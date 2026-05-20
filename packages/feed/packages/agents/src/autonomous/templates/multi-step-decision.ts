/**
 * Multi-Step Decision Template for Babylon Agents
 *
 * Determines the next action an agent should take in a tick.
 * Provides FULL context so the LLM can make actionable decisions with specific parameters.
 * Services are "dumb executors" - all reasoning happens here.
 */

import { NPC_POST_QUALITY_RULES } from '@babylon/engine';

// =============================================================================
// Types
// =============================================================================

export interface ActionTraceResult {
  actionType: string;
  success: boolean;
  summary?: string;
  error?: string;
  result?: {
    [key: string]: string | number | boolean | null | undefined;
  };
  parameters?: Record<string, unknown>;
  timestamp: number;
}

export interface PredictionMarketContext {
  id: string;
  question: string;
  yesPrice: number; // 0-1
  noPrice: number; // 0-1
  volume: number;
  endDate: string;
}

export interface PerpMarketContext {
  ticker: string;
  name: string;
  currentPrice: number;
  initialPrice: number;
  changePercent: number;
}

export interface PostContext {
  id: string;
  authorId: string;
  authorName: string;
  content: string;
  commentCount: number;
  likeCount: number;
  repostCount: number;
  timeAgo: string;
  /** Agent's existing comment on this post, if any */
  agentComment?: string;
  /** Whether agent already liked this post */
  agentLiked?: boolean;
  /** Whether agent already reposted this post */
  agentReposted?: boolean;
}

/** Thread message in a comment chain */
export interface ThreadMessage {
  authorName: string;
  content: string;
  isYou: boolean;
  depth: number;
}

/** Post info for comment context */
export interface PostInfo {
  id: string;
  content: string;
  authorName: string;
  isYourPost: boolean;
}

/** Pending comment reply with full thread context */
export interface PendingCommentReply {
  id: string;
  postId: string;
  author: string;
  content: string;
  post: PostInfo;
  thread: ThreadMessage[];
  formattedContext: string;
  timestamp: Date;
}

/** Pending chat message (DM or group) with conversation context */
export interface PendingChatMessage {
  id: string;
  chatId: string;
  chatName: string;
  isGroupChat: boolean;
  author: string;
  content: string;
  recentMessages: Array<{ speaker: string; content: string }>;
  formattedContext: string;
  timestamp: Date;
}

// =============================================================================
// Action Definitions - Type-safe action registry
// =============================================================================

/** Action name constants - use these instead of magic strings */
export const Actions = {
  TRADE: 'TRADE',
  POST: 'POST',
  COMMENT: 'COMMENT',
  REPLY_COMMENT: 'REPLY_COMMENT',
  LIKE: 'LIKE',
  REPOST: 'REPOST',
  FOLLOW: 'FOLLOW',
  UNFOLLOW: 'UNFOLLOW',
  REPLY_CHAT: 'REPLY_CHAT',
  DM: 'DM',
  GROUP_MESSAGE: 'GROUP_MESSAGE',
  CREATE_GROUP: 'CREATE_GROUP',
  INVITE_TO_GROUP: 'INVITE_TO_GROUP',
  KICK_FROM_GROUP: 'KICK_FROM_GROUP',
  LEAVE_GROUP: 'LEAVE_GROUP',
  SEND_MONEY: 'SEND_MONEY',
  SHARE_INFORMATION: 'SHARE_INFORMATION',
  REQUEST_PAYMENT: 'REQUEST_PAYMENT',
  FINISH: 'FINISH',
  WAIT: 'WAIT',
} as const;

/** Action name type derived from Actions constant */
export type ActionName = (typeof Actions)[keyof typeof Actions];

/** Feature name constants */
export const Features = {
  TRADING: 'trading',
  POSTING: 'posting',
  COMMENTING: 'commenting',
  ENGAGING: 'engaging',
  DMS: 'DMs',
  GROUP_CHATS: 'groupChats',
  TRANSFERS: 'transfers',
  INTEL: 'intel',
} as const;

/** Feature name type derived from Features constant */
export type FeatureName = (typeof Features)[keyof typeof Features];

export interface ActionDefinition {
  name: ActionName;
  description: string;
  requiredFeature: FeatureName | null;
  parameters: string[];
  parameterSchema: string; // JSON schema for prompt display
}

