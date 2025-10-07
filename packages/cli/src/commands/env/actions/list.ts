import { UserEnvironment } from '@/src/utils';
import { existsSync } from 'node:fs';
import path from 'node:path';
import colors from 'yoctocolors';
import { ListEnvOptions } from '../types';
import { getLocalEnvPath, parseEnvFile } from '../utils/file-operations';
import { maskedValue } from '../utils/validation';

/**
 * Displays system information and lists local environment variables, masking sensitive values.
 *
 * Prints details about the current platform, architecture, CLI version, and package manager. Shows environment variables from the project's `.env` file, masking sensitive values, or provides guidance if the file is missing. Includes a link to the web UI for editing variables.
 */
export async function listEnvVars(): Promise<void> {
  const envInfo = await UserEnvironment.getInstanceInfo();

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
  const localEnvFilePath = await getLocalEnvPath();
  console.info(`Path: ${localEnvFilePath ?? path.join(process.cwd(), '.env')}`);

  if (!localEnvFilePath || !existsSync(localEnvFilePath)) {
    // No local .env file exists, provide guidance to the user
    console.info(colors.yellow('  No local .env file found'));

    // Check if .env.example exists and suggest copying it as a starting point
    const exampleEnvPath = path.join(process.cwd(), '.env.example');
    if (existsSync(exampleEnvPath)) {
      console.info(colors.red('  [X] Missing .env file. Create one with:'));
      console.info(`     ${colors.bold(colors.green('cp .env.example .env'))}`);
    } else {
      console.info(
        colors.red(
          '  [X] Missing .env file. Create one in your project directory to set local environment variables.'
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
 * Handle the list command with options
 */
export async function handleListCommand(options: ListEnvOptions): Promise<void> {
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
    // Show ONLY local environment variables, no system information
    console.info(colors.bold('\nLocal Environment Variables:'));
    const localEnvPath = await getLocalEnvPath();

    if (!localEnvPath || !existsSync(localEnvPath)) {
      console.info('  No local .env file found in the current directory');
      return;
    }

    const localEnvVars = await parseEnvFile(localEnvPath);
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
}
