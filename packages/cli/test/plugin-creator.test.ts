import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { PluginCreator } from '../src/utils/plugins/creator';

// Mock all dependencies
vi.mock('fs-extra', () => ({
  ensureDir: vi.fn(),
  pathExists: vi.fn(),
  writeFile: vi.fn(),
  writeJson: vi.fn(),
  copy: vi.fn(),
  readdir: vi.fn(),
  stat: vi.fn(),
  move: vi.fn(),
  readFile: vi.fn(),
}));

vi.mock('execa', () => ({
  execa: vi.fn(),
}));

vi.mock('@anthropic-ai/sdk', () => ({
  default: vi.fn(),
}));

vi.mock('simple-git', () => ({
  default: vi.fn(),
}));

vi.mock('ora', () => ({
  default: () => ({
    start: vi.fn().mockReturnThis(),
    info: vi.fn().mockReturnThis(),
    succeed: vi.fn().mockReturnThis(),
    fail: vi.fn().mockReturnThis(),
  }),
}));

vi.mock('inquirer', () => ({
  default: {
    prompt: vi.fn(),
  },
}));

describe('PluginCreator', () => {
  // Mock process.chdir since it's not available in worker threads
  const originalChdir = process.chdir;

  beforeEach(() => {
    vi.clearAllMocks();
    process.env.ANTHROPIC_API_KEY = 'test-api-key';
    // Mock process.chdir
    process.chdir = vi.fn();
  });

  afterEach(() => {
    delete process.env.ANTHROPIC_API_KEY;
    // Restore original process.chdir
    process.chdir = originalChdir;
  });

  describe('initialization', () => {
    it('should fail if ANTHROPIC_API_KEY is not set', async () => {
      delete process.env.ANTHROPIC_API_KEY;
      const creator = new PluginCreator();

      const result = await creator.create();

      expect(result.success).toBe(false);
      expect(result.error?.message).toContain('ANTHROPIC_API_KEY is required');
    });
  });

  describe('create', () => {
    it('should create plugin with provided specification', async () => {
      // Setup mocks
      const { execa } = await import('execa');
      const fs = await import('fs-extra');
      const Anthropic = (await import('@anthropic-ai/sdk')).default;
      const simpleGit = (await import('simple-git')).default;

      // Mock implementations
      vi.mocked(execa).mockResolvedValue({
        stdout: 'success',
        stderr: '',
        exitCode: 0,
      } as any);

      vi.mocked(fs.ensureDir).mockResolvedValue(undefined as any);
      vi.mocked(fs.pathExists).mockResolvedValue(false as any);
      vi.mocked(fs.writeFile).mockResolvedValue(undefined as any);
      vi.mocked(fs.writeJson).mockResolvedValue(undefined as any);
      vi.mocked(fs.copy).mockResolvedValue(undefined as any);
      vi.mocked(fs.readdir).mockResolvedValue([] as any);
      vi.mocked(fs.stat).mockResolvedValue({ isFile: () => true } as any);
      vi.mocked(fs.readFile).mockResolvedValue('content' as any);
      vi.mocked(fs.move).mockResolvedValue(undefined as any);

      vi.mocked(Anthropic).mockImplementation(
        () =>
          ({
            messages: {
              create: vi.fn().mockResolvedValue({
                content: [{ type: 'text', text: 'Detailed specification content' }],
              }),
            },
          }) as any
      );

      vi.mocked(simpleGit).mockReturnValue({
        init: vi.fn().mockResolvedValue(undefined),
        add: vi.fn().mockResolvedValue(undefined),
        commit: vi.fn().mockResolvedValue(undefined),
      } as any);

      const spec = {
        name: 'time-tracker',
        description: 'A plugin to track and display time',
        features: ['Display current time', 'Set timezone offset'],
        actions: ['displayTime', 'setOffset'],
        providers: ['timeProvider'],
      };

      const creator = new PluginCreator({
        skipPrompts: true,
        spec,
        skipTests: true,
        skipValidation: true,
      });

      const result = await creator.create();

      expect(result.success).toBe(true);
      expect(result.pluginName).toBe('time-tracker');
      expect(result.pluginPath).toContain('plugin-time-tracker');
    });

    it('should handle errors gracefully', async () => {
      const { execa } = await import('execa');

      // Mock Claude Code not found
      vi.mocked(execa).mockRejectedValue(new Error('Command not found'));

      const spec = {
        name: 'test-plugin',
        description: 'Test plugin',
        features: ['Test feature'],
      };

      const creator = new PluginCreator({ skipPrompts: true, spec });

      const result = await creator.create();

      expect(result.success).toBe(false);
      expect(result.error?.message).toContain('Claude Code is required');
    });
  });

  describe('validation', () => {
    it('should skip validation when option is set', async () => {
      // Setup mocks
      const { execa } = await import('execa');
      const fs = await import('fs-extra');
      const Anthropic = (await import('@anthropic-ai/sdk')).default;
      const simpleGit = (await import('simple-git')).default;

      vi.mocked(execa).mockResolvedValue({
        stdout: 'success',
        stderr: '',
        exitCode: 0,
      } as any);

      vi.mocked(fs.ensureDir).mockResolvedValue(undefined as any);
      vi.mocked(fs.pathExists).mockResolvedValue(false as any);
      vi.mocked(fs.writeFile).mockResolvedValue(undefined as any);
      vi.mocked(fs.writeJson).mockResolvedValue(undefined as any);
      vi.mocked(fs.copy).mockResolvedValue(undefined as any);
      vi.mocked(fs.readdir).mockResolvedValue([] as any);
      vi.mocked(fs.stat).mockResolvedValue({ isFile: () => true } as any);
      vi.mocked(fs.readFile).mockResolvedValue('content' as any);
      vi.mocked(fs.move).mockResolvedValue(undefined as any);

      const mockAnthropicCreate = vi.fn().mockResolvedValue({
        content: [{ type: 'text', text: 'Specification' }],
      });

      vi.mocked(Anthropic).mockImplementation(
        () =>
          ({
            messages: {
              create: mockAnthropicCreate,
            },
          }) as any
      );

      vi.mocked(simpleGit).mockReturnValue({
        init: vi.fn().mockResolvedValue(undefined),
        add: vi.fn().mockResolvedValue(undefined),
        commit: vi.fn().mockResolvedValue(undefined),
      } as any);

      const spec = {
        name: 'test-plugin',
        description: 'Test plugin',
        features: ['Test feature'],
      };

      const creator = new PluginCreator({
        skipPrompts: true,
        spec,
        skipTests: true,
        skipValidation: true,
      });

      const result = await creator.create();

      expect(result.success).toBe(true);
      // Should only be called once for spec generation, not for validation
      expect(mockAnthropicCreate).toHaveBeenCalledTimes(1);
    });
  });
});
