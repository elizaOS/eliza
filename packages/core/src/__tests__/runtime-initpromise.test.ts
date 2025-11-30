import { beforeEach, afterEach, describe, expect, it } from 'bun:test';
import { mock } from 'bun:test';
import { AgentRuntime } from '../runtime';
import type { Character, IDatabaseAdapter, Plugin, UUID } from '../types';
import { v4 as uuidv4 } from 'uuid';

const stringToUuid = (id: string): UUID => id as UUID;

describe('AgentRuntime initPromise Tests', () => {
    let mockAdapter: IDatabaseAdapter;
    let testCharacter: Character;
    let adapterReady = false;

    beforeEach(() => {
        adapterReady = false;

        // Create a mock database adapter
        mockAdapter = {
            db: {},
            init: mock().mockImplementation(async () => {
                adapterReady = true;
            }),
            initialize: mock().mockResolvedValue(undefined),
            isReady: mock().mockImplementation(async () => adapterReady),
            close: mock().mockImplementation(async () => {
                adapterReady = false;
            }),
            getConnection: mock().mockResolvedValue({}),
            getEntitiesByIds: mock().mockResolvedValue([]),
            getEntitiesForRoom: mock().mockResolvedValue([]),
            createEntities: mock().mockResolvedValue(true),
            getMemories: mock().mockResolvedValue([]),
            getMemoryById: mock().mockResolvedValue(null),
            getMemoriesByRoomIds: mock().mockResolvedValue([]),
            getMemoriesByIds: mock().mockResolvedValue([]),
            getCachedEmbeddings: mock().mockResolvedValue([]),
            log: mock().mockResolvedValue(undefined),
            searchMemories: mock().mockResolvedValue([]),
            createMemory: mock().mockResolvedValue(stringToUuid(uuidv4())),
            deleteMemory: mock().mockResolvedValue(undefined),
            deleteManyMemories: mock().mockResolvedValue(undefined),
            deleteAllMemories: mock().mockResolvedValue(undefined),
            countMemories: mock().mockResolvedValue(0),
            getRoomsByIds: mock().mockResolvedValue([]),
            createRooms: mock().mockResolvedValue([stringToUuid(uuidv4())]),
            deleteRoom: mock().mockResolvedValue(undefined),
            getRoomsForParticipant: mock().mockResolvedValue([]),
            getRoomsForParticipants: mock().mockResolvedValue([]),
            addParticipantsRoom: mock().mockResolvedValue(true),
            removeParticipant: mock().mockResolvedValue(true),
            getParticipantsForEntity: mock().mockResolvedValue([]),
            getParticipantsForRoom: mock().mockResolvedValue([]),
            getParticipantUserState: mock().mockResolvedValue(null),
            setParticipantUserState: mock().mockResolvedValue(undefined),
            createRelationship: mock().mockResolvedValue(true),
            getRelationship: mock().mockResolvedValue(null),
            getRelationships: mock().mockResolvedValue([]),
            getAgent: mock().mockResolvedValue(null),
            getAgents: mock().mockResolvedValue([]),
            createAgent: mock().mockResolvedValue(true),
            updateAgent: mock().mockResolvedValue(true),
            deleteAgent: mock().mockResolvedValue(true),
            ensureEmbeddingDimension: mock().mockResolvedValue(undefined),
            updateEntity: mock().mockResolvedValue(undefined),
            getComponent: mock().mockResolvedValue(null),
            getComponents: mock().mockResolvedValue([]),
            createComponent: mock().mockResolvedValue(true),
            updateComponent: mock().mockResolvedValue(undefined),
            deleteComponent: mock().mockResolvedValue(undefined),
            createWorld: mock().mockResolvedValue(stringToUuid(uuidv4())),
            getWorld: mock().mockResolvedValue(null),
            getAllWorlds: mock().mockResolvedValue([]),
            updateWorld: mock().mockResolvedValue(undefined),
            updateRoom: mock().mockResolvedValue(undefined),
            getRoomsByWorld: mock().mockResolvedValue([]),
            updateRelationship: mock().mockResolvedValue(undefined),
            getCache: mock().mockResolvedValue(undefined),
            setCache: mock().mockResolvedValue(true),
            deleteCache: mock().mockResolvedValue(true),
            createTask: mock().mockResolvedValue(stringToUuid(uuidv4())),
            getTasks: mock().mockResolvedValue([]),
            getTask: mock().mockResolvedValue(null),
            getTasksByName: mock().mockResolvedValue([]),
            updateTask: mock().mockResolvedValue(undefined),
            deleteTask: mock().mockResolvedValue(undefined),
            removeWorld: mock().mockResolvedValue(undefined),
            deleteRoomsByWorldId: mock().mockResolvedValue(undefined),
            getLogs: mock().mockResolvedValue([]),
            deleteLog: mock().mockResolvedValue(undefined),
            getAllMemories: mock().mockResolvedValue([]),
            clearAllAgentMemories: mock().mockResolvedValue(undefined),
            getMemoriesByWorldId: mock().mockResolvedValue([]),
            runMigrations: mock().mockResolvedValue(undefined),
            runPluginMigrations: mock().mockResolvedValue(undefined),
        } as any;

        testCharacter = {
            id: stringToUuid(uuidv4()),
            name: 'Test Character',
            bio: ['Test bio'],
            system: 'Test system',
            modelProvider: 'openai',
            settings: {
                model: 'gpt-4',
                secrets: {},
            },
        } as Character;

        // Mock getEntitiesByIds to return a valid entity for the agent
        mockAdapter.getEntitiesByIds = mock().mockImplementation(async (ids: UUID[]) => {
            return ids.map(id => ({
                id,
                name: 'Test Entity',
                created: new Date(),
            }));
        });
    });

    it('should create initPromise on runtime instantiation', () => {
        const runtime = new AgentRuntime({
            character: testCharacter,
            adapter: mockAdapter,
        });

        expect(runtime.initPromise).toBeDefined();
        expect(runtime.initPromise).toBeInstanceOf(Promise);
    });

    it('should resolve initPromise after successful initialization', async () => {
        const runtime = new AgentRuntime({
            character: testCharacter,
            adapter: mockAdapter,
        });

        let initPromiseResolved = false;
        runtime.initPromise.then(() => {
            initPromiseResolved = true;
        });

        await runtime.initialize();

        // Give the promise microtask queue time to resolve
        await new Promise(resolve => setTimeout(resolve, 0));

        expect(initPromiseResolved).toBe(true);
    });

    it('should reject initPromise on initialization failure', async () => {
        // Make adapter init fail
        mockAdapter.init = mock().mockRejectedValue(new Error('Database init failed'));

        const runtime = new AgentRuntime({
            character: testCharacter,
            adapter: mockAdapter,
        });

        let initPromiseRejected = false;
        let initPromiseError: Error | null = null;

        runtime.initPromise.catch((error) => {
            initPromiseRejected = true;
            initPromiseError = error;
        });

        try {
            await runtime.initialize();
        } catch (error) {
            // Expected to throw
        }

        // Give the promise microtask queue time to resolve
        await new Promise(resolve => setTimeout(resolve, 0));

        expect(initPromiseRejected).toBe(true);
        expect(initPromiseError).toBeDefined();
        expect(initPromiseError?.message).toContain('Database init failed');
    });

    it('should allow plugins to wait on initPromise before accessing database', async () => {
        let pluginInitCalled = false;
        let pluginAccessedDb = false;

        const testPlugin: Plugin = {
            name: 'test-plugin',
            description: 'Test plugin that waits on initPromise',
            init: async (_, runtime) => {
                pluginInitCalled = true;

                // Plugin should wait on initPromise before accessing database
                await runtime.initPromise;

                // Now we can safely access database methods
                pluginAccessedDb = true;
                await runtime.getTasks({ tags: ['test'] });
            },
        };

        const runtime = new AgentRuntime({
            character: testCharacter,
            plugins: [testPlugin],
            adapter: mockAdapter,
        });

        await runtime.initialize();

        expect(pluginInitCalled).toBe(true);
        expect(pluginAccessedDb).toBe(true);
        expect(mockAdapter.getTasks).toHaveBeenCalled();
    });

    it('should handle multiple async waiters on initPromise', async () => {
        const runtime = new AgentRuntime({
            character: testCharacter,
            adapter: mockAdapter,
        });

        const waiter1Results: boolean[] = [];
        const waiter2Results: boolean[] = [];
        const waiter3Results: boolean[] = [];

        // Multiple async operations waiting on initPromise
        const waiter1 = runtime.initPromise.then(() => {
            waiter1Results.push(true);
        });

        const waiter2 = runtime.initPromise.then(() => {
            waiter2Results.push(true);
        });

        const waiter3 = runtime.initPromise.then(() => {
            waiter3Results.push(true);
        });

        await runtime.initialize();

        // Wait for all promises to resolve
        await Promise.all([waiter1, waiter2, waiter3]);

        expect(waiter1Results).toEqual([true]);
        expect(waiter2Results).toEqual([true]);
        expect(waiter3Results).toEqual([true]);
    });

    it('should resolve initPromise before plugin migrations run', async () => {
        let initResolvedBeforeMigrations = false;
        let migrationsRan = false;

        // Mock the adapter to have a runPluginMigrations method
        mockAdapter.runPluginMigrations = mock().mockImplementation(async () => {
            migrationsRan = true;
            return undefined;
        });

        // Create a plugin with a schema so migrations will run
        const testPlugin: Plugin = {
            name: 'test-plugin-with-schema',
            description: 'Test plugin with schema',
            schema: {}, // Add schema so runPluginMigrations will be called
        };

        const runtime = new AgentRuntime({
            character: testCharacter,
            plugins: [testPlugin],
            adapter: mockAdapter,
        });

        runtime.initPromise.then(() => {
            // Check if migrations have already run
            if (!migrationsRan) {
                initResolvedBeforeMigrations = true;
            }
        });

        await runtime.initialize();

        // Give promises time to resolve
        await new Promise(resolve => setTimeout(resolve, 10));

        expect(initResolvedBeforeMigrations).toBe(true);
        expect(migrationsRan).toBe(true);
    });

    it('should not re-resolve initPromise on subsequent initialize calls', async () => {
        const runtime = new AgentRuntime({
            character: testCharacter,
            adapter: mockAdapter,
        });

        let resolveCount = 0;
        runtime.initPromise.then(() => {
            resolveCount++;
        });

        await runtime.initialize();
        await new Promise(resolve => setTimeout(resolve, 0));

        // Second initialization should be idempotent
        await runtime.initialize();
        await new Promise(resolve => setTimeout(resolve, 0));

        // Should only resolve once
        expect(resolveCount).toBe(1);
    });

    it('should allow services to use initPromise to defer work', async () => {
        const serviceWorkLog: string[] = [];

        const testPlugin: Plugin = {
            name: 'test-plugin',
            description: 'Test plugin with deferred service work',
            init: async (_, runtime) => {
                serviceWorkLog.push('plugin init started');

                // Defer some work until runtime is fully initialized
                runtime.initPromise.then(async () => {
                    serviceWorkLog.push('deferred work executing');

                    // Now safe to do database operations
                    await runtime.getTasks({ tags: ['deferred'] });
                    serviceWorkLog.push('deferred work complete');
                });

                serviceWorkLog.push('plugin init complete');
            },
        };

        const runtime = new AgentRuntime({
            character: testCharacter,
            plugins: [testPlugin],
            adapter: mockAdapter,
        });

        await runtime.initialize();

        // Wait for deferred work to complete
        await new Promise(resolve => setTimeout(resolve, 10));

        expect(serviceWorkLog).toEqual([
            'plugin init started',
            'plugin init complete',
            'deferred work executing',
            'deferred work complete',
        ]);
    });
});

