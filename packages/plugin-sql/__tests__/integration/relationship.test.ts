import { describe, expect, it, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import { SqliteDatabaseAdapter } from '../../src/sqlite/adapter';
import { SqliteClientManager } from '../../src/sqlite/manager';
import { type UUID } from '@elizaos/core';
import {
  relationshipTestAgentId,
  relationshipTestSourceEntityId,
  relationshipTestTargetEntityId,
  relationshipTestAgent,
  relationshipTestSourceEntity,
  relationshipTestTargetEntity,
  relationshipTestRelationships,
  createTestRelationship,
} from './seed';
import { setupMockedMigrations } from '../test-helpers';

// Setup mocked migrations before any tests run or instances are created
setupMockedMigrations();

// Mock only the logger
vi.mock('@elizaos/core', async () => {
  const actual = await vi.importActual('@elizaos/core');
  return {
    ...actual,
    logger: {
      debug: vi.fn(),
      error: vi.fn(),
      warn: vi.fn(),
      success: vi.fn(),
      info: vi.fn(),
    },
  };
});

describe('Relationship Integration Tests', () => {
  // Database connection variables
  let connectionManager: SqliteClientManager;
  let adapter: SqliteDatabaseAdapter;
  let agentId: UUID = relationshipTestAgentId;

  beforeAll(async () => {
    // Initialize connection manager and adapter
    connectionManager = new SqliteClientManager({});
    await connectionManager.initialize();
    adapter = new SqliteDatabaseAdapter(agentId, connectionManager);
    await adapter.init();

    try {
      // Step 1: Create test agent
      await adapter.createAgent(relationshipTestAgent);

      // Step 2: Create test source entity
      await adapter.createEntities([relationshipTestSourceEntity]);

      // Step 3: Create test target entity
      await adapter.createEntities([relationshipTestTargetEntity]);
    } catch (error) {
      console.error('Error in setup:', error);
      throw error;
    }
  }, 10000);

  afterAll(async () => {
    // Clean up test data
    const client = connectionManager.getConnection();
    try {
      // Order matters for foreign key constraints
      await client.query('DELETE FROM relationships WHERE TRUE');
      await client.query(
        `DELETE FROM entities WHERE id IN ('${relationshipTestSourceEntityId}', '${relationshipTestTargetEntityId}')`
      );
      await client.query(`DELETE FROM agents WHERE id = '${relationshipTestAgentId}'`);
    } catch (error) {
      console.error('Error cleaning test data:', error);
    }

    // Close all connections
    await adapter.close();
  }, 10000);

  beforeEach(async () => {
    // Clean up any existing test relationships before each test
    const client = connectionManager.getConnection();
    try {
      await client.query('DELETE FROM relationships WHERE TRUE');
    } catch (error) {
      console.error('Error cleaning test relationship data:', error);
    }
  });

  afterEach(async () => {
    vi.clearAllMocks();
  });

  describe('Relationship CRUD Operations', () => {
    it('should create a relationship between entities', async () => {
      const relationship = relationshipTestRelationships[0];

      const result = await adapter.createRelationship({
        sourceEntityId: relationship.sourceEntityId,
        targetEntityId: relationship.targetEntityId,
        tags: relationship.tags,
        metadata: relationship.metadata,
      });

      expect(result).toBe(true);

      // Verify the relationship exists
      const createdRelationship = await adapter.getRelationship({
        sourceEntityId: relationship.sourceEntityId,
        targetEntityId: relationship.targetEntityId,
      });

      expect(createdRelationship).not.toBeNull();
      expect(createdRelationship?.sourceEntityId).toBe(relationship.sourceEntityId);
      expect(createdRelationship?.targetEntityId).toBe(relationship.targetEntityId);
      expect(createdRelationship?.tags).toEqual(relationship.tags);
      expect(createdRelationship?.metadata).toEqual(relationship.metadata);
    });

    it('should update an existing relationship', async () => {
      // Create a relationship first
      const relationship = relationshipTestRelationships[0];
      await adapter.createRelationship({
        sourceEntityId: relationship.sourceEntityId,
        targetEntityId: relationship.targetEntityId,
        tags: relationship.tags,
        metadata: relationship.metadata,
      });

      // Get the created relationship
      const createdRelationship = await adapter.getRelationship({
        sourceEntityId: relationship.sourceEntityId,
        targetEntityId: relationship.targetEntityId,
      });

      expect(createdRelationship).not.toBeNull();

      // Update the relationship
      const updatedTags = ['friend', 'updated'];
      const updatedMetadata = {
        type: 'social',
        strength: 'very high',
        updated: true,
      };

      await adapter.updateRelationship({
        id: createdRelationship!.id,
        sourceEntityId: relationship.sourceEntityId,
        targetEntityId: relationship.targetEntityId,
        agentId: relationship.agentId,
        tags: updatedTags,
        metadata: updatedMetadata,
      });

      // Retrieve the updated relationship
      const updatedRelationship = await adapter.getRelationship({
        sourceEntityId: relationship.sourceEntityId,
        targetEntityId: relationship.targetEntityId,
      });

      expect(updatedRelationship).not.toBeNull();
      expect(updatedRelationship?.tags).toEqual(updatedTags);
      expect(updatedRelationship?.metadata).toEqual(updatedMetadata);
    });

    it('should retrieve relationships by entity ID', async () => {
      // Create multiple relationships
      for (const relationship of relationshipTestRelationships) {
        await adapter.createRelationship({
          sourceEntityId: relationship.sourceEntityId,
          targetEntityId: relationship.targetEntityId,
          tags: relationship.tags,
          metadata: relationship.metadata,
        });
      }

      // Get relationships for source entity
      const sourceRelationships = await adapter.getRelationships({
        entityId: relationshipTestSourceEntityId,
      });

      // There should be at least one relationship where the entity is source or target
      expect(sourceRelationships.length).toBeGreaterThan(0);

      // Verify relationship properties
      const foundSourceRel = sourceRelationships.find(
        (r) =>
          r.sourceEntityId === relationshipTestSourceEntityId &&
          r.targetEntityId === relationshipTestTargetEntityId
      );

      expect(foundSourceRel).toBeDefined();
      expect(foundSourceRel?.tags).toContain('friend');

      // Get relationships for target entity
      const targetRelationships = await adapter.getRelationships({
        entityId: relationshipTestTargetEntityId,
      });

      // There should be at least one relationship where the entity is source or target
      expect(targetRelationships.length).toBeGreaterThan(0);
    });

    it('should filter relationships by tags', async () => {
      // Create relationships with different tags
      const friendRelationship = createTestRelationship(
        relationshipTestSourceEntityId,
        relationshipTestTargetEntityId,
        ['friend', 'close'],
        { type: 'personal' }
      );

      const colleagueRelationship = createTestRelationship(
        relationshipTestTargetEntityId,
        relationshipTestSourceEntityId,
        ['colleague', 'professional'],
        { type: 'work' }
      );

      // Create both relationships
      await adapter.createRelationship({
        sourceEntityId: friendRelationship.sourceEntityId,
        targetEntityId: friendRelationship.targetEntityId,
        tags: friendRelationship.tags,
        metadata: friendRelationship.metadata,
      });

      await adapter.createRelationship({
        sourceEntityId: colleagueRelationship.sourceEntityId,
        targetEntityId: colleagueRelationship.targetEntityId,
        tags: colleagueRelationship.tags,
        metadata: colleagueRelationship.metadata,
      });

      // Filter by 'friend' tag
      const friendRelationships = await adapter.getRelationships({
        entityId: relationshipTestSourceEntityId,
        tags: ['friend'],
      });

      expect(friendRelationships.length).toBeGreaterThan(0);
      expect(friendRelationships[0].tags).toContain('friend');
      expect(friendRelationships[0].tags).toContain('close');

      // Filter by 'colleague' tag
      const colleagueRelationships = await adapter.getRelationships({
        entityId: relationshipTestSourceEntityId,
        tags: ['colleague'],
      });

      expect(colleagueRelationships.length).toBeGreaterThan(0);
      expect(colleagueRelationships[0].tags).toContain('colleague');
      expect(colleagueRelationships[0].tags).toContain('professional');
    });
  });
});
