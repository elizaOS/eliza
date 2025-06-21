/**
 * Plugin Configuration System Types
 * Provides configurable actions, providers, and evaluators with backwards compatibility
 */

import type { Action, Provider, Evaluator } from './components.js';
import type { Plugin } from './plugin.js';
import type { Service } from './service.js';

/**
 * Configuration for a plugin component (action, provider, or evaluator)
 */
export interface ComponentConfig {
  /** Whether the component is enabled */
  enabled?: boolean;

  /** Required environment variables or settings */
  requiredSettings?: string[];

  /** Category for grouping in UI */
  category?: string;

  /** Required permissions to use this component */
  permissions?: string[];

  /** Mark as experimental/beta feature */
  experimental?: boolean;

  /** Description of why this is disabled by default */
  disabledReason?: string;
}

/**
 * Enhanced action interface with configuration
 */
export interface ConfigurableAction extends Action {
  /** Configuration for this action */
  config?: ComponentConfig;
}

/**
 * Enhanced provider interface with configuration
 */
export interface ConfigurableProvider extends Provider {
  /** Configuration for this provider */
  config?: ComponentConfig;
}

/**
 * Enhanced evaluator interface with configuration
 */
export interface ConfigurableEvaluator extends Evaluator {
  /** Configuration for this evaluator */
  config?: ComponentConfig;
}

/**
 * Enhanced service interface with configuration
 */
export interface ConfigurableService {
  /** The service class (extends Service) */
  service: typeof Service;
  /** Configuration for this service */
  config?: ComponentConfig;
}

/**
 * Enhanced plugin interface with configurable components
 * Backwards compatible with existing Plugin interface
 */
export interface ConfigurablePlugin extends Plugin {
  /** Configurable actions (can be enabled/disabled) */
  configurableActions?: ConfigurableAction[];

  /** Configurable providers (can be enabled/disabled) */
  configurableProviders?: ConfigurableProvider[];

  /** Configurable evaluators (can be enabled/disabled) */
  configurableEvaluators?: ConfigurableEvaluator[];

  /** Configurable services (can be enabled/disabled) */
  configurableServices?: ConfigurableService[];

  /** Plugin-level configuration */
  config?: {
    /** Whether plugin is enabled by default */
    defaultEnabled?: boolean;

    /** Plugin category */
    category?: string;

    /** Required permissions for entire plugin */
    permissions?: string[];

    /** Plugin metadata */
    metadata?: Record<string, any>;
  };
}

/**
 * Configuration state for a component
 */
export interface ComponentConfigState {
  /** Whether component is enabled */
  enabled: boolean;

  /** Source of the configuration override */
  overrideLevel: 'default' | 'plugin' | 'database' | 'gui' | 'runtime';

  /** Reason for override */
  overrideReason?: string;

  /** Additional settings */
  settings?: Record<string, any>;

  /** Timestamp of last configuration change */
  lastModified?: Date;
}

/**
 * Plugin configuration state
 */
export interface PluginConfiguration {
  /** Plugin name */
  pluginName: string;

  /** Whether entire plugin is enabled */
  enabled: boolean;

  /** Action configurations */
  actions: Record<string, ComponentConfigState>;

  /** Provider configurations */
  providers: Record<string, ComponentConfigState>;

  /** Evaluator configurations */
  evaluators?: Record<string, ComponentConfigState>;

  /** Service configurations */
  services?: Record<string, ComponentConfigState>;

  /** Plugin-level settings */
  settings: Record<string, any>;

  /** Last modified timestamp */
  lastModified: Date;
}

/**
 * Configuration source interface
 */
export interface ConfigurationSource {
  /** Source name */
  name: string;

  /** Priority (higher = takes precedence) */
  priority: number;

  /** Load configurations from this source */
  load(): Promise<Record<string, PluginConfiguration>>;

  /** Save configurations to this source */
  save(config: Record<string, PluginConfiguration>): Promise<void>;

  /** Get configuration for specific plugin */
  getPluginConfig?(pluginName: string): Promise<PluginConfiguration | null>;

  /** Update configuration for specific plugin */
  updatePluginConfig?(pluginName: string, config: Partial<PluginConfiguration>): Promise<void>;
}

/**
 * Configuration change event
 */
export interface ConfigurationChangeEvent {
  /** Type of change */
  type: 'plugin' | 'action' | 'provider' | 'evaluator';

  /** Plugin name */
  pluginName: string;

  /** Component name (for action/provider/evaluator changes) */
  componentName?: string;

  /** Previous configuration */
  previousConfig?: ComponentConfigState | PluginConfiguration;

  /** New configuration */
  newConfig: ComponentConfigState | PluginConfiguration;

  /** Source of the change */
  source: string;

  /** Timestamp */
  timestamp: Date;
}

/**
 * Configuration manager interface
 */
export interface IConfigurationManager {
  /** Get effective configuration for a component */
  getComponentConfig(
    pluginName: string,
    componentName: string,
    type: 'action' | 'provider' | 'evaluator' | 'service'
  ): ComponentConfigState;

  /** Set configuration override */
  setOverride(
    source: 'gui' | 'database' | 'plugin-manager' | 'runtime',
    pluginName: string,
    config: Partial<PluginConfiguration>
  ): Promise<void>;

  /** Check if component is enabled */
  isComponentEnabled(
    pluginName: string,
    componentName: string,
    type: 'action' | 'provider' | 'evaluator' | 'service'
  ): boolean;

  /** Get full plugin configuration */
  getPluginConfiguration(pluginName: string): PluginConfiguration | null;

  /** List all plugin configurations */
  listConfigurations(): PluginConfiguration[];

  /** Subscribe to configuration changes */
  onConfigurationChange(callback: (event: ConfigurationChangeEvent) => void): () => void;

  /** Register configuration source */
  registerSource(source: ConfigurationSource): void;

  /** Reload configurations from all sources */
  reload(): Promise<void>;
}
