/**
 * Non-mutating diagnostic projection for validated tool-call arguments. The
 * handler must receive the exact raw values, so redaction cannot happen where
 * arguments are produced; instead every boundary where arguments leave the
 * ephemeral execution path (planner queue/context/events, streaming and
 * observer payloads, action summaries, result/failure metadata, persisted
 * trajectories) projects them through this module before serialization.
 *
 * The projection composes runtime-known-secret redaction with the shared
 * tool-shape patterns from redact.ts (CLI --token forms, URI userinfo, token
 * prefixes), fully masks values under credential-named keys, preserves
 * non-string primitives so numeric/boolean diagnostics stay exact, and bounds
 * depth/cycles so a pathological argument graph cannot hang a diagnostic
 * writer. Unchanged subtrees are returned by reference (structural sharing);
 * callers must treat projected values as immutable.
 */

import {
	isSensitiveKeyName,
	type RedactSensitiveMode,
	redactSensitiveText,
} from "./redact";

/** Replacement emitted for masked keys, cycles, and over-deep subtrees. */
export const TOOL_DIAGNOSTIC_MASK = "[REDACTED]";

/**
 * Depth bound for the projection walk. Matches the log-sink redactor's bound
 * so a diagnostic surface never preserves structure a log line would refuse.
 */
const MAX_TOOL_DIAGNOSTIC_DEPTH = 8;

/** Scrubs one string for diagnostic output. */
export type ToolDiagnosticTextRedactor = (text: string) => string;

const TOOLS_MODE: { mode: RedactSensitiveMode } = { mode: "tools" };

/**
 * Composes runtime-known-secret redaction with shared tool-shape redaction —
 * the established order from the action-output work: literal character
 * secrets first, then pattern detection over whatever remains. Lightweight
 * and test runtimes may stub `redactSecrets` as identity, so the pattern pass
 * always runs.
 */
export function composeToolDiagnosticRedactor(runtime?: {
	redactSecrets?(text: string): string;
}): ToolDiagnosticTextRedactor {
	const redactSecrets = runtime?.redactSecrets?.bind(runtime);
	if (!redactSecrets) {
		return (text) => redactSensitiveText(text, TOOLS_MODE);
	}
	return (text) => redactSensitiveText(redactSecrets(text), TOOLS_MODE);
}

function projectValue(
	value: unknown,
	redactText: ToolDiagnosticTextRedactor,
	seen: WeakSet<object>,
	depth: number,
): unknown {
	if (typeof value === "string") {
		return redactText(value);
	}
	if (value === null || typeof value !== "object") {
		// Numbers, booleans, bigints, undefined, functions, symbols: preserved.
		// Non-serializable entries drop out at JSON.stringify time exactly as
		// they would have for the raw value, so the projection never changes
		// which fields a surface serializes — only what the strings contain.
		return value;
	}
	if (depth >= MAX_TOOL_DIAGNOSTIC_DEPTH || seen.has(value)) {
		return TOOL_DIAGNOSTIC_MASK;
	}
	seen.add(value);
	try {
		if (Array.isArray(value)) {
			let changed = false;
			const projected = value.map((item) => {
				const next = projectValue(item, redactText, seen, depth + 1);
				if (next !== item) {
					changed = true;
				}
				return next;
			});
			return changed ? projected : value;
		}
		if (value instanceof Error) {
			// Thrown values routinely interpolate the offending argument into
			// their message; preserve the Error shape but scrub message/stack.
			const projected = new Error(redactText(value.message));
			projected.name = value.name;
			projected.stack = value.stack ? redactText(value.stack) : undefined;
			return projected;
		}
		let changed = false;
		const projected: Record<string, unknown> = {};
		for (const [key, entry] of Object.entries(value)) {
			if (isSensitiveKeyName(key)) {
				projected[key] = TOOL_DIAGNOSTIC_MASK;
				changed = true;
				continue;
			}
			const next = projectValue(entry, redactText, seen, depth + 1);
			if (next !== entry) {
				changed = true;
			}
			projected[key] = next;
		}
		// A non-plain prototype (class instance) still projects to a plain
		// object: diagnostics serialize own enumerable state only.
		if (!changed && Object.getPrototypeOf(value) === Object.prototype) {
			return value;
		}
		return projected;
	} finally {
		// Re-entrant siblings may legitimately share a subtree; only a path
		// back through an ancestor is a cycle.
		seen.delete(value);
	}
}

/**
 * Projects one value for diagnostic egress. The input is never mutated; the
 * result is safe to embed in planner context, events, stream payloads,
 * summaries, and persisted trajectories. Strings are scrubbed with
 * `redactText`, values under credential-named keys are fully masked,
 * non-string primitives are preserved exactly, and cycles or nesting beyond
 * the depth bound collapse to {@link TOOL_DIAGNOSTIC_MASK}.
 */
export function projectToolDiagnosticValue(
	value: unknown,
	redactText: ToolDiagnosticTextRedactor,
): unknown {
	return projectValue(value, redactText, new WeakSet<object>(), 0);
}

/**
 * Projects a tool-call argument record for diagnostic egress. Returns the
 * same reference when nothing needed redaction so unchanged calls stay
 * identity-comparable across surfaces.
 */
export function projectToolDiagnosticArgs(
	args: Record<string, unknown> | undefined,
	redactText: ToolDiagnosticTextRedactor,
): Record<string, unknown> | undefined {
	if (args === undefined) {
		return undefined;
	}
	return projectToolDiagnosticValue(args, redactText) as Record<
		string,
		unknown
	>;
}