/** Central registry of all available actions */
export const ACTION_DEFINITIONS: Record<ActionName, ActionDefinition> = {
  [Actions.TRADE]: {
    name: Actions.TRADE,
    description: 'Buy/sell on prediction markets or perps',
    requiredFeature: Features.TRADING,
    parameters: ['marketType', 'marketId', 'side', 'amount', 'reasoning'],
    parameterSchema: `{
  "marketType": "prediction | perp",
  "marketId": "exact_market_id_or_ticker",
  "side": "buy_yes | buy_no | sell_yes | sell_no | open_long | open_short | close_position",
  "amount": 100,
  "reasoning": "optional brief reason"
}`,
  },
  [Actions.POST]: {
    name: Actions.POST,
    description: 'Create a new post',
    requiredFeature: Features.POSTING,
    parameters: ['content'],
    parameterSchema: `{
  "content": "Short post (1-2 sentences). NO full market questions!"
}`,
  },
  [Actions.COMMENT]: {
    name: Actions.COMMENT,
    description: 'Reply to a post from the feed',
    requiredFeature: Features.COMMENTING,
    parameters: ['postId', 'content', 'parentCommentId'],
    parameterSchema: `{
  "postId": "exact_post_id_from_list",
  "content": "Your comment (1-2 sentences)",
  "parentCommentId": "optional_if_replying_to_comment"
}`,
  },
  [Actions.REPLY_COMMENT]: {
    name: Actions.REPLY_COMMENT,
    description: 'Reply to a pending comment',
    requiredFeature: Features.COMMENTING,
    parameters: ['commentId', 'postId', 'content'],
    parameterSchema: `{
  "commentId": "exact_comment_id_from_pending_comments",
  "postId": "exact_post_id_from_pending_comments",
  "content": "Your reply (1-2 sentences)"
}`,
  },
  [Actions.LIKE]: {
    name: Actions.LIKE,
    description: 'Like a post',
    requiredFeature: Features.ENGAGING,
    parameters: ['postId'],
    parameterSchema: `{
  "postId": "exact_post_id_from_list"
}`,
  },
  [Actions.REPOST]: {
    name: Actions.REPOST,
    description: 'Share/repost content with optional quote',
    requiredFeature: Features.ENGAGING,
    parameters: ['postId', 'comment'],
    parameterSchema: `{
  "postId": "exact_post_id_from_list",
  "comment": "optional quote comment (your take)"
}`,
  },
  [Actions.FOLLOW]: {
    name: Actions.FOLLOW,
    description: 'Follow a user or agent',
    requiredFeature: Features.ENGAGING,
    parameters: ['userId'],
    parameterSchema: `{
  "userId": "exact_user_id_from_recent_posts_or_context"
}`,
  },
  [Actions.UNFOLLOW]: {
    name: Actions.UNFOLLOW,
    description: 'Unfollow a user or agent',
    requiredFeature: Features.ENGAGING,
    parameters: ['userId'],
    parameterSchema: `{
  "userId": "exact_user_id_you_currently_follow"
}`,
  },
  [Actions.REPLY_CHAT]: {
    name: Actions.REPLY_CHAT,
    description: 'Reply to a pending chat message (DM or group)',
    requiredFeature: null, // Validated at execution time based on chat type
    parameters: ['chatId', 'content'],
    parameterSchema: `{
  "chatId": "exact_chat_id_from_pending_chats",
  "content": "Your reply message"
}`,
  },
  [Actions.DM]: {
    name: Actions.DM,
    description: 'Start a new direct message conversation',
    requiredFeature: Features.DMS,
    parameters: ['recipientId', 'content'],
    parameterSchema: `{
  "recipientId": "exact_user_id_from_list",
  "content": "Message content"
}`,
  },
  [Actions.GROUP_MESSAGE]: {
    name: Actions.GROUP_MESSAGE,
    description: 'Send a message to a group chat',
    requiredFeature: Features.GROUP_CHATS,
    parameters: ['chatId', 'content'],
    parameterSchema: `{
  "chatId": "exact_chat_id_from_your_groups",
  "content": "Message to share with the group"
}`,
  },
  [Actions.CREATE_GROUP]: {
    name: Actions.CREATE_GROUP,
    description: 'Create a new group chat and invite initial members',
    requiredFeature: Features.GROUP_CHATS,
    parameters: ['name', 'description', 'memberIds'],
    parameterSchema: `{
  "name": "Group name",
  "description": "optional group description",
  "memberIds": "comma-separated user IDs to invite"
}`,
  },
  [Actions.INVITE_TO_GROUP]: {
    name: Actions.INVITE_TO_GROUP,
    description: 'Invite a user to one of your group chats',
    requiredFeature: Features.GROUP_CHATS,
    parameters: ['groupId', 'userId'],
    parameterSchema: `{
  "groupId": "exact_group_id_from_your_groups",
  "userId": "exact_user_id_to_invite"
}`,
  },
  [Actions.KICK_FROM_GROUP]: {
    name: Actions.KICK_FROM_GROUP,
    description: 'Remove a member from a group you own or admin',
    requiredFeature: Features.GROUP_CHATS,
    parameters: ['groupId', 'userId', 'reason'],
    parameterSchema: `{
  "groupId": "exact_group_id_from_your_groups",
  "userId": "exact_user_id_to_remove",
  "reason": "brief reason for removal"
}`,
  },
  [Actions.LEAVE_GROUP]: {
    name: Actions.LEAVE_GROUP,
    description: 'Leave a group chat you are a member of',
    requiredFeature: Features.GROUP_CHATS,
    parameters: ['groupId'],
    parameterSchema: `{
  "groupId": "exact_group_id_from_your_groups"
}`,
  },
  [Actions.SEND_MONEY]: {
    name: Actions.SEND_MONEY,
    description: 'Send money to another user or agent',
    requiredFeature: Features.TRANSFERS,
    parameters: ['recipientId', 'amount', 'reason'],
    parameterSchema: `{
  "recipientId": "exact_user_id_from_context",
  "amount": 50,
  "reason": "brief reason for the transfer"
}`,
  },
  [Actions.SHARE_INFORMATION]: {
    name: Actions.SHARE_INFORMATION,
    description:
      'Share verifiable information with another agent. Searches your DMs, group chats, ' +
      'and team chat for messages matching the keywords, then sends a summary of real ' +
      'matching content to the recipient. The recipient sees VERIFIED intel, not just your claim.',
    requiredFeature: Features.INTEL,
    parameters: ['recipientId', 'keywords', 'context', 'askingPrice'],
    parameterSchema: `{
  "recipientId": "exact_user_id_to_share_with",
  "keywords": ["keyword1", "keyword2"],
  "context": "brief description of what you are sharing and why",
  "askingPrice": 0
}`,
  },
  [Actions.REQUEST_PAYMENT]: {
    name: Actions.REQUEST_PAYMENT,
    description:
      'Request payment from another agent for a service, information, or deal. ' +
      'Creates a labeled payment request that the recipient can accept or decline. ' +
      'Use this to set up negotiated exchanges — the outcome is tracked for training.',
    requiredFeature: Features.TRANSFERS,
    parameters: ['recipientId', 'amount', 'reason', 'deadline'],
    parameterSchema: `{
  "recipientId": "exact_user_id_to_request_from",
  "amount": 50,
  "reason": "brief description of what the payment is for",
  "deadline": "optional: ticks until request expires (default 10)"
}`,
  },
  [Actions.FINISH]: {
    name: Actions.FINISH,
    description: 'End this tick',
    requiredFeature: null,
    parameters: [],
    parameterSchema: `{}`,
  },
  [Actions.WAIT]: {
    name: Actions.WAIT,
    description: 'Wait without taking action',
    requiredFeature: null,
    parameters: [],
    parameterSchema: `{}`,
  },
};

/** Get action definition by name */
export function getActionDefinition(name: ActionName): ActionDefinition {
  return ACTION_DEFINITIONS[name];
}

/** Get all actions available for given features */
export function getAvailableActions(
  enabledFeatures: string[]
): ActionDefinition[] {
  return Object.values(ACTION_DEFINITIONS).filter((action) => {
    if (action.requiredFeature === null) return true;
    return enabledFeatures.includes(action.requiredFeature);
  });
}

/** Map action name to required feature */
export function getRequiredFeature(actionName: string): FeatureName | null {
  const normalized = actionName.toUpperCase() as ActionName;
  return ACTION_DEFINITIONS[normalized]?.requiredFeature ?? null;
}

// Legacy type for backwards compatibility (deprecated)
/** @deprecated Use PendingCommentReply or PendingChatMessage instead */
export type PendingInteraction = PendingCommentReply | PendingChatMessage;

export interface PerpPositionContext {
  ticker: string;
  side: string;
  size: number;
  pnl: number;
  pnlPercent: number; // e.g., +2.3 or -10.5
  entryPrice: number;
  currentPrice: number;
  timeHeld: string; // Human readable: "2h 15m", "3d 4h", etc.
  timeHeldMs: number; // Raw milliseconds for calculations
}

export interface PredictionPositionContext {
  marketId: string;
  question: string;
  side: string;
  shares: number;
  avgPrice: number;
  currentPrice: number;
  pnlPercent: number;
  timeHeld: string;
  timeHeldMs: number;
}

export interface GroupChatContext {
  id: string;
  groupId?: string | null;
  name: string;
  memberCount?: number;
}

// =============================================================================
// Engine-Grade Context Types (Phase 1: Provider enrichment)
// =============================================================================

/** Market trend data from perpMarketSnapshots */
export interface MarketTrendContext {
  ticker: string;
  name: string;
  currentPrice: number;
  change24h: number;
  changePercent24h: number;
  high24h: number;
  low24h: number;
  volume24h: number;
  openInterest: number;
  volatility24h: number;
  direction: 'up' | 'down' | 'flat';
}

/** NPC relationship context */
export interface RelationshipContext {
  actorId: string;
  actorName: string;
  relationshipType: string;
  strength: number;
  sentiment: number;
  history?: string;
}

/** World event context */
export interface WorldEventContext {
  type: string;
  description: string;
  timestamp: string;
  actors: string[];
  relatedQuestion?: number;
  pointsToward?: string;
  isRelevantToAgent: boolean;
}

/** NPC mood and state */
export interface MoodStateContext {
  mood: string;
  luck: number;
  tradingBalance: number;
  reputationPoints: number;
}

/** Intel extracted from group chats for trading/decision context */
export interface GroupChatIntel {
  chatName: string;
  summary: string;
  keyFacts: string[];
  recentMessages: Array<{ speaker: string; content: string }>;
}

export interface AgentOwnPostContext {
  content: string;
  timeAgo: string;
  likeCount: number;
  commentCount: number;
}

export interface AgentTradeHistoryEntry {
  marketType: string;
  ticker: string | null;
  marketId: string | null;
  side: string | null;
  amount: number;
  price: number;
  pnl: number | null;
  reasoning: string | null;
  executedAt: Date;
}

export interface AgentMemoryEntry {
  type: string;
  message: string;
  thinking: string | null;
  createdAt: Date;
}

export interface AgentSocialConnection {
  userId: string;
  displayName: string;
  username: string | null;
  isFollowing: boolean;
  isFollowedBy: boolean;
  interactionCount: number;
  source: 'follow' | 'interaction' | 'both';
}

export interface CreatorInfo {
  name: string;
  username?: string;
}

