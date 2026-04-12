/**
 * neuroEvaluator — produces quality signals after each agent response.
 *
 * WHY an evaluator, not an event handler: evaluators are awaited by the
 * message service, guaranteeing they complete before RUN_ENDED fires.
 * Event handlers run asynchronously with no ordering guarantees, which
 * caused race conditions in earlier designs where traces were deleted
 * before signals could be attached.
 *
 * WHY the evaluator receives the user message directly: previous designs
 * used getMemoryById inside an event handler, but RUN_STARTED fires before
 * the user message is persisted to memory, causing a lookup miss. The
 * evaluator receives `message` as a parameter, sidestepping this entirely.
 *
 * CRITICAL ORDERING: enrichContinuationSignals MUST run before
 * trackAgentResponse. Continuation reads the PREVIOUS turn's data from
 * lastAgentResponseByKey. trackAgentResponse overwrites it with the
 * CURRENT turn. Swapping them means continuation always reads current-turn
 * data, producing meaningless signals. This was the most-fixed bug in
 * the system (fixed Round 5, reverted, re-fixed Round 6).
 */

import {
	logger,
	type EvaluationExample,
	type Evaluator,
	type IAgentRuntime,
	type Memory,
} from "@elizaos/core";
import {
	enrichContinuationSignals,
	trackAgentResponse,
} from "./handlers/continuation.ts";
import { NEURO_SOURCE, ROLLING_WINDOW_SIZE, SIGNALS } from "./signals.ts";

/** Per-agent rolling statistics for normalization */
interface RollingStats {
	latencies: number[];
	lengths: number[];
	lastAccessed: number;
}
const perAgentStats = new Map<string, RollingStats>();

/** Maximum number of agent stats entries before LRU eviction. */
const MAX_AGENT_STATS_ENTRIES = 100;

function getAgentStats(agentId: string): RollingStats {
	let stats = perAgentStats.get(agentId);
	const now = Date.now();
	if (!stats) {
		// Evict least-recently-used entries if at capacity
		if (perAgentStats.size >= MAX_AGENT_STATS_ENTRIES) {
			let oldestKey: string | null = null;
			let oldestTime = Infinity;
			for (const [key, entry] of perAgentStats) {
				if (entry.lastAccessed < oldestTime) {
					oldestTime = entry.lastAccessed;
					oldestKey = key;
				}
			}
			if (oldestKey) {
				perAgentStats.delete(oldestKey);
			}
		}
		stats = { latencies: [], lengths: [], lastAccessed: now };
		perAgentStats.set(agentId, stats);
	} else {
		stats.lastAccessed = now;
	}
	return stats;
}

function pushRolling(arr: number[], value: number): void {
	arr.push(value);
	if (arr.length > ROLLING_WINDOW_SIZE) arr.shift();
}

function median(arr: number[]): number {
	if (arr.length === 0) return 0;
	const sorted = [...arr].sort((a, b) => a - b);
	const mid = Math.floor(sorted.length / 2);
	return sorted.length % 2 === 0
		? (sorted[mid - 1] + sorted[mid]) / 2
		: sorted[mid];
}

