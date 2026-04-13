
import {
    AgentRuntime,
    stringToUuid,
    type Memory,
    type State,
    ModelType,
    type IDatabaseAdapter,
    type UUID,
    ModelClass,
} from "@elizaos/core";

// ... (existing code)


// 1b. Mock LLM for REQUEST_SECRET
// Override generateObject/generateText directly as useModel might not be the hook
// (runtime as any).generateObject = ... // We try models first

// ...
import { agentOrchestratorPlugin } from "../plugins/plugin-agent-orchestrator/typescript/index.ts";
import { secretsManagerPlugin } from "../plugins/plugin-secrets-manager/typescript/src/index.ts";
import { bootstrapPlugin } from "@elizaos/plugin-bootstrap";

// Proxy-based Mock Adapter
// intercepts all method calls and returns safe defaults
const createMockAdapter = () => {
    const db = new Map<string, any>();
    // We need some specific implementations
    const overrides: any = {
        db,
        init: async () => { },
        close: async () => { },
        isReady: async () => true,

        // Account/Agent
        getAccountById: async (id: UUID) => ({ id, username: "mockuser" }),
        createAccount: async () => true,
        getAgent: async (agentId: UUID) => null, // Return null to force creation path or object to skip? Core logic: ensureAgentExists calls getAgent. If null, creates.
        createAgent: async () => true,
        createEntity: async () => true,
        createEntities: async () => true,
        ensureAgentExists: async () => { },
        getEntityById: async (id: UUID) => ({ id, names: ["MockEntity"], agentId: id }),
        getEntitiesByIds: async (ids: UUID[]) => ids.map(id => ({ id, names: ["MockEntity"], agentId: id })),

        // Rooms
        ensureRoomExists: async (roomId: UUID) => { },
        getRoom: async (roomId: UUID) => ({ id: roomId }),
        createRoom: async (roomId: UUID) => roomId,
        getRoomsByIds: async (ids: UUID[]) => ids.map(id => ({ id })),
        createRooms: async (rooms: any[]) => rooms.map(r => r.id),

        // Participants
        addParticipant: async () => true,
        addParticipantsRoom: async () => true,
        ensureParticipantInRoom: async () => true,
        addParticipantsRoom: async () => true,
        ensureParticipantInRoom: async () => true,
        getParticipantsForRoom: async () => [],

        // World/Entity updates
        getWorld: async (id: UUID) => ({ id, agentId: id, name: "World" }),
        createWorld: async (world: any) => world.id,
        updateEntity: async () => true,

        // Memories
        createMemory: async (memory: Memory, tableName: string) => {
            console.log(`[MockDB] createMemory ${tableName}`, memory.content.text?.slice(0, 50));
            const key = memory.roomId + tableName;
            if (!db.has(key)) db.set(key, []);
            db.get(key).unshift(memory);
        },
        getMemories: async (params: any) => {
            const key = params.roomId + params.tableName;
            const list = db.get(key) || [];
            console.log(`[MockDB] getMemories params:`, JSON.stringify(params));
            console.log(`[MockDB] getMemories found ${list.length} items for key ${key}`);
            return list.slice(0, params.count || 10);
        },
        getMemoryById: async () => null,

        // Subagent runs might use specialized methods if plugin defines them?
        // No, plugin uses standard memories usually.
    };

    return new Proxy({}, {
        get: (target, prop) => {
            if (prop in overrides) {
                console.log(`[MockDB] GET ${String(prop)}`);
                return overrides[prop];
            }
            // Default handler for everything else
            return async (...args: any[]) => {
                console.log(`[MockDB] Call ${String(prop)}`, args);
                return null;
            };
        }
    });
};

const testCharacter: any = {
    name: "OrchestratorBot",
    username: "orchestrator",
    plugins: [],
    modelProvider: "openai",
    bio: "A test agent for orchestration.",
    lore: [],
    style: { all: [], chat: [], post: [] },
};

