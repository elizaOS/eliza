/**
 * UTILS.TS EXACT TEMPLATE CONTENT
 * 
 * Responsibilities:
 * - Provide exact utils.ts template
 * - Mock runtime implementation
 * - Test utilities
 */

/**
 * EXACT utils.ts content - Copy this AS-IS to src/test/utils.ts
 * Based on plugin-coinmarketcap/src/test/utils.ts
 */
export const UTILS_TS_EXACT_CONTENT = `import type {
    Content,
    FragmentMetadata,
    IAgentRuntime,
    KnowledgeItem,
    Memory,
    Plugin,
    Provider,
    Service,
    State,
    TestSuite,
    UUID,
} from "@elizaos/core";
import { MemoryType, ModelType } from "@elizaos/core";
import { Buffer } from "buffer";
import * as fs from "fs";
import * as path from "path";
import { v4 as uuidv4 } from "uuid";

// Define an interface for the mock logger functions
export interface MockLogFunction extends Function {
    (...args: any[]): void;
    calls: any[][];
}

// Mock logger to capture and verify logging
export const mockLogger: {
    info: MockLogFunction;
    warn: MockLogFunction;
    error: MockLogFunction;
    debug: MockLogFunction;
    success: MockLogFunction;
    clearCalls: () => void;
} = {
    info: (() => {
        const fn: any = (...args: any[]) => {
            fn.calls.push(args);
        };
        fn.calls = [];
        return fn as MockLogFunction;
    })(),
    warn: (() => {
        const fn: any = (...args: any[]) => {
            fn.calls.push(args);
        };
        fn.calls = [];
        return fn as MockLogFunction;
    })(),
    error: (() => {
        const fn: any = (...args: any[]) => {
            fn.calls.push(args);
        };
        fn.calls = [];
        return fn as MockLogFunction;
    })(),
    debug: (() => {
        const fn: any = (...args: any[]) => {
            fn.calls.push(args);
        };
        fn.calls = [];
        return fn as MockLogFunction;
    })(),
    success: (() => {
        const fn: any = (...args: any[]) => {
            fn.calls.push(args);
        };
        fn.calls = [];
        return fn as MockLogFunction;
    })(),
    clearCalls: () => {
        mockLogger.info.calls = [];
        mockLogger.warn.calls = [];
        mockLogger.error.calls = [];
        mockLogger.debug.calls = [];
        mockLogger.success.calls = [];
    },
};

// Replace global logger with mock for tests
(global as any).logger = mockLogger;

/**
 * Creates a mock runtime with common test functionality
 */
export function createMockRuntime(overrides?: Partial<IAgentRuntime>): IAgentRuntime {
    const memories: Map<UUID, Memory> = new Map();
    const services: Map<string, Service> = new Map();

    return {
        agentId: uuidv4() as UUID,
        character: {
            name: "Test Agent",
            bio: ["Test bio"],
            knowledge: [],
        },
        providers: [],
        actions: [],
        evaluators: [],
        plugins: [],
        services,
        events: new Map(),

        // Database methods
        async init() {},
        async close() {},
        async getConnection() {
            return null as any;
        },

        async getAgent(agentId: UUID) {
            return null;
        },
        async getAgents() {
            return [];
        },
        async createAgent(agent: any) {
            return true;
        },
        async updateAgent(agentId: UUID, agent: any) {
            return true;
        },
        async deleteAgent(agentId: UUID) {
            return true;
        },
        async ensureAgentExists(agent: any) {
            return agent as any;
        },
        async ensureEmbeddingDimension(dimension: number) {},

        async getEntityById(entityId: UUID) {
            return null;
        },
        async getEntitiesForRoom(roomId: UUID) {
            return [];
        },
        async createEntity(entity: any) {
            return true;
        },
        async updateEntity(entity: any) {},

        async getComponent(entityId: UUID, type: string) {
            return null;
        },
        async getComponents(entityId: UUID) {
            return [];
        },
        async createComponent(component: any) {
            return true;
        },
        async updateComponent(component: unknown) {},
        async deleteComponent(componentId: UUID) {},

        // Memory methods with mock implementation
        async getMemoryById(id: UUID) {
            return memories.get(id) || null;
        },

        async getMemories(params: any) {
            const results = Array.from(memories.values()).filter((m) => {
                if (params.roomId && m.roomId !== params.roomId) return false;
                if (params.entityId && m.entityId !== params.entityId) return false;
                if (
                    params.tableName === "knowledge" &&
                    m.metadata?.type !== MemoryType.FRAGMENT
                )
                    return false;
                if (
                    params.tableName === "documents" &&
                    m.metadata?.type !== MemoryType.DOCUMENT
                )
                    return false;
                return true;
            });

            return params.count ? results.slice(0, params.count) : results;
        },

        async getMemoriesByIds(ids: UUID[]) {
            return ids.map((id) => memories.get(id)).filter(Boolean) as Memory[];
        },

        async getMemoriesByRoomIds(params: any) {
            return Array.from(memories.values()).filter((m) =>
                params.roomIds.includes(m.roomId)
            );
        },

        async searchMemories(params: any) {
            // Mock search - return fragments with similarity scores
            const fragments = Array.from(memories.values()).filter(
                (m) => m.metadata?.type === MemoryType.FRAGMENT
            );

            return fragments
                .map((f) => ({
                    ...f,
                    similarity: 0.8 + Math.random() * 0.2, // Mock similarity between 0.8 and 1.0
                }))
                .slice(0, params.count || 10);
        },

        async createMemory(memory: Memory, tableName: string) {
            const id = memory.id || (uuidv4() as UUID);
            const memoryWithId = { ...memory, id };
            memories.set(id, memoryWithId);
            return id;
        },

        async updateMemory(memory: any) {
            if (memory.id && memories.has(memory.id)) {
                memories.set(memory.id, { ...memories.get(memory.id)!, ...memory });
                return true;
            }
            return false;
        },

        async deleteMemory(memoryId: UUID) {
            memories.delete(memoryId);
        },

        async deleteAllMemories(roomId: UUID, tableName: string) {
            for (const [id, memory] of memories.entries()) {
                if (memory.roomId === roomId) {
                    memories.delete(id);
                }
            }
        },

        async countMemories(roomId: UUID) {
            return Array.from(memories.values()).filter((m) => m.roomId === roomId)
                .length;
        },

        // Other required methods with minimal implementation
        async getCachedEmbeddings(params: any) {
            return [];
        },
        async log(params: any) {},
        async getLogs(params: any) {
            return [];
        },
        async deleteLog(logId: UUID) {},

        async createWorld(world: any) {
            return uuidv4() as UUID;
        },
        async getWorld(id: UUID) {
            return null;
        },
        async removeWorld(id: UUID) {},
        async getAllWorlds() {
            return [];
        },
        async updateWorld(world: any) {},

        async getRoom(roomId: UUID) {
            return null;
        },
        async createRoom(room: any) {
            return uuidv4() as UUID;
        },
        async deleteRoom(roomId: UUID) {},
        async deleteRoomsByWorldId(worldId: UUID) {},
        async updateRoom(room: any) {},
        async getRoomsForParticipant(entityId: UUID) {
            return [];
        },
        async getRoomsForParticipants(userIds: UUID[]) {
            return [];
        },
        async getRooms(worldId: UUID) {
            return [];
        },

        async addParticipant(entityId: UUID, roomId: UUID) {
            return true;
        },
        async removeParticipant(entityId: UUID, roomId: UUID) {
            return true;
        },
        async getParticipantsForEntity(entityId: UUID) {
            return [];
        },
        async getParticipantsForRoom(roomId: UUID) {
            return [];
        },
        async getParticipantUserState(roomId: UUID, entityId: UUID) {
            return null;
        },
        async setParticipantUserState(roomId: UUID, entityId: UUID, state: any) {},

        async createRelationship(params: any) {
            return true;
        },
        async updateRelationship(relationship: any) {},
        async getRelationship(params: any) {
            return null;
        },
        async getRelationships(params: any) {
            return [];
        },

        async getCache(key: string) {
            return undefined;
        },
        async setCache(key: string, value: any) {
            return true;
        },
        async deleteCache(key: string) {
            return true;
        },

        async createTask(task: any) {
            return uuidv4() as UUID;
        },
        async getTasks(params: any) {
            return [];
        },
        async getTask(id: UUID) {
            return null;
        },
        async getTasksByName(name: string) {
            return [];
        },
        async updateTask(id: UUID, task: any) {},
        async deleteTask(id: UUID) {},
        async getMemoriesByWorldId(params: any) {
            return [];
        },

        // Plugin/service methods
        async registerPlugin(plugin: Plugin) {},
        async initialize() {},

        getService<T extends Service>(name: string): T | null {
            return (services.get(name) as T) || null;
        },

        getAllServices() {
            return services;
        },

        async registerService(ServiceClass: typeof Service) {
            const service = await ServiceClass.start(this);
            services.set(ServiceClass.serviceType, service);
        },

        registerDatabaseAdapter(adapter: any) {},
        setSetting(key: string, value: any) {},
        getSetting(key: string) {
            return null;
        },
        getConversationLength() {
            return 0;
        },

        async processActions(message: Memory, responses: Memory[]) {},
        async evaluate(message: Memory) {
            return null;
        },

        registerProvider(provider: Provider) {
            this.providers.push(provider);
        },
        registerAction(action: any) {},
        registerEvaluator(evaluator: any) {},

        async ensureConnection(params: any) {},
        async ensureParticipantInRoom(entityId: UUID, roomId: UUID) {},
        async ensureWorldExists(world: any) {},
        async ensureRoomExists(room: any) {},

        async composeState(message: Memory) {
            return {
                values: {},
                data: {},
                text: "",
            };
        },

        // Model methods with mocks
        async useModel(modelType: any, params: any) {
            if (modelType === ModelType.TEXT_EMBEDDING) {
                // Return mock embedding
                return new Array(1536).fill(0).map(() => Math.random()) as any;
            }
            if (
                modelType === ModelType.TEXT_LARGE ||
                modelType === ModelType.TEXT_SMALL
            ) {
                // Return mock text generation
                return \`Mock response for: \${params.prompt}\` as any;
            }
            return null as any;
        },

        registerModel(modelType: unknown, handler: unknown, provider: string) {},
        getModel(modelType: any) {
            return undefined;
        },

        registerEvent(event: string, handler: unknown) {},
        getEvent(event: string) {
            return undefined;
        },
        async emitEvent(event: string, params: unknown) {},

        registerTaskWorker(taskHandler: unknown) {},
        getTaskWorker(name: string) {
            return undefined;
        },

        async stop() {},

        async addEmbeddingToMemory(memory: Memory) {
            memory.embedding = await this.useModel(ModelType.TEXT_EMBEDDING, {
                text: memory.content.text,
            });
            return memory;
        },

        registerSendHandler(source: string, handler: unknown) {},
        async sendMessageToTarget(target: unknown, content: Content) {},

        ...overrides,
    } as IAgentRuntime;
}`; 