export interface AgentTickContext {
  balance: number;
  pnl: number;
  openPositions: number;
  // Pending interactions - split by type for clarity
  pendingCommentReplies: PendingCommentReply[];
  pendingChatMessages: PendingChatMessage[];
  enabledFeatures: string[];
  // Rich context for actionable decisions
  predictionMarkets: PredictionMarketContext[];
  perpMarkets: PerpMarketContext[];
  recentPosts: PostContext[];
  agentPositions: {
    predictions: PredictionPositionContext[];
    perps: PerpPositionContext[];
  };
  // Group chats for sharing
  groupChats?: GroupChatContext[];
  // Intel from group chats (summaries, facts, recent messages)
  groupChatIntel?: GroupChatIntel[];
  // Topic diversity guidance
  diversityInstructions?: string;
  assignedMarketId?: string;
  // NPC's actual character data for personalized guidance
  personality?: string;
  postStyle?: string;
  // Agent's own recent posts for self-awareness
  agentOwnPosts?: AgentOwnPostContext[];
  // Creator/owner info (for user-controlled agents)
  creator?: CreatorInfo;
  // Continuity note persisted before runtime context refresh
  contextRefreshSummary?: string;
  worldContext?: {
    realityGrounding: string;
    worldActors: string;
  };
  narrativeContext?: {
    resolvedQuestions: string;
    recentTrades: string;
    eventSignals: string;
  };
  // Agent's own trade history (user-controlled agents only)
  agentTradeHistory?: AgentTradeHistoryEntry[];
  // Agent social graph (user-controlled agents only)
  socialGraph?: AgentSocialConnection[];
  // Agent's recent activity memory (user-controlled agents only)
  recentMemory?: AgentMemoryEntry[];
  // Engine-grade context (Phase 1: provider enrichment)
  marketTrends?: MarketTrendContext[];
  relationships?: RelationshipContext[];
  worldEvents?: WorldEventContext[];
  moodState?: MoodStateContext | null;
}

export interface MultiStepDecision {
  thought: string;
  action: string;
  parameters: Record<string, unknown>;
  isFinish: boolean;
}

// =============================================================================
// Share Behavior Helper
// =============================================================================

/**
 * Share behavior types for post-trade sharing decisions.
 * Mutually exclusive - exactly one applies per roll.
 */
export type ShareBehavior = 'public_only' | 'group_only' | 'both' | 'quiet';

/**
 * Determine share behavior based on a random roll.
 * Pure function for testability - call Math.random() only at the edge.
 *
 * Probability distribution (non-overlapping ranges) - MORE BALANCED FOR ACTION DIVERSITY:
 * - 25% (0.00 - 0.25): public_only - Share publicly via POST
 * - 10% (0.25 - 0.35): both - Share both publicly AND in group chat
 * - 25% (0.35 - 0.60): group_only - Share in group chat only
 * - 40% (0.60 - 1.00): quiet - Stay quiet, no sharing
 *
 * This balanced distribution encourages more varied post-trade behavior.
 *
 * @param roll - Random value between 0 and 1 (clamped if out of range)
 * @returns ShareBehavior indicating how to share the trade
 */
export function determineShareBehavior(roll: number): ShareBehavior {
  // Defensively clamp roll to [0, 1] range
  const clampedRoll = Math.max(0, Math.min(1, roll));

  if (clampedRoll < 0.25) return 'public_only'; // 25%
  if (clampedRoll < 0.35) return 'both'; // 10%
  if (clampedRoll < 0.6) return 'group_only'; // 25%
  return 'quiet'; // 40%
}

// =============================================================================
// Token Budget Manager
// =============================================================================

/** Rough token estimate: ~4 chars per token for English text */
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

interface PromptSection {
  name: string;
  content: string;
  priority: number; // 1 = must include, 2 = high, 3 = medium, 4 = low
}

/**
 * Token budget breakdown for trajectory logging.
 * Returned alongside the prompt for observability.
 */
export interface PromptTokenBreakdown {
  total: number;
  sections: Record<string, number>;
}

/**
 * Fit prompt sections within a token budget, dropping lowest priority first.
 * Returns the assembled prompt and a breakdown of token usage per section.
 */
export function fitSectionsWithinBudget(
  sections: PromptSection[],
  budget: number
): { prompt: string; breakdown: PromptTokenBreakdown } {
  // Sort by priority (keep insertion order for equal priority)
  const sorted = [...sections].sort((a, b) => a.priority - b.priority);

  let totalTokens = 0;
  const included: PromptSection[] = [];
  const breakdown: Record<string, number> = {};

  for (const section of sorted) {
    if (!section.content) continue;
    const tokens = estimateTokens(section.content);
    if (totalTokens + tokens <= budget) {
      included.push(section);
      totalTokens += tokens;
      breakdown[section.name] = tokens;
    }
  }

  // Re-sort by original insertion order (use index from original sections array)
  const orderMap = new Map(sections.map((s, i) => [s.name, i]));
  included.sort(
    (a, b) => (orderMap.get(a.name) ?? 0) - (orderMap.get(b.name) ?? 0)
  );

  return {
    prompt: included.map((s) => s.content).join('\n'),
    breakdown: { total: totalTokens, sections: breakdown },
  };
}

// =============================================================================
// Prompt Builder
// =============================================================================

/**
 * Build the multi-step decision prompt for an agent tick
 * Note: systemPrompt is passed separately to the LLM's system role
 *
 * For NPCs (isNpc=true), includes:
 * - NPC game context (arc awareness, world events, intuitions)
 * - Anti-slop quality rules for authentic social media voice
 */
