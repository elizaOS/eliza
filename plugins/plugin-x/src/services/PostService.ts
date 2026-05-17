import { createUniqueUuid, logger, type UUID } from "@elizaos/core";
import type { ClientBase } from "../base";
import { SearchMode } from "../client";
import { getEpochMs } from "../utils/time";
import type {
  CreatePostOptions,
  GetPostsOptions,
  IPostService,
  Post,
} from "./IPostService";

export class TwitterPostService implements IPostService {
  constructor(private client: ClientBase) {}

  private errorDetail(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }

  private async safeParseJsonResponse(
    result: unknown,
  ): Promise<unknown | undefined> {
    try {
      const asRecord = (v: unknown): Record<string, unknown> =>
        typeof v === "object" && v !== null
          ? (v as Record<string, unknown>)
          : {};
      const recordResult = asRecord(result);

      if (typeof recordResult.clone === "function") {
        // If body is already used, clone() may throw; guard defensively.
        if (recordResult.bodyUsed === true) return undefined;
        const cloned = (recordResult.clone as () => unknown)();
        const clonedRecord = asRecord(cloned);
        if (typeof clonedRecord.json === "function") {
          return await (clonedRecord.json as () => Promise<unknown>)();
        }
        return undefined;
      }

      // Non-Response shapes (e.g. our internal wrappers) may expose json()
      // but do not consume streams.
      if (typeof recordResult.json === "function") {
        return await (recordResult.json as () => Promise<unknown>)();
      }
      return undefined;
    } catch {
      return undefined;
    }
  }

  private extractRestId(result: unknown): string | undefined {
    const r = result as {
      rest_id?: unknown;
      data?: {
        create_tweet?: { tweet_results?: { result?: { rest_id?: unknown } } };
        data?: {
          create_tweet?: { tweet_results?: { result?: { rest_id?: unknown } } };
        };
      };
    } | null;
    const candidate =
      r?.rest_id ??
      r?.data?.create_tweet?.tweet_results?.result?.rest_id ??
      r?.data?.data?.create_tweet?.tweet_results?.result?.rest_id;
    return typeof candidate === "string" ? candidate : undefined;
  }

  private async extractTweetId(result: unknown): Promise<string | undefined> {
    const r = result as {
      id?: unknown;
      data?: { id?: unknown; data?: { id?: unknown } };
      json?: unknown;
    } | null;
    const direct = r?.id ?? r?.data?.id ?? r?.data?.data?.id;
    if (typeof direct === "string") return direct;
    const restId = this.extractRestId(result);
    if (restId) return restId;

    if (r && typeof r.json === "function") {
      const body = (await this.safeParseJsonResponse(result)) as {
        id?: unknown;
        data?: { id?: unknown; data?: { id?: unknown } };
      } | null;
      const viaBody = body?.id ?? body?.data?.id ?? body?.data?.data?.id;
      if (typeof viaBody === "string") return viaBody;
      return this.extractRestId(body);
    }

    return undefined;
  }

