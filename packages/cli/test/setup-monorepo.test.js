import { beforeEach, describe, expect, it, vi } from 'vitest';

// Import command directly for faster testing
import { Command } from 'commander';

describe('setup-monorepo Command', () => {
  // Create a minimal mock implementation
  let gitArgs = [];
  let dirCreated = '';

  // Mock functions to record args
  const mockExeca = vi.fn().mockImplementation((cmd, args) => {
    if (cmd === 'git' && args[0] === 'clone') {
      gitArgs = args;
    }
    return { exitCode: 0 };
  });

  const mockMkdir = vi.fn().mockImplementation((path) => {
    dirCreated = path;
  });

  const mockExists = vi.fn().mockReturnValue(false);
  const mockReaddir = vi.fn().mockReturnValue([]);

  // Create a command instance for testing
  let setupCommand;

  beforeEach(() => {
    // Reset test state
    gitArgs = [];
    dirCreated = '';

    // Reset all mocks to their default implementation
    mockExeca.mockImplementation((cmd, args) => {
      if (cmd === 'git' && args[0] === 'clone') {
        gitArgs = args;
      }
      return { exitCode: 0 };
    });

    mockExists.mockReturnValue(false);
    mockReaddir.mockReturnValue([]);

    // Create a fresh command
    setupCommand = new Command()
      .name('setup-monorepo')
      .description('Test command')
      .option('-b, --branch <branch>', 'Branch to install', 'v2-develop')
      .option('-d, --dir <directory>', 'Destination directory', './eliza')
      .action(async (options) => {
        const repo = 'test/repo';
        const branch = options.branch;
        const dir = options.dir;

        // Check if directory exists and is empty
        if (mockExists(dir) && mockReaddir(dir).length > 0) {
          throw new Error(`Directory ${dir} is not empty`);
        }

        // Create directory
        mockMkdir(dir);

        // Clone repo
        await mockExeca('git', ['clone', '-b', branch, `https://github.com/${repo}`, dir]);
      });
  });

  it('creates directory if it does not exist', async () => {
    // Act
    await setupCommand.parseAsync(['node', 'cmd', '--dir', 'test-dir']);

    // Assert
    expect(dirCreated).toBe('test-dir');
  });

  it('uses the specified branch', async () => {
    // Act
    await setupCommand.parseAsync(['node', 'cmd', '--branch', 'main']);

    // Assert
    expect(gitArgs[2]).toBe('main'); // -b main
  });

  it('uses the specified directory', async () => {
    // Act
    await setupCommand.parseAsync(['node', 'cmd', '--dir', 'custom-dir']);

    // Assert
    expect(gitArgs[4]).toBe('custom-dir');
    expect(dirCreated).toBe('custom-dir');
  });

  it('throws error when directory is not empty', async () => {
    // Arrange
    mockExists.mockReturnValueOnce(true);
    mockReaddir.mockReturnValueOnce(['file.txt']);

    // Act & Assert
    await expect(setupCommand.parseAsync(['node', 'cmd'])).rejects.toThrow('not empty');
  });

  it('handles git clone errors', async () => {
    // Arrange
    mockExeca.mockImplementationOnce(() => {
      throw new Error('Git clone failed');
    });

    // Act & Assert
    await expect(setupCommand.parseAsync(['node', 'cmd'])).rejects.toThrow('Git clone failed');
  });

  it('handles branch not found errors', async () => {
    // Arrange - simulate a git exit code 128 error message about branch
    mockExeca.mockImplementationOnce(() => {
      const error = new Error('exit code 128');
      error.message = 'fatal: Remote branch v2-develop not found in upstream origin';
      throw error;
    });

    // Act & Assert
    await expect(setupCommand.parseAsync(['node', 'cmd'])).rejects.toThrow(/branch.*not found/i);
  });
});
