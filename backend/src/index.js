/**
 * Zap Backend — Cloudflare Worker Entry Point
 *
 * Fixes applied:
 *  - CRITICAL #2: Download no longer 302-redirects in production.
 *                 Files stream through the Worker so the frontend's
 *                 chunk-decrypt loop receives Content-Length and can
 *                 show accurate progress.
 *  - CRITICAL #3: Multipart ETag — backend re-adds quotes before
 *                 calling R2 native binding complete(), since the
 *                 frontend strips them for S3 compatibility.
 *  - HIGH     #4: MAX_ROOM_FILES default raised from 2 → 10 to
 *                 match the frontend's enforced limit.
 *  - HIGH     #5: Content-Length header set on streamed downloads
 *                 using obj.size from R2 so progress bar works.
 *  - HIGH     #6: cloudHoldUploadComplete now errors if parts are
 *                 present but uploadId is missing.
 */

import { ZapHub } from './ZapHub.js';
export { ZapHub };

// ── Constants ─────────────────────────────────────────

const MAX_FILE_SIZE_GB = 2.2;
const MAX_STORAGE_GB = 8;
const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

// ── Helpers ───────────────────────────────────────────

function json(data, status = 200) {
  return Response.json(data, { status, headers: CORS_HEADERS });
}

function err(msg, status = 400) {
  return json({ error: msg }, status);
}

function generateKey(roomId, fileName) {
  return `rooms/${roomId}/${Date.now()}-${fileName}`;
}

// get the hub DO instance
function getHub(env) {
  return env.HUB.get(env.HUB.idFromName('global'));
}

async function hubFetch(env, path, options = {}) {
  const hub = getHub(env);
  return hub.fetch(new Request(`http://do-internal${path}`, options));
}

// ── Main Worker ───────────────────────────────────────

