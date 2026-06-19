import { relations } from "drizzle-orm";
import {
  boolean,
  decimal,
  doublePrecision,
  index,
  integer,
  json,
  pgTable,
  text,
  timestamp,
} from "drizzle-orm/pg-core";
import type { JsonValue } from "../types";
import { agentStatusEnum, agentTypeEnum } from "./enums";
import { users } from "./users";

// AgentLog
export const agentLogs = pgTable(
  "AgentLog",
  {
    id: text("id").primaryKey(),
    type: text("type").notNull(),
    level: text("level").notNull(),
    message: text("message").notNull(),
    prompt: text("prompt"),
    completion: text("completion"),
    thinking: text("thinking"),
    metadata: json("metadata").$type<JsonValue>(),
    createdAt: timestamp("createdAt", { mode: "date" }).notNull().defaultNow(),
    agentUserId: text("agentUserId").notNull(),
  },
  (table) => [
    index("AgentLog_agentUserId_createdAt_idx").on(
      table.agentUserId,
      table.createdAt,
    ),
    index("AgentLog_level_idx").on(table.level),
    index("AgentLog_type_createdAt_idx").on(table.type, table.createdAt),
  ],
);

// AgentMessage
export const agentMessages = pgTable(
  "AgentMessage",
  {
    id: text("id").primaryKey(),
    role: text("role").notNull(),
    content: text("content").notNull(),
    modelUsed: text("modelUsed"),
    pointsCost: integer("pointsCost").notNull().default(0),
    metadata: json("metadata").$type<JsonValue>(),
    createdAt: timestamp("createdAt", { mode: "date" }).notNull().defaultNow(),
    agentUserId: text("agentUserId").notNull(),
  },
  (table) => [
    index("AgentMessage_agentUserId_createdAt_idx").on(
      table.agentUserId,
      table.createdAt,
    ),
    index("AgentMessage_role_idx").on(table.role),
  ],
);

// AgentPerformanceMetrics
export const agentPerformanceMetrics = pgTable(
  "AgentPerformanceMetrics",
  {
    id: text("id").primaryKey(),
    userId: text("userId").notNull().unique(),
    gamesPlayed: integer("gamesPlayed").notNull().default(0),
    gamesWon: integer("gamesWon").notNull().default(0),
    averageGameScore: doublePrecision("averageGameScore").notNull().default(0),
    lastGameScore: doublePrecision("lastGameScore"),
    lastGamePlayedAt: timestamp("lastGamePlayedAt", { mode: "date" }),
    normalizedPnL: doublePrecision("normalizedPnL").notNull().default(0.5),
    totalTrades: integer("totalTrades").notNull().default(0),
    profitableTrades: integer("profitableTrades").notNull().default(0),
    winRate: doublePrecision("winRate").notNull().default(0),
    averageROI: doublePrecision("averageROI").notNull().default(0),
    sharpeRatio: doublePrecision("sharpeRatio"),
    totalFeedbackCount: integer("totalFeedbackCount").notNull().default(0),
    averageFeedbackScore: doublePrecision("averageFeedbackScore")
      .notNull()
      .default(70),
    intelFeedbackCount: integer("intelFeedbackCount").notNull().default(0),
    averageIntelScore: doublePrecision("averageIntelScore")
      .notNull()
      .default(50),
    averageRating: doublePrecision("averageRating"),
    positiveCount: integer("positiveCount").notNull().default(0),
    neutralCount: integer("neutralCount").notNull().default(0),
    negativeCount: integer("negativeCount").notNull().default(0),
    reputationScore: doublePrecision("reputationScore").notNull().default(70),
    trustLevel: text("trustLevel").notNull().default("UNRATED"),
    confidenceScore: doublePrecision("confidenceScore").notNull().default(0),
    onChainReputationSync: boolean("onChainReputationSync")
      .notNull()
      .default(false),
    lastSyncedAt: timestamp("lastSyncedAt", { mode: "date" }),
    onChainTrustScore: doublePrecision("onChainTrustScore"),
    onChainAccuracyScore: doublePrecision("onChainAccuracyScore"),
    firstActivityAt: timestamp("firstActivityAt", { mode: "date" }),
    lastActivityAt: timestamp("lastActivityAt", { mode: "date" }),
    totalInteractions: integer("totalInteractions").notNull().default(0),
    createdAt: timestamp("createdAt", { mode: "date" }).notNull().defaultNow(),
    updatedAt: timestamp("updatedAt", { mode: "date" }).notNull(),
  },
  (table) => [
    index("AgentPerformanceMetrics_gamesPlayed_idx").on(table.gamesPlayed),
    index("AgentPerformanceMetrics_normalizedPnL_idx").on(table.normalizedPnL),
    index("AgentPerformanceMetrics_reputationScore_idx").on(
      table.reputationScore,
    ),
    index("AgentPerformanceMetrics_trustLevel_idx").on(table.trustLevel),
    index("AgentPerformanceMetrics_updatedAt_idx").on(table.updatedAt),
  ],
);

