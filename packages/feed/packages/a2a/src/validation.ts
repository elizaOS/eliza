/**
 * A2A Protocol Validation Schemas
 *
 * Zod schemas for validating A2A protocol method parameters.
 * All schemas follow the A2A Protocol v0.3.0 specification.
 *
 * @public
 */

import { JsonValueSchema } from '@babylon/shared';
import { z } from 'zod';

// Pagination defaults and limits
const DEFAULT_PAGINATION_LIMIT = 10;
const MAX_PAGINATION_LIMIT = 100;

/**
 * Offset-based pagination for A2A list operations.
 * Uses offset/limit rather than page/limit like the shared PaginationSchema.
 * Uses z.coerce.number() to handle string-to-number conversion for query params.
 */
export const OffsetPaginationSchema = z.object({
  offset: z.coerce.number().int().nonnegative().default(0),
  limit: z.coerce
    .number()
    .int()
    .min(1)
    .max(MAX_PAGINATION_LIMIT)
    .default(DEFAULT_PAGINATION_LIMIT),
});

export type OffsetPaginationParams = z.infer<typeof OffsetPaginationSchema>;

/**
 * Parameters for agent discovery requests
 */
export const DiscoverParamsSchema = z.object({
  filters: z
    .object({
      strategies: z.array(z.string()).optional(),
      minReputation: z.number().optional(),
      markets: z.array(z.string()).optional(),
    })
    .optional(),
  limit: z.number().optional(),
});

export const GetAgentInfoParamsSchema = z.object({
  agentId: z.string(),
});

export const GetMarketDataParamsSchema = z.object({
  marketId: z.string(),
});

export const GetMarketPricesParamsSchema = z.object({
  marketId: z.string(),
});

export const PaymentRequestParamsSchema = z.object({
  to: z.string(),
  amount: z.string(),
  service: z.string(),
  metadata: z.record(z.string(), JsonValueSchema).optional(),
  from: z.string().optional(),
});

export const PaymentReceiptParamsSchema = z.object({
  requestId: z.string(),
  txHash: z.string(),
});

/**
 * Parameters for listing prediction markets
 */
export const GetPredictionsParamsSchema = z.object({
  userId: z.string().optional(),
  status: z.enum(['active', 'resolved']).optional(),
});

export const GetPerpetualsParamsSchema = z.object({});

export const BuySharesParamsSchema = z.object({
  marketId: z.string(),
  outcome: z.enum(['YES', 'NO']),
  amount: z.number().positive(),
});

export const SellSharesParamsSchema = z.object({
  positionId: z.string(),
  shares: z.number().positive(),
});

export const OpenPositionParamsSchema = z.object({
  ticker: z.string(),
  side: z.enum(['LONG', 'SHORT']),
  amount: z.number().positive(),
  leverage: z.number().min(1).max(100),
});

export const ClosePositionParamsSchema = z.object({
  positionId: z.string(),
});

export const GetPositionsParamsSchema = z.object({
  userId: z.string().optional(),
});

/**
 * Parameters for retrieving social feed
 */
export const GetFeedParamsSchema = z.object({
  limit: z.number().optional().default(20),
  offset: z.number().optional().default(0),
  following: z.boolean().optional(),
  type: z.enum(['post', 'article']).optional(),
});

export const GetPostParamsSchema = z.object({
  postId: z.string(),
});

export const CreatePostParamsSchema = z.object({
  content: z.string().min(1).max(5000),
  type: z.enum(['post', 'article']).optional().default('post'),
});

export const DeletePostParamsSchema = z.object({
  postId: z.string(),
});

export const LikePostParamsSchema = z.object({
  postId: z.string(),
});

export const SharePostParamsSchema = z.object({
  postId: z.string(),
  comment: z.string().optional(),
});

export const GetCommentsParamsSchema = z.object({
  postId: z.string(),
  limit: z.number().optional().default(50),
});

export const CreateCommentParamsSchema = z.object({
  postId: z.string(),
  content: z.string().min(1).max(2000),
});

export const DeleteCommentParamsSchema = z.object({
  commentId: z.string(),
});

export const LikeCommentParamsSchema = z.object({
  commentId: z.string(),
});

/**
 * Parameters for retrieving user profile
 */
export const GetUserProfileParamsSchema = z.object({
  userId: z.string(),
});

