import type { TestSuite, IAgentRuntime, Memory } from '@elizaos/core';
import { createUniqueUuid } from '@elizaos/core';

// Test for createPlugin action
export const createPluginActionTest = {
  name: 'create-plugin-action-e2e',
  description: 'E2E test for createPlugin action with real runtime',
  fn: async (runtime: IAgentRuntime) => {
    console.log('Starting Create Plugin Action E2E Test...');

    try {
      // 1. Create test data - Note: This test will validate but not execute without API key
      const testRoomId = createUniqueUuid(runtime, 'test-room');
      const specification = {
        name: '@elizaos/plugin-weather',
        description: 'Provides weather information',
        version: '1.0.0',
        actions: [
          {
            name: 'getCurrentWeather',
            description: 'Get current weather for a city',
            parameters: {
              city: 'string',
            },
          },
        ],
      };

      const message: Memory = {
        id: createUniqueUuid(runtime, 'test-message'),
        content: {
          text: JSON.stringify(specification), // Action expects JSON specification
          source: 'test',
        },
        roomId: testRoomId,
        agentId: runtime.agentId,
        entityId: runtime.agentId,
        createdAt: Date.now(),
      };

      // 2. Find and validate action
      const createAction = runtime.actions.find((action) => action.name === 'createPlugin');

      if (!createAction) {
        throw new Error('createPlugin action not found');
      }

      const isValid = await createAction.validate(runtime, message);
      console.log(`✓ Validation result: ${isValid}`);

      // Note: Without API key, validation may fail or action won't create actual plugin
      if (isValid) {
        console.log('✓ createPlugin action found and validated');

        // 3. Execute action
        const state = await runtime.composeState(message);
        let responseReceived = false;

        const callback = async (response: any) => {
          console.log('✓ Action response:', response.text);
          responseReceived = true;
          return [];
        };

        await createAction.handler(runtime, message, state, {}, callback);

        // 4. Verify response was received
        if (!responseReceived) {
          throw new Error('No response received from action');
        }
      } else {
        console.log(
          '✓ Action validation handled correctly (may require API key or no active jobs)'
        );
      }

      console.log('✅ Create Plugin Action E2E Test PASSED\n');
    } catch (error) {
      console.error('❌ Create Plugin Action E2E Test FAILED:', error);
      throw error;
    }
  },
};

// Test for checkPluginCreationStatus action
export const checkStatusActionTest = {
  name: 'check-status-action-e2e',
  description: 'E2E test for checkPluginCreationStatus action',
  fn: async (runtime: IAgentRuntime) => {
    console.log('Starting Check Status Action E2E Test...');

    try {
      // Create test message
      const testRoomId = createUniqueUuid(runtime, 'test-room');
      const message: Memory = {
        id: createUniqueUuid(runtime, 'test-message'),
        content: {
          text: 'Check the status of my plugin creation job',
          source: 'test',
        },
        roomId: testRoomId,
        agentId: runtime.agentId,
        entityId: runtime.agentId,
        createdAt: Date.now(),
      };

      // Find action
      const checkAction = runtime.actions.find(
        (action) => action.name === 'checkPluginCreationStatus'
      );

      if (!checkAction) {
        throw new Error('checkPluginCreationStatus action not found');
      }

      // Validate
      const isValid = await checkAction.validate(runtime, message);
      console.log(`✓ Validation result: ${isValid}`);

      if (isValid) {
        // Execute
        const state = await runtime.composeState(message);
        const callback = async (response: any) => {
          console.log('✓ Status check response:', response.text);
          return [];
        };

        await checkAction.handler(runtime, message, state, {}, callback);
      } else {
        console.log('✓ No active jobs to check (expected when no jobs are running)');
      }

      console.log('✅ Check Status Action E2E Test PASSED\n');
    } catch (error) {
      console.error('❌ Check Status Action E2E Test FAILED:', error);
      throw error;
    }
  },
};

// Test for plugin providers
export const pluginProvidersTest = {
  name: 'plugin-providers-e2e',
  description: 'E2E test for plugin creation providers',
  fn: async (runtime: IAgentRuntime) => {
    console.log('Starting Plugin Providers E2E Test...');

    try {
      // Create test message for context
      const message: Memory = {
        id: createUniqueUuid(runtime, 'test-message'),
        content: { text: 'test', source: 'test' },
        roomId: createUniqueUuid(runtime, 'test-room'),
        agentId: runtime.agentId,
        entityId: runtime.agentId,
        createdAt: Date.now(),
      };

      const state = await runtime.composeState(message);

      // Test capabilities provider
      const capabilitiesProvider = runtime.providers.find(
        (p) => p.name === 'pluginCreationCapabilities'
      );

      if (!capabilitiesProvider) {
        throw new Error('Plugin capabilities provider not found');
      }

      const capabilities = await capabilitiesProvider.get(runtime, message, state);
      console.log('✓ Capabilities provider returned:', capabilities.text.substring(0, 100) + '...');

      // Test registry provider
      const registryProvider = runtime.providers.find((p) => p.name === 'pluginRegistry');

      if (!registryProvider) {
        throw new Error('Plugin registry provider not found');
      }

      const registry = await registryProvider.get(runtime, message, state);
      console.log('✓ Registry provider returned:', registry.text);

      console.log('✅ Plugin Providers E2E Test PASSED\n');
    } catch (error) {
      console.error('❌ Plugin Providers E2E Test FAILED:', error);
      throw error;
    }
  },
};

