import {
  bigint,
  boolean,
  doublePrecision,
  index,
  integer,
  json,
  numeric,
  pgEnum,
  pgTable,
  text,
  timestamp,
  unique,
  varchar,
} from "drizzle-orm/pg-core";
export const agentStatus = pgEnum("AgentStatus", [
  "REGISTERED",
  "INITIALIZED",
  "ACTIVE",
  "PAUSED",
  "TERMINATED",
]);
export const agentType = pgEnum("AgentType", [
  "USER_CONTROLLED",
  "NPC",
  "EXTERNAL",
]);
export const onboardingStatus = pgEnum("OnboardingStatus", [
  "PENDING_PROFILE",
  "PENDING_ONCHAIN",
  "ONCHAIN_IN_PROGRESS",
  "ONCHAIN_FAILED",
  "COMPLETED",
]);
export const realtimeOutboxStatus = pgEnum("RealtimeOutboxStatus", [
  "pending",
  "sent",
  "failed",
]);

export const worldEvent = pgTable(
  "WorldEvent",
  {
    id: text().primaryKey().notNull(),
    eventType: text().notNull(),
    description: text().notNull(),
    actors: text().array().default([""]).notNull(),
    relatedQuestion: integer(),
    pointsToward: text(),
    visibility: text().default("public").notNull(),
    gameId: text(),
    dayNumber: integer(),
    timestamp: timestamp({ mode: "string" }).defaultNow().notNull(),
    createdAt: timestamp({ mode: "string" }).defaultNow().notNull(),
  },
  (table) => [
    index("WorldEvent_gameId_dayNumber_idx").using(
      "btree",
      table.gameId.asc().nullsLast().op("text_ops"),
      table.dayNumber.asc().nullsLast().op("int4_ops"),
    ),
    index("WorldEvent_relatedQuestion_idx").using(
      "btree",
      table.relatedQuestion.asc().nullsLast().op("int4_ops"),
    ),
    index("WorldEvent_timestamp_idx").using(
      "btree",
      table.timestamp.asc().nullsLast().op("timestamp_ops"),
    ),
  ],
);

export const worldFact = pgTable(
  "WorldFact",
  {
    id: text().primaryKey().notNull(),
    category: text().notNull(),
    key: text().notNull(),
    label: text().notNull(),
    value: text().notNull(),
    source: text(),
    lastUpdated: timestamp({ mode: "string" }).notNull(),
    isActive: boolean().default(true).notNull(),
    priority: integer().default(0).notNull(),
    createdAt: timestamp({ mode: "string" }).defaultNow().notNull(),
    updatedAt: timestamp({ mode: "string" }).notNull(),
  },
  (table) => [
    index("WorldFact_category_isActive_idx").using(
      "btree",
      table.category.asc().nullsLast().op("bool_ops"),
      table.isActive.asc().nullsLast().op("text_ops"),
    ),
    index("WorldFact_lastUpdated_idx").using(
      "btree",
      table.lastUpdated.asc().nullsLast().op("timestamp_ops"),
    ),
    index("WorldFact_priority_idx").using(
      "btree",
      table.priority.asc().nullsLast().op("int4_ops"),
    ),
  ],
);

export const poolDeposit = pgTable(
  "PoolDeposit",
  {
    id: text().primaryKey().notNull(),
    poolId: text().notNull(),
    userId: text().notNull(),
    amount: numeric({ precision: 18, scale: 2 }).notNull(),
    shares: numeric({ precision: 18, scale: 6 }).notNull(),
    currentValue: numeric({ precision: 18, scale: 2 }).notNull(),
    unrealizedPnL: numeric({ precision: 18, scale: 2 }).notNull(),
    depositedAt: timestamp({ mode: "string" }).defaultNow().notNull(),
    withdrawnAt: timestamp({ mode: "string" }),
    withdrawnAmount: numeric({ precision: 18, scale: 2 }),
  },
  (table) => [
    index("PoolDeposit_poolId_userId_idx").using(
      "btree",
      table.poolId.asc().nullsLast().op("text_ops"),
      table.userId.asc().nullsLast().op("text_ops"),
    ),
    index("PoolDeposit_poolId_withdrawnAt_idx").using(
      "btree",
      table.poolId.asc().nullsLast().op("text_ops"),
      table.withdrawnAt.asc().nullsLast().op("text_ops"),
    ),
    index("PoolDeposit_userId_depositedAt_idx").using(
      "btree",
      table.userId.asc().nullsLast().op("text_ops"),
      table.depositedAt.asc().nullsLast().op("text_ops"),
    ),
  ],
);

export const poolPosition = pgTable(
  "PoolPosition",
  {
    id: text().primaryKey().notNull(),
    poolId: text().notNull(),
    marketType: text().notNull(),
    ticker: text(),
    marketId: text(),
    side: text().notNull(),
    entryPrice: doublePrecision().notNull(),
    currentPrice: doublePrecision().notNull(),
    size: doublePrecision().notNull(),
    shares: doublePrecision(),
    leverage: integer(),
    liquidationPrice: doublePrecision(),
    unrealizedPnL: doublePrecision().notNull(),
    openedAt: timestamp({ mode: "string" }).defaultNow().notNull(),
    closedAt: timestamp({ mode: "string" }),
    realizedPnL: doublePrecision(),
    updatedAt: timestamp({ mode: "string" }).notNull(),
  },
  (table) => [
    index("PoolPosition_marketType_marketId_idx").using(
      "btree",
      table.marketType.asc().nullsLast().op("text_ops"),
      table.marketId.asc().nullsLast().op("text_ops"),
    ),
    index("PoolPosition_marketType_ticker_idx").using(
      "btree",
      table.marketType.asc().nullsLast().op("text_ops"),
      table.ticker.asc().nullsLast().op("text_ops"),
    ),
    index("PoolPosition_poolId_closedAt_idx").using(
      "btree",
      table.poolId.asc().nullsLast().op("text_ops"),
      table.closedAt.asc().nullsLast().op("text_ops"),
    ),
  ],
);

export const pool = pgTable(
  "Pool",
  {
    id: text().primaryKey().notNull(),
    npcActorId: text().notNull(),
    name: text().notNull(),
    description: text(),
    totalValue: numeric({ precision: 18, scale: 2 }).default("0").notNull(),
    totalDeposits: numeric({ precision: 18, scale: 2 }).default("0").notNull(),
    availableBalance: numeric({ precision: 18, scale: 2 })
      .default("0")
      .notNull(),
    lifetimePnL: numeric({ precision: 18, scale: 2 }).default("0").notNull(),
    performanceFeeRate: doublePrecision().default(0.05).notNull(),
    totalFeesCollected: numeric({ precision: 18, scale: 2 })
      .default("0")
      .notNull(),
    isActive: boolean().default(true).notNull(),
    openedAt: timestamp({ mode: "string" }).defaultNow().notNull(),
    closedAt: timestamp({ mode: "string" }),
    updatedAt: timestamp({ mode: "string" }).notNull(),
    currentPrice: doublePrecision(),
    priceChange24H: doublePrecision(),
    status: text().default("ACTIVE").notNull(),
    tvl: numeric({ precision: 18, scale: 2 }),
    volume24H: numeric({ precision: 18, scale: 2 }),
  },
  (table) => [
    index("Pool_isActive_idx").using(
      "btree",
      table.isActive.asc().nullsLast().op("bool_ops"),
    ),
    index("Pool_npcActorId_idx").using(
      "btree",
      table.npcActorId.asc().nullsLast().op("text_ops"),
    ),
    index("Pool_status_idx").using(
      "btree",
      table.status.asc().nullsLast().op("text_ops"),
    ),
    index("Pool_totalValue_idx").using(
      "btree",
      table.totalValue.asc().nullsLast().op("numeric_ops"),
    ),
    index("Pool_volume24h_idx").using(
      "btree",
      table.volume24H.asc().nullsLast().op("numeric_ops"),
    ),
  ],
);

export const comment = pgTable(
  "Comment",
  {
    id: text().primaryKey().notNull(),
    content: text().notNull(),
    postId: text().notNull(),
    authorId: text().notNull(),
    parentCommentId: text(),
    createdAt: timestamp({ mode: "string" }).defaultNow().notNull(),
    updatedAt: timestamp({ mode: "string" }).notNull(),
    deletedAt: timestamp({ mode: "string" }),
  },
  (table) => [
    index("Comment_authorId_idx").using(
      "btree",
      table.authorId.asc().nullsLast().op("text_ops"),
    ),
    index("Comment_deletedAt_idx").using(
      "btree",
      table.deletedAt.asc().nullsLast().op("timestamp_ops"),
    ),
    index("Comment_parentCommentId_idx").using(
      "btree",
      table.parentCommentId.asc().nullsLast().op("text_ops"),
    ),
    index("Comment_postId_createdAt_idx").using(
      "btree",
      table.postId.asc().nullsLast().op("text_ops"),
      table.createdAt.asc().nullsLast().op("text_ops"),
    ),
    index("Comment_postId_deletedAt_idx").using(
      "btree",
      table.postId.asc().nullsLast().op("text_ops"),
      table.deletedAt.asc().nullsLast().op("text_ops"),
    ),
  ],
);

export const postTag = pgTable(
  "PostTag",
  {
    id: text().primaryKey().notNull(),
    postId: text().notNull(),
    tagId: text().notNull(),
    createdAt: timestamp({ mode: "string" }).defaultNow().notNull(),
  },
  (table) => [
    index("PostTag_postId_idx").using(
      "btree",
      table.postId.asc().nullsLast().op("text_ops"),
    ),
    index("PostTag_tagId_createdAt_idx").using(
      "btree",
      table.tagId.asc().nullsLast().op("text_ops"),
      table.createdAt.asc().nullsLast().op("text_ops"),
    ),
    index("PostTag_tagId_idx").using(
      "btree",
      table.tagId.asc().nullsLast().op("text_ops"),
    ),
    unique("PostTag_postId_tagId_key").on(table.postId, table.tagId),
  ],
);

export const post = pgTable(
  "Post",
  {
    id: text().primaryKey().notNull(),
    content: text().notNull(),
    authorId: text().notNull(),
    gameId: text(),
    dayNumber: integer(),
    timestamp: timestamp({ mode: "string" }).defaultNow().notNull(),
    createdAt: timestamp({ mode: "string" }).defaultNow().notNull(),
    articleTitle: text(),
    biasScore: doublePrecision(),
    byline: text(),
    category: text(),
    fullContent: text(),
    sentiment: text(),
    slant: text(),
    type: text().default("post").notNull(),
    deletedAt: timestamp({ mode: "string" }),
    commentOnPostId: text(),
    parentCommentId: text(),
    originalPostId: text(),
  },
  (table) => [
    index("Post_authorId_timestamp_idx").using(
      "btree",
      table.authorId.asc().nullsLast().op("text_ops"),
      table.timestamp.asc().nullsLast().op("text_ops"),
    ),
    index("Post_authorId_type_timestamp_idx").using(
      "btree",
      table.authorId.asc().nullsLast().op("timestamp_ops"),
      table.type.asc().nullsLast().op("text_ops"),
      table.timestamp.asc().nullsLast().op("text_ops"),
    ),
    index("Post_commentOnPostId_idx").using(
      "btree",
      table.commentOnPostId.asc().nullsLast().op("text_ops"),
    ),
    index("Post_deletedAt_idx").using(
      "btree",
      table.deletedAt.asc().nullsLast().op("timestamp_ops"),
    ),
    index("Post_gameId_dayNumber_idx").using(
      "btree",
      table.gameId.asc().nullsLast().op("int4_ops"),
      table.dayNumber.asc().nullsLast().op("int4_ops"),
    ),
    index("Post_originalPostId_idx").using(
      "btree",
      table.originalPostId.asc().nullsLast().op("text_ops"),
    ),
    index("Post_parentCommentId_idx").using(
      "btree",
      table.parentCommentId.asc().nullsLast().op("text_ops"),
    ),
    index("Post_timestamp_idx").using(
      "btree",
      table.timestamp.asc().nullsLast().op("timestamp_ops"),
    ),
    index("Post_type_deletedAt_timestamp_idx").using(
      "btree",
      table.type.asc().nullsLast().op("text_ops"),
      table.deletedAt.asc().nullsLast().op("text_ops"),
      table.timestamp.asc().nullsLast().op("text_ops"),
    ),
    index("Post_type_timestamp_idx").using(
      "btree",
      table.type.asc().nullsLast().op("text_ops"),
      table.timestamp.asc().nullsLast().op("text_ops"),
    ),
  ],
);

export const reaction = pgTable(
  "Reaction",
  {
    id: text().primaryKey().notNull(),
    postId: text(),
    commentId: text(),
    userId: text().notNull(),
    type: text().default("like").notNull(),
    createdAt: timestamp({ mode: "string" }).defaultNow().notNull(),
  },
  (table) => [
    index("Reaction_commentId_idx").using(
      "btree",
      table.commentId.asc().nullsLast().op("text_ops"),
    ),
    index("Reaction_postId_idx").using(
      "btree",
      table.postId.asc().nullsLast().op("text_ops"),
    ),
    index("Reaction_userId_idx").using(
      "btree",
      table.userId.asc().nullsLast().op("text_ops"),
    ),
    unique("Reaction_postId_userId_type_key").on(
      table.postId,
      table.userId,
      table.type,
    ),
    unique("Reaction_commentId_userId_type_key").on(
      table.commentId,
      table.userId,
      table.type,
    ),
  ],
);

export const shareAction = pgTable(
  "ShareAction",
  {
    id: text().primaryKey().notNull(),
    userId: text().notNull(),
    platform: text().notNull(),
    contentType: text().notNull(),
    contentId: text(),
    url: text(),
    pointsAwarded: boolean().default(false).notNull(),
    createdAt: timestamp({ mode: "string" }).defaultNow().notNull(),
    verificationDetails: text(),
    verified: boolean().default(false).notNull(),
    verifiedAt: timestamp({ mode: "string" }),
  },
  (table) => [
    index("ShareAction_contentType_idx").using(
      "btree",
      table.contentType.asc().nullsLast().op("text_ops"),
    ),
    index("ShareAction_platform_idx").using(
      "btree",
      table.platform.asc().nullsLast().op("text_ops"),
    ),
    index("ShareAction_userId_createdAt_idx").using(
      "btree",
      table.userId.asc().nullsLast().op("timestamp_ops"),
      table.createdAt.asc().nullsLast().op("text_ops"),
    ),
    index("ShareAction_verified_idx").using(
      "btree",
      table.verified.asc().nullsLast().op("bool_ops"),
    ),
  ],
);