export const UpdateProfileParamsSchema = z.object({
  displayName: z.string().optional(),
  bio: z.string().max(500).optional(),
  username: z.string().optional(),
  profileImageUrl: z.string().optional(),
});

export const GetBalanceParamsSchema = z.object({});

export const GetUserPositionsParamsSchema = z.object({
  userId: z.string(),
});

export const FollowUserParamsSchema = z.object({
  userId: z.string(),
});

export const UnfollowUserParamsSchema = z.object({
  userId: z.string(),
});

export const GetFollowersParamsSchema = z.object({
  userId: z.string(),
  limit: z.number().optional().default(50),
});

export const GetFollowingParamsSchema = z.object({
  userId: z.string(),
  limit: z.number().optional().default(50),
});

export const SearchUsersParamsSchema = z.object({
  query: z.string().min(1),
  limit: z.number().optional().default(20),
});

/**
 * Parameters for retrieving trades
 */
export const GetTradesParamsSchema = z.object({
  limit: z.number().optional().default(50),
  marketId: z.string().optional(),
});

export const GetTradeHistoryParamsSchema = z.object({
  userId: z.string(),
  limit: z.number().optional().default(50),
});

/**
 * Parameters for retrieving chats
 */
export const GetChatsParamsSchema = z.object({
  filter: z.enum(['all', 'dms', 'groups']).optional(),
});

export const GetChatMessagesParamsSchema = z.object({
  chatId: z.string(),
  limit: z.number().optional().default(50),
  offset: z.number().optional().default(0),
});

export const SendMessageParamsSchema = z.object({
  chatId: z.string(),
  content: z.string().min(1).max(5000),
});

export const CreateGroupParamsSchema = z.object({
  name: z.string().min(1).max(100),
  description: z.string().max(500).optional(),
  memberIds: z.array(z.string()).min(1),
});

export const LeaveChatParamsSchema = z.object({
  chatId: z.string(),
});

export const GetUnreadCountParamsSchema = z.object({});

/**
 * Parameters for retrieving notifications
 */
export const GetNotificationsParamsSchema = z.object({
  limit: z.number().optional().default(100),
});

export const MarkNotificationsReadParamsSchema = z.object({
  notificationIds: z.array(z.string()),
});

export const GetGroupInvitesParamsSchema = z.object({});

export const AcceptGroupInviteParamsSchema = z.object({
  inviteId: z.string(),
});

export const DeclineGroupInviteParamsSchema = z.object({
  inviteId: z.string(),
});

/**
 * Parameters for retrieving leaderboard
 */
export const GetLeaderboardParamsSchema = z.object({
  page: z.number().optional().default(1),
  pageSize: z.number().optional().default(100),
  pointsType: z.enum(['all', 'earned', 'referral']).optional().default('all'),
  minPoints: z.number().optional().default(0),
});

export const GetUserStatsParamsSchema = z.object({
  userId: z.string(),
});

export const GetSystemStatsParamsSchema = z.object({});

/**
 * Parameters for retrieving referrals
 */
export const GetReferralsParamsSchema = z.object({});

export const GetReferralStatsParamsSchema = z.object({});

export const GetReferralCodeParamsSchema = z.object({});

/**
 * Parameters for retrieving reputation
 */
export const GetReputationParamsSchema = z.object({
  userId: z.string().optional(),
});

export const GetReputationBreakdownParamsSchema = z.object({
  userId: z.string(),
});

/**
 * Parameters for retrieving trending tags
 */
export const GetTrendingTagsParamsSchema = z.object({
  limit: z.number().optional().default(20),
});

export const GetPostsByTagParamsSchema = z.object({
  tag: z.string(),
  limit: z.number().optional().default(20),
  offset: z.number().optional().default(0),
});

/**
 * Parameters for retrieving organizations
 */
export const GetOrganizationsParamsSchema = z.object({
  limit: z.number().optional().default(50),
});

/**
 * Parameters for favoriting a profile
 */
export const FavoriteProfileParamsSchema = z.object({
  userId: z.string().min(1),
});

export const UnfavoriteProfileParamsSchema = z.object({
  userId: z.string().min(1),
});

export const GetFavoritesParamsSchema = z.object({
  limit: z.number().min(1).max(100).optional().default(50),
  offset: z.number().min(0).optional().default(0),
});

export const GetFavoritePostsParamsSchema = z.object({
  limit: z.number().min(1).max(100).optional().default(20),
  offset: z.number().min(0).optional().default(0),
});
