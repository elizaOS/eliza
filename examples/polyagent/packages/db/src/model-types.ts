/**
 * Database Model Types
 *
 * Exports inferred types for all database tables.
 * Use these types when you need to explicitly type variables holding database records.
 *
 * Example:
 *   import type { User, Post, Market } from '@babylon/db';
 *
 *   const user: User = await db.user.findUnique({ where: { id } });
 *   const posts: Post[] = await db.post.findMany({ where: { authorId: user.id } });
 */

import type { InferInsertModel, InferSelectModel } from "drizzle-orm";
import type * as schema from "./schema";

// ============================================================================
// Select Types (what you get when reading from the database)
// ============================================================================

export type User = InferSelectModel<typeof schema.users>;
export type Post = InferSelectModel<typeof schema.posts>;
export type Comment = InferSelectModel<typeof schema.comments>;
export type Reaction = InferSelectModel<typeof schema.reactions>;
export type Share = InferSelectModel<typeof schema.shares>;
export type Market = InferSelectModel<typeof schema.markets>;
export type Position = InferSelectModel<typeof schema.positions>;
export type PerpPosition = InferSelectModel<typeof schema.perpPositions>;
export type StockPrice = InferSelectModel<typeof schema.stockPrices>;
export type Question = InferSelectModel<typeof schema.questions>;
export type PredictionPriceHistory = InferSelectModel<
  typeof schema.predictionPriceHistories
>;
export type Chat = InferSelectModel<typeof schema.chats>;
export type ChatParticipant = InferSelectModel<typeof schema.chatParticipants>;
export type Message = InferSelectModel<typeof schema.messages>;
export type Notification = InferSelectModel<typeof schema.notifications>;
export type DMAcceptance = InferSelectModel<typeof schema.dmAcceptances>;
export type UserInteraction = InferSelectModel<typeof schema.userInteractions>;
export type AgentRegistry = InferSelectModel<typeof schema.agentRegistries>;
export type AgentCapability = InferSelectModel<typeof schema.agentCapabilities>;
export type AgentLog = InferSelectModel<typeof schema.agentLogs>;
export type AgentMessage = InferSelectModel<typeof schema.agentMessages>;
export type AgentPerformanceMetrics = InferSelectModel<
  typeof schema.agentPerformanceMetrics
>;
export type AgentGoal = InferSelectModel<typeof schema.agentGoals>;
export type AgentGoalAction = InferSelectModel<typeof schema.agentGoalActions>;
export type AgentPointsTransaction = InferSelectModel<
  typeof schema.agentPointsTransactions
>;
export type AgentTrade = InferSelectModel<typeof schema.agentTrades>;
export type ExternalAgentConnection = InferSelectModel<
  typeof schema.externalAgentConnections
>;
export type TradingFee = InferSelectModel<typeof schema.tradingFees>;
export type BalanceTransaction = InferSelectModel<
  typeof schema.balanceTransactions
>;
export type PointsTransaction = InferSelectModel<
  typeof schema.pointsTransactions
>;
export type UserActorFollow = InferSelectModel<typeof schema.userActorFollows>;
export type UserBlock = InferSelectModel<typeof schema.userBlocks>;
export type UserMute = InferSelectModel<typeof schema.userMutes>;
export type Report = InferSelectModel<typeof schema.reports>;
export type TwitterOAuthToken = InferSelectModel<
  typeof schema.twitterOAuthTokens
>;
export type OnboardingIntent = InferSelectModel<
  typeof schema.onboardingIntents
>;
export type Favorite = InferSelectModel<typeof schema.favorites>;
export type Follow = InferSelectModel<typeof schema.follows>;
export type FollowStatus = InferSelectModel<typeof schema.followStatuses>;
export type ProfileUpdateLog = InferSelectModel<
  typeof schema.profileUpdateLogs
