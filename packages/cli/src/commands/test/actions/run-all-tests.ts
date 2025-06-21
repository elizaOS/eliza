import { logger } from '@elizaos/core';
import { TestCommandOptions } from '../types';
import { getProjectType } from '../utils/project-utils';
import { runComponentTests } from './component-tests';
import { runE2eTests } from './e2e-tests';
import { runCypressTests } from './cypress-tests';
import { runScenarioTests } from './scenario-tests';

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
      logger.error('Component tests failed. Stopping test execution.');
      process.exit(1);
    }
    logger.success('Component tests passed!');
  }

  // Run e2e tests
  const e2eResult = await runE2eTests(testPath, options, projectInfo);
  if (e2eResult.failed) {
    logger.error('E2E tests failed.');
    // Give async operations time to complete
    await new Promise((resolve) => setTimeout(resolve, 100));
    process.exit(1);
  }
  logger.success('E2E tests passed!');

  // Run Cypress tests if available
  const cypressResult = await runCypressTests(testPath, options, projectInfo);
  if (cypressResult.failed) {
    logger.error('Cypress tests failed.');
    process.exit(1);
  }
  logger.success('Cypress tests passed!');

  // Run scenario tests
  const scenarioResult = await runScenarioTests(testPath, options);
  if (scenarioResult.failed) {
    logger.error('Scenario tests failed.');
    process.exit(1);
  }
  logger.success('Scenario tests passed!');

  logger.success('All tests passed successfully!');
  // Give async operations time to complete before exiting
  await new Promise((resolve) => setTimeout(resolve, 100));
  process.exit(0);
}
