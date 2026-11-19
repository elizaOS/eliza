/**
 * Session-scoped secret-swap layer that sits between the agent and the model:
 * on ingress it detects secrets/PII in text and structured params and replaces
 * each with a per-session nonce'd placeholder (`__ELIZA_SECRET_<nonce>_<n>__`)
 * so the raw value never reaches the model; on egress it restores the originals
 * at the execution boundary (tool call / outbound request).
 *
 * Ingress draws assignment-style secrets from the shared redaction pattern set
 * (`./log-redaction`) and validated PII/token classes from `./pii-detectors`; explicit credential context admits short values; detected PII uses its own floor.
 *
 * The per-session nonce makes placeholders unforgeable: restore and assertion
 * scope only to THIS session's nonce, and only to references this session has
 * itself written into text. A placeholder-shaped token from user input or model
 * output therefore never resolves to a value the model was not shown, whether
 * it was guessed, counted from a visible reference or kept from an earlier
 * session. A this-session placeholder that does not resolve (e.g. a model that
 * fabricated `…_999__`) can fail loud via SecretSwapUnresolvedPlaceholderError
 * rather than silently leak.
 */
import { ElizaError } from "../errors";
import { BufferUtils } from "../utils/buffer";
import { createHash } from "../utils/crypto-compat";
import { SENSITIVE_TEXT_REGEXPS } from "./log-redaction";
import { detectPii } from "./pii-detectors";
import { isRuntimeAbortSignal } from "./runtime-abort-signal";

export const SECRET_SWAP_ENABLED_SETTING = "ELIZA_SECRET_SWAP_ENABLED";
/**
 * Keeps a value's reference the same in every turn of one conversation, so text
 * an earlier turn sent stays byte-identical and a provider can reuse the prompt
 * prefix. The system prompt then carries the same reference guidance on every
 * request, and the kinds of a request's contact references follow its newest
 * user message. A host turns this on; the default draws a fresh nonce per
 * session and lists the kinds in the system prompt.
 */
export const SECRET_SWAP_STABLE_REFERENCES_SETTING =
	"ELIZA_SECRET_SWAP_STABLE_REFERENCES";
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
	/**
	 * A secret the host holds for one conversation and never shows to anyone.
	 * Sessions that share it mint the same reference for the same value. A
	 * reference seen in an earlier session is then no longer dead text, so it
	 * matters that restore resolves only what this session wrote: replaying one
	 * yields nothing the current request does not already show the model.
	 */
	stableKey?: string;
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
/** A fresh key for stable references. The host keeps it in memory only. */
export function createSecretSwapStableKey(): string {
	return BufferUtils.toHex(BufferUtils.randomBytes(32));
}

function keyedDigest(key: string, value: string): string {
	return createHash("sha256")
		.update(`${key.length}:${key}${value}`)
		.digest("hex");
}

function generateSessionNonce(): string {
	// Fail closed through BufferUtils.randomBytes (the W1-066 policy): a nonce
	// from a predictable Math.random() fallback could be recovered from observed
	// outputs, making placeholders forgeable and re-enabling restore-hijack.
	return BufferUtils.toHex(BufferUtils.randomBytes(8));
}

/** PII kinds the local user may read back in a reply; every other kind stays redacted. */
const USER_READABLE_KINDS: ReadonlySet<string> = new Set([
	"email",
	"phone",
	"ipv4",
	"mac-address",
	"credit-card",
	"ssn",
	"iban",
]);

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
		...collectMatches(decoded, SENSITIVE_TEXT_REGEXPS, exemptValues),
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

/** Only string values are secret-bearing in a complete JSON document. */
function replaceJsonStringValues(
	text: string,
	replace: (value: string) => string,
): string | null {
	const trimmed = text.trimStart();
	if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return null;
	try {
		JSON.parse(text);
	} catch {
		// Unrecognized/malformed data retains the ordinary redaction path.
		return null;
	}
	return text.replace(/"(?:\\[\s\S]|[^"\\])*"/g, (token, offset: number) => {
		// Object keys are protocol structure, not credential values.
		let next = offset + token.length;
		while (next < text.length && /\s/.test(text[next])) next++;
		if (text[next] === ":") return token;
		const value = JSON.parse(token) as string;
		const replaced = replace(value);
		return replaced === value ? token : JSON.stringify(replaced);
	});
}

