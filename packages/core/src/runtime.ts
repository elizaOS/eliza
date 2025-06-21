import { v4 as uuidv4 } from 'uuid';
import { createUniqueUuid } from './entities';
import { decryptSecret, getSalt, safeReplacer } from './index';
import { createLogger } from './logger';
import type { PluginConfiguration } from './types/plugin-config.js';
import {
  ChannelType,
  ModelType,
  type Content,
  type MemoryMetadata,
  type Character,
  type Action,
  type Evaluator,
  type Provider,
  type HandlerCallback,
  type IDatabaseAdapter,
  type Entity,
  type Room,
  type World,
  type GetWorldsOptions,
  type SendHandlerFunction,
  type TargetInfo,
  type ModelParamsMap,
  type ModelResultMap,
  type ModelTypeName,
  type Plugin,
  type Route,
  type UUID,
  type Service,
  type ServiceTypeName,
  type State,
  type TaskWorker,
  type Agent,
  type Log,
  type Participant,
  type Relationship,
  type Task,
  type Memory,
  type ModelHandler,
  type RuntimeSettings,
  type Component,
  IAgentRuntime,
  type ActionResult,
  type ActionContext,
  type WorkingMemory as IWorkingMemory,
} from './types';

import { BM25 } from './search';
import { stringToUuid } from './utils';
import { EventEmitter } from 'events';
import {
  PlanExecutionContext,
  composePlanningPrompt,
  parsePlan,
  validatePlan as validatePlanUtil,
  executeStep,
  getExecutionOrder,
} from './planning';
import type { ActionPlan, PlanningContext, PlanExecutionResult } from './types/planning';
import { ConfigurationManager } from './managers/ConfigurationManager.js';
import { CharacterConfigurationSource } from './configuration/CharacterConfigurationSource.js';
import type {
  ConfigurablePlugin,
  ConfigurableAction,
  ConfigurableProvider,
} from './types/plugin-config.js';

const environmentSettings: RuntimeSettings = {};

export class Semaphore {
  private permits: number;
  private waiting: Array<() => void> = [];
  constructor(count: number) {
    this.permits = count;
  }
  async acquire(): Promise<void> {
    if (this.permits > 0) {
      this.permits--;
      return;
    }
    await new Promise<void>((resolve) => this.waiting.push(resolve));
  }
  release(): void {
    this.permits++;
    if (this.waiting.length > 0) {
      const next = this.waiting.shift();
      if (next) next();
    }
  }
}

// WorkingMemory implementation
class WorkingMemory implements IWorkingMemory {
  private memory: Map<string, any> = new Map();
  private history: Array<{ timestamp: number; key: string; value: any }> = [];

  set(key: string, value: any): void {
    this.memory.set(key, value);
    this.history.push({ timestamp: Date.now(), key, value });
  }

  get(key: string): any {
    return this.memory.get(key);
  }

  has(key: string): boolean {
    return this.memory.has(key);
  }

  delete(key: string): boolean {
    return this.memory.delete(key);
  }

  clear(): void {
    this.memory.clear();
    this.history = [];
  }

  entries(): IterableIterator<[string, any]> {
    return this.memory.entries();
  }

  getHistory(key?: string): Array<{ timestamp: number; key: string; value: any }> {
    if (key) {
      return this.history.filter((h) => h.key === key);
    }
    return [...this.history];
  }

  merge(other: WorkingMemory): void {
    for (const [key, value] of other.memory) {
      this.set(key, value);
    }
  }

  serialize(): Record<string, any> {
    return Object.fromEntries(this.memory);
  }
}

export class AgentRuntime implements IAgentRuntime {
  readonly #conversationLength = 32 as number;
  readonly agentId: UUID;
  readonly character: Character;
  public adapter!: IDatabaseAdapter;
  readonly actions: Action[] = [];
  readonly evaluators: Evaluator[] = [];
  readonly providers: Provider[] = [];
  readonly plugins: Plugin[] = [];
  private isInitialized = false;
  events: Map<string, ((params: any) => Promise<void>)[]> = new Map();
  stateCache = new Map<
    UUID,
    {
      values: { [key: string]: any };
      data: { [key: string]: any };
      text: string;
    }
  >();
  readonly fetch = fetch;
  services = new Map<ServiceTypeName, Service>();
  private serviceTypes = new Map<ServiceTypeName, typeof Service>();
  models = new Map<string, ModelHandler[]>();
  routes: Route[] = [];
  private taskWorkers = new Map<string, TaskWorker>();
  private sendHandlers = new Map<string, SendHandlerFunction>();
  private eventHandlers: Map<string, ((data: any) => void)[]> = new Map();

  // A map of all plugins available to the runtime, keyed by name, for dependency resolution.
  private allAvailablePlugins = new Map<string, Plugin>();
  // The initial list of plugins specified by the character configuration.
  private characterPlugins: Plugin[] = [];

  public logger;
  private settings: RuntimeSettings;
  private servicesInitQueue = new Set<typeof Service>();
  private pendingServices = new Map<string, typeof Service>();
  private currentRunId?: UUID; // Track the current run ID
  private currentActionContext?: {
    // Track current action execution context
    actionName: string;
    actionId: UUID;
    prompts: Array<{
      modelType: string;
      prompt: string;
      timestamp: number;
    }>;
  };

  // Add working memory support
  private workingMemories = new Map<UUID, WorkingMemory>();

  // Configuration management
  private configurationManager: ConfigurationManager;

  constructor(opts: {
    conversationLength?: number;
    agentId?: UUID;
    character?: Character;
    plugins?: Plugin[];
    fetch?: typeof fetch;
    adapter?: IDatabaseAdapter;
    settings?: RuntimeSettings;
    events?: { [key: string]: ((params: any) => void)[] };
    allAvailablePlugins?: Plugin[];
  }) {
    this.agentId =
      opts.character?.id ??
      opts?.agentId ??
      stringToUuid(opts.character?.name ?? uuidv4() + opts.character?.username);
    this.character = opts.character || ({} as Character);
    const logLevel = process.env.LOG_LEVEL || 'info';

    // Create the logger with appropriate level - only show debug logs when explicitly configured
    this.logger = createLogger({
      agentName: this.character?.name,
      logLevel: logLevel as any,
    });

    this.#conversationLength = opts.conversationLength ?? this.#conversationLength;
    if (opts.adapter) {
      this.registerDatabaseAdapter(opts.adapter);
    }
    this.fetch = (opts.fetch as typeof fetch) ?? this.fetch;
    this.settings = opts.settings ?? environmentSettings;

    this.plugins = []; // Initialize plugins as an empty array
    this.characterPlugins = opts?.plugins ?? []; // Store the original character plugins

    if (opts.allAvailablePlugins) {
      for (const plugin of opts.allAvailablePlugins) {
        if (plugin?.name) {
          this.allAvailablePlugins.set(plugin.name, plugin);
        }
      }
    }

    this.logger.debug(`Success: Agent ID: ${this.agentId}`);
    this.currentRunId = undefined; // Initialize run ID tracker

    // Initialize configuration manager
    this.configurationManager = new ConfigurationManager();
  }

  /**
   * Create a new run ID for tracking a sequence of model calls
   */
  createRunId(): UUID {
    return uuidv4() as UUID;
  }

  /**
   * Start a new run for tracking prompts
   */
  startRun(): UUID {
    this.currentRunId = this.createRunId();
    return this.currentRunId;
  }

  /**
   * End the current run
   */
  endRun(): void {
    this.currentRunId = undefined;
  }

  /**
   * Get the current run ID (creates one if it doesn't exist)
   */
  getCurrentRunId(): UUID {
    if (!this.currentRunId) {
      this.currentRunId = this.createRunId();
    }
    return this.currentRunId;
  }

