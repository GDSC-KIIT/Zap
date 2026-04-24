# Threat Model

**Author:** Agam Singh Saluja  
**Project:** Zap — Anonymous, Ephemeral File Transfer

---

## Methodology

This document applies the **STRIDE** framework (Spoofing, Tampering, Repudiation, Information Disclosure, Denial of Service, Elevation of Privilege) to Zap's attack surface.

**Assets under protection**
- File content (plaintext)
- Sender/receiver IP and identity
- Platform availability
- Room code confidentiality

**Adversary classes**

| ID  | Class                    | Description                                             |
| --- | ------------------------ | ------------------------------------------------------- |
| A1  | Passive network observer | Reads traffic in transit (ISP, Wi-Fi intercept)         |
| A2  | Active network attacker  | Intercepts and modifies traffic (MITM)                  |
| A3  | Compromised server       | Full read access to Worker code, KV, and R2             |
| A4  | Malicious peer           | The other participant in a transfer session             |
| A5  | External attacker        | No privileged access; operates from the public internet |

---

## Trust Boundaries

```
+-----------------------------------------------------+
| TRUSTED                                             |
|                                                     |
| Sender/Receiver Browser                             |
| (Web Crypto API, script.js)                         |
| Crypto operations run here; key never leaves        |
+-----------------------------------------------------+
|                                                     |
|                  TLS boundary                       |
|                                                     |
+-----------------------------------------------------+
| SEMI-TRUSTED                                        |
|                                                     |
| Cloudflare Worker + ZapHub DO                       |
| Trusted for availability and routing.               |
| Not trusted with plaintext or keys (target arch).   |
| Currently serves the AES key via /api/enc-key.      |
|                                                     |
| Cloudflare R2 + KV                                  |
| Trusted for storage integrity. Sees ciphertext.     |
+-----------------------------------------------------+
|                                                     |
|                  TLS boundary                       |
|                                                     |
+-----------------------------------------------------+
| UNTRUSTED                                           |
|                                                     |
| Public internet / network path                      |
| Receiver browser (adversarial peer scenario)        |
| External attackers                                  |
+-----------------------------------------------------+
```

---

## Threat Catalogue

---

### T1 — Passive Network Eavesdropping

**STRIDE category:** Information Disclosure  
**Adversary:** A1

A passive observer (ISP, shared Wi-Fi, network tap) attempts to read file content or metadata in transit.

**Mitigations**
- All client-to-Worker traffic runs over TLS 1.3 enforced by the Cloudflare edge.
- P2P DataChannel uses mandatory DTLS 1.2+ enforced by the browser — cannot be disabled.
- In Cloud Hold, even if TLS were stripped, the attacker receives AES-256-GCM ciphertext — unintelligible without the key.

**Residual risk:** Negligible. TLS and application-layer encryption provide two independent barriers.

**Likelihood:** Low | **Impact:** High | **Overall:** Low

---

### T2 — Active Man-in-the-Middle (MITM)

**STRIDE category:** Tampering, Information Disclosure  
**Adversary:** A2

An active attacker intercepts TLS connections to inject or modify data.

**Mitigations**
- Cloudflare terminates TLS with valid CA-signed certificates. Intercepting requires forging or compromising a browser-trusted CA.
- WebRTC DTLS uses self-signed certificates with fingerprint verification — the browser verifies DTLS fingerprints exchanged in SDP, rejecting any hijacked ICE path that cannot present the expected fingerprint.
- GCM authentication tags cause decryption to fail on any ciphertext modification.

**Residual risk:** Viable only against an attacker who has compromised a browser-trusted CA — effectively a nation-state-tier attack.

**Likelihood:** Very Low | **Impact:** High | **Overall:** Low

---

### T3 — Server-Side Data Exposure

**STRIDE category:** Information Disclosure  
**Adversary:** A3

An attacker with read access to the Cloudflare environment (compromised API token, rogue insider, supply chain) attempts to read uploaded files.

**Mitigations**
- R2 stores AES-256-GCM ciphertext only. Without the key, stored data is computationally inaccessible.
- The AES key is derived from `ENCRYPTION_PASSWORD` and is not stored in R2 or KV.
- TTL-based deletion limits the window during which any file is accessible.

**Residual risk:** An attacker who also compromises the `ENCRYPTION_PASSWORD` Worker environment variable can derive the key and decrypt stored files. This is the **primary residual risk** of the current key distribution model.

**Likelihood:** Low | **Impact:** Critical | **Overall:** Medium

---

### T4 — Room Code Enumeration

**STRIDE category:** Information Disclosure  
**Adversary:** A5

An attacker systematically guesses room codes to access rooms created by others.

**Mitigations**
- Code space: 6-character alphanumeric = 36^6 ~= 2.18 billion combinations.
- Rate limiting: 100 requests per 15-minute window per IP. Exhausting the space at this rate would take approximately 4.7 million hours per IP.
- `MAX_ROOMS_PER_IP = 10` limits the attack's utility even if codes are guessed.

