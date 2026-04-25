/**
 * ZapHub — Cloudflare Durable Object
 *
 * Uses standard (non-hibernation) WebSocket API so that `this.rooms`
 * is preserved in memory for the lifetime of the DO instance.
 * The hibernation API was evicting the DO between messages, wiping rooms.
 *
 * Fixes:
 *  - CRITICAL: rooms Map preserved across messages (no more "Room not found")
 *  - CRITICAL #1: room_joined includes room.metadata so receiver sees file list
 *  - HIGH #7: webSocketClose roomId handled gracefully via #findClientRoom
 */

function generateRoomId() {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let id = '';
  for (let i = 0; i < 10; i++) id += chars[Math.floor(Math.random() * chars.length)];
  return id;
}

function generateClientId() {
  const arr = new Uint8Array(16);
  crypto.getRandomValues(arr);
  return Array.from(arr, b => b.toString(16).padStart(2, '0')).join('');
}

export class ZapHub {
  constructor(state, env) {
    this.state = state;
    this.env = env;

    // track rooms, IPs, and relay sessions in memory
    this.rooms = new Map(); // roomId → RoomObject
    this.ipCount = new Map(); // ip → count
    this.relays = new Map(); // senderId → RelayObject
  }

  // ── DO HTTP Interface ─────────────────────────────

  async fetch(request) {
    if (request.headers.get('Upgrade') === 'websocket') {
      return this.#handleWsUpgrade(request);
    }

    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method;

    if (path === '/internal/room-stats' && method === 'GET') {
      return Response.json(this.#getRoomStats());
    }

    if (path === '/internal/room-lookup' && method === 'POST') {
      const { roomId } = await request.json();
      const room = this.rooms.get(roomId);
      if (!room || Date.now() > room.expiresAt) return Response.json({ found: false }, { status: 404 });
      return Response.json({ found: true, storageUsed: room.storageUsed, mode: room.mode });
    }

    if (path === '/internal/upload-complete' && method === 'POST') {
      const { roomId, key, fileName, fileSize } = await request.json();
      const room = this.rooms.get(roomId);
      if (!room) return Response.json({ error: 'Room not found' }, { status: 404 });
      if (!room.files) room.files = [];
      room.files.push({ key, fileName, fileSize, uploadedAt: new Date().toISOString() });
      room.storageUsed += (fileSize || 0);
      return Response.json({ success: true });
    }

    if (path === '/internal/cleanup' && method === 'POST') {
      const cleaned = await this.#cleanupExpiredRooms();
      return Response.json({ cleaned });
    }

    return new Response('Not Found', { status: 404 });
  }

  // ── WebSocket — standard (non-hibernation) mode ───

  async #handleWsUpgrade(request) {
    const [client, server] = Object.values(new WebSocketPair());

    // Use standard accept() — keeps the DO alive while the WS is open.
    // This preserves this.rooms in memory (the hibernation API evicts the DO
    // between messages, silently wiping all room state).
    server.accept();

    const clientId = generateClientId();
    const clientIp = request.headers.get('CF-Connecting-IP') || '0.0.0.0';

    // Store per-socket state as a plain property (replaces serializeAttachment)
    server._att = { clientId, clientIp, roomId: null };

    server.send(JSON.stringify({ type: 'connected', clientId }));

    server.addEventListener('message', async event => {
      await this.#onMessage(server, event.data);
    });

    server.addEventListener('close', event => {
      const { clientId: cid, roomId } = server._att || {};
      if (cid) this.#handleDisconnection(cid, roomId);
    });

    server.addEventListener('error', () => {
      const { clientId: cid, roomId } = server._att || {};
      if (cid) this.#handleDisconnection(cid, roomId);
    });

    return new Response(null, { status: 101, webSocket: client });
  }

  async #onMessage(ws, message) {
    const att = ws._att || {};
    const { clientId, clientIp } = att;

