/** Proves real matrix-js-sdk and MatrixService behavior against the resettable Client-Server API simulator. */

import { afterEach, describe, expect, test } from "bun:test";
import type { IAgentRuntime, Memory, UUID } from "@elizaos/core";
import { MatrixEventTypes, MatrixService } from "@elizaos/plugin-matrix";
import {
  ClientEvent,
  createClient,
  Direction,
  EventType,
  type MatrixClient,
  Method,
  RoomEvent,
} from "matrix-js-sdk";
import { startMatrixClientServerMock } from "../src/matrix";

const USER_ID = "@bot:mock";
const ACCESS_TOKEN = "matrix-contract-token";
const ROOM_ID = "!general:mock";
const SECOND_ROOM_ID = "!second:mock";
const OCCUPIED_CREATED_ROOM_ID = "!created-1:mock";
const EQUIVALENT_ROOM_ID = "!equivalent:mock";

const seed = {
  userId: USER_ID,
  accessToken: ACCESS_TOKEN,
  deviceId: "SYNTHETIC",
  rooms: [
    {
      roomId: ROOM_ID,
      name: "Synthetic General",
      topic: "Protocol contract room",
      canonicalAlias: "#general:mock",
      members: [
        { userId: USER_ID, displayName: "Synthetic Bot" },
        { userId: "@alice:mock", displayName: "Alice" },
      ],
      timeline: [
        event("$generated-1:mock", "oldest", 1_700_000_000_001),
        event("$generated-2:mock", "middle", 1_700_000_000_002),
        event("$seed-3:mock", "newest", 1_700_000_000_003),
      ],
    },
    {
      roomId: SECOND_ROOM_ID,
      name: "Join Target",
      joined: false,
      members: [{ userId: "@alice:mock", displayName: "Alice" }],
      timeline: [],
    },
    ...[OCCUPIED_CREATED_ROOM_ID, EQUIVALENT_ROOM_ID].map((roomId) => ({
      roomId,
      name: "Equivalent State",
      topic: "State must survive global SDK deduplication",
      members: [
        { userId: USER_ID, displayName: "Synthetic Bot" },
        { userId: "@alice:mock", displayName: "Alice" },
      ],
      timeline: [],
    })),
  ],
};

const stops: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.all(stops.splice(0).map((stop) => stop()));
});

function event(eventId: string, body: string, originServerTs: number) {
  return {
    eventId,
    sender: "@alice:mock",
    content: { msgtype: "m.text", body },
    originServerTs,
  };
}

function client(url: string, accessToken = ACCESS_TOKEN): MatrixClient {
  return createClient({
    baseUrl: url,
    userId: USER_ID,
    accessToken,
    deviceId: "SYNTHETIC",
  });
}

async function startAndWaitPrepared(matrixClient: MatrixClient): Promise<void> {
  const prepared = new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error("Matrix PREPARED timeout")),
      2_000,
    );
    const listener = (state: string) => {
      if (state !== "PREPARED") return;
      clearTimeout(timeout);
      matrixClient.removeListener(ClientEvent.Sync, listener);
      resolve();
    };
    matrixClient.on(ClientEvent.Sync, listener);
  });
  await matrixClient.startClient({
    initialSyncLimit: 10,
    pollTimeout: 20,
    disablePresence: true,
  });
  await prepared;
}

