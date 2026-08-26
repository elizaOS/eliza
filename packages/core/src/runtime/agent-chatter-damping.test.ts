/**
 * Damping matrix for agent-to-agent chatter: a bot-authored unaddressed group
 * turn capping an all-agent run of >= N messages is damped; human-authored or
 * agent-addressed turns are never damped; a human message anywhere in the
 * trailing run resets it; the flag and threshold are config-overridable and
 * history errors fail open. Stub runtime, no model, no database.
 */
import { describe, expect, it, vi } from "vitest";
import type { Memory, UUID } from "../types/index";
import type { IAgentRuntime } from "../types/runtime";
import {
	AGENT_CHATTER_DAMPING_DEFAULT_RUN,
	agentChatterDampingRunThreshold,
	evaluateAgentChatterDamping,
	isAgentChatterDampingEnabled,
	isBotAuthoredMessage,
	messageStructurallyAddressesAgent,
} from "./agent-chatter-damping";

const AGENT_ID = "00000000-0000-0000-0000-0000000000aa" as UUID;
const OTHER_BOT = "00000000-0000-0000-0000-0000000000bb" as UUID;
const HUMAN = "00000000-0000-0000-0000-0000000000cc" as UUID;
const ROOM_ID = "00000000-0000-0000-0000-000000000001" as UUID;

let idCounter = 0;
function nextId(): UUID {
	idCounter += 1;
	return `00000000-0000-0000-0000-${String(idCounter).padStart(12, "0")}` as UUID;
}

function makeRuntime(args?: {
	settings?: Record<string, string>;
	history?: Memory[];
	historyError?: Error;
}): IAgentRuntime {
	const reportError = vi.fn();
	return {
		agentId: AGENT_ID,
		character: { name: "MyAgent", username: "myagent_bot" },
		getSetting: (key: string) => args?.settings?.[key] ?? null,
		getMemories: vi.fn(async () => {
			if (args?.historyError) throw args.historyError;
			return args?.history ?? [];
		}),
		reportError,
		logger: { debug: vi.fn(), warn: vi.fn() },
	} as unknown as IAgentRuntime;
}

function botMessage(args?: {
	text?: string;
	entityId?: UUID;
	createdAt?: number;
	mentionContext?: Record<string, unknown>;
	channelType?: string;
}): Memory {
	return {
		id: nextId(),
		entityId: args?.entityId ?? OTHER_BOT,
		roomId: ROOM_ID,
		createdAt: args?.createdAt ?? Date.now(),
		content: {
			text: args?.text ?? "agent chatter",
			channelType: args?.channelType ?? "GROUP",
			metadata: { fromBot: true },
			...(args?.mentionContext ? { mentionContext: args.mentionContext } : {}),
		},
	} as Memory;
}

function humanMessage(args?: { text?: string; createdAt?: number }): Memory {
	return {
		id: nextId(),
		entityId: HUMAN,
		roomId: ROOM_ID,
		createdAt: args?.createdAt ?? Date.now(),
		content: { text: args?.text ?? "hi all", channelType: "GROUP" },
	} as Memory;
}

function agentSelfMessage(createdAt: number): Memory {
	return {
		id: nextId(),
		entityId: AGENT_ID,
		roomId: ROOM_ID,
		createdAt,
		content: { text: "my own reply", channelType: "GROUP" },
	} as Memory;
}

/** Trailing run: newest-last list of prior room messages. */
function priorRun(...messages: Memory[]): Memory[] {
	return messages;
}

