import { relations, sql } from "drizzle-orm";
import {
  boolean,
  index,
  integer,
  jsonb,
  type PgColumn,
  pgTable,
  text,
  timestamp,
  unique,
} from "drizzle-orm/pg-core";
import { questions } from "./markets";

/**
 * Market timeframe category
 * Defines the resolution duration for markets
 */
export type MarketTimeframe =
  | "flash" // 15-30 minutes
  | "intraday" // 1-6 hours
  | "daily" // 12-48 hours
  | "weekly" // 3-7 days
  | "monthly" // 2-4 weeks
  | "quarterly" // 1-3 months
  | "longterm"; // 3+ months

/**
 * Market category for thematic grouping
 */
export type MarketCategory =
  | "tech"
  | "crypto"
  | "politics"
  | "sports"
  | "business"
  | "entertainment"
  | "science"
  | "general";

/**
 * Arc state types for long-term narrative state machine (30 days)
 */
export type LongTermArcState =
  | "setup" // Days 1-3: Introduce question
  | "tension" // Days 4-10: Early signals, misdirection
  | "escalation" // Days 11-18: Conflicting signals
  | "crisis" // Days 19-24: Peak uncertainty
  | "revelation" // Days 25-27: Truth emerges
  | "resolution"; // Days 28-30: Definitive answer

/**
 * Arc state types for weekly markets (3-7 days)
 */
export type WeeklyArcState =
  | "setup"
  | "tension"
  | "escalation"
  | "crisis"
  | "resolution";

/**
 * Arc state types for daily markets (12-48 hours)
 */
export type DailyArcState =
  | "morning"
  | "midday"
  | "afternoon"
  | "evening"
  | "resolution";

/**
 * Arc state types for intraday markets (1-6 hours)
 */
export type IntradayArcState = "setup" | "active" | "climax" | "resolution";

/**
 * Arc state types for flash markets (15-30 minutes)
 */
export type FlashArcState = "live" | "resolving";

/**
 * Generic arc state type (union of all)
 */
export type ArcStateType =
  | LongTermArcState
  | WeeklyArcState
  | DailyArcState
  | IntradayArcState
  | FlashArcState;

/**
 * Pending state transition
 */
export interface PendingTransition {
  targetState: ArcStateType;
  triggerDay: number;
  triggerEventType?: string;
  probability?: number;
}

/**
 * Market impact from a structured event
 */
export interface MarketImpact {
  stockTicker: string;
  direction: "up" | "down";
  magnitude: "minor" | "moderate" | "major";
  duration: "instant" | "hours" | "days";
}

/**
 * Structured event types for narrative
 */
export type StructuredEventType =
  | "rumor"
  | "leak"
  | "denial"
  | "confirmation"
  | "reversal"
  | "proof";

/**
 * Structured event data stored in events table
 */
export interface StructuredEventData {
  arcId: string;
  type: StructuredEventType;
  severity: 1 | 2 | 3 | 4 | 5;
  affectedActors: string[];
  affectedStocks: string[];
  affectedQuestions: string[];
  signalDirection: "YES" | "NO" | "NEUTRAL";
  signalStrength: number;
  marketImpacts: MarketImpact[];
}

/**
 * QuestionArcPlan - Narrative arc configuration for a prediction question.
 * Stores timing milestones and actor assignments for signal generation.
 */
export const questionArcPlans = pgTable(
  "QuestionArcPlan",
  {
    id: text("id").primaryKey(),
    questionId: text("questionId")
      .notNull()
      .references(() => questions.id, { onDelete: "cascade" }),

    // Narrative timing (day numbers)
    uncertaintyPeakDay: integer("uncertaintyPeakDay").notNull(),
    clarityOnsetDay: integer("clarityOnsetDay").notNull(),
    verificationDay: integer("verificationDay").notNull(),

    // Actor assignments
    insiderActorIds: jsonb("insiderActorIds").$type<string[]>().default([]),
    deceiverActorIds: jsonb("deceiverActorIds").$type<string[]>().default([]),

    // Phase signal ratios (correctSignals / totalSignals)
    phaseRatios: jsonb("phaseRatios")
      .$type<{ early: number; middle: number; late: number; climax: number }>()
      .notNull(),

    createdAt: timestamp("createdAt", { mode: "date" }).notNull().defaultNow(),
  },
  (t) => [index("QuestionArcPlan_questionId_idx").on(t.questionId)],
);

