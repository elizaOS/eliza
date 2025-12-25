import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import { Command } from 'commander';
import { teeCommand } from '../../src/commands/tee';
import { phalaCliCommand } from '../../src/commands/tee/phala-wrapper';
import { bunExecSync } from '../utils/bun-test-helpers';
import { TEST_TIMEOUTS } from '../test-timeouts';

// Check if npx is available
function isNpxAvailable(): boolean {
  try {
    bunExecSync('npx --version', { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

// Skip Phala tests in CI or when npx is not available
const skipPhalaTests = process.env.CI === 'true' || !isNpxAvailable();

describe('TEE Command', { timeout: TEST_TIMEOUTS.SUITE_TIMEOUT }, () => {
  describe('teeCommand', () => {
    it('should be a Commander command', () => {
      expect(teeCommand).toBeInstanceOf(Command);
    });

    it('should have correct name and description', () => {
      expect(teeCommand.name()).toBe('tee');
      expect(teeCommand.description()).toBe('Manage TEE deployments');
    });

    it('should have phala subcommand', () => {
      const subcommands = teeCommand.commands.map((cmd) => cmd.name());
      expect(subcommands).toContain('phala');
    });

    it('should have enablePositionalOptions set', () => {
      expect((teeCommand as unknown as { _enablePositionalOptions: boolean })._enablePositionalOptions).toBe(true);
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
      expect((phalaCliCommand as unknown as { _allowUnknownOption: boolean })._allowUnknownOption).toBe(true);
    });

    it('should have help disabled', () => {
      // Check that help option is disabled by checking if it doesn't have the default -h flag
      const helpOption = phalaCliCommand.options.find((opt) => opt.short === '-h');
      expect(helpOption).toBeUndefined();
    });

    it('should allow excess arguments', () => {
      expect((phalaCliCommand as unknown as { _allowExcessArguments: boolean })._allowExcessArguments).toBe(true);
    });

    it('should have passthrough options enabled', () => {
      expect((phalaCliCommand as unknown as { _passThroughOptions: boolean })._passThroughOptions).toBe(true);
    });

    it('should have variadic arguments configured', () => {
      const args = (phalaCliCommand as unknown as { _args: Array<{ variadic: boolean; name: () => string }> })._args || [];
      expect(args.length).toBeGreaterThan(0);
      expect(args[0].variadic).toBe(true);
      // The name property is actually a function that returns the name
      expect(typeof args[0].name).toBe('function');
      expect(args[0].name()).toBe('args');
    });

    it.skipIf(skipPhalaTests)('should have action handler configured', () => {
      // Verify the command has an action handler
      expect((phalaCliCommand as unknown as { _actionHandler: unknown })._actionHandler).toBeDefined();
      expect(typeof (phalaCliCommand as unknown as { _actionHandler: unknown })._actionHandler).toBe('function');
    });

    it('should pass arguments to phala CLI', () => {
      // Test that the command accepts arguments
      const testArgs = ['node', 'test', 'cvms', 'list'];

      // This should not throw an error
      expect(() => {
        phalaCliCommand.parseOptions(testArgs);
      }).not.toThrow();

      // Verify unknown options are allowed
      const testArgsWithOptions = ['node', 'test', '--some-option', 'value'];
      expect(() => {
        phalaCliCommand.parseOptions(testArgsWithOptions);
      }).not.toThrow();
    });

    it('should parse complex argument patterns', () => {
      const testArgs = [
        'node',
        'test',
        'deploy',
        '--project',
        'my-app',
        '--memory',
        '512',
        '--cpus',
        '1',
        '--json',
        '-v',
      ];

      // This should not throw an error
      expect(() => {
        phalaCliCommand.parseOptions(testArgs);
      }).not.toThrow();
    });

    it('should handle mixed positional and flag arguments', () => {
      const testArgs = ['node', 'test', 'auth', 'login', 'test-key', '--force', '--output', 'json'];

      // This should not throw an error
      expect(() => {
        phalaCliCommand.parseOptions(testArgs);
      }).not.toThrow();
    });

    it('should handle arguments containing "phala" without confusion', () => {
      // Test that arguments containing 'phala' don't confuse the command extraction
      const testArgs = [
        'node',
        'script',
        'tee',
        'phala', // The actual command
        'deploy',
        '--project',
        'my-phala-app', // Argument value containing 'phala'
        '--name',
        'phala-test', // Another argument containing 'phala'
      ];

      // This should not throw an error
      expect(() => {
        phalaCliCommand.parseOptions(testArgs);
      }).not.toThrow();
    });
  });
});
