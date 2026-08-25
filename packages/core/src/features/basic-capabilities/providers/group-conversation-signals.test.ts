/**
 * Covers the deterministic group-chat signal helpers in
 * `basic-capabilities/providers/group-conversation-signals`: bot-authorship
 * stamping, channel-type resolution and the multi-party gate, dialogue-window
 * loading (composed-state preference, room-scan fallback, filtering, ordering,
 * window cap, live-turn append), group conversation metrics (share,
 * participants, strict ping-pong alternation, human-gap counters), and the
 * structural human-address dampener.
 *
 * Harness: real module with plain-data inputs only — runtimes are minimal
 * literal objects and messages/state are ordinary DTO literals; every
 * expectation records behavior observed from this implementation.
 */
import { describe, expect, it } from "vitest";
import type {
	IAgentRuntime,
	Memory,
	State,
	UUID,
} from "../../../types/index.ts";
import {
	computeGroupConversationMetrics,
	GROUP_SIGNAL_WINDOW,
	humanDirectlyAddressesAgent,
	isBotAuthoredMessage,
	isMultiPartyChannel,
	loadDialogueWindow,
	resolveChannelType,
} from "./group-conversation-signals.ts";

const AGENT: UUID = "00000000-0000-4000-8000-000000000001";
const ALICE: UUID = "00000000-0000-4000-8000-000000000002";
const BOB: UUID = "00000000-0000-4000-8000-000000000003";
const ROOM: UUID = "00000000-0000-4000-8000-0000000000aa";

let nextTurnId = 0;

function turn(
	entityId: UUID,
	createdAt: number,
	extra: Partial<Memory> = {},
): Memory {
	nextTurnId += 1;
	return {
		id: `t${String(nextTurnId).padStart(4, "0")}`,
		entityId,
		createdAt,
		roomId: ROOM,
		content: { text: `turn ${nextTurnId}` },
		...extra,
	};
}

function stateWithRecentMessages(messages: Memory[]): State {
	return {
		data: {
			providers: {
				RECENT_MESSAGES: { data: { recentMessages: messages } },
			},
		},
	} as State;
}

function runtimeWithRoom(room: unknown): {
	runtime: IAgentRuntime;
	getRoomCalls: unknown[];
} {
	const getRoomCalls: unknown[] = [];
	const runtime = {
		getRoom: async (...args: unknown[]) => {
			getRoomCalls.push(args);
			if (room instanceof Error) throw room;
			return room;
		},
	} as IAgentRuntime;
	return { runtime, getRoomCalls };
}

function runtimeWithMemories(rows: Memory[] | Error): {
	runtime: IAgentRuntime;
	getMemoriesCalls: Array<Record<string, unknown>>;
} {
	const getMemoriesCalls: Array<Record<string, unknown>> = [];
	const runtime = {
		getMemories: async (params: Record<string, unknown>) => {
			getMemoriesCalls.push(params);
			if (rows instanceof Error) throw rows;
			return rows;
		},
	} as IAgentRuntime;
	return { runtime, getMemoriesCalls };
}

describe("GROUP_SIGNAL_WINDOW", () => {
	it("caps loadDialogueWindow at twenty turns", async () => {
		const composed = Array.from({ length: 25 }, (_, index) =>
			turn(ALICE, index + 1),
		);
		const inbound = turn(BOB, 999);
		const { runtime } = runtimeWithMemories([]);
		const window = await loadDialogueWindow(
			runtime,
			inbound,
			stateWithRecentMessages(composed),
		);
		expect(window).toHaveLength(GROUP_SIGNAL_WINDOW);
		expect(window[0]?.createdAt).toBe(25 - GROUP_SIGNAL_WINDOW + 1 + 1);
		expect(window.at(-1)?.id).toBe(inbound.id);
	});
});

