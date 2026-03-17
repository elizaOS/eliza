import type { IAgentRuntime, Memory, State, UUID } from "@elizaos/core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { farcasterActions } from "../actions";
import { replyCastAction } from "../actions/replyCast";
import { sendCastAction } from "../actions/sendCast";
import { farcasterPlugin } from "../index";
import { farcasterProviders } from "../providers";
import { farcasterProfileProvider } from "../providers/profileProvider";
import { farcasterThreadProvider } from "../providers/threadProvider";
import { farcasterTimelineProvider } from "../providers/timelineProvider";
import {
  DEFAULT_MAX_CAST_LENGTH,
  DEFAULT_POLL_INTERVAL,
  FARCASTER_SERVICE_NAME,
  FARCASTER_SOURCE,
  FarcasterConfigSchema,
  FarcasterEventTypes,
  FarcasterMessageType,
} from "../types";
import { formatCastTimestamp, splitParagraph, splitPostContent } from "../utils";
import { formatCast, formatTimeline } from "../utils/prompts";

// ---------------------------------------------------------------------------
// Helpers – lightweight stubs that satisfy the interfaces without credentials
// ---------------------------------------------------------------------------

function createMockRuntime(settings: Record<string, string> = {}): IAgentRuntime {
  return {
    agentId: "00000000-0000-0000-0000-000000000001" as UUID,
    getSetting: (key: string) => settings[key] ?? null,
    getService: () => null,
    logger: {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      success: vi.fn(),
    },
    useModel: vi.fn(async () => "Generated text for Farcaster"),
    createMemory: vi.fn(async () => undefined),
  } as Partial<IAgentRuntime> as IAgentRuntime;
}

function createMessage(text: string, metadata?: Record<string, string>): Memory {
  return {
    id: "00000000-0000-0000-0000-000000000010" as UUID,
    agentId: "00000000-0000-0000-0000-000000000001" as UUID,
    entityId: "00000000-0000-0000-0000-000000000002" as UUID,
    roomId: "00000000-0000-0000-0000-000000000099" as UUID,
    content: { text, source: "farcaster", metadata },
  } as Memory;
}

// ═══════════════════════════════════════════════════════════════════════════
// 1. Plugin Structure
// ═══════════════════════════════════════════════════════════════════════════

