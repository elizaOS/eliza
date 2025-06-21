import { describe, it, expect, beforeEach } from 'vitest';
import { 
  ConfigurationManager,
  Service,
  type ConfigurablePlugin,
  type ConfigurableAction,
  type ConfigurableProvider,
  type ConfigurableEvaluator,
  type ConfigurableService,
  type Action,
  type Provider,
  type Evaluator,
  type ComponentDefinition,
  type PluginConfiguration 
} from '@elizaos/core';

// Mock implementations for testing
const mockAction: Action = {
  name: 'TEST_ACTION',
  description: 'Test action',
  validate: async () => true,
  handler: async () => ({ text: 'Test response' }),
  examples: [],
};

const mockProvider: Provider = {
  name: 'TEST_PROVIDER',
  get: async () => ({ text: 'Test provider data' }),
};

const mockEvaluator: Evaluator = {
  name: 'TEST_EVALUATOR',
  description: 'Test evaluator',
  validate: async () => true,
  handler: async () => ({}),
  examples: [],
};

class MockTestService extends Service {
  static serviceName = 'test-service';
  static serviceType = 'TEST';
  
  capabilityDescription = 'Mock test service';
  
  async stop(): Promise<void> {}
  
  static async start(): Promise<MockTestService> {
    return new MockTestService();
  }
}

