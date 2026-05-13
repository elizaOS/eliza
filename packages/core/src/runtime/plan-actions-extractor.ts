/**
 * Strict extractor for PLAN_ACTIONS calls emitted as content text.
 *
 * Weak planner LLMs (Cerebras llama3.1-8b, gpt-oss-120b, etc.) are shown
 * `PLAN_ACTIONS({...})` in their system prompt as an example and sometimes
 * echo the call shape verbatim as message-content text rather than invoking
 * the function. This module detects that pattern strictly and returns the
 * parsed inner payload so callers can treat it as a synthesized tool call.
 *
 * Conservative by design:
 *   - Single well-formed block only. Multiple blocks → reject.
 *   - No surrounding prose in strict mode. "Here's how: PLAN_ACTIONS({...})" → reject.
 *   - Malformed JSON → reject.
 *   - Missing `action` field → reject.
 *   - Ambiguity always falls through to the caller; the extractor never guesses.
 */

/** Shape returned when the extractor fires. */
export interface ExtractedPlanAction {
	/** Raw action name as emitted by the model — caller is responsible for resolving. */
	action: string;
	/**
	 * Parameters object. Canonical schema uses `parameters`; many models emit
	 * `params`. Both are normalized here — caller receives the resolved object.
	 */
	parameters: Record<string, unknown>;
	thought?: string;
	/** Which pattern matched — useful for telemetry. */
	recoverySource: "plan-actions-wrapper" | "bare-action-object";
}

export interface ExtractOptions {
	/**
	 * When false, prose may surround the block. Default true (strict).
	 * Only set false for testing; production callers should use strict mode.
	 */
	strict?: boolean;
}

/**
 * Attempt to extract a single PLAN_ACTIONS invocation from raw model text.
 *
 * Handles:
 *   - `PLAN_ACTIONS({...})` — with optional markdown code-fence wrapping
 *   - Bare `{"action": "...", "parameters": {...}}` / `{"action": "...", "params": {...}}`
 *
 * Returns null on any ambiguity.
 */
