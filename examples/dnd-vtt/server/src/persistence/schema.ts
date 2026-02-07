/**
 * Database Schema
 * Drizzle ORM schema for campaign persistence
 */

import {
  pgTable,
  uuid,
  varchar,
  text,
  integer,
  boolean,
  timestamp,
  jsonb,
  real,
  index,
} from 'drizzle-orm/pg-core';
import { relations } from 'drizzle-orm';

// ============================================================================
// CAMPAIGNS
// ============================================================================

export const campaigns = pgTable('campaigns', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: varchar('name', { length: 255 }).notNull(),
  description: text('description'),
  
  dmAgentId: uuid('dm_agent_id'),
  dmCharacterName: varchar('dm_character_name', { length: 255 }).default('Dungeon Master'),
  
  settings: jsonb('settings').default({
    maxPartySize: 6,
    startingLevel: 1,
    allowPvP: false,
    deathRules: 'standard',
    restRules: 'standard',
    encumbranceRules: 'none',
  }),
  
  currentTime: jsonb('current_time').default({
    year: 1490,
    month: 1,
    day: 1,
    hour: 8,
    minute: 0,
  }),
  currentLocationId: uuid('current_location_id'),
  
  totalPlayTime: integer('total_play_time').default(0),
  sessionCount: integer('session_count').default(0),
  
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
});

export const campaignsRelations = relations(campaigns, ({ many, one }) => ({
  sessions: many(sessions),
  characters: many(characters),
  npcs: many(npcs),
  locations: many(locations),
  quests: many(quests),
  worldEvents: many(worldEvents),
  currentLocation: one(locations, {
    fields: [campaigns.currentLocationId],
    references: [locations.id],
  }),
}));

// ============================================================================
// SESSIONS
// ============================================================================

export const sessions = pgTable('sessions', {
  id: uuid('id').primaryKey().defaultRandom(),
  campaignId: uuid('campaign_id').notNull().references(() => campaigns.id, { onDelete: 'cascade' }),
  sessionNumber: integer('session_number').notNull(),
  
  startedAt: timestamp('started_at').defaultNow().notNull(),
  endedAt: timestamp('ended_at'),
  duration: integer('duration'), // Minutes
  
  startingLocationId: uuid('starting_location_id'),
  endingLocationId: uuid('ending_location_id'),
  startingTime: jsonb('starting_time'),
  endingTime: jsonb('ending_time'),
  
  summary: jsonb('summary'),
  stateSnapshot: text('state_snapshot'),
  
  playerCharacterIds: jsonb('player_character_ids').default([]),
  activeNpcIds: jsonb('active_npc_ids').default([]),
  
  createdAt: timestamp('created_at').defaultNow().notNull(),
}, (table) => ({
  campaignIdx: index('sessions_campaign_idx').on(table.campaignId),
  sessionNumberIdx: index('sessions_number_idx').on(table.campaignId, table.sessionNumber),
}));

export const sessionsRelations = relations(sessions, ({ one, many }) => ({
  campaign: one(campaigns, {
    fields: [sessions.campaignId],
    references: [campaigns.id],
  }),
  worldEvents: many(worldEvents),
}));

// ============================================================================
// CHARACTERS
// ============================================================================

export const characters = pgTable('characters', {
  id: uuid('id').primaryKey().defaultRandom(),
  campaignId: uuid('campaign_id').notNull().references(() => campaigns.id, { onDelete: 'cascade' }),
  
  playerType: varchar('player_type', { length: 20 }).notNull(), // 'human' or 'ai'
  agentId: uuid('agent_id'), // ElizaOS agent ID if AI
  
  name: varchar('name', { length: 255 }).notNull(),
  sheet: jsonb('sheet').notNull(), // Full CharacterSheet
  
  // Quick access fields for querying
  race: varchar('race', { length: 50 }).notNull(),
  className: varchar('class_name', { length: 50 }).notNull(),
  level: integer('level').notNull().default(1),
  currentHP: integer('current_hp').notNull(),
  maxHP: integer('max_hp').notNull(),
  
  portraitUrl: text('portrait_url'),
  tokenUrl: text('token_url'),
  
  isActive: boolean('is_active').default(true),
  
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
}, (table) => ({
  campaignIdx: index('characters_campaign_idx').on(table.campaignId),
  playerTypeIdx: index('characters_player_type_idx').on(table.playerType),
}));

