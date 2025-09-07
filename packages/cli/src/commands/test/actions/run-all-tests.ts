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
  let componentResult = { failed: false };
  if (!options.skipBuild) {
    componentResult = await runComponentTests(testPath, options, projectInfo);
  } else {
    logger.info('Skipping component tests due to --skip-build option');
  }

  // Run e2e tests
  const e2eResult = await runE2eTests(testPath, options, projectInfo);

  // Check results and exit appropriately
  if (componentResult.failed || e2eResult.failed) {
    if (componentResult.failed) {
      logger.error('Component tests failed.');
    }
    if (e2eResult.failed) {
      logger.error('E2E tests failed.');
    }
    logger.error('Test suite failed.');
    process.exit(1);
  }

  logger.success('All tests passed successfully!');
  process.exit(0);
}
