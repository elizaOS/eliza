/**
 * Deterministic bot-loop gate tests — the proof that the anti-loop floor
 * works INDEPENDENT of model instruction-following: `runBotLoopGate` is pure
 * code over the room window, so these assertions hold identically for a
 * gemma-class small model and a frontier model (the model is never invoked;
 * there is nothing for it to obey or ignore).
 *
 * Covered:
 *  - trips (IGNORE) for an all-bot back-and-forth with no intervening human
 *    turn once the agent has produced >= N consecutive turns,
 *  - does NOT trip when a human has spoken since the agent's last turn,
 *  - does NOT trip for human-authored or untagged inbound (fail-open),
 *  - inert in DMs (group-only scoping),
 *  - first bot contact is allowed (the agent may answer a bot once; the gate
 *    stops the reply-to-a-reply),
 *  - opt-out setting and threshold clamping,
 *  - read failure fails open (a DB error never mutes the agent).
 *
 * Deterministic: real AgentRuntime + InMemoryDatabaseAdapter, zero model
 * calls (asserted via a throwing useModel stub).
 */
import { afterEach, describe, expect, it } from "vitest";
import { createCharacter } from "../../character";
import { InMemoryDatabaseAdapter } from "../../database/inMemoryAdapter";
import { AgentRuntime } from "../../runtime";
import type { Memory, UUID } from "../../types/index";
import { ChannelType } from "../../types/index";
import {
	botLoopMaxAgentTurns,
	DEFAULT_BOT_LOOP_MAX_AGENT_TURNS,
	isBotLoopGateEnabled,
	runBotLoopGate,
} from "./bot-loop-gate";

const WORLD_ID = "66666666-6666-6666-6666-666666666660" as UUID;
const GROUP_ROOM = "66666666-6666-6666-6666-666666666661" as UUID;
const DM_ROOM = "66666666-6666-6666-6666-666666666662" as UUID;
const HUMAN = "66666666-6666-6666-6666-6666666666aa" as UUID;
const OTHER_BOT = "66666666-6666-6666-6666-6666666666bb" as UUID;

const activeRuntimes: AgentRuntime[] = [];

afterEach(async () => {
	while (activeRuntimes.length > 0) {
		await activeRuntimes.pop()?.stop();
	}
});

async function makeRuntime(settings?: Record<string, string>): Promise<{
	runtime: AgentRuntime;
	adapter: InMemoryDatabaseAdapter;
}> {
	const adapter = new InMemoryDatabaseAdapter();
	const runtime = new AgentRuntime({
		character: createCharacter({
			name: "GateAgent",
			...(settings ? { settings } : {}),
		}),
		adapter,
		logLevel: "fatal",
		enableAutonomy: false,
	});
	await runtime.initialize();
	// Model-independence proof: any model call during the gate is a failure.
	runtime.useModel = (async () => {
		throw new Error("bot-loop gate must not call a model");
	}) as typeof runtime.useModel;
	await adapter.createWorlds([
		{
			id: WORLD_ID,
			agentId: runtime.agentId,
			name: "gate world",
			metadata: { roles: {} },
		},
	]);
	await adapter.createRooms([
		{
			id: GROUP_ROOM,
			agentId: runtime.agentId,
			source: "test",
			type: ChannelType.GROUP,
			worldId: WORLD_ID,
		},
		{
			id: DM_ROOM,
			agentId: runtime.agentId,
			source: "test",
			type: ChannelType.DM,
			worldId: WORLD_ID,
		},
	]);
	activeRuntimes.push(runtime);
	return { runtime, adapter };
}

let rowCounter = 0;

function makeRow(args: {
	roomId: UUID;
	entityId: UUID;
	text: string;
	fromBot?: boolean;
	channelType?: ChannelType;
}): Memory {
	rowCounter += 1;
	const suffix = rowCounter.toString(16).padStart(12, "0");
	return {
		id: `abababab-abab-abab-abab-${suffix}` as UUID,
		entityId: args.entityId,
		roomId: args.roomId,
		worldId: WORLD_ID,
		createdAt: 50_000 + rowCounter,
		content: {
			text: args.text,
			source: "test",
			...(args.channelType ? { channelType: args.channelType } : {}),
		},
		...(args.fromBot ? { metadata: { fromBot: true } } : {}),
	} as Memory;
}

