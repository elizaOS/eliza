import {
  boolean,
  doublePrecision,
  index,
  integer,
  json,
  pgTable,
  text,
  timestamp,
} from 'drizzle-orm/pg-core';
import type { JsonValue } from '../types';

/**
 * Actor-related tables for NPC interactions and relationships.
 *
 * Note: Static actor data (name, personality, tier, etc.) is stored in TypeScript
 * files and accessed via StaticDataRegistry from @feed/engine.
 *
 * Dynamic actor state (tradingBalance, reputationPoints, hasPool) is stored
 * in the `actorState` table (see actor-state.ts).
 *
 * The tables below track actor-to-actor relationships and interactions,
 * using actor IDs that reference both the static registry and actorState.
 */

// ActorFollow - NPC follow relationships
export const actorFollows = pgTable(
  'ActorFollow',
  {
    id: text('id').primaryKey(),
    followerId: text('followerId').notNull(),
    followingId: text('followingId').notNull(),
    createdAt: timestamp('createdAt', { mode: 'date' }).notNull().defaultNow(),
    isMutual: boolean('isMutual').notNull().default(false),
  },
  (table) => [
    index('ActorFollow_followerId_idx').on(table.followerId),
    index('ActorFollow_followingId_idx').on(table.followingId),
    index('ActorFollow_isMutual_idx').on(table.isMutual),
  ]
);

// ActorRelationship - Relationships between NPCs
export const actorRelationships = pgTable(
  'ActorRelationship',
  {
    id: text('id').primaryKey(),
    actor1Id: text('actor1Id').notNull(),
    actor2Id: text('actor2Id').notNull(),
    relationshipType: text('relationshipType').notNull(),
    strength: doublePrecision('strength').notNull(),
    sentiment: doublePrecision('sentiment').notNull(),
    isPublic: boolean('isPublic').notNull().default(true),
    history: text('history'),
    affects: json('affects').$type<JsonValue>(),
    createdAt: timestamp('createdAt', { mode: 'date' }).notNull().defaultNow(),
    updatedAt: timestamp('updatedAt', { mode: 'date' }).notNull(),
    lastInteraction: timestamp('lastInteraction', { mode: 'date' }),
    interactionCount: integer('interactionCount').notNull().default(0),
    evolutionCount: integer('evolutionCount').notNull().default(0),
  },
  (table) => [
    index('ActorRelationship_actor1Id_idx').on(table.actor1Id),
    index('ActorRelationship_actor2Id_idx').on(table.actor2Id),
    index('ActorRelationship_relationshipType_idx').on(table.relationshipType),
    index('ActorRelationship_sentiment_idx').on(table.sentiment),
    index('ActorRelationship_strength_idx').on(table.strength),
    index('ActorRelationship_lastInteraction_idx').on(table.lastInteraction),
  ]
);

// NPCInteraction - Interactions between NPCs
export const npcInteractions = pgTable(
  'NPCInteraction',
  {
    id: text('id').primaryKey(),
    actor1Id: text('actor1Id').notNull(),
    actor2Id: text('actor2Id').notNull(),
    interactionType: text('interactionType').notNull(),
    sentiment: doublePrecision('sentiment').notNull().default(0),
    context: text('context').notNull(),
    metadata: json('metadata').$type<JsonValue>(),
    timestamp: timestamp('timestamp', { mode: 'date' }).notNull().defaultNow(),
  },
  (table) => [
    index('NPCInteraction_actor1Id_actor2Id_timestamp_idx').on(
      table.actor1Id,
      table.actor2Id,
      table.timestamp
    ),
    index('NPCInteraction_timestamp_idx').on(table.timestamp),
    index('NPCInteraction_actor1Id_idx').on(table.actor1Id),
    index('NPCInteraction_actor2Id_idx').on(table.actor2Id),
    index('NPCInteraction_interactionType_idx').on(table.interactionType),
  ]
);

// NPCTrade - Trades made by NPCs
export const npcTrades = pgTable(
  'NPCTrade',
  {
    id: text('id').primaryKey(),
    npcActorId: text('npcActorId').notNull(),
    poolId: text('poolId'),
    marketType: text('marketType').notNull(),
    ticker: text('ticker'),
    marketId: text('marketId'),
    action: text('action').notNull(),
    side: text('side'),
    amount: doublePrecision('amount').notNull(),
    price: doublePrecision('price').notNull(),
    sentiment: doublePrecision('sentiment'),
    reason: text('reason'),
    postId: text('postId'),
    executedAt: timestamp('executedAt', { mode: 'date' })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index('NPCTrade_executedAt_idx').on(table.executedAt),
    index('NPCTrade_marketType_marketId_executedAt_idx').on(
      table.marketType,
      table.marketId,
      table.executedAt
    ),
    index('NPCTrade_marketType_ticker_idx').on(table.marketType, table.ticker),
    index('NPCTrade_npcActorId_executedAt_idx').on(
      table.npcActorId,
      table.executedAt
    ),
    index('NPCTrade_poolId_executedAt_idx').on(table.poolId, table.executedAt),
  ]
);

// Type exports
export type ActorFollow = typeof actorFollows.$inferSelect;
export type NewActorFollow = typeof actorFollows.$inferInsert;
export type ActorRelationship = typeof actorRelationships.$inferSelect;
export type NewActorRelationship = typeof actorRelationships.$inferInsert;
export type NPCInteraction = typeof npcInteractions.$inferSelect;
export type NewNPCInteraction = typeof npcInteractions.$inferInsert;
export type NPCTrade = typeof npcTrades.$inferSelect;
export type NewNPCTrade = typeof npcTrades.$inferInsert;