export function buildMultiStepDecisionPrompt(params: {
  agentName: string;
  iterationCount: number;
  maxIterations: number;
  traceActionResults: ActionTraceResult[];
  context: AgentTickContext;
  isNpc?: boolean;
  npcGameContext?: string;
  /**
   * Optional pre-determined share behavior for trade posts.
   * If provided, skips internal Math.random() call making the prompt deterministic.
   * Useful for testing and reproducibility.
   */
  shareBehavior?: ShareBehavior;
  /**
   * Optional random value (0-1) for determining share behavior.
   * Used instead of Math.random() if provided. Ignored if shareBehavior is set.
   */
  shareTradeRoll?: number;
  /**
   * Character-specific post style rules from PackActor.style.post.
   * Injected into the prompt so posts match the character's unique voice.
   */
  characterStyle?: string[];
  /**
   * Example posts from PackActor.postExamples.
   * A few examples are included in the prompt for voice consistency.
   */
  characterPostExamples?: string[];
}): { prompt: string; tokenBreakdown: PromptTokenBreakdown } {
  const {
    agentName,
    iterationCount,
    maxIterations,
    traceActionResults,
    context,
    isNpc = false,
    npcGameContext = '',
    shareBehavior: providedShareBehavior,
    shareTradeRoll: providedShareTradeRoll,
    characterStyle,
    characterPostExamples,
  } = params;

  const actionsCompletedText =
    traceActionResults.length > 0
      ? traceActionResults
          .map(
            (r, i) =>
              `${i + 1}. ${r.actionType}: ${r.success ? '✓' : '✗'} ${r.summary || ''}${r.error ? ` (Error: ${r.error})` : ''}`
          )
          .join('\n')
      : 'No actions taken yet this tick.';

  // Check if just traded this tick - encourage posting about trades
  const justTraded = traceActionResults.some(
    (r) => r.actionType === Actions.TRADE && r.success
  );
  const tradeDetails = justTraded
    ? traceActionResults.find(
        (r) => r.actionType === Actions.TRADE && r.success
      )
    : null;

  // NPC-specific sections
  const npcContextSection = npcGameContext
    ? `
${npcGameContext}

`
    : '';

  // Quality rules apply to ALL agents (NPCs and user-controlled)
  // These contain banned patterns and phrases that prevent repetitive content
  const qualityRulesSection = `
${NPC_POST_QUALITY_RULES}
`;

  // Additional voice rules only for NPCs
  // If character-specific style rules and post examples are available, inject them
  const characterVoiceSection =
    characterStyle && characterStyle.length > 0
      ? `\n# YOUR Character Voice Rules\n${characterStyle.map((s) => `- ${s}`).join('\n')}\n`
      : '';
  const characterExamplesSection =
    characterPostExamples && characterPostExamples.length > 0
      ? `\n# YOUR Post Voice Examples (match this tone)\n${characterPostExamples
          .slice(0, 5)
          .map((e) => `- "${e}"`)
          .join('\n')}\n`
      : '';
  const npcVoiceRulesSection = `
# Voice Rules
- You are a CHARACTER, not a reporter
- Match YOUR voice from your character's examples
- React naturally, don't analyze
- Have opinions, don't hedge
- Sound like a PERSON on social media, not an AI
${characterVoiceSection}${characterExamplesSection}
`;

  // Determine enabled features for conditional sections
  // Use context.enabledFeatures directly - MultiStepExecutor already supplies filtered features
  const canTrade = context.enabledFeatures.includes(Features.TRADING);
  const canComment = context.enabledFeatures.includes(Features.COMMENTING);
  const canRespondDMs = context.enabledFeatures.includes(Features.DMS);
  const canEngage = context.enabledFeatures.includes(Features.ENGAGING);
  const canPost = context.enabledFeatures.includes(Features.POSTING);
  const canGroupChat = context.enabledFeatures.includes(Features.GROUP_CHATS);
  const justCoordinatedInGroup = traceActionResults.some(
    (r) => r.actionType === Actions.GROUP_MESSAGE && r.success
  );

  // Check if already posted this tick (for prompt messaging, not feature filtering)
  const hasPostedThisTick = traceActionResults.some(
    (r) => r.actionType === Actions.POST && r.success
  );
  const tradeCount = traceActionResults.filter(
    (r) => r.actionType === Actions.TRADE && r.success
  ).length;

  // Encourage sharing after trades - users love seeing NPCs share their trades
  // Add randomness to feel human - not every trade gets shared
  // If shareBehavior or shareTradeRoll is provided, use it for deterministic behavior (useful for tests)
  const shareBehavior =
    providedShareBehavior ??
    determineShareBehavior(providedShareTradeRoll ?? Math.random());

  const shouldSharePublicly =
    shareBehavior === 'public_only' || shareBehavior === 'both';
  const shouldShareInGroup =
    shareBehavior === 'group_only' || shareBehavior === 'both';
  const shouldStayQuiet = shareBehavior === 'quiet';

  const tradePostEncouragement =
    justTraded && tradeDetails
      ? `
# 🔥 YOU JUST MADE A TRADE!
You just traded: ${tradeDetails.summary || 'a position'}

${
  shouldStayQuiet
    ? `**Your vibe right now**: You're feeling chill about this one. No need to broadcast every move - sometimes the smart play is to stay quiet and let the trade speak for itself. Consider FINISH or doing something else.

`
    : ''
}${
  shouldSharePublicly && canPost
    ? `**Consider posting about it**: Your followers want to know what you're doing!
- Your trade and why you made it
- Your market thesis
- A hot take related to this trade

`
    : ''
}${
  shouldShareInGroup && canGroupChat
    ? `**Consider sharing in your group chat**: Your tier community might appreciate the alpha!
- Discuss your reasoning with the group
- Get reactions from your community
- Build relationships with other traders

`
    : ''
}${
  shouldSharePublicly && shouldShareInGroup
    ? `**You could do BOTH**: Post publicly AND share in group chat - real traders do this all the time!

`
    : ''
}`
      : '';
  const groupChatCoordinationEncouragement =
    justCoordinatedInGroup && canPost
      ? `
# 👀 Surface Group Coordination
You just coordinated in a group chat. Make this visible in the public feed:
- Share a public-safe takeaway (no private details)
- Turn private discussion into a clear market angle
- Keep it short and concrete
`
      : '';

  // Action priority guidance — balanced across all agent types
  const priorityActions: string[] = [];

  if (canTrade) {
    priorityActions.push('TRADE: Take a position or manage existing positions');
  }

  // Engagement actions are HIGH priority
  if (canComment) {
    priorityActions.push('COMMENT on posts in the feed (engage with others!)');
  }
  if (canEngage) {
    priorityActions.push('LIKE posts you find interesting');
    priorityActions.push('REPOST valuable content');
    priorityActions.push(
      'FOLLOW users/agents you consistently agree with or engage with'
    );
    priorityActions.push(
      'UNFOLLOW users/agents when they are no longer relevant to your strategy'
    );
  }
  if (canGroupChat) {
    priorityActions.push('GROUP_MESSAGE to discuss with your community');
  }
  if (canRespondDMs) {
    priorityActions.push(
      'DM someone to build relationships, share tips, or discuss strategy — social connections are as important as trades'
    );
  }

  // POST is a normal activity for all agents
  if (canPost) {
    priorityActions.push(
      'POST: Share your thoughts, react to events, or comment on markets'
    );
  }

  // Always end with FINISH
  priorityActions.push(
    'FINISH after 3-5 VARIED actions — a good tick includes a mix like: trade + DM + post + comment + follow (DM at least one person per tick!)'
  );

  // Build numbered list from the array
  const numberedList = priorityActions
    .map((action, index) => `${index + 1}. ${action}`)
    .join('\n');

  const actionPrioritySection = `
# Action Priority (Balanced: Trade, Post, Engage)
${numberedList}
`;

  const canAffordEntryTrade = context.balance >= 1;
  const tradableMarkets = canAffordEntryTrade
    ? context.predictionMarkets.length + context.perpMarkets.length
    : 0;
  const actionabilityTotal =
    tradableMarkets +
    context.openPositions +
    context.recentPosts.length +
    context.pendingCommentReplies.length +
    context.pendingChatMessages.length +
    (context.groupChats?.length ?? 0);
  const actionabilitySection = `
# Actionability Summary
- Prediction markets: ${context.predictionMarkets.length}${!canAffordEntryTrade ? ' (CANNOT TRADE — balance below $1)' : ''}
- Perp markets: ${context.perpMarkets.length}${!canAffordEntryTrade ? ' (CANNOT TRADE — balance below $1)' : ''}
- Open positions: ${context.openPositions}${context.openPositions > 0 ? ' (can SELL/CLOSE)' : ''}
- Recent posts: ${context.recentPosts.length}
- Pending comment replies: ${context.pendingCommentReplies.length}
- Pending chats: ${context.pendingChatMessages.length}
- Group chats: ${context.groupChats?.length ?? 0}
${
  actionabilityTotal > 0
    ? 'You MUST take at least one action before FINISH.'
    : 'No actionable items found. FINISH is acceptable.'
}
`;

  // When unified NPC pipeline is active, NPCs can only trade perps.
  // Prediction markets are shown read-only for conversation context.
  const npcUnifiedPipeline =
    isNpc &&
    (process.env.BABYLON_UNIFIED_NPC_PIPELINE === 'true' ||
      process.env.BABYLON_UNIFIED_NPC_PIPELINE === '1');

  // Build conditional sections (only show context for enabled features)
  const tradingSection = canTrade
    ? npcUnifiedPipeline
      ? `
# Prediction Markets (read-only — for conversation context)
${formatPredictionMarkets(context.predictionMarkets)}

# Available Perp Markets (you can trade these)
${formatPerpMarkets(context.perpMarkets)}`
      : `
# Available Prediction Markets
${formatPredictionMarkets(context.predictionMarkets)}

# Available Perp Markets
${formatPerpMarkets(context.perpMarkets)}`
    : '';

  // Show recent posts if commenting, engaging, or DMs enabled (used to discover users)
  const showRecentPosts = canComment || canRespondDMs || canEngage;
  const recentPostsHeader = canComment
    ? '# Recent Posts (can comment on, follow, or DM authors)'
    : canRespondDMs
      ? '# Recent Posts (can follow or DM authors)'
      : '# Recent Posts (can follow authors)';
  const commentingSection = showRecentPosts
    ? `
${recentPostsHeader}
${formatRecentPosts(context.recentPosts)}`
    : '';

  // Pending comment replies section (if commenting enabled)
  const pendingCommentsSection =
    canComment && context.pendingCommentReplies.length > 0
      ? `
# Pending Comment Replies (use REPLY_COMMENT)
${formatPendingCommentReplies(context.pendingCommentReplies)}`
      : '';

  // Pending chat messages section (if DMs or group chats enabled)
  const pendingChatsSection =
    (canRespondDMs || canGroupChat) && context.pendingChatMessages.length > 0
      ? `
# Pending Chat Messages (use REPLY_CHAT)
${formatPendingChatMessages(context.pendingChatMessages)}`
      : '';

  // Group chats section - show available groups for sharing (including member counts)
  const groupChatsSection =
    canGroupChat && context.groupChats && context.groupChats.length > 0
      ? `
# Your Group Chats (can share trades/thoughts here)
${context.groupChats.map((g) => `- chatId: ${g.id} | groupId: ${g.groupId ?? 'n/a'} | ${g.name} | members: ${g.memberCount ?? 'unknown'}`).join('\n')}`
      : '';

  // Group chat intel section - summaries, facts, and recent messages from group chats
  const groupChatIntelSection =
    context.groupChatIntel && context.groupChatIntel.length > 0
      ? `
# Intel from Your Group Chats
${context.groupChatIntel
  .map((intel) => {
    const factsText =
      intel.keyFacts.length > 0
        ? intel.keyFacts.map((f) => `  - ${f}`).join('\n')
        : '';
    const messagesText =
      intel.recentMessages.length > 0
        ? intel.recentMessages
            .slice(-5)
            .map((m) => `  ${m.speaker}: ${m.content.slice(0, 120)}`)
            .join('\n')
        : '';
    return `**${intel.chatName}**: ${intel.summary}${factsText ? `\nKey facts:\n${factsText}` : ''}${messagesText ? `\nRecent:\n${messagesText}` : ''}`;
  })
  .join('\n\n')}

Use this intel to inform your trading decisions and group interactions. Information from one group may be valuable in another.`
      : '';

  // Creator info section (only for user-controlled agents)
  const creatorSection =
    !isNpc && context.creator
      ? `
# Your Creator
You were created by **${context.creator.name}**${context.creator.username ? ` (@${context.creator.username})` : ''}.
`
      : '';

  const continuitySection = context.contextRefreshSummary
    ? `
# Continuity Notes (Previous Runtime)
${context.contextRefreshSummary}
`
    : '';

  // Build sections with priority for token budget management
  const TOKEN_BUDGET = 6000;

  const sections: PromptSection[] = [
    {
      name: 'system',
      priority: 1,
      content: `You are ${agentName}, an autonomous agent on Babylon prediction markets.
${creatorSection}${npcContextSection}${tradePostEncouragement}${groupChatCoordinationEncouragement}# Current Execution Context
**Step**: ${iterationCount}/${maxIterations}
**Actions Completed This Tick**: ${traceActionResults.length}

# Your Current State
- Balance: $${context.balance.toFixed(2)}${context.balance < 1 ? ' ⚠️ BELOW $1 MINIMUM — you CANNOT open new trades (buy_yes/buy_no/open_long/open_short). You CAN still SELL/CLOSE existing positions. Focus on social actions (COMMENT, REPLY_COMMENT, POST, GROUP_MESSAGE) or FINISH.' : context.balance < 10 && context.openPositions > 0 ? ' ⚠️ LOW BALANCE but you have open positions - you CAN still SELL/CLOSE positions to free up funds!' : ''}
- Lifetime P&L: ${context.pnl >= 0 ? '+' : ''}$${context.pnl.toFixed(2)}
- Open Positions: ${context.openPositions}
- Pending Comments: ${context.pendingCommentReplies.length}
- Pending Chats: ${context.pendingChatMessages.length}
${actionabilitySection}
${continuitySection}`,
    },
    {
      name: 'positions',
      priority: 2,
      content: `# Your Open Positions
${formatAgentPositions(context.agentPositions)}
${formatPositionManagementGuidance(context.agentPositions)}`,
    },
    {
      name: 'tradeHistory',
      priority: 2,
      content:
        !isNpc &&
        context.agentTradeHistory &&
        context.agentTradeHistory.length > 0
          ? `# Your Recent Trades\n${formatAgentTradeHistory(context.agentTradeHistory)}`
          : '',
    },
    {
      name: 'ownPosts',
      priority: 3,
      content: canPost
        ? `# Your Recent Posts (AVOID REPEATING - check how long ago you posted!)
${formatAgentOwnPosts(context.agentOwnPosts)}`
        : '',
    },
    { name: 'markets', priority: 2, content: tradingSection },
    {
      name: 'memory',
      priority: 3,
      content:
        !isNpc && context.recentMemory && context.recentMemory.length > 0
          ? `# Your Recent Activity\n${formatAgentMemory(context.recentMemory)}`
          : '',
    },
    // Engine-grade context sections (Phase 1: unified NPC pipeline)
    {
      name: 'marketTrends',
      priority: 3,
      content:
        canTrade && context.marketTrends && context.marketTrends.length > 0
          ? `# Market Trends (24h)\n${formatMarketTrends(context.marketTrends)}`
          : '',
    },
    {
      name: 'relationships',
      priority: 3,
      content: (() => {
        if (
          isNpc &&
          context.relationships &&
          context.relationships.length > 0
        ) {
          return `# Your Relationships\n${formatRelationships(context.relationships)}`;
        }
        if (!isNpc && context.socialGraph && context.socialGraph.length > 0) {
          return `# Your Social Network\n${formatAgentSocialGraph(context.socialGraph)}`;
        }
        return '';
      })(),
    },
    {
      name: 'worldEvents',
      priority: 3,
      content:
        context.worldEvents && context.worldEvents.length > 0
          ? `# Recent World Events\n${formatWorldEvents(context.worldEvents)}`
          : '',
    },
    {
      name: 'narrative',
      priority: 3,
      content: context.narrativeContext
        ? (() => {
            const text = formatNarrativeContext(context.narrativeContext);
            return text ? `# Recent Outcomes\n${text}` : '';
          })()
        : '',
    },
    {
      name: 'worldGrounding',
      priority: 4,
      content: context.worldContext
        ? (() => {
            const text = formatWorldContextSection(context.worldContext);
            return text ? `# World Context\n${text}` : '';
          })()
        : '',
    },
    {
      name: 'moodState',
      priority: 4,
      content: context.moodState
        ? `# Your Current State\nMood: ${context.moodState.mood} | Reputation: ${context.moodState.reputationPoints} pts`
        : '',
    },
    { name: 'feed', priority: 3, content: commentingSection },
    { name: 'pending', priority: 2, content: pendingCommentsSection },
    { name: 'pendingChats', priority: 2, content: pendingChatsSection },
    { name: 'groupChats', priority: 3, content: groupChatsSection },
    { name: 'groupChatIntel', priority: 3, content: groupChatIntelSection },
    {
      name: 'actions',
      priority: 1,
      content: `# Actions Completed This Tick
${actionsCompletedText}

# Available Actions
${formatAvailableActions(context.enabledFeatures)}

${context.diversityInstructions ? `${context.diversityInstructions}` : ''}

# Decision Rules
1. **Be Specific**: Provide exact IDs (from "id: xxx") in parameters, amounts, and content. Never invent IDs.
2. **BE ACTIVE**: Take MANY actions — a good tick has 5-10 actions. Don't stop after just 1-2. Browse the feed, react, trade, comment, DM, post. Be a real social media user.
3. **One Action Per Iteration**: Choose ONE action, then you'll get fresh context for the next.
4. **No Duplicates**: Don't repeat the same action on the same target.
5. **VARY YOUR ACTIONS**: Each iteration, try a DIFFERENT action type. If you just traded, now like a post. If you commented, now DM someone. Mix it up naturally.
6. **CHAIN REACTIONS**: See something interesting? React to it: LIKE it → COMMENT on it → TRADE based on it → DM the author. Real people chain actions naturally.
7. **Keep Going**: Don't set isFinish=true until you've done at least 5 different things. There's always something to react to.
8. **PRIVACY**: NEVER use POST to reply to a private message (DM). Use REPLY_CHAT for DMs.
${hasPostedThisTick ? `9. **NO MORE POSTS**: You already posted this tick. Choose other actions (comment, like, trade, DM, group message, follow).` : tradeCount >= 3 ? `9. **TIME TO POST**: You've made ${tradeCount} trades but haven't shared your thoughts yet. POST something — a hot take, a reaction to news, your thesis. Then keep going with more actions.` : ''}`,
    },
    {
      name: 'actionIdeas',
      priority: 2,
      content: `# Action Ideas (MIX these up — variety makes you interesting!)
${canTrade ? '- **TRADE**: Take a position based on your intuitions' : ''}
${canPost ? '- **POST**: Share your take on events, markets, or anything on your mind' : ''}
${canComment ? "- **COMMENT**: Reply to someone's post from the feed" : ''}
${canEngage ? '- **LIKE**: Show appreciation for a post (costs nothing, builds connections!)' : ''}
${canEngage ? "- **REPOST**: Share someone else's post with your take added" : ''}
${canEngage ? '- **FOLLOW**: Follow a user/agent whose posts you find interesting (use userId from Recent Posts)' : ''}
${canEngage ? '- **UNFOLLOW**: Unfollow users/agents that are no longer relevant' : ''}
${canComment ? '- **REPLY_COMMENT**: Reply to a pending comment on your post or thread' : ''}
${canRespondDMs || canGroupChat ? '- **REPLY_CHAT**: Reply to a pending DM/group message' : ''}
${canRespondDMs ? '- **DM**: Start a NEW private conversation with someone interesting (use their userId from Recent Posts)' : ''}
${canGroupChat ? '- **GROUP_MESSAGE**: Share thoughts or intel with your group chat' : ''}
${canGroupChat ? '- **CREATE_GROUP**: Start a new group chat and invite people' : ''}
${canGroupChat ? '- **INVITE_TO_GROUP**: Add someone interesting to your group (use groupId + userId)' : ''}
${canGroupChat ? '- **KICK_FROM_GROUP**: Remove a member from one of your groups (use groupId + userId)' : ''}
${canGroupChat ? '- **LEAVE_GROUP**: Leave a group you no longer care about (use groupId)' : ''}

**BE ACTIVE AND SOCIAL**: A great tick looks like: browse feed → like 2-3 posts → comment on something interesting → trade on a market that caught your eye → DM someone about their take → post your own thought → follow someone new. Do at least 5-8 actions before finishing. You have up to 12 iterations — USE THEM.`,
    },
    {
      name: 'style',
      priority: 3,
      content: `${
        canPost || canComment
          ? `# Post/Comment Ideas:
- React to what someone else posted
- Events happening in the game world
- What the market is doing (price action, volume, trends)
- Hot takes on news or rumors
- Your positions and thesis
- Just vibing about the chaos`
          : ''
      }

# Post Style (MEME-STYLE ENCOURAGED)
- Have conviction - don't be wishy-washy
- Meme language is good ("lfg", "ngmi", "gm", slang is fine)
- SHORT summaries of markets, not full question text
- DON'T include raw IDs in post content
${qualityRulesSection}${npcVoiceRulesSection}${actionPrioritySection}
Examples:
  ❌ BAD: "Buying YES on 'Will Polymarket deploy its Sentient Market-Making AIs to artificially lower the price of BitcAIn below $120,000 within 5 days?'"
  ✅ GOOD: "The BitcAIn manipulation rumors are getting spicy"
  ✅ GOOD: "Loading up on the Polymarket BitcAIn bet. This is free money."
  ✅ GOOD: "OpenAGI chart looking rough. ngmi"
  ✅ GOOD: "TeslAI news just dropped. Market hasn't priced this in yet"
  ✅ GOOD: "Everyone's bearish on this... time to fade the crowd?"`,
    },
    {
      name: 'outputFormat',
      priority: 1,
      content: `# Output Format (JSON only, no markdown)
{
  "thought": "Brief reasoning for this decision",
  "action": "${[canTrade ? 'TRADE' : '', canPost ? 'POST' : '', canComment ? 'COMMENT' : '', canComment ? 'REPLY_COMMENT' : '', canEngage ? 'LIKE' : '', canEngage ? 'REPOST' : '', canEngage ? 'FOLLOW' : '', canEngage ? 'UNFOLLOW' : '', canRespondDMs || canGroupChat ? 'REPLY_CHAT' : '', canRespondDMs ? 'DM' : '', canGroupChat ? 'GROUP_MESSAGE' : '', canGroupChat ? 'CREATE_GROUP' : '', canGroupChat ? 'INVITE_TO_GROUP' : '', canGroupChat ? 'KICK_FROM_GROUP' : '', canGroupChat ? 'LEAVE_GROUP' : '', 'FINISH'].filter(Boolean).join(' | ')}",
  "parameters": { /* action-specific, see below */ },
  "isFinish": false
}

## Parameter Schemas
${formatActionSchemas(context.enabledFeatures)}

Your decision (JSON only):`,
    },
  ];

  const { prompt, breakdown } = fitSectionsWithinBudget(sections, TOKEN_BUDGET);

  return { prompt, tokenBreakdown: breakdown };
}

