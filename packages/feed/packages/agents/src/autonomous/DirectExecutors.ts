/**
 * Direct Executors for Multi-Step Agent Actions
 *
 * These are "dumb" executors that take specific parameters and execute directly
 * without making their own LLM calls. The multi-step decision loop handles all
 * LLM reasoning - these just execute the decided actions.
 */

import {
  broadcastAgentActivity,
  broadcastChatMessage,
  broadcastToChannel,
  type CommentActivityData,
  cachedDb,
  type JsonValue,
  type MessageActivityData,
  notifyGroupChatMessage,
  type PostActivityData,
} from '@feed/api';
import { PerpDbAdapter, PerpMarketService } from '@feed/core/markets/perps';
import {
  PredictionDbAdapter,
  PredictionMarketService,
} from '@feed/core/markets/prediction';
import {
  actorState,
  aliasedTable,
  and,
  asSystem,
  asUser,
  chatParticipants,
  chats,
  comments,
  db,
  desc,
  dmAcceptances,
  eq,
  follows,
  groupMembers,
  groups,
  gte,
  inArray,
  isNull,
  messages,
  perpPositions,
  posts,
  reactions,
  shares,
  sql,
  users,
  withTransaction,
} from '@feed/db';
import {
  createPerpPriceImpactPort,
  FEE_CONFIG,
  FeeService,
  type GeneratedTag,
  generateTagsFromPost,
  invalidateAfterPredictionTrade,
  PredictionPricing,
  StaticDataRegistry,
  storeTagsForPost,
  WalletService,
} from '@feed/engine';
import {
  AGENT_TRANSFER_IN_TRANSACTION_TYPE,
  AGENT_TRANSFER_OUT_TRANSACTION_TYPE,
  isPureRepost,
} from '@feed/shared';
import { agentPnLService } from '../services/AgentPnLService';
import { logger } from '../shared/logger';
import { generateSnowflakeId } from '../shared/snowflake';
import { topicDiversityService } from './TopicDiversityService';
import { resolvePerpTicker } from './utils/resolvePerpTicker';

/**
 * Helper to get agent display name for broadcasting.
 *
 * Currently called only within `if (!isNpc)` blocks, but includes a defensive
 * NPC check for reusability. The StaticDataRegistry lookup is O(1) so this
 * adds negligible overhead while future-proofing the helper for callers that
 * may not have already performed the NPC check.
 */
async function getAgentDisplayName(agentUserId: string): Promise<string> {
  // Defensive NPC check - O(1) fast-path for potential future callers
  // that haven't already verified the agent is not an NPC
  const npcActor = StaticDataRegistry.getActor(agentUserId);
  if (npcActor) {
    return npcActor.name;
  }

  // Query user table for display name
  const [agent] = await db
    .select({ displayName: users.displayName })
    .from(users)
    .where(eq(users.id, agentUserId))
    .limit(1);

  return agent?.displayName ?? 'Agent';
}

const SHARE_LIKE_MAX_INTEGER = 10;
const SHARE_LIKE_RATIO_THRESHOLD = 0.01;
// Minimum shares threshold - positions with fewer shares are considered closed
const MIN_SHARES_THRESHOLD = 0.01;
const PREDICTION_TRADE_SIDES = new Set([
  'buy_yes',
  'buy_no',
  'sell_yes',
  'sell_no',
]);
const PERP_TRADE_SIDES = new Set(['open_long', 'open_short', 'close_position']);

// =============================================================================
// Wallet Adapter Helper
// =============================================================================

/**
 * Creates a wallet adapter for perp trading operations.
 * NPCs use actorState.tradingBalance, while regular users use WalletService.
 */
function createPerpWalletAdapter(isNpc: boolean) {
  if (isNpc) {
    return {
      debit: async ({
        userId: uid,
        amount: amt,
      }: {
        userId: string;
        amount: number;
        reason: string;
        description?: string;
        relatedId?: string;
      }) => {
        // Atomic debit with balance check to prevent negative balance
        const result = await db
          .update(actorState)
          .set({
            tradingBalance: sql`${actorState.tradingBalance} - ${amt}`,
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(actorState.id, uid),
              gte(sql<number>`${actorState.tradingBalance}::numeric`, amt)
            )
          )
          .returning({ id: actorState.id });

        if (result.length === 0) {
          throw new Error(`Insufficient NPC balance for perp trade: $${amt}`);
        }
      },
      credit: async ({
        userId: uid,
        amount: amt,
      }: {
        userId: string;
        amount: number;
        reason: string;
        description?: string;
        relatedId?: string;
      }) => {
        await db
          .update(actorState)
          .set({
            tradingBalance: sql`${actorState.tradingBalance} + ${amt}`,
            updatedAt: new Date(),
          })
          .where(eq(actorState.id, uid));
      },
      recordPnL: async (_args: {
        userId: string;
        pnl: number;
        reason: string;
        relatedId?: string;
      }) => {
        // NPCs don't track PnL
      },
      getBalance: async (uid: string) => {
        const [actor] = await db
          .select({ tradingBalance: actorState.tradingBalance })
          .from(actorState)
          .where(eq(actorState.id, uid))
          .limit(1);
        return {
          balance: Number(actor?.tradingBalance ?? 10000),
          totalDeposited: 0,
          totalWithdrawn: 0,
          lifetimePnL: 0,
        };
      },
    };
  }

  return {
    debit: ({
      userId: uid,
      amount: amt,
      reason,
      description,
      relatedId,
    }: {
      userId: string;
      amount: number;
      reason: string;
      description?: string;
      relatedId?: string;
    }) => WalletService.debit(uid, amt, reason, description ?? '', relatedId),
    credit: ({
      userId: uid,
      amount: amt,
      reason,
      description,
      relatedId,
    }: {
      userId: string;
      amount: number;
      reason: string;
      description?: string;
      relatedId?: string;
    }) => WalletService.credit(uid, amt, reason, description ?? '', relatedId),
    recordPnL: async ({
      userId: uid,
      pnl,
      reason,
      relatedId,
    }: {
      userId: string;
      pnl: number;
      reason: string;
      relatedId?: string;
    }) => {
      await WalletService.recordPnL(uid, pnl, reason, relatedId);
    },
    getBalance: (uid: string) => WalletService.getBalance(uid),
  };
}

/** PnL record to be processed after transaction completes */
interface DeferredPnLRecord {
  userId: string;
  pnl: number;
  reason: string;
  relatedId?: string;
}

/**
 * Creates a wallet adapter for prediction market trading operations.
 *
 * - NPCs use actorState.tradingBalance (within the provided transaction context).
 * - Regular users use WalletService.
 *
 * IMPORTANT: recordPnL is deferred to avoid nested transaction deadlocks.
 * The caller must process deferredPnL after the transaction completes.
 */
function createPredictionWalletAdapter(
  isNpc: boolean,
  txDb?: Parameters<Parameters<typeof asUser>[1]>[0],
  deferredPnL?: DeferredPnLRecord[]
) {
  if (isNpc) {
    if (!txDb) {
      throw new Error('Transaction context required for NPC prediction wallet');
    }
    return {
      debit: async ({
        userId: uid,
        amount: amt,
      }: {
        userId: string;
        amount: number;
        reason: string;
        description?: string;
        relatedId?: string;
      }) => {
        const result = await txDb
          .update(actorState)
          .set({
            tradingBalance: sql`${actorState.tradingBalance} - ${amt}`,
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(actorState.id, uid),
              gte(sql<number>`${actorState.tradingBalance}::numeric`, amt)
            )
          )
          .returning({ id: actorState.id });

        if (result.length === 0) {
          throw new Error(
            `Insufficient NPC balance for prediction trade: $${amt}`
          );
        }
      },
      credit: async ({
        userId: uid,
        amount: amt,
      }: {
        userId: string;
        amount: number;
        reason: string;
        description?: string;
        relatedId?: string;
      }) => {
        await txDb
          .update(actorState)
          .set({
            tradingBalance: sql`${actorState.tradingBalance} + ${amt}`,
            updatedAt: new Date(),
          })
          .where(eq(actorState.id, uid));
      },
      recordPnL: async (_args: {
        userId: string;
        pnl: number;
        reason: string;
        relatedId?: string;
      }) => {
        // NPCs don't track PnL
      },
      getBalance: async (uid: string) => {
        const [actor] = await txDb
          .select({ tradingBalance: actorState.tradingBalance })
          .from(actorState)
          .where(eq(actorState.id, uid))
          .limit(1);
        return {
          balance: Number(actor?.tradingBalance ?? 0),
          totalDeposited: 0,
          totalWithdrawn: 0,
          lifetimePnL: 0,
        };
      },
    };
  }

  return {
    debit: ({
      userId: uid,
      amount: amt,
      reason,
      description,
      relatedId,
    }: {
      userId: string;
      amount: number;
      reason: string;
      description?: string;
      relatedId?: string;
    }) =>
      WalletService.debit(uid, amt, reason, description ?? '', relatedId, txDb),
    credit: ({
      userId: uid,
      amount: amt,
      reason,
      description,
      relatedId,
    }: {
      userId: string;
      amount: number;
      reason: string;
      description?: string;
      relatedId?: string;
    }) =>
      WalletService.credit(
        uid,
        amt,
        reason,
        description ?? '',
        relatedId,
        txDb
      ),
    recordPnL: async ({
      userId: uid,
      pnl,
      reason,
      relatedId,
    }: {
      userId: string;
      pnl: number;
      reason: string;
      relatedId?: string;
    }) => {
      // Defer PnL recording to avoid nested transaction deadlocks
      // The PnL will be recorded after the transaction completes
      if (deferredPnL) {
        deferredPnL.push({ userId: uid, pnl, reason, relatedId });
      } else {
        // Fallback for callers that don't use deferredPnL (shouldn't happen in new code)
        await WalletService.recordPnL(uid, pnl, reason, relatedId);
      }
    },
    getBalance: (uid: string) => WalletService.getBalance(uid),
  };
}

