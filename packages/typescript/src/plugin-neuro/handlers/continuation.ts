/**
 * Continuation / correction tracking for plugin-neuro.
 *
 * WHY track continuation: a user who keeps talking after an agent response
 * is an implicit positive signal — the response was useful enough to continue.
 * A user who corrects the agent ("that's wrong", "I meant...") is a strong
 * negative signal. These are cheap, universal proxies for response quality
 * that don't require explicit feedback UI.
 *
 * WHY attach to CURRENT run, not previous: by the time the next message
 * arrives, the previous run's traces have been finalized (written to disk)
 * and deleted from activeTraces. We can't enrich them anymore. Instead,
 * we attach the signal to the current run — "the user continued after your
 * predecessor's response" is still meaningful training data.
 *
 * WHY per agent+room keying: in multi-agent rooms, we need to know which
 * agent the user is responding to. The agent who spoke last in that room
 * is the one whose quality we're measuring.
 */

import type { IAgentRuntime } from "../../types/runtime.ts";
import { CONTINUATION_WINDOW_MS, NEURO_SOURCE, SIGNALS } from "../signals.ts";

/** Per agent+room tracking: when did the agent last respond */
const lastAgentResponseByKey = new Map<
	string,
	{ at: number; responseLength: number }
>();

/** Register an agent response for continuation tracking */
export function trackAgentResponse(
	roomId: string,
	_runId: string,
	responseLength: number,
	agentId?: string,
): void {
	const key = agentId ? `${agentId}:${roomId}` : roomId;
	lastAgentResponseByKey.set(key, {
		at: Date.now(),
		responseLength,
	});

	// Auto-cleanup after 2x continuation window
	setTimeout(() => {
		const entry = lastAgentResponseByKey.get(key);
		if (entry && Date.now() - entry.at > CONTINUATION_WINDOW_MS * 2) {
			lastAgentResponseByKey.delete(key);
		}
	}, CONTINUATION_WINDOW_MS * 2);
}

/** Patterns that indicate a user is correcting the agent */
const CORRECTION_PATTERNS = [
	/\b(that'?s?\s+wrong|incorrect|not right|no,?\s+actually|you'?re?\s+wrong)\b/i,
	/\b(i said|i meant|i was asking|my question was)\b/i,
	/\b(please\s+re-?do|try again|redo this|start over)\b/i,
	/^(no[!,.]?\s*)/i,
];

function detectCorrection(text: string): boolean {
	return CORRECTION_PATTERNS.some((p) => p.test(text));
}

/**
 * Called by the evaluator during the CURRENT run. Checks if the incoming
 * user message represents a continuation or correction of the agent's
 * previous response, and attaches the signal to the current run's trace.
 */
export function enrichContinuationSignals(
	runtime: IAgentRuntime,
	runId: string,
	roomId: string,
	userMessageText: string,
): void {
	const key = `${runtime.agentId}:${roomId}`;
	const lastResponse = lastAgentResponseByKey.get(key);
	if (!lastResponse) return;

	const timeSinceResponse = Date.now() - lastResponse.at;
	if (timeSinceResponse > CONTINUATION_WINDOW_MS) return;

	// User continued the conversation within the window — positive signal
	runtime.enrichTrace(runId, {
		source: NEURO_SOURCE,
		kind: SIGNALS.CONVERSATION_CONTINUED,
		value: 1.0,
		reason: `User messaged again within ${CONTINUATION_WINDOW_MS}ms of last agent reply`,
		metadata: {
			timeSinceResponseMs: timeSinceResponse,
			roomId,
		},
	});

	// Check for correction
	if (userMessageText && detectCorrection(userMessageText)) {
		runtime.enrichTrace(runId, {
			source: NEURO_SOURCE,
			kind: SIGNALS.USER_CORRECTION,
			value: 0.0,
			reason: "Heuristic detected correction phrasing in follow-up user message",
			metadata: {
				detectedIn: userMessageText.slice(0, 100),
				roomId,
			},
		});
	} else if (userMessageText) {
		runtime.enrichTrace(runId, {
			source: NEURO_SOURCE,
			kind: SIGNALS.USER_CORRECTION,
			value: 1.0,
			reason: "No correction phrasing detected in follow-up user message",
			metadata: { roomId },
		});
	}

	// Remove from tracking — consumed this window
	lastAgentResponseByKey.delete(key);
}