// AgentGoal
export const agentGoals = pgTable(
  "AgentGoal",
  {
    id: text("id").primaryKey(),
    agentUserId: text("agentUserId").notNull(),
    type: text("type").notNull(),
    name: text("name").notNull(),
    description: text("description").notNull(),
    target: json("target").$type<JsonValue>(),
    priority: integer("priority").notNull(),
    status: text("status").notNull().default("active"),
    progress: doublePrecision("progress").notNull().default(0),
    createdAt: timestamp("createdAt", { mode: "date" }).notNull().defaultNow(),
    updatedAt: timestamp("updatedAt", { mode: "date" }).notNull(),
    completedAt: timestamp("completedAt", { mode: "date" }),
  },
  (table) => [
    index("AgentGoal_agentUserId_status_idx").on(
      table.agentUserId,
      table.status,
    ),
    index("AgentGoal_priority_idx").on(table.priority),
    index("AgentGoal_status_idx").on(table.status),
    index("AgentGoal_createdAt_idx").on(table.createdAt),
  ],
);

// AgentGoalAction
export const agentGoalActions = pgTable(
  "AgentGoalAction",
  {
    id: text("id").primaryKey(),
    goalId: text("goalId").notNull(),
    agentUserId: text("agentUserId").notNull(),
    actionType: text("actionType").notNull(),
    actionId: text("actionId"),
    impact: doublePrecision("impact").notNull(),
    metadata: json("metadata").$type<JsonValue>(),
    createdAt: timestamp("createdAt", { mode: "date" }).notNull().defaultNow(),
  },
  (table) => [
    index("AgentGoalAction_goalId_idx").on(table.goalId),
    index("AgentGoalAction_agentUserId_createdAt_idx").on(
      table.agentUserId,
      table.createdAt,
    ),
    index("AgentGoalAction_actionType_idx").on(table.actionType),
  ],
);

// AgentPointsTransaction
export const agentPointsTransactions = pgTable(
  "AgentPointsTransaction",
  {
    id: text("id").primaryKey(),
    type: text("type").notNull(),
    amount: integer("amount").notNull(),
    balanceBefore: decimal("balanceBefore", {
      precision: 18,
      scale: 2,
    }).notNull(),
    balanceAfter: decimal("balanceAfter", {
      precision: 18,
      scale: 2,
    }).notNull(),
    description: text("description").notNull(),
    relatedId: text("relatedId"),
    createdAt: timestamp("createdAt", { mode: "date" }).notNull().defaultNow(),
    agentUserId: text("agentUserId").notNull(),
    managerUserId: text("managerUserId").notNull(),
  },
  (table) => [
    index("AgentPointsTransaction_agentUserId_createdAt_idx").on(
      table.agentUserId,
      table.createdAt,
    ),
    index("AgentPointsTransaction_managerUserId_createdAt_idx").on(
      table.managerUserId,
      table.createdAt,
    ),
    index("AgentPointsTransaction_type_idx").on(table.type),
  ],
);

