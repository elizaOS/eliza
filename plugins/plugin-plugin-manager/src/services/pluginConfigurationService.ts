import { Service, logger, type IAgentRuntime } from '@elizaos/core';
import { PluginManagerServiceType, type PluginEnvironmentVariable } from '../types';
import * as fs from 'fs/promises';
import * as path from 'path';

/**
 * Simplified plugin configuration service for basic environment variable checking
 */
export class PluginConfigurationService extends Service {
  static override serviceType = PluginManagerServiceType.PLUGIN_CONFIGURATION;
  override capabilityDescription = 'Provides basic plugin configuration status checking';

  constructor(runtime: IAgentRuntime) {
    super(runtime);
  }

  static async start(runtime: IAgentRuntime): Promise<PluginConfigurationService> {
    const service = new PluginConfigurationService(runtime);
    await service.initialize();
    return service;
  }

  async initialize(): Promise<void> {
    logger.info('[PluginConfigurationService] Initialized simple configuration checker');
  }

  /**
   * Parse plugin requirements from package.json or plugin file
   */
  async parsePluginRequirements(pluginPath: string): Promise<{
    requiredVars: PluginEnvironmentVariable[];
    optionalVars: PluginEnvironmentVariable[];
  } | null> {
    try {
      // Try to read package.json first
      const packageJsonPath = path.join(pluginPath, 'package.json');

      try {
        const packageJson = JSON.parse(await fs.readFile(packageJsonPath, 'utf-8'));

        // Look for elizaConfig section with environment variables
        if (packageJson.elizaConfig?.environmentVariables) {
          const envVars = packageJson.elizaConfig.environmentVariables;

          return {
            requiredVars: envVars.filter((v: PluginEnvironmentVariable) => v.required !== false),
            optionalVars: envVars.filter((v: PluginEnvironmentVariable) => v.required === false),
          };
        }
      } catch {
        // package.json doesn't exist or doesn't have elizaConfig
      }

      // Fallback: scan plugin files for common environment variable patterns
      return this.scanForCommonEnvVars(pluginPath);
    } catch (error) {
      logger.error('[PluginConfigurationService] Failed to parse requirements:', error);
      return null;
    }
  }

  /**
   * Get current plugin configuration status
   */
  getPluginConfiguration(pluginName: string): Record<string, string> {
    // Just return environment variables that are set
    const config: Record<string, string> = {};

    // Common plugin environment variable patterns
    const commonPatterns = [
      `${pluginName.toUpperCase().replace(/-/g, '_')}_API_KEY`,
      `${pluginName.toUpperCase().replace(/-/g, '_')}_TOKEN`,
      `${pluginName.toUpperCase().replace(/-/g, '_')}_SECRET`,
      `${pluginName.toUpperCase().replace(/-/g, '_')}_URL`,
    ];

    for (const pattern of commonPatterns) {
      const value = process.env[pattern];
      if (value) {
        config[pattern] = value;
      }
    }

    return config;
  }

  /**
   * Check if plugin has valid configuration
   */
  async hasValidConfiguration(pluginName: string, pluginPath: string): Promise<boolean> {
    const requirements = await this.parsePluginRequirements(pluginPath);
    if (!requirements || requirements.requiredVars.length === 0) {
      return true; // No requirements = valid
    }

    const currentConfig = this.getPluginConfiguration(pluginName);

    // Check if all required variables are set
    for (const varInfo of requirements.requiredVars) {
      if (!process.env[varInfo.name]) {
        return false;
      }
    }

    return true;
  }

  /**
   * Get missing environment variables for a plugin
   */
  async getMissingEnvVars(pluginName: string, pluginPath: string): Promise<string[]> {
    const requirements = await this.parsePluginRequirements(pluginPath);
    if (!requirements) {
      return [];
    }

    const missing: string[] = [];

    for (const varInfo of requirements.requiredVars) {
      if (!process.env[varInfo.name]) {
        missing.push(varInfo.name);
      }
    }

    return missing;
  }

  /**
   * Get configuration status for a specific plugin by name and path
   */
  async getPluginConfigurationStatusForPlugin(
    pluginName: string,
    pluginPath: string
  ): Promise<{
    configured: boolean;
    missingVars: string[];
    requiredVars: PluginEnvironmentVariable[];
  }> {
    const requirements = await this.parsePluginRequirements(pluginPath);
    if (!requirements || requirements.requiredVars.length === 0) {
      return { configured: true, missingVars: [], requiredVars: [] };
    }

    const missing = await this.getMissingEnvVars(pluginName, pluginPath);
    return {
      configured: missing.length === 0,
      missingVars: missing,
      requiredVars: requirements.requiredVars,
    };
  }

  private async scanForCommonEnvVars(pluginPath: string): Promise<{
    requiredVars: PluginEnvironmentVariable[];
    optionalVars: PluginEnvironmentVariable[];
  }> {
    // Scan common files for environment variable usage
    const commonEnvPatterns = [
      { name: 'API_KEY', description: 'API key for service authentication', sensitive: true },
      { name: 'TOKEN', description: 'Authentication token', sensitive: true },
      { name: 'SECRET', description: 'Secret key', sensitive: true },
      { name: 'URL', description: 'Service URL', sensitive: false },
      { name: 'ENDPOINT', description: 'API endpoint', sensitive: false },
    ];

    const requiredVars: PluginEnvironmentVariable[] = [];

    // Look for files that might use environment variables
    try {
      const files = await fs.readdir(pluginPath, { recursive: true });
      const codeFiles = files.filter(
        (f) => typeof f === 'string' && (f.endsWith('.ts') || f.endsWith('.js'))
      );

      for (const file of codeFiles) {
        try {
          const content = await fs.readFile(path.join(pluginPath, file as string), 'utf-8');

          // Look for process.env usage
          const envMatches = content.match(/process\.env\.([A-Z_]+)/g);

          if (envMatches) {
            for (const match of envMatches) {
              const varName = match.replace('process.env.', '');

              // Check if it matches common patterns
              for (const pattern of commonEnvPatterns) {
                if (varName.includes(pattern.name)) {
                  const existing = requiredVars.find((v) => v.name === varName);
                  if (!existing) {
                    requiredVars.push({
                      name: varName,
                      description: pattern.description,
                      sensitive: pattern.sensitive,
                      required: true,
                    });
                  }
                }
              }
            }
          }
        } catch {
          // Skip files that can't be read
        }
      }
    } catch {
      // Skip if can't read directory
    }

    return {
      requiredVars,
      optionalVars: [],
    };
  }

  async stop(): Promise<void> {
    logger.info('[PluginConfigurationService] Stopped');
  }
}
