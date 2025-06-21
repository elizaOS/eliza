import type { IAgentRuntime, Plugin, Action, Provider, Evaluator, Service } from '@elizaos/core';
import { ServiceType } from '@elizaos/core';

// Mock plugin components for testing
const mockAction: Action = {
  name: 'TEST_CONFIG_ACTION',
  similes: [],
  description: 'Test action for configuration system scenario',
  examples: [],
  validate: async (runtime, message, state) => {
    return true;
  },
  handler: async (runtime, message, state, options, callback) => {
    if (callback) {
      await callback({
        text: 'Configuration test action executed successfully',
        thought: 'Testing configuration system functionality',
        actions: ['TEST_CONFIG_ACTION']
      });
    }
    return { text: 'Action executed' };
  }
};

const mockProvider: Provider = {
  name: 'TEST_CONFIG_PROVIDER',
  description: 'Test provider for configuration system scenario',
  get: async (runtime, message, state) => {
    return {
      text: '[CONFIG TEST]\nProvider data for configuration testing\n[/CONFIG TEST]',
      values: {
        configTestData: 'provider-active'
      }
    };
  }
};

const mockEvaluator: Evaluator = {
  name: 'TEST_CONFIG_EVALUATOR',
  description: 'Test evaluator for configuration system scenario',
  examples: [],
  validate: async (runtime, message, state) => {
    return true;
  },
  handler: async (runtime, message, state, options, callback) => {
    console.log('[SCENARIO] Test evaluator executed during configuration test');
    return null;
  }
};

class MockConfigService extends Service {
  static serviceName = 'TEST_CONFIG_SERVICE';
  static serviceType = ServiceType.UNKNOWN;
  capabilityDescription = 'Test service for configuration system scenario';

  private isInitialized = false;

  static async start(runtime: IAgentRuntime): Promise<MockConfigService> {
    const service = new MockConfigService();
    service.isInitialized = true;
    console.log('[SCENARIO] Mock configuration service started');
    return service;
  }

  async stop(): Promise<void> {
    this.isInitialized = false;
    console.log('[SCENARIO] Mock configuration service stopped');
  }

  public isReady(): boolean {
    return this.isInitialized;
  }

  public getTestData(): string {
    return 'service-test-data';
  }
}

// Test plugin for configuration scenarios
const configTestPlugin: Plugin = {
  name: 'config-test-plugin',
  description: 'Plugin for testing configuration system functionality',
  actions: [mockAction],
  providers: [mockProvider],
  evaluators: [mockEvaluator],
  services: [MockConfigService],
  config: {
    actions: {
      TEST_CONFIG_ACTION: {
        enabled: true,
        settings: {
          testMode: true
        }
      }
    },
    providers: {
      TEST_CONFIG_PROVIDER: {
        enabled: true,
        settings: {}
      }
    },
    evaluators: {
      TEST_CONFIG_EVALUATOR: {
        enabled: true,
        settings: {}
      }
    },
    services: {
      TEST_CONFIG_SERVICE: {
        enabled: true,
        settings: {
          maxConnections: 10
        }
      }
    }
  }
};

/**
 * ElizaOS Configuration System Test Scenario
 * 
 * This scenario tests the complete configuration system including:
 * - Plugin component registration and configuration
 * - Hot-swap functionality for enabling/disabling components
 * - Configuration persistence and override levels
 * - Runtime status tracking and synchronization
 */