describe("evaluateAgentChatterDamping — the damping matrix", () => {
	it("damps a bot turn capping a 4-in-a-row all-agent run (default threshold)", async () => {
		const history = priorRun(
			botMessage({ createdAt: 1 }),
			agentSelfMessage(2),
			botMessage({ createdAt: 3 }),
		);
		const decision = await evaluateAgentChatterDamping({
			runtime: makeRuntime({ history }),
			message: botMessage({ createdAt: 4 }),
		});
		expect(decision.damped).toBe(true);
		expect(decision.reason).toBe("agent-run");
		expect(decision.runLength).toBe(4);
		expect(decision.threshold).toBe(AGENT_CHATTER_DAMPING_DEFAULT_RUN);
	});

	it("never damps a human-authored turn, even amid heavy agent chatter", async () => {
		const history = priorRun(
			botMessage({ createdAt: 1 }),
			botMessage({ createdAt: 2 }),
			botMessage({ createdAt: 3 }),
			botMessage({ createdAt: 4 }),
		);
		const decision = await evaluateAgentChatterDamping({
			runtime: makeRuntime({ history }),
			message: humanMessage({ createdAt: 5 }),
		});
		expect(decision.damped).toBe(false);
		expect(decision.reason).toBe("sender-not-bot");
	});

	it("never damps a bot turn that mentions the agent (platform mention)", async () => {
		const history = priorRun(
			botMessage({ createdAt: 1 }),
			botMessage({ createdAt: 2 }),
			botMessage({ createdAt: 3 }),
		);
		const decision = await evaluateAgentChatterDamping({
			runtime: makeRuntime({ history }),
			message: botMessage({
				createdAt: 4,
				mentionContext: { isMention: true },
			}),
		});
		expect(decision.damped).toBe(false);
		expect(decision.reason).toBe("structurally-addressed");
	});

	it("never damps a bot turn that is a platform reply to the agent", async () => {
		const decision = await evaluateAgentChatterDamping({
			runtime: makeRuntime({
				history: priorRun(
					botMessage({ createdAt: 1 }),
					botMessage({ createdAt: 2 }),
					botMessage({ createdAt: 3 }),
				),
			}),
			message: botMessage({ createdAt: 4, mentionContext: { isReply: true } }),
		});
		expect(decision.damped).toBe(false);
		expect(decision.reason).toBe("structurally-addressed");
	});

	it("never damps a bot turn that names the agent in the text", async () => {
		const decision = await evaluateAgentChatterDamping({
			runtime: makeRuntime({
				history: priorRun(
					botMessage({ createdAt: 1 }),
					botMessage({ createdAt: 2 }),
					botMessage({ createdAt: 3 }),
				),
			}),
			message: botMessage({
				createdAt: 4,
				text: "MyAgent can you take this one?",
			}),
		});
		expect(decision.damped).toBe(false);
		expect(decision.reason).toBe("structurally-addressed");
	});

	it("a human message inside the trailing window resets the run", async () => {
		const history = priorRun(
			botMessage({ createdAt: 1 }),
			botMessage({ createdAt: 2 }),
			humanMessage({ createdAt: 3 }),
			botMessage({ createdAt: 4 }),
			botMessage({ createdAt: 5 }),
		);
		const decision = await evaluateAgentChatterDamping({
			runtime: makeRuntime({ history }),
			message: botMessage({ createdAt: 6 }),
		});
		expect(decision.damped).toBe(false);
		expect(decision.reason).toBe("human-present");
		expect(decision.runLength).toBe(3);
	});

	it("unknown authorship counts as human and breaks the run (fail open)", async () => {
		const history = priorRun(
			botMessage({ createdAt: 1 }),
			botMessage({ createdAt: 2 }),
			humanMessage({ createdAt: 3, text: "unstamped connector message" }),
			botMessage({ createdAt: 4 }),
		);
		const decision = await evaluateAgentChatterDamping({
			runtime: makeRuntime({ history }),
			message: botMessage({ createdAt: 5 }),
		});
		expect(decision.damped).toBe(false);
		expect(decision.reason).toBe("human-present");
	});

	it("a short all-agent run stays below threshold", async () => {
		const decision = await evaluateAgentChatterDamping({
			runtime: makeRuntime({
				history: priorRun(botMessage({ createdAt: 1 })),
			}),
			message: botMessage({ createdAt: 2 }),
		});
		expect(decision.damped).toBe(false);
		expect(decision.reason).toBe("run-below-threshold");
		expect(decision.runLength).toBe(2);
	});

	it("the agent's own replies count toward the run", async () => {
		const history = priorRun(
			agentSelfMessage(1),
			agentSelfMessage(2),
			botMessage({ createdAt: 3 }),
		);
		const decision = await evaluateAgentChatterDamping({
			runtime: makeRuntime({ history }),
			message: botMessage({ createdAt: 4 }),
		});
		expect(decision.damped).toBe(true);
		expect(decision.runLength).toBe(4);
	});

	it("ELIZA_AGENT_CHATTER_DAMPING=off disables damping entirely", async () => {
		const decision = await evaluateAgentChatterDamping({
			runtime: makeRuntime({
				settings: { ELIZA_AGENT_CHATTER_DAMPING: "off" },
				history: priorRun(
					botMessage({ createdAt: 1 }),
					botMessage({ createdAt: 2 }),
					botMessage({ createdAt: 3 }),
				),
			}),
			message: botMessage({ createdAt: 4 }),
		});
		expect(decision.damped).toBe(false);
		expect(decision.reason).toBe("disabled");
	});

	it("ELIZA_AGENT_CHATTER_DAMPING_RUN raises the threshold", async () => {
		const history = priorRun(
			botMessage({ createdAt: 1 }),
			botMessage({ createdAt: 2 }),
			botMessage({ createdAt: 3 }),
		);
		const decision = await evaluateAgentChatterDamping({
			runtime: makeRuntime({
				settings: { ELIZA_AGENT_CHATTER_DAMPING_RUN: "6" },
				history,
			}),
			message: botMessage({ createdAt: 4 }),
		});
		expect(decision.damped).toBe(false);
		expect(decision.threshold).toBe(6);
	});

	it("DM turns are never damped (canonical structural classifier)", async () => {
		const decision = await evaluateAgentChatterDamping({
			runtime: makeRuntime({
				history: priorRun(
					botMessage({ createdAt: 1 }),
					botMessage({ createdAt: 2 }),
					botMessage({ createdAt: 3 }),
				),
			}),
			message: botMessage({ createdAt: 4, channelType: "DM" }),
		});
		expect(decision.damped).toBe(false);
		expect(decision.reason).toBe("not-unaddressed-text-group");
	});

	it("an unreadable history fails open and reports the error", async () => {
		const runtime = makeRuntime({
			historyError: new Error("db down"),
		});
		const decision = await evaluateAgentChatterDamping({
			runtime,
			message: botMessage({ createdAt: 4 }),
		});
		expect(decision.damped).toBe(false);
		expect(decision.reason).toBe("history-unavailable");
		expect(
			(runtime.reportError as ReturnType<typeof vi.fn>).mock.calls.length,
		).toBe(1);
	});
});

