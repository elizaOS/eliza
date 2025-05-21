import { describe, expect, it, vi, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { logger, IAgentRuntime } from '@elizaos/core';
import { character } from '../src/index';
import plugin from '../src/plugin';

// Set up spies on logger
beforeAll(() => {
  vi.spyOn(logger, 'info').mockImplementation(() => {});
  vi.spyOn(logger, 'error').mockImplementation(() => {});
  vi.spyOn(logger, 'warn').mockImplementation(() => {});
  vi.spyOn(logger, 'debug').mockImplementation(() => {});
});

afterAll(() => {
  vi.restoreAllMocks();
});

// Skip in CI environments or when running automated tests without interaction
const isCI = process.env.CI === 'true' || process.env.NODE_ENV === 'test';

/**
 * Integration tests demonstrate how multiple components of the project work together.
 * Unlike unit tests that test individual functions in isolation, integration tests
 * examine how components interact with each other.
 */
describe('Integration: Project Structure and Components', () => {
  it('should have a valid package structure', () => {
    const srcDir = path.join(process.cwd(), 'src');
    expect(fs.existsSync(srcDir)).toBe(true);

    // Check for required source files
    const srcFiles = [
      path.join(srcDir, 'index.ts'),
      path.join(srcDir, 'plugin.ts'),
      path.join(srcDir, 'character.ts'),
    ];

    srcFiles.forEach((file) => {
      expect(fs.existsSync(file)).toBe(true);
    });
  });

  it('should have dist directory for build outputs', () => {
    const distDir = path.join(process.cwd(), 'dist');

    // Skip directory content validation if dist doesn't exist yet
    if (!fs.existsSync(distDir)) {
      logger.warn('Dist directory does not exist yet. Build the project first.');
      return;
    }

    expect(fs.existsSync(distDir)).toBe(true);
  });
});

describe('Integration: Character and Plugin', () => {
  it('should properly integrate character with plugins', () => {
    // Verify character includes the plugin
    expect(character.plugins).toContain(plugin.name);

    // Verify character has required properties
    expect(character).toHaveProperty('name');
    expect(character).toHaveProperty('bio');
    expect(character).toHaveProperty('system');
    expect(character).toHaveProperty('messageExamples');
  });

  it('should configure plugin correctly', () => {
    // Verify plugin has necessary components that character will use
    expect(plugin).toHaveProperty('name');
    expect(plugin).toHaveProperty('description');
    expect(plugin).toHaveProperty('init');

    // Check if plugin has actions, models, providers, etc. that character might use
    const components = ['models', 'actions', 'providers', 'services', 'routes', 'events'];
    components.forEach((component) => {
      if (plugin[component]) {
        // Just verify if these exist, we don't need to test their functionality here
        // Those tests belong in plugin.test.ts, actions.test.ts, etc.
        expect(
          Array.isArray(plugin[component]) || typeof plugin[component] === 'object'
        ).toBeTruthy();
      }
    });
  });
});

describe('Integration: Runtime Initialization', () => {
  it('should create a mock runtime with character and plugin', () => {
    // Create a minimal mock runtime for testing initialization
    const mockRuntime = {
      character: { ...character },
      plugins: [plugin],
      registerPlugin: vi.fn(),
      initialize: vi.fn(),
      // Add minimal required properties to satisfy the interface
      agentId: 'test-agent-id',
      providers: [],
      actions: [],
      evaluators: [],
      services: new Map(),
      events: new Map(),
      routes: [],
      getService: vi.fn(),
      getSetting: vi.fn(),
    } as unknown as IAgentRuntime;

    // Initialize plugin in runtime
    expect(async () => {
      if (plugin.init) {
        await plugin.init({}, mockRuntime);
      }
      await mockRuntime.initialize();
    }).not.toThrow();

    // Check if registerPlugin was called for our plugin
    if (plugin.init) {
      expect(mockRuntime.registerPlugin).toHaveBeenCalled();
    }
  });
});

// Skip scaffolding tests in CI environments as they modify the filesystem
describe.skipIf(isCI)('Integration: Project Scaffolding', () => {
  // Create a temp directory for testing the scaffolding
  const TEST_DIR = path.join(process.cwd(), 'test-project');

  beforeAll(() => {
    // Create test directory if it doesn't exist
    if (!fs.existsSync(TEST_DIR)) {
      fs.mkdirSync(TEST_DIR, { recursive: true });
    }
  });

  afterAll(() => {
    // Clean up test directory
    if (fs.existsSync(TEST_DIR)) {
      fs.rmSync(TEST_DIR, { recursive: true, force: true });
    }
  });

  it('should scaffold a new project correctly', () => {
    try {
      // This is a simple simulation of the scaffolding process
      // In a real scenario, you'd use the CLI or API to scaffold

      // Copy essential files to test directory
      const srcFiles = ['index.ts', 'plugin.ts', 'character.ts'];

      for (const file of srcFiles) {
        const sourceFilePath = path.join(process.cwd(), 'src', file);
        const targetFilePath = path.join(TEST_DIR, file);

        if (fs.existsSync(sourceFilePath)) {
          fs.copyFileSync(sourceFilePath, targetFilePath);
        }
      }

      // Create package.json in test directory
      const packageJson = {
        name: 'test-project',
        version: '1.0.0',
        type: 'module',
        dependencies: {
          '@elizaos/core': 'workspace:*',
        },
      };

      fs.writeFileSync(path.join(TEST_DIR, 'package.json'), JSON.stringify(packageJson, null, 2));

      // Verify files exist
      expect(fs.existsSync(path.join(TEST_DIR, 'index.ts'))).toBe(true);
      expect(fs.existsSync(path.join(TEST_DIR, 'plugin.ts'))).toBe(true);
      expect(fs.existsSync(path.join(TEST_DIR, 'character.ts'))).toBe(true);
      expect(fs.existsSync(path.join(TEST_DIR, 'package.json'))).toBe(true);
    } catch (error) {
      logger.error('Error in scaffolding test:', error);
      throw error;
    }
  });
});