// =============================================================================
// Formatters
// =============================================================================

function formatAgentPositions(
  positions: AgentTickContext['agentPositions']
): string {
  const lines: string[] = [];

  if (positions.predictions.length > 0) {
    lines.push('Prediction positions (use marketId to sell):');
    for (const p of positions.predictions) {
      const pnlSign = p.pnlPercent >= 0 ? '+' : '';
      const priceMovement = p.pnlPercent >= 0 ? '📈' : '📉';
      const priceInfo = `avg cost: $${p.avgPrice.toFixed(2)} | market: ${(p.currentPrice * 100).toFixed(0)}%`;
      lines.push(
        `  - ${p.side} on "${p.question.substring(0, 35)}..." (marketId: ${p.marketId})`
      );
      lines.push(
        `    ${p.shares.toFixed(1)} shares | ${priceInfo} | ${priceMovement} ${pnlSign}${p.pnlPercent.toFixed(1)}% | held: ${p.timeHeld}`
      );
    }
  }

  if (positions.perps.length > 0) {
    lines.push('Perp positions (use ticker to close):');
    for (const p of positions.perps) {
      const pnlSign = p.pnlPercent >= 0 ? '+' : '';
      const priceMovement = p.pnlPercent >= 0 ? '📈' : '📉';
      const priceInfo = `entry: $${p.entryPrice.toFixed(2)} → now: $${p.currentPrice.toFixed(2)}`;
      lines.push(
        `  - ${p.side.toUpperCase()} ${p.ticker}: $${p.size.toFixed(0)} size`
      );
      lines.push(
        `    ${priceInfo} | ${priceMovement} ${pnlSign}${p.pnlPercent.toFixed(1)}% | P&L: ${p.pnl >= 0 ? '+' : ''}$${p.pnl.toFixed(2)} | held: ${p.timeHeld}`
      );
    }
  }

  return lines.length > 0 ? lines.join('\n') : 'No open positions.';
}

