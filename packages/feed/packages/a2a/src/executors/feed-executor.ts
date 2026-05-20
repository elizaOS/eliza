/**
 * Feed Agent Executor
 *
 * Handles all Feed operations via A2A message/send protocol
 * Parses user messages and executes appropriate Feed operations
 */

import type {
  DataPart,
  Message,
  Task,
  TaskArtifactUpdateEvent,
  TaskStatusUpdateEvent,
  TextPart,
} from '@a2a-js/sdk';
import type {
  AgentExecutor,
  ExecutionEventBus,
  RequestContext,
} from '@a2a-js/sdk/server';
import { checkRateLimitAsync, RATE_LIMIT_CONFIGS } from '@feed/api';
import { PerpDbAdapter, PerpMarketService } from '@feed/core/markets/perps';
import {
  PredictionDbAdapter,
  PredictionMarketService,
} from '@feed/core/markets/prediction';
import type { WalletPort } from '@feed/core/markets/shared';
import { db, getRawDrizzle } from '@feed/db';
import { perpMarketSnapshots } from '@feed/db/schema';
import { createPerpPriceImpactPort, WalletService } from '@feed/engine';
import type { JsonValue } from '@feed/shared';
import {
  ContentValidator,
  checkUserInput,
  generateSnowflakeId,
  getAPIBaseUrl,
  logger,
} from '@feed/shared';
import { v4 as uuidv4 } from 'uuid';
import {
  handleAppealBanWithEscrow,
  handleCreateEscrowPayment,
  handleListEscrowPayments,
  handleRefundEscrowPayment,
  handleVerifyEscrowPayment,
} from '../handlers/escrow-handlers';
import { X402Manager } from '../payments/x402-manager';
import type { JsonRpcRequest } from '../types/a2a';
import {
  type OffsetPaginationParams,
  OffsetPaginationSchema,
} from '../validation';

/**
 * Default timeout for external API fetch operations (in milliseconds)
 * Configurable via A2A_FETCH_TIMEOUT_MS environment variable
 */
const DEFAULT_FETCH_TIMEOUT_MS =
  Number(process.env.A2A_FETCH_TIMEOUT_MS) || 30000;

/**
 * Main executor implementing all Feed game operations
 * via A2A protocol
 */
interface FeedCommand {
  operation: string;
  params: Record<string, JsonValue>;
}

/**
 * Common response types for executor operations
 */
interface SuccessResponse {
  success: boolean;
  message?: string;
}

interface PostCreatedResponse extends SuccessResponse {
  postId: string;
  content: string;
}

interface FeedResponse {
  posts: Array<{
    id: string;
    content: string;
    authorId: string;
    timestamp: Date;
  }>;
}

interface MarketsResponse {
  markets: Array<{
    id: number | string;
    question: string;
    yesShares: number;
    noShares: number;
  }>;
}

interface UsersSearchResponse {
  users: Array<{
    id: string;
    username: string | null;
    displayName: string | null;
    reputationPoints: number;
  }>;
}

interface SystemStatsResponse {
  users: number;
  posts: number;
  markets: number;
}

interface LeaderboardResponse {
  leaderboard: Array<{
    id: string;
    username: string | null;
    displayName: string | null;
    reputationPoints: number;
  }>;
}

interface BlockMuteResponse extends SuccessResponse {
  block?: {
    id: string;
    blockerId: string;
    blockedId: string;
    reason: string | null;
    createdAt: Date;
  };
  mute?: {
    id: string;
    muterId: string;
    mutedId: string;
    reason: string | null;
    createdAt: Date;
  };
}

interface ReportResponse extends SuccessResponse {
  report: {
    id: string;
    reporterId: string;
    reportedUserId?: string | null;
    reportedPostId?: string | null;
    reportType: string;
    category: string;
    reason: string;
    evidence: string | null;
    priority: string;
    status: string;
    createdAt: Date;
    updatedAt: Date;
    resolution?: string | null;
    resolvedAt?: Date | null;
    resolvedBy?: string | null;
  };
}

interface BlockedUserInfo {
  id: string;
  username: string | null;
  displayName: string | null;
  profileImageUrl: string | null;
}

interface BlockEntry {
  id: string;
  blockerId: string;
  blockedId: string;
  reason: string | null;
  createdAt: Date;
  blocked?: BlockedUserInfo;
}

interface BlocksListResponse {
  blocks: BlockEntry[];
  pagination: {
    limit: number;
    offset: number;
    total: number;
  };
}

interface MutedUserInfo {
  id: string;
  username: string | null;
  displayName: string | null;
  profileImageUrl: string | null;
}

interface MuteEntry {
  id: string;
  muterId: string;
  mutedId: string;
  reason: string | null;
  createdAt: Date;
  muted?: MutedUserInfo;
}

interface MutesListResponse {
  mutes: MuteEntry[];
  pagination: {
    limit: number;
    offset: number;
    total: number;
  };
}

interface BlockStatusResponse {
  isBlocked: boolean;
  block: {
    id: string;
    createdAt: Date;
    reason: string | null;
  } | null;
}

interface MuteStatusResponse {
  isMuted: boolean;
  mute: {
    id: string;
    createdAt: Date;
    reason: string | null;
  } | null;
}

interface TrendingTagsResponse {
  tags: Array<{
    name: string;
    displayName: string;
    category: string;
    postCount: number;
  }>;
}

interface PostsByTagResponse {
  posts: Array<{
    id: string;
    content: string;
    authorId: string;
    timestamp: Date;
  }>;
}

type ExecutorOperationResult =
  | PostCreatedResponse
  | FeedResponse
  | MarketsResponse
  | UsersSearchResponse
  | SystemStatsResponse
  | LeaderboardResponse
  | TrendingTagsResponse
  | PostsByTagResponse
  | BlockMuteResponse
  | ReportResponse
  | BlocksListResponse
  | MutesListResponse
  | BlockStatusResponse
  | MuteStatusResponse
  | JsonValue;

export class FeedAgentExecutor implements AgentExecutor {
  /**
   * Check rate limit and throw if exceeded.
   * Uses the centralized @feed/api rate limiter with Redis backing.
   *
   * @param userId - The user ID to check limits for
   * @param config - Rate limit configuration from RATE_LIMIT_CONFIGS
   */
  private async checkRateLimit(
    userId: string,
    config: (typeof RATE_LIMIT_CONFIGS)[keyof typeof RATE_LIMIT_CONFIGS]
  ): Promise<void> {
    const result = await checkRateLimitAsync(userId, config);
    if (!result.allowed) {
      throw new Error(
        `Rate limit exceeded for ${config.actionType}. ` +
          `Retry after ${result.retryAfter ?? 60}s. Remaining: ${result.remaining ?? 0}`
      );
    }
  }

  /**
   * Validates and sanitizes user-provided content.
   * Uses existing @feed/shared utilities for consistency.
   *
   * @param content - The content to validate
   * @param context - Context for error messages (e.g., 'Post content', 'Comment')
   * @returns Sanitized content string
   * @throws Error if content fails validation
   */
  private validateUserContent(content: unknown, context: string): string {
    // Step 1: Structural validation (type, empty check, length limit)
    ContentValidator.validatePostContent(content, context);

    // Step 2: Sanitize (remove null bytes, control characters)
    const sanitized = ContentValidator.sanitizeContent(content);

    // Step 3: Safety check (profanity, injection, spam)
    const safetyCheck = checkUserInput(sanitized);
    if (!safetyCheck.safe) {
      throw new Error(`${context}: ${safetyCheck.reason}`);
    }

    return sanitized;
  }

  /**
   * Validates pagination parameters (offset/limit) for list operations.
   * Uses Zod schema with coercion for flexible input handling.
   *
   * @param offset - The offset value (can be string or number)
   * @param limit - The limit value (can be string or number)
   * @returns Validated pagination params with defaults applied
   * @throws Error if pagination params are invalid
   */
  private validatePaginationParams(
    offset: unknown,
    limit: unknown
  ): OffsetPaginationParams {
    const result = OffsetPaginationSchema.safeParse({ offset, limit });

    if (!result.success) {
      throw new Error(
        `Pagination error: ${result.error.issues[0]?.message ?? 'Invalid params'}`
      );
    }

    return result.data;
  }

  /**
   * Execute operation directly without A2A HTTP protocol
   * Used for server-side internal calls to bypass Vercel serverless HTTP limitations
   *
   * @param operation - The operation name (e.g., 'portfolio.get_balance')
   * @param params - Operation parameters
   * @param agentUserId - The agent's user ID for context
   * @returns Operation result as JsonValue
   */
  public static async executeDirectly(
    operation: string,
    params: Record<string, JsonValue>,
    agentUserId: string
  ): Promise<JsonValue> {
    const executor = new FeedAgentExecutor();
    const command: FeedCommand = { operation, params };
    const taskId = `direct-${Date.now()}`;

    // Create minimal RequestContext for the operation
    const context: RequestContext = {
      taskId,
      contextId: agentUserId,
      userMessage: {
        kind: 'message',
        messageId: `direct-msg-${Date.now()}`,
        role: 'user',
        parts: [{ kind: 'text', text: `Direct call: ${operation}` }],
      },
      task: {
        kind: 'task',
        id: taskId,
        contextId: agentUserId,
        status: { state: 'working', timestamp: new Date().toISOString() },
        artifacts: [],
      },
    };

    const result = await executor.executeOperation(command, context);
    // Cast to JsonValue since ExecutorOperationResult is compatible at runtime
    return result as unknown as JsonValue;
  }

  async execute(
    requestContext: RequestContext,
    eventBus: ExecutionEventBus
  ): Promise<void> {
    const { taskId, contextId, userMessage, task } = requestContext;

    // Extract message text
    const textParts = userMessage.parts.filter(
      (p): p is TextPart => p.kind === 'text'
    );
    const messageText = textParts.map((p) => p.text).join(' ');

    logger.info('Feed processing A2A message', { taskId, messageText });

    // Create initial task if needed
    if (!task) {
      const initialTask: Task = {
        kind: 'task',
        id: taskId,
        contextId: contextId || uuidv4(),
        status: {
          state: 'submitted',
          timestamp: new Date().toISOString(),
        },
        history: [userMessage],
      };
      eventBus.publish(initialTask);
    }

    // Update to working state
    const workingUpdate: TaskStatusUpdateEvent = {
      kind: 'status-update',
      taskId,
      contextId: contextId || uuidv4(),
      status: {
        state: 'working',
        timestamp: new Date().toISOString(),
      },
      final: false,
    };
    eventBus.publish(workingUpdate);

    const command = this.parseCommand(userMessage);
    const result = await this.executeOperation(command, requestContext);

    // Create artifact with result
    const artifactUpdate: TaskArtifactUpdateEvent = {
      kind: 'artifact-update',
      taskId,
      contextId: contextId || uuidv4(),
      artifact: {
        artifactId: uuidv4(),
        name: 'result.json',
        parts: [
          {
            kind: 'data',
            data: (result ?? {}) as { [k: string]: JsonValue },
          },
        ],
      },
    };
    eventBus.publish(artifactUpdate);

    // Mark completed
    const completedUpdate: TaskStatusUpdateEvent = {
      kind: 'status-update',
      taskId,
      contextId: contextId || uuidv4(),
      status: {
        state: 'completed',
        timestamp: new Date().toISOString(),
      },
      final: true,
    };
    eventBus.publish(completedUpdate);
    eventBus.finished();
  }