export const questionArcPlansRelations = relations(
  questionArcPlans,
  ({ one }) => ({
    question: one(questions, {
      fields: [questionArcPlans.questionId],
      references: [questions.id],
    }),
  }),
);

export type QuestionArcPlan = typeof questionArcPlans.$inferSelect;
export type NewQuestionArcPlan = typeof questionArcPlans.$inferInsert;

/**
 * ArcState - Tracks the current state of a narrative arc state machine.
 * Each question has an associated arc state that transitions through phases.
 */
export const arcStates = pgTable(
  "ArcState",
  {
    id: text("id").primaryKey(),
    questionId: text("questionId")
      .notNull()
      .references(() => questions.id, { onDelete: "cascade" }),

    // State machine
    currentState: text("currentState").$type<ArcStateType>().notNull(),
    stateEnteredAt: timestamp("stateEnteredAt", { mode: "date" }).notNull(),

    // Event tracking
    eventsGenerated: integer("eventsGenerated").notNull().default(0),
    lastEventAt: timestamp("lastEventAt", { mode: "date" }),

    // Pending transitions
    pendingTransitions: jsonb("pendingTransitions")
      .$type<PendingTransition[]>()
      .default(sql`'[]'::jsonb`),

    createdAt: timestamp("createdAt", { mode: "date" }).notNull().defaultNow(),
    updatedAt: timestamp("updatedAt", { mode: "date" }).notNull().defaultNow(),
  },
  (t) => [
    // Note: unique constraint on questionId serves as an index, so separate index removed
    index("ArcState_currentState_idx").on(t.currentState),
    unique("ArcState_questionId_unique").on(t.questionId),
  ],
);

export const arcStatesRelations = relations(arcStates, ({ one }) => ({
  question: one(questions, {
    fields: [arcStates.questionId],
    references: [questions.id],
  }),
}));

export type ArcState = typeof arcStates.$inferSelect;
export type NewArcState = typeof arcStates.$inferInsert;

// =============================================================================
// TIMEFRAMED MARKETS
// =============================================================================

/**
 * Sub-market trigger metadata
 */
export interface SubMarketTriggerData {
  eventType: string;
  questionTemplate: string;
  spawnedAt: string; // ISO date
  parentEventId?: string;
}

/**
 * TimeframedMarket - Markets with explicit timeframe and hierarchy support.
 * Can be standalone or part of a parent/child hierarchy.
 */
export const timeframedMarkets = pgTable(
  "TimeframedMarket",
  {
    id: text("id").primaryKey(),

    // Link to question/market
    questionId: text("questionId").references(() => questions.id, {
      onDelete: "cascade",
    }),

    // Timeframe configuration
    timeframe: text("timeframe").$type<MarketTimeframe>().notNull(),
    category: text("category")
      .$type<MarketCategory>()
      .notNull()
      .default("general"),

    // Hierarchy (self-referential foreign keys)
    parentMarketId: text("parentMarketId").references(
      (): PgColumn => timeframedMarkets.id,
      { onDelete: "set null" },
    ),
    rootMarketId: text("rootMarketId").references(
      (): PgColumn => timeframedMarkets.id,
      { onDelete: "set null" },
    ), // Top-level parent for nested hierarchies

    // Timing
    startTime: timestamp("startTime", { mode: "date" }).notNull(),
    endTime: timestamp("endTime", { mode: "date" }).notNull(),

    // Arc state (typed to ArcStateType for type safety)
    arcState: text("arcState").$type<ArcStateType>().notNull().default("setup"),
    arcStateEnteredAt: timestamp("arcStateEnteredAt", {
      mode: "date",
    }).notNull(),

    // Status
    isActive: boolean("isActive").notNull().default(true),
    isResolved: boolean("isResolved").notNull().default(false),
    resolvedAt: timestamp("resolvedAt", { mode: "date" }),

    // Metadata
    triggerData: jsonb("triggerData").$type<SubMarketTriggerData>(),
    affiliatedOrgIds: jsonb("affiliatedOrgIds").$type<string[]>().default([]),
    affiliatedActorIds: jsonb("affiliatedActorIds")
      .$type<string[]>()
      .default([]),

    // Stats
    childMarketCount: integer("childMarketCount").notNull().default(0),
    eventsGenerated: integer("eventsGenerated").notNull().default(0),
    lastEventAt: timestamp("lastEventAt", { mode: "date" }),

    createdAt: timestamp("createdAt", { mode: "date" }).notNull().defaultNow(),
    updatedAt: timestamp("updatedAt", { mode: "date" }).notNull().defaultNow(),
  },
  (t) => [
    index("TimeframedMarket_questionId_idx").on(t.questionId),
    index("TimeframedMarket_parentMarketId_idx").on(t.parentMarketId),
    index("TimeframedMarket_rootMarketId_idx").on(t.rootMarketId),
    index("TimeframedMarket_timeframe_idx").on(t.timeframe),
    index("TimeframedMarket_category_idx").on(t.category),
    index("TimeframedMarket_isActive_idx").on(t.isActive),
    index("TimeframedMarket_endTime_idx").on(t.endTime),
    index("TimeframedMarket_startTime_endTime_idx").on(t.startTime, t.endTime),
  ],
);

