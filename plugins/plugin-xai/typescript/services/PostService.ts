import { createUniqueUuid, logger, type UUID } from "@elizaos/core";
import type { ClientBase } from "../base";
import { SearchMode } from "../client";
import { extractIdFromResult, extractRestId, isResponseLike, type PostResponse } from "../types";
import { getEpochMs } from "../utils/time";
import type { CreatePostOptions, GetPostsOptions, IPostService, Post } from "./IPostService";

export class XPostService implements IPostService {
  constructor(private client: ClientBase) {}

  private async safeParseJsonResponse(
    result: unknown
  ): Promise<Record<string, unknown> | undefined> {
    if (!isResponseLike(result)) return undefined;

    try {
      if (result.clone && typeof result.clone === "function") {
        if (result.bodyUsed === true) return undefined;
        const cloned = result.clone();
        if (cloned?.json && typeof cloned.json === "function") {
          return await cloned.json();
        }
        return undefined;
      }

      if (result.json && typeof result.json === "function") {
        return await result.json();
      }
      return undefined;
    } catch {
      return undefined;
    }
  }

  private async extractPostId(result: PostResponse | unknown): Promise<string | undefined> {
    const directId = extractIdFromResult(result);
    if (directId) return directId;

    const restId = extractRestId(result);
    if (restId) return restId;

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
      const _mediaIds: string[] = [];

      if (options.media && options.media.length > 0) {
        logger.warn("Media upload not currently supported with X API v2");
      }

      const result = await this.client.xClient.sendPost(options.text, options.inReplyTo);

      const postId = await this.extractPostId(result);
      if (!postId) {
        const safeResult =
          typeof result === "string" ? result : JSON.stringify(result, null, 2).slice(0, 8000);
        logger.error("X createPost: could not extract post id from API result", safeResult);
        throw new Error(
          "X createPost failed: could not extract post id from API response. See logs for raw response."
        );
      }

      const post: Post = {
        id: postId,
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
      await this.client.xClient.deletePost(postId);
    } catch (error) {
      logger.error("Error deleting post:", error instanceof Error ? error.message : String(error));
      throw error;
    }
  }

  async getPost(postId: string, agentId: UUID): Promise<Post | null> {
    try {
      const rawPost = await this.client.xClient.getPost(postId);

      if (!rawPost || !rawPost.id || !rawPost.userId || !rawPost.username || !rawPost.text) {
        return null;
      }

      const post: Post = {
        id: rawPost.id,
        agentId: agentId,
        roomId: createUniqueUuid(this.client.runtime, rawPost.conversationId || rawPost.id),
        userId: rawPost.userId,
        username: rawPost.username,
        text: rawPost.text,
        timestamp: getEpochMs(rawPost.timestamp),
        metrics: {
          likes: rawPost.likes || 0,
          reposts: rawPost.reposts || 0,
          replies: rawPost.replies || 0,
          quotes: rawPost.quotes || 0,
          views: rawPost.views || 0,
        },
        media:
          rawPost.photos?.map((photo) => ({
            type: "image" as const,
            url: photo.url,
            metadata: { id: photo.id },
          })) || [],
        metadata: {
          conversationId: rawPost.conversationId,
          permanentUrl: rawPost.permanentUrl,
        },
      };

      return post;
    } catch (error) {
      logger.error("Error fetching post:", error instanceof Error ? error.message : String(error));
      return null;
    }
  }

  async getPosts(options: GetPostsOptions): Promise<Post[]> {
    interface PartialPost {
      id?: string;
      userId?: string;
      username?: string;
      text?: string;
      timestamp?: number;
      conversationId?: string;
      likes?: number;
      reposts?: number;
      quotes?: number;
      replies?: number;
      views?: number;
      photos?: Array<{ url: string; id: string }>;
      permanentUrl?: string;
      media?: Array<{ type?: string; url?: string }>;
    }

    function hasRequiredFields(
      post: PartialPost
    ): post is PartialPost & { id: string; userId: string; username: string; text: string } {
      return Boolean(post.id && post.userId && post.username && post.text);
    }

    try {
      let _posts: PartialPost[] | undefined;

      if (options.userId) {
        const result = await this.client.xClient.getUserPosts(
          options.userId,
          options.limit || 20,
          options.before
        );
        _posts = result.posts;
      } else {
        _posts = await this.client.fetchHomeTimeline(options.limit || 20, false);
      }

      if (!_posts) return [];

      const posts: Post[] = _posts.filter(hasRequiredFields).map((post) => ({
        id: post.id,
        agentId: options.agentId,
        roomId: createUniqueUuid(this.client.runtime, post.conversationId || post.id),
        userId: post.userId,
        username: post.username,
        text: post.text,
        timestamp: getEpochMs(post.timestamp),
        metrics: {
          likes: post.likes ?? 0,
          reposts: post.reposts ?? 0,
          replies: post.replies ?? 0,
          quotes: post.quotes ?? 0,
          views: post.views ?? 0,
        },
        media:
          post.photos?.map((photo) => ({
            type: "image" as const,
            url: photo.url,
            metadata: { id: photo.id },
          })) ?? [],
        metadata: {
          conversationId: post.conversationId,
          permanentUrl: post.permanentUrl,
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
      await this.client.xClient.likePost(postId);
    } catch (error) {
      logger.error("Error liking post:", error instanceof Error ? error.message : String(error));
      throw error;
    }
  }

  async repost(postId: string, _agentId: UUID): Promise<void> {
    try {
      await this.client.xClient.repost(postId);
    } catch (error) {
      logger.error("Error reposting:", error instanceof Error ? error.message : String(error));
      throw error;
    }
  }

  async getMentions(agentId: UUID, options?: Partial<GetPostsOptions>): Promise<Post[]> {
    try {
      const username = this.client.profile?.username;
      if (!username) {
        logger.error("No X profile available");
        return [];
      }

      const searchResult = await this.client.fetchSearchPosts(
        `@${username}`,
        options?.limit || 20,
        SearchMode.Latest,
        options?.before
      );

      const posts: Post[] = searchResult.posts
        .filter(
          (
            post
          ): post is typeof post & {
            id: string;
            userId: string;
            username: string;
            text: string;
          } => !!(post.id && post.userId && post.username && post.text)
        )
        .map((post) => ({
          id: post.id,
          agentId: agentId,
          roomId: createUniqueUuid(this.client.runtime, post.conversationId || post.id),
          userId: post.userId,
          username: post.username,
          text: post.text,
          timestamp: getEpochMs(post.timestamp),
          metrics: {
            likes: post.likes || 0,
            reposts: post.reposts || 0,
            replies: post.replies || 0,
            quotes: post.quotes || 0,
            views: post.views || 0,
          },
          media:
            post.photos?.map((photo) => ({
              type: "image" as const,
              url: photo.url,
              metadata: { id: photo.id },
            })) || [],
          metadata: {
            conversationId: post.conversationId,
            permanentUrl: post.permanentUrl,
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
      await this.client.xClient.unlikePost(postId);
    } catch (error) {
      logger.error("Error unliking post:", error instanceof Error ? error.message : String(error));
      throw error;
    }
  }

  async unrepost(postId: string, _agentId: UUID): Promise<void> {
    try {
      await this.client.xClient.unrepost(postId);
    } catch (error) {
      logger.error("Error unreposting:", error instanceof Error ? error.message : String(error));
      throw error;
    }
  }
}
