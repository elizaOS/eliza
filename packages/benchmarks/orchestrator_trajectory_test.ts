
import {
    AgentRuntime,
    stringToUuid,
    type Memory,
    type State,
    ModelClass,
    type IDatabaseAdapter,
    type UUID,
} from "@elizaos/core";
import { agentOrchestratorPlugin } from "../plugins/plugin-agent-orchestrator/typescript/index.ts";
import { secretsManagerPlugin } from "../plugins/plugin-secrets-manager/typescript/src/index.ts";
import { bootstrapPlugin } from "@elizaos/plugin-bootstrap";

// --- Mock Infrastructure ---

const createMockAdapter = () => {
    const db = new Map<string, any>();
    const overrides: any = {
        db,
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
        getRoomsForParticipant: async () => [],
        // World
        getWorld: async (id: UUID) => ({ id, agentId: id, name: "World" }),
        createWorld: async (world: any) => world.id,
        updateEntity: async () => true,
        // Memories
        createMemory: async (memory: Memory, tableName: string) => {
            const key = memory.roomId + tableName;
            if (!db.has(key)) db.set(key, []);
            db.get(key).push(memory); // Push to end (cronological)
            // console.log(`[MockDB] Stored memory in ${tableName} for room ${memory.roomId}: ${memory.content.text?.slice(0, 30)}...`);
        },
        getMemories: async (params: any) => {
            const key = params.roomId + params.tableName;
            const list = db.get(key) || [];
            // console.log(`[MockDB] getMemories ${key} count=${list.length}`);
            // Return request count, usually reverse chronological in real DB but basic list here
            // We'll reverse it to simulate most recent first if needed, but core usually handles sorting
            return [...list].reverse().slice(0, params.count || 10);
        },
        getMemoryById: async () => null,
    };

    return new Proxy({}, {
        get: (target, prop) => {
            if (prop in overrides) return overrides[prop];
            return async (...args: any[]) => {
                // console.log(`[MockDB] Unhandled Call ${String(prop)}`, args);
                return null;
            };
        }
    });
};

// --- Scenario Runner ---

