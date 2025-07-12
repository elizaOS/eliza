import { type Agent, stringToUuid, type UUID } from '@elizaos/core';
import { v4 as uuidv4 } from 'uuid';
import { describe, it, expect, beforeEach, beforeAll, afterAll } from 'bun:test';
import { PgDatabaseAdapter } from '../../pg/adapter';
import { PgliteDatabaseAdapter } from '../../pglite/adapter';
import { agentTable } from '../../schema';
import { mockCharacter } from '../fixtures';
import { createIsolatedTestDatabase, createTestDatabase } from '../test-helpers';

describe('Agent Integration Tests', () => {
  let adapter: PgliteDatabaseAdapter | PgDatabaseAdapter;
  let cleanup: () => Promise<void>;
  let testAgentId: UUID;
  let testAgent: Agent;

  beforeAll(async () => {
    const setup = await createIsolatedTestDatabase('agent-tests');
    adapter = setup.adapter;
    cleanup = setup.cleanup;
    testAgentId = setup.testAgentId;
  });

  beforeEach(() => {
    // Reset or seed data before each test if needed
    testAgent = {
      id: testAgentId,
      name: 'Test Agent',
      bio: 'A test agent for running tests.',
      system: 'You are a helpful assistant.',
      plugins: [],
      settings: { testSetting: 'test value' },
      createdAt: new Date().getTime(),
      updatedAt: new Date().getTime(),
      enabled: true,
      username: 'test_agent',
    };
  });

  afterAll(async () => {
    if (cleanup) {
      await cleanup();
    }
  });

  describe('Agent Tests', () => {
    beforeEach(async () => {
      // Clean up agents table before each test
      await adapter.getDatabase().delete(agentTable);
      // Re-create the test agent
      await adapter.createAgent({
        id: testAgentId,
        ...mockCharacter,
      } as Agent);
    });

    describe('createAgent', () => {
      it('should successfully create an agent', async () => {
        const newAgentId = stringToUuid('new-test-agent-create');
        const newAgent: Agent = {
          id: newAgentId,
          name: 'Integration Test Create',
          enabled: true,
          createdAt: Date.now(),
          updatedAt: Date.now(),
          username: 'integration-create',
          system: 'System message',
          bio: ['Bio line 1'],
          messageExamples: [],
          postExamples: [],
          topics: [],
          adjectives: [],
          knowledge: [],
          plugins: [],
          settings: {},
          style: {},
        };

        const result = await adapter.createAgent(newAgent);
        expect(result).toBe(true);

        const createdAgent = await adapter.getAgent(newAgent.id as UUID);
        expect(createdAgent).not.toBeNull();
        expect(createdAgent?.name).toBe(newAgent.name);
      });

      it('should return false when creating an agent with a duplicate name', async () => {
        const agent1Id = stringToUuid('duplicate-name-agent-1');
        const agent1: Agent = {
          id: agent1Id,
          name: 'duplicate-name',
          enabled: true,
          createdAt: Date.now(),
          updatedAt: Date.now(),
          username: 'duplicate-name-1',
          system: 'System message',
          bio: ['Bio line 1'],
          messageExamples: [],
          postExamples: [],
          topics: [],
          adjectives: [],
          knowledge: [],
          plugins: [],
          settings: {},
          style: {},
        };
        await adapter.createAgent(agent1);

        const agent2Id = stringToUuid('duplicate-name-agent-2');
        const agent2: Agent = {
          id: agent2Id,
          name: 'duplicate-name',
          enabled: true,
          createdAt: Date.now(),
          updatedAt: Date.now(),
          username: 'duplicate-name-2',
          system: 'System message',
          bio: ['Bio line 1'],
          messageExamples: [],
          postExamples: [],
          topics: [],
          adjectives: [],
          knowledge: [],
          plugins: [],
          settings: {},
          style: {},
        };
        const result = await adapter.createAgent(agent2);
        expect(result).toBe(false);
      });

      it('should return false when creating an agent with a duplicate ID', async () => {
        const agent1 = {
          ...testAgent,
          id: uuidv4() as UUID,
          name: 'Duplicate ID Test 1',
        };
        const created = await adapter.createAgent(agent1);
        expect(created).toBe(true);

        const agent2 = {
          ...testAgent,
          id: agent1.id, // Same ID
          name: 'Duplicate ID Test 2',
        };

        const result = await adapter.createAgent(agent2);
        expect(result).toBe(false);
      });

      it('should create agent with complex settings structure', async () => {
        // Create an agent with complex settings
        const complexSettings = {
          apiSettings: {
            endpoints: {
              primary: 'https://api.example.com',
              secondary: 'https://backup.example.com',
            },
            auth: {
              type: 'oauth',
              tokens: {
                access: 'access-token',
                refresh: 'refresh-token',
              },
            },
          },
          preferences: {
            theme: 'dark',
            notifications: true,
            languages: ['en', 'fr', 'es'],
          },
          features: [
            { id: 'feature1', enabled: true, config: { timeout: 1000 } },
            { id: 'feature2', enabled: false },
          ],
        };

        const newAgent = {
          ...testAgent,
          id: uuidv4() as UUID,
          name: 'Integration Test Complex Settings',
          settings: complexSettings,
        };

        const result = await adapter.createAgent(newAgent);
        expect(result).toBe(true);

        // Verify the complex settings were stored correctly
        const createdAgent = await adapter.getAgent(newAgent.id);
        expect(createdAgent?.settings?.apiSettings?.['endpoints']?.primary).toBe(
          'https://api.example.com'
        );
        expect(createdAgent?.settings?.apiSettings?.['auth']?.tokens?.refresh).toBe(
          'refresh-token'
        );
        expect(createdAgent?.settings?.preferences?.['languages']).toEqual(['en', 'fr', 'es']);
        expect(createdAgent?.settings?.features?.[0]?.id).toBe('feature1');
        expect(createdAgent?.settings?.features?.[1]?.enabled).toBe(false);
      });

      it('should handle creating agent with missing optional fields', async () => {
        // Create an agent with minimal required fields
        const minimalAgent = {
          id: uuidv4() as UUID,
          name: 'Minimal Agent',
          bio: 'Just the required fields',
          createdAt: new Date().getTime(),
          updatedAt: new Date().getTime(),
        };

        const result = await adapter.createAgent(minimalAgent);
        expect(result).toBe(true);

        // Verify the agent was created with default values for missing fields
        const createdAgent = await adapter.getAgent(minimalAgent.id);
        expect(createdAgent).not.toBeNull();
        expect(createdAgent?.name).toBe(minimalAgent.name);
        expect(createdAgent?.enabled).toBe(true); // Should use the default value
        expect(createdAgent?.settings).toEqual({}); // Should have empty settings object
      });
    });

    describe('getAgent and getAgents', () => {
      it('should retrieve an agent by ID', async () => {
        // Create an agent first
        const newAgent = {
          ...testAgent,
          id: uuidv4() as UUID,
          name: 'Integration Test Get Agent',
        };

        await adapter.createAgent(newAgent);

        // Retrieve the agent
        const result = await adapter.getAgent(newAgent.id);

        expect(result).not.toBeNull();
        expect(result?.id).toBe(newAgent.id);
        expect(result?.name).toBe(newAgent.name);
      });

      it('should return null for non-existent agent ID', async () => {
        const nonExistentId = uuidv4() as UUID;

        const result = await adapter.getAgent(nonExistentId);

        expect(result).toBeNull();
      });

      it('should retrieve all agents', async () => {
        // Create multiple agents
        const agent1 = {
          ...testAgent,
          id: uuidv4() as UUID,
          name: 'Integration Test Agent 1',
        };

        const agent2 = {
          ...testAgent,
          id: uuidv4() as UUID,
          name: 'Integration Test Agent 2',
        };

        await adapter.createAgent(agent1);
        await adapter.createAgent(agent2);

        // Retrieve all agents
        const agents = await adapter.getAgents();

        // Verify at least our test agents are included
        const testAgents = agents.filter((a) => a.name === agent1.name || a.name === agent2.name);

        expect(testAgents.length).toBeGreaterThanOrEqual(2);
        expect(testAgents.some((a) => a.id === agent1.id)).toBe(true);
        expect(testAgents.some((a) => a.id === agent2.id)).toBe(true);
      });
    });

    describe('updateAgent', () => {
      it('should update an existing agent', async () => {
        // Create an agent first
        const newAgent = {
          ...testAgent,
          id: uuidv4() as UUID,
          name: 'Integration Test Update',
        };

        await adapter.createAgent(newAgent);

        // Update the agent
        const updateData: Partial<Agent> = {
          bio: 'Updated bio',
          settings: {
            updatedSetting: 'new value',
          },
        };

        const result = await adapter.updateAgent(newAgent.id, updateData);

        expect(result).toBe(true);

        // Verify the agent was updated
        const updatedAgent = await adapter.getAgent(newAgent.id);
        expect(updatedAgent?.bio).toBe(updateData.bio as string);
        expect(updatedAgent?.settings).toHaveProperty('updatedSetting', 'new value');
      });

      it('should merge settings when updating', async () => {
        // Create an agent with initial settings
        const newAgent = {
          ...testAgent,
          id: uuidv4() as UUID,
          name: 'Integration Test Settings Merge',
          settings: {
            initialSetting: 'initial value',
            toBeKept: 'keep this value',
          },
        };

        await adapter.createAgent(newAgent);

        // Update with new settings
        const updateData: Partial<Agent> = {
          settings: {
            initialSetting: 'updated value', // Update existing setting
            newSetting: 'new value', // Add new setting
            // toBeKept is not mentioned, should be kept
          },
        };

        await adapter.updateAgent(newAgent.id, updateData);

        // Verify the settings were properly merged
        const updatedAgent = await adapter.getAgent(newAgent.id);
        expect(updatedAgent?.settings).toHaveProperty('initialSetting', 'updated value');
        expect(updatedAgent?.settings).toHaveProperty('newSetting', 'new value');
        expect(updatedAgent?.settings).toHaveProperty('toBeKept', 'keep this value');
      });

      it('should remove settings when set to null', async () => {
        // Create an agent with initial settings
        const newAgent = {
          ...testAgent,
          id: uuidv4() as UUID,
          name: 'Integration Test Settings Remove',
          settings: {
            initialSetting: 'initial value',
            toBeRemoved: 'remove this value',
            toBeKept: 'keep this value',
            secrets: {
              password: 'secret123',
              token: 'token123',
            },
          },
        };

        await adapter.createAgent(newAgent);

        // Update with null settings to remove
        const updateData: Partial<Agent> = {
          settings: {
            toBeRemoved: null, // This should be removed
            secrets: {
              password: null, // This should be removed
              token: 'newToken', // This should be updated
            },
          } as any,
        };

        await adapter.updateAgent(newAgent.id, updateData as any);

        // Verify the settings were properly updated
        const updatedAgent = await adapter.getAgent(newAgent.id);
        expect(updatedAgent?.settings).toHaveProperty('initialSetting', 'initial value');
        expect(updatedAgent?.settings).toHaveProperty('toBeKept', 'keep this value');
        expect(updatedAgent?.settings).not.toHaveProperty('toBeRemoved');
        // Check secrets only if they exist
        if (updatedAgent?.settings && updatedAgent.settings.secrets) {
          expect(updatedAgent.settings.secrets).not.toHaveProperty('password');
          expect(updatedAgent.settings.secrets).toHaveProperty('token', 'newToken');
        }
      });

      it('should update only non-settings fields', async () => {
        // Create an agent first
        const newAgent = {
          ...testAgent,
          id: uuidv4() as UUID,
          name: 'Integration Test Update Non-Settings',
          settings: {
            initialSetting: 'should remain unchanged',
          },
        };

        await adapter.createAgent(newAgent);

        // Update only non-settings fields
        const updateData: Partial<Agent> = {
          bio: 'Updated bio only',
          username: 'new_username',
        };

        const result = await adapter.updateAgent(newAgent.id, updateData);
        expect(result).toBe(true);

        // Verify the agent was updated correctly
        const updatedAgent = await adapter.getAgent(newAgent.id);
        expect(updatedAgent?.bio).toBe(updateData.bio as string);
        expect(updatedAgent?.username).toBe(updateData.username as string);
        expect(updatedAgent?.settings).toHaveProperty('initialSetting', 'should remain unchanged');
      });

      it('should update only settings fields', async () => {
        // Create an agent first
        const newAgent = {
          ...testAgent,
          id: uuidv4() as UUID,
          name: 'Integration Test Update Settings Only',
          bio: 'Original bio',
        };

        await adapter.createAgent(newAgent);

        // Update only settings
        const updateData: Partial<Agent> = {
          settings: {
            newSetting: 'settings only update',
          },
        };

        const result = await adapter.updateAgent(newAgent.id, updateData);
        expect(result).toBe(true);

        // Verify the agent was updated correctly
        const updatedAgent = await adapter.getAgent(newAgent.id);
        expect(updatedAgent?.bio).toBe(newAgent.bio); // Bio should remain unchanged
        expect(updatedAgent?.settings).toHaveProperty('newSetting', 'settings only update');
        expect(updatedAgent?.settings).toHaveProperty('testSetting', 'test value'); // Original setting should be kept
      });

      it('should remove top-level and nested secret settings when set to null', async () => {
        // Create an agent with initial settings
        const agentId = uuidv4() as UUID;
        const initialAgent = {
          id: agentId,
          name: 'Test Agent Settings Removal',
          username: 'test_settings_removal',
          bio: 'test bio',
          settings: {
            topLevelToBeRemoved: 'keep this for a moment',
            anotherTopLevel: 'this should stay',
            secrets: {
              secretKeyToRemove: 'secret value to be removed',
              anotherSecret: 'this secret should also stay',
            },
            nestedObject: {
              prop1: 'value1',
              propToRemove: 'will be removed',
            },
          },
          createdAt: new Date().getTime(),
          updatedAt: new Date().getTime(),
        };
        await adapter.createAgent(initialAgent);

        // Update: set a top-level key, a secret key, and a nested object key to null
        const updateData: Partial<Agent> = {
          settings: {
            topLevelToBeRemoved: null,
            secrets: {
              secretKeyToRemove: null,
            },
            nestedObject: {
              propToRemove: null,
            },
          } as any,
        };

        await adapter.updateAgent(agentId, updateData as any);

        const updatedAgent = await adapter.getAgent(agentId);
        expect(updatedAgent?.settings).not.toHaveProperty('topLevelToBeRemoved');
        expect(updatedAgent?.settings?.anotherTopLevel).toBe('this should stay');
        expect(updatedAgent?.settings?.secrets).not.toHaveProperty('secretKeyToRemove');
        expect(updatedAgent?.settings?.secrets?.['anotherSecret']).toBe(
          'this secret should also stay'
        );
        expect(updatedAgent?.settings?.nestedObject).not.toHaveProperty('propToRemove');
        expect(updatedAgent?.settings?.nestedObject?.['prop1']).toBe('value1');
      });

      it('should correctly remove specific secrets from a complex settings object when set to null', async () => {
        const agentId = uuidv4() as UUID;
        const initialAgentSettings = {
          avatar: 'data:image/jpeg;base64,short_mock_base64_string',
          secrets: {
            DISCORD_API_TOKEN: 'discord_token_old',
            ELEVENLABS_VOICE_ID: 'elevenlabs_voice_id_old',
            ELEVENLABS_XI_API_KEY: 'elevenlabs_xi_api_key_old',
            DISCORD_APPLICATION_ID: 'discord_app_id_old',
            PERPLEXITY_API_KEY: 'perplexity_api_key_to_keep',
          },
          someOtherSetting: 'should_remain',
        };

        const agentToCreate: Agent = {
          id: agentId,
          name: 'Complex Secrets Agent',
          bio: 'This is a test agent with complex secrets',
          username: 'complex_secrets_agent',
          settings: initialAgentSettings,
          createdAt: new Date().getTime(),
          updatedAt: new Date().getTime(),
        };

        const creationResult = await adapter.createAgent(agentToCreate);
        expect(creationResult, 'Agent creation failed').toBe(true);

        // Verify agent was created before update
        const agentBeforeUpdate = await adapter.getAgent(agentId);
        expect(agentBeforeUpdate, 'Agent not found after creation, before update').not.toBeNull();

        // Update: set some secrets to null, and update one
        const updatePayload: Partial<Agent> = {
          settings: {
            secrets: {
              DISCORD_API_TOKEN: null, // Remove
              ELEVENLABS_VOICE_ID: null, // Remove
              ELEVENLABS_XI_API_KEY: 'elevenlabs_xi_api_key_new', // Update
            },
          },
        };

        const updateResult = await adapter.updateAgent(agentId, updatePayload as any);
        expect(updateResult, 'Agent update failed').toBe(true);

        const updatedAgent = await adapter.getAgent(agentId);
        expect(updatedAgent, 'Agent not found after update').not.toBeNull();
        expect(updatedAgent?.settings).toBeDefined();

        // Check avatar and other settings are preserved
        expect(updatedAgent?.settings?.avatar).toBe(initialAgentSettings.avatar);
        expect(updatedAgent?.settings?.someOtherSetting).toBe('should_remain');

        // Check secrets
        const updatedSecrets = updatedAgent?.settings?.secrets;
        expect(updatedSecrets).toBeDefined();
        expect(updatedSecrets).not.toHaveProperty('DISCORD_API_TOKEN');
        expect(updatedSecrets).not.toHaveProperty('ELEVENLABS_VOICE_ID');
        expect(updatedSecrets?.['ELEVENLABS_XI_API_KEY']).toBe('elevenlabs_xi_api_key_new');
        expect(updatedSecrets?.['DISCORD_APPLICATION_ID']).toBe(
          initialAgentSettings.secrets.DISCORD_APPLICATION_ID
        );
        expect(updatedSecrets?.['PERPLEXITY_API_KEY']).toBe(
          initialAgentSettings.secrets.PERPLEXITY_API_KEY
        );
      });

      it('should handle updating with empty object', async () => {
        // Create an agent first
        const newAgent = {
          ...testAgent,
          id: uuidv4() as UUID,
          name: 'Integration Test Empty Update',
        };

        await adapter.createAgent(newAgent);

        // Update with empty object
        const updateData: Partial<Agent> = {};

        const result = await adapter.updateAgent(newAgent.id, updateData);
        expect(result).toBe(true);

        // Verify the agent was not modified
        const updatedAgent = await adapter.getAgent(newAgent.id);
        expect(updatedAgent?.name).toBe(newAgent.name);
        expect(updatedAgent?.bio).toBe(newAgent.bio);
      });

      it('should handle deep nested settings objects', async () => {
        // Create an agent with nested settings
        const newAgent = {
          ...testAgent,
          id: uuidv4() as UUID,
          name: 'Integration Test Deep Nested Settings',
          settings: {
            level1: {
              level2: {
                level3: 'deep value',
                toKeep: true,
              },
              sibling: 'sibling value',
            },
          },
        };

        await adapter.createAgent(newAgent);

        // Update with deeply nested settings
        const updateData: Partial<Agent> = {
          settings: {
            level1: {
              level2: {
                level3: 'updated deep value',
                newProperty: 'new nested value',
              },
            },
          },
        };

        await adapter.updateAgent(newAgent.id, updateData);

        // Verify the deep settings were properly merged
        const updatedAgent = await adapter.getAgent(newAgent.id);
        if (updatedAgent?.settings && updatedAgent.settings.level1) {
          const level1 = updatedAgent.settings.level1 as any;
          expect(level1.sibling).toBe('sibling value'); // Should be kept

          if (level1.level2) {
            expect(level1.level2.level3).toBe('updated deep value'); // Should be updated
            expect(level1.level2.newProperty).toBe('new nested value'); // Should be added
            expect(level1.level2.toKeep).toBe(true); // Should be kept
          }
        }
      });

      it('should handle array values in settings', async () => {
        // Create an agent with array in settings
        const newAgent = {
          ...testAgent,
          id: uuidv4() as UUID,
          name: 'Integration Test Array Settings',
          settings: {
            tags: ['tag1', 'tag2', 'tag3'],
            config: {
              options: [1, 2, 3],
            },
          },
        };

        await adapter.createAgent(newAgent);

        // Update arrays in settings
        const updateData: Partial<Agent> = {
          settings: {
            tags: ['new-tag1', 'new-tag2'], // Replace entire array
            config: {
              options: [4, 5, 6, 7], // Replace nested array
            },
          },
        };

        await adapter.updateAgent(newAgent.id, updateData);

        // Verify arrays were properly updated
        const updatedAgent = await adapter.getAgent(newAgent.id);
        expect(updatedAgent?.settings?.tags).toEqual(['new-tag1', 'new-tag2']);
        if (updatedAgent?.settings?.config) {
          expect((updatedAgent.settings.config as any).options).toEqual([4, 5, 6, 7]);
        }
      });

      it('should handle non-existent agent ID', async () => {
        const nonExistentId = uuidv4() as UUID;

        // Try to update non-existent agent
        const updateData: Partial<Agent> = {
          bio: 'This should not be saved',
        };

        const result = await adapter.updateAgent(nonExistentId, updateData);

        // Should still return true as the operation didn't fail
        expect(result).toBe(true);

        // Verify the agent doesn't exist
        const agent = await adapter.getAgent(nonExistentId);
        expect(agent).toBeNull();
      });
    });

    describe('deleteAgent', () => {
      it('should delete an agent and return true', async () => {
        // Create an agent first
        const newAgent = {
          ...testAgent,
          id: uuidv4() as UUID,
          name: 'Integration Test Delete',
        };

        await adapter.createAgent(newAgent);

        // Delete the agent
        const result = await adapter.deleteAgent(newAgent.id);

        expect(result).toBe(true);

        // Verify the agent was deleted
        const deletedAgent = await adapter.getAgent(newAgent.id);
        expect(deletedAgent).toBeNull();
      });

      it('should cascade delete all related data when deleting an agent', async () => {
        // Create a separate test instance for cascade delete test
        const setup = await createIsolatedTestDatabase('agent-cascade-delete');
        const cascadeAdapter = setup.adapter;
        const agentId = setup.testAgentId;

        try {
          // The agent was already created by the test helper

          // Create a world
          const worldId = uuidv4() as UUID;
          await cascadeAdapter.createWorld({
            id: worldId,
            name: 'Test World',
            agentId: agentId,
            serverId: uuidv4() as UUID,
          });

          // Create rooms
          const roomId1 = uuidv4() as UUID;
          const roomId2 = uuidv4() as UUID;
          await cascadeAdapter.createRooms([
            {
              id: roomId1,
              name: 'Test Room 1',
              agentId: agentId,
              serverId: uuidv4() as UUID,
              worldId: worldId,
              channelId: uuidv4() as UUID,
              type: 'PUBLIC' as any,
              source: 'test',
            },
            {
              id: roomId2,
              name: 'Test Room 2',
              agentId: agentId,
              serverId: uuidv4() as UUID,
              worldId: worldId,
              channelId: uuidv4() as UUID,
              type: 'PRIVATE' as any,
              source: 'test',
            },
          ]);

          // Create entities
          const entityId1 = uuidv4() as UUID;
          const entityId2 = uuidv4() as UUID;
          await cascadeAdapter.createEntities([
            {
              id: entityId1,
              agentId: agentId,
              names: ['Entity 1'],
              metadata: { type: 'test' },
            },
            {
              id: entityId2,
              agentId: agentId,
              names: ['Entity 2'],
              metadata: { type: 'test' },
            },
          ]);

          // Create memories
          const memoryId1 = await cascadeAdapter.createMemory(
            {
              id: uuidv4() as UUID,
              agentId: agentId,
              entityId: entityId1,
              roomId: roomId1,
              content: { text: 'Test memory 1' },
              createdAt: Date.now(),
              embedding: new Array(384).fill(0.1), // Create a test embedding
            },
            'test_memories'
          );

          const memoryId2 = await cascadeAdapter.createMemory(
            {
              id: uuidv4() as UUID,
              agentId: agentId,
              entityId: entityId2,
              roomId: roomId2,
              content: { text: 'Test memory 2' },
              createdAt: Date.now(),
              embedding: new Array(384).fill(0.2), // Create a test embedding
            },
            'test_memories'
          );

          // Create components
          await cascadeAdapter.createComponent({
            id: uuidv4() as UUID,
            entityId: entityId1,
            type: 'test_component',
            data: { value: 'test' },
            agentId: agentId,
            roomId: roomId1,
            worldId: worldId,
            sourceEntityId: entityId2,
            createdAt: Date.now(),
          });

          // Create participants
          await cascadeAdapter.addParticipant(entityId1, roomId1);
          await cascadeAdapter.addParticipant(entityId2, roomId2);

          // Create relationships
          await cascadeAdapter.createRelationship({
            sourceEntityId: entityId1,
            targetEntityId: entityId2,
            tags: ['test_relationship'],
            metadata: { strength: 0.8 },
          });

          // Create tasks
          const taskId = await cascadeAdapter.createTask({
            id: uuidv4() as UUID,
            name: 'Test Task',
            description: 'A test task',
            roomId: roomId1,
            worldId: worldId,
            tags: ['test'],
            metadata: { priority: 'high' },
          });

          // Create cache entries
          await cascadeAdapter.setCache('test_cache_key', { value: 'cached data' });

          // Create logs
          await cascadeAdapter.log({
            body: { action: 'test_log' },
            entityId: entityId1,
            roomId: roomId1,
            type: 'test',
          });

          // Verify all data was created
          expect(await cascadeAdapter.getWorld(worldId)).not.toBeNull();
          expect((await cascadeAdapter.getRoomsByIds([roomId1, roomId2]))?.length).toBe(2);
          expect((await cascadeAdapter.getEntitiesByIds([entityId1, entityId2]))?.length).toBe(2);
          expect(await cascadeAdapter.getMemoryById(memoryId1)).not.toBeNull();
          expect(await cascadeAdapter.getMemoryById(memoryId2)).not.toBeNull();
          expect(await cascadeAdapter.getTask(taskId)).not.toBeNull();
          expect(await cascadeAdapter.getCache('test_cache_key')).toBeDefined();

          // Now delete the agent - this should cascade delete everything
          const deleteResult = await cascadeAdapter.deleteAgent(agentId);
          expect(deleteResult).toBe(true);

          // Verify the agent is deleted
          expect(await cascadeAdapter.getAgent(agentId)).toBeNull();

          // Verify all related data is deleted via cascade
          // Worlds should be deleted
          expect(await cascadeAdapter.getWorld(worldId)).toBeNull();

          // Rooms should be deleted
          const rooms = await cascadeAdapter.getRoomsByIds([roomId1, roomId2]);
          expect(rooms).toEqual([]);

          // Entities should be deleted
          const entities = await cascadeAdapter.getEntitiesByIds([entityId1, entityId2]);
          expect(entities).toEqual([]);

          // Memories should be deleted
          expect(await cascadeAdapter.getMemoryById(memoryId1)).toBeNull();
          expect(await cascadeAdapter.getMemoryById(memoryId2)).toBeNull();

          // Tasks should be deleted
          expect(await cascadeAdapter.getTask(taskId)).toBeNull();

          // Cache should be deleted
          expect(await cascadeAdapter.getCache('test_cache_key')).toBeUndefined();

          // Components, participants, relationships, and logs should also be deleted
          // but we don't have direct methods to verify these in the adapter
          // They would be verified through database queries if needed
        } finally {
          await setup.cleanup();
        }
      });

      it('should return false when deleting non-existent agent', async () => {
        const nonExistentId = uuidv4() as UUID;

        const result = await adapter.deleteAgent(nonExistentId);

        // Should return false for non-existent agents with the new implementation
        expect(result).toBe(false);
      });

      it('should delete agent with complex data structure', async () => {
        // Create an agent with complex settings and other fields
        const complexAgent = {
          ...testAgent,
          id: uuidv4() as UUID,
          name: 'Integration Test Delete Complex',
          settings: {
            nestedObject: {
              deeplyNested: {
                value: 'test',
                array: [1, 2, 3],
              },
            },
            simpleValue: 'hello',
          },
          messageExamples: [
            [
              {
                name: 'user',
                content: {
                  text: 'Hello there',
                },
              },
              {
                name: 'assistant',
                content: {
                  text: 'Hi, how can I help you?',
                },
              },
            ],
          ],
          postExamples: ['Example post'],
          topics: ['topic1', 'topic2'],
          adjectives: ['smart', 'helpful'],
        };

        await adapter.createAgent(complexAgent);

        // Delete the agent
        const result = await adapter.deleteAgent(complexAgent.id);
        expect(result).toBe(true);

        // Verify the agent was deleted
        const deletedAgent = await adapter.getAgent(complexAgent.id);
        expect(deletedAgent).toBeNull();
      });
    });

    describe('countAgents', () => {
      it('should return the correct count of agents', async () => {
        const agent1 = {
          ...testAgent,
          id: uuidv4() as UUID,
          name: 'Count Test Agent 1',
        };
        const agent2 = {
          ...testAgent,
          id: uuidv4() as UUID,
          name: 'Count Test Agent 2',
        };
        await adapter.createAgent(agent1);
        await adapter.createAgent(agent2);
        const count = await adapter.countAgents();
        // Use toBeGreaterThanOrEqual since other tests might have created agents
        expect(count).toBeGreaterThanOrEqual(2);
      });
    });

    // Add tests for cleanupAgents if this method is implemented
    describe('cleanupAgents', () => {
      it('should clean up agents properly', async () => {
        // This test is a placeholder and should be implemented
        // if the cleanupAgents method is actually used

        // Create some test agents that would be cleaned up
        const tempAgent = {
          ...testAgent,
          id: uuidv4() as UUID,
          name: 'Integration Test Cleanup',
        };

        await adapter.createAgent(tempAgent);

        // Call the cleanup method - implementation would depend on what
        // cleanupAgents is actually supposed to do
        await adapter.cleanupAgents();

        // Add appropriate verification based on what the method should do
      });
    });
  });
});