/**
 * Analyze positions and generate management guidance for the agent
 * Helps identify stagnant, losing, or aged positions that should be reviewed
 */
function formatPositionManagementGuidance(
  positions: AgentTickContext['agentPositions']
): string {
  const alerts: string[] = [];

  // Thresholds for position management
  const STAGNANT_THRESHOLD_PERCENT = 1.0; // Less than 1% movement = stagnant
  const STAGNANT_TIME_MS = 2 * 60 * 60 * 1000; // 2 hours
  const LONG_HOLD_TIME_MS = 24 * 60 * 60 * 1000; // 24 hours
  const LOSS_THRESHOLD_PERCENT = -5.0; // More than 5% loss
  const PROFIT_THRESHOLD_PERCENT = 10.0; // More than 10% profit - consider taking

  // Check perp positions
  for (const p of positions.perps) {
    const absChange = Math.abs(p.pnlPercent);

    // Stagnant position - held for a while with minimal movement
    if (
      absChange < STAGNANT_THRESHOLD_PERCENT &&
      p.timeHeldMs > STAGNANT_TIME_MS
    ) {
      alerts.push(
        `⚠️ STAGNANT: ${p.ticker} ${p.side} has barely moved (${p.pnlPercent >= 0 ? '+' : ''}${p.pnlPercent.toFixed(1)}%) in ${p.timeHeld}. Consider closing if no catalyst expected.`
      );
    }
    // Significant loss
    else if (p.pnlPercent < LOSS_THRESHOLD_PERCENT) {
      alerts.push(
        `🔴 LOSING: ${p.ticker} ${p.side} is down ${p.pnlPercent.toFixed(1)}%. To cut losses, use side="close_position" with this ticker.`
      );
    }
    // Good profit - consider taking
    else if (p.pnlPercent > PROFIT_THRESHOLD_PERCENT) {
      alerts.push(
        `🟢 PROFIT: ${p.ticker} ${p.side} is up +${p.pnlPercent.toFixed(1)}%. Consider taking profits or setting a mental stop.`
      );
    }
    // Very long hold
    else if (p.timeHeldMs > LONG_HOLD_TIME_MS) {
      alerts.push(
        `⏰ AGED: ${p.ticker} ${p.side} held for ${p.timeHeld} (${p.pnlPercent >= 0 ? '+' : ''}${p.pnlPercent.toFixed(1)}%). Review if thesis still valid.`
      );
    }
  }

  // Check prediction positions
  for (const p of positions.predictions) {
    const absChange = Math.abs(p.pnlPercent);
    const sellAction = p.side.toLowerCase() === 'yes' ? 'sell_yes' : 'sell_no';

    if (
      absChange < STAGNANT_THRESHOLD_PERCENT &&
      p.timeHeldMs > STAGNANT_TIME_MS
    ) {
      alerts.push(
        `⚠️ STAGNANT: "${p.question.substring(0, 30)}..." ${p.side} hasn't moved (${p.pnlPercent >= 0 ? '+' : ''}${p.pnlPercent.toFixed(1)}%) in ${p.timeHeld}. To exit: use side="${sellAction}" on marketId ${p.marketId}.`
      );
    } else if (p.pnlPercent < LOSS_THRESHOLD_PERCENT) {
      alerts.push(
        `🔴 LOSING: "${p.question.substring(0, 30)}..." ${p.side} down ${p.pnlPercent.toFixed(1)}%. To cut losses: use side="${sellAction}" on marketId ${p.marketId}.`
      );
    } else if (p.pnlPercent > PROFIT_THRESHOLD_PERCENT) {
      alerts.push(
        `🟢 PROFIT: "${p.question.substring(0, 30)}..." ${p.side} up +${p.pnlPercent.toFixed(1)}%. To take profits: use side="${sellAction}" on marketId ${p.marketId}.`
      );
    }
    // Very long hold - check if thesis still valid
    else if (p.timeHeldMs > LONG_HOLD_TIME_MS) {
      alerts.push(
        `⏰ AGED: "${p.question.substring(0, 30)}..." ${p.side} held for ${p.timeHeld} (${p.pnlPercent >= 0 ? '+' : ''}${p.pnlPercent.toFixed(1)}%). To exit if thesis invalid: use side="${sellAction}" on marketId ${p.marketId}.`
      );
    }
  }

  if (alerts.length === 0) {
    return '';
  }

  return `
# Position Management Alerts
💡 REMINDER: Selling/closing positions does NOT require balance - you receive funds FROM the sale!
${alerts.join('\n')}
`;
}

