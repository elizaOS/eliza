/**
 * Named-entity recognition for the PII pseudonymization layer (#10469 / #7007).
 *
 * The {@link ./pii-pseudonymizer | PseudonymSession} owns the surrogate vault and
 * the (synchronous, value-based) substitution/restoration. It does *not* decide
 * what counts as a person / organization / location / address — that is this
 * module's job. A {@link PiiEntityRecognizer} takes text and returns typed
 * {@link EntitySpan}s; the session learns their values and mints surrogates.
 *
 * Recognizers here:
 * - {@link RegexEntityRecognizer} — deterministic, dependency-free. Catches
 *   *structured* named PII that patterns handle reliably (street addresses, and —
 *   opt-in — emails/phones). Ships enabled by default so the layer is useful even
 *   with no ML model present.
 * - {@link GazetteerEntityRecognizer} — dictionary-driven. Used by the test suite
 *   to drive the full swap/restore pipeline deterministically without downloading
 *   a model, and usable in production to force-protect a known contact list.
 * - {@link CompositeEntityRecognizer} — merges several recognizers, resolves
 *   overlaps (longest span wins), and applies the blocklist.
 *
 * The heavy local NER model (distilbert-NER via `@huggingface/transformers`) lives
 * behind this same interface in `@elizaos/plugin-pii-guard` and is injected at
 * runtime, so `@elizaos/core` never hard-depends on an ONNX runtime.
 *
 * ## transformers.js offset caveat (issue #359)
 * transformers.js token-classification pipelines frequently return `start`/`end`
 * as `null` for BERT/DeBERTa tokenizers. That is why {@link EntitySpan.start} /
 * {@link EntitySpan.end} are optional and why the pseudonymizer swaps by **value**
 * (string replace), never by offset. Recognizers should still fill offsets when
 * they can (regex/gazetteer do) so overlap resolution is precise.
 */

/** A detected named-entity span. Offsets are best-effort (see module note). */
export interface EntitySpan {
	/** Entity class — one of {@link PseudonymKind} (`person`, `org`, …) or an
	 * upstream label the composite recognizer maps. */
	readonly kind: string;
	/** The surface string of the entity, as it appears in the source text. */
	readonly value: string;
	/** Character start offset in the source text, when known. */
	readonly start?: number;
	/** Character end offset in the source text, when known. */
	readonly end?: number;
	/** Detector confidence in `[0,1]`, when the recognizer reports one. */
	readonly score?: number;
}

/** Recognizes named-entity PII spans in free text. */
export interface PiiEntityRecognizer {
	/** Stable identifier, for logging/telemetry (`regex`, `distilbert-ner`, …). */
	readonly name: string;
	/** Return every detected span in `text`. Must not throw for empty input. */
	recognize(text: string): Promise<EntitySpan[]>;
}

/**
 * Service type a plugin registers to supply the local NER model recognizer to
 * the runtime's PII swap layer. `@elizaos/core` never hard-depends on an ONNX
 * runtime; it looks up this service when PII swap is enabled and composes the
 * returned recognizer with its built-in regex recognizer. When absent, the layer
 * runs regex-only (addresses; opt-in email/phone) — degraded but still safe.
 */
export const PII_ENTITY_RECOGNIZER_SERVICE = "pii_entity_recognizer";

/** Shape a {@link PII_ENTITY_RECOGNIZER_SERVICE} service must expose. */
export interface PiiEntityRecognizerService {
	/** The recognizer, or `null` while the model is still loading / unavailable. */
	getRecognizer(): PiiEntityRecognizer | null;
}

/**
 * Options for {@link RegexEntityRecognizer}. Emails and phones are OFF by default:
 * when the secret-swap layer is also enabled it already masks them (as opaque
 * placeholders), and double-owning them across both layers causes a surrogate to
 * be re-masked. Turn them on here only when the pseudonym layer should own them.
 */
export interface RegexEntityRecognizerOptions {
	/** Detect US-style street addresses. Default `true`. */
	address?: boolean;
	/** Detect emails as `email` spans (see note above). Default `false`. */
	email?: boolean;
	/** Detect phone numbers as `phone` spans (see note above). Default `false`. */
	phone?: boolean;
}

