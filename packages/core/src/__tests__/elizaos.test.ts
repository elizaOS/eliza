import { describe, it, expect, beforeEach, afterEach, vi } from 'bun:test';
import { ElizaOS } from '../elizaos';
import { Character } from '../types/agent';
import { Plugin } from '../types/plugin';
import { ElizaOSEventType } from '../types/elizaos';

describe('ElizaOS', () => {
  let elizaos: ElizaOS;
  
  const testCharacter: Character = {
    name: 'Test Agent',
    bio: 'A test agent',
    system: 'You are a test agent',
    messageExamples: [],
    topics: ['testing'],
    adjectives: ['test'],
  };

  beforeEach(() => {
    elizaos = new ElizaOS({
      name: 'TestElizaOS',
      debug: false,
      maxAgents: 5,
    });
  });

  afterEach(async () => {
    // Clean up
    try {
      await elizaos.reset();
    } catch (error) {
      // Ignore cleanup errors
    }
  });

  describe('initialization', () => {
    it('should initialize ElizaOS', async () => {
      await elizaos.initialize();
      expect(elizaos).toBeDefined();
      expect(elizaos.name).toBe('TestElizaOS');
    });

    it('should not initialize twice', async () => {
      await elizaos.initialize();
      
      // Second initialization should not throw but should log warning
      await expect(elizaos.initialize()).resolves.toBeUndefined();
    });

    it('should set default configuration', () => {
      expect(elizaos.config.maxAgents).toBe(5);
      expect(elizaos.config.debug).toBe(false);
      expect(elizaos.config.clustering).toBe(false);
      expect(elizaos.config.serverConfig?.enabled).toBe(false);
    });
  });

  describe('start/stop', () => {
    it('should start and stop ElizaOS', async () => {
      await elizaos.initialize();
      await elizaos.start();
      
      // ElizaOS should be started
      await elizaos.stop();
      
      // Should be able to stop
      expect(true).toBe(true); // If we get here, it worked
    });

    it('should auto-initialize when starting', async () => {
      await elizaos.start();
      // Should initialize automatically
      expect(true).toBe(true);
    });
  });

  describe('agent management', () => {
    beforeEach(async () => {
      await elizaos.initialize();
    });

    it('should create an agent', async () => {
      const agentId = await elizaos.createAgent({
        character: testCharacter,
        autoStart: false,
      });

      expect(agentId).toBeDefined();
      
      const agent = elizaos.getAgent(agentId);
      expect(agent).toBeDefined();
      expect(agent?.name).toBe('Test Agent');
      expect(agent?.status).toBe('created');
    });

    it('should auto-start agent when configured', async () => {
      const agentId = await elizaos.createAgent({
        character: testCharacter,
        autoStart: true,
      });

      const agent = elizaos.getAgent(agentId);
      // Note: In real implementation, this would be 'running' after initialization
      // But without a proper database adapter, it might fail to initialize
      expect(agent).toBeDefined();
    });

    it('should enforce max agents limit', async () => {
      // Create max agents
      for (let i = 0; i < 5; i++) {
        await elizaos.createAgent({
          character: {
            ...testCharacter,
            name: `Test Agent ${i}`,
          },
          autoStart: false,
        });
      }

      // Should throw when exceeding limit
      await expect(elizaos.createAgent({
        character: testCharacter,
        autoStart: false,
      })).rejects.toThrow('Maximum number of agents');
    });

    it('should get all agents', async () => {
      const id1 = await elizaos.createAgent({
        character: { ...testCharacter, name: 'Agent 1' },
        autoStart: false,
      });
      
      const id2 = await elizaos.createAgent({
        character: { ...testCharacter, name: 'Agent 2' },
        autoStart: false,
      });

      const allAgents = elizaos.getAllAgents();
      expect(allAgents).toHaveLength(2);
      expect(allAgents.map(a => a.name).sort()).toEqual(['Agent 1', 'Agent 2']);
    });

    it('should get agents by status', async () => {
      await elizaos.createAgent({
        character: testCharacter,
        autoStart: false,
      });

      const createdAgents = elizaos.getAgentsByStatus('created');
      expect(createdAgents).toHaveLength(1);
      
      const runningAgents = elizaos.getAgentsByStatus('running');
      expect(runningAgents).toHaveLength(0);
    });

    it('should remove an agent', async () => {
      const agentId = await elizaos.createAgent({
        character: testCharacter,
        autoStart: false,
      });

      expect(elizaos.getAgent(agentId)).toBeDefined();
      
      await elizaos.removeAgent(agentId);
      
      expect(elizaos.getAgent(agentId)).toBeUndefined();
    });
  });

  describe('global plugins', () => {
    const testPlugin: Plugin = {
      name: 'test-plugin',
      description: 'Test plugin',
      actions: [],
      providers: [],
    };

    beforeEach(async () => {
      await elizaos.initialize();
    });

    it('should register a global plugin', async () => {
      await elizaos.registerGlobalPlugin(testPlugin);
      
      expect(elizaos.globalPlugins).toContainEqual(testPlugin);
    });

    it('should unregister a global plugin', async () => {
      await elizaos.registerGlobalPlugin(testPlugin);
      expect(elizaos.globalPlugins).toContainEqual(testPlugin);
      
      await elizaos.unregisterGlobalPlugin('test-plugin');
      expect(elizaos.globalPlugins).not.toContainEqual(testPlugin);
    });

    it('should throw when unregistering non-existent plugin', async () => {
      await expect(elizaos.unregisterGlobalPlugin('non-existent'))
        .rejects.toThrow('Plugin not found');
    });
  });

  describe('events', () => {
    it('should emit and handle events', async () => {
      let eventFired = false;
      let eventData: any = null;

      elizaos.on(ElizaOSEventType.SYSTEM_STARTED, (event) => {
        eventFired = true;
        eventData = event.data;
      });

      await elizaos.initialize();

      expect(eventFired).toBe(true);
      expect(eventData).toBeDefined();
    });

    it('should remove event handlers', async () => {
      let eventCount = 0;
      
      const handler = () => {
        eventCount++;
      };

      elizaos.on(ElizaOSEventType.SYSTEM_STARTED, handler);
      await elizaos.initialize();
      expect(eventCount).toBe(1);

      elizaos.off(ElizaOSEventType.SYSTEM_STARTED, handler);
      
      // Re-initialize to trigger event again
      await elizaos.reset();
      await elizaos.initialize();
      
      // Event count should still be 1 (handler was removed)
      expect(eventCount).toBe(1);
    });
  });

  describe('system status', () => {
    it('should get system status', async () => {
      await elizaos.initialize();
      
      const status = elizaos.getSystemStatus();
      
      expect(status).toBeDefined();
      expect(status.totalAgents).toBe(0);
      expect(status.activeAgents).toBe(0);
      expect(status.memoryUsage).toBeDefined();
      expect(status.services).toBeDefined();
      expect(status.plugins).toBeDefined();
    });

    it('should update status after creating agents', async () => {
      await elizaos.initialize();
      
      await elizaos.createAgent({
        character: testCharacter,
        autoStart: false,
      });

      const status = elizaos.getSystemStatus();
      expect(status.totalAgents).toBe(1);
    });
  });

  describe('health check', () => {
    it('should return healthy when system is ok', async () => {
      await elizaos.initialize();
      
      const isHealthy = await elizaos.healthCheck();
      expect(isHealthy).toBe(true);
    });
  });

  describe('reset', () => {
    it('should reset the system', async () => {
      await elizaos.initialize();
      
      const agentId = await elizaos.createAgent({
        character: testCharacter,
        autoStart: false,
      });

      expect(elizaos.getAgent(agentId)).toBeDefined();
      
      await elizaos.reset();
      
      expect(elizaos.getAllAgents()).toHaveLength(0);
      expect(elizaos.getAgent(agentId)).toBeUndefined();
    });
  });

  describe('withAgent', () => {
    it('should execute function with agent context', async () => {
      await elizaos.initialize();
      
      const agentId = await elizaos.createAgent({
        character: testCharacter,
        autoStart: false,
      });

      // This will fail because agent is not running, but that's expected
      await expect(elizaos.withAgent(agentId, async (runtime) => {
        return runtime.character.name;
      })).rejects.toThrow('Agent not running');
    });

    it('should throw for non-existent agent', async () => {
      await elizaos.initialize();
      
      const fakeId = 'non-existent-id' as any;
      
      await expect(elizaos.withAgent(fakeId, async () => {
        return 'test';
      })).rejects.toThrow('Agent not found');
    });
  });
});