describe("config + helper surface", () => {
	it("damping defaults ON and the threshold defaults to 4", () => {
		const runtime = makeRuntime();
		expect(isAgentChatterDampingEnabled(runtime)).toBe(true);
		expect(agentChatterDampingRunThreshold(runtime)).toBe(4);
	});

	it("non-numeric or too-small thresholds fall back to the default", () => {
		expect(
			agentChatterDampingRunThreshold(
				makeRuntime({ settings: { ELIZA_AGENT_CHATTER_DAMPING_RUN: "1" } }),
			),
		).toBe(AGENT_CHATTER_DAMPING_DEFAULT_RUN);
		expect(
			agentChatterDampingRunThreshold(
				makeRuntime({ settings: { ELIZA_AGENT_CHATTER_DAMPING_RUN: "nah" } }),
			),
		).toBe(AGENT_CHATTER_DAMPING_DEFAULT_RUN);
	});

	it("isBotAuthoredMessage reads both metadata surfaces", () => {
		expect(isBotAuthoredMessage(botMessage())).toBe(true);
		expect(
			isBotAuthoredMessage({
				id: nextId(),
				entityId: OTHER_BOT,
				roomId: ROOM_ID,
				content: { text: "x" },
				metadata: { fromBot: true },
			} as Memory),
		).toBe(true);
		expect(isBotAuthoredMessage(humanMessage())).toBe(false);
	});

	it("messageStructurallyAddressesAgent matches name tokens", () => {
		const runtime = makeRuntime();
		expect(
			messageStructurallyAddressesAgent(
				runtime,
				botMessage({ text: "what do you think, myagent?" }),
			),
		).toBe(true);
		expect(
			messageStructurallyAddressesAgent(
				runtime,
				botMessage({ text: "carry on without them" }),
			),
		).toBe(false);
	});
});
