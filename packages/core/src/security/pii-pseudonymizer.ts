/**
 * PII pseudonymization for the model-call boundary (#10469 / #7007).
 *
 * The secret-swap layer ({@link ./secret-swap}) masks *structured secrets*
 * (API keys, private keys, DB creds) behind opaque `__ELIZA_SECRET_…__`
 * placeholders that the model must never reason about and that are restored
 * only at the true execution boundary. That is the wrong shape for
 * *named-entity PII* — a person's name, an employer, a city, a street address.
 * For those the model genuinely needs to reason over a *coherent* value ("draft
 * an email to my manager Dana at Acme about the Rushmore contract") — but it
 * must never see the real one.
 *
 * The answer is **pseudonymization**: swap each real entity for a *realistic*
 * surrogate of the same type ("Dana Whitfield" → "Priya Okafor", "Acme" →
 * "Northwind Labs"), consistently within a session, then reverse the mapping on
 * the way back out. The provider sees a fluent, plausible prompt containing zero
 * real PII; the user sees their real contacts; the executed tool call carries the
 * real recipient.
 *
 * Guarantees this module is built to keep (exercised by the fuzz/red-team suites):
 * - **Deterministic + consistent.** The same original maps to the same surrogate
 *   everywhere in a session (a per-session random salt makes the mapping
 *   *unlinkable* across sessions so a provider cannot correlate turns).
 * - **Bijective + reversible.** Two different originals never share a surrogate,
 *   and every minted surrogate is collision-checked against the learned corpus
 *   and every other surrogate — so restore is exact. The only hard rule on the
 *   surrogate itself is that it is never the original's *own* value; a surrogate
 *   may coincidentally share a token with (or equal) some *other* real name — the
 *   mapping stays reversible and the provider still cannot attribute it.
 * - **No-leak.** After `substituteInValue`, no real value survives as a real
 *   reference: every standalone occurrence of a learned value is replaced. A real
 *   name may appear only as an incidental token *inside* a fabricated surrogate,
 *   which carries no attributable information.
 * - **Blacklist-aware.** Framework/brand identity ("elizaOS", "Eliza", provider
 *   names) and caller-supplied exempt values are never swapped.
 *
 * Detection is *not* done here — this module owns the surrogate vault and the
 * substitution/restoration. Callers feed it spans from an
 * {@link ./entity-recognizer | entity recognizer} (regex + an optional local NER
 * model) via {@link PseudonymSession.learnSpans}, or feed raw text plus a
 * recognizer via {@link PseudonymSession.learn}.
 */

import type { EntitySpan, PiiEntityRecognizer } from "./entity-recognizer";

/** A learned mapping between a real value and its session surrogate. */
export interface PseudonymEntry {
	/** The real, sensitive value (never sent to the provider). */
	readonly value: string;
	/** The realistic surrogate the provider sees in its place. */
	readonly surrogate: string;
	/** The entity class that produced this entry (`person`, `org`, …). */
	readonly kind: string;
}

export interface PseudonymSessionOptions {
	/**
	 * Deterministic seed for surrogate selection. Omit for a cryptographically
	 * random per-session salt (the production default — makes surrogates
	 * unlinkable across sessions). Tests pass a fixed salt for reproducibility.
	 */
	salt?: string;
	/**
	 * Values that must never be swapped even when a recognizer flags them
	 * (false-positive opt-out by value). Compared case-insensitively after trim.
	 * The framework/brand defaults ({@link DEFAULT_PSEUDONYM_BLOCKLIST}) are always
	 * merged in.
	 */
	blocklist?: Iterable<string>;
	/**
	 * Entity kinds to skip entirely (e.g. `["location"]` to leave places alone).
	 */
	disabledKinds?: Iterable<string>;
	/** Recognizer used by {@link PseudonymSession.learn}. Optional if callers only
	 * ever call {@link PseudonymSession.learnSpans} with pre-computed spans. */
	recognizer?: PiiEntityRecognizer;
	/**
	 * Minimum trimmed length for a detected span to be swapped. Guards against a
	 * recognizer emitting single-character or stopword spans. Default 2.
	 */
	minValueLength?: number;
}