**Residual risk:** Low. Distributed enumeration across many IPs is theoretically possible but impractical at any realistic room count.

**Likelihood:** Low | **Impact:** Medium | **Overall:** Low

---

### T5 — Storage Exhaustion (DoS)

**STRIDE category:** Denial of Service  
**Adversary:** A5

An attacker creates many rooms and uploads large files to exhaust R2 storage, making the service unavailable.

**Mitigations**
- Global R2 cap: `MAX_R2_STORAGE_GB = 8` — uploads beyond the cap are rejected.
- Per-IP room limit: `MAX_ROOMS_PER_IP = 10`.
- Max file size: `MAX_R2_FILE_SIZE_GB = 2`.
- Max files per room: `MAX_ROOM_FILES = 10`.
- Rate limiting: 100 requests per 15 minutes per IP.
- Cron cleanup prevents accumulation of expired-but-undeleted files.

**Residual risk:** A distributed attack across many IPs could potentially saturate the global cap. The cap can be tightened via `wrangler.toml` for constrained deployments.

**Likelihood:** Medium | **Impact:** Medium | **Overall:** Medium

---

### T6 — Relay Abuse (Bandwidth Exhaustion)

**STRIDE category:** Denial of Service  
**Adversary:** A5

An attacker deliberately forces the server relay path for large transfers to exhaust Durable Object egress bandwidth.

**Mitigations**
- `MAX_CONCURRENT_RELAYS = 3` caps simultaneous relay sessions.
- Rate limiting at the Worker level restricts new WebSocket connections per IP.
- Relay is triggered only when direct ICE fails — it cannot be directly requested by clients.

**Residual risk:** Moderate. ICE failure conditions are partially attacker-controllable (e.g., by not responding to ICE candidates). Per-relay bandwidth accounting is not currently implemented.

**Likelihood:** Medium | **Impact:** Medium | **Overall:** Medium

---

### T7 — Ciphertext Tampering

**STRIDE category:** Tampering  
**Adversary:** A3, A4

An attacker with R2 write access, or a MITM on the download path, modifies encrypted chunks to corrupt the file or inject malicious content.

**Mitigations**
- AES-GCM is an authenticated encryption (AEAD) scheme. Any modification to the ciphertext or IV causes `crypto.subtle.decrypt()` to throw a `DOMException` — no plaintext is ever produced from a tampered chunk.
- Each 5 MB chunk carries an independent 128-bit GCM authentication tag.

**Residual risk:** Negligible for integrity. Breaking AES-GCM authentication is computationally infeasible.

**Likelihood:** Low | **Impact:** High | **Overall:** Low

---

### T8 — Stale Data Exposure

**STRIDE category:** Information Disclosure  
**Adversary:** A5

A file is accessed after its intended expiry — because the cron job hasn't yet run, or R2 objects weren't cleaned up in time.

**Mitigations**
- The Worker checks `expiresAt` on **every request**. Expired rooms are rejected at the API layer even if the KV entry and R2 objects physically still exist.
- KV TTLs are set at write time as a secondary deletion mechanism.
- Cron runs every 10 minutes to clean orphaned objects.

**Residual risk:** Zero for API access. Physical R2 object residency may extend up to 10 minutes beyond expiry, but the data is unreachable via the API during that window.

**Likelihood:** Low | **Impact:** Low | **Overall:** Very Low

---

### T9 — Malicious File Distribution

**STRIDE category:** Repudiation, Elevation of Privilege  
**Adversary:** A4

A bad actor uses Cloud Hold to distribute malware or illegal content, exploiting client-side encryption to evade content moderation.

**Mitigations**
- Ephemerality limits distribution window (max 24 hours).
- No indexing, search, or public listing of rooms.
- Rate limits constrain upload volume.
- Server-side content scanning is not possible given the encryption model — this is an accepted trade-off.

**Residual risk:** Moderate. Client-side encryption is in fundamental tension with content moderation. Operator-level abuse response requires manual room deletion via the admin API.

**Likelihood:** Medium | **Impact:** High | **Overall:** Medium (accepted trade-off)

---

### T10 — Signaling Injection / Session Hijacking

**STRIDE category:** Spoofing, Elevation of Privilege  
**Adversary:** A5

An attacker injects a crafted SDP offer or ICE candidate into a P2P session to redirect the DataChannel to an attacker-controlled endpoint.

**Mitigations**
- ZapHub allows only one peer per role per room. A third connection is rejected or replaces the idle peer.
- WebRTC DTLS fingerprint verification is browser-enforced. A hijacked ICE path that cannot present the expected DTLS fingerprint is rejected automatically.
- TLS on the WebSocket channel prevents injection from outside the existing connection.

