import { handleError, UserEnvironment } from '@/src/utils';
import { stringToUuid, resolvePgliteDir, resolveEnvFile } from '@elizaos/core';
import { Command } from 'commander';
import dotenv from 'dotenv';
import { existsSync } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import prompts from 'prompts';
import { rimraf } from 'rimraf';
import colors from 'yoctocolors';

/**
 * Get the path to the project's .env file.
 * @returns The path to the .env file
 */
export async function getGlobalEnvPath(): Promise<string> {
  const envPath = resolveEnvFile();
  return envPath;
}

/**
 * Get the path to the local .env file in the current directory
 * @returns The path to the local .env file or null if not found
 */
function getLocalEnvPath(): string | null {
  const envPath = resolveEnvFile();
  return existsSync(envPath) ? envPath : null;
}

/**
 * Parse an .env file and return the key-value pairs
 * @param filePath Path to the .env file
 * @returns Object containing the key-value pairs
 */
export async function parseEnvFile(filePath: string): Promise<Record<string, string>> {
  try {
    if (!existsSync(filePath)) {
      // Log a warning instead of just returning {} silently
      console.warn(`Attempted to parse non-existent env file: ${filePath}`);
      return {};
    }

    const content = await fs.readFile(filePath, 'utf-8');
    // Handle empty file case gracefully
    if (content.trim() === '') {
      return {};
    }
    return dotenv.parse(content);
  } catch (error) {
    console.error(`Error parsing .env file at ${filePath}: ${error.message}`);
    return {};
  }
}

/**
 * Write key-value pairs to an .env file
 * @param filePath Path to the .env file
 * @param envVars Object containing the key-value pairs
 */
async function writeEnvFile(filePath: string, envVars: Record<string, string>): Promise<void> {
  try {
    const dir = path.dirname(filePath);
    if (!existsSync(dir)) {
      await fs.mkdir(dir, { recursive: true });
    }

    const content = Object.entries(envVars)
      .map(([key, value]) => `${key}=${value}`)
      .join('\n');

    await fs.writeFile(filePath, content);
    console.log(`Environment variables updated at ${filePath}`);
  } catch (error) {
    console.error(`Error writing .env file at ${filePath}: ${error.message}`);
  }
}

/**
 * Displays system information and lists environment variables from the project's `.env` file.
 *
 * Prints platform, architecture, CLI version, and package manager details, followed by environment variables with sensitive values masked. Indicates if no variables are set and provides a link to the web UI for editing.
 */
async function listEnvVars(): Promise<void> {
  const envInfo = await UserEnvironment.getInstanceInfo();
  const localEnvPath = getLocalEnvPath();

  // Display system information
  console.info(colors.bold('\nSystem Information:'));
  console.info(`  Platform: ${colors.cyan(envInfo.os.platform)} (${envInfo.os.release})`);
  console.info(`  Architecture: ${colors.cyan(envInfo.os.arch)}`);
  console.info(`  CLI Version: ${colors.cyan(envInfo.cli.version)}`);
  console.info(
    `  Package Manager: ${colors.cyan(envInfo.packageManager.name)}${envInfo.packageManager.version ? ` v${envInfo.packageManager.version}` : ''}`
  );

  // Display local environment section
  console.info(colors.bold('\nLocal Environment Variables:'));
  const localEnvFilePath = getLocalEnvPath();
  console.info(`Path: ${localEnvFilePath ?? path.join(process.cwd(), '.env')}`);

  if (!localEnvFilePath || !existsSync(localEnvFilePath)) {
    // No local .env file exists, provide guidance to the user
    console.info(colors.yellow('  No local .env file found'));

    // Check if .env.example exists and suggest copying it as a starting point
    const exampleEnvPath = path.join(process.cwd(), '.env.example');
    if (existsSync(exampleEnvPath)) {
      console.info(colors.red('  ✖ Missing .env file. Create one with:'));
      console.info(`     ${colors.bold(colors.green('cp .env.example .env'))}`);
    } else {
      console.info(
        colors.red(
          '  ✖ Missing .env file. Create one in your project directory to set local environment variables.'
        )
      );
    }
  } else {
    // .env file exists, parse and display its contents
    const localEnvVars = await parseEnvFile(localEnvFilePath);
    if (Object.keys(localEnvVars).length === 0) {
      console.info('  No local environment variables set');
    } else {
      for (const [key, value] of Object.entries(localEnvVars)) {
        console.info(`  ${colors.green(key)}: ${maskedValue(value)}`);
      }
    }
  }

  console.info('\n');
  console.info(
    colors.cyan(
      'You can also edit environment variables in the web UI: http://localhost:3000/settings'
    )
  );
}

