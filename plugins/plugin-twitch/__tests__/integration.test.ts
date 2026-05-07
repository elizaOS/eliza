import { describe, expect, test, beforeEach, vi } from "vitest";
import twitchPlugin, {
  TwitchService,
  twitchChannelAction,
  twitchChannelsProvider,
  userContextProvider,
  normalizeChannel,
  formatChannelForDisplay,
  getTwitchUserDisplayName,
  stripMarkdownForTwitch,
  splitMessageForTwitch,
  MAX_TWITCH_MESSAGE_LENGTH,
  TWITCH_SERVICE_NAME,
  TwitchEventTypes,
  TwitchPluginError,
  TwitchServiceNotInitializedError,
  TwitchNotConnectedError,
  TwitchConfigurationError,
  TwitchApiError,
  type TwitchSettings,
  type TwitchUserInfo,
  type TwitchMessage,
  type TwitchMessageSendOptions,
  type TwitchSendResult,
} from "../src/index.ts";

// ---------------------------------------------------------------------------
// Helpers: mock runtime, memory, state
// ---------------------------------------------------------------------------

function makeMockRuntime(overrides: Record<string, unknown> = {}) {
  return {
    getSetting: (key: string) =>
      (overrides as Record<string, string>)[key] ?? null,
    getService: (_name: string) => overrides.service ?? null,
    composeState: async (_msg: unknown) => ({ recentMessages: "" }),
    useModel: async (_type: string, _opts: unknown) =>
      overrides.modelResponse ?? "{}",
    emitEvent: async () => {},
    ...overrides,
  } as any;
}

function makeMemory(source: string = "twitch", text: string = "hello") {
  return {
    content: { text, source },
    userId: "user-1",
    roomId: "room-1",
  } as any;
}

function makeState(extra: Record<string, unknown> = {}) {
  return {
    agentName: "TestBot",
    recentMessages: "",
    data: {},
    ...extra,
  } as any;
}

function makeMockTwitchService(overrides: Record<string, unknown> = {}) {
  return {
    isConnected: () => overrides.connected ?? true,
    getBotUsername: () => overrides.botUsername ?? "testbot",
    getPrimaryChannel: () => overrides.primaryChannel ?? "mainchannel",
    getJoinedChannels: () =>
      (overrides.joinedChannels as string[]) ?? ["mainchannel"],
    sendMessage: async (_text: string, _opts?: TwitchMessageSendOptions) =>
      (overrides.sendResult as TwitchSendResult) ?? {
        success: true,
        messageId: "msg-123",
      },
    joinChannel: overrides.joinChannel ?? (async () => {}),
    leaveChannel: overrides.leaveChannel ?? (async () => {}),
  };
}

// ===========================================================================
// 1. Plugin Metadata
// ===========================================================================

describe("Plugin metadata", () => {
  test("has correct name", () => {
    expect(twitchPlugin.name).toBe("twitch");
  });

  test("has a description containing 'Twitch'", () => {
    expect(twitchPlugin.description).toContain("Twitch");
  });

  test("registers the channel router action (sends route through SEND_MESSAGE connector)", () => {
    expect(twitchPlugin.actions).toHaveLength(1);
    const names = twitchPlugin.actions!.map((a) => a.name);
    expect(names).toContain("TWITCH_CHANNEL_OP");
  });

  test("registers the user context and channels providers", () => {
    expect(twitchPlugin.providers).toHaveLength(2);
    const names = twitchPlugin.providers!.map((p) => p.name);
    expect(names).toContain("twitchUserContext");
    expect(names).toContain("twitchChannels");
  });

  test("registers exactly 1 service", () => {
    expect(twitchPlugin.services).toHaveLength(1);
    expect(twitchPlugin.services![0]).toBe(TwitchService);
  });

  test("has an init function", () => {
    expect(typeof twitchPlugin.init).toBe("function");
  });
});

// ===========================================================================
// 2. Constants
// ===========================================================================

describe("Constants", () => {
  test("MAX_TWITCH_MESSAGE_LENGTH is 500", () => {
    expect(MAX_TWITCH_MESSAGE_LENGTH).toBe(500);
  });

  test("TWITCH_SERVICE_NAME is 'twitch'", () => {
    expect(TWITCH_SERVICE_NAME).toBe("twitch");
  });
});

