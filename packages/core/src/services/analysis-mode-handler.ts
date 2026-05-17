/**
 * Analysis-mode activation hook for the core message handler.
 *
 * When a user types the bare token `analysis` (or `as you were` to disable),
 * this module toggles a per-room debug flag and short-circuits the rest of
 * the planner pipeline so the agent never hallucinates a "performing an
 * analysis" reply. The token grammar mirrors the agent-side scaffold at
 * `packages/agent/src/runtime/analysis-mode-flag.ts`. We intentionally
 * re-implement the regex + env-gate locally instead of importing from
 * `@elizaos/agent`: `core` is upstream of `agent` and cannot depend on it.
 * The two layers stay in lock-step by sharing the exact same token grammar
 * and env-gate semantics — both are tiny and stable.
 *
 * Privacy:
 *   - `isAnalysisModeAllowed()` returns false unless the operator opted in
 *     via `ELIZA_ENABLE_ANALYSIS_MODE=1`, or `NODE_ENV=development`.
 *   - When disabled, activation tokens are ignored (no toggle, no
 *     confirmation) so the words flow through to the planner like any
 *     other text.
 *
 * Sidecar attachment (the four debug payloads — thinking, planned actions,
 * simple-mode flag, evaluator output) is implemented as `appendAnalysisSidecar`
 * but is only invoked from the activation-confirmation path in this wave.
 * Wiring it at the response-emit site is intentionally PUNT until the
 * SSE event type and UI sidecar component exist; surfacing it via the
 * activation echo would silently teach users a payload format we may
 * still revise.
 */

const ANALYSIS_TOKEN = /^\s*analysis\s*$/i;
const AS_YOU_WERE_TOKEN = /^\s*as\s+you\s+were\s*$/i;

export type AnalysisToken = "enable" | "disable" | null;

/**
 * Detect activation tokens. Mirror of
 * `packages/agent/src/runtime/analysis-mode-flag.ts#parseAnalysisToken`.
 */
export function parseAnalysisToken(
	text: string | undefined | null,
): AnalysisToken {
	if (typeof text !== "string") return null;
	if (ANALYSIS_TOKEN.test(text)) return "enable";
	if (AS_YOU_WERE_TOKEN.test(text)) return "disable";
	return null;
}

/**
 * Gate analysis-mode activation. Mirror of
 * `packages/agent/src/runtime/analysis-mode-flag.ts#isAnalysisModeAllowed`.
 */
export function isAnalysisModeAllowed(
	env: NodeJS.ProcessEnv = process.env,
): boolean {
	if (env.ELIZA_ENABLE_ANALYSIS_MODE === "1") return true;
	if (env.ELIZA_ENABLE_ANALYSIS_MODE === "0") return false;
	return env.NODE_ENV === "development";
}

interface FlagState {
	enabled: boolean;
	enabledAt: number;
}

/**
 * Module-private per-room flag store. Process-local. Restarts clear the
 * flag — analysis mode is a transient debug toggle, not a persisted
 * preference.
 */
const flagStore = new Map<string, FlagState>();

export function isAnalysisModeEnabledForRoom(roomId: string): boolean {
	return flagStore.get(roomId)?.enabled === true;
}

/** Test helper. */
export function __resetAnalysisModeFlagsForTests(): void {
	flagStore.clear();
}

export interface AnalysisActivationResult {
	/** True when the message was an activation/deactivation token and was handled. */
	handled: boolean;
	/** Confirmation text to emit back to the user. Only set when `handled === true`. */
	responseText?: string;
	/** New per-room flag state after applying the token. */
	enabledAfter?: boolean;
}

interface ActivationInput {
	text: string | undefined | null;
	roomId: string;
}

/**
 * Inspect an inbound message for an analysis-mode activation token. When
 * detected (and the env gate allows it), toggle the per-room flag and
 * return a confirmation response so the caller can short-circuit before
 * the planner runs.
 *
 * Returns `{ handled: false }` when:
 *   - the env gate is closed, OR
 *   - the message text is not exactly an activation/deactivation token.
 *
 * The caller (message handler) MUST treat `handled: true` as terminal —
 * do not invoke the planner or emit any other reply.
 */
export function maybeHandleAnalysisActivation(
	input: ActivationInput,
	env: NodeJS.ProcessEnv = process.env,
): AnalysisActivationResult {
	if (!isAnalysisModeAllowed(env)) {
		return { handled: false };
	}

	const token = parseAnalysisToken(input.text);
	if (token === null) {
		return { handled: false };
	}

	const roomId = input.roomId;
	if (token === "enable") {
		flagStore.set(roomId, { enabled: true, enabledAt: Date.now() });
		return {
			handled: true,
			responseText: "Analysis mode on.",
			enabledAfter: true,
		};
	}

	flagStore.delete(roomId);
	return {
		handled: true,
		responseText: "Analysis mode off.",
		enabledAfter: false,
	};
}

export interface AnalysisSidecarPayload {
	thoughtPreview?: string;
	plannedActions?: readonly string[];
	simpleMode?: boolean;
	evaluatorOutputs?: readonly string[];
}

/**
 * Append a debug sidecar to the user-facing text. Only called when the
 * per-room flag is enabled. The delimiter format is intentionally
 * deterministic so a future UI sidecar component can split on it.
 *
 * The full SSE event + UI sidecar wiring is PUNT — this helper is
 * exported for unit testing the format only.
 */
export function appendAnalysisSidecar(
	text: string,
	payload: AnalysisSidecarPayload,
): string {
	const lines: string[] = [];
	if (typeof payload.thoughtPreview === "string") {
		lines.push(`thought: ${payload.thoughtPreview}`);
	}
	if (Array.isArray(payload.plannedActions)) {
		lines.push(`actions: ${payload.plannedActions.join(", ")}`);
	}
	if (typeof payload.simpleMode === "boolean") {
		lines.push(`simpleMode: ${payload.simpleMode}`);
	}
	if (Array.isArray(payload.evaluatorOutputs)) {
		lines.push(`evaluators: ${payload.evaluatorOutputs.join(", ")}`);
	}
	if (lines.length === 0) {
		return text;
	}
	return `${text}\n\n---\nANALYSIS:\n${lines.join("\n")}`;
}