// US-style street address: number + street words + a street-type keyword, with an
// optional trailing unit/city/state/ZIP tail. Kept conservative (requires the
// street-type keyword) so ordinary "12 items" / "3 apples" never match.
const STREET_ADDRESS =
	/\b\d{1,6}\s+(?:[A-Z][A-Za-z.'-]+\s+){1,4}(?:Street|St|Avenue|Ave|Boulevard|Blvd|Road|Rd|Lane|Ln|Drive|Dr|Court|Ct|Way|Terrace|Ter|Place|Pl|Circle|Cir|Highway|Hwy|Parkway|Pkwy)\b\.?(?:\s*(?:#|Apt\.?|Suite|Ste\.?|Unit)\s*\w+)?(?:,\s*[A-Z][A-Za-z.'-]+(?:\s+[A-Z][A-Za-z.'-]+)*)?(?:,\s*[A-Z]{2})?(?:\s+\d{5}(?:-\d{4})?)?/g;

// Reuse the same well-tested email/phone shapes the secret-swap detectors use.
const EMAIL = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g;
const PHONE =
	/(?<!\d)(?:\+?1[ .-]?)?(?:\(\d{3}\)[ .-]?|\d{3}[ .-])\d{3}[ .-]?\d{4}(?!\d)|\+[1-9]\d{7,14}(?!\d)/g;

/** Dependency-free recognizer for structured named PII (addresses, opt-in email/phone). */
export class RegexEntityRecognizer implements PiiEntityRecognizer {
	readonly name = "regex";
	private readonly detectors: { kind: string; pattern: RegExp }[];

	constructor(options: RegexEntityRecognizerOptions = {}) {
		this.detectors = [];
		if (options.address !== false) {
			this.detectors.push({ kind: "address", pattern: STREET_ADDRESS });
		}
		if (options.email) this.detectors.push({ kind: "email", pattern: EMAIL });
		if (options.phone) this.detectors.push({ kind: "phone", pattern: PHONE });
	}

	recognize(text: string): Promise<EntitySpan[]> {
		const spans: EntitySpan[] = [];
		if (text) {
			for (const { kind, pattern } of this.detectors) {
				pattern.lastIndex = 0;
				for (const match of text.matchAll(pattern)) {
					const value = match[0].trim();
					if (!value) continue;
					const start = match.index ?? 0;
					spans.push({ kind, value, start, end: start + match[0].length });
				}
			}
		}
		return Promise.resolve(spans);
	}
}

/**
 * Dictionary-driven recognizer. Matches supplied terms (whole-word, case
 * sensitivity configurable) and tags them with a fixed kind. Two uses:
 * deterministic tests of the full pipeline without an ML model, and forcing a
 * known contact roster to always be protected regardless of what the model finds.
 */
export class GazetteerEntityRecognizer implements PiiEntityRecognizer {
	readonly name: string;
	private readonly terms: { kind: string; value: string; lower: string }[];
	private readonly caseSensitive: boolean;

	constructor(
		entries: Iterable<{ kind: string; value: string }>,
		options: { name?: string; caseSensitive?: boolean } = {},
	) {
		this.name = options.name ?? "gazetteer";
		this.caseSensitive = options.caseSensitive ?? false;
		this.terms = [...entries]
			.map((e) => ({
				kind: e.kind,
				value: e.value,
				lower: e.value.toLowerCase(),
			}))
			.filter((e) => e.value.length > 0)
			// Longest first so "San Francisco" is preferred over "San".
			.sort((a, b) => b.value.length - a.value.length);
	}

	recognize(text: string): Promise<EntitySpan[]> {
		const spans: EntitySpan[] = [];
		if (!text) return Promise.resolve(spans);
		const haystack = this.caseSensitive ? text : text.toLowerCase();
		for (const term of this.terms) {
			const needle = this.caseSensitive ? term.value : term.lower;
			let from = 0;
			for (;;) {
				const idx = haystack.indexOf(needle, from);
				if (idx === -1) break;
				if (isWordBoundary(text, idx, idx + term.value.length)) {
					spans.push({
						kind: term.kind,
						// Preserve the source casing at this position.
						value: text.slice(idx, idx + term.value.length),
						start: idx,
						end: idx + term.value.length,
						score: 1,
					});
				}
				from = idx + term.value.length;
			}
		}
		return Promise.resolve(spans);
	}
}

function isWordBoundary(text: string, start: number, end: number): boolean {
	const before = start === 0 ? "" : text[start - 1];
	const after = end >= text.length ? "" : text[end];
	const isWord = (c: string) => c !== "" && /[A-Za-z0-9_]/.test(c);
	return !isWord(before) && !isWord(after);
}

/**
 * Merges several recognizers, resolves overlapping spans (longest wins, ties
 * broken by recognizer order), maps upstream labels to canonical pseudonym kinds,
 * and drops blocklisted values. This is what the runtime wires to the session.
 */
export class CompositeEntityRecognizer implements PiiEntityRecognizer {
	readonly name = "composite";
	private readonly recognizers: readonly PiiEntityRecognizer[];
	private readonly blocklistLower: ReadonlySet<string>;

	constructor(
		recognizers: readonly PiiEntityRecognizer[],
		options: { blocklist?: Iterable<string> } = {},
	) {
		this.recognizers = recognizers;
		this.blocklistLower = new Set(
			[...(options.blocklist ?? [])].map((v) => v.trim().toLowerCase()),
		);
	}

	async recognize(text: string): Promise<EntitySpan[]> {
		if (!text) return [];
		// Run recognizers concurrently — the ONNX model call overlaps the (cheap)
		// regex/gazetteer passes rather than serializing behind them.
		const batches = await Promise.all(
			this.recognizers.map(async (r, order) => {
				const spans = await r.recognize(text);
				return spans.map((s) => ({ span: s, order }));
			}),
		);
		const candidates = batches
			.flat()
			.map(({ span, order }) => ({
				span: { ...span, kind: canonicalKind(span.kind) },
				order,
			}))
			.filter(({ span }) => !this.blocklistLower.has(span.value.toLowerCase()));

		// Overlap resolution needs offsets. Spans without offsets (e.g. an ML model
		// that returned null offsets) are kept as-is — value-based substitution
		// downstream de-duplicates by value anyway.
		const located = candidates.filter(
			({ span }) => span.start !== undefined && span.end !== undefined,
		);
		const unlocated = candidates.filter(
			({ span }) => span.start === undefined || span.end === undefined,
		);

		located.sort(
			(a, b) =>
				b.span.value.length - a.span.value.length ||
				a.order - b.order ||
				(a.span.start ?? 0) - (b.span.start ?? 0),
		);
		const kept: EntitySpan[] = [];
		const keptRanges: { start: number; end: number }[] = [];
		for (const { span } of located) {
			const start = span.start as number;
			const end = span.end as number;
			if (keptRanges.some((r) => start < r.end && r.start < end)) continue;
			kept.push(span);
			keptRanges.push({ start, end });
		}

		// De-duplicate unlocated spans by (kind,value) and append.
		const seen = new Set(kept.map((s) => `${s.kind} ${s.value}`));
		for (const { span } of unlocated) {
			const key = `${span.kind} ${span.value}`;
			if (seen.has(key)) continue;
			seen.add(key);
			kept.push(span);
		}
		return kept;
	}
}

/**
 * Map an upstream recognizer label to a canonical pseudonym kind. Handles the
 * distilbert-NER CoNLL labels (`PER`/`ORG`/`LOC`/`MISC`, with or without `B-`/`I-`
 * prefixes) and common synonyms; unknown labels pass through unchanged so the
 * pseudonymizer's default surrogate still applies.
 */
export function canonicalKind(raw: string): string {
	const label = raw
		.replace(/^[BI]-/, "")
		.trim()
		.toLowerCase();
	switch (label) {
		case "per":
		case "person":
		case "people":
		case "first_name":
		case "last_name":
		case "full_name":
			return "person";
		case "org":
		case "organization":
		case "organisation":
		case "company":
			return "org";
		case "loc":
		case "location":
		case "gpe":
		case "city":
		case "place":
			return "location";
		case "address":
		case "street_address":
			return "address";
		case "email":
			return "email";
		case "phone":
		case "phone_number":
			return "phone";
		default:
			return label || raw;
	}
}