// =============================================================================
// Types
// =============================================================================

export interface DirectTradeParams {
  agentUserId: string;
  marketType: 'prediction' | 'perp';
  marketId: string; // Market ID for prediction, ticker/name/id for perp
  side:
    | 'buy_yes'
    | 'buy_no'
    | 'sell_yes'
    | 'sell_no'
    | 'open_long'
    | 'open_short'
    | 'close_position';
  amount: number;
  reasoning?: string;
  /**
   * Skip resolving the perp ticker when the caller already passed the canonical ticker.
   * Useful for services that call resolvePerpTicker upstream.
   */
  skipPerpResolution?: boolean;
}

export interface DirectTradeResult {
  success: boolean;
  marketId?: string;
  ticker?: string;
  side?: string;
  shares?: number;
  error?: string;
}

export interface DirectPostParams {
  agentUserId: string;
  content: string;
}

export interface DirectPostResult {
  success: boolean;
  postId?: string;
  error?: string;
}

export interface DirectCommentParams {
  agentUserId: string;
  postId: string;
  content: string;
  parentCommentId?: string;
}

export interface DirectCommentResult {
  success: boolean;
  commentId?: string;
  error?: string;
}

export interface DirectMessageParams {
  agentUserId: string;
  chatId?: string;
  recipientId?: string;
  content: string;
}

export interface DirectMessageResult {
  success: boolean;
  messageId?: string;
  error?: string;
}

export interface DirectLikeParams {
  agentUserId: string;
  postId: string;
}

export interface DirectLikeResult {
  success: boolean;
  liked?: boolean;
  error?: string;
}

export interface DirectRepostParams {
  agentUserId: string;
  postId: string;
  comment?: string;
}

export interface DirectRepostResult {
  success: boolean;
  repostId?: string;
  quotePostId?: string;
  error?: string;
}

export interface DirectSendMoneyParams {
  agentUserId: string;
  recipientId: string;
  amount: number;
  reason?: string;
}

export interface DirectSendMoneyResult {
  success: boolean;
  transactionId?: string;
  newBalance?: number;
  error?: string;
}

export interface DirectFollowParams {
  agentUserId: string;
  targetUserId: string;
}

export interface DirectFollowResult {
  success: boolean;
  followed?: boolean;
  alreadyFollowing?: boolean;
  unfollowed?: boolean;
  wasFollowing?: boolean;
  targetUserId?: string;
  error?: string;
}

export interface DirectCreateGroupParams {
  agentUserId: string;
  name: string;
  description?: string;
  memberIds?: string[];
}

export interface DirectCreateGroupResult {
  success: boolean;
  groupId?: string;
  chatId?: string;
  error?: string;
}

export interface DirectInviteToGroupParams {
  agentUserId: string;
  groupId: string;
  targetUserId: string;
}

export interface DirectInviteToGroupResult {
  success: boolean;
  alreadyMember?: boolean;
  error?: string;
}

export interface DirectKickFromGroupParams {
  agentUserId: string;
  groupId: string;
  targetUserId: string;
  reason?: string;
}

export interface DirectKickFromGroupResult {
  success: boolean;
  error?: string;
}

export interface DirectLeaveGroupParams {
  agentUserId: string;
  groupId: string;
}

export interface DirectLeaveGroupResult {
  success: boolean;
  error?: string;
}

// =============================================================================
// Direct Trade Executor
// =============================================================================

/**
 * Execute a trade directly without LLM decision-making.
 * Validates balance for entry trades; exit trades (sell_yes/sell_no/close_position)
 * can close positions even when balance is $0.
 */
export async function executeDirectTrade(
  params: DirectTradeParams
): Promise<DirectTradeResult> {
  const { agentUserId, marketType, reasoning } = params;
  const marketId = params.marketId.trim();
  const side = params.side
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, '_');
  let { amount } = params;

  if (marketType !== 'prediction' && marketType !== 'perp') {
    return {
      success: false,
      error: `Invalid market type: ${marketType}`,
    };
  }

  if (!marketId) {
    return {
      success: false,
      error: 'Missing trade market identifier.',
    };
  }

  const validSides =
    marketType === 'prediction' ? PREDICTION_TRADE_SIDES : PERP_TRADE_SIDES;
  if (!validSides.has(side)) {
    return {
      success: false,
      error: `Invalid ${marketType} trade side: ${params.side}`,
    };
  }

  if (!Number.isFinite(amount)) {
    return {
      success: false,
      error: 'Invalid trade amount. Must be a finite number.',
    };
  }

  // Check if this is an NPC (system-defined actor from static data files).
  // User-created agents are NOT in StaticDataRegistry, so they won't match.
  // This ensures only system NPCs skip broadcasting - user agents always broadcast.
  const npcActor = StaticDataRegistry.getActor(agentUserId);
  const isNpc = !!npcActor;

  const isExitTrade =
    (marketType === 'prediction' &&
      (side === 'sell_yes' || side === 'sell_no')) ||
    (marketType === 'perp' && side === 'close_position');

  // Get current balance
  let balance = 0;
  if (isNpc) {
    const [actor] = await db
      .select({ tradingBalance: actorState.tradingBalance })
      .from(actorState)
      .where(eq(actorState.id, agentUserId))
      .limit(1);
    balance = Number(actor?.tradingBalance ?? 0);
  } else {
    const walletBalance = await WalletService.getBalance(agentUserId);
    balance = walletBalance.balance;
  }

  if (!isExitTrade) {
    const looksLikeShareCount =
      Number.isInteger(amount) &&
      amount >= 1 &&
      amount <= SHARE_LIKE_MAX_INTEGER &&
      balance > 0 &&
      amount / balance < SHARE_LIKE_RATIO_THRESHOLD;
    if (looksLikeShareCount) {
      logger.warn(
        `[DirectExecutor] Trade amount $${amount.toFixed(
          2
        )} looks like a share count relative to $${balance.toFixed(
          2
        )} balance. Expected Feed Points.`,
        { agentUserId, marketType, side, balance },
        'DirectExecutors'
      );
    }

    // Cannot trade more than balance
    if (amount > balance) {
      logger.warn(
        `[DirectExecutor] Trade capped to balance: $${amount} -> $${balance}`,
        { agentUserId, isNpc },
        'DirectExecutors'
      );
      amount = balance;
    }

    // Reject if insufficient funds
    if (amount < 1) {
      return {
        success: false,
        error: `Insufficient balance: $${balance.toFixed(2)} (minimum $1 required for entry trades). Do NOT retry entry trades — use social actions instead or SELL existing positions.`,
      };
    }
  } else if (amount < 0) {
    return {
      success: false,
      error: 'Amount must be 0 or greater for exit trades',
    };
  }

  // Get agent's managed by for recording (for USER_CONTROLLED agents)
  const agentManagedBy = agentUserId;

  logger.info(
    `[DirectExecutor] Executing ${marketType} trade: ${side} $${amount} on ${marketId}`,
    { agentUserId, isNpc, balance },
    'DirectExecutors'
  );

  if (marketType === 'prediction') {
    // Handle sell (close prediction position)
    if (side === 'sell_yes' || side === 'sell_no') {
      return executePredictionSell({
        agentUserId,
        marketId,
        side: side as 'sell_yes' | 'sell_no',
        amount,
        reasoning,
        isNpc,
        agentManagedBy,
      });
    }

    return executePredictionTrade({
      agentUserId,
      marketId,
      side: side as 'buy_yes' | 'buy_no',
      amount,
      reasoning,
      isNpc,
      agentManagedBy,
    });
  }

  const perpTicker = params.skipPerpResolution
    ? marketId
    : resolvePerpTicker(marketId)?.ticker;

  if (!perpTicker) {
    return { success: false, error: `Perp market not found: ${marketId}` };
  }

  // Handle close_position
  if (side === 'close_position') {
    return executeClosePerpPosition({
      agentUserId,
      ticker: perpTicker,
      reasoning,
      isNpc,
      agentManagedBy,
    });
  }

  return executePerpTrade({
    agentUserId,
    ticker: perpTicker,
    side: side as 'open_long' | 'open_short',
    amount,
    reasoning,
    isNpc,
    agentManagedBy,
  });
}

