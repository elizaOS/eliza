/**
 * Unit tests for Bluesky handlers
 *
 * These tests verify that the handlers correctly:
 * - Route to the full elizaOS messageService.handleMessage() pipeline
 * - Create proper Memory objects using createMessageMemory()
 * - Set up connections and rooms correctly
 * - Handle callbacks that post to Bluesky
 */

import type { Content, IAgentRuntime, Memory, Service } from "@elizaos/core";
import { stringToUuid } from "@elizaos/core";
import { beforeEach, describe, expect, it, type Mock, vi } from "vitest";
import {
  type BlueSkyCreatePostEventPayload,
  type BlueSkyNotification,
  type BlueSkyNotificationEventPayload,
  handleCreatePost,
  handleMentionReceived,
  handleShouldRespond,
  registerBlueskyHandlers,
} from "../handlers";

// ============================================================================
// Mock Types
// ============================================================================

interface MockPostService {
  createPost: Mock;
}

interface MockBlueSkyService extends Service {
  getPostService: Mock;
  getMessageService: Mock;
}

// ============================================================================
// Mock Factories
// ============================================================================

function createMockRuntime(): IAgentRuntime {
  const mockPostService: MockPostService = {
    createPost: vi.fn().mockResolvedValue({
      uri: "at://did:plc:test/app.bsky.feed.post/123",
      cid: "bafyreic123",
    }),
  };

  const mockService: MockBlueSkyService = {
    getPostService: vi.fn().mockReturnValue(mockPostService),
    getMessageService: vi.fn().mockReturnValue(null),
  } as unknown as MockBlueSkyService;

  // Mock messageService that captures the callback and invokes it
  const mockMessageService = {
    handleMessage: vi
      .fn()
      .mockImplementation(
        async (
          _runtime: IAgentRuntime,
          _message: Memory,
          callback?: (content: Content) => Promise<Memory[]>,
        ) => {
          // Simulate elizaOS pipeline generating a response
          if (callback) {
            const responseContent: Content = {
              text: "This is a test response from the elizaOS pipeline!",
              source: "bluesky",
            };
            await callback(responseContent);
          }
          return {
            didRespond: true,
            responseContent: { text: "Test response" },
            responseMessages: [],
            state: { values: {}, data: {}, text: "" },
            mode: "actions",
          };
        },
      ),
  };

  return {
    agentId: stringToUuid("test-agent"),
    character: {
      name: "TestBot",
      bio: "A test bot for Bluesky",
      postExamples: ["Test post 1", "Test post 2"],
    },
    logger: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    },
    messageService: mockMessageService,
    getService: vi.fn().mockReturnValue(mockService),
    createMemory: vi.fn().mockResolvedValue(stringToUuid("memory-id")),
    ensureConnection: vi.fn().mockResolvedValue(undefined),
    ensureWorldExists: vi.fn().mockResolvedValue(undefined),
    registerEvent: vi.fn(),
  } as unknown as IAgentRuntime;
}

function createMockNotification(
  overrides: Partial<BlueSkyNotification> = {},
): BlueSkyNotification {
  return {
    uri: "at://did:plc:user123/app.bsky.feed.post/abc123",
    cid: "bafyreic456",
    author: {
      did: "did:plc:user123",
      handle: "testuser.bsky.social",
      displayName: "Test User",
    },
    reason: "mention",
    record: { text: "@TestBot hello, how are you?" },
    isRead: false,
    indexedAt: new Date().toISOString(),
    ...overrides,
  };
}

// ============================================================================
// Helper to get mock service from runtime
// ============================================================================

function getMockService(runtime: IAgentRuntime): MockBlueSkyService {
  return runtime.getService("bluesky") as unknown as MockBlueSkyService;
}

function getMockPostService(runtime: IAgentRuntime): MockPostService {
  const service = getMockService(runtime);
  return service.getPostService(runtime.agentId) as MockPostService;
}

// ============================================================================
// Tests
// ============================================================================