export const charactersRelations = relations(characters, ({ one, many }) => ({
  campaign: one(campaigns, {
    fields: [characters.campaignId],
    references: [campaigns.id],
  }),
  memories: many(characterMemories),
  relationships: many(characterRelationships),
}));

// ============================================================================
// CHARACTER MEMORIES
// ============================================================================

export const characterMemories = pgTable('character_memories', {
  id: uuid('id').primaryKey().defaultRandom(),
  characterId: uuid('character_id').notNull().references(() => characters.id, { onDelete: 'cascade' }),
  campaignId: uuid('campaign_id').notNull().references(() => campaigns.id, { onDelete: 'cascade' }),
  
  type: varchar('type', { length: 50 }).notNull(), // 'experience', 'relationship', etc.
  content: text('content').notNull(),
  
  sessionId: uuid('session_id').references(() => sessions.id),
  gameTime: jsonb('game_time'),
  locationId: uuid('location_id').references(() => locations.id),
  relatedEntityIds: jsonb('related_entity_ids').default([]),
  
  importance: integer('importance').notNull().default(5), // 1-10
  emotionalValence: real('emotional_valence').default(0), // -1 to 1
  
  embeddingId: uuid('embedding_id'), // Reference to embedding store
  
  createdAt: timestamp('created_at').defaultNow().notNull(),
}, (table) => ({
  characterIdx: index('char_memories_character_idx').on(table.characterId),
  campaignIdx: index('char_memories_campaign_idx').on(table.campaignId),
  importanceIdx: index('char_memories_importance_idx').on(table.importance),
}));

export const characterMemoriesRelations = relations(characterMemories, ({ one }) => ({
  character: one(characters, {
    fields: [characterMemories.characterId],
    references: [characters.id],
  }),
  campaign: one(campaigns, {
    fields: [characterMemories.campaignId],
    references: [campaigns.id],
  }),
  session: one(sessions, {
    fields: [characterMemories.sessionId],
    references: [sessions.id],
  }),
  location: one(locations, {
    fields: [characterMemories.locationId],
    references: [locations.id],
  }),
}));

// ============================================================================
// CHARACTER RELATIONSHIPS
// ============================================================================

export const characterRelationships = pgTable('character_relationships', {
  id: uuid('id').primaryKey().defaultRandom(),
  characterId: uuid('character_id').notNull().references(() => characters.id, { onDelete: 'cascade' }),
  targetId: uuid('target_id').notNull(),
  targetType: varchar('target_type', { length: 20 }).notNull(), // 'pc' or 'npc'
  targetName: varchar('target_name', { length: 255 }).notNull(),
  
  disposition: integer('disposition').default(0), // -100 to 100
  trust: integer('trust').default(50), // 0 to 100
  familiarity: integer('familiarity').default(0), // 0 to 100
  
  significantInteractions: jsonb('significant_interactions').default([]),
  
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
}, (table) => ({
  characterIdx: index('char_rel_character_idx').on(table.characterId),
  targetIdx: index('char_rel_target_idx').on(table.targetId),
}));

export const characterRelationshipsRelations = relations(characterRelationships, ({ one }) => ({
  character: one(characters, {
    fields: [characterRelationships.characterId],
    references: [characters.id],
  }),
}));

// ============================================================================
// NPCs
// ============================================================================

export const npcs = pgTable('npcs', {
  id: uuid('id').primaryKey().defaultRandom(),
  campaignId: uuid('campaign_id').notNull().references(() => campaigns.id, { onDelete: 'cascade' }),
  
  name: varchar('name', { length: 255 }).notNull(),
  type: varchar('type', { length: 50 }).default('neutral'), // 'ally', 'enemy', 'neutral', 'merchant', 'questGiver'
  race: varchar('race', { length: 100 }),
  occupation: varchar('occupation', { length: 100 }),
  description: text('description'),
  personality: text('personality'),
  appearance: text('appearance'),
  motivation: text('motivation'),
  
  faction: varchar('faction', { length: 100 }),
  
  statBlock: jsonb('stat_block'), // Monster stat block if applicable
  
  currentLocationId: uuid('current_location_id').references(() => locations.id),
  
  partyDisposition: integer('party_disposition').default(0), // -100 to 100
  disposition: jsonb('disposition').default({}), // Character ID -> disposition
  knownInformation: jsonb('known_information').default([]),
  secrets: jsonb('secrets').default([]),
  
  greeting: text('greeting'),
  farewell: text('farewell'),
  
  isAlive: boolean('is_alive').default(true),
  isHostile: boolean('is_hostile').default(false),
  interactionCount: integer('interaction_count').default(0),
  lastInteraction: timestamp('last_interaction'),
  
  portraitUrl: text('portrait_url'),
  
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
}, (table) => ({
  campaignIdx: index('npcs_campaign_idx').on(table.campaignId),
  locationIdx: index('npcs_location_idx').on(table.currentLocationId),
  typeIdx: index('npcs_type_idx').on(table.type),
}));

