/**
 * ElizaOS Standalone Agent Runner
 *
 * This file demonstrates how to create and run a minimal ElizaOS agent outside of the
 * full CLI/server infrastructure. It's useful for:
 *
 * - Learning the core ElizaOS agent lifecycle and architecture
 * - Testing agent behaviors in isolation
 * - Integrating ElizaOS agents into custom applications
 * - Development and debugging without HTTP server overhead
 *
 * Quick Start:
 *   bun run standalone.ts
 *
 * Key Differences from Full Setup:
 * - No HTTP API server or web GUI
 * - No multi-agent orchestration
 * - Minimal plugin set (SQL, Bootstrap, OpenAI)
 * - Direct message processing via events
 * - Single conversation simulation
 *
 * Prerequisites:
 * - OPENAI_API_KEY environment variable
 * - Optional: POSTGRES_URL (defaults to in-memory PGLite)
 * - Optional: PGLITE_PATH (defaults to memory://)
 *
 * Usage:
 *   OPENAI_API_KEY=your_key bun run standalone.ts
 *   # or with Postgres:
 *   OPENAI_API_KEY=your_key POSTGRES_URL=postgresql://... bun run standalone.ts
 *
 * Architecture Flow:
 * 1. Initialize database adapter and run migrations
 * 2. Create AgentRuntime with core plugins
 * 3. Set up world/room/user mappings for conversation context
 * 4. Simulate a user message and process agent response
 * 5. Clean shutdown
 */

import {
  AgentRuntime,
  ChannelType,
  EventType,
  createMessageMemory,
  stringToUuid,
  type Character,
  type Content,
  type Memory,
  type UUID,
} from '@elizaos/core';
import bootstrapPlugin from '@elizaos/plugin-bootstrap';
import openaiPlugin from '@elizaos/plugin-openai';
import sqlPlugin, { DatabaseMigrationService, createDatabaseAdapter } from '@elizaos/plugin-sql';
import 'node:crypto';
import fs from 'node:fs';
import { v4 as uuidv4 } from 'uuid';

async function main(): Promise<void> {
  // Basic env checks
  const openaiKey = process.env.OPENAI_API_KEY || '';
  if (!openaiKey) {
    console.error(
      'OPENAI_API_KEY is not set; set it in your environment to use @elizaos/plugin-openai.'
    );
    process.exit(1);
  }

  // Database selection: prefer POSTGRES_URL if set, else PGLite at ./.eliza/.elizadb
  const postgresUrl = process.env.POSTGRES_URL || '';
  const pgliteDir = process.env.PGLITE_PATH || 'memory://';

  // Ensure local data directory exists for PGLite
  if (!postgresUrl) {
    fs.mkdirSync(pgliteDir, { recursive: true });
  }

  // Character definition
  const character: Character = {
    name: 'StandaloneAgent',
    username: 'standalone',
    bio: 'An ElizaOS agent running without the HTTP server.',
    adjectives: ['helpful', 'concise'],
  };

  // Pre-create DB adapter and run migrations (server usually does this)
  const agentId = stringToUuid(character.name);
  const adapter = createDatabaseAdapter(
    { dataDir: pgliteDir, postgresUrl: postgresUrl || undefined },
    agentId
  );
  await adapter.init();

  const migrator = new DatabaseMigrationService();
  // @ts-ignore getDatabase is available on the adapter base class
  await migrator.initializeWithDatabase(adapter.getDatabase());
  migrator.discoverAndRegisterPluginSchemas([sqlPlugin]);
  await migrator.runAllPluginMigrations();

  // Build the runtime with required plugins and settings
  const runtime = new AgentRuntime({
    character,
    plugins: [sqlPlugin, bootstrapPlugin, openaiPlugin],
    settings: {
      OPENAI_API_KEY: openaiKey,
      POSTGRES_URL: postgresUrl || undefined,
      PGLITE_PATH: pgliteDir,
    },
  });

  // Use the prepared adapter so the SQL plugin skips creating a second adapter
  runtime.registerDatabaseAdapter(adapter);
  await runtime.initialize();

  // Ensure a basic DM world/room mapping exists for this conversation
  const userId = uuidv4() as UUID;
  const worldId = stringToUuid('standalone-world');
  const roomId = stringToUuid('standalone-room');

  await runtime.ensureConnection({
    entityId: userId,
    roomId,
    worldId,
    name: 'LocalUser',
    source: 'cli',
    channelId: 'standalone-channel',
    serverId: 'standalone-server',
    type: ChannelType.DM,
  });

  // Compose a test message from the user with proper metadata
  const message: Memory = createMessageMemory({
    id: uuidv4() as UUID,
    entityId: userId,
    roomId,
    content: {
      text: 'Hello! Who are you?',
      source: 'cli',
      channelType: ChannelType.DM,
    },
  });

  console.log('User:', message.content.text);

  // Send the message through the bootstrap message handler and print the response(s)
  await runtime.emitEvent(EventType.MESSAGE_RECEIVED, {
    runtime,
    message,
    callback: async (content: Content) => {
      if (content?.text) {
        console.log(`${character.name}:`, content.text);
      } else if (content?.thought) {
        console.log(`${character.name} (thought):`, content.thought);
      }
    },
  });

  await runtime.stop();
}

main().catch((err) => {
  console.error('Fatal error in standalone runtime:', err);
  process.exit(1);
});