/**
 * Framework / brand / provider identity that must never be treated as PII.
 * Swapping "elizaOS" out of a system prompt would corrupt the agent's own
 * identity and instructions; swapping a provider name is pointless and confusing.
 * Compared case-insensitively.
 */
export const DEFAULT_PSEUDONYM_BLOCKLIST: readonly string[] = [
	"eliza",
	"elizaos",
	"eliza classic",
	"eliza cloud",
	"anthropic",
	"claude",
	"openai",
	"chatgpt",
	"gpt",
	"google",
	"gemini",
	"groq",
	"xai",
	"grok",
	"openrouter",
	"mistral",
	"cohere",
	"ollama",
	"cerebras",
	"assistant",
	"user",
	"system",
];

/** Opt-in gate. When falsy, the runtime never mints a PseudonymSession. */
export const PII_SWAP_ENABLED_SETTING = "ELIZA_PII_SWAP_ENABLED";
/** Comma-separated values to never swap (false-positive opt-out by value). */
export const PII_SWAP_EXEMPT_VALUES_SETTING = "ELIZA_PII_SWAP_EXEMPT_VALUES";
/** Comma-separated entity kinds to skip (e.g. `location,address`). */
export const PII_SWAP_DISABLED_KINDS_SETTING = "ELIZA_PII_SWAP_DISABLED_KINDS";

/** Parse a comma-separated setting value into a trimmed, non-empty list. */
export function parsePiiSwapList(value: unknown): string[] {
	if (typeof value !== "string") return [];
	return value
		.split(",")
		.map((part) => part.trim())
		.filter(Boolean);
}

// ---------------------------------------------------------------------------
// Surrogate pools — realistic, fictional values by entity class.
// ---------------------------------------------------------------------------
// Deliberately fictional and broad. Phone/email/address use reserved-for-fiction
// ranges (555-01xx per NANP; example.com/.org/.net per RFC 2606) so a surrogate
// can never resolve to a real person, number, or mailbox even if it leaks.

const FIRST_NAMES: readonly string[] = [
	"Priya",
	"Mateo",
	"Aria",
	"Kwame",
	"Lena",
	"Diego",
	"Yuki",
	"Omar",
	"Sofia",
	"Ravi",
	"Nadia",
	"Tomas",
	"Amara",
	"Elias",
	"Freya",
	"Hana",
	"Isaac",
	"Jade",
	"Kiran",
	"Leila",
	"Marco",
	"Nia",
	"Oscar",
	"Petra",
	"Quinn",
	"Rosa",
	"Samir",
	"Tara",
	"Umar",
	"Vera",
	"Wren",
	"Zane",
	"Anika",
	"Bruno",
	"Cira",
	"Dante",
	"Esme",
	"Felix",
	"Gita",
	"Hugo",
];

const LAST_NAMES: readonly string[] = [
	"Okafor",
	"Whitfield",
	"Nakamura",
	"Delgado",
	"Ferreira",
	"Haddad",
	"Ivanov",
	"Johansson",
	"Kapoor",
	"Larsson",
	"Moreau",
	"Novak",
	"Okonkwo",
	"Petrov",
	"Quintero",
	"Rossi",
	"Sato",
	"Tanaka",
	"Ustinov",
	"Vargas",
	"Weber",
	"Xu",
	"Yamamoto",
	"Zielinski",
	"Adeyemi",
	"Bianchi",
	"Castro",
	"Dubois",
	"Eriksson",
	"Fontaine",
	"Gallo",
	"Hoffman",
	"Ionescu",
	"Jensen",
];

const ORG_HEADS: readonly string[] = [
	"Northwind",
	"Contoso",
	"Silverpeak",
	"Blueharbor",
	"Redcliff",
	"Evergreen",
	"Ironwood",
	"Brightsea",
	"Meridian",
	"Solstice",
	"Aurora",
	"Cascade",
	"Granite",
	"Harborview",
	"Junction",
	"Keystone",
	"Lakeshore",
	"Monarch",
	"Nimbus",
	"Orchard",
	"Pinnacle",
	"Quarry",
	"Ridgeline",
	"Summit",
];

