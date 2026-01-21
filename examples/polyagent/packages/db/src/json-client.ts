/**
 * JSON Database Client
 *
 * Creates a DrizzleClient-compatible interface backed by JSON storage.
 * All table repositories use the same API as the PostgreSQL version.
 */

import type { DrizzleClient, SQLValue } from "./client";
import { JsonTableRepository } from "./json-storage";

// Create JSON repository - uses any to bridge the gap between JSON and Drizzle types
// The runtime behavior is the same, we just need to satisfy the type checker
// biome-ignore lint/suspicious/noExplicitAny: needed for type bridging between JSON and Drizzle
function createJsonRepo(tableName: string): any {
  return new JsonTableRepository(tableName);
}

/**
 * Create a JSON-backed database client.
 *
 * This returns a client with the same interface as the PostgreSQL DrizzleClient,
 * but stores all data in memory/JSON files.
 */
export function createJsonClient(): DrizzleClient {
  // Stub implementations for Drizzle-specific methods
  const notSupported = () => {
    throw new Error(
      "This method is not supported in JSON mode. Use table repositories instead.",
    );
  };

  const $connect = async (): Promise<void> => {
    // No-op for JSON mode
  };

  const $disconnect = async (): Promise<void> => {
    // No-op for JSON mode
  };

  const $transaction = async <T>(
    callback: (tx: DrizzleClient) => Promise<T>,
  ): Promise<T> => {
    // JSON mode doesn't have real transactions, just execute the callback
    return callback(createJsonClient());
  };

  const $queryRaw = async <T = Record<string, SQLValue>>(): Promise<T[]> => {
    throw new Error("Raw queries are not supported in JSON mode");
  };

  const $executeRaw = async (): Promise<number> => {
    throw new Error("Raw queries are not supported in JSON mode");
  };

  return {
    // Core Drizzle methods - not supported in JSON mode
    select: notSupported as DrizzleClient["select"],
    selectDistinct: notSupported as DrizzleClient["selectDistinct"],
    selectDistinctOn: notSupported as DrizzleClient["selectDistinctOn"],
    insert: notSupported as DrizzleClient["insert"],
    update: notSupported as DrizzleClient["update"],
    delete: notSupported as DrizzleClient["delete"],
    execute: notSupported as DrizzleClient["execute"],
    transaction: notSupported as DrizzleClient["transaction"],
    query: {} as DrizzleClient["query"],

    // Connection management
    $connect,
    $disconnect,
    $transaction,
    $queryRaw,
    $executeRaw,

    // Table repositories - JSON-backed
    user: createJsonRepo("users"),
    post: createJsonRepo("posts"),
    comment: createJsonRepo("comments"),
    reaction: createJsonRepo("reactions"),
    share: createJsonRepo("shares"),
    market: createJsonRepo("markets"),
    position: createJsonRepo("positions"),
    perpPosition: createJsonRepo("perpPositions"),
    stockPrice: createJsonRepo("stockPrices"),
    question: createJsonRepo("questions"),
    predictionPriceHistory: createJsonRepo("predictionPriceHistories"),
    chat: createJsonRepo("chats"),
    chatParticipant: createJsonRepo("chatParticipants"),
    message: createJsonRepo("messages"),
    notification: createJsonRepo("notifications"),
    dmAcceptance: createJsonRepo("dmAcceptances"),
    userInteraction: createJsonRepo("userInteractions"),
    agentRegistry: createJsonRepo("agentRegistries"),
    agentCapability: createJsonRepo("agentCapabilities"),
    agentLog: createJsonRepo("agentLogs"),
    agentMessage: createJsonRepo("agentMessages"),
    agentPerformanceMetrics: createJsonRepo("agentPerformanceMetrics"),
    agentGoal: createJsonRepo("agentGoals"),
    agentGoalAction: createJsonRepo("agentGoalActions"),
    agentPointsTransaction: createJsonRepo("agentPointsTransactions"),
    agentTrade: createJsonRepo("agentTrades"),
    externalAgentConnection: createJsonRepo("externalAgentConnections"),
    tradingFee: createJsonRepo("tradingFees"),
    balanceTransaction: createJsonRepo("balanceTransactions"),
    pointsTransaction: createJsonRepo("pointsTransactions"),
    userActorFollow: createJsonRepo("userActorFollows"),
    userBlock: createJsonRepo("userBlocks"),
    userMute: createJsonRepo("userMutes"),
    report: createJsonRepo("reports"),
    twitterOAuthToken: createJsonRepo("twitterOAuthTokens"),
    onboardingIntent: createJsonRepo("onboardingIntents"),
    favorite: createJsonRepo("favorites"),
    follow: createJsonRepo("follows"),
    followStatus: createJsonRepo("followStatuses"),
    profileUpdateLog: createJsonRepo("profileUpdateLogs"),
    shareAction: createJsonRepo("shareActions"),
    tag: createJsonRepo("tags"),
    postTag: createJsonRepo("postTags"),
    trendingTag: createJsonRepo("trendingTags"),
    llmCallLog: createJsonRepo("llmCallLogs"),
    marketOutcome: createJsonRepo("marketOutcomes"),
    trainedModel: createJsonRepo("trainedModels"),
    trainingBatch: createJsonRepo("trainingBatches"),
    benchmarkResult: createJsonRepo("benchmarkResults"),
    trajectory: createJsonRepo("trajectories"),
    rewardJudgment: createJsonRepo("rewardJudgments"),
    oracleCommitment: createJsonRepo("oracleCommitments"),
    oracleTransaction: createJsonRepo("oracleTransactions"),
    realtimeOutbox: createJsonRepo("realtimeOutboxes"),
    game: createJsonRepo("games"),
    gameConfig: createJsonRepo("gameConfigs"),
    oAuthState: createJsonRepo("oAuthStates"),
    systemSettings: createJsonRepo("systemSettings"),
    worldEvent: createJsonRepo("worldEvents"),
    worldFact: createJsonRepo("worldFacts"),
    rssFeedSource: createJsonRepo("rssFeedSources"),
    rssHeadline: createJsonRepo("rssHeadlines"),
    parodyHeadline: createJsonRepo("parodyHeadlines"),
    moderationEscrow: createJsonRepo("moderationEscrows"),
    generationLock: createJsonRepo("generationLocks"),
    feedback: createJsonRepo("feedbacks"),
    referral: createJsonRepo("referrals"),
    widgetCache: createJsonRepo("widgetCaches"),
    userAgentConfig: createJsonRepo("userAgentConfigs"),
    userApiKey: createJsonRepo("userApiKeys"),
    tickTokenStats: createJsonRepo("tickTokenStats"),
    questionArcPlan: createJsonRepo("questionArcPlans"),
    adminRole: createJsonRepo("adminRoles"),

    // Group system
    group: createJsonRepo("groups"),
    groupMember: createJsonRepo("groupMembers"),
    groupInvite: createJsonRepo("groupInvites"),
  };
}