export default {

  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method;

    if (method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    // WebSocket upgrade → delegate to ZapHub DO
    if (request.headers.get('Upgrade') === 'websocket' && path === '/ws') {
      return getHub(env).fetch(request);
    }

    // R2 upload proxy
    if (method === 'PUT' && path.startsWith('/api/r2/upload/')) {
      return handleR2Upload(request, env, path);
    }

    // R2 download proxy
    if (method === 'GET' && path.startsWith('/api/r2/download/')) {
      return handleR2Download(request, env, path);
    }

    // Health
    if (path === '/api/health') {
      return json({
        status: 'healthy',
        timestamp: new Date().toISOString(),
        version: '2.0.1-worker',
        runtime: 'cloudflare-workers',
      });
    }

    if (path === '/api/upload-url' && method === 'POST') return handleUploadUrl(request, env);
    if (path === '/api/download-url' && method === 'POST') return handleDownloadUrl(request, env);
    if (path === '/api/upload-complete' && method === 'POST') return handleUploadComplete(request, env);
    if (path === '/api/validate-file' && method === 'POST') return handleValidateFile(request, env);
    if (path === '/api/encryption-key' && method === 'GET') return handleEncryptionKey(env);
    if (path === '/api/storage-stats' && method === 'GET') return handleStorageStats(env);
    if (path === '/api/turn-credentials' && method === 'GET') return handleTurnCredentials(env);

    if (path === '/api/room-stats' && method === 'GET') {
      const resp = await hubFetch(env, '/internal/room-stats');
      return json(await resp.json());
    }

    if (path === '/api/cleanup' && method === 'POST') {
      const body = await request.json().catch(() => ({}));
      const resp = await hubFetch(env, '/internal/cleanup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      return json(await resp.json());
    }

    // Cloud Hold routes

    const uploadFileMatch = path.match(/^\/api\/room\/upload-file\/([A-Z0-9]{6})\/([a-z0-9-]+)\/(.+)$/);
    if (method === 'PUT' && uploadFileMatch) {
      return cloudHoldHandleUploadFile(request, env, uploadFileMatch[1], uploadFileMatch[2], uploadFileMatch[3]);
    }

    if (path === '/api/room/create' && method === 'POST') return cloudHoldCreateRoom(request, env);
    if (path === '/api/room/upload' && method === 'POST') return cloudHoldUpload(request, env);
    if (path === '/api/room/upload-complete' && method === 'POST') return cloudHoldUploadComplete(request, env);

    const roomMatch = path.match(/^\/api\/room\/([A-Z0-9]{6})$/);
    if (method === 'GET' && roomMatch) return cloudHoldGetRoom(roomMatch[1], env);
    if (method === 'DELETE' && roomMatch) return cloudHoldDeleteRoom(request, roomMatch[1], env);

    const downloadMatch = path.match(/^\/api\/room\/([A-Z0-9]{6})\/download\/(.+)$/);
    if (method === 'GET' && downloadMatch) return cloudHoldDownload(downloadMatch[1], downloadMatch[2], env);

    return err('Not found', 404);
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(runCleanup(env));
  },
};

// ── Cron Cleanup ──────────────────────────────────────

async function runCleanup(env) {
  await hubFetch(env, '/internal/cleanup', { method: 'POST' });

  // clean up old R2 files past 48h
  const cutoff = Date.now() - 48 * 60 * 60 * 1000;
  let cursor;
  let deletedCount = 0;

  do {
    const listed = await env.FILES.list({ prefix: 'rooms/', cursor, limit: 500 });
    for (const obj of listed.objects) {
      if (obj.uploaded.getTime() < cutoff) {
        await env.FILES.delete(obj.key);
        deletedCount++;
      }
    }
    cursor = listed.truncated ? listed.cursor : undefined;
  } while (cursor);

  if (deletedCount > 0) {
    console.log(`[cleanup] Deleted ${deletedCount} orphaned R2 objects`);
  }
}

// ── R2 Upload/Download Proxy ──────────────────────────

async function handleR2Upload(request, env, path) {
  const key = decodeURIComponent(path.replace('/api/r2/upload/', ''));
  await env.FILES.put(key, request.body, {
    httpMetadata: { contentType: request.headers.get('Content-Type') || 'application/octet-stream' },
  });
  return json({ success: true, key });
}

async function handleR2Download(request, env, path) {
  const key = decodeURIComponent(path.replace('/api/r2/download/', ''));
  const obj = await env.FILES.get(key);
  if (!obj) return err('File not found', 404);

  const headers = new Headers(CORS_HEADERS);
  headers.set('Content-Type', obj.httpMetadata?.contentType || 'application/octet-stream');
  headers.set('Content-Disposition', `attachment; filename="${key.split('/').pop()}"`);
  // FIX #5: always include Content-Length so download progress works
  if (obj.size) headers.set('Content-Length', String(obj.size));

  return new Response(obj.body, { headers });
}

// ── REST Route Handlers ───────────────────────────────

async function handleUploadUrl(request, env) {
  let body;
  try { body = await request.json(); } catch { return err('Invalid JSON body'); }

  const { roomId, fileName, fileSize, contentType } = body;
  if (!roomId || !fileName || !fileSize) return err('Missing required fields: roomId, fileName, fileSize');

  const roomCheck = await hubFetch(env, '/internal/room-lookup', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ roomId }),
  });
  if (!roomCheck.ok) return err('Room not found', 404);

  const maxFileBytes = MAX_FILE_SIZE_GB * 1024 * 1024 * 1024;
  if (fileSize > maxFileBytes) return err(`File exceeds maximum allowed size of ${MAX_FILE_SIZE_GB}GB`);

  const storedUsage = parseInt((await env.ROOMS_KV.get('r2_usage_bytes')) || '0');
  const maxStorageBytes = MAX_STORAGE_GB * 1024 * 1024 * 1024;
  if (storedUsage + fileSize > maxStorageBytes) {
    return err(`Storage capacity exceeded. Used: ${formatBytes(storedUsage)}, Max: ${formatBytes(maxStorageBytes)}`);
  }

  const key = generateKey(roomId, fileName);
  const uploadUrl = new URL(request.url);
  uploadUrl.pathname = `/api/r2/upload/${encodeURIComponent(key)}`;

  return json({ uploadUrl: uploadUrl.toString(), key, expiresIn: 3600 });
}

