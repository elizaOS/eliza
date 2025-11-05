import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import { createIsolatedTestDatabase } from '../test-helpers';
import { v4 as uuidv4 } from 'uuid';
import type { Entity, UUID } from '@elizaos/core';
import { PgDatabaseAdapter } from '../../pg/adapter';
import { PgliteDatabaseAdapter } from '../../pglite/adapter';

describe('Entity Methods Integration Tests', () => {
  let adapter: PgliteDatabaseAdapter | PgDatabaseAdapter;
  let cleanup: () => Promise<void>;
  let testAgentId: UUID;

  beforeAll(async () => {
    const setup = await createIsolatedTestDatabase('entity-methods');
    adapter = setup.adapter;
    cleanup = setup.cleanup;
    testAgentId = setup.testAgentId;
  });

  afterAll(async () => {
    if (cleanup) {
      await cleanup();
    }
  });

  /**
   * Entity Names Normalization Tests
   *
   * These tests verify that the entity names field is properly normalized to an array
   * regardless of the input type. This is critical because:
   *
   * 1. **String Handling Bug**: Without proper normalization, passing a string like "username"
   *    would be treated as an iterable and split into individual characters ["u","s","e","r"...]
   *    which corrupts the data.
   *
   * 2. **Non-Iterable Values**: When non-array values (numbers, booleans, objects) are passed,
   *    calling Array.from() would throw a runtime error, crashing the application.
   *
   * 3. **Data Integrity**: Entity names must always be stored as a proper string array to
   *    maintain consistency across the database and prevent query failures.
   *
   * The normalizeEntityNames method handles:
   * - Arrays: Pass through unchanged
   * - Strings: Wrap in array (not split into characters)
   * - Sets: Convert to array using Array.from()
   * - Iterables: Check for Symbol.iterator before calling Array.from()
   * - Non-iterables: Convert to string and wrap in array
   * - null/undefined: Return empty array
   */
  describe('Entity Names Normalization', () => {
    /**
     * Test: String values should NOT be split into individual characters
     *
     * WHY: A common bug was that passing a string like "username" would result in
     * the string being treated as an iterable, producing ["u","s","e","r","n","a","m","e"]
     * instead of ["username"].
     *
     * WHAT: Verify that a single string is wrapped in an array, not character-split.
     */
    it('should NOT split a string name into individual characters', async () => {
      const entityId = uuidv4() as UUID;

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

      // Should be ["username123"], NOT ["u","s","e","r","n","a","m","e","1","2","3"]
      expect(retrieved?.[0]?.names).toEqual(['username123']);
      expect(retrieved?.[0]?.names.length).toBe(1);
    });

    /**
     * Test: String values in updates should also NOT be split into characters
     *
     * WHY: The bug could also occur during entity updates, not just creation.
     *
     * WHAT: Verify that updating an entity with a string name doesn't split it.
     */
    it('should handle string name in update without splitting into characters', async () => {
      const entityId = uuidv4() as UUID;

      // Create initial entity with proper array
      const entity: Entity = {
        id: entityId,
        agentId: testAgentId,
        names: ['original-name'],
        metadata: {},
      };

      await adapter.createEntities([entity]);

      // Update with string instead of array (simulating the bug scenario)
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

      // Should be ["updated-username"], NOT character array
      expect(retrieved?.[0]?.names).toEqual(['updated-username']);
      expect(retrieved?.[0]?.names.length).toBe(1);
    });

    /**
     * Test: Multiple input types should all normalize correctly
     *
     * WHY: Entities can come from various sources (APIs, user input, other systems)
     * and we need to handle all possible input types gracefully.
     *
     * WHAT: Test Set, string, and array inputs all in one batch to ensure
     * consistent behavior across different input types.
     */
    it('should properly handle Set, string, and array types in batch', async () => {
      const entities: any[] = [
        {
          id: uuidv4() as UUID,
          agentId: testAgentId,
          names: new Set(['name1', 'name2']), // Set should convert to array
          metadata: { type: 'set' },
        },
        {
          id: uuidv4() as UUID,
          agentId: testAgentId,
          names: 'singlename', // String should wrap in array
          metadata: { type: 'string' },
        },
        {
          id: uuidv4() as UUID,
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

    /**
     * Test: Numbers should be converted to string arrays
     *
     * WHY: Without proper handling, passing a number would cause Array.from(42)
     * to throw "TypeError: 42 is not iterable", crashing the application.
     *
     * WHAT: Verify that numbers are safely converted to string format ["42"].
     */
    it('should handle number as names by converting to string array', async () => {
      const entityId = uuidv4() as UUID;

      const entity: any = {
        id: entityId,
        agentId: testAgentId,
        names: 42, // Number (non-iterable)
        metadata: { type: 'number' },
      };

      const result = await adapter.createEntities([entity]);
      expect(result).toBe(true);

      const retrieved = await adapter.getEntitiesByIds([entityId]);
      expect(retrieved).not.toBeNull();
      expect(Array.isArray(retrieved?.[0]?.names)).toBe(true);
      expect(retrieved?.[0]?.names).toEqual(['42']);
    });

    /**
     * Test: Booleans should be converted to string arrays
     *
     * WHY: Similar to numbers, booleans are non-iterable and would cause
     * Array.from(true) to throw a runtime error.
     *
     * WHAT: Verify that booleans are safely converted to string format ["true"].
     */
    it('should handle boolean as names by converting to string array', async () => {
      const entityId = uuidv4() as UUID;

      const entity: any = {
        id: entityId,
        agentId: testAgentId,
        names: true, // Boolean (non-iterable)
        metadata: { type: 'boolean' },
      };

      const result = await adapter.createEntities([entity]);
      expect(result).toBe(true);

      const retrieved = await adapter.getEntitiesByIds([entityId]);
      expect(retrieved).not.toBeNull();
      expect(Array.isArray(retrieved?.[0]?.names)).toBe(true);
      expect(retrieved?.[0]?.names).toEqual(['true']);
    });

    /**
     * Test: Plain objects should be converted to string arrays
     *
     * WHY: Plain objects like {foo: 'bar'} are not iterable and would cause
     * Array.from() to throw. They need to be stringified.
     *
     * WHAT: Verify that plain objects are safely converted to their string
     * representation and wrapped in an array.
     */
    it('should handle plain object as names by converting to string array', async () => {
      const entityId = uuidv4() as UUID;

      const entity: any = {
        id: entityId,
        agentId: testAgentId,
        names: { foo: 'bar' }, // Plain object (non-iterable)
        metadata: { type: 'object' },
      };

      const result = await adapter.createEntities([entity]);
      expect(result).toBe(true);

      const retrieved = await adapter.getEntitiesByIds([entityId]);
      expect(retrieved).not.toBeNull();
      expect(Array.isArray(retrieved?.[0]?.names)).toBe(true);
      // Should convert object to string representation
      expect(retrieved?.[0]?.names.length).toBe(1);
      expect(typeof retrieved?.[0]?.names[0]).toBe('string');
    });

    /**
     * Test: Null and undefined should result in empty arrays
     *
     * WHY: Null and undefined are common in JavaScript and need special handling.
     * They should not cause errors or produce invalid data.
     *
     * WHAT: Verify that both null and undefined values are safely converted
     * to empty arrays [].
     */
    it('should handle null and undefined names gracefully', async () => {
      const entities: any[] = [
        {
          id: uuidv4() as UUID,
          agentId: testAgentId,
          names: null,
          metadata: { type: 'null' },
        },
        {
          id: uuidv4() as UUID,
          agentId: testAgentId,
          names: undefined,
          metadata: { type: 'undefined' },
        },
      ];

      const result = await adapter.createEntities(entities);
      expect(result).toBe(true);

      const entityIds = entities.map((e) => e.id);
      const retrieved = await adapter.getEntitiesByIds(entityIds);

      expect(retrieved).not.toBeNull();
      expect(retrieved?.length).toBe(2);

      // Both should result in empty arrays
      retrieved?.forEach((entity) => {
        expect(Array.isArray(entity.names)).toBe(true);
        expect(entity.names).toEqual([]);
      });
    });

    /**
     * Test: Non-iterable values in updates should be handled gracefully
     *
     * WHY: The normalization bug could occur during updates just as it could
     * during creation. Updates need the same safety guarantees.
     *
     * WHAT: Verify that updating an entity with a non-iterable value (number)
     * doesn't crash and produces the expected string array.
     */
    it('should handle non-iterable values in update', async () => {
      const entityId = uuidv4() as UUID;

      // Create initial entity
      const entity: Entity = {
        id: entityId,
        agentId: testAgentId,
        names: ['original-name'],
        metadata: {},
      };

      await adapter.createEntities([entity]);

      // Update with non-iterable value (number)
      const updatedEntity: any = {
        id: entityId,
        agentId: testAgentId,
        names: 999, // Number
        metadata: { updated: true },
      };

      await adapter.updateEntity(updatedEntity);

      const retrieved = await adapter.getEntitiesByIds([entityId]);
      expect(retrieved).not.toBeNull();
      expect(Array.isArray(retrieved?.[0]?.names)).toBe(true);
      expect(retrieved?.[0]?.names).toEqual(['999']);
    });

    /**
     * Test: Maps should be converted to string arrays (not [key, value] tuples)
     *
     * WHY: Maps are iterables that yield [key, value] tuples. Without proper
     * handling, Array.from(map) would create an array of tuples like
     * [['key1', 'value1'], ['key2', 'value2']], which would then be stringified
     * to ["key1,value1", "key2,value2"] or cause database errors.
     *
     * WHAT: Verify that Map inputs are converted to proper string arrays.
     */
    it('should handle Map as names by converting entries to strings', async () => {
      const entityId = uuidv4() as UUID;

      // Create a Map (common in some APIs or data structures)
      const namesMap = new Map([
        ['key1', 'value1'],
        ['key2', 'value2'],
      ]);

      const entity: any = {
        id: entityId,
        agentId: testAgentId,
        names: namesMap, // Map (iterable that yields tuples)
        metadata: { type: 'map' },
      };

      const result = await adapter.createEntities([entity]);
      expect(result).toBe(true);

      const retrieved = await adapter.getEntitiesByIds([entityId]);
      expect(retrieved).not.toBeNull();
      expect(Array.isArray(retrieved?.[0]?.names)).toBe(true);

      // Each entry should be converted to a string
      // Map entries become "key1,value1", "key2,value2" when stringified
      expect(retrieved?.[0]?.names.length).toBe(2);
      expect(retrieved?.[0]?.names).toContain('key1,value1');
      expect(retrieved?.[0]?.names).toContain('key2,value2');
    });

    /**
     * Test: Arrays with non-string elements should convert all to strings
     *
     * WHY: Arrays might contain mixed types (numbers, objects, booleans).
     * Without converting all elements to strings, these would cause database
     * errors when inserted into a string array column.
     *
     * WHAT: Verify that arrays with non-string elements are properly converted.
     */
    it('should convert all array elements to strings, even if non-string', async () => {
      const entityId = uuidv4() as UUID;

      const entity: any = {
        id: entityId,
        agentId: testAgentId,
        names: ['string', 123, true, { foo: 'bar' }, null], // Mixed types
        metadata: { type: 'mixed-array' },
      };

      const result = await adapter.createEntities([entity]);
      expect(result).toBe(true);

      const retrieved = await adapter.getEntitiesByIds([entityId]);
      expect(retrieved).not.toBeNull();
      expect(Array.isArray(retrieved?.[0]?.names)).toBe(true);

      // All elements should be strings now
      expect(retrieved?.[0]?.names.length).toBe(5);
      expect(retrieved?.[0]?.names[0]).toBe('string');
      expect(retrieved?.[0]?.names[1]).toBe('123');
      expect(retrieved?.[0]?.names[2]).toBe('true');
      expect(typeof retrieved?.[0]?.names[3]).toBe('string'); // Object stringified
      expect(retrieved?.[0]?.names[4]).toBe('null');

      // Verify all are strings
      retrieved?.[0]?.names.forEach((name) => {
        expect(typeof name).toBe('string');
      });
    });

    /**
     * Test: Sets with non-string elements should convert all to strings
     *
     * WHY: Sets might contain non-string values (numbers, objects, etc).
     * These need to be converted to strings to prevent database errors.
     *
     * WHAT: Verify that Sets with mixed types are properly converted.
     */
    it('should convert Set elements to strings, even if non-string', async () => {
      const entityId = uuidv4() as UUID;

      const namesSet = new Set([123, 'test', true, 456]);

      const entity: any = {
        id: entityId,
        agentId: testAgentId,
        names: namesSet, // Set with mixed types
        metadata: { type: 'mixed-set' },
      };

      const result = await adapter.createEntities([entity]);
      expect(result).toBe(true);

      const retrieved = await adapter.getEntitiesByIds([entityId]);
      expect(retrieved).not.toBeNull();
      expect(Array.isArray(retrieved?.[0]?.names)).toBe(true);

      // All elements should be strings now
      expect(retrieved?.[0]?.names.length).toBe(4);
      expect(retrieved?.[0]?.names).toContain('123');
      expect(retrieved?.[0]?.names).toContain('test');
      expect(retrieved?.[0]?.names).toContain('true');
      expect(retrieved?.[0]?.names).toContain('456');

      // Verify all are strings
      retrieved?.[0]?.names.forEach((name) => {
        expect(typeof name).toBe('string');
      });
    });

    /**
     * Test: Custom iterables should be handled correctly
     *
     * WHY: Some objects might implement Symbol.iterator and yield non-string
     * values. These need to be properly converted.
     *
     * WHAT: Verify that custom iterables are converted to string arrays.
     */
    it('should handle custom iterable with non-string values', async () => {
      const entityId = uuidv4() as UUID;

      // Create a custom iterable
      const customIterable = {
        *[Symbol.iterator]() {
          yield 1;
          yield 2;
          yield 3;
        },
      };

      const entity: any = {
        id: entityId,
        agentId: testAgentId,
        names: customIterable, // Custom iterable yielding numbers
        metadata: { type: 'custom-iterable' },
      };

      const result = await adapter.createEntities([entity]);
      expect(result).toBe(true);

      const retrieved = await adapter.getEntitiesByIds([entityId]);
      expect(retrieved).not.toBeNull();
      expect(Array.isArray(retrieved?.[0]?.names)).toBe(true);

      // All elements should be converted to strings
      expect(retrieved?.[0]?.names).toEqual(['1', '2', '3']);
      retrieved?.[0]?.names.forEach((name) => {
        expect(typeof name).toBe('string');
      });
    });

    /**
     * Test: Map in update should also be handled correctly
     *
     * WHY: The Map bug could occur during updates, not just creation.
     *
     * WHAT: Verify that updating an entity with a Map doesn't cause issues.
     */
    it('should handle Map in update by converting entries to strings', async () => {
      const entityId = uuidv4() as UUID;

      // Create initial entity
      const entity: Entity = {
        id: entityId,
        agentId: testAgentId,
        names: ['original-name'],
        metadata: {},
      };

      await adapter.createEntities([entity]);

      // Update with Map
      const namesMap = new Map([
        ['updated', 'name1'],
        ['another', 'name2'],
      ]);

      const updatedEntity: any = {
        id: entityId,
        agentId: testAgentId,
        names: namesMap,
        metadata: { updated: true },
      };

      await adapter.updateEntity(updatedEntity);

      const retrieved = await adapter.getEntitiesByIds([entityId]);
      expect(retrieved).not.toBeNull();
      expect(Array.isArray(retrieved?.[0]?.names)).toBe(true);
      expect(retrieved?.[0]?.names.length).toBe(2);
      expect(retrieved?.[0]?.names).toContain('updated,name1');
      expect(retrieved?.[0]?.names).toContain('another,name2');
    });
  });

  describe('deleteEntity', () => {
    it('should delete an entity by ID', async () => {
      const entity: Entity = {
        id: uuidv4() as UUID,
        agentId: testAgentId,
        names: ['Entity to Delete'],
        metadata: { type: 'test' },
      };

      // Create entity
      await adapter.createEntities([entity]);

      // Verify it exists
      let retrieved = await adapter.getEntitiesByIds([entity.id!]);
      expect(retrieved).toHaveLength(1);

      // Delete entity
      await adapter.deleteEntity(entity.id!);

      // Verify it's deleted
      retrieved = await adapter.getEntitiesByIds([entity.id!]);
      expect(retrieved).toHaveLength(0);
    });

    it('should not throw when deleting non-existent entity', async () => {
      const nonExistentId = uuidv4() as UUID;
      // Should not throw - deleteEntity should handle non-existent entities gracefully
      await adapter.deleteEntity(nonExistentId);
    });
  });

  describe('getEntitiesByNames', () => {
    it('should retrieve entities by names', async () => {
      const entity1: Entity = {
        id: uuidv4() as UUID,
        agentId: testAgentId,
        names: ['John Doe', 'Johnny'],
        metadata: { type: 'person' },
      };

      const entity2: Entity = {
        id: uuidv4() as UUID,
        agentId: testAgentId,
        names: ['Jane Doe', 'Janet'],
        metadata: { type: 'person' },
      };

      const entity3: Entity = {
        id: uuidv4() as UUID,
        agentId: testAgentId,
        names: ['Bob Smith'],
        metadata: { type: 'person' },
      };

      // Create entities
      await adapter.createEntities([entity1, entity2, entity3]);

      // Search for entities with Doe names
      const doeEntities = await adapter.getEntitiesByNames({
        names: ['John Doe', 'Jane Doe'],
        agentId: testAgentId,
      });

      expect(doeEntities).toHaveLength(2);
      expect(doeEntities.map((e) => e.id)).toContain(entity1.id);
      expect(doeEntities.map((e) => e.id)).toContain(entity2.id);
    });

    it('should return empty array when no entities match', async () => {
      const result = await adapter.getEntitiesByNames({
        names: ['Non Existent Name'],
        agentId: testAgentId,
      });

      expect(result).toEqual([]);
    });
  });

  describe('searchEntitiesByName', () => {
    it('should search entities by partial name match', async () => {
      const entities: Entity[] = [
        {
          id: uuidv4() as UUID,
          agentId: testAgentId,
          names: ['Alice Smith', 'Alicia'],
          metadata: { type: 'person' },
        },
        {
          id: uuidv4() as UUID,
          agentId: testAgentId,
          names: ['Bob Johnson'],
          metadata: { type: 'person' },
        },
        {
          id: uuidv4() as UUID,
          agentId: testAgentId,
          names: ['Alice Cooper', 'Al Cooper'],
          metadata: { type: 'person' },
        },
      ];

      // Create entities
      for (const entity of entities) {
        await adapter.createEntities([entity]);
      }

      // Search for entities with 'Alice' in name
      const searchResults = await adapter.searchEntitiesByName({
        query: 'Alice',
        agentId: testAgentId,
        limit: 10,
      });

      expect(searchResults).toHaveLength(2);
      expect(
        searchResults.every((e) => e.names.some((name) => name.toLowerCase().includes('alice')))
      ).toBe(true);
    });

    it('should respect the limit parameter', async () => {
      const entities: Entity[] = [];
      for (let i = 0; i < 5; i++) {
        entities.push({
          id: uuidv4() as UUID,
          agentId: testAgentId,
          names: [`Test Entity ${i}`],
          metadata: { index: i },
        });
      }

      // Create entities
      await adapter.createEntities(entities);

      // Search with limit
      const results = await adapter.searchEntitiesByName({
        query: 'Test',
        agentId: testAgentId,
        limit: 2,
      });

      expect(results).toHaveLength(2);
    });

    it('should return all entities when query is empty', async () => {
      const entities: Entity[] = [
        {
          id: uuidv4() as UUID,
          agentId: testAgentId,
          names: ['Entity 1'],
          metadata: {},
        },
        {
          id: uuidv4() as UUID,
          agentId: testAgentId,
          names: ['Entity 2'],
          metadata: {},
        },
      ];

      await adapter.createEntities(entities);

      const results = await adapter.searchEntitiesByName({
        query: '',
        agentId: testAgentId,
        limit: 10,
      });

      expect(results.length).toBeGreaterThanOrEqual(2);
    });

    it('should perform case-insensitive search', async () => {
      const entity: Entity = {
        id: uuidv4() as UUID,
        agentId: testAgentId,
        names: ['UPPERCASE NAME', 'MixedCase Name'],
        metadata: {},
      };

      await adapter.createEntities([entity]);

      // Search with lowercase
      let results = await adapter.searchEntitiesByName({
        query: 'uppercase',
        agentId: testAgentId,
      });
      expect(results).toHaveLength(1);

      // Search with different case
      results = await adapter.searchEntitiesByName({
        query: 'MIXEDCASE',
        agentId: testAgentId,
      });
      expect(results).toHaveLength(1);
    });
  });
});
