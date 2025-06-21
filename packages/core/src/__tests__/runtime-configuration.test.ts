import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { AgentRuntime } from '../runtime';
import type { 
  Plugin, 
  Action, 
  Provider, 
  Evaluator, 
  IAgentRuntime,
  Character,
  IDatabaseAdapter 
} from '../types';
import { Service } from '../types/service';

// Mock character for testing
const testCharacter: Character = {
  name: 'TestAgent',
  bio: ['Test agent for configuration testing'],
  system: 'You are a test agent',
  messageExamples: [],
  postExamples: [],
  topics: [],
  adjectives: [],
  knowledge: [],
  plugins: ['test-plugin'],
  settings: {},
  secrets: {},
  pluginConfig: {
    'test-plugin': {
      enabled: true,
      settings: {},
      actions: {
        TEST_ACTION: {
          enabled: true,
          settings: {
            testMode: true
          }
        }
      },
      providers: {
        TEST_PROVIDER: {
          enabled: true,
          settings: {}
        }
      },
      evaluators: {
        TEST_EVALUATOR: {
          enabled: true,
          settings: {}
        }
      },
      services: {
        TEST_SERVICE: {
          enabled: true,
          settings: {
            maxConnections: 10
          }
        }
      }
    }
  }
};

// Mock plugin components for testing
const mockAction: Action = {
  name: 'TEST_ACTION',
  similes: [],
  description: 'Test action for configuration testing',
  examples: [],
  validate: vi.fn().mockResolvedValue(true),
  handler: vi.fn().mockResolvedValue({ text: 'Test action executed' }),
};

const mockProvider: Provider = {
  name: 'TEST_PROVIDER',
  description: 'Test provider for configuration testing',
  get: vi.fn().mockResolvedValue({ text: 'Test provider data' }),
};

const mockEvaluator: Evaluator = {
  name: 'TEST_EVALUATOR',
  description: 'Test evaluator for configuration testing',
  examples: [],
  validate: vi.fn().mockResolvedValue(true),
  handler: vi.fn().mockResolvedValue(null),
};

class MockService extends Service {
  static serviceName = 'TEST_SERVICE';
  static serviceType = 'TEST' as any;
  capabilityDescription = 'Test service for configuration testing';

  static async start(_runtime: IAgentRuntime): Promise<MockService> {
    return new MockService();
  }

  async stop(): Promise<void> {
    // Cleanup
  }
}

// Test plugin with configurable components
const testPlugin: Plugin = {
  name: 'test-plugin',
  description: 'Test plugin for configuration testing',
  actions: [mockAction],
  providers: [mockProvider],
  evaluators: [mockEvaluator],
  services: [MockService],
  config: {
    actions: {
      TEST_ACTION: {
        enabled: true,
        settings: {}
      }
    },
    providers: {
      TEST_PROVIDER: {
        enabled: true,
        settings: {}
      }
    },
    evaluators: {
      TEST_EVALUATOR: {
        enabled: true,
        settings: {}
      }
    },
    services: {
      TEST_SERVICE: {
        enabled: true,
        settings: {}
      }
    }
  }
};

