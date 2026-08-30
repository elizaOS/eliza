/**
 * Deterministic bot-to-bot loop gate — the model-size-independent floor
 * beneath the soft ANXIETY / BOT_AWARENESS prompt signals.
 *
 * Why code, not prompt: the multi-agent "endless hell loop" is worst on
 * agents running SMALL models (remilio on gemma-4), and small models do not
 * reliably follow soft prompt guidance — so a purely advisory fix would be
 * ignored by exactly the agent most likely to cause the loop. This gate trips
 * in the message-handling decision path BEFORE any model call, so it behaves
 * identically on gemma-4 and on frontier models: the model never gets the
 * chance to loop.
 *
 * The first gate enforces address precedence: a trusted bot-authored group
 * turn is silent unless it directly addresses this agent. The second, older
 * loop-depth gate stops a directly unaddressed exchange after N agent turns.
 * Both require all relevant signals to be verifiable; uncertain authorship or
 * room type fails OPEN into the normal pipeline:
 *   - the inbound message is positively bot-authored (connector-stamped
 *     `fromBot` — the same ground truth the transcript formatter and the
 *     bot-noise triage read; never name-guessing),
 *   - the room is a multi-party text/voice-group channel (group chat only —
 *     DMs are never gated),
 *   - direct address bypasses both suppressions so intentional agent-to-agent
 *     orchestration remains available,
 *   - the depth gate additionally requires >= N consecutive agent turns since
 *     the last human message in the room (default N=2, configurable).
 *
 * When tripped the turn ends with a deterministic IGNORE: no composeState, no
 * Stage-1 call, no reply. A human speaking in the room resets the counter
 * naturally (their message becomes the newest human turn), so human-driven
 * conversation is never suppressed — the gate only ever biases toward
 * silence, never toward speaking, and it strictly ADDS to existing gating
 * (personality reply-gate, mute, bot-noise triage all still run).
 *
 * The shared prompt policy remains the soft layer for models that read; these
 * gates are the model-independent floor. Both use connector metadata rather
 * than names or user-written speaker labels.
 *
 * Cost: one complete room messages-scan, issued only for bot-authored group
 * turns — exactly the query shape the runtime's
 * turn-scoped single-flight memo coalesces with the compose fan-out, so no
 * new query load on the hot path. No model calls, no embeddings.
 */

import {
	computeGroupConversationMetrics,
	isBotAuthoredMessage,
	isMultiPartyChannel,
	resolveChannelType,
} from "../../features/basic-capabilities/providers/group-conversation-signals.ts";
import { isInternalBridgeMessage } from "../../messaging/automated-turns.ts";
import type { Memory } from "../../types/memory";
import type { IAgentRuntime } from "../../types/runtime";

/** Default max consecutive agent turns into a human-free bot exchange. */
export const DEFAULT_BOT_LOOP_MAX_AGENT_TURNS = 2;

export interface BotLoopGateResult {
	/** True when the deterministic gate trips: end the turn with IGNORE. */
	ignored: boolean;
	/** Agent turns since the last human message (when computed). */
	agentTurnsSinceLastHuman?: number;
	/** Why the gate did not apply, for debug logging. */
	reason?:
		| "disabled"
		| "directly_addressed"
		| "not_bot_authored"
		| "not_group_channel"
		| "below_threshold"
		| "window_unavailable";
}

export interface BotGroupAddressGateResult {
	/** True when an unaddressed, trusted bot-authored group turn must be silent. */
	ignored: boolean;
	reason:
		| "not_bot_authored"
		| "not_group_channel"
		| "directly_addressed"
		| "unaddressed_bot";
}

/**
 * Enforce the response-precedence contract before any model call. Connector
 * metadata establishes bot authorship; human-authored text that merely says
 * "(bot)" can never enter this gate. A direct address wins so intentional
 * agent-to-agent orchestration remains reachable.
 */
export async function runBotGroupAddressGate(args: {
	runtime: IAgentRuntime;
	message: Memory;
	explicitlyAddressesAgent: boolean;
}): Promise<BotGroupAddressGateResult> {
	const { runtime, message, explicitlyAddressesAgent } = args;
	if (!isBotAuthoredMessage(message)) {
		return { ignored: false, reason: "not_bot_authored" };
	}
	const channelType = await resolveChannelType(runtime, message);
	if (!isMultiPartyChannel(channelType)) {
		return { ignored: false, reason: "not_group_channel" };
	}
	if (explicitlyAddressesAgent) {
		return { ignored: false, reason: "directly_addressed" };
	}
	return { ignored: true, reason: "unaddressed_bot" };
}

