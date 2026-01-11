import { createUniqueUuid, logger, type UUID } from "@elizaos/core";
import type { ClientBase } from "../base";
import { SearchMode } from "../client";
import { extractIdFromResult, extractRestId, isResponseLike, type TweetResponse } from "../types";
import { getEpochMs } from "../utils/time";
import type { CreatePostOptions, GetPostsOptions, IPostService, Post } from "./IPostService";

export class TwitterPostService implements IPostService {
  constructor(private client: ClientBase) {}

  /**
   * Safely parse JSON from a Response-like object without consuming the original body
   */
  private async safeParseJsonResponse(result: unknown): Promise<unknown | undefined> {
    if (!isResponseLike(result)) return undefined;

    try {
      // If this is a real Fetch Response, avoid consuming the original body.
      if (result.clone && typeof result.clone === "function") {
        // If body is already used, clone() may throw; guard defensively.
        if (result.bodyUsed === true) return undefined;
        const cloned = result.clone();
        if (cloned?.json && typeof cloned.json === "function") {
          return await cloned.json();
        }
        return undefined;
      }

      // Non-Response shapes (e.g. our internal wrappers) may expose json() but do not consume streams.
      if (result.json && typeof result.json === "function") {
        return await result.json();
      }
      return undefined;
    } catch {
      return undefined;
    }
  }

  /**
   * Extract tweet ID from various Twitter API response shapes
   */
  private async extractTweetId(result: TweetResponse | unknown): Promise<string | undefined> {
    // First try direct extraction using type-safe utility
    const directId = extractIdFromResult(result);
    if (directId) return directId;

    // Check for rest_id
    const restId = extractRestId(result);
    if (restId) return restId;

    // Some callers return a Response-like shape with a json() function.
    if (isResponseLike(result)) {
      const body = await this.safeParseJsonResponse(result);
      const bodyId = extractIdFromResult(body);
      if (bodyId) return bodyId;

      const bodyRestId = extractRestId(body);
      if (bodyRestId) return bodyRestId;
    }

    return undefined;
  }

  async createPost(options: CreatePostOptions): Promise<Post> {
    try {
      // Handle media uploads if needed
      const _mediaIds: string[] = [];

      if (options.media && options.media.length > 0) {
        logger.warn("Media upload not currently supported with Twitter API v2");
      }

      const result = await this.client.twitterClient.sendTweet(
        options.text,
        options.inReplyTo
      );

      const tweetId = await this.extractTweetId(result);
      if (!tweetId) {
        const safeResult =
          typeof result === "string" ? result : JSON.stringify(result, null, 2).slice(0, 8000);
        logger.error("Twitter createPost: could not extract tweet id from API result", safeResult);
        throw new Error(
          "Twitter createPost failed: could not extract tweet id from API response. See logs for raw response."
        );
      }

      const post: Post = {
        id: tweetId,
        agentId: options.agentId,
        roomId: options.roomId,
        userId: this.client.profile?.id || "",
        username: this.client.profile?.username || "",
        text: options.text,
        timestamp: Date.now(),
        inReplyTo: options.inReplyTo,
        quotedPostId: options.quotedPostId,
        metrics: {
          likes: 0,
          reposts: 0,
          replies: 0,
          quotes: 0,
          views: 0,
        },
        media: [],
        metadata: {
          raw: result,
        },
      };

      return post;
    } catch (error) {
      logger.error("Error creating post:", error instanceof Error ? error.message : String(error));
      throw error;
    }
  }

  async deletePost(postId: string, _agentId: UUID): Promise<void> {
    try {
      await this.client.twitterClient.deleteTweet(postId);
    } catch (error) {
      logger.error("Error deleting post:", error instanceof Error ? error.message : String(error));
      throw error;
    }
  }

  async getPost(postId: string, agentId: UUID): Promise<Post | null> {
    try {
      const tweet = await this.client.twitterClient.getTweet(postId);

      if (!tweet || !tweet.id || !tweet.userId || !tweet.username || !tweet.text) {
        return null;
      }

      const post: Post = {
        id: tweet.id,
        agentId: agentId,
        roomId: createUniqueUuid(this.client.runtime, tweet.conversationId || tweet.id),
        userId: tweet.userId,
        username: tweet.username,
        text: tweet.text,
        timestamp: getEpochMs(tweet.timestamp),
        metrics: {
          likes: tweet.likes || 0,
          reposts: tweet.retweets || 0,
          replies: tweet.replies || 0,
          quotes: tweet.quotes || 0,
          views: tweet.views || 0,
        },
        media:
          tweet.photos?.map((photo) => ({
            type: "image" as const,
            url: photo.url,
            metadata: { id: photo.id },
          })) || [],
        metadata: {
          conversationId: tweet.conversationId,
          permanentUrl: tweet.permanentUrl,
        },
      };

      return post;
    } catch (error) {
      logger.error("Error fetching post:", error instanceof Error ? error.message : String(error));
      return null;
    }
  }

