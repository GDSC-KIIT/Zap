<div align="center">

<img src="frontend/assets/zap logo.svg" alt="Zap Logo" width="72" height="72">

# Zap

**Peer-to-peer file transfer — encrypted, direct, and ephemeral.**

[![Live](https://img.shields.io/badge/live-zap.zap--files.workers.dev-brightgreen?style=flat-square)](https://zap.zap-files.workers.dev)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue?style=flat-square)](LICENSE)
[![Built on Cloudflare Workers](https://img.shields.io/badge/cloudflare-workers-F38020?style=flat-square&logo=cloudflare&logoColor=white)](https://workers.cloudflare.com)
[![Docs](https://img.shields.io/badge/docs-Google%20Docs-4285F4?style=flat-square&logo=googledocs&logoColor=white)](https://docs.google.com/document/d/1VfMF_COy8hM_mf03bPSOm7bFpykexB-2pKqZTsBW0FE/edit?usp=sharing)
![Visitors](https://visitor-badge.laobi.icu/badge?page_id=RitwikRishRaj.Zap)

</div>

---

## What is Zap?

Zap is a no-signup file transfer tool with two modes:

| Mode | How it works |
|---|---|
| **Direct P2P** | Files go browser → browser over a **WebRTC DataChannel**. The WebSocket (via `ZapHub` Durable Object) is used only for signaling (offer/answer/ICE). If a direct path can't be established, the Durable Object relays the binary data as a fallback. Nothing is stored on any server. |
| **Cloud Hold** | Files are AES-GCM encrypted in 5 MB chunks and uploaded to Cloudflare R2 inside a temporary room. Downloads stream through the Worker for decryption with accurate progress. The room auto-deletes in 1–24 hours. |

---

## Features

- ⚡ **Instant rooms** — 6-character code, no sign-up, no dashboard
- 🔒 **End-to-end encrypted** — AES-GCM (Web Crypto API) for Cloud Hold; direct channel for P2P
- 🌐 **WebRTC P2P** — files sent over `RTCDataChannel` in 256 KB chunks, with ICE restart on failure
- 🔁 **Server relay fallback** — `ZapHub` relays binary chunks when direct ICE path fails
- ☁️ **Cloud Hold** — R2-backed ephemeral rooms, multipart upload support, streamed downloads
- 📶 **Connection quality badge** — shows Direct/Relayed and round-trip time in real time
- 🧹 **Auto-purge** — cron trigger every 10 min deletes expired rooms and R2 objects
- 📱 **QR sharing** — shareable link with QR code for P2P sessions
- 🗂️ **Active rooms panel** — browser-local session cache with live expiry countdowns

---

## Architecture

```
Zap/
├── frontend/              → Static assets served via Cloudflare Workers Assets
│   ├── index.html         → Single-page app (SPA, no framework)
│   ├── style.css          → All styles (vanilla CSS, dark/light themes)
│   ├── script.js          → All app logic: P2P, Cloud Hold, Encryption, UI
│   └── assets/
│       └── zap logo.svg   → Logo + favicon
└── backend/
    ├── src/
    │   ├── index.js        → Worker entry point — API routing, R2 proxy, cron cleanup
    │   └── ZapHub.js       → Durable Object — WebSocket hub, signaling, server relay
    └── wrangler.toml       → Deployment config (gitignored — copy from wrangler.toml.example)
```

### P2P Transfer Flow

```
Sender ─── WebSocket ──► ZapHub DO ◄── WebSocket ─── Receiver
              ↕ signaling (offer / answer / ICE)
Sender ─────────────── RTCDataChannel ───────────────► Receiver
              (256 KB binary chunks, direct or relayed)
```

1. Both peers connect to `ZapHub` over WebSocket
2. Sender creates an `RTCPeerConnection` → sends SDP offer via WebSocket
3. Receiver answers → ICE negotiation completes
4. File bytes flow over the `RTCDataChannel` (256 KB chunks)
5. If ICE fails, `ZapHub` relays raw `ArrayBuffer` chunks as fallback

### Cloud Hold Transfer Flow

```
Browser
  ↓  AES-GCM encrypt (5 MB chunks, random IV per chunk)
Worker API  →  Cloudflare R2 (via Worker proxy or multipart PUT)
                    ↓
Receiver → Worker streaming download → chunked AES-GCM decrypt → save
```

---

## Cloudflare Services

| Service | Purpose |
|---|---|
| **Workers** | API layer, R2 upload/download proxy, cron cleanup |
| **Durable Objects** (`ZapHub`) | WebSocket signaling + server-side binary relay fallback |
| **R2** | Encrypted file storage for Cloud Hold rooms |
| **KV** (`ROOMS`) | Cloud Hold room metadata + expiry |
| **KV** (`ROOMS_KV`) | R2 storage usage counter |
| **Workers Assets** | Serves the `frontend/` static files |
| **Cron Triggers** | `*/10 * * * *` — cleanup expired rooms and orphaned R2 objects |

---

## Getting Started

### Prerequisites

- [Node.js](https://nodejs.org) ≥ 18
- A [Cloudflare account](https://dash.cloudflare.com) with Workers, R2, and KV enabled

### 1. Clone

```bash
git clone https://github.com/RitwikRishRaj/Zap.git
cd Zap/backend
```

### 2. Configure

```bash
cp wrangler.toml.example wrangler.toml
```

Fill in your real IDs in `wrangler.toml`:

```toml
[[kv_namespaces]]
binding = "ROOMS_KV"
id = "<your-kv-namespace-id>"

[[kv_namespaces]]
binding = "ROOMS"
id = "<your-rooms-kv-namespace-id>"

[[r2_buckets]]
binding = "FILES"
bucket_name = "<your-r2-bucket-name>"
```

### 3. Install & Deploy

```bash
npm install
npm run deploy
```

### 4. Local Development

```bash
npm run dev
# → http://localhost:8787
```

---

## Environment Variables

Set in `wrangler.toml` under `[vars]`:

| Variable | Default | Description |
|---|---|---|
| `MAX_ROOMS_PER_IP` | `10` | Max active P2P/DO rooms per IP |
| `DEFAULT_ROOM_TTL_HOURS` | `24` | Default P2P room lifetime |
| `MAX_R2_STORAGE_GB` | `8` | Total R2 storage cap |
| `MAX_R2_FILE_SIZE_GB` | `2` | Max single file size |
| `MAX_ROOM_FILES` | `10` | Max files per Cloud Hold room |
| `MAX_CONCURRENT_RELAYS` | `3` | Max simultaneous server relay sessions |
| `RATE_LIMIT_WINDOW_MS` | `900000` | Rate limit window (15 min) |
| `RATE_LIMIT_MAX_REQUESTS` | `100` | Max requests per window |

**Optional — Cloudflare TURN (improves P2P behind strict NAT):**

```toml
[vars]
CF_TURN_KEY_ID    = "..."   # from dash.cloudflare.com > Calls
CF_TURN_API_TOKEN = "..."
```

Without TURN keys, Zap falls back to `stun:stun.cloudflare.com:3478` and the server relay.

---

## API Reference

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/health` | Health check + version |
| `WS` | `/ws` | WebSocket — P2P signaling & relay (`ZapHub` DO) |
| `POST` | `/api/room/create` | Create a Cloud Hold room |
| `GET` | `/api/room/:code` | Get room info & file list |
| `DELETE` | `/api/room/:code` | Delete room (requires `Authorization: Bearer <adminToken>`) |
| `POST` | `/api/room/upload` | Initiate file upload (returns upload URL + fileId) |
| `PUT` | `/api/room/upload-file/:code/:fileId/:name` | Direct Worker upload fallback |
| `POST` | `/api/room/upload-complete` | Finalize upload / complete multipart |
| `GET` | `/api/room/:code/download/:fileId` | Stream-download a file (sets `Content-Length` for progress) |
| `GET` | `/api/storage-stats` | R2 usage stats |
| `GET` | `/api/turn-credentials` | ICE server config (STUN/TURN) for WebRTC |
| `GET` | `/api/encryption-key` | AES-GCM key hex (derived from `ENCRYPTION_PASSWORD`) |

---

## Built by

[GDG On Campus · KIIT](https://gdg-kiit.vercel.app), Bhubaneswar — Google Developer Groups student community.

---

## License

[MIT](LICENSE) © 2026 Ritwik