describe("isBotAuthoredMessage", () => {
	it("detects the connector stamp on memory metadata", () => {
		expect(
			isBotAuthoredMessage(turn(ALICE, 1, { metadata: { fromBot: true } })),
		).toBe(true);
	});

	it("detects the connector stamp on content metadata", () => {
		const message = turn(ALICE, 1, {
			content: { text: "hi", metadata: { fromBot: true } },
		});
		expect(isBotAuthoredMessage(message)).toBe(true);
	});

	it("treats untagged senders as human", () => {
		expect(isBotAuthoredMessage(turn(ALICE, 1))).toBe(false);
		expect(
			isBotAuthoredMessage(turn(ALICE, 1, { metadata: { fromBot: false } })),
		).toBe(false);
	});

	it("rejects non-record metadata shapes instead of reading them", () => {
		expect(
			isBotAuthoredMessage(turn(ALICE, 1, { metadata: [] as never })),
		).toBe(false);
	});
});

describe("resolveChannelType", () => {
	it("prefers a non-empty content channel type, trimmed and uppercased", async () => {
		const { runtime } = runtimeWithRoom(null);
		const message = turn(ALICE, 1, {
			content: { text: "hi", channelType: "  group " },
		});
		await expect(resolveChannelType(runtime, message)).resolves.toBe("GROUP");
	});

	it("falls back to the room row when content is blank or missing", async () => {
		const { runtime, getRoomCalls } = runtimeWithRoom({ type: "THREAD" });
		const blank = turn(ALICE, 1, {
			content: { text: "hi", channelType: "   " },
		});
		await expect(resolveChannelType(runtime, blank)).resolves.toBe("THREAD");
		const missing = turn(BOB, 2, { roomId: ROOM });
		await expect(resolveChannelType(runtime, missing)).resolves.toBe("THREAD");
		expect(getRoomCalls).toHaveLength(2);
		expect(getRoomCalls[0]?.[0]).toBe(blank.roomId);
	});

	it("returns empty for a message without roomId and without content type", async () => {
		const { runtime, getRoomCalls } = runtimeWithRoom({ type: "DM" });
		const orphan = turn(ALICE, 1);
		delete (orphan as { roomId?: UUID }).roomId;
		await expect(resolveChannelType(runtime, orphan)).resolves.toBe("");
		expect(getRoomCalls).toHaveLength(0);
	});

	it("returns empty when the room lookup fails or has no type", async () => {
		const failing = runtimeWithRoom(new Error("db down"));
		const message = turn(ALICE, 1, { roomId: ROOM });
		await expect(resolveChannelType(failing.runtime, message)).resolves.toBe(
			"",
		);
		const typeless = runtimeWithRoom({});
		await expect(resolveChannelType(typeless.runtime, message)).resolves.toBe(
			"",
		);
	});
});

describe("isMultiPartyChannel", () => {
	it("accepts exactly the documented multi-party channel types", () => {
		for (const channelType of [
			"GROUP",
			"VOICE_GROUP",
			"THREAD",
			"WORLD",
			"FORUM",
		]) {
			expect(isMultiPartyChannel(channelType)).toBe(true);
		}
	});

	it("keeps private, feed, api, and unknown channels inert", () => {
		for (const channelType of [
			"DM",
			"VOICE_DM",
			"SELF",
			"API",
			"FEED",
			"AUTONOMOUS",
			"",
			"group",
		]) {
			expect(isMultiPartyChannel(channelType)).toBe(false);
		}
	});
});

