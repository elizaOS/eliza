/**
 * TypeScript types for social interaction features
 * Includes: likes, comments, shares, and favorites
 */

import type { JsonValue } from "./common";

// ============================================================================
// Post Interaction Types
// ============================================================================

export interface PostInteraction {
  postId: string;
  likeCount: number;
  commentCount: number;
  shareCount: number;
  isLiked: boolean;
  isShared: boolean;
}

export interface PostInteractionCounts {
  likes: number;
  comments: number;
  shares: number;
}

// ============================================================================
// Comment Interaction Types
// ============================================================================

export interface CommentInteraction {
  commentId: string;
  likeCount: number;
  replyCount: number;
  isLiked: boolean;
}

export interface CommentWithReplies {
  id: string;
  content: string;
  createdAt: Date;
  updatedAt: Date;
  userId: string;
  userName: string;
  userUsername?: string | null;
  userAvatar?: string;
  parentCommentId?: string;
  parentCommentAuthorName?: string; // Author name of the parent comment (for "Replying to" indicator)
  likeCount: number;
  isLiked: boolean;
  replies: CommentWithReplies[];
}

export interface CommentData {
  id: string;
  content: string;
  postId: string;
  authorId: string;
  parentCommentId?: string;
  createdAt: Date;
  updatedAt: Date;
  author: {
    id: string;
    displayName: string | null;
    username: string | null;
    profileImageUrl: string | null;
  };
  // API response includes these directly
  likeCount?: number;
  replyCount?: number;
}

// ============================================================================
// Favorite Profile Types
// ============================================================================

export interface FavoriteProfile {
  id: string;
  name: string;
  username?: string;
  avatar?: string;
  bio?: string;
  isFavorited: boolean;
  favoritedAt?: Date;
}

export interface FavoriteData {
  id: string;
  userId: string;
  targetUserId: string;
  createdAt: Date;
  targetUser: {
    id: string;
    displayName: string | null;
    username: string | null;
    profileImageUrl: string | null;
    bio: string | null;
  };
}

// ============================================================================
// Share/Repost Types
// ============================================================================

export interface ShareData {
  id: string;
  userId: string;
  postId: string;
  createdAt: Date;
  user: {
    id: string;
    displayName: string | null;
    username: string | null;
    profileImageUrl: string | null;
  };
  post: {
    id: string;
    content: string;
    createdAt: Date;
    author: {
      id: string;
      displayName: string | null;
      username: string | null;
      profileImageUrl: string | null;
    };
  };
}

// ============================================================================
// API Request/Response Types
// ============================================================================

export interface LikePostRequest {
  postId: string;
}

export interface LikeCommentRequest {
  commentId: string;
}

export interface CreateCommentRequest {
  postId: string;
  content: string;
  parentCommentId?: string;
}

export interface UpdateCommentRequest {
  content: string;
}

export interface SharePostRequest {
  postId: string;
}

export interface FavoriteProfileRequest {
  targetUserId: string;
}

export interface InteractionResponse<T = JsonValue> {
  success: boolean;
  data?: T;
  error?: string;
}

export interface PostInteractionsResponse {
  postId: string;
  likeCount: number;
  commentCount: number;
  shareCount: number;
  isLiked: boolean;
  isShared: boolean;
}

export interface CommentsResponse {
  comments: CommentWithReplies[];
  total: number;
  hasMore: boolean;
}

// ============================================================================
// Optimistic Update Types
// ============================================================================

export interface OptimisticUpdate<T> {
  id: string;
  type:
    | "like"
    | "unlike"
    | "comment"
    | "share"
    | "unshare"
    | "favorite"
    | "unfavorite";
  data: T;
  timestamp: number;
  reverted?: boolean;
}

export interface PendingInteraction<T = JsonValue> {
  id: string;
  type: "like" | "comment" | "share" | "favorite";
  target: string;
  timestamp: number;
  optimisticData: T;
}

// ============================================================================
// Real-time Polling Types
// ============================================================================

export interface PollingConfig {
  interval: number; // milliseconds
  enabled: boolean;
  postIds: string[];
}

export interface PollingUpdate {
  postId: string;
  interactions: PostInteractionCounts;
  timestamp: number;
}

// ============================================================================
// Error Types
// ============================================================================