async function waitFor(predicate: () => boolean, label: string): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (!predicate()) {
    if (Date.now() >= deadline)
      throw new Error(`Timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe("Matrix Client-Server production boundary", () => {
  test("allocates globally unique deterministic room, event, state, alias, and transaction identities", async () => {
    const mock = await startMatrixClientServerMock(seed);
    stops.push(mock.stop);
    const matrixClient = client(mock.url);
    stops.push(async () => matrixClient.stopClient());

    const initial = (await matrixClient.http.authedRequest(
      Method.Get,
      "/sync",
    )) as {
      next_batch: string;
      rooms: {
        join: Record<
          string,
          {
            state: { events: Array<{ event_id: string }> };
            timeline: { events: Array<{ event_id: string }> };
          }
        >;
      };
    };
    const initialEventIds = Object.values(initial.rooms.join).flatMap((room) =>
      [...room.state.events, ...room.timeline.events].map(
        (matrixEvent) => matrixEvent.event_id,
      ),
    );
    expect(new Set(initialEventIds).size).toBe(initialEventIds.length);
    expect(initialEventIds).toContain("$generated-1:mock");
    expect(initialEventIds).toContain("$generated-2:mock");

    mock.reset(seed);
    const replay = (await matrixClient.http.authedRequest(
      Method.Get,
      "/sync",
    )) as typeof initial;
    expect(JSON.stringify(replay.rooms)).toBe(JSON.stringify(initial.rooms));
    expect(replay.next_batch.replace(/^g\d+-/, "")).toBe(
      initial.next_batch.replace(/^g\d+-/, ""),
    );

    await startAndWaitPrepared(matrixClient);
    for (const roomId of [OCCUPIED_CREATED_ROOM_ID, EQUIVALENT_ROOM_ID]) {
      const room = matrixClient.getRoom(roomId);
      expect(room?.name).toBe("Equivalent State");
      expect(
        room?.currentState.getStateEvents(EventType.RoomTopic, "")?.getContent()
          .topic,
      ).toBe("State must survive global SDK deduplication");
      expect(room?.getMember(USER_ID)?.membership).toBe("join");
      expect(room?.getMember("@alice:mock")?.membership).toBe("join");
    }

    await expect(
      matrixClient.createRoom({ room_alias_name: "general" }),
    ).rejects.toMatchObject({ httpStatus: 409, errcode: "M_ROOM_IN_USE" });
    const created = await matrixClient.createRoom({
      name: "Collision-safe room",
      room_alias_name: "collision-safe",
    });
    expect(created.room_id).toBe("!created-2:mock");
    expect(mock.snapshot().rooms.map((room) => room.roomId)).toContain(
      OCCUPIED_CREATED_ROOM_ID,
    );

    const transactionId = "same-transaction-across-distinct-routes";
    const routeClient = client(mock.url);
    const first = await routeClient.sendEvent(
      ROOM_ID,
      EventType.RoomMessage,
      { msgtype: "m.text", body: "first route" },
      transactionId,
    );
    const replayed = await routeClient.sendEvent(
      ROOM_ID,
      EventType.RoomMessage,
      { msgtype: "m.text", body: "first route" },
      transactionId,
    );
    const otherRoom = await routeClient.sendEvent(
      OCCUPIED_CREATED_ROOM_ID,
      EventType.RoomMessage,
      { msgtype: "m.text", body: "other room" },
      transactionId,
    );
    const otherType = await routeClient.sendEvent(
      ROOM_ID,
      EventType.Reaction,
      {
        "m.relates_to": {
          event_id: first.event_id,
          key: "ok",
          rel_type: "m.annotation",
        },
      },
      transactionId,
    );
    expect(replayed.event_id).toBe(first.event_id);
    expect(
      new Set([first.event_id, otherRoom.event_id, otherType.event_id]).size,
    ).toBe(3);

    const completeReadback = (await matrixClient.http.authedRequest(
      Method.Get,
      "/sync",
    )) as typeof initial;
    const allEventIds = Object.values(completeReadback.rooms.join).flatMap(
      (room) =>
        [...room.state.events, ...room.timeline.events].map(
          (matrixEvent) => matrixEvent.event_id,
        ),
    );
    expect(new Set(allEventIds).size).toBe(allEventIds.length);
  });

  test("syncs, joins, creates, sends, paginates, orders, deduplicates, and resets", async () => {
    const mock = await startMatrixClientServerMock(seed);
    stops.push(mock.stop);
    const matrixClient = client(mock.url);
    stops.push(async () => matrixClient.stopClient());
    const timelineIds: string[] = [];
    matrixClient.on(RoomEvent.Timeline, (matrixEvent) => {
      const eventId = matrixEvent.getId();
      if (eventId) timelineIds.push(eventId);
    });

    await startAndWaitPrepared(matrixClient);
    expect(matrixClient.getRoom(ROOM_ID)?.getMyMembership()).toBe("join");
    expect(matrixClient.getRoom(ROOM_ID)?.name).toBe("Synthetic General");
    expect(timelineIds.slice(0, 3)).toEqual([
      "$generated-1:mock",
      "$generated-2:mock",
      "$seed-3:mock",
    ]);

    const joined = await matrixClient.joinRoom(SECOND_ROOM_ID);
    expect(joined.roomId).toBe(SECOND_ROOM_ID);
    await waitFor(
      () => matrixClient.getRoom(SECOND_ROOM_ID)?.getMyMembership() === "join",
      "joined room sync",
    );

    const created = await matrixClient.createRoom({
      name: "Created Through SDK",
    });
    expect(created.room_id).toMatch(/^!created-\d+:mock$/);
    await matrixClient.sendTextMessage(ROOM_ID, "outbound through real SDK");

    const firstPage = await matrixClient.createMessagesRequest(
      ROOM_ID,
      null,
      2,
      Direction.Backward,
    );
    expect(firstPage.chunk.map((item) => item.content.body)).toEqual([
      "outbound through real SDK",
      "newest",
    ]);
    const secondPage = await matrixClient.createMessagesRequest(
      ROOM_ID,
      firstPage.end ?? null,
      2,
      Direction.Backward,
    );
    expect(secondPage.chunk.map((item) => item.content.body)).toEqual([
      "middle",
      "oldest",
    ]);

    expect(
      mock.enqueueInbound(
        ROOM_ID,
        event("$live-1:mock", "live one", Date.now()),
      ),
    ).toBe(true);
    expect(
      mock.enqueueInbound(
        ROOM_ID,
        event("$live-2:mock", "live two", Date.now() + 1),
      ),
    ).toBe(true);
    expect(
      mock.enqueueInbound(
        ROOM_ID,
        event("$live-2:mock", "duplicate", Date.now() + 2),
      ),
    ).toBe(false);
    expect(
      mock.enqueueInbound(
        SECOND_ROOM_ID,
        event("$live-2:mock", "cross-room duplicate", Date.now() + 3),
      ),
    ).toBe(false);
    await waitFor(
      () => timelineIds.includes("$live-2:mock"),
      "ordered live sync",
    );
    expect(timelineIds.filter((id) => id === "$live-2:mock")).toHaveLength(1);
    expect(timelineIds.indexOf("$live-1:mock")).toBeLessThan(
      timelineIds.indexOf("$live-2:mock"),
    );

    const snapshot = mock.snapshot();
    const room = snapshot.rooms.find(
      (candidate) => candidate.roomId === ROOM_ID,
    );
    expect(room?.timeline.map((item) => item.content.body)).toEqual([
      "oldest",
      "middle",
      "newest",
      "outbound through real SDK",
      "live one",
      "live two",
    ]);
    expect(
      snapshot.requests.every(
        (request) =>
          request.authenticated || request.path === "/_matrix/client/versions",
      ),
    ).toBe(true);

    mock.reset();
    expect(mock.snapshot()).toEqual(
      expect.objectContaining({
        generation: 1,
        requests: [],
        nextBatch: "g1-s3",
      }),
    );
  });

  test("surfaces retry-after and exercises auth, malformed, timeout, and cancellation", async () => {
    const mock = await startMatrixClientServerMock(seed);
    stops.push(mock.stop);
    mock.enqueueFault("GET", "/_matrix/client/v3/account/whoami", {
      status: 429,
      retryAfterMs: 1,
      body: {
        errcode: "M_LIMIT_EXCEEDED",
        error: "slow down",
        retry_after_ms: 1,
      },
    });
    const rateLimitedClient = client(mock.url);
    await expect(rateLimitedClient.whoami()).rejects.toMatchObject({
      httpStatus: 429,
      data: { retry_after_ms: 1 },
    });
    expect(await rateLimitedClient.whoami()).toEqual({
      user_id: USER_ID,
      device_id: "SYNTHETIC",
    });

    const unauthorized = client(mock.url, "wrong-token");
    await expect(unauthorized.whoami()).rejects.toMatchObject({
      httpStatus: 401,
    });

    mock.enqueueFault("GET", "/_matrix/client/v3/account/whoami", {
      status: 200,
      rawBody: "not-json",
    });
    await expect(client(mock.url).whoami()).rejects.toThrow();

    mock.enqueueFault("GET", "/_matrix/client/v3/account/whoami", {
      status: 200,
      delayMs: 100,
      body: { user_id: USER_ID },
    });
    await expect(
      client(mock.url).http.authedRequest(
        Method.Get,
        "/account/whoami",
        {},
        undefined,
        {
          localTimeoutMs: 10,
        },
      ),
    ).rejects.toThrow();

    mock.enqueueFault("GET", "/_matrix/client/v3/account/whoami", {
      status: 200,
      delayMs: 100,
      body: { user_id: USER_ID },
    });
    const controller = new AbortController();
    const pending = client(mock.url).http.authedRequest(
      Method.Get,
      "/account/whoami",
      {},
      undefined,
      { abortSignal: controller.signal },
    );
    controller.abort(new Error("matrix contract cancellation"));
    await expect(pending).rejects.toThrow();
  });

  test("drives the plugin inbound event and persistence path from real sync", async () => {
    const mock = await startMatrixClientServerMock(seed);
    stops.push(mock.stop);
    const memories: Memory[] = [];
    const emitted: string[] = [];
    let connector: Record<string, unknown> | undefined;
    const runtime = {
      agentId: "00000000-0000-0000-0000-000000000093" as UUID,
      character: { settings: {} },
      getSetting(key: string) {
        const settings: Record<string, unknown> = {
          MATRIX_HOMESERVER: mock.url,
          MATRIX_USER_ID: USER_ID,
          MATRIX_ACCESS_TOKEN: ACCESS_TOKEN,
          MATRIX_DEVICE_ID: "SYNTHETIC",
          MATRIX_ENCRYPTION: false,
          MATRIX_AUTO_JOIN: false,
          MATRIX_REQUIRE_MENTION: false,
          MATRIX_AUTO_REPLY: false,
        };
        return settings[key];
      },
      registerMessageConnector(value: Record<string, unknown>) {
        connector = value;
      },
      emitEvent(type: string) {
        emitted.push(type);
      },
      ensureConnection: async () => undefined,
      createMemory: async (memory: Memory) => {
        memories.push(memory);
        return memory.id;
      },
      getService: () => null,
      logger: { debug() {}, info() {}, warn() {}, error() {} },
      reportError() {},
    } as unknown as IAgentRuntime;

    const service = await MatrixService.start(runtime);
    stops.push(() => service.stop());
    await waitFor(
      () => memories.some((memory) => memory.content.text === "newest"),
      "plugin inbound persistence",
    );

    expect(emitted).toContain(MatrixEventTypes.SYNC_COMPLETE);
    expect(emitted).toContain(MatrixEventTypes.MESSAGE_RECEIVED);
    expect(memories.map((memory) => memory.content.text)).toEqual([
      "oldest",
      "middle",
      "newest",
    ]);
    expect(connector).toEqual(
      expect.objectContaining({ source: "matrix", accountId: "default" }),
    );
  });

  test("invalidates an in-flight old-generation sync before exposing reseeded state", async () => {
    const mock = await startMatrixClientServerMock(seed);
    stops.push(mock.stop);
    const matrixClient = client(mock.url);
    const oldCursor = mock.snapshot().nextBatch;
    const oldGenerationSync = matrixClient.http.authedRequest(
      Method.Get,
      "/sync",
      { since: oldCursor, timeout: 200 },
    );
    await waitFor(
      () =>
        mock
          .snapshot()
          .requests.some(
            (request) =>
              request.path === "/_matrix/client/v3/sync" &&
              request.query.since === oldCursor,
          ),
      "old-generation sync admission",
    );

    const primaryRoom = seed.rooms.find((room) => room.roomId === ROOM_ID);
    if (!primaryRoom) throw new Error("primary Matrix room seed missing");
    const replacementSeed = {
      ...seed,
      rooms: [
        {
          ...primaryRoom,
          timeline: [
            event(
              "$replacement:mock",
              "replacement generation only",
              1_800_000_000_000,
            ),
          ],
        },
      ],
    };
    mock.reset(replacementSeed);
    await expect(oldGenerationSync).rejects.toMatchObject({
      httpStatus: 409,
      errcode: "M_UNKNOWN_POS",
    });
    await expect(
      matrixClient.http.authedRequest(Method.Get, "/sync", {
        since: oldCursor,
      }),
    ).rejects.toMatchObject({ httpStatus: 409, errcode: "M_UNKNOWN_POS" });

    const replacement = (await matrixClient.http.authedRequest(
      Method.Get,
      "/sync",
    )) as {
      rooms: {
        join: Record<
          string,
          { timeline: { events: Array<{ event_id: string }> } }
        >;
      };
    };
    expect(
      replacement.rooms.join[ROOM_ID]?.timeline.events.map(
        (matrixEvent) => matrixEvent.event_id,
      ),
    ).toEqual(["$replacement:mock"]);
  });

  test("replays the same effects to byte-equivalent provider state after reset", async () => {
    const mock = await startMatrixClientServerMock(seed);
    stops.push(mock.stop);
    const firstClient = client(mock.url);
    const outboundContent = {
      msgtype: "m.text" as const,
      body: "deterministic outbound",
    };
    const firstSend = await firstClient.sendEvent(
      ROOM_ID,
      EventType.RoomMessage,
      outboundContent,
      "stable-transaction",
    );
    const firstReplay = await firstClient.sendEvent(
      ROOM_ID,
      EventType.RoomMessage,
      outboundContent,
      "stable-transaction",
    );
    expect(firstReplay.event_id).toBe(firstSend.event_id);
    mock.enqueueInbound(
      ROOM_ID,
      event(
        "$deterministic-inbound:mock",
        "deterministic inbound",
        1_800_000_000_001,
      ),
    );
    const first = mock.snapshot();

    mock.reset(seed);
    const secondClient = client(mock.url);
    await secondClient.sendEvent(
      ROOM_ID,
      EventType.RoomMessage,
      outboundContent,
      "stable-transaction",
    );
    mock.enqueueInbound(
      ROOM_ID,
      event(
        "$deterministic-inbound:mock",
        "deterministic inbound",
        1_800_000_000_001,
      ),
    );
    const second = mock.snapshot();

    expect(second.nextBatch.replace(/^g\d+-/, "")).toBe(
      first.nextBatch.replace(/^g\d+-/, ""),
    );
    expect(JSON.stringify(second.rooms)).toBe(JSON.stringify(first.rooms));
  });
});
