/**
 * Interaction Store - Manages social interactions with optimistic updates
 * Handles: likes, comments, shares, and favorites with real-time polling
 */

import type {
  CommentData,
  CommentInteraction,
  CommentWithReplies,
  FavoriteProfile,
  InteractionError,
  PendingInteraction,
  PostInteraction,
} from '@feed/shared';
import { retryIfRetryable } from '@feed/shared';
import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { getAuthToken } from '@/lib/auth';
import { apiUrl } from '@/utils/api-url';

interface RepostPost {
  id: string;
  originalPostId: string;
  userId: string;
  createdAt: number;
  content: string;
  authorId: string;
  authorName: string;
  authorUsername?: string;
  authorProfileImageUrl?: string;
  timestamp: string;
  isRepost: boolean;
  originalAuthorId?: string | null;
  originalAuthorName?: string | null;
  originalAuthorUsername?: string | null;
  originalAuthorProfileImageUrl?: string | null;
  originalContent?: string | null;
  quoteComment?: string | null;
}

interface InteractionStoreState {
  // State maps
  postInteractions: Map<string, PostInteraction>;
  commentInteractions: Map<string, CommentInteraction>;
  favoritedProfiles: Set<string>;
  pendingInteractions: Map<string, PendingInteraction>;

  // Loading states
  loadingStates: Map<string, boolean>;

  // Error states
  errors: Map<string, InteractionError>;
}

interface InteractionStoreActions {
  // Like actions
  toggleLike: (postId: string) => Promise<void>;
  toggleCommentLike: (commentId: string) => Promise<void>;

  // Comment actions
  addComment: (
    postId: string,
    content: string,
    parentId?: string
  ) => Promise<CommentData | null>;
  editComment: (commentId: string, content: string) => Promise<void>;
  deleteComment: (commentId: string, postId?: string) => Promise<void>;
  loadComments: (postId: string) => Promise<CommentWithReplies[]>;

  // Share actions
  toggleShare: (
    postId: string,
    comment?: string
  ) => Promise<{ repostPost?: RepostPost } | void>;

  // Favorite actions
  toggleFavorite: (profileId: string) => Promise<void>;
  loadFavorites: () => Promise<FavoriteProfile[]>;

  // Utility actions
  clearError: (id: string) => void;
  resetStore: () => void;
  getPostInteraction: (postId: string) => PostInteraction | null;
  getCommentInteraction: (commentId: string) => CommentInteraction | null;
  isFavorited: (profileId: string) => boolean;
  setLoading: (id: string, loading: boolean) => void;
  setError: (id: string, error: InteractionError) => void;
}

type InteractionStore = InteractionStoreState & InteractionStoreActions;

// Persisted state type (only serializable parts)
type PersistedInteractionState = {
  postInteractions: Array<[string, PostInteraction]>;
  commentInteractions: Array<[string, CommentInteraction]>;
  favoritedProfiles: string[];
};

async function apiCall<T>(url: string, options: RequestInit = {}): Promise<T> {
  return retryIfRetryable(
    async () => {
      const token = getAuthToken();

      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        ...(options.headers as Record<string, string>),
      };

      if (token) {
        headers['Authorization'] = `Bearer ${token}`;
      }

      const response = await fetch(apiUrl(url), {
        ...options,
        headers,
      });

      return await response.json();
    },
    {
      maxAttempts: 3,
      initialDelayMs: 1000,
    }
  );
}

