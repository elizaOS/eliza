import { describe, expect, it, beforeEach, mock } from 'bun:test';
import { ElizaOS } from '../elizaos';
import { type UUID, type Character, type Plugin, type IDatabaseAdapter } from '../types';
import { v4 as uuidv4 } from 'uuid';

// Event detail interfaces for type-safe event handlers
interface AgentsAddedDetail {
  agentIds: UUID[];
  count: number;
}

interface AgentsStoppedDetail {
  agentIds: UUID[];
  count: number;
}

interface AgentsDeletedDetail {
  agentIds: UUID[];
  count: number;
}

// Mock database adapter with minimal implementation
const mockAdapter = new Proxy({} as IDatabaseAdapter, {
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
      return (ids: UUID[]) =>
        Promise.resolve(ids.map((id) => ({ id, name: 'TestAgent', names: ['TestAgent'] })));
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
  },
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
      bio: 'A test agent',
      system: 'You are a test agent',
    };

    it('should add multiple agents', async () => {
      const agentIds = await elizaOS.addAgents([
        { character: testCharacter, plugins: [mockSqlPlugin] },
        { character: { ...testCharacter, name: 'TestAgent2' }, plugins: [mockSqlPlugin] },
      ]);

      expect(agentIds).toHaveLength(2);
      expect(agentIds[0]).toBeTruthy();
      expect(agentIds[1]).toBeTruthy();
    });

    it('should start agents', async () => {
      const agentIds = await elizaOS.addAgents([
        { character: testCharacter, plugins: [mockSqlPlugin] },
      ]);
      await elizaOS.startAgents(agentIds);

      const agent = elizaOS.getAgent(agentIds[0]);
      expect(agent).toBeTruthy();
    });

    it('should stop agents', async () => {
      const agentIds = await elizaOS.addAgents([
        { character: testCharacter, plugins: [mockSqlPlugin] },
      ]);
      await elizaOS.startAgents(agentIds);
      await elizaOS.stopAgents(agentIds);

      // Agent should still exist but be stopped
      const agent = elizaOS.getAgent(agentIds[0]);
      expect(agent).toBeTruthy();
    });

    it('should delete agents', async () => {
      const agentIds = await elizaOS.addAgents([
        { character: testCharacter, plugins: [mockSqlPlugin] },
      ]);
      await elizaOS.deleteAgents(agentIds);

      const agent = elizaOS.getAgent(agentIds[0]);
      expect(agent).toBeUndefined();
    });

    it('should get all agents', async () => {
      const agentIds = await elizaOS.addAgents([
        { character: testCharacter, plugins: [mockSqlPlugin] },
        { character: { ...testCharacter, name: 'TestAgent2' }, plugins: [mockSqlPlugin] },
      ]);

      const agents = elizaOS.getAgents();
      expect(agents).toHaveLength(2);
    });
  });

  describe('Runtime ElizaOS Reference', () => {
    const testCharacter: Character = {
      name: 'TestAgent',
      bio: 'A test agent',
      system: 'You are a test agent',
    };

    it('should assign elizaOS reference to runtime when agent is added', async () => {
      const agentIds = await elizaOS.addAgents([
        { character: testCharacter, plugins: [mockSqlPlugin] },
      ]);

      const runtime = elizaOS.getAgent(agentIds[0]);
      expect(runtime).toBeTruthy();
      expect(runtime?.elizaOS).toBe(elizaOS);
    });

    it('should assign elizaOS reference to runtime when agent is registered', async () => {
      const agentIds = await elizaOS.addAgents([
        { character: testCharacter, plugins: [mockSqlPlugin] },
      ]);
      const runtime = elizaOS.getAgent(agentIds[0]);

      // Remove and re-register
      await elizaOS.deleteAgents(agentIds);
      elizaOS.registerAgent(runtime!);

      expect(runtime?.elizaOS).toBe(elizaOS);
    });

    it('hasElizaOS() should return true when elizaOS is assigned', async () => {
      const agentIds = await elizaOS.addAgents([
        { character: testCharacter, plugins: [mockSqlPlugin] },
      ]);

      const runtime = elizaOS.getAgent(agentIds[0]);
      expect(runtime?.hasElizaOS()).toBe(true);
    });

    it('hasElizaOS() should narrow TypeScript type correctly', async () => {
      const agentIds = await elizaOS.addAgents([
        { character: testCharacter, plugins: [mockSqlPlugin] },
      ]);

      const runtime = elizaOS.getAgent(agentIds[0]);
      if (runtime?.hasElizaOS()) {
        // TypeScript should know elizaOS is defined here
        expect(runtime.elizaOS).toBeDefined();
        expect(runtime.elizaOS.sendMessage).toBeDefined();
        expect(runtime.elizaOS.getAgent).toBeDefined();
      } else {
        throw new Error('hasElizaOS() should return true');
      }
    });

    it('should clear elizaOS reference on runtime.stop()', async () => {
      const agentIds = await elizaOS.addAgents([
        { character: testCharacter, plugins: [mockSqlPlugin] },
      ]);

      const runtime = elizaOS.getAgent(agentIds[0]);
      expect(runtime?.elizaOS).toBe(elizaOS);

      // Stop the runtime
      await runtime?.stop();

      // elizaOS reference should be cleared to prevent memory leak
      expect(runtime?.elizaOS).toBeUndefined();
    });

    it('should prevent memory leaks with bidirectional reference', async () => {
      const agentIds = await elizaOS.addAgents([
        { character: testCharacter, plugins: [mockSqlPlugin] },
      ]);

      const runtime = elizaOS.getAgent(agentIds[0]);

      // Verify bidirectional reference
      expect(runtime?.elizaOS).toBe(elizaOS);
      expect(elizaOS.getAgent(agentIds[0])).toBe(runtime);

      // Stop and verify cleanup
      await runtime?.stop();
      expect(runtime?.elizaOS).toBeUndefined();
    });
  });

  describe('Unified Messaging API', () => {
    const testCharacter: Character = {
      name: 'TestAgent',
      bio: 'A test agent',
      system: 'You are a test agent',
    };

  });

  describe('Event System', () => {
    it('should emit events when agents are added', async () => {
      const addedHandler = mock();
      elizaOS.addEventListener('agents:added', (e: Event) => {
        const customEvent = e as CustomEvent<AgentsAddedDetail>;
        addedHandler(customEvent.detail);
      });

      await elizaOS.addAgents([
        { character: { name: 'Test1', bio: 'Test agent 1' }, plugins: [mockSqlPlugin] },
        { character: { name: 'Test2', bio: 'Test agent 2' }, plugins: [mockSqlPlugin] },
      ]);

      expect(addedHandler).toHaveBeenCalledTimes(1);
      const eventData: AgentsAddedDetail = addedHandler.mock.calls[0][0];
      expect(eventData.count).toBe(2);
      expect(eventData.agentIds).toHaveLength(2);
    });

    it('should emit events when agents are stopped', async () => {
      const stoppedHandler = mock();
      elizaOS.addEventListener('agents:stopped', (e: Event) => {
        const customEvent = e as CustomEvent<AgentsStoppedDetail>;
        stoppedHandler(customEvent.detail);
      });

      const agentIds = await elizaOS.addAgents([
        { character: { name: 'Test1', bio: 'Test agent' }, plugins: [mockSqlPlugin] },
      ]);
      await elizaOS.startAgents(agentIds);
      await elizaOS.stopAgents(agentIds);

      expect(stoppedHandler).toHaveBeenCalledTimes(1);
      const eventData: AgentsStoppedDetail = stoppedHandler.mock.calls[0][0];
      expect(eventData.agentIds).toEqual(agentIds);
    });

    it('should emit events when agents are deleted', async () => {
      const deletedHandler = mock();
      elizaOS.addEventListener('agents:deleted', (e: Event) => {
        const customEvent = e as CustomEvent<AgentsDeletedDetail>;
        deletedHandler(customEvent.detail);
      });

      const agentIds = await elizaOS.addAgents([
        { character: { name: 'Test1', bio: 'Test agent' }, plugins: [mockSqlPlugin] },
      ]);
      await elizaOS.deleteAgents(agentIds);

      expect(deletedHandler).toHaveBeenCalledTimes(1);
      const eventData: AgentsDeletedDetail = deletedHandler.mock.calls[0][0];
      expect(eventData.agentIds).toEqual(agentIds);
    });
  });
});
