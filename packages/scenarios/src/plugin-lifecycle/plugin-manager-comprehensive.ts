import type { Scenario } from "../types.js";

export const pluginManagerComprehensiveScenario: Scenario = {
  id: 'plugin-manager-comprehensive',
  name: 'Plugin Manager Comprehensive Lifecycle Testing',
  description: 'Thorough testing of plugin discovery, installation, configuration, loading, unloading, updating, and management through the CLI',
  category: 'plugin-system',
  tags: ['plugin-manager', 'lifecycle', 'cli', 'integration'],
  
  actors: [
    {
      id: 'plugin-manager-agent',
      name: 'Plugin Manager Agent',
      role: 'subject',
      systemPrompt: `You are an AI agent with access to the ElizaOS plugin management system. You can:
- List available plugins
- Install plugins from various sources
- Configure plugins with different settings
- Load and unload plugins dynamically
- Update plugins to newer versions
- Handle plugin dependencies
- Manage plugin conflicts
- Debug plugin issues

When asked to perform plugin operations, use the appropriate plugin manager actions and provide detailed feedback about the process.`,
    },
    {
      id: 'developer',
      name: 'Developer',
      role: 'subject',
      script: {
        steps: [
          {
            type: 'message',
            content: 'I need to set up a comprehensive plugin environment. Can you help me explore what plugins are available?',
            timing: 2000,
          },
          {
            type: 'wait',
            waitTime: 3000,
          },
          {
            type: 'message',
            content: 'Great! Now I want to install the @elizaos/plugin-github plugin. Can you walk me through the installation process?',
            timing: 2000,
          },
          {
            type: 'wait',
            waitTime: 5000,
          },
          {
            type: 'message',
            content: 'Perfect! Now I need to configure the GitHub plugin with my authentication token. How do I set that up securely?',
            timing: 2000,
          },
          {
            type: 'wait',
            waitTime: 4000,
          },
          {
            type: 'message',
            content: 'Excellent. Now I want to install @elizaos/plugin-autocoder as well. Can you install it and then show me the current list of loaded plugins?',
            timing: 2000,
          },
          {
            type: 'wait',
            waitTime: 5000,
          },
          {
            type: 'message',
            content: 'I heard there might be a conflict between these plugins. Can you check for any compatibility issues and resolve them?',
            timing: 2000,
          },
          {
            type: 'wait',
            waitTime: 4000,
          },
          {
            type: 'message',
            content: 'Now I want to temporarily unload the GitHub plugin without uninstalling it. How do I do that?',
            timing: 2000,
          },
          {
            type: 'wait',
            waitTime: 3000,
          },
          {
            type: 'message',
            content: 'Great! Can you reload the GitHub plugin and verify it\'s working correctly?',
            timing: 2000,
          },
          {
            type: 'wait',
            waitTime: 4000,
          },
          {
            type: 'message',
            content: 'Finally, I want to check if there are any updates available for my plugins and update them if needed.',
            timing: 2000,
          },
        ],
      },
    },
    {
      id: 'quality-assessor',
      name: 'Quality Assessor',
      role: 'subject',
      script: {
        steps: [
          {
            type: 'wait',
            waitTime: 45000, // Wait for main interaction to complete
          },
          {
            type: 'message',
            content: 'I need to verify the plugin system is working correctly. Can you run a comprehensive health check on all installed plugins?',
            timing: 2000,
          },
          {
            type: 'wait',
            waitTime: 3000,
          },
          {
            type: 'message',
            content: 'Also, please test that the plugin manager properly handles error cases - try installing a non-existent plugin.',',
            timing: 2000,
          },
          {
            type: 'wait',
            waitTime: 3000,
          },
          {
            type: 'message',
            content: 'Finally, demonstrate that plugin state persistence works by restarting the agent and verifying plugins remain configured.',
            timing: 2000,
          },
        ],
      },
    },
  ],
  
  setup: {
    roomName: 'Plugin Manager Test Environment',
    roomType: 'group',
    initialContext: {
      purpose: 'comprehensive-plugin-testing',
      environment: 'controlled-test',
      pluginSystemEnabled: true,
    },
  },
  
  execution: {
    maxDuration: 120000, // 2 minutes for comprehensive testing
    maxSteps: 50,
    strategy: 'sequential',
  },
  
  verification: {
    strategy: 'llm', // Only LLM-based verification
    confidence: 0.8,
    rules: [
      {
        id: 'plugin-discovery-successful',
        type: 'llm',
        description: 'Agent successfully discovers and lists available plugins',
        weight: 3,
        config: {
          successCriteria: 'Agent provides a list of available plugins with descriptions and demonstrates knowledge of plugin discovery mechanisms',
          category: 'functional',
          priority: 'HIGH',
        },
      },
      {
        id: 'plugin-installation-complete',
        type: 'llm',
        description: 'Agent successfully installs plugins with proper dependency resolution',
        weight: 3,
        config: {
          successCriteria: 'Agent installs plugins correctly, handles dependencies, and provides installation feedback',
          category: 'functional',
          priority: 'HIGH',
        },
      },
      {
        id: 'plugin-configuration-secure',
        type: 'llm',
        description: 'Agent handles plugin configuration securely, especially sensitive data like tokens',
        weight: 3,
        config: {
          successCriteria: 'Agent demonstrates secure configuration practices, uses proper secrets management, and validates configuration',
          category: 'security',
          priority: 'HIGH',
        },
      },
      {
        id: 'plugin-loading-unloading',
        type: 'llm',
        description: 'Agent can dynamically load and unload plugins without system restart',
        weight: 2,
        config: {
          successCriteria: 'Agent demonstrates hot-loading/unloading of plugins with proper state management',
          category: 'functional',
          priority: 'MEDIUM',
        },
      },
      {
        id: 'conflict-resolution',
        type: 'llm',
        description: 'Agent identifies and resolves plugin conflicts effectively',
        weight: 2,
        config: {
          successCriteria: 'Agent detects potential conflicts, explains issues, and provides resolution strategies',
          category: 'edge-case',
          priority: 'MEDIUM',
        },
      },
      {
        id: 'plugin-health-monitoring',
        type: 'llm',
        description: 'Agent can monitor plugin health and diagnose issues',
        weight: 2,
        config: {
          successCriteria: 'Agent provides comprehensive health checks, identifies issues, and suggests remediation',
          category: 'performance',
          priority: 'MEDIUM',
        },
      },
      {
        id: 'error-handling-robustness',
        type: 'llm',
        description: 'Agent handles plugin errors gracefully without system failure',
        weight: 2,
        config: {
          successCriteria: 'Agent properly handles invalid plugins, network failures, and configuration errors',
          category: 'edge-case',
          priority: 'MEDIUM',
        },
      },
      {
        id: 'state-persistence',
        type: 'llm',
        description: 'Plugin states and configurations persist across agent restarts',
        weight: 2,
        config: {
          successCriteria: 'Plugin configurations and states are maintained after system restart',
          category: 'behavioral',
          priority: 'MEDIUM',
        },
      },
    ],
  },
  
  benchmarks: {
    responseTime: 8000, // Plugin operations can be slow
    completionTime: 120000, // 2 minutes
    successRate: 0.85,
    customMetrics: {
      pluginOperationsCompleted: 8,
      securityViolations: 0,
      errorRecoveryCount: 1,
    },
  },
  
  metadata: {
    complexity: 'high',
    systemRequirements: ['plugin-manager', 'secrets-manager'],
    expectedPlugins: ['@elizaos/plugin-github', '@elizaos/plugin-autocoder'],
    testType: 'integration',
  },
};

export default pluginManagerComprehensiveScenario;