/** The gate is ON by default; opt out with ELIZA_BOT_LOOP_GATE=0|false|off. */
export function isBotLoopGateEnabled(runtime: IAgentRuntime): boolean {
	const raw = runtime.getSetting("ELIZA_BOT_LOOP_GATE");
	if (raw === undefined || raw === null) return true;
	const normalized = String(raw).trim().toLowerCase();
	return !["0", "false", "no", "off"].includes(normalized);
}

/**
 * Consecutive agent turns allowed into a human-free bot exchange before the
 * depth stop. Clamped to >= 1; directly addressed bot requests bypass it.
 */
export function botLoopMaxAgentTurns(runtime: IAgentRuntime): number {
	const raw = runtime.getSetting("ELIZA_BOT_LOOP_MAX_AGENT_TURNS");
	const parsed =
		raw === undefined || raw === null
			? Number.NaN
			: Number.parseInt(String(raw), 10);
	if (!Number.isFinite(parsed) || parsed < 1) {
		return DEFAULT_BOT_LOOP_MAX_AGENT_TURNS;
	}
	return parsed;
}

/**
 * Run the deterministic gate. Pure decision logic over the complete room
 * history; every uncertain path fails OPEN (`ignored: false`).
 */
export async function runBotLoopGate(args: {
	runtime: IAgentRuntime;
	message: Memory;
	explicitlyAddressesAgent?: boolean;
}): Promise<BotLoopGateResult> {
	const { runtime, message, explicitlyAddressesAgent = false } = args;
	if (!isBotLoopGateEnabled(runtime)) {
		return { ignored: false, reason: "disabled" };
	}
	// Positively bot-authored inbound only. Human and untagged senders never
	// enter the gate — a connector that omits `fromBot` degrades to normal
	// behavior. Transcript text and speaker labels are never authentication.
	if (!isBotAuthoredMessage(message)) {
		return { ignored: false, reason: "not_bot_authored" };
	}
	// Group chat only. Unknown/missing channel type fails open.
	const channelType = await resolveChannelType(runtime, message);
	if (!isMultiPartyChannel(channelType)) {
		return { ignored: false, reason: "not_group_channel" };
	}
	// Direct address has higher precedence than bot-loop suppression. A named
	// agent-to-agent request is intentional orchestration, not ambient reverb.
	if (explicitlyAddressesAgent) {
		return { ignored: false, reason: "directly_addressed" };
	}
	if (!message.roomId) {
		return { ignored: false, reason: "window_unavailable" };
	}
	let window: Memory[];
	try {
		// Coalesced by the runtime's turn-scoped room-scan memo — shares the
		// superset fetch the compose fan-out issues anyway.
		window = await runtime.getMemories({
			tableName: "messages",
			roomId: message.roomId,
			unique: false,
		});
	} catch (error) {
		// error-policy:J4 This optional suppression gate deliberately degrades to
		// the ordinary response pipeline when its bounded room read is unavailable.
		runtime.reportError("BotLoopGate.window", error, {
			roomId: message.roomId,
		});
		return { ignored: false, reason: "window_unavailable" };
	}
	const dialogue = window
		.filter(
			(entry) =>
				entry.content?.type !== "action_result" &&
				!isInternalBridgeMessage(entry),
		)
		.sort((a, b) => {
			const aSafe = Number.isFinite(a.createdAt ?? 0) ? (a.createdAt ?? 0) : 0;
			const bSafe = Number.isFinite(b.createdAt ?? 0) ? (b.createdAt ?? 0) : 0;
			if (aSafe !== bSafe) return aSafe - bSafe;
			return String(a.id ?? "").localeCompare(String(b.id ?? ""));
		});
	const metrics = computeGroupConversationMetrics(dialogue, runtime.agentId);
	const maxAgentTurns = botLoopMaxAgentTurns(runtime);
	// The agent must ALREADY be a participant in the human-free tail: at least
	// one bot turn and >= maxAgentTurns agent turns since the last human. A
	// human message anywhere newer than the agent's turns resets both counters
	// to zero, so an active human conversation can never trip this.
	if (
		metrics.botTurnsSinceLastHuman > 0 &&
		metrics.agentTurnsSinceLastHuman >= maxAgentTurns
	) {
		return {
			ignored: true,
			agentTurnsSinceLastHuman: metrics.agentTurnsSinceLastHuman,
		};
	}
	return {
		ignored: false,
		reason: "below_threshold",
		agentTurnsSinceLastHuman: metrics.agentTurnsSinceLastHuman,
	};
}
