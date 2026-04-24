# Security Architecture

**Author:** Agam Singh Saluja  
**Project:** Zap — Anonymous, Ephemeral File Transfer

---

## Overview

Zap is built around two security principles: **ephemerality** and **client-side confidentiality**. No user accounts, no persistent identifiers, no server-side plaintext — even a full backend compromise reveals minimal useful data.

The platform has two transfer modes with distinct security postures:

| Mode        | Transport                             | Encryption                 | Server Exposure                  |
| ----------- | ------------------------------------- | -------------------------- | -------------------------------- |
| P2P Direct  | WebRTC `RTCDataChannel`               | DTLS 1.2+ (browser-native) | Signaling metadata only          |
| P2P Relayed | WebSocket via `ZapHub` Durable Object | TLS on WebSocket           | Binary ciphertext, no key access |
| Cloud Hold  | HTTPS via Cloudflare Worker           | AES-256-GCM (client-side)  | Ciphertext + IV only             |

The guiding principle is **defence in depth** — platform TLS, storage-level encryption, and application-level AES-GCM operate as independent, complementary layers.

---

## Cloudflare Infrastructure Security

### Transport (TLS)

All client-to-Worker communication runs exclusively over **TLS 1.2/1.3**, terminated at the Cloudflare edge. WebSocket connections (`/ws`) are established as `wss://` — TLS-wrapped end to end.

### Encryption at Rest (R2)

Files in Cloud Hold are stored in **Cloudflare R2**, which enforces AES-256 encryption at rest on all objects by default.

Because Zap also applies **client-side AES-256-GCM encryption before upload**, R2 stores ciphertext that is itself already encrypted. The result is a double-encryption envelope:

```
Plaintext file
  -> [Browser] AES-256-GCM encrypt  (key lives only in browser)
  -> Ciphertext chunks (5 MB each, unique 96-bit IV per chunk)
  -> [TLS 1.3] in transit
  -> [R2] AES-256 at rest
  -> Double-encrypted object on disk
```

### Controlled Access via Workers

R2 buckets are not publicly exposed. All file access is mediated through the Cloudflare Worker, which enforces:

- Room code validation on every request
- Expiry checks before serving any file
- Storage quota limits (`MAX_R2_STORAGE_GB`, `MAX_R2_FILE_SIZE_GB`)
- File count limits per room (`MAX_ROOM_FILES`)

### TTL-Based Deletion

Room metadata in KV carries a configurable TTL (1–24 hours). A cron trigger fires every 10 minutes and:

1. Scans KV for rooms past their expiry timestamp
2. Deletes all associated R2 objects for that room
3. Removes the KV entry and decrements the storage counter

---

## End-to-End Encryption (AES-256-GCM)

### Algorithm

Cloud Hold uses **AES-256-GCM** via the browser's native **Web Crypto API** (`window.crypto.subtle`). No third-party cryptography libraries are involved. GCM mode provides both confidentiality and authenticated integrity (AEAD) — any ciphertext modification is detectable on decryption.

### Chunked Encryption

Files are encrypted in **5 MB chunks**, each with a **unique randomly generated 96-bit IV**:

```
File:  [ Chunk 1 (5 MB) ]      [ Chunk 2 (5 MB) ]      [ Chunk N ]
         IV1 + Ciphertext1        IV2 + Ciphertext2        IVn + Ciphertextn
         + GCM AuthTag1           + GCM AuthTag2           + GCM AuthTagn
```

This eliminates IV reuse attacks, enables per-chunk integrity verification, and allows streaming decryption with accurate progress reporting.

Each chunk stored in R2 has the following byte layout:

```
| 0 - 11      | 12 - (N+11) | (N+12) - (N+27) |
| IV (96-bit) | Ciphertext  | GCM AuthTag     |
| 12 bytes    | N bytes     | 16 bytes        |
```

### Key Distribution