export const share = pgTable(
  "Share",
  {
    id: text().primaryKey().notNull(),
    userId: text().notNull(),
    postId: text().notNull(),
    createdAt: timestamp({ mode: "string" }).defaultNow().notNull(),
  },
  (table) => [
    index("Share_createdAt_idx").using(
      "btree",
      table.createdAt.asc().nullsLast().op("timestamp_ops"),
    ),
    index("Share_postId_idx").using(
      "btree",
      table.postId.asc().nullsLast().op("text_ops"),
    ),
    index("Share_userId_idx").using(
      "btree",
      table.userId.asc().nullsLast().op("text_ops"),
    ),
    unique("Share_userId_postId_key").on(table.userId, table.postId),
  ],
);

export const tag = pgTable(
  "Tag",
  {
    id: text().primaryKey().notNull(),
    name: text().notNull(),
    displayName: text().notNull(),
    category: text(),
    createdAt: timestamp({ mode: "string" }).defaultNow().notNull(),
    updatedAt: timestamp({ mode: "string" }).notNull(),
  },
  (table) => [
    index("Tag_name_idx").using(
      "btree",
      table.name.asc().nullsLast().op("text_ops"),
    ),
    unique("Tag_name_unique").on(table.name),
  ],
);

export const trendingTag = pgTable(
  "TrendingTag",
  {
    id: text().primaryKey().notNull(),
    tagId: text().notNull(),
    score: doublePrecision().notNull(),
    postCount: integer().notNull(),
    rank: integer().notNull(),
    calculatedAt: timestamp({ mode: "string" }).defaultNow().notNull(),
    windowStart: timestamp({ mode: "string" }).notNull(),
    windowEnd: timestamp({ mode: "string" }).notNull(),
    relatedContext: text(),
  },
  (table) => [
    index("TrendingTag_calculatedAt_idx").using(
      "btree",
      table.calculatedAt.asc().nullsLast().op("timestamp_ops"),
    ),
    index("TrendingTag_rank_calculatedAt_idx").using(
      "btree",
      table.rank.asc().nullsLast().op("int4_ops"),
      table.calculatedAt.asc().nullsLast().op("timestamp_ops"),
    ),
    index("TrendingTag_tagId_calculatedAt_idx").using(
      "btree",
      table.tagId.asc().nullsLast().op("text_ops"),
      table.calculatedAt.asc().nullsLast().op("text_ops"),
    ),
  ],
);

export const balanceTransaction = pgTable(
  "BalanceTransaction",
  {
    id: text().primaryKey().notNull(),
    userId: text().notNull(),
    type: text().notNull(),
    amount: numeric({ precision: 18, scale: 2 }).notNull(),
    balanceBefore: numeric({ precision: 18, scale: 2 }).notNull(),
    balanceAfter: numeric({ precision: 18, scale: 2 }).notNull(),
    relatedId: text(),
    description: text(),
    createdAt: timestamp({ mode: "string" }).defaultNow().notNull(),
  },
  (table) => [
    index("BalanceTransaction_type_idx").using(
      "btree",
      table.type.asc().nullsLast().op("text_ops"),
    ),
    index("BalanceTransaction_userId_createdAt_idx").using(
      "btree",
      table.userId.asc().nullsLast().op("text_ops"),
      table.createdAt.asc().nullsLast().op("text_ops"),
    ),
  ],
);

export const feedback = pgTable(
  "Feedback",
  {
    id: text().primaryKey().notNull(),
    fromUserId: text(),
    fromAgentId: text(),
    toUserId: text(),
    toAgentId: text(),
    score: integer().notNull(),
    rating: integer(),
    comment: text(),
    category: text(),
    gameId: text(),
    tradeId: text(),
    positionId: text(),
    interactionType: text().notNull(),
    onChainTxHash: text(),
    agent0TokenId: integer(),
    metadata: json(),
    createdAt: timestamp({ mode: "string" }).defaultNow().notNull(),
    updatedAt: timestamp({ mode: "string" }).notNull(),
  },
  (table) => [
    index("Feedback_createdAt_idx").using(
      "btree",
      table.createdAt.asc().nullsLast().op("timestamp_ops"),
    ),
    index("Feedback_fromUserId_idx").using(
      "btree",
      table.fromUserId.asc().nullsLast().op("text_ops"),
    ),
    index("Feedback_gameId_idx").using(
      "btree",
      table.gameId.asc().nullsLast().op("text_ops"),
    ),
    index("Feedback_interactionType_idx").using(
      "btree",
      table.interactionType.asc().nullsLast().op("text_ops"),
    ),
    index("Feedback_score_idx").using(
      "btree",
      table.score.asc().nullsLast().op("int4_ops"),
    ),
    index("Feedback_toAgentId_idx").using(
      "btree",
      table.toAgentId.asc().nullsLast().op("text_ops"),
    ),
    index("Feedback_toUserId_idx").using(
      "btree",
      table.toUserId.asc().nullsLast().op("text_ops"),
    ),
    index("Feedback_toUserId_interactionType_idx").using(
      "btree",
      table.toUserId.asc().nullsLast().op("text_ops"),
      table.interactionType.asc().nullsLast().op("text_ops"),
    ),
  ],
);

export const moderationEscrow = pgTable(
  "ModerationEscrow",
  {
    id: text().primaryKey().notNull(),
    recipientId: text().notNull(),
    adminId: text().notNull(),
    amountUsd: numeric({ precision: 18, scale: 2 }).notNull(),
    amountWei: text().notNull(),
    status: text().default("pending").notNull(),
    reason: text(),
    paymentRequestId: text(),
    paymentTxHash: text(),
    refundTxHash: text(),
    refundedBy: text(),
    refundedAt: timestamp({ mode: "string" }),
    metadata: json(),
    createdAt: timestamp({ mode: "string" }).defaultNow().notNull(),
    updatedAt: timestamp({ mode: "string" }).notNull(),
    expiresAt: timestamp({ mode: "string" }).notNull(),
  },
  (table) => [
    index("ModerationEscrow_adminId_idx").using(
      "btree",
      table.adminId.asc().nullsLast().op("text_ops"),
    ),
    index("ModerationEscrow_createdAt_idx").using(
      "btree",
      table.createdAt.asc().nullsLast().op("timestamp_ops"),
    ),
    index("ModerationEscrow_paymentRequestId_idx").using(
      "btree",
      table.paymentRequestId.asc().nullsLast().op("text_ops"),
    ),
    index("ModerationEscrow_paymentTxHash_idx").using(
      "btree",
      table.paymentTxHash.asc().nullsLast().op("text_ops"),
    ),
    index("ModerationEscrow_recipientId_createdAt_idx").using(
      "btree",
      table.recipientId.asc().nullsLast().op("timestamp_ops"),
      table.createdAt.asc().nullsLast().op("timestamp_ops"),
    ),
    index("ModerationEscrow_status_idx").using(
      "btree",
      table.status.asc().nullsLast().op("text_ops"),
    ),
    unique("ModerationEscrow_paymentRequestId_unique").on(
      table.paymentRequestId,
    ),
    unique("ModerationEscrow_paymentTxHash_unique").on(table.paymentTxHash),
    unique("ModerationEscrow_refundTxHash_unique").on(table.refundTxHash),
  ],
);

export const pointsTransaction = pgTable(
  "PointsTransaction",
  {
    id: text().primaryKey().notNull(),
    userId: text().notNull(),
    amount: integer().notNull(),
    pointsBefore: integer().notNull(),
    pointsAfter: integer().notNull(),
    reason: text().notNull(),
    metadata: text(),
    createdAt: timestamp({ mode: "string" }).defaultNow().notNull(),
    paymentAmount: text(),
    paymentRequestId: text(),
    paymentTxHash: text(),
    paymentVerified: boolean().default(false).notNull(),
  },
  (table) => [
    index("PointsTransaction_createdAt_idx").using(
      "btree",
      table.createdAt.asc().nullsLast().op("timestamp_ops"),
    ),
    index("PointsTransaction_paymentRequestId_idx").using(
      "btree",
      table.paymentRequestId.asc().nullsLast().op("text_ops"),
    ),
    index("PointsTransaction_reason_idx").using(
      "btree",
      table.reason.asc().nullsLast().op("text_ops"),
    ),
    index("PointsTransaction_userId_createdAt_idx").using(
      "btree",
      table.userId.asc().nullsLast().op("text_ops"),
      table.createdAt.asc().nullsLast().op("text_ops"),
    ),
    unique("PointsTransaction_paymentRequestId_unique").on(
      table.paymentRequestId,
    ),
  ],
);

export const report = pgTable(
  "Report",
  {
    id: text().primaryKey().notNull(),
    reporterId: text().notNull(),
    reportedUserId: text(),
    reportedPostId: text(),
    reportType: text().notNull(),
    category: text().notNull(),
    reason: text().notNull(),
    evidence: text(),
    status: text().default("pending").notNull(),
    priority: text().default("normal").notNull(),
    resolution: text(),
    resolvedBy: text(),
    resolvedAt: timestamp({ mode: "string" }),
    createdAt: timestamp({ mode: "string" }).defaultNow().notNull(),
    updatedAt: timestamp({ mode: "string" }).notNull(),
  },
  (table) => [
    index("Report_category_idx").using(
      "btree",
      table.category.asc().nullsLast().op("text_ops"),
    ),
    index("Report_createdAt_idx").using(
      "btree",
      table.createdAt.asc().nullsLast().op("timestamp_ops"),
    ),
    index("Report_priority_status_idx").using(
      "btree",
      table.priority.asc().nullsLast().op("text_ops"),
      table.status.asc().nullsLast().op("text_ops"),
    ),
    index("Report_reportedPostId_idx").using(
      "btree",
      table.reportedPostId.asc().nullsLast().op("text_ops"),
    ),
    index("Report_reportedPostId_status_idx").using(
      "btree",
      table.reportedPostId.asc().nullsLast().op("text_ops"),
      table.status.asc().nullsLast().op("text_ops"),
    ),
    index("Report_reportedUserId_idx").using(
      "btree",
      table.reportedUserId.asc().nullsLast().op("text_ops"),
    ),
    index("Report_reportedUserId_status_idx").using(
      "btree",
      table.reportedUserId.asc().nullsLast().op("text_ops"),
      table.status.asc().nullsLast().op("text_ops"),
    ),
    index("Report_reporterId_idx").using(
      "btree",
      table.reporterId.asc().nullsLast().op("text_ops"),
    ),
    index("Report_status_idx").using(
      "btree",
      table.status.asc().nullsLast().op("text_ops"),
    ),
  ],
);

export const tradingFee = pgTable(
  "TradingFee",
  {
    id: text().primaryKey().notNull(),
    userId: text().notNull(),
    tradeType: text().notNull(),
    tradeId: text(),
    marketId: text(),
    feeAmount: numeric({ precision: 18, scale: 2 }).notNull(),
    platformFee: numeric({ precision: 18, scale: 2 }).notNull(),
    referrerFee: numeric({ precision: 18, scale: 2 }).notNull(),
    referrerId: text(),
    createdAt: timestamp({ mode: "string" }).defaultNow().notNull(),
  },
  (table) => [
    index("TradingFee_createdAt_idx").using(
      "btree",
      table.createdAt.asc().nullsLast().op("timestamp_ops"),
    ),
    index("TradingFee_referrerId_createdAt_idx").using(
      "btree",
      table.referrerId.asc().nullsLast().op("text_ops"),
      table.createdAt.asc().nullsLast().op("timestamp_ops"),
    ),
    index("TradingFee_tradeType_idx").using(
      "btree",
      table.tradeType.asc().nullsLast().op("text_ops"),
    ),
    index("TradingFee_userId_createdAt_idx").using(
      "btree",
      table.userId.asc().nullsLast().op("text_ops"),
      table.createdAt.asc().nullsLast().op("text_ops"),
    ),
  ],
);

export const benchmarkResults = pgTable(
  "benchmark_results",
  {
    id: text().primaryKey().notNull(),
    modelId: text().notNull(),
    benchmarkId: text().notNull(),
    benchmarkPath: text().notNull(),
    runAt: timestamp({ mode: "string" }).defaultNow().notNull(),
    totalPnl: doublePrecision().notNull(),
    predictionAccuracy: doublePrecision().notNull(),
    perpWinRate: doublePrecision().notNull(),
    optimalityScore: doublePrecision().notNull(),
    detailedMetrics: json().notNull(),
    baselinePnlDelta: doublePrecision(),
    baselineAccuracyDelta: doublePrecision(),
    improved: boolean(),
    duration: integer().notNull(),
    createdAt: timestamp({ mode: "string" }).defaultNow().notNull(),
  },
  (table) => [
    index("benchmark_results_benchmarkId_idx").using(
      "btree",
      table.benchmarkId.asc().nullsLast().op("text_ops"),
    ),
    index("benchmark_results_modelId_idx").using(
      "btree",
      table.modelId.asc().nullsLast().op("text_ops"),
    ),
    index("benchmark_results_optimalityScore_idx").using(
      "btree",
      table.optimalityScore.asc().nullsLast().op("float8_ops"),
    ),
    index("benchmark_results_runAt_idx").using(
      "btree",
      table.runAt.asc().nullsLast().op("timestamp_ops"),
    ),
  ],
);

export const llmCallLogs = pgTable(
  "llm_call_logs",
  {
    id: text().primaryKey().notNull(),
    trajectoryId: text().notNull(),
    stepId: text().notNull(),
    callId: text().notNull(),
    timestamp: timestamp({ mode: "string" }).notNull(),
    latencyMs: integer(),
    model: text().notNull(),
    purpose: text().notNull(),
    actionType: text(),
    systemPrompt: text().notNull(),
    userPrompt: text().notNull(),
    messagesJson: text(),
    response: text().notNull(),
    reasoning: text(),
    temperature: doublePrecision().notNull(),
    maxTokens: integer().notNull(),
    topP: doublePrecision(),
    promptTokens: integer(),
    completionTokens: integer(),
    totalTokens: integer(),
    metadata: text(),
    createdAt: timestamp({ mode: "string" }).defaultNow().notNull(),
  },
  (table) => [
    index("llm_call_logs_callId_idx").using(
      "btree",
      table.callId.asc().nullsLast().op("text_ops"),
    ),
    index("llm_call_logs_timestamp_idx").using(
      "btree",
      table.timestamp.asc().nullsLast().op("timestamp_ops"),
    ),
    index("llm_call_logs_trajectoryId_idx").using(
      "btree",
      table.trajectoryId.asc().nullsLast().op("text_ops"),
    ),
    unique("llm_call_logs_callId_unique").on(table.callId),
  ],
);

