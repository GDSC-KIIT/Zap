# System Architecture — Zap

> **Author:** Agam Singh Saluja  
> **Project:** Zap — Anonymous, Ephemeral File Transfer  
> **Scope:** High-level system design, component responsibilities, and infrastructure topology

---

## Table of Contents

1. [Architectural Philosophy](#1-architectural-philosophy)
2. [High-Level Topology](#2-high-level-topology)
3. [Frontend Layer](#3-frontend-layer)
4. [Backend Layer](#4-backend-layer)
5. [Cloudflare Services](#5-cloudflare-services)
6. [Transfer Mode Architectures](#6-transfer-mode-architectures)
7. [State Management](#7-state-management)
8. [Deployment Model](#8-deployment-model)

---

## 1. Architectural Philosophy

Zap is built on three architectural constraints:

- **Serverless-first**: No persistent origin servers. All compute runs on Cloudflare's edge network via Workers and Durable Objects.
- **Zero-persistence by default**: Files and room metadata have hard TTLs. The system is designed to hold data for the minimum necessary duration.
- **No-framework frontend**: The client is a single-page application written in vanilla HTML, CSS, and JavaScript — no bundler, no runtime framework, no npm dependencies at runtime.

These constraints reduce attack surface, operational overhead, and cold-start latency simultaneously.

---

## 2. High-Level Topology

```
┌────────────────────────────────────────────────────────────────┐
│                        CLIENT BROWSER                          │
│                                                                │
│  ┌────────────┐   ┌──────────────────┐   ┌──────────────────┐  │
│  │ index.html │   │   script.js      │   │   Web Crypto API │  │
│  │ style.css  │   │  (P2P + Cloud    │   │  (AES-256-GCM)   │  │
│  └────────────┘   │   Hold logic)    │   └──────────────────┘  │
│                   └──────────────────┘                         │
└────────────────────────────┬───────────────────────────────────┘
                             │ HTTPS / WSS (TLS 1.3)
                             ▼
┌─────────────────────────────────────────────────────────────────┐
│                   CLOUDFLARE EDGE NETWORK                       │
│                                                                 │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │               Cloudflare Worker (index.js)               │   │
│  │                                                          │   │
│  │  • API routing (/api/*)                                  │   │
│  │  • R2 upload / download proxy                            │   │
│  │  • Room lifecycle management                             │   │
│  │  • Storage quota enforcement                             │   │
│  │  • Cron cleanup (*/10 * * * *)                           │   │
│  │  • Static asset serving (Workers Assets)                 │   │
│  └──────────────────────────┬───────────────────────────────┘   │
│                             │                                   │
│          ┌──────────────────┼──────────────────┐                │
│          ▼                  ▼                  ▼                │
│   ┌──────────────┐  ┌──────────────┐  ┌──────────────────┐      │
│   │ ZapHub       │  │ Cloudflare   │  │ Cloudflare KV    │      │
│   │ Durable      │  │ R2           │  │                  │      │
│   │ Object       │  │              │  │ ROOMS: metadata  │      │
│   │              │  │ Encrypted    │  │ ROOMS_KV: quota  │      │
│   │ WebSocket    │  │ file chunks  │  │                  │      │
│   │ signaling +  │  │ (AES-GCM     │  │ TTL-expiring     │      │
│   │ relay        │  │  ciphertext) │  │ entries          │      │
│   └──────────────┘  └──────────────┘  └──────────────────┘      │
└─────────────────────────────────────────────────────────────────┘
                             │
                      WebRTC DataChannel
                      (ICE-negotiated, DTLS)
                             │
┌────────────────────────────▼────────────────────────────────────┐
│                     PEER BROWSER (P2P mode)                     │
└─────────────────────────────────────────────────────────────────┘
```

---

## 3. Frontend Layer

The frontend is a single-page application served as **static assets** via Cloudflare Workers Assets.

### File Structure

```
frontend/
├── index.html     → Application shell; single HTML file; no templating engine
├── style.css      → All styles; dark/light theme support via CSS variables
├── script.js      → All application logic (P2P, Cloud Hold, encryption, UI)
└── assets/
    └── zap logo.svg
```

### Responsibilities of `script.js`

| Domain | Responsibility |
|---|---|
| **P2P** | `RTCPeerConnection` lifecycle, SDP offer/answer, ICE candidate handling, DataChannel chunking (256 KB), ICE restart on failure |
| **Cloud Hold** | Room creation/joining, chunk encryption, multipart upload coordination, streaming download with progress |
| **Encryption** | AES-256-GCM encrypt/decrypt via `window.crypto.subtle`; IV generation; per-chunk key derivation |
| **Signaling** | WebSocket connection to `ZapHub`; message serialisation/deserialisation |
| **UI** | Room creation/join UI, connection quality badge (Direct/Relayed + RTT), QR code generation, active rooms panel with expiry countdown |
| **Session State** | Browser-local cache of active room codes and expiry timestamps |

### Connection Quality Badge

The UI exposes a real-time connection quality indicator:

```
[ ● Direct | 12 ms ]     ← ICE succeeded, direct path
[ ● Relayed | 48 ms ]    ← Falling back through ZapHub DO
```

Round-trip time is measured continuously via DataChannel ping/pong frames.

---

## 4. Backend Layer

### 4.1 Worker Entry Point (`index.js`)

The Cloudflare Worker is the sole HTTP entry point. It handles:

```
GET  /api/health              → Health check + version string
WS   /ws                      → Upgrade to WebSocket → delegates to ZapHub DO
POST /api/room/create         → Create Cloud Hold room (writes to KV)
GET  /api/room/:code          → Fetch room metadata + file list
DEL  /api/room/:code          → Admin-authenticated room deletion
POST /api/room/upload         → Initiate upload; returns upload URL + fileId
PUT  /api/room/upload-file/…  → Direct Worker upload fallback
POST /api/room/upload-complete→ Finalise upload or complete multipart
GET  /api/room/:code/download/:fileId → Streamed R2 download proxy
GET  /api/storage-stats       → R2 usage counters
GET  /api/turn-credentials    → STUN/TURN ICE config for WebRTC
GET  /api/encryption-key      → AES key hex (derived from ENCRYPTION_PASSWORD)
```

**Cron trigger** (`*/10 * * * *`): The Worker's scheduled handler iterates expired KV entries, deletes associated R2 objects, and resets storage counters.

### 4.2 ZapHub Durable Object (`ZapHub.js`)

`ZapHub` is a Cloudflare Durable Object that provides **stateful WebSocket coordination** — a capability not available in stateless Workers.

```
┌─────────────────────────────────────────┐
│             ZapHub DO Instance          │
│                                         │
│  WebSocket connections: [Sender, Recv]  │
│                                         │
│  Signaling messages:                    │
│    offer  → forward to peer             │
│    answer → forward to peer             │
│    ice    → forward to peer             │
│                                         │
│  Relay (fallback):                      │
│    ArrayBuffer → forward binary chunk   │
│    to the other connected peer          │
└─────────────────────────────────────────┘
```

Each P2P session gets its own DO instance, scoped to a room code. The DO holds no persistent state between sessions — it is purely an in-memory message router.

**Relay limit**: `MAX_CONCURRENT_RELAYS` (default: 3) caps the number of simultaneous server-relay sessions to prevent bandwidth abuse.

---

## 5. Cloudflare Services

| Service | Binding | Role |
|---|---|---|
| **Workers** | — | API layer, proxy, cron, asset serving |
| **Durable Objects** | `ZapHub` class | Stateful WebSocket hub per room |
| **R2** | `FILES` | Encrypted chunk storage for Cloud Hold |
| **KV** | `ROOMS` | Room metadata (code → JSON), TTL-expiring |
| **KV** | `ROOMS_KV` | Global R2 storage usage counter |
| **Workers Assets** | `frontend/` | Static file serving |
| **Cron Triggers** | `*/10 * * * *` | Expired room and orphan R2 object cleanup |
| **Cloudflare TURN** | Optional | ICE relay for WebRTC behind strict NAT |

---

## 6. Transfer Mode Architectures

### 6.1 P2P Mode

```
Sender Browser              ZapHub DO              Receiver Browser
      │                         │                         │
      │─── WebSocket connect ──►│◄── WebSocket connect ───│
      │                         │                         │
      │──── SDP Offer ─────────►│──── SDP Offer ─────────►│
      │◄─── SDP Answer ─────────│◄─── SDP Answer ─────────│
      │──── ICE Candidates ────►│──── ICE Candidates ────►│
      │◄─── ICE Candidates ─────│◄─── ICE Candidates ─────│
      │                         │                         │
      │═══════════ RTCDataChannel (DTLS, direct) ═════════│
      │           256 KB binary chunks                    │
      │                                                   │

  If ICE fails → ZapHub relays ArrayBuffer chunks (fallback)
```

**Chunk size**: 256 KB per DataChannel message, chosen to balance throughput and backpressure management.

### 6.2 Cloud Hold Mode

```
Sender Browser                 Worker                 Cloudflare R2
      │                           │                         │
      │── POST /api/room/create ─►│                         │
      │◄─ { code, adminToken } ───│                         │
      │                           │                         │
      │   [Encrypt chunk in browser: AES-256-GCM, 5 MB]     │
      │── POST /api/room/upload ─►│                         │
      │◄─ { uploadUrl, fileId } ──│                         │
      │── PUT uploadUrl ─────────►│──── R2.put(chunk) ─────►│
      │── POST /upload-complete ─►│                         │
      │                           │                         │
                                                            │
Receiver Browser               Worker                       │
      │                           │                         │
      │── GET /api/room/:code ───►│                         │
      │◄─ { files: [...] } ───────│                         │
      │── GET /download/:fileId ─►│──── R2.get(chunk) ─────►│
      │◄─ Streaming ciphertext ───│◄─── stream ─────────────│
      │  [Decrypt chunk in browser: AES-256-GCM]            │
      │  [Reassemble and trigger browser download]          │
```

---

## 7. State Management

| State | Location | Lifetime |
|---|---|---|
| Room metadata (code, TTL, file list) | Cloudflare KV (`ROOMS`) | 1–24 hours (configurable) |
| R2 storage usage counter | Cloudflare KV (`ROOMS_KV`) | Updated on upload/delete |
| WebSocket peer connections | ZapHub DO (in-memory) | Duration of P2P session only |
| Active rooms list, expiry timers | Browser local cache | Browser session only |
| Encryption key | Worker environment variable | Deployment lifetime |
| File ciphertext | Cloudflare R2 | Until room TTL expires |

No server-side session cookies, no user database, no persistent logs.

---

## 8. Deployment Model

Zap deploys entirely to Cloudflare's global edge network via `wrangler`:

```bash
# From backend/
npm install
npm run deploy   # wrangler deploy
```

**Configuration** (`wrangler.toml`):

```toml
[[kv_namespaces]]
binding = "ROOMS_KV"
id = "<kv-namespace-id>"

[[kv_namespaces]]
binding = "ROOMS"
id = "<rooms-kv-namespace-id>"

[[r2_buckets]]
binding = "FILES"
bucket_name = "<r2-bucket-name>"

[vars]
MAX_ROOMS_PER_IP         = "10"
DEFAULT_ROOM_TTL_HOURS   = "24"
MAX_R2_STORAGE_GB        = "8"
MAX_R2_FILE_SIZE_GB      = "2"
MAX_ROOM_FILES           = "10"
MAX_CONCURRENT_RELAYS    = "3"
RATE_LIMIT_WINDOW_MS     = "900000"
RATE_LIMIT_MAX_REQUESTS  = "100"
```

**Local development** runs via `wrangler dev` at `http://localhost:8787` with local simulations of KV, R2, and Durable Objects.

---

*For data flow detail, see [`data-flow.md`](./data-flow.md). For security analysis, see [`security.md`](./security.md).*
