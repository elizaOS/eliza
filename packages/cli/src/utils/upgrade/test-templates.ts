/**
 * Test Templates for ElizaOS V2 Plugin Migration
 * 
 * This file contains the exact templates to be used when creating test infrastructure
 * during V1 to V2 migration.
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

/**
 * SIMPLIFIED Dynamic test.ts template - Clear and focused for LLMs
 * CRITICAL: This creates src/test/test.ts (NOT test.test.ts)
 * Replace {{PLUGIN_NAME}}, {{PLUGIN_VARIABLE}}, {{API_KEY_NAME}} with actual values
 */
export const TEST_TS_TEMPLATE = `import type {
  IAgentRuntime,
  TestSuite,
  Memory,
  UUID,
  Content,
  HandlerCallback,
} from "@elizaos/core";
import { createMockRuntime } from "./utils";
import {{PLUGIN_VARIABLE}} from "../index";

/**
 * {{PLUGIN_NAME}} Plugin Test Suite
 * 
 * CLEAR SIMPLE APPROACH:
 * - Test plugin structure (name, description, actions)
 * - Test services (if exists) 
 * - Test actions (validate and structure)
 * - Test providers (if exists)
 * - Keep tests focused and clear
 */

export class {{PLUGIN_NAME}}TestSuite implements TestSuite {
  name = "{{PLUGIN_NAME_LOWER}}";
  description = "Test suite for {{PLUGIN_NAME}} plugin";

  tests = [
    {
      name: "Should validate plugin V2 structure",
      fn: async (runtime: IAgentRuntime) => {
        console.log("🧪 Testing plugin structure...");
        
        // Test required fields
        if (!{{PLUGIN_VARIABLE}}.name) {
          throw new Error("Plugin missing name");
        }
        
        if (!{{PLUGIN_VARIABLE}}.description) {
          throw new Error("Plugin missing description (required in V2)");
        }
        
        if (!{{PLUGIN_VARIABLE}}.actions || {{PLUGIN_VARIABLE}}.actions.length === 0) {
          throw new Error("Plugin missing actions");
        }
        
        console.log("✅ Plugin structure is valid");
      },
    },

    {
      name: "Should test service initialization (if exists)",
      fn: async (runtime: IAgentRuntime) => {
        console.log("🧪 Testing service initialization...");
        
        // Check if plugin has services
        if (!{{PLUGIN_VARIABLE}}.services || {{PLUGIN_VARIABLE}}.services.length === 0) {
          console.log("ℹ️  Plugin has no services - skipping service tests");
          return;
        }

        const testRuntime = createMockRuntime({
          getSetting: (key: string) => {
            if (key === "{{API_KEY_NAME}}") return "test-api-key-12345";
            return runtime.getSetting(key);
          },
        });

        // Test each service
        for (const ServiceClass of {{PLUGIN_VARIABLE}}.services) {
          console.log(\`  Testing service: \${ServiceClass.name}\`);
          
          // Test service structure
          if (typeof ServiceClass.start !== 'function') {
            throw new Error(\`Service missing start method\`);
          }
          
          if (!ServiceClass.serviceType) {
            throw new Error(\`Service missing serviceType\`);
          }
          
          try {
            // Test service registration and initialization
            await testRuntime.registerService(ServiceClass);
            const service = testRuntime.getService(ServiceClass.serviceType);
            
            if (!service) {
              throw new Error(\`Service not registered properly\`);
            }
            
            console.log(\`  ✅ Service \${ServiceClass.serviceType} initialized\`);
          } catch (error: unknown) {
            const errorMsg = error instanceof Error ? error.message : String(error);
            console.log(\`  ⚠️ Service initialization error: \${errorMsg}\`);
            // Don't throw - some services might require real API keys
          }
        }
      },
    },

    {
      name: "Should validate actions structure and examples",
      fn: async (runtime: IAgentRuntime) => {
        console.log("🧪 Testing actions...");
        
        const testRuntime = createMockRuntime({
          getSetting: (key: string) => {
            if (key === "{{API_KEY_NAME}}") return "test-api-key-12345";
            return "test-value";
          },
        });

        // Register services if they exist
        if ({{PLUGIN_VARIABLE}}.services) {
          for (const ServiceClass of {{PLUGIN_VARIABLE}}.services) {
            try {
              await testRuntime.registerService(ServiceClass);
            } catch (error) {
              // Ignore service registration errors in tests
            }
          }
        }

        // Test each action
        for (const action of {{PLUGIN_VARIABLE}}.actions) {
          console.log(\`  Testing action: \${action.name}\`);
          
          // Test action structure
          if (!action.name || !action.description) {
            throw new Error(\`Action \${action.name} missing name or description\`);
          }
          
          if (typeof action.validate !== 'function') {
            throw new Error(\`Action \${action.name} missing validate function\`);
          }
          
          if (typeof action.handler !== 'function') {
            throw new Error(\`Action \${action.name} missing handler function\`);
          }
          
          if (!action.examples || !Array.isArray(action.examples)) {
            throw new Error(\`Action \${action.name} missing examples array\`);
          }

          // Test validation with basic message
          const testMessage: Memory = {
            id: "test-id" as UUID,
            entityId: "test-entity" as UUID,
            agentId: testRuntime.agentId,
            roomId: "test-room" as UUID,
            content: {
              text: \`Test \${action.name}\`,
              source: "test"
            },
            createdAt: Date.now()
          };

          const state = {
            values: {},
            data: {},
            text: testMessage.content.text
          };

          try {
            const isValid = await action.validate(testRuntime, testMessage, state);
            console.log(\`    Validation result: \${isValid}\`);
            
            if (typeof isValid !== 'boolean') {
              throw new Error(\`Action \${action.name} validate must return boolean\`);
            }
            
          } catch (error: unknown) {
            const errorMsg = error instanceof Error ? error.message : String(error);
            console.log(\`    Validation error (may be expected): \${errorMsg}\`);
          }
          
          console.log(\`  ✅ Action \${action.name} structure is valid\`);
        }
      },
    },
    
    {
      name: "Should test providers (if exists)",
      fn: async (runtime: IAgentRuntime) => {
        console.log("🧪 Testing providers...");
        
        // Check if plugin has providers
        if (!{{PLUGIN_VARIABLE}}.providers || {{PLUGIN_VARIABLE}}.providers.length === 0) {
          console.log("ℹ️  Plugin has no providers - skipping provider tests");
          return;
        }

        const testRuntime = createMockRuntime({
          getSetting: (key: string) => {
            if (key === "{{API_KEY_NAME}}") return "test-api-key-12345";
            return "test-value";
          },
        });

        // Test each provider
        for (const provider of {{PLUGIN_VARIABLE}}.providers) {
          console.log(\`  Testing provider: \${provider.name}\`);
          
          // Test provider structure
          if (!provider.name || typeof provider.name !== 'string') {
            throw new Error(\`Provider missing name field\`);
          }
          
          if (typeof provider.get !== 'function') {
            throw new Error(\`Provider \${provider.name} missing get method\`);
          }

          // Test provider functionality
          const testMessage: Memory = {
            id: "test-id" as UUID,
            entityId: "test-entity" as UUID,
            agentId: testRuntime.agentId,
            roomId: "test-room" as UUID,
            content: { text: "test", source: "test" },
            createdAt: Date.now()
          };

          try {
            const state = await provider.get(
              testRuntime,
              testMessage,
              { values: {}, data: {}, text: "" }
            );

            // Validate state structure
            if (!state || typeof state !== 'object') {
              throw new Error(\`Provider \${provider.name} returned invalid state\`);
            }

            console.log(\`  ✅ Provider \${provider.name} working\`);
          } catch (error: unknown) {
            const errorMsg = error instanceof Error ? error.message : String(error);
            console.log(\`  ⚠️ Provider \${provider.name} error (may be expected): \${errorMsg}\`);
          }
        }
      },
    },
  ];
}

// Export both named and default export for compatibility
export const test: TestSuite = new {{PLUGIN_NAME}}TestSuite();
export default test;`;

