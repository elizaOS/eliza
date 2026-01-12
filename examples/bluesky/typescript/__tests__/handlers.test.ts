import type { IAgentRuntime } from "@elizaos/core";
import { stringToUuid } from "@elizaos/core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  handleCreatePost,
  handleMentionReceived,
  registerBlueskyHandlers,
} from "../handlers";

// Inline types to avoid module resolution issues
interface BlueSkyProfile {
  did: string;
  handle: string;
  displayName?: string;
}

interface BlueSkyNotification {
  uri: string;
  cid: string;
  author: BlueSkyProfile;
  reason: string;
  record: Record<string, unknown>;
  isRead: boolean;
  indexedAt: string;
}

interface BlueSkyNotificationEventPayload {
  runtime: IAgentRuntime;
  source: string;
  notification: BlueSkyNotification;
}

interface BlueSkyCreatePostEventPayload {
  runtime: IAgentRuntime;
  source: string;
  automated: boolean;
}

// Mock runtime factory
function createMockRuntime(): IAgentRuntime {
  const mockPostService = {
    createPost: vi.fn().mockResolvedValue({
      uri: "at://mock/post/123",
      cid: "mock-cid-123",
    }),
  };

  const mockService = {
    getPostService: vi.fn().mockReturnValue(mockPostService),
    getMessageService: vi.fn().mockReturnValue(null),
  };

  return {
    agentId: stringToUuid("test-agent"),
    character: {
      name: "TestBot",
      bio: "A test bot",
      postExamples: ["Test post 1", "Test post 2"],
    },
    logger: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    },
    getService: vi.fn().mockReturnValue(mockService),
    createMemory: vi.fn().mockResolvedValue(undefined),
    composeState: vi.fn().mockResolvedValue({}),
    useModel: vi.fn().mockResolvedValue("This is a test reply!"),
    ensureConnection: vi.fn().mockResolvedValue(undefined),
    registerEvent: vi.fn(),
  } as unknown as IAgentRuntime;
}

// Mock notification factory
function createMockNotification(
  overrides: Partial<BlueSkyNotification> = {},
): BlueSkyNotification {
  return {
    uri: "at://did:plc:user123/app.bsky.feed.post/abc123",
    cid: "bafyreic123",
    author: {
      did: "did:plc:user123",
      handle: "testuser.bsky.social",
      displayName: "Test User",
    },
    reason: "mention",
    record: { text: "@TestBot hello!" },
    isRead: false,
    indexedAt: new Date().toISOString(),
    ...overrides,
  } as BlueSkyNotification;
}

describe("Bluesky Handlers", () => {
  let runtime: IAgentRuntime;

  beforeEach(() => {
    runtime = createMockRuntime();
    vi.clearAllMocks();
  });

  describe("handleMentionReceived", () => {
    it("should process a mention and generate a reply", async () => {
      const notification = createMockNotification({
        reason: "mention",
        record: { text: "@TestBot what is AI?" },
      });

      const payload: BlueSkyNotificationEventPayload = {
        runtime,
        source: "bluesky",
        notification,
      };

      await handleMentionReceived(payload);

      // Should have created memory for the incoming message
      expect(runtime.createMemory).toHaveBeenCalled();

      // Should have used the model to generate a reply
      expect(runtime.useModel).toHaveBeenCalled();

      // Should have used the service to post
      expect(runtime.getService).toHaveBeenCalledWith("bluesky");
    });

    it("should skip non-mention/reply notifications", async () => {
      const notification = createMockNotification({
        reason: "follow",
      });

      const payload: BlueSkyNotificationEventPayload = {
        runtime,
        source: "bluesky",
        notification,
      };

      await handleMentionReceived(payload);

      // Should not have processed
      expect(runtime.useModel).not.toHaveBeenCalled();
    });

    it("should skip empty mention text", async () => {
      const notification = createMockNotification({
        reason: "mention",
        record: { text: "" },
      });

      const payload: BlueSkyNotificationEventPayload = {
        runtime,
        source: "bluesky",
        notification,
      };

      await handleMentionReceived(payload);

      expect(runtime.useModel).not.toHaveBeenCalled();
    });

    it("should handle reply notifications", async () => {
      const notification = createMockNotification({
        reason: "reply",
        record: { text: "Thanks for the info!" },
      });

      const payload: BlueSkyNotificationEventPayload = {
        runtime,
        source: "bluesky",
        notification,
      };

      await handleMentionReceived(payload);

      expect(runtime.useModel).toHaveBeenCalled();
    });
  });

  describe("handleCreatePost", () => {
    it("should generate and post automated content", async () => {
      const payload: BlueSkyCreatePostEventPayload = {
        runtime,
        source: "bluesky",
        automated: true,
      };

      await handleCreatePost(payload);

      // Should have used the model
      expect(runtime.useModel).toHaveBeenCalled();

      // Should have used the service
      expect(runtime.getService).toHaveBeenCalledWith("bluesky");
    });

    it("should skip non-automated posts", async () => {
      const payload: BlueSkyCreatePostEventPayload = {
        runtime,
        source: "bluesky",
        automated: false,
      };

      await handleCreatePost(payload);

      expect(runtime.useModel).not.toHaveBeenCalled();
    });

    it("should handle empty generated content", async () => {
      (runtime.useModel as ReturnType<typeof vi.fn>).mockResolvedValueOnce("");

      const payload: BlueSkyCreatePostEventPayload = {
        runtime,
        source: "bluesky",
        automated: true,
      };

      await handleCreatePost(payload);

      // Should log warning but not throw
      expect(runtime.logger.warn).toHaveBeenCalled();
    });
  });

  describe("registerBlueskyHandlers", () => {
    it("should register all event handlers", () => {
      registerBlueskyHandlers(runtime);

      expect(runtime.registerEvent).toHaveBeenCalledWith(
        "bluesky.mention_received",
        expect.any(Function),
      );
      expect(runtime.registerEvent).toHaveBeenCalledWith(
        "bluesky.should_respond",
        expect.any(Function),
      );
      expect(runtime.registerEvent).toHaveBeenCalledWith(
        "bluesky.create_post",
        expect.any(Function),
      );
    });
  });
});

describe("Character Configuration", () => {
  it("should have valid character export", async () => {
    const { character } = await import("../character");

    expect(character.name).toBeDefined();
    expect(character.bio).toBeDefined();
    expect(character.system).toBeDefined();
  });

  it("should have message examples", async () => {
    const { character } = await import("../character");

    expect(character.messageExamples).toBeDefined();
    expect(character.messageExamples?.length).toBeGreaterThan(0);
  });

  it("should have post examples", async () => {
    const { character } = await import("../character");

    expect(character.postExamples).toBeDefined();
    expect(character.postExamples?.length).toBeGreaterThan(0);
  });
});
