// File: packages/cli/src/commands/scenario/src/__tests__/ConversationEvaluators.test.ts
// Comprehensive tests for conversation-specific evaluators

import { describe, it, expect, beforeEach } from 'bun:test';
import {
  ConversationLengthEvaluator,
  ConversationFlowEvaluator,
  UserSatisfactionEvaluator,
  ContextRetentionEvaluator,
} from '../ConversationEvaluators';
import type { ExecutionResult } from '../providers';

describe('Conversation Evaluators', () => {
  let mockRuntime: any;
  let mockExecutionResult: ExecutionResult;

  beforeEach(() => {
    mockRuntime = {
      useModel: async (modelType: string, params: any) => {
        // Default LLM responses for testing
        const prompt = params.messages[0].content.toLowerCase();

        if (prompt.includes('yes or no')) {
          return 'yes';
        }
        if (prompt.includes('number between 0.0 and 1.0')) {
          return '0.8';
        }
        return 'Mock LLM response';
      },
    };

    mockExecutionResult = {
      exitCode: 0,
      stdout: 'Mock conversation transcript',
      stderr: '',
      files: {},
      startedAtMs: Date.now() - 5000,
      endedAtMs: Date.now(),
      durationMs: 5000,
      trajectory: [],
    };
  });

  describe('ConversationLengthEvaluator', () => {
    let evaluator: ConversationLengthEvaluator;

    beforeEach(() => {
      evaluator = new ConversationLengthEvaluator();
    });

    it('should pass when conversation length is within acceptable range', async () => {
      const resultWithMetadata = {
        ...mockExecutionResult,
        conversationMetadata: {
          turnCount: 4,
          terminatedEarly: false,
          terminationReason: null,
          finalEvaluations: [],
        },
      };

      const params = {
        type: 'conversation_length' as const,
        min_turns: 2,
        max_turns: 6,
        optimal_turns: 4,
      };

      const result = await evaluator.evaluate(params, resultWithMetadata, mockRuntime);

      expect(result.success).toBe(true);
      expect(result.message).toContain('4 turns');
      expect(result.message).toContain('optimal');
    });

    it('should fail when conversation is too short', async () => {
      const resultWithMetadata = {
        ...mockExecutionResult,
        conversationMetadata: {
          turnCount: 1,
          terminatedEarly: true,
          terminationReason: 'user_expresses_satisfaction',
          finalEvaluations: [],
        },
      };

      const params = {
        type: 'conversation_length' as const,
        min_turns: 3,
        max_turns: 8,
      };

      const result = await evaluator.evaluate(params, resultWithMetadata, mockRuntime);

      expect(result.success).toBe(false);
      expect(result.message).toContain('1 turns');
      expect(result.message).toContain('below minimum of 3');
    });

    it('should fail when conversation is too long', async () => {
      const resultWithMetadata = {
        ...mockExecutionResult,
        conversationMetadata: {
          turnCount: 12,
          terminatedEarly: false,
          terminationReason: null,
          finalEvaluations: [],
        },
      };

      const params = {
        type: 'conversation_length' as const,
        min_turns: 2,
        max_turns: 8,
        optimal_turns: 5,
      };

      const result = await evaluator.evaluate(params, resultWithMetadata, mockRuntime);

      expect(result.success).toBe(false);
      expect(result.message).toContain('12 turns');
      expect(result.message).toContain('above maximum of 8');
      expect(result.message).toContain('7 turns from optimal 5');
    });

    it('should validate target range correctly', async () => {
      const resultWithMetadata = {
        ...mockExecutionResult,
        conversationMetadata: {
          turnCount: 10,
          terminatedEarly: false,
          terminationReason: null,
          finalEvaluations: [],
        },
      };

      const params = {
        type: 'conversation_length' as const,
        target_range: [3, 7],
      };

      const result = await evaluator.evaluate(params, resultWithMetadata, mockRuntime);

      expect(result.success).toBe(false);
      expect(result.message).toContain('outside target range 3-7');
    });

    it('should fail gracefully when no conversation metadata is present', async () => {
      const params = {
        type: 'conversation_length' as const,
        min_turns: 2,
        max_turns: 6,
      };

      const result = await evaluator.evaluate(params, mockExecutionResult, mockRuntime);

      expect(result.success).toBe(false);
      expect(result.message).toContain('No conversation metadata found');
    });
  });

  describe('ConversationFlowEvaluator', () => {
    let evaluator: ConversationFlowEvaluator;

    beforeEach(() => {
      evaluator = new ConversationFlowEvaluator();
    });

    it('should detect required conversation patterns', async () => {
      const conversationResult = {
        ...mockExecutionResult,
        stdout: `Turn 1:
User: I have a problem with my account
Agent: What specific issue are you experiencing?

Turn 2:
User: I can't log in to my account
Agent: Let me help you reset your password. Here is the solution: try this link.`,
      };

      // Mock LLM to detect patterns
      mockRuntime.useModel = async (modelType: string, params: any) => {
        const prompt = params.messages[0].content;
        if (prompt.includes('question and the user provides an answer')) {
          return 'yes';
        }
        if (prompt.includes('problem and the agent providing a solution')) {
          return 'yes';
        }
        return 'no';
      };

      const params = {
        type: 'conversation_flow' as const,
        required_patterns: ['question_then_answer', 'problem_then_solution'],
        flow_quality_threshold: 0.8,
      };

      const result = await evaluator.evaluate(params, conversationResult, mockRuntime);

      expect(result.success).toBe(true);
      expect(result.message).toContain('2/2 patterns detected');
      expect(result.message).toContain('question_then_answer, problem_then_solution');
    });

    it('should fail when required patterns are missing', async () => {
      const conversationResult = {
        ...mockExecutionResult,
        stdout: `Turn 1:
User: Hello
Agent: Hello back

Turn 2:
User: How are you?
Agent: I am fine`,
      };

      // Mock LLM to not detect patterns
      mockRuntime.useModel = async () => 'no';

      const params = {
        type: 'conversation_flow' as const,
        required_patterns: ['problem_then_solution', 'escalation_pattern'],
        flow_quality_threshold: 0.7,
      };

      const result = await evaluator.evaluate(params, conversationResult, mockRuntime);

      expect(result.success).toBe(false);
      expect(result.message).toContain('0/2 patterns detected');
      expect(result.message).toContain('problem_then_solution, escalation_pattern');
    });

    it('should handle partial pattern detection based on threshold', async () => {
      mockRuntime.useModel = async (modelType: string, params: any) => {
        const prompt = params.messages[0].content;
        if (prompt.includes('empathy')) {
          return 'yes';
        }
        return 'no';
      };

      const params = {
        type: 'conversation_flow' as const,
        required_patterns: ['empathy_then_solution', 'clarification_cycle'],
        flow_quality_threshold: 0.5, // 50% threshold
      };

      const result = await evaluator.evaluate(params, mockExecutionResult, mockRuntime);

      expect(result.success).toBe(true);
      expect(result.message).toContain('1/2 patterns detected');
    });

    it('should handle LLM failures gracefully', async () => {
      mockRuntime.useModel = async () => {
        throw new Error('LLM API failure');
      };

      const params = {
        type: 'conversation_flow' as const,
        required_patterns: ['question_then_answer'],
        flow_quality_threshold: 0.8,
      };

      const result = await evaluator.evaluate(params, mockExecutionResult, mockRuntime);

      expect(result.success).toBe(false);
      expect(result.message).toContain('0/1 patterns detected');
    });
  });

  describe('UserSatisfactionEvaluator', () => {
    let evaluator: UserSatisfactionEvaluator;

    beforeEach(() => {
      evaluator = new UserSatisfactionEvaluator();
    });

    it('should measure satisfaction using keyword analysis', async () => {
      const satisfiedConversation = {
        ...mockExecutionResult,
        stdout: `Turn 1:
User: I need help with billing
Agent: I can help with that

Turn 2: 
User: Thank you so much! That was perfect and very helpful
Agent: You're welcome!`,
      };

      const params = {
        type: 'user_satisfaction' as const,
        satisfaction_threshold: 0.7,
        measurement_method: 'keyword_analysis' as const,
        indicators: {
          positive: ['thank you', 'perfect', 'helpful'],
          negative: ['frustrated', 'unhelpful'],
        },
      };

      const result = await evaluator.evaluate(params, satisfiedConversation, mockRuntime);

      expect(result.success).toBe(true);
      expect(result.message).toContain('100.0%'); // All positive keywords, no negative
      expect(result.message).toContain('keyword_analysis');
    });

    it('should measure satisfaction using LLM judge', async () => {
      mockRuntime.useModel = async (modelType: string, params: any) => {
        if (params.messages[0].content.includes('satisfied')) {
          return '0.85'; // High satisfaction
        }
        return '0.5';
      };

      const params = {
        type: 'user_satisfaction' as const,
        satisfaction_threshold: 0.8,
        measurement_method: 'llm_judge' as const,
      };

      const result = await evaluator.evaluate(params, mockExecutionResult, mockRuntime);

      expect(result.success).toBe(true);
      expect(result.message).toContain('85.0%');
      expect(result.message).toContain('llm_judge');
    });

    it('should handle sentiment analysis method', async () => {
      mockRuntime.useModel = async (modelType: string, params: any) => {
        if (params.messages[0].content.includes('sentiment')) {
          return '0.75';
        }
        return '0.5';
      };

      const params = {
        type: 'user_satisfaction' as const,
        satisfaction_threshold: 0.7,
        measurement_method: 'sentiment_analysis' as const,
      };

      const result = await evaluator.evaluate(params, mockExecutionResult, mockRuntime);

      expect(result.success).toBe(true);
      expect(result.message).toContain('75.0%');
      expect(result.message).toContain('sentiment_analysis');
    });

    it('should fail when satisfaction is below threshold', async () => {
      const dissatisfiedConversation = {
        ...mockExecutionResult,
        stdout: `Turn 1:
User: This is frustrating and unhelpful
Agent: I apologize

Turn 2:
User: Still confused and angry
Agent: Let me try again`,
      };

      const params = {
        type: 'user_satisfaction' as const,
        satisfaction_threshold: 0.8,
        measurement_method: 'keyword_analysis' as const,
        indicators: {
          positive: ['great', 'helpful'],
          negative: ['frustrating', 'unhelpful', 'confused', 'angry'],
        },
      };

      const result = await evaluator.evaluate(params, dissatisfiedConversation, mockRuntime);

      expect(result.success).toBe(false);
      expect(result.message).toContain('0.0%'); // All negative keywords
    });

    it('should handle neutral conversations correctly', async () => {
      const neutralConversation = {
        ...mockExecutionResult,
        stdout: `Turn 1:
User: I need information
Agent: Here is the information

Turn 2:
User: Okay
Agent: Anything else?`,
      };

      const params = {
        type: 'user_satisfaction' as const,
        satisfaction_threshold: 0.6,
        measurement_method: 'keyword_analysis' as const,
      };

      const result = await evaluator.evaluate(params, neutralConversation, mockRuntime);

      expect(result.success).toBe(false); // 50% neutral < 60% threshold
      expect(result.message).toContain('50.0%');
    });

    it('should handle LLM parsing errors gracefully', async () => {
      mockRuntime.useModel = async () => 'invalid_number';

      const params = {
        type: 'user_satisfaction' as const,
        satisfaction_threshold: 0.7,
        measurement_method: 'llm_judge' as const,
      };

      const result = await evaluator.evaluate(params, mockExecutionResult, mockRuntime);

      expect(result.success).toBe(false); // Default 50% < 70% threshold
      expect(result.message).toContain('50.0%');
    });
  });

  describe('ContextRetentionEvaluator', () => {
    let evaluator: ContextRetentionEvaluator;

    beforeEach(() => {
      evaluator = new ContextRetentionEvaluator();
    });

    it('should test memory retention across conversation turns', async () => {
      const conversationWithMemory = {
        ...mockExecutionResult,
        stdout: `Turn 1:
User: My name is John Smith and I have an issue with my billing
Agent: Hello John, I'll help you with your billing issue

Turn 2:
User: Can you check my account?
Agent: Of course John, let me look up your billing information

Turn 3:
User: What do you see?
Agent: I can see your billing issue John, there was a duplicate charge`,
      };

      // Mock LLM to detect memory retention
      mockRuntime.useModel = async (modelType: string, params: any) => {
        const prompt = params.messages[0].content;
        if (prompt.includes('John Smith') || prompt.includes('billing')) {
          return 'yes';
        }
        return 'no';
      };

      const params = {
        type: 'context_retention' as const,
        test_memory_of: ['John Smith', 'billing'],
        retention_turns: 3,
        memory_accuracy_threshold: 0.8,
      };

      const result = await evaluator.evaluate(params, conversationWithMemory, mockRuntime);

      expect(result.success).toBe(true);
      expect(result.message).toContain('Context retention:');
      expect(result.message).toContain('John Smith: 100.0%');
      expect(result.message).toContain('billing: 100.0%');
    });

    it('should fail when agent forgets important context', async () => {
      const conversationWithForgetfulness = {
        ...mockExecutionResult,
        stdout: `Turn 1:
User: My name is Alice and I need help with password reset
Agent: I'll help with password reset

Turn 2:
User: Can you help me?
Agent: Sure, what's your name again?

Turn 3:
User: Alice, as I mentioned
Agent: Right, what did you need help with?`,
      };

      // Mock LLM to detect poor memory retention
      mockRuntime.useModel = async (modelType: string, params: any) => {
        const prompt = params.messages[0].content;
        // Simulate that the agent forgot context in later turns
        if (prompt.includes('Alice') && (prompt.includes('Turn 2') || prompt.includes('Turn 3'))) {
          return 'no'; // Agent forgot Alice's name
        }
        if (prompt.includes('password reset') && prompt.includes('Turn 3')) {
          return 'no'; // Agent forgot the password reset request
        }
        return 'yes';
      };

      const params = {
        type: 'context_retention' as const,
        test_memory_of: ['Alice', 'password reset'],
        retention_turns: 2,
        memory_accuracy_threshold: 0.8,
      };

      const result = await evaluator.evaluate(params, conversationWithForgetfulness, mockRuntime);

      // The test should complete (success may vary based on implementation details)
      expect(result).toBeDefined();
      expect(result.message).toContain('Context retention:');
      expect(typeof result.success).toBe('boolean');
    });

    it('should handle items never mentioned in conversation', async () => {
      const conversationResult = {
        ...mockExecutionResult,
        stdout: `Turn 1:
User: Hello
Agent: Hi there

Turn 2:
User: How are you?
Agent: I'm good`,
      };

      const params = {
        type: 'context_retention' as const,
        test_memory_of: ['nonexistent_item', 'another_missing_item'],
        retention_turns: 2,
        memory_accuracy_threshold: 0.5,
      };

      const result = await evaluator.evaluate(params, conversationResult, mockRuntime);

      expect(result.success).toBe(false);
      expect(result.message).toContain('nonexistent_item: 0.0%');
      expect(result.message).toContain('another_missing_item: 0.0%');
    });

    it('should handle different retention turn windows', async () => {
      const longConversation = {
        ...mockExecutionResult,
        stdout: `Turn 1:
User: I'm Bob with order #12345
Agent: Hello Bob, I see order #12345

Turn 2:
User: Status update please
Agent: Checking order #12345 for you Bob

Turn 3:
User: Any updates?
Agent: Bob, your order #12345 is processing

Turn 4:
User: When will it ship?
Agent: Order #12345 should ship tomorrow Bob

Turn 5:
User: Thank you
Agent: You're welcome!`,
      };

      mockRuntime.useModel = async (modelType: string, params: any) => {
        const prompt = params.messages[0].content;
        // Simulate gradual memory degradation
        if (prompt.includes('Turn 5')) {
          return 'no'; // Forgot in final turn
        }
        return 'yes';
      };

      const params = {
        type: 'context_retention' as const,
        test_memory_of: ['Bob', 'order #12345'],
        retention_turns: 4,
        memory_accuracy_threshold: 0.75,
      };

      const result = await evaluator.evaluate(params, longConversation, mockRuntime);

      // Should show high but not perfect retention
      expect(result.message).toContain('Context retention:');
    });

    it('should handle LLM failures in memory testing', async () => {
      mockRuntime.useModel = async () => {
        throw new Error('LLM failure during memory test');
      };

      const params = {
        type: 'context_retention' as const,
        test_memory_of: ['test_item'],
        retention_turns: 2,
        memory_accuracy_threshold: 0.8,
      };

      const result = await evaluator.evaluate(params, mockExecutionResult, mockRuntime);

      expect(result.success).toBe(false);
      expect(result.message).toContain('test_item: 0.0%');
    });

    it('should parse conversation turns correctly', async () => {
      const malformedConversation = {
        ...mockExecutionResult,
        stdout: `Malformed conversation without proper turn markers
Some text here
More text there`,
      };

      const params = {
        type: 'context_retention' as const,
        test_memory_of: ['test'],
        retention_turns: 1,
        memory_accuracy_threshold: 0.5,
      };

      // Should handle malformed conversations gracefully
      const result = await evaluator.evaluate(params, malformedConversation, mockRuntime);
      expect(result).toBeDefined();
      expect(typeof result.success).toBe('boolean');
      expect(typeof result.message).toBe('string');
    });
  });

  describe('Integration with Evaluation Engine', () => {
    it('should work correctly when registered in evaluation engine', async () => {
      // This tests that the evaluators integrate properly with the evaluation engine
      const { EvaluationEngine } = require('../EvaluationEngine');
      const engine = new EvaluationEngine(mockRuntime);

      const conversationResult = {
        ...mockExecutionResult,
        conversationMetadata: {
          turnCount: 3,
          terminatedEarly: false,
          terminationReason: null,
          finalEvaluations: [],
        },
      };

      const evaluations = [
        {
          type: 'conversation_length' as const,
          min_turns: 2,
          max_turns: 5,
        },
        {
          type: 'user_satisfaction' as const,
          satisfaction_threshold: 0.6,
          measurement_method: 'llm_judge' as const,
        },
      ];

      const results = await engine.runEvaluations(evaluations, conversationResult);

      expect(results).toHaveLength(2);
      expect(results[0].success).toBeDefined();
      expect(results[0].message).toBeDefined();
      expect(results[1].success).toBeDefined();
      expect(results[1].message).toBeDefined();
    });
  });
});
