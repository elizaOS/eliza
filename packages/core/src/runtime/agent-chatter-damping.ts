/**
 * Deterministic agent-to-agent chatter damping for the engagement gate. In a
 * group room where the trailing run of messages is entirely agent/bot-authored
 * with no human in between, an unaddressed bot-authored turn biases toward
 * IGNORE — two chatty agents otherwise validate each other in essay-length
 * loops until a human complains (live 2026-08-24, tj-c2c32c8976d42e →
 * tj-c3488b65cdbefe: a misread reply-address spawned ~25 mutual-validation
 * replies in 7 minutes; "what a waste of tokens"). The damping NEVER touches
 * human-authored turns, turns that structurally address this agent (platform
 * mention, reply, or the agent's name in the text), or rooms where a human
 * message breaks the bot run — those all fail open into normal handling.
 * Config: ELIZA_AGENT_CHATTER_DAMPING (default ON; 0/false/no/off disables),
 * ELIZA_AGENT_CHATTER_DAMPING_RUN (trailing run length that arms damping,
 * default 4, minimum 2; the incoming bot message counts toward the run).
 */

import { isUnaddressedTextGroupTurn } from "../services/message/stage1-prompt-tier";
import type { Memory } from "../types/memory";
import type { IAgentRuntime } from "../types/runtime";
import { textContainsAgentName } from "../utils/agent-name-match";

/** Default trailing all-agent run length that arms damping. */
export const AGENT_CHATTER_DAMPING_DEFAULT_RUN = 4;

/** Extra history fetched beyond the run threshold so a breaker is visible. */
const HISTORY_FETCH_MARGIN = 8;

export type AgentChatterDampingReason =
	| "disabled"
	| "sender-not-bot"
	| "structurally-addressed"
	| "not-unaddressed-text-group"
	| "history-unavailable"
	| "human-present"
	| "run-below-threshold"
	| "agent-run";

export interface AgentChatterDampingDecision {
	damped: boolean;
	reason: AgentChatterDampingReason;
	/** Consecutive agent-authored messages observed, incoming turn included. */
	runLength: number;
	threshold: number;
}

function metadataRecord(value: unknown): Record<string, unknown> | undefined {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}

function readSetting(runtime: IAgentRuntime, key: string): unknown {
	return typeof runtime.getSetting === "function"
		? runtime.getSetting(key)
		: undefined;
}

/** Damping is ON by default; opt out with ELIZA_AGENT_CHATTER_DAMPING=0|false|off. */
export function isAgentChatterDampingEnabled(runtime: IAgentRuntime): boolean {
	const raw = readSetting(runtime, "ELIZA_AGENT_CHATTER_DAMPING");
	if (raw === undefined || raw === null) return true;
	const normalized = String(raw).trim().toLowerCase();
	return !["0", "false", "no", "off"].includes(normalized);
}

/** Trailing-run threshold; ELIZA_AGENT_CHATTER_DAMPING_RUN, default 4, min 2. */
export function agentChatterDampingRunThreshold(
	runtime: IAgentRuntime,
): number {
	const raw = readSetting(runtime, "ELIZA_AGENT_CHATTER_DAMPING_RUN");
	const parsed = Number.parseInt(String(raw ?? ""), 10);
	if (!Number.isFinite(parsed) || parsed < 2) {
		return AGENT_CHATTER_DAMPING_DEFAULT_RUN;
	}
	return parsed;
}

/** Connector-stamped bot authorship: `fromBot` on either metadata surface. */
export function isBotAuthoredMessage(message: Memory): boolean {
	return (
		metadataRecord(message.content?.metadata)?.fromBot === true ||
		metadataRecord(message.metadata)?.fromBot === true
	);
}

/**
 * A stored room message counts as agent-authored when it is this agent's own
 * reply or carries the connector's bot stamp. Anything else — including
 * unknown authorship — counts as human, so damping fails open toward
 * responding.
 */
function isAgentAuthoredHistory(
	runtime: IAgentRuntime,
	memory: Memory,
): boolean {
	if (memory.entityId === runtime.agentId) return true;
	return isBotAuthoredMessage(memory);
}

/**
 * Structural "this turn addresses the agent" signal: platform mention,
 * platform reply, or the agent's name/username in the text. Mirrors the
 * message-service reply-gate ground truth so a structurally addressed turn is
 * never damped regardless of caller preconditions.
 */
export function messageStructurallyAddressesAgent(
	runtime: IAgentRuntime,
	message: Memory,
): boolean {
	const mentionContext = message.content?.mentionContext;
	return (
		mentionContext?.isMention === true ||
		mentionContext?.isReply === true ||
		textContainsAgentName(message.content?.text, [
			runtime.character?.name,
			runtime.character?.username,
		])
	);
}

/**
 * Decide whether this turn is damped agent-to-agent chatter. Deterministic:
 * no model call, one room-history read, and every uncertain path (missing
 * flags, unknown channel type, history errors) fails open to "not damped".
 */
export async function evaluateAgentChatterDamping(args: {
	runtime: IAgentRuntime;
	message: Memory;
}): Promise<AgentChatterDampingDecision> {
	const { runtime, message } = args;
	const threshold = agentChatterDampingRunThreshold(runtime);
	const decide = (
		damped: boolean,
		reason: AgentChatterDampingReason,
		runLength: number,
	): AgentChatterDampingDecision => ({ damped, reason, runLength, threshold });

	if (!isAgentChatterDampingEnabled(runtime)) {
		return decide(false, "disabled", 0);
	}
	// Only positively bot-authored turns are ever damped — a human message is
	// by definition a human re-entering the room.
	if (!isBotAuthoredMessage(message)) {
		return decide(false, "sender-not-bot", 0);
	}
	const structurallyAddressed = messageStructurallyAddressesAgent(
		runtime,
		message,
	);
	if (structurallyAddressed) {
		return decide(false, "structurally-addressed", 0);
	}
	// Canonical structural classifier: DMs, autonomous self-turns, sub-agent
	// relays, client-chat sources, and unknown channel types all fail open.
	if (!isUnaddressedTextGroupTurn(message, structurallyAddressed)) {
		return decide(false, "not-unaddressed-text-group", 0);
	}

	let history: Memory[];
	try {
		history = await runtime.getMemories({
			tableName: "messages",
			roomId: message.roomId,
			count: threshold + HISTORY_FETCH_MARGIN,
		});
	} catch (error) {
		// error-policy:J4 damping is a cost/noise bias, never load-bearing: an
		// unreadable history fails open to normal handling, observably.
		runtime.reportError("AgentChatterDamping.history", error, {
			roomId: message.roomId,
		});
		return decide(false, "history-unavailable", 1);
	}

	const prior = history
		.filter((memory) => memory.id !== message.id)
		.sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0));

	// The incoming bot message is the newest link of the run.
	let runLength = 1;
	let sawBreaker = false;
	for (const memory of prior) {
		if (!isAgentAuthoredHistory(runtime, memory)) {
			sawBreaker = true;
			break;
		}
		runLength += 1;
		if (runLength >= threshold) break;
	}

	if (runLength >= threshold) {
		return decide(true, "agent-run", runLength);
	}
	return decide(
		false,
		sawBreaker ? "human-present" : "run-below-threshold",
		runLength,
	);
}
