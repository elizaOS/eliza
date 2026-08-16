/** Defines and validates the bounded public-web evidence envelope shared by cloud history and Dedicated imports. */

export const PUBLIC_WEB_GROUNDING_METADATA_KEY = "publicWebGrounding";
export const MAX_PUBLIC_WEB_GROUNDING_QUERY_BYTES = 512;
export const MAX_PUBLIC_WEB_GROUNDING_RESULT_BYTES = 4_000;
export const MAX_PUBLIC_WEB_GROUNDING_ENCODED_BYTES = 6_000;

export type PublicWebGrounding = {
	kind: "web_search";
	query: string;
	provider: "parallel" | "exa";
	text: string;
	observedAt: number;
	truncated: boolean;
};

const GROUNDING_STOP_WORDS = new Set([
	"and",
	"are",
	"for",
	"from",
	"have",
	"how",
	"that",
	"the",
	"this",
	"was",
	"what",
	"when",
	"where",
	"which",
	"who",
	"with",
	"you",
]);
const DEICTIC_GROUNDING_FOLLOW_UP =
	/\b(?:it|that|this|those|these|they|them|result|results|source|sources|finding|findings)\b/i;

const encoder = new TextEncoder();

function truncateUtf8(
	value: string,
	maxBytes: number,
): { value: string; truncated: boolean } {
	const trimmed = value.trim();
	if (encoder.encode(trimmed).byteLength <= maxBytes)
		return { value: trimmed, truncated: false };
	let low = 0;
	let high = trimmed.length;
	while (low < high) {
		const middle = Math.ceil((low + high) / 2);
		if (encoder.encode(trimmed.slice(0, middle)).byteLength <= maxBytes)
			low = middle;
		else high = middle - 1;
	}
	return { value: trimmed.slice(0, low), truncated: true };
}

/** Rejects malformed provenance and independently bounds every persisted field. */
export function parsePublicWebGrounding(
	value: unknown,
): PublicWebGrounding | undefined {
	if (!value || typeof value !== "object") return undefined;
	const candidate = value as Record<string, unknown>;
	if (
		candidate.kind !== "web_search" ||
		typeof candidate.query !== "string" ||
		(candidate.provider !== "parallel" && candidate.provider !== "exa") ||
		typeof candidate.text !== "string" ||
		typeof candidate.observedAt !== "number" ||
		!Number.isSafeInteger(candidate.observedAt) ||
		candidate.observedAt < 0 ||
		typeof candidate.truncated !== "boolean"
	)
		return undefined;
	const query = truncateUtf8(
		candidate.query,
		MAX_PUBLIC_WEB_GROUNDING_QUERY_BYTES,
	);
	const text = truncateUtf8(
		candidate.text,
		MAX_PUBLIC_WEB_GROUNDING_RESULT_BYTES,
	);
	if (!query.value || !text.value) return undefined;
	return {
		kind: "web_search",
		query: query.value,
		provider: candidate.provider,
		text: text.value,
		observedAt: candidate.observedAt,
		truncated: candidate.truncated || query.truncated || text.truncated,
	};
}

/** Encodes untrusted evidence as JSON so result text cannot forge envelope boundaries. */
export function encodePublicWebGrounding(value: PublicWebGrounding): string {
	const parsed = parsePublicWebGrounding(value);
	if (!parsed) throw new TypeError("Invalid public web grounding");
	let text = parsed.text;
	for (;;) {
		const encoded = JSON.stringify({
			type: "untrusted_public_web_search_result",
			instructionPolicy: "data_only",
			...parsed,
			text,
			truncated: parsed.truncated || text.length < parsed.text.length,
		});
		if (
			encoder.encode(encoded).byteLength <=
			MAX_PUBLIC_WEB_GROUNDING_ENCODED_BYTES
		)
			return encoded;
		text = truncateUtf8(
			text,
			Math.max(0, encoder.encode(text).byteLength - 256),
		).value;
	}
}

function groundingWords(value: string): Set<string> {
	return new Set(
		value
			.toLowerCase()
			.match(/[\p{L}\p{N}]+/gu)
			?.filter((word) => word.length > 2 && !GROUNDING_STOP_WORDS.has(word)) ??
			[],
	);
}

/** Selects at most two results using trusted query/prose only; result text never affects rank. */
export function selectRelevantPublicWebGroundingIds(
	candidates: readonly {
		id: string;
		prose: string;
		grounding: PublicWebGrounding;
		immediate: boolean;
	}[],
	queryText: string,
): Set<string> {
	const query = groundingWords(queryText);
	return new Set(
		candidates
			.map((candidate, index) => {
				const words = groundingWords(
					`${candidate.prose}\n${candidate.grounding.query}`,
				);
				let overlap = 0;
				for (const word of query) if (words.has(word)) overlap += 1;
				return { ...candidate, index, overlap };
			})
			.filter(
				(candidate) =>
					candidate.overlap > 0 ||
					(candidate.immediate && DEICTIC_GROUNDING_FOLLOW_UP.test(queryText)),
			)
			.sort(
				(left, right) =>
					right.overlap - left.overlap || right.index - left.index,
			)
			.slice(0, 2)
			.map((candidate) => candidate.id),
	);
}
