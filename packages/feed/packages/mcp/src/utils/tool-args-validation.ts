/**
 * MCP Tool Arguments Validation
 *
 * Validation schemas for each tool's arguments
 */

import { JsonValueSchema } from '@babylon/shared';
import { z } from 'zod';
import type {
  AcceptGroupInviteArgs,
  AppealBanArgs,
  AppealBanWithEscrowArgs,
  BlockUserArgs,
  BuySharesArgs,
  CheckBlockStatusArgs,
  CheckMuteStatusArgs,
  ClosePositionArgs,
  CreateCommentArgs,
  CreateEscrowPaymentArgs,
  CreateGroupArgs,
  CreatePostArgs,
  DeclineGroupInviteArgs,
  DeleteCommentArgs,
  DeletePostArgs,
  FavoriteProfileArgs,
  FollowUserArgs,
  GetBalanceArgs,
  GetBlocksArgs,
  GetChatMessagesArgs,
  GetChatsArgs,
  GetCommentsArgs,
  GetFavoritePostsArgs,
  GetFavoritesArgs,
  GetFollowersArgs,
  GetFollowingArgs,
  GetGroupInvitesArgs,
  GetLeaderboardArgs,
  GetMarketDataArgs,
  GetMarketPricesArgs,
  GetMarketsArgs,
  GetMutesArgs,
  GetNotificationsArgs,
  GetOrganizationsArgs,
  GetPerpetualsArgs,
  GetPortfolioArgs,
  GetPositionsArgs,
  GetPostArgs,
  GetPostsByTagArgs,
  GetReferralCodeArgs,
  GetReferralStatsArgs,
  GetReferralsArgs,
  GetReputationArgs,
  GetReputationBreakdownArgs,
  GetSystemStatsArgs,
  GetTradeHistoryArgs,
  GetTradesArgs,
  GetTrendingTagsArgs,
  GetUnreadCountArgs,
  GetUserProfileArgs,
  GetUserStatsArgs,
  GetUserWalletArgs,
  LeaveChatArgs,
  LikeCommentArgs,
  LikePostArgs,
  ListEscrowPaymentsArgs,
  MarkNotificationsReadArgs,
  MuteUserArgs,
  OpenPositionArgs,
  PaymentReceiptArgs,
  PaymentRequestArgs,
  PlaceBetArgs,
  QueryFeedArgs,
  RefundEscrowPaymentArgs,
  ReportPostArgs,
  ReportUserArgs,
  ResolveMarketArgs,
  SearchAgentsArgs,
  SearchUsersArgs,
  SellSharesArgs,
  SendMessageArgs,
  SharePostArgs,
  UnblockUserArgs,
  UnfavoriteProfileArgs,
  UnfollowUserArgs,
  UnlikePostArgs,
  UnmuteUserArgs,
  UpdateProfileArgs,
  VerifyEscrowPaymentArgs,
} from '../types/mcp';

const GetMarketsArgsSchema = z.object({
  type: z.enum(['prediction', 'perpetuals', 'all']).optional(),
}) satisfies z.ZodType<GetMarketsArgs>;

const PlaceBetArgsSchema = z.object({
  marketId: z.string().min(1),
  side: z.enum(['YES', 'NO']),
  amount: z.number().positive(),
}) satisfies z.ZodType<PlaceBetArgs>;

const GetBalanceArgsSchema = z.object({}) satisfies z.ZodType<GetBalanceArgs>;

const GetPositionsArgsSchema = z.object({
  marketId: z.string().optional(),
  limit: z.number().int().positive().optional(),
  offset: z.number().int().nonnegative().optional(),
}) satisfies z.ZodType<GetPositionsArgs>;

const ClosePositionArgsSchema = z.object({
  positionId: z.string().min(1),
}) satisfies z.ZodType<ClosePositionArgs>;

const GetMarketDataArgsSchema = z.object({
  marketId: z.string().min(1),
}) satisfies z.ZodType<GetMarketDataArgs>;

const QueryFeedArgsSchema = z.object({
  limit: z.number().int().positive().optional(),
  questionId: z.string().optional(),
}) satisfies z.ZodType<QueryFeedArgs>;

/**
 * Validate and parse tool arguments
 */
export function validateGetMarketsArgs(args: unknown): GetMarketsArgs {
  return GetMarketsArgsSchema.parse(args);
}

