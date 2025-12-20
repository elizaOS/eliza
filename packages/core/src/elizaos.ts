import { v4 as uuidv4 } from 'uuid';
import { AgentRuntime } from './runtime';
import { setDefaultSecretsFromEnv } from './secrets';
import { getSalt, encryptObjectValues } from './settings';
import { resolvePlugins } from './plugin';
import type {
  Character,
  IAgentRuntime,
  IElizaOS,
  UUID,
  Memory,
  State,
  Plugin,
  RuntimeSettings,
  Content,
  HandleMessageOptions,
  HandleMessageResult,
  IDatabaseAdapter,
  HealthStatus,
  ReadonlyRuntime,
} from './types';
import type { MessageProcessingOptions, MessageProcessingResult } from './services/message-service';

/**
 * ElizaOS - Multi-agent orchestration framework
 */
export class ElizaOS extends EventTarget implements IElizaOS {
  private runtimes: Map<UUID, IAgentRuntime> = new Map();
  private initFunctions: Map<UUID, (runtime: IAgentRuntime) => Promise<void>> = new Map();
  private editableMode = false;

  // Overload: returns UUID[] when returnRuntimes is false/undefined
  async addAgents(
    agents: Array<{
      character: Character;
      plugins?: (Plugin | string)[];
      settings?: RuntimeSettings;
      init?: (runtime: IAgentRuntime) => Promise<void>;
      databaseAdapter?: IDatabaseAdapter;
    }>,
    options?: {
      isTestMode?: boolean;
      ephemeral?: boolean;
      skipMigrations?: boolean;
      autoStart?: boolean;
      returnRuntimes?: false;
    }
  ): Promise<UUID[]>;

  // Overload: returns IAgentRuntime[] when returnRuntimes is true
  async addAgents(
    agents: Array<{
      character: Character;
      plugins?: (Plugin | string)[];
      settings?: RuntimeSettings;
      init?: (runtime: IAgentRuntime) => Promise<void>;
      databaseAdapter?: IDatabaseAdapter;
    }>,
    options: {
      isTestMode?: boolean;
      ephemeral?: boolean;
      skipMigrations?: boolean;
      autoStart?: boolean;
      returnRuntimes: true;
    }
  ): Promise<IAgentRuntime[]>;

