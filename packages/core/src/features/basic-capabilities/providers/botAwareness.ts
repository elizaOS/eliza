/**
 * BOT_AWARENESS — anti-loop signal for agent-to-agent exchanges in group
 * channels.
 *
 * Two agents that both reply to replies can trap each other in an endless
 * mutual-acknowledgement loop with no human in the exchange. This provider
 * gives the model explicit awareness that a recent interlocutor is another
 * bot, using the connector-stamped `fromBot` metadata (the same ground truth
 * the transcript formatter renders as "Name (bot)" and the bot-noise triage
 * gate reads — never name-guessing).
 *
 * Fires only when BOTH hold:
 *   - the latest inbound turn is bot-authored, and
 *   - there has been agent↔bot back-and-forth with NO human turn in between
 *     (bot turns + own turns since the last human message).
 *
 * The guidance escalates with the depth of the human-free bot exchange, from
 * "you're talking to another bot — don't mirror its conversational reflexes"
 * to "let it drop: prefer IGNORE / silence until a human advances the
 * conversation." Soft signal only: when a human is active in the gap, or the
 * interlocutor is human, the provider renders nothing and behavior is normal.
 *
 * Group-only like ANXIETY (Shaw framed these as two separate things, so it is
 * a separate provider — they share the room-signal helpers). Same hot-path
 * discipline: composed recent-messages state or the coalesced room scan; no
 * model calls, no embeddings, no new DB query shapes.
 */

import type {
	IAgentRuntime,
	Memory,
	Provider,
	State,
} from "../../../types/index.ts";
import { addHeader } from "../../../utils.ts";
import {
	computeGroupConversationMetrics,
	type GroupConversationMetrics,
	isBotAuthoredMessage,
	isMultiPartyChannel,
	loadDialogueWindow,
	resolveChannelType,
} from "./group-conversation-signals.ts";

const EMPTY_RESULT = { text: "", values: {}, data: {} } as const;

/**
 * Bot-loop assessment: fires when the newest turn is bot-authored and the
 * agent has already replied at least once inside the human-free tail — i.e.
 * an actual bot↔agent exchange, not merely a bot posting into the room.
 */
export interface BotLoopAssessment {
	active: boolean;
	/** Human-free exchange depth (agent turns + bot turns since last human). */
	exchangeDepth: number;
	/** Whether the loop has gone deep (escalated wording). */
	deep: boolean;
}

/** Exchange depth at which the wording escalates to "let it drop". */
export const DEEP_BOT_LOOP_DEPTH = 4;

export function assessBotLoop(
	metrics: GroupConversationMetrics,
): BotLoopAssessment {
	const exchangeDepth =
		metrics.agentTurnsSinceLastHuman + metrics.botTurnsSinceLastHuman;
	const active =
		metrics.latestFromBot &&
		metrics.botTurnsSinceLastHuman > 0 &&
		metrics.agentTurnsSinceLastHuman > 0;
	return {
		active,
		exchangeDepth,
		deep: active && exchangeDepth >= DEEP_BOT_LOOP_DEPTH,
	};
}

function renderBotAwarenessText(assessment: BotLoopAssessment): string {
	const lines: string[] = [
		"The message you are looking at was written by another bot/agent, and no human has spoken since this exchange began.",
	];
	if (assessment.deep) {
		lines.push(
			`This bot-to-bot exchange is already ${assessment.exchangeDepth} messages deep with no human input. Let it drop: do not reply to its reply. Prefer IGNORE or silence until a human advances the conversation.`,
		);
	} else {
		lines.push(
			"Do not get pulled into a loop: another agent will answer politeness with politeness and questions with questions indefinitely. If its message contains nothing a human asked for, there is no obligation to respond — IGNORE is the right move.",
		);
	}
	lines.push(
		"Never reply-to-a-reply between bots without a human advancing the conversation in between.",
	);
	return addHeader("# Talking to another bot", lines.join("\n"));
}

export const botAwarenessProvider: Provider = {
	name: "BOT_AWARENESS",
	description:
		"Anti-loop awareness for group channels: flags when the current interlocutor is another bot and the exchange has had no intervening human turn. Advisory only — never gates action selection.",
	dynamic: true,
	position: -3,
	contexts: ["general"],
	contextGate: { anyOf: ["general"] },
	cacheStable: false,
	cacheScope: "turn",
	// Must reach Stage-1 response state on ambient group turns — that is where
	// bot-to-bot loops form.
	alwaysInResponseState: true,
	roleGate: { minRole: "GUEST" },

	get: async (runtime: IAgentRuntime, message: Memory, state: State) => {
		try {
			const channelType = await resolveChannelType(runtime, message);
			if (!isMultiPartyChannel(channelType)) {
				// Group chat only — inert in DMs like ANXIETY.
				return { ...EMPTY_RESULT };
			}
			// Cheap precondition: if the inbound turn itself is not bot-authored
			// there is no loop to warn about, skip the window load entirely.
			if (!isBotAuthoredMessage(message)) {
				return { ...EMPTY_RESULT };
			}
			const window = await loadDialogueWindow(runtime, message, state);
			const metrics = computeGroupConversationMetrics(window, runtime.agentId);
			const assessment = assessBotLoop(metrics);
			if (!assessment.active) {
				return { ...EMPTY_RESULT };
			}
			return {
				text: renderBotAwarenessText(assessment),
				values: {
					botLoopActive: true,
					botLoopExchangeDepth: assessment.exchangeDepth,
					botLoopDeep: assessment.deep,
				},
				data: { metrics, assessment },
			};
		} catch {
			// Advisory only — degrade to silence on any failure.
			return { ...EMPTY_RESULT };
		}
	},
};
