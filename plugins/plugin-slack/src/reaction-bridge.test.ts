/**
 * Production-path proof for the Slack reaction bridge.
 *
 * These tests drive the REAL handlers that `registerEventHandlers` binds to
 * the bolt app (`app.event("reaction_added" | "reaction_removed")`), not a
 * helper, so they cannot drift onto dead code.
 *
 * The central assertion is bidirectional: a Slack reaction must reach the core
 * event bus as `EventType.REACTION_RECEIVED`. On unfixed develop the handler
 * takes `_event`, throws the reaction data away, and emits only the
 * plugin-local `SLACK_REACTION_ADDED` with an empty payload — nothing in core
 * consumes that name, so those cases fail. With the bridge wired in they pass.
 */
import { EventType, type IAgentRuntime, type Memory } from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";
import type { ResolvedSlackAccount } from "./accounts";
import { SlackService } from "./service";
import type { SlackChannel, SlackSettings, SlackUser } from "./types";
import { SlackEventTypes } from "./types";

const BOT_USER_ID = "U0BOTBOT0";
const CHANNEL_ID = "C0123ABCD";
const REACTOR_ID = "U0REACTOR";
const AUTHOR_ID = "U0AUTHOR0";
const MESSAGE_TS = "1700000000.000100";
const THREAD_TS = "1699999999.000001";

interface HarnessOptions {
  /** Memories the runtime already knows about, keyed by memory UUID. */
  memories?: Map<string, Memory>;
  /** Rooms the runtime already knows about, keyed by room UUID. */
  rooms?: Map<string, { id: string }>;
  allowedChannelIds?: string[];
  existingEntity?: boolean;
}

function createRuntime(
  memories: Map<string, Memory>,
  rooms: Map<string, { id: string }>,
) {
  return {
    agentId: "agent-slack-reactions",
    character: { name: "Salem", settings: {} },
    logger: {
      info: vi.fn(),
      debug: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    },
    getSetting: vi.fn().mockReturnValue(undefined),
    emitEvent: vi.fn(),
    createMemory: vi.fn(),
    createMemories: vi.fn(),
    createEntity: vi.fn(),
    getMemoryById: vi.fn(async (id: string) => memories.get(id) ?? null),
    getEntityById: vi.fn().mockResolvedValue({ id: "entity-existing" }),
    // A real room store keyed by UUID, NOT a canned room. A blanket
    // `mockResolvedValue({ id: "room-existing" })` makes `ensureRoomExists`
    // short-circuit on its `getRoom(roomId)` hit and hand back a room whose id
    // never came from `createUniqueUuid`, so the room-mapping the bridge is
    // supposed to reuse is never exercised and the assertion tests nothing.
    // Backing it with a Map means an unseen channel misses, falls through to
    // the real `getRoomId` + `createRoom` path, and the id under test is the
    // one production would compute.
    getRoom: vi.fn(async (id: string) => rooms.get(id) ?? null),
    createRoom: vi.fn(async (room: { id: string }) => {
      rooms.set(room.id, room);
      return room;
    }),
    getWorld: vi.fn().mockResolvedValue({ id: "world-1" }),
    createWorld: vi.fn(),
  } as unknown as IAgentRuntime;
}

/**
 * Builds a SlackService wired the way `startAccount` wires it and returns the
 * reaction handlers `registerEventHandlers` actually binds to the bolt app.
 */