export const marketOutcomes = pgTable(
  "market_outcomes",
  {
    id: text().primaryKey().notNull(),
    windowId: varchar({ length: 50 }).notNull(),
    stockTicker: varchar({ length: 20 }),
    startPrice: numeric({ precision: 10, scale: 2 }),
    endPrice: numeric({ precision: 10, scale: 2 }),
    changePercent: numeric({ precision: 5, scale: 2 }),
    sentiment: varchar({ length: 20 }),
    newsEvents: json(),
    predictionMarketId: text(),
    question: text(),
    outcome: varchar({ length: 20 }),
    finalProbability: numeric({ precision: 5, scale: 4 }),
    volume: numeric({ precision: 15, scale: 2 }),
    createdAt: timestamp({ mode: "string" }).defaultNow().notNull(),
  },
  (table) => [
    index("market_outcomes_windowId_idx").using(
      "btree",
      table.windowId.asc().nullsLast().op("text_ops"),
    ),
    index("market_outcomes_windowId_stockTicker_idx").using(
      "btree",
      table.windowId.asc().nullsLast().op("text_ops"),
      table.stockTicker.asc().nullsLast().op("text_ops"),
    ),
  ],
);

export const rewardJudgments = pgTable(
  "reward_judgments",
  {
    id: text().primaryKey().notNull(),
    trajectoryId: text().notNull(),
    judgeModel: text().notNull(),
    judgeVersion: text().notNull(),
    overallScore: doublePrecision().notNull(),
    componentScoresJson: text(),
    rank: integer(),
    normalizedScore: doublePrecision(),
    groupId: text(),
    reasoning: text().notNull(),
    strengthsJson: text(),
    weaknessesJson: text(),
    criteriaJson: text().notNull(),
    judgedAt: timestamp({ mode: "string" }).defaultNow().notNull(),
  },
  (table) => [
    index("reward_judgments_groupId_rank_idx").using(
      "btree",
      table.groupId.asc().nullsLast().op("int4_ops"),
      table.rank.asc().nullsLast().op("text_ops"),
    ),
    index("reward_judgments_overallScore_idx").using(
      "btree",
      table.overallScore.asc().nullsLast().op("float8_ops"),
    ),
    unique("reward_judgments_trajectoryId_unique").on(table.trajectoryId),
  ],
);

export const trainedModels = pgTable(
  "trained_models",
  {
    id: text().primaryKey().notNull(),
    modelId: text().notNull(),
    version: text().notNull(),
    baseModel: text().notNull(),
    trainingBatch: text(),
    status: text().default("training").notNull(),
    deployedAt: timestamp({ mode: "string" }),
    archivedAt: timestamp({ mode: "string" }),
    storagePath: text().notNull(),
    benchmarkScore: doublePrecision(),
    accuracy: doublePrecision(),
    avgReward: doublePrecision(),
    evalMetrics: json(),
    wandbRunId: text(),
    wandbArtifactId: text(),
    huggingFaceRepo: text(),
    agentsUsing: integer().default(0).notNull(),
    totalInferences: integer().default(0).notNull(),
    lastBenchmarked: timestamp({ mode: "string" }),
    benchmarkCount: integer().default(0).notNull(),
    createdAt: timestamp({ mode: "string" }).defaultNow().notNull(),
    updatedAt: timestamp({ mode: "string" }).notNull(),
  },
  (table) => [
    index("trained_models_deployedAt_idx").using(
      "btree",
      table.deployedAt.asc().nullsLast().op("timestamp_ops"),
    ),
    index("trained_models_lastBenchmarked_idx").using(
      "btree",
      table.lastBenchmarked.asc().nullsLast().op("timestamp_ops"),
    ),
    index("trained_models_status_idx").using(
      "btree",
      table.status.asc().nullsLast().op("text_ops"),
    ),
    index("trained_models_version_idx").using(
      "btree",
      table.version.asc().nullsLast().op("text_ops"),
    ),
    unique("trained_models_modelId_unique").on(table.modelId),
  ],
);

export const trainingBatches = pgTable(
  "training_batches",
  {
    id: text().primaryKey().notNull(),
    batchId: text().notNull(),
    scenarioId: text(),
    baseModel: text().notNull(),
    modelVersion: text().notNull(),
    trajectoryIds: text().notNull(),
    rankingsJson: text(),
    rewardsJson: text().notNull(),
    trainingLoss: doublePrecision(),
    policyImprovement: doublePrecision(),
    status: text().default("pending").notNull(),
    error: text(),
    createdAt: timestamp({ mode: "string" }).defaultNow().notNull(),
    startedAt: timestamp({ mode: "string" }),
    completedAt: timestamp({ mode: "string" }),
  },
  (table) => [
    index("training_batches_scenarioId_idx").using(
      "btree",
      table.scenarioId.asc().nullsLast().op("text_ops"),
    ),
    index("training_batches_status_createdAt_idx").using(
      "btree",
      table.status.asc().nullsLast().op("text_ops"),
      table.createdAt.asc().nullsLast().op("text_ops"),
    ),
    unique("training_batches_batchId_unique").on(table.batchId),
  ],
);

export const trajectories = pgTable(
  "trajectories",
  {
    id: text().primaryKey().notNull(),
    trajectoryId: text().notNull(),
    agentId: text().notNull(),
    startTime: timestamp({ mode: "string" }).notNull(),
    endTime: timestamp({ mode: "string" }).notNull(),
    durationMs: integer().notNull(),
    windowId: varchar({ length: 50 }),
    windowHours: integer().default(1).notNull(),
    episodeId: varchar({ length: 100 }),
    scenarioId: varchar({ length: 100 }),
    batchId: varchar({ length: 100 }),
    stepsJson: text().notNull(),
    rewardComponentsJson: text().notNull(),
    metricsJson: text().notNull(),
    metadataJson: text().notNull(),
    totalReward: doublePrecision().notNull(),
    episodeLength: integer().notNull(),
    finalStatus: text().notNull(),
    finalBalance: doublePrecision(),
    finalPnL: doublePrecision(),
    tradesExecuted: integer(),
    postsCreated: integer(),
    aiJudgeReward: doublePrecision(),
    aiJudgeReasoning: text(),
    judgedAt: timestamp({ mode: "string" }),
    isTrainingData: boolean().default(true).notNull(),
    isEvaluation: boolean().default(false).notNull(),
    usedInTraining: boolean().default(false).notNull(),
    trainedInBatch: text(),
    createdAt: timestamp({ mode: "string" }).defaultNow().notNull(),
    updatedAt: timestamp({ mode: "string" }).notNull(),
  },
  (table) => [
    index("trajectories_agentId_startTime_idx").using(
      "btree",
      table.agentId.asc().nullsLast().op("timestamp_ops"),
      table.startTime.asc().nullsLast().op("text_ops"),
    ),
    index("trajectories_aiJudgeReward_idx").using(
      "btree",
      table.aiJudgeReward.asc().nullsLast().op("float8_ops"),
    ),
    index("trajectories_isTrainingData_usedInTraining_idx").using(
      "btree",
      table.isTrainingData.asc().nullsLast().op("bool_ops"),
      table.usedInTraining.asc().nullsLast().op("bool_ops"),
    ),
    index("trajectories_scenarioId_createdAt_idx").using(
      "btree",
      table.scenarioId.asc().nullsLast().op("text_ops"),
      table.createdAt.asc().nullsLast().op("text_ops"),
    ),
    index("trajectories_trainedInBatch_idx").using(
      "btree",
      table.trainedInBatch.asc().nullsLast().op("text_ops"),
    ),
    index("trajectories_windowId_agentId_idx").using(
      "btree",
      table.windowId.asc().nullsLast().op("text_ops"),
      table.agentId.asc().nullsLast().op("text_ops"),
    ),
    index("trajectories_windowId_idx").using(
      "btree",
      table.windowId.asc().nullsLast().op("text_ops"),
    ),
    unique("trajectories_trajectoryId_unique").on(table.trajectoryId),
  ],
);

export const favorite = pgTable(
  "Favorite",
  {
    id: text().primaryKey().notNull(),
    userId: text().notNull(),
    targetUserId: text().notNull(),
    createdAt: timestamp({ mode: "string" }).defaultNow().notNull(),
  },
  (table) => [
    index("Favorite_targetUserId_idx").using(
      "btree",
      table.targetUserId.asc().nullsLast().op("text_ops"),
    ),
    index("Favorite_userId_idx").using(
      "btree",
      table.userId.asc().nullsLast().op("text_ops"),
    ),
    unique("Favorite_userId_targetUserId_key").on(
      table.userId,
      table.targetUserId,
    ),
  ],
);

export const followStatus = pgTable(
  "FollowStatus",
  {
    id: text().primaryKey().notNull(),
    userId: text().notNull(),
    npcId: text().notNull(),
    followedAt: timestamp({ mode: "string" }).defaultNow().notNull(),
    unfollowedAt: timestamp({ mode: "string" }),
    isActive: boolean().default(true).notNull(),
    followReason: text(),
  },
  (table) => [
    index("FollowStatus_npcId_idx").using(
      "btree",
      table.npcId.asc().nullsLast().op("text_ops"),
    ),
    index("FollowStatus_userId_isActive_idx").using(
      "btree",
      table.userId.asc().nullsLast().op("text_ops"),
      table.isActive.asc().nullsLast().op("bool_ops"),
    ),
    unique("FollowStatus_userId_npcId_key").on(table.userId, table.npcId),
  ],
);

export const follow = pgTable(
  "Follow",
  {
    id: text().primaryKey().notNull(),
    followerId: text().notNull(),
    followingId: text().notNull(),
    createdAt: timestamp({ mode: "string" }).defaultNow().notNull(),
  },
  (table) => [
    index("Follow_followerId_idx").using(
      "btree",
      table.followerId.asc().nullsLast().op("text_ops"),
    ),
    index("Follow_followingId_idx").using(
      "btree",
      table.followingId.asc().nullsLast().op("text_ops"),
    ),
    unique("Follow_followerId_followingId_key").on(
      table.followerId,
      table.followingId,
    ),
  ],
);

export const onboardingIntent = pgTable(
  "OnboardingIntent",
  {
    id: text().primaryKey().notNull(),
    userId: text().notNull(),
    status: onboardingStatus().default("PENDING_PROFILE").notNull(),
    referralCode: text(),
    payload: json(),
    profileApplied: boolean().default(false).notNull(),
    profileCompletedAt: timestamp({ mode: "string" }),
    onchainStartedAt: timestamp({ mode: "string" }),
    onchainCompletedAt: timestamp({ mode: "string" }),
    lastError: json(),
    createdAt: timestamp({ mode: "string" }).defaultNow().notNull(),
    updatedAt: timestamp({ mode: "string" }).notNull(),
  },
  (table) => [
    index("OnboardingIntent_createdAt_idx").using(
      "btree",
      table.createdAt.asc().nullsLast().op("timestamp_ops"),
    ),
    index("OnboardingIntent_status_idx").using(
      "btree",
      table.status.asc().nullsLast().op("enum_ops"),
    ),
    unique("OnboardingIntent_userId_unique").on(table.userId),
  ],
);

export const profileUpdateLog = pgTable(
  "ProfileUpdateLog",
  {
    id: text().primaryKey().notNull(),
    userId: text().notNull(),
    changedFields: text().array().notNull(),
    backendSigned: boolean().notNull(),
    txHash: text(),
    createdAt: timestamp({ mode: "string" }).defaultNow().notNull(),
  },
  (table) => [
    index("ProfileUpdateLog_userId_createdAt_idx").using(
      "btree",
      table.userId.asc().nullsLast().op("text_ops"),
      table.createdAt.asc().nullsLast().op("text_ops"),
    ),
  ],
);

export const twitterOauthToken = pgTable(
  "TwitterOAuthToken",
  {
    id: text().primaryKey().notNull(),
    userId: text().notNull(),
    oauth1Token: text().notNull(),
    oauth1TokenSecret: text().notNull(),
    screenName: text(),
    createdAt: timestamp({ mode: "string" }).defaultNow().notNull(),
    updatedAt: timestamp({ mode: "string" }).notNull(),
  },
  (table) => [
    index("TwitterOAuthToken_userId_idx").using(
      "btree",
      table.userId.asc().nullsLast().op("text_ops"),
    ),
    unique("TwitterOAuthToken_userId_unique").on(table.userId),
  ],
);

export const userActorFollow = pgTable(
  "UserActorFollow",
  {
    id: text().primaryKey().notNull(),
    userId: text().notNull(),
    actorId: text().notNull(),
    createdAt: timestamp({ mode: "string" }).defaultNow().notNull(),
  },
  (table) => [
    index("UserActorFollow_actorId_idx").using(
      "btree",
      table.actorId.asc().nullsLast().op("text_ops"),
    ),
    index("UserActorFollow_userId_idx").using(
      "btree",
      table.userId.asc().nullsLast().op("text_ops"),
    ),
    unique("UserActorFollow_userId_actorId_key").on(
      table.userId,
      table.actorId,
    ),
  ],
);