// ===========================================================================
// 3. Event Types Enum
// ===========================================================================

describe("TwitchEventTypes", () => {
  test("has all expected event types", () => {
    expect(TwitchEventTypes.MESSAGE_RECEIVED).toBe("TWITCH_MESSAGE_RECEIVED");
    expect(TwitchEventTypes.MESSAGE_SENT).toBe("TWITCH_MESSAGE_SENT");
    expect(TwitchEventTypes.JOIN_CHANNEL).toBe("TWITCH_JOIN_CHANNEL");
    expect(TwitchEventTypes.LEAVE_CHANNEL).toBe("TWITCH_LEAVE_CHANNEL");
    expect(TwitchEventTypes.CONNECTION_READY).toBe("TWITCH_CONNECTION_READY");
    expect(TwitchEventTypes.CONNECTION_LOST).toBe("TWITCH_CONNECTION_LOST");
  });
});

// ===========================================================================
// 4. Utility Functions
// ===========================================================================

describe("normalizeChannel", () => {
  test.each([
    ["#mychannel", "mychannel"],
    ["mychannel", "mychannel"],
    ["", ""],
    ["##double", "#double"],
  ])("normalizeChannel(%s) → %s", (input, expected) => {
    expect(normalizeChannel(input)).toBe(expected);
  });
});

describe("formatChannelForDisplay", () => {
  test.each([
    ["mychannel", "#mychannel"],
    ["#mychannel", "#mychannel"],
  ])("formatChannelForDisplay(%s) → %s", (input, expected) => {
    expect(formatChannelForDisplay(input)).toBe(expected);
  });
});

describe("getTwitchUserDisplayName", () => {
  test("returns displayName when set", () => {
    const user = {
      userId: "1",
      username: "alice",
      displayName: "Alice_Cool",
      isModerator: false,
      isBroadcaster: false,
      isVip: false,
      isSubscriber: false,
      badges: new Map(),
    } as TwitchUserInfo;
    expect(getTwitchUserDisplayName(user)).toBe("Alice_Cool");
  });

  test("falls back to username when displayName is empty", () => {
    const user = {
      userId: "1",
      username: "bob",
      displayName: "",
      isModerator: false,
      isBroadcaster: false,
      isVip: false,
      isSubscriber: false,
      badges: new Map(),
    } as TwitchUserInfo;
    expect(getTwitchUserDisplayName(user)).toBe("bob");
  });
});

describe("stripMarkdownForTwitch", () => {
  test.each([
    ["**bold text**", "bold text"],
    ["__bold text__", "bold text"],
    ["*italic text*", "italic text"],
    ["_italic text_", "italic text"],
    ["~~strikethrough~~", "strikethrough"],
    ["`some code`", "some code"],
    ["[click here](https://example.com)", "click here"],
    ["## My Header", "My Header"],
    ["> quoted text", "quoted text"],
    ["- item one", "• item one"],
    ["1. item one", "• item one"],
    ["a\n\n\n\nb", "a\n\nb"],
    ["plain text", "plain text"],
    ["  hello  ", "hello"],
  ])("stripMarkdownForTwitch(%j) → %j", (input, expected) => {
    expect(stripMarkdownForTwitch(input)).toBe(expected);
  });

  test("processes code blocks", () => {
    const result = stripMarkdownForTwitch("```js\nconsole.log('hi');\n```");
    expect(result.length).toBeGreaterThan(0);
    const result2 = stripMarkdownForTwitch("before ```code``` after");
    expect(result2).toContain("code");
  });
});

