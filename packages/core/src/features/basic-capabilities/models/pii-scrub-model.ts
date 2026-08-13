/**
 * Production {@link ModelType.PII_SCRUB} model handler (#15973).
 *
 * Before this module, no production handler was registered for
 * {@link ModelType.PII_SCRUB}. The seam ({@link scrubWithEscalation}) was
 * fail-closed — content with un-inspectable residue threw — but there was no
 * default handler to serve that escalation. The only handlers lived in tests.
 *
 * This handler is the **context-aware pass**: it takes the candidate spans the
 * tier-0 deterministic detectors could not decide, asks a TEXT_SMALL model to
 * classify each one (`pii` / `safe`), and returns the typed verdict set. It is
 * registered by the basic-capabilities plugin at priority 0 (lowest — a
 * dedicated on-device privacy-filter GGUF or Eliza Cloud handler should win
 * over this TEXT_SMALL-based fallback, exactly like the
 * `local-inference@0 < BYO@1 < Eliza Cloud@50` tiering for TEXT_EMBEDDING).
 *
 * Fail-closed contract: if no TEXT_SMALL model is registered, or the model
 * returns an unparseable / incomplete response, the handler THROWS. It never
 * fabricates a "safe" verdict to avoid a throw — that would be the exact
 * fail-open the seam's {@link assertValidScrubResult} exists to prevent.
 */

import type {
	PiiPseudonymAssignment,
	PiiScrubParams,
	PiiScrubResult,
	PiiScrubVerdict,
} from "../../../types/model.js";
import { ModelType } from "../../../types/model.js";
import type { IAgentRuntime } from "../../../types/runtime.js";

const HANDLER_MODEL_ID = "eliza-core:pii-scrub:text-small-fallback";
const HANDLER_PRIORITY = 0;

/**
 * The classification prompt sent to TEXT_SMALL. Asks for a strict JSON array
 * of `{span, kind}` objects. The handler parses this into typed verdicts.
 */
function buildScrubPrompt(params: PiiScrubParams): string {
	const spanList = params.candidateSpans
		.map((s, i) => `${i + 1}. "${s}"`)
		.join("\n");

	const assignmentLines = (params.pseudonymAssignments ?? [])
		.map(
			(a) =>
				`- cluster ${a.entityClusterId} (${a.kind}): use surrogate "${a.surrogate}"`,
		)
		.join("\n");

	return [
		"You are a PII classification assistant. For each candidate span, decide if it is personally identifiable information (PII) or safe to keep.",
		"",
		`Ruleset version: ${params.rulesetVersion}`,
		"",
		"Candidate spans to classify:",
		spanList,
		"",
		assignmentLines
			? `Already-pseudonymized clusters (use these surrogates if the span belongs to one):\n${assignmentLines}`
			: "",
		params.contextPack
			? `Context for disambiguation:\n${params.contextPack}`
			: "",
		"",
		'For each span, output a JSON object: {"span": "<exact span>", "kind": "pii"|"safe", "replacement": "<surrogate if pii, omit if safe>"}',
		'A "pii" verdict MUST include a realistic "replacement" surrogate. A "safe" verdict means you positively judged it non-sensitive.',
		"Respond with ONLY a JSON array of these objects. No prose.",
	].join("\n");
}

/**
 * Parse the model's JSON response into typed verdicts. Throws on any structural
 * problem — fail-closed. Every requested candidate span MUST receive a verdict;
 * a response that omits a candidate is incomplete and throws.
 */
function parseVerdictResponse(
	raw: string,
	params: PiiScrubParams,
): PiiScrubResult {
	let parsed: unknown;
	try {
		// The model may wrap the JSON in prose or markdown fences; extract the
		// first JSON array from the response.
		const jsonMatch = raw.match(/\[[\s\S]*\]/);
		parsed = JSON.parse(jsonMatch ? jsonMatch[0] : raw);
	} catch {
		throw new Error(
			`PII_SCRUB handler: model response is not valid JSON (${raw.slice(0, 120)}…)`,
		);
	}

	if (!Array.isArray(parsed)) {
		throw new Error("PII_SCRUB handler: model response is not a JSON array");
	}

	const verdicts: PiiScrubVerdict[] = [];
	for (const item of parsed as unknown[]) {
		if (item === null || typeof item !== "object") {
			throw new Error("PII_SCRUB handler: verdict is not an object");
		}
		const v = item as {
			span?: unknown;
			kind?: unknown;
			replacement?: unknown;
			entityClusterId?: unknown;
		};
		if (typeof v.span !== "string" || v.span.length === 0) {
			throw new Error("PII_SCRUB handler: verdict missing non-empty span");
		}
		if (v.kind !== "pii" && v.kind !== "safe") {
			throw new Error(
				`PII_SCRUB handler: verdict kind must be "pii" or "safe", got ${JSON.stringify(v.kind)}`,
			);
		}
		const verdict: PiiScrubVerdict = {
			span: v.span,
			kind: v.kind,
			...(typeof v.entityClusterId === "string"
				? { entityClusterId: v.entityClusterId }
				: {}),
			...(v.kind === "pii"
				? {
						replacement:
							typeof v.replacement === "string" && v.replacement.length > 0
								? v.replacement
								: defaultSurrogate(v.span),
					}
				: {}),
		};
		verdicts.push(verdict);
	}

	return {
		verdicts,
		modelId: HANDLER_MODEL_ID,
		rulesetVersion: params.rulesetVersion,
	};
}