  /**
   * Add multiple agents (batch operation)
   * Handles config and plugin resolution automatically
   *
   * Supports both persistent (Node.js server) and ephemeral (serverless) modes:
   * - Persistent: runtime stored in registry, accessed via getAgent()
   * - Ephemeral: runtime returned but not stored, for per-request usage
   *
   * @example
   * // Node.js server (persistent)
   * const ids = await elizaOS.addAgents([{ character, plugins }]);
   * await elizaOS.startAgents(ids);
   *
   * @example
   * // Serverless (ephemeral, with pre-cached DB adapter)
   * const runtimes = await elizaOS.addAgents([{
   *   character,
   *   plugins,
   *   databaseAdapter: cachedAdapter,
   * }], {
   *   ephemeral: true,
   *   skipMigrations: true,
   *   autoStart: true,
   *   returnRuntimes: true,
   * });
   */
  async addAgents(
    agents: Array<{
      character: Character;
      plugins?: (Plugin | string)[];
      settings?: RuntimeSettings;
      init?: (runtime: IAgentRuntime) => Promise<void>;
      /** Pre-initialized database adapter (skips plugin-sql) */
      databaseAdapter?: IDatabaseAdapter;
    }>,
    options?: {
      isTestMode?: boolean;
      /** If true, runtimes are NOT stored in registry (for serverless) */
      ephemeral?: boolean;
      /** If true, skip database migrations during initialize */
      skipMigrations?: boolean;
      /** If true, automatically call initialize() after creation */
      autoStart?: boolean;
      /** If true, return IAgentRuntime[] instead of UUID[] */
      returnRuntimes?: boolean;
    }
  ): Promise<UUID[] | IAgentRuntime[]> {
    const createdRuntimes: IAgentRuntime[] = [];

    const promises = agents.map(async (agent) => {
      const character: Character = JSON.parse(JSON.stringify(agent.character));

      // Merge environment secrets with character secrets
      // Priority: .env < character.json (character overrides)
      // In test mode, skip env merge to avoid database bloat from system variables
      await setDefaultSecretsFromEnv(character, { skipEnvMerge: options?.isTestMode });

      // Encrypt all secrets after merging env vars
      const salt = getSalt();
      if (character.settings?.secrets && typeof character.settings.secrets === 'object') {
        character.settings.secrets = encryptObjectValues(
          character.settings.secrets as Record<string, string>,
          salt
        );
      }
      // Also encrypt character.secrets (root level) if it exists
      if (character.secrets && typeof character.secrets === 'object') {
        character.secrets = encryptObjectValues(
          character.secrets as Record<string, string>,
          salt
        ) as { [key: string]: string | boolean | number };
      }

      let resolvedPlugins = agent.plugins
        ? await resolvePlugins(agent.plugins, options?.isTestMode || false)
        : [];

      // Filter out plugin-sql if databaseAdapter is provided
      if (agent.databaseAdapter) {
        resolvedPlugins = resolvedPlugins.filter((p) => p.name !== '@elizaos/plugin-sql');
      }

      const runtime = new AgentRuntime({
        character,
        plugins: resolvedPlugins,
        settings: agent.settings || {},
      });

      // Register pre-initialized database adapter if provided
      if (agent.databaseAdapter) {
        (runtime as IAgentRuntime).registerDatabaseAdapter(agent.databaseAdapter);
      }

      runtime.elizaOS = this;

      // Only store in registry if not ephemeral
      if (!options?.ephemeral) {
        this.runtimes.set(runtime.agentId, runtime);
      }

      if (typeof agent.init === 'function') {
        this.initFunctions.set(runtime.agentId, agent.init);
      }

      const { settings, ...characterWithoutSecrets } = character;
      const { secrets, ...settingsWithoutSecrets } = settings || {};

      this.dispatchEvent(
        new CustomEvent('agent:added', {
          detail: {
            agentId: runtime.agentId,
            character: {
              ...characterWithoutSecrets,
              settings: settingsWithoutSecrets,
            },
            ephemeral: options?.ephemeral,
          },
        })
      );

      createdRuntimes.push(runtime);
      return runtime.agentId;
    });

    const ids = await Promise.all(promises);

    // Auto-start if requested (useful for serverless)
    if (options?.autoStart) {
      await Promise.all(
        createdRuntimes.map(async (runtime) => {
          await runtime.initialize({ skipMigrations: options?.skipMigrations });

          // Run init function if provided
          const initFn = this.initFunctions.get(runtime.agentId);
          if (initFn) {
            await initFn(runtime);
            this.initFunctions.delete(runtime.agentId);
          }

          this.dispatchEvent(
            new CustomEvent('agent:started', {
              detail: { agentId: runtime.agentId },
            })
          );
        })
      );
    }

    this.dispatchEvent(
      new CustomEvent('agents:added', {
        detail: { agentIds: ids, count: ids.length, ephemeral: options?.ephemeral },
      })
    );

    // Return runtimes directly if requested (serverless pattern)
    if (options?.returnRuntimes) {
      return createdRuntimes;
    }

    return ids;
  }

  /**
   * Register an existing runtime
   */
  registerAgent(runtime: IAgentRuntime): void {
    if (this.runtimes.has(runtime.agentId)) {
      throw new Error(`Agent ${runtime.agentId} already registered`);
    }

    runtime.elizaOS = this;

    this.runtimes.set(runtime.agentId, runtime);

    this.dispatchEvent(
      new CustomEvent('agent:registered', {
        detail: { agentId: runtime.agentId, runtime },
      })
    );
  }

  /**
   * Update an agent's character
   */
  async updateAgent(agentId: UUID, updates: Partial<Character>): Promise<void> {
    if (!this.editableMode) {
      throw new Error('Editable mode not enabled');
    }

    const runtime = this.runtimes.get(agentId);
    if (!runtime) {
      throw new Error(`Agent ${agentId} not found`);
    }

    // Update character properties
    Object.assign(runtime.character, updates);

    this.dispatchEvent(
      new CustomEvent('agent:updated', {
        detail: { agentId, updates },
      })
    );
  }

