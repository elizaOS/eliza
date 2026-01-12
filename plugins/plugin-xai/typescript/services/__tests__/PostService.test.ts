import { stringToUuid } from "@elizaos/core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ClientBase } from "../../base";
import { SearchMode } from "../../client";
import { XPostService } from "../PostService";

// Mock the dependencies
vi.mock("@elizaos/core", async () => {
  const actual = await vi.importActual<typeof import("@elizaos/core")>("@elizaos/core");
  return {
    ...actual,
    createUniqueUuid: vi.fn((_runtime, id) => `uuid-${id}`),
    logger: {
      error: vi.fn(),
      warn: vi.fn(),
    },
  };
});

// Test UUIDs - use stringToUuid to create proper UUID types
const TEST_AGENT_ID = stringToUuid("agent-123");
const TEST_ROOM_ID = stringToUuid("room-123");

interface MockClient {
  runtime: {
    agentId: string;
  };
  profile: {
    id: string;
    username: string;
  } | null;
  fetchSearchPosts: ReturnType<typeof vi.fn>;
  fetchHomeTimeline: ReturnType<typeof vi.fn>;
  xClient: {
    sendPost: ReturnType<typeof vi.fn>;
    deletePost: ReturnType<typeof vi.fn>;
    getPost: ReturnType<typeof vi.fn>;
    getUserPosts: ReturnType<typeof vi.fn>;
    likePost: ReturnType<typeof vi.fn>;
    repost: ReturnType<typeof vi.fn>;
  };
}

// Helper function to convert MockClient to ClientBase for testing
function asClientBase(client: MockClient): ClientBase {
  return client as ClientBase;
}

