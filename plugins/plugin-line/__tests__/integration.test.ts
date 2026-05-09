import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { DEFAULT_ACCOUNT_ID, normalizeAccountId } from "../src/accounts";
import linePlugin, {
  buildLineDeepLink,
  chunkLineText,
  extractCodeBlocks,
  extractLinks,
  extractMarkdownTables,
  formatCodeBlockAsText,
  formatLineUser,
  formatTableAsText,
  getChatId,
  getChatType,
  getChatTypeFromId,
  hasMarkdownContent,
  isGroupChat,
  isValidLineId,
  LINE_SERVICE_NAME,
  LINE_TEXT_CHUNK_LIMIT,
  LineApiError,
  LineConfigurationError,
  LineEventTypes,
  LineService,
  MAX_LINE_BATCH_SIZE,
  markdownToLineChunks,
  normalizeLineTarget,
  processLineMessage,
  resolveLineSystemLocation,
  splitMessageForLine,
  stripMarkdown,
  truncateText,
} from "../src/index";

// ===========================================================================
// Plugin metadata
// ===========================================================================

describe("Plugin metadata", () => {
  it("exports correct plugin name and description", () => {
    expect(linePlugin.name).toBe("line");
    expect(linePlugin.description).toContain("LINE");
  });

  it("does not register legacy LINE message router actions", () => {
    expect(Array.isArray(linePlugin.actions)).toBe(true);
    expect(linePlugin.actions?.length).toBe(0);
  });

  it("uses core platform context providers", () => {
    expect(Array.isArray(linePlugin.providers)).toBe(true);
    expect(linePlugin.providers?.length).toBe(0);
  });

  it("exports services array", () => {
    expect(Array.isArray(linePlugin.services)).toBe(true);
  });

  it("exports all expected components", () => {
    expect(LineService).toBeDefined();
  });
});

// ===========================================================================
// Config validation
// ===========================================================================

describe("Config validation", () => {
  it("defines correct service name constant", () => {
    expect(LINE_SERVICE_NAME).toBe("line");
  });

  it("defines correct batch size constant", () => {
    expect(MAX_LINE_BATCH_SIZE).toBe(5);
  });

  it("defines text chunk limit", () => {
    expect(LINE_TEXT_CHUNK_LIMIT).toBe(5000);
  });

  it("creates LineConfigurationError with field", () => {
    const err = new LineConfigurationError("Token required", "LINE_CHANNEL_ACCESS_TOKEN");
    expect(err.name).toBe("LineConfigurationError");
    expect(err.message).toBe("Token required");
    expect(err.field).toBe("LINE_CHANNEL_ACCESS_TOKEN");
    expect(err instanceof Error).toBe(true);
  });

  it("creates LineConfigurationError without field", () => {
    const err = new LineConfigurationError("General error");
    expect(err.field).toBeUndefined();
  });

  it("creates LineApiError with status code", () => {
    const err = new LineApiError("Not found", 404);
    expect(err.name).toBe("LineApiError");
    expect(err.message).toBe("Not found");
    expect(err.statusCode).toBe(404);
    expect(err instanceof Error).toBe(true);
  });

  it("creates LineApiError without status code", () => {
    const err = new LineApiError("Unknown error");
    expect(err.statusCode).toBeUndefined();
  });
});

// ===========================================================================
// Type utilities (types.ts)
// ===========================================================================

