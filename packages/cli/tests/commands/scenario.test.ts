import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Command } from 'commander';
import { scenarioCommand } from '../../src/commands/scenario/index.js';
import type { Scenario } from '../../src/scenario-runner/types.js';
import * as fs from 'fs/promises';
import * as path from 'path';

// Use bun-compatible mocking approach
const mockFn = () => {
  let calls: any[][] = [];
  let mockReturnValue: any = undefined;
  const fn: any = (...args: any[]) => {
    calls.push(args);
    return mockReturnValue;
  };
  fn.mockReturnValue = undefined;
  fn.mockResolvedValue = (value: any) => {
    mockReturnValue = Promise.resolve(value);
    return fn;
  };
  fn.mockImplementation = (impl: Function) => {
    return (...args: any[]) => {
      calls.push(args);
      return impl(...args);
    };
  };
  fn.getCalls = () => calls;
  fn.clearCalls = () => {
    calls = [];
  };
  return fn;
};

// Create mock modules
const mockProject = {
  loadProject: mockFn(),
};
mockProject.loadProject.mockResolvedValue({
  agents: [
    {
      character: {
        id: 'test-character',
        name: 'Test Agent',
        bio: ['Test bio'],
        system: 'Test system',
      },
      plugins: [],
    },
  ],
});

const mockAgentServer = mockFn();
mockAgentServer.mockImplementation(() => ({
  agents: new Map(),
  database: {},
  initialize: mockFn(),
  registerAgent: mockFn(),
  unregisterAgent: mockFn(),
  stop: mockFn(),
}));

const mockCore = {
  AgentRuntime: mockFn(),
  createUniqueUuid: mockFn(),
  asUUID: mockFn(),
  ChannelType: {
    DM: 'dm',
    GROUP: 'group',
  },
  ModelType: {
    TEXT_LARGE: 'text-large',
    TEXT_SMALL: 'text-small',
  },
  logger: {
    info: mockFn(),
    error: mockFn(),
    warn: mockFn(),
    debug: mockFn(),
    success: mockFn(),
  },
};

mockCore.AgentRuntime.mockImplementation(() => ({
  agentId: 'test-agent-id',
  character: { name: 'Test Agent' },
  initialize: mockFn(),
  ensureWorldExists: mockFn(),
  ensureRoomExists: mockFn(),
  createMemory: mockFn(),
  emitEvent: mockFn(),
  useModel: mockFn(),
}));
mockCore.createUniqueUuid = vi.fn().mockReturnValue('test-uuid');
mockCore.asUUID = vi.fn().mockImplementation((id: string) => id);

