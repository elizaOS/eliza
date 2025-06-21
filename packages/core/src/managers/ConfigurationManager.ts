import { EventEmitter } from 'events';
import type {
  ComponentConfigState,
  ConfigurationChangeEvent,
  ConfigurationSource,
  IConfigurationManager,
  PluginConfiguration,
  ConfigurablePlugin,
  ComponentConfig,
} from '../types/plugin-config.js';
import type {
  ComponentDependency,
  ValidationResult,
  ComponentValidationContext,
} from '../types/validation.js';
import { elizaLogger } from '../logger.js';

/**
 * Configuration Manager for Plugin System
 * Manages plugin configurations with multiple override sources
 */
export class ConfigurationManager extends EventEmitter implements IConfigurationManager {
  private configurations = new Map<string, PluginConfiguration>();
  private sources: ConfigurationSource[] = [];
  private logger = elizaLogger;

  constructor() {
    super();
  }

  /**
   * Register a configuration source
   */
  registerSource(source: ConfigurationSource): void {
    // Insert source in priority order
    const insertIndex = this.sources.findIndex((s) => s.priority < source.priority);
    if (insertIndex === -1) {
      this.sources.push(source);
    } else {
      this.sources.splice(insertIndex, 0, source);
    }

    this.logger.info(
      `Registered configuration source: ${source.name} with priority ${source.priority}`
    );
  }

  /**
   * Reload configurations from all sources
   */
  async reload(): Promise<void> {
    this.logger.info('Reloading plugin configurations from all sources');

    // Clear existing configurations
    this.configurations.clear();

    // Load from sources in reverse priority order (lowest to highest)
    // This allows higher priority sources to override lower ones
    for (const source of [...this.sources].reverse()) {
      try {
        const configs = await source.load();

        // Merge configurations
        for (const [pluginName, config] of Object.entries(configs)) {
          const existing = this.configurations.get(pluginName);

          if (existing) {
            // Merge with existing, keeping higher priority values
            this.mergeConfigurations(existing, config, source.name);
          } else {
            this.configurations.set(pluginName, config);
          }
        }

        this.logger.debug(`Loaded configurations from ${source.name}`);
      } catch (error) {
        this.logger.error(`Failed to load configurations from ${source.name}:`, error);
      }
    }
  }

  /**
   * Get component configuration
   */
  getComponentConfig(
    pluginName: string,
    componentName: string,
    type: 'action' | 'provider' | 'evaluator' | 'service'
  ): ComponentConfigState {
    const pluginConfig = this.configurations.get(pluginName);

    if (!pluginConfig) {
      // Return default enabled state for backwards compatibility
      return {
        enabled: true,
        overrideLevel: 'default',
        lastModified: new Date(),
      };
    }

    let componentConfigs: Record<string, ComponentConfigState>;
    if (type === 'action') {
      componentConfigs = pluginConfig.actions;
    } else if (type === 'provider') {
      componentConfigs = pluginConfig.providers;
    } else if (type === 'evaluator') {
      componentConfigs = pluginConfig.evaluators || {};
    } else if (type === 'service') {
      componentConfigs = pluginConfig.services || {};
    } else {
      componentConfigs = {};
    }

    const componentConfig = componentConfigs[componentName];

    if (!componentConfig) {
      // Return default enabled state
      return {
        enabled: true,
        overrideLevel: 'default',
        lastModified: new Date(),
      };
    }

    return componentConfig;
  }

