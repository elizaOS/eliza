import { describe, expect, it, vi, beforeEach } from "vitest";
import tlonPlugin, {
  TlonService,
  sendMessageAction,
  SEND_MESSAGE_ACTION,
  chatStateProvider,
  CHAT_STATE_PROVIDER,
  TLON_SERVICE_NAME,
} from "../src/index.js";
import {
  PLUGIN_NAME,
  PLUGIN_DESCRIPTION,
  PLUGIN_VERSION,
} from "../src/constants.js";
import {
  normalizeShip,
  formatShip,
  parseChannelNest,
  buildChannelNest,
  buildTlonSettings,
  tlonEnvSchema,
} from "../src/environment.js";
import type { TlonEnvConfig } from "../src/environment.js";
import {
  TlonChannelType,
  TlonEventTypes,
} from "../src/types.js";
import type {
  TlonContent,
  TlonShip,
  TlonChat,
  TlonMessagePayload,
  TlonMessageSentPayload,
} from "../src/types.js";
import {
  formatUd,
  unixToUrbitDa,
  generateMessageId,
  extractMessageText,
  buildMediaText,
  isBotMentioned,
  isDmAllowed,
  sendDm,
  sendGroupMessage,
} from "../src/utils.js";
import type { IAgentRuntime, Memory, State } from "@elizaos/core";

// ---------------------------------------------------------------------------
// 1. Plugin metadata
// ---------------------------------------------------------------------------
describe("tlonPlugin", () => {
  it("has the correct name", () => {
    expect(tlonPlugin.name).toBe("tlon");
  });

  it("has a meaningful description", () => {
    expect(tlonPlugin.description).toBe(PLUGIN_DESCRIPTION);
    expect(tlonPlugin.description!.length).toBeGreaterThan(10);
  });

  it("exposes exactly 1 action", () => {
    expect(tlonPlugin.actions).toHaveLength(1);
    expect(tlonPlugin.actions![0]).toBe(sendMessageAction);
  });

  it("exposes exactly 1 provider", () => {
    expect(tlonPlugin.providers).toHaveLength(1);
    expect(tlonPlugin.providers![0]).toBe(chatStateProvider);
  });

  it("registers the TlonService", () => {
    expect(tlonPlugin.services).toHaveLength(1);
    expect(tlonPlugin.services![0]).toBe(TlonService);
  });
});

