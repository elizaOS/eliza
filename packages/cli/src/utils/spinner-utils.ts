import { bunExec } from './bun-exec.js';
import * as clack from '@clack/prompts';
import colors from 'yoctocolors';
import { parseBooleanFromText, logger } from '@elizaos/core';

/**
 * Check if quiet mode is enabled
 */
export function isQuietMode(): boolean {
  return parseBooleanFromText(process.env.QUIET_MODE);
}

interface SpinnerCommandOptions {
  cwd?: string;
  spinnerText: string;
  successText: string;
  errorText?: string;
  showOutputOnError?: boolean;
}

interface CommandResult {
  success: boolean;
  stdout?: string;
  stderr?: string;
  error?: Error;
}

/**
 * Core function to run any command with a spinner
 */
export async function runCommandWithSpinner(
  command: string,
  args: string[],
  options: SpinnerCommandOptions
): Promise<CommandResult> {
  const spinner = clack.spinner();

  try {
    spinner.start(options.spinnerText);

    const result = await bunExec(command, args, {
      cwd: options.cwd || process.cwd(),
    });

    if (result.success) {
      spinner.stop(options.successText);
      return {
        success: true,
        stdout: result.stdout,
        stderr: result.stderr,
      };
    } else {
      const errorMessage = options.errorText || `Command failed with exit code ${result.exitCode}`;
      spinner.stop(colors.red(errorMessage));

      // Show captured output on error for debugging
      if (options.showOutputOnError !== false) {
        if (result.stdout) {
          console.error(colors.dim('stdout:'), result.stdout);
        }
        if (result.stderr) {
          console.error(colors.dim('stderr:'), result.stderr);
        }
      }

      return {
        success: false,
        stdout: result.stdout,
        stderr: result.stderr,
        error: new Error(`${errorMessage}: ${result.stderr || result.stdout}`),
      };
    }
  } catch (error) {
    const errorMessage = options.errorText || 'Command execution failed';
    spinner.stop(colors.red(errorMessage));

    return {
      success: false,
      error: error as Error,
    };
  }
}

/**
 * Run a bun command with spinner
 */
export async function runBunWithSpinner(
  args: string[],
  cwd: string,
  options: Partial<SpinnerCommandOptions>
): Promise<CommandResult> {
  return runCommandWithSpinner('bun', args, {
    cwd,
    spinnerText: options.spinnerText || 'Running bun command...',
    successText: options.successText || colors.green('✓ Command completed successfully'),
    errorText: options.errorText,
    showOutputOnError: options.showOutputOnError,
  });
}

/**
 * Install dependencies with spinner
 */
export async function installDependenciesWithSpinner(targetDir: string): Promise<void> {
  // Skip in CI/test environments
  if (process.env.CI === 'true' || process.env.ELIZA_TEST_MODE === 'true') {
    return;
  }

  const result = await runBunWithSpinner(['install'], targetDir, {
    spinnerText: 'Installing dependencies...',
    successText: colors.green('✓ Dependencies installed successfully'),
    errorText: 'Failed to install dependencies',
  });

  if (!result.success) {
    throw result.error || new Error('Dependency installation failed');
  }
}

/**
 * Build project with spinner
 */
export async function buildProjectWithSpinner(targetDir: string, isPlugin = false): Promise<void> {
  if (process.env.ELIZA_TEST_MODE) {
    return;
  }

  const projectType = isPlugin ? 'plugin' : 'project';

  const result = await runBunWithSpinner(['run', 'build'], targetDir, {
    spinnerText: `Building ${projectType}...`,
    successText: colors.green(
      `✓ ${projectType.charAt(0).toUpperCase() + projectType.slice(1)} built successfully`
    ),
    errorText: `Failed to build ${projectType}`,
  });

  if (!result.success) {
    throw result.error || new Error(`${projectType} build failed`);
  }
}

/**
 * Install plugin with spinner (non-critical, warns on failure)
 */
export async function installPluginWithSpinner(
  pluginName: string,
  targetDir: string,
  purpose = ''
): Promise<void> {
  const purposeText = purpose ? ` ${purpose}` : '';
  const packageName = `@elizaos/plugin-${pluginName}`;

  // Skip in test environments
  if (process.env.CI === 'true' || process.env.ELIZA_TEST_MODE === 'true') {
    return;
  }

  const spinner = clack.spinner();
  spinner.start(`Installing ${packageName}${purposeText}...`);

  try {
    const result = await bunExec('bun', ['add', packageName], {
      cwd: targetDir,
    });

    if (result.success) {
      spinner.stop(colors.green(`✓ ${packageName} installed successfully`));
    } else {
      // Log warning but don't throw - plugin installation is non-critical
      spinner.stop(colors.yellow(`⚠ Failed to install ${packageName} (optional)`));

      // Log to debug for troubleshooting
      logger.debug(`Plugin installation failed: ${packageName}`, {
        exitCode: result.exitCode,
        stderr: result.stderr,
        stdout: result.stdout,
      });
    }
  } catch (error) {
    // Log warning but don't throw - plugin installation is non-critical
    spinner.stop(colors.yellow(`⚠ Failed to install ${packageName} (optional)`));

    logger.debug(`Plugin installation error: ${packageName}`, error);
  }
}

/**
 * Create a task for use with clack.tasks()
 */
export function createTask(title: string, fn: () => Promise<any>) {
  return {
    title,
    task: async () => {
      await fn();
      return `${title} completed`;
    },
  };
}

/**
 * Run multiple tasks with clack.tasks()
 */
export async function runTasks(
  tasks: Array<{ title: string; task: () => Promise<any> }>
): Promise<void> {
  await clack.tasks(tasks);
}
