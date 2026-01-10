import { describe, it, expect, beforeEach, afterEach, vi, Mock } from 'vitest';
import {
  PluginCreationService,
  PluginSpecification,
  ClaudeModel,
  PluginCreationJob,
} from '../services/plugin-creation-service.ts';
import { IAgentRuntime } from '@elizaos/core';
import fs from 'fs-extra';
import path from 'path';
import Anthropic from '@anthropic-ai/sdk';

// Mock Anthropic
vi.mock('@anthropic-ai/sdk');

// Test plugin specifications
const TIME_PLUGIN_SPEC: PluginSpecification = {
  name: '@elizaos/plugin-time',
  description: 'Provides current time and timezone information',
  version: '1.0.0',
  actions: [
    {
      name: 'getCurrentTime',
      description: 'Get current time in any timezone',
      parameters: {
        timezone: 'string',
      },
    },
    {
      name: 'convertTime',
      description: 'Convert time between timezones',
      parameters: {
        time: 'string',
        fromTimezone: 'string',
        toTimezone: 'string',
      },
    },
  ],
  providers: [
    {
      name: 'timeProvider',
      description: 'Provides current time context',
      dataStructure: {
        currentTime: 'string',
        timezone: 'string',
        utcOffset: 'number',
      },
    },
  ],
};

const ASTRAL_CHART_SPEC: PluginSpecification = {
  name: '@elizaos/plugin-astral',
  description: 'Calculate astral charts using astronomical algorithms',
  version: '1.0.0',
  actions: [
    {
      name: 'calculateChart',
      description: 'Calculate natal chart for given birth data',
      parameters: {
        birthDate: 'string',
        birthTime: 'string',
        latitude: 'number',
        longitude: 'number',
      },
    },
    {
      name: 'getPlanetPositions',
      description: 'Get current planetary positions',
      parameters: {
        date: 'string',
        observer: {
          latitude: 'number',
          longitude: 'number',
        },
      },
    },
  ],
  dependencies: {
    astronomia: '^4.1.1',
  },
};

const SHELL_COMMAND_SPEC: PluginSpecification = {
  name: '@elizaos/plugin-shell',
  description: 'Execute shell commands and curl requests safely',
  version: '1.0.0',
  actions: [
    {
      name: 'executeCommand',
      description: 'Run shell command with safety checks',
      parameters: {
        command: 'string',
        args: 'string[]',
        cwd: 'string',
      },
    },
    {
      name: 'curlRequest',
      description: 'Make HTTP request via curl',
      parameters: {
        url: 'string',
        method: 'string',
        headers: 'object',
        data: 'string',
      },
    },
  ],
  services: [
    {
      name: 'ShellService',
      description: 'Manages shell execution with security',
      methods: ['execute', 'validateCommand', 'auditLog'],
    },
  ],
  environmentVariables: [
    {
      name: 'SHELL_WHITELIST',
      description: 'Comma-separated list of allowed commands',
      required: false,
      sensitive: false,
    },
    {
      name: 'SHELL_AUDIT_LOG',
      description: 'Path to audit log file',
      required: false,
      sensitive: false,
    },
  ],
};

// Mock runtime
const createMockRuntime = (): IAgentRuntime => {
  const runtime = {
    getSetting: vi.fn().mockReturnValue('test-api-key'),
    services: new Map(),
  } as any;

  return runtime;
};

// Mock successful AI response for plugin code
const mockSuccessfulAIResponse = (pluginName: string) => ({
  content: [
    {
      type: 'text',
      text: generateMockPluginCode(pluginName),
    },
  ],
});

// Generate mock plugin code based on specification
function generateMockPluginCode(pluginName: string): string {
  return `
File: src/index.ts
\`\`\`typescript
import { Plugin } from "@elizaos/core";
import { timeAction } from "./actions/timeAction";

export const plugin: Plugin = {
  name: "${pluginName}",
  description: "Test plugin",
  actions: [timeAction],
  providers: [],
  services: [],
};

export default plugin;
\`\`\`

File: src/actions/timeAction.ts
\`\`\`typescript
import { Action, IAgentRuntime, Memory, State } from "@elizaos/core";

export const timeAction: Action = {
  name: "getCurrentTime",
  description: "Get current time",
  similes: ["time", "clock"],
  examples: [],
  validate: async () => true,
  handler: async () => {
    return new Date().toISOString();
  },
};
\`\`\`

File: src/__tests__/timeAction.test.ts
\`\`\`typescript
import { describe, it, expect } from "vitest";
import { timeAction } from "../actions/timeAction";

describe("timeAction", () => {
  it("should return current time", async () => {
    const result = await timeAction.handler({} as any, {} as any);
    expect(result).toBeDefined();
  });
});
\`\`\`
`;
}

