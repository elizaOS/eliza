/** Pure redaction shared by Node and client sinks. No runtime or host imports. */
const REDACTED_VALUE = "[REDACTED]";
/**
 * Marker substituted when the redactor itself fails on a value. Logging must
 * never break the runtime, but it must fail CLOSED — never emit the original
 * unredacted payload (W5-028).
 */
export const REDACTION_FAILED_VALUE = "[REDACTED: redaction failed]";
/** Bound on recursion so a pathological payload cannot hang the process. */
const MAX_REDACT_DEPTH = 8;
/**
 * Bound on the extra work one walk spends re-cloning objects it already cloned
 * elsewhere. A shared (non-cyclic) reference renders in full wherever it
 * appears, but a densely shared graph (an HTTP client error's request, socket,
 * and agent) would otherwise expand once per path. A repeated object is
 * admitted only when the budget covers one unit plus its width (own keys,
 * elements, or entries), so it renders whole or becomes a single "[Shared]";
 * every key, element, and entry visited inside a repeated subtree then spends
 * a unit before any skip, and text (strings, an error's message and stack, a
 * RegExp source) spends one more per SHARED_TEXT_UNIT characters because every
 * credential pattern re-scans it. The total work therefore stays linear in
 * the payload's distinct content.
 */
const MAX_SHARED_WORK = 10_000;
const SHARED_TEXT_UNIT = 256;
const CIRCULAR_VALUE = "[Circular]";
const SHARED_VALUE = "[Shared]";

/**
 * Separator-free substrings that mark an object key as holding a credential.
 * Compared against the lowercased key with `_-. ` stripped, so `apiKey`,
 * `OPENAI_API_KEY`, and `api.key` all match `apikey`. Shared by log sinks and the core model-output redactor.
 */
const SENSITIVE_KEY_SUBSTRINGS: readonly string[] = [
	"password",
	"passwd",
	"passphrase",
	"secret",
	"mnemonic",
	"seedphrase",
	"privatekey",
	"apikey",
	"accesstoken",
	"refreshtoken",
	"authkey",
	"credential",
	"authorization",
	"sessionkey",
	// A webhook URL is a full post credential (Discord/Slack); covered by the
	// /api/config classifier and core's policy, so it belongs here too.
	"webhook",
	"connectionstring",
];

/** Whole-key names (normalized) too generic for substring matching. */
const SENSITIVE_KEY_EXACT: ReadonlySet<string> = new Set([
	"auth",
	"session",
	"jwt",
	"bearer",
	"cookie",
	"dsn",
]);

/**
 * Telemetry/schema keys whose names contain "token" but whose values are
 * counts, budgets, or correlation ids rather than credentials. Closed list,
 * shared by log sinks and model-output redaction.
 */
