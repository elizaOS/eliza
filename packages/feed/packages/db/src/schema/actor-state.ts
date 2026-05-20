import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  decimal,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
} from 'drizzle-orm/pg-core';

/**
 * NPC Memory - Bounded memory of past interactions for continuity
 * Note: Dates stored as ISO strings for JSONB compatibility
 */
export interface NpcMemory {
  id: string;
  type:
    | 'posted'
    | 'replied_to'
    | 'mentioned_by'
    | 'witnessed_event'
    | 'traded'
    | 'running_bit';
  timestamp: string; // ISO date string
  summary: string;
  actorIds?: string[];
  eventId?: string;
  questionId?: string;
  sentiment: number; // -1 to 1
}

/**
 * Relationship State - Tracks relationship between two actors
 * Note: Dates stored as ISO strings for JSONB compatibility
 */
export interface RelationshipState {
  actorId: string;
  sentiment: number; // -1 (hostile) to 1 (friendly)
  lastInteraction: string; // ISO date string
  interactionCount: number;
  notes: string[];
}

/**
 * ActorState - Dynamic runtime state for actors (NPCs)
 *
 * Static actor data is in TypeScript (StaticDataRegistry from @feed/engine).
 * This table stores only fields that change during gameplay.
 */
export const actorState = pgTable(
  'ActorState',
  {
    id: text('id').primaryKey(),
    tradingBalance: decimal('tradingBalance', { precision: 18, scale: 2 })
      .notNull()
      .default('10000'),
    reputationPoints: integer('reputationPoints').notNull().default(10000),
    hasPool: boolean('hasPool').notNull().default(false),

    // Activity tracking for organic behavior patterns
    lastPostAt: timestamp('lastPostAt', { mode: 'date' }),
    lastActiveAt: timestamp('lastActiveAt', { mode: 'date' }),
    postsToday: integer('postsToday').notNull().default(0),
    postsTodayResetAt: timestamp('postsTodayResetAt', { mode: 'date' }),

    // Mood state (-1 to 1)
    // CHECK constraint current_mood_bounds enforces -1 <= currentMood <= 1 at DB level
    currentMood: decimal('currentMood', { precision: 4, scale: 3 }).default(
      '0'
    ),

    // Memory array for NPC context
    // Note: 50-memory limit is enforced in NpcMemoryService, not at DB level
    recentMemories: jsonb('recentMemories')
      .$type<NpcMemory[]>()
      .default(sql`'[]'::jsonb`),

    // Relationships with other actors
    relationships: jsonb('relationships')
      .$type<Record<string, RelationshipState>>()
      .default(sql`'{}'::jsonb`),

    createdAt: timestamp('createdAt', { mode: 'date' }).notNull().defaultNow(),
    updatedAt: timestamp('updatedAt', { mode: 'date' }).notNull(),
  },
  (table) => [
    index('ActorState_hasPool_idx').on(table.hasPool),
    index('ActorState_reputationPoints_idx').on(table.reputationPoints),
    index('ActorState_lastPostAt_idx').on(table.lastPostAt),
    index('ActorState_lastActiveAt_idx').on(table.lastActiveAt),
    // Prevent negative trading balance at database level
    check('positive_trading_balance', sql`${table.tradingBalance} >= 0`),
    // Enforce mood bounds (-1 to 1) at database level
    check(
      'current_mood_bounds',
      sql`${table.currentMood} >= -1 AND ${table.currentMood} <= 1`
    ),
  ]
);

// Type exports
export type ActorStateRow = typeof actorState.$inferSelect;
export type NewActorStateRow = typeof actorState.$inferInsert;
