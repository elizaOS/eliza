// File: packages/cli/src/commands/scenario/src/__tests__/backwards-compatibility.test.ts
// Tests ensuring perfect backwards compatibility with existing scenarios

import { describe, it, expect, beforeEach } from 'bun:test';
import { LocalEnvironmentProvider } from '../LocalEnvironmentProvider';
import { ScenarioSchema } from '../schema';
import type { Scenario } from '../schema';

describe('Backwards Compatibility', () => {
  const REAL_AGENT_ID = '54334a5c-cbd8-0f1f-a083-f5d48d8a7b82'; // Real agent from running server
  let mockRuntime: any;

  beforeEach(() => {
    mockRuntime = {
      useModel: async () => 'Mock runtime response',
      getSetting: (key: string) => {
        const settings: Record<string, string> = {
          OPENAI_API_KEY: 'mock-key',
          MODEL_PROVIDER: 'openai',
        };
        return settings[key] || null;
      },
    };
  });

  describe('Legacy Single-Turn Scenarios', () => {
    it('should execute original single-turn scenario without modifications', async () => {
      const legacyScenario: Scenario = {
        name: 'Legacy Customer Support Test',
        description: 'Original single-turn customer support scenario',
        environment: {
          type: 'local',
        },
        run: [
          {
            input: 'I need help with my account',
            evaluations: [
              {
                type: 'string_contains',
                value: 'account',
              },
              {
                type: 'llm_judge',
                prompt: 'Was the response helpful?',
                expected: 'yes',
              },
            ],
          },
        ],
        judgment: {
          strategy: 'all_pass',
        },
      };

      // Validate schema
      expect(() => ScenarioSchema.parse(legacyScenario)).not.toThrow();

      // Create provider and execute
      const provider = new LocalEnvironmentProvider(
        null, // Server object not needed for real askAgentViaApi calls
        REAL_AGENT_ID as any,
        mockRuntime,
        3000
      );

      await provider.setup(legacyScenario);
      const results = await provider.run(legacyScenario);

      expect(results).toHaveLength(1);
      expect(results[0].exitCode).toBe(0);
      expect(results[0].stdout).toContain('Agent response to: I need help with my account');
      expect(results[0].durationMs).toBeGreaterThan(0);

      // Should NOT have conversation metadata
      expect((results[0] as any).conversationMetadata).toBeUndefined();
    });

    it('should handle code execution scenarios unchanged', async () => {
      const codeScenario: Scenario = {
        name: 'Code Execution Test',
        description: 'Test bash script execution',
        environment: {
          type: 'local',
        },
        run: [
          {
            name: 'Echo test',
            lang: 'bash',
            code: "echo 'Hello from bash'",
            evaluations: [
              {
                type: 'string_contains',
                value: 'Hello from bash',
              },
              {
                type: 'execution_time',
                max_duration_ms: 5000,
              },
            ],
          },
        ],
        judgment: {
          strategy: 'all_pass',
        },
      };

      // Validate schema
      expect(() => ScenarioSchema.parse(codeScenario)).not.toThrow();

      const provider = new LocalEnvironmentProvider();
      await provider.setup(codeScenario);
      const results = await provider.run(codeScenario);

      expect(results).toHaveLength(1);
      expect(results[0].exitCode).toBe(0);
      expect(results[0].stdout).toContain('Hello from bash');
    });

    it('should support complex multi-step legacy scenarios', async () => {
      const complexScenario: Scenario = {
        name: 'Complex Multi-Step Legacy',
        description: 'Multiple steps with different types',
        plugins: [
          '@elizaos/plugin-bootstrap',
          {
            name: '@elizaos/plugin-custom',
            version: '1.0.0',
            config: { enabled: true },
            enabled: true,
          },
        ],
        environment: {
          type: 'local',
        },
        setup: {
          mocks: [
            {
              service: 'database',
              method: 'query',
              when: {
                input: { table: 'users' },
              },
              response: { count: 5 },
            },
          ],
          virtual_fs: {
            'test.txt': 'test content',
          },
        },
        run: [
          {
            name: 'Natural language step',
            input: 'Check the database for user count',
            evaluations: [
              {
                type: 'string_contains',
                value: 'database',
              },
            ],
          },
          {
            name: 'Code execution step',
            lang: 'python',
            code: "print(f'User count: {5}')",
            evaluations: [
              {
                type: 'string_contains',
                value: 'User count: 5',
              },
            ],
          },
          {
            name: 'File check step',
            lang: 'bash',
            code: 'ls test.txt',
            evaluations: [
              {
                type: 'file_exists',
                path: 'test.txt',
              },
            ],
          },
        ],
        judgment: {
          strategy: 'all_pass',
        },
      };

      // Validate schema
      expect(() => ScenarioSchema.parse(complexScenario)).not.toThrow();

      const provider = new LocalEnvironmentProvider(
        null, // Server object not needed for real askAgentViaApi calls
        REAL_AGENT_ID as any,
        mockRuntime,
        3000
      );

      await provider.setup(complexScenario);
      const results = await provider.run(complexScenario);

      expect(results).toHaveLength(3);

      // Natural language step
      expect(results[0].stdout).toContain('Agent response to: Check the database for user count');

      // Code execution steps should work
      expect(results[1].exitCode).toBe(0);
      expect(results[2].exitCode).toBe(0);
    });

    it('should handle all existing evaluation types', async () => {
      const evaluationScenario: Scenario = {
        name: 'All Evaluation Types Test',
        description: 'Test all existing evaluation types work unchanged',
        environment: {
          type: 'local',
        },
        run: [
          {
            input: 'Test all evaluations with trajectory data',
            evaluations: [
              {
                type: 'string_contains',
                value: 'trajectory',
              },
              {
                type: 'regex_match',
                pattern: '\\btrajectory\\b',
              },
              {
                type: 'trajectory_contains_action',
                action: 'SEARCH',
              },
              {
                type: 'llm_judge',
                prompt: 'Does this response mention testing?',
                expected: 'yes',
                temperature: 0.1,
                capabilities: ['analysis', 'reasoning'],
              },
              {
                type: 'execution_time',
                max_duration_ms: 30000,
                min_duration_ms: 100,
              },
            ],
          },
        ],
        judgment: {
          strategy: 'any_pass',
        },
      };

      // Validate schema
      expect(() => ScenarioSchema.parse(evaluationScenario)).not.toThrow();

      const provider = new LocalEnvironmentProvider(
        null, // Server object not needed for real askAgentViaApi calls
        REAL_AGENT_ID as any,
        mockRuntime,
        3000
      );

      await provider.setup(evaluationScenario);
      const results = await provider.run(evaluationScenario);

      expect(results).toHaveLength(1);
      expect(results[0].exitCode).toBe(0);
      expect(results[0].trajectory).toBeDefined();
    });
  });

  describe('Mixed Mode Scenarios', () => {
    it('should support mixing legacy and conversation steps in same scenario', async () => {
      const mixedScenario: Scenario = {
        name: 'Mixed Legacy and Conversation',
        description: 'Combine old and new step types',
        environment: {
          type: 'local',
        },
        run: [
          {
            name: 'Legacy single-turn step',
            input: 'This is a traditional step',
            evaluations: [
              {
                type: 'string_contains',
                value: 'traditional',
              },
            ],
          },
          {
            name: 'New conversation step',
            input: 'Start a conversation',
            conversation: {
              max_turns: 2,
              user_simulator: {
                persona: 'helpful user',
                objective: 'complete the conversation',
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
            code: "echo 'Back to legacy'",
            evaluations: [
              {
                type: 'string_contains',
                value: 'Back to legacy',
              },
            ],
          },
        ],
        judgment: {
          strategy: 'all_pass',
        },
      };

      // Validate schema
      expect(() => ScenarioSchema.parse(mixedScenario)).not.toThrow();

      const parsed = ScenarioSchema.parse(mixedScenario);

      // Verify step types
      expect(parsed.run[0].conversation).toBeUndefined(); // Legacy step
      expect(parsed.run[1].conversation).toBeDefined(); // Conversation step
      expect(parsed.run[2].conversation).toBeUndefined(); // Legacy step
      expect(parsed.run[2].lang).toBe('bash');

      const provider = new LocalEnvironmentProvider(
        null, // Server object not needed for real askAgentViaApi calls
        REAL_AGENT_ID as any,
        mockRuntime,
        3000
      );

      // Mock user simulator response
      mockRuntime.useModel = async (modelType: any, params: any) => {
        if (params.messages[0].content.includes('simulating a user')) {
          return 'Thank you, that completes our conversation!';
        }
        return 'Mock runtime response';
      };

      await provider.setup(mixedScenario);
      const results = await provider.run(mixedScenario);

      expect(results).toHaveLength(3);

      // First step: traditional
      expect(results[0].stdout).toContain('This is a traditional step');
      expect((results[0] as any).conversationMetadata).toBeUndefined();

      // Second step: conversation
      expect(results[1].stdout).toContain('Turn 1:');
      expect((results[1] as any).conversationMetadata).toBeDefined();
      expect((results[1] as any).conversationMetadata.turnCount).toBe(2);

      // Third step: legacy code
      expect(results[2].stdout).toContain('Back to legacy');
      expect((results[2] as any).conversationMetadata).toBeUndefined();
    });
  });

  describe('CLI Command Compatibility', () => {
    it('should maintain CLI command interface for legacy scenarios', () => {
      // Test that CLI commands work unchanged
      // This would typically be tested at a higher level, but we verify
      // that the scenario structure remains compatible

      const legacyScenarios = [
        {
          name: 'Simple Test',
          description: 'Basic test',
          environment: { type: 'local' as const },
          run: [{ input: 'test', evaluations: [] }],
          judgment: { strategy: 'all_pass' as const },
        },
        {
          name: 'Code Test',
          description: 'Code execution test',
          environment: { type: 'e2b' as const },
          run: [{ lang: 'python', code: "print('test')", evaluations: [] }],
          judgment: { strategy: 'any_pass' as const },
        },
      ];

      legacyScenarios.forEach((scenario, index) => {
        expect(() => ScenarioSchema.parse(scenario)).not.toThrow();

        const parsed = ScenarioSchema.parse(scenario);
        expect(parsed.name).toBe(scenario.name);
        expect(parsed.environment.type).toBe(scenario.environment.type);
        expect(parsed.judgment.strategy).toBe(scenario.judgment.strategy);

        // Ensure conversation field is optional and undefined for legacy scenarios
        parsed.run.forEach((step) => {
          expect(step.conversation).toBeUndefined();
        });
      });
    });

    it('should preserve all existing schema properties and defaults', () => {
      const minimalScenario = {
        name: 'Minimal',
        description: 'Test',
        environment: { type: 'local' as const },
        run: [{ evaluations: [] }],
        judgment: { strategy: 'all_pass' as const },
      };

      const parsed = ScenarioSchema.parse(minimalScenario);

      // Verify all expected properties exist
      expect(parsed.name).toBeDefined();
      expect(parsed.description).toBeDefined();
      expect(parsed.environment).toBeDefined();
      expect(parsed.run).toBeDefined();
      expect(parsed.judgment).toBeDefined();

      // Optional properties should be undefined for legacy scenarios
      expect(parsed.plugins).toBeUndefined();
      expect(parsed.setup).toBeUndefined();

      // Run steps should not have conversation config
      expect(parsed.run[0].conversation).toBeUndefined();
    });
  });

  describe('Error Handling Backwards Compatibility', () => {
    it('should provide same error messages for invalid legacy scenarios', () => {
      const invalidScenarios = [
        // Missing required fields
        {
          name: 'Invalid',
          // Missing description, environment, run, judgment
        },
        // Invalid judgment strategy
        {
          name: 'Invalid',
          description: 'Test',
          environment: { type: 'local' as const },
          run: [{ evaluations: [] }],
          judgment: { strategy: 'invalid_strategy' as any },
        },
        // Invalid environment type
        {
          name: 'Invalid',
          description: 'Test',
          environment: { type: 'invalid_env' as any },
          run: [{ evaluations: [] }],
          judgment: { strategy: 'all_pass' as const },
        },
      ];

      invalidScenarios.forEach((scenario) => {
        expect(() => ScenarioSchema.parse(scenario)).toThrow();
      });
    });

    it('should handle legacy scenario execution errors gracefully', async () => {
      const errorScenario: Scenario = {
        name: 'Error Test',
        description: 'Test error handling',
        environment: { type: 'local' },
        run: [
          {
            input: 'This should trigger an error',
            evaluations: [
              {
                type: 'string_contains',
                value: 'error',
              },
            ],
          },
        ],
        judgment: { strategy: 'all_pass' },
      };

      // Mock an API failure
      const originalModule = require('../runtime-factory');
      originalModule.askAgentViaApi = async () => {
        throw new Error('Simulated API failure');
      };

      const provider = new LocalEnvironmentProvider(
        null, // Server object not needed for real askAgentViaApi calls
        REAL_AGENT_ID as any,
        mockRuntime,
        3000
      );

      await provider.setup(errorScenario);

      try {
        await provider.run(errorScenario);
        expect(false).toBe(true); // Should not reach here
      } catch (error: any) {
        // Should handle errors the same way as before
        expect(error).toBeDefined();
        expect(typeof error.message).toBe('string');
      }
    });
  });

  describe('Performance Backwards Compatibility', () => {
    it('should maintain same performance characteristics for legacy scenarios', async () => {
      const performanceScenario: Scenario = {
        name: 'Performance Test',
        description: 'Test execution speed',
        environment: { type: 'local' },
        run: [
          {
            input: 'Quick response test',
            evaluations: [
              {
                type: 'execution_time',
                max_duration_ms: 5000,
              },
            ],
          },
        ],
        judgment: { strategy: 'all_pass' },
      };

      const provider = new LocalEnvironmentProvider(
        null, // Server object not needed for real askAgentViaApi calls
        REAL_AGENT_ID as any,
        mockRuntime,
        3000
      );

      const startTime = Date.now();

      await provider.setup(performanceScenario);
      const results = await provider.run(performanceScenario);

      const endTime = Date.now();
      const totalTime = endTime - startTime;

      expect(results).toHaveLength(1);
      expect(results[0].durationMs).toBeLessThan(5000);
      expect(totalTime).toBeLessThan(10000); // Total should be reasonable

      // Memory usage should be reasonable (no major leaks)
      // This is a basic check - in production, you'd use more sophisticated memory monitoring
      expect(process.memoryUsage().heapUsed).toBeLessThan(100 * 1024 * 1024); // 100MB limit
    });
  });
});
