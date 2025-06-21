import type { Scenario } from '@elizaos/cli';

/**
 * Comprehensive battle-tested scenarios that push the limits of the scenario system
 */

export const multiStepConversationScenario: Scenario = {
  id: 'multi-step-conversation',
  name: 'Multi-Step Conversation Test',
  description: 'Tests agent ability to maintain context across multiple conversation turns',
  tags: ['conversation', 'context', 'memory', 'battle-tested'],

  actors: [
    {
      id: 'conversation-agent' as any,
      name: 'ConversationAgent',
      role: 'subject',
      bio: 'An agent that maintains conversation context and responds thoughtfully',
      system: 'You are a helpful assistant. Remember what users tell you and reference it in future responses. Always acknowledge information users share and build upon it.',
      plugins: ['@elizaos/plugin-openai']
    },
    {
      id: 'user-conversationalist' as any,
      name: 'UserConversationalist',
      role: 'assistant',
      bio: 'A user conducting a multi-turn conversation',
      system: 'You are testing an agent\'s conversational abilities. Follow the script to test context retention.',
      plugins: ['@elizaos/plugin-openai'],
      script: {
        steps: [
          {
            id: 'initial-intro',
            type: 'message',
            content: 'Hi! My name is Alice and I work as a software engineer at TechCorp.',
            description: 'Introduce personal information',
            timeout: 10000,
            critical: true
          },
          {
            id: 'wait-response-1',
            type: 'wait',
            waitTime: 5000,
            description: 'Wait for acknowledgment'
          },
          {
            id: 'follow-up-info',
            type: 'message',
            content: 'I\'m working on a new AI project that involves natural language processing. It\'s quite challenging!',
            description: 'Share project details',
            timeout: 10000,
            critical: true
          },
          {
            id: 'wait-response-2',
            type: 'wait',
            waitTime: 5000,
            description: 'Wait for response about project'
          },
          {
            id: 'test-memory',
            type: 'message',
            content: 'Can you remind me what I told you about my work?',
            description: 'Test context retention',
            timeout: 10000,
            critical: true
          },
          {
            id: 'final-wait',
            type: 'wait',
            waitTime: 8000,
            description: 'Wait for memory recall response'
          }
        ],
        goals: [
          'Test multi-turn conversation handling',
          'Verify context retention across messages',
          'Ensure agent remembers and references shared information'
        ],
        personality: 'Friendly, detail-oriented, testing conversational memory'
      }
    }
  ],

  setup: {
    roomType: 'group',
    roomName: 'Conversation Test Room'
  },

  execution: {
    maxDuration: 60000, // 1 minute
    maxSteps: 20
  },

  verification: {
    rules: [
      {
        id: 'context-retention',
        type: 'llm',
        description: 'Agent should remember and reference user information',
        config: {
          successCriteria: 'Agent should acknowledge the user\'s name (Alice), job (software engineer), company (TechCorp), and project (AI/NLP) when asked to recall information',
          requiredKeywords: ['Alice', 'software', 'TechCorp'],
        },
        weight: 2
      },
      {
        id: 'conversation-flow',
        type: 'llm',
        description: 'Agent should maintain natural conversation flow',
        config: {
          successCriteria: 'Agent should respond appropriately to each message, asking relevant questions and showing engagement',
        },
        weight: 1
      },
      {
        id: 'memory-recall',
        type: 'llm',
        description: 'Agent should successfully recall shared information when prompted',
        config: {
          successCriteria: 'When asked to recall what the user told them about work, agent should mention key details like software engineering, TechCorp, and AI project',
          requiredKeywords: ['software engineer', 'TechCorp', 'AI'],
        },
        weight: 3
      }
    ]
  }
};

