import { v4 as uuidv4 } from 'uuid';
import { createUniqueUuid } from './entities';
import { decryptSecret, getSalt, safeReplacer } from './index';
import logger from './logger';
import { splitChunks } from './prompts';
import { ChannelType, MemoryType, ModelType } from './types';
import { InstrumentationService } from './instrumentation/service';
import {
  type Context,
  SpanStatusCode,
  trace,
  SpanStatus,
  type Span,
  context,
} from '@opentelemetry/api';

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
  KnowledgeItem,
  Log,
  Memory,
  MemoryMetadata,
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
  Service,
  ServiceTypeName,
  State,
  Task,
  TaskWorker,
  UUID,
  World,
} from './types';
import { stringToUuid } from './uuid';
import { EventType, type MessagePayload } from './types';

/**
 * Represents a collection of settings grouped by namespace.
 *
 * @typedef {Object} NamespacedSettings
 * @property {RuntimeSettings} namespace - The namespace key and corresponding RuntimeSettings value.
 */

/**
 * Initialize an empty object for storing environment settings.
 */
const environmentSettings: RuntimeSettings = {};

// Semaphore implementation for controlling concurrent operations
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

/**
 * Represents the runtime environment for an agent, handling message processing,
 * action registration, and interaction with external services like OpenAI and Supabase.
 */
