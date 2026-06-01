import type { IAgentRuntime } from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";
import { MatrixService } from "../service.js";
import { MatrixEventTypes, MatrixNotConnectedError, type MatrixSettings } from "../types.js";

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

function createRuntime(): IAgentRuntime {
  return {
    emitEvent: vi.fn(),
    getSetting: vi.fn(),
    character: { settings: {} },
  } as unknown as IAgentRuntime;
}

function createService(stateOverrides: Partial<TestState> = {}) {
  const runtime = createRuntime();
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
    getSender: vi.fn(() => "@alice:example"),
    getRoomId: vi.fn(() => "!ops:example"),
    getId: vi.fn(() => "$event"),
    getTs: vi.fn(() => 123),
  };
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
});
