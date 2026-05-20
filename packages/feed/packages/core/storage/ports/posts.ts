/**
 * Post Storage Port
 *
 * Defines the interface for post and content data access.
 */

import type { PaginatedResult, PaginationOptions, PostRecord } from '../types';

export interface PostPort {
  // Post Operations
  getPost(id: string): Promise<PostRecord | null>;
  getRecentPosts(
    options?: PaginationOptions
  ): Promise<PaginatedResult<PostRecord>>;
  getPostsByAuthor(
    authorId: string,
    options?: PaginationOptions
  ): Promise<PaginatedResult<PostRecord>>;
  getPostsByType(
    type: string,
    options?: PaginationOptions
  ): Promise<PaginatedResult<PostRecord>>;

  // Create Operations
  createPost(
    post: Omit<PostRecord, 'likeCount' | 'commentCount' | 'repostCount'>
  ): Promise<PostRecord>;
  createManyPosts(
    posts: Omit<PostRecord, 'likeCount' | 'commentCount' | 'repostCount'>[]
  ): Promise<{ count: number }>;

  // Update Operations
  updatePost(id: string, updates: Partial<PostRecord>): Promise<PostRecord>;
  deletePost(id: string): Promise<void>;

  // Engagement
  incrementLikeCount(id: string): Promise<void>;
  decrementLikeCount(id: string): Promise<void>;
  incrementCommentCount(id: string): Promise<void>;
  incrementRepostCount(id: string): Promise<void>;

  // Comments
  getPostComments(
    postId: string,
    options?: PaginationOptions
  ): Promise<PaginatedResult<PostRecord>>;

  // Statistics
  getTotalPosts(): Promise<number>;
}