  /**
   * Delete agents
   */
  async deleteAgents(agentIds: UUID[]): Promise<void> {
    await this.stopAgents(agentIds);

    for (const id of agentIds) {
      this.runtimes.delete(id);
      this.initFunctions.delete(id);
    }

    this.dispatchEvent(
      new CustomEvent('agents:deleted', {
        detail: { agentIds, count: agentIds.length },
      })
    );
  }

  /**
   * Start multiple agents
   */
  async startAgents(agentIds?: UUID[]): Promise<void> {
    const ids = agentIds || Array.from(this.runtimes.keys());

    await Promise.all(
      ids.map(async (id) => {
        const runtime = this.runtimes.get(id);
        if (!runtime) {
          throw new Error(`Agent ${id} not found`);
        }
        await runtime.initialize();

        this.dispatchEvent(
          new CustomEvent('agent:started', {
            detail: { agentId: id },
          })
        );
      })
    );

    for (const id of ids) {
      const initFn = this.initFunctions.get(id);
      if (initFn) {
        const runtime = this.runtimes.get(id);
        if (runtime) {
          await initFn(runtime);
          this.initFunctions.delete(id);
        }
      }
    }

    this.dispatchEvent(
      new CustomEvent('agents:started', {
        detail: { agentIds: ids, count: ids.length },
      })
    );
  }

  /**
   * Stop agents
   */
  async stopAgents(agentIds?: UUID[]): Promise<void> {
    const ids = agentIds || Array.from(this.runtimes.keys());

    await Promise.all(
      ids.map(async (id) => {
        const runtime = this.runtimes.get(id);
        if (runtime) {
          await runtime.stop();
        }
      })
    );

    this.dispatchEvent(
      new CustomEvent('agents:stopped', {
        detail: { agentIds: ids, count: ids.length },
      })
    );
  }

  /**
   * Get a single agent
   */
  getAgent(id: UUID): IAgentRuntime | undefined {
    return this.runtimes.get(id);
  }

  /**
   * Get all agents
   */
  getAgents(): IAgentRuntime[] {
    return Array.from(this.runtimes.values());
  }

  /**
   * Get agents by IDs
   */
  getAgentsByIds(ids: UUID[]): IAgentRuntime[] {
    return ids
      .map((id) => this.runtimes.get(id))
      .filter((runtime): runtime is IAgentRuntime => runtime !== undefined);
  }

  /**
   * Get agents by names
   */
  getAgentsByNames(names: string[]): IAgentRuntime[] {
    const nameSet = new Set(names.map((n) => n.toLowerCase()));
    return this.getAgents().filter((runtime) => nameSet.has(runtime.character.name.toLowerCase()));
  }

  /**
   * Get agent by ID (alias for getAgent for consistency)
   */
  getAgentById(id: UUID): IAgentRuntime | undefined {
    return this.getAgent(id);
  }

  /**
   * Get agent by name
   */
  getAgentByName(name: string): IAgentRuntime | undefined {
    const lowercaseName = name.toLowerCase();
    return this.getAgents().find(
      (runtime) => runtime.character.name.toLowerCase() === lowercaseName
    );
  }

  /**
   * Get agent by character name (alias for getAgentByName)
   */
  getAgentByCharacterName(name: string): IAgentRuntime | undefined {
    return this.getAgentByName(name);
  }

  /**
   * Get agent by character ID
   */
  getAgentByCharacterId(characterId: UUID): IAgentRuntime | undefined {
    return this.getAgents().find((runtime) => runtime.character.id === characterId);
  }

