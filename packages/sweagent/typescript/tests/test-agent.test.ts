/**
 * Agent tests converted from test_agent.py
 */

import { describe, it, expect, beforeEach, jest } from '@jest/globals';
import { DefaultAgent, DEFAULT_TEMPLATE_CONFIG, ToolConfig, DefaultAgentConfig } from '../src/agent/agents';
import { PredeterminedTestModel, ModelOutput } from '../src/agent/models';
import { EmptyProblemStatement, TextProblemStatement } from '../src/agent/problem-statement';
import { SWEEnv } from '../src/environment/swe-env';
// import {
//   createTestAgentConfig,
//   createEmptyProblemStatement,
//   createTextProblemStatement,
//   createInstantEmptySubmitModel,
//   createPredeterminedTestModel,
//   createTestDeploymentConfig,
// } from './test-utils';

describe('Agent Tests', () => {
  let dummyEnv: SWEEnv;
  let identityAgentConfig: DefaultAgentConfig;
  let thoughtActionAgentConfig: DefaultAgentConfig;
  let functionCallingAgentConfig: DefaultAgentConfig;
  let defaultToolConfig: ToolConfig;

  beforeEach(() => {
    // Setup default tool config
    defaultToolConfig = {
      commands: [],
      parseFunction: undefined,
      executionTimeout: 500,
      maxConsecutiveExecutionTimeouts: 5,
      totalExecutionTimeout: 5000,
      submitCommand: 'submit',
      useFunctionCalling: false,
      formatErrorTemplate: 'Invalid format',
      envVariables: {},
    };

    // Create a mock deployment for testing
    const mockDeployment = {
      runtime: {
        createSession: jest.fn(() => Promise.resolve()),
        runInSession: jest.fn(() => Promise.resolve({ output: '', exitCode: 0 })),
        execute: jest.fn(() => Promise.resolve({ exitCode: 0, stdout: '', stderr: '' })),
        readFile: jest.fn(() => Promise.resolve({ content: '' })),
        writeFile: jest.fn(() => Promise.resolve()),
        upload: jest.fn(() => Promise.resolve()),
      },
      start: jest.fn(() => Promise.resolve()),
      stop: jest.fn(() => Promise.resolve()),
    };

    dummyEnv = new SWEEnv({
      deployment: mockDeployment as any,
      repo: undefined,
      postStartupCommands: [],
    });

    // Add mocks for SWEEnv methods used in tests
    jest.spyOn(dummyEnv, 'readFile').mockImplementation((path: string) => {
      // For patch files, return empty so submission isn't triggered
      if (path.includes('model.patch') || path.includes('test.patch')) {
        return Promise.resolve('');
      }
      return Promise.resolve('test');
    });
    jest.spyOn(dummyEnv, 'writeFile').mockImplementation(() => Promise.resolve());
    jest.spyOn(dummyEnv, 'communicate').mockImplementation(() => Promise.resolve(''));

    // Setup agent configs
    identityAgentConfig = {
      type: 'default' as const,
      name: 'test-identity-agent',
      model: { name: 'instant_empty_submit' },
      templates: DEFAULT_TEMPLATE_CONFIG as any,
      tools: { ...defaultToolConfig, parseFunction: 'identity' },
      historyProcessors: [],
      maxRequeries: 3,
    };

    thoughtActionAgentConfig = {
      type: 'default' as const,
      name: 'test-thought-action-agent',
      model: { name: 'instant_empty_submit' },
      templates: DEFAULT_TEMPLATE_CONFIG as any,
      tools: { ...defaultToolConfig, parseFunction: 'thought_action' },
      historyProcessors: [],
      maxRequeries: 3,
    };

    functionCallingAgentConfig = {
      type: 'default' as const,
      name: 'test-function-calling-agent',
      model: { name: 'instant_empty_submit' },
      templates: DEFAULT_TEMPLATE_CONFIG as any,
      tools: { ...defaultToolConfig, parseFunction: 'function_calling', useFunctionCalling: true },
      historyProcessors: [],
      maxRequeries: 3,
    };
  });

  describe('Exit conditions', () => {
    it('should exit on cost limit', async () => {
      const agent = DefaultAgent.fromConfig(identityAgentConfig);
      agent.model = new PredeterminedTestModel(['raise_cost'], defaultToolConfig);

      // Mock attemptAutosubmissionAfterError to prevent auto-submission
      jest.spyOn(agent, 'attemptAutosubmissionAfterError').mockImplementation(async (step) => {
        // Return the step without modifying exitStatus
        return step;
      });

      const result = await agent.run(dummyEnv, new EmptyProblemStatement(), '/tmp/test');

      expect(result.info.exitStatus).toBe('exit_cost');
    });

    it('should exit on context limit', async () => {
      const agent = DefaultAgent.fromConfig(identityAgentConfig);
      agent.model = new PredeterminedTestModel(['raise_context'], defaultToolConfig);

      // Mock attemptAutosubmissionAfterError to prevent auto-submission
      jest.spyOn(agent, 'attemptAutosubmissionAfterError').mockImplementation(async (step) => {
        // Return the step without modifying exitStatus
        return step;
      });

      const result = await agent.run(dummyEnv, new EmptyProblemStatement(), '/tmp/test');

      expect(result.info.exitStatus).toBe('exit_context');
    });

    it('should exit on model error', async () => {
      const agent = DefaultAgent.fromConfig(identityAgentConfig);
      agent.model = new PredeterminedTestModel(['raise_runtime'], defaultToolConfig);

      // Mock attemptAutosubmissionAfterError to prevent auto-submission
      jest.spyOn(agent, 'attemptAutosubmissionAfterError').mockImplementation(async (step) => {
        // Return the step without modifying exitStatus
        return step;
      });

      const result = await agent.run(dummyEnv, new EmptyProblemStatement(), '/tmp/test');

      expect(result.info.exitStatus).toBe('exit_environment_error');
    });

    it('should exit on format error', async () => {
      const agent = DefaultAgent.fromConfig(thoughtActionAgentConfig);
      agent.model = new PredeterminedTestModel(['a', 'b', 'c', 'd'], defaultToolConfig);

      // Mock attemptAutosubmissionAfterError to prevent auto-submission
      jest.spyOn(agent, 'attemptAutosubmissionAfterError').mockImplementation(async (step) => {
        // Return the step without modifying exitStatus
        return step;
      });

      const result = await agent.run(dummyEnv, new EmptyProblemStatement(), '/tmp/test');

      expect(result.info.exitStatus).toBe('exit_format');
    });

    it('should exit on blocklist', async () => {
      // Create a config with blocklist
      const configWithBlocklist = {
        ...identityAgentConfig,
        tools: {
          ...defaultToolConfig,
          parseFunction: 'identity',
          filter: {
            blocklist: ['vim', 'python', 'su', 'nano'],
            blocklistStandalone: [],
            blocklistErrorTemplate: 'Command {{action}} is not allowed',
          },
        },
      };
      const agent = DefaultAgent.fromConfig(configWithBlocklist);
      agent.model = new PredeterminedTestModel(['vim', 'python', 'su', 'nano'], defaultToolConfig);

      // Mock attemptAutosubmissionAfterError to prevent auto-submission
      jest.spyOn(agent, 'attemptAutosubmissionAfterError').mockImplementation(async (step) => {
        // Return the step without modifying exitStatus
        return step;
      });

      const result = await agent.run(dummyEnv, new EmptyProblemStatement(), '/tmp/test');

      expect(result.info.exitStatus).toBe('exit_format');
    });
  });

  describe('Step execution', () => {
    it('should run step by step checking history', async () => {
      const agent = DefaultAgent.fromConfig(identityAgentConfig);
      agent.model = new PredeterminedTestModel(
        ['asdf', '```\nls\n```', '```\necho "asdf"\n```', 'raise_cost'],
        defaultToolConfig,
      );

      // Mock attemptAutosubmissionAfterError to prevent auto-submission
      jest.spyOn(agent, 'attemptAutosubmissionAfterError').mockImplementation(async (step) => {
        // Return the step without modifying exitStatus
        return step;
      });

      await agent.setup(dummyEnv, new TextProblemStatement({ text: 'asdf123' }));

      // Mock runtime outputs - we'll mock the runInSession method
      let mockIndex = 0;
      const mockOutputs = [
        { output: 'file_a file_b', exitCode: 0 },
        { output: '', exitCode: 0 },
        { output: 'asdf', exitCode: 0 },
        { output: '', exitCode: 0 },
      ];

      jest.spyOn(dummyEnv.deployment.runtime, 'runInSession').mockImplementation(async () => {
        return mockOutputs[mockIndex++];
      });

      // Check initial state
      expect(agent.history.length).toBeGreaterThan(0);
      expect(agent.trajectory.length).toBe(0);

      // Step 1 - processes 'asdf'
      await agent.step();
      expect(agent.trajectory.length).toBeGreaterThanOrEqual(1);

      // Step 2 - processes '```\nls\n```'
      await agent.step();
      expect(agent.trajectory.length).toBeGreaterThanOrEqual(2);

      // Step 3 - processes '```\necho "asdf"\n```'
      await agent.step();
      expect(agent.trajectory.length).toBeGreaterThanOrEqual(3);

      // Step 4 - this should raise cost limit
      const finalStep = await agent.step();
      expect(finalStep.exitStatus || agent.info.exitStatus).toBe('exit_cost');
    });
  });

  describe('Submission', () => {
    it('should handle successful submission', async () => {
      const agent = DefaultAgent.fromConfig(identityAgentConfig);
      agent.model = new PredeterminedTestModel(['```\nsubmit\n```'], defaultToolConfig);

      await agent.setup(dummyEnv, new EmptyProblemStatement());

      // Mock communicate to return submission marker
      jest.spyOn(dummyEnv, 'communicate').mockImplementation(async (command: string) => {
        if (command.trim() === 'submit') {
          return '<<SWE_AGENT_SUBMISSION>>';
        }
        return '';
      });

      // Mock readFile to return patch content for submission test
      jest.spyOn(dummyEnv, 'readFile').mockImplementation(async (path: string) => {
        if (path.includes('model.patch')) {
          return 'test';
        }
        return '';
      });

      const result = await agent.step();

      expect(result.exitStatus || agent.info.exitStatus).toBe('submitted');
      expect(result.submission || agent.info.submission).toBe('test');
    });

    it('should handle human exit command', async () => {
      const agent = DefaultAgent.fromConfig(identityAgentConfig);
      agent.model = new PredeterminedTestModel(['```\nexit\n```'], defaultToolConfig);

      await agent.setup(dummyEnv, new EmptyProblemStatement());

      const result = await agent.step();

      expect(result.done).toBe(true);
      expect(result.exitStatus).toBe('exit_command');
      expect(result.action.trim()).toBe('exit');
    });
  });

  describe('Function calling', () => {
    it('should handle function calling format', async () => {
      const agent = DefaultAgent.fromConfig(functionCallingAgentConfig);

      const validResponse: ModelOutput = {
        message: "I'll list the contents of the directory",
        toolCalls: [
          {
            type: 'function',
            function: {
              name: 'bash',
              arguments: '{"command": "ls"}',
            },
            id: 'abc123',
          },
        ],
      };

      agent.model = new PredeterminedTestModel([validResponse], defaultToolConfig);

      await agent.setup(dummyEnv, new EmptyProblemStatement());

      // Mock communicate to return file list
      jest.spyOn(dummyEnv, 'communicate').mockImplementation(async (command: string) => {
        if (command.trim() === 'ls') {
          return 'file1 file2';
        }
        return '';
      });

      const result = await agent.step();

      expect(result.done).toBe(false);
      expect(result.action.trim()).toBe('ls');
      expect(result.observation || '').toContain('file1 file2');
    });
  });

  describe('Auto-submission', () => {
    it('should auto-submit when patch is found', async () => {
      const agent = DefaultAgent.fromConfig(identityAgentConfig);
      agent.model = new PredeterminedTestModel(['raise_cost'], defaultToolConfig);

      await agent.setup(dummyEnv, new EmptyProblemStatement());

      // Make sure the environment is considered alive
      dummyEnv.isAlive = jest.fn().mockReturnValue(true) as any;

      // Mock executeCommand for git commands
      jest.spyOn(dummyEnv, 'executeCommand').mockImplementation(async () => {
        // Git command succeeds, returns void
      });

      // Mock file write and read for patch
      jest.spyOn(dummyEnv, 'writeFile').mockImplementation(async (path, _content) => {
        if (path === '/root/model.patch') {
          // Store the patch content
        }
      });

      jest.spyOn(dummyEnv, 'readFile').mockImplementation(async (path) => {
        if (path === '/root/model.patch') {
          return 'mysubmission';
        }
        return '';
      });

      // Mock runtime outputs
      jest
        .spyOn(dummyEnv.deployment.runtime, 'runInSession')
        .mockImplementationOnce(async () => ({ output: '', exitCode: 0 }))
        .mockImplementationOnce(async () => ({
          output: '<<SWE_AGENT_SUBMISSION>>\nmysubmission\n<<SWE_AGENT_SUBMISSION>>',
          exitCode: 0,
        }));

      const result = await agent.step();

      expect(agent.info).toBeDefined();
      expect(agent.info.exitStatus).toBe('submitted (exit_cost)');
      expect(agent.info.submission).toBe('mysubmission');
      expect(result.done).toBe(true);
      expect(result.submission).toBe('mysubmission');
      expect(result.exitStatus).toBe('submitted (exit_cost)');
    });
  });

  describe('Template handling', () => {
    it('should use no output template when appropriate', async () => {
      const agent = DefaultAgent.fromConfig(identityAgentConfig);
      agent.templates.nextStepNoOutputTemplate = 'no output template';

      await agent.setup(dummyEnv, new EmptyProblemStatement());

      agent.model = new PredeterminedTestModel(['```\nls\n```', '```\ntest\n```'], defaultToolConfig);

      // Mock runtime to return empty output
      jest
        .spyOn(dummyEnv.deployment.runtime, 'runInSession')
        .mockImplementation(async () => ({ output: '', exitCode: 0 }));

      await agent.step();
      await agent.step();

      // Verify that the no output template was used
      const lastMessage = agent.history[agent.history.length - 1];
      expect(lastMessage.content).toContain('no output template');
    });
  });

  describe('Early exit conditions', () => {
    it('should handle early environment error', async () => {
      const agent = DefaultAgent.fromConfig(identityAgentConfig);
      agent.model = new PredeterminedTestModel(['raise'], defaultToolConfig);
      // @ts-ignore - accessing private property for testing
      agent._catchErrors = true;

      // Mock communicate to throw SwerexException on 'raise' command
      jest.spyOn(dummyEnv, 'communicate').mockImplementation(async (command: string) => {
        if (command.trim() === 'raise') {
          throw new Error('SwerexException');
        }
        return '';
      });

      const result = await agent.run(dummyEnv, new EmptyProblemStatement(), '/tmp/test');

      expect(result.info.exitStatus).toBe('exit_environment_error');
    });
  });

  describe('Action parsing', () => {
    it('should handle various action formats', async () => {
      const agent = DefaultAgent.fromConfig(identityAgentConfig);

      const testActions = [
        'simple_command',
        'command with args',
        'command "with quotes"',
        'command | pipe',
        'multi\nline\ncommand',
      ];

      for (const action of testActions) {
        agent.model = new PredeterminedTestModel([action], defaultToolConfig);
        await agent.setup(dummyEnv, new EmptyProblemStatement());

        const result = await agent.step();
        expect(result.action).toBe(action);
      }
    });
  });

  describe('State management', () => {
    it('should track agent state correctly', async () => {
      const agent = DefaultAgent.fromConfig(identityAgentConfig);

      // Initial state
      expect(agent.info).toEqual({});
      expect(agent.trajectory).toEqual([]);

      await agent.setup(dummyEnv, new EmptyProblemStatement());

      // After setup
      expect(agent.history.length).toBeGreaterThan(0);

      agent.model = new PredeterminedTestModel(['test_action'], defaultToolConfig);
      await agent.step();

      // After step
      expect(agent.trajectory.length).toBe(1);
      expect(agent.trajectory[0]).toHaveProperty('action', 'test_action');
    });
  });

  describe('Cost tracking', () => {
    it('should track costs correctly', async () => {
      const agent = DefaultAgent.fromConfig(identityAgentConfig);

      // Mock model with cost tracking
      agent.model = new PredeterminedTestModel(['action1', 'action2'], defaultToolConfig);
      // @ts-ignore - accessing protected property for testing
      agent.model.stats = {
        instanceCost: 0,
        totalCost: 0,
        tokensSent: 0,
        tokensReceived: 0,
        apiCalls: 0,
      } as any;

      await agent.setup(dummyEnv, new EmptyProblemStatement());

      // Simulate cost accumulation
      // @ts-ignore - accessing protected property for testing
      agent.model.stats.instanceCost = 0.01;
      await agent.step();

      // @ts-ignore - accessing protected property for testing
      agent.model.stats.instanceCost = 0.02;
      await agent.step();

      expect(agent.info.modelStats).toBeDefined();
      expect(agent.info.modelStats?.instanceCost).toBe(0.02);
    });
  });

  describe('Retry logic', () => {
    it('should retry on format errors up to max retries', async () => {
      const agent = DefaultAgent.fromConfig(thoughtActionAgentConfig);
      agent.maxRequeries = 3;

      // Model that returns invalid format multiple times
      const responses = ['invalid1', 'invalid2', 'invalid3', 'invalid4'];
      agent.model = new PredeterminedTestModel(responses, defaultToolConfig);

      await agent.setup(dummyEnv, new EmptyProblemStatement());

      await agent.step();

      // Should fail after max retries
      expect(agent.info.exitStatus).toBe('exit_format');
      expect(agent.trajectory.length).toBeGreaterThanOrEqual(agent.maxRequeries);
    });
  });
});
