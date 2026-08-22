/** Hosts a resettable Matrix Client-Server API subset that real matrix-js-sdk clients reach over loopback HTTP. */

import { startFetchServer } from "../fetch-server.js";
import type {
  MatrixClientServerSeed,
  MatrixMockEventSeed,
  MatrixMockFault,
  MatrixMockRoomSeed,
  MatrixMockSnapshot,
  MatrixRequestObservation,
} from "./types.js";

interface StoredEvent extends MatrixMockEventSeed {
  sequence: number;
  transactionId?: string;
}

interface RoomState extends Omit<MatrixMockRoomSeed, "timeline"> {
  joined: boolean;
  joinedAt: number;
  timeline: StoredEvent[];
}

export interface RunningMatrixClientServerMock {
  url: string;
  port: number;
  enqueueFault(method: string, path: string, fault: MatrixMockFault): void;
  enqueueInbound(roomId: string, event: MatrixMockEventSeed): boolean;
  reset(seed?: MatrixClientServerSeed): void;
  snapshot(): MatrixMockSnapshot;
  stop(): Promise<void>;
}

export async function startMatrixClientServerMock(
  initialSeed: MatrixClientServerSeed,
): Promise<RunningMatrixClientServerMock> {
  let currentSeed = cloneSeed(initialSeed);
  let generation = 0;
  let eventSequence = 0;
  let requestSequence = 0;
  let roomSequence = 0;
  let eventIdSequence = 0;
  let rooms = buildRooms(currentSeed, () => ++eventSequence);
  let requests: MatrixRequestObservation[] = [];
  const faults = new Map<string, MatrixMockFault[]>();
  const activeRequests = new Set<AbortController>();

  const server = await startFetchServer(async (request) => {
    const url = new URL(request.url);
    const body = await readJsonBody(request);
    const authenticated =
      request.headers.get("authorization") ===
      `Bearer ${currentSeed.accessToken}`;
    requests.push({
      sequence: ++requestSequence,
      method: request.method,
      path: url.pathname,
      query: Object.fromEntries(url.searchParams),
      authenticated,
      body,
    });

    if (
      url.pathname === "/_matrix/client/versions" &&
      request.method === "GET"
    ) {
      return json({ versions: ["v1.1", "v1.11"], unstable_features: {} });
    }
    if (!url.pathname.startsWith("/_matrix/client/v3/") || !authenticated) {
      return matrixError(401, "M_UNKNOWN_TOKEN", "invalid access token");
    }

    const faultKey = `${request.method} ${url.pathname}`;
    const fault = faults.get(faultKey)?.shift();
    if (fault) {
      if (
        fault.delayMs &&
        !(await waitWithinGeneration(
          fault.delayMs,
          request.signal,
          generation,
          () => generation,
          activeRequests,
        ))
      ) {
        return matrixError(
          409,
          "M_UNKNOWN_POS",
          "synthetic Matrix generation changed",
        );
      }
      const headers = new Headers({ "content-type": "application/json" });
      if (fault.retryAfterMs !== undefined) {
        headers.set("retry-after", String(fault.retryAfterMs / 1000));
      }
      return new Response(
        fault.rawBody ??
          JSON.stringify(
            fault.body ?? {
              errcode: "M_UNKNOWN",
              error: "seeded Matrix fault",
              retry_after_ms: fault.retryAfterMs,
            },
          ),
        { status: fault.status ?? 500, headers },
      );
    }

    const path = url.pathname.slice("/_matrix/client/v3".length);
    if (request.method === "GET" && path === "/pushrules/") {
      return json({ global: {} });
    }
    if (request.method === "POST" && /^\/user\/[^/]+\/filter$/.test(path)) {
      return json({ filter_id: "filter-synthetic" });
    }
    if (request.method === "GET" && path === "/account/whoami") {
      return json({
        user_id: currentSeed.userId,
        device_id: currentSeed.deviceId ?? "DEVICE",
      });
    }
    if (request.method === "GET" && path === "/capabilities") {
      return json({
        capabilities: {
          "m.room_versions": { default: "10", available: { "10": "stable" } },
        },
      });
    }
    if (request.method === "GET" && path === "/sync") {
      const rawSince = url.searchParams.get("since");
      const parsedSince = parseSyncToken(rawSince);
      if (
        rawSince !== null &&
        (!parsedSince || parsedSince.generation !== generation)
      ) {
        return matrixError(
          409,
          "M_UNKNOWN_POS",
          "synthetic Matrix sync cursor belongs to another generation",
        );
      }
      const since = parsedSince?.sequence ?? null;
      if (
        since !== null &&
        !(await waitWithinGeneration(
          Math.min(readPositiveInt(url.searchParams.get("timeout"), 250), 250),
          request.signal,
          generation,
          () => generation,
          activeRequests,
        ))
      ) {
        return matrixError(
          409,
          "M_UNKNOWN_POS",
          "synthetic Matrix generation changed",
        );
      }
      return json(
        buildSync(currentSeed, rooms, since, generation, eventSequence),
      );
    }
    if (request.method === "POST" && path === "/createRoom") {
      const roomId = `!created-${++roomSequence}:mock`;
      const name = readString(body, "name");
      rooms.set(roomId, {
        roomId,
        name: name ?? undefined,
        joined: true,
        joinedAt: ++eventSequence,
        members: [{ userId: currentSeed.userId, displayName: "Synthetic Bot" }],
        timeline: [],
      });
      return json({ room_id: roomId });
    }

    const joinMatch = /^\/join\/(.+)$/.exec(path);
    if (request.method === "POST" && joinMatch) {
      const requested = decodeURIComponent(joinMatch[1] ?? "");
      const room = resolveRoom(rooms, requested);
      if (!room) return matrixError(404, "M_NOT_FOUND", "unknown room");
      room.joined = true;
      room.joinedAt = ++eventSequence;
      const ownMember = room.members.find(
        (member) => member.userId === currentSeed.userId,
      );
      if (ownMember) ownMember.membership = "join";
      else
        room.members.push({ userId: currentSeed.userId, membership: "join" });
      return json({ room_id: room.roomId });
    }

    const sendMatch = /^\/rooms\/([^/]+)\/send\/([^/]+)\/([^/]+)$/.exec(path);
    if (request.method === "PUT" && sendMatch) {
      const roomId = decodeURIComponent(sendMatch[1] ?? "");
      const eventType = decodeURIComponent(sendMatch[2] ?? "");
      const transactionId = decodeURIComponent(sendMatch[3] ?? "");
      const room = rooms.get(roomId);
      if (!room?.joined) return matrixError(403, "M_FORBIDDEN", "not joined");
      const existing = room.timeline.find(
        (event) => event.transactionId === transactionId,
      );
      if (existing) return json({ event_id: existing.eventId });
      const eventId = `$sent-${++eventIdSequence}:mock`;
      const sequence = ++eventSequence;
      room.timeline.push({
        eventId,
        sender: currentSeed.userId,
        type: eventType,
        content: requireRecord(body),
        originServerTs: 1_700_000_100_000 + sequence,
        sequence,
        transactionId,
      });
      return json({ event_id: eventId });
    }

    const messagesMatch = /^\/rooms\/([^/]+)\/messages$/.exec(path);
    if (request.method === "GET" && messagesMatch) {
      const roomId = decodeURIComponent(messagesMatch[1] ?? "");
      const room = rooms.get(roomId);
      if (!room?.joined) return matrixError(403, "M_FORBIDDEN", "not joined");
      const direction = url.searchParams.get("dir") ?? "b";
      const limit = Math.min(
        readPositiveInt(url.searchParams.get("limit"), 10),
        100,
      );
      if (direction !== "b")
        return matrixError(
          400,
          "M_INVALID_PARAM",
          "only backward pagination is seeded",
        );
      const endIndex = parsePaginationToken(
        url.searchParams.get("from"),
        room.timeline.length,
      );
      const startIndex = Math.max(0, endIndex - limit);
      const chunk = room.timeline
        .slice(startIndex, endIndex)
        .reverse()
        .map(wireEvent);
      return json({
        start: `p${endIndex}`,
        end: `p${startIndex}`,
        chunk,
        state: [],
      });
    }

    return matrixError(
      404,
      "M_UNRECOGNIZED",
      `unsupported Matrix path ${path}`,
    );
  });

  return {
    url: `http://${server.hostname}:${server.port}`,
    port: server.port,
    enqueueFault(method, path, fault) {
      const key = `${method.toUpperCase()} ${path}`;
      const queue = faults.get(key) ?? [];
      queue.push(structuredClone(fault));
      faults.set(key, queue);
    },
    enqueueInbound(roomId, event) {
      const room = rooms.get(roomId);
      if (!room) throw new Error(`unknown Matrix room '${roomId}'`);
      if (
        room.timeline.some((candidate) => candidate.eventId === event.eventId)
      )
        return false;
      room.timeline.push({
        ...structuredClone(event),
        sequence: ++eventSequence,
      });
      return true;
    },
    reset(nextSeed = currentSeed) {
      generation += 1;
      for (const controller of activeRequests) controller.abort();
      currentSeed = cloneSeed(nextSeed);
      eventSequence = 0;
      requestSequence = 0;
      roomSequence = 0;
      eventIdSequence = 0;
      rooms = buildRooms(currentSeed, () => ++eventSequence);
      requests = [];
      faults.clear();
    },
    snapshot() {
      return snapshot(generation, eventSequence, requests, rooms);
    },
    stop: server.stop,
  };
}

