/**
 * elizaOS's standard structured logger, built on Adze. Exposes the `Logger`
 * interface and the `createLogger` factory (plus the default `logger` /
 * `elizaLogger` singletons) as a Pino-shaped API extended with custom
 * `success`/`progress` levels. Redacts sensitive fields with a deep-walk
 * redactor that deep-clones log context objects (callers keep their live
 * objects unmutated) and masks every value under a credential-named key at any
 * nesting depth, matched case-insensitively. Binary payloads (Buffer, typed
 * arrays, DataView, ArrayBuffer) collapse to a size-only marker so raw bytes
 * never reach a sink under a neutral key. String values — object properties,
 * headline messages, and Error message/stack — are additionally scrubbed for
 * credential shapes (API keys, Bearer tokens, URI userinfo, PEM blocks) with
 * the pattern library mirrored from `@elizaos/core`'s security/redact.ts,
 * because this process's ring buffer, file sinks, and WS stream have no
 * downstream scrubber. Keeps
 * an in-memory ring buffer with real-time listeners for WebSocket streaming,
 * and lazily opens optional file sinks (`output.log`, `prompts.log`,
 * `chat.log`, all 0600) with prompt/response/chat instrumentation helpers.
 * Adapts between node and a console-based browser path.
 */
// Test hook to clear env cache in logger tests (kept internal)
export const __loggerTestHooks = {
  clearEnvCacheForTests: () => {},
  stripAnsi: (str: string): string => stripAnsi(str),
  // Core owns the model/tool redactor while this leaf package owns the log
  // sink. Expose a copy only to the cross-package contract test so duplicated
  // credential shapes cannot silently drift between those two boundaries.
  getSensitiveTextPatternsForTests: (): string[] => [
    ...SENSITIVE_TEXT_PATTERNS,
  ],
};

import adze, {
  type ConsoleStyle,
  type LevelConfiguration,
  type Method,
  setup,
  type UserConfiguration,
} from "adze";
import type Log from "adze/dist/log.js";
import { getEnv as getEnvironmentVar } from "./env.js";

/**
 * Interface for Adze sealed logger with known methods
 */
interface AdzeLogMethods {
  alert(...args: unknown[]): void;
  error(...args: unknown[]): void;
  warn(...args: unknown[]): void;
  info(...args: unknown[]): void;
  fail(...args: unknown[]): void;
  success(...args: unknown[]): void;
  log(...args: unknown[]): void;
  debug(...args: unknown[]): void;
  verbose(...args: unknown[]): void;
}

// ============================================================================
// Type Definitions
// ============================================================================

/**
 * Log function signature matching Pino's API for compatibility
 */
type LogFn = (
  obj: Record<string, unknown> | string | Error,
  msg?: string,
  ...args: unknown[]
) => void;

/**
 * Logger interface - elizaOS standard logger API
 */
export interface Logger {
  level: string;
  trace: LogFn;
  debug: LogFn;
  info: LogFn;
  warn: LogFn;
  error: LogFn;
  fatal: LogFn;
  success: LogFn;
  progress: LogFn;
  log: LogFn;
  clear: () => void;
  child: (bindings: Record<string, unknown>) => Logger;
}

/**
 * Configuration for logger creation
 */
export interface LoggerBindings extends Record<string, unknown> {
  level?: string;
  namespace?: string;
  namespaces?: string[];
  /**
   * Retention cap for the process-wide in-memory ring buffer backing
   * `recentLogs()` and WebSocket log streaming. A positive value resizes the
   * shared buffer in place, preserving already-captured history; raising the
   * cap keeps prior entries and lowering it trims the oldest. Non-positive or
   * non-finite values are ignored, leaving the current cap (default 100)
   * unchanged. Constructing a logger never clears the shared buffer.
   */
  maxMemoryLogs?: number;
  __forceType?: "browser" | "node"; // For testing - forces specific environment behavior
}

/**
 * Log entry structure for in-memory storage and streaming
 */
export interface LogEntry {
  time: number;
  level?: number;
  msg: string;
  agentName?: string;
  agentId?: string;
  [key: string]: string | number | boolean | null | undefined;
}

/**
 * Log listener callback type for real-time log streaming
 */
export type LogListener = (entry: LogEntry) => void;

// Global log listeners for streaming
const logListeners: Set<LogListener> = new Set();
const warnedLogListeners: WeakSet<LogListener> = new WeakSet();

/**
 * Add a listener for real-time log entries (used for WebSocket streaming)
 * @param listener - Callback function to receive log entries
 * @returns Function to remove the listener
 */
export function addLogListener(listener: LogListener): () => void {
  if (!logListeners.has(listener)) {
    warnedLogListeners.delete(listener);
    logListeners.add(listener);
  }
  return () => logListeners.delete(listener);
}

/**
 * Remove a log listener
 * @param listener - The listener to remove
 */
export function removeLogListener(listener: LogListener): void {
  logListeners.delete(listener);
}

/**
 * In-memory destination for recent logs
 */
interface InMemoryDestination {
  write: (entry: LogEntry) => void;
  clear: () => void;
  recentLogs: () => string;
  /**
   * Resize the ring buffer's retention cap in place. Raising the cap keeps
   * existing entries; lowering it trims the oldest entries from the front so
   * at most `maxLogs` remain. Only a finite safe integer `>= 1` is honored;
   * fractional, non-finite, unsafe-integer, and non-positive values are ignored
   * so a bad binding cannot silently disable or wipe retention. Never clears
   * the buffer — the buffer is shared process-wide, so prior history is
   * preserved.
   */
  setMaxLogs: (maxLogs: number) => void;
}

// ============================================================================
// Utility Functions
// ============================================================================

/**
 * Log level priorities for filtering
 */
const LOG_LEVEL_PRIORITY: Record<string, number> = {
  trace: 10,
  verbose: 10,
  debug: 20,
  success: 27,
  progress: 28,
  log: 29,
  info: 30,
  warn: 40,
  error: 50,
  fatal: 60,
  alert: 60,
};

/**
 * Reverse mapping from numeric level to preferred level name
 * When multiple level names have the same numeric value, we prioritize the most semantic one
 */
