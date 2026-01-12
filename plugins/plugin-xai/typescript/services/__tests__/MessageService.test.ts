import { stringToUuid } from "@elizaos/core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ClientBase } from "../../base";
import { SearchMode } from "../../client";
import { MessageType } from "../IMessageService";
import { XMessageService } from "../MessageService";

// Mock the dependencies
vi.mock("@elizaos/core", async () => {
  const actual = await vi.importActual<typeof import("@elizaos/core")>("@elizaos/core");
  return {
    ...actual,
    createUniqueUuid: vi.fn((_runtime, id) => `uuid-${id}`),
    logger: {
      error: vi.fn(),
      debug: vi.fn(),
    },
  };
});

// Test UUIDs - use stringToUuid to create proper UUID types
const TEST_AGENT_ID = stringToUuid("agent-123");
const TEST_ROOM_ID = stringToUuid("room-123");
const TEST_CONV_ID = stringToUuid("conv-1");

interface MockClient {
  runtime: {
    agentId: string;
  };
  profile: {
    id: string;
    username: string;
  } | null;
  fetchSearchPosts: ReturnType<typeof vi.fn>;
  xClient: {
    sendDirectMessage: ReturnType<typeof vi.fn>;
    sendPost: ReturnType<typeof vi.fn>;
    deletePost: ReturnType<typeof vi.fn>;
    getPost: ReturnType<typeof vi.fn>;
  };
}

// Helper function to convert MockClient to ClientBase for testing
function asClientBase(client: MockClient): ClientBase {
  return client as ClientBase;
}

