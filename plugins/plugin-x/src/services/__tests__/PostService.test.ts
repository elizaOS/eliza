import type { UUID } from "@elizaos/core";
import { beforeEach, describe, expect, it, type Mock, vi } from "vitest";
import type { ClientBase } from "../../base";
import { SearchMode } from "../../client";
import { TwitterPostService } from "../PostService";

vi.mock("@elizaos/core", () => ({
  createUniqueUuid: vi.fn((_runtime, id) => `uuid-${id}`),
  logger: {
    info: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
  },
}));

interface MockTwitterClient {
  sendTweet: Mock;
  uploadMedia: Mock;
  deleteTweet: Mock;
  getTweet: Mock;
  getUserTweets: Mock;
  likeTweet: Mock;
  retweet: Mock;
}

interface MockClientBase {
  runtime: { agentId: UUID };
  profile: { id: string; username: string } | null;
  fetchSearchTweets: Mock;
  fetchHomeTimeline: Mock;
  twitterClient: MockTwitterClient;
}

const AGENT_ID = "agent-123" as UUID;
const ROOM_ID = "room-123" as UUID;

describe("TwitterPostService", () => {
  let service: TwitterPostService;
  let mockClient: MockClientBase;

  beforeEach(() => {
    mockClient = {
      runtime: {
        agentId: AGENT_ID,
      },
      profile: {
        id: "user-123",
        username: "testuser",
      },
      fetchSearchTweets: vi.fn(),
      fetchHomeTimeline: vi.fn(),
      twitterClient: {
        sendTweet: vi.fn(),
        uploadMedia: vi.fn().mockResolvedValue("media-123"),
        deleteTweet: vi.fn(),
        getTweet: vi.fn(),
        getUserTweets: vi.fn(),
        likeTweet: vi.fn(),
        retweet: vi.fn(),
      },
    };

    service = new TwitterPostService(mockClient as unknown as ClientBase);
  });

  describe("createPost", () => {
    it("should create a new post", async () => {
      const mockResult = {
        data: {
          create_tweet: {
            tweet_results: {
              result: {
                rest_id: "tweet-123",
              },
            },
          },
        },
      };

      mockClient.twitterClient.sendTweet.mockResolvedValue(mockResult);

      const options = {
        agentId: AGENT_ID,
        roomId: ROOM_ID,
        text: "Hello World!",
      };

      const post = await service.createPost(options);

      expect(mockClient.twitterClient.sendTweet).toHaveBeenCalledWith(
        "Hello World!",
        undefined,
      );

      expect(post).toEqual({
        id: "tweet-123",
        agentId: "agent-123",
        roomId: "room-123",
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

    it("should not consume a Response-like body when extracting tweet id (uses clone)", async () => {
      const body = { id: "tweet-999" };
      interface ResponseLike {
        bodyUsed: boolean;
        clone: Mock;
        json: Mock;
      }
      const responseLike: ResponseLike = {
        bodyUsed: false,
        clone: vi.fn(() => ({
          json: vi.fn(async () => body),
        })),
        json: vi.fn(async () => body),
      };

      mockClient.twitterClient.sendTweet.mockResolvedValue(responseLike);

      const options = {
        agentId: AGENT_ID,
        roomId: ROOM_ID,
        text: "Hello World!",
      };

      const post = await service.createPost(options);
      expect(post.id).toBe("tweet-999");
      expect(responseLike.clone).toHaveBeenCalled();
      expect(responseLike.json).not.toHaveBeenCalled();
    });

    it("should create a reply post", async () => {
      const mockResult = { id: "tweet-456" };

      mockClient.twitterClient.sendTweet.mockResolvedValue(mockResult);

      const options = {
        agentId: AGENT_ID,
        roomId: ROOM_ID,
        text: "This is a reply",
        inReplyTo: "tweet-789",
      };

      const post = await service.createPost(options);

      expect(mockClient.twitterClient.sendTweet).toHaveBeenCalledWith(
        "This is a reply",
        "tweet-789",
      );

      expect(post.inReplyTo).toBe("tweet-789");
    });

    it("should upload media and pass media IDs to sendTweet", async () => {
      const mockResult = { id: "tweet-123" };
      mockClient.twitterClient.sendTweet.mockResolvedValue(mockResult);

      const options = {
        agentId: AGENT_ID,
        roomId: ROOM_ID,
        text: "Post with media",
        media: [{ data: Buffer.from("image"), type: "image/png" }],
      };

      await service.createPost(options);

      expect(mockClient.twitterClient.uploadMedia).toHaveBeenCalledWith(
        options.media[0].data,
        { mimeType: "image/png" },
      );
      expect(mockClient.twitterClient.sendTweet).toHaveBeenCalledWith(
        "Post with media",
        undefined,
        options.media.map((m) => ({ data: m.data, mediaType: m.type })),
        false,
        ["media-123"],
      );
    });
  });

  describe("deletePost", () => {
    it("should delete a post", async () => {
      await service.deletePost("tweet-123", AGENT_ID);

      expect(mockClient.twitterClient.deleteTweet).toHaveBeenCalledWith(
        "tweet-123",
      );
    });

    it("should throw error on failure", async () => {
      mockClient.twitterClient.deleteTweet.mockRejectedValue(
        new Error("Delete failed"),
      );

      await expect(service.deletePost("tweet-123", AGENT_ID)).rejects.toThrow(
        "Delete failed",
      );
    });
  });

  describe("getPost", () => {
    it("should fetch a single post", async () => {
      const mockTweet = {
        id: "tweet-123",
        userId: "user-456",
        username: "someuser",
        text: "Hello World",
        timestamp: 1234567890,
        likes: 10,
        retweets: 5,
        replies: 3,
        quotes: 2,
        views: 100,
        photos: [{ id: "photo-1", url: "https://example.com/photo.jpg" }],
        conversationId: "conv-123",
        permanentUrl: "https://twitter.com/someuser/status/tweet-123",
      };

      mockClient.twitterClient.getTweet.mockResolvedValue(mockTweet);

      const post = await service.getPost("tweet-123", AGENT_ID);

      expect(post).toEqual({
        id: "tweet-123",
        agentId: "agent-123",
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
          permanentUrl: "https://twitter.com/someuser/status/tweet-123",
        },
      });
    });

    it("should return null if post not found", async () => {
      mockClient.twitterClient.getTweet.mockResolvedValue(null);

      const post = await service.getPost("tweet-123", AGENT_ID);

      expect(post).toBeNull();
    });
  });

  describe("getPosts", () => {
    it("should fetch posts from a specific user", async () => {
      const mockTweets = [
        {
          id: "tweet-1",
          userId: "user-456",
          username: "someuser",
          text: "Tweet 1",
          timestamp: 1234567890,
          likes: 5,
          retweets: 2,
          replies: 1,
          views: 50,
        },
        {
          id: "tweet-2",
          userId: "user-456",
          username: "someuser",
          text: "Tweet 2",
          timestamp: 1234567891,
          likes: 10,
          retweets: 3,
          replies: 2,
          views: 100,
        },
      ];

      mockClient.twitterClient.getUserTweets.mockResolvedValue({
        tweets: mockTweets,
      });

      const options = {
        agentId: AGENT_ID,
        userId: "user-456",
        limit: 10,
      };

      const posts = await service.getPosts(options);

      expect(mockClient.twitterClient.getUserTweets).toHaveBeenCalledWith(
        "user-456",
        10,
        undefined,
      );

      expect(posts).toHaveLength(2);
      expect(posts[0].id).toBe("tweet-1");
      expect(posts[1].id).toBe("tweet-2");
    });

    it("should fetch home timeline when no userId specified", async () => {
      const mockTweets = [
        {
          id: "tweet-1",
          userId: "user-789",
          username: "anotheruser",
          text: "Timeline tweet",
          timestamp: 1234567890,
          conversationId: "conv-1",
          permanentUrl: "https://twitter.com/anotheruser/status/tweet-1",
        },
      ];

      mockClient.fetchHomeTimeline.mockResolvedValue(mockTweets);

      const options = {
        agentId: AGENT_ID,
        limit: 20,
      };

      const posts = await service.getPosts(options);

      expect(mockClient.fetchHomeTimeline).toHaveBeenCalledWith(20, false);
      expect(posts).toHaveLength(1);
    });

    it("should handle errors gracefully", async () => {
      mockClient.fetchHomeTimeline.mockRejectedValue(new Error("API Error"));

      const options = {
        agentId: AGENT_ID,
      };

      const posts = await service.getPosts(options);

      expect(posts).toEqual([]);
    });
  });

  describe("likePost", () => {
    it("should like a post", async () => {
      await service.likePost("tweet-123", AGENT_ID);

      expect(mockClient.twitterClient.likeTweet).toHaveBeenCalledWith(
        "tweet-123",
      );
    });

    it("should throw error on failure", async () => {
      mockClient.twitterClient.likeTweet.mockRejectedValue(
        new Error("Like failed"),
      );

      await expect(service.likePost("tweet-123", AGENT_ID)).rejects.toThrow(
        "Like failed",
      );
    });
  });

  describe("repost", () => {
    it("should repost a tweet", async () => {
      await service.repost("tweet-123", AGENT_ID);

      expect(mockClient.twitterClient.retweet).toHaveBeenCalledWith(
        "tweet-123",
      );
    });

    it("should throw error on failure", async () => {
      mockClient.twitterClient.retweet.mockRejectedValue(
        new Error("Retweet failed"),
      );

      await expect(service.repost("tweet-123", AGENT_ID)).rejects.toThrow(
        "Retweet failed",
      );
    });
  });

  describe("getMentions", () => {
    it("should fetch mentions", async () => {
      const mockTweets = [
        {
          id: "tweet-1",
          userId: "user-456",
          username: "otheruser",
          text: "@testuser mentioned you",
          timestamp: 1234567890,
          likes: 5,
          retweets: 2,
          replies: 1,
          views: 50,
          conversationId: "conv-1",
          permanentUrl: "https://twitter.com/otheruser/status/tweet-1",
        },
      ];

      mockClient.fetchSearchTweets.mockResolvedValue({
        tweets: mockTweets,
      });

      const posts = await service.getMentions(AGENT_ID);

      expect(mockClient.fetchSearchTweets).toHaveBeenCalledWith(
        "@testuser",
        20,
        SearchMode.Latest,
        undefined,
      );

      expect(posts).toHaveLength(1);
      expect(posts[0].metadata?.isMention).toBe(true);
    });

    it("should return empty array if no profile", async () => {
      mockClient.profile = null;

      const posts = await service.getMentions(AGENT_ID);

      expect(posts).toEqual([]);
    });
  });
});