export const useInteractionStore = create<InteractionStore>()(
  persist(
    (set, get) => ({
      // Initial state
      postInteractions: new Map(),
      commentInteractions: new Map(),
      favoritedProfiles: new Set(),
      pendingInteractions: new Map(),
      loadingStates: new Map(),
      errors: new Map(),

      // Like actions
      toggleLike: async (postId: string) => {
        const { postInteractions, setLoading } = get();
        const currentInteraction = postInteractions.get(postId) || {
          postId,
          likeCount: 0,
          commentCount: 0,
          shareCount: 0,
          isLiked: false,
          isShared: false,
        };

        const wasLiked = currentInteraction.isLiked;
        const optimisticCount = wasLiked
          ? currentInteraction.likeCount - 1
          : currentInteraction.likeCount + 1;

        // Optimistic update
        const optimisticInteraction: PostInteraction = {
          ...currentInteraction,
          isLiked: !wasLiked,
          likeCount: Math.max(0, optimisticCount),
        };

        set((state) => ({
          postInteractions: new Map(state.postInteractions).set(
            postId,
            optimisticInteraction
          ),
        }));

        setLoading(postId, true);

        const method = wasLiked ? 'DELETE' : 'POST';
        const response = await apiCall<{
          data: { likeCount: number; isLiked: boolean };
        }>(`/api/posts/${postId}/like`, { method });

        set((state) => ({
          postInteractions: new Map(state.postInteractions).set(postId, {
            ...currentInteraction,
            likeCount: response.data.likeCount,
            isLiked: response.data.isLiked,
          }),
        }));

        setLoading(postId, false);
      },

      toggleCommentLike: async (commentId: string) => {
        const { commentInteractions, setLoading } = get();
        const currentInteraction = commentInteractions.get(commentId) || {
          commentId,
          likeCount: 0,
          replyCount: 0,
          isLiked: false,
        };

        const wasLiked = currentInteraction.isLiked;
        const optimisticCount = wasLiked
          ? currentInteraction.likeCount - 1
          : currentInteraction.likeCount + 1;

        // Optimistic update
        const optimisticInteraction: CommentInteraction = {
          ...currentInteraction,
          isLiked: !wasLiked,
          likeCount: Math.max(0, optimisticCount),
        };

        set((state) => ({
          commentInteractions: new Map(state.commentInteractions).set(
            commentId,
            optimisticInteraction
          ),
        }));

        setLoading(commentId, true);

        const method = wasLiked ? 'DELETE' : 'POST';
        const response = await apiCall<{
          data: { likeCount: number; isLiked: boolean };
        }>(`/api/comments/${commentId}/like`, { method });

        set((state) => ({
          commentInteractions: new Map(state.commentInteractions).set(
            commentId,
            {
              ...currentInteraction,
              likeCount: response.data.likeCount,
              isLiked: response.data.isLiked,
            }
          ),
        }));

        setLoading(commentId, false);
      },

      // Comment actions
      addComment: async (
        postId: string,
        content: string,
        parentId?: string
      ) => {
        const { setLoading, postInteractions } = get();
        const loadingKey = `comment-${postId}-${parentId || 'root'}`;

        setLoading(loadingKey, true);

        const response = await apiCall<CommentData>(
          `/api/posts/${postId}/comments`,
          {
            method: 'POST',
            body: JSON.stringify({ content, parentCommentId: parentId }),
          }
        );

        if (!parentId) {
          const currentInteraction = postInteractions.get(postId);
          if (currentInteraction) {
            set((state) => ({
              postInteractions: new Map(state.postInteractions).set(postId, {
                ...currentInteraction,
                commentCount: currentInteraction.commentCount + 1,
              }),
            }));
          }
        }

        setLoading(loadingKey, false);
        return response;
      },

      editComment: async (commentId: string, content: string) => {
        const { setLoading } = get();
        const loadingKey = `edit-comment-${commentId}`;

        setLoading(loadingKey, true);

        await apiCall(`/api/comments/${commentId}`, {
          method: 'PATCH',
          body: JSON.stringify({ content }),
        });

        setLoading(loadingKey, false);
      },

      deleteComment: async (commentId: string, postId?: string) => {
        const { setLoading, postInteractions } = get();
        const loadingKey = `delete-comment-${commentId}`;

        setLoading(loadingKey, true);

        await apiCall(`/api/comments/${commentId}`, {
          method: 'DELETE',
        });

        if (postId) {
          const currentInteraction = postInteractions.get(postId);
          if (currentInteraction && currentInteraction.commentCount > 0) {
            set((state) => ({
              postInteractions: new Map(state.postInteractions).set(postId, {
                ...currentInteraction,
                commentCount: currentInteraction.commentCount - 1,
              }),
            }));
          }
        }

        setLoading(loadingKey, false);
      },

      loadComments: async (postId: string) => {
        const { clearError, setError, setLoading } = get();
        const loadingKey = `load-comments-${postId}`;

        setLoading(loadingKey, true);

        try {
          const response = await apiCall<{
            data?: { comments?: CommentWithReplies[] };
          }>(`/api/posts/${postId}/comments`);

          if (Array.isArray(response.data?.comments)) {
            clearError(loadingKey);
            return response.data.comments;
          }

          setError(loadingKey, {
            code: 'UNKNOWN',
            message: 'Unable to load comments right now.',
          });
          return [];
        } catch {
          setError(loadingKey, {
            code: 'NETWORK_ERROR',
            message: 'Unable to load comments right now.',
          });
          return [];
        } finally {
          setLoading(loadingKey, false);
        }
      },

      // Share actions
      toggleShare: async (postId: string, comment?: string) => {
        const { postInteractions, setLoading } = get();
        const currentInteraction = postInteractions.get(postId) || {
          postId,
          likeCount: 0,
          commentCount: 0,
          shareCount: 0,
          isLiked: false,
          isShared: false,
        };

        const wasShared = currentInteraction.isShared;
        const optimisticCount = wasShared
          ? currentInteraction.shareCount - 1
          : currentInteraction.shareCount + 1;

        const optimisticInteraction: PostInteraction = {
          ...currentInteraction,
          isShared: !wasShared,
          shareCount: Math.max(0, optimisticCount),
        };

        set((state) => ({
          postInteractions: new Map(state.postInteractions).set(
            postId,
            optimisticInteraction
          ),
        }));

        setLoading(`share-${postId}`, true);

        const method = wasShared ? 'DELETE' : 'POST';
        const body = comment ? JSON.stringify({ comment }) : JSON.stringify({});
        const response = await apiCall<{
          data: {
            shareCount: number;
            isShared: boolean;
            repostPost?: RepostPost;
          };
        }>(`/api/posts/${postId}/share`, {
          method,
          ...(method === 'POST' && { body }),
        });

        set((state) => ({
          postInteractions: new Map(state.postInteractions).set(postId, {
            ...currentInteraction,
            shareCount: response.data.shareCount,
            isShared: response.data.isShared,
          }),
        }));

        setLoading(`share-${postId}`, false);

        // Return response data (includes repostPost for optimistic UI)
        return response.data;
      },

      // Favorite actions (uses follow API)
      toggleFavorite: async (profileId: string) => {
        const { favoritedProfiles, setLoading } = get();
        const wasFavorited = favoritedProfiles.has(profileId);

        const newFavorites = new Set(favoritedProfiles);
        if (wasFavorited) {
          newFavorites.delete(profileId);
        } else {
          newFavorites.add(profileId);
        }

        set({ favoritedProfiles: newFavorites });
        setLoading(`favorite-${profileId}`, true);

        const method = wasFavorited ? 'DELETE' : 'POST';
        const encodedProfileId = encodeURIComponent(profileId);
        await apiCall(`/api/users/${encodedProfileId}/follow`, { method });

        setLoading(`favorite-${profileId}`, false);
      },

      loadFavorites: async () => {
        const { setLoading } = get();

        setLoading('favorites', true);

        const response = await apiCall<{
          data: { profiles: FavoriteProfile[] };
        }>('/api/profiles/favorites');

        const favoriteIds = new Set(response.data.profiles.map((p) => p.id));
        set({ favoritedProfiles: favoriteIds });

        setLoading('favorites', false);
        return response.data.profiles;
      },

      // Utility actions
      clearError: (id: string) => {
        set((state) => {
          const newErrors = new Map(state.errors);
          newErrors.delete(id);
          return { errors: newErrors };
        });
      },

      resetStore: () => {
        set({
          postInteractions: new Map(),
          commentInteractions: new Map(),
          favoritedProfiles: new Set(),
          pendingInteractions: new Map(),
          loadingStates: new Map(),
          errors: new Map(),
        });
      },

      getPostInteraction: (postId: string) => {
        return get().postInteractions.get(postId) || null;
      },

      getCommentInteraction: (commentId: string) => {
        return get().commentInteractions.get(commentId) || null;
      },

      isFavorited: (profileId: string) => {
        return get().favoritedProfiles.has(profileId);
      },

      setLoading: (id: string, loading: boolean) => {
        set((state) => {
          const newLoadingStates = new Map(state.loadingStates);
          if (loading) {
            newLoadingStates.set(id, true);
          } else {
            newLoadingStates.delete(id);
          }
          return { loadingStates: newLoadingStates };
        });
      },

      setError: (id: string, error: InteractionError) => {
        set((state) => ({
          errors: new Map(state.errors).set(id, error),
        }));
      },
    }),
    {
      name: 'feed-interactions',
      // Custom serialization for Maps and Sets
      partialize: (state: InteractionStore): PersistedInteractionState => ({
        postInteractions: Array.from(state.postInteractions.entries()),
        commentInteractions: Array.from(state.commentInteractions.entries()),
        favoritedProfiles: Array.from(state.favoritedProfiles),
      }),
      // Custom deserialization to convert arrays back to Maps and Sets
      merge: (persistedState: unknown, currentState: InteractionStore) => {
        const persisted = (persistedState as
          | Partial<PersistedInteractionState>
          | null
          | undefined) || {
          postInteractions: undefined,
          commentInteractions: undefined,
          favoritedProfiles: undefined,
        };

        return {
          ...currentState,
          postInteractions: new Map(persisted?.postInteractions || []),
          commentInteractions: new Map(persisted?.commentInteractions || []),
          favoritedProfiles: new Set(persisted?.favoritedProfiles || []),
        };
      },
    }
  )
);
