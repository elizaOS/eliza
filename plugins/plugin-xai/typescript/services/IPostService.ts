import type { UUID } from "@elizaos/core";

export interface Post {
  id: string;
  agentId: UUID;
  roomId: UUID;
  userId: string;
  username: string;
  text: string;
  timestamp: number;
  inReplyTo?: string;
  quotedPostId?: string;
  metrics?: PostMetrics;
  media?: MediaAttachment[];
  metadata?: Record<string, unknown>;
}

export interface PostMetrics {
  likes: number;
  reposts: number;
  replies: number;
  quotes: number;
  views?: number;
}

export interface MediaAttachment {
  type: "image" | "video" | "gif";
  url: string;
  thumbnailUrl?: string;
  altText?: string;
}

export interface CreatePostOptions {
  agentId: UUID;
  roomId: UUID;
  text: string;
  inReplyTo?: string;
  media?: { data: Buffer; type: string; altText?: string }[];
  quotedPostId?: string;
}

export interface GetPostsOptions {
  agentId: UUID;
  roomId?: UUID;
  userId?: string;
  limit?: number;
  before?: string;
  after?: string;
  includeReplies?: boolean;
  includeReposts?: boolean;
}

export interface IPostService {
  /**
   * Create a new post
   */
  createPost(options: CreatePostOptions): Promise<Post>;

  /**
   * Delete a post
   */
  deletePost(postId: string, agentId: UUID): Promise<void>;

  /**
   * Get a specific post by ID
   */
  getPost(postId: string, agentId: UUID): Promise<Post | null>;

  /**
   * Get multiple posts based on filters
   */
  getPosts(options: GetPostsOptions): Promise<Post[]>;

  /**
   * Like/unlike a post
   */
  likePost(postId: string, agentId: UUID): Promise<void>;
  unlikePost(postId: string, agentId: UUID): Promise<void>;

  /**
   * Repost/unrepost
   */
  repost(postId: string, agentId: UUID): Promise<void>;
  unrepost(postId: string, agentId: UUID): Promise<void>;

  /**
   * Get posts that mention the agent
   */
  getMentions(agentId: UUID, options?: Partial<GetPostsOptions>): Promise<Post[]>;
}