  /**
   * Set configuration override
   */
  async setOverride(
    source: 'gui' | 'database' | 'plugin-manager' | 'runtime',
    pluginName: string,
    config: Partial<PluginConfiguration>
  ): Promise<void> {
    const existingConfig =
      this.configurations.get(pluginName) || this.createDefaultPluginConfig(pluginName);
    const previousConfig = JSON.parse(JSON.stringify(existingConfig));

    // Apply override
    if (config.enabled !== undefined) {
      existingConfig.enabled = config.enabled;
    }

    if (config.actions) {
      for (const [actionName, actionConfig] of Object.entries(config.actions)) {
        const existingActionConfig =
          existingConfig.actions[actionName] || ({} as Partial<ComponentConfigState>);
        existingConfig.actions[actionName] = {
          enabled: actionConfig.enabled ?? existingActionConfig.enabled ?? true,
          overrideLevel: source as any,
          overrideReason: actionConfig.overrideReason ?? existingActionConfig.overrideReason,
          settings: actionConfig.settings ?? existingActionConfig.settings ?? {},
          lastModified: new Date(),
        };
      }
    }

    if (config.providers) {
      for (const [providerName, providerConfig] of Object.entries(config.providers)) {
        const existingProviderConfig =
          existingConfig.providers[providerName] || ({} as Partial<ComponentConfigState>);
        existingConfig.providers[providerName] = {
          enabled: providerConfig.enabled ?? existingProviderConfig.enabled ?? true,
          overrideLevel: source as any,
          overrideReason: providerConfig.overrideReason ?? existingProviderConfig.overrideReason,
          settings: providerConfig.settings ?? existingProviderConfig.settings ?? {},
          lastModified: new Date(),
        };
      }
    }

    if (config.evaluators) {
      existingConfig.evaluators = existingConfig.evaluators || {};
      for (const [evaluatorName, evaluatorConfig] of Object.entries(config.evaluators)) {
        const existingEvaluatorConfig =
          existingConfig.evaluators[evaluatorName] || ({} as Partial<ComponentConfigState>);
        existingConfig.evaluators[evaluatorName] = {
          enabled: evaluatorConfig.enabled ?? existingEvaluatorConfig.enabled ?? true,
          overrideLevel: source as any,
          overrideReason: evaluatorConfig.overrideReason ?? existingEvaluatorConfig.overrideReason,
          settings: evaluatorConfig.settings ?? existingEvaluatorConfig.settings ?? {},
          lastModified: new Date(),
        };
      }
    }

    if (config.services) {
      existingConfig.services = existingConfig.services || {};
      for (const [serviceName, serviceConfig] of Object.entries(config.services)) {
        const existingServiceConfig =
          existingConfig.services[serviceName] || ({} as Partial<ComponentConfigState>);
        existingConfig.services[serviceName] = {
          enabled: serviceConfig.enabled ?? existingServiceConfig.enabled ?? true,
          overrideLevel: source as any,
          overrideReason: serviceConfig.overrideReason ?? existingServiceConfig.overrideReason,
          settings: serviceConfig.settings ?? existingServiceConfig.settings ?? {},
          lastModified: new Date(),
        };
      }
    }

    if (config.settings) {
      existingConfig.settings = {
        ...existingConfig.settings,
        ...config.settings,
      };
    }

    existingConfig.lastModified = new Date();
    this.configurations.set(pluginName, existingConfig);

    // Emit change event
    const event: ConfigurationChangeEvent = {
      type: 'plugin',
      pluginName,
      previousConfig,
      newConfig: existingConfig,
      source,
      timestamp: new Date(),
    };

    this.emit('configurationChange', event);

    // Save to appropriate source
    const configSource = this.sources.find((s) => s.name === source);
    if (configSource?.updatePluginConfig) {
      await configSource.updatePluginConfig(pluginName, existingConfig);
    }
  }

  /**
   * Check if component is enabled
   */
  isComponentEnabled(
    pluginName: string,
    componentName: string,
    type: 'action' | 'provider' | 'evaluator' | 'service'
  ): boolean {
    const config = this.getComponentConfig(pluginName, componentName, type);
    return config.enabled;
  }

  /**
   * Get full plugin configuration
   */
  getPluginConfiguration(pluginName: string): PluginConfiguration | null {
    return this.configurations.get(pluginName) || null;
  }

  /**
   * List all plugin configurations
   */
  listConfigurations(): PluginConfiguration[] {
    return Array.from(this.configurations.values());
  }