export const referral = pgTable(
  "Referral",
  {
    id: text().primaryKey().notNull(),
    referrerId: text().notNull(),
    referredUserId: text(),
    referralCode: text().notNull(),
    status: text().default("pending").notNull(),
    createdAt: timestamp({ mode: "string" }).defaultNow().notNull(),
    completedAt: timestamp({ mode: "string" }),
    qualifiedAt: timestamp({ mode: "string" }),
    suspiciousReferralFlags: json(),
    signupPointsAwarded: boolean().default(false).notNull(),
  },
  (table) => [
    index("Referral_qualifiedAt_idx").using(
      "btree",
      table.qualifiedAt.asc().nullsLast().op("timestamp_ops"),
    ),
    index("Referral_referralCode_idx").using(
      "btree",
      table.referralCode.asc().nullsLast().op("text_ops"),
    ),
    index("Referral_referredUserId_idx").using(
      "btree",
      table.referredUserId.asc().nullsLast().op("text_ops"),
    ),
    index("Referral_referrerId_idx").using(
      "btree",
      table.referrerId.asc().nullsLast().op("text_ops"),
    ),
    index("Referral_referrerId_signupPointsAwarded_completedAt_idx").using(
      "btree",
      table.referrerId.asc().nullsLast().op("text_ops"),
      table.signupPointsAwarded.asc().nullsLast().op("bool_ops"),
      table.completedAt.asc().nullsLast().op("bool_ops"),
    ),
    index(
      "Referral_referrerId_status_qualifiedAt_signupPointsAwarded_idx",
    ).using(
      "btree",
      table.referrerId.asc().nullsLast().op("bool_ops"),
      table.status.asc().nullsLast().op("timestamp_ops"),
      table.qualifiedAt.asc().nullsLast().op("text_ops"),
      table.signupPointsAwarded.asc().nullsLast().op("bool_ops"),
    ),
    index("Referral_status_createdAt_idx").using(
      "btree",
      table.status.asc().nullsLast().op("timestamp_ops"),
      table.createdAt.asc().nullsLast().op("timestamp_ops"),
    ),
    unique("Referral_referralCode_referredUserId_key").on(
      table.referredUserId,
      table.referralCode,
    ),
  ],
);

export const userBlock = pgTable(
  "UserBlock",
  {
    id: text().primaryKey().notNull(),
    blockerId: text().notNull(),
    blockedId: text().notNull(),
    reason: text(),
    createdAt: timestamp({ mode: "string" }).defaultNow().notNull(),
  },
  (table) => [
    index("UserBlock_blockedId_idx").using(
      "btree",
      table.blockedId.asc().nullsLast().op("text_ops"),
    ),
    index("UserBlock_blockerId_idx").using(
      "btree",
      table.blockerId.asc().nullsLast().op("text_ops"),
    ),
    index("UserBlock_createdAt_idx").using(
      "btree",
      table.createdAt.asc().nullsLast().op("timestamp_ops"),
    ),
    unique("UserBlock_blockerId_blockedId_key").on(
      table.blockerId,
      table.blockedId,
    ),
  ],
);

export const userInteraction = pgTable(
  "UserInteraction",
  {
    id: text().primaryKey().notNull(),
    userId: text().notNull(),
    npcId: text().notNull(),
    postId: text().notNull(),
    commentId: text().notNull(),
    timestamp: timestamp({ mode: "string" }).defaultNow().notNull(),
    qualityScore: doublePrecision().default(1).notNull(),
    wasFollowed: boolean().default(false).notNull(),
    wasInvitedToChat: boolean().default(false).notNull(),
  },
  (table) => [
    index("UserInteraction_npcId_timestamp_idx").using(
      "btree",
      table.npcId.asc().nullsLast().op("timestamp_ops"),
      table.timestamp.asc().nullsLast().op("text_ops"),
    ),
    index("UserInteraction_userId_npcId_timestamp_idx").using(
      "btree",
      table.userId.asc().nullsLast().op("timestamp_ops"),
      table.npcId.asc().nullsLast().op("text_ops"),
      table.timestamp.asc().nullsLast().op("text_ops"),
    ),
    index("UserInteraction_userId_timestamp_idx").using(
      "btree",
      table.userId.asc().nullsLast().op("text_ops"),
      table.timestamp.asc().nullsLast().op("text_ops"),
    ),
  ],
);

export const userMute = pgTable(
  "UserMute",
  {
    id: text().primaryKey().notNull(),
    muterId: text().notNull(),
    mutedId: text().notNull(),
    reason: text(),
    createdAt: timestamp({ mode: "string" }).defaultNow().notNull(),
  },
  (table) => [
    index("UserMute_createdAt_idx").using(
      "btree",
      table.createdAt.asc().nullsLast().op("timestamp_ops"),
    ),
    index("UserMute_mutedId_idx").using(
      "btree",
      table.mutedId.asc().nullsLast().op("text_ops"),
    ),
    index("UserMute_muterId_idx").using(
      "btree",
      table.muterId.asc().nullsLast().op("text_ops"),
    ),
    unique("UserMute_muterId_mutedId_key").on(table.muterId, table.mutedId),
  ],
);

export const user = pgTable(
  "User",
  {
    id: text().primaryKey().notNull(),
    walletAddress: text(),
    username: text(),
    displayName: text(),
    bio: text(),
    profileImageUrl: text(),
    isActor: boolean().default(false).notNull(),
    createdAt: timestamp({ mode: "string" }).defaultNow().notNull(),
    updatedAt: timestamp({ mode: "string" }).notNull(),
    personality: text(),
    postStyle: text(),
    postExample: text(),
    virtualBalance: numeric({ precision: 18, scale: 2 })
      .default("1000")
      .notNull(),
    totalDeposited: numeric({ precision: 18, scale: 2 })
      .default("1000")
      .notNull(),
    totalWithdrawn: numeric({ precision: 18, scale: 2 }).default("0").notNull(),
    lifetimePnL: numeric({ precision: 18, scale: 2 }).default("0").notNull(),
    profileComplete: boolean().default(false).notNull(),
    hasProfileImage: boolean().default(false).notNull(),
    hasUsername: boolean().default(false).notNull(),
    hasBio: boolean().default(false).notNull(),
    profileSetupCompletedAt: timestamp({ mode: "string" }),
    farcasterUsername: text(),
    hasFarcaster: boolean().default(false).notNull(),
    hasTwitter: boolean().default(false).notNull(),
    hasDiscord: boolean().default(false).notNull(),
    nftTokenId: integer(),
    onChainRegistered: boolean().default(false).notNull(),
    pointsAwardedForFarcaster: boolean().default(false).notNull(),
    pointsAwardedForFarcasterFollow: boolean().default(false).notNull(),
    pointsAwardedForProfile: boolean().default(false).notNull(),
    pointsAwardedForProfileImage: boolean().default(false).notNull(),
    pointsAwardedForTwitter: boolean().default(false).notNull(),
    pointsAwardedForTwitterFollow: boolean().default(false).notNull(),
    pointsAwardedForDiscord: boolean().default(false).notNull(),
    pointsAwardedForDiscordJoin: boolean().default(false).notNull(),
    pointsAwardedForUsername: boolean().default(false).notNull(),
    pointsAwardedForWallet: boolean().default(false).notNull(),
    pointsAwardedForReferralBonus: boolean().default(false).notNull(),
    pointsAwardedForShare: boolean().default(false).notNull(),
    pointsAwardedForPrivateGroup: boolean().default(false).notNull(),
    pointsAwardedForPrivateChannel: boolean().default(false).notNull(),
    referralCode: text(),
    referralCount: integer().default(0).notNull(),
    referredBy: text(),
    registrationIpHash: text(),
    lastReferralIpHash: text(),
    registrationTxHash: text(),
    reputationPoints: integer().default(1000).notNull(),
    twitterUsername: text(),
    bannerDismissCount: integer().default(0).notNull(),
    bannerLastShown: timestamp({ mode: "string" }),
    coverImageUrl: text(),
    showFarcasterPublic: boolean().default(true).notNull(),
    showTwitterPublic: boolean().default(true).notNull(),
    showWalletPublic: boolean().default(true).notNull(),
    usernameChangedAt: timestamp({ mode: "string" }),
    agent0FeedbackCount: integer(),
    agent0MetadataCid: text(),
    agent0RegisteredAt: timestamp({ mode: "string" }),
    agent0TokenId: integer(),
    agent0TrustScore: doublePrecision(),
    bannedAt: timestamp({ mode: "string" }),
    bannedBy: text(),
    bannedReason: text(),
    farcasterDisplayName: text(),
    farcasterFid: text(),
    farcasterPfpUrl: text(),
    farcasterVerifiedAt: timestamp({ mode: "string" }),
    isAdmin: boolean().default(false).notNull(),
    isBanned: boolean().default(false).notNull(),
    isScammer: boolean().default(false).notNull(),
    isCsam: boolean().default(false).notNull(),
    appealCount: integer().default(0).notNull(),
    appealStaked: boolean().default(false).notNull(),
    appealStakeAmount: numeric({ precision: 18, scale: 2 }),
    appealStakeTxHash: text(),
    appealStatus: text(),
    appealSubmittedAt: timestamp({ mode: "string" }),
    appealReviewedAt: timestamp({ mode: "string" }),
    falsePositiveHistory: json(),
    privyId: text(),
    // You can use { mode: "bigint" } if numbers are exceeding js number limitations
    registrationBlockNumber: bigint({ mode: "number" }),
    // You can use { mode: "bigint" } if numbers are exceeding js number limitations
    registrationGasUsed: bigint({ mode: "number" }),
    registrationTimestamp: timestamp({ mode: "string" }),
    role: text(),
    totalFeesEarned: numeric({ precision: 18, scale: 2 })
      .default("0")
      .notNull(),
    totalFeesPaid: numeric({ precision: 18, scale: 2 }).default("0").notNull(),
    twitterAccessToken: text(),
    twitterId: text(),
    twitterRefreshToken: text(),
    twitterTokenExpiresAt: timestamp({ mode: "string" }),
    twitterVerifiedAt: timestamp({ mode: "string" }),
    discordId: text(),
    discordUsername: text(),
    discordAccessToken: text(),
    discordRefreshToken: text(),
    discordTokenExpiresAt: timestamp({ mode: "string" }),
    discordVerifiedAt: timestamp({ mode: "string" }),
    tosAccepted: boolean().default(false).notNull(),
    tosAcceptedAt: timestamp({ mode: "string" }),
    tosAcceptedVersion: text().default("2025-11-11"),
    privacyPolicyAccepted: boolean().default(false).notNull(),
    privacyPolicyAcceptedAt: timestamp({ mode: "string" }),
    privacyPolicyAcceptedVersion: text().default("2025-11-11"),
    invitePoints: integer().default(0).notNull(),
    earnedPoints: integer().default(0).notNull(),
    bonusPoints: integer().default(0).notNull(),
    waitlistPosition: integer(),
    waitlistJoinedAt: timestamp({ mode: "string" }),
    isWaitlistActive: boolean().default(false).notNull(),
    isTest: boolean().default(false).notNull(),
    pointsAwardedForEmail: boolean().default(false).notNull(),
    emailVerified: boolean().default(false).notNull(),
    email: text(),
    waitlistGraduatedAt: timestamp({ mode: "string" }),
    agentCount: integer().default(0).notNull(),
    totalAgentPnL: numeric({ precision: 18, scale: 2 }).default("0").notNull(),
    agentErrorMessage: text(),
    agentLastChatAt: timestamp({ mode: "string" }),
    agentLastTickAt: timestamp({ mode: "string" }),
    agentMessageExamples: json(),
    agentModelTier: text().default("free").notNull(),
    agentPersonality: text(),
    agentPointsBalance: integer().default(0).notNull(),
    agentStatus: text().default("idle").notNull(),
    agentStyle: json(),
    agentSystem: text(),
    agentTotalDeposited: integer().default(0).notNull(),
    agentTotalPointsSpent: integer().default(0).notNull(),
    agentTotalWithdrawn: integer().default(0).notNull(),
    agentTradingStrategy: text(),
    autonomousCommenting: boolean().default(false).notNull(),
    autonomousDms: boolean().default(false).notNull(),
    autonomousGroupChats: boolean().default(false).notNull(),
    autonomousPosting: boolean().default(false).notNull(),
    autonomousTrading: boolean().default(false).notNull(),
    a2AEnabled: boolean().default(false).notNull(),
    isAgent: boolean().default(false).notNull(),
    managedBy: text(),
    agentGoals: json(),
    agentDirectives: json(),
    agentConstraints: json(),
    agentPersonaPrompt: text(),
    agentPlanningHorizon: text().default("single").notNull(),
    agentRiskTolerance: text().default("medium").notNull(),
    agentMaxActionsPerTick: integer().default(3).notNull(),
  },
  (table) => [
    index("User_agentCount_idx").using(
      "btree",
      table.agentCount.asc().nullsLast().op("int4_ops"),
    ),
    index("User_autonomousTrading_idx").using(
      "btree",
      table.autonomousTrading.asc().nullsLast().op("bool_ops"),
    ),
    index("User_displayName_idx").using(
      "btree",
      table.displayName.asc().nullsLast().op("text_ops"),
    ),
    index("User_earnedPoints_idx").using(
      "btree",
      table.earnedPoints.asc().nullsLast().op("int4_ops"),
    ),
    index("User_invitePoints_idx").using(
      "btree",
      table.invitePoints.asc().nullsLast().op("int4_ops"),
    ),
    index("User_isActor_idx").using(
      "btree",
      table.isActor.asc().nullsLast().op("bool_ops"),
    ),
    index("User_isAgent_idx").using(
      "btree",
      table.isAgent.asc().nullsLast().op("bool_ops"),
    ),
    index("User_isAgent_managedBy_idx").using(
      "btree",
      table.isAgent.asc().nullsLast().op("text_ops"),
      table.managedBy.asc().nullsLast().op("bool_ops"),
    ),
    index("User_isBanned_isActor_idx").using(
      "btree",
      table.isBanned.asc().nullsLast().op("bool_ops"),
      table.isActor.asc().nullsLast().op("bool_ops"),
    ),
    index("User_isCSAM_idx").using(
      "btree",
      table.isCsam.asc().nullsLast().op("bool_ops"),
    ),
    index("User_isScammer_idx").using(
      "btree",
      table.isScammer.asc().nullsLast().op("bool_ops"),
    ),
    index("User_lastReferralIpHash_idx").using(
      "btree",
      table.lastReferralIpHash.asc().nullsLast().op("text_ops"),
    ),
    index("User_managedBy_idx").using(
      "btree",
      table.managedBy.asc().nullsLast().op("text_ops"),
    ),
    index("User_profileComplete_createdAt_idx").using(
      "btree",
      table.profileComplete.asc().nullsLast().op("bool_ops"),
      table.createdAt.asc().nullsLast().op("bool_ops"),
    ),
    index("User_referralCode_idx").using(
      "btree",
      table.referralCode.asc().nullsLast().op("text_ops"),
    ),
    index("User_registrationIpHash_idx").using(
      "btree",
      table.registrationIpHash.asc().nullsLast().op("text_ops"),
    ),
    index("User_reputationPoints_idx").using(
      "btree",
      table.reputationPoints.asc().nullsLast().op("int4_ops"),
    ),
    index("User_totalAgentPnL_idx").using(
      "btree",
      table.totalAgentPnL.asc().nullsLast().op("numeric_ops"),
    ),
    index("User_username_idx").using(
      "btree",
      table.username.asc().nullsLast().op("text_ops"),
    ),
    index("User_waitlistJoinedAt_idx").using(
      "btree",
      table.waitlistJoinedAt.asc().nullsLast().op("timestamp_ops"),
    ),
    index("User_waitlistPosition_idx").using(
      "btree",
      table.waitlistPosition.asc().nullsLast().op("int4_ops"),
    ),
    index("User_walletAddress_idx").using(
      "btree",
      table.walletAddress.asc().nullsLast().op("text_ops"),
    ),
    unique("User_walletAddress_unique").on(table.walletAddress),
    unique("User_username_unique").on(table.username),
    unique("User_nftTokenId_unique").on(table.nftTokenId),
    unique("User_referralCode_unique").on(table.referralCode),
    unique("User_farcasterFid_unique").on(table.farcasterFid),
    unique("User_privyId_unique").on(table.privyId),
    unique("User_twitterId_unique").on(table.twitterId),
    unique("User_discordId_unique").on(table.discordId),
  ],
);

