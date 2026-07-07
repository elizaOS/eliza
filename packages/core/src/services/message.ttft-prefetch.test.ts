/**
 * TTFT prefetch behavior through the real DefaultMessageService.handleMessage:
 * (1) the shared per-turn recall-query embed is warmed once, after the cheap
 * short-circuit gates but before the serial pre-compose work, and lands in the
 * per-run cache that the compose-time recall providers (relevant-conversations,
 * document recall, experience recall) and the FACTS path hit via the same
 * `embedRecallQuery` seam and text normalization; a dropped turn (muted / LLM
 * off) issues no embed; (2) the Stage-1 sender role is resolved once per turn
 * and reused by the pre-LLM shortcut gate through the trajectory context
 * instead of a second room+world lookup. Fake runtime over real service code,
 * no live model; the turn runs the deterministic no-model reply path.
 */
import { describe, expect, it, vi } from "vitest";
import { embedRecallQuery } from "../features/documents/recall-embed";
import { TurnControllerRegistry } from "../runtime/turn-controller";
import type { Room, World } from "../types/environment";
import type { IAgentRuntime, Memory, UUID } from "../types/index";
import { ModelType } from "../types/index";
import { DefaultMessageService } from "./message";

const AGENT_ID = "00000000-0000-0000-0000-0000000000a1" as UUID;
const USER_ID = "00000000-0000-0000-0000-0000000000c1" as UUID;
const ROOM_ID = "00000000-0000-0000-0000-0000000000d1" as UUID;
const WORLD_ID = "00000000-0000-0000-0000-0000000000e1" as UUID;
const RUN_ID = "00000000-0000-0000-0000-0000000000f1" as UUID;
const MESSAGE_ID = "00000000-0000-0000-0000-0000000000e2" as UUID;
const WARM_VECTOR = [0.11, 0.22, 0.33];

interface RuntimeOptions {
	/** Seed a MUTED participant state to exercise the early mute drop. */
	muted?: boolean;
	/** Force LLM-off-by-default so the turn drops before compose. */
	llmOff?: boolean;
}

function makeRuntime(opts: RuntimeOptions = {}) {
	const room: Room = {
		id: ROOM_ID,
		source: "client_chat",
		type: "DM",
		worldId: WORLD_ID,
	} as Room;
	const world: World = {
		id: WORLD_ID,
		agentId: AGENT_ID,
		name: "Home",
		metadata: { roles: { [USER_ID]: "ADMIN" } },
	} as World;
	// `getWorld` is the observable proxy for a Stage-1 role resolution:
	// `resolveStage1SenderRole` → `checkSenderRole` → `resolveWorldForMessage`
	// fetches the world on every call, so its call count reveals how many times
	// the role was resolved across the turn.
	const getWorld = vi.fn(async (worldId: UUID) =>
		worldId === WORLD_ID ? world : null,
	);
	const useModel = vi.fn(async (modelType: string) => {
		if (modelType === ModelType.TEXT_EMBEDDING) return WARM_VECTOR;
		throw new Error(`unexpected non-embedding model call: ${modelType}`);
	});
	const runtime = {
		agentId: AGENT_ID,
		character: { name: "Eliza" },
		logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
		stateCache: new Map(),
		turnControllers: new TurnControllerRegistry(),
		startRun: vi.fn(() => RUN_ID),
		getCurrentRunId: vi.fn(() => RUN_ID),
		emitEvent: vi.fn(async () => undefined),
		runActionsByMode: vi.fn(async () => undefined),
		reportError: vi.fn(),
		useModel,
		getSetting: vi.fn((key: string) =>
			key === "BASIC_CAPABILITIES_DEFLLMOFF" && opts.llmOff
				? "true"
				: undefined,
		),
		getRoom: vi.fn(async (roomId: UUID) => (roomId === ROOM_ID ? room : null)),
		getWorld,
		updateRoom: vi.fn(async () => undefined),
		updateWorld: vi.fn(async () => undefined),
		getService: vi.fn(() => null),
		getServicesByType: vi.fn(() => []),
		// No text-generation handler: the turn runs the deterministic no-model
		// path (shortcut gate → should-respond → injection gate → no-model reply),
		// exercising the prefetch and both role-reuse call sites without a model.
		getModel: vi.fn(() => null),
		isCheckShouldRespondEnabled: vi.fn(() => false),
		getMemoryById: vi.fn(async () => null),
		getMemories: vi.fn(async () => []),
		getRoomsByIds: vi.fn(async () => [room]),
		createMemory: vi.fn(async (memory: Memory) => memory.id),
		queueEmbeddingGeneration: vi.fn(async () => undefined),
		getParticipantUserState: vi.fn(async () => (opts.muted ? "MUTED" : null)),
		updateParticipantUserState: vi.fn(async () => undefined),
		applyPipelineHooks: vi.fn(async () => undefined),
		composeState: vi.fn(async () => ({ values: {}, data: {}, text: "" })),
		actions: [],
		providers: [],
		evaluators: [],
	} as unknown as IAgentRuntime;
	return { runtime, useModel, getWorld };
}

