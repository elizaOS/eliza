/**
 * Hardening tests for `MatrixService`, focused on the passive-connector
 * auto-reply gate. Mocks `@elizaos/core` to supply
 * `lifeOpsPassiveConnectorsEnabled` (omitted by the vitest core shim) so the
 * gate is exercised deterministically — no live homeserver.
 */
import { type Content, EventType, type HandlerCallback, type IAgentRuntime } from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";

// The vitest @elizaos/core shim (packages/test/vitest/shims) is a curated subset
// and omits lifeOpsPassiveConnectorsEnabled, which service.ts imports. The real
// runtime export exists; mirror its semantics here (default ON; explicit-false
// disables via the ELIZA_LIFEOPS_PASSIVE_CONNECTORS / LIFEOPS_PASSIVE_CONNECTORS
// setting) so the auto-reply gate is exercised deterministically under test.
vi.mock("@elizaos/core", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const isExplicitFalse = (value: unknown): boolean => {
    if (value === false || value === 0) return true;
    if (typeof value !== "string") return false;
    const v = value.trim().toLowerCase();
    return v === "0" || v === "false" || v === "off" || v === "no" || v === "disabled";
  };
  return {
    ...actual,
    lifeOpsPassiveConnectorsEnabled: (runtime?: { getSetting?: (k: string) => unknown } | null) => {
      const value =
        runtime?.getSetting?.("ELIZA_LIFEOPS_PASSIVE_CONNECTORS") ??
        runtime?.getSetting?.("LIFEOPS_PASSIVE_CONNECTORS");
      return value === undefined || value === null ? true : !isExplicitFalse(value);
    },
  };
});

import { MatrixService } from "../service.js";
import {
  MatrixEventTypes,
  type MatrixMessage,
  MatrixNotConnectedError,
  type MatrixRoom,
  type MatrixSettings,
} from "../types.js";

type TestState = {
  accountId: string;
  settings: MatrixSettings;
  client: {
    sendMessage: ReturnType<typeof vi.fn>;
    sendEvent: ReturnType<typeof vi.fn>;
    joinRoom: ReturnType<typeof vi.fn>;
    leave: ReturnType<typeof vi.fn>;
    getAccountData: ReturnType<typeof vi.fn>;
  };
  connected: boolean;
  syncing: boolean;
};

function createRuntime(settings: Record<string, unknown> = {}): IAgentRuntime {
  return {
    agentId: "00000000-0000-0000-0000-000000000001",
    emitEvent: vi.fn(),
    // ELIZA_LIFEOPS_PASSIVE_CONNECTORS defaults to undefined (passive ON) unless overridden.
    getSetting: vi.fn((key: string) => settings[key]),
    ensureConnection: vi.fn().mockResolvedValue(undefined),
    createMemory: vi.fn().mockResolvedValue(undefined),
    messageService: { handleMessage: vi.fn() },
    character: { settings: {} },
  } as unknown as IAgentRuntime;
}

function createService(
  stateOverrides: Partial<TestState> = {},
  runtimeSettings: Record<string, unknown> = {}
) {
  const runtime = createRuntime(runtimeSettings);
  const settings: MatrixSettings = {
    accountId: "work",
    homeserver: "https://matrix.example",
    userId: "@bot.name:example",
    accessToken: "token",
    rooms: [],
    autoJoin: false,
    encryption: false,
    requireMention: false,
    enabled: true,
    ...stateOverrides.settings,
  };
  const state: TestState = {
    accountId: "work",
    settings,
    client: {
      sendMessage: vi.fn().mockResolvedValue({ event_id: "$sent" }),
      sendEvent: vi.fn().mockResolvedValue({ event_id: "$reaction" }),
      joinRoom: vi.fn().mockResolvedValue({ roomId: "!joined:example" }),
      leave: vi.fn().mockResolvedValue(undefined),
      getAccountData: vi.fn(() => undefined),
    },
    connected: true,
    syncing: true,
    ...stateOverrides,
  };
  const service = Object.create(MatrixService.prototype) as MatrixService;
  Object.assign(service as unknown as { runtime: IAgentRuntime; defaultAccountId: string }, {
    runtime,
    defaultAccountId: "work",
  });
  (service as unknown as { states: Map<string, TestState> }).states = new Map([["work", state]]);
  return { runtime, service, state };
}

