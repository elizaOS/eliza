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

// RFC 9110 §5.6.2 and §11.2. Keeping these grammar fragments together makes
// Authorization classification one authority for both direct redaction and
// SecretSwapSession, which compiles this module's exported default patterns.
const HTTP_TOKEN_PATTERN = "[!#$%&'*+\\-.^_`|~0-9A-Za-z]+";
const HTTP_BWS_PATTERN = String.raw`[ \t]*`;
const HTTP_QUOTED_STRING_PATTERN = String.raw`"(?:[\t\x20\x21\x23-\x5B\x5D-\x7E\x80-\xFF]|\\[\t\x20-\x7E\x80-\xFF])*"`;
const HTTP_AUTH_PARAM_PATTERN = `${HTTP_TOKEN_PATTERN}${HTTP_BWS_PATTERN}=${HTTP_BWS_PATTERN}(?:${HTTP_TOKEN_PATTERN}|${HTTP_QUOTED_STRING_PATTERN})`;
const HTTP_AUTH_PARAM_LIST_PATTERN = `(?:,${HTTP_BWS_PATTERN})*${HTTP_AUTH_PARAM_PATTERN}(?:${HTTP_BWS_PATTERN},${HTTP_BWS_PATTERN}(?:${HTTP_AUTH_PARAM_PATTERN})?)*`;
const HTTP_TOKEN68_PATTERN = String.raw`[A-Za-z0-9._~+/\-]+={0,}`;

/**
 * Default patterns for detecting sensitive data.
 * Matches common formats for API keys, tokens, passwords, etc.
 */
const DEFAULT_REDACT_PATTERNS: string[] = [
	// ENV-style assignments (incl. seed/mnemonic/passphrase/credential names).
	String.raw`\b[A-Z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD|PASSPHRASE|MNEMONIC|SEED|CREDENTIAL)\b\s*[=:]\s*(["']?)([^\s"'\\]+)\1`,
	// JSON fields.
	String.raw`"(?:apiKey|token|secret|password|passwd|accessToken|access_token|refreshToken|refresh_token|mnemonic|seedPhrase|passphrase|privateKey|credential|clientSecret|client_secret|sessionKey|session_key|authToken|auth_token|botToken|bot_token|connectionString|connection_string|webhookUrl|webhook_url)"\s*:\s*"([^"]+)"`,
	// CLI flags (space-separated and --flag=value forms).
	String.raw`--(?:api[-_]?key|token|secret|password|passwd)(?:\s+|=)(["']?)([^\s"']+)\1`,
	// Authorization credentials are either one token68 value or a complete
	// comma-separated auth-param list. Basic is classified first because its
	// trailing `=` is token68 padding, not an auth-param assignment; this also
	// lets diagnostic prose follow a Basic credential without being swallowed.
	// Extension schemes then use the complete RFC token/quoted-string grammar.
	// Line boundaries keep invalid prose such as "Authorization: required for
	// this endpoint" unchanged. Bearer retains its floor-free compatibility for
	// short service values in env-style `*_AUTHORIZATION` output.
	String.raw`(?:Proxy-)?Authorization\s*[:=]\s*Bearer\s+([A-Za-z0-9._\-+=/~]+)`,
	String.raw`(?:Proxy-)?Authorization\s*[:=]\s*Basic[ \t]+(${HTTP_TOKEN68_PATTERN})(?=[ \t]|[\r\n]|$)`,
	String.raw`(?:Proxy-)?Authorization\s*[:=]\s*(${HTTP_TOKEN_PATTERN})[ \t]+(${HTTP_AUTH_PARAM_LIST_PATTERN})(?=${HTTP_BWS_PATTERN}(?:[\r\n]|$))`,
	String.raw`(?:Proxy-)?Authorization\s*[:=]\s*(${HTTP_TOKEN_PATTERN})[ \t]+(${HTTP_TOKEN68_PATTERN})(?=${HTTP_BWS_PATTERN}(?:[\r\n]|$))`,
	// Once a non-Basic/Bearer credential has the unambiguous `token BWS =`
	// assignment opener, malformed quoting or a truncated list must fail toward
	// masking rather than leave a likely credential in diagnostics.
	String.raw`(?:Proxy-)?Authorization\s*[:=]\s*(?!(?:Basic|Bearer)(?:[ \t]|$))(${HTTP_TOKEN_PATTERN})[ \t]+((?=${HTTP_TOKEN_PATTERN}${HTTP_BWS_PATTERN}=)[^\r\n]+)(?=[\r\n]|$)`,
	String.raw`(?:Proxy-)?Authorization\s*[:=]\s*([A-Za-z0-9._~+/\-]{18,}={0,})(?=[\r\n]|$)`,
	String.raw`\bBearer\s+([A-Za-z0-9._\-+=]{18,})\b`,
	// URI userinfo. Mask the complete userinfo component (user:password,
	// token-only, or password-only) so credentials in database URLs, curl
	// arguments, and remote URLs never survive as output.
	String.raw`\b[a-z][a-z0-9+.-]*:\/\/([^\s/@]+)@`,
	// PEM blocks.
	String.raw`-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]+?-----END [A-Z ]*PRIVATE KEY-----`,
	// Common token prefixes.
	String.raw`\b(sk-[A-Za-z0-9_-]{8,})\b`,
	// Cerebras inference keys (csk-…) — a distinct prefix from OpenAI's sk-,
	// routinely echoed by sub-agent stdout as the model key in use.
	String.raw`\b(csk-[A-Za-z0-9_-]{8,})\b`,
	// Stripe secret + restricted keys (underscore form) — sk_live_/sk_test_/rk_live_/rk_test_.
	// Distinct shape from the OpenAI sk- above; Stripe is the payment processor so a leaked
	// sk_live_ is catastrophic, and these often appear as bare values (not under a *_SECRET name).
	String.raw`\b((?:sk|rk)_(?:live|test)_[A-Za-z0-9]{10,})\b`,
	// AWS credential identifiers have fixed four-character type prefixes and
	// 16 uppercase base32 characters. AKIA/ASIA are access-key IDs; ABIA/ACCA
	// are bearer/context credential identifiers and should be masked as well.
	// Keep this regex explicitly case-sensitive so ordinary mixed-case words
	// beginning with "Asia" are not folded into the credential shape.
	String.raw`/\b((?:AKIA|ASIA|ABIA|ACCA)[A-Z0-9]{16})\b/g`,
	String.raw`\b(ghp_[A-Za-z0-9]{20,})\b`,
	String.raw`\b(github_pat_[A-Za-z0-9_]{20,})\b`,
	String.raw`\b(xox[baprs]-[A-Za-z0-9-]{10,})\b`,
	String.raw`\b(xapp-[A-Za-z0-9-]{10,})\b`,
	String.raw`\b(gsk_[A-Za-z0-9_-]{10,})\b`,
	String.raw`\b(AIza[0-9A-Za-z\-_]{20,})\b`,
	String.raw`\b(pplx-[A-Za-z0-9_-]{10,})\b`,
	String.raw`\b(npm_[A-Za-z0-9]{10,})\b`,
	String.raw`\b(\d{6,}:[A-Za-z0-9_-]{20,})\b`,
];

