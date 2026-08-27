/**
 * What a failed job records about why it failed.
 *
 * Job rows stored `error.message` alone, so `agent_delete` failures have sat at
 * 35 bytes — "value.toISOString is not a function" — across 342 production
 * occurrences with nothing to locate the call site from (#23117). One of them
 * has been undeletable since 2026-07-07 for want of a stack.
 *
 * Complete error text is offloaded when necessary; an unavailable storage
 * boundary rejects an oversize write instead of persisting a partial error.
 *
 * Three properties this module owes its callers, because the value it produces
 * is written to `jobs.error` and surfaced by the jobs API:
 *
 * - It never throws. `String(value)` throws for a null-prototype object and an
 *   `Error` can carry a throwing `stack` accessor; this runs *before* the
 *   failed job is written back, so a throw here would replace the original
 *   failure and strand the claimed job without its retry/failure transition.
 * - It redacts before the text becomes durable. The logger's redactor covers
 *   process logs only — nothing scrubs this DB path, and a stack can carry a
 *   credential from the frame that raised it.
 * - It preserves the complete redacted diagnostic and cause chain.
 */

import { redactSensitiveText } from "@elizaos/core/edge";

const PUBLIC_INTERNAL_ERROR =
  "The operation failed. Retry from Eliza Cloud or contact support if it continues.";
