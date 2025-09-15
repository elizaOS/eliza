/**
 * Agent management tests for AgentServer
 */

import { describe, it, expect, beforeEach, afterEach, jest, mock } from 'bun:test';
import { AgentServer } from '../index';
import type { UUID } from '@elizaos/core';

// Mock logger to avoid console output during tests
mock.module('@elizaos/core', () => ({
  logger: {
    warn: jest.fn(),
    info: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
    success: jest.fn(),
  },
  Service: class MockService {
    constructor() {}
    async initialize() {}
    async cleanup() {}
  },
  createUniqueUuid: jest.fn(() => '123e4567-e89b-12d3-a456-426614174000'),
  ChannelType: {
    DIRECT: 'direct',
    GROUP: 'group',
  },
  EventType: {
    MESSAGE: 'message',
    USER_JOIN: 'user_join',
  },
  SOCKET_MESSAGE_TYPE: {
    MESSAGE: 'message',
    AGENT_UPDATE: 'agent_update',
    CONNECTION: 'connection',
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

describe('AgentServer Agent Management Tests', () => {
  let server: AgentServer;
  let mockRuntime: any;

  beforeEach(async () => {
    server = new AgentServer();
    await server.initialize();

    mockRuntime = {
      agentId: '123e4567-e89b-12d3-a456-426614174000',
      character: { name: 'TestAgent' },
      registerPlugin: jest.fn().mockResolvedValue(undefined),
      stop: jest.fn().mockResolvedValue(undefined),
      plugins: [],
      registerProvider: jest.fn(),
      registerAction: jest.fn(),
    };

    // Mock the database methods
    server.database = {
      ...server.database,
      getMessageServers: jest.fn()
        .mockResolvedValueOnce([])
        .mockResolvedValue([{ id: '00000000-0000-0000-0000-000000000000', name: 'Default Server' }]),
      createMessageServer: jest.fn().mockResolvedValue({ id: 'server-id' }),
      db: {
        execute: jest.fn().mockResolvedValue([]),
      },
      addAgentToServer: jest.fn().mockResolvedValue(undefined),
    } as any;
  });

  afterEach(async () => {
    if (server) {
      await server.stop().catch(() => {});
      server = null as any;
    }
  });

  it('should register agent successfully', async () => {
    // Mock elizaOS.getAgents to return our mock runtime after sync
    server.elizaOS = {
      getAgents: jest.fn().mockReturnValue([mockRuntime])
    } as any;

    await server.registerAgent(mockRuntime);

    const agents = server.getAllAgents();
    const agent = agents.find(a => a.agentId === mockRuntime.agentId);
    expect(agent).toBeDefined();
    expect(agent).toBe(mockRuntime);
    expect(mockRuntime.registerPlugin).toHaveBeenCalled();
  });

  it('should throw error when registering null runtime', async () => {
    await expect(server.registerAgent(null as any)).rejects.toThrow(
      'Attempted to register null/undefined runtime'
    );
  });

  it('should throw error when runtime missing agentId', async () => {
    const invalidRuntime = { character: { name: 'TestAgent' } };
    await expect(server.registerAgent(invalidRuntime as any)).rejects.toThrow(
      'Runtime missing agentId'
    );
  });

  it('should throw error when runtime missing character', async () => {
    const invalidRuntime = { agentId: '123e4567-e89b-12d3-a456-426614174000' };
    await expect(server.registerAgent(invalidRuntime as any)).rejects.toThrow(
      'Runtime missing character configuration'
    );
  });

  it('should unregister agent successfully', async () => {
    // Create a mutable array to track agents
    let mockAgents = [mockRuntime];

    // Mock elizaOS to return current state of mockAgents
    server.elizaOS = {
      getAgents: jest.fn(() => [...mockAgents]),
      getAgent: jest.fn((id) => mockAgents.find(a => a.agentId === id)),
      deleteAgents: jest.fn(async (ids) => {
        // Simulate deletion by removing from mockAgents
        mockAgents = mockAgents.filter(a => !ids.includes(a.agentId));
      }),
      registerAgent: jest.fn((agent) => {
        if (!mockAgents.find(a => a.agentId === agent.agentId)) {
          mockAgents.push(agent);
        }
      })
    } as any;

    await server.registerAgent(mockRuntime);

    let agents = server.getAllAgents();
    expect(agents.find(a => a.agentId === mockRuntime.agentId)).toBeDefined();

    await server.unregisterAgent(mockRuntime.agentId);

    agents = server.getAllAgents();
    expect(agents.find(a => a.agentId === mockRuntime.agentId)).toBeUndefined();
    expect(mockRuntime.stop).toHaveBeenCalled();
  });

  it('should handle unregistering non-existent agent gracefully', async () => {
    const nonExistentId = '999e4567-e89b-12d3-a456-426614174999';

    // Mock elizaOS with empty agents
    server.elizaOS = {
      getAgent: jest.fn().mockReturnValue(undefined),
      deleteAgents: jest.fn().mockResolvedValue(undefined)
    } as any;

    // Should not throw when unregistering non-existent agent
    await server.unregisterAgent(nonExistentId as any);
    expect(true).toBe(true); // Test passes if no error thrown
  });

  it('should handle missing agentId in unregister gracefully', async () => {
    // Mock elizaOS
    server.elizaOS = {
      getAgent: jest.fn().mockReturnValue(undefined),
      deleteAgents: jest.fn().mockResolvedValue(undefined)
    } as any;

    // Should not throw when agentId is null or undefined
    await server.unregisterAgent(null as any);
    await server.unregisterAgent(undefined as any);
    expect(true).toBe(true); // Test passes if no error thrown
  });
});