  async getPosts(options: GetPostsOptions): Promise<Post[]> {
    /** Shape of partial tweet data from Twitter API */
    interface PartialTweet {
      id?: string;
      userId?: string;
      username?: string;
      text?: string;
      timestamp?: number;
      conversationId?: string;
      likes?: number;
      retweets?: number;
      quotes?: number;
      replies?: number;
      views?: number;
      photos?: Array<{ url: string; id: string }>;
      permanentUrl?: string;
      media?: Array<{ type?: string; url?: string }>;
    }

    /** Type guard for tweets with required fields */
    function hasRequiredFields(
      tweet: PartialTweet
    ): tweet is PartialTweet & { id: string; userId: string; username: string; text: string } {
      return Boolean(tweet.id && tweet.userId && tweet.username && tweet.text);
    }

    try {
      let tweets: PartialTweet[] | undefined;

      if (options.userId) {
        // Get tweets from a specific user
        const result = await this.client.twitterClient.getUserTweets(
          options.userId,
          options.limit || 20,
          options.before
        );
        tweets = result.tweets;
      } else {
        // Get home timeline or search results
        tweets = await this.client.fetchHomeTimeline(options.limit || 20, false);
      }

      if (!tweets) return [];

      const posts: Post[] = tweets.filter(hasRequiredFields).map((tweet) => ({
        id: tweet.id,
        agentId: options.agentId,
        roomId: createUniqueUuid(this.client.runtime, tweet.conversationId || tweet.id),
        userId: tweet.userId,
        username: tweet.username,
        text: tweet.text,
        timestamp: getEpochMs(tweet.timestamp),
        metrics: {
          likes: tweet.likes ?? 0,
          reposts: tweet.retweets ?? 0,
          replies: tweet.replies ?? 0,
          quotes: tweet.quotes ?? 0,
          views: tweet.views ?? 0,
        },
        media:
          tweet.photos?.map((photo) => ({
            type: "image" as const,
            url: photo.url,
            metadata: { id: photo.id },
          })) ?? [],
        metadata: {
          conversationId: tweet.conversationId,
          permanentUrl: tweet.permanentUrl,
        },
      }));

      return posts;
    } catch (error) {
      logger.error("Error fetching posts:", error instanceof Error ? error.message : String(error));
      return [];
    }
  }

  async likePost(postId: string, _agentId: UUID): Promise<void> {
    try {
      await this.client.twitterClient.likeTweet(postId);
    } catch (error) {
      logger.error("Error liking post:", error instanceof Error ? error.message : String(error));
      throw error;
    }
  }

  async repost(postId: string, _agentId: UUID): Promise<void> {
    try {
      await this.client.twitterClient.retweet(postId);
    } catch (error) {
      logger.error("Error reposting:", error instanceof Error ? error.message : String(error));
      throw error;
    }
  }

  async getMentions(agentId: UUID, options?: Partial<GetPostsOptions>): Promise<Post[]> {
    try {
      const username = this.client.profile?.username;
      if (!username) {
        logger.error("No Twitter profile available");
        return [];
      }

      const searchResult = await this.client.fetchSearchTweets(
        `@${username}`,
        options?.limit || 20,
        SearchMode.Latest,
        options?.before
      );

      const posts: Post[] = searchResult.tweets
        .filter(
          (
            tweet
          ): tweet is typeof tweet & {
            id: string;
            userId: string;
            username: string;
            text: string;
          } => !!(tweet.id && tweet.userId && tweet.username && tweet.text)
        )
        .map((tweet) => ({
          id: tweet.id,
          agentId: agentId,
          roomId: createUniqueUuid(this.client.runtime, tweet.conversationId || tweet.id),
          userId: tweet.userId,
          username: tweet.username,
          text: tweet.text,
          timestamp: getEpochMs(tweet.timestamp),
          metrics: {
            likes: tweet.likes || 0,
            reposts: tweet.retweets || 0,
            replies: tweet.replies || 0,
            quotes: tweet.quotes || 0,
            views: tweet.views || 0,
          },
          media:
            tweet.photos?.map((photo) => ({
              type: "image" as const,
              url: photo.url,
              metadata: { id: photo.id },
            })) || [],
          metadata: {
            conversationId: tweet.conversationId,
            permanentUrl: tweet.permanentUrl,
            isMention: true,
          },
        }));

      return posts;
    } catch (error) {
      logger.error(
        "Error fetching mentions:",
        error instanceof Error ? error.message : String(error)
      );
      return [];
    }
  }

  async unlikePost(postId: string, _agentId: UUID): Promise<void> {
    try {
      await this.client.twitterClient.unlikeTweet(postId);
    } catch (error) {
      logger.error("Error unliking post:", error instanceof Error ? error.message : String(error));
      throw error;
    }
  }

  async unrepost(postId: string, _agentId: UUID): Promise<void> {
    try {
      await this.client.twitterClient.unretweet(postId);
    } catch (error) {
      logger.error("Error unreposting:", error instanceof Error ? error.message : String(error));
      throw error;
    }
  }
}