  /**
   * Subscribe to configuration changes
   */
  onConfigurationChange(callback: (event: ConfigurationChangeEvent) => void): () => void {
    this.on('configurationChange', callback);

    // Return unsubscribe function
    return () => {
      this.off('configurationChange', callback);
    };
  }

  /**
   * Initialize plugin configuration from plugin definition
   */
  initializePluginConfiguration(plugin: ConfigurablePlugin): PluginConfiguration {
    const config: PluginConfiguration = {
      pluginName: plugin.name,
      enabled: plugin.config?.defaultEnabled ?? true,
      actions: {},
      providers: {},
      evaluators: {},
      services: {},
      settings: plugin.config?.metadata || {},
      lastModified: new Date(),
    };

    // Initialize action configurations
    if (plugin.configurableActions) {
      for (const action of plugin.configurableActions) {
        config.actions[action.name] = this.createComponentConfigState(action.config);
      }
    }

    // Initialize provider configurations
    if (plugin.configurableProviders) {
      for (const provider of plugin.configurableProviders) {
        config.providers[provider.name] = this.createComponentConfigState(provider.config);
      }
    }

    // Initialize evaluator configurations
    if (plugin.configurableEvaluators) {
      config.evaluators = {};
      for (const evaluator of plugin.configurableEvaluators) {
        config.evaluators[evaluator.name] = this.createComponentConfigState(evaluator.config);
      }
    }

    // Initialize service configurations
    if (plugin.configurableServices) {
      config.services = {};
      for (const service of plugin.configurableServices) {
        const serviceName = service.service.serviceName || service.service.name;
        config.services[serviceName] = this.createComponentConfigState(service.config);
      }
    }

    // Store configuration
    this.configurations.set(plugin.name, config);

    return config;
  }

  /**
   * Create component configuration state from component config
   */
  private createComponentConfigState(config?: ComponentConfig): ComponentConfigState {
    return {
      enabled: config?.enabled ?? true,
      overrideLevel: 'plugin',
      overrideReason: config?.disabledReason,
      settings: {},
      lastModified: new Date(),
    };
  }

  /**
   * Create default plugin configuration
   */
  private createDefaultPluginConfig(pluginName: string): PluginConfiguration {
    return {
      pluginName,
      enabled: true,
      actions: {},
      providers: {},
      evaluators: {},
      services: {},
      settings: {},
      lastModified: new Date(),
    };
  }

  /**
   * Merge configurations with priority
   */
  private mergeConfigurations(
    existing: PluginConfiguration,
    incoming: PluginConfiguration,
    sourceName: string
  ): void {
    // Only merge if incoming has actual values
    if (incoming.enabled !== undefined) {
      existing.enabled = incoming.enabled;
    }

    // Merge actions
    for (const [actionName, actionConfig] of Object.entries(incoming.actions)) {
      if (
        !existing.actions[actionName] ||
        this.shouldOverride(existing.actions[actionName].overrideLevel, sourceName)
      ) {
        existing.actions[actionName] = actionConfig;
      }
    }

    // Merge providers
    for (const [providerName, providerConfig] of Object.entries(incoming.providers)) {
      if (
        !existing.providers[providerName] ||
        this.shouldOverride(existing.providers[providerName].overrideLevel, sourceName)
      ) {
        existing.providers[providerName] = providerConfig;
      }
    }

    // Merge evaluators
    if (incoming.evaluators) {
      existing.evaluators = existing.evaluators || {};
      for (const [evaluatorName, evaluatorConfig] of Object.entries(incoming.evaluators)) {
        if (
          !existing.evaluators[evaluatorName] ||
          this.shouldOverride(existing.evaluators[evaluatorName].overrideLevel, sourceName)
        ) {
          existing.evaluators[evaluatorName] = evaluatorConfig;
        }
      }
    }

    // Merge services
    if (incoming.services) {
      existing.services = existing.services || {};
      for (const [serviceName, serviceConfig] of Object.entries(incoming.services)) {
        if (
          !existing.services[serviceName] ||
          this.shouldOverride(existing.services[serviceName].overrideLevel, sourceName)
        ) {
          existing.services[serviceName] = serviceConfig;
        }
      }
    }

    // Merge settings
    existing.settings = {
      ...existing.settings,
      ...incoming.settings,
    };
  }