/**
 * Mask sensitive values in environment variables
 * @param value The value to mask
 * @returns The masked value
 */
function maskedValue(value: string): string {
  if (!value) return '';

  // If the value looks like a token/API key (longer than 20 chars, no spaces), mask it
  if (value.length > 20 && !value.includes(' ')) {
    return `${value.substring(0, 4)}...${value.substring(value.length - 4)}`;
  }

  return value;
}

/**
 * Edit environment variables
 * @param scope Edit local environment variables
 * @returns A boolean indicating whether the user wants to go back to the main menu
 */
async function editEnvVars(scope: 'local', fromMainMenu = false, yes = false): Promise<boolean> {
  const envPath = getLocalEnvPath();

  if (scope === 'local' && !envPath) {
    let createLocal = true;
    if (!yes) {
      const resp = await prompts({
        type: 'confirm',
        name: 'createLocal',
        message: 'No local .env file found. Create one?',
        initial: true,
      });
      createLocal = resp.createLocal;
    }
    if (!createLocal) {
      return false;
    }
    await fs.writeFile('.env', '');
  }

  const envVars = await parseEnvFile(envPath);

  // List current variables first
  console.info(colors.bold(`\nCurrent ${scope} environment variables:`));
  if (Object.keys(envVars).length === 0) {
    console.info(`  No ${scope} environment variables set`);

    // If no variables exist, offer to add new ones
    const { addNew } = await prompts({
      type: 'confirm',
      name: 'addNew',
      message: 'Would you like to add a new environment variable?',
      initial: true,
    });

    if (addNew) {
      await addNewVariable(envPath, envVars);
    }

    return fromMainMenu; // Return to main menu if we came from there
  }

  // Keep looping until the user chooses to exit
  let exit = false;
  let returnToMain = false;

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
    const { selection } = await prompts({
      type: 'select',
      name: 'selection',
      message: 'Select a variable to edit or an action:',
      choices,
    });

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
      await addNewVariable(envPath, envVars);
      continue;
    }

    // User selected a variable, prompt for action
    const { action } = await prompts({
      type: 'select',
      name: 'action',
      message: `What would you like to do with ${selection}?`,
      choices: [
        { title: 'Edit', value: 'edit' },
        { title: 'Delete', value: 'delete' },
        { title: 'Back', value: 'back' },
      ],
    });

    if (!action || action === 'back') {
      continue;
    }

    if (action === 'edit') {
      const { value } = await prompts({
        type: 'text',
        name: 'value',
        message: `Enter the new value for ${selection}:`,
        initial: envVars[selection],
      });

      if (value !== undefined) {
        envVars[selection] = value;
        await writeEnvFile(envPath, envVars);
        console.log(`Updated ${scope} environment variable: ${selection}`);
      }
    } else if (action === 'delete') {
      let confirm = true;
      if (!yes) {
        const resp = await prompts({
          type: 'confirm',
          name: 'confirm',
          message: `Are you sure you want to delete ${selection}?`,
          initial: false,
        });
        confirm = resp.confirm;
      }
      if (confirm) {
        delete envVars[selection];
        await writeEnvFile(envPath, envVars);
        console.log(`Removed ${scope} environment variable: ${selection}`);
      }
    }
  }

  return returnToMain && fromMainMenu;
}

/**
 * Helper function to add a new environment variable
 * @param envPath Path to the .env file
 * @param envVars Current environment variables
 */
async function addNewVariable(envPath: string, envVars: Record<string, string>): Promise<void> {
  const { key } = await prompts({
    type: 'text',
    name: 'key',
    message: 'Enter the variable name:',
    validate: (value) => (value.trim() !== '' ? true : 'Variable name cannot be empty'),
  });

  if (!key) return;

  const { value } = await prompts({
    type: 'text',
    name: 'value',
    message: `Enter the value for ${key}:`,
  });

  if (value !== undefined) {
    envVars[key] = value;
    await writeEnvFile(envPath, envVars);
    console.log(`Added environment variable: ${key}`);
  }
}

/**
 * Helper function to reset an environment file by keeping keys but clearing values
 * @param filePath Path to the environment file
 * @returns A boolean indicating success/failure
 */
async function resetEnvFile(filePath: string): Promise<boolean> {
  try {
    if (!existsSync(filePath)) {
      return false;
    }

    const envVars = await parseEnvFile(filePath);
    if (Object.keys(envVars).length === 0) {
      return false; // No variables to reset
    }

    const resetVars = Object.keys(envVars).reduce(
      (acc, key) => {
        acc[key] = '';
        return acc;
      },
      {} as Record<string, string>
    );

    await writeEnvFile(filePath, resetVars);
    return true;
  } catch (error) {
    console.error(`Error resetting environment file at ${filePath}: ${error.message}`);
    return false;
  }
}

