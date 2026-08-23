/**
 * LLM-backed named-entity recognizer for the core PII pseudonymization layer.
 *
 * Entity extraction runs as a constrained JSON-extraction prompt against the
 * already-resident local llama.cpp backend (the Eliza-1 pipeline) rather than a
 * dedicated token-classification model, so there is no extra model download and
 * every byte of PII stays on-device. The recognizer takes a caller-supplied
 * `generate` function that MUST be wired to a local backend only, never to
 * `runtime.useModel` (which can route to cloud).
 *
 * Anti-hallucination contract: a model-reported entity is only emitted when its
 * value is found VERBATIM in the source text (forward-moving cursor, exact
 * `indexOf`). Anything the model paraphrases, trims, or invents is dropped, so
 * the value-based pseudonymizer always swaps real substrings. Unparseable model
 * output throws — `CompositeEntityRecognizer` is the designed degrade boundary
 * (a throwing recognizer contributes zero spans without killing the turn).
 */

import {
	type EntitySpan,
	logger,
	type PiiEntityRecognizer,
	toWellFormedUnicode,
	truncateWellFormed,
} from "@elizaos/core";

/** Local-only text generation seam the recognizer runs its prompt through. */
export type LocalPiiGenerate = (args: {
	prompt: string;
	maxTokens?: number;
	temperature?: number;
	stopSequences?: string[];
}) => Promise<string>;

/** Entity classes this recognizer owns. Email/phone/address stay with core's regex recognizer. */
export const PII_LLM_KINDS = ["person", "org", "location"] as const;

/** Chunk size keeps prompts comfortably inside small local-model context windows. */
export const PII_CHUNK_CHARS = 4000;

const PROMPT_HEADER = `You are a named-entity extractor. Read the text between <text> tags and list every personal name (person), organization/company name (org), and place name (location) that appears in it.

Rules:
- Output ONLY a JSON array, no prose: [{"kind":"person","value":"..."}]
- "kind" must be exactly "person", "org", or "location".
- "value" must be copied VERBATIM from the text (exact characters, casing, spacing).
- List entities in the order they first appear. No duplicates.
- If there are none, output [].

<text>
`;

const PROMPT_FOOTER = `
</text>

JSON array:`;

export function buildPiiExtractionPrompt(chunk: string): string {
	return PROMPT_HEADER + chunk + PROMPT_FOOTER;
}

/** Split long input into chunks the prompt can carry; offsets re-base onto the full text. */
export function chunkText(
	text: string,
	chunkChars: number = PII_CHUNK_CHARS,
): { text: string; offset: number }[] {
	if (text.length <= chunkChars) return [{ text, offset: 0 }];
	const chunks: { text: string; offset: number }[] = [];
	let offset = 0;
	while (offset < text.length) {
		let end = Math.min(offset + chunkChars, text.length);
		// Prefer breaking on whitespace so an entity is not split mid-word.
		if (end < text.length) {
			const lastSpace = text.lastIndexOf(" ", end);
			if (lastSpace > offset + chunkChars / 2) end = lastSpace;
		}
		chunks.push({ text: text.slice(offset, end), offset });
		offset = end;
	}
	return chunks;
}

/** A model-reported entity before verbatim relocation in the source text. */
export interface ReportedEntity {
	kind: string;
	value: string;
}

/**
 * Parse the model's completion into reported entities. Accepts surrounding
 * prose/code fences (extracts the first top-level JSON array) because small
 * local models occasionally wrap the array. Throws when no valid array is
 * present — the composite recognizer degrades, and the failure stays visible.
 */
export function parseReportedEntities(completion: string): ReportedEntity[] {
	const start = completion.indexOf("[");
	const end = completion.lastIndexOf("]");
	if (start === -1 || end === -1 || end < start) {
		throw new Error(
			`[LocalPii] model output contains no JSON array: ${JSON.stringify(truncateWellFormed(toWellFormedUnicode(completion), 200))}`,
		);
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(completion.slice(start, end + 1));
	} catch (cause) {
		throw new Error(
			`[LocalPii] model output is not valid JSON: ${JSON.stringify(completion.slice(start, start + 200))}`,
			{ cause },
		);
	}
	if (!Array.isArray(parsed)) {
		throw new Error("[LocalPii] model output parsed to a non-array");
	}
	const kinds: readonly string[] = PII_LLM_KINDS;
	const entities: ReportedEntity[] = [];
	for (const item of parsed) {
		if (item === null || typeof item !== "object") continue;
		const { kind, value } = item as { kind?: unknown; value?: unknown };
		if (typeof kind !== "string" || typeof value !== "string") continue;
		const trimmedKind = kind.trim().toLowerCase();
		if (!kinds.includes(trimmedKind)) continue;
		if (value.length === 0 || value.trim().length === 0) continue;
		entities.push({ kind: trimmedKind, value });
	}
	return entities;
}

/**
 * Locate reported entities verbatim in `chunk` with a forward-moving cursor
 * (entities arrive in reading order) and re-base offsets by `base` onto the full
 * text. A value not found from the cursor is retried from the chunk start
 * (models sometimes reorder); a value not found at all is dropped and logged —
 * never emitted with a guessed offset or a paraphrased value.
 */
export function relocateEntities(
	chunk: string,
	base: number,
	reported: readonly ReportedEntity[],
): EntitySpan[] {
	const spans: EntitySpan[] = [];
	let cursor = 0;
	for (const entity of reported) {
		let idx = chunk.indexOf(entity.value, cursor);
		if (idx === -1) idx = chunk.indexOf(entity.value);
		if (idx === -1) {
			logger.debug(
				`[LocalPii] dropping entity not found verbatim in source: ${JSON.stringify(entity.value)}`,
			);
			continue;
		}
		spans.push({
			kind: entity.kind,
			value: entity.value,
			start: base + idx,
			end: base + idx + entity.value.length,
		});
		cursor = idx + entity.value.length;
	}
	return spans;
}

/**
 * The recognizer the local-inference plugin injects behind core's
 * `PII_ENTITY_RECOGNIZER_SERVICE` seam. Stateless per call; the local model is
 * already resident, so there is no load/warm-up phase.
 */
export class LlmEntityRecognizer implements PiiEntityRecognizer {
	readonly name = "local-llm-ner";
	private readonly generate: LocalPiiGenerate;
	private readonly chunkChars: number;

	constructor(
		generate: LocalPiiGenerate,
		options: { chunkChars?: number } = {},
	) {
		this.generate = generate;
		this.chunkChars = options.chunkChars ?? PII_CHUNK_CHARS;
	}

	async recognize(text: string): Promise<EntitySpan[]> {
		if (!text || text.trim().length === 0) return [];
		const spans: EntitySpan[] = [];
		for (const chunk of chunkText(text, this.chunkChars)) {
			const completion = await this.generate({
				prompt: buildPiiExtractionPrompt(chunk.text),
				maxTokens: 512,
				temperature: 0,
			});
			const reported = parseReportedEntities(completion);
			spans.push(...relocateEntities(chunk.text, chunk.offset, reported));
		}
		// De-duplicate identical (kind, start) spans across chunk retries.
		const seen = new Set<string>();
		return spans.filter((span) => {
			const key = `${span.kind}\0${span.start}\0${span.value}`;
			if (seen.has(key)) return false;
			seen.add(key);
			return true;
		});
	}
}
