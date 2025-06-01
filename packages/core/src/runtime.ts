import { SpanStatusCode, context, trace, type Context, type Span } from '@opentelemetry/api';
import { v4 as uuidv4 } from 'uuid';
import { createUniqueUuid } from './entities';
import { decryptSecret, getSalt, safeReplacer } from './index';
import { InstrumentationService } from './instrumentation/service';
import { createLogger } from './logger';
import {
  ChannelType,
  ModelType,
  type Content,
  type KnowledgeItem,
  type MemoryMetadata,
} from './types';

import { PGlite } from '@electric-sql/pglite';
import { Pool } from 'pg';
import { BM25 } from './search';
import type {
  Action,
  Agent,
  Character,
  Component,
  Entity,
  Evaluator,
  HandlerCallback,
  IAgentRuntime,
  IDatabaseAdapter,
  Log,
  Memory,
  ModelHandler,
  ModelParamsMap,
  ModelResultMap,
  ModelTypeName,
  Participant,
  Plugin,
  Provider,
  Relationship,
  Room,
  Route,
  RuntimeSettings,
  SendHandlerFunction,
  Service,
  ServiceInstance,
  ServiceTypeRegistry,
  ServiceTypeName,
  State,
  TargetInfo,
  Task,
  TaskWorker,
  UUID,
  World,
} from './types';
import { EventType, type MessagePayload } from './types';
import { stringToUuid } from './utils';