async function executePredictionTrade(params: {
  agentUserId: string;
  marketId: string;
  side: 'buy_yes' | 'buy_no';
  amount: number;
  reasoning?: string;
  isNpc: boolean;
  agentManagedBy: string;
}): Promise<DirectTradeResult> {
  const {
    agentUserId,
    marketId,
    side,
    amount,
    reasoning,
    isNpc,
    agentManagedBy,
  } = params;

  const isBuyYes = side === 'buy_yes';
  const sideLabel = isBuyYes ? 'yes' : 'no';

  const tradeOperation = async (
    txDb: Parameters<Parameters<typeof asUser>[1]>[0]
  ) => {
    const service = new PredictionMarketService({
      db: new PredictionDbAdapter(txDb),
      wallet: createPredictionWalletAdapter(isNpc, txDb),
      broadcast: {
        emit: (channel, payload) =>
          broadcastToChannel(channel, payload as Record<string, JsonValue>),
      },
      cache: { invalidate: () => invalidateAfterPredictionTrade(marketId) },
      fees: {
        tradingFeeRate: FEE_CONFIG.TRADING_FEE_RATE,
        platformShare: FEE_CONFIG.PLATFORM_SHARE,
        referrerShare: FEE_CONFIG.REFERRER_SHARE,
        minFeeAmount: FEE_CONFIG.MIN_FEE_AMOUNT,
      },
      tradeSource: isNpc ? 'npc_trade' : 'user_trade',
      tradeActorType: isNpc ? 'npc' : 'user',
      feeProcessor: isNpc
        ? undefined
        : {
            processTradingFee: ({
              userId,
              amount,
              type,
              relatedId,
              positionId,
            }) =>
              FeeService.processTradingFee(
                userId,
                type as (typeof FEE_CONFIG.FEE_TYPES)[keyof typeof FEE_CONFIG.FEE_TYPES],
                amount,
                positionId,
                relatedId,
                txDb // Pass the existing transaction to avoid nested transaction deadlocks
              ),
          },
    });

    return service.buy({
      userId: agentUserId,
      marketId,
      side: sideLabel,
      amount,
    });
  };

  const result = isNpc
    ? await asSystem(tradeOperation, 'npc_prediction_trade')
    : await asUser({ userId: agentUserId }, tradeOperation);

  // Record in AgentTrade
  await agentPnLService.recordTrade({
    agentId: agentUserId,
    userId: agentManagedBy,
    marketType: 'prediction',
    marketId,
    action: 'open',
    side: sideLabel,
    amount,
    price: result.avgPrice,
    reasoning,
  });

  const sharesRounded = Math.round(result.shares * 100) / 100;

  logger.info(
    `[DirectExecutor] Prediction trade executed: ${isBuyYes ? 'YES' : 'NO'} on market ${marketId}`,
    { shares: sharesRounded },
    'DirectExecutors'
  );

  return {
    success: true,
    marketId,
    side: isBuyYes ? 'YES' : 'NO',
    shares: sharesRounded,
  };
}

/**
 * Sell (close) a prediction market position
 */
async function executePredictionSell(params: {
  agentUserId: string;
  marketId: string;
  side: 'sell_yes' | 'sell_no';
  amount: number; // Amount in dollars to sell, or 0 for full position
  reasoning?: string;
  isNpc: boolean;
  agentManagedBy: string;
}): Promise<DirectTradeResult> {
  const {
    agentUserId,
    marketId,
    side,
    amount,
    reasoning,
    isNpc,
    agentManagedBy,
  } = params;

  const isSellYes = side === 'sell_yes';
  const sideLabel = isSellYes ? 'yes' : 'no';

  // Collect PnL records to process after transaction completes (avoids nested transaction deadlocks)
  const deferredPnL: DeferredPnLRecord[] = [];

  const sellOperation = async (
    txDb: Parameters<Parameters<typeof asUser>[1]>[0]
  ) => {
    const adapter = new PredictionDbAdapter(txDb);
    const service = new PredictionMarketService({
      db: adapter,
      wallet: createPredictionWalletAdapter(isNpc, txDb, deferredPnL),
      broadcast: {
        emit: (channel, payload) =>
          broadcastToChannel(channel, payload as Record<string, JsonValue>),
      },
      cache: { invalidate: () => invalidateAfterPredictionTrade(marketId) },
      fees: {
        tradingFeeRate: FEE_CONFIG.TRADING_FEE_RATE,
        platformShare: FEE_CONFIG.PLATFORM_SHARE,
        referrerShare: FEE_CONFIG.REFERRER_SHARE,
        minFeeAmount: FEE_CONFIG.MIN_FEE_AMOUNT,
      },
      tradeSource: isNpc ? 'npc_trade' : 'user_trade',
      tradeActorType: isNpc ? 'npc' : 'user',
      feeProcessor: isNpc
        ? undefined
        : {
            processTradingFee: ({
              userId,
              amount,
              type,
              relatedId,
              positionId,
            }) =>
              FeeService.processTradingFee(
                userId,
                type as (typeof FEE_CONFIG.FEE_TYPES)[keyof typeof FEE_CONFIG.FEE_TYPES],
                amount,
                positionId,
                relatedId,
                txDb // Pass the existing transaction to avoid nested transaction deadlocks
              ),
          },
    });

    const market = await service.getMarket(marketId);
    if (!market) {
      throw new Error(`Market not found: ${marketId}`);
    }

    const position = await adapter.getPosition(
      agentUserId,
      marketId,
      sideLabel
    );
    if (
      !position ||
      position.status === 'closed' ||
      position.shares <= MIN_SHARES_THRESHOLD
    ) {
      throw new Error(`No open position found for market ${marketId}`);
    }

    const currentPrice = PredictionPricing.getCurrentPrice(
      market.yesShares,
      market.noShares,
      sideLabel
    );
    const safePrice = currentPrice > 0 ? currentPrice : 1e-9;

    // If amount is 0, close full position. Otherwise, approximate shares by current probability.
    const sharesToSell =
      amount > 0
        ? Math.min(position.shares, amount / safePrice)
        : position.shares;

    if (sharesToSell <= MIN_SHARES_THRESHOLD) {
      throw new Error('Amount too small to sell any shares');
    }

    const sellResult = await service.sell({
      userId: agentUserId,
      marketId,
      shares: sharesToSell,
      positionId: position.id,
    });

    return { sellResult, sharesToSell };
  };

  const { sellResult, sharesToSell } = isNpc
    ? await asSystem(sellOperation, 'npc_prediction_sell')
    : await asUser({ userId: agentUserId }, sellOperation);

  // Process deferred PnL records AFTER transaction completes (avoids nested transaction deadlocks)
  for (const pnlRecord of deferredPnL) {
    if (pnlRecord.pnl === 0) continue;
    await WalletService.recordPnL(
      pnlRecord.userId,
      pnlRecord.pnl,
      pnlRecord.reason,
      pnlRecord.relatedId
    );
  }

  // Record in AgentTrade
  await agentPnLService.recordTrade({
    agentId: agentUserId,
    userId: agentManagedBy,
    marketType: 'prediction',
    marketId,
    action: 'close',
    side: sideLabel,
    amount: sellResult.netProceeds ?? 0,
    price: sellResult.avgPrice,
    pnl: sellResult.pnl,
    reasoning,
  });

  logger.info(
    `[DirectExecutor] Prediction sell executed: ${isSellYes ? 'YES' : 'NO'} on market ${marketId}`,
    { sharesSold: sharesToSell, remaining: sellResult.remainingShares },
    'DirectExecutors'
  );

  return {
    success: true,
    marketId,
    side: `sold_${isSellYes ? 'YES' : 'NO'}`,
    shares: sharesToSell,
  };
}

async function executePerpTrade(params: {
  agentUserId: string;
  ticker: string;
  side: 'open_long' | 'open_short';
  amount: number;
  reasoning?: string;
  isNpc: boolean;
  agentManagedBy: string;
}): Promise<DirectTradeResult> {
  const {
    agentUserId,
    ticker,
    side,
    amount,
    reasoning,
    isNpc,
    agentManagedBy,
  } = params;

  const perpSide = side === 'open_long' ? 'long' : 'short';

  // Get org for price (search through all orgs by ticker)
  const allOrgs = StaticDataRegistry.getAllOrganizations();
  const org = allOrgs.find((o) => o.ticker === ticker);
  const currentPrice = org?.initialPrice ?? 100;

  const perpTradeOperation = async () => {
    const walletAdapter = createPerpWalletAdapter(isNpc);

    const service = new PerpMarketService({
      db: new PerpDbAdapter(),
      wallet: walletAdapter,
      fees: {
        tradingFeeRate: 0.001,
        platformShare: 0.5,
        referrerShare: 0.5,
        minFeeAmount: 0.01,
      },
      priceImpact: createPerpPriceImpactPort(),
    });

    await service.openPosition({
      userId: agentUserId,
      ticker,
      side: perpSide,
      size: amount,
      leverage: 1,
    });
  };

  // Execute with appropriate context
  if (isNpc) {
    await asSystem(perpTradeOperation, 'npc_perp_trade');
  } else {
    await asUser({ userId: agentUserId }, perpTradeOperation);
  }

  // Record trade
  await agentPnLService.recordTrade({
    agentId: agentUserId,
    userId: agentManagedBy,
    marketType: 'perp',
    ticker,
    action: 'open',
    side: perpSide,
    amount,
    price: currentPrice,
    reasoning,
  });

  logger.info(
    `[DirectExecutor] Perp trade executed: ${perpSide} $${amount} on ${ticker}`,
    undefined,
    'DirectExecutors'
  );

  return {
    success: true,
    ticker,
    side: perpSide,
  };
}