const LEVEL_TO_NAME: Record<number, string> = {
  10: "trace", // prefer 'trace' over 'verbose'
  20: "debug",
  27: "success",
  28: "progress",
  29: "log",
  30: "info",
  40: "warn",
  50: "error",
  60: "fatal", // prefer 'fatal' over 'alert'
};

/**
 * Check if a message should be logged based on current level
 */
function shouldLog(messageLevel: string, currentLevel: string): boolean {
  const messagePriority = LOG_LEVEL_PRIORITY[messageLevel.toLowerCase()] || 30;
  const currentPriority = LOG_LEVEL_PRIORITY[currentLevel.toLowerCase()] || 30;
  return messagePriority >= currentPriority;
}

/**
 * Safe JSON stringify that handles circular references
 */
function safeStringify(obj: unknown): string {
  try {
    const seen = new WeakSet();
    return JSON.stringify(obj, (_, value) => {
      if (typeof value === "object" && value !== null) {
        if (seen.has(value)) return "[Circular]";
        seen.add(value);
      }
      return value;
    });
  } catch {
    return String(obj);
  }
}

/**
 * Parse boolean from text string
 */
function parseBooleanFromText(value: string | undefined | null): boolean {
  if (!value) return false;
  const normalized = value.toLowerCase().trim();
  return (
    normalized === "true" ||
    normalized === "1" ||
    normalized === "yes" ||
    normalized === "on"
  );
}

/**
 * Format a value for display in pretty log extras
 */
function formatExtraValue(value: unknown): string {
  if (value === null) return "null";
  if (value === undefined) return "undefined";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean")
    return String(value);
  if (value instanceof Error) return value.message;
  return safeStringify(value);
}

/**
 * Format a log entry in compact pretty format
 * Format: [src] message (key=val, key=val)
 *
 * agentId/agentName are NOT displayed in pretty mode because:
 * - Loggers with namespace already show an agent-prefixed tag (via Adze)
 * - These fields ARE still included in JSON mode for filtering/monitoring
 */
function formatPrettyLog(
  context: Record<string, unknown>,
  message: string,
  isJsonMode: boolean,
): string {
  // In JSON mode, don't format - return message as-is
  if (isJsonMode) {
    return message;
  }

  const src = context.src as string | undefined;

  // Build prefix: [SRC] in uppercase
  const srcPart = src ? `[${src.toUpperCase()}] ` : "";

  // Build extras: (key=val, key=val)
  // Exclude: src (already in prefix), agentId/agentName (shown via Adze namespace tag)
  const excludeKeys = ["src", "agentId", "agentName"];
  const extraPairs: string[] = [];

  for (const [key, value] of Object.entries(context)) {
    if (excludeKeys.includes(key)) continue;
    if (value === undefined) continue;
    extraPairs.push(`${key}=${formatExtraValue(value)}`);
  }

  const extrasPart = extraPairs.length > 0 ? ` (${extraPairs.join(", ")})` : "";

  return `${srcPart}${message}${extrasPart}`;
}

// ============================================================================
// Configuration
// ============================================================================

// Log level configuration
const DEFAULT_LOG_LEVEL = "info";
const effectiveLogLevel = getEnvironmentVar("LOG_LEVEL") || DEFAULT_LOG_LEVEL;

// Custom log levels mapping (elizaOS to Adze)
// These are for our internal shouldLog function, not Adze's levels
export const customLevels: Record<string, number> = {
  fatal: 60,
  error: 50,
  warn: 40,
  info: 30,
  log: 29,
  progress: 28,
  success: 27,
  debug: 20,
  trace: 10,
};

// Configuration flags
const raw = parseBooleanFromText(getEnvironmentVar("LOG_JSON_FORMAT"));
const showTimestamps = parseBooleanFromText(
  getEnvironmentVar("LOG_TIMESTAMPS") ?? "true",
);

// A Worker isolate cannot generate randomness during module evaluation. Node
// processes already have a stable per-process discriminator; edge hosts should
// inject SERVER_ID when they need one more specific than the runtime label.
const serverId =
  getEnvironmentVar("SERVER_ID") ||
  (typeof process !== "undefined" && process.pid
    ? `process-${process.pid}`
    : "edge-runtime");

// ============================================================================
// Sensitive-data redaction
// ============================================================================

const REDACTED_VALUE = "[REDACTED]";
/**
 * Marker substituted when the redactor itself fails on a value. Logging must
 * never break the runtime, but it must fail CLOSED — never emit the original
 * unredacted payload (W5-028).
 */
const REDACTION_FAILED_VALUE = "[REDACTED: redaction failed]";
/** Bound on recursion so a pathological payload cannot hang the process. */
const MAX_REDACT_DEPTH = 8;

/**
 * Separator-free substrings that mark an object key as holding a credential.
 * Compared against the lowercased key with `_-. ` stripped, so `apiKey`,
 * `OPENAI_API_KEY`, and `api.key` all match `apikey`. Mirrors the name policy
 * of `@elizaos/core`'s security/redact.ts — this leaf package cannot import
 * it, so the two lists must be kept in sync by hand.
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
 * mirroring core's NON_SECRET_TOKEN_METADATA_KEYS.
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
function isSensitiveLogKey(key: string): boolean {
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

// RFC 9110 grammar fragments for the Authorization patterns, mirroring core.
const HTTP_TOKEN_PATTERN = "[!#$%&'*+\\-.^_`|~0-9A-Za-z]+";
const HTTP_BWS_PATTERN = String.raw`[ \t]*`;
const HTTP_QUOTED_STRING_PATTERN = String.raw`"(?:[\t\x20\x21\x23-\x5B\x5D-\x7E\x80-\xFF]|\\[\t\x20-\x7E\x80-\xFF])*"`;
const HTTP_AUTH_PARAM_PATTERN = `${HTTP_TOKEN_PATTERN}${HTTP_BWS_PATTERN}=${HTTP_BWS_PATTERN}(?:${HTTP_TOKEN_PATTERN}|${HTTP_QUOTED_STRING_PATTERN})`;
const HTTP_AUTH_PARAM_LIST_PATTERN = `(?:,${HTTP_BWS_PATTERN})*${HTTP_AUTH_PARAM_PATTERN}(?:${HTTP_BWS_PATTERN},${HTTP_BWS_PATTERN}(?:${HTTP_AUTH_PARAM_PATTERN})?)*`;
const HTTP_TOKEN68_PATTERN = String.raw`[A-Za-z0-9._~+/\-]+={0,}`;

/**
 * Credential-shaped value patterns, mirrored verbatim from `@elizaos/core`'s
 * security/redact.ts DEFAULT_REDACT_PATTERNS — this leaf package cannot import
 * core, so the two copies must be kept in sync by hand. Applied to every
 * string that reaches the log sinks (object values, trailing args, headline
 * messages, Error message/stack). The shapes require an assignment context or
 * a known token prefix — no entropy heuristics — so ordinary prose does not
 * false-positive, while credentials interpolated into free text are caught.
 */
