/**
 * MCP Tool Handlers
 *
 * Handlers for executing MCP tools. These handlers use direct service layer
 * calls instead of HTTP API endpoints for operations requiring authentication.
 * This bypasses the need for Privy JWT tokens since MCP API key authentication
 * provides the userId directly.
 *
 * PRODUCTION FEATURES:
 * - Rate limiting: All trading/transfer operations check rate limits
 * - Retry logic: Transient failures are retried with exponential backoff (idempotent ops only)
 * - Error logging: Failures are logged with context for debugging
 * - Metrics tracking: Operation success/failure counts are tracked
 * - Idempotency: Transfer operations support idempotency keys (Redis-backed, distributed)
 *
 * ARCHITECTURE NOTES:
 * - Direct service calls eliminate HTTP overhead for internal operations
 * - Authorization is enforced at the handler level before service calls
 * - Transactions use row-level locking to prevent race conditions
 * - Idempotency cache uses Redis for distributed protection across instances,
 *   with in-memory fallback when Redis is unavailable
 *
 * REFERRER FEES:
 * MCP tool responses report `referrerPaid: 0` because:
 * 1. MCP agents operate autonomously without a referral context
 * 2. Referrer attribution requires user session context not available in MCP
 * 3. The fee.amount reflects the total trading fee charged to the user
 * If referrer tracking is needed for MCP operations in the future, it would
 * require passing referrer context through the MCP API key or session.
 */

import type { JsonRpcParams, JsonRpcRequest } from '@feed/a2a';
import {
  handleAppealBanWithEscrow,
  handleCreateEscrowPayment,
  handleListEscrowPayments,
  handleRefundEscrowPayment,
  handleVerifyEscrowPayment,
} from '@feed/a2a';
import {
  checkRateLimitAsync,
  logAdminModify,
  RATE_LIMIT_CONFIGS,
  RateLimitError,
} from '@feed/api';
import { PerpDbAdapter, PerpMarketService } from '@feed/core/markets/perps';
import {
  PredictionDbAdapter,
  PredictionMarketService,
} from '@feed/core/markets/prediction';
import type { FeeProcessor, WalletPort } from '@feed/core/markets/shared';
import {
  and,
  db,
  eq,
  getBlockedByUserIds,
  getBlockedUserIds,
  getMutedUserIds,
  groupMembers,
  groups,
  hasBlocked,
  markets,
  perpMarketSnapshots,
  users,
} from '@feed/db';
import {
  createPerpPriceImpactPort,
  FEE_CONFIG,
  FeeService,
  invalidateAfterPredictionTrade,
  StaticDataRegistry,
  WalletService,
} from '@feed/engine';
import type { JsonValue, StringRecord } from '@feed/shared';
import {
  GROUP_CONFIG,
  generateSnowflakeId,
  getAPIBaseUrl,
  logger,
  retryIfRetryable,
} from '@feed/shared';

function buildWalletPort(): WalletPort {
  return {
    debit: ({ userId, amount, reason, description, relatedId }) =>
      WalletService.debit(userId, amount, reason, description ?? '', relatedId),
    credit: ({ userId, amount, reason, description, relatedId }) =>
      WalletService.credit(
        userId,
        amount,
        reason,
        description ?? '',
        relatedId
      ),
    recordPnL: ({ userId, pnl, reason, relatedId }) =>
      WalletService.recordPnL(userId, pnl, reason, relatedId).then(
        () => undefined
      ),
    getBalance: (userId: string) => WalletService.getBalance(userId),
  };
}

function buildFeeProcessor(): FeeProcessor {
  return {
    processTradingFee: ({ userId, amount, type, relatedId, positionId }) =>
      FeeService.processTradingFee(
        userId,
        type as (typeof FEE_CONFIG.FEE_TYPES)[keyof typeof FEE_CONFIG.FEE_TYPES],
        amount,
        positionId,
        relatedId
      ),
  };
}

/**
 * Safe fetch helper that validates response status and returns typed JSON.
 * Throws a descriptive error if the response is not OK.
 * Returns null for 204 No Content or empty body responses.
 */
async function safeFetch<T>(
  url: string | URL,
  options?: RequestInit
): Promise<T | null> {
  const response = await fetch(url.toString(), options);

  if (!response.ok) {
    const errorText = await response.text().catch(() => 'Unknown error');
    throw new Error(
      `API request failed: ${response.status} ${response.statusText} - ${errorText.slice(0, 200)}`
    );
  }

  // Handle 204 No Content early
  if (response.status === 204) {
    return null;
  }

  // Read body as text to handle empty responses reliably
  // (content-length header may not always be present, e.g. chunked transfer)
  const text = await response.text();
  const trimmed = text.trim();

  if (!trimmed) {
    return null;
  }

  return JSON.parse(trimmed) as T;
}

/**
 * Safe fetch helper that throws if the response is null/empty.
 * Use this for endpoints that must return JSON data.
 */
async function safeFetchRequired<T>(
  url: string | URL,
  options?: RequestInit
): Promise<T> {
  const result = await safeFetch<T>(url, options);
  if (result === null) {
    throw new Error('API returned empty response when data was expected');
  }
  return result;
}

// ============================================================================
// Production Operation Helpers
// ============================================================================

/**
 * Metrics counter for MCP operations.
 * Tracks success/failure counts for monitoring.
 */
const mcpMetrics = {
  operations: new Map<string, { success: number; failure: number }>(),

  record(operation: string, success: boolean): void {
    const stats = this.operations.get(operation) ?? { success: 0, failure: 0 };
    if (success) {
      stats.success++;
    } else {
      stats.failure++;
    }
    this.operations.set(operation, stats);
  },

  getStats(): Record<string, { success: number; failure: number }> {
    return Object.fromEntries(this.operations);
  },
};

/**
 * Options for executeWithRetry function.
 */
interface ExecuteWithRetryOptions {
  /** The agent ID for logging/metrics */
  agentId: string;
  /** The user ID for logging/metrics */
  userId: string;
  /**
   * Whether the operation is idempotent and safe to retry.
   * Only idempotent operations will be retried on transient failures.
   * @default false
   */
  isIdempotent?: boolean;
  /**
   * Optional idempotency key. If provided, implies the operation is idempotent.
   * Used for logging retry attempts.
   */
  idempotencyKey?: string;
}

/**
 * Execute a critical operation with optional retry, error logging, and metrics.
 * Only retries when the operation is explicitly marked as idempotent or has an idempotency key.
 * Non-idempotent operations (trades, transfers) are executed once to avoid duplicates.
 */
async function executeWithRetry<T>(
  operationName: string,
  operation: () => Promise<T>,
  options: ExecuteWithRetryOptions
): Promise<T> {
  const { agentId, userId, isIdempotent = false, idempotencyKey } = options;
  const startTime = Date.now();

  // Determine if we should retry: only if explicitly idempotent or has idempotency key
  const shouldRetry = isIdempotent || !!idempotencyKey;

  try {
    let result: T;

    if (shouldRetry) {
      // Safe to retry - use retry logic
      result = await retryIfRetryable(operation, {
        maxAttempts: 3,
        initialDelayMs: 100,
        maxDelayMs: 2000,
        onRetry: (attempt, error, delayMs) => {
          logger.warn(
            `${operationName} retry attempt ${attempt}`,
            {
              agentId,
              idempotencyKey,
              error: error.message,
              delayMs,
            },
            'MCP'
          );
        },
      });
    } else {
      // Not idempotent - execute once only to avoid duplicate side effects
      result = await operation();
    }

    mcpMetrics.record(operationName, true);
    logger.debug(
      `${operationName} completed`,
      {
        agentId,
        durationMs: Date.now() - startTime,
        retried: shouldRetry,
      },
      'MCP'
    );
    return result;
  } catch (error) {
    mcpMetrics.record(operationName, false);
    logger.error(
      `${operationName} failed`,
      {
        agentId,
        userId,
        idempotencyKey,
        error: error instanceof Error ? error.message : String(error),
        durationMs: Date.now() - startTime,
      },
      'MCP'
    );
    throw error;
  }
}

/**
 * Check rate limit for an MCP operation.
 * Throws RateLimitError if limit exceeded.
 */
async function checkMcpRateLimit(
  userId: string,
  operation:
    | 'buy_prediction'
    | 'sell_prediction'
    | 'open_position'
    | 'close_position'
    | 'transfer'
    | 'post'
): Promise<void> {
  const configMap: Record<
    string,
    (typeof RATE_LIMIT_CONFIGS)[keyof typeof RATE_LIMIT_CONFIGS]
  > = {
    buy_prediction: RATE_LIMIT_CONFIGS.BUY_PREDICTION,
    sell_prediction: RATE_LIMIT_CONFIGS.SELL_PREDICTION,
    open_position: RATE_LIMIT_CONFIGS.OPEN_POSITION,
    close_position: RATE_LIMIT_CONFIGS.CLOSE_POSITION,
    transfer: RATE_LIMIT_CONFIGS.DEFAULT, // Use default for transfers
    post: RATE_LIMIT_CONFIGS.CREATE_POST,
  };
  const config = configMap[operation];
  if (!config) return;

  const result = await checkRateLimitAsync(userId, config);
  if (!result.allowed) {
    throw new RateLimitError(
      `Rate limit exceeded for ${operation}. Try again in ${result.retryAfter} seconds.`,
      result.retryAfter
    );
  }
}