/**
 * Close an existing perp position
 */
async function executeClosePerpPosition(params: {
  agentUserId: string;
  ticker: string;
  reasoning?: string;
  isNpc: boolean;
  agentManagedBy: string;
}): Promise<DirectTradeResult> {
  const { agentUserId, ticker, reasoning, isNpc, agentManagedBy } = params;

  // Find the open position for this ticker
  const [existingPosition] = await db
    .select()
    .from(perpPositions)
    .where(
      and(
        eq(perpPositions.userId, agentUserId),
        eq(perpPositions.ticker, ticker),
        isNull(perpPositions.closedAt)
      )
    )
    .limit(1);

  if (!existingPosition) {
    return {
      success: false,
      error: `No open position found for ${ticker}`,
    };
  }

  const closeOperation = async () => {
    const walletAdapter = createPerpWalletAdapter(isNpc);

    const service = new PerpMarketService({
      db: new PerpDbAdapter(),
      wallet: walletAdapter,
      fees: {
        tradingFeeRate: 0.001,
        platformShare: 0.5,
        referrerShare: 0.5,
        minFeeAmount: 0.01,
      },
      priceImpact: createPerpPriceImpactPort(),
    });

    // Capture the result from closePosition to get accurate realizedPnL
    const result = await service.closePosition({
      positionId: existingPosition.id,
      userId: agentUserId,
    });

    return result;
  };

  // Execute with appropriate context and capture the result
  const closeResult = isNpc
    ? await asSystem(closeOperation, 'npc_perp_close')
    : await asUser({ userId: agentUserId }, closeOperation);

  // Use the realized P&L from the service (computed with actual exit price)
  // This is more accurate than recalculating from potentially stale position data
  // closePosition() always returns these fields - validate at runtime for safety
  if (
    closeResult.realizedPnL == null ||
    closeResult.exitPrice == null ||
    closeResult.size == null
  ) {
    throw new Error(
      `[DirectExecutor] closePosition did not return expected fields: realizedPnL=${closeResult.realizedPnL}, exitPrice=${closeResult.exitPrice}, size=${closeResult.size}`
    );
  }
  const { realizedPnL, size, exitPrice } = closeResult;

  // Record trade
  await agentPnLService.recordTrade({
    agentId: agentUserId,
    userId: agentManagedBy,
    marketType: 'perp',
    ticker,
    action: 'close',
    side: existingPosition.side as 'long' | 'short',
    amount: size,
    price: exitPrice,
    pnl: realizedPnL,
    reasoning,
  });

  logger.info(
    `[DirectExecutor] Perp position closed: ${existingPosition.side} $${size} on ${ticker} (P&L: ${realizedPnL >= 0 ? '+' : ''}$${realizedPnL.toFixed(2)})`,
    undefined,
    'DirectExecutors'
  );

  return {
    success: true,
    ticker,
    side: `closed_${existingPosition.side}`,
  };
}

// =============================================================================
// Direct Post Executor
// =============================================================================

/**
 * Create a post directly without LLM decision-making.
 * Validates content for diversity before creating.
 */
export async function executeDirectPost(
  params: DirectPostParams
): Promise<DirectPostResult> {
  const { agentUserId, content } = params;

  if (!content || content.trim().length < 5) {
    return { success: false, error: 'Content too short' };
  }

  const cleanContent = content.trim();

  // DIVERSITY CHECK: Validate content before creating post (per-agent, in-process)
  const diversityIssues = topicDiversityService.validateContent(
    agentUserId,
    cleanContent
  );

  if (diversityIssues.length > 0) {
    logger.warn(
      `[DirectExecutor] Post rejected for diversity issues`,
      {
        agentUserId,
        issues: diversityIssues,
        contentPreview: cleanContent.substring(0, 100),
      },
      'DirectExecutors'
    );

    return {
      success: false,
      error: `Content rejected: ${diversityIssues[0]}`,
    };
  }

  // CROSS-NPC DEDUP CHECK (NPC actors only):
  // Query the last 20 NPC posts in the past 10 minutes and reject if any other
  // NPC posted sufficiently similar content. This closes the gap left by the
  // per-agent in-process TopicDiversityService singleton.
  // Only applies to NPC actors — user autonomous agents are NOT subject to this
  // cross-agent check to avoid blocking them based on unrelated user posts.
  const isNpcForDedup = !!StaticDataRegistry.getActor(agentUserId);
  if (isNpcForDedup) {
    const allNpcIds = StaticDataRegistry.getAllActors()
      .map((a) => a.id)
      .filter((id) => id !== agentUserId);

    if (allNpcIds.length > 0) {
      const crossNpcWindow = new Date(Date.now() - 10 * 60 * 1000);
      const recentNpcPosts = await db
        .select({ content: posts.content })
        .from(posts)
        .where(
          and(
            gte(posts.timestamp, crossNpcWindow),
            isNull(posts.deletedAt),
            isNull(posts.commentOnPostId),
            inArray(posts.authorId, allNpcIds)
          )
        )
        .orderBy(desc(posts.timestamp))
        .limit(20);

      for (const recent of recentNpcPosts) {
        const sim = topicDiversityService.calculateSimilarity(
          cleanContent,
          recent.content
        );
        if (sim >= 0.5) {
          logger.warn(
            `[DirectExecutor] Post rejected — cross-NPC similarity ${(sim * 100).toFixed(0)}%`,
            { agentUserId, contentPreview: cleanContent.substring(0, 80) },
            'DirectExecutors'
          );
          return {
            success: false,
            error: 'Content too similar to a recent post by another NPC',
          };
        }
      }
    }
  }

  // Check if this is an NPC (system-defined actor from static data files).
  // User-created agents are NOT in StaticDataRegistry, so they won't match.
  const npcActor = StaticDataRegistry.getActor(agentUserId);
  const isNpc = !!npcActor;

  logger.info(
    `[DirectExecutor] Creating post for ${isNpc ? 'NPC' : 'user'} ${agentUserId}`,
    { contentPreview: cleanContent.substring(0, 50) },
    'DirectExecutors'
  );

  // Create the post
  const postId = await generateSnowflakeId();
  const now = new Date();

  await db.insert(posts).values({
    id: postId,
    content: cleanContent,
    authorId: agentUserId,
    timestamp: now,
    createdAt: now,
  });

  // Record topic coverage for future diversity checks
  topicDiversityService.recordTopicCoverage(agentUserId, cleanContent);

  // Generate and store tags
  const tags: GeneratedTag[] = await generateTagsFromPost(cleanContent);
  if (tags.length > 0) {
    await storeTagsForPost(postId, tags);
  }

  logger.info(
    `[DirectExecutor] Post created: ${postId}`,
    { tags: tags.length },
    'DirectExecutors'
  );

  // Broadcast activity for real-time UI updates (only for non-NPCs)
  if (!isNpc) {
    const agentName = await getAgentDisplayName(agentUserId);
    const activityData: PostActivityData = {
      postId,
      contentPreview: cleanContent.substring(0, 200),
    };

    broadcastAgentActivity(agentUserId, agentName, 'post', activityData).catch(
      (error: Error) => {
        logger.warn(
          `Failed to broadcast post activity: ${error.message}`,
          { agentUserId, postId },
          'DirectExecutors'
        );
      }
    );
  }

  return {
    success: true,
    postId,
  };
}

// =============================================================================
// Direct Comment Executor
// =============================================================================

/**
 * Create a comment directly without LLM decision-making.
 * Includes deduplication check to prevent agents from:
 * - Making multiple top-level comments on the same post
 * - Making multiple replies to the same parent comment
 */
