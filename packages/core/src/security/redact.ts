import {
	SENSITIVE_TEXT_PATTERNS as DEFAULT_REDACT_PATTERNS,
	isSensitiveLogKey,
} from "@elizaos/shared/log-redaction";
import {
	toWellFormedUnicode,
	truncateWellFormed,
} from "../utils/well-formed.ts";
/** Masks credential patterns and configured character secrets before logging or display. */

/**
 * Mode for sensitive text redaction.
 * - "off": No redaction
 * - "tools": Redact in tool outputs
 */
export type RedactSensitiveMode = "off" | "tools";

const DEFAULT_REDACT_MODE: RedactSensitiveMode = "tools";
const DEFAULT_REDACT_MIN_LENGTH = 18;
const DEFAULT_REDACT_KEEP_START = 6;
const DEFAULT_REDACT_KEEP_END = 4;

// Minimum length for a secret to be considered for redaction
// Shorter values could cause false positives
export const MIN_SECRET_LENGTH = 8;
/** Shared credential-name policy used by model and log redaction. */
export function isSensitiveKeyName(key: string): boolean {
	return isSensitiveLogKey(key);
}

/**
 * Options for redacting sensitive text.
 */
export type RedactOptions = {
	/** Redaction mode */
	mode?: RedactSensitiveMode;
	/** Custom patterns to match (in addition to or instead of defaults) */
	patterns?: string[];
};

/**
 * Options for secrets-based redaction.
 */
export type SecretsRedactOptions = {
	/** Known secrets to redact (key -> secret value) */
	secrets?: Record<string, string>;
	/** Whether to also apply pattern-based redaction */
	applyPatterns?: boolean;
};

function normalizeMode(value?: string): RedactSensitiveMode {
	return value === "off" ? "off" : DEFAULT_REDACT_MODE;
}