describe('Runtime Configuration System E2E Tests', () => {
  let runtime: AgentRuntime;
  let dbAdapter: any;

  beforeEach(async () => {
    // Track created entities for mock consistency
    const createdEntities = new Map();
    const createdRooms = new Map();
    
    // Track configuration persistence (shared across runtime instances)
    const configStorage = new Map();
    
    // Create mock database adapter for testing
    dbAdapter = {
      init: vi.fn().mockResolvedValue(undefined),
      initialize: vi.fn().mockResolvedValue(undefined),
      isReady: vi.fn().mockResolvedValue(true),
      close: vi.fn().mockResolvedValue(undefined),
      getConnection: vi.fn().mockResolvedValue({}),
      db: {},
      
      // Agent management methods
      getAgent: vi.fn().mockResolvedValue(null),
      getAgents: vi.fn().mockResolvedValue([]),
      createAgent: vi.fn().mockResolvedValue(true),
      updateAgent: vi.fn().mockResolvedValue(true),
      deleteAgent: vi.fn().mockResolvedValue(true),
      
      // Migration and embedding methods
      runMigrations: vi.fn().mockResolvedValue(undefined),
      ensureEmbeddingDimension: vi.fn().mockResolvedValue(undefined),
      
      // Entity methods
      getEntityByIds: vi.fn().mockImplementation((ids) => {
        const entities = ids.map(id => createdEntities.get(id)).filter(Boolean);
        return Promise.resolve(entities.length > 0 ? entities : null);
      }),
      getEntitiesForRoom: vi.fn().mockResolvedValue([]),
      createEntities: vi.fn().mockImplementation((entities) => {
        entities.forEach(entity => {
          const entityData = { id: entity.id, names: entity.names, metadata: entity.metadata, agentId: entity.agentId };
          createdEntities.set(entity.id, entityData);
        });
        return Promise.resolve(true);
      }),
      createEntity: vi.fn().mockImplementation((entity) => {
        const entityData = { id: entity.id, names: entity.names, metadata: entity.metadata, agentId: entity.agentId };
        createdEntities.set(entity.id, entityData);
        return Promise.resolve(entity.id || 'test-entity-id');
      }),
      getEntityById: vi.fn().mockImplementation((id) => {
        return Promise.resolve(createdEntities.get(id) || null);
      }),
      updateEntity: vi.fn().mockResolvedValue(undefined),
      
      // Component methods
      getComponent: vi.fn().mockResolvedValue(null),
      getComponents: vi.fn().mockResolvedValue([]),
      createComponent: vi.fn().mockResolvedValue(true),
      updateComponent: vi.fn().mockResolvedValue(undefined),
      deleteComponent: vi.fn().mockResolvedValue(undefined),
      
      // Memory methods
      getMemories: vi.fn().mockResolvedValue([]),
      getMemoryById: vi.fn().mockResolvedValue(null),
      getMemoriesByIds: vi.fn().mockResolvedValue([]),
      getMemoriesByRoomIds: vi.fn().mockResolvedValue([]),
      getMemoriesByWorldId: vi.fn().mockResolvedValue([]),
      getCachedEmbeddings: vi.fn().mockResolvedValue([]),
      searchMemories: vi.fn().mockResolvedValue([]),
      createMemory: vi.fn().mockResolvedValue('test-memory-id'),
      updateMemory: vi.fn().mockResolvedValue(true),
      deleteMemory: vi.fn().mockResolvedValue(undefined),
      deleteManyMemories: vi.fn().mockResolvedValue(undefined),
      deleteAllMemories: vi.fn().mockResolvedValue(undefined),
      countMemories: vi.fn().mockResolvedValue(0),
      
      // Logging methods
      log: vi.fn().mockResolvedValue(undefined),
      getLogs: vi.fn().mockResolvedValue([]),
      deleteLog: vi.fn().mockResolvedValue(undefined),
      
      // World methods
      createWorld: vi.fn().mockResolvedValue('test-world-id'),
      getWorld: vi.fn().mockResolvedValue({ id: 'test-world-id', name: 'test' }),
      getWorlds: vi.fn().mockResolvedValue([]),
      getAllWorlds: vi.fn().mockResolvedValue([]),
      updateWorld: vi.fn().mockResolvedValue(undefined),
      removeWorld: vi.fn().mockResolvedValue(undefined),
      
      // Room methods
      createRoom: vi.fn().mockImplementation((room) => {
        const roomData = { id: room.id, name: room.name, type: room.type, agentId: room.agentId };
        createdRooms.set(room.id, roomData);
        return Promise.resolve(room.id || 'test-room-id');
      }),
      createRooms: vi.fn().mockResolvedValue(['test-room-id']),
      getRoom: vi.fn().mockImplementation((id) => {
        return Promise.resolve(createdRooms.get(id) || null);
      }),
      getRoomsByIds: vi.fn().mockResolvedValue([]),
      getRoomsForParticipant: vi.fn().mockResolvedValue([]),
      getRoomsForParticipants: vi.fn().mockResolvedValue([]),
      getRoomsByWorld: vi.fn().mockResolvedValue([]),
      updateRoom: vi.fn().mockResolvedValue(undefined),
      deleteRoom: vi.fn().mockResolvedValue(undefined),
      deleteRoomsByWorldId: vi.fn().mockResolvedValue(undefined),
      
      // Participant methods
      addParticipant: vi.fn().mockResolvedValue(undefined),
      addParticipantsRoom: vi.fn().mockResolvedValue(true),
      removeParticipant: vi.fn().mockResolvedValue(true),
      getParticipantsForEntity: vi.fn().mockResolvedValue([]),
      getParticipantsForRoom: vi.fn().mockResolvedValue([]),
      setParticipantUserState: vi.fn().mockResolvedValue(undefined),
      getParticipantUserState: vi.fn().mockResolvedValue(null),
      
      // Relationship methods
      createRelationship: vi.fn().mockResolvedValue(true),
      updateRelationship: vi.fn().mockResolvedValue(undefined),
      getRelationship: vi.fn().mockResolvedValue(null),
      getRelationships: vi.fn().mockResolvedValue([]),
      
      // Cache methods
      setCache: vi.fn().mockResolvedValue(true),
      getCache: vi.fn().mockResolvedValue(null),
      deleteCache: vi.fn().mockResolvedValue(true),
      
      // Task methods
      createTask: vi.fn().mockResolvedValue('test-task-id'),
      getTasks: vi.fn().mockResolvedValue([]),
      getTask: vi.fn().mockResolvedValue(null),
      getTasksByName: vi.fn().mockResolvedValue([]),
      updateTask: vi.fn().mockResolvedValue(undefined),
      deleteTask: vi.fn().mockResolvedValue(undefined),
    } as IDatabaseAdapter;

    // Create runtime with test character
    runtime = new AgentRuntime({
      character: testCharacter,
      adapter: dbAdapter,
    });

    // Register the test plugin
    await runtime.registerPlugin(testPlugin);
    await runtime.initialize();
  });

  afterEach(async () => {
    if (runtime) {
      await runtime.stop?.();
    }
  });

  describe('Configuration Manager Integration', () => {
    it('should initialize configuration manager with plugin configurations', async () => {
      const configManager = runtime.getConfigurationManager();
      expect(configManager).toBeDefined();

      const configurations = configManager.listConfigurations();
      expect(configurations).toHaveLength(1);
      expect(configurations[0].pluginName).toBe('test-plugin');
    });

    it('should retrieve plugin configuration correctly', async () => {
      const configManager = runtime.getConfigurationManager();
      const pluginConfig = configManager.getPluginConfiguration('test-plugin');
      
      expect(pluginConfig).toBeDefined();
      expect(pluginConfig.pluginName).toBe('test-plugin');
      expect(pluginConfig.enabled).toBe(true);
      expect(pluginConfig.actions).toBeDefined();
      expect(pluginConfig.providers).toBeDefined();
      expect(pluginConfig.evaluators).toBeDefined();
      expect(pluginConfig.services).toBeDefined();
    });

    it('should update component configuration and reflect in runtime', async () => {
      const configManager = runtime.getConfigurationManager();
      
      // Initially, action should be enabled and registered
      expect(runtime.actions.find(a => a.name === 'TEST_ACTION')).toBeDefined();
      
      // Update component configuration to disable
      const enabledComponents = configManager.getEnabledComponentsMap();
      const result = await configManager.updateComponentConfiguration(
        'test-plugin',
        'TEST_ACTION',
        'action',
        { enabled: false },
        [],
        enabledComponents
      );
      
      expect(result.valid).toBe(true);
      
      // Check that component config is updated
      const componentConfig = configManager.getComponentConfig('test-plugin', 'TEST_ACTION', 'action');
      expect(componentConfig.enabled).toBe(false);
    });
  });

  describe('Hot-swap Component Management', () => {
    it('should enable component using configurePlugin method', async () => {
      // Disable component first
      await runtime.configurePlugin('test-plugin', {
        actions: {
          TEST_ACTION: {
            enabled: false,
            overrideLevel: 'runtime',
            overrideReason: 'Test disable',
            settings: {},
            lastModified: new Date()
          }
        }
      });

      // Verify component is disabled
      const configManager = runtime.getConfigurationManager();
      let componentConfig = configManager.getComponentConfig('test-plugin', 'TEST_ACTION', 'action');
      expect(componentConfig.enabled).toBe(false);

      // Re-enable component
      await runtime.configurePlugin('test-plugin', {
        actions: {
          TEST_ACTION: {
            enabled: true,
            overrideLevel: 'runtime',
            overrideReason: 'Test enable',
            settings: {},
            lastModified: new Date()
          }
        }
      });

      // Verify component is enabled
      componentConfig = configManager.getComponentConfig('test-plugin', 'TEST_ACTION', 'action');
      expect(componentConfig.enabled).toBe(true);
    });

    it('should support hot-swap for all component types', async () => {
      const configManager = runtime.getConfigurationManager();

      // Test all component types
      const componentTypes = [
        { type: 'actions', name: 'TEST_ACTION', runtimeCheck: () => runtime.actions.find(a => a.name === 'TEST_ACTION') },
        { type: 'providers', name: 'TEST_PROVIDER', runtimeCheck: () => runtime.providers.find(p => p.name === 'TEST_PROVIDER') },
        { type: 'evaluators', name: 'TEST_EVALUATOR', runtimeCheck: () => runtime.evaluators.find(e => e.name === 'TEST_EVALUATOR') },
        { type: 'services', name: 'TEST_SERVICE', runtimeCheck: () => runtime.getService('TEST_SERVICE') }
      ];

      for (const component of componentTypes) {
        // Initially should be enabled
        expect(component.runtimeCheck()).toBeDefined();

        // Disable component
        await runtime.configurePlugin('test-plugin', {
          [component.type]: {
            [component.name]: {
              enabled: false,
              overrideLevel: 'runtime',
              overrideReason: `Test disable ${component.name}`,
              settings: {},
              lastModified: new Date()
            }
          }
        });

        // Check configuration is updated
        const componentConfig = configManager.getComponentConfig(
          'test-plugin', 
          component.name, 
          component.type.slice(0, -1) as any
        );
        expect(componentConfig.enabled).toBe(false);

        // Re-enable component
        await runtime.configurePlugin('test-plugin', {
          [component.type]: {
            [component.name]: {
              enabled: true,
              overrideLevel: 'runtime',
              overrideReason: `Test enable ${component.name}`,
              settings: {},
              lastModified: new Date()
            }
          }
        });

        // Check configuration is updated
        const enabledConfig = configManager.getComponentConfig(
          'test-plugin', 
          component.name, 
          component.type.slice(0, -1) as any
        );
        expect(enabledConfig.enabled).toBe(true);
      }
    });
  });

  describe('Component Registration State', () => {
    it('should track component registration state correctly', async () => {
      const configManager = runtime.getConfigurationManager();

      // Get initial state
      const initialActions = runtime.actions.map(a => a.name);
      const initialProviders = runtime.providers.map(p => p.name);
      const initialEvaluators = runtime.evaluators.map(e => e.name);
      const initialServices = Array.from(runtime.services.keys());

      expect(initialActions).toContain('TEST_ACTION');
      expect(initialProviders).toContain('TEST_PROVIDER');
      expect(initialEvaluators).toContain('TEST_EVALUATOR');
      expect(initialServices).toContain('TEST_SERVICE');

      // Disable action
      await runtime.configurePlugin('test-plugin', {
        actions: {
          TEST_ACTION: {
            enabled: false,
            overrideLevel: 'runtime',
            overrideReason: 'Test state tracking',
            settings: {},
            lastModified: new Date()
          }
        }
      });

      // Check that action is removed from runtime
      const actionsAfterDisable = runtime.actions.map(a => a.name);
      expect(actionsAfterDisable).not.toContain('TEST_ACTION');

      // But configuration should still exist
      const componentConfig = configManager.getComponentConfig('test-plugin', 'TEST_ACTION', 'action');
      expect(componentConfig).toBeDefined();
      expect(componentConfig.enabled).toBe(false);
    });

    it('should handle component dependencies correctly', async () => {
      const configManager = runtime.getConfigurationManager();
      
      // Test dependency validation
      const enabledComponents = configManager.getEnabledComponentsMap();
      
      // Try to update a component with dependencies
      const result = await configManager.updateComponentConfiguration(
        'test-plugin',
        'TEST_ACTION',
        'action',
        { enabled: true },
        [{ type: 'provider', name: 'TEST_PROVIDER', pluginName: 'test-plugin' }], // Dependency on provider
        enabledComponents
      );

      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });
  });

  describe('Configuration Persistence', () => {
    it('should persist configuration changes in memory correctly', async () => {
      const configManager = runtime.getConfigurationManager();
      
      // Make a configuration change
      await runtime.configurePlugin('test-plugin', {
        actions: {
          TEST_ACTION: {
            enabled: false,
            overrideLevel: 'gui',
            overrideReason: 'Persistence test',
            settings: { testSetting: 'value' },
            lastModified: new Date()
          }
        }
      });

      // Verify change is applied and persisted in the configuration manager
      let componentConfig = configManager.getComponentConfig('test-plugin', 'TEST_ACTION', 'action');
      expect(componentConfig.enabled).toBe(false);
      expect(componentConfig.settings?.testSetting).toBe('value');
      expect(componentConfig.overrideLevel).toBe('gui');
      expect(componentConfig.overrideReason).toBe('Persistence test');

      // Verify configuration persists in the configuration manager's state
      const allConfigs = configManager.listConfigurations();
      const testPluginConfig = allConfigs.find(c => c.pluginName === 'test-plugin');
      expect(testPluginConfig).toBeDefined();
      expect(testPluginConfig.actions['TEST_ACTION'].enabled).toBe(false);
      expect(testPluginConfig.actions['TEST_ACTION'].settings?.testSetting).toBe('value');
    });

    it('should handle configuration override levels correctly', async () => {
      const configManager = runtime.getConfigurationManager();
      
      // Set plugin-level default
      await configManager.setOverride('plugin', 'test-plugin', {
        actions: {
          TEST_ACTION: {
            enabled: true,
            settings: { level: 'plugin' }
          }
        }
      });

      // Set GUI-level override
      await configManager.setOverride('gui', 'test-plugin', {
        actions: {
          TEST_ACTION: {
            enabled: false,
            settings: { level: 'gui' }
          }
        }
      });

      // GUI override should take precedence
      const componentConfig = configManager.getComponentConfig('test-plugin', 'TEST_ACTION', 'action');
      expect(componentConfig.enabled).toBe(false);
      expect(componentConfig.settings?.level).toBe('gui');

      // Set runtime-level override
      await runtime.configurePlugin('test-plugin', {
        actions: {
          TEST_ACTION: {
            enabled: true,
            overrideLevel: 'runtime',
            overrideReason: 'Runtime override test',
            settings: { level: 'runtime' },
            lastModified: new Date()
          }
        }
      });

      // Runtime override should take precedence
      const runtimeConfig = configManager.getComponentConfig('test-plugin', 'TEST_ACTION', 'action');
      expect(runtimeConfig.enabled).toBe(true);
      expect(runtimeConfig.settings?.level).toBe('runtime');
    });
  });

  describe('Error Handling', () => {
    it('should handle invalid plugin names gracefully', async () => {
      const configManager = runtime.getConfigurationManager();
      
      expect(() => {
        configManager.getPluginConfiguration('non-existent-plugin');
      }).not.toThrow();
      
      const config = configManager.getPluginConfiguration('non-existent-plugin');
      expect(config).toBeNull();
    });

    it('should handle invalid component configurations gracefully', async () => {
      const configManager = runtime.getConfigurationManager();
      const enabledComponents = configManager.getEnabledComponentsMap();
      
      const result = await configManager.updateComponentConfiguration(
        'test-plugin',
        'NON_EXISTENT_COMPONENT',
        'action',
        { enabled: true },
        [],
        enabledComponents
      );

      expect(result.valid).toBe(false);
      expect(result.errors).toContain('Component NON_EXISTENT_COMPONENT not found in plugin test-plugin');
    });

    it('should validate component dependencies', async () => {
      const configManager = runtime.getConfigurationManager();
      const enabledComponents = configManager.getEnabledComponentsMap();
      
      // Try to set a dependency on a non-existent component
      const result = await configManager.updateComponentConfiguration(
        'test-plugin',
        'TEST_ACTION',
        'action',
        { enabled: true },
        [{ type: 'provider', name: 'NON_EXISTENT_DEPENDENCY', pluginName: 'test-plugin' }],
        enabledComponents
      );

      expect(result.valid).toBe(false);
      expect(result.errors.some(error => error.includes('NON_EXISTENT_DEPENDENCY'))).toBe(true);
    });
  });

  describe('Performance Tests', () => {
    it('should handle configuration changes efficiently', async () => {
      const startTime = Date.now();
      
      // Perform multiple configuration changes
      for (let i = 0; i < 10; i++) {
        await runtime.configurePlugin('test-plugin', {
          actions: {
            TEST_ACTION: {
              enabled: i % 2 === 0,
              overrideLevel: 'runtime',
              overrideReason: `Performance test iteration ${i}`,
              settings: { iteration: i },
              lastModified: new Date()
            }
          }
        });
      }
      
      const endTime = Date.now();
      const duration = endTime - startTime;
      
      // Should complete within reasonable time (adjust threshold as needed)
      expect(duration).toBeLessThan(5000); // 5 seconds
    });

    it('should cache configuration data efficiently', async () => {
      const configManager = runtime.getConfigurationManager();
      
      const startTime = Date.now();
      
      // Perform multiple reads
      for (let i = 0; i < 100; i++) {
        configManager.getPluginConfiguration('test-plugin');
        configManager.getComponentConfig('test-plugin', 'TEST_ACTION', 'action');
      }
      
      const endTime = Date.now();
      const duration = endTime - startTime;
      
      // Should be fast due to caching
      expect(duration).toBeLessThan(1000); // 1 second
    });
  });
});