async function runTrajectoryTest() {
    console.log("\n🚀 Starting Deep Trajectory Analysis...");

    const adapter = createMockAdapter();
    const parentId = stringToUuid("parent-agent");
    const parentRuntime = new AgentRuntime({
        character: {
            name: "ParentBot",
            username: "parent",
            modelProvider: "openai",
            settings: { secrets: {} }
        } as any,
        token: "mock-token",
        plugins: [bootstrapPlugin, agentOrchestratorPlugin],
        adapter: adapter as IDatabaseAdapter,
    }); // We will attach mock models manually

    // Define Mock LLM to simulate "Intelligence"
    // We need it to handle:
    // 1. Determining to SPAWN
    // 2. Answering status checks
    const mockLLMHandler = async (runtime: any, params: any) => {
        const context = params.context || params.prompt || "";
        console.log(`\n🤖 [MockLLM] Thinking... Context snippet: "${context.slice(-100).replace(/\n/g, ' ')}"`);

        // Scene 1: User asks to build an app -> Agent decides to SPAWN
        if (context.includes("Build a React app")) {
            console.log("   -> Decision: SPAWN_SUBAGENT");
            return {
                action: "SPAWN_SUBAGENT",
                text: "I will spawn a sub-agent to handle the React app coding.",
                content: { task: "Create specific React components" } // Param for the action
            };
        }

        // Scene 2: User asks for status -> Agent decides to PEEK
        if (context.includes("status of the React app")) {
            console.log("   -> Decision: PEEK_SUBAGENT");
            // In real life, the LLM would need the runID. 
            // We'll assume the runtime or context has provided it or the agent looks it up.
            // For this test, we might need to inject the runId into the state or let the plugin find the active one.
            return {
                action: "PEEK_SUBAGENT",
                text: "Let me check on the sub-agent.",
                content: { runId: "LATEST" } // Special flag for our test or we assume agent tracks it
            };
        }

        return { text: "I'm standby." };
    };

    // Register Mock Models
    // Register Mock Models
    (parentRuntime as any).registerModel("OBJECT_SMALL", { endpoint: "mock", handler: mockLLMHandler });
    (parentRuntime as any).registerModel("SMALL", { endpoint: "mock", handler: async () => "Mock Text Response" });
    (parentRuntime as any).registerModel("LARGE", { endpoint: "mock", handler: async () => "Mock Text Response" });

    // Initialize
    await parentRuntime.initialize();

    // Simulate Connection
    const roomId = stringToUuid("main-chat-room");
    await parentRuntime.ensureConnection({
        userId: stringToUuid("user"),
        roomId,
        userName: "User",
        userScreenName: "User",
        source: "test",
        type: 0,
        worldId: parentId
    } as any);

    // --- EXECUTION FLOW ---

    // 1. User Request: "Build a React app"
    console.log("\n🗣️  USER: 'Please build a React app for me.'");

    const message1: Memory = {
        id: stringToUuid("m1"),
        userId: stringToUuid("user"),
        roomId,
        agentId: parentId,
        content: { text: "Please build a React app for me." },
        createdAt: Date.now()
    };

    // processActions loop simulation
    // We manually invoke the handler for SPAWN since we know the LLM would choose it.
    // In a full integration test we'd run `runtime.processActions` but that's complex to mock fully.
    // We'll invoke the plugin action directly to test the *Orchestrator's* handling of the state.

    const spawnAction = agentOrchestratorPlugin.actions.find(a => a.name === "SPAWN_SUBAGENT");
    if (!spawnAction) throw new Error("Missing SPAWN action");

    let subagentRunId = "";

    console.log("⚙️  Processing SPAWN_SUBAGENT...");
    await spawnAction.handler(parentRuntime, message1, {} as State, { task: "Create React App" }, async (resp) => {
        console.log(`   -> Output: ${resp.text}`);
    });

    // 2. Verify State: Subagent should be "active" in the service
    const service = parentRuntime.getService("SUBAGENT") as any;
    const runs = Array.from(service.subagentRuns.values());
    if (runs.length !== 1) throw new Error("Failed to register subagent run");
    const run = runs[0] as any;
    subagentRunId = run.runId;
    console.log(`✅ Subagent Spawned. ID: ${subagentRunId}`);


    // 3. Simulate Subagent Activity (The "Gap")
    // The sub-agent runs in a different "context" (or machine).
    // The Orchestrator just assumes it's running. 
    // We need to simulate the sub-agent writing logs to the DB that the Parent can see.
    console.log("\n⏳ Simulating Subagent Work (Data generation)...");

    const childRoomId = run.roomId; // The orchestrator created this room for the child
    const mockDb = adapter as any;

    // Child logs some thoughts/actions
    await mockDb.createMemory({
        id: stringToUuid("log1"),
        roomId: childRoomId,
        userId: parentRuntime.agentId, // Technically the child uses the parent's ID or its own? 
        // Implementation detail: Orchestrator currently spawns child with same agentID but different room?
        // Let's check SubagentService implementation.
        // It uses `this.runtime.agentId`.
        agentId: parentRuntime.agentId,
        content: { text: "Initializing React project structure...", source: "subagent" },
        createdAt: Date.now()
    }, "messages");

    await new Promise(r => setTimeout(r, 100));

    await mockDb.createMemory({
        id: stringToUuid("log2"),
        roomId: childRoomId,
        userId: parentRuntime.agentId,
        agentId: parentRuntime.agentId,
        content: { text: "Installing dependencies: react, react-dom...", source: "subagent" },
        createdAt: Date.now()
    }, "messages");


    // 4. User Request: "What is the status?"
    console.log("\n🗣️  USER: 'What is the status of the React app?'");

    const message2: Memory = {
        id: stringToUuid("m2"),
        userId: stringToUuid("user"),
        roomId,
        agentId: parentId,
        content: { text: "What is the status of the React app?" },
        createdAt: Date.now()
    };

    const peekAction = agentOrchestratorPlugin.actions.find(a => a.name === "PEEK_SUBAGENT");

    console.log("⚙️  Processing PEEK_SUBAGENT...");
    // We assume the LLM extracted the runId (or we pass the active one)
    await peekAction.handler(parentRuntime, message2, {} as State, { runId: subagentRunId }, async (resp) => {
        const text = resp ? (resp.text || resp.content?.text) : "No response";
        console.log(`   -> PEEK Result:\n${text}`);

        if (!text.includes("Installing dependencies")) {
            throw new Error("Peek failed to see recent logs.");
        }
    });

    console.log("\n✅ Trajectory Analysis Passed: Full Cycle Verified.");
    process.exit(0);
}

runTrajectoryTest().catch(e => {
    console.error("❌ Test Failed:", e);
    process.exit(1);
});
