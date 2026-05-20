/**
 * Feed Store - Manages feed state and optimistic updates
 * Handles: optimistic post creation, quote posts
 */

import type { FeedPost } from "@feed/shared";
import { create } from "zustand";

interface FeedStoreState {
  // Callbacks for feed updates
  onOptimisticPost: ((post: FeedPost) => void) | null;
}

interface FeedStoreActions {
  // Register callback for optimistic post updates (used by feed page)
  registerOptimisticPostCallback: (callback: (post: FeedPost) => void) => void;
  unregisterOptimisticPostCallback: () => void;

  // Add optimistic post (called by components like RepostButton)
  addOptimisticPost: (post: FeedPost) => void;
}

type FeedStore = FeedStoreState & FeedStoreActions;

export const useFeedStore = create<FeedStore>((set, get) => ({
  // Initial state
  onOptimisticPost: null,

  // Register callback for feed page to receive optimistic posts
  registerOptimisticPostCallback: (callback) => {
    set({ onOptimisticPost: callback });
  },

  unregisterOptimisticPostCallback: () => {
    set({ onOptimisticPost: null });
  },

  // Add optimistic post - will call the registered callback if available
  addOptimisticPost: (post) => {
    const { onOptimisticPost } = get();
    if (onOptimisticPost) {
      onOptimisticPost(post);
    }
  },
}));
