import { v4 as uuidv4 } from 'uuid';

interface WorkingMemoryEntry {
  actionName: string;
  result: ActionResult;
  timestamp: number;
}

import { createUniqueUuid } from './entities';
import { getNumberEnv } from './utils/environment';
import { BufferUtils } from './utils/buffer';
import { isPlainObject } from './utils/type-guards';
import { decryptSecret, getSalt } from './index';
import { ActionStreamFilter } from './utils/streaming';
import { getStreamingContext, runWithStreamingContext } from './streaming-context';
import { createLogger } from './logger';
import { DefaultMessageService } from './services/default-message-service';
import type { IMessageService } from './services/message-service';
import {
  ChannelType,
  EventType,
  ModelType,
  MODEL_SETTINGS,
  type Content,
  type ControlMessage,
  type MemoryMetadata,
  type Character,
  type Action,
  type Evaluator,
  type Provider,
  type HandlerCallback,
  type HandlerOptions,
  type ActionContext,
  type IDatabaseAdapter,
  type Entity,
  type Room,
  type World,
  type SendHandlerFunction,
  type TargetInfo,
  type ModelParamsMap,
  type ModelResultMap,
  type ModelTypeName,
  type TextStreamResult,
  type Plugin,
  type RuntimeEventStorage,
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
  type IElizaOS,
  type ActionResult,
  type GenerateTextParams,
  type GenerateTextOptions,
  type GenerateTextResult,
  type EventPayload,
  type EventPayloadMap,
  type EventHandler,
} from './types';

import { BM25 } from './search';
import { stringToUuid } from './utils';

const environmentSettings: RuntimeSettings = {};

export class Semaphore {
  private permits: number;
  private waiting: Array<() => void> = [];
  constructor(count: number) {
    this.permits = count;
  }
  async acquire(): Promise<void> {
    if (this.permits > 0) {
      this.permits -= 1;
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      this.waiting.push(resolve);
    });
  }
  release(): void {
    this.permits += 1;
    const nextResolve = this.waiting.shift();
    if (nextResolve && this.permits > 0) {
      this.permits -= 1;
      nextResolve();
    }
  }
}

type ServiceResolver = (service: Service) => void;
type ServiceRejecter = (reason: Error | string) => void;
type ServicePromiseHandler = {
  resolve: ServiceResolver;
  reject: ServiceRejecter;
};

export class AgentRuntime implements IAgentRuntime {
  readonly #conversationLength = 32 as number;
  readonly agentId: UUID;
  readonly character: Character;
  public adapter!: IDatabaseAdapter;
  readonly actions: Action[] = [];
  readonly evaluators: Evaluator[] = [];
  readonly providers: Provider[] = [];
  readonly plugins: Plugin[] = [];
  events: RuntimeEventStorage = {};
  stateCache = new Map<string, State>();
  readonly fetch = fetch;
  services = new Map<ServiceTypeName, Service[]>();
  private serviceTypes = new Map<ServiceTypeName, (typeof Service)[]>();
  models = new Map<string, ModelHandler[]>();
  routes: Route[] = [];
  private taskWorkers = new Map<string, TaskWorker>();
  private sendHandlers = new Map<string, SendHandlerFunction>();
  private eventHandlers: Map<string, ((data: unknown) => void)[]> = new Map();

  /**
   * Reference to the ElizaOS instance that created this runtime
   * Set by ElizaOS when runtime is registered
   * @optional
   */
  elizaOS?: IElizaOS;

  // A map of all plugins available to the runtime, keyed by name, for dependency resolution.
  private allAvailablePlugins = new Map<string, Plugin>();
  // The initial list of plugins specified by the character configuration.
  private characterPlugins: Plugin[] = [];

  public logger;
  private settings: RuntimeSettings;
  private servicePromiseHandlers = new Map<string, ServicePromiseHandler>(); // Combined handlers for resolve/reject
  private servicePromises = new Map<string, Promise<Service>>(); // read
  private serviceRegistrationStatus = new Map<
    ServiceTypeName,
    'pending' | 'registering' | 'registered' | 'failed'
  >(); // status tracking
  public initPromise: Promise<void>;
  private initResolver: ((value?: void | PromiseLike<void>) => void) | undefined;
  private initRejecter: ((reason?: Error | string) => void) | undefined;
  private currentRunId?: UUID; // Track the current run ID
  private currentRoomId?: UUID; // Track the current room for logging
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
  private maxWorkingMemoryEntries: number = 50; // Default value, can be overridden
  public messageService: IMessageService | null = null; // Lazily initialized