export const npcsRelations = relations(npcs, ({ one, many }) => ({
  campaign: one(campaigns, {
    fields: [npcs.campaignId],
    references: [campaigns.id],
  }),
  location: one(locations, {
    fields: [npcs.currentLocationId],
    references: [locations.id],
  }),
  memories: many(npcMemories),
}));

// ============================================================================
// NPC MEMORIES
// ============================================================================

export const npcMemories = pgTable('npc_memories', {
  id: uuid('id').primaryKey().defaultRandom(),
  npcId: uuid('npc_id').notNull().references(() => npcs.id, { onDelete: 'cascade' }),
  campaignId: uuid('campaign_id').notNull().references(() => campaigns.id, { onDelete: 'cascade' }),
  
  involvedCharacterIds: jsonb('involved_character_ids').default([]),
  involvedCharacterNames: jsonb('involved_character_names').default([]),
  
  content: text('content').notNull(),
  
  sessionId: uuid('session_id').references(() => sessions.id),
  gameTime: jsonb('game_time'),
  locationId: uuid('location_id').references(() => locations.id),
  
  dispositionChange: jsonb('disposition_change').default({}), // Character ID -> change
  
  createdAt: timestamp('created_at').defaultNow().notNull(),
}, (table) => ({
  npcIdx: index('npc_memories_npc_idx').on(table.npcId),
  campaignIdx: index('npc_memories_campaign_idx').on(table.campaignId),
}));

export const npcMemoriesRelations = relations(npcMemories, ({ one }) => ({
  npc: one(npcs, {
    fields: [npcMemories.npcId],
    references: [npcs.id],
  }),
  campaign: one(campaigns, {
    fields: [npcMemories.campaignId],
    references: [campaigns.id],
  }),
}));

// ============================================================================
// LOCATIONS
// ============================================================================

export const locations = pgTable('locations', {
  id: uuid('id').primaryKey().defaultRandom(),
  campaignId: uuid('campaign_id').notNull().references(() => campaigns.id, { onDelete: 'cascade' }),
  
  name: varchar('name', { length: 255 }).notNull(),
  description: text('description'),
  type: varchar('type', { length: 50 }).notNull(), // 'town', 'dungeon', etc.
  
  parentLocationId: uuid('parent_location_id'),
  childLocationIds: jsonb('child_location_ids').default([]),
  
  connections: jsonb('connections').default([]),
  features: jsonb('features').default([]),
  
  ambiance: text('ambiance'),
  lighting: varchar('lighting', { length: 50 }).default('bright'),
  
  // Tags and metadata
  tags: jsonb('tags').default([]),
  npcs: jsonb('npcs').default([]), // NPC IDs present at location
  pointsOfInterest: jsonb('points_of_interest').default([]),
  availableServices: jsonb('available_services').default([]),
  dangerLevel: integer('danger_level').default(0), // 0-10
  
  npcIds: jsonb('npc_ids').default([]),
  monsterIds: jsonb('monster_ids').default([]),
  loot: jsonb('loot').default([]),
  
  // Visit tracking
  isDiscovered: boolean('is_discovered').default(false),
  visitCount: integer('visit_count').default(0),
  lastVisited: timestamp('last_visited'),
  
  discovered: boolean('discovered').default(false),
  cleared: boolean('cleared').default(false),
  notes: text('notes'),
  
  battleMapId: uuid('battle_map_id'),
  imageUrl: text('image_url'),
  
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
}, (table) => ({
  campaignIdx: index('locations_campaign_idx').on(table.campaignId),
  parentIdx: index('locations_parent_idx').on(table.parentLocationId),
  typeIdx: index('locations_type_idx').on(table.type),
}));