function buildRooms(
  seed: MatrixClientServerSeed,
  nextSequence: () => number,
): Map<string, RoomState> {
  if (!seed.userId.startsWith("@") || !seed.accessToken)
    throw new Error("invalid Matrix account seed");
  const rooms = new Map<string, RoomState>();
  for (const room of seed.rooms) {
    if (!room.roomId.startsWith("!") || rooms.has(room.roomId))
      throw new Error("invalid or duplicate Matrix room seed");
    const eventIds = new Set<string>();
    const timeline = (room.timeline ?? []).map((event) => {
      if (!event.eventId || eventIds.has(event.eventId))
        throw new Error("duplicate Matrix event seed");
      eventIds.add(event.eventId);
      return { ...structuredClone(event), sequence: nextSequence() };
    });
    rooms.set(room.roomId, {
      ...structuredClone(room),
      joined: room.joined ?? true,
      joinedAt: room.joined === false ? Number.MAX_SAFE_INTEGER : 0,
      timeline,
    });
  }
  return rooms;
}

function buildSync(
  seed: MatrixClientServerSeed,
  rooms: Map<string, RoomState>,
  since: number | null,
  generation: number,
  nextSequence: number,
) {
  const join = Object.fromEntries(
    [...rooms.values()]
      .filter((room) => room.joined)
      .map((room) => {
        const newlyJoined = since !== null && room.joinedAt > since;
        const timeline = room.timeline.filter(
          (event) => since === null || newlyJoined || event.sequence > since,
        );
        return [
          room.roomId,
          {
            summary: {
              "m.joined_member_count": room.members.filter(
                (member) => (member.membership ?? "join") === "join",
              ).length,
              "m.invited_member_count": room.members.filter(
                (member) => member.membership === "invite",
              ).length,
            },
            state: {
              events:
                since === null || newlyJoined
                  ? roomStateEvents(seed, room)
                  : [],
            },
            timeline: {
              events: timeline.map(wireEvent),
              limited: false,
              prev_batch: "p0",
            },
            ephemeral: { events: [] },
            account_data: { events: [] },
            unread_notifications: { highlight_count: 0, notification_count: 0 },
          },
        ];
      }),
  );
  return {
    next_batch: syncToken(generation, nextSequence),
    rooms: { join, invite: {}, leave: {} },
    presence: { events: [] },
    account_data: { events: [] },
    to_device: { events: [] },
    device_lists: { changed: [], left: [] },
    device_one_time_keys_count: {},
  };
}

