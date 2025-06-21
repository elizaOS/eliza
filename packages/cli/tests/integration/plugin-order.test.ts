import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { AgentRuntime } from '@elizaos/core';
import type { Plugin } from '@elizaos/core';

// Create a mock SQL plugin with database adapter
const mockSqlPlugin: Plugin = {
  name: '@elizaos/plugin-sql',
  description: 'Mock SQL plugin for testing',
  adapter: {
    // Mock database methods
    init: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockResolvedValue(undefined),
    query: vi.fn().mockResolvedValue({ rows: [] }),
    execute: vi.fn().mockResolvedValue({ changes: 0 }),
    // Agent methods
    getAgents: vi.fn().mockResolvedValue([]),
    createAgent: vi.fn().mockImplementation((agent) => Promise.resolve(agent)),
    updateAgent: vi.fn().mockResolvedValue(undefined),
    deleteAgent: vi.fn().mockResolvedValue(undefined),
    // Memory methods
    createMemory: vi.fn().mockResolvedValue(undefined),
    getMemories: vi.fn().mockResolvedValue([]),
    searchMemories: vi.fn().mockResolvedValue([]),
    updateMemory: vi.fn().mockResolvedValue(undefined),
    deleteMemory: vi.fn().mockResolvedValue(undefined),
    deleteAllMemories: vi.fn().mockResolvedValue(undefined),
    getMemoryById: vi.fn().mockResolvedValue(null),
    getCachedEmbeddings: vi.fn().mockResolvedValue([]),
    // Entity methods
    createEntity: vi.fn().mockResolvedValue(undefined),
    getEntity: vi.fn().mockResolvedValue(null),
    getEntityByIds: vi.fn().mockResolvedValue([]),
    updateEntity: vi.fn().mockResolvedValue(undefined),
    deleteEntity: vi.fn().mockResolvedValue(undefined),
    // Room methods
    createRoom: vi.fn().mockResolvedValue(undefined),
    getRoom: vi.fn().mockResolvedValue(null),
    updateRoom: vi.fn().mockResolvedValue(undefined),
    deleteRoom: vi.fn().mockResolvedValue(undefined),
    getRooms: vi.fn().mockResolvedValue([]),
    // Relationship methods
    createRelationship: vi.fn().mockResolvedValue(undefined),
    getRelationship: vi.fn().mockResolvedValue(null),
    getRelationships: vi.fn().mockResolvedValue([]),
    updateRelationship: vi.fn().mockResolvedValue(undefined),
    deleteRelationship: vi.fn().mockResolvedValue(undefined),
    // World methods
    createWorld: vi.fn().mockResolvedValue(undefined),
    getWorld: vi.fn().mockResolvedValue(null),
    getWorlds: vi.fn().mockResolvedValue([]),
    updateWorld: vi.fn().mockResolvedValue(undefined),
    deleteWorld: vi.fn().mockResolvedValue(undefined),
    // Task methods
    createTask: vi.fn().mockResolvedValue(undefined),
    getTask: vi.fn().mockResolvedValue(null),
    getTasks: vi.fn().mockResolvedValue([]),
    updateTask: vi.fn().mockResolvedValue(undefined),
    deleteTask: vi.fn().mockResolvedValue(undefined),
    updateTaskStatus: vi.fn().mockResolvedValue(undefined),
    // Component methods
    createComponent: vi.fn().mockResolvedValue(undefined),
    getComponent: vi.fn().mockResolvedValue(null),
    getComponents: vi.fn().mockResolvedValue([]),
    updateComponent: vi.fn().mockResolvedValue(undefined),
    deleteComponent: vi.fn().mockResolvedValue(undefined),
  } as any,
};