describe('Complete Configuration System Integration', () => {
  let configManager: ConfigurationManager;

  beforeEach(() => {
    configManager = new ConfigurationManager();
  });

  describe('Legacy Plugin Support (Backwards Compatibility)', () => {
    it('should handle traditional plugin structure', () => {
      const legacyPlugin = {
        name: '@test/legacy-plugin',
        description: 'Legacy plugin with traditional arrays',
        actions: [mockAction],
        providers: [mockProvider],
        evaluators: [mockEvaluator],
        services: [MockTestService],
      };

      // Legacy plugins don't use the configurable system
      // but should still work with the configuration manager
      const config = configManager.initializePluginConfiguration(legacyPlugin as any);

      expect(config.pluginName).toBe('@test/legacy-plugin');
      expect(config.enabled).toBe(true);
      expect(config.actions).toEqual({});
      expect(config.providers).toEqual({});
      expect(config.evaluators).toEqual({});
      expect(config.services).toEqual({});
    });
  });

  describe('New Configurable Plugin System', () => {
    it('should handle fully configurable plugin with all component types', () => {
      const configurableActions: ConfigurableAction[] = [
        {
          ...mockAction,
          name: 'CONFIGURABLE_ACTION',
          config: {
            enabled: true,
            category: 'core',
            requiredSettings: ['API_KEY'],
          },
        },
        {
          ...mockAction,
          name: 'DISABLED_ACTION',
          config: {
            enabled: false,
            category: 'experimental',
            disabledReason: 'Under development',
          },
        },
      ];

      const configurableProviders: ConfigurableProvider[] = [
        {
          ...mockProvider,
          name: 'CONFIGURABLE_PROVIDER',
          config: {
            enabled: true,
            category: 'data',
          },
        },
        {
          ...mockProvider,
          name: 'EXPENSIVE_PROVIDER',
          config: {
            enabled: false,
            category: 'performance',
            disabledReason: 'High resource usage',
          },
        },
      ];

      const configurableEvaluators: ConfigurableEvaluator[] = [
        {
          ...mockEvaluator,
          name: 'CONFIGURABLE_EVALUATOR',
          config: {
            enabled: true,
            category: 'analysis',
          },
        },
      ];

      const configurableServices: ConfigurableService[] = [
        {
          service: MockTestService,
          config: {
            enabled: true,
            category: 'infrastructure',
            requiredSettings: ['DATABASE_URL'],
          },
        },
      ];

      const configurablePlugin: ConfigurablePlugin = {
        name: '@test/configurable-plugin',
        description: 'Full configurable plugin',
        configurableActions,
        configurableProviders,
        configurableEvaluators,
        configurableServices,
        config: {
          defaultEnabled: true,
          category: 'test',
          permissions: ['admin'],
        },
      };

      const config = configManager.initializePluginConfiguration(configurablePlugin);

      // Check all component types are initialized
      expect(config.actions['CONFIGURABLE_ACTION']).toEqual({
        enabled: true,
        overrideLevel: 'plugin',
        settings: {},
        lastModified: expect.any(Date),
      });

      expect(config.actions['DISABLED_ACTION']).toEqual({
        enabled: false,
        overrideLevel: 'plugin',
        overrideReason: 'Under development',
        settings: {},
        lastModified: expect.any(Date),
      });

      expect(config.providers['CONFIGURABLE_PROVIDER']).toEqual({
        enabled: true,
        overrideLevel: 'plugin',
        settings: {},
        lastModified: expect.any(Date),
      });

      expect(config.providers['EXPENSIVE_PROVIDER']).toEqual({
        enabled: false,
        overrideLevel: 'plugin',
        overrideReason: 'High resource usage',
        settings: {},
        lastModified: expect.any(Date),
      });

      expect(config.evaluators!['CONFIGURABLE_EVALUATOR']).toEqual({
        enabled: true,
        overrideLevel: 'plugin',
        settings: {},
        lastModified: expect.any(Date),
      });

      expect(config.services!['test-service']).toEqual({
        enabled: true,
        overrideLevel: 'plugin',
        settings: {},
        lastModified: expect.any(Date),
      });
    });
  });

  describe('Unified Component Definition System', () => {
    it('should handle mixed component types in unified array', () => {
      const componentDefinitions: ComponentDefinition[] = [
        {
          type: 'action',
          name: 'unified-action',
          component: mockAction,
          config: {
            enabled: true,
            defaultEnabled: true,
            category: 'unified',
          },
        },
        {
          type: 'provider',
          component: mockProvider,
          config: {
            enabled: false,
            defaultEnabled: false,
            disabledReason: 'Optional provider',
          },
        },
        {
          type: 'evaluator',
          component: mockEvaluator,
          config: {
            enabled: true,
            defaultEnabled: true,
            experimental: true,
          },
        },
        {
          type: 'service',
          name: 'unified-service',
          component: MockTestService,
          config: {
            enabled: true,
            defaultEnabled: true,
            category: 'infrastructure',
          },
        },
      ];

      const config = configManager.initializeUnifiedPluginConfiguration(
        '@test/unified-plugin',
        componentDefinitions
      );

      expect(config.actions['unified-action']).toBeDefined();
      expect(config.actions['unified-action'].enabled).toBe(true);

      expect(config.providers['TEST_PROVIDER']).toBeDefined();
      expect(config.providers['TEST_PROVIDER'].enabled).toBe(false);

      expect(config.evaluators!['TEST_EVALUATOR']).toBeDefined();
      expect(config.evaluators!['TEST_EVALUATOR'].enabled).toBe(true);

      expect(config.services!['unified-service']).toBeDefined();
      expect(config.services!['unified-service'].enabled).toBe(true);
    });
  });

  describe('Mixed Legacy and Configurable Components', () => {
    it('should handle plugin with both legacy and configurable components', () => {
      const mixedPlugin: ConfigurablePlugin = {
        name: '@test/mixed-plugin',
        description: 'Plugin with both legacy and configurable components',
        
        // Legacy components (always enabled)
        actions: [mockAction],
        providers: [mockProvider],
        
        // Configurable components (can be enabled/disabled)
        configurableActions: [
          {
            ...mockAction,
            name: 'CONFIG_ACTION',
            config: { enabled: false, disabledReason: 'Configurable action' },
          },
        ],
        configurableServices: [
          {
            service: MockTestService,
            config: { enabled: true, category: 'infrastructure' },
          },
        ],
      };

      const config = configManager.initializePluginConfiguration(mixedPlugin);

      // Legacy components are not in the configurable system
      expect(config.actions['TEST_ACTION']).toBeUndefined();
      expect(config.providers['TEST_PROVIDER']).toBeUndefined();

      // Configurable components are in the system
      expect(config.actions['CONFIG_ACTION']).toEqual({
        enabled: false,
        overrideLevel: 'plugin',
        overrideReason: 'Configurable action',
        settings: {},
        lastModified: expect.any(Date),
      });

      expect(config.services!['test-service']).toEqual({
        enabled: true,
        overrideLevel: 'plugin',
        settings: {},
        lastModified: expect.any(Date),
      });
    });
  });

  describe('Dynamic Configuration Changes', () => {
    it('should handle runtime configuration changes across all component types', async () => {
      const configurablePlugin: ConfigurablePlugin = {
        name: '@test/runtime-config',
        description: 'Plugin for runtime configuration testing',
        configurableActions: [
          {
            ...mockAction,
            name: 'RUNTIME_ACTION',
            config: { enabled: true },
          },
        ],
        configurableProviders: [
          {
            ...mockProvider,
            name: 'RUNTIME_PROVIDER',
            config: { enabled: true },
          },
        ],
        configurableEvaluators: [
          {
            ...mockEvaluator,
            name: 'RUNTIME_EVALUATOR',
            config: { enabled: true },
          },
        ],
        configurableServices: [
          {
            service: MockTestService,
            config: { enabled: true },
          },
        ],
      };

      configManager.initializePluginConfiguration(configurablePlugin);

      // Verify initial state
      expect(configManager.isComponentEnabled('@test/runtime-config', 'RUNTIME_ACTION', 'action')).toBe(true);
      expect(configManager.isComponentEnabled('@test/runtime-config', 'RUNTIME_PROVIDER', 'provider')).toBe(true);
      expect(configManager.isComponentEnabled('@test/runtime-config', 'RUNTIME_EVALUATOR', 'evaluator')).toBe(true);
      expect(configManager.isComponentEnabled('@test/runtime-config', 'test-service', 'service')).toBe(true);

      // Apply runtime overrides to disable all components
      const overrides: Partial<PluginConfiguration> = {
        actions: {
          RUNTIME_ACTION: {
            enabled: false,
            overrideLevel: 'runtime',
            overrideReason: 'Disabled by admin',
            settings: {},
            lastModified: new Date(),
          },
        },
        providers: {
          RUNTIME_PROVIDER: {
            enabled: false,
            overrideLevel: 'runtime',
            overrideReason: 'Maintenance mode',
            settings: {},
            lastModified: new Date(),
          },
        },
        evaluators: {
          RUNTIME_EVALUATOR: {
            enabled: false,
            overrideLevel: 'runtime',
            overrideReason: 'Performance optimization',
            settings: {},
            lastModified: new Date(),
          },
        },
        services: {
          'test-service': {
            enabled: false,
            overrideLevel: 'runtime',
            overrideReason: 'Service maintenance',
            settings: {},
            lastModified: new Date(),
          },
        },
      };

      await configManager.setOverride('runtime', '@test/runtime-config', overrides);

      // Verify all components are now disabled
      expect(configManager.isComponentEnabled('@test/runtime-config', 'RUNTIME_ACTION', 'action')).toBe(false);
      expect(configManager.isComponentEnabled('@test/runtime-config', 'RUNTIME_PROVIDER', 'provider')).toBe(false);
      expect(configManager.isComponentEnabled('@test/runtime-config', 'RUNTIME_EVALUATOR', 'evaluator')).toBe(false);
      expect(configManager.isComponentEnabled('@test/runtime-config', 'test-service', 'service')).toBe(false);

      // Verify enabled components map reflects changes
      const enabledComponents = configManager.getEnabledComponentsMap();
      const pluginComponents = enabledComponents.get('@test/runtime-config');
      
      expect(pluginComponents!.has('action:RUNTIME_ACTION')).toBe(false);
      expect(pluginComponents!.has('provider:RUNTIME_PROVIDER')).toBe(false);
      expect(pluginComponents!.has('evaluator:RUNTIME_EVALUATOR')).toBe(false);
      expect(pluginComponents!.has('service:test-service')).toBe(false);
    });
  });

  describe('Configuration Priority System', () => {
    it('should respect configuration source priorities', async () => {
      const configurablePlugin: ConfigurablePlugin = {
        name: '@test/priority-config',
        description: 'Plugin for priority testing',
        configurableServices: [
          {
            service: MockTestService,
            config: { enabled: false, disabledReason: 'Default disabled' },
          },
        ],
      };

      configManager.initializePluginConfiguration(configurablePlugin);

      // Initial state: disabled by plugin
      expect(configManager.isComponentEnabled('@test/priority-config', 'test-service', 'service')).toBe(false);

      // Database override (priority 3)
      await configManager.setOverride('database', '@test/priority-config', {
        services: {
          'test-service': {
            enabled: true,
            overrideLevel: 'database',
            overrideReason: 'Enabled in database',
            settings: { source: 'database' },
            lastModified: new Date(),
          },
        },
      });

      expect(configManager.isComponentEnabled('@test/priority-config', 'test-service', 'service')).toBe(true);

      // GUI override (priority 5) should override database
      await configManager.setOverride('gui', '@test/priority-config', {
        services: {
          'test-service': {
            enabled: false,
            overrideLevel: 'gui',
            overrideReason: 'Disabled by user',
            settings: { source: 'gui' },
            lastModified: new Date(),
          },
        },
      });

      expect(configManager.isComponentEnabled('@test/priority-config', 'test-service', 'service')).toBe(false);

      // Runtime override (priority 6) should override everything
      await configManager.setOverride('runtime', '@test/priority-config', {
        services: {
          'test-service': {
            enabled: true,
            overrideLevel: 'runtime',
            overrideReason: 'Emergency enable',
            settings: { source: 'runtime' },
            lastModified: new Date(),
          },
        },
      });

      expect(configManager.isComponentEnabled('@test/priority-config', 'test-service', 'service')).toBe(true);

      // Verify the final configuration shows runtime override
      const serviceConfig = configManager.getComponentConfig('@test/priority-config', 'test-service', 'service');
      expect(serviceConfig.overrideLevel).toBe('runtime');
      expect(serviceConfig.settings?.source).toBe('runtime');
    });
  });

  describe('Complete System Verification', () => {
    it('should demonstrate complete configurable component system functionality', async () => {
      // Create a comprehensive plugin using all features
      const comprehensivePlugin: ConfigurablePlugin = {
        name: '@test/comprehensive-plugin',
        description: 'Comprehensive plugin demonstrating all features',
        
        // Mixed configuration with various enabled/disabled states
        configurableActions: [
          {
            ...mockAction,
            name: 'ENABLED_ACTION',
            config: { enabled: true, category: 'core' },
          },
          {
            ...mockAction,
            name: 'DISABLED_ACTION',
            config: { enabled: false, disabledReason: 'Beta feature' },
          },
        ],
        configurableProviders: [
          {
            ...mockProvider,
            name: 'ENABLED_PROVIDER',
            config: { enabled: true, category: 'data' },
          },
          {
            ...mockProvider,
            name: 'DISABLED_PROVIDER',
            config: { enabled: false, experimental: true },
          },
        ],
        configurableEvaluators: [
          {
            ...mockEvaluator,
            name: 'ENABLED_EVALUATOR',
            config: { enabled: true, category: 'analysis' },
          },
        ],
        configurableServices: [
          {
            service: MockTestService,
            config: { enabled: true, category: 'infrastructure' },
          },
        ],
        
        // Legacy components for backwards compatibility
        actions: [mockAction],
        providers: [mockProvider],
        
        config: {
          defaultEnabled: true,
          category: 'comprehensive',
          permissions: ['read', 'write'],
          metadata: { version: '1.0.0' },
        },
      };

      // Initialize plugin configuration
      const config = configManager.initializePluginConfiguration(comprehensivePlugin);

      // Verify initial configuration
      expect(config.pluginName).toBe('@test/comprehensive-plugin');
      expect(config.enabled).toBe(true);
      
      // Verify enabled components
      expect(configManager.isComponentEnabled('@test/comprehensive-plugin', 'ENABLED_ACTION', 'action')).toBe(true);
      expect(configManager.isComponentEnabled('@test/comprehensive-plugin', 'ENABLED_PROVIDER', 'provider')).toBe(true);
      expect(configManager.isComponentEnabled('@test/comprehensive-plugin', 'ENABLED_EVALUATOR', 'evaluator')).toBe(true);
      expect(configManager.isComponentEnabled('@test/comprehensive-plugin', 'test-service', 'service')).toBe(true);
      
      // Verify disabled components
      expect(configManager.isComponentEnabled('@test/comprehensive-plugin', 'DISABLED_ACTION', 'action')).toBe(false);
      expect(configManager.isComponentEnabled('@test/comprehensive-plugin', 'DISABLED_PROVIDER', 'provider')).toBe(false);

      // Test runtime overrides
      await configManager.setOverride('gui', '@test/comprehensive-plugin', {
        actions: {
          DISABLED_ACTION: {
            enabled: true,
            overrideLevel: 'gui',
            overrideReason: 'User enabled beta feature',
            settings: { beta: true },
            lastModified: new Date(),
          },
        },
        services: {
          'test-service': {
            enabled: false,
            overrideLevel: 'gui',
            overrideReason: 'Maintenance mode',
            settings: { maintenance: true },
            lastModified: new Date(),
          },
        },
      });

      // Verify overrides worked
      expect(configManager.isComponentEnabled('@test/comprehensive-plugin', 'DISABLED_ACTION', 'action')).toBe(true);
      expect(configManager.isComponentEnabled('@test/comprehensive-plugin', 'test-service', 'service')).toBe(false);

      // Verify enabled components map is accurate
      const enabledComponents = configManager.getEnabledComponentsMap();
      const pluginComponents = enabledComponents.get('@test/comprehensive-plugin');
      
      expect(pluginComponents!.has('action:ENABLED_ACTION')).toBe(true);
      expect(pluginComponents!.has('action:DISABLED_ACTION')).toBe(true); // Now enabled
      expect(pluginComponents!.has('provider:ENABLED_PROVIDER')).toBe(true);
      expect(pluginComponents!.has('provider:DISABLED_PROVIDER')).toBe(false);
      expect(pluginComponents!.has('evaluator:ENABLED_EVALUATOR')).toBe(true);
      expect(pluginComponents!.has('service:test-service')).toBe(false); // Now disabled

      // Test individual component configuration updates
      const updateResult = await configManager.updateComponentConfiguration(
        '@test/comprehensive-plugin',
        'DISABLED_PROVIDER',
        'provider',
        {
          enabled: true,
          overrideLevel: 'gui',
          overrideReason: 'User requested',
          settings: { userRequested: true },
        }
      );

      expect(updateResult.valid).toBe(true);
      expect(configManager.isComponentEnabled('@test/comprehensive-plugin', 'DISABLED_PROVIDER', 'provider')).toBe(true);

      // Verify complete plugin configuration
      const fullConfig = configManager.getPluginConfiguration('@test/comprehensive-plugin');
      expect(fullConfig).not.toBeNull();
      expect(fullConfig!.pluginName).toBe('@test/comprehensive-plugin');
      expect(fullConfig!.settings).toEqual({ version: '1.0.0' });
    });
  });
});