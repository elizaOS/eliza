import { describe, it, expect, beforeEach, vi } from 'vitest';
import { PluginManagerService } from '../../services/pluginManagerService';
import { PluginConfigurationService } from '../../services/pluginConfigurationService';
import type { IAgentRuntime, Plugin, UUID, Action, Provider, Service, ServiceTypeName } from '@elizaos/core';

/**
 * These tests verify the ACTUAL code paths, not mocked versions.
 * They exercise the real register -> load -> unload lifecycle.
 */

function createMockRuntime(plugins: Plugin[] = []): IAgentRuntime {
  const services = new Map<ServiceTypeName, Service[]>();
  return {
    agentId: 'test-agent-id' as UUID,
    plugins: [...plugins],
    actions: [] as Action[],
    providers: [] as Provider[],
    evaluators: [],
    services,
    registerAction: vi.fn((action: Action) => {
      // Actually push it like the real runtime does
      (runtime.actions as Action[]).push(action);
    }),
    registerProvider: vi.fn((provider: Provider) => {
      (runtime.providers as Provider[]).push(provider);
    }),
    registerEvaluator: vi.fn((evaluator) => {
      runtime.evaluators.push(evaluator);
    }),
    registerEvent: vi.fn(),
    registerService: vi.fn(),
    getService: vi.fn(),
    getServicesByType: vi.fn().mockReturnValue([]),
    getAllServices: vi.fn().mockReturnValue(services),
  } as unknown as IAgentRuntime;

  // Self-reference hack for the closure above
  var runtime: IAgentRuntime;
  const r = arguments[0]; // won't work, need a different approach
}

// Better approach - create and return
function makeMockRuntime(plugins: Plugin[] = []): IAgentRuntime {
  const actions: Action[] = [];
  const providers: Provider[] = [];
  const evaluators: { name: string }[] = [];
  const services = new Map<ServiceTypeName, Service[]>();

  const runtime = {
    agentId: 'test-agent-id' as UUID,
    plugins: [...plugins],
    actions,
    providers,
    evaluators,
    services,
    registerAction: vi.fn((action: Action) => {
      actions.push(action);
    }),
    registerProvider: vi.fn((provider: Provider) => {
      providers.push(provider);
    }),
    registerEvaluator: vi.fn((evaluator: { name: string }) => {
      evaluators.push(evaluator);
    }),
    registerEvent: vi.fn(),
    registerService: vi.fn(),
    getService: vi.fn(),
    getServicesByType: vi.fn().mockReturnValue([]),
    getAllServices: vi.fn().mockReturnValue(services),
  } as unknown as IAgentRuntime;

  return runtime;
}

function makeTestPlugin(name: string, opts: Partial<Plugin> = {}): Plugin {
  return {
    name,
    description: `Test plugin: ${name}`,
    actions: [
      {
        name: `${name}_ACTION`,
        similes: [],
        description: 'Test action',
        validate: async () => true,
        handler: async () => ({ success: true }),
        examples: [],
      },
    ],
    providers: [
      {
        name: `${name}_PROVIDER`,
        get: async () => ({ text: 'test', values: {}, data: {} }),
      },
    ],
    ...opts,
  };
}

