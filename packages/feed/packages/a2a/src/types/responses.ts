/**
 * A2A API Response Types
 *
 * Strongly typed response interfaces for all A2A protocol methods
 */

import type { JsonValue } from '@feed/shared';

/**
 * Balance information response
 */
export interface A2ABalanceResponse {
  balance: number;
  reputationPoints?: number;
  lifetimePnL?: number;
  totalDeposited?: number;
  totalWithdrawn?: number;
}

/**
 * Prediction market position data
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
 * Perpetual futures position data
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
 * Combined positions response
 */
export interface A2APositionsResponse {
  marketPositions: A2AMarketPosition[];
  perpPositions: A2APerpPosition[];
}

/**
 * Prediction market information
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
 * Prediction markets list response
 */
export interface A2APredictionsResponse {
  predictions: A2APredictionMarket[];
}

/**
 * Perpetual futures market information
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
 * Perpetual markets list response
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
 * Trending tags response from a2a.getTrendingTags
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
 * Chats response from a2a.getChats
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
 * Notifications response from a2a.getNotifications
 */
export interface A2ANotificationsResponse {
  notifications: A2ANotification[];
  unreadCount?: number;
}

/**
 * Unread count response from a2a.getUnreadCount
 */
export interface A2AUnreadCountResponse {
  unreadCount: number;
}

/**
 * User profile response from a2a.getUserProfile
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
 * User wallet response from a2a.getUserWallet
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
 * Trade history response from a2a.getTradeHistory
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
 * Leaderboard response from a2a.getLeaderboard
 */
export interface A2ALeaderboardResponse {
  leaderboard: A2ALeaderboardEntry[];
}

/**
 * System stats response from a2a.getSystemStats
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
 * Organizations response from a2a.getOrganizations
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
 * Users search response from a2a.searchUsers
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
 * Referrals response from a2a.getReferrals
 */
export interface A2AReferralsResponse {
  referrals: A2AReferral[];
}

/**
 * Referral stats response from a2a.getReferralStats
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
 * Referral code response from a2a.getReferralCode
 */
export interface A2AReferralCodeResponse {
  code: string;
  url: string;
}

/**
 * Reputation response from a2a.getReputation
 */
export interface A2AReputationResponse {
  reputationPoints: number;
  trustScore?: number;
  accuracyScore?: number;
  tradingScore?: number;
  socialScore?: number;
}
