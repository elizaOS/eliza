import type { IAgentRuntime } from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";
import { normalizeAccountId } from "../src/accounts";
import linePlugin, {
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
  LineApiError,
  LineConfigurationError,
  LineEventTypes,
  LineService,
  markdownToLineChunks,
  normalizeLineTarget,
  processLineMessage,
  resolveLineSystemLocation,
  splitMessageForLine,
  stripMarkdown,
  truncateText,
} from "../src/index";
import { LineWorkflowCredentialProvider } from "../src/workflow-credential-provider";

// ===========================================================================
// Plugin metadata
// ===========================================================================

describe("Plugin metadata", () => {
  it("does not register legacy LINE message router actions", () => {
    expect(Array.isArray(linePlugin.actions)).toBe(true);
    expect(linePlugin.actions?.length).toBe(0);
  });

  it("uses core platform context providers", () => {
    expect(Array.isArray(linePlugin.providers)).toBe(true);
    expect(linePlugin.providers?.length).toBe(0);
  });
});

// ===========================================================================
// Config validation
// ===========================================================================

describe("Config validation", () => {
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
// Webhook handling
// ===========================================================================

describe("Webhook handling", () => {
  function createServiceWithRuntime() {
    const runtime = {
      emitEvent: vi.fn(),
    };
    const service = new LineService();
    (service as unknown as { runtime: typeof runtime }).runtime = runtime;
    return { runtime, service };
  }

  it("emits structured payloads for valid webhook events", async () => {
    const { runtime, service } = createServiceWithRuntime();

    await service.handleWebhookEvents([
      {
        type: "message",
        timestamp: 1234567890,
        source: { type: "group", userId: "U123", groupId: "C123" },
        replyToken: "rt4",
        message: { id: "msg1", type: "text", text: "Hello!" },
      },
      {
        type: "postback",
        timestamp: 1234567891,
        source: { type: "user", userId: "U456" },
        replyToken: "rt3",
        postback: { data: "action=buy", params: { date: "2024-01-01" } },
      },
    ] as Parameters<LineService["handleWebhookEvents"]>[0]);

    expect(runtime.emitEvent).toHaveBeenCalledWith(
      [LineEventTypes.MESSAGE_RECEIVED],
      expect.objectContaining({
        lineSource: expect.objectContaining({ groupId: "C123" }),
        message: expect.objectContaining({
          groupId: "C123",
          id: "msg1",
          text: "Hello!",
          type: "text",
        }),
        replyToken: "rt4",
      })
    );
    expect(runtime.emitEvent).toHaveBeenCalledWith(
      [LineEventTypes.POSTBACK],
      expect.objectContaining({
        data: "action=buy",
        params: { date: "2024-01-01" },
        userId: "U456",
      })
    );
  });

  it("ignores malformed or hostile webhook payloads without emitting", async () => {
    const { runtime, service } = createServiceWithRuntime();

    await service.handleWebhookEvents([
      null,
      { type: "message", timestamp: 1, source: { type: "user", userId: "U1" } },
      { type: "message", timestamp: 1, message: { type: "text", text: "missing id" } },
      { type: "postback", timestamp: 1, postback: null },
      { type: "postback", timestamp: 1, postback: { params: { date: "2024-01-01" } } },
      { type: "unknown", timestamp: 1 },
    ] as Parameters<LineService["handleWebhookEvents"]>[0]);

    expect(runtime.emitEvent).not.toHaveBeenCalled();
  });
});

// ===========================================================================
// Send payload validation
// ===========================================================================

describe("Send payload validation", () => {
  function createServiceWithClient() {
    const client = {
      pushMessage: vi.fn().mockResolvedValue(undefined),
    };
    const service = new LineService();
    (service as unknown as { client: typeof client }).client = client;
    return { client, service };
  }

  it("rejects invalid location coordinates before sending", async () => {
    const { client, service } = createServiceWithClient();

    const result = await service.sendLocationMessage("U1234567890abcdef1234567890abcdef", {
      type: "location",
      title: "Invalid place",
      address: "Unknown",
      latitude: Number.NaN,
      longitude: 139.7454,
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain("latitude");
    expect(client.pushMessage).not.toHaveBeenCalled();
  });

  it("rejects unsafe template URLs before sending", async () => {
    const { client, service } = createServiceWithClient();

    const result = await service.sendTemplateMessage("U1234567890abcdef1234567890abcdef", {
      altText: "Choose",
      template: {
        type: "buttons",
        text: "Pick one",
        thumbnailImageUrl: "javascript:alert(1)",
        actions: [{ type: "uri", label: "Open", uri: "https://example.com" }],
      },
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain("HTTPS");
    expect(client.pushMessage).not.toHaveBeenCalled();
  });

  it("rejects unsafe template URI actions before sending", async () => {
    const { client, service } = createServiceWithClient();

    const result = await service.sendTemplateMessage("U1234567890abcdef1234567890abcdef", {
      altText: "Choose",
      template: {
        type: "confirm",
        text: "Pick one",
        actions: [{ type: "uri", label: "Open", uri: "http://example.com" }],
      },
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain("HTTPS");
    expect(client.pushMessage).not.toHaveBeenCalled();
  });

  it("batches long text sends and attaches quick replies only to the final chunk", async () => {
    const { client, service } = createServiceWithClient();
    const text = "a".repeat(25_001);

    const result = await service.sendMessage("U1234567890abcdef1234567890abcdef", text, {
      quickReplyItems: [
        {
          type: "action",
          action: { type: "message", label: "Yes", text: "yes" },
        },
      ],
    });

    expect(result.success).toBe(true);
    expect(client.pushMessage).toHaveBeenCalledTimes(2);
    expect(client.pushMessage.mock.calls[0][0].messages).toHaveLength(5);
    expect(client.pushMessage.mock.calls[0][0].messages).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ quickReply: expect.anything() })])
    );
    expect(client.pushMessage.mock.calls[1][0].messages).toEqual([
      expect.objectContaining({
        quickReply: {
          items: [
            {
              type: "action",
              action: { type: "message", label: "Yes", text: "yes" },
            },
          ],
        },
      }),
    ]);
  });
});

// ===========================================================================
// Connector registration behavior
// ===========================================================================

describe("Connector registration behavior", () => {
  function registerConnectorWithRooms() {
    const roomA = {
      id: "room-a",
      name: "Line Support",
      source: "line",
      channelId: "C1234567890abcdef1234567890abcdef",
      type: "group",
    };
    const roomB = {
      id: "room-b",
      name: "Personal",
      source: "line",
      channelId: "U1234567890abcdef1234567890abcdef",
      type: "dm",
    };
    const runtime = {
      agentId: "agent-id",
      registerMessageConnector: vi.fn(),
      registerSendHandler: vi.fn(),
      getRoomsForParticipant: vi.fn().mockResolvedValue(["room-a", "room-b", "foreign-room"]),
      getRoom: vi.fn(async (roomId: string) => {
        if (roomId === "room-a") return roomA;
        if (roomId === "room-b") return roomB;
        return {
          id: "foreign-room",
          name: "Other",
          source: "discord",
          channelId: "D123",
          type: "group",
        };
      }),
      getMemories: vi.fn(async ({ roomId }: { roomId: string }) => {
        if (roomId === "room-a") {
          return [
            { id: "newer", content: { text: "incident followup" }, createdAt: 300 },
            { id: "older", content: { text: "hello" }, createdAt: 100 },
          ];
        }
        return [{ id: "dm", content: { text: "private incident" }, createdAt: 200 }];
      }),
    } as unknown as IAgentRuntime;
    const service = Object.create(LineService.prototype) as LineService;
    vi.spyOn(service, "leaveChat").mockResolvedValue(undefined);

    LineService.registerSendHandlers(runtime, service);

    return {
      registration: vi.mocked(runtime.registerMessageConnector).mock.calls[0][0],
      runtime,
      service,
    };
  }

  it("resolves exact LINE IDs ahead of stored rooms and ignores foreign rooms", async () => {
    const { registration, runtime } = registerConnectorWithRooms();

    const targets = await registration.resolveTargets("C1234567890abcdef1234567890abcdef", {
      runtime,
    });

    expect(targets[0]).toEqual(
      expect.objectContaining({
        label: "C1234567890abcdef1234567890abcdef",
        kind: "group",
        score: 1,
      })
    );
    expect(targets).toHaveLength(2);
    expect(targets.map((target) => target.label)).toContain("Line Support");
    expect(targets.map((target) => target.label)).not.toContain("Other");
  });

  it("fetches and searches stored LINE message memories with hostile limits normalized", async () => {
    const { registration, runtime } = registerConnectorWithRooms();

    const fetched = await registration.fetchMessages?.(
      { runtime },
      { limit: Number.POSITIVE_INFINITY }
    );
    const searched = await registration.searchMessages?.(
      { runtime },
      { query: "incident", limit: -1 }
    );

    expect(fetched?.map((memory) => memory.id)).toEqual(["newer", "dm", "older"]);
    expect(searched?.map((memory) => memory.id)).toEqual(["newer", "dm"]);
  });

  it("rejects leave requests for user targets before calling the LINE API", async () => {
    const { registration, runtime, service } = registerConnectorWithRooms();

    await expect(
      registration.leaveHandler?.(runtime, {
        target: { source: "line", channelId: "U1234567890abcdef1234567890abcdef" },
      })
    ).rejects.toThrow("requires a group or room target");
    expect(service.leaveChat).not.toHaveBeenCalled();
  });

  it("resolves leave targets from stored room channel IDs", async () => {
    const { registration, runtime, service } = registerConnectorWithRooms();

    await registration.leaveHandler?.(runtime, {
      target: { source: "line", roomId: "room-a" },
    });

    expect(service.leaveChat).toHaveBeenCalledWith("C1234567890abcdef1234567890abcdef", "group");
  });
});

// ===========================================================================
// Workflow credentials
// ===========================================================================

describe("Workflow credential provider", () => {
  it("returns bearer header credentials for supported workflow credential requests", async () => {
    const runtime = {
      getSetting: vi.fn(() => "  line-token  "),
    } as unknown as IAgentRuntime;
    const provider = new LineWorkflowCredentialProvider(runtime);

    await expect(provider.resolve("user-1", "httpHeaderAuth")).resolves.toEqual({
      status: "credential_data",
      data: { name: "Authorization", value: "Bearer line-token" },
    });
  });

  it("declines unsupported workflow credential types", async () => {
    const runtime = {
      getSetting: vi.fn(() => "line-token"),
    } as unknown as IAgentRuntime;
    const provider = new LineWorkflowCredentialProvider(runtime);

    await expect(provider.resolve("user-1", "oauth2")).resolves.toBeNull();
    expect(runtime.getSetting).not.toHaveBeenCalled();
  });

  it("returns null when runtime credential lookup fails", async () => {
    const runtime = {
      getSetting: vi.fn(() => {
        throw new Error("settings unavailable");
      }),
    } as unknown as IAgentRuntime;
    const provider = new LineWorkflowCredentialProvider(runtime);

    await expect(provider.resolve("user-1", "httpHeaderAuth")).resolves.toBeNull();
  });
});

// ===========================================================================
// Service lifecycle
// ===========================================================================

describe("Service lifecycle", () => {
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