function userMessage(text: string): Memory {
	return {
		id: MESSAGE_ID,
		entityId: USER_ID,
		agentId: AGENT_ID,
		roomId: ROOM_ID,
		content: { text, source: "client_chat", channelType: "DM" },
	} as unknown as Memory;
}

describe("recall-query embed prefetch (per-turn cache warm)", () => {
	it("fires exactly one TEXT_EMBEDDING call with the message text", async () => {
		const { runtime, useModel } = makeRuntime();
		const service = new DefaultMessageService();
		const text = "what did we discuss about the roadmap?";

		await service.handleMessage(runtime, userMessage(text));

		const embedCalls = useModel.mock.calls.filter(
			([modelType]) => modelType === ModelType.TEXT_EMBEDDING,
		);
		expect(embedCalls).toHaveLength(1);
		expect(embedCalls[0][1]).toEqual({ text });
	});

	it("warms the cache entry the compose-time recall providers hit (same seam, normalized key)", async () => {
		const { runtime, useModel } = makeRuntime();
		const service = new DefaultMessageService();
		const text = "What did we discuss about the roadmap?";

		await service.handleMessage(runtime, userMessage(text));

		// relevant-conversations / document recall call embedRecallQuery with the
		// in-flight message text; normalization (trim/whitespace/case) must map a
		// trivially-different form onto the warmed slot — no second embed call.
		const vector = await embedRecallQuery(
			runtime,
			"  what DID we discuss   about the roadmap? ",
		);
		expect(vector).toEqual(WARM_VECTOR);
		const embedCalls = useModel.mock.calls.filter(
			([modelType]) => modelType === ModelType.TEXT_EMBEDDING,
		);
		expect(embedCalls).toHaveLength(1);
	});

	it("issues no embed for a muted turn (dropped turn = zero model calls)", async () => {
		const { runtime, useModel } = makeRuntime({ muted: true });
		const service = new DefaultMessageService();

		const result = await service.handleMessage(
			runtime,
			userMessage("hey are you there?"),
		);

		expect(result.didRespond).toBe(false);
		expect(useModel).not.toHaveBeenCalled();
	});

	it("issues no embed for an LLM-off turn (dropped before compose)", async () => {
		const { runtime, useModel } = makeRuntime({ llmOff: true });
		const service = new DefaultMessageService();

		await service.handleMessage(runtime, userMessage("anything new?"));

		expect(useModel).not.toHaveBeenCalled();
	});

	it("skips the prefetch for empty message text", async () => {
		const { runtime, useModel } = makeRuntime();
		const service = new DefaultMessageService();

		await service.handleMessage(runtime, userMessage("   "));

		expect(useModel).not.toHaveBeenCalled();
	});
});

describe("Stage-1 sender role resolved once per turn", () => {
	it("resolves the sender role once — world fetched for role + mute only, not re-resolved at the shortcut gate", async () => {
		const { runtime, getWorld } = makeRuntime();
		const service = new DefaultMessageService();

		await service.handleMessage(
			runtime,
			userMessage("what's the plan for today?"),
		);

		// The world is fetched exactly twice for the whole turn: once by the
		// single Stage-1 role resolution in handleMessage, once by the
		// world-scope mute check. Before the per-turn role reuse, the shortcut
		// gate's own `resolveStage1SenderRole` issued a third world lookup for
		// the same message; the injection gate short-circuits on zero risk score
		// so it never re-resolves either.
		expect(getWorld).toHaveBeenCalledTimes(2);
	});
});
