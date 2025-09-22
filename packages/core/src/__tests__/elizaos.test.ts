import { describe, expect, it, beforeEach, mock } from 'bun:test';
import { ElizaOS } from '../elizaos';
import { type UUID, type Character, type Memory, type Plugin } from '../types';
import { v4 as uuidv4 } from 'uuid';

// Mock database adapter with minimal implementation
const mockAdapter = new Proxy({} as any, {
  get: (target, prop) => {
    // Return async functions for all adapter methods
    if (prop === 'init' || prop === 'close') {
      return mock().mockResolvedValue(undefined);
    }
    // getAgents should return an empty array
    if (prop === 'getAgents') {
      return mock().mockResolvedValue([]);
    }
    // createAgent returns true
    if (prop === 'createAgent') {
      return mock().mockResolvedValue(true);
    }
    // createEntity returns an object with id
    if (prop === 'createEntity') {
      return mock().mockResolvedValue({ id: uuidv4() });
    }
    // createEntities returns true
    if (prop === 'createEntities') {
      return mock().mockResolvedValue(true);
    }
    // getParticipantsForRoom should return an array
    if (prop === 'getParticipantsForRoom') {
      return mock().mockResolvedValue([]);
    }
    // getEntitiesByIds should return mock entities with the same IDs
    if (prop === 'getEntitiesByIds') {
      return (ids: UUID[]) => Promise.resolve(ids.map(id => ({ id, name: 'TestAgent', names: ['TestAgent'] })));
    }
    // createRooms should return an array of room IDs
    if (prop === 'createRooms') {
      return mock().mockResolvedValue([uuidv4()]);
    }
    // addParticipantsRoom should return true
    if (prop === 'addParticipantsRoom') {
      return mock().mockResolvedValue(true);
    }
    return mock().mockResolvedValue(null);
  }
});

// Mock SQL plugin that provides the adapter
const mockSqlPlugin: Plugin = {
  name: 'sql',
  description: 'Mock SQL plugin for testing',
  adapter: mockAdapter,
};

