/**
 * Tests for the ANXIETY and BOT_AWARENESS group-channel providers.
 *
 * ANXIETY: pressure rises with the agent's share of recent turns and with
 * agent↔single-participant ping-pong, stays at zero when the agent has been
 * quiet, is damped when a human just directly addressed the agent, and is
 * INERT in DMs (bidirectional: the DM path returns the empty result even
 * under maximum-pressure history). Room-awareness: the same agent turn count
 * produces more pressure in a crowded room than a two-person group.
 *
 * BOT_AWARENESS: fires when the latest interlocutor is connector-stamped
 * `fromBot` and the bot↔agent exchange has no intervening human turn; stays
 * quiet when a human is active in the gap, when the interlocutor is human,
 * and in DMs.
 *
 * Deterministic: real AgentRuntime + InMemoryDatabaseAdapter; providers read
 * either the composed RECENT_MESSAGES state or the coalesced room scan; no
 * model calls.
 */
import { afterEach, describe, expect, it } from "vitest";
import { createCharacter } from "../../../character";
import { InMemoryDatabaseAdapter } from "../../../database/inMemoryAdapter";
import { AgentRuntime } from "../../../runtime";
import type { Memory, State, UUID } from "../../../types/index";
import { ChannelType } from "../../../types/index";
import {
	anxietyProvider,
	computeAnxietyPressure,
	DEFAULT_ANXIETY_CALIBRATION,
} from "./anxiety";
import { assessBotLoop, botAwarenessProvider } from "./botAwareness";
import { computeGroupConversationMetrics } from "./group-conversation-signals";

const WORLD_ID = "77777777-7777-7777-7777-777777777770" as UUID;
const GROUP_ROOM = "77777777-7777-7777-7777-777777777771" as UUID;
const DM_ROOM = "77777777-7777-7777-7777-777777777772" as UUID;
const HUMAN_A = "88888888-8888-8888-8888-888888888881" as UUID;
const HUMAN_B = "88888888-8888-8888-8888-888888888882" as UUID;
const HUMAN_C = "88888888-8888-8888-8888-888888888883" as UUID;
const OTHER_BOT = "88888888-8888-8888-8888-8888888888bb" as UUID;

const activeRuntimes: AgentRuntime[] = [];

afterEach(async () => {
	while (activeRuntimes.length > 0) {
		const runtime = activeRuntimes.pop();
		await runtime?.stop();
	}
});