/** Matches an existing placeholder (kept) or `value` (replaced); compiled once per session value. */
function compileReplacePattern(value: string): RegExp {
	return new RegExp(
		`(${PLACEHOLDER_PATTERN.source})|(?:${valuePattern(value)})`,
		"gu",
	);
}

function replaceValue(
	text: string,
	pattern: RegExp,
	placeholder: string,
): string {
	const replace = (value: string) =>
		value.replace(
			pattern,
			(_match, existingPlaceholder) => existingPlaceholder ?? placeholder,
		);
	const json = replaceJsonStringValues(text, replace);
	if (json !== null) return json;
	// Evaluators also accept fenced JSON. Protect its structure while still
	// redacting surrounding prose; malformed fences keep ordinary redaction.
	const fence = /^```(?:json)?[ \t]*\r?\n([\s\S]*?)^```[ \t]*$/gm;
	let cursor = 0;
	const parts: string[] = [];
	for (const match of text.matchAll(fence)) {
		const body = match[1];
		const replaced = replaceJsonStringValues(body, replace);
		if (replaced === null) continue;
		const bodyStart = match.index + match[0].indexOf("\n") + 1;
		parts.push(replace(text.slice(cursor, bodyStart)), replaced);
		cursor = bodyStart + body.length;
	}
	parts.push(replace(text.slice(cursor)));
	return parts.join("");
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
	mapString: (text: string, key?: string, field?: string) => string,
	key?: string,
	/** The root object's property this value sits under. */
	field?: string,
): unknown {
	if (typeof value === "string") {
		return mapString(value, key, field);
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
					undefined,
					field,
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
				walkSecretSwapValue(
					descriptor.value,
					depth + 1,
					ctx,
					mapString,
					key,
					depth === 0 ? key : field,
				),
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
	/** Numbers already minted, across both prefixes. */
	private readonly numbers = new Set<number>();
	/** References this session has written into text. Only these restore. */
	private readonly shown = new Map<string, SecretSwapEntry>();
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
	private readonly stableKey: string | undefined;
	/** Nonce woven into every placeholder so it is unforgeable: fresh per session, or derived from the conversation's stable key. */
	private readonly nonce: string;
	/** Restores only placeholders minted for this session. Other or absent nonces remain text; unresolved current-session placeholders fail explicitly. */
	private readonly placeholderPattern: RegExp;
	/** Per-value compiled patterns, scoped to the session so secret values never outlive it. */
	private readonly replacePatterns = new Map<string, RegExp>();
	private readonly containsPatterns = new Map<string, RegExp>();

	constructor(options: SecretSwapSessionOptions = {}) {
		this.stableKey = options.stableKey || undefined;
		this.nonce = this.stableKey
			? keyedDigest(this.stableKey, "nonce:").slice(0, 16)
			: generateSessionNonce();
		this.placeholderPattern = new RegExp(
			`__ELIZA_(?:SECRET|CONTACT)_${this.nonce}_\\d+__`,
			"g",
		);
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

	/** True when a value keeps one reference across the conversation's turns. */
	get stable(): boolean {
		return this.stableKey !== undefined;
	}

	/** Hide only this session's protocol references from local NER, preserving offsets.
	 * The model input is unchanged. Unknown current-session references stay opaque
	 * too, so strict execution restoration can reject them rather than a PII alias.
	 */
	maskReferencesForPiiRecognition(text: string): string {
		this.placeholderPattern.lastIndex = 0;
		return text.replace(this.placeholderPattern, (reference) =>
			" ".repeat(reference.length),
		);
	}

	/** Length of the longest value/placeholder held (0 when empty). */
	get maxTokenLength(): number {
		return this.maxToken;
	}

	/**
	 * Learn every secret and PII value in `text` without rewriting it. Returns
	 * the credential capture spans that {@link substituteText} splices first.
	 */
	private learnText(
		text: string,
		/** false: learn no contact data here; a set: learn it, except these values. */
		contacts: boolean | ReadonlySet<string> = true,
	): { value: string; start: number; end: number }[] {
		// 1) Assignment-style secrets (KEY=…, "token":"…", Bearer …, PEM blocks)
		// from the shared redact pattern set — value-extracted, including short values.
		const assignments = [
			...collectEncodedCredentials(text, this.exemptValues),
			...collectUriCredentials(text, this.exemptValues),
			...collectQuotedCredentials(text, this.exemptValues),
			...collectMatches(text, SENSITIVE_TEXT_REGEXPS, this.exemptValues),
		];
		for (const { value } of assignments) {
			this.replyProtectedValues.add(value);
			this.entryForValue(value, "secret");
		}
		// 2) Validated PII / token classes (credit-card+Luhn, email, ssn, iban,
		// jwt, cloud keys, …). Already proven sensitive by their detector, so
		// its own length floor applies; class can be opted out via disabledKinds.
		for (const match of detectPii(text, {
			disabledKinds: this.disabledKinds,
		})) {
			const trimmed = match.value.trim();
			// Authored interface text documents a format with an example; a phone
			// number or address there is not anyone's contact.
			if (
				(match.kind === "email" || match.kind === "phone") &&
				(contacts === false ||
					(typeof contacts === "object" && contacts.has(trimmed)))
			)
				continue;
			if (
				trimmed.length >= MIN_PII_VALUE_LENGTH &&
				!this.exemptValues.has(trimmed) &&
				!trimmed.match(PLACEHOLDER_PATTERN)
			) {
				if (!USER_READABLE_KINDS.has(match.kind))
					this.replyProtectedValues.add(trimmed);
				this.entryForValue(trimmed, match.kind);
			}
		}
		return assignments;
	}

	substituteText(
		text: string,
		contacts: boolean | ReadonlySet<string> = true,
	): string {
		let result = text;
		const assignments = this.learnText(text, contacts);
		// Replace credential capture spans before general known-value matching. This
		// covers short punctuation-only assignments without rewriting JSON syntax.
		let cursor = 0;
		const parts: string[] = [];
		for (const span of assignments.sort(
			(a, b) => a.start - b.start || b.end - a.end,
		)) {
			if (span.start < cursor) continue;
			const entry = this.entryForValue(span.value, "secret");
			this.shown.set(entry.placeholder, entry);
			parts.push(result.slice(cursor, span.start), entry.placeholder);
			cursor = span.end;
		}
		parts.push(result.slice(cursor));
		result = parts.join("");
		return this.replaceKnownValues(result);
	}

	/**
	 * Replace every known value with its placeholder, longest first so a value
	 * that is a substring of another does not corrupt the longer placeholder.
	 */
	private replaceKnownValues(text: string): string {
		let result = text;
		for (const entry of this.entries.sort(
			(a, b) => b.value.length - a.value.length,
		)) {
			let pattern = this.replacePatterns.get(entry.value);
			if (!pattern) {
				pattern = compileReplacePattern(entry.value);
				this.replacePatterns.set(entry.value, pattern);
			}
			const replaced = replaceValue(result, pattern, entry.placeholder);
			if (replaced !== result) this.shown.set(entry.placeholder, entry);
			result = replaced;
		}
		return result;
	}

	private containsValue(text: string, value: string): boolean {
		let pattern = this.containsPatterns.get(value);
		if (!pattern) {
			pattern = new RegExp(valuePattern(value), "u");
			this.containsPatterns.set(value, pattern);
		}
		return pattern.test(text);
	}

	/**
	 * `authoredFields` names properties of the root object that hold authored
	 * interface text, such as a request's tool definitions. Contact data is not
	 * learned from them: an example number in a schema description would become
	 * a reference, change the definition's bytes with every nonce, and be listed
	 * as a contact of the request. A request also carries copies of those
	 * definitions in other fields, so outside `conversationFields` an example
	 * found in the authored fields is not learned either. Credentials are
	 * learned everywhere, a contact that is not such an example is learned
	 * everywhere else, and a value learned anywhere is replaced everywhere.
	 */
	substituteInValue<T>(
		value: T,
		options: {
			authoredFields?: readonly string[];
			conversationFields?: readonly string[];
		} = {},
	): T {
		const authored = new Set(options.authoredFields ?? []);
		const conversation = new Set(options.conversationFields ?? []);
		const examples = new Set<string>();
		if (authored.size)
			walkSecretSwapValue(
				value,
				0,
				createSecretSwapWalkContext(),
				(text, _key, field) => {
					if (field !== undefined && authored.has(field))
						for (const match of detectPii(text, {
							disabledKinds: this.disabledKinds,
						}))
							if (match.kind === "email" || match.kind === "phone")
								examples.add(match.value.trim());
					return text;
				},
			);
		const contacts = (field?: string) =>
			field !== undefined && authored.has(field)
				? false
				: examples.size && (field === undefined || !conversation.has(field))
					? examples
					: true;
		// Snapshot descriptors and learn the entire graph before replacement, so
		// a credential discovered in a later field protects earlier references too.
		const snapshot = walkSecretSwapValue(
			value,
			0,
			createSecretSwapWalkContext(),
			(text, key, field) => {
				if (
					key &&
					isCredentialField(key) &&
					shouldSwapValue(text, this.exemptValues)
				) {
					this.replyProtectedValues.add(text);
					this.entryForValue(text, "secret");
				}
				this.learnText(text, contacts(field));
				return text;
			},
		);
		return walkSecretSwapValue(
			snapshot,
			0,
			createSecretSwapWalkContext(),
			(text, _key, field) => this.substituteText(text, contacts(field)),
		) as T;
	}

	/** Restore personal data only at the local user-reply boundary, never credentials. */
	restoreUserReplyText(text: string): string {
		this.placeholderPattern.lastIndex = 0;
		return text.replace(this.placeholderPattern, (placeholder) => {
			const entry = this.shown.get(placeholder);
			if (
				!entry ||
				!USER_READABLE_KINDS.has(entry.kind) ||
				this.isReplyProtected(entry.value)
			)
				return "[redacted credential]";
			return entry.value;
		});
	}

	/**
	 * Apply the user-reply policy to text whose values were already restored
	 * (tool-call sends: the execution boundary restores handler args). Known
	 * values go back to placeholders, then {@link restoreUserReplyText} decides
	 * what stays readable, so both reply paths share one policy.
	 */
	redactRestoredSecretValues(text: string): string {
		return this.restoreUserReplyText(this.replaceKnownValues(text));
	}

	/** True when `value` overlaps (either contains or is contained in) a reply-protected value. */
	private isReplyProtected(value: string): boolean {
		for (const protectedValue of this.replyProtectedValues) {
			if (
				this.containsValue(protectedValue, value) ||
				this.containsValue(value, protectedValue)
			)
				return true;
		}
		return false;
	}

	restoreText(
		text: string,
		options: { failOnUnresolved?: boolean } = {},
	): string {
		const unresolved = new Set<string>();
		this.placeholderPattern.lastIndex = 0;
		const restored = text.replace(this.placeholderPattern, (placeholder) => {
			const entry = this.shown.get(placeholder);
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
			.filter((placeholder) => !this.shown.has(placeholder))
			.sort();
		if (placeholders.length > 0) {
			throw new SecretSwapUnresolvedPlaceholderError(placeholders);
		}
	}

	private entryForValue(value: string, kind: string): SecretSwapEntry {
		const existing = this.valueToEntry.get(value);
		if (existing) return existing;
		const prefix = `${(kind === "email" || kind === "phone") && !this.replyProtectedValues.has(value) ? CONTACT_PLACEHOLDER_PREFIX : PLACEHOLDER_PREFIX}${this.nonce}_`;
		// A stable reference is numbered from its value, not from the order the
		// session met it: a growing conversation must not renumber earlier text.
		// Twelve digits keep two values of one conversation from sharing a number,
		// so a reference means the same value in every session or nothing.
		let index = this.stableKey
			? Number.parseInt(
					keyedDigest(this.stableKey, `value:${value}`).slice(0, 12),
					16,
				) % 1_000_000_000_000
			: this.valueToEntry.size + 1;
		while (this.numbers.has(index)) index++;
		this.numbers.add(index);
		const entry = { placeholder: `${prefix}${index}__`, value, kind };
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
