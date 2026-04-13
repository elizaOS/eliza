import { AgentRuntime, type UUID, type Memory } from "@elizaos/core";
import { SubagentService } from "../plugins/plugin-agent-orchestrator/typescript/src/services/subagent-service.ts";
import { describe, it, expect } from "bun:test";

// --- Inline Mock Adapter ---
const createMockAdapter = () => {
    const db = new Map<string, any>();
    const rooms = new Map<string, any>();

    const overrides: any = {
        db,
        rooms,
        init: async () => { },
        close: async () => { },
        isReady: async () => true,
        // Account/Agent
        getAccountById: async (id: UUID) => ({ id, username: "mockuser" }),
        createAccount: async () => true,
        getAgent: async (agentId: UUID) => null,
        createAgent: async () => true,
        createEntity: async () => true,
        createEntities: async () => true,
        ensureAgentExists: async () => { },
        getEntityById: async (id: UUID) => ({ id, names: ["MockEntity"], agentId: id }),
        getEntitiesByIds: async (ids: UUID[]) => ids.map(id => ({ id, names: ["MockEntity"], agentId: id })),
        // Rooms
        ensureRoomExists: async (room: any) => {
            // Mock Upsert
            rooms.set(room.id, { ...rooms.get(room.id), ...room });
        },
        getRoom: async (roomId: UUID) => {
            const r = rooms.get(roomId) || null;
            return r;
        },
        createRoom: async (room: any) => {
            const id = room.id || room;
            const roomObj = typeof room === 'object' ? room : { id };
            rooms.set(id, roomObj);
            return id;
        },
        getRoomsByIds: async (ids: UUID[]) => ids.map(id => rooms.get(id) || { id }),
        createRooms: async (roomsList: any[]) => roomsList.map(r => {
            rooms.set(r.id, r);
            return r.id;
        }),
        getRoomsForParticipant: async (userId: UUID) => {
            // Simplified: Return ALL rooms for test
            return Array.from(rooms.keys());
        },
        // Participants
        addParticipant: async () => true,
        addParticipantsRoom: async () => true,
        ensureParticipantInRoom: async () => true,
        getParticipantsForRoom: async () => [],
        // World
        getWorld: async (id: UUID) => ({ id, agentId: id, name: "World" }),
        createWorld: async (world: any) => world.id,
        updateEntity: async () => true,
        updateRoom: async (room: any) => {
            rooms.set(room.id, { ...rooms.get(room.id), ...room });
        },
        // Memories
        createMemory: async (memory: Memory, tableName: string) => {
            const key = memory.roomId + tableName;
            if (!db.has(key)) db.set(key, []);
            db.get(key).push(memory);
        },
        getMemories: async (params: any) => {
            const key = params.roomId + params.tableName;
            const list = db.get(key) || [];
            return [...list].reverse().slice(0, params.count || 10);
        },
        getMemoryById: async () => null,
    };

    return new Proxy({}, {
        get: (target, prop) => {
            if (prop in overrides) return overrides[prop];
            return async (...args: any[]) => {
                return null;
            };
        }
    });
};

// Mock Runtime setup helper
async function createMockRuntime(dbAdapter: any) {
    const runtime = new AgentRuntime({
        token: "mock-token",
        modelProvider: "openai" as any,
        character: {
            name: "ParentBot",
            username: "parentbot",
            bio: "I am a parent bot.",
            modelProvider: "openai" as any,
            clients: [],
            plugins: []
        },
        adapter: dbAdapter,
        cacheManager: { get: async () => null, set: async () => { }, delete: async () => { } } as any,
        logging: true
    });

    // Manual service registration
    const service = new SubagentService(runtime);
    // (runtime as any).services.set("SUBAGENT", service); 

    // Initialize
    console.log("Runtime Adapter check:", !!runtime.databaseAdapter, !!(runtime as any).adapter);
    await runtime.initialize();
    await service.initialize();

    return { runtime, service };
}

describe("Agent Orchestrator Persistence", () => {
    // Shared DB state across "restarts"
    const sharedDb = createMockAdapter();
    let firstRuntime: any;
    let firstService: SubagentService;
    let runId: string;

    it("Phase 1: Spawn Subagent and Persist", async () => {
        // Init First Runtime
        const { runtime, service } = await createMockRuntime(sharedDb);
        firstRuntime = runtime;
        firstService = service;

        // Register Mock LLM
        (runtime as any).registerModel("OBJECT_SMALL", async () => ({
            class: "react-app",
            task: "Build React App"
        }));
        (runtime as any).registerModel("SMALL", async () => "Mock small response");

        // Spawn
        const result = await firstService.spawnSubagent({
            name: "PersistedWorker",
            modelClass: "small",
            task: "Long running task",
            prompts: {}
        }, {
            sessionKey: "main"
        });

        console.log('Spawn Result:', result);
        runId = result.runId;
        console.log(`[Phase 1] Spawned subagent ${runId}`);

        // Verify it exists in memory
        const runs = await firstService.getSubagentsForRequester(runtime.agentId);
        expect(runs.some(r => r.runId === runId && !r.endedAt)).toBe(true);

        // Simulate "Work" (ensure DB update happened)
        await new Promise(r => setTimeout(r, 100));

        // Verify DB has the room with metadata
        const room = await (sharedDb as any).getRoom(result.childRoomId);
        expect(room).toBeDefined();
        console.log("Room Metadata:", room.metadata);
        expect(room.metadata.runId).toBe(runId);
        expect(room.metadata.isSubagent).toBe(true);
    });

    it("Phase 2: Crash and Restart (Rehydration)", async () => {
        console.log("[Phase 2] Simulating Crash (Creating new Runtime with SAME DB)...");

        // DESTROY first runtime (stop service)
        await firstService.stop();

        // Create SECOND runtime connected to SAME DB
        const { runtime: secondRuntime, service: secondService } = await createMockRuntime(sharedDb);

        console.log("[Phase 2] Second runtime initialized.");

        // check internal state
        // access private map via 'any' for testing
        const internalMap = (secondService as any).subagentRuns;
        const record = internalMap.get(runId);

        if (!record) {
            console.error("Available runs:", Array.from(internalMap.keys()));
        }
        expect(record).toBeDefined();
        expect(record.runId).toBe(runId);
        console.log(`[Phase 2] Rehydrated record status: ${record.outcome?.status || 'Active'}`);

        // It should be marked as "Active" or "Interrupted"
        // Since test runs fast, it's likely "Process restarted (Interrupted)"
        expect(record.endedAt).toBeDefined();
        expect(record.outcome).toBeDefined();
        expect(record.outcome.error).toContain("Process restarted");

    });
});