const ORG_TAILS: readonly string[] = [
	"Labs",
	"Systems",
	"Partners",
	"Group",
	"Holdings",
	"Industries",
	"Collective",
	"Works",
	"Analytics",
	"Dynamics",
	"Logistics",
	"Networks",
	"Ventures",
	"Solutions",
	"Technologies",
	"Foundry",
];

const CITIES: readonly string[] = [
	"Fairhaven",
	"Port Alder",
	"Westmoor",
	"Crestline",
	"Ashford",
	"Rivermouth",
	"Elmbridge",
	"Kingsford",
	"Northgate",
	"Oakdale",
	"Pinehurst",
	"Stonebrook",
	"Thornbury",
	"Underhill",
	"Vale Crossing",
	"Whitmore",
	"Brookfield",
	"Cedar Falls",
	"Deerpark",
	"Glenmoor",
];

const STREETS: readonly string[] = [
	"Maple",
	"Cedar",
	"Birch",
	"Alder",
	"Willow",
	"Chestnut",
	"Juniper",
	"Sycamore",
	"Aspen",
	"Hawthorn",
	"Linden",
	"Magnolia",
	"Poplar",
	"Rowan",
	"Cypress",
	"Dogwood",
];

const STREET_TYPES: readonly string[] = [
	"Street",
	"Avenue",
	"Lane",
	"Road",
	"Boulevard",
	"Court",
	"Drive",
	"Way",
];

// ---------------------------------------------------------------------------
// Deterministic hashing (FNV-1a 32-bit) — reproducible surrogate selection.
// ---------------------------------------------------------------------------

function fnv1a(input: string): number {
	let hash = 0x811c9dc5;
	for (let i = 0; i < input.length; i += 1) {
		hash ^= input.charCodeAt(i);
		// hash *= 16777619, kept in 32-bit unsigned range.
		hash = Math.imul(hash, 0x01000193) >>> 0;
	}
	return hash >>> 0;
}

function pick<T>(pool: readonly T[], seed: number): T {
	return pool[seed % pool.length] as T;
}

function generateSessionSalt(): string {
	const bytes = new Uint8Array(16);
	const cryptoObj = (globalThis as { crypto?: Crypto }).crypto;
	if (typeof cryptoObj?.getRandomValues === "function") {
		cryptoObj.getRandomValues(bytes);
	} else {
		for (let i = 0; i < bytes.length; i += 1) {
			bytes[i] = Math.floor(Math.random() * 256);
		}
	}
	return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return (
		typeof value === "object" &&
		value !== null &&
		Object.getPrototypeOf(value) === Object.prototype
	);
}

