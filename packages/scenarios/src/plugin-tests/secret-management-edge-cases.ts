import type { Scenario } from "../types.js";

/**
 * Secret Management Edge Cases Testing
 * 
 * This scenario tests edge cases in secret and configuration management:
 * - Invalid API key formats
 * - Missing required secrets
 * - Secret validation failures
 * - Complex multi-level secret dependencies
 * - Secret update and migration scenarios
 * - Permission and access control edge cases
 */
export const secretManagementEdgeCasesScenario: Scenario = {
  id: 'secret-management-edge-cases',
  name: 'Secret Management Edge Cases Test',
  description: 'Tests edge cases and error conditions in secret collection, validation, and management',
  category: 'edge-cases',
  tags: ['secrets', 'configuration', 'secrets-manager', 'validation', 'edge-cases'],

  actors: [
    {
      id: 'problematic-user',
      name: 'Problematic User',
      role: 'subject',
      personality: {
        traits: ['impatient', 'prone-to-errors', 'security-conscious-but-confused'],
        systemPrompt: 'You are a user who struggles with API keys and configuration. You often provide invalid formats, forget required information, and need help with security best practices.',
        interests: ['getting things working quickly', 'but concerned about security']
      },
      script: {
        steps: [
          // Test 1: Invalid API key format
          {
            type: 'message',
            content: 'I have an OpenAI API key: "abc123" - can you set this up for me?',
            description: 'Test validation of obviously invalid API key format'
          },
          {
            type: 'wait',
            waitTime: 3000
          },
          // Test 2: Missing required secrets
          {
            type: 'message',
            content: 'I want to use the Discord plugin but I only have a bot token, not sure what else I need',
            description: 'Test handling of partially provided secrets'
          },
          {
            type: 'wait',
            waitTime: 3000
          },
          // Test 3: Expired/revoked credentials
          {
            type: 'message',
            content: 'I set up my API keys yesterday but now I\'m getting 401 errors. The keys look right to me.',
            description: 'Test handling of expired or revoked credentials'
          },
          {
            type: 'wait',
            waitTime: 4000
          },
          // Test 4: Security concerns about sharing secrets
          {
            type: 'message',
            content: 'I have my API keys but I\'m worried about typing them here. Is this secure? What if someone sees them?',
            description: 'Test security guidance and secure secret collection'
          },
          {
            type: 'wait',
            waitTime: 3000
          },
          // Test 5: Complex secret dependencies
          {
            type: 'message',
            content: 'I need to set up OAuth for Google, but it requires client ID, client secret, redirect URI, and scopes. I\'m not sure how all these work together.',
            description: 'Test complex multi-part secret configuration'
          },
          {
            type: 'wait',
            waitTime: 4000
          },
          // Test 6: Secret format confusion
          {
            type: 'message',
            content: 'The API documentation says I need a "bearer token" but the form is asking for an "API key". Are these the same thing?',
            description: 'Test handling of secret format terminology confusion'
          },
          {
            type: 'wait',
            waitTime: 3000
          },
          // Test 7: Environment-specific secrets
          {
            type: 'message',
            content: 'I have different API keys for development and production. How do I manage both? And what about team members who need access?',
            description: 'Test multi-environment and team secret management'
          },
          {
            type: 'wait',
            waitTime: 4000
          }
        ],
        goals: [
          'Successfully validate and configure API keys',
          'Understand security best practices',
          'Set up complex multi-part configurations',
          'Manage environment-specific secrets'
        ]
      }
    }
  ],

  setup: {
    roomType: 'dm',
    roomName: 'Secret Configuration Session',
    context: 'A secure environment for configuring API keys and secrets with proper validation',
    environment: {
      plugins: ['plugin-secrets-manager', 'plugin-ngrok'],
      securityLevel: 'high',
      validationEnabled: true,
      formGeneration: true
    }
  },

  execution: {
    maxDuration: 360000, // 6 minutes
    maxSteps: 20,
    timeout: 30000,
    stopConditions: [
      {
        type: 'keyword',
        value: 'configuration complete',
        description: 'Stop when configuration is marked complete'
      }
    ]
  },

  verification: {
    rules: [
      {
        id: 'invalid-format-detection',
        type: 'llm',
        description: 'Verify that invalid API key formats are detected and rejected',
        config: {
          successCriteria: 'Agent identified invalid API key format and provided guidance on correct format requirements',
          priority: 'high',
          category: 'validation',
          expectedValue: 'Invalid formats detected and rejected with guidance'
        }
      },
      {
        id: 'missing-secrets-guidance',
        type: 'llm',
        description: 'Verify that missing required secrets are identified and user is guided to provide them',
        config: {
          successCriteria: 'Agent identified missing required secrets and provided clear guidance on what additional information is needed',
          priority: 'high',
          category: 'validation',
          expectedValue: 'Missing secrets identified with clear guidance'
        }
      },
      {
        id: 'credential-validation-troubleshooting',
        type: 'llm',
        description: 'Verify that credential validation failures are diagnosed and resolved',
        config: {
          successCriteria: 'Agent helped troubleshoot authentication failures and provided steps to resolve credential issues',
          priority: 'high',
          category: 'troubleshooting',
          expectedValue: 'Credential issues diagnosed and resolution provided'
        }
      },
      {
        id: 'security-guidance-provided',
        type: 'llm',
        description: 'Verify that appropriate security guidance is provided for secret sharing concerns',
        config: {
          successCriteria: 'Agent addressed security concerns, explained secure collection methods, and provided reassurance about safety measures',
          priority: 'high',
          category: 'security',
          expectedValue: 'Comprehensive security guidance provided'
        }
      },
      {
        id: 'complex-configuration-support',
        type: 'llm',
        description: 'Verify that complex multi-part secret configurations are handled properly',
        config: {
          successCriteria: 'Agent provided step-by-step guidance for complex OAuth setup and explained relationships between different secret components',
          priority: 'medium',
          category: 'configuration',
          expectedValue: 'Complex configurations explained and guided'
        }
      },
      {
        id: 'terminology-clarification',
        type: 'llm',
        description: 'Verify that secret terminology confusion is clarified',
        config: {
          successCriteria: 'Agent clarified differences between various secret types and provided clear explanations of terminology',
          priority: 'medium',
          category: 'education',
          expectedValue: 'Terminology clearly explained and confusion resolved'
        }
      },
      {
        id: 'multi-environment-guidance',
        type: 'llm',
        description: 'Verify that multi-environment and team secret management is addressed',
        config: {
          successCriteria: 'Agent provided guidance on managing secrets across environments and team access patterns',
          priority: 'medium',
          category: 'advanced',
          expectedValue: 'Multi-environment management guidance provided'
        }
      },
      {
        id: 'secure-form-generation',
        type: 'llm',
        description: 'Verify that secure forms are generated when appropriate',
        config: {
          successCriteria: 'Agent offered or generated secure web forms for sensitive secret collection when security concerns were raised',
          priority: 'high',
          category: 'security',
          expectedValue: 'Secure forms offered for sensitive data collection'
        }
      }
    ]
  },

  benchmarks: {
    maxDuration: 360000,
    maxSteps: 20,
    targetAccuracy: 0.85,
    customMetrics: [
      {
        name: 'validation_accuracy',
        threshold: 0.9
      },
      {
        name: 'security_guidance_quality',
        threshold: 0.85
      },
      {
        name: 'configuration_success_rate',
        threshold: 0.8
      }
    ]
  },

  expectations: {
    messagePatterns: [
      {
        pattern: 'invalid|incorrect format|not valid',
        flags: 'i'
      },
      {
        pattern: 'missing|required|need.*also',
        flags: 'i'
      },
      {
        pattern: 'secure|encrypted|safe|privacy',
        flags: 'i'
      },
      {
        pattern: 'step.*by.*step|guide|help.*setup',
        flags: 'i'
      }
    ],
    responseTime: {
      max: 30000
    },
    actionCalls: [
      'MANAGE_SECRET',
      'REQUEST_SECRET_FORM',
      'GENERATE_ENV_VAR',
      'SET_ENV_VAR'
    ]
  }
};

export default secretManagementEdgeCasesScenario;