export const stressTestScenario: Scenario = {
  id: 'rapid-fire-stress-test',
  name: 'Rapid Fire Stress Test',
  description: 'Tests agent under high message volume and rapid interactions',
  tags: ['stress-test', 'performance', 'rapid-fire', 'battle-tested'],

  actors: [
    {
      id: 'stress-test-agent' as any,
      name: 'StressTestAgent',
      role: 'subject',
      bio: 'An agent being tested under high message volume',
      system: 'You are a helpful assistant. Respond to each message appropriately, even under high volume. Keep responses concise but helpful.',
      plugins: ['@elizaos/plugin-openai']
    },
    {
      id: 'rapid-fire-user' as any,
      name: 'RapidFireUser',
      role: 'assistant',
      bio: 'A user sending rapid-fire messages to stress test the agent',
      system: 'You are testing an agent\'s performance under stress. Send messages quickly.',
      plugins: ['@elizaos/plugin-openai'],
      script: {
        steps: [
          {
            id: 'question-1',
            type: 'message',
            content: 'What is 2 + 2?',
            description: 'Simple math question',
            timeout: 5000,
            critical: true
          },
          {
            id: 'wait-1',
            type: 'wait',
            waitTime: 1000,
            description: 'Brief wait'
          },
          {
            id: 'question-2',
            type: 'message',
            content: 'What is the capital of France?',
            description: 'Geography question',
            timeout: 5000,
            critical: true
          },
          {
            id: 'wait-2',
            type: 'wait',
            waitTime: 1000,
            description: 'Brief wait'
          },
          {
            id: 'question-3',
            type: 'message',
            content: 'Explain machine learning in one sentence.',
            description: 'Technical question',
            timeout: 5000,
            critical: true
          },
          {
            id: 'wait-3',
            type: 'wait',
            waitTime: 1000,
            description: 'Brief wait'
          },
          {
            id: 'question-4',
            type: 'message',
            content: 'What color is the sky?',
            description: 'Simple factual question',
            timeout: 5000,
            critical: true
          },
          {
            id: 'wait-4',
            type: 'wait',
            waitTime: 1000,
            description: 'Brief wait'
          },
          {
            id: 'question-5',
            type: 'message',
            content: 'Count from 1 to 5.',
            description: 'Sequence task',
            timeout: 5000,
            critical: true
          },
          {
            id: 'final-wait',
            type: 'wait',
            waitTime: 3000,
            description: 'Wait for final responses'
          }
        ],
        goals: [
          'Test agent performance under rapid message volume',
          'Verify response quality remains high under stress',
          'Ensure no message handling failures'
        ],
        personality: 'Quick, inquisitive, testing performance limits'
      }
    }
  ],

  setup: {
    roomType: 'group',
    roomName: 'Stress Test Room'
  },

  execution: {
    maxDuration: 45000, // 45 seconds
    maxSteps: 30
  },

  verification: {
    rules: [
      {
        id: 'message-handling',
        type: 'llm',
        description: 'Agent should handle all messages without failure',
        config: {
          successCriteria: 'Agent should respond to all or most messages appropriately, showing it can handle rapid-fire interactions',
          minMessages: 3,
        },
        weight: 2
      },
      {
        id: 'response-quality',
        type: 'llm',
        description: 'Responses should remain coherent under stress',
        config: {
          successCriteria: 'Agent responses should be relevant and coherent, even under high message volume. Math should be correct (2+2=4), facts should be accurate (Paris is capital of France)',
          requiredKeywords: ['4', 'Paris'],
        },
        weight: 2
      },
      {
        id: 'performance-consistency',
        type: 'llm',
        description: 'Agent should maintain consistent performance throughout',
        config: {
          successCriteria: 'Agent should maintain similar response quality from first to last message, showing stable performance under load',
        },
        weight: 1
      }
    ]
  }
};

