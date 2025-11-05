import { v4 as uuidv4 } from 'uuid';
import { AgentRuntime } from './runtime';
import { setDefaultSecretsFromEnv } from './secrets';
import { resolvePlugins } from './plugin';
import type {
  Character,
  IAgentRuntime,
  UUID,
  Memory,
  State,
  Plugin,
  RuntimeSettings,
  Content,
} from './types';
import type { MessageProcessingOptions, MessageProcessingResult } from './services/message-service';

/**
 * Options for sending a message to an agent
 */
export interface SendMessageOptions {
  /**
   * Called when the agent generates a response (ASYNC MODE)
   * If provided, method returns immediately (fire & forget)
   * If not provided, method waits for response (SYNC MODE)
   */
  onResponse?: (content: Content) => Promise<void>;

  /**
   * Called if an error occurs during processing
   */
  onError?: (error: Error) => Promise<void>;

  /**
   * Called when processing is complete
   */
  onComplete?: () => Promise<void>;

  /**
   * Maximum number of retries for failed messages
   */
  maxRetries?: number;

  /**
   * Timeout duration in milliseconds
   */
  timeoutDuration?: number;

  /**
   * Enable multi-step message processing
   */
  useMultiStep?: boolean;

  /**
   * Maximum multi-step iterations
   */
  maxMultiStepIterations?: number;
}

/**
 * Result of sending a message to an agent
 */
export interface SendMessageResult {
  /** ID of the user message */
  messageId: UUID;

  /** The user message that was created */
  userMessage: Memory;

  /** Processing result (only in SYNC mode) */
  result?: MessageProcessingResult;
}

/**
 * Batch operation for sending messages
 */
export interface BatchOperation {
  agentId: UUID;
  operation: 'message' | 'action' | 'evaluate';
  payload: any;
}

/**
 * Result of a batch operation
 */
export interface BatchResult {
  agentId: UUID;
  success: boolean;
  result?: any;
  error?: Error;
}

/**
 * Read-only runtime accessor
 */
export interface ReadonlyRuntime {
  getAgent(id: UUID): IAgentRuntime | undefined;
  getAgents(): IAgentRuntime[];
  getState(agentId: UUID): State | undefined;
}

/**
 * Health status for an agent
 */
export interface HealthStatus {
  alive: boolean;
  responsive: boolean;
  memoryUsage?: number;
  uptime?: number;
}

/**
 * Update operation for an agent
 */
export interface AgentUpdate {
  id: UUID;
  character: Partial<Character>;
}

/**
 * ElizaOS - Multi-agent orchestration framework
 * Pure JavaScript implementation for browser and Node.js compatibility
 */
export class ElizaOS extends EventTarget {
  private runtimes: Map<UUID, IAgentRuntime> = new Map();
  private initFunctions: Map<UUID, (runtime: IAgentRuntime) => Promise<void>> = new Map();
  private editableMode = false;

  /**
   * Add multiple agents (batch operation)
   * Handles config and plugin resolution automatically
   */
  async addAgents(
    agents: Array<{
      character: Character;
      plugins?: (Plugin | string)[];
      settings?: RuntimeSettings;
      init?: (runtime: IAgentRuntime) => Promise<void>;
    }>,
    options?: { isTestMode?: boolean }
  ): Promise<UUID[]> {
    const promises = agents.map(async (agent) => {
      // Always merge environment secrets with character secrets
      // Priority: .env < character.json (character overrides)
      const character = agent.character;
      await setDefaultSecretsFromEnv(character);

      const resolvedPlugins = agent.plugins
        ? await resolvePlugins(agent.plugins, options?.isTestMode || false)
        : [];

      const runtime = new AgentRuntime({
        character,
        plugins: resolvedPlugins,
        settings: agent.settings || {},
      });

      this.runtimes.set(runtime.agentId, runtime);

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
          },
        })
      );

      return runtime.agentId;
    });

    const ids = await Promise.all(promises);

    this.dispatchEvent(
      new CustomEvent('agents:added', {
        detail: { agentIds: ids, count: ids.length },
      })
    );

    return ids;
  }

  /**
   * Register an existing runtime
   */
  registerAgent(runtime: IAgentRuntime): void {
    if (this.runtimes.has(runtime.agentId)) {
      throw new Error(`Agent ${runtime.agentId} already registered`);
    }

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
   * @param agentId - The agent ID to send the message to
   * @param message - Partial Memory object (missing fields auto-filled)
   * @param options - Optional callbacks and processing options
   * @returns Promise with message ID and result
   *
   * @example
   * // SYNC mode (HTTP API)
   * const result = await elizaOS.sendMessage(agentId, {
   *   entityId: user.id,
   *   roomId: room.id,
   *   content: { text: "Hello", source: 'web' }
   * });
   *
   * @example
   * // ASYNC mode (WebSocket, MessageBus)
   * await elizaOS.sendMessage(agentId, {
   *   entityId: user.id,
   *   roomId: room.id,
   *   content: { text: "Hello", source: 'websocket' }
   * }, {
   *   onResponse: async (response) => {
   *     await socket.emit('message', response.text);
   *   }
   * });
   */
  async sendMessage(
    agentId: UUID,
    message: Partial<Memory> & {
      entityId: UUID;
      roomId: UUID;
      content: Content;
      worldId?: UUID;
    },
    options?: SendMessageOptions
  ): Promise<SendMessageResult> {
    // 1. Get the runtime
    const runtime = this.runtimes.get(agentId);
    if (!runtime) {
      throw new Error(`Agent ${agentId} not found`);
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

    // 5. Extract processing options
    const processingOptions: MessageProcessingOptions = {
      maxRetries: options?.maxRetries,
      timeoutDuration: options?.timeoutDuration,
      useMultiStep: options?.useMultiStep,
      maxMultiStepIterations: options?.maxMultiStepIterations,
    };

    // 6. Determine mode: async or sync
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

      // Direct call to messageService
      runtime.messageService
        .handleMessage(runtime, userMessage, callback, processingOptions)
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

      const result = await runtime.messageService.handleMessage(
        runtime,
        userMessage,
        undefined,
        processingOptions
      );

      if (options?.onComplete) await options.onComplete();

      // Emit event for tracking
      this.dispatchEvent(
        new CustomEvent('message:sent', {
          detail: { agentId, messageId, mode: 'sync', result },
        })
      );

      return { messageId, userMessage, result };
    }
  }

  /**
   * Send messages to multiple agents in parallel
   *
   * Useful for batch operations where you need to send messages to multiple agents at once.
   * All messages are sent in parallel for maximum performance.
   *
   * @param messages - Array of messages to send, each with agentId and message data
   * @returns Promise with array of results, one per message
   *
   * @example
   * const results = await elizaOS.sendMessages([
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
  async sendMessages(
    messages: Array<{
      agentId: UUID;
      message: Partial<Memory> & {
        entityId: UUID;
        roomId: UUID;
        content: Content;
        worldId?: UUID;
      };
      options?: SendMessageOptions;
    }>
  ): Promise<Array<{ agentId: UUID; result: SendMessageResult; error?: Error }>> {
    const results = await Promise.all(
      messages.map(async ({ agentId, message, options }) => {
        try {
          const result = await this.sendMessage(agentId, message, options);
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
        const agentRuntime = agent as any;
        if (agentRuntime.stateCache && agentRuntime.stateCache.size > 0) {
          // Get the most recent state from the cache
          const states = Array.from(agentRuntime.stateCache.values());
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