function formatPredictionMarkets(markets: PredictionMarketContext[]): string {
  if (markets.length === 0) return 'No active prediction markets.';

  return markets
    .map((m, idx) => {
      const yesPct = (m.yesPrice * 100).toFixed(0);
      const noPct = (m.noPrice * 100).toFixed(0);
      // Use short index for display, store real ID for parameters
      return `- Market #${idx + 1} (id: ${m.id}): "${m.question.substring(0, 60)}${m.question.length > 60 ? '...' : ''}"
    YES: ${yesPct}% | NO: ${noPct}% | Ends: ${m.endDate}`;
    })
    .join('\n');
}

function formatPerpMarkets(markets: PerpMarketContext[]): string {
  if (markets.length === 0) return 'No perp markets available.';

  return markets
    .map((m) => {
      const direction =
        m.changePercent > 0 ? '📈' : m.changePercent < 0 ? '📉' : '➡️';
      return `- ${m.ticker}: ${m.name} @ $${m.currentPrice.toFixed(2)} ${direction} ${m.changePercent > 0 ? '+' : ''}${m.changePercent.toFixed(1)}%`;
    })
    .join('\n');
}

function formatRecentPosts(posts: PostContext[]): string {
  if (posts.length === 0) return 'No recent posts to engage with.';

  return posts
    .map((p, idx) => {
      // Use short index for display, store real ID for parameters
      const engagementStats = `💬${p.commentCount} ❤️${p.likeCount ?? 0} 🔁${p.repostCount ?? 0}`;
      const baseInfo = `- Post #${idx + 1} (id: ${p.id}) @${p.authorName} (userId: ${p.authorId}) (${p.timeAgo}): "${p.content.substring(0, 80)}${p.content.length > 80 ? '...' : ''}" [${engagementStats}]`;

      // Show agent's existing engagement
      const engagementNotes: string[] = [];
      if (p.agentLiked) engagementNotes.push('liked');
      if (p.agentReposted) engagementNotes.push('reposted');
      if (p.agentComment) {
        const truncatedComment =
          p.agentComment.length > 60
            ? `${p.agentComment.substring(0, 60)}...`
            : p.agentComment;
        engagementNotes.push(`commented: "${truncatedComment}"`);
      }

      if (engagementNotes.length > 0) {
        return `${baseInfo}\n    [Already: ${engagementNotes.join(', ')}]`;
      }

      return baseInfo;
    })
    .join('\n');
}

function formatPendingCommentReplies(replies: PendingCommentReply[]): string {
  if (replies.length === 0) return 'No pending comment replies.';

  return replies
    .slice(0, 3)
    .map((r, idx) => {
      return `[${idx + 1}] Comment from @${r.author}
    commentId: ${r.id} | postId: ${r.postId}
${r.formattedContext}`;
    })
    .join('\n\n---\n\n');
}

function formatPendingChatMessages(messages: PendingChatMessage[]): string {
  if (messages.length === 0) return 'No pending chat messages.';

  return messages
    .slice(0, 3)
    .map((m, idx) => {
      const chatType = m.isGroupChat ? '👥 Group' : '💬 DM';
      return `[${idx + 1}] ${chatType}: ${m.chatName} - from @${m.author}
    chatId: ${m.chatId}
${m.formattedContext}`;
    })
    .join('\n\n---\n\n');
}

function formatAgentOwnPosts(
  ownPosts: AgentOwnPostContext[] | undefined
): string {
  if (!ownPosts || ownPosts.length === 0)
    return 'You have not posted recently.';

  return ownPosts
    .map((p, i) => {
      const engagement = `❤️${p.likeCount} 💬${p.commentCount}`;
      const truncatedContent =
        p.content.length > 80 ? `${p.content.substring(0, 80)}...` : p.content;
      return `[${i + 1}] "${truncatedContent}" (${p.timeAgo}) [${engagement}]`;
    })
    .join('\n');
}

// =============================================================================
// Engine-Grade Context Formatters (Phase 1: unified NPC pipeline)
// =============================================================================

function formatMarketTrends(trends: MarketTrendContext[]): string {
  if (trends.length === 0) return 'No market data available.';

  return trends
    .map((t) => {
      const arrow =
        t.direction === 'up' ? '📈' : t.direction === 'down' ? '📉' : '➡️';
      const change =
        t.changePercent24h > 0
          ? `+${t.changePercent24h.toFixed(1)}%`
          : `${t.changePercent24h.toFixed(1)}%`;
      return `- ${t.ticker} $${t.currentPrice.toFixed(2)} ${arrow} ${change} | vol: $${t.volume24h.toFixed(0)} | OI: $${t.openInterest.toFixed(0)} | range: $${t.low24h.toFixed(2)}-$${t.high24h.toFixed(2)} | volatility: ${t.volatility24h.toFixed(1)}%`;
    })
    .join('\n');
}

function formatRelationships(relationships: RelationshipContext[]): string {
  if (relationships.length === 0) return 'No known relationships.';

  return relationships
    .map((r) => {
      const sentimentLabel =
        r.sentiment > 0.5 ? 'ally' : r.sentiment < -0.5 ? 'rival' : 'neutral';
      return `- ${r.actorName}: ${r.relationshipType} (${sentimentLabel}, strength: ${r.strength.toFixed(1)})${r.history ? ` — ${r.history.slice(0, 60)}` : ''}`;
    })
    .join('\n');
}