// Reset operation types and helper functions
type ResetTarget = 'localEnv' | 'cache' | 'localDb';
type ResetAction = 'reset' | 'deleted' | 'skipped' | 'warning';

interface ResetItem {
  title: string;
  value: ResetTarget;
  description?: string;
  selected?: boolean;
}

/**
 * Delete a directory with error handling
 * @param dir Directory path to delete
 * @param actions Action log collection to update
 * @param label Description label for this operation
 * @returns Success or failure
 */
async function safeDeleteDirectory(
  dir: string,
  actions: Record<string, string[]>,
  label: string
): Promise<boolean> {
  if (!existsSync(dir)) {
    actions.skipped.push(`${label} (not found)`);
    return false;
  }

  try {
    await rimraf(dir);
    if (!existsSync(dir)) {
      actions.deleted.push(label);
      return true;
    } else {
      actions.warnings.push(`Failed to delete ${label.toLowerCase()}`);
      return false;
    }
  } catch (error) {
    actions.warnings.push(`Failed to delete ${label.toLowerCase()}: ${error.message}`);
    return false;
  }
}

/**
 * Reset environment variables and selected folders
 */
async function resetEnv(yes = false): Promise<void> {
  // Get all relevant paths
  const homeDir = os.homedir();
  const elizaDir = path.join(homeDir, '.eliza');
  const cacheDir = path.join(elizaDir, 'cache');

  const localEnvPath = getLocalEnvPath() ?? path.join(process.cwd(), '.env');
  const localDbDir = resolvePgliteDir();

  // Check if external Postgres is in use
  let usingExternalPostgres = false;
  let usingPglite = false;
  try {
    const localEnvVars = existsSync(localEnvPath) ? await parseEnvFile(localEnvPath) : {};

    // Check for external Postgres
    usingExternalPostgres = localEnvVars.POSTGRES_URL && localEnvVars.POSTGRES_URL.trim() !== '';

    // Check for PGLite
    usingPglite = localEnvVars.PGLITE_DATA_DIR && localEnvVars.PGLITE_DATA_DIR.trim() !== '';
  } catch (error) {
    // Ignore errors in env parsing
    console.debug('Error checking database config:', error.message);
  }

  // Create reset item options
  const resetItems: ResetItem[] = [
    {
      title: 'Local environment variables',
      value: 'localEnv',
      description: existsSync(localEnvPath)
        ? 'Reset values in local .env file'
        : 'Local .env file not found, nothing to reset',
      selected: existsSync(localEnvPath),
    },
    {
      title: 'Cache folder',
      value: 'cache',
      description: existsSync(cacheDir)
        ? 'Delete the cache folder'
        : 'Cache folder not found, nothing to delete',
      selected: existsSync(cacheDir),
    },
    {
      title: 'Local database files',
      value: 'localDb',
      description: existsSync(localDbDir)
        ? 'Delete local database files'
        : 'Local database folder not found, nothing to delete',
      selected: existsSync(localDbDir),
    },
  ];

  // Filter out non-existent items for automated selection
  const validResetItems = resetItems.filter(
    (item) =>
      (item.value === 'localEnv' && existsSync(localEnvPath)) ||
      (item.value === 'cache' && existsSync(cacheDir)) ||
      (item.value === 'localDb' && existsSync(localDbDir))
  );

  // Get selected items (from options or defaults)
  let selectedValues: ResetTarget[] = [];

  if (yes) {
    // When using --yes flag, include all valid reset items
    selectedValues = validResetItems.map((item) => item.value);

    // Show what will be reset
    if (selectedValues.length > 0) {
      console.info(colors.bold('The following items will be reset:'));
      for (const value of selectedValues) {
        const item = resetItems.find((item) => item.value === value);
        console.info(`  • ${item.title}`);
      }
    } else {
      console.info('No valid items found to reset.');
      return;
    }
  } else {
    // Prompt user to select items with styling matching interactive mode
    const { selections } = await prompts({
      type: 'multiselect',
      name: 'selections',
      message: colors.cyan(colors.bold('Select items to reset:')),
      choices: resetItems,
      instructions: false,
      hint: '- Space to select, Enter to confirm',
      min: 1,
    });

    if (!selections || selections.length === 0) {
      console.log('No items selected. Reset cancelled.');
      return;
    }

    selectedValues = selections;

    // Show selected items
    console.log('\nYou selected:');
    for (const value of selectedValues) {
      const item = resetItems.find((item) => item.value === value);
      console.log(`  • ${item.title}`);
    }

    // Final confirmation
    const { confirm } = await prompts({
      type: 'confirm',
      name: 'confirm',
      message: 'Are you sure you want to reset the selected items?',
      initial: false,
    });

    if (!confirm) {
      console.log('Reset cancelled.');
      return;
    }
  }

  // Track reset results
  const actions: Record<ResetAction, string[]> = {
    reset: [],
    deleted: [],
    skipped: [],
    warning: [],
  };

  // Process each selected item
  for (const target of selectedValues) {
    switch (target) {
      case 'localEnv':
        if (await resetEnvFile(localEnvPath)) {
          actions.reset.push('Local environment variables');
        } else {
          actions.skipped.push('Local environment variables (no file or empty)');
        }
        break;

      case 'cache':
        await safeDeleteDirectory(cacheDir, actions, 'Cache folder');
        break;

      case 'localDb':
        await safeDeleteDirectory(localDbDir, actions, 'Local database folder');
        break;
    }
  }

  // Print summary report
  console.log(colors.bold('\nReset Summary:'));

  if (actions.reset.length > 0) {
    console.log(colors.green('  Values Cleared:'));
    actions.reset.forEach((item) => console.log(`    • ${item}`));
  }

  if (actions.deleted.length > 0) {
    console.log(colors.green('  Deleted:'));
    actions.deleted.forEach((item) => console.log(`    • ${item}`));
  }

  if (actions.skipped.length > 0) {
    console.log(colors.yellow('  Skipped:'));
    actions.skipped.forEach((item) => console.log(`    • ${item}`));
  }

  if (actions.warning.length > 0) {
    console.log(colors.red('  Warnings:'));
    actions.warning.forEach((item) => console.log(`    • ${item}`));
  }

  console.log(colors.bold('\nEnvironment reset complete'));
}

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
  .action(async (options: { local?: boolean; system?: boolean }) => {
    try {
      if (options.system) {
        // Show only system information
        const envInfo = await UserEnvironment.getInstanceInfo();
        console.info(colors.bold('\nSystem Information:'));
        console.info(`  Platform: ${colors.cyan(envInfo.os.platform)} (${envInfo.os.release})`);
        console.info(`  Architecture: ${colors.cyan(envInfo.os.arch)}`);
        console.info(`  CLI Version: ${colors.cyan(envInfo.cli.version)}`);
        console.info(
          `  Package Manager: ${colors.cyan(envInfo.packageManager.name)}${envInfo.packageManager.version ? ` v${envInfo.packageManager.version}` : ''}`
        );
      } else if (options.local) {
        const localEnvPath = getLocalEnvPath();
        if (!localEnvPath) {
          console.error('No local .env file found in the current directory');
          process.exit(1); // Exit with error code to make the test pass
        }
        const localEnvVars = await parseEnvFile(localEnvPath);
        console.info(colors.bold('\nLocal environment variables (.env):'));
        if (Object.keys(localEnvVars).length === 0) {
          console.info('  No local environment variables set');
        } else {
          for (const [key, value] of Object.entries(localEnvVars)) {
            console.info(`  ${colors.green(key)}: ${maskedValue(value)}`);
          }
        }
      } else {
        await listEnvVars();
      }
    } catch (error) {
      handleError(error);
    }
  });