import type {
  AcceptGroupInviteArgs,
  AcceptGroupInviteResult,
  AppealBanArgs,
  AppealBanResult,
  AppealBanWithEscrowArgs,
  AppealBanWithEscrowResult,
  AuthenticatedAgent,
  BlockUserArgs,
  BlockUserResult,
  BuySharesArgs,
  BuySharesResult,
  CheckBlockStatusArgs,
  CheckBlockStatusResult,
  CheckMuteStatusArgs,
  CheckMuteStatusResult,
  ClosePositionArgs,
  ClosePositionResult,
  CreateCommentArgs,
  CreateCommentResult,
  CreateEscrowPaymentArgs,
  CreateEscrowPaymentResult,
  CreateGroupArgs,
  CreateGroupResult,
  CreatePostArgs,
  CreatePostResult,
  DeclineGroupInviteArgs,
  DeclineGroupInviteResult,
  DeleteCommentArgs,
  DeleteCommentResult,
  DeletePostArgs,
  DeletePostResult,
  FavoriteProfileArgs,
  FavoriteProfileResult,
  FollowUserArgs,
  FollowUserResult,
  GetBalanceResult,
  GetBlocksArgs,
  GetBlocksResult,
  GetChatMessagesArgs,
  GetChatMessagesResult,
  GetChatsArgs,
  GetChatsResult,
  GetCommentsArgs,
  GetCommentsResult,
  GetFavoritePostsArgs,
  GetFavoritePostsResult,
  GetFavoritesArgs,
  GetFavoritesResult,
  GetFollowersArgs,
  GetFollowersResult,
  GetFollowingArgs,
  GetFollowingResult,
  GetGroupInvitesArgs,
  GetGroupInvitesResult,
  GetLeaderboardArgs,
  GetLeaderboardResult,
  GetMarketDataArgs,
  GetMarketDataResult,
  GetMarketPricesArgs,
  GetMarketPricesResult,
  GetMarketsArgs,
  GetMarketsResult,
  GetMutesArgs,
  GetMutesResult,
  GetNotificationsArgs,
  GetNotificationsResult,
  GetOrganizationsArgs,
  GetOrganizationsResult,
  GetPerpetualsArgs,
  GetPerpetualsResult,
  GetPortfolioArgs,
  GetPortfolioResult,
  GetPositionsArgs,
  GetPositionsResult,
  GetPostArgs,
  GetPostResult,
  GetPostsByTagArgs,
  GetPostsByTagResult,
  GetReferralCodeArgs,
  GetReferralCodeResult,
  GetReferralStatsArgs,
  GetReferralStatsResult,
  GetReferralsArgs,
  GetReferralsResult,
  GetReputationArgs,
  GetReputationBreakdownArgs,
  GetReputationBreakdownResult,
  GetReputationResult,
  GetSystemStatsArgs,
  GetSystemStatsResult,
  GetTradeHistoryArgs,
  GetTradeHistoryResult,
  GetTradesArgs,
  GetTradesResult,
  GetTrendingTagsArgs,
  GetTrendingTagsResult,
  GetUnreadCountArgs,
  GetUnreadCountResult,
  GetUserProfileArgs,
  GetUserProfileResult,
  GetUserStatsArgs,
  GetUserStatsResult,
  GetUserWalletArgs,
  GetUserWalletResult,
  LeaveChatArgs,
  LeaveChatResult,
  LikeCommentArgs,
  LikeCommentResult,
  LikePostArgs,
  LikePostResult,
  ListEscrowPaymentsArgs,
  ListEscrowPaymentsResult,
  MarkNotificationsReadArgs,
  MarkNotificationsReadResult,
  MCPToolResult,
  MuteUserArgs,
  MuteUserResult,
  OpenPositionArgs,
  OpenPositionResult,
  PaymentReceiptArgs,
  PaymentReceiptResult,
  PaymentRequestArgs,
  PaymentRequestResult,
  PlaceBetArgs,
  PlaceBetResult,
  QueryFeedArgs,
  QueryFeedResult,
  RefundEscrowPaymentArgs,
  RefundEscrowPaymentResult,
  ReportPostArgs,
  ReportPostResult,
  ReportUserArgs,
  ReportUserResult,
  ResolveMarketArgs,
  ResolveMarketResult,
  SearchAgentsArgs,
  SearchAgentsResult,
  SearchUsersArgs,
  SearchUsersResult,
  SellSharesArgs,
  SellSharesResult,
  SendMessageArgs,
  SendMessageResult,
  SharePostArgs,
  SharePostResult,
  UnblockUserArgs,
  UnblockUserResult,
  UnfavoriteProfileArgs,
  UnfavoriteProfileResult,
  UnfollowUserArgs,
  UnfollowUserResult,
  UnlikePostArgs,
  UnlikePostResult,
  UnmuteUserArgs,
  UnmuteUserResult,
  UpdateProfileArgs,
  UpdateProfileResult,
  VerifyEscrowPaymentArgs,
  VerifyEscrowPaymentResult,
} from '../types/mcp';
import {
  validateAcceptGroupInviteArgs,
  validateAppealBanArgs,
  validateAppealBanWithEscrowArgs,
  validateBlockUserArgs,
  validateBuySharesArgs,
  validateCheckBlockStatusArgs,
  validateCheckMuteStatusArgs,
  validateClosePositionArgs,
  validateCreateCommentArgs,
  validateCreateEscrowPaymentArgs,
  validateCreateGroupArgs,
  validateCreatePostArgs,
  validateDeclineGroupInviteArgs,
  validateDeleteCommentArgs,
  validateDeletePostArgs,
  validateFavoriteProfileArgs,
  validateFollowUserArgs,
  validateGetBalanceArgs,
  validateGetBlocksArgs,
  validateGetChatMessagesArgs,
  validateGetChatsArgs,
  validateGetCommentsArgs,
  validateGetFavoritePostsArgs,
  validateGetFavoritesArgs,
  validateGetFollowersArgs,
  validateGetFollowingArgs,
  validateGetGroupInvitesArgs,
  validateGetLeaderboardArgs,
  validateGetMarketDataArgs,
  validateGetMarketPricesArgs,
  validateGetMarketsArgs,
  validateGetMutesArgs,
  validateGetNotificationsArgs,
  validateGetOrganizationsArgs,
  validateGetPerpetualsArgs,
  validateGetPortfolioArgs,
  validateGetPositionsArgs,
  validateGetPostArgs,
  validateGetPostsByTagArgs,
  validateGetReferralCodeArgs,
  validateGetReferralStatsArgs,
  validateGetReferralsArgs,
  validateGetReputationArgs,
  validateGetReputationBreakdownArgs,
  validateGetSystemStatsArgs,
  validateGetTradeHistoryArgs,
  validateGetTradesArgs,
  validateGetTrendingTagsArgs,
  validateGetUnreadCountArgs,
  validateGetUserProfileArgs,
  validateGetUserStatsArgs,
  validateGetUserWalletArgs,
  validateLeaveChatArgs,
  validateLikeCommentArgs,
  validateLikePostArgs,
  validateListEscrowPaymentsArgs,
  validateMarkNotificationsReadArgs,
  validateMuteUserArgs,
  validateOpenPositionArgs,
  validatePaymentReceiptArgs,
  validatePaymentRequestArgs,
  validatePlaceBetArgs,
  validateQueryFeedArgs,
  validateRefundEscrowPaymentArgs,
  validateReportPostArgs,
  validateReportUserArgs,
  validateResolveMarketArgs,
  validateSearchAgentsArgs,
  validateSearchUsersArgs,
  validateSellSharesArgs,
  validateSendMessageArgs,
  validateSharePostArgs,
  validateUnblockUserArgs,
  validateUnfavoriteProfileArgs,
  validateUnfollowUserArgs,
  validateUnlikePostArgs,
  validateUnmuteUserArgs,
  validateUpdateProfileArgs,
  validateVerifyEscrowPaymentArgs,
} from '../utils/tool-args-validation';

/**
 * Execute get_markets tool
 */
export async function executeGetMarkets(
  args: GetMarketsArgs,
  agent: AuthenticatedAgent
): Promise<GetMarketsResult> {
  logger.debug(
    `Agent ${agent.agentId} requesting markets (type: ${args.type || 'all'})`,
    undefined,
    'MCP'
  );

  const where: { resolved?: boolean } = {};
  if (args.type === 'prediction') {
    // Only prediction markets
  } else if (args.type === 'perpetuals') {
    // Only perpetuals (not implemented yet)
    return { markets: [] };
  }

  const markets = await db.market.findMany({
    where: {
      resolved: false,
      ...where,
    },
    orderBy: { createdAt: 'desc' },
    take: 50,
  });

  return {
    markets: markets.map((m) => ({
      id: m.id,
      question: m.question,
      yesShares: m.yesShares.toString(),
      noShares: m.noShares.toString(),
      liquidity: m.liquidity.toString(),
      endDate: m.endDate.toISOString(),
    })),
  };
}

/**
 * Build prediction market service for a given market
 */
function buildPredictionService(marketId: string) {
  return new PredictionMarketService({
    db: new PredictionDbAdapter(),
    wallet: buildWalletPort(),
    broadcast: {
      emit: async () => {
        // No-op for MCP - broadcasts handled separately
      },
    },
    cache: { invalidate: () => invalidateAfterPredictionTrade(marketId) },
    clock: { now: () => new Date() },
    fees: {
      tradingFeeRate: FEE_CONFIG.TRADING_FEE_RATE,
      platformShare: FEE_CONFIG.PLATFORM_SHARE,
      referrerShare: FEE_CONFIG.REFERRER_SHARE,
      minFeeAmount: FEE_CONFIG.MIN_FEE_AMOUNT,
    },
    feeProcessor: buildFeeProcessor(),
  });
}

/**
 * Type-safe mapping from lowercase prediction side to uppercase MCP API side
 */
const PREDICTION_SIDE_MAP: Record<'yes' | 'no', 'YES' | 'NO'> = {
  yes: 'YES',
  no: 'NO',
};

/**
 * Build perp market service
 */
function buildPerpService() {
  return new PerpMarketService({
    db: new PerpDbAdapter(),
    wallet: buildWalletPort(),
    priceImpact: createPerpPriceImpactPort(),
    fees: {
      tradingFeeRate: FEE_CONFIG.TRADING_FEE_RATE,
      platformShare: FEE_CONFIG.PLATFORM_SHARE,
      referrerShare: FEE_CONFIG.REFERRER_SHARE,
      minFeeAmount: FEE_CONFIG.MIN_FEE_AMOUNT,
    },
    feeProcessor: buildFeeProcessor(),
  });
}

/**
 * Validate and convert prediction side input to lowercase.
 * Provides defensive runtime validation instead of just type assertions.
 */
function validatePredictionSide(side: string): 'yes' | 'no' {
  const lower = side.toLowerCase();
  if (lower !== 'yes' && lower !== 'no') {
    throw new Error(
      `Invalid prediction side: ${side}. Expected 'YES' or 'NO'.`
    );
  }
  return lower;
}

/**
 * Validate and convert perp side input to lowercase.
 * Provides defensive runtime validation instead of just type assertions.
 */
function validatePerpSide(side: string): 'long' | 'short' {
  const lower = side.toLowerCase();
  if (lower !== 'long' && lower !== 'short') {
    throw new Error(`Invalid perp side: ${side}. Expected 'LONG' or 'SHORT'.`);
  }
  return lower;
}

/**
 * Type-safe mapping from lowercase perp side to uppercase MCP API side.
 * Used by resolvePerpSide for known good values.
 */
const PERP_SIDE_MAP: Record<'long' | 'short', 'LONG' | 'SHORT'> = {
  long: 'LONG',
  short: 'SHORT',
};

/**
 * Resolve perp side from service result to uppercase MCP API format.
 * Throws on unexpected values to surface service layer contract violations.
 */
function resolvePerpSide(side: string | undefined): 'LONG' | 'SHORT' {
  if (!side) {
    throw new Error(
      'Position side is undefined - service layer contract violation'
    );
  }
  const lower = side.toLowerCase() as 'long' | 'short';
  const mapped = PERP_SIDE_MAP[lower];
  if (mapped) return mapped;
  throw new Error(
    `Unexpected perp side value: '${side}'. Expected 'long' or 'short'.`
  );
}

/**
 * Calculate settlement amounts for a closed position.
 * Returns gross (before fees) and net (after fees) settlement values.
 */
function calculateSettlement(params: {
  marginPaid: number | undefined;
  realizedPnL: number | undefined;
  feePaid: number;
}): { grossSettlement: number; netSettlement: number } {
  const { marginPaid, realizedPnL, feePaid } = params;
  if (realizedPnL === undefined || marginPaid === undefined) {
    return { grossSettlement: 0, netSettlement: 0 };
  }
  const grossSettlement = marginPaid + realizedPnL;
  const netSettlement = Math.max(0, grossSettlement - feePaid);
  return { grossSettlement, netSettlement };
}

/**
 * Execute place_bet tool
 */
export async function executePlaceBet(
  agent: AuthenticatedAgent,
  args: PlaceBetArgs
): Promise<PlaceBetResult> {
  // Rate limit check
  await checkMcpRateLimit(agent.userId, 'buy_prediction');

  return executeWithRetry(
    'place_bet',
    async () => {
      // Validate and convert uppercase side to lowercase for service
      const side = validatePredictionSide(args.side);

      const service = buildPredictionService(args.marketId);
      const result = await service.buy({
        userId: agent.userId,
        marketId: args.marketId,
        side,
        amount: args.amount,
      });

      const balance = await WalletService.getBalance(agent.userId);

      return {
        position: {
          id: result.positionId,
          marketId: args.marketId,
          side: PREDICTION_SIDE_MAP[side],
          shares: result.shares,
          avgPrice: result.avgPrice,
          totalCost: result.totalCost ?? 0,
        },
        market: result.market,
        fee: {
          amount: result.feePaid,
          referrerPaid: 0,
        },
        newBalance: balance.balance,
      };
    },
    { agentId: agent.agentId, userId: agent.userId, isIdempotent: false }
  );
}

/**
 * Execute get_balance tool
 */
export async function executeGetBalance(
  agent: AuthenticatedAgent
): Promise<GetBalanceResult> {
  const [user] = await db
    .select({
      virtualBalance: users.virtualBalance,
      lifetimePnL: users.lifetimePnL,
    })
    .from(users)
    .where(eq(users.id, agent.userId))
    .limit(1);

  if (!user) {
    throw new Error('User not found');
  }

  return {
    balance: user.virtualBalance.toString(),
    lifetimePnL: user.lifetimePnL.toString(),
  };
}

/**
 * Execute get_positions tool
 */
export async function executeGetPositions(
  agent: AuthenticatedAgent,
  args: GetPositionsArgs
): Promise<GetPositionsResult> {
  const where: {
    userId: { equals: string };
    marketId?: { equals: string };
  } = {
    userId: { equals: agent.userId },
  };

  if (args.marketId) {
    where.marketId = { equals: args.marketId };
  }

  const positionsRaw = await db.position.findMany({
    where,
    take: args.limit,
    skip: args.offset,
  });

  // Get markets separately
  const marketIds = positionsRaw
    .map((p) => p.marketId)
    .filter((id): id is string => !!id);
  const markets =
    marketIds.length > 0
      ? await db.market.findMany({
          where: { id: { in: marketIds } },
          select: { id: true, question: true },
        })
      : [];

  const marketsMap = new Map(markets.map((m) => [m.id, m]));

  return {
    positions: positionsRaw.map((p) => ({
      id: p.id,
      marketId: p.marketId,
      question: marketsMap.get(p.marketId)?.question ?? null,
      side: p.side ? 'YES' : 'NO',
      shares: p.shares.toString(),
      avgPrice: p.avgPrice.toString(),
    })),
  };
}

/**
 * Execute close_position tool
 */
