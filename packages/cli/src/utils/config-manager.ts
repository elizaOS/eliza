import path from 'node:path';
import { promises as fs } from 'node:fs';
import { logger } from '@elizaos/core';
import { UserEnvironment } from './user-environment';

/**
 * Interface for the agent's configuration
 */
interface AgentConfig {
  lastUpdated: string;
  isDefault?: boolean; // Flag to indicate if this is a default config
}

/**
 * Retrieves the file path to the agent's configuration file.
 *
 * @returns A promise that resolves to the absolute path of the configuration file.
 */
export async function getConfigFilePath(): Promise<string> {
  const envInfo = await UserEnvironment.getInstanceInfo();
  return envInfo.paths.configPath;
}

async function fileExists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * Loads the agent configuration from disk, returning a default configuration if the file does not exist or cannot be read.
 *
 * @returns The loaded {@link AgentConfig} object, or a default configuration if loading fails.
 */
export async function loadConfig(): Promise<AgentConfig> {
  try {
    const configPath = await getConfigFilePath();
    if (!(await fileExists(configPath))) {
      return {
        lastUpdated: new Date().toISOString(),
        isDefault: true, // Mark as default config
      };
    }

    const content = await fs.readFile(configPath, 'utf8');
    return JSON.parse(content) as AgentConfig;
  } catch (error) {
    logger.warn(
      {
        src: 'cli',
        util: 'config-manager',
        error: error instanceof Error ? error.message : String(error),
      },
      'Error loading configuration'
    );
    // Return default configuration on error
    return {
      lastUpdated: new Date().toISOString(),
      isDefault: true, // Mark as default config
    };
  }
}

/**
 * Saves the agent configuration object to disk, updating its last updated timestamp.
 *
 * @param config - The agent configuration to save.
 *
 * @remark
 * If the target directory does not exist, it is created. Errors during saving are logged and rethrown.
 */
export async function saveConfig(config: AgentConfig): Promise<void> {
  const configPath = await getConfigFilePath();
  const elizaDir = path.dirname(configPath);

  // Create .eliza directory if it doesn't exist
  if (!(await fileExists(elizaDir))) {
    await fs.mkdir(elizaDir, { recursive: true });
  }

  // Update lastUpdated timestamp
  config.lastUpdated = new Date().toISOString();

  // Write config to file
  await fs.writeFile(configPath, JSON.stringify(config, null, 2), 'utf8');
  logger.info({ src: 'cli', util: 'config-manager', configPath }, 'Configuration saved');
}