>;
export type ShareAction = InferSelectModel<typeof schema.shareActions>;
export type Tag = InferSelectModel<typeof schema.tags>;
export type PostTag = InferSelectModel<typeof schema.postTags>;
export type TrendingTag = InferSelectModel<typeof schema.trendingTags>;
export type LlmCallLog = InferSelectModel<typeof schema.llmCallLogs>;
export type MarketOutcome = InferSelectModel<typeof schema.marketOutcomes>;
export type TrainedModel = InferSelectModel<typeof schema.trainedModels>;
export type TrainingBatch = InferSelectModel<typeof schema.trainingBatches>;
export type BenchmarkResult = InferSelectModel<typeof schema.benchmarkResults>;
export type Trajectory = InferSelectModel<typeof schema.trajectories>;
export type RewardJudgment = InferSelectModel<typeof schema.rewardJudgments>;
export type OracleCommitment = InferSelectModel<
  typeof schema.oracleCommitments
>;
export type OracleTransaction = InferSelectModel<
  typeof schema.oracleTransactions
>;
export type RealtimeOutbox = InferSelectModel<typeof schema.realtimeOutboxes>;
export type Game = InferSelectModel<typeof schema.games>;
export type GameConfig = InferSelectModel<typeof schema.gameConfigs>;
export type OAuthState = InferSelectModel<typeof schema.oAuthStates>;
export type SystemSettings = InferSelectModel<typeof schema.systemSettings>;
export type WorldEvent = InferSelectModel<typeof schema.worldEvents>;
export type WorldFact = InferSelectModel<typeof schema.worldFacts>;
export type RSSFeedSource = InferSelectModel<typeof schema.rssFeedSources>;
export type RSSHeadline = InferSelectModel<typeof schema.rssHeadlines>;
export type ParodyHeadline = InferSelectModel<typeof schema.parodyHeadlines>;
export type ModerationEscrow = InferSelectModel<
  typeof schema.moderationEscrows
>;
export type GenerationLock = InferSelectModel<typeof schema.generationLocks>;
export type Feedback = InferSelectModel<typeof schema.feedbacks>;
export type Referral = InferSelectModel<typeof schema.referrals>;
export type WidgetCache = InferSelectModel<typeof schema.widgetCaches>;
export type UserAgentConfig = InferSelectModel<typeof schema.userAgentConfigs>;
export type UserApiKey = InferSelectModel<typeof schema.userApiKeys>;
export type TickTokenStats = InferSelectModel<typeof schema.tickTokenStats>;

// Group types
export type Group = InferSelectModel<typeof schema.groups>;
export type GroupMember = InferSelectModel<typeof schema.groupMembers>;
export type GroupInvite = InferSelectModel<typeof schema.groupInvites>;

// Organization type
export type Organization = InferSelectModel<typeof schema.organizations>;

// ============================================================================
// Insert Types (what you provide when inserting into the database)
// ============================================================================

export type NewUser = InferInsertModel<typeof schema.users>;
export type NewPost = InferInsertModel<typeof schema.posts>;
export type NewComment = InferInsertModel<typeof schema.comments>;
export type NewReaction = InferInsertModel<typeof schema.reactions>;
export type NewShare = InferInsertModel<typeof schema.shares>;
export type NewMarket = InferInsertModel<typeof schema.markets>;
export type NewPosition = InferInsertModel<typeof schema.positions>;
export type NewPerpPosition = InferInsertModel<typeof schema.perpPositions>;
export type NewStockPrice = InferInsertModel<typeof schema.stockPrices>;
export type NewQuestion = InferInsertModel<typeof schema.questions>;
export type NewPredictionPriceHistory = InferInsertModel<
  typeof schema.predictionPriceHistories
>;
export type NewChat = InferInsertModel<typeof schema.chats>;
export type NewChatParticipant = InferInsertModel<
  typeof schema.chatParticipants
>;
export type NewMessage = InferInsertModel<typeof schema.messages>;
export type NewNotification = InferInsertModel<typeof schema.notifications>;
export type NewDMAcceptance = InferInsertModel<typeof schema.dmAcceptances>;
export type NewUserInteraction = InferInsertModel<
  typeof schema.userInteractions
