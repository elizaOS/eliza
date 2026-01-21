import { relations } from "drizzle-orm";
import {
  boolean,
  decimal,
  index,
  integer,
  json,
  pgTable,
  text,
  timestamp,
} from "drizzle-orm/pg-core";
import type { JsonValue } from "../types";
import { users } from "./users";

// BalanceTransaction
export const balanceTransactions = pgTable(
  "BalanceTransaction",
  {
    id: text("id").primaryKey(),
    userId: text("userId").notNull(),
    type: text("type").notNull(),
    amount: decimal("amount", { precision: 18, scale: 2 }).notNull(),
    balanceBefore: decimal("balanceBefore", {
      precision: 18,
      scale: 2,
    }).notNull(),
    balanceAfter: decimal("balanceAfter", {
      precision: 18,
      scale: 2,
    }).notNull(),
    relatedId: text("relatedId"),
    description: text("description"),
    createdAt: timestamp("createdAt", { mode: "date" }).notNull().defaultNow(),
  },
  (table) => [
    index("BalanceTransaction_type_idx").on(table.type),
    index("BalanceTransaction_userId_createdAt_idx").on(
      table.userId,
      table.createdAt,
    ),
    // Admin stats indexes for optimized date-range queries
    index("BalanceTransaction_type_createdAt_idx").on(
      table.type,
      table.createdAt,
    ),
    index("BalanceTransaction_userId_type_idx").on(table.userId, table.type),
  ],
);

// PointsTransaction
export const pointsTransactions = pgTable(
  "PointsTransaction",
  {
    id: text("id").primaryKey(),
    userId: text("userId").notNull(),
    amount: integer("amount").notNull(),
    pointsBefore: integer("pointsBefore").notNull(),
    pointsAfter: integer("pointsAfter").notNull(),
    reason: text("reason").notNull(),
    metadata: text("metadata"),
    createdAt: timestamp("createdAt", { mode: "date" }).notNull().defaultNow(),
    paymentAmount: text("paymentAmount"),
    paymentRequestId: text("paymentRequestId").unique(),
    paymentTxHash: text("paymentTxHash"),
    paymentVerified: boolean("paymentVerified").notNull().default(false),
  },
  (table) => [
    index("PointsTransaction_createdAt_idx").on(table.createdAt),
    index("PointsTransaction_paymentRequestId_idx").on(table.paymentRequestId),
    index("PointsTransaction_reason_idx").on(table.reason),
    index("PointsTransaction_userId_createdAt_idx").on(
      table.userId,
      table.createdAt,
    ),
  ],
);

// TradingFee
export const tradingFees = pgTable(
  "TradingFee",
  {
    id: text("id").primaryKey(),
    userId: text("userId").notNull(),
    tradeType: text("tradeType").notNull(),
    tradeId: text("tradeId"),
    marketId: text("marketId"),
    feeAmount: decimal("feeAmount", { precision: 18, scale: 2 }).notNull(),
    platformFee: decimal("platformFee", { precision: 18, scale: 2 }).notNull(),
    referrerFee: decimal("referrerFee", { precision: 18, scale: 2 }).notNull(),
    referrerId: text("referrerId"),
    createdAt: timestamp("createdAt", { mode: "date" }).notNull().defaultNow(),
  },
  (table) => [
    index("TradingFee_createdAt_idx").on(table.createdAt),
    index("TradingFee_referrerId_createdAt_idx").on(
      table.referrerId,
      table.createdAt,
    ),
    index("TradingFee_tradeType_idx").on(table.tradeType),
    index("TradingFee_userId_createdAt_idx").on(table.userId, table.createdAt),
  ],
);

// Feedback
export const feedbacks = pgTable(
  "Feedback",
  {
    id: text("id").primaryKey(),
    fromUserId: text("fromUserId"),
    fromAgentId: text("fromAgentId"),
    toUserId: text("toUserId"),
    toAgentId: text("toAgentId"),
    score: integer("score").notNull(),
    rating: integer("rating"),
    comment: text("comment"),
    category: text("category"),
    gameId: text("gameId"),
    tradeId: text("tradeId"),
    positionId: text("positionId"),
    interactionType: text("interactionType").notNull(),
    onChainTxHash: text("onChainTxHash"),
    agent0TokenId: integer("agent0TokenId"),
    metadata: json("metadata").$type<JsonValue>(),
    createdAt: timestamp("createdAt", { mode: "date" }).notNull().defaultNow(),
    updatedAt: timestamp("updatedAt", { mode: "date" }).notNull(),
  },
  (table) => [
    index("Feedback_createdAt_idx").on(table.createdAt),
    index("Feedback_fromUserId_idx").on(table.fromUserId),
    index("Feedback_gameId_idx").on(table.gameId),
    index("Feedback_interactionType_idx").on(table.interactionType),
    index("Feedback_score_idx").on(table.score),
    index("Feedback_toAgentId_idx").on(table.toAgentId),
    index("Feedback_toUserId_idx").on(table.toUserId),
    index("Feedback_toUserId_interactionType_idx").on(
      table.toUserId,
      table.interactionType,
    ),
  ],
);

