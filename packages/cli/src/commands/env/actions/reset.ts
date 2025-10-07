import * as clack from '@clack/prompts';
import { existsSync } from 'node:fs';
import path from 'node:path';
import colors from 'yoctocolors';
import { ResetActionRecord, ResetEnvOptions, ResetItem, ResetTarget } from '../types';
import { safeDeleteDirectory } from '../utils/directory-operations';
import { getLocalEnvPath, resetEnvFile } from '../utils/file-operations';

/**
 * Resolve the PGLite database directory path
 * @returns The path to the PGLite database directory
 */
async function resolvePgliteDir(): Promise<string> {
  // Default PGLite directory path
  return path.join(process.cwd(), '.eliza', 'db');
}

/**
 * Reset environment variables and selected folders
 *
 * Provides an interactive menu to reset local environment variables, cache folder, and local database files. Supports auto-confirmation mode for batch operations.
 */
export async function resetEnv(options: ResetEnvOptions): Promise<void> {
  const { yes } = options;

  // Get all relevant paths
  const elizaDir = path.join(process.cwd(), '.eliza');
  const cacheDir = path.join(elizaDir, 'cache');

  const localEnvPath = (await getLocalEnvPath()) ?? path.join(process.cwd(), '.env');
  const localDbDir = await resolvePgliteDir();

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
        console.info(`  • ${item?.title || value}`);
      }
    } else {
      console.info('No valid items found to reset.');
      return;
    }
  } else {
    // Prompt user to select items with styling matching interactive mode
    const selections = await clack.multiselect({
      message: colors.cyan(colors.bold('Select items to reset:')),
      options: resetItems.map((item) => ({ value: item.value, label: item.title })),
      required: true,
    });

    if (clack.isCancel(selections)) {
      clack.cancel('Operation cancelled.');
      process.exit(0);
    }

    if (!selections || selections.length === 0) {
      console.log('No items selected. Reset cancelled.');
      return;
    }

    selectedValues = selections;

    // Show selected items
    console.log('\nYou selected:');
    for (const value of selectedValues) {
      const item = resetItems.find((item) => item.value === value);
      console.log(`  • ${item?.title || value}`);
    }

    // Final confirmation
    const confirm = await clack.confirm({
      message: 'Are you sure you want to reset the selected items?',
      initialValue: false,
    });

    if (clack.isCancel(confirm)) {
      clack.cancel('Operation cancelled.');
      process.exit(0);
    }

    if (!confirm) {
      console.log('Reset cancelled.');
      return;
    }
  }

  // Track reset results
  const actions: ResetActionRecord = {
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