describe('Plugin Registration Order', () => {
  let runtime: AgentRuntime;
  let registrationOrder: string[] = [];
  let initializationOrder: string[] = [];

  beforeEach(() => {
    registrationOrder = [];
    initializationOrder = [];
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('should register plugins sequentially in the order they appear', async () => {
    // Create mock plugins with delayed initialization to test sequencing
    const createMockPlugin = (name: string, delay: number): Plugin => ({
      name,
      description: `Test plugin ${name}`,
      init: vi.fn(async () => {
        registrationOrder.push(name);
        // Simulate async operation with delay
        await new Promise((resolve) => setTimeout(resolve, delay));
        initializationOrder.push(name);
      }),
      actions: [],
      providers: [],
      evaluators: [],
      services: [],
    });

    // Create plugins with different delays to ensure sequential execution
    const plugin1 = createMockPlugin('plugin-1', 100);
    const plugin2 = createMockPlugin('plugin-2', 50);
    const plugin3 = createMockPlugin('plugin-3', 25);

    // Create runtime with test plugins
    runtime = new AgentRuntime({
      agentId: '00000000-0000-0000-0000-000000000000' as any,
      character: {
        name: 'Test Agent',
        bio: 'A test agent for plugin order verification',
        plugins: [],
      },
      plugins: [mockSqlPlugin, plugin1, plugin2, plugin3],
      adapter: mockSqlPlugin.adapter,
    });

    // Wait for plugins to register and initialize
    await new Promise((resolve) => setTimeout(resolve, 300));

    // Verify registration happened in order
    expect(registrationOrder).toEqual(['plugin-1', 'plugin-2', 'plugin-3']);

    // Verify all plugin init functions were called
    expect(plugin1.init).toHaveBeenCalledTimes(1);
    expect(plugin2.init).toHaveBeenCalledTimes(1);
    expect(plugin3.init).toHaveBeenCalledTimes(1);

    // Verify initialization happened in order (despite different delays)
    expect(initializationOrder).toEqual(['plugin-1', 'plugin-2', 'plugin-3']);
  });

  it('should handle plugin dependencies in correct order', async () => {
    const serviceInitOrder: string[] = [];

    // Create mock service classes
    class ServiceA {
      static serviceType = 'service_a';
      constructor(_runtime: any) {
        serviceInitOrder.push('ServiceA');
      }
      async initialize() {}
      async stop() {}
      static async start(runtime: any) {
        const instance = new ServiceA(runtime);
        await instance.initialize();
        return instance;
      }
    }

    class ServiceB {
      static serviceType = 'service_b';
      constructor(runtime: any) {
        // This service depends on ServiceA
        const serviceA = runtime.getService('service_a');
        if (!serviceA) {
          throw new Error('ServiceA must be initialized before ServiceB');
        }
        serviceInitOrder.push('ServiceB');
      }
      async initialize() {}
      async stop() {}
      static async start(runtime: any) {
        const instance = new ServiceB(runtime);
        await instance.initialize();
        return instance;
      }
    }

    // Create plugins with services in correct order
    const pluginWithServices: Plugin = {
      name: 'services-plugin',
      description: 'Plugin with dependent services',
      services: [ServiceA as any, ServiceB as any],
      init: async (_config, runtime) => {
        // Manually start services to test order
        for (const Service of pluginWithServices.services || []) {
          const service = await Service.start(runtime);
          // Use the service type name as the key
          (runtime as any).services.set(Service.serviceType, service);
        }
      },
    };

    runtime = new AgentRuntime({
      agentId: '00000000-0000-0000-0000-000000000000' as any,
      character: {
        name: 'Test Agent',
        bio: 'A test agent for plugin order verification',
        plugins: [],
      },
      plugins: [mockSqlPlugin, pluginWithServices],
      adapter: mockSqlPlugin.adapter,
    });

    // Wait for plugin initialization
    await new Promise((resolve) => setTimeout(resolve, 100));

    // Verify services were initialized in correct order
    expect(serviceInitOrder).toEqual(['ServiceA', 'ServiceB']);
  });

  it('should fail if dependent service is registered before dependency', async () => {
    const serviceInitOrder: string[] = [];
    let initError: Error | null = null;

    // Same service classes as above
    class ServiceA {
      static serviceType = 'service_a';
      constructor(_runtime: any) {
        serviceInitOrder.push('ServiceA');
      }
      async initialize() {}
      async stop() {}
      static async start(runtime: any) {
        const instance = new ServiceA(runtime);
        await instance.initialize();
        return instance;
      }
    }

    class ServiceB {
      static serviceType = 'service_b';
      constructor(runtime: any) {
        const serviceA = runtime.getService('service_a');
        if (!serviceA) {
          throw new Error('ServiceA must be initialized before ServiceB');
        }
        serviceInitOrder.push('ServiceB');
      }
      async initialize() {}
      async stop() {}
      static async start(runtime: any) {
        const instance = new ServiceB(runtime);
        await instance.initialize();
        return instance;
      }
    }

    // Create plugin with services in WRONG order
    const pluginWithServices: Plugin = {
      name: 'services-plugin',
      description: 'Plugin with dependent services in wrong order',
      services: [ServiceB as any, ServiceA as any], // Wrong order!
      init: async (_config, runtime) => {
        // Manually start services to test order
        try {
          for (const Service of pluginWithServices.services || []) {
            const service = await Service.start(runtime);
            // Use the service type name as the key
            (runtime as any).services.set(Service.serviceType, service);
          }
        } catch (error) {
          initError = error as Error;
          throw error as unknown as Error;
        }
      },
    };

    runtime = new AgentRuntime({
      agentId: '00000000-0000-0000-0000-000000000000' as any,
      character: {
        name: 'Test Agent',
        bio: 'A test agent for plugin order verification',
        plugins: [],
      },
      plugins: [mockSqlPlugin, pluginWithServices],
      adapter: mockSqlPlugin.adapter,
    });

    // Wait for plugin initialization
    await new Promise((resolve) => setTimeout(resolve, 100));

    // Verify the error was thrown
    expect(initError).toBeTruthy();
    expect((initError as unknown as Error)?.message).toBe(
      'ServiceA must be initialized before ServiceB'
    );
  });

  it('should register plugin components in sequence', async () => {
    const componentOrder: string[] = [];

    // Create a plugin with multiple component types
    const testPlugin: Plugin = {
      name: 'comprehensive-plugin',
      description: 'Plugin with all component types',
      init: async () => {
        componentOrder.push('init');
      },
      actions: [
        {
          name: 'test-action',
          description: 'Test action',
          similes: [],
          examples: [],
          handler: async () => {
            componentOrder.push('action-handler');
            return true;
          },
          validate: async () => true,
        },
      ],
      providers: [
        {
          name: 'test-provider',
          description: 'Test provider',
          get: async () => {
            componentOrder.push('provider-get');
            return { values: {}, text: '' };
          },
        },
      ],
      evaluators: [
        {
          name: 'test-evaluator',
          description: 'Test evaluator',
          similes: [],
          examples: [],
          handler: async () => {
            componentOrder.push('evaluator-handler');
          },
          validate: async () => true,
        },
      ],
      services: [],
    };

    runtime = new AgentRuntime({
      agentId: '00000000-0000-0000-0000-000000000000' as any,
      character: {
        name: 'Test Agent',
        bio: 'A test agent for plugin order verification',
        plugins: [],
      },
      plugins: [mockSqlPlugin, testPlugin],
      adapter: mockSqlPlugin.adapter,
    });

    // Wait for plugin initialization
    await new Promise((resolve) => setTimeout(resolve, 100));

    // Verify init was called
    expect(componentOrder).toContain('init');

    // Verify components were registered
    expect(runtime.actions).toHaveLength(1);
    expect(runtime.providers).toHaveLength(1);
    expect(runtime.evaluators).toHaveLength(1);
  });

  it('should maintain plugin order even with async operations', async () => {
    const executionOrder: string[] = [];

    // Create plugins that perform async operations
    const plugins = Array.from({ length: 5 }, (_, i) => ({
      name: `async-plugin-${i}`,
      description: `Async test plugin ${i}`,
      init: async () => {
        // Random delay between 0-100ms
        const delay = Math.random() * 100;
        await new Promise((resolve) => setTimeout(resolve, delay));
        executionOrder.push(`async-plugin-${i}`);
      },
    }));

    runtime = new AgentRuntime({
      agentId: '00000000-0000-0000-0000-000000000000' as any,
      character: {
        name: 'Test Agent',
        bio: 'A test agent for plugin order verification',
        plugins: [],
      },
      plugins: [mockSqlPlugin, ...plugins],
      adapter: mockSqlPlugin.adapter,
    });

    // Wait for all plugins to initialize
    await new Promise((resolve) => setTimeout(resolve, 600));

    // Despite random delays, plugins should initialize in order
    expect(executionOrder).toEqual([
      'async-plugin-0',
      'async-plugin-1',
      'async-plugin-2',
      'async-plugin-3',
      'async-plugin-4',
    ]);
  });
});