>;
export type NewAgentRegistry = InferInsertModel<typeof schema.agentRegistries>;
export type NewAgentCapability = InferInsertModel<
  typeof schema.agentCapabilities
>;
export type NewAgentLog = InferInsertModel<typeof schema.agentLogs>;
export type NewAgentMessage = InferInsertModel<typeof schema.agentMessages>;
export type NewAgentPerformanceMetrics = InferInsertModel<
  typeof schema.agentPerformanceMetrics
>;
export type NewAgentGoal = InferInsertModel<typeof schema.agentGoals>;
export type NewAgentGoalAction = InferInsertModel<
  typeof schema.agentGoalActions
>;
export type NewAgentPointsTransaction = InferInsertModel<
  typeof schema.agentPointsTransactions
>;
export type NewAgentTrade = InferInsertModel<typeof schema.agentTrades>;
export type NewExternalAgentConnection = InferInsertModel<
  typeof schema.externalAgentConnections
>;
export type NewTradingFee = InferInsertModel<typeof schema.tradingFees>;
export type NewBalanceTransaction = InferInsertModel<
  typeof schema.balanceTransactions
>;
export type NewPointsTransaction = InferInsertModel<
  typeof schema.pointsTransactions
>;
export type NewUserActorFollow = InferInsertModel<
  typeof schema.userActorFollows
>;
export type NewUserBlock = InferInsertModel<typeof schema.userBlocks>;
export type NewUserMute = InferInsertModel<typeof schema.userMutes>;
export type NewReport = InferInsertModel<typeof schema.reports>;
export type NewTwitterOAuthToken = InferInsertModel<
  typeof schema.twitterOAuthTokens
>;
export type NewOnboardingIntent = InferInsertModel<
  typeof schema.onboardingIntents
>;
export type NewFavorite = InferInsertModel<typeof schema.favorites>;
export type NewFollow = InferInsertModel<typeof schema.follows>;
export type NewFollowStatus = InferInsertModel<typeof schema.followStatuses>;
export type NewProfileUpdateLog = InferInsertModel<
  typeof schema.profileUpdateLogs
>;
export type NewShareAction = InferInsertModel<typeof schema.shareActions>;
export type NewTag = InferInsertModel<typeof schema.tags>;
export type NewPostTag = InferInsertModel<typeof schema.postTags>;
export type NewTrendingTag = InferInsertModel<typeof schema.trendingTags>;
export type NewLlmCallLog = InferInsertModel<typeof schema.llmCallLogs>;
export type NewMarketOutcome = InferInsertModel<typeof schema.marketOutcomes>;
export type NewTrainedModel = InferInsertModel<typeof schema.trainedModels>;
export type NewTrainingBatch = InferInsertModel<typeof schema.trainingBatches>;
export type NewBenchmarkResult = InferInsertModel<
  typeof schema.benchmarkResults
>;
export type NewTrajectory = InferInsertModel<typeof schema.trajectories>;
export type NewRewardJudgment = InferInsertModel<typeof schema.rewardJudgments>;
export type NewOracleCommitment = InferInsertModel<
  typeof schema.oracleCommitments
>;
export type NewOracleTransaction = InferInsertModel<
  typeof schema.oracleTransactions
>;
export type NewRealtimeOutbox = InferInsertModel<
  typeof schema.realtimeOutboxes
>;
export type NewGame = InferInsertModel<typeof schema.games>;
export type NewGameConfig = InferInsertModel<typeof schema.gameConfigs>;
export type NewOAuthState = InferInsertModel<typeof schema.oAuthStates>;
export type NewSystemSettings = InferInsertModel<typeof schema.systemSettings>;
export type NewWorldEvent = InferInsertModel<typeof schema.worldEvents>;
export type NewWorldFact = InferInsertModel<typeof schema.worldFacts>;
export type NewRSSFeedSource = InferInsertModel<typeof schema.rssFeedSources>;
export type NewRSSHeadline = InferInsertModel<typeof schema.rssHeadlines>;
export type NewParodyHeadline = InferInsertModel<typeof schema.parodyHeadlines>;
export type NewModerationEscrow = InferInsertModel<
  typeof schema.moderationEscrows
