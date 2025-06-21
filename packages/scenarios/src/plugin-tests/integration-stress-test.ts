import type { Scenario } from "../types.js";

/**
 * Integration Stress Test Scenario
 * 
 * This scenario tests the system under stress conditions with multiple concurrent operations:
 * - Multiple plugins being developed simultaneously
 * - Rapid context switching between different workflows
 * - Complex dependency chains and interactions
 * - System performance under load
 * - Error recovery and resilience
 */
export const integrationStressTestScenario: Scenario = {
  id: 'integration-stress-test',
  name: 'Integration Stress Test',
  description: 'Tests system performance and reliability under stress conditions with multiple concurrent operations',
  category: 'stress-test',
  tags: ['integration', 'stress', 'performance', 'concurrency', 'reliability', 'all-plugins'],

  actors: [
    {
      id: 'power-user',
      name: 'Power User',
      role: 'subject',
      personality: {
        traits: ['multitasking', 'demanding', 'impatient', 'thorough'],
        systemPrompt: 'You are a power user managing multiple plugin development projects simultaneously. You frequently switch contexts and expect fast, reliable responses.',
        interests: ['productivity', 'automation', 'complex workflows']
      },
      script: {
        steps: [
          // Rapid-fire plugin searches
          {
            type: 'message',
            content: 'I need to quickly search for plugins related to: OAuth, webhook handling, data transformation, email integration, and blockchain connectivity. Can you search for all of these at once?',
            description: 'Test rapid multiple plugin searches'
          },
          {
            type: 'wait',
            waitTime: 1000
          },
          // Immediate context switch to development
          {
            type: 'message',
            content: 'Actually, before you finish that search, I need to start developing a new social media analytics plugin. Can you kick off the Autocoder process while continuing the searches?',
            description: 'Test context switching during active operations'
          },
          {
            type: 'wait',
            waitTime: 2000
          },
          // Multiple secret configurations
          {
            type: 'message',
            content: 'I need to configure secrets for Twitter API, Facebook Graph API, Instagram Basic Display, LinkedIn API, and Reddit API all for the same plugin. Can we batch this process?',
            description: 'Test bulk secret configuration workflow'
          },
          {
            type: 'wait',
            waitTime: 1500
          },
          // Concurrent dependency management
          {
            type: 'message',
            content: 'While setting up those secrets, I also need to check dependencies for three existing plugins I\'m updating: my-weather-plugin, custom-ai-assistant, and data-sync-tool. Are there any conflicts?',
            description: 'Test concurrent dependency checking'
          },
          {
            type: 'wait',
            waitTime: 2000
          },
          // Rapid publishing pipeline
          {
            type: 'message',
            content: 'I have four plugins ready to publish: social-media-connector v2.1.0, data-processor v1.5.2, notification-hub v3.0.0, and analytics-dashboard v1.0.0. Can you validate and publish all of them?',
            description: 'Test bulk plugin publishing validation'
          },
          {
            type: 'wait',
            waitTime: 1500
          },
          // Complex troubleshooting scenario
          {
            type: 'message',
            content: 'Now I\'m getting authentication errors on the social media plugin, dependency conflicts on the data processor, and validation failures on the notification hub. I need help troubleshooting all of these issues simultaneously.',
            description: 'Test complex multi-issue troubleshooting'
          },
          {
            type: 'wait',
            waitTime: 3000
          },
          // System limits testing
          {
            type: 'message',
            content: 'Can the system handle if I start developing 5 new plugins simultaneously: real-time-chat, file-processor, api-gateway, monitoring-service, and security-scanner? What are the system limits?',
            description: 'Test system capacity and limits'
          },
          {
            type: 'wait',
            waitTime: 2000
          },
          // Recovery scenario
          {
            type: 'message',
            content: 'Something seems to have gone wrong with multiple processes. Can you give me a status report on all active operations and help me recover any failed tasks?',
            description: 'Test error recovery and status reporting'
          },
          {
            type: 'wait',
            waitTime: 3000
          }
        ],
        goals: [
          'Handle multiple concurrent plugin operations',
          'Maintain performance under stress',
          'Successfully context switch between different workflows',
          'Resolve complex multi-issue scenarios',
          'Provide clear status and recovery options'
        ]
      }
    }
  ],

  setup: {
    roomType: 'dm',
    roomName: 'Power User Development Environment',
    context: 'A high-performance environment for managing multiple concurrent plugin development operations',
    environment: {
      plugins: ['plugin-manager', 'plugin-autocoder', 'plugin-secrets-manager'],
      performanceMode: 'high',
      concurrencyLimit: 10,
      memoryLimit: '2GB',
      timeoutExtended: true
    }
  },

  execution: {
    maxDuration: 600000, // 10 minutes
    maxSteps: 30,
    timeout: 45000, // Extended timeout for stress conditions
    stopConditions: [
      {
        type: 'keyword',
        value: 'stress test complete',
        description: 'Stop when stress test is marked complete'
      }
    ]
  },

  verification: {
    rules: [
      {
        id: 'concurrent-operation-handling',
        type: 'llm',
        description: 'Verify that multiple concurrent operations are handled effectively',
        config: {
          successCriteria: 'System successfully managed multiple plugin searches, development tasks, and configurations simultaneously without significant degradation',
          priority: 'high',
          category: 'performance',
          expectedValue: 'Successful concurrent operation handling'
        }
      },
      {
        id: 'context-switching-capability',
        type: 'llm',
        description: 'Verify that rapid context switching between different workflows is handled smoothly',
        config: {
          successCriteria: 'Agent successfully switched between search, development, and configuration contexts without losing track of previous requests',
          priority: 'high',
          category: 'multitasking',
          expectedValue: 'Smooth context switching without task loss'
        }
      },
      {
        id: 'bulk-operation-efficiency',
        type: 'llm',
        description: 'Verify that bulk operations (secrets, publishing, validation) are handled efficiently',
        config: {
          successCriteria: 'System provided efficient batch processing for multiple secrets configuration and plugin publishing validation',
          priority: 'high',
          category: 'efficiency',
          expectedValue: 'Efficient bulk operation processing'
        }
      },
      {
        id: 'multi-issue-troubleshooting',
        type: 'llm',
        description: 'Verify that complex multi-issue troubleshooting scenarios are handled systematically',
        config: {
          successCriteria: 'Agent systematically addressed multiple simultaneous issues with clear prioritization and resolution strategies',
          priority: 'high',
          category: 'troubleshooting',
          expectedValue: 'Systematic multi-issue resolution'
        }
      },
      {
        id: 'system-limits-communication',
        type: 'llm',
        description: 'Verify that system limits and capacity constraints are clearly communicated',
        config: {
          successCriteria: 'Agent clearly communicated system capacity limits and provided guidance on optimal resource usage',
          priority: 'medium',
          category: 'communication',
          expectedValue: 'Clear system limits communication'
        }
      },
      {
        id: 'error-recovery-capability',
        type: 'llm',
        description: 'Verify that error recovery and status reporting work effectively under stress',
        config: {
          successCriteria: 'System provided clear status reports on all operations and offered effective recovery options for failed tasks',
          priority: 'high',
          category: 'reliability',
          expectedValue: 'Effective error recovery and status reporting'
        }
      },
      {
        id: 'performance-maintenance',
        type: 'llm',
        description: 'Verify that system maintains reasonable performance under stress conditions',
        config: {
          successCriteria: 'Response times remained reasonable and system remained responsive throughout high-stress operations',
          priority: 'high',
          category: 'performance',
          expectedValue: 'Maintained performance under stress'
        }
      }
    ]
  },

  benchmarks: {
    maxDuration: 600000,
    maxSteps: 30,
    maxTokens: 50000,
    maxMemoryUsage: 2048,
    targetAccuracy: 0.8, // Lower accuracy acceptable under stress
    customMetrics: [
      {
        name: 'concurrent_operations_success_rate',
        threshold: 0.8
      },
      {
        name: 'context_switching_success_rate',
        threshold: 0.85
      },
      {
        name: 'bulk_operation_efficiency',
        threshold: 0.75
      },
      {
        name: 'error_recovery_effectiveness',
        threshold: 0.9
      },
      {
        name: 'average_response_time_under_load',
        threshold: 45000 // 45 seconds max
      }
    ]
  },

  expectations: {
    messagePatterns: [
      {
        pattern: 'concurrent|simultaneous|batch|bulk',
        flags: 'i'
      },
      {
        pattern: 'switch|context|multiple|parallel',
        flags: 'i'
      },
      {
        pattern: 'status|progress|recovery|failed',
        flags: 'i'
      },
      {
        pattern: 'limit|capacity|performance|resource',
        flags: 'i'
      }
    ],
    responseTime: {
      max: 45000 // Extended for stress conditions
    },
    actionCalls: [
      'SEARCH_PLUGIN',
      'CREATE_PLUGIN_PROJECT',
      'MANAGE_SECRET',
      'REQUEST_SECRET_FORM',
      'CHECK_DEPENDENCIES',
      'PUBLISH_PLUGIN',
      'CHECK_PLUGIN_HEALTH',
      'GET_PLUGIN_STATE'
    ]
  }
};

export default integrationStressTestScenario;