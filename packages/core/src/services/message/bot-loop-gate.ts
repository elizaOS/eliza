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
 * Trip condition (ALL must hold; anything unverifiable fails OPEN into the
 * normal pipeline):
 *   - the inbound message is positively bot-authored (connector-stamped
 *     `fromBot` — the same ground truth the transcript formatter and the
 *     bot-noise triage read; never name-guessing),
 *   - the room is a multi-party text/voice-group channel (group chat only —
 *     DMs are never gated),
 *   - the agent has already produced >= N consecutive turns since the last
 *     human message in the room (default N=2, configurable), i.e. an actual
 *     agent↔bot exchange with no human advancing the conversation.
 *
 * When tripped the turn ends with a deterministic IGNORE: no composeState, no
 * Stage-1 call, no reply. A human speaking in the room resets the counter
 * naturally (their message becomes the newest human turn), so human-driven
 * conversation is never suppressed — the gate only ever biases toward
 * silence, never toward speaking, and it strictly ADDS to existing gating
 * (personality reply-gate, mute, bot-noise triage all still run).
 *
 * Layering with PR #25405 (register-aware + restraint defaults): #25405 adds
 * IGNORE-biased multi-agent rules to the shouldRespond PROMPTS ("never reply
 * to another bot's reply", "one speaker per human message"). Those are the
 * soft layer for models that read; this gate is the hard floor for models
 * that don't. Same policy, two enforcement strengths.
 *
 * Cost: one room messages-scan bounded to the signal window, issued only for
 * bot-authored group turns — exactly the query shape the runtime's
 * turn-scoped single-flight memo coalesces with the compose fan-out, so no
 * new query load on the hot path. No model calls, no embeddings.
 */

import {
	computeGroupConversationMetrics,
	GROUP_SIGNAL_WINDOW,
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
		| "not_bot_authored"
		| "not_group_channel"
		| "below_threshold"
		| "window_unavailable";
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
 * hard stop. Clamped to >= 1 so the agent can always answer a bot once (a
 * single bot question deserves a single answer; the loop starts at the
 * reply-to-a-reply).
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
 * Run the deterministic gate. Pure decision logic over the bounded room
 * window; every uncertain path fails OPEN (`ignored: false`).
 */
export async function runBotLoopGate(args: {
	runtime: IAgentRuntime;
	message: Memory;
}): Promise<BotLoopGateResult> {
	const { runtime, message } = args;
	if (!isBotLoopGateEnabled(runtime)) {
		return { ignored: false, reason: "disabled" };
	}
	// Positively bot-authored inbound only. Human and untagged senders never
	// enter the gate — a connector that omits `fromBot` degrades to normal
	// behavior, exactly like the transcript "(bot)" tag.
	if (!isBotAuthoredMessage(message)) {
		return { ignored: false, reason: "not_bot_authored" };
	}
	// Group chat only. Unknown/missing channel type fails open.
	const channelType = await resolveChannelType(runtime, message);
	if (!isMultiPartyChannel(channelType)) {
		return { ignored: false, reason: "not_group_channel" };
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
			limit: GROUP_SIGNAL_WINDOW,
			unique: false,
		});
	} catch {
		// error-policy: a read failure must never mute the agent — fail open.
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
		})
		.slice(-GROUP_SIGNAL_WINDOW);
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