export function validatePlaceBetArgs(args: unknown): PlaceBetArgs {
  return PlaceBetArgsSchema.parse(args);
}

export function validateGetBalanceArgs(args: unknown): GetBalanceArgs {
  return GetBalanceArgsSchema.parse(args);
}

export function validateGetPositionsArgs(args: unknown): GetPositionsArgs {
  return GetPositionsArgsSchema.parse(args);
}

export function validateClosePositionArgs(args: unknown): ClosePositionArgs {
  return ClosePositionArgsSchema.parse(args);
}

export function validateGetMarketDataArgs(args: unknown): GetMarketDataArgs {
  return GetMarketDataArgsSchema.parse(args);
}

export function validateQueryFeedArgs(args: unknown): QueryFeedArgs {
  return QueryFeedArgsSchema.parse(args);
}

// Market Operations - Validation Schemas
const BuySharesArgsSchema = z.object({
  marketId: z.string().min(1),
  outcome: z.enum(['YES', 'NO']),
  amount: z.number().positive(),
}) satisfies z.ZodType<BuySharesArgs>;

const SellSharesArgsSchema = z.object({
  positionId: z.string().min(1),
  shares: z.number().positive(),
}) satisfies z.ZodType<SellSharesArgs>;

const OpenPositionArgsSchema = z.object({
  ticker: z.string().min(1),
  side: z.enum(['LONG', 'SHORT']),
  amount: z.number().positive(),
  leverage: z.number().min(1).max(100),
}) satisfies z.ZodType<OpenPositionArgs>;

const GetMarketPricesArgsSchema = z.object({
  marketId: z.string().min(1),
}) satisfies z.ZodType<GetMarketPricesArgs>;

const GetPerpetualsArgsSchema = z.object(
  {}
) satisfies z.ZodType<GetPerpetualsArgs>;

const GetTradesArgsSchema = z.object({
  limit: z.number().int().positive().optional(),
  marketId: z.string().optional(),
}) satisfies z.ZodType<GetTradesArgs>;

const GetTradeHistoryArgsSchema = z.object({
  userId: z.string().min(1),
  limit: z.number().int().positive().optional(),
}) satisfies z.ZodType<GetTradeHistoryArgs>;

// Social Features - Validation Schemas
const GetPostArgsSchema = z.object({
  postId: z.string().min(1),
}) satisfies z.ZodType<GetPostArgs>;

const CreatePostArgsSchema = z.object({
  content: z.string().min(1).max(5000),
  type: z.enum(['post', 'article']).optional().default('post'),
  mediaUrl: z.string().url().optional(),
}) satisfies z.ZodType<CreatePostArgs>;

const DeletePostArgsSchema = z.object({
  postId: z.string().min(1),
}) satisfies z.ZodType<DeletePostArgs>;

const LikePostArgsSchema = z.object({
  postId: z.string().min(1),
}) satisfies z.ZodType<LikePostArgs>;

const UnlikePostArgsSchema = z.object({
  postId: z.string().min(1),
}) satisfies z.ZodType<UnlikePostArgs>;

const SharePostArgsSchema = z.object({
  postId: z.string().min(1),
  comment: z.string().optional(),
}) satisfies z.ZodType<SharePostArgs>;

const GetCommentsArgsSchema = z.object({
  postId: z.string().min(1),
  limit: z.number().int().positive().optional().default(50),
}) satisfies z.ZodType<GetCommentsArgs>;

const CreateCommentArgsSchema = z.object({
  postId: z.string().min(1),
  content: z.string().min(1).max(2000),
}) satisfies z.ZodType<CreateCommentArgs>;

const DeleteCommentArgsSchema = z.object({
  commentId: z.string().min(1),
}) satisfies z.ZodType<DeleteCommentArgs>;

const LikeCommentArgsSchema = z.object({
  commentId: z.string().min(1),
}) satisfies z.ZodType<LikeCommentArgs>;

const GetPostsByTagArgsSchema = z.object({
  tag: z.string().min(1),
  limit: z.number().int().positive().optional().default(20),
  offset: z.number().int().nonnegative().optional().default(0),
}) satisfies z.ZodType<GetPostsByTagArgs>;

// User Management - Validation Schemas
const GetUserProfileArgsSchema = z.object({
  userId: z.string().min(1),
}) satisfies z.ZodType<GetUserProfileArgs>;

