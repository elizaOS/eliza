/**
 * Session-scoped secret-swap layer that sits between the agent and the model:
 * on ingress it detects secrets/PII in text and structured params and replaces
 * each with a per-session nonce'd placeholder (`__ELIZA_SECRET_<nonce>_<n>__`)
 * so the raw value never reaches the model; on egress it restores the originals
 * at the execution boundary (tool call / outbound request).
 *
 * Ingress draws assignment-style secrets from the shared redact pattern set
 * (`./redact`) and validated PII/token classes from `./pii-detectors`; explicit credential context admits short values; detected PII uses its own floor.
 *
 * The per-session nonce makes placeholders unforgeable: restore and assertion
 * scope only to THIS session's nonce, so a placeholder-shaped token from user
 * input or model output can never resolve to a real secret. A this-session
 * placeholder that should resolve but does not (e.g. a model that fabricated
 * `…_999__`) can fail loud via SecretSwapUnresolvedPlaceholderError rather than
 * silently leak.
 */
import { ElizaError } from "../errors";
import { BufferUtils } from "../utils/buffer";
import { detectPii } from "./pii-detectors";
import { getDefaultRedactPatterns } from "./redact";
import { isRuntimeAbortSignal } from "./runtime-abort-signal";

export const SECRET_SWAP_ENABLED_SETTING = "ELIZA_SECRET_SWAP_ENABLED";
export const SECRET_SWAP_EXEMPT_VALUES_SETTING =
	"ELIZA_SECRET_SWAP_EXEMPT_VALUES";

/**
 * Honest model-param graphs are a handful of objects deep. JSON.parse still
 * admits a 20k-deep nest that then RangeError'd `substituteInValue` on
 * origin develop.
 */
export const MAX_SECRET_SWAP_WALK_DEPTH = 64;
export const MAX_SECRET_SWAP_WALK_NODES = 100_000;
export const SECRET_SWAP_UNBOUNDED = "SECRET_SWAP_UNBOUNDED";

type SecretSwapWalkContext = {
	visits: number;
	visiting: WeakSet<object>;
};

function failSecretSwapUnbounded(
	context: Record<string, unknown>,
	cause?: unknown,
): never {
	throw new ElizaError("Secret-swap value exceeds the walk budget", {
		code: SECRET_SWAP_UNBOUNDED,
		cause,
		context,
		severity: "fatal",
	});
}

export function isSecretSwapUnbounded(error: unknown): boolean {
	return error instanceof ElizaError && error.code === SECRET_SWAP_UNBOUNDED;
}

function inspectSwap<T>(operation: string, inspect: () => T): T {
	try {
		return inspect();
	} catch (cause) {
		// error-policy:J2 Proxy inspection failures wrap with cause as unbounded.
		failSecretSwapUnbounded({ inspection: operation }, cause);
	}
}

export class SecretSwapUnresolvedPlaceholderError extends Error {
	readonly placeholders: string[];

	constructor(placeholders: string[]) {
		super(`Unresolved secret placeholder(s): ${placeholders.join(", ")}`);
		this.name = "SecretSwapUnresolvedPlaceholderError";
		this.placeholders = placeholders;
	}
}

export type SecretSwapEntry = {
	placeholder: string;
	value: string;
	kind: string;
};

export type SecretSwapSessionOptions = {
	knownSecrets?: Record<string, string | undefined>;
	exemptValues?: Iterable<string>;
	/**
	 * PII/token detector classes to disable (false-positive opt-out by class,
	 * e.g. `["phone", "ipv4"]`). Complements `exemptValues` (opt-out by value).
	 */
	disabledKinds?: Iterable<string>;
};

const SHORT_SWAP_VALUE_LENGTH = 8;
/** Validated PII spans (email, card, SSN, …) swap even when short — the detector
 * already proved they are sensitive. */
const MIN_PII_VALUE_LENGTH = 4;
const PLACEHOLDER_PREFIX = "__ELIZA_SECRET_";
// Contact references are data to preserve, not credentials to omit.
const CONTACT_PLACEHOLDER_PREFIX = "__ELIZA_CONTACT_";
/** Recognizes placeholder-shaped text to avoid swapping it twice. Restoration accepts only this session’s nonce, so input cannot forge a reference to a real secret. */
const PLACEHOLDER_PATTERN =
	/__ELIZA_(?:SECRET|CONTACT)_(?:[0-9a-f]{8,}_)?\d+__/g;

