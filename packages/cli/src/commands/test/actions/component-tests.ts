import { buildProject } from '@/src/utils';
import { type DirectoryInfo } from '@/src/utils/directory-detection';
import { logger } from '@elizaos/core';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { ComponentTestOptions, TestResult } from '../types';
import { processFilterName } from '../utils/project-utils';

/**
 * Run component tests using Vitest
 *
 * Executes component tests for the project using Vitest as the test runner. Supports filtering by test name and can optionally skip the build step for faster iteration.
 */
export async function runComponentTests(
  testPath: string | undefined,
  options: ComponentTestOptions,
  projectInfo: DirectoryInfo
): Promise<TestResult> {
  // Build the project or plugin first unless skip-build is specified
  if (!options.skipBuild) {
    try {
      const cwd = process.cwd();
      const isPlugin = projectInfo.type === 'elizaos-plugin';
      logger.info(`Building ${isPlugin ? 'plugin' : 'project'}...`);
      await buildProject(cwd, isPlugin);
      logger.info(`Build completed successfully`);
    } catch (buildError) {
      logger.error(`Build error: ${buildError}`);
      logger.warn(`Attempting to continue with tests despite build error`);
    }
  }

  logger.info('Running component tests...');

  return new Promise((resolve) => {
    // Build command arguments
    const args = ['run', 'vitest', 'run', '--passWithNoTests', '--reporter=default'];

    // Add filter if specified
    if (options.name) {
      const baseName = processFilterName(options.name);
      if (baseName) {
        logger.info(`Using test filter: ${baseName}`);
        args.push('-t', baseName);
      }
    }

    const targetPath = testPath ? path.resolve(process.cwd(), '..', testPath) : process.cwd();
    logger.info(`Executing: bun ${args.join(' ')} in ${targetPath}`);

    // Use spawn for real-time output streaming
    const child = spawn('bun', args, {
      stdio: 'inherit',
      shell: false,
      cwd: targetPath,
      env: {
        ...process.env,
        FORCE_COLOR: '1', // Force color output
        CI: 'false', // Ensure we're not in CI mode which might buffer
      },
    });

    child.on('close', (code) => {
      logger.info('Component tests completed');
      resolve({ failed: code !== 0 });
    });

    child.on('error', (error) => {
      logger.error('Error running component tests:', error);
      resolve({ failed: true });
    });
  });
}