export const actorFollow = pgTable(
  "ActorFollow",
  {
    id: text().primaryKey().notNull(),
    followerId: text().notNull(),
    followingId: text().notNull(),
    createdAt: timestamp({ mode: "string" }).defaultNow().notNull(),
    isMutual: boolean().default(false).notNull(),
  },
  (table) => [
    index("ActorFollow_followerId_idx").using(
      "btree",
      table.followerId.asc().nullsLast().op("text_ops"),
    ),
    index("ActorFollow_followingId_idx").using(
      "btree",
      table.followingId.asc().nullsLast().op("text_ops"),
    ),
    index("ActorFollow_isMutual_idx").using(
      "btree",
      table.isMutual.asc().nullsLast().op("bool_ops"),
    ),
  ],
);

export const actorRelationship = pgTable(
  "ActorRelationship",
  {
    id: text().primaryKey().notNull(),
    actor1Id: text().notNull(),
    actor2Id: text().notNull(),
    relationshipType: text().notNull(),
    strength: doublePrecision().notNull(),
    sentiment: doublePrecision().notNull(),
    isPublic: boolean().default(true).notNull(),
    history: text(),
    affects: json(),
    createdAt: timestamp({ mode: "string" }).defaultNow().notNull(),
    updatedAt: timestamp({ mode: "string" }).notNull(),
    lastInteraction: timestamp({ mode: "string" }),
    interactionCount: integer().default(0).notNull(),
    evolutionCount: integer().default(0).notNull(),
  },
  (table) => [
    index("ActorRelationship_actor1Id_idx").using(
      "btree",
      table.actor1Id.asc().nullsLast().op("text_ops"),
    ),
    index("ActorRelationship_actor2Id_idx").using(
      "btree",
      table.actor2Id.asc().nullsLast().op("text_ops"),
    ),
    index("ActorRelationship_lastInteraction_idx").using(
      "btree",
      table.lastInteraction.asc().nullsLast().op("timestamp_ops"),
    ),
    index("ActorRelationship_relationshipType_idx").using(
      "btree",
      table.relationshipType.asc().nullsLast().op("text_ops"),
    ),
    index("ActorRelationship_sentiment_idx").using(
      "btree",
      table.sentiment.asc().nullsLast().op("float8_ops"),
    ),
    index("ActorRelationship_strength_idx").using(
      "btree",
      table.strength.asc().nullsLast().op("float8_ops"),
    ),
  ],
);

export const npcInteraction = pgTable(
  "NPCInteraction",
  {
    id: text().primaryKey().notNull(),
    actor1Id: text().notNull(),
    actor2Id: text().notNull(),
    interactionType: text().notNull(),
    sentiment: doublePrecision().default(0).notNull(),
    context: text().notNull(),
    metadata: json(),
    timestamp: timestamp({ mode: "string" }).defaultNow().notNull(),
  },
  (table) => [
    index("NPCInteraction_actor1Id_actor2Id_timestamp_idx").using(
      "btree",
      table.actor1Id.asc().nullsLast().op("timestamp_ops"),
      table.actor2Id.asc().nullsLast().op("text_ops"),
      table.timestamp.asc().nullsLast().op("timestamp_ops"),
    ),
    index("NPCInteraction_actor1Id_idx").using(
      "btree",
      table.actor1Id.asc().nullsLast().op("text_ops"),
    ),
    index("NPCInteraction_actor2Id_idx").using(
      "btree",
      table.actor2Id.asc().nullsLast().op("text_ops"),
    ),
    index("NPCInteraction_interactionType_idx").using(
      "btree",
      table.interactionType.asc().nullsLast().op("text_ops"),
    ),
    index("NPCInteraction_timestamp_idx").using(
      "btree",
      table.timestamp.asc().nullsLast().op("timestamp_ops"),
    ),
  ],
);

export const actor = pgTable(
  "Actor",
  {
    id: text().primaryKey().notNull(),
    name: text().notNull(),
    description: text(),
    domain: text().array().default([""]).notNull(),
    personality: text(),
    tier: text(),
    affiliations: text().array().default([""]).notNull(),
    postStyle: text(),
    postExample: text().array().default([""]).notNull(),
    role: text(),
    initialLuck: text().default("medium").notNull(),
    initialMood: doublePrecision().default(0).notNull(),
    createdAt: timestamp({ mode: "string" }).defaultNow().notNull(),
    updatedAt: timestamp({ mode: "string" }).notNull(),
    hasPool: boolean().default(false).notNull(),
    profileImageUrl: text(),
    reputationPoints: integer().default(10000).notNull(),
    tradingBalance: numeric({ precision: 18, scale: 2 })
      .default("10000")
      .notNull(),
    isTest: boolean().default(false).notNull(),
  },
  (table) => [
    index("Actor_hasPool_idx").using(
      "btree",
      table.hasPool.asc().nullsLast().op("bool_ops"),
    ),
    index("Actor_reputationPoints_idx").using(
      "btree",
      table.reputationPoints.asc().nullsLast().op("int4_ops"),
    ),
    index("Actor_role_idx").using(
      "btree",
      table.role.asc().nullsLast().op("text_ops"),
    ),
    index("Actor_tier_idx").using(
      "btree",
      table.tier.asc().nullsLast().op("text_ops"),
    ),
  ],
);

export const npcTrade = pgTable(
  "NPCTrade",
  {
    id: text().primaryKey().notNull(),
    npcActorId: text().notNull(),
    poolId: text(),
    marketType: text().notNull(),
    ticker: text(),
    marketId: text(),
    action: text().notNull(),
    side: text(),
    amount: doublePrecision().notNull(),
    price: doublePrecision().notNull(),
    sentiment: doublePrecision(),
    reason: text(),
    postId: text(),
    executedAt: timestamp({ mode: "string" }).defaultNow().notNull(),
  },
  (table) => [
    index("NPCTrade_executedAt_idx").using(
      "btree",
      table.executedAt.asc().nullsLast().op("timestamp_ops"),
    ),
    index("NPCTrade_marketType_ticker_idx").using(
      "btree",
      table.marketType.asc().nullsLast().op("text_ops"),
      table.ticker.asc().nullsLast().op("text_ops"),
    ),
    index("NPCTrade_npcActorId_executedAt_idx").using(
      "btree",
      table.npcActorId.asc().nullsLast().op("text_ops"),
      table.executedAt.asc().nullsLast().op("timestamp_ops"),
    ),
    index("NPCTrade_poolId_executedAt_idx").using(
      "btree",
      table.poolId.asc().nullsLast().op("text_ops"),
      table.executedAt.asc().nullsLast().op("text_ops"),
    ),
  ],
);

export const agentCapability = pgTable(
  "AgentCapability",
  {
    id: text().primaryKey().notNull(),
    agentRegistryId: text().notNull(),
    strategies: text().array().default([""]).notNull(),
    markets: text().array().default([""]).notNull(),
    actions: text().array().default([""]).notNull(),
    version: text().default("1.0.0").notNull(),
    x402Support: boolean().default(false).notNull(),
    platform: text(),
    userType: text(),
    gameNetworkChainId: integer(),
    gameNetworkRpcUrl: text(),
    gameNetworkExplorerUrl: text(),
    skills: text().array().default([""]).notNull(),
    domains: text().array().default([""]).notNull(),
    a2AEndpoint: text(),
    mcpEndpoint: text(),
    createdAt: timestamp({ mode: "string" }).defaultNow().notNull(),
    updatedAt: timestamp({ mode: "string" }).notNull(),
  },
  (table) => [
    index("AgentCapability_agentRegistryId_idx").using(
      "btree",
      table.agentRegistryId.asc().nullsLast().op("text_ops"),
    ),
    unique("AgentCapability_agentRegistryId_unique").on(table.agentRegistryId),
  ],
);

export const agentGoalAction = pgTable(
  "AgentGoalAction",
  {
    id: text().primaryKey().notNull(),
    goalId: text().notNull(),
    agentUserId: text().notNull(),
    actionType: text().notNull(),
    actionId: text(),
    impact: doublePrecision().notNull(),
    metadata: json(),
    createdAt: timestamp({ mode: "string" }).defaultNow().notNull(),
  },
  (table) => [
    index("AgentGoalAction_actionType_idx").using(
      "btree",
      table.actionType.asc().nullsLast().op("text_ops"),
    ),
    index("AgentGoalAction_agentUserId_createdAt_idx").using(
      "btree",
      table.agentUserId.asc().nullsLast().op("text_ops"),
      table.createdAt.asc().nullsLast().op("text_ops"),
    ),
    index("AgentGoalAction_goalId_idx").using(
      "btree",
      table.goalId.asc().nullsLast().op("text_ops"),
    ),
  ],
);

export const agentGoal = pgTable(
  "AgentGoal",
  {
    id: text().primaryKey().notNull(),
    agentUserId: text().notNull(),
    type: text().notNull(),
    name: text().notNull(),
    description: text().notNull(),
    target: json(),
    priority: integer().notNull(),
    status: text().default("active").notNull(),
    progress: doublePrecision().default(0).notNull(),
    createdAt: timestamp({ mode: "string" }).defaultNow().notNull(),
    updatedAt: timestamp({ mode: "string" }).notNull(),
    completedAt: timestamp({ mode: "string" }),
  },
  (table) => [
    index("AgentGoal_agentUserId_status_idx").using(
      "btree",
      table.agentUserId.asc().nullsLast().op("text_ops"),
      table.status.asc().nullsLast().op("text_ops"),
    ),
    index("AgentGoal_createdAt_idx").using(
      "btree",
      table.createdAt.asc().nullsLast().op("timestamp_ops"),
    ),
    index("AgentGoal_priority_idx").using(
      "btree",
      table.priority.asc().nullsLast().op("int4_ops"),
    ),
    index("AgentGoal_status_idx").using(
      "btree",
      table.status.asc().nullsLast().op("text_ops"),
    ),
  ],
);

export const agentLog = pgTable(
  "AgentLog",
  {
    id: text().primaryKey().notNull(),
    type: text().notNull(),
    level: text().notNull(),
    message: text().notNull(),
    prompt: text(),
    completion: text(),
    thinking: text(),
    metadata: json(),
    createdAt: timestamp({ mode: "string" }).defaultNow().notNull(),
    agentUserId: text().notNull(),
  },
  (table) => [
    index("AgentLog_agentUserId_createdAt_idx").using(
      "btree",
      table.agentUserId.asc().nullsLast().op("text_ops"),
      table.createdAt.asc().nullsLast().op("text_ops"),
    ),
    index("AgentLog_level_idx").using(
      "btree",
      table.level.asc().nullsLast().op("text_ops"),
    ),
    index("AgentLog_type_createdAt_idx").using(
      "btree",
      table.type.asc().nullsLast().op("timestamp_ops"),
      table.createdAt.asc().nullsLast().op("text_ops"),
    ),
  ],
);

export const agentMessage = pgTable(
  "AgentMessage",
  {
    id: text().primaryKey().notNull(),
    role: text().notNull(),
    content: text().notNull(),
    modelUsed: text(),
    pointsCost: integer().default(0).notNull(),
    metadata: json(),
    createdAt: timestamp({ mode: "string" }).defaultNow().notNull(),
    agentUserId: text().notNull(),
  },
  (table) => [
    index("AgentMessage_agentUserId_createdAt_idx").using(
      "btree",
      table.agentUserId.asc().nullsLast().op("text_ops"),
      table.createdAt.asc().nullsLast().op("text_ops"),
    ),
    index("AgentMessage_role_idx").using(
      "btree",
      table.role.asc().nullsLast().op("text_ops"),
    ),
  ],
);

