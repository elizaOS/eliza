import type { Scenario } from "../types.js";

export const pluginWorkflowEdgeCasesScenario: Scenario = {
  id: '9d6e3b2f-1c4a-5e8b-7f9c-3a5d7e9f1b3c',
  name: 'Plugin Development Workflow Edge Cases',
  description:
    'Test edge cases, error handling, and UX optimizations in plugin development workflow including existing plugin detection, secret recovery, and upgrade scenarios',
  category: 'integration',
  tags: ['plugin-manager', 'autocoder', 'secrets-manager', 'edge-cases', 'error-handling', 'ux'],

  actors: [
    {
      id: '3d4e5f6a-7b8c-9d0e-1f2a-3b4c5d6e7f8a',
      name: 'Advanced Plugin Development Agent',
      role: 'subject',
      bio: 'An advanced plugin development assistant that handles complex scenarios',
      system: `You are an expert plugin development assistant that excels at handling complex scenarios:

1. PLUGIN DISCOVERY INTELLIGENCE:
   - Always search existing plugins first
   - Analyze similarity and recommend extend vs create new
   - Check for compatibility and dependency conflicts
   - Suggest plugin combinations when beneficial

2. SMART SECRET MANAGEMENT:
   - Detect when API keys are needed from context
   - Guide users through secure collection process
   - Handle missing or invalid secrets gracefully
   - Support secret rotation and updates

3. ROBUST ERROR HANDLING:
   - Provide clear error explanations
   - Suggest concrete solutions
   - Implement retry mechanisms
   - Graceful degradation when services unavailable

4. UX OPTIMIZATION:
   - Minimize user effort and decision fatigue
   - Provide progress updates and estimated completion times
   - Offer alternative paths when primary approach fails
   - Proactive communication about potential issues

Always prioritize user experience and provide helpful guidance throughout the process.`,
      plugins: [
        '@elizaos/plugin-plugin-manager',
        '@elizaos/plugin-autocoder', 
        '@elizaos/plugin-secrets-manager',
        '@elizaos/plugin-ngrok'
      ],
      script: { steps: [] },
    },
    {
      id: '4e5f6a7b-8c9d-0e1f-2a3b-4c5d6e7f8a9b',
      name: 'Challenging User',
      role: 'assistant',
      script: {
        steps: [
          {
            type: 'message',
            content: 'I want to create a plugin for GitHub integration that can list repositories and create issues. But I don\'t want to reinvent the wheel if something similar already exists.',
          },
          {
            type: 'wait',
            waitTime: 10000,
          },
          {
            type: 'message',
            content: 'Hmm, if there\'s already a GitHub plugin, can we extend it instead? What would be the pros and cons of each approach?',
          },
          {
            type: 'wait',
            waitTime: 8000,
          },
          {
            type: 'message',
            content: 'Ok, let\'s go with your recommendation. But I forgot my GitHub token - can you help me get set up with the right credentials?',
          },
          {
            type: 'wait',
            waitTime: 12000,
          },
          {
            type: 'message',
            content: 'Actually, I just realized I need this to work with both GitHub and GitLab. Can the plugin support multiple Git platforms?',
          },
          {
            type: 'wait',
            waitTime: 15000,
          },
          {
            type: 'message',
            content: 'What if something goes wrong during development? How do we handle errors and retry failed builds?',
          },
          {
            type: 'wait',
            waitTime: 8000,
          },
          {
            type: 'message',
            content: 'This is taking a while. Can you give me an estimated completion time and show me what\'s happening under the hood?',
          },
          {
            type: 'wait',
            waitTime: 10000,
          },
          {
            type: 'message',
            content: 'Perfect! Now what if I want to update this plugin later with new features? How does the update process work?',
          },
        ],
        personality: 'curious, thorough, occasionally impatient, security-conscious',
        goals: [
          'understand all available options',
          'make informed decisions about plugin architecture', 
          'ensure robust error handling',
          'plan for future extensibility',
          'optimize development workflow',
        ],
      },
    },
  ],

  setup: {
    roomType: 'dm',
    roomName: 'Advanced Plugin Development',
    context: 'Complex plugin development scenario with edge cases and optimization opportunities',
    environment: {
      plugins: [
        '@elizaos/plugin-plugin-manager',
        '@elizaos/plugin-autocoder', 
        '@elizaos/plugin-secrets-manager',
        '@elizaos/plugin-ngrok',
        '@elizaos/plugin-github' // Existing plugin to test discovery
      ],
      existingPlugins: ['@elizaos/plugin-github'],
      complexRequirements: true,
      errorSimulation: true,
    },
  },

  execution: {
    maxDuration: 420000, // 7 minutes
    maxSteps: 45,
    stopConditions: [
      {
        type: 'message_count',
        value: 14,
        description: 'Stop after full conversation',
      },
    ],
  },

  verification: {
    rules: [
      {
        id: '1e2f3a4b-5c6d-7e8f-9a0b-1c2d3e4f5a6b',
        type: 'llm' as const,
        description: 'Comprehensive plugin discovery performed',
        config: {
          expectedValue: 'SEARCH_PLUGINS',
          criteria: 'Agent should search for existing GitHub/Git plugins and analyze their capabilities thoroughly',
        },
        weight: 4,
      },
      {
        id: '2f3a4b5c-6d7e-8f9a-0b1c-2d3e4f5a6b7c',
        type: 'llm' as const,
        description: 'Intelligent recommendation provided',
        config: {
          criteria: 'Agent should analyze existing GitHub plugin and provide pros/cons of extending vs creating new',
        },
        weight: 4,
      },
      {
        id: '3a4b5c6d-7e8f-9a0b-1c2d-3e4f5a6b7c8d',
        type: 'llm' as const,
        description: 'Guided secret collection process',
        config: {
          expectedValue: 'requestSecretForm',
          criteria: 'Agent should detect missing GitHub token and guide user through secure collection',
        },
        weight: 4,
      },
      {
        id: '4b5c6d7e-8f9a-0b1c-2d3e-4f5a6b7c8d9e',
        type: 'llm' as const,
        description: 'Multi-platform architecture consideration',
        config: {
          criteria: 'Agent should address GitHub + GitLab support requirements and suggest appropriate architecture',
        },
        weight: 3,
      },
      {
        id: '5c6d7e8f-9a0b-1c2d-3e4f-5a6b7c8d9e0f',
        type: 'llm' as const,
        description: 'Error handling strategy explained',
        config: {
          criteria: 'Agent should explain error handling, retry mechanisms, and recovery procedures',
        },
        weight: 3,
      },
      {
        id: '6d7e8f9a-0b1c-2d3e-4f5a-6b7c8d9e0f1a',
        type: 'llm' as const,
        description: 'Progress transparency provided',
        config: {
          expectedValue: 'checkProjectStatus',
          criteria: 'Agent should provide detailed progress updates and estimated completion times',
        },
        weight: 3,
      },
      {
        id: '7e8f9a0b-1c2d-3e4f-5a6b-7c8d9e0f1a2b',
        type: 'llm' as const,
        description: 'Update workflow planning',
        config: {
          expectedValue: 'updatePluginProject',
          criteria: 'Agent should explain plugin update process and version management strategy',
        },
        weight: 3,
      },
      {
        id: '8f9a0b1c-2d3e-4f5a-6b7c-8d9e0f1a2b3c',
        type: 'llm' as const,
        description: 'Dependency conflict detection',
        config: {
          criteria: 'Agent should identify potential conflicts between GitHub and GitLab dependencies',
        },
        weight: 3,
      },
      {
        id: '9a0b1c2d-3e4f-5a6b-7c8d-9e0f1a2b3c4d',
        type: 'llm' as const,
        description: 'Proactive problem solving',
        config: {
          criteria: 'Agent should anticipate potential issues and provide preventive solutions',
        },
        weight: 4,
      },
      {
        id: '0b1c2d3e-4f5a-6b7c-8d9e-0f1a2b3c4d5e',
        type: 'llm' as const,
        description: 'User experience optimization',
        config: {
          criteria: 'Agent should minimize user decision fatigue and provide clear guidance throughout',
        },
        weight: 4,
      },
    ],
    expectedOutcomes: [
      {
        actorId: '3d4e5f6a-7b8c-9d0e-1f2a-3b4c5d6e7f8a',
        outcome: 'Successfully handled complex plugin development scenario with optimal UX',
        verification: {
          id: 'b1c2d3e4-5f6a-7b8c-9d0e-1f2a3b4c5d6e',
          type: 'llm' as const,
          description: 'Complex scenario handled with excellence',
          config: {
            criteria: 'Agent provided intelligent recommendations, guided user through challenges, and optimized the development experience',
          },
        },
      },
    ],
    groundTruth: {
      expectedBehavior: 'Intelligent handling of complex scenarios with user-centric approach',
      successCriteria: [
        'Thoroughly analyzed existing plugin options',
        'Provided informed recommendations with tradeoffs',
        'Guided secure credential collection',
        'Addressed multi-platform requirements',
        'Explained comprehensive error handling',
        'Provided transparent progress tracking',
        'Planned for future updates and maintenance',
        'Minimized user effort and confusion',
        'Anticipated and prevented potential issues',
      ],
    },
  },

  benchmarks: {
    maxDuration: 420000,
    maxSteps: 45,
    maxTokens: 20000,
    targetAccuracy: 0.88,
    customMetrics: [
      { name: 'recommendation_quality_score' },
      { name: 'user_guidance_effectiveness' },
      { name: 'error_handling_completeness' },
      { name: 'progress_transparency_rating' },
      { name: 'decision_support_quality' },
      { name: 'proactive_problem_prevention' },
    ],
  },
};

export default pluginWorkflowEdgeCasesScenario;