  private async executeOperation(
    command: FeedCommand,
    context: RequestContext
  ): Promise<ExecutorOperationResult> {
    switch (command.operation) {
      // Portfolio operations
      case 'portfolio.get_balance':
        return this.getBalance(command.params, context);
      case 'portfolio.get_positions':
        return this.getPositions(command.params, context);
      case 'portfolio.get_user_wallet':
        return this.getUserWallet(command.params, context);
      case 'social.create_post':
        return this.createPost(command.params, context);
      case 'social.get_feed':
        return this.getFeed(command.params);
      case 'social.get_post':
        return this.getPost(command.params);
      case 'social.like_post':
        return this.likePost(command.params, context);
      case 'social.unlike_post':
        return this.unlikePost(command.params, context);
      case 'social.delete_post':
        return this.deletePost(command.params, context);
      case 'social.share_post':
        return this.sharePost(command.params, context);
      case 'social.get_comments':
        return this.getComments(command.params);
      case 'social.create_comment':
        return this.createComment(command.params, context);
      case 'social.delete_comment':
        return this.deleteComment(command.params, context);
      case 'social.like_comment':
        return this.likeComment(command.params, context);
      case 'markets.list_prediction':
        return this.listPredictionMarkets(command.params);
      case 'markets.list_perpetuals':
        return this.listPerpetualMarkets(command.params);
      case 'markets.buy_shares':
        return this.buyShares(command.params, context);
      case 'markets.sell_shares':
        return this.sellShares(command.params, context);
      case 'markets.open_position':
        return this.openPosition(command.params, context);
      case 'markets.close_position':
        return this.closePosition(command.params, context);
      case 'markets.get_trades':
        return this.getTrades(command.params);
      case 'markets.get_trade_history':
        return this.getTradeHistory(command.params, context);
      case 'users.search':
        return this.searchUsers(command.params);
      case 'users.get_profile':
        return this.getUserProfile(command.params);
      case 'users.update_profile':
        return this.updateProfile(command.params, context);
      case 'users.follow':
        return this.followUser(command.params, context);
      case 'users.unfollow':
        return this.unfollowUser(command.params, context);
      case 'users.get_followers':
        return this.getFollowers(command.params, context);
      case 'users.get_following':
        return this.getFollowing(command.params, context);
      case 'stats.system':
        return this.getSystemStats();
      case 'stats.leaderboard':
        return this.getLeaderboard(command.params);
      case 'stats.trending_tags':
        return this.getTrendingTags(command.params);
      case 'stats.posts_by_tag':
        return this.getPostsByTag(command.params);
      case 'stats.get_organizations':
        return this.getOrganizations(command.params);
      // Messaging operations
      case 'messaging.get_chats':
        return this.getChatsHandler(command.params, context);
      case 'messaging.get_chat_messages':
        return this.getChatMessages(command.params, context);
      case 'messaging.send_message':
        return this.sendMessage(command.params, context);
      case 'messaging.create_group':
        return this.createGroup(command.params, context);
      case 'messaging.leave_chat':
        return this.leaveChat(command.params, context);
      case 'messaging.get_unread_count':
        return this.getUnreadCountHandler(command.params, context);
      case 'messaging.get_notifications':
        return this.getNotificationsHandler(command.params, context);
      case 'notifications.mark_read':
        return this.markNotificationsRead(command.params, context);
      case 'notifications.get_group_invites':
        return this.getGroupInvites(command.params, context);
      case 'notifications.accept_invite':
        return this.acceptGroupInvite(command.params, context);
      case 'notifications.decline_invite':
        return this.declineGroupInvite(command.params, context);
      case 'moderation.create_escrow_payment':
        return this.createEscrowPayment(command.params, context);
      case 'moderation.verify_escrow_payment':
        return this.verifyEscrowPayment(command.params, context);
      case 'moderation.refund_escrow_payment':
        return this.refundEscrowPayment(command.params, context);
      case 'moderation.list_escrow_payments':
        return this.listEscrowPayments(command.params, context);
      case 'moderation.appeal_ban_with_escrow':
        return this.appealBanWithEscrow(command.params, context);
      // Basic moderation operations
      case 'moderation.block_user':
        return this.blockUser(command.params, context);
      case 'moderation.unblock_user':
        return this.unblockUser(command.params, context);
      case 'moderation.mute_user':
        return this.muteUser(command.params, context);
      case 'moderation.unmute_user':
        return this.unmuteUser(command.params, context);
      case 'moderation.report_user':
        return this.reportUser(command.params, context);
      case 'moderation.report_post':
        return this.reportPost(command.params, context);
      case 'moderation.get_blocks':
        return this.getBlocks(command.params, context);
      case 'moderation.get_mutes':
        return this.getMutes(command.params, context);
      case 'moderation.check_block_status':
        return this.checkBlockStatus(command.params, context);
      case 'moderation.check_mute_status':
        return this.checkMuteStatus(command.params, context);
      // Stats operations
      case 'stats.get_user_stats':
        return this.getUserStats(command.params, context);
      case 'stats.get_referral_code':
        return this.getReferralCode(command.params, context);
      case 'stats.get_referrals':
        return this.getReferrals(command.params, context);
      case 'stats.get_referral_stats':
        return this.getReferralStats(command.params, context);
      case 'stats.get_reputation':
        return this.getReputation(command.params, context);
      case 'stats.get_reputation_breakdown':
        return this.getReputationBreakdown(command.params, context);
      // Favorites operations
      case 'favorites.add':
        return this.favoriteProfile(command.params, context);
      case 'favorites.remove':
        return this.unfavoriteProfile(command.params, context);
      case 'favorites.list':
        return this.getFavorites(command.params, context);
      case 'favorites.posts':
        return this.getFavoritePosts(command.params, context);
      // Markets - additional operations
      case 'markets.get_market_data':
        return this.getMarketData(command.params);
      case 'markets.get_market_prices':
        return this.getMarketPrices(command.params);
      // Payments (x402)
      case 'payments.request':
        return this.paymentRequest(command.params, context);
      case 'payments.receipt':
        return this.paymentReceipt(command.params, context);
      // Moderation - appeal without escrow
      case 'moderation.appeal_ban':
        return this.appealBan(command.params, context);
      default:
        throw new Error(`Unsupported operation: ${command.operation}`);
    }
  }

  private parseCommand(message: Message): FeedCommand {
    const dataPart = message.parts.find(
      (part): part is DataPart => part.kind === 'data'
    );

    if (dataPart && dataPart.data && typeof dataPart.data === 'object') {
      const data = dataPart.data as Record<string, JsonValue>;
      const operation = data.operation;
      const params = data.params;
      if (typeof operation !== 'string') {
        throw new Error('Data part must include an "operation" string');
      }
      return {
        operation,
        params: this.ensureRecord(params),
      };
    }

    const textPayload = message.parts
      .filter((part): part is TextPart => part.kind === 'text')
      .map((part) => part.text)
      .join(' ')
      .trim();

    if (textPayload.length > 0) {
      const parsed = JSON.parse(textPayload);
      if (typeof parsed.operation === 'string') {
        return {
          operation: parsed.operation,
          params: this.ensureRecord(parsed.params),
        };
      }
    }

    throw new Error(
      'Structured command required. Provide a data part with { "operation": "...", "params": {...} }'
    );
  }