// Report
export const reports = pgTable(
  "Report",
  {
    id: text("id").primaryKey(),
    reporterId: text("reporterId").notNull(),
    reportedUserId: text("reportedUserId"),
    reportedPostId: text("reportedPostId"),
    reportedCommentId: text("reportedCommentId"),
    reportType: text("reportType").notNull(),
    category: text("category").notNull(),
    reason: text("reason").notNull(),
    evidence: text("evidence"),
    status: text("status").notNull().default("pending"),
    priority: text("priority").notNull().default("normal"),
    resolution: text("resolution"),
    resolvedBy: text("resolvedBy"),
    resolvedAt: timestamp("resolvedAt", { mode: "date" }),
    createdAt: timestamp("createdAt", { mode: "date" }).notNull().defaultNow(),
    updatedAt: timestamp("updatedAt", { mode: "date" }).notNull(),
  },
  (table) => [
    index("Report_reporterId_idx").on(table.reporterId),
    index("Report_reportedUserId_idx").on(table.reportedUserId),
    index("Report_reportedPostId_idx").on(table.reportedPostId),
    index("Report_reportedCommentId_idx").on(table.reportedCommentId),
    index("Report_status_idx").on(table.status),
    index("Report_priority_status_idx").on(table.priority, table.status),
    index("Report_category_idx").on(table.category),
    index("Report_createdAt_idx").on(table.createdAt),
    index("Report_reportedUserId_status_idx").on(
      table.reportedUserId,
      table.status,
    ),
    index("Report_reportedPostId_status_idx").on(
      table.reportedPostId,
      table.status,
    ),
    index("Report_reportedCommentId_status_idx").on(
      table.reportedCommentId,
      table.status,
    ),
  ],
);

// ModerationEscrow
export const moderationEscrows = pgTable(
  "ModerationEscrow",
  {
    id: text("id").primaryKey(),
    recipientId: text("recipientId").notNull(),
    adminId: text("adminId").notNull(),
    amountUSD: decimal("amountUSD", { precision: 18, scale: 2 }).notNull(),
    amountWei: text("amountWei").notNull(),
    status: text("status").notNull().default("pending"),
    reason: text("reason"),
    paymentRequestId: text("paymentRequestId").unique(),
    paymentTxHash: text("paymentTxHash").unique(),
    refundTxHash: text("refundTxHash").unique(),
    refundedBy: text("refundedBy"),
    refundedAt: timestamp("refundedAt", { mode: "date" }),
    metadata: json("metadata").$type<JsonValue>(),
    createdAt: timestamp("createdAt", { mode: "date" }).notNull().defaultNow(),
    updatedAt: timestamp("updatedAt", { mode: "date" }).notNull(),
    expiresAt: timestamp("expiresAt", { mode: "date" }).notNull(),
  },
  (table) => [
    index("ModerationEscrow_recipientId_createdAt_idx").on(
      table.recipientId,
      table.createdAt,
    ),
    index("ModerationEscrow_adminId_idx").on(table.adminId),
    index("ModerationEscrow_status_idx").on(table.status),
    index("ModerationEscrow_paymentRequestId_idx").on(table.paymentRequestId),
    index("ModerationEscrow_paymentTxHash_idx").on(table.paymentTxHash),
    index("ModerationEscrow_createdAt_idx").on(table.createdAt),
  ],
);

// Relations
export const balanceTransactionsRelations = relations(
  balanceTransactions,
  ({ one }) => ({
    user: one(users, {
      fields: [balanceTransactions.userId],
      references: [users.id],
    }),
  }),
);

export const pointsTransactionsRelations = relations(
  pointsTransactions,
  ({ one }) => ({
    user: one(users, {
      fields: [pointsTransactions.userId],
      references: [users.id],
    }),
  }),
);

export const tradingFeesRelations = relations(tradingFees, ({ one }) => ({
  user: one(users, {
    fields: [tradingFees.userId],
    references: [users.id],
    relationName: "TradingFee_userIdToUser",
  }),
  referrer: one(users, {
    fields: [tradingFees.referrerId],
    references: [users.id],
    relationName: "TradingFee_referrerIdToUser",
  }),
}));

export const feedbacksRelations = relations(feedbacks, ({ one }) => ({
  fromUser: one(users, {
    fields: [feedbacks.fromUserId],
    references: [users.id],
    relationName: "Feedback_fromUserIdToUser",
  }),
  toUser: one(users, {
    fields: [feedbacks.toUserId],
    references: [users.id],
    relationName: "Feedback_toUserIdToUser",
  }),
}));

export const reportsRelations = relations(reports, ({ one }) => ({
  reporter: one(users, {
    fields: [reports.reporterId],
    references: [users.id],
    relationName: "Report_reporterIdToUser",
  }),
  reportedUser: one(users, {
    fields: [reports.reportedUserId],
    references: [users.id],
    relationName: "Report_reportedUserIdToUser",
  }),
  resolver: one(users, {
    fields: [reports.resolvedBy],
    references: [users.id],
    relationName: "Report_resolvedByToUser",
  }),
}));

export const moderationEscrowsRelations = relations(
  moderationEscrows,
  ({ one }) => ({
    recipient: one(users, {
      fields: [moderationEscrows.recipientId],
      references: [users.id],
    }),
    admin: one(users, {
      fields: [moderationEscrows.adminId],
      references: [users.id],
      relationName: "ModerationEscrowAdmin",
    }),
    refundedByUser: one(users, {
      fields: [moderationEscrows.refundedBy],
      references: [users.id],
      relationName: "ModerationEscrowRefundedBy",
    }),
  }),
);

// Type exports
export type BalanceTransaction = typeof balanceTransactions.$inferSelect;
export type NewBalanceTransaction = typeof balanceTransactions.$inferInsert;
export type PointsTransaction = typeof pointsTransactions.$inferSelect;
export type NewPointsTransaction = typeof pointsTransactions.$inferInsert;
export type TradingFee = typeof tradingFees.$inferSelect;
export type NewTradingFee = typeof tradingFees.$inferInsert;
export type Feedback = typeof feedbacks.$inferSelect;
export type NewFeedback = typeof feedbacks.$inferInsert;
export type Report = typeof reports.$inferSelect;
export type NewReport = typeof reports.$inferInsert;
export type ModerationEscrow = typeof moderationEscrows.$inferSelect;
export type NewModerationEscrow = typeof moderationEscrows.$inferInsert;
