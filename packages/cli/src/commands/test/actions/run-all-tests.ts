import { logger } from '@elizaos/core';
import { TestCommandOptions } from '../types';
import { getProjectType } from '../utils/project-utils';
import { runComponentTests } from './component-tests';
import { runE2eTests } from './e2e-tests';

/**
 * Run both component and E2E tests
 *
 * Executes a comprehensive test suite including both component tests (via bun test) and end-to-end tests (via TestRunner). Component tests run first, followed by e2e tests.
 */
export async function runAllTests(
  testPath: string | undefined,
  options: TestCommandOptions
): Promise<void> {
  // Run component tests first
  const projectInfo = getProjectType(testPath);
  if (!options.skipBuild) {
    const componentResult = await runComponentTests(testPath, options, projectInfo);
    if (componentResult.failed) {
      logger.error('Component tests failed. Continuing to e2e tests...');
    }
  }

  // Run e2e tests
  const e2eResult = await runE2eTests(testPath, options, projectInfo);
  if (e2eResult.failed) {
    logger.error('E2E tests failed.');
    process.exit(1);
  }

  logger.success('All tests passed successfully!');
  process.exit(0);
}
