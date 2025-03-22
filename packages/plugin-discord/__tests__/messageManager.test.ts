import type { IAgentRuntime } from '@elizaos/core';
import { ChannelType, Client, Collection } from 'discord.js';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MessageManager } from '../src/messages';

describe('Discord MessageManager', () => {
  let mockRuntime: IAgentRuntime;
  let mockClient: Client;
  let mockDiscordClient: { client: Client; runtime: IAgentRuntime };
  let mockMessage: any;
  let messageManager: MessageManager;

  beforeEach(() => {
    vi.clearAllMocks();

    mockRuntime = {
      character: {
        name: 'TestBot',
        templates: {},
        settings: {
          discord: {
            allowedChannelIds: ['mock-channel-id'],
            shouldIgnoreBotMessages: true,
            shouldIgnoreDirectMessages: true,
            shouldRespondOnlyToMentions: true,
          },
        },
      },
      evaluate: vi.fn(),
      composeState: vi.fn(),
      ensureConnection: vi.fn(),
      getOrCreateUser: vi.fn(),
      messageManager: {
        createMemory: vi.fn(),
        addEmbeddingToMemory: vi.fn(),
      },
      getParticipantUserState: vi.fn().mockResolvedValue('ACTIVE'),
      log: vi.fn(),
      processActions: vi.fn(),
      emitEvent: vi.fn(),
    } as unknown as IAgentRuntime;

    mockClient = new Client({ intents: [] });
    mockClient.user = { id: 'mock-bot-id', username: 'MockBot' } as any;

    mockDiscordClient = { client: mockClient, runtime: mockRuntime };
    messageManager = new MessageManager(mockDiscordClient);
    (messageManager as any).getChannelType = vi.fn().mockResolvedValueOnce(ChannelType.GuildText);

    const guild = {
      fetch: vi.fn().mockReturnValue({
        type: ChannelType.GuildText,
        serverId: 'mock-server-id',
      }),
      members: {
        cache: {
          get: vi.fn().mockReturnValue({ nickname: 'MockBotNickname' }),
        },
      },
    };

    mockMessage = {
      content: 'Hello, MockBot!',
      author: { id: 'mock-user-id', username: 'MockUser', bot: false },
      guild,
      channel: {
        id: 'mock-channel-id',
        type: ChannelType.GuildText,
        send: vi.fn(),
        guild,
        client: { user: mockClient.user },
        permissionsFor: vi.fn().mockReturnValue({ has: vi.fn().mockReturnValue(true) }),
      },
      id: 'mock-message-id',
      createdTimestamp: Date.now(),
      mentions: {
        users: { has: vi.fn().mockReturnValue(true) },
      },
      reference: null,
      attachments: new Collection(),
    };
  });

  it('should process user messages', async () => {
    await messageManager.handleMessage(mockMessage);
    expect(mockRuntime.ensureConnection).toHaveBeenCalled();
  });

  it('should ignore bot messages', async () => {
    mockMessage.author.bot = true;
    await messageManager.handleMessage(mockMessage);
    expect(mockRuntime.ensureConnection).not.toHaveBeenCalled();
  });

  it('should ignore messages from restricted channels', async () => {
    mockMessage.channel.id = 'undefined-channel-id';
    await messageManager.handleMessage(mockMessage);
    expect(mockRuntime.ensureConnection).not.toHaveBeenCalled();
  });

  it('should ignore not mentioned messages', async () => {
    mockMessage.mentions.users.has = vi.fn().mockReturnValue(false);
    await messageManager.handleMessage(mockMessage);
    expect(mockRuntime.ensureConnection).not.toHaveBeenCalled();
  });

  it('should process audio attachments', async () => {
    vi.spyOn(messageManager, 'processMessage').mockResolvedValue({
      processedContent: '',
      attachments: [],
    });

    const mockAttachments = new Collection<string, any>([
      [
        'mock-attachment-id',
        {
          attachment: 'https://www.example.mp3',
          name: 'mock-attachment.mp3',
          contentType: 'audio/mpeg',
        },
      ],
    ]);

    mockMessage.attachments = mockAttachments;
    const processAttachmentsMock = vi.fn().mockResolvedValue([]);

    Object.defineProperty(messageManager, 'attachmentManager', {
      value: { processAttachments: processAttachmentsMock },
      writable: true,
    });

    await messageManager.handleMessage(mockMessage);
    expect(processAttachmentsMock).toHaveBeenCalledWith(mockAttachments);
  });
});
