import * as clack from '@clack/prompts';
import { InteractiveEnvOptions } from '../types';
import { listEnvVars } from './list';
import { editEnvVars } from './edit';
import { resetEnv } from './reset';

/**
 * Display the main menu for environment variables
 *
 * Provides an interactive menu system for managing environment variables, including listing, editing, and resetting operations.
 */
export async function showMainMenu(options: InteractiveEnvOptions): Promise<void> {
  const { yes } = options;

  // Interactive mode always requires user input, so ignore the -y flag
  let exit = false;

  while (!exit) {
    const action = await clack.select({
      message: 'Select an action:',
      options: [
        { label: 'List environment variables', value: 'list' },
        { label: 'Edit local environment variables', value: 'edit_local' },
        { label: 'Reset environment variables', value: 'reset' },
        { label: 'Exit', value: 'exit' },
      ],
    });

    if (clack.isCancel(action)) {
      clack.cancel('Operation cancelled.');
      process.exit(0);
    }
    if (!action || action === 'exit') {
      exit = true;
      continue;
    }

    switch (action) {
      case 'list':
        await listEnvVars();
        break;
      case 'edit_local': {
        const returnToMainFromLocal = await editEnvVars({ yes }, true);
        exit = !returnToMainFromLocal;
        break;
      }
      case 'reset':
        await resetEnv({ yes });
        break;
    }
  }
}
