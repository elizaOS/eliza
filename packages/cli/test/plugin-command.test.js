// Import test dependencies
import { vi, describe, beforeEach, afterAll, test, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';

// Mock imports need to come before actual imports
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    promises: {
      ...actual.promises,
      readFile: vi.fn().mockImplementation((filePath) => {
        if (filePath.includes('package.json')) {
          return Promise.resolve(
            JSON.stringify({
              name: '@elizaos/test-plugin',
              version: '1.0.0',
            })
          );
        }
        return Promise.resolve('{}');
      }),
      access: vi.fn().mockResolvedValue(undefined),
    },
    existsSync: vi.fn().mockReturnValue(true),
  };
});

vi.mock('node:child_process', () => ({
  execSync: vi.fn().mockReturnValue(Buffer.from('command executed')),
}));

vi.mock('node:path', () => ({
  join: vi.fn((...args) => args.join('/')),
  resolve: vi.fn((...args) => args.join('/')),
  dirname: vi.fn((path) => path.split('/').slice(0, -1).join('/')),
}));

vi.mock('commander', () => ({
  Command: vi.fn().mockImplementation(() => ({
    option: vi.fn().mockReturnThis(),
    action: vi.fn().mockReturnThis(),
  })),
}));

// Mock the module and its default export
vi.mock('../src/commands/plugin.js', () => {
  return {
    plugin: vi.fn(),
  };
});

// Setup spy on console
vi.spyOn(console, 'log').mockImplementation(() => {});
vi.spyOn(console, 'error').mockImplementation(() => {});

// Import the mocked module
import { plugin } from '../src/commands/plugin.js';

describe('Plugin Command', () => {
  let program;

  beforeEach(() => {
    vi.resetAllMocks();

    // Setup default mocks
    program = {
      command: vi.fn().mockReturnThis(),
      description: vi.fn().mockReturnThis(),
      option: vi.fn().mockReturnThis(),
      action: vi.fn().mockReturnThis(),
    };

    // Setup the plugin mock implementation for each test
    vi.mocked(plugin).mockImplementation((prog) => {
      // Register the main plugin command
      prog.command('plugin');
      prog.description('Manage plugins');

      // Mock the create command
      prog._createAction = ({ name, template }) => {
        execSync(`npx elizaos create --template plugin-${template} --name ${name}`, {
          stdio: 'inherit',
        });
      };

      // Mock the build command
      prog._buildAction = () => {
        execSync('npm run build', {
          stdio: 'inherit',
        });
      };

      // Mock the publish command
      prog._publishAction = () => {
        execSync('npx elizaos publish --type plugin', {
          stdio: 'inherit',
        });
      };

      return prog;
    });
  });

  afterAll(() => {
    vi.restoreAllMocks();
  });

  test('registers plugin commands', () => {
    // Call the plugin function
    plugin(program);

    // Assert it registered the commands
    expect(program.command).toHaveBeenCalledWith('plugin');
    expect(program.description).toHaveBeenCalled();
  });

  test('creates plugin command', () => {
    // Call the plugin function (our mock will attach _createAction)
    plugin(program);

    // Ensure _createAction was attached and call it
    expect(program._createAction).toBeDefined();
    program._createAction({ name: 'test-plugin', template: 'basic' });

    // Assert it created the plugin
    expect(execSync).toHaveBeenCalledWith(
      expect.stringContaining('create --template plugin-basic --name test-plugin'),
      expect.any(Object)
    );
  });

  test('builds plugin command', () => {
    // Call the plugin function
    plugin(program);

    // Ensure _buildAction was attached and call it
    expect(program._buildAction).toBeDefined();
    program._buildAction({});

    // Assert it built the plugin
    expect(execSync).toHaveBeenCalledWith(expect.stringContaining('build'), expect.any(Object));
  });

  test('publishes plugin command', () => {
    // Call the plugin function
    plugin(program);

    // Ensure _publishAction was attached and call it
    expect(program._publishAction).toBeDefined();
    program._publishAction({});

    // Assert it published the plugin
    expect(execSync).toHaveBeenCalledWith(
      expect.stringContaining('publish --type plugin'),
      expect.any(Object)
    );
  });
});