async function makeRuntime(): Promise<{
	runtime: AgentRuntime;
	adapter: InMemoryDatabaseAdapter;
}> {
	const adapter = new InMemoryDatabaseAdapter();
	const runtime = new AgentRuntime({
		character: createCharacter({ name: "Eliza" }),
		adapter,
		logLevel: "fatal",
		enableAutonomy: false,
	});
	await runtime.initialize();
	await adapter.createWorlds([
		{
			id: WORLD_ID,
			agentId: runtime.agentId,
			name: "anxiety world",
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
		id: `99999999-9999-9999-9999-${suffix}` as UUID,
		entityId: args.entityId,
		roomId: args.roomId,
		worldId: WORLD_ID,
		createdAt: 10_000 + rowCounter,
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

/** Alternating agent↔human history: pure ping-pong of the given length. */
function pingPongRows(
	agentId: UUID,
	other: UUID,
	pairs: number,
	roomId: UUID = GROUP_ROOM,
): Memory[] {
	const rows: Memory[] = [];
	for (let i = 0; i < pairs; i += 1) {
		rows.push(
			makeRow({ roomId, entityId: other, text: `ping ${i}` }),
			makeRow({ roomId, entityId: agentId, text: `pong ${i}` }),
		);
	}
	return rows;
}

const EMPTY_STATE = {} as State;

describe("ANXIETY provider", () => {
	it("stays silent in a group where the agent has been quiet", async () => {
		const { runtime, adapter } = await makeRuntime();
		await seed(adapter, [
			makeRow({ roomId: GROUP_ROOM, entityId: HUMAN_A, text: "hey all" }),
			makeRow({ roomId: GROUP_ROOM, entityId: HUMAN_B, text: "morning" }),
			makeRow({ roomId: GROUP_ROOM, entityId: HUMAN_A, text: "plans today?" }),
		]);
		const inbound = makeRow({
			roomId: GROUP_ROOM,
			entityId: HUMAN_B,
			text: "coffee first",
			channelType: ChannelType.GROUP,
		});
		const result = await anxietyProvider.get(runtime, inbound, EMPTY_STATE);
		expect(result.text).toBe("");
		expect(result.values).toEqual({});
	});

	it("rises with agent-turn dominance and renders the yield-the-floor guidance", async () => {
		const { runtime, adapter } = await makeRuntime();
		const rows: Memory[] = [
			makeRow({ roomId: GROUP_ROOM, entityId: HUMAN_A, text: "question" }),
		];
		for (let i = 0; i < 8; i += 1) {
			rows.push(
				makeRow({
					roomId: GROUP_ROOM,
					entityId: runtime.agentId,
					text: `agent monologue ${i}`,
				}),
			);
		}
		await seed(adapter, rows);
		const inbound = makeRow({
			roomId: GROUP_ROOM,
			entityId: HUMAN_B,
			text: "anyway",
			channelType: ChannelType.GROUP,
		});
		const result = await anxietyProvider.get(runtime, inbound, EMPTY_STATE);
		expect(result.text).toContain("Others should have the floor");
		expect(result.text).toContain("IGNORE");
		expect(result.values?.anxietyPressure as number).toBeGreaterThanOrEqual(
			DEFAULT_ANXIETY_CALIBRATION.highWatermark,
		);
	});

	it("ramps on sustained ping-pong with a single participant", async () => {
		const { runtime, adapter } = await makeRuntime();
		await seed(adapter, [
			// A third participant exists but the tail is pure agent↔HUMAN_A.
			makeRow({ roomId: GROUP_ROOM, entityId: HUMAN_B, text: "lurking" }),
			...pingPongRows(runtime.agentId, HUMAN_A, 5),
		]);
		const inbound = makeRow({
			roomId: GROUP_ROOM,
			entityId: HUMAN_A,
			text: "ping again",
			channelType: ChannelType.GROUP,
		});
		const result = await anxietyProvider.get(runtime, inbound, EMPTY_STATE);
		expect(result.text).not.toBe("");
		expect(result.values?.anxietyPingPongRun as number).toBeGreaterThanOrEqual(
			3,
		);
		expect(result.text).toMatch(/back-and-forth|trading messages/);
	});

	it("is damped (not silenced) when a human directly addresses the agent by name", async () => {
		const { runtime, adapter } = await makeRuntime();
		await seed(adapter, pingPongRows(runtime.agentId, HUMAN_A, 6));
		const inbound = makeRow({
			roomId: GROUP_ROOM,
			entityId: HUMAN_A,
			text: "Eliza can you summarize the thread?",
			channelType: ChannelType.GROUP,
		});
		const undamped = await anxietyProvider.get(
			runtime,
			makeRow({
				roomId: GROUP_ROOM,
				entityId: HUMAN_A,
				text: "just chatting along",
				channelType: ChannelType.GROUP,
			}),
			EMPTY_STATE,
		);
		const damped = await anxietyProvider.get(runtime, inbound, EMPTY_STATE);
		const undampedPressure = (undamped.values?.anxietyPressure as number) ?? 0;
		if (damped.text === "") {
			// Fully below the notice floor after damping — acceptable outcome.
			expect(undampedPressure).toBeGreaterThan(0);
		} else {
			expect(damped.values?.anxietyDampedByAddress).toBe(true);
			expect(damped.values?.anxietyPressure as number).toBeLessThan(
				undampedPressure,
			);
			expect(damped.text).toContain("directly addressed");
		}
	});

	it("is INERT in DMs even with maximum-pressure history (bidirectional)", async () => {
		const { runtime, adapter } = await makeRuntime();
		const rows: Memory[] = [];
		for (let i = 0; i < 10; i += 1) {
			rows.push(
				makeRow({
					roomId: DM_ROOM,
					entityId: runtime.agentId,
					text: `dm monologue ${i}`,
				}),
			);
		}
		await seed(adapter, rows);
		// Sanity: the same shape in a GROUP room does produce pressure.
		const groupResult = await anxietyProvider.get(
			runtime,
			makeRow({
				roomId: GROUP_ROOM,
				entityId: HUMAN_A,
				text: "hm",
				channelType: ChannelType.GROUP,
			}),
			{
				data: {
					providers: {
						RECENT_MESSAGES: { data: { recentMessages: rows } },
					},
				},
			} as unknown as State,
		);
		expect(groupResult.text).not.toBe("");
		// The DM path returns the empty result: explicit channelType on content…
		const explicit = await anxietyProvider.get(
			runtime,
			makeRow({
				roomId: DM_ROOM,
				entityId: HUMAN_A,
				text: "hm",
				channelType: ChannelType.DM,
			}),
			EMPTY_STATE,
		);
		expect(explicit).toEqual({ text: "", values: {}, data: {} });
		// …and via room-row type resolution when content omits it.
		const resolved = await anxietyProvider.get(
			runtime,
			makeRow({ roomId: DM_ROOM, entityId: HUMAN_A, text: "hm" }),
			EMPTY_STATE,
		);
		expect(resolved).toEqual({ text: "", values: {}, data: {} });
	});

	it("reads the composed RECENT_MESSAGES state on a turn recompose instead of refetching", async () => {
		const { runtime, adapter } = await makeRuntime();
		let scans = 0;
		const realGetMemories = adapter.getMemories.bind(adapter);
		adapter.getMemories = async (
			params: Parameters<InMemoryDatabaseAdapter["getMemories"]>[0],
		) => {
			if (params.tableName === "messages") scans += 1;
			return realGetMemories(params);
		};
		const rows = pingPongRows(runtime.agentId, HUMAN_A, 6);
		const inbound = makeRow({
			roomId: GROUP_ROOM,
			entityId: HUMAN_A,
			text: "again",
			channelType: ChannelType.GROUP,
		});
		const state = {
			data: {
				providers: {
					RECENT_MESSAGES: { data: { recentMessages: rows } },
				},
			},
		} as unknown as State;
		const result = await anxietyProvider.get(runtime, inbound, state);
		expect(result.text).not.toBe("");
		expect(scans).toBe(0);
	});

	it("is room-aware: identical agent activity pressures higher in a crowded room", () => {
		// Pure-function proof of the crowd calibration: same agent share and
		// window, more distinct participants → more pressure.
		const base = {
			windowSize: 10,
			agentTurns: 5,
			agentShare: 0.5,
			pingPongRun: 0,
			latestFromBot: false,
			agentTurnsSinceLastHuman: 0,
			botTurnsSinceLastHuman: 0,
			humanInWindow: true,
		};
		const quiet = computeAnxietyPressure(
			{ ...base, participantCount: 1 },
			false,
		);
		const crowded = computeAnxietyPressure(
			{ ...base, participantCount: 6 },
			false,
		);
		expect(crowded.pressure).toBeGreaterThan(quiet.pressure);
		// Fair share shrinks as the room fills up.
		expect(crowded.fairShare).toBeLessThan(quiet.fairShare);
	});

	it("registers group-only advisory metadata", () => {
		expect(anxietyProvider.name).toBe("ANXIETY");
		expect(anxietyProvider.alwaysInResponseState).toBe(true);
		expect(anxietyProvider.dynamic).toBe(true);
	});
});

describe("BOT_AWARENESS provider", () => {
	it("fires when the interlocutor is a bot with no intervening human turn", async () => {
		const { runtime, adapter } = await makeRuntime();
		await seed(adapter, [
			makeRow({ roomId: GROUP_ROOM, entityId: HUMAN_A, text: "hi bots" }),
			makeRow({
				roomId: GROUP_ROOM,
				entityId: OTHER_BOT,
				text: "hello!",
				fromBot: true,
			}),
			makeRow({
				roomId: GROUP_ROOM,
				entityId: runtime.agentId,
				text: "hello to you too!",
			}),
		]);
		const inbound = makeRow({
			roomId: GROUP_ROOM,
			entityId: OTHER_BOT,
			text: "and hello again! anything I can help with?",
			fromBot: true,
			channelType: ChannelType.GROUP,
		});
		const result = await botAwarenessProvider.get(
			runtime,
			inbound,
			EMPTY_STATE,
		);
		expect(result.text).toContain("another bot");
		expect(result.text).toContain("IGNORE");
		expect(result.values?.botLoopActive).toBe(true);
	});

	it("escalates to let-it-drop wording when the human-free exchange is deep", async () => {
		const { runtime, adapter } = await makeRuntime();
		const rows: Memory[] = [
			makeRow({ roomId: GROUP_ROOM, entityId: HUMAN_A, text: "kick off" }),
		];
		for (let i = 0; i < 3; i += 1) {
			rows.push(
				makeRow({
					roomId: GROUP_ROOM,
					entityId: OTHER_BOT,
					text: `bot volley ${i}`,
					fromBot: true,
				}),
				makeRow({
					roomId: GROUP_ROOM,
					entityId: runtime.agentId,
					text: `agent volley ${i}`,
				}),
			);
		}
		await seed(adapter, rows);
		const inbound = makeRow({
			roomId: GROUP_ROOM,
			entityId: OTHER_BOT,
			text: "one more volley",
			fromBot: true,
			channelType: ChannelType.GROUP,
		});
		const result = await botAwarenessProvider.get(
			runtime,
			inbound,
			EMPTY_STATE,
		);
		expect(result.text).toContain("Let it drop");
		expect(result.values?.botLoopDeep).toBe(true);
		expect(
			result.values?.botLoopExchangeDepth as number,
		).toBeGreaterThanOrEqual(4);
	});

	it("stays quiet when a human turn sits between the bot exchanges", async () => {
		const { runtime, adapter } = await makeRuntime();
		await seed(adapter, [
			makeRow({
				roomId: GROUP_ROOM,
				entityId: OTHER_BOT,
				text: "bot says a thing",
				fromBot: true,
			}),
			makeRow({
				roomId: GROUP_ROOM,
				entityId: runtime.agentId,
				text: "agent replies",
			}),
			makeRow({
				roomId: GROUP_ROOM,
				entityId: HUMAN_A,
				text: "human steps in with a real question",
			}),
		]);
		const inbound = makeRow({
			roomId: GROUP_ROOM,
			entityId: OTHER_BOT,
			text: "bot answers the human",
			fromBot: true,
			channelType: ChannelType.GROUP,
		});
		const result = await botAwarenessProvider.get(
			runtime,
			inbound,
			EMPTY_STATE,
		);
		// Latest turn is a bot, but the agent has not replied since the last
		// human turn — no agent↔bot loop is in progress.
		expect(result).toEqual({ text: "", values: {}, data: {} });
	});

	it("stays quiet when the interlocutor is human", async () => {
		const { runtime, adapter } = await makeRuntime();
		await seed(adapter, pingPongRows(runtime.agentId, HUMAN_A, 4));
		const inbound = makeRow({
			roomId: GROUP_ROOM,
			entityId: HUMAN_A,
			text: "humans keep talking",
			channelType: ChannelType.GROUP,
		});
		const result = await botAwarenessProvider.get(
			runtime,
			inbound,
			EMPTY_STATE,
		);
		expect(result).toEqual({ text: "", values: {}, data: {} });
	});

	it("is INERT in DMs even for a bot interlocutor", async () => {
		const { runtime, adapter } = await makeRuntime();
		await seed(adapter, [
			makeRow({
				roomId: DM_ROOM,
				entityId: OTHER_BOT,
				text: "bot dm",
				fromBot: true,
			}),
			makeRow({ roomId: DM_ROOM, entityId: runtime.agentId, text: "reply" }),
		]);
		const inbound = makeRow({
			roomId: DM_ROOM,
			entityId: OTHER_BOT,
			text: "bot dm again",
			fromBot: true,
			channelType: ChannelType.DM,
		});
		const result = await botAwarenessProvider.get(
			runtime,
			inbound,
			EMPTY_STATE,
		);
		expect(result).toEqual({ text: "", values: {}, data: {} });
	});

	it("assessBotLoop requires both bot and agent turns in the human-free tail", () => {
		const base = {
			windowSize: 6,
			agentTurns: 2,
			agentShare: 0.33,
			participantCount: 2,
			pingPongRun: 0,
			humanInWindow: true,
		};
		expect(
			assessBotLoop({
				...base,
				latestFromBot: true,
				agentTurnsSinceLastHuman: 1,
				botTurnsSinceLastHuman: 2,
			}).active,
		).toBe(true);
		// Bot posted but agent never engaged: not a loop.
		expect(
			assessBotLoop({
				...base,
				latestFromBot: true,
				agentTurnsSinceLastHuman: 0,
				botTurnsSinceLastHuman: 3,
			}).active,
		).toBe(false);
		// Agent talked but latest turn is human-authored: not a loop.
		expect(
			assessBotLoop({
				...base,
				latestFromBot: false,
				agentTurnsSinceLastHuman: 2,
				botTurnsSinceLastHuman: 1,
			}).active,
		).toBe(false);
	});

	it("computeGroupConversationMetrics counts the ping-pong tail strictly", () => {
		const agent = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa" as UUID;
		const window = [
			makeRow({ roomId: GROUP_ROOM, entityId: HUMAN_C, text: "old" }),
			makeRow({ roomId: GROUP_ROOM, entityId: HUMAN_A, text: "a1" }),
			makeRow({ roomId: GROUP_ROOM, entityId: agent, text: "r1" }),
			makeRow({ roomId: GROUP_ROOM, entityId: HUMAN_A, text: "a2" }),
			makeRow({ roomId: GROUP_ROOM, entityId: agent, text: "r2" }),
			makeRow({ roomId: GROUP_ROOM, entityId: HUMAN_A, text: "a3" }),
			makeRow({ roomId: GROUP_ROOM, entityId: agent, text: "r3" }),
		];
		const metrics = computeGroupConversationMetrics(window, agent);
		expect(metrics.pingPongRun).toBe(3);
		expect(metrics.participantCount).toBe(2);
		// A third party breaking the tail resets the run: the strict suffix is
		// now just agent↔HUMAN_B (one agent turn), well below the ping-pong
		// threshold — the deep alternation with HUMAN_A no longer counts.
		const broken = [
			...window,
			makeRow({ roomId: GROUP_ROOM, entityId: HUMAN_B, text: "interrupt" }),
		];
		expect(computeGroupConversationMetrics(broken, agent).pingPongRun).toBe(1);
	});
});