describe("Type utilities", () => {
  describe("isValidLineId", () => {
    it("accepts valid user IDs", () => {
      expect(isValidLineId("U1234567890abcdef1234567890abcdef")).toBe(true);
      expect(isValidLineId("u1234567890abcdef1234567890abcdef")).toBe(true);
    });

    it("accepts valid group IDs", () => {
      expect(isValidLineId("C1234567890abcdef1234567890abcdef")).toBe(true);
      expect(isValidLineId("c1234567890abcdef1234567890abcdef")).toBe(true);
    });

    it("accepts valid room IDs", () => {
      expect(isValidLineId("R1234567890abcdef1234567890abcdef")).toBe(true);
      expect(isValidLineId("r1234567890abcdef1234567890abcdef")).toBe(true);
    });

    it("rejects invalid IDs", () => {
      expect(isValidLineId("")).toBe(false);
      expect(isValidLineId("X12345")).toBe(false);
      expect(isValidLineId("U123")).toBe(false);
      expect(isValidLineId("invalid")).toBe(false);
    });
  });

  describe("normalizeLineTarget", () => {
    it("returns valid IDs unchanged", () => {
      const id = "U1234567890abcdef1234567890abcdef";
      expect(normalizeLineTarget(id)).toBe(id);
    });

    it("trims whitespace", () => {
      const id = "U1234567890abcdef1234567890abcdef";
      expect(normalizeLineTarget(`  ${id}  `)).toBe(id);
    });

    it("returns null for empty strings", () => {
      expect(normalizeLineTarget("")).toBeNull();
      expect(normalizeLineTarget("   ")).toBeNull();
    });

    it("returns null for invalid IDs", () => {
      expect(normalizeLineTarget("invalid_id")).toBeNull();
    });
  });

  describe("getChatTypeFromId", () => {
    it("returns user for U-prefix IDs", () => {
      expect(getChatTypeFromId("U123")).toBe("user");
    });

    it("returns group for C-prefix IDs", () => {
      expect(getChatTypeFromId("C123")).toBe("group");
      expect(getChatTypeFromId("c123")).toBe("group");
    });

    it("returns room for R-prefix IDs", () => {
      expect(getChatTypeFromId("R123")).toBe("room");
      expect(getChatTypeFromId("r123")).toBe("room");
    });

    it("defaults to user for unknown prefixes", () => {
      expect(getChatTypeFromId("X123")).toBe("user");
    });
  });

  describe("splitMessageForLine", () => {
    it("returns single chunk for short messages", () => {
      expect(splitMessageForLine("Hello")).toEqual(["Hello"]);
    });

    it("returns empty array for empty string", () => {
      expect(splitMessageForLine("")).toEqual([]);
    });

    it("returns single chunk at exactly 5000 chars", () => {
      const text = "a".repeat(5000);
      const chunks = splitMessageForLine(text);
      expect(chunks).toHaveLength(1);
    });

    it("splits messages over 5000 chars", () => {
      const text = "a".repeat(6000);
      const chunks = splitMessageForLine(text);
      expect(chunks.length).toBeGreaterThan(1);
      for (const chunk of chunks) {
        expect(chunk.length).toBeLessThanOrEqual(5000);
      }
    });

    it("prefers splitting at newlines", () => {
      const first = "a".repeat(3000);
      const second = "b".repeat(3000);
      const text = `${first}\n${second}`;
      const chunks = splitMessageForLine(text);
      expect(chunks).toHaveLength(2);
    });

    it("prefers splitting at spaces", () => {
      const first = "a".repeat(3000);
      const second = "b".repeat(3000);
      const text = `${first} ${second}`;
      const chunks = splitMessageForLine(text);
      expect(chunks).toHaveLength(2);
    });
  });
});

// ===========================================================================
// Event types
// ===========================================================================

describe("Event types", () => {
  it("defines all expected event type constants", () => {
    expect(LineEventTypes.CONNECTION_READY).toBe("line:connection_ready");
    expect(LineEventTypes.MESSAGE_RECEIVED).toBe("line:message_received");
    expect(LineEventTypes.MESSAGE_SENT).toBe("line:message_sent");
    expect(LineEventTypes.FOLLOW).toBe("line:follow");
    expect(LineEventTypes.UNFOLLOW).toBe("line:unfollow");
    expect(LineEventTypes.JOIN_GROUP).toBe("line:join_group");
    expect(LineEventTypes.LEAVE_GROUP).toBe("line:leave_group");
    expect(LineEventTypes.POSTBACK).toBe("line:postback");
  });

  it("event types are readonly", () => {
    const keys = Object.keys(LineEventTypes);
    expect(keys.length).toBe(8);
  });
});

// ===========================================================================
// Messaging utilities
// ===========================================================================

