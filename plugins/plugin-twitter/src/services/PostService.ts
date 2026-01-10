import { type UUID, createUniqueUuid, logger } from "@elizaos/core";
import { getEpochMs } from "../utils/time";
import {
  type IPostService,
  type Post,
  type GetPostsOptions,
  type CreatePostOptions,
} from "./IPostService";
import type { ClientBase } from "../base";
import { SearchMode } from "../client";

export class TwitterPostService implements IPostService {
  constructor(private client: ClientBase) {}

  private async safeParseJsonResponse(result: any): Promise<any | undefined> {
    try {
      // If this is a real Fetch Response, avoid consuming the original body.
      if (result?.clone && typeof result.clone === "function") {
        // If body is already used, clone() may throw; guard defensively.
        if (result?.bodyUsed === true) return undefined;
        const cloned = result.clone();
        if (cloned?.json && typeof cloned.json === "function") {
          return await cloned.json();
        }
        return undefined;
      }

      // Non-Response shapes (e.g. our internal wrappers) may expose json() but do not consume streams.
      if (result?.json && typeof result.json === "function") {
        return await result.json();
      }
      return undefined;
    } catch {
      return undefined;
    }
  }

  private extractRestId(result: any): string | undefined {
    return (
      result?.rest_id ??
      result?.data?.create_tweet?.tweet_results?.result?.rest_id ??
      result?.data?.data?.create_tweet?.tweet_results?.result?.rest_id ??
      undefined
    );
  }

  private async extractTweetId(result: any): Promise<string | undefined> {
    const direct =
      result?.id ?? result?.data?.id ?? result?.data?.data?.id ?? undefined;
    if (direct) return direct;
    const restId = this.extractRestId(result);
    if (restId) return restId;

    // Some callers return a Response-like shape with a json() function.
    if (result?.json && typeof result.json === "function") {
      const body = await this.safeParseJsonResponse(result);
      return (
        body?.id ??
        body?.data?.id ??
        body?.data?.data?.id ??
        this.extractRestId(body) ??
        undefined
      );
    }

    return undefined;
  }

  async createPost(options: CreatePostOptions): Promise<Post> {
    try {
      // Handle media uploads if needed
      const mediaIds: string[] = [];

      if (options.media && options.media.length > 0) {
        // TODO: Implement media upload when Twitter API v2 support is added
        logger.warn("Media upload not currently supported with Twitter API v2");
      }

      const result = await this.client.twitterClient.sendTweet(
        options.text,
        options.inReplyTo,
        // TODO: Add media support when available
      );

      const tweetId = await this.extractTweetId(result);
      if (!tweetId) {
        const safeResult =
          typeof result === "string"
            ? result
            : JSON.stringify(result, null, 2).slice(0, 8000);
        logger.error(
          "Twitter createPost: could not extract tweet id from API result",
          { inReplyTo: options.inReplyTo, textLength: options.text?.length },
          safeResult,
        );
        throw new Error(
          "Twitter createPost failed: could not extract tweet id from API response. See logs for raw response.",
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
      logger.error("Error creating post:", error);
      throw error;
    }
  }

  async deletePost(postId: string, agentId: UUID): Promise<void> {
    try {
      await this.client.twitterClient.deleteTweet(postId);
    } catch (error) {
      logger.error("Error deleting post:", error);
      throw error;
    }
  }

  async getPost(postId: string, agentId: UUID): Promise<Post | null> {
    try {
      const tweet = await this.client.twitterClient.getTweet(postId);

      if (!tweet) return null;

      const post: Post = {
        id: tweet.id,
        agentId: agentId,
        roomId: createUniqueUuid(
          this.client.runtime,
          tweet.conversationId || tweet.id,
        ),
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
      logger.error("Error fetching post:", error);
      return null;
    }
  }

  async getPosts(options: GetPostsOptions): Promise<Post[]> {
    try {
      let tweets;

      if (options.userId) {
        // Get tweets from a specific user
        const result = await this.client.twitterClient.getUserTweets(
          options.userId,
          options.limit || 20,
          options.before,
        );
        tweets = result.tweets;
      } else {
        // Get home timeline or search results
        tweets = await this.client.fetchHomeTimeline(
          options.limit || 20,
          false,
        );
      }

      const posts: Post[] = tweets.map((tweet) => ({
        id: tweet.id,
        agentId: options.agentId,
        roomId: createUniqueUuid(
          this.client.runtime,
          tweet.conversationId || tweet.id,
        ),
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
      }));

      return posts;
    } catch (error) {
      logger.error("Error fetching posts:", error);
      return [];
    }
  }

  async likePost(postId: string, agentId: UUID): Promise<void> {
    try {
      await this.client.twitterClient.likeTweet(postId);
    } catch (error) {
      logger.error("Error liking post:", error);
      throw error;
    }
  }

  async repost(postId: string, agentId: UUID): Promise<void> {
    try {
      await this.client.twitterClient.retweet(postId);
    } catch (error) {
      logger.error("Error reposting:", error);
      throw error;
    }
  }

  async getMentions(
    agentId: UUID,
    options?: Partial<GetPostsOptions>,
  ): Promise<Post[]> {
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
        options?.before,
      );

      const posts: Post[] = searchResult.tweets.map((tweet) => ({
        id: tweet.id,
        agentId: agentId,
        roomId: createUniqueUuid(
          this.client.runtime,
          tweet.conversationId || tweet.id,
        ),
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
      logger.error("Error fetching mentions:", error);
      return [];
    }
  }

  async unlikePost(postId: string, agentId: UUID): Promise<void> {
    try {
      // Twitter API v2 doesn't have a direct unlike method in the Client wrapper
      // This would need to be implemented using the Twitter API v2 endpoints
      logger.warn("Unlike functionality not yet implemented");
      throw new Error("Unlike functionality not yet implemented");
    } catch (error) {
      logger.error("Error unliking post:", error);
      throw error;
    }
  }

  async unrepost(postId: string, agentId: UUID): Promise<void> {
    try {
      // Twitter API v2 doesn't have a direct unretweet method in the Client wrapper
      // This would need to be implemented using the Twitter API v2 endpoints
      logger.warn("Unrepost functionality not yet implemented");
      throw new Error("Unrepost functionality not yet implemented");
    } catch (error) {
      logger.error("Error unreposting:", error);
      throw error;
    }
  }
}