describe('ElizaOS', () => {
  let elizaOS: ElizaOS;
  
  beforeEach(() => {
    elizaOS = new ElizaOS();
  });

  describe('Agent Management', () => {
    const testCharacter: Character = {
      name: 'TestAgent',
      description: 'A test agent',
      system: 'You are a test agent',
      modelEndpointOverride: 'test-endpoint',
    };

    it('should add multiple agents', async () => {
      const agentIds = await elizaOS.addAgents([
        { character: testCharacter, plugins: [mockSqlPlugin] },
        { character: { ...testCharacter, name: 'TestAgent2' }, plugins: [mockSqlPlugin] }
      ]);
      
      expect(agentIds).toHaveLength(2);
      expect(agentIds[0]).toBeTruthy();
      expect(agentIds[1]).toBeTruthy();
    });

    it('should start agents', async () => {
      const agentIds = await elizaOS.addAgents([{ character: testCharacter, plugins: [mockSqlPlugin] }]);
      await elizaOS.startAgents(agentIds);
      
      const agent = elizaOS.getAgent(agentIds[0]);
      expect(agent).toBeTruthy();
    });

    it('should stop agents', async () => {
      const agentIds = await elizaOS.addAgents([{ character: testCharacter, plugins: [mockSqlPlugin] }]);
      await elizaOS.startAgents(agentIds);
      await elizaOS.stopAgents(agentIds);
      
      // Agent should still exist but be stopped
      const agent = elizaOS.getAgent(agentIds[0]);
      expect(agent).toBeTruthy();
    });

    it('should delete agents', async () => {
      const agentIds = await elizaOS.addAgents([{ character: testCharacter, plugins: [mockSqlPlugin] }]);
      await elizaOS.deleteAgents(agentIds);
      
      const agent = elizaOS.getAgent(agentIds[0]);
      expect(agent).toBeUndefined();
    });

    it('should get all agents', async () => {
      const agentIds = await elizaOS.addAgents([
        { character: testCharacter, plugins: [mockSqlPlugin] },
        { character: { ...testCharacter, name: 'TestAgent2' }, plugins: [mockSqlPlugin] }
      ]);
      
      const agents = elizaOS.getAgents();
      expect(agents).toHaveLength(2);
    });
  });

  describe('Message Handling', () => {
    const testCharacter: Character = {
      name: 'TestAgent',
      description: 'A test agent',
      system: 'You are a test agent. Always respond with "Test response"',
      modelEndpointOverride: 'test-endpoint',
    };

    it('should send a message to an agent', async () => {
      const [agentId] = await elizaOS.addAgents([{ character: testCharacter, plugins: [mockSqlPlugin] }]);
      await elizaOS.startAgents([agentId]);
      
      // Mock the runtime's processActions to return a response
      const agent = elizaOS.getAgent(agentId);
      if (agent) {
        agent.processActions = mock(async (message: Memory, responses: Memory[]) => {
          responses.push({
            id: uuidv4() as UUID,
            entityId: agentId,
            agentId,
            roomId: message.roomId,
            content: { text: 'Test response' },
            createdAt: Date.now(),
          } as Memory);
        });
      }
      
      const responses = await elizaOS.sendMessage(agentId, 'Hello');
      
      expect(responses).toHaveLength(1);
      expect(responses[0].content.text).toBe('Test response');
    });

    it('should send a Memory object to an agent', async () => {
      const [agentId] = await elizaOS.addAgents([{ character: testCharacter, plugins: [mockSqlPlugin] }]);
      await elizaOS.startAgents([agentId]);
      
      const agent = elizaOS.getAgent(agentId);
      if (agent) {
        agent.processActions = mock(async (message: Memory, responses: Memory[]) => {
          responses.push({
            id: uuidv4() as UUID,
            entityId: agentId,
            agentId,
            roomId: message.roomId,
            content: { text: `Echo: ${message.content.text}` },
            createdAt: Date.now(),
          } as Memory);
        });
      }
      
      const testMemory: Memory = {
        id: uuidv4() as UUID,
        entityId: 'user' as UUID,
        agentId,
        roomId: agentId,
        content: { text: 'Test message' },
        createdAt: Date.now(),
      };
      
      const responses = await elizaOS.sendMessage(agentId, testMemory);
      
      expect(responses).toHaveLength(1);
      expect(responses[0].content.text).toBe('Echo: Test message');
    });

    it('should handle sendMessage with options', async () => {
      const [agentId] = await elizaOS.addAgents([{ character: testCharacter, plugins: [mockSqlPlugin] }]);
      await elizaOS.startAgents([agentId]);
      
      const userId = uuidv4() as UUID;
      const roomId = uuidv4() as UUID;
      
      const agent = elizaOS.getAgent(agentId);
      if (agent) {
        agent.processActions = mock(async (message: Memory, responses: Memory[]) => {
          expect(message.entityId).toBe(userId);
          expect(message.roomId).toBe(roomId);
          expect(message.metadata?.custom).toBe('data');
          
          responses.push({
            id: uuidv4() as UUID,
            entityId: agentId,
            agentId,
            roomId: message.roomId,
            content: { text: 'Response with metadata' },
            createdAt: Date.now(),
          } as Memory);
        });
      }
      
      const responses = await elizaOS.sendMessage(agentId, 'Hello', {
        userId,
        roomId,
        metadata: { custom: 'data' }
      });
      
      expect(responses).toHaveLength(1);
    });

    it('should send messages to multiple agents', async () => {
      const agentIds = await elizaOS.addAgents([
        { character: testCharacter, plugins: [mockSqlPlugin] },
        { character: { ...testCharacter, name: 'TestAgent2' }, plugins: [mockSqlPlugin] }
      ]);
      await elizaOS.startAgents(agentIds);
      
      // Mock both agents
      agentIds.forEach((agentId, index) => {
        const agent = elizaOS.getAgent(agentId);
        if (agent) {
          agent.processActions = mock(async (message: Memory, responses: Memory[]) => {
            responses.push({
              id: uuidv4() as UUID,
              entityId: agentId,
              agentId,
              roomId: message.roomId,
              content: { text: `Agent ${index + 1} response` },
              createdAt: Date.now(),
            } as Memory);
          });
        }
      });
      
      const results = await elizaOS.sendMessages([
        { agentId: agentIds[0], message: 'Hello Agent 1' },
        { agentId: agentIds[1], message: 'Hello Agent 2' }
      ]);
      
      expect(results).toHaveLength(2);
      expect(results[0].responses[0].content.text).toBe('Agent 1 response');
      expect(results[1].responses[0].content.text).toBe('Agent 2 response');
    });

    it('should handle errors when sending to non-existent agent', async () => {
      const fakeAgentId = uuidv4() as UUID;
      
      await expect(elizaOS.sendMessage(fakeAgentId, 'Hello')).rejects.toThrow(
        `Agent ${fakeAgentId} not found`
      );
    });

    it('should handle errors in sendMessages batch', async () => {
      const [agentId] = await elizaOS.addAgents([{ character: testCharacter, plugins: [mockSqlPlugin] }]);
      await elizaOS.startAgents([agentId]);
      
      const fakeAgentId = uuidv4() as UUID;
      
      const agent = elizaOS.getAgent(agentId);
      if (agent) {
        agent.processActions = mock(async (message: Memory, responses: Memory[]) => {
          responses.push({
            id: uuidv4() as UUID,
            entityId: agentId,
            agentId,
            roomId: message.roomId,
            content: { text: 'Success' },
            createdAt: Date.now(),
          } as Memory);
        });
      }
      
      const results = await elizaOS.sendMessages([
        { agentId, message: 'Hello' },
        { agentId: fakeAgentId, message: 'This will fail' }
      ]);
      
      expect(results).toHaveLength(2);
      expect(results[0].responses[0].content.text).toBe('Success');
      expect(results[0].error).toBeUndefined();
      expect(results[1].responses).toHaveLength(0);
      expect(results[1].error).toBeTruthy();
    });
  });

  describe('Event System', () => {
    it('should emit events when agents are added', async () => {
      const addedHandler = mock();
      elizaOS.addEventListener('agents:added', (e: any) => addedHandler(e.detail));
      
      await elizaOS.addAgents([
        { character: { name: 'Test1' }, plugins: [mockSqlPlugin] },
        { character: { name: 'Test2' }, plugins: [mockSqlPlugin] }
      ]);
      
      expect(addedHandler).toHaveBeenCalledTimes(1);
      const eventData = addedHandler.mock.calls[0][0];
      expect(eventData.count).toBe(2);
      expect(eventData.agentIds).toHaveLength(2);
    });

    it('should emit events when agents are stopped', async () => {
      const stoppedHandler = mock();
      elizaOS.addEventListener('agents:stopped', (e: any) => stoppedHandler(e.detail));
      
      const agentIds = await elizaOS.addAgents([
        { character: { name: 'Test1' }, plugins: [mockSqlPlugin] }
      ]);
      await elizaOS.startAgents(agentIds);
      await elizaOS.stopAgents(agentIds);
      
      expect(stoppedHandler).toHaveBeenCalledTimes(1);
      const eventData = stoppedHandler.mock.calls[0][0];
      expect(eventData.agentIds).toEqual(agentIds);
    });

    it('should emit events when agents are deleted', async () => {
      const deletedHandler = mock();
      elizaOS.addEventListener('agents:deleted', (e: any) => deletedHandler(e.detail));
      
      const agentIds = await elizaOS.addAgents([
        { character: { name: 'Test1' }, plugins: [mockSqlPlugin] }
      ]);
      await elizaOS.deleteAgents(agentIds);
      
      expect(deletedHandler).toHaveBeenCalledTimes(1);
      const eventData = deletedHandler.mock.calls[0][0];
      expect(eventData.agentIds).toEqual(agentIds);
    });
  });
});