  /**
   * Send a message to a specific agent
   *
   * @param target - The agent ID (UUID) or runtime instance to send the message to
   * @param message - Partial Memory object (missing fields auto-filled)
   * @param options - Optional callbacks and processing options
   * @returns Promise with message ID and result
   *
   * @example
   * // SYNC mode with agent ID (HTTP API)
   * const result = await elizaOS.handleMessage(agentId, {
   *   entityId: user.id,
   *   roomId: room.id,
   *   content: { text: "Hello", source: 'web' }
   * });
   *
   * @example
   * // Serverless mode with runtime directly (no registry lookup)
   * const [runtime] = await elizaOS.addAgents([config], { ephemeral: true, autoStart: true, returnRuntimes: true });
   * const result = await elizaOS.handleMessage(runtime, {
   *   entityId: user.id,
   *   roomId: room.id,
   *   content: { text: "Hello", source: 'web' }
   * });
   *
   * @example
   * // ASYNC mode (WebSocket, MessageBus)
   * await elizaOS.handleMessage(agentId, {
   *   entityId: user.id,
   *   roomId: room.id,
   *   content: { text: "Hello", source: 'websocket' }
   * }, {
   *   onResponse: async (response) => {
   *     await socket.emit('message', response.text);
   *   }
   * });
   */
  async handleMessage(
    target: UUID | IAgentRuntime,
    message: Partial<Memory> & {
      entityId: UUID;
      roomId: UUID;
      content: Content;
      worldId?: UUID;
    },
    options?: HandleMessageOptions
  ): Promise<HandleMessageResult> {
    // 1. Resolve the runtime (UUID → lookup, runtime → direct)
    let runtime: IAgentRuntime | undefined;
    let agentId: UUID;

    if (typeof target === 'string') {
      // Target is UUID, lookup in registry
      agentId = target as UUID;
      runtime = this.runtimes.get(agentId);
      if (!runtime) {
        throw new Error(`Agent ${agentId} not found in registry`);
      }
    } else {
      // Target is runtime instance (serverless pattern)
      runtime = target;
      agentId = runtime.agentId;
    }

    // 2. Verify messageService exists
    if (!runtime.messageService) {
      throw new Error('messageService is not initialized on runtime');
    }

    // 3. Auto-fill missing fields
    const messageId = message.id || (uuidv4() as UUID);
    const userMessage: Memory = {
      ...message,
      id: messageId,
      agentId: message.agentId || runtime.agentId,
      createdAt: message.createdAt || Date.now(),
      entityId: message.entityId,
      roomId: message.roomId,
      content: message.content,
    } as Memory;

    // 4. Ensure connection exists
    await runtime.ensureConnection({
      entityId: userMessage.entityId,
      roomId: userMessage.roomId,
      worldId: message.worldId || userMessage.roomId,
      source: userMessage.content.source || 'unknown',
      channelId: userMessage.roomId,
    });

    // 5. Extract processing options (includes streaming callback)
    const processingOptions: MessageProcessingOptions = {
      maxRetries: options?.maxRetries,
      timeoutDuration: options?.timeoutDuration,
      useMultiStep: options?.useMultiStep,
      maxMultiStepIterations: options?.maxMultiStepIterations,
      onStreamChunk: options?.onStreamChunk,
    };

    // 6. Helper to wrap message handling with Entity RLS context if available
    const handleMessageWithEntityContext = async <T>(handler: () => Promise<T>): Promise<T> => {
      if (runtime.withEntityContext) {
        return await runtime.withEntityContext(userMessage.entityId, handler);
      } else {
        return await handler();
      }
    };

    // 7. Determine mode: async or sync
    const isAsyncMode = !!options?.onResponse;

    if (isAsyncMode) {
      // ========== ASYNC MODE ==========
      // Fire and forget with callback

      const callback = async (content: Content) => {
        try {
          if (options.onResponse) {
            await options.onResponse(content);
          }
        } catch (error) {
          if (options.onError) {
            await options.onError(error instanceof Error ? error : new Error(String(error)));
          }
        }
        return [];
      };

      // Wrap message handling with Entity RLS context
      handleMessageWithEntityContext(() =>
        runtime.messageService!.handleMessage(runtime, userMessage, callback, processingOptions)
      )
        .then(() => {
          if (options.onComplete) options.onComplete();
        })
        .catch((error: Error) => {
          if (options.onError) options.onError(error);
        });

      // Emit event for tracking
      this.dispatchEvent(
        new CustomEvent('message:sent', {
          detail: { agentId, messageId, mode: 'async' },
        })
      );

      return { messageId, userMessage };
    } else {
      // ========== SYNC MODE ==========
      // Wait for response

      const processing = await handleMessageWithEntityContext<MessageProcessingResult>(() =>
        runtime.messageService!.handleMessage(runtime, userMessage, undefined, processingOptions)
      );

      if (options?.onComplete) await options.onComplete();

      // Emit event for tracking
      this.dispatchEvent(
        new CustomEvent('message:sent', {
          detail: { agentId, messageId, mode: 'sync', processing },
        })
      );

      return { messageId, userMessage, processing };
    }
  }

