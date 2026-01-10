import { describe, expect, it, vi, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { logger, IAgentRuntime, Plugin } from '@elizaos/core';
import { character } from '../src/index';
import plugin from '../src/plugin';
import { createMockRuntime } from './test-utils';
import * as os from 'os';

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
const isCI = Boolean(process.env.CI) || process.env.NODE_ENV === 'test';

/**
 * Integration tests demonstrate how multiple components of the project work together.
 * Unlike unit tests that test individual functions in isolation, integration tests
 * examine how components interact with each other.
 */
describe('Integration: Project Structure and Components', () => {
  it('should have a valid package structure', () => {
    const srcDir = path.join(process.cwd(), 'src');
    expect(fs.existsSync(srcDir)).toBe(true);

    // Check for required source files - only checking core files
    const srcFiles = [path.join(srcDir, 'index.ts'), path.join(srcDir, 'plugin.ts')];

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
  it('should have character with required properties', () => {
    // Verify character has required properties
    expect(character).toHaveProperty('name');
    expect(character).toHaveProperty('plugins');
    expect(character).toHaveProperty('bio');
    expect(character).toHaveProperty('system');
    expect(character).toHaveProperty('messageExamples');

    // Verify plugins is an array
    expect(Array.isArray(character.plugins)).toBe(true);
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
  it('should create a mock runtime with character and plugin', async () => {
    // Create a custom mock runtime for this test
    const customMockRuntime = {
      character: { ...character },
      plugins: [],
      registerPlugin: vi.fn().mockImplementation((plugin: Plugin) => {
        // In a real runtime, registering the plugin would call its init method,
        // but since we're testing init itself, we just need to record the call
        return Promise.resolve();
      }),
      initialize: vi.fn(),
      getService: vi.fn(),
      getSetting: vi.fn().mockReturnValue(null),
      useModel: vi.fn().mockResolvedValue('Test model response'),
      getProviderResults: vi.fn().mockResolvedValue([]),
      evaluateProviders: vi.fn().mockResolvedValue([]),
      evaluate: vi.fn().mockResolvedValue([]),
    } as unknown as IAgentRuntime;

    // Ensure we're testing safely - to avoid parallel test race conditions
    const originalInit = plugin.init;
    let initCalled = false;

    // Mock the plugin.init method using vi.fn instead of direct assignment
    if (plugin.init) {
      plugin.init = vi.fn(async (config, runtime) => {
        // Set flag to indicate our wrapper was called
        initCalled = true;

        // Call original if it exists
        if (originalInit) {
          await originalInit(config, runtime);
        }

        // Register plugin
        await runtime.registerPlugin(plugin);
      });
    }

    try {
      // Initialize plugin in runtime
      if (plugin.init) {
        await plugin.init({ EXAMPLE_PLUGIN_VARIABLE: 'test-value' }, customMockRuntime);
      }

      // Verify our wrapper was called
      expect(initCalled).toBe(true);

      // Check if registerPlugin was called
      expect(customMockRuntime.registerPlugin).toHaveBeenCalled();
    } catch (error) {
      console.error('Error initializing plugin:', error);
      throw error;
    } finally {
      // Restore the original init method to avoid affecting other tests
      plugin.init = originalInit;
    }
  });
});

// Skip scaffolding tests in CI environments as they modify the filesystem
const describeScaffolding = isCI ? describe.skip : describe;
describeScaffolding('Integration: Project Scaffolding', () => {
  // Create a temp directory for testing the scaffolding
  const TEST_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'eliza-test-'));

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