// Minimal interface for RagService to ensure type safety for delegation
// This avoids a direct import cycle if RagService imports from core.
interface RagServiceDelegator extends Service {
  getKnowledge(
    message: Memory,
    scope?: { roomId?: UUID; worldId?: UUID; entityId?: UUID }
  ): Promise<KnowledgeItem[]>;
  // Assuming _internalAddKnowledge is the method in RagService that takes these params
  _internalAddKnowledge(item: KnowledgeItem, options?: any, scope?: any): Promise<void>;
}

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
  instrumentationService: InstrumentationService;
  tracer: any;

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
    this.character = opts.character;
    const logLevel = process.env.LOG_LEVEL || 'info';

    // Create the logger with appropriate level - only show debug logs when explicitly configured
    this.logger = createLogger({
      agentName: this.character?.name,
    });

    this.logger.debug(`[AgentRuntime] Process working directory: ${process.cwd()}`);

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

    if (process.env.INSTRUMENTATION_ENABLED === 'true') {
      try {
        this.instrumentationService = new InstrumentationService({
          serviceName: `agent-${this.character?.name || 'unknown'}-${this.agentId}`,
          enabled: true,
        });
        this.tracer = this.instrumentationService.getTracer('agent-runtime');

        this.logger.debug(`Instrumentation service initialized for agent ${this.agentId}`);
      } catch (error) {
        // If instrumentation fails, provide a fallback implementation
        this.logger.warn(`Failed to initialize instrumentation: ${error.message}`);
        // Create a no-op implementation
        this.instrumentationService = {
          getTracer: () => null,
          start: async () => {},
          stop: async () => {},
          isStarted: () => false,
          isEnabled: () => false,
          name: 'INSTRUMENTATION',
          capabilityDescription: 'Disabled instrumentation service (fallback)',
          instrumentationConfig: { enabled: false },
          getMeter: () => null,
          flush: async () => {},
        } as any;
        this.tracer = null;
      }
    }

    this.logger.debug(`Success: Agent ID: ${this.agentId}`);
  }

  async startSpan<T>(
    name: string,
    fn: (span: Span) => Promise<T>,
    parentContext?: Context
  ): Promise<T> {
    if (!this.instrumentationService?.isEnabled?.() || !this.tracer) {
      const mockSpan = {
        setStatus: () => {},
        setAttribute: () => {},
        setAttributes: () => {},
        recordException: () => {},
        addEvent: () => {},
        end: () => {},
        isRecording: () => false,
        spanContext: () => ({ traceId: '', spanId: '', traceFlags: 0 }),
        updateName: () => {},
        addLink: () => {},
        addLinks: () => {},
      } as unknown as Span;
      return fn(mockSpan);
    }
    return this.tracer.startActiveSpan(name, parentContext, undefined, async (span: Span) => {
      try {
        span.setAttributes({
          'agent.id': this.agentId,
          'agent.name': this.character?.name || 'unknown',
        });
        const result = await fn(span);
        span.setStatus({ code: SpanStatusCode.OK });
        span.end();
        return result;
      } catch (error: any) {
        span.recordException(error as Error);
        span.setStatus({
          code: SpanStatusCode.ERROR,
          message: (error as Error).message,
        });
        span.end();
        throw error;
      }
    });
  }

  endSpan(ctx: Context | undefined, name: string): void {}

  startActiveSpan(name: string, options: any = {}): Span {
    if (!this.instrumentationService?.isEnabled?.() || !this.tracer) {
      return {
        setStatus: () => {},
        setAttribute: () => {},
        setAttributes: () => {},
        recordException: () => {},
        addEvent: () => {},
        end: () => {},
        isRecording: () => false,
        spanContext: () => ({ traceId: '', spanId: '', traceFlags: 0 }),
        updateName: () => {},
        addLink: () => {},
        addLinks: () => {},
      } as unknown as Span;
    }
    return this.tracer.startSpan(name, options);
  }

  async registerPlugin(plugin: Plugin): Promise<void> {
    return this.startSpan('AgentRuntime.registerPlugin', async (span) => {
      span.setAttributes({
        'plugin.name': plugin?.name || 'unknown',
        'agent.id': this.agentId,
      });
      if (!plugin?.name) {
        // Ensure plugin and plugin.name are defined
        const errorMsg = 'Plugin or plugin name is undefined';
        span.setStatus({ code: SpanStatusCode.ERROR, message: errorMsg });
        this.logger.error(`*** registerPlugin: ${errorMsg}`);
        throw new Error(`*** registerPlugin: ${errorMsg}`);
      }

      // Check if a plugin with the same name is already registered.
      if (this.plugins.some((p) => p.name === plugin.name)) {
        this.logger.warn(
          `${this.character.name}(${this.agentId}) - Plugin ${plugin.name} is already registered. Skipping re-registration.`
        );
        span.addEvent('plugin_already_registered_skipped');
        return; // Do not proceed further
      }

      // Add the plugin to the runtime's list of active plugins
      (this.plugins as Plugin[]).push(plugin);
      span.addEvent('plugin_added_to_active_list');
      this.logger.debug(
        `Success: Plugin ${plugin.name} added to active plugins for ${this.character.name}(${this.agentId}).`
      );

      if (plugin.init) {
        try {
          span.addEvent('initializing_plugin');
          await plugin.init(plugin.config || {}, this);
          span.addEvent('plugin_initialized');
          this.logger.debug(`Success: Plugin ${plugin.name} initialized successfully`);
        } catch (error) {
          // Check if the error is related to missing API keys
          const errorMessage = error instanceof Error ? error.message : String(error);
          span.setAttributes({
            'error.message': errorMessage,
            'error.type': error instanceof Error ? error.constructor.name : 'Unknown',
          });
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
            span.addEvent('plugin_configuration_warning');
          } else {
            span.setStatus({ code: SpanStatusCode.ERROR, message: errorMessage });
            throw error;
          }
        }
      }
      if (plugin.adapter) {
        span.addEvent('registering_adapter');
        this.logger.debug(`Registering database adapter for plugin ${plugin.name}`);
        this.registerDatabaseAdapter(plugin.adapter);
      }
      if (plugin.actions) {
        span.addEvent('registering_actions');
        for (const action of plugin.actions) {
          this.registerAction(action);
        }
      }
      if (plugin.evaluators) {
        span.addEvent('registering_evaluators');
        for (const evaluator of plugin.evaluators) {
          this.registerEvaluator(evaluator);
        }
      }
      if (plugin.providers) {
        span.addEvent('registering_providers');
        for (const provider of plugin.providers) {
          this.registerProvider(provider);
        }
      }
      if (plugin.models) {
        span.addEvent('registering_models');
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
        span.addEvent('registering_routes');
        for (const route of plugin.routes) {
          this.routes.push(route);
        }
      }
      if (plugin.events) {
        span.addEvent('registering_events');
        for (const [eventName, eventHandlers] of Object.entries(plugin.events)) {
          for (const eventHandler of eventHandlers) {
            this.registerEvent(eventName, eventHandler);
          }
        }
      }
      if (plugin.services) {
        span.addEvent('registering_services');
        for (const service of plugin.services) {
          if (this.isInitialized) {
            await this.registerService(service);
          } else {
            this.servicesInitQueue.add(service);
          }
        }
      }
      span.addEvent('plugin_registration_complete');
    });
  }

  private async resolvePluginDependencies(characterPlugins: Plugin[]): Promise<Plugin[]> {
    const resolvedPlugins = new Map<string, Plugin>();
    const visited = new Set<string>();
    const recursionStack = new Set<string>();
    const finalPluginList: Plugin[] = [];

    // First, add all character-specified plugins to resolvedPlugins to prioritize them.
    for (const plugin of characterPlugins) {
      if (plugin?.name) {
        resolvedPlugins.set(plugin.name, plugin);
      }
    }

    const resolve = async (pluginName: string) => {
      if (recursionStack.has(pluginName)) {
        this.logger.error(
          `Circular dependency detected: ${Array.from(recursionStack).join(' -> ')} -> ${pluginName}`
        );
        throw new Error(`Circular dependency detected involving plugin: ${pluginName}`);
      }
      if (visited.has(pluginName)) {
        return;
      }

      visited.add(pluginName);
      recursionStack.add(pluginName);

      let plugin = resolvedPlugins.get(pluginName); // Check if it's a character-specified plugin first
      if (!plugin) {
        plugin = this.allAvailablePlugins.get(pluginName); // Fallback to allAvailablePlugins
      }

      if (!plugin) {
        this.logger.warn(
          `Dependency plugin "${pluginName}" not found in allAvailablePlugins. Skipping.`
        );
        recursionStack.delete(pluginName);
        return; // Or throw an error if strict dependency checking is required
      }

      if (plugin.dependencies) {
        for (const depName of plugin.dependencies) {
          await resolve(depName);
        }
      }

      recursionStack.delete(pluginName);
      // Add to final list only if it hasn't been added. This ensures correct order for dependencies.
      if (!finalPluginList.find((p) => p.name === pluginName)) {
        finalPluginList.push(plugin);
        // Ensure the resolvedPlugins map contains the instance we are actually going to use.
        // This is important if a dependency was loaded from allAvailablePlugins but was also a character plugin.
        // The character plugin (already in resolvedPlugins) should be the one used.
        if (!resolvedPlugins.has(pluginName)) {
          resolvedPlugins.set(pluginName, plugin);
        }
      }
    };

    // Resolve dependencies for all character-specified plugins.
    for (const plugin of characterPlugins) {
      if (plugin?.name) {
        await resolve(plugin.name);
      }
    }

    // The finalPluginList is now topologically sorted.
    // We also need to ensure that any plugin in characterPlugins that was *not* a dependency of another characterPlugin
    // is also included, maintaining its original instance.
    const finalSet = new Map<string, Plugin>();
    finalPluginList.forEach((p) => finalSet.set(p.name, resolvedPlugins.get(p.name)!));
    characterPlugins.forEach((p) => {
      if (p?.name && !finalSet.has(p.name)) {
        // This handles cases where a character plugin has no dependencies and wasn't pulled in as one.
        // It should be added to the end, or merged based on priority if that's a requirement (not implemented here).
        finalSet.set(p.name, p);
      }
    });

    return Array.from(finalSet.values());
  }

  getAllServices(): Map<ServiceTypeName, Service> {
    return this.services;
  }

  async stop() {
    return this.startSpan('AgentRuntime.stop', async (span) => {
      span.setAttributes({
        'agent.id': this.agentId,
        'agent.name': this.character?.name || 'unknown',
      });

      this.logger.debug(`runtime::stop - character ${this.character.name}`);
      span.addEvent('stopping_services');
      for (const [serviceName, service] of this.services) {
        this.logger.debug(`runtime::stop - requesting service stop for ${serviceName}`);
        span.addEvent(`stopping_service_${serviceName}`);
        await service.stop();
      }
      span.addEvent('all_services_stopped');
    });
  }

  async initialize(): Promise<void> {
    return this.startSpan('AgentRuntime.initialize', async (span) => {
      span.setAttributes({
        'agent.id': this.agentId,
        'agent.name': this.character?.name || 'unknown',
        'plugins.count': this.plugins.length,
      });
      if (this.isInitialized) {
        span.addEvent('agent_already_initialized');
        this.logger.warn('Agent already initialized');
        return;
      }
      span.addEvent('initialization_started');
      const registeredPluginNames = new Set<string>(); // This can be removed if registerPlugin handles duplicates
      const pluginRegistrationPromises = [];

      // Resolve plugin dependencies and get the final list of plugins to load
      const pluginsToLoad = await this.resolvePluginDependencies(this.characterPlugins);
      // (this.plugins as Plugin[]) = pluginsToLoad; // This line is removed. this.plugins will be built by registerPlugin calls.
      span.setAttributes({ 'plugins.resolved_count': pluginsToLoad.length });

      for (const plugin of pluginsToLoad) {
        // Iterate over the resolved list
        // The check for registeredPluginNames can be removed if registerPlugin handles its own idempotency by name.
        // if (plugin && !registeredPluginNames.has(plugin.name)) {
        //   registeredPluginNames.add(plugin.name);
        //   pluginRegistrationPromises.push(this.registerPlugin(plugin));
        // }
        if (plugin) {
          // Ensure plugin is not null/undefined
          pluginRegistrationPromises.push(this.registerPlugin(plugin));
        }
      }
      await Promise.all(pluginRegistrationPromises);
      span.addEvent('plugins_setup');
      span.setAttributes({
        registered_plugins: Array.from(registeredPluginNames).join(','),
      });
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
        span.addEvent('adapter_initialized');
        const existingAgent = await this.adapter.ensureAgentExists(
          this.character as Partial<Agent>
        );
        span.addEvent('agent_exists_verified');
        if (!existingAgent) {
          const errorMsg = `Agent ${this.character.name} does not exist in database after ensureAgentExists call`;
          span.setStatus({ code: SpanStatusCode.ERROR, message: errorMsg });
          throw new Error(errorMsg);
        }

        // No need to transform agent's own ID
        let agentEntity = await this.getEntityById(this.agentId);

        if (!agentEntity) {
          span.addEvent('creating_agent_entity');
          const created = await this.createEntity({
            id: this.agentId,
            names: [this.character.name],
            metadata: {},
            agentId: existingAgent.id,
          });
          if (!created) {
            const errorMsg = `Failed to create entity for agent ${this.agentId}`;
            span.setStatus({ code: SpanStatusCode.ERROR, message: errorMsg });
            throw new Error(errorMsg);
          }

          agentEntity = await this.getEntityById(this.agentId);
          if (!agentEntity) throw new Error(`Agent entity not found for ${this.agentId}`);

          this.logger.debug(
            `Success: Agent entity created successfully for ${this.character.name}`
          );
          span.addEvent('agent_entity_created');
        } else {
          span.addEvent('agent_entity_exists');
        }
      } catch (error: any) {
        const errorMsg = error instanceof Error ? error.message : String(error);
        span.recordException(error as Error);
        span.setStatus({ code: SpanStatusCode.ERROR, message: errorMsg });
        this.logger.error(`Failed to create agent entity: ${errorMsg}`);
        throw error;
      }
      try {
        span.addEvent('creating_group_and_plugins_already_registering');
        span.addEvent('room_created_and_plugins_registered');
      } catch (error: any) {
        const errorMsg = error instanceof Error ? error.message : String(error);
        span.recordException(error as Error);
        span.setStatus({ code: SpanStatusCode.ERROR, message: errorMsg });
        this.logger.error(`Failed to initialize: ${errorMsg}`);
        throw error;
      }
      try {
        const room = await this.getRoom(this.agentId);
        if (!room) {
          const room = await this.createRoom({
            id: this.agentId,
            name: this.character.name,
            source: 'elizaos',
            type: ChannelType.SELF,
            channelId: this.agentId,
            serverId: this.agentId,
            worldId: this.agentId,
          });
        }
        span.addEvent('adding_agent_as_participant');
        const participants = await this.adapter.getParticipantsForRoom(this.agentId);
        if (!participants.includes(this.agentId)) {
          const added = await this.addParticipant(this.agentId, this.agentId);
          if (!added) {
            const errorMsg = `Failed to add agent ${this.agentId} as participant to its own room`;
            span.setStatus({ code: SpanStatusCode.ERROR, message: errorMsg });
            throw new Error(errorMsg);
          }
          this.logger.debug(`Agent ${this.character.name} linked to its own room successfully`);
          span.addEvent('agent_added_as_participant');
        } else {
          span.addEvent('agent_already_participant');
        }
      } catch (error: any) {
        const errorMsg = error instanceof Error ? error.message : String(error);
        span.recordException(error as Error);
        span.setStatus({ code: SpanStatusCode.ERROR, message: errorMsg });
        this.logger.error(`Failed to add agent as participant: ${errorMsg}`);
        throw error;
      }
      const embeddingModel = this.getModel(ModelType.TEXT_EMBEDDING);
      if (!embeddingModel) {
        span.addEvent('embedding_model_missing');
        this.logger.warn(
          `[AgentRuntime][${this.character.name}] No TEXT_EMBEDDING model registered. Skipping embedding dimension setup.`
        );
      } else {
        span.addEvent('setting_up_embedding_dimension');
        await this.ensureEmbeddingDimension();
        span.addEvent('embedding_dimension_setup_complete');
      }
      span.addEvent('starting_deferred_services');
      span.setAttributes({
        'deferred_services.count': this.servicesInitQueue.size,
      });
      for (const service of this.servicesInitQueue) {
        await this.registerService(service);
      }
      this.isInitialized = true;
      span.addEvent('initialization_completed');
    });
  }

  async getConnection(): Promise<PGlite | Pool> {
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
    return this.startSpan('AgentRuntime.processActions', async (span) => {
      span.setAttributes({
        'message.id': message.id,
        'responses.count': responses.length,
        'agent.id': this.agentId,
      });
      for (const response of responses) {
        if (!response.content?.actions || response.content.actions.length === 0) {
          span.addEvent('no_actions_in_response');
          this.logger.warn('No action found in the response content.');
          continue;
        }
        const actions = response.content.actions;
        span.setAttributes({
          'actions.count': actions.length,
          'actions.names': JSON.stringify(actions),
        });
        function normalizeAction(actionString: string) {
          return actionString.toLowerCase().replace('_', '');
        }
        this.logger.debug(`Found actions: ${this.actions.map((a) => normalizeAction(a.name))}`);

        for (const responseAction of actions) {
          span.addEvent(`processing_action_${responseAction}`);
          state = await this.composeState(message, ['RECENT_MESSAGES']);

          this.logger.debug(`Success: Calling action: ${responseAction}`);
          const normalizedResponseAction = normalizeAction(responseAction);
          let action = this.actions.find(
            (a: { name: string }) =>
              normalizeAction(a.name).includes(normalizedResponseAction) ||
              normalizedResponseAction.includes(normalizeAction(a.name))
          );
          if (action) {
            span.addEvent(`found_exact_action_${action.name}`);
            this.logger.debug(`Success: Found action: ${action?.name}`);
          } else {
            span.addEvent('looking_for_similar_action');
            this.logger.debug('Attempting to find action in similes.');
            for (const _action of this.actions) {
              const simileAction = _action.similes?.find(
                (simile) =>
                  simile.toLowerCase().replace('_', '').includes(normalizedResponseAction) ||
                  normalizedResponseAction.includes(simile.toLowerCase().replace('_', ''))
              );
              if (simileAction) {
                action = _action;
                span.addEvent(`found_similar_action_${action.name}`);
                this.logger.debug(`Success: Action found in similes: ${action.name}`);
                break;
              }
            }
          }
          if (!action) {
            const errorMsg = `No action found for: ${responseAction}`;
            span.addEvent('action_not_found');
            span.setAttributes({
              'error.action': responseAction,
            });
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
            span.addEvent('action_has_no_handler');
            span.setAttributes({
              'error.action': action.name,
            });
            this.logger.error(`Action ${action.name} has no handler.`);
            continue;
          }
          try {
            span.addEvent(`executing_action_${action.name}`);
            this.logger.debug(`Executing handler for action: ${action.name}`);

            // Wrap individual action handler invocation in its own span
            await this.startSpan(`Action.${action.name}`, async (actionSpan) => {
              actionSpan.setAttributes({
                'action.name': action.name,
                'parent_span.id': span.spanContext().spanId,
              });
              actionSpan.addEvent('action.input', {
                'message.id': message.id,
                'state.keys': state ? JSON.stringify(Object.keys(state.values)) : 'none',
                options: JSON.stringify({}),
                'responses.count': responses?.length ?? 0,
                'responses.ids': JSON.stringify(responses?.map((r) => r.id) ?? []),
              });
              try {
                const result = await action.handler(this, message, state, {}, callback, responses);
                actionSpan.addEvent('action.output', {
                  status: 'success',
                  result: JSON.stringify(result, safeReplacer()),
                });
                actionSpan.setStatus({ code: SpanStatusCode.OK });
              } catch (handlerError: any) {
                console.error('action error', handlerError);
                const handlerErrorMessage =
                  handlerError instanceof Error ? handlerError.message : String(handlerError);
                actionSpan.recordException(handlerError as Error);
                actionSpan.setStatus({ code: SpanStatusCode.ERROR, message: handlerErrorMessage });
                actionSpan.setAttributes({
                  'error.message': handlerErrorMessage,
                });
                actionSpan.addEvent('action.output', {
                  status: 'error',
                  error: handlerErrorMessage,
                });
                const actionMemory: Memory = {
                  id: uuidv4() as UUID,
                  entityId: message.entityId,
                  roomId: message.roomId,
                  worldId: message.worldId,
                  content: {
                    thought: handlerErrorMessage,
                    source: 'auto',
                  },
                };
                await this.createMemory(actionMemory, 'messages');
                throw handlerError;
              }
            });
            span.addEvent(`action_executed_successfully_${action.name}`);
            this.logger.debug(`Success: Action ${action.name} executed successfully.`);

            // log to database
            this.adapter.log({
              entityId: message.entityId,
              roomId: message.roomId,
              type: 'action',
              body: {
                action: action.name,
                message: message.content.text,
                messageId: message.id,
                state,
                responses,
              },
            });
          } catch (error: any) {
            const errorMessage = error instanceof Error ? error.message : String(error);
            span.recordException(error as Error);
            span.setStatus({
              code: SpanStatusCode.ERROR,
              message: errorMessage,
            });
            span.setAttributes({
              'error.action': action.name,
              'error.message': errorMessage,
            });
            this.logger.error(error);

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
            throw error;
          }
        }
      }
    });
  }

  async evaluate(
    message: Memory,
    state: State,
    didRespond?: boolean,
    callback?: HandlerCallback,
    responses?: Memory[]
  ) {
    return this.startSpan('AgentRuntime.evaluate', async (span) => {
      span.setAttributes({
        'agent.id': this.agentId,
        'character.name': this.character?.name,
        'message.id': message?.id,
        'room.id': message?.roomId,
        'entity.id': message?.entityId,
        did_respond: didRespond,
        responses_count: responses?.length || 0,
      });
      span.addEvent('evaluation_started');
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
      span.setAttribute('selected_evaluators_count', evaluators.length);
      span.addEvent('evaluator_selection_complete', {
        'evaluator.names': JSON.stringify(evaluators.map((e) => e.name)),
      });
      if (evaluators.length === 0) {
        span.addEvent('no_evaluators_selected');
        return [];
      }
      state = await this.composeState(message, ['RECENT_MESSAGES', 'EVALUATORS']);
      span.addEvent('evaluator_execution_start');
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
      span.addEvent('evaluator_execution_complete');
      span.addEvent('evaluation_complete');
      return evaluators;
    });
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
      worldId = createUniqueUuid(this.agentId + serverId, serverId);
    }
    const names = [name, userName].filter(Boolean);
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
          names: [...new Set([...(entity.names || []), ...names])].filter(Boolean) as string[],
          metadata: {
            ...entity.metadata,
            [source!]: {
              ...entity.metadata?.[source!],
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
        name: name,
        source,
        type,
        channelId,
        serverId,
        worldId,
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
    return this.startSpan('AgentRuntime.composeState', async (span) => {
      span.setAttributes({
        'message.id': message.id,
        'agent.id': this.agentId,
        filter_list: filterList ? JSON.stringify(filterList) : 'none',
        include_list: includeList ? JSON.stringify(includeList) : 'none',
      });
      span.addEvent('state_composition_started');
      const emptyObj = {
        values: {},
        data: {},
        text: '',
      } as State;
      const cachedState = skipCache
        ? emptyObj
        : (await this.stateCache.get(message.id)) || emptyObj;
      const existingProviderNames = cachedState.data.providers
        ? Object.keys(cachedState.data.providers)
        : [];
      span.setAttributes({
        cached_state_exists: !!cachedState.data.providers,
        existing_providers_count: existingProviderNames.length,
        existing_providers: JSON.stringify(existingProviderNames),
      });
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
      const providerNamesToGet = providersToGet.map((p) => p.name);
      span.setAttributes({
        providers_to_get_count: providersToGet.length,
        providers_to_get: JSON.stringify(providerNamesToGet),
      });
      span.addEvent('starting_provider_fetch');
      const providerData = await Promise.all(
        providersToGet.map(async (provider) => {
          return this.startSpan(`provider.${provider.name}`, async (providerSpan) => {
            const start = Date.now();
            try {
              const result = await provider.get(this, message, cachedState);
              const duration = Date.now() - start;
              providerSpan.setAttributes({
                'provider.name': provider.name,
                'provider.duration_ms': duration,
                'result.has_text': !!result.text,
                'result.values_keys': result.values
                  ? JSON.stringify(Object.keys(result.values))
                  : '[]',
              });
              providerSpan.addEvent('provider_fetch_complete');

              this.logger.debug(`${provider.name} Provider took ${duration}ms to respond`);
              return {
                ...result,
                providerName: provider.name,
              };
            } catch (error: any) {
              console.error('provider error', provider.name, error);
              const duration = Date.now() - start;
              const errorMessage = error instanceof Error ? error.message : String(error);
              providerSpan.recordException(error as Error);
              providerSpan.setStatus({ code: SpanStatusCode.ERROR, message: errorMessage });
              providerSpan.setAttributes({
                'provider.name': provider.name,
                'provider.duration_ms': duration,
                'error.message': errorMessage,
              });
              providerSpan.addEvent('provider_fetch_error');
              return { values: {}, text: '', data: {}, providerName: provider.name };
            }
          });
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
          if (
            providerResult &&
            providerResult.values &&
            typeof providerResult.values === 'object'
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
      this.stateCache.set(message.id, newState);
      const finalProviderCount = Object.keys(currentProviderResults).length;
      const finalProviderNames = Object.keys(currentProviderResults);
      const finalValueKeys = Object.keys(newState.values);
      span.setAttributes({
        'context.sources.provider_count': finalProviderCount,
        'context.sources.provider_names': JSON.stringify(finalProviderNames),
        'context.state.value_keys': JSON.stringify(finalValueKeys),
        'context.state.text_length': providersText.length,
        'context.sources.used_memory': finalProviderNames.includes('RECENT_MESSAGES'),
        'context.sources.used_knowledge': finalProviderNames.includes('KNOWLEDGE'),
        'context.sources.used_character': finalProviderNames.includes('CHARACTER'),
        'context.sources.used_actions': finalProviderNames.includes('ACTIONS'),
        'context.sources.used_facts': finalProviderNames.includes('FACTS'),
      });
      span.addEvent('context.composed', {
        'context.final_string':
          providersText.length > 1000 ? providersText.substring(0, 997) + '...' : providersText,
        'context.final_length': providersText.length,
      });
      span.addEvent('state_composition_complete');
      return newState;
    });
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

  async registerService(serviceDef: typeof Service): Promise<void> {
    return this.startSpan('AgentRuntime.registerService', async (span) => {
      const serviceType = serviceDef.serviceType as ServiceTypeName;
      span.setAttributes({
        'service.type': serviceType || 'unknown',
        'agent.id': this.agentId,
      });
      if (!serviceType) {
        span.addEvent('service_missing_type');
        this.logger.warn(
          `Service ${serviceDef.name} is missing serviceType. Please define a static serviceType property.`
        );
        return;
      }
      this.logger.debug(
        `${this.character.name}(${this.agentId}) - Registering service:`,
        serviceType
      );
      if (this.services.has(serviceType)) {
        span.addEvent('service_already_registered');
        this.logger.warn(
          `${this.character.name}(${this.agentId}) - Service ${serviceType} is already registered. Skipping registration.`
        );
        return;
      }
      try {
        span.addEvent('starting_service');
        const serviceInstance = await serviceDef.start(this);
        this.services.set(serviceType, serviceInstance);
        this.serviceTypes.set(serviceType, serviceDef);
        if (typeof (serviceDef as any).registerSendHandlers === 'function') {
          (serviceDef as any).registerSendHandlers(this, serviceInstance);
        }
        span.addEvent('service_registered');
        this.logger.debug(
          `${this.character.name}(${this.agentId}) - Service ${serviceType} registered successfully`
        );
      } catch (error: any) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        span.recordException(error as Error);
        span.setStatus({
          code: SpanStatusCode.ERROR,
          message: errorMessage,
        });
        this.logger.error(
          `${this.character.name}(${this.agentId}) - Failed to register service ${serviceType}: ${errorMessage}`
        );
        throw error;
      }
    });
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
    this.models.get(modelKey)?.sort((a, b) => {
      if ((b.priority || 0) !== (a.priority || 0)) {
        return (b.priority || 0) - (a.priority || 0);
      }
      return a.registrationOrder - b.registrationOrder;
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
    return this.startSpan(`AgentRuntime.useModel.${modelType}`, async (span) => {
      const modelKey = typeof modelType === 'string' ? modelType : ModelType[modelType];
      const promptContent =
        params?.prompt ||
        params?.input ||
        (Array.isArray(params?.messages) ? JSON.stringify(params.messages) : null);
      span.setAttributes({
        'llm.request.model': modelKey,
        'agent.id': this.agentId,
        'llm.request.temperature': params?.temperature,
        'llm.request.top_p': params?.top_p,
        'llm.request.max_tokens': params?.max_tokens || params?.max_tokens_to_sample,
      });
      span.addEvent('model_parameters', { params: JSON.stringify(params, safeReplacer()) });
      if (promptContent) {
        span.addEvent('llm.prompt', { 'prompt.content': promptContent });
      }
      const model = this.getModel(modelKey, provider);
      if (!model) {
        const errorMsg = `No handler found for delegate type: ${modelKey}`;
        span.setStatus({ code: SpanStatusCode.ERROR, message: errorMsg });
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
      span.addEvent('model_execution_start');
      try {
        const response = await model(this, paramsWithRuntime);
        const elapsedTime = performance.now() - startTime;
        span.setAttributes({
          'llm.duration_ms': elapsedTime,
          'llm.usage.prompt_tokens': (response as any)?.usage?.prompt_tokens,
          'llm.usage.completion_tokens': (response as any)?.usage?.completion_tokens,
          'llm.usage.total_tokens': (response as any)?.usage?.total_tokens,
        });

        // Log response as event
        span.addEvent('model_response', { response: JSON.stringify(response, safeReplacer()) }); // Log processed response

        // Log timing / response (keep debug log if useful)
        this.logger.debug(
          `[useModel] ${modelKey} output (took ${Number(elapsedTime.toFixed(2)).toLocaleString()}ms):`,
          Array.isArray(response)
            ? `${JSON.stringify(response.slice(0, 5))}...${JSON.stringify(response.slice(-5))} (${
                response.length
              } items)`
            : JSON.stringify(response, safeReplacer(), 2).replace(/\\n/g, '\n')
        );
        this.adapter.log({
          entityId: this.agentId,
          roomId: this.agentId,
          body: {
            modelType,
            modelKey,
            params: params
              ? typeof params === 'object'
                ? Object.keys(params)
                : typeof params
              : null,
            response:
              Array.isArray(response) && response.every((x) => typeof x === 'number')
                ? '[array]'
                : response,
          },
          type: `useModel:${modelKey}`,
        });
        span.addEvent('model_execution_complete');
        span.setStatus({ code: SpanStatusCode.OK });
        return response as R;
      } catch (error: any) {
        const errorTime = performance.now() - startTime;
        const errorMessage = error instanceof Error ? error.message : String(error);
        span.recordException(error as Error);
        span.setStatus({
          code: SpanStatusCode.ERROR,
          message: errorMessage,
        });
        span.setAttributes({
          'error.time_ms': errorTime,
          'error.message': errorMessage,
        });
        span.addEvent('model_execution_error');
        throw error;
      }
    });
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
      const isMessageReceivedEvent = eventName === EventType.MESSAGE_RECEIVED;
      const instrumentationEnabled = this.instrumentationService?.isEnabled?.() && this.tracer;
      const eventHandlers = this.events.get(eventName);
      if (!eventHandlers) {
        continue;
      }
      if (isMessageReceivedEvent && instrumentationEnabled) {
        const message = (params as MessagePayload)?.message;
        const rootSpan = this.tracer.startSpan('AgentRuntime.handleMessageEvent', {
          attributes: {
            'agent.id': this.agentId,
            'character.name': this.character?.name,
            'room.id': message?.roomId || 'unknown',
            'user.id': message?.entityId || 'unknown',
            'message.id': message?.id || 'unknown',
            'event.name': eventName,
          },
        });
        const spanContext = trace.setSpan(context.active(), rootSpan);
        try {
          rootSpan.addEvent('processing_started');
          await context.with(spanContext, async () => {
            await Promise.all(
              eventHandlers.map((handler) => {
                const ctx = context.active();
                return context.with(ctx, () => handler(params));
              })
            );
          });
          rootSpan.setStatus({ code: SpanStatusCode.OK });
        } catch (error) {
          this.logger.error(
            `Error during instrumented handler execution for event ${eventName}:`,
            error
          );
          rootSpan.recordException(error as Error);
          rootSpan.setStatus({ code: SpanStatusCode.ERROR, message: (error as Error).message });
        } finally {
          rootSpan.addEvent('processing_ended');
          rootSpan.end();
        }
      } else {
        try {
          await Promise.all(eventHandlers.map((handler) => handler(params)));
        } catch (error) {
          this.logger.error(`Error during emitEvent for ${eventName} (handler execution):`, error);
          // throw error; // Re-throw if necessary
        }
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
    return await this.adapter.ensureAgentExists(agent);
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
  async getRoom(roomId: UUID): Promise<Room | null> {
    const rooms = await this.adapter.getRoomsByIds([roomId]);
    if (!rooms?.length) return null;
    return rooms[0];
  }

  async getRoomsByIds(roomIds: UUID[]): Promise<Room[] | null> {
    return await this.adapter.getRoomsByIds(roomIds);
  }
  async createRoom({ id, name, source, type, channelId, serverId, worldId }: Room): Promise<UUID> {
    if (!worldId) throw new Error('worldId is required');
    const res = await this.adapter.createRooms([
      {
        id,
        name,
        source,
        type,
        channelId,
        serverId,
        worldId,
      },
    ]);
    if (!res.length) return null;
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
    return this.startSpan('AgentRuntime.sendMessageToTarget', async (span) => {
      span.setAttributes({
        'message.target.source': target.source,
        'message.target.roomId': target.roomId,
        'message.target.channelId': target.channelId,
        'message.target.serverId': target.serverId,
        'message.target.entityId': target.entityId,
        'message.target.threadId': target.threadId,
        'agent.id': this.agentId,
      });
      const handler = this.sendHandlers.get(target.source);
      if (!handler) {
        const errorMsg = `No send handler registered for source: ${target.source}`;
        span.setStatus({ code: SpanStatusCode.ERROR, message: errorMsg });
        this.logger.error(errorMsg);
        // Optionally throw or just log the error
        throw new Error(errorMsg);
      }
      try {
        span.addEvent('executing_send_handler');
        await handler(this, target, content);
        span.addEvent('send_handler_executed');
        span.setStatus({ code: SpanStatusCode.OK });
      } catch (error: any) {
        const errorMsg = error instanceof Error ? error.message : String(error);
        span.recordException(error as Error);
        span.setStatus({ code: SpanStatusCode.ERROR, message: errorMsg });
        this.logger.error(`Error executing send handler for source ${target.source}:`, error);
        throw error; // Re-throw error after logging and tracing
      }
    });
  }
  async getMemoriesByWorldId(params: {
    worldId: UUID;
    count?: number;
    tableName?: string;
  }): Promise<Memory[]> {
    return await this.adapter.getMemoriesByWorldId(params);
  }
}