describe("XMessageService", () => {
  let service: XMessageService;
  let mockClient: MockClient;

  beforeEach(() => {
    // Create mock client - use TEST_AGENT_ID for consistent UUID usage
    mockClient = {
      runtime: {
        agentId: TEST_AGENT_ID,
      },
      profile: {
        id: "user-123",
        username: "testuser",
      },
      fetchSearchPosts: vi.fn(),
      xClient: {
        sendDirectMessage: vi.fn(),
        sendPost: vi.fn(),
        deletePost: vi.fn(),
        getPost: vi.fn(),
      },
    };

    service = new XMessageService(asClientBase(mockClient));
  });

  describe("getMessages", () => {
    it("should fetch messages based on mentions", async () => {
      const mockPosts = [
        {
          id: "post-1",
          userId: "user-456",
          username: "otheruser",
          text: "@testuser Hello!",
          conversationId: "conv-1",
          timestamp: 1234567890,
          inReplyToStatusId: null,
          permanentUrl: "https://x.com/otheruser/status/post-1",
        },
        {
          id: "post-2",
          userId: "user-789",
          username: "anotheruser",
          text: "@testuser How are you?",
          conversationId: "conv-2",
          timestamp: 1234567891,
          inReplyToStatusId: "post-0",
          permanentUrl: "https://x.com/anotheruser/status/post-2",
        },
      ];

      mockClient.fetchSearchPosts.mockResolvedValue({
        posts: mockPosts,
      });

      const options = {
        agentId: TEST_AGENT_ID,
        limit: 10,
      };

      const messages = await service.getMessages(options);

      expect(mockClient.fetchSearchPosts).toHaveBeenCalledWith("@testuser", 10, SearchMode.Latest);

      expect(messages).toHaveLength(2);
      expect(messages[0]).toEqual({
        id: "post-1",
        agentId: TEST_AGENT_ID,
        roomId: "uuid-conv-1",
        userId: "user-456",
        username: "otheruser",
        text: "@testuser Hello!",
        type: MessageType.MENTION,
        timestamp: 1234567890000,
        inReplyTo: null,
        metadata: {
          postId: "post-1",
          permanentUrl: "https://x.com/otheruser/status/post-1",
        },
      });

      expect(messages[1].type).toBe(MessageType.REPLY);
    });

    it("should filter by roomId when specified", async () => {
      const mockPosts = [
        {
          id: "post-1",
          conversationId: "conv-1",
          userId: "user-456",
          username: "otheruser",
          text: "Hello",
          timestamp: 1234567890,
        },
        {
          id: "post-2",
          conversationId: "conv-2",
          userId: "user-789",
          username: "anotheruser",
          text: "Hi",
          timestamp: 1234567891,
        },
      ];

      mockClient.fetchSearchPosts.mockResolvedValue({
        posts: mockPosts,
      });

      // The mock for createUniqueUuid returns "uuid-${id}", so we need to match that
      const options = {
        agentId: TEST_AGENT_ID,
        roomId: "uuid-conv-1" as ReturnType<typeof stringToUuid>,
      };

      const messages = await service.getMessages(options);

      expect(messages).toHaveLength(1);
      expect(messages[0].id).toBe("post-1");
    });

    it("should handle errors gracefully", async () => {
      mockClient.fetchSearchPosts.mockRejectedValue(new Error("API Error"));

      const options = {
        agentId: TEST_AGENT_ID,
      };

      const messages = await service.getMessages(options);

      expect(messages).toEqual([]);
    });
  });

  describe("sendMessage", () => {
    it("should send a direct message", async () => {
      const mockResult = {
        id: "dm-123",
        text: "Hello DM",
      };

      mockClient.xClient.sendDirectMessage.mockResolvedValue(mockResult);

      const options = {
        agentId: TEST_AGENT_ID,
        roomId: TEST_ROOM_ID,
        text: "Hello DM",
        type: MessageType.DIRECT_MESSAGE,
      };

      const message = await service.sendMessage(options);

      // sendDirectMessage receives roomId.toString() which is the UUID string
      expect(mockClient.xClient.sendDirectMessage).toHaveBeenCalledWith(
        TEST_ROOM_ID.toString(),
        "Hello DM"
      );

      expect(message).toEqual({
        id: "dm-123",
        agentId: TEST_AGENT_ID,
        roomId: TEST_ROOM_ID,
        userId: "user-123",
        username: "testuser",
        text: "Hello DM",
        type: MessageType.DIRECT_MESSAGE,
        timestamp: expect.any(Number),
        inReplyTo: undefined,
        metadata: undefined,
      });
    });

    it("should send a post", async () => {
      const mockResult = {
        rest_id: "post-123",
      };

      mockClient.xClient.sendPost.mockResolvedValue(mockResult);

      const options = {
        agentId: TEST_AGENT_ID,
        roomId: TEST_ROOM_ID,
        text: "Hello Post",
        type: MessageType.POST,
        replyToId: "reply-to-123",
      };

      const message = await service.sendMessage(options);

      expect(mockClient.xClient.sendPost).toHaveBeenCalledWith("Hello Post", "reply-to-123");

      expect(message.id).toBe("post-123");
      expect(message.type).toBe(MessageType.POST);
    });
  });

  describe("deleteMessage", () => {
    it("should delete a message", async () => {
      await service.deleteMessage("post-123", TEST_AGENT_ID);

      expect(mockClient.xClient.deletePost).toHaveBeenCalledWith("post-123");
    });

    it("should throw error on failure", async () => {
      mockClient.xClient.deletePost.mockRejectedValue(new Error("Delete failed"));

      await expect(service.deleteMessage("post-123", TEST_AGENT_ID)).rejects.toThrow(
        "Delete failed"
      );
    });
  });

  describe("getMessage", () => {
    it("should fetch a single message", async () => {
      const mockPost = {
        id: "post-123",
        userId: "user-456",
        username: "someuser",
        text: "Hello World",
        conversationId: "conv-123",
        timestamp: 1234567890,
        inReplyToStatusId: "post-100",
        permanentUrl: "https://x.com/someuser/status/post-123",
      };

      mockClient.xClient.getPost.mockResolvedValue(mockPost);

      const message = await service.getMessage("post-123", TEST_AGENT_ID);

      expect(message).toEqual({
        id: "post-123",
        agentId: TEST_AGENT_ID,
        roomId: "uuid-conv-123",
        userId: "user-456",
        username: "someuser",
        text: "Hello World",
        type: MessageType.REPLY,
        timestamp: 1234567890000,
        inReplyTo: "post-100",
        metadata: {
          postId: "post-123",
          permanentUrl: "https://x.com/someuser/status/post-123",
        },
      });
    });

    it("should return null if post not found", async () => {
      mockClient.xClient.getPost.mockResolvedValue(null);

      const message = await service.getMessage("post-123", TEST_AGENT_ID);

      expect(message).toBeNull();
    });
  });

  describe("markAsRead", () => {
    it("should log that marking as read is not implemented", async () => {
      const { logger } = await import("@elizaos/core");
      const logSpy = vi.spyOn(logger, "debug").mockImplementation(() => {});

      await service.markAsRead(["post-1", "post-2"], TEST_AGENT_ID);

      expect(logSpy).toHaveBeenCalledWith("Marking messages as read is not implemented for X");

      logSpy.mockRestore();
    });
  });
});
