import type {
  ConfigurationSource,
  PluginConfiguration,
  ComponentConfigState,
} from '../types/plugin-config.js';
import type { Character } from '../types/agent.js';
import { elizaLogger } from '../logger.js';

/**
 * Configuration source that reads plugin configurations from character files
 * This allows users to specify component-level settings directly in character.json files
 */
export class CharacterConfigurationSource implements ConfigurationSource {
  name = 'character';
  priority = 50; // Medium priority - after plugin defaults but before GUI/database overrides

  private character: Character;
  private logger = elizaLogger;

  constructor(character: Character) {
    this.character = character;
  }

  /**
   * Load plugin configurations from character file
   */
  async load(): Promise<Record<string, PluginConfiguration>> {
    const configurations: Record<string, PluginConfiguration> = {};

    if (!this.character.pluginConfig) {
      this.logger.debug('No plugin configuration found in character file');
      return configurations;
    }

    // Convert character plugin config to PluginConfiguration format
    for (const [pluginName, pluginConfig] of Object.entries(this.character.pluginConfig)) {
      const configuration: PluginConfiguration = {
        pluginName,
        enabled: pluginConfig.enabled ?? true,
        actions: {},
        providers: {},
        evaluators: {},
        settings: pluginConfig.settings || {},
        lastModified: new Date(),
      };

      // Convert action configurations
      if (pluginConfig.actions) {
        for (const [actionName, actionConfig] of Object.entries(pluginConfig.actions)) {
          configuration.actions[actionName] = this.convertToComponentConfigState(
            actionConfig,
            'plugin'
          );
        }
      }

      // Convert provider configurations
      if (pluginConfig.providers) {
        for (const [providerName, providerConfig] of Object.entries(pluginConfig.providers)) {
          configuration.providers[providerName] = this.convertToComponentConfigState(
            providerConfig,
            'plugin'
          );
        }
      }

      // Convert evaluator configurations
      if (pluginConfig.evaluators) {
        configuration.evaluators = configuration.evaluators || {};
        for (const [evaluatorName, evaluatorConfig] of Object.entries(pluginConfig.evaluators)) {
          configuration.evaluators[evaluatorName] = this.convertToComponentConfigState(
            evaluatorConfig,
            'plugin'
          );
        }
      }

      // Convert service configurations
      if (pluginConfig.services) {
        configuration.services = configuration.services || {};
        for (const [serviceName, serviceConfig] of Object.entries(pluginConfig.services)) {
          configuration.services[serviceName] = this.convertToComponentConfigState(
            serviceConfig,
            'plugin'
          );
        }
      }

      configurations[pluginName] = configuration;
    }

    this.logger.info(
      `Loaded plugin configurations for ${Object.keys(configurations).length} plugins from character file`
    );

    return configurations;
  }

  /**
   * Character configuration source is read-only, cannot update
   */
  async updatePluginConfig(
    pluginName: string,
    config: PluginConfiguration
  ): Promise<void> {
    this.logger.warn(
      `Cannot update plugin configuration for "${pluginName}" - character configuration source is read-only`
    );
    throw new Error(
      'Character configuration source is read-only. Use GUI or database configuration sources for updates.'
    );
  }

  /**
   * Character configuration source is read-only, cannot save
   */
  async save(config: Record<string, PluginConfiguration>): Promise<void> {
    this.logger.warn(
      'Cannot save plugin configurations - character configuration source is read-only'
    );
    throw new Error(
      'Character configuration source is read-only. Use GUI or database configuration sources for updates.'
    );
  }

  /**
   * Convert character component config to ComponentConfigState
   */
  private convertToComponentConfigState(
    config: {
      enabled?: boolean;
      settings?: Record<string, any>;
    },
    overrideLevel: 'default' | 'plugin' | 'database' | 'gui' | 'runtime'
  ): ComponentConfigState {
    return {
      enabled: config.enabled ?? true,
      overrideLevel,
      settings: config.settings || {},
      lastModified: new Date(),
    };
  }

  /**
   * Update the character reference for this configuration source
   */
  updateCharacter(character: Character): void {
    this.character = character;
    this.logger.debug('Updated character reference for character configuration source');
  }
}