function createHarness(options: HarnessOptions = {}) {
  const memories = options.memories ?? new Map<string, Memory>();
  const rooms = options.rooms ?? new Map<string, { id: string }>();
  const runtime = createRuntime(memories, rooms);
  const service = Object.create(SlackService.prototype) as SlackService;

  const settings: SlackSettings = {
    allowedChannelIds: options.allowedChannelIds,
    shouldIgnoreBotMessages: true,
    shouldRespondOnlyToMentions: false,
  };

  const account = {
    accountId: "default",
    enabled: true,
    role: "AGENT",
    botToken: "xoxb-test",
    appToken: "xapp-test",
    botTokenSource: "config",
    appTokenSource: "config",
    config: {},
  } as unknown as ResolvedSlackAccount;

  const allowedChannelIds = new Set<string>(options.allowedChannelIds ?? []);

  const state = {
    accountId: "default",
    account,
    app: {} as never,
    client: {} as never,
    userClient: null,
    botUserId: BOT_USER_ID,
    teamId: "T0TEAM000",
    settings,
    allowedChannelIds,
    dynamicChannelIds: new Set<string>(),
    userCache: new Map<string, SlackUser>(),
    channelCache: new Map<string, SlackChannel>(),
    isConnected: true,
  };

  Object.assign(service, {
    runtime,
    character: runtime.character,
    settings,
    defaultAccountId: "default",
    accountStates: new Map([["default", state]]),
    accountStarts: new Map(),
    allowedChannelIds,
    dynamicChannelIds: new Set<string>(),
    userCache: new Map(),
    channelCache: new Map(),
    botUserId: BOT_USER_ID,
    teamId: "T0TEAM000",
    isConnected: true,
  });

  // Stub only the Slack-network edges; all ID/room/entity mapping stays real
  // so the test proves reactions land on the same UUIDs as messages.
  const sendMessage = vi.fn().mockResolvedValue({ ts: "1", channelId: "C" });
  Object.assign(service, {
    getUser: vi.fn().mockResolvedValue(null),
    getChannel: vi.fn().mockResolvedValue(null),
    sendMessage,
  });

  // Capture the handlers registered on the real bolt app surface.
  const handlers: {
    reactionAdded?: (args: { event: unknown }) => Promise<void>;
    reactionRemoved?: (args: { event: unknown }) => Promise<void>;
  } = {};

  const app = {
    message: () => {},
    event: (name: string, fn: (args: { event: unknown }) => Promise<void>) => {
      if (name === "reaction_added") handlers.reactionAdded = fn;
      if (name === "reaction_removed") handlers.reactionRemoved = fn;
    },
  };

  (
    service as unknown as { registerEventHandlers: (s: unknown) => void }
  ).registerEventHandlers({ ...state, app });

  return { service, runtime, handlers, sendMessage, memories, rooms };
}

function reactionEvent(overrides: Record<string, unknown> = {}) {
  return {
    type: "reaction_added",
    user: REACTOR_ID,
    reaction: "+1",
    item: { type: "message", channel: CHANNEL_ID, ts: MESSAGE_TS },
    item_user: AUTHOR_ID,
    event_ts: "1700000001.000200",
    ...overrides,
  };
}

/** Pulls the emitted event-name list + payload for a given event name. */
function findEmit(runtime: IAgentRuntime, eventName: string) {
  const calls = (runtime.emitEvent as ReturnType<typeof vi.fn>).mock.calls;
  return calls.find(([names]) =>
    Array.isArray(names) ? names.includes(eventName) : names === eventName,
  );
}