    // Raw binary → relay chunk
    if (message instanceof ArrayBuffer) {
      this.#relayData(ws, clientId, { chunk: message });
      return;
    }

    let parsed;
    try {
      parsed = JSON.parse(message);
    } catch {
      this.#send(ws, { type: 'error', message: 'Invalid message format' });
      return;
    }

    await this.#route(ws, clientId, clientIp, parsed, att);
  }

  // ── Message Router ────────────────────────────────

  async #route(ws, clientId, clientIp, message, attachment) {
    const { type, roomId, data = {} } = message;

    switch (type) {
      case 'create_room':
        this.#createRoom(ws, clientId, clientIp, data, attachment);
        break;

      case 'join_room':
        this.#joinRoom(ws, clientId, data, attachment);
        break;

      case 'leave_room':
        this.#leaveRoom(ws, clientId, data, attachment);
        break;

      case 'signal':
        this.#forwardSignal(clientId, roomId, data);
        break;

      case 'transfer_start':
        this.#broadcastToRoom(roomId, clientId, {
          type: 'transfer_start', fromId: clientId, transferInfo: data.transferInfo,
        });
        break;

      case 'transfer_progress':
        this.#broadcastToRoom(roomId, clientId, {
          type: 'transfer_progress', fromId: clientId, progress: data.progress,
        });
        break;

      case 'transfer_complete':
        this.#broadcastToRoom(roomId, clientId, {
          type: 'transfer_complete', fromId: clientId, fileInfo: data.fileInfo,
        });
        break;

      case 'heartbeat':
        this.#send(ws, { type: 'heartbeat_response', timestamp: new Date().toISOString() });
        break;

      case 'relay_request':
        this.#relayRequest(ws, clientId, roomId || attachment.roomId, data);
        break;

      case 'relay_data':
        this.#relayData(ws, clientId, data);
        break;

      case 'relay_connect':
        this.#relayConnect(ws, clientId, data);
        break;

      default:
        this.#send(ws, { type: 'error', message: `Unknown message type: ${type}` });
    }
  }

  // ── Room Management ───────────────────────────────

  // create a new room and add the first client
  #createRoom(ws, clientId, clientIp, data = {}, attachment) {
    const maxRooms = parseInt(this.env.MAX_ROOMS_PER_IP) || 10;
    const currentCount = this.ipCount.get(clientIp) || 0;

    if (currentCount >= maxRooms) {
      this.#send(ws, { type: 'error', message: `Maximum rooms per IP (${maxRooms}) exceeded` });
      return;
    }

    const roomId = generateRoomId();
    const ttlHours = parseInt(this.env.DEFAULT_ROOM_TTL_HOURS) || 24;
    const expiresAt = Date.now() + ttlHours * 60 * 60 * 1000;

    const room = {
      id: roomId,
      createdAt: Date.now(),
      expiresAt,
      clients: new Map([[clientId, { ws, metadata: { isCreator: true }, joinedAt: Date.now() }]]),
      mode: data.mode || 'p2p',
      storageUsed: 0,
      files: [],
      metadata: data.metadata || {},
      creatorIp: clientIp,
    };

    this.rooms.set(roomId, room);
    this.ipCount.set(clientIp, currentCount + 1);

    // Update socket attachment with roomId
    ws._att = { ...attachment, roomId };

    this.#send(ws, {
      type: 'room_created',
      roomId,
      room: { id: roomId, mode: room.mode, expiresAt },
    });

    this.#broadcastToRoom(roomId, clientId, {
      type: 'user_joined', clientId, metadata: { isCreator: true },
    });
  }

  #joinRoom(ws, clientId, data = {}, attachment) {
    const { roomId, metadata = {} } = data;
    const room = this.rooms.get(roomId);

    if (!room) {
      this.#send(ws, { type: 'error', message: 'Room not found' });
      return;
    }
    if (Date.now() > room.expiresAt) {
      this.#expireRoom(roomId);
      this.#send(ws, { type: 'error', message: 'Room has expired' });
      return;
    }

    room.clients.set(clientId, { ws, metadata, joinedAt: Date.now() });

    ws._att = { ...attachment, roomId };

    this.#send(ws, {
      type: 'room_joined',
      roomId,
      room: {
        id: roomId,
        mode: room.mode,
        expiresAt: room.expiresAt,
        clientCount: room.clients.size,
        metadata: room.metadata,
      },
    });

    this.#broadcastToRoom(roomId, clientId, { type: 'user_joined', clientId, metadata });
  }

  #leaveRoom(ws, clientId, data = {}, attachment) {
    const roomId = data.roomId || attachment.roomId;
    if (!roomId) return;

    this.#broadcastToRoom(roomId, clientId, { type: 'user_left', clientId });

    const room = this.rooms.get(roomId);
    if (room) {
      room.clients.delete(clientId);
      if (room.clients.size === 0) this.#expireRoom(roomId);
    }

    ws._att = { ...attachment, roomId: null };
  }

  #expireRoom(roomId) {
    const room = this.rooms.get(roomId);
    if (!room) return;

    room.clients.forEach(({ ws }) => {
      try {
        ws.send(JSON.stringify({ type: 'room_expired', roomId }));
        ws.close(1000, 'Room expired');
      } catch { }
    });
    room.clients.clear();

    const count = this.ipCount.get(room.creatorIp) || 1;
    this.ipCount.set(room.creatorIp, Math.max(0, count - 1));

    this.rooms.delete(roomId);
  }

  async #cleanupExpiredRooms() {
    const now = Date.now();
    let cleaned = 0;
    for (const [roomId, room] of this.rooms) {
      if (now > room.expiresAt) {
        this.#expireRoom(roomId);
        cleaned++;
      }
    }
    return cleaned;
  }

  // ── Signaling ─────────────────────────────────────

  #forwardSignal(clientId, roomId, data = {}) {
    const { targetId, signalType, signalData } = data;
    const room = this.rooms.get(roomId);
    if (!room) return;

    const payload = { type: 'signal', fromId: clientId, signalType, signalData };

    if (targetId === '*') {
      room.clients.forEach(({ ws }, id) => {
        if (id !== clientId) this.#send(ws, payload);
      });
      return;
    }

    const target = room.clients.get(targetId);
    if (target) this.#send(target.ws, payload);
  }

  // ── Server-Side Relay ─────────────────────────────

  // set up relay when direct p2p connection fails
  #relayRequest(ws, clientId, roomId, data = {}) {
    const { targetId, metadata = {} } = data;
    const maxRelays = parseInt(this.env.MAX_CONCURRENT_RELAYS) || 3;

    const activeRelays = Array.from(this.relays.values()).filter(r => r.status === 'active');
    if (activeRelays.length >= maxRelays) {
      this.#send(ws, { type: 'error', message: 'Maximum concurrent relays reached' });
      return;
    }

    if (this.relays.has(clientId)) {
      this.#send(ws, { type: 'error', message: 'You already have an active relay session' });
      return;
    }

    const relay = {
      id: clientId,
      senderWs: ws,
      receiverWs: null,
      targetId,
      metadata,
      status: 'initiating',
      bytesTransferred: 0,
      startTime: Date.now(),
      buffer: [],
    };

    this.relays.set(clientId, relay);
    this.#send(ws, { type: 'relay_initiated', relayId: clientId });

    const room = roomId ? this.rooms.get(roomId) : null;
    const receiver = room?.clients.get(targetId);
    if (receiver) {
      this.#send(receiver.ws, {
        type: 'relay_offer', relayId: clientId, fromId: clientId, metadata,
      });
    }
  }

  #relayData(ws, clientId, data = {}) {
    const relay = this.relays.get(clientId);
    if (!relay) {
      this.#send(ws, { type: 'error', message: 'No relay session found' });
      return;
    }

    const maxRelayBytes = (parseInt(this.env.MAX_RELAY_SIZE_GB) || 10) * 1024 * 1024 * 1024;
    const chunkLen = data.chunk instanceof ArrayBuffer
      ? data.chunk.byteLength
      : (data.chunk?.length || 0);

    if (relay.bytesTransferred + chunkLen > maxRelayBytes) {
      this.#endRelay(clientId, 'size_limit_exceeded');
      return;
    }

    if (!relay.receiverWs) {
      relay.buffer.push(data.chunk);
      relay.bytesTransferred += chunkLen;
      return;
    }

    try {
      relay.receiverWs.send(data.chunk);
      relay.bytesTransferred += chunkLen;
    } catch {
      this.#endRelay(clientId, 'error');
    }
  }

  #relayConnect(ws, clientId, data = {}) {
    const { relayId } = data;
    const relay = this.relays.get(relayId);

    if (!relay) {
      this.#send(ws, { type: 'error', message: 'Relay session not found' });
      return;
    }

    relay.receiverWs = ws;
    relay.status = 'active';

    while (relay.buffer.length > 0) {
      const chunk = relay.buffer.shift();
      try { ws.send(chunk); } catch { break; }
    }

    this.#send(ws, { type: 'relay_connected', relayId });
    if (relay.senderWs) {
      this.#send(relay.senderWs, { type: 'relay_connected', relayId });
    }
  }

  #endRelay(clientId, reason = 'completed') {
    const relay = this.relays.get(clientId);
    if (!relay) return;

    const endMsg = JSON.stringify({
      type: 'relay_ended',
      reason,
      bytesTransferred: relay.bytesTransferred,
    });

    try { relay.senderWs?.send(endMsg); } catch { }
    try { relay.receiverWs?.send(endMsg); } catch { }

    this.relays.delete(clientId);
  }

  // ── Disconnection Cleanup ─────────────────────────

  // clean up when a peer disconnects
  #handleDisconnection(clientId, roomId) {
    this.#endRelay(clientId, 'disconnected');

    for (const [senderId, relay] of this.relays) {
      if (relay.targetId === clientId) this.#endRelay(senderId, 'peer_disconnected');
    }

    const effectiveRoomId = roomId || this.#findClientRoom(clientId);
    if (effectiveRoomId) {
      const room = this.rooms.get(effectiveRoomId);
      if (room) {
        this.#broadcastToRoom(effectiveRoomId, clientId, {
          type: 'user_disconnected', clientId,
        });
        room.clients.delete(clientId);
        if (room.clients.size === 0) this.#expireRoom(effectiveRoomId);
      }
    }
  }

  #findClientRoom(clientId) {
    for (const [roomId, room] of this.rooms) {
      if (room.clients.has(clientId)) return roomId;
    }
    return null;
  }

  // ── Stats ─────────────────────────────────────────

  #getRoomStats() {
    const now = Date.now();
    const active = Array.from(this.rooms.values()).filter(r => now <= r.expiresAt);
    return {
      totalRooms: this.rooms.size,
      activeRooms: active.length,
      expiredRooms: this.rooms.size - active.length,
      totalClients: active.reduce((s, r) => s + r.clients.size, 0),
      totalStorageUsed: Array.from(this.rooms.values()).reduce((s, r) => s + r.storageUsed, 0),
      activeRelays: Array.from(this.relays.values()).filter(r => r.status === 'active').length,
    };
  }

  // ── Utilities ─────────────────────────────────────

  #broadcastToRoom(roomId, excludeClientId, message) {
    const room = this.rooms.get(roomId);
    if (!room) return;
    room.clients.forEach(({ ws }, id) => {
      if (id !== excludeClientId) this.#send(ws, message);
    });
  }

  #send(ws, message) {
    try {
      ws.send(typeof message === 'string' ? message : JSON.stringify(message));
    } catch { }
  }
}