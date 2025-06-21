import type { Scenario } from "./types.js";

export const codingChallengeScenario: Scenario = {
  id: 'coding-challenge',
  name: 'Basic Coding Challenge',
  description: 'Test the agent\'s ability to understand, write, and explain code solutions',
  category: 'coding',
  tags: ['programming', 'problem-solving', 'code-generation'],

  actors: [
    {
      id: 'coder',
      name: 'Coding Agent',
      role: 'subject',
      // Uses the main agent being tested
    },
    {
      id: 'interviewer',
      name: 'Technical Interviewer',
      role: 'subject',
      script: {
        steps: [
          {
            type: 'message',
            content: 'I\'d like you to solve a coding problem. Write a function that finds the longest common subsequence between two strings. Please provide the solution in Python with comments explaining your approach.'
          },
          {
            type: 'wait',
            waitTime: 15000
          },
          {
            type: 'message',
            content: 'Can you explain the time and space complexity of your solution?'
          },
          {
            type: 'wait',
            waitTime: 10000
          },
          {
            type: 'message',
            content: 'Great! Now can you provide a simple test case to demonstrate how your function works?'
          }
        ],
        personality: 'professional, evaluative, technical',
        goals: ['assess coding ability', 'evaluate explanation skills', 'test understanding of complexity']
      }
    }
  ],

  setup: {
    roomType: 'dm',
    roomName: 'Coding Interview',
    context: 'You are in a technical interview. Solve the coding problem thoroughly and explain your approach clearly.',
    environment: {
      allowCodeExecution: true,
      programmingLanguage: 'python'
    }
  },

  execution: {
    maxDuration: 900000, // 15 minutes
    maxSteps: 20,
    stopConditions: [
      {
        type: 'keyword',
        value: 'solution complete',
        description: 'Stop when solution is marked as complete'
      }
    ]
  },

  verification: {
    rules: [
      {
        id: 'provided-working-solution',
        type: 'llm',
        description: 'Agent provided a working code solution',
        config: {
          criteria: 'The agent provided Python code that correctly implements a longest common subsequence algorithm'
        },
        weight: 4
      },
      {
        id: 'code-has-comments',
        type: 'regex',
        description: 'Code includes explanatory comments',
        config: {
          pattern: '#.*[a-zA-Z]'
        },
        weight: 2
      },
      {
        id: 'explained-complexity',
        type: 'llm',
        description: 'Agent explained time and space complexity',
        config: {
          criteria: 'The agent provided an explanation of the time complexity (likely O(m*n)) and space complexity of their solution'
        },
        weight: 2
      },
      {
        id: 'provided-test-case',
        type: 'llm',
        description: 'Agent provided test case or example',
        config: {
          criteria: 'The agent provided a test case or example demonstrating how their function works with sample inputs'
        },
        weight: 2
      },
      {
        id: 'clear-explanation',
        type: 'llm',
        description: 'Agent provided clear explanations of approach',
        config: {
          criteria: 'The agent clearly explained their algorithmic approach and reasoning behind the solution'
        },
        weight: 2
      },
      {
        id: 'used-appropriate-algorithm',
        type: 'llm',
        description: 'Used appropriate algorithm (dynamic programming)',
        config: {
          criteria: 'The solution uses dynamic programming or a similar appropriate algorithmic approach for longest common subsequence'
        },
        weight: 3
      },
      {
        id: 'response-time',
        type: 'timing',
        description: 'Provided solution within reasonable time',
        config: {
          threshold: 900000 // 15 minutes
        },
        weight: 1
      }
    ],
    groundTruth: {
      correctAnswer: 'Dynamic programming solution with O(m*n) time complexity',
      expectedBehavior: 'Agent should provide working code with explanation',
      successCriteria: [
        'Correct algorithm implementation',
        'Code with comments',
        'Complexity analysis',
        'Test case provided',
        'Clear explanations'
      ]
    }
  },

  benchmarks: {
    maxDuration: 900000,
    maxSteps: 20,
    maxTokens: 6000,
    targetAccuracy: 0.8,
    customMetrics: ['code_quality', 'explanation_clarity', 'problem_solving_approach']
  }
};

export default codingChallengeScenario;