// AgentTrade
export const agentTrades = pgTable(
  "AgentTrade",
  {
    id: text("id").primaryKey(),
    marketType: text("marketType").notNull(),
    marketId: text("marketId"),
    ticker: text("ticker"),
    action: text("action").notNull(),
    side: text("side"),
    amount: doublePrecision("amount").notNull(),
    price: doublePrecision("price").notNull(),
    pnl: doublePrecision("pnl"),
    reasoning: text("reasoning"),
    executedAt: timestamp("executedAt", { mode: "date" })
      .notNull()
      .defaultNow(),
    agentUserId: text("agentUserId").notNull(),
  },
  (table) => [
    index("AgentTrade_agentUserId_executedAt_idx").on(
      table.agentUserId,
      table.executedAt,
    ),
    index("AgentTrade_marketType_marketId_idx").on(
      table.marketType,
      table.marketId,
    ),
    index("AgentTrade_ticker_idx").on(table.ticker),
  ],
);

// AgentRegistry
export const agentRegistries = pgTable(
  "AgentRegistry",
  {
    id: text("id").primaryKey(),
    agentId: text("agentId").notNull().unique(),
    type: agentTypeEnum("type").notNull(),
    status: agentStatusEnum("status").notNull().default("REGISTERED"),
    trustLevel: integer("trustLevel").notNull().default(0),
    userId: text("userId").unique(),
    actorId: text("actorId").unique(),
    name: text("name").notNull(),
    systemPrompt: text("systemPrompt").notNull(),
    discoveryCardVersion: text("discoveryCardVersion"),
    discoveryEndpointA2a: text("discoveryEndpointA2a"),
    discoveryEndpointMcp: text("discoveryEndpointMcp"),
    discoveryEndpointRpc: text("discoveryEndpointRpc"),
    discoveryAuthRequired: boolean("discoveryAuthRequired")
      .notNull()
      .default(false),
    discoveryAuthMethods: text("discoveryAuthMethods")
      .array()
      .notNull()
      .default([]),
    discoveryRateLimit: integer("discoveryRateLimit"),
    discoveryCostPerAction: doublePrecision("discoveryCostPerAction"),
    onChainTokenId: integer("onChainTokenId"),
    onChainTxHash: text("onChainTxHash"),
    onChainServerWallet: text("onChainServerWallet"),
    onChainReputationScore: integer("onChainReputationScore").default(0),
    onChainChainId: integer("onChainChainId"),
    onChainIdentityRegistry: text("onChainIdentityRegistry"),
    onChainReputationSystem: text("onChainReputationSystem"),
    agent0TokenId: text("agent0TokenId"),
    agent0MetadataCID: text("agent0MetadataCID"),
    agent0SubgraphOwner: text("agent0SubgraphOwner"),
    agent0SubgraphMetadataURI: text("agent0SubgraphMetadataURI"),
    agent0SubgraphTimestamp: integer("agent0SubgraphTimestamp"),
    agent0DiscoveryEndpoint: text("agent0DiscoveryEndpoint"),
    runtimeInstanceId: text("runtimeInstanceId").unique(),
    registeredAt: timestamp("registeredAt", { mode: "date" })
      .notNull()
      .defaultNow(),
    lastActiveAt: timestamp("lastActiveAt", { mode: "date" }),
    terminatedAt: timestamp("terminatedAt", { mode: "date" }),
    updatedAt: timestamp("updatedAt", { mode: "date" }).notNull(),
  },
  (table) => [
    index("AgentRegistry_type_status_idx").on(table.type, table.status),
    index("AgentRegistry_trustLevel_idx").on(table.trustLevel),
    index("AgentRegistry_userId_idx").on(table.userId),
    index("AgentRegistry_actorId_idx").on(table.actorId),
    index("AgentRegistry_status_lastActiveAt_idx").on(
      table.status,
      table.lastActiveAt,
    ),
    index("AgentRegistry_type_trustLevel_idx").on(table.type, table.trustLevel),
  ],
);

