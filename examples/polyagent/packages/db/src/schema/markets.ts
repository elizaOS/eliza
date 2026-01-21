import { relations } from "drizzle-orm";
import {
  boolean,
  decimal,
  doublePrecision,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
} from "drizzle-orm/pg-core";
import { users } from "./users";

/**
 * Funding rate for perpetual markets
 * Note: Dates stored as ISO strings for JSONB compatibility
 */
export interface FundingRate {
  ticker: string;
  rate: number; // APR as decimal (e.g., 0.01 = 1%)
  nextFundingTime: string; // ISO timestamp
  predictedRate: number; // Next period's estimated rate
}

// Market - Prediction markets
export const markets = pgTable(
  "Market",
  {
    id: text("id").primaryKey(),
    question: text("question").notNull(),
    description: text("description"),
    gameId: text("gameId"),
    dayNumber: integer("dayNumber"),
    yesShares: decimal("yesShares", { precision: 18, scale: 6 })
      .notNull()
      .default("0"),
    noShares: decimal("noShares", { precision: 18, scale: 6 })
      .notNull()
      .default("0"),
    liquidity: decimal("liquidity", { precision: 18, scale: 6 }).notNull(),
    resolved: boolean("resolved").notNull().default(false),
    resolution: boolean("resolution"),
    endDate: timestamp("endDate", { mode: "date" }).notNull(),
    createdAt: timestamp("createdAt", { mode: "date" }).notNull().defaultNow(),
    updatedAt: timestamp("updatedAt", { mode: "date" }).notNull(),
    onChainMarketId: text("onChainMarketId"),
    onChainResolutionTxHash: text("onChainResolutionTxHash"),
    onChainResolved: boolean("onChainResolved").notNull().default(false),
    oracleAddress: text("oracleAddress"),
    resolutionProofUrl: text("resolutionProofUrl"),
    resolutionDescription: text("resolutionDescription"),
  },
  (table) => [
    index("Market_createdAt_idx").on(table.createdAt),
    index("Market_gameId_dayNumber_idx").on(table.gameId, table.dayNumber),
    index("Market_onChainMarketId_idx").on(table.onChainMarketId),
    index("Market_resolved_endDate_idx").on(table.resolved, table.endDate),
  ],
);

// Question
export const questions = pgTable(
  "Question",
  {
    id: text("id").primaryKey(),
    questionNumber: integer("questionNumber").notNull().unique(),
    text: text("text").notNull(),
    scenarioId: integer("scenarioId").notNull(),
    outcome: boolean("outcome").notNull(),
    rank: integer("rank").notNull(),
    createdDate: timestamp("createdDate", { mode: "date" })
      .notNull()
      .defaultNow(),
    resolutionDate: timestamp("resolutionDate", { mode: "date" }).notNull(),
    status: text("status").notNull().default("active"),
    resolvedOutcome: boolean("resolvedOutcome"),
    createdAt: timestamp("createdAt", { mode: "date" }).notNull().defaultNow(),
    updatedAt: timestamp("updatedAt", { mode: "date" }).notNull(),
    oracleCommitBlock: integer("oracleCommitBlock"),
    oracleCommitTxHash: text("oracleCommitTxHash"),
    oracleCommitment: text("oracleCommitment"),
    oracleError: text("oracleError"),
    oraclePublishedAt: timestamp("oraclePublishedAt", { mode: "date" }),
    oracleRevealBlock: integer("oracleRevealBlock"),
    oracleRevealTxHash: text("oracleRevealTxHash"),
    oracleSaltEncrypted: text("oracleSaltEncrypted"),
    oracleSessionId: text("oracleSessionId").unique(),
    resolutionProofUrl: text("resolutionProofUrl"),
    resolutionDescription: text("resolutionDescription"),
    resolutionConfidence: doublePrecision("resolutionConfidence"),
    requiresManualReview: boolean("requiresManualReview")
      .notNull()
      .default(false),
    resolutionReviewStatus: text("resolutionReviewStatus"),
    resolutionReviewedAt: timestamp("resolutionReviewedAt", { mode: "date" }),
    resolutionReviewedBy: text("resolutionReviewedBy"),
  },
  (table) => [
    index("Question_createdDate_idx").on(table.createdDate),
    index("Question_oraclePublishedAt_idx").on(table.oraclePublishedAt),
    index("Question_oracleSessionId_idx").on(table.oracleSessionId),
    index("Question_status_resolutionDate_idx").on(
      table.status,
      table.resolutionDate,
    ),
    index("Question_requiresManualReview_status_idx").on(
      table.status,
      table.requiresManualReview,
      table.resolutionReviewStatus,
    ),
  ],
);