describe("Messaging utilities", () => {
  describe("chunkLineText", () => {
    it("returns empty array for empty/whitespace text", () => {
      expect(chunkLineText("")).toEqual([]);
      expect(chunkLineText("   ")).toEqual([]);
    });

    it("returns single chunk for short text", () => {
      expect(chunkLineText("Hello")).toEqual(["Hello"]);
    });

    it("respects custom limit", () => {
      const text = "Hello World, this is a test message.";
      const chunks = chunkLineText(text, { limit: 15 });
      expect(chunks.length).toBeGreaterThan(1);
      for (const chunk of chunks) {
        expect(chunk.length).toBeLessThanOrEqual(15);
      }
    });
  });

  describe("extractCodeBlocks", () => {
    it("extracts code blocks with language", () => {
      const text = "Before\n```python\nprint('hello')\n```\nAfter";
      const { codeBlocks, textWithoutCode } = extractCodeBlocks(text);
      expect(codeBlocks).toHaveLength(1);
      expect(codeBlocks[0].language).toBe("python");
      expect(codeBlocks[0].code).toBe("print('hello')");
      expect(textWithoutCode).not.toContain("```");
    });

    it("extracts code blocks without language", () => {
      const text = "```\nsome code\n```";
      const { codeBlocks } = extractCodeBlocks(text);
      expect(codeBlocks).toHaveLength(1);
      expect(codeBlocks[0].language).toBeUndefined();
    });

    it("handles text with no code blocks", () => {
      const text = "No code here";
      const { codeBlocks, textWithoutCode } = extractCodeBlocks(text);
      expect(codeBlocks).toHaveLength(0);
      expect(textWithoutCode).toBe(text);
    });
  });

  describe("extractLinks", () => {
    it("extracts markdown links", () => {
      const text = "Check [this link](https://example.com) out";
      const { links, textWithLinks } = extractLinks(text);
      expect(links).toHaveLength(1);
      expect(links[0].text).toBe("this link");
      expect(links[0].url).toBe("https://example.com");
      expect(textWithLinks).toBe("Check this link out");
    });

    it("handles text with no links", () => {
      const text = "No links here";
      const { links } = extractLinks(text);
      expect(links).toHaveLength(0);
    });
  });

  describe("extractMarkdownTables", () => {
    it("extracts simple tables", () => {
      const text = "Before\n| A | B |\n|---|---|\n| 1 | 2 |\n| 3 | 4 |\nAfter";
      const { tables, textWithoutTables } = extractMarkdownTables(text);
      expect(tables).toHaveLength(1);
      expect(tables[0].headers).toEqual(["A", "B"]);
      expect(tables[0].rows).toHaveLength(2);
      expect(textWithoutTables).not.toContain("|");
    });

    it("handles text with no tables", () => {
      const text = "No tables here";
      const { tables } = extractMarkdownTables(text);
      expect(tables).toHaveLength(0);
    });
  });

  describe("stripMarkdown", () => {
    it("removes bold formatting", () => {
      expect(stripMarkdown("**bold text**")).toBe("bold text");
      expect(stripMarkdown("__bold text__")).toBe("bold text");
    });

    it("removes strikethrough", () => {
      expect(stripMarkdown("~~deleted~~")).toBe("deleted");
    });

    it("removes headers", () => {
      expect(stripMarkdown("# Title")).toBe("Title");
      expect(stripMarkdown("## Subtitle")).toBe("Subtitle");
    });

    it("removes blockquotes", () => {
      expect(stripMarkdown("> quoted text")).toBe("quoted text");
    });

    it("removes inline code", () => {
      expect(stripMarkdown("use `code` here")).toBe("use code here");
    });

    it("preserves plain text", () => {
      expect(stripMarkdown("plain text")).toBe("plain text");
    });
  });

  describe("hasMarkdownContent", () => {
    it("detects bold", () => {
      expect(hasMarkdownContent("**bold**")).toBe(true);
    });

    it("detects headers", () => {
      expect(hasMarkdownContent("# Header")).toBe(true);
    });

    it("detects blockquotes", () => {
      expect(hasMarkdownContent("> quote")).toBe(true);
    });

    it("returns false for plain text", () => {
      expect(hasMarkdownContent("plain text")).toBe(false);
    });
  });

  describe("processLineMessage", () => {
    it("processes text with markdown content", () => {
      const result = processLineMessage("**Hello** [link](https://example.com)");
      expect(result.text).toContain("Hello");
      expect(result.links).toHaveLength(1);
    });

    it("processes plain text", () => {
      const result = processLineMessage("Just plain text");
      expect(result.text).toBe("Just plain text");
      expect(result.tables).toHaveLength(0);
      expect(result.codeBlocks).toHaveLength(0);
    });
  });

  describe("markdownToLineChunks", () => {
    it("processes and chunks markdown", () => {
      const result = markdownToLineChunks("Simple message");
      expect(result.textChunks).toEqual(["Simple message"]);
    });
  });

  describe("formatTableAsText", () => {
    it("formats table with headers and rows", () => {
      const result = formatTableAsText({
        headers: ["Name", "Age"],
        rows: [
          ["Alice", "30"],
          ["Bob", "25"],
        ],
      });
      expect(result).toContain("Name");
      expect(result).toContain("Alice");
      expect(result).toContain("Bob");
    });
  });

  describe("formatCodeBlockAsText", () => {
    it("formats with language label", () => {
      const result = formatCodeBlockAsText({
        language: "python",
        code: "print(1)",
      });
      expect(result).toContain("[python]");
      expect(result).toContain("print(1)");
    });

    it("formats without language", () => {
      const result = formatCodeBlockAsText({ code: "hello" });
      expect(result).toContain("[code]");
    });
  });

  describe("truncateText", () => {
    it("returns text unchanged if within limit", () => {
      expect(truncateText("hello", 10)).toBe("hello");
    });

    it("truncates with ellipsis", () => {
      expect(truncateText("hello world", 8)).toBe("hello...");
    });

    it("handles very short max length", () => {
      expect(truncateText("hello", 3)).toBe("...");
    });
  });

  describe("formatLineUser", () => {
    it("returns display name if provided", () => {
      expect(formatLineUser("Alice", "U123456")).toBe("Alice");
    });

    it("returns fallback with user ID if no display name", () => {
      expect(formatLineUser("", "U1234567890abcdef")).toContain("User(");
      expect(formatLineUser("", "U1234567890abcdef")).toContain("U1234567");
    });
  });

  describe("buildLineDeepLink", () => {
    it("builds deep link URL", () => {
      const link = buildLineDeepLink("user", "U123");
      expect(link).toBe("line://ti/p/U123");
    });
  });

  describe("resolveLineSystemLocation", () => {
    it("formats user chat location", () => {
      const result = resolveLineSystemLocation({
        chatType: "user",
        chatId: "U12345678",
        chatName: "Alice",
      });
      expect(result).toBe("LINE user:Alice");
    });

    it("falls back to truncated chat ID", () => {
      const result = resolveLineSystemLocation({
        chatType: "group",
        chatId: "C1234567890abcdef",
      });
      expect(result).toContain("LINE group:");
    });
  });

  describe("isGroupChat", () => {
    it("returns true for group", () => {
      expect(isGroupChat({ groupId: "C123" })).toBe(true);
    });

    it("returns true for room", () => {
      expect(isGroupChat({ roomId: "R123" })).toBe(true);
    });

    it("returns false for DM", () => {
      expect(isGroupChat({})).toBe(false);
    });
  });

  describe("getChatId", () => {
    it("prefers groupId", () => {
      expect(getChatId({ userId: "U1", groupId: "C1", roomId: "R1" })).toBe("C1");
    });

    it("falls back to roomId", () => {
      expect(getChatId({ userId: "U1", roomId: "R1" })).toBe("R1");
    });

    it("falls back to userId", () => {
      expect(getChatId({ userId: "U1" })).toBe("U1");
    });
  });

  describe("getChatType", () => {
    it("returns group when groupId present", () => {
      expect(getChatType({ groupId: "C1" })).toBe("group");
    });

    it("returns room when roomId present", () => {
      expect(getChatType({ roomId: "R1" })).toBe("room");
    });

    it("returns user when neither present", () => {
      expect(getChatType({})).toBe("user");
    });
  });
});