describe("splitMessageForTwitch", () => {
  test("returns single chunk for short messages", () => {
    const result = splitMessageForTwitch("Hello world");
    expect(result).toEqual(["Hello world"]);
  });

  test("splits long messages into multiple chunks", () => {
    const longMessage = "A".repeat(600);
    const result = splitMessageForTwitch(longMessage);
    expect(result.length).toBeGreaterThan(1);
    for (const chunk of result) {
      expect(chunk.length).toBeLessThanOrEqual(MAX_TWITCH_MESSAGE_LENGTH);
    }
  });

  test("prefers splitting at sentence boundaries", () => {
    // The ". " must appear past halfway of maxLength to be selected.
    // lastIndexOf(". ", maxLength) returns the index of the ".", so the
    // split point is at that index — everything before goes to chunk 0.
    const prefix = "A".repeat(300);
    const text = prefix + ". " + "B".repeat(250); // total 552
    const result = splitMessageForTwitch(text, 500);
    expect(result.length).toBe(2);
    expect(result[0]).toBe(prefix);
    expect(result[1]).toContain("B");
    expect(result[1].length).toBeLessThan(text.length);
  });

  test("falls back to word boundary when no sentence break", () => {
    const words = Array(60).fill("word").join(" "); // 60*5-1 = 299 chars
    const result = splitMessageForTwitch(words, 50);
    expect(result.length).toBeGreaterThan(1);
    // Every chunk should be within the max limit
    for (const chunk of result) {
      expect(chunk.length).toBeLessThanOrEqual(50);
    }
    // Reassembled text should contain all original words
    const reassembled = result.join(" ");
    expect(reassembled.replace(/\s+/g, " ")).toContain("word");
  });

  test("respects custom maxLength", () => {
    const text = "A".repeat(30);
    const result = splitMessageForTwitch(text, 10);
    expect(result.length).toBe(3);
  });

  test("returns empty for single-word exact match", () => {
    const text = "A".repeat(500);
    const result = splitMessageForTwitch(text, 500);
    expect(result).toEqual([text]);
  });
});

// ===========================================================================
// 5. Error Classes
// ===========================================================================

describe("Custom Errors", () => {
  test("TwitchPluginError is an Error with correct name", () => {
    const err = new TwitchPluginError("oops");
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe("TwitchPluginError");
    expect(err.message).toBe("oops");
  });

  test("TwitchServiceNotInitializedError has default message", () => {
    const err = new TwitchServiceNotInitializedError();
    expect(err.message).toBe("Twitch service is not initialized");
    expect(err.name).toBe("TwitchServiceNotInitializedError");
    expect(err).toBeInstanceOf(TwitchPluginError);
  });

  test("TwitchNotConnectedError has default message", () => {
    const err = new TwitchNotConnectedError();
    expect(err.message).toBe("Twitch client is not connected");
    expect(err.name).toBe("TwitchNotConnectedError");
    expect(err).toBeInstanceOf(TwitchPluginError);
  });

  test("TwitchConfigurationError stores settingName", () => {
    const err = new TwitchConfigurationError("bad config", "MY_SETTING");
    expect(err.message).toBe("bad config");
    expect(err.settingName).toBe("MY_SETTING");
    expect(err.name).toBe("TwitchConfigurationError");
    expect(err).toBeInstanceOf(TwitchPluginError);
  });

  test("TwitchApiError stores statusCode", () => {
    const err = new TwitchApiError("api fail", 401);
    expect(err.message).toBe("api fail");
    expect(err.statusCode).toBe(401);
    expect(err.name).toBe("TwitchApiError");
    expect(err).toBeInstanceOf(TwitchPluginError);
  });
});

// ===========================================================================
// 6. twitchChannelAction Router
// ===========================================================================

describe("twitchChannelAction", () => {
  test("has router metadata", () => {
    expect(twitchChannelAction.name).toBe("TWITCH_CHANNEL_OP");
    expect(twitchChannelAction.similes).toContain("TWITCH_CHANNEL");
    expect(twitchChannelAction.similes).toContain("TWITCH_JOIN_CHANNEL");
    expect(twitchChannelAction.similes).toContain("TWITCH_LEAVE_CHANNEL");
  });
});

// ===========================================================================
// 7. sendMessage path
// ===========================================================================
// TWITCH_SEND_MESSAGE used to be a standalone action; now the Twitch
// MessageConnector (registered by TwitchService.registerSendHandlers) is the
// canonical send path through SEND_MESSAGE. Action-shape and handler tests
// retired with the action.

// ===========================================================================
// 7. twitchChannelsProvider
// ===========================================================================

