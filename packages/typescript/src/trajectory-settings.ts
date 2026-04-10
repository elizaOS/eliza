/**
 * Trajectory capture settings — **orthogonal** to `PROMPT_OPTIMIZATION_ENABLED`.
 *
 * **Why a separate module:** Prompt optimization gates DPE traces, registry, and
 * auto-optimizer. Benchmarks and operators may need raw `useModel` / provider
 * logs without that pipeline, or may forbid writing full prompts to disk while
 * still optimizing. Centralizing bool parsing here keeps `TrajectoryLoggerService`
 * and plugin-neuro finalizer consistent.
 *
 * **Why `parseBool` is strict-ish:** Env and `getSetting` return inconsistent
 * types (`"true"`, `1`, `""`). We trim strings, accept numeric 0/1, and treat
 * **empty string as “unset”** so each flag falls back to its documented default
 * — avoiding accidental enable of PII-heavy JSONL on typos or blank env vars.
 */

function parseBool(value: unknown, whenUnset: boolean): boolean {
	if (value === undefined || value === null) return whenUnset;
	if (typeof value === "boolean") return value;
	if (typeof value === "number") {
		if (value === 1) return true;
		if (value === 0) return false;
		// **Why fall through:** non-binary numbers are ambiguous; use per-flag default.
		return whenUnset;
	}
	if (typeof value === "string") {
		const s = value.trim().toLowerCase();
		if (s === "") return whenUnset;
		if (s === "false" || s === "0" || s === "no" || s === "off") {
			return false;
		}
		if (s === "true" || s === "1" || s === "yes" || s === "on") return true;
		// **Why whenUnset on unknown strings:** e.g. `TRAJECTORY_HISTORY_JSONL=maybe`
		// should not silently turn on disk capture (opt-in flags default false).
	}
	return whenUnset;
}

/** When false, skip in-memory and disk trajectory logging entirely. Default true. */
export function isTrajectoryCaptureEnabled(
	getSetting: (key: string) => unknown,
): boolean {
	return parseBool(getSetting("TRAJECTORY_CAPTURE_ENABLED"), true);
}

/**
 * Append `llm_observation` / `provider_observation` lines to `history.jsonl`.
 * Default false (PII). Uses `OPTIMIZATION_DIR` like the optimizer.
 *
 * **Why default false:** Rows include full prompts and completions; operators must opt in.
 */
export function isTrajectoryHistoryJsonlEnabled(
	getSetting: (key: string) => unknown,
): boolean {
	return parseBool(getSetting("TRAJECTORY_HISTORY_JSONL"), false);
}

/**
 * Append `signal_context` after neuro enrichment (duplicate score snapshot).
 * Default false.
 *
 * **Why separate from history:** Enriched `ExecutionTrace` already carries
 * `scoreCard`; this row exists so tools that start from `llm_observation` can
 * join to final scores without re-reading the full trace document.
 */
export function isTrajectorySignalContextJsonlEnabled(
	getSetting: (key: string) => unknown,
): boolean {
	return parseBool(getSetting("TRAJECTORY_SIGNAL_CONTEXT_JSONL"), false);
}