describe("Bluesky Handlers - Full elizaOS Pipeline", () => {
  let runtime: IAgentRuntime;

  beforeEach(() => {
    runtime = createMockRuntime();
    vi.clearAllMocks();
  });

  describe("handleMentionReceived", () => {
    it("should process mentions through messageService.handleMessage()", async () => {
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

      // Should have ensured connection
      expect(runtime.ensureConnection).toHaveBeenCalledWith(
        expect.objectContaining({
          source: "bluesky",
          userName: "testuser.bsky.social",
        }),
      );

      // Should have called messageService.handleMessage() - THE FULL PIPELINE
      expect(runtime.messageService?.handleMessage).toHaveBeenCalledWith(
        runtime,
        expect.objectContaining({
          content: expect.objectContaining({
            text: "@TestBot what is AI?",
            source: "bluesky",
            mentionContext: expect.objectContaining({
              isMention: true,
              mentionType: "platform_mention",
            }),
          }),
        }),
        expect.any(Function), // callback
      );

      // Should have posted the reply via the callback
      const postService = getMockPostService(runtime);
      expect(postService.createPost).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          uri: notification.uri,
          cid: notification.cid,
        }),
      );
    });

    it("should process replies through the pipeline", async () => {
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

      expect(runtime.messageService?.handleMessage).toHaveBeenCalledWith(
        runtime,
        expect.objectContaining({
          content: expect.objectContaining({
            mentionContext: expect.objectContaining({
              isReply: true,
              mentionType: "reply",
            }),
          }),
        }),
        expect.any(Function),
      );
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

      // Should NOT have called the message service
      expect(runtime.messageService?.handleMessage).not.toHaveBeenCalled();
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

      expect(runtime.messageService?.handleMessage).not.toHaveBeenCalled();
    });

    it("should handle missing messageService gracefully", async () => {
      // Remove messageService
      (runtime as { messageService: null }).messageService = null;

      const notification = createMockNotification();
      const payload: BlueSkyNotificationEventPayload = {
        runtime,
        source: "bluesky",
        notification,
      };

      // Should not throw
      await handleMentionReceived(payload);

      expect(runtime.logger.error).toHaveBeenCalledWith(
        expect.stringContaining("MessageService not available"),
      );
    });

    it("should truncate responses over 300 characters", async () => {
      // Mock a long response
      const longResponse = "A".repeat(400);
      (runtime.messageService?.handleMessage as Mock).mockImplementation(
        async (
          _runtime: IAgentRuntime,
          _message: Memory,
          callback?: (content: Content) => Promise<Memory[]>,
        ) => {
          if (callback) {
            await callback({ text: longResponse, source: "bluesky" });
          }
          return {
            didRespond: true,
            responseContent: null,
            responseMessages: [],
            state: { values: {}, data: {}, text: "" },
            mode: "actions",
          };
        },
      );

      const notification = createMockNotification();
      const payload: BlueSkyNotificationEventPayload = {
        runtime,
        source: "bluesky",
        notification,
      };

      await handleMentionReceived(payload);

      const postService = getMockPostService(runtime);

      // Check that the posted text is truncated
      expect(postService.createPost).toHaveBeenCalledWith(
        expect.stringMatching(/^A{297}\.\.\.$/),
        expect.anything(),
      );
    });
  });

  describe("handleShouldRespond", () => {
    it("should route mentions to handleMentionReceived", async () => {
      const notification = createMockNotification({ reason: "mention" });
      const payload: BlueSkyNotificationEventPayload = {
        runtime,
        source: "bluesky",
        notification,
      };

      await handleShouldRespond(payload);

      expect(runtime.messageService?.handleMessage).toHaveBeenCalled();
    });

    it("should route replies to handleMentionReceived", async () => {
      const notification = createMockNotification({ reason: "reply" });
      const payload: BlueSkyNotificationEventPayload = {
        runtime,
        source: "bluesky",
        notification,
      };

      await handleShouldRespond(payload);

      expect(runtime.messageService?.handleMessage).toHaveBeenCalled();
    });
  });

  describe("handleCreatePost", () => {
    it("should generate automated posts through the pipeline", async () => {
      const payload: BlueSkyCreatePostEventPayload = {
        runtime,
        source: "bluesky",
        automated: true,
      };

      await handleCreatePost(payload);

      // Should have called messageService.handleMessage()
      expect(runtime.messageService?.handleMessage).toHaveBeenCalledWith(
        runtime,
        expect.objectContaining({
          content: expect.objectContaining({
            metadata: expect.objectContaining({
              isAutomatedPostTrigger: true,
              platform: "bluesky",
            }),
          }),
        }),
        expect.any(Function),
      );

      // Should have posted via the callback
      const postService = getMockPostService(runtime);
      expect(postService.createPost).toHaveBeenCalledWith(expect.any(String));
    });

    it("should skip non-automated posts", async () => {
      const payload: BlueSkyCreatePostEventPayload = {
        runtime,
        source: "bluesky",
        automated: false,
      };

      await handleCreatePost(payload);

      expect(runtime.messageService?.handleMessage).not.toHaveBeenCalled();
    });
  });

  describe("registerBlueskyHandlers", () => {
    it("should register all three event handlers", () => {
      registerBlueskyHandlers(runtime);

      expect(runtime.registerEvent).toHaveBeenCalledTimes(3);
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

  it("should have message examples for few-shot learning", async () => {
    const { character } = await import("../character");

    expect(character.messageExamples).toBeDefined();
    expect(character.messageExamples?.length).toBeGreaterThan(0);
  });

  it("should have post examples for automated posting", async () => {
    const { character } = await import("../character");

    expect(character.postExamples).toBeDefined();
    expect(character.postExamples?.length).toBeGreaterThan(0);
  });
});
