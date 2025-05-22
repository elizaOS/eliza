import { describe, expect, it, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import { PgliteDatabaseAdapter } from '../../src/pglite/adapter';
import { PGliteClientManager } from '../../src/pglite/manager';
import { type UUID, type Entity, type Room, type World, type Agent } from '@elizaos/core';
import {
  componentTestAgentSettings,
  componentTestEntity,
  componentTestRoom,
  componentTestComponents,
  componentTestWorld,
  componentTestSourceEntity,
} from './seed';
import { v4 as uuidv4 } from 'uuid';
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

describe('Component Integration Tests', () => {
  // Database connection variables
  let connectionManager: PGliteClientManager;
  let adapter: PgliteDatabaseAdapter;
  let testAgentId: UUID;
  let testEntityId: UUID;
  let testSourceEntityId: UUID;
  let testRoomId: UUID;
  let testWorldId: UUID;

  beforeAll(async () => {
    // Use the shared test IDs
    testAgentId = componentTestAgentSettings.id as UUID;
    testEntityId = componentTestEntity.id;
    testSourceEntityId = componentTestSourceEntity.id;
    testRoomId = componentTestRoom.id;
    testWorldId = componentTestWorld.id;

    // Initialize connection manager and adapter
    connectionManager = new PGliteClientManager({});
    await connectionManager.initialize();
    adapter = new PgliteDatabaseAdapter(testAgentId, connectionManager);
    await adapter.init();

    try {
      // Use ensureAgentExists instead of createAgent
      await adapter.createAgent(componentTestAgentSettings as Agent);

      // Create the test world
      const worldId = await adapter.createWorld({
        ...componentTestWorld,
        agentId: testAgentId,
      } as World);

      // Create the test entity
      await adapter.createEntity({
        ...componentTestEntity,
        agentId: testAgentId,
      } as Entity);

      // Create the source entity
      await adapter.createEntity({
        ...componentTestSourceEntity,
        agentId: testAgentId,
      } as Entity);

      // Create the test room
      await adapter.createRooms([
        {
          ...componentTestRoom,
          agentId: testAgentId,
          worldId: worldId,
        } as Room,
      ]);
    } catch (error) {
      console.error('Error in setup:', error);
      throw error;
    }
  }, 10000);

  afterAll(async () => {
    // Clean up test data
    const client = connectionManager.getConnection();
    try {
      // Delete test data in correct order due to foreign key constraints
      await client.query(
        `DELETE FROM components WHERE "entityId" = '${testEntityId}' OR "sourceEntityId" = '${testSourceEntityId}'`
      );
      await client.query(
        `DELETE FROM entities WHERE id = '${testEntityId}' OR id = '${testSourceEntityId}'`
      );
      await client.query(`DELETE FROM rooms WHERE id = '${testRoomId}'`);
      await client.query(`DELETE FROM worlds WHERE id = '${testWorldId}'`);
      await client.query(`DELETE FROM agents WHERE id = '${testAgentId}'`);
    } catch (error) {
      console.error('Error cleaning test data:', error);
    }
    // Close all connections
    await adapter.close();
  }, 10000);

  beforeEach(async () => {
    // Clean up any existing components for our test entity
    try {
      const client = connectionManager.getConnection();
      await client.query(`DELETE FROM components WHERE "entityId" = '${testEntityId}'`);
    } catch (error) {
      console.error('Error cleaning test component data:', error);
    }
  });

  afterEach(async () => {
    vi.clearAllMocks();
  });

  describe('createComponent', () => {
    it('should successfully create a basic component', async () => {
      const component = componentTestComponents.basic;

      const result = await adapter.createComponent(component);

      expect(result).toBe(true);

      // Verify the component was created
      const retrievedComponent = await adapter.getComponent(component.entityId, component.type);

      expect(retrievedComponent).not.toBeNull();
      expect(retrievedComponent?.id).toBe(component.id);
      expect(retrievedComponent?.type).toBe(component.type);
      expect(retrievedComponent?.data).toEqual(component.data);
    });

    it('should create a component with worldId', async () => {
      const component = componentTestComponents.withWorldId;

      const result = await adapter.createComponent(component);

      expect(result).toBe(true);

      // Verify the component was created with the correct worldId
      const retrievedComponent = await adapter.getComponent(
        component.entityId,
        component.type,
        component.worldId
      );

      expect(retrievedComponent).not.toBeNull();
      expect(retrievedComponent?.worldId).toBe(component.worldId);
      expect(retrievedComponent?.data).toEqual(component.data);
    });

    it('should create a component with sourceEntityId', async () => {
      const component = componentTestComponents.withSourceEntity;

      const result = await adapter.createComponent(component);

      expect(result).toBe(true);

      // Verify the component was created with the correct sourceEntityId
      const retrievedComponent = await adapter.getComponent(
        component.entityId,
        component.type,
        undefined,
        component.sourceEntityId
      );

      expect(retrievedComponent).not.toBeNull();
      expect(retrievedComponent?.sourceEntityId).toBe(component.sourceEntityId);
      expect(retrievedComponent?.data).toEqual(component.data);
    });
  });

  describe('getComponent', () => {
    it('should retrieve a component by entityId and type', async () => {
      // Create a component first
      const component = componentTestComponents.basic;
      await adapter.createComponent(component);

      // Retrieve the component
      const retrievedComponent = await adapter.getComponent(component.entityId, component.type);

      expect(retrievedComponent).not.toBeNull();
      expect(retrievedComponent?.id).toBe(component.id);
      expect(retrievedComponent?.entityId).toBe(component.entityId);
      expect(retrievedComponent?.agentId).toBe(component.agentId);
      expect(retrievedComponent?.roomId).toBe(component.roomId);
      expect(retrievedComponent?.type).toBe(component.type);
      expect(retrievedComponent?.data).toEqual(component.data);
    });

    it('should return null for a non-existent component', async () => {
      const result = await adapter.getComponent(uuidv4() as UUID, 'non_existent_type');

      expect(result).toBeNull();
    });

    it('should retrieve a component with worldId', async () => {
      // Create a component with worldId
      const component = componentTestComponents.withWorldId;
      await adapter.createComponent(component);

      // Retrieve with worldId
      const retrievedComponent = await adapter.getComponent(
        component.entityId,
        component.type,
        component.worldId
      );

      expect(retrievedComponent).not.toBeNull();
      expect(retrievedComponent?.worldId).toBe(component.worldId);
    });

    it('should retrieve a component with sourceEntityId', async () => {
      // Create a component with sourceEntityId
      const component = componentTestComponents.withSourceEntity;
      await adapter.createComponent(component);

      // Retrieve with sourceEntityId
      const retrievedComponent = await adapter.getComponent(
        component.entityId,
        component.type,
        undefined,
        component.sourceEntityId
      );

      expect(retrievedComponent).not.toBeNull();
      expect(retrievedComponent?.sourceEntityId).toBe(component.sourceEntityId);
    });
  });

  describe('getComponents', () => {
    it('should retrieve all components for an entity', async () => {
      // Create multiple components for the same entity
      await adapter.createComponent(componentTestComponents.basic);
      await adapter.createComponent(componentTestComponents.withWorldId);
      await adapter.createComponent(componentTestComponents.withSourceEntity);

      // Retrieve all components
      const components = await adapter.getComponents(testEntityId);

      expect(components).toHaveLength(3);

      // Verify all components are in the result
      const componentIds = components.map((c) => c.id);
      expect(componentIds).toContain(componentTestComponents.basic.id);
      expect(componentIds).toContain(componentTestComponents.withWorldId.id);
      expect(componentIds).toContain(componentTestComponents.withSourceEntity.id);
    });

    it('should filter components by worldId', async () => {
      // Create multiple components
      await adapter.createComponent(componentTestComponents.basic);
      await adapter.createComponent(componentTestComponents.withWorldId);

      // Retrieve components filtered by worldId
      const components = await adapter.getComponents(
        testEntityId,
        componentTestComponents.withWorldId.worldId
      );

      expect(components).toHaveLength(1);
      expect(components[0].id).toBe(componentTestComponents.withWorldId.id);
    });

    it('should filter components by sourceEntityId', async () => {
      // Create multiple components
      await adapter.createComponent(componentTestComponents.basic);
      await adapter.createComponent(componentTestComponents.withSourceEntity);

      // Retrieve components filtered by sourceEntityId
      const components = await adapter.getComponents(
        testEntityId,
        undefined,
        componentTestComponents.withSourceEntity.sourceEntityId
      );

      expect(components).toHaveLength(1);
      expect(components[0].id).toBe(componentTestComponents.withSourceEntity.id);
    });

    it('should return an empty array for an entity with no components', async () => {
      const nonExistentEntityId = uuidv4() as UUID;

      const components = await adapter.getComponents(nonExistentEntityId);

      expect(components).toHaveLength(0);
    });
  });

  describe('updateComponent', () => {
    it('should update an existing component', async () => {
      // Create a component first
      const component = componentTestComponents.basic;
      await adapter.createComponent(component);

      // Update the component
      const updatedData = { value: 'updated component data' };
      const updatedComponent = {
        ...component,
        data: updatedData,
      };

      await adapter.updateComponent(updatedComponent);

      // Verify the component was updated
      const retrievedComponent = await adapter.getComponent(component.entityId, component.type);

      expect(retrievedComponent).not.toBeNull();
      expect(retrievedComponent?.data).toEqual(updatedData);
    });
  });

  describe('deleteComponent', () => {
    it('should delete an existing component', async () => {
      // Create a component first
      const component = componentTestComponents.basic;
      await adapter.createComponent(component);

      // Delete the component
      await adapter.deleteComponent(component.id);

      // Verify the component was deleted
      const retrievedComponent = await adapter.getComponent(component.entityId, component.type);

      expect(retrievedComponent).toBeNull();
    });

    it('should not throw when deleting a non-existent component', async () => {
      const nonExistentId = uuidv4() as UUID;

      // This should not throw
      await expect(adapter.deleteComponent(nonExistentId)).resolves.not.toThrow();
    });
  });
});
