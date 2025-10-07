// File: packages/cli/src/commands/scenario/src/__tests__/e2e-integration.test.ts
// End-to-end integration tests for dynamic prompting system

import { describe, it, expect, beforeEach } from 'bun:test';
import { LocalEnvironmentProvider } from '../LocalEnvironmentProvider';
import { ScenarioSchema } from '../schema';
import type { Scenario } from '../schema';

describe('Dynamic Prompting E2E Integration', () => {
  let provider: LocalEnvironmentProvider;
  let mockServer: any;
  let mockRuntime: any;
  let mockTrajectoryReconstructor: any;

  beforeEach(() => {
    // Setup comprehensive mocks for E2E testing
    mockServer = {
      _mockApiResponses: new Map(),
      _responseSequence: [] as string[],
      _currentIndex: 0,

      setResponseSequence: function (responses: string[]) {
        this._responseSequence = responses;
        this._currentIndex = 0;
      },

      getNextResponse: function () {
        if (this._currentIndex < this._responseSequence.length) {
          const response = this._responseSequence[this._currentIndex];
          this._currentIndex++;
          return { response, roomId: `room-${this._currentIndex}` };
        }
        return { response: 'Default agent response', roomId: 'default-room' };
      },
    };

    mockRuntime = {
      _userResponses: [] as string[],
      _userIndex: 0,

      useModel: async (modelType: string, params: any) => {
        const prompt = params.messages[0].content.toLowerCase();

        // Handle user simulation requests
        if (prompt.includes('simulating a user') || prompt.includes('your persona')) {
          if (this._userIndex < this._userResponses.length) {
            const response = this._userResponses[this._userIndex];
            this._userIndex++;
            return response;
          }
          return 'Thank you for your help!';
        }

        // Handle evaluation requests
        if (prompt.includes('yes or no')) {
          return 'yes';
        }
        if (prompt.includes('number between 0.0 and 1.0')) {
          return '0.8';
        }

        return 'Mock LLM response';
      },

      setUserResponses: function (responses: string[]) {
        this._userResponses = responses;
        this._userIndex = 0;
      },
    };

    mockTrajectoryReconstructor = {
      getLatestTrajectory: async () => [
        {
          type: 'thought' as const,
          content: 'I need to help this user',
          timestamp: new Date().toISOString(),
        },
        {
          type: 'action' as const,
          content: 'PROVIDE_ASSISTANCE',
          timestamp: new Date(Date.now() + 100).toISOString(),
        },
      ],
    };

    // Mock askAgentViaApi with sequence support
    const originalModule = require('../runtime-factory');
    originalModule.askAgentViaApi = async (server: any, _agentId: any, input: string) => {
      return server.getNextResponse();
    };

    provider = new LocalEnvironmentProvider(mockServer, 'test-agent-123' as any, mockRuntime, 3000);
  });

  describe('Complete Conversation Scenarios', () => {
    it('should execute a complete customer support conversation end-to-end', async () => {
      const scenario: Scenario = {
        name: 'E2E Customer Support Test',
        description: 'Full customer support conversation with realistic flow',
        environment: { type: 'local' },
        run: [
          {
            name: 'Customer support conversation',
            input: "I'm having trouble with my account",
            conversation: {
              max_turns: 4,
              user_simulator: {
                persona: 'frustrated customer with account issues',
                objective: 'resolve account access problem',
                temperature: 0.7,
                max_tokens: 200,
                style: 'initially frustrated but becomes cooperative',
                constraints: [
                  'Express frustration about account access',
                  'Provide details when asked',
                  'Show appreciation for helpful responses',
                ],
                knowledge_level: 'intermediate' as const,
              },
              termination_conditions: [
                {
                  type: 'user_expresses_satisfaction',
                  keywords: ['thank you', 'resolved', 'helpful'],
                },
              ],
              final_evaluations: [
                {
                  type: 'conversation_length',
                  min_turns: 3,
                  max_turns: 5,
                },
                {
                  type: 'user_satisfaction',
                  satisfaction_threshold: 0.6,
                },
              ],
            },
            evaluations: [
              {
                type: 'string_contains',
                value: 'account',
              },
            ],
          },
        ],
        judgment: { strategy: 'all_pass' },
      };

      // Setup realistic conversation flow
      mockServer.setResponseSequence([
        "I understand you're having account troubles. Can you tell me what specific issue you're experiencing?",
        'I see the problem. Let me help you reset your account access. Please check your email for reset instructions.',
        'Perfect! Your account should be working now. Is there anything else I can help you with?',
        "You're welcome! Don't hesitate to contact us if you need further assistance.",
      ]);

      mockRuntime.setUserResponses([
        "I can't log in and I've tried multiple times. This is really frustrating!",
        'I got the email and followed the instructions. Let me try logging in now.',
        "Yes, it's working now! Thank you so much for your quick help.",
      ]);

      // Validate scenario schema
      expect(() => ScenarioSchema.parse(scenario)).not.toThrow();

      // Execute scenario
      await provider.setup(scenario);
      const results = await provider.run(scenario);

      // Validate results
      expect(results).toHaveLength(1);
      const result = results[0];

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('Turn 1:');
      expect(result.stdout).toContain('Turn 4:');
      expect((result as any).conversationMetadata).toBeDefined();
      expect((result as any).conversationMetadata.turnCount).toBe(4);
      expect((result as any).conversationMetadata.terminatedEarly).toBe(false);
      expect(result.trajectory).toHaveLength(2);
      expect(result.durationMs).toBeGreaterThan(0);
    });

    it('should handle early termination correctly', async () => {
      const scenario: Scenario = {
        name: 'Early Termination Test',
        description: 'Test conversation that terminates early',
        environment: { type: 'local' },
        run: [
          {
            input: 'I need a quick answer',
            conversation: {
              max_turns: 6,
              user_simulator: {
                persona: 'user who gets satisfied quickly',
                objective: 'get quick information',
              },
              termination_conditions: [
                {
                  type: 'user_expresses_satisfaction',
                  keywords: ['perfect', 'exactly', 'thank you'],
                },
              ],
              final_evaluations: [
                {
                  type: 'conversation_length',
                  max_turns: 4,
                },
              ],
            },
            evaluations: [],
          },
        ],
        judgment: { strategy: 'all_pass' },
      };

      mockServer.setResponseSequence([
        "I can help with that! Here's the information you need: [detailed answer]",
        "You're very welcome! Glad I could help quickly.",
      ]);

      mockRuntime.setUserResponses(["Perfect! That's exactly what I needed. Thank you!"]);

      await provider.setup(scenario);
      const results = await provider.run(scenario);

      expect(results).toHaveLength(1);
      const result = results[0];

      expect((result as any).conversationMetadata.turnCount).toBe(2);
      expect((result as any).conversationMetadata.terminatedEarly).toBe(true);
      expect((result as any).conversationMetadata.terminationReason).toBe(
        'user_expresses_satisfaction'
      );
    });

    it('should handle mixed legacy and conversation steps', async () => {
      const mixedScenario: Scenario = {
        name: 'Mixed Mode E2E Test',
        description: 'Mix legacy single-turn and conversation steps',
        environment: { type: 'local' },
        run: [
          {
            name: 'Legacy single-turn step',
            input: 'Single turn request',
            evaluations: [
              {
                type: 'string_contains',
                value: 'Single',
              },
            ],
          },
          {
            name: 'Conversation step',
            input: 'Start conversation',
            conversation: {
              max_turns: 2,
              user_simulator: {
                persona: 'brief user',
                objective: 'quick interaction',
              },
            },
            evaluations: [
              {
                type: 'string_contains',
                value: 'conversation',
              },
            ],
          },
          {
            name: 'Another legacy step',
            lang: 'bash',
            code: "echo 'Legacy code execution'",
            evaluations: [
              {
                type: 'string_contains',
                value: 'Legacy code execution',
              },
            ],
          },
        ],
        judgment: { strategy: 'all_pass' },
      };

      mockServer.setResponseSequence([
        'Response to single turn request',
        'Starting conversation response',
        'Conversation continuation',
      ]);

      mockRuntime.setUserResponses(['Thanks for starting the conversation!']);

      await provider.setup(mixedScenario);
      const results = await provider.run(mixedScenario);

      expect(results).toHaveLength(3);

      // First result: single-turn (no conversation metadata)
      expect((results[0] as any).conversationMetadata).toBeUndefined();
      expect(results[0].stdout).toContain('Response to single turn request');

      // Second result: conversation (has metadata)
      expect((results[1] as any).conversationMetadata).toBeDefined();
      expect((results[1] as any).conversationMetadata.turnCount).toBe(2);
      expect(results[1].stdout).toContain('Turn 1:');

      // Third result: code execution (no conversation metadata)
      expect((results[2] as any).conversationMetadata).toBeUndefined();
      expect(results[2].stdout).toContain('Legacy code execution');
    });
  });

  describe('Advanced Conversation Features', () => {
    it('should handle complex termination conditions', async () => {
      const scenario: Scenario = {
        name: 'Complex Termination Test',
        description: 'Test multiple termination conditions',
        environment: { type: 'local' },
        run: [
          {
            input: 'Complex issue that might need escalation',
            conversation: {
              max_turns: 8,
              user_simulator: {
                persona: 'user with complex issue',
                objective: 'resolve complex problem or get escalated',
              },
              termination_conditions: [
                {
                  type: 'agent_provides_solution',
                  keywords: ['solution', 'fix', 'resolve'],
                },
                {
                  type: 'escalation_needed',
                  keywords: ['escalate', 'supervisor', 'specialist'],
                },
                {
                  type: 'custom_condition',
                  llm_judge: {
                    prompt: 'Has the issue been adequately addressed?',
                    threshold: 0.8,
                  },
                },
              ],
              final_evaluations: [
                {
                  type: 'user_satisfaction',
                  satisfaction_threshold: 0.7,
                },
              ],
            },
            evaluations: [],
          },
        ],
        judgment: { strategy: 'all_pass' },
      };

      mockServer.setResponseSequence([
        'I understand this is a complex issue. Let me investigate further.',
        "This requires specialist attention. I'm escalating this to our technical team.",
        'A specialist will contact you within 24 hours to resolve this.',
      ]);

      mockRuntime.setUserResponses([
        "The issue is quite complicated and I've tried basic troubleshooting.",
        "Okay, I appreciate that you're escalating it to someone who can help better.",
      ]);

      // Mock LLM judge to return positive evaluation
      const originalUseModel = mockRuntime.useModel;
      mockRuntime.useModel = async (modelType: string, params: any) => {
        const prompt = params.messages[0].content.toLowerCase();
        if (prompt.includes('adequately addressed')) {
          return 'yes'; // Custom termination condition met
        }
        return originalUseModel.call(mockRuntime, modelType, params);
      };

      await provider.setup(scenario);
      const results = await provider.run(scenario);

      expect(results).toHaveLength(1);
      const result = results[0];

      expect((result as any).conversationMetadata.terminatedEarly).toBe(true);
      expect(['escalation_needed', 'custom_condition']).toContain(
        (result as any).conversationMetadata.terminationReason
      );
    });

    it('should handle evaluation failures gracefully', async () => {
      const scenario: Scenario = {
        name: 'Evaluation Failure Test',
        description: 'Test handling of evaluation failures',
        environment: { type: 'local' },
        run: [
          {
            input: 'Test evaluation failures',
            conversation: {
              max_turns: 2,
              user_simulator: {
                persona: 'test user',
                objective: 'test evaluations',
              },
              final_evaluations: [
                {
                  type: 'conversation_length',
                  min_turns: 5, // This will fail - conversation is only 2 turns
                  max_turns: 8,
                },
                {
                  type: 'user_satisfaction',
                  satisfaction_threshold: 0.9, // This might fail with high threshold
                },
              ],
            },
            evaluations: [],
          },
        ],
        judgment: { strategy: 'all_pass' },
      };

      mockServer.setResponseSequence(['Test response 1', 'Test response 2']);

      mockRuntime.setUserResponses(['Test user response']);

      await provider.setup(scenario);
      const results = await provider.run(scenario);

      expect(results).toHaveLength(1);
      const result = results[0];

      // Should complete despite evaluation failures
      expect((result as any).conversationMetadata.turnCount).toBe(2);
      expect(result.exitCode).toBe(1); // Failed due to evaluations
      expect((result as any).conversationMetadata.finalEvaluations).toBeDefined();
    });

    it('should handle LLM failures during conversation', async () => {
      const scenario: Scenario = {
        name: 'LLM Failure Test',
        description: 'Test handling of LLM failures',
        environment: { type: 'local' },
        run: [
          {
            input: 'Test LLM failure handling',
            conversation: {
              max_turns: 3,
              user_simulator: {
                persona: 'test user',
                objective: 'test error handling',
              },
            },
            evaluations: [],
          },
        ],
        judgment: { strategy: 'all_pass' },
      };

      mockServer.setResponseSequence(['Initial response', 'Second response']);

      // Mock LLM failure for user simulation
      let callCount = 0;
      mockRuntime.useModel = async (modelType: string, params: any) => {
        callCount++;
        if (callCount === 1) {
          throw new Error('Simulated LLM failure');
        }
        return 'Fallback user response after LLM failure';
      };

      await provider.setup(scenario);

      // Should handle LLM failure gracefully
      try {
        const results = await provider.run(scenario);

        // If it doesn't throw, the conversation should still have some results
        expect(results).toHaveLength(1);
      } catch (error: any) {
        // If it throws, it should be a conversation execution failure
        expect(error.message).toContain('Conversation execution failed');
      }
    });
  });

  describe('Performance and Resource Management', () => {
    it('should complete conversations within reasonable time limits', async () => {
      const scenario: Scenario = {
        name: 'Performance Test',
        description: 'Test conversation performance',
        environment: { type: 'local' },
        run: [
          {
            input: 'Performance test conversation',
            conversation: {
              max_turns: 5,
              timeout_per_turn_ms: 10000, // 10 second per turn limit
              total_timeout_ms: 60000, // 1 minute total limit
              user_simulator: {
                persona: 'efficient user',
                objective: 'complete conversation quickly',
              },
              final_evaluations: [
                {
                  type: 'conversation_length',
                  max_turns: 6,
                },
              ],
            },
            evaluations: [],
          },
        ],
        judgment: { strategy: 'all_pass' },
      };

      mockServer.setResponseSequence([
        'Quick response 1',
        'Quick response 2',
        'Quick response 3',
        'Quick response 4',
        'Final quick response',
      ]);

      mockRuntime.setUserResponses([
        'Quick user response 1',
        'Quick user response 2',
        'Quick user response 3',
        'Final user response',
      ]);

      const startTime = Date.now();

      await provider.setup(scenario);
      const results = await provider.run(scenario);

      const endTime = Date.now();
      const totalTime = endTime - startTime;

      expect(results).toHaveLength(1);
      expect(totalTime).toBeLessThan(60000); // Should complete within 1 minute
      expect((results[0] as any).conversationMetadata.turnCount).toBe(5);
      expect(results[0].durationMs).toBeGreaterThan(0);
      expect(results[0].durationMs).toBeLessThan(60000);
    });

    it('should handle memory efficiently for longer conversations', async () => {
      const scenario: Scenario = {
        name: 'Memory Efficiency Test',
        description: 'Test memory usage in longer conversations',
        environment: { type: 'local' },
        run: [
          {
            input: 'Long conversation test',
            conversation: {
              max_turns: 8,
              user_simulator: {
                persona: 'chatty user who provides detailed responses',
                objective: 'have extended conversation',
              },
            },
            evaluations: [],
          },
        ],
        judgment: { strategy: 'all_pass' },
      };

      // Generate longer responses to test memory usage
      const longResponse =
        'This is a longer response that contains more text to test memory usage. '.repeat(10);

      mockServer.setResponseSequence(Array(8).fill(longResponse));
      mockRuntime.setUserResponses(Array(7).fill(longResponse));

      const initialMemory = process.memoryUsage().heapUsed;

      await provider.setup(scenario);
      const results = await provider.run(scenario);

      const finalMemory = process.memoryUsage().heapUsed;
      const memoryIncrease = finalMemory - initialMemory;

      expect(results).toHaveLength(1);
      expect((results[0] as any).conversationMetadata.turnCount).toBe(8);

      // Memory increase should be reasonable (less than 50MB for this test)
      expect(memoryIncrease).toBeLessThan(50 * 1024 * 1024);
    });
  });

  describe('Backwards Compatibility Validation', () => {
    it('should execute legacy scenarios unchanged in mixed environment', async () => {
      const legacyScenario: Scenario = {
        name: 'Legacy Scenario in New System',
        description: 'Ensure legacy scenarios work in new system',
        environment: { type: 'local' },
        run: [
          {
            input: 'Legacy single-turn request',
            evaluations: [
              {
                type: 'string_contains',
                value: 'Legacy',
              },
              {
                type: 'llm_judge',
                prompt: 'Was this handled correctly?',
                expected: 'yes',
              },
            ],
          },
        ],
        judgment: { strategy: 'all_pass' },
      };

      mockServer.setResponseSequence(['Legacy single-turn response handled correctly']);

      await provider.setup(legacyScenario);
      const results = await provider.run(legacyScenario);

      expect(results).toHaveLength(1);
      expect(results[0].exitCode).toBe(0);
      expect(results[0].stdout).toContain('Legacy single-turn response');
      expect((results[0] as any).conversationMetadata).toBeUndefined();
      expect(results[0].trajectory).toBeDefined();
    });
  });
});