export default {
  name: 'Configuration System Integration Test',
  description: 'Tests the complete plugin configuration system with hot-swap capabilities',

  async execute(runtime: IAgentRuntime): Promise<void> {
    console.log('🔧 Starting Configuration System Integration Test Scenario...');

    try {
      // Phase 1: Initial Configuration Setup
      console.log('\n📋 Phase 1: Testing initial configuration setup...');
      
      // Register the test plugin
      await runtime.registerPlugin(configTestPlugin);
      
      // Verify configuration manager is available
      const configManager = runtime.getConfigurationManager();
      if (!configManager) {
        throw new Error('Configuration manager not available');
      }
      
      // Check that plugin configuration was loaded
      const pluginConfig = configManager.getPluginConfiguration('config-test-plugin');
      if (!pluginConfig) {
        throw new Error('Plugin configuration not found');
      }
      
      console.log('✅ Plugin configuration loaded successfully');
      console.log(`   - Plugin: ${pluginConfig.pluginName}`);
      console.log(`   - Enabled: ${pluginConfig.enabled}`);
      console.log(`   - Actions: ${Object.keys(pluginConfig.actions || {}).length}`);
      console.log(`   - Providers: ${Object.keys(pluginConfig.providers || {}).length}`);
      console.log(`   - Evaluators: ${Object.keys(pluginConfig.evaluators || {}).length}`);
      console.log(`   - Services: ${Object.keys(pluginConfig.services || {}).length}`);

      // Phase 2: Component Registration Verification
      console.log('\n📋 Phase 2: Verifying component registration...');
      
      // Check that components are registered in runtime
      const registeredAction = runtime.actions.find(a => a.name === 'TEST_CONFIG_ACTION');
      const registeredProvider = runtime.providers.find(p => p.name === 'TEST_CONFIG_PROVIDER');
      const registeredEvaluator = runtime.evaluators.find(e => e.name === 'TEST_CONFIG_EVALUATOR');
      const registeredService = runtime.getService('TEST_CONFIG_SERVICE');
      
      if (!registeredAction) throw new Error('Test action not registered in runtime');
      if (!registeredProvider) throw new Error('Test provider not registered in runtime');
      if (!registeredEvaluator) throw new Error('Test evaluator not registered in runtime');
      if (!registeredService) throw new Error('Test service not registered in runtime');
      
      console.log('✅ All components registered successfully in runtime');

      // Phase 3: Hot-swap Disable Testing
      console.log('\n📋 Phase 3: Testing hot-swap component disable...');
      
      // Disable the action using configurePlugin
      await runtime.configurePlugin('config-test-plugin', {
        actions: {
          TEST_CONFIG_ACTION: {
            enabled: false,
            overrideLevel: 'runtime',
            overrideReason: 'Scenario test disable',
            settings: {},
            lastModified: new Date()
          }
        }
      });
      
      // Verify action is disabled in configuration
      const disabledActionConfig = configManager.getComponentConfig('config-test-plugin', 'TEST_CONFIG_ACTION', 'action');
      if (disabledActionConfig.enabled !== false) {
        throw new Error('Action configuration not updated to disabled');
      }
      
      // Verify action is removed from runtime
      const actionAfterDisable = runtime.actions.find(a => a.name === 'TEST_CONFIG_ACTION');
      if (actionAfterDisable) {
        throw new Error('Action still registered in runtime after disable');
      }
      
      console.log('✅ Hot-swap disable successful');
      console.log('   - Configuration updated to disabled');
      console.log('   - Component removed from runtime');

      // Phase 4: Hot-swap Enable Testing
      console.log('\n📋 Phase 4: Testing hot-swap component enable...');
      
      // Re-enable the action
      await runtime.configurePlugin('config-test-plugin', {
        actions: {
          TEST_CONFIG_ACTION: {
            enabled: true,
            overrideLevel: 'runtime',
            overrideReason: 'Scenario test enable',
            settings: { testMode: true },
            lastModified: new Date()
          }
        }
      });
      
      // Verify action is enabled in configuration
      const enabledActionConfig = configManager.getComponentConfig('config-test-plugin', 'TEST_CONFIG_ACTION', 'action');
      if (enabledActionConfig.enabled !== true) {
        throw new Error('Action configuration not updated to enabled');
      }
      
      // Verify action is back in runtime
      const actionAfterEnable = runtime.actions.find(a => a.name === 'TEST_CONFIG_ACTION');
      if (!actionAfterEnable) {
        throw new Error('Action not registered in runtime after enable');
      }
      
      console.log('✅ Hot-swap enable successful');
      console.log('   - Configuration updated to enabled');
      console.log('   - Component re-registered in runtime');

      // Phase 5: Service Hot-swap Testing
      console.log('\n📋 Phase 5: Testing service hot-swap...');
      
      // Disable service
      await runtime.configurePlugin('config-test-plugin', {
        services: {
          TEST_CONFIG_SERVICE: {
            enabled: false,
            overrideLevel: 'runtime',
            overrideReason: 'Scenario test service disable',
            settings: {},
            lastModified: new Date()
          }
        }
      });
      
      // Verify service is removed
      const serviceAfterDisable = runtime.getService('TEST_CONFIG_SERVICE');
      if (serviceAfterDisable) {
        throw new Error('Service still available after disable');
      }
      
      // Re-enable service
      await runtime.configurePlugin('config-test-plugin', {
        services: {
          TEST_CONFIG_SERVICE: {
            enabled: true,
            overrideLevel: 'runtime',
            overrideReason: 'Scenario test service enable',
            settings: { maxConnections: 20 },
            lastModified: new Date()
          }
        }
      });
      
      // Verify service is back
      const serviceAfterEnable = runtime.getService('TEST_CONFIG_SERVICE');
      if (!serviceAfterEnable) {
        throw new Error('Service not available after enable');
      }
      
      console.log('✅ Service hot-swap successful');

      // Phase 6: Functional Testing with Configuration
      console.log('\n📋 Phase 6: Testing functional behavior with configuration...');
      
      // Create a test message
      const testMessage = {
        entityId: 'test-user-id',
        roomId: 'test-room-id',
        agentId: runtime.agentId,
        content: {
          text: 'test configuration action',
          source: 'scenario-test'
        },
        createdAt: Date.now()
      };
      
      // Test that providers are working
      const state = await runtime.composeState(testMessage);
      if (!state.text.includes('Provider data for configuration testing')) {
        throw new Error('Provider not working correctly');
      }
      
      console.log('✅ Provider functioning correctly with configuration');
      
      // Test action execution
      let actionExecuted = false;
      const callback = async (content: any) => {
        if (content.text?.includes('Configuration test action executed successfully')) {
          actionExecuted = true;
        }
        return [];
      };
      
      await mockAction.handler(runtime, testMessage, state, {}, callback);
      
      if (!actionExecuted) {
        throw new Error('Action not executing correctly');
      }
      
      console.log('✅ Action executing correctly with configuration');

      // Phase 7: Configuration Persistence Testing
      console.log('\n📋 Phase 7: Testing configuration persistence...');
      
      // Set a custom configuration with specific override level
      await configManager.setOverride('gui', 'config-test-plugin', {
        actions: {
          TEST_CONFIG_ACTION: {
            enabled: true,
            settings: {
              persistenceTest: true,
              customValue: 42
            }
          }
        }
      });
      
      // Verify the configuration persisted
      const persistedConfig = configManager.getComponentConfig('config-test-plugin', 'TEST_CONFIG_ACTION', 'action');
      if (!persistedConfig.settings?.persistenceTest) {
        throw new Error('Configuration not persisted correctly');
      }
      
      if (persistedConfig.settings?.customValue !== 42) {
        throw new Error('Custom configuration value not persisted');
      }
      
      console.log('✅ Configuration persistence working correctly');

      // Phase 8: Override Level Testing
      console.log('\n📋 Phase 8: Testing configuration override levels...');
      
      // Set plugin-level default
      await configManager.setOverride('plugin', 'config-test-plugin', {
        actions: {
          TEST_CONFIG_ACTION: {
            enabled: true,
            settings: { level: 'plugin', priority: 1 }
          }
        }
      });
      
      // Set GUI-level override
      await configManager.setOverride('gui', 'config-test-plugin', {
        actions: {
          TEST_CONFIG_ACTION: {
            enabled: true,
            settings: { level: 'gui', priority: 2 }
          }
        }
      });
      
      // Set runtime-level override
      await runtime.configurePlugin('config-test-plugin', {
        actions: {
          TEST_CONFIG_ACTION: {
            enabled: true,
            overrideLevel: 'runtime',
            overrideReason: 'Scenario test runtime override',
            settings: { level: 'runtime', priority: 3 },
            lastModified: new Date()
          }
        }
      });
      
      // Runtime override should take precedence
      const finalConfig = configManager.getComponentConfig('config-test-plugin', 'TEST_CONFIG_ACTION', 'action');
      if (finalConfig.settings?.level !== 'runtime' || finalConfig.settings?.priority !== 3) {
        throw new Error('Runtime override not taking precedence');
      }
      
      console.log('✅ Configuration override levels working correctly');

      // Phase 9: Dependency Validation Testing
      console.log('\n📋 Phase 9: Testing dependency validation...');
      
      const enabledComponents = configManager.getEnabledComponentsMap();
      
      // Test valid dependency
      const validResult = await configManager.updateComponentConfiguration(
        'config-test-plugin',
        'TEST_CONFIG_ACTION',
        'action',
        { enabled: true },
        ['TEST_CONFIG_PROVIDER'],
        enabledComponents
      );
      
      if (!validResult.valid) {
        throw new Error('Valid dependency validation failed');
      }
      
      // Test invalid dependency
      const invalidResult = await configManager.updateComponentConfiguration(
        'config-test-plugin',
        'TEST_CONFIG_ACTION',
        'action',
        { enabled: true },
        ['NON_EXISTENT_COMPONENT'],
        enabledComponents
      );
      
      if (invalidResult.valid) {
        throw new Error('Invalid dependency validation should have failed');
      }
      
      console.log('✅ Dependency validation working correctly');

      // Phase 10: Error Handling Testing
      console.log('\n📋 Phase 10: Testing error handling...');
      
      // Test invalid plugin name
      const invalidPluginConfig = configManager.getPluginConfiguration('non-existent-plugin');
      if (invalidPluginConfig !== null) {
        throw new Error('Should return null for non-existent plugin');
      }
      
      // Test invalid component update
      const invalidComponentResult = await configManager.updateComponentConfiguration(
        'config-test-plugin',
        'NON_EXISTENT_COMPONENT',
        'action',
        { enabled: true },
        [],
        enabledComponents
      );
      
      if (invalidComponentResult.valid) {
        throw new Error('Invalid component update should have failed');
      }
      
      console.log('✅ Error handling working correctly');

      // Final Success
      console.log('\n🎉 Configuration System Integration Test completed successfully!');
      console.log('\n📊 Test Summary:');
      console.log('✅ Initial configuration setup');
      console.log('✅ Component registration verification');
      console.log('✅ Hot-swap disable functionality');
      console.log('✅ Hot-swap enable functionality');
      console.log('✅ Service hot-swap functionality');
      console.log('✅ Functional behavior testing');
      console.log('✅ Configuration persistence');
      console.log('✅ Override level priority');
      console.log('✅ Dependency validation');
      console.log('✅ Error handling');
      
    } catch (error) {
      console.error('❌ Configuration System Integration Test failed:', error);
      throw error;
    }
  }
};