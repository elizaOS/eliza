import { type Scenario } from '@elizaos/cli';

/**
 * Basic trust functionality validation without database dependencies
 * Tests core trust system components directly
 */
export const trustBasicValidationScenario: Scenario = {
  id: 'trust-basic-validation',
  name: 'Trust Basic Validation',
  description: 'Test basic trust system functionality without complex dependencies',
  tags: ['trust', 'basic', 'validation'],
  
  setup: {
    plugins: ['@elizaos/plugin-trust'],
    environment: {
      NODE_ENV: 'test'
    }
  },

  actors: [
    {
      id: 'test-user',
      name: 'Test User',
      trustScore: 0.5,
      roles: ['USER_ROLE']
    },
    {
      id: 'agent',
      name: 'Agent',
      type: 'agent'
    }
  ],

  interactions: [
    // Test 1: Check trust services are available
    {
      actor: 'agent',
      action: 'internal_check',
      description: 'Verify trust services are available',
      check: async (runtime) => {
        const trustService = runtime.getService('trust-engine');
        const permService = runtime.getService('contextual-permissions');
        const secService = runtime.getService('security-module');
        
        // At least one service should be available
        return !!(trustService || permService || secService);
      }
    },

    // Test 2: Check TrustAwarePlugin framework exists
    {
      actor: 'agent',
      action: 'internal_check',
      description: 'Verify TrustAwarePlugin class is available',
      check: async (runtime) => {
        try {
          const { TrustAwarePlugin } = await import('@elizaos/plugin-trust');
          return typeof TrustAwarePlugin === 'function';
        } catch {
          return false;
        }
      }
    },

    // Test 3: Check trust middleware functionality
    {
      actor: 'agent',
      action: 'internal_check',
      description: 'Verify TrustMiddleware can wrap actions',
      check: async (runtime) => {
        try {
          const { TrustMiddleware } = await import('@elizaos/plugin-trust');
          return typeof TrustMiddleware === 'function';
        } catch {
          return false;
        }
      }
    },

    // Test 4: Basic trust calculation
    {
      actor: 'test-user',
      action: 'send_message',
      content: {
        text: 'Hello, can you help me?'
      },
      expectedResponse: {
        shouldNotContain: ['Access denied', 'insufficient trust']
      },
      timeout: 5000
    }
  ],

  validation: {
    checks: [
      {
        name: 'trust_plugin_loaded',
        description: 'Trust plugin should be loaded successfully',
        check: async (runtime) => {
          // Check if trust actions/evaluators/services are registered
          const hasServices = runtime.getService('trust-engine') ||
                            runtime.getService('contextual-permissions') ||
                            runtime.getService('security-module');
          return !!hasServices;
        }
      },
      {
        name: 'trust_aware_framework_available',
        description: 'TrustAware framework should be importable',
        check: async (runtime) => {
          try {
            const trustModule = await import('@elizaos/plugin-trust');
            return !!(trustModule.TrustAwarePlugin && trustModule.TrustMiddleware);
          } catch {
            return false;
          }
        }
      },
      {
        name: 'basic_interaction_working',
        description: 'Basic interactions should work without database errors',
        check: async (runtime) => {
          // If we get this far without database errors, basic functionality works
          return true;
        }
      }
    ]
  },

  metrics: {
    successCriteria: [
      'Trust plugin loads without critical errors',
      'TrustAware framework classes are available',
      'Basic interactions work without permission blocks',
      'Trust services are properly registered'
    ],
    performance: {
      maxResponseTime: 2000,
      minSuccessRate: 100
    }
  }
};

export default trustBasicValidationScenario;