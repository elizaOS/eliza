// File: packages/cli/src/commands/scenario/src/__tests__/ConversationManager.test.ts
// Integration tests for ConversationManager class

import { describe, it, expect, beforeEach } from 'bun:test';
import { ConversationManager } from '../ConversationManager';
import type { ConversationConfig } from '../conversation-types';

describe('ConversationManager', () => {
  const REAL_AGENT_ID = '54334a5c-cbd8-0f1f-a083-f5d48d8a7b82'; // Real agent from running server
  let mockRuntime: any;
  let mockServer: any;
  let mockTrajectoryReconstructor: any;
  let conversationManager: ConversationManager;
  let basicConfig: ConversationConfig;

  beforeEach(() => {
    // Mock AgentRuntime
    mockRuntime = {
      useModel: async () => 'Mock LLM response',
      _callHistory: [],
      _setMockResponse: function (response: string) {
        this.useModel = async () => response;
      },
    };

    // Mock AgentServer
    mockServer = {
      _mockApiResponses: new Map(),
      setMockApiResponse: function (response: string, roomId: string = 'mock-room-123') {
        this._mockApiResponses.set('latest', { response, roomId });
      },
    };

    // Mock TrajectoryReconstructor
    mockTrajectoryReconstructor = {
      _mockTrajectories: new Map(),
      getLatestTrajectory: async function (roomId: string) {
        return (
          this._mockTrajectories.get(roomId) || [
            {
              type: 'thought' as const,
              content: 'I should help the user with their request',
              timestamp: new Date().toISOString(),
            },
            {
              type: 'action' as const,
              content: 'SEARCH_KNOWLEDGE',
              timestamp: new Date(Date.now() + 100).toISOString(),
            },
          ]
        );
      },
      setMockTrajectory: function (roomId: string, trajectory: any[]) {
        this._mockTrajectories.set(roomId, trajectory);
      },
    };

    conversationManager = new ConversationManager(
      mockRuntime,
      mockServer,
      REAL_AGENT_ID as any,
      3000,
      mockTrajectoryReconstructor
    );

    basicConfig = {
      max_turns: 3,
      timeout_per_turn_ms: 30000,
      total_timeout_ms: 300000,
      user_simulator: {
        model_type: 'TEXT_LARGE',
        temperature: 0.7,
        max_tokens: 200,
        persona: 'helpful customer',
        objective: 'get account help',
        style: 'polite',
        constraints: [],
        knowledge_level: 'intermediate' as const,
      },
      termination_conditions: [],
      turn_evaluations: [],
      final_evaluations: [],
      debug_options: {
        log_user_simulation: false,
        log_turn_decisions: false,
        export_full_transcript: true,
      },
    };

    // We'll use the actual askAgentViaApi function for integration testing
  });

  describe('Initialization', () => {
    it('should initialize conversation manager with valid parameters', () => {
      expect(conversationManager).toBeDefined();
    });

    it('should handle conversation manager creation with all dependencies', () => {
      const manager = new ConversationManager(
        mockRuntime,
        mockServer,
        REAL_AGENT_ID as any,
        8080,
        mockTrajectoryReconstructor
      );
      expect(manager).toBeDefined();
    });
  });

  describe('Basic Conversation Execution', () => {
    it('should execute a minimal 2-turn conversation', async () => {
      mockServer.setMockApiResponse('Hello! How can I help you today?');
      mockRuntime._setMockResponse('I need help with my billing account');

      const result = await conversationManager.executeConversation('Hi, I need help', {
        ...basicConfig,
        max_turns: 2,
      });

      expect(result).toBeDefined();
      expect(result.turns).toHaveLength(2);
      expect(result.totalDuration).toBeGreaterThan(0);
      expect(result.conversationTranscript).toContain('Turn 1:');
      expect(result.conversationTranscript).toContain('Turn 2:');
      expect(result.success).toBe(true);
    });

    it('should handle conversation with specified number of turns', async () => {
      mockServer.setMockApiResponse('I can help with that!');
      mockRuntime._setMockResponse('Great, thank you!');

      const result = await conversationManager.executeConversation('Start conversation', {
        ...basicConfig,
        max_turns: 3,
      });

      expect(result.turns).toHaveLength(3);
      expect(result.terminatedEarly).toBe(false);
      expect(result.terminationReason).toBeNull();
    });

    it('should generate transcript in correct format', async () => {
      mockServer.setMockApiResponse('Agent response');
      mockRuntime._setMockResponse('User follow-up');

      const result = await conversationManager.executeConversation('Initial message', {
        ...basicConfig,
        max_turns: 2,
      });

      const transcript = result.conversationTranscript;
      expect(transcript).toMatch(/Turn 1:\nUser: Initial message\nAgent: Agent response/);
      expect(transcript).toMatch(/Turn 2:\nUser: User follow-up\nAgent: Agent response/);
    });

    it('should track conversation timing accurately', async () => {
      const startTime = Date.now();

      mockServer.setMockApiResponse('Quick response');
      mockRuntime._setMockResponse('Quick user response');

      const result = await conversationManager.executeConversation('Time test', {
        ...basicConfig,
        max_turns: 2,
      });

      const endTime = Date.now();

      expect(result.totalDuration).toBeGreaterThan(0);
      expect(result.totalDuration).toBeLessThan(endTime - startTime + 1000); // Allow some buffer

      // Each turn should have duration
      result.turns.forEach((turn) => {
        expect(turn.duration).toBeGreaterThan(0);
        expect(turn.executionResult.durationMs).toBeGreaterThan(0);
      });
    });
  });

  describe('Termination Conditions', () => {
    it('should terminate on user satisfaction keywords', async () => {
      mockServer.setMockApiResponse('Here is the solution to your problem');
      mockRuntime._setMockResponse('Perfect! Thank you so much, that resolved my issue!');

      const result = await conversationManager.executeConversation('I have a problem', {
        ...basicConfig,
        max_turns: 5,
        termination_conditions: [
          {
            type: 'user_expresses_satisfaction',
            keywords: ['thank you', 'perfect', 'resolved'],
          },
        ],
      });

      expect(result.turns.length).toBeLessThan(5); // Should terminate early
      expect(result.terminatedEarly).toBe(true);
      expect(result.terminationReason).toBe('user_expresses_satisfaction');
    });

    it('should terminate on agent solution keywords', async () => {
      mockServer.setMockApiResponse('Here is the solution: try this approach');
      mockRuntime._setMockResponse('I will try that approach');

      const result = await conversationManager.executeConversation('Need help', {
        ...basicConfig,
        max_turns: 4,
        termination_conditions: [
          {
            type: 'agent_provides_solution',
            keywords: ['solution', 'try this'],
          },
        ],
      });

      expect(result.terminatedEarly).toBe(true);
      expect(result.terminationReason).toBe('agent_provides_solution');
    });

    it('should detect conversation getting stuck', async () => {
      // Mock repetitive agent responses
      let callCount = 0;
      const originalAskAgent = require('../runtime-factory').askAgentViaApi;
      require('../runtime-factory').askAgentViaApi = async () => {
        callCount++;
        return {
          response: 'I can help you with that issue', // Same response every time
          roomId: 'mock-room',
        };
      };

      mockRuntime._setMockResponse('Still having the same problem');

      const result = await conversationManager.executeConversation('I need help', {
        ...basicConfig,
        max_turns: 5,
        termination_conditions: [
          {
            type: 'conversation_stuck',
          },
        ],
      });

      // Restore original function
      require('../runtime-factory').askAgentViaApi = originalAskAgent;

      expect(result.turns.length).toBeGreaterThanOrEqual(3); // Need at least 3 turns to detect stuck
      expect(result.terminatedEarly).toBe(true);
      expect(result.terminationReason).toBe('conversation_stuck');
    });

    it('should handle custom LLM judge termination conditions', async () => {
      mockServer.setMockApiResponse('The issue has been completely resolved');
      mockRuntime._setMockResponse('Excellent, everything is working now');

      // Mock LLM judge to return 'yes' for termination
      const originalUseModel = mockRuntime.useModel;
      mockRuntime.useModel = async (modelType: any, params: any) => {
        if (params.messages[0].content.includes('Should this conversation be terminated')) {
          return 'yes';
        }
        return originalUseModel(modelType, params);
      };

      const result = await conversationManager.executeConversation('Fix my issue', {
        ...basicConfig,
        max_turns: 4,
        termination_conditions: [
          {
            type: 'custom_condition',
            llm_judge: {
              prompt: "Has the user's issue been completely resolved?",
              threshold: 0.8,
            },
          },
        ],
      });

      expect(result.terminatedEarly).toBe(true);
      expect(result.terminationReason).toBe('custom_condition');
    });

    it('should continue to max turns when no termination conditions met', async () => {
      mockServer.setMockApiResponse('I am still working on your request');
      mockRuntime._setMockResponse('Ok, please continue');

      const result = await conversationManager.executeConversation('Complex issue', {
        ...basicConfig,
        max_turns: 3,
        termination_conditions: [
          {
            type: 'user_expresses_satisfaction',
            keywords: ['completely satisfied', 'perfect solution'], // Very specific keywords
          },
        ],
      });

      expect(result.turns).toHaveLength(3);
      expect(result.terminatedEarly).toBe(false);
      expect(result.terminationReason).toBeNull();
    });
  });

  describe('Turn and Final Evaluations', () => {
    it('should run turn-level evaluations for each turn', async () => {
      mockServer.setMockApiResponse('Helpful agent response');
      mockRuntime._setMockResponse('User response');

      // Mock evaluation engine
      const mockEvaluations = [{ success: true, message: 'Turn evaluation passed' }];

      const originalEvaluationEngine = require('../EvaluationEngine').EvaluationEngine;
      const mockEvaluationEngineConstructor = class {
        async runEvaluations() {
          return mockEvaluations;
        }
      };
      require('../EvaluationEngine').EvaluationEngine = mockEvaluationEngineConstructor;

      const result = await conversationManager.executeConversation('Test evaluations', {
        ...basicConfig,
        max_turns: 2,
        turn_evaluations: [
          {
            type: 'llm_judge',
            prompt: 'Was this turn helpful?',
            expected: 'yes',
          },
        ],
      });

      // Restore original
      require('../EvaluationEngine').EvaluationEngine = originalEvaluationEngine;

      expect(result.turns[0].turnEvaluations).toEqual(mockEvaluations);
      expect(result.turns[1].turnEvaluations).toEqual(mockEvaluations);
    });

    it('should run final evaluations on complete conversation', async () => {
      mockServer.setMockApiResponse('Final agent response');
      mockRuntime._setMockResponse('Final user response');

      const mockFinalEvaluations = [
        { success: true, message: 'Conversation was successful' },
        { success: true, message: 'User satisfaction was high' },
      ];

      const originalEvaluationEngine = require('../EvaluationEngine').EvaluationEngine;
      const mockEvaluationEngineConstructor = class {
        async runEvaluations() {
          return mockFinalEvaluations;
        }
      };
      require('../EvaluationEngine').EvaluationEngine = mockEvaluationEngineConstructor;

      const result = await conversationManager.executeConversation('Final evaluation test', {
        ...basicConfig,
        max_turns: 2,
        final_evaluations: [
          {
            type: 'user_satisfaction',
            satisfaction_threshold: 0.7,
          },
          {
            type: 'conversation_length',
            optimal_turns: 2,
          },
        ],
      });

      // Restore original
      require('../EvaluationEngine').EvaluationEngine = originalEvaluationEngine;

      expect(result.finalEvaluations).toEqual(mockFinalEvaluations);
    });

    it('should determine overall success based on evaluations', async () => {
      mockServer.setMockApiResponse('Good response');
      mockRuntime._setMockResponse('Satisfied response');

      // Test successful evaluations
      const originalEvaluationEngine = require('../EvaluationEngine').EvaluationEngine;
      const successfulEvaluationEngine = class {
        async runEvaluations() {
          return [{ success: true, message: 'All good' }];
        }
      };
      require('../EvaluationEngine').EvaluationEngine = successfulEvaluationEngine;

      const successResult = await conversationManager.executeConversation('Success test', {
        ...basicConfig,
        max_turns: 1,
        final_evaluations: [
          {
            type: 'user_satisfaction',
            satisfaction_threshold: 0.5,
          },
        ],
      });

      expect(successResult.success).toBe(true);

      // Test failed evaluations
      const failedEvaluationEngine = class {
        async runEvaluations() {
          return [{ success: false, message: 'Failed evaluation' }];
        }
      };
      require('../EvaluationEngine').EvaluationEngine = failedEvaluationEngine;

      const failResult = await conversationManager.executeConversation('Fail test', {
        ...basicConfig,
        max_turns: 1,
        final_evaluations: [
          {
            type: 'user_satisfaction',
            satisfaction_threshold: 0.9,
          },
        ],
      });

      expect(failResult.success).toBe(false);

      // Restore original
      require('../EvaluationEngine').EvaluationEngine = originalEvaluationEngine;
    });
  });

  describe('Error Handling', () => {
    it('should handle agent API failures gracefully', async () => {
      const originalAskAgent = require('../runtime-factory').askAgentViaApi;
      require('../runtime-factory').askAgentViaApi = async () => {
        throw new Error('Agent API failure');
      };

      try {
        await conversationManager.executeConversation('Error test', {
          ...basicConfig,
          max_turns: 2,
        });

        // Should not reach here
        expect(false).toBe(true);
      } catch (error: any) {
        expect(error.message).toContain('Conversation execution failed');
      } finally {
        // Restore original
        require('../runtime-factory').askAgentViaApi = originalAskAgent;
      }
    });

    it('should handle user simulation failures', async () => {
      mockServer.setMockApiResponse('Agent response');

      // Mock user simulator failure
      mockRuntime._setMockResponse = function () {
        this.useModel = async () => {
          throw new Error('User simulation failed');
        };
      };
      mockRuntime._setMockResponse('');

      try {
        await conversationManager.executeConversation('Simulation error test', {
          ...basicConfig,
          max_turns: 2,
        });

        // Should not reach here
        expect(false).toBe(true);
      } catch (error: any) {
        expect(error.message).toContain('Conversation execution failed');
      }
    });

    it('should handle trajectory reconstruction failures gracefully', async () => {
      mockServer.setMockApiResponse('Response');
      mockRuntime._setMockResponse('User response');

      mockTrajectoryReconstructor.getLatestTrajectory = async () => {
        throw new Error('Trajectory reconstruction failed');
      };

      const result = await conversationManager.executeConversation('Trajectory error test', {
        ...basicConfig,
        max_turns: 1,
      });

      // Should still complete the conversation, just without trajectory data
      expect(result).toBeDefined();
      expect(result.turns).toHaveLength(1);
    });
  });

  describe('Debug and Logging', () => {
    it('should log conversation progress when debug enabled', async () => {
      mockServer.setMockApiResponse('Debug response');
      mockRuntime._setMockResponse('Debug user response');

      const originalConsoleLog = console.log;
      const logCalls: any[][] = [];
      console.log = (...args) => {
        logCalls.push(args);
        originalConsoleLog(...args);
      };

      try {
        await conversationManager.executeConversation('Debug test', {
          ...basicConfig,
          max_turns: 2,
          debug_options: {
            log_user_simulation: true,
            log_turn_decisions: true,
            export_full_transcript: true,
          },
        });

        expect(logCalls.length).toBeGreaterThan(0);
        expect(
          logCalls.some((call) =>
            call[0]?.includes?.('[ConversationManager] Starting conversation')
          )
        ).toBe(true);
        expect(logCalls.some((call) => call[0]?.includes?.('=== TURN'))).toBe(true);
      } finally {
        console.log = originalConsoleLog;
      }
    });

    it('should include trajectory data in conversation results', async () => {
      const mockTrajectory = [
        {
          type: 'thought' as const,
          content: 'User needs help',
          timestamp: new Date().toISOString(),
        },
        {
          type: 'action' as const,
          content: 'SEARCH',
          timestamp: new Date(Date.now() + 100).toISOString(),
        },
      ];

      mockServer.setMockApiResponse('Response with trajectory');
      mockRuntime._setMockResponse('User response');
      mockTrajectoryReconstructor.setMockTrajectory('mock-room-123', mockTrajectory);

      const result = await conversationManager.executeConversation('Trajectory test', {
        ...basicConfig,
        max_turns: 1,
      });

      expect(result.turns[0].trajectory).toEqual(mockTrajectory);
      expect(result.turns[0].executionResult.trajectory).toEqual(mockTrajectory);
    });
  });
});
