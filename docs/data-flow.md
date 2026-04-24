# Data Flow — Zap

> **Author:** Agam Singh Saluja  
> **Project:** Zap — Anonymous, Ephemeral File Transfer  
> **Scope:** Step-by-step data movement for P2P transfer, Cloud Hold upload/download, and room lifecycle

---

## Table of Contents

1. [P2P Transfer Flow](#1-p2p-transfer-flow)
2. [Cloud Hold Upload Flow](#2-cloud-hold-upload-flow)
3. [Cloud Hold Download Flow](#3-cloud-hold-download-flow)
4. [Room Lifecycle and Expiry Flow](#4-room-lifecycle-and-expiry-flow)
5. [Signaling Flow (WebRTC)](#5-signaling-flow-webrtc)
6. [Relay Fallback Flow](#6-relay-fallback-flow)
7. [Data Boundaries Summary](#7-data-boundaries-summary)

---

## 1. P2P Transfer Flow

P2P mode sends file data directly between browsers over a WebRTC `RTCDataChannel`. The server participates only during the signaling phase; it never touches file bytes in the happy path.

### Step-by-Step

```
STEP 1 — Room creation
  Sender opens Zap → clicks "Start P2P Transfer"
  → A 6-character room code is generated
  → QR code and shareable link are displayed

STEP 2 — WebSocket connection (Sender)
  Sender browser → WSS /ws → Cloudflare Worker
  → Worker upgrades connection → routes to ZapHub Durable Object
  → ZapHub registers Sender's WebSocket in room [code]

STEP 3 — WebSocket connection (Receiver)
  Receiver opens link with room code
  → Same WSS /ws → same ZapHub DO instance (scoped by code)
  → ZapHub now holds both peers in memory

STEP 4 — ICE server configuration
  Both peers → GET /api/turn-credentials
  → Worker returns STUN/TURN config:
      stun:stun.cloudflare.com:3478 (always)
      TURN credentials (if CF_TURN_KEY_ID is configured)

STEP 5 — SDP Offer/Answer (signaling via ZapHub)
  Sender creates RTCPeerConnection
  → Sender generates SDP Offer
  → Sender sends: { type: "offer", sdp: "..." } via WebSocket
  → ZapHub forwards offer to Receiver's WebSocket

  Receiver creates RTCPeerConnection with received offer
  → Receiver generates SDP Answer
  → Receiver sends: { type: "answer", sdp: "..." } via WebSocket
  → ZapHub forwards answer to Sender's WebSocket

STEP 6 — ICE Candidate Exchange
  Both peers emit ICE candidates asynchronously
  → Each candidate forwarded through ZapHub as { type: "ice", candidate: {...} }
  → ICE negotiation completes; direct UDP/TCP path established (or fails → Step 6b)

STEP 7 — File Transfer (DataChannel)
  Sender slices file into 256 KB ArrayBuffer chunks
  → Each chunk sent via RTCDataChannel.send(chunk)
  → Browser DTLS layer encrypts each chunk in transit (mandatory, browser-enforced)
  → Chunks arrive at Receiver's DataChannel onmessage handler
  → Receiver reassembles chunks → triggers browser download via Blob URL
```

### What the Server Sees

| Phase | Server-observable data |
|---|---|
| Room creation | Room code |
| Signaling | SDP (media capabilities, no file content), ICE candidates (IP/port hints) |
| File transfer (direct) | **Nothing** — DataChannel is peer-to-peer |

---

## 2. Cloud Hold Upload Flow

Cloud Hold encrypts files in the browser before any bytes leave the device. The Worker and R2 never handle plaintext.

### Step-by-Step

```
STEP 1 — Room creation
  Sender → POST /api/room/create  { ttl: <hours> }
  → Worker generates random 6-char code
  → Worker writes to KV (ROOMS):
      key:   "room:<code>"
      value: { code, createdAt, expiresAt, files: [], adminToken }
      TTL:   <hours> seconds
  → Worker returns { code, adminToken }

STEP 2 — File selection and chunking
  Sender selects file in browser
  → script.js slices file into 5 MB chunks: [chunk₁, chunk₂, … chunkₙ]

STEP 3 — Key retrieval
  Sender → GET /api/encryption-key
  → Worker derives AES-256 key from ENCRYPTION_PASSWORD env var
  → Returns key as hex string

STEP 4 — Client-side encryption (per chunk)
  For each chunkᵢ:
    IV₁ ← crypto.getRandomValues(new Uint8Array(12))   [96-bit random]
    ciphertext₁ ← crypto.subtle.encrypt(
        { name: "AES-GCM", iv: IV₁ },
        aesKey,
        chunkᵢ
    )
    encryptedChunkᵢ = [IV₁ (12 bytes)] + [ciphertext₁] + [GCM AuthTag (16 bytes)]

STEP 5 — Upload initiation
  Sender → POST /api/room/upload  { code, fileName, fileSize, chunkCount }
  → Worker validates: room exists, not expired, quota not exceeded
  → Worker generates fileId
  → For large files: initiates R2 multipart upload, returns { uploadUrl, fileId, partUrls }
  → For small files: returns direct upload URL

STEP 6 — Chunk upload
  For each encryptedChunkᵢ:
    Sender → PUT <uploadUrl>/chunk_i   body: encryptedChunkᵢ
    → Worker proxies to R2.put("rooms/<code>/<fileId>/chunk_i", encryptedChunkᵢ)
    → R2 stores ciphertext (applies its own AES-256 at-rest encryption on top)

STEP 7 — Upload finalisation
  Sender → POST /api/room/upload-complete  { code, fileId, totalChunks }
  → Worker updates KV entry: appends fileId to room's file list
  → Worker updates ROOMS_KV storage counter
  → Returns { success: true }

STEP 8 — Link sharing
  Sender shares room code (6 chars) out-of-band
  → Receiver enters code at zap.zap-files.workers.dev
```

### Encryption Data Layout (per chunk stored in R2)

```
┌─────────────────────────────────────────────────────────────────┐
│  Byte 0–11    │  Byte 12 – (12+N-1)  │  Byte (12+N) – (12+N+15) │
│   IV (96-bit) │  AES-GCM Ciphertext  │  GCM Auth Tag (128-bit)  │
│  12 bytes     │  N bytes             │  16 bytes                │
└─────────────────────────────────────────────────────────────────┘
  N = original chunk size (up to 5 MB)
```

---

## 3. Cloud Hold Download Flow

Download streams ciphertext from R2 through the Worker and decrypts it in the receiver's browser.

### Step-by-Step

```
STEP 1 — Room lookup
  Receiver → GET /api/room/:code
  → Worker checks KV: room exists and not expired
  → Returns { code, expiresAt, files: [{ fileId, fileName, fileSize }] }
  → UI shows file list with expiry countdown

STEP 2 — Key retrieval
  Receiver → GET /api/encryption-key
  → Receives same AES-256 key hex as uploader

STEP 3 — Download request
  Receiver clicks file → GET /api/room/:code/download/:fileId
  → Worker validates room + fileId
  → Worker initiates R2 streaming read of chunk objects for fileId
  → Worker sets Content-Length header (enables accurate progress bar)
  → Worker streams ciphertext as chunked HTTP response

STEP 4 — Client-side decryption (streaming, per chunk)
  For each received encryptedChunkᵢ:
    IV₁       ← first 12 bytes of encryptedChunkᵢ
    ciphertext ← remaining bytes
    plaintextᵢ ← crypto.subtle.decrypt(
        { name: "AES-GCM", iv: IV₁ },
        aesKey,
        ciphertext
    )
    → If AuthTag mismatch: decryption throws → chunk rejected

STEP 5 — Reassembly and save
  Decrypted chunks accumulated as Blob parts
  → new Blob([plaintext₁, plaintext₂, …]) constructed
  → Object URL created: URL.createObjectURL(blob)
  → Anchor click triggered → browser saves file to disk
  → Object URL revoked to free memory
```

### Progress Tracking

Because the Worker sets `Content-Length` on the response and chunks are fixed-size (5 MB), the UI can display accurate per-file download progress:

```
bytesReceived / totalBytes × 100 = download %
```

---

## 4. Room Lifecycle and Expiry Flow

```
Room Created
    │
    ▼
KV entry written with expiresAt timestamp
    │
    │◄──────────────────────────────────────────────────────┐
    │                                                       │
    │  Every 10 minutes: Cron Trigger fires                 │
    │                                                       │
    │  Worker scheduled handler:                            │
    │    1. List all KV keys with prefix "room:"            │
    │    2. For each key:                                   │
    │         read metadata → check expiresAt               │
    │         if Date.now() > expiresAt:                    │
    │           list R2 objects: rooms/<code>/*             │
    │           R2.delete() each object                     │
    │           KV.delete("room:<code>")                    │
    │           decrement ROOMS_KV storage counter          │
    │                                                       │
    └───────────────────────────────────────────────────────┘
    │
    ▼
Room fully purged from KV + R2
(maximum residency: TTL + up to 10 minutes cron lag)
```

### TTL Configuration

| Parameter | Default | Min | Max |
|---|---|---|---|
| `DEFAULT_ROOM_TTL_HOURS` | 24 hours | 1 hour | 24 hours |
| Cron cleanup frequency | Every 10 min | — | — |
| Max post-expiry residency | ~10 minutes | — | — |

---

## 5. Signaling Flow (WebRTC)

WebRTC requires an out-of-band signaling channel to exchange session descriptions and ICE candidates. Zap uses `ZapHub` for this.

```
Sender                ZapHub DO              Receiver
  │                      │                         │
  │── connect ──────────►│◄── connect ─────────────│
  │                      │  (room scoped by code)  │
  │                      │                         │
  │── { type:"offer", ──►│── { type:"offer",   ──► │
  │     sdp: "v=0..." }  │     sdp: "v=0..." }     │
  │                      │                         │
  │◄── { type:"answer", ─│◄── { type:"answer",  ── │
  │      sdp: "v=0..." } │      sdp: "v=0..." }    │
  │                      │                         │
  │── { type:"ice",   ──►│── { type:"ice",      ──►│
  │     candidate:{...}} │     candidate:{...} }   │
  │                      │                         │
  │◄── { type:"ice",  ───│◄── { type:"ice",     ── │
  │      candidate:{...}}│      candidate:{...} }  │
  │                      │                         │
  └──────────── RTCDataChannel established─────────┘
               (ZapHub no longer involved)
```

**Message types handled by ZapHub**: `offer`, `answer`, `ice`, and binary `ArrayBuffer` (relay fallback only).

---

## 6. Relay Fallback Flow

If ICE negotiation fails (e.g., symmetric NAT on both sides, no TURN configured), `ZapHub` transparently relays binary data.

```
Sender                ZapHub DO              Receiver
  │                       │                       │
  │── ArrayBuffer ───────►│── ArrayBuffer ───────►│
  │   (256 KB chunk)      │   (forwarded as-is)   │
  │                       │                       │
  │   [No decryption or inspection by ZapHub]     │
  │   [TLS on WebSocket wraps transit]            │
```

Relay sessions are capped at `MAX_CONCURRENT_RELAYS` (default: 3) to prevent bandwidth saturation. The connection quality badge updates to show "Relayed" and increases RTT display when this path is active.

---

## 7. Data Boundaries Summary

The following table summarises precisely what data crosses each boundary and in what form.

| Boundary | Data Crossing | Form |
|---|---|---|
| Browser → ZapHub (signaling) | SDP, ICE candidates | JSON over WSS |
| Browser → ZapHub (relay) | File chunks | Binary ArrayBuffer over WSS (DTLS cannot be applied here; TLS on WebSocket is the transport security) |
| Browser ↔ Browser (P2P direct) | File chunks | Binary ArrayBuffer, DTLS-encrypted DataChannel |
| Browser → Worker (Cloud Hold upload) | Encrypted file chunks | Binary, AES-256-GCM ciphertext |
| Worker → R2 (Cloud Hold store) | Encrypted file chunks | Binary ciphertext (R2 applies additional AES-256 at rest) |
| Worker → Browser (Cloud Hold download) | Encrypted file chunks | Binary, streamed over HTTPS |
| Browser (Cloud Hold download) | Plaintext | Only in browser memory; never retransmitted |
| Browser → Worker (key retrieval) | AES key hex | HTTPS response; key never stored client-side after use |

**Key insight**: At no point does the server receive or transmit plaintext file content in Cloud Hold mode. In P2P direct mode, the server receives no file content at all.

---

*For the full security analysis of these data flows, see [`security.md`](./security.md). For component responsibilities, see [`architecture.md`](./architecture.md).*