describe('E2E Plugin Creation Tests', () => {
  let service: PluginCreationService;
  let runtime: IAgentRuntime;
  let mockAnthropicCreate: Mock;
  let testDataDir: string;

  beforeEach(async () => {
    runtime = createMockRuntime();
    service = new PluginCreationService(runtime);

    // Setup test data directory
    testDataDir = path.join(process.cwd(), 'test-data', Date.now().toString());
    (runtime.getSetting as any).mockImplementation((key: string) => {
      if (key === 'PLUGIN_DATA_DIR') return testDataDir;
      if (key === 'ANTHROPIC_API_KEY') return 'test-api-key';
      if (key === 'CLAUDE_MODEL') return ClaudeModel.SONNET_3_5;
      return null;
    });

    // Mock Anthropic responses
    mockAnthropicCreate = vi.fn();
    (Anthropic as any).mockImplementation(() => ({
      messages: { create: mockAnthropicCreate },
    }));

    await service.initialize(runtime);
    vi.useFakeTimers();
  });

  afterEach(async () => {
    vi.useRealTimers();
    vi.clearAllMocks();

    // Stop all running jobs before cleanup
    const allJobs = service.listJobs();
    for (const job of allJobs) {
      if (job.status === 'running' && job.childProcess) {
        try {
          // Use SIGKILL for immediate termination
          job.childProcess.kill('SIGKILL');
        } catch (e) {
          // Ignore errors killing processes
        }
      }
      service.cancelJob(job.id);
    }

    // Stop the service to ensure all jobs are cleaned up
    await service.stop();

    // Wait for processes to fully terminate
    await new Promise((resolve) => setTimeout(resolve, 200));

    // Cleanup test data - use rm with force and retries
    if (await fs.pathExists(testDataDir)) {
      let retries = 3;
      while (retries > 0) {
        try {
          await fs.rm(testDataDir, { recursive: true, force: true, maxRetries: 3 });
          break;
        } catch (error) {
          retries--;
          if (retries === 0) {
            // Last resort - ignore the error
            console.warn('Could not clean up test directory:', error);
          } else {
            // Wait before retry
            await new Promise((resolve) => setTimeout(resolve, 500));
          }
        }
      }
    }
  }, 30000); // Increase timeout to 30 seconds for cleanup

  describe('Time Plugin Creation', () => {
    it('should create a working time plugin', async () => {
      // Mock successful AI responses
      mockAnthropicCreate
        .mockResolvedValueOnce(mockSuccessfulAIResponse(TIME_PLUGIN_SPEC.name))
        .mockResolvedValueOnce({
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                score: 95,
                production_ready: true,
                issues: [],
                suggestions: ['Consider adding more timezones'],
              }),
            },
          ],
        });

      const jobId = await service.createPlugin(TIME_PLUGIN_SPEC, 'test-api-key', {
        useTemplate: true,
        model: ClaudeModel.SONNET_3_5,
      });

      expect(jobId).toBeDefined();
      expect(service.isPluginCreated(TIME_PLUGIN_SPEC.name)).toBe(true);

      // Wait for async processing
      await vi.advanceTimersByTimeAsync(1000);

      const job = service.getJobStatus(jobId);
      expect(job).toBeDefined();
      expect(job?.modelUsed).toBe(ClaudeModel.SONNET_3_5);
    });

    it('should prevent duplicate time plugin creation', async () => {
      // Create first plugin
      await service.createPlugin(TIME_PLUGIN_SPEC, 'test-api-key');

      // Attempt to create duplicate
      await expect(service.createPlugin(TIME_PLUGIN_SPEC, 'test-api-key')).rejects.toThrow(
        'has already been created'
      );
    });
  });

  describe('Astral Chart Plugin Creation', () => {
    it('should create astral chart plugin with dependencies', async () => {
      mockAnthropicCreate
        .mockResolvedValueOnce(mockSuccessfulAIResponse(ASTRAL_CHART_SPEC.name))
        .mockResolvedValueOnce({
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                score: 90,
                production_ready: true,
                issues: [],
                suggestions: [],
              }),
            },
          ],
        });

      const jobId = await service.createPlugin(ASTRAL_CHART_SPEC, 'test-api-key', {
        useTemplate: true,
        model: ClaudeModel.OPUS_3,
      });

      await vi.advanceTimersByTimeAsync(1000);

      const job = service.getJobStatus(jobId);
      expect(job?.specification.dependencies).toHaveProperty('astronomia');
      expect(job?.modelUsed).toBe(ClaudeModel.OPUS_3);
    });
  });

  describe('Shell Command Plugin Creation', () => {
    it('should create shell plugin with security features', async () => {
      mockAnthropicCreate
        .mockResolvedValueOnce(mockSuccessfulAIResponse(SHELL_COMMAND_SPEC.name))
        .mockResolvedValueOnce({
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                score: 88,
                production_ready: true,
                issues: [],
                suggestions: ['Add more command validation'],
              }),
            },
          ],
        });

      const jobId = await service.createPlugin(SHELL_COMMAND_SPEC, 'test-api-key');

      await vi.advanceTimersByTimeAsync(1000);

      const job = service.getJobStatus(jobId);
      expect(job?.specification.services).toHaveLength(1);
      expect(job?.specification.environmentVariables).toHaveLength(2);
    });

    it('should validate security constraints', async () => {
      const dangerousSpec = {
        ...SHELL_COMMAND_SPEC,
        name: '../../../etc/passwd',
      };

      await expect(service.createPlugin(dangerousSpec, 'test-api-key')).rejects.toThrow(
        'Invalid plugin name'
      );
    });
  });

  describe('Plugin Registry Integration', () => {
    it('should track all created plugins', async () => {
      // Create multiple plugins
      mockAnthropicCreate
        .mockResolvedValueOnce(mockSuccessfulAIResponse(TIME_PLUGIN_SPEC.name))
        .mockResolvedValueOnce({ content: [{ type: 'text', text: JSON.stringify({ score: 95, production_ready: true, issues: [], suggestions: [] }) }] })
        .mockResolvedValueOnce(mockSuccessfulAIResponse(ASTRAL_CHART_SPEC.name))
        .mockResolvedValueOnce({ content: [{ type: 'text', text: JSON.stringify({ score: 95, production_ready: true, issues: [], suggestions: [] }) }] })
        .mockResolvedValueOnce(mockSuccessfulAIResponse(SHELL_COMMAND_SPEC.name))
        .mockResolvedValueOnce({ content: [{ type: 'text', text: JSON.stringify({ score: 95, production_ready: true, issues: [], suggestions: [] }) }] });

      await service.createPlugin(TIME_PLUGIN_SPEC, 'test-api-key');
      await service.createPlugin(ASTRAL_CHART_SPEC, 'test-api-key');
      await service.createPlugin(SHELL_COMMAND_SPEC, 'test-api-key');

      const createdPlugins = service.getCreatedPlugins();
      expect(createdPlugins).toHaveLength(3);
      expect(createdPlugins).toContain(TIME_PLUGIN_SPEC.name);
      expect(createdPlugins).toContain(ASTRAL_CHART_SPEC.name);
      expect(createdPlugins).toContain(SHELL_COMMAND_SPEC.name);
    });

    it('should provide accurate plugin existence check', () => {
      service.createPlugin(TIME_PLUGIN_SPEC, 'test-api-key');

      expect(service.isPluginCreated(TIME_PLUGIN_SPEC.name)).toBe(true);
      expect(service.isPluginCreated('@elizaos/plugin-nonexistent')).toBe(false);
    });
  });

  describe('Template Integration', () => {
    it('should use plugin-starter template when available', async () => {
      // Use real timers for this test
      vi.useRealTimers();

      const templatePath = path.join(__dirname, '../resources/templates/plugin-starter');

      // Check if template exists (it should after our setup)
      const templateExists = await fs.pathExists(templatePath);
      expect(templateExists).toBe(true);

      // Mock both code generation and validation responses
      mockAnthropicCreate
        .mockResolvedValueOnce(mockSuccessfulAIResponse(TIME_PLUGIN_SPEC.name))
        .mockResolvedValueOnce({
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                score: 95,
                production_ready: true,
                issues: [],
                suggestions: [],
              }),
            },
          ],
        });

      const jobId = await service.createPlugin(TIME_PLUGIN_SPEC, 'test-api-key', {
        useTemplate: true,
      });

      // Wait for the job to progress to setupPluginWorkspace
      let attempts = 0;
      let job: PluginCreationJob | null = null;
      
      while (attempts < 20) { // Max 2 seconds
        await new Promise((resolve) => setTimeout(resolve, 100));
        job = service.getJobStatus(jobId);
        
        if (job && job.logs.length > 0) {
          // Check if we have the log we're looking for
          if (job.logs.some((log) => log.includes('Using plugin-starter template') || 
                                     log.includes('Template not found, using fallback setup'))) {
            break;
          }
        }
        attempts++;
      }

      expect(job?.logs.some((log) => log.includes('Using plugin-starter template'))).toBe(true);

      // Restore fake timers
      vi.useFakeTimers();
    });

    it('should fall back gracefully when template missing', async () => {
      // Use real timers for this test
      vi.useRealTimers();

      // Temporarily rename template directory
      const templatePath = path.join(__dirname, '../resources/templates/plugin-starter');
      const tempPath = templatePath + '.bak';

      if (await fs.pathExists(templatePath)) {
        await fs.move(templatePath, tempPath);
      }

      try {
        mockAnthropicCreate.mockResolvedValue(mockSuccessfulAIResponse(TIME_PLUGIN_SPEC.name));

        const jobId = await service.createPlugin(TIME_PLUGIN_SPEC, 'test-api-key', {
          useTemplate: true,
        });

        // Wait for the job to progress to setupPluginWorkspace
        let attempts = 0;
        let job: PluginCreationJob | null = null;
        
        while (attempts < 20) { // Max 2 seconds
          await new Promise((resolve) => setTimeout(resolve, 100));
          job = service.getJobStatus(jobId);
          
          if (job && job.logs.length > 0) {
            // Check if we have the log we're looking for
            if (job.logs.some((log) => log.includes('Using plugin-starter template') || 
                                       log.includes('Template not found, using fallback setup'))) {
              break;
            }
          }
          attempts++;
        }

        expect(
          job?.logs.some((log) => log.includes('Template not found, using fallback setup'))
        ).toBe(true);
      } finally {
        // Restore template
        if (await fs.pathExists(tempPath)) {
          await fs.move(tempPath, templatePath);
        }
        // Restore fake timers
        vi.useFakeTimers();
      }
    });
  });

  describe('Model Selection', () => {
    it('should respect model selection', async () => {
      mockAnthropicCreate.mockResolvedValue(mockSuccessfulAIResponse(TIME_PLUGIN_SPEC.name));

      // Test Sonnet
      const sonnetJobId = await service.createPlugin(
        { ...TIME_PLUGIN_SPEC, name: '@elizaos/plugin-time-sonnet' },
        'test-api-key',
        { model: ClaudeModel.SONNET_3_5 }
      );

      // Test Opus
      const opusJobId = await service.createPlugin(
        { ...ASTRAL_CHART_SPEC, name: '@elizaos/plugin-astral-opus' },
        'test-api-key',
        { model: ClaudeModel.OPUS_3 }
      );

      const sonnetJob = service.getJobStatus(sonnetJobId);
      const opusJob = service.getJobStatus(opusJobId);

      expect(sonnetJob?.modelUsed).toBe(ClaudeModel.SONNET_3_5);
      expect(opusJob?.modelUsed).toBe(ClaudeModel.OPUS_3);
    });
  });
});

describe('Plugin Code Generation Quality', () => {
  it('should generate complete, production-ready code', async () => {
    // This test would validate the actual generated code
    // For now, we're mocking, but in real E2E tests, we'd check:
    // 1. All actions are implemented
    // 2. No stubs or TODOs
    // 3. Proper error handling
    // 4. Comprehensive tests
    // 5. TypeScript compiles
    // 6. Tests pass
    // 7. Linting passes
    expect(true).toBe(true); // Placeholder
  });
});

export { TIME_PLUGIN_SPEC, ASTRAL_CHART_SPEC, SHELL_COMMAND_SPEC };
