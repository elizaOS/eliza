import { logger } from '@elizaos/core';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'readline';
import { emoji } from '@/src/utils/emoji-handler';
import { EnvVarConfig } from '../types';

/**
 * Attempts to find the package.json of an installed plugin and extract environment variable requirements
 * from its agentConfig.pluginParameters
 */
export const extractPluginEnvRequirements = async (
  packageName: string,
  cwd: string
): Promise<Record<string, EnvVarConfig>> => {
  try {
    // Try to find the plugin's package.json in node_modules
    const nodeModulesPath = path.join(cwd, 'node_modules', packageName, 'package.json');

    if (!fs.existsSync(nodeModulesPath)) {
      logger.debug(`Plugin package.json not found at: ${nodeModulesPath}`);
      return {};
    }

    const packageJsonContent = fs.readFileSync(nodeModulesPath, 'utf-8');
    const packageJson = JSON.parse(packageJsonContent);

    // Extract environment variables from agentConfig.pluginParameters
    const agentConfig = packageJson.agentConfig;
    if (!agentConfig || !agentConfig.pluginParameters) {
      logger.debug(`No agentConfig.pluginParameters found in ${packageName}`);
      return {};
    }

    logger.debug(
      `Found environment variables for ${packageName}: ${Object.keys(agentConfig.pluginParameters).join(', ')}`
    );

    return agentConfig.pluginParameters;
  } catch (error) {
    logger.debug(`Error reading plugin package.json for ${packageName}: ${error.message}`);
    return {};
  }
};

/**
 * Reads the current .env file content
 */
export const readEnvFile = (cwd: string): string => {
  const envPath = path.join(cwd, '.env');
  try {
    return fs.readFileSync(envPath, 'utf-8');
  } catch (error) {
    // File doesn't exist, return empty string
    return '';
  }
};

/**
 * Writes content to the .env file
 */
export const writeEnvFile = (cwd: string, content: string): void => {
  const envPath = path.join(cwd, '.env');
  fs.writeFileSync(envPath, content, 'utf-8');
};

/**
 * Prompts user for an environment variable value
 */
export const promptForEnvVar = async (
  varName: string,
  description: string,
  type: string
): Promise<string> => {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  return new Promise((resolve) => {
    const prompt = `Enter value for ${varName} (${description})${type === 'string' ? '' : ` [${type}]`}: `;
    rl.question(prompt, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
};

/**
 * Updates the .env file with a new environment variable
 */
export const updateEnvFile = (cwd: string, varName: string, value: string): void => {
  const envContent = readEnvFile(cwd);
  const lines = envContent.split('\n');

  // Check if the variable already exists
  const existingLineIndex = lines.findIndex((line) => line.startsWith(`${varName}=`));

  if (existingLineIndex >= 0) {
    // Update existing line
    lines[existingLineIndex] = `${varName}=${value}`;
  } else {
    // Add new line
    if (envContent && !envContent.endsWith('\n')) {
      lines.push(''); // Add empty line if file doesn't end with newline
    }
    lines.push(`${varName}=${value}`);
  }

  writeEnvFile(cwd, lines.join('\n'));
};

/**
 * Prompts for environment variables based on the plugin's agentConfig.pluginParameters
 * and writes them to the .env file
 */
export const promptForPluginEnvVars = async (packageName: string, cwd: string): Promise<void> => {
  const envRequirements = await extractPluginEnvRequirements(packageName, cwd);

  if (Object.keys(envRequirements).length === 0) {
    logger.debug(`No environment variables required for ${packageName}`);
    logger.info(`✅ No environment variables required for ${packageName}`);
    return;
  }

  logger.info(`\n${emoji.rocket(`Plugin ${packageName} requires environment variables:`)}`);

  // Read current .env file to check for existing values
  const envContent = readEnvFile(cwd);
  const existingVars: Record<string, string> = {};

  envContent.split('\n').forEach((line) => {
    const match = line.match(/^([^=]+)=(.*)$/);
    if (match) {
      existingVars[match[1]] = match[2];
    }
  });

  for (const [varName, config] of Object.entries(envRequirements)) {
    const { type = 'string', description = 'No description available' } = config;

    // Check if variable already exists and has a value
    if (existingVars[varName] && existingVars[varName] !== '') {
      console.log(`✓ ${varName} is already set in .env file`);
      continue;
    }

    try {
      const value = await promptForEnvVar(varName, description, type);

      if (value) {
        updateEnvFile(cwd, varName, value);
        console.log(`✓ Added ${varName} to .env file`);
      } else {
        console.log(`⚠ Skipped ${varName} (no value provided)`);
      }
    } catch (error) {
      logger.warn(`Failed to prompt for ${varName}: ${error.message}`);
    }
  }

  console.log(`\n${emoji.success('Environment variable setup complete!')}`);
};