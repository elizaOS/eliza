import { describe, expect, it, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import { SqliteDatabaseAdapter } from '../../src/sqlite/adapter';
import { PGliteClientManager } from '../../src/sqlite/manager';
import { type UUID, type Agent } from '@elizaos/core';
import { agentTable } from '../../src/schema/agent';
import { sql } from 'drizzle-orm';
import { v4 as uuidv4 } from 'uuid';
import { testAgent } from './seed';
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

describe('Agent Integration Tests', () => {
  // Database connection variables
  let connectionManager: PGliteClientManager;
  let adapter: SqliteDatabaseAdapter;
  let testAgentId: UUID;

  beforeAll(async () => {
    // Create a random agent ID for use with the adapter
    testAgentId = uuidv4() as UUID;

    // Initialize connection manager for PGlite (in-memory)
    connectionManager = new PGliteClientManager({});
    await connectionManager.initialize();

    // Initialize adapter after cleanup
    adapter = new SqliteDatabaseAdapter(testAgentId, connectionManager);
    await adapter.init();
  }, 15000); // Increased timeout for setup and cleanup

  afterAll(async () => {
    // Close all connections
    await adapter.close();
  });

  beforeEach(async () => {
    // Clean up any existing test data
    try {
      // Get a client to execute the cleanup query
      const sqliteInstance = connectionManager.getConnection();

      await sqliteInstance.query(`DELETE FROM agents WHERE name LIKE 'Integration Test%'`);
    } catch (error) {
      console.error('Error cleaning test data:', error);
    }
  });

  afterEach(async () => {
    vi.clearAllMocks();
  });

  describe('createAgent', () => {
    it('should successfully create an agent', async () => {
      const newAgent = {
        ...testAgent,
        id: uuidv4() as UUID,
        name: 'Integration Test Create',
      };

      const result = await adapter.createAgent(newAgent);

      expect(result).toBe(true);

      // Verify the agent was created in the database
      const createdAgent = await adapter.getAgent(newAgent.id);
      expect(createdAgent).not.toBeNull();
      expect(createdAgent?.name).toBe(newAgent.name);
      expect(createdAgent?.bio).toBe(newAgent.bio);
    });

    it('should handle duplicate agent names', async () => {
      // Create the first agent
      const agent1 = {
        ...testAgent,
        id: uuidv4() as UUID,
        name: 'Integration Test Duplicate',
      };

      const result1 = await adapter.createAgent(agent1);
      expect(result1).toBe(true);

      // Try to create another agent with the same name
      const agent2 = {
        ...testAgent,
        id: uuidv4() as UUID,
        name: 'Integration Test Duplicate',
      };

      const result2 = await adapter.createAgent(agent2);
      expect(result2).toBe(false);
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
      expect(createdAgent?.settings?.apiSettings?.endpoints?.primary).toBe(
        'https://api.example.com'
      );
      expect(createdAgent?.settings?.apiSettings?.auth?.tokens?.refresh).toBe('refresh-token');
      expect(createdAgent?.settings?.preferences?.languages).toEqual(['en', 'fr', 'es']);
      expect(createdAgent?.settings?.features?.[0]?.id).toBe('feature1');
      expect(createdAgent?.settings?.features?.[1]?.enabled).toBe(false);
    });

    it('should handle creating agent with missing optional fields', async () => {
      // Create an agent with minimal required fields
      const minimalAgent = {
        id: uuidv4() as UUID,
        name: 'Minimal Agent',
        bio: 'Just the required fields',
        createdAt: Date.now(),
        updatedAt: Date.now(),
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

    it('should handle retrieving agents when none exist', async () => {
      // First delete all test agents to ensure clean state
      const sqliteInstance = connectionManager.getConnection();
      try {
        await sqliteInstance.query(`DELETE FROM agents WHERE name LIKE 'Integration Test%'`);
      } finally {
        // No release needed for PGlite instance from getConnection like with pg PoolClient
      }

      // Now retrieve agents
      const agents = await adapter.getAgents();

      // There might be other agents in the database, but our test agents should be gone
      const testAgents = agents.filter((a) => a.name?.startsWith('Integration Test'));
      expect(testAgents.length).toBe(0);
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
      expect(updatedAgent?.bio).toBe(updateData.bio);
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
        },
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
      expect(updatedAgent?.bio).toBe(updateData.bio);
      expect(updatedAgent?.username).toBe(updateData.username);
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
        },
      };

      await adapter.updateAgent(agentId, updateData as any);

      const updatedAgent = await adapter.getAgent(agentId);
      expect(updatedAgent?.settings).not.toHaveProperty('topLevelToBeRemoved');
      expect(updatedAgent?.settings?.anotherTopLevel).toBe('this should stay');
      expect(updatedAgent?.settings?.secrets).not.toHaveProperty('secretKeyToRemove');
      expect(updatedAgent?.settings?.secrets?.anotherSecret).toBe('this secret should also stay');
      expect(updatedAgent?.settings?.nestedObject).not.toHaveProperty('propToRemove');
      expect(updatedAgent?.settings?.nestedObject?.prop1).toBe('value1');
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
      expect(updatedSecrets?.ELEVENLABS_XI_API_KEY).toBe('elevenlabs_xi_api_key_new');
      expect(updatedSecrets?.DISCORD_APPLICATION_ID).toBe(
        initialAgentSettings.secrets.DISCORD_APPLICATION_ID
      );
      expect(updatedSecrets?.PERPLEXITY_API_KEY).toBe(
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

    it('should return true when deleting non-existent agent', async () => {
      const nonExistentId = uuidv4() as UUID;

      const result = await adapter.deleteAgent(nonExistentId);

      // Should return true even though agent didn't exist
      expect(result).toBe(true);
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

  describe('ensureAgentExists', () => {
    it('should create a new agent when it does not exist', async () => {
      const newAgent = {
        ...testAgent,
        name: 'Integration Test Ensure Create',
      };

      const result = await adapter.ensureAgentExists(newAgent);

      // Make sure id is defined before using it
      expect(result).toHaveProperty('id');
      expect(result.name).toBe(newAgent.name);

      // Verify the agent was created
      if (result.id) {
        const createdAgent = await adapter.getAgent(result.id);
        expect(createdAgent).not.toBeNull();
      }
    });

    it('should return existing agent when it already exists', async () => {
      // Create an agent first
      const newAgent = {
        ...testAgent,
        id: uuidv4() as UUID,
        name: 'Integration Test Ensure Existing',
      };

      await adapter.createAgent(newAgent);

      // Call ensureAgentExists with the same name
      const ensureResult = await adapter.ensureAgentExists({
        name: newAgent.name,
      });

      expect(ensureResult.id).toBe(newAgent.id);
      expect(ensureResult.name).toBe(newAgent.name);
    });

    it('should throw an error when agent name is missing', async () => {
      const incompleteAgent: Partial<Agent> = {
        id: uuidv4() as UUID,
        // name is missing
      };

      await expect(adapter.ensureAgentExists(incompleteAgent)).rejects.toThrow(
        'Agent name is required'
      );
    });

    it('should handle case with existing name but different ID', async () => {
      // Create an agent first
      const existingAgent = {
        ...testAgent,
        id: uuidv4() as UUID,
        name: 'Integration Test Ensure Name Conflict',
      };

      await adapter.createAgent(existingAgent);

      // Try to ensure an agent with the same name but different ID
      const conflictAgent = {
        ...testAgent,
        id: uuidv4() as UUID, // Different ID
        name: 'Integration Test Ensure Name Conflict', // Same name
      };

      const result = await adapter.ensureAgentExists(conflictAgent);

      // Should return the existing agent, not create a new one
      expect(result.id).toBe(existingAgent.id);
      expect(result.id).not.toBe(conflictAgent.id);
    });
  });

  describe('countAgents', () => {
    it('should return the correct count of agents', async () => {
      // Create a few agents first
      const initialCount = await adapter.countAgents();

      // Add two more agents
      const agent1 = {
        ...testAgent,
        id: uuidv4() as UUID,
        name: 'Integration Test Count 1',
      };

      const agent2 = {
        ...testAgent,
        id: uuidv4() as UUID,
        name: 'Integration Test Count 2',
      };

      await adapter.createAgent(agent1);
      await adapter.createAgent(agent2);

      // Count the agents
      const finalCount = await adapter.countAgents();

      expect(finalCount).toBe(initialCount + 2);
    });

    it('should return 0 when no agents exist', async () => {
      // First delete all test agents to ensure clean state
      const sqliteInstance = connectionManager.getConnection();
      try {
        // Delete all agents with test names
        await sqliteInstance.query(`DELETE FROM agents WHERE name LIKE 'Integration Test%'`);

        // Then try to count agents with a specific pattern that shouldn't exist
        const specificCount = await adapter.db
          .select({ count: sql`COUNT(*)` })
          .from(agentTable)
          .where(sql`${agentTable.name} LIKE ${'Integration Test Count Non-Existent%'}`)
          .then((result) => Number(result[0]?.count || '0'));

        expect(specificCount).toBe(0);
      } finally {
        // No release needed for PGlite instance from getConnection like with pg PoolClient
      }
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
