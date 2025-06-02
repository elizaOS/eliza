import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { PluginCreator } from '../src/utils/plugins/creator';

// Mock all dependencies
vi.mock('fs-extra', () => ({
  ensureDir: vi.fn(),
  pathExists: vi.fn(),
  writeFile: vi.fn(),
  writeJSON: vi.fn(),
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
      vi.mocked(fs.writeJSON).mockResolvedValue(undefined as any);
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
      vi.mocked(fs.writeJSON).mockResolvedValue(undefined as any);
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

    it('should generate database-agnostic specifications', async () => {
      const { execa } = await import('execa');
      const fs = await import('fs-extra');
      const Anthropic = (await import('@anthropic-ai/sdk')).default;
      const simpleGit = (await import('simple-git')).default;

      // Mock successful execution
      vi.mocked(execa).mockResolvedValue({
        stdout: 'success',
        stderr: '',
        exitCode: 0,
      } as any);

      vi.mocked(fs.ensureDir).mockResolvedValue(undefined as any);
      vi.mocked(fs.pathExists).mockResolvedValue(false as any);
      vi.mocked(fs.writeFile).mockResolvedValue(undefined as any);
      vi.mocked(fs.writeJSON).mockResolvedValue(undefined as any);
      vi.mocked(fs.copy).mockResolvedValue(undefined as any);
      vi.mocked(fs.readdir).mockResolvedValue([] as any);
      vi.mocked(fs.stat).mockResolvedValue({ isFile: () => true } as any);
      vi.mocked(fs.readFile).mockResolvedValue('content' as any);
      vi.mocked(fs.move).mockResolvedValue(undefined as any);

      const mockAnthropicCreate = vi
        .fn()
        .mockResolvedValueOnce({
          content: [{ type: 'text', text: 'Database-agnostic specification with runtime APIs' }],
        })
        .mockResolvedValueOnce({
          content: [{ type: 'text', text: '{"production_ready": true}' }],
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
        name: 'db-test-plugin',
        description: 'A plugin that must work with both Pglite and PostgreSQL',
        features: ['Memory storage', 'Data retrieval'],
      };

      const creator = new PluginCreator({
        skipPrompts: true,
        spec,
        skipTests: true,
      });

      const result = await creator.create();

      expect(result.success).toBe(true);

      // Verify specification generation includes database compatibility
      const specCall = mockAnthropicCreate.mock.calls[0][0];
      expect(specCall.messages[0].content).toContain('Database Compatibility (MANDATORY)');
      expect(specCall.messages[0].content).toContain('runtime.createMemory()');
      expect(specCall.messages[0].content).toContain('both Pglite and PostgreSQL');
    });

    it('should validate import compliance in production readiness', async () => {
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
      vi.mocked(fs.writeJSON).mockResolvedValue(undefined as any);
      vi.mocked(fs.copy).mockResolvedValue(undefined as any);
      vi.mocked(fs.readdir).mockResolvedValue(['src/index.ts'] as any);
      vi.mocked(fs.stat).mockResolvedValue({ isFile: () => true } as any);
      vi.mocked(fs.readFile).mockResolvedValue('import { Plugin } from "@elizaos/core";' as any);
      vi.mocked(fs.move).mockResolvedValue(undefined as any);

      const mockAnthropicCreate = vi
        .fn()
        .mockResolvedValueOnce({
          content: [{ type: 'text', text: 'Specification' }],
        })
        .mockResolvedValueOnce({
          content: [{ type: 'text', text: '{"production_ready": true}' }],
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
        name: 'import-test-plugin',
        description: 'Test plugin for import validation',
        features: ['Test imports'],
      };

      const creator = new PluginCreator({
        skipPrompts: true,
        spec,
        skipTests: true,
      });

      const result = await creator.create();

      expect(result.success).toBe(true);

      // Verify production validation includes import compliance checks
      const validationCall = mockAnthropicCreate.mock.calls[1][0];
      expect(validationCall.messages[0].content).toContain(
        'Import Compliance (CRITICAL - MANDATORY)'
      );
      expect(validationCall.messages[0].content).toContain('@elizaos/core ONLY');
      expect(validationCall.messages[0].content).toContain(
        'Database Compatibility (CRITICAL - MANDATORY)'
      );
    });
  });

  describe('database compatibility', () => {
    it('should generate plugins that work with both Pglite and PostgreSQL', async () => {
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
      vi.mocked(fs.writeJSON).mockResolvedValue(undefined as any);
      vi.mocked(fs.copy).mockResolvedValue(undefined as any);
      vi.mocked(fs.readdir).mockResolvedValue([] as any);
      vi.mocked(fs.stat).mockResolvedValue({ isFile: () => true } as any);
      vi.mocked(fs.readFile).mockResolvedValue('content' as any);
      vi.mocked(fs.move).mockResolvedValue(undefined as any);

      const mockAnthropicCreate = vi.fn().mockResolvedValue({
        content: [{ type: 'text', text: 'Database-agnostic plugin specification' }],
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
        name: 'memory-plugin',
        description: 'A plugin that stores and retrieves memories',
        features: ['Store memories', 'Search memories'],
        actions: ['storeMemory', 'searchMemory'],
      };

      const creator = new PluginCreator({
        skipPrompts: true,
        spec,
        skipTests: true,
        skipValidation: true,
      });

      const result = await creator.create();

      expect(result.success).toBe(true);
      expect(result.pluginName).toBe('memory-plugin');

      // Verify the generated specification includes database abstraction
      const specificationCall = mockAnthropicCreate.mock.calls[0][0];
      expect(specificationCall.messages[0].content).toContain('Database Compatibility (MANDATORY)');
      expect(specificationCall.messages[0].content).toContain('runtime.createMemory()');
      expect(specificationCall.messages[0].content).toContain('runtime.searchMemories()');
      expect(specificationCall.messages[0].content).toContain('both Pglite and PostgreSQL');
    });

    it('should include database compatibility test requirements', async () => {
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

      let writtenContent = '';
      vi.mocked(fs.writeFile).mockImplementation(async (path: any, content: any) => {
        if (path.includes('PLUGIN_SPEC.md')) {
          writtenContent = content;
        }
        return undefined as any;
      });

      vi.mocked(fs.writeJSON).mockResolvedValue(undefined as any);
      vi.mocked(fs.copy).mockResolvedValue(undefined as any);
      vi.mocked(fs.readdir).mockResolvedValue([] as any);
      vi.mocked(fs.stat).mockResolvedValue({ isFile: () => true } as any);
      vi.mocked(fs.readFile).mockResolvedValue('content' as any);
      vi.mocked(fs.move).mockResolvedValue(undefined as any);

      const mockAnthropicCreate = vi.fn().mockResolvedValue({
        content: [{ type: 'text', text: 'Database-agnostic specification' }],
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
        name: 'test-db-plugin',
        description: 'Test database compatibility',
        features: ['Database operations'],
      };

      const creator = new PluginCreator({
        skipPrompts: true,
        spec,
        skipTests: true,
        skipValidation: true,
      });

      await creator.create();

      // Verify PLUGIN_SPEC.md includes database compatibility requirements
      expect(writtenContent).toContain('Database Compatibility (MANDATORY)');
      expect(writtenContent).toContain('Pglite and PostgreSQL');
      expect(writtenContent).toContain('runtime.createMemory()');
      expect(writtenContent).toContain('Database compatibility tests');
      expect(writtenContent).toContain('PGLITE_DATA_DIR');
      expect(writtenContent).toContain('POSTGRES_URL');
    });
  });
});
