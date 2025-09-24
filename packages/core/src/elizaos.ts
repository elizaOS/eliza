import { v4 as uuidv4 } from 'uuid';
import { AgentRuntime } from './runtime';
import type {
  Character,
  IAgentRuntime,
  UUID,
  Memory,
  State,
  Plugin,
} from './types';

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
  private editableMode = false;



  /**
   * Add multiple agents (batch operation)
   */
  async addAgents(agents: Array<{ character: Character; plugins?: Plugin[] }>): Promise<UUID[]> {
    const promises = agents.map(async (agent) => {
      const runtime = new AgentRuntime({
        character: agent.character,
        plugins: agent.plugins || [],
      });

      this.runtimes.set(runtime.agentId, runtime);
      
      this.dispatchEvent(
        new CustomEvent('agent:added', {
          detail: { agentId: runtime.agentId, character: agent.character },
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
    
    await Promise.all(ids.map(async (id) => {
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
    }));

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

    await Promise.all(ids.map(async (id) => {
      const runtime = this.runtimes.get(id);
      if (runtime) {
        await runtime.stop();
      }
    }));

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
    return this.getAgents().filter((runtime) =>
      nameSet.has(runtime.character.name.toLowerCase())
    );
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
    return this.getAgents().find(
      (runtime) => runtime.character.id === characterId
    );
  }

  /**
   * Send a message to a specific agent - THE ONLY WAY to send messages
   * All message sending (WebSocket, API, CLI, Tests, MessageBus) must use this method
   */
  async sendMessage(
    agentId: UUID,
    message: Memory | string,
    options?: {
      userId?: UUID;
      roomId?: UUID;
      metadata?: Record<string, any>;
    }
  ): Promise<Memory[]> {
    const runtime = this.runtimes.get(agentId);
    if (!runtime) {
      throw new Error(`Agent ${agentId} not found`);
    }

    // Convert string to Memory if needed
    const memory: Memory = typeof message === 'string' 
      ? {
          id: uuidv4() as UUID,
          entityId: options?.userId || ('system' as UUID),
          agentId,
          roomId: options?.roomId || agentId, // Default to agent's ID as room
          content: { text: message },
          createdAt: Date.now(),
          metadata: options?.metadata
        } as Memory
      : message;

    // Process directly with runtime
    const responses: Memory[] = [];
    await runtime.processActions(memory, responses);
    
    this.dispatchEvent(
      new CustomEvent('message:sent', {
        detail: { agentId, message: memory, responses },
      })
    );
    
    return responses;
  }

  /**
   * Send messages to multiple agents (batch operation)
   * All batch message sending must use this method
   */
  async sendMessages(
    messages: Array<{
      agentId: UUID;
      message: Memory | string;
      options?: {
        userId?: UUID;
        roomId?: UUID;
        metadata?: Record<string, any>;
      };
    }>
  ): Promise<Array<{agentId: UUID; responses: Memory[]; error?: Error}>> {
    const results = await Promise.all(
      messages.map(async ({agentId, message, options}) => {
        try {
          const responses = await this.sendMessage(agentId, message, options);
          return { agentId, responses };
        } catch (error) {
          return { 
            agentId, 
            responses: [], 
            error: error instanceof Error ? error : new Error(String(error))
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
          runtime.getSetting('OPENAI_API_KEY') ||
          runtime.getSetting('ANTHROPIC_API_KEY')
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