const MAX_URL_METADATA_DECODE_ROUNDS = 4;
const NETWORK_URL_PATTERN =
  /\b(?:https?|wss?):\/\/(?:\[[0-9a-f:.%]+\]|[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?)(?::\d{1,5})?(?:[/?#][^\s'"`<>[\]]*)?/giu;
const FILE_URL_PATTERN = /\bfile:\/\//iu;
const DRIVE_PATH_PATTERN = /[A-Za-z]:[\\/][^\s'"`<>]*/u;
const UNC_PATH_PATTERN = /\\\\[^\\\s'"`<>]+\\[^\s'"`<>]*/u;
const POSIX_PATH_PATTERN = /\/+[^\s'"`<>]+/u;
const PUBLIC_URL_METADATA_PATH_PATTERN = /^\/(?:v1\/chat|callback)$/iu;
const URL_PATH_ADJACENT_HOST_PATH_PATTERN =
  /[()[\]{},;:=][\p{White_Space}\p{Cc}\p{Cf}]*(?:\/{1,2}|[A-Za-z]:[\\/]|\\\\)/u;
const LEADING_URL_METADATA_PADDING_PATTERN = /^[\p{White_Space}\p{Cc}\p{Cf}]+/u;
const STACK_FRAME_PATTERN = /\n\s+at\s+/u;
const BEARER_CREDENTIAL_PATTERN = /\bBearer\s+\S+/iu;
const CREDENTIAL_ASSIGNMENT_PATTERN =
  /\b(?:authorization|proxy-authorization|x-api-key|api[\s_-]*key|[a-z][a-z0-9_-]*(?:api[\s_-]*key|token|secret|password))\s*[:=]\s*\S+/iu;
const ENVIRONMENT_ASSIGNMENT_PATTERN = /(?:^|[^A-Z0-9_])(?:export\s+)?[A-Z][A-Z0-9_]*\s*=\s*\S+/u;
const IPV4_CANDIDATE_PATTERN = /(?:^|[^0-9])((?:\d{1,3}\.){3}\d{1,3})(?=$|[^0-9])/gu;
const PRIVATE_IPV6_BRACKETED_PATTERN =
  /\[(?:::1|f[cd][0-9a-f]{2}:[0-9a-f:.]*(?:%[a-z0-9_.~-]+)?|fe[89ab][0-9a-f]:[0-9a-f:.]*(?:%[a-z0-9_.~-]+)?)\]/iu;
const PRIVATE_IPV6_UNBRACKETED_PATTERN =
  /(?:^|[^0-9a-f:])(?:::1|f[cd][0-9a-f]{2}:[0-9a-f:]*[0-9a-f]|fe[89ab][0-9a-f]:[0-9a-f:]*[0-9a-f])(?=$|[^0-9a-f:])/iu;
const PRIVATE_HOSTNAME_PATTERN =
  /(?:^|[^a-z0-9.-])(?:localhost|[a-z0-9-]+(?:\.[a-z0-9-]+)*\.(?:internal|local|localdomain|lan)|[a-z0-9-]+(?:\.[a-z0-9-]+)*\.home\.arpa)(?=$|[^a-z0-9.-])/iu;

function canonicalizeUrlMetadata(value: string): string | null {
  let canonical = value;
  for (let round = 0; round < MAX_URL_METADATA_DECODE_ROUNDS; round += 1) {
    let decoded: string;
    try {
      decoded = decodeURIComponent(canonical);
    } catch {
      // error-policy:J3 malformed percent encoding is an explicit unsafe result.
      return null;
    }
    if (decoded === canonical) return canonical;
    canonical = decoded;
  }

  try {
    // A value that still changes after the bound is deliberately unsafe. This
    // keeps recursive encoding from turning the public projection into an
    // unbounded decoder while preventing an extra layer from bypassing it.
    return decodeURIComponent(canonical) === canonical ? canonical : null;
  } catch {
    // error-policy:J3 malformed encoding at the recursion bound is unsafe.
    return null;
  }
}

function containsPrivateIpv4Address(text: string): boolean {
  for (const match of text.matchAll(IPV4_CANDIDATE_PATTERN)) {
    const octets = match[1]?.split(".").map(Number);
    if (!octets || octets.length !== 4 || octets.some((octet) => octet > 255)) continue;
    const [first, second] = octets;
    if (
      first === 10 ||
      first === 127 ||
      (first === 100 && second !== undefined && second >= 64 && second <= 127) ||
      (first === 169 && second === 254) ||
      (first === 172 && second !== undefined && second >= 16 && second <= 31) ||
      (first === 192 && second === 168)
    ) {
      return true;
    }
  }
  return false;
}

function containsPrivateNetworkAddress(text: string): boolean {
  return (
    containsPrivateIpv4Address(text) ||
    PRIVATE_IPV6_BRACKETED_PATTERN.test(text) ||
    PRIVATE_IPV6_UNBRACKETED_PATTERN.test(text) ||
    PRIVATE_HOSTNAME_PATTERN.test(text)
  );
}

function containsCredentialMaterial(text: string): boolean {
  if (
    BEARER_CREDENTIAL_PATTERN.test(text) ||
    CREDENTIAL_ASSIGNMENT_PATTERN.test(text) ||
    ENVIRONMENT_ASSIGNMENT_PATTERN.test(text)
  ) {
    return true;
  }
  try {
    return redactSensitiveText(text) !== text;
  } catch {
    // error-policy:J3 an unavailable redactor makes the owner projection unsafe.
    return true;
  }
}

function containsHostPathToken(text: string): boolean {
  return (
    FILE_URL_PATTERN.test(text) ||
    DRIVE_PATH_PATTERN.test(text) ||
    UNC_PATH_PATTERN.test(text) ||
    POSIX_PATH_PATTERN.test(text)
  );
}

function urlMetadataIsUnsafe(value: string): boolean {
  const decoded = canonicalizeUrlMetadata(value);
  if (decoded === null) return true;
  const canonical = decoded.replace(LEADING_URL_METADATA_PADDING_PATTERN, "");
  if (PUBLIC_URL_METADATA_PATH_PATTERN.test(canonical)) return false;
  return (
    containsHostPathToken(canonical) ||
    containsPrivateNetworkAddress(canonical) ||
    containsCredentialMaterial(canonical)
  );
}

/** Detect host-path syntax carried inside otherwise public URL metadata. */
function networkUrlContainsHostPath(urlToken: string): boolean {
  let url: URL;
  try {
    url = new URL(urlToken);
  } catch {
    // error-policy:J3 a malformed URL-shaped token fails closed at this public boundary.
    return true;
  }

  const canonicalPathname = canonicalizeUrlMetadata(url.pathname);
  if (canonicalPathname === null || URL_PATH_ADJACENT_HOST_PATH_PATTERN.test(canonicalPathname)) {
    return true;
  }

  // Ordinary pathname segments are public route data. Query and fragment
  // metadata receive the stricter recursive host-path classifier because they
  // are not endpoint labels.
  const queryMetadata = [...url.searchParams.entries()].flat();
  const candidates = [url.hash.slice(1), ...queryMetadata];
  return candidates.some(urlMetadataIsUnsafe);
}

/**
 * Stored diagnostics may put a host path in the error message itself, before
 * any stack frame. Those strings are useful to operators but are not a public
 * contract. Prefer a bounded generic message to an incomplete path scrubber:
 * path syntax has too many quoting and escaping forms to safely rewrite while
 * preserving arbitrary operator text.
 */
function containsAbsolutePath(text: string): boolean {
  if (FILE_URL_PATTERN.test(text) || UNC_PATH_PATTERN.test(text)) return true;

  // A network URL contains `//` and path slashes but is not itself a host
  // filesystem path. Inspect canonical decoded query keys, values, and fragment
  // metadata before masking the URL: public route values such as `/v1/chat`
  // remain valid, while host roots and drive/UNC forms fail closed. The
  // authority grammar deliberately
  // stops before adjacent `(`, `[`, or `,` host-path delimiters.
  let embeddedHostPath = false;
  const withoutNetworkUrls = text.replace(NETWORK_URL_PATTERN, (urlToken) => {
    if (networkUrlContainsHostPath(urlToken)) embeddedHostPath = true;
    return "network:";
  });
  if (embeddedHostPath) return true;

  return (
    POSIX_PATH_PATTERN.test(withoutNetworkUrls) ||
    DRIVE_PATH_PATTERN.test(withoutNetworkUrls) ||
    UNC_PATH_PATTERN.test(withoutNetworkUrls)
  );
}

function containsUnsafeOwnerDiagnostic(text: string): boolean {
  return (
    STACK_FRAME_PATTERN.test(text) ||
    containsCredentialMaterial(text) ||
    containsPrivateNetworkAddress(text) ||
    containsAbsolutePath(text)
  );
}

/** Classify an untrusted throw without allowing Proxy reflection to escape. */
function safeError(value: unknown): Error | undefined {
  try {
    return value instanceof Error ? value : undefined;
  } catch {
    // error-policy:J3 a revoked or hostile Proxy can throw from getPrototypeOf.
    return undefined;
  }
}

/** Stringify anything without ever throwing (null-prototype, hostile toString). */
function safeString(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    // A thrown plain object (JSON-RPC error payloads are a live shape on this
    // path) stringifies to "[object Object]" — as information-free as the rows
    // this module exists to fix. Serialize it instead.
    if (
      value !== null &&
      typeof value === "object" &&
      !safeError(value) &&
      typeof (value as { toString?: unknown }).toString !== "function"
    ) {
      const json = JSON.stringify(value);
      if (typeof json === "string") return json;
    }
    const coerced = String(value);
    if (coerced === "[object Object]") {
      const json = JSON.stringify(value);
      if (typeof json === "string" && json !== "{}") return json;
    }
    return coerced;
  } catch {
    // error-policy:J3 untrusted throw value; an unstringifiable one yields an
    // explicit marker rather than propagating over the original failure.
    try {
      return Object.prototype.toString.call(value);
    } catch {
      return "[unstringifiable]";
    }
  }
}

/** `error.stack` is an accessor and can throw or be a non-string. */
function safeStack(error: Error): string {
  try {
    const stack = error.stack;
    if (typeof stack === "string" && stack.trim().length > 0) {
      return stack.trim();
    }
  } catch {
    // error-policy:J3 hostile stack accessor; fall through to the message.
  }
  try {
    return typeof error.message === "string" && error.message.length > 0
      ? error.message
      : safeString(error);
  } catch {
    return "[unreadable error]";
  }
}

/**
 * Native stacks do not serialize `cause`, so a wrapped throw loses exactly the
 * lower-level detail this module exists to retain. Cause traversal is
 * cycle-safe without imposing a depth window.
 */
function describeErrorChain(error: unknown): string {
  const parts: string[] = [];
  const seen = new Set<unknown>();
  let current: unknown = error;

  for (let depth = 0; ; depth += 1) {
    // Only the cause traversal skips nullish; a job that threw `null`
    // must still record "null" rather than an empty column.
    if (depth > 0 && (current === undefined || current === null)) break;
    if (typeof current === "object" && seen.has(current)) {
      parts.push("caused by: [circular]");
      break;
    }
    if (typeof current === "object") seen.add(current);

    const currentError = safeError(current);
    const text = currentError ? safeStack(currentError) : safeString(current);
    parts.push(depth === 0 ? text : `caused by: ${text}`);

    if (!currentError) break;
    let next: unknown;
    try {
      next = (currentError as { cause?: unknown }).cause;
    } catch {
      // error-policy:J3 hostile cause accessor ends the chain rather than
      // replacing the failure being recorded.
      break;
    }
    if (next === undefined) break;
    current = next;
  }

  return parts.join("\n");
}

/**
 * Redact job-error text without discarding diagnostic content.
 */
export function finalizeJobErrorText(text: string): string {
  let redacted: string;
  try {
    redacted = redactSensitiveText(text);
  } catch {
    // error-policy:J3 the module's contract is that it never throws — this is
    // its one external call, and it runs before the failed job is written
    // back. A redactor failure must not strand the job, and unredacted text
    // must not become durable, so record the failure instead of the text.
    redacted = "[error text withheld: redaction failed]";
  }
  return redacted;
}

export function jobErrorText(error: unknown): string {
  return finalizeJobErrorText(describeErrorChain(error));
}

/**
 * One-line summary of a throw, for embedding in another error's message.
 * Never throws; carries no frames, so wrapping does not consume the budget
 * the wrapped error's own `cause` will need.
 */
export function jobErrorSummary(error: unknown): string {
  const classifiedError = safeError(error);
  const text = classifiedError
    ? (() => {
        try {
          return typeof classifiedError.message === "string" && classifiedError.message.length > 0
            ? classifiedError.message
            : safeString(classifiedError);
        } catch {
          // error-policy:J3 hostile message accessor.
          return "[unreadable error]";
        }
      })()
    : safeString(error);
  return (text.split("\n", 1)[0] ?? "").trim() || "[no error text]";
}

/**
 * What the jobs API may return to a caller. The stored text is an operator
 * diagnostic: even redacted it may disclose absolute server paths and internal
 * module layout, which a non-admin job owner has no business reading. Legacy
 * rows also predate durable redaction. Re-sanitize at this boundary and fail
 * closed rather than trying to surgically rewrite credentials, private network
 * coordinates, stack frames, or recursively encoded host paths.
 */
export function publicJobErrorSummary(storedError: string | null | undefined): string | null {
  if (typeof storedError !== "string") return null;
  const summary = storedError.trim();
  if (summary.length === 0) return null;
  return containsUnsafeOwnerDiagnostic(summary) ? PUBLIC_INTERNAL_ERROR : summary;
}
