import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { logger } from '@elizaos/core';
import colors from 'yoctocolors';
import { checkEnvVarsForPlugin } from './env-prompt.js';

/**
 * Interface for the agent's configuration
 */
interface AgentConfig {
  lastUpdated: string;
  isDefault?: boolean; // Flag to indicate if this is a default config
}

/**
 * Path to the config file
 */
export function getConfigFilePath(): string {
  const homeDir = os.homedir();
  const elizaDir = path.join(homeDir, '.eliza');
  return path.join(elizaDir, 'config.json');
}

/**
 * Load the agent configuration if it exists
 * If no configuration exists, return a default empty configuration
 */
export function loadConfig(): AgentConfig {
  try {
    const configPath = getConfigFilePath();
    if (!fs.existsSync(configPath)) {
      return {
        lastUpdated: new Date().toISOString(),
        isDefault: true, // Mark as default config
      };
    }

    const content = fs.readFileSync(configPath, 'utf8');
    return JSON.parse(content) as AgentConfig;
  } catch (error) {
    logger.warn(`Error loading configuration: ${error}`);
    // Return default configuration on error
    return {
      lastUpdated: new Date().toISOString(),
      isDefault: true, // Mark as default config
    };
  }
}

/**
 * Save the agent configuration to disk
 */
export function saveConfig(config: AgentConfig): void {
  try {
    const configPath = getConfigFilePath();
    const elizaDir = path.dirname(configPath);

    // Create .eliza directory if it doesn't exist
    if (!fs.existsSync(elizaDir)) {
      fs.mkdirSync(elizaDir, { recursive: true });
    }

    // Update lastUpdated timestamp
    config.lastUpdated = new Date().toISOString();

    // Write config to file
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf8');
    logger.info(`Configuration saved to ${configPath}`);
  } catch (error) {
    logger.error(`Error saving configuration: ${error}`);
  }
}

/**
 * Get the status of each plugin's environment variables
 */
export function getPluginStatus(): Record<string, boolean> {
  // List of all available plugins
  const allPlugins = ['openai', 'anthropic', 'discord', 'twitter', 'telegram', 'pglite'];

  // Check environment variables for each plugin
  const status: Record<string, boolean> = {};
  for (const plugin of allPlugins) {
    status[plugin] = checkEnvVarsForPlugin(plugin);
  }

  return status;
}

/**
 * Display the current configuration status
 */
export function displayConfigStatus(): void {
  const config = loadConfig();
  const pluginStatus = getPluginStatus();

  logger.info('\n=== Current Configuration ===');

  // Indicate if this is a default configuration
  if (config.isDefault) {
    logger.info(
      colors.yellow('Using default configuration - you will be prompted to customize your setup.')
    );
  }

  // Display last updated timestamp
  if (config.lastUpdated && !config.isDefault) {
    logger.info(`Last updated: ${colors.gray(new Date(config.lastUpdated).toLocaleString())}`);
  }

  // Add a helpful note about reconfiguration (only if not default)
  if (!config.isDefault) {
    logger.info('\nTo change this configuration, run with the --configure flag');
  }

  logger.info('');
}
