#!/usr/bin/env node

import Database from 'better-sqlite3';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { logger } from '@elizaos/core';

async function runMigration() {
  try {
    // Check if running from CLI package directory
    const centralDbPath = './eliza-central.db';

    if (!fs.existsSync(centralDbPath)) {
      logger.error('Central database not found at', centralDbPath);
      logger.error(
        'Please run this script from the CLI package directory or where your central database is located.'
      );
      process.exit(1);
    }

    logger.info('Connecting to central database...');
    const db = new Database(centralDbPath);

    logger.info('Running server_agents table migration...');

    const migrationSQL = `
      -- Add server_agents association table
      CREATE TABLE IF NOT EXISTS server_agents (
          server_id TEXT NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
          agent_id TEXT NOT NULL,
          PRIMARY KEY (server_id, agent_id)
      );

      -- Create indexes for performance
      CREATE INDEX IF NOT EXISTS idx_server_agents_server_id ON server_agents(server_id);
      CREATE INDEX IF NOT EXISTS idx_server_agents_agent_id ON server_agents(agent_id);
    `;

    db.exec(migrationSQL);

    logger.success('Migration completed successfully!');
    logger.info('The server_agents table has been created.');
    logger.info('You can now manage server-agent associations through the UI.');

    db.close();
    process.exit(0);
  } catch (error) {
    logger.error('Migration failed:', error);
    process.exit(1);
  }
}

runMigration();