export const agentPerformanceMetrics = pgTable(
  "AgentPerformanceMetrics",
  {
    id: text().primaryKey().notNull(),
    userId: text().notNull(),
    gamesPlayed: integer().default(0).notNull(),
    gamesWon: integer().default(0).notNull(),
    averageGameScore: doublePrecision().default(0).notNull(),
    lastGameScore: doublePrecision(),
    lastGamePlayedAt: timestamp({ mode: "string" }),
    normalizedPnL: doublePrecision().default(0.5).notNull(),
    totalTrades: integer().default(0).notNull(),
    profitableTrades: integer().default(0).notNull(),
    winRate: doublePrecision().default(0).notNull(),
    averageRoi: doublePrecision().default(0).notNull(),
    sharpeRatio: doublePrecision(),
    totalFeedbackCount: integer().default(0).notNull(),
    averageFeedbackScore: doublePrecision().default(70).notNull(),
    intelFeedbackCount: integer().default(0).notNull(),
    averageIntelScore: doublePrecision().default(50).notNull(),
    averageRating: doublePrecision(),
    positiveCount: integer().default(0).notNull(),
    neutralCount: integer().default(0).notNull(),
    negativeCount: integer().default(0).notNull(),
    reputationScore: doublePrecision().default(70).notNull(),
    trustLevel: text().default("UNRATED").notNull(),
    confidenceScore: doublePrecision().default(0).notNull(),
    onChainReputationSync: boolean().default(false).notNull(),
    lastSyncedAt: timestamp({ mode: "string" }),
    onChainTrustScore: doublePrecision(),
    onChainAccuracyScore: doublePrecision(),
    firstActivityAt: timestamp({ mode: "string" }),
    lastActivityAt: timestamp({ mode: "string" }),
    totalInteractions: integer().default(0).notNull(),
    createdAt: timestamp({ mode: "string" }).defaultNow().notNull(),
    updatedAt: timestamp({ mode: "string" }).notNull(),
  },
  (table) => [
    index("AgentPerformanceMetrics_gamesPlayed_idx").using(
      "btree",
      table.gamesPlayed.asc().nullsLast().op("int4_ops"),
    ),
    index("AgentPerformanceMetrics_normalizedPnL_idx").using(
      "btree",
      table.normalizedPnL.asc().nullsLast().op("float8_ops"),
    ),
    index("AgentPerformanceMetrics_reputationScore_idx").using(
      "btree",
      table.reputationScore.asc().nullsLast().op("float8_ops"),
    ),
    index("AgentPerformanceMetrics_trustLevel_idx").using(
      "btree",
      table.trustLevel.asc().nullsLast().op("text_ops"),
    ),
    index("AgentPerformanceMetrics_updatedAt_idx").using(
      "btree",
      table.updatedAt.asc().nullsLast().op("timestamp_ops"),
    ),
    unique("AgentPerformanceMetrics_userId_unique").on(table.userId),
  ],
);

export const agentPointsTransaction = pgTable(
  "AgentPointsTransaction",
  {
    id: text().primaryKey().notNull(),
    type: text().notNull(),
    amount: integer().notNull(),
    balanceBefore: integer().notNull(),
    balanceAfter: integer().notNull(),
    description: text().notNull(),
    relatedId: text(),
    createdAt: timestamp({ mode: "string" }).defaultNow().notNull(),
    agentUserId: text().notNull(),
    managerUserId: text().notNull(),
  },
  (table) => [
    index("AgentPointsTransaction_agentUserId_createdAt_idx").using(
      "btree",
      table.agentUserId.asc().nullsLast().op("timestamp_ops"),
      table.createdAt.asc().nullsLast().op("text_ops"),
    ),
    index("AgentPointsTransaction_managerUserId_createdAt_idx").using(
      "btree",
      table.managerUserId.asc().nullsLast().op("timestamp_ops"),
      table.createdAt.asc().nullsLast().op("text_ops"),
    ),
    index("AgentPointsTransaction_type_idx").using(
      "btree",
      table.type.asc().nullsLast().op("text_ops"),
    ),
  ],
);

export const agentRegistry = pgTable(
  "AgentRegistry",
  {
    id: text().primaryKey().notNull(),
    agentId: text().notNull(),
    type: agentType().notNull(),
    status: agentStatus().default("REGISTERED").notNull(),
    trustLevel: integer().default(0).notNull(),
    userId: text(),
    actorId: text(),
    name: text().notNull(),
    systemPrompt: text().notNull(),
    discoveryCardVersion: text(),
    discoveryEndpointA2A: text(),
    discoveryEndpointMcp: text(),
    discoveryEndpointRpc: text(),
    discoveryAuthRequired: boolean().default(false).notNull(),
    discoveryAuthMethods: text().array().default([""]).notNull(),
    discoveryRateLimit: integer(),
    discoveryCostPerAction: doublePrecision(),
    onChainTokenId: integer(),
    onChainTxHash: text(),
    onChainServerWallet: text(),
    onChainReputationScore: integer().default(0),
    onChainChainId: integer(),
    onChainIdentityRegistry: text(),
    onChainReputationSystem: text(),
    agent0TokenId: text(),
    agent0MetadataCid: text(),
    agent0SubgraphOwner: text(),
    agent0SubgraphMetadataUri: text(),
    agent0SubgraphTimestamp: integer(),
    agent0DiscoveryEndpoint: text(),
    runtimeInstanceId: text(),
    registeredAt: timestamp({ mode: "string" }).defaultNow().notNull(),
    lastActiveAt: timestamp({ mode: "string" }),
    terminatedAt: timestamp({ mode: "string" }),
    updatedAt: timestamp({ mode: "string" }).notNull(),
  },
  (table) => [
    index("AgentRegistry_actorId_idx").using(
      "btree",
      table.actorId.asc().nullsLast().op("text_ops"),
    ),
    index("AgentRegistry_status_lastActiveAt_idx").using(
      "btree",
      table.status.asc().nullsLast().op("timestamp_ops"),
      table.lastActiveAt.asc().nullsLast().op("timestamp_ops"),
    ),
    index("AgentRegistry_trustLevel_idx").using(
      "btree",
      table.trustLevel.asc().nullsLast().op("int4_ops"),
    ),
    index("AgentRegistry_type_status_idx").using(
      "btree",
      table.type.asc().nullsLast().op("enum_ops"),
      table.status.asc().nullsLast().op("enum_ops"),
    ),
    index("AgentRegistry_type_trustLevel_idx").using(
      "btree",
      table.type.asc().nullsLast().op("enum_ops"),
      table.trustLevel.asc().nullsLast().op("int4_ops"),
    ),
    index("AgentRegistry_userId_idx").using(
      "btree",
      table.userId.asc().nullsLast().op("text_ops"),
    ),
    unique("AgentRegistry_agentId_unique").on(table.agentId),
    unique("AgentRegistry_userId_unique").on(table.userId),
    unique("AgentRegistry_actorId_unique").on(table.actorId),
    unique("AgentRegistry_runtimeInstanceId_unique").on(
      table.runtimeInstanceId,
    ),
  ],
);

export const agentTrade = pgTable(
  "AgentTrade",
  {
    id: text().primaryKey().notNull(),
    marketType: text().notNull(),
    marketId: text(),
    ticker: text(),
    action: text().notNull(),
    side: text(),
    amount: doublePrecision().notNull(),
    price: doublePrecision().notNull(),
    pnl: doublePrecision(),
    reasoning: text(),
    executedAt: timestamp({ mode: "string" }).defaultNow().notNull(),
    agentUserId: text().notNull(),
  },
  (table) => [
    index("AgentTrade_agentUserId_executedAt_idx").using(
      "btree",
      table.agentUserId.asc().nullsLast().op("text_ops"),
      table.executedAt.asc().nullsLast().op("text_ops"),
    ),
    index("AgentTrade_marketType_marketId_idx").using(
      "btree",
      table.marketType.asc().nullsLast().op("text_ops"),
      table.marketId.asc().nullsLast().op("text_ops"),
    ),
    index("AgentTrade_ticker_idx").using(
      "btree",
      table.ticker.asc().nullsLast().op("text_ops"),
    ),
  ],
);

export const externalAgentConnection = pgTable(
  "ExternalAgentConnection",
  {
    id: text().primaryKey().notNull(),
    agentRegistryId: text().notNull(),
    externalId: text().notNull(),
    endpoint: text().notNull(),
    protocol: text().notNull(),
    authType: text(),
    authCredentials: text(),
    agentCardJson: json(),
    isHealthy: boolean().default(true).notNull(),
    lastHealthCheck: timestamp({ mode: "string" }),
    lastConnected: timestamp({ mode: "string" }),
    createdAt: timestamp({ mode: "string" }).defaultNow().notNull(),
    updatedAt: timestamp({ mode: "string" }).notNull(),
  },
  (table) => [
    index("ExternalAgentConnection_agentRegistryId_idx").using(
      "btree",
      table.agentRegistryId.asc().nullsLast().op("text_ops"),
    ),
    index("ExternalAgentConnection_externalId_idx").using(
      "btree",
      table.externalId.asc().nullsLast().op("text_ops"),
    ),
    index("ExternalAgentConnection_isHealthy_idx").using(
      "btree",
      table.isHealthy.asc().nullsLast().op("bool_ops"),
    ),
    index("ExternalAgentConnection_protocol_idx").using(
      "btree",
      table.protocol.asc().nullsLast().op("text_ops"),
    ),
    unique("ExternalAgentConnection_agentRegistryId_unique").on(
      table.agentRegistryId,
    ),
    unique("ExternalAgentConnection_externalId_unique").on(table.externalId),
  ],
);

export const market = pgTable(
  "Market",
  {
    id: text().primaryKey().notNull(),
    question: text().notNull(),
    description: text(),
    gameId: text(),
    dayNumber: integer(),
    yesShares: numeric({ precision: 18, scale: 6 }).default("0").notNull(),
    noShares: numeric({ precision: 18, scale: 6 }).default("0").notNull(),
    liquidity: numeric({ precision: 18, scale: 6 }).notNull(),
    resolved: boolean().default(false).notNull(),
    resolution: boolean(),
    endDate: timestamp({ mode: "string" }).notNull(),
    createdAt: timestamp({ mode: "string" }).defaultNow().notNull(),
    updatedAt: timestamp({ mode: "string" }).notNull(),
    onChainMarketId: text(),
    onChainResolutionTxHash: text(),
    onChainResolved: boolean().default(false).notNull(),
    oracleAddress: text(),
  },
  (table) => [
    index("Market_createdAt_idx").using(
      "btree",
      table.createdAt.asc().nullsLast().op("timestamp_ops"),
    ),
    index("Market_gameId_dayNumber_idx").using(
      "btree",
      table.gameId.asc().nullsLast().op("int4_ops"),
      table.dayNumber.asc().nullsLast().op("int4_ops"),
    ),
    index("Market_onChainMarketId_idx").using(
      "btree",
      table.onChainMarketId.asc().nullsLast().op("text_ops"),
    ),
    index("Market_resolved_endDate_idx").using(
      "btree",
      table.resolved.asc().nullsLast().op("timestamp_ops"),
      table.endDate.asc().nullsLast().op("timestamp_ops"),
    ),
  ],
);

export const organization = pgTable(
  "Organization",
  {
    id: text().primaryKey().notNull(),
    name: text().notNull(),
    ticker: text(),
    description: text().notNull(),
    type: text().notNull(),
    canBeInvolved: boolean().default(true).notNull(),
    initialPrice: doublePrecision(),
    currentPrice: doublePrecision(),
    createdAt: timestamp({ mode: "string" }).defaultNow().notNull(),
    updatedAt: timestamp({ mode: "string" }).notNull(),
    imageUrl: text(),
  },
  (table) => [
    index("Organization_currentPrice_idx").using(
      "btree",
      table.currentPrice.asc().nullsLast().op("float8_ops"),
    ),
    index("Organization_ticker_idx").using(
      "btree",
      table.ticker.asc().nullsLast().op("text_ops"),
    ),
    index("Organization_type_idx").using(
      "btree",
      table.type.asc().nullsLast().op("text_ops"),
    ),
  ],
);

export const perpPosition = pgTable(
  "PerpPosition",
  {
    id: text().primaryKey().notNull(),
    userId: text().notNull(),
    ticker: text().notNull(),
    organizationId: text().notNull(),
    side: text().notNull(),
    entryPrice: doublePrecision().notNull(),
    currentPrice: doublePrecision().notNull(),
    size: doublePrecision().notNull(),
    leverage: integer().notNull(),
    liquidationPrice: doublePrecision().notNull(),
    unrealizedPnL: doublePrecision().notNull(),
    unrealizedPnLpercent: doublePrecision().notNull(),
    fundingPaid: doublePrecision().default(0).notNull(),
    openedAt: timestamp({ mode: "string" }).defaultNow().notNull(),
    lastUpdated: timestamp({ mode: "string" }).notNull(),
    closedAt: timestamp({ mode: "string" }),
    realizedPnL: doublePrecision(),
    settledAt: timestamp({ mode: "string" }),
    settledToChain: boolean().default(false).notNull(),
    settlementTxHash: text(),
  },
  (table) => [
    index("PerpPosition_organizationId_idx").using(
      "btree",
      table.organizationId.asc().nullsLast().op("text_ops"),
    ),
    index("PerpPosition_settledToChain_idx").using(
      "btree",
      table.settledToChain.asc().nullsLast().op("bool_ops"),
    ),
    index("PerpPosition_ticker_idx").using(
      "btree",
      table.ticker.asc().nullsLast().op("text_ops"),
    ),
    index("PerpPosition_userId_closedAt_idx").using(
      "btree",
      table.userId.asc().nullsLast().op("text_ops"),
      table.closedAt.asc().nullsLast().op("text_ops"),
    ),
  ],
);

export const position = pgTable(
  "Position",
  {
    id: text().primaryKey().notNull(),
    userId: text().notNull(),
    marketId: text().notNull(),
    side: boolean().notNull(),
    shares: numeric({ precision: 18, scale: 6 }).notNull(),
    avgPrice: numeric({ precision: 18, scale: 6 }).notNull(),
    createdAt: timestamp({ mode: "string" }).defaultNow().notNull(),
    updatedAt: timestamp({ mode: "string" }).notNull(),
    amount: numeric({ precision: 18, scale: 2 }).default("0").notNull(),
    outcome: boolean(),
    pnl: numeric({ precision: 18, scale: 2 }),
    questionId: integer(),
    resolvedAt: timestamp({ mode: "string" }),
    status: text().default("active").notNull(),
  },
  (table) => [
    index("Position_marketId_idx").using(
      "btree",
      table.marketId.asc().nullsLast().op("text_ops"),
    ),
    index("Position_questionId_idx").using(
      "btree",
      table.questionId.asc().nullsLast().op("int4_ops"),
    ),
    index("Position_status_idx").using(
      "btree",
      table.status.asc().nullsLast().op("text_ops"),
    ),
    index("Position_userId_idx").using(
      "btree",
      table.userId.asc().nullsLast().op("text_ops"),
    ),
    index("Position_userId_marketId_idx").using(
      "btree",
      table.userId.asc().nullsLast().op("text_ops"),
      table.marketId.asc().nullsLast().op("text_ops"),
    ),
    index("Position_userId_status_idx").using(
      "btree",
      table.userId.asc().nullsLast().op("text_ops"),
      table.status.asc().nullsLast().op("text_ops"),
    ),
  ],
);