**Residual risk:** If an attacker arrives before the legitimate receiver, they could establish the P2P session. There is no secondary authentication of peers beyond room code knowledge — consistent with the anonymity model.

**Likelihood:** Low | **Impact:** High | **Overall:** Low–Medium

---

### T11 — Operator-Level Key Compromise

**STRIDE category:** Information Disclosure  
**Adversary:** A3

The `ENCRYPTION_PASSWORD` variable in `wrangler.toml` or the Cloudflare dashboard is leaked, enabling decryption of all Cloud Hold files.

**Mitigations**
- `wrangler.toml` is listed in `.gitignore` — never committed to the repository.
- Cloudflare dashboard secrets are access-controlled by account credentials.
- TTL-based deletion means historical ciphertext is unavailable after expiry.

**Residual risk:** High if `ENCRYPTION_PASSWORD` is leaked. The entire Cloud Hold encryption model depends on this secret remaining confidential. This motivates the roadmap item to move to client-side key generation (see [security.md — Future Improvements](./security.md#future-security-improvements)).

**Likelihood:** Low (with good practice) | **Impact:** Critical | **Overall:** Medium

---

### T12 — IP Exposure via ICE Candidates (P2P)

**STRIDE category:** Information Disclosure  
**Adversary:** A4

In P2P mode, the receiver's browser discovers the sender's public IP address via ICE candidates, which may de-anonymise the sender.

**Mitigations**
- When Cloudflare TURN credentials are configured, traffic routes through Cloudflare's TURN server, masking both peers' IPs from each other.
- Without TURN, both peers' public IPs are mutually visible — this is inherent to the WebRTC protocol.

**Residual risk:** Without TURN configured, peer IPs are visible to each other. Users with strong anonymity requirements should use Cloud Hold mode or ensure TURN is enabled.

**Likelihood:** High (without TURN) | **Impact:** Medium | **Overall:** Medium

---

## STRIDE Summary Matrix

| Threat                    | S   | T   | R   | I   | D   | E   | Likelihood | Impact   |
| ------------------------- | --- | --- | --- | --- | --- | --- | ---------- | -------- |
| T1 — Eavesdropping        |     |     |     | X   |     |     | Low        | High     |
| T2 — MITM                 |     | X   |     | X   |     |     | Very Low   | High     |
| T3 — Server exposure      |     |     |     | X   |     |     | Low        | Critical |
| T4 — Room enumeration     |     |     |     | X   |     |     | Low        | Medium   |
| T5 — Storage DoS          |     |     |     |     | X   |     | Medium     | Medium   |
| T6 — Relay abuse          |     |     |     |     | X   |     | Medium     | Medium   |
| T7 — Ciphertext tamper    |     | X   |     |     |     |     | Low        | High     |
| T8 — Stale data           |     |     |     | X   |     |     | Low        | Low      |
| T9 — Malware distribution |     |     | X   |     |     | X   | Medium     | High     |
| T10 — Signaling injection | X   |     |     |     |     | X   | Low        | High     |
| T11 — Key compromise      |     |     |     | X   |     |     | Low        | Critical |
| T12 — IP exposure         |     |     |     | X   |     |     | High       | Medium   |

*S = Spoofing, T = Tampering, R = Repudiation, I = Information Disclosure, D = Denial of Service, E = Elevation of Privilege*

---

## Out-of-Scope Threats

| Threat                                  | Reason                                                             |
| --------------------------------------- | ------------------------------------------------------------------ |
| Endpoint compromise (malware on device) | Cannot protect files after they reach the OS filesystem            |
| Receiver-side data leakage              | Once decrypted and downloaded, files are outside platform control  |
| Cloudflare platform compromise          | Zap trusts the Cloudflare infrastructure at its base               |
| Social engineering                      | Sharing room codes with unintended parties is a user-layer concern |
| Legal / DMCA enforcement                | Operational policy, not a technical control                        |

---

## Residual Risk Summary

| Risk                          | Status                                                             | Recommended Action                                                           |
| ----------------------------- | ------------------------------------------------------------------ | ---------------------------------------------------------------------------- |
| Operator key compromise (T11) | `ENCRYPTION_PASSWORD` is the single point of cryptographic failure | Migrate to client-side key generation; remove `/api/encryption-key` endpoint |
| P2P IP exposure (T12)         | Peer IPs are mutually visible without TURN                         | Mandate TURN in production; document the risk for self-hosters               |
| Malware distribution (T9)     | No content scanning possible with E2EE                             | Accept as trade-off; add abuse reporting contact to README                   |
| Distributed storage DoS (T5)  | Global 8 GB cap is a blunt instrument                              | Add per-room storage quotas and Cloudflare WAF rate rules                    |

---

*This threat model was developed by Agam Singh Saluja as part of the Zap project security architecture work. It should be revisited whenever the encryption model, key management approach, or infrastructure changes materially.*