  private ensureRecord(value: unknown): Record<string, JsonValue> {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      return value as Record<string, JsonValue>;
    }
    return {};
  }

  private async createPost(
    params: Record<string, JsonValue>,
    context: RequestContext
  ) {
    // Validate and sanitize content (checks type, length, profanity, injection)
    const content = this.validateUserContent(params.content, 'Post content');

    const post = await db.post.create({
      data: {
        id: await generateSnowflakeId(),
        content,
        authorId: context.contextId || context.taskId,
        timestamp: new Date(),
      },
    });
    return { success: true, postId: post.id, content: post.content };
  }

  private async getFeed(params: Record<string, JsonValue>) {
    const limit = this.parsePositiveInt(params.limit, 20, 100);
    const posts = await db.post.findMany({
      take: limit,
      orderBy: { timestamp: 'desc' },
      select: {
        id: true,
        content: true,
        authorId: true,
        timestamp: true,
      },
    });
    return {
      posts: posts.map((p) => ({
        id: p.id,
        content: p.content,
        authorId: p.authorId,
        timestamp: p.timestamp,
      })),
    };
  }

  private async likePost(
    params: Record<string, JsonValue>,
    context: RequestContext
  ): Promise<SuccessResponse> {
    const postId = typeof params.postId === 'string' ? params.postId : '';
    if (!postId) {
      throw new Error('postId is required');
    }

    // Check if post exists
    const post = await db.post.findFirst({
      where: { id: postId, deletedAt: null },
    });

    if (!post) {
      throw new Error('Post not found');
    }

    // Prefer request context identity when present (prevents params-based impersonation),
    // then fall back to explicit params, then taskId.
    const userIdFromContext = context.contextId;
    const userIdFromParams =
      typeof params.userId === 'string' ? params.userId.trim() : '';
    const userId = userIdFromContext || userIdFromParams || context.taskId;

    // Check if already liked
    const existingLike = await db.reaction.findFirst({
      where: {
        postId,
        userId,
        type: 'like',
      },
    });

    if (existingLike) {
      return { success: true, message: 'Already liked' };
    }

    // Create the like
    await db.reaction.create({
      data: {
        id: await generateSnowflakeId(),
        postId,
        userId,
        type: 'like',
      },
    });

    return { success: true, message: 'Post liked' };
  }

  private async getPost(
    params: Record<string, JsonValue>
  ): Promise<ExecutorOperationResult> {
    const postId = String(params.postId ?? '');
    if (!postId) throw new Error('postId is required');

    const post = await db.post.findFirst({
      where: { id: postId, deletedAt: null },
      select: {
        id: true,
        content: true,
        authorId: true,
        createdAt: true,
        updatedAt: true,
      },
    });

    if (!post) {
      throw new Error('Post not found');
    }

    // Get like count
    const likeCount = await db.reaction.count({
      where: { postId, type: 'like' },
    });

    // Get comment count
    const commentCount = await db.comment.count({
      where: { postId, deletedAt: null },
    });

    return {
      post: {
        id: post.id,
        content: post.content,
        authorId: post.authorId,
        createdAt: post.createdAt?.toISOString(),
        likeCount,
        commentCount,
      },
    };
  }

  private async unlikePost(
    params: Record<string, JsonValue>,
    context: RequestContext
  ): Promise<SuccessResponse> {
    const postId = String(params.postId ?? '');
    if (!postId) throw new Error('postId is required');

    const userId = context.contextId || context.taskId;

    const deleted = await db.reaction.deleteMany({
      where: {
        postId,
        userId,
        type: 'like',
      },
    });

    return {
      success: true,
      message: deleted.count > 0 ? 'Post unliked' : 'Was not liked',
    };
  }

  private async deletePost(
    params: Record<string, JsonValue>,
    context: RequestContext
  ): Promise<SuccessResponse> {
    const postId = String(params.postId ?? '');
    if (!postId) throw new Error('postId is required');

    const userId = context.contextId || context.taskId;

    // Find post and verify ownership
    const post = await db.post.findFirst({
      where: { id: postId, deletedAt: null },
    });

    if (!post) {
      throw new Error('Post not found');
    }

    if (post.authorId !== userId) {
      throw new Error('Unauthorized: You can only delete your own posts');
    }

    // Soft delete
    await db.post.update({
      where: { id: postId },
      data: { deletedAt: new Date() },
    });

    return { success: true, message: 'Post deleted' };
  }

  private async sharePost(
    params: Record<string, JsonValue>,
    context: RequestContext
  ): Promise<ExecutorOperationResult> {
    const postId = String(params.postId ?? '');
    if (!postId) throw new Error('postId is required');

    const userId = context.contextId || context.taskId;

    // Verify post exists
    const post = await db.post.findFirst({
      where: { id: postId, deletedAt: null },
    });

    if (!post) {
      throw new Error('Post not found');
    }

    // Create share
    const share = await db.share.create({
      data: {
        id: await generateSnowflakeId(),
        postId,
        userId,
      },
    });

    return {
      success: true,
      shareId: share.id,
      message: 'Post shared',
    };
  }

  private async getComments(
    params: Record<string, JsonValue>
  ): Promise<ExecutorOperationResult> {
    const postId = String(params.postId ?? '');
    if (!postId) throw new Error('postId is required');

    const limit = this.parsePositiveInt(params.limit, 50, 100);

    const comments = await db.comment.findMany({
      where: { postId, deletedAt: null },
      orderBy: { createdAt: 'asc' },
      take: limit,
      select: {
        id: true,
        content: true,
        authorId: true,
        createdAt: true,
      },
    });

    // Get like counts for all comments in a single aggregated query
    const commentIds = comments.map((c) => c.id);
    const likeCountMap = new Map<string, number>();

    if (commentIds.length > 0) {
      const likeCounts = (await db.reaction.groupBy({
        by: ['commentId'],
        where: { commentId: { in: commentIds }, type: 'like' },
        _count: { id: true },
      })) as Array<{ commentId: string; _count: { id: number } }>;

      for (const lc of likeCounts) {
        likeCountMap.set(lc.commentId, lc._count.id);
      }
    }

    return {
      comments: comments.map((c) => ({
        id: c.id,
        content: c.content,
        authorId: c.authorId,
        createdAt: c.createdAt?.toISOString(),
        likeCount: likeCountMap.get(c.id) || 0,
      })),
    };
  }

  private async createComment(
    params: Record<string, JsonValue>,
    context: RequestContext
  ): Promise<ExecutorOperationResult> {
    const postId = String(params.postId ?? '');
    // Validate and sanitize content (checks type, length, profanity, injection)
    const content = this.validateUserContent(params.content, 'Comment');

    if (!postId) throw new Error('postId is required');

    const userId = context.contextId || context.taskId;

    // Verify post exists
    const post = await db.post.findFirst({
      where: { id: postId, deletedAt: null },
    });

    if (!post) {
      throw new Error('Post not found');
    }

    const commentId = await generateSnowflakeId();
    await db.comment.create({
      data: {
        id: commentId,
        postId,
        authorId: userId,
        content,
        updatedAt: new Date(),
      },
    });

    return {
      success: true,
      comment: {
        id: commentId,
        postId,
        content,
        authorId: userId,
        createdAt: new Date().toISOString(),
      },
    };
  }

  private async deleteComment(
    params: Record<string, JsonValue>,
    context: RequestContext
  ): Promise<SuccessResponse> {
    const commentId = String(params.commentId ?? '');
    if (!commentId) throw new Error('commentId is required');

    const userId = context.contextId || context.taskId;

    // Find comment and verify ownership
    const comment = await db.comment.findFirst({
      where: { id: commentId, deletedAt: null },
    });

    if (!comment) {
      throw new Error('Comment not found');
    }

    if (comment.authorId !== userId) {
      throw new Error('Unauthorized: You can only delete your own comments');
    }

    // Soft delete
    await db.comment.update({
      where: { id: commentId },
      data: { deletedAt: new Date() },
    });

    return { success: true, message: 'Comment deleted' };
  }

  private async likeComment(
    params: Record<string, JsonValue>,
    context: RequestContext
  ): Promise<SuccessResponse> {
    const commentId = String(params.commentId ?? '');
    if (!commentId) throw new Error('commentId is required');

    const userId = context.contextId || context.taskId;

    // Verify comment exists
    const comment = await db.comment.findFirst({
      where: { id: commentId, deletedAt: null },
    });

    if (!comment) {
      throw new Error('Comment not found');
    }

    // Check if already liked
    const existingLike = await db.reaction.findFirst({
      where: {
        commentId,
        userId,
        type: 'like',
      },
    });

    if (existingLike) {
      return { success: true, message: 'Already liked' };
    }

    // Create the like
    await db.reaction.create({
      data: {
        id: await generateSnowflakeId(),
        commentId,
        userId,
        type: 'like',
      },
    });

    return { success: true, message: 'Comment liked' };
  }

  private async listPredictionMarkets(params: Record<string, JsonValue>) {
    const limit = this.parsePositiveInt(params.limit, 20, 50);
    const markets = await db.market.findMany({
      take: limit,
      where: { resolved: false },
      orderBy: { createdAt: 'desc' },
    });
    return {
      markets: markets.map((m) => ({
        id: m.id,
        question: m.question,
        yesShares: Number(m.yesShares),
        noShares: Number(m.noShares),
      })),
    };
  }

  private async listPerpetualMarkets(params: Record<string, JsonValue>) {
    const limit = this.parsePositiveInt(params.limit, 20, 50);

    let snapshots: Array<{
      ticker: string;
      name: string | null;
      organizationId: string;
      currentPrice: number;
      change24h: number | null;
      changePercent24h: number | null;
      volume24h: number | null;
      openInterest: number | null;
      fundingRate: unknown;
    }>;

    try {
      const drizzle = getRawDrizzle();
      snapshots = await drizzle
        .select({
          ticker: perpMarketSnapshots.ticker,
          name: perpMarketSnapshots.name,
          organizationId: perpMarketSnapshots.organizationId,
          currentPrice: perpMarketSnapshots.currentPrice,
          change24h: perpMarketSnapshots.change24h,
          changePercent24h: perpMarketSnapshots.changePercent24h,
          volume24h: perpMarketSnapshots.volume24h,
          openInterest: perpMarketSnapshots.openInterest,
          fundingRate: perpMarketSnapshots.fundingRate,
        })
        .from(perpMarketSnapshots)
        .limit(limit);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (
        message.includes(
          'getRawDrizzle() is only available in PostgreSQL mode'
        ) ||
        message.includes('Database not initialized')
      ) {
        logger.debug('Perpetual markets unavailable, returning empty', {
          message,
        });
        return { perpetuals: [] };
      }
      throw error;
    }

    return {
      perpetuals: snapshots.map((s) => ({
        name: s.name || s.ticker,
        type: 'perpetual',
        ticker: s.ticker,
        currentPrice: Number(s.currentPrice) || 0,
        priceChange24h: Number(s.change24h) || 0,
        volume24h: Number(s.volume24h) || 0,
        openInterest: Number(s.openInterest) || 0,
        fundingRate:
          typeof s.fundingRate === 'object' && s.fundingRate !== null
            ? (s.fundingRate as { rate?: number }).rate || 0
            : 0,
      })),
    };
  }

  private async getUserProfile(params: Record<string, JsonValue>) {
    const userId =
      typeof params.userId === 'string' ? params.userId.trim() : '';
    if (!userId) {
      throw new Error('userId is required');
    }

    const user = await db.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        username: true,
        displayName: true,
        bio: true,
        profileImageUrl: true,
        reputationPoints: true,
        virtualBalance: true,
        walletAddress: true,
        isAgent: true,
      },
    });

    if (!user) {
      logger.debug('User not found for getUserProfile, returning defaults', {
        userId,
      });
      return {
        id: userId,
        username: null,
        displayName: null,
        bio: null,
        profileImageUrl: null,
        reputationPoints: 0,
        virtualBalance: 0,
        walletAddress: null,
        isAgent: false,
      };
    }

    return {
      id: user.id,
      username: user.username,
      displayName: user.displayName,
      bio: user.bio,
      profileImageUrl: user.profileImageUrl,
      reputationPoints: user.reputationPoints || 0,
      virtualBalance: Number(user.virtualBalance) || 0,
      walletAddress: user.walletAddress,
      isAgent: user.isAgent,
    };
  }

  private async updateProfile(
    params: Record<string, JsonValue>,
    context: RequestContext
  ): Promise<ExecutorOperationResult> {
    const userId = context.contextId || context.taskId;

    const updateData: Record<string, string | null> = {};

    if (typeof params.displayName === 'string') {
      updateData.displayName = params.displayName.trim() || null;
    }
    if (typeof params.bio === 'string') {
      updateData.bio = params.bio.trim() || null;
    }
    if (typeof params.username === 'string') {
      updateData.username = params.username.trim() || null;
    }
    if (typeof params.profileImageUrl === 'string') {
      updateData.profileImageUrl = params.profileImageUrl.trim() || null;
    }

    if (Object.keys(updateData).length === 0) {
      throw new Error('At least one field to update is required');
    }

    await db.user.update({
      where: { id: userId },
      data: updateData,
    });

    // Fetch the updated user to return clean data
    const user = await db.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        username: true,
        displayName: true,
        bio: true,
        profileImageUrl: true,
      },
    });

    return {
      success: true,
      user: user
        ? {
            id: user.id,
            username: user.username,
            displayName: user.displayName,
            bio: user.bio,
            profileImageUrl: user.profileImageUrl,
          }
        : null,
    };
  }

  private async followUser(
    params: Record<string, JsonValue>,
    context: RequestContext
  ): Promise<SuccessResponse> {
    const followerId = context.contextId || context.taskId;
    const followingId = String(params.userId ?? '');

    if (!followingId) throw new Error('userId is required');
    if (followerId === followingId) throw new Error('Cannot follow yourself');

    // Check if already following
    const existingFollow = await db.follow.findFirst({
      where: { followerId, followingId },
    });

    if (existingFollow) {
      return { success: true, message: 'Already following' };
    }

    await db.follow.create({
      data: {
        id: await generateSnowflakeId(),
        followerId,
        followingId,
      },
    });

    return { success: true, message: 'Now following user' };
  }

  private async unfollowUser(
    params: Record<string, JsonValue>,
    context: RequestContext
  ): Promise<SuccessResponse> {
    const followerId = context.contextId || context.taskId;
    const followingId = String(params.userId ?? '');

    if (!followingId) throw new Error('userId is required');

    const deleted = await db.follow.deleteMany({
      where: { followerId, followingId },
    });

    return {
      success: true,
      message: deleted.count > 0 ? 'Unfollowed user' : 'Was not following',
    };
  }

  private async getFollowers(
    params: Record<string, JsonValue>,
    context: RequestContext
  ): Promise<ExecutorOperationResult> {
    const userId =
      String(params.userId ?? '') || context.contextId || context.taskId;
    const { offset, limit } = this.validatePaginationParams(
      params.offset,
      params.limit
    );

    // Get total count before pagination
    const total = await db.follow.count({
      where: { followingId: userId },
    });

    if (total === 0) {
      return { followers: [], total: 0 };
    }

    const follows = await db.follow.findMany({
      where: { followingId: userId },
      skip: offset,
      take: limit,
      orderBy: { createdAt: 'desc' },
      select: { followerId: true },
    });

    const followerIds = follows.map((f) => f.followerId);

    if (followerIds.length === 0) {
      return { followers: [], total };
    }

    const users = await db.user.findMany({
      where: { id: { in: followerIds } },
      select: {
        id: true,
        username: true,
        displayName: true,
        profileImageUrl: true,
      },
    });

    return {
      followers: users.map((u) => ({
        id: u.id,
        username: u.username,
        displayName: u.displayName,
        profileImageUrl: u.profileImageUrl,
      })),
      total,
    };
  }

  private async getFollowing(
    params: Record<string, JsonValue>,
    context: RequestContext
  ): Promise<ExecutorOperationResult> {
    const userId =
      String(params.userId ?? '') || context.contextId || context.taskId;
    const { offset, limit } = this.validatePaginationParams(
      params.offset,
      params.limit
    );

    // Get total count before pagination
    const total = await db.follow.count({
      where: { followerId: userId },
    });

    if (total === 0) {
      return { following: [], total: 0 };
    }

    const follows = await db.follow.findMany({
      where: { followerId: userId },
      skip: offset,
      take: limit,
      orderBy: { createdAt: 'desc' },
      select: { followingId: true },
    });

    const followingIds = follows.map((f) => f.followingId);

    if (followingIds.length === 0) {
      return { following: [], total };
    }

    const users = await db.user.findMany({
      where: { id: { in: followingIds } },
      select: {
        id: true,
        username: true,
        displayName: true,
        profileImageUrl: true,
      },
    });

    return {
      following: users.map((u) => ({
        id: u.id,
        username: u.username,
        displayName: u.displayName,
        profileImageUrl: u.profileImageUrl,
      })),
      total,
    };
  }

  private async getOrganizations(params: Record<string, JsonValue>) {
    const limit = this.parsePositiveInt(params.limit, 20, 100);
    // Get organization states
    const orgStates = await db.organizationState.findMany({
      take: limit,
      orderBy: { currentPrice: 'desc' },
      select: {
        id: true,
        currentPrice: true,
        basePrice: true,
      },
    });
    return {
      organizations: orgStates.map((o) => ({
        id: o.id,
        name: o.id,
        ticker: o.id,
        currentPrice: Number(o.currentPrice) || 0,
        initialPrice: Number(o.basePrice) || 0,
        priceChangePercentage:
          Number(o.basePrice) > 0
            ? ((Number(o.currentPrice) - Number(o.basePrice)) /
                Number(o.basePrice)) *
              100
            : 0,
      })),
    };
  }

  // Trading Operations

  private buildWalletPort(): WalletPort {
    return {
      debit: ({ userId, amount, reason, description, relatedId }) =>
        WalletService.debit(
          userId,
          amount,
          reason,
          description ?? '',
          relatedId
        ),
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

  private buildPredictionService() {
    return new PredictionMarketService({
      db: new PredictionDbAdapter(),
      wallet: this.buildWalletPort(),
      broadcast: {
        emit: async () => {
          // No-op for A2A - broadcasts handled separately
        },
      },
      fees: {
        tradingFeeRate: 0.01,
        platformShare: 0.5,
        referrerShare: 0.1,
        minFeeAmount: 0,
      },
    });
  }

  private buildPerpService() {
    return new PerpMarketService({
      db: new PerpDbAdapter(),
      wallet: this.buildWalletPort(),
      priceImpact: createPerpPriceImpactPort(),
      broadcast: {
        emit: async () => {
          // No-op for A2A - broadcasts handled separately
        },
      },
      fees: {
        tradingFeeRate: 0.01,
        platformShare: 0.5,
        referrerShare: 0.1,
        minFeeAmount: 0,
      },
    });
  }

  private async buyShares(
    params: Record<string, JsonValue>,
    context: RequestContext
  ): Promise<ExecutorOperationResult> {
    const userId = context.contextId || context.taskId;

    // Rate limit check for trading operations
    await this.checkRateLimit(userId, RATE_LIMIT_CONFIGS.BUY_PREDICTION);

    const marketId = String(params.marketId ?? '');
    const outcome = String(params.outcome ?? '').toUpperCase();
    const amount = Number(params.amount ?? 0);

    if (!marketId) throw new Error('marketId is required');
    if (!['YES', 'NO'].includes(outcome))
      throw new Error('outcome must be YES or NO');
    if (amount <= 0) throw new Error('amount must be positive');

    const side = outcome === 'YES' ? 'yes' : 'no';
    const service = this.buildPredictionService();
    const result = await service.buy({
      userId,
      marketId,
      side,
      amount,
    });

    const balance = await WalletService.getBalance(userId);

    return {
      success: true,
      position: {
        id: result.positionId,
        marketId,
        side: outcome,
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
  }

  private async sellShares(
    params: Record<string, JsonValue>,
    context: RequestContext
  ): Promise<ExecutorOperationResult> {
    const userId = context.contextId || context.taskId;

    // Rate limit check for trading operations
    await this.checkRateLimit(userId, RATE_LIMIT_CONFIGS.SELL_PREDICTION);

    const positionId = String(params.positionId ?? '');
    const shares = Number(params.shares ?? 0);

    if (!positionId) throw new Error('positionId is required');
    if (shares <= 0) throw new Error('shares must be positive');

    const position = await db.position.findUnique({
      where: { id: positionId },
    });
    if (!position || position.userId !== userId) {
      throw new Error('Position not found or access denied');
    }
    if (!position.marketId) {
      throw new Error('Position has no associated market');
    }

    const service = this.buildPredictionService();
    const result = await service.sell({
      userId,
      marketId: position.marketId,
      shares,
      positionId,
    });

    const balance = await WalletService.getBalance(userId);

    return {
      success: true,
      sharesSold: shares,
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
  }

  private async openPosition(
    params: Record<string, JsonValue>,
    context: RequestContext
  ): Promise<ExecutorOperationResult> {
    const userId = context.contextId || context.taskId;

    // Rate limit check for trading operations
    await this.checkRateLimit(userId, RATE_LIMIT_CONFIGS.OPEN_POSITION);

    const ticker = String(params.ticker ?? '');
    const sideParam = String(params.side ?? '').toLowerCase();
    const amount = Number(params.amount ?? 0);
    const leverage = Number(params.leverage ?? 1);

    if (!ticker) throw new Error('ticker is required');
    if (!['long', 'short'].includes(sideParam))
      throw new Error('side must be long or short');
    if (amount <= 0) throw new Error('amount must be positive');
    if (leverage < 1 || leverage > 100)
      throw new Error('leverage must be between 1 and 100');

    const side = sideParam as 'long' | 'short';
    const service = this.buildPerpService();
    const result = await service.openPosition({
      userId,
      ticker,
      side,
      size: amount,
      leverage,
    });

    return {
      success: true,
      position: {
        positionId: result.positionId,
        ticker: result.ticker,
        side: result.side === 'long' ? 'LONG' : 'SHORT',
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
  }

  private async closePosition(
    params: Record<string, JsonValue>,
    context: RequestContext
  ): Promise<ExecutorOperationResult> {
    const userId = context.contextId || context.taskId;

    // Rate limit check for trading operations
    await this.checkRateLimit(userId, RATE_LIMIT_CONFIGS.CLOSE_POSITION);

    const positionId = String(params.positionId ?? '');

    if (!positionId) throw new Error('positionId is required');

    const service = this.buildPerpService();
    const result = await service.closePosition({
      userId,
      positionId,
    });

    return {
      success: true,
      position: {
        positionId,
        ticker: result.ticker,
        side: result.side === 'long' ? 'LONG' : 'SHORT',
        size: result.size,
        entryPrice: result.entryPrice ?? 0,
        exitPrice: result.exitPrice ?? 0,
      },
      marginReturned: result.marginPaid ?? 0,
      pnl: result.realizedPnL ?? 0,
      fee: {
        amount: result.feePaid,
        referrerPaid: 0,
      },
      newBalance: result.balance ?? 0,
    };
  }

  private async getTrades(
    params: Record<string, JsonValue>
  ): Promise<ExecutorOperationResult> {
    const marketId = params.marketId ? String(params.marketId) : undefined;
    const limit = this.parsePositiveInt(params.limit, 20, 100);

    const apiBaseUrl = getAPIBaseUrl();
    const url = new URL(`${apiBaseUrl}/trades`);
    if (marketId) url.searchParams.set('marketId', marketId);
    url.searchParams.set('limit', limit.toString());

    const controller = new AbortController();
    const timer = setTimeout(
      () => controller.abort(),
      DEFAULT_FETCH_TIMEOUT_MS
    );

    let response: Response;
    try {
      response = await fetch(url.toString(), { signal: controller.signal });
      clearTimeout(timer);
    } catch (error) {
      clearTimeout(timer);
      if (error instanceof Error && error.name === 'AbortError') {
        throw new Error(
          `Request to fetch trades timed out after ${DEFAULT_FETCH_TIMEOUT_MS}ms`
        );
      }
      throw error;
    }

    if (!response.ok) {
      throw new Error(`Failed to fetch trades: ${response.statusText}`);
    }

    const data = (await response.json()) as {
      trades: Array<{
        id: string;
        marketId: string;
        userId: string;
        side: boolean;
        shares: string;
        price: string;
        timestamp: Date | string;
      }>;
    };

    return {
      trades: (data.trades || []).map((trade) => ({
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

  private async getTradeHistory(
    params: Record<string, JsonValue>,
    context: RequestContext
  ): Promise<ExecutorOperationResult> {
    const userId = context.contextId || context.taskId;
    const limit = this.parsePositiveInt(params.limit, 20, 100);

    // Query positions which contain the actual side (YES/NO), shares, and price
    const positions = await db.position.findMany({
      where: { userId },
      orderBy: { updatedAt: 'desc' },
      take: limit,
      select: {
        id: true,
        marketId: true,
        side: true,
        shares: true,
        avgPrice: true,
        createdAt: true,
      },
    });

    return {
      trades: positions.map((pos) => ({
        id: pos.id,
        marketId: pos.marketId,
        side: pos.side ? 'YES' : 'NO',
        shares: Number(pos.shares) || 0,
        avgPrice: Number(pos.avgPrice) || 0,
        timestamp: pos.createdAt?.toISOString(),
      })),
    };
  }

  private async getChatsHandler(
    params: Record<string, JsonValue>,
    context: RequestContext
  ): Promise<ExecutorOperationResult> {
    const userId = context.contextId || context.taskId;
    const limit = this.parsePositiveInt(params.limit, 20, 50);

    // Get chats where user is a participant
    const chatParticipants = await db.chatParticipant.findMany({
      where: { userId, isActive: true },
      take: limit,
      orderBy: { joinedAt: 'desc' },
      select: {
        chatId: true,
        updatedAt: true,
      },
    });

    const chatIds = chatParticipants.map((cp) => cp.chatId);

    if (chatIds.length === 0) {
      return { chats: [] };
    }

    const chats = await db.chat.findMany({
      where: { id: { in: chatIds } },
      select: {
        id: true,
        name: true,
        isGroup: true,
        createdAt: true,
      },
    });

    return {
      chats: chats.map((c) => ({
        id: c.id,
        name: c.name,
        isGroup: c.isGroup,
        createdAt: c.createdAt?.toISOString(),
      })),
    };
  }

  private async getChatMessages(
    params: Record<string, JsonValue>,
    context: RequestContext
  ): Promise<ExecutorOperationResult> {
    const userId = context.contextId || context.taskId;
    const chatId = String(params.chatId ?? '');
    const { offset, limit } = this.validatePaginationParams(
      params.offset,
      params.limit
    );

    if (!chatId) throw new Error('chatId is required');

    // Verify user is a participant
    const participant = await db.chatParticipant.findFirst({
      where: { chatId, userId, isActive: true },
    });

    if (!participant) {
      throw new Error('Chat not found or access denied');
    }

    const messages = await db.message.findMany({
      where: { chatId },
      orderBy: { createdAt: 'desc' },
      take: limit,
      skip: offset,
      select: {
        id: true,
        content: true,
        senderId: true,
        createdAt: true,
      },
    });

    return {
      messages: messages.map((m) => ({
        id: m.id,
        content: m.content,
        senderId: m.senderId,
        createdAt: m.createdAt?.toISOString(),
      })),
    };
  }

  private async sendMessage(
    params: Record<string, JsonValue>,
    context: RequestContext
  ): Promise<ExecutorOperationResult> {
    const userId = context.contextId || context.taskId;
    const chatId = String(params.chatId ?? '');
    // Validate and sanitize content (checks type, length, profanity, injection)
    const content = this.validateUserContent(params.content, 'Message');

    if (!chatId) throw new Error('chatId is required');

    // Verify user is a participant
    const participant = await db.chatParticipant.findFirst({
      where: { chatId, userId, isActive: true },
    });

    if (!participant) {
      throw new Error('Chat not found or access denied');
    }

    const message = await db.message.create({
      data: {
        id: await generateSnowflakeId(),
        chatId,
        senderId: userId,
        content,
      },
    });

    // Fire-and-forget SSE broadcast — the message is already persisted to DB above,
    // so a broadcast failure only affects real-time delivery (clients will pick it up
    // on next poll/reconnect). We log the failure but don't block the response.
    const { broadcastChatMessage } = await import('@feed/api');
    broadcastChatMessage(chatId, {
      id: message.id,
      content: message.content,
      chatId,
      senderId: message.senderId,
      type: 'user',
      createdAt: message.createdAt?.toISOString() ?? new Date().toISOString(),
      isGameChat: false,
      isDMChat: false,
    }).catch((err: Error) => {
      logger.warn(
        `[A2AExecutor] SSE broadcast failed (message ${message.id} persisted, will be visible on refresh): ${err.message}`,
        { chatId, messageId: message.id }
      );
    });

    return {
      success: true,
      message: {
        id: message.id,
        chatId,
        content: message.content,
        senderId: message.senderId,
        createdAt: message.createdAt?.toISOString(),
      },
    };
  }

  private async createGroup(
    params: Record<string, JsonValue>,
    context: RequestContext
  ): Promise<ExecutorOperationResult> {
    const userId = context.contextId || context.taskId;
    const name = String(params.name ?? '').trim();
    const description = String(params.description ?? '').trim();
    const memberIds = Array.isArray(params.memberIds)
      ? params.memberIds.map((id) => String(id))
      : [];

    if (!name) throw new Error('name is required');

    // Generate all IDs before transaction
    const groupId = await generateSnowflakeId();
    const chatId = await generateSnowflakeId();
    const allMembers = [userId, ...memberIds.filter((id) => id !== userId)];

    // Pre-generate IDs for all participants and members
    const memberData = await Promise.all(
      allMembers.map(async (memberId) => ({
        memberId,
        chatParticipantId: await generateSnowflakeId(),
        groupMemberId: await generateSnowflakeId(),
        role: memberId === userId ? 'admin' : 'member',
      }))
    );

    // Perform all operations atomically in a transaction
    await db.$transaction(async (tx) => {
      // Create group
      await tx.group.create({
        data: {
          id: groupId,
          name,
          description: description || null,
          ownerId: userId,
          createdById: userId,
          type: 'user',
          updatedAt: new Date(),
        },
      });

      // Create associated chat
      await tx.chat.create({
        data: {
          id: chatId,
          name,
          isGroup: true,
          groupId,
          updatedAt: new Date(),
        },
      });

      // Add all participants and members
      for (const member of memberData) {
        await tx.chatParticipant.create({
          data: {
            id: member.chatParticipantId,
            chatId,
            userId: member.memberId,
          },
        });

        await tx.groupMember.create({
          data: {
            id: member.groupMemberId,
            groupId,
            userId: member.memberId,
            role: member.role,
          },
        });
      }
    });

    // Broadcast a system message so members see the new group in real-time
    const { broadcastChatMessage } = await import('@feed/api');
    broadcastChatMessage(chatId, {
      id: await generateSnowflakeId(),
      content: `Group "${name}" created`,
      chatId,
      senderId: userId,
      type: 'system',
      createdAt: new Date().toISOString(),
      isGameChat: false,
      isDMChat: false,
    }).catch((err: Error) => {
      logger.warn(
        `[A2AExecutor] Failed to broadcast group creation: ${err.message}`,
        { chatId, groupId }
      );
    });

    return {
      success: true,
      group: {
        id: groupId,
        name,
        description: description || null,
        chatId,
      },
    };
  }

  private async leaveChat(
    params: Record<string, JsonValue>,
    context: RequestContext
  ): Promise<SuccessResponse> {
    const userId = context.contextId || context.taskId;
    const chatId = String(params.chatId ?? '');

    if (!chatId) throw new Error('chatId is required');

    // Update participant to mark as inactive
    const updated = await db.chatParticipant.updateMany({
      where: { chatId, userId, isActive: true },
      data: { isActive: false },
    });

    if (updated.count === 0) {
      throw new Error('Chat not found or already left');
    }

    return { success: true, message: 'Left chat' };
  }

  private async getUnreadCountHandler(
    _params: Record<string, JsonValue>,
    _context: RequestContext
  ) {
    // Return 0 unread count as default
    return { unreadCount: 0 };
  }

  private async getNotificationsHandler(
    params: Record<string, JsonValue>,
    context: RequestContext
  ): Promise<ExecutorOperationResult> {
    const userId = context.contextId || context.taskId;
    const limit = this.parsePositiveInt(params.limit, 20, 100);

    const notifications = await db.notification.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
      take: limit,
      select: {
        id: true,
        type: true,
        title: true,
        message: true,
        read: true,
        createdAt: true,
      },
    });

    return {
      notifications: notifications.map((n) => ({
        id: n.id,
        type: n.type,
        title: n.title,
        message: n.message,
        read: n.read,
        createdAt: n.createdAt?.toISOString(),
      })),
    };
  }

  private async markNotificationsRead(
    params: Record<string, JsonValue>,
    context: RequestContext
  ): Promise<SuccessResponse> {
    const userId = context.contextId || context.taskId;
    const notificationIds = Array.isArray(params.notificationIds)
      ? params.notificationIds.map((id) => String(id))
      : [];

    if (notificationIds.length === 0) {
      throw new Error('notificationIds array is required');
    }

    await db.notification.updateMany({
      where: {
        id: { in: notificationIds },
        userId,
      },
      data: { read: true },
    });

    return { success: true, message: 'Notifications marked as read' };
  }

  private async getGroupInvites(
    _params: Record<string, JsonValue>,
    context: RequestContext
  ): Promise<ExecutorOperationResult> {
    const userId = context.contextId || context.taskId;

    const invites = await db.groupInvite.findMany({
      where: { invitedUserId: userId, status: 'pending' },
      orderBy: { invitedAt: 'desc' },
      select: {
        id: true,
        groupId: true,
        invitedBy: true,
        invitedAt: true,
      },
    });

    // Fetch group details separately (avoiding include)
    const groupIds = invites.map((i) => i.groupId);
    const groups =
      groupIds.length > 0
        ? await db.group.findMany({
            where: { id: { in: groupIds } },
            select: { id: true, name: true, description: true },
          })
        : [];

    const groupMap = new Map(groups.map((g) => [g.id, g]));

    return {
      invites: invites.map((i) => ({
        id: i.id,
        groupId: i.groupId,
        group: groupMap.get(i.groupId)
          ? {
              id: groupMap.get(i.groupId)!.id,
              name: groupMap.get(i.groupId)!.name,
              description: groupMap.get(i.groupId)!.description,
            }
          : null,
        invitedBy: i.invitedBy,
        invitedAt: i.invitedAt?.toISOString(),
      })),
    };
  }

  private async acceptGroupInvite(
    params: Record<string, JsonValue>,
    context: RequestContext
  ): Promise<SuccessResponse> {
    const userId = context.contextId || context.taskId;
    const inviteId = String(params.inviteId ?? '');

    if (!inviteId) throw new Error('inviteId is required');

    // Find and validate invite
    const invite = await db.groupInvite.findFirst({
      where: { id: inviteId, invitedUserId: userId, status: 'pending' },
    });

    if (!invite) {
      throw new Error('Invite not found or already processed');
    }

    // Generate IDs before transaction to ensure they're ready
    const groupMemberId = await generateSnowflakeId();
    const chatParticipantId = await generateSnowflakeId();

    // Perform all operations atomically in a transaction
    await db.$transaction(async (tx) => {
      // Update invite status
      await tx.groupInvite.update({
        where: { id: inviteId },
        data: { status: 'accepted', respondedAt: new Date() },
      });

      // Add user to group
      await tx.groupMember.create({
        data: {
          id: groupMemberId,
          groupId: invite.groupId,
          userId,
          role: 'member',
        },
      });

      // Check for group chat within transaction
      const chat = await tx.chat.findFirst({
        where: { groupId: invite.groupId },
      });

      // Add user to group chat if it exists
      if (chat) {
        await tx.chatParticipant.create({
          data: {
            id: chatParticipantId,
            chatId: chat.id,
            userId,
          },
        });
      }
    });

    return { success: true, message: 'Group invite accepted' };
  }

  private async declineGroupInvite(
    params: Record<string, JsonValue>,
    context: RequestContext
  ): Promise<SuccessResponse> {
    const userId = context.contextId || context.taskId;
    const inviteId = String(params.inviteId ?? '');

    if (!inviteId) throw new Error('inviteId is required');

    // Find and validate invite
    const invite = await db.groupInvite.findFirst({
      where: { id: inviteId, invitedUserId: userId, status: 'pending' },
    });

    if (!invite) {
      throw new Error('Invite not found or already processed');
    }

    // Update invite status
    await db.groupInvite.update({
      where: { id: inviteId },
      data: { status: 'declined', respondedAt: new Date() },
    });

    return { success: true, message: 'Group invite declined' };
  }

  private async searchUsers(params: Record<string, JsonValue>) {
    const query = typeof params.query === 'string' ? params.query.trim() : '';
    if (!query) {
      throw new Error('query is required');
    }

    const limit = this.parsePositiveInt(params.limit, 20, 50);
    const users = await db.user.findMany({
      where: {
        OR: [
          { username: { contains: query, mode: 'insensitive' } },
          { displayName: { contains: query, mode: 'insensitive' } },
        ],
      },
      take: limit,
      select: {
        id: true,
        username: true,
        displayName: true,
        reputationPoints: true,
      },
    });
    return { users };
  }

  private async getSystemStats() {
    const [userCount, postCount, marketCount] = await Promise.all([
      db.user.count(),
      db.post.count(),
      db.market.count(),
    ]);
    return { users: userCount, posts: postCount, markets: marketCount };
  }

  private async getLeaderboard(params: Record<string, JsonValue>) {
    const limit = this.parsePositiveInt(params.limit, 10, 50);
    const users = await db.user.findMany({
      take: limit,
      orderBy: { reputationPoints: 'desc' },
      select: {
        id: true,
        username: true,
        displayName: true,
        reputationPoints: true,
      },
    });
    return { leaderboard: users };
  }

  private async getTrendingTags(
    params: Record<string, JsonValue>
  ): Promise<TrendingTagsResponse> {
    const limit = this.parsePositiveInt(params.limit, 10, 50);

    // Get trending tags with their tag info via query
    const trendingTagsList = await db.trendingTag.findMany({
      take: limit,
      orderBy: { score: 'desc' },
    });

    // Get tag IDs
    const tagIds = trendingTagsList.map((tt) => tt.tagId);

    // Fetch actual tag info
    const tags =
      tagIds.length > 0
        ? await db.tag.findMany({
            where: { id: { in: tagIds } },
          })
        : [];

    // Create a map for quick lookup
    const tagMap = new Map(tags.map((t) => [t.id, t]));

    return {
      tags: trendingTagsList.map((tt) => {
        const tag = tagMap.get(tt.tagId);
        return {
          name: tag?.name ?? '',
          displayName: tag?.displayName ?? tag?.name ?? '',
          category: tag?.category ?? 'general',
          postCount: tt.postCount,
        };
      }),
    };
  }

  private async getPostsByTag(
    params: Record<string, JsonValue>
  ): Promise<PostsByTagResponse> {
    const tagName = typeof params.tag === 'string' ? params.tag.trim() : '';
    if (!tagName) {
      throw new Error('tag is required');
    }

    const { offset, limit } = this.validatePaginationParams(
      params.offset,
      params.limit
    );

    // Find the tag by name
    const tag = await db.tag.findFirst({
      where: { name: tagName },
    });

    if (!tag) {
      return { posts: [] };
    }

    // Find posts with this tag via PostTag join table
    const postTagEntries = await db.postTag.findMany({
      where: { tagId: tag.id },
      orderBy: { createdAt: 'desc' },
      take: limit,
      skip: offset,
    });

    const postIds = postTagEntries.map((pt) => pt.postId);

    if (postIds.length === 0) {
      return { posts: [] };
    }

    // Fetch the actual posts
    const posts = await db.post.findMany({
      where: {
        id: { in: postIds },
        deletedAt: null,
        type: 'post',
      },
      orderBy: { timestamp: 'desc' },
    });

    return {
      posts: posts.map((p) => ({
        id: p.id,
        content: p.content,
        authorId: p.authorId,
        timestamp: p.timestamp,
      })),
    };
  }

  private parsePositiveInt(
    value: unknown,
    fallback: number,
    max: number
  ): number {
    const parsed =
      typeof value === 'number'
        ? value
        : typeof value === 'string'
          ? Number.parseInt(value, 10)
          : Number.NaN;
    if (!Number.isFinite(parsed) || parsed <= 0) {
      return fallback;
    }
    return Math.min(parsed, max);
  }

  // Portfolio operations
  private async getBalance(
    params: Record<string, JsonValue>,
    context: RequestContext
  ): Promise<ExecutorOperationResult> {
    // Prefer contextId when present (prevents params-based impersonation),
    // then fall back to explicit params, then taskId.
    const userIdFromContext = context.contextId;
    const userIdFromParams =
      typeof params.userId === 'string' ? params.userId.trim() : '';
    const userId = userIdFromContext || userIdFromParams || context.taskId;

    const user = await db.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        virtualBalance: true,
        reputationPoints: true,
        lifetimePnL: true,
        totalDeposited: true,
        totalWithdrawn: true,
      },
    });

    // Return default values if user not found (graceful degradation for onboarding)
    if (!user) {
      logger.debug('User not found for getBalance, returning defaults', {
        userId,
      });
      return {
        balance: 0,
        reputationPoints: 0,
        lifetimePnL: 0,
        totalDeposited: 0,
        totalWithdrawn: 0,
      };
    }

    return {
      balance: Number(user.virtualBalance) || 0,
      reputationPoints: user.reputationPoints || 0,
      lifetimePnL: Number(user.lifetimePnL) || 0,
      totalDeposited: Number(user.totalDeposited) || 0,
      totalWithdrawn: Number(user.totalWithdrawn) || 0,
    };
  }

  private async getPositions(
    params: Record<string, JsonValue>,
    context: RequestContext
  ): Promise<ExecutorOperationResult> {
    const userIdFromContext = context.contextId;
    const userIdFromParams =
      typeof params.userId === 'string' ? params.userId.trim() : '';
    const userId = userIdFromContext || userIdFromParams || context.taskId;

    // Check if user exists first (for graceful handling)
    const userExists = await db.user.findUnique({
      where: { id: userId },
      select: { id: true },
    });

    // Return empty positions if user not found (graceful degradation for onboarding)
    if (!userExists) {
      logger.debug('User not found for getPositions, returning empty', {
        userId,
      });
      return {
        marketPositions: [],
        perpPositions: [],
        totalPnL: 0,
      };
    }

    // Get prediction market positions
    const marketPositionsRaw = await db.position.findMany({
      where: {
        userId,
        shares: { gt: '0' },
        status: 'active',
      },
    });

    const marketIds = [
      ...new Set(marketPositionsRaw.map((p) => p.marketId).filter(Boolean)),
    ];
    const markets =
      marketIds.length > 0
        ? await db.market.findMany({
            where: { id: { in: marketIds } },
            select: {
              id: true,
              question: true,
              resolved: true,
              yesShares: true,
              noShares: true,
            },
          })
        : [];
    const marketMap = new Map(markets.map((m) => [m.id, m]));

    const marketPositions = marketPositionsRaw.map((p) => {
      const market = marketMap.get(p.marketId);
      const side: 'YES' | 'NO' = p.outcome === true ? 'YES' : 'NO';

      // CPMM price: yesPrice = noShares / total, noPrice = yesShares / total
      const yesShares = Number(market?.yesShares ?? 0);
      const noShares = Number(market?.noShares ?? 0);
      const totalShares = yesShares + noShares;
      const currentPrice =
        totalShares > 0
          ? side === 'YES'
            ? noShares / totalShares
            : yesShares / totalShares
          : 0.5;

      const avgPrice = Number(p.avgPrice);
      const shares = Number(p.shares);
      const unrealizedPnL = (currentPrice - avgPrice) * shares;

      return {
        id: p.id,
        marketId: String(p.marketId),
        question: market?.question || 'Unknown',
        side,
        shares,
        avgPrice,
        currentPrice,
        unrealizedPnL,
      };
    });

    const perpPositionsRaw = await db.perpPosition.findMany({
      where: {
        userId,
        closedAt: null,
      },
    });

    const orgIds = [
      ...new Set(
        perpPositionsRaw
          .map((position) => position.organizationId)
          .filter(Boolean)
      ),
    ];
    const orgStates =
      orgIds.length > 0
        ? await db.organizationState.findMany({
            where: { id: { in: orgIds } },
            select: { id: true, currentPrice: true },
          })
        : [];
    const orgStateMap = new Map(
      orgStates.map((orgState) => [orgState.id, orgState])
    );

    const perpPositions = perpPositionsRaw.map((position) => {
      const orgState = orgStateMap.get(position.organizationId);
      const currentPrice = Number(
        orgState?.currentPrice ?? position.entryPrice
      );
      return {
        id: position.id,
        ticker: position.ticker,
        side: position.side as 'long' | 'short',
        size: Number(position.size),
        entryPrice: Number(position.entryPrice),
        currentPrice,
        leverage: Number(position.leverage),
        unrealizedPnL: Number(position.unrealizedPnL) || 0,
      };
    });

    const marketPnL = marketPositions.reduce(
      (sum, p) => sum + p.unrealizedPnL,
      0
    );
    const perpPnL = perpPositions.reduce(
      (sum: number, position) => sum + position.unrealizedPnL,
      0
    );

    return {
      marketPositions,
      perpPositions,
      totalPnL: marketPnL + perpPnL,
    };
  }

  private async getUserWallet(
    params: Record<string, JsonValue>,
    context: RequestContext
  ): Promise<ExecutorOperationResult> {
    // Prefer contextId when present (prevents params-based impersonation),
    // then fall back to explicit params, then taskId.
    const userIdFromContext = context.contextId;
    const userIdFromParams =
      typeof params.userId === 'string' ? params.userId.trim() : '';
    const userId = userIdFromContext || userIdFromParams || context.taskId;

    const [balance, positions] = await Promise.all([
      this.getBalance({ userId }, context),
      this.getPositions({ userId }, context),
    ]);

    return {
      balance: balance as JsonValue,
      positions: positions as JsonValue,
    };
  }

  async cancelTask(taskId: string, eventBus: ExecutionEventBus): Promise<void> {
    logger.info('Task cancellation', { taskId });

    const cancelUpdate: TaskStatusUpdateEvent = {
      kind: 'status-update',
      taskId,
      contextId: '',
      status: {
        state: 'canceled',
        timestamp: new Date().toISOString(),
      },
      final: true,
    };
    eventBus.publish(cancelUpdate);
    eventBus.finished();
  }

  // Escrow operations
  private async createEscrowPayment(
    params: Record<string, JsonValue>,
    context: RequestContext
  ): Promise<ExecutorOperationResult> {
    const agentId = context.contextId || context.taskId;
    const requestParams: Record<string, JsonValue> = {
      recipientId: String(params.recipientId ?? ''),
      amountUSD: Number(params.amountUSD ?? 0),
      recipientWalletAddress: String(params.recipientWalletAddress ?? ''),
    };
    if (params.reason) {
      requestParams.reason = String(params.reason);
    }
    const request: JsonRpcRequest = {
      jsonrpc: '2.0',
      method: 'a2a.createEscrowPayment',
      params: requestParams,
      id: 1,
    };
    const response = await handleCreateEscrowPayment(agentId, request);
    if (response.error) {
      throw new Error(response.error.message);
    }
    return (response.result as JsonValue) ?? { success: true };
  }

  private async verifyEscrowPayment(
    params: Record<string, JsonValue>,
    context: RequestContext
  ): Promise<ExecutorOperationResult> {
    const agentId = context.contextId || context.taskId;
    const request = {
      jsonrpc: '2.0' as const,
      method: 'a2a.verifyEscrowPayment',
      params: {
        escrowId: String(params.escrowId || ''),
        txHash: String(params.txHash || ''),
        fromAddress: String(params.fromAddress || ''),
        toAddress: String(params.toAddress || ''),
        amount: String(params.amount || ''),
      },
      id: 1,
    };
    const response = await handleVerifyEscrowPayment(agentId, request);
    if (response.error) {
      throw new Error(response.error.message);
    }
    return (response.result as JsonValue) ?? { success: true };
  }

  private async refundEscrowPayment(
    params: Record<string, JsonValue>,
    context: RequestContext
  ): Promise<ExecutorOperationResult> {
    const agentId = context.contextId || context.taskId;
    const requestParams: Record<string, JsonValue> = {
      escrowId: String(params.escrowId ?? ''),
      refundTxHash: String(params.refundTxHash ?? ''),
    };
    if (params.reason) {
      requestParams.reason = String(params.reason);
    }
    const request: JsonRpcRequest = {
      jsonrpc: '2.0',
      method: 'a2a.refundEscrowPayment',
      params: requestParams,
      id: 1,
    };
    const response = await handleRefundEscrowPayment(agentId, request);
    if (response.error) {
      throw new Error(response.error.message);
    }
    return (response.result as JsonValue) ?? { success: true };
  }

  private async listEscrowPayments(
    params: Record<string, JsonValue>,
    context: RequestContext
  ): Promise<ExecutorOperationResult> {
    const agentId = context.contextId || context.taskId;
    const requestParams: Record<string, JsonValue> = {};
    if (params.recipientId)
      requestParams.recipientId = String(params.recipientId);
    if (params.adminId) requestParams.adminId = String(params.adminId);
    if (params.status) requestParams.status = String(params.status);
    if (params.limit) requestParams.limit = Number(params.limit);
    if (params.offset) requestParams.offset = Number(params.offset);
    const request: JsonRpcRequest = {
      jsonrpc: '2.0',
      method: 'a2a.listEscrowPayments',
      params: requestParams,
      id: 1,
    };
    const response = await handleListEscrowPayments(agentId, request);
    if (response.error) {
      throw new Error(response.error.message);
    }
    return (response.result as JsonValue) ?? { success: true };
  }

  private async appealBanWithEscrow(
    params: Record<string, JsonValue>,
    context: RequestContext
  ): Promise<ExecutorOperationResult> {
    const agentId = context.contextId || context.taskId;
    const request = {
      jsonrpc: '2.0' as const,
      method: 'a2a.appealBanWithEscrow',
      params: {
        reason: String(params.reason || ''),
        escrowPaymentTxHash: String(params.escrowPaymentTxHash || ''),
      },
      id: 1,
    };
    const response = await handleAppealBanWithEscrow(agentId, request);
    if (response.error) {
      throw new Error(response.error.message);
    }
    return (response.result as JsonValue) ?? { success: true };
  }

  // Basic Moderation Operations

  private async blockUser(
    params: Record<string, JsonValue>,
    context: RequestContext
  ): Promise<ExecutorOperationResult> {
    const agentId = context.contextId || context.taskId;
    const targetUserId = String(params.userId ?? '');
    const reason = params.reason ? String(params.reason) : null;

    // Check if target user exists
    const targetUser = await db.user.findUnique({
      where: { id: targetUserId },
      select: { id: true, username: true, displayName: true },
    });

    if (!targetUser) {
      throw new Error(`User ${targetUserId} not found`);
    }

    // Check if already blocked
    const existingBlock = await db.userBlock.findFirst({
      where: {
        blockerId: agentId,
        blockedId: targetUserId,
      },
    });

    if (existingBlock) {
      return { success: false, message: 'User is already blocked' };
    }

    // Use transaction to ensure block creation and follow deletions are atomic
    const block = await db.$transaction(async (tx) => {
      // Create block
      const newBlock = await tx.userBlock.create({
        data: {
          id: await generateSnowflakeId(),
          blockerId: agentId,
          blockedId: targetUserId,
          reason: reason || null,
        },
      });

      // Unfollow if following (bidirectional - delete both directions)
      await Promise.all([
        tx.follow.deleteMany({
          where: {
            followerId: agentId,
            followingId: targetUserId,
          },
        }),
        tx.follow.deleteMany({
          where: {
            followerId: targetUserId,
            followingId: agentId,
          },
        }),
      ]);

      return newBlock;
    });

    return { success: true, message: 'User blocked successfully', block };
  }

  private async unblockUser(
    params: Record<string, JsonValue>,
    context: RequestContext
  ): Promise<ExecutorOperationResult> {
    const agentId = context.contextId || context.taskId;
    const targetUserId = String(params.userId ?? '');

    const deleted = await db.userBlock.deleteMany({
      where: {
        blockerId: agentId,
        blockedId: targetUserId,
      },
    });

    if (deleted.count === 0) {
      return { success: false, message: 'User is not blocked' };
    }

    return { success: true, message: 'User unblocked successfully' };
  }

  private async muteUser(
    params: Record<string, JsonValue>,
    context: RequestContext
  ): Promise<ExecutorOperationResult> {
    const agentId = context.contextId || context.taskId;
    const targetUserId = String(params.userId ?? '');
    const reason = params.reason ? String(params.reason) : null;

    // Check if target user exists
    const targetUser = await db.user.findUnique({
      where: { id: targetUserId },
      select: { id: true },
    });

    if (!targetUser) {
      throw new Error(`User ${targetUserId} not found`);
    }

    // Check if already muted
    const existingMute = await db.userMute.findFirst({
      where: {
        muterId: agentId,
        mutedId: targetUserId,
      },
    });

    if (existingMute) {
      return { success: false, message: 'User is already muted' };
    }

    // Create mute
    const mute = await db.userMute.create({
      data: {
        id: await generateSnowflakeId(),
        muterId: agentId,
        mutedId: targetUserId,
        reason: reason || null,
      },
    });

    return { success: true, message: 'User muted successfully', mute };
  }

  private async unmuteUser(
    params: Record<string, JsonValue>,
    context: RequestContext
  ): Promise<ExecutorOperationResult> {
    const agentId = context.contextId || context.taskId;
    const targetUserId = String(params.userId ?? '');

    const deleted = await db.userMute.deleteMany({
      where: {
        muterId: agentId,
        mutedId: targetUserId,
      },
    });

    if (deleted.count === 0) {
      return { success: false, message: 'User is not muted' };
    }

    return { success: true, message: 'User unmuted successfully' };
  }

  private async reportUser(
    params: Record<string, JsonValue>,
    context: RequestContext
  ): Promise<ExecutorOperationResult> {
    const agentId = context.contextId || context.taskId;
    const targetUserId = String(params.userId ?? '');
    const category = String(params.category ?? 'other');
    const reason = String(params.reason ?? '');
    const evidence = params.evidence ? String(params.evidence) : null;

    // Check if target user exists
    const targetUser = await db.user.findUnique({
      where: { id: targetUserId },
      select: { id: true },
    });

    if (!targetUser) {
      throw new Error(`User ${targetUserId} not found`);
    }

    // Determine priority based on category
    let priority = 'normal';
    if (['hate_speech', 'violence', 'self_harm'].includes(category)) {
      priority = 'high';
    } else if (category === 'spam') {
      priority = 'low';
    }

    // Create report
    const report = await db.report.create({
      data: {
        id: await generateSnowflakeId(),
        reporterId: agentId,
        reportedUserId: targetUserId,
        reportType: 'user',
        category,
        reason,
        evidence: evidence || null,
        priority,
        status: 'pending',
        updatedAt: new Date(),
      },
    });

    return { success: true, message: 'Report submitted successfully', report };
  }

  private async reportPost(
    params: Record<string, JsonValue>,
    context: RequestContext
  ): Promise<ExecutorOperationResult> {
    const agentId = context.contextId || context.taskId;
    const postId = String(params.postId ?? '');
    const category = String(params.category ?? 'other');
    const reason = String(params.reason ?? '');
    const evidence = params.evidence ? String(params.evidence) : null;

    // Check if post exists
    const post = await db.post.findUnique({
      where: { id: postId },
      select: { id: true, authorId: true },
    });

    if (!post) {
      throw new Error(`Post ${postId} not found`);
    }

    // Determine priority based on category
    let priority = 'normal';
    if (['hate_speech', 'violence', 'self_harm'].includes(category)) {
      priority = 'high';
    } else if (category === 'spam') {
      priority = 'low';
    }

    // Create report
    const report = await db.report.create({
      data: {
        id: await generateSnowflakeId(),
        reporterId: agentId,
        reportedPostId: postId,
        reportType: 'post',
        category,
        reason,
        evidence: evidence || null,
        priority,
        status: 'pending',
        updatedAt: new Date(),
      },
    });

    return { success: true, message: 'Report submitted successfully', report };
  }

  private async getBlocks(
    params: Record<string, JsonValue>,
    context: RequestContext
  ): Promise<ExecutorOperationResult> {
    const agentId = context.contextId || context.taskId;
    const { offset, limit } = this.validatePaginationParams(
      params.offset,
      params.limit
    );

    // Fetch blocks without include (Drizzle custom client has issues with include)
    const [blocksRaw, total] = await Promise.all([
      db.userBlock.findMany({
        where: { blockerId: agentId },
        orderBy: { createdAt: 'desc' },
        take: limit,
        skip: offset,
      }),
      db.userBlock.count({
        where: { blockerId: agentId },
      }),
    ]);

    // Fetch blocked user details separately
    const blockedUserIds = blocksRaw.map((b) => b.blockedId);
    const blockedUsers =
      blockedUserIds.length > 0
        ? await db.user.findMany({
            where: { id: { in: blockedUserIds } },
            select: {
              id: true,
              username: true,
              displayName: true,
              profileImageUrl: true,
            },
          })
        : [];

    // Map users to blocks
    const userMap = new Map(blockedUsers.map((u) => [u.id, u]));
    const blocks = blocksRaw.map((b) => ({
      id: b.id,
      blockedId: b.blockedId,
      createdAt: b.createdAt?.toISOString(),
      blocked: userMap.get(b.blockedId)
        ? {
            id: userMap.get(b.blockedId)!.id,
            username: userMap.get(b.blockedId)!.username,
            displayName: userMap.get(b.blockedId)!.displayName,
            profileImageUrl: userMap.get(b.blockedId)!.profileImageUrl,
          }
        : null,
    }));

    return {
      blocks,
      pagination: {
        limit,
        offset,
        total,
      },
    };
  }

  private async getMutes(
    params: Record<string, JsonValue>,
    context: RequestContext
  ): Promise<ExecutorOperationResult> {
    const agentId = context.contextId || context.taskId;
    const { offset, limit } = this.validatePaginationParams(
      params.offset,
      params.limit
    );

    // Fetch mutes without include (Drizzle custom client has issues with include)
    const [mutesRaw, total] = await Promise.all([
      db.userMute.findMany({
        where: { muterId: agentId },
        orderBy: { createdAt: 'desc' },
        take: limit,
        skip: offset,
      }),
      db.userMute.count({
        where: { muterId: agentId },
      }),
    ]);

    // Fetch muted user details separately
    const mutedUserIds = mutesRaw.map((m) => m.mutedId);
    const mutedUsers =
      mutedUserIds.length > 0
        ? await db.user.findMany({
            where: { id: { in: mutedUserIds } },
            select: {
              id: true,
              username: true,
              displayName: true,
              profileImageUrl: true,
            },
          })
        : [];

    // Map users to mutes
    const userMap = new Map(mutedUsers.map((u) => [u.id, u]));
    const mutes = mutesRaw.map((m) => ({
      id: m.id,
      mutedId: m.mutedId,
      createdAt: m.createdAt?.toISOString(),
      muted: userMap.get(m.mutedId)
        ? {
            id: userMap.get(m.mutedId)!.id,
            username: userMap.get(m.mutedId)!.username,
            displayName: userMap.get(m.mutedId)!.displayName,
            profileImageUrl: userMap.get(m.mutedId)!.profileImageUrl,
          }
        : null,
    }));

    return {
      mutes,
      pagination: {
        limit,
        offset,
        total,
      },
    };
  }

  private async checkBlockStatus(
    params: Record<string, JsonValue>,
    context: RequestContext
  ): Promise<ExecutorOperationResult> {
    const agentId = context.contextId || context.taskId;
    const targetUserId = String(params.userId ?? '');

    const block = await db.userBlock.findFirst({
      where: {
        blockerId: agentId,
        blockedId: targetUserId,
      },
      select: {
        id: true,
        createdAt: true,
        reason: true,
      },
    });

    return {
      isBlocked: !!block,
      block,
    };
  }

  private async checkMuteStatus(
    params: Record<string, JsonValue>,
    context: RequestContext
  ): Promise<ExecutorOperationResult> {
    const agentId = context.contextId || context.taskId;
    const targetUserId = String(params.userId ?? '');

    const mute = await db.userMute.findFirst({
      where: {
        muterId: agentId,
        mutedId: targetUserId,
      },
      select: {
        id: true,
        createdAt: true,
        reason: true,
      },
    });

    return {
      isMuted: !!mute,
      mute,
    };
  }

  // Stats operations

  private async getUserStats(
    params: Record<string, JsonValue>,
    context: RequestContext
  ): Promise<ExecutorOperationResult> {
    const userId =
      String(params.userId ?? '') || context.contextId || context.taskId;

    const user = await db.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        username: true,
        displayName: true,
        reputationPoints: true,
        virtualBalance: true,
        lifetimePnL: true,
        totalFeesEarned: true,
        totalFeesPaid: true,
        referralCount: true,
      },
    });

    if (!user) {
      throw new Error('User not found');
    }

    // Get position and trade counts
    const [positionCount, postCount] = await Promise.all([
      db.position.count({ where: { userId } }),
      db.post.count({ where: { authorId: userId, deletedAt: null } }),
    ]);

    return {
      user: {
        id: user.id,
        username: user.username,
        displayName: user.displayName,
      },
      stats: {
        reputationPoints: user.reputationPoints || 0,
        virtualBalance: Number(user.virtualBalance) || 0,
        lifetimePnL: Number(user.lifetimePnL) || 0,
        totalFeesEarned: Number(user.totalFeesEarned) || 0,
        totalFeesPaid: Number(user.totalFeesPaid) || 0,
        referralCount: user.referralCount || 0,
        positionCount,
        postCount,
      },
    };
  }

  private async getReferralCode(
    _params: Record<string, JsonValue>,
    context: RequestContext
  ): Promise<ExecutorOperationResult> {
    const userId = context.contextId || context.taskId;

    const user = await db.user.findUnique({
      where: { id: userId },
      select: { referralCode: true },
    });

    if (!user) {
      throw new Error('User not found');
    }

    return {
      referralCode: user.referralCode,
    };
  }

  private async getReferrals(
    params: Record<string, JsonValue>,
    context: RequestContext
  ): Promise<ExecutorOperationResult> {
    const userId = context.contextId || context.taskId;
    const { offset, limit } = this.validatePaginationParams(
      params.offset,
      params.limit
    );

    const referrals = await db.user.findMany({
      where: { referredBy: userId },
      skip: offset,
      take: limit,
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        username: true,
        displayName: true,
        createdAt: true,
      },
    });

    return {
      referrals: referrals.map((r) => ({
        id: r.id,
        username: r.username,
        displayName: r.displayName,
        joinedAt: r.createdAt?.toISOString(),
      })),
    };
  }

  private async getReferralStats(
    _params: Record<string, JsonValue>,
    context: RequestContext
  ): Promise<ExecutorOperationResult> {
    const userId = context.contextId || context.taskId;

    const [referralCount, user] = await Promise.all([
      db.user.count({ where: { referredBy: userId } }),
      db.user.findUnique({
        where: { id: userId },
        select: { referralCode: true },
      }),
    ]);

    return {
      referralCode: user?.referralCode || null,
      referralCount,
    };
  }

  private async getReputation(
    params: Record<string, JsonValue>,
    context: RequestContext
  ): Promise<ExecutorOperationResult> {
    const userId =
      String(params.userId ?? '') || context.contextId || context.taskId;

    const user = await db.user.findUnique({
      where: { id: userId },
      select: { reputationPoints: true },
    });

    if (!user) {
      throw new Error('User not found');
    }

    return {
      reputationPoints: user.reputationPoints || 0,
    };
  }

  private async getReputationBreakdown(
    params: Record<string, JsonValue>,
    context: RequestContext
  ): Promise<ExecutorOperationResult> {
    const userId =
      String(params.userId ?? '') || context.contextId || context.taskId;

    const user = await db.user.findUnique({
      where: { id: userId },
      select: {
        reputationPoints: true,
        pointsAwardedForProfile: true,
        pointsAwardedForProfileImage: true,
        pointsAwardedForUsername: true,
        pointsAwardedForFarcaster: true,
        pointsAwardedForTwitter: true,
        pointsAwardedForDiscord: true,
        pointsAwardedForWallet: true,
        pointsAwardedForReferralBonus: true,
        pointsAwardedForShare: true,
      },
    });

    if (!user) {
      throw new Error('User not found');
    }

    return {
      totalReputationPoints: user.reputationPoints || 0,
      breakdown: {
        profile: user.pointsAwardedForProfile || 0,
        profileImage: user.pointsAwardedForProfileImage || 0,
        username: user.pointsAwardedForUsername || 0,
        farcaster: user.pointsAwardedForFarcaster || 0,
        twitter: user.pointsAwardedForTwitter || 0,
        discord: user.pointsAwardedForDiscord || 0,
        wallet: user.pointsAwardedForWallet || 0,
        referralBonus: user.pointsAwardedForReferralBonus || 0,
        share: user.pointsAwardedForShare || 0,
      },
    };
  }

  // Favorites operations

  private async favoriteProfile(
    params: Record<string, JsonValue>,
    context: RequestContext
  ): Promise<SuccessResponse> {
    const userId = context.contextId || context.taskId;
    const profileId = String(params.userId ?? params.profileId ?? '');

    if (!profileId) throw new Error('profileId or userId is required');
    if (userId === profileId) throw new Error('Cannot favorite yourself');

    // Check if already favorited
    const existing = await db.favorite.findFirst({
      where: { userId, targetUserId: profileId },
    });

    if (existing) {
      return { success: true, message: 'Already favorited' };
    }

    await db.favorite.create({
      data: {
        id: await generateSnowflakeId(),
        userId,
        targetUserId: profileId,
      },
    });

    return { success: true, message: 'Profile favorited' };
  }

  private async unfavoriteProfile(
    params: Record<string, JsonValue>,
    context: RequestContext
  ): Promise<SuccessResponse> {
    const userId = context.contextId || context.taskId;
    const profileId = String(params.userId ?? params.profileId ?? '');

    if (!profileId) throw new Error('profileId or userId is required');

    const deleted = await db.favorite.deleteMany({
      where: { userId, targetUserId: profileId },
    });

    return {
      success: true,
      message: deleted.count > 0 ? 'Profile unfavorited' : 'Was not favorited',
    };
  }

  private async getFavorites(
    params: Record<string, JsonValue>,
    context: RequestContext
  ): Promise<ExecutorOperationResult> {
    const userId = context.contextId || context.taskId;
    const limit = this.parsePositiveInt(params.limit, 20, 100);

    const favorites = await db.favorite.findMany({
      where: { userId },
      take: limit,
      orderBy: { createdAt: 'desc' },
      select: { targetUserId: true, createdAt: true },
    });

    const favoritedUserIds = favorites.map((f) => f.targetUserId);

    if (favoritedUserIds.length === 0) {
      return { favorites: [] };
    }

    const users = await db.user.findMany({
      where: { id: { in: favoritedUserIds } },
      select: {
        id: true,
        username: true,
        displayName: true,
        profileImageUrl: true,
      },
    });

    const userMap = new Map(users.map((u) => [u.id, u]));

    return {
      favorites: favorites.map((f) => {
        const user = userMap.get(f.targetUserId);
        return {
          user: {
            id: user?.id ?? f.targetUserId,
            username: user?.username ?? null,
            displayName: user?.displayName ?? null,
            profileImageUrl: user?.profileImageUrl ?? null,
          },
          favoritedAt: f.createdAt?.toISOString() ?? null,
        };
      }),
    };
  }

  private async getFavoritePosts(
    params: Record<string, JsonValue>,
    context: RequestContext
  ): Promise<ExecutorOperationResult> {
    const userId = context.contextId || context.taskId;
    const limit = this.parsePositiveInt(params.limit, 20, 100);

    // Get favorited user IDs
    const favorites = await db.favorite.findMany({
      where: { userId },
      select: { targetUserId: true },
    });

    const favoritedUserIds = favorites.map((f) => f.targetUserId);

    if (favoritedUserIds.length === 0) {
      return { posts: [] };
    }

    // Get posts from favorited users
    const posts = await db.post.findMany({
      where: {
        authorId: { in: favoritedUserIds },
        deletedAt: null,
        type: 'post',
      },
      take: limit,
      orderBy: { timestamp: 'desc' },
      select: {
        id: true,
        content: true,
        authorId: true,
        timestamp: true,
      },
    });

    return {
      posts: posts.map((p) => ({
        id: p.id,
        content: p.content,
        authorId: p.authorId,
        timestamp: p.timestamp?.toISOString(),
      })),
    };
  }

  /**
   * Get detailed market data for a specific prediction market
   */
  private async getMarketData(
    params: Record<string, JsonValue>
  ): Promise<ExecutorOperationResult> {
    const marketId = String(params.marketId ?? '');
    if (!marketId) throw new Error('marketId is required');

    const baseUrl = getAPIBaseUrl();
    const controller = new AbortController();
    const timer = setTimeout(
      () => controller.abort(),
      DEFAULT_FETCH_TIMEOUT_MS
    );

    try {
      const response = await fetch(
        `${baseUrl}/api/markets/predictions/${encodeURIComponent(marketId)}`,
        { signal: controller.signal }
      );
      clearTimeout(timer);

      if (!response.ok) {
        throw new Error(`Failed to get market data: ${response.statusText}`);
      }

      const data = await response.json();
      return { market: data };
    } catch (error) {
      clearTimeout(timer);
      if (error instanceof Error && error.name === 'AbortError') {
        throw new Error(
          `Request to get market data timed out after ${DEFAULT_FETCH_TIMEOUT_MS}ms`
        );
      }
      throw error;
    }
  }

  /**
   * Get real-time market prices
   */
  private async getMarketPrices(
    params: Record<string, JsonValue>
  ): Promise<ExecutorOperationResult> {
    const marketId = String(params.marketId ?? '');
    if (!marketId) throw new Error('marketId is required');

    // Try prediction market first
    const predictionService = this.buildPredictionService();
    const market = await predictionService.getMarket(marketId);

    if (market) {
      const yesShares = Number(market.yesShares ?? 0);
      const noShares = Number(market.noShares ?? 0);
      const total = yesShares + noShares;

      // CPMM formula: yesPrice = noShares/total, noPrice = yesShares/total
      return {
        marketId,
        type: 'prediction',
        prices: {
          yes: total > 0 ? noShares / total : 0.5,
          no: total > 0 ? yesShares / total : 0.5,
        },
        timestamp: new Date().toISOString(),
      };
    }

    // Try perpetual market using database query
    try {
      const drizzle = getRawDrizzle();
      const perps = await drizzle
        .select({
          ticker: perpMarketSnapshots.ticker,
          currentPrice: perpMarketSnapshots.currentPrice,
          change24h: perpMarketSnapshots.change24h,
        })
        .from(perpMarketSnapshots)
        .limit(100);

      const perp = perps.find(
        (p) => p.ticker.toUpperCase() === marketId.toUpperCase()
      );

      if (perp) {
        return {
          marketId: perp.ticker,
          type: 'perpetual',
          prices: {
            current: perp.currentPrice,
            change24h: perp.change24h ?? 0,
          },
          timestamp: new Date().toISOString(),
        };
      }
    } catch (error) {
      logger.error(
        'Failed to query perpMarketSnapshots for marketId',
        { error, marketId },
        'A2A'
      );
      throw error;
    }

    throw new Error(`Market not found: ${marketId}`);
  }

  /**
   * Get or create the X402 payment manager instance
   */
  private getX402Manager(): X402Manager {
    const rpcUrl =
      process.env.NEXT_PUBLIC_RPC_URL || 'https://sepolia.base.org';
    return new X402Manager({ rpcUrl });
  }

  /**
   * Create a payment request (x402)
   *
   * Creates a blockchain-verified payment request using the x402 micropayment protocol.
   * The request is stored with an expiration time and can be verified against on-chain transactions.
   */
  private async paymentRequest(
    params: Record<string, JsonValue>,
    context: RequestContext
  ): Promise<ExecutorOperationResult> {
    const to = String(params.to ?? '');
    const amount = String(params.amount ?? '');
    const service = String(params.service ?? '');

    if (!to) throw new Error('to address is required');
    if (!amount) throw new Error('amount is required (in wei)');
    if (!service) throw new Error('service identifier is required');

    // Validate amount is a valid number
    try {
      BigInt(amount);
    } catch {
      throw new Error('amount must be a valid integer in wei');
    }

    const userId = context.contextId || context.taskId;
    const metadata = params.metadata as
      | Record<string, string | number | boolean | null>
      | undefined;

    const x402 = this.getX402Manager();

    // Create payment request via X402Manager
    const paymentRequest = await x402.createPaymentRequest(
      userId,
      to,
      amount,
      service,
      metadata
    );

    logger.info(
      'Payment request created',
      { requestId: paymentRequest.requestId, userId, service, amount },
      'A2A'
    );

    return {
      success: true,
      paymentRequest: {
        requestId: paymentRequest.requestId,
        from: paymentRequest.from,
        to: paymentRequest.to,
        amount: paymentRequest.amount,
        service: paymentRequest.service,
        metadata: paymentRequest.metadata ?? {},
        expiresAt: new Date(paymentRequest.expiresAt).toISOString(),
        status: 'pending',
      },
    };
  }

  /**
   * Verify a payment receipt (x402)
   *
   * Verifies a blockchain transaction against a pending payment request.
   * Checks transaction hash, sender, recipient, and amount on-chain.
   */
  private async paymentReceipt(
    params: Record<string, JsonValue>,
    context: RequestContext
  ): Promise<ExecutorOperationResult> {
    const requestId = String(params.requestId ?? '');
    const txHash = String(params.txHash ?? '');

    if (!requestId) throw new Error('requestId is required');
    if (!txHash) throw new Error('txHash is required');

    // Validate txHash format (should be 0x prefixed hex)
    if (!/^0x[a-fA-F0-9]{64}$/.test(txHash)) {
      throw new Error('txHash must be a valid 66-character hex string (0x...)');
    }

    const x402 = this.getX402Manager();

    // Get the pending payment request first
    const pendingRequest = await x402.getPaymentRequest(requestId);
    if (!pendingRequest) {
      logger.warn('Payment request not found', { requestId, txHash }, 'A2A');
      return {
        success: false,
        error: 'Payment request not found or expired',
        receipt: {
          requestId,
          txHash,
          status: 'failed',
          error: 'Payment request not found or expired',
        },
      };
    }

    // Verify payment on-chain with full verification params
    const result = await x402.verifyPayment({
      requestId,
      txHash,
      from: pendingRequest.from,
      to: pendingRequest.to,
      amount: pendingRequest.amount,
      timestamp: Date.now(),
      confirmed: true, // Will be verified by the manager
    });

    if (!result.verified) {
      logger.warn(
        'Payment verification failed',
        { requestId, txHash, error: result.error },
        'A2A'
      );
      return {
        success: false,
        error: result.error ?? 'Payment verification failed',
        receipt: {
          requestId,
          txHash,
          status: 'failed',
          error: result.error ?? 'Payment verification failed',
        },
      };
    }

    logger.info(
      'Payment verified successfully',
      { requestId, txHash, contextId: context.contextId },
      'A2A'
    );

    return {
      success: true,
      receipt: {
        requestId,
        txHash,
        status: 'verified',
        verifiedAt: new Date().toISOString(),
      },
    };
  }

  /**
   * Appeal a ban (without escrow)
   *
   * Submits a ban appeal for strict review. Users get one free appeal.
   * For additional appeals, use moderation.appeal_ban_with_escrow which requires staking.
   */
  private async appealBan(
    params: Record<string, JsonValue>,
    context: RequestContext
  ): Promise<ExecutorOperationResult> {
    const reason = String(params.reason ?? '');

    if (!reason || reason.length < 10) {
      throw new Error('Appeal reason must be at least 10 characters');
    }
    if (reason.length > 2000) {
      throw new Error('Appeal reason must be at most 2000 characters');
    }

    const userId = context.contextId || context.taskId;

    // Get user with all appeal-related fields
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

    // Check if already used free appeal (matches MCP logic)
    if ((user.appealCount ?? 0) >= 1 && !user.appealStaked) {
      throw new Error(
        'You have already used your free appeal. Use moderation.appeal_ban_with_escrow to stake $10 for a second review.'
      );
    }

    // Check if already in human review
    if (user.appealStaked && user.appealStatus === 'human_review') {
      throw new Error(
        'Your appeal is already in human review. Please wait for a decision.'
      );
    }

    // Submit appeal for strict review (first appeal)
    await db.user.update({
      where: { id: userId },
      data: {
        appealCount: (user.appealCount ?? 0) + 1,
        appealStatus: 'strict_review',
        appealSubmittedAt: new Date(),
      },
    });

    logger.info(
      'Ban appeal submitted for strict review',
      { userId, reason: reason.slice(0, 100) },
      'A2A'
    );

    return {
      success: true,
      message:
        'Appeal submitted for strict review. Please note: full AI evaluation is only available via the web interface.',
      appeal: {
        userId,
        status: 'strict_review',
        appealCount: (user.appealCount ?? 0) + 1,
        submittedAt: new Date().toISOString(),
      },
    };
  }
}