export const predictionPriceHistory = pgTable(
  "PredictionPriceHistory",
  {
    id: text().primaryKey().notNull(),
    marketId: text().notNull(),
    yesPrice: doublePrecision().notNull(),
    noPrice: doublePrecision().notNull(),
    yesShares: numeric({ precision: 24, scale: 8 }).notNull(),
    noShares: numeric({ precision: 24, scale: 8 }).notNull(),
    liquidity: numeric({ precision: 24, scale: 8 }).notNull(),
    eventType: text().notNull(),
    source: text().notNull(),
    createdAt: timestamp({ mode: "string" }).defaultNow().notNull(),
  },
  (table) => [
    index("PredictionPriceHistory_marketId_createdAt_idx").using(
      "btree",
      table.marketId.asc().nullsLast().op("text_ops"),
      table.createdAt.asc().nullsLast().op("text_ops"),
    ),
  ],
);

export const question = pgTable(
  "Question",
  {
    id: text().primaryKey().notNull(),
    questionNumber: integer().notNull(),
    text: text().notNull(),
    scenarioId: integer().notNull(),
    outcome: boolean().notNull(),
    rank: integer().notNull(),
    createdDate: timestamp({ mode: "string" }).defaultNow().notNull(),
    resolutionDate: timestamp({ mode: "string" }).notNull(),
    status: text().default("active").notNull(),
    resolvedOutcome: boolean(),
    createdAt: timestamp({ mode: "string" }).defaultNow().notNull(),
    updatedAt: timestamp({ mode: "string" }).notNull(),
    oracleCommitBlock: integer(),
    oracleCommitTxHash: text(),
    oracleCommitment: text(),
    oracleError: text(),
    oraclePublishedAt: timestamp({ mode: "string" }),
    oracleRevealBlock: integer(),
    oracleRevealTxHash: text(),
    oracleSaltEncrypted: text(),
    oracleSessionId: text(),
    resolutionProofUrl: text(),
    resolutionDescription: text(),
  },
  (table) => [
    index("Question_createdDate_idx").using(
      "btree",
      table.createdDate.asc().nullsLast().op("timestamp_ops"),
    ),
    index("Question_oraclePublishedAt_idx").using(
      "btree",
      table.oraclePublishedAt.asc().nullsLast().op("timestamp_ops"),
    ),
    index("Question_oracleSessionId_idx").using(
      "btree",
      table.oracleSessionId.asc().nullsLast().op("text_ops"),
    ),
    index("Question_status_resolutionDate_idx").using(
      "btree",
      table.status.asc().nullsLast().op("timestamp_ops"),
      table.resolutionDate.asc().nullsLast().op("text_ops"),
    ),
    unique("Question_questionNumber_unique").on(table.questionNumber),
    unique("Question_oracleSessionId_unique").on(table.oracleSessionId),
  ],
);

export const stockPrice = pgTable(
  "StockPrice",
  {
    id: text().primaryKey().notNull(),
    organizationId: text().notNull(),
    price: doublePrecision().notNull(),
    change: doublePrecision().notNull(),
    changePercent: doublePrecision().notNull(),
    timestamp: timestamp({ mode: "string" }).defaultNow().notNull(),
    isSnapshot: boolean().default(false).notNull(),
    openPrice: doublePrecision(),
    highPrice: doublePrecision(),
    lowPrice: doublePrecision(),
    volume: doublePrecision(),
  },
  (table) => [
    index("StockPrice_isSnapshot_timestamp_idx").using(
      "btree",
      table.isSnapshot.asc().nullsLast().op("bool_ops"),
      table.timestamp.asc().nullsLast().op("timestamp_ops"),
    ),
    index("StockPrice_organizationId_timestamp_idx").using(
      "btree",
      table.organizationId.asc().nullsLast().op("timestamp_ops"),
      table.timestamp.asc().nullsLast().op("text_ops"),
    ),
    index("StockPrice_timestamp_idx").using(
      "btree",
      table.timestamp.asc().nullsLast().op("timestamp_ops"),
    ),
  ],
);

export const chatAdmin = pgTable(
  "ChatAdmin",
  {
    id: text().primaryKey().notNull(),
    chatId: text().notNull(),
    userId: text().notNull(),
    grantedAt: timestamp({ mode: "string" }).defaultNow().notNull(),
    grantedBy: text().notNull(),
  },
  (table) => [
    index("ChatAdmin_chatId_idx").using(
      "btree",
      table.chatId.asc().nullsLast().op("text_ops"),
    ),
    index("ChatAdmin_userId_idx").using(
      "btree",
      table.userId.asc().nullsLast().op("text_ops"),
    ),
    unique("ChatAdmin_chatId_userId_key").on(table.chatId, table.userId),
  ],
);

export const chatInvite = pgTable(
  "ChatInvite",
  {
    id: text().primaryKey().notNull(),
    chatId: text().notNull(),
    invitedUserId: text().notNull(),
    invitedBy: text().notNull(),
    status: text().default("pending").notNull(),
    message: text(),
    invitedAt: timestamp({ mode: "string" }).defaultNow().notNull(),
    respondedAt: timestamp({ mode: "string" }),
  },
  (table) => [
    index("ChatInvite_chatId_idx").using(
      "btree",
      table.chatId.asc().nullsLast().op("text_ops"),
    ),
    index("ChatInvite_invitedUserId_status_idx").using(
      "btree",
      table.invitedUserId.asc().nullsLast().op("text_ops"),
      table.status.asc().nullsLast().op("text_ops"),
    ),
    index("ChatInvite_status_idx").using(
      "btree",
      table.status.asc().nullsLast().op("text_ops"),
    ),
    unique("ChatInvite_chatId_invitedUserId_key").on(
      table.chatId,
      table.invitedUserId,
    ),
  ],
);

export const chatParticipant = pgTable(
  "ChatParticipant",
  {
    id: text().primaryKey().notNull(),
    chatId: text().notNull(),
    userId: text().notNull(),
    joinedAt: timestamp({ mode: "string" }).defaultNow().notNull(),
    invitedBy: text(),
    isActive: boolean().default(true).notNull(),
    lastMessageAt: timestamp({ mode: "string" }),
    messageCount: integer().default(0).notNull(),
    qualityScore: doublePrecision().default(1).notNull(),
    kickedAt: timestamp({ mode: "string" }),
    kickReason: text(),
    addedBy: text(),
  },
  (table) => [
    index("ChatParticipant_chatId_idx").using(
      "btree",
      table.chatId.asc().nullsLast().op("text_ops"),
    ),
    index("ChatParticipant_chatId_isActive_idx").using(
      "btree",
      table.chatId.asc().nullsLast().op("text_ops"),
      table.isActive.asc().nullsLast().op("text_ops"),
    ),
    index("ChatParticipant_lastMessageAt_idx").using(
      "btree",
      table.lastMessageAt.asc().nullsLast().op("timestamp_ops"),
    ),
    index("ChatParticipant_userId_idx").using(
      "btree",
      table.userId.asc().nullsLast().op("text_ops"),
    ),
    index("ChatParticipant_userId_isActive_idx").using(
      "btree",
      table.userId.asc().nullsLast().op("bool_ops"),
      table.isActive.asc().nullsLast().op("bool_ops"),
    ),
    unique("ChatParticipant_chatId_userId_key").on(table.chatId, table.userId),
  ],
);

export const chat = pgTable(
  "Chat",
  {
    id: text().primaryKey().notNull(),
    name: text(),
    description: text(),
    isGroup: boolean().default(false).notNull(),
    createdBy: text(),
    npcAdminId: text(),
    gameId: text(),
    dayNumber: integer(),
    relatedQuestion: integer(),
    createdAt: timestamp({ mode: "string" }).defaultNow().notNull(),
    updatedAt: timestamp({ mode: "string" }).notNull(),
    groupId: text(),
  },
  (table) => [
    index("Chat_createdBy_idx").using(
      "btree",
      table.createdBy.asc().nullsLast().op("text_ops"),
    ),
    index("Chat_gameId_dayNumber_idx").using(
      "btree",
      table.gameId.asc().nullsLast().op("text_ops"),
      table.dayNumber.asc().nullsLast().op("int4_ops"),
    ),
    index("Chat_groupId_idx").using(
      "btree",
      table.groupId.asc().nullsLast().op("text_ops"),
    ),
    index("Chat_isGroup_idx").using(
      "btree",
      table.isGroup.asc().nullsLast().op("bool_ops"),
    ),
    index("Chat_npcAdminId_idx").using(
      "btree",
      table.npcAdminId.asc().nullsLast().op("text_ops"),
    ),
    index("Chat_relatedQuestion_idx").using(
      "btree",
      table.relatedQuestion.asc().nullsLast().op("int4_ops"),
    ),
  ],
);

export const dmAcceptance = pgTable(
  "DMAcceptance",
  {
    id: text().primaryKey().notNull(),
    chatId: text().notNull(),
    userId: text().notNull(),
    otherUserId: text().notNull(),
    status: text().default("pending").notNull(),
    createdAt: timestamp({ mode: "string" }).defaultNow().notNull(),
    acceptedAt: timestamp({ mode: "string" }),
    rejectedAt: timestamp({ mode: "string" }),
  },
  (table) => [
    index("DMAcceptance_status_createdAt_idx").using(
      "btree",
      table.status.asc().nullsLast().op("text_ops"),
      table.createdAt.asc().nullsLast().op("timestamp_ops"),
    ),
    index("DMAcceptance_userId_status_idx").using(
      "btree",
      table.userId.asc().nullsLast().op("text_ops"),
      table.status.asc().nullsLast().op("text_ops"),
    ),
    unique("DMAcceptance_chatId_unique").on(table.chatId),
  ],
);

export const groupChatMembership = pgTable(
  "GroupChatMembership",
  {
    id: text().primaryKey().notNull(),
    userId: text().notNull(),
    chatId: text().notNull(),
    npcAdminId: text().notNull(),
    joinedAt: timestamp({ mode: "string" }).defaultNow().notNull(),
    lastMessageAt: timestamp({ mode: "string" }),
    messageCount: integer().default(0).notNull(),
    qualityScore: doublePrecision().default(1).notNull(),
    isActive: boolean().default(true).notNull(),
    sweepReason: text(),
    removedAt: timestamp({ mode: "string" }),
  },
  (table) => [
    index("GroupChatMembership_chatId_isActive_idx").using(
      "btree",
      table.chatId.asc().nullsLast().op("bool_ops"),
      table.isActive.asc().nullsLast().op("bool_ops"),
    ),
    index("GroupChatMembership_lastMessageAt_idx").using(
      "btree",
      table.lastMessageAt.asc().nullsLast().op("timestamp_ops"),
    ),
    index("GroupChatMembership_userId_isActive_idx").using(
      "btree",
      table.userId.asc().nullsLast().op("bool_ops"),
      table.isActive.asc().nullsLast().op("bool_ops"),
    ),
    unique("GroupChatMembership_userId_chatId_key").on(
      table.userId,
      table.chatId,
    ),
  ],
);

export const message = pgTable(
  "Message",
  {
    id: text().primaryKey().notNull(),
    chatId: text().notNull(),
    senderId: text().notNull(),
    content: text().notNull(),
    createdAt: timestamp({ mode: "string" }).defaultNow().notNull(),
  },
  (table) => [
    index("Message_chatId_createdAt_idx").using(
      "btree",
      table.chatId.asc().nullsLast().op("text_ops"),
      table.createdAt.asc().nullsLast().op("text_ops"),
    ),
    index("Message_senderId_idx").using(
      "btree",
      table.senderId.asc().nullsLast().op("text_ops"),
    ),
  ],
);

export const notification = pgTable(
  "Notification",
  {
    id: text().primaryKey().notNull(),
    userId: text().notNull(),
    type: text().notNull(),
    actorId: text(),
    postId: text(),
    commentId: text(),
    message: text().notNull(),
    read: boolean().default(false).notNull(),
    createdAt: timestamp({ mode: "string" }).defaultNow().notNull(),
    title: text().notNull(),
    groupId: text(),
    inviteId: text(),
  },
  (table) => [
    index("Notification_groupId_idx").using(
      "btree",
      table.groupId.asc().nullsLast().op("text_ops"),
    ),
    index("Notification_inviteId_idx").using(
      "btree",
      table.inviteId.asc().nullsLast().op("text_ops"),
    ),
    index("Notification_read_idx").using(
      "btree",
      table.read.asc().nullsLast().op("bool_ops"),
    ),
    index("Notification_userId_createdAt_idx").using(
      "btree",
      table.userId.asc().nullsLast().op("timestamp_ops"),
      table.createdAt.asc().nullsLast().op("timestamp_ops"),
    ),
    index("Notification_userId_read_createdAt_idx").using(
      "btree",
      table.userId.asc().nullsLast().op("timestamp_ops"),
      table.read.asc().nullsLast().op("timestamp_ops"),
      table.createdAt.asc().nullsLast().op("timestamp_ops"),
    ),
    index("Notification_userId_type_read_idx").using(
      "btree",
      table.userId.asc().nullsLast().op("bool_ops"),
      table.type.asc().nullsLast().op("text_ops"),
      table.read.asc().nullsLast().op("text_ops"),
    ),
  ],
);

export const userGroupAdmin = pgTable(
  "UserGroupAdmin",
  {
    id: text().primaryKey().notNull(),
    groupId: text().notNull(),
    userId: text().notNull(),
    grantedAt: timestamp({ mode: "string" }).defaultNow().notNull(),
    grantedBy: text().notNull(),
  },
  (table) => [
    index("UserGroupAdmin_groupId_idx").using(
      "btree",
      table.groupId.asc().nullsLast().op("text_ops"),
    ),
    index("UserGroupAdmin_userId_idx").using(
      "btree",
      table.userId.asc().nullsLast().op("text_ops"),
    ),
    unique("UserGroupAdmin_groupId_userId_key").on(table.groupId, table.userId),
  ],
);

export const userGroupInvite = pgTable(
  "UserGroupInvite",
  {
    id: text().primaryKey().notNull(),
    groupId: text().notNull(),
    invitedUserId: text().notNull(),
    invitedBy: text().notNull(),
    status: text().default("pending").notNull(),
    invitedAt: timestamp({ mode: "string" }).defaultNow().notNull(),
    respondedAt: timestamp({ mode: "string" }),
    message: text(),
  },
  (table) => [
    index("UserGroupInvite_groupId_idx").using(
      "btree",
      table.groupId.asc().nullsLast().op("text_ops"),
    ),
    index("UserGroupInvite_invitedUserId_status_idx").using(
      "btree",
      table.invitedUserId.asc().nullsLast().op("text_ops"),
      table.status.asc().nullsLast().op("text_ops"),
    ),
    index("UserGroupInvite_status_idx").using(
      "btree",
      table.status.asc().nullsLast().op("text_ops"),
    ),
    unique("UserGroupInvite_groupId_invitedUserId_key").on(
      table.groupId,
      table.invitedUserId,
    ),
  ],
);

