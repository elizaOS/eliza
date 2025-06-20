import { handleError } from '@/src/utils';
import { Command } from 'commander';
import colors from 'yoctocolors';
import { editEnvVars } from './actions/edit';
import { showMainMenu } from './actions/interactive';
import { handleListCommand } from './actions/list';
import { resetEnv } from './actions/reset';
import { EditEnvOptions, InteractiveEnvOptions, ListEnvOptions, ResetEnvOptions } from './types';

// Create command for managing environment variables
export const env = new Command()
  .name('env')
  .description('Manage environment variables and secrets');

// List subcommand
env
  .command('list')
  .description('List all environment variables')
  .option('--system', 'List only system information')
  .option('--local', 'List only local environment variables')
  .action(async (options: ListEnvOptions) => {
    try {
      await handleListCommand(options);
    } catch (error) {
      handleError(error);
    }
  });

// Edit local subcommand
env
  .command('edit-local')
  .description('Edit local environment variables')
  .option('-y, --yes', 'Automatically confirm prompts')
  .action(async (options: EditEnvOptions) => {
    try {
      await editEnvVars(options);
    } catch (error) {
      handleError(error);
    }
  });

// Reset subcommand
env
  .command('reset')
  .description(
    'Reset environment variables and clean up database/cache files (interactive selection)'
  )
  .option('-y, --yes', 'Automatically reset using default selections')
  .action(async (options: ResetEnvOptions) => {
    try {
      await resetEnv(options);
    } catch (error) {
      handleError(error);
    }
  });

// Interactive mode
env
  .command('interactive')
  .description('Interactive environment variable management')
  .option('-y, --yes', 'Automatically confirm prompts')
  .action(async (options: InteractiveEnvOptions) => {
    try {
      await showMainMenu(options);
    } catch (error) {
      handleError(error);
    }
  });

// Default command (show help if no subcommand provided)
env.action(() => {
  // Show available subcommands
  console.log(colors.bold('\nEliza Environment Variable Manager'));
  console.log('\nAvailable commands:');
  console.log('  list                  List all environment variables');
  console.log('  edit-local            Edit local environment variables');
  console.log(
    '  reset                 Reset environment variables and clean up database/cache files (interactive selection)'
  );
  console.log('  interactive           Start interactive environment variable manager');
  console.log('\nYou can also edit environment variables in the web UI:');
  console.log('  http://localhost:3000/settings');
});

// Re-export for backward compatibility
export * from './actions/edit';
export * from './actions/interactive';
export * from './actions/list';
export * from './actions/reset';
export * from './types';
export * from './utils/directory-operations';
export * from './utils/file-operations';
export * from './utils/validation';