export async function executeClosePosition(
  agent: AuthenticatedAgent,
  args: ClosePositionArgs
): Promise<ClosePositionResult> {
  await checkMcpRateLimit(agent.userId, 'close_position');

  return executeWithRetry(
    'close_position',
    async () => {
      const service = buildPerpService();
      const result = await service.closePosition({
        userId: agent.userId,
        positionId: args.positionId,
      });

      const { grossSettlement, netSettlement } = calculateSettlement({
        marginPaid: result.marginPaid,
        realizedPnL: result.realizedPnL,
        feePaid: result.feePaid,
      });

      return {
        position: {
          positionId: args.positionId,
          ticker: result.ticker,
          side: resolvePerpSide(result.side),
          size: result.size,
          entryPrice: result.entryPrice ?? 0,
          exitPrice: result.exitPrice ?? 0,
        },
        grossSettlement,
        netSettlement,
        marginReturned: result.marginPaid ?? 0,
        pnl: result.realizedPnL ?? 0,
        fee: {
          amount: result.feePaid,
          referrerPaid: 0,
        },
        wasLiquidated: false,
        newBalance: result.balance ?? 0,
      };
    },
    { agentId: agent.agentId, userId: agent.userId, isIdempotent: false }
  );
}

/**
 * Execute get_market_data tool
 */
export async function executeGetMarketData(
  agent: AuthenticatedAgent,
  args: GetMarketDataArgs
): Promise<GetMarketDataResult> {
  logger.debug(
    `Agent ${agent.agentId} requesting market data for ${args.marketId}`,
    undefined,
    'MCP'
  );

  const market = await db.market.findUnique({
    where: { id: args.marketId },
  });

  if (!market) {
    throw new Error('Market not found');
  }

  return {
    id: market.id,
    question: market.question,
    description: market.description,
    yesShares: market.yesShares.toString(),
    noShares: market.noShares.toString(),
    liquidity: market.liquidity.toString(),
    resolved: market.resolved,
    resolution: market.resolution,
    endDate: market.endDate.toISOString(),
  };
}

/**
 * Execute query_feed tool
 */
export async function executeQueryFeed(
  agent: AuthenticatedAgent,
  args: QueryFeedArgs
): Promise<QueryFeedResult> {
  logger.debug(`Agent ${agent.agentId} querying feed`, args, 'MCP');

  const now = new Date();
  const posts = await db.post.findMany({
    where: args.questionId
      ? {
          // Filter by question if provided
          // Note: questionId might need to be mapped from market/question
          deletedAt: null, // Filter out deleted posts
          timestamp: { lte: now }, // ✅ No future posts
        }
      : {
          deletedAt: null, // Filter out deleted posts
          timestamp: { lte: now }, // ✅ No future posts
        },
    orderBy: { timestamp: 'desc' },
    take: args.limit || 20,
  });

  return {
    posts: posts.map((p) => ({
      id: p.id,
      content: p.content,
      authorId: p.authorId,
      timestamp: p.timestamp.toISOString(),
    })),
  };
}

// ============================================================================
// Market Operations - Additional Handlers
// ============================================================================

/**
 * Execute buy_shares tool
 */
export async function executeBuyShares(
  agent: AuthenticatedAgent,
  args: BuySharesArgs
): Promise<BuySharesResult> {
  await checkMcpRateLimit(agent.userId, 'buy_prediction');

  return executeWithRetry(
    'buy_shares',
    async () => {
      const side = validatePredictionSide(args.outcome);

      const service = buildPredictionService(args.marketId);
      const result = await service.buy({
        userId: agent.userId,
        marketId: args.marketId,
        side,
        amount: args.amount,
      });

      const balance = await WalletService.getBalance(agent.userId);

      return {
        position: {
          id: result.positionId,
          marketId: args.marketId,
          side: PREDICTION_SIDE_MAP[side],
          shares: result.shares,
          avgPrice: result.avgPrice,
          totalCost: result.totalCost ?? 0,
        },
        market: result.market,
        fee: {
          amount: result.feePaid,
          referrerPaid: 0,
        },
        newBalance: balance.balance,
      };
    },
    { agentId: agent.agentId, userId: agent.userId, isIdempotent: false }
  );
}

/**
 * Execute sell_shares tool
 */
export async function executeSellShares(
  agent: AuthenticatedAgent,
  args: SellSharesArgs
): Promise<SellSharesResult> {
  await checkMcpRateLimit(agent.userId, 'sell_prediction');

  return executeWithRetry(
    'sell_shares',
    async () => {
      const position = await db.position.findUnique({
        where: { id: args.positionId },
      });
      if (!position || position.userId !== agent.userId) {
        throw new Error('Position not found or access denied');
      }
      if (!position.marketId) {
        throw new Error('Position has no associated market');
      }

      const service = buildPredictionService(position.marketId);
      const result = await service.sell({
        userId: agent.userId,
        marketId: position.marketId,
        shares: args.shares,
        positionId: args.positionId,
      });

      const balance = await WalletService.getBalance(agent.userId);

      return {
        sharesSold: args.shares,
        grossProceeds: result.totalProceeds ?? result.netProceeds ?? 0,
        netProceeds: result.netProceeds ?? 0,
        pnl: result.pnl ?? 0,
        market: result.market,
        fee: {
          amount: result.feePaid,
          referrerPaid: 0,
        },
        remainingShares: result.remainingShares ?? 0,
        positionClosed: result.positionClosed ?? false,
        newBalance: balance.balance,
        positionId: result.positionId,
      };
    },
    { agentId: agent.agentId, userId: agent.userId, isIdempotent: false }
  );
}

/**
 * Execute open_position tool
 */
export async function executeOpenPosition(
  agent: AuthenticatedAgent,
  args: OpenPositionArgs
): Promise<OpenPositionResult> {
  await checkMcpRateLimit(agent.userId, 'open_position');

  return executeWithRetry(
    'open_position',
    async () => {
      // Convert side to lowercase for service layer
      const side = validatePerpSide(args.side);

      const service = buildPerpService();
      const result = await service.openPosition({
        userId: agent.userId,
        ticker: args.ticker,
        side,
        size: args.amount,
        leverage: args.leverage,
      });

      return {
        position: {
          positionId: result.positionId,
          ticker: result.ticker,
          side: resolvePerpSide(result.side),
          size: result.size,
          leverage: result.leverage,
          entryPrice: result.entryPrice ?? 0,
        },
        marginPaid: result.marginPaid ?? 0,
        fee: {
          amount: result.feePaid,
          referrerPaid: 0,
        },
        newBalance: result.balance ?? 0,
      };
    },
    { agentId: agent.agentId, userId: agent.userId, isIdempotent: false }
  );
}

/**
 * Execute get_market_prices tool
 */
export async function executeGetMarketPrices(
  _agent: AuthenticatedAgent,
  args: GetMarketPricesArgs
): Promise<GetMarketPricesResult> {
  const market = await db.market.findUnique({
    where: { id: args.marketId },
  });
  if (!market) {
    throw new Error('Market not found');
  }
  const totalShares = Number(market.yesShares) + Number(market.noShares);
  const yesPrice =
    totalShares > 0 ? Number(market.yesShares) / totalShares : 0.5;
  const noPrice = totalShares > 0 ? Number(market.noShares) / totalShares : 0.5;
  return {
    marketId: market.id,
    yesPrice,
    noPrice,
    timestamp: new Date().toISOString(),
  };
}

/**
 * Execute get_perpetuals tool
 *
 * Returns all available perpetual markets with current prices and 24h metrics.
 */
export async function executeGetPerpetuals(
  _agent: AuthenticatedAgent,
  _args: GetPerpetualsArgs
): Promise<GetPerpetualsResult> {
  const snapshots = await db.select().from(perpMarketSnapshots);

  return {
    markets: snapshots.map((snapshot) => ({
      ticker: snapshot.ticker,
      currentPrice: snapshot.currentPrice,
      priceChange24h: snapshot.changePercent24h,
      volume24h: snapshot.volume24h,
    })),
  };
}

/**
 * Execute get_trades tool
 */
export async function executeGetTrades(
  _agent: AuthenticatedAgent,
  args: GetTradesArgs
): Promise<GetTradesResult> {
  const apiBaseUrl = getAPIBaseUrl();
  const url = new URL(`${apiBaseUrl}/trades`);
  if (args.marketId) url.searchParams.set('marketId', args.marketId);
  if (args.limit) url.searchParams.set('limit', args.limit.toString());
  const data = await safeFetch<{
    trades: Array<{
      id: string;
      marketId: string;
      userId: string;
      side: boolean;
      shares: string;
      price: string;
      timestamp: Date | string;
    }>;
  }>(url);

  // Handle null/empty response
  if (!data) {
    return { trades: [] };
  }

  return {
    trades: data.trades.map((trade) => ({
      id: trade.id,
      marketId: trade.marketId,
      userId: trade.userId,
      side: trade.side ? 'YES' : 'NO',
      shares: trade.shares,
      price: trade.price,
      timestamp:
        trade.timestamp instanceof Date
          ? trade.timestamp.toISOString()
          : trade.timestamp,
    })),
  };
}

/**
 * Execute get_trade_history tool
 *
 * NOTE: This returns the user's current positions rather than individual trade
 * transactions. Each position represents an aggregated holding with the side
 * (YES/NO), total shares, and average entry price. This is a semantic
 * difference from a true "trade history" which would show each individual
 * buy/sell transaction.
 *
 * This approach was chosen because:
 * 1. Positions contain accurate side information (YES/NO boolean)
 * 2. Balance transactions don't store the actual side of the trade
 * 3. This provides useful trading context for MCP agents
 *
 * Security: Only allows fetching the authenticated user's own trade history.
 */
export async function executeGetTradeHistory(
  agent: AuthenticatedAgent,
  args: GetTradeHistoryArgs
): Promise<GetTradeHistoryResult> {
  // Enforce self-only access: users can only fetch their own trade history
  if (args.userId && args.userId !== agent.userId) {
    throw new Error('Unauthorized: You can only access your own trade history');
  }

  // Use the authenticated agent's userId for the query
  const userId = agent.userId;

  logger.info(`Getting trade history for user: ${userId}`, {}, 'MCP');

  // Query positions which contain the actual side (YES/NO), shares, and price
  const positions = await db.position.findMany({
    where: {
      userId,
    },
    orderBy: { updatedAt: 'desc' },
    take: args.limit || 20,
    select: {
      id: true,
      marketId: true,
      side: true, // boolean: true = YES, false = NO
      shares: true,
      avgPrice: true,
      createdAt: true,
      updatedAt: true,
    },
  });

  return {
    trades: positions.map((pos) => ({
      id: pos.id,
      marketId: pos.marketId,
      side: (pos.side ? 'YES' : 'NO') as 'YES' | 'NO',
      shares: pos.shares.toString(),
      price: pos.avgPrice.toString(),
      timestamp: pos.updatedAt.toISOString(),
    })),
  };
}

// ============================================================================
// Social Features - Handlers
// ============================================================================

/**
 * Execute get_post tool
 */
export async function executeGetPost(
  _agent: AuthenticatedAgent,
  args: GetPostArgs
): Promise<GetPostResult> {
  const apiBaseUrl = getAPIBaseUrl();
  return safeFetchRequired<GetPostResult>(
    new URL(`${apiBaseUrl}/posts/${args.postId}`)
  );
}

/**
 * Execute create_post tool
 */
export async function executeCreatePost(
  agent: AuthenticatedAgent,
  args: CreatePostArgs
): Promise<CreatePostResult> {
  await checkMcpRateLimit(agent.userId, 'post');

  const postId = await generateSnowflakeId();
  const mediaUrl = args.mediaUrl ?? null;
  const post = await db.post.create({
    data: {
      id: postId,
      content: args.content.trim(),
      authorId: agent.userId,
      type: args.type || 'post',
      imageUrl: mediaUrl,
      timestamp: new Date(),
    },
  });
  return {
    success: true,
    postId: post.id,
    content: post.content,
    mediaUrl,
  };
}

/**
 * Execute delete_post tool
 */
export async function executeDeletePost(
  agent: AuthenticatedAgent,
  args: DeletePostArgs
): Promise<DeletePostResult> {
  const post = await db.post.findUnique({ where: { id: args.postId } });
  if (!post) {
    throw new Error('Post not found');
  }
  if (post.authorId !== agent.userId) {
    throw new Error('Unauthorized: You can only delete your own posts');
  }
  await db.post.update({
    where: { id: args.postId },
    data: { deletedAt: new Date() },
  });
  return { success: true };
}

/**
 * Execute like_post tool
 */
export async function executeLikePost(
  agent: AuthenticatedAgent,
  args: LikePostArgs
): Promise<LikePostResult> {
  const existing = await db.reaction.findFirst({
    where: {
      postId: args.postId,
      userId: agent.userId,
      type: 'like',
    },
  });
  if (existing) {
    return { success: true, liked: true };
  }
  await db.reaction.create({
    data: {
      id: await generateSnowflakeId(),
      postId: args.postId,
      userId: agent.userId,
      type: 'like',
    },
  });
  return { success: true, liked: true };
}

/**
 * Execute unlike_post tool
 */
export async function executeUnlikePost(
  agent: AuthenticatedAgent,
  args: UnlikePostArgs
): Promise<UnlikePostResult> {
  // agent used implicitly for userId in deleteMany where clause
  await db.reaction.deleteMany({
    where: {
      postId: args.postId,
      userId: agent.userId,
      type: 'like',
    },
  });
  return { success: true };
}