export const locationsRelations = relations(locations, ({ one, many }) => ({
  campaign: one(campaigns, {
    fields: [locations.campaignId],
    references: [campaigns.id],
  }),
  parent: one(locations, {
    fields: [locations.parentLocationId],
    references: [locations.id],
    relationName: 'parent_child',
  }),
  children: many(locations, { relationName: 'parent_child' }),
  battleMap: one(battleMaps, {
    fields: [locations.battleMapId],
    references: [battleMaps.id],
  }),
  npcs: many(npcs),
  worldEvents: many(worldEvents),
}));

// ============================================================================
// BATTLE MAPS
// ============================================================================

export const battleMaps = pgTable('battle_maps', {
  id: uuid('id').primaryKey().defaultRandom(),
  locationId: uuid('location_id').notNull().references(() => locations.id, { onDelete: 'cascade' }),
  campaignId: uuid('campaign_id').notNull().references(() => campaigns.id, { onDelete: 'cascade' }),
  name: varchar('name', { length: 255 }).notNull(),
  
  gridWidth: integer('grid_width').notNull(),
  gridHeight: integer('grid_height').notNull(),
  gridSize: integer('grid_size').default(5), // Feet per grid square
  
  backgroundUrl: text('background_url'),
  backgroundColor: varchar('background_color', { length: 20 }).default('#2a2a2a'),
  
  showGrid: boolean('show_grid').default(true),
  gridColor: varchar('grid_color', { length: 20 }).default('#444444'),
  gridOpacity: real('grid_opacity').default(0.5),
  
  gridData: jsonb('grid_data').default({}), // Terrain data
  fogOfWar: jsonb('fog_of_war').default([]), // Array of revealed cells
  markers: jsonb('markers').default([]),
  
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
}, (table) => ({
  locationIdx: index('battle_maps_location_idx').on(table.locationId),
  campaignIdx: index('battle_maps_campaign_idx').on(table.campaignId),
}));

export const battleMapsRelations = relations(battleMaps, ({ one }) => ({
  location: one(locations, {
    fields: [battleMaps.locationId],
    references: [locations.id],
  }),
}));

// ============================================================================
// WORLD EVENTS
// ============================================================================

export const worldEvents = pgTable('world_events', {
  id: uuid('id').primaryKey().defaultRandom(),
  campaignId: uuid('campaign_id').notNull().references(() => campaigns.id, { onDelete: 'cascade' }),
  sessionId: uuid('session_id').references(() => sessions.id),
  
  type: varchar('type', { length: 50 }).notNull(),
  description: text('description').notNull(),
  
  involvedEntityIds: jsonb('involved_entity_ids').default([]),
  consequences: jsonb('consequences').default([]),
  
  locationId: uuid('location_id').references(() => locations.id),
  gameTime: jsonb('game_time'),
  
  importance: integer('importance').default(5), // 1-10
  
  embeddingId: uuid('embedding_id'),
  
  createdAt: timestamp('created_at').defaultNow().notNull(),
}, (table) => ({
  campaignIdx: index('world_events_campaign_idx').on(table.campaignId),
  sessionIdx: index('world_events_session_idx').on(table.sessionId),
  locationIdx: index('world_events_location_idx').on(table.locationId),
  importanceIdx: index('world_events_importance_idx').on(table.importance),
  typeIdx: index('world_events_type_idx').on(table.type),
}));

export const worldEventsRelations = relations(worldEvents, ({ one }) => ({
  campaign: one(campaigns, {
    fields: [worldEvents.campaignId],
    references: [campaigns.id],
  }),
  session: one(sessions, {
    fields: [worldEvents.sessionId],
    references: [sessions.id],
  }),
  location: one(locations, {
    fields: [worldEvents.locationId],
    references: [locations.id],
  }),
}));

// ============================================================================
// QUESTS
// ============================================================================