export async function executeDirectComment(
  params: DirectCommentParams
): Promise<DirectCommentResult> {
  const { agentUserId, postId, content, parentCommentId } = params;

  if (!content || content.trim().length < 3) {
    return { success: false, error: 'Content too short' };
  }

  const cleanContent = content.trim();

  // Verify post exists
  const [post] = await db
    .select({ id: posts.id })
    .from(posts)
    .where(eq(posts.id, postId))
    .limit(1);

  if (!post) {
    return { success: false, error: `Post not found: ${postId}` };
  }

  // DEDUPLICATION CHECK: Prevent duplicate comments
  if (parentCommentId) {
    // Replying to a specific comment - check if agent already replied to this comment
    const [existingReply] = await db
      .select({ id: comments.id })
      .from(comments)
      .where(
        and(
          eq(comments.postId, postId),
          eq(comments.authorId, agentUserId),
          eq(comments.parentCommentId, parentCommentId)
        )
      )
      .limit(1);

    if (existingReply) {
      logger.info(
        `[DirectExecutor] Agent already replied to comment ${parentCommentId} - skipping duplicate`,
        { agentUserId, postId, existingReplyId: existingReply.id },
        'DirectExecutors'
      );
      return {
        success: false,
        error: `Already replied to this comment`,
      };
    }

    // Verify parent comment exists
    const [parentComment] = await db
      .select({ id: comments.id })
      .from(comments)
      .where(eq(comments.id, parentCommentId))
      .limit(1);

    if (!parentComment) {
      return {
        success: false,
        error: `Parent comment not found: ${parentCommentId}`,
      };
    }
  } else {
    // Top-level comment - check if agent already commented on this post
    const [existingComment] = await db
      .select({ id: comments.id })
      .from(comments)
      .where(
        and(
          eq(comments.postId, postId),
          eq(comments.authorId, agentUserId),
          isNull(comments.parentCommentId)
        )
      )
      .limit(1);

    if (existingComment) {
      logger.info(
        `[DirectExecutor] Agent already made top-level comment on post ${postId} - skipping duplicate`,
        { agentUserId, existingCommentId: existingComment.id },
        'DirectExecutors'
      );
      return {
        success: false,
        error: `Already commented on this post`,
      };
    }
  }

  logger.info(
    `[DirectExecutor] Creating comment on post ${postId}`,
    { parentCommentId, contentPreview: cleanContent.substring(0, 50) },
    'DirectExecutors'
  );

  const commentId = await generateSnowflakeId();
  const now = new Date();

  await db.insert(comments).values({
    id: commentId,
    content: cleanContent,
    postId,
    authorId: agentUserId,
    parentCommentId: parentCommentId ?? null,
    createdAt: now,
    updatedAt: now,
  });

  logger.info(
    `[DirectExecutor] Comment created: ${commentId}`,
    undefined,
    'DirectExecutors'
  );

  // Broadcast activity for real-time UI updates (only for non-NPCs)
  const isNpc = !!StaticDataRegistry.getActor(agentUserId);
  if (!isNpc) {
    const agentName = await getAgentDisplayName(agentUserId);
    const activityData: CommentActivityData = {
      commentId,
      postId,
      contentPreview: cleanContent.substring(0, 200),
      parentCommentId: parentCommentId ?? null,
    };

    broadcastAgentActivity(
      agentUserId,
      agentName,
      'comment',
      activityData
    ).catch((error: Error) => {
      logger.warn(
        `Failed to broadcast comment activity: ${error.message}`,
        { agentUserId, commentId },
        'DirectExecutors'
      );
    });
  }

  return {
    success: true,
    commentId,
  };
}

// =============================================================================
// Direct Message Executor
// =============================================================================

/**
 * Strip `<think>...</think>` reasoning blocks from content.
 * Removes paired blocks first, then any orphan tags.
 * Returns empty string if only reasoning was present.
 */
function stripThinkTags(text: string): string {
  // Remove paired <think>...</think> blocks
  const withoutBlocks = text.replace(/<think>[\s\S]*?<\/think>/gi, '');
  // Also strip orphan tags (unclosed/unmatched)
  return withoutBlocks.replace(/<\/?think>/gi, '').trim();
}

export async function executeDirectMessage(
  params: DirectMessageParams
): Promise<DirectMessageResult> {
  const { agentUserId, chatId: providedChatId, recipientId, content } = params;

  // Strip think tags and clean content
  const cleanContent = stripThinkTags(content?.trim() ?? '');
  if (cleanContent.length < 3) {
    return {
      success: false,
      error: 'Content too short or only contained thinking',
    };
  }
  let chatId = providedChatId;

  // If chatId not provided, resolve it from recipientId
  if (!chatId && recipientId) {
    // Check if agent is trying to DM their owner - not allowed
    // Agents should communicate with owners through Agents (team chat)
    const [agent] = await db
      .select({ managedBy: users.managedBy })
      .from(users)
      .where(eq(users.id, agentUserId))
      .limit(1);

    if (agent?.managedBy === recipientId) {
      return {
        success: false,
        error: 'Agent-owner DMs are not allowed - use Agents chat instead',
      };
    }

    // Check if recipient exists
    const [recipient] = await db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.id, recipientId))
      .limit(1);

    if (!recipient) {
      // Try searching actorState for NPCs
      const [npc] = await db
        .select({ id: actorState.id })
        .from(actorState)
        .where(eq(actorState.id, recipientId))
        .limit(1);

      if (!npc) {
        return { success: false, error: `Recipient not found: ${recipientId}` };
      }
    }

    // Find existing DM chat using a single query with self-join
    // Join chatParticipants (for agent) -> chats -> chatParticipants alias (for recipient)
    const recipientParticipants = aliasedTable(chatParticipants, 'cp2');

    const existingChat = await db
      .select({ chatId: chatParticipants.chatId })
      .from(chatParticipants)
      .innerJoin(chats, eq(chatParticipants.chatId, chats.id))
      .innerJoin(
        recipientParticipants,
        eq(chatParticipants.chatId, recipientParticipants.chatId)
      )
      .where(
        and(
          eq(chatParticipants.userId, agentUserId),
          eq(chats.isGroup, false),
          eq(recipientParticipants.userId, recipientId)
        )
      )
      .limit(1);

    if (existingChat.length > 0 && existingChat[0]) {
      chatId = existingChat[0].chatId;
    }

    // If still no chatId, create new DM
    if (!chatId) {
      chatId = await generateSnowflakeId();
      const now = new Date();

      try {
        await db.transaction(async (tx) => {
          await tx.insert(chats).values({
            id: chatId!,
            isGroup: false,
            createdAt: now,
            updatedAt: now,
          });

          // Add both participants
          await tx.insert(chatParticipants).values([
            {
              id: await generateSnowflakeId(),
              chatId: chatId!,
              userId: agentUserId,
              joinedAt: now,
              isActive: true,
            },
            {
              id: await generateSnowflakeId(),
              chatId: chatId!,
              userId: recipientId,
              joinedAt: now,
              isActive: true,
            },
          ]);

          // Create DMAcceptance record with 'accepted' status
          // Agent-initiated DMs bypass the acceptance flow since agents are automated
          await tx.insert(dmAcceptances).values({
            id: await generateSnowflakeId(),
            chatId: chatId!,
            userId: recipientId, // The recipient
            otherUserId: agentUserId, // The agent initiating
            status: 'accepted', // Auto-accepted for agent-initiated DMs
            createdAt: now,
            acceptedAt: now, // Mark as accepted immediately
          });
        });

        logger.info(
          `[DirectExecutor] Created new DM chat ${chatId} between ${agentUserId} and ${recipientId}`,
          undefined,
          'DirectExecutors'
        );
      } catch (error) {
        // Handle race condition - if chat was created by another process, try to find it
        if (error instanceof Error && error.message.includes('duplicate key')) {
          logger.warn(
            `[DirectExecutor] Race condition detected, retrying chat lookup`,
            { agentUserId, recipientId },
            'DirectExecutors'
          );
          // Retry with the same optimized single query
          const retryRecipientParticipants = aliasedTable(
            chatParticipants,
            'cp2_retry'
          );

          const retryMatch = await db
            .select({ chatId: chatParticipants.chatId })
            .from(chatParticipants)
            .innerJoin(chats, eq(chatParticipants.chatId, chats.id))
            .innerJoin(
              retryRecipientParticipants,
              eq(chatParticipants.chatId, retryRecipientParticipants.chatId)
            )
            .where(
              and(
                eq(chatParticipants.userId, agentUserId),
                eq(chats.isGroup, false),
                eq(retryRecipientParticipants.userId, recipientId)
              )
            )
            .limit(1);

          if (retryMatch.length > 0 && retryMatch[0]) {
            chatId = retryMatch[0].chatId;
          } else {
            throw error; // Re-throw if we still can't find the chat
          }
        } else {
          throw error;
        }
      }
    }
  }

  if (!chatId) {
    return {
      success: false,
      error: 'Chat ID required or could not be resolved',
    };
  }

  // Verify chat exists (if provided directly)
  if (providedChatId) {
    const [chat] = await db
      .select({ id: chats.id })
      .from(chats)
      .where(eq(chats.id, chatId))
      .limit(1);

    if (!chat) {
      return { success: false, error: `Chat not found: ${chatId}` };
    }
  }

  logger.info(
    `[DirectExecutor] Creating message in chat ${chatId}`,
    { contentPreview: cleanContent.substring(0, 50) },
    'DirectExecutors'
  );

  const messageId = await generateSnowflakeId();
  const now = new Date();

  await db.insert(messages).values({
    id: messageId,
    chatId,
    senderId: agentUserId,
    content: cleanContent,
    createdAt: now,
  });

  logger.info(
    `[DirectExecutor] Message created: ${messageId}`,
    undefined,
    'DirectExecutors'
  );

  // Broadcast to chat channel for real-time message updates
  // This ensures all chat participants see the message immediately
  broadcastChatMessage(chatId, {
    id: messageId,
    content: cleanContent,
    chatId,
    senderId: agentUserId,
    type: 'user',
    createdAt: now.toISOString(),
    isGameChat: false,
    isDMChat: Boolean(recipientId),
  }).catch((error: Error) => {
    logger.warn(
      `Failed to broadcast chat message: ${error.message}`,
      { chatId, messageId },
      'DirectExecutors'
    );
  });

  // Broadcast activity for real-time UI updates (only for non-NPCs)
  const isNpc = !!StaticDataRegistry.getActor(agentUserId);
  if (!isNpc) {
    const agentName = await getAgentDisplayName(agentUserId);
    const activityData: MessageActivityData = {
      messageId,
      chatId,
      recipientId: recipientId ?? null,
      contentPreview: cleanContent.substring(0, 200),
    };

    broadcastAgentActivity(
      agentUserId,
      agentName,
      'message',
      activityData
    ).catch((error: Error) => {
      logger.warn(
        `Failed to broadcast message activity: ${error.message}`,
        { agentUserId, messageId },
        'DirectExecutors'
      );
    });
  }

  // Notify group chat members for offline/push notifications
  // Only for group messages (no recipientId means it's a group chat message)
  if (!recipientId && chatId) {
    const participantRows = await db
      .select({ userId: chatParticipants.userId })
      .from(chatParticipants)
      .where(eq(chatParticipants.chatId, chatId));
    const recipientIds = participantRows
      .map((p) => p.userId)
      .filter((id) => id !== agentUserId);

    if (recipientIds.length > 0) {
      const [chatRecord] = await db
        .select({ name: chats.name })
        .from(chats)
        .where(eq(chats.id, chatId))
        .limit(1);

      notifyGroupChatMessage(
        recipientIds,
        agentUserId,
        chatId,
        chatRecord?.name ?? 'Group Chat',
        cleanContent.substring(0, 50)
      ).catch((error: Error) => {
        logger.warn(
          `Failed to notify group chat message: ${error.message}`,
          { chatId, messageId },
          'DirectExecutors'
        );
      });
    }
  }

  return {
    success: true,
    messageId,
  };
}