describe("twitchChannelsProvider", () => {
  test("has correct metadata", () => {
    expect(twitchChannelsProvider.name).toBe("twitchChannels");
    expect(twitchChannelsProvider.description).toContain("Twitch");
    expect(twitchChannelsProvider.dynamic).toBe(true);
  });

  test("returns not_connected when service unavailable", async () => {
    const runtime = makeMockRuntime({ service: null });
    const result = await twitchChannelsProvider.get!(
      runtime,
      makeMemory("twitch"),
      makeState(),
    );
    expect(String(result.text)).toContain("not_connected");
  });

  test("returns channel list when service connected", async () => {
    const service = makeMockTwitchService({
      connected: true,
      primaryChannel: "mainchannel",
      joinedChannels: ["mainchannel", "otherchannel"],
    });
    const runtime = makeMockRuntime({
      service,
      getService: () => service,
    });
    const result = await twitchChannelsProvider.get!(
      runtime,
      makeMemory("twitch"),
      makeState(),
    );

    expect(result.data!.channelCount).toBe(2);
    expect(result.data!.channels).toEqual(["mainchannel", "otherchannel"]);
    expect(result.data!.primaryChannel).toBe("mainchannel");
    expect(String(result.text)).toContain("ready");
    expect(String(result.text)).toContain("mainchannel");
  });

  test("returns empty list when no channels", async () => {
    const service = makeMockTwitchService({
      connected: true,
      primaryChannel: "main",
      joinedChannels: [],
    });
    const runtime = makeMockRuntime({
      service,
      getService: () => service,
    });
    const result = await twitchChannelsProvider.get!(
      runtime,
      makeMemory("twitch"),
      makeState(),
    );
    expect(result.data!.channelCount).toBe(0);
  });
});

// ===========================================================================
// 10. userContextProvider
// ===========================================================================

describe("userContextProvider", () => {
  test("has correct metadata", () => {
    expect(userContextProvider.name).toBe("twitchUserContext");
    expect(userContextProvider.description).toContain("Twitch user");
  });

  test("returns empty for non-twitch source", async () => {
    const runtime = makeMockRuntime();
    const memory = makeMemory("discord");
    const result = await userContextProvider.get(runtime, memory, makeState());
    expect(result.text).toBe("");
    expect(result.data).toEqual({});
  });

  test("returns empty when service unavailable", async () => {
    const runtime = makeMockRuntime({ service: null });
    const memory = makeMemory("twitch");
    const result = await userContextProvider.get(runtime, memory, makeState());
    expect(result.text).toBe("");
    expect(result.data).toEqual({});
  });

  test("returns empty when no user info in metadata", async () => {
    const service = makeMockTwitchService({ connected: true });
    const runtime = makeMockRuntime({
      service,
      getService: () => service,
    });
    const memory = makeMemory("twitch");
    const result = await userContextProvider.get(runtime, memory, makeState());
    expect(result.text).toBe("");
  });

  test("returns user context for broadcaster", async () => {
    const service = makeMockTwitchService({ connected: true });
    const runtime = makeMockRuntime({
      service,
      getService: () => service,
    });
    const memory = {
      content: {
        text: "hello",
        source: "twitch",
        metadata: {
          user: {
            userId: "12345",
            username: "streamer_dude",
            displayName: "Streamer_Dude",
            isModerator: false,
            isBroadcaster: true,
            isVip: false,
            isSubscriber: true,
            badges: new Map(),
          } as TwitchUserInfo,
        },
      },
    } as any;
    const state = makeState({ agentName: "MyBot" });

    const result = await userContextProvider.get(runtime, memory, state);

    expect(result.data.userId).toBe("12345");
    expect(result.data.username).toBe("streamer_dude");
    expect(result.data.displayName).toBe("Streamer_Dude");
    expect(result.data.isBroadcaster).toBe(true);
    expect(result.data.isSubscriber).toBe(true);
    expect(result.data.roles).toContain("broadcaster");
    expect(result.data.roles).toContain("subscriber");
    expect(result.values.roleText).toContain("broadcaster");
    expect(result.text).toContain("MyBot");
    expect(result.text).toContain("Streamer_Dude");
    expect(result.text).toContain("broadcaster");
    expect(result.text).toContain("channel owner/broadcaster");
  });

  test("returns viewer role when user has no special roles", async () => {
    const service = makeMockTwitchService({ connected: true });
    const runtime = makeMockRuntime({
      service,
      getService: () => service,
    });
    const memory = {
      content: {
        text: "hi",
        source: "twitch",
        metadata: {
          user: {
            userId: "99",
            username: "viewer99",
            displayName: "Viewer99",
            isModerator: false,
            isBroadcaster: false,
            isVip: false,
            isSubscriber: false,
            badges: new Map(),
          } as TwitchUserInfo,
        },
      },
    } as any;

    const result = await userContextProvider.get(runtime, memory, makeState());

    expect(result.values.roleText).toBe("viewer");
    expect(result.data.roles).toEqual([]);
  });

  test("returns moderator context text for moderator", async () => {
    const service = makeMockTwitchService({ connected: true });
    const runtime = makeMockRuntime({
      service,
      getService: () => service,
    });
    const memory = {
      content: {
        text: "hi",
        source: "twitch",
        metadata: {
          user: {
            userId: "55",
            username: "modperson",
            displayName: "ModPerson",
            isModerator: true,
            isBroadcaster: false,
            isVip: false,
            isSubscriber: false,
            badges: new Map(),
          } as TwitchUserInfo,
        },
      },
    } as any;

    const result = await userContextProvider.get(runtime, memory, makeState());

    expect(result.data.isModerator).toBe(true);
    expect(result.text).toContain("channel moderator");
    expect(result.text).not.toContain("broadcaster");
  });
});

