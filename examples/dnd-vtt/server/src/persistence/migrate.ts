/**
 * Database Migration Script
 * Creates all tables for campaign persistence
 */

import { Pool } from 'pg';
import { getDatabaseConfig } from './database';

const MIGRATIONS = [
  // Drop all tables (for development - remove in production)
  `DROP TABLE IF EXISTS combat_logs CASCADE;`,
  `DROP TABLE IF EXISTS embeddings CASCADE;`,
  `DROP TABLE IF EXISTS items CASCADE;`,
  `DROP TABLE IF EXISTS quests CASCADE;`,
  `DROP TABLE IF EXISTS world_events CASCADE;`,
  `DROP TABLE IF EXISTS battle_maps CASCADE;`,
  `DROP TABLE IF EXISTS locations CASCADE;`,
  `DROP TABLE IF EXISTS npc_memories CASCADE;`,
  `DROP TABLE IF EXISTS npcs CASCADE;`,
  `DROP TABLE IF EXISTS character_relationships CASCADE;`,
  `DROP TABLE IF EXISTS character_memories CASCADE;`,
  `DROP TABLE IF EXISTS characters CASCADE;`,
  `DROP TABLE IF EXISTS sessions CASCADE;`,
  `DROP TABLE IF EXISTS campaigns CASCADE;`,
  
  // Enable UUID extension
  `CREATE EXTENSION IF NOT EXISTS "uuid-ossp";`,
  
  // Campaigns
  `CREATE TABLE campaigns (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    name VARCHAR(255) NOT NULL,
    description TEXT,
    dm_agent_id UUID NOT NULL,
    dm_character_name VARCHAR(255) DEFAULT 'Dungeon Master',
    settings JSONB DEFAULT '{"maxPartySize": 6, "startingLevel": 1, "allowPvP": false, "deathRules": "standard", "restRules": "standard", "encumbranceRules": "none"}',
    "current_time" JSONB DEFAULT '{"year": 1490, "month": 1, "day": 1, "hour": 8, "minute": 0}',
    current_location_id UUID,
    total_play_time INTEGER DEFAULT 0,
    session_count INTEGER DEFAULT 0,
    created_at TIMESTAMP DEFAULT NOW() NOT NULL,
    updated_at TIMESTAMP DEFAULT NOW() NOT NULL
  );`,
  
  // Sessions
  `CREATE TABLE sessions (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    campaign_id UUID NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
    session_number INTEGER NOT NULL,
    started_at TIMESTAMP DEFAULT NOW() NOT NULL,
    ended_at TIMESTAMP,
    duration INTEGER,
    starting_location_id UUID,
    ending_location_id UUID,
    starting_time JSONB,
    ending_time JSONB,
    summary JSONB,
    state_snapshot TEXT,
    player_character_ids JSONB DEFAULT '[]',
    active_npc_ids JSONB DEFAULT '[]',
    created_at TIMESTAMP DEFAULT NOW() NOT NULL
  );`,
  `CREATE INDEX sessions_campaign_idx ON sessions(campaign_id);`,
  `CREATE INDEX sessions_number_idx ON sessions(campaign_id, session_number);`,
  
  // Characters
  `CREATE TABLE characters (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    campaign_id UUID NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
    player_type VARCHAR(20) NOT NULL,
    agent_id UUID,
    name VARCHAR(255) NOT NULL,
    sheet JSONB NOT NULL,
    race VARCHAR(50) NOT NULL,
    class_name VARCHAR(50) NOT NULL,
    level INTEGER NOT NULL DEFAULT 1,
    current_hp INTEGER NOT NULL,
    max_hp INTEGER NOT NULL,
    portrait_url TEXT,
    token_url TEXT,
    is_active BOOLEAN DEFAULT TRUE,
    created_at TIMESTAMP DEFAULT NOW() NOT NULL,
    updated_at TIMESTAMP DEFAULT NOW() NOT NULL
  );`,
  `CREATE INDEX characters_campaign_idx ON characters(campaign_id);`,
  `CREATE INDEX characters_player_type_idx ON characters(player_type);`,
  
  // Character Memories
  `CREATE TABLE character_memories (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    character_id UUID NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
    campaign_id UUID NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
    type VARCHAR(50) NOT NULL,
    content TEXT NOT NULL,
    session_id UUID REFERENCES sessions(id),
    game_time JSONB,
    location_id UUID,
    related_entity_ids JSONB DEFAULT '[]',
    importance INTEGER NOT NULL DEFAULT 5,
    emotional_valence REAL DEFAULT 0,
    embedding_id UUID,
    created_at TIMESTAMP DEFAULT NOW() NOT NULL
  );`,
  `CREATE INDEX char_memories_character_idx ON character_memories(character_id);`,
  `CREATE INDEX char_memories_campaign_idx ON character_memories(campaign_id);`,
  `CREATE INDEX char_memories_importance_idx ON character_memories(importance);`,
  
  // Character Relationships
  `CREATE TABLE character_relationships (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    character_id UUID NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
    target_id UUID NOT NULL,
    target_type VARCHAR(20) NOT NULL,
    target_name VARCHAR(255) NOT NULL,
    disposition INTEGER DEFAULT 0,
    trust INTEGER DEFAULT 50,
    familiarity INTEGER DEFAULT 0,
    significant_interactions JSONB DEFAULT '[]',
    updated_at TIMESTAMP DEFAULT NOW() NOT NULL
  );`,
  `CREATE INDEX char_rel_character_idx ON character_relationships(character_id);`,
  `CREATE INDEX char_rel_target_idx ON character_relationships(target_id);`,
  
  // Locations (before NPCs due to foreign key)
  `CREATE TABLE locations (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    campaign_id UUID NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
    name VARCHAR(255) NOT NULL,
    description TEXT,
    type VARCHAR(50) NOT NULL,
    parent_location_id UUID REFERENCES locations(id),
    child_location_ids JSONB DEFAULT '[]',
    connections JSONB DEFAULT '[]',
    features JSONB DEFAULT '[]',
    ambiance TEXT,
    lighting VARCHAR(50) DEFAULT 'bright',
    tags JSONB DEFAULT '[]',
    npcs JSONB DEFAULT '[]',
    points_of_interest JSONB DEFAULT '[]',
    available_services JSONB DEFAULT '[]',
    danger_level INTEGER DEFAULT 0,
    npc_ids JSONB DEFAULT '[]',
    monster_ids JSONB DEFAULT '[]',
    loot JSONB DEFAULT '[]',
    is_discovered BOOLEAN DEFAULT FALSE,
    visit_count INTEGER DEFAULT 0,
    last_visited TIMESTAMP,
    discovered BOOLEAN DEFAULT FALSE,
    cleared BOOLEAN DEFAULT FALSE,
    notes TEXT,
    battle_map_id UUID,
    image_url TEXT,
    created_at TIMESTAMP DEFAULT NOW() NOT NULL,
    updated_at TIMESTAMP DEFAULT NOW() NOT NULL
  );`,
  `CREATE INDEX locations_campaign_idx ON locations(campaign_id);`,
  `CREATE INDEX locations_parent_idx ON locations(parent_location_id);`,
  `CREATE INDEX locations_type_idx ON locations(type);`,
  
  // Add foreign key to campaigns after locations exists
  `ALTER TABLE campaigns ADD CONSTRAINT campaigns_current_location_fk 
   FOREIGN KEY (current_location_id) REFERENCES locations(id);`,
  
  // Add foreign key to character_memories after locations exists
  `ALTER TABLE character_memories ADD CONSTRAINT char_memories_location_fk 
   FOREIGN KEY (location_id) REFERENCES locations(id);`,
  
  // NPCs
  `CREATE TABLE npcs (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    campaign_id UUID NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
    name VARCHAR(255) NOT NULL,
    type VARCHAR(50) DEFAULT 'neutral',
    race VARCHAR(100),
    occupation VARCHAR(100),
    description TEXT,
    personality TEXT,
    appearance TEXT,
    motivation TEXT,
    faction VARCHAR(100),
    stat_block JSONB,
    current_location_id UUID REFERENCES locations(id),
    party_disposition INTEGER DEFAULT 0,
    disposition JSONB DEFAULT '{}',
    known_information JSONB DEFAULT '[]',
    secrets JSONB DEFAULT '[]',
    greeting TEXT,
    farewell TEXT,
    is_alive BOOLEAN DEFAULT TRUE,
    is_hostile BOOLEAN DEFAULT FALSE,
    interaction_count INTEGER DEFAULT 0,
    last_interaction TIMESTAMP,
    portrait_url TEXT,
    created_at TIMESTAMP DEFAULT NOW() NOT NULL,
    updated_at TIMESTAMP DEFAULT NOW() NOT NULL
  );`,
  `CREATE INDEX npcs_campaign_idx ON npcs(campaign_id);`,
  `CREATE INDEX npcs_location_idx ON npcs(current_location_id);`,
  `CREATE INDEX npcs_type_idx ON npcs(type);`,
  
  // NPC Memories
  `CREATE TABLE npc_memories (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    npc_id UUID NOT NULL REFERENCES npcs(id) ON DELETE CASCADE,
    campaign_id UUID NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
    involved_character_ids JSONB DEFAULT '[]',
    involved_character_names JSONB DEFAULT '[]',
    content TEXT NOT NULL,
    session_id UUID REFERENCES sessions(id),
    game_time JSONB,
    location_id UUID REFERENCES locations(id),
    disposition_change JSONB DEFAULT '{}',
    created_at TIMESTAMP DEFAULT NOW() NOT NULL
  );`,
  `CREATE INDEX npc_memories_npc_idx ON npc_memories(npc_id);`,
  `CREATE INDEX npc_memories_campaign_idx ON npc_memories(campaign_id);`,
  
  // Battle Maps
  `CREATE TABLE battle_maps (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    location_id UUID NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
    campaign_id UUID NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
    name VARCHAR(255) NOT NULL,
    grid_width INTEGER NOT NULL,
    grid_height INTEGER NOT NULL,
    grid_size INTEGER DEFAULT 5,
    background_url TEXT,
    background_color VARCHAR(20) DEFAULT '#2a2a2a',
    show_grid BOOLEAN DEFAULT TRUE,
    grid_color VARCHAR(20) DEFAULT '#444444',
    grid_opacity REAL DEFAULT 0.5,
    grid_data JSONB DEFAULT '{}',
    fog_of_war JSONB DEFAULT '[]',
    markers JSONB DEFAULT '[]',
    created_at TIMESTAMP DEFAULT NOW() NOT NULL,
    updated_at TIMESTAMP DEFAULT NOW() NOT NULL
  );`,
  `CREATE INDEX battle_maps_location_idx ON battle_maps(location_id);`,
  `CREATE INDEX battle_maps_campaign_idx ON battle_maps(campaign_id);`,
  
  // World Events
  `CREATE TABLE world_events (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    campaign_id UUID NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
    session_id UUID REFERENCES sessions(id),
    type VARCHAR(50) NOT NULL,
    description TEXT NOT NULL,
    involved_entity_ids JSONB DEFAULT '[]',
    consequences JSONB DEFAULT '[]',
    location_id UUID REFERENCES locations(id),
    game_time JSONB,
    importance INTEGER DEFAULT 5,
    embedding_id UUID,
    created_at TIMESTAMP DEFAULT NOW() NOT NULL
  );`,
  `CREATE INDEX world_events_campaign_idx ON world_events(campaign_id);`,
  `CREATE INDEX world_events_session_idx ON world_events(session_id);`,
  `CREATE INDEX world_events_location_idx ON world_events(location_id);`,
  `CREATE INDEX world_events_importance_idx ON world_events(importance);`,
  `CREATE INDEX world_events_type_idx ON world_events(type);`,
  
  // Quests
  `CREATE TABLE quests (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    campaign_id UUID NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
    name VARCHAR(255) NOT NULL,
    description TEXT,
    type VARCHAR(50) DEFAULT 'side',
    giver VARCHAR(255),
    location_id UUID REFERENCES locations(id),
    objectives JSONB DEFAULT '[]',
    rewards JSONB DEFAULT '{}',
    status VARCHAR(50) DEFAULT 'available',
    importance INTEGER DEFAULT 5,
    accepted_at TIMESTAMP,
    completed_at TIMESTAMP,
    player_notes TEXT,
    dm_notes TEXT,
    created_at TIMESTAMP DEFAULT NOW() NOT NULL,
    updated_at TIMESTAMP DEFAULT NOW() NOT NULL
  );`,
  `CREATE INDEX quests_campaign_idx ON quests(campaign_id);`,
  `CREATE INDEX quests_status_idx ON quests(status);`,
  `CREATE INDEX quests_location_idx ON quests(location_id);`,
  
  // Items
  `CREATE TABLE items (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    campaign_id UUID NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
    name VARCHAR(255) NOT NULL,
    type VARCHAR(50) NOT NULL,
    rarity VARCHAR(50) DEFAULT 'common',
    description TEXT,
    properties JSONB DEFAULT '{}',
    weight REAL DEFAULT 0,
    value INTEGER DEFAULT 0,
    owner_id UUID,
    owner_type VARCHAR(50),
    equipped BOOLEAN DEFAULT FALSE,
    attuned BOOLEAN DEFAULT FALSE,
    created_at TIMESTAMP DEFAULT NOW() NOT NULL,
    updated_at TIMESTAMP DEFAULT NOW() NOT NULL
  );`,
  `CREATE INDEX items_campaign_idx ON items(campaign_id);`,
  `CREATE INDEX items_owner_idx ON items(owner_id);`,
  `CREATE INDEX items_type_idx ON items(type);`,
  
  // Embeddings
  `CREATE TABLE embeddings (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    campaign_id UUID NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
    entity_type VARCHAR(50) NOT NULL,
    entity_id UUID NOT NULL,
    content TEXT NOT NULL,
    embedding JSONB,
    created_at TIMESTAMP DEFAULT NOW() NOT NULL
  );`,
  `CREATE INDEX embeddings_campaign_idx ON embeddings(campaign_id);`,
  `CREATE INDEX embeddings_entity_idx ON embeddings(entity_type, entity_id);`,
  
  // Combat Logs
  `CREATE TABLE combat_logs (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    campaign_id UUID NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
    session_id UUID NOT NULL REFERENCES sessions(id),
    encounter_id UUID NOT NULL,
    round_number INTEGER NOT NULL,
    turn_order INTEGER NOT NULL,
    actor_id UUID NOT NULL,
    actor_name VARCHAR(255) NOT NULL,
    action_type VARCHAR(50) NOT NULL,
    action_description TEXT NOT NULL,
    target_ids JSONB DEFAULT '[]',
    dice_rolls JSONB DEFAULT '[]',
    damage INTEGER,
    healing INTEGER,
    outcome TEXT,
    game_time JSONB,
    created_at TIMESTAMP DEFAULT NOW() NOT NULL
  );`,
  `CREATE INDEX combat_logs_campaign_idx ON combat_logs(campaign_id);`,
  `CREATE INDEX combat_logs_session_idx ON combat_logs(session_id);`,
  `CREATE INDEX combat_logs_encounter_idx ON combat_logs(encounter_id);`,
];

async function migrate(): Promise<void> {
  const config = getDatabaseConfig();
  
  console.log(`Connecting to database ${config.host}:${config.port}/${config.database}...`);
  
  const pool = new Pool({
    host: config.host,
    port: config.port,
    database: config.database,
    user: config.user,
    password: config.password,
    ssl: config.ssl ? { rejectUnauthorized: false } : undefined,
  });
  
  const client = await pool.connect();
  
  try {
    console.log('Running migrations...');
    
    for (let i = 0; i < MIGRATIONS.length; i++) {
      const sql = MIGRATIONS[i];
      const preview = sql.substring(0, 60).replace(/\n/g, ' ');
      console.log(`  [${i + 1}/${MIGRATIONS.length}] ${preview}...`);
      await client.query(sql);
    }
    
    console.log('Migrations completed successfully!');
  } catch (error) {
    console.error('Migration failed:', error);
    throw error;
  } finally {
    client.release();
    await pool.end();
  }
}

// Run migrations if executed directly
if (import.meta.main) {
  migrate().catch((error) => {
    console.error('Migration error:', error);
    process.exit(1);
  });
}

export { migrate };