describe("loadDialogueWindow", () => {
	it("prefers the composed RECENT_MESSAGES state and appends the live inbound turn", async () => {
		const composed = [turn(ALICE, 100), turn(AGENT, 200)];
		const inbound = turn(BOB, 300);
		const { runtime, getMemoriesCalls } = runtimeWithMemories([]);
		const window = await loadDialogueWindow(
			runtime,
			inbound,
			stateWithRecentMessages(composed),
		);
		expect(window.map((entry) => entry.createdAt)).toEqual([100, 200, 300]);
		expect(getMemoriesCalls).toHaveLength(0);
	});

	it("filters action results and internal bridge rows out of the window", async () => {
		const composed = [
			turn(ALICE, 1),
			turn(AGENT, 2, { content: { type: "action_result" } }),
			turn(BOB, 3, { content: { source: "swarm_synthesis" } }),
			turn(ALICE, 4, { content: { metadata: { subAgent: true } } }),
		];
		const { runtime } = runtimeWithMemories([]);
		const window = await loadDialogueWindow(
			runtime,
			turn(BOB, 5),
			stateWithRecentMessages(composed),
		);
		expect(window).toHaveLength(2);
		expect(window.map((entry) => entry.createdAt)).toEqual([1, 5]);
	});

	it("sorts ascending with non-finite stamps collapsing to oldest and ties broken by id", async () => {
		const nanStamp = turn(ALICE, Number.NaN, { id: "zz" });
		const noStamp = turn(BOB, undefined as unknown as number, { id: "aa" });
		const stamped = turn(AGENT, 50, { id: "mm" });
		const { runtime } = runtimeWithMemories([stamped, nanStamp, noStamp]);
		const window = await loadDialogueWindow(
			runtime,
			turn(AGENT, 60, { id: "kk" }),
			stateWithRecentMessages([]),
		);
		expect(window.map((entry) => entry.id)).toEqual(["aa", "zz", "mm", "kk"]);
	});

	it("falls back to the coalesced room scan with the bounded limit", async () => {
		const rows = [turn(ALICE, 20), turn(AGENT, 10)];
		const { runtime, getMemoriesCalls } = runtimeWithMemories(rows);
		const inbound = turn(BOB, 30);
		inbound.roomId = ROOM;
		const window = await loadDialogueWindow(runtime, inbound, {} as State);
		expect(getMemoriesCalls).toEqual([
			{
				tableName: "messages",
				roomId: ROOM,
				limit: GROUP_SIGNAL_WINDOW,
				unique: false,
			},
		]);
		expect(window.map((entry) => entry.createdAt)).toEqual([10, 20, 30]);
	});

	it("degrades to the lone inbound turn when the room scan rejects", async () => {
		const { runtime } = runtimeWithMemories(new Error("scan failed"));
		const inbound = turn(ALICE, 1);
		inbound.roomId = ROOM;
		const window = await loadDialogueWindow(runtime, inbound, {} as State);
		expect(window.map((entry) => entry.id)).toEqual([inbound.id]);
	});

	it("uses just the inbound turn when there is no state data and no roomId", async () => {
		const { runtime } = runtimeWithMemories([]);
		const inbound = turn(ALICE, 1);
		delete (inbound as { roomId?: UUID }).roomId;
		const window = await loadDialogueWindow(runtime, inbound, {} as State);
		expect(window).toHaveLength(1);
		expect(window[0]?.id).toBe(inbound.id);
	});

	it("does not duplicate the inbound turn when the stored window already holds it", async () => {
		const inbound = turn(ALICE, 10);
		const composed = [turn(BOB, 5), inbound];
		const { runtime } = runtimeWithMemories([]);
		const window = await loadDialogueWindow(
			runtime,
			inbound,
			stateWithRecentMessages(composed),
		);
		expect(window.filter((entry) => entry.id === inbound.id)).toHaveLength(1);
		expect(window).toHaveLength(2);
	});

	it("skips appending an inbound action result row", async () => {
		const composed = [turn(ALICE, 1)];
		const actionRow = turn(AGENT, 9, { content: { type: "action_result" } });
		const { runtime } = runtimeWithMemories([]);
		const window = await loadDialogueWindow(
			runtime,
			actionRow,
			stateWithRecentMessages(composed),
		);
		expect(window.map((entry) => entry.createdAt)).toEqual([1]);
	});
});

