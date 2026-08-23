/**
 * ANXIETY — evidence-based social-cost signal for multi-party channels.
 *
 * Modernizes the original bootstrap anxiety provider (which returned three
 * RANDOM canned "you are too verbose" lines regardless of what was happening
 * in the room). This version computes rising pressure from LIVE room state:
 *
 *   - talked-too-much: the agent's share of the recent dialogue window versus
 *     its fair share of the floor (1 / (participants + 1)), so the same
 *     number of agent turns weighs heavier in a crowded room — the
 *     "anxiety based on room" calibration,
 *   - ping-pong: a strict tail alternation between the agent and one other
 *     sender (A→B→A→B) ramps pressure even at moderate overall share,
 *   - dampeners: zero pressure when the agent has been quiet, and strong
 *     damping when a human just directly addressed the agent — genuine
 *     engagement is never suppressed.
 *
 * Output is advisory prompt text only (soft signal, like the original): at
 * low pressure a light "brevity is welcome" note, at high pressure a strong
 * "you have been dominating the floor — prefer IGNORE / a reaction / silence"
 * instruction. IGNORE-as-valid-response framing is kept from the original.
 *
 * Strictly group-only: DMs, voice DMs, API and unknown channels return the
 * empty result ("just group chat" — Shaw + Shadow, 2026-08-23). Cheap on the
 * hot path: reads the already-composed RECENT_MESSAGES state, falling back to
 * the runtime's coalesced room messages-scan; no model calls, no embeddings,
 * no new query shapes.
 *
 * Calibration is a plain exported constant consumed through a parameter, so a
 * host can compute per-room calibration later without changing the provider
 * contract. No agent- or deployment-specific values are hardcoded.
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
	humanDirectlyAddressesAgent,
	isMultiPartyChannel,
	loadDialogueWindow,
	resolveChannelType,
} from "./group-conversation-signals.ts";

const EMPTY_RESULT = { text: "", values: {}, data: {} } as const;

export interface AnxietyCalibration {
	/** Excess-share multiplier: how fast pressure grows past fair share. */
	excessShareGain: number;
	/** Agent turns in the tail alternation before ping-pong pressure starts. */
	pingPongThreshold: number;
	/** Pressure added per agent turn past the ping-pong threshold. */
	pingPongGain: number;
	/** Cap on the crowd multiplier applied to excess share. */
	maxCrowdFactor: number;
	/** Pressure below this renders nothing (quiet rooms stay unprompted). */
	noticeFloor: number;
	/** Pressure at or above this renders the strong yield-the-floor text. */
	highWatermark: number;
	/** Multiplier applied when a human just directly addressed the agent. */
	addressedDamping: number;
}

export const DEFAULT_ANXIETY_CALIBRATION: AnxietyCalibration = {
	excessShareGain: 2.5,
	pingPongThreshold: 2,
	pingPongGain: 0.2,
	maxCrowdFactor: 2,
	noticeFloor: 0.15,
	highWatermark: 0.7,
	addressedDamping: 0.25,
};

export interface AnxietyPressure {
	/** Final pressure in [0, 1]. */
	pressure: number;
	/** Component: excess-share (talked-too-much) contribution before damping. */
	talkPressure: number;
	/** Component: ping-pong contribution before damping. */
	pingPongPressure: number;
	/** The fair floor share used for the excess computation. */
	fairShare: number;
	/** Whether the addressed-by-a-human dampener applied. */
	dampedByAddress: boolean;
}

/**
 * Pure pressure computation over the room metrics. Exported for tests and for
 * hosts that want to feed per-room calibration.
 */