describe("XPostService", () => {
  let service: XPostService;
  let mockClient: MockClient;

  beforeEach(() => {
    // Create mock client
    mockClient = {
      runtime: {
        agentId: "agent-123",
      },
      profile: {
        id: "user-123",
        username: "testuser",
      },
      fetchSearchPosts: vi.fn(),
      fetchHomeTimeline: vi.fn(),
      xClient: {
        sendPost: vi.fn(),
        deletePost: vi.fn(),
        getPost: vi.fn(),
        getUserPosts: vi.fn(),
        likePost: vi.fn(),
        repost: vi.fn(),
      },
    };

    service = new XPostService(asClientBase(mockClient));
  });

  describe("createPost", () => {
    it("should create a new post", async () => {
      const mockResult = {
        data: {
          create_post: {
            post_results: {
              result: {
                rest_id: "post-123",
              },
            },
          },
        },
      };

      mockClient.xClient.sendPost.mockResolvedValue(mockResult);

      const options = {
        agentId: TEST_AGENT_ID,
        roomId: TEST_ROOM_ID,
        text: "Hello World!",
      };

      const post = await service.createPost(options);

      expect(mockClient.xClient.sendPost).toHaveBeenCalledWith("Hello World!", undefined);

      expect(post).toEqual({
        id: "post-123",
        agentId: TEST_AGENT_ID,
        roomId: TEST_ROOM_ID,
        userId: "user-123",
        username: "testuser",
        text: "Hello World!",
        timestamp: expect.any(Number),
        inReplyTo: undefined,
        quotedPostId: undefined,
        metrics: {
          likes: 0,
          reposts: 0,
          replies: 0,
          quotes: 0,
          views: 0,
        },
        media: [],
        metadata: {
          raw: mockResult,
        },
      });
    });

    it("should not consume a Response-like body when extracting post id (uses clone)", async () => {
      const body = { id: "post-999" };
      interface ResponseLike {
        bodyUsed: boolean;
        clone: () => { json: () => Promise<typeof body> };
        json: () => Promise<typeof body>;
      }
      const responseLike: ResponseLike = {
        bodyUsed: false,
        clone: vi.fn(() => ({
          json: vi.fn(async () => body),
        })),
        json: vi.fn(async () => body), // would consume in real Response; here we ensure clone() path is used
      };

      mockClient.xClient.sendPost.mockResolvedValue(responseLike);

      const options = {
        agentId: TEST_AGENT_ID,
        roomId: TEST_ROOM_ID,
        text: "Hello World!",
      };

      const post = await service.createPost(options);
      expect(post.id).toBe("post-999");
      expect(responseLike.clone).toHaveBeenCalled();
      expect(responseLike.json).not.toHaveBeenCalled();
    });

    it("should create a reply post", async () => {
      const mockResult = { id: "post-456" };

      mockClient.xClient.sendPost.mockResolvedValue(mockResult);

      const options = {
        agentId: TEST_AGENT_ID,
        roomId: TEST_ROOM_ID,
        text: "This is a reply",
        inReplyTo: "post-789",
      };

      const post = await service.createPost(options);

      expect(mockClient.xClient.sendPost).toHaveBeenCalledWith("This is a reply", "post-789");

      expect(post.inReplyTo).toBe("post-789");
    });

    it("should warn about media uploads", async () => {
      const { logger } = await import("@elizaos/core");
      const warnSpy = vi.spyOn(logger, "warn").mockImplementation(() => {});

      const mockResult = { id: "post-123" };
      mockClient.xClient.sendPost.mockResolvedValue(mockResult);

      const options = {
        agentId: TEST_AGENT_ID,
        roomId: TEST_ROOM_ID,
        text: "Post with media",
        media: [{ data: Buffer.from("image"), type: "image/png" }],
      };

      await service.createPost(options);

      expect(warnSpy).toHaveBeenCalledWith("Media upload not currently supported with X API v2");

      warnSpy.mockRestore();
    });
  });

  describe("deletePost", () => {
    it("should delete a post", async () => {
      await service.deletePost("post-123", TEST_AGENT_ID);

      expect(mockClient.xClient.deletePost).toHaveBeenCalledWith("post-123");
    });

    it("should throw error on failure", async () => {
      mockClient.xClient.deletePost.mockRejectedValue(new Error("Delete failed"));

      await expect(service.deletePost("post-123", TEST_AGENT_ID)).rejects.toThrow("Delete failed");
    });
  });

  describe("getPost", () => {
    it("should fetch a single post", async () => {
      const mockPost = {
        id: "post-123",
        userId: "user-456",
        username: "someuser",
        text: "Hello World",
        timestamp: 1234567890,
        likes: 10,
        reposts: 5,
        replies: 3,
        quotes: 2,
        views: 100,
        photos: [{ id: "photo-1", url: "https://example.com/photo.jpg" }],
        conversationId: "conv-123",
        permanentUrl: "https://x.com/someuser/status/post-123",
      };

      mockClient.xClient.getPost.mockResolvedValue(mockPost);

      const post = await service.getPost("post-123", TEST_AGENT_ID);

      expect(post).toEqual({
        id: "post-123",
        agentId: TEST_AGENT_ID,
        roomId: "uuid-conv-123",
        userId: "user-456",
        username: "someuser",
        text: "Hello World",
        timestamp: 1234567890000,
        metrics: {
          likes: 10,
          reposts: 5,
          replies: 3,
          quotes: 2,
          views: 100,
        },
        media: [
          {
            type: "image",
            url: "https://example.com/photo.jpg",
            metadata: { id: "photo-1" },
          },
        ],
        metadata: {
          conversationId: "conv-123",
          permanentUrl: "https://x.com/someuser/status/post-123",
        },
      });
    });

    it("should return null if post not found", async () => {
      mockClient.xClient.getPost.mockResolvedValue(null);

      const post = await service.getPost("post-123", TEST_AGENT_ID);

      expect(post).toBeNull();
    });
  });

  describe("getPosts", () => {
    it("should fetch posts from a specific user", async () => {
      const mockPosts = [
        {
          id: "post-1",
          userId: "user-456",
          username: "someuser",
          text: "Post 1",
          timestamp: 1234567890,
          likes: 5,
          reposts: 2,
          replies: 1,
          views: 50,
        },
        {
          id: "post-2",
          userId: "user-456",
          username: "someuser",
          text: "Post 2",
          timestamp: 1234567891,
          likes: 10,
          reposts: 3,
          replies: 2,
          views: 100,
        },
      ];

      mockClient.xClient.getUserPosts.mockResolvedValue({
        posts: mockPosts,
      });

      const options = {
        agentId: TEST_AGENT_ID,
        userId: "user-456",
        limit: 10,
      };

      const posts = await service.getPosts(options);

      expect(mockClient.xClient.getUserPosts).toHaveBeenCalledWith("user-456", 10, undefined);

      expect(posts).toHaveLength(2);
      expect(posts[0].id).toBe("post-1");
      expect(posts[1].id).toBe("post-2");
    });

    it("should fetch home timeline when no userId specified", async () => {
      const mockPosts = [
        {
          id: "post-1",
          userId: "user-789",
          username: "anotheruser",
          text: "Timeline post",
          timestamp: 1234567890,
          conversationId: "conv-1",
          permanentUrl: "https://x.com/anotheruser/status/post-1",
        },
      ];

      mockClient.fetchHomeTimeline.mockResolvedValue(mockPosts);

      const options = {
        agentId: TEST_AGENT_ID,
        limit: 20,
      };

      const posts = await service.getPosts(options);

      expect(mockClient.fetchHomeTimeline).toHaveBeenCalledWith(20, false);
      expect(posts).toHaveLength(1);
    });

    it("should handle errors gracefully", async () => {
      mockClient.fetchHomeTimeline.mockRejectedValue(new Error("API Error"));

      const options = {
        agentId: TEST_AGENT_ID,
      };

      const posts = await service.getPosts(options);

      expect(posts).toEqual([]);
    });
  });

  describe("likePost", () => {
    it("should like a post", async () => {
      await service.likePost("post-123", TEST_AGENT_ID);

      expect(mockClient.xClient.likePost).toHaveBeenCalledWith("post-123");
    });

    it("should throw error on failure", async () => {
      mockClient.xClient.likePost.mockRejectedValue(new Error("Like failed"));

      await expect(service.likePost("post-123", TEST_AGENT_ID)).rejects.toThrow("Like failed");
    });
  });

  describe("repost", () => {
    it("should repost a post", async () => {
      await service.repost("post-123", TEST_AGENT_ID);

      expect(mockClient.xClient.repost).toHaveBeenCalledWith("post-123");
    });

    it("should throw error on failure", async () => {
      mockClient.xClient.repost.mockRejectedValue(new Error("Repost failed"));

      await expect(service.repost("post-123", TEST_AGENT_ID)).rejects.toThrow("Repost failed");
    });
  });

  describe("getMentions", () => {
    it("should fetch mentions", async () => {
      const mockPosts = [
        {
          id: "post-1",
          userId: "user-456",
          username: "otheruser",
          text: "@testuser mentioned you",
          timestamp: 1234567890,
          likes: 5,
          reposts: 2,
          replies: 1,
          views: 50,
          conversationId: "conv-1",
          permanentUrl: "https://x.com/otheruser/status/post-1",
        },
      ];

      mockClient.fetchSearchPosts.mockResolvedValue({
        posts: mockPosts,
      });

      const posts = await service.getMentions(TEST_AGENT_ID);

      expect(mockClient.fetchSearchPosts).toHaveBeenCalledWith(
        "@testuser",
        20,
        SearchMode.Latest,
        undefined
      );

      expect(posts).toHaveLength(1);
      const firstPost = posts[0];
      if (!firstPost) {
        throw new Error("Expected first post to exist");
      }
      expect(firstPost.metadata?.isMention).toBe(true);
    });

    it("should return empty array if no profile", async () => {
      mockClient.profile = null;

      const posts = await service.getMentions(TEST_AGENT_ID);

      expect(posts).toEqual([]);
    });
  });
});