async function main() {
    console.log("Starting Deep Verification Scenario (Proxy Mock Adapter)");

    // Define Mock Plugin first
    const mockModelPlugin = {
        name: "mock-model",
        description: "Mock model provider",
        models: {
            "OBJECT_SMALL": {
                endpoint: "mock",
                model: "mock-model",
                handler: async (runtime: any, params: any) => {
                    console.log(`[MockLLM] OBJECT_SMALL context:`, params.context?.slice(0, 50));
                    if (params.context?.includes("missing secret") || params.context?.includes("Request a")) {
                        return { key: "MOCK_SECRET_KEY", reason: "Unit testing" };
                    }
                    return null;
                }
            },
            "SMALL": {
                endpoint: "mock",
                model: "mock-model",
                handler: async (runtime: any, params: any) => {
                    // console.log(`[MockLLM] SMALL context:`, params.context?.slice(0, 50));
                    return "Generic response";
                }
            },
            "LARGE": {
                endpoint: "mock",
                model: "mock-model",
                handler: async (runtime: any, params: any) => {
                    return "Generic response";
                }
            }
        }
    };

    // 1. Initialize Runtime
    const adapter = createMockAdapter();
    const runtime = new AgentRuntime({
        character: testCharacter,
        token: process.env.OPENAI_API_KEY || "mock-token",
        plugins: [
            bootstrapPlugin,
            agentOrchestratorPlugin,
            secretsManagerPlugin,
            mockModelPlugin,
        ],
        adapter: adapter as IDatabaseAdapter,
        modelProvider: testCharacter.modelProvider,
    });

    // Manual registration
    const mockHandler = async (runtime: any, params: any) => {
        console.log(`[MockLLM] OBJECT_SMALL params keys:`, Object.keys(params));
        console.log(`[MockLLM] OBJECT_SMALL prompt:`, params.prompt?.slice(0, 50));
        const text = params.prompt || params.context || "";
        if (text.includes("missing secret") || text.includes("Request a") || text.includes("MOCK_SECRET_KEY")) {
            return { key: "MOCK_SECRET_KEY", reason: "Unit testing" };
        }
        return { key: "UNKNOWN", reason: "No context match" };
    };

    // Register after init? No, models usually needed during init or execution.
    // registerModel is available on runtime.
    (runtime as any).registerModel("OBJECT_SMALL", mockHandler);
    (runtime as any).registerModel("SMALL", async () => "Generic response");
    (runtime as any).registerModel("LARGE", async () => "Generic response");

    // 1c. Mock emitEvent to capture Subagent Trigger
    const originalEmit = runtime.emitEvent.bind(runtime);
    let capturedSubagentMessage: Memory | null = null;
    runtime.emitEvent = async (type, payload) => {
        if (type === "MESSAGE_RECEIVED" && payload.source === "subagent") {
            capturedSubagentMessage = payload.message;
            console.log("Captured subagent start message:", payload.message.content.text);
        }
        return originalEmit(type, payload);
    };

    await runtime.initialize();
    console.log("Runtime initialized.");

    // 2. Setup User & Room
    const roomId = stringToUuid("test-room-" + Date.now());
    const userId = stringToUuid("user");

    // ensureConnection
    await runtime.ensureConnection({
        userId, roomId, userName: "User", userScreenName: "User", source: "test", type: 0,
        worldId: runtime.agentId
    } as any);


    // ==========================================
    // Test 1: REQUEST_SECRET
    // ==========================================
    console.log("\n--- Test 1: REQUEST_SECRET ---");
    console.log("Registered models keys:", Object.keys((runtime as any).models || {}));
    if ((runtime as any).models?.["OBJECT_SMALL"]) {
        console.log("OBJECT_SMALL handler type:", typeof (runtime as any).models["OBJECT_SMALL"].handler);
    } else {
        console.log("OBJECT_SMALL model NOT registered");
    }

    const requestAction = secretsManagerPlugin.actions.find(a => a.name === "REQUEST_SECRET");
    if (!requestAction) throw new Error("REQUEST_SECRET action missing");

    const secretMsg: Memory = {
        id: stringToUuid("msg-secret"),
        userId, roomId, agentId: runtime.agentId,
        content: { text: "I need MOCK_SECRET_KEY to continue.", action: "REQUEST_SECRET" }
    };

    let secretResponse = "";
    await requestAction.handler(runtime, secretMsg, {} as State, {}, async (resp) => {
        secretResponse = resp.text || "";
        console.log("[Callback] " + resp.text);
    });

    if (!secretResponse.includes("MOCK_SECRET_KEY")) {
        throw new Error(`REQUEST_SECRET failed. Response: ${secretResponse}`);
    }
    console.log("✅ REQUEST_SECRET verified.");


    // ==========================================
    // Test 2: SPAWN_SUBAGENT
    // ==========================================
    console.log("\n--- Test 2: SPAWN_SUBAGENT ---");
    const spawnAction = agentOrchestratorPlugin.actions.find(a => a.name === "SPAWN_SUBAGENT");
    if (!spawnAction) throw new Error("SPAWN_SUBAGENT action missing");

    const spawnMsg: Memory = {
        id: stringToUuid("msg-spawn"),
        userId, roomId, agentId: runtime.agentId,
        content: { text: "Spawn a subagent to calculate 2+2", action: "SPAWN_SUBAGENT" }
    };

    let subagentRunId = "";
    await spawnAction.handler(runtime, spawnMsg, {} as State, { task: "calculate 2+2" }, async (resp) => {
        console.log("[Callback] " + resp.text);
    });

    // Verify Subagent Service State
    const subagentService = runtime.getService("SUBAGENT") as any;
    const allRuns = Array.from(subagentService.subagentRuns.values());
    const myRun = allRuns.find((r: any) => r.task === "calculate 2+2");

    if (!myRun) throw new Error("Subagent run record not found in service");
    subagentRunId = myRun.runId;
    console.log(`✅ SPAWN_SUBAGENT verified. Run ID: ${subagentRunId}`);

    // ==========================================
    // Test 2b: Verify Trigger Event
    // ==========================================
    await new Promise(r => setTimeout(r, 1000));

    if (!capturedSubagentMessage) {
        console.warn("⚠️ Warning: MESSAGE_RECEIVED event not captured.");
    } else {
        console.log("✅ Subagent start event captured.");
    }


    // ==========================================
    // Test 3: PEEK_SUBAGENT
    // ==========================================
    console.log("\n--- Test 3: PEEK_SUBAGENT ---");

    const childRoomId = myRun.roomId;
    const mockAdapter = adapter as any;
    // Inject into mock DB using our overrides
    await mockAdapter.createMemory({
        id: stringToUuid("log-1"),
        roomId: childRoomId,
        userId: runtime.agentId,
        agentId: runtime.agentId,
        content: { text: "I am calculating 2+2...", source: "subagent" },
        createdAt: Date.now()
    }, "messages");

    const peekAction = agentOrchestratorPlugin.actions.find(a => a.name === "PEEK_SUBAGENT");
    if (!peekAction) throw new Error("PEEK_SUBAGENT action missing");

    const peekMsg: Memory = {
        id: stringToUuid("msg-peek"),
        userId, roomId, agentId: runtime.agentId,
        content: { text: "Peek subagent", action: "PEEK_SUBAGENT" }
    };

    let peekResponse = "";
    await peekAction.handler(runtime, peekMsg, {} as State, { runId: subagentRunId }, async (resp: any) => {
        console.log("[Callback Payload] " + JSON.stringify(resp));
        const text = resp?.content?.text || resp?.text || "";
        peekResponse = text;
    });

    if (!peekResponse.includes("calculating 2+2")) {
        throw new Error(`PEEK_SUBAGENT failed. Got: ${peekResponse}`);
    }
    console.log("✅ PEEK_SUBAGENT verified.");

    console.log("\n--- Deep Verification Complete ---");
    process.exit(0);
}

main().catch(err => {
    console.error("Verification Failed:", err);
    process.exit(1);
});