describe("Slack reaction bridge — production wiring", () => {
  it("registers handlers on the real bolt reaction_added/reaction_removed events", () => {
    const h = createHarness();
    expect(h.handlers.reactionAdded).toBeTypeOf("function");
    expect(h.handlers.reactionRemoved).toBeTypeOf("function");
  });

  it("emits core EventType.REACTION_RECEIVED when a reaction is added", async () => {
    // FAILS on develop: the handler discards the event and emits only the
    // plugin-local SLACK_REACTION_ADDED, so the core event never fires.
    const h = createHarness();

    await h.handlers.reactionAdded?.({ event: reactionEvent() });

    const emit = findEmit(h.runtime, EventType.REACTION_RECEIVED);
    expect(emit).toBeDefined();
  });

  it("keeps the plugin-local SLACK_REACTION_ADDED event for back-compat", async () => {
    const h = createHarness();

    await h.handlers.reactionAdded?.({ event: reactionEvent() });

    const emit = findEmit(h.runtime, SlackEventTypes.REACTION_ADDED as string);
    expect(emit).toBeDefined();
    // Both names ride on a single emit so consumers see one payload.
    const [names] = emit as [string[], unknown];
    expect(names).toContain(EventType.REACTION_RECEIVED);
  });

  it("carries emoji, message ts, channel, and reactor identity in the payload", async () => {
    // FAILS on develop: buildEventPayload carries no reaction data at all.
    const h = createHarness();

    await h.handlers.reactionAdded?.({ event: reactionEvent() });

    const emit = findEmit(h.runtime, EventType.REACTION_RECEIVED);
    const payload = (emit as [string[], Record<string, unknown>])[1];

    expect(payload.reaction).toBe("+1");
    expect(payload.messageTs).toBe(MESSAGE_TS);
    expect(payload.channelId).toBe(CHANNEL_ID);
    expect(payload.userId).toBe(REACTOR_ID);
    expect(payload.itemUser).toBe(AUTHOR_ID);
    expect(payload.source).toBe("slack");
  });

  it("attaches a Memory whose entity/room match the plugin's uuid scheme", async () => {
    const h = createHarness();

    await h.handlers.reactionAdded?.({ event: reactionEvent() });

    const emit = findEmit(h.runtime, EventType.REACTION_RECEIVED);
    const payload = (emit as [string[], { message: Memory }])[1];
    const memory = payload.message;

    expect(memory).toBeDefined();
    // Same scheme the message path uses: stringToUuid("slack-user-<id>")
    // and createUniqueUuid("slack-room-<channel>").
    const expectedEntityId = (
      h.service as unknown as {
        getEntityId: (u: string, a: string) => string;
      }
    ).getEntityId(REACTOR_ID, "default");
    const expectedRoomId = await (
      h.service as unknown as {
        getRoomId: (c: string, t: undefined, a: string) => Promise<string>;
      }
    ).getRoomId(CHANNEL_ID, undefined, "default");

    expect(memory.entityId).toBe(expectedEntityId);
    expect(memory.roomId).toBe(expectedRoomId);
    expect(memory.agentId).toBe(h.runtime.agentId);

    // The channel room did not exist beforehand, so the bridge must have gone
    // through the real `ensureRoomExists` -> `createRoom` path rather than
    // reusing a pre-seeded room. Asserting the created room's id proves the
    // reaction joins the same room the message path would create.
    expect(h.runtime.createRoom).toHaveBeenCalledTimes(1);
    const createdRoom = (h.runtime.createRoom as ReturnType<typeof vi.fn>).mock
      .calls[0][0] as { id: string; channelId: string; source: string };
    expect(createdRoom.id).toBe(expectedRoomId);
    expect(createdRoom.channelId).toBe(CHANNEL_ID);
    expect(createdRoom.source).toBe("slack");
    expect(h.rooms.get(expectedRoomId)).toBeDefined();

    const meta = memory.metadata as {
      slackReaction?: { action?: string; emoji?: string };
    };
    expect(meta.slackReaction?.action).toBe("added");
    expect(meta.slackReaction?.emoji).toBe("+1");
  });

  it("references the reacted-to message memory via inReplyTo", async () => {
    const h = createHarness();

    await h.handlers.reactionAdded?.({ event: reactionEvent() });

    const emit = findEmit(h.runtime, EventType.REACTION_RECEIVED);
    const memory = (emit as [string[], { message: Memory }])[1].message;

    // The target id is deterministic from the Slack ts, so a consumer can
    // join the reaction to the message even when the memory is absent.
    const meta = memory.metadata as {
      slackReaction?: { targetMessageId?: string; targetMessageTs?: string };
    };
    expect(meta.slackReaction?.targetMessageTs).toBe(MESSAGE_TS);
    expect(memory.content.inReplyTo).toBe(meta.slackReaction?.targetMessageId);
  });

  it("resolves the reacted-to message text when the memory is known", async () => {
    const memories = new Map<string, Memory>();
    const h0 = createHarness();
    const targetId = (
      h0.service as unknown as {
        scopedSlackKey: (p: string, k: string, a: string) => string;
      }
    ).scopedSlackKey("slack", MESSAGE_TS, "default");
    expect(targetId).toBe(`slack-${MESSAGE_TS}`);

    // Seed the target memory under the id the bridge will look up.
    const h = createHarness({ memories });
    const lookupId = (
      h.service as unknown as {
        reactionBridgeHost: () => {
          getMessageMemoryId: (ts: string, a: string) => string;
        };
      }
    )
      .reactionBridgeHost()
      .getMessageMemoryId(MESSAGE_TS, "default");

    memories.set(lookupId, {
      id: lookupId as never,
      entityId: "e" as never,
      agentId: "a" as never,
      roomId: "room-parent" as never,
      content: { text: "did the dishes", source: "slack" },
      metadata: { slackMessageTs: MESSAGE_TS } as never,
    } as Memory);

    await h.handlers.reactionAdded?.({ event: reactionEvent() });

    const emit = findEmit(h.runtime, EventType.REACTION_RECEIVED);
    const memory = (emit as [string[], { message: Memory }])[1].message;

    expect(memory.content.text).toContain("did the dishes");
    expect(
      (memory.content as { reactedMessageText?: string }).reactedMessageText,
    ).toBe("did the dishes");
  });

  it("routes a reaction on a threaded message into that thread's room", async () => {
    const memories = new Map<string, Memory>();
    const h = createHarness({ memories });

    const lookupId = (
      h.service as unknown as {
        reactionBridgeHost: () => {
          getMessageMemoryId: (ts: string, a: string) => string;
        };
      }
    )
      .reactionBridgeHost()
      .getMessageMemoryId(MESSAGE_TS, "default");

    // The message lives in the thread room, not the channel room.
    const threadRoomId = await (
      h.service as unknown as {
        getRoomId: (c: string, t: string, a: string) => Promise<string>;
      }
    ).getRoomId(CHANNEL_ID, THREAD_TS, "default");

    memories.set(lookupId, {
      id: lookupId as never,
      entityId: "e" as never,
      agentId: "a" as never,
      roomId: threadRoomId as never,
      content: { text: "in thread", source: "slack" },
      metadata: { slackThreadTs: THREAD_TS } as never,
    } as Memory);

    await h.handlers.reactionAdded?.({ event: reactionEvent() });

    const emit = findEmit(h.runtime, EventType.REACTION_RECEIVED);
    const memory = (emit as [string[], { message: Memory }])[1].message;

    // A reaction event carries no thread_ts; without recovery it would land
    // in the channel room and detach from the message it reacted to.
    const channelRoomId = await (
      h.service as unknown as {
        getRoomId: (c: string, t: undefined, a: string) => Promise<string>;
      }
    ).getRoomId(CHANNEL_ID, undefined, "default");

    expect(memory.roomId).toBe(threadRoomId);
    expect(memory.roomId).not.toBe(channelRoomId);
    expect((memory.metadata as { slackThreadTs?: string }).slackThreadTs).toBe(
      THREAD_TS,
    );
  });

  it("emits SLACK_REACTION_REMOVED with full payload on removal", async () => {
    // FAILS on develop: the removal payload carries no reaction data.
    const h = createHarness();

    await h.handlers.reactionRemoved?.({
      event: reactionEvent({ type: "reaction_removed" }),
    });

    const emit = findEmit(
      h.runtime,
      SlackEventTypes.REACTION_REMOVED as string,
    );
    expect(emit).toBeDefined();

    const payload = (emit as [string[], Record<string, unknown>])[1];
    expect(payload.reaction).toBe("+1");
    expect(payload.messageTs).toBe(MESSAGE_TS);

    const memory = payload.message as Memory;
    const meta = memory.metadata as { slackReaction?: { action?: string } };
    expect(meta.slackReaction?.action).toBe("removed");
    expect(memory.content.text).toContain("Removed");
  });

  it("does NOT emit core REACTION_RECEIVED on removal (matches plugin-discord)", async () => {
    // Core declares no REACTION_REMOVED. plugin-discord bridges only the add
    // to core; mirroring that keeps a platform-agnostic vote counter from
    // double-counting on Slack while under-counting on Discord.
    const h = createHarness();

    await h.handlers.reactionRemoved?.({
      event: reactionEvent({ type: "reaction_removed" }),
    });

    expect(findEmit(h.runtime, EventType.REACTION_RECEIVED)).toBeUndefined();
  });

  it("ignores non-message reactions (files)", async () => {
    const h = createHarness();

    await h.handlers.reactionAdded?.({
      event: reactionEvent({
        item: { type: "file", channel: CHANNEL_ID, ts: MESSAGE_TS },
      }),
    });

    expect(h.runtime.emitEvent).not.toHaveBeenCalled();
  });

  it("honours the channel allowlist", async () => {
    const h = createHarness({ allowedChannelIds: ["C0OTHER99"] });

    await h.handlers.reactionAdded?.({ event: reactionEvent() });

    expect(h.runtime.emitEvent).not.toHaveBeenCalled();
  });

  it("provides a callback that replies into the reacted channel", async () => {
    const h = createHarness();

    await h.handlers.reactionAdded?.({ event: reactionEvent() });

    const emit = findEmit(h.runtime, EventType.REACTION_RECEIVED);
    const payload = (emit as [string[], Record<string, unknown>])[1];
    const callback = payload.callback as (c: {
      text: string;
    }) => Promise<unknown>;

    expect(callback).toBeTypeOf("function");
    await callback({ text: "counted your vote" });

    // Non-threaded reaction, so `threadTs` is undefined; the remaining keys
    // are the fully-spelled `SlackMessageSendOptions` shape the plugin's
    // other reply paths use.
    expect(h.sendMessage).toHaveBeenCalledWith(
      CHANNEL_ID,
      "counted your vote",
      expect.objectContaining({ threadTs: undefined }),
      "default",
    );
  });

  it("never throws out of the handler on a malformed event", async () => {
    const h = createHarness();

    await expect(
      h.handlers.reactionAdded?.({ event: { user: REACTOR_ID } }),
    ).resolves.toBeUndefined();
    expect(h.runtime.emitEvent).not.toHaveBeenCalled();
  });
});
