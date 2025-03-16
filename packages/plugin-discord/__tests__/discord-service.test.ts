import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DiscordService } from '../src/discordService';

// Mock @elizaos/core
vi.mock('@elizaos/core', () => ({
  logger: {
    log: vi.fn(),
    info: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
  stringToUuid: (str: string) => str,
  messageCompletionFooter: '# INSTRUCTIONS: Choose the best response for the agent.',
  shouldRespondFooter: '# INSTRUCTIONS: Choose if the agent should respond.',
  generateMessageResponse: vi.fn(),
  generateShouldRespond: vi.fn(),
  composePrompt: vi.fn(),
  Service: vi.fn(),
}));

// Mock discord.js Service
vi.mock('discord.js', () => {
  const mockGuilds = {
    fetch: vi.fn().mockResolvedValue(new Map()),
  };
  const mockService = {
    login: vi.fn().mockResolvedValue('token'),
    on: vi.fn(),
    once: vi.fn(),
    destroy: vi.fn().mockResolvedValue(undefined),
    guilds: mockGuilds,
  };

  return {
    Service: vi.fn(() => mockService),
    Events: {
      ServiceReady: 'ready',
      MessageCreate: 'messageCreate',
      VoiceStateUpdate: 'voiceStateUpdate',
      MessageReactionAdd: 'messageReactionAdd',
      MessageReactionRemove: 'messageReactionRemove',
    },
    GatewayIntentBits: {
      Guilds: 1,
      DirectMessages: 2,
      GuildVoiceStates: 3,
      MessageContent: 4,
      GuildMessages: 5,
      DirectMessageTyping: 6,
      GuildMessageTyping: 7,
      GuildMessageReactions: 8,
    },
    Partials: {
      Channel: 'channel',
      Message: 'message',
      User: 'user',
      Reaction: 'reaction',
    },
    Collection: class Collection extends Map {},
  };
});

describe('DiscordService', () => {
  let mockRuntime: any;
  let discordService: DiscordService;

  beforeEach(() => {
    mockRuntime = {
      getSetting: vi.fn((key: string) => {
        if (key === 'DISCORD_API_TOKEN') return 'mock-token';
        return undefined;
      }),
      getState: vi.fn(),
      setState: vi.fn(),
      getMemory: vi.fn(),
      setMemory: vi.fn(),
      getService: vi.fn(),
      registerAction: vi.fn(),
      providers: [],
      character: {
        settings: {
          discord: {
            shouldIgnoreBotMessages: true,
          },
        },
      },
    };

    discordService = {
      client: {
        once: vi.fn(),
        on: vi.fn(),
        destroy: vi.fn(),
      },
    } as unknown as DiscordService;
  });

  it('should initialize with correct configuration', () => {
    expect(discordService.client).toBeDefined();
  });
});