export const complexReasoningScenario: Scenario = {
  id: 'complex-reasoning-challenge',
  name: 'Complex Reasoning Challenge',
  description: 'Tests agent ability to handle multi-step reasoning and problem solving',
  tags: ['reasoning', 'problem-solving', 'complex', 'battle-tested'],

  actors: [
    {
      id: 'reasoning-agent' as any,
      name: 'ReasoningAgent',
      role: 'subject',
      bio: 'An agent capable of complex reasoning and problem solving',
      system: 'You are an intelligent assistant skilled at reasoning through complex problems. Break down problems step by step, show your reasoning, and provide clear explanations.',
      plugins: ['@elizaos/plugin-openai']
    },
    {
      id: 'problem-setter' as any,
      name: 'ProblemSetter',
      role: 'assistant',
      bio: 'A user presenting complex reasoning challenges',
      system: 'You are testing an agent\'s reasoning abilities with challenging problems.',
      plugins: ['@elizaos/plugin-openai'],
      script: {
        steps: [
          {
            id: 'logic-puzzle',
            type: 'message',
            content: 'Here\'s a logic puzzle: Three friends - Alice, Bob, and Carol - each have a different favorite color: red, blue, or green. Alice doesn\'t like red. Bob\'s favorite color comes before green alphabetically. What is each person\'s favorite color?',
            description: 'Present logic puzzle',
            timeout: 15000,
            critical: true
          },
          {
            id: 'wait-logic',
            type: 'wait',
            waitTime: 8000,
            description: 'Wait for logic solution'
          },
          {
            id: 'math-sequence',
            type: 'message',
            content: 'What\'s the next number in this sequence: 2, 6, 12, 20, 30, ?',
            description: 'Mathematical pattern recognition',
            timeout: 10000,
            critical: true
          },
          {
            id: 'wait-math',
            type: 'wait',
            waitTime: 6000,
            description: 'Wait for math solution'
          },
          {
            id: 'planning-problem',
            type: 'message',
            content: 'I need to organize a dinner party for 8 people. I have 3 tables that seat 3 people each, but one table is broken. How would you solve this seating problem?',
            description: 'Practical planning challenge',
            timeout: 12000,
            critical: true
          },
          {
            id: 'final-reasoning-wait',
            type: 'wait',
            waitTime: 8000,
            description: 'Wait for planning solution'
          }
        ],
        goals: [
          'Test logical reasoning capabilities',
          'Verify mathematical pattern recognition',
          'Assess practical problem-solving skills'
        ],
        personality: 'Challenging, analytical, focused on testing reasoning abilities'
      }
    }
  ],

  setup: {
    roomType: 'group',
    roomName: 'Reasoning Challenge Room'
  },

  execution: {
    maxDuration: 75000, // 75 seconds
    maxSteps: 15
  },

  verification: {
    rules: [
      {
        id: 'logic-puzzle-solution',
        type: 'llm',
        description: 'Agent should solve the logic puzzle correctly',
        config: {
          successCriteria: 'Agent should correctly identify that Alice likes blue, Bob likes blue (but since Alice already has blue, Bob must like blue comes before green alphabetically, so Bob likes blue), and Carol likes the remaining color. The correct answer is Alice: blue or green, Bob: blue, Carol: red or green.',
        },
        weight: 2
      },
      {
        id: 'math-pattern',
        type: 'llm',
        description: 'Agent should recognize the mathematical sequence pattern',
        config: {
          successCriteria: 'Agent should identify that the sequence is n(n+1) where n starts at 2: 2×3=6, 3×4=12, 4×5=20, 5×6=30, so next is 6×7=42',
          requiredKeywords: ['42'],
        },
        weight: 2
      },
      {
        id: 'practical-problem-solving',
        type: 'llm',
        description: 'Agent should provide practical solutions to the seating problem',
        config: {
          successCriteria: 'Agent should recognize the constraint (2 working tables × 3 seats = 6 seats, but need 8) and propose solutions like getting additional chairs, borrowing a table, or having some people stand/use alternative seating',
        },
        weight: 2
      },
      {
        id: 'reasoning-quality',
        type: 'llm',
        description: 'Agent should show clear reasoning process',
        config: {
          successCriteria: 'Agent should demonstrate step-by-step thinking, explain reasoning process, and show how they arrived at conclusions',
        },
        weight: 1
      }
    ]
  }
};

