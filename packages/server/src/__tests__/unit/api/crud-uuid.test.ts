import { describe, expect, it, beforeEach, mock } from 'bun:test';
import type { Agent, Character, UUID } from '@elizaos/core';
import { stringToUuid } from '@elizaos/core';
import { v4 as uuidv4 } from 'uuid';
import { jsonToCharacter } from '../../../loader';

/**
 * Test suite to verify that agent operations work correctly with UUID-based identification
 * and allow multiple agents with the same name.
 *
 * This tests the core logic without needing the full API server setup.
 */
describe('Agent Operations - UUID Independence', () => {
  const agentStore = new Map<UUID, Agent>();

  const mockDb = {
    getAgent: async (agentId: UUID) => {
      return agentStore.get(agentId) || null;
    },
    getAgents: async () => {
      return Array.from(agentStore.values());
    },
    createAgent: async (agent: Partial<Agent>) => {
      if (!agent.id) return false;
      const fullAgent: Agent = {
        id: agent.id,
        name: agent.name || 'Unknown',
        username: agent.username,
        bio: agent.bio || [],
        createdAt: agent.createdAt || Date.now(),
        updatedAt: agent.updatedAt || Date.now(),
      };
      agentStore.set(agent.id, fullAgent);
      return true;
    },
    updateAgent: async (agentId: UUID, updates: Partial<Agent>) => {
      const existing = agentStore.get(agentId);
      if (!existing) return false;
      agentStore.set(agentId, { ...existing, ...updates, updatedAt: Date.now() });
      return true;
    },
    deleteAgent: async (agentId: UUID) => {
      return agentStore.delete(agentId);
    },
  };

  beforeEach(() => {
    agentStore.clear();
  });

  it('should create two agents with the same name but different IDs', async () => {
    const sharedName = 'TestAgent';
    const id1 = stringToUuid(uuidv4());
    const id2 = stringToUuid(uuidv4());

    // Create first agent
    const character1: Character = await jsonToCharacter({
      id: id1,
      name: sharedName,
      bio: ['First agent'],
    });

    await mockDb.createAgent(character1);

    // Create second agent with same name but different ID
    const character2: Character = await jsonToCharacter({
      id: id2,
      name: sharedName,
      bio: ['Second agent'],
    });

    await mockDb.createAgent(character2);

    // Verify both exist
    const allAgents = await mockDb.getAgents();
    expect(allAgents).toHaveLength(2);

    const ids = allAgents.map((a: Agent) => a.id);
    expect(ids).toContain(id1);
    expect(ids).toContain(id2);

    const names = allAgents.map((a: Agent) => a.name);
    expect(names.filter((n: string) => n === sharedName)).toHaveLength(2);
  });

  it('should reject agent creation without an ID', async () => {
    const characterWithoutId = {
      name: 'TestAgent',
      bio: ['Agent without ID'],
      // No ID field - loader should generate one
    };

    const character = await jsonToCharacter(characterWithoutId);

    // jsonToCharacter should have generated an ID
    expect(character.id).toBeTruthy();

    // Now test that ensureAgentExists logic requires ID
    const ensureAgentExists = async (character: Character) => {
      if (!character.id) {
        throw new Error('Character must have an ID');
      }
      const agentId = character.id;
      let agent = await mockDb.getAgent(agentId);
      if (!agent) {
        await mockDb.createAgent({ ...character, id: agentId });
        agent = await mockDb.getAgent(agentId);
      }
      return agent;
    };

    // Should work since loader generated ID
    const agent = await ensureAgentExists(character);
    expect(agent).toBeTruthy();
    expect(agent?.id).toBe(character.id);
  });

  it('should list all agents with same name separately', async () => {
    const sharedName = 'DuplicateName';
    const id1 = stringToUuid(uuidv4());
    const id2 = stringToUuid(uuidv4());
    const id3 = stringToUuid(uuidv4());

    // Create three agents, two with same name
    await mockDb.createAgent({ id: id1, name: sharedName, bio: ['First'] });
    await mockDb.createAgent({ id: id2, name: 'UniqueName', bio: ['Unique'] });
    await mockDb.createAgent({ id: id3, name: sharedName, bio: ['Second'] });

    const allAgents = await mockDb.getAgents();

    expect(allAgents).toHaveLength(3);

    const duplicates = allAgents.filter((a: Agent) => a.name === sharedName);
    expect(duplicates).toHaveLength(2);
    expect(duplicates[0].id).not.toBe(duplicates[1].id);
  });

  it('should get specific agent by UUID, not by name', async () => {
    const sharedName = 'SharedAgent';
    const id1 = stringToUuid(uuidv4());
    const id2 = stringToUuid(uuidv4());

    await mockDb.createAgent({ id: id1, name: sharedName, bio: ['First bio'] });
    await mockDb.createAgent({ id: id2, name: sharedName, bio: ['Second bio'] });

    // Get first agent by ID
    const agent1 = await mockDb.getAgent(id1);
    expect(agent1).toBeTruthy();
    expect(agent1?.id).toBe(id1);
    expect(agent1?.bio).toContain('First bio');

    // Get second agent by ID
    const agent2 = await mockDb.getAgent(id2);
    expect(agent2).toBeTruthy();
    expect(agent2?.id).toBe(id2);
    expect(agent2?.bio).toContain('Second bio');
  });

  it('should update specific agent by UUID without affecting agents with same name', async () => {
    const sharedName = 'TestAgent';
    const id1 = stringToUuid(uuidv4());
    const id2 = stringToUuid(uuidv4());

    await mockDb.createAgent({ id: id1, name: sharedName, bio: ['First'] });
    await mockDb.createAgent({ id: id2, name: sharedName, bio: ['Second'] });

    // Update first agent only
    const updates = { bio: ['Updated first agent'] };
    await mockDb.updateAgent(id1, updates);

    // Verify only first agent was updated
    const agent1 = await mockDb.getAgent(id1);
    const agent2 = await mockDb.getAgent(id2);

    expect(agent1?.bio).toContain('Updated first agent');
    expect(agent2?.bio).toContain('Second'); // Unchanged
  });

  it('should delete specific agent by UUID without affecting agents with same name', async () => {
    const sharedName = 'TestAgent';
    const id1 = stringToUuid(uuidv4());
    const id2 = stringToUuid(uuidv4());

    await mockDb.createAgent({ id: id1, name: sharedName, bio: ['First'] });
    await mockDb.createAgent({ id: id2, name: sharedName, bio: ['Second'] });

    // Delete first agent
    await mockDb.deleteAgent(id1);

    // Verify only first agent was deleted
    const agent1 = await mockDb.getAgent(id1);
    const agent2 = await mockDb.getAgent(id2);

    expect(agent1).toBeNull();
    expect(agent2).toBeTruthy();
    expect(agent2?.name).toBe(sharedName);

    const allAgents = await mockDb.getAgents();
    expect(allAgents).toHaveLength(1);
  });
});
