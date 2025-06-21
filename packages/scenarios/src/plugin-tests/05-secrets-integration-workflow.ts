import type { Scenario } from "../types.js";

export const secretsIntegrationWorkflowScenario: Scenario = {
  id: 'f3e7d9c1-8b2a-4f6e-9d1c-5a7b9e3f1d5c',
  name: 'Secrets Manager Integration Workflow',
  description:
    'Test comprehensive secrets manager integration including automatic secret detection, secure web forms, multi-level storage, and seamless integration with plugin development',
  category: 'integration',
  tags: ['secrets-manager', 'security', 'web-forms', 'plugin-development', 'automation'],

  actors: [
    {
      id: '5f1d3c7e-9a2b-4e6f-8c1d-7b9e3a5f1d3c',
      name: 'Secrets Management Agent',
      role: 'subject',
      bio: 'An intelligent agent specializing in secure secret management and plugin development',
      system: `You are a security-focused agent that specializes in intelligent secret management:

1. AUTOMATIC SECRET DETECTION:
   - Analyze user requests to identify required API keys/secrets
   - Detect service types (OpenAI, Anthropic, GitHub, etc.) from context
   - Proactively request secrets before they're needed in development

2. SECURE COLLECTION WORKFLOW:
   - Use SecretFormService to create secure web forms
   - Generate appropriate form fields based on detected secret types
   - Provide clear instructions and security guidance
   - Handle form submissions and store secrets securely

3. MULTI-LEVEL STORAGE INTELLIGENCE:
   - Choose appropriate storage level (global, world, user)
   - Explain storage decisions and security implications
   - Handle permission management and access control
   - Support secret rotation and updates

4. SEAMLESS PLUGIN INTEGRATION:
   - Integrate secret collection with plugin development workflow
   - Validate secrets before plugin testing
   - Handle missing or invalid secrets gracefully
   - Provide secrets to autocoder and other services

Always prioritize security while maintaining excellent user experience.`,
      plugins: [
        '@elizaos/plugin-secrets-manager',
        '@elizaos/plugin-autocoder',
        '@elizaos/plugin-plugin-manager',
        '@elizaos/plugin-ngrok'
      ],
      script: { steps: [] },
    },
    {
      id: '6a2e4f8c-1b3d-5e7f-9a2e-4c6f8a2e4f8c',
      name: 'Security-Conscious Developer',
      role: 'assistant',
      script: {
        steps: [
          {
            type: 'message',
            content: 'I want to create a plugin that integrates with multiple AI services: OpenAI for text generation, Anthropic for reasoning, and ElevenLabs for speech synthesis. I need help managing all the API keys securely.',
          },
          {
            type: 'wait',
            waitTime: 12000,
          },
          {
            type: 'message',
            content: 'Great! I can see the secure form. Let me fill it out... Actually, what\'s the difference between storing these keys globally vs for this specific project? Which is more secure?',
          },
          {
            type: 'wait',
            waitTime: 8000,
          },
          {
            type: 'message',
            content: 'Perfect. I\'ll use project-level storage. Now, what happens if I need to rotate these API keys later? How do I update them without breaking the plugin?',
          },
          {
            type: 'wait',
            waitTime: 6000,
          },
          {
            type: 'message',
            content: 'Excellent. Now let\'s proceed with creating the multi-AI plugin. I want to make sure the secrets are properly integrated with the development process.',
          },
          {
            type: 'wait',
            waitTime: 20000,
          },
          {
            type: 'message',
            content: 'How can I verify that the plugin is correctly using the stored secrets? And what happens if one of the API keys is invalid?',
          },
          {
            type: 'wait',
            waitTime: 10000,
          },
          {
            type: 'message',
            content: 'Can you show me all the secrets currently stored for this project? I want to make sure everything is set up correctly.',
          },
          {
            type: 'wait',
            waitTime: 5000,
          },
          {
            type: 'message',
            content: 'Finally, what are the best practices for sharing this plugin with others? How do they handle their own API keys?',
          },
        ],
        personality: 'security-focused, detail-oriented, methodical, forward-thinking',
        goals: [
          'understand secret storage security models',
          'implement secure secret management workflow',
          'plan for secret rotation and maintenance',
          'ensure plugin security best practices',
          'prepare for team collaboration',
        ],
      },
    },
  ],

  setup: {
    roomType: 'dm',
    roomName: 'Secure Plugin Development',
    context: 'Multi-service plugin development with comprehensive secret management',
    environment: {
      plugins: [
        '@elizaos/plugin-secrets-manager',
        '@elizaos/plugin-autocoder',
        '@elizaos/plugin-plugin-manager',
        '@elizaos/plugin-ngrok'
      ],
      securityFocus: true,
      multiService: true,
      ngrokTunnel: true,
    },
  },

  execution: {
    maxDuration: 360000, // 6 minutes
    maxSteps: 40,
    stopConditions: [
      {
        type: 'message_count',
        value: 14,
        description: 'Complete conversation flow',
      },
    ],
  },

  verification: {
    rules: [
      {
        id: '1f3e7d9c-8b2a-4f6e-9d1c-5a7b9e3f1d5c',
        type: 'llm' as const,
        description: 'Automatic secret detection performed',
        config: {
          criteria: 'Agent should automatically detect required API keys for OpenAI, Anthropic, and ElevenLabs services',
        },
        weight: 4,
      },
      {
        id: '2e4f8c1b-3d5e-7f9a-2e4c-6f8a2e4f8c1b',
        type: 'llm' as const,
        description: 'Secure web form generated',
        config: {
          expectedValue: 'requestSecretForm',
          criteria: 'Agent should create a secure web form with appropriate fields for all detected secrets',
        },
        weight: 5,
      },
      {
        id: '3d5e7f9a-2e4c-6f8a-2e4f-8c1b3d5e7f9a',
        type: 'llm' as const,
        description: 'Storage level guidance provided',
        config: {
          criteria: 'Agent should explain different storage levels (global vs project) and recommend appropriate choice',
        },
        weight: 3,
      },
      {
        id: '4c6f8a2e-4f8c-1b3d-5e7f-9a2e4c6f8a2e',
        type: 'llm' as const,
        description: 'Secret rotation workflow explained',
        config: {
          criteria: 'Agent should explain how to update/rotate secrets without breaking the plugin',
        },
        weight: 3,
      },
      {
        id: '5b7f9a2e-4c6f-8a2e-4f8c-1b3d5e7f9a2e',
        type: 'llm' as const,
        description: 'Plugin development integration',
        config: {
          expectedValue: 'createPluginProject',
          criteria: 'Agent should integrate secret collection with plugin development workflow',
        },
        weight: 4,
      },
      {
        id: '6a8e4f8c-1b3d-5e7f-9a2e-4c6f8a2e4f8c',
        type: 'llm' as const,
        description: 'Secret validation and error handling',
        config: {
          criteria: 'Agent should explain secret validation process and error handling for invalid keys',
        },
        weight: 3,
      },
      {
        id: '79d2e4c6-f8a2-e4f8-c1b3-d5e7f9a2e4c6',
        type: 'llm' as const,
        description: 'Secret listing and verification',
        config: {
          expectedValue: 'listSecrets',
          criteria: 'Agent should provide secure way to list/verify stored secrets without exposing values',
        },
        weight: 3,
      },
      {
        id: '8c1f5e7f-9a2e-4c6f-8a2e-4f8c1b3d5e7f',
        type: 'llm' as const,
        description: 'Collaboration security guidance',
        config: {
          criteria: 'Agent should explain best practices for plugin sharing and team secret management',
        },
        weight: 3,
      },
      {
        id: '9b3e7f9a-2e4c-6f8a-2e4f-8c1b3d5e7f9a',
        type: 'llm' as const,
        description: 'Comprehensive security workflow',
        config: {
          criteria: 'Agent should demonstrate end-to-end secure secret management throughout plugin development',
        },
        weight: 5,
      },
      {
        id: 'a2f4c6f8-a2e4-f8c1-b3d5-e7f9a2e4c6f8',
        type: 'llm' as const,
        description: 'User experience optimization',
        config: {
          criteria: 'Agent should provide excellent UX while maintaining strict security standards',
        },
        weight: 3,
      },
    ],
    expectedOutcomes: [
      {
        actorId: '5f1d3c7e-9a2b-4e6f-8c1d-7b9e3a5f1d3c',
        outcome: 'Successfully demonstrated comprehensive secure secret management workflow',
        verification: {
          id: 'b3f6e8a2-e4f8-c1b3-d5e7-f9a2e4c6f8a2',
          type: 'llm' as const,
          description: 'Complete secure workflow demonstrated',
          config: {
            criteria: 'Agent provided secure, user-friendly secret management with proper integration into plugin development',
          },
        },
      },
    ],
    groundTruth: {
      expectedBehavior: 'Intelligent, secure, and user-friendly secret management workflow',
      successCriteria: [
        'Automatically detected all required API keys',
        'Generated secure web form with appropriate fields',
        'Explained storage level security implications',
        'Provided secret rotation and update guidance',
        'Integrated secrets seamlessly with plugin development',
        'Implemented proper secret validation and error handling',
        'Offered secure secret listing and verification',
        'Explained team collaboration best practices',
        'Maintained security while optimizing user experience',
        'Demonstrated end-to-end secure workflow',
      ],
    },
  },

  benchmarks: {
    maxDuration: 360000,
    maxSteps: 40,
    maxTokens: 18000,
    targetAccuracy: 0.92,
    customMetrics: [
      { name: 'secret_detection_accuracy' },
      { name: 'form_generation_completeness' },
      { name: 'security_guidance_quality' },
      { name: 'integration_seamlessness' },
      { name: 'user_experience_rating' },
      { name: 'security_compliance_score' },
    ],
  },
};

export default secretsIntegrationWorkflowScenario;