/**
 * Database operations tests for AgentServer
 */

import { describe, it, expect, beforeEach, afterEach, jest, mock } from 'bun:test';
import { AgentServer } from '../index';
import type { UUID, ChannelType } from '@elizaos/core';

// Mock logger to avoid console output during tests
mock.module('@elizaos/core', () => ({
  logger: {
    warn: jest.fn(),
    info: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
    success: jest.fn(),
  },
  ChannelType: {
    DIRECT: 'direct',
    GROUP: 'group',
  },
}));

// Mock database adapter
mock.module('@elizaos/plugin-sql', () => ({
  default: { name: 'sql', description: 'SQL plugin', adapter: {} },
  createDatabaseAdapter: jest.fn(() => ({
    init: jest.fn().mockResolvedValue(undefined),
    close: jest.fn().mockResolvedValue(undefined),
    getDatabase: jest.fn(() => ({
      execute: jest.fn().mockResolvedValue([]),
    })),
    getMessageServers: jest.fn()
      .mockResolvedValueOnce([])
      .mockResolvedValue([{ id: '00000000-0000-0000-0000-000000000000', name: 'Default Server' }]),
    createMessageServer: jest.fn().mockResolvedValue({ id: '00000000-0000-0000-0000-000000000000' }),
    getMessageServerById: jest.fn().mockResolvedValue({ id: '00000000-0000-0000-0000-000000000000', name: 'Default Server' }),
    addAgentToServer: jest.fn().mockResolvedValue(undefined),
    getChannelsForServer: jest.fn().mockResolvedValue([]),
    createChannel: jest.fn().mockResolvedValue({ id: '123e4567-e89b-12d3-a456-426614174000' }),
    getAgentsForServer: jest.fn().mockResolvedValue([]),
    db: { execute: jest.fn().mockResolvedValue([]) },
  })),
  DatabaseMigrationService: jest.fn(() => ({
    initializeWithDatabase: jest.fn().mockResolvedValue(undefined),
    discoverAndRegisterPluginSchemas: jest.fn(),
    runAllPluginMigrations: jest.fn().mockResolvedValue(undefined),
  })),
  plugin: {},
}));

describe('AgentServer Database Operations Tests', () => {
  let server: AgentServer;

  beforeEach(async () => {
    server = new AgentServer();
    await server.initialize();

    // Mock database methods
    server.database = {
      ...server.database,
      createMessageServer: jest.fn().mockResolvedValue({ id: 'server-id', name: 'Test Server' }),
      getMessageServers: jest.fn()
      .mockResolvedValueOnce([])
      .mockResolvedValue([{ id: '00000000-0000-0000-0000-000000000000', name: 'Default Server' }]),
      getMessageServerById: jest.fn().mockResolvedValue({ id: 'server-id' }),
      createChannel: jest.fn().mockResolvedValue({ id: 'channel-id' }),
      getChannelsForServer: jest.fn().mockResolvedValue([]),
      createMessage: jest.fn().mockResolvedValue({ id: 'message-id' }),
      getMessagesForChannel: jest.fn().mockResolvedValue([]),
      addAgentToServer: jest.fn().mockResolvedValue(undefined),
      getAgentsForServer: jest.fn().mockResolvedValue([]),
    } as any;
  });

  afterEach(async () => {
    if (server) {
      await server.stop().catch(() => {});
      server = null as any;
    }
  });

  it('should create server', async () => {
    const serverData = { name: 'Test Server', sourceType: 'test' };

    const result = await server.createServer(serverData);

    expect((server.database as any).createMessageServer).toHaveBeenCalledWith(serverData);
    expect(result).toEqual({
      id: 'server-id',
      name: 'Test Server',
    });
  });

  it('should get servers', async () => {
    await server.getServers();

    expect((server.database as any).getMessageServers).toHaveBeenCalled();
  });

  it('should create channel', async () => {
    const channelData = {
      name: 'Test Channel',
      messageServerId: 'server-id' as UUID,
      type: 'group' as ChannelType,
    };

    const result = await server.createChannel(channelData);

    expect((server.database as any).createChannel).toHaveBeenCalledWith(channelData, undefined);
    expect(result).toEqual({
      id: 'channel-id',
    });
  });

  it('should add agent to server', async () => {
    const serverId = 'server-id' as any;
    const agentId = 'agent-id' as any;

    await server.addAgentToServer(serverId, agentId);

    expect((server.database as any).getMessageServerById).toHaveBeenCalledWith(serverId);
    expect((server.database as any).addAgentToServer).toHaveBeenCalledWith(serverId, agentId);
  });

  it('should throw error when adding agent to non-existent server', async () => {
    (server.database as any).getMessageServerById = jest.fn().mockResolvedValue(null);

    const serverId = 'non-existent-server' as any;
    const agentId = 'agent-id' as any;

    await expect(server.addAgentToServer(serverId, agentId)).rejects.toThrow(
      'Server non-existent-server not found'
    );
  });
});