/**
 * Substrings that mark an object key as holding a credential. Case-insensitive.
 * This is the single source of truth for *name-based* redaction — the cloud
 * logger's `redact.context()` and the log-sink redactor below both consult
 * {@link isSensitiveKeyName}, so "which field names are secret" is defined once.
 * Value-shape detection (sk-, ghp_, Bearer, PEM, …) lives in
 * {@link DEFAULT_REDACT_PATTERNS}; the two are complementary, not duplicated.
 */
const SENSITIVE_KEY_SUBSTRINGS: readonly string[] = [
	"privatekey",
	"private_key",
	"secret",
	"password",
	"passwd",
	"passphrase",
	"mnemonic",
	"seedphrase",
	"seed_phrase",
	"apikey",
	"api_key",
	"accesstoken",
	"access_token",
	"refreshtoken",
	"refresh_token",
	"authkey",
	"auth_key",
	"credential",
	"authorization",
];

// Exact telemetry/schema controls whose names contain "token" but whose
// values are counts, budgets, or correlation identifiers rather than
// credentials. Keep this list deliberately closed: broad suffix rules would
// accidentally exempt credential collections such as `accessTokens`.
const NON_SECRET_TOKEN_METADATA_KEYS = new Set([
	"cachecreationinputtokens",
	"cachereadinputtokens",
	"completiontokens",
	"compactionthresholdtokens",
	"contextwindowtokens",
	"estimatedinputtokens",
	"inputtokens",
	"maxtokens",
	"maxtokensomitted",
	"outputtokens",
	"prompttokens",
	"reasoningtokens",
	"reservetokens",
	"tokencount",
	"tokencountestimated",
	"tokenid",
	"totaltokens",
]);

/**
 * Whether an object key names a credential and its value must be fully masked.
 * Matches the substrings in {@link SENSITIVE_KEY_SUBSTRINGS} plus `token`
 * (excluding `tokenId`) and the `*key` forms the cloud logger recognized
 * (ssh/api/signing key). Callers redact the *value* under a matching key.
 */
export function isSensitiveKeyName(key: string): boolean {
	const lower = key.toLowerCase();
	const normalized = lower.replace(/[_-]/g, "");
	if (NON_SECRET_TOKEN_METADATA_KEYS.has(normalized)) {
		return false;
	}
	if (SENSITIVE_KEY_SUBSTRINGS.some((needle) => lower.includes(needle))) {
		return true;
	}
	if (lower.includes("token") && !lower.includes("tokenid")) {
		return true;
	}
	if (
		lower.includes("key") &&
		(lower.includes("ssh") ||
			lower.includes("api") ||
			lower.includes("signing"))
	) {
		return true;
	}
	// Separator-free concatenations (masterKey, MASTERKEY, encryption-key, …)
	// have no word boundary for the substring rules above; a closed suffix set
	// on the normalized name catches them without opening `key$` to lookalikes
	// (monkey/turnkey/KEYBOARD stay non-sensitive). Same closed set as the leaf
	// logger's isSensitiveLogKey and the agent's isSensitiveConfigKey.
	if (/(?:master|signing|ssh|encryption)key$/i.test(normalized)) {
		return true;
	}
	return false;
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

function maskToken(token: string): string {
	if (token.length < DEFAULT_REDACT_MIN_LENGTH) {
		return "***";
	}
	const start = token.slice(0, DEFAULT_REDACT_KEEP_START);
	const end = token.slice(-DEFAULT_REDACT_KEEP_END);
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
		return `${match.slice(0, tailIndex)}${masked}`;
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