export const adversarialTestScenario: Scenario = {
  id: 'adversarial-challenge',
  name: 'Adversarial Challenge Test',
  description: 'Tests agent resilience against challenging, confusing, or contradictory inputs',
  tags: ['adversarial', 'resilience', 'edge-cases', 'battle-tested'],

  actors: [
    {
      id: 'resilient-agent' as any,
      name: 'ResilientAgent',
      role: 'subject',
      bio: 'An agent being tested for resilience against difficult inputs',
      system: 'You are a helpful and robust assistant. Stay helpful and polite even when faced with confusing, contradictory, or challenging inputs. Ask for clarification when needed.',
      plugins: ['@elizaos/plugin-openai']
    },
    {
      id: 'adversarial-user' as any,
      name: 'AdversarialUser',
      role: 'adversary',
      bio: 'A user testing agent resilience with challenging inputs',
      system: 'You are testing an agent\'s resilience. Follow the script to present challenging scenarios.',
      plugins: ['@elizaos/plugin-openai'],
      script: {
        steps: [
          {
            id: 'contradiction',
            type: 'message',
            content: 'I said the sky is green yesterday, but today I\'m saying it\'s blue. Which statement is correct?',
            description: 'Present contradictory information',
            timeout: 10000,
            critical: true
          },
          {
            id: 'wait-contradiction',
            type: 'wait',
            waitTime: 5000,
            description: 'Wait for response to contradiction'
          },
          {
            id: 'nonsense-question',
            type: 'message',
            content: 'How many purple do you need to make a square louder?',
            description: 'Ask nonsensical question',
            timeout: 8000,
            critical: true
          },
          {
            id: 'wait-nonsense',
            type: 'wait',
            waitTime: 4000,
            description: 'Wait for response to nonsense'
          },
          {
            id: 'impossible-request',
            type: 'message',
            content: 'Please remember that I told you my name is Bob, but also forget that I told you this.',
            description: 'Make self-contradictory request',
            timeout: 10000,
            critical: true
          },
          {
            id: 'wait-impossible',
            type: 'wait',
            waitTime: 5000,
            description: 'Wait for response to impossible request'
          },
          {
            id: 'confusion-test',
            type: 'message',
            content: 'If you always lie and I always tell the truth, and I just said I always lie, what\'s happening?',
            description: 'Present logical paradox',
            timeout: 12000,
            critical: true
          },
          {
            id: 'final-adversarial-wait',
            type: 'wait',
            waitTime: 6000,
            description: 'Wait for paradox response'
          }
        ],
        goals: [
          'Test agent resilience to contradictory inputs',
          'Verify graceful handling of nonsensical requests',
          'Assess ability to handle logical paradoxes'
        ],
        personality: 'Challenging, paradoxical, testing edge cases'
      }
    }
  ],

  setup: {
    roomType: 'group',
    roomName: 'Adversarial Test Room'
  },

  execution: {
    maxDuration: 60000, // 1 minute
    maxSteps: 20
  },

  verification: {
    rules: [
      {
        id: 'graceful-handling',
        type: 'llm',
        description: 'Agent should handle challenging inputs gracefully',
        config: {
          successCriteria: 'Agent should remain helpful and polite when faced with contradictions, nonsense, or paradoxes. Should not become confused or provide unhelpful responses.',
        },
        weight: 2
      },
      {
        id: 'clarification-seeking',
        type: 'llm',
        description: 'Agent should seek clarification for unclear inputs',
        config: {
          successCriteria: 'Agent should recognize when inputs don\'t make sense and politely ask for clarification or explain the issues with the request',
        },
        weight: 2
      },
      {
        id: 'factual-accuracy',
        type: 'llm',
        description: 'Agent should maintain factual accuracy despite misleading inputs',
        config: {
          successCriteria: 'Agent should correctly identify that the sky is blue (not green) and handle contradictory claims appropriately',
          forbiddenKeywords: ['sky is green'],
        },
        weight: 1
      },
      {
        id: 'logical-consistency',
        type: 'llm',
        description: 'Agent should maintain logical consistency',
        config: {
          successCriteria: 'Agent should recognize logical paradoxes and explain why they are problematic rather than attempting impossible solutions',
        },
        weight: 1
      }
    ]
  }
};

// Export all scenarios as a collection
export const battleTestedScenarios = [
  multiStepConversationScenario,
  stressTestScenario,
  complexReasoningScenario,
  adversarialTestScenario
];

// Export the first scenario as default for CLI compatibility
export default multiStepConversationScenario;

// Also export named scenarios for CLI pattern matching
export const scenarios = battleTestedScenarios;
export const testScenarios = battleTestedScenarios;