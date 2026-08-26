/**
 * Engagement-gate integration for agent-chatter damping: the third evidence
 * source inside messageAddressedToOtherParticipant ignores an unaddressed
 * bot-authored group turn capping an all-agent run, while human turns,
 * agent-addressed turns, and rooms with a recent human message keep normal
 * handling. Runtime, entity lookup, and history are vi-mocked; no model.
 */
import { describe, expect, it, vi } from "vitest";
import type { Entity, IAgentRuntime, Memory, UUID } from "../../types/index.ts";
import { messageAddressedToOtherParticipant } from "../addressed-to.ts";

const AGENT_ID = "00000000-0000-0000-0000-0000000000aa" as UUID;
const OTHER_BOT = "00000000-0000-0000-0000-0000000000bb" as UUID;
const HUMAN = "00000000-0000-0000-0000-0000000000cc" as UUID;
const ROOM_ID = "00000000-0000-0000-0000-000000000001" as UUID;

let idCounter = 0;
function nextId(): UUID {
	idCounter += 1;
	return `00000000-0000-0000-0000-${String(idCounter).padStart(12, "0")}` as UUID;
}

function historyBot(createdAt: number): Memory {
	return {
		id: nextId(),
		entityId: OTHER_BOT,
		roomId: ROOM_ID,
		createdAt,
		content: {
			text: "bot chatter",
			channelType: "GROUP",
			metadata: { fromBot: true },
		},
	} as Memory;
}

function historyHuman(createdAt: number): Memory {
	return {
		id: nextId(),
		entityId: HUMAN,
		roomId: ROOM_ID,
		createdAt,
		content: { text: "human here", channelType: "GROUP" },
	} as Memory;
}

function makeRuntime(history: Memory[]): IAgentRuntime {
	return {
		agentId: AGENT_ID,
		character: { name: "MyAgent" },
		getEntitiesForRoom: vi.fn(
			async () =>
				[
					{ id: AGENT_ID, names: ["MyAgent"] },
					{ id: OTHER_BOT, names: ["SomeOtherBot"] },
					{ id: HUMAN, names: ["Alice"] },
				] as Entity[],
		),
		getSetting: () => null,
		getMemories: vi.fn(async () => history),
		reportError: vi.fn(),
		logger: { debug: vi.fn(), warn: vi.fn() },
	} as unknown as IAgentRuntime;
}

function incomingBot(text = "more bot chatter", fromBot = true): Memory {
	return {
		id: nextId(),
		entityId: OTHER_BOT,
		roomId: ROOM_ID,
		createdAt: 100,
		content: {
			text,
			channelType: "GROUP",
			...(fromBot ? { metadata: { fromBot: true } } : {}),
		},
	} as Memory;
}

describe("messageAddressedToOtherParticipant — agent-chatter damping seam", () => {
	it("ignores an unaddressed bot turn capping a 4-in-a-row all-agent run", async () => {
		const runtime = makeRuntime([historyBot(1), historyBot(2), historyBot(3)]);
		expect(
			await messageAddressedToOtherParticipant({
				runtime,
				message: incomingBot(),
				addressedTo: [],
			}),
		).toBe(true);
		expect(
			(runtime.logger.debug as ReturnType<typeof vi.fn>).mock.calls.length,
		).toBe(1);
	});

	it("keeps handling when a human message breaks the run", async () => {
		const runtime = makeRuntime([
			historyBot(1),
			historyHuman(2),
			historyBot(3),
		]);
		expect(
			await messageAddressedToOtherParticipant({
				runtime,
				message: incomingBot(),
				addressedTo: [],
			}),
		).toBe(false);
	});

	it("never damps a turn that names this agent, even amid heavy bot chatter", async () => {
		const runtime = makeRuntime([historyBot(1), historyBot(2), historyBot(3)]);
		expect(
			await messageAddressedToOtherParticipant({
				runtime,
				message: incomingBot("MyAgent what do you think?"),
				addressedTo: ["MyAgent"],
			}),
		).toBe(false);
	});

	it("never damps a human-authored turn (no fromBot stamp)", async () => {
		const runtime = makeRuntime([historyBot(1), historyBot(2), historyBot(3)]);
		expect(
			await messageAddressedToOtherParticipant({
				runtime,
				message: incomingBot("humans type too", false),
				addressedTo: [],
			}),
		).toBe(false);
	});

	it("addressed-to-other evidence still wins before damping is consulted", async () => {
		const runtime = makeRuntime([]);
		expect(
			await messageAddressedToOtherParticipant({
				runtime,
				message: incomingBot("Alice can you take this?"),
				addressedTo: ["Alice"],
			}),
		).toBe(true);
		// The suppression came from the corroborated tag, not from damping.
		expect(
			(runtime.getMemories as ReturnType<typeof vi.fn>).mock.calls.length,
		).toBe(0);
	});
});