  /**
   * Determine if an override should be applied based on priority
   */
  private shouldOverride(currentLevel: string, incomingSource: string): boolean {
    const priority: Record<string, number> = {
      default: 1,
      plugin: 2,
      database: 3,
      'plugin-manager': 4,
      gui: 5,
      runtime: 6,
    };

    return priority[incomingSource] >= priority[currentLevel];
  }

  /**
   * Validate component dependencies
   */
  validateComponentDependencies(context: ComponentValidationContext): ValidationResult {
    const errors: string[] = [];
    const warnings: string[] = [];

    // Check if all dependencies are enabled
    for (const dependency of context.dependencies) {
      const pluginName = dependency.pluginName || context.pluginName;
      const dependentComponents = context.enabledComponents.get(pluginName);
      
      if (!dependentComponents) {
        if (!dependency.optional) {
          errors.push(
            `Required plugin dependency "${dependency.pluginName || 'unknown'}" is not available for ${context.componentType} "${context.componentName}"`
          );
        } else {
          warnings.push(
            `Optional plugin dependency "${dependency.pluginName || 'unknown'}" is not available for ${context.componentType} "${context.componentName}"`
          );
        }
        continue;
      }

      // Check if the specific component type and name are enabled
      const componentKey = `${dependency.type}:${dependency.name}`;
      if (!dependentComponents.has(componentKey)) {
        if (!dependency.optional) {
          errors.push(
            `Required component dependency "${dependency.pluginName || 'current'}.${dependency.name}" (${dependency.type}) is not enabled for ${context.componentType} "${context.componentName}"`
          );
        } else {
          warnings.push(
            `Optional component dependency "${dependency.pluginName || 'current'}.${dependency.name}" (${dependency.type}) is not enabled for ${context.componentType} "${context.componentName}"`
          );
        }
      }
    }

    return {
      valid: errors.length === 0,
      errors,
      warnings,
    };
  }

  /**
   * Update component configuration with dependency validation
   */
  async updateComponentConfiguration(
    pluginName: string,
    componentName: string,
    componentType: 'action' | 'provider' | 'evaluator' | 'service',
    config: Partial<ComponentConfigState>,
    dependencies: ComponentDependency[] = [],
    enabledComponents?: Map<string, Set<string>>
  ): Promise<ValidationResult> {
    // First, validate that the component exists in the plugin configuration
    const pluginConfig = this.getPluginConfiguration(pluginName);
    if (!pluginConfig) {
      return {
        valid: false,
        errors: [`Plugin ${pluginName} not found`],
        warnings: [],
      };
    }

    // Check if component exists in the appropriate configuration section
    let componentExists = false;
    if (componentType === 'action' && pluginConfig.actions[componentName]) {
      componentExists = true;
    } else if (componentType === 'provider' && pluginConfig.providers[componentName]) {
      componentExists = true;
    } else if (componentType === 'evaluator' && pluginConfig.evaluators?.[componentName]) {
      componentExists = true;
    } else if (componentType === 'service' && pluginConfig.services?.[componentName]) {
      componentExists = true;
    }

    if (!componentExists) {
      return {
        valid: false,
        errors: [`Component ${componentName} not found in plugin ${pluginName}`],
        warnings: [],
      };
    }

    // Validate dependencies if enabling the component
    if (config.enabled && dependencies.length > 0 && enabledComponents) {
      const validationContext: ComponentValidationContext = {
        pluginName,
        componentName,
        componentType,
        dependencies,
        enabledComponents,
      };

      const validationResult = this.validateComponentDependencies(validationContext);
      
      // If validation fails and there are required dependencies missing, don't enable
      if (!validationResult.valid) {
        this.logger.warn(
          `Cannot enable ${componentType} "${componentName}" in plugin "${pluginName}": ${validationResult.errors.join(', ')}`
        );
        return validationResult;
      }

      // Log warnings if any
      if (validationResult.warnings.length > 0) {
        this.logger.warn(
          `Enabling ${componentType} "${componentName}" in plugin "${pluginName}" with warnings: ${validationResult.warnings.join(', ')}`
        );
      }
    }

    // Apply the configuration update
    const componentConfig: Partial<PluginConfiguration> = {};
    
    // Create a complete ComponentConfigState from the partial config
    const fullConfig: ComponentConfigState = {
      enabled: config.enabled ?? true,
      overrideLevel: config.overrideLevel ?? 'gui',
      overrideReason: config.overrideReason,
      settings: config.settings ?? {},
      lastModified: config.lastModified ?? new Date(),
    };
    
    if (componentType === 'action') {
      componentConfig.actions = { [componentName]: fullConfig };
    } else if (componentType === 'provider') {
      componentConfig.providers = { [componentName]: fullConfig };
    } else if (componentType === 'evaluator') {
      componentConfig.evaluators = { [componentName]: fullConfig };
    } else if (componentType === 'service') {
      componentConfig.services = { [componentName]: fullConfig };
    }

    await this.setOverride('gui', pluginName, componentConfig);

    return {
      valid: true,
      errors: [],
      warnings: [],
    };
  }

