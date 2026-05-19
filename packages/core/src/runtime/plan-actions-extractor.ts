/**
 * Tolerant `PLAN_ACTIONS`-in-text extractor.
 *
 * Background: the v5 planner asks models to emit a native tool call with the
 * envelope `{action, parameters, thought}` (see `buildPlannerActionGrammar` in
 * `response-grammar.ts`). Cloud cloud-hosted open-weights models — most
 * notably Cerebras-hosted `gpt-oss-120b` and `qwen-3-235b-a22b-instruct-2507`
 * — sometimes emit the SAME envelope as message-content text instead of as a
 * native tool call. The dispatcher then drops the turn because
 * `raw.toolCalls` is empty. See elizaOS/eliza#7620 and the feature request
 * linked from that issue.
 *
 * This module is the second-pass parser. The planner-loop calls it when
 * `parsePlannerOutput` returns zero tool calls but `raw.text` carries one of
 * the supported shapes:
 *
 *   1. Bare action object — `{"action":"NAME","parameters":{...},"thought":"..."}`
 *      with optional fencing / surrounding prose. This is the shape the local
 *      engine's GBNF produces and the shape `buildPlannerActionGrammar`
 *      encodes — when a hosted provider streams it as text, the bytes are
 *      identical.
 *
 *   2. Envelope call shape — `PLAN_ACTIONS({...})` literally written as text,
 *      which the character prompt happens to use as a worked example and
 *      which `gpt-oss-120b` mimics. The inner `{...}` is the same bare
 *      action object as (1).
 *
 * The extractor is intentionally conservative. It refuses ambiguous shapes
 * (HANDLE_RESPONSE envelopes with `shouldRespond`, `replyText`, `contexts`,
 * etc. — which would mis-fire on Stage-1 outputs that accidentally reach the
 * Stage-2 path). It does NOT validate `action` against any registry — the
 * planner-loop's downstream resolver does that.
 */

import { parseJsonObject } from "./json-output";

/**
 * Where in the wire output the extractor recovered a plan action. Used by
 * tests + trajectory logs to distinguish a native tool call (no recovery
 * needed) from a text-recovered call (which we record because it's
 * model-bias evidence).
 */
export type PlanActionRecoverySource =
	| "bare-action-object"
	| "plan-actions-envelope";

export interface ExtractedPlanAction {
	action: string;
	parameters: Record<string, unknown>;
	thought?: string;
	recoverySource: PlanActionRecoverySource;
}

/**
 * Fields that, when present, indicate the JSON object is a Stage-1
 * HANDLE_RESPONSE envelope rather than a Stage-2 plan-action envelope. We
 * refuse to recover those — letting them through would cause the planner to
 * dispatch random action names sampled from `candidateActionNames`.
 */
const STAGE_1_DISCRIMINATORS = new Set([
	"shouldRespond",
	"replyText",
	"contexts",
	"candidateActionNames",
	"candidateActions",
	"parentActionHints",
]);

function looksLikeStage1Envelope(record: Record<string, unknown>): boolean {
	for (const key of Object.keys(record)) {
		if (STAGE_1_DISCRIMINATORS.has(key)) {
			return true;
		}
	}
	return false;
}

function normalizeParameters(value: unknown): Record<string, unknown> {
	if (value && typeof value === "object" && !Array.isArray(value)) {
		return value as Record<string, unknown>;
	}
	return {};
}

function buildExtracted(
	record: Record<string, unknown>,
	recoverySource: PlanActionRecoverySource,
): ExtractedPlanAction | null {
	const actionRaw = record.action;
	if (typeof actionRaw !== "string") {
		return null;
	}
	const action = actionRaw.trim();
	if (!action) {
		return null;
	}
	if (looksLikeStage1Envelope(record)) {
		return null;
	}
	const parameters = normalizeParameters(record.parameters);
	const thoughtRaw = record.thought;
	const thought = typeof thoughtRaw === "string" ? thoughtRaw : undefined;
	const result: ExtractedPlanAction = {
		action,
		parameters,
		recoverySource,
	};
	if (thought !== undefined) {
		result.thought = thought;
	}
	return result;
}

/**
 * Match a `PLAN_ACTIONS(<json object>)` envelope anywhere in the text. We
 * capture the inner JSON via brace-balancing rather than a single regex
 * because the parameters object is free-form JSON that may itself contain
 * `{`, `}`, quoted braces, etc.
 */
function extractEnvelopeBody(raw: string): string | null {
	const match = raw.match(/PLAN_ACTIONS\s*\(\s*/);
	if (!match || match.index === undefined) return null;
	const start = match.index + match[0].length;
	if (raw[start] !== "{") return null;

	let depth = 0;
	let inString = false;
	let escaped = false;
	for (let index = start; index < raw.length; index++) {
		const char = raw[index];
		if (inString) {
			if (escaped) {
				escaped = false;
			} else if (char === "\\") {
				escaped = true;
			} else if (char === '"') {
				inString = false;
			}
			continue;
		}
		if (char === '"') {
			inString = true;
			continue;
		}
		if (char === "{") {
			depth++;
			continue;
		}
		if (char === "}") {
			depth--;
			if (depth === 0) {
				return raw.slice(start, index + 1);
			}
		}
	}
	return null;
}

/**
 * Extract a plan-action envelope from raw message content.
 *
 * Returns `null` when the text contains no recognizable envelope, when the
 * envelope is missing a non-empty `action`, or when the envelope looks like
 * a Stage-1 HANDLE_RESPONSE payload (defensive — see `STAGE_1_DISCRIMINATORS`).
 *
 * The returned `recoverySource` distinguishes the two recognized shapes so
 * the planner-loop / trajectory recorder can attribute the recovery in logs.
 */
export function extractPlanActionsFromContent(
	text: string | null | undefined,
): ExtractedPlanAction | null {
	if (typeof text !== "string") return null;
	const trimmed = text.trim();
	if (!trimmed) return null;

	const envelopeBody = extractEnvelopeBody(trimmed);
	if (envelopeBody) {
		const parsed = parseJsonObject<Record<string, unknown>>(envelopeBody);
		if (parsed) {
			const extracted = buildExtracted(parsed, "plan-actions-envelope");
			if (extracted) return extracted;
		}
	}

	const bare = parseJsonObject<Record<string, unknown>>(trimmed);
	if (bare) {
		return buildExtracted(bare, "bare-action-object");
	}

	return null;
}
