import { describe, it, expect, beforeEach } from 'vitest';
import { 
  ConfigurationManager,
  Service,
  type ConfigurablePlugin, 
  type ConfigurableService,
  type ComponentConfigState,
  type PluginConfiguration 
} from '@elizaos/core';

// Mock service classes for testing
class MockDatabaseService extends Service {
  static serviceName = 'database';
  static serviceType = 'DATABASE';
  
  capabilityDescription = 'Mock database service for testing';
  
  async stop(): Promise<void> {
    // Mock implementation
  }
  
  static async start(): Promise<MockDatabaseService> {
    return new MockDatabaseService();
  }
}

class MockCacheService extends Service {
  static serviceName = 'cache';
  static serviceType = 'CACHE';
  
  capabilityDescription = 'Mock cache service for testing';
  
  async stop(): Promise<void> {
    // Mock implementation
  }
  
  static async start(): Promise<MockCacheService> {
    return new MockCacheService();
  }
}

describe('ConfigurationManager Services Support', () => {
  let configManager: ConfigurationManager;
  let mockPlugin: ConfigurablePlugin;

  beforeEach(() => {
    configManager = new ConfigurationManager();
    
    // Create mock plugin with configurable services
    const configurableServices: ConfigurableService[] = [
      {
        service: MockDatabaseService,
        config: {
          enabled: true,
          category: 'storage',
          requiredSettings: ['DATABASE_URL'],
        },
      },
      {
        service: MockCacheService,
        config: {
          enabled: false,
          category: 'storage',
          disabledReason: 'Optional caching service',
        },
      },
    ];

    mockPlugin = {
      name: '@test/services-plugin',
      description: 'Test plugin with configurable services',
      configurableServices,
      config: {
        defaultEnabled: true,
        category: 'test',
      },
    };
  });

  describe('Plugin Configuration Initialization', () => {
    it('should initialize service configurations from plugin definition', () => {
      const config = configManager.initializePluginConfiguration(mockPlugin);

      expect(config.services).toBeDefined();
      expect(config.services!['database']).toEqual({
        enabled: true,
        overrideLevel: 'plugin',
        settings: {},
        lastModified: expect.any(Date),
      });
      
      expect(config.services!['cache']).toEqual({
        enabled: false,
        overrideLevel: 'plugin',
        overrideReason: 'Optional caching service',
        settings: {},
        lastModified: expect.any(Date),
      });
    });

    it('should handle plugins without configurable services', () => {
      const pluginWithoutServices: ConfigurablePlugin = {
        name: '@test/no-services-plugin',
        description: 'Test plugin without services',
        config: { defaultEnabled: true },
      };

      const config = configManager.initializePluginConfiguration(pluginWithoutServices);
      
      expect(config.services).toEqual({});
    });
  });

  describe('Service Configuration Management', () => {
    beforeEach(() => {
      configManager.initializePluginConfiguration(mockPlugin);
    });

    it('should get service configuration correctly', () => {
      const databaseConfig = configManager.getComponentConfig(
        '@test/services-plugin',
        'database',
        'service'
      );

      expect(databaseConfig.enabled).toBe(true);
      expect(databaseConfig.overrideLevel).toBe('plugin');
    });

    it('should check if service is enabled', () => {
      expect(
        configManager.isComponentEnabled('@test/services-plugin', 'database', 'service')
      ).toBe(true);
      
      expect(
        configManager.isComponentEnabled('@test/services-plugin', 'cache', 'service')
      ).toBe(false);
    });

    it('should return default config for non-existent service', () => {
      const config = configManager.getComponentConfig(
        '@test/services-plugin',
        'nonexistent',
        'service'
      );

      expect(config.enabled).toBe(true);
      expect(config.overrideLevel).toBe('default');
    });
  });

  describe('Service Configuration Overrides', () => {
    beforeEach(() => {
      configManager.initializePluginConfiguration(mockPlugin);
    });

    it('should apply service configuration overrides', async () => {
      const override: Partial<PluginConfiguration> = {
        services: {
          cache: {
            enabled: true,
            overrideLevel: 'gui',
            overrideReason: 'User enabled cache',
            settings: { ttl: 3600 },
            lastModified: new Date(),
          },
        },
      };

      await configManager.setOverride('gui', '@test/services-plugin', override);

      const cacheConfig = configManager.getComponentConfig(
        '@test/services-plugin',
        'cache',
        'service'
      );

      expect(cacheConfig.enabled).toBe(true);
      expect(cacheConfig.overrideLevel).toBe('gui');
      expect(cacheConfig.overrideReason).toBe('User enabled cache');
      expect(cacheConfig.settings).toEqual({ ttl: 3600 });
    });

    it('should disable enabled service via override', async () => {
      const override: Partial<PluginConfiguration> = {
        services: {
          database: {
            enabled: false,
            overrideLevel: 'gui',
            overrideReason: 'Disabled for maintenance',
            settings: {},
            lastModified: new Date(),
          },
        },
      };

      await configManager.setOverride('gui', '@test/services-plugin', override);

      expect(
        configManager.isComponentEnabled('@test/services-plugin', 'database', 'service')
      ).toBe(false);
    });
  });

  describe('Enabled Components Map', () => {
    beforeEach(() => {
      configManager.initializePluginConfiguration(mockPlugin);
    });

    it('should include enabled services in components map', () => {
      const enabledComponents = configManager.getEnabledComponentsMap();
      const pluginComponents = enabledComponents.get('@test/services-plugin');

      expect(pluginComponents).toBeDefined();
      expect(pluginComponents!.has('service:database')).toBe(true);
      expect(pluginComponents!.has('service:cache')).toBe(false);
    });

    it('should update components map after service override', async () => {
      // Enable cache service
      await configManager.setOverride('gui', '@test/services-plugin', {
        services: {
          cache: {
            enabled: true,
            overrideLevel: 'gui',
            settings: {},
            lastModified: new Date(),
          },
        },
      });

      const enabledComponents = configManager.getEnabledComponentsMap();
      const pluginComponents = enabledComponents.get('@test/services-plugin');

      expect(pluginComponents!.has('service:cache')).toBe(true);
    });
  });

  describe('Service Component Configuration Updates', () => {
    beforeEach(() => {
      configManager.initializePluginConfiguration(mockPlugin);
    });

    it('should update service configuration with validation', async () => {
      const result = await configManager.updateComponentConfiguration(
        '@test/services-plugin',
        'cache',
        'service',
        {
          enabled: true,
          overrideLevel: 'gui',
          overrideReason: 'User enabled',
          settings: { maxSize: 1000 },
        }
      );

      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);

      const cacheConfig = configManager.getComponentConfig(
        '@test/services-plugin',
        'cache',
        'service'
      );

      expect(cacheConfig.enabled).toBe(true);
      expect(cacheConfig.settings).toEqual({ maxSize: 1000 });
    });
  });

  describe('Unified Component Definitions', () => {
    it('should handle service component definitions', () => {
      const componentDefinitions = [
        {
          type: 'service' as const,
          name: 'custom-database',
          component: MockDatabaseService,
          config: {
            enabled: true,
            defaultEnabled: true,
            category: 'storage',
          },
        },
        {
          type: 'service' as const,
          component: MockCacheService,
          config: {
            enabled: false,
            defaultEnabled: false,
            disabledReason: 'Experimental feature',
          },
        },
      ];

      const config = configManager.initializeUnifiedPluginConfiguration(
        '@test/unified-services',
        componentDefinitions
      );

      expect(config.services).toBeDefined();
      expect(config.services!['custom-database']).toEqual({
        enabled: true,
        overrideLevel: 'plugin',
        settings: {},
        lastModified: expect.any(Date),
      });
      
      // The service without explicit name uses serviceName (which is 'cache')
      expect(config.services!['cache']).toEqual({
        enabled: false,
        overrideLevel: 'plugin',
        overrideReason: 'Experimental feature',
        settings: {},
        lastModified: expect.any(Date),
      });
    });
  });

  describe('Configuration Merging', () => {
    it('should merge service configurations from multiple sources', async () => {
      // Initialize plugin config
      configManager.initializePluginConfiguration(mockPlugin);

      // Create a mock configuration source
      const mockSource = {
        name: 'database',
        priority: 3,
        load: async () => ({
          '@test/services-plugin': {
            pluginName: '@test/services-plugin',
            enabled: true,
            actions: {},
            providers: {},
            evaluators: {},
            services: {
              cache: {
                enabled: true,
                overrideLevel: 'database' as any,
                overrideReason: 'Database override',
                settings: { source: 'database' },
                lastModified: new Date(),
              },
            },
            settings: {},
            lastModified: new Date(),
          },
        }),
        save: async () => {},
      };

      configManager.registerSource(mockSource);
      await configManager.reload();

      const cacheConfig = configManager.getComponentConfig(
        '@test/services-plugin',
        'cache',
        'service'
      );

      expect(cacheConfig.enabled).toBe(true);
      expect(cacheConfig.overrideLevel).toBe('database');
      expect(cacheConfig.settings).toEqual({ source: 'database' });
    });
  });
});