const UpdateProfileArgsSchema = z.object({
  displayName: z.string().optional(),
  bio: z.string().max(500).optional(),
  username: z.string().optional(),
  profileImageUrl: z.string().optional(),
}) satisfies z.ZodType<UpdateProfileArgs>;

const FollowUserArgsSchema = z.object({
  userId: z.string().min(1),
}) satisfies z.ZodType<FollowUserArgs>;

const UnfollowUserArgsSchema = z.object({
  userId: z.string().min(1),
}) satisfies z.ZodType<UnfollowUserArgs>;

const GetFollowersArgsSchema = z.object({
  userId: z.string().min(1),
  limit: z.number().int().positive().optional().default(50),
}) satisfies z.ZodType<GetFollowersArgs>;

const GetFollowingArgsSchema = z.object({
  userId: z.string().min(1),
  limit: z.number().int().positive().optional().default(50),
}) satisfies z.ZodType<GetFollowingArgs>;

const SearchUsersArgsSchema = z.object({
  query: z.string().min(1),
  limit: z.number().int().positive().optional().default(20),
}) satisfies z.ZodType<SearchUsersArgs>;

const SearchAgentsArgsSchema = z.object({
  query: z.string().min(1),
  limit: z.number().int().positive().optional().default(20),
}) satisfies z.ZodType<SearchAgentsArgs>;

const GetUserWalletArgsSchema = z.object({
  userId: z.string().min(1),
}) satisfies z.ZodType<GetUserWalletArgs>;

const GetUserStatsArgsSchema = z.object({
  userId: z.string().min(1),
}) satisfies z.ZodType<GetUserStatsArgs>;

// Chats & Messaging - Validation Schemas
const GetChatsArgsSchema = z.object({
  filter: z.enum(['all', 'dms', 'groups']).optional(),
}) satisfies z.ZodType<GetChatsArgs>;

const GetChatMessagesArgsSchema = z.object({
  chatId: z.string().min(1),
  limit: z.number().int().positive().optional().default(50),
  offset: z.number().int().nonnegative().optional().default(0),
}) satisfies z.ZodType<GetChatMessagesArgs>;

const SendMessageArgsSchema = z.object({
  chatId: z.string().min(1),
  content: z.string().min(1).max(5000),
}) satisfies z.ZodType<SendMessageArgs>;

const CreateGroupArgsSchema = z.object({
  name: z.string().min(1).max(100),
  description: z.string().max(500).optional(),
  memberIds: z.array(z.string().min(1)).min(1),
}) satisfies z.ZodType<CreateGroupArgs>;

const LeaveChatArgsSchema = z.object({
  chatId: z.string().min(1),
}) satisfies z.ZodType<LeaveChatArgs>;

const GetUnreadCountArgsSchema = z.object(
  {}
) satisfies z.ZodType<GetUnreadCountArgs>;

// Notifications - Validation Schemas
const GetNotificationsArgsSchema = z.object({
  limit: z.number().int().positive().optional().default(100),
}) satisfies z.ZodType<GetNotificationsArgs>;

const MarkNotificationsReadArgsSchema = z.object({
  notificationIds: z.array(z.string().min(1)),
}) satisfies z.ZodType<MarkNotificationsReadArgs>;

const GetPortfolioArgsSchema = z.object(
  {}
) satisfies z.ZodType<GetPortfolioArgs>;

const GetGroupInvitesArgsSchema = z.object(
  {}
) satisfies z.ZodType<GetGroupInvitesArgs>;

const AcceptGroupInviteArgsSchema = z.object({
  inviteId: z.string().min(1),
}) satisfies z.ZodType<AcceptGroupInviteArgs>;

const DeclineGroupInviteArgsSchema = z.object({
  inviteId: z.string().min(1),
}) satisfies z.ZodType<DeclineGroupInviteArgs>;

// Leaderboard & Stats - Validation Schemas
const GetLeaderboardArgsSchema = z.object({
  page: z.number().int().positive().optional().default(1),
  pageSize: z.number().int().positive().optional().default(100),
  type: z.enum(['wallet', 'team']).optional().default('wallet'),
  pointsType: z.enum(['all', 'earned', 'referral']).optional(),
  minPoints: z.number().nonnegative().optional().default(0),
}) satisfies z.ZodType<GetLeaderboardArgs>;

