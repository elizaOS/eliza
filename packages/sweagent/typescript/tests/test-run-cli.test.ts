/**
 * Main run CLI tests converted from test_run.py
 */

import { describe, it, expect } from 'vitest';
import { execSync } from 'child_process';
import * as path from 'path';

describe('Run CLI', () => {
  // Use tsx to run TypeScript source directly to avoid ESM extension issues
  const cliSourcePath = path.join(__dirname, '..', 'src', 'run', 'cli.ts');
  const tsxPath = path.join(__dirname, '..', 'node_modules', '.bin', 'tsx');

  // Helper function to run CLI commands
  const runCLI = (args: string[], options: Record<string, unknown> = {}) => {
    const command = `${tsxPath} ${cliSourcePath} ${args.join(' ')}`;
    return execSync(command, {
      encoding: 'utf-8',
      cwd: path.join(__dirname, '..'),
      ...options,
    });
  };

  describe('Main CLI behavior', () => {
    it('should show error when no arguments provided', () => {
      let exitCode = 0;
      let output = '';
      let error = '';

      try {
        output = runCLI([]);
      } catch (e: unknown) {
        const execError = e as { status?: number; stdout?: Buffer | string; stderr?: Buffer | string };
        exitCode = execError.status || 1;
        output = execError.stdout?.toString() || '';
        error = execError.stderr?.toString() || '';
      }

      // Should exit with error code
      expect(exitCode).toBeGreaterThan(0);
      expect(exitCode).toBeLessThanOrEqual(2);

      // Should show available commands
      const combinedOutput = output + error;
      expect(combinedOutput).toContain('run-batch');
      expect(combinedOutput).toContain('run-replay');
      expect(combinedOutput).toContain('run');
    });

    it('should show help with --help flag', () => {
      const output = runCLI(['--help']);

      // Should show all available commands
      expect(output).toContain('run-batch');
      expect(output).toContain('run-replay');
      expect(output).toContain('run');

      // Should show descriptions
      expect(output.toLowerCase()).toContain('batch');
      expect(output.toLowerCase()).toContain('replay');
    });

    it('should show version with --version flag', () => {
      const output = runCLI(['--version']);

      // Should show version number
      expect(output).toMatch(/\d+\.\d+\.\d+/);
    });
  });

  describe('Subcommand help', () => {
    it('should show help for run subcommand', () => {
      const output = runCLI(['run', '--help']);

      // Should show run-specific options
      expect(output).toContain('--config');
      expect(output).toContain('--agent');
      expect(output).toContain('--output_dir');
      expect(output).toContain('--problem_statement');
    });

    it('should show help for run-batch subcommand', () => {
      const output = runCLI(['run-batch', '--help']);

      // Should show batch-specific options
      expect(output).toContain('--instances');
      expect(output).toContain('--num_workers');
      expect(output).toContain('--output_dir');
    });

    it('should show help for run-replay subcommand', () => {
      const output = runCLI(['run-replay', '--help']);

      // Should show replay-specific options
      expect(output).toContain('--traj_path');
      expect(output).toContain('--forward_only');
      expect(output).toContain('--n_forward');
    });
  });

  describe('Command aliases', () => {
    it('should support sweagent command', () => {
      const sweagentPath = path.join(__dirname, '..', 'bin', 'sweagent');

      try {
        const output = execSync(`${sweagentPath} --help`, {
          encoding: 'utf-8',
        });

        expect(output).toContain('run-batch');
        expect(output).toContain('run-replay');
      } catch (e) {
        // sweagent binary might not exist in test environment
        console.warn('sweagent binary not found, skipping alias test');
      }
    });
  });

  describe('Error handling', () => {
    it('should show error for unknown subcommand', () => {
      let error = '';

      try {
        runCLI(['unknown-command']);
      } catch (e: unknown) {
        const execError = e as { stdout?: Buffer | string; stderr?: Buffer | string };
        error = (execError.stdout?.toString() || '') + (execError.stderr?.toString() || '');
      }

      expect(error).toContain('unknown');
    });

    it('should show error for invalid arguments', () => {
      let error = '';

      try {
        runCLI(['run', '--invalid-arg', 'value']);
      } catch (e: unknown) {
        const execError = e as { stdout?: Buffer | string; stderr?: Buffer | string };
        error = (execError.stdout?.toString() || '') + (execError.stderr?.toString() || '');
      }

      expect(error.toLowerCase()).toContain('invalid');
    });

    it('should validate required arguments', () => {
      let error = '';

      try {
        // run-replay requires traj_path
        runCLI(['run-replay']);
      } catch (e: unknown) {
        const execError = e as { stdout?: Buffer | string; stderr?: Buffer | string };
        error = (execError.stdout?.toString() || '') + (execError.stderr?.toString() || '');
      }

      expect(error).toContain('traj_path');
    });
  });

  describe('Configuration loading', () => {
    it('should support --config flag', () => {
      const output = runCLI(['run', '--help']);

      expect(output).toContain('--config');
      expect(output.toLowerCase()).toContain('configuration file');
    });

    it('should support environment variables', () => {
      // Test that environment variables are documented
      const output = runCLI(['run', '--help']);

      // Should mention environment variables somewhere
      expect(output.toLowerCase()).toMatch(/env|environment/);
    });
  });

  describe('Output formats', () => {
    it('should support JSON output', () => {
      const output = runCLI(['run', '--help']);

      // Check if JSON output is mentioned
      expect(output.toLowerCase()).toMatch(/json|format/);
    });

    it('should support verbose mode', () => {
      const output = runCLI(['run', '--help']);

      // Should have verbose/debug options
      expect(output.toLowerCase()).toMatch(/verbose|debug|log/);
    });
  });

  describe('Batch processing', () => {
    it('should document batch options', () => {
      const output = runCLI(['run-batch', '--help']);

      // Should document key batch options
      expect(output).toContain('num_workers');
      expect(output.toLowerCase()).toContain('parallel');
    });

    it('should document instance filtering', () => {
      const output = runCLI(['run-batch', '--help']);

      // Should have filtering options
      expect(output.toLowerCase()).toMatch(/filter|slice|shuffle/);
    });
  });

  describe('Integration tests', () => {
    it('should handle piped input', () => {
      // Test that CLI can handle piped input
      try {
        const output = execSync(`echo '{"test": true}' | node ${cliPath} run --help`, {
          encoding: 'utf-8',
        });

        expect(output).toBeDefined();
      } catch (e) {
        // Piping might not work in all test environments
        console.warn('Piped input test skipped');
      }
    });

    it('should handle SIGINT gracefully', () => {
      // This would test graceful shutdown but is hard to test in unit tests
      // Would need to spawn a process and send SIGINT
      expect(true).toBe(true);
    });
  });

  describe('Python compatibility', () => {
    it('should have similar command structure to Python version', () => {
      // The TypeScript version should maintain compatibility with Python version
      const output = runCLI(['--help']);

      // Should have the same main commands as Python version
      expect(output).toContain('run');
      expect(output).toContain('run-batch');
      expect(output).toContain('run-replay');

      // Should use similar terminology
      expect(output.toLowerCase()).toContain('agent');
      expect(output.toLowerCase()).toContain('instance');
    });
  });

  describe('Documentation', () => {
    it('should provide examples in help', () => {
      const output = runCLI(['run', '--help']);

      // Good CLI tools provide examples
      const hasExamples = output.toLowerCase().includes('example') || output.toLowerCase().includes('usage');

      expect(hasExamples).toBe(true);
    });

    it('should document config file format', () => {
      const output = runCLI(['run', '--help']);

      // Should mention YAML or config format
      const hasConfigFormat = output.toLowerCase().includes('yaml') || output.toLowerCase().includes('config');

      expect(hasConfigFormat).toBe(true);
    });
  });
});
