import { v4 as uuidv4 } from 'uuid';
import { bootstrapPlugin } from './bootstrap';
import { createUniqueUuid } from './entities';
import { handlePluginImporting } from './index';
import logger from './logger';
import { splitChunks } from './prompts';
// Import enums and values that are used as values
import { ChannelType, MemoryType, ModelType } from './types';

// Import types with the 'type' keyword
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
  Service,
  ServiceTypeName,
  State,
  Task,
  TaskWorker,
  UUID,
  World,
} from './types';
import { stringToUuid } from './uuid';

import fs from 'node:fs';
import path from 'node:path';

/**
 * Interface for settings object with key-value pairs.
 */
interface Settings {
  [key: string]: string | undefined;
}

/**
 * Represents a collection of settings grouped by namespace.
 *
 * @typedef {Object} NamespacedSettings
 * @property {Settings} namespace - The namespace key and corresponding Settings value.
 */
interface NamespacedSettings {
  [namespace: string]: Settings;
}

/**
 * Initialize an empty object for storing environment settings.
 */
let environmentSettings: Settings = {};

/**
 * Loads environment variables from the nearest .env file in Node.js
 * or returns configured settings in browser
 * @returns {Settings} Environment variables object
 */
export function loadEnvConfig(): Settings {
  // For browser environments, return the configured settings
  if (typeof window !== 'undefined' && typeof window.document !== 'undefined') {
    return environmentSettings;
  }

  // Only import dotenv in Node.js environment
  let dotenv = null;
  try {
    // This code block will only execute in Node.js environments
    if (typeof process !== 'undefined' && process.versions && process.versions.node) {
      dotenv = require('dotenv');
    }
  } catch (err) {
    // Silently fail if require is not available (e.g., in browser environments)
    logger.debug('dotenv module not available');
  }

  function findNearestEnvFile(startDir = process.cwd()) {
    let currentDir = startDir;

    // Continue searching until we reach the root directory
    while (currentDir !== path.parse(currentDir).root) {
      const envPath = path.join(currentDir, '.env');

      if (fs.existsSync(envPath)) {
        return envPath;
      }

      // Move up to parent directory
      currentDir = path.dirname(currentDir);
    }

    // Check root directory as well
    const rootEnvPath = path.join(path.parse(currentDir).root, '.env');
    return fs.existsSync(rootEnvPath) ? rootEnvPath : null;
  }

  // Node.js environment: load from .env file
  const envPath = findNearestEnvFile();

  // Load the .env file into process.env synchronously
  try {
    if (dotenv) {
      const result = dotenv.config(envPath ? { path: envPath } : {});
      if (!result.error && envPath) {
        logger.log(`Loaded .env file from: ${envPath}`);
      }
    }
  } catch (err) {
    logger.warn('Failed to load .env file:', err);
  }

  // Parse namespaced settings
  const env = typeof process !== 'undefined' ? process.env : (import.meta as any).env;
  const namespacedSettings = parseNamespacedSettings(env as Settings);

  // Attach to process.env for backward compatibility if available
  if (typeof process !== 'undefined') {
    Object.entries(namespacedSettings).forEach(([namespace, settings]) => {
      process.env[`__namespaced_${namespace}`] = JSON.stringify(settings);
    });
  }

  return env as Settings;
}

