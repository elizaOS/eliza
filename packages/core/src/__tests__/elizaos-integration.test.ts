import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { ElizaOS } from '../elizaos';
import { Character } from '../types/agent';
import { Plugin } from '../types/plugin';
import { Action } from '../types/components';
import { ElizaOSEventType } from '../types/elizaos';
// import { MemoryManager } from '../entities'; // Not implemented yet
import { ModelType } from '../types/model';

/**
 * Integration test for ElizaOS with AgentRuntime
 * 
 * This test verifies that:
 * 1. ElizaOS can create and manage agents with AgentRuntime
 * 2. Agents can access global plugins and services
 * 3. Event system works correctly
 * 4. Agents can interact with each other
 */

describe('ElizaOS Integration with AgentRuntime', () => {
  let elizaos: ElizaOS;
  
  // Test character
  const testCharacter: Character = {
    name: 'Integration Test Agent',
    bio: 'An agent for testing ElizaOS integration',
    system: 'You are a test agent designed to verify ElizaOS functionality',
    messageExamples: [
      [
        { name: 'user', content: { text: 'Hello' } },
        { name: 'Integration Test Agent', content: { text: 'Hello! I am a test agent.' } }
      ]
    ],
    topics: ['testing', 'integration'],
    adjectives: ['test', 'integration'],
  };

  // Test plugin
  const testAction: Action = {
    name: 'test-action',
    description: 'A test action',
    examples: [
      [
        { name: 'user', content: { text: 'run test action' } },
        { name: 'assistant', content: { text: 'Running test action', action: 'test-action' } }
      ]
    ],
    similes: ['test', 'run test'],
    validate: async (_runtime, _message, _state) => true,
    handler: async (runtime, message, state, options, callback) => {
      callback({
        text: 'Test action executed successfully',
        action: 'test-action',
      });
    },
  };

  const testPlugin: Plugin = {
    name: 'test-plugin',
    description: 'A test plugin for integration testing',
    actions: [testAction],
    providers: [],
    services: [],
  };

  beforeEach(() => {
    elizaos = new ElizaOS({
      name: 'TestElizaOS',
      debug: false,
      maxAgents: 5,
      globalPlugins: [testPlugin],
    });
  });

  afterEach(async () => {
    await elizaos.reset();
  });

  describe('System Initialization', () => {
    it('should initialize ElizaOS successfully', async () => {
      await elizaos.initialize();
      
      const status = elizaos.getSystemStatus();
      expect(status).toBeDefined();
      expect(status.totalAgents).toBe(0);
      expect(status.activeAgents).toBe(0);
    });

    it('should register global plugins', async () => {
      await elizaos.initialize();
      
      expect(elizaos.globalPlugins).toHaveLength(1);
      expect(elizaos.globalPlugins[0].name).toBe('test-plugin');
    });
  });

  describe('Agent Management', () => {
    it('should create an agent with AgentRuntime', async () => {
      await elizaos.initialize();
      
      const agentId = await elizaos.createAgent({
        character: testCharacter,
        plugins: [],
      });
      
      expect(agentId).toBeDefined();
      
      const agent = elizaos.getAgent(agentId);
      expect(agent).toBeDefined();
      expect(agent?.name).toBe('Integration Test Agent');
      expect(agent?.status).toBe('created');
    });

    it('should start and stop agents', async () => {
      await elizaos.initialize();
      
      const agentId = await elizaos.createAgent({
        character: testCharacter,
      });
      
      await elizaos.startAgent(agentId);
      let agent = elizaos.getAgent(agentId);
      expect(agent?.status).toBe('running');
      
      await elizaos.stopAgent(agentId);
      agent = elizaos.getAgent(agentId);
      expect(agent?.status).toBe('stopped');
    });

    it('should enforce agent limits', async () => {
      await elizaos.initialize();
      
      // Create max agents
      for (let i = 0; i < 5; i++) {
        await elizaos.createAgent({
          character: {
            ...testCharacter,
            name: `Test Agent ${i}`,
          },
        });
      }
      
      // Try to create one more
      await expect(elizaos.createAgent({
        character: testCharacter,
      })).rejects.toThrow('Maximum number of agents reached');
    });
  });

  describe('Agent Runtime Integration', () => {
    it('should access global plugins from agent runtime', async () => {
      await elizaos.initialize();
      
      const agentId = await elizaos.createAgent({
        character: testCharacter,
      });
      
      await elizaos.startAgent(agentId);
      
      // Execute within agent context
      const result = await elizaos.withAgent(agentId, async (runtime) => {
        // Check if global plugin is available
        const actions = runtime.actions;
        return actions.some(action => action.name === 'test-action');
      });
      
      expect(result).toBe(true);
    });

    // TODO: Re-enable this test when MemoryManager is implemented
    it.skip('should maintain separate memory for each agent', async () => {
      // This test requires MemoryManager implementation
      // await elizaos.initialize();
      // ... test implementation
    });
  });

  describe('Event System', () => {
    it('should emit and handle events', async () => {
      let eventReceived = false;
      let eventData: any = null;
      
      elizaos.on(ElizaOSEventType.AGENT_CREATED, (event) => {
        eventReceived = true;
        eventData = event.data;
      });
      
      await elizaos.initialize();
      
      const agentId = await elizaos.createAgent({
        character: testCharacter,
      });
      
      expect(eventReceived).toBe(true);
      expect(eventData).toBeDefined();
      expect(eventData.agentId).toBe(agentId);
    });

    it('should handle multiple event handlers', async () => {
      let handler1Called = false;
      let handler2Called = false;
      
      const handler1 = () => { handler1Called = true; };
      const handler2 = () => { handler2Called = true; };
      
      elizaos.on(ElizaOSEventType.SYSTEM_STARTED, handler1);
      elizaos.on(ElizaOSEventType.SYSTEM_STARTED, handler2);
      
      await elizaos.initialize();
      
      expect(handler1Called).toBe(true);
      expect(handler2Called).toBe(true);
    });

    it('should unsubscribe from events', async () => {
      let eventCount = 0;
      
      const handler = () => { eventCount++; };
      
      elizaos.on(ElizaOSEventType.AGENT_CREATED, handler);
      
      await elizaos.initialize();
      
      // Create first agent
      await elizaos.createAgent({ character: testCharacter });
      expect(eventCount).toBe(1);
      
      // Unsubscribe
      elizaos.off(ElizaOSEventType.AGENT_CREATED, handler);
      
      // Create second agent - should not trigger handler
      await elizaos.createAgent({ 
        character: { ...testCharacter, name: 'Agent 2' } 
      });
      expect(eventCount).toBe(1);
    });
  });

  describe('System Management', () => {
    it('should start and stop the entire system', async () => {
      await elizaos.initialize();
      
      // Create agents
      const agent1Id = await elizaos.createAgent({
        character: { ...testCharacter, name: 'Agent 1' },
        autoStart: true,
      });
      
      const agent2Id = await elizaos.createAgent({
        character: { ...testCharacter, name: 'Agent 2' },
        autoStart: true,
      });
      
      // Start system
      await elizaos.start();
      
      let status = elizaos.getSystemStatus();
      expect(status.activeAgents).toBe(2);
      expect(status.totalAgents).toBe(2);
      
      // Stop system
      await elizaos.stop();
      
      status = elizaos.getSystemStatus();
      expect(status.activeAgents).toBe(0);
      expect(status.totalAgents).toBe(2);
    });

    it('should reset the system', async () => {
      await elizaos.initialize();
      
      // Create agents
      await elizaos.createAgent({ character: testCharacter });
      await elizaos.createAgent({ 
        character: { ...testCharacter, name: 'Agent 2' } 
      });
      
      let status = elizaos.getSystemStatus();
      expect(status.totalAgents).toBe(2);
      
      // Reset
      await elizaos.reset();
      
      status = elizaos.getSystemStatus();
      expect(status.totalAgents).toBe(0);
    });

    it('should perform health check', async () => {
      await elizaos.initialize();
      
      const isHealthy = await elizaos.healthCheck();
      expect(isHealthy).toBe(true);
      
      // Create and start an agent
      const agentId = await elizaos.createAgent({ character: testCharacter });
      await elizaos.startAgent(agentId);
      
      const isStillHealthy = await elizaos.healthCheck();
      expect(isStillHealthy).toBe(true);
    });
  });

  describe('Agent Communication', () => {
    it('should broadcast messages to all agents', async () => {
      await elizaos.initialize();
      
      // Create multiple agents
      const agent1Id = await elizaos.createAgent({
        character: { ...testCharacter, name: 'Agent 1' },
      });
      
      const agent2Id = await elizaos.createAgent({
        character: { ...testCharacter, name: 'Agent 2' },
      });
      
      await elizaos.startAgent(agent1Id);
      await elizaos.startAgent(agent2Id);
      
      // Broadcast message (currently just logs, but structure is in place)
      await expect(elizaos.broadcast({ 
        text: 'Hello all agents' 
      })).resolves.not.toThrow();
    });
  });

  describe('Resource Management', () => {
    it('should track resource usage', async () => {
      await elizaos.initialize();
      
      const status = elizaos.getSystemStatus();
      
      expect(status.memoryUsage).toBeDefined();
      expect(status.memoryUsage.heapUsed).toBeGreaterThan(0);
      expect(status.memoryUsage.heapTotal).toBeGreaterThan(0);
    });

    it('should report system uptime', async () => {
      await elizaos.initialize();
      await elizaos.start();
      
      // Wait a bit
      await new Promise(resolve => setTimeout(resolve, 100));
      
      const status = elizaos.getSystemStatus();
      expect(status.uptime).toBeGreaterThan(0);
    });
  });
});