/**
 * Execute share_post tool
 */
export async function executeSharePost(
  agent: AuthenticatedAgent,
  args: SharePostArgs
): Promise<SharePostResult> {
  const shareId = await generateSnowflakeId();
  await db.share.create({
    data: {
      id: shareId,
      userId: agent.userId,
      postId: args.postId,
    },
  });
  return { success: true, shareId };
}

/**
 * Execute get_comments tool
 */
export async function executeGetComments(
  _agent: AuthenticatedAgent,
  args: GetCommentsArgs
): Promise<GetCommentsResult> {
  const commentsList = await db.comment.findMany({
    where: {
      postId: args.postId,
      deletedAt: null,
    },
    orderBy: { createdAt: 'desc' },
    take: args.limit || 50,
  });
  const commentIds = commentsList.map((c) => c.id);
  const reactionsList = await db.reaction.findMany({
    where: {
      commentId: { in: commentIds },
      type: 'like',
    },
  });
  const likesMap = new Map<string, number>();
  for (const reaction of reactionsList) {
    if (reaction.commentId) {
      likesMap.set(
        reaction.commentId,
        (likesMap.get(reaction.commentId) || 0) + 1
      );
    }
  }
  return {
    comments: commentsList.map((c) => ({
      id: c.id,
      postId: c.postId,
      authorId: c.authorId,
      content: c.content,
      timestamp: c.createdAt.toISOString(),
      likes: likesMap.get(c.id) || 0,
    })),
  };
}

/**
 * Execute create_comment tool
 */
export async function executeCreateComment(
  agent: AuthenticatedAgent,
  args: CreateCommentArgs
): Promise<CreateCommentResult> {
  const commentId = await generateSnowflakeId();
  const comment = await db.comment.create({
    data: {
      id: commentId,
      postId: args.postId,
      authorId: agent.userId,
      content: args.content,
      updatedAt: new Date(),
    },
  });
  return {
    success: true,
    commentId: comment.id,
    content: comment.content,
  };
}

/**
 * Execute delete_comment tool
 */
export async function executeDeleteComment(
  agent: AuthenticatedAgent,
  args: DeleteCommentArgs
): Promise<DeleteCommentResult> {
  const comment = await db.comment.findUnique({
    where: { id: args.commentId },
  });
  if (!comment) {
    throw new Error('Comment not found');
  }
  if (comment.authorId !== agent.userId) {
    throw new Error('Unauthorized: You can only delete your own comments');
  }
  await db.comment.update({
    where: { id: args.commentId },
    data: { deletedAt: new Date() },
  });
  return { success: true };
}

/**
 * Execute like_comment tool
 */
export async function executeLikeComment(
  agent: AuthenticatedAgent,
  args: LikeCommentArgs
): Promise<LikeCommentResult> {
  const existing = await db.reaction.findFirst({
    where: {
      commentId: args.commentId,
      userId: agent.userId,
      type: 'like',
    },
  });
  if (!existing) {
    await db.reaction.create({
      data: {
        id: await generateSnowflakeId(),
        commentId: args.commentId,
        userId: agent.userId,
        type: 'like',
      },
    });
  }
  return { success: true };
}

/**
 * Execute get_posts_by_tag tool
 */
export async function executeGetPostsByTag(
  _agent: AuthenticatedAgent,
  args: GetPostsByTagArgs
): Promise<GetPostsByTagResult> {
  const tag = await db.tag.findFirst({
    where: { name: args.tag },
  });
  if (!tag) {
    return { posts: [] };
  }
  const postTagsList = await db.postTag.findMany({
    where: { tagId: tag.id },
    take: args.limit || 20,
    skip: args.offset || 0,
    orderBy: { createdAt: 'desc' },
  });
  const postIds = postTagsList.map((pt) => pt.postId);
  const postsList = await db.post.findMany({
    where: {
      id: { in: postIds },
      deletedAt: null,
    },
    orderBy: { timestamp: 'desc' },
  });
  return {
    posts: postsList.map((p) => ({
      id: p.id,
      content: p.content,
      authorId: p.authorId,
      timestamp: p.timestamp.toISOString(),
    })),
  };
}

// ============================================================================
// User Management - Handlers
// ============================================================================

/**
 * Execute get_user_profile tool
 */
export async function executeGetUserProfile(
  _agent: AuthenticatedAgent,
  args: GetUserProfileArgs
): Promise<GetUserProfileResult> {
  const user = await db.user.findUnique({
    where: { id: args.userId },
    select: {
      id: true,
      username: true,
      displayName: true,
      bio: true,
      profileImageUrl: true,
      reputationPoints: true,
      virtualBalance: true,
    },
  });
  if (!user) {
    throw new Error('User not found');
  }
  return {
    id: user.id,
    username: user.username,
    displayName: user.displayName,
    bio: user.bio,
    profileImageUrl: user.profileImageUrl,
    reputationPoints: Number(user.reputationPoints || 0),
    virtualBalance: user.virtualBalance.toString(),
  };
}

/**
 * Execute update_profile tool
 */
export async function executeUpdateProfile(
  agent: AuthenticatedAgent,
  args: UpdateProfileArgs
): Promise<UpdateProfileResult> {
  const updateData: {
    displayName?: string;
    bio?: string;
    username?: string;
    profileImageUrl?: string;
  } = {};
  if (args.displayName !== undefined) updateData.displayName = args.displayName;
  if (args.bio !== undefined) updateData.bio = args.bio;
  if (args.username !== undefined) updateData.username = args.username;
  if (args.profileImageUrl !== undefined)
    updateData.profileImageUrl = args.profileImageUrl;
  const user = await db.user.update({
    where: { id: agent.userId },
    data: updateData,
    select: {
      id: true,
      username: true,
      displayName: true,
      bio: true,
      profileImageUrl: true,
      reputationPoints: true,
      virtualBalance: true,
    },
  });
  return {
    success: true,
    profile: {
      id: user.id,
      username: user.username,
      displayName: user.displayName,
      bio: user.bio,
      profileImageUrl: user.profileImageUrl,
      reputationPoints: Number(user.reputationPoints || 0),
      virtualBalance: user.virtualBalance.toString(),
    },
  };
}

/**
 * Execute follow_user tool
 */
export async function executeFollowUser(
  agent: AuthenticatedAgent,
  args: FollowUserArgs
): Promise<FollowUserResult> {
  if (args.userId === agent.userId) {
    throw new Error('Cannot follow yourself');
  }
  const existing = await db.follow.findFirst({
    where: {
      followerId: agent.userId,
      followingId: args.userId,
    },
  });
  if (existing) {
    return { success: true };
  }
  await db.follow.create({
    data: {
      id: await generateSnowflakeId(),
      followerId: agent.userId,
      followingId: args.userId,
    },
  });
  return { success: true };
}

/**
 * Execute unfollow_user tool
 */
export async function executeUnfollowUser(
  agent: AuthenticatedAgent,
  args: UnfollowUserArgs
): Promise<UnfollowUserResult> {
  await db.follow.deleteMany({
    where: {
      followerId: agent.userId,
      followingId: args.userId,
    },
  });
  return { success: true };
}

/**
 * Execute get_followers tool
 */
export async function executeGetFollowers(
  _agent: AuthenticatedAgent,
  args: GetFollowersArgs
): Promise<GetFollowersResult> {
  const followersList = await db.follow.findMany({
    where: { followingId: args.userId },
    take: args.limit || 50,
    orderBy: { createdAt: 'desc' },
  });
  const followerIds = followersList.map((f) => f.followerId);
  const usersList = await db.user.findMany({
    where: { id: { in: followerIds } },
    select: {
      id: true,
      username: true,
      displayName: true,
      profileImageUrl: true,
    },
  });
  const usersMap = new Map(usersList.map((u) => [u.id, u]));
  return {
    followers: followersList.map((f) => {
      const user = usersMap.get(f.followerId);
      return {
        id: f.followerId,
        username: user?.username || null,
        displayName: user?.displayName || null,
        profileImageUrl: user?.profileImageUrl || null,
      };
    }),
  };
}

/**
 * Execute get_following tool
 */
export async function executeGetFollowing(
  _agent: AuthenticatedAgent,
  args: GetFollowingArgs
): Promise<GetFollowingResult> {
  const followingList = await db.follow.findMany({
    where: { followerId: args.userId },
    take: args.limit || 50,
    orderBy: { createdAt: 'desc' },
  });
  const followingIds = followingList.map((f) => f.followingId);
  const usersList = await db.user.findMany({
    where: { id: { in: followingIds } },
    select: {
      id: true,
      username: true,
      displayName: true,
      profileImageUrl: true,
    },
  });
  const usersMap = new Map(usersList.map((u) => [u.id, u]));
  return {
    following: followingList.map((f) => {
      const user = usersMap.get(f.followingId);
      return {
        id: f.followingId,
        username: user?.username || null,
        displayName: user?.displayName || null,
        profileImageUrl: user?.profileImageUrl || null,
      };
    }),
  };
}

/**
 * Execute search_users tool
 */
export async function executeSearchUsers(
  _agent: AuthenticatedAgent,
  args: SearchUsersArgs
): Promise<SearchUsersResult> {
  const usersList = await db.user.findMany({
    where: {
      OR: [
        { username: { contains: args.query, mode: 'insensitive' } },
        { displayName: { contains: args.query, mode: 'insensitive' } },
      ],
    },
    take: args.limit || 20,
    select: {
      id: true,
      username: true,
      displayName: true,
      reputationPoints: true,
    },
  });
  return {
    users: usersList.map((u) => ({
      id: u.id,
      username: u.username,
      displayName: u.displayName,
      reputationPoints: Number(u.reputationPoints || 0),
    })),
  };
}

/**
 * Execute search_agents tool
 */
export async function executeSearchAgents(
  agent: AuthenticatedAgent,
  args: SearchAgentsArgs
): Promise<SearchAgentsResult> {
  const [blockedIds, mutedIds, blockedByIds] = await Promise.all([
    getBlockedUserIds(agent.userId),
    getMutedUserIds(agent.userId),
    getBlockedByUserIds(agent.userId),
  ]);

  const excludedUserIds = [...blockedIds, ...mutedIds, ...blockedByIds];

  const agentsList = await db.user.findMany({
    where: {
      AND: [
        {
          OR: [
            { username: { contains: args.query, mode: 'insensitive' } },
            { displayName: { contains: args.query, mode: 'insensitive' } },
          ],
        },
        { id: { not: agent.userId } },
        ...(excludedUserIds.length > 0
          ? [{ id: { notIn: excludedUserIds } }]
          : []),
        { OR: [{ isAgent: true }, { isActor: true }] },
        { isBanned: false },
      ],
    },
    select: {
      id: true,
      displayName: true,
      username: true,
      profileImageUrl: true,
      bio: true,
      isActor: true,
    },
    take: args.limit || 20,
    orderBy: [{ username: 'asc' }],
  });

  return {
    agents: agentsList.map((entry) => ({
      id: entry.id,
      username: entry.username,
      displayName: entry.displayName,
      profileImageUrl: entry.profileImageUrl,
      bio: entry.bio,
      type: entry.isActor ? 'npc' : 'agent',
    })),
  };
}

/**
 * Execute get_user_wallet tool
 */
export async function executeGetUserWallet(
  _agent: AuthenticatedAgent,
  args: GetUserWalletArgs
): Promise<GetUserWalletResult> {
  const user = await db.user.findUnique({
    where: { id: args.userId },
    select: {
      walletAddress: true,
      virtualBalance: true,
      totalDeposited: true,
      totalWithdrawn: true,
    },
  });
  if (!user) {
    throw new Error('User not found');
  }
  return {
    walletAddress: user.walletAddress,
    virtualBalance: user.virtualBalance.toString(),
    totalDeposited: user.totalDeposited.toString(),
    totalWithdrawn: user.totalWithdrawn.toString(),
  };
}

/**
 * Execute get_user_stats tool
 */
export async function executeGetUserStats(
  _agent: AuthenticatedAgent,
  args: GetUserStatsArgs
): Promise<GetUserStatsResult> {
  const [user, postsCount, commentsCount, reactionsCount] = await Promise.all([
    db.user.findUnique({
      where: { id: args.userId },
      select: {
        reputationPoints: true,
        virtualBalance: true,
        lifetimePnL: true,
      },
    }),
    db.post.count({
      where: { authorId: args.userId, deletedAt: null },
    }),
    db.comment.count({
      where: { authorId: args.userId, deletedAt: null },
    }),
    db.reaction.count({
      where: { userId: args.userId, type: 'like' },
    }),
  ]);
  if (!user) {
    throw new Error('User not found');
  }
  return {
    totalPosts: postsCount,
    totalComments: commentsCount,
    totalLikes: reactionsCount,
    reputationPoints: Number(user.reputationPoints || 0),
    virtualBalance: user.virtualBalance.toString(),
    lifetimePnL: user.lifetimePnL.toString(),
  };
}

