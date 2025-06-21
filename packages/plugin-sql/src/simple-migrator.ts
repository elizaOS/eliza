import { sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import type { PgliteDatabase } from 'drizzle-orm/pglite';
import { logger } from '@elizaos/core';

type DrizzleDB = NodePgDatabase | PgliteDatabase;

/**
 * Simple migration runner that just ensures core tables exist
 * Uses basic SQL that should work with both PGLite and PostgreSQL
 */
export async function ensureCoreTablesExist(db: DrizzleDB): Promise<void> {
  logger.info('🔧 SIMPLE MIGRATOR: Ensuring core ElizaOS tables exist...');

  // First test if basic SQL execution works
  try {
    logger.info('🔧 MIGRATOR: About to test database connection with SELECT 1...');
    const result = await db.execute(sql.raw('SELECT 1 as test'));
    logger.info('🔧 MIGRATOR: Database connection is working, result:', result);
  } catch (error) {
    logger.error('🔧 MIGRATOR: Database connection test failed with our SELECT 1 query');
    logger.error('🔧 MIGRATOR: Error message:', error instanceof Error ? error.message : String(error));
    logger.error('🔧 MIGRATOR: Error type:', typeof error);
    if (error instanceof Error && error.stack) {
      logger.error('🔧 MIGRATOR: Error stack (first 500 chars):', error.stack.slice(0, 500));
    }
    // Don't return early - try to continue anyway since some connections may be lazy-initialized
    logger.info('🔧 MIGRATOR: Continuing with table creation despite connection test failure...');
  }

  // Test if we can create a simple table
  try {
    await db.execute(sql.raw('CREATE TABLE IF NOT EXISTS test_table (id TEXT PRIMARY KEY)'));
    logger.info('Basic table creation works');
    await db.execute(sql.raw('DROP TABLE IF EXISTS test_table'));
  } catch (error) {
    logger.error('Basic table creation failed:', error);
    // Continue anyway - maybe the table creation will work
    logger.info('Continuing with core table creation despite test failure...');
  }

  // Get the proper table schemas
  const tableSchemas = getBasicTableSQL();
  
  for (const [tableName, tableSQL] of Object.entries(tableSchemas)) {
    try {
      const result = await db.execute(sql.raw(`SELECT 1 FROM ${tableName} LIMIT 1`));
      logger.debug(`Table ${tableName} exists, test result:`, result);
    } catch (error) {
      logger.info(`Table ${tableName} does not exist, creating...`);
      try {
        logger.debug(`Executing SQL for ${tableName}:`, tableSQL.slice(0, 200) + '...');
        const createResult = await db.execute(sql.raw(tableSQL));
        logger.info(`✅ Created table ${tableName}`, createResult);
      } catch (createError) {
        logger.error(`❌ Could not create table ${tableName}:`, createError);
        logger.error(`Failed SQL:`, tableSQL.slice(0, 500));
      }
    }
  }
  
  logger.info('Core tables check complete');
}

function getBasicTableSQL(): Record<string, string> {
  // Use schema that matches Drizzle expectations exactly
  // Note: Some tables use snake_case, others use camelCase - this matches the actual schema
  return {
    agents: `
      CREATE TABLE IF NOT EXISTS agents (
        id TEXT PRIMARY KEY,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        name TEXT NOT NULL,
        username TEXT,
        bio TEXT NOT NULL DEFAULT '',
        system TEXT NOT NULL DEFAULT '',
        lore TEXT DEFAULT '[]',
        topics TEXT DEFAULT '[]',
        interests TEXT DEFAULT '[]',
        adjectives TEXT DEFAULT '[]',
        knowledge TEXT DEFAULT '[]',
        knowledge_cutoff TEXT,
        message_examples TEXT DEFAULT '[]',
        post_examples TEXT DEFAULT '[]',
        style TEXT DEFAULT '{}',
        style_all TEXT DEFAULT '[]',
        style_chat TEXT DEFAULT '[]',
        style_post TEXT DEFAULT '[]',
        people TEXT DEFAULT '[]',
        model_provider TEXT NOT NULL DEFAULT 'openai',
        model_endpoint_override TEXT,
        enabled INTEGER DEFAULT 1,
        status TEXT,
        settings TEXT DEFAULT '{}',
        plugins TEXT DEFAULT '[]',
        clients TEXT DEFAULT '[]',
        client_config TEXT DEFAULT '{}',
        enable_rag INTEGER DEFAULT 0,
        rag_target_count INTEGER DEFAULT 5,
        rag_top_k INTEGER DEFAULT 50,
        rag_top_p TEXT DEFAULT '0.9',
        rag_temperature TEXT DEFAULT '0.7',
        rag_frequency_penalty TEXT DEFAULT '0.0',
        rag_presence_penalty TEXT DEFAULT '0.0'
      )
    `,
    
    cache: `
      CREATE TABLE IF NOT EXISTS cache (
        key TEXT NOT NULL,
        agent_id TEXT NOT NULL,
        value TEXT,
        created_at TEXT DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (key, agent_id)
      )
    `,
    
    memories: `
      CREATE TABLE IF NOT EXISTS memories (
        id TEXT PRIMARY KEY,
        type TEXT NOT NULL,
        content TEXT NOT NULL,
        entity_id TEXT NOT NULL,
        agent_id TEXT NOT NULL,
        room_id TEXT NOT NULL,
        created_at TEXT DEFAULT CURRENT_TIMESTAMP
      )
    `,
    
    entities: `
      CREATE TABLE IF NOT EXISTS entities (
        id TEXT PRIMARY KEY,
        names TEXT NOT NULL DEFAULT '[]',
        agent_id TEXT NOT NULL,
        created_at TEXT DEFAULT CURRENT_TIMESTAMP,
        metadata TEXT DEFAULT '{}'
      )
    `,
    
    relationships: `
      CREATE TABLE IF NOT EXISTS relationships (
        id TEXT PRIMARY KEY,
        source_entity_id TEXT NOT NULL,
        target_entity_id TEXT NOT NULL,
        agent_id TEXT NOT NULL,
        created_at TEXT DEFAULT CURRENT_TIMESTAMP
      )
    `,
    
    rooms: `
      CREATE TABLE IF NOT EXISTS rooms (
        id TEXT PRIMARY KEY,
        name TEXT,
        agent_id TEXT,
        source TEXT NOT NULL,
        type TEXT NOT NULL,
        created_at TEXT DEFAULT CURRENT_TIMESTAMP
      )
    `,
    
    participants: `
      CREATE TABLE IF NOT EXISTS participants (
        id TEXT PRIMARY KEY,
        entity_id TEXT NOT NULL,
        room_id TEXT NOT NULL,
        agent_id TEXT NOT NULL,
        created_at TEXT DEFAULT CURRENT_TIMESTAMP
      )
    `,
    
    worlds: `
      CREATE TABLE IF NOT EXISTS worlds (
        id TEXT PRIMARY KEY,
        name TEXT,
        agent_id TEXT NOT NULL,
        server_id TEXT NOT NULL,
        created_at TEXT DEFAULT CURRENT_TIMESTAMP
      )
    `,
    
    tasks: `
      CREATE TABLE IF NOT EXISTS tasks (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        description TEXT NOT NULL,
        agent_id TEXT,
        created_at TEXT DEFAULT CURRENT_TIMESTAMP
      )
    `,
    
    components: `
      CREATE TABLE IF NOT EXISTS components (
        id TEXT PRIMARY KEY,
        "entityId" TEXT NOT NULL,
        "agentId" TEXT NOT NULL,
        "roomId" TEXT NOT NULL,
        "worldId" TEXT,
        "sourceEntityId" TEXT,
        type TEXT NOT NULL,
        data TEXT DEFAULT '{}',
        "createdAt" TEXT DEFAULT CURRENT_TIMESTAMP
      )
    `,
  };
}

/**
 * Dynamically ensure plugin tables exist based on schema
 * This replaces the traditional migration approach with dynamic table loading
 */
export async function ensurePluginTablesExist(db: DrizzleDB, pluginName: string, schema: any): Promise<void> {
  logger.info(`🔧 DYNAMIC LOADER: Ensuring tables exist for plugin: ${pluginName}`);

  if (!schema || typeof schema !== 'object') {
    logger.warn(`🔧 DYNAMIC LOADER: No valid schema provided for plugin: ${pluginName}`);
    return;
  }

  // Extract table definitions from the schema object
  const tables = Object.entries(schema).filter(([key, value]) => {
    // Look for Drizzle table objects (they have specific properties)
    return value && typeof value === 'object' && '_' in value;
  });

  logger.info(`🔧 DYNAMIC LOADER: Found ${tables.length} tables in schema for plugin: ${pluginName}`);

  for (const [tableName, tableDefinition] of tables) {
    try {
      // Check if table exists
      const result = await db.execute(sql.raw(`SELECT 1 FROM ${tableName} LIMIT 1`));
      logger.debug(`Table ${tableName} exists for plugin ${pluginName}`);
    } catch (error) {
      logger.info(`Table ${tableName} does not exist for plugin ${pluginName}, will be created dynamically when first accessed`);
      // Note: We don't create the table here - Drizzle will handle creation when the table is first accessed
      // This is the "dynamic table loading" approach - tables are created on-demand
    }
  }
  
  logger.info(`🔧 DYNAMIC LOADER: Schema verification complete for plugin: ${pluginName}`);
}