// ---------------------------------------------------------------------------
// 2. Constants
// ---------------------------------------------------------------------------
describe("constants", () => {
  it("PLUGIN_NAME is 'tlon'", () => {
    expect(PLUGIN_NAME).toBe("tlon");
  });

  it("TLON_SERVICE_NAME is 'tlon'", () => {
    expect(TLON_SERVICE_NAME).toBe("tlon");
  });

  it("PLUGIN_VERSION matches semver pattern", () => {
    expect(PLUGIN_VERSION).toMatch(/^\d+\.\d+\.\d+/);
  });

  it("PLUGIN_DESCRIPTION is not empty", () => {
    expect(PLUGIN_DESCRIPTION.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// 3. sendMessageAction
// ---------------------------------------------------------------------------
describe("sendMessageAction", () => {
  describe("metadata", () => {
    it("has name SEND_TLON_MESSAGE", () => {
      expect(sendMessageAction.name).toBe("SEND_TLON_MESSAGE");
      expect(SEND_MESSAGE_ACTION).toBe("SEND_TLON_MESSAGE");
    });

    it("has a description mentioning Tlon or Urbit", () => {
      expect(sendMessageAction.description).toMatch(/tlon|urbit/i);
    });

    it("has 8 similes covering tlon and urbit aliases", () => {
      expect(sendMessageAction.similes).toHaveLength(8);
      expect(sendMessageAction.similes).toContain("TLON_SEND_MESSAGE");
      expect(sendMessageAction.similes).toContain("URBIT_SEND_MESSAGE");
      expect(sendMessageAction.similes).toContain("SEND_TLON");
      expect(sendMessageAction.similes).toContain("SEND_URBIT");
    });

    it("has at least 2 example conversations", () => {
      expect(sendMessageAction.examples).toBeDefined();
      expect(sendMessageAction.examples!.length).toBeGreaterThanOrEqual(2);
    });
  });

  describe("validate()", () => {
    const makeRuntime = () => ({} as IAgentRuntime);

    it("returns true when source is 'tlon'", async () => {
      const message = {
        content: { text: "hello", source: "tlon" },
      } as unknown as Memory;
      const result = await sendMessageAction.validate!(makeRuntime(), message);
      expect(result).toBe(true);
    });

    it("returns true when source is 'urbit'", async () => {
      const message = {
        content: { text: "hello", source: "urbit" },
      } as unknown as Memory;
      const result = await sendMessageAction.validate!(makeRuntime(), message);
      expect(result).toBe(true);
    });

    it("returns false when source is 'discord'", async () => {
      const message = {
        content: { text: "hello", source: "discord" },
      } as unknown as Memory;
      const result = await sendMessageAction.validate!(makeRuntime(), message);
      expect(result).toBe(false);
    });

    it("returns false when source is undefined", async () => {
      const message = {
        content: { text: "hello" },
      } as unknown as Memory;
      const result = await sendMessageAction.validate!(makeRuntime(), message);
      expect(result).toBe(false);
    });

    it("returns false when content is empty", async () => {
      const message = { content: {} } as unknown as Memory;
      const result = await sendMessageAction.validate!(makeRuntime(), message);
      expect(result).toBe(false);
    });
  });

  describe("handler()", () => {
    it("returns error result when tlon service is not registered", async () => {
      const runtime = {
        getService: vi.fn().mockReturnValue(undefined),
      } as unknown as IAgentRuntime;

      const message = {
        content: { text: "test", source: "tlon" },
      } as unknown as Memory;

      const callback = vi.fn();
      const result = await sendMessageAction.handler(
        runtime,
        message,
        undefined,
        undefined,
        callback,
      );

      expect(result.success).toBe(false);
      expect(result.error).toBe("Tlon service not initialized");
      expect(callback).toHaveBeenCalledWith(
        expect.objectContaining({ text: "Tlon service not available" }),
      );
    });

    it("returns missing-target error when no ship or channel provided", async () => {
      const mockService = {
        sendDirectMessage: vi.fn(),
        sendChannelMessage: vi.fn(),
      };
      const runtime = {
        getService: vi.fn().mockReturnValue(mockService),
      } as unknown as IAgentRuntime;

      const message = {
        content: { text: "test", source: "tlon" } as TlonContent,
      } as unknown as Memory;

      const callback = vi.fn();
      const result = await sendMessageAction.handler(
        runtime,
        message,
        undefined,
        undefined,
        callback,
      );

      expect(result.success).toBe(false);
      expect(result.error).toBe("Missing target ship or channel");
      expect(callback).toHaveBeenCalledWith(
        expect.objectContaining({ text: "No target ship or channel specified" }),
      );
    });

    it("sends a DM when ship is set and channelNest is absent", async () => {
      const mockService = {
        sendDirectMessage: vi.fn().mockResolvedValue({ messageId: "test-id" }),
        sendChannelMessage: vi.fn(),
      };
      const runtime = {
        getService: vi.fn().mockReturnValue(mockService),
      } as unknown as IAgentRuntime;

      const message = {
        content: { text: "test", source: "tlon", ship: "sampel-palnet" } as TlonContent,
      } as unknown as Memory;

      const state = { values: { response: "Hello there" } } as unknown as State;
      const callback = vi.fn();
      const result = await sendMessageAction.handler(
        runtime,
        message,
        state,
        undefined,
        callback,
      );

      expect(result.success).toBe(true);
      expect(mockService.sendDirectMessage).toHaveBeenCalledWith("sampel-palnet", "Hello there");
      expect(mockService.sendChannelMessage).not.toHaveBeenCalled();
    });

    it("sends a channel message when channelNest includes a slash", async () => {
      const mockService = {
        sendDirectMessage: vi.fn(),
        sendChannelMessage: vi.fn().mockResolvedValue({ messageId: "ch-id" }),
      };
      const runtime = {
        getService: vi.fn().mockReturnValue(mockService),
      } as unknown as IAgentRuntime;

      const message = {
        content: {
          text: "test",
          source: "tlon",
          channelNest: "chat/~host/channel",
          ship: "sampel-palnet",
        } as TlonContent,
      } as unknown as Memory;

      const state = { values: { response: "Reply text" } } as unknown as State;
      const callback = vi.fn();
      const result = await sendMessageAction.handler(
        runtime,
        message,
        state,
        undefined,
        callback,
      );

      expect(result.success).toBe(true);
      expect(mockService.sendChannelMessage).toHaveBeenCalledWith(
        "chat/~host/channel",
        "Reply text",
        undefined,
      );
      expect(mockService.sendDirectMessage).not.toHaveBeenCalled();
    });

    it("forwards replyToId for thread replies", async () => {
      const mockService = {
        sendDirectMessage: vi.fn(),
        sendChannelMessage: vi.fn().mockResolvedValue({ messageId: "th-id" }),
      };
      const runtime = {
        getService: vi.fn().mockReturnValue(mockService),
      } as unknown as IAgentRuntime;

      const message = {
        content: {
          text: "test",
          source: "tlon",
          channelNest: "chat/~host/channel",
          replyToId: "parent-123",
        } as TlonContent,
      } as unknown as Memory;

      const state = { values: { response: "Thread reply" } } as unknown as State;
      const result = await sendMessageAction.handler(runtime, message, state);

      expect(result.success).toBe(true);
      expect(mockService.sendChannelMessage).toHaveBeenCalledWith(
        "chat/~host/channel",
        "Thread reply",
        "parent-123",
      );
    });

    it("returns error result and calls callback when sendChannelMessage throws", async () => {
      const mockService = {
        sendDirectMessage: vi.fn(),
        sendChannelMessage: vi.fn().mockRejectedValue(new Error("Network error")),
      };
      const runtime = {
        getService: vi.fn().mockReturnValue(mockService),
      } as unknown as IAgentRuntime;

      const message = {
        content: {
          text: "test",
          source: "tlon",
          channelNest: "chat/~host/channel",
        } as TlonContent,
      } as unknown as Memory;

      const callback = vi.fn();
      const result = await sendMessageAction.handler(
        runtime,
        message,
        undefined,
        undefined,
        callback,
      );

      expect(result.success).toBe(false);
      expect(result.error).toBe("Network error");
      expect(callback).toHaveBeenCalledWith(
        expect.objectContaining({
          text: expect.stringContaining("Failed to send message: Network error"),
        }),
      );
    });
  });
});

// ---------------------------------------------------------------------------
// 4. chatStateProvider
// ---------------------------------------------------------------------------
describe("chatStateProvider", () => {
  describe("metadata", () => {
    it("has the correct name", () => {
      expect(chatStateProvider.name).toBe("tlon_chat_state");
      expect(CHAT_STATE_PROVIDER).toBe("tlon_chat_state");
    });

    it("has a non-empty description", () => {
      expect(chatStateProvider.description!.length).toBeGreaterThan(10);
    });

    it("is marked as dynamic", () => {
      expect(chatStateProvider.dynamic).toBe(true);
    });
  });

  describe("get()", () => {
    const makeRuntime = () => ({} as IAgentRuntime);
    const makeState = () => ({} as State);

    it("returns DM type when no channelNest is present", async () => {
      const message = {
        content: { ship: "sampel-palnet" } as TlonContent,
        roomId: "room-1",
      } as unknown as Memory;

      const result = await chatStateProvider.get!(makeRuntime(), message, makeState());
      expect(result.data.chatType).toBe("dm");
      expect(result.data.isDm).toBe(true);
      expect(result.data.isGroup).toBe(false);
      expect(result.data.isThread).toBe(false);
      expect(result.values.ship).toBe("sampel-palnet");
      expect(result.text).toContain("Ship: ~sampel-palnet");
    });

    it("returns GROUP type when channelNest contains a slash", async () => {
      const message = {
        content: {
          ship: "sampel-palnet",
          channelNest: "chat/~host/general",
        } as TlonContent,
        roomId: "room-2",
      } as unknown as Memory;

      const result = await chatStateProvider.get!(makeRuntime(), message, makeState());
      expect(result.data.chatType).toBe("group");
      expect(result.data.isGroup).toBe(true);
      expect(result.data.isDm).toBe(false);
      expect(result.values.channel_nest).toBe("chat/~host/general");
      expect(result.text).toContain("Channel: chat/~host/general");
      expect(result.text).toContain("Chat Type: group");
    });

    it("returns THREAD type when channelNest and replyToId are present", async () => {
      const message = {
        content: {
          ship: "sampel-palnet",
          channelNest: "chat/~host/general",
          replyToId: "msg-parent",
        } as TlonContent,
        roomId: "room-3",
      } as unknown as Memory;

      const result = await chatStateProvider.get!(makeRuntime(), message, makeState());
      expect(result.data.chatType).toBe("thread");
      expect(result.data.isThread).toBe(true);
      expect(result.data.isDm).toBe(false);
      expect(result.data.isGroup).toBe(false);
      expect(result.values.reply_to_id).toBe("msg-parent");
      expect(result.text).toContain("Reply To: msg-parent");
    });

    it("returns empty strings in values when fields are missing", async () => {
      const message = {
        content: {} as TlonContent,
        roomId: "",
      } as unknown as Memory;

      const result = await chatStateProvider.get!(makeRuntime(), message, makeState());
      expect(result.values.ship).toBe("");
      expect(result.values.channel_nest).toBe("");
      expect(result.values.reply_to_id).toBe("");
      expect(result.data.chatType).toBe("dm"); // default
    });
  });
});

// ---------------------------------------------------------------------------
// 5. Environment / config helpers
// ---------------------------------------------------------------------------
describe("environment", () => {
  describe("normalizeShip()", () => {
    it("strips ~ prefix", () => {
      expect(normalizeShip("~sampel-palnet")).toBe("sampel-palnet");
    });

    it("returns name unchanged when no ~ present", () => {
      expect(normalizeShip("sampel-palnet")).toBe("sampel-palnet");
    });

    it("returns empty string unchanged", () => {
      expect(normalizeShip("")).toBe("");
    });
  });

  describe("formatShip()", () => {
    it("adds ~ prefix to bare name", () => {
      expect(formatShip("sampel-palnet")).toBe("~sampel-palnet");
    });

    it("does not double the ~ prefix", () => {
      expect(formatShip("~sampel-palnet")).toBe("~sampel-palnet");
    });
  });

  describe("parseChannelNest()", () => {
    it("parses valid nest into kind/host/name", () => {
      const result = parseChannelNest("chat/~host-ship/channel-name");
      expect(result).not.toBeNull();
      expect(result!.kind).toBe("chat");
      expect(result!.hostShip).toBe("host-ship");
      expect(result!.channelName).toBe("channel-name");
    });

    it("returns null for invalid nest with too few parts", () => {
      expect(parseChannelNest("only-one")).toBeNull();
      expect(parseChannelNest("only/two")).toBeNull();
    });

    it("returns null for nest with too many parts", () => {
      expect(parseChannelNest("a/b/c/d")).toBeNull();
    });

    it("normalizes the host ship (strips ~)", () => {
      const result = parseChannelNest("diary/~my-ship/notes");
      expect(result!.hostShip).toBe("my-ship");
    });
  });

  describe("buildChannelNest()", () => {
    it("constructs nest string with formatted host ship", () => {
      expect(buildChannelNest("chat", "host-ship", "general")).toBe(
        "chat/~host-ship/general",
      );
    });

    it("does not double ~ on already-prefixed host", () => {
      expect(buildChannelNest("chat", "~host-ship", "general")).toBe(
        "chat/~host-ship/general",
      );
    });
  });

  describe("buildTlonSettings()", () => {
    it("normalizes ship and strips trailing slash from url", () => {
      const config: TlonEnvConfig = {
        TLON_SHIP: "~my-ship",
        TLON_URL: "https://my-ship.tlon.network/",
        TLON_CODE: "secret-code",
        TLON_ENABLED: true,
        TLON_GROUP_CHANNELS: undefined,
        TLON_DM_ALLOWLIST: undefined,
        TLON_AUTO_DISCOVER_CHANNELS: true,
      };

      const settings = buildTlonSettings(config);
      expect(settings.ship).toBe("my-ship");
      expect(settings.url).toBe("https://my-ship.tlon.network");
      expect(settings.code).toBe("secret-code");
      expect(settings.enabled).toBe(true);
      expect(settings.autoDiscoverChannels).toBe(true);
    });

    it("parses group channels from JSON array", () => {
      const config: TlonEnvConfig = {
        TLON_SHIP: "my-ship",
        TLON_URL: "https://example.com",
        TLON_CODE: "code",
        TLON_ENABLED: true,
        TLON_GROUP_CHANNELS: '["chat/~host/general","chat/~host/random"]',
        TLON_DM_ALLOWLIST: undefined,
        TLON_AUTO_DISCOVER_CHANNELS: false,
      };

      const settings = buildTlonSettings(config);
      expect(settings.groupChannels).toEqual([
        "chat/~host/general",
        "chat/~host/random",
      ]);
      expect(settings.autoDiscoverChannels).toBe(false);
    });

    it("parses dm allowlist and normalizes ship names", () => {
      const config: TlonEnvConfig = {
        TLON_SHIP: "my-ship",
        TLON_URL: "https://example.com",
        TLON_CODE: "code",
        TLON_ENABLED: true,
        TLON_GROUP_CHANNELS: undefined,
        TLON_DM_ALLOWLIST: '["~allowed-ship","another-ship"]',
        TLON_AUTO_DISCOVER_CHANNELS: true,
      };

      const settings = buildTlonSettings(config);
      expect(settings.dmAllowlist).toEqual(["allowed-ship", "another-ship"]);
    });

    it("returns empty arrays for invalid JSON in channels/allowlist", () => {
      const config: TlonEnvConfig = {
        TLON_SHIP: "my-ship",
        TLON_URL: "https://example.com",
        TLON_CODE: "code",
        TLON_ENABLED: true,
        TLON_GROUP_CHANNELS: "not-json",
        TLON_DM_ALLOWLIST: "{bad",
        TLON_AUTO_DISCOVER_CHANNELS: true,
      };

      const settings = buildTlonSettings(config);
      expect(settings.groupChannels).toEqual([]);
      expect(settings.dmAllowlist).toEqual([]);
    });
  });

  describe("tlonEnvSchema validation", () => {
    it("parses valid config", () => {
      const result = tlonEnvSchema.safeParse({
        TLON_SHIP: "sampel-palnet",
        TLON_URL: "https://example.com",
        TLON_CODE: "lidlut-tabwed",
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.TLON_ENABLED).toBe(true); // default
        expect(result.data.TLON_AUTO_DISCOVER_CHANNELS).toBe(true); // default
      }
    });

    it("rejects missing TLON_SHIP", () => {
      const result = tlonEnvSchema.safeParse({
        TLON_URL: "https://example.com",
        TLON_CODE: "code",
      });
      expect(result.success).toBe(false);
    });

    it("rejects invalid URL", () => {
      const result = tlonEnvSchema.safeParse({
        TLON_SHIP: "ship",
        TLON_URL: "not-a-url",
        TLON_CODE: "code",
      });
      expect(result.success).toBe(false);
    });

    it("rejects empty TLON_CODE", () => {
      const result = tlonEnvSchema.safeParse({
        TLON_SHIP: "ship",
        TLON_URL: "https://example.com",
        TLON_CODE: "",
      });
      expect(result.success).toBe(false);
    });
  });
});

// ---------------------------------------------------------------------------
// 6. Types
// ---------------------------------------------------------------------------
describe("types", () => {
  describe("TlonChannelType", () => {
    it("has DM, GROUP, and THREAD values", () => {
      expect(TlonChannelType.DM).toBe("dm");
      expect(TlonChannelType.GROUP).toBe("group");
      expect(TlonChannelType.THREAD).toBe("thread");
    });

    it("has exactly 3 members", () => {
      const values = Object.values(TlonChannelType);
      expect(values).toHaveLength(3);
    });
  });

  describe("TlonEventTypes", () => {
    it("prefixes all event types with TLON_", () => {
      const values = Object.values(TlonEventTypes);
      for (const v of values) {
        expect(v).toMatch(/^TLON_/);
      }
    });

    it("includes all expected event types", () => {
      expect(TlonEventTypes.MESSAGE_RECEIVED).toBe("TLON_MESSAGE_RECEIVED");
      expect(TlonEventTypes.MESSAGE_SENT).toBe("TLON_MESSAGE_SENT");
      expect(TlonEventTypes.DM_RECEIVED).toBe("TLON_DM_RECEIVED");
      expect(TlonEventTypes.GROUP_MESSAGE_RECEIVED).toBe("TLON_GROUP_MESSAGE_RECEIVED");
      expect(TlonEventTypes.WORLD_JOINED).toBe("TLON_WORLD_JOINED");
      expect(TlonEventTypes.WORLD_CONNECTED).toBe("TLON_WORLD_CONNECTED");
      expect(TlonEventTypes.WORLD_LEFT).toBe("TLON_WORLD_LEFT");
      expect(TlonEventTypes.CONNECTION_ERROR).toBe("TLON_CONNECTION_ERROR");
      expect(TlonEventTypes.RECONNECTED).toBe("TLON_RECONNECTED");
    });

    it("has 11 members", () => {
      expect(Object.values(TlonEventTypes)).toHaveLength(11);
    });
  });
});

// ---------------------------------------------------------------------------
// 7. Utility functions
// ---------------------------------------------------------------------------
describe("utils", () => {
  describe("formatUd()", () => {
    it("formats small numbers without dots", () => {
      expect(formatUd(0n)).toBe("0");
      expect(formatUd(123n)).toBe("123");
    });

    it("inserts dots every 3 digits from the right", () => {
      expect(formatUd(1234n)).toBe("1.234");
      expect(formatUd(1234567n)).toBe("1.234.567");
      expect(formatUd(1000000n)).toBe("1.000.000");
    });

    it("handles exact 3-digit boundary", () => {
      expect(formatUd(999n)).toBe("999");
      expect(formatUd(1000n)).toBe("1.000");
    });
  });

  describe("unixToUrbitDa()", () => {
    it("returns a bigint greater than the urbit epoch offset for any positive timestamp", () => {
      const da = unixToUrbitDa(1000);
      expect(da).toBeGreaterThan(0n);
    });

    it("produces monotonically increasing values for increasing timestamps", () => {
      const da1 = unixToUrbitDa(1000);
      const da2 = unixToUrbitDa(2000);
      const da3 = unixToUrbitDa(3000);
      expect(da2).toBeGreaterThan(da1);
      expect(da3).toBeGreaterThan(da2);
    });
  });

  describe("generateMessageId()", () => {
    it("starts with ~ship/ prefix", () => {
      const id = generateMessageId("sampel-palnet", Date.now());
      expect(id).toMatch(/^~sampel-palnet\//);
    });

    it("contains dotted @ud after the slash", () => {
      const id = generateMessageId("zod", 1700000000000);
      const parts = id.split("/");
      expect(parts).toHaveLength(2);
      // The @ud part should contain dots for large numbers
      expect(parts[1].length).toBeGreaterThan(0);
    });
  });

  describe("extractMessageText()", () => {
    it("returns empty string for null/undefined", () => {
      expect(extractMessageText(null)).toBe("");
      expect(extractMessageText(undefined)).toBe("");
    });

    it("extracts text from simple inline story", () => {
      const story = [{ inline: ["Hello world"] }];
      expect(extractMessageText(story)).toBe("Hello world");
    });

    it("extracts text from story with multiple verses", () => {
      const story = [
        { inline: ["First line"] },
        { inline: ["Second line"] },
      ];
      expect(extractMessageText(story)).toBe("First line\nSecond line");
    });

    it("extracts ship mentions with ~ prefix", () => {
      const story = [{ inline: [{ ship: "sampel-palnet" }] }];
      expect(extractMessageText(story)).toBe("~sampel-palnet");
    });

    it("formats links as markdown", () => {
      const story = [
        { inline: [{ link: { href: "https://example.com", content: "Click here" } }] },
      ];
      expect(extractMessageText(story)).toBe("[Click here](https://example.com)");
    });

    it("wraps inline code in backticks", () => {
      const story = [{ inline: [{ code: "const x = 1" }] }];
      expect(extractMessageText(story)).toBe("`const x = 1`");
    });

    it("formats code blocks with triple backticks", () => {
      const story = [
        {
          block: {
            code: { code: "fn main() {}", lang: "rust" },
          },
        },
      ];
      const text = extractMessageText(story);
      expect(text).toContain("```rust");
      expect(text).toContain("fn main() {}");
    });

    it("formats images with alt text", () => {
      const story = [
        {
          block: {
            image: { src: "https://img.com/pic.png", alt: "A picture" },
          },
        },
      ];
      expect(extractMessageText(story)).toBe("[Image: A picture]");
    });

    it("falls back to image src when no alt text", () => {
      const story = [
        {
          block: {
            image: { src: "https://img.com/pic.png" },
          },
        },
      ];
      expect(extractMessageText(story)).toBe("[Image: https://img.com/pic.png]");
    });

    it("returns string content directly", () => {
      expect(extractMessageText("plain text")).toBe("plain text");
    });

    it("handles mixed inline content", () => {
      const story = [
        {
          inline: [
            "Hello ",
            { bold: ["world"] },
            " from ",
            { italic: ["Urbit"] },
          ],
        },
      ];
      const result = extractMessageText(story);
      expect(result).toContain("Hello ");
      expect(result).toContain("world");
      expect(result).toContain("Urbit");
    });

    it("extracts blockquote text", () => {
      const story = [{ inline: [{ blockquote: ["quoted text"] }] }];
      expect(extractMessageText(story)).toBe("> quoted text");
    });
  });

  describe("buildMediaText()", () => {
    it("combines text and media url with newline", () => {
      expect(buildMediaText("Hello", "https://img.com/a.png")).toBe(
        "Hello\nhttps://img.com/a.png",
      );
    });

    it("returns just the url when text is empty", () => {
      expect(buildMediaText("", "https://img.com/a.png")).toBe("https://img.com/a.png");
    });

    it("returns just the url when text is undefined", () => {
      expect(buildMediaText(undefined, "https://img.com/a.png")).toBe(
        "https://img.com/a.png",
      );
    });

    it("returns just the text when media is undefined", () => {
      expect(buildMediaText("Hello", undefined)).toBe("Hello");
    });

    it("returns empty string when both are empty", () => {
      expect(buildMediaText("", "")).toBe("");
    });

    it("trims whitespace from both inputs", () => {
      expect(buildMediaText("  Hello  ", "  https://url.com  ")).toBe(
        "Hello\nhttps://url.com",
      );
    });
  });

  describe("isBotMentioned()", () => {
    it("detects ~ship mention", () => {
      expect(isBotMentioned("Hello ~sampel-palnet how are you?", "sampel-palnet")).toBe(
        true,
      );
    });

    it("detects @ship mention", () => {
      expect(isBotMentioned("Hey @sampel-palnet", "sampel-palnet")).toBe(true);
    });

    it("detects bare ship name mention", () => {
      expect(isBotMentioned("sampel-palnet said hello", "sampel-palnet")).toBe(true);
    });

    it("handles ~ prefix in botShip argument", () => {
      expect(isBotMentioned("Hello ~myship", "~myship")).toBe(true);
    });

    it("returns false when ship is not mentioned", () => {
      expect(isBotMentioned("Hello world", "sampel-palnet")).toBe(false);
    });
  });

  describe("isDmAllowed()", () => {
    it("allows any ship when allowlist is empty", () => {
      expect(isDmAllowed("any-ship", [])).toBe(true);
    });

    it("allows a ship in the allowlist", () => {
      expect(isDmAllowed("good-ship", ["good-ship", "other-ship"])).toBe(true);
    });

    it("blocks a ship not in the allowlist", () => {
      expect(isDmAllowed("bad-ship", ["good-ship"])).toBe(false);
    });

    it("normalizes ~ prefix when checking", () => {
      expect(isDmAllowed("~good-ship", ["good-ship"])).toBe(true);
      expect(isDmAllowed("good-ship", ["~good-ship"])).toBe(true);
    });
  });

  describe("sendDm()", () => {
    it("pokes the chat app with correct mark and structure", async () => {
      const pokeFn = vi.fn().mockResolvedValue(undefined);
      const api = { poke: pokeFn };

      const result = await sendDm({
        api,
        fromShip: "my-ship",
        toShip: "their-ship",
        text: "Hello",
      });

      expect(pokeFn).toHaveBeenCalledTimes(1);
      const callArgs = pokeFn.mock.calls[0][0];
      expect(callArgs.app).toBe("chat");
      expect(callArgs.mark).toBe("chat-dm-action");
      expect(callArgs.json.ship).toBe("~their-ship");
      expect(callArgs.json.diff.delta.add.memo.content[0].inline[0]).toBe("Hello");
      expect(callArgs.json.diff.delta.add.memo.author).toBe("~my-ship");
      expect(result.messageId).toContain("~my-ship/");
      expect(result.channel).toBe("tlon");
    });
  });

  describe("sendGroupMessage()", () => {
    it("sends a regular post without replyToId", async () => {
      const pokeFn = vi.fn().mockResolvedValue(undefined);
      const api = { poke: pokeFn };

      const result = await sendGroupMessage({
        api,
        fromShip: "my-ship",
        hostShip: "host-ship",
        channelName: "general",
        text: "Channel message",
      });

      expect(pokeFn).toHaveBeenCalledTimes(1);
      const callArgs = pokeFn.mock.calls[0][0];
      expect(callArgs.app).toBe("channels");
      expect(callArgs.mark).toBe("channel-action-1");
      expect(callArgs.json.channel.nest).toBe("chat/~host-ship/general");
      expect(callArgs.json.channel.action.post.add).toBeDefined();
      expect(callArgs.json.channel.action.post.add.content[0].inline[0]).toBe(
        "Channel message",
      );
      expect(callArgs.json.channel.action.post.add.kind).toBe("/chat");
      expect(result.messageId).toContain("~my-ship/");
    });

    it("sends a thread reply when replyToId is provided", async () => {
      const pokeFn = vi.fn().mockResolvedValue(undefined);
      const api = { poke: pokeFn };

      await sendGroupMessage({
        api,
        fromShip: "my-ship",
        hostShip: "host-ship",
        channelName: "general",
        text: "Thread reply",
        replyToId: "parent-id-123",
      });

      const callArgs = pokeFn.mock.calls[0][0];
      expect(callArgs.json.channel.action.post.reply).toBeDefined();
      expect(callArgs.json.channel.action.post.reply.id).toBe("parent-id-123");
      expect(callArgs.json.channel.action.post.reply.action.add.content[0].inline[0]).toBe(
        "Thread reply",
      );
    });

    it("formats numeric replyToId as dotted @ud", async () => {
      const pokeFn = vi.fn().mockResolvedValue(undefined);
      const api = { poke: pokeFn };

      await sendGroupMessage({
        api,
        fromShip: "my-ship",
        hostShip: "host-ship",
        channelName: "general",
        text: "Reply",
        replyToId: "1234567",
      });

      const callArgs = pokeFn.mock.calls[0][0];
      // numeric ID should be formatted with dots
      expect(callArgs.json.channel.action.post.reply.id).toBe("1.234.567");
    });
  });
});