function roomStateEvents(seed: MatrixClientServerSeed, room: RoomState) {
  const events: Array<Record<string, unknown>> = [
    stateEvent(room.roomId, "$create:mock", "m.room.create", "", seed.userId, {
      creator: seed.userId,
      room_version: "10",
    }),
  ];
  if (room.name)
    events.push(
      stateEvent(room.roomId, "$name:mock", "m.room.name", "", seed.userId, {
        name: room.name,
      }),
    );
  if (room.topic)
    events.push(
      stateEvent(room.roomId, "$topic:mock", "m.room.topic", "", seed.userId, {
        topic: room.topic,
      }),
    );
  if (room.canonicalAlias)
    events.push(
      stateEvent(
        room.roomId,
        "$alias:mock",
        "m.room.canonical_alias",
        "",
        seed.userId,
        { alias: room.canonicalAlias },
      ),
    );
  for (const member of room.members) {
    events.push(
      stateEvent(
        room.roomId,
        `$member-${encodeURIComponent(member.userId)}:mock`,
        "m.room.member",
        member.userId,
        member.userId,
        {
          membership: member.membership ?? "join",
          displayname: member.displayName,
        },
      ),
    );
  }
  return events;
}

function stateEvent(
  roomId: string,
  eventId: string,
  type: string,
  stateKey: string,
  sender: string,
  content: Record<string, unknown>,
) {
  return {
    event_id: eventId,
    room_id: roomId,
    sender,
    type,
    state_key: stateKey,
    origin_server_ts: 1_700_000_000_000,
    content,
  };
}