// Position
export const positions = pgTable(
  "Position",
  {
    id: text("id").primaryKey(),
    userId: text("userId").notNull(),
    marketId: text("marketId").notNull(),
    side: boolean("side").notNull(),
    shares: decimal("shares", { precision: 18, scale: 6 }).notNull(),
    avgPrice: decimal("avgPrice", { precision: 18, scale: 6 }).notNull(),
    createdAt: timestamp("createdAt", { mode: "date" }).notNull().defaultNow(),
    updatedAt: timestamp("updatedAt", { mode: "date" }).notNull(),
    amount: decimal("amount", { precision: 18, scale: 2 })
      .notNull()
      .default("0"),
    outcome: boolean("outcome"),
    pnl: decimal("pnl", { precision: 18, scale: 2 }),
    questionId: integer("questionId"),
    resolvedAt: timestamp("resolvedAt", { mode: "date" }),
    status: text("status").notNull().default("active"),
  },
  (table) => [
    index("Position_marketId_idx").on(table.marketId),
    index("Position_questionId_idx").on(table.questionId),
    index("Position_status_idx").on(table.status),
    index("Position_userId_idx").on(table.userId),
    index("Position_userId_marketId_idx").on(table.userId, table.marketId),
    index("Position_userId_status_idx").on(table.userId, table.status),
  ],
);

// PredictionPriceHistory
export const predictionPriceHistories = pgTable(
  "PredictionPriceHistory",
  {
    id: text("id").primaryKey(),
    marketId: text("marketId").notNull(),
    yesPrice: doublePrecision("yesPrice").notNull(),
    noPrice: doublePrecision("noPrice").notNull(),
    yesShares: decimal("yesShares", { precision: 24, scale: 8 }).notNull(),
    noShares: decimal("noShares", { precision: 24, scale: 8 }).notNull(),
    liquidity: decimal("liquidity", { precision: 24, scale: 8 }).notNull(),
    eventType: text("eventType").notNull(),
    source: text("source").notNull(),
    createdAt: timestamp("createdAt", { mode: "date" }).notNull().defaultNow(),
  },
  (table) => [
    index("PredictionPriceHistory_marketId_createdAt_idx").on(
      table.marketId,
      table.createdAt,
    ),
  ],
);

// Organization (companies)
export const organizations = pgTable(
  "Organization",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    ticker: text("ticker"),
    description: text("description").notNull(),
    type: text("type").notNull(),
    canBeInvolved: boolean("canBeInvolved").notNull().default(true),
    initialPrice: doublePrecision("initialPrice"),
    currentPrice: doublePrecision("currentPrice"),
    createdAt: timestamp("createdAt", { mode: "date" }).notNull().defaultNow(),
    updatedAt: timestamp("updatedAt", { mode: "date" }).notNull(),
    imageUrl: text("imageUrl"),
  },
  (table) => [
    index("Organization_currentPrice_idx").on(table.currentPrice),
    index("Organization_type_idx").on(table.type),
    index("Organization_ticker_idx").on(table.ticker),
  ],
);

// StockPrice
export const stockPrices = pgTable(
  "StockPrice",
  {
    id: text("id").primaryKey(),
    organizationId: text("organizationId").notNull(),
    price: doublePrecision("price").notNull(),
    change: doublePrecision("change").notNull(),
    changePercent: doublePrecision("changePercent").notNull(),
    timestamp: timestamp("timestamp", { mode: "date" }).notNull().defaultNow(),
    isSnapshot: boolean("isSnapshot").notNull().default(false),
    openPrice: doublePrecision("openPrice"),
    highPrice: doublePrecision("highPrice"),
    lowPrice: doublePrecision("lowPrice"),
    volume: doublePrecision("volume"),
  },
  (table) => [
    index("StockPrice_isSnapshot_timestamp_idx").on(
      table.isSnapshot,
      table.timestamp,
    ),
    index("StockPrice_organizationId_timestamp_idx").on(
      table.organizationId,
      table.timestamp,
    ),
    index("StockPrice_timestamp_idx").on(table.timestamp),
  ],
);

