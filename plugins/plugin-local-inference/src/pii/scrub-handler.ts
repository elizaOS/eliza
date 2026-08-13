/**
 * Implements the dedicated on-device `PII_SCRUB` model contract by prompting
 * the resident local text backend and validating its per-candidate verdicts.
 */

import type {
	GenerateTextParams,
	IAgentRuntime,
	PiiScrubParams,
	PiiScrubResult,
	PiiScrubVerdict,
} from "@elizaos/core";

export type LocalPiiScrubGenerate = (
	runtime: IAgentRuntime,
	params: GenerateTextParams,
) => Promise<string>;

const RESULT_PREFIX =
	'Output JSON only: {"verdicts":[{"span":string,"kind":"pii"|"safe","replacement"?:string,"entityClusterId"?:string}]}';

export function buildLocalPiiScrubPrompt(params: PiiScrubParams): string {
	return [
		"Inspect every candidate for personally identifiable information.",
		RESULT_PREFIX,
		"Return exactly one verdict for every candidate and copy span exactly.",
		"For pii, replacement is required. When a candidate is the entire text, rewrite it to preserve non-sensitive meaning while removing every PII value. Use the supplied pseudonym assignments when relevant.",
		"A safe verdict is allowed only after positively determining that the candidate contains no PII. If uncertain, fail instead of claiming safe.",
		JSON.stringify({
			text: params.text,
			candidateSpans: params.candidateSpans,
			contextPack: params.contextPack,
			pseudonymAssignments: params.pseudonymAssignments,
			rulesetVersion: params.rulesetVersion,
		}),
	].join("\n");
}

function parseVerdict(value: unknown): PiiScrubVerdict {
	if (!value || typeof value !== "object") {
		throw new Error("[LocalPiiScrub] verdict is not an object");
	}
	const record = value as Record<string, unknown>;
	if (typeof record.span !== "string" || record.span.length === 0) {
		throw new Error("[LocalPiiScrub] verdict span is missing");
	}
	if (record.kind !== "pii" && record.kind !== "safe") {
		throw new Error("[LocalPiiScrub] verdict kind is invalid");
	}
	if (
		record.replacement !== undefined &&
		typeof record.replacement !== "string"
	) {
		throw new Error("[LocalPiiScrub] verdict replacement is invalid");
	}
	if (record.kind === "pii" && !record.replacement) {
		throw new Error("[LocalPiiScrub] pii verdict is missing replacement");
	}
	if (
		record.entityClusterId !== undefined &&
		typeof record.entityClusterId !== "string"
	) {
		throw new Error("[LocalPiiScrub] verdict entityClusterId is invalid");
	}
	return {
		span: record.span,
		kind: record.kind,
		...(record.replacement !== undefined
			? { replacement: record.replacement }
			: {}),
		...(record.entityClusterId !== undefined
			? { entityClusterId: record.entityClusterId }
			: {}),
	};
}

export function parseLocalPiiScrubResult(
	completion: string,
	params: PiiScrubParams,
): PiiScrubResult {
	const start = completion.indexOf("{");
	const end = completion.lastIndexOf("}");
	if (start < 0 || end < start) {
		throw new Error("[LocalPiiScrub] model output contains no JSON object");
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(completion.slice(start, end + 1));
	} catch (cause) {
		throw new Error("[LocalPiiScrub] model output is not valid JSON", {
			cause,
		});
	}
	if (!parsed || typeof parsed !== "object") {
		throw new Error("[LocalPiiScrub] model output is not an object");
	}
	const verdicts = (parsed as Record<string, unknown>).verdicts;
	if (!Array.isArray(verdicts)) {
		throw new Error("[LocalPiiScrub] model output has no verdict array");
	}
	return {
		modelId: "eliza-local-inference",
		rulesetVersion: params.rulesetVersion,
		verdicts: verdicts.map(parseVerdict),
	};
}

export function createLocalPiiScrubHandler(generate: LocalPiiScrubGenerate) {
	return async (
		runtime: IAgentRuntime,
		params: PiiScrubParams,
	): Promise<PiiScrubResult> => {
		if (
			!params.text ||
			!params.rulesetVersion ||
			params.candidateSpans.length === 0
		) {
			throw new Error("[LocalPiiScrub] request is missing required input");
		}
		const completion = await generate(runtime, {
			prompt: buildLocalPiiScrubPrompt(params),
			responseFormat: { type: "json_object" },
			maxTokens: 1024,
			temperature: 0,
			priority: params.priority ?? "background",
			voiceOutput: "internal",
			signal: params.signal,
		});
		return parseLocalPiiScrubResult(completion, params);
	};
}