/**
 * A per-session random nonce woven into every placeholder
 * (`__ELIZA_SECRET_<nonce>_<n>__`). Without it, a user message or model output
 * could contain a literal `__ELIZA_SECRET_1__` that collides with a real
 * mapping, hijacking restore to leak the secret into an unintended position —
 * the nonce makes placeholders unforgeable and unguessable per turn.
 */
function generateSessionNonce(): string {
	// Fail closed through BufferUtils.randomBytes (the W1-066 policy): a nonce
	// from a predictable Math.random() fallback could be recovered from observed
	// outputs, making placeholders forgeable and re-enabling restore-hijack.
	const bytes = BufferUtils.randomBytes(8);
	return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

function parsePattern(raw: string): RegExp | null {
	if (!raw.trim()) return null;
	const match = raw.match(/^\/(.+)\/([gimsuy]*)$/);
	try {
		if (match) {
			const flags = match[2].includes("g") ? match[2] : `${match[2]}g`;
			return new RegExp(match[1], flags);
		}
		return new RegExp(raw, "gi");
	} catch {
		// error-policy:J3 custom patterns are untrusted configuration; an invalid
		// expression is excluded from the compiled detector set.
		return null;
	}
}

const SECRET_PATTERNS: readonly RegExp[] = getDefaultRedactPatterns()
	.map(parsePattern)
	.filter((pattern): pattern is RegExp => Boolean(pattern));

function shouldSwapValue(
	value: string,
	exemptValues: ReadonlySet<string>,
): boolean {
	const trimmed = value.trim();
	return (
		trimmed.length > 0 &&
		!exemptValues.has(trimmed) &&
		!trimmed.match(PLACEHOLDER_PATTERN)
	);
}

function extractToken(match: string, groups: readonly unknown[]): string {
	const stringGroups = groups.filter(
		(group): group is string => typeof group === "string" && group.length > 0,
	);
	return stringGroups[stringGroups.length - 1] ?? match;
}

function collectMatches(
	text: string,
	patterns: readonly RegExp[],
	exemptValues: ReadonlySet<string>,
): { value: string; start: number; end: number }[] {
	const values: { value: string; start: number; end: number }[] = [];
	for (const pattern of patterns) {
		pattern.lastIndex = 0;
		for (const match of text.matchAll(pattern)) {
			const token = extractToken(match[0], match.slice(1));
			if (!/^[[{]+$/.test(token) && shouldSwapValue(token, exemptValues)) {
				const start = match.index + match[0].lastIndexOf(token);
				values.push({ value: token, start, end: start + token.length });
			}
		}
	}
	return values;
}

// Unlike log masking, model data must distinguish credentials from schema/AST
// metadata such as `key`, `tokenId`, and budget fields. Never classify those by suffix.
function isCredentialField(key: string): boolean {
	return /^(?:password|passwd|passphrase|mnemonic|seedphrase|credential|secret|token|apikey|accesstoken|refreshtoken|authtoken|bottoken|sessionkey|privatekey|clientsecret|authorization|cookie)$/.test(
		key.toLowerCase().replace(/[_ .-]/g, ""),
	);
}

// Parse a whole quoted assignment before the generic token patterns. Escaped
// quotes and spaces belong to the credential, not to unprotected trailing text.
function collectQuotedCredentials(
	text: string,
	exemptValues: ReadonlySet<string>,
) {
	const spans: { value: string; start: number; end: number }[] = [];
	const pattern =
		/(?:"([^"\r\n]+)"|'([^'\r\n]+)'|\b([A-Za-z][A-Za-z0-9_.-]*))\s*[:=]\s*(?:"((?:\\[\s\S]|[^"\\])*)"|'((?:\\[\s\S]|[^'\\])*)')/g;
	for (let match = pattern.exec(text); match; match = pattern.exec(text)) {
		const key = match[1] ?? match[2] ?? match[3];
		const value = match[4] ?? match[5];
		// A noncredential wrapper such as `text` may itself contain a quoted
		// credential. Resume inside it instead of consuming the whole value.
		if (!isCredentialField(key)) {
			pattern.lastIndex = match.index + 1;
			continue;
		}
		if (!shouldSwapValue(value, exemptValues)) continue;
		const end = match.index + match[0].length - 1;
		spans.push({ value, start: end - value.length, end });
	}
	return spans;
}

// Bound userinfo to one URI authority and use its final @ separator. A
// literal @ inside a password must not leave a suffix exposed; /, query,
// fragment, whitespace and prose delimiters cannot extend the authority.
function collectUriCredentials(
	text: string,
	exemptValues: ReadonlySet<string>,
) {
	const spans: { value: string; start: number; end: number }[] = [];
	const pattern = /\b[a-z][a-z0-9+.-]*:\/\/([^\s/?#\\<>"']+)/gi;
	for (const match of text.matchAll(pattern)) {
		const authority = match[1],
			separator = authority.lastIndexOf("@");
		if (separator <= 0 || separator === authority.length - 1) continue;
		const value = authority.slice(0, separator);
		if (!shouldSwapValue(value, exemptValues)) continue;
		const start = match.index + match[0].length - authority.length;
		spans.push({ value, start, end: start + value.length });
	}
	return spans;
}

// Prompt templates may contain whole JSON strings or escaped JSON fragments.
// Decode only valid JSON escapes for detection, then map spans back to exact
// original bytes so restoration never changes the caller's representation.
function collectEncodedCredentials(
	text: string,
	exemptValues: ReadonlySet<string>,
	depth = 0,
) {
	const spans: { value: string; start: number; end: number }[] = [];
	if (!text.includes("\\")) return spans;
	const starts: number[] = [],
		ends: number[] = [],
		pieces: string[] = [];
	const escapes: Record<string, string> = {
		'"': '"',
		"\\": "\\",
		"/": "/",
		b: "\b",
		f: "\f",
		n: "\n",
		r: "\r",
		t: "\t",
	};
	for (let i = 0; i < text.length; ) {
		const start = i;
		let decoded = text[i++];
		if (decoded === "\\") {
			const next = text[i];
			if (Object.hasOwn(escapes, next)) {
				decoded = escapes[next];
				i++;
			} else if (
				next === "u" &&
				/^[0-9a-f]{4}$/i.test(text.slice(i + 1, i + 5))
			) {
				decoded = String.fromCharCode(
					Number.parseInt(text.slice(i + 1, i + 5), 16),
				);
				i += 5;
			}
		}
		pieces.push(decoded);
		starts.push(start);
		ends.push(i);
	}
	const decoded = pieces.join("");
	if (decoded === text) return spans;
	if (depth >= 8)
		failSecretSwapUnbounded({ inspection: "encoded credential depth", depth });
	const decodedSpans = [
		...collectUriCredentials(decoded, exemptValues),
		...collectQuotedCredentials(decoded, exemptValues),
		...collectMatches(decoded, SECRET_PATTERNS, exemptValues),
		...collectEncodedCredentials(decoded, exemptValues, depth + 1),
	];
	for (const span of decodedSpans) {
		const start = starts[span.start],
			end = ends[span.end - 1];
		if (start === undefined || end === undefined) continue;
		const value = text.slice(start, end);
		if (shouldSwapValue(value, exemptValues)) spans.push({ value, start, end });
	}
	return spans;
}

// Short values must not replace fragments of words, JSON syntax, or opaque handles.
function valuePattern(value: string): string {
	const escaped = value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	if (value.length >= SHORT_SWAP_VALUE_LENGTH) return escaped;
	return /[\p{L}\p{N}_]/u.test(value)
		? `(?<![\\p{L}\\p{N}_])${escaped}(?![\\p{L}\\p{N}_])`
		: `(?<!\\S)${escaped}(?!\\S)`;
}

function replaceValue(text: string, entry: SecretSwapEntry): string {
	const pattern = new RegExp(
		`(${PLACEHOLDER_PATTERN.source})|(?:${valuePattern(entry.value)})`,
		"gu",
	);
	return text.replace(
		pattern,
		(_match, existingPlaceholder) => existingPlaceholder ?? entry.placeholder,
	);
}

function containsValue(text: string, value: string): boolean {
	return new RegExp(valuePattern(value), "u").test(text);
}

function createSecretSwapWalkContext(): SecretSwapWalkContext {
	return { visits: 0, visiting: new WeakSet<object>() };
}

function reserveSecretSwapVisits(ctx: SecretSwapWalkContext, count = 1): void {
	if (
		!Number.isSafeInteger(count) ||
		count < 0 ||
		count > MAX_SECRET_SWAP_WALK_NODES - ctx.visits
	) {
		failSecretSwapUnbounded({
			visits: ctx.visits,
			requestedVisits: count,
			maxNodes: MAX_SECRET_SWAP_WALK_NODES,
		});
	}
	ctx.visits += count;
}

function ownValueDescriptor(
	value: object,
	key: string | number,
): PropertyDescriptor | undefined {
	const descriptor = inspectSwap("getOwnPropertyDescriptor", () =>
		Object.getOwnPropertyDescriptor(value, key),
	);
	if (!descriptor) return undefined;
	if (!("value" in descriptor)) {
		failSecretSwapUnbounded({
			accessor: true,
			numericKey: typeof key === "number",
		});
	}
	return descriptor;
}

function isSecretSwapArray(value: object): boolean {
	return inspectSwap("isArray", () => Array.isArray(value));
}

function ownArrayLength(value: object): number {
	const descriptor = inspectSwap("getOwnPropertyDescriptor", () =>
		Object.getOwnPropertyDescriptor(value, "length"),
	);
	if (
		!descriptor ||
		!("value" in descriptor) ||
		typeof descriptor.value !== "number" ||
		!Number.isSafeInteger(descriptor.value) ||
		descriptor.value < 0
	) {
		failSecretSwapUnbounded({ invalidArrayLength: true });
	}
	return descriptor.value;
}

function defineSecretSwapValue(
	target: Record<string, unknown>,
	key: string,
	value: unknown,
): void {
	Object.defineProperty(target, key, {
		configurable: true,
		enumerable: true,
		value,
		writable: true,
	});
}

function walkSecretSwapValue(
	value: unknown,
	depth: number,
	ctx: SecretSwapWalkContext,
	mapString: (text: string, key?: string) => string,
	key?: string,
): unknown {
	if (typeof value === "string") {
		return mapString(value, key);
	}
	if (value === null || typeof value !== "object") {
		return value;
	}
	// Preserve a clean native cancellation signal, never control-shaped payload data.
	if (isRuntimeAbortSignal(value)) {
		return value;
	}
	if (depth > MAX_SECRET_SWAP_WALK_DEPTH) {
		failSecretSwapUnbounded({
			depth,
			maxDepth: MAX_SECRET_SWAP_WALK_DEPTH,
		});
	}
	if (ctx.visiting.has(value)) {
		failSecretSwapUnbounded({ cycle: true });
	}
	reserveSecretSwapVisits(ctx);
	ctx.visiting.add(value);
	try {
		if (isSecretSwapArray(value)) {
			const size = ownArrayLength(value);
			// Reserve every logical slot before scanning descriptors or allocating the
			// output. Sparse arrays otherwise bypass a per-value visit counter.
			reserveSecretSwapVisits(ctx, size);
			const next = new Array<unknown>(size);
			for (let index = 0; index < size; index += 1) {
				const descriptor = ownValueDescriptor(value, index);
				if (!descriptor) continue;
				next[index] = walkSecretSwapValue(
					descriptor.value,
					depth + 1,
					ctx,
					mapString,
				);
			}
			return next;
		}
		// Deliberately normalize every non-array object from its own enumerable
		// data descriptors. The pre-boundary implementation used Object.entries
		// for this whole class, so limiting the safe walk to Object.prototype
		// records would let null-prototype dictionaries and class/custom-prototype
		// data records carry unswapped secrets to providers. Do not reflect the
		// prototype: it is irrelevant to the wire value and may itself be a hostile
		// Proxy trap. Reconstructing a plain data record preserves the established
		// boundary behavior without executing getters or inherited properties.
		const next: Record<string, unknown> = {};
		const keys = inspectSwap("ownKeys", () => Reflect.ownKeys(value));
		// Charge reflection work up front, including symbols and non-enumerable
		// keys that still require inspection before they can be skipped.
		reserveSecretSwapVisits(ctx, keys.length);
		for (const key of keys) {
			if (typeof key !== "string") continue;
			const descriptor = inspectSwap("getOwnPropertyDescriptor", () =>
				Object.getOwnPropertyDescriptor(value, key),
			);
			if (!descriptor?.enumerable) continue;
			if (!("value" in descriptor)) {
				failSecretSwapUnbounded({ accessor: true });
			}
			defineSecretSwapValue(
				next,
				key,
				walkSecretSwapValue(descriptor.value, depth + 1, ctx, mapString, key),
			);
		}
		return next;
	} finally {
		ctx.visiting.delete(value);
	}
}

export class SecretSwapSession {
	private readonly replyProtectedValues = new Set<string>();
	private readonly valueToEntry = new Map<string, SecretSwapEntry>();
	private readonly placeholderToEntry = new Map<string, SecretSwapEntry>();
	private readonly exemptValues: ReadonlySet<string>;
	private readonly disabledKinds: ReadonlySet<string>;
	/**
	 * Longest token (secret value or minted placeholder) the session holds,
	 * maintained incrementally as entries are added. The streaming guard
	 * ({@link./guarded-stream}) reads this to size its carry-over window: a known
	 * secret that arrives split across two chunks must be held whole, so the guard
	 * never emits a chunk shorter than the longest value it might straddle.
	 */
	private maxToken = 0;
	/** Per-session nonce woven into every placeholder so it is unforgeable. */
	private readonly nonce = generateSessionNonce();
	/** Restores only placeholders minted for this session. Other or absent nonces remain text; unresolved current-session placeholders fail explicitly. */
	private readonly placeholderPattern = new RegExp(
		`__ELIZA_(?:SECRET|CONTACT)_${this.nonce}_\\d+__`,
		"g",
	);

	constructor(options: SecretSwapSessionOptions = {}) {
		this.exemptValues = new Set(
			[...(options.exemptValues ?? [])]
				.map((value) => value.trim())
				.filter(Boolean),
		);
		this.disabledKinds = new Set(
			[...(options.disabledKinds ?? [])]
				.map((value) => value.trim())
				.filter(Boolean),
		);
		for (const [name, value] of Object.entries(options.knownSecrets ?? {})) {
			if (
				typeof value === "string" &&
				shouldSwapValue(value, this.exemptValues)
			) {
				this.replyProtectedValues.add(value);
				this.entryForValue(value, name);
			}
		}
	}

	get entries(): SecretSwapEntry[] {
		return [...this.valueToEntry.values()];
	}

	/** Length of the longest value/placeholder held (0 when empty). */
	get maxTokenLength(): number {
		return this.maxToken;
	}

	substituteText(text: string): string {
		let result = text;
		// 1) Assignment-style secrets (KEY=…, "token":"…", Bearer …, PEM blocks)
		// from the shared redact pattern set — value-extracted, including short values.
		const assignments = [
			...collectEncodedCredentials(result, this.exemptValues),
			...collectUriCredentials(result, this.exemptValues),
			...collectQuotedCredentials(result, this.exemptValues),
			...collectMatches(result, SECRET_PATTERNS, this.exemptValues),
		];
		for (const { value } of assignments) {
			this.replyProtectedValues.add(value);
			this.entryForValue(value, "secret");
		}
		// 2) Validated PII / token classes (credit-card+Luhn, email, ssn, iban,
		// jwt, cloud keys, …). Already proven sensitive by their detector, so
		// its own length floor applies; class can be opted out via disabledKinds.
		for (const match of detectPii(result, {
			disabledKinds: this.disabledKinds,
		})) {
			const trimmed = match.value.trim();
			if (
				trimmed.length >= MIN_PII_VALUE_LENGTH &&
				!this.exemptValues.has(trimmed) &&
				!trimmed.match(PLACEHOLDER_PATTERN)
			) {
				if (
					![
						"email",
						"phone",
						"ipv4",
						"mac-address",
						"credit-card",
						"ssn",
						"iban",
					].includes(match.kind)
				)
					this.replyProtectedValues.add(trimmed);
				this.entryForValue(trimmed, match.kind);
			}
		}
		// Replace credential capture spans before general known-value matching. This
		// covers short punctuation-only assignments without rewriting JSON syntax.
		let cursor = 0;
		const parts: string[] = [];
		for (const span of assignments.sort(
			(a, b) => a.start - b.start || b.end - a.end,
		)) {
			if (span.start < cursor) continue;
			parts.push(
				result.slice(cursor, span.start),
				this.entryForValue(span.value, "secret").placeholder,
			);
			cursor = span.end;
		}
		parts.push(result.slice(cursor));
		result = parts.join("");
		// Replace longest-first so a value that is a substring of another does not
		// corrupt the longer placeholder.
		for (const entry of this.entries.sort(
			(a, b) => b.value.length - a.value.length,
		)) {
			result = replaceValue(result, entry);
		}
		return result;
	}

	substituteInValue<T>(value: T): T {
		// Snapshot descriptors and learn the entire graph before replacement, so
		// a credential discovered in a later field protects earlier references too.
		const snapshot = walkSecretSwapValue(
			value,
			0,
			createSecretSwapWalkContext(),
			(text, key) => {
				if (
					key &&
					isCredentialField(key) &&
					shouldSwapValue(text, this.exemptValues)
				) {
					this.replyProtectedValues.add(text);
					this.entryForValue(text, "secret");
				}
				this.substituteText(text);
				return text;
			},
		);
		return walkSecretSwapValue(
			snapshot,
			0,
			createSecretSwapWalkContext(),
			(text) => this.substituteText(text),
		) as T;
	}

	/** Restore personal data only at the local user-reply boundary, never credentials. */
	restoreUserReplyText(text: string): string {
		this.placeholderPattern.lastIndex = 0;
		return text.replace(this.placeholderPattern, (placeholder) => {
			const entry = this.placeholderToEntry.get(placeholder);
			if (
				!entry ||
				[...this.replyProtectedValues].some(
					(value) =>
						containsValue(value, entry.value) ||
						containsValue(entry.value, value),
				)
			)
				return "[redacted credential]";
			return [
				"email",
				"phone",
				"ipv4",
				"mac-address",
				"credit-card",
				"ssn",
				"iban",
			].includes(entry.kind)
				? entry.value
				: "[redacted credential]";
		});
	}

	restoreText(
		text: string,
		options: { failOnUnresolved?: boolean } = {},
	): string {
		const unresolved = new Set<string>();
		this.placeholderPattern.lastIndex = 0;
		const restored = text.replace(this.placeholderPattern, (placeholder) => {
			const entry = this.placeholderToEntry.get(placeholder);
			if (!entry) {
				unresolved.add(placeholder);
				return placeholder;
			}
			return entry.value;
		});
		if (options.failOnUnresolved && unresolved.size > 0) {
			throw new SecretSwapUnresolvedPlaceholderError([...unresolved].sort());
		}
		return restored;
	}

	restoreInValue<T>(value: T, options: { failOnUnresolved?: boolean } = {}): T {
		return walkSecretSwapValue(
			value,
			0,
			createSecretSwapWalkContext(),
			(text) => this.restoreText(text, options),
		) as T;
	}

	assertNoUnresolvedPlaceholders(value: unknown): void {
		const serialized =
			typeof value === "string" ? value : JSON.stringify(value);
		this.placeholderPattern.lastIndex = 0;
		const placeholders = [
			...new Set(serialized.match(this.placeholderPattern) ?? []),
		]
			.filter((placeholder) => !this.placeholderToEntry.has(placeholder))
			.sort();
		if (placeholders.length > 0) {
			throw new SecretSwapUnresolvedPlaceholderError(placeholders);
		}
	}

	private entryForValue(value: string, kind: string): SecretSwapEntry {
		const existing = this.valueToEntry.get(value);
		if (existing) return existing;
		const entry = {
			placeholder: `${(kind === "email" || kind === "phone") && !this.replyProtectedValues.has(value) ? CONTACT_PLACEHOLDER_PREFIX : PLACEHOLDER_PREFIX}${this.nonce}_${this.valueToEntry.size + 1}__`,
			value,
			kind,
		};
		this.valueToEntry.set(value, entry);
		this.placeholderToEntry.set(entry.placeholder, entry);
		this.maxToken = Math.max(
			this.maxToken,
			entry.value.length,
			entry.placeholder.length,
		);
		return entry;
	}
}

export function parseSecretSwapExemptValues(value: unknown): string[] {
	if (typeof value !== "string") return [];
	return value
		.split(",")
		.map((part) => part.trim())
		.filter(Boolean);
}