// AgentCapability
export const agentCapabilities = pgTable(
  "AgentCapability",
  {
    id: text("id").primaryKey(),
    agentRegistryId: text("agentRegistryId").notNull().unique(),
    strategies: text("strategies").array().notNull().default([]),
    markets: text("markets").array().notNull().default([]),
    actions: text("actions").array().notNull().default([]),
    version: text("version").notNull().default("1.0.0"),
    x402Support: boolean("x402Support").notNull().default(false),
    platform: text("platform"),
    userType: text("userType"),
    gameNetworkChainId: integer("gameNetworkChainId"),
    gameNetworkRpcUrl: text("gameNetworkRpcUrl"),
    gameNetworkExplorerUrl: text("gameNetworkExplorerUrl"),
    skills: text("skills").array().notNull().default([]),
    domains: text("domains").array().notNull().default([]),
    a2aEndpoint: text("a2aEndpoint"),
    mcpEndpoint: text("mcpEndpoint"),
    createdAt: timestamp("createdAt", { mode: "date" }).notNull().defaultNow(),
    updatedAt: timestamp("updatedAt", { mode: "date" }).notNull(),
  },
  (table) => [
    index("AgentCapability_agentRegistryId_idx").on(table.agentRegistryId),
  ],
);

// ExternalAgentConnection
// NOTE: After modifying this schema, run `bun run db:generate` to create a migration.
export const externalAgentConnections = pgTable(
  "ExternalAgentConnection",
  {
    id: text("id").primaryKey(),
    agentRegistryId: text("agentRegistryId").notNull().unique(),
    externalId: text("externalId").notNull().unique(),
    endpoint: text("endpoint").notNull(),
    protocol: text("protocol").notNull(),
    authType: text("authType"),
    authCredentials: text("authCredentials"),
    agentCardJson: json("agentCardJson").$type<JsonValue>(),
    isHealthy: boolean("isHealthy").notNull().default(true),
    lastHealthCheck: timestamp("lastHealthCheck", { mode: "date" }),
    lastConnected: timestamp("lastConnected", { mode: "date" }),
    registeredByUserId: text("registeredByUserId"),
    revokedAt: timestamp("revokedAt", { mode: "date" }),
    revokedBy: text("revokedBy"),
    createdAt: timestamp("createdAt", { mode: "date" }).notNull().defaultNow(),
    updatedAt: timestamp("updatedAt", { mode: "date" }).notNull(),
  },
  (table) => [
    index("ExternalAgentConnection_agentRegistryId_idx").on(
      table.agentRegistryId,
    ),
    index("ExternalAgentConnection_externalId_idx").on(table.externalId),
    index("ExternalAgentConnection_protocol_idx").on(table.protocol),
    index("ExternalAgentConnection_isHealthy_idx").on(table.isHealthy),
    index("ExternalAgentConnection_revokedAt_idx").on(table.revokedAt),
  ],
);

// Relations
export const agentLogsRelations = relations(agentLogs, ({ one }) => ({
  user: one(users, {
    fields: [agentLogs.agentUserId],
    references: [users.id],
  }),
}));

export const agentMessagesRelations = relations(agentMessages, ({ one }) => ({
  user: one(users, {
    fields: [agentMessages.agentUserId],
    references: [users.id],
  }),
}));

export const agentPerformanceMetricsRelations = relations(
  agentPerformanceMetrics,
  ({ one }) => ({
    user: one(users, {
      fields: [agentPerformanceMetrics.userId],
      references: [users.id],
    }),
  }),
);