export interface InteractionError {
  code:
    | "UNAUTHORIZED"
    | "NOT_FOUND"
    | "DUPLICATE"
    | "NETWORK_ERROR"
    | "UNKNOWN";
  message: string;
  details?: JsonValue | Record<string, JsonValue>;
}

// ============================================================================
// Zustand Store State Types
// ============================================================================

export interface InteractionStoreState {
  // State maps
  postInteractions: Map<string, PostInteraction>;
  commentInteractions: Map<string, CommentInteraction>;
  favoritedProfiles: Set<string>;
  pendingInteractions: Map<string, PendingInteraction>;

  // Polling state
  pollingConfig: PollingConfig;
  isPolling: boolean;

  // Loading states
  loadingStates: Map<string, boolean>;

  // Error states
  errors: Map<string, InteractionError>;
}

export interface InteractionStoreActions {
  // Like actions
  toggleLike: (postId: string) => Promise<void>;
  toggleCommentLike: (commentId: string) => Promise<void>;

  // Comment actions
  addComment: (
    postId: string,
    content: string,
    parentId?: string,
  ) => Promise<CommentData | null>;
  editComment: (commentId: string, content: string) => Promise<void>;
  deleteComment: (commentId: string, postId?: string) => Promise<void>;
  loadComments: (postId: string) => Promise<CommentWithReplies[]>;

  // Share actions
  toggleShare: (postId: string) => Promise<void>;

  // Favorite actions
  toggleFavorite: (profileId: string) => Promise<void>;
  loadFavorites: () => Promise<FavoriteProfile[]>;

  // Polling actions
  startPolling: (postIds: string[]) => void;
  stopPolling: () => void;
  syncInteractions: (postIds: string[]) => Promise<void>;

  // Utility actions
  clearError: (id: string) => void;
  resetStore: () => void;

  // Get interaction data
  getPostInteraction: (postId: string) => PostInteraction | null;
  getCommentInteraction: (commentId: string) => CommentInteraction | null;
  isFavorited: (profileId: string) => boolean;
}

export type InteractionStore = InteractionStoreState & InteractionStoreActions;

// ============================================================================
// Component Props Types
// ============================================================================

export interface LikeButtonProps {
  target: string;
  targetType: "post" | "comment";
  initialLiked?: boolean;
  initialCount?: number;
  initialReactionType?: "like" | "love" | "laugh" | "sad";
  size?: "sm" | "md" | "lg";
  showCount?: boolean;
  className?: string;
}

export interface CommentButtonProps {
  postId: string;
  commentCount: number;
  onClick?: () => void;
  size?: "sm" | "md" | "lg";
  className?: string;
}

export interface RepostButtonProps {
  postId: string;
  shareCount: number;
  initialShared?: boolean;
  size?: "sm" | "md" | "lg";
  showCount?: boolean;
  className?: string;
  postData?: {
    id: string;
    content: string;
    authorId: string;
    authorName: string;
    authorUsername?: string | null;
    authorProfileImageUrl?: string | null;
    timestamp: string;
  };
}

export interface FavoriteButtonProps {
  profileId: string;
  initialFavorited?: boolean;
  size?: "sm" | "md" | "lg";
  variant?: "icon" | "button";
  className?: string;
}

export interface InteractionBarProps {
  postId: string;
  initialInteractions?: PostInteraction;
  onCommentClick?: () => void;
  className?: string;
  postData?: {
    id: string;
    content: string;
    authorId: string;
    authorName: string;
    authorUsername?: string | null;
    authorProfileImageUrl?: string | null;
    timestamp: string;
    likeCount?: number;
    commentCount?: number;
    shareCount?: number;
    isLiked?: boolean;
    isShared?: boolean;
    // Repost metadata
    isRepost?: boolean;
    isQuote?: boolean;
    quoteComment?: string | null;
    originalPostId?: string | null;
  };
}

export interface CommentCardProps {
  comment: CommentWithReplies;
  postId: string; // Post ID needed for replies
  onReply?: (commentId: string) => void;
  onEdit?: (commentId: string, content: string) => void;
  onDelete?: (commentId: string) => void;
  onReplySubmit?: (comment: CommentData) => void; // Callback when reply is submitted
  depth?: number;
  maxDepth?: number;
  className?: string;
}

export interface CommentInputProps {
  postId: string;
  parentCommentId?: string;
  placeholder?: string;
  autoFocus?: boolean;
  onSubmit?: (comment: CommentData) => void;
  onCancel?: () => void;
  className?: string;
}
