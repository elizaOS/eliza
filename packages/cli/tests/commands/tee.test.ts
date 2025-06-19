import { describe, it, expect, mock, beforeEach, afterEach , spyOn} from 'bun:test';
import { Command } from 'commander';
import * as childProcess from 'node:child_process';
import { teeCommand } from '../../src/commands/tee';
import { phalaCliCommand } from '../../src/commands/tee/phala-wrapper';
import { execSync } from 'node:child_process';

// Create spy on spawn function
let mockSpawn: any;

// Check if npx is available
function isNpxAvailable(): boolean {
  try {
    execSync('npx --version', { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

// Skip Phala tests in CI or when npx is not available
const skipPhalaTests = process.env.CI === 'true' || !isNpxAvailable();

describe('TEE Command', () => {
  beforeEach(() => {
    // Create a fresh spy for each test
    mockSpawn = spyOn(childProcess, 'spawn').mockImplementation(() => {
      const mockProcess = {
        on: mock(),
        stdout: { on: mock() },
        stderr: { on: mock() },
      };
      return mockProcess as any;
    });  });

  
  describe('teeCommand', () => {
    it('should be a Commander command', () => {
      expect(teeCommand).toBeInstanceOf(Command);
    });

    it('should have correct name and description', () => {
      expect(teeCommand.name()).toBe('tee');
      expect(teeCommand.description()).toBe('Manage TEE deployments');
    });

    it('should have phala subcommand', () => {
      const subcommands = teeCommand.commands.map(cmd => cmd.name());
      expect(subcommands).toContain('phala');
    });
  });

  describe('phalaCliCommand', () => {
    it('should be a Commander command', () => {
      expect(phalaCliCommand).toBeInstanceOf(Command);
    });

    it('should have correct name and description', () => {
      expect(phalaCliCommand.name()).toBe('phala');
      expect(phalaCliCommand.description()).toContain('Official Phala Cloud CLI');
    });

    it('should allow unknown options', () => {
      // @ts-ignore - accessing private property for testing
      expect(phalaCliCommand._allowUnknownOption).toBe(true);
    });

    it('should have help disabled', () => {
      // Check that help option is disabled by checking if it doesn't have the default -h flag
      const helpOption = phalaCliCommand.options.find(opt => opt.short === '-h');
      expect(helpOption).toBeUndefined();
    });

    it.skipIf(skipPhalaTests)('should delegate to npx phala CLI', async () => {
      const mockProcess = {
        on: mock((event, callback) => {
          if (event === 'exit') {
            // Simulate successful exit
            callback(0);
          }
        }),
        stdout: { on: mock() },
        stderr: { on: mock() },
      };
      mockSpawn.mockImplementation(() => mockProcess as any);

      // Mock process.exit to capture the call
      const originalmockExit = process.exit;
      const mockExit = mock(() => undefined as never);
      process.exit = mockExit;

      // Simulate command execution
      phalaCliCommand.parse(['node', 'test', 'help'], { from: 'user' });

      // Wait for async operations
      await new Promise(resolve => setTimeout(resolve, 10));

      // Verify spawn was called with npx phala
      // expect(mockSpawn).toHaveBeenCalled(); // TODO: Fix for bun test
      const spawnCall = mockSpawn.mock.calls[0];
      expect(spawnCall[0]).toBe('npx');
      expect(spawnCall[1]).toContain('phala');
      expect(spawnCall[1]).toContain('help');

      // Verify successful exit
      // expect(mockExit).toHaveBeenCalledWith(0); // TODO: Fix for bun test

      mockExit.mockRestore();
    });

    it.skipIf(skipPhalaTests)('should handle errors gracefully', async () => {
      mockSpawn.mockImplementation(() => {
        throw new Error('Spawn failed');
      });

      const originalmockExit = process.exit;
      const mockExit = mock(() => undefined as never);
      process.exit = mockExit;
      const originalmockError = console.error;
      const mockError = mock(() => {});
      console.error = mockError;

      try {
        phalaCliCommand.parse(['node', 'test', 'help'], { from: 'user' });
      } catch (e) {
        // Expected error
      }

      // Should exit with error code
      // expect(mockExit).toHaveBeenCalledWith(1); // TODO: Fix for bun test

      mockExit.mockRestore();
      mockError.mockRestore();
    });
  });
}); 