// ===========================================================================
// 12. Type Construction
// ===========================================================================

describe("Type construction and shapes", () => {
  test("TwitchUserInfo can be constructed with all fields", () => {
    const user: TwitchUserInfo = {
      userId: "123",
      username: "testuser",
      displayName: "TestUser",
      isModerator: true,
      isBroadcaster: false,
      isVip: true,
      isSubscriber: false,
      color: "#FF0000",
      badges: new Map([["moderator", "1"]]),
    };
    expect(user.userId).toBe("123");
    expect(user.color).toBe("#FF0000");
    expect(user.badges.get("moderator")).toBe("1");
  });

  test("TwitchMessage can be constructed with reply info", () => {
    const msg: TwitchMessage = {
      id: "msg-1",
      channel: "test",
      text: "hello",
      user: {
        userId: "1",
        username: "user1",
        displayName: "User1",
        isModerator: false,
        isBroadcaster: false,
        isVip: false,
        isSubscriber: false,
        badges: new Map(),
      },
      timestamp: new Date(),
      isAction: false,
      isHighlighted: true,
      replyTo: {
        messageId: "parent-1",
        userId: "2",
        username: "user2",
        text: "original",
      },
    };
    expect(msg.replyTo?.messageId).toBe("parent-1");
    expect(msg.isHighlighted).toBe(true);
  });

  test("TwitchSendResult success shape", () => {
    const res: TwitchSendResult = {
      success: true,
      messageId: "abc-123",
    };
    expect(res.success).toBe(true);
    expect(res.messageId).toBe("abc-123");
    expect(res.error).toBeUndefined();
  });

  test("TwitchSendResult failure shape", () => {
    const res: TwitchSendResult = {
      success: false,
      error: "not connected",
    };
    expect(res.success).toBe(false);
    expect(res.error).toBe("not connected");
    expect(res.messageId).toBeUndefined();
  });

  test("TwitchMessageSendOptions is optional fields", () => {
    const opts: TwitchMessageSendOptions = {};
    expect(opts.channel).toBeUndefined();
    expect(opts.replyTo).toBeUndefined();

    const opts2: TwitchMessageSendOptions = {
      channel: "test",
      replyTo: "msg-1",
    };
    expect(opts2.channel).toBe("test");
    expect(opts2.replyTo).toBe("msg-1");
  });
});

// ===========================================================================
// 13. TwitchService Static Properties
// ===========================================================================

describe("TwitchService class", () => {
  test("has correct serviceType", () => {
    expect(TwitchService.serviceType).toBe("twitch");
  });

  test("has static start method", () => {
    expect(typeof TwitchService.start).toBe("function");
  });

  test("has static stopRuntime method", () => {
    expect(typeof TwitchService.stopRuntime).toBe("function");
  });
});
