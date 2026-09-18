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

// ----------------------------------------------------------------------------
// Credential-shape text scanning (string values, headlines, Error messages)
// ----------------------------------------------------------------------------

// RFC 9110 grammar fragments shared by all Authorization redaction.
const HTTP_TOKEN_PATTERN = "[!#$%&'*+\\-.^_`|~0-9A-Za-z]+";
const HTTP_BWS_PATTERN = String.raw`[ \t]*`;
const HTTP_QUOTED_STRING_PATTERN = String.raw`"(?:[\t\x20\x21\x23-\x5B\x5D-\x7E\x80-\xFF]|\\[\t\x20-\x7E\x80-\xFF])*"`;
const HTTP_AUTH_PARAM_PATTERN = `${HTTP_TOKEN_PATTERN}${HTTP_BWS_PATTERN}=${HTTP_BWS_PATTERN}(?:${HTTP_TOKEN_PATTERN}|${HTTP_QUOTED_STRING_PATTERN})`;
const HTTP_AUTH_PARAM_LIST_PATTERN = `(?:,${HTTP_BWS_PATTERN})*${HTTP_AUTH_PARAM_PATTERN}(?:${HTTP_BWS_PATTERN},${HTTP_BWS_PATTERN}(?:${HTTP_AUTH_PARAM_PATTERN})?)*`;
const HTTP_TOKEN68_PATTERN = String.raw`[A-Za-z0-9._~+/\-]+={0,}`;

/**
 * Credential-shaped value patterns, shared by model-output and log redaction. Applied to every
 * string that reaches the log sinks (object values, trailing args, headline
 * messages, Error message/stack). The shapes require an assignment context or
 * a known token prefix — no entropy heuristics — so ordinary prose does not
 * false-positive, while credentials interpolated into free text are caught.
 */
export const SENSITIVE_TEXT_PATTERNS: readonly string[] = [
  // ENV-style assignments (incl. seed/mnemonic/passphrase/credential names).
  String.raw`/\b(?:[A-Z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD|PASSPHRASE|MNEMONIC|SEED|CREDENTIAL)|(?:api_key|access_token|refresh_token|auth_token|bot_token|session_key|private_key|client_secret|seed_phrase|connection_string|webhook_url))\b\s*[=:]\s*(["']?)([^\s"'\\]+)\1/g`,
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
  // PEM blocks.
  String.raw`-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]+?-----END [A-Z ]*PRIVATE KEY-----`,
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
  String.raw`\b(\d{6,}:[A-Za-z0-9_-]{20,})\b`,
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

/**
 * Deep-clone a log argument, masking every value under a credential-named key
 * at any depth. The clone is what gets logged, so redaction never mutates the
 * caller's live objects (previously a shallow copy let the redactor overwrite
 * nested credentials in place, corrupting e.g. a provider config mid-use).
 * String values are pattern-scrubbed for credential shapes at every depth.
 * Function-valued properties are dropped from the clone: they are executable
 * serializer hooks (toJSON/valueOf/toString), and a copied hook re-runs when a
 * sink JSON-stringifies the clone, able to reconstitute the very secrets the
 * walk just masked — JSON.stringify drops function props anyway, so omission
 * matches serialization semantics. Cycles and over-depth payloads collapse
 * to a marker instead of recursing forever. Buffer/TypedArray/DataView/
 * ArrayBuffer values collapse to a size-only marker — JSON would otherwise
 * serialize the raw bytes verbatim
 * (`{"type":"Buffer","data":[...]}`) under an innocent-looking key. Error
 * instances keep their name/message/stack shape (Adze renders
 * it) with message and stack scrubbed — thrown errors routinely interpolate
 * the offending secret — and their own enumerable properties (axios-style
 * `err.config.headers`) are walked and masked.
 */
export function redactLogValue(
  value: unknown,
  seen: WeakSet<object>,
  depth: number,
): unknown {
  if (typeof value === "string") return redactSensitiveLogText(value);
  // Functions are executable values even when they are passed directly or as
  // trailing arguments. Never let a caller-owned function (and its toJSON)
  // survive into a sink.
  if (typeof value === "function") return null;
  if (value === null || typeof value !== "object") return value;
  if (seen.has(value)) return "[Circular]";
  if (depth >= MAX_REDACT_DEPTH) return REDACTED_VALUE;
  seen.add(value);

  if (value instanceof Error) {
    const clone = new Error(redactSensitiveLogText(value.message));
    clone.name = redactSensitiveLogText(value.name);
    if (value.stack) clone.stack = redactSensitiveLogText(value.stack);
    if (value.cause !== undefined) {
      clone.cause = redactLogValue(value.cause, seen, depth + 1);
    }
    const target = clone as unknown as Record<string, unknown>;
    redactOwnPropertiesInto(value, target, seen, depth + 1);
    return clone;
  }

  if (Array.isArray(value)) {
    // Avoid the caller's potentially overridden `map` and species constructor.
    const result = new Array<unknown>(value.length);
    for (let index = 0; index < value.length; index += 1) {
      result[index] = redactLogValue(value[index], seen, depth + 1);
    }
    return result;
  }

  // Binary payloads carry raw bytes that JSON serializes verbatim
  // ({"type":"Buffer","data":[...]}); under a neutral key that silently leaks
  // secret material into every sink, so mask with a size-only marker. Both
  // the node and browser log paths funnel through this walker.
  if (ArrayBuffer.isView(value) || value instanceof ArrayBuffer) {
    return `[BUFFER REDACTED ${value.byteLength} bytes]`;
  }

  // Built-ins must also be detached from the caller. JSON.stringify invokes a
  // caller-owned Date/toJSON before its replacer, and pretty sinks may inspect
  // Map/Set contents directly.
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
  if (value instanceof Map) {
    const entries: unknown[] = [];
    Map.prototype.forEach.call(
      value,
      (entryValue: unknown, entryKey: unknown) => {
        const safeKey = redactLogValue(entryKey, seen, depth + 1);
        const safeValue =
          typeof entryKey === "string" && isSensitiveLogKey(entryKey)
            ? REDACTED_VALUE
            : redactLogValue(entryValue, seen, depth + 1);
        entries.push([safeKey, safeValue]);
      },
    );
    const result = Object.create(null) as Record<string, unknown>;
    defineSafeProperty(result, "type", "Map");
    defineSafeProperty(result, "entries", entries);
    return result;
  }
  if (value instanceof Set) {
    const values: unknown[] = [];
    Set.prototype.forEach.call(value, (entryValue: unknown) => {
      values.push(redactLogValue(entryValue, seen, depth + 1));
    });
    const result = Object.create(null) as Record<string, unknown>;
    defineSafeProperty(result, "type", "Set");
    defineSafeProperty(result, "values", values);
    return result;
  }
  if (value instanceof WeakMap) return "[WeakMap]";
  if (value instanceof WeakSet) return "[WeakSet]";
  if (value instanceof Promise) return "[Promise]";

  // Class instances are cloned into plain objects: JSON serialization only
  // ever emits own enumerable properties anyway, and walking them here masks
  // credentials stashed on config/response wrappers (axios-style).
  const result = Object.create(null) as Record<string, unknown>;
  redactOwnPropertiesInto(value, result, seen, depth + 1);
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
): void {
  for (const key of Object.keys(source)) {
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
      defineSafeProperty(target, key, redactLogValue(entry, seen, depth));
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