// =============================================================================
// Direct Follow / Unfollow Executors
// =============================================================================

/**
 * Follow a user/agent directly without LLM decision-making.
 * This action is restricted to real users/agents (not static NPC actors).
 */
export async function executeDirectFollow(
  params: DirectFollowParams
): Promise<DirectFollowResult> {
  const { agentUserId, targetUserId } = params;
  const cleanTargetUserId = targetUserId?.trim();

  if (!cleanTargetUserId) {
    return { success: false, error: 'Target user ID is required' };
  }

  if (cleanTargetUserId === agentUserId) {
    return { success: false, error: 'Cannot follow yourself' };
  }

  const [targetUser] = await db
    .select({ id: users.id, isActor: users.isActor })
    .from(users)
    .where(eq(users.id, cleanTargetUserId))
    .limit(1);

  if (!targetUser) {
    return { success: false, error: `User not found: ${cleanTargetUserId}` };
  }

  if (targetUser.isActor) {
    return {
      success: false,
      error:
        'FOLLOW supports users/agents only. NPC actors are not supported here',
    };
  }

  logger.info(
    `[DirectExecutor] Following user ${cleanTargetUserId}`,
    { agentUserId },
    'DirectExecutors'
  );

  const followId = await generateSnowflakeId();
  const insertResult = await db
    .insert(follows)
    .values({
      id: followId,
      followerId: agentUserId,
      followingId: cleanTargetUserId,
    })
    .onConflictDoNothing()
    .returning({ id: follows.id });

  const followed = insertResult.length > 0;

  if (followed) {
    await Promise.all([
      cachedDb.invalidateUserCache(agentUserId),
      cachedDb.invalidateUserCache(cleanTargetUserId),
    ]).catch((error: unknown) => {
      logger.warn('Failed to invalidate user cache after direct follow', {
        error,
      });
    });
  }

  return {
    success: true,
    followed,
    alreadyFollowing: !followed,
    targetUserId: cleanTargetUserId,
  };
}

/**
 * Unfollow a user/agent directly without LLM decision-making.
 * Returns success even if there was no active follow relationship (idempotent).
 */
export async function executeDirectUnfollow(
  params: DirectFollowParams
): Promise<DirectFollowResult> {
  const { agentUserId, targetUserId } = params;
  const cleanTargetUserId = targetUserId?.trim();

  if (!cleanTargetUserId) {
    return { success: false, error: 'Target user ID is required' };
  }

  if (cleanTargetUserId === agentUserId) {
    return { success: false, error: 'Cannot unfollow yourself' };
  }

  const [targetUser] = await db
    .select({ id: users.id, isActor: users.isActor })
    .from(users)
    .where(eq(users.id, cleanTargetUserId))
    .limit(1);

  if (!targetUser) {
    return { success: false, error: `User not found: ${cleanTargetUserId}` };
  }

  if (targetUser.isActor) {
    return {
      success: false,
      error:
        'UNFOLLOW supports users/agents only. NPC actors are not supported here',
    };
  }

  logger.info(
    `[DirectExecutor] Unfollowing user ${cleanTargetUserId}`,
    { agentUserId },
    'DirectExecutors'
  );

  const deletedRows = await db
    .delete(follows)
    .where(
      and(
        eq(follows.followerId, agentUserId),
        eq(follows.followingId, cleanTargetUserId)
      )
    )
    .returning({ id: follows.id });

  const wasFollowing = deletedRows.length > 0;

  if (wasFollowing) {
    await Promise.all([
      cachedDb.invalidateUserCache(agentUserId),
      cachedDb.invalidateUserCache(cleanTargetUserId),
    ]).catch((error: unknown) => {
      logger.warn('Failed to invalidate user cache after direct unfollow', {
        error,
      });
    });
  }

  return {
    success: true,
    unfollowed: wasFollowing,
    wasFollowing,
    targetUserId: cleanTargetUserId,
  };
}

// =============================================================================
// Direct Like Executor
// =============================================================================

/**
 * Like a post directly without LLM decision-making.
 * Includes deduplication to prevent double-liking.
 */
export async function executeDirectLike(
  params: DirectLikeParams
): Promise<DirectLikeResult> {
  const { agentUserId, postId } = params;

  // Verify post exists
  const [post] = await db
    .select({ id: posts.id })
    .from(posts)
    .where(eq(posts.id, postId))
    .limit(1);

  if (!post) {
    return { success: false, error: `Post not found: ${postId}` };
  }

  logger.info(
    `[DirectExecutor] Liking post ${postId}`,
    { agentUserId },
    'DirectExecutors'
  );

  const reactionId = await generateSnowflakeId();

  // Use onConflictDoNothing to handle race conditions and prevent duplicate likes atomically
  // This relies on a unique index on (userId, postId, type) for the reactions table
  // No pre-check needed - the insert handles duplicates automatically
  const insertResult = await db
    .insert(reactions)
    .values({
      id: reactionId,
      postId,
      userId: agentUserId,
      type: 'like',
      createdAt: new Date(),
    })
    .onConflictDoNothing()
    .returning({ id: reactions.id });

  // Determine if a new row was created or it already existed
  const alreadyLiked = insertResult.length === 0;
  logger.info(
    `[DirectExecutor] Post ${alreadyLiked ? 'already liked' : 'liked'}: ${postId}`,
    { agentUserId, alreadyLiked },
    'DirectExecutors'
  );

  return {
    success: true,
    liked: !alreadyLiked,
  };
}

// =============================================================================
// Direct Repost Executor
// =============================================================================

/**
 * Repost/share a post directly without LLM decision-making.
 * Creates a share record and optionally a quote post.
 */