async function seed(
	adapter: InMemoryDatabaseAdapter,
	rows: Memory[],
): Promise<void> {
	await adapter.createMemories(
		rows.map((memory) => ({ memory, tableName: "messages" })),
	);
}

/** History: human kicks off, then `volleys` bot→agent pairs (no human since). */
function botExchangeRows(
	agentId: UUID,
	volleys: number,
	roomId: UUID = GROUP_ROOM,
): Memory[] {
	const rows: Memory[] = [
		makeRow({ roomId, entityId: HUMAN, text: "hello agents" }),
	];
	for (let i = 0; i < volleys; i += 1) {
		rows.push(
			makeRow({
				roomId,
				entityId: OTHER_BOT,
				text: `bot volley ${i}`,
				fromBot: true,
			}),
			makeRow({ roomId, entityId: agentId, text: `agent volley ${i}` }),
		);
	}
	return rows;
}

function botInbound(
	roomId: UUID = GROUP_ROOM,
	channelType?: ChannelType,
): Memory {
	return makeRow({
		roomId,
		entityId: OTHER_BOT,
		text: "and another thing!",
		fromBot: true,
		...(channelType ? { channelType } : {}),
	});
}

describe("runBotLoopGate — deterministic anti-loop floor", () => {
	it("returns IGNORE for an all-bot back-and-forth with no human turn (model never consulted)", async () => {
		const { runtime, adapter } = await makeRuntime();
		// Agent already sent 2 consecutive turns into the human-free exchange.
		await seed(adapter, botExchangeRows(runtime.agentId, 2));
		const result = await runBotLoopGate({
			runtime,
			message: botInbound(GROUP_ROOM, ChannelType.GROUP),
		});
		expect(result.ignored).toBe(true);
		expect(result.agentTurnsSinceLastHuman).toBeGreaterThanOrEqual(
			DEFAULT_BOT_LOOP_MAX_AGENT_TURNS,
		);
	});

	it("does NOT trip when a human has spoken since the agent's last turn", async () => {
		const { runtime, adapter } = await makeRuntime();
		await seed(adapter, [
			...botExchangeRows(runtime.agentId, 2),
			// Human advances the conversation — counters reset.
			makeRow({
				roomId: GROUP_ROOM,
				entityId: HUMAN,
				text: "ok you two, actual question:",
			}),
		]);
		const result = await runBotLoopGate({
			runtime,
			message: botInbound(GROUP_ROOM, ChannelType.GROUP),
		});
		expect(result.ignored).toBe(false);
		expect(result.reason).toBe("below_threshold");
	});

	it("allows the FIRST reply to a bot (loop starts at the reply-to-a-reply)", async () => {
		const { runtime, adapter } = await makeRuntime();
		// Only one agent turn so far in the human-free tail — below N=2.
		await seed(adapter, botExchangeRows(runtime.agentId, 1));
		const result = await runBotLoopGate({
			runtime,
			message: botInbound(GROUP_ROOM, ChannelType.GROUP),
		});
		expect(result.ignored).toBe(false);
		expect(result.reason).toBe("below_threshold");
	});

	it("fails open for human-authored and untagged inbound messages", async () => {
		const { runtime, adapter } = await makeRuntime();
		await seed(adapter, botExchangeRows(runtime.agentId, 3));
		const humanMessage = makeRow({
			roomId: GROUP_ROOM,
			entityId: HUMAN,
			text: "a human speaks",
			channelType: ChannelType.GROUP,
		});
		expect(
			(await runBotLoopGate({ runtime, message: humanMessage })).ignored,
		).toBe(false);
		// Untagged sender (connector omitted fromBot): treated as human.
		const untagged = makeRow({
			roomId: GROUP_ROOM,
			entityId: OTHER_BOT,
			text: "no stamp on this one",
			channelType: ChannelType.GROUP,
		});
		const untaggedResult = await runBotLoopGate({
			runtime,
			message: untagged,
		});
		expect(untaggedResult.ignored).toBe(false);
		expect(untaggedResult.reason).toBe("not_bot_authored");
	});

	it("is inert in DMs regardless of exchange depth (group-only scoping)", async () => {
		const { runtime, adapter } = await makeRuntime();
		await seed(adapter, botExchangeRows(runtime.agentId, 5, DM_ROOM));
		const result = await runBotLoopGate({
			runtime,
			message: botInbound(DM_ROOM, ChannelType.DM),
		});
		expect(result.ignored).toBe(false);
		expect(result.reason).toBe("not_group_channel");
	});

	it("respects the opt-out setting and clamps the threshold", async () => {
		const { runtime, adapter } = await makeRuntime({
			ELIZA_BOT_LOOP_GATE: "off",
		});
		await seed(adapter, botExchangeRows(runtime.agentId, 4));
		expect(isBotLoopGateEnabled(runtime)).toBe(false);
		const result = await runBotLoopGate({
			runtime,
			message: botInbound(GROUP_ROOM, ChannelType.GROUP),
		});
		expect(result.ignored).toBe(false);
		expect(result.reason).toBe("disabled");

		// Threshold clamp: junk and sub-1 values fall back to the default.
		const { runtime: clamped } = await makeRuntime({
			ELIZA_BOT_LOOP_MAX_AGENT_TURNS: "0",
		});
		expect(botLoopMaxAgentTurns(clamped)).toBe(
			DEFAULT_BOT_LOOP_MAX_AGENT_TURNS,
		);
		const { runtime: junk } = await makeRuntime({
			ELIZA_BOT_LOOP_MAX_AGENT_TURNS: "banana",
		});
		expect(botLoopMaxAgentTurns(junk)).toBe(DEFAULT_BOT_LOOP_MAX_AGENT_TURNS);
		const { runtime: raised } = await makeRuntime({
			ELIZA_BOT_LOOP_MAX_AGENT_TURNS: "5",
		});
		expect(botLoopMaxAgentTurns(raised)).toBe(5);
	});

	it("honors a raised threshold before tripping", async () => {
		const { runtime, adapter } = await makeRuntime({
			ELIZA_BOT_LOOP_MAX_AGENT_TURNS: "4",
		});
		await seed(adapter, botExchangeRows(runtime.agentId, 3));
		const below = await runBotLoopGate({
			runtime,
			message: botInbound(GROUP_ROOM, ChannelType.GROUP),
		});
		expect(below.ignored).toBe(false);

		const { runtime: runtime2, adapter: adapter2 } = await makeRuntime({
			ELIZA_BOT_LOOP_MAX_AGENT_TURNS: "4",
		});
		await seed(adapter2, botExchangeRows(runtime2.agentId, 4));
		const at = await runBotLoopGate({
			runtime: runtime2,
			message: botInbound(GROUP_ROOM, ChannelType.GROUP),
		});
		expect(at.ignored).toBe(true);
	});

	it("fails open when the room window read throws (never mutes on error)", async () => {
		const { runtime, adapter } = await makeRuntime();
		await seed(adapter, botExchangeRows(runtime.agentId, 3));
		const realGetMemories = adapter.getMemories.bind(adapter);
		// Scoped failure: only the gate's own bounded room-window scan throws, so
		// unrelated background services (relationships graph builder etc.) keep
		// working and cannot surface unhandled rejections into the test run.
		adapter.getMemories = async (
			params: Parameters<InMemoryDatabaseAdapter["getMemories"]>[0],
		) => {
			if (params.tableName === "messages" && params.roomId === GROUP_ROOM) {
				throw new Error("db unavailable");
			}
			return realGetMemories(params);
		};
		const result = await runBotLoopGate({
			runtime,
			message: botInbound(GROUP_ROOM, ChannelType.GROUP),
		});
		adapter.getMemories = realGetMemories;
		expect(result.ignored).toBe(false);
		expect(result.reason).toBe("window_unavailable");
	});
});