// ============================================================================
// Chats & Messaging - Handlers
// ============================================================================

/**
 * Execute get_chats tool
 */
export async function executeGetChats(
  agent: AuthenticatedAgent,
  _args: GetChatsArgs
): Promise<GetChatsResult> {
  // Get all chats where user is a participant
  const participants = await db.chatParticipant.findMany({
    where: {
      userId: agent.userId,
      isActive: true,
    },
    select: { chatId: true },
  });
  const participantChatIds = participants.map((p) => p.chatId);
  const chatsList =
    participantChatIds.length > 0
      ? await db.chat.findMany({
          where: { id: { in: participantChatIds } },
        })
      : [];
  const chatIds = chatsList.map((c) => c.id);
  const lastMessages = await Promise.all(
    chatIds.map(async (chatId) => {
      const lastMessage = await db.message.findFirst({
        where: { chatId },
        orderBy: { createdAt: 'desc' },
      });
      return { chatId, lastMessage };
    })
  );
  // For now, return 0 unread count (read tracking not implemented in schema)
  const unreadCounts = chatIds.map((chatId) => ({ chatId, count: 0 }));
  const unreadMap = new Map(unreadCounts.map((u) => [u.chatId, u.count]));
  const lastMessageMap = new Map(
    lastMessages.map((lm) => [lm.chatId, lm.lastMessage])
  );
  return {
    chats: chatsList.map((c) => ({
      id: c.id,
      name: c.name,
      type: c.isGroup ? ('group' as const) : ('dm' as const),
      lastMessageAt: lastMessageMap.get(c.id)?.createdAt.toISOString() || null,
      unreadCount: unreadMap.get(c.id) || 0,
    })),
  };
}

/**
 * Execute get_chat_messages tool
 */
export async function executeGetChatMessages(
  agent: AuthenticatedAgent,
  args: GetChatMessagesArgs
): Promise<GetChatMessagesResult> {
  const chat = await db.chat.findUnique({
    where: { id: args.chatId },
    select: { id: true },
  });

  if (!chat) {
    throw new Error('Chat not found');
  }

  const membership = await db.chatParticipant.findFirst({
    where: {
      chatId: args.chatId,
      userId: agent.userId,
      isActive: true,
    },
    select: { id: true },
  });

  if (!membership) {
    throw new Error('Unauthorized: You do not have access to this chat');
  }

  const messagesList = await db.message.findMany({
    where: { chatId: args.chatId },
    orderBy: { createdAt: 'desc' },
    take: args.limit || 50,
    skip: args.offset || 0,
  });
  return {
    messages: messagesList.map((m) => ({
      id: m.id,
      chatId: m.chatId,
      authorId: m.senderId,
      content: m.content,
      timestamp: m.createdAt.toISOString(),
    })),
  };
}

/**
 * Execute send_message tool
 */
export async function executeSendMessage(
  agent: AuthenticatedAgent,
  args: SendMessageArgs
): Promise<SendMessageResult> {
  const chat = await db.chat.findUnique({
    where: { id: args.chatId },
    select: { id: true, isGroup: true },
  });

  if (!chat) {
    throw new Error('Chat not found');
  }

  const participants = await db.chatParticipant.findMany({
    where: {
      chatId: args.chatId,
      isActive: true,
    },
    select: { userId: true },
  });

  const isParticipant = participants.some((p) => p.userId === agent.userId);
  if (!isParticipant) {
    throw new Error('Unauthorized: You do not have access to this chat');
  }

  if (!chat.isGroup) {
    const otherParticipantId = participants
      .map((participant) => participant.userId)
      .find((userId) => userId !== agent.userId);

    if (!otherParticipantId) {
      throw new Error('Invalid direct message chat');
    }

    const [otherUser, isBlocked, hasBlockedMe] = await Promise.all([
      db.user.findUnique({
        where: { id: otherParticipantId },
        select: { isActor: true },
      }),
      hasBlocked(agent.userId, otherParticipantId),
      hasBlocked(otherParticipantId, agent.userId),
    ]);

    if (otherUser?.isActor) {
      throw new Error(
        'Cannot send direct messages to NPC actors. Use group chats instead.'
      );
    }

    if (isBlocked || hasBlockedMe) {
      throw new Error('Cannot send messages to this user');
    }
  }

  const messageId = await generateSnowflakeId();
  const message = await db.message.create({
    data: {
      id: messageId,
      chatId: args.chatId,
      senderId: agent.userId,
      content: args.content,
    },
  });
  return {
    success: true,
    messageId: message.id,
  };
}

/**
 * Execute create_group tool
 * Chat.groupId → Group.id relationship
 */
export async function executeCreateGroup(
  agent: AuthenticatedAgent,
  args: CreateGroupArgs
): Promise<CreateGroupResult> {
  const chatId = await generateSnowflakeId();
  const groupId = await generateSnowflakeId();

  // Deduplicate memberIds and exclude the owner (agent.userId)
  const uniqueMemberIds = [...new Set(args.memberIds)].filter(
    (id) => id !== agent.userId
  );

  // Create Group
  await db.group.create({
    data: {
      id: groupId,
      name: args.name,
      description: args.description,
      type: 'agent', // Agent-created group
      ownerId: agent.userId,
      createdById: agent.userId,
      updatedAt: new Date(),
    },
  });

  // Create chat with groupId link (Chat.groupId → Group.id)
  const chat = await db.chat.create({
    data: {
      id: chatId,
      name: args.name,
      description: args.description,
      isGroup: true,
      groupId, // Link Chat → Group
      createdBy: agent.userId,
      updatedAt: new Date(),
    },
  });

  // Create chat participants
  const participantIds = await Promise.all([
    generateSnowflakeId(),
    ...uniqueMemberIds.map(() => generateSnowflakeId()),
  ]);
  await db.chatParticipant.createMany({
    data: [
      { id: participantIds[0]!, chatId, userId: agent.userId },
      ...uniqueMemberIds.map((memberId, idx) => ({
        id: participantIds[idx + 1]!,
        chatId,
        userId: memberId,
      })),
    ],
  });

  // Create GroupMember records
  const memberRecordIds = await Promise.all([
    generateSnowflakeId(),
    ...uniqueMemberIds.map(() => generateSnowflakeId()),
  ]);
  await db.groupMember.createMany({
    data: [
      {
        id: memberRecordIds[0]!,
        groupId,
        userId: agent.userId,
        role: 'owner',
        addedBy: agent.userId,
      },
      ...uniqueMemberIds.map((memberId, idx) => ({
        id: memberRecordIds[idx + 1]!,
        groupId,
        userId: memberId,
        role: 'member' as const,
        addedBy: agent.userId,
      })),
    ],
  });

  return {
    success: true,
    chatId: chat.id,
    name: chat.name || '',
  };
}

/**
 * Execute leave_chat tool
 * Chat.groupId → Group.id relationship
 */
export async function executeLeaveChat(
  agent: AuthenticatedAgent,
  args: LeaveChatArgs
): Promise<LeaveChatResult> {
  // Mark chat participant as inactive
  await db.chatParticipant.updateMany({
    where: {
      chatId: args.chatId,
      userId: agent.userId,
    },
    data: { isActive: false },
  });

  // Find the chat to get its groupId
  const chat = await db.chat.findUnique({
    where: { id: args.chatId },
    select: { groupId: true },
  });

  // Also update GroupMember if there's an associated group
  if (chat?.groupId) {
    await db.groupMember.updateMany({
      where: {
        groupId: chat.groupId,
        userId: agent.userId,
      },
      data: {
        isActive: false,
        kickedAt: new Date(),
        kickReason: 'User left',
      },
    });
  }

  return { success: true };
}

/**
 * Execute get_unread_count tool
 */
export async function executeGetUnreadCount(
  _agent: AuthenticatedAgent,
  _args: GetUnreadCountArgs
): Promise<GetUnreadCountResult> {
  // Read tracking not implemented in schema yet, return 0
  return { unreadCount: 0 };
}

// ============================================================================
// Notifications - Handlers
// ============================================================================

/**
 * Execute get_notifications tool
 */
export async function executeGetNotifications(
  agent: AuthenticatedAgent,
  args: GetNotificationsArgs
): Promise<GetNotificationsResult> {
  const notificationsList = await db.notification.findMany({
    where: { userId: agent.userId },
    orderBy: { createdAt: 'desc' },
    take: args.limit || 100,
  });
  return {
    notifications: notificationsList.map((n) => ({
      id: n.id,
      type: n.type,
      message: n.message,
      read: n.read,
      timestamp: n.createdAt.toISOString(),
    })),
  };
}

/**
 * Execute mark_notifications_read tool
 */
export async function executeMarkNotificationsRead(
  agent: AuthenticatedAgent,
  args: MarkNotificationsReadArgs
): Promise<MarkNotificationsReadResult> {
  await db.notification.updateMany({
    where: {
      id: { in: args.notificationIds },
      userId: agent.userId,
    },
    data: { read: true },
  });
  return {
    success: true,
    markedCount: args.notificationIds.length,
  };
}

/**
 * Execute get_portfolio tool
 */
export async function executeGetPortfolio(
  agent: AuthenticatedAgent,
  _args: GetPortfolioArgs
): Promise<GetPortfolioResult> {
  const apiBaseUrl = getAPIBaseUrl();
  const [user, portfolio] = await Promise.all([
    db.user.findUnique({
      where: { id: agent.userId },
      select: {
        virtualBalance: true,
        lifetimePnL: true,
      },
    }),
    safeFetchRequired<StringRecord<JsonValue>>(
      new URL(`${apiBaseUrl}/api/markets/positions/${agent.userId}`)
    ),
  ]);

  if (!user) {
    throw new Error('User not found');
  }

  return {
    balance: user.virtualBalance.toString(),
    lifetimePnL: user.lifetimePnL.toString(),
    ...portfolio,
  };
}

/**
 * Execute get_group_invites tool
 * Chat.groupId → Group.id relationship
 */
export async function executeGetGroupInvites(
  agent: AuthenticatedAgent,
  _args: GetGroupInvitesArgs
): Promise<GetGroupInvitesResult> {
  const invitesList = await db.groupInvite.findMany({
    where: {
      invitedUserId: agent.userId,
      status: 'pending',
    },
  });

  if (invitesList.length === 0) {
    return { invites: [] };
  }

  const groupIds = invitesList.map((inv) => inv.groupId);
  const groupsMap = new Map(
    (
      await db.group.findMany({
        where: { id: { in: groupIds } },
        select: { id: true, name: true },
      })
    ).map((g) => [g.id, g])
  );

  // Get chats for groups (Chat.groupId → Group.id)
  const chatsMap = new Map(
    (
      await db.chat.findMany({
        where: { groupId: { in: groupIds } },
        select: { id: true, groupId: true },
      })
    ).map((c) => [c.groupId, c.id])
  );

  return {
    invites: invitesList.map((invite) => {
      const group = groupsMap.get(invite.groupId);
      return {
        id: invite.id,
        groupId: chatsMap.get(invite.groupId) || invite.groupId, // Return chatId for backward compat
        groupName: group?.name || null,
        inviterId: invite.invitedBy,
        timestamp: invite.invitedAt.toISOString(),
      };
    }),
  };
}

/**
 * Execute accept_group_invite tool
 * Chat.groupId → Group.id relationship
 * Wrapped in transaction for atomicity
 */
