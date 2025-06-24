import { handleError } from '@/src/utils';
import { validatePort } from '@/src/utils/port-validation';
import { logger } from '@elizaos/core';
import { Command, Option } from 'commander';
import { runAllTests } from './actions/run-all-tests';
import { runComponentTests } from './actions/component-tests';
import { runE2eTests } from './actions/e2e-tests';
import { TestCommandOptions } from './types';
import { getProjectType, installPluginDependencies } from './utils/project-utils';

// Create base test command with basic description only
export const test = new Command()
  .name('test')
  .description('Run tests for the current project or a specified plugin')
  .argument('[path]', 'Optional path to the project or plugin to test')
  .addOption(
    new Option('-t, --type <type>', 'the type of test to run')
      .choices(['component', 'e2e', 'all'])
      .default('all')
  )
  .option('--port <port>', 'The port to run e2e tests on', validatePort)
  .option('--name <name>', 'Filter tests by name')
  .option('--skip-build', 'Skip building before running tests')
  .option('--skip-type-check', 'Skip TypeScript validation before running tests')
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

// This is the function that registers the command with the CLI
export default function registerCommand(cli: Command) {
  return cli.addCommand(test);
}

// Re-export for backward compatibility
export * from './actions/component-tests';
export * from './actions/e2e-tests';
export * from './actions/run-all-tests';
export * from './types';
export * from './utils/project-utils';
export * from './utils/port-utils';
export * from './utils/plugin-utils';