function escapeRegExp(input: string): string {
	return input.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Compile a single-pass replacement regex over `keys` plus a callback map. Two
 * properties make substitution and restoration exact and mutually safe:
 *
 * 1. **Single pass, longest-first.** All keys go into one alternation ordered by
 *    length descending, so at any position the longest key wins and text a
 *    replacement *inserts* is never re-scanned. This is what lets a surrogate
 *    ("Mateo Delgado") safely contain a token that is itself another real value
 *    ("Mateo") without corrupting the round-trip.
 * 2. **Word-boundary lookarounds.** A key only matches when it is not glued to an
 *    adjacent word character, so swapping "John" never mangles "Johnson". Named
 *    entities are always word-char-edged, so this is the correct semantics and
 *    cannot drop a real occurrence.
 *
 * Returns `null` when there is nothing to replace.
 */
function compileReplacer(
	pairs: { from: string; to: string }[],
): { regex: RegExp; map: Map<string, string> } | null {
	if (pairs.length === 0) return null;
	const map = new Map<string, string>();
	for (const { from, to } of pairs) map.set(from, to);
	const alternation = [...map.keys()]
		.sort((a, b) => b.length - a.length)
		.map(escapeRegExp)
		.join("|");
	const regex = new RegExp(
		`(?<![A-Za-z0-9_])(?:${alternation})(?![A-Za-z0-9_])`,
		"g",
	);
	return { regex, map };
}

/**
 * Mint a candidate surrogate for `kind` at a given probe `attempt`. Pure
 * function of `(salt, kind, value, attempt)` so the mapping is deterministic and
 * reproducible; `attempt` is advanced by the caller on a collision.
 */
function mintSurrogate(
	salt: string,
	kind: string,
	value: string,
	attempt: number,
): string {
	const seed = fnv1a(`${salt}\0${kind}\0${value}\0${attempt}`);
	switch (kind) {
		case "person": {
			const first = pick(FIRST_NAMES, seed);
			const last = pick(LAST_NAMES, seed >>> 8);
			return `${first} ${last}`;
		}
		case "org": {
			const head = pick(ORG_HEADS, seed);
			const tail = pick(ORG_TAILS, seed >>> 8);
			return `${head} ${tail}`;
		}
		case "location": {
			return pick(CITIES, seed);
		}
		case "address": {
			const number = 100 + (seed % 9900);
			const street = pick(STREETS, seed >>> 8);
			const type = pick(STREET_TYPES, seed >>> 16);
			return `${number} ${street} ${type}`;
		}
		case "email": {
			const first = pick(FIRST_NAMES, seed).toLowerCase();
			const last = pick(LAST_NAMES, seed >>> 8).toLowerCase();
			// RFC 2606 reserved domain — can never route to a real mailbox.
			return `${first}.${last}@example.com`;
		}
		case "phone": {
			// NANP 555-0100..555-0199 block is reserved for fictional use.
			const line = 100 + (seed % 100);
			const area = 200 + (seed % 800);
			return `(${area}) 555-0${String(line).padStart(3, "0").slice(-3)}`;
		}
		default: {
			// Unknown kind: fall back to a person-shaped surrogate rather than an
			// opaque token, so downstream text stays fluent.
			const first = pick(FIRST_NAMES, seed);
			const last = pick(LAST_NAMES, seed >>> 8);
			return `${first} ${last}`;
		}
	}
}

/**
 * A per-session pseudonymization vault. Learns real entities (from a recognizer
 * or pre-computed spans), mints a realistic surrogate for each, and provides
 * exact, reversible substitution over strings and structured values.
 *
 * Not thread-safe; scope one to a single turn/session (carried on the
 * trajectory context, mirroring {@link SecretSwapSession}).
 */
export class PseudonymSession {
	private readonly salt: string;
	private readonly blocklist: ReadonlySet<string>;
	private readonly disabledKinds: ReadonlySet<string>;
	private readonly recognizer?: PiiEntityRecognizer;
	private readonly minValueLength: number;

	private readonly valueToEntry = new Map<string, PseudonymEntry>();
	private readonly surrogateToEntry = new Map<string, PseudonymEntry>();
	/** Lowercased surrogates in use, for O(1) collision checks when minting. */
	private readonly usedSurrogatesLower = new Set<string>();
	/**
	 * Every swappable real value ever learned, lowercased. The value namespace and
	 * the surrogate namespace are kept mutually exclusive: a surrogate is never
	 * minted equal to a known value, and — because `learn()` is called once per
	 * model call and a *later* call can introduce a real value equal to an
	 * *earlier* call's surrogate — any existing entry whose surrogate collides with
	 * a newly-learned value is re-minted. Without this, two distinct people could
	 * collapse onto one surrogate, breaking the round-trip and misdelivering the
	 * restored value at the execution boundary.
	 */
	private readonly knownValuesLower = new Set<string>();
	/**
	 * Everything the session has ever "seen" (learned text). A surrogate is
	 * rejected if it already occurs here, so substitution never mints a token
	 * that collides with real text and restore stays exact.
	 */
	private corpusLower = "";
	/** Compiled single-pass replacers, rebuilt lazily after a new entry is added. */
	private substituteReplacer: {
		regex: RegExp;
		map: Map<string, string>;
	} | null = null;
	private restoreReplacer: { regex: RegExp; map: Map<string, string> } | null =
		null;
	private replacersDirty = true;
	/**
	 * Longest string in either namespace (a real value or its surrogate),
	 * maintained as entries are minted/re-minted. The streaming guard
	 * ({@link ./guarded-stream}) sizes its carry-over window from this so a value
	 * or surrogate that spans a chunk boundary is never split across two emissions
	 * (which would leak a value fragment on the safe side, or drop a restore on the
	 * visible side). Surrogates can be longer than their value, so both count.
	 */
	private maxToken = 0;

	constructor(options: PseudonymSessionOptions = {}) {
		this.salt = options.salt ?? generateSessionSalt();
		this.blocklist = new Set(
			[...DEFAULT_PSEUDONYM_BLOCKLIST, ...(options.blocklist ?? [])]
				.map((v) => v.trim().toLowerCase())
				.filter(Boolean),
		);
		this.disabledKinds = new Set(
			[...(options.disabledKinds ?? [])].map((v) => v.trim()).filter(Boolean),
		);
		this.recognizer = options.recognizer;
		this.minValueLength = options.minValueLength ?? 2;
	}

	/** All learned mappings (real → surrogate), newest last. */
	get entries(): PseudonymEntry[] {
		return [...this.valueToEntry.values()];
	}

	/** Number of distinct entities learned this session. */
	get size(): number {
		return this.valueToEntry.size;
	}

	/** Length of the longest value or surrogate held (0 when empty). */
	get maxTokenLength(): number {
		return this.maxToken;
	}

	/**
	 * Run the configured recognizer over `text` and learn every accepted span.
	 * This is the single async step; call it once per model call on the assembled
	 * prompt text before the (synchronous) substitution passes. Idempotent: text
	 * already learned re-uses existing mappings.
	 */
	async learn(text: string): Promise<void> {
		if (!this.recognizer || !text) return;
		const spans = await this.recognizer.recognize(text);
		this.learnSpans(text, spans);
	}

	/**
	 * Learn a set of pre-computed spans against the `sourceText` they were found
	 * in. Exposed so callers with their own recognizer (or a batch of recognizers)
	 * can drive the vault without this class importing a model.
	 */
	learnSpans(sourceText: string, spans: readonly EntitySpan[]): void {
		if (sourceText) this.corpusLower += `\n${sourceText.toLowerCase()}`;
		// 1. Register every swappable incoming value into the value namespace first,
		//    so both the re-mint check and any new mint below see the full set.
		const incoming: { value: string; kind: string }[] = [];
		for (const span of spans) {
			const value = span.value.trim();
			if (!this.isSwappable(value, span.kind)) continue;
			this.knownValuesLower.add(value.toLowerCase());
			if (!this.valueToEntry.has(value))
				incoming.push({ value, kind: span.kind });
		}
		// 2. Re-mint any existing entry whose surrogate now equals a known value —
		//    the cross-call collision. Snapshot first (remint mutates the maps).
		for (const entry of [...this.valueToEntry.values()]) {
			if (this.knownValuesLower.has(entry.surrogate.toLowerCase())) {
				this.remintEntry(entry);
			}
		}
		// 3. Mint entries for the new values.
		for (const { value, kind } of incoming) this.entryForValue(value, kind);
	}

	/** True when a value/kind pair is eligible for swapping. */
	private isSwappable(value: string, kind: string): boolean {
		if (value.length < this.minValueLength) return false;
		if (this.disabledKinds.has(kind)) return false;
		if (this.blocklist.has(value.toLowerCase())) return false;
		return true;
	}

	/**
	 * Substitute every learned real value in `text` with its surrogate, in a
	 * single boundary-aware pass (see {@link compileReplacer}).
	 */
	substituteText(text: string): string {
		if (!text || this.valueToEntry.size === 0) return text;
		this.ensureReplacers();
		const replacer = this.substituteReplacer;
		if (!replacer) return text;
		replacer.regex.lastIndex = 0;
		return text.replace(replacer.regex, (m) => replacer.map.get(m) ?? m);
	}

	/** Restore every surrogate in `text` back to its real value, single-pass. */
	restoreText(text: string): string {
		if (!text || this.surrogateToEntry.size === 0) return text;
		this.ensureReplacers();
		const replacer = this.restoreReplacer;
		if (!replacer) return text;
		replacer.regex.lastIndex = 0;
		return text.replace(replacer.regex, (m) => replacer.map.get(m) ?? m);
	}

	private ensureReplacers(): void {
		if (!this.replacersDirty) return;
		const entries = [...this.valueToEntry.values()];
		// Substitution is idempotent: the alternation includes every surrogate
		// mapped to ITSELF alongside every value mapped to its surrogate. Ordered
		// longest-first, an already-present surrogate ("Elias Nakamura") is matched
		// and preserved before a real value it happens to embed ("Elias") can be
		// re-swapped — so substituteText(substituteText(x)) === substituteText(x),
		// which the runtime relies on when it substitutes params twice per call
		// (before and after the pre_model hook). Value and surrogate string sets are
		// disjoint (a surrogate is never present in the learned corpus, and every
		// value is), so there is no key collision.
		this.substituteReplacer = compileReplacer([
			...entries.map((e) => ({ from: e.value, to: e.surrogate })),
			...entries.map((e) => ({ from: e.surrogate, to: e.surrogate })),
		]);
		this.restoreReplacer = compileReplacer(
			entries.map((e) => ({ from: e.surrogate, to: e.value })),
		);
		this.replacersDirty = false;
	}

	/** Recursively substitute across strings/arrays/plain objects. */
	substituteInValue<T>(value: T): T {
		return this.walk(value, (s) => this.substituteText(s));
	}

	/** Recursively restore across strings/arrays/plain objects. */
	restoreInValue<T>(value: T): T {
		return this.walk(value, (s) => this.restoreText(s));
	}

	private walk<T>(value: T, transform: (s: string) => string): T {
		if (typeof value === "string") return transform(value) as T;
		if (Array.isArray(value)) {
			return value.map((item) => this.walk(item, transform)) as T;
		}
		if (isPlainObject(value)) {
			const next: Record<string, unknown> = {};
			for (const [key, child] of Object.entries(value)) {
				next[key] = this.walk(child, transform);
			}
			return next as T;
		}
		return value;
	}

	private entryForValue(value: string, kind: string): PseudonymEntry {
		const existing = this.valueToEntry.get(value);
		if (existing) return existing;
		this.knownValuesLower.add(value.toLowerCase());
		const surrogate = this.mintUniqueSurrogate(value, kind);
		const entry: PseudonymEntry = { value, surrogate, kind };
		this.valueToEntry.set(value, entry);
		this.surrogateToEntry.set(surrogate, entry);
		this.usedSurrogatesLower.add(surrogate.toLowerCase());
		this.maxToken = Math.max(this.maxToken, value.length, surrogate.length);
		this.replacersDirty = true;
		return entry;
	}

	/** Replace an entry's surrogate with a fresh one (cross-call collision fix). */
	private remintEntry(entry: PseudonymEntry): void {
		const fresh = this.mintUniqueSurrogate(entry.value, entry.kind);
		if (fresh.toLowerCase() === entry.surrogate.toLowerCase()) return;
		this.surrogateToEntry.delete(entry.surrogate);
		this.usedSurrogatesLower.delete(entry.surrogate.toLowerCase());
		const next: PseudonymEntry = {
			value: entry.value,
			surrogate: fresh,
			kind: entry.kind,
		};
		this.valueToEntry.set(entry.value, next);
		this.surrogateToEntry.set(fresh, next);
		this.usedSurrogatesLower.add(fresh.toLowerCase());
		this.maxToken = Math.max(this.maxToken, fresh.length);
		this.replacersDirty = true;
	}

	/**
	 * Mint a surrogate that is unique within the session and absent from the
	 * learned corpus, probing deterministically on collision. A surrogate is
	 * rejected when it (case-insensitively) equals an already-minted surrogate,
	 * equals any known real value, or already occurs in the corpus text — any of
	 * which would make restore ambiguous or collapse two entities onto one token.
	 */
	private mintUniqueSurrogate(value: string, kind: string): string {
		const valueLower = value.toLowerCase();
		for (let attempt = 0; attempt < 512; attempt += 1) {
			const candidate = mintSurrogate(this.salt, kind, value, attempt);
			const candidateLower = candidate.toLowerCase();
			if (candidateLower === valueLower) continue;
			if (this.usedSurrogatesLower.has(candidateLower)) continue;
			if (this.knownValuesLower.has(candidateLower)) continue;
			if (this.valueToEntry.has(candidate)) continue;
			if (this.corpusLower.includes(candidateLower)) continue;
			return candidate;
		}
		// Exhausted the deterministic space (astronomically unlikely): fall back to
		// a salted, obviously-unique token rather than risk an ambiguous restore.
		return `${mintSurrogate(this.salt, kind, value, 0)} ${fnv1a(`${this.salt}${value}${this.size}`).toString(36)}`;
	}
}
