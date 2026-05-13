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
	recoverySource:
		| "plan-actions-wrapper"
		| "bare-action-object"
		| "openai-function-call";
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
 *   - OpenAI function-call shape `{"name": "PLAN_ACTIONS", "arguments": <obj|string>}`
 *     — weak planners (Cerebras llama3.1-8b especially) frequently echo this
 *     serialized form as content text instead of issuing a real tool call.
 *     The recognizer also accepts the OpenAI assistant-message wrapper
 *     `{"function": {"name": ..., "arguments": ...}}` for completeness.
 *   - Reasoning-block prefix (`<think>...</think>`) is stripped before matching,
 *     so reasoning-style models (Qwen3, DeepSeek-R1, gpt-oss thinking) that emit
 *     `<think>plan</think>\nPLAN_ACTIONS({...})` are recovered identically to
 *     non-reasoning models.
 *
 * Returns null on any ambiguity.
 */
export function extractPlanActionsFromContent(
	text: string,
	options: ExtractOptions = {},
): ExtractedPlanAction | null {
	const strict = options.strict !== false;
	const trimmed = stripReasoningPrefix(text.trim());
	if (!trimmed) return null;

	// Unwrap a single markdown code fence if present.
	const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
	const candidate = fenced ? fenced[1].trim() : trimmed;

	// --- Pattern 1: PLAN_ACTIONS(<JSON>) wrapper ---
	const wrapperResult = tryExtractFromWrapper(candidate, strict);
	if (wrapperResult) return wrapperResult;

	// --- Pattern 3: OpenAI function-call shape `{"name": "...", "arguments": ...}` ---
	// Tried before the bare-object pattern because a function-call object also
	// looks like a single top-level JSON object — without this check, the
	// bare-object pattern would reject it (no top-level `action` key) and we'd
	// fall through. With it, models that echo the OpenAI tool-call envelope
	// are recovered.
	const functionCallResult = tryExtractFromFunctionCallShape(candidate, strict);
	if (functionCallResult) return functionCallResult;

	// --- Pattern 2: bare JSON object with action + parameters/params ---
	const bareResult = tryExtractFromBareObject(candidate, strict);
	if (bareResult) return bareResult;

	return null;
}

/**
 * Strip reasoning blocks (`<think>...</think>`, optionally with attributes) and
 * stray `no_think` / `/no_think` markers so that reasoning-style models can be
 * recovered without their internal monologue counting as "prose surrounding the
 * call" in strict mode. Mirrors `stripReasoningBlocks` in
 * packages/core/src/services/message.ts but kept local so this module has no
 * cross-file dependency.
 */
function stripReasoningPrefix(raw: string): string {
	return raw
		.replace(/<think\b[^>]*>[\s\S]*?<\/think>/gi, "")
		.replace(/^[\s\S]*?<\/think>/i, "")
		.replace(/<think\b[^>]*>[\s\S]*$/gi, "")
		.replace(/\/?\bno_think\b/gi, "")
		.trim();
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
		parsed = JSON.parse(body.text);
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
		parsed = JSON.parse(body.text);
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
 * Recognize the OpenAI function-call envelope when echoed as content text:
 *   {"name": "PLAN_ACTIONS", "arguments": {"action": "...", "parameters": {...}}}
 *   {"name": "PLAN_ACTIONS", "arguments": "<stringified JSON>"}
 *   {"function": {"name": "PLAN_ACTIONS", "arguments": ...}}
 *
 * Cerebras llama3.1-8b emits this in ~80% of trials when it intends to call
 * PLAN_ACTIONS but doesn't use the tool API.
 *
 * Only fires when `name === "PLAN_ACTIONS"`; other tool names fall through
 * so the caller (or the bare-action-object path) can decide. HANDLE_RESPONSE
 * envelopes (Stage 1) are deliberately not handled here — they're parsed by a
 * different path upstream.
 */
function tryExtractFromFunctionCallShape(
	text: string,
	strict: boolean,
): ExtractedPlanAction | null {
	const objectCount = countTopLevelObjects(text);
	if (objectCount !== 1) return null;

	const startIdx = text.indexOf("{");
	if (startIdx < 0) return null;

	const before = text.slice(0, startIdx).trim();
	if (strict && before.length > 0) return null;

	const body = extractJsonObject(text, startIdx);
	if (!body) return null;

	const after = text.slice(body.end).trim();
	if (strict && after.length > 0) return null;

	let parsed: Record<string, unknown>;
	try {
		parsed = JSON.parse(body.text);
	} catch {
		return null;
	}

	// Two shapes accepted:
	//   { name, arguments }
	//   { function: { name, arguments } }
	const envelope =
		parsed.function && typeof parsed.function === "object"
			? (parsed.function as Record<string, unknown>)
			: parsed;

	const name = typeof envelope.name === "string" ? envelope.name.trim() : "";
	if (name !== "PLAN_ACTIONS") return null;

	const rawArgs = envelope.arguments;
	let argsObj: Record<string, unknown> | null = null;
	if (rawArgs && typeof rawArgs === "object" && !Array.isArray(rawArgs)) {
		argsObj = rawArgs as Record<string, unknown>;
	} else if (typeof rawArgs === "string") {
		try {
			const decoded: unknown = JSON.parse(rawArgs);
			if (decoded && typeof decoded === "object" && !Array.isArray(decoded)) {
				argsObj = decoded as Record<string, unknown>;
			}
		} catch {
			return null;
		}
	}
	if (!argsObj) return null;

	return buildResult(argsObj, "openai-function-call");
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
