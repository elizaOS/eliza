import path from 'node:path';
import { promises as fs } from 'node:fs';
import { logger } from '@elizaos/core';
import { UserEnvironment } from './user-environment';
import { validatePluginEnvVars } from './env-prompt';

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
    logger.warn(`Error loading configuration: ${error}`);
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
 * If the target directory does not exist, it is created. Errors during saving are logged but not thrown.
 */
export async function saveConfig(config: AgentConfig): Promise<void> {
  try {
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
    logger.info(`Configuration saved to ${configPath}`);
  } catch (error) {
    logger.error(`Error saving configuration: ${error}`);
  }
}

/**
 * Checks whether the required environment variables for a plugin are valid.
 *
 * @param pluginName - The name of the plugin to validate.
 * @returns An object indicating if the environment is valid and a message describing the result.
 */
export async function checkPluginRequirements(pluginName: string): Promise<{
  valid: boolean;
  message: string;
}> {
  return validatePluginEnvVars(pluginName);
}

/**
 * Retrieves the environment variable validation status for each plugin listed in the agent configuration.
 *
 * @returns A record mapping plugin names to a boolean indicating whether their required environment variables are valid.
 */
export async function getPluginStatus(): Promise<Record<string, boolean>> {
  const configPath = await getConfigFilePath();
  if (!(await fileExists(configPath))) {
    return {};
  }

  try {
    const configContent = await fs.readFile(configPath, 'utf-8');
    const config = JSON.parse(configContent);
    const status: Record<string, boolean> = {};

    // Check each plugin's environment variables
    for (const plugin of Object.keys(config.plugins ?? {})) {
      const check = await validatePluginEnvVars(plugin);
      status[plugin] = check.valid;
    }

    return status;
  } catch (error) {
    logger.error(`Error reading config file: ${error}`);
    return {};
  }
}