The AES key is derived server-side from an `ENCRYPTION_PASSWORD` environment variable and served to clients via `GET /api/encryption-key`. This is the primary trust assumption — the server is trusted to serve a consistent, non-malicious key. See [Limitations](#limitations-and-trade-offs) for the full implications.

### P2P Encryption

In P2P mode, WebRTC `RTCDataChannel` provides **DTLS 1.2+** encryption enforced natively by the browser. The `ZapHub` Durable Object handles only signaling (SDP, ICE candidates) and relay chunks — it never touches plaintext or key material.

---

## Anonymity and Identity Model

Zap requires zero identifying information:

- No registration, login, or email address
- Room codes are randomly generated 6-character strings with no linkage to IP or session identity
- No cookies or persistent tokens are issued
- Session state (active rooms, expiry timers) is stored in browser-local cache only, not on the server

The server observes room code, file size, upload/download timing, and client IP (for rate limiting only). IPs are not persisted in KV or R2 metadata.

---

## Rate Limiting and Abuse Prevention

| Control                       | Variable                  | Default    |
| ----------------------------- | ------------------------- | ---------- |
| Requests per IP per window    | `RATE_LIMIT_MAX_REQUESTS` | 100        |
| Rate limit window             | `RATE_LIMIT_WINDOW_MS`    | 15 minutes |
| Max active rooms per IP       | `MAX_ROOMS_PER_IP`        | 10         |
| Max files per room            | `MAX_ROOM_FILES`          | 10         |
| Max single file size          | `MAX_R2_FILE_SIZE_GB`     | 2 GB       |
| Total R2 storage cap          | `MAX_R2_STORAGE_GB`       | 8 GB       |
| Max concurrent relay sessions | `MAX_CONCURRENT_RELAYS`   | 3          |

Room deletion requires `Authorization: Bearer <adminToken>`, preventing arbitrary deletion of active rooms.

---

## Threat Model Summary

See [`threat-model.md`](./threat-model.md) for the full analysis.

| Threat                    | Mitigation                                                                             |
| ------------------------- | -------------------------------------------------------------------------------------- |
| Network eavesdropping     | TLS 1.3 in transit; DTLS for WebRTC                                                    |
| Server-side data exposure | Client-side AES-256-GCM; server holds ciphertext only                                  |
| Stale data exposure       | KV TTL + cron deletion every 10 minutes; Worker rejects expired rooms on every request |
| Room code enumeration     | ~2.18 billion possible codes; per-IP rate limiting                                     |
| Storage exhaustion (DoS)  | Per-IP room limits; global R2 cap; per-file size cap                                   |
| Ciphertext tampering      | GCM authentication tag per chunk rejects any modified ciphertext                       |

---

## Limitations and Trade-offs

**Server-trusted key distribution.** The AES key is served from the Worker. The platform operator could theoretically serve a different key and observe uploads. True end-to-end confidentiality from the server operator is not achieved in Cloud Hold mode — users trust the platform, not just the cryptographic primitives.

**No forward secrecy in Cloud Hold.** Unlike P2P mode (where DTLS provides ephemeral key exchange), Cloud Hold uses a long-lived key derived from a server-side secret. A compromised `ENCRYPTION_PASSWORD` allows decryption of any retained ciphertext.

**Room code as sole access control.** Access to a Cloud Hold room is gated entirely by the 6-character code with no secondary authentication. Anyone who learns the code can access the room until expiry.

**No content scanning.** Because files are encrypted client-side before upload, server-side malware scanning or content moderation is not possible. This is an inherent trade-off of client-side encryption.

---

## Future Security Improvements

| Improvement             | Description                                                                              | Priority |
| ----------------------- | ---------------------------------------------------------------------------------------- | -------- |
| Client-generated keys   | Generate the AES key in the browser; transmit only via URL fragment, never to the server | High     |
| Signed upload URLs      | Replace direct Worker uploads with time-limited, HMAC-signed R2 presigned URLs           | High     |
| PAKE key exchange       | Password-authenticated key exchange so the server never sees the raw key                 | Medium   |
| Per-chunk HMAC manifest | Server-side manifest of chunk HMACs to detect partial deletion or reordering             | Medium   |
| Room access tokens      | Short-lived JWT issued on room creation; required for download                           | Medium   |
| Audit logging           | Append-only log of room creation, upload, and download events                            | Low      |

---

*This document should be reviewed whenever the encryption implementation, key management approach, or infrastructure configuration changes.*