const GetSystemStatsArgsSchema = z.object(
  {}
) satisfies z.ZodType<GetSystemStatsArgs>;

const ResolveMarketArgsSchema = z.object({
  marketId: z.string().min(1),
  resolution: z.boolean(),
  reason: z.string().max(500).optional(),
}) satisfies z.ZodType<ResolveMarketArgs>;

// Referrals & Rewards - Validation Schemas
const GetReferralCodeArgsSchema = z.object(
  {}
) satisfies z.ZodType<GetReferralCodeArgs>;

const GetReferralsArgsSchema = z.object(
  {}
) satisfies z.ZodType<GetReferralsArgs>;

const GetReferralStatsArgsSchema = z.object(
  {}
) satisfies z.ZodType<GetReferralStatsArgs>;

// Reputation - Validation Schemas
const GetReputationArgsSchema = z.object({
  userId: z.string().optional(),
}) satisfies z.ZodType<GetReputationArgs>;

const GetReputationBreakdownArgsSchema = z.object({
  userId: z.string().min(1),
}) satisfies z.ZodType<GetReputationBreakdownArgs>;

// Trending & Discovery - Validation Schemas
const GetTrendingTagsArgsSchema = z.object({
  limit: z.number().int().positive().optional().default(20),
}) satisfies z.ZodType<GetTrendingTagsArgs>;

// Organizations - Validation Schemas
const GetOrganizationsArgsSchema = z.object({
  limit: z.number().int().positive().optional().default(50),
}) satisfies z.ZodType<GetOrganizationsArgs>;

// x402 Micropayments - Validation Schemas
const PaymentRequestArgsSchema = z.object({
  to: z.string().min(1),
  amount: z.string().min(1),
  service: z.string().min(1),
  metadata: z.record(z.string(), JsonValueSchema).optional(),
  from: z.string().optional(),
}) satisfies z.ZodType<PaymentRequestArgs>;

const PaymentReceiptArgsSchema = z.object({
  requestId: z.string().min(1),
  txHash: z.string().min(1),
}) satisfies z.ZodType<PaymentReceiptArgs>;

// Moderation - Validation Schemas
const BlockUserArgsSchema = z.object({
  userId: z.string().min(1),
}) satisfies z.ZodType<BlockUserArgs>;

const UnblockUserArgsSchema = z.object({
  userId: z.string().min(1),
}) satisfies z.ZodType<UnblockUserArgs>;

const MuteUserArgsSchema = z.object({
  userId: z.string().min(1),
}) satisfies z.ZodType<MuteUserArgs>;

const UnmuteUserArgsSchema = z.object({
  userId: z.string().min(1),
}) satisfies z.ZodType<UnmuteUserArgs>;

const ReportUserArgsSchema = z.object({
  userId: z.string().min(1),
  reason: z.string().min(1),
}) satisfies z.ZodType<ReportUserArgs>;

const ReportPostArgsSchema = z.object({
  postId: z.string().min(1),
  reason: z.string().min(1),
}) satisfies z.ZodType<ReportPostArgs>;

const GetBlocksArgsSchema = z.object({}) satisfies z.ZodType<GetBlocksArgs>;

const GetMutesArgsSchema = z.object({}) satisfies z.ZodType<GetMutesArgs>;

const CheckBlockStatusArgsSchema = z.object({
  userId: z.string().min(1),
}) satisfies z.ZodType<CheckBlockStatusArgs>;

const CheckMuteStatusArgsSchema = z.object({
  userId: z.string().min(1),
}) satisfies z.ZodType<CheckMuteStatusArgs>;

// Moderation Escrow - Validation Schemas
const CreateEscrowPaymentArgsSchema = z.object({
  recipientId: z.string().min(1),
  amountUSD: z.number().positive(),
  reason: z.string().optional(),
  recipientWalletAddress: z.string().min(1),
}) satisfies z.ZodType<CreateEscrowPaymentArgs>;

const VerifyEscrowPaymentArgsSchema = z.object({
  escrowId: z.string().min(1),
  txHash: z.string().min(1),
  fromAddress: z.string().min(1),
  toAddress: z.string().min(1),
  amount: z.string().min(1),
}) satisfies z.ZodType<VerifyEscrowPaymentArgs>;

