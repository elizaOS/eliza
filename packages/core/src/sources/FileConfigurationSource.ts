import type { ConfigurationSource, PluginConfiguration } from '../types/plugin-config.js';
import { elizaLogger } from '../logger.js';
import * as fs from 'fs/promises';
import * as path from 'path';

/**
 * File-based Configuration Source
 * Stores and retrieves plugin configurations from a JSON file
 */
export class FileConfigurationSource implements ConfigurationSource {
  name = 'file';
  priority = 2; // Lower priority than database

  constructor(private configPath: string = '.eliza/plugin-config.json') {}

  /**
   * Load all plugin configurations from file
   */
  async load(): Promise<Record<string, PluginConfiguration>> {
    try {
      const fullPath = path.resolve(this.configPath);

      // Check if file exists
      try {
        await fs.access(fullPath);
      } catch {
        // File doesn't exist, return empty config
        return {};
      }

      // Read and parse file
      const content = await fs.readFile(fullPath, 'utf-8');
      const configs = JSON.parse(content);

      // Convert date strings back to Date objects
      for (const config of Object.values(configs) as PluginConfiguration[]) {
        if (config.lastModified) {
          config.lastModified = new Date(config.lastModified as any);
        }

        // Convert dates in component configs
        for (const actionConfig of Object.values(config.actions || {})) {
          if (actionConfig.lastModified) {
            actionConfig.lastModified = new Date(actionConfig.lastModified as any);
          }
        }

        for (const providerConfig of Object.values(config.providers || {})) {
          if (providerConfig.lastModified) {
            providerConfig.lastModified = new Date(providerConfig.lastModified as any);
          }
        }
      }

      elizaLogger.info(`Loaded plugin configurations from ${fullPath}`);
      return configs;
    } catch (error) {
      elizaLogger.error('Failed to load configurations from file:', error);
      return {};
    }
  }

  /**
   * Save all plugin configurations to file
   */
  async save(configs: Record<string, PluginConfiguration>): Promise<void> {
    try {
      const fullPath = path.resolve(this.configPath);
      const dir = path.dirname(fullPath);

      // Ensure directory exists
      await fs.mkdir(dir, { recursive: true });

      // Write configurations to file
      await fs.writeFile(fullPath, JSON.stringify(configs, null, 2), 'utf-8');

      elizaLogger.info(`Saved plugin configurations to ${fullPath}`);
    } catch (error) {
      elizaLogger.error('Failed to save configurations to file:', error);
      throw error;
    }
  }

  /**
   * Get configuration for specific plugin
   */
  async getPluginConfig(pluginName: string): Promise<PluginConfiguration | null> {
    const configs = await this.load();
    return configs[pluginName] || null;
  }

  /**
   * Update configuration for specific plugin
   */
  async updatePluginConfig(
    pluginName: string,
    config: Partial<PluginConfiguration>
  ): Promise<void> {
    const configs = await this.load();
    const existing = configs[pluginName];

    configs[pluginName] = {
      pluginName,
      enabled: config.enabled ?? existing?.enabled ?? true,
      actions: { ...existing?.actions, ...config.actions },
      providers: { ...existing?.providers, ...config.providers },
      settings: { ...existing?.settings, ...config.settings },
      lastModified: new Date(),
    };

    await this.save(configs);
  }
}
