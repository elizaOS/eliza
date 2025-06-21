import { type Scenario } from '@elizaos/cli';

/**
 * Scenario to test the actual TrustMiddleware functionality
 * This tests the REAL trust system, not custom implementations
 */
export const trustMiddlewareValidationScenario: Scenario = {
  id: 'trust-middleware-validation',
  name: 'Trust Middleware Validation',
  description: 'Test that TrustMiddleware properly wraps actions and enforces trust requirements',
  tags: ['trust', 'middleware', 'validation', 'core'],
  
  setup: {
    plugins: ['@elizaos/plugin-trust', '@elizaos/plugin-shell'],
    environment: {
      NODE_ENV: 'test'
    }
  },

  actors: [
    {
      id: 'new-user',
      name: 'New User',
      trustScore: 0, // No trust history
      roles: []
    },
    {
      id: 'established-user',
      name: 'Established User', 
      trustScore: 50, // Medium trust
      roles: ['USER_ROLE']
    },
    {
      id: 'high-trust-user',
      name: 'High Trust User',
      trustScore: 85, // High trust
      roles: ['USER_ROLE', 'ADMIN_ROLE']
    },
    {
      id: 'agent',
      name: 'Agent',
      type: 'agent'
    }
  ],

  interactions: [
    // Test 1: Check trust requirements are properly set
    {
      actor: 'agent',
      action: 'internal_check',
      description: 'Verify trust requirements are loaded',
      check: async (runtime) => {
        // Import trust requirements
        const { getTrustRequirement } = await import('@elizaos/plugin-trust');
        
        // Check that shell commands have appropriate trust requirements
        const shellTrust = getTrustRequirement('SHELL_COMMAND');
        return shellTrust > 0; // Should have some trust requirement
      }
    },

    // Test 2: New user attempts high-trust action (should fail)
    {
      actor: 'new-user',
      action: 'send_message',
      content: {
        text: 'Run shell command: ls -la'
      },
      expectedResponse: {
        shouldContain: ['insufficient trust', 'trust score'],
        shouldNotContain: ['total', 'drwx'] // Shouldn't see directory listing
      },
      timeout: 5000
    },

    // Test 3: Build trust gradually with helpful actions
    {
      actor: 'new-user',
      action: 'send_message',
      content: {
        text: 'Hello! Can you help me understand how this system works?'
      },
      expectedResponse: {
        shouldNotContain: ['Access denied', 'insufficient trust']
      },
      timeout: 5000
    },

    // Test 4: Check trust increased after positive interaction
    {
      actor: 'agent', 
      action: 'get_trust_profile',
      target: 'new-user',
      expectedResponse: {
        trustScore: { greaterThan: 0 } // Should have gained some trust
      }
    },

    // Test 5: High-trust user should be able to execute shell commands
    {
      actor: 'high-trust-user',
      action: 'send_message',
      content: {
        text: 'Run command: echo "trust test successful"'
      },
      expectedResponse: {
        shouldContain: ['trust test successful'],
        shouldNotContain: ['Access denied', 'insufficient trust']
      },
      timeout: 10000
    },

    // Test 6: Verify trust middleware records successful actions
    {
      actor: 'agent',
      action: 'get_trust_profile', 
      target: 'high-trust-user',
      expectedResponse: {
        interactions: { greaterThan: 0 },
        // Trust should remain high or increase
        trustScore: { greaterThanOrEqual: 85 }
      }
    },

    // Test 7: Test permission elevation request
    {
      actor: 'established-user',
      action: 'send_message',
      content: {
        text: 'I need elevated permissions to run system commands'
      },
      expectedResponse: {
        shouldContain: ['elevation', 'permission', 'trust'],
        shouldNotContain: ['Access denied'] // Should get info about elevation
      },
      timeout: 5000
    }
  ],

  validation: {
    checks: [
      {
        name: 'trust_middleware_active',
        description: 'TrustMiddleware should be wrapping actions',
        check: async (runtime) => {
          // Check if actions have trust validation
          const shellAction = runtime.actions.find(a => a.name.includes('SHELL'));
          if (!shellAction) return false;
          
          // The wrapped action should have enhanced validation
          const validateResult = await shellAction.validate(runtime, {
            entityId: 'test-user',
            roomId: 'test-room',
            content: { text: 'test command' }
          } as any);
          
          // For a test user with no trust, validation should fail
          return validateResult === false;
        }
      },
      {
        name: 'trust_scores_persisted',
        description: 'Trust scores should be saved to database',
        check: async (runtime) => {
          const trustService = runtime.getService('trust-engine');
          if (!trustService) return false;
          
          try {
            // Try to get trust profile (should work even if score is 0)
            const profile = await (trustService as any).trustEngine.calculateTrust('new-user', {
              evaluatorId: runtime.agentId
            });
            return typeof profile.overallTrust === 'number';
          } catch {
            return false;
          }
        }
      },
      {
        name: 'security_violations_tracked',
        description: 'Security violations should be tracked',
        check: async (runtime) => {
          const trustService = runtime.getService('trust-engine');
          if (!trustService) return false;
          
          try {
            // Check that violations are being tracked
            const interactions = await (trustService as any).trustEngine.getRecentInteractions('new-user');
            return Array.isArray(interactions);
          } catch {
            return false;
          }
        }
      }
    ]
  },

  metrics: {
    successCriteria: [
      'Trust middleware properly blocks unauthorized actions',
      'Trust scores are calculated and persisted correctly',
      'Positive interactions increase trust scores', 
      'Security violations are properly recorded',
      'High-trust users can execute privileged actions'
    ],
    performance: {
      maxResponseTime: 3000,
      minSuccessRate: 100
    }
  }
};

export default trustMiddlewareValidationScenario;