const RefundEscrowPaymentArgsSchema = z.object({
  escrowId: z.string().min(1),
  refundTxHash: z.string().min(1),
  reason: z.string().optional(),
}) satisfies z.ZodType<RefundEscrowPaymentArgs>;

const ListEscrowPaymentsArgsSchema = z.object({
  recipientId: z.string().optional(),
  adminId: z.string().optional(),
  status: z.enum(['pending', 'paid', 'refunded', 'expired']).optional(),
  limit: z.number().int().positive().max(100).optional().default(50),
  offset: z.number().int().nonnegative().optional().default(0),
}) satisfies z.ZodType<ListEscrowPaymentsArgs>;

// Ban Appeals - Validation Schemas
const AppealBanArgsSchema = z.object({
  reason: z.string().min(10).max(2000),
}) satisfies z.ZodType<AppealBanArgs>;

const AppealBanWithEscrowArgsSchema = z.object({
  reason: z.string().min(10).max(2000),
  escrowPaymentTxHash: z.string().min(1),
}) satisfies z.ZodType<AppealBanWithEscrowArgs>;

// Favorites - Validation Schemas
const FavoriteProfileArgsSchema = z.object({
  userId: z.string().min(1),
}) satisfies z.ZodType<FavoriteProfileArgs>;

const UnfavoriteProfileArgsSchema = z.object({
  userId: z.string().min(1),
}) satisfies z.ZodType<UnfavoriteProfileArgs>;

const GetFavoritesArgsSchema = z.object({
  limit: z.number().int().positive().max(100).optional().default(50),
  offset: z.number().int().nonnegative().optional().default(0),
}) satisfies z.ZodType<GetFavoritesArgs>;

const GetFavoritePostsArgsSchema = z.object({
  limit: z.number().int().positive().max(100).optional().default(20),
  offset: z.number().int().nonnegative().optional().default(0),
}) satisfies z.ZodType<GetFavoritePostsArgs>;

// Validation Functions - Market Operations
export function validateBuySharesArgs(args: unknown): BuySharesArgs {
  return BuySharesArgsSchema.parse(args);
}

export function validateSellSharesArgs(args: unknown): SellSharesArgs {
  return SellSharesArgsSchema.parse(args);
}

export function validateOpenPositionArgs(args: unknown): OpenPositionArgs {
  return OpenPositionArgsSchema.parse(args);
}

export function validateGetMarketPricesArgs(
  args: unknown
): GetMarketPricesArgs {
  return GetMarketPricesArgsSchema.parse(args);
}

export function validateGetPerpetualsArgs(args: unknown): GetPerpetualsArgs {
  return GetPerpetualsArgsSchema.parse(args);
}

export function validateGetTradesArgs(args: unknown): GetTradesArgs {
  return GetTradesArgsSchema.parse(args);
}

export function validateGetTradeHistoryArgs(
  args: unknown
): GetTradeHistoryArgs {
  return GetTradeHistoryArgsSchema.parse(args);
}

// Validation Functions - Social Features
export function validateGetPostArgs(args: unknown): GetPostArgs {
  return GetPostArgsSchema.parse(args);
}

export function validateCreatePostArgs(args: unknown): CreatePostArgs {
  return CreatePostArgsSchema.parse(args);
}

export function validateDeletePostArgs(args: unknown): DeletePostArgs {
  return DeletePostArgsSchema.parse(args);
}

export function validateLikePostArgs(args: unknown): LikePostArgs {
  return LikePostArgsSchema.parse(args);
}

export function validateUnlikePostArgs(args: unknown): UnlikePostArgs {
  return UnlikePostArgsSchema.parse(args);
}

export function validateSharePostArgs(args: unknown): SharePostArgs {
  return SharePostArgsSchema.parse(args);
}

export function validateGetCommentsArgs(args: unknown): GetCommentsArgs {
  return GetCommentsArgsSchema.parse(args);
}

export function validateCreateCommentArgs(args: unknown): CreateCommentArgs {
  return CreateCommentArgsSchema.parse(args);
}

export function validateDeleteCommentArgs(args: unknown): DeleteCommentArgs {
  return DeleteCommentArgsSchema.parse(args);
}

export function validateLikeCommentArgs(args: unknown): LikeCommentArgs {
  return LikeCommentArgsSchema.parse(args);
}

export function validateGetPostsByTagArgs(args: unknown): GetPostsByTagArgs {
  return GetPostsByTagArgsSchema.parse(args);
}

