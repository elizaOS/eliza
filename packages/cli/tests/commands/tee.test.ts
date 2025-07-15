import { beforeEach, describe, expect, it, mock } from 'bun:test';
import { Command } from 'commander';
import { teeCommand } from '../../src/commands/tee';
import { phalaCliCommand } from '../../src/commands/tee/phala-wrapper';
import { bunExecSync } from '../utils/bun-test-helpers';

// Mock spawn function

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

describe('TEE Command', () => {
  // Since the implementation still uses Node's spawn, we need to mock the module
  // The tests are checking the behavior, not the implementation detail
  beforeEach(() => {
    // Tests are skipped in CI or when npx is not available
    // So mocking is only for local development testing
  });

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
      const helpOption = phalaCliCommand.options.find((opt) => opt.short === '-h');
      expect(helpOption).toBeUndefined();
    });

    it.skipIf(skipPhalaTests)('should have action handler configured', () => {
      // Verify the command has an action handler
      expect(phalaCliCommand._actionHandler).toBeDefined();
      expect(typeof phalaCliCommand._actionHandler).toBe('function');
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
  });
});