// Perp market snapshot (offchain synthetic markets)
export const perpMarketSnapshots = pgTable(
  "PerpMarketSnapshot",
  {
    ticker: text("ticker").primaryKey(),
    organizationId: text("organizationId").notNull(),
    name: text("name"),
    currentPrice: doublePrecision("currentPrice").notNull(),
    /** Price from 24h ago for accurate change calculation */
    price24hAgo: doublePrecision("price24hAgo"),
    /** Timestamp when price24hAgo was last rotated */
    price24hAgoUpdatedAt: timestamp("price24hAgoUpdatedAt", { mode: "date" }),
    /** Timestamp when 24h metrics (high/low/volume) were last reset */
    metrics24hResetAt: timestamp("metrics24hResetAt", { mode: "date" }),
    change24h: doublePrecision("change24h").notNull().default(0),
    changePercent24h: doublePrecision("changePercent24h").notNull().default(0),
    high24h: doublePrecision("high24h").notNull(),
    low24h: doublePrecision("low24h").notNull(),
    volume24h: doublePrecision("volume24h").notNull().default(0),
    openInterest: doublePrecision("openInterest").notNull().default(0),
    fundingRate: jsonb("fundingRate").$type<FundingRate>().notNull(),
    maxLeverage: integer("maxLeverage").notNull().default(100),
    minOrderSize: integer("minOrderSize").notNull().default(10),
    markPrice: doublePrecision("markPrice"),
    indexPrice: doublePrecision("indexPrice"),
    createdAt: timestamp("createdAt", { mode: "date" }).notNull().defaultNow(),
    updatedAt: timestamp("updatedAt", { mode: "date" }).notNull().defaultNow(),
  },
  (table) => [index("PerpMarketSnapshot_orgId_idx").on(table.organizationId)],
);

// PerpPosition
export const perpPositions = pgTable(
  "PerpPosition",
  {
    id: text("id").primaryKey(),
    userId: text("userId").notNull(),
    ticker: text("ticker").notNull(),
    organizationId: text("organizationId").notNull(),
    side: text("side").notNull(),
    entryPrice: doublePrecision("entryPrice").notNull(),
    currentPrice: doublePrecision("currentPrice").notNull(),
    size: doublePrecision("size").notNull(),
    leverage: integer("leverage").notNull(),
    liquidationPrice: doublePrecision("liquidationPrice").notNull(),
    unrealizedPnL: doublePrecision("unrealizedPnL").notNull(),
    unrealizedPnLPercent: doublePrecision("unrealizedPnLPercent").notNull(),
    fundingPaid: doublePrecision("fundingPaid").notNull().default(0),
    openedAt: timestamp("openedAt", { mode: "date" }).notNull().defaultNow(),
    lastUpdated: timestamp("lastUpdated", { mode: "date" }).notNull(),
    closedAt: timestamp("closedAt", { mode: "date" }),
    realizedPnL: doublePrecision("realizedPnL"),
    settledAt: timestamp("settledAt", { mode: "date" }),
    settledToChain: boolean("settledToChain").notNull().default(false),
    settlementTxHash: text("settlementTxHash"),
  },
  (table) => [
    index("PerpPosition_organizationId_idx").on(table.organizationId),
    index("PerpPosition_settledToChain_idx").on(table.settledToChain),
    index("PerpPosition_ticker_idx").on(table.ticker),
    index("PerpPosition_userId_closedAt_idx").on(table.userId, table.closedAt),
  ],
);

// Relations
export const marketsRelations = relations(markets, ({ many }) => ({
  positions: many(positions),
  priceHistory: many(predictionPriceHistories),
}));

export const questionsRelations = relations(questions, ({ many }) => ({
  positions: many(positions),
}));

export const positionsRelations = relations(positions, ({ one }) => ({
  Market: one(markets, {
    fields: [positions.marketId],
    references: [markets.id],
  }),
  Question: one(questions, {
    fields: [positions.questionId],
    references: [questions.questionNumber],
  }),
  User: one(users, {
    fields: [positions.userId],
    references: [users.id],
  }),
}));

export const predictionPriceHistoriesRelations = relations(
  predictionPriceHistories,
  ({ one }) => ({
    market: one(markets, {
      fields: [predictionPriceHistories.marketId],
      references: [markets.id],
    }),
  }),
);

export const organizationsRelations = relations(organizations, ({ many }) => ({
  stockPrices: many(stockPrices),
}));

export const stockPricesRelations = relations(stockPrices, ({ one }) => ({
  Organization: one(organizations, {
    fields: [stockPrices.organizationId],
    references: [organizations.id],
  }),
}));

// Type exports
export type Market = typeof markets.$inferSelect;
export type NewMarket = typeof markets.$inferInsert;
export type Question = typeof questions.$inferSelect;
export type NewQuestion = typeof questions.$inferInsert;
export type Position = typeof positions.$inferSelect;
export type NewPosition = typeof positions.$inferInsert;
export type PredictionPriceHistory =
  typeof predictionPriceHistories.$inferSelect;
export type NewPredictionPriceHistory =
  typeof predictionPriceHistories.$inferInsert;
export type Organization = typeof organizations.$inferSelect;
export type NewOrganization = typeof organizations.$inferInsert;
export type StockPrice = typeof stockPrices.$inferSelect;
export type NewStockPrice = typeof stockPrices.$inferInsert;
export type PerpPosition = typeof perpPositions.$inferSelect;
export type NewPerpPosition = typeof perpPositions.$inferInsert;
export type PerpMarketSnapshot = typeof perpMarketSnapshots.$inferSelect;
export type NewPerpMarketSnapshot = typeof perpMarketSnapshots.$inferInsert;
