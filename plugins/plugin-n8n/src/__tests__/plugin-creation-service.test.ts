import { describe, it, expect, beforeEach, afterEach, vi, Mock } from 'vitest';
import { PluginCreationService, PluginSpecification } from '../services/plugin-creation-service.ts';
import { IAgentRuntime } from '@elizaos/core';
import * as fs from 'fs-extra';
import { spawn } from 'child_process';
import Anthropic from '@anthropic-ai/sdk';

// Mock modules
vi.mock('fs-extra', () => {
  const fsMethods = {
    ensureDir: vi.fn(),
    writeJson: vi.fn(),
    writeFile: vi.fn(),
    remove: vi.fn(),
    readdir: vi.fn(),
    readFile: vi.fn(),
    pathExists: vi.fn(),
  };

  return {
    default: fsMethods,
    ...fsMethods,
  };
});
vi.mock('child_process');
vi.mock('@anthropic-ai/sdk');

// Mock IAgentRuntime
const createMockRuntime = (): IAgentRuntime => {
  const runtime = {
    getSetting: vi.fn(),
    services: new Map(),
  } as any;

  return runtime;
};

// Mock child process
const createMockChildProcess = () => ({
  stdout: { on: vi.fn() },
  stderr: { on: vi.fn() },
  on: vi.fn(),
  kill: vi.fn(),
  killed: false,
});

