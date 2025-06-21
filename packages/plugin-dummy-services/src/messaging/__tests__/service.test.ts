/// <reference types="vitest/globals" />
import { describe, expect, it, beforeEach } from 'vitest';
import { DummyMessageService } from '../service';
import { type IAgentRuntime, asUUID } from '@elizaos/core';
import { v4 as uuid } from 'uuid';

describe('DummyMessageService', () => {
  let service: DummyMessageService;
  const mockRuntime = {
    agentId: asUUID(uuid()),
  } as IAgentRuntime;

  beforeEach(async () => {
    service = new DummyMessageService(mockRuntime);
    await service.start();
  });

  it('should initialize with a default channel', async () => {
    const channels = await service.getChannels();
    expect(channels).toHaveLength(1);
    expect(channels[0].name).toBe('Dummy General Channel');
  });

  it('should send and retrieve a message in a channel', async () => {
    const channels = await service.getChannels();
    const channelId = channels[0].id;

    const content = { text: 'Hello, world!' };
    const sentMessage = await service.sendMessage(channelId, content);

    expect(sentMessage).toBeDefined();
    expect(sentMessage.content.text).toBe('Hello, world!');
    expect(sentMessage.roomId).toBe(channelId);

    const messages = await service.getMessages(channelId);
    expect(messages).toHaveLength(1);
    expect(messages[0].id).toBe(sentMessage.id);
  });

  it('should retrieve a limited number of messages', async () => {
    const channels = await service.getChannels();
    const channelId = channels[0].id;

    await service.sendMessage(channelId, { text: 'Message 1' });
    await service.sendMessage(channelId, { text: 'Message 2' });
    await service.sendMessage(channelId, { text: 'Message 3' });

    const messages = await service.getMessages(channelId, 2);
    expect(messages).toHaveLength(2);
    expect(messages[0].content.text).toBe('Message 2');
    expect(messages[1].content.text).toBe('Message 3');
  });

  it('should throw an error when sending to a non-existent channel', async () => {
    const nonExistentChannelId = asUUID(uuid());
    await expect(service.sendMessage(nonExistentChannelId, { text: 'test' })).rejects.toThrow(
      `Channel with id ${nonExistentChannelId} not found.`
    );
  });
});