function createRoom() {
  return {
    name: "Ops",
    getMember: vi.fn(() => ({
      name: "Alice",
      getMxcAvatarUrl: vi.fn(() => "mxc://avatar"),
    })),
    currentState: {
      getStateEvents: vi.fn(() => ({ getContent: () => ({ topic: "Alerts" }) })),
    },
    getCanonicalAlias: vi.fn(() => "#ops:example"),
    hasEncryptionStateEvent: vi.fn(() => false),
    getJoinedMemberCount: vi.fn(() => 3),
  };
}

function createEvent(content: Record<string, unknown>) {
  return {
    getContent: vi.fn(() => content),
    getType: vi.fn(() => "m.room.message"),
    isDecryptionFailure: vi.fn(() => false),
    getSender: vi.fn(() => "@alice:example"),
    getRoomId: vi.fn(() => "!ops:example"),
    getId: vi.fn(() => "$event"),
    getTs: vi.fn(() => 123),
  };
}

function createMatrixMessage(overrides: Partial<MatrixMessage> = {}): MatrixMessage {
  return {
    eventId: "$inbound",
    roomId: "!ops:example",
    sender: "@alice:example",
    senderInfo: { userId: "@alice:example", displayName: "Alice" },
    content: "hello bot",
    msgType: "m.text",
    timestamp: 123,
    ...overrides,
  };
}

function createMatrixRoom(overrides: Partial<MatrixRoom> = {}): MatrixRoom {
  return {
    roomId: "!ops:example",
    name: "Ops",
    isEncrypted: false,
    isDirect: false,
    memberCount: 3,
    ...overrides,
  };
}

function callDispatch(
  service: MatrixService,
  state: TestState,
  message: MatrixMessage,
  room: MatrixRoom
) {
  return (
    service as unknown as {
      dispatchToAgent: (s: TestState, m: MatrixMessage, r: MatrixRoom) => Promise<void>;
    }
  ).dispatchToAgent(state, message, room);
}