>;
export type NewGenerationLock = InferInsertModel<typeof schema.generationLocks>;
export type NewFeedback = InferInsertModel<typeof schema.feedbacks>;
export type NewReferral = InferInsertModel<typeof schema.referrals>;
export type NewWidgetCache = InferInsertModel<typeof schema.widgetCaches>;
export type NewUserAgentConfig = InferInsertModel<
  typeof schema.userAgentConfigs
>;
export type NewUserApiKey = InferInsertModel<typeof schema.userApiKeys>;
export type NewTickTokenStats = InferInsertModel<typeof schema.tickTokenStats>;

// Group types
export type NewGroup = InferInsertModel<typeof schema.groups>;
export type NewGroupMember = InferInsertModel<typeof schema.groupMembers>;
export type NewGroupInvite = InferInsertModel<typeof schema.groupInvites>;

// Organization type
export type NewOrganization = InferInsertModel<typeof schema.organizations>;

// ============================================================================
// Types with Relations (for queries using include/with)
// ============================================================================

/** Chat with participants relation */
export type ChatWithParticipants = Chat & {
  ChatParticipant: ChatParticipant[];
};

/** Chat with participants and messages */
export type ChatWithParticipantsAndMessages = Chat & {
  ChatParticipant: ChatParticipant[];
  Message: Message[];
};

/** Chat with all common relations */
export type ChatWithRelations = Chat & {
  ChatParticipant?: ChatParticipant[];
  Message?: Message[];
};

/** User with performance metrics */
export type UserWithMetrics = User & {
  AgentPerformanceMetrics?: AgentPerformanceMetrics | null;
};

/** User with all agent-related relations */
export type UserWithAgentRelations = User & {
  AgentPerformanceMetrics?: AgentPerformanceMetrics | null;
  AgentRegistry?: AgentRegistry | null;
  AgentCapability?: AgentCapability | null;
  agentConfig?: UserAgentConfig | null;
};

/**
 * Actor reference (deprecated - for backwards compatibility)
 */
export interface ActorRef {
  id: string;
  name: string;
  profileImageUrl?: string | null;
}

/** Post with author and reactions */
export type PostWithRelations = Post & {
  author?: User | ActorRef | null;
  reactions?: Reaction[];
  comments?: Comment[];
  shares?: Share[];
};

/** Message with sender */
export type MessageWithSender = Message & {
  sender?: User | ActorRef | null;
};

/** BalanceTransaction with user relation */
export type BalanceTransactionWithUser = BalanceTransaction & {
  user?: Pick<
    User,
    "id" | "username" | "displayName" | "profileImageUrl" | "isActor"
  > | null;
};

/** ModerationEscrow with relations */
export type ModerationEscrowWithRelations = ModerationEscrow & {
  recipient?: Pick<
    User,
    "id" | "username" | "displayName" | "profileImageUrl"
  > | null;
  admin?: Pick<
    User,
    "id" | "username" | "displayName" | "walletAddress"
  > | null;
  refundedByUser?: Pick<User, "id" | "username" | "displayName"> | null;
};

/** TradingFee with user relation */
export type TradingFeeWithUser = TradingFee & {
  user?: Pick<
    User,
    "id" | "username" | "displayName" | "profileImageUrl" | "isActor"
  > | null;
};

/** ExternalAgentConnection with agentRegistry relation */
export type ExternalAgentConnectionWithRegistry = ExternalAgentConnection & {
  agentRegistry?:
    | (AgentRegistry & {
        capabilities?: AgentCapability[];
      })
    | null;
};

/** AgentGoal with actions relation */
export type AgentGoalWithActions = AgentGoal & {
  actions?: AgentGoalAction[];
};

// Deprecated types - kept for backwards compatibility
/** @deprecated Use Organization instead */
export type OrganizationStateRow = Organization;
/** @deprecated Use NewOrganization instead */
export type NewOrganizationStateRow = NewOrganization;