describe("computeGroupConversationMetrics", () => {
	it("returns zeroed signals for an empty window", () => {
		const metrics = computeGroupConversationMetrics([], AGENT);
		expect(metrics).toEqual({
			windowSize: 0,
			agentTurns: 0,
			agentShare: 0,
			participantCount: 0,
			pingPongRun: 0,
			latestFromBot: false,
			agentTurnsSinceLastHuman: 0,
			botTurnsSinceLastHuman: 0,
			humanInWindow: false,
		});
	});

	it("counts agent share, participants, and the human gap on a mixed window", () => {
		const window = [
			turn(ALICE, 1),
			turn(AGENT, 2),
			turn(BOB, 3),
			turn(AGENT, 4),
		];
		const metrics = computeGroupConversationMetrics(window, AGENT);
		expect(metrics.windowSize).toBe(4);
		expect(metrics.agentTurns).toBe(2);
		expect(metrics.agentShare).toBe(0.5);
		expect(metrics.participantCount).toBe(2);
		expect(metrics.pingPongRun).toBe(2);
		expect(metrics.latestFromBot).toBe(false);
		expect(metrics.agentTurnsSinceLastHuman).toBe(1);
		expect(metrics.botTurnsSinceLastHuman).toBe(0);
		expect(metrics.humanInWindow).toBe(true);
	});

	it("measures a full agent-other alternation as one ping-pong run", () => {
		const window = [
			turn(AGENT, 1),
			turn(ALICE, 2),
			turn(AGENT, 3),
			turn(ALICE, 4),
			turn(AGENT, 5),
		];
		expect(computeGroupConversationMetrics(window, AGENT).pingPongRun).toBe(3);
	});

	it("stops the ping-pong run on a repeated speaker", () => {
		const window = [turn(ALICE, 1), turn(AGENT, 2), turn(AGENT, 3)];
		expect(computeGroupConversationMetrics(window, AGENT).pingPongRun).toBe(1);
	});

	it("stops the ping-pong run when a third party joins the tail", () => {
		const window = [
			turn(BOB, 1),
			turn(AGENT, 2),
			turn(ALICE, 3),
			turn(AGENT, 4),
		];
		expect(computeGroupConversationMetrics(window, AGENT).pingPongRun).toBe(2);
	});

	it("breaks immediately on a tail entry with no sender identity", () => {
		const anonymous = turn(AGENT, 3);
		delete (anonymous as { entityId?: UUID }).entityId;
		const window = [turn(AGENT, 1), turn(ALICE, 2), anonymous];
		expect(computeGroupConversationMetrics(window, AGENT).pingPongRun).toBe(0);
	});

	it("classifies bot-stamped tail turns separately from the human gap", () => {
		const botTurn = turn(ALICE, 3, { metadata: { fromBot: true } });
		const window = [turn(ALICE, 1), turn(AGENT, 2), botTurn];
		const metrics = computeGroupConversationMetrics(window, AGENT);
		expect(metrics.latestFromBot).toBe(true);
		expect(metrics.botTurnsSinceLastHuman).toBe(1);
		expect(metrics.agentTurnsSinceLastHuman).toBe(1);
		expect(metrics.pingPongRun).toBe(1);
		expect(metrics.humanInWindow).toBe(true);
	});

	it("reports no human in an all-agent-and-bot window after the fallback scan", () => {
		const otherBot = turn(ALICE, 1, { metadata: { fromBot: true } });
		const agentTurn = turn(AGENT, 2);
		const latestBot = turn(BOB, 3, { metadata: { fromBot: true } });
		const metrics = computeGroupConversationMetrics(
			[otherBot, agentTurn, latestBot],
			AGENT,
		);
		expect(metrics.agentTurnsSinceLastHuman).toBe(1);
		expect(metrics.botTurnsSinceLastHuman).toBe(2);
		expect(metrics.latestFromBot).toBe(true);
		expect(metrics.humanInWindow).toBe(false);
	});

	it("excludes identity-less entries from the participant set", () => {
		const anonymous = turn(AGENT, 1);
		delete (anonymous as { entityId?: UUID }).entityId;
		const metrics = computeGroupConversationMetrics(
			[anonymous, turn(AGENT, 2)],
			AGENT,
		);
		expect(metrics.participantCount).toBe(0);
	});
});