const SENSITIVE_TEXT_PATTERNS: readonly string[] = [
  // ENV-style assignments (incl. seed/mnemonic/passphrase/credential names).
  String.raw`\b[A-Z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD|PASSPHRASE|MNEMONIC|SEED|CREDENTIAL)\b\s*[=:]\s*(["']?)([^\s"'\\]+)\1`,
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
    // error-policy:J3 a mirrored pattern that no longer compiles is excluded
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
function redactSensitiveLogText(text: string): string {
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
function redactLogValue(
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
function redactTrailingArgs(args: readonly unknown[]): unknown[] {
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

// ============================================================================
// File Log Output
// ============================================================================

/**
 * File logging - lazy-initialized on first write to avoid module-init timing issues.
 * Enable with LOG_FILE=true/1 (writes output.log, prompts.log, and chat.log in
 * cwd) or LOG_FILE=/path/to/file.log.
 * Disabled by default.
 */
let _fileLogState: "pending" | "active" | "disabled" = "pending";
let _fileLogFd: number | null = null;
// One-shot guard so a persistent file-write failure surfaces exactly once on
// stderr instead of being swallowed forever by the catch in writeLogEntryToFile
// (#16356: an invalid stripAnsi regex threw on every write and output.log
// silently stayed empty for the sink's whole lifetime).
let _fileLogWriteErrorWarned = false;
let _promptLogFd: number | null = null;
let _chatLogFd: number | null = null;
let _promptLogCounter = 0;

let _fs: typeof import("node:fs") | null = null;
function getFs(): typeof import("node:fs") | null {
  if (_fs) return _fs;
  try {
    _fs = require("node:fs");
    return _fs;
  } catch {
    // error-policy:J7 logger is a leaf and cannot report through itself; no
    // node:fs (browser build) legitimately means "no file sink", not a failure.
    return null;
  }
}

/**
 * Strip ANSI escape codes from a string for plain-text logging.
 * Uses RegExp constructor to avoid control-character-in-regex lint.
 */
function stripAnsi(str: string): string {
  const ESC = "\x1b";
  const BEL = "\x07";
  const re = new RegExp(
    `${ESC}(?:\\[[\\x20-\\x3F]*[\\x40-\\x7E]|\\].*?(?:${BEL}|${ESC}\\\\|\\(B))`,
    "g",
  );
  return str.replace(re, "");
}

/**
 * Open a log sink for appending with owner-only permissions. The `0o600` mode
 * only applies when the file is first created, so fchmod heals files left
 * world-readable by older builds. Prompt and chat logs routinely contain
 * user-pasted secrets, so the sinks must never be group/other-readable.
 */
function openLogFilePrivate(
  fs: typeof import("node:fs"),
  path: string,
): number {
  const fd = fs.openSync(path, "a", 0o600);
  try {
    fs.fchmodSync(fd, 0o600);
  } catch {
    // error-policy:J6 best-effort permission heal on an already-open sink;
    // platforms without POSIX chmod semantics keep the creation-time mode.
  }
  return fd;
}

/**
 * Lazily open the log files on the first write.
 * Returns true if the files are ready for writing.
 */
function ensureFileLog(): boolean {
  if (_fileLogState === "active") return true;
  if (_fileLogState === "disabled") return false;

  _fileLogState = "disabled";
  try {
    if (typeof process === "undefined" || !process.env || !process.versions)
      return false;
    if (!process.versions.node && !process.versions.bun) return false;

    const logFileEnv = process.env.LOG_FILE;
    if (
      !logFileEnv ||
      logFileEnv.trim() === "" ||
      logFileEnv.trim() === "0" ||
      logFileEnv.trim().toLowerCase() === "false"
    ) {
      return false;
    }

    const fs = getFs();
    if (!fs) return false;
    const pathMod = require("node:path");
    const isBooleanFlag = ["true", "1", "yes", "on"].includes(
      logFileEnv.trim().toLowerCase(),
    );
    const logFilePath = isBooleanFlag
      ? pathMod.join(process.cwd(), "output.log")
      : logFileEnv.trim();
    const logDir = pathMod.dirname(
      isBooleanFlag ? pathMod.join(process.cwd(), "output.log") : logFilePath,
    );

    // Ensure log directory exists
    fs.mkdirSync(logDir, { recursive: true });

    const promptLogPath = pathMod.join(logDir, "prompts.log");
    const chatLogPath = pathMod.join(logDir, "chat.log");

    _fileLogFd = openLogFilePrivate(fs, logFilePath);
    _promptLogFd = openLogFilePrivate(fs, promptLogPath);
    _chatLogFd = openLogFilePrivate(fs, chatLogPath);
    _fileLogState = "active";

    process.on("exit", () => {
      const fs2 = getFs();
      if (fs2 && _fileLogFd !== null) {
        try {
          fs2.closeSync(_fileLogFd);
        } catch {
          // error-policy:J6 best-effort fd close on process exit.
        }
        _fileLogFd = null;
      }
      if (fs2 && _promptLogFd !== null) {
        try {
          fs2.closeSync(_promptLogFd);
        } catch {
          // error-policy:J6 best-effort fd close on process exit.
        }
        _promptLogFd = null;
      }
      if (fs2 && _chatLogFd !== null) {
        try {
          fs2.closeSync(_chatLogFd);
        } catch {
          // error-policy:J6 best-effort fd close on process exit.
        }
        _chatLogFd = null;
      }
    });

    return true;
  } catch {
    // error-policy:J7 ensureFileLog sets up the logger's own optional file
    // sink; the logger cannot report a failure to initialize itself through
    // itself, so a failed setup degrades to no file logging (returns false).
    return false;
  }
}

/**
 * Write a formatted log entry to the output file.
 * Skips browser environments, unset LOG_FILE, or a failed file open.
 */
function writeLogEntryToFile(entry: LogEntry): void {
  if (!ensureFileLog()) return;
  try {
    const fs = getFs();
    if (!fs) return;
    const fd = _fileLogFd;
    if (fd === null) return;
    const timestamp = new Date(entry.time).toISOString();
    const levelStr = LEVEL_TO_NAME[entry.level ?? 30] || "info";
    const line = `${timestamp} [${levelStr.toUpperCase().padEnd(8)}] ${stripAnsi(entry.msg)}\n`;
    fs.writeSync(fd, line);
  } catch (error) {
    // A persistent write failure (e.g. #16356's invalid regex, which threw on
    // every call) must not stay invisible for the sink's whole lifetime — go
    // straight to stderr once, bypassing the logger that is itself failing.
    if (!_fileLogWriteErrorWarned) {
      _fileLogWriteErrorWarned = true;
      console.error(
        `[logger] failed to write to the log file; further errors are suppressed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }
}

// ============================================================================
// Prompt instrumentation (prompts.log)
// ============================================================================

export interface PromptLogMetadata {
  agentName?: string;
  agentId?: string;
  runId?: string;
  provider?: string;
  caller?: string;
  [key: string]: unknown;
}

export interface ResponseLogMetadata {
  agentName?: string;
  agentId?: string;
  runId?: string;
  provider?: string;
  duration?: number;
  promptSlug?: string;
  [key: string]: unknown;
}

function promptSlug(
  counter: number,
  agentName: string,
  modelType: string,
): string {
  return `#${String(counter).padStart(4, "0")}/${agentName}/${modelType}`;
}

const MAX_PROMPT_LOG_CHARS = 100_000;

function writeToPromptLog(
  slug: string,
  kind: "PROMPT" | "RESPONSE",
  modelType: string,
  body: string,
  metadata?: Record<string, unknown>,
): void {
  if (!ensureFileLog() || _promptLogFd === null) return;
  try {
    const fs = getFs();
    if (!fs) return;
    const sep = "=".repeat(80);
    let header = `${sep}\n ${slug}  ${kind}: ${modelType} (${body.length} chars)\n`;
    header += ` ${new Date().toISOString()}\n`;
    if (metadata) {
      header += ` ${JSON.stringify(metadata, null, 2)}\n`;
    }
    header += `${sep}\n`;
    fs.writeSync(_promptLogFd, header);
    if (body.length > MAX_PROMPT_LOG_CHARS) {
      fs.writeSync(_promptLogFd, body.substring(0, MAX_PROMPT_LOG_CHARS));
      fs.writeSync(
        _promptLogFd,
        `\n... [TRUNCATED - ${body.length - MAX_PROMPT_LOG_CHARS} more chars]\n`,
      );
    } else {
      fs.writeSync(_promptLogFd, body);
    }
    fs.writeSync(_promptLogFd, `\n${sep}\n\n`);
  } catch {
    // Silent fail
  }
}

/**
 * Log a prompt to prompts.log. Returns the slug callers can pass as
 * `metadata.promptSlug` when logging the matching response.
 */
export function logPrompt(
  modelType: string,
  prompt: string,
  metadata?: PromptLogMetadata,
): string {
  if (!ensureFileLog()) return "";
  const counter = ++_promptLogCounter;
  const agentName = metadata?.agentName ?? "unknown";
  const slug = promptSlug(counter, agentName, modelType);
  writeToPromptLog(slug, "PROMPT", modelType, prompt, {
    ...metadata,
    promptSlug: slug,
  });
  return slug;
}

/**
 * Log a response to prompts.log. Returns the correlated prompt slug, or an
 * empty string when no prompt slug is available.
 */
export function logResponse(
  modelType: string,
  response: string,
  metadata?: ResponseLogMetadata,
): string {
  if (!ensureFileLog()) return "";
  const slug = metadata?.promptSlug;
  if (!slug) {
    logger.warn(
      { src: "logger" },
      "logResponse missing promptSlug - responses can't be correlated",
    );
    return "";
  }
  writeToPromptLog(slug, "RESPONSE", modelType, response, metadata);
  return slug;
}

// ============================================================================
// Chat instrumentation (chat.log)
// ============================================================================

export interface ChatInLogParams {
  agentName: string;
  agentId: string;
  roomId: string;
  messageId: string;
  text: string;
  source?: string;
}

export interface ChatOutLogParams {
  agentName: string;
  agentId: string;
  roomId: string;
  action: string;
  text?: string;
  emoji?: string;
  providers?: string[];
  reasoning?: string;
  actions?: string[];
}

const CHAT_PREVIEW_IN_MAX = 200;
const CHAT_PREVIEW_OUT_MAX = 120;

function escapeChatPreview(text: string): string {
  const safe = text.length > 10_000 ? text.slice(0, 10_000) : text;
  const oneLine = safe.replace(/\s+/g, " ").trim();
  return oneLine.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function writeChatLine(line: string): void {
  if (!ensureFileLog() || _chatLogFd === null) return;
  try {
    const fs = getFs();
    if (!fs) return;
    const timestamp = new Date().toISOString();
    fs.writeSync(_chatLogFd, `${timestamp} ${line}\n`);
  } catch {
    // Silent fail
  }
}

/** Log an incoming message to chat.log. */
export function logChatIn(params: ChatInLogParams): string {
  const preview = escapeChatPreview(
    params.text.length > CHAT_PREVIEW_IN_MAX
      ? `${params.text.slice(0, CHAT_PREVIEW_IN_MAX)}...`
      : params.text,
  );
  const roomShort = params.roomId.slice(0, 8);
  const msgShort = params.messageId.slice(0, 8);
  const source = params.source ?? "unknown";
  const line = `[CHAT:IN]  #agent:${params.agentName} room=${roomShort} msg=${msgShort} source=${source} "${preview}"`;
  writeChatLine(line);
  return line;
}

/** Log an outgoing response to chat.log. */
export function logChatOut(params: ChatOutLogParams): string {
  const roomShort = params.roomId.slice(0, 8);
  let part = `[CHAT:OUT] #agent:${params.agentName} room=${roomShort} action=${params.action}`;
  if (params.actions && params.actions.length > 0) {
    part += ` actions=${params.actions.join(",")}`;
  }
  if (params.emoji) {
    part += ` emoji=${params.emoji}`;
  }
  if (params.text !== undefined && params.text !== "") {
    const preview = escapeChatPreview(
      params.text.length > CHAT_PREVIEW_OUT_MAX
        ? `${params.text.slice(0, CHAT_PREVIEW_OUT_MAX)}...`
        : params.text,
    );
    part += ` len=${params.text.length} "${preview}"`;
  } else if (params.emoji) {
    part += " len=0";
  }
  if (params.providers && params.providers.length > 0) {
    part += ` providers=${params.providers.join(",")}`;
  }
  if (params.reasoning !== undefined && params.reasoning !== "") {
    const safe = escapeChatPreview(
      params.reasoning.length > 80
        ? `${params.reasoning.slice(0, 80)}...`
        : params.reasoning,
    );
    part += ` reasoning="${safe}"`;
  }
  writeChatLine(part);
  return part;
}

// ============================================================================
// In-Memory Log Storage
// ============================================================================

/**
 * Creates an in-memory destination for storing recent logs
 */
function createInMemoryDestination(initialMaxLogs = 100): InMemoryDestination {
  const logs: LogEntry[] = [];
  let maxLogs = initialMaxLogs;

  return {
    write(entry: LogEntry): void {
      logs.push(entry);
      while (logs.length > maxLogs) {
        logs.shift();
      }
      if (logListeners.size === 0) return;
      // Snapshot so registration changes during a callback apply only to the
      // next entry and cannot revisit the current listener indefinitely.
      for (const listener of [...logListeners]) {
        // A listener earlier in the snapshot may unsubscribe a later one.
        // Honor that removal immediately without letting new registrations
        // join the current delivery.
        if (!logListeners.has(listener)) continue;
        try {
          listener(entry);
        } catch {
          // error-policy:J7 the logger is the diagnostics boundary, so report
          // directly without recursively invoking it or exposing the entry.
          if (!warnedLogListeners.has(listener)) {
            warnedLogListeners.add(listener);
            try {
              console.error(
                "[logger] log listener failed; continuing fan-out and suppressing further errors from this listener",
              );
            } catch {
              // error-policy:J7 a failed console sink cannot be re-reported.
            }
          }
        }
      }
    },
    clear(): void {
      logs.length = 0;
    },
    setMaxLogs(nextMaxLogs: number): void {
      // A bad binding must not disable retention or wipe the shared buffer, and
      // there is no public rounding contract, so honor only a finite safe
      // integer cap of at least 1. `Number.isSafeInteger` rejects fractional
      // (e.g. 0.5, which would otherwise floor to 0 and empty the ring), NaN,
      // ±Infinity, and unsafe-integer inputs in one check; the prior cap and
      // history then stand. Only trim when the cap shrinks below the current
      // fill so existing history is preserved.
      if (!Number.isSafeInteger(nextMaxLogs) || nextMaxLogs < 1) return;
      maxLogs = nextMaxLogs;
      while (logs.length > maxLogs) {
        logs.shift();
      }
    },
    recentLogs(): string {
      return logs
        .map((entry) => {
          const timestamp = showTimestamps
            ? new Date(entry.time).toISOString()
            : "";
          // Convert numeric level back to string using the reverse mapping
          const levelStr = LEVEL_TO_NAME[entry.level ?? 30] || "info";
          return `${timestamp} ${levelStr} ${entry.msg}`.trim();
        })
        .join("\n");
    },
  };
}

// Global in-memory destination
const globalInMemoryDestination = createInMemoryDestination();

// ============================================================================
// Adze Configuration
// ============================================================================

// Configure Adze globally
// Map elizaOS log levels to Adze log levels
const getAdzeActiveLevel = () => {
  const level = effectiveLogLevel.toLowerCase();
  if (level === "trace") return "verbose";
  if (level === "debug") return "debug";
  if (level === "log") return "log";
  if (level === "info") return "info";
  if (level === "warn") return "warn";
  if (level === "error") return "error";
  if (level === "fatal") return "alert";
  return "info"; // Default to info
};

const adzeActiveLevel = getAdzeActiveLevel();

// Reusable custom level configuration using Adze's types
const customLevelConfig: Record<string, LevelConfiguration> = {
  alert: {
    levelName: "alert",
    level: 0,
    style: "font-size: 12px; color: #ff0000;",
    terminalStyle: ["bgRed", "white", "bold"] satisfies ConsoleStyle[],
    method: "error" satisfies Method,
    emoji: "",
  },
  error: {
    levelName: "error",
    level: 1,
    style: "font-size: 12px; color: #ff0000;",
    terminalStyle: ["bgRed", "whiteBright", "bold"] satisfies ConsoleStyle[],
    method: "error" satisfies Method,
    emoji: "",
  },
  warn: {
    levelName: "warn",
    level: 2,
    style: "font-size: 12px; color: #ffaa00;",
    terminalStyle: ["bgYellow", "black", "bold"] satisfies ConsoleStyle[],
    method: "warn" satisfies Method,
    emoji: "",
  },
  info: {
    levelName: "info",
    level: 3,
    style: "font-size: 12px; color: #0099ff;",
    terminalStyle: ["cyan"] satisfies ConsoleStyle[],
    method: "info" satisfies Method,
    emoji: "",
  },
  fail: {
    levelName: "fail",
    level: 4,
    style: "font-size: 12px; color: #ff6600;",
    terminalStyle: ["red", "underline"] satisfies ConsoleStyle[],
    method: "error" satisfies Method,
    emoji: "",
  },
  success: {
    levelName: "success",
    level: 5,
    style: "font-size: 12px; color: #00cc00;",
    terminalStyle: ["green"] satisfies ConsoleStyle[],
    method: "log" satisfies Method,
    emoji: "",
  },
  log: {
    levelName: "log",
    level: 6,
    style: "font-size: 12px; color: #888888;",
    terminalStyle: ["white"] satisfies ConsoleStyle[],
    method: "log" satisfies Method,
    emoji: "",
  },
  debug: {
    levelName: "debug",
    level: 7,
    style: "font-size: 12px; color: #9b59b6;",
    terminalStyle: ["gray", "dim"] satisfies ConsoleStyle[],
    method: "debug" satisfies Method,
    emoji: "",
  },
  verbose: {
    levelName: "verbose",
    level: 8,
    style: "font-size: 12px; color: #666666;",
    terminalStyle: ["gray", "dim", "italic"] satisfies ConsoleStyle[],
    method: "debug" satisfies Method,
    emoji: "",
  },
};

setup({
  activeLevel: adzeActiveLevel,
  format: raw ? "json" : "pretty",
  timestampFormatter: showTimestamps ? undefined : () => "",
  withEmoji: false,
  levels: customLevelConfig,
});

// Adze owns formatted output; createLogger().invoke owns the single in-memory
// dispatch so listeners receive one entry with Pino-compatible levels.

// ============================================================================
// Logger Factory
// ============================================================================

/**
 * Creates a sealed Adze logger instance with namespaces and metadata
 */
function sealAdze(base: Record<string, unknown>): ReturnType<typeof adze.seal> {
  let chain: ReturnType<typeof adze.ns> | typeof adze = adze as
    | ReturnType<typeof adze.ns>
    | typeof adze;

  // Add namespaces if provided
  const namespaces: string[] = [];
  if (typeof base.namespace === "string") namespaces.push(base.namespace);
  if (Array.isArray(base.namespaces))
    namespaces.push(...(base.namespaces as string[]));
  if (namespaces.length > 0) {
    chain = chain.ns(...namespaces);
  }

  // Add metadata (excluding namespace properties)
  const metaBase: Record<string, unknown> = { ...base };
  delete metaBase.namespace;
  delete metaBase.namespaces;

  // Add server context metadata (always, for observability)
  // Only add defaults if user hasn't provided them
  if (!metaBase.name) {
    metaBase.name = "elizaos";
  }

  // Add pid for process identification
  if (!metaBase.pid && typeof process !== "undefined" && process.pid) {
    metaBase.pid = process.pid;
  }

  // Add environment (production, development, test)
  if (!metaBase.environment && typeof process !== "undefined" && process.env) {
    metaBase.environment = process.env.NODE_ENV || "development";
  }

  // Add serverId for instance identification
  if (!metaBase.serverId) {
    metaBase.serverId = serverId;
  }

  // Add hostname (for JSON format or when explicitly needed)
  if (raw && !metaBase.hostname) {
    // Get hostname in a way that works in both Node and browser
    let hostname = "unknown";
    if (typeof process !== "undefined" && process.platform) {
      // Node.js environment
      const os = require("node:os");
      hostname = os.hostname();
    } else {
      // Browser environment
      const browserLocation = (
        globalThis as { location?: { hostname?: string } }
      ).location;
      if (browserLocation) {
        hostname = browserLocation.hostname || "browser";
      }
    }
    metaBase.hostname = hostname;
  }

  // This ensures the sealed logger inherits the correct log level and styling
  const globalConfig: UserConfiguration = {
    activeLevel: getAdzeActiveLevel(),
    format: raw ? "json" : "pretty",
    timestampFormatter: showTimestamps ? undefined : () => "",
    withEmoji: false,
    levels: customLevelConfig,
  };

  // Creation/child bindings bypass the per-call redaction in adaptArgs — Adze
  // emits the merged meta verbatim on every line — so scrub the bindings here:
  // logger.child({ apiKey }) must not print the key on each subsequent line.
  let safeMeta: Record<string, unknown>;
  try {
    safeMeta = redactLogValue(metaBase, new WeakSet<object>(), 0) as Record<
      string,
      unknown
    >;
  } catch {
    // error-policy:J7 logging must never break the runtime; an unwalkable
    // bindings payload degrades to a marker, never emits unredacted (W5-028).
    safeMeta = { redactionError: REDACTION_FAILED_VALUE };
  }

  return chain.meta(safeMeta).seal(globalConfig);
}

/**
 * Extract configuration from bindings
 */
function extractBindingsConfig(bindings: LoggerBindings | boolean): {
  level: string;
  base: Record<string, unknown>;
  maxMemoryLogs?: number;
} {
  let level = effectiveLogLevel;
  let base: Record<string, unknown> = {};
  let maxMemoryLogs: number | undefined;

  if (typeof bindings === "object" && bindings !== null) {
    if ("level" in bindings) {
      level = bindings.level as string;
    }
    if (
      "maxMemoryLogs" in bindings &&
      typeof bindings.maxMemoryLogs === "number"
    ) {
      maxMemoryLogs = bindings.maxMemoryLogs;
    }

    // Extract base bindings (excluding special properties)
    const { level: _, maxMemoryLogs: __, ...rest } = bindings;
    base = rest;
  }

  // Namespace bindings bypass the per-call redaction like meta does: Adze
  // prints the ns tag and invoke() prefixes the ring-buffer message with the
  // raw value. Scrub credential shapes once here, where both consumers read.
  if (typeof base.namespace === "string") {
    base.namespace = redactSensitiveLogText(base.namespace);
  }
  if (Array.isArray(base.namespaces)) {
    base.namespaces = base.namespaces.map((ns) =>
      typeof ns === "string" ? redactSensitiveLogText(ns) : ns,
    );
  }

  return { level, base, maxMemoryLogs };
}

/**
 * Creates a logger instance using Adze
 * @param bindings - Logger configuration or boolean flag
 * @returns Logger instance with elizaOS API
 */
function createLogger(bindings: LoggerBindings | boolean = false): Logger {
  const { level, base, maxMemoryLogs } = extractBindingsConfig(bindings);

  // Apply the requested retention cap in place. Resizing preserves the shared
  // buffer's existing history instead of destroying every other logger's
  // recent-logs/streaming window; fractional, non-finite, unsafe-integer, and
  // non-positive values are ignored by setMaxLogs so the prior cap stands.
  if (typeof maxMemoryLogs === "number") {
    globalInMemoryDestination.setMaxLogs(maxMemoryLogs);
  }

  // Check if we should force browser behavior (for testing)
  const forceBrowser =
    typeof bindings === "object" &&
    bindings &&
    "__forceType" in bindings &&
    bindings.__forceType === "browser";

  // If forcing browser mode, create a simple console-based logger
  if (forceBrowser) {
    const levelStr =
      typeof level === "number" ? "info" : level || effectiveLogLevel;
    const currentLevel = levelStr.toLowerCase();

    const formatArgs = (...args: unknown[]): string => {
      return args
        .map((arg) => {
          if (typeof arg === "string") return arg;
          if (arg instanceof Error) return arg.message;
          return safeStringify(arg);
        })
        .join(" ");
    };

    const logToConsole = (method: string, ...args: unknown[]): void => {
      if (!shouldLog(method, currentLevel)) {
        return;
      }

      const message = formatArgs(...args);
      const consoleMethod: keyof Console =
        method === "fatal"
          ? "error"
          : method === "trace" || method === "verbose"
            ? "debug"
            : method === "success" || method === "progress"
              ? "info"
              : method === "log"
                ? "log"
                : method in console &&
                    typeof console[method as keyof Console] === "function"
                  ? (method as keyof Console)
                  : "log";

      const consoleFn = console[consoleMethod];
      if (consoleFn && typeof consoleFn === "function") {
        // TypeScript doesn't know that consoleMethod excludes non-function properties
        // but we've already checked typeof consoleFn === 'function', so it's safe
        (consoleFn as (...args: unknown[]) => void)(message);
      }
    };

    /**
     * Safely redact sensitive data from an object (browser version).
     * Fails closed: a redactor failure must never emit the caller's original
     * object — identified secrets would reach the sinks in cleartext (W5-028).
     */
    const safeRedact = (
      obj: Record<string, unknown>,
    ): Record<string, unknown> => {
      try {
        return redactLogValue(obj, new WeakSet<object>(), 0) as Record<
          string,
          unknown
        >;
      } catch {
        // error-policy:J7 logging must never break the runtime; the failure
        // degrades to a marker object, not the unredacted original.
        return { redactionError: REDACTION_FAILED_VALUE };
      }
    };

    const adaptArgs = (
      obj: Record<string, unknown> | string | Error,
      msg?: string,
      ...args: unknown[]
    ): unknown[] => {
      // `msg` is typed string but runtime callers pass objects in that slot;
      // fold it into the trailing args so objects always hit the redactor.
      const cleanMsg =
        typeof msg === "string" ? redactSensitiveLogText(msg) : msg;
      if (typeof obj === "string") {
        const rest = cleanMsg !== undefined ? [cleanMsg, ...args] : args;
        return [redactSensitiveLogText(obj), ...redactTrailingArgs(rest)];
      }
      // A bare function in the context slot collapses like a function-valued
      // property: drop it and keep the message (see the node path).
      if (typeof obj === "function") {
        const rest = cleanMsg !== undefined ? [cleanMsg, ...args] : args;
        return redactTrailingArgs(rest);
      }
      if (obj instanceof Error) {
        const rest = cleanMsg !== undefined ? [cleanMsg, ...args] : args;
        return [
          redactSensitiveLogText(obj.message),
          ...redactTrailingArgs(rest),
        ];
      }
      // Redact sensitive data from objects
      const redactedObj = safeRedact(obj);
      if (cleanMsg !== undefined) {
        // Browser is always pretty mode - format as compact single line
        const formatted = formatPrettyLog(redactedObj, cleanMsg, false);
        return [formatted, ...redactTrailingArgs(args)];
      }
      // No message - format context only
      const formatted = formatPrettyLog(redactedObj, "", false);
      return formatted
        ? [formatted, ...redactTrailingArgs(args)]
        : [...redactTrailingArgs(args)];
    };

    return {
      level: currentLevel,
      trace: (obj, msg, ...args) =>
        logToConsole("trace", ...adaptArgs(obj, msg, ...args)),
      debug: (obj, msg, ...args) =>
        logToConsole("debug", ...adaptArgs(obj, msg, ...args)),
      info: (obj, msg, ...args) =>
        logToConsole("info", ...adaptArgs(obj, msg, ...args)),
      warn: (obj, msg, ...args) =>
        logToConsole("warn", ...adaptArgs(obj, msg, ...args)),
      error: (obj, msg, ...args) =>
        logToConsole("error", ...adaptArgs(obj, msg, ...args)),
      fatal: (obj, msg, ...args) =>
        logToConsole("fatal", ...adaptArgs(obj, msg, ...args)),
      success: (obj, msg, ...args) =>
        logToConsole("success", ...adaptArgs(obj, msg, ...args)),
      progress: (obj, msg, ...args) =>
        logToConsole("progress", ...adaptArgs(obj, msg, ...args)),
      log: (obj, msg, ...args) =>
        logToConsole("log", ...adaptArgs(obj, msg, ...args)),
      clear: () => {
        if (typeof console.clear === "function") console.clear();
      },
      child: (childBindings: Record<string, unknown>) =>
        createLogger({
          level: currentLevel,
          ...base,
          ...childBindings,
          __forceType: "browser",
        }),
    };
  }

  // Create sealed Adze instance with configuration
  const sealed = sealAdze(base);
  const levelStr =
    typeof level === "number" ? "info" : level || effectiveLogLevel;
  const currentLevel = levelStr.toLowerCase();

  /**
   * Invoke Adze method with error capture
   */
  const invoke = (method: string, ...args: unknown[]): void => {
    // Check if this log level should be output
    if (!shouldLog(method, currentLevel)) {
      return;
    }

    // Capture to in-memory destination for API access (even for namespaced loggers)
    let msg = "";
    if (args.length > 0) {
      msg = args
        .map((arg) => {
          if (typeof arg === "string") return arg;
          if (arg instanceof Error) return arg.message;
          return safeStringify(arg);
        })
        .join(" ");
    }

    // Include namespace in the message if present
    if (base.namespace) {
      msg = `#${base.namespace}  ${msg}`;
    }

    const entry: LogEntry = {
      time: Date.now(),
      level:
        LOG_LEVEL_PRIORITY[method.toLowerCase()] || LOG_LEVEL_PRIORITY.info,
      msg,
    };

    globalInMemoryDestination.write(entry);
    writeLogEntryToFile(entry);

    // Map Eliza methods to correct Adze invocations
    let adzeMethod = method;
    let adzeArgs = args;

    // Normalize special cases - map our custom levels to Adze levels
    if (method === "fatal") {
      // Adze uses 'alert' for fatal-level logging
      adzeMethod = "alert";
    } else if (method === "progress") {
      // Map progress to info level with a prefix
      adzeMethod = "info";
      adzeArgs = ["[PROGRESS]", ...args];
    } else if (method === "success") {
      // Map success to info level with a prefix
      adzeMethod = "info";
      adzeArgs = ["[SUCCESS]", ...args];
    } else if (method === "trace") {
      // Map trace to verbose
      adzeMethod = "verbose";
    }

    // Invoke the sealed logger method
    try {
      // The sealed logger implements AdzeLogMethods
      const loggerWithMethods = sealed as Log & AdzeLogMethods;
      const logMethod = loggerWithMethods[adzeMethod as keyof AdzeLogMethods];
      if (typeof logMethod === "function") {
        logMethod.call(loggerWithMethods, ...adzeArgs);
      }
    } catch {
      // Adze internals failed — drop the log entry rather than breaking the runtime
    }
  };

  /**
   * Safely redact sensitive data from an object.
   * Deep-clones first so redaction never mutates the caller's live objects.
   * Fails closed: a redactor failure must never emit the caller's original
   * object — identified secrets would reach the sinks in cleartext (W5-028).
   */
  const safeRedact = (
    obj: Record<string, unknown>,
  ): Record<string, unknown> => {
    try {
      return redactLogValue(obj, new WeakSet<object>(), 0) as Record<
        string,
        unknown
      >;
    } catch {
      // error-policy:J7 logging must never break the runtime; the failure
      // degrades to a marker object, not the unredacted original.
      return { redactionError: REDACTION_FAILED_VALUE };
    }
  };

  /**
   * Adapt elizaOS logger API arguments to Adze format
   * Also applies redaction to sensitive data in objects
   *
   * In pretty mode: formats as compact single line [src] agent — message (extras)
   * In JSON mode: keeps structured object for machine parsing
   */
  const adaptArgs = (
    obj: Record<string, unknown> | string | Error,
    msg?: string,
    ...args: unknown[]
  ): unknown[] => {
    // String first argument - no context object. `msg` is typed string but
    // runtime callers do pass objects in that slot; fold it into the trailing
    // args so anything object-shaped still goes through the redactor.
    const cleanMsg =
      typeof msg === "string" ? redactSensitiveLogText(msg) : msg;
    if (typeof obj === "string") {
      const rest = cleanMsg !== undefined ? [cleanMsg, ...args] : args;
      return [redactSensitiveLogText(obj), ...redactTrailingArgs(rest)];
    }
    // A bare function in the context slot collapses like a function-valued
    // property: drop it and keep the message rather than handing the pretty
    // formatter the redactor's null stand-in.
    if (typeof obj === "function") {
      const rest = cleanMsg !== undefined ? [cleanMsg, ...args] : args;
      return redactTrailingArgs(rest);
    }
    // Error object - the wrapper must be redacted too: error instances can
    // carry credentials on enumerable properties (request config, headers),
    // and the headline message itself can interpolate the offending secret.
    if (obj instanceof Error) {
      const errorWrapper = safeRedact({ error: obj });
      const rest = cleanMsg !== undefined ? [cleanMsg, ...args] : args;
      return [
        redactSensitiveLogText(obj.message),
        errorWrapper,
        ...redactTrailingArgs(rest),
      ];
    }

    // Object (context) - redact sensitive data
    const redactedObj = safeRedact(obj);

    if (cleanMsg !== undefined) {
      // Pretty mode: format as compact single line
      if (!raw) {
        const formatted = formatPrettyLog(redactedObj, cleanMsg, raw);
        return [formatted, ...redactTrailingArgs(args)];
      }
      // JSON mode: keep structured object for machine parsing
      return [cleanMsg, redactedObj, ...redactTrailingArgs(args)];
    }

    // No message provided - just context object
    if (!raw) {
      // Pretty mode: format the object as a simple string
      const formatted = formatPrettyLog(redactedObj, "", raw);
      return formatted
        ? [formatted, ...redactTrailingArgs(args)]
        : [...redactTrailingArgs(args)];
    }
    return [redactedObj, ...redactTrailingArgs(args)];
  };

  // Create log methods
  const trace: LogFn = (obj, msg, ...args) =>
    invoke("verbose", ...adaptArgs(obj, msg, ...args));
  const debug: LogFn = (obj, msg, ...args) =>
    invoke("debug", ...adaptArgs(obj, msg, ...args));
  const info: LogFn = (obj, msg, ...args) =>
    invoke("info", ...adaptArgs(obj, msg, ...args));
  const warn: LogFn = (obj, msg, ...args) =>
    invoke("warn", ...adaptArgs(obj, msg, ...args));
  const error: LogFn = (obj, msg, ...args) =>
    invoke("error", ...adaptArgs(obj, msg, ...args));
  const fatal: LogFn = (obj, msg, ...args) =>
    invoke("fatal", ...adaptArgs(obj, msg, ...args));
  const success: LogFn = (obj, msg, ...args) =>
    invoke("success", ...adaptArgs(obj, msg, ...args));
  const progress: LogFn = (obj, msg, ...args) =>
    invoke("progress", ...adaptArgs(obj, msg, ...args));
  const logFn: LogFn = (obj, msg, ...args) =>
    invoke("log", ...adaptArgs(obj, msg, ...args));

  /**
   * Clear console and memory buffer
   */
  const clear = (): void => {
    const consoleClear = console.clear;
    if (typeof consoleClear === "function") {
      consoleClear();
    }
    globalInMemoryDestination.clear();
  };

  /**
   * Create child logger with additional bindings
   */
  const child = (childBindings: Record<string, unknown>): Logger => {
    return createLogger({ level: currentLevel, ...base, ...childBindings });
  };

  return {
    level: currentLevel,
    trace,
    debug,
    info,
    warn,
    error,
    fatal,
    success,
    progress,
    log: logFn,
    clear,
    child,
  };
}

// ============================================================================
// Exports
// ============================================================================

// Create default logger instance
const logger = createLogger();

// Backward compatibility alias
export const elizaLogger = logger;

// Export recent logs function
export const recentLogs = (): string => globalInMemoryDestination.recentLogs();

// Export everything
export { createLogger, logger };
export default logger;