export function computeAnxietyPressure(
	metrics: GroupConversationMetrics,
	addressedByHuman: boolean,
	calibration: AnxietyCalibration = DEFAULT_ANXIETY_CALIBRATION,
): AnxietyPressure {
	// A silent agent has no social cost to manage.
	if (metrics.windowSize === 0 || metrics.agentTurns === 0) {
		return {
			pressure: 0,
			talkPressure: 0,
			pingPongPressure: 0,
			fairShare: 1,
			dampedByAddress: false,
		};
	}

	// Fair share of the floor: one voice among the humans present. More
	// participants → smaller fair share → the same agent turn count produces
	// more excess. This is the room-aware core.
	const fairShare = 1 / (metrics.participantCount + 1);
	const excess = Math.max(0, metrics.agentShare - fairShare);
	// Crowd factor: busier rooms (more distinct participants) ramp faster.
	const crowdFactor = Math.min(
		calibration.maxCrowdFactor,
		1 + Math.max(0, metrics.participantCount - 1) / 4,
	);
	const talkPressure = Math.min(
		1,
		excess * calibration.excessShareGain * crowdFactor,
	);

	const pingPongPressure = Math.min(
		1,
		Math.max(0, metrics.pingPongRun - calibration.pingPongThreshold) *
			calibration.pingPongGain,
	);

	let pressure = Math.min(1, talkPressure + pingPongPressure);
	const dampedByAddress = addressedByHuman && pressure > 0;
	if (dampedByAddress) {
		pressure *= calibration.addressedDamping;
	}

	return {
		pressure,
		talkPressure,
		pingPongPressure,
		fairShare,
		dampedByAddress,
	};
}

function renderAnxietyText(
	metrics: GroupConversationMetrics,
	result: AnxietyPressure,
	calibration: AnxietyCalibration,
): string {
	const sharePct = Math.round(metrics.agentShare * 100);
	const lines: string[] = [];
	if (result.pressure >= calibration.highWatermark) {
		lines.push(
			`You have sent ${metrics.agentTurns} of the last ${metrics.windowSize} messages in this group (${sharePct}% of the floor). That is a lot. Others should have the floor now.`,
		);
		if (result.pingPongPressure > 0) {
			lines.push(
				"You are in a rapid back-and-forth with a single participant. Step out of the exchange rather than extending it.",
			);
		}
		lines.push(
			"Strongly prefer IGNORE, a brief reaction, or silence over another reply. Only respond if directly asked something new.",
		);
	} else {
		lines.push(
			`You have been fairly active here (${metrics.agentTurns} of the last ${metrics.windowSize} messages). Keep replies short and let the conversation breathe.`,
		);
		if (result.pingPongPressure > 0) {
			lines.push(
				"You are trading messages with one participant repeatedly — avoid turning the group channel into a two-way thread.",
			);
		}
		lines.push(
			"IGNORE is a valid and often better response than a marginal reply.",
		);
	}
	if (result.dampedByAddress) {
		lines.push(
			"That said, you were just directly addressed — a focused, concise answer to that is appropriate.",
		);
	}
	return addHeader("# Group conversation awareness", lines.join("\n"));
}

export const anxietyProvider: Provider = {
	name: "ANXIETY",
	description:
		"Evidence-based social-cost signal for group channels: rises with the agent's share of recent turns and ping-pong exchanges; inert in DMs. Advisory only — never gates action selection.",
	dynamic: true,
	position: -3,
	contexts: ["general"],
	contextGate: { anyOf: ["general"] },
	cacheStable: false,
	cacheScope: "turn",
	// Reach the Stage-1 response state regardless of selected contexts (like
	// CHANNEL_TOPICS): the whole point is to shape shouldRespond on ambient
	// group turns.
	alwaysInResponseState: true,
	roleGate: { minRole: "GUEST" },

	get: async (runtime: IAgentRuntime, message: Memory, state: State) => {
		try {
			const channelType = await resolveChannelType(runtime, message);
			if (!isMultiPartyChannel(channelType)) {
				// "Just group chat": DMs and private channels stay inert.
				return { ...EMPTY_RESULT };
			}
			const window = await loadDialogueWindow(runtime, message, state);
			const metrics = computeGroupConversationMetrics(window, runtime.agentId);
			const addressed = humanDirectlyAddressesAgent(runtime, message);
			const calibration = DEFAULT_ANXIETY_CALIBRATION;
			const result = computeAnxietyPressure(metrics, addressed, calibration);
			if (result.pressure < calibration.noticeFloor) {
				return { ...EMPTY_RESULT };
			}
			const text = renderAnxietyText(metrics, result, calibration);
			return {
				text,
				values: {
					anxietyPressure: Number(result.pressure.toFixed(3)),
					anxietyAgentShare: Number(metrics.agentShare.toFixed(3)),
					anxietyPingPongRun: metrics.pingPongRun,
					anxietyParticipantCount: metrics.participantCount,
					anxietyDampedByAddress: result.dampedByAddress,
				},
				data: { metrics, pressure: result },
			};
		} catch {
			// Advisory signal only: any failure degrades to no guidance rather
			// than disturbing the turn.
			return { ...EMPTY_RESULT };
		}
	},
};
