import {
  createUniqueUuid,
  type IAgentRuntime,
  type Memory,
  type UUID,
} from '@elizaos/core';
import type { Message } from '@telegraf/types';
import type { Context, Telegraf } from 'telegraf';
import { describe, expect, it, vi } from 'vitest';
import { MessageManager } from '../src/messageManager';

type EnsureConnectionParams = Parameters<IAgentRuntime['ensureConnection']>[0];

describe('MessageManager identity metadata', () => {
  it('stores Telegram sender identity separately from chat identity', async () => {
    const agentId = '00000000-0000-0000-0000-000000000001' as UUID;
    let capturedMemory: Memory | null = null;

    const ensureConnection = vi.fn(
      async (_params: EnsureConnectionParams): Promise<void> => undefined,
    );
    const createMemory = vi.fn(async (memory: Memory): Promise<void> => {
      capturedMemory = memory;
    });
    const handleMessage = vi.fn();

    const runtime = {
      agentId,
      getSetting: vi.fn(() => undefined),
      ensureConnection,
      createMemory,
      messageService: { handleMessage },
    } as IAgentRuntime;

    const bot = {
      telegram: {
        sendMessage: vi.fn(),
      },
    } as unknown as Telegraf<Context>;
    const manager = new MessageManager(bot, runtime);

    const chat: Message.TextMessage['chat'] = {
      id: 999,
      type: 'private',
      first_name: 'Grace',
      username: 'grace_chat',
    };
    const from: Message.TextMessage['from'] = {
      id: 123,
      is_bot: false,
      first_name: 'Grace',
      username: 'grace_tg',
    };
    const message: Message.TextMessage = {
      message_id: 456,
      date: 1710000000,
      chat,
      from,
      text: 'hello from Telegram',
    };
    const ctx = {
      chat,
      from,
      message,
      telegram: {
        sendMessage: vi.fn(),
        sendChatAction: vi.fn(),
      },
    } as unknown as Context;

    await manager.handleMessage(ctx);

    const expectedEntityId = createUniqueUuid(runtime, '123');
    const expectedRoomId = createUniqueUuid(runtime, '999');
    const expectedWorldId = createUniqueUuid(runtime, '999');

    expect(ensureConnection).toHaveBeenCalledWith(
      expect.objectContaining({
        entityId: expectedEntityId,
        roomId: expectedRoomId,
        source: 'telegram',
        channelId: '999',
        userId: '123',
        worldId: expectedWorldId,
      }),
    );

    expect(createMemory).toHaveBeenCalledWith(
      expect.objectContaining({ metadata: expect.any(Object) }),
      'messages',
    );
    expect(handleMessage).not.toHaveBeenCalled();
    expect(capturedMemory).not.toBeNull();
    const memory = capturedMemory;
    if (!memory) {
      throw new Error('MessageManager did not pass a memory to messageService');
    }

    expect(memory.entityId).toBe(expectedEntityId);
    expect(memory.roomId).toBe(expectedRoomId);
    expect(memory.metadata).toMatchObject({
      fromId: '123',
      telegramUserId: '123',
      telegramChatId: '999',
      provider: 'telegram',
      sender: {
        id: '123',
        name: 'Grace',
        username: 'grace_tg',
      },
      telegram: {
        chatId: '999',
        messageId: '456',
      },
    });
  });
});
