import type { Scenario } from "../types.js";

export const pluginDevelopmentWorkflowScenario: Scenario = {
  id: '8c5d2a3f-9e1b-4c6d-8f7a-2b4c6e8d0f1a',
  name: 'Complete Plugin Development Workflow',
  description:
    'Test the full integration between plugin manager, autocoder, and secrets manager for discovering, creating, and publishing plugins',
  category: 'integration',
  tags: ['plugin-manager', 'autocoder', 'secrets-manager', 'end-to-end', 'publishing'],

  actors: [
    {
      id: '1a2b3c4d-5e6f-7a8b-9c0d-1e2f3a4b5c6d',
      name: 'Plugin Development Agent',
      role: 'subject',
      bio: 'An AI-powered plugin development assistant',
      system: `You are a sophisticated plugin development assistant that integrates three core services:
1. Plugin Manager - for discovering, searching, and publishing plugins
2. Autocoder - for AI-powered plugin generation and development
3. Secrets Manager - for secure API key collection and management

Your workflow should be:
1. Search existing plugins before creating new ones
2. Collect required secrets securely when needed
3. Generate high-quality plugins with proper testing
4. Publish successfully to the plugin registry

Always explain your decision-making process and provide clear status updates.`,
      plugins: [
        '@elizaos/plugin-plugin-manager',
        '@elizaos/plugin-autocoder', 
        '@elizaos/plugin-secrets-manager',
        '@elizaos/plugin-ngrok'
      ],
      script: { steps: [] },
    },
    {
      id: '2b3c4d5e-6f7a-8b9c-0d1e-2f3a4b5c6d7e',
      name: 'Plugin Developer',
      role: 'assistant',
      script: {
        steps: [
          {
            type: 'message',
            content: 'I need a plugin that can fetch weather data from OpenWeatherMap API and provide current conditions for any city. Can you help me create this?',
          },
          {
            type: 'wait',
            waitTime: 8000,
          },
          {
            type: 'message',
            content: 'Great! I have an OpenWeatherMap API key: "test-api-key-12345". How do I provide this securely?',
          },
          {
            type: 'wait',
            waitTime: 10000,
          },
          {
            type: 'message',
            content: 'Perfect! Now please proceed with creating the weather plugin. Make sure it includes proper error handling and testing.',
          },
          {
            type: 'wait',
            waitTime: 30000,
          },
          {
            type: 'message',
            content: 'Can you show me the status of the plugin development? I want to make sure everything is working correctly.',
          },
          {
            type: 'wait',
            waitTime: 5000,
          },
          {
            type: 'message',
            content: 'Excellent! Once the plugin is complete and tested, please publish it to the plugin registry.',
          },
          {
            type: 'wait',
            waitTime: 15000,
          },
          {
            type: 'message',
            content: 'Finally, can you search the registry to confirm our new weather plugin is available for others to use?',
          },
        ],
        personality: 'methodical, quality-focused, security-conscious',
        goals: [
          'create a high-quality weather plugin',
          'ensure secure secret management',
          'publish plugin for community use',
          'verify successful publication',
        ],
      },
    },
  ],

  setup: {
    roomType: 'dm',
    roomName: 'Plugin Development Session',
    context: 'AI-powered plugin development with integrated security and publishing',
    environment: {
      plugins: [
        '@elizaos/plugin-plugin-manager',
        '@elizaos/plugin-autocoder', 
        '@elizaos/plugin-secrets-manager',
        '@elizaos/plugin-ngrok'
      ],
      apiMocking: true,
      testMode: true,
    },
  },

  execution: {
    maxDuration: 300000, // 5 minutes
    maxSteps: 35,
    stopConditions: [
      {
        type: 'message_count',
        value: 12,
        description: 'Stop after conversation completes',
      },
    ],
  },

  verification: {
    rules: [
      {
        id: '1a2b3c4d-5e6f-7a8b-9c0d-1e2f3a4b5c6d',
        type: 'llm' as const,
        description: 'Plugin discovery search was performed',
        config: {
          expectedValue: 'SEARCH_PLUGINS',
          criteria: 'Agent should search existing plugins before creating new ones to avoid duplication',
        },
        weight: 4,
      },
      {
        id: '2b3c4d5e-6f7a-8b9c-0d1e-2f3a4b5c6d7e',
        type: 'llm' as const,
        description: 'Plugin recommendation analysis',
        config: {
          criteria: 'Agent should analyze search results and recommend whether to extend existing plugin or create new one',
        },
        weight: 3,
      },
      {
        id: '3c4d5e6f-7a8b-9c0d-1e2f-3a4b5c6d7e8f',
        type: 'llm' as const,
        description: 'Secure secret collection',
        config: {
          expectedValue: 'requestSecretForm',
          criteria: 'Agent should use secrets manager to securely collect the OpenWeatherMap API key',
        },
        weight: 4,
      },
      {
        id: '4d5e6f7a-8b9c-0d1e-2f3a-4b5c6d7e8f9a',
        type: 'llm' as const,
        description: 'Plugin creation initiated',
        config: {
          expectedValue: 'createPluginProject',
          criteria: 'Agent should start plugin development using autocoder service',
        },
        weight: 4,
      },
      {
        id: '5e6f7a8b-9c0d-1e2f-3a4b-5c6d7e8f9a0b',
        type: 'llm' as const,
        description: 'Development status monitoring',
        config: {
          expectedValue: 'checkProjectStatus',
          criteria: 'Agent should provide status updates on plugin development progress',
        },
        weight: 3,
      },
      {
        id: '6f7a8b9c-0d1e-2f3a-4b5c-6d7e8f9a0b1c',
        type: 'llm' as const,
        description: 'Plugin testing verification',
        config: {
          criteria: 'Agent should verify that plugin passes all tests before publishing',
        },
        weight: 3,
      },
      {
        id: '7a8b9c0d-1e2f-3a4b-5c6d-7e8f9a0b1c2d',
        type: 'llm' as const,
        description: 'Plugin publishing',
        config: {
          expectedValue: 'publishPlugin',
          criteria: 'Agent should publish the completed plugin to the registry',
        },
        weight: 4,
      },
      {
        id: '8b9c0d1e-2f3a-4b5c-6d7e-8f9a0b1c2d3e',
        type: 'llm' as const,
        description: 'Registry verification',
        config: {
          criteria: 'Agent should verify plugin availability in registry after publishing',
        },
        weight: 3,
      },
      {
        id: '9c0d1e2f-3a4b-5c6d-7e8f-9a0b1c2d3e4f',
        type: 'llm' as const,
        description: 'Complete workflow integration',
        config: {
          criteria: 'All three services (plugin manager, autocoder, secrets manager) should work together seamlessly',
        },
        weight: 5,
      },
    ],
    expectedOutcomes: [
      {
        actorId: '1a2b3c4d-5e6f-7a8b-9c0d-1e2f3a4b5c6d',
        outcome: 'Successfully created and published weather plugin using integrated workflow',
        verification: {
          id: 'a0b1c2d3-4e5f-6a7b-8c9d-0e1f2a3b4c5d',
          type: 'llm' as const,
          description: 'End-to-end workflow completed successfully',
          config: {
            criteria: 'Plugin was discovered, created, tested, and published through integrated services',
          },
        },
      },
    ],
    groundTruth: {
      expectedBehavior: 'Seamless integration between plugin discovery, creation, secret management, and publishing',
      successCriteria: [
        'Searched existing plugins before creation',
        'Securely collected API credentials',
        'Generated functional weather plugin',
        'Passed all development tests',
        'Successfully published to registry',
        'Verified registry availability',
        'Maintained security throughout process',
      ],
    },
  },

  benchmarks: {
    maxDuration: 300000,
    maxSteps: 35,
    maxTokens: 15000,
    targetAccuracy: 0.90,
    customMetrics: [
      { name: 'plugin_discovery_accuracy' },
      { name: 'secret_collection_security' },
      { name: 'code_generation_quality' },
      { name: 'publishing_success_rate' },
      { name: 'end_to_end_completion_time' },
    ],
  },
};

export default pluginDevelopmentWorkflowScenario;