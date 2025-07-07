import { execa } from 'execa';
import * as clack from '@clack/prompts';
import colors from 'yoctocolors';
import { logger } from '@elizaos/core';

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

    const result = await execa(command, args, {
      cwd: options.cwd || process.cwd(),
      stdio: 'pipe',
      reject: false,
    });

    if (result.exitCode === 0) {
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

  const result = await runBunWithSpinner(['add', `@elizaos/plugin-${pluginName}`], targetDir, {
    spinnerText: `Installing ${pluginName} plugin${purposeText}...`,
    successText: colors.green(`✓ ${pluginName} plugin installed successfully`),
    errorText: `Failed to install ${pluginName} plugin`,
    showOutputOnError: false, // Don't show verbose output for plugin failures
  });

  if (!result.success) {
    // Don't throw, just warn - plugin installation is not critical
    logger.warn(`Could not install ${pluginName} plugin automatically: ${result.error?.message}`);
    logger.info(`💡 You can install it manually with: elizaos plugins add ${pluginName}`);
  }
}

/**
 * Create a task for use with clack.tasks()
 */
export function createTask(title: string, fn: () => Promise<any>) {
  return { title, task: fn };
}

/**
 * Run multiple tasks with clack.tasks()
 */
export async function runTasks(
  tasks: Array<{ title: string; task: () => Promise<any> }>
): Promise<void> {
  await clack.tasks(tasks);
}
