/**
 * Widget Cache Store - Caches widget data to prevent unnecessary refetches
 * when navigating between pages
 */

import type { A2AReputationResponse } from "@polyagent/agents/client";
import type {
  PerpPositionFromAPI,
  PredictionPosition,
  UserBalanceData,
  UserProfileStats,
} from "@polyagent/shared";
import { create } from "zustand";

/**
 * Trending item structure for trending panel (supports grouped trends).
 * Used by the trending panel widget and cache store.
 */
export interface TrendingItem {
  id: string;
  tags: string[]; // Array of tag names (e.g., ["OpenAI", "Sam Altman"])
  tagSlugs: string[]; // Array of tag slugs for routing
  tagIds: string[]; // Array of tag IDs
  category?: string | null;
  totalPostCount: number;
  summary?: string | null;
  rank: number;
}

export interface BreakingNewsItem {
  id: string;
  title: string;
  description: string;
  icon: "chart" | "calendar" | "dollar" | "trending";
  timestamp: string;
  trending?: boolean;
  source?: string;
  fullDescription?: string;
  imageUrl?: string;
  relatedQuestion?: number;
  relatedActorId?: string;
  relatedOrganizationId?: string;
}

export interface ArticleItem {
  id: string;
  title: string;
  summary: string;
  authorOrgName: string;
  byline?: string;
  sentiment?: string;
  category?: string;
  publishedAt: string;
  relatedQuestion?: number;
  slant?: string;
  biasScore?: number;
}

export interface MarketsWidgetData {
  topPerpGainers: Array<{
    ticker: string;
    organizationId: string;
    name: string;
    currentPrice: number;
    changePercent24h: number;
    volume24h: number;
  }>;
  topPoolGainers: Array<{
    id: string;
    name: string;
    npcActorName: string;
    totalReturn: number;
    totalValue: number;
  }>;
  topVolumeQuestions: Array<{
    id: number;
    text: string;
    totalVolume: number;
    yesPrice: number;
    timeWeightedScore: number;
  }>;
  lastUpdated: string;
}

export interface UpcomingEvent {
  id: string;
  title: string;
  date: string;
  time?: string;
  isLive?: boolean;
  hint?: string;
  fullDescription?: string;
  source?: string;
  relatedQuestion?: number;
  imageUrl?: string;
  relatedActorId?: string;
  relatedOrganizationId?: string;
}

export interface PolyagentStats {
  activePlayers: number;
  aiAgents: number;
  totalHoots: number;
  pointsInCirculation: string;
}

interface ProfileWidgetData {
  balance: UserBalanceData | null;
  predictions: PredictionPosition[];
  perps: PerpPositionFromAPI[];
  stats: UserProfileStats | null;
}

interface CacheEntry<T> {
  data: T;
  timestamp: number;
}

interface WidgetCacheState {
  breakingNews: CacheEntry<BreakingNewsItem[]> | null;
  latestNews: CacheEntry<ArticleItem[]> | null;
  upcomingEvents: CacheEntry<UpcomingEvent[]> | null;
  trending: CacheEntry<TrendingItem[]> | null;
  stats: CacheEntry<PolyagentStats> | null;
  markets: CacheEntry<MarketsWidgetData> | null;
  profileWidget: Map<string, CacheEntry<ProfileWidgetData>>; // Keyed by userId
  reputationWidget: Map<string, CacheEntry<A2AReputationResponse>>; // Keyed by userId

  // TTL in milliseconds (default: 30 seconds)
  ttl: number;

  // Set cache entry
  setBreakingNews: (data: BreakingNewsItem[]) => void;
  setLatestNews: (data: ArticleItem[]) => void;
  setUpcomingEvents: (data: UpcomingEvent[]) => void;
  setTrending: (data: TrendingItem[]) => void;
  setStats: (data: PolyagentStats) => void;
  setMarkets: (data: MarketsWidgetData) => void;
  setProfileWidget: (userId: string, data: ProfileWidgetData) => void;
  setReputationWidget: (userId: string, data: A2AReputationResponse) => void;

  // Get cache entry (returns null if stale or missing)
  getBreakingNews: () => BreakingNewsItem[] | null;
  getLatestNews: () => ArticleItem[] | null;
  getUpcomingEvents: () => UpcomingEvent[] | null;
  getTrending: () => TrendingItem[] | null;
  getStats: () => PolyagentStats | null;
  getMarkets: () => MarketsWidgetData | null;
  getProfileWidget: (userId: string) => ProfileWidgetData | null;
  getReputationWidget: (userId: string) => A2AReputationResponse | null;

