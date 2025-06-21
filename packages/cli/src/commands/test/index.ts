import { handleError } from '@/src/utils';
import { validatePort } from '@/src/utils/port-validation';
import { logger } from '@elizaos/core';
import { Command, Option } from 'commander';
import { runAllTests } from './actions/run-all-tests';
import { runComponentTests } from './actions/component-tests';
import { runE2eTests } from './actions/e2e-tests';
import { runCypressTests } from './actions/cypress-tests';
import { runScenarioTests } from './actions/scenario-tests';
import { TestCommandOptions } from './types';
import { getProjectType, installPluginDependencies } from './utils/project-utils';

// Create base test command with basic description only
export const test = new Command()
  .name('test')
  .description('Run tests for the current project or a specified plugin')
  .argument('[path]', 'Optional path to the project or plugin to test')
  .addOption(
    new Option('-t, --type <type>', 'the type of test to run')
      .choices(['component', 'e2e', 'cypress', 'scenario', 'all'])
      .default('all')
  )
  .option('-p, --port <port>', 'the port to run e2e tests on', validatePort)
  .option('--name <name>', 'filter tests by name')
  .option('--skip-build', 'skip the build step before running tests')
  .option('--skip-type-check', 'skip TypeScript validation before running tests')
  .hook('preAction', async (thisCommand) => {
    // Install plugin dependencies before running tests
    const testPath = thisCommand.args[0];
    const projectInfo = getProjectType(testPath);
    await installPluginDependencies(projectInfo);
  })
  .action(async (testPath: string | undefined, options: TestCommandOptions) => {
    logger.info('Starting tests...');

    try {
      const projectInfo = getProjectType(testPath);

      switch (options.type) {
        case 'component':
          logger.info('Running component tests only...');
          const componentResult = await runComponentTests(testPath, options, projectInfo);
          if (componentResult.failed) {
            logger.error('Component tests failed.');
            process.exit(1);
          }
          logger.success('Component tests passed successfully!');
          break;

        case 'e2e':
          logger.info('Running e2e tests only...');
          const e2eResult = await runE2eTests(testPath, options, projectInfo);
          if (e2eResult.failed) {
            logger.error('E2E tests failed.');
            process.exit(1);
          }
          logger.success('E2E tests passed successfully!');
          break;

        case 'cypress':
          logger.info('Running Cypress tests only...');
          const cypressResult = await runCypressTests(testPath, options, projectInfo);
          if (cypressResult.failed) {
            logger.error('Cypress tests failed.');
            process.exit(1);
          }
          logger.success('Cypress tests passed successfully!');
          break;

        case 'scenario':
          logger.info('Running scenario tests only...');
          const scenarioResult = await runScenarioTests(testPath, options);
          if (scenarioResult.failed) {
            logger.error('Scenario tests failed.');
            process.exit(1);
          }
          logger.success('Scenario tests passed successfully!');
          break;

        case 'all':
        default:
          logger.info('Running all tests...');
          await runAllTests(testPath, options);
          break;
      }

      process.exit(0);
    } catch (error) {
      handleError(error);
    }
  });

// Add duplicate options for backward compatibility (the original had duplicated options)
test
  .addOption(
    new Option('-p, --port <port>', 'Server port for e2e tests (default: 3000)').argParser(
      validatePort
    )
  )
  .option('-n, --name <n>', 'Filter tests by name (matches file names or test suite names)')
  .option('--skip-build', 'Skip building before running tests');

// Export the command as default
export default test;

// Re-export for backward compatibility
export * from './actions/component-tests';
export * from './actions/e2e-tests';
export * from './actions/run-all-tests';
export * from './actions/cypress-tests';
export * from './actions/scenario-tests';
export * from './types';
export * from './utils/project-utils';
export * from './utils/port-utils';
export * from './utils/plugin-utils';
export * from './utils/server-utils';
export * from './utils/agent-utils';