describe("humanDirectlyAddressesAgent", () => {
	function addressingRuntime(character?: {
		name?: string;
		username?: string;
	}): IAgentRuntime {
		return { character } as IAgentRuntime;
	}

	it("never fires for bot-authored inbound turns", () => {
		const message = turn(BOB, 1, {
			metadata: { fromBot: true },
			content: {
				text: "@agent hello",
				mentionContext: { isMention: true, isReply: false },
			},
		});
		expect(humanDirectlyAddressesAgent(addressingRuntime(), message)).toBe(
			false,
		);
	});

	it("fires on platform mention or reply context", () => {
		const mention = turn(ALICE, 1, {
			content: {
				text: "any thoughts?",
				mentionContext: { isMention: true, isReply: false },
			},
		});
		expect(humanDirectlyAddressesAgent(addressingRuntime(), mention)).toBe(
			true,
		);
		const reply = turn(BOB, 2, {
			content: {
				text: "actually no",
				mentionContext: { isMention: false, isReply: true },
			},
		});
		expect(humanDirectlyAddressesAgent(addressingRuntime(), reply)).toBe(true);
	});

	it("matches the configured name as a whole word, case-insensitively", () => {
		const runtime = addressingRuntime({ name: "Scot", username: "scotty" });
		expect(
			humanDirectlyAddressesAgent(
				runtime,
				turn(ALICE, 1, { content: { text: "hey Scot can you help" } }),
			),
		).toBe(true);
		expect(
			humanDirectlyAddressesAgent(
				runtime,
				turn(ALICE, 2, { content: { text: "hey SCOT," } }),
			),
		).toBe(true);
		expect(
			humanDirectlyAddressesAgent(
				runtime,
				turn(ALICE, 3, { content: { text: "hey Scott can you help" } }),
			),
		).toBe(false);
		expect(
			humanDirectlyAddressesAgent(
				runtime,
				turn(ALICE, 4, { content: { text: "ascot race" } }),
			),
		).toBe(false);
	});

	it("also matches the configured username", () => {
		const runtime = addressingRuntime({ name: "Nobody", username: "pixi" });
		expect(
			humanDirectlyAddressesAgent(
				runtime,
				turn(ALICE, 1, { content: { text: "ping pixi please" } }),
			),
		).toBe(true);
	});

	it("ignores names shorter than two characters", () => {
		const runtime = addressingRuntime({ name: "Q", username: "" });
		expect(
			humanDirectlyAddressesAgent(
				runtime,
				turn(ALICE, 1, { content: { text: "ok Q" } }),
			),
		).toBe(false);
	});

	it("returns false without text or without any character identity", () => {
		const runtime = addressingRuntime();
		expect(
			humanDirectlyAddressesAgent(
				runtime,
				turn(ALICE, 1, { content: { text: "anything" } }),
			),
		).toBe(false);
		const named = addressingRuntime({ name: "Scot" });
		expect(
			humanDirectlyAddressesAgent(
				named,
				turn(ALICE, 2, { content: { text: "" } }),
			),
		).toBe(false);
		expect(humanDirectlyAddressesAgent(named, turn(ALICE, 3, {}))).toBe(false);
	});

	it("escapes regex metacharacters in configured names safely", () => {
		const runtime = addressingRuntime({ name: "Bot(1)" });
		expect(
			humanDirectlyAddressesAgent(
				runtime,
				turn(ALICE, 1, { content: { text: "hi Bot(1)" } }),
			),
		).toBe(true);
		expect(
			humanDirectlyAddressesAgent(
				runtime,
				turn(ALICE, 2, { content: { text: "hi Bot(12)" } }),
			),
		).toBe(false);
	});
});
