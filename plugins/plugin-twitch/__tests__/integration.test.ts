import { describe, expect, test, vi } from "vitest";
import twitchPlugin, {
  formatChannelForDisplay,
  getTwitchUserDisplayName,
  MAX_TWITCH_MESSAGE_LENGTH,
  normalizeChannel,
  splitMessageForTwitch,
  stripMarkdownForTwitch,
  TWITCH_SERVICE_NAME,
  TwitchApiError,
  TwitchConfigurationError,
  TwitchEventTypes,
  type TwitchMessage,
  type TwitchMessageSendOptions,
  TwitchNotConnectedError,
  TwitchPluginError,
  type TwitchSendResult,
  TwitchService,
  TwitchServiceNotInitializedError,
  type TwitchUserInfo,
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

  test("does not register platform-specific chat actions", () => {
    expect(twitchPlugin.actions).toHaveLength(0);
  });

  test("does not register platform-specific context providers", () => {
    expect(twitchPlugin.providers).toHaveLength(0);
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
    const text = `${prefix}. ${"B".repeat(250)}`; // total 552
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

describe("Twitch message connector accounts", () => {
  test("registers one connector for each started account", () => {
    const runtime = makeMockRuntime({
      registerMessageConnector: vi.fn(),
      registerSendHandler: vi.fn(),
      logger: { info: vi.fn() },
    });
    const service = Object.create(TwitchService.prototype) as TwitchService;
    const primary = Object.create(TwitchService.prototype) as TwitchService;
    const secondary = Object.create(TwitchService.prototype) as TwitchService;
    (primary as any).settings = {
      accountId: "primary",
      username: "bot_one",
      channel: "one",
      additionalChannels: [],
    };
    (primary as any).joinedChannels = new Set(["one"]);
    (secondary as any).settings = {
      accountId: "secondary",
      username: "bot_two",
      channel: "two",
      additionalChannels: [],
    };
    (secondary as any).joinedChannels = new Set(["two"]);
    (service as any).accountServices = new Map([
      ["primary", primary],
      ["secondary", secondary],
    ]);

    TwitchService.registerSendHandlers(runtime, service);

    expect(runtime.registerMessageConnector).toHaveBeenCalledTimes(2);
    expect(
      (runtime.registerMessageConnector as any).mock.calls.map(
        ([registration]: any[]) => registration.accountId,
      ),
    ).toEqual(["primary", "secondary"]);
  });

  test("registers accountId and routes sends through that account", async () => {
    const runtime = makeMockRuntime({
      registerMessageConnector: vi.fn(),
      registerSendHandler: vi.fn(),
      getRoom: vi.fn(),
      logger: { info: vi.fn() },
      TWITCH_DEFAULT_ACCOUNT_ID: "streamer",
    });
    const service = Object.create(TwitchService.prototype) as TwitchService;
    (service as any).settings = {
      accountId: "streamer",
      username: "testbot",
      channel: "mainchannel",
    };
    const sendMessage = vi
      .spyOn(service, "sendMessage")
      .mockResolvedValue({ success: true, messageId: "msg-1" });

    TwitchService.registerSendHandlers(runtime, service);

    expect(runtime.registerMessageConnector).toHaveBeenCalledWith(
      expect.objectContaining({
        source: "twitch",
        accountId: "streamer",
        joinHandler: expect.any(Function),
        leaveHandler: expect.any(Function),
      }),
    );

    const registration = (runtime.registerMessageConnector as any).mock
      .calls[0][0];
    await registration.sendHandler!(
      runtime,
      {
        source: "twitch",
        accountId: "streamer",
        channelId: "mainchannel",
      } as any,
      { text: "hello" } as any,
    );

    expect(sendMessage).toHaveBeenCalledWith(
      "hello",
      expect.objectContaining({ channel: "mainchannel" }),
    );
  });
});

// ===========================================================================
// 7. sendMessage path
// ===========================================================================
// Twitch send used to be a standalone action; now the Twitch
// MessageConnector (registered by TwitchService.registerSendHandlers) is the
// canonical send path through MESSAGE operation=send. Action-shape and handler
// tests retired with the action.

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
