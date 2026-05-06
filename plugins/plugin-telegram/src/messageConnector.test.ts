import type { IAgentRuntime } from '@elizaos/core';
import { describe, expect, it, vi } from 'vitest';
import { TelegramService } from './service';

function createRuntime() {
  return {
    agentId: 'agent-1',
    registerMessageConnector: vi.fn(),
    registerSendHandler: vi.fn(),
    logger: { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
    getRoom: vi.fn().mockResolvedValue(null),
    getMemories: vi.fn().mockResolvedValue([]),
    getEntityById: vi.fn().mockResolvedValue(null),
  } as unknown as IAgentRuntime & {
    registerMessageConnector: ReturnType<typeof vi.fn>;
    registerSendHandler: ReturnType<typeof vi.fn>;
  };
}

function createTelegramService(
  overrides: Record<string, unknown>,
): TelegramService {
  return Object.assign(
    Object.create(TelegramService.prototype) as TelegramService,
    overrides,
  );
}

describe('Telegram message connector adapter', () => {
  it('registers connector metadata with chat and thread support', () => {
    const runtime = createRuntime();
    const service = createTelegramService({
      bot: {},
      messageManager: {},
      handleSendMessage: vi.fn(),
      resolveConnectorTargets: vi.fn(),
      listRecentConnectorTargets: vi.fn(),
      listConnectorRooms: vi.fn(),
      getConnectorChatContext: vi.fn(),
      getConnectorUserContext: vi.fn(),
    });

    TelegramService.registerSendHandlers(runtime, service);

    expect(runtime.registerMessageConnector.mock.calls[0][0]).toMatchObject({
      source: 'telegram',
      label: 'Telegram',
      capabilities: expect.arrayContaining([
        'send_message',
        'resolve_targets',
        'chat_context',
        'user_context',
      ]),
      supportedTargetKinds: ['channel', 'group', 'thread', 'user'],
      contexts: ['social', 'connectors'],
    });
  });

  it('parses forum-topic channel IDs for unified sends', async () => {
    const runtime = createRuntime();
    const sendMessage = vi.fn().mockResolvedValue([]);
    const service = createTelegramService({
      bot: {},
      messageManager: { sendMessage },
    });

    await service.handleSendMessage(
      runtime,
      { source: 'telegram', channelId: '-1001234567890-42' },
      { text: 'hello' },
    );

    expect(sendMessage).toHaveBeenCalledWith(
      '-1001234567890',
      { text: 'hello' },
      undefined,
      42,
    );
  });

  it('resolves known chats into connector targets', async () => {
    const runtime = createRuntime();
    const service = createTelegramService({
      runtime,
      bot: null,
      knownChats: new Map([
        [
          '-100123',
          {
            id: -100123,
            type: 'supergroup',
            title: 'Ops Room',
            is_forum: true,
          },
        ],
      ]),
    });

    const targets = await service.resolveConnectorTargets('ops', { runtime });

    expect(targets[0]).toMatchObject({
      label: 'Ops Room',
      kind: 'group',
      target: { source: 'telegram', channelId: '-100123' },
    });
  });
});
