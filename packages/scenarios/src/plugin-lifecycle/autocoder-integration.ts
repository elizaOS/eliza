import type { Scenario } from "../types.js";

export const autocoderIntegrationScenario: Scenario = {
  id: 'autocoder-integration-comprehensive',
  name: 'Autocoder Plugin Comprehensive Integration Testing',
  description: 'Deep testing of autocoder plugin functionality including code generation, refactoring, debugging, and integration with other development tools',
  category: 'plugin-integration',
  tags: ['autocoder', 'code-generation', 'development', 'integration'],
  
  actors: [
    {
      id: 'autocoder-agent',
      name: 'Autocoder Agent',
      role: 'subject',
      systemPrompt: `You are an AI agent with the autocoder plugin loaded. You can:
- Generate code from natural language descriptions
- Refactor existing code for better quality
- Debug code and suggest fixes
- Create test cases for code
- Analyze code for security vulnerabilities
- Optimize code performance
- Generate documentation
- Work with multiple programming languages
- Integrate with version control systems
- Handle complex multi-file projects

Provide detailed, working code solutions and explain your reasoning.`,
    },
    {
      id: 'developer',
      name: 'Senior Developer',
      role: 'subject',
      script: {
        steps: [
          {
            type: 'message',
            content: 'I need to create a TypeScript function that validates email addresses using regex. Can you generate this with proper error handling and tests?',
            timing: 3000,
          },
          {
            type: 'wait',
            waitTime: 5000,
          },
          {
            type: 'message',
            content: 'Excellent! Now I have this legacy JavaScript code that needs to be refactored to TypeScript with proper types. Here it is: `function process(data) { return data.map(item => item.value * 2).filter(val => val > 10); }`',
            timing: 3000,
          },
          {
            type: 'wait',
            waitTime: 4000,
          },
          {
            type: 'message',
            content: 'Great work! Now I\'m getting a strange bug in my React component where state updates aren\'t triggering re-renders. Can you help me debug this issue and suggest a fix?',
            timing: 3000,
          },
          {
            type: 'wait',
            waitTime: 5000,
          },
          {
            type: 'message',
            content: 'Perfect! Now I need you to create a complete Express.js API endpoint with middleware, error handling, and proper validation for a user registration system.',
            timing: 3000,
          },
          {
            type: 'wait',
            waitTime: 6000,
          },
          {
            type: 'message',
            content: 'Impressive! Can you analyze the security implications of this code and suggest improvements? Also, generate comprehensive unit tests for it.',
            timing: 3000,
          },
          {
            type: 'wait',
            waitTime: 5000,
          },
          {
            type: 'message',
            content: 'Now I want to optimize this code for performance. Can you suggest performance improvements and generate benchmarking code?',
            timing: 3000,
          },
          {
            type: 'wait',
            waitTime: 4000,
          },
          {
            type: 'message',
            content: 'Finally, can you help me integrate this with a GitHub workflow? Generate the necessary CI/CD configuration files.',
            timing: 3000,
          },
        ],
      },
    },
    {
      id: 'code-reviewer',
      name: 'Code Reviewer',
      role: 'subject',
      script: {
        steps: [
          {
            type: 'wait',
            waitTime: 50000, // Wait for main development tasks
          },
          {
            type: 'message',
            content: 'I need to review all the generated code. Can you provide a comprehensive code review checklist and verify the quality of everything created?',
            timing: 2000,
          },
          {
            type: 'wait',
            waitTime: 4000,
          },
          {
            type: 'message',
            content: 'Also, please verify that the autocoder plugin can handle edge cases - try generating code for an invalid or ambiguous request.',
            timing: 2000,
          },
          {
            type: 'wait',
            waitTime: 3000,
          },
          {
            type: 'message',
            content: 'Test the plugin\'s ability to maintain context across multiple related code generation requests in a complex project.',
            timing: 2000,
          },
        ],
      },
    },
  ],
  
  setup: {
    roomName: 'Autocoder Development Environment',
    roomType: 'group',
    initialContext: {
      purpose: 'code-development-testing',
      environment: 'development',
      projectType: 'full-stack-web-application',
    },
  },
  
  execution: {
    maxDuration: 180000, // 3 minutes for complex code generation
    maxSteps: 60,
    strategy: 'sequential',
  },
  
  verification: {
    strategy: 'llm',
    confidence: 0.85,
    rules: [
      {
        id: 'code-generation-quality',
        type: 'llm',
        description: 'Generated code is syntactically correct, follows best practices, and meets requirements',
        weight: 3,
        config: {
          successCriteria: 'All generated code compiles, follows language conventions, includes proper error handling, and fulfills specified requirements',
          category: 'functional',
          priority: 'HIGH',
        },
      },
      {
        id: 'refactoring-improvement',
        type: 'llm',
        description: 'Code refactoring improves quality, maintainability, and type safety',
        weight: 3,
        config: {
          successCriteria: 'Refactored code shows measurable improvements in type safety, readability, and maintainability while preserving functionality',
          category: 'functional',
          priority: 'HIGH',
        },
      },
      {
        id: 'debugging-effectiveness',
        type: 'llm',
        description: 'Agent identifies bugs accurately and provides effective solutions',
        weight: 3,
        config: {
          successCriteria: 'Agent correctly identifies the root cause of bugs and provides working solutions with explanations',
          category: 'functional',
          priority: 'HIGH',
        },
      },
      {
        id: 'security-analysis',
        type: 'llm',
        description: 'Agent identifies security vulnerabilities and provides secure alternatives',
        weight: 3,
        config: {
          successCriteria: 'Agent identifies potential security issues, explains risks, and provides secure implementations',
          category: 'security',
          priority: 'HIGH',
        },
      },
      {
        id: 'test-generation-coverage',
        type: 'llm',
        description: 'Generated tests provide comprehensive coverage and meaningful assertions',
        weight: 2,
        config: {
          successCriteria: 'Tests cover edge cases, include both positive and negative scenarios, and use appropriate testing frameworks',
          category: 'functional',
          priority: 'MEDIUM',
        },
      },
      {
        id: 'performance-optimization',
        type: 'llm',
        description: 'Performance optimizations are valid and provide measurable improvements',
        weight: 2,
        config: {
          successCriteria: 'Optimization suggestions are technically sound and include benchmarking approaches',
          category: 'performance',
          priority: 'MEDIUM',
        },
      },
      {
        id: 'integration-compatibility',
        type: 'llm',
        description: 'Generated code integrates well with existing systems and follows project patterns',
        weight: 2,
        config: {
          successCriteria: 'Code follows project conventions, integrates with specified systems, and maintains consistency',
          category: 'behavioral',
          priority: 'MEDIUM',
        },
      },
      {
        id: 'context-awareness',
        type: 'llm',
        description: 'Agent maintains context across related requests and builds cohesive solutions',
        weight: 2,
        config: {
          successCriteria: 'Agent demonstrates understanding of project context and creates cohesive, interrelated code components',
          category: 'behavioral',
          priority: 'MEDIUM',
        },
      },
      {
        id: 'edge-case-handling',
        type: 'llm',
        description: 'Agent handles ambiguous or invalid requests gracefully',
        weight: 1,
        config: {
          successCriteria: 'Agent identifies ambiguous requests, asks for clarification, and handles invalid inputs appropriately',
          category: 'edge-case',
          priority: 'LOW',
        },
      },
    ],
  },
  
  benchmarks: {
    responseTime: 12000, // Code generation can be complex
    completionTime: 180000, // 3 minutes
    successRate: 0.85,
    customMetrics: {
      codeBlocksGenerated: 6,
      bugsIdentified: 1,
      securityIssuesFound: 1,
      testCasesCreated: 1,
    },
  },
  
  metadata: {
    complexity: 'high',
    systemRequirements: ['autocoder-plugin', 'github-plugin'],
    skills: ['typescript', 'javascript', 'react', 'express', 'testing'],
    testType: 'integration',
  },
};

export default autocoderIntegrationScenario;