export const quests = pgTable('quests', {
  id: uuid('id').primaryKey().defaultRandom(),
  campaignId: uuid('campaign_id').notNull().references(() => campaigns.id, { onDelete: 'cascade' }),
  
  name: varchar('name', { length: 255 }).notNull(),
  description: text('description'),
  type: varchar('type', { length: 50 }).default('side'), // 'main', 'side', 'personal', 'faction'
  
  giver: varchar('giver', { length: 255 }), // Name of quest giver
  locationId: uuid('location_id').references(() => locations.id),
  
  objectives: jsonb('objectives').default([]),
  rewards: jsonb('rewards').default({}),
  
  status: varchar('status', { length: 50 }).default('available'), // 'available', 'active', 'completed', 'failed'
  importance: integer('importance').default(5), // 1-10
  
  acceptedAt: timestamp('accepted_at'),
  completedAt: timestamp('completed_at'),
  
  playerNotes: text('player_notes'),
  dmNotes: text('dm_notes'),
  
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
}, (table) => ({
  campaignIdx: index('quests_campaign_idx').on(table.campaignId),
  statusIdx: index('quests_status_idx').on(table.status),
  locationIdx: index('quests_location_idx').on(table.locationId),
}));

export const questsRelations = relations(quests, ({ one }) => ({
  campaign: one(campaigns, {
    fields: [quests.campaignId],
    references: [campaigns.id],
  }),
  location: one(locations, {
    fields: [quests.locationId],
    references: [locations.id],
  }),
}));

// ============================================================================
// ITEMS
// ============================================================================

export const items = pgTable('items', {
  id: uuid('id').primaryKey().defaultRandom(),
  campaignId: uuid('campaign_id').notNull().references(() => campaigns.id, { onDelete: 'cascade' }),
  
  name: varchar('name', { length: 255 }).notNull(),
  type: varchar('type', { length: 50 }).notNull(), // 'weapon', 'armor', 'consumable', etc.
  rarity: varchar('rarity', { length: 50 }).default('common'),
  description: text('description'),
  
  properties: jsonb('properties').default({}), // Item-specific properties
  weight: real('weight').default(0),
  value: integer('value').default(0), // In copper pieces
  
  ownerId: uuid('owner_id'),
  ownerType: varchar('owner_type', { length: 50 }), // 'character', 'npc', 'location'
  
  equipped: boolean('equipped').default(false),
  attuned: boolean('attuned').default(false),
  
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
}, (table) => ({
  campaignIdx: index('items_campaign_idx').on(table.campaignId),
  ownerIdx: index('items_owner_idx').on(table.ownerId),
  typeIdx: index('items_type_idx').on(table.type),
}));

// ============================================================================
// EMBEDDINGS (for semantic search)
// ============================================================================

export const embeddings = pgTable('embeddings', {
  id: uuid('id').primaryKey().defaultRandom(),
  campaignId: uuid('campaign_id').notNull().references(() => campaigns.id, { onDelete: 'cascade' }),
  
  entityType: varchar('entity_type', { length: 50 }).notNull(), // 'world_event', 'character_memory', 'npc_memory'
  entityId: uuid('entity_id').notNull(),
  
  content: text('content').notNull(),
  embedding: jsonb('embedding'), // Vector stored as JSON array (could use pgvector extension)
  
  createdAt: timestamp('created_at').defaultNow().notNull(),
}, (table) => ({
  campaignIdx: index('embeddings_campaign_idx').on(table.campaignId),
  entityIdx: index('embeddings_entity_idx').on(table.entityType, table.entityId),
}));

// ============================================================================
// COMBAT LOGS (for session history)
// ============================================================================

export const combatLogs = pgTable('combat_logs', {
  id: uuid('id').primaryKey().defaultRandom(),
  campaignId: uuid('campaign_id').notNull().references(() => campaigns.id, { onDelete: 'cascade' }),
  sessionId: uuid('session_id').notNull().references(() => sessions.id),
  encounterId: uuid('encounter_id').notNull(),
  
  roundNumber: integer('round_number').notNull(),
  turnOrder: integer('turn_order').notNull(),
  
  actorId: uuid('actor_id').notNull(),
  actorName: varchar('actor_name', { length: 255 }).notNull(),
  actionType: varchar('action_type', { length: 50 }).notNull(),
  actionDescription: text('action_description').notNull(),
  
  targetIds: jsonb('target_ids').default([]),
  diceRolls: jsonb('dice_rolls').default([]),
  damage: integer('damage'),
  healing: integer('healing'),
  outcome: text('outcome'),
  
  gameTime: jsonb('game_time'),
  
  createdAt: timestamp('created_at').defaultNow().notNull(),
}, (table) => ({
  campaignIdx: index('combat_logs_campaign_idx').on(table.campaignId),
  sessionIdx: index('combat_logs_session_idx').on(table.sessionId),
  encounterIdx: index('combat_logs_encounter_idx').on(table.encounterId),
}));
