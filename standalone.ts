/**
 * ElizaOS Interactive Chat Interface
 *
 * An interactive command-line chat interface using ElizaOS agents.
 * Similar to AI SDK's streamText but using ElizaOS runtime and plugins.
 *
 * Usage:
 *   OPENAI_API_KEY=your_key bun run standalone.ts
 */

// MUST be set before any imports to suppress ElizaOS logs
process.env.LOG_LEVEL = process.env.LOG_LEVEL || 'fatal';

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
import * as clack from '@clack/prompts';
import 'node:crypto';
import fs from 'node:fs';
import { v4 as uuidv4 } from 'uuid';

/**
 * Wrap text to specified width while preserving word boundaries
 */
function wrapText(text: string, maxWidth: number): string {
  const words = text.split(' ');
  const lines: string[] = [];
  let currentLine = '';

  for (const word of words) {
    if (currentLine.length === 0) {
      currentLine = word;
    } else if (currentLine.length + word.length + 1 <= maxWidth) {
      currentLine += ' ' + word;
    } else {
      lines.push(currentLine);
      currentLine = word;
    }
  }

  if (currentLine.length > 0) {
    lines.push(currentLine);
  }

  return lines.join('\n');
}

async function initializeAgent(): Promise<{
  runtime: AgentRuntime;
  userId: UUID;
  roomId: UUID;
  character: Character;
}> {
  const task = clack.spinner();

  try {
    task.start('Initializing ElizaOS...');

    // Basic env checks
    const openaiKey = process.env.OPENAI_API_KEY || '';
    if (!openaiKey) {
      task.stop('❌ OPENAI_API_KEY is not set');
      process.exit(1);
    }

    // Database setup
    task.message('Setting up database...');
    const postgresUrl = process.env.POSTGRES_URL || '';
    const pgliteDir = process.env.PGLITE_PATH || 'memory://';

    if (!postgresUrl) {
      fs.mkdirSync(pgliteDir, { recursive: true });
    }

    // Character definition
    const character: Character = {
      name: 'Eliza',
      username: 'eliza',
      bio: 'A helpful AI assistant powered by ElizaOS.',
      adjectives: ['helpful', 'friendly', 'knowledgeable'],
    };

    // Initialize database
    task.message('Initializing database...');
    const agentId = stringToUuid(character.name);
    const adapter = createDatabaseAdapter(
      { dataDir: pgliteDir, postgresUrl: postgresUrl || undefined },
      agentId
    );
    await adapter.init();

    task.message('Running migrations...');
    const migrator = new DatabaseMigrationService();
    // @ts-ignore getDatabase is available on the adapter base class
    await migrator.initializeWithDatabase(adapter.getDatabase());
    migrator.discoverAndRegisterPluginSchemas([sqlPlugin]);
    await migrator.runAllPluginMigrations();

    // Create runtime
    task.message('Creating agent runtime...');
    const runtime = new AgentRuntime({
      character,
      plugins: [sqlPlugin, bootstrapPlugin, openaiPlugin],
      settings: {
        OPENAI_API_KEY: openaiKey,
        POSTGRES_URL: postgresUrl || undefined,
        PGLITE_PATH: pgliteDir,
        LOG_LEVEL: 'fatal',
      },
    });

    runtime.registerDatabaseAdapter(adapter);
    await runtime.initialize();

    // Set up conversation context
    task.message('Setting up conversation...');
    const userId = uuidv4() as UUID;
    const worldId = stringToUuid('chat-world');
    const roomId = stringToUuid('chat-room');

    await runtime.ensureConnection({
      entityId: userId,
      roomId,
      worldId,
      name: 'User',
      source: 'cli',
      channelId: 'chat-channel',
      serverId: 'chat-server',
      type: ChannelType.DM,
    });

    task.stop('✅ ElizaOS initialized successfully');
    return { runtime, userId, roomId, character };
  } catch (error) {
    task.stop(`❌ Initialization failed: ${error}`);
    throw error;
  }
}

async function main(): Promise<void> {
  const { runtime, userId, roomId, character } = await initializeAgent();

  clack.intro('🤖 ElizaOS Interactive Chat');
  clack.note(
    `Ready to chat with ${character.name}!`,
    'Type your messages below. Use Ctrl+C or type "quit"/"exit" to end.'
  );

  while (true) {
    const userInput = await clack.text({
      message: 'You:',
      placeholder: 'Type your message here...',
    });

    if (clack.isCancel(userInput) || userInput === 'quit' || userInput === 'exit') {
      clack.outro('Thanks for chatting! 👋');
      break;
    }

    // Create message memory
    const message: Memory = createMessageMemory({
      id: uuidv4() as UUID,
      entityId: userId,
      roomId,
      content: {
        text: userInput,
        source: 'cli',
        channelType: ChannelType.DM,
      },
    });

    // Show thinking spinner and track time
    const spinner = clack.spinner();
    const startTime = Date.now();
    spinner.start(`${character.name} is thinking...`);

    // Process message and collect response
    let response = '';

    try {
      await runtime.emitEvent(EventType.MESSAGE_RECEIVED, {
        runtime,
        message,
        callback: async (content: Content) => {
          if (content?.text) {
            response += content.text;
          }
        },
      });
    } finally {
      // Calculate thinking time and stop spinner
      const endTime = Date.now();
      const thinkingTimeMs = endTime - startTime;
      const thinkingTimeSec = (thinkingTimeMs / 1000).toFixed(1);

      spinner.stop(`Thought for ${thinkingTimeSec} seconds`);
    }

    if (response) {
      // Wrap long text for better readability
      const wrappedResponse = wrapText(response, 80);
      clack.note(wrappedResponse, `${character.name}:`);
    }
  }

  await runtime.stop();
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