// Add this function to parse namespaced settings
function parseNamespacedSettings(env: Settings): NamespacedSettings {
  const namespaced: NamespacedSettings = {};

  for (const [key, value] of Object.entries(env)) {
    if (!value) continue;

    const [namespace, ...rest] = key.split('.');
    if (!namespace || rest.length === 0) continue;

    const settingKey = rest.join('.');
    namespaced[namespace] = namespaced[namespace] || {};
    namespaced[namespace][settingKey] = value;
  }

  return namespaced;
}

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
  private settings: Settings;

  constructor(opts: {
    conversationLength?: number;
    agentId?: UUID;
    character?: Character;
    plugins?: Plugin[];
    fetch?: typeof fetch;
    adapter?: IDatabaseAdapter;
    events?: { [key: string]: ((params: any) => void)[] };
    ignoreBootstrap?: boolean;
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

    if (typeof window !== 'undefined' && typeof window.document !== 'undefined') {
      this.settings = environmentSettings;
    } else {
      this.settings = loadEnvConfig();
    }

    // Register plugins from options or empty array
    const plugins = opts?.plugins ?? [];

    // Add bootstrap plugin if not explicitly ignored
    if (!opts?.ignoreBootstrap) {
      plugins.push(bootstrapPlugin);
    }

    // Store plugins in the array but don't initialize them yet
    this.plugins = plugins;

    this.runtimeLogger.debug(`Success: Agent ID: ${this.agentId}`);
  }

  /**
   * Registers a plugin with the runtime and initializes its components
   * @param plugin The plugin to register
   */
  async registerPlugin(plugin: Plugin): Promise<void> {
    if (!plugin) {
      this.runtimeLogger.error('*** registerPlugin plugin is undefined');
      throw new Error('*** registerPlugin plugin is undefined');
    }

    // Add to plugins array if not already present - but only if it was not passed there initially
    // (otherwise we can't add to readonly array)
    if (!this.plugins.some((p) => p.name === plugin.name)) {
      // Push to plugins array - this works because we're modifying the array, not reassigning it
      this.plugins.push(plugin);
      this.runtimeLogger.debug(`Success: Plugin ${plugin.name} registered successfully`);
    }

    // Initialize the plugin if it has an init function
    if (plugin.init) {
      try {
        await plugin.init(plugin.config || {}, this);
        this.runtimeLogger.debug(`Success: Plugin ${plugin.name} initialized successfully`);
      } catch (error) {
        // Check if the error is related to missing API keys
        const errorMessage = error instanceof Error ? error.message : String(error);

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

          // We don't throw here, allowing the application to continue
          // with reduced functionality
        } else {
          // For other types of errors, rethrow
          throw error;
        }
      }
    }

    // Register plugin adapter
    if (plugin.adapter) {
      this.runtimeLogger.debug(`Registering database adapter for plugin ${plugin.name}`);
      this.registerDatabaseAdapter(plugin.adapter);
    }

    // Register plugin actions
    if (plugin.actions) {
      for (const action of plugin.actions) {
        this.registerAction(action);
      }
    }

    // Register plugin evaluators
    if (plugin.evaluators) {
      for (const evaluator of plugin.evaluators) {
        this.registerEvaluator(evaluator);
      }
    }

    // Register plugin providers
    if (plugin.providers) {
      for (const provider of plugin.providers) {
        this.registerContextProvider(provider);
      }
    }

    // Register plugin models
    if (plugin.models) {
      for (const [modelType, handler] of Object.entries(plugin.models)) {
        this.registerModel(modelType as ModelTypeName, handler as (params: any) => Promise<any>);
      }
    }

    // Register plugin routes
    if (plugin.routes) {
      for (const route of plugin.routes) {
        this.routes.push(route);
      }
    }

    // Register plugin events
    if (plugin.events) {
      for (const [eventName, eventHandlers] of Object.entries(plugin.events)) {
        for (const eventHandler of eventHandlers) {
          this.registerEvent(eventName, eventHandler);
        }
      }
    }

    // Register plugin services
    if (plugin.services) {
      await Promise.all(plugin.services.map((service) => this.registerService(service)));
    }
  }

  getAllServices(): Map<ServiceTypeName, Service> {
    return this.services;
  }

  async stop() {
    this.runtimeLogger.debug(`runtime::stop - character ${this.character.name}`);

    // Stop all registered clients
    for (const [serviceName, service] of this.services) {
      this.runtimeLogger.debug(`runtime::stop - requesting service stop for ${serviceName}`);
      await service.stop();
    }
  }

  async initialize() {
    // Track registered plugins to avoid duplicates
    const registeredPluginNames = new Set<string>();

    // Load and register plugins from character configuration
    const pluginRegistrationPromises = [];

    if (this.character.plugins) {
      const characterPlugins = (await handlePluginImporting(this.character.plugins)) as Plugin[];

      // Register each character plugin
      for (const plugin of characterPlugins) {
        if (plugin && !registeredPluginNames.has(plugin.name)) {
          registeredPluginNames.add(plugin.name);
          pluginRegistrationPromises.push(await this.registerPlugin(plugin));
        }
      }
    }

    // Register plugins that were provided in the constructor
    for (const plugin of [...this.plugins]) {
      if (plugin && !registeredPluginNames.has(plugin.name)) {
        registeredPluginNames.add(plugin.name);
        pluginRegistrationPromises.push(await this.registerPlugin(plugin));
      }
    }

    await this.adapter.init();

    // First create the agent entity directly
    try {
      // Ensure agent exists first (this is critical for test mode)
      const agentExists = await this.adapter.ensureAgentExists(this.character as Partial<Agent>);

      // Verify agent exists before proceeding
      const agent = await this.adapter.getAgent(this.agentId);
      if (!agent) {
        throw new Error(
          `Agent ${this.agentId} does not exist in database after ensureAgentExists call`
        );
      }

      // No need to transform agent's own ID
      const agentEntity = await this.adapter.getEntityById(this.agentId);

      if (!agentEntity) {
        const created = await this.createEntity({
          id: this.agentId,
          agentId: this.agentId,
          names: Array.from(new Set([this.character.name].filter(Boolean))) as string[],
          metadata: {},
        });

        if (!created) {
          throw new Error(`Failed to create entity for agent ${this.agentId}`);
        }

        this.runtimeLogger.debug(
          `Success: Agent entity created successfully for ${this.character.name}`
        );
      }
    } catch (error) {
      this.runtimeLogger.error(
        `Failed to create agent entity: ${error instanceof Error ? error.message : String(error)}`
      );
      throw error;
    }

    // Create room for the agent and register all plugins in parallel
    try {
      await Promise.all([
        this.ensureRoomExists({
          id: this.agentId,
          name: this.character.name,
          source: 'self',
          type: ChannelType.SELF,
        }),
        ...pluginRegistrationPromises,
      ]);
    } catch (error) {
      this.runtimeLogger.error(
        `Failed to initialize: ${error instanceof Error ? error.message : String(error)}`
      );
      throw error;
    }

    // Add agent as participant in its own room
    try {
      // No need to transform agent ID
      const participants = await this.adapter.getParticipantsForRoom(this.agentId);
      if (!participants.includes(this.agentId)) {
        const added = await this.adapter.addParticipant(this.agentId, this.agentId);
        if (!added) {
          throw new Error(`Failed to add agent ${this.agentId} as participant to its own room`);
        }
        this.runtimeLogger.debug(
          `Agent ${this.character.name} linked to its own room successfully`
        );
      }
    } catch (error) {
      this.runtimeLogger.error(
        `Failed to add agent as participant: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
      throw error;
    }

    // Check if TEXT_EMBEDDING model is registered
    const embeddingModel = this.getModel(ModelType.TEXT_EMBEDDING);
    if (!embeddingModel) {
      this.runtimeLogger.warn(
        `[AgentRuntime][${this.character.name}] No TEXT_EMBEDDING model registered. Skipping embedding dimension setup.`
      );
    } else {
      // Only run ensureEmbeddingDimension if we have an embedding model
      await this.ensureEmbeddingDimension();
    }

    // Process character knowledge
    if (this.character?.knowledge && this.character.knowledge.length > 0) {
      const stringKnowledge = this.character.knowledge.filter(
        (item): item is string => typeof item === 'string'
      );
      await this.processCharacterKnowledge(stringKnowledge);
    }
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
    // Add validation for message
    if (!message?.content?.text) {
      this.runtimeLogger.warn('Invalid message for knowledge query:', {
        message,
        content: message?.content,
        text: message?.content?.text,
      });
      return [];
    }

    // Validate processed text
    if (!message?.content?.text || message?.content?.text.trim().length === 0) {
      this.runtimeLogger.warn('Empty text for knowledge query');
      return [];
    }

    const embedding = await this.useModel(ModelType.TEXT_EMBEDDING, {
      text: message?.content?.text,
    });
    const fragments = await this.searchMemories({
      tableName: 'knowledge',
      embedding,
      roomId: message.agentId,
      count: 5,
      match_threshold: 0.1,
    });

    const uniqueSources = [
      ...new Set(
        fragments.map((memory) => {
          this.runtimeLogger.debug(
            `Matched fragment: ${memory.content.text} with similarity: ${memory.similarity}`
          );
          return memory.content.source;
        })
      ),
    ];

    const knowledgeDocuments = await Promise.all(
      uniqueSources.map((source) => this.getMemoryById(source as UUID))
    );

    return knowledgeDocuments
      .filter((memory) => memory !== null)
      .map((memory) => ({ id: memory.id, content: memory.content }));
  }

  async addKnowledge(
    item: KnowledgeItem,
    options = {
      targetTokens: 3000,
      overlap: 200,
      modelContextSize: 4096,
    }
  ) {
    // First store the document
    const documentMemory: Memory = {
      id: item.id,
      agentId: this.agentId,
      roomId: this.agentId,
      entityId: this.agentId,
      content: item.content,
      metadata: {
        type: MemoryType.DOCUMENT,
        timestamp: Date.now(),
      },
    };

    await this.createMemory(documentMemory, 'documents');

    // Create fragments using splitChunks
    const fragments = await splitChunks(item.content.text, options.targetTokens, options.overlap);

    // Store each fragment with link to source document
    for (let i = 0; i < fragments.length; i++) {
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
    }
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

        await this.addKnowledge({
          id: knowledgeId,
          content: {
            text: item,
          },
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

    if (value === 'true') return true;
    if (value === 'false') return false;
    return value || null;
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
    for (const response of responses) {
      if (!response.content?.actions || response.content.actions.length === 0) {
        this.runtimeLogger.warn('No action found in the response content.');
        continue;
      }

      const actions = response.content.actions;

      function normalizeAction(action: string) {
        return action.toLowerCase().replace('_', '');
      }
      this.runtimeLogger.debug(
        `Found actions: ${this.actions.map((a) => normalizeAction(a.name))}`
      );

      for (const responseAction of actions) {
        state = await this.composeState(message, ['RECENT_MESSAGES']);

        this.runtimeLogger.debug(`Success: Calling action: ${responseAction}`);
        const normalizedResponseAction = normalizeAction(responseAction);
        let action = this.actions.find(
          (a: { name: string }) =>
            normalizeAction(a.name).includes(normalizedResponseAction) || // the || is kind of a fuzzy match
            normalizedResponseAction.includes(normalizeAction(a.name)) //
        );

        if (action) {
          this.runtimeLogger.debug(`Success: Found action: ${action?.name}`);
        } else {
          this.runtimeLogger.debug('Attempting to find action in similes.');
          for (const _action of this.actions) {
            const simileAction = _action.similes?.find(
              (simile) =>
                simile.toLowerCase().replace('_', '').includes(normalizedResponseAction) ||
                normalizedResponseAction.includes(simile.toLowerCase().replace('_', ''))
            );
            if (simileAction) {
              action = _action;
              this.runtimeLogger.debug(`Success: Action found in similes: ${action.name}`);
              break;
            }
          }
        }

        if (!action) {
          this.runtimeLogger.error(`No action found for: ${responseAction}`);
          continue;
        }

        if (!action.handler) {
          this.runtimeLogger.error(`Action ${action.name} has no handler.`);
          continue;
        }

        try {
          this.runtimeLogger.debug(`Executing handler for action: ${action.name}`);

          await action.handler(this, message, state, {}, callback, responses);

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
          this.runtimeLogger.error(error);
          throw error;
        }
      }
    }
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

    // get the evaluators that were chosen by the response handler

    if (evaluators.length === 0) {
      return [];
    }

    state = await this.composeState(message, ['RECENT_MESSAGES', 'EVALUATORS']);

    await Promise.all(
      evaluators.map(async (evaluator) => {
        if (evaluator.handler) {
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
              state,
            },
          });
        }
      })
    );

    return evaluators;
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
        name: name,
        userName: userName,
      },
    };

    // Step 1: Handle entity creation/update with proper error handling
    try {
      // First check if the entity exists
      let entity = await this.adapter.getEntityById(entityId);

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
  async ensureRoomExists({ id, name, source, type, channelId, serverId, worldId }: Room) {
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

    // Fetch data from selected providers
    const providerData = await Promise.all(
      providersToGet.map(async (provider) => {
        const start = Date.now();
        const result = await provider.get(this, message, cachedState);
        const duration = Date.now() - start;
        this.runtimeLogger.debug(`${provider.name} Provider took ${duration}ms to respond`);
        return {
          ...result,
          providerName: provider.name,
        };
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
      .join('\n');

    // Combine with existing text if available
    let providersText = '';
    if (cachedState.text && newProvidersText) {
      providersText = `${cachedState.text}\n${newProvidersText}`;
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
    return newState;
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
    const serviceType = service.serviceType as ServiceTypeName;
    if (!serviceType) {
      return;
    }
    this.runtimeLogger.debug(
      `${this.character.name}(${this.agentId}) - Registering service:`,
      serviceType
    );

    if (this.services.has(serviceType)) {
      this.runtimeLogger.warn(
        `${this.character.name}(${this.agentId}) - Service ${serviceType} is already registered. Skipping registration.`
      );
      return;
    }

    const serviceInstance = await service.start(this);

    // Add the service to the services map
    this.services.set(serviceType, serviceInstance);
    this.runtimeLogger.debug(
      `${this.character.name}(${this.agentId}) - Service ${serviceType} registered successfully`
    );
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
    const modelKey = typeof modelType === 'string' ? modelType : ModelType[modelType];
    const model = this.getModel(modelKey);
    if (!model) {
      throw new Error(`No handler found for delegate type: ${modelKey}`);
    }

    // Log input parameters
    this.runtimeLogger.debug(`[useModel] ${modelKey} input:`, JSON.stringify(params, null, 2));

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

    // Call the model
    const response = await model(this, paramsWithRuntime);

    // Calculate elapsed time
    const elapsedTime = performance.now() - startTime;

    // Log timing
    this.runtimeLogger.debug(`[useModel] ${modelKey} completed in ${elapsedTime.toFixed(2)}ms`);

    // Log response
    this.runtimeLogger.debug(
      `[useModel] ${modelKey} output:`,
      // if response is an array, should the first and last 5 items with a "..." in the middle, and a (x items) at the end
      Array.isArray(response)
        ? `${JSON.stringify(response.slice(0, 5))}...${JSON.stringify(
            response.slice(-5)
          )} (${response.length} items)`
        : JSON.stringify(response)
    );

    // Log the model usage
    this.adapter.log({
      entityId: this.agentId,
      roomId: this.agentId,
      body: {
        modelType,
        modelKey,
        params: params ? (typeof params === 'object' ? Object.keys(params) : typeof params) : null,
        response:
          Array.isArray(response) && response.every((x) => typeof x === 'number')
            ? '[array]'
            : response,
      },
      type: `useModel:${modelKey}`,
    });

    return response as R;
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
    // Handle both single event string and array of event strings
    const events = Array.isArray(event) ? event : [event];

    // Call handlers for each event
    for (const eventName of events) {
      const eventHandlers = this.events.get(eventName);

      if (eventHandlers) {
        await Promise.all(eventHandlers.map((handler) => handler(params)));
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

  async ensureAgentExists(agent: Partial<Agent>): Promise<void> {
    await this.adapter.ensureAgentExists(agent);
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
}