export function extractPlanActionsFromContent(
	text: string,
	options: ExtractOptions = {},
): ExtractedPlanAction | null {
	const strict = options.strict !== false;
	const trimmed = text.trim();
	if (!trimmed) return null;

	// Unwrap a single markdown code fence if present.
	const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
	const candidate = fenced ? fenced[1].trim() : trimmed;

	// --- Pattern 1: PLAN_ACTIONS(<JSON>) wrapper ---
	const wrapperResult = tryExtractFromWrapper(candidate, strict);
	if (wrapperResult) return wrapperResult;

	// --- Pattern 2: bare JSON object with action + parameters/params ---
	const bareResult = tryExtractFromBareObject(candidate, strict);
	if (bareResult) return bareResult;

	return null;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function tryExtractFromWrapper(
	text: string,
	strict: boolean,
): ExtractedPlanAction | null {
	// Count occurrences of PLAN_ACTIONS( to reject multiple blocks early.
	const wrapperMatches = countOccurrences(text, "PLAN_ACTIONS(");
	if (wrapperMatches > 1) return null;
	if (wrapperMatches === 0) return null;

	const idx = text.indexOf("PLAN_ACTIONS(");
	const before = text.slice(0, idx).trim();
	const afterStart = idx + "PLAN_ACTIONS(".length;

	// In strict mode, nothing may precede the wrapper except whitespace.
	if (strict && before.length > 0) return null;

	// Walk forward to find the matching closing paren of PLAN_ACTIONS(...).
	// The body is a JSON object so we need the outermost `{}` to be balanced
	// first, then the `)` follows immediately.
	const body = extractJsonObject(text, afterStart);
	if (!body) return null;

	const afterBody = text.slice(body.end).trim();
	// Expect the closing `)` immediately after the object.
	if (!afterBody.startsWith(")")) return null;
	const afterParen = afterBody.slice(1).trim();

	// In strict mode, nothing may follow the closing paren.
	if (strict && afterParen.length > 0) return null;

	let parsed: Record<string, unknown>;
	try {
		parsed = JSON.parse(sanitizeJsonText(body.text));
	} catch {
		return null;
	}

	return buildResult(parsed, "plan-actions-wrapper");
}

function tryExtractFromBareObject(
	text: string,
	strict: boolean,
): ExtractedPlanAction | null {
	// Count `{` at depth-0 — multiple top-level objects → reject.
	const objectCount = countTopLevelObjects(text);
	if (objectCount !== 1) return null;

	const before = text.slice(0, text.indexOf("{")).trim();
	if (strict && before.length > 0) return null;

	const body = extractJsonObject(text, text.indexOf("{"));
	if (!body) return null;

	const after = text.slice(body.end).trim();
	if (strict && after.length > 0) return null;

	let parsed: Record<string, unknown>;
	try {
		parsed = JSON.parse(sanitizeJsonText(body.text));
	} catch {
		return null;
	}

	// Bare object must look like an action call: has `action` but NOT
	// a `shouldRespond` / `replyText` / `contexts` field (which would indicate
	// it's a HANDLE_RESPONSE envelope, already handled upstream).
	if (
		"shouldRespond" in parsed ||
		"replyText" in parsed ||
		"contexts" in parsed
	) {
		return null;
	}

	return buildResult(parsed, "bare-action-object");
}

/**
 * Fix common non-standard JSON escape sequences that LLMs emit.
 *
 * Models trained on code sometimes produce `\'` (a valid escape in many
 * languages but NOT in JSON — the only legal single-quote form is the
 * literal character). We also strip `\`` and neutralize `'` round-trips.
 * This runs only on the extracted body text, not the full response, so the
 * risk of mangling valid content is low.
 */
function sanitizeJsonText(text: string): string {
	return (
		text
			// \' → '   (invalid JSON escape for single-quote)
			.replace(/\\'/g, "'")
			// \` → `   (backtick escape, invalid in JSON)
			.replace(/\\`/g, "`")
	);
}

function buildResult(
	parsed: Record<string, unknown>,
	source: ExtractedPlanAction["recoverySource"],
): ExtractedPlanAction | null {
	const action =
		typeof parsed.action === "string" ? parsed.action.trim() : null;
	if (!action) return null;

	// Normalize both `parameters` (canonical) and `params` (common drift).
	const params =
		(parsed.parameters as Record<string, unknown> | null | undefined) ??
		(parsed.params as Record<string, unknown> | null | undefined);
	const parameters =
		params && typeof params === "object" && !Array.isArray(params)
			? (params as Record<string, unknown>)
			: {};

	const thought =
		typeof parsed.thought === "string" ? parsed.thought : undefined;

	return { action, parameters, thought, recoverySource: source };
}

// ---------------------------------------------------------------------------
// Bracket-walking utilities (no regex for nested JSON)
// ---------------------------------------------------------------------------

interface ExtractedSpan {
	text: string;
	/** Index past the closing `}` in the original string. */
	end: number;
}

function extractJsonObject(
	raw: string,
	startSearch: number,
): ExtractedSpan | null {
	const start = raw.indexOf("{", startSearch);
	if (start < 0) return null;

	let depth = 0;
	let inString = false;
	let escaped = false;

	for (let i = start; i < raw.length; i++) {
		const ch = raw[i];
		if (inString) {
			if (escaped) {
				escaped = false;
			} else if (ch === "\\") {
				escaped = true;
			} else if (ch === '"') {
				inString = false;
			}
			continue;
		}
		if (ch === '"') {
			inString = true;
			continue;
		}
		if (ch === "{") {
			depth++;
			continue;
		}
		if (ch === "}") {
			depth--;
			if (depth === 0) {
				const slice = raw.slice(start, i + 1);
				return { text: slice, end: i + 1 };
			}
		}
	}
	return null;
}

function countOccurrences(text: string, needle: string): number {
	let count = 0;
	let pos = 0;
	for (
		let matchIndex = text.indexOf(needle, pos);
		matchIndex !== -1;
		matchIndex = text.indexOf(needle, pos)
	) {
		count++;
		pos = matchIndex + needle.length;
	}
	return count;
}

/**
 * Count distinct top-level JSON objects (depth-0 `{...}` spans) in `text`.
 * Used to reject multi-object responses.
 */
function countTopLevelObjects(text: string): number {
	let count = 0;
	let depth = 0;
	let inString = false;
	let escaped = false;

	for (const ch of text) {
		if (inString) {
			if (escaped) {
				escaped = false;
			} else if (ch === "\\") {
				escaped = true;
			} else if (ch === '"') {
				inString = false;
			}
			continue;
		}
		if (ch === '"') {
			inString = true;
			continue;
		}
		if (ch === "{") {
			if (depth === 0) count++;
			depth++;
			continue;
		}
		if (ch === "}") {
			depth--;
		}
	}
	return count;
}