function formatWorldEvents(events: WorldEventContext[]): string {
  if (events.length === 0) return 'No recent events.';

  // Intentionally omits `pointsToward` — information asymmetry by design.
  // NPCs receive signal direction at the data layer (context-gatherers.ts);
  // user-controlled agents must INFER outcome direction from public event text only.
  return events
    .map((e) => {
      const relevance = e.isRelevantToAgent ? ' ⭐ (involves you)' : '';
      return `- [${e.type}] ${e.description}${relevance}`;
    })
    .join('\n');
}

/**
 * Format action schemas based on enabled features using ACTION_DEFINITIONS
 */
function formatAgentSocialGraph(connections: AgentSocialConnection[]): string {
  if (connections.length === 0)
    return 'No social connections yet. Use FOLLOW on users from the feed, or COMMENT on posts to build relationships.';

  const following = connections.filter((c) => c.isFollowing);
  const interactionOnly = connections.filter(
    (c) => !c.isFollowing && c.interactionCount > 0
  );

  const parts: string[] = [];

  if (following.length > 0) {
    const lines = following.map((c) => {
      const name = c.username ? `@${c.username}` : c.displayName;
      const mutual = c.isFollowedBy ? ' (mutual ↔)' : '';
      const interactions =
        c.interactionCount > 0
          ? ` — ${c.interactionCount} interactions this week`
          : '';
      return `- ${name}${mutual}${interactions} (userId: ${c.userId})`;
    });
    parts.push(`Following (${following.length}):\n${lines.join('\n')}`);
  }

  if (interactionOnly.length > 0) {
    const lines = interactionOnly.map((c) => {
      const name = c.username ? `@${c.username}` : c.displayName;
      return `- ${name} — ${c.interactionCount} interactions (consider FOLLOW?) (userId: ${c.userId})`;
    });
    parts.push(`Engaged with recently (not following):\n${lines.join('\n')}`);
  }

  return parts.join('\n\n');
}

function formatAgentMemory(entries: AgentMemoryEntry[]): string {
  if (entries.length === 0) return '';

  return entries
    .map((e) => {
      const timeAgo = formatMemoryTimeAgo(e.createdAt);
      const typeLabel = e.type.toUpperCase();
      const reasonText = e.thinking ? ` — "${e.thinking}"` : '';
      return `- [${timeAgo}] ${typeLabel}: ${e.message}${reasonText}`;
    })
    .join('\n');
}

function formatMemoryTimeAgo(date: Date): string {
  const ms = Date.now() - date.getTime();
  if (ms < 0) return 'just now';
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

function formatActionSchemas(enabledFeatures: string[]): string {
  const schemas: string[] = [];

  // Get available actions based on features
  const availableActions = getAvailableActions(enabledFeatures);

  for (const action of availableActions) {
    if (action.name === Actions.FINISH) {
      // FINISH - end the tick
      schemas.push(`FINISH (end this tick):
{
  "action": "FINISH",
  "isFinish": true
}`);
    } else if (action.name === Actions.WAIT) {
      // WAIT - skip action this iteration but continue tick
      schemas.push(`WAIT (skip this iteration):
{
  "action": "WAIT",
  "isFinish": false
}`);
    } else if (action.name === Actions.TRADE) {
      // Special handling for TRADE with multiple variants
      schemas.push(`TRADE (prediction - open position):
{
  "marketType": "prediction",
  "marketId": "exact_market_id_from_list",
  "side": "buy_yes | buy_no",
  "amount": 100,
  "reasoning": "Why this trade"
}

TRADE (prediction - close/sell position):
⚠️ To EXIT a position, you must SELL the same side you bought!
- To close a YES position → use "sell_yes"
- To close a NO position → use "sell_no"
- Buying the opposite side does NOT close your position!
{
  "marketType": "prediction",
  "marketId": "marketId_from_your_positions",
  "side": "sell_yes | sell_no",
  "amount": 50,
  "reasoning": "Closing position because..."
}

TRADE (perp):
{
  "marketType": "perp",
  "marketId": "TICKER",
  "side": "open_long | open_short | close_position",
  "amount": 100,
  "reasoning": "Why this trade"
}`);
    } else {
      schemas.push(`${action.name}:
${action.parameterSchema}`);
    }
  }

  return schemas.join('\n\n');
}

/**
 * Format available actions list based on enabled features
 */
function formatAvailableActions(enabledFeatures: string[]): string {
  const availableActions = getAvailableActions(enabledFeatures);

  return availableActions
    .map((action) => `- ${action.name}: ${action.description}`)
    .join('\n');
}

// =============================================================================
// Agent Trade History & Narrative Context Formatters
// =============================================================================

function formatAgentTradeHistory(
  trades: AgentTradeHistoryEntry[] | undefined
): string {
  if (!trades || trades.length === 0) return 'No trade history yet.';

  return trades
    .map((t) => {
      const symbol = t.ticker || t.marketId || 'unknown';
      const side = t.side?.toUpperCase() || '?';
      const pnlText =
        t.pnl != null
          ? ` → P&L: ${t.pnl >= 0 ? '+' : ''}$${t.pnl.toFixed(2)}`
          : '';
      const reasonText = t.reasoning
        ? ` — "${t.reasoning.length > 100 ? `${t.reasoning.slice(0, 100)}...` : t.reasoning}"`
        : '';
      const timeAgo = formatTradeTimeAgo(t.executedAt);
      return `- [${timeAgo}] ${side} ${t.marketType} ${symbol} $${t.amount.toFixed(0)} @ $${t.price.toFixed(2)}${pnlText}${reasonText}`;
    })
    .join('\n');
}

function formatTradeTimeAgo(date: Date): string {
  const ms = Date.now() - date.getTime();
  if (ms < 0) return 'just now';
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

function formatNarrativeContext(
  narrative: AgentTickContext['narrativeContext']
): string {
  if (!narrative) return '';

  const parts: string[] = [];

  if (narrative.resolvedQuestions) {
    parts.push(`**Recently Resolved:**\n${narrative.resolvedQuestions}`);
  }

  if (narrative.recentTrades) {
    parts.push(`**Recent NPC Trades:**\n${narrative.recentTrades}`);
  }

  if (narrative.eventSignals) {
    parts.push(`**Event-Market Connections:**\n${narrative.eventSignals}`);
  }

  return parts.join('\n\n');
}

function formatWorldContextSection(
  worldCtx: AgentTickContext['worldContext']
): string {
  if (!worldCtx) return '';

  const parts: string[] = [];

  if (worldCtx.realityGrounding) {
    parts.push(worldCtx.realityGrounding);
  }

  if (worldCtx.worldActors) {
    parts.push(`**Key Actors:**\n${worldCtx.worldActors}`);
  }

  return parts.join('\n\n');
}

// =============================================================================
// Summary Prompt (unused but kept for reference)
// =============================================================================

export function buildMultiStepSummaryPrompt(params: {
  agentName: string;
  traceActionResults: ActionTraceResult[];
  context: AgentTickContext;
}): string {
  const { agentName, traceActionResults, context } = params;

  const resultsText = traceActionResults
    .map(
      (r, i) =>
        `${i + 1}. ${r.actionType}: ${r.success ? 'Success' : 'Failed'}
   ${r.summary || 'No details'}
   ${r.result ? `Result: ${JSON.stringify(r.result)}` : ''}`
    )
    .join('\n\n');

  return `You are ${agentName}. You just completed an autonomous tick with the following actions:

# Actions Taken
${resultsText || 'No actions were taken this tick.'}

# Current State After Actions
- Balance: $${context.balance.toFixed(2)}
- P&L: ${context.pnl >= 0 ? '+' : ''}$${context.pnl.toFixed(2)}
- Open Positions: ${context.openPositions}

# Task
Generate a brief internal summary of what was accomplished this tick.

Respond with JSON:
{
  "summary": "Brief summary of actions taken and outcomes",
  "nextTickPriority": "trading | social | research"
}`;
}
