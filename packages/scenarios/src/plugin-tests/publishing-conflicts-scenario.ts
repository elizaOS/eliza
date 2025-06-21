import type { Scenario } from "../types.js";

/**
 * Publishing Conflicts and Edge Cases Testing
 * 
 * This scenario tests edge cases in the plugin publishing and distribution phase:
 * - Name conflicts with existing plugins
 * - Version conflicts and dependency issues
 * - Registry authentication and permission problems
 * - Plugin validation failures
 * - Rollback and recovery scenarios
 * - Registry sync and distribution edge cases
 */
export const publishingConflictsScenario: Scenario = {
  id: 'publishing-conflicts-scenario',
  name: 'Publishing Conflicts and Edge Cases Test',
  description: 'Tests edge cases and conflict resolution in plugin publishing and distribution',
  category: 'edge-cases',
  tags: ['publishing', 'conflicts', 'plugin-manager', 'registry', 'validation', 'edge-cases'],

  actors: [
    {
      id: 'aspiring-publisher',
      name: 'Aspiring Publisher',
      role: 'subject',
      personality: {
        traits: ['eager', 'somewhat-inexperienced', 'persistent'],
        systemPrompt: 'You are a developer ready to publish your first plugin but you encounter various obstacles and conflicts during the publishing process.',
        interests: ['sharing work with community', 'learning from mistakes']
      },
      script: {
        steps: [
          // Test 1: Name conflict
          {
            type: 'message',
            content: 'I want to publish my weather plugin as "weather-plugin". Can you help me get it on the registry?',
            description: 'Test handling of common/conflicting plugin name'
          },
          {
            type: 'wait',
            waitTime: 3000
          },
          // Test 2: Version format issues
          {
            type: 'message',
            content: 'I set the version to "v1.0-beta-final" in my package.json. Is that the right format for publishing?',
            description: 'Test validation of incorrect version format'
          },
          {
            type: 'wait',
            waitTime: 3000
          },
          // Test 3: Missing required metadata
          {
            type: 'message',
            content: 'The publishing process says I\'m missing some required fields. My package.json just has name, version, and main. What else do I need?',
            description: 'Test handling of incomplete package metadata'
          },
          {
            type: 'wait',
            waitTime: 4000
          },
          // Test 4: Dependency conflicts
          {
            type: 'message',
            content: 'My plugin depends on a specific version of axios (0.25.0) but the registry is saying there are compatibility issues. How do I fix this?',
            description: 'Test dependency compatibility validation'
          },
          {
            type: 'wait',
            waitTime: 4000
          },
          // Test 5: Authentication issues
          {
            type: 'message',
            content: 'I\'m getting an authentication error when trying to publish. I think I have an NPM token but I\'m not sure if it\'s set up correctly.',
            description: 'Test registry authentication troubleshooting'
          },
          {
            type: 'wait',
            waitTime: 3000
          },
          // Test 6: Plugin validation failures
          {
            type: 'message',
            content: 'The validation is failing because it says my plugin doesn\'t export the right interface. But it works fine when I test it locally!',
            description: 'Test plugin interface validation failures'
          },
          {
            type: 'wait',
            waitTime: 4000
          },
          // Test 7: Registry sync issues
          {
            type: 'message',
            content: 'I published successfully to NPM but the ElizaOS registry doesn\'t show my plugin yet. How long does it take to sync?',
            description: 'Test registry synchronization and timing issues'
          },
          {
            type: 'wait',
            waitTime: 3000
          },
          // Test 8: Rollback scenario
          {
            type: 'message',
            content: 'I just realized I published a version with a critical bug. Can I unpublish it or roll back to the previous version?',
            description: 'Test rollback and version management scenarios'
          },
          {
            type: 'wait',
            waitTime: 4000
          }
        ],
        goals: [
          'Successfully resolve name conflicts',
          'Fix version and metadata issues',
          'Resolve authentication problems',
          'Pass plugin validation',
          'Understand registry sync process',
          'Learn rollback procedures'
        ]
      }
    }
  ],

  setup: {
    roomType: 'dm',
    roomName: 'Plugin Publishing Support',
    context: 'A support environment for resolving plugin publishing issues and conflicts',
    environment: {
      plugins: ['plugin-manager', 'plugin-autocoder'],
      registryAccess: true,
      validationEnabled: true,
      npmIntegration: true
    }
  },

  execution: {
    maxDuration: 420000, // 7 minutes
    maxSteps: 25,
    timeout: 35000,
    stopConditions: [
      {
        type: 'keyword',
        value: 'publishing resolved',
        description: 'Stop when publishing issues are resolved'
      }
    ]
  },

  verification: {
    rules: [
      {
        id: 'name-conflict-resolution',
        type: 'llm',
        description: 'Verify that name conflicts are identified and alternative names are suggested',
        config: {
          successCriteria: 'Agent identified the name conflict, checked for existing plugins with similar names, and suggested alternative naming strategies',
          priority: 'high',
          category: 'conflict-resolution',
          expectedValue: 'Name conflicts resolved with alternative suggestions'
        }
      },
      {
        id: 'version-format-validation',
        type: 'llm',
        description: 'Verify that version format issues are detected and corrected',
        config: {
          successCriteria: 'Agent identified invalid version format and provided guidance on proper semantic versioning',
          priority: 'high',
          category: 'validation',
          expectedValue: 'Version format corrected with proper guidance'
        }
      },
      {
        id: 'metadata-completion-guidance',
        type: 'llm',
        description: 'Verify that missing metadata requirements are identified and guidance is provided',
        config: {
          successCriteria: 'Agent identified missing required fields and provided complete list of necessary package.json metadata',
          priority: 'high',
          category: 'validation',
          expectedValue: 'Complete metadata requirements provided'
        }
      },
      {
        id: 'dependency-conflict-resolution',
        type: 'llm',
        description: 'Verify that dependency conflicts are diagnosed and resolution strategies provided',
        config: {
          successCriteria: 'Agent analyzed dependency conflicts and provided strategies for resolution including version updates or alternatives',
          priority: 'high',
          category: 'dependency-management',
          expectedValue: 'Dependency conflicts resolved with clear strategies'
        }
      },
      {
        id: 'authentication-troubleshooting',
        type: 'llm',
        description: 'Verify that authentication issues are diagnosed and resolved',
        config: {
          successCriteria: 'Agent helped troubleshoot authentication problems and provided steps to verify and configure proper credentials',
          priority: 'high',
          category: 'authentication',
          expectedValue: 'Authentication issues diagnosed and resolved'
        }
      },
      {
        id: 'validation-failure-diagnosis',
        type: 'llm',
        description: 'Verify that plugin validation failures are properly diagnosed',
        config: {
          successCriteria: 'Agent identified specific validation issues and provided guidance on fixing plugin interface and export problems',
          priority: 'high',
          category: 'validation',
          expectedValue: 'Validation failures diagnosed with specific fixes'
        }
      },
      {
        id: 'registry-sync-explanation',
        type: 'llm',
        description: 'Verify that registry synchronization processes are explained',
        config: {
          successCriteria: 'Agent explained registry sync timing, provided ways to check status, and offered troubleshooting for sync delays',
          priority: 'medium',
          category: 'registry',
          expectedValue: 'Registry sync process clearly explained'
        }
      },
      {
        id: 'rollback-guidance',
        type: 'llm',
        description: 'Verify that rollback and version management guidance is provided',
        config: {
          successCriteria: 'Agent provided guidance on version rollback options, deprecation strategies, and proper version management practices',
          priority: 'medium',
          category: 'version-management',
          expectedValue: 'Comprehensive rollback and version management guidance'
        }
      }
    ]
  },

  benchmarks: {
    maxDuration: 420000,
    maxSteps: 25,
    targetAccuracy: 0.85,
    customMetrics: [
      {
        name: 'conflict_resolution_rate',
        threshold: 0.9
      },
      {
        name: 'validation_guidance_quality',
        threshold: 0.85
      },
      {
        name: 'troubleshooting_effectiveness',
        threshold: 0.8
      }
    ]
  },

  expectations: {
    messagePatterns: [
      {
        pattern: 'conflict|already.*exist|name.*taken',
        flags: 'i'
      },
      {
        pattern: 'version|semantic|semver|format',
        flags: 'i'
      },
      {
        pattern: 'missing|required.*field|metadata',
        flags: 'i'
      },
      {
        pattern: 'dependency|compatibility|conflict',
        flags: 'i'
      },
      {
        pattern: 'authentication|token|credential',
        flags: 'i'
      },
      {
        pattern: 'validation|interface|export',
        flags: 'i'
      },
      {
        pattern: 'sync|registry|delay|timing',
        flags: 'i'
      },
      {
        pattern: 'rollback|unpublish|previous.*version',
        flags: 'i'
      }
    ],
    responseTime: {
      max: 35000
    },
    actionCalls: [
      'SEARCH_PLUGIN',
      'VIEW_PLUGIN_DETAILS',
      'PUBLISH_PLUGIN',
      'CHECK_DEPENDENCIES',
      'UPDATE_PLUGIN'
    ]
  }
};

export default publishingConflictsScenario;