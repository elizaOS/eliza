import type { Character, IAgentRuntime, UUID, Memory, State, Plugin, RuntimeSettings } from './types';
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
export declare class ElizaOS extends EventTarget {
    private runtimes;
    private initFunctions;
    private editableMode;
    /**
     * Add multiple agents (batch operation)
     * Handles config and plugin resolution automatically
     */
    addAgents(agents: Array<{
        character: Character;
        plugins?: (Plugin | string)[];
        settings?: RuntimeSettings;
        init?: (runtime: IAgentRuntime) => Promise<void>;
    }>, options?: {
        isTestMode?: boolean;
    }): Promise<UUID[]>;
    /**
     * Register an existing runtime
     */
    registerAgent(runtime: IAgentRuntime): void;
    /**
     * Update an agent's character
     */
    updateAgent(agentId: UUID, updates: Partial<Character>): Promise<void>;
    /**
     * Delete agents
     */
    deleteAgents(agentIds: UUID[]): Promise<void>;
    /**
     * Start multiple agents
     */
    startAgents(agentIds?: UUID[]): Promise<void>;
    /**
     * Stop agents
     */
    stopAgents(agentIds?: UUID[]): Promise<void>;
    /**
     * Get a single agent
     */
    getAgent(id: UUID): IAgentRuntime | undefined;
    /**
     * Get all agents
     */
    getAgents(): IAgentRuntime[];
    /**
     * Get agents by IDs
     */
    getAgentsByIds(ids: UUID[]): IAgentRuntime[];
    /**
     * Get agents by names
     */
    getAgentsByNames(names: string[]): IAgentRuntime[];
    /**
     * Get agent by ID (alias for getAgent for consistency)
     */
    getAgentById(id: UUID): IAgentRuntime | undefined;
    /**
     * Get agent by name
     */
    getAgentByName(name: string): IAgentRuntime | undefined;
    /**
     * Get agent by character name (alias for getAgentByName)
     */
    getAgentByCharacterName(name: string): IAgentRuntime | undefined;
    /**
     * Get agent by character ID
     */
    getAgentByCharacterId(characterId: UUID): IAgentRuntime | undefined;
    /**
     * Send a message to a specific agent - THE ONLY WAY to send messages
     * All message sending (WebSocket, API, CLI, Tests, MessageBus) must use this method
     */
    sendMessage(agentId: UUID, message: Memory | string, options?: {
        userId?: UUID;
        roomId?: UUID;
        metadata?: Record<string, any>;
    }): Promise<Memory[]>;
    /**
     * Send messages to multiple agents (batch operation)
     * All batch message sending must use this method
     */
    sendMessages(messages: Array<{
        agentId: UUID;
        message: Memory | string;
        options?: {
            userId?: UUID;
            roomId?: UUID;
            metadata?: Record<string, any>;
        };
    }>): Promise<Array<{
        agentId: UUID;
        responses: Memory[];
        error?: Error;
    }>>;
    /**
     * Validate API keys for agents
     */
    validateApiKeys(agents?: UUID[]): Promise<Map<UUID, boolean>>;
    /**
     * Health check for agents
     */
    healthCheck(agents?: UUID[]): Promise<Map<UUID, HealthStatus>>;
    /**
     * Get a read-only runtime accessor
     */
    getRuntimeAccessor(): ReadonlyRuntime;
    /**
     * Enable editable mode for post-initialization updates
     */
    enableEditableMode(): void;
}
//# sourceMappingURL=elizaos.d.ts.map