  async registerPlugin(plugin: Plugin): Promise<void> {
    if (!plugin?.name) {
      // Ensure plugin and plugin.name are defined
      const errorMsg = 'Plugin or plugin name is undefined';
      this.logger.error(`*** registerPlugin: ${errorMsg}`);
      throw new Error(`*** registerPlugin: ${errorMsg}`);
    }

    // Check if a plugin with the same name is already registered.
    const existingPlugin = this.plugins.find((p) => p.name === plugin.name);
    if (existingPlugin) {
      this.logger.warn(
        `${this.character.name}(${this.agentId}) - Plugin ${plugin.name} is already registered. Skipping re-registration.`
      );
      return; // Do not proceed further with other registration steps
    }

    // Add the plugin to the runtime's list of active plugins
    (this.plugins as Plugin[]).push(plugin);
    this.logger.debug(
      `Success: Plugin ${plugin.name} added to active plugins for ${this.character.name}(${this.agentId}).`
    );

    // Initialize plugin configuration if it's a configurable plugin
    const configurablePlugin = plugin as ConfigurablePlugin;
    if (configurablePlugin.configurableActions || configurablePlugin.configurableProviders || configurablePlugin.configurableEvaluators) {
      this.configurationManager.initializePluginConfiguration(configurablePlugin);
    }

    // Check for unified component system support
    const hasUnifiedComponents = (plugin as any).components && Array.isArray((plugin as any).components);
    if (hasUnifiedComponents) {
      this.configurationManager.initializeUnifiedPluginConfiguration(
        plugin.name,
        (plugin as any).components,
        configurablePlugin.config?.defaultEnabled ?? true
      );
    }

    if (plugin.init) {
      try {
        await plugin.init(plugin.config || {}, this);
        this.logger.debug(`Success: Plugin ${plugin.name} initialized successfully`);
      } catch (error) {
        // Check if the error is related to missing API keys
        const errorMessage = error instanceof Error ? error.message : String(error);
        if (
          errorMessage.includes('API key') ||
          errorMessage.includes('environment variables') ||
          errorMessage.includes('Invalid plugin configuration')
        ) {
          console.warn(`Plugin ${plugin.name} requires configuration. ${errorMessage}`);
          console.warn(
            'Please check your environment variables and ensure all required API keys are set.'
          );
          console.warn('You can set these in your .env file.');
        } else {
          throw error;
        }
      }
    }
    if (plugin.adapter) {
      this.logger.debug(`Registering database adapter for plugin ${plugin.name}`);
      this.registerDatabaseAdapter(plugin.adapter);
    }

    // Register legacy actions (always enabled for backwards compatibility)
    if (plugin.actions) {
      for (const action of plugin.actions) {
        this.registerAction(action);
      }
    }

    // Register configurable actions (check configuration)
    if (configurablePlugin.configurableActions) {
      for (const action of configurablePlugin.configurableActions) {
        const isEnabled = this.configurationManager.isComponentEnabled(
          plugin.name,
          action.name,
          'action'
        );

        if (isEnabled) {
          this.registerAction(action);
          this.logger.debug(`Configurable action ${action.name} is enabled and registered`);
        } else {
          this.logger.debug(`Configurable action ${action.name} is disabled by configuration`);
        }
      }
    }

    // Register legacy evaluators (always enabled for backwards compatibility)
    if (plugin.evaluators) {
      for (const evaluator of plugin.evaluators) {
        this.registerEvaluator(evaluator);
      }
    }

    // Register configurable evaluators (check configuration)
    if (configurablePlugin.configurableEvaluators) {
      for (const evaluator of configurablePlugin.configurableEvaluators) {
        const isEnabled = this.configurationManager.isComponentEnabled(
          plugin.name,
          evaluator.name,
          'evaluator'
        );

        if (isEnabled) {
          this.registerEvaluator(evaluator);
          this.logger.debug(`Configurable evaluator ${evaluator.name} is enabled and registered`);
        } else {
          this.logger.debug(`Configurable evaluator ${evaluator.name} is disabled by configuration`);
        }
      }
    }

    // Register legacy providers (always enabled for backwards compatibility)
    if (plugin.providers) {
      for (const provider of plugin.providers) {
        this.registerProvider(provider);
      }
    }

    // Register configurable providers (check configuration)
    if (configurablePlugin.configurableProviders) {
      for (const provider of configurablePlugin.configurableProviders) {
        const isEnabled = this.configurationManager.isComponentEnabled(
          plugin.name,
          provider.name,
          'provider'
        );

        if (isEnabled) {
          this.registerProvider(provider);
          this.logger.debug(`Configurable provider ${provider.name} is enabled and registered`);
        } else {
          this.logger.debug(`Configurable provider ${provider.name} is disabled by configuration`);
        }
      }
    }

    // Process unified component system (components array)
    if (hasUnifiedComponents) {
      const components = (plugin as any).components;
      const enabledComponentsMap = this.configurationManager.getEnabledComponentsMap();

      for (const componentDef of components) {
        const componentName = componentDef.name || componentDef.component.name;
        const componentType = componentDef.type;
        
        // Check if component is enabled
        const isEnabled = this.configurationManager.isComponentEnabled(
          plugin.name,
          componentName,
          componentType
        );

        if (isEnabled) {
          // Validate dependencies if present
          if (componentDef.dependencies && componentDef.dependencies.length > 0) {
            const validationResult = this.configurationManager.validateComponentDependencies({
              pluginName: plugin.name,
              componentName,
              componentType,
              dependencies: componentDef.dependencies,
              enabledComponents: enabledComponentsMap,
            });

            if (!validationResult.valid) {
              this.logger.warn(
                `Skipping ${componentType} "${componentName}" in plugin "${plugin.name}": ${validationResult.errors.join(', ')}`
              );
              continue;
            }

            if (validationResult.warnings.length > 0) {
              this.logger.warn(
                `${componentType} "${componentName}" in plugin "${plugin.name}" has warnings: ${validationResult.warnings.join(', ')}`
              );
            }
          }

          // Register the component based on its type
          switch (componentType) {
            case 'action':
              this.registerAction(componentDef.component);
              this.logger.debug(`Unified action ${componentName} is enabled and registered`);
              break;
            case 'provider':
              this.registerProvider(componentDef.component);
              this.logger.debug(`Unified provider ${componentName} is enabled and registered`);
              break;
            case 'evaluator':
              this.registerEvaluator(componentDef.component);
              this.logger.debug(`Unified evaluator ${componentName} is enabled and registered`);
              break;
            case 'service':
              if (this.isInitialized) {
                await this.registerService(componentDef.component);
              } else {
                this.servicesInitQueue.add(componentDef.component);
              }
              this.logger.debug(`Unified service ${componentName} is enabled and registered`);
              break;
            default:
              this.logger.warn(`Unknown component type "${componentType}" for component "${componentName}"`);
          }
        } else {
          this.logger.debug(`Unified ${componentType} ${componentName} is disabled by configuration`);
        }
      }
    }

    if (plugin.models) {
      for (const [modelType, handler] of Object.entries(plugin.models)) {
        this.registerModel(
          modelType as ModelTypeName,
          handler as (params: any) => Promise<any>,
          plugin.name,
          plugin?.priority
        );
      }
    }
    if (plugin.routes) {
      for (const route of plugin.routes) {
        this.routes.push(route);
      }
    }
    if (plugin.events) {
      for (const [eventName, eventHandlers] of Object.entries(plugin.events)) {
        for (const eventHandler of eventHandlers) {
          this.registerEvent(eventName, eventHandler);
        }
      }
    }
    // Register legacy services (always enabled for backwards compatibility)
    if (plugin.services) {
      for (const service of plugin.services) {
        if (this.isInitialized) {
          await this.registerService(service);
        } else {
          this.servicesInitQueue.add(service);
        }
      }
    }

    // Register configurable services (check configuration)
    if (configurablePlugin.configurableServices) {
      for (const service of configurablePlugin.configurableServices) {
        const serviceName = service.service.serviceName || service.service.name;
        const isEnabled = this.configurationManager.isComponentEnabled(
          plugin.name,
          serviceName,
          'service'
        );

        if (isEnabled) {
          if (this.isInitialized) {
            await this.registerService(service.service);
          } else {
            this.servicesInitQueue.add(service.service);
          }
          this.logger.debug(`Configurable service ${serviceName} is enabled and registered`);
        } else {
          this.logger.debug(`Configurable service ${serviceName} is disabled by configuration`);
        }
      }
    }
  }

  getAllServices(): Map<ServiceTypeName, Service> {
    return this.services;
  }

  /**
   * Get the configuration manager for plugin component configuration
   */
  getConfigurationManager(): ConfigurationManager {
    return this.configurationManager;
  }

  async stop() {
    this.logger.debug(`runtime::stop - character ${this.character.name}`);
    for (const [serviceName, service] of this.services) {
      this.logger.debug(`runtime::stop - requesting service stop for ${serviceName}`);
      await service.stop();
    }
  }