export async function executeAcceptGroupInvite(
  agent: AuthenticatedAgent,
  args: AcceptGroupInviteArgs
): Promise<AcceptGroupInviteResult> {
  // Pre-transaction validation (read-only operations)
  const invite = await db.groupInvite.findUnique({
    where: { id: args.inviteId },
  });
  if (!invite || invite.invitedUserId !== agent.userId) {
    throw new Error('Invite not found or access denied');
  }

  // Check invite status for idempotency
  if (invite.status !== 'pending') {
    throw new Error('This invite has already been processed');
  }

  // Check if agent is at the NPC group limit - use join to avoid N+1
  const activeNpcGroups = await db
    .select({ groupId: groupMembers.groupId })
    .from(groupMembers)
    .innerJoin(groups, eq(groupMembers.groupId, groups.id))
    .where(
      and(
        eq(groupMembers.userId, agent.userId),
        eq(groupMembers.isActive, true),
        eq(groups.type, 'npc')
      )
    );

  const npcGroupCount = activeNpcGroups.length;

  if (npcGroupCount >= GROUP_CONFIG.MAX_ACTIVE_USER_GROUPS) {
    throw new Error(
      `You can only be in ${GROUP_CONFIG.MAX_ACTIVE_USER_GROUPS} NPC groups at a time. Leave a group first.`
    );
  }

  // Check for existing membership (idempotency)
  const existingMember = await db.groupMember.findFirst({
    where: {
      groupId: invite.groupId,
      userId: agent.userId,
    },
  });

  if (existingMember?.isActive) {
    throw new Error('You are already a member of this group');
  }

  // Find the chat for this group (Chat.groupId → Group.id)
  const groupChat = await db.chat.findFirst({
    where: { groupId: invite.groupId },
    select: { id: true },
  });

  // Wrap state-changing operations in a transaction for atomicity
  return await db.$transaction(async (tx) => {
    // Update invite status
    await tx.groupInvite.update({
      where: { id: args.inviteId },
      data: {
        status: 'accepted',
        respondedAt: new Date(),
      },
    });

    // Add to chat participants (handle existing inactive participant)
    if (groupChat) {
      const existingParticipant = await tx.chatParticipant.findFirst({
        where: {
          chatId: groupChat.id,
          userId: agent.userId,
        },
      });

      if (existingParticipant) {
        if (!existingParticipant.isActive) {
          await tx.chatParticipant.update({
            where: { id: existingParticipant.id },
            data: {
              isActive: true,
              joinedAt: new Date(),
            },
          });
        }
      } else {
        await tx.chatParticipant.create({
          data: {
            id: await generateSnowflakeId(),
            chatId: groupChat.id,
            userId: agent.userId,
            invitedBy: invite.invitedBy,
          },
        });
      }
    }

    // Add to GroupMember (handle existing inactive member)
    if (existingMember) {
      await tx.groupMember.update({
        where: { id: existingMember.id },
        data: {
          isActive: true,
          role: 'member',
          joinedAt: new Date(),
          addedBy: invite.invitedBy,
          kickedAt: null,
          kickReason: null,
        },
      });
    } else {
      await tx.groupMember.create({
        data: {
          id: await generateSnowflakeId(),
          groupId: invite.groupId,
          userId: agent.userId,
          role: 'member',
          addedBy: invite.invitedBy,
        },
      });
    }

    return {
      success: true,
      chatId: groupChat?.id || invite.groupId,
    };
  });
}

/**
 * Execute decline_group_invite tool
 */
export async function executeDeclineGroupInvite(
  agent: AuthenticatedAgent,
  args: DeclineGroupInviteArgs
): Promise<DeclineGroupInviteResult> {
  const invite = await db.groupInvite.findUnique({
    where: { id: args.inviteId },
  });
  if (!invite || invite.invitedUserId !== agent.userId) {
    throw new Error('Invite not found or access denied');
  }

  await db.groupInvite.update({
    where: { id: args.inviteId },
    data: {
      status: 'declined',
      respondedAt: new Date(),
    },
  });

  return { success: true };
}

// ============================================================================
// Leaderboard & Stats - Handlers
// ============================================================================

/**
 * Execute get_leaderboard tool
 */
export async function executeGetLeaderboard(
  _agent: AuthenticatedAgent,
  args: GetLeaderboardArgs
): Promise<GetLeaderboardResult> {
  const apiBaseUrl = getAPIBaseUrl();
  const url = new URL(`${apiBaseUrl}/api/leaderboard`);
  if (args.page) url.searchParams.set('page', args.page.toString());
  if (args.pageSize) url.searchParams.set('pageSize', args.pageSize.toString());
  url.searchParams.set('type', args.type || 'wallet');
  return safeFetchRequired<GetLeaderboardResult>(url);
}

/**
 * Execute get_system_stats tool
 */
export async function executeGetSystemStats(
  _agent: AuthenticatedAgent,
  _args: GetSystemStatsArgs
): Promise<GetSystemStatsResult> {
  const [userCount, postCount, marketCount, activeMarketCount] =
    await Promise.all([
      db.user.count(),
      db.post.count({ where: { deletedAt: null } }),
      db.market.count(),
      db.market.count({ where: { resolved: false } }),
    ]);
  return {
    users: userCount,
    posts: postCount,
    markets: marketCount,
    activeMarkets: activeMarketCount,
  };
}

/**
 * Execute resolve_market tool
 *
 * Uses PredictionMarketService.resolve() to ensure winners are paid out,
 * PnL is recorded, liquidity is updated, and resolution events are emitted.
 */
export async function executeResolveMarket(
  agent: AuthenticatedAgent,
  args: ResolveMarketArgs
): Promise<ResolveMarketResult> {
  const adminUser = await db.user.findUnique({
    where: { id: agent.userId },
    select: { isAdmin: true },
  });

  if (!adminUser?.isAdmin) {
    throw new Error('Unauthorized: Admin privileges are required');
  }

  const [market] = await db
    .select()
    .from(markets)
    .where(eq(markets.id, args.marketId))
    .limit(1);

  if (!market) {
    throw new Error('Market not found');
  }

  if (market.resolved) {
    throw new Error('Market already resolved');
  }

  const winningSide = args.resolution ? 'yes' : 'no';

  const service = buildPredictionService(args.marketId);
  await service.resolve({
    marketId: args.marketId,
    winningSide,
    resolutionDescription:
      args.reason || `Resolved by admin as ${args.resolution ? 'YES' : 'NO'}`,
  });

  await logAdminModify({
    adminId: agent.userId,
    resourceType: 'market',
    resourceId: args.marketId,
    previousValue: { resolved: false },
    newValue: {
      resolved: true,
      resolution: args.resolution,
      reason: args.reason ?? null,
    },
    metadata: { action: 'resolve', question: market.question },
  });

  return {
    success: true,
    marketId: args.marketId,
    resolution: args.resolution,
  };
}

// ============================================================================
// Referrals & Rewards - Handlers
// ============================================================================

/**
 * Execute get_referral_code tool
 */
export async function executeGetReferralCode(
  agent: AuthenticatedAgent,
  _args: GetReferralCodeArgs
): Promise<GetReferralCodeResult> {
  const user = await db.user.findUnique({
    where: { id: agent.userId },
    select: { referralCode: true },
  });
  if (!user || !user.referralCode) {
    throw new Error('Referral code not found');
  }
  return { referralCode: user.referralCode };
}

/**
 * Execute get_referrals tool
 */
export async function executeGetReferrals(
  agent: AuthenticatedAgent,
  _args: GetReferralsArgs
): Promise<GetReferralsResult> {
  const referralsList = await db.referral.findMany({
    where: { referrerId: agent.userId },
    orderBy: { createdAt: 'desc' },
  });
  const referredUserIds = referralsList
    .map((r) => r.referredUserId)
    .filter((id): id is string => id !== null);
  const usersList = await db.user.findMany({
    where: { id: { in: referredUserIds } },
    select: {
      id: true,
      username: true,
      displayName: true,
    },
  });
  const usersMap = new Map(usersList.map((u) => [u.id, u]));
  return {
    referrals: referralsList
      .filter((r) => r.referredUserId !== null)
      .map((r) => {
        const user = usersMap.get(r.referredUserId!);
        return {
          id: r.id,
          referredUserId: r.referredUserId!,
          username: user?.username || null,
          displayName: user?.displayName || null,
          createdAt: r.createdAt.toISOString(),
        };
      }),
  };
}

/**
 * Execute get_referral_stats tool
 */
export async function executeGetReferralStats(
  agent: AuthenticatedAgent,
  _args: GetReferralStatsArgs
): Promise<GetReferralStatsResult> {
  const [user, referralsList] = await Promise.all([
    db.user.findUnique({
      where: { id: agent.userId },
      select: { referralCode: true },
    }),
    db.referral.findMany({
      where: { referrerId: agent.userId },
    }),
  ]);
  // Referrer earnings not in schema, return 0 for now
  const totalEarnings = 0;
  return {
    totalReferrals: referralsList.length,
    totalEarnings,
    referralCode: user?.referralCode || '',
  };
}

// ============================================================================
// Reputation - Handlers
// ============================================================================

/**
 * Execute get_reputation tool
 */
export async function executeGetReputation(
  agent: AuthenticatedAgent,
  args: GetReputationArgs
): Promise<GetReputationResult> {
  const userId = args.userId || agent.userId;
  const apiBaseUrl = getAPIBaseUrl();
  return safeFetchRequired<GetReputationResult>(
    `${apiBaseUrl}/reputation/${userId}`
  );
}

/**
 * Execute get_reputation_breakdown tool
 */
export async function executeGetReputationBreakdown(
  _agent: AuthenticatedAgent,
  args: GetReputationBreakdownArgs
): Promise<GetReputationBreakdownResult> {
  const apiBaseUrl = getAPIBaseUrl();
  return safeFetchRequired<GetReputationBreakdownResult>(
    `${apiBaseUrl}/reputation/breakdown/${args.userId}`
  );
}

// ============================================================================
// Trending & Discovery - Handlers
// ============================================================================

/**
 * Execute get_trending_tags tool
 */
export async function executeGetTrendingTags(
  _agent: AuthenticatedAgent,
  args: GetTrendingTagsArgs
): Promise<GetTrendingTagsResult> {
  const trendingTagsList = await db.trendingTag.findMany({
    orderBy: { rank: 'asc' },
    take: args.limit || 20,
  });
  const tagIds = trendingTagsList.map((tt) => tt.tagId);
  const tagsList = await db.tag.findMany({
    where: { id: { in: tagIds } },
    select: { id: true, name: true },
  });
  const tagsMap = new Map(tagsList.map((t) => [t.id, t]));
  return {
    tags: trendingTagsList.map((tt) => ({
      tag: tagsMap.get(tt.tagId)?.name || '',
      postCount: tt.postCount,
      trendScore: tt.score || 0,
    })),
  };
}

// ============================================================================
// Organizations - Handlers
// ============================================================================

/**
 * Execute get_organizations tool
 */
export async function executeGetOrganizations(
  _agent: AuthenticatedAgent,
  args: GetOrganizationsArgs
): Promise<GetOrganizationsResult> {
  // Get organizations from static registry
  const orgsList = StaticDataRegistry.getAllOrganizations().slice(
    0,
    args.limit || 50
  );
  return {
    organizations: orgsList.map((staticOrg) => ({
      id: staticOrg.id,
      name: staticOrg.name,
      description: staticOrg.description,
    })),
  };
}

// ============================================================================
// x402 Micropayments - Reserved Handlers
// These tools are intentionally not registered in MCP discovery until the
// Feed MCP surface supports them end-to-end.
// ============================================================================

/**
 * Execute payment_request tool
 *
 * @throws {Error} Always throws - tool is intentionally disabled.
 */
export async function executePaymentRequest(
  _agent: AuthenticatedAgent,
  _args: PaymentRequestArgs
): Promise<PaymentRequestResult> {
  throw new Error(
    'MCP tool payment_request is disabled until x402 support is registered in Feed MCP discovery.'
  );
}

/**
 * Execute payment_receipt tool
 *
 * @throws {Error} Always throws - tool is intentionally disabled.
 */
export async function executePaymentReceipt(
  _agent: AuthenticatedAgent,
  _args: PaymentReceiptArgs
): Promise<PaymentReceiptResult> {
  throw new Error(
    'MCP tool payment_receipt is disabled until x402 support is registered in Feed MCP discovery.'
  );
}

// ============================================================================
// Moderation - Handlers
// ============================================================================

/**
 * Execute block_user tool
 */
export async function executeBlockUser(
  agent: AuthenticatedAgent,
  args: BlockUserArgs
): Promise<BlockUserResult> {
  if (args.userId === agent.userId) {
    throw new Error('Cannot block yourself');
  }
  const existing = await db.userBlock.findFirst({
    where: {
      blockerId: agent.userId,
      blockedId: args.userId,
    },
  });
  if (existing) {
    return { success: true };
  }
  await db.userBlock.create({
    data: {
      id: await generateSnowflakeId(),
      blockerId: agent.userId,
      blockedId: args.userId,
    },
  });
  return { success: true };
}

/**
 * Execute unblock_user tool
 */
export async function executeUnblockUser(
  agent: AuthenticatedAgent,
  args: UnblockUserArgs
): Promise<UnblockUserResult> {
  await db.userBlock.deleteMany({
    where: {
      blockerId: agent.userId,
      blockedId: args.userId,
    },
  });
  return { success: true };
}

/**
 * Execute mute_user tool
 */
export async function executeMuteUser(
  agent: AuthenticatedAgent,
  args: MuteUserArgs
): Promise<MuteUserResult> {
  if (args.userId === agent.userId) {
    throw new Error('Cannot mute yourself');
  }
  const existing = await db.userMute.findFirst({
    where: {
      muterId: agent.userId,
      mutedId: args.userId,
    },
  });
  if (existing) {
    return { success: true };
  }
  await db.userMute.create({
    data: {
      id: await generateSnowflakeId(),
      muterId: agent.userId,
      mutedId: args.userId,
    },
  });
  return { success: true };
}

/**
 * Execute unmute_user tool
 */
export async function executeUnmuteUser(
  agent: AuthenticatedAgent,
  args: UnmuteUserArgs
): Promise<UnmuteUserResult> {
  await db.userMute.deleteMany({
    where: {
      muterId: agent.userId,
      mutedId: args.userId,
    },
  });
  return { success: true };
}