  /**
   * Handle messages to multiple agents in parallel
   *
   * Useful for batch operations where you need to send messages to multiple agents at once.
   * All messages are handled in parallel for maximum performance.
   *
   * @param messages - Array of messages to handle, each with agentId and message data
   * @returns Promise with array of results, one per message
   *
   * @example
   * const results = await elizaOS.handleMessages([
   *   {
   *     agentId: agent1Id,
   *     message: {
   *       entityId: user.id,
   *       roomId: room.id,
   *       content: { text: "Hello Agent 1", source: "web" }
   *     }
   *   },
   *   {
   *     agentId: agent2Id,
   *     message: {
   *       entityId: user.id,
   *       roomId: room.id,
   *       content: { text: "Hello Agent 2", source: "web" }
   *     },
   *     options: {
   *       onResponse: async (response) => {
   *         console.log("Agent 2 responded:", response.text);
   *       }
   *     }
   *   }
   * ]);
   */
  async handleMessages(
    messages: Array<{
      agentId: UUID;
      message: Partial<Memory> & {
        entityId: UUID;
        roomId: UUID;
        content: Content;
        worldId?: UUID;
      };
      options?: HandleMessageOptions;
    }>
  ): Promise<Array<{ agentId: UUID; result: HandleMessageResult; error?: Error }>> {
    const results = await Promise.all(
      messages.map(async ({ agentId, message, options }) => {
        try {
          const result = await this.handleMessage(agentId, message, options);
          return { agentId, result };
        } catch (error) {
          return {
            agentId,
            result: {
              messageId: (message.id || '') as UUID,
              userMessage: message as Memory,
            },
            error: error instanceof Error ? error : new Error(String(error)),
          };
        }
      })
    );

    this.dispatchEvent(
      new CustomEvent('messages:sent', {
        detail: { results, count: messages.length },
      })
    );

    return results;
  }

  /**
   * Validate API keys for agents
   */
  async validateApiKeys(agents?: UUID[]): Promise<Map<UUID, boolean>> {
    const results = new Map<UUID, boolean>();
    const ids = agents || Array.from(this.runtimes.keys());

    for (const id of ids) {
      const runtime = this.runtimes.get(id);
      if (runtime) {
        // Check if runtime has required API keys
        const hasKeys = !!(
          runtime.getSetting('OPENAI_API_KEY') || runtime.getSetting('ANTHROPIC_API_KEY')
        );
        results.set(id, hasKeys);
      }
    }

    return results;
  }

  /**
   * Health check for agents
   */
  async healthCheck(agents?: UUID[]): Promise<Map<UUID, HealthStatus>> {
    const results = new Map<UUID, HealthStatus>();
    const ids = agents || Array.from(this.runtimes.keys());

    for (const id of ids) {
      const runtime = this.runtimes.get(id);
      const status: HealthStatus = {
        alive: !!runtime,
        responsive: true,
      };

      // Add memory and uptime info if available (Node.js only)
      if (typeof process !== 'undefined') {
        status.memoryUsage = process.memoryUsage().heapUsed;
        status.uptime = process.uptime();
      }

      results.set(id, status);
    }

    return results;
  }

  /**
   * Get a read-only runtime accessor
   */
  getRuntimeAccessor(): ReadonlyRuntime {
    return {
      getAgent: (id: UUID) => this.getAgent(id),
      getAgents: () => this.getAgents(),
      getState: (agentId: UUID) => {
        const agent = this.getAgent(agentId);
        if (!agent) return undefined;

        // Access the most recent state from the runtime's state cache
        // Note: This returns the cached state for the most recent message
        if (agent.stateCache && agent.stateCache.size > 0) {
          // Get the most recent state from the cache
          const states = Array.from(agent.stateCache.values());
          return states[states.length - 1] as State;
        }
        return undefined;
      },
    };
  }

  /**
   * Enable editable mode for post-initialization updates
   */
  enableEditableMode(): void {
    this.editableMode = true;
    this.dispatchEvent(
      new CustomEvent('mode:editable', {
        detail: { editable: true },
      })
    );
  }
}