  /**
   * Initialize unified plugin configuration from ComponentDefinition array
   */
  initializeUnifiedPluginConfiguration(
    pluginName: string,
    components: any[], // ComponentDefinition[] but avoiding circular import
    defaultEnabled: boolean = true
  ): PluginConfiguration {
    const config: PluginConfiguration = {
      pluginName,
      enabled: defaultEnabled,
      actions: {},
      providers: {},
      evaluators: {},
      services: {},
      settings: {},
      lastModified: new Date(),
    };

    // Process unified components
    for (const componentDef of components) {
      let componentName: string;
      
      if (componentDef.type === 'service') {
        // For services, use serviceName property or fallback to name
        componentName = componentDef.name || (componentDef.component as any).serviceName || componentDef.component.name;
      } else {
        componentName = componentDef.name || componentDef.component.name;
      }
      
      const componentConfig = this.createComponentConfigState(componentDef.config);

      if (componentDef.type === 'action') {
        config.actions[componentName] = componentConfig;
      } else if (componentDef.type === 'provider') {
        config.providers[componentName] = componentConfig;
      } else if (componentDef.type === 'evaluator') {
        config.evaluators = config.evaluators || {};
        config.evaluators[componentName] = componentConfig;
      } else if (componentDef.type === 'service') {
        config.services = config.services || {};
        config.services[componentName] = componentConfig;
      }
    }

    // Store configuration
    this.configurations.set(pluginName, config);

    return config;
  }

  /**
   * Get enabled components map for dependency validation
   */
  getEnabledComponentsMap(): Map<string, Set<string>> {
    const enabledComponents = new Map<string, Set<string>>();

    for (const [pluginName, config] of this.configurations.entries()) {
      if (!config.enabled) continue;

      const componentSet = new Set<string>();

      // Add enabled actions
      for (const [actionName, actionConfig] of Object.entries(config.actions)) {
        if (actionConfig.enabled) {
          componentSet.add(`action:${actionName}`);
        }
      }

      // Add enabled providers
      for (const [providerName, providerConfig] of Object.entries(config.providers)) {
        if (providerConfig.enabled) {
          componentSet.add(`provider:${providerName}`);
        }
      }

      // Add enabled evaluators
      if (config.evaluators) {
        for (const [evaluatorName, evaluatorConfig] of Object.entries(config.evaluators)) {
          if (evaluatorConfig.enabled) {
            componentSet.add(`evaluator:${evaluatorName}`);
          }
        }
      }

      // Add enabled services
      if (config.services) {
        for (const [serviceName, serviceConfig] of Object.entries(config.services)) {
          if (serviceConfig.enabled) {
            componentSet.add(`service:${serviceName}`);
          }
        }
      }

      enabledComponents.set(pluginName, componentSet);
    }

    return enabledComponents;
  }
}