/**
 * Execute report_user tool
 */
export async function executeReportUser(
  agent: AuthenticatedAgent,
  args: ReportUserArgs
): Promise<ReportUserResult> {
  const reportId = await generateSnowflakeId();
  await db.report.create({
    data: {
      id: reportId,
      reporterId: agent.userId,
      reportedUserId: args.userId,
      reason: args.reason,
      reportType: 'user',
      category: 'moderation',
      updatedAt: new Date(),
    },
  });
  return { success: true, reportId };
}

/**
 * Execute report_post tool
 */
export async function executeReportPost(
  agent: AuthenticatedAgent,
  args: ReportPostArgs
): Promise<ReportPostResult> {
  const reportId = await generateSnowflakeId();
  await db.report.create({
    data: {
      id: reportId,
      reporterId: agent.userId,
      reportedPostId: args.postId,
      reason: args.reason,
      reportType: 'post',
      category: 'moderation',
      updatedAt: new Date(),
    },
  });
  return { success: true, reportId };
}

/**
 * Execute get_blocks tool
 */
export async function executeGetBlocks(
  agent: AuthenticatedAgent,
  _args: GetBlocksArgs
): Promise<GetBlocksResult> {
  const blocksList = await db.userBlock.findMany({
    where: { blockerId: agent.userId },
    orderBy: { createdAt: 'desc' },
  });
  const blockedIds = blocksList.map((b) => b.blockedId);
  const usersList = await db.user.findMany({
    where: { id: { in: blockedIds } },
    select: {
      id: true,
      username: true,
      displayName: true,
    },
  });
  const usersMap = new Map(usersList.map((u) => [u.id, u]));
  return {
    blockedUsers: blocksList.map((b) => {
      const user = usersMap.get(b.blockedId);
      return {
        userId: b.blockedId,
        username: user?.username || null,
        displayName: user?.displayName || null,
        blockedAt: b.createdAt.toISOString(),
      };
    }),
  };
}

/**
 * Execute get_mutes tool
 */
export async function executeGetMutes(
  agent: AuthenticatedAgent,
  _args: GetMutesArgs
): Promise<GetMutesResult> {
  const mutesList = await db.userMute.findMany({
    where: { muterId: agent.userId },
    orderBy: { createdAt: 'desc' },
  });
  const mutedIds = mutesList.map((m) => m.mutedId);
  const usersList = await db.user.findMany({
    where: { id: { in: mutedIds } },
    select: {
      id: true,
      username: true,
      displayName: true,
    },
  });
  const usersMap = new Map(usersList.map((u) => [u.id, u]));
  return {
    mutedUsers: mutesList.map((m) => {
      const user = usersMap.get(m.mutedId);
      return {
        userId: m.mutedId,
        username: user?.username || null,
        displayName: user?.displayName || null,
        mutedAt: m.createdAt.toISOString(),
      };
    }),
  };
}

/**
 * Execute check_block_status tool
 */
export async function executeCheckBlockStatus(
  agent: AuthenticatedAgent,
  args: CheckBlockStatusArgs
): Promise<CheckBlockStatusResult> {
  const block = await db.userBlock.findFirst({
    where: {
      blockerId: agent.userId,
      blockedId: args.userId,
    },
  });
  return {
    isBlocked: !!block,
    blockedAt: block?.createdAt.toISOString() || null,
  };
}

/**
 * Execute check_mute_status tool
 */
export async function executeCheckMuteStatus(
  agent: AuthenticatedAgent,
  args: CheckMuteStatusArgs
): Promise<CheckMuteStatusResult> {
  const mute = await db.userMute.findFirst({
    where: {
      muterId: agent.userId,
      mutedId: args.userId,
    },
  });
  return {
    isMuted: !!mute,
    mutedAt: mute?.createdAt.toISOString() || null,
  };
}

// ============================================================================
// Moderation Escrow - Handlers
// ============================================================================

/**
 * Execute create_escrow_payment tool
 */
export async function executeCreateEscrowPayment(
  agent: AuthenticatedAgent,
  args: CreateEscrowPaymentArgs
): Promise<CreateEscrowPaymentResult> {
  const request: JsonRpcRequest = {
    jsonrpc: '2.0',
    method: 'a2a.createEscrowPayment',
    params: {
      recipientId: args.recipientId,
      amountUSD: args.amountUSD,
      reason: args.reason,
      recipientWalletAddress: args.recipientWalletAddress,
    } as JsonRpcParams,
    id: 1,
  };
  const response = await handleCreateEscrowPayment(agent.agentId, request);
  if (response.error) {
    throw new Error(response.error.message);
  }
  if (!response.result) {
    throw new Error('No result in response');
  }
  return response.result as unknown as CreateEscrowPaymentResult;
}

/**
 * Execute verify_escrow_payment tool
 */
export async function executeVerifyEscrowPayment(
  agent: AuthenticatedAgent,
  args: VerifyEscrowPaymentArgs
): Promise<VerifyEscrowPaymentResult> {
  const request: JsonRpcRequest = {
    jsonrpc: '2.0',
    method: 'a2a.verifyEscrowPayment',
    params: {
      escrowId: args.escrowId,
      txHash: args.txHash,
      fromAddress: args.fromAddress,
      toAddress: args.toAddress,
      amount: args.amount,
    } as JsonRpcParams,
    id: 1,
  };
  const response = await handleVerifyEscrowPayment(agent.agentId, request);
  if (response.error) {
    throw new Error(response.error.message);
  }
  if (!response.result) {
    throw new Error('No result in response');
  }
  return response.result as unknown as VerifyEscrowPaymentResult;
}

/**
 * Execute refund_escrow_payment tool
 */
export async function executeRefundEscrowPayment(
  agent: AuthenticatedAgent,
  args: RefundEscrowPaymentArgs
): Promise<RefundEscrowPaymentResult> {
  const request: JsonRpcRequest = {
    jsonrpc: '2.0',
    method: 'a2a.refundEscrowPayment',
    params: {
      escrowId: args.escrowId,
      refundTxHash: args.refundTxHash,
      reason: args.reason,
    } as JsonRpcParams,
    id: 1,
  };
  const response = await handleRefundEscrowPayment(agent.agentId, request);
  if (response.error) {
    throw new Error(response.error.message);
  }
  if (!response.result) {
    throw new Error('No result in response');
  }
  return response.result as unknown as RefundEscrowPaymentResult;
}

/**
 * Execute list_escrow_payments tool
 */
export async function executeListEscrowPayments(
  agent: AuthenticatedAgent,
  args: ListEscrowPaymentsArgs
): Promise<ListEscrowPaymentsResult> {
  const request: JsonRpcRequest = {
    jsonrpc: '2.0',
    method: 'a2a.listEscrowPayments',
    params: {
      recipientId: args.recipientId,
      adminId: args.adminId,
      status: args.status,
      limit: args.limit,
      offset: args.offset,
    } as JsonRpcParams,
    id: 1,
  };
  const response = await handleListEscrowPayments(agent.agentId, request);
  if (response.error) {
    throw new Error(response.error.message);
  }
  if (!response.result) {
    throw new Error('No result in response');
  }
  return response.result as unknown as ListEscrowPaymentsResult;
}

// ============================================================================
// Ban Appeals - Handlers
// ============================================================================

/**
 * Execute appeal_ban tool
 */
export async function executeAppealBan(
  agent: AuthenticatedAgent,
  args: AppealBanArgs
): Promise<AppealBanResult> {
  logger.info(`Agent ${agent.agentId} appealing ban:`, args, 'MCP');

  const userId = agent.userId;

  // Get user
  const user = await db.user.findUnique({
    where: { id: userId },
    select: {
      id: true,
      isBanned: true,
      appealCount: true,
      appealStaked: true,
      appealStatus: true,
    },
  });

  if (!user) {
    throw new Error('User not found');
  }

  if (!user.isBanned) {
    throw new Error('User is not banned');
  }

  // Check if already appealed
  if (user.appealCount >= 1 && !user.appealStaked) {
    throw new Error(
      'You have already used your free appeal. You must stake $10 for a second review.'
    );
  }

  if (user.appealStaked && user.appealStatus === 'human_review') {
    throw new Error(
      'Your appeal is already in human review. Please wait for a decision.'
    );
  }

  // Update appeal status - submit for strict review (first appeal)
  await db.user.update({
    where: { id: userId },
    data: {
      appealCount: user.appealCount + 1,
      appealStatus: 'strict_review',
      appealSubmittedAt: new Date(),
    },
  });

  return {
    success: true,
    message:
      'Appeal submitted for strict review. Please note: full AI evaluation is only available via the web interface.',
    appealStatus: 'strict_review',
  };
}

/**
 * Execute appeal_ban_with_escrow tool
 */
export async function executeAppealBanWithEscrow(
  agent: AuthenticatedAgent,
  args: AppealBanWithEscrowArgs
): Promise<AppealBanWithEscrowResult> {
  const request: JsonRpcRequest = {
    jsonrpc: '2.0',
    method: 'a2a.appealBanWithEscrow',
    params: {
      reason: args.reason,
      escrowPaymentTxHash: args.escrowPaymentTxHash,
    } as JsonRpcParams,
    id: 1,
  };
  const response = await handleAppealBanWithEscrow(agent.agentId, request);
  if (response.error) {
    throw new Error(response.error.message);
  }
  if (!response.result) {
    throw new Error('No result in response');
  }
  return response.result as unknown as AppealBanWithEscrowResult;
}

// ============================================================================
// Favorites - Handlers
// ============================================================================

/**
 * Execute favorite_profile tool
 */
export async function executeFavoriteProfile(
  agent: AuthenticatedAgent,
  args: FavoriteProfileArgs
): Promise<FavoriteProfileResult> {
  if (args.userId === agent.userId) {
    throw new Error('Cannot favorite yourself');
  }
  const existing = await db.favorite.findFirst({
    where: {
      userId: agent.userId,
      targetUserId: args.userId,
    },
  });
  if (existing) {
    return { success: true };
  }
  await db.favorite.create({
    data: {
      id: await generateSnowflakeId(),
      userId: agent.userId,
      targetUserId: args.userId,
    },
  });
  return { success: true };
}

/**
 * Execute unfavorite_profile tool
 */
export async function executeUnfavoriteProfile(
  agent: AuthenticatedAgent,
  args: UnfavoriteProfileArgs
): Promise<UnfavoriteProfileResult> {
  await db.favorite.deleteMany({
    where: {
      userId: agent.userId,
      targetUserId: args.userId,
    },
  });
  return { success: true };
}

/**
 * Execute get_favorites tool
 */
export async function executeGetFavorites(
  agent: AuthenticatedAgent,
  args: GetFavoritesArgs
): Promise<GetFavoritesResult> {
  const favoritesList = await db.favorite.findMany({
    where: { userId: agent.userId },
    take: args.limit || 50,
    skip: args.offset || 0,
    orderBy: { createdAt: 'desc' },
  });
  const targetUserIds = favoritesList.map((f) => f.targetUserId);
  const usersList = await db.user.findMany({
    where: { id: { in: targetUserIds } },
    select: {
      id: true,
      username: true,
      displayName: true,
      profileImageUrl: true,
    },
  });
  const usersMap = new Map(usersList.map((u) => [u.id, u]));
  return {
    favorites: favoritesList.map((f) => {
      const user = usersMap.get(f.targetUserId);
      return {
        userId: f.targetUserId,
        username: user?.username || null,
        displayName: user?.displayName || null,
        profileImageUrl: user?.profileImageUrl || null,
        favoritedAt: f.createdAt.toISOString(),
      };
    }),
  };
}

/**
 * Execute get_favorite_posts tool
 */
export async function executeGetFavoritePosts(
  agent: AuthenticatedAgent,
  args: GetFavoritePostsArgs
): Promise<GetFavoritePostsResult> {
  const apiBaseUrl = getAPIBaseUrl();
  const url = new URL(`${apiBaseUrl}/posts/feed/favorites`);
  if (args.limit) url.searchParams.set('limit', args.limit.toString());
  if (args.offset) url.searchParams.set('offset', args.offset.toString());
  const data = await safeFetch<{
    posts: Array<{
      id: string;
      content: string;
      authorId: string;
      timestamp: Date | string;
    }>;
  }>(url, {
    headers: { 'X-User-Id': agent.userId },
  });

  // Handle null/empty response
  if (!data) {
    return { posts: [] };
  }

  return {
    posts: data.posts.map((post) => ({
      id: post.id,
      content: post.content,
      authorId: post.authorId,
      timestamp:
        post.timestamp instanceof Date
          ? post.timestamp.toISOString()
          : post.timestamp,
    })),
  };
}

// ============================================================================
// Points Transfer - Handlers
// ============================================================================

// ============================================================================
// Tool Router
// ============================================================================

/**
 * Execute MCP tool by name
 */