describe('Plugin Lifecycle - register -> load -> unload', () => {
  let runtime: IAgentRuntime;
  let pluginManager: PluginManagerService;

  beforeEach(async () => {
    runtime = makeMockRuntime();
    pluginManager = await PluginManagerService.start(runtime);
  });

  describe('registerPlugin', () => {
    it('should register a new plugin and return its ID', async () => {
      const plugin = makeTestPlugin('my-test-plugin');
      const pluginId = await pluginManager.registerPlugin(plugin);

      expect(pluginId).toBeTruthy();
      expect(typeof pluginId).toBe('string');

      const state = pluginManager.getPlugin(pluginId);
      expect(state).toBeDefined();
      expect(state!.name).toBe('my-test-plugin');
      expect(state!.status).toBe('ready');
    });

    it('should reject duplicate registration', async () => {
      const plugin = makeTestPlugin('duplicate-plugin');
      await pluginManager.registerPlugin(plugin);

      await expect(pluginManager.registerPlugin(plugin)).rejects.toThrow('already registered');
    });

    it('should reject registration of protected plugin names', async () => {
      const plugin = makeTestPlugin('bootstrap');
      await expect(pluginManager.registerPlugin(plugin)).rejects.toThrow('protected');
    });
  });

  describe('loadPlugin', () => {
    it('should load a registered plugin and register its components', async () => {
      const plugin = makeTestPlugin('loadable-plugin');
      const pluginId = await pluginManager.registerPlugin(plugin);

      await pluginManager.loadPlugin({ pluginId });

      const state = pluginManager.getPlugin(pluginId);
      expect(state!.status).toBe('loaded');

      // Verify components were registered with the runtime
      expect(runtime.registerAction).toHaveBeenCalled();
      expect(runtime.registerProvider).toHaveBeenCalled();

      // Verify the actual action was pushed to runtime.actions
      expect(runtime.actions.some((a) => a.name === 'loadable-plugin_ACTION')).toBe(true);
      expect(runtime.providers.some((p) => p.name === 'loadable-plugin_PROVIDER')).toBe(true);
    });

    it('should call plugin init if defined', async () => {
      const initFn = vi.fn();
      const plugin = makeTestPlugin('init-plugin', { init: initFn });
      const pluginId = await pluginManager.registerPlugin(plugin);

      await pluginManager.loadPlugin({ pluginId });

      expect(initFn).toHaveBeenCalledWith({}, runtime);
    });

    it('should reject loading a plugin that is not registered', async () => {
      await expect(
        pluginManager.loadPlugin({ pluginId: 'nonexistent-id' })
      ).rejects.toThrow('not found');
    });

    it('should be idempotent - loading an already loaded plugin is a no-op', async () => {
      const plugin = makeTestPlugin('idempotent-plugin');
      const pluginId = await pluginManager.registerPlugin(plugin);

      await pluginManager.loadPlugin({ pluginId });
      // Load again - should not throw
      await pluginManager.loadPlugin({ pluginId });

      // registerAction should only have been called once (from first load)
      const calls = (runtime.registerAction as ReturnType<typeof vi.fn>).mock.calls;
      const matchingCalls = calls.filter(
        (c) => (c[0] as Action).name === 'idempotent-plugin_ACTION'
      );
      expect(matchingCalls.length).toBe(1);
    });
  });

  describe('unloadPlugin', () => {
    it('should unload a dynamically loaded plugin and remove its components', async () => {
      const plugin = makeTestPlugin('unloadable-plugin');
      const pluginId = await pluginManager.registerPlugin(plugin);
      await pluginManager.loadPlugin({ pluginId });

      // Verify it's loaded
      expect(runtime.actions.some((a) => a.name === 'unloadable-plugin_ACTION')).toBe(true);

      // Unload it
      await pluginManager.unloadPlugin({ pluginId });

      const state = pluginManager.getPlugin(pluginId);
      expect(state!.status).toBe('unloaded');

      // Verify components were removed from runtime
      expect(runtime.actions.some((a) => a.name === 'unloadable-plugin_ACTION')).toBe(false);
      expect(runtime.providers.some((p) => p.name === 'unloadable-plugin_PROVIDER')).toBe(false);
    });

    it('should allow re-loading after unload', async () => {
      const plugin = makeTestPlugin('reload-plugin');
      const pluginId = await pluginManager.registerPlugin(plugin);

      await pluginManager.loadPlugin({ pluginId });
      await pluginManager.unloadPlugin({ pluginId });

      expect(pluginManager.getPlugin(pluginId)!.status).toBe('unloaded');

      // Re-load
      await pluginManager.loadPlugin({ pluginId });
      expect(pluginManager.getPlugin(pluginId)!.status).toBe('loaded');
      expect(runtime.actions.some((a) => a.name === 'reload-plugin_ACTION')).toBe(true);
    });
  });

  describe('stop (cleanup)', () => {
    it('should unload all dynamic plugins on stop', async () => {
      const plugin1 = makeTestPlugin('dynamic-1');
      const plugin2 = makeTestPlugin('dynamic-2');

      const id1 = await pluginManager.registerPlugin(plugin1);
      const id2 = await pluginManager.registerPlugin(plugin2);
      await pluginManager.loadPlugin({ pluginId: id1 });
      await pluginManager.loadPlugin({ pluginId: id2 });

      await pluginManager.stop();

      expect(pluginManager.getPlugin(id1)!.status).toBe('unloaded');
      expect(pluginManager.getPlugin(id2)!.status).toBe('unloaded');
    });
  });
});