async function handleDownloadUrl(request, env) {
  let body;
  try { body = await request.json(); } catch { return err('Invalid JSON body'); }
  const { key } = body;
  if (!key) return err('Missing required field: key');

  const downloadUrl = new URL(request.url);
  downloadUrl.pathname = `/api/r2/download/${encodeURIComponent(key)}`;
  return json({ downloadUrl: downloadUrl.toString(), expiresIn: 3600 });
}

async function handleUploadComplete(request, env) {
  let body;
  try { body = await request.json(); } catch { return err('Invalid JSON body'); }

  const { roomId, key, fileName, fileSize } = body;
  if (!roomId || !key) return err('Missing required fields: roomId, key');

  const current = parseInt((await env.ROOMS_KV.get('r2_usage_bytes')) || '0');
  await env.ROOMS_KV.put('r2_usage_bytes', String(current + (fileSize || 0)));

  await hubFetch(env, '/internal/upload-complete', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ roomId, key, fileName, fileSize }),
  });

  return json({ success: true });
}

async function handleValidateFile(request, env) {
  let body;
  try { body = await request.json(); } catch { return err('Invalid JSON body'); }

  const { fileName, fileSize } = body;
  if (!fileName || !fileSize) return err('Missing required fields: fileName, fileSize');

  const maxFileBytes = MAX_FILE_SIZE_GB * 1024 * 1024 * 1024;
  if (fileSize > maxFileBytes) return err(`File exceeds maximum allowed size of ${MAX_FILE_SIZE_GB}GB`);

  return json({ valid: true, message: 'File validation passed' });
}

async function handleEncryptionKey(env) {
  const pwd = env.ENCRYPTION_PASSWORD || 'default_zap_encryption_key';
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(pwd));
  const keyHex = [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
  return json({ keyHex });
}

async function handleTurnCredentials(env) {
  const keyId = env.CF_TURN_KEY_ID;
  const apiToken = env.CF_TURN_API_TOKEN;

  if (!keyId || !apiToken) {
    // Fallback: return public STUN only
    return json({
      iceServers: [{ urls: 'stun:stun.cloudflare.com:3478' }]
    });
  }

  try {
    const resp = await fetch(
      `https://rtc.live.cloudflare.com/v1/turn/keys/${keyId}/credentials/generate`,
      {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${apiToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ ttl: 86400 }),
      }
    );
    if (!resp.ok) throw new Error(`Cloudflare TURN API: ${resp.status}`);
    const { iceServers } = await resp.json();
    return json({ iceServers });
  } catch (e) {
    console.error('[TURN]', e);
    return json({
      iceServers: [{ urls: 'stun:stun.cloudflare.com:3478' }]
    });
  }
}

async function handleStorageStats(env) {
  const usage = parseInt((await env.ROOMS_KV.get('r2_usage_bytes')) || '0');
  const maxBytes = MAX_STORAGE_GB * 1024 * 1024 * 1024;
  return json({
    currentUsage: usage,
    maxCapacity: maxBytes,
    usagePercentage: (usage / maxBytes) * 100,
    availableSpace: maxBytes - usage,
    formatted: {
      used: formatBytes(usage),
      max: formatBytes(maxBytes),
      available: formatBytes(maxBytes - usage),
    },
  });
}

// ── Utilities ─────────────────────────────────────────

function formatBytes(bytes) {
  if (bytes === 0) return '0 Bytes';
  const k = 1024;
  const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

// ── Cloud Hold Handlers ───────────────────────────────

// 6-char room code, skips confusing chars like O and I
function cloudRoomCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 6; i++) code += chars[Math.floor(Math.random() * chars.length)];
  return code;
}

