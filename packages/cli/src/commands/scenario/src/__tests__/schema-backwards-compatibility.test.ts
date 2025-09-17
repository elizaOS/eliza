// File: packages/cli/src/commands/scenario/src/__tests__/schema-backwards-compatibility.test.ts
// Comprehensive tests ensuring perfect backwards compatibility of schema extensions

import { describe, it, expect } from 'bun:test';
import { ScenarioSchema } from '../schema';

describe('Schema Backwards Compatibility', () => {
  describe('Legacy Scenario Support', () => {
    it('should validate original single-turn scenarios unchanged', () => {
      const legacyScenario = {
        name: 'Legacy Test',
        description: 'Original single-turn scenario',
        environment: {
          type: 'local' as const,
        },
        run: [
          {
            input: 'Hello agent',
            evaluations: [
              {
                type: 'string_contains' as const,
                value: 'hello',
              },
            ],
          },
        ],
        judgment: {
          strategy: 'all_pass' as const,
        },
      };

      expect(() => ScenarioSchema.parse(legacyScenario)).not.toThrow();

      const parsed = ScenarioSchema.parse(legacyScenario);
      expect(parsed.name).toBe('Legacy Test');
      expect(parsed.run[0].input).toBe('Hello agent');
      expect(parsed.run[0].conversation).toBeUndefined(); // Conversation should be optional
    });

    it('should validate scenarios with code execution steps', () => {
      const codeScenario = {
        name: 'Code Execution Test',
        description: 'Test code execution scenarios',
        environment: {
          type: 'local' as const,
        },
        run: [
          {
            name: 'Run Python script',
            lang: 'python',
            code: "print('Hello World')",
            evaluations: [
              {
                type: 'string_contains' as const,
                value: 'Hello World',
              },
            ],
          },
        ],
        judgment: {
          strategy: 'all_pass' as const,
        },
      };

      expect(() => ScenarioSchema.parse(codeScenario)).not.toThrow();

      const parsed = ScenarioSchema.parse(codeScenario);
      expect(parsed.run[0].lang).toBe('python');
      expect(parsed.run[0].code).toBe("print('Hello World')");
      expect(parsed.run[0].conversation).toBeUndefined();
    });

    it('should validate scenarios with complex evaluations', () => {
      const complexScenario = {
        name: 'Complex Evaluation Test',
        description: 'Test various evaluation types',
        environment: {
          type: 'e2b' as const,
        },
        setup: {
          mocks: [
            {
              service: 'testService',
              method: 'testMethod',
              when: {
                input: { query: 'test' },
              },
              response: { result: 'mocked' },
            },
          ],
        },
        run: [
          {
            input: 'Test complex evaluations',
            evaluations: [
              {
                type: 'string_contains' as const,
                value: 'test',
              },
              {
                type: 'regex_match' as const,
                pattern: '\\btest\\b',
              },
              {
                type: 'trajectory_contains_action' as const,
                action: 'SEARCH',
              },
              {
                type: 'llm_judge' as const,
                prompt: 'Was this helpful?',
                expected: 'yes',
                temperature: 0.1,
              },
              {
                type: 'execution_time' as const,
                max_duration_ms: 5000,
                min_duration_ms: 100,
              },
            ],
          },
        ],
        judgment: {
          strategy: 'any_pass' as const,
        },
      };

      expect(() => ScenarioSchema.parse(complexScenario)).not.toThrow();

      const parsed = ScenarioSchema.parse(complexScenario);
      expect(parsed.environment.type).toBe('e2b');
      expect(parsed.setup?.mocks).toHaveLength(1);
      expect(parsed.run[0].evaluations).toHaveLength(5);
      expect(parsed.judgment.strategy).toBe('any_pass');
    });

    it('should validate scenarios with plugins configuration', () => {
      const pluginScenario = {
        name: 'Plugin Test',
        description: 'Test plugin configurations',
        plugins: [
          '@elizaos/plugin-bootstrap',
          {
            name: '@elizaos/plugin-custom',
            version: '1.0.0',
            config: { setting: 'value' },
            enabled: true,
          },
        ],
        environment: {
          type: 'local' as const,
        },
        run: [
          {
            input: 'Test with plugins',
            evaluations: [
              {
                type: 'string_contains' as const,
                value: 'plugin',
              },
            ],
          },
        ],
        judgment: {
          strategy: 'all_pass' as const,
        },
      };

      expect(() => ScenarioSchema.parse(pluginScenario)).not.toThrow();

      const parsed = ScenarioSchema.parse(pluginScenario);
      expect(parsed.plugins).toHaveLength(2);
      expect(typeof parsed.plugins![0]).toBe('string');
      expect(typeof parsed.plugins![1]).toBe('object');
    });
  });

  describe('New Conversation Schema Validation', () => {
    it('should validate minimal conversation configuration', () => {
      const minimalConversation = {
        name: 'Minimal Conversation Test',
        description: 'Test minimal conversation setup',
        environment: {
          type: 'local' as const,
        },
        run: [
          {
            input: 'Hello',
            conversation: {
              max_turns: 3,
              user_simulator: {
                persona: 'friendly user',
                objective: 'have a chat',
              },
            },
            evaluations: [],
          },
        ],
        judgment: {
          strategy: 'all_pass' as const,
        },
      };

      expect(() => ScenarioSchema.parse(minimalConversation)).not.toThrow();

      const parsed = ScenarioSchema.parse(minimalConversation);
      expect(parsed.run[0].conversation).toBeDefined();
      expect(parsed.run[0].conversation!.max_turns).toBe(3);
      expect(parsed.run[0].conversation!.user_simulator.persona).toBe('friendly user');

      // Check default values
      expect(parsed.run[0].conversation!.timeout_per_turn_ms).toBe(30000);
      expect(parsed.run[0].conversation!.user_simulator.temperature).toBe(0.7);
      expect(parsed.run[0].conversation!.user_simulator.knowledge_level).toBe('intermediate');
    });

    it('should validate complete conversation configuration', () => {
      const fullConversation = {
        name: 'Complete Conversation Test',
        description: 'Test full conversation configuration',
        environment: {
          type: 'local' as const,
        },
        run: [
          {
            input: 'I need help',
            conversation: {
              max_turns: 5,
              timeout_per_turn_ms: 25000,
              total_timeout_ms: 180000,
              user_simulator: {
                model_type: 'TEXT_REASONING_LARGE',
                temperature: 0.8,
                max_tokens: 300,
                persona: 'frustrated customer',
                objective: 'resolve billing issue',
                style: 'impatient but cooperative',
                constraints: ['Express frustration initially', 'Become helpful when treated well'],
                emotional_state: 'frustrated',
                knowledge_level: 'beginner' as const,
              },
              termination_conditions: [
                {
                  type: 'user_expresses_satisfaction' as const,
                  keywords: ['thank you', 'resolved'],
                },
                {
                  type: 'custom_condition' as const,
                  description: 'Custom termination logic',
                  llm_judge: {
                    prompt: 'Should we terminate?',
                    threshold: 0.9,
                  },
                },
              ],
              turn_evaluations: [
                {
                  type: 'llm_judge' as const,
                  prompt: 'Was the response appropriate?',
                  expected: 'yes',
                },
              ],
              final_evaluations: [
                {
                  type: 'conversation_length' as const,
                  min_turns: 2,
                  max_turns: 8,
                  optimal_turns: 4,
                },
                {
                  type: 'user_satisfaction' as const,
                  satisfaction_threshold: 0.7,
                  measurement_method: 'llm_judge' as const,
                },
              ],
              debug_options: {
                log_user_simulation: true,
                log_turn_decisions: true,
                export_full_transcript: true,
              },
            },
            evaluations: [
              {
                type: 'string_contains' as const,
                value: 'help',
              },
            ],
          },
        ],
        judgment: {
          strategy: 'all_pass' as const,
        },
      };

      expect(() => ScenarioSchema.parse(fullConversation)).not.toThrow();

      const parsed = ScenarioSchema.parse(fullConversation);
      const conv = parsed.run[0].conversation!;

      expect(conv.max_turns).toBe(5);
      expect(conv.timeout_per_turn_ms).toBe(25000);
      expect(conv.user_simulator.temperature).toBe(0.8);
      expect(conv.user_simulator.constraints).toHaveLength(2);
      expect(conv.termination_conditions).toHaveLength(2);
      expect(conv.turn_evaluations).toHaveLength(1);
      expect(conv.final_evaluations).toHaveLength(2);
      expect(conv.debug_options.log_user_simulation).toBe(true);
    });

    it('should validate new conversation evaluation types', () => {
      const evaluationTypes = [
        {
          type: 'conversation_length' as const,
          min_turns: 2,
          max_turns: 10,
          optimal_turns: 5,
          target_range: [3, 7],
        },
        {
          type: 'conversation_flow' as const,
          required_patterns: ['question_then_answer' as const, 'problem_then_solution' as const],
          flow_quality_threshold: 0.8,
        },
        {
          type: 'user_satisfaction' as const,
          satisfaction_threshold: 0.75,
          indicators: {
            positive: ['great', 'thanks'],
            negative: ['frustrated', 'unhelpful'],
          },
          measurement_method: 'sentiment_analysis' as const,
        },
        {
          type: 'context_retention' as const,
          test_memory_of: ['user_name', 'main_issue'],
          retention_turns: 4,
          memory_accuracy_threshold: 0.85,
        },
      ];

      // Test each evaluation type individually
      evaluationTypes.forEach((evaluation, index) => {
        const scenario = {
          name: `Evaluation Test ${index}`,
          description: `Test ${evaluation.type} evaluation`,
          environment: { type: 'local' as const },
          run: [
            {
              input: 'Test',
              conversation: {
                max_turns: 3,
                user_simulator: {
                  persona: 'test user',
                  objective: 'test objective',
                },
                final_evaluations: [evaluation],
              },
              evaluations: [],
            },
          ],
          judgment: { strategy: 'all_pass' as const },
        };

        expect(() => ScenarioSchema.parse(scenario)).not.toThrow();

        const parsed = ScenarioSchema.parse(scenario);
        expect(parsed.run[0].conversation!.final_evaluations[0].type).toBe(evaluation.type);
      });
    });
  });

  describe('Mixed Mode Compatibility', () => {
    it('should support scenarios with both conversation and traditional steps', () => {
      const mixedScenario = {
        name: 'Mixed Mode Test',
        description: 'Test mixing conversation and traditional steps',
        environment: {
          type: 'local' as const,
        },
        run: [
          {
            name: 'Traditional step',
            input: 'Traditional input',
            evaluations: [
              {
                type: 'string_contains' as const,
                value: 'traditional',
              },
            ],
          },
          {
            name: 'Conversation step',
            input: 'Start conversation',
            conversation: {
              max_turns: 3,
              user_simulator: {
                persona: 'helpful user',
                objective: 'complete task',
              },
              final_evaluations: [
                {
                  type: 'user_satisfaction' as const,
                  satisfaction_threshold: 0.6,
                },
              ],
            },
            evaluations: [
              {
                type: 'string_contains' as const,
                value: 'conversation',
              },
            ],
          },
          {
            name: 'Code execution step',
            lang: 'bash',
            code: "echo 'Mixed mode works'",
            evaluations: [
              {
                type: 'string_contains' as const,
                value: 'Mixed mode works',
              },
            ],
          },
        ],
        judgment: {
          strategy: 'all_pass' as const,
        },
      };

      expect(() => ScenarioSchema.parse(mixedScenario)).not.toThrow();

      const parsed = ScenarioSchema.parse(mixedScenario);
      expect(parsed.run).toHaveLength(3);
      expect(parsed.run[0].conversation).toBeUndefined(); // Traditional step
      expect(parsed.run[1].conversation).toBeDefined(); // Conversation step
      expect(parsed.run[2].conversation).toBeUndefined(); // Code step
      expect(parsed.run[2].lang).toBe('bash');
    });
  });

  describe('Error Cases', () => {
    it('should reject invalid conversation configuration', () => {
      const invalidScenarios = [
        // max_turns too low
        {
          name: 'Invalid',
          description: 'Test',
          environment: { type: 'local' as const },
          run: [
            {
              input: 'Test',
              conversation: {
                max_turns: 1, // Should be min 2
                user_simulator: {
                  persona: 'user',
                  objective: 'objective',
                },
              },
              evaluations: [],
            },
          ],
          judgment: { strategy: 'all_pass' as const },
        },
        // max_turns too high
        {
          name: 'Invalid',
          description: 'Test',
          environment: { type: 'local' as const },
          run: [
            {
              input: 'Test',
              conversation: {
                max_turns: 25, // Should be max 20
                user_simulator: {
                  persona: 'user',
                  objective: 'objective',
                },
              },
              evaluations: [],
            },
          ],
          judgment: { strategy: 'all_pass' as const },
        },
        // Missing required persona
        {
          name: 'Invalid',
          description: 'Test',
          environment: { type: 'local' as const },
          run: [
            {
              input: 'Test',
              conversation: {
                max_turns: 3,
                user_simulator: {
                  objective: 'objective',
                  // Missing persona
                },
              },
              evaluations: [],
            },
          ],
          judgment: { strategy: 'all_pass' as const },
        },
      ];

      invalidScenarios.forEach((scenario) => {
        expect(() => ScenarioSchema.parse(scenario)).toThrow();
      });
    });

    it('should reject invalid evaluation configurations', () => {
      const invalidEvaluations = [
        // Invalid conversation_length
        {
          type: 'conversation_length' as const,
          target_range: [5], // Should be array of 2 numbers
        },
        // Invalid user_satisfaction threshold
        {
          type: 'user_satisfaction' as const,
          satisfaction_threshold: 1.5, // Should be max 1.0
        },
        // Invalid context_retention
        {
          type: 'context_retention' as const,
          test_memory_of: [], // Should not be empty
          retention_turns: 0, // Should be min 1
        },
      ];

      invalidEvaluations.forEach((evaluation, index) => {
        const scenario = {
          name: `Invalid Evaluation ${index}`,
          description: 'Test invalid evaluation',
          environment: { type: 'local' as const },
          run: [
            {
              input: 'Test',
              conversation: {
                max_turns: 3,
                user_simulator: {
                  persona: 'user',
                  objective: 'objective',
                },
                final_evaluations: [evaluation],
              },
              evaluations: [],
            },
          ],
          judgment: { strategy: 'all_pass' as const },
        };

        expect(() => ScenarioSchema.parse(scenario)).toThrow();
      });
    });
  });
});