  async initialize(): Promise<void> {
    if (this.isInitialized) {
      this.logger.warn('Agent already initialized');
      return;
    }

    // Register character-based configuration source if character has plugin config
    if (this.character.pluginConfig) {
      const characterConfigSource = new CharacterConfigurationSource(this.character);
      this.configurationManager.registerSource(characterConfigSource);
      this.logger.info('Registered character-based plugin configuration source');
    }

    // Load all configuration sources
    await this.configurationManager.reload();

    // The resolution is now expected to happen in the CLI layer (e.g., startAgent)
    // The runtime now accepts a pre-resolved, ordered list of plugins.
    const pluginsToLoad = this.characterPlugins;

    // Register plugins sequentially to maintain order, especially important for services
    for (const plugin of pluginsToLoad) {
      if (plugin) {
        await this.registerPlugin(plugin);
      }
    }

    if (!this.adapter) {
      this.logger.error(
        'Database adapter not initialized. Make sure @elizaos/plugin-sql is included in your plugins.'
      );
      throw new Error(
        'Database adapter not initialized. The SQL plugin (@elizaos/plugin-sql) is required for agent initialization. Please ensure it is included in your character configuration.'
      );
    }
    try {
      await this.adapter.init();

      this.logger.info('Initializing plugin schemas...');
      await this.initializePluginSchemas();
      this.logger.info('Plugin schema initialization completed.');

      const existingAgent = await this.ensureAgentExists(this.character as Partial<Agent>);
      if (!existingAgent) {
        const errorMsg = `Agent ${this.character.name} does not exist in database after ensureAgentExists call`;
        throw new Error(errorMsg);
      }

      // No need to transform agent's own ID
      let agentEntity = await this.getEntityById(this.agentId);

      if (!agentEntity) {
        const created = await this.createEntity({
          id: this.agentId,
          names: [this.character.name],
          metadata: {},
          agentId: existingAgent.id as UUID,
        });
        if (!created) {
          const errorMsg = `Failed to create entity for agent ${this.agentId}`;
          throw new Error(errorMsg);
        }

        agentEntity = await this.getEntityById(this.agentId);
        if (!agentEntity) throw new Error(`Agent entity not found for ${this.agentId}`);

        this.logger.debug(`Success: Agent entity created successfully for ${this.character.name}`);
      }
    } catch (error: any) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      this.logger.error(`Failed to create agent entity: ${errorMsg}`);
      throw error;
    }
    try {
      // Room creation and participant setup
      const room = await this.getRoom(this.agentId);
      if (!room) {
        await this.createRoom({
          id: this.agentId,
          name: this.character.name,
          source: 'elizaos',
          type: ChannelType.SELF,
          channelId: this.agentId,
          serverId: this.agentId,
          worldId: this.agentId,
        });
      }
      const participants = await this.adapter.getParticipantsForRoom(this.agentId);
      if (!participants.includes(this.agentId)) {
        const added = await this.addParticipant(this.agentId, this.agentId);
        if (!added) {
          const errorMsg = `Failed to add agent ${this.agentId} as participant to its own room`;
          throw new Error(errorMsg);
        }
        this.logger.debug(`Agent ${this.character.name} linked to its own room successfully`);
      }
    } catch (error: any) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      this.logger.error(`Failed to add agent as participant: ${errorMsg}`);
      throw error;
    }
    const embeddingModel = this.getModel(ModelType.TEXT_EMBEDDING);
    if (!embeddingModel) {
      this.logger.warn(
        `[AgentRuntime][${this.character.name}] No TEXT_EMBEDDING model registered. Skipping embedding dimension setup.`
      );
    } else {
      await this.ensureEmbeddingDimension();
    }
    for (const service of this.servicesInitQueue) {
      await this.registerService(service);
    }
    // Check if any services are still pending due to unmet dependencies
    if (this.pendingServices.size > 0) {
      const pendingNames = Array.from(this.pendingServices.keys());
      this.logger.warn(
        `${this.character.name}(${this.agentId}) - ${this.pendingServices.size} services could not be initialized due to unmet dependencies: ${pendingNames.join(', ')}`
      );
    }
    this.isInitialized = true;
  }

  async initializePluginSchemas(): Promise<void> {
    const drizzle = (this.adapter as any)?.db;
    if (!drizzle) {
      this.logger.warn('Drizzle instance not found on adapter, skipping plugin schema initialization.');
      return;
    }

    const pluginsWithSchemas = this.plugins.filter((p) => p.schema);
    this.logger.info(`Found ${pluginsWithSchemas.length} plugins with schemas to initialize.`);

    for (const p of pluginsWithSchemas) {
      if (p.schema) {
        this.logger.info(`Initializing schema for plugin: ${p.name}`);
        try {
          // Find the SQL plugin in our loaded plugins
          const sqlPlugin = this.plugins.find((plugin) => plugin.name === '@elizaos/plugin-sql');
          if (sqlPlugin && 'initializePluginSchema' in sqlPlugin) {
            // Use the new initializePluginSchema function from the SQL plugin
            await (sqlPlugin as any).initializePluginSchema(drizzle, p.name, p.schema);
            this.logger.info(`Successfully initialized schema for plugin: ${p.name}`);
          } else {
            this.logger.warn(
              `SQL plugin not found or missing initializePluginSchema method, skipping schema initialization for plugin: ${p.name}`
            );
          }
        } catch (error) {
          this.logger.error(`Failed to initialize schema for plugin ${p.name}:`, error);
          throw error;
        }
      }
    }
  }

  async getConnection(): Promise<unknown> {
    // Updated return type
    if (!this.adapter) {
      throw new Error('Database adapter not registered');
    }
    return this.adapter.getConnection();
  }

  setSetting(key: string, value: string | boolean | null | any, secret = false) {
    if (secret) {
      if (!this.character.secrets) {
        this.character.secrets = {};
      }
      this.character.secrets[key] = value;
    } else {
      if (!this.character.settings) {
        this.character.settings = {};
      }
      this.character.settings[key] = value;
    }
  }

  getSetting(key: string): string | boolean | null | any {
    const value =
      this.character.secrets?.[key] ||
      this.character.settings?.[key] ||
      this.character.settings?.secrets?.[key] ||
      this.settings[key];
    const decryptedValue = decryptSecret(value, getSalt());
    if (decryptedValue === 'true') return true;
    if (decryptedValue === 'false') return false;
    return decryptedValue || null;
  }

  getConversationLength() {
    return this.#conversationLength;
  }

  registerDatabaseAdapter(adapter: IDatabaseAdapter) {
    if (this.adapter) {
      this.logger.warn(
        'Database adapter already registered. Additional adapters will be ignored. This may lead to unexpected behavior.'
      );
    } else {
      this.adapter = adapter;
      this.logger.debug('Success: Database adapter registered successfully.');
    }
  }

  registerProvider(provider: Provider) {
    this.providers.push(provider);
    this.logger.debug(`Success: Provider ${provider.name} registered successfully.`);
  }

  registerAction(action: Action) {
    this.logger.debug(
      `${this.character.name}(${this.agentId}) - Registering action: ${action.name}`
    );
    if (this.actions.find((a) => a.name === action.name)) {
      this.logger.warn(
        `${this.character.name}(${this.agentId}) - Action ${action.name} already exists. Skipping registration.`
      );
    } else {
      this.actions.push(action);
      this.logger.debug(
        `${this.character.name}(${this.agentId}) - Action ${action.name} registered successfully.`
      );
    }
  }

  registerEvaluator(evaluator: Evaluator) {
    this.evaluators.push(evaluator);
  }

  async processActions(
    message: Memory,
    responses: Memory[],
    state?: State,
    callback?: HandlerCallback
  ): Promise<void> {
    for (const response of responses) {
      if (!response.content?.actions || response.content.actions.length === 0) {
        this.logger.warn('No action found in the response content.');
        continue;
      }
      const actions = response.content.actions;
      let accumulatedState = state;
      const actionResults: ActionResult[] = [];

      function normalizeAction(actionString: string) {
        return actionString.toLowerCase().replace('_', '');
      }
      this.logger.debug(`Found actions: ${this.actions.map((a) => normalizeAction(a.name))}`);

      for (const responseAction of actions) {
        // Compose state with previous action results
        accumulatedState = await this.composeState(message, [
          'RECENT_MESSAGES',
          'ACTION_STATE', // New provider we'll implement
        ]);

        this.logger.debug(`Success: Calling action: ${responseAction}`);
        const normalizedResponseAction = normalizeAction(responseAction);
        let action = this.actions.find(
          (a: { name: string }) =>
            normalizeAction(a.name).includes(normalizedResponseAction) ||
            normalizedResponseAction.includes(normalizeAction(a.name))
        );
        if (action) {
          this.logger.debug(`Success: Found action: ${action?.name}`);
        } else {
          this.logger.debug('Attempting to find action in similes.');
          for (const _action of this.actions) {
            const simileAction = _action.similes?.find(
              (simile) =>
                simile.toLowerCase().replace('_', '').includes(normalizedResponseAction) ||
                normalizedResponseAction.includes(simile.toLowerCase().replace('_', ''))
            );
            if (simileAction) {
              action = _action;
              this.logger.debug(`Success: Action found in similes: ${action.name}`);
              break;
            }
          }
        }
        if (!action) {
          const errorMsg = `No action found for: ${responseAction}`;
          this.logger.error(errorMsg);

          const actionMemory: Memory = {
            id: uuidv4() as UUID,
            entityId: message.entityId,
            roomId: message.roomId,
            worldId: message.worldId,
            content: {
              thought: errorMsg,
              source: 'auto',
            },
          };
          await this.createMemory(actionMemory, 'messages');
          continue;
        }
        if (!action.handler) {
          this.logger.error(`Action ${action.name} has no handler.`);
          continue;
        }
        try {
          this.logger.debug(`Executing handler for action: ${action.name}`);

          // Start tracking this action's execution
          const actionId = uuidv4() as UUID;
          this.currentActionContext = {
            actionName: action.name,
            actionId: actionId,
            prompts: [],
          };

          // Create action context
          const actionContext: ActionContext = {
            previousResults: actionResults,
            workingMemory: this.getWorkingMemory(message.roomId),
            updateMemory: (key: string, value: any) => {
              this.getWorkingMemory(message.roomId).set(key, value);
            },
            getMemory: (key: string) => {
              return this.getWorkingMemory(message.roomId).get(key);
            },
            getPreviousResult: (stepId: UUID) => {
              return actionResults.find((r) => r.data?.stepId === stepId);
            },
          };

          // Execute action with context
          const result = await action.handler(
            this,
            message,
            accumulatedState,
            { context: actionContext },
            callback,
            responses
          );

          // Handle backward compatibility for void, null, true, false returns
          const isLegacyReturn =
            result === undefined || result === null || typeof result === 'boolean';

          // Only create ActionResult if we have a proper result
          let actionResult: ActionResult | null = null;

          if (!isLegacyReturn) {
            // Ensure we have an ActionResult
            actionResult =
              typeof result === 'object' &&
              result !== null &&
              ('values' in result || 'data' in result || 'text' in result)
                ? (result as ActionResult)
                : {
                    data: {
                      actionName: action.name,
                      legacyResult: result,
                    },
                  };

            actionResults.push(actionResult);

            // Merge returned values into state
            if (actionResult.values) {
              accumulatedState = {
                ...accumulatedState,
                values: { ...accumulatedState.values, ...actionResult.values },
                data: {
                  ...accumulatedState.data,
                  actionResults: [...(accumulatedState.data?.actionResults || []), actionResult],
                },
              };
            }

            // Store in working memory
            this.updateWorkingMemory(message.roomId, responseAction, actionResult);
          }

          this.logger.debug(`Action ${action.name} completed`, {
            isLegacyReturn,
            result: isLegacyReturn ? result : undefined,
            hasValues: actionResult ? !!actionResult.values : false,
            hasData: actionResult ? !!actionResult.data : false,
            hasText: actionResult ? !!actionResult.text : false,
          });

          // log to database with collected prompts
          await this.adapter.log({
            entityId: message.entityId,
            roomId: message.roomId,
            type: 'action',
            body: {
              action: action.name,
              actionId: actionId,
              message: message.content.text,
              messageId: message.id,
              state: accumulatedState,
              responses,
              result: isLegacyReturn ? { legacy: result } : actionResult,
              isLegacyReturn,
              prompts: this.currentActionContext?.prompts || [],
              promptCount: this.currentActionContext?.prompts.length || 0,
            },
          });

          // Clear action context
          this.currentActionContext = undefined;
        } catch (error: any) {
          const errorMessage = error instanceof Error ? error.message : String(error);
          this.logger.error(error);

          // Clear action context on error
          this.currentActionContext = undefined;

          // Create error result
          const errorResult: ActionResult = {
            data: {
              actionName: action.name,
              error: errorMessage,
              errorObject: error,
            },
          };
          actionResults.push(errorResult);

          const actionMemory: Memory = {
            id: uuidv4() as UUID,
            content: {
              thought: errorMessage,
              source: 'auto',
            },
            entityId: message.entityId,
            roomId: message.roomId,
            worldId: message.worldId,
          };
          await this.createMemory(actionMemory, 'messages');

          // Decide whether to continue or abort
          if (this.shouldAbortOnError(error)) {
            throw error;
          }
        }
      }

      // Store accumulated results for evaluators and providers
      if (message.id) {
        this.stateCache.set(`${message.id}_action_results`, {
          values: { actionResults },
          data: { actionResults },
          text: JSON.stringify(actionResults),
        });
      }
    }
  }

  // New helper methods for working memory
  getWorkingMemory(roomId: UUID): WorkingMemory {
    if (!this.workingMemories.has(roomId)) {
      this.workingMemories.set(roomId, new WorkingMemory());
    }
    return this.workingMemories.get(roomId)!;
  }

  updateWorkingMemory(roomId: UUID, actionName: string, result: ActionResult): void {
    const memory = this.getWorkingMemory(roomId);
    memory.set(`action_${actionName}_${Date.now()}`, {
      actionName,
      result,
      timestamp: Date.now(),
    });
  }

  private shouldAbortOnError(error: any): boolean {
    // TODO: Implement logic to determine if we should abort on this error
    // For now, only abort on critical errors
    if (error?.critical || error?.code === 'CRITICAL_ERROR') {
      return true;
    }
    return false;
  }

  async evaluate(
    message: Memory,
    state: State,
    didRespond?: boolean,
    callback?: HandlerCallback,
    responses?: Memory[]
  ) {
    const evaluatorPromises = this.evaluators.map(async (evaluator: Evaluator) => {
      if (!evaluator.handler) {
        return null;
      }
      if (!didRespond && !evaluator.alwaysRun) {
        return null;
      }
      const result = await evaluator.validate(this, message, state);
      if (result) {
        return evaluator;
      }
      return null;
    });
    const evaluators = (await Promise.all(evaluatorPromises)).filter(Boolean) as Evaluator[];
    if (evaluators.length === 0) {
      return [];
    }
    state = await this.composeState(message, ['RECENT_MESSAGES', 'EVALUATORS']);
    await Promise.all(
      evaluators.map(async (evaluator) => {
        if (evaluator.handler) {
          await evaluator.handler(this, message, state, {}, callback, responses);
          this.adapter.log({
            entityId: message.entityId,
            roomId: message.roomId,
            type: 'evaluator',
            body: {
              evaluator: evaluator.name,
              messageId: message.id,
              message: message.content.text,
              state,
            },
          });
        }
      })
    );
    return evaluators;
  }

  // highly SQL optimized queries
  async ensureConnections(
    entities: any[],
    rooms: any[],
    source: string,
    world: any
  ): Promise<void> {
    // guards
    if (!entities) {
      console.trace();
      this.logger.error('ensureConnections - no entities');
      return;
    }
    if (!rooms || rooms.length === 0) {
      console.trace();
      this.logger.error('ensureConnections - no rooms');
      return;
    }

    // Create/ensure the world exists for this server
    await this.ensureWorldExists({ ...world, agentId: this.agentId });

    const firstRoom = rooms[0];

    // Helper function for chunking arrays
    const chunkArray = (arr: any[], size: number) =>
      arr.reduce((chunks: any[][], item: any, i: number) => {
        if (i % size === 0) chunks.push([]);
        chunks[chunks.length - 1].push(item);
        return chunks;
      }, []);

    // Step 1: Create all rooms FIRST (before adding any participants)
    const roomIds = rooms.map((r) => r.id);
    const roomExistsCheck = await this.getRoomsByIds(roomIds);
    const roomsIdExists = roomExistsCheck ? roomExistsCheck.map((r) => r.id) : [];
    const roomsToCreate = roomIds.filter((id) => !roomsIdExists.includes(id));

    const rf = {
      worldId: world.id,
      serverId: world.serverId,
      source,
      agentId: this.agentId,
    };

    if (roomsToCreate.length) {
      this.logger.debug(
        'runtime/ensureConnections - create',
        roomsToCreate.length.toLocaleString(),
        'rooms'
      );
      const roomObjsToCreate = rooms
        .filter((r) => roomsToCreate.includes(r.id))
        .map((r) => ({ ...r, ...rf }));
      await this.createRooms(roomObjsToCreate);
    }

    // Step 2: Create all entities
    const entityIds = entities.map((e) => e.id);
    const entityExistsCheck = await this.adapter.getEntityByIds(entityIds);
    const entitiesToUpdate = entityExistsCheck ? entityExistsCheck.map((e) => e.id) : [];
    const entitiesToCreate = entities.filter((e) => !entitiesToUpdate.includes(e.id));

    const r = {
      roomId: firstRoom.id,
      channelId: firstRoom.channelId,
      type: firstRoom.type,
    };
    const wf = {
      worldId: world.id,
      serverId: world.serverId,
    };

    if (entitiesToCreate.length) {
      this.logger.debug(
        'runtime/ensureConnections - creating',
        entitiesToCreate.length.toLocaleString(),
        'entities...'
      );
      const ef = {
        ...r,
        ...wf,
        source,
        agentId: this.agentId,
      };
      const entitiesToCreateWFields = entitiesToCreate.map((e) => ({ ...e, ...ef }));
      // pglite doesn't like over 10k records
      const batches = chunkArray(entitiesToCreateWFields, 5000);
      for (const batch of batches) {
        await this.createEntities(batch);
      }
    }

    // Step 3: Now add all participants (rooms and entities must exist by now)
    // Always add the agent to the first room
    await this.ensureParticipantInRoom(this.agentId, firstRoom.id);

    // Add all entities to the first room
    const entityIdsInFirstRoom = await this.getParticipantsForRoom(firstRoom.id);
    const entityIdsInFirstRoomFiltered = entityIdsInFirstRoom.filter(Boolean);
    const missingIdsInRoom = entityIds.filter((id) => !entityIdsInFirstRoomFiltered.includes(id));

    if (missingIdsInRoom.length) {
      this.logger.debug(
        'runtime/ensureConnections - Missing',
        missingIdsInRoom.length.toLocaleString(),
        'connections in',
        firstRoom.id
      );
      // pglite handle this at over 10k records fine though
      await this.addParticipantsRoom(missingIdsInRoom, firstRoom.id);
    }

    this.logger.info(`Success: Successfully connected world`);
  }

  async ensureConnection({
    entityId,
    roomId,
    worldId,
    worldName,
    userName,
    name,
    source,
    type,
    channelId,
    serverId,
    userId,
    metadata,
  }: {
    entityId: UUID;
    roomId: UUID;
    worldId: UUID;
    worldName?: string;
    userName?: string;
    name?: string;
    source?: string;
    type?: ChannelType;
    channelId?: string;
    serverId?: string;
    userId?: UUID;
    metadata?: Record<string, any>;
  }) {
    if (!worldId && serverId) {
      worldId = createUniqueUuid(this, serverId);
    }
    const names = [name, userName].filter((n): n is string => Boolean(n));
    const entityMetadata = {
      [source!]: {
        id: userId,
        name: name,
        userName: userName,
      },
    };
    try {
      // First check if the entity exists
      const entity = await this.getEntityById(entityId);

      if (!entity) {
        try {
          const success = await this.createEntity({
            id: entityId,
            names,
            metadata: entityMetadata,
            agentId: this.agentId,
          });
          if (success) {
            this.logger.debug(
              `Created new entity ${entityId} for user ${name || userName || 'unknown'}`
            );
          } else {
            throw new Error(`Failed to create entity ${entityId}`);
          }
        } catch (error: any) {
          if (error.message?.includes('duplicate key') || error.code === '23505') {
            this.logger.debug(
              `Entity ${entityId} exists in database but not for this agent. This is normal in multi-agent setups.`
            );
          } else {
            throw error;
          }
        }
      } else {
        await this.adapter.updateEntity({
          id: entityId,
          names: [
            ...new Set([...(entity.names || []), ...names.filter((n): n is string => Boolean(n))]),
          ],
          metadata: {
            ...entity.metadata,
            [source!]: {
              ...(entity.metadata?.[source!] as Record<string, any>),
              id: userId,
              name: name,
              userName: userName,
            },
          },
          agentId: this.agentId,
        });
      }
      await this.ensureWorldExists({
        id: worldId,
        name: worldName || serverId ? `World for server ${serverId}` : `World for room ${roomId}`,
        agentId: this.agentId,
        serverId: serverId || 'default',
        metadata,
      });
      await this.ensureRoomExists({
        id: roomId,
        name: name || 'Unnamed Room',
        source: source || 'unknown',
        type: type || ChannelType.DM,
        channelId,
        serverId,
        worldId,
        metadata,
      });
      try {
        await this.ensureParticipantInRoom(entityId, roomId);
      } catch (error: any) {
        if (error.message?.includes('not found')) {
          const added = await this.addParticipant(entityId, roomId);
          if (!added) {
            throw new Error(`Failed to add participant ${entityId} to room ${roomId}`);
          }
          this.logger.debug(`Added participant ${entityId} to room ${roomId} directly`);
        } else {
          throw error;
        }
      }
      await this.ensureParticipantInRoom(this.agentId, roomId);

      this.logger.debug(`Success: Successfully connected entity ${entityId} in room ${roomId}`);
    } catch (error) {
      this.logger.error(
        `Failed to ensure connection: ${error instanceof Error ? error.message : String(error)}`
      );
      throw error;
    }
  }

  async ensureParticipantInRoom(entityId: UUID, roomId: UUID) {
    // Make sure entity exists in database before adding as participant
    const entity = await this.getEntityById(entityId);

    // If entity is not found but it's not the agent itself, we might still want to proceed
    // This can happen when an entity exists in the database but isn't associated with this agent
    if (!entity && entityId !== this.agentId) {
      this.logger.warn(
        `Entity ${entityId} not directly accessible to agent ${this.agentId}. Will attempt to add as participant anyway.`
      );
    } else if (!entity && entityId === this.agentId) {
      throw new Error(`Agent entity ${entityId} not found, cannot add as participant.`);
    } else if (!entity) {
      throw new Error(`User entity ${entityId} not found, cannot add as participant.`);
    }
    const participants = await this.adapter.getParticipantsForRoom(roomId);
    if (!participants.includes(entityId)) {
      // Add participant using the ID
      const added = await this.addParticipant(entityId, roomId);

      if (!added) {
        throw new Error(`Failed to add participant ${entityId} to room ${roomId}`);
      }
      if (entityId === this.agentId) {
        this.logger.debug(`Agent ${this.character.name} linked to room ${roomId} successfully.`);
      } else {
        this.logger.debug(`User ${entityId} linked to room ${roomId} successfully.`);
      }
    }
  }

  async removeParticipant(entityId: UUID, roomId: UUID): Promise<boolean> {
    return await this.adapter.removeParticipant(entityId, roomId);
  }

  async getParticipantsForEntity(entityId: UUID): Promise<Participant[]> {
    return await this.adapter.getParticipantsForEntity(entityId);
  }

  async getParticipantsForRoom(roomId: UUID): Promise<UUID[]> {
    return await this.adapter.getParticipantsForRoom(roomId);
  }

  async addParticipant(entityId: UUID, roomId: UUID): Promise<boolean> {
    return await this.adapter.addParticipantsRoom([entityId], roomId);
  }

  async addParticipantsRoom(entityIds: UUID[], roomId: UUID): Promise<boolean> {
    return await this.adapter.addParticipantsRoom(entityIds, roomId);
  }

  /**
   * Ensure the existence of a world.
   */
  async ensureWorldExists({ id, name, serverId, metadata }: World) {
    const world = await this.getWorld(id);
    if (!world) {
      this.logger.debug('Creating world:', {
        id,
        name,
        serverId,
        agentId: this.agentId,
      });
      await this.adapter.createWorld({
        id,
        name,
        agentId: this.agentId,
        serverId: serverId || 'default',
        metadata,
      });
      this.logger.debug(`World ${id} created successfully.`);
    }
  }

  async ensureRoomExists({ id, name, source, type, channelId, serverId, worldId, metadata }: Room) {
    if (!worldId) throw new Error('worldId is required');
    const room = await this.getRoom(id);
    if (!room) {
      await this.createRoom({
        id,
        name,
        agentId: this.agentId,
        source,
        type,
        channelId,
        serverId,
        worldId,
        metadata,
      });
      this.logger.debug(`Room ${id} created successfully.`);
    }
  }

  async composeState(
    message: Memory,
    includeList: string[] | null = null,
    onlyInclude = false,
    skipCache = false
  ): Promise<State> {
    const filterList = onlyInclude ? includeList : null;
    const emptyObj = {
      values: {},
      data: {},
      text: '',
    } as State;
    const cachedState =
      skipCache || !message.id ? emptyObj : (await this.stateCache.get(message.id)) || emptyObj;

    const existingProviderNames = cachedState.data.providers
      ? Object.keys(cachedState.data.providers)
      : [];
    const providerNames = new Set<string>();
    if (filterList && filterList.length > 0) {
      filterList.forEach((name) => providerNames.add(name));
    } else {
      this.providers
        .filter((p) => !p.private && !p.dynamic)
        .forEach((p) => providerNames.add(p.name));
    }
    if (!filterList && includeList && includeList.length > 0) {
      includeList.forEach((name) => providerNames.add(name));
    }
    const providersToGet = Array.from(
      new Set(this.providers.filter((p) => providerNames.has(p.name)))
    ).sort((a, b) => (a.position || 0) - (b.position || 0));
    const providerData = await Promise.all(
      providersToGet.map(async (provider) => {
        const start = Date.now();
        try {
          const result = await provider.get(this, message, cachedState);
          const duration = Date.now() - start;

          this.logger.debug(`${provider.name} Provider took ${duration}ms to respond`);
          return {
            ...result,
            providerName: provider.name,
          };
        } catch (error: any) {
          console.error('provider error', provider.name, error);
          return { values: {}, text: '', data: {}, providerName: provider.name };
        }
      })
    );
    const currentProviderResults = { ...(cachedState.data?.providers || {}) };
    for (const freshResult of providerData) {
      currentProviderResults[freshResult.providerName] = freshResult;
    }
    const orderedTexts: string[] = [];
    for (const provider of providersToGet) {
      const result = currentProviderResults[provider.name];
      if (result && result.text && result.text.trim() !== '') {
        orderedTexts.push(result.text);
      }
    }
    const providersText = orderedTexts.join('\n');
    const aggregatedStateValues = { ...(cachedState.values || {}) };
    for (const provider of providersToGet) {
      const providerResult = currentProviderResults[provider.name];
      if (providerResult && providerResult.values && typeof providerResult.values === 'object') {
        Object.assign(aggregatedStateValues, providerResult.values);
      }
    }
    for (const providerName in currentProviderResults) {
      if (!providersToGet.some((p) => p.name === providerName)) {
        const providerResult = currentProviderResults[providerName];
        if (providerResult && providerResult.values && typeof providerResult.values === 'object') {
          Object.assign(aggregatedStateValues, providerResult.values);
        }
      }
    }
    const newState = {
      values: {
        ...aggregatedStateValues,
        providers: providersText,
      },
      data: {
        ...(cachedState.data || {}),
        providers: currentProviderResults,
      },
      text: providersText,
    } as State;
    if (message.id) {
      this.stateCache.set(message.id, newState);
    }
    const finalProviderCount = Object.keys(currentProviderResults).length;
    const finalProviderNames = Object.keys(currentProviderResults);
    const finalValueKeys = Object.keys(newState.values);
    return newState;
  }

  getService<T extends Service = Service>(serviceName: ServiceTypeName | string): T | null {
    const serviceInstance = this.services.get(serviceName as ServiceTypeName);
    if (!serviceInstance) {
      // it's not a warn, a plugin might just not be installed
      this.logger.debug(`Service ${serviceName} not found`);
      return null;
    }
    return serviceInstance as T;
  }

  /**
   * Get all services of a specific type
   * @param serviceType - The service type to filter by
   * @returns Array of services matching the specified type
   */
  getServicesByType(serviceType: ServiceTypeName): Service[] {
    const services: Service[] = [];
    for (const [serviceName, service] of this.services.entries()) {
      // Check if the service's constructor has the matching serviceType
      const ServiceClass = this.serviceTypes.get(serviceName);
      if (ServiceClass && ServiceClass.serviceType === serviceType) {
        services.push(service);
      }
    }
    return services;
  }

  /**
   * Type-safe service getter that ensures the correct service type is returned
   * @template T - The expected service class type
   * @param serviceName - The service type name
   * @returns The service instance with proper typing, or null if not found
   */
  getTypedService<T extends Service = Service>(serviceName: ServiceTypeName | string): T | null {
    return this.getService<T>(serviceName);
  }

  /**
   * Get all registered service types
   * @returns Array of registered service type names
   */
  getRegisteredServiceTypes(): ServiceTypeName[] {
    return Array.from(this.services.keys());
  }

  /**
   * Check if a service type is registered
   * @param serviceType - The service type to check
   * @returns true if the service is registered
   */
  hasService(serviceType: ServiceTypeName | string): boolean {
    return this.services.has(serviceType as ServiceTypeName);
  }

  /**
   * Process any pending services that were waiting for dependencies
   */
  private async processPendingServices(): Promise<void> {
    const pendingList = Array.from(this.pendingServices.entries());
    for (const [serviceName, serviceDef] of pendingList) {
      const dependencies = (serviceDef as any).dependencies || [];
      const missingDeps = dependencies.filter(
        (dep: string) => !this.services.has(dep as ServiceTypeName)
      );

      if (missingDeps.length === 0) {
        // All dependencies are now satisfied, remove from pending and register
        this.pendingServices.delete(serviceName);
        await this.registerService(serviceDef);
      }
    }
  }

  async registerService(serviceDef: typeof Service): Promise<void> {
    // Use serviceName as the unique key for registration
    const serviceName = serviceDef.serviceName || serviceDef.name;
    if (!serviceName) {
      this.logger.warn(
        `Service ${serviceDef.name} is missing serviceName. Please define a static serviceName property.`
      );
      return;
    }
    const serviceType = serviceDef.serviceType as ServiceTypeName;
    this.logger.debug(
      `${this.character.name}(${this.agentId}) - Registering service:`,
      serviceName
    );
    if (this.services.has(serviceName as ServiceTypeName)) {
      this.logger.warn(
        `${this.character.name}(${this.agentId}) - Service ${serviceName} is already registered. Skipping registration.`
      );
      return;
    }

    // Check if all dependencies are satisfied
    const dependencies = (serviceDef as any).dependencies || [];
    const missingDeps = dependencies.filter(
      (dep: string) => !this.services.has(dep as ServiceTypeName)
    );

    if (missingDeps.length > 0) {
      this.logger.debug(
        `${this.character.name}(${this.agentId}) - Service ${serviceName} has unmet dependencies: ${missingDeps.join(', ')}. Deferring registration.`
      );
      this.pendingServices.set(serviceName, serviceDef);
      return;
    }

    try {
      const serviceInstance = await serviceDef.start(this);
      this.services.set(serviceName as ServiceTypeName, serviceInstance);
      if (serviceType) {
        this.serviceTypes.set(serviceName as ServiceTypeName, serviceDef);
      }
      if (typeof (serviceDef as any).registerSendHandlers === 'function') {
        (serviceDef as any).registerSendHandlers(this, serviceInstance);
      }
      this.logger.debug(
        `${this.character.name}(${this.agentId}) - Service ${serviceName} registered successfully`
      );

      // Check if any pending services can now be registered
      await this.processPendingServices();
    } catch (error: any) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      this.logger.error(
        `${this.character.name}(${this.agentId}) - Failed to register service ${serviceName}: ${errorMessage}`
      );
      throw error;
    }
  }

  registerModel(
    modelType: ModelTypeName,
    handler: (params: any) => Promise<any>,
    provider: string,
    priority?: number
  ) {
    const modelKey = typeof modelType === 'string' ? modelType : ModelType[modelType];
    if (!this.models.has(modelKey)) {
      this.models.set(modelKey, []);
    }

    const registrationOrder = Date.now();
    this.models.get(modelKey)?.push({
      handler,
      provider,
      priority: priority || 0,
      registrationOrder,
    });
    // Sort by priority (higher priority first)
    // If priorities are equal, maintain insertion order
    this.models.get(modelKey)?.sort((a, b) => {
      const aPriority = a.priority ?? 0;
      const bPriority = b.priority ?? 0;
      if (bPriority !== aPriority) {
        return bPriority - aPriority;
      }
      // If priorities are equal, sort by registration order
      const aOrder = a.registrationOrder ?? Number.MAX_SAFE_INTEGER;
      const bOrder = b.registrationOrder ?? Number.MAX_SAFE_INTEGER;
      return aOrder - bOrder;
    });
  }

  getModel(
    modelType: ModelTypeName,
    provider?: string
  ): ((runtime: IAgentRuntime, params: any) => Promise<any>) | undefined {
    const modelKey = typeof modelType === 'string' ? modelType : ModelType[modelType];
    const models = this.models.get(modelKey);
    if (!models?.length) {
      return undefined;
    }
    if (provider) {
      const modelWithProvider = models.find((m) => m.provider === provider);
      if (modelWithProvider) {
        this.logger.debug(
          `[AgentRuntime][${this.character.name}] Using model ${modelKey} from provider ${provider}`
        );
        return modelWithProvider.handler;
      } else {
        this.logger.warn(
          `[AgentRuntime][${this.character.name}] No model found for provider ${provider}`
        );
      }
    }

    // Return highest priority handler (first in array after sorting)
    this.logger.debug(
      `[AgentRuntime][${this.character.name}] Using model ${modelKey} from provider ${models[0].provider}`
    );
    return models[0].handler;
  }

  async useModel<T extends ModelTypeName, R = ModelResultMap[T]>(
    modelType: T,
    params: Omit<ModelParamsMap[T], 'runtime'> | any,
    provider?: string
  ): Promise<R> {
    const modelKey = typeof modelType === 'string' ? modelType : ModelType[modelType];
    const promptContent =
      params?.prompt ||
      params?.input ||
      (Array.isArray(params?.messages) ? JSON.stringify(params.messages) : null);
    const model = this.getModel(modelKey, provider);
    if (!model) {
      const errorMsg = `No handler found for delegate type: ${modelKey}`;
      throw new Error(errorMsg);
    }

    // Log input parameters (keep debug log if useful)
    this.logger.debug(
      `[useModel] ${modelKey} input: ` +
        JSON.stringify(params, safeReplacer(), 2).replace(/\\n/g, '\n')
    );
    let paramsWithRuntime: any;
    if (
      params === null ||
      params === undefined ||
      typeof params !== 'object' ||
      Array.isArray(params) ||
      (typeof Buffer !== 'undefined' && Buffer.isBuffer(params))
    ) {
      paramsWithRuntime = params;
    } else {
      paramsWithRuntime = {
        ...params,
        runtime: this,
      };
    }
    const startTime = performance.now();
    try {
      const response = await model(this, paramsWithRuntime);
      const elapsedTime = performance.now() - startTime;

      // Log timing / response (keep debug log if useful)
      this.logger.debug(
        `[useModel] ${modelKey} output (took ${Number(elapsedTime.toFixed(2)).toLocaleString()}ms):`,
        Array.isArray(response)
          ? `${JSON.stringify(response.slice(0, 5))}...${JSON.stringify(response.slice(-5))} (${
              response.length
            } items)`
          : JSON.stringify(response, safeReplacer(), 2).replace(/\\n/g, '\n')
      );

      // Log all prompts except TEXT_EMBEDDING to track agent behavior
      if (modelKey !== ModelType.TEXT_EMBEDDING && promptContent) {
        // If we're in an action context, collect the prompt
        if (this.currentActionContext) {
          this.currentActionContext.prompts.push({
            modelType: modelKey,
            prompt: promptContent,
            timestamp: Date.now(),
          });
        }

        await this.adapter.log({
          entityId: this.agentId,
          roomId: this.agentId,
          body: {
            modelType,
            modelKey,
            prompt: promptContent,
            runId: this.getCurrentRunId(),
            timestamp: Date.now(),
            executionTime: elapsedTime,
            provider: provider || this.models.get(modelKey)?.[0]?.provider || 'unknown',
            actionContext: this.currentActionContext
              ? {
                  actionName: this.currentActionContext.actionName,
                  actionId: this.currentActionContext.actionId,
                }
              : undefined,
          },
          type: `prompt:${modelKey}`,
        });
      }

      // Keep the existing model logging for backward compatibility
      this.adapter.log({
        entityId: this.agentId,
        roomId: this.agentId,
        body: {
          modelType,
          modelKey,
          params: {
            ...(typeof params === 'object' && !Array.isArray(params) && params ? params : {}),
            prompt: promptContent,
          },
          response:
            Array.isArray(response) && response.every((x) => typeof x === 'number')
              ? '[array]'
              : response,
        },
        type: `useModel:${modelKey}`,
      });
      return response as R;
    } catch (error: any) {
      throw error;
    }
  }

  registerEvent(event: string, handler: (params: any) => Promise<void>) {
    if (!this.events.has(event)) {
      this.events.set(event, []);
    }
    this.events.get(event)?.push(handler);
  }

  getEvent(event: string): ((params: any) => Promise<void>)[] | undefined {
    return this.events.get(event);
  }

  async emitEvent(event: string | string[], params: any) {
    const events = Array.isArray(event) ? event : [event];
    for (const eventName of events) {
      const eventHandlers = this.events.get(eventName);
      if (!eventHandlers) {
        continue;
      }
      try {
        await Promise.all(eventHandlers.map((handler) => handler(params)));
      } catch (error) {
        this.logger.error(`Error during emitEvent for ${eventName} (handler execution):`, error);
        // throw error; // Re-throw if necessary
      }
    }
  }


  async ensureEmbeddingDimension() {
    this.logger.debug(`[AgentRuntime][${this.character.name}] Starting ensureEmbeddingDimension`);

    if (!this.adapter) {
      throw new Error(
        `[AgentRuntime][${this.character.name}] Database adapter not initialized before ensureEmbeddingDimension`
      );
    }
    try {
      const model = this.getModel(ModelType.TEXT_EMBEDDING);
      if (!model) {
        throw new Error(
          `[AgentRuntime][${this.character.name}] No TEXT_EMBEDDING model registered`
        );
      }

      this.logger.debug(`[AgentRuntime][${this.character.name}] Getting embedding dimensions`);
      const embedding = await this.useModel(ModelType.TEXT_EMBEDDING, null);
      if (!embedding || !embedding.length) {
        throw new Error(`[AgentRuntime][${this.character.name}] Invalid embedding received`);
      }

      this.logger.debug(
        `[AgentRuntime][${this.character.name}] Setting embedding dimension: ${embedding.length}`
      );
      await this.adapter.ensureEmbeddingDimension(embedding.length);
      this.logger.debug(
        `[AgentRuntime][${this.character.name}] Successfully set embedding dimension`
      );
    } catch (error) {
      this.logger.debug(
        `[AgentRuntime][${this.character.name}] Error in ensureEmbeddingDimension:`,
        error
      );
      throw error;
    }
  }

  registerTaskWorker(taskHandler: TaskWorker): void {
    if (this.taskWorkers.has(taskHandler.name)) {
      this.logger.warn(
        `Task definition ${taskHandler.name} already registered. Will be overwritten.`
      );
    }
    this.taskWorkers.set(taskHandler.name, taskHandler);
  }

  getTaskWorker(name: string): TaskWorker | undefined {
    return this.taskWorkers.get(name);
  }

  get db(): any {
    return this.adapter.db;
  }
  async init(): Promise<void> {
    await this.adapter.init();
  }
  async close(): Promise<void> {
    await this.adapter.close();
  }
  async getAgent(agentId: UUID): Promise<Agent | null> {
    return await this.adapter.getAgent(agentId);
  }
  async getAgents(): Promise<Partial<Agent>[]> {
    return await this.adapter.getAgents();
  }
  async createAgent(agent: Partial<Agent>): Promise<boolean> {
    return await this.adapter.createAgent(agent);
  }
  async updateAgent(agentId: UUID, agent: Partial<Agent>): Promise<boolean> {
    return await this.adapter.updateAgent(agentId, agent);
  }
  async deleteAgent(agentId: UUID): Promise<boolean> {
    return await this.adapter.deleteAgent(agentId);
  }
  async ensureAgentExists(agent: Partial<Agent>): Promise<Agent> {
    if (!agent.name) {
      throw new Error('Agent name is required');
    }

    const agents = await this.adapter.getAgents();
    const existingAgentId = agents.find((a) => a.name === agent.name)?.id;

    if (existingAgentId) {
      // Update the agent on restart with the latest character configuration
      const updatedAgent = {
        ...agent,
        id: existingAgentId,
        updatedAt: Date.now(),
      };

      await this.adapter.updateAgent(existingAgentId, updatedAgent);
      const existingAgent = await this.adapter.getAgent(existingAgentId);

      if (!existingAgent) {
        throw new Error(`Failed to retrieve agent after update: ${existingAgentId}`);
      }

      this.logger.debug(`Updated existing agent ${agent.name} on restart`);
      return existingAgent;
    }

    // Create new agent if it doesn't exist
    const newAgent: Agent = {
      ...agent,
      id: stringToUuid(agent.name),
    } as Agent;

    const created = await this.adapter.createAgent(newAgent);
    if (!created) {
      throw new Error(`Failed to create agent: ${agent.name}`);
    }

    this.logger.debug(`Created new agent ${agent.name}`);
    return newAgent;
  }
  async getEntityById(entityId: UUID): Promise<Entity | null> {
    const entities = await this.adapter.getEntityByIds([entityId]);
    if (!entities?.length) return null;
    return entities[0];
  }

  async getEntityByIds(entityIds: UUID[]): Promise<Entity[] | null> {
    return await this.adapter.getEntityByIds(entityIds);
  }
  async getEntitiesForRoom(roomId: UUID, includeComponents?: boolean): Promise<Entity[]> {
    return await this.adapter.getEntitiesForRoom(roomId, includeComponents);
  }
  async createEntity(entity: Entity): Promise<boolean> {
    if (!entity.agentId) {
      entity.agentId = this.agentId;
    }
    return await this.createEntities([entity]);
  }

  async createEntities(entities: Entity[]): Promise<boolean> {
    entities.forEach((e) => {
      e.agentId = this.agentId;
    });
    return await this.adapter.createEntities(entities);
  }

  async updateEntity(entity: Entity): Promise<void> {
    await this.adapter.updateEntity(entity);
  }
  async getComponent(
    entityId: UUID,
    type: string,
    worldId?: UUID,
    sourceEntityId?: UUID
  ): Promise<Component | null> {
    return await this.adapter.getComponent(entityId, type, worldId, sourceEntityId);
  }
  async getComponents(entityId: UUID, worldId?: UUID, sourceEntityId?: UUID): Promise<Component[]> {
    return await this.adapter.getComponents(entityId, worldId, sourceEntityId);
  }
  async createComponent(component: Component): Promise<boolean> {
    return await this.adapter.createComponent(component);
  }
  async updateComponent(component: Component): Promise<void> {
    await this.adapter.updateComponent(component);
  }
  async deleteComponent(componentId: UUID): Promise<void> {
    await this.adapter.deleteComponent(componentId);
  }
  async addEmbeddingToMemory(memory: Memory): Promise<Memory> {
    if (memory.embedding) {
      return memory;
    }
    const memoryText = memory.content.text;
    if (!memoryText) {
      throw new Error('Cannot generate embedding: Memory content is empty');
    }
    try {
      memory.embedding = await this.useModel(ModelType.TEXT_EMBEDDING, {
        text: memoryText,
      });
    } catch (error: any) {
      this.logger.error('Failed to generate embedding:', error);
      memory.embedding = await this.useModel(ModelType.TEXT_EMBEDDING, null);
    }
    return memory;
  }
  async getMemories(params: {
    entityId?: UUID;
    agentId?: UUID;
    roomId?: UUID;
    count?: number;
    unique?: boolean;
    tableName: string;
    start?: number;
    end?: number;
  }): Promise<Memory[]> {
    return await this.adapter.getMemories(params);
  }
  async getAllMemories(): Promise<Memory[]> {
    const tables = ['memories', 'messages', 'facts', 'documents'];
    const allMemories: Memory[] = [];

    for (const tableName of tables) {
      try {
        const memories = await this.adapter.getMemories({
          agentId: this.agentId,
          tableName,
          count: 10000, // Get a large number to fetch all
        });
        allMemories.push(...memories);
      } catch (error) {
        // Continue with other tables if one fails
        this.logger.debug(`Failed to get memories from table ${tableName}:`, error);
      }
    }

    return allMemories;
  }
  async getMemoryById(id: UUID): Promise<Memory | null> {
    return await this.adapter.getMemoryById(id);
  }
  async getMemoriesByIds(ids: UUID[], tableName?: string): Promise<Memory[]> {
    return await this.adapter.getMemoriesByIds(ids, tableName);
  }
  async getMemoriesByRoomIds(params: {
    tableName: string;
    roomIds: UUID[];
    limit?: number;
  }): Promise<Memory[]> {
    return await this.adapter.getMemoriesByRoomIds(params);
  }

  async getCachedEmbeddings(params: {
    query_table_name: string;
    query_threshold: number;
    query_input: string;
    query_field_name: string;
    query_field_sub_name: string;
    query_match_count: number;
  }): Promise<{ embedding: number[]; levenshtein_score: number }[]> {
    return await this.adapter.getCachedEmbeddings(params);
  }
  async log(params: {
    body: { [key: string]: unknown };
    entityId: UUID;
    roomId: UUID;
    type: string;
  }): Promise<void> {
    await this.adapter.log(params);
  }
  async searchMemories(params: {
    embedding: number[];
    query?: string;
    match_threshold?: number;
    count?: number;
    roomId?: UUID;
    unique?: boolean;
    worldId?: UUID;
    entityId?: UUID;
    tableName: string;
  }): Promise<Memory[]> {
    const memories = await this.adapter.searchMemories(params);
    if (params.query) {
      const rerankedMemories = await this.rerankMemories(params.query, memories);
      return rerankedMemories;
    }
    return memories;
  }
  async rerankMemories(query: string, memories: Memory[]): Promise<Memory[]> {
    const docs = memories.map((memory) => ({
      title: memory.id,
      content: memory.content.text,
    }));
    const bm25 = new BM25(docs);
    const results = bm25.search(query, memories.length);
    return results.map((result) => memories[result.index]);
  }
  async createMemory(memory: Memory, tableName: string, unique?: boolean): Promise<UUID> {
    return await this.adapter.createMemory(memory, tableName, unique);
  }
  async updateMemory(
    memory: Partial<Memory> & { id: UUID; metadata?: MemoryMetadata }
  ): Promise<boolean> {
    return await this.adapter.updateMemory(memory);
  }
  async deleteMemory(memoryId: UUID): Promise<void> {
    await this.adapter.deleteMemory(memoryId);
  }
  async deleteManyMemories(memoryIds: UUID[]): Promise<void> {
    await this.adapter.deleteManyMemories(memoryIds);
  }
  async clearAllAgentMemories(): Promise<void> {
    this.logger.info(`Clearing all memories for agent ${this.character.name} (${this.agentId})`);

    const allMemories = await this.getAllMemories();
    const memoryIds = allMemories.map((memory) => memory.id);

    if (memoryIds.length === 0) {
      this.logger.info('No memories found to delete');
      return;
    }

    this.logger.info(`Found ${memoryIds.length} memories to delete`);
    await this.adapter.deleteManyMemories(memoryIds);

    this.logger.info(`Successfully cleared all ${memoryIds.length} memories for agent`);
  }
  async deleteAllMemories(roomId: UUID, tableName: string): Promise<void> {
    await this.adapter.deleteAllMemories(roomId, tableName);
  }
  async countMemories(roomId: UUID, unique?: boolean, tableName?: string): Promise<number> {
    return await this.adapter.countMemories(roomId, unique, tableName);
  }
  async getLogs(params: {
    entityId: UUID;
    roomId?: UUID;
    type?: string;
    count?: number;
    offset?: number;
  }): Promise<Log[]> {
    return await this.adapter.getLogs(params);
  }
  async deleteLog(logId: UUID): Promise<void> {
    await this.adapter.deleteLog(logId);
  }
  async createWorld(world: World): Promise<UUID> {
    return await this.adapter.createWorld(world);
  }
  async getWorld(id: UUID): Promise<World | null> {
    return await this.adapter.getWorld(id);
  }
  async removeWorld(worldId: UUID): Promise<void> {
    await this.adapter.removeWorld(worldId);
  }
  async getAllWorlds(): Promise<World[]> {
    return await this.adapter.getAllWorlds();
  }
  async updateWorld(world: World): Promise<void> {
    await this.adapter.updateWorld(world);
  }

  async getWorlds(options?: GetWorldsOptions): Promise<World[]> {
    return await this.adapter.getWorlds({
      agentId: this.agentId,
      ...options,
    });
  }
  async getRoom(roomId: UUID): Promise<Room | null> {
    const rooms = await this.adapter.getRoomsByIds([roomId]);
    if (!rooms?.length) return null;
    return rooms[0];
  }

  async getRoomsByIds(roomIds: UUID[]): Promise<Room[] | null> {
    return await this.adapter.getRoomsByIds(roomIds);
  }
  async createRoom({ id, name, source, type, channelId, serverId, worldId }: Room): Promise<UUID> {
    try {
      const existingRoom = await this.getRoom(id);
      if (existingRoom) {
        return existingRoom.id;
      }
      const res = await this.adapter.createRooms([
        {
          id,
          name,
          source,
          type,
          channelId,
          serverId,
          worldId: worldId || this.agentId, // Use agent ID as fallback world ID
          agentId: this.agentId,
        },
      ]);
      if (!res.length) {
        throw new Error('Failed to create room - empty result');
      }
      return res[0];
    } catch (error: any) {
      throw new Error(`Failed to create room: ${error.message}`);
    }
  }

  async createRooms(rooms: Room[]): Promise<UUID[]> {
    return await this.adapter.createRooms(rooms);
  }

  async deleteRoom(roomId: UUID): Promise<void> {
    await this.adapter.deleteRoom(roomId);
  }
  async deleteRoomsByWorldId(worldId: UUID): Promise<void> {
    await this.adapter.deleteRoomsByWorldId(worldId);
  }
  async updateRoom(room: Room): Promise<void> {
    await this.adapter.updateRoom(room);
  }
  async getRoomsForParticipant(entityId: UUID): Promise<UUID[]> {
    return await this.adapter.getRoomsForParticipant(entityId);
  }
  async getRoomsForParticipants(userIds: UUID[]): Promise<UUID[]> {
    return await this.adapter.getRoomsForParticipants(userIds);
  }

  // deprecate this one
  async getRooms(worldId: UUID): Promise<Room[]> {
    return await this.adapter.getRoomsByWorld(worldId);
  }

  async getRoomsByWorld(worldId: UUID): Promise<Room[]> {
    return await this.adapter.getRoomsByWorld(worldId);
  }
  async getParticipantUserState(
    roomId: UUID,
    entityId: UUID
  ): Promise<'FOLLOWED' | 'MUTED' | null> {
    return await this.adapter.getParticipantUserState(roomId, entityId);
  }
  async setParticipantUserState(
    roomId: UUID,
    entityId: UUID,
    state: 'FOLLOWED' | 'MUTED' | null
  ): Promise<void> {
    await this.adapter.setParticipantUserState(roomId, entityId, state);
  }
  async createRelationship(params: {
    sourceEntityId: UUID;
    targetEntityId: UUID;
    tags?: string[];
    metadata?: { [key: string]: any };
  }): Promise<boolean> {
    return await this.adapter.createRelationship(params);
  }
  async updateRelationship(relationship: Relationship): Promise<void> {
    await this.adapter.updateRelationship(relationship);
  }
  async getRelationship(params: {
    sourceEntityId: UUID;
    targetEntityId: UUID;
  }): Promise<Relationship | null> {
    return await this.adapter.getRelationship(params);
  }
  async getRelationships(params: { entityId: UUID; tags?: string[] }): Promise<Relationship[]> {
    return await this.adapter.getRelationships(params);
  }
  async getCache<T>(key: string): Promise<T | undefined> {
    return await this.adapter.getCache<T>(key);
  }
  async setCache<T>(key: string, value: T): Promise<boolean> {
    return await this.adapter.setCache<T>(key, value);
  }
  async deleteCache(key: string): Promise<boolean> {
    return await this.adapter.deleteCache(key);
  }
  async createTask(task: Task): Promise<UUID> {
    return await this.adapter.createTask(task);
  }
  async getTasks(params: { roomId?: UUID; tags?: string[]; entityId?: UUID }): Promise<Task[]> {
    return await this.adapter.getTasks(params);
  }
  async getTask(id: UUID): Promise<Task | null> {
    return await this.adapter.getTask(id);
  }
  async getTasksByName(name: string): Promise<Task[]> {
    return await this.adapter.getTasksByName(name);
  }
  async updateTask(id: UUID, task: Partial<Task>): Promise<void> {
    await this.adapter.updateTask(id, task);
  }
  async deleteTask(id: UUID): Promise<void> {
    await this.adapter.deleteTask(id);
  }
  on(event: string, callback: (data: any) => void): void {
    if (!this.eventHandlers.has(event)) {
      this.eventHandlers.set(event, []);
    }
    this.eventHandlers.get(event)?.push(callback);
  }
  off(event: string, callback: (data: any) => void): void {
    if (!this.eventHandlers.has(event)) {
      return;
    }
    const handlers = this.eventHandlers.get(event)!;
    const index = handlers.indexOf(callback);
    if (index !== -1) {
      handlers.splice(index, 1);
    }
  }
  emit(event: string, data: any): void {
    if (!this.eventHandlers.has(event)) {
      return;
    }
    for (const handler of this.eventHandlers.get(event)!) {
      handler(data);
    }
  }
  async sendControlMessage(params: {
    roomId: UUID;
    action: 'enable_input' | 'disable_input';
    target?: string;
  }): Promise<void> {
    try {
      const { roomId, action, target } = params;
      const controlMessage = {
        type: 'control',
        payload: {
          action,
          target,
        },
        roomId,
      };
      await this.emitEvent('CONTROL_MESSAGE', {
        runtime: this,
        message: controlMessage,
        source: 'agent',
      });

      this.logger.debug(`Sent control message: ${action} to room ${roomId}`);
    } catch (error) {
      this.logger.error(`Error sending control message: ${error}`);
    }
  }
  registerSendHandler(source: string, handler: SendHandlerFunction): void {
    if (this.sendHandlers.has(source)) {
      this.logger.warn(`Send handler for source '${source}' already registered. Overwriting.`);
    }
    this.sendHandlers.set(source, handler);
    this.logger.info(`Registered send handler for source: ${source}`);
  }
  async sendMessageToTarget(target: TargetInfo, content: Content): Promise<void> {
    const handler = this.sendHandlers.get(target.source);
    if (!handler) {
      const errorMsg = `No send handler registered for source: ${target.source}`;
      this.logger.error(errorMsg);
      // Optionally throw or just log the error
      throw new Error(errorMsg);
    }
    try {
      await handler(this, target, content);
    } catch (error: any) {
      this.logger.error(`Error executing send handler for source ${target.source}:`, error);
      throw error; // Re-throw error after logging and tracing
    }
  }
  async getMemoriesByWorldId(params: {
    worldId: UUID;
    count?: number;
    tableName?: string;
  }): Promise<Memory[]> {
    return await this.adapter.getMemoriesByWorldId(params);
  }
  async runMigrations(migrationsPaths?: string[]): Promise<void> {
    if (this.adapter && 'runMigrations' in this.adapter) {
      await (this.adapter as any).runMigrations(migrationsPaths);
    } else {
      this.logger.warn('Database adapter does not support migrations.');
    }
  }

  async isReady(): Promise<boolean> {
    if (!this.adapter) {
      throw new Error('Database adapter not registered');
    }
    return await this.adapter.isReady();
  }

  /**
   * Generate an action plan based on the given message and context
   */
  async generatePlan(message: Memory, context: PlanningContext): Promise<ActionPlan> {
    try {
      // Compose state for planning
      const state = await this.composeState(message);

      // Create planning prompt
      const prompt = composePlanningPrompt(context, state);

      // Use reasoning model to generate plan
      const response = await this.useModel(ModelType.TEXT_REASONING_LARGE, {
        prompt,
        temperature: 0.7,
        maxTokens: 2000,
      });

      // Parse the plan from the response
      const plan = parsePlan(response);

      // Validate the plan
      const validation = await this.validatePlan(plan);
      if (!validation.valid) {
        throw new Error(`Invalid plan: ${validation.issues.join(', ')}`);
      }

      return plan;
    } catch (error) {
      this.logger.error('Failed to generate plan:', error);
      throw error;
    }
  }

  /**
   * Execute an action plan
   */
  async executePlan(
    plan: ActionPlan,
    message: Memory,
    callback?: HandlerCallback
  ): Promise<PlanExecutionResult> {
    const context = new PlanExecutionContext(plan);

    try {
      // Update plan state
      plan.state.status = 'running';
      plan.state.startTime = Date.now();

      // Get execution order based on dependencies
      const executionOrder = getExecutionOrder(plan);

      // Execute steps in order
      for (const stepGroup of executionOrder) {
        if (context.shouldAbort()) {
          break;
        }

        // Execute steps in parallel if multiple in group
        if (stepGroup.length > 1 && plan.executionModel !== 'sequential') {
          const promises = stepGroup.map((stepId) => {
            const step = plan.steps.find((s) => s.id === stepId);
            if (!step) return Promise.resolve();

            return executeStep(step, context, this, message, callback).catch((error) => {
              context.addError(error);
              if (step.onError === 'abort') {
                context.abort();
              }
            });
          });

          await Promise.all(promises);
        } else {
          // Execute steps sequentially
          for (const stepId of stepGroup) {
            if (context.shouldAbort()) {
              break;
            }

            const step = plan.steps.find((s) => s.id === stepId);
            if (!step) continue;

            try {
              await executeStep(step, context, this, message, callback);
            } catch (error) {
              context.addError(error as Error);
              if (step.onError === 'abort') {
                context.abort();
                break;
              }
            }
          }
        }
      }

      // Update plan state
      plan.state.status = context.hasError() ? 'failed' : 'completed';
      plan.state.endTime = Date.now();

      return context.getResult();
    } catch (error) {
      this.logger.error('Failed to execute plan:', error);
      plan.state.status = 'failed';
      plan.state.endTime = Date.now();
      plan.state.error = error as Error;

      context.addError(error as Error);
      return context.getResult();
    }
  }

  /**
   * Validate a plan
   */
  async validatePlan(plan: ActionPlan): Promise<{ valid: boolean; issues: string[] }> {
    return validatePlanUtil(plan, this);
  }



  /**
   * Configure plugin components dynamically
   */
  async configurePlugin(
    pluginName: string,
    config: {
      enabled?: boolean;
      actions?: Record<string, { 
        enabled: boolean;
        overrideLevel?: 'default' | 'plugin' | 'database' | 'gui' | 'runtime';
        overrideReason?: string;
        settings?: Record<string, any>;
        lastModified?: Date;
      }>;
      providers?: Record<string, { 
        enabled: boolean;
        overrideLevel?: 'default' | 'plugin' | 'database' | 'gui' | 'runtime';
        overrideReason?: string;
        settings?: Record<string, any>;
        lastModified?: Date;
      }>;
      evaluators?: Record<string, { 
        enabled: boolean;
        overrideLevel?: 'default' | 'plugin' | 'database' | 'gui' | 'runtime';
        overrideReason?: string;
        settings?: Record<string, any>;
        lastModified?: Date;
      }>;
      services?: Record<string, { 
        enabled: boolean;
        overrideLevel?: 'default' | 'plugin' | 'database' | 'gui' | 'runtime';
        overrideReason?: string;
        settings?: Record<string, any>;
        lastModified?: Date;
      }>;
    }
  ): Promise<void> {
    
    // Convert simple config to ComponentConfigState format
    const pluginConfig: Partial<PluginConfiguration> = {
      enabled: config.enabled,
      actions: config.actions
        ? Object.fromEntries(
            Object.entries(config.actions).map(([name, conf]) => [
              name,
              { 
                enabled: conf.enabled, 
                overrideLevel: conf.overrideLevel || 'runtime' as const,
                overrideReason: conf.overrideReason,
                settings: conf.settings || {},
                lastModified: conf.lastModified || new Date() 
              },
            ])
          )
        : undefined,
      providers: config.providers
        ? Object.fromEntries(
            Object.entries(config.providers).map(([name, conf]) => [
              name,
              { 
                enabled: conf.enabled, 
                overrideLevel: conf.overrideLevel || 'runtime' as const,
                overrideReason: conf.overrideReason,
                settings: conf.settings || {},
                lastModified: conf.lastModified || new Date() 
              },
            ])
          )
        : undefined,
      evaluators: config.evaluators
        ? Object.fromEntries(
            Object.entries(config.evaluators).map(([name, conf]) => [
              name,
              { 
                enabled: conf.enabled, 
                overrideLevel: conf.overrideLevel || 'runtime' as const,
                overrideReason: conf.overrideReason,
                settings: conf.settings || {},
                lastModified: conf.lastModified || new Date() 
              },
            ])
          )
        : undefined,
      services: config.services
        ? Object.fromEntries(
            Object.entries(config.services).map(([name, conf]) => [
              name,
              { 
                enabled: conf.enabled, 
                overrideLevel: conf.overrideLevel || 'runtime' as const,
                overrideReason: conf.overrideReason,
                settings: conf.settings || {},
                lastModified: conf.lastModified || new Date() 
              },
            ])
          )
        : undefined,
    };

    // Determine the override level from the first component config if specified
    let overrideLevel: 'gui' | 'database' | 'plugin-manager' | 'runtime' = 'runtime';
    if (config.actions && Object.keys(config.actions).length > 0) {
      const firstAction = Object.values(config.actions)[0];
      if (firstAction.overrideLevel && ['gui', 'database', 'plugin-manager', 'runtime'].includes(firstAction.overrideLevel)) {
        overrideLevel = firstAction.overrideLevel as any;
      }
    } else if (config.providers && Object.keys(config.providers).length > 0) {
      const firstProvider = Object.values(config.providers)[0];
      if (firstProvider.overrideLevel && ['gui', 'database', 'plugin-manager', 'runtime'].includes(firstProvider.overrideLevel)) {
        overrideLevel = firstProvider.overrideLevel as any;
      }
    } else if (config.evaluators && Object.keys(config.evaluators).length > 0) {
      const firstEvaluator = Object.values(config.evaluators)[0];
      if (firstEvaluator.overrideLevel && ['gui', 'database', 'plugin-manager', 'runtime'].includes(firstEvaluator.overrideLevel)) {
        overrideLevel = firstEvaluator.overrideLevel as any;
      }
    } else if (config.services && Object.keys(config.services).length > 0) {
      const firstService = Object.values(config.services)[0];
      if (firstService.overrideLevel && ['gui', 'database', 'plugin-manager', 'runtime'].includes(firstService.overrideLevel)) {
        overrideLevel = firstService.overrideLevel as any;
      }
    }

    await this.configurationManager.setOverride(overrideLevel, pluginName, pluginConfig);

    // Re-register affected components
    const plugin = this.plugins.find((p) => p.name === pluginName);
    if (plugin) {
      const configurablePlugin = plugin as ConfigurablePlugin;

      // Handle legacy actions (standard Plugin interface)
      if (plugin.actions && config.actions) {
        for (const [actionName, actionConfig] of Object.entries(config.actions)) {
          const action = plugin.actions.find((a) => a.name === actionName);
          if (action) {
            const currentlyRegistered = this.actions.some((a) => a.name === actionName);

            if (actionConfig.enabled && !currentlyRegistered) {
              // Enable action
              this.registerAction(action);
              this.logger.info(`Legacy action ${actionName} enabled for plugin ${pluginName}`);
            } else if (!actionConfig.enabled && currentlyRegistered) {
              // Disable action
              const index = this.actions.findIndex((a) => a.name === actionName);
              if (index !== -1) {
                this.actions.splice(index, 1);
                this.logger.info(`Legacy action ${actionName} disabled for plugin ${pluginName}`);
              }
            }
          }
        }
      }

      // Handle configurable actions
      if (configurablePlugin.configurableActions && config.actions) {
        for (const [actionName, actionConfig] of Object.entries(config.actions)) {
          const action = configurablePlugin.configurableActions.find((a) => a.name === actionName);
          if (action) {
            const currentlyRegistered = this.actions.some((a) => a.name === actionName);

            if (actionConfig.enabled && !currentlyRegistered) {
              // Enable action
              this.registerAction(action);
              this.logger.info(`Action ${actionName} enabled for plugin ${pluginName}`);
            } else if (!actionConfig.enabled && currentlyRegistered) {
              // Disable action
              const index = this.actions.findIndex((a) => a.name === actionName);
              if (index !== -1) {
                this.actions.splice(index, 1);
                this.logger.info(`Action ${actionName} disabled for plugin ${pluginName}`);
              }
            }
          }
        }
      }

      // Handle legacy providers (standard Plugin interface)
      if (plugin.providers && config.providers) {
        for (const [providerName, providerConfig] of Object.entries(config.providers)) {
          const provider = plugin.providers.find((p) => p.name === providerName);
          if (provider) {
            const currentlyRegistered = this.providers.some((p) => p.name === providerName);

            if (providerConfig.enabled && !currentlyRegistered) {
              // Enable provider
              this.registerProvider(provider);
              this.logger.info(`Legacy provider ${providerName} enabled for plugin ${pluginName}`);
            } else if (!providerConfig.enabled && currentlyRegistered) {
              // Disable provider
              const index = this.providers.findIndex((p) => p.name === providerName);
              if (index !== -1) {
                this.providers.splice(index, 1);
                this.logger.info(`Legacy provider ${providerName} disabled for plugin ${pluginName}`);
              }
            }
          }
        }
      }

      // Handle configurable providers
      if (configurablePlugin.configurableProviders && config.providers) {
        for (const [providerName, providerConfig] of Object.entries(config.providers)) {
          const provider = configurablePlugin.configurableProviders.find(
            (p) => p.name === providerName
          );
          if (provider) {
            const currentlyRegistered = this.providers.some((p) => p.name === providerName);

            if (providerConfig.enabled && !currentlyRegistered) {
              // Enable provider
              this.registerProvider(provider);
              this.logger.info(`Provider ${providerName} enabled for plugin ${pluginName}`);
            } else if (!providerConfig.enabled && currentlyRegistered) {
              // Disable provider
              const index = this.providers.findIndex((p) => p.name === providerName);
              if (index !== -1) {
                this.providers.splice(index, 1);
                this.logger.info(`Provider ${providerName} disabled for plugin ${pluginName}`);
              }
            }
          }
        }
      }

      // Handle legacy evaluators (standard Plugin interface)
      if (plugin.evaluators && config.evaluators) {
        for (const [evaluatorName, evaluatorConfig] of Object.entries(config.evaluators)) {
          const evaluator = plugin.evaluators.find((e) => e.name === evaluatorName);
          if (evaluator) {
            const currentlyRegistered = this.evaluators.some((e) => e.name === evaluatorName);

            if (evaluatorConfig.enabled && !currentlyRegistered) {
              // Enable evaluator
              this.registerEvaluator(evaluator);
              this.logger.info(`Legacy evaluator ${evaluatorName} enabled for plugin ${pluginName}`);
            } else if (!evaluatorConfig.enabled && currentlyRegistered) {
              // Disable evaluator
              const index = this.evaluators.findIndex((e) => e.name === evaluatorName);
              if (index !== -1) {
                this.evaluators.splice(index, 1);
                this.logger.info(`Legacy evaluator ${evaluatorName} disabled for plugin ${pluginName}`);
              }
            }
          }
        }
      }

      // Handle configurable evaluators
      if (configurablePlugin.configurableEvaluators && config.evaluators) {
        for (const [evaluatorName, evaluatorConfig] of Object.entries(config.evaluators)) {
          const evaluator = configurablePlugin.configurableEvaluators.find(
            (e) => e.name === evaluatorName
          );
          if (evaluator) {
            const currentlyRegistered = this.evaluators.some((e) => e.name === evaluatorName);

            if (evaluatorConfig.enabled && !currentlyRegistered) {
              // Enable evaluator
              this.registerEvaluator(evaluator);
              this.logger.info(`Evaluator ${evaluatorName} enabled for plugin ${pluginName}`);
            } else if (!evaluatorConfig.enabled && currentlyRegistered) {
              // Disable evaluator
              const index = this.evaluators.findIndex((e) => e.name === evaluatorName);
              if (index !== -1) {
                this.evaluators.splice(index, 1);
                this.logger.info(`Evaluator ${evaluatorName} disabled for plugin ${pluginName}`);
              }
            }
          }
        }
      }

      // Handle legacy services (standard Plugin interface)
      if (plugin.services && config.services) {
        for (const [serviceName, serviceConfig] of Object.entries(config.services)) {
          const service = plugin.services.find((s) => (s.serviceName || s.name) === serviceName);
          if (service) {
            const currentlyRegistered = this.services.has(serviceName as ServiceTypeName);

            if (serviceConfig.enabled && !currentlyRegistered) {
              // Enable service
              await this.registerService(service);
              this.logger.info(`Legacy service ${serviceName} enabled for plugin ${pluginName}`);
            } else if (!serviceConfig.enabled && currentlyRegistered) {
              // Disable service
              const serviceInstance = this.services.get(serviceName as ServiceTypeName);
              if (serviceInstance) {
                await serviceInstance.stop();
                this.services.delete(serviceName as ServiceTypeName);
                this.logger.info(`Legacy service ${serviceName} disabled for plugin ${pluginName}`);
              }
            }
          }
        }
      }

      // Handle configurable services
      if (configurablePlugin.configurableServices && config.services) {
        for (const [serviceName, serviceConfig] of Object.entries(config.services)) {
          const service = configurablePlugin.configurableServices.find(
            (s) => (s.service.serviceName || s.service.name) === serviceName
          );
          if (service) {
            const currentlyRegistered = this.services.has(serviceName as ServiceTypeName);

            if (serviceConfig.enabled && !currentlyRegistered) {
              // Enable service
              await this.registerService(service.service);
              this.logger.info(`Service ${serviceName} enabled for plugin ${pluginName}`);
            } else if (!serviceConfig.enabled && currentlyRegistered) {
              // Disable service
              const serviceInstance = this.services.get(serviceName as ServiceTypeName);
              if (serviceInstance) {
                await serviceInstance.stop();
                this.services.delete(serviceName as ServiceTypeName);
                this.logger.info(`Service ${serviceName} disabled for plugin ${pluginName}`);
              }
            }
          }
        }
      }

      // Handle unified components system (NEW)
      if ((plugin as any).components) {
        const components = (plugin as any).components as Array<{
          type: 'action' | 'provider' | 'evaluator' | 'service';
          component: any;
          config: any;
        }>;

        for (const componentDef of components) {
          const componentName = componentDef.component.name || 
                               componentDef.component.serviceName || 
                               componentDef.component.constructor?.name;
          
          if (!componentName) continue;

          const componentType = componentDef.type;
          const targetConfigKey = `${componentType}s` as keyof typeof config;
          const targetConfig = config[targetConfigKey] as Record<string, { enabled: boolean }> | undefined;
          
          if (targetConfig && targetConfig[componentName]) {
            const componentConfig = targetConfig[componentName];

            switch (componentType) {
              case 'action':
                {
                  const currentlyRegistered = this.actions.some((a) => a.name === componentName);
                  
                  if (componentConfig.enabled && !currentlyRegistered) {
                    // Enable action
                    this.registerAction(componentDef.component);
                    this.logger.info(`Unified action ${componentName} enabled for plugin ${pluginName}`);
                  } else if (!componentConfig.enabled && currentlyRegistered) {
                    // Disable action
                    const index = this.actions.findIndex((a) => a.name === componentName);
                    if (index !== -1) {
                      this.actions.splice(index, 1);
                      this.logger.info(`Unified action ${componentName} disabled for plugin ${pluginName}`);
                    }
                  }
                }
                break;

              case 'provider':
                {
                  const currentlyRegistered = this.providers.some((p) => p.name === componentName);
                  
                  if (componentConfig.enabled && !currentlyRegistered) {
                    // Enable provider
                    this.registerProvider(componentDef.component);
                    this.logger.info(`Unified provider ${componentName} enabled for plugin ${pluginName}`);
                  } else if (!componentConfig.enabled && currentlyRegistered) {
                    // Disable provider
                    const index = this.providers.findIndex((p) => p.name === componentName);
                    if (index !== -1) {
                      this.providers.splice(index, 1);
                      this.logger.info(`Unified provider ${componentName} disabled for plugin ${pluginName}`);
                    }
                  }
                }
                break;

              case 'evaluator':
                {
                  const currentlyRegistered = this.evaluators.some((e) => e.name === componentName);
                  
                  if (componentConfig.enabled && !currentlyRegistered) {
                    // Enable evaluator
                    this.registerEvaluator(componentDef.component);
                    this.logger.info(`Unified evaluator ${componentName} enabled for plugin ${pluginName}`);
                  } else if (!componentConfig.enabled && currentlyRegistered) {
                    // Disable evaluator
                    const index = this.evaluators.findIndex((e) => e.name === componentName);
                    if (index !== -1) {
                      this.evaluators.splice(index, 1);
                      this.logger.info(`Unified evaluator ${componentName} disabled for plugin ${pluginName}`);
                    }
                  }
                }
                break;

              case 'service':
                {
                  const currentlyRegistered = this.services.has(componentName as ServiceTypeName);
                  
                  if (componentConfig.enabled && !currentlyRegistered) {
                    // Enable service
                    await this.registerService(componentDef.component);
                    this.logger.info(`Unified service ${componentName} enabled for plugin ${pluginName}`);
                  } else if (!componentConfig.enabled && currentlyRegistered) {
                    // Disable service
                    const serviceInstance = this.services.get(componentName as ServiceTypeName);
                    if (serviceInstance) {
                      await serviceInstance.stop();
                      this.services.delete(componentName as ServiceTypeName);
                      this.logger.info(`Unified service ${componentName} disabled for plugin ${pluginName}`);
                    }
                  }
                }
                break;
            }
          }
        }
      }
    }
  }

  /**
   * Get plugin configuration state
   */
  getPluginConfiguration(pluginName: string) {
    return this.configurationManager.getPluginConfiguration(pluginName);
  }

  /**
   * List all plugin configurations
   */
  listPluginConfigurations() {
    return this.configurationManager.listConfigurations();
  }

  /**
   * Enable a specific component dynamically
   */
  async enableComponent(
    pluginName: string, 
    componentName: string, 
    componentType: 'action' | 'provider' | 'evaluator' | 'service',
    component: any
  ): Promise<void> {
    // Enable the component in configuration
    const config = {
      [`${componentType}s`]: {
        [componentName]: { enabled: true }
      }
    };
    await this.configurePlugin(pluginName, config);
  }

  /**
   * Disable a specific component dynamically
   */
  async disableComponent(
    pluginName: string,
    componentName: string,
    componentType: 'action' | 'provider' | 'evaluator' | 'service'
  ): Promise<void> {
    // Disable the component in configuration
    const config = {
      [`${componentType}s`]: {
        [componentName]: { enabled: false }
      }
    };
    await this.configurePlugin(pluginName, config);
  }
}
