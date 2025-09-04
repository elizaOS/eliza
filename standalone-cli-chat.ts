/**
 * ElizaOS Interactive Chat Interface
 *
 * An interactive command-line chat interface using ElizaOS agents.
 * Similar to AI SDK's streamText but using ElizaOS runtime and plugins.
 *
 * Usage:
 *   LOG_LEVEL=fatal OPENAI_API_KEY=your_key bun run standalone.ts
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

// ============================================================================
// CONSTANTS & CONFIGURATION
// ============================================================================

const CONSTANTS = {
  TEXT_WRAP_WIDTH: 80,
  LOG_LEVEL: 'fatal',
  DEFAULT_PGLITE_PATH: 'memory://',
  CHAT_IDENTIFIERS: {
    WORLD: 'chat-world',
    ROOM: 'chat-room',
    CHANNEL: 'chat-channel',
    SERVER: 'chat-server',
    SOURCE: 'cli',
  },
  EXIT_COMMANDS: ['quit', 'exit'],
} as const;

interface AppConfiguration {
  openaiApiKey: string;
  postgresUrl: string;
  pglitePath: string;
}

interface ChatSession {
  runtime: AgentRuntime;
  userId: UUID;
  roomId: UUID;
  worldId: UUID;
  character: Character;
}

interface MessageProcessingResult {
  response: string;
  thinkingTimeMs: number;
}

// ============================================================================
// CONFIGURATION MANAGEMENT
// ============================================================================

class Configuration {
  private static validateEnvironment(): void {
    const openaiKey = process.env.OPENAI_API_KEY;
    if (!openaiKey?.trim()) {
      throw new Error('OPENAI_API_KEY environment variable is required');
    }
  }

  static load(): AppConfiguration {
    this.validateEnvironment();

    return {
      openaiApiKey: process.env.OPENAI_API_KEY!,
      postgresUrl: process.env.POSTGRES_URL || '',
      pglitePath: process.env.PGLITE_PATH || CONSTANTS.DEFAULT_PGLITE_PATH,
    };
  }
}

// ============================================================================
// UTILITY FUNCTIONS
// ============================================================================

class TextUtils {
  static wrapText(text: string, maxWidth: number = CONSTANTS.TEXT_WRAP_WIDTH): string {
    const words = text.split(' ');
    const lines: string[] = [];
    let currentLine = '';

    for (const word of words) {
      if (currentLine.length === 0) {
        currentLine = word;
      } else if (currentLine.length + word.length + 1 <= maxWidth) {
        currentLine += ` ${word}`;
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
}

class TimeUtils {
  static formatThinkingTime(milliseconds: number): string {
    const seconds = (milliseconds / 1000).toFixed(1);
    return `${seconds} seconds`;
  }
}

// ============================================================================
// AGENT INITIALIZATION
// ============================================================================

class AgentInitializer {
  private static createCharacter(): Character {
    return {
      name: 'Eliza',
      username: 'eliza',
      bio: 'A helpful AI assistant powered by ElizaOS.',
      adjectives: ['helpful', 'friendly', 'knowledgeable'],
    };
  }

  private static async setupDatabase(config: AppConfiguration, agentId: UUID): Promise<void> {
    if (!config.postgresUrl && config.pglitePath !== CONSTANTS.DEFAULT_PGLITE_PATH) {
      fs.mkdirSync(config.pglitePath, { recursive: true });
    }

    const adapter = createDatabaseAdapter(
      {
        dataDir: config.pglitePath,
        postgresUrl: config.postgresUrl || undefined,
      },
      agentId
    );

    await adapter.init();

    const migrator = new DatabaseMigrationService();
    // @ts-ignore getDatabase is available on the adapter base class
    await migrator.initializeWithDatabase(adapter.getDatabase());
    migrator.discoverAndRegisterPluginSchemas([sqlPlugin]);
    await migrator.runAllPluginMigrations();

    return adapter;
  }

  private static createRuntime(character: Character, config: AppConfiguration): AgentRuntime {
    return new AgentRuntime({
      character,
      plugins: [sqlPlugin, bootstrapPlugin, openaiPlugin],
      settings: {
        OPENAI_API_KEY: config.openaiApiKey,
        POSTGRES_URL: config.postgresUrl || undefined,
        PGLITE_PATH: config.pglitePath,
      },
    });
  }

  private static async setupConversationContext(runtime: AgentRuntime): Promise<{
    userId: UUID;
    roomId: UUID;
    worldId: UUID;
  }> {
    const userId = uuidv4() as UUID;
    const worldId = stringToUuid(CONSTANTS.CHAT_IDENTIFIERS.WORLD);
    const roomId = stringToUuid(CONSTANTS.CHAT_IDENTIFIERS.ROOM);

    await runtime.ensureConnection({
      entityId: userId,
      roomId,
      worldId,
      name: 'User',
      source: CONSTANTS.CHAT_IDENTIFIERS.SOURCE,
      channelId: CONSTANTS.CHAT_IDENTIFIERS.CHANNEL,
      serverId: CONSTANTS.CHAT_IDENTIFIERS.SERVER,
      type: ChannelType.DM,
    });

    return { userId, roomId, worldId };
  }

  static async initialize(): Promise<ChatSession> {
    const task = clack.spinner();

    try {
      task.start('Initializing ElizaOS...');

      const config = Configuration.load();
      const character = this.createCharacter();

      task.message('Setting up database...');
      const agentId = stringToUuid(character.name);
      const adapter = await this.setupDatabase(config, agentId);

      task.message('Creating agent runtime...');
      const runtime = this.createRuntime(character, config);
      runtime.registerDatabaseAdapter(adapter);
      await runtime.initialize();

      task.message('Setting up conversation...');
      const { userId, roomId, worldId } = await this.setupConversationContext(runtime);

      task.stop('✅ ElizaOS initialized successfully');

      return {
        runtime,
        userId,
        roomId,
        worldId,
        character,
      };
    } catch (error) {
      task.stop(`❌ Initialization failed: ${error}`);
      throw error;
    }
  }
}

// ============================================================================
// MESSAGE PROCESSING
// ============================================================================

class MessageProcessor {
  constructor(private session: ChatSession) {}

  private createMessageMemory(userInput: string): Memory {
    return createMessageMemory({
      id: uuidv4() as UUID,
      entityId: this.session.userId,
      roomId: this.session.roomId,
      content: {
        text: userInput,
        source: CONSTANTS.CHAT_IDENTIFIERS.SOURCE,
        channelType: ChannelType.DM,
      },
    });
  }

  async processMessage(userInput: string): Promise<MessageProcessingResult> {
    const message = this.createMessageMemory(userInput);
    const startTime = Date.now();

    let response = '';

    await this.session.runtime.emitEvent(EventType.MESSAGE_RECEIVED, {
      runtime: this.session.runtime,
      message,
      callback: async (content: Content) => {
        if (content?.text) {
          response += content.text;
        }
      },
    });

    const thinkingTimeMs = Date.now() - startTime;

    return {
      response,
      thinkingTimeMs,
    };
  }
}

// ============================================================================
// USER INTERFACE
// ============================================================================

class ChatInterface {
  constructor(
    private messageProcessor: MessageProcessor,
    private character: Character
  ) {}

  private displayWelcome(): void {
    clack.intro('🤖 ElizaOS Interactive Chat');
    clack.note(
      `Ready to chat with ${this.character.name}!`,
      'Type your messages below. Use Ctrl+C or type "quit"/"exit" to end.'
    );
  }

  private async getUserInput(): Promise<string | symbol> {
    return clack.text({
      message: 'You:',
      placeholder: 'Type your message here...',
    });
  }

  private isExitCommand(input: string | symbol): boolean {
    if (clack.isCancel(input)) return true;
    if (typeof input === 'string') {
      return CONSTANTS.EXIT_COMMANDS.includes(input.toLowerCase());
    }
    return false;
  }

  private async displayThinkingAndProcess(userInput: string): Promise<MessageProcessingResult> {
    const spinner = clack.spinner();
    spinner.start(`${this.character.name} is thinking...`);

    try {
      const result = await this.messageProcessor.processMessage(userInput);
      const thinkingTime = TimeUtils.formatThinkingTime(result.thinkingTimeMs);
      spinner.stop(`Thought for ${thinkingTime}`);
      return result;
    } catch (error) {
      spinner.stop('❌ Error processing message');
      throw error;
    }
  }

  private displayResponse(response: string): void {
    if (!response.trim()) return;

    const wrappedResponse = TextUtils.wrapText(response);
    clack.note(wrappedResponse, `${this.character.name}:`);
  }

  async startChatLoop(): Promise<void> {
    this.displayWelcome();

    while (true) {
      try {
        const userInput = await this.getUserInput();

        if (this.isExitCommand(userInput)) {
          clack.outro('Thanks for chatting! 👋');
          break;
        }

        if (typeof userInput === 'string' && userInput.trim()) {
          const result = await this.displayThinkingAndProcess(userInput);
          this.displayResponse(result.response);
        }
      } catch (error) {
        console.error('Error in chat loop:', error);
        clack.note('An error occurred. Please try again.', '❌ Error');
      }
    }
  }
}

// ============================================================================
// APPLICATION ENTRY POINT
// ============================================================================

class StandaloneChatApp {
  static async run(): Promise<void> {
    try {
      const session = await AgentInitializer.initialize();
      const messageProcessor = new MessageProcessor(session);
      const chatInterface = new ChatInterface(messageProcessor, session.character);

      await chatInterface.startChatLoop();
      await session.runtime.stop();
    } catch (error) {
      console.error('Fatal error:', error);
      process.exit(1);
    }
  }
}

// ============================================================================
// MAIN EXECUTION
// ============================================================================

if (import.meta.main) {
  StandaloneChatApp.run().catch((error) => {
    console.error('Unhandled error:', error);
    process.exit(1);
  });
}