// Validation Functions - User Management
export function validateGetUserProfileArgs(args: unknown): GetUserProfileArgs {
  return GetUserProfileArgsSchema.parse(args);
}

export function validateUpdateProfileArgs(args: unknown): UpdateProfileArgs {
  return UpdateProfileArgsSchema.parse(args);
}

export function validateFollowUserArgs(args: unknown): FollowUserArgs {
  return FollowUserArgsSchema.parse(args);
}

export function validateUnfollowUserArgs(args: unknown): UnfollowUserArgs {
  return UnfollowUserArgsSchema.parse(args);
}

export function validateGetFollowersArgs(args: unknown): GetFollowersArgs {
  return GetFollowersArgsSchema.parse(args);
}

export function validateGetFollowingArgs(args: unknown): GetFollowingArgs {
  return GetFollowingArgsSchema.parse(args);
}

export function validateSearchUsersArgs(args: unknown): SearchUsersArgs {
  return SearchUsersArgsSchema.parse(args);
}

export function validateSearchAgentsArgs(args: unknown): SearchAgentsArgs {
  return SearchAgentsArgsSchema.parse(args);
}

export function validateGetUserWalletArgs(args: unknown): GetUserWalletArgs {
  return GetUserWalletArgsSchema.parse(args);
}

export function validateGetUserStatsArgs(args: unknown): GetUserStatsArgs {
  return GetUserStatsArgsSchema.parse(args);
}

// Validation Functions - Chats & Messaging
export function validateGetChatsArgs(args: unknown): GetChatsArgs {
  return GetChatsArgsSchema.parse(args);
}

export function validateGetChatMessagesArgs(
  args: unknown
): GetChatMessagesArgs {
  return GetChatMessagesArgsSchema.parse(args);
}

export function validateSendMessageArgs(args: unknown): SendMessageArgs {
  return SendMessageArgsSchema.parse(args);
}

export function validateCreateGroupArgs(args: unknown): CreateGroupArgs {
  return CreateGroupArgsSchema.parse(args);
}

export function validateLeaveChatArgs(args: unknown): LeaveChatArgs {
  return LeaveChatArgsSchema.parse(args);
}

export function validateGetUnreadCountArgs(args: unknown): GetUnreadCountArgs {
  return GetUnreadCountArgsSchema.parse(args);
}

// Validation Functions - Notifications
export function validateGetNotificationsArgs(
  args: unknown
): GetNotificationsArgs {
  return GetNotificationsArgsSchema.parse(args);
}

export function validateMarkNotificationsReadArgs(
  args: unknown
): MarkNotificationsReadArgs {
  return MarkNotificationsReadArgsSchema.parse(args);
}

export function validateGetPortfolioArgs(args: unknown): GetPortfolioArgs {
  return GetPortfolioArgsSchema.parse(args);
}

export function validateGetGroupInvitesArgs(
  args: unknown
): GetGroupInvitesArgs {
  return GetGroupInvitesArgsSchema.parse(args);
}

export function validateAcceptGroupInviteArgs(
  args: unknown
): AcceptGroupInviteArgs {
  return AcceptGroupInviteArgsSchema.parse(args);
}

export function validateDeclineGroupInviteArgs(
  args: unknown
): DeclineGroupInviteArgs {
  return DeclineGroupInviteArgsSchema.parse(args);
}

// Validation Functions - Leaderboard & Stats
export function validateGetLeaderboardArgs(args: unknown): GetLeaderboardArgs {
  return GetLeaderboardArgsSchema.parse(args);
}

export function validateGetSystemStatsArgs(args: unknown): GetSystemStatsArgs {
  return GetSystemStatsArgsSchema.parse(args);
}

export function validateResolveMarketArgs(args: unknown): ResolveMarketArgs {
  return ResolveMarketArgsSchema.parse(args);
}

// Validation Functions - Referrals & Rewards
export function validateGetReferralCodeArgs(
  args: unknown
): GetReferralCodeArgs {
  return GetReferralCodeArgsSchema.parse(args);
}

export function validateGetReferralsArgs(args: unknown): GetReferralsArgs {
  return GetReferralsArgsSchema.parse(args);
}

export function validateGetReferralStatsArgs(
  args: unknown
): GetReferralStatsArgs {
  return GetReferralStatsArgsSchema.parse(args);
}