describe("Farcaster Plugin", () => {
  describe("Plugin Structure", () => {
    it("should export a valid plugin with name", () => {
      expect(farcasterPlugin).toBeDefined();
      expect(farcasterPlugin.name).toBe("farcaster");
    });

    it("should have a description", () => {
      expect(farcasterPlugin.description).toBeDefined();
      expect(typeof farcasterPlugin.description).toBe("string");
      expect(farcasterPlugin.description!.length).toBeGreaterThan(0);
    });

    it("should have services array", () => {
      expect(farcasterPlugin.services).toBeDefined();
      expect(Array.isArray(farcasterPlugin.services)).toBe(true);
      expect(farcasterPlugin.services!.length).toBeGreaterThan(0);
    });

    it("should register actions", () => {
      expect(farcasterPlugin.actions).toBeDefined();
      expect(Array.isArray(farcasterPlugin.actions)).toBe(true);
      expect(farcasterPlugin.actions!.length).toBe(2);
    });

    it("should register providers", () => {
      expect(farcasterPlugin.providers).toBeDefined();
      expect(Array.isArray(farcasterPlugin.providers)).toBe(true);
      expect(farcasterPlugin.providers!.length).toBe(3);
    });

    it("should have routes", () => {
      expect(farcasterPlugin.routes).toBeDefined();
    });
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 2. Config Validation (FarcasterConfigSchema / zod)
// ═══════════════════════════════════════════════════════════════════════════

describe("Config Validation", () => {
  const validConfig = {
    FARCASTER_DRY_RUN: true,
    FARCASTER_FID: 12345,
    MAX_CAST_LENGTH: 320,
    FARCASTER_POLL_INTERVAL: 120,
    FARCASTER_MODE: "polling" as const,
    ENABLE_CAST: true,
    CAST_INTERVAL_MIN: 90,
    CAST_INTERVAL_MAX: 180,
    ENABLE_ACTION_PROCESSING: false,
    ACTION_INTERVAL: 5,
    CAST_IMMEDIATELY: false,
    MAX_ACTIONS_PROCESSING: 1,
    FARCASTER_SIGNER_UUID: "test-signer-uuid",
    FARCASTER_NEYNAR_API_KEY: "test-api-key",
    FARCASTER_HUB_URL: "hub.pinata.cloud",
  };

  it("should accept a valid config", () => {
    const result = FarcasterConfigSchema.safeParse(validConfig);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.FARCASTER_FID).toBe(12345);
      expect(result.data.FARCASTER_SIGNER_UUID).toBe("test-signer-uuid");
    }
  });

  it("should reject config with missing FID", () => {
    const { FARCASTER_FID: _, ...noFid } = validConfig;
    const result = FarcasterConfigSchema.safeParse(noFid);
    expect(result.success).toBe(false);
  });

  it("should reject config with FID = 0", () => {
    const result = FarcasterConfigSchema.safeParse({
      ...validConfig,
      FARCASTER_FID: 0,
    });
    expect(result.success).toBe(false);
  });

  it("should reject config with missing signer UUID", () => {
    const result = FarcasterConfigSchema.safeParse({
      ...validConfig,
      FARCASTER_SIGNER_UUID: "",
    });
    expect(result.success).toBe(false);
  });

  it("should reject config with missing API key", () => {
    const result = FarcasterConfigSchema.safeParse({
      ...validConfig,
      FARCASTER_NEYNAR_API_KEY: "",
    });
    expect(result.success).toBe(false);
  });

  it("should coerce string booleans for FARCASTER_DRY_RUN", () => {
    const result = FarcasterConfigSchema.safeParse({
      ...validConfig,
      FARCASTER_DRY_RUN: "true",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.FARCASTER_DRY_RUN).toBe(true);
    }
  });

  it("should default FARCASTER_MODE to polling", () => {
    const { FARCASTER_MODE: _, ...noMode } = validConfig;
    const result = FarcasterConfigSchema.safeParse(noMode);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.FARCASTER_MODE).toBe("polling");
    }
  });

  it("should accept webhook mode", () => {
    const result = FarcasterConfigSchema.safeParse({
      ...validConfig,
      FARCASTER_MODE: "webhook",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.FARCASTER_MODE).toBe("webhook");
    }
  });

  it("should reject invalid mode", () => {
    const result = FarcasterConfigSchema.safeParse({
      ...validConfig,
      FARCASTER_MODE: "invalid_mode",
    });
    expect(result.success).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 3. Type Constants
// ═══════════════════════════════════════════════════════════════════════════

describe("Type Constants", () => {
  it("should export correct service name", () => {
    expect(FARCASTER_SERVICE_NAME).toBe("farcaster");
  });

  it("should export correct source constant", () => {
    expect(FARCASTER_SOURCE).toBe("farcaster");
  });

  it("should export default constants", () => {
    expect(DEFAULT_MAX_CAST_LENGTH).toBe(320);
    expect(DEFAULT_POLL_INTERVAL).toBe(120);
  });

  it("should define message types", () => {
    expect(FarcasterMessageType.CAST).toBe("CAST");
    expect(FarcasterMessageType.REPLY).toBe("REPLY");
  });

  it("should define event types", () => {
    expect(FarcasterEventTypes.CAST_GENERATED).toBe("FARCASTER_CAST_GENERATED");
    expect(FarcasterEventTypes.MENTION_RECEIVED).toBe("FARCASTER_MENTION_RECEIVED");
    expect(FarcasterEventTypes.THREAD_CAST_CREATED).toBe("FARCASTER_THREAD_CAST_CREATED");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 4. Cast Formatting & Text Splitting
// ═══════════════════════════════════════════════════════════════════════════

describe("Cast Formatting and Validation", () => {
  describe("splitPostContent", () => {
    it("should return a single chunk for short text", () => {
      const result = splitPostContent("Hello Farcaster!");
      expect(result).toHaveLength(1);
      expect(result[0]).toBe("Hello Farcaster!");
    });

    it("should split long text into multiple chunks", () => {
      // Build text with paragraph breaks that exceeds 1024 chars total
      const paragraph = "This is a test paragraph with some content. ";
      const longText =
        Array(30).fill(paragraph).join("") + "\n\n" + Array(30).fill(paragraph).join("");
      const result = splitPostContent(longText);
      expect(result.length).toBeGreaterThan(1);
      for (const chunk of result) {
        expect(chunk.length).toBeLessThanOrEqual(1024);
      }
    });

    it("should preserve paragraph structure when possible", () => {
      const text = "First paragraph.\n\nSecond paragraph.\n\nThird paragraph.";
      const result = splitPostContent(text, 1024);
      expect(result).toHaveLength(1);
      expect(result[0]).toContain("First paragraph.");
      expect(result[0]).toContain("Second paragraph.");
    });

    it("should handle empty string", () => {
      const result = splitPostContent("");
      expect(result).toHaveLength(0);
    });
  });

  describe("splitParagraph", () => {
    it("should split a long paragraph by sentences", () => {
      const paragraph = "This is sentence one. This is sentence two. This is sentence three.";
      const result = splitParagraph(paragraph, 50);
      expect(result.length).toBeGreaterThan(0);
      for (const chunk of result) {
        expect(chunk.length).toBeLessThanOrEqual(50);
      }
    });

    it("should return single chunk when paragraph fits", () => {
      const paragraph = "Short paragraph.";
      const result = splitParagraph(paragraph, 100);
      expect(result).toHaveLength(1);
      expect(result[0]).toBe("Short paragraph.");
    });
  });

  describe("formatCast", () => {
    it("should format a cast with profile info", () => {
      const cast = {
        hash: "0xabc123",
        authorFid: 12345,
        text: "Hello world!",
        profile: {
          fid: 12345,
          name: "Test User",
          username: "testuser",
        },
        timestamp: new Date("2025-01-01T00:00:00Z"),
      };
      const formatted = formatCast(cast);
      expect(formatted).toContain("0xabc123");
      expect(formatted).toContain("Test User");
      expect(formatted).toContain("@testuser");
      expect(formatted).toContain("Hello world!");
    });

    it("should include reply info when present", () => {
      const cast = {
        hash: "0xdef456",
        authorFid: 12345,
        text: "My reply",
        profile: {
          fid: 12345,
          name: "Test User",
          username: "testuser",
        },
        inReplyTo: { hash: "0xabc", fid: 54321 },
        timestamp: new Date("2025-01-01T00:00:00Z"),
      };
      const formatted = formatCast(cast);
      expect(formatted).toContain("In reply to");
      expect(formatted).toContain("54321");
    });
  });

  describe("formatTimeline", () => {
    it("should format a timeline with character name", () => {
      const character = { name: "TestAgent" } as { name: string };
      const casts = [
        {
          hash: "0x1",
          authorFid: 1,
          text: "First cast",
          profile: { fid: 1, name: "User1", username: "user1" },
          timestamp: new Date(),
        },
        {
          hash: "0x2",
          authorFid: 2,
          text: "Second cast",
          profile: { fid: 2, name: "User2", username: "user2" },
          timestamp: new Date(),
        },
      ];
      const formatted = formatTimeline(character as Parameters<typeof formatTimeline>[0], casts);
      expect(formatted).toContain("TestAgent");
      expect(formatted).toContain("First cast");
      expect(formatted).toContain("Second cast");
    });
  });

  describe("formatCastTimestamp", () => {
    it("should return a formatted date string", () => {
      const date = new Date("2025-06-15T14:30:00Z");
      const formatted = formatCastTimestamp(date);
      expect(typeof formatted).toBe("string");
      expect(formatted.length).toBeGreaterThan(0);
    });
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 5. SendCast Action
// ═══════════════════════════════════════════════════════════════════════════

describe("SendCast Action", () => {
  it("should have correct metadata", () => {
    expect(sendCastAction.name).toBe("SEND_CAST");
    expect(sendCastAction.description).toBeDefined();
    expect(typeof sendCastAction.description).toBe("string");
  });

  it("should have examples", () => {
    expect(sendCastAction.examples).toBeDefined();
    expect(Array.isArray(sendCastAction.examples)).toBe(true);
  });

  describe("validate", () => {
    it("should return false when service is not available", async () => {
      const runtime = createMockRuntime();
      const msg = createMessage("post this on farcaster");
      const result = await sendCastAction.validate(runtime, msg);
      expect(result).toBe(false);
    });

    it("should return false when text has no cast keywords", async () => {
      const mockService = { getCastService: () => ({}) };
      const runtime = {
        ...createMockRuntime(),
        getService: () => mockService,
      } as Partial<IAgentRuntime> as IAgentRuntime;
      const msg = createMessage("hello world");
      const result = await sendCastAction.validate(runtime, msg);
      expect(result).toBe(false);
    });

    it("should return true with keyword and service available", async () => {
      const mockService = {
        getCastService: () => ({ createCast: vi.fn() }),
      };
      const runtime = {
        ...createMockRuntime(),
        getService: () => mockService,
      } as Partial<IAgentRuntime> as IAgentRuntime;
      const msg = createMessage("post this to farcaster");
      const result = await sendCastAction.validate(runtime, msg);
      expect(result).toBe(true);
    });

    it("should detect 'cast' keyword", async () => {
      const mockService = { getCastService: () => ({}) };
      const runtime = {
        ...createMockRuntime(),
        getService: () => mockService,
      } as Partial<IAgentRuntime> as IAgentRuntime;
      const msg = createMessage("cast this message now");
      const result = await sendCastAction.validate(runtime, msg);
      expect(result).toBe(true);
    });

    it("should detect 'share' keyword", async () => {
      const mockService = { getCastService: () => ({}) };
      const runtime = {
        ...createMockRuntime(),
        getService: () => mockService,
      } as Partial<IAgentRuntime> as IAgentRuntime;
      const msg = createMessage("share my announcement");
      const result = await sendCastAction.validate(runtime, msg);
      expect(result).toBe(true);
    });

    it("should detect 'announce' keyword", async () => {
      const mockService = { getCastService: () => ({}) };
      const runtime = {
        ...createMockRuntime(),
        getService: () => mockService,
      } as Partial<IAgentRuntime> as IAgentRuntime;
      const msg = createMessage("announce the release");
      const result = await sendCastAction.validate(runtime, msg);
      expect(result).toBe(true);
    });

    it("should be case-insensitive", async () => {
      const mockService = { getCastService: () => ({}) };
      const runtime = {
        ...createMockRuntime(),
        getService: () => mockService,
      } as Partial<IAgentRuntime> as IAgentRuntime;
      const msg = createMessage("POST THIS ON FARCASTER");
      const result = await sendCastAction.validate(runtime, msg);
      expect(result).toBe(true);
    });
  });

  describe("handler", () => {
    it("should return error when PostService is not available", async () => {
      const mockService = { getCastService: () => null };
      const runtime = {
        ...createMockRuntime(),
        getService: () => mockService,
      } as Partial<IAgentRuntime> as IAgentRuntime;
      const msg = createMessage("post this");
      const result = await sendCastAction.handler(runtime, msg, undefined);
      expect(result).toMatchObject({ success: false });
    });

    it("should create cast via service and record memory", async () => {
      const mockCast = {
        id: "cast-id-1",
        roomId: "room-1" as UUID,
        timestamp: Date.now(),
        metadata: { castHash: "0xabc" },
        text: "Generated text for Farcaster",
      };
      const createCast = vi.fn().mockResolvedValue(mockCast);
      const mockService = { getCastService: () => ({ createCast }) };
      const createMemory = vi.fn().mockResolvedValue(undefined);
      const runtime = {
        ...createMockRuntime(),
        getService: () => mockService,
        createMemory,
      } as Partial<IAgentRuntime> as IAgentRuntime;

      const msg = createMessage("cast this");
      const state = { castContent: "Hello Farcaster!" } as State;
      const result = await sendCastAction.handler(runtime, msg, state);

      expect(result).toMatchObject({ success: true });
      expect(createCast).toHaveBeenCalledTimes(1);
      const callArgs = createCast.mock.calls[0][0];
      expect(callArgs.text).toBe("Hello Farcaster!");
      expect(createMemory).toHaveBeenCalledTimes(1);
    });

    it("should truncate cast content exceeding 320 characters", async () => {
      const longText = "X".repeat(400);
      const createCast = vi.fn().mockResolvedValue({
        id: "cast-id-2",
        roomId: "room-2" as UUID,
        timestamp: Date.now(),
        metadata: {},
        text: longText.substring(0, 317) + "...",
      });
      const mockService = { getCastService: () => ({ createCast }) };
      const runtime = {
        ...createMockRuntime(),
        getService: () => mockService,
        createMemory: vi.fn(),
      } as Partial<IAgentRuntime> as IAgentRuntime;

      const msg = createMessage("post this");
      const state = { castContent: longText } as State;
      await sendCastAction.handler(runtime, msg, state);

      const callArgs = createCast.mock.calls[0][0];
      expect(callArgs.text.length).toBeLessThanOrEqual(320);
      expect(callArgs.text.endsWith("...")).toBe(true);
    });

    it("should use model-generated text when state has no castContent", async () => {
      const mockCast = {
        id: "cast-id-3",
        roomId: "room-3" as UUID,
        timestamp: Date.now(),
        metadata: {},
        text: "Generated text for Farcaster",
      };
      const createCast = vi.fn().mockResolvedValue(mockCast);
      const mockService = { getCastService: () => ({ createCast }) };
      const useModel = vi.fn().mockResolvedValue("AI generated cast");
      const runtime = {
        ...createMockRuntime(),
        getService: () => mockService,
        useModel,
        createMemory: vi.fn(),
      } as Partial<IAgentRuntime> as IAgentRuntime;

      const msg = createMessage("cast something cool");
      await sendCastAction.handler(runtime, msg, {} as State);
      expect(useModel).toHaveBeenCalledTimes(1);
    });
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 6. ReplyCast Action
// ═══════════════════════════════════════════════════════════════════════════

describe("ReplyCast Action", () => {
  it("should have correct metadata", () => {
    expect(replyCastAction.name).toBe("REPLY_TO_CAST");
    expect(replyCastAction.description).toBeDefined();
  });

  it("should have examples with correct structure", () => {
    expect(replyCastAction.examples).toBeDefined();
    expect(Array.isArray(replyCastAction.examples)).toBe(true);
    expect(replyCastAction.examples.length).toBeGreaterThan(0);
    for (const set of replyCastAction.examples) {
      expect(Array.isArray(set)).toBe(true);
      expect(set.length).toBe(2); // user + assistant
    }
  });

  describe("validate", () => {
    it("should return false when service is unavailable", async () => {
      const runtime = createMockRuntime();
      const msg = createMessage("reply to this");
      const result = await replyCastAction.validate(runtime, msg);
      expect(result).toBe(false);
    });

    it("should return false when no reply keyword in text", async () => {
      const mockService = { getMessageService: () => ({}) };
      const runtime = {
        ...createMockRuntime(),
        getService: () => mockService,
      } as Partial<IAgentRuntime> as IAgentRuntime;
      const msg = createMessage("hello world");
      const result = await replyCastAction.validate(runtime, msg);
      expect(result).toBe(false);
    });

    it("should return true with reply keyword and parent hash", async () => {
      const mockService = { getMessageService: () => ({}) };
      const runtime = {
        ...createMockRuntime(),
        getService: () => mockService,
      } as Partial<IAgentRuntime> as IAgentRuntime;
      const msg = createMessage("reply to their message", {
        parentCastHash: "0xparent",
      });
      const result = await replyCastAction.validate(runtime, msg);
      expect(result).toBe(true);
    });

    it("should detect 'respond' keyword", async () => {
      const mockService = { getMessageService: () => ({}) };
      const runtime = {
        ...createMockRuntime(),
        getService: () => mockService,
      } as Partial<IAgentRuntime> as IAgentRuntime;
      const msg = createMessage("respond to the thread", {
        parentCastHash: "0x123",
      });
      const result = await replyCastAction.validate(runtime, msg);
      expect(result).toBe(true);
    });

    it("should detect 'answer' keyword", async () => {
      const mockService = { getMessageService: () => ({}) };
      const runtime = {
        ...createMockRuntime(),
        getService: () => mockService,
      } as Partial<IAgentRuntime> as IAgentRuntime;
      const msg = createMessage("answer their question", {
        parentCastHash: "0xabc",
      });
      const result = await replyCastAction.validate(runtime, msg);
      expect(result).toBe(true);
    });

    it("should detect 'comment' keyword", async () => {
      const mockService = { getMessageService: () => ({}) };
      const runtime = {
        ...createMockRuntime(),
        getService: () => mockService,
      } as Partial<IAgentRuntime> as IAgentRuntime;
      const msg = createMessage("comment on this cast", {
        parentCastHash: "0xdef",
      });
      const result = await replyCastAction.validate(runtime, msg);
      expect(result).toBe(true);
    });
  });

  describe("handler", () => {
    it("should return error when MessageService is not available", async () => {
      const mockService = { getMessageService: () => null };
      const runtime = {
        ...createMockRuntime(),
        getService: () => mockService,
      } as Partial<IAgentRuntime> as IAgentRuntime;
      const msg = createMessage("reply to this");
      const result = await replyCastAction.handler(runtime, msg, undefined);
      expect(result).toMatchObject({ success: false });
    });

    it("should return error when no parent cast hash", async () => {
      const sendMessage = vi.fn();
      const mockService = {
        getMessageService: () => ({ sendMessage }),
      };
      const runtime = {
        ...createMockRuntime(),
        getService: () => mockService,
      } as Partial<IAgentRuntime> as IAgentRuntime;
      const msg = createMessage("reply to this");
      const result = await replyCastAction.handler(runtime, msg, {} as State);
      expect(result).toMatchObject({ success: false });
      expect(sendMessage).not.toHaveBeenCalled();
    });

    it("should send reply when parent hash is in metadata", async () => {
      const mockReply = { id: "reply-1" };
      const sendMessage = vi.fn().mockResolvedValue(mockReply);
      const mockService = {
        getMessageService: () => ({ sendMessage }),
      };
      const useModel = vi.fn().mockResolvedValue("Thanks for sharing!");
      const runtime = {
        ...createMockRuntime(),
        getService: () => mockService,
        useModel,
      } as Partial<IAgentRuntime> as IAgentRuntime;

      const msg = createMessage("reply to them", {
        parentCastHash: "0xparenthash",
      });
      const result = await replyCastAction.handler(runtime, msg, {} as State);
      expect(result).toMatchObject({ success: true });
      expect(sendMessage).toHaveBeenCalledTimes(1);
    });

    it("should truncate reply content exceeding 320 characters", async () => {
      const longReply = "R".repeat(400);
      const sendMessage = vi.fn().mockResolvedValue({ id: "reply-2" });
      const mockService = {
        getMessageService: () => ({ sendMessage }),
      };
      const runtime = {
        ...createMockRuntime(),
        getService: () => mockService,
      } as Partial<IAgentRuntime> as IAgentRuntime;

      const msg = createMessage("reply", { parentCastHash: "0xparent" });
      const state = { replyContent: longReply } as State;
      await replyCastAction.handler(runtime, msg, state);

      const callArgs = sendMessage.mock.calls[0][0];
      expect(callArgs.text.length).toBeLessThanOrEqual(320);
      expect(callArgs.text.endsWith("...")).toBe(true);
    });
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 7. Actions Collection
// ═══════════════════════════════════════════════════════════════════════════

describe("Actions Collection", () => {
  it("should export exactly 2 actions", () => {
    expect(farcasterActions).toHaveLength(2);
  });

  it("should include sendCast and replyCast", () => {
    const names = farcasterActions.map((a) => a.name);
    expect(names).toContain("SEND_CAST");
    expect(names).toContain("REPLY_TO_CAST");
  });

  it("each action should have a handler function", () => {
    for (const action of farcasterActions) {
      expect(typeof action.handler).toBe("function");
    }
  });

  it("each action should have a validate function", () => {
    for (const action of farcasterActions) {
      expect(typeof action.validate).toBe("function");
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 8. TimelineProvider
// ═══════════════════════════════════════════════════════════════════════════

describe("Timeline Provider", () => {
  it("should have correct metadata", () => {
    expect(farcasterTimelineProvider.name).toBeDefined();
    expect(farcasterTimelineProvider.description).toBe(
      "Provides recent casts from the agent's Farcaster timeline"
    );
  });

  it("should return unavailable when service is missing", async () => {
    const runtime = createMockRuntime();
    const msg = createMessage("show timeline");
    const result = await farcasterTimelineProvider.get(runtime, msg, {} as State);
    expect(result.text).toContain("not available");
    expect(result.data).toMatchObject({ available: false });
  });

  it("should return empty timeline message when no casts", async () => {
    const mockService = {
      getCastService: () => ({
        getCasts: vi.fn().mockResolvedValue([]),
      }),
    };
    const runtime = {
      ...createMockRuntime(),
      getService: () => mockService,
    } as Partial<IAgentRuntime> as IAgentRuntime;
    const msg = createMessage("show timeline");
    const result = await farcasterTimelineProvider.get(runtime, msg, {} as State);
    expect(result.text).toContain("No recent casts");
    expect(result.data).toMatchObject({ available: true, casts: [], count: 0 });
  });

  it("should format casts when available", async () => {
    const casts = [
      {
        text: "Hello timeline!",
        username: "user1",
        timestamp: Date.now(),
        metadata: { castHash: "0xaaa" },
      },
      {
        text: "Second cast",
        username: "user2",
        timestamp: Date.now() - 60000,
        metadata: {},
      },
    ];
    const mockService = {
      getCastService: () => ({
        getCasts: vi.fn().mockResolvedValue(casts),
      }),
    };
    const runtime = {
      ...createMockRuntime(),
      getService: () => mockService,
    } as Partial<IAgentRuntime> as IAgentRuntime;
    const msg = createMessage("show timeline");
    const result = await farcasterTimelineProvider.get(runtime, msg, {} as State);
    expect(result.text).toContain("Recent casts");
    expect(result.text).toContain("@user1");
    expect(result.text).toContain("Hello timeline!");
    expect(result.data).toMatchObject({ available: true, castCount: 2 });
    expect(result.values).toBeDefined();
    expect(result.values!.latestCastHash).toBe("0xaaa");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 9. ThreadProvider
// ═══════════════════════════════════════════════════════════════════════════

describe("Thread Provider", () => {
  it("should have correct metadata", () => {
    expect(farcasterThreadProvider.name).toBeDefined();
    expect(farcasterThreadProvider.description).toContain("thread context");
  });

  it("should return empty for non-farcaster source", async () => {
    const runtime = createMockRuntime();
    const msg = {
      ...createMessage("text"),
      content: { text: "text", source: "discord" },
    } as Memory;
    const result = await farcasterThreadProvider.get(runtime, msg, {} as State);
    expect(result.text).toBe("");
    expect(result.data).toMatchObject({ available: false });
  });

  it("should return unavailable when service is missing", async () => {
    const runtime = createMockRuntime();
    const msg = createMessage("text");
    msg.content.source = "farcaster";
    const result = await farcasterThreadProvider.get(runtime, msg, {} as State);
    expect(result.data).toMatchObject({ available: false });
  });

  it("should return thread context when available", async () => {
    const threadMsgs = [
      {
        text: "Original cast",
        username: "author1",
        userId: "author1",
        timestamp: Date.now() - 120000,
      },
      {
        text: "Reply to original",
        username: "author2",
        userId: "author2",
        timestamp: Date.now(),
      },
    ];
    const mockService = {
      getMessageService: () => ({
        getThread: vi.fn().mockResolvedValue(threadMsgs),
      }),
    };
    const runtime = {
      ...createMockRuntime(),
      getService: () => mockService,
    } as Partial<IAgentRuntime> as IAgentRuntime;
    const msg = createMessage("text");
    msg.content.source = "farcaster";
    (msg.content as Record<string, string>).castHash = "0xthreadhash";

    const result = await farcasterThreadProvider.get(runtime, msg, {} as State);
    expect(result.text).toContain("Farcaster Thread Context");
    expect(result.data).toMatchObject({
      available: true,
      castHash: "0xthreadhash",
      count: 2,
    });
    expect(result.values).toBeDefined();
    expect(result.values!.farcasterCastHash).toBe("0xthreadhash");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 10. ProfileProvider
// ═══════════════════════════════════════════════════════════════════════════

describe("Profile Provider", () => {
  it("should have correct metadata", () => {
    expect(farcasterProfileProvider.name).toBeDefined();
    expect(farcasterProfileProvider.description).toContain("profile");
  });

  it("should return unavailable when service has no managers", async () => {
    const mockService = { getActiveManagers: () => new Map() };
    const runtime = {
      ...createMockRuntime(),
      getService: () => mockService,
    } as Partial<IAgentRuntime> as IAgentRuntime;
    const msg = createMessage("show profile");
    const result = await farcasterProfileProvider.get(runtime, msg, {} as State);
    expect(result.text).toContain("not available");
    expect(result.data).toMatchObject({ available: false });
  });

  it("should return profile data when available", async () => {
    const agentId = "00000000-0000-0000-0000-000000000001" as UUID;
    const mockProfile = {
      fid: 12345,
      username: "testuser",
      name: "Test User",
      pfp: "https://example.com/pfp.png",
    };
    const mockManager = {
      client: {
        getProfile: vi.fn().mockResolvedValue(mockProfile),
      },
    };
    const managers = new Map([[agentId, mockManager]]);
    const mockService = { getActiveManagers: () => managers };
    const runtime = {
      ...createMockRuntime({ FARCASTER_FID: "12345" }),
      agentId,
      getService: () => mockService,
    } as Partial<IAgentRuntime> as IAgentRuntime;
    const msg = createMessage("show profile");
    const result = await farcasterProfileProvider.get(runtime, msg, {} as State);
    expect(result.text).toContain("@testuser");
    expect(result.text).toContain("12345");
    expect(result.data).toMatchObject({
      available: true,
      fid: 12345,
      username: "testuser",
    });
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 11. Providers Collection
// ═══════════════════════════════════════════════════════════════════════════

describe("Providers Collection", () => {
  it("should export exactly 3 providers", () => {
    expect(farcasterProviders).toHaveLength(3);
  });

  it("should have get functions on each provider", () => {
    for (const provider of farcasterProviders) {
      expect(typeof provider.get).toBe("function");
    }
  });

  it("each provider should have a name", () => {
    for (const provider of farcasterProviders) {
      expect(provider.name).toBeDefined();
      expect(typeof provider.name).toBe("string");
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 12. Service Lifecycle (static methods, no credentials needed)
// ═══════════════════════════════════════════════════════════════════════════

describe("FarcasterService Lifecycle", () => {
  it("should have a static serviceType", async () => {
    const { FarcasterService } = await import("../services/FarcasterService");
    expect(FarcasterService.serviceType).toBe("farcaster");
  });

  it("should return service from start even when not enabled", async () => {
    const { FarcasterService } = await import("../services/FarcasterService");
    // No FARCASTER_FID set, so hasFarcasterEnabled returns false
    const runtime = createMockRuntime();
    const service = await FarcasterService.start(runtime);
    expect(service).toBeDefined();
  });

  it("should handle stop gracefully when not running", async () => {
    const { FarcasterService } = await import("../services/FarcasterService");
    const runtime = createMockRuntime();
    // stop should not throw when not running
    await expect(FarcasterService.stop(runtime)).resolves.toBeUndefined();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 13. Client Parameter Validation
// ═══════════════════════════════════════════════════════════════════════════

describe("Client Parameter Validation", () => {
  it("FarcasterClient constructor requires neynar and signerUuid", async () => {
    const { FarcasterClient } = await import("../client/FarcasterClient");
    // Passing minimal valid params should not throw
    const neynarMock = {} as Parameters<typeof FarcasterClient.prototype.sendCast>[0] extends never
      ? never
      : Record<string, Function>;
    expect(
      () => new FarcasterClient({ neynar: neynarMock as never, signerUuid: "uuid" })
    ).not.toThrow();
  });

  it("sendCast returns empty array for empty text", async () => {
    const { FarcasterClient } = await import("../client/FarcasterClient");
    const neynarMock = {} as never;
    const client = new FarcasterClient({
      neynar: neynarMock,
      signerUuid: "uuid",
    });
    const result = await client.sendCast({ content: { text: "" } });
    expect(result).toEqual([]);
  });

  it("sendCast returns empty array for whitespace-only text", async () => {
    const { FarcasterClient } = await import("../client/FarcasterClient");
    const neynarMock = {} as never;
    const client = new FarcasterClient({
      neynar: neynarMock,
      signerUuid: "uuid",
    });
    const result = await client.sendCast({ content: { text: "   " } });
    expect(result).toEqual([]);
  });
});