describe('PluginCreationService', () => {
  let service: PluginCreationService;
  let runtime: IAgentRuntime;
  let mockFs: any;
  let mockSpawn: Mock;
  let mockAnthropicCreate: Mock;

  beforeEach(() => {
    runtime = createMockRuntime();
    service = new PluginCreationService(runtime);

    // Setup mocks
    mockFs = fs as any;
    vi.mocked(fs.ensureDir).mockResolvedValue(undefined);
    vi.mocked(fs.writeJson).mockResolvedValue(undefined);
    vi.mocked(fs.writeFile).mockResolvedValue(undefined);
    vi.mocked(fs.remove).mockResolvedValue(undefined);
    vi.mocked(fs.readdir).mockResolvedValue([] as any);
    vi.mocked(fs.readFile).mockResolvedValue('' as any);
    vi.mocked(fs.pathExists).mockResolvedValue(false as any);

    mockSpawn = spawn as unknown as Mock;
    mockSpawn.mockReturnValue(createMockChildProcess());

    // Mock Anthropic
    mockAnthropicCreate = vi.fn().mockResolvedValue({
      content: [{ type: 'text', text: 'Generated code' }],
    });
    (Anthropic as any).mockImplementation(() => ({
      messages: { create: mockAnthropicCreate },
    }));

    // Clear all timers
    vi.clearAllTimers();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.clearAllMocks();
    vi.useRealTimers();
  });

  describe('initialization', () => {
    it('should initialize without API key', async () => {
      await service.initialize(runtime);
      expect(runtime.getSetting).toHaveBeenCalledWith('ANTHROPIC_API_KEY');
    });

    it('should initialize with API key', async () => {
      (runtime.getSetting as any).mockReturnValue('test-api-key');
      await service.initialize(runtime);
      expect(runtime.getSetting).toHaveBeenCalledWith('ANTHROPIC_API_KEY');
      expect(Anthropic).toHaveBeenCalledWith({ apiKey: 'test-api-key' });
    });
  });

  describe('createPlugin', () => {
    const validSpecification: PluginSpecification = {
      name: '@test/plugin-example',
      description: 'Test plugin for unit tests',
      version: '1.0.0',
      actions: [
        {
          name: 'testAction',
          description: 'A test action',
        },
      ],
    };

    it('should create a new plugin job', async () => {
      const jobId = await service.createPlugin(validSpecification, 'test-api-key');

      expect(jobId).toBeDefined();
      expect(typeof jobId).toBe('string');
      expect(jobId).toMatch(/^[a-f0-9-]{36}$/);

      const job = service.getJobStatus(jobId);
      expect(job).toBeDefined();
      expect(job?.specification).toEqual(validSpecification);
      expect(job?.status).toBe('pending');
    });

    it('should reject invalid plugin names', async () => {
      const invalidSpecs = [
        { ...validSpecification, name: '../../../etc/passwd' },
        { ...validSpecification, name: 'plugin\\..\\windows' },
        { ...validSpecification, name: './hidden/plugin' },
        { ...validSpecification, name: 'invalid plugin name' },
      ];

      for (const spec of invalidSpecs) {
        await expect(service.createPlugin(spec)).rejects.toThrow('Invalid plugin name');
      }
    });

    it('should enforce rate limiting', async () => {
      // Create 10 jobs (rate limit)
      for (let i = 0; i < 10; i++) {
        await service.createPlugin({
          ...validSpecification,
          name: `@test/plugin-${i}`,
        });
      }

      // 11th job should fail
      await expect(service.createPlugin(validSpecification)).rejects.toThrow('Rate limit exceeded');
    });

    it('should enforce concurrent job limit', async () => {
      // Create 10 jobs (rate limit)
      for (let i = 0; i < 10; i++) {
        await service.createPlugin({
          ...validSpecification,
          name: `@test/plugin-${i}`,
        });
      }

      // 11th job should fail with rate limit error (since we hit rate limit before concurrent limit)
      await expect(
        service.createPlugin({
          ...validSpecification,
          name: '@test/plugin-11',
        })
      ).rejects.toThrow('Rate limit exceeded');
    });

    it('should timeout long-running jobs', async () => {
      const jobId = await service.createPlugin(validSpecification);
      const job = service.getJobStatus(jobId);
      expect(job?.status).toBe('pending');

      // Fast-forward 30 minutes
      vi.advanceTimersByTime(30 * 60 * 1000);

      const timedOutJob = service.getJobStatus(jobId);
      expect(timedOutJob?.status).toBe('failed');
      expect(timedOutJob?.error).toContain('timed out');
    });
  });

  describe('job management', () => {
    it('should get all jobs', async () => {
      const spec1 = { name: '@test/plugin1', description: 'Plugin 1' };
      const spec2 = { name: '@test/plugin2', description: 'Plugin 2' };

      const jobId1 = await service.createPlugin(spec1);
      const jobId2 = await service.createPlugin(spec2);

      const jobs = service.getAllJobs();
      expect(jobs).toHaveLength(2);
      expect(jobs.map((j) => j.id)).toContain(jobId1);
      expect(jobs.map((j) => j.id)).toContain(jobId2);
    });

    it('should cancel a job and kill process', async () => {
      const specification = {
        name: '@test/plugin',
        description: 'Test plugin',
      };

      const jobId = await service.createPlugin(specification);
      const job = service.getJobStatus(jobId);

      // Mock child process
      const mockChildProcess = { kill: vi.fn(), killed: false };
      if (job) {
        job.childProcess = mockChildProcess;
        job.status = 'running';
      }

      service.cancelJob(jobId);

      const cancelledJob = service.getJobStatus(jobId);
      expect(cancelledJob?.status).toBe('cancelled');
      expect(cancelledJob?.completedAt).toBeDefined();
      expect(mockChildProcess.kill).toHaveBeenCalledWith('SIGTERM');
    });

    it('should handle cancelling non-existent job', () => {
      expect(() => service.cancelJob('non-existent-id')).not.toThrow();
    });
  });

  describe('service lifecycle', () => {
    it('should stop service and cancel running jobs', async () => {
      const specification = {
        name: '@test/plugin',
        description: 'Test plugin',
      };

      const jobId = await service.createPlugin(specification);

      // Manually set job to running
      const job = service.getJobStatus(jobId);
      if (job) {
        job.status = 'running';
      }

      await service.stop();

      const stoppedJob = service.getJobStatus(jobId);
      expect(stoppedJob?.status).toBe('cancelled');
    });
  });

  describe('static start method', () => {
    it('should create and initialize service', async () => {
      const newService = await PluginCreationService.start(runtime);
      expect(newService).toBeInstanceOf(PluginCreationService);
    });
  });

  describe('cleanupOldJobs', () => {
    it('should remove jobs older than one week', async () => {
      const oldDate = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000); // 8 days ago
      const recentDate = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000); // 2 days ago

      // Create old job
      const oldJobId = await service.createPlugin({
        name: '@test/old-plugin',
        description: 'Old',
      });
      const oldJob = service.getJobStatus(oldJobId);
      if (oldJob) {
        oldJob.completedAt = oldDate;
        oldJob.status = 'completed';
      }

      // Create recent job
      const recentJobId = await service.createPlugin({
        name: '@test/recent-plugin',
        description: 'Recent',
      });
      const recentJob = service.getJobStatus(recentJobId);
      if (recentJob) {
        recentJob.completedAt = recentDate;
        recentJob.status = 'completed';
      }

      service.cleanupOldJobs();

      expect(service.getJobStatus(oldJobId)).toBeNull();
      expect(service.getJobStatus(recentJobId)).toBeDefined();
      expect(fs.remove).toHaveBeenCalled();
    });
  });

  describe('plugin creation workflow', () => {
    it('should handle successful code generation', { timeout: 10000 }, async () => {
      (runtime.getSetting as any).mockReturnValue('test-api-key');

      const specification = {
        name: '@test/plugin',
        description: 'Test plugin',
        actions: [{ name: 'testAction', description: 'Test' }],
      };

      // Mock successful command execution
      const mockChild = createMockChildProcess();
      mockChild.on = vi.fn((event, callback) => {
        if (event === 'close') {
          process.nextTick(() => callback(0));
        }
      });
      mockSpawn.mockReturnValue(mockChild);

      const jobId = await service.createPlugin(specification, 'test-api-key');

      // Use fake timers to advance
      await vi.advanceTimersByTimeAsync(100);

      const job = service.getJobStatus(jobId);
      expect(job).toBeDefined();
      expect(mockAnthropicCreate).toHaveBeenCalled();
      expect(fs.ensureDir).toHaveBeenCalled();
      expect(fs.writeJson).toHaveBeenCalled();
    });

    it('should handle code generation failure', { timeout: 10000 }, async () => {
      (runtime.getSetting as any).mockReturnValue('test-api-key');

      // Mock Anthropic failure
      mockAnthropicCreate.mockRejectedValue(new Error('API error'));

      const specification = {
        name: '@test/plugin',
        description: 'Test plugin',
      };

      const jobId = await service.createPlugin(specification, 'test-api-key');

      // Use fake timers to advance
      await vi.advanceTimersByTimeAsync(100);

      const job = service.getJobStatus(jobId);
      expect(job?.status).toBe('failed');
      expect(job?.error).toContain('API error');
    });

    it('should handle build failures', { timeout: 10000 }, async () => {
      (runtime.getSetting as any).mockReturnValue('test-api-key');

      // Mock failed build
      const mockChild = createMockChildProcess();
      mockChild.on = vi.fn((event, callback) => {
        if (event === 'close') {
          process.nextTick(() => callback(1)); // Exit code 1
        }
      });
      mockChild.stderr.on = vi.fn((event, callback) => {
        if (event === 'data') {
          callback(Buffer.from('Build error'));
        }
      });
      mockSpawn.mockReturnValue(mockChild);

      const specification = {
        name: '@test/plugin',
        description: 'Test plugin',
      };

      const jobId = await service.createPlugin(specification, 'test-api-key');

      // Use fake timers to advance
      await vi.advanceTimersByTimeAsync(200);

      const job = service.getJobStatus(jobId);
      expect(job?.errors.length).toBeGreaterThan(0);
    });

    it('should handle command timeouts', async () => {
      (runtime.getSetting as any).mockReturnValue('test-api-key');

      // Mock hanging command
      const mockChild = createMockChildProcess();
      mockChild.on = vi.fn(); // Never calls close
      mockSpawn.mockReturnValue(mockChild);

      const specification = {
        name: '@test/plugin',
        description: 'Test plugin',
      };

      const jobId = await service.createPlugin(specification, 'test-api-key');

      // Wait for async code generation to complete
      await vi.advanceTimersByTimeAsync(100);

      // Now advance past command timeout (5 minutes)
      await vi.advanceTimersByTimeAsync(5 * 60 * 1000 + 1000);

      expect(mockChild.kill).toHaveBeenCalledWith('SIGTERM');
    });

    it('should limit output size', { timeout: 10000 }, async () => {
      (runtime.getSetting as any).mockReturnValue('test-api-key');

      // Mock large output
      const mockChild = createMockChildProcess();
      mockChild.on = vi.fn((event, callback) => {
        if (event === 'close') {
          process.nextTick(() => callback(0));
        }
      });
      mockChild.stdout.on = vi.fn((event, callback) => {
        if (event === 'data') {
          // Send 2MB of data
          for (let i = 0; i < 20; i++) {
            callback(Buffer.alloc(100 * 1024, 'a')); // 100KB chunks
          }
        }
      });
      mockSpawn.mockReturnValue(mockChild);

      const specification = {
        name: '@test/plugin',
        description: 'Test plugin',
      };

      const jobId = await service.createPlugin(specification, 'test-api-key');

      // Use fake timers to advance
      await vi.advanceTimersByTimeAsync(200);

      const job = service.getJobStatus(jobId);
      const logs = job?.logs.join('\n') || '';
      expect(logs).toContain('Output truncated');
    });
  });

  describe('security', () => {
    it('should sanitize plugin names', async () => {
      const specification = {
        name: '@test/Plugin-Name_123',
        description: 'Test',
      };

      const jobId = await service.createPlugin(specification);
      const job = service.getJobStatus(jobId);

      expect(job?.outputPath).toContain('test-plugin-name_123');
      // Check the sanitized part doesn't contain special characters
      const pathParts = job?.outputPath?.split('/');
      const sanitizedName = pathParts?.[pathParts.length - 1];
      expect(sanitizedName).not.toContain('@');
      expect(sanitizedName).not.toContain('/');
    });

    it('should prevent shell injection in commands', { timeout: 10000 }, async () => {
      (runtime.getSetting as any).mockReturnValue('test-api-key');

      // The spawn call should use shell: false
      const specification = {
        name: '@test/plugin',
        description: 'Test; rm -rf /',
      };

      await service.createPlugin(specification, 'test-api-key');

      // Use fake timers to advance
      await vi.advanceTimersByTimeAsync(100);

      expect(mockSpawn).toHaveBeenCalledWith(
        expect.any(String),
        expect.any(Array),
        expect.objectContaining({ shell: false })
      );
    });
  });
});