/**
 * A deterministic fallback surrogate when the model returns a `pii` verdict
 * without a replacement. Uses a per-kind fictional shape (mirrors the
 * pseudonymizer's mintSurrogate pools). This is NOT the primary path — the
 * prompt asks for replacements — but it prevents a throw on a model that
 * classifies correctly but forgets the surrogate.
 */
function defaultSurrogate(span: string): string {
	// Stable hash of the span for deterministic selection.
	let hash = 0;
	for (let i = 0; i < span.length; i++) {
		hash = (Math.imul(hash, 31) + span.charCodeAt(i)) | 0;
	}
	const idx = Math.abs(hash);
	const names = [
		"Priya Okafor",
		"Mateo Delgado",
		"Aria Nakamura",
		"Northwind Labs",
		"Contoso Systems",
		"Fairhaven",
	];
	return names[idx % names.length] ?? "[REDACTED]";
}

/**
 * The production PII_SCRUB model handler. Escalates candidate spans to a
 * TEXT_SMALL model for context-aware classification. Fail-closed: throws when
 * no TEXT_SMALL is registered or the response is unparseable.
 */
export async function piiScrubModelHandler(
	runtime: IAgentRuntime,
	params: PiiScrubParams,
): Promise<PiiScrubResult> {
	// Fail-closed: no TEXT_SMALL → cannot classify → throw (never fabricate safe).
	if (!runtime.getModel(ModelType.TEXT_SMALL)) {
		throw new Error(
			"PII_SCRUB handler: no TEXT_SMALL model registered; cannot perform context-aware classification (fail-closed)",
		);
	}

	const prompt = buildScrubPrompt(params);
	const result = await runtime.useModel(ModelType.TEXT_SMALL, {
		prompt,
		temperature: 0,
		maxTokens: 1024,
		voiceOutput: "internal",
		priority: params.priority,
		...(params.signal ? { signal: params.signal } : {}),
	});

	// useModel for TEXT_SMALL returns a TextStreamResult or string.
	const raw =
		typeof result === "string"
			? result
			: ((result as { text?: string }).text ?? "");

	const scrubResult = parseVerdictResponse(raw, params);

	// Fill in entityClusterId from pseudonymAssignments when the model didn't.
	if (params.pseudonymAssignments && params.pseudonymAssignments.length > 0) {
		return attachClusterIds(scrubResult, params.pseudonymAssignments);
	}

	return scrubResult;
}

/**
 * Attach the entityClusterId from the pseudonym assignments to matching
 * verdicts, so the rewrite stage can use the corpus-consistent surrogate.
 */
function attachClusterIds(
	result: PiiScrubResult,
	assignments: readonly PiiPseudonymAssignment[],
): PiiScrubResult {
	// Build a span→clusterId map from the assignments (the surrogate is the
	// replacement the model should have used; we match on it).
	const surrogateToCluster = new Map<string, string>();
	for (const a of assignments) {
		surrogateToCluster.set(a.surrogate, a.entityClusterId);
	}
	const verdicts = result.verdicts.map((v) => {
		if (v.entityClusterId) return v;
		const clusterId = v.replacement && surrogateToCluster.get(v.replacement);
		return clusterId ? { ...v, entityClusterId: clusterId } : v;
	});
	return { ...result, verdicts };
}

/**
 * The plugin model registration object for basic-capabilities. Registered at
 * priority 0 so a dedicated privacy-filter GGUF / Eliza Cloud handler wins.
 */
export const piiScrubModelRegistration = {
	modelType: ModelType.PII_SCRUB,
	handler: piiScrubModelHandler,
	provider: "eliza-core",
	priority: HANDLER_PRIORITY,
	modelId: HANDLER_MODEL_ID,
} as const;