// ===========================================================================
// Accounts utilities
// ===========================================================================

describe("Accounts utilities", () => {
  it("DEFAULT_ACCOUNT_ID is 'default'", () => {
    expect(DEFAULT_ACCOUNT_ID).toBe("default");
  });

  it("normalizeAccountId returns default for null/undefined", () => {
    expect(normalizeAccountId(null)).toBe("default");
    expect(normalizeAccountId(undefined)).toBe("default");
    expect(normalizeAccountId("")).toBe("default");
  });

  it("normalizeAccountId lowercases and trims", () => {
    expect(normalizeAccountId("  MyAccount  ")).toBe("myaccount");
  });

  it("normalizeAccountId returns default for 'default' input", () => {
    expect(normalizeAccountId("default")).toBe("default");
    expect(normalizeAccountId("DEFAULT")).toBe("default");
  });
});

// ===========================================================================
// Webhook signature validation
// ===========================================================================

describe("Webhook signature validation", () => {
  const channelSecret = "test_channel_secret";

  function computeSignature(body: string, secret: string): string {
    return createHmac("SHA256", secret).update(body).digest("base64");
  }

  it("produces consistent signatures for same input", () => {
    const body = '{"events":[]}';
    const sig1 = computeSignature(body, channelSecret);
    const sig2 = computeSignature(body, channelSecret);
    expect(sig1).toBe(sig2);
  });

  it("produces different signatures for different secrets", () => {
    const body = '{"events":[]}';
    const sig1 = computeSignature(body, channelSecret);
    const sig2 = computeSignature(body, "other_secret");
    expect(sig1).not.toBe(sig2);
  });

  it("produces different signatures for different bodies", () => {
    const sig1 = computeSignature("body1", channelSecret);
    const sig2 = computeSignature("body2", channelSecret);
    expect(sig1).not.toBe(sig2);
  });

  it("signature is non-empty base64", () => {
    const sig = computeSignature("{}", channelSecret);
    expect(sig.length).toBeGreaterThan(0);
    // Base64 chars: A-Z, a-z, 0-9, +, /, =
    expect(sig).toMatch(/^[A-Za-z0-9+/=]+$/);
  });

  it("validates against correct recomputation", () => {
    const body = '{"events":[{"type":"follow"}]}';
    const sig = computeSignature(body, channelSecret);
    const recomputed = computeSignature(body, channelSecret);
    expect(sig).toBe(recomputed);
  });
});

