import { describe, expect, it, beforeAll, afterAll, beforeEach } from 'vitest';
import { PgliteDatabaseAdapter } from '../../src/pglite/adapter';
import { type UUID, type Entity, type Relationship, AgentRuntime, stringToUuid } from '@elizaos/core';
import { v4 as uuidv4 } from 'uuid';
import { createTestDatabase } from '../test-helpers';
import { relationshipTable, entityTable } from '../../src/schema';

describe('Relationship Integration Tests', () => {
  let adapter: PgliteDatabaseAdapter;
  let runtime: AgentRuntime;
  let cleanup: () => Promise<void>;
  let testAgentId: UUID;
  let sourceEntityId: UUID;
  let targetEntityId: UUID;

  beforeAll(async () => {
    testAgentId = stringToUuid('test-agent-for-relationship-tests');
    sourceEntityId = stringToUuid('source-entity-for-relationship-tests');
    targetEntityId = stringToUuid('target-entity-for-relationship-tests');
    ({ adapter, runtime, cleanup } = await createTestDatabase(testAgentId));

    await adapter.createEntities([
      { id: sourceEntityId, agentId: testAgentId, names: ['Source Entity'] } as Entity,
      { id: targetEntityId, agentId: testAgentId, names: ['Target Entity'] } as Entity,
    ]);
  }, 30000);

  beforeEach(async () => {
    const db = adapter.getDatabase();
    await db.delete(relationshipTable);
    await db.delete(entityTable);

    await adapter.createEntities([
      { id: sourceEntityId, agentId: testAgentId, names: ['Source'] } as Entity,
      { id: targetEntityId, agentId: testAgentId, names: ['Target'] } as Entity,
    ]);
  });

  afterAll(async () => {
    await cleanup();
  });

  it('should create and retrieve a relationship', async () => {
    const result = await adapter.createRelationship({
      sourceEntityId,
      targetEntityId,
      tags: ['friend'],
      metadata: { since: '2023' },
    });
    expect(result).toBe(true);

    const retrieved = await adapter.getRelationship({ sourceEntityId, targetEntityId });
    expect(retrieved).not.toBeNull();
    expect(retrieved?.tags).toEqual(['friend']);
    expect(retrieved?.metadata).toEqual({ since: '2023' });
  });

  it('should update an existing relationship', async () => {
    await adapter.createRelationship({ sourceEntityId, targetEntityId });
    const created = await adapter.getRelationship({ sourceEntityId, targetEntityId });
    expect(created).not.toBeNull();

    const updatedRel: Relationship = {
      ...created!,
      tags: ['updated_tag'],
      metadata: { status: 'updated' },
    };
    await adapter.updateRelationship(updatedRel);

    const retrieved = await adapter.getRelationship({ sourceEntityId, targetEntityId });
    expect(retrieved?.tags).toEqual(['updated_tag']);
    expect(retrieved?.metadata).toEqual({ status: 'updated' });
  });

  it('should retrieve relationships by entity ID and tags', async () => {
    await adapter.createRelationship({ sourceEntityId, targetEntityId, tags: ['friend', 'close'] });
    await adapter.createRelationship({
      sourceEntityId: targetEntityId,
      targetEntityId: sourceEntityId,
      tags: ['colleague'],
    });

    const friendRels = await adapter.getRelationships({
      entityId: sourceEntityId,
      tags: ['friend'],
    });
    expect(friendRels).toHaveLength(1);
    expect(friendRels[0].tags).toContain('close');

    const allRels = await adapter.getRelationships({ entityId: sourceEntityId });
    expect(allRels).toHaveLength(2);
  });
});
