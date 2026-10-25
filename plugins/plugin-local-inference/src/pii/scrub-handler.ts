/**
 * Production `PII_SCRUB` prompt builder and completion parser for the
 * local-inference lane. The core scrub seam
 * (`packages/core/src/security/pii-scrub-seam.ts`) escalates residue
 * candidates its deterministic tier-0 detectors cannot decide; this module
 * turns that escalation into a constrained JSON-judgment prompt against the
 * resident Eliza-1 backend and parses the completion into the seam's
 * fail-closed `PiiScrubResult` shape.
 *
 * Contract highlights (enforced here, re-verified by the seam's
 * `assertValidScrubResult`):
 * - Every escalated candidate span MUST receive a verdict; a completion that
 *   drops a candidate throws (absence is never interpreted as clean).
 * - `pii` verdicts must carry a replacement. When the caller supplied a
 *   pseudonym assignment for the verdict's cluster, that assignment's
 *   surrogate is used VERBATIM regardless of what the model emitted, so
 *   corpus-wide pseudonym consistency is structural, not model-trusted.
 * - Unparseable output throws — the scrub rails retry/quarantine the item.
 *
 * The prompt carries the retrieval context pack and the per-chunk
 * cluster→surrogate slice, never the whole corpus map.
 */

import type {
	PiiPseudonymAssignment,
	PiiScrubParams,
	PiiScrubVerdict,
} from "@elizaos/core";
import { toWellFormedUnicode, truncateWellFormed } from "@elizaos/core";

/** Build the constrained judgment prompt for one escalation call. */
export function buildPiiScrubPrompt(params: PiiScrubParams): string {
	const sections: string[] = [
		"You are a privacy scrubber. Judge each candidate span found in the text between <text> tags: is it personally identifying information (PII) that must be replaced, or safe to keep?",
		`Rules:
- Output ONLY a JSON array, no prose: [{"span":"...","verdict":"pii","replacement":"...","cluster":"..."}]
- Include EXACTLY one object per candidate span listed below, "span" copied VERBATIM.
- "verdict" must be exactly "pii" or "safe".
- For "pii" verdicts, provide a realistic surrogate "replacement" of the same kind (fake name for a name, fake company for a company). Never reuse the original value.
- For "safe" verdicts, omit "replacement".
- When the pseudonym assignments below list a surrogate for an entity, use exactly that surrogate as the replacement and set "cluster" to its cluster id.`,
	];
	if (params.contextPack && params.contextPack.trim().length > 0) {
		sections.push(`Context:\n${params.contextPack.trim()}`);
	}
	const assignments = params.pseudonymAssignments ?? [];
	if (assignments.length > 0) {
		const lines = assignments.map(
			(a) =>
				`- cluster ${a.entityClusterId} (${a.kind}): use surrogate ${JSON.stringify(a.surrogate)}`,
		);
		sections.push(
			`Pseudonym assignments (reuse EXACTLY):\n${lines.join("\n")}`,
		);
	}
	sections.push(
		`Candidate spans:\n${params.candidateSpans
			.map((span) => `- ${JSON.stringify(span)}`)
			.join("\n")}`,
	);
	sections.push(`<text>\n${params.text}\n</text>\n\nJSON array:`);
	return sections.join("\n\n");
}

/** Raw item shape the model is asked to emit. */
interface ReportedVerdict {
	span?: unknown;
	verdict?: unknown;
	replacement?: unknown;
	cluster?: unknown;
}

/**
 * Parse the completion into one verdict per candidate span. Throws on
 * unparseable output, unknown verdict kinds, missing candidates, or a `pii`
 * verdict with no usable replacement — the fail-closed doctrine: the rails
 * retry/quarantine, they never treat garbage as clean. Hallucinated verdicts
 * for spans not present in the source text are dropped; the coverage check
 * below still requires every real candidate to be judged.
 */
export function parseScrubCompletion(
	completion: string,
	params: PiiScrubParams,
): PiiScrubVerdict[] {
	const start = completion.indexOf("[");
	const end = completion.lastIndexOf("]");
	if (start === -1 || end === -1 || end < start) {
		throw new Error(
			`[local-inference] PII_SCRUB output contains no JSON array: ${JSON.stringify(truncateWellFormed(toWellFormedUnicode(completion), 200))}`,
		);
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(completion.slice(start, end + 1));
	} catch (cause) {
		// error-policy:J2 wrap the parse failure with the model-output context;
		// the seam quarantines the item on throw.
		throw new Error(
			`[local-inference] PII_SCRUB output is not valid JSON: ${JSON.stringify(completion.slice(start, start + 200))}`,
			{ cause },
		);
	}
	if (!Array.isArray(parsed)) {
		throw new Error("[local-inference] PII_SCRUB output parsed to a non-array");
	}

	const byCluster = new Map<string, PiiPseudonymAssignment>();
	for (const assignment of params.pseudonymAssignments ?? []) {
		byCluster.set(assignment.entityClusterId, assignment);
	}

	const bySpan = new Map<string, PiiScrubVerdict>();
	for (const item of parsed as readonly ReportedVerdict[]) {
		if (item === null || typeof item !== "object") continue;
		const span = typeof item.span === "string" ? item.span : "";
		if (span.length === 0 || !params.text.includes(span)) continue;
		const kindRaw =
			typeof item.verdict === "string" ? item.verdict.trim().toLowerCase() : "";
		if (kindRaw !== "pii" && kindRaw !== "safe") {
			throw new Error(
				`[local-inference] PII_SCRUB verdict for ${JSON.stringify(span)} has unknown kind ${JSON.stringify(item.verdict)}`,
			);
		}
		if (kindRaw === "safe") {
			bySpan.set(span, { span, kind: "safe" });
			continue;
		}
		const clusterId =
			typeof item.cluster === "string" && item.cluster.trim().length > 0
				? item.cluster.trim()
				: undefined;
		// Consistency is structural: an assigned cluster's surrogate wins over
		// whatever the model emitted, so one person gets ONE pseudonym
		// corpus-wide.
		const assignment = clusterId ? byCluster.get(clusterId) : undefined;
		const replacement =
			assignment?.surrogate ??
			(typeof item.replacement === "string" &&
			item.replacement.trim().length > 0
				? item.replacement.trim()
				: undefined);
		if (!replacement || replacement === span) {
			throw new Error(
				`[local-inference] PII_SCRUB pii verdict for ${JSON.stringify(span)} lacks a usable replacement`,
			);
		}
		bySpan.set(span, {
			span,
			kind: "pii",
			replacement,
			...(assignment ? { entityClusterId: assignment.entityClusterId } : {}),
		});
	}

	// Every escalated candidate must be judged. The seam re-checks coverage,
	// but throwing here keeps the failure attributed to the handler's model
	// output.
	for (const candidate of params.candidateSpans) {
		const needle = candidate.trim();
		if (needle.length === 0) continue;
		const covered = [...bySpan.keys()].some(
			(s) => s === needle || s.includes(needle),
		);
		if (!covered) {
			throw new Error(
				`[local-inference] PII_SCRUB output omitted a verdict for candidate ${JSON.stringify(candidate)}`,
			);
		}
	}

	return [...bySpan.values()];
}