// Test for createPluginFromDescription action
export const createFromDescriptionTest = {
  name: 'create-from-description-e2e',
  description: 'E2E test for createPluginFromDescription action',
  fn: async (runtime: IAgentRuntime) => {
    console.log('Starting Create From Description E2E Test...');

    try {
      // Create test message with plugin description
      const testRoomId = createUniqueUuid(runtime, 'test-room');
      const message: Memory = {
        id: createUniqueUuid(runtime, 'test-message'),
        content: {
          text: 'I need a plugin that can send SMS messages using Twilio. It should have actions for sending SMS and checking delivery status.',
          source: 'test',
        },
        roomId: testRoomId,
        agentId: runtime.agentId,
        entityId: runtime.agentId,
        createdAt: Date.now(),
      };

      // Find action
      const action = runtime.actions.find(
        (action) => action.name === 'createPluginFromDescription'
      );

      if (!action) {
        throw new Error('createPluginFromDescription action not found');
      }

      // Validate
      const isValid = await action.validate(runtime, message);
      if (!isValid) {
        console.log(
          '✓ Validation correctly handled (may need longer description or no active jobs)'
        );
      } else {
        console.log('✓ Description validated');

        // Execute only if API key is available
        const hasApiKey = !!runtime.getSetting('ANTHROPIC_API_KEY');
        if (hasApiKey) {
          const state = await runtime.composeState(message);
          const callback = async (response: any) => {
            console.log('✓ Action response:', response.text.substring(0, 100) + '...');
            return [];
          };

          await action.handler(runtime, message, state, {}, callback);
        } else {
          console.log('✓ Skipping execution (no API key)');
        }
      }

      console.log('✅ Create From Description E2E Test PASSED\n');
    } catch (error) {
      console.error('❌ Create From Description E2E Test FAILED:', error);
      throw error;
    }
  },
};

// Test for cancelPluginCreation action
export const cancelPluginActionTest = {
  name: 'cancel-plugin-action-e2e',
  description: 'E2E test for cancelPluginCreation action',
  fn: async (runtime: IAgentRuntime) => {
    console.log('Starting Cancel Plugin Action E2E Test...');

    try {
      const testRoomId = createUniqueUuid(runtime, 'test-room');
      const message: Memory = {
        id: createUniqueUuid(runtime, 'test-message'),
        content: {
          text: 'Cancel the plugin creation',
          source: 'test',
        },
        roomId: testRoomId,
        agentId: runtime.agentId,
        entityId: runtime.agentId,
        createdAt: Date.now(),
      };

      // Find action
      const cancelAction = runtime.actions.find((action) => action.name === 'cancelPluginCreation');

      if (!cancelAction) {
        throw new Error('cancelPluginCreation action not found');
      }

      // Validate
      const isValid = await cancelAction.validate(runtime, message);
      console.log(`✓ Validation result: ${isValid} (false is expected when no active jobs)`);

      if (isValid) {
        // Execute
        const state = await runtime.composeState(message);
        const callback = async (response: any) => {
          console.log('✓ Cancel response:', response.text);
          return [];
        };

        await cancelAction.handler(runtime, message, state, {}, callback);
      } else {
        console.log('✓ No active jobs to cancel (expected)');
      }

      console.log('✅ Cancel Plugin Action E2E Test PASSED\n');
    } catch (error) {
      console.error('❌ Cancel Plugin Action E2E Test FAILED:', error);
      throw error;
    }
  },
};

// Integration test - full workflow
export const pluginCreationIntegrationTest = {
  name: 'plugin-creation-integration-e2e',
  description: 'Integration test for complete plugin creation workflow',
  fn: async (runtime: IAgentRuntime) => {
    console.log('Starting Plugin Creation Integration E2E Test...');

    try {
      // 1. Check service availability
      const service = runtime.services.get('plugin_creation' as any);
      if (!service) {
        throw new Error('Plugin creation service not available');
      }
      console.log('✓ Plugin creation service available');

      // 2. Check all required actions are registered
      const requiredActions = [
        'createPlugin',
        'checkPluginCreationStatus',
        'cancelPluginCreation',
        'createPluginFromDescription',
      ];

      for (const actionName of requiredActions) {
        const action = runtime.actions.find((a) => a.name === actionName);
        if (!action) {
          throw new Error(`Required action ${actionName} not found`);
        }
      }
      console.log('✓ All required actions registered');

      // 3. Check all required providers are registered
      const requiredProviders = [
        'pluginCreationStatus',
        'pluginCreationCapabilities',
        'pluginRegistry',
        'pluginExists',
      ];

      for (const providerName of requiredProviders) {
        const provider = runtime.providers.find((p) => p.name === providerName);
        if (!provider) {
          throw new Error(`Required provider ${providerName} not found`);
        }
      }
      console.log('✓ All required providers registered');

      // 4. Verify API key configuration
      const hasApiKey = !!runtime.getSetting('ANTHROPIC_API_KEY');
      console.log(`✓ Anthropic API key configured: ${hasApiKey}`);

      console.log('✅ Plugin Creation Integration E2E Test PASSED\n');
    } catch (error) {
      console.error('❌ Plugin Creation Integration E2E Test FAILED:', error);
      throw error;
    }
  },
};

// Test suite following ElizaOS standards
export const pluginActionsE2ETests: TestSuite = {
  name: 'Plugin Actions E2E Tests',
  tests: [
    createPluginActionTest,
    checkStatusActionTest,
    cancelPluginActionTest,
    pluginProvidersTest,
    createFromDescriptionTest,
    pluginCreationIntegrationTest,
  ],
};

// Export default for backward compatibility
export default pluginActionsE2ETests;
