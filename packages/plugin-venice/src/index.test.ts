import { describe, expect, it } from 'bun:test';
import { venicePlugin } from './index';
import { type IAgentRuntime, ModelType, type Memory, type UUID, type Character } from '@elizaos/core';

describe('VenicePlugin', () => {
    const mockCharacter: Character = {
        name: 'Test Agent',
        bio: 'A test agent for Venice plugin',
        system: 'test system prompt',
        username: 'test-agent',
    };

    const mockFetch = async (url: string, options: RequestInit) => {
        const headers = options.headers as Record<string, string>;
        if (!headers?.Authorization || headers.Authorization !== 'Bearer test-key') {
            return new Response(null, { status: 401, statusText: 'Unauthorized' });
        }

        if (url.endsWith('/models')) {
            return new Response(JSON.stringify({ models: [] }), {
                status: 200,
                headers: { 'Content-Type': 'application/json' }
            });
        }
        if (url.endsWith('/embeddings')) {
            const body = JSON.parse(options.body as string);
            if (!body.model || !body.input) {
                return new Response(null, { status: 400, statusText: 'Bad Request' });
            }
            return new Response(JSON.stringify({
                data: [{
                    embedding: new Array(4096).fill(0.1),
                }]
            }), {
                status: 200,
                headers: { 'Content-Type': 'application/json' }
            });
        }
        return new Response(null, { status: 404 });
    };

    const mockRuntime = {
        getSetting: (key: string) => {
            switch (key) {
                case 'VENICE_API_KEY':
                    return 'test-key';
                case 'VENICE_SMALL_MODEL':
                    return 'llama-3.3-70b';
                case 'VENICE_LARGE_MODEL':
                    return 'llama-3.1-405b';
                case 'VENICE_EMBEDDING_MODEL':
                    return 'llama-3.3-70b';
                case 'VENICE_EMBEDDING_DIMENSIONS':
                    return '4096';
                default:
                    return undefined;
            }
        },
        character: mockCharacter,
        agentId: 'test-agent' as UUID,
        providers: [],
        actions: [],
        evaluators: [],
        plugins: [],
        services: new Map(),
        events: new Map(),
        routes: [],
        fetch: mockFetch,
        logger: console,
        metrics: {
            increment: () => { },
            timing: () => { },
            gauge: () => { },
        },
        registerPlugin: async () => { },
        initialize: async () => { },
        getKnowledge: async () => [],
        addKnowledge: async () => { },
        getService: () => null,
        getAllServices: () => new Map(),
        registerService: () => { },
        registerDatabaseAdapter: () => { },
        setSetting: () => { },
        getConversationLength: () => 0,
        processActions: async () => { },
        evaluate: async () => null,
        registerProvider: () => { },
        registerAction: () => { },
        registerEvaluator: () => { },
        ensureConnection: async () => { },
        ensureParticipantInRoom: async () => { },
        ensureWorldExists: async () => { },
        ensureRoomExists: async () => { },
        composeState: async () => ({ values: {}, data: {}, text: '' }),
        useModel: async () => ({}),
        registerModel: () => { },
        getModel: () => undefined,
        registerEvent: () => { },
        getEvent: () => [],
        emitEvent: async () => { },
        registerTaskWorker: () => { },
        getTaskWorker: () => undefined,
        stop: async () => { },
        addEmbeddingToMemory: async (memory: Memory) => memory,
        // Database adapter methods
        db: null,
        init: async () => { },
        close: async () => { },
        getAgent: async () => null,
        getAgents: async () => [],
        createAgent: async () => true,
        updateAgent: async () => true,
        deleteAgent: async () => true,
        ensureAgentExists: async () => { },
        ensureEmbeddingDimension: async () => { },
        getEntityById: async () => null,
        getEntitiesForRoom: async () => [],
        createEntity: async () => true,
        updateEntity: async () => { },
        getComponent: async () => null,
        getComponents: async () => [],
        createComponent: async () => true,
        updateComponent: async () => { },
        deleteComponent: async () => { },
        getMemories: async () => [],
        getMemoryById: async () => null,
        getMemoriesByIds: async () => [],
        getMemoriesByRoomIds: async () => [],
        getCachedEmbeddings: async () => [],
        log: async () => { },
        getLogs: async () => [],
        deleteLog: async () => { },
        searchMemories: async () => [],
        createMemory: async () => 'test-id' as UUID,
        updateMemory: async () => true,
        deleteMemory: async () => { },
        deleteAllMemories: async () => { },
        countMemories: async () => 0,
        createWorld: async () => 'test-id' as UUID,
        getWorld: async () => null,
        getAllWorlds: async () => [],
        updateWorld: async () => { },
        getRoom: async () => null,
        createRoom: async () => 'test-id' as UUID,
        deleteRoom: async () => { },
        updateRoom: async () => { },
        getRoomsForParticipant: async () => [],
        getRoomsForParticipants: async () => [],
        getRooms: async () => [],
        addParticipant: async () => true,
        removeParticipant: async () => true,
        getParticipantsForEntity: async () => [],
        getParticipantsForRoom: async () => [],
        getParticipantUserState: async () => null,
        setParticipantUserState: async () => { },
        createRelationship: async () => true,
        updateRelationship: async () => { },
        getRelationship: async () => null,
        getRelationships: async () => [],
        getCache: async () => undefined,
        setCache: async () => true,
        deleteCache: async () => true,
        createTask: async () => 'test-id' as UUID,
        getTasks: async () => [],
        getTask: async () => null,
        getTasksByName: async () => [],
        updateTask: async () => { },
        deleteTask: async () => { },
    } as unknown as IAgentRuntime;

    it('should have correct plugin metadata', () => {
        expect(venicePlugin.name).toBe('venice');
        expect(venicePlugin.description).toBe('Venice AI plugin');
    });

    it('should initialize without errors', async () => {
        const result = await venicePlugin.init({}, mockRuntime);
        expect(result).toBeUndefined();
    });

    it('should have text embedding model handler', () => {
        expect(venicePlugin.models[ModelType.TEXT_EMBEDDING]).toBeDefined();
    });

    it('should generate text embeddings', async () => {
        const embeddingHandler = venicePlugin.models[ModelType.TEXT_EMBEDDING];
        expect(embeddingHandler).toBeDefined();

        const result = await embeddingHandler(mockRuntime, {
            text: 'test text',
            runtime: mockRuntime,
        });

        expect(result).toBeDefined();
        expect(Array.isArray(result.embedding)).toBe(true);
        expect(result.dimensions).toBe(4096);
        expect(result.embedding.length).toBe(4096);
    });
}); 