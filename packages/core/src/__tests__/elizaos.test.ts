import { describe, expect, it, beforeEach, mock } from 'bun:test';
import { ElizaOS } from '../elizaos';
import { type UUID, type Character, type Plugin, type IDatabaseAdapter } from '../types';
import { v4 as uuidv4 } from 'uuid';
import { getSalt, decryptObjectValues } from '../settings';

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
        expect(runtime.elizaOS.handleMessage).toBeDefined();
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

  describe('Serverless Mode', () => {
    const testCharacter: Character = {
      name: 'TestAgent',
      bio: 'A test agent',
      system: 'You are a test agent',
    };

    it('should not store runtime in registry when ephemeral is true', async () => {
      const result = await elizaOS.addAgents(
        [{ character: testCharacter, plugins: [mockSqlPlugin] }],
        {
          ephemeral: true,
          returnRuntimes: true,
        }
      );

      // Should return runtimes
      expect(result).toHaveLength(1);
      expect(typeof result[0]).toBe('object');

      const runtime = result[0] as IAgentRuntime;
      expect(runtime.agentId).toBeDefined();

      // Should NOT be in registry
      expect(elizaOS.getAgent(runtime.agentId)).toBeUndefined();
    });

    it('should return UUIDs by default (not runtimes)', async () => {
      const result = await elizaOS.addAgents([
        { character: testCharacter, plugins: [mockSqlPlugin] },
      ]);

      expect(result).toHaveLength(1);
      expect(typeof result[0]).toBe('string');
    });

    it('should return runtimes when returnRuntimes is true', async () => {
      const result = await elizaOS.addAgents(
        [{ character: testCharacter, plugins: [mockSqlPlugin] }],
        {
          returnRuntimes: true,
        }
      );

      expect(result).toHaveLength(1);
      expect(typeof result[0]).toBe('object');
      expect((result[0] as IAgentRuntime).agentId).toBeDefined();
    });

    it('should auto-start when autoStart is true', async () => {
      const result = await elizaOS.addAgents(
        [{ character: testCharacter, plugins: [mockSqlPlugin] }],
        {
          autoStart: true,
          returnRuntimes: true,
        }
      );

      const runtime = result[0] as IAgentRuntime;
      // Runtime should have messageService after initialize
      expect(runtime.messageService).toBeDefined();
    });

    it('should use provided databaseAdapter', async () => {
      const customAdapter = { ...mockAdapter, _custom: true } as IDatabaseAdapter;

      const result = await elizaOS.addAgents(
        [
          {
            character: testCharacter,
            plugins: [],
            databaseAdapter: customAdapter,
          },
        ],
        {
          returnRuntimes: true,
        }
      );

      const runtime = result[0] as IAgentRuntime;
      expect(runtime.adapter).toBe(customAdapter);
    });

    it('should emit event with ephemeral flag', async () => {
      const addedHandler = mock();
      elizaOS.addEventListener('agents:added', (e: Event) => {
        addedHandler((e as CustomEvent).detail);
      });

      await elizaOS.addAgents([{ character: testCharacter, plugins: [mockSqlPlugin] }], {
        ephemeral: true,
      });

      expect(addedHandler).toHaveBeenCalledTimes(1);
      expect(addedHandler.mock.calls[0][0].ephemeral).toBe(true);
    });
  });

  describe('handleMessage with runtime', () => {
    const testCharacter: Character = {
      name: 'TestAgent',
      bio: 'A test agent',
      system: 'You are a test agent',
    };

    it('should accept runtime directly instead of UUID', async () => {
      const [runtime] = (await elizaOS.addAgents(
        [{ character: testCharacter, plugins: [mockSqlPlugin] }],
        {
          ephemeral: true,
          autoStart: true,
          returnRuntimes: true,
        }
      )) as IAgentRuntime[];

      // Mock messageService
      const handleMessageMock = mock().mockResolvedValue({ success: true });
      runtime.messageService = { handleMessage: handleMessageMock };
      runtime.ensureConnection = mock().mockResolvedValue(undefined);

      const result = await elizaOS.handleMessage(runtime, {
        entityId: uuidv4() as UUID,
        roomId: uuidv4() as UUID,
        content: { text: 'Hello' },
      });

      expect(result.messageId).toBeDefined();
      expect(handleMessageMock).toHaveBeenCalled();
    });

    it('should throw error for unknown UUID', async () => {
      const unknownId = uuidv4() as UUID;

      await expect(
        elizaOS.handleMessage(unknownId, {
          entityId: uuidv4() as UUID,
          roomId: uuidv4() as UUID,
          content: { text: 'Hello' },
        })
      ).rejects.toThrow(`Agent ${unknownId} not found in registry`);
    });
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

  describe('Secrets Encryption', () => {
    it('should encrypt character secrets after addAgents', async () => {
      const characterWithSecrets: Character = {
        name: 'TestAgentWithSecrets',
        bio: 'A test agent with secrets',
        system: 'You are a test agent',
        settings: {
          secrets: {
            API_KEY: 'sk-test-12345',
            DATABASE_PASSWORD: 'super-secret-password',
          },
        },
      };

      const [runtime] = (await elizaOS.addAgents(
        [{ character: characterWithSecrets, plugins: [mockSqlPlugin] }],
        { returnRuntimes: true, isTestMode: true }
      )) as any[];

      // Get the character from runtime
      const character = runtime.character;

      // Secrets should be encrypted (format: iv:encrypted)
      expect(character.settings?.secrets).toBeDefined();
      const secrets = character.settings.secrets as Record<string, string>;

      // Check that API_KEY is encrypted (contains ':' separator for iv:encrypted format)
      expect(secrets.API_KEY).toContain(':');
      expect(secrets.API_KEY).not.toBe('sk-test-12345');

      // Check that DATABASE_PASSWORD is encrypted
      expect(secrets.DATABASE_PASSWORD).toContain(':');
      expect(secrets.DATABASE_PASSWORD).not.toBe('super-secret-password');

      // Verify we can decrypt back to original values
      const salt = getSalt();
      const decrypted = decryptObjectValues(secrets, salt);
      expect(decrypted.API_KEY).toBe('sk-test-12345');
      expect(decrypted.DATABASE_PASSWORD).toBe('super-secret-password');
    });

    it('should not double-encrypt already encrypted secrets', async () => {
      const characterWithSecrets: Character = {
        name: 'TestAgentWithSecrets2',
        bio: 'A test agent',
        system: 'You are a test agent',
        settings: {
          secrets: {
            API_KEY: 'my-secret-key',
          },
        },
      };

      const [runtime] = (await elizaOS.addAgents(
        [{ character: characterWithSecrets, plugins: [mockSqlPlugin] }],
        { returnRuntimes: true, isTestMode: true }
      )) as any[];

      const secrets = runtime.character.settings.secrets as Record<string, string>;
      const firstEncryption = secrets.API_KEY;

      // Decrypt and verify
      const salt = getSalt();
      const decrypted = decryptObjectValues(secrets, salt);
      expect(decrypted.API_KEY).toBe('my-secret-key');

      // The encrypted value should have iv:encrypted format
      const parts = firstEncryption.split(':');
      expect(parts.length).toBe(2);
      // IV should be 32 hex chars (16 bytes)
      expect(parts[0].length).toBe(32);
    });

    it('should handle empty secrets object', async () => {
      const characterWithEmptySecrets: Character = {
        name: 'TestAgentEmptySecrets',
        bio: 'A test agent',
        system: 'You are a test agent',
        settings: {
          secrets: {},
        },
      };

      const [runtime] = (await elizaOS.addAgents(
        [{ character: characterWithEmptySecrets, plugins: [mockSqlPlugin] }],
        { returnRuntimes: true, isTestMode: true }
      )) as any[];

      // Should not throw, secrets should remain empty object
      expect(runtime.character.settings?.secrets).toEqual({});
    });

    it('should handle character without settings', async () => {
      const characterWithoutSettings: Character = {
        name: 'TestAgentNoSettings',
        bio: 'A test agent',
        system: 'You are a test agent',
      };

      const [runtime] = (await elizaOS.addAgents(
        [{ character: characterWithoutSettings, plugins: [mockSqlPlugin] }],
        { returnRuntimes: true, isTestMode: true }
      )) as any[];

      // Should not throw
      expect(runtime).toBeDefined();
    });

    it('should preserve non-string secret values', async () => {
      const characterWithMixedSecrets: Character = {
        name: 'TestAgentMixedSecrets',
        bio: 'A test agent',
        system: 'You are a test agent',
        settings: {
          secrets: {
            STRING_SECRET: 'secret-value',
            NUMBER_VALUE: 12345 as any,
            BOOLEAN_VALUE: true as any,
            NULL_VALUE: null as any,
          },
        },
      };

      const [runtime] = (await elizaOS.addAgents(
        [{ character: characterWithMixedSecrets, plugins: [mockSqlPlugin] }],
        { returnRuntimes: true, isTestMode: true }
      )) as any[];

      const secrets = runtime.character.settings.secrets;

      // String should be encrypted
      expect(secrets.STRING_SECRET).toContain(':');

      // Non-string values should be preserved as-is
      expect(secrets.NUMBER_VALUE).toBe(12345);
      expect(secrets.BOOLEAN_VALUE).toBe(true);
      expect(secrets.NULL_VALUE).toBeNull();
    });

    it('should encrypt character.secrets at root level', async () => {
      const characterWithRootSecrets: Character = {
        name: 'TestAgentRootSecrets',
        bio: 'A test agent with root-level secrets',
        system: 'You are a test agent',
        secrets: {
          ROOT_API_KEY: 'root-secret-12345',
          ROOT_PASSWORD: 'root-password',
        },
      };

      const [runtime] = (await elizaOS.addAgents(
        [{ character: characterWithRootSecrets, plugins: [mockSqlPlugin] }],
        { returnRuntimes: true, isTestMode: true }
      )) as any[];

      const character = runtime.character;

      // Root secrets should be encrypted
      expect(character.secrets).toBeDefined();
      const rootSecrets = character.secrets as Record<string, string>;

      // Check that ROOT_API_KEY is encrypted
      expect(rootSecrets.ROOT_API_KEY).toContain(':');
      expect(rootSecrets.ROOT_API_KEY).not.toBe('root-secret-12345');

      // Verify we can decrypt back to original values
      const salt = getSalt();
      const decrypted = decryptObjectValues(rootSecrets, salt);
      expect(decrypted.ROOT_API_KEY).toBe('root-secret-12345');
      expect(decrypted.ROOT_PASSWORD).toBe('root-password');
    });

    it('should encrypt both settings.secrets and root secrets', async () => {
      const characterWithBothSecrets: Character = {
        name: 'TestAgentBothSecrets',
        bio: 'A test agent with both secret locations',
        system: 'You are a test agent',
        secrets: {
          ROOT_SECRET: 'root-value',
        },
        settings: {
          secrets: {
            SETTINGS_SECRET: 'settings-value',
          },
        },
      };

      const [runtime] = (await elizaOS.addAgents(
        [{ character: characterWithBothSecrets, plugins: [mockSqlPlugin] }],
        { returnRuntimes: true, isTestMode: true }
      )) as any[];

      const character = runtime.character;
      const salt = getSalt();

      // Both should be encrypted
      expect(character.secrets.ROOT_SECRET).toContain(':');
      expect(character.settings.secrets.SETTINGS_SECRET).toContain(':');

      // Both should decrypt correctly
      const decryptedRoot = decryptObjectValues(character.secrets, salt);
      const decryptedSettings = decryptObjectValues(character.settings.secrets, salt);

      expect(decryptedRoot.ROOT_SECRET).toBe('root-value');
      expect(decryptedSettings.SETTINGS_SECRET).toBe('settings-value');
    });
  });
});
