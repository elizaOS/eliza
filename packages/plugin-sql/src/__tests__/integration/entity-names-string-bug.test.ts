import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import type { Entity, UUID } from '@elizaos/core';
import { stringToUuid } from '@elizaos/core';
import { createTestDatabase } from '../test-helpers';

describe('Entity Names String Bug Verification', () => {
  let adapter: any;
  let cleanup: () => Promise<void>;
  let testAgentId: UUID;

  beforeEach(async () => {
    testAgentId = stringToUuid(`test-agent-${Date.now()}`);
    const testDB = await createTestDatabase(testAgentId);
    adapter = testDB.adapter;
    cleanup = testDB.cleanup;
  });

  afterEach(async () => {
    if (cleanup) {
      await cleanup();
    }
  });

  describe('String to Array Bug', () => {
    it('should NOT split a string name into individual characters', async () => {
      const entityId = stringToUuid(`entity-string-bug-${Date.now()}`);

      // Simulate a case where names might accidentally be a string
      const entity: any = {
        id: entityId,
        agentId: testAgentId,
        names: 'username123', // String instead of array
        metadata: { web: { userName: 'username123' } },
      };

      const result = await adapter.createEntities([entity]);
      expect(result).toBe(true);

      const retrieved = await adapter.getEntitiesByIds([entityId]);
      expect(retrieved).not.toBeNull();
      expect(Array.isArray(retrieved?.[0]?.names)).toBe(true);

      // THIS IS THE BUG: Without the fix, this would be ["u","s","e","r","n","a","m","e","1","2","3"]
      // With the fix, it should be ["username123"]
      expect(retrieved?.[0]?.names).toEqual(['username123']);
      expect(retrieved?.[0]?.names.length).toBe(1);
    });

    it('should handle string name in update without splitting into characters', async () => {
      const entityId = stringToUuid(`entity-update-string-bug-${Date.now()}`);

      // Create initial entity with proper array
      const entity: Entity = {
        id: entityId,
        agentId: testAgentId,
        names: ['original-name'],
        metadata: {},
      };

      await adapter.createEntities([entity]);

      // Update with string instead of array (simulating the bug)
      const updatedEntity: any = {
        id: entityId,
        agentId: testAgentId,
        names: 'updated-username', // String instead of array
        metadata: { updated: true },
      };

      await adapter.updateEntity(updatedEntity);

      const retrieved = await adapter.getEntitiesByIds([entityId]);
      expect(retrieved).not.toBeNull();
      expect(Array.isArray(retrieved?.[0]?.names)).toBe(true);

      // Should be ["updated-username"], NOT ["u","p","d","a","t","e","d","-","u","s","e","r","n","a","m","e"]
      expect(retrieved?.[0]?.names).toEqual(['updated-username']);
      expect(retrieved?.[0]?.names.length).toBe(1);
    });

    it('should properly handle Set conversion without affecting strings', async () => {
      const timestamp = Date.now();
      const entities: any[] = [
        {
          id: stringToUuid(`entity-set-${timestamp}-1`),
          agentId: testAgentId,
          names: new Set(['name1', 'name2']), // Set should convert to array
          metadata: { type: 'set' },
        },
        {
          id: stringToUuid(`entity-string-${timestamp}-2`),
          agentId: testAgentId,
          names: 'singlename', // String should wrap in array
          metadata: { type: 'string' },
        },
        {
          id: stringToUuid(`entity-array-${timestamp}-3`),
          agentId: testAgentId,
          names: ['proper', 'array'], // Array should stay as is
          metadata: { type: 'array' },
        },
      ];

      const result = await adapter.createEntities(entities);
      expect(result).toBe(true);

      const entityIds = entities.map((e) => e.id);
      const retrieved = await adapter.getEntitiesByIds(entityIds);

      expect(retrieved).not.toBeNull();
      expect(retrieved?.length).toBe(3);

      // Find each entity by metadata type
      const setEntity = retrieved?.find((e) => e.metadata?.type === 'set');
      const stringEntity = retrieved?.find((e) => e.metadata?.type === 'string');
      const arrayEntity = retrieved?.find((e) => e.metadata?.type === 'array');

      // Set should be converted to array
      expect(Array.isArray(setEntity?.names)).toBe(true);
      expect(setEntity?.names.length).toBe(2);
      expect(setEntity?.names).toContain('name1');
      expect(setEntity?.names).toContain('name2');

      // String should be wrapped in array, NOT split into characters
      expect(Array.isArray(stringEntity?.names)).toBe(true);
      expect(stringEntity?.names).toEqual(['singlename']);
      expect(stringEntity?.names.length).toBe(1);

      // Array should remain unchanged
      expect(Array.isArray(arrayEntity?.names)).toBe(true);
      expect(arrayEntity?.names).toEqual(['proper', 'array']);
    });
  });
});
