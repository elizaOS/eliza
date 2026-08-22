/**
 * `TwitterPostService` — the `IPostService` implementation for public tweets,
 * covering create/get posts, mention retrieval, and like/retweet plus their
 * inverses through `ClientBase`. Backs the post connector handlers on `XService`.
 */
import { createUniqueUuid, ElizaError, logger, type UUID } from "@elizaos/core";
import type { ClientBase, TwitterProfile } from "../base";
import { SearchMode } from "../client";
import { extractXWriteReceiptId } from "../utils/provider-receipt";
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

  async createPost(
    options: CreatePostOptions,
    authenticatedProfile?: TwitterProfile,
  ): Promise<Post> {
    return this.client.withAuthenticatedSession(async (session) => {
      const { profile } = session;
      if (authenticatedProfile && authenticatedProfile.id !== profile.id) {
        throw new ElizaError(
          "Authenticated X profile changed before the post was admitted",
          { code: "X_AUTH_SESSION_ROTATED" },
        );
      }
      try {
        if (options.quotedPostId && options.inReplyTo) {
          throw new ElizaError(
            "An X post cannot be both a reply and a quote through one connector request",
            {
              code: "X_POST_TARGET_CONFLICT",
              context: {
                hasReplyTarget: true,
                hasQuoteTarget: true,
              },
              severity: "fatal",
            },
          );
        }
        if ((options.media?.length ?? 0) > 4) {
          throw new ElizaError(
            "X posts accept at most four media attachments",
            {
              code: "X_POST_MEDIA_COUNT_INVALID",
              context: { mediaCount: options.media?.length },
              severity: "fatal",
            },
          );
        }

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
              // error-policy:J2 Publishing without every requested attachment
              // would silently change an irreversible external effect.
              throw new ElizaError("X media upload failed", {
                code: "X_MEDIA_UPLOAD_FAILED",
                cause: error,
                context: { mimeType: media.type },
              });
            }
          }

          logger.info(
            `Successfully uploaded ${mediaIds.length}/${options.media.length} media file(s)`,
          );
        }

        if (!this.client.isAuthenticatedSessionCurrent(session)) {
          throw new ElizaError("X credentials rotated before post egress", {
            code: "X_AUTH_SESSION_ROTATED",
          });
        }
        const result = options.quotedPostId
          ? await this.client.twitterClient.sendQuoteTweet(
              options.text,
              options.quotedPostId,
              ...(mediaIds.length > 0 ? [{ mediaIds }] : []),
            )
          : mediaIds.length > 0
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

        const tweetId = await extractXWriteReceiptId(result);
        if (!tweetId) {
          logger.error(
            `Twitter createPost: provider accepted the request without a usable receipt (reply=${options.inReplyTo ? "yes" : "no"}, textLength=${options.text.length})`,
          );
          throw new ElizaError(
            "X accepted the post but returned no usable receipt; do not retry blindly",
            {
              code: "X_POST_RECEIPT_INDETERMINATE",
              context: {
                accountId: this.client.accountId,
                providerAccepted: true,
                retrySafe: false,
              },
            },
          );
        }

        const post: Post = {
          id: tweetId,
          agentId: options.agentId,
          roomId: options.roomId,
          userId: profile.id,
          username: profile.username,
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
    });
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

      // Fail closed on a present-but-unusable timestamp (#18965).
      const timestamp = getEpochMs(tweet.timestamp);
      if (timestamp === undefined) return null;

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
        timestamp,
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
      // error-policy:J7 Report the connector failure to the agent, then keep it
      // distinct from the legitimate null returned for a missing post.
      this.client.runtime.reportError("XPostService.getPost", error);
      throw error;
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

      const posts: Post[] = tweets.flatMap((tweet) => {
        // Normalize once per row; rows without a usable identity or timestamp
        // fail closed instead of surfacing as fresh posts (#18965).
        const timestamp = getEpochMs(tweet.timestamp);
        if (typeof tweet.id !== "string" || timestamp === undefined) return [];
        const tweetId = tweet.id;
        return [
          {
            id: tweetId,
            agentId: options.agentId,
            roomId: createUniqueUuid(
              this.client.runtime,
              tweet.conversationId || tweetId,
            ),
            userId: tweet.userId ?? "",
            username: tweet.username ?? "",
            text: tweet.text ?? "",
            timestamp,
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
          },
        ];
      });

      return posts;
    } catch (error) {
      // error-policy:J7 Report the connector failure to the agent, then keep it
      // distinct from a legitimately empty timeline.
      this.client.runtime.reportError("XPostService.getPosts", error);
      throw error;
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
      return await this.client.withAuthenticatedSession(async ({ profile }) => {
        const searchResult = await this.client.fetchSearchTweets(
          `@${profile.username}`,
          options?.limit || 20,
          SearchMode.Latest,
          options?.before,
        );

        const posts: Post[] = searchResult.tweets.flatMap((tweet) => {
          // Normalize once per row; rows without a usable identity or timestamp
          // fail closed instead of surfacing as fresh mentions (#18965).
          const timestamp = getEpochMs(tweet.timestamp);
          if (typeof tweet.id !== "string" || timestamp === undefined)
            return [];
          const tweetId = tweet.id;
          return [
            {
              id: tweetId,
              agentId: agentId,
              roomId: createUniqueUuid(
                this.client.runtime,
                tweet.conversationId || tweetId,
              ),
              userId: tweet.userId ?? "",
              username: tweet.username ?? "",
              text: tweet.text ?? "",
              timestamp,
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
            },
          ];
        });

        return posts;
      });
    } catch (error) {
      // error-policy:J7 Report the connector failure to the agent, then keep it
      // distinct from a legitimately empty mention list.
      this.client.runtime.reportError("XPostService.getMentions", error);
      throw error;
    }
  }

  async unlikePost(postId: string, _agentId: UUID): Promise<void> {
    try {
      await this.client.twitterClient.unlikeTweet(postId);
    } catch (error) {
      logger.error("Error unliking post:", this.errorDetail(error));
      throw error;
    }
  }

  async unrepost(postId: string, _agentId: UUID): Promise<void> {
    try {
      await this.client.twitterClient.unretweet(postId);
    } catch (error) {
      logger.error("Error unreposting:", this.errorDetail(error));
      throw error;
    }
  }
}