export const neuroEvaluator: Evaluator = {
	name: "NEURO_QUALITY",
	description:
		"Tracks user-facing quality signals (latency, length, corrections) for prompt optimization.",
	similes: ["prompt-quality", "response-quality"],
	alwaysRun: false,
	examples: [] as EvaluationExample[],

	validate: async (
		runtime: IAgentRuntime,
		message: Memory,
	): Promise<boolean> => {
		// Only run when the incoming message is from a non-agent entity (i.e. a user message)
		// so that we can evaluate the agent's response(s) from the responses[] array.
		return message.entityId !== runtime.agentId;
	},

	handler: async (
		runtime: IAgentRuntime,
		message: Memory,
		_state: unknown,
		_options: unknown,
		_callback: unknown,
		responses?: Memory[],
	): Promise<undefined> => {
		if (!responses || responses.length === 0) return undefined;

		const agentResponse = responses[0];
		if (!agentResponse) return undefined;

		const runId = runtime.getCurrentRunId?.() as string | undefined;
		if (!runId) return undefined;

		const text =
			typeof agentResponse.content === "string"
				? agentResponse.content
				: String(
						(agentResponse.content as Record<string, unknown>)?.text ?? "",
					);

		const responseLength = text.length;

		const roomId = agentResponse.roomId;

		// --- Continuation / correction from the incoming user message ---
		// Must run BEFORE trackAgentResponse so the map still holds the
		// PREVIOUS turn's entry (not the one we're about to overwrite).
		if (roomId && message?.content) {
			const userText =
				typeof message.content === "string"
					? message.content
					: String((message.content as Record<string, unknown>)?.text ?? "");
			if (userText) {
				enrichContinuationSignals(runtime, runId, roomId, userText);
			}
		}

		// Record the current agent response for the NEXT message's continuation check
		if (roomId) {
			trackAgentResponse(roomId, runId, responseLength, runtime.agentId);
		}

		const stats = getAgentStats(runtime.agentId);

		// --- Length appropriateness ---
		// Compute median BEFORE pushing current value to avoid self-referential scoring
		const medianLen = median(stats.lengths);
		pushRolling(stats.lengths, responseLength);
		const lengthRatio = medianLen > 0 ? responseLength / medianLen : 1.0;
		const lengthScore = Math.max(
			0,
			1.0 - Math.abs(Math.log2(lengthRatio)) * 0.3,
		);

		const lengthSignal = {
			source: NEURO_SOURCE,
			kind: SIGNALS.LENGTH_APPROPRIATENESS,
			value: Math.min(1.0, Math.max(0.0, lengthScore)),
			reason: `Reply length ${responseLength} vs rolling median ${medianLen.toFixed(0)} (ratio ${lengthRatio.toFixed(2)})`,
			metadata: {
				responseLength,
				medianLength: medianLen,
				ratio: lengthRatio,
			},
		};

		// Get all active traces for per-trace signal attachment
		const activeTraces = runtime.getActiveTracesForRun?.(runId) ?? [];
		const singleTrace =
			activeTraces.length > 0 ? undefined : runtime.getActiveTrace(runId);
		const allTraces =
			activeTraces.length > 0 ? activeTraces : singleTrace ? [singleTrace] : [];

		if (allTraces.length > 0) {
			// WHY last trace only: in a multi-DPE run (should-respond + reply), the
			// last trace corresponds to the actual response. Length quality is only
			// meaningful for the user-facing reply, not internal decision traces.
			const replyTrace = allTraces[allTraces.length - 1];
			replyTrace.scoreCard.signals.push(lengthSignal);
			replyTrace.enrichedAt = Date.now();
		} else {
			// No per-trace access — fall back to broadcast
			runtime.enrichTrace(runId, lengthSignal);
		}

		// WHY per-trace latency: unlike length (which is a property of the final
		// response), latency is meaningful per-DPE-call. A slow should-respond
		// check matters independently of a slow reply generation.
		// Compute median BEFORE the loop and any pushRolling calls to avoid
		// cross-contamination between traces in the same run.
		const medianLatency = median(stats.latencies);
		// Collect all latencies first, then push after loop to prevent mid-loop pollution
		const latenciesToPush: number[] = [];
		for (const trace of allTraces) {
			const latencyMs = trace.latencyMs;
			if (typeof latencyMs !== "number" || latencyMs <= 0) continue;

			latenciesToPush.push(latencyMs);
			// Use only the pre-loop median for scoring; fallback to 0.5 if no history
			const latencyScore =
				medianLatency > 0
					? Math.min(1.0, medianLatency / Math.max(latencyMs, medianLatency))
					: 0.5;

			trace.scoreCard.signals.push({
				source: NEURO_SOURCE,
				kind: SIGNALS.RESPONSE_LATENCY,
				value: latencyScore,
				reason: `DPE latency ${latencyMs}ms vs rolling median ${medianLatency.toFixed(0)}ms`,
				metadata: {
					latencyMs,
					medianLatencyMs: medianLatency,
				},
			});
			trace.enrichedAt = Date.now();
		}
		// Push all latencies after the loop to prevent cross-contamination
		for (const lat of latenciesToPush) {
			pushRolling(stats.latencies, lat);
		}

		logger.debug(
			{
				src: "plugin-neuro",
				runId,
				traceCount: allTraces.length,
				roomId,
			},
			"neuroEvaluator: attached length/latency signals",
		);

		return undefined;
	},
};