function parsePattern(raw: string): RegExp | null {
	if (!raw.trim()) {
		return null;
	}
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

// Compiled once at module load. The default patterns never change, and
// String.prototype.replace resets a global regex's lastIndex before each call,
// so the same compiled array is safe to reuse across every redaction — no need
// to allocate 16 fresh RegExp objects per call.
const DEFAULT_REDACT_REGEXPS: readonly RegExp[] = DEFAULT_REDACT_PATTERNS.map(
	parsePattern,
).filter((re): re is RegExp => Boolean(re));

function resolvePatterns(value?: string[]): readonly RegExp[] {
	if (!value?.length) {
		return DEFAULT_REDACT_REGEXPS;
	}
	return value.map(parsePattern).filter((re): re is RegExp => Boolean(re));
}

function maskToken(tokenInput: string): string {
	const token = toWellFormedUnicode(tokenInput);
	if (token.length < DEFAULT_REDACT_MIN_LENGTH) {
		return "***";
	}
	const start = truncateWellFormed(token, DEFAULT_REDACT_KEEP_START);
	let tailStart = token.length - DEFAULT_REDACT_KEEP_END;
	if (
		tailStart > 0 &&
		token.charCodeAt(tailStart - 1) >= 0xd800 &&
		token.charCodeAt(tailStart - 1) <= 0xdbff &&
		token.charCodeAt(tailStart) >= 0xdc00 &&
		token.charCodeAt(tailStart) <= 0xdfff
	) {
		tailStart += 1;
	}
	const end = token.slice(tailStart);
	return `${start}…${end}`;
}

function redactPemBlock(block: string): string {
	const lines = block.split(/\r?\n/).filter(Boolean);
	if (lines.length < 2) {
		return "***";
	}
	return `${lines[0]}\n…redacted…\n${lines[lines.length - 1]}`;
}

function redactMatch(match: string, groups: string[]): string {
	if (match.includes("PRIVATE KEY-----")) {
		return redactPemBlock(match);
	}
	const filteredGroups = groups.filter(
		(value) => typeof value === "string" && value.length > 0,
	);
	const token = filteredGroups[filteredGroups.length - 1] ?? match;
	// Unlike provider tokens, URI userinfo includes an account identifier; do
	// not preserve its usual six-character prefix in diagnostics.
	// Anchor the rewrite to the userinfo span. A plain `replace(token, …)` hits
	// the FIRST occurrence of the userinfo substring, which for a short user
	// name is usually inside the scheme itself ("https://s@h" would become
	// "http***://s@h" and leak the credential verbatim).
	//
	// Known residual: `[^\s/@]+` cannot cross an `@`, so a password containing a
	// literal `@` ("https://user:p@ss@host") only masks up to the first `@` and
	// leaves the tail ("ss@host") in the output. Widening the userinfo class
	// would make the pattern swallow unrelated text after a bare scheme, so the
	// partial mask is deliberate.
	if (/^[a-z][a-z0-9+.-]*:\/\//i.test(match) && match.endsWith("@")) {
		return match.replace(/^([a-z][a-z0-9+.-]*:\/\/)[^\s/@]+@$/i, "$1***@");
	}
	const masked = maskToken(token);
	if (token === match) {
		return masked;
	}
	// Credential patterns capture the secret remainder at the match tail. A
	// first-occurrence replace is unsafe when the same bytes occur earlier in
	// the scheme/prefix, so splice the known tail position directly.
	const tailIndex = match.length - token.length;
	if (tailIndex > 0 && match.startsWith(token, tailIndex)) {
		const head = truncateWellFormed(toWellFormedUnicode(match), tailIndex);
		return `${head}${masked}`;
	}
	// Use a replacer function so `masked` is inserted literally. `masked` keeps
	// the token's first/last characters verbatim, and String.replace treats a
	// replacement STRING's `$&` / `$'` / "$`" / `$$` as special patterns — a
	// secret starting with `ab$&…` would re-expand `$&` to the whole matched
	// token, leaking the full secret back into the "redacted" output.
	return match.replace(token, () => masked);
}

function redactText(text: string, patterns: readonly RegExp[]): string {
	let next = text;
	for (const pattern of patterns) {
		next = next.replace(pattern, (...args: string[]) =>
			redactMatch(args[0], args.slice(1, args.length - 2)),
		);
	}
	return next;
}

/**
 * Redact sensitive information from text.
 *
 * @param text - The text to redact
 * @param options - Redaction options
 * @returns Text with sensitive data masked
 */
export function redactSensitiveText(
	text: string,
	options?: RedactOptions,
): string {
	if (!text) {
		return text;
	}
	const resolved = options ?? { mode: DEFAULT_REDACT_MODE };
	if (normalizeMode(resolved.mode) === "off") {
		return text;
	}
	const patterns = resolvePatterns(resolved.patterns);
	if (!patterns.length) {
		return text;
	}
	return redactText(text, patterns);
}

/**
 * Redact sensitive information from tool output detail.
 *
 * Only redacts when mode is "tools" (the default).
 *
 * @param detail - The tool detail to redact
 * @returns Redacted detail
 */
export function redactToolDetail(detail: string): string {
	return redactSensitiveText(detail, { mode: "tools" });
}

/**
 * Get the default redaction patterns.
 *
 * @returns Copy of default pattern strings
 */
export function getDefaultRedactPatterns(): string[] {
	return [...DEFAULT_REDACT_PATTERNS];
}

// ============================================================================
// Secrets-Based Redaction
// ============================================================================

/**
 * Escape special regex characters in a string.
 */
function escapeRegex(str: string): string {
	return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Per-secret compiled regexes. Secret values are stable within a character
// config and small in number; caching avoids recompiling the same escaped
// RegExp on every redaction call (redactSecrets runs 3+× per composeState).
// Bounded so runtime secret rotation can't grow it without limit.
const SECRET_REGEX_CACHE = new Map<string, RegExp>();
const SECRET_REGEX_CACHE_LIMIT = 256;

function getSecretRegex(value: string): RegExp {
	const cached = SECRET_REGEX_CACHE.get(value);
	if (cached) {
		return cached;
	}
	const regex = new RegExp(escapeRegex(value), "g");
	SECRET_REGEX_CACHE.set(value, regex);
	if (SECRET_REGEX_CACHE.size > SECRET_REGEX_CACHE_LIMIT) {
		const oldest = SECRET_REGEX_CACHE.keys().next().value;
		if (typeof oldest === "string") {
			SECRET_REGEX_CACHE.delete(oldest);
		}
	}
	return regex;
}

/**
 * Redact known secrets from text.
 *
 * This performs literal string replacement of known secret values,
 * ensuring they don't appear in outputs even if they don't match
 * the pattern-based detection.
 *
 * @param text - Text to redact
 * @param secrets - Map of secret names to secret values
 * @returns Text with secrets replaced by [REDACTED:name]
 */
export function redactSecrets(
	text: string,
	secrets: Record<string, string>,
): string {
	if (!text || !secrets) {
		return text;
	}

	let result = text;

	// Sort secrets by length (longest first) to avoid partial replacements
	const sortedEntries = Object.entries(secrets)
		.filter(
			([, value]) =>
				typeof value === "string" && value.length >= MIN_SECRET_LENGTH,
		)
		.sort(([, a], [, b]) => b.length - a.length);

	for (const [name, value] of sortedEntries) {
		// Case-sensitive regex for the exact value (compiled once, then cached).
		const regex = getSecretRegex(value);
		// Replacer function: a secret NAME containing `$&`/`$$`/etc. must be
		// inserted literally, not expanded as a replacement pattern.
		result = result.replace(regex, () => `[REDACTED:${name}]`);
	}

	return result;
}

/**
 * Redact both known secrets and pattern-detected sensitive data.
 *
 * This combines literal secret replacement with pattern-based detection
 * for comprehensive redaction.
 *
 * @param text - Text to redact
 * @param options - Redaction options including known secrets
 * @returns Text with all sensitive data redacted
 */
export function redactWithSecrets(
	text: string,
	options: SecretsRedactOptions = {},
): string {
	if (!text) {
		return text;
	}

	let result = text;

	// First, redact known secrets (exact matches)
	if (options.secrets) {
		result = redactSecrets(result, options.secrets);
	}

	// Then apply pattern-based redaction if requested (default: true)
	if (options.applyPatterns !== false) {
		result = redactSensitiveText(result);
	}

	return result;
}

/**
 * Create a redaction function bound to specific secrets.
 *
 * This is useful for creating a redactor that can be passed around
 * and reused without needing to pass secrets each time.
 *
 * @param secrets - Map of secret names to secret values
 * @param applyPatterns - Whether to also apply pattern detection (default: true)
 * @returns Redaction function
 *
 * @example
 * ```ts
 * const redact = createSecretsRedactor(runtime.character.settings.secrets);
 * const safeText = redact(userMessage);
 * ```
 */
export function createSecretsRedactor(
	secrets: Record<string, string>,
	applyPatterns = true,
): (text: string) => string {
	return (text: string) => redactWithSecrets(text, { secrets, applyPatterns });
}

/**
 * Recursively redact secrets from an object.
 *
 * Walks through all string values in an object (including nested objects
 * and arrays) and applies secret redaction.
 *
 * @param obj - Object to redact
 * @param secrets - Map of secret names to secret values
 * @param applyPatterns - Whether to also apply pattern detection
 * @returns New object with redacted values
 */
export function redactObjectSecrets<T>(
	obj: T,
	secrets: Record<string, string>,
	applyPatterns = true,
): T {
	if (obj === null || obj === undefined) {
		return obj;
	}

	if (typeof obj === "string") {
		return redactWithSecrets(obj, { secrets, applyPatterns }) as T;
	}

	if (Array.isArray(obj)) {
		return obj.map((item) =>
			redactObjectSecrets(item, secrets, applyPatterns),
		) as T;
	}

	if (typeof obj === "object") {
		const result: Record<string, unknown> = {};
		for (const [key, value] of Object.entries(obj)) {
			result[key] = redactObjectSecrets(value, secrets, applyPatterns);
		}
		return result as T;
	}

	return obj;
}

// ============================================================================
// Log-Sink Redaction (applied to every log line, not opt-in per call)
// ============================================================================

const REDACTED_MASK = "[REDACTED]";
const MAX_LOG_REDACT_DEPTH = 8;

/**
 * Redact one log argument for output at the sink. A string is scrubbed with the
 * value-shape patterns ({@link redactSensitiveText}); an object/array is walked
 * so any value under a credential-named key ({@link isSensitiveKeyName}) is
 * fully masked and every remaining string is pattern-scrubbed. This is the
 * mechanism that makes redaction structural rather than opt-in: a logger that
 * pipes its arguments through {@link redactLogArgs} masks `{ apiKey }` whether
 * or not the caller wrapped the context first.
 *
 * Function values never survive the walk. They are executable serializer hooks
 * (toJSON/valueOf/toString), and a copied hook re-runs when a JSON sink
 * stringifies the clone, able to reconstitute the very secrets the walk just
 * masked. A bare function argument collapses to null and a function-valued
 * property is dropped outright — matching JSON.stringify, which emits null for
 * array functions and omits object function props. Symbol-keyed hooks such as
 * util.inspect.custom never reach the clone because the walk copies string keys
 * only.
 *
 * Buffer/TypedArray/DataView/ArrayBuffer values collapse to a size-only marker:
 * the indexed walk would otherwise emit the raw bytes as {"0":115,…} under an
 * innocent-looking key, and JSON.stringify would emit them as
 * {"type":"Buffer","data":[…]} — either way secret bytes survive in every sink.
 *
 * Depth is bounded and cycles are broken (returning the mask) so a pathological
 * log payload cannot hang or blow the stack — a redactor must never be the thing
 * that takes the process down.
 */
function redactLogArg(
	value: unknown,
	seen: WeakSet<object>,
	depth: number,
): unknown {
	if (typeof value === "string") {
		return redactSensitiveText(value);
	}
	if (typeof value === "function") {
		return null;
	}
	if (value === null || typeof value !== "object") {
		return value;
	}
	if (depth >= MAX_LOG_REDACT_DEPTH || seen.has(value)) {
		return REDACTED_MASK;
	}
	seen.add(value);
	if (Array.isArray(value)) {
		// Do not call value.map: an Array subclass, custom Symbol.species, or own
		// map property can return caller-owned data carrying a serializer hook.
		// Index into the input but construct the output with the intrinsic Array
		// constructor so no caller-controlled method or result prototype survives.
		const result: unknown[] = [];
		for (let index = 0; index < value.length; index += 1) {
			result.push(redactLogArg(value[index], seen, depth + 1));
		}
		return result;
	}
	if (value instanceof Error) {
		// Preserve the Error shape (name/stack) callers rely on, but scrub the
		// message — thrown errors routinely interpolate the offending secret.
		const redacted = new Error(redactSensitiveText(value.message));
		redacted.name = value.name;
		redacted.stack = value.stack ? redactSensitiveText(value.stack) : undefined;
		return redacted;
	}
	// Binary payloads carry raw bytes that JSON serializes verbatim
	// ({"type":"Buffer","data":[...]}); walked as indexed objects they emit the
	// same bytes as {"0":115,...} under an innocent-looking key, so mask with a
	// size-only marker (same marker shape as the leaf logger's).
	if (ArrayBuffer.isView(value) || value instanceof ArrayBuffer) {
		return `[BUFFER REDACTED ${value.byteLength} bytes]`;
	}
	// A null-prototype target prevents a __proto__ input key from changing the
	// clone's prototype and reintroducing inherited serializer behavior.
	const result = Object.create(null) as Record<string, unknown>;
	for (const [key, entry] of Object.entries(value)) {
		if (isSensitiveKeyName(key)) {
			result[key] = REDACTED_MASK;
			continue;
		}
		// Function-valued properties are executable serializer hooks
		// (toJSON/valueOf/toString): a copied hook re-runs when a sink
		// JSON-stringifies the clone and can reconstitute the very secrets the
		// walk just masked. JSON.stringify omits function props anyway, so
		// dropping the key matches serialization semantics.
		if (typeof entry === "function") {
			continue;
		}
		result[key] = redactLogArg(entry, seen, depth + 1);
	}
	return result;
}

/**
 * Redact every argument in a `logger.error(...args)` call before it reaches the
 * transport. Consumed by log sinks so secret masking is structural, not opt-in:
 * `logger.error("msg", { apiKey })` masks the key with no `redact.context()` at
 * the call site. Value-shape and credential-named-key redaction converge here on
 * the one core module ({@link redactSensitiveText} + {@link isSensitiveKeyName}).
 */
export function redactLogArgs(args: readonly unknown[]): unknown[] {
	return args.map((arg) => redactLogArg(arg, new WeakSet<object>(), 0));
}
