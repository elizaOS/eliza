import * as clack from '@clack/prompts';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { EditEnvOptions, EnvVars } from '../types';
import { getLocalEnvPath, parseEnvFile, writeEnvFile } from '../utils/file-operations';
import { maskedValue } from '../utils/validation';

/**
 * Interactive environment variable editor for local .env files.
 *
 * Provides an interactive menu to edit existing variables, add new variables, and delete variables from the local .env file. Supports auto-confirmation mode for non-interactive usage.
 *
 * @param options - Edit command options
 * @param fromMainMenu - Whether this command was called from the main menu (affects return behavior)
 * @returns Promise<boolean> - Whether to return to main menu
 */
export async function editEnvVars(options: EditEnvOptions, fromMainMenu = false): Promise<boolean> {
  const { yes } = options;
  const localEnvPath = await getLocalEnvPath();

  if (!localEnvPath || !existsSync(localEnvPath)) {
    // No local .env file exists, check if we can create one from .env.example
    const exampleEnvPath = path.join(process.cwd(), '.env.example');
    const hasExample = existsSync(exampleEnvPath);

    if (hasExample) {
      console.log('No local .env file found. Create one with:');
      console.log('  cp .env.example .env');
    } else {
      console.log('No local .env file found in the current directory.');
      console.log('Create a .env file to set local environment variables.');
    }
    return fromMainMenu;
  }

  // Parse the current environment variables
  const envVars = await parseEnvFile(localEnvPath);

  // Handle empty .env file
  if (Object.keys(envVars).length === 0) {
    console.log('Local .env file is empty.');

    // Offer to add a new variable if not in auto-confirm mode
    const addNew = yes
      ? false
      : await clack.confirm({
          message: 'Would you like to add a new environment variable?',
          initialValue: true,
        });

    if (clack.isCancel(addNew)) {
      clack.cancel('Operation cancelled.');
      process.exit(0);
    }

    if (addNew) {
      await addNewVariable(localEnvPath, envVars, yes);
    }

    return fromMainMenu; // Return to main menu if we came from there
  }

  // Keep looping until the user chooses to exit
  let exit = false;
  let returnToMain = false;

  // If -y flag is used, just exit successfully without user interaction
  if (yes) {
    console.log('✅ Environment variables displayed. Use interactive mode without -y to edit.');
    return fromMainMenu;
  }

  while (!exit) {
    // Create menu choices from the environment variables
    const entries = Object.entries(envVars);
    const choices = [
      ...entries.map(([key, value]) => ({
        title: `${key}: ${maskedValue(value)}`,
        value: key,
      })),
      { title: 'Add new variable', value: 'add_new' },
      fromMainMenu
        ? { title: 'Back to main menu', value: 'back_to_main' }
        : { title: 'Exit', value: 'exit' },
    ];

    // Prompt user to select a variable or action
    const selection = await clack.select({
      message: 'Select a variable to edit or an action:',
      options: choices.map((choice) => ({
        value: choice.value,
        label: choice.title,
      })),
    });

    if (clack.isCancel(selection)) {
      clack.cancel('Operation cancelled.');
      process.exit(0);
    }

    if (!selection) {
      // If user cancels (Ctrl+C), go back to main menu if we came from there
      return fromMainMenu;
    }

    if (selection === 'exit' || selection === 'back_to_main') {
      exit = true;
      returnToMain = selection === 'back_to_main';
      continue;
    }

    if (selection === 'add_new') {
      await addNewVariable(localEnvPath, envVars, yes);
      continue;
    }

    // User selected a variable, prompt for action
    const action = await clack.select({
      message: `What would you like to do with ${selection}?`,
      options: [
        { label: 'Edit', value: 'edit' },
        { label: 'Delete', value: 'delete' },
        { label: 'Back', value: 'back' },
      ],
    });

    if (clack.isCancel(action)) {
      clack.cancel('Operation cancelled.');
      process.exit(0);
    }

    if (!action || action === 'back') {
      continue;
    }

    if (action === 'edit') {
      const value = await clack.text({
        message: `Enter the new value for ${selection}:`,
        defaultValue: envVars[selection],
      });

      if (clack.isCancel(value)) {
        clack.cancel('Operation cancelled.');
        process.exit(0);
      }

      if (value !== undefined) {
        envVars[selection] = value;
        await writeEnvFile(localEnvPath, envVars);
        console.log(`✓ Updated ${selection}`);
      }
    } else if (action === 'delete') {
      let confirm = true;
      if (!yes) {
        const resp = await clack.confirm({
          message: `Are you sure you want to delete ${selection}?`,
          initialValue: false,
        });

        if (clack.isCancel(resp)) {
          clack.cancel('Operation cancelled.');
          process.exit(0);
        }

        confirm = resp;
      }
      if (confirm) {
        delete envVars[selection];
        await writeEnvFile(localEnvPath, envVars);
        console.log(`✓ Removed ${selection}`);
      }
    }
  }

  return returnToMain && fromMainMenu;
}

/**
 * Helper function to add a new environment variable
 * @param envPath Path to the .env file
 * @param envVars Current environment variables
 * @param yes Whether to auto-confirm prompts
 */
async function addNewVariable(envPath: string, envVars: EnvVars, yes = false): Promise<void> {
  if (yes) {
    console.log(
      'Auto-confirmation mode enabled - skipping variable addition in edit-local -y mode'
    );
    return;
  }

  const key = await clack.text({
    message: 'Enter the variable name:',
    validate: (value) => (value.trim() !== '' ? undefined : 'Variable name cannot be empty'),
  });

  if (clack.isCancel(key)) {
    clack.cancel('Operation cancelled.');
    process.exit(0);
  }

  if (!key) return;

  const value = await clack.text({
    message: `Enter the value for ${key}:`,
    defaultValue: '',
  });

  if (clack.isCancel(value)) {
    clack.cancel('Operation cancelled.');
    process.exit(0);
  }

  if (value !== undefined) {
    envVars[key] = value;
    await writeEnvFile(envPath, envVars);
    console.log(`✓ Added ${key}`);
  }
}