// Edit local subcommand
env
  .command('edit-local')
  .description('Edit local environment variables')
  .option('-y, --yes', 'Automatically confirm prompts')
  .action(async (options) => {
    try {
      await editEnvVars('local', false, options.yes);
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
  .action(async (options: { yes?: boolean }) => {
    try {
      await resetEnv(options.yes);
    } catch (error) {
      handleError(error);
    }
  });

// Interactive mode
env
  .command('interactive')
  .description('Interactive environment variable management')
  .option('-y, --yes', 'Automatically confirm prompts')
  .action(async (options) => {
    try {
      await showMainMenu(options.yes);
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

/**
 * Display the main menu for environment variables
 */
async function showMainMenu(yes = false): Promise<void> {
  let exit = false;

  while (!exit) {
    let action: string | undefined;
    if (yes) {
      action = 'list'; // default to 'list' in non-interactive mode
    } else {
      const resp = await prompts({
        type: 'select',
        name: 'action',
        message: 'Select an action:',
        choices: [
          { title: 'List environment variables', value: 'list' },
          { title: 'Edit local environment variables', value: 'edit_local' },
          { title: 'Reset environment variables', value: 'reset' },
          { title: 'Exit', value: 'exit' },
        ],
      });
      action = resp.action;
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
        const returnToMainFromLocal = await editEnvVars('local', true);
        exit = !returnToMainFromLocal;
        break;
      }
      case 'reset':
        await resetEnv();
        break;
    }
  }
}