// Validation Functions - Reputation
export function validateGetReputationArgs(args: unknown): GetReputationArgs {
  return GetReputationArgsSchema.parse(args);
}

export function validateGetReputationBreakdownArgs(
  args: unknown
): GetReputationBreakdownArgs {
  return GetReputationBreakdownArgsSchema.parse(args);
}

// Validation Functions - Trending & Discovery
export function validateGetTrendingTagsArgs(
  args: unknown
): GetTrendingTagsArgs {
  return GetTrendingTagsArgsSchema.parse(args);
}

// Validation Functions - Organizations
export function validateGetOrganizationsArgs(
  args: unknown
): GetOrganizationsArgs {
  return GetOrganizationsArgsSchema.parse(args);
}

// Validation Functions - x402 Micropayments
export function validatePaymentRequestArgs(args: unknown): PaymentRequestArgs {
  return PaymentRequestArgsSchema.parse(args);
}

export function validatePaymentReceiptArgs(args: unknown): PaymentReceiptArgs {
  return PaymentReceiptArgsSchema.parse(args);
}

// Validation Functions - Moderation
export function validateBlockUserArgs(args: unknown): BlockUserArgs {
  return BlockUserArgsSchema.parse(args);
}

export function validateUnblockUserArgs(args: unknown): UnblockUserArgs {
  return UnblockUserArgsSchema.parse(args);
}

export function validateMuteUserArgs(args: unknown): MuteUserArgs {
  return MuteUserArgsSchema.parse(args);
}

export function validateUnmuteUserArgs(args: unknown): UnmuteUserArgs {
  return UnmuteUserArgsSchema.parse(args);
}

export function validateReportUserArgs(args: unknown): ReportUserArgs {
  return ReportUserArgsSchema.parse(args);
}

export function validateReportPostArgs(args: unknown): ReportPostArgs {
  return ReportPostArgsSchema.parse(args);
}

export function validateGetBlocksArgs(args: unknown): GetBlocksArgs {
  return GetBlocksArgsSchema.parse(args);
}

export function validateGetMutesArgs(args: unknown): GetMutesArgs {
  return GetMutesArgsSchema.parse(args);
}

export function validateCheckBlockStatusArgs(
  args: unknown
): CheckBlockStatusArgs {
  return CheckBlockStatusArgsSchema.parse(args);
}

export function validateCheckMuteStatusArgs(
  args: unknown
): CheckMuteStatusArgs {
  return CheckMuteStatusArgsSchema.parse(args);
}

// Validation Functions - Moderation Escrow
export function validateCreateEscrowPaymentArgs(
  args: unknown
): CreateEscrowPaymentArgs {
  return CreateEscrowPaymentArgsSchema.parse(args);
}

export function validateVerifyEscrowPaymentArgs(
  args: unknown
): VerifyEscrowPaymentArgs {
  return VerifyEscrowPaymentArgsSchema.parse(args);
}

export function validateRefundEscrowPaymentArgs(
  args: unknown
): RefundEscrowPaymentArgs {
  return RefundEscrowPaymentArgsSchema.parse(args);
}

export function validateListEscrowPaymentsArgs(
  args: unknown
): ListEscrowPaymentsArgs {
  return ListEscrowPaymentsArgsSchema.parse(args);
}

// Validation Functions - Ban Appeals
export function validateAppealBanArgs(args: unknown): AppealBanArgs {
  return AppealBanArgsSchema.parse(args);
}

export function validateAppealBanWithEscrowArgs(
  args: unknown
): AppealBanWithEscrowArgs {
  return AppealBanWithEscrowArgsSchema.parse(args);
}

// Validation Functions - Favorites
export function validateFavoriteProfileArgs(
  args: unknown
): FavoriteProfileArgs {
  return FavoriteProfileArgsSchema.parse(args);
}

export function validateUnfavoriteProfileArgs(
  args: unknown
): UnfavoriteProfileArgs {
  return UnfavoriteProfileArgsSchema.parse(args);
}

export function validateGetFavoritesArgs(args: unknown): GetFavoritesArgs {
  return GetFavoritesArgsSchema.parse(args);
}

export function validateGetFavoritePostsArgs(
  args: unknown
): GetFavoritePostsArgs {
  return GetFavoritePostsArgsSchema.parse(args);
}