export async function executeDirectRepost(
  params: DirectRepostParams
): Promise<DirectRepostResult> {
  const { agentUserId, postId, comment } = params;

  // Verify post exists
  const [post] = await db
    .select({
      id: posts.id,
      authorId: posts.authorId,
      content: posts.content,
      originalPostId: posts.originalPostId,
    })
    .from(posts)
    .where(eq(posts.id, postId))
    .limit(1);

  if (!post) {
    return { success: false, error: `Post not found: ${postId}` };
  }

  let targetPost = post;
  let targetPostId = postId;

  if (isPureRepost(post)) {
    const [resolvedPost] = await db
      .select({
        id: posts.id,
        authorId: posts.authorId,
        content: posts.content,
        originalPostId: posts.originalPostId,
      })
      .from(posts)
      .where(eq(posts.id, post.originalPostId))
      .limit(1);

    if (!resolvedPost) {
      return {
        success: false,
        error: 'Original post no longer exists',
      };
    }

    targetPost = resolvedPost;
    targetPostId = resolvedPost.id;
  }

  // Don't let agents repost their own content
  if (targetPost.authorId === agentUserId) {
    return { success: false, error: 'Cannot repost own content' };
  }

  // Note: We rely on the transaction's unique constraint handling to detect duplicates.
  // The pre-check was removed to avoid TOCTOU race conditions.

  logger.info(
    `[DirectExecutor] Reposting post ${targetPostId}`,
    { agentUserId, hasComment: !!comment, requestedPostId: postId },
    'DirectExecutors'
  );

  const now = new Date();

  try {
    // Pre-generate IDs before transaction
    const shareId = await generateSnowflakeId();
    const hasQuote = comment && comment.trim().length >= 3;
    const quotePostId = hasQuote ? await generateSnowflakeId() : undefined;

    // Use transaction to ensure atomicity of share and quote post
    await db.transaction(async (tx) => {
      // Create share record
      await tx.insert(shares).values({
        id: shareId,
        userId: agentUserId,
        postId: targetPostId,
        createdAt: now,
      });

      // If there's a quote comment, create a quote post (min 3 chars like comments)
      if (hasQuote && quotePostId) {
        await tx.insert(posts).values({
          id: quotePostId,
          content: comment!.trim(),
          authorId: agentUserId,
          originalPostId: targetPostId,
          type: 'repost',
          timestamp: now,
          createdAt: now,
        });
      }
    });

    logger.info(
      `[DirectExecutor] Post reposted: ${targetPostId} -> share ${shareId}${quotePostId ? ` with quote ${quotePostId}` : ''}`,
      undefined,
      'DirectExecutors'
    );

    return {
      success: true,
      repostId: shareId,
      quotePostId,
    };
  } catch (error) {
    // Handle unique constraint violation (concurrent repost)
    // Check error code for PostgreSQL (23505) or Prisma (P2002)
    const errorCode = (error as { code?: string }).code;
    const isUniqueConstraint =
      errorCode === '23505' ||
      errorCode === 'P2002' ||
      (error as Error).message?.includes('unique constraint');

    if (isUniqueConstraint) {
      const [share] = await db
        .select({ id: shares.id })
        .from(shares)
        .where(
          and(eq(shares.postId, targetPostId), eq(shares.userId, agentUserId))
        )
        .limit(1);

      if (!share?.id) {
        throw new Error(
          'Share not found after unique constraint violation - concurrent repost race condition'
        );
      }

      return { success: true, repostId: share.id };
    }
    throw error;
  }
}

// =============================================================================
// Direct Create Group Executor
// =============================================================================

/**
 * Create a new agent-owned group chat with optional initial members.
 */
export async function executeDirectCreateGroup(
  params: DirectCreateGroupParams
): Promise<DirectCreateGroupResult> {
  const { agentUserId, name, description, memberIds } = params;

  const cleanName = name?.trim();
  if (!cleanName || cleanName.length < 2) {
    return {
      success: false,
      error: 'Group name must be at least 2 characters',
    };
  }

  if (cleanName.length > 100) {
    return {
      success: false,
      error: 'Group name must be 100 characters or less',
    };
  }

  // Validate member IDs exist (if provided)
  const validMemberIds: string[] = [];
  if (memberIds && memberIds.length > 0) {
    const uniqueIds = [
      ...new Set(memberIds.filter((id) => id !== agentUserId)),
    ];
    if (uniqueIds.length > 0) {
      const existingUsers = await db
        .select({ id: users.id })
        .from(users)
        .where(sql`${users.id} IN ${uniqueIds}`);
      const existingIds = new Set(existingUsers.map((u) => u.id));
      for (const id of uniqueIds) {
        if (existingIds.has(id)) validMemberIds.push(id);
      }
    }
  }

  const groupId = await generateSnowflakeId();
  const chatId = await generateSnowflakeId();
  const now = new Date();

  await db.transaction(async (tx) => {
    // Create the group
    await tx.insert(groups).values({
      id: groupId,
      name: cleanName,
      description: description?.trim() || null,
      type: 'agent',
      ownerId: agentUserId,
      createdById: agentUserId,
      createdAt: now,
      updatedAt: now,
    });

    // Create the chat linked to the group
    await tx.insert(chats).values({
      id: chatId,
      name: cleanName,
      isGroup: true,
      groupId,
      createdAt: now,
      updatedAt: now,
    });

    // Add the agent as owner member
    await tx.insert(groupMembers).values({
      id: await generateSnowflakeId(),
      groupId,
      userId: agentUserId,
      role: 'owner',
      joinedAt: now,
      isActive: true,
    });

    // Add the agent as chat participant
    await tx.insert(chatParticipants).values({
      id: await generateSnowflakeId(),
      chatId,
      userId: agentUserId,
      joinedAt: now,
      isActive: true,
    });

    // Add initial members
    for (const memberId of validMemberIds) {
      await tx.insert(groupMembers).values({
        id: await generateSnowflakeId(),
        groupId,
        userId: memberId,
        role: 'member',
        joinedAt: now,
        addedBy: agentUserId,
        isActive: true,
      });

      await tx.insert(chatParticipants).values({
        id: await generateSnowflakeId(),
        chatId,
        userId: memberId,
        joinedAt: now,
        isActive: true,
      });
    }
  });

  logger.info(
    `[DirectExecutor] Created group "${cleanName}" with ${validMemberIds.length} initial members`,
    { agentUserId, groupId, chatId },
    'DirectExecutors'
  );

  return { success: true, groupId, chatId };
}

// =============================================================================
// Direct Invite To Group Executor
// =============================================================================

/**
 * Invite a user to a group the agent owns or admins.
 * Adds them directly (no acceptance flow for agent-initiated invites).
 */
export async function executeDirectInviteToGroup(
  params: DirectInviteToGroupParams
): Promise<DirectInviteToGroupResult> {
  const { agentUserId, groupId, targetUserId } = params;

  const cleanGroupId = groupId?.trim();
  const cleanTargetId = targetUserId?.trim();

  if (!cleanGroupId) {
    return { success: false, error: 'Group ID is required' };
  }
  if (!cleanTargetId) {
    return { success: false, error: 'Target user ID is required' };
  }
  if (cleanTargetId === agentUserId) {
    return { success: false, error: 'Cannot invite yourself' };
  }

  // Verify group exists and agent has permission (owner or admin)
  const [membership] = await db
    .select({ role: groupMembers.role })
    .from(groupMembers)
    .where(
      and(
        eq(groupMembers.groupId, cleanGroupId),
        eq(groupMembers.userId, agentUserId),
        eq(groupMembers.isActive, true)
      )
    )
    .limit(1);

  if (!membership) {
    return { success: false, error: 'You are not a member of this group' };
  }

  if (membership.role !== 'owner' && membership.role !== 'admin') {
    return {
      success: false,
      error: 'Only group owners and admins can invite members',
    };
  }

  // Verify target user exists
  const [targetUser] = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.id, cleanTargetId))
    .limit(1);

  if (!targetUser) {
    return { success: false, error: `User not found: ${cleanTargetId}` };
  }

  // Check if already a member (use upsert to handle race conditions)
  const [existing] = await db
    .select({ isActive: groupMembers.isActive })
    .from(groupMembers)
    .where(
      and(
        eq(groupMembers.groupId, cleanGroupId),
        eq(groupMembers.userId, cleanTargetId)
      )
    )
    .limit(1);

  if (existing?.isActive) {
    return { success: true, alreadyMember: true };
  }

  // Find the chat linked to this group
  const [chat] = await db
    .select({ id: chats.id })
    .from(chats)
    .where(eq(chats.groupId, cleanGroupId))
    .limit(1);

  if (!chat) {
    return { success: false, error: 'Group chat not found' };
  }

  const now = new Date();

  if (existing) {
    // Reactivate previously kicked/left member
    await db
      .update(groupMembers)
      .set({
        isActive: true,
        role: 'member',
        joinedAt: now,
        addedBy: agentUserId,
        kickedAt: null,
        kickReason: null,
      })
      .where(
        and(
          eq(groupMembers.groupId, cleanGroupId),
          eq(groupMembers.userId, cleanTargetId)
        )
      );
  } else {
    await db.insert(groupMembers).values({
      id: await generateSnowflakeId(),
      groupId: cleanGroupId,
      userId: cleanTargetId,
      role: 'member',
      joinedAt: now,
      addedBy: agentUserId,
      isActive: true,
    });
  }

  // Add as chat participant (idempotent)
  await db
    .insert(chatParticipants)
    .values({
      id: await generateSnowflakeId(),
      chatId: chat.id,
      userId: cleanTargetId,
      joinedAt: now,
      isActive: true,
    })
    .onConflictDoUpdate({
      target: [chatParticipants.chatId, chatParticipants.userId],
      set: {
        isActive: true,
        joinedAt: now,
      },
    });

  logger.info(
    `[DirectExecutor] Invited ${cleanTargetId} to group ${cleanGroupId}`,
    { agentUserId },
    'DirectExecutors'
  );

  return { success: true, alreadyMember: false };
}

// =============================================================================
// Direct Kick From Group Executor
// =============================================================================

/**
 * Kick a member from a group. Requires owner or admin role.
 * Cannot kick the group owner.
 */
