import type { Scenario } from "../types.js";

/**
 * Comprehensive UX Workflow Test Scenario
 * 
 * This scenario tests the complete plugin development workflow from discovery to publishing,
 * covering all four phases and critical UX edge cases identified in the analysis:
 * 
 * Phase 1: Discovery & Planning
 * - Search for existing similar plugins
 * - Handle ambiguous search results
 * - Deal with partial matches and suggestions
 * 
 * Phase 2: Development & Implementation
 * - Create new plugin project with Autocoder
 * - Handle API changes and iterations
 * - Manage development dependencies
 * 
 * Phase 3: Secret & Configuration Management
 * - Collect required secrets from users
 * - Validate secret formats and functionality
 * - Handle missing or invalid configurations
 * 
 * Phase 4: Publishing & Distribution
 * - Validate plugin before publishing
 * - Handle naming conflicts
 * - Manage registry integration
 */
export const comprehensiveUXWorkflowScenario: Scenario = {
  id: 'comprehensive-ux-workflow',
  name: 'Comprehensive UX Workflow Test',
  description: 'Tests the complete plugin development workflow covering all phases and edge cases',
  category: 'integration',
  tags: ['ux', 'workflow', 'plugin-manager', 'autocoder', 'secrets-manager', 'comprehensive'],

  actors: [
    {
      id: 'developer',
      name: 'Plugin Developer',
      role: 'subject',
      personality: {
        traits: ['curious', 'detail-oriented', 'persistent'],
        systemPrompt: 'You are a developer who wants to create a new plugin for ElizaOS. You will go through the complete workflow from discovery to publishing.',
        interests: ['plugin development', 'automation', 'integration']
      },
      script: {
        steps: [
          // Phase 1: Discovery & Planning - Test search ambiguity
          {
            type: 'message',
            content: 'I want to create a plugin for weather data integration. Can you help me search for existing weather plugins first?',
            description: 'Initiate discovery phase with ambiguous search'
          },
          {
            type: 'wait',
            waitTime: 2000
          },
          {
            type: 'message',
            content: 'The search results show several weather-related plugins. Can you help me understand the differences and see if any meet my specific needs for real-time weather alerts?',
            description: 'Test disambiguation and specific requirements matching'
          },
          {
            type: 'wait',
            waitTime: 3000
          },
          // Phase 2: Development - Test Autocoder integration
          {
            type: 'message',
            content: 'None of the existing plugins meet my needs. I want to create a new weather alerts plugin that integrates with multiple weather APIs and sends notifications. Can you help me start the development?',
            description: 'Initiate Autocoder plugin development'
          },
          {
            type: 'wait',
            waitTime: 5000
          },
          // Phase 3: Secret Management - Test complex secret collection
          {
            type: 'message',
            content: 'The plugin needs API keys for OpenWeatherMap, WeatherAPI, and notification settings. Can you help me set up the required secrets and configurations?',
            description: 'Test multi-API secret collection workflow'
          },
          {
            type: 'wait',
            waitTime: 4000
          },
          {
            type: 'message',
            content: 'I have the API keys but I\'m not sure about the correct format for the notification webhook URL. Can you validate these settings?',
            description: 'Test secret validation and format checking'
          },
          {
            type: 'wait',
            waitTime: 3000
          },
          // Phase 4: Publishing - Test conflict resolution
          {
            type: 'message',
            content: 'The plugin is working great! I want to publish it to the ElizaOS registry as "weather-alerts-plugin". Can you help me with the publishing process?',
            description: 'Initiate publishing workflow'
          },
          {
            type: 'wait',
            waitTime: 5000
          }
        ],
        goals: [
          'Successfully discover existing plugins',
          'Create a new plugin with proper specifications',
          'Configure all required secrets and settings',
          'Publish plugin to registry successfully'
        ]
      }
    }
  ],

  setup: {
    roomType: 'dm',
    roomName: 'Plugin Development Workspace',
    context: 'A developer workspace for creating and managing ElizaOS plugins',
    environment: {
      plugins: ['plugin-manager', 'plugin-autocoder', 'plugin-secrets-manager'],
      trustLevel: 'high',
      registryAccess: true
    }
  },

  execution: {
    maxDuration: 300000, // 5 minutes
    maxSteps: 20,
    timeout: 30000,
    stopConditions: [
      {
        type: 'keyword',
        value: 'workflow complete',
        description: 'Stop when workflow is marked complete'
      }
    ]
  },

  verification: {
    rules: [
      {
        id: 'discovery-phase-completion',
        type: 'llm',
        description: 'Verify that plugin discovery phase completed with search results and analysis',
        config: {
          successCriteria: 'The agent successfully searched for existing plugins, provided analysis of search results, and helped determine if existing solutions meet the user needs',
          priority: 'high',
          category: 'workflow',
          expectedValue: 'Discovery phase completed with search and analysis'
        }
      },
      {
        id: 'development-phase-initiation',
        type: 'llm',
        description: 'Verify that plugin development was initiated using Autocoder',
        config: {
          successCriteria: 'The agent initiated plugin development using Autocoder service, created project structure, and began implementation',
          priority: 'high',
          category: 'workflow',
          expectedValue: 'Development phase initiated with Autocoder'
        }
      },
      {
        id: 'secret-management-workflow',
        type: 'llm',
        description: 'Verify that secret collection and validation workflow was executed',
        config: {
          successCriteria: 'The agent collected required API keys and configurations, provided validation guidance, and helped resolve format issues',
          priority: 'high',
          category: 'workflow',
          expectedValue: 'Secret management completed successfully'
        }
      },
      {
        id: 'publishing-process-initiated',
        type: 'llm',
        description: 'Verify that publishing process was started with proper validation',
        config: {
          successCriteria: 'The agent initiated the publishing process, performed validation checks, and guided through registry submission',
          priority: 'high',
          category: 'workflow',
          expectedValue: 'Publishing process initiated successfully'
        }
      },
      {
        id: 'integration-coherence',
        type: 'llm',
        description: 'Verify that all three plugins worked together coherently throughout the workflow',
        config: {
          successCriteria: 'Plugin Manager, Autocoder, and Secrets Manager integrated seamlessly with proper handoffs between phases',
          priority: 'high',
          category: 'integration',
          expectedValue: 'Seamless integration between all plugin services'
        }
      },
      {
        id: 'ux-guidance-quality',
        type: 'llm',
        description: 'Verify that UX guidance was provided for ambiguous situations and edge cases',
        config: {
          successCriteria: 'Agent provided clear guidance for ambiguous search results, API format questions, and potential conflicts',
          priority: 'medium',
          category: 'ux',
          expectedValue: 'High-quality UX guidance throughout workflow'
        }
      }
    ]
  },

  benchmarks: {
    maxDuration: 300000,
    maxSteps: 20,
    targetAccuracy: 0.85,
    customMetrics: [
      {
        name: 'workflow_completion_rate',
        threshold: 0.9
      },
      {
        name: 'integration_success_rate',
        threshold: 0.85
      },
      {
        name: 'ux_guidance_quality',
        threshold: 0.8
      }
    ]
  },

  expectations: {
    messagePatterns: [
      {
        pattern: 'search.*weather.*plugin',
        flags: 'i'
      },
      {
        pattern: 'autocoder|development|create.*plugin',
        flags: 'i'
      },
      {
        pattern: 'secret|api.*key|configuration',
        flags: 'i'
      },
      {
        pattern: 'publish|registry|distribution',
        flags: 'i'
      }
    ],
    responseTime: {
      max: 30000
    },
    actionCalls: [
      'SEARCH_PLUGIN',
      'CREATE_PLUGIN_PROJECT',
      'MANAGE_SECRET',
      'REQUEST_SECRET_FORM',
      'PUBLISH_PLUGIN'
    ]
  }
};

export default comprehensiveUXWorkflowScenario;