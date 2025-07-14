import { Service, ServiceType } from './service';
import type { UUID } from './primitives';

export interface PostMedia {
  id: UUID;
  url: string;
  type: 'image' | 'video' | 'audio' | 'document';
  mimeType: string;
  size: number;
  width?: number;
  height?: number;
  duration?: number;
  thumbnail?: string;
  description?: string;
  altText?: string;
}

export interface PostLocation {
  name: string;
  address?: string;
  coordinates?: {
    latitude: number;
    longitude: number;
  };
  placeId?: string;
}

export interface PostAuthor {
  id: UUID;
  username: string;
  displayName: string;
  avatar?: string;
  verified?: boolean;
  followerCount?: number;
  followingCount?: number;
  bio?: string;
  website?: string;
}

export interface PostEngagement {
  likes: number;
  shares: number;
  comments: number;
  views?: number;
  hasLiked: boolean;
  hasShared: boolean;
  hasCommented: boolean;
  hasSaved: boolean;
}

export interface PostContent {
  text?: string;
  html?: string;
  media?: PostMedia[];
  location?: PostLocation;
  tags?: string[];
  mentions?: UUID[];
  links?: Array<{
    url: string;
    title?: string;
    description?: string;
    image?: string;
  }>;
  poll?: {
    question: string;
    options: Array<{
      text: string;
      votes: number;
    }>;
    expiresAt?: Date;
    multipleChoice?: boolean;
  };
}

export interface PostInfo {
  id: UUID;
  author: PostAuthor;
  content: PostContent;
  platform: string;
  platformId: string;
  url: string;
  createdAt: Date;
  editedAt?: Date;
  scheduledAt?: Date;
  engagement: PostEngagement;
  visibility: 'public' | 'private' | 'followers' | 'friends' | 'unlisted';
  replyTo?: UUID;
  thread?: {
    id: UUID;
    position: number;
    total: number;
  };
  crossPosted?: Array<{
    platform: string;
    platformId: string;
    url: string;
  }>;
}

export interface PostCreateOptions {
  platforms?: string[];
  scheduledAt?: Date;
  visibility?: PostInfo['visibility'];
  replyTo?: UUID;
  thread?: boolean;
  location?: PostLocation;
  tags?: string[];
  mentions?: UUID[];
  enableComments?: boolean;
  enableSharing?: boolean;
  contentWarning?: string;
  sensitive?: boolean;
}

export interface PostSearchOptions {
  query?: string;
  author?: UUID;
  platform?: string;
  tags?: string[];
  mentions?: UUID[];
  since?: Date;
  before?: Date;
  limit?: number;
  offset?: number;
  hasMedia?: boolean;
  hasLocation?: boolean;
  visibility?: PostInfo['visibility'];
  sortBy?: 'date' | 'engagement' | 'relevance';
}

export interface PostAnalytics {
  postId: UUID;
  platform: string;
  impressions: number;
  reach: number;
  engagement: PostEngagement;
  clicks: number;
  shares: number;
  saves: number;
  demographics?: {
    age?: Record<string, number>;
    gender?: Record<string, number>;
    location?: Record<string, number>;
  };
  topPerformingHours?: Array<{
    hour: number;
    engagement: number;
  }>;
}

/**
 * Interface for social media posting services
 */
export abstract class IPostService extends Service {
  static override readonly serviceType = ServiceType.POST;

  public readonly capabilityDescription =
    'Social media posting and content management capabilities';

  /**
   * Create and publish a new post
   * @param content - Post content
   * @param options - Publishing options
   * @returns Promise resolving to post ID
   */
  abstract createPost(content: PostContent, options?: PostCreateOptions): Promise<UUID>;

  /**
   * Get posts from timeline or specific user
   * @param options - Search options
   * @returns Promise resolving to array of posts
   */
  abstract getPosts(options?: PostSearchOptions): Promise<PostInfo[]>;

  /**
   * Get a specific post by ID
   * @param postId - Post ID
   * @returns Promise resolving to post info
   */
  abstract getPost(postId: UUID): Promise<PostInfo>;

  /**
   * Edit an existing post
   * @param postId - Post ID
   * @param content - New post content
   * @returns Promise resolving when edit completes
   */
  abstract editPost(postId: UUID, content: PostContent): Promise<void>;

  /**
   * Delete a post
   * @param postId - Post ID
   * @returns Promise resolving when deletion completes
   */
  abstract deletePost(postId: UUID): Promise<void>;

  /**
   * Like/unlike a post
   * @param postId - Post ID
   * @param like - True to like, false to unlike
   * @returns Promise resolving when operation completes
   */
  abstract likePost(postId: UUID, like: boolean): Promise<void>;

  /**
   * Share/repost a post
   * @param postId - Post ID
   * @param comment - Optional comment when sharing
   * @returns Promise resolving to share ID
   */
  abstract sharePost(postId: UUID, comment?: string): Promise<UUID>;

  /**
   * Save/unsave a post
   * @param postId - Post ID
   * @param save - True to save, false to unsave
   * @returns Promise resolving when operation completes
   */
  abstract savePost(postId: UUID, save: boolean): Promise<void>;

  /**
   * Comment on a post
   * @param postId - Post ID
   * @param content - Comment content
   * @returns Promise resolving to comment ID
   */
  abstract commentOnPost(postId: UUID, content: PostContent): Promise<UUID>;

  /**
   * Get comments for a post
   * @param postId - Post ID
   * @param options - Search options
   * @returns Promise resolving to array of comments
   */
  abstract getComments(postId: UUID, options?: PostSearchOptions): Promise<PostInfo[]>;

  /**
   * Schedule a post for later publishing
   * @param content - Post content
   * @param scheduledAt - When to publish
   * @param options - Publishing options
   * @returns Promise resolving to scheduled post ID
   */
  abstract schedulePost(
    content: PostContent,
    scheduledAt: Date,
    options?: PostCreateOptions
  ): Promise<UUID>;

  /**
   * Get analytics for a post
   * @param postId - Post ID
   * @returns Promise resolving to post analytics
   */
  abstract getPostAnalytics(postId: UUID): Promise<PostAnalytics>;

  /**
   * Get trending posts
   * @param options - Search options
   * @returns Promise resolving to trending posts
   */
  abstract getTrendingPosts(options?: PostSearchOptions): Promise<PostInfo[]>;

  /**
   * Search posts across platforms
   * @param query - Search query
   * @param options - Search options
   * @returns Promise resolving to search results
   */
  abstract searchPosts(query: string, options?: PostSearchOptions): Promise<PostInfo[]>;
}