const NON_SECRET_TOKEN_METADATA_KEYS: ReadonlySet<string> = new Set([
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
 * Whether an object key names a credential whose value must be masked.
 * Case-insensitive and depth-independent — the walker applies it to every key
 * at every level, so top-level and deeply nested secrets are treated alike.
 */
export function isSensitiveLogKey(key: string): boolean {
	const normalized = key.toLowerCase().replace(/[_\-. ]/g, "");
	if (NON_SECRET_TOKEN_METADATA_KEYS.has(normalized)) return false;
	if (SENSITIVE_KEY_EXACT.has(normalized)) return true;
	if (SENSITIVE_KEY_SUBSTRINGS.some((needle) => normalized.includes(needle))) {
		return true;
	}
	if (normalized.includes("token")) return true;
	// Generic `*key` forms (encryptionKey, masterKey, sshKey, OPENAI_KEY) need a
	// word boundary before "key" so monkey/turnkey/hotkey stay visible.
	if (/(?:^|[_\-. ])key$/i.test(key) || /[a-z]Key$/.test(key)) return true;
	// Separator-free all-caps concatenations (MASTERKEY, SSHKEY, SIGNINGKEY,
	// ENCRYPTIONKEY) have no boundary for the rule above; a closed suffix set on
	// the normalized name catches them without opening `key$` to lookalikes.
	if (/(?:master|signing|ssh|encryption)key$/.test(normalized)) return true;
	// Same boundary treatment for the exact names in suffixed form
	// (sessionCookie, SESSION_JWT, x-bearer).
	if (
		/(?:^|[_\-. ])(jwt|bearer|cookie)$/i.test(key) ||
		/[a-z](Jwt|Bearer|Cookie)$/.test(key)
	) {
		return true;
	}
	return false;
}

// Credential-shape text scanning (string values, headlines, Error messages)

// RFC 9110 grammar fragments shared by all Authorization redaction.
const HTTP_TOKEN_PATTERN = "[!#$%&'*+\\-.^_`|~0-9A-Za-z]+";
const HTTP_BWS_PATTERN = String.raw`[ \t]*`;
const HTTP_QUOTED_STRING_PATTERN = String.raw`"(?:[\t\x20\x21\x23-\x5B\x5D-\x7E\x80-\xFF]|\\[\t\x20-\x7E\x80-\xFF])*"`;
const HTTP_AUTH_PARAM_PATTERN = `${HTTP_TOKEN_PATTERN}${HTTP_BWS_PATTERN}=${HTTP_BWS_PATTERN}(?:${HTTP_TOKEN_PATTERN}|${HTTP_QUOTED_STRING_PATTERN})`;
// Each separator consumes its comma; each interior separator run must end in
// a parameter. Whitespace between empty entries has only one parse, avoiding
// exponential backtracking when a malformed remainder fails the boundary check.
const HTTP_AUTH_PARAM_LIST_PATTERN = `(?:,${HTTP_BWS_PATTERN})*${HTTP_AUTH_PARAM_PATTERN}(?:(?:${HTTP_BWS_PATTERN},)+${HTTP_BWS_PATTERN}${HTTP_AUTH_PARAM_PATTERN})*(?:${HTTP_BWS_PATTERN},)*`;
const HTTP_TOKEN68_PATTERN = String.raw`[A-Za-z0-9._~+/\-]+={0,}`;

/**
 * Credential-shaped value patterns, shared by model-output and log redaction. Applied to every
 * string that reaches the log sinks (object values, trailing args, headline
 * messages, Error message/stack). The shapes require an assignment context or
 * a known token prefix — no entropy heuristics — so ordinary prose does not
 * false-positive, while credentials interpolated into free text are caught.
 */
/** Broad assignment detection for runtime logs; source reviewers classify literals separately. */
export const SENSITIVE_ASSIGNMENT_PATTERNS: readonly string[] = [
	// Named credential assignments are case-insensitive; avoid broad suffix matches on ordinary words.
	// A `_`/`-`-joined prefix (db_password, openai_api_key, github_token) names the same credential,
	// as the uppercase ENV-style row already allows; `turnkey` has no separator and stays unmatched.
	// Match only the start of the whole assignment key.
	String.raw`/(?<![A-Za-z0-9_-])(?:[a-z0-9]+[_-])*(?:password|passwd|passphrase|mnemonic|seed|credential|secret|token|api[_-]?key|access[_-]?key|access[_-]?token|refresh[_-]?token|auth[_-]?token|bot[_-]?token|session[_-]?key|private[_-]?key|client[_-]?secret|seed[_-]?phrase)\b\s*[=:]\s*(["']?)([^\s"'\\]+)\1/gi`,
	// ENV-style assignments (incl. seed/mnemonic/passphrase/credential names).
	String.raw`/\b(?:[A-Z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD|PASSPHRASE|MNEMONIC|SEED|CREDENTIAL)|(?:api_key|access_token|refresh_token|auth_token|bot_token|session_key|private_key|client_secret|seed_phrase|connection_string|webhook_url))\b\s*[=:]\s*(["']?)([^\s"'\\]+)\1/g`,
];

export const SENSITIVE_TEXT_PATTERNS: readonly string[] = [
	...SENSITIVE_ASSIGNMENT_PATTERNS,
	// JSON fields.
	String.raw`"(?:apiKey|token|secret|password|passwd|accessToken|access_token|refreshToken|refresh_token|mnemonic|seedPhrase|passphrase|privateKey|credential|clientSecret|client_secret|sessionKey|session_key|authToken|auth_token|botToken|bot_token|connectionString|connection_string|webhookUrl|webhook_url)"\s*:\s*"([^"]+)"`,
	// Quoted credential keys with arbitrary naming — a closing quote sits where
	// the ENV-style row expects `=`/`:`, so `{"api_key": "…"}` matched nothing.
	// See core for the full rationale.
	String.raw`(["'])(?:[A-Za-z0-9]+[_.\-]){0,8}(?:api[_.\-]?key|access[_.\-]?token|refresh[_.\-]?token|auth[_.\-]?token|bot[_.\-]?token|session[_.\-]?key|private[_.\-]?key|client[_.\-]?secret|seed[_.\-]?phrase|passphrase|password|passwd|mnemonic|credential|secret|token|key)\1\s*[:=]\s*(["'])([^"'\\]+)\2`,
	// CLI flags (space-separated and --flag=value forms).
	String.raw`--(?:api[-_]?key|token|secret|password|passwd)(?:\s+|=)(["']?)([^\s"']+)\1`,
	// Authorization headers (see core for the full grammar rationale: Basic
	// first so trailing `=` reads as token68 padding; extension schemes use the
	// complete token/quoted-string grammar; malformed assignment tails fail
	// toward masking rather than leaking a likely credential into diagnostics).
	String.raw`(?:Proxy-)?Authorization\s*[:=]\s*Bearer\s+([A-Za-z0-9._\-+=/~]+)`,
	String.raw`(?:Proxy-)?Authorization\s*[:=]\s*Basic[ \t]+(${HTTP_TOKEN68_PATTERN})(?=[ \t]|[\r\n]|$)`,
	String.raw`(?:Proxy-)?Authorization\s*[:=]\s*(${HTTP_TOKEN_PATTERN})[ \t]+(${HTTP_AUTH_PARAM_LIST_PATTERN})(?=${HTTP_BWS_PATTERN}(?:[\r\n]|$))`,
	String.raw`(?:Proxy-)?Authorization\s*[:=]\s*(${HTTP_TOKEN_PATTERN})[ \t]+(${HTTP_TOKEN68_PATTERN})(?=${HTTP_BWS_PATTERN}(?:[\r\n]|$))`,
	String.raw`(?:Proxy-)?Authorization\s*[:=]\s*(?!(?:Basic|Bearer)(?:[ \t]|$))(${HTTP_TOKEN_PATTERN})[ \t]+((?=${HTTP_TOKEN_PATTERN}${HTTP_BWS_PATTERN}=)[^\r\n]+)(?=[\r\n]|$)`,
	String.raw`(?:Proxy-)?Authorization\s*[:=]\s*([A-Za-z0-9._~+/\-]{18,}={0,})(?=[\r\n]|$)`,
	String.raw`\bBearer\s+([A-Za-z0-9._\-+=]{18,})\b`,
	// URI userinfo (database URLs, curl arguments, remotes carrying passwords).
	String.raw`\b[a-z][a-z0-9+.-]*:\/\/([^\s/@]+)@`,
	// PEM blocks. The body stops at the next BEGIN header, and a block with no
	// END before that header ends there, so each header scans only to its END
	// or the next header. An unbounded body rescanned the rest of the text for
	// every header without an END: quadratic on untrusted log text.
	String.raw`-----BEGIN [A-Z ]*PRIVATE KEY-----(?:(?!-----BEGIN [A-Z ]*PRIVATE KEY-----)[\s\S])+?(?:-----END [A-Z ]*PRIVATE KEY-----|(?=-----BEGIN [A-Z ]*PRIVATE KEY-----))|-----BEGIN [A-Z ]*PRIVATE KEY-----(?=-----BEGIN [A-Z ]*PRIVATE KEY-----)`,
	// Common token prefixes.
	String.raw`\b(sk-[A-Za-z0-9_-]{8,})\b`,
	String.raw`\b(csk-[A-Za-z0-9_-]{8,})\b`,
	String.raw`\b((?:sk|rk)_(?:live|test)_[A-Za-z0-9]{10,})\b`,
	// Case-sensitive on purpose: ordinary words beginning with "Asia" must not
	// fold into the AWS credential-identifier shape.
	String.raw`/\b((?:AKIA|ASIA|ABIA|ACCA)[A-Z0-9]{16})\b/g`,
	String.raw`\b(ghp_[A-Za-z0-9]{20,})\b`,
	String.raw`\b(github_pat_[A-Za-z0-9_]{20,})\b`,
	String.raw`\b(xox[baprs]-[A-Za-z0-9-]{10,})\b`,
	String.raw`\b(xapp-[A-Za-z0-9-]{10,})\b`,
	String.raw`\b(gsk_[A-Za-z0-9_-]{10,})\b`,
	String.raw`\b(AIza[0-9A-Za-z\-_]{20,})\b`,
	String.raw`\b(pplx-[A-Za-z0-9_-]{10,})\b`,
	String.raw`\b(npm_[A-Za-z0-9]{10,})\b`,
	// Bot tokens (`<bot id>:<secret>`). A digit run after `-` is the last group
	// of a UUID, as in `<uuid>:<uuid>` receipt IDs, not a bot id.
	String.raw`(?<![A-Za-z0-9_-])(\d{6,}:[A-Za-z0-9_-]{20,})\b`,
	// Google OAuth refresh (`1//0…`) and access (`ya29.…`) tokens; neither shape
	// survives a `\b`-anchored alphanumeric pattern.
	String.raw`/(1\/\/[A-Za-z0-9_\-]{10,})/g`,
	String.raw`/\b(ya29\.[A-Za-z0-9_\-.]{10,})/g`,
];

function parseSensitiveTextPattern(raw: string): RegExp | null {
	const match = raw.match(/^\/(.+)\/([gimsuy]*)$/);
	try {
		if (match) {
			const flags = match[2].includes("g") ? match[2] : `${match[2]}g`;
			return new RegExp(match[1], flags);
		}
		return new RegExp(raw, "gi");
	} catch {
		// error-policy:J3 a configured pattern that no longer compiles is excluded
		// from the detector set rather than breaking logger module load.
		return null;
	}
}

// Compiled once at module load; String.prototype.replace resets a global
// regex's lastIndex before each call, so the shared array is safe to reuse.
const SENSITIVE_TEXT_REGEXPS: readonly RegExp[] = SENSITIVE_TEXT_PATTERNS.map(
	parseSensitiveTextPattern,
).filter((re): re is RegExp => Boolean(re));

const SENSITIVE_TEXT_MIN_LENGTH = 18;
const SENSITIVE_TEXT_KEEP_START = 6;
const SENSITIVE_TEXT_KEEP_END = 4;

/** Mask a matched credential, keeping short affixes for diagnostics. */
function maskSensitiveToken(token: string): string {
	if (token.length < SENSITIVE_TEXT_MIN_LENGTH) {
		return "***";
	}
	const start = token.slice(0, SENSITIVE_TEXT_KEEP_START);
	const end = token.slice(-SENSITIVE_TEXT_KEEP_END);
	return `${start}…${end}`;
}

function redactSensitiveLogMatch(match: string, groups: string[]): string {
	if (match.includes("PRIVATE KEY-----")) {
		return "***";
	}
	const filteredGroups = groups.filter(
		(value) => typeof value === "string" && value.length > 0,
	);
	const token = filteredGroups[filteredGroups.length - 1] ?? match;
	// URI userinfo includes an account identifier; do not preserve its prefix,
	// and anchor the rewrite to the userinfo span so a first-occurrence replace
	// cannot corrupt the scheme (mirrors core's redactMatch).
	if (/^[a-z][a-z0-9+.-]*:\/\//i.test(match) && match.endsWith("@")) {
		return match.replace(/^([a-z][a-z0-9+.-]*:\/\/)[^\s/@]+@$/i, "$1***@");
	}
	const masked = maskSensitiveToken(token);
	if (token === match) {
		return masked;
	}
	// Credential patterns capture the secret at the match tail; splice that
	// position directly so identical bytes earlier in the match are untouched.
	const tailIndex = match.length - token.length;
	if (tailIndex > 0 && match.startsWith(token, tailIndex)) {
		return `${match.slice(0, tailIndex)}${masked}`;
	}
	// Replacer function: `masked` keeps token affixes verbatim, and a string
	// replacement would re-expand `$&`/`$$` sequences from the secret itself.
	return match.replace(token, () => masked);
}

/**
 * Scrub credential-shaped values from free text reaching the log sinks.
 * Pattern sweep only — secrets-map literal redaction stays in core, which owns
 * the character configuration.
 */
export function redactSensitiveLogText(text: string): string {
	if (!text) {
		return text;
	}
	let next = text;
	for (const pattern of SENSITIVE_TEXT_REGEXPS) {
		next = next.replace(pattern, (...args: string[]) =>
			redactSensitiveLogMatch(args[0], args.slice(1, args.length - 2)),
		);
	}
	return next;
}

/** Clones and redacts log arguments without mutating live objects. Drops executable serialization hooks; masks binary values; scrubs Error details; and marks cycles, depth limits, and expansion limits. Plain clone targets use safe property definition to prevent __proto__ setters. */
function createRedactClone(): Record<string, unknown> {
	return {};
}

/**
 * Keep source data named toString/valueOf without executing it during
 * coercion. Plain clones get this only when an own toString shadows the
 * inherited method: Bun's console prints a non-enumerable Symbol.toPrimitive (own or
 * inherited) on every object, so an unconditional hook adds a
 * `[Symbol(Symbol.toPrimitive)]: [Function: value]` line to each logged
 * object in the terminal.
 */
function protectCloneCoercion(clone: object, text: string): void {
	Object.defineProperty(clone, Symbol.toPrimitive, {
		value: (hint: string) => (hint === "number" ? Number.NaN : text),
	});
}

/** Per-walk record of cloned objects and the remaining repeat-work budget. */
interface SharedReferenceBudget {
	expanded: WeakSet<object>;
	/**
	 * Repeated objects the budget already refused. The budget only shrinks, so
	 * a refusal is final for the walk; remembering it keeps later copies from
	 * re-measuring the object's keys, which is O(width) on V8 per copy.
	 */
	rejected: WeakSet<object>;
	remaining: number;
	/** Number of repeated objects on the current path; non-zero means every value costs work. */
	repeatDepth: number;
}

/**
 * Extra work units for re-scanning `text` against every credential pattern,
 * beyond the unit its slot already paid. Error fields may hold non-strings;
 * those cost nothing extra, never NaN, which would turn the remaining budget
 * into NaN and disable every later check.
 */
function sharedTextExtra(text: unknown): number {
	return typeof text === "string"
		? Math.floor(text.length / SHARED_TEXT_UNIT)
		: 0;
}

/** Keys, elements, or entries a clone of `value` visits, read without walking it. */
function shallowWidth(value: object): number {
	if (Array.isArray(value)) return value.length;
	if (value instanceof Map) return Reflect.get(Map.prototype, "size", value);
	if (value instanceof Set) return Reflect.get(Set.prototype, "size", value);
	// An error's clone also walks its cause.
	return Object.keys(value).length + (value instanceof Error ? 1 : 0);
}

/** Spend one unit for a key, element, or entry visited inside a repeated subtree. */
function spendRepeatedSlot(shared: SharedReferenceBudget): boolean {
	return shared.repeatDepth === 0 || spendSharedWork(shared, 1);
}

function spendSharedWork(shared: SharedReferenceBudget, cost: number): boolean {
	if (shared.remaining < cost) return false;
	shared.remaining -= cost;
	return true;
}

export function redactLogValue(
	value: unknown,
	seen: WeakSet<object>,
	depth: number,
): unknown {
	return redactWalkValue(value, seen, depth, {
		expanded: new WeakSet<object>(),
		rejected: new WeakSet<object>(),
		remaining: MAX_SHARED_WORK,
		repeatDepth: 0,
	});
}

function redactWalkValue(
	value: unknown,
	seen: WeakSet<object>,
	depth: number,
	shared: SharedReferenceBudget,
): unknown {
	// Primitives and functions cost nothing beyond the unit their slot paid.
	if (typeof value === "string") {
		const extra = shared.repeatDepth > 0 ? sharedTextExtra(value) : 0;
		if (extra > 0 && !spendSharedWork(shared, extra)) return SHARED_VALUE;
		return redactSensitiveLogText(value);
	}
	// Functions are executable values even when they are passed directly or as
	// trailing arguments. Never let a caller-owned function (and its toJSON)
	// survive into a sink.
	if (typeof value === "function") return null;
	if (value === null || typeof value !== "object") return value;
	if (seen.has(value)) return CIRCULAR_VALUE;
	if (depth >= MAX_REDACT_DEPTH) return REDACTED_VALUE;
	const repeated = shared.expanded.has(value);
	shared.expanded.add(value);
	if (isLeafObject(value)) {
		// Leaf built-ins have no children; only a RegExp source is re-scanned,
		// so a repeated Date or buffer stays free while a long pattern pays.
		const extra =
			(repeated || shared.repeatDepth > 0) && value instanceof RegExp
				? sharedTextExtra(RegExp.prototype.toString.call(value))
				: 0;
		if (extra > 0 && !spendSharedWork(shared, extra)) return SHARED_VALUE;
		return redactLeafObject(value);
	}
	if (repeated || shared.repeatDepth > 0) {
		if (shared.rejected.has(value) || shared.remaining <= 0) {
			return SHARED_VALUE;
		}
		// Admit the whole clone or none of it, so a repeat never renders half a
		// record. The per-slot charges below still bound a Proxy whose key list
		// changes between reads.
		const errorText =
			value instanceof Error
				? sharedTextExtra(value.message) + sharedTextExtra(value.stack)
				: 0;
		if (shared.remaining < 1 + shallowWidth(value) + errorText) {
			shared.rejected.add(value);
			return SHARED_VALUE;
		}
		shared.remaining -= 1 + errorText;
	}
	if (repeated) shared.repeatDepth += 1;
	// Leave the ancestor path on every exit, including a throwing getter that
	// unwinds to redactOwnPropertiesInto's per-key catch, so a sibling key that
	// holds the same object is not misreported as a cycle.
	seen.add(value);
	try {
		return redactObjectValue(value, seen, depth, shared);
	} finally {
		seen.delete(value);
		if (repeated) shared.repeatDepth -= 1;
	}
}

/** Built-ins that hold no walkable children and render in one marker or string. */
function isLeafObject(value: object): boolean {
	return (
		ArrayBuffer.isView(value) ||
		value instanceof ArrayBuffer ||
		value instanceof Date ||
		value instanceof RegExp ||
		value instanceof WeakMap ||
		value instanceof WeakSet ||
		value instanceof Promise
	);
}

/** Render a value for which isLeafObject holds. */
function redactLeafObject(value: object): string {
	// Binary payloads carry raw bytes that JSON serializes verbatim
	// ({"type":"Buffer","data":[...]}); under a neutral key that silently leaks
	// secret material into every sink, so mask with a size-only marker. Both
	// the runtime log paths funnel through this walker.
	if (ArrayBuffer.isView(value) || value instanceof ArrayBuffer) {
		return `[BUFFER REDACTED ${value.byteLength} bytes]`;
	}

	// Built-ins must also be detached from the caller. JSON.stringify invokes a
	// caller-owned Date/toJSON before its replacer.
	if (value instanceof Date) {
		try {
			return Date.prototype.toISOString.call(value);
		} catch {
			return "[Invalid Date]";
		}
	}
	if (value instanceof RegExp) {
		return `[RegExp ${redactSensitiveLogText(RegExp.prototype.toString.call(value))}]`;
	}
	if (value instanceof WeakMap) return "[WeakMap]";
	if (value instanceof WeakSet) return "[WeakSet]";
	return "[Promise]";
}

function redactObjectValue(
	value: object,
	seen: WeakSet<object>,
	depth: number,
	shared: SharedReferenceBudget,
): unknown {
	if (value instanceof Error) {
		const clone = new Error(redactSensitiveLogText(value.message));
		clone.name = redactSensitiveLogText(value.name);
		if (value.stack) clone.stack = redactSensitiveLogText(value.stack);
		protectCloneCoercion(clone, Error.prototype.toString.call(clone));
		if (value.cause !== undefined) {
			clone.cause = spendRepeatedSlot(shared)
				? redactWalkValue(value.cause, seen, depth + 1, shared)
				: SHARED_VALUE;
		}
		const target = clone as unknown as Record<string, unknown>;
		redactOwnPropertiesInto(value, target, seen, depth + 1, shared);
		return clone;
	}

	if (Array.isArray(value)) {
		// Avoid the caller's potentially overridden `map` and species constructor.
		const result = new Array<unknown>(value.length);
		for (let index = 0; index < value.length; index += 1) {
			result[index] = spendRepeatedSlot(shared)
				? redactWalkValue(value[index], seen, depth + 1, shared)
				: SHARED_VALUE;
		}
		return result;
	}

	// Pretty sinks may inspect Map/Set contents directly, so both are detached
	// from the caller like every other clone.
	if (value instanceof Map) {
		const entries: unknown[] = [];
		Map.prototype.forEach.call(
			value,
			(entryValue: unknown, entryKey: unknown) => {
				if (!spendRepeatedSlot(shared)) {
					entries.push(SHARED_VALUE);
					return;
				}
				const safeKey = redactWalkValue(entryKey, seen, depth + 1, shared);
				const safeValue =
					typeof entryKey === "string" && isSensitiveLogKey(entryKey)
						? REDACTED_VALUE
						: redactWalkValue(entryValue, seen, depth + 1, shared);
				entries.push([safeKey, safeValue]);
			},
		);
		const result = createRedactClone();
		defineSafeProperty(result, "type", "Map");
		defineSafeProperty(result, "entries", entries);
		return result;
	}
	if (value instanceof Set) {
		const values: unknown[] = [];
		Set.prototype.forEach.call(value, (entryValue: unknown) => {
			values.push(
				spendRepeatedSlot(shared)
					? redactWalkValue(entryValue, seen, depth + 1, shared)
					: SHARED_VALUE,
			);
		});
		const result = createRedactClone();
		defineSafeProperty(result, "type", "Set");
		defineSafeProperty(result, "values", values);
		return result;
	}
	// Class instances are cloned into plain objects: JSON serialization only
	// ever emits own enumerable properties anyway, and walking them here masks
	// credentials stashed on config/response wrappers (axios-style).
	const result = createRedactClone();
	redactOwnPropertiesInto(value, result, seen, depth + 1, shared);
	// Only a non-callable own toString breaks coercion: ToPrimitive falls back
	// from valueOf to toString, and the inherited Object.prototype.toString
	// still answers when valueOf alone is shadowed.
	if (Object.hasOwn(result, "toString")) {
		protectCloneCoercion(result, "[object Object]");
	}
	return result;
}

/** Define a clone key without invoking Object.prototype's `__proto__` setter. */
function defineSafeProperty(
	target: Record<string, unknown>,
	key: string,
	value: unknown,
): void {
	Object.defineProperty(target, key, {
		value,
		enumerable: true,
		configurable: true,
		writable: true,
	});
}

/**
 * Walk `source`'s own enumerable keys into `target`, masking credential-named
 * keys and recursing into the rest. Uses Object.keys plus a per-key read
 * rather than Object.entries so one throwing getter (lazy ORM/REST-client
 * payloads, Proxies) degrades to a per-key marker instead of throwing the
 * whole walk — which would fail open and unmask every sibling credential
 * (W5-028).
 */
function redactOwnPropertiesInto(
	source: object,
	target: Record<string, unknown>,
	seen: WeakSet<object>,
	depth: number,
	shared: SharedReferenceBudget,
): void {
	for (const key of Object.keys(source)) {
		// Charge before the credential and function skips: a repeated object of
		// masked or dropped keys still costs one visit per key.
		if (!spendRepeatedSlot(shared)) {
			defineSafeProperty(target, key, SHARED_VALUE);
			continue;
		}
		if (isSensitiveLogKey(key)) {
			defineSafeProperty(target, key, REDACTED_VALUE);
			continue;
		}
		try {
			const entry = (source as Record<string, unknown>)[key];
			// Function-valued properties are executable serializer hooks: a copied
			// toJSON/valueOf/toString re-runs when a sink serializes the clone and
			// can reconstitute the very secrets the walk just masked. JSON.stringify
			// omits function props anyway, so the clone drops them outright.
			if (typeof entry === "function") continue;
			defineSafeProperty(
				target,
				key,
				redactWalkValue(entry, seen, depth, shared),
			);
		} catch {
			// error-policy:J7 logging must never break the runtime; a throwing
			// getter fails closed on this one key, never emits the raw value.
			defineSafeProperty(target, key, REDACTION_FAILED_VALUE);
		}
	}
}

/**
 * Redact every argument in a trailing-args list: strings are pattern-scrubbed,
 * objects deep-walked. A walk failure on any argument fails closed to the
 * redaction-failed marker rather than propagating (or leaking) the raw value.
 */
export function redactTrailingArgs(args: readonly unknown[]): unknown[] {
	return args.map((arg) => {
		if (typeof arg === "string") return redactSensitiveLogText(arg);
		if (arg === null || (typeof arg !== "object" && typeof arg !== "function"))
			return arg;
		try {
			return redactLogValue(arg, new WeakSet<object>(), 0);
		} catch {
			// error-policy:J7 logging must never break the runtime; fail closed so
			// an unwalkable payload is marked, never emitted unredacted (W5-028).
			return REDACTION_FAILED_VALUE;
		}
	});
}