describe('PluginConfigurationService - real config checking', () => {
  let runtime: IAgentRuntime;
  let configService: PluginConfigurationService;

  beforeEach(async () => {
    runtime = makeMockRuntime();
    configService = await PluginConfigurationService.start(runtime);
  });

  it('should report no missing keys for plugin with no config', () => {
    const plugin: Plugin = {
      name: 'no-config-plugin',
      description: 'test',
    };
    const status = configService.getPluginConfigStatus(plugin);
    expect(status.configured).toBe(true);
    expect(status.missingKeys).toHaveLength(0);
    expect(status.totalKeys).toBe(0);
  });

  it('should detect missing config keys', () => {
    const plugin: Plugin = {
      name: 'needs-config',
      description: 'test',
      config: {
        MY_API_KEY: null,        // null = required, no default
        MY_OPTIONAL: 'default',  // has default = not missing
      },
    };

    // Make sure env var is NOT set
    delete process.env.MY_API_KEY;

    const status = configService.getPluginConfigStatus(plugin);
    expect(status.configured).toBe(false);
    expect(status.missingKeys).toContain('MY_API_KEY');
    expect(status.totalKeys).toBe(2);
  });

  it('should report configured when env vars are set', () => {
    const plugin: Plugin = {
      name: 'configured-plugin',
      description: 'test',
      config: {
        TEST_CONFIG_KEY: null,
      },
    };

    // Set the env var
    process.env.TEST_CONFIG_KEY = 'test-value';

    const status = configService.getPluginConfigStatus(plugin);
    expect(status.configured).toBe(true);
    expect(status.missingKeys).toHaveLength(0);

    // Clean up
    delete process.env.TEST_CONFIG_KEY;
  });
});

describe('isValidPlugin', () => {
  let runtime: IAgentRuntime;
  let pluginManager: PluginManagerService;

  beforeEach(async () => {
    runtime = makeMockRuntime();
    pluginManager = await PluginManagerService.start(runtime);
  });

  // Access private method via prototype for testing
  const testIsValid = (pm: PluginManagerService, obj: unknown) => {
    return (pm as unknown as { isValidPlugin: (obj: unknown) => boolean }).isValidPlugin(obj);
  };

  it('should accept plugin with name and actions', () => {
    expect(testIsValid(pluginManager, { name: 'test', actions: [] })).toBe(true);
  });

  it('should accept plugin with name and providers', () => {
    expect(testIsValid(pluginManager, { name: 'test', providers: [] })).toBe(true);
  });

  it('should accept plugin with name and init', () => {
    expect(testIsValid(pluginManager, { name: 'test', init: () => {} })).toBe(true);
  });

  it('should reject null', () => {
    expect(testIsValid(pluginManager, null)).toBe(false);
  });

  it('should reject non-object', () => {
    expect(testIsValid(pluginManager, 'string')).toBe(false);
  });

  it('should reject object without name', () => {
    expect(testIsValid(pluginManager, { actions: [] })).toBe(false);
  });

  it('should reject object with name but no plugin properties', () => {
    expect(testIsValid(pluginManager, { name: 'test', somethingElse: true })).toBe(false);
  });
});