export const userGroupMember = pgTable(
  "UserGroupMember",
  {
    id: text().primaryKey().notNull(),
    groupId: text().notNull(),
    userId: text().notNull(),
    joinedAt: timestamp({ mode: "string" }).defaultNow().notNull(),
    addedBy: text().notNull(),
  },
  (table) => [
    index("UserGroupMember_groupId_idx").using(
      "btree",
      table.groupId.asc().nullsLast().op("text_ops"),
    ),
    index("UserGroupMember_userId_idx").using(
      "btree",
      table.userId.asc().nullsLast().op("text_ops"),
    ),
    unique("UserGroupMember_groupId_userId_key").on(
      table.groupId,
      table.userId,
    ),
  ],
);

export const userGroup = pgTable(
  "UserGroup",
  {
    id: text().primaryKey().notNull(),
    name: text().notNull(),
    description: text(),
    createdById: text().notNull(),
    createdAt: timestamp({ mode: "string" }).defaultNow().notNull(),
    updatedAt: timestamp({ mode: "string" }).notNull(),
  },
  (table) => [
    index("UserGroup_createdAt_idx").using(
      "btree",
      table.createdAt.asc().nullsLast().op("timestamp_ops"),
    ),
    index("UserGroup_createdById_idx").using(
      "btree",
      table.createdById.asc().nullsLast().op("text_ops"),
    ),
  ],
);

export const characterMapping = pgTable(
  "CharacterMapping",
  {
    id: text().primaryKey().notNull(),
    realName: text().notNull(),
    parodyName: text().notNull(),
    category: text().notNull(),
    aliases: text().array().default([""]).notNull(),
    isActive: boolean().default(true).notNull(),
    priority: integer().default(0).notNull(),
    createdAt: timestamp({ mode: "string" }).defaultNow().notNull(),
    updatedAt: timestamp({ mode: "string" }).notNull(),
  },
  (table) => [
    index("CharacterMapping_category_isActive_idx").using(
      "btree",
      table.category.asc().nullsLast().op("bool_ops"),
      table.isActive.asc().nullsLast().op("bool_ops"),
    ),
    index("CharacterMapping_priority_idx").using(
      "btree",
      table.priority.asc().nullsLast().op("int4_ops"),
    ),
    unique("CharacterMapping_realName_unique").on(table.realName),
  ],
);

export const gameConfig = pgTable(
  "GameConfig",
  {
    id: text().primaryKey().notNull(),
    key: text().notNull(),
    value: json().notNull(),
    createdAt: timestamp({ mode: "string" }).defaultNow().notNull(),
    updatedAt: timestamp({ mode: "string" }).notNull(),
  },
  (table) => [
    index("GameConfig_key_idx").using(
      "btree",
      table.key.asc().nullsLast().op("text_ops"),
    ),
    unique("GameConfig_key_unique").on(table.key),
  ],
);

export const game = pgTable(
  "Game",
  {
    id: text().primaryKey().notNull(),
    currentDay: integer().default(1).notNull(),
    currentDate: timestamp({ mode: "string" }).defaultNow().notNull(),
    isRunning: boolean().default(false).notNull(),
    isContinuous: boolean().default(true).notNull(),
    speed: integer().default(60000).notNull(),
    startedAt: timestamp({ mode: "string" }),
    pausedAt: timestamp({ mode: "string" }),
    completedAt: timestamp({ mode: "string" }),
    lastTickAt: timestamp({ mode: "string" }),
    lastSnapshotAt: timestamp({ mode: "string" }),
    activeQuestions: integer().default(0).notNull(),
    createdAt: timestamp({ mode: "string" }).defaultNow().notNull(),
    updatedAt: timestamp({ mode: "string" }).notNull(),
  },
  (table) => [
    index("Game_isContinuous_idx").using(
      "btree",
      table.isContinuous.asc().nullsLast().op("bool_ops"),
    ),
    index("Game_isRunning_idx").using(
      "btree",
      table.isRunning.asc().nullsLast().op("bool_ops"),
    ),
  ],
);

export const generationLock = pgTable(
  "GenerationLock",
  {
    id: text().default("game-tick-lock").primaryKey().notNull(),
    lockedBy: text().notNull(),
    lockedAt: timestamp({ mode: "string" }).defaultNow().notNull(),
    expiresAt: timestamp({ mode: "string" }).notNull(),
    operation: text().default("game-tick").notNull(),
  },
  (table) => [
    index("GenerationLock_expiresAt_idx").using(
      "btree",
      table.expiresAt.asc().nullsLast().op("timestamp_ops"),
    ),
  ],
);

export const oauthState = pgTable(
  "OAuthState",
  {
    id: text().primaryKey().notNull(),
    state: text().notNull(),
    codeVerifier: text().notNull(),
    userId: text(),
    returnPath: text(),
    expiresAt: timestamp({ mode: "string" }).notNull(),
    createdAt: timestamp({ mode: "string" }).defaultNow().notNull(),
  },
  (table) => [
    index("OAuthState_expiresAt_idx").using(
      "btree",
      table.expiresAt.asc().nullsLast().op("timestamp_ops"),
    ),
    index("OAuthState_state_idx").using(
      "btree",
      table.state.asc().nullsLast().op("text_ops"),
    ),
    unique("OAuthState_state_unique").on(table.state),
  ],
);

export const oracleCommitment = pgTable(
  "OracleCommitment",
  {
    id: text().primaryKey().notNull(),
    questionId: text().notNull(),
    sessionId: text().notNull(),
    saltEncrypted: text().notNull(),
    commitment: text().notNull(),
    createdAt: timestamp({ mode: "string" }).defaultNow().notNull(),
  },
  (table) => [
    index("OracleCommitment_createdAt_idx").using(
      "btree",
      table.createdAt.asc().nullsLast().op("timestamp_ops"),
    ),
    index("OracleCommitment_questionId_idx").using(
      "btree",
      table.questionId.asc().nullsLast().op("text_ops"),
    ),
    index("OracleCommitment_sessionId_idx").using(
      "btree",
      table.sessionId.asc().nullsLast().op("text_ops"),
    ),
    unique("OracleCommitment_questionId_unique").on(table.questionId),
  ],
);

export const oracleTransaction = pgTable(
  "OracleTransaction",
  {
    id: text().primaryKey().notNull(),
    questionId: text(),
    txType: text().notNull(),
    txHash: text().notNull(),
    status: text().notNull(),
    blockNumber: integer(),
    // You can use { mode: "bigint" } if numbers are exceeding js number limitations
    gasUsed: bigint({ mode: "number" }),
    // You can use { mode: "bigint" } if numbers are exceeding js number limitations
    gasPrice: bigint({ mode: "number" }),
    error: text(),
    retryCount: integer().default(0).notNull(),
    createdAt: timestamp({ mode: "string" }).defaultNow().notNull(),
    confirmedAt: timestamp({ mode: "string" }),
  },
  (table) => [
    index("OracleTransaction_questionId_idx").using(
      "btree",
      table.questionId.asc().nullsLast().op("text_ops"),
    ),
    index("OracleTransaction_status_createdAt_idx").using(
      "btree",
      table.status.asc().nullsLast().op("timestamp_ops"),
      table.createdAt.asc().nullsLast().op("timestamp_ops"),
    ),
    index("OracleTransaction_txHash_idx").using(
      "btree",
      table.txHash.asc().nullsLast().op("text_ops"),
    ),
    index("OracleTransaction_txType_idx").using(
      "btree",
      table.txType.asc().nullsLast().op("text_ops"),
    ),
    unique("OracleTransaction_txHash_unique").on(table.txHash),
  ],
);

export const organizationMapping = pgTable(
  "OrganizationMapping",
  {
    id: text().primaryKey().notNull(),
    realName: text().notNull(),
    parodyName: text().notNull(),
    category: text().notNull(),
    aliases: text().array().default([""]).notNull(),
    isActive: boolean().default(true).notNull(),
    priority: integer().default(0).notNull(),
    createdAt: timestamp({ mode: "string" }).defaultNow().notNull(),
    updatedAt: timestamp({ mode: "string" }).notNull(),
  },
  (table) => [
    index("OrganizationMapping_category_isActive_idx").using(
      "btree",
      table.category.asc().nullsLast().op("bool_ops"),
      table.isActive.asc().nullsLast().op("bool_ops"),
    ),
    index("OrganizationMapping_priority_idx").using(
      "btree",
      table.priority.asc().nullsLast().op("int4_ops"),
    ),
    unique("OrganizationMapping_realName_unique").on(table.realName),
  ],
);

export const parodyHeadline = pgTable(
  "ParodyHeadline",
  {
    id: text().primaryKey().notNull(),
    originalHeadlineId: text().notNull(),
    originalTitle: text().notNull(),
    originalSource: text().notNull(),
    parodyTitle: text().notNull(),
    parodyContent: text(),
    characterMappings: json().notNull(),
    organizationMappings: json().notNull(),
    generatedAt: timestamp({ mode: "string" }).notNull(),
    isUsed: boolean().default(false).notNull(),
    usedAt: timestamp({ mode: "string" }),
    createdAt: timestamp({ mode: "string" }).defaultNow().notNull(),
  },
  (table) => [
    index("ParodyHeadline_generatedAt_idx").using(
      "btree",
      table.generatedAt.asc().nullsLast().op("timestamp_ops"),
    ),
    index("ParodyHeadline_isUsed_generatedAt_idx").using(
      "btree",
      table.isUsed.asc().nullsLast().op("timestamp_ops"),
      table.generatedAt.asc().nullsLast().op("bool_ops"),
    ),
    unique("ParodyHeadline_originalHeadlineId_unique").on(
      table.originalHeadlineId,
    ),
  ],
);

export const realtimeOutbox = pgTable(
  "RealtimeOutbox",
  {
    id: text().primaryKey().notNull(),
    channel: text().notNull(),
    type: text().notNull(),
    version: text().default("v1"),
    payload: json().notNull(),
    status: realtimeOutboxStatus().default("pending").notNull(),
    attempts: integer().default(0).notNull(),
    lastError: text(),
    createdAt: timestamp({ mode: "string" }).defaultNow().notNull(),
    updatedAt: timestamp({ mode: "string" }).notNull(),
  },
  (table) => [
    index("RealtimeOutbox_channel_status_idx").using(
      "btree",
      table.channel.asc().nullsLast().op("text_ops"),
      table.status.asc().nullsLast().op("enum_ops"),
    ),
    index("RealtimeOutbox_status_createdAt_idx").using(
      "btree",
      table.status.asc().nullsLast().op("enum_ops"),
      table.createdAt.asc().nullsLast().op("enum_ops"),
    ),
  ],
);

export const rssFeedSource = pgTable(
  "RSSFeedSource",
  {
    id: text().primaryKey().notNull(),
    name: text().notNull(),
    feedUrl: text().notNull(),
    category: text().notNull(),
    isActive: boolean().default(true).notNull(),
    lastFetched: timestamp({ mode: "string" }),
    fetchErrors: integer().default(0).notNull(),
    createdAt: timestamp({ mode: "string" }).defaultNow().notNull(),
    updatedAt: timestamp({ mode: "string" }).notNull(),
  },
  (table) => [
    index("RSSFeedSource_category_idx").using(
      "btree",
      table.category.asc().nullsLast().op("text_ops"),
    ),
    index("RSSFeedSource_isActive_lastFetched_idx").using(
      "btree",
      table.isActive.asc().nullsLast().op("timestamp_ops"),
      table.lastFetched.asc().nullsLast().op("timestamp_ops"),
    ),
  ],
);

export const rssHeadline = pgTable(
  "RSSHeadline",
  {
    id: text().primaryKey().notNull(),
    sourceId: text().notNull(),
    title: text().notNull(),
    link: text(),
    publishedAt: timestamp({ mode: "string" }).notNull(),
    summary: text(),
    content: text(),
    rawData: json(),
    fetchedAt: timestamp({ mode: "string" }).notNull(),
  },
  (table) => [
    index("RSSHeadline_publishedAt_idx").using(
      "btree",
      table.publishedAt.asc().nullsLast().op("timestamp_ops"),
    ),
    index("RSSHeadline_sourceId_publishedAt_idx").using(
      "btree",
      table.sourceId.asc().nullsLast().op("text_ops"),
      table.publishedAt.asc().nullsLast().op("text_ops"),
    ),
  ],
);

export const systemSettings = pgTable("SystemSettings", {
  id: text().default("system").primaryKey().notNull(),
  createdAt: timestamp({ mode: "string" }).defaultNow().notNull(),
  updatedAt: timestamp({ mode: "string" }).notNull(),
});

export const widgetCache = pgTable(
  "WidgetCache",
  {
    widget: text().primaryKey().notNull(),
    data: json().notNull(),
    updatedAt: timestamp({ mode: "string" }).defaultNow().notNull(),
  },
  (table) => [
    index("WidgetCache_widget_updatedAt_idx").using(
      "btree",
      table.widget.asc().nullsLast().op("text_ops"),
      table.updatedAt.asc().nullsLast().op("text_ops"),
    ),
  ],
);

export const userApiKey = pgTable(
  "UserApiKey",
  {
    id: text().primaryKey().notNull(),
    userId: text().notNull(),
    keyHash: text().notNull(),
    name: text(),
    lastUsedAt: timestamp({ mode: "string" }),
    createdAt: timestamp({ mode: "string" }).defaultNow().notNull(),
    expiresAt: timestamp({ mode: "string" }),
    revokedAt: timestamp({ mode: "string" }),
  },
  (table) => [
    index("UserApiKey_keyHash_idx").using(
      "btree",
      table.keyHash.asc().nullsLast().op("text_ops"),
    ),
    index("UserApiKey_userId_idx").using(
      "btree",
      table.userId.asc().nullsLast().op("text_ops"),
    ),
    index("UserApiKey_userId_revokedAt_idx").using(
      "btree",
      table.userId.asc().nullsLast().op("text_ops"),
      table.revokedAt.asc().nullsLast().op("text_ops"),
    ),
  ],
);