  constructor(opts: {
    conversationLength?: number;
    agentId?: UUID;
    character?: Character;
    plugins?: Plugin[];
    fetch?: typeof fetch;
    adapter?: IDatabaseAdapter;
    settings?: RuntimeSettings;
    allAvailablePlugins?: Plugin[];
  }) {
    // Generate deterministic UUID from character name for backward compatibility
    // Falls back to random UUID only if no character name is provided
    this.agentId =
      opts.character?.id ?? opts?.agentId ?? stringToUuid(opts.character?.name ?? uuidv4());
    this.character = opts.character as Character;

    this.initPromise = new Promise((resolve, reject) => {
      this.initResolver = resolve;
      this.initRejecter = reject;
    });

    // Create the logger with namespace only - level is handled globally from env
    this.logger = createLogger({
      namespace: this.character?.name,
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

    this.logger.debug(
      { src: 'agent', agentId: this.agentId, agentName: this.character?.name },
      'Initialized'
    );
    this.currentRunId = undefined; // Initialize run ID tracker

    // Set max working memory entries from settings or environment
    if (opts.settings?.MAX_WORKING_MEMORY_ENTRIES) {
      this.maxWorkingMemoryEntries = parseInt(opts.settings.MAX_WORKING_MEMORY_ENTRIES, 10) || 50;
    } else {
      this.maxWorkingMemoryEntries = getNumberEnv('MAX_WORKING_MEMORY_ENTRIES', 50) as number;
    }
  }

  /**
   * Create a new run ID for tracking a sequence of model calls
   */
  createRunId(): UUID {
    return uuidv4() as UUID;
  }

  /**
   * Start a new run for tracking prompts
   * @param roomId Optional room ID to associate logs with this conversation
   */
  startRun(roomId?: UUID): UUID {
    this.currentRunId = this.createRunId();
    this.currentRoomId = roomId;
    return this.currentRunId;
  }

  /**
   * End the current run
   */
  endRun(): void {
    this.currentRunId = undefined;
    this.currentRoomId = undefined;
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
      this.logger.error(
        { src: 'agent', agentId: this.agentId, error: errorMsg },
        'Plugin registration failed'
      );
      throw new Error(`registerPlugin: ${errorMsg}`);
    }

    // Check if a plugin with the same name is already registered.
    const existingPlugin = this.plugins.find((p) => p.name === plugin.name);
    if (existingPlugin) {
      this.logger.warn(
        { src: 'agent', agentId: this.agentId, plugin: plugin.name },
        'Plugin already registered, skipping'
      );
      return;
    }

    (this.plugins as Plugin[]).push(plugin);
    this.logger.debug({ src: 'agent', agentId: this.agentId, plugin: plugin.name }, 'Plugin added');

    if (plugin.init) {
      const config: Record<string, string> = {};
      if (plugin.config) {
        for (const [key, value] of Object.entries(plugin.config)) {
          if (value !== null && value !== undefined) {
            config[key] = String(value);
          }
        }
      }
      await plugin.init(config, this as IAgentRuntime);
      this.logger.debug(
        { src: 'agent', agentId: this.agentId, plugin: plugin.name },
        'Plugin initialized'
      );
    }
    if (plugin.adapter) {
      this.logger.debug(
        { src: 'agent', agentId: this.agentId, plugin: plugin.name },
        'Registering database adapter'
      );
      this.registerDatabaseAdapter(plugin.adapter);
    }
    if (plugin.actions) {
      for (const action of plugin.actions) {
        this.registerAction(action);
      }
    }
    if (plugin.evaluators) {
      for (const evaluator of plugin.evaluators) {
        this.registerEvaluator(evaluator);
      }
    }
    if (plugin.providers) {
      for (const provider of plugin.providers) {
        this.registerProvider(provider);
      }
    }
    if (plugin.models) {
      for (const [modelType, handler] of Object.entries(plugin.models)) {
        this.registerModel(
          modelType as ModelTypeName,
          handler as (params: unknown) => Promise<unknown>,
          plugin.name,
          plugin?.priority
        );
      }
    }
    if (plugin.routes) {
      for (const route of plugin.routes) {
        // namespace plugin name infront of paths
        const routePath = route.path.startsWith('/') ? route.path : `/${route.path}`;
        this.routes.push({ ...route, path: '/' + plugin.name + routePath });
      }
    }
    if (plugin.events) {
      for (const [eventName, eventHandlers] of Object.entries(plugin.events)) {
        for (const eventHandler of eventHandlers) {
          this.registerEvent(eventName, eventHandler as (params: unknown) => Promise<void>);
        }
      }
    }
    if (plugin.services) {
      for (const service of plugin.services) {
        const serviceType = service.serviceType as ServiceTypeName;

        this.logger.debug(
          { src: 'agent', agentId: this.agentId, plugin: plugin.name, serviceType },
          'Registering service'
        );

        // ensure we have a promise, so when it's actually loaded via registerService,
        // we can trigger the loading of service dependencies
        if (!this.servicePromises.has(serviceType)) {
          this._createServiceResolver(serviceType);
        }

        // Track service registration status
        this.serviceRegistrationStatus.set(serviceType, 'pending');

        // Register service asynchronously; handle errors without rethrowing since
        // we are not awaiting this promise here (to avoid unhandled rejections)
        this.registerService(service).catch((error) => {
          this.logger.error(
            {
              src: 'agent',
              agentId: this.agentId,
              plugin: plugin.name,
              serviceType,
              error: error instanceof Error ? error.message : String(error),
            },
            'Service registration failed'
          );

          // Reject the service promise so waiting consumers know about the failure
          const handler = this.servicePromiseHandlers.get(serviceType);
          if (handler) {
            const serviceError = new Error(
              `Service ${serviceType} from plugin ${plugin.name} failed to register: ${error instanceof Error ? error.message : String(error)}`
            );
            handler.reject(serviceError);
            // Clean up the promise handles
            this.servicePromiseHandlers.delete(serviceType);
            this.servicePromises.delete(serviceType);
          }
          // Update service status
          this.serviceRegistrationStatus.set(serviceType, 'failed');
          // Do not rethrow; error is propagated via promise rejection and status update
        });
      }
    }
  }

  getAllServices(): Map<ServiceTypeName, Service[]> {
    return this.services;
  }

  async stop() {
    this.logger.debug({ src: 'agent', agentId: this.agentId }, 'Stopping runtime');
    for (const [serviceType, services] of this.services) {
      this.logger.debug({ src: 'agent', agentId: this.agentId, serviceType }, 'Stopping service');
      for (const service of services) {
        await service.stop();
      }
    }

    this.elizaOS = undefined;
  }

  async initialize(options?: { skipMigrations?: boolean }): Promise<void> {
    const pluginRegistrationPromises: Promise<void>[] = [];

    // The resolution is now expected to happen in the CLI layer (e.g., startAgent)
    // The runtime now accepts a pre-resolved, ordered list of plugins.
    const pluginsToLoad = this.characterPlugins;

    for (const plugin of pluginsToLoad) {
      if (plugin) {
        pluginRegistrationPromises.push(this.registerPlugin(plugin));
      }
    }
    await Promise.all(pluginRegistrationPromises);

    if (!this.adapter) {
      this.logger.error(
        { src: 'agent', agentId: this.agentId },
        'Database adapter not initialized'
      );
      throw new Error(
        'Database adapter not initialized. The SQL plugin (@elizaos/plugin-sql) is required for agent initialization. Please ensure it is included in your character configuration.'
      );
    }

    // Make adapter init idempotent - check if already initialized
    if (!(await this.adapter.isReady())) {
      await this.adapter.init();
    }

    // Initialize message service
    this.messageService = new DefaultMessageService();

    const skipMigrations = options?.skipMigrations ?? false;

    const existingAgent = await this.ensureAgentExists({
      ...this.character,
      id: this.agentId,
    } as Partial<Agent>);

    if (!existingAgent) {
      throw new Error(`Agent ${this.agentId} does not exist in database after ensureAgentExists`);
    }

    this.mergeAgentSettings(existingAgent);

    await Promise.all([
      this.ensureWorldExists({
        id: this.agentId,
        name: `${this.character.name}'s World`,
        agentId: this.agentId,
        messageServerId: this.agentId,
      }),

      skipMigrations
        ? Promise.resolve()
        : (async () => {
            this.logger.debug({ src: 'agent', agentId: this.agentId }, 'Running plugin migrations');
            await this.runPluginMigrations();
            this.logger.debug(
              { src: 'agent', agentId: this.agentId },
              'Plugin migrations completed'
            );
          })(),
    ]);

    const [agentEntity, existingRoom, participants] = await Promise.all([
      this.ensureEntity({
        id: this.agentId,
        names: [this.character.name],
        metadata: {},
        agentId: existingAgent.id!,
      }),
      this.getRoom(this.agentId),
      this.adapter.getParticipantsForRoom(this.agentId),
    ]);

    if (!agentEntity) {
      throw new Error(`Failed to ensure entity for agent ${this.agentId}`);
    }

    if (!existingRoom) {
      await this.createRoom({
        id: this.agentId,
        name: this.character.name,
        source: 'elizaos',
        type: ChannelType.SELF,
        channelId: this.agentId,
        messageServerId: this.agentId,
        worldId: this.agentId,
      });
      this.logger.debug({ src: 'agent', agentId: this.agentId }, 'Agent room created');
    }

    if (!participants.includes(this.agentId)) {
      const added = await this.addParticipant(this.agentId, this.agentId);
      if (!added) {
        throw new Error(`Failed to add agent ${this.agentId} as participant to its own room`);
      }
      this.logger.debug({ src: 'agent', agentId: this.agentId }, 'Agent linked to room');
    }

    const embeddingModel = this.getModel(ModelType.TEXT_EMBEDDING);
    if (!embeddingModel) {
      this.logger.warn(
        { src: 'agent', agentId: this.agentId },
        'No TEXT_EMBEDDING model registered, skipping embedding setup'
      );
    } else {
      await this.ensureEmbeddingDimension();
    }

    // Resolve init promise to allow services to start
    if (this.initResolver) {
      this.initResolver();
      this.initResolver = undefined;
    }
  }

  private mergeAgentSettings(existingAgent: Agent): void {
    if (!existingAgent.settings) return;

    this.character.settings = {
      ...existingAgent.settings,
      ...this.character.settings,
    };

    const dbSecrets =
      existingAgent.settings.secrets && typeof existingAgent.settings.secrets === 'object'
        ? existingAgent.settings.secrets
        : {};
    const settingsSecrets =
      this.character.settings.secrets && typeof this.character.settings.secrets === 'object'
        ? this.character.settings.secrets
        : {};
    const characterSecrets =
      this.character.secrets && typeof this.character.secrets === 'object'
        ? this.character.secrets
        : {};

    const mergedSecrets = {
      ...dbSecrets,
      ...characterSecrets,
      ...settingsSecrets,
    };

    if (Object.keys(mergedSecrets).length > 0) {
      const filteredSecrets: Record<string, string | boolean | number> = {};
      for (const [key, value] of Object.entries(mergedSecrets)) {
        if (value !== null && value !== undefined) {
          filteredSecrets[key] = value as string | boolean | number;
        }
      }
      if (Object.keys(filteredSecrets).length > 0) {
        this.character.secrets = filteredSecrets;
        this.character.settings.secrets = filteredSecrets;
      }
    }
  }

  async runPluginMigrations(): Promise<void> {
    if (!this.adapter) {
      this.logger.warn(
        { src: 'agent', agentId: this.agentId },
        'Database adapter not found, skipping plugin migrations'
      );
      return;
    }

    if (typeof this.adapter.runPluginMigrations !== 'function') {
      this.logger.warn(
        { src: 'agent', agentId: this.agentId },
        'Database adapter does not support plugin migrations'
      );
      return;
    }

    const pluginsWithSchemas = this.plugins
      .filter((p) => p.schema)
      .map((p) => {
        const schema = p.schema || {};
        const normalizedSchema: Record<
          string,
          string | number | boolean | Record<string, unknown> | null
        > = {};
        for (const [key, value] of Object.entries(schema)) {
          if (
            typeof value === 'string' ||
            typeof value === 'number' ||
            typeof value === 'boolean' ||
            value === null ||
            (typeof value === 'object' && value !== null && !Array.isArray(value))
          ) {
            normalizedSchema[key] = value as
              | string
              | number
              | boolean
              | Record<string, unknown>
              | null;
          }
        }
        return { name: p.name, schema: normalizedSchema };
      });

    if (pluginsWithSchemas.length === 0) {
      this.logger.debug(
        { src: 'agent', agentId: this.agentId },
        'No plugins with schemas, skipping migrations'
      );
      return;
    }

    this.logger.debug(
      { src: 'agent', agentId: this.agentId, count: pluginsWithSchemas.length },
      'Found plugins with schemas'
    );

    const isProduction = process.env.NODE_ENV === 'production';
    const forceDestructive = process.env.ELIZA_ALLOW_DESTRUCTIVE_MIGRATIONS === 'true';

    await this.adapter.runPluginMigrations(pluginsWithSchemas, {
      verbose: !isProduction,
      force: forceDestructive,
      dryRun: false,
    });

    this.logger.debug({ src: 'agent', agentId: this.agentId }, 'Plugin migrations completed');
  }

  async getConnection(): Promise<unknown> {
    // Updated return type
    if (!this.adapter) {
      throw new Error('Database adapter not registered');
    }
    return this.adapter.getConnection();
  }

  setSetting(key: string, value: string | boolean | null, secret = false) {
    if (secret) {
      if (!this.character.secrets) {
        this.character.secrets = {};
      }
      if (value !== null && value !== undefined) {
        this.character.secrets[key] = value as string | boolean | number;
      }
    } else {
      if (!this.character.settings) {
        this.character.settings = {};
      }
      if (value !== null && value !== undefined) {
        this.character.settings[key] = value as string | number | boolean | Record<string, unknown>;
      }
    }
  }

  getSetting(key: string): string | boolean | number | null {
    const settings = this.character.settings;
    const secrets = this.character.secrets;
    const nestedSecrets =
      typeof settings === 'object' &&
      settings !== null &&
      'secrets' in settings &&
      typeof settings.secrets === 'object' &&
      settings.secrets !== null
        ? (settings.secrets as Record<string, string | undefined>)
        : undefined;

    const value = secrets?.[key] || settings?.[key] || nestedSecrets?.[key] || this.settings[key];

    // Handle each type appropriately
    if (value === undefined || value === null) {
      return null;
    }

    if (typeof value === 'number') {
      return value;
    }

    if (typeof value === 'boolean') {
      return value;
    }

    if (typeof value === 'string') {
      // Only decrypt string values
      const decrypted = decryptSecret(value, getSalt());
      if (decrypted === 'true') return true;
      if (decrypted === 'false') return false;
      return decrypted;
    }

    return null;
  }

  getConversationLength() {
    return this.#conversationLength;
  }

  registerDatabaseAdapter(adapter: IDatabaseAdapter) {
    if (this.adapter) {
      this.logger.warn(
        { src: 'agent', agentId: this.agentId },
        'Database adapter already registered, ignoring'
      );
    } else {
      this.adapter = adapter;
      this.logger.debug({ src: 'agent', agentId: this.agentId }, 'Database adapter registered');
    }
  }

  registerProvider(provider: Provider) {
    this.providers.push(provider);
    this.logger.debug(
      { src: 'agent', agentId: this.agentId, provider: provider.name },
      'Provider registered'
    );
  }

  registerAction(action: Action) {
    if (this.actions.find((a) => a.name === action.name)) {
      this.logger.warn(
        { src: 'agent', agentId: this.agentId, action: action.name },
        'Action already registered, skipping'
      );
    } else {
      this.actions.push(action);
      this.logger.debug(
        { src: 'agent', agentId: this.agentId, action: action.name },
        'Action registered'
      );
    }
  }

  registerEvaluator(evaluator: Evaluator) {
    this.evaluators.push(evaluator);
  }

  // Helper functions for immutable action plan updates
  private updateActionPlan<T>(plan: T, updates: Partial<T>): T {
    return { ...plan, ...updates };
  }

  private updateActionStep<T, S>(
    plan: T & { steps: S[] },
    index: number,
    stepUpdates: Partial<S>
  ): T & { steps: S[] } {
    // Add bounds checking
    if (!plan.steps || index < 0 || index >= plan.steps.length) {
      this.logger.warn(
        { src: 'agent', agentId: this.agentId, index, stepsCount: plan.steps?.length || 0 },
        'Invalid step index'
      );
      return plan;
    }
    return {
      ...plan,
      steps: plan.steps.map((step: S, i: number) =>
        i === index ? { ...step, ...stepUpdates } : step
      ),
    };
  }

  async processActions(
    message: Memory,
    responses: Memory[],
    state?: State,
    callback?: HandlerCallback,
    processOptions?: { onStreamChunk?: (chunk: string, messageId?: UUID) => Promise<void> }
  ): Promise<void> {
    // Determine if we have multiple actions to execute
    const allActions: string[] = [];
    for (const response of responses) {
      if (response.content?.actions && response.content.actions.length > 0) {
        allActions.push(...response.content.actions);
      }
    }

    const hasMultipleActions = allActions.length > 1;
    const parentRunId = this.getCurrentRunId();
    const runId = this.createRunId();

    // Create action plan if multiple actions
    let actionPlan:
      | {
          runId: UUID;
          totalSteps: number;
          currentStep: number;
          steps: Array<{
            action: string;
            status: 'pending' | 'completed' | 'failed';
            result?: ActionResult;
            error?: string;
          }>;
          thought: string;
          startTime: number;
        }
      | undefined = undefined;

    const thought =
      responses[0]?.content?.thought ||
      `Executing ${allActions.length} actions: ${allActions.join(', ')}`;

    if (hasMultipleActions) {
      // Extract thought from response content

      actionPlan = {
        runId,
        totalSteps: allActions.length,
        currentStep: 0,
        steps: allActions.map((action) => ({
          action,
          status: 'pending' as const,
        })),
        thought,
        startTime: Date.now(),
      };
    }

    let actionIndex = 0;

    for (const response of responses) {
      if (!response.content?.actions || response.content.actions.length === 0) {
        this.logger.warn({ src: 'agent', agentId: this.agentId }, 'No action found in response');
        continue;
      }
      const actions = response.content.actions;

      const actionResults: ActionResult[] = [];
      let accumulatedState = state;

      function normalizeAction(actionString: string) {
        return actionString.toLowerCase().replace(/_/g, '');
      }
      this.logger.trace(
        {
          src: 'agent',
          agentId: this.agentId,
          actions: this.actions.map((a) => normalizeAction(a.name)),
        },
        'Available actions'
      );

      for (const responseAction of actions) {
        // Update current step in plan immutably
        if (actionPlan) {
          actionPlan = this.updateActionPlan(actionPlan, { currentStep: actionIndex + 1 });
        }

        // Compose state with previous action results and plan
        accumulatedState = await this.composeState(message, [
          'RECENT_MESSAGES',
          'ACTION_STATE', // This will include the action plan
        ]);

        // Add action plan to state if it exists
        if (actionPlan && accumulatedState.data) {
          accumulatedState.data.actionPlan = actionPlan;
          accumulatedState.data.actionResults = actionResults;
        }

        this.logger.debug(
          { src: 'agent', agentId: this.agentId, action: responseAction },
          'Processing action'
        );
        const normalizedResponseAction = normalizeAction(responseAction);

        // First try exact match
        let action = this.actions.find(
          (a: { name: string }) => normalizeAction(a.name) === normalizedResponseAction
        );

        if (!action) {
          // Then try fuzzy matching
          action = this.actions.find(
            (a: { name: string }) =>
              normalizeAction(a.name).includes(normalizedResponseAction) ||
              normalizedResponseAction.includes(normalizeAction(a.name))
          );
        }

        if (!action) {
          // Try similes
          for (const _action of this.actions) {
            const exactSimileMatch = _action.similes?.find(
              (simile) => normalizeAction(simile) === normalizedResponseAction
            );

            if (exactSimileMatch) {
              action = _action;
              this.logger.debug(
                { src: 'agent', agentId: this.agentId, action: action.name, match: 'simile' },
                'Action resolved via simile'
              );
              break;
            }

            const fuzzySimileMatch = _action.similes?.find(
              (simile) =>
                normalizeAction(simile).includes(normalizedResponseAction) ||
                normalizedResponseAction.includes(normalizeAction(simile))
            );

            if (fuzzySimileMatch) {
              action = _action;
              this.logger.debug(
                { src: 'agent', agentId: this.agentId, action: action.name, match: 'fuzzy' },
                'Action resolved via fuzzy match'
              );
              break;
            }
          }
        }
        if (!action) {
          const errorMsg = `Action not found: ${responseAction}`;
          this.logger.error(
            { src: 'agent', agentId: this.agentId, action: responseAction },
            'Action not found'
          );

          if (actionPlan && actionPlan.steps[actionIndex]) {
            actionPlan = this.updateActionStep(actionPlan, actionIndex, {
              status: 'failed',
              error: errorMsg,
            });
          }

          const actionMemory: Memory = {
            id: uuidv4() as UUID,
            entityId: message.entityId,
            roomId: message.roomId,
            worldId: message.worldId,
            content: {
              thought: errorMsg,
              source: 'auto',
              type: 'action_result',
              actionName: responseAction,
              actionStatus: 'failed',
              runId,
            },
          };
          await this.createMemory(actionMemory, 'messages');
          actionIndex++;
          continue;
        }
        if (!action.handler) {
          this.logger.error(
            { src: 'agent', agentId: this.agentId, action: action.name },
            'Action has no handler'
          );

          // Update plan with error immutably
          if (actionPlan && actionPlan.steps[actionIndex]) {
            actionPlan = this.updateActionStep(actionPlan, actionIndex, {
              status: 'failed',
              error: 'No handler',
            });
          }

          actionIndex++;
          continue;
        }
        this.logger.debug(
          { src: 'agent', agentId: this.agentId, action: action.name },
          'Executing action'
        );

        const actionId = uuidv4() as UUID;
        // Separate ID for streamed response message (independent from action badge)
        const responseMessageId = uuidv4() as UUID;

        this.currentActionContext = {
          actionName: action.name,
          actionId,
          prompts: [],
        };

        // Create action context with plan information
        const actionContext: ActionContext = {
          previousResults: actionResults,
          getPreviousResult: (actionName: string) => {
            return actionResults.find((r) => r.data?.actionName === actionName);
          },
        };

        // Add plan information to options if multiple actions
        const options: HandlerOptions = {
          actionContext: actionContext,
        };

        if (actionPlan) {
          options.actionPlan = {
            totalSteps: actionPlan.totalSteps,
            currentStep: actionPlan.currentStep,
            steps: actionPlan.steps,
            thought: actionPlan.thought,
          };
        }

        // Pass streaming callback to action handlers
        if (processOptions?.onStreamChunk) {
          options.onStreamChunk = processOptions.onStreamChunk;
        }

        await this.emitEvent(EventType.ACTION_STARTED, {
          messageId: actionId,
          roomId: message.roomId,
          world: message.worldId,
          content: {
            text: `Executing action: ${action.name}`,
            actions: [action.name],
            actionStatus: 'executing',
            actionId: actionId,
            runId: runId,
            type: 'agent_action',
            thought: thought,
            source: message.content?.source,
          },
        });

        let storedCallbackData: Content[] = [];

        const storageCallback = async (response: Content) => {
          // Use responseMessageId for the text response (separate from action badge)
          response.responseId = responseMessageId;
          storedCallbackData.push(response);
          return [];
        };

        // Create streaming context using responseMessageId (separate from actionId)
        // This ensures streamed text goes to its own message, independent from action badge
        //
        // Actions may have multiple useModel calls (e.g., JSON extraction + text generation).
        // onStreamEnd is called after each useModel stream completes, allowing us to reset
        // the filter so content type detection from one call doesn't affect the next.
        let actionStreamingContext:
          | {
              messageId: UUID;
              onStreamChunk: (chunk: string, messageId?: UUID) => Promise<void>;
              onStreamEnd: () => void;
            }
          | undefined;
        if (processOptions?.onStreamChunk) {
          let currentFilter: ActionStreamFilter | null = null;

          actionStreamingContext = {
            messageId: responseMessageId,
            onStreamChunk: async (chunk: string, msgId?: UUID) => {
              if (!currentFilter) {
                currentFilter = new ActionStreamFilter();
              }
              const textToStream = currentFilter.push(chunk);
              if (textToStream) {
                await processOptions.onStreamChunk!(textToStream, msgId);
              }
            },
            onStreamEnd: () => {
              // Reset filter for next useModel call
              currentFilter = null;
            },
          };
        }

        // Execute action with its own streaming context
        const result = await runWithStreamingContext(actionStreamingContext, () =>
          action.handler(
            this as IAgentRuntime,
            message,
            accumulatedState,
            options,
            storageCallback,
            responses
          )
        );

        // Handle backward compatibility for void, null, true, false returns
        const isLegacyReturn =
          result === undefined || result === null || typeof result === 'boolean';

        // Only create ActionResult if we have a proper result
        let actionResult: ActionResult | null = null;

        if (!isLegacyReturn) {
          // Ensure we have an ActionResult with required success field
          if (
            typeof result === 'object' &&
            result !== null &&
            ('values' in result || 'data' in result || 'text' in result)
          ) {
            // Ensure success field exists with default true
            actionResult = {
              ...result,
              success: 'success' in result ? result.success : true, // Default to true if not specified
            } as ActionResult;
          } else {
            actionResult = {
              success: true, // Default success for legacy results
              data: {
                actionName: action.name,
                legacyResult: result,
              },
            };
          }

          actionResults.push(actionResult);

          // Merge returned values into state
          if (actionResult.values) {
            const existingActionResults = Array.isArray(accumulatedState.data?.actionResults)
              ? accumulatedState.data.actionResults
              : [];
            accumulatedState = {
              ...accumulatedState,
              values: { ...accumulatedState.values, ...actionResult.values },
              data: {
                ...(accumulatedState.data || {}),
                actionResults: [...existingActionResults, actionResult],
                actionPlan,
              },
            };
          }

          // Store in working memory (in state data) with cleanup
          if (actionResult && accumulatedState.data) {
            if (!accumulatedState.data.workingMemory) accumulatedState.data.workingMemory = {};

            // Add new entry first, then clean up if we exceed the limit
            const responseAction = actionResult.data?.actionName || action.name;
            const memoryKey = `action_${responseAction}_${uuidv4()}`;
            const memoryEntry: WorkingMemoryEntry = {
              actionName: action.name,
              result: actionResult,
              timestamp: Date.now(),
            };
            const workingMemory = accumulatedState.data.workingMemory as Record<
              string,
              WorkingMemoryEntry
            >;
            workingMemory[memoryKey] = memoryEntry;

            // Clean up old entries if we now exceed the limit
            const entries = Object.entries(workingMemory);
            if (entries.length > this.maxWorkingMemoryEntries) {
              // Sort by timestamp (newest first) and keep only the most recent entries
              const sorted = entries.sort((a, b) => {
                const entryA = a[1] as WorkingMemoryEntry | null;
                const entryB = b[1] as WorkingMemoryEntry | null;
                const timestampA = entryA?.timestamp ?? 0;
                const timestampB = entryB?.timestamp ?? 0;
                return timestampB - timestampA;
              });
              // Keep exactly maxWorkingMemoryEntries entries (including the new one we just added)
              accumulatedState.data.workingMemory = Object.fromEntries(
                sorted.slice(0, this.maxWorkingMemoryEntries)
              );
            }
          }

          // Update plan with success immutably
          if (actionPlan && actionPlan.steps[actionIndex]) {
            actionPlan = this.updateActionStep(actionPlan, actionIndex, {
              status: 'completed',
              result: actionResult,
            });
          }
        }

        const isSuccess = actionResult?.success !== false;
        const statusText = isSuccess ? 'completed' : 'failed';

        await this.emitEvent(EventType.ACTION_COMPLETED, {
          messageId: actionId,
          roomId: message.roomId,
          world: message.worldId,
          content: {
            // Use action's actual text, not status message (prevents overwriting streamed content)
            text: actionResult?.text || '',
            actions: [action.name],
            actionStatus: statusText,
            actionId: actionId,
            type: 'agent_action',
            thought: thought,
            actionResult: actionResult,
            source: message.content?.source, // Include original message source
          },
        });

        if (callback) {
          for (const content of storedCallbackData) {
            await callback(content);
          }
        }

        // Store action result as memory
        const actionMemory: Memory = {
          id: actionId,
          entityId: this.agentId,
          roomId: message.roomId,
          worldId: message.worldId,
          content: {
            text: actionResult?.text || `Executed action: ${action.name}`,
            source: 'action',
            type: 'action_result',
            actionName: action.name,
            actionStatus: actionResult?.success ? 'completed' : 'failed',
            actionResult: isLegacyReturn ? { legacy: result } : actionResult,
            runId,
            ...(actionPlan && {
              planStep: `${actionPlan.currentStep}/${actionPlan.totalSteps}`,
              planThought: actionPlan.thought,
            }),
          },
          metadata: {
            type: 'action_result',
            actionName: action.name,
            runId,
            parentRunId,
            actionId,
            ...(actionPlan && {
              totalSteps: actionPlan.totalSteps,
              currentStep: actionPlan.currentStep,
            }),
          },
        };
        await this.createMemory(actionMemory, 'messages');

        this.logger.debug(
          { src: 'agent', agentId: this.agentId, action: action.name },
          'Action completed'
        );

        // log to database with collected prompts
        await this.adapter.log({
          entityId: message.entityId,
          roomId: message.roomId,
          type: 'action',
          body: {
            action: action.name,
            actionId,
            message: message.content.text,
            messageId: message.id,
            state: accumulatedState,
            responses,
            result: isLegacyReturn ? { legacy: result } : actionResult,
            isLegacyReturn,
            prompts: this.currentActionContext?.prompts || [],
            promptCount: this.currentActionContext?.prompts.length || 0,
            runId,
            parentRunId,
            ...(actionPlan && {
              planStep: `${actionPlan.currentStep}/${actionPlan.totalSteps}`,
              planThought: actionPlan.thought,
            }),
          },
        });

        // Clear action context
        this.currentActionContext = undefined;

        actionIndex++;
      }

      // Store accumulated results for evaluators and providers
      if (message.id) {
        this.stateCache.set(`${message.id}_action_results`, {
          values: { actionResults },
          data: { actionResults, actionPlan },
          text: JSON.stringify(actionResults),
        });
      }
    }
  }

  getActionResults(messageId: UUID): ActionResult[] {
    const cachedState = this.stateCache?.get(`${messageId}_action_results`);
    return (cachedState?.data?.actionResults as ActionResult[]) || [];
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
      const result = await evaluator.validate(this as IAgentRuntime, message, state);
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
          await evaluator.handler(this as IAgentRuntime, message, state, {}, callback, responses);
          this.adapter.log({
            entityId: message.entityId,
            roomId: message.roomId,
            type: 'evaluator',
            body: {
              evaluator: evaluator.name,
              messageId: message.id,
              message: message.content.text,
              state,
              runId: this.getCurrentRunId(),
            },
          });
        }
      })
    );
    return evaluators;
  }

  // highly SQL optimized queries
  async ensureConnections(
    entities: Entity[],
    rooms: Room[],
    source: string,
    world: World
  ): Promise<void> {
    // guards
    if (!entities) {
      this.logger.error(
        { src: 'agent', agentId: this.agentId },
        'ensureConnections called without entities'
      );
      return;
    }
    if (!rooms || rooms.length === 0) {
      this.logger.error(
        { src: 'agent', agentId: this.agentId },
        'ensureConnections called without rooms'
      );
      return;
    }

    // Create/ensure the world exists for this server
    await this.ensureWorldExists({ ...world, agentId: this.agentId });

    const firstRoom = rooms[0];

    // Helper function for chunking arrays
    const chunkArray = <T>(arr: T[], size: number): T[][] =>
      arr.reduce((chunks: T[][], item: T, i: number) => {
        if (i % size === 0) chunks.push([]);
        chunks[chunks.length - 1].push(item);
        return chunks;
      }, []);

    // Step 1: Create all rooms FIRST (before adding any participants)
    const roomIds = rooms.map((r: { id: UUID }) => r.id);
    const roomExistsCheck = await this.getRoomsByIds(roomIds);
    const roomsIdExists = roomExistsCheck?.map((r: { id: UUID }) => r.id);
    const roomsToCreate = roomIds.filter((id: UUID) => !roomsIdExists?.includes(id));

    const rf = {
      worldId: world.id,
      messageServerId: world.messageServerId,
      source,
      agentId: this.agentId,
    };

    if (roomsToCreate.length) {
      this.logger.debug(
        { src: 'agent', agentId: this.agentId, count: roomsToCreate.length },
        'Creating rooms'
      );
      const roomObjsToCreate: Room[] = rooms
        .filter((r) => roomsToCreate.includes(r.id))
        .map((r) => ({ ...r, ...rf, type: r.type || ChannelType.GROUP }));
      await this.createRooms(roomObjsToCreate);
    }

    // Step 2: Create all entities (ON CONFLICT DO NOTHING handles duplicates)
    const entityIds = entities.map((e) => e.id).filter((id): id is UUID => id !== undefined);

    if (entities.length) {
      this.logger.debug(
        { src: 'agent', agentId: this.agentId, count: entities.length },
        'Creating entities'
      );
      const entityFields = {
        roomId: firstRoom.id,
        channelId: firstRoom.channelId,
        type: firstRoom.type,
        worldId: world.id,
        messageServerId: world.messageServerId,
        source,
        agentId: this.agentId,
      };
      const entitiesWithFields: Entity[] = entities
        .filter((e) => e.id !== undefined)
        .map((e) => ({
          ...e,
          ...entityFields,
          metadata: e.metadata || {},
        }));
      // pglite doesn't like over 10k records
      const batches = chunkArray(entitiesWithFields, 5000);
      for (const batch of batches) {
        await this.createEntities(batch);
      }
    }

    // Step 3: Now add all participants (rooms and entities must exist by now)
    // Always add the agent to the first room
    await this.ensureParticipantInRoom(this.agentId, firstRoom.id);

    // Add all entities to the first room
    const entityIdsInFirstRoom = await this.getParticipantsForRoom(firstRoom.id);
    const entityIdsInFirstRoomFiltered = entityIdsInFirstRoom.filter(
      (id): id is UUID => id !== undefined
    );
    const missingIdsInRoom = entityIds.filter(
      (id: UUID) => !entityIdsInFirstRoomFiltered.includes(id)
    );

    if (missingIdsInRoom.length) {
      this.logger.debug(
        {
          src: 'agent',
          agentId: this.agentId,
          count: missingIdsInRoom.length,
          channelId: firstRoom.id,
        },
        'Adding missing participants'
      );
      // pglite handle this at over 10k records fine though
      const batches = chunkArray(missingIdsInRoom, 5000);
      for (const batch of batches) {
        await this.addParticipantsRoom(batch, firstRoom.id);
      }
    }

    this.logger.success(
      { src: 'agent', agentId: this.agentId, worldId: world.id },
      'World connected'
    );
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
    messageServerId,
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
    messageServerId?: UUID;
    userId?: UUID;
    metadata?: Record<string, unknown>;
  }) {
    if (!worldId && messageServerId) {
      worldId = createUniqueUuid(this as IAgentRuntime, messageServerId);
    }
    const names = [name, userName].filter(Boolean) as string[];
    const entityMetadata = {
      [source!]: {
        id: userId,
        name: name,
        userName: userName,
      },
    };
    // First check if the entity exists
    const entity = await this.getEntityById(entityId);

    if (!entity) {
      const success = await this.createEntity({
        id: entityId,
        names,
        metadata: entityMetadata,
        agentId: this.agentId,
      });
      if (success) {
        this.logger.debug(
          { src: 'agent', agentId: this.agentId, entityId, userName: name || userName },
          'Entity created'
        );
      } else {
        throw new Error(`Failed to create entity ${entityId}`);
      }
    } else {
      await this.adapter.updateEntity({
        id: entityId,
        names: [...new Set([...(entity.names || []), ...names])].filter(Boolean) as string[],
        metadata: {
          ...entity.metadata,
          [source!]: {
            ...(entity.metadata?.[source!] && typeof entity.metadata[source!] === 'object'
              ? (entity.metadata[source!] as Record<string, unknown>)
              : {}),
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
      name:
        worldName || messageServerId
          ? `World for server ${messageServerId}`
          : `World for room ${roomId}`,
      agentId: this.agentId,
      messageServerId: messageServerId,
      metadata,
    });
    await this.ensureRoomExists({
      id: roomId,
      name: name || 'default',
      source: source || 'default',
      type: type || ChannelType.DM,
      channelId,
      messageServerId,
      worldId,
    });
    await this.ensureParticipantInRoom(entityId, roomId);
    await this.ensureParticipantInRoom(this.agentId, roomId);

    this.logger.debug(
      { src: 'agent', agentId: this.agentId, entityId, channelId: roomId },
      'Entity connected'
    );
  }

  async ensureParticipantInRoom(entityId: UUID, roomId: UUID) {
    // Make sure entity exists in database before adding as participant
    const entity = await this.getEntityById(entityId);

    // If entity is not found but it's not the agent itself, we might still want to proceed
    // This can happen when an entity exists in the database but isn't associated with this agent
    if (!entity && entityId !== this.agentId) {
      this.logger.warn(
        { src: 'agent', agentId: this.agentId, entityId },
        'Entity not accessible, attempting to add as participant'
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
        this.logger.debug(
          { src: 'agent', agentId: this.agentId, channelId: roomId },
          'Agent linked to room'
        );
      } else {
        this.logger.debug(
          { src: 'agent', agentId: this.agentId, entityId, channelId: roomId },
          'User linked to room'
        );
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

  async isRoomParticipant(roomId: UUID, entityId: UUID): Promise<boolean> {
    return await this.adapter.isRoomParticipant(roomId, entityId);
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
  async ensureWorldExists({ id, name, messageServerId, metadata }: World) {
    this.logger.debug(
      { src: 'agent', agentId: this.agentId, worldId: id, name, messageServerId },
      'Ensuring world exists'
    );
    await this.adapter.createWorld({
      id,
      name,
      agentId: this.agentId,
      messageServerId,
      metadata,
    });
  }

  async ensureRoomExists({
    id,
    name,
    source,
    type,
    channelId,
    messageServerId,
    worldId,
    metadata,
  }: Room) {
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
        messageServerId,
        worldId,
        metadata,
      });
      this.logger.debug({ src: 'agent', agentId: this.agentId, channelId: id }, 'Room created');
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
        const result = await provider.get(this as IAgentRuntime, message, cachedState);
        const duration = Date.now() - start;

        // only need to inform if it's taking a long time
        if (duration > 100) {
          this.logger.debug(
            { src: 'agent', agentId: this.agentId, provider: provider.name, duration },
            'Slow provider'
          );
        }
        return {
          ...result,
          providerName: provider.name,
        };
      })
    );
    const currentProviderResults: Record<
      string,
      { text?: string; values?: Record<string, unknown>; providerName: string }
    > = {
      ...((cachedState.data?.providers as Record<
        string,
        { text?: string; values?: Record<string, unknown>; providerName: string }
      >) || {}),
    };
    for (const freshResult of providerData) {
      currentProviderResults[freshResult.providerName] = freshResult;
    }
    const orderedTexts: string[] = [];
    for (const provider of providersToGet) {
      const result = currentProviderResults[provider.name];
      if (result && result.text && typeof result.text === 'string' && result.text.trim() !== '') {
        orderedTexts.push(result.text);
      }
    }
    const providersText = orderedTexts.join('\n');
    const aggregatedStateValues: Record<string, unknown> = { ...(cachedState.values || {}) };
    for (const provider of providersToGet) {
      const providerResult = currentProviderResults[provider.name];
      if (
        providerResult &&
        providerResult.values &&
        typeof providerResult.values === 'object' &&
        providerResult.values !== null
      ) {
        Object.assign(aggregatedStateValues, providerResult.values);
      }
    }
    for (const providerName in currentProviderResults) {
      if (!providersToGet.some((p) => p.name === providerName)) {
        const providerResult = currentProviderResults[providerName];
        if (
          providerResult &&
          providerResult.values &&
          typeof providerResult.values === 'object' &&
          providerResult.values !== null
        ) {
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
    return newState;
  }

  getService<T extends Service = Service>(serviceName: ServiceTypeName | string): T | null {
    const serviceInstances = this.services.get(serviceName as ServiceTypeName);
    if (!serviceInstances || serviceInstances.length === 0) {
      // it's not a warn, a plugin might just not be installed
      this.logger.debug({ src: 'agent', agentId: this.agentId, serviceName }, 'Service not found');
      return null;
    }
    return serviceInstances[0] as T;
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
   * Get all services of a specific type
   * @template T - The expected service class type
   * @param serviceName - The service type name
   * @returns Array of service instances with proper typing
   */
  getServicesByType<T extends Service = Service>(serviceName: ServiceTypeName | string): T[] {
    const serviceInstances = this.services.get(serviceName as ServiceTypeName);
    if (!serviceInstances || serviceInstances.length === 0) {
      this.logger.debug(
        { src: 'agent', agentId: this.agentId, serviceName },
        'No services found for type'
      );
      return [];
    }
    return serviceInstances as T[];
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
    const serviceInstances = this.services.get(serviceType as ServiceTypeName);
    return serviceInstances !== undefined && serviceInstances.length > 0;
  }

  /**
   * Get the registration status of a service
   * @param serviceType - The service type to check
   * @returns the current registration status
   */
  getServiceRegistrationStatus(
    serviceType: ServiceTypeName | string
  ): 'pending' | 'registering' | 'registered' | 'failed' | 'unknown' {
    return this.serviceRegistrationStatus.get(serviceType as ServiceTypeName) || 'unknown';
  }

  /**
   * Get service health information
   * @returns Object containing service health status
   */
  getServiceHealth(): Record<
    string,
    {
      status: 'pending' | 'registering' | 'registered' | 'failed' | 'unknown';
      instances: number;
      hasPromise: boolean;
    }
  > {
    const health: Record<
      string,
      {
        status: 'pending' | 'registering' | 'registered' | 'failed' | 'unknown';
        instances: number;
        hasPromise: boolean;
      }
    > = {};

    // Check all registered services
    for (const [serviceType, instances] of this.services) {
      health[serviceType] = {
        status: this.getServiceRegistrationStatus(serviceType),
        instances: instances.length,
        hasPromise: this.servicePromises.has(serviceType),
      };
    }

    // Check services that have registration status but no instances yet
    for (const [serviceType, status] of this.serviceRegistrationStatus) {
      if (!health[serviceType]) {
        health[serviceType] = {
          status,
          instances: 0,
          hasPromise: this.servicePromises.has(serviceType),
        };
      }
    }

    return health;
  }

  async registerService(serviceDef: typeof Service): Promise<void> {
    const serviceType = serviceDef.serviceType as ServiceTypeName;
    const serviceName = serviceDef.name || 'Unknown';

    if (!serviceType) {
      this.logger.warn(
        { src: 'agent', agentId: this.agentId, serviceName },
        'Service missing serviceType property'
      );
      return;
    }
    this.logger.debug({ src: 'agent', agentId: this.agentId, serviceType }, 'Registering service');

    // Update service status to registering
    this.serviceRegistrationStatus.set(serviceType, 'registering');

    // ALL services wait for initialization to complete with a timeout to prevent hanging
    // This ensures services start after all plugins are registered and runtime is ready
    this.logger.debug(
      { src: 'agent', agentId: this.agentId, serviceType },
      'Service waiting for init'
    );

    // Add timeout protection to prevent indefinite hangs
    const initTimeout = new Promise<never>((_, reject) => {
      setTimeout(() => {
        reject(
          new Error(
            `Service ${serviceType} registration timed out waiting for runtime initialization (30s timeout)`
          )
        );
      }, 30000); // 30 second timeout
    });

    await Promise.race([this.initPromise, initTimeout]);

    // Check if service has a start method
    if (typeof serviceDef.start !== 'function') {
      throw new Error(
        `Service ${serviceType} does not have a static start method. All services must implement static async start(runtime: IAgentRuntime): Promise<Service>.`
      );
    }
    const serviceInstance = await serviceDef.start(this as IAgentRuntime);

    if (!serviceInstance) {
      throw new Error(
        `Service ${serviceType}  start() method returned null or undefined. It must return a Service instance.`
      );
    }

    // Initialize arrays if they don't exist
    if (!this.services.has(serviceType)) {
      this.services.set(serviceType, []);
    }
    if (!this.serviceTypes.has(serviceType)) {
      this.serviceTypes.set(serviceType, []);
    }

    // Add the service to the arrays
    this.services.get(serviceType)!.push(serviceInstance);
    this.serviceTypes.get(serviceType)!.push(serviceDef);

    // inform everyone that's waiting for this service, that it's now available
    // removes the need for polling and timers
    const handler = this.servicePromiseHandlers.get(serviceType);
    if (handler) {
      handler.resolve(serviceInstance);
      // Clean up the promise handler after resolving
      this.servicePromiseHandlers.delete(serviceType);
    } else {
      this.logger.debug(
        { src: 'agent', agentId: this.agentId, serviceType },
        'Service has no promise handler'
      );
    }

    if (serviceDef.registerSendHandlers) {
      (serviceDef.constructor as typeof Service).registerSendHandlers?.(
        this as IAgentRuntime,
        serviceInstance
      );
    }
    // Update service status to registered
    this.serviceRegistrationStatus.set(serviceType, 'registered');

    this.logger.debug({ src: 'agent', agentId: this.agentId, serviceType }, 'Service registered');
  }

  /// ensures servicePromises & servicePromiseHandlers for a serviceType
  private _createServiceResolver(serviceType: ServiceTypeName) {
    let resolver: ServiceResolver | undefined;
    let rejecter: ServiceRejecter | undefined;
    this.servicePromises.set(
      serviceType,
      new Promise<Service>((resolve, reject) => {
        resolver = resolve;
        rejecter = reject;
      })
    );
    if (!resolver) {
      throw new Error(`Failed to create resolver for service ${serviceType}`);
    }
    if (!rejecter) {
      throw new Error(`Failed to create rejecter for service ${serviceType}`);
    }
    this.servicePromiseHandlers.set(serviceType, { resolve: resolver, reject: rejecter });
    return this.servicePromises.get(serviceType)!;
  }

  /// returns a promise that's resolved once this service is loaded
  getServiceLoadPromise(serviceType: ServiceTypeName): Promise<Service> {
    // if this.isInitialized then the this p will exist and already be resolved
    let p = this.servicePromises.get(serviceType);
    if (!p) {
      // not initialized or registered yet, registerPlugin is already smart enough to check to see if we make it here
      p = this._createServiceResolver(serviceType);
    }
    return p;
  }

  registerModel(
    modelType: ModelTypeName | string,
    handler: (runtime: IAgentRuntime, params: Record<string, unknown>) => Promise<unknown>,
    provider: string,
    priority?: number
  ): void {
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
    this.models.get(modelKey)?.sort((a, b) => {
      if ((b.priority || 0) !== (a.priority || 0)) {
        return (b.priority || 0) - (a.priority || 0);
      }
      return (a.registrationOrder || 0) - (b.registrationOrder || 0);
    });
  }

  getModel(
    modelType: ModelTypeName | string
  ): ((runtime: IAgentRuntime, params: Record<string, unknown>) => Promise<unknown>) | undefined {
    const modelKey = typeof modelType === 'string' ? modelType : ModelType[modelType];
    const models = this.models.get(modelKey);
    if (!models?.length) {
      return undefined;
    }

    // Return highest priority handler (first in array after sorting)
    this.logger.debug(
      { src: 'agent', agentId: this.agentId, model: modelKey, provider: models[0].provider },
      'Using model'
    );
    return models[0].handler;
  }

  /**
   * Retrieves model configuration settings from character settings with support for
   * model-specific overrides and default fallbacks.
   *
   * Precedence order (highest to lowest):
   * 1. Model-specific settings (e.g., TEXT_SMALL_TEMPERATURE)
   * 2. Default settings (e.g., DEFAULT_TEMPERATURE)
   * 3. Legacy settings for backwards compatibility (e.g., MODEL_TEMPERATURE)
   *
   * @param modelType The specific model type to get settings for
   * @returns Object containing model parameters if they exist, or null if no settings are configured
   */
  private getModelSettings(modelType?: ModelTypeName): Record<string, number> | null {
    const modelSettings: Record<string, number> = {};

    // Helper to get a setting value with fallback chain
    const getSettingWithFallback = (
      param:
        | 'MAX_TOKENS'
        | 'TEMPERATURE'
        | 'TOP_P'
        | 'TOP_K'
        | 'MIN_P'
        | 'SEED'
        | 'REPETITION_PENALTY'
        | 'FREQUENCY_PENALTY'
        | 'PRESENCE_PENALTY',
      legacyKey?: string
    ): number | null => {
      // Try model-specific setting first
      if (modelType) {
        const modelSpecificKey = `${modelType}_${param}`;
        const modelValue = this.getSetting(modelSpecificKey);
        if (modelValue !== null && modelValue !== undefined) {
          const numValue = Number(modelValue);
          if (!isNaN(numValue)) {
            return numValue;
          }
          // If model-specific value exists but is invalid, continue to fallbacks
        }
      }

      // Fall back to default setting
      const defaultKey = `DEFAULT_${param}`;
      const defaultValue = this.getSetting(defaultKey);
      if (defaultValue !== null && defaultValue !== undefined) {
        const numValue = Number(defaultValue);
        if (!isNaN(numValue)) {
          return numValue;
        }
        // If default value exists but is invalid, continue to legacy
      }

      // Fall back to legacy setting for backwards compatibility (if provided)
      if (legacyKey) {
        const legacyValue = this.getSetting(legacyKey);
        if (legacyValue !== null && legacyValue !== undefined) {
          const numValue = Number(legacyValue);
          if (!isNaN(numValue)) {
            return numValue;
          }
        }
      }

      return null;
    };

    // Get settings with proper fallback chain
    const maxTokens = getSettingWithFallback('MAX_TOKENS', MODEL_SETTINGS.MODEL_MAX_TOKEN);
    const temperature = getSettingWithFallback('TEMPERATURE', MODEL_SETTINGS.MODEL_TEMPERATURE);
    const topP = getSettingWithFallback('TOP_P');
    const topK = getSettingWithFallback('TOP_K');
    const minP = getSettingWithFallback('MIN_P');
    const seed = getSettingWithFallback('SEED');
    const repetitionPenalty = getSettingWithFallback('REPETITION_PENALTY');
    const frequencyPenalty = getSettingWithFallback(
      'FREQUENCY_PENALTY',
      MODEL_SETTINGS.MODEL_FREQ_PENALTY
    );
    const presencePenalty = getSettingWithFallback(
      'PRESENCE_PENALTY',
      MODEL_SETTINGS.MODEL_PRESENCE_PENALTY
    );

    // Add settings if they exist
    if (maxTokens !== null) modelSettings.maxTokens = maxTokens;
    if (temperature !== null) modelSettings.temperature = temperature;
    if (topP !== null) modelSettings.topP = topP;
    if (topK !== null) modelSettings.topK = topK;
    if (minP !== null) modelSettings.minP = minP;
    if (seed !== null) modelSettings.seed = seed;
    if (repetitionPenalty !== null) modelSettings.repetitionPenalty = repetitionPenalty;
    if (frequencyPenalty !== null) modelSettings.frequencyPenalty = frequencyPenalty;
    if (presencePenalty !== null) modelSettings.presencePenalty = presencePenalty;

    // Return null if no settings were configured
    return Object.keys(modelSettings).length > 0 ? modelSettings : null;
  }

  /**
   * Helper to log model calls to the database (used by both streaming and non-streaming paths)
   */
  private logModelCall(
    modelType: string,
    modelKey: string,
    params: unknown,
    promptContent: string | null,
    elapsedTime: number,
    provider: string | undefined,
    response: unknown
  ): void {
    // Log prompts to action context (except embeddings)
    if (modelKey !== ModelType.TEXT_EMBEDDING && promptContent) {
      if (this.currentActionContext) {
        this.currentActionContext.prompts.push({
          modelType: modelKey,
          prompt: promptContent,
          timestamp: Date.now(),
        });
      }
    }

    // Log to database
    this.adapter.log({
      entityId: this.agentId,
      roomId: this.currentRoomId ?? this.agentId,
      body: {
        modelType,
        modelKey,
        params: {
          ...(typeof params === 'object' && !Array.isArray(params) && params ? params : {}),
          prompt: promptContent,
        },
        prompt: promptContent,
        systemPrompt: this.character?.system || null,
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
        response:
          Array.isArray(response) && response.every((x) => typeof x === 'number')
            ? '[array]'
            : response,
      },
      type: `useModel:${modelKey}`,
    });
  }

  async useModel<T extends keyof ModelParamsMap, R = ModelResultMap[T]>(
    modelType: T,
    params: ModelParamsMap[T],
    provider?: string
  ): Promise<R> {
    const modelKey = typeof modelType === 'string' ? modelType : ModelType[modelType];
    const paramsObj = params as Record<string, unknown> | null | undefined;
    const promptContent =
      (paramsObj && 'prompt' in paramsObj && typeof paramsObj.prompt === 'string'
        ? paramsObj.prompt
        : null) ||
      (paramsObj && 'input' in paramsObj && typeof paramsObj.input === 'string'
        ? paramsObj.input
        : null) ||
      (paramsObj && 'messages' in paramsObj && Array.isArray(paramsObj.messages)
        ? JSON.stringify(paramsObj.messages)
        : null);
    const model = this.getModel(modelKey);
    const modelWithProvider =
      provider && this.models.get(modelKey)?.find((m) => m.provider === provider);
    const handler = modelWithProvider ? modelWithProvider.handler : model;
    if (!handler) {
      const errorMsg = `No handler found for delegate type: ${modelKey}`;
      throw new Error(errorMsg);
    }

    // Log input parameters (keep debug log if useful)
    // Skip verbose logging for binary data models (TRANSCRIPTION, IMAGE, AUDIO, VIDEO)
    const binaryModels: string[] = [
      ModelType.TRANSCRIPTION,
      ModelType.IMAGE,
      ModelType.AUDIO,
      ModelType.VIDEO,
    ];
    if (!binaryModels.includes(modelKey)) {
      this.logger.trace(
        { src: 'agent', agentId: this.agentId, model: modelKey, params },
        'Model input'
      );
    } else {
      // For binary models, just log the type and size info
      let sizeInfo = 'unknown size';
      if (Buffer.isBuffer(params)) {
        sizeInfo = `${params.length} bytes`;
      } else if (typeof Blob !== 'undefined' && params instanceof Blob) {
        sizeInfo = `${params.size} bytes`;
      } else if (typeof params === 'object' && params !== null) {
        if ('audio' in params && Buffer.isBuffer(params.audio)) {
          sizeInfo = `${(params.audio as Buffer).length} bytes`;
        } else if (
          'audio' in params &&
          typeof Blob !== 'undefined' &&
          params.audio instanceof Blob
        ) {
          sizeInfo = `${(params.audio as Blob).size} bytes`;
        }
      }
      this.logger.trace(
        { src: 'agent', agentId: this.agentId, model: modelKey, size: sizeInfo },
        'Model input (binary)'
      );
    }
    let modelParams: ModelParamsMap[T];
    if (
      params === null ||
      params === undefined ||
      typeof params !== 'object' ||
      Array.isArray(params) ||
      BufferUtils.isBuffer(params)
    ) {
      modelParams = params;
    } else {
      // Include model settings from character configuration if available
      const modelSettings = this.getModelSettings(modelKey);

      if (modelSettings) {
        // Apply model settings if configured
        modelParams = {
          ...modelSettings, // Apply model settings first (includes defaults and model-specific)
          ...params, // Then apply specific params (allowing overrides)
        };
      } else {
        // No model settings configured, use params as-is
        modelParams = params;
      }

      // Auto-populate user parameter from character name if not provided
      // The `user` parameter is used by LLM providers for tracking and analytics purposes.
      // We only auto-populate when user is undefined (not explicitly set to empty string or null)
      // to allow users to intentionally set an empty identifier if needed.
      if (isPlainObject(modelParams)) {
        if (modelParams.user === undefined && this.character?.name) {
          if (
            typeof modelParams === 'object' &&
            modelParams !== null &&
            !Array.isArray(modelParams)
          ) {
            (modelParams as Record<string, unknown>).user = this.character.name;
          }
        }
      }
    }
    const startTime =
      typeof performance !== 'undefined' && typeof performance.now === 'function'
        ? performance.now()
        : Date.now();

    // Get streaming config
    const streamingCtx = getStreamingContext();
    const paramsChunk = isPlainObject(modelParams) ? (modelParams as any).onStreamChunk : undefined;
    const ctxChunk = streamingCtx?.onStreamChunk;
    const msgId = streamingCtx?.messageId;
    const abortSignal = streamingCtx?.abortSignal;
    const explicitStream = isPlainObject(modelParams) ? (modelParams as any).stream : undefined;

    // stream: false = force no stream, otherwise stream if any callback exists
    const shouldStream =
      explicitStream === false ? false : !!(paramsChunk || ctxChunk || explicitStream);

    if (isPlainObject(modelParams)) {
      (modelParams as any).stream = shouldStream;
      delete (modelParams as any).onStreamChunk;
    }

    const response = await handler(this as IAgentRuntime, modelParams as Record<string, unknown>);

    // Stream: broadcast to callbacks if streaming
    if (
      shouldStream &&
      (paramsChunk || ctxChunk) &&
      response &&
      typeof response === 'object' &&
      'textStream' in response
    ) {
      let fullText = '';
      for await (const chunk of (response as TextStreamResult).textStream) {
        if (abortSignal?.aborted) break;
        fullText += chunk;
        try {
          if (paramsChunk) await paramsChunk(chunk, msgId);
        } catch {}
        try {
          if (ctxChunk) await ctxChunk(chunk, msgId);
        } catch {}
      }

      // Signal stream end to allow context to reset state between useModel calls
      const ctxEnd = getStreamingContext()?.onStreamEnd;
      if (ctxEnd) ctxEnd();

      // Log the completed stream
      const elapsedTime =
        (typeof performance !== 'undefined' && typeof performance.now === 'function'
          ? performance.now()
          : Date.now()) - startTime;
      this.logger.trace(
        {
          src: 'agent',
          agentId: this.agentId,
          model: modelKey,
          duration: Number(elapsedTime.toFixed(2)),
          streaming: true,
        },
        'Model output (stream with callback complete)'
      );

      this.logModelCall(
        modelType,
        modelKey,
        params,
        promptContent,
        elapsedTime,
        provider,
        fullText
      );
      return fullText as R;
    }

    const elapsedTime =
      (typeof performance !== 'undefined' && typeof performance.now === 'function'
        ? performance.now()
        : Date.now()) - startTime;

    // Log timing / response (keep debug log if useful)
    this.logger.trace(
      {
        src: 'agent',
        agentId: this.agentId,
        model: modelKey,
        duration: Number(elapsedTime.toFixed(2)),
      },
      'Model output'
    );

    this.logModelCall(modelType, modelKey, params, promptContent, elapsedTime, provider, response);
    return response as R;
  }

  /**
   * Simplified text generation with optional character context.
   */
  async generateText(input: string, options?: GenerateTextOptions): Promise<GenerateTextResult> {
    if (!input?.trim()) {
      throw new Error('Input cannot be empty');
    }

    // Set defaults
    const includeCharacter = options?.includeCharacter ?? true;
    const modelType = options?.modelType ?? ModelType.TEXT_LARGE;

    let prompt = input;

    // Add character context if requested
    if (includeCharacter && this.character) {
      const c = this.character;
      const parts: string[] = [];

      // Add bio
      const bioText = Array.isArray(c.bio) ? c.bio.join(' ') : c.bio;
      if (bioText) {
        parts.push(`# About ${c.name}\n${bioText}`);
      }

      // Add system prompt
      if (c.system) {
        parts.push(c.system);
      }

      // Add style directives (all + chat)
      const styles = [...(c.style?.all || []), ...(c.style?.chat || [])];
      if (styles.length > 0) {
        parts.push(`Style:\n${styles.map((s) => `- ${s}`).join('\n')}`);
      }

      // Combine character context with input
      if (parts.length > 0) {
        prompt = `${parts.join('\n\n')}\n\n${input}`;
      }
    }

    const params: GenerateTextParams = {
      prompt,
      maxTokens: options?.maxTokens,
      minTokens: options?.minTokens,
      temperature: options?.temperature,
      topP: options?.topP,
      topK: options?.topK,
      minP: options?.minP,
      seed: options?.seed,
      repetitionPenalty: options?.repetitionPenalty,
      frequencyPenalty: options?.frequencyPenalty,
      presencePenalty: options?.presencePenalty,
      stopSequences: options?.stopSequences,
      // User identifier for provider tracking/analytics - auto-populates from character name if not provided
      // Explicitly set empty string or null will be preserved (not overridden)
      user: options?.user !== undefined ? options.user : this.character?.name,
      responseFormat: options?.responseFormat,
    };

    const response = await this.useModel(modelType, params);

    return {
      text: response as string,
    };
  }

  registerEvent<T extends keyof EventPayloadMap>(event: T, handler: EventHandler<T>): void;
  registerEvent<P extends EventPayload = EventPayload>(
    event: string,
    handler: (params: P) => Promise<void>
  ): void;
  registerEvent(event: string, handler: (params: EventPayload) => Promise<void>): void {
    if (!this.events[event]) {
      this.events[event] = [];
    }
    this.events[event]!.push(handler as (params: unknown) => Promise<void>);
  }

  getEvent(event: string): ((params: unknown) => Promise<void>)[] | undefined {
    return this.events[event] as ((params: unknown) => Promise<void>)[] | undefined;
  }

  async emitEvent(event: string | string[], params: unknown) {
    const events = Array.isArray(event) ? event : [event];
    for (const eventName of events) {
      const eventHandlers = this.events[eventName];
      if (!eventHandlers) {
        continue;
      }
      let paramsWithRuntime: EventPayload = { runtime: this as IAgentRuntime, source: 'runtime' };
      if (typeof params === 'object' && params && params !== null) {
        const paramsObj = params as Record<string, unknown>;
        paramsWithRuntime = {
          ...paramsObj,
          runtime: this as IAgentRuntime,
          source: (paramsObj.source as string) || 'runtime',
        } as EventPayload;
      }
      await Promise.all(
        eventHandlers.map((handler) => handler(paramsWithRuntime as unknown as EventPayload))
      );
    }
  }

  async ensureEmbeddingDimension(): Promise<void> {
    if (!this.adapter) {
      throw new Error('Database adapter not initialized before ensureEmbeddingDimension');
    }
    if (!this.getModel(ModelType.TEXT_EMBEDDING)) {
      throw new Error('No TEXT_EMBEDDING model registered');
    }

    // Check if dimension is provided via settings (skips expensive ~500ms API call)
    const providedDimension = this.getSetting('EMBEDDING_DIMENSION');
    const parsedDimension = Number(providedDimension);
    const useProvidedDimension = parsedDimension > 0;

    const dimension = useProvidedDimension
      ? parsedDimension
      : (await this.useModel(ModelType.TEXT_EMBEDDING, { text: '' }))?.length;

    if (!dimension) {
      throw new Error('Invalid embedding dimension');
    }

    await this.adapter.ensureEmbeddingDimension(dimension);
    this.logger.debug(
      { src: 'agent', agentId: this.agentId, dimension },
      useProvidedDimension
        ? 'Embedding dimension set from config'
        : 'Embedding dimension set via API call'
    );
  }

  registerTaskWorker(taskHandler: TaskWorker): void {
    if (this.taskWorkers.has(taskHandler.name)) {
      this.logger.warn(
        { src: 'agent', agentId: this.agentId, task: taskHandler.name },
        'Task worker already registered, overwriting'
      );
    }
    this.taskWorkers.set(taskHandler.name, taskHandler);
  }

  getTaskWorker(name: string): TaskWorker | undefined {
    return this.taskWorkers.get(name);
  }

  get db(): unknown {
    return this.adapter.db;
  }
  async init(): Promise<void> {
    await this.adapter.init();
  }
  async close(): Promise<void> {
    if (this.adapter) {
      await this.adapter.close();
    }
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
    if (!agent.id) {
      throw new Error('Agent id is required');
    }

    // Check if agent exists by ID
    const existingAgent = await this.adapter.getAgent(agent.id);

    if (existingAgent) {
      // Merge DB-persisted settings with character configuration
      // Priority: DB (persisted runtime settings) < character.json (file overrides)
      const mergedSettings = {
        ...existingAgent.settings, // Keep all DB-persisted settings
        ...agent.settings, // Override only keys present in character.json
      };

      // Deep merge secrets to preserve runtime-generated secrets
      const mergedSecrets =
        typeof existingAgent.settings?.secrets === 'object' ||
        typeof agent.settings?.secrets === 'object'
          ? {
              ...(typeof existingAgent.settings?.secrets === 'object'
                ? existingAgent.settings.secrets
                : {}),
              ...(typeof agent.settings?.secrets === 'object' ? agent.settings.secrets : {}),
            }
          : undefined;

      if (mergedSecrets) {
        mergedSettings.secrets = mergedSecrets;
      }

      const updatedAgent = {
        ...existingAgent, // Keep all DB-persisted data
        ...agent, // Override with character.json values
        settings: mergedSettings, // Use intelligently merged settings
        id: agent.id,
        updatedAt: Date.now(),
      };

      await this.adapter.updateAgent(agent.id, updatedAgent);
      const refreshedAgent = await this.adapter.getAgent(agent.id);

      if (!refreshedAgent) {
        throw new Error(`Failed to retrieve agent after update: ${agent.id}`);
      }

      this.logger.debug({ src: 'agent', agentId: agent.id }, 'Agent updated on restart');
      return refreshedAgent;
    }

    // Create new agent if it doesn't exist
    const newAgent: Agent = {
      ...agent,
      id: agent.id,
    } as Agent;

    const created = await this.adapter.createAgent(newAgent);
    if (!created) {
      throw new Error(`Failed to create agent: ${agent.id}`);
    }

    this.logger.debug({ src: 'agent', agentId: agent.id }, 'Agent created');
    return newAgent;
  }
  async getEntityById(entityId: UUID): Promise<Entity | null> {
    const entities = await this.adapter.getEntitiesByIds([entityId]);
    if (!entities?.length) return null;
    return entities[0];
  }

  async getEntitiesByIds(entityIds: UUID[]): Promise<Entity[] | null> {
    return await this.adapter.getEntitiesByIds(entityIds);
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

  /**
   * Ensures entity exists, creating if needed.
   * @param entity - The entity to ensure exists
   * @returns Input entity on success (not re-fetched to avoid extra query), null on failure
   */
  async ensureEntity(entity: Entity): Promise<Entity | null> {
    if (!entity.id) return null;

    const created = await this.createEntity(entity);
    if (!created) return null;

    return entity;
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
    } catch (error: unknown) {
      this.logger.error(
        {
          src: 'agent',
          agentId: this.agentId,
          error: error instanceof Error ? error.message : String(error),
        },
        'Embedding generation failed'
      );
      memory.embedding = await this.useModel(ModelType.TEXT_EMBEDDING, { text: '' });
    }
    return memory;
  }

  async queueEmbeddingGeneration(
    memory: Memory,
    priority?: 'high' | 'normal' | 'low'
  ): Promise<void> {
    // Set default priority if not provided
    priority = priority || 'normal';

    // Skip if memory is null or undefined
    if (!memory) {
      return;
    }

    // Skip if memory already has embeddings
    if (memory.embedding) {
      return;
    }

    // Skip if no text content
    if (!memory.content?.text) {
      return;
    }

    // Emit event for async embedding generation
    await this.emitEvent(EventType.EMBEDDING_GENERATION_REQUESTED, {
      runtime: this,
      memory,
      priority,
      source: 'runtime',
      retryCount: 0,
      maxRetries: 3,
      runId: this.getCurrentRunId(),
    });
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
      } catch (error: unknown) {
        // Continue with other tables if one fails
        this.logger.debug(
          {
            src: 'agent',
            agentId: this.agentId,
            tableName,
            error: error instanceof Error ? error.message : String(error),
          },
          'Failed to get memories'
        );
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
    if (unique !== undefined) memory.unique = unique;
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
    this.logger.info({ src: 'agent', agentId: this.agentId }, 'Clearing all memories');

    const allMemories = await this.getAllMemories();
    const memoryIds = allMemories
      .map((memory) => memory.id)
      .filter((id): id is UUID => id !== undefined);

    if (memoryIds.length === 0) {
      this.logger.debug({ src: 'agent', agentId: this.agentId }, 'No memories to delete');
      return;
    }

    await this.adapter.deleteManyMemories(memoryIds);
    this.logger.info(
      { src: 'agent', agentId: this.agentId, count: memoryIds.length },
      'Memories cleared'
    );
  }
  async deleteAllMemories(roomId: UUID, tableName: string): Promise<void> {
    await this.adapter.deleteAllMemories(roomId, tableName);
  }
  async countMemories(roomId: UUID, unique?: boolean, tableName?: string): Promise<number> {
    return await this.adapter.countMemories(roomId, unique, tableName);
  }
  async getLogs(params: {
    entityId?: UUID;
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
  async getRoom(roomId: UUID): Promise<Room | null> {
    const rooms = await this.adapter.getRoomsByIds([roomId]);
    if (!rooms?.length) return null;
    return rooms[0];
  }

  async getRoomsByIds(roomIds: UUID[]): Promise<Room[] | null> {
    return await this.adapter.getRoomsByIds(roomIds);
  }
  async createRoom({
    id,
    name,
    source,
    type,
    channelId,
    messageServerId,
    worldId,
  }: Room): Promise<UUID> {
    if (!worldId) throw new Error('worldId is required');
    const res = await this.adapter.createRooms([
      {
        id,
        name,
        source,
        type,
        channelId,
        messageServerId,
        worldId,
      },
    ]);
    if (!res.length) throw new Error('Failed to create room');
    return res[0];
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
    metadata?: { [key: string]: unknown };
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
  on(event: string, callback: (data: unknown) => void): void {
    if (!this.eventHandlers.has(event)) {
      this.eventHandlers.set(event, []);
    }
    this.eventHandlers.get(event)?.push(callback);
  }
  off(event: string, callback: (data: unknown) => void): void {
    if (!this.eventHandlers.has(event)) {
      return;
    }
    const handlers = this.eventHandlers.get(event)!;
    const index = handlers.indexOf(callback);
    if (index !== -1) {
      handlers.splice(index, 1);
    }
  }
  emit(event: string, data: unknown): void {
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
    const { roomId, action, target } = params;
    const controlMessage: ControlMessage = {
      type: 'control',
      payload: {
        action,
        target,
      },
      roomId,
    };
    try {
      await this.emitEvent('CONTROL_MESSAGE', {
        runtime: this,
        message: controlMessage,
        source: 'agent',
      });

      this.logger.debug(
        { src: 'agent', agentId: this.agentId, action, channelId: roomId },
        'Control message sent'
      );
    } catch (error: unknown) {
      this.logger.error(
        {
          src: 'agent',
          agentId: this.agentId,
          error: error instanceof Error ? error.message : String(error),
        },
        'Control message failed'
      );
    }
  }
  registerSendHandler(source: string, handler: SendHandlerFunction): void {
    if (this.sendHandlers.has(source)) {
      this.logger.warn(
        { src: 'agent', agentId: this.agentId, handlerSource: source },
        'Send handler already registered, overwriting'
      );
    }
    this.sendHandlers.set(source, handler);
    this.logger.debug(
      { src: 'agent', agentId: this.agentId, handlerSource: source },
      'Send handler registered'
    );
  }
  async sendMessageToTarget(target: TargetInfo, content: Content): Promise<void> {
    const handler = this.sendHandlers.get(target.source);
    if (!handler) {
      const errorMsg = `No send handler registered for source: ${target.source}`;
      this.logger.error(
        { src: 'agent', agentId: this.agentId, handlerSource: target.source },
        'Send handler not found'
      );
      throw new Error(errorMsg);
    }
    try {
      await handler(this, target, content);
    } catch (error: unknown) {
      this.logger.error(
        {
          src: 'agent',
          agentId: this.agentId,
          handlerSource: target.source,
          error: error instanceof Error ? error.message : String(error),
        },
        'Send handler failed'
      );
      throw error;
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
    if (this.adapter?.runMigrations) {
      await this.adapter.runMigrations(migrationsPaths);
    } else {
      this.logger.warn(
        { src: 'agent', agentId: this.agentId },
        'Database adapter does not support migrations'
      );
    }
  }

  async isReady(): Promise<boolean> {
    if (!this.adapter) {
      throw new Error('Database adapter not registered');
    }
    return await this.adapter.isReady();
  }

  hasElizaOS(): this is IAgentRuntime & { elizaOS: IElizaOS } {
    return this.elizaOS !== undefined;
  }
}
