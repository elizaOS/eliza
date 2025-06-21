import type { Scenario } from "../types.js";

export const complexWorkflowIntegrationScenario: Scenario = {
  id: 'complex-workflow-integration',
  name: 'Complex Multi-Plugin Workflow: Download, Fix, Test, and Submit PR',
  description: 'End-to-end workflow testing: download plugin, analyze code, apply autocoder fixes, manage secrets, run tests, and submit PR via GitHub integration',
  category: 'integration-workflow',
  tags: ['workflow', 'integration', 'github', 'autocoder', 'secrets', 'plugin-manager', 'e2e'],
  
  actors: [
    {
      id: 'workflow-orchestrator',
      name: 'Workflow Orchestrator Agent',
      role: 'subject',
      systemPrompt: `You are an advanced AI agent capable of orchestrating complex development workflows. You have access to:
- Plugin Manager (install, configure, manage plugins)
- Autocoder (code generation, analysis, refactoring, testing)
- Secrets Manager (secure credential storage and management)
- GitHub Integration (repository access, PR creation, issue management)
- CLI tools and development utilities

You can execute complex multi-step workflows that involve multiple plugins working together. Always follow security best practices, provide detailed progress updates, and handle errors gracefully.`,
    },
    {
      id: 'product-manager',
      name: 'Product Manager',
      role: 'subject',
      script: {
        steps: [
          {
            type: 'message',
            content: 'We need to address a critical bug in the @elizaos/plugin-github repository. Can you help me set up a complete workflow to fix this? The issue is in the authentication module.',
            timing: 4000,
          },
          {
            type: 'wait',
            waitTime: 5000,
          },
          {
            type: 'message',
            content: 'Perfect! Now I need you to download the plugin source code and analyze it for the authentication bug. Set up any necessary secrets securely.',
            timing: 4000,
          },
          {
            type: 'wait',
            waitTime: 8000,
          },
          {
            type: 'message',
            content: 'Great analysis! Now use the autocoder to generate a fix for the authentication issue. Make sure it includes proper error handling and security measures.',
            timing: 4000,
          },
          {
            type: 'wait',
            waitTime: 10000,
          },
          {
            type: 'message',
            content: 'Excellent! Now I need you to generate comprehensive tests for this fix to ensure it works correctly and doesn\'t break existing functionality.',
            timing: 4000,
          },
          {
            type: 'wait',
            waitTime: 8000,
          },
          {
            type: 'message',
            content: 'Perfect! Now run the tests to verify everything works, then create a pull request with a detailed description of the fix.',
            timing: 4000,
          },
          {
            type: 'wait',
            waitTime: 10000,
          },
          {
            type: 'message',
            content: 'Finally, can you set up automated monitoring to track the PR status and notify me when it\'s ready for review?',
            timing: 4000,
          },
        ],
      },
    },
    {
      id: 'tech-lead',
      name: 'Technical Lead',
      role: 'subject',
      script: {
        steps: [
          {
            type: 'wait',
            waitTime: 30000, // Wait for initial setup
          },
          {
            type: 'message',
            content: 'I want to ensure this workflow follows our development standards. Can you verify the code quality, security practices, and testing coverage?',
            timing: 3000,
          },
          {
            type: 'wait',
            waitTime: 6000,
          },
          {
            type: 'message',
            content: 'Also, please check that all secrets are handled securely and that the plugin integration doesn\'t introduce any vulnerabilities.',
            timing: 3000,
          },
          {
            type: 'wait',
            waitTime: 5000,
          },
          {
            type: 'message',
            content: 'Can you also verify that the workflow is repeatable and that we can automate this process for future bug fixes?',
            timing: 3000,
          },
        ],
      },
    },
    {
      id: 'qa-engineer',
      name: 'QA Engineer',
      role: 'subject',
      script: {
        steps: [
          {
            type: 'wait',
            waitTime: 60000, // Wait for main workflow
          },
          {
            type: 'message',
            content: 'I need to validate the entire workflow end-to-end. Can you demonstrate that all components work together correctly?',
            timing: 2000,
          },
          {
            type: 'wait',
            waitTime: 5000,
          },
          {
            type: 'message',
            content: 'Please test error scenarios - what happens if GitHub is unavailable, if the plugin download fails, or if tests don\'t pass?',
            timing: 2000,
          },
          {
            type: 'wait',
            waitTime: 5000,
          },
          {
            type: 'message',
            content: 'Finally, verify that the workflow maintains state correctly and can recover from interruptions.',
            timing: 2000,
          },
        ],
      },
    },
    {
      id: 'security-engineer',
      name: 'Security Engineer',
      role: 'subject',
      script: {
        steps: [
          {
            type: 'wait',
            waitTime: 90000, // Wait for workflow completion
          },
          {
            type: 'message',
            content: 'I need to audit the security aspects of this workflow. Verify that no secrets are exposed and all operations follow security protocols.',
            timing: 2000,
          },
          {
            type: 'wait',
            waitTime: 4000,
          },
          {
            type: 'message',
            content: 'Check that the authentication mechanisms are secure and that the GitHub integration doesn\'t have any security vulnerabilities.',
            timing: 2000,
          },
        ],
      },
    },
  ],
  
  setup: {
    roomName: 'Complex Workflow Integration Lab',
    roomType: 'group',
    initialContext: {
      purpose: 'end-to-end-workflow-testing',
      environment: 'production-simulation',
      workflow: 'bug-fix-pr-submission',
    },
  },
  
  execution: {
    maxDuration: 300000, // 5 minutes for complex workflow
    maxSteps: 100,
    strategy: 'sequential',
  },
  
  verification: {
    strategy: 'llm',
    confidence: 0.85,
    rules: [
      {
        id: 'workflow-orchestration',
        type: 'llm',
        description: 'Agent successfully orchestrates the entire multi-step workflow',
        weight: 3,
        config: {
          successCriteria: 'Agent demonstrates ability to coordinate multiple plugins and execute complex workflows with proper sequencing',
          category: 'functional',
          priority: 'HIGH',
        },
      },
      {
        id: 'plugin-integration',
        type: 'llm',
        description: 'Multiple plugins work together seamlessly without conflicts',
        weight: 3,
        config: {
          successCriteria: 'Plugin manager, autocoder, secrets manager, and GitHub plugins integrate properly and share data appropriately',
          category: 'functional',
          priority: 'HIGH',
        },
      },
      {
        id: 'security-throughout-workflow',
        type: 'llm',
        description: 'Security is maintained throughout the entire workflow',
        weight: 3,
        config: {
          successCriteria: 'All sensitive data is handled securely, secrets are properly managed, and no security vulnerabilities are introduced',
          category: 'security',
          priority: 'HIGH',
        },
      },
      {
        id: 'code-quality-standards',
        type: 'llm',
        description: 'Generated code and fixes meet quality standards',
        weight: 3,
        config: {
          successCriteria: 'Code follows best practices, includes proper error handling, and meets established quality standards',
          category: 'functional',
          priority: 'HIGH',
        },
      },
      {
        id: 'testing-completeness',
        type: 'llm',
        description: 'Comprehensive testing is implemented and executed',
        weight: 2,
        config: {
          successCriteria: 'Tests cover the fix comprehensively, include edge cases, and validate that existing functionality is not broken',
          category: 'functional',
          priority: 'MEDIUM',
        },
      },
      {
        id: 'github-integration',
        type: 'llm',
        description: 'GitHub operations (clone, commit, PR creation) work correctly',
        weight: 2,
        config: {
          successCriteria: 'Repository operations are successful, PR is created with proper description, and GitHub API integration works correctly',
          category: 'functional',
          priority: 'MEDIUM',
        },
      },
      {
        id: 'error-handling-robustness',
        type: 'llm',
        description: 'Workflow handles errors gracefully and provides recovery options',
        weight: 2,
        config: {
          successCriteria: 'System handles network failures, API errors, and plugin failures gracefully with appropriate error messages and recovery options',
          category: 'edge-case',
          priority: 'MEDIUM',
        },
      },
      {
        id: 'state-management',
        type: 'llm',
        description: 'Workflow state is properly managed and can recover from interruptions',
        weight: 2,
        config: {
          successCriteria: 'Workflow maintains consistent state, can resume from interruptions, and tracks progress appropriately',
          category: 'behavioral',
          priority: 'MEDIUM',
        },
      },
      {
        id: 'automation-capability',
        type: 'llm',
        description: 'Workflow demonstrates potential for automation and repeatability',
        weight: 2,
        config: {
          successCriteria: 'Process is repeatable, can be automated, and demonstrates scalability for similar workflows',
          category: 'behavioral',
          priority: 'MEDIUM',
        },
      },
      {
        id: 'monitoring-alerting',
        type: 'llm',
        description: 'Monitoring and alerting systems work correctly',
        weight: 1,
        config: {
          successCriteria: 'Progress updates are provided, monitoring is set up for PR status, and alerts are configured appropriately',
          category: 'functional',
          priority: 'LOW',
        },
      },
    ],
  },
  
  benchmarks: {
    responseTime: 15000, // Complex workflows take time
    completionTime: 300000, // 5 minutes
    successRate: 0.8, // Complex workflow, some tolerance for issues
    customMetrics: {
      pluginsUsed: 4,
      workflowStepsCompleted: 8,
      securityChecksPerformed: 5,
      testCasesGenerated: 1,
      githubOperations: 3,
    },
  },
  
  metadata: {
    complexity: 'very-high',
    systemRequirements: ['plugin-manager', 'autocoder', 'secrets-manager', 'github-plugin'],
    workflowType: 'end-to-end-development',
    testType: 'integration-workflow',
    businessValue: 'high',
  },
};

export default complexWorkflowIntegrationScenario;