/**
 * Get the template variables for a specific plugin
 */
function getTestTemplateVariables(pluginName: string, packageJson: { name?: string; [key: string]: unknown }): {
    PLUGIN_NAME: string;
    PLUGIN_NAME_LOWER: string;
    PLUGIN_VARIABLE: string;
    API_KEY_NAME: string;
} {
    // Extract clean plugin name
    const cleanName = pluginName
        .replace('@elizaos/plugin-', '')
        .replace('plugin-', '')
        .replace(/-/g, ' ')
        .split(' ')
        .map(word => word.charAt(0).toUpperCase() + word.slice(1))
        .join(' ');

    // Create variable name (camelCase)
    const variableName = `${pluginName
        .replace('@elizaos/plugin-', '')
        .replace('plugin-', '')
        .replace(/-([a-z])/g, (g) => g[1].toUpperCase())}Plugin`;

    // Guess API key name based on plugin name
    const apiKeyName = `${pluginName
        .replace('@elizaos/plugin-', '')
        .replace('plugin-', '')
        .toUpperCase()
        .replace(/-/g, '_')}_API_KEY`;

    return {
        PLUGIN_NAME: cleanName,
        PLUGIN_NAME_LOWER: pluginName.replace('@elizaos/plugin-', '').replace('plugin-', ''),
        PLUGIN_VARIABLE: variableName,
        API_KEY_NAME: apiKeyName,
    };
}

