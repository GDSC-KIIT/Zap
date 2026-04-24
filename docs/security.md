# Security Architecture — Zap

> **Author:** Agam Singh Saluja  
> **Project:** Zap — Anonymous, Ephemeral File Transfer  
> **Scope:** Security model design, encryption layer, threat analysis, and hardening roadmap

---

## Table of Contents

1. [Security Model Overview](#1-security-model-overview)
2. [Cloudflare Infrastructure Security](#2-cloudflare-infrastructure-security)
3. [End-to-End Encryption (AES-256-GCM)](#3-end-to-end-encryption-aes-256-gcm)
4. [Anonymity and Identity Model](#4-anonymity-and-identity-model)
5. [Rate Limiting and Abuse Prevention](#5-rate-limiting-and-abuse-prevention)
6. [Threat Model Summary](#6-threat-model-summary)
7. [Limitations and Trade-offs](#7-limitations-and-trade-offs)
8. [Future Security Improvements](#8-future-security-improvements)

---

## 1. Security Model Overview

Zap is designed around two core security principles: **ephemerality** and **client-side confidentiality**. No user accounts, no persistent identifiers, and no server-side plaintext — the system is architected so that even a full compromise of the backend infrastructure reveals minimal useful data.

The platform operates in two transfer modes, each with a distinct security posture:

| Mode | Transport | Encryption | Server Exposure |
|---|---|---|---|
| **P2P Direct** | WebRTC `RTCDataChannel` | DTLS 1.2+ (browser-native) | Signaling metadata only |
| **P2P Relayed** | WebSocket via `ZapHub` Durable Object | DTLS over TLS | Binary chunks (no key access) |
| **Cloud Hold** | HTTPS via Cloudflare Worker | AES-256-GCM (client-side) | Ciphertext + IV only |

The guiding principle is **defence in depth**: platform-level TLS, storage-level encryption, and application-level AES-GCM encryption operate as independent, complementary layers.

---

## 2. Cloudflare Infrastructure Security

### 2.1 Transport Security (TLS)

All communication between clients and Cloudflare Workers occurs exclusively over **TLS 1.2 / 1.3**. Cloudflare terminates TLS at the edge, ensuring that no data traverses the public internet in plaintext. WebSocket connections (`/ws`) are likewise upgraded from `wss://` (TLS-wrapped).

### 2.2 Encryption at Rest (Cloudflare R2)

Files uploaded via Cloud Hold are stored in **Cloudflare R2**, which enforces **AES-256 encryption at rest** on all stored objects by default. This is a platform guarantee — Cloudflare manages keys at the infrastructure level, and objects are never written to disk in plaintext.

Critically, because Zap applies **additional client-side AES-256-GCM encryption before upload**, what R2 actually stores is **ciphertext encrypted by the client**. The R2 encryption-at-rest layer therefore provides a second, independent encryption envelope.

```
Plaintext File
     │
     ▼
[ Client: AES-256-GCM encrypt ] ── key lives only in browser
     │
     ▼
Ciphertext Chunks (5 MB each, unique IV per chunk)
     │
     ▼
[ TLS 1.3 in transit ]
     │
     ▼
[ Cloudflare R2: AES-256 at rest ]
     │
     ▼
Double-encrypted object on disk
```

### 2.3 Controlled Access via Cloudflare Workers

R2 buckets are **not publicly accessible**. All file access is mediated exclusively through the Cloudflare Worker, which enforces:

- Room code validation before any read or write
- Room expiry checks on every request
- Storage quota enforcement (`MAX_R2_STORAGE_GB`, `MAX_R2_FILE_SIZE_GB`)
- File count limits per room (`MAX_ROOM_FILES`)

There are no direct S3-compatible presigned URLs exposed to clients in the current implementation, meaning every upload and download passes through Worker-enforced access control logic.

### 2.4 TTL-Based Automatic Deletion

Room metadata is stored in **Cloudflare KV** with a configurable TTL (1–24 hours, default 24 hours). A **cron trigger** runs every 10 minutes (`*/10 * * * *`) and:

1. Scans KV for rooms past their expiry timestamp
2. Deletes all associated R2 objects for that room
3. Removes the KV metadata entry
4. Decrements the global storage usage counter

This ensures that expired data does not persist on the platform and reduces the window of exposure for any stored file.

---

## 3. End-to-End Encryption (AES-256-GCM)

### 3.1 Algorithm Choice

Cloud Hold uses **AES-256-GCM** (Advanced Encryption Standard in Galois/Counter Mode), implemented entirely via the browser's native **Web Crypto API** (`window.crypto.subtle`). This choice is deliberate:

- **AES-256**: 256-bit key provides a security margin well beyond current computational feasibility
- **GCM mode**: Provides both confidentiality *and* authenticated integrity (AEAD — Authenticated Encryption with Associated Data). Any tampering with ciphertext is detectable on decryption
- **Web Crypto API**: Hardware-accelerated, audited browser primitive — no third-party cryptography libraries are introduced

### 3.2 Chunked Encryption

Files are encrypted in **5 MB chunks**, each with a **unique, randomly generated 96-bit IV** (Initialisation Vector). This design has important security properties:

```
File: [  Chunk 1 (5 MB)  ] [  Chunk 2 (5 MB)  ] [  Chunk N  ]
       IV₁ + Ciphertext₁    IV₂ + Ciphertext₂    IVₙ + Ciphertextₙ
       + AuthTag₁           + AuthTag₂            + AuthTagₙ
```

- IV reuse attacks are eliminated: even identical chunks produce different ciphertext
- Each chunk carries an independent GCM authentication tag, enabling integrity verification per chunk rather than requiring the entire file to be buffered
- Streaming decryption is possible, enabling accurate progress reporting during download

### 3.3 Key Derivation and Distribution

The encryption key is derived server-side from an `ENCRYPTION_PASSWORD` environment variable and served to clients via `GET /api/encryption-key` as a hex string. The Worker never stores or logs the derived key. **This is the primary trust assumption in the current model** — the server is trusted to serve a consistent, non-malicious key.

### 3.4 P2P Mode Encryption

In P2P mode, WebRTC `RTCDataChannel` provides **DTLS 1.2+** encryption natively enforced by the browser. This is a transport-layer encryption guarantee, not application-layer AES. The `ZapHub` Durable Object handles only WebSocket signaling (SDP offer/answer, ICE candidates) and, as a fallback, relays raw binary `ArrayBuffer` chunks — neither path exposes plaintext to the server.

---

## 4. Anonymity and Identity Model

Zap is designed to require **zero identifying information**:

- No user registration, login, or email
- Room codes are randomly generated 6-character strings with no linkage to IP or session identity
- No cookies or persistent tokens are issued
- Session state (active rooms, expiry timers) is stored only in **browser-local cache**, not on the server

The server observes only: room code, file size, upload/download timing, and the client IP (for rate limiting). IP addresses are used transiently for rate-limit enforcement and are not stored in KV or R2 metadata.

---

## 5. Rate Limiting and Abuse Prevention

To prevent resource exhaustion and abuse, the Worker enforces the following controls:

| Control | Parameter | Default |
|---|---|---|
| Requests per IP per window | `RATE_LIMIT_MAX_REQUESTS` | 100 |
| Rate limit window | `RATE_LIMIT_WINDOW_MS` | 15 minutes |
| Max active rooms per IP | `MAX_ROOMS_PER_IP` | 10 |
| Max files per room | `MAX_ROOM_FILES` | 10 |
| Max single file size | `MAX_R2_FILE_SIZE_GB` | 2 GB |
| Total R2 storage cap | `MAX_R2_STORAGE_GB` | 8 GB |
| Max concurrent relay sessions | `MAX_CONCURRENT_RELAYS` | 3 |

Room deletion requires an `Authorization: Bearer <adminToken>` header, preventing arbitrary deletion of active rooms.

---

## 6. Threat Model Summary

> See [`threat-model.md`](./threat-model.md) for the full analysis.

| Threat | Mitigation |
|---|---|
| Network eavesdropping | TLS 1.3 in transit; DTLS for WebRTC |
| Server-side data exposure | Client-side AES-256-GCM; server only holds ciphertext |
| Stale data exposure | KV TTL + cron-based deletion every 10 minutes |
| Brute-force room enumeration | 6-char alphanumeric codes (~2.18 billion combinations); rate limiting |
| Storage exhaustion (DoS) | Per-IP room limits; global R2 storage cap; file size cap |
| Relay-based MITM | TLS wraps WebSocket relay; no key material passes through relay |
| Chunk integrity tampering | GCM authentication tag per chunk rejects modified ciphertext |

---

## 7. Limitations and Trade-offs

### 7.1 Server-Trusted Key Distribution

The current model serves the AES encryption key from the Worker (`/api/encryption-key`). This means:

- The operator of the Worker can theoretically serve a different key and observe uploads
- True end-to-end confidentiality from the server operator is not achieved in Cloud Hold mode
- Users must trust the platform, not merely the cryptographic primitives

This is a deliberate architectural trade-off for usability (no key exchange UI, no out-of-band communication required).

### 7.2 No Forward Secrecy in Cloud Hold

Unlike P2P mode (where DTLS provides ephemeral key exchange), Cloud Hold uses a long-lived key derived from a server-side secret. If the `ENCRYPTION_PASSWORD` is compromised, previously uploaded files can be decrypted if the ciphertext was retained.

### 7.3 Room Code Secrecy as the Access Control Primitive

Access to a Cloud Hold room is gated entirely by knowledge of the 6-character room code. There is no secondary authentication. Anyone who learns the code (e.g., via URL sharing, browser history, or shoulder-surfing) can access the room until it expires.

### 7.4 No File Content Scanning

Because files are encrypted client-side before upload, the platform cannot perform malware scanning or content moderation on stored files. This is an inherent trade-off of client-side encryption.

---

## 8. Future Security Improvements

| Improvement | Description | Priority |
|---|---|---|
| **Client-generated keys** | Generate the AES key in the browser; transmit only via URL fragment (never sent to server) | High |
| **Signed upload URLs** | Replace direct Worker upload with time-limited, HMAC-signed R2 presigned URLs | High |
| **OPAQUE or PAKE key exchange** | Use a password-authenticated key exchange so the server never sees the raw key | Medium |
| **Per-chunk HMAC manifest** | Generate a server-side manifest of chunk HMACs to detect partial deletion or reordering | Medium |
| **Room access tokens** | Issue a short-lived JWT on room creation; require it for download | Medium |
| **Certificate pinning guidance** | Document expected TLS certificate fingerprints for high-assurance deployments | Low |
| **Audit logging** | Append-only log of room creation, file upload, and download events for abuse investigation | Low |
| **Content-length commitment** | Commit to file size at upload time; reject downloads that deviate | Low |

---

*This document reflects the security architecture as designed for the Zap project. It should be reviewed and updated whenever the encryption implementation, key management approach, or infrastructure configuration changes.*
