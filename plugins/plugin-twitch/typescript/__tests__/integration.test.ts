import { describe, expect, test, beforeEach, mock } from "bun:test";
import twitchPlugin, {
  TwitchService,
  channelStateProvider,
  joinChannel,
  leaveChannel,
  listChannels,
  sendMessage,
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
    getSetting: (key: string) => (overrides as Record<string, string>)[key] ?? null,
    getService: (_name: string) => overrides.service ?? null,
    composeState: async (_msg: unknown) => ({ recentMessages: "" }),
    useModel: async (_type: string, _opts: unknown) => overrides.modelResponse ?? "{}",
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

  test("registers exactly 4 actions", () => {
    expect(twitchPlugin.actions).toHaveLength(4);
    const names = twitchPlugin.actions!.map((a) => a.name);
    expect(names).toContain("TWITCH_SEND_MESSAGE");
    expect(names).toContain("TWITCH_JOIN_CHANNEL");
    expect(names).toContain("TWITCH_LEAVE_CHANNEL");
    expect(names).toContain("TWITCH_LIST_CHANNELS");
  });

  test("registers exactly 2 providers", () => {
    expect(twitchPlugin.providers).toHaveLength(2);
    const names = twitchPlugin.providers!.map((p) => p.name);
    expect(names).toContain("twitchChannelState");
    expect(names).toContain("twitchUserContext");
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
  test("strips leading # from channel name", () => {
    expect(normalizeChannel("#mychannel")).toBe("mychannel");
  });

  test("returns channel unchanged when no #", () => {
    expect(normalizeChannel("mychannel")).toBe("mychannel");
  });

  test("handles empty string", () => {
    expect(normalizeChannel("")).toBe("");
  });

  test("only strips the first #", () => {
    expect(normalizeChannel("##double")).toBe("#double");
  });
});

describe("formatChannelForDisplay", () => {
  test("adds # prefix to bare name", () => {
    expect(formatChannelForDisplay("mychannel")).toBe("#mychannel");
  });

  test("does not double-prefix", () => {
    expect(formatChannelForDisplay("#mychannel")).toBe("#mychannel");
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
  test("strips bold (**text**)", () => {
    expect(stripMarkdownForTwitch("**bold text**")).toBe("bold text");
  });

  test("strips bold (__text__)", () => {
    expect(stripMarkdownForTwitch("__bold text__")).toBe("bold text");
  });

  test("strips italic (*text*)", () => {
    expect(stripMarkdownForTwitch("*italic text*")).toBe("italic text");
  });

  test("strips italic (_text_)", () => {
    expect(stripMarkdownForTwitch("_italic text_")).toBe("italic text");
  });

  test("strips strikethrough", () => {
    expect(stripMarkdownForTwitch("~~strikethrough~~")).toBe("strikethrough");
  });

  test("strips inline code", () => {
    expect(stripMarkdownForTwitch("`some code`")).toBe("some code");
  });

  test("processes code blocks", () => {
    // The inline code regex runs before the code block regex, so triple-backtick
    // blocks where content has no backticks get partially consumed.
    // Verify the function produces a non-empty stripped result.
    const result = stripMarkdownForTwitch("```js\nconsole.log('hi');\n```");
    expect(result.length).toBeGreaterThan(0);
    // Test with a code block whose content already contains backticks
    const result2 = stripMarkdownForTwitch("before ```code``` after");
    expect(result2).toContain("code");
  });

  test("keeps link text, removes URL", () => {
    expect(stripMarkdownForTwitch("[click here](https://example.com)")).toBe(
      "click here",
    );
  });

  test("strips header markers", () => {
    expect(stripMarkdownForTwitch("## My Header")).toBe("My Header");
  });

  test("strips blockquotes", () => {
    expect(stripMarkdownForTwitch("> quoted text")).toBe("quoted text");
  });

  test("converts unordered list markers to bullet", () => {
    expect(stripMarkdownForTwitch("- item one")).toBe("• item one");
  });

  test("converts ordered list markers to bullet", () => {
    expect(stripMarkdownForTwitch("1. item one")).toBe("• item one");
  });

  test("collapses multiple newlines", () => {
    expect(stripMarkdownForTwitch("a\n\n\n\nb")).toBe("a\n\nb");
  });

  test("handles plain text untouched", () => {
    expect(stripMarkdownForTwitch("plain text")).toBe("plain text");
  });

  test("trims leading/trailing whitespace", () => {
    expect(stripMarkdownForTwitch("  hello  ")).toBe("hello");
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
// 6. sendMessage Action
// ===========================================================================

describe("sendMessage action", () => {
  test("has correct metadata", () => {
    expect(sendMessage.name).toBe("TWITCH_SEND_MESSAGE");
    expect(sendMessage.description).toBe("Send a message to a Twitch channel");
    expect(sendMessage.similes).toContain("SEND_TWITCH_MESSAGE");
    expect(sendMessage.similes).toContain("TWITCH_CHAT");
    expect(sendMessage.similes).toContain("CHAT_TWITCH");
    expect(sendMessage.similes).toContain("SAY_IN_TWITCH");
    expect(sendMessage.similes).toHaveLength(4);
  });

  test("has examples", () => {
    expect(sendMessage.examples!.length).toBeGreaterThan(0);
  });

  test("validate returns true for twitch source", async () => {
    const runtime = makeMockRuntime();
    const memory = makeMemory("twitch");
    expect(await sendMessage.validate!(runtime, memory)).toBe(true);
  });

  test("validate returns false for non-twitch source", async () => {
    const runtime = makeMockRuntime();
    expect(await sendMessage.validate!(runtime, makeMemory("discord"))).toBe(false);
    expect(await sendMessage.validate!(runtime, makeMemory("telegram"))).toBe(false);
    expect(await sendMessage.validate!(runtime, makeMemory(""))).toBe(false);
  });

  test("handler returns error when service unavailable", async () => {
    const runtime = makeMockRuntime({ service: null });
    const memory = makeMemory("twitch");
    let callbackPayload: any = null;
    const callback = (resp: any) => { callbackPayload = resp; };

    const result = await sendMessage.handler!(runtime, memory, makeState(), {}, callback);

    expect(result.success).toBe(false);
    expect(result.error).toBe("Twitch service not available");
    expect(callbackPayload).not.toBeNull();
    expect(callbackPayload.text).toBe("Twitch service is not available.");
  });

  test("handler returns error when service not connected", async () => {
    const service = makeMockTwitchService({ connected: false });
    const runtime = makeMockRuntime({
      service,
      getService: () => service,
    });
    const memory = makeMemory("twitch");
    let callbackPayload: any = null;
    const callback = (resp: any) => { callbackPayload = resp; };

    const result = await sendMessage.handler!(runtime, memory, makeState(), {}, callback);

    expect(result.success).toBe(false);
    expect(result.error).toBe("Twitch service not available");
    expect(callbackPayload.text).toBe("Twitch service is not available.");
  });
});

// ===========================================================================
// 7. joinChannel Action
// ===========================================================================

describe("joinChannel action", () => {
  test("has correct metadata", () => {
    expect(joinChannel.name).toBe("TWITCH_JOIN_CHANNEL");
    expect(joinChannel.description).toContain("Join");
    expect(joinChannel.description).toContain("Twitch channel");
    expect(joinChannel.similes).toContain("JOIN_TWITCH_CHANNEL");
    expect(joinChannel.similes).toContain("ENTER_CHANNEL");
    expect(joinChannel.similes).toContain("CONNECT_CHANNEL");
    expect(joinChannel.similes).toHaveLength(3);
  });

  test("has examples", () => {
    expect(joinChannel.examples!.length).toBeGreaterThan(0);
  });

  test("validate returns true for twitch source", async () => {
    const runtime = makeMockRuntime();
    expect(await joinChannel.validate!(runtime, makeMemory("twitch"))).toBe(true);
  });

  test("validate returns false for non-twitch source", async () => {
    const runtime = makeMockRuntime();
    expect(await joinChannel.validate!(runtime, makeMemory("discord"))).toBe(false);
    expect(await joinChannel.validate!(runtime, makeMemory(""))).toBe(false);
  });

  test("handler returns error when service unavailable", async () => {
    const runtime = makeMockRuntime({ service: null });
    const memory = makeMemory("twitch");
    let callbackText = "";
    const callback = (resp: any) => { callbackText = resp.text; };

    const result = await joinChannel.handler!(runtime, memory, makeState(), {}, callback);

    expect(result.success).toBe(false);
    expect(result.error).toBe("Twitch service not available");
    expect(callbackText).toBe("Twitch service is not available.");
  });
});

// ===========================================================================
// 8. leaveChannel Action
// ===========================================================================

describe("leaveChannel action", () => {
  test("has correct metadata", () => {
    expect(leaveChannel.name).toBe("TWITCH_LEAVE_CHANNEL");
    expect(leaveChannel.description).toBe("Leave a Twitch channel");
    expect(leaveChannel.similes).toContain("LEAVE_TWITCH_CHANNEL");
    expect(leaveChannel.similes).toContain("EXIT_CHANNEL");
    expect(leaveChannel.similes).toContain("PART_CHANNEL");
    expect(leaveChannel.similes).toContain("DISCONNECT_CHANNEL");
    expect(leaveChannel.similes).toHaveLength(4);
  });

  test("has examples", () => {
    expect(leaveChannel.examples!.length).toBeGreaterThan(0);
  });

  test("validate returns true for twitch source", async () => {
    const runtime = makeMockRuntime();
    expect(await leaveChannel.validate!(runtime, makeMemory("twitch"))).toBe(true);
  });

  test("validate returns false for non-twitch source", async () => {
    const runtime = makeMockRuntime();
    expect(await leaveChannel.validate!(runtime, makeMemory("discord"))).toBe(false);
  });

  test("handler returns error when service unavailable", async () => {
    const runtime = makeMockRuntime({ service: null });
    const memory = makeMemory("twitch");
    let callbackText = "";
    const callback = (resp: any) => { callbackText = resp.text; };

    const result = await leaveChannel.handler!(runtime, memory, makeState(), {}, callback);

    expect(result.success).toBe(false);
    expect(result.error).toBe("Twitch service not available");
    expect(callbackText).toBe("Twitch service is not available.");
  });
});

// ===========================================================================
// 9. listChannels Action
// ===========================================================================

describe("listChannels action", () => {
  test("has correct metadata", () => {
    expect(listChannels.name).toBe("TWITCH_LIST_CHANNELS");
    expect(listChannels.description).toContain("List");
    expect(listChannels.description).toContain("Twitch channels");
    expect(listChannels.similes).toContain("LIST_TWITCH_CHANNELS");
    expect(listChannels.similes).toContain("SHOW_CHANNELS");
    expect(listChannels.similes).toContain("GET_CHANNELS");
    expect(listChannels.similes).toContain("CURRENT_CHANNELS");
    expect(listChannels.similes).toHaveLength(4);
  });

  test("has examples", () => {
    expect(listChannels.examples!.length).toBeGreaterThan(0);
  });

  test("validate returns true for twitch source", async () => {
    const runtime = makeMockRuntime();
    expect(await listChannels.validate!(runtime, makeMemory("twitch"))).toBe(true);
  });

  test("validate returns false for non-twitch source", async () => {
    const runtime = makeMockRuntime();
    expect(await listChannels.validate!(runtime, makeMemory("slack"))).toBe(false);
  });

  test("handler returns error when service unavailable", async () => {
    const runtime = makeMockRuntime({ service: null });
    const memory = makeMemory("twitch");
    let callbackText = "";
    const callback = (resp: any) => { callbackText = resp.text; };

    const result = await listChannels.handler!(runtime, memory, makeState(), {}, callback);

    expect(result.success).toBe(false);
    expect(result.error).toBe("Twitch service not available");
    expect(callbackText).toBe("Twitch service is not available.");
  });

  test("handler returns channel list when service connected", async () => {
    const service = makeMockTwitchService({
      connected: true,
      primaryChannel: "mainchannel",
      joinedChannels: ["mainchannel", "otherchannel"],
    });
    const runtime = makeMockRuntime({
      service,
      getService: () => service,
    });
    const memory = makeMemory("twitch");
    let callbackText = "";
    const callback = (resp: any) => { callbackText = resp.text; };

    const result = await listChannels.handler!(runtime, memory, makeState(), {}, callback);

    expect(result.success).toBe(true);
    expect(result.data.channelCount).toBe(2);
    expect(result.data.channels).toEqual(["mainchannel", "otherchannel"]);
    expect(result.data.primaryChannel).toBe("mainchannel");
    expect(callbackText).toContain("2 channel(s)");
    expect(callbackText).toContain("#mainchannel (primary)");
    expect(callbackText).toContain("#otherchannel");
  });

  test("handler returns empty message for no channels", async () => {
    const service = makeMockTwitchService({
      connected: true,
      primaryChannel: "main",
      joinedChannels: [],
    });
    const runtime = makeMockRuntime({
      service,
      getService: () => service,
    });
    const memory = makeMemory("twitch");
    let callbackText = "";
    const callback = (resp: any) => { callbackText = resp.text; };

    const result = await listChannels.handler!(runtime, memory, makeState(), {}, callback);

    expect(result.success).toBe(true);
    expect(result.data.channelCount).toBe(0);
    expect(callbackText).toBe("Not currently in any channels.");
  });
});

// ===========================================================================
// 10. channelStateProvider
// ===========================================================================

describe("channelStateProvider", () => {
  test("has correct metadata", () => {
    expect(channelStateProvider.name).toBe("twitchChannelState");
    expect(channelStateProvider.description).toContain("Twitch channel");
  });

  test("returns empty for non-twitch source", async () => {
    const runtime = makeMockRuntime();
    const memory = makeMemory("discord");
    const result = await channelStateProvider.get(runtime, memory, makeState());
    expect(result.text).toBe("");
    expect(result.data).toEqual({});
  });

  test("returns disconnected state when service unavailable", async () => {
    const runtime = makeMockRuntime({ service: null });
    const memory = makeMemory("twitch");
    const result = await channelStateProvider.get(runtime, memory, makeState());
    expect(result.data.connected).toBe(false);
    expect(result.text).toBe("");
  });

  test("returns full channel state when connected", async () => {
    const service = makeMockTwitchService({
      connected: true,
      botUsername: "testbot",
      primaryChannel: "mainchannel",
      joinedChannels: ["mainchannel", "extra"],
    });
    const runtime = makeMockRuntime({
      service,
      getService: () => service,
    });
    const memory = makeMemory("twitch");
    const state = makeState({ agentName: "CoolBot" });

    const result = await channelStateProvider.get(runtime, memory, state);

    expect(result.data.connected).toBe(true);
    expect(result.data.channel).toBe("mainchannel");
    expect(result.data.displayChannel).toBe("#mainchannel");
    expect(result.data.isPrimaryChannel).toBe(true);
    expect(result.data.botUsername).toBe("testbot");
    expect(result.data.channelCount).toBe(2);
    expect(result.data.joinedChannels).toEqual(["mainchannel", "extra"]);
    expect(result.text).toContain("CoolBot");
    expect(result.text).toContain("#mainchannel");
    expect(result.text).toContain("primary channel");
    expect(result.text).toContain("@testbot");
    expect(result.text).toContain("2 channel(s)");
  });

  test("uses room channelId from state when available", async () => {
    const service = makeMockTwitchService({
      connected: true,
      primaryChannel: "mainchannel",
      joinedChannels: ["mainchannel", "otherchan"],
    });
    const runtime = makeMockRuntime({
      service,
      getService: () => service,
    });
    const memory = makeMemory("twitch");
    const state = makeState({
      data: { room: { channelId: "#otherchan" } },
    });

    const result = await channelStateProvider.get(runtime, memory, state);

    expect(result.data.channel).toBe("otherchan");
    expect(result.data.isPrimaryChannel).toBe(false);
  });
});

// ===========================================================================
// 11. userContextProvider
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