export const timeframedMarketsRelations = relations(
  timeframedMarkets,
  ({ one, many }) => ({
    question: one(questions, {
      fields: [timeframedMarkets.questionId],
      references: [questions.id],
    }),
    parentMarket: one(timeframedMarkets, {
      fields: [timeframedMarkets.parentMarketId],
      references: [timeframedMarkets.id],
      relationName: "parentChild",
    }),
    childMarkets: many(timeframedMarkets, {
      relationName: "parentChild",
    }),
    rootMarket: one(timeframedMarkets, {
      fields: [timeframedMarkets.rootMarketId],
      references: [timeframedMarkets.id],
      relationName: "rootRelation",
    }),
    descendantMarkets: many(timeframedMarkets, {
      relationName: "rootRelation",
    }),
  }),
);

export type TimeframedMarket = typeof timeframedMarkets.$inferSelect;
export type NewTimeframedMarket = typeof timeframedMarkets.$inferInsert;

// =============================================================================
// SUB-MARKET SPAWN LOG
// =============================================================================

/**
 * SubMarketSpawnLog - Tracks sub-market creation from narrative events.
 * Used for analytics and preventing duplicate spawns.
 */
export const subMarketSpawnLogs = pgTable(
  "SubMarketSpawnLog",
  {
    id: text("id").primaryKey(),

    // Source
    parentMarketId: text("parentMarketId")
      .notNull()
      .references(() => timeframedMarkets.id, { onDelete: "cascade" }),
    sourceEventId: text("sourceEventId"),
    eventType: text("eventType").notNull(),

    // Result
    spawnedMarketId: text("spawnedMarketId").references(
      () => timeframedMarkets.id,
      { onDelete: "set null" },
    ),
    wasSpawned: boolean("wasSpawned").notNull(),
    skipReason: text("skipReason"), // If not spawned, why

    // Details
    questionTemplate: text("questionTemplate"),
    generatedQuestion: text("generatedQuestion"),
    childTimeframe: text("childTimeframe").$type<MarketTimeframe>(),

    createdAt: timestamp("createdAt", { mode: "date" }).notNull().defaultNow(),
  },
  (t) => [
    index("SubMarketSpawnLog_parentMarketId_idx").on(t.parentMarketId),
    index("SubMarketSpawnLog_spawnedMarketId_idx").on(t.spawnedMarketId),
    index("SubMarketSpawnLog_eventType_idx").on(t.eventType),
    index("SubMarketSpawnLog_createdAt_idx").on(t.createdAt),
    // Note: Partial unique index on (parentMarketId, sourceEventId) WHERE sourceEventId IS NOT NULL
    // is defined in the migration SQL file as Drizzle doesn't support partial unique constraints directly
  ],
);

export const subMarketSpawnLogsRelations = relations(
  subMarketSpawnLogs,
  ({ one }) => ({
    parentMarket: one(timeframedMarkets, {
      fields: [subMarketSpawnLogs.parentMarketId],
      references: [timeframedMarkets.id],
    }),
    spawnedMarket: one(timeframedMarkets, {
      fields: [subMarketSpawnLogs.spawnedMarketId],
      references: [timeframedMarkets.id],
    }),
  }),
);

export type SubMarketSpawnLog = typeof subMarketSpawnLogs.$inferSelect;
export type NewSubMarketSpawnLog = typeof subMarketSpawnLogs.$inferInsert;