function wireEvent(event: MatrixMockEventSeed) {
  return {
    event_id: event.eventId,
    sender: event.sender,
    type: event.type ?? "m.room.message",
    origin_server_ts: event.originServerTs,
    content: event.content,
  };
}

function snapshot(
  generation: number,
  eventSequence: number,
  requests: MatrixRequestObservation[],
  rooms: Map<string, RoomState>,
): MatrixMockSnapshot {
  return {
    generation,
    nextBatch: syncToken(generation, eventSequence),
    requests: structuredClone(requests),
    rooms: [...rooms.values()].map((room) => ({
      roomId: room.roomId,
      joined: room.joined,
      timeline: room.timeline.map(
        ({ sequence: _sequence, transactionId: _transactionId, ...event }) =>
          structuredClone(event),
      ),
    })),
  };
}

function resolveRoom(
  rooms: Map<string, RoomState>,
  idOrAlias: string,
): RoomState | undefined {
  return (
    rooms.get(idOrAlias) ??
    [...rooms.values()].find((room) => room.canonicalAlias === idOrAlias)
  );
}

function parseSyncToken(
  value: string | null,
): { generation: number; sequence: number } | null {
  if (value === null) return null;
  const match = /^g(\d+)-s(\d+)$/.exec(value);
  return match
    ? { generation: Number(match[1]), sequence: Number(match[2]) }
    : null;
}

function syncToken(generation: number, sequence: number): string {
  return `g${generation}-s${sequence}`;
}

function parsePaginationToken(value: string | null, fallback: number): number {
  if (value === null) return fallback;
  const match = /^p(\d+)$/.exec(value);
  return match ? Math.min(Number(match[1]), fallback) : fallback;
}

function readPositiveInt(value: string | null, fallback: number): number {
  const parsed = value === null ? Number.NaN : Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : fallback;
}

async function readJsonBody(request: Request): Promise<unknown> {
  if (request.method === "GET" || request.method === "HEAD") return undefined;
  const text = await request.text();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function readString(value: unknown, key: string): string | null {
  const record = requireRecord(value);
  const candidate = record[key];
  return typeof candidate === "string" && candidate.trim() ? candidate : null;
}

function requireRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function cloneSeed(seed: MatrixClientServerSeed): MatrixClientServerSeed {
  return structuredClone(seed);
}

function json(value: unknown, status = 200): Response {
  return Response.json(value, { status });
}

function matrixError(status: number, errcode: string, error: string): Response {
  return json({ errcode, error }, status);
}

async function waitWithinGeneration(
  ms: number,
  requestSignal: AbortSignal,
  admittedGeneration: number,
  readGeneration: () => number,
  activeRequests: Set<AbortController>,
): Promise<boolean> {
  const resetController = new AbortController();
  activeRequests.add(resetController);
  try {
    await delay(ms, AbortSignal.any([requestSignal, resetController.signal]));
    return readGeneration() === admittedGeneration;
  } catch {
    // The caller translates cancellation/reset into an explicit stale cursor;
    // no pre-reset request may resume against the replacement generation.
    return false;
  } finally {
    activeRequests.delete(resetController);
  }
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(signal.reason);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason);
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