  // Check if cache is fresh
  isFresh: <T>(entry: CacheEntry<T> | null) => boolean;

  // Clear specific cache
  clearBreakingNews: () => void;
  clearLatestNews: () => void;
  clearUpcomingEvents: () => void;
  clearTrending: () => void;
  clearStats: () => void;
  clearMarkets: () => void;
  clearProfileWidget: (userId: string) => void;
  clearReputationWidget: (userId: string) => void;
  clearAll: () => void;
}

const DEFAULT_TTL = 30000; // 30 seconds

export const useWidgetCacheStore = create<WidgetCacheState>((set, get) => ({
  breakingNews: null,
  latestNews: null,
  upcomingEvents: null,
  trending: null,
  stats: null,
  markets: null,
  profileWidget: new Map(),
  reputationWidget: new Map(),
  ttl: DEFAULT_TTL,

  isFresh: <T>(entry: CacheEntry<T> | null) => {
    if (!entry) return false;
    const age = Date.now() - entry.timestamp;
    return age < get().ttl;
  },

  setBreakingNews: (data: BreakingNewsItem[]) => {
    set({
      breakingNews: {
        data,
        timestamp: Date.now(),
      },
    });
  },

  setLatestNews: (data: ArticleItem[]) => {
    set({
      latestNews: {
        data,
        timestamp: Date.now(),
      },
    });
  },

  setUpcomingEvents: (data: UpcomingEvent[]) => {
    set({
      upcomingEvents: {
        data,
        timestamp: Date.now(),
      },
    });
  },

  setTrending: (data: TrendingItem[]) => {
    set({
      trending: {
        data,
        timestamp: Date.now(),
      },
    });
  },

  setStats: (data: PolyagentStats) => {
    set({
      stats: {
        data,
        timestamp: Date.now(),
      },
    });
  },

  setMarkets: (data: MarketsWidgetData) => {
    set({
      markets: {
        data,
        timestamp: Date.now(),
      },
    });
  },

  setProfileWidget: (userId: string, data: ProfileWidgetData) => {
    const profileWidget = new Map(get().profileWidget);
    profileWidget.set(userId, {
      data,
      timestamp: Date.now(),
    });
    set({ profileWidget });
  },

  setReputationWidget: (userId: string, data: A2AReputationResponse) => {
    const reputationWidget = new Map(get().reputationWidget);
    reputationWidget.set(userId, {
      data,
      timestamp: Date.now(),
    });
    set({ reputationWidget });
  },

  getBreakingNews: () => {
    const entry = get().breakingNews;
    return entry && get().isFresh(entry) ? entry.data : null;
  },

  getLatestNews: () => {
    const entry = get().latestNews;
    return entry && get().isFresh(entry) ? entry.data : null;
  },

  getUpcomingEvents: () => {
    const entry = get().upcomingEvents;
    return entry && get().isFresh(entry) ? entry.data : null;
  },

  getTrending: () => {
    const entry = get().trending;
    return entry && get().isFresh(entry) ? entry.data : null;
  },

  getStats: () => {
    const entry = get().stats;
    return entry && get().isFresh(entry) ? entry.data : null;
  },

  getMarkets: () => {
    const entry = get().markets;
    return entry && get().isFresh(entry) ? entry.data : null;
  },

  getProfileWidget: (userId: string) => {
    const profileWidget = get().profileWidget;
    const entry = profileWidget.get(userId);
    return entry && get().isFresh(entry) ? entry.data : null;
  },

  getReputationWidget: (userId: string) => {
    const reputationWidget = get().reputationWidget;
    const entry = reputationWidget.get(userId);
    return entry && get().isFresh(entry) ? entry.data : null;
  },

  clearBreakingNews: () => set({ breakingNews: null }),
  clearLatestNews: () => set({ latestNews: null }),
  clearUpcomingEvents: () => set({ upcomingEvents: null }),
  clearTrending: () => set({ trending: null }),
  clearStats: () => set({ stats: null }),
  clearMarkets: () => set({ markets: null }),
  clearProfileWidget: (userId: string) => {
    const profileWidget = new Map(get().profileWidget);
    profileWidget.delete(userId);
    set({ profileWidget });
  },
  clearReputationWidget: (userId: string) => {
    const reputationWidget = new Map(get().reputationWidget);
    reputationWidget.delete(userId);
    set({ reputationWidget });
  },
  clearAll: () =>
    set({
      breakingNews: null,
      latestNews: null,
      upcomingEvents: null,
      trending: null,
      stats: null,
      markets: null,
      profileWidget: new Map(),
      reputationWidget: new Map(),
    }),
}));
