/**
 * A2A API Response Types for @babylon/agents
 *
 * Strongly typed responses for A2A protocol methods
 */

import type { JsonValue } from './common';

/**
 * Balance response from a2a.getBalance
 */
export interface A2ABalanceResponse {
  balance: number;
  reputationPoints?: number;
  lifetimePnL?: number;
  totalDeposited?: number;
  totalWithdrawn?: number;
}

/**
 * Prediction market position
 */
export interface A2AMarketPosition {
  id: string;
  marketId: string;
  question: string;
  side: 'YES' | 'NO';
  shares: number;
  avgPrice: number;
  currentPrice: number;
  unrealizedPnL: number;
}

/**
 * Perpetual position
 */
export interface A2APerpPosition {
  id: string;
  ticker: string;
  side: 'long' | 'short';
  size: number;
  amount?: number;
  entryPrice: number;
  currentPrice: number;
  leverage: number;
  unrealizedPnL: number;
  liquidationPrice?: number;
}

/**
 * Positions response from a2a.getPositions
 */
export interface A2APositionsResponse {
  marketPositions: A2AMarketPosition[];
  perpPositions: A2APerpPosition[];
}

/**
 * Prediction market data
 */
export interface A2APredictionMarket {
  id: string;
  question: string;
  yesShares: number;
  noShares: number;
  liquidity: number;
  totalVolume?: number;
  resolved?: boolean;
  endDate?: string | number;
}

/**
 * Predictions response from a2a.getPredictions
 */
export interface A2APredictionsResponse {
  predictions: A2APredictionMarket[];
}

/**
 * Perpetual market data
 */
export interface A2APerpetualMarket {
  name: string;
  ticker: string;
  currentPrice: number;
  priceChange24h?: number;
  volume24h?: number;
  openInterest?: number;
  fundingRate?: number;
}

/**
 * Perpetuals response from a2a.getPerpetuals
 */
export interface A2APerpetualsResponse {
  tickers?: A2APerpetualMarket[];
  perpetuals?: A2APerpetualMarket[];
}

/**
 * Post author
 */
export interface A2APostAuthor {
  id?: string;
  username?: string;
  displayName?: string;
}

/**
 * Social feed post
 */
export interface A2AFeedPost {
  id: string;
  content: string;
  author: A2APostAuthor;
  commentsCount?: number;
  reactionsCount?: number;
  timestamp?: string | number;
  createdAt?: string | number;
}

/**
 * Feed response from a2a.getFeed
 */
export interface A2AFeedResponse {
  posts: A2AFeedPost[];
}

/**
 * Trending tag
 */
export interface A2ATrendingTag {
  name: string;
  displayName?: string;
  category?: string;
  postCount?: number;
  score?: number;
}

/**
 * Trending tags response
 */
export interface A2ATrendingTagsResponse {
  tags: A2ATrendingTag[];
}

/**
 * Chat participant info
 */
export interface A2AChatParticipant {
  id: string;
  username?: string;
  displayName?: string;
}

/**
 * Chat message
 */
export interface A2AChatMessage {
  id: string;
  content: string;
  authorId: string;
  timestamp: string | number;
}

/**
 * Chat data
 */
export interface A2AChat {
  id: string;
  name?: string;
  isGroup: boolean;
  participants: number;
  lastMessage?: A2AChatMessage;
  updatedAt?: string | number;
}

/**
 * Chats response
 */
export interface A2AChatsResponse {
  chats: A2AChat[];
}

/**
 * Notification data
 */
export interface A2ANotification {
  id: string;
  type: string;
  message: string;
  read: boolean;
  createdAt: string | number;
}

/**
 * Notifications response
 */
export interface A2ANotificationsResponse {
  notifications: A2ANotification[];
  unreadCount?: number;
}

/**
 * Unread count response
 */
export interface A2AUnreadCountResponse {
  unreadCount: number;
}

/**
 * User profile response
 */
export interface A2AUserProfileResponse {
  id: string;
  username: string | null;
  displayName: string | null;
  bio: string | null;
  profileImageUrl: string | null;
  reputationPoints: number;
  virtualBalance: number;
  walletAddress?: string | null;
  isAgent?: boolean;
  createdAt?: string | Date;
}

/**
 * User wallet response
 */
export interface A2AUserWalletResponse {
  balance: A2ABalanceResponse;
  positions: A2APositionsResponse;
}

/**
 * Trade history entry
 */
export interface A2ATradeHistoryEntry {
  id: string;
  marketId?: string;
  ticker?: string;
  type: 'prediction' | 'perp';
  action: string;
  amount: number;
  price: number;
  pnl?: number;
  timestamp: string | number;
}

/**
 * Trade history response
 */
export interface A2ATradeHistoryResponse {
  trades: A2ATradeHistoryEntry[];
}

/**
 * Leaderboard entry
 */
export interface A2ALeaderboardEntry {
  id: string;
  username: string;
  displayName?: string;
  reputationPoints?: number;
  totalPnL?: number;
}

/**
 * Leaderboard response
 */
export interface A2ALeaderboardResponse {
  leaderboard: A2ALeaderboardEntry[];
}

/**
 * System stats response
 */
export interface A2ASystemStatsResponse {
  markets?: number;
  users?: number;
  posts?: number;
  [key: string]: JsonValue | undefined;
}

/**
 * Organization data
 */
export interface A2AOrganization {
  id: string;
  name: string;
  ticker?: string;
  description?: string;
  imageUrl?: string;
  currentPrice?: number;
  priceChange24h?: number;
}

/**
 * Organizations response
 */
export interface A2AOrganizationsResponse {
  organizations: A2AOrganization[];
}

/**
 * User search result
 */
export interface A2AUserSearchResult {
  id: string;
  username: string | null;
  displayName: string | null;
  profileImageUrl?: string | null;
  isAgent?: boolean;
  reputationPoints?: number;
}

/**
 * Users search response
 */
export interface A2AUsersSearchResponse {
  users: A2AUserSearchResult[];
}

/**
 * Referral data
 */
export interface A2AReferral {
  id: string;
  referredUserId: string;
  referredUsername?: string;
  pointsEarned?: number;
  createdAt: string | number;
}

/**
 * Referrals response
 */
export interface A2AReferralsResponse {
  referrals: A2AReferral[];
}

/**
 * Referral stats response
 */
export interface A2AReferralStatsResponse {
  totalReferrals: number;
  totalReputationEarned: number;
  /**
   * @deprecated Use totalReputationEarned.
   */
  totalPointsEarned: number;
  activeReferrals?: number;
}

/**
 * Referral code response
 */
export interface A2AReferralCodeResponse {
  code: string;
  url: string;
}

/**
 * Reputation response
 */
export interface A2AReputationResponse {
  reputationPoints: number;
  trustScore?: number;
  accuracyScore?: number;
  tradingScore?: number;
  socialScore?: number;
}