export const agentGoalsRelations = relations(agentGoals, ({ one, many }) => ({
  user: one(users, {
    fields: [agentGoals.agentUserId],
    references: [users.id],
  }),
  actions: many(agentGoalActions),
}));

export const agentGoalActionsRelations = relations(
  agentGoalActions,
  ({ one }) => ({
    goal: one(agentGoals, {
      fields: [agentGoalActions.goalId],
      references: [agentGoals.id],
    }),
    user: one(users, {
      fields: [agentGoalActions.agentUserId],
      references: [users.id],
    }),
  }),
);

export const agentPointsTransactionsRelations = relations(
  agentPointsTransactions,
  ({ one }) => ({
    agentUser: one(users, {
      fields: [agentPointsTransactions.agentUserId],
      references: [users.id],
      relationName: "AgentPointsTransaction_agentUserIdToUser",
    }),
    managerUser: one(users, {
      fields: [agentPointsTransactions.managerUserId],
      references: [users.id],
      relationName: "AgentPointsTransaction_managerUserIdToUser",
    }),
  }),
);

export const agentTradesRelations = relations(agentTrades, ({ one }) => ({
  user: one(users, {
    fields: [agentTrades.agentUserId],
    references: [users.id],
  }),
}));

// Note: actorId references actor IDs from StaticDataRegistry (static) and actorState (dynamic)
export const agentRegistriesRelations = relations(
  agentRegistries,
  ({ one }) => ({
    user: one(users, {
      fields: [agentRegistries.userId],
      references: [users.id],
    }),
    capabilities: one(agentCapabilities, {
      fields: [agentRegistries.id],
      references: [agentCapabilities.agentRegistryId],
    }),
    externalConnection: one(externalAgentConnections, {
      fields: [agentRegistries.id],
      references: [externalAgentConnections.agentRegistryId],
    }),
  }),
);

export const agentCapabilitiesRelations = relations(
  agentCapabilities,
  ({ one }) => ({
    agentRegistry: one(agentRegistries, {
      fields: [agentCapabilities.agentRegistryId],
      references: [agentRegistries.id],
    }),
  }),
);

export const externalAgentConnectionsRelations = relations(
  externalAgentConnections,
  ({ one }) => ({
    agentRegistry: one(agentRegistries, {
      fields: [externalAgentConnections.agentRegistryId],
      references: [agentRegistries.id],
    }),
  }),
);

// Type exports
export type AgentLog = typeof agentLogs.$inferSelect;
export type NewAgentLog = typeof agentLogs.$inferInsert;
export type AgentMessage = typeof agentMessages.$inferSelect;
export type NewAgentMessage = typeof agentMessages.$inferInsert;
export type AgentPerformanceMetrics =
  typeof agentPerformanceMetrics.$inferSelect;
export type NewAgentPerformanceMetrics =
  typeof agentPerformanceMetrics.$inferInsert;
export type AgentGoal = typeof agentGoals.$inferSelect;
export type NewAgentGoal = typeof agentGoals.$inferInsert;
export type AgentGoalAction = typeof agentGoalActions.$inferSelect;
export type NewAgentGoalAction = typeof agentGoalActions.$inferInsert;
export type AgentPointsTransaction =
  typeof agentPointsTransactions.$inferSelect;
export type NewAgentPointsTransaction =
  typeof agentPointsTransactions.$inferInsert;
export type AgentTrade = typeof agentTrades.$inferSelect;
export type NewAgentTrade = typeof agentTrades.$inferInsert;
export type AgentRegistry = typeof agentRegistries.$inferSelect;
export type NewAgentRegistry = typeof agentRegistries.$inferInsert;
export type AgentCapability = typeof agentCapabilities.$inferSelect;
export type NewAgentCapability = typeof agentCapabilities.$inferInsert;
export type ExternalAgentConnection =
  typeof externalAgentConnections.$inferSelect;
export type NewExternalAgentConnection =
  typeof externalAgentConnections.$inferInsert;