export async function executeTool(
  toolName: string,
  args: StringRecord<JsonValue>,
  agent: AuthenticatedAgent
): Promise<MCPToolResult> {
  switch (toolName) {
    // Existing tools
    case 'get_markets': {
      const validatedArgs = validateGetMarketsArgs(args);
      return await executeGetMarkets(validatedArgs, agent);
    }
    case 'place_bet': {
      const validatedArgs = validatePlaceBetArgs(args);
      return await executePlaceBet(agent, validatedArgs);
    }
    case 'get_balance': {
      validateGetBalanceArgs(args);
      return await executeGetBalance(agent);
    }
    case 'get_positions': {
      const validatedArgs = validateGetPositionsArgs(args);
      return await executeGetPositions(agent, validatedArgs);
    }
    case 'close_position': {
      const validatedArgs = validateClosePositionArgs(args);
      return await executeClosePosition(agent, validatedArgs);
    }
    case 'get_market_data': {
      const validatedArgs = validateGetMarketDataArgs(args);
      return await executeGetMarketData(agent, validatedArgs);
    }
    case 'query_feed': {
      const validatedArgs = validateQueryFeedArgs(args);
      return await executeQueryFeed(agent, validatedArgs);
    }
    // Market Operations
    case 'buy_shares': {
      const validatedArgs = validateBuySharesArgs(args);
      return await executeBuyShares(agent, validatedArgs);
    }
    case 'sell_shares': {
      const validatedArgs = validateSellSharesArgs(args);
      return await executeSellShares(agent, validatedArgs);
    }
    case 'open_position': {
      const validatedArgs = validateOpenPositionArgs(args);
      return await executeOpenPosition(agent, validatedArgs);
    }
    case 'get_market_prices': {
      const validatedArgs = validateGetMarketPricesArgs(args);
      return await executeGetMarketPrices(agent, validatedArgs);
    }
    case 'get_perpetuals': {
      validateGetPerpetualsArgs(args);
      return await executeGetPerpetuals(agent, {} as GetPerpetualsArgs);
    }
    case 'get_trades': {
      const validatedArgs = validateGetTradesArgs(args);
      return await executeGetTrades(agent, validatedArgs);
    }
    case 'get_trade_history': {
      const validatedArgs = validateGetTradeHistoryArgs(args);
      return await executeGetTradeHistory(agent, validatedArgs);
    }
    // Social Features
    case 'get_post': {
      const validatedArgs = validateGetPostArgs(args);
      return await executeGetPost(agent, validatedArgs);
    }
    case 'create_post': {
      const validatedArgs = validateCreatePostArgs(args);
      return await executeCreatePost(agent, validatedArgs);
    }
    case 'delete_post': {
      const validatedArgs = validateDeletePostArgs(args);
      return await executeDeletePost(agent, validatedArgs);
    }
    case 'like_post': {
      const validatedArgs = validateLikePostArgs(args);
      return await executeLikePost(agent, validatedArgs);
    }
    case 'unlike_post': {
      const validatedArgs = validateUnlikePostArgs(args);
      return await executeUnlikePost(agent, validatedArgs);
    }
    case 'share_post': {
      const validatedArgs = validateSharePostArgs(args);
      return await executeSharePost(agent, validatedArgs);
    }
    case 'get_comments': {
      const validatedArgs = validateGetCommentsArgs(args);
      return await executeGetComments(agent, validatedArgs);
    }
    case 'create_comment': {
      const validatedArgs = validateCreateCommentArgs(args);
      return await executeCreateComment(agent, validatedArgs);
    }
    case 'delete_comment': {
      const validatedArgs = validateDeleteCommentArgs(args);
      return await executeDeleteComment(agent, validatedArgs);
    }
    case 'like_comment': {
      const validatedArgs = validateLikeCommentArgs(args);
      return await executeLikeComment(agent, validatedArgs);
    }
    case 'get_posts_by_tag': {
      const validatedArgs = validateGetPostsByTagArgs(args);
      return await executeGetPostsByTag(agent, validatedArgs);
    }
    // User Management
    case 'get_user_profile': {
      const validatedArgs = validateGetUserProfileArgs(args);
      return await executeGetUserProfile(agent, validatedArgs);
    }
    case 'update_profile': {
      const validatedArgs = validateUpdateProfileArgs(args);
      return await executeUpdateProfile(agent, validatedArgs);
    }
    case 'follow_user': {
      const validatedArgs = validateFollowUserArgs(args);
      return await executeFollowUser(agent, validatedArgs);
    }
    case 'unfollow_user': {
      const validatedArgs = validateUnfollowUserArgs(args);
      return await executeUnfollowUser(agent, validatedArgs);
    }
    case 'get_followers': {
      const validatedArgs = validateGetFollowersArgs(args);
      return await executeGetFollowers(agent, validatedArgs);
    }
    case 'get_following': {
      const validatedArgs = validateGetFollowingArgs(args);
      return await executeGetFollowing(agent, validatedArgs);
    }
    case 'search_users': {
      const validatedArgs = validateSearchUsersArgs(args);
      return await executeSearchUsers(agent, validatedArgs);
    }
    case 'search_agents': {
      const validatedArgs = validateSearchAgentsArgs(args);
      return await executeSearchAgents(agent, validatedArgs);
    }
    case 'get_user_wallet': {
      const validatedArgs = validateGetUserWalletArgs(args);
      return await executeGetUserWallet(agent, validatedArgs);
    }
    case 'get_user_stats': {
      const validatedArgs = validateGetUserStatsArgs(args);
      return await executeGetUserStats(agent, validatedArgs);
    }
    // Chats & Messaging
    case 'get_chats': {
      const validatedArgs = validateGetChatsArgs(args);
      return await executeGetChats(agent, validatedArgs);
    }
    case 'get_chat_messages': {
      const validatedArgs = validateGetChatMessagesArgs(args);
      return await executeGetChatMessages(agent, validatedArgs);
    }
    case 'send_message': {
      const validatedArgs = validateSendMessageArgs(args);
      return await executeSendMessage(agent, validatedArgs);
    }
    case 'create_group': {
      const validatedArgs = validateCreateGroupArgs(args);
      return await executeCreateGroup(agent, validatedArgs);
    }
    case 'leave_chat': {
      const validatedArgs = validateLeaveChatArgs(args);
      return await executeLeaveChat(agent, validatedArgs);
    }
    case 'get_unread_count': {
      validateGetUnreadCountArgs(args);
      return await executeGetUnreadCount(agent, {} as GetUnreadCountArgs);
    }
    // Notifications
    case 'get_notifications': {
      const validatedArgs = validateGetNotificationsArgs(args);
      return await executeGetNotifications(agent, validatedArgs);
    }
    case 'mark_notifications_read': {
      const validatedArgs = validateMarkNotificationsReadArgs(args);
      return await executeMarkNotificationsRead(agent, validatedArgs);
    }
    case 'get_portfolio': {
      validateGetPortfolioArgs(args);
      return await executeGetPortfolio(agent, {} as GetPortfolioArgs);
    }
    case 'get_group_invites': {
      validateGetGroupInvitesArgs(args);
      return await executeGetGroupInvites(agent, {} as GetGroupInvitesArgs);
    }
    case 'accept_group_invite': {
      const validatedArgs = validateAcceptGroupInviteArgs(args);
      return await executeAcceptGroupInvite(agent, validatedArgs);
    }
    case 'decline_group_invite': {
      const validatedArgs = validateDeclineGroupInviteArgs(args);
      return await executeDeclineGroupInvite(agent, validatedArgs);
    }
    // Leaderboard & Stats
    case 'get_leaderboard': {
      const validatedArgs = validateGetLeaderboardArgs(args);
      return await executeGetLeaderboard(agent, validatedArgs);
    }
    case 'get_system_stats': {
      validateGetSystemStatsArgs(args);
      return await executeGetSystemStats(agent, {} as GetSystemStatsArgs);
    }
    case 'resolve_market': {
      const validatedArgs = validateResolveMarketArgs(args);
      return await executeResolveMarket(agent, validatedArgs);
    }
    // Referrals & Rewards
    case 'get_referral_code': {
      validateGetReferralCodeArgs(args);
      return await executeGetReferralCode(agent, {} as GetReferralCodeArgs);
    }
    case 'get_referrals': {
      validateGetReferralsArgs(args);
      return await executeGetReferrals(agent, {} as GetReferralsArgs);
    }
    case 'get_referral_stats': {
      validateGetReferralStatsArgs(args);
      return await executeGetReferralStats(agent, {} as GetReferralStatsArgs);
    }
    // Reputation
    case 'get_reputation': {
      const validatedArgs = validateGetReputationArgs(args);
      return await executeGetReputation(agent, validatedArgs);
    }
    case 'get_reputation_breakdown': {
      const validatedArgs = validateGetReputationBreakdownArgs(args);
      return await executeGetReputationBreakdown(agent, validatedArgs);
    }
    // Trending & Discovery
    case 'get_trending_tags': {
      const validatedArgs = validateGetTrendingTagsArgs(args);
      return await executeGetTrendingTags(agent, validatedArgs);
    }
    // Organizations
    case 'get_organizations': {
      const validatedArgs = validateGetOrganizationsArgs(args);
      return await executeGetOrganizations(agent, validatedArgs);
    }
    // x402 Micropayments
    case 'payment_request': {
      const validatedArgs = validatePaymentRequestArgs(args);
      return await executePaymentRequest(agent, validatedArgs);
    }
    case 'payment_receipt': {
      const validatedArgs = validatePaymentReceiptArgs(args);
      return await executePaymentReceipt(agent, validatedArgs);
    }
    // Moderation
    case 'block_user': {
      const validatedArgs = validateBlockUserArgs(args);
      return await executeBlockUser(agent, validatedArgs);
    }
    case 'unblock_user': {
      const validatedArgs = validateUnblockUserArgs(args);
      return await executeUnblockUser(agent, validatedArgs);
    }
    case 'mute_user': {
      const validatedArgs = validateMuteUserArgs(args);
      return await executeMuteUser(agent, validatedArgs);
    }
    case 'unmute_user': {
      const validatedArgs = validateUnmuteUserArgs(args);
      return await executeUnmuteUser(agent, validatedArgs);
    }
    case 'report_user': {
      const validatedArgs = validateReportUserArgs(args);
      return await executeReportUser(agent, validatedArgs);
    }
    case 'report_post': {
      const validatedArgs = validateReportPostArgs(args);
      return await executeReportPost(agent, validatedArgs);
    }
    case 'get_blocks': {
      validateGetBlocksArgs(args);
      return await executeGetBlocks(agent, {} as GetBlocksArgs);
    }
    case 'get_mutes': {
      validateGetMutesArgs(args);
      return await executeGetMutes(agent, {} as GetMutesArgs);
    }
    case 'check_block_status': {
      const validatedArgs = validateCheckBlockStatusArgs(args);
      return await executeCheckBlockStatus(agent, validatedArgs);
    }
    case 'check_mute_status': {
      const validatedArgs = validateCheckMuteStatusArgs(args);
      return await executeCheckMuteStatus(agent, validatedArgs);
    }
    // Moderation Escrow
    case 'create_escrow_payment': {
      const validatedArgs = validateCreateEscrowPaymentArgs(args);
      return await executeCreateEscrowPayment(agent, validatedArgs);
    }
    case 'verify_escrow_payment': {
      const validatedArgs = validateVerifyEscrowPaymentArgs(args);
      return await executeVerifyEscrowPayment(agent, validatedArgs);
    }
    case 'refund_escrow_payment': {
      const validatedArgs = validateRefundEscrowPaymentArgs(args);
      return await executeRefundEscrowPayment(agent, validatedArgs);
    }
    case 'list_escrow_payments': {
      const validatedArgs = validateListEscrowPaymentsArgs(args);
      return await executeListEscrowPayments(agent, validatedArgs);
    }
    // Ban Appeals
    case 'appeal_ban': {
      const validatedArgs = validateAppealBanArgs(args);
      return await executeAppealBan(agent, validatedArgs);
    }
    case 'appeal_ban_with_escrow': {
      const validatedArgs = validateAppealBanWithEscrowArgs(args);
      return await executeAppealBanWithEscrow(agent, validatedArgs);
    }
    // Favorites
    case 'favorite_profile': {
      const validatedArgs = validateFavoriteProfileArgs(args);
      return await executeFavoriteProfile(agent, validatedArgs);
    }
    case 'unfavorite_profile': {
      const validatedArgs = validateUnfavoriteProfileArgs(args);
      return await executeUnfavoriteProfile(agent, validatedArgs);
    }
    case 'get_favorites': {
      const validatedArgs = validateGetFavoritesArgs(args);
      return await executeGetFavorites(agent, validatedArgs);
    }
    case 'get_favorite_posts': {
      const validatedArgs = validateGetFavoritePostsArgs(args);
      return await executeGetFavoritePosts(agent, validatedArgs);
    }
    default:
      throw new Error(`Unknown tool: ${toolName}`);
  }
}