describe("Matrix service hardening", () => {
  it("ignores hostile text events with non-string bodies instead of throwing or emitting", () => {
    const { runtime, service, state } = createService();
    const event = createEvent({ msgtype: "m.text", body: { text: "not a string" } });

    expect(() =>
      (
        service as unknown as {
          handleRoomMessage: (state: TestState, event: unknown, room: unknown) => void;
        }
      ).handleRoomMessage(state, event, createRoom())
    ).not.toThrow();

    expect(runtime.emitEvent).not.toHaveBeenCalled();
  });

  it("escapes regex metacharacters in required mentions", () => {
    const { runtime, service, state } = createService({
      settings: {
        accountId: "work",
        homeserver: "https://matrix.example",
        userId: "@bot.name:example",
        accessToken: "token",
        rooms: [],
        autoJoin: false,
        encryption: false,
        requireMention: true,
        enabled: true,
      },
    });
    const handleRoomMessage = (
      service as unknown as {
        handleRoomMessage: (state: TestState, event: unknown, room: unknown) => void;
      }
    ).handleRoomMessage.bind(service);

    handleRoomMessage(
      state,
      createEvent({ msgtype: "m.text", body: "hello botXname" }),
      createRoom()
    );
    expect(runtime.emitEvent).not.toHaveBeenCalled();

    handleRoomMessage(
      state,
      createEvent({ msgtype: "m.text", body: "hello @bot.name" }),
      createRoom()
    );
    expect(runtime.emitEvent).toHaveBeenCalledWith(
      MatrixEventTypes.MESSAGE_RECEIVED,
      expect.objectContaining({
        accountId: "work",
        message: expect.objectContaining({ content: "hello @bot.name" }),
      })
    );
  });

  it("trims room aliases before resolving and sending messages", async () => {
    const { runtime, service, state } = createService();
    const getRoomIdForAlias = vi.fn().mockResolvedValue({ room_id: "!resolved:example" });
    (state.client as unknown as { getRoomIdForAlias: typeof getRoomIdForAlias }).getRoomIdForAlias =
      getRoomIdForAlias;

    await expect(
      service.sendMessage("hello", { accountId: "work", roomId: " #ops:example " })
    ).resolves.toEqual({ success: true, eventId: "$sent", roomId: "!resolved:example" });

    expect(getRoomIdForAlias).toHaveBeenCalledWith("#ops:example");
    expect(state.client.sendMessage).toHaveBeenCalledWith(
      "!resolved:example",
      expect.objectContaining({ body: "hello" })
    );
    expect(runtime.emitEvent).toHaveBeenCalledWith(
      MatrixEventTypes.MESSAGE_SENT,
      expect.objectContaining({ roomId: "!resolved:example", accountId: "work" })
    );
  });

  it("rejects blank room IDs before sending reactions, joins, or leaves", async () => {
    const { service, state } = createService();

    await expect(service.sendReaction(" ", "$event", "+1", "work")).resolves.toEqual({
      success: false,
      error: "Room ID, event ID, and emoji are required",
    });
    await expect(service.sendReaction("!room:example", " ", "+1", "work")).resolves.toEqual({
      success: false,
      error: "Room ID, event ID, and emoji are required",
    });
    await expect(service.joinRoom(" ", "work")).rejects.toThrow(
      "Matrix room ID or alias is required"
    );
    await expect(service.leaveRoom(" ", "work")).rejects.toThrow("Matrix room ID is required");

    expect(state.client.sendEvent).not.toHaveBeenCalled();
    expect(state.client.joinRoom).not.toHaveBeenCalled();
    expect(state.client.leave).not.toHaveBeenCalled();
  });

  it("surfaces auth/session failures without calling Matrix mutation APIs", async () => {
    const { service, state } = createService({ connected: false });

    await expect(
      service.sendMessage("hello", { accountId: "work", roomId: "!room:example" })
    ).rejects.toBeInstanceOf(MatrixNotConnectedError);
    await expect(
      service.sendReaction("!room:example", "$event", "+1", "work")
    ).rejects.toBeInstanceOf(MatrixNotConnectedError);
    await expect(service.joinRoom("#ops:example", "work")).rejects.toBeInstanceOf(
      MatrixNotConnectedError
    );

    expect(state.client.sendMessage).not.toHaveBeenCalled();
    expect(state.client.sendEvent).not.toHaveBeenCalled();
    expect(state.client.joinRoom).not.toHaveBeenCalled();
  });

  it("persists the inbound message but does not run the agent when auto-reply is off", async () => {
    // MATRIX_AUTO_REPLY unset -> gate off; passive mode is irrelevant here.
    const { runtime, service, state } = createService();

    await callDispatch(service, state, createMatrixMessage(), createMatrixRoom());

    expect(runtime.ensureConnection).toHaveBeenCalledTimes(1);
    expect(runtime.createMemory).toHaveBeenCalledTimes(1);
    expect(runtime.createMemory).toHaveBeenCalledWith(
      expect.objectContaining({ content: expect.objectContaining({ text: "hello bot" }) }),
      "messages"
    );
    expect(runtime.messageService.handleMessage).not.toHaveBeenCalled();
    expect(state.client.sendMessage).not.toHaveBeenCalled();
    expect(runtime.emitEvent).toHaveBeenCalledWith(
      EventType.MESSAGE_RECEIVED,
      expect.objectContaining({
        source: "matrix",
        message: expect.objectContaining({
          content: expect.objectContaining({ text: "hello bot", source: "matrix" }),
        }),
      })
    );
  });

  it("runs the agent and round-trips the reply when auto-reply is on and passive mode is off", async () => {
    // Auto-reply ON requires BOTH the gate set true AND passive connectors explicitly disabled.
    const { runtime, service, state } = createService(
      {},
      { MATRIX_AUTO_REPLY: "true", ELIZA_LIFEOPS_PASSIVE_CONNECTORS: "false" }
    );

    await callDispatch(service, state, createMatrixMessage(), createMatrixRoom());

    expect(runtime.messageService.handleMessage).toHaveBeenCalledTimes(1);
    // Inbound is not separately persisted in the auto-reply path; only the agent's outbound is.
    expect(runtime.createMemory).not.toHaveBeenCalled();

    // Invoke the callback the service handed to messageService, simulating the agent's reply.
    const callback = runtime.messageService.handleMessage.mock.calls[0][2] as HandlerCallback;
    const result = await callback({ text: "  hi back  " } as Content);

    expect(state.client.sendMessage).toHaveBeenCalledWith(
      "!ops:example",
      expect.objectContaining({ body: "hi back" })
    );
    expect(runtime.createMemory).toHaveBeenCalledTimes(1);
    expect(runtime.createMemory).toHaveBeenCalledWith(
      expect.objectContaining({ content: expect.objectContaining({ text: "hi back" }) }),
      "messages"
    );
    expect(result).toHaveLength(1);
  });

  it("still suppresses auto-reply when passive mode is on even if the gate is true", async () => {
    // Gate true but passive connectors left at default (on) -> no agent run.
    const { runtime, service, state } = createService({}, { MATRIX_AUTO_REPLY: "true" });

    await callDispatch(service, state, createMatrixMessage(), createMatrixRoom());

    expect(runtime.messageService.handleMessage).not.toHaveBeenCalled();
    expect(runtime.createMemory).toHaveBeenCalledTimes(1);
  });

  it("bypasses the mention gate in 1:1 DMs but honors it in group rooms", () => {
    const settings: MatrixSettings = {
      accountId: "work",
      homeserver: "https://matrix.example",
      userId: "@bot.name:example",
      accessToken: "token",
      rooms: [],
      autoJoin: false,
      encryption: false,
      requireMention: true,
      enabled: true,
    };

    // DM: 2 members, body lacks the mention -> still dispatched (mention gate bypassed).
    const dm = createService({ settings });
    const dmRoom = createRoom();
    dmRoom.getJoinedMemberCount = vi.fn(() => 2);
    (
      dm.service as unknown as {
        handleRoomMessage: (s: TestState, e: unknown, r: unknown) => void;
      }
    ).handleRoomMessage(
      dm.state,
      createEvent({ msgtype: "m.text", body: "no mention here" }),
      dmRoom
    );
    expect(dm.runtime.emitEvent).toHaveBeenCalledWith(
      MatrixEventTypes.MESSAGE_RECEIVED,
      expect.anything()
    );

    // Group: 3 members, same body without the mention -> gate honored, not dispatched.
    const group = createService({ settings });
    const groupRoom = createRoom();
    groupRoom.getJoinedMemberCount = vi.fn(() => 3);
    (
      group.service as unknown as {
        handleRoomMessage: (s: TestState, e: unknown, r: unknown) => void;
      }
    ).handleRoomMessage(
      group.state,
      createEvent({ msgtype: "m.text", body: "no mention here" }),
      groupRoom
    );
    expect(group.runtime.emitEvent).not.toHaveBeenCalled();
  });

  it("reads live timeline messages newest-first, attaches the name, and skips non-text events", async () => {
    const { runtime, service, state } = createService();

    const makeEvent = (over: {
      body?: unknown;
      msgtype?: string;
      sender?: string;
      id?: string;
      ts?: number;
    }) => ({
      getContent: vi.fn(() => ({ msgtype: over.msgtype ?? "m.text", body: over.body })),
      getType: vi.fn(() => "m.room.message"),
      isDecryptionFailure: vi.fn(() => false),
      getSender: vi.fn(() => over.sender ?? "@alice:example"),
      getRoomId: vi.fn(() => "!ops:example"),
      getId: vi.fn(() => over.id ?? "$e"),
      getTs: vi.fn(() => over.ts ?? 0),
    });

    // Timeline order is oldest -> newest; an image event sits between the two text ones.
    const events = [
      makeEvent({ body: "older", sender: "@alice:example", id: "$1", ts: 100 }),
      makeEvent({ body: "ignored", msgtype: "m.image", id: "$img", ts: 150 }),
      makeEvent({ body: "newer", sender: "@bob:example", id: "$2", ts: 200 }),
    ];

    const room = {
      getJoinedMemberCount: vi.fn(() => 3),
      getMember: vi.fn((userId: string) => ({
        name: userId === "@bob:example" ? "Bob" : "Alice",
        getMxcAvatarUrl: vi.fn(() => undefined),
      })),
      getLiveTimeline: vi.fn(() => ({ getEvents: vi.fn(() => events) })),
    };
    (state.client as unknown as { getRoom: ReturnType<typeof vi.fn> }).getRoom = vi.fn(
      (id: string) => (id === "!ops:example" ? room : null)
    );

    const result = await service.getRoomMessages("!ops:example", 50, "work");

    // Two text events only (image skipped), newest-first.
    expect(result).toHaveLength(2);
    expect(result[0].content.text).toBe("newer");
    expect(result[0].content.name).toBe("Bob");
    expect(result[1].content.text).toBe("older");
    expect(result[1].content.name).toBe("Alice");
    expect(result[0].content.source).toBe("matrix");

    // Unknown room id -> empty.
    expect(await service.getRoomMessages("!missing:example", 50, "work")).toEqual([]);

    expect(runtime.emitEvent).not.toHaveBeenCalled();
  });

  it("respects the limit when reading the live timeline, keeping the newest", async () => {
    const { service, state } = createService();
    const makeEvent = (id: string, body: string, ts: number) => ({
      getContent: vi.fn(() => ({ msgtype: "m.text", body })),
      getType: vi.fn(() => "m.room.message"),
      isDecryptionFailure: vi.fn(() => false),
      getSender: vi.fn(() => "@alice:example"),
      getRoomId: vi.fn(() => "!ops:example"),
      getId: vi.fn(() => id),
      getTs: vi.fn(() => ts),
    });
    const events = [
      makeEvent("$1", "first", 100),
      makeEvent("$2", "second", 200),
      makeEvent("$3", "third", 300),
    ];
    const room = {
      getJoinedMemberCount: vi.fn(() => 2),
      getMember: vi.fn(() => ({ name: "Alice", getMxcAvatarUrl: vi.fn(() => undefined) })),
      getLiveTimeline: vi.fn(() => ({ getEvents: vi.fn(() => events) })),
    };
    (state.client as unknown as { getRoom: ReturnType<typeof vi.fn> }).getRoom = vi.fn(() => room);

    const result = await service.getRoomMessages("!ops:example", 2, "work");
    expect(result.map((m) => m.content.text)).toEqual(["third", "second"]);
  });

  it("skips crypto init when encryption is off and warns when initRustCrypto is unavailable", async () => {
    const { service } = createService();
    const initCrypto = (
      service as unknown as {
        initCrypto: (state: { settings: MatrixSettings; client: unknown }) => Promise<void>;
      }
    ).initCrypto.bind(service);

    // Encryption off -> no-op, never touches the client.
    const initRustCrypto = vi.fn().mockResolvedValue(undefined);
    await initCrypto({
      settings: { encryption: false } as MatrixSettings,
      client: { initRustCrypto },
    });
    expect(initRustCrypto).not.toHaveBeenCalled();

    // Encryption on but client lacks initRustCrypto -> warns, does not throw.
    const { logger } = await import("@elizaos/core");
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});
    await expect(
      initCrypto({
        settings: { encryption: true, userId: "@bot:example" } as MatrixSettings,
        client: {},
      })
    ).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("initRustCrypto is unavailable"));
    warn.mockRestore();
  });

  it("degrades and continues when initRustCrypto rejects instead of crashing the connection", async () => {
    const { service } = createService();
    const initCrypto = (
      service as unknown as {
        initCrypto: (state: { settings: MatrixSettings; client: unknown }) => Promise<void>;
      }
    ).initCrypto.bind(service);

    const { logger } = await import("@elizaos/core");
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});
    const initRustCrypto = vi.fn().mockRejectedValue(new Error("wasm init failed"));

    // A rejecting rust-crypto init must NOT throw out of initialize()/start();
    // it should warn and let the Matrix connection continue.
    await expect(
      initCrypto({
        settings: { encryption: true, userId: "@bot:example" } as MatrixSettings,
        client: { initRustCrypto },
      })
    ).resolves.toBeUndefined();

    // First the persistent (IndexedDB) path is attempted; when it rejects the
    // in-memory path is attempted as a fallback. Both reject here.
    expect(initRustCrypto).toHaveBeenCalledTimes(2);
    expect(initRustCrypto).toHaveBeenNthCalledWith(1, {
      useIndexedDB: true,
      cryptoDatabasePrefix: "matrix-js-sdk",
    });
    expect(initRustCrypto).toHaveBeenNthCalledWith(2, { useIndexedDB: false });
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("Matrix encryption failed to initialize")
    );
    warn.mockRestore();
  });

  it("falls back to the in-memory store when only the persistent (IndexedDB) init fails", async () => {
    const { service } = createService();
    const initCrypto = (
      service as unknown as {
        initCrypto: (state: { settings: MatrixSettings; client: unknown }) => Promise<void>;
      }
    ).initCrypto.bind(service);

    const { logger } = await import("@elizaos/core");
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});
    const info = vi.spyOn(logger, "info").mockImplementation(() => {});
    // Reject the persistent attempt, accept the in-memory fallback.
    const initRustCrypto = vi
      .fn()
      .mockImplementation((opts: { useIndexedDB: boolean }) =>
        opts.useIndexedDB ? Promise.reject(new Error("idb blocked")) : Promise.resolve(undefined)
      );

    await expect(
      initCrypto({
        settings: { encryption: true, userId: "@bot:example" } as MatrixSettings,
        client: { initRustCrypto },
      })
    ).resolves.toBeUndefined();

    expect(initRustCrypto).toHaveBeenNthCalledWith(1, {
      useIndexedDB: true,
      cryptoDatabasePrefix: "matrix-js-sdk",
    });
    expect(initRustCrypto).toHaveBeenNthCalledWith(2, { useIndexedDB: false });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("falling back to in-memory crypto"));
    expect(info).toHaveBeenCalledWith(expect.stringContaining("in-memory rust-crypto"));
    warn.mockRestore();
    info.mockRestore();
  });
});