// ===========================================================================
// Webhook event parsing
// ===========================================================================

describe("Webhook event parsing", () => {
  it("parses follow event structure", () => {
    const event = {
      type: "follow",
      timestamp: 1234567890,
      source: { type: "user", userId: "U123" },
      replyToken: "rt1",
    };
    expect(event.type).toBe("follow");
    expect(event.source.userId).toBe("U123");
  });

  it("parses unfollow event structure", () => {
    const event = {
      type: "unfollow",
      timestamp: 1234567890,
      source: { type: "user", userId: "U123" },
    };
    expect(event.type).toBe("unfollow");
  });

  it("parses join event structure", () => {
    const event = {
      type: "join",
      timestamp: 1234567890,
      source: { type: "group", groupId: "C123" },
      replyToken: "rt2",
    };
    expect(event.type).toBe("join");
    expect(event.source.groupId).toBe("C123");
  });

  it("parses leave event structure", () => {
    const event = {
      type: "leave",
      timestamp: 1234567890,
      source: { type: "room", roomId: "R123" },
    };
    expect(event.type).toBe("leave");
    expect(event.source.roomId).toBe("R123");
  });

  it("parses postback event structure", () => {
    const event = {
      type: "postback",
      timestamp: 1234567890,
      source: { type: "user", userId: "U123" },
      replyToken: "rt3",
      postback: { data: "action=buy", params: { date: "2024-01-01" } },
    };
    expect(event.type).toBe("postback");
    expect(event.postback.data).toBe("action=buy");
  });

  it("parses message event structure", () => {
    const event = {
      type: "message",
      timestamp: 1234567890,
      source: { type: "user", userId: "U123" },
      replyToken: "rt4",
      message: { id: "msg1", type: "text", text: "Hello!" },
    };
    expect(event.type).toBe("message");
    expect(event.message.text).toBe("Hello!");
  });

  it("handles multiple events in body", () => {
    const body = {
      events: [
        {
          type: "follow",
          timestamp: 1,
          source: { type: "user", userId: "U1" },
        },
        {
          type: "message",
          timestamp: 2,
          source: { type: "user", userId: "U2" },
          message: { id: "m1", type: "text", text: "Hi" },
        },
      ],
    };
    expect(body.events).toHaveLength(2);
    expect(body.events[0].type).toBe("follow");
    expect(body.events[1].type).toBe("message");
  });
});

// ===========================================================================
// Service lifecycle
// ===========================================================================

describe("Service lifecycle", () => {
  it("has correct static service type", () => {
    expect(LineService.serviceType).toBe("line");
  });

  it("can be constructed without runtime", () => {
    const service = new LineService();
    expect(service.isConnected()).toBe(false);
  });

  it("returns false from isConnected before start", () => {
    const service = new LineService();
    expect(service.isConnected()).toBe(false);
  });

  it("returns null settings before configuration", () => {
    const service = new LineService();
    expect(service.getSettings()).toBeNull();
  });

  it("stop works even when not started", async () => {
    const service = new LineService();
    await service.stop();
    expect(service.isConnected()).toBe(false);
    expect(service.getSettings()).toBeNull();
  });
});