  async createPost(options: CreatePostOptions): Promise<Post> {
    try {
      // Handle media uploads if needed
      const mediaIds: string[] = [];

      if (options.media && options.media.length > 0) {
        logger.info(`Uploading ${options.media.length} media file(s)...`);

        for (const media of options.media) {
          try {
            // Upload media using Twitter API v1 (v2 doesn't support media upload yet)
            const mediaId = await this.client.twitterClient.uploadMedia(
              media.data,
              {
                mimeType: media.type,
              },
            );

            mediaIds.push(mediaId);
            logger.info(`Media uploaded successfully. Media ID: ${mediaId}`);
          } catch (error) {
            logger.error("Error uploading media:", this.errorDetail(error));
            // Continue with other media files even if one fails
          }
        }

        logger.info(
          `Successfully uploaded ${mediaIds.length}/${options.media.length} media file(s)`,
        );
      }

      const result =
        mediaIds.length > 0
          ? await this.client.twitterClient.sendTweet(
              options.text,
              options.inReplyTo,
              options.media?.map((m) => ({
                data: m.data,
                mediaType: m.type,
              })),
              false, // hideLinkPreview
              mediaIds, // Pass uploaded media IDs
            )
          : await this.client.twitterClient.sendTweet(
              options.text,
              options.inReplyTo,
            );

      const tweetId = await this.extractTweetId(result);
      if (!tweetId) {
        const safeResult =
          typeof result === "string"
            ? result
            : JSON.stringify(result, null, 2).slice(0, 8000);
        logger.error(
          `Twitter createPost: could not extract tweet id from API result ${JSON.stringify(
            { inReplyTo: options.inReplyTo, textLength: options.text?.length },
          )} ${safeResult}`,
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
      logger.error("Error creating post:", this.errorDetail(error));
      throw error;
    }
  }

  async deletePost(postId: string, _agentId: UUID): Promise<void> {
    try {
      await this.client.twitterClient.deleteTweet(postId);
    } catch (error) {
      logger.error("Error deleting post:", this.errorDetail(error));
      throw error;
    }
  }

  async getPost(postId: string, agentId: UUID): Promise<Post | null> {
    try {
      const tweet = await this.client.twitterClient.getTweet(postId);

      if (!tweet?.id) return null;
      const tweetId = tweet.id;

      const post: Post = {
        id: tweetId,
        agentId: agentId,
        roomId: createUniqueUuid(
          this.client.runtime,
          tweet.conversationId || tweetId,
        ),
        userId: tweet.userId ?? "",
        username: tweet.username ?? "",
        text: tweet.text ?? "",
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
      logger.error("Error fetching post:", this.errorDetail(error));
      return null;
    }
  }

  async getPosts(options: GetPostsOptions): Promise<Post[]> {
    try {
      type FetchedTweet = Awaited<
        ReturnType<ClientBase["fetchHomeTimeline"]>
      >[number];
      let tweets: FetchedTweet[];

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

      const posts: Post[] = tweets
        .filter((tweet) => typeof tweet.id === "string")
        .map((tweet) => {
          const tweetId = tweet.id as string;
          return {
            id: tweetId,
            agentId: options.agentId,
            roomId: createUniqueUuid(
              this.client.runtime,
              tweet.conversationId || tweetId,
            ),
            userId: tweet.userId ?? "",
            username: tweet.username ?? "",
            text: tweet.text ?? "",
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
        });

      return posts;
    } catch (error) {
      logger.error("Error fetching posts:", this.errorDetail(error));
      return [];
    }
  }

  async likePost(postId: string, _agentId: UUID): Promise<void> {
    try {
      await this.client.twitterClient.likeTweet(postId);
    } catch (error) {
      logger.error("Error liking post:", this.errorDetail(error));
      throw error;
    }
  }

  async repost(postId: string, _agentId: UUID): Promise<void> {
    try {
      await this.client.twitterClient.retweet(postId);
    } catch (error) {
      logger.error("Error reposting:", this.errorDetail(error));
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

      const posts: Post[] = searchResult.tweets
        .filter((tweet) => typeof tweet.id === "string")
        .map((tweet) => {
          const tweetId = tweet.id as string;
          return {
            id: tweetId,
            agentId: agentId,
            roomId: createUniqueUuid(
              this.client.runtime,
              tweet.conversationId || tweetId,
            ),
            userId: tweet.userId ?? "",
            username: tweet.username ?? "",
            text: tweet.text ?? "",
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
          };
        });

      return posts;
    } catch (error) {
      logger.error("Error fetching mentions:", this.errorDetail(error));
      return [];
    }
  }

  async unlikePost(_postId: string, _agentId: UUID): Promise<void> {
    try {
      // Twitter API v2 doesn't have a direct unlike method in the Client wrapper
      // This would need to be implemented using the Twitter API v2 endpoints
      logger.warn("Unlike functionality not yet implemented");
      throw new Error("Unlike functionality not yet implemented");
    } catch (error) {
      logger.error("Error unliking post:", this.errorDetail(error));
      throw error;
    }
  }

  async unrepost(_postId: string, _agentId: UUID): Promise<void> {
    try {
      // Twitter API v2 doesn't have a direct unretweet method in the Client wrapper
      // This would need to be implemented using the Twitter API v2 endpoints
      logger.warn("Unrepost functionality not yet implemented");
      throw new Error("Unrepost functionality not yet implemented");
    } catch (error) {
      logger.error("Error unreposting:", this.errorDetail(error));
      throw error;
    }
  }
}
