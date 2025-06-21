import {
  type IAgentRuntime,
  type Content,
  type UUID,
  Service,
  logger,
  type Room,
  type Memory,
  asUUID,
  ChannelType,
} from '@elizaos/core';
import { v4 as uuid } from 'uuid';

// Based on example_highlevel_services/tests/messaging-service.test.ts
export interface IMessageService extends Service {
  sendMessage(channelId: UUID, content: Content): Promise<Memory>;
  getMessages(channelId: UUID, limit?: number): Promise<Memory[]>;
  getChannels(): Promise<Room[]>;
}

export class DummyMessageService extends Service implements IMessageService {
  static readonly serviceName = 'MESSAGE';
  static readonly serviceType = 'message';
  readonly capabilityDescription = 'Provides a dummy messaging service for testing.';

  private channels: Map<string, Room> = new Map();
  private messages: Map<string, Memory[]> = new Map();

  constructor(runtime?: IAgentRuntime) {
    super(runtime);
    const channelId = asUUID(uuid());
    this.channels.set(channelId, {
      id: channelId,
      name: 'Dummy General Channel',
      type: ChannelType.GROUP,
      source: 'dummy-message',
      worldId: asUUID(uuid()),
      serverId: 'dummy-server',
    });
    this.messages.set(channelId, []);
    logger.info('DummyMessageService initialized');
  }

  async sendMessage(channelId: UUID, content: Content): Promise<Memory> {
    const channelMessages = this.messages.get(channelId);
    if (!this.channels.has(channelId) || !channelMessages) {
      throw new Error(`Channel with id ${channelId} not found.`);
    }

    const message: Memory = {
      id: asUUID(uuid()),
      agentId: this.runtime.agentId,
      content,
      createdAt: Date.now(),
      roomId: channelId,
      entityId: this.runtime.agentId, // Sent by the agent
    };
    channelMessages.push(message);
    logger.debug(`[DummyMessageService] Sent message to ${channelId}:`, content);
    return message;
  }

  async getMessages(channelId: UUID, limit?: number): Promise<Memory[]> {
    const channelMessages = this.messages.get(channelId);
    if (!channelMessages) {
      throw new Error(`Channel with id ${channelId} not found.`);
    }
    return limit ? channelMessages.slice(-limit) : channelMessages;
  }

  async getChannels(): Promise<Room[]> {
    return Array.from(this.channels.values());
  }

  static async start(runtime: IAgentRuntime): Promise<DummyMessageService> {
    const service = new DummyMessageService(runtime);
    return service;
  }

  static async stop(runtime: IAgentRuntime): Promise<void> {
    const service = runtime.getService<DummyMessageService>(DummyMessageService.serviceType);
    if (service) {
      await service.stop();
    }
  }

  async start(): Promise<void> {
    logger.info(`[${this.serviceName}] Service started.`);
  }

  async stop(): Promise<void> {
    logger.info(`[${this.serviceName}] Service stopped.`);
  }
}
