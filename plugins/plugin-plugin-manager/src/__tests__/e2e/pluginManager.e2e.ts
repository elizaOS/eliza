import {
  type Action,
  type IAgentRuntime,
  type Memory,
  ModelType,
  type Plugin,
  Service,
  type ServiceTypeName,
  type UUID,
} from '@elizaos/core';
import fs from 'fs-extra';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PluginManagerService } from '../../services/pluginManagerService.ts';

// Mock database adapter since we don't need a real DB for plugin tests
class MockDatabaseAdapter {
  async getMemories() {
    return [];
  }
  async searchMemories() {
    return [];
  }
  async createMemory() {
    return;
  }
  async getMemoriesByRoomIds() {
    return [];
  }
  async getGoals() {
    return [];
  }
  async getConversation() {
    return [];
  }
  async createConversation() {
    return;
  }
  async saveMemory() {
    return;
  }
}

describe('Plugin Manager E2E Tests', () => {
  let runtime: IAgentRuntime;
  let pluginManager: PluginManagerService;
  let tempDir: string;

  beforeEach(async () => {
    // Create a temporary directory for testing
    tempDir = path.join(os.tmpdir(), `plugin-manager-e2e-${Date.now()}`);
    await fs.ensureDir(tempDir);

    // Create a mock runtime with minimal required properties
    runtime = {
      agentId: '00000000-0000-0000-0000-000000000000' as UUID,
      plugins: [],
      actions: [],
      providers: [],
      evaluators: [],
      services: new Map(),
      events: new Map(),

      // Core methods
      registerPlugin: async (plugin: Plugin) => {
        runtime.plugins.push(plugin);
      },
      registerAction: async (action: Action) => {
        runtime.actions.push(action);
      },
      registerProvider: async (provider: any) => {
        runtime.providers.push(provider);
      },
      registerEvaluator: async (evaluator: any) => {
        runtime.evaluators.push(evaluator);
      },
      registerEvent: (event: string, handler: (params: any) => Promise<void>) => {
        const handlers = runtime.events.get(event) || [];
        handlers.push(handler as any);
        runtime.events.set(event, handlers);
      },
      emitEvent: async (event: string, params: any) => {
        const handlers = runtime.events.get(event) || [];
        for (const handler of handlers) {
          await handler(params);
        }
      },
      getService: (name: string) => {
        return runtime.services.get(name as ServiceTypeName);
      },
      registerService: (service: any) => {
        runtime.services.set(service.name || service.constructor.name, service);
      },
      memory: [] as Memory[],
      messageManager: {} as any,
      descriptionManager: {} as any,
      loreManager: {} as any,
      cacheManager: {} as any,
      modelProvider: 'openai' as any,
      character: {
        name: 'Test Agent',
        modelProvider: ModelType.TEXT_SMALL,
        settings: {
          secrets: {},
        },
      } as any,
      state: {} as any,
      goals: [] as any[],
    } as unknown as IAgentRuntime;

    // Initialize plugin manager
    pluginManager = new PluginManagerService(runtime, {
      pluginDirectory: path.join(tempDir, 'plugins'),
    });
  });

  afterEach(async () => {
    // Clean up
    await fs.remove(tempDir);
  });

  describe('Plugin Lifecycle E2E', () => {
    it('should register a simple plugin and execute its action', async () => {
      // Create a test plugin
      const testAction: Action = {
        name: 'TEST_ACTION',
        description: 'A test action',
        similes: ['test', 'demo'],
        validate: async () => true,
        handler: async (runtime, message, state) => {
          return {
            text: 'Test action executed successfully',
            action: 'TEST_ACTION',
            success: true,
          };
        },
        examples: [] as any,
      };

      const testPlugin: Plugin = {
        name: 'test-e2e-plugin',
        description: 'Test plugin for E2E testing',
        actions: [testAction],
      };

      // Register the plugin
      const pluginId = await pluginManager.registerPlugin(testPlugin);
      await pluginManager.loadPlugin({ pluginId });

      // Verify plugin is loaded
      const pluginState = pluginManager.getPlugin(pluginId);
      expect(pluginState?.status).toBe('loaded');

      // Verify action is registered
      const registeredAction = runtime.actions.find((a) => a.name === 'TEST_ACTION');
      expect(registeredAction).toBeDefined();

      // Execute the action
      const result = await registeredAction!.handler(
        runtime,
        {
          userId: '00000000-0000-0000-0000-000000000001' as UUID,
          agentId: runtime.agentId,
          roomId: '00000000-0000-0000-0000-000000000003' as UUID,
          content: { text: 'test' },
        } as any,
        { values: {}, data: {}, text: '' }
      );
      expect((result as any).text).toBe('Test action executed successfully');

      // Unload the plugin
      await pluginManager.unloadPlugin({ pluginId });

      // Verify action is removed
      const removedAction = runtime.actions.find((a) => a.name === 'TEST_ACTION');
      expect(removedAction).toBeUndefined();
    });

    it('should handle plugin with providers and evaluators', async () => {
      const testPlugin: Plugin = {
        name: 'complex-plugin',
        description: 'Plugin with multiple components',
        providers: [
          {
            name: 'TEST_PROVIDER',
            description: 'Test provider',
            get: async (runtime, message, state) => {
              return { data: { text: 'Test provider data' } };
            },
          },
        ],
        evaluators: [
          {
            name: 'TEST_EVALUATOR',
            description: 'Test evaluator',
            similes: ['evaluate', 'check'],
            validate: async () => true,
            handler: async (runtime, message) => {
              return {
                success: true,
                metadata: { evaluated: true },
              };
            },
            examples: [],
          },
        ],
      };

      const pluginId = await pluginManager.registerPlugin(testPlugin);
      await pluginManager.loadPlugin({ pluginId });

      // Verify provider is registered
      const provider = runtime.providers.find((p) => p.name === 'TEST_PROVIDER');
      expect(provider).toBeDefined();

      // Verify evaluator is registered
      const evaluator = runtime.evaluators.find((e) => e.name === 'TEST_EVALUATOR');
      expect(evaluator).toBeDefined();

      // Test provider
      const providerData = await provider!.get(runtime, {} as any, {
        values: {},
        data: {},
        text: '',
      });
      expect((providerData as any).data.text).toBe('Test provider data');

      // Unload and verify cleanup
      await pluginManager.unloadPlugin({ pluginId });

      expect(runtime.providers.find((p) => p.name === 'TEST_PROVIDER')).toBeUndefined();
      expect(runtime.evaluators.find((e) => e.name === 'TEST_EVALUATOR')).toBeUndefined();
    });

    it('should handle plugin with event handlers', async () => {
      let eventFired = false;

      const testPlugin: Plugin = {
        name: 'event-plugin',
        description: 'Plugin with event handlers',
        events: {
          'test:event': [
            async (params) => {
              eventFired = true;
              expect(params.data).toBe('test-data');
            },
          ],
        },
      };

      const pluginId = await pluginManager.registerPlugin(testPlugin);
      await pluginManager.loadPlugin({ pluginId });

      // Emit the event
      await runtime.emitEvent('test:event', { data: 'test-data' });

      // Wait a bit for async event handling
      await new Promise((resolve) => setTimeout(resolve, 100));

      expect(eventFired).toBe(true);

      // Unload and test event removal
      await pluginManager.unloadPlugin({ pluginId });
      eventFired = false;

      await runtime.emitEvent('test:event', { data: 'test-data' });
      await new Promise((resolve) => setTimeout(resolve, 100));

      expect(eventFired).toBe(false);
    });

    it('should handle multiple plugins without conflicts', async () => {
      const plugin1: Plugin = {
        name: 'plugin-1',
        description: 'First plugin',
        actions: [
          {
            name: 'ACTION_1',
            description: 'Action from plugin 1',
            similes: [],
            validate: async () => true,
            handler: async () => ({ text: 'Plugin 1 action', success: true }),
            examples: [],
          },
        ],
        providers: [
          {
            name: 'PROVIDER_1',
            description: 'Provider from plugin 1',
            get: async () => ({ data: { text: 'Plugin 1 data' } }),
          },
        ],
      };

      const plugin2: Plugin = {
        name: 'plugin-2',
        description: 'Second plugin',
        actions: [
          {
            name: 'ACTION_2',
            description: 'Action from plugin 2',
            similes: [],
            validate: async () => true,
            handler: async () => ({ text: 'Plugin 2 action', success: true }),
            examples: [],
          },
        ],
        providers: [
          {
            name: 'PROVIDER_2',
            description: 'Provider from plugin 2',
            get: async () => ({ data: { text: 'Plugin 2 data' } }),
          },
        ],
      };

      // Load both plugins
      const id1 = await pluginManager.registerPlugin(plugin1);
      const id2 = await pluginManager.registerPlugin(plugin2);

      await pluginManager.loadPlugin({ pluginId: id1 });
      await pluginManager.loadPlugin({ pluginId: id2 });

      // Verify both plugins' components are registered
      expect(runtime.actions.find((a) => a.name === 'ACTION_1')).toBeDefined();
      expect(runtime.actions.find((a) => a.name === 'ACTION_2')).toBeDefined();
      expect(runtime.providers.find((p) => p.name === 'PROVIDER_1')).toBeDefined();
      expect(runtime.providers.find((p) => p.name === 'PROVIDER_2')).toBeDefined();

      // Unload plugin 1
      await pluginManager.unloadPlugin({ pluginId: id1 });

      // Verify plugin 1 components are removed but plugin 2 remains
      expect(runtime.actions.find((a) => a.name === 'ACTION_1')).toBeUndefined();
      expect(runtime.actions.find((a) => a.name === 'ACTION_2')).toBeDefined();
      expect(runtime.providers.find((p) => p.name === 'PROVIDER_1')).toBeUndefined();
      expect(runtime.providers.find((p) => p.name === 'PROVIDER_2')).toBeDefined();
    });
  });

  describe('Real Plugin Installation E2E', () => {
    it('should create and install a local plugin bundle', async () => {
      // Create a simple plugin in the temp directory
      const pluginDir = path.join(tempDir, 'test-local-plugin');
      await fs.ensureDir(pluginDir);

      // Create package.json
      await fs.writeJson(path.join(pluginDir, 'package.json'), {
        name: '@test/local-plugin',
        version: '1.0.0',
        main: 'index.js',
        elizaos: {
          requiredEnvVars: [],
        },
      });

      // Create index.js
      await fs.writeFile(
        path.join(pluginDir, 'index.js'),
        `
module.exports = {
  name: "@test/local-plugin",
  description: "Test local plugin",
  actions: [
    {
      name: "LOCAL_ACTION",
      description: "Action from local plugin",
      similes: ["local", "test"],
      validate: async () => true,
      handler: async () => ({
        text: "Local plugin action executed",
        action: "LOCAL_ACTION"
      }),
      examples: []
    }
  ]
};
`
      );

      // Install the local bundle
      const pluginInfo = await pluginManager.installFromLocalBundle(pluginDir);
      expect(pluginInfo.name).toBe('@test/local-plugin');
      expect(pluginInfo.status).toBe('installed');

      // Load the installed plugin
      const pluginId = await pluginManager.loadInstalledPlugin('@test/local-plugin');

      // Verify the action is available
      const action = runtime.actions.find((a) => a.name === 'LOCAL_ACTION');
      expect(action).toBeDefined();

      // Execute the action
      const result = await action!.handler(runtime, {} as any, { values: {}, data: {}, text: '' });
      expect((result as any).text).toBe('Local plugin action executed');
    });
  });

  describe('Service Integration E2E', () => {
    it('should handle plugin with custom service', async () => {
      let serviceStarted = false;
      let serviceStopped = false;

      class TestService extends Service {
        static get serviceType() {
          return 'TEST_SERVICE' as ServiceTypeName;
        }

        override capabilityDescription = 'Test service for E2E testing';

        static async start(runtime: IAgentRuntime) {
          serviceStarted = true;
          const instance = new TestService();
          return instance;
        }

        async stop() {
          serviceStopped = true;
        }

        async getData() {
          return 'Service data';
        }
      }

      const testPlugin: Plugin = {
        name: 'service-plugin',
        description: 'Plugin with custom service',
        services: [TestService],
      };

      const pluginId = await pluginManager.registerPlugin(testPlugin);
      await pluginManager.loadPlugin({ pluginId });

      // Verify service is started
      expect(serviceStarted).toBe(true);

      // Test service functionality
      const service = runtime.getService('TEST_SERVICE') as any;
      expect(service).toBeDefined();
      const data = await service.getData();
      expect(data).toBe('Service data');

      // Unload and verify service is stopped
      await pluginManager.unloadPlugin({ pluginId });
      expect(serviceStopped).toBe(true);
    });
  });

  describe('Error Handling E2E', () => {
    it('should handle plugin initialization errors gracefully', async () => {
      const faultyPlugin: Plugin = {
        name: 'faulty-plugin',
        description: 'Plugin that fails to initialize',
        init: async () => {
          throw new Error('Plugin initialization failed');
        },
      };

      const pluginId = await pluginManager.registerPlugin(faultyPlugin);

      await expect(pluginManager.loadPlugin({ pluginId })).rejects.toThrow(
        'Plugin initialization failed'
      );

      // Verify plugin status
      const pluginState = pluginManager.getPlugin(pluginId);
      expect(pluginState?.status).toBe('error');
    });

    it('should recover from action handler errors', async () => {
      const errorPlugin: Plugin = {
        name: 'error-plugin',
        description: 'Plugin with error-prone action',
        actions: [
          {
            name: 'ERROR_ACTION',
            description: 'Action that throws errors',
            similes: [],
            validate: async () => true,
            handler: async () => {
              throw new Error('Action execution failed');
            },
            examples: [],
          },
        ],
      };

      const pluginId = await pluginManager.registerPlugin(errorPlugin);
      await pluginManager.loadPlugin({ pluginId });

      const action = runtime.actions.find((a) => a.name === 'ERROR_ACTION');

      // Action should throw but not crash the system
      await expect(
        action!.handler(runtime, {} as any, { values: {}, data: {}, text: '' })
      ).rejects.toThrow('Action execution failed');

      // System should still be functional
      const allPlugins = pluginManager.getAllPlugins();
      expect(allPlugins).toHaveLength(1);
    });
  });
});