/**
 * Represents the runtime environment for an agent.
 * @class
 * @implements { IAgentRuntime }
 * @property { number } #conversationLength - The maximum length of a conversation.
 * @property { UUID } agentId - The unique identifier for the agent.
 * @property { Character } character - The character associated with the agent.
 * @property { IDatabaseAdapter } adapter - The adapter for interacting with the database.
 * @property {Action[]} actions - The list of actions available to the agent.
 * @property {Evaluator[]} evaluators - The list of evaluators for decision making.
 * @property {Provider[]} providers - The list of providers for external services.
 * @property {Plugin[]} plugins - The list of plugins to extend functionality.
 */
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
  models = new Map<string, Array<(runtime: IAgentRuntime, params: any) => Promise<any>>>();
  routes: Route[] = [];

  private taskWorkers = new Map<string, TaskWorker>();

  // Event emitter methods
  private eventHandlers: Map<string, ((data: any) => void)[]> = new Map();

  private runtimeLogger;
  private knowledgeProcessingSemaphore = new Semaphore(10);
  private settings: RuntimeSettings;

  private servicesInitQueue = new Set<typeof Service>();

  // Add instrumentation properties
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
  }) {
    // use the character id if it exists, otherwise use the agentId if it is passed in, otherwise use the character name
    this.agentId =
      opts.character?.id ?? opts?.agentId ?? stringToUuid(opts.character?.name ?? uuidv4());
    this.character = opts.character;

    // Get log level from environment or default to info
    const logLevel = process.env.LOG_LEVEL || 'info';

    // Create the logger with appropriate level - only show debug logs when explicitly configured
    this.runtimeLogger = logger.child({
      agentName: this.character?.name,
      agentId: this.agentId,
      level: logLevel === 'debug' ? 'debug' : 'error', // Show only errors unless debug mode is enabled
    });

    this.runtimeLogger.debug(`[AgentRuntime] Process working directory: ${process.cwd()}`);

    this.#conversationLength = opts.conversationLength ?? this.#conversationLength;

    if (opts.adapter) {
      this.registerDatabaseAdapter(opts.adapter);
    }

    this.fetch = (opts.fetch as typeof fetch) ?? this.fetch;

    this.settings = opts.settings ?? environmentSettings;

    // Register plugins from options or empty array
    const plugins = opts?.plugins ?? [];

    // Store plugins in the array but don't initialize them yet
    this.plugins = plugins;

    // Initialize instrumentation service with appropriate configuration
    try {
      // Create instrumentation service with agent info
      this.instrumentationService = new InstrumentationService({
        serviceName: `agent-${this.character?.name || 'unknown'}-${this.agentId}`,
        enabled: process.env.INSTRUMENTATION_ENABLED === 'true',
      });

      // Get a tracer for the runtime
      this.tracer = this.instrumentationService.getTracer('agent-runtime');

      this.runtimeLogger.debug(`Instrumentation service initialized for agent ${this.agentId}`);
    } catch (error) {
      // If instrumentation fails, provide a fallback implementation
      this.runtimeLogger.warn(`Failed to initialize instrumentation: ${error.message}`);
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

    this.runtimeLogger.debug(`Success: Agent ID: ${this.agentId}`);
  }

  /**
   * Starts a span for the given operation and executes the provided function with the span.
   * @param name The name of the span to create
   * @param fn The function to execute with the span
   * @param parentContext Optional parent context for the span
   * @returns The result of the provided function
   */
  async startSpan<T>(
    name: string,
    fn: (span: Span) => Promise<T>,
    parentContext?: Context
  ): Promise<T> {
    // If instrumentation is disabled, create a mock span with no-op methods
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

    // Otherwise, use the real tracer to create a span
    return this.tracer.startActiveSpan(name, parentContext, undefined, async (span: Span) => {
      try {
        // Set default attributes for all spans
        span.setAttributes({
          'agent.id': this.agentId,
          'agent.name': this.character?.name || 'unknown',
        });

        // Call the function with the span
        const result = await fn(span);

        // End the span with successful status
        span.setStatus({ code: SpanStatusCode.OK });
        span.end();

        return result;
      } catch (error) {
        // If an error occurs, record it and set error status
        span.recordException(error as Error);
        span.setStatus({
          code: SpanStatusCode.ERROR,
          message: (error as Error).message,
        });
        span.end();

        // Rethrow the error
        throw error;
      }
    });
  }

  /**
   * Ends a span with the provided name in the given context
   * @param ctx Context containing the span to end
   * @param name Name to record in the end event
   */
  endSpan(ctx: Context | undefined, name: string): void {
    // This is a no-op method for compatibility
    // Actual span ending is handled in startSpan
  }

  /**
   * Start an active span that can be used as a parent for other spans
   * @param name Name of the span
   * @param options Span options
   */
  startActiveSpan(name: string, options: any = {}): Span {
    if (!this.instrumentationService?.isEnabled?.() || !this.tracer) {
      // Return mock span if instrumentation is disabled
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

    // Create real span if instrumentation is enabled
    return this.tracer.startSpan(name, options);
  }

  /**
   * Registers a plugin with the runtime and initializes its components
   * @param plugin The plugin to register
   */
  async registerPlugin(plugin: Plugin): Promise<void> {
    return this.startSpan('AgentRuntime.registerPlugin', async (span) => {
      span.setAttributes({
        'plugin.name': plugin?.name || 'unknown',
        'agent.id': this.agentId,
      });

      if (!plugin) {
        span.setStatus({ code: SpanStatusCode.ERROR, message: 'Plugin is undefined' });
        this.runtimeLogger.error('*** registerPlugin plugin is undefined');
        throw new Error('*** registerPlugin plugin is undefined');
      }

      // Add to plugins array if not already present - but only if it was not passed there initially
      // (otherwise we can't add to readonly array)
      if (!this.plugins.some((p) => p.name === plugin.name)) {
        // Push to plugins array - this works because we're modifying the array, not reassigning it
        this.plugins.push(plugin);
        span.addEvent('plugin_added_to_array');
        this.runtimeLogger.debug(`Success: Plugin ${plugin.name} registered successfully`);
      }

      // Initialize the plugin if it has an init function
      if (plugin.init) {
        try {
          span.addEvent('initializing_plugin');
          await plugin.init(plugin.config || {}, this);
          span.addEvent('plugin_initialized');
          this.runtimeLogger.debug(`Success: Plugin ${plugin.name} initialized successfully`);
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
            // Instead of throwing an error, log a friendly message
            console.warn(`Plugin ${plugin.name} requires configuration. ${errorMessage}`);
            console.warn(
              'Please check your environment variables and ensure all required API keys are set.'
            );
            console.warn('You can set these in your .eliza/.env file.');
            span.addEvent('plugin_configuration_warning');
            // We don't throw here, allowing the application to continue
            // with reduced functionality
          } else {
            // For other types of errors, rethrow
            span.setStatus({ code: SpanStatusCode.ERROR, message: errorMessage });
            throw error;
          }
        }
      }

      // Register plugin adapter
      if (plugin.adapter) {
        span.addEvent('registering_adapter');
        this.runtimeLogger.debug(`Registering database adapter for plugin ${plugin.name}`);
        this.registerDatabaseAdapter(plugin.adapter);
      }

      // Register plugin actions
      if (plugin.actions) {
        span.addEvent('registering_actions');
        for (const action of plugin.actions) {
          this.registerAction(action);
        }
      }

      // Register plugin evaluators
      if (plugin.evaluators) {
        span.addEvent('registering_evaluators');
        for (const evaluator of plugin.evaluators) {
          this.registerEvaluator(evaluator);
        }
      }

      // Register plugin providers
      if (plugin.providers) {
        span.addEvent('registering_providers');
        for (const provider of plugin.providers) {
          this.registerContextProvider(provider);
        }
      }

      // Register plugin models
      if (plugin.models) {
        span.addEvent('registering_models');
        for (const [modelType, handler] of Object.entries(plugin.models)) {
          this.registerModel(modelType as ModelTypeName, handler as (params: any) => Promise<any>);
        }
      }

      // Register plugin routes
      if (plugin.routes) {
        span.addEvent('registering_routes');
        for (const route of plugin.routes) {
          this.routes.push(route);
        }
      }

      // Register plugin events
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

  getAllServices(): Map<ServiceTypeName, Service> {
    return this.services;
  }

  async stop() {
    return this.startSpan('AgentRuntime.stop', async (span) => {
      span.setAttributes({
        'agent.id': this.agentId,
        'agent.name': this.character?.name || 'unknown',
      });

      this.runtimeLogger.debug(`runtime::stop - character ${this.character.name}`);
      span.addEvent('stopping_services');

      // Stop all registered clients
      for (const [serviceName, service] of this.services) {
        this.runtimeLogger.debug(`runtime::stop - requesting service stop for ${serviceName}`);
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
        this.runtimeLogger.warn('Agent already initialized');
        return;
      }

      span.addEvent('initialization_started');

      // Track registered plugins to avoid duplicates
      const registeredPluginNames = new Set<string>();

      // Load and register plugins from character configuration
      const pluginRegistrationPromises = [];

      // Register plugins that were provided in the constructor
      for (const plugin of [...this.plugins]) {
        if (plugin && !registeredPluginNames.has(plugin.name)) {
          registeredPluginNames.add(plugin.name);
          pluginRegistrationPromises.push(await this.registerPlugin(plugin));
        }
      }

      span.addEvent('plugins_setup');
      span.setAttributes({
        registered_plugins: Array.from(registeredPluginNames).join(','),
      });

      // Ensure adapter is initialized
      if (!this.adapter) {
        this.runtimeLogger.error(
          'Database adapter not initialized. Make sure @elizaos/plugin-sql is included in your plugins.'
        );
        throw new Error(
          'Database adapter not initialized. The SQL plugin (@elizaos/plugin-sql) is required for agent initialization. Please ensure it is included in your character configuration.'
        );
      }

      try {
        await this.adapter.init();
        span.addEvent('adapter_initialized');

        // First create the agent entity directly
        // Ensure agent exists first (this is critical for test mode)
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
        let agentEntity = await this.adapter.getEntityById(this.agentId);

        if (!agentEntity) {
          span.addEvent('creating_agent_entity');
          const created = await this.createEntity({
            id: this.agentId,
            agentId: existingAgent.id,
            names: Array.from(new Set([this.character.name].filter(Boolean))) as string[],
            metadata: {},
          });

          if (!created) {
            const errorMsg = `Failed to create entity for agent ${this.agentId}`;
            span.setStatus({ code: SpanStatusCode.ERROR, message: errorMsg });
            throw new Error(errorMsg);
          }

          agentEntity = await this.adapter.getEntityById(this.agentId);
          if (!agentEntity) throw new Error(`Agent entity not found for ${this.agentId}`);

          this.runtimeLogger.debug(
            `Success: Agent entity created successfully for ${this.character.name}`
          );
          span.addEvent('agent_entity_created');
        } else {
          span.addEvent('agent_entity_exists');
        }
      } catch (error) {
        const errorMsg = error instanceof Error ? error.message : String(error);
        span.recordException(error as Error);
        span.setStatus({ code: SpanStatusCode.ERROR, message: errorMsg });
        this.runtimeLogger.error(`Failed to create agent entity: ${errorMsg}`);
        throw error;
      }

      // Create room for the agent and register all plugins in parallel
      try {
        span.addEvent('creating_room_and_registering_plugins');
        await Promise.all([
          this.ensureRoomExists({
            id: this.agentId,
            name: this.character.name,
            source: 'self',
            type: ChannelType.SELF,
          }),
          ...pluginRegistrationPromises,
        ]);
        span.addEvent('room_created_and_plugins_registered');
      } catch (error) {
        const errorMsg = error instanceof Error ? error.message : String(error);
        span.recordException(error as Error);
        span.setStatus({ code: SpanStatusCode.ERROR, message: errorMsg });
        this.runtimeLogger.error(`Failed to initialize: ${errorMsg}`);
        throw error;
      }

      // Add agent as participant in its own room
      try {
        span.addEvent('adding_agent_as_participant');
        // No need to transform agent ID
        const participants = await this.adapter.getParticipantsForRoom(this.agentId);
        if (!participants.includes(this.agentId)) {
          const added = await this.adapter.addParticipant(this.agentId, this.agentId);
          if (!added) {
            const errorMsg = `Failed to add agent ${this.agentId} as participant to its own room`;
            span.setStatus({ code: SpanStatusCode.ERROR, message: errorMsg });
            throw new Error(errorMsg);
          }
          this.runtimeLogger.debug(
            `Agent ${this.character.name} linked to its own room successfully`
          );
          span.addEvent('agent_added_as_participant');
        } else {
          span.addEvent('agent_already_participant');
        }
      } catch (error) {
        const errorMsg = error instanceof Error ? error.message : String(error);
        span.recordException(error as Error);
        span.setStatus({ code: SpanStatusCode.ERROR, message: errorMsg });
        this.runtimeLogger.error(`Failed to add agent as participant: ${errorMsg}`);
        throw error;
      }

      // Check if TEXT_EMBEDDING model is registered
      const embeddingModel = this.getModel(ModelType.TEXT_EMBEDDING);
      if (!embeddingModel) {
        span.addEvent('embedding_model_missing');
        this.runtimeLogger.warn(
          `[AgentRuntime][${this.character.name}] No TEXT_EMBEDDING model registered. Skipping embedding dimension setup.`
        );
      } else {
        // Only run ensureEmbeddingDimension if we have an embedding model
        span.addEvent('setting_up_embedding_dimension');
        await this.ensureEmbeddingDimension();
        span.addEvent('embedding_dimension_setup_complete');
      }

      // Process character knowledge
      if (this.character?.knowledge && this.character.knowledge.length > 0) {
        span.addEvent('processing_character_knowledge');
        span.setAttributes({
          'knowledge.count': this.character.knowledge.length,
        });

        const stringKnowledge = this.character.knowledge.filter(
          (item): item is string => typeof item === 'string'
        );
        await this.processCharacterKnowledge(stringKnowledge);
        span.addEvent('character_knowledge_processed');
      }

      // Start all deferred services now that runtime is ready
      span.addEvent('starting_deferred_services');
      span.setAttributes({
        'deferred_services.count': this.servicesInitQueue.size,
      });

      for (const service of this.servicesInitQueue) {
        await this.registerService(service);
      }

      span.addEvent('initialization_completed');
    });
  }

  private async handleProcessingError(error: any, context: string) {
    this.runtimeLogger.error(`Error ${context}:`, error?.message || error || 'Unknown error');
    throw error;
  }

  private async checkExistingKnowledge(knowledgeId: UUID): Promise<boolean> {
    const existingDocument = await this.getMemoryById(knowledgeId);
    return !!existingDocument;
  }

  async getKnowledge(message: Memory): Promise<KnowledgeItem[]> {
    return this.startSpan('AgentRuntime.getKnowledge', async (span) => {
      // Add validation for message
      if (!message?.content?.text) {
        span.addEvent('invalid_message');
        span.setStatus({
          code: SpanStatusCode.ERROR,
          message: 'Invalid message for knowledge query',
        });
        this.runtimeLogger.warn('Invalid message for knowledge query:', {
          message,
          content: message?.content,
          text: message?.content?.text,
        });
        return [];
      }

      // Validate processed text
      if (!message?.content?.text || message?.content?.text.trim().length === 0) {
        span.addEvent('empty_text');
        span.setStatus({
          code: SpanStatusCode.ERROR,
          message: 'Empty text for knowledge query',
        });
        this.runtimeLogger.warn('Empty text for knowledge query');
        return [];
      }

      span.setAttributes({
        'message.id': message.id,
        'query.length': message.content.text.length,
        'agent.id': this.agentId,
      });

      span.addEvent('generating_embedding');
      const embedding = await this.useModel(ModelType.TEXT_EMBEDDING, {
        text: message?.content?.text,
      });

      span.addEvent('searching_memories');
      span.setAttributes({
        'embedding.length': embedding.length,
      });

      const fragments = await this.searchMemories({
        tableName: 'knowledge',
        embedding,
        roomId: message.agentId,
        count: 5,
        match_threshold: 0.1,
      });

      span.addEvent('knowledge_retrieved');
      span.setAttributes({
        'fragments.count': fragments.length,
      });

      // Return the fragments directly as this is used from prompts.
      // Example usage in prompts: # provider KNOWLEDGE
      return fragments.map((fragment) => ({
        id: fragment.id,
        content: fragment.content,
        similarity: fragment.similarity,
        metadata: fragment.metadata,
      }));
    });
  }

  async addKnowledge(
    item: KnowledgeItem,
    options = {
      targetTokens: 1500,
      overlap: 200,
      modelContextSize: 4096,
    }
  ) {
    return this.startSpan('AgentRuntime.addKnowledge', async (span) => {
      span.setAttributes({
        'item.id': item.id,
        'agent.id': this.agentId,
        'options.targetTokens': options.targetTokens,
        'options.overlap': options.overlap,
      });

      // First store the document
      const documentMemory: Memory = {
        id: item.id,
        agentId: this.agentId,
        roomId: this.agentId,
        entityId: this.agentId,
        content: item.content,
        metadata: item.metadata || {
          type: MemoryType.DOCUMENT,
          timestamp: Date.now(),
        },
      };

      span.addEvent('storing_document');
      await this.createMemory(documentMemory, 'documents');
      span.addEvent('document_stored');

      // Create fragments using splitChunks
      span.addEvent('splitting_chunks');
      const fragments = await splitChunks(item.content.text, options.targetTokens, options.overlap);
      span.setAttributes({
        'fragments.count': fragments.length,
      });
      span.addEvent('chunks_split');

      // Track progress
      let fragmentsProcessed = 0;

      // Store each fragment with link to source document
      span.addEvent('storing_fragments');
      for (let i = 0; i < fragments.length; i++) {
        try {
          span.addEvent(`generating_embedding_${i}`);
          const embedding = await this.useModel(ModelType.TEXT_EMBEDDING, fragments[i]);

          const fragmentMemory: Memory = {
            id: createUniqueUuid(this, `${item.id}-fragment-${i}`),
            agentId: this.agentId,
            roomId: this.agentId,
            entityId: this.agentId,
            embedding,
            content: { text: fragments[i] },
            metadata: {
              type: MemoryType.FRAGMENT,
              documentId: item.id, // Link to source document
              position: i, // Keep track of order
              timestamp: Date.now(),
            },
          };

          await this.createMemory(fragmentMemory, 'knowledge');
          fragmentsProcessed++;
        } catch (error) {
          const errorMsg = error instanceof Error ? error.message : String(error);
          span.recordException(error as Error);
          span.setAttributes({
            'error.fragment': i,
            'error.message': errorMsg,
          });
          this.runtimeLogger.error(`Error processing fragment ${i}: ${errorMsg}`);
        }
      }

      span.setAttributes({
        'fragments.processed': fragmentsProcessed,
        'fragments.success_rate': fragmentsProcessed / fragments.length,
      });
      span.addEvent('knowledge_processing_complete');
    });
  }

  async processCharacterKnowledge(items: string[]) {
    const processingPromises = items.map(async (item) => {
      await this.knowledgeProcessingSemaphore.acquire();
      try {
        const knowledgeId = createUniqueUuid(this, item);
        if (await this.checkExistingKnowledge(knowledgeId)) {
          return;
        }

        this.runtimeLogger.debug(
          'Processing knowledge for ',
          this.character.name,
          ' - ',
          item.slice(0, 100)
        );

        // Extract metadata from the knowledge item
        let metadata: MemoryMetadata = {
          type: MemoryType.DOCUMENT,
          timestamp: Date.now(),
        };

        const pathMatch = item.match(/^Path: (.+?)(?:\n|\r\n)/);
        if (pathMatch) {
          const filePath = pathMatch[1].trim();
          const extension = filePath.split('.').pop() || '';
          const filename = filePath.split('/').pop() || '';
          const title = filename.replace(`.${extension}`, '');

          metadata = {
            ...metadata,
            path: filePath,
            filename: filename,
            fileExt: extension,
            title: title,
            fileType: `text/${extension || 'plain'}`,
            fileSize: item.length,
            source: 'character',
          };
        }

        await this.addKnowledge({
          id: knowledgeId,
          content: {
            text: item,
          },
          metadata,
        });
      } catch (error) {
        await this.handleProcessingError(error, 'processing character knowledge');
      } finally {
        this.knowledgeProcessingSemaphore.release();
      }
    });

    await Promise.all(processingPromises);
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

  /**
   * Get the number of messages that are kept in the conversation buffer.
   * @returns The number of recent messages to be kept in memory.
   */
  getConversationLength() {
    return this.#conversationLength;
  }

  registerDatabaseAdapter(adapter: IDatabaseAdapter) {
    if (this.adapter) {
      this.runtimeLogger.warn(
        'Database adapter already registered. Additional adapters will be ignored. This may lead to unexpected behavior.'
      );
    } else {
      this.adapter = adapter;
      this.runtimeLogger.debug('Success: Database adapter registered successfully.');
    }
  }

  /**
   * Register a provider for the agent to use.
   * @param provider The provider to register.
   */
  registerProvider(provider: Provider) {
    this.providers.push(provider);
    this.runtimeLogger.debug(`Success: Provider ${provider.name} registered successfully.`);
  }

  /**
   * Register an action for the agent to perform.
   * @param action The action to register.
   */
  registerAction(action: Action) {
    this.runtimeLogger.debug(
      `${this.character.name}(${this.agentId}) - Registering action: ${action.name}`
    );
    // if an action with the same name already exists, throw a warning and don't add the new action
    if (this.actions.find((a) => a.name === action.name)) {
      this.runtimeLogger.warn(
        `${this.character.name}(${this.agentId}) - Action ${action.name} already exists. Skipping registration.`
      );
    } else {
      this.actions.push(action);
      this.runtimeLogger.debug(
        `${this.character.name}(${this.agentId}) - Action ${action.name} registered successfully.`
      );
    }
  }

  /**
   * Register an evaluator to assess and guide the agent's responses.
   * @param evaluator The evaluator to register.
   */
  registerEvaluator(evaluator: Evaluator) {
    this.evaluators.push(evaluator);
  }

  /**
   * Register a context provider to provide context for message generation.
   * @param provider The context provider to register.
   */
  registerContextProvider(provider: Provider) {
    this.providers.push(provider);
  }

  /**
   * Process the actions of a message.
   * @param message The message to process.
   * @param responses The array of response memories to process actions from.
   * @param state Optional state object for the action processing.
   * @param callback Optional callback handler for action results.
   */
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
          this.runtimeLogger.warn('No action found in the response content.');
          continue;
        }

        const actions = response.content.actions;
        span.setAttributes({
          'actions.count': actions.length,
          'actions.names': JSON.stringify(actions),
        });

        function normalizeAction(action: string) {
          return action.toLowerCase().replace('_', '');
        }
        this.runtimeLogger.debug(
          `Found actions: ${this.actions.map((a) => normalizeAction(a.name))}`
        );

        for (const responseAction of actions) {
          span.addEvent(`processing_action_${responseAction}`);
          state = await this.composeState(message, ['RECENT_MESSAGES']);

          this.runtimeLogger.debug(`Success: Calling action: ${responseAction}`);
          const normalizedResponseAction = normalizeAction(responseAction);
          let action = this.actions.find(
            (a: { name: string }) =>
              normalizeAction(a.name).includes(normalizedResponseAction) || // the || is kind of a fuzzy match
              normalizedResponseAction.includes(normalizeAction(a.name)) //
          );

          if (action) {
            span.addEvent(`found_exact_action_${action.name}`);
            this.runtimeLogger.debug(`Success: Found action: ${action?.name}`);
          } else {
            span.addEvent('looking_for_similar_action');
            this.runtimeLogger.debug('Attempting to find action in similes.');
            for (const _action of this.actions) {
              const simileAction = _action.similes?.find(
                (simile) =>
                  simile.toLowerCase().replace('_', '').includes(normalizedResponseAction) ||
                  normalizedResponseAction.includes(simile.toLowerCase().replace('_', ''))
              );
              if (simileAction) {
                action = _action;
                span.addEvent(`found_similar_action_${action.name}`);
                this.runtimeLogger.debug(`Success: Action found in similes: ${action.name}`);
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
            this.runtimeLogger.error(errorMsg);
            continue;
          }

          if (!action.handler) {
            span.addEvent('action_has_no_handler');
            span.setAttributes({
              'error.action': action.name,
            });
            this.runtimeLogger.error(`Action ${action.name} has no handler.`);
            continue;
          }

          try {
            span.addEvent(`executing_action_${action.name}`);
            this.runtimeLogger.debug(`Executing handler for action: ${action.name}`);

            // Wrap individual action handler invocation in its own span
            await this.startSpan(`Action.${action.name}`, async (actionSpan) => {
              actionSpan.setAttributes({
                'action.name': action.name,
                'parent_span.id': span.spanContext().spanId, // Link to parent processActions span
              });

              // Log input parameters (avoid logging potentially large state)
              actionSpan.addEvent('action.input', {
                'message.id': message.id,
                'state.keys': state ? JSON.stringify(Object.keys(state.values)) : 'none',

                options: JSON.stringify({}), // Hardcoded empty options for now
                'responses.count': responses?.length ?? 0,
                'responses.ids': JSON.stringify(responses?.map((r) => r.id) ?? []),
              });

              try {
                // Execute the action handler and capture the result
                const result = await action.handler(this, message, state, {}, callback, responses);

                // Log the result in the output event
                actionSpan.addEvent('action.output', {
                  status: 'success',
                  result: JSON.stringify(result, safeReplacer()), // Log stringified result
                });
                actionSpan.setStatus({ code: SpanStatusCode.OK });
              } catch (handlerError) {
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
                // Re-throw the error to be caught by the outer try/catch
                throw handlerError;
              }
            }); // End of Action.${action.name} span

            span.addEvent(`action_executed_successfully_${action.name}`);
            this.runtimeLogger.debug(`Success: Action ${action.name} executed successfully.`);

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
          } catch (error) {
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
            this.runtimeLogger.error(error);
            throw error;
          }
        }
      }
    });
  }

  /**
   * Evaluate the message and state using the registered evaluators.
   * @param message The message to evaluate.
   * @param state The state of the agent.
   * @param didRespond Whether the agent responded to the message.~
   * @param callback The handler callback
   * @returns The results of the evaluation.
   */
  async evaluate(
    message: Memory,
    state: State,
    didRespond?: boolean,
    callback?: HandlerCallback,
    responses?: Memory[]
  ) {
    // Start root span for evaluation
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

      // get the evaluators that were chosen by the response handler

      if (evaluators.length === 0) {
        span.addEvent('no_evaluators_selected');
        return [];
      }

      // Note: composeState is already instrumented, will be nested automatically
      state = await this.composeState(message, ['RECENT_MESSAGES', 'EVALUATORS']);

      span.addEvent('evaluator_execution_start');
      await Promise.all(
        evaluators.map(async (evaluator) => {
          if (evaluator.handler) {
            // TODO: Instrument individual evaluator handlers if needed (potentially in plugins)
            await evaluator.handler(this, message, state, {}, callback, responses);
            // log to database
            this.adapter.log({
              entityId: message.entityId,
              roomId: message.roomId,
              type: 'evaluator',
              body: {
                evaluator: evaluator.name,
                messageId: message.id,
                message: message.content.text,
                state, // Consider if state should be logged here, can be large
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
    userName,
    name,
    source,
    type,
    channelId,
    serverId,
    worldId,
    userId,
  }: {
    entityId: UUID;
    roomId: UUID;
    userName?: string;
    name?: string;
    source?: string;
    type?: ChannelType;
    channelId?: string;
    serverId?: string;
    worldId?: UUID;
    userId?: UUID;
  }) {
    if (entityId === this.agentId) {
      throw new Error('Agent should not connect to itself');
    }

    if (!worldId && serverId) {
      worldId = createUniqueUuid(this, serverId);
    }

    const names = [name, userName].filter(Boolean);
    const metadata = {
      [source]: {
        id: userId,
        name: name,
        userName: userName,
      },
    };

    // Step 1: Handle entity creation/update with proper error handling
    try {
      // First check if the entity exists
      const entity = await this.adapter.getEntityById(entityId);

      if (!entity) {
        // Try to create the entity
        try {
          const success = await this.adapter.createEntity({
            id: entityId,
            names,
            metadata,
            agentId: this.agentId,
          });

          if (success) {
            this.runtimeLogger.debug(
              `Created new entity ${entityId} for user ${name || userName || 'unknown'}`
            );
          } else {
            throw new Error(`Failed to create entity ${entityId}`);
          }
        } catch (error) {
          // If we get a duplicate key error, the entity exists in the database but isn't
          // associated with this agent - this is expected in multi-agent scenarios
          if (error.message?.includes('duplicate key') || error.code === '23505') {
            this.runtimeLogger.debug(
              `Entity ${entityId} exists in database but not for this agent. This is normal in multi-agent setups.`
            );
          } else {
            // For any other errors, re-throw
            throw error;
          }
        }
      } else {
        // Entity exists for this agent, update if needed
        await this.adapter.updateEntity({
          id: entityId,
          names: [...new Set([...(entity.names || []), ...names])].filter(Boolean),
          metadata: {
            ...entity.metadata,
            [source]: {
              ...entity.metadata?.[source],
              name: name,
              userName: userName,
            },
          },
          agentId: this.agentId,
        });
      }

      // Step 2: Ensure world exists
      if (worldId) {
        await this.ensureWorldExists({
          id: worldId,
          name: serverId ? `World for server ${serverId}` : `World for room ${roomId}`,
          agentId: this.agentId,
          serverId: serverId || 'default',
          metadata,
        });
      }

      // Step 3: Ensure room exists
      await this.ensureRoomExists({
        id: roomId,
        name: name,
        source,
        type,
        channelId,
        serverId,
        worldId,
      });

      // Step 4: Add participants to the room
      // For the user entity, we'll try even if we couldn't retrieve it
      try {
        await this.ensureParticipantInRoom(entityId, roomId);
      } catch (error) {
        // If the normal flow fails because the entity isn't found,
        // try direct participant addition as a clean fallback
        if (error.message?.includes('not found')) {
          const added = await this.adapter.addParticipant(entityId, roomId);
          if (!added) {
            throw new Error(`Failed to add participant ${entityId} to room ${roomId}`);
          }
          this.runtimeLogger.debug(`Added participant ${entityId} to room ${roomId} directly`);
        } else {
          throw error;
        }
      }

      // Always add the agent to the room
      await this.ensureParticipantInRoom(this.agentId, roomId);

      this.runtimeLogger.debug(
        `Success: Successfully connected entity ${entityId} in room ${roomId}`
      );
    } catch (error) {
      this.runtimeLogger.error(
        `Failed to ensure connection: ${error instanceof Error ? error.message : String(error)}`
      );
      throw error;
    }
  }

  /**
   * Ensures a participant is added to a room, checking that the entity exists first
   */
  async ensureParticipantInRoom(entityId: UUID, roomId: UUID) {
    // Make sure entity exists in database before adding as participant
    const entity = await this.adapter.getEntityById(entityId);

    // If entity is not found but it's not the agent itself, we might still want to proceed
    // This can happen when an entity exists in the database but isn't associated with this agent
    if (!entity && entityId !== this.agentId) {
      this.runtimeLogger.warn(
        `Entity ${entityId} not directly accessible to agent ${this.agentId}. Will attempt to add as participant anyway.`
      );
    } else if (!entity) {
      throw new Error(`User ${entityId} not found`);
    }

    // Get current participants
    const participants = await this.adapter.getParticipantsForRoom(roomId);

    // Only add if not already a participant
    if (!participants.includes(entityId)) {
      // Add participant using the ID
      const added = await this.adapter.addParticipant(entityId, roomId);

      if (!added) {
        throw new Error(`Failed to add participant ${entityId} to room ${roomId}`);
      }

      if (entityId === this.agentId) {
        this.runtimeLogger.debug(
          `Agent ${this.character.name} linked to room ${roomId} successfully.`
        );
      } else {
        this.runtimeLogger.debug(`User ${entityId} linked to room ${roomId} successfully.`);
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
    return await this.adapter.addParticipant(entityId, roomId);
  }

  /**
   * Ensure the existence of a world.
   */
  async ensureWorldExists({ id, name, serverId, metadata }: World) {
    // try {
    const world = await this.getWorld(id);
    if (!world) {
      this.runtimeLogger.debug('Creating world:', {
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
      this.runtimeLogger.debug(`World ${id} created successfully.`);
    }
    // } catch (error) {
    //   this.runtimeLogger.error(
    //     `Failed to ensure world exists: ${
    //       error instanceof Error ? error.message : String(error)
    //     }`
    //   );
    //   throw error;
    // }
  }

  /**
   * Ensure the existence of a room between the agent and a user. If no room exists, a new room is created and the user
   * and agent are added as participants. The room ID is returned.
   * @param entityId - The user ID to create a room with.
   * @returns The room ID of the room between the agent and the user.
   * @throws An error if the room cannot be created.
   */
  async ensureRoomExists({ id, name, source, type, channelId, serverId, worldId, metadata }: Room) {
    const room = await this.adapter.getRoom(id);
    if (!room) {
      await this.adapter.createRoom({
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
      this.runtimeLogger.debug(`Room ${id} created successfully.`);
    }
  }

  /**
   * Composes the agent's state by gathering data from enabled providers.
   * @param message - The message to use as context for state composition
   * @param filterList - Optional list of provider names to include, filtering out all others
   * @param includeList - Optional list of private provider names to include that would otherwise be filtered out
   * @returns A State object containing provider data, values, and text
   */
  async composeState(
    message: Memory,
    filterList: string[] | null = null, // only get providers that are in the filterList
    includeList: string[] | null = null // include providers that are private, dynamic or otherwise not included by default
  ): Promise<State> {
    return this.startSpan('AgentRuntime.composeState', async (span) => {
      span.setAttributes({
        'message.id': message.id,
        'agent.id': this.agentId,
        filter_list: filterList ? JSON.stringify(filterList) : 'none', // Use 'none' for clarity
        include_list: includeList ? JSON.stringify(includeList) : 'none', // Use 'none' for clarity
      });
      span.addEvent('state_composition_started');

      // Get cached state for this message ID first
      const cachedState = (await this.stateCache.get(message.id)) || {
        values: {},
        data: {},
        text: '',
      };

      // Get existing provider names from cache (if any)
      const existingProviderNames = cachedState.data.providers
        ? Object.keys(cachedState.data.providers)
        : [];

      span.setAttributes({
        cached_state_exists: !!cachedState.data.providers, // More specific check
        existing_providers_count: existingProviderNames.length,
        existing_providers: JSON.stringify(existingProviderNames), // Add list of existing providers
      });

      // Step 1: Determine base set of providers to fetch
      const providerNames = new Set<string>();

      if (filterList && filterList.length > 0) {
        // If filter list provided, start with just those providers
        filterList.forEach((name) => providerNames.add(name));
      } else {
        // Otherwise, start with all non-private, non-dynamic providers that aren't cached
        this.providers
          .filter((p) => !p.private && !p.dynamic && !existingProviderNames.includes(p.name))
          .forEach((p) => providerNames.add(p.name));
      }

      // Step 2: Always add providers from include list
      if (includeList && includeList.length > 0) {
        includeList.forEach((name) => providerNames.add(name));
      }

      // Get the actual provider objects and sort by position
      const providersToGet = Array.from(
        new Set(this.providers.filter((p) => providerNames.has(p.name)))
      ).sort((a, b) => (a.position || 0) - (b.position || 0));

      const providerNamesToGet = providersToGet.map((p) => p.name);
      span.setAttributes({
        providers_to_get_count: providersToGet.length,
        providers_to_get: JSON.stringify(providerNamesToGet), // Log names as JSON array
      });
      span.addEvent('starting_provider_fetch');

      // Fetch data from selected providers
      const providerData = await Promise.all(
        providersToGet.map(async (provider) => {
          // This creates nested spans for each provider call automatically
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

              this.runtimeLogger.debug(`${provider.name} Provider took ${duration}ms to respond`);
              return {
                ...result,
                providerName: provider.name,
              };
            } catch (error) {
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

              // Return empty result on error
              return { values: {}, text: '', providerName: provider.name };
            }
          });
        })
      );

      // Extract existing provider data from cache
      const existingProviderData = cachedState.data.providers || {};

      // Create a combined provider values structure that preserves all cached data
      // but updates with any newly fetched provider data
      const combinedValues = { ...existingProviderData };

      // Update with newly fetched provider data
      for (const result of providerData) {
        combinedValues[result.providerName] = result.values || {};
      }

      // Collect provider text from newly fetched providers
      const newProvidersText = providerData
        .map((result) => result.text)
        .filter((text) => text !== '')
        .join('\\n');

      // Combine with existing text if available
      let providersText = '';
      if (cachedState.text && newProvidersText) {
        providersText = `${cachedState.text}\\n${newProvidersText}`;
      } else if (newProvidersText) {
        providersText = newProvidersText;
      } else if (cachedState.text) {
        providersText = cachedState.text;
      }

      // Prepare final values
      const values = {
        ...(cachedState.values || {}),
      };

      // Safely merge all provider values
      for (const providerName in combinedValues) {
        const providerValues = combinedValues[providerName];
        if (providerValues && typeof providerValues === 'object') {
          Object.assign(values, providerValues);
        }
      }

      // Assemble and cache the new state
      const newState = {
        values: {
          ...values,
          providers: providersText,
        },
        data: {
          ...(cachedState.data || {}),
          providers: combinedValues,
        },
        text: providersText,
      } as State;

      // Cache the result for future use
      this.stateCache.set(message.id, newState);

      const finalProviderCount = Object.keys(combinedValues).length;
      const finalProviderNames = Object.keys(combinedValues);
      const finalValueKeys = Object.keys(newState.values); // Get keys from the merged state values

      span.setAttributes({
        // Remove original/redundant attributes
        // 'final_state_text_length': providersText.length,
        // 'provider_count_final': finalProviderCount,
        // 'provider_names_final': JSON.stringify(finalProviderNames),

        // Context-specific attributes
        'context.sources.provider_count': finalProviderCount,
        'context.sources.provider_names': JSON.stringify(finalProviderNames),
        'context.state.value_keys': JSON.stringify(finalValueKeys),
        'context.state.text_length': providersText.length,
        // Flags for common providers
        'context.sources.used_memory': finalProviderNames.includes('RECENT_MESSAGES'),
        'context.sources.used_knowledge': finalProviderNames.includes('KNOWLEDGE'),
        'context.sources.used_character': finalProviderNames.includes('CHARACTER'),
        'context.sources.used_actions': finalProviderNames.includes('ACTIONS'),
        'context.sources.used_facts': finalProviderNames.includes('FACTS'), // Example, adjust if needed
      });

      // Log final text as event, using updated event name
      span.addEvent('context.composed', {
        'context.final_string':
          providersText.length > 1000 ? providersText.substring(0, 997) + '...' : providersText, // Truncate if needed
        'context.final_length': providersText.length,
      });
      span.addEvent('state_composition_complete');

      return newState;
    });
  }

  getService<T extends Service>(service: ServiceTypeName): T | null {
    const serviceInstance = this.services.get(service);
    if (!serviceInstance) {
      this.runtimeLogger.warn(`Service ${service} not found`);
      return null;
    }
    return serviceInstance as T;
  }

  async registerService(service: typeof Service): Promise<void> {
    return this.startSpan('AgentRuntime.registerService', async (span) => {
      const serviceType = service.serviceType as ServiceTypeName;
      span.setAttributes({
        'service.type': serviceType || 'unknown',
        'agent.id': this.agentId,
      });

      if (!serviceType) {
        span.addEvent('service_missing_type');
        return;
      }
      this.runtimeLogger.debug(
        `${this.character.name}(${this.agentId}) - Registering service:`,
        serviceType
      );

      if (this.services.has(serviceType)) {
        span.addEvent('service_already_registered');
        this.runtimeLogger.warn(
          `${this.character.name}(${this.agentId}) - Service ${serviceType} is already registered. Skipping registration.`
        );
        return;
      }

      try {
        span.addEvent('starting_service');
        const serviceInstance = await service.start(this);

        // Add the service to the services map
        this.services.set(serviceType, serviceInstance);
        span.addEvent('service_registered');
        this.runtimeLogger.debug(
          `${this.character.name}(${this.agentId}) - Service ${serviceType} registered successfully`
        );
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        span.recordException(error as Error);
        span.setStatus({
          code: SpanStatusCode.ERROR,
          message: errorMessage,
        });
        this.runtimeLogger.error(
          `${this.character.name}(${this.agentId}) - Failed to register service ${serviceType}: ${errorMessage}`
        );
        throw error;
      }
    });
  }

  registerModel(modelType: ModelTypeName, handler: (params: any) => Promise<any>) {
    const modelKey = typeof modelType === 'string' ? modelType : ModelType[modelType];
    if (!this.models.has(modelKey)) {
      this.models.set(modelKey, []);
    }
    this.models.get(modelKey)?.push(handler);
  }

  getModel(
    modelType: ModelTypeName
  ): ((runtime: IAgentRuntime, params: any) => Promise<any>) | undefined {
    const modelKey = typeof modelType === 'string' ? modelType : ModelType[modelType];
    const models = this.models.get(modelKey);
    if (!models?.length) {
      return undefined;
    }
    return models[0];
  }

  /**
   * Use a model with strongly typed parameters and return values based on model type
   * @template T - The model type to use
   * @template R - The expected return type, defaults to the type defined in ModelResultMap[T]
   * @param {T} modelType - The type of model to use
   * @param {ModelParamsMap[T] | any} params - The parameters for the model, typed based on model type
   * @returns {Promise<R>} - The model result, typed based on the provided generic type parameter
   */
  async useModel<T extends ModelTypeName, R = ModelResultMap[T]>(
    modelType: T,
    params: Omit<ModelParamsMap[T], 'runtime'> | any
  ): Promise<R> {
    // Use modelType directly in span name for better granularity
    return this.startSpan(`AgentRuntime.useModel.${modelType}`, async (span) => {
      const modelKey = typeof modelType === 'string' ? modelType : ModelType[modelType];

      // Try to extract prompt content from params (common patterns)
      const promptContent =
        params?.prompt ||
        params?.input ||
        (Array.isArray(params?.messages) ? JSON.stringify(params.messages) : null);

      // Add essential attributes and params/prompt as events
      span.setAttributes({
        'llm.request.model': modelKey, // Semantic convention
        'agent.id': this.agentId,
        'llm.request.temperature': params?.temperature,
        'llm.request.top_p': params?.top_p,
        'llm.request.max_tokens': params?.max_tokens || params?.max_tokens_to_sample, // Handle variations
      });
      span.addEvent('model_parameters', { params: JSON.stringify(params, safeReplacer()) }); // Log full params
      if (promptContent) {
        span.addEvent('llm.prompt', { 'prompt.content': promptContent }); // Log extracted prompt
      }
      // Note: Logging raw API response is not feasible here as the call happens within the model handler.

      const model = this.getModel(modelKey);
      if (!model) {
        const errorMsg = `No handler found for delegate type: ${modelKey}`;
        span.setStatus({ code: SpanStatusCode.ERROR, message: errorMsg });
        throw new Error(errorMsg);
      }

      // Log input parameters (keep debug log if useful)
      this.runtimeLogger.debug(
        `[useModel] ${model} input:`,
        JSON.stringify(params, safeReplacer(), 2)
      );

      // Handle different parameter formats
      let paramsWithRuntime: any;

      // If params is a simple value (string, number, etc.), pass it directly
      if (
        params === null ||
        params === undefined ||
        typeof params !== 'object' ||
        Array.isArray(params) ||
        (typeof Buffer !== 'undefined' && Buffer.isBuffer(params))
      ) {
        paramsWithRuntime = params;
      } else {
        // Otherwise inject the runtime
        paramsWithRuntime = {
          ...params,
          runtime: this,
        };
      }

      // Start timer
      const startTime = performance.now();
      span.addEvent('model_execution_start');

      try {
        // Call the model
        const response = await model(this, paramsWithRuntime);

        // Calculate elapsed time
        const elapsedTime = performance.now() - startTime;
        span.setAttributes({
          'llm.duration_ms': elapsedTime, // Consider llm.duration semantic convention
          // Attempt to extract token counts if response structure is known/standardized
          // Example (adjust based on actual response structure):
          'llm.usage.prompt_tokens': (response as any)?.usage?.prompt_tokens,
          'llm.usage.completion_tokens': (response as any)?.usage?.completion_tokens,
          'llm.usage.total_tokens': (response as any)?.usage?.total_tokens,
        });

        // Log response as event
        span.addEvent('model_response', { response: JSON.stringify(response, safeReplacer()) }); // Log processed response

        // Log timing (keep debug log if useful)
        this.runtimeLogger.debug(`[useModel] ${modelKey} completed in ${elapsedTime.toFixed(2)}ms`);

        // Log response (keep debug log if useful)
        this.runtimeLogger.debug(
          `[useModel] ${modelKey} output:`,
          Array.isArray(response)
            ? `${JSON.stringify(response.slice(0, 5))}...${JSON.stringify(
                response.slice(-5)
              )} (${response.length} items)`
            : JSON.stringify(response)
        );

        // Log the model usage (keep adapter log if useful)
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
        span.setStatus({ code: SpanStatusCode.OK }); // Explicitly set OK status
        return response as R;
      } catch (error) {
        // Calculate time to error
        const errorTime = performance.now() - startTime;

        // Record error details
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
        span.addEvent('model_execution_error'); // Add specific error event

        // Rethrow the error
        throw error;
      }
    });
  }

  registerEvent(event: string, handler: (params: any) => Promise<void>) {
    // --- Reverted: Original simple registration logic ---
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
        continue; // No handlers for this event
      }

      if (isMessageReceivedEvent && instrumentationEnabled) {
        // --- Instrument with startSpan + context.with ---
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

        // Create a new context with the rootSpan as active
        const spanContext = trace.setSpan(context.active(), rootSpan);

        try {
          rootSpan.addEvent('processing_started');
          // Execute handlers within the new context
          await context.with(spanContext, async () => {
            await Promise.all(
              eventHandlers.map((handler) => {
                // Explicitly capture the active context for each handler
                const ctx = context.active();
                return context.with(ctx, () => handler(params));
              })
            );
          });
          rootSpan.setStatus({ code: SpanStatusCode.OK });
        } catch (error) {
          this.runtimeLogger.error(
            `Error during instrumented handler execution for event ${eventName}:`,
            error
          );
          rootSpan.recordException(error as Error);
          rootSpan.setStatus({ code: SpanStatusCode.ERROR, message: (error as Error).message });
          // throw error; // Re-throw if needed
        } finally {
          rootSpan.addEvent('processing_ended');
          rootSpan.end();
        }
        // --- End Instrumentation ---
      } else {
        // --- No Instrumentation: Execute directly ---
        try {
          await Promise.all(eventHandlers.map((handler) => handler(params)));
        } catch (error) {
          this.runtimeLogger.error(
            `Error during emitEvent for ${eventName} (handler execution):`,
            error
          );
          // throw error; // Re-throw if necessary
        }
      }
    }
  }

  async ensureEmbeddingDimension() {
    this.runtimeLogger.debug(
      `[AgentRuntime][${this.character.name}] Starting ensureEmbeddingDimension`
    );

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

      this.runtimeLogger.debug(
        `[AgentRuntime][${this.character.name}] Getting embedding dimensions`
      );
      const embedding = await this.useModel(ModelType.TEXT_EMBEDDING, null);

      if (!embedding || !embedding.length) {
        throw new Error(`[AgentRuntime][${this.character.name}] Invalid embedding received`);
      }

      this.runtimeLogger.debug(
        `[AgentRuntime][${this.character.name}] Setting embedding dimension: ${embedding.length}`
      );
      await this.adapter.ensureEmbeddingDimension(embedding.length);
      this.runtimeLogger.debug(
        `[AgentRuntime][${this.character.name}] Successfully set embedding dimension`
      );
    } catch (error) {
      this.runtimeLogger.debug(
        `[AgentRuntime][${this.character.name}] Error in ensureEmbeddingDimension:`,
        error
      );
      throw error;
    }
  }

  registerTaskWorker(taskHandler: TaskWorker): void {
    if (this.taskWorkers.has(taskHandler.name)) {
      this.runtimeLogger.warn(
        `Task definition ${taskHandler.name} already registered. Will be overwritten.`
      );
    }
    this.taskWorkers.set(taskHandler.name, taskHandler);
  }

  /**
   * Get a task worker by name
   */
  getTaskWorker(name: string): TaskWorker | undefined {
    return this.taskWorkers.get(name);
  }

  // Implement database adapter methods

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

  async getAgents(): Promise<Agent[]> {
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
    return await this.adapter.getEntityById(entityId);
  }

  async getEntitiesForRoom(roomId: UUID, includeComponents?: boolean): Promise<Entity[]> {
    return await this.adapter.getEntitiesForRoom(roomId, includeComponents);
  }

  async createEntity(entity: Entity): Promise<boolean> {
    if (!entity.agentId) {
      entity.agentId = this.agentId;
    }
    return await this.adapter.createEntity(entity);
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
    // Return early if embedding already exists
    if (memory.embedding) {
      return memory;
    }

    const memoryText = memory.content.text;

    // Validate memory has text content
    if (!memoryText) {
      throw new Error('Cannot generate embedding: Memory content is empty');
    }

    try {
      // Generate embedding from text content
      memory.embedding = await this.useModel(ModelType.TEXT_EMBEDDING, {
        text: memoryText,
      });
    } catch (error) {
      logger.error('Failed to generate embedding:', error);
      // Fallback to zero vector if embedding fails
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
    match_threshold?: number;
    count?: number;
    roomId?: UUID;
    unique?: boolean;
    tableName: string;
  }): Promise<Memory[]> {
    return await this.adapter.searchMemories(params);
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

  async getAllWorlds(): Promise<World[]> {
    return await this.adapter.getAllWorlds();
  }

  async updateWorld(world: World): Promise<void> {
    await this.adapter.updateWorld(world);
  }

  async getRoom(roomId: UUID): Promise<Room | null> {
    return await this.adapter.getRoom(roomId);
  }

  async createRoom({ id, name, source, type, channelId, serverId, worldId }: Room): Promise<UUID> {
    return await this.adapter.createRoom({
      id,
      name,
      source,
      type,
      channelId,
      serverId,
      worldId,
    });
  }

  async deleteRoom(roomId: UUID): Promise<void> {
    await this.adapter.deleteRoom(roomId);
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

  async getRooms(worldId: UUID): Promise<Room[]> {
    return await this.adapter.getRooms(worldId);
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

  async getTasks(params: { roomId?: UUID; tags?: string[] }): Promise<Task[]> {
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

  // Event emitter methods
  on(event: string, callback: (data: any) => void): void {
    if (!this.eventHandlers.has(event)) {
      this.eventHandlers.set(event, []);
    }
    this.eventHandlers.get(event)!.push(callback);
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

  /**
   * Sends a control message to the frontend to enable or disable input
   * @param {Object} params - Parameters for the control message
   * @param {UUID} params.roomId - The ID of the room to send the control message to
   * @param {'enable_input' | 'disable_input'} params.action - The action to perform
   * @param {string} [params.target] - Optional target element identifier
   * @returns {Promise<void>}
   */
  async sendControlMessage(params: {
    roomId: UUID;
    action: 'enable_input' | 'disable_input';
    target?: string;
  }): Promise<void> {
    try {
      const { roomId, action, target } = params;

      // Create the control message
      const controlMessage = {
        type: 'control',
        payload: {
          action,
          target,
        },
        roomId,
      };

      // Emit an event that can be handled by the websocket service or other handlers
      await this.emitEvent('CONTROL_MESSAGE', {
        runtime: this,
        message: controlMessage,
        source: 'agent',
      });

      this.runtimeLogger.debug(`Sent control message: ${action} to room ${roomId}`);
    } catch (error) {
      this.runtimeLogger.error(`Error sending control message: ${error}`);
    }
  }
}