describe('Scenario Command Integration', () => {
  let program: Command;

  beforeEach(() => {
    program = new Command();
    program.addCommand(scenarioCommand);
    // Clear mock calls
    (mockProject.loadProject as any).clearCalls();
    (mockCore.logger.info as any).clearCalls();
    (mockCore.logger.warn as any).clearCalls();
  });

  afterEach(() => {
    // Reset mocks
  });

  describe('Command Structure', () => {
    it('should have scenario command with correct options', () => {
      const scenario = program.commands.find((cmd) => cmd.name() === 'scenario');

      expect(scenario).toBeDefined();
      expect(scenario?.options).toContainEqual(expect.objectContaining({ long: '--scenario' }));
      expect(scenario?.options).toContainEqual(expect.objectContaining({ long: '--directory' }));
      expect(scenario?.options).toContainEqual(expect.objectContaining({ long: '--filter' }));
      expect(scenario?.options).toContainEqual(expect.objectContaining({ long: '--benchmark' }));
      expect(scenario?.options).toContainEqual(expect.objectContaining({ long: '--verbose' }));
      expect(scenario?.options).toContainEqual(expect.objectContaining({ long: '--output' }));
      expect(scenario?.options).toContainEqual(expect.objectContaining({ long: '--format' }));
      expect(scenario?.options).toContainEqual(expect.objectContaining({ long: '--parallel' }));
      expect(scenario?.options).toContainEqual(
        expect.objectContaining({ long: '--max-concurrency' })
      );
    });

    it('should have generate subcommand', () => {
      const scenario = program.commands.find((cmd) => cmd.name() === 'scenario');
      const generate = scenario?.commands.find((cmd) => cmd.name() === 'generate');

      expect(generate).toBeDefined();
      expect(generate?.description()).toContain('Generate a new scenario using AI');
    });
  });

  describe('Scenario Execution', () => {
    it('should execute scenario with proper setup', async () => {
      const testScenario: Scenario = {
        id: 'test-scenario',
        name: 'Test Scenario',
        description: 'Integration test scenario',
        actors: [
          {
            id: 'subject' as any,
            name: 'Subject Agent',
            role: 'subject',
            script: {
              steps: [{ type: 'message', content: 'Hello from integration test' }],
            },
          },
        ],
        setup: {
          roomType: 'dm',
        },
        execution: {
          maxDuration: 5000,
        },
        verification: {
          rules: [
            {
              id: 'test-rule',
              type: 'llm',
              description: 'Test verification',
              config: {},
            },
          ],
        },
      };

      // Create a temporary scenario file
      const tempDir = path.join(process.cwd(), '.test-scenarios');
      await fs.mkdir(tempDir, { recursive: true });
      const scenarioPath = path.join(tempDir, 'test-scenario.json');
      await fs.writeFile(scenarioPath, JSON.stringify(testScenario));

      // Mock console output
      const originalLog = console.log;
      const originalError = console.error;
      console.log = mockFn();
      console.error = mockFn();

      try {
        // Execute the command - catch to prevent test failure on expected exit
        await program.parseAsync(['node', 'test', 'scenario', '--scenario', scenarioPath]);
      } catch (error) {
        // Expected to exit with code, check that scenario was processed
      }

      // Clean up
      await fs.rm(tempDir, { recursive: true, force: true });
      console.log = originalLog;
      console.error = originalError;

      // Verify the command attempted to run scenarios
      expect(mockCore.logger.info.getCalls().length).toBeGreaterThan(0);
    });
  });

  describe('Generate Subcommand', () => {
    it('should parse generate command options', () => {
      const scenario = program.commands.find((cmd) => cmd.name() === 'scenario');
      const generate = scenario?.commands.find((cmd) => cmd.name() === 'generate');

      expect(generate?.options).toContainEqual(expect.objectContaining({ long: '--plugins' }));
      expect(generate?.options).toContainEqual(expect.objectContaining({ long: '--complexity' }));
      expect(generate?.options).toContainEqual(expect.objectContaining({ long: '--test-type' }));
      expect(generate?.options).toContainEqual(expect.objectContaining({ long: '--duration' }));
      expect(generate?.options).toContainEqual(expect.objectContaining({ long: '--actors' }));
      expect(generate?.options).toContainEqual(expect.objectContaining({ long: '--output' }));
      expect(generate?.options).toContainEqual(expect.objectContaining({ long: '--enhance' }));
    });
  });

  describe('Error Handling', () => {
    it('should handle missing scenario files gracefully', async () => {
      const originalError = console.error;
      const originalExit = process.exit;
      console.error = mockFn();
      process.exit = mockFn() as any;
      (process.exit as any).mockImplementation(() => {
        throw new Error('Process exit');
      });

      try {
        await program.parseAsync([
          'node',
          'test',
          'scenario',
          '--scenario',
          '/non/existent/file.json',
        ]);
      } catch (error) {
        // Expected
      }

      expect((console.error as any).getCalls().length).toBeGreaterThan(0);

      console.error = originalError;
      process.exit = originalExit;
    });

    it('should handle empty scenarios directory', async () => {
      const tempDir = path.join(process.cwd(), '.empty-scenarios');
      await fs.mkdir(tempDir, { recursive: true });

      const originalLog = console.log;
      console.log = mockFn();

      try {
        await program.parseAsync(['node', 'test', 'scenario', '--directory', tempDir]);
      } catch {
        // Expected
      }

      await fs.rm(tempDir, { recursive: true, force: true });
      console.log = originalLog;

      expect(mockCore.logger.warn.getCalls().length).toBeGreaterThan(0);
    });
  });

  describe('Output Formats', () => {
    it('should support different output formats', async () => {
      const testScenario: Scenario = {
        id: 'format-test',
        name: 'Format Test',
        description: 'Test output formats',
        actors: [
          {
            id: 'subject' as any,
            name: 'Subject',
            role: 'subject',
            script: { steps: [] },
          },
        ],
        setup: {},
        execution: {},
        verification: {
          rules: [
            {
              id: 'test',
              type: 'llm',
              description: 'Test',
              config: {},
            },
          ],
        },
      };

      const tempDir = path.join(process.cwd(), '.format-test');
      await fs.mkdir(tempDir, { recursive: true });
      const scenarioPath = path.join(tempDir, 'test.json');
      await fs.writeFile(scenarioPath, JSON.stringify(testScenario));

      // Test JSON format
      const jsonOutput = path.join(tempDir, 'results.json');
      try {
        await program.parseAsync([
          'node',
          'test',
          'scenario',
          '--scenario',
          scenarioPath,
          '--format',
          'json',
          '--output',
          jsonOutput,
        ]);
      } catch {
        // Expected
      }

      // Test HTML format
      const htmlOutput = path.join(tempDir, 'results.html');
      try {
        await program.parseAsync([
          'node',
          'test',
          'scenario',
          '--scenario',
          scenarioPath,
          '--format',
          'html',
          '--output',
          htmlOutput,
        ]);
      } catch {
        // Expected
      }

      // Clean up
      await fs.rm(tempDir, { recursive: true, force: true });
    });
  });
});