export async function executeDirectKickFromGroup(
  params: DirectKickFromGroupParams
): Promise<DirectKickFromGroupResult> {
  const { agentUserId, groupId, targetUserId, reason } = params;

  const cleanGroupId = groupId?.trim();
  const cleanTargetId = targetUserId?.trim();

  if (!cleanGroupId) {
    return { success: false, error: 'Group ID is required' };
  }
  if (!cleanTargetId) {
    return { success: false, error: 'Target user ID is required' };
  }
  if (cleanTargetId === agentUserId) {
    return {
      success: false,
      error: 'Cannot kick yourself - use LEAVE_GROUP instead',
    };
  }

  // Verify agent has permission
  const [agentMembership] = await db
    .select({ role: groupMembers.role })
    .from(groupMembers)
    .where(
      and(
        eq(groupMembers.groupId, cleanGroupId),
        eq(groupMembers.userId, agentUserId),
        eq(groupMembers.isActive, true)
      )
    )
    .limit(1);

  if (!agentMembership) {
    return { success: false, error: 'You are not a member of this group' };
  }

  if (agentMembership.role !== 'owner' && agentMembership.role !== 'admin') {
    return {
      success: false,
      error: 'Only group owners and admins can kick members',
    };
  }

  // Verify target is an active member and not the owner
  const [targetMembership] = await db
    .select({ role: groupMembers.role, isActive: groupMembers.isActive })
    .from(groupMembers)
    .where(
      and(
        eq(groupMembers.groupId, cleanGroupId),
        eq(groupMembers.userId, cleanTargetId)
      )
    )
    .limit(1);

  if (!targetMembership || !targetMembership.isActive) {
    return {
      success: false,
      error: 'User is not an active member of this group',
    };
  }

  if (targetMembership.role === 'owner') {
    return { success: false, error: 'Cannot kick the group owner' };
  }

  // Admins cannot kick other admins (only owners can)
  if (targetMembership.role === 'admin' && agentMembership.role !== 'owner') {
    return { success: false, error: 'Only the group owner can kick admins' };
  }

  const now = new Date();
  const kickReason = reason?.trim() || 'Removed by agent';

  await db
    .update(groupMembers)
    .set({
      isActive: false,
      kickedAt: now,
      kickReason,
    })
    .where(
      and(
        eq(groupMembers.groupId, cleanGroupId),
        eq(groupMembers.userId, cleanTargetId),
        eq(groupMembers.isActive, true)
      )
    );

  // Deactivate chat participant
  const [chat] = await db
    .select({ id: chats.id })
    .from(chats)
    .where(eq(chats.groupId, cleanGroupId))
    .limit(1);

  if (chat) {
    await db
      .update(chatParticipants)
      .set({ isActive: false })
      .where(
        and(
          eq(chatParticipants.chatId, chat.id),
          eq(chatParticipants.userId, cleanTargetId)
        )
      );
  }

  logger.info(
    `[DirectExecutor] Kicked ${cleanTargetId} from group ${cleanGroupId}: ${kickReason}`,
    { agentUserId },
    'DirectExecutors'
  );

  return { success: true };
}

// =============================================================================
// Direct Leave Group Executor
// =============================================================================

/**
 * Leave a group chat. Owners cannot leave (must transfer ownership or delete).
 */
export async function executeDirectLeaveGroup(
  params: DirectLeaveGroupParams
): Promise<DirectLeaveGroupResult> {
  const { agentUserId, groupId } = params;

  const cleanGroupId = groupId?.trim();
  if (!cleanGroupId) {
    return { success: false, error: 'Group ID is required' };
  }

  // Verify membership
  const [membership] = await db
    .select({ role: groupMembers.role, isActive: groupMembers.isActive })
    .from(groupMembers)
    .where(
      and(
        eq(groupMembers.groupId, cleanGroupId),
        eq(groupMembers.userId, agentUserId)
      )
    )
    .limit(1);

  if (!membership || !membership.isActive) {
    return {
      success: false,
      error: 'You are not an active member of this group',
    };
  }

  if (membership.role === 'owner') {
    return {
      success: false,
      error: 'Group owners cannot leave - transfer ownership first',
    };
  }

  await db
    .update(groupMembers)
    .set({
      isActive: false,
      kickReason: 'Left voluntarily',
      kickedAt: new Date(),
    })
    .where(
      and(
        eq(groupMembers.groupId, cleanGroupId),
        eq(groupMembers.userId, agentUserId),
        eq(groupMembers.isActive, true)
      )
    );

  // Deactivate chat participant
  const [chat] = await db
    .select({ id: chats.id })
    .from(chats)
    .where(eq(chats.groupId, cleanGroupId))
    .limit(1);

  if (chat) {
    await db
      .update(chatParticipants)
      .set({ isActive: false })
      .where(
        and(
          eq(chatParticipants.chatId, chat.id),
          eq(chatParticipants.userId, agentUserId)
        )
      );
  }

  logger.info(
    `[DirectExecutor] Agent left group ${cleanGroupId}`,
    { agentUserId },
    'DirectExecutors'
  );

  return { success: true };
}

/**
 * Send money to another user directly without LLM decision-making.
 * Uses WalletService.debit + credit in sequence (each creates its own transaction).
 */
export async function executeDirectSendMoney(
  params: DirectSendMoneyParams
): Promise<DirectSendMoneyResult> {
  const { agentUserId, recipientId, amount, reason } = params;
  const cleanRecipientId = recipientId?.trim();

  if (!cleanRecipientId) {
    return { success: false, error: 'Recipient ID is required' };
  }

  if (cleanRecipientId === agentUserId) {
    return { success: false, error: 'Cannot send money to yourself' };
  }

  if (!Number.isFinite(amount) || amount <= 0) {
    return { success: false, error: 'Amount must be a positive number' };
  }

  // Verify recipient exists
  const [recipient] = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.id, cleanRecipientId))
    .limit(1);

  if (!recipient) {
    return {
      success: false,
      error: `Recipient not found: ${cleanRecipientId}`,
    };
  }

  const MAX_TRANSFER_RATIO = 0.5;
  const transactionId = await generateSnowflakeId();
  const desc = reason
    ? `Transfer to ${cleanRecipientId}: ${reason}`
    : `Transfer to ${cleanRecipientId}`;

  try {
    // Balance check + cap + debit + credit all inside one transaction
    // to eliminate TOCTOU race on the balance cap calculation.
    const transferredAmount = await withTransaction(async (tx) => {
      const balanceInfo = await WalletService.getBalance(agentUserId);
      const balance = balanceInfo.balance;

      if (balance <= 0) {
        throw new Error('Insufficient balance');
      }

      // Cap transfer at 50% of balance to prevent agents from draining funds
      const maxTransfer = balance * MAX_TRANSFER_RATIO;
      let effectiveAmount = amount;
      if (effectiveAmount > maxTransfer) {
        logger.warn(
          `[DirectExecutor] Transfer capped to ${MAX_TRANSFER_RATIO * 100}% of balance: $${amount} -> $${maxTransfer}`,
          { agentUserId, recipientId: cleanRecipientId },
          'DirectExecutors'
        );
        effectiveAmount = Math.floor(maxTransfer * 100) / 100;
      }

      await WalletService.debit(
        agentUserId,
        effectiveAmount,
        AGENT_TRANSFER_OUT_TRANSACTION_TYPE,
        desc,
        transactionId,
        tx
      );

      await WalletService.credit(
        cleanRecipientId,
        effectiveAmount,
        AGENT_TRANSFER_IN_TRANSACTION_TYPE,
        `Transfer from ${agentUserId}${reason ? `: ${reason}` : ''}`,
        transactionId,
        tx
      );

      return effectiveAmount;
    });

    const updatedBalance = await WalletService.getBalance(agentUserId);

    logger.info(
      `[DirectExecutor] Money sent: ${agentUserId} → ${cleanRecipientId} $${transferredAmount}`,
      {
        agentUserId,
        recipientId: cleanRecipientId,
        amount: transferredAmount,
        transactionId,
      },
      'DirectExecutors'
    );

    return {
      success: true,
      transactionId,
      newBalance: updatedBalance.balance,
    };
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    logger.error(
      `[DirectExecutor] Send money failed: ${errorMsg}`,
      {
        agentUserId,
        recipientId: cleanRecipientId,
        amount,
        error: errorMsg,
      },
      'DirectExecutors'
    );
    return { success: false, error: errorMsg };
  }
}

// =============================================================================
// Stubs for features being built by another agent
// These will be replaced with full implementations
// =============================================================================

/** Stub: Share information with another agent (not yet implemented) */
export async function executeDirectShareInformation(params: {
  agentUserId: string;
  recipientId: string;
  keywords: string[];
  context?: string;
  askingPrice?: number;
}): Promise<{
  success: boolean;
  error?: string;
  matchCount: number;
  sharedWithRecipient: boolean;
  messageId: string | null;
}> {
  void params;
  return {
    success: false,
    error: 'Not yet implemented',
    matchCount: 0,
    sharedWithRecipient: false,
    messageId: null,
  };
}

/** Stub: Request payment from another agent (not yet implemented) */
export async function executeDirectRequestPayment(params: {
  agentUserId: string;
  recipientId: string;
  amount: number;
  reason: string;
  deadline: number;
}): Promise<{
  success: boolean;
  error?: string;
  requestId: string | null;
}> {
  void params;
  return { success: false, error: 'Not yet implemented', requestId: null };
}