function cloudFileId() {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

async function cloudHoldCreateRoom(request, env) {
  let body;
  try { body = await request.json(); } catch { return err('Invalid JSON body'); }

  const { name, expiry } = body;
  if (!name || typeof name !== 'string' || !name.trim()) return err('Name is required');
  if (!expiry || typeof expiry !== 'number' || expiry < 3600 || expiry > 86400 * 7) {
    return err('Invalid expiry. Must be between 1 hour and 7 days (in seconds).');
  }

  let code, attempts = 0;
  do {
    code = cloudRoomCode();
    const existing = await env.ROOMS.get(`room:${code}`);
    if (!existing) break;
    attempts++;
  } while (attempts < 5);

  if (attempts >= 5) return err('Failed to generate unique room code. Try again.', 500);

  const adminToken = cloudFileId();
  const roomData = {
    name: name.trim(), code, files: [],
    adminToken,
    createdAt: Date.now(),
    expiresAt: Date.now() + expiry * 1000,
    expirySeconds: expiry,
  };

  await env.ROOMS.put(`room:${code}`, JSON.stringify(roomData), { expirationTtl: expiry });

  const hrs = Math.round(expiry / 3600);
  return json({
    code, adminToken, name: roomData.name,
    expiresAt: roomData.expiresAt,
    expiresIn: `${hrs} hours`,
  }, 201);
}

async function cloudHoldUpload(request, env) {
  let body;
  try { body = await request.json(); } catch { return err('Invalid JSON body'); }

  const { code, fileName, fileSize, contentType = 'application/octet-stream' } = body;
  if (!code || !fileName || !fileSize) return err('Missing required fields: code, fileName, fileSize');

  const roomJson = await env.ROOMS.get(`room:${code}`);
  if (!roomJson) return err('Room not found or expired', 404);

  const room = JSON.parse(roomJson);

  // FIX #4 (HIGH): default raised from 2 → 10 to match frontend limit
  const maxFiles = parseInt(env.MAX_ROOM_FILES) || 10;
  if (room.files.length >= maxFiles) return err(`Maximum ${maxFiles} files per room`);

  const maxSizeMB = parseInt(env.MAX_FILE_SIZE_MB) || 2252;
  const maxSizeBytes = maxSizeMB * 1024 * 1024;
  if (fileSize > maxSizeBytes) return err(`File too large. Maximum ${maxSizeMB}MB`);

  const fileId = cloudFileId();
  const decodedFileName = fileName;
  const r2Key = `rooms/${code}/${fileId}-${decodedFileName}`;

  let uploadMethod = 'worker';
  let uploadUrls = [];
  let uploadId = null;

  // pick upload path — multipart if R2 keys are set, else Worker proxy
  if (env.R2_ACCOUNT_ID && env.R2_ACCESS_KEY_ID && env.R2_SECRET_ACCESS_KEY) {
    uploadMethod = 'multipart';
    const CHUNK_SIZE = 5 * 1024 * 1024;
    const numChunks = Math.ceil(fileSize / CHUNK_SIZE) || 1;

    const multipart = await env.FILES.createMultipartUpload(r2Key, {
      httpMetadata: { contentType },
      customMetadata: { roomCode: code, fileName: decodedFileName, fileId, uploadedAt: Date.now().toString() },
    });
    uploadId = multipart.uploadId;

    for (let i = 1; i <= numChunks; i++) {
      uploadUrls.push(await generateR2PresignedUrl(env, r2Key, contentType, 3600, 'PUT', {
        partNumber: String(i),
        uploadId: uploadId,
      }));
    }
  } else {
    const workerUrl = new URL(request.url);
    workerUrl.pathname = `/api/room/upload-file/${code}/${fileId}/${encodeURIComponent(decodedFileName)}`;
    uploadUrls = [workerUrl.toString()];
  }

  return json({ fileId, r2Key, uploadUrls, uploadMethod, uploadId, maxSize: maxSizeBytes });
}

async function cloudHoldHandleUploadFile(request, env, code, fileId, fileName) {
  const roomJson = await env.ROOMS.get(`room:${code}`);
  if (!roomJson) return err('Room not found or expired', 404);

  const room = JSON.parse(roomJson);
  const decodedFileName = decodeURIComponent(fileName);
  const r2Key = `rooms/${code}/${fileId}-${decodedFileName}`;
  const contentType = request.headers.get('Content-Type') || 'application/octet-stream';

  await env.FILES.put(r2Key, request.body, {
    httpMetadata: { contentType },
    customMetadata: { roomCode: code, fileName: decodedFileName, fileId, uploadedAt: Date.now().toString() },
  });

  const obj = await env.FILES.head(r2Key);
  const fileSize = obj ? obj.size : 0;

  room.files.push({ id: fileId, name: decodedFileName, size: fileSize, r2Key, uploadedAt: Date.now(), contentType });

  const remainingTtl = Math.max(60, Math.floor((room.expiresAt - Date.now()) / 1000));
  await env.ROOMS.put(`room:${code}`, JSON.stringify(room), { expirationTtl: remainingTtl });

  return json({ success: true, fileId, fileName: decodedFileName, fileSize });
}

async function cloudHoldUploadComplete(request, env) {
  let body;
  try { body = await request.json(); } catch { return err('Invalid JSON body'); }

  const { code, fileId, fileName, fileSize, uploadId, parts } = body;
  if (!code || !fileId) return err('Missing required fields: code, fileId');

  const roomJson = await env.ROOMS.get(`room:${code}`);
  if (!roomJson) return err('Room not found or expired', 404);

  const room = JSON.parse(roomJson);
  const r2Key = `rooms/${code}/${fileId}-${fileName}`;

  // FIX #6 (HIGH): validate uploadId is present when parts are provided
  if (parts && parts.length > 0 && !uploadId) {
    return err('uploadId is required when completing a multipart upload', 400);
  }

  if (uploadId && parts && parts.length > 0) {
    try {
      const multipart = env.FILES.resumeMultipartUpload(r2Key, uploadId);

      // FIX #3 (CRITICAL): R2 native binding complete() requires ETags WITH quotes.
      // The frontend strips quotes for S3 presigned URL compatibility, so we
      // re-add them here before passing to the native binding.
      await multipart.complete(parts.map(p => ({
        partNumber: parseInt(p.partNumber),
        etag: p.etag.startsWith('"') ? p.etag : `"${p.etag}"`,
      })));
    } catch (e) {
      console.error('Multipart complete failed:', e);
      return err('Failed to complete multipart upload', 500);
    }
  }

  // Idempotency: skip if already recorded
  if (room.files.some(f => f.id === fileId)) {
    return json({ success: true, message: 'File already recorded' });
  }

  room.files.push({ id: fileId, name: fileName, size: fileSize, r2Key, uploadedAt: Date.now() });

  const remainingTtl = Math.max(60, Math.floor((room.expiresAt - Date.now()) / 1000));
  await env.ROOMS.put(`room:${code}`, JSON.stringify(room), { expirationTtl: remainingTtl });

  return json({ success: true, filesCount: room.files.length });
}

async function cloudHoldGetRoom(code, env) {
  const roomJson = await env.ROOMS.get(`room:${code}`);
  if (!roomJson) return err('Room not found or expired', 404);

  const room = JSON.parse(roomJson);
  return json({
    code: room.code, name: room.name,
    files: room.files.map(f => ({ id: f.id, name: f.name, size: f.size, uploadedAt: f.uploadedAt })),
    createdAt: room.createdAt,
    expiresAt: room.expiresAt,
    timeRemaining: Math.max(0, room.expiresAt - Date.now()),
  });
}

async function cloudHoldDeleteRoom(request, code, env) {
  const roomJson = await env.ROOMS.get(`room:${code}`);
  if (!roomJson) return json({ success: true }); // idempotent

  const room = JSON.parse(roomJson);
  const authHeader = request.headers.get('Authorization');
  if (authHeader !== `Bearer ${room.adminToken}`) {
    return err('Unauthorized: missing or invalid admin token', 401);
  }

  for (const file of room.files) {
    if (file.r2Key) await env.FILES.delete(file.r2Key).catch(() => { });
  }

  await env.ROOMS.delete(`room:${code}`);
  return json({ success: true, message: 'Room deleted safely' });
}

// FIX #2 (CRITICAL): Download always streams through the Worker instead of
// redirecting to a presigned R2 URL. A 302 redirect would:
//   a) bypass the frontend's chunk-decrypt streaming loop
//   b) lose Content-Length (R2 presigned GETs don't always include it)
//   c) break download progress display
// Streaming through the Worker costs slightly more CPU but is correct.
async function cloudHoldDownload(code, fileId, env) {
  const roomJson = await env.ROOMS.get(`room:${code}`);
  if (!roomJson) return err('Room not found or expired', 404);

  const room = JSON.parse(roomJson);
  const file = room.files.find(f => f.id === fileId);
  if (!file) return err('File not found', 404);

  const object = await env.FILES.get(file.r2Key);
  if (!object) return err('File data not found in storage', 404);

  const headers = new Headers(CORS_HEADERS);
  headers.set('Content-Type', object.httpMetadata?.contentType || 'application/octet-stream');
  headers.set('Content-Disposition', `attachment; filename="${file.name}"`);
  // FIX #5 (HIGH): always set Content-Length from R2 object metadata
  // so the frontend decrypt loop can show accurate progress percentage.
  if (object.size) headers.set('Content-Length', String(object.size));

  return new Response(object.body, { headers });
}

// ── AWS v4 Presigned URL (upload only) ───────────────
// Note: presigned URLs are now only used for PUT (upload) not GET (download).
// Downloads always go through cloudHoldDownload above.

async function generateR2PresignedUrl(env, r2Key, contentType, expiresInSec = 3600, method = 'PUT', extraQueryParams = {}) {
  const accountId = env.R2_ACCOUNT_ID;
  const accessKeyId = env.R2_ACCESS_KEY_ID;
  const secretKey = env.R2_SECRET_ACCESS_KEY;
  const bucket = env.R2_BUCKET_NAME || 'zap-files';
  const region = 'auto';
  const service = 's3';

  const host = `${accountId}.r2.cloudflarestorage.com`;
  const now = new Date();

  const pad = n => String(n).padStart(2, '0');
  const dateStr = `${now.getUTCFullYear()}${pad(now.getUTCMonth() + 1)}${pad(now.getUTCDate())}`;
  const timeStr = `${pad(now.getUTCHours())}${pad(now.getUTCMinutes())}${pad(now.getUTCSeconds())}`;
  const datetime = `${dateStr}T${timeStr}Z`;

  const credentialScope = `${dateStr}/${region}/${service}/aws4_request`;
  const credential = `${accessKeyId}/${credentialScope}`;

  const queryParams = [
    ['X-Amz-Algorithm', 'AWS4-HMAC-SHA256'],
    ['X-Amz-Content-Sha256', 'UNSIGNED-PAYLOAD'],
    ['X-Amz-Credential', credential],
    ['X-Amz-Date', datetime],
    ['X-Amz-Expires', String(expiresInSec)],
    ['X-Amz-SignedHeaders', 'host'],
  ];

  for (const [k, v] of Object.entries(extraQueryParams)) {
    queryParams.push([k, v]);
  }

  queryParams.sort((a, b) => a[0].localeCompare(b[0]));

  const queryString = queryParams
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join('&');

  const canonicalUri = `/${bucket}/${r2Key.split('/').map(encodeURIComponent).join('/')}`;
  const canonicalHeaders = `host:${host}\n`;
  const signedHeaders = 'host';

  const canonicalRequest = [
    method,
    canonicalUri,
    queryString,
    canonicalHeaders,
    signedHeaders,
    'UNSIGNED-PAYLOAD',
  ].join('\n');

  const stringToSign = [
    'AWS4-HMAC-SHA256',
    datetime,
    credentialScope,
    await sha256Hex(canonicalRequest),
  ].join('\n');

  const signingKey = await deriveSigningKey(secretKey, dateStr, region, service);
  const signature = await hmacHex(signingKey, stringToSign);

  return `https://${host}/${bucket}/${r2Key}?${queryString}&X-Amz-Signature=${signature}`;
}

// ── Crypto helpers ────────────────────────────────────

async function sha256Hex(message) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(message));
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
}

async function hmacSign(key, message) {
  const k = typeof key === 'string'
    ? await crypto.subtle.importKey('raw', new TextEncoder().encode(key), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
    : await crypto.subtle.importKey('raw', key, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return crypto.subtle.sign('HMAC', k, typeof message === 'string' ? new TextEncoder().encode(message) : message);
}

async function hmacHex(key, message) {
  return [...new Uint8Array(await hmacSign(key, message))].map(b => b.toString(16).padStart(2, '0')).join('');
}

async function deriveSigningKey(secret, date, region, service) {
  const kDate = await hmacSign(`AWS4${secret}`, date);
  const kRegion = await hmacSign(kDate, region);
  const kService = await hmacSign(kRegion, service);
  return hmacSign(kService, 'aws4_request');
}