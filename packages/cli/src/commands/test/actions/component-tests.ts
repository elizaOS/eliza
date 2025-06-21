import { buildProject } from '@/src/utils';
import { type DirectoryInfo } from '@/src/utils/directory-detection';
import { logger } from '@elizaos/core';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { ComponentTestOptions, TestResult } from '../types';
import { processFilterName } from '../utils/project-utils';
import { runTypeCheck } from '@/src/utils/testing/tsc-validator';
// import { createVitestConfig } from '../utils/vitest-config'; // Available for custom vitest configurations
import { existsSync } from 'node:fs';

/**
 * Run component tests using bun test
 *
 * Executes component tests for the project using bun test as the test runner. Supports filtering by test name and can optionally skip the build step for faster iteration.
 */
export async function runComponentTests(
  testPath: string | undefined,
  options: ComponentTestOptions,
  projectInfo: DirectoryInfo
): Promise<TestResult> {
  const cwd = process.cwd();
  const isPlugin = projectInfo.type === 'elizaos-plugin';

  // Run TypeScript validation first
  if (!options.skipTypeCheck) {
    logger.info('Running TypeScript validation...');
    const typeCheckResult = await runTypeCheck(cwd, true);

    if (!typeCheckResult.success) {
      logger.error('TypeScript validation failed:');
      typeCheckResult.errors.forEach((error) => logger.error(error));
      return { failed: true };
    }
    logger.success('TypeScript validation passed');
  }
  // Build the project or plugin first unless skip-build is specified
  if (!options.skipBuild) {
    try {
      logger.info(`Building ${isPlugin ? 'plugin' : 'project'}...`);
      await buildProject(cwd, isPlugin);
      logger.success(`Build completed successfully`);
    } catch (buildError) {
      logger.error(`Build failed: ${buildError}`);
      // Return immediately on build failure
      return { failed: true };
    }
  }

  logger.info('Running component tests...');

  return new Promise((resolve) => {
    // Build command arguments
    const args = ['test', '--passWithNoTests'];

    // Add filter if specified
    if (options.name) {
      const baseName = processFilterName(options.name);
      if (baseName) {
        logger.info(`Using test filter: ${baseName}`);
        args.push('-t', baseName);
      }
    }

    // Don't pass include/exclude patterns from config - vitest will use its own config file
    const targetPath = testPath ? path.resolve(process.cwd(), '..', testPath) : process.cwd();

    // Check if vitest config exists in the target directory
    const hasVitestConfig =
      existsSync(path.join(targetPath, 'vitest.config.ts')) ||
      existsSync(path.join(targetPath, 'vitest.config.js')) ||
      existsSync(path.join(targetPath, 'vitest.config.mjs'));

    // Vitest will use its own config file if it exists
    if (!hasVitestConfig) {
      logger.info('No vitest config found, using default configuration');
    }

    logger.info(`Executing: bun ${args.join(' ')} in ${targetPath}`);

    // Use spawn for real-time output streaming
    const child = spawn('bun', args, {
      stdio: 'inherit',
      shell: false,
      cwd: targetPath,
      env: {
        ...process.env,
        FORCE_COLOR: '1',
        CI: 'false',
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
