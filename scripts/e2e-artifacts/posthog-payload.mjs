/**
 * Pure decode + per-test routing logic for PostHog client traffic captured
 * during e2e runs. The sink process (`posthog-sink.mjs`) feeds raw request
 * bodies through `decodePosthogBody`/`normalizeEvents` and asks
 * `createEventRouter` which test bundle each event belongs to; keeping this
 * layer dependency-free and side-effect-free is what makes it unit-testable
 * without a server (`posthog-payload.test.mjs`).
 *
 * posthog-js ships payloads in three encodings depending on config and
 * endpoint: plain JSON, urlencoded `data=<base64 json>` form bodies, and
 * gzip ("gzip-js") bodies flagged by a `compression=` query param. Gzip magic
 * bytes are honored even without the param so a stripped query string cannot
 * corrupt a capture.
 */
import { gunzipSync } from "node:zlib";

const GZIP_MAGIC_0 = 0x1f;
const GZIP_MAGIC_1 = 0x8b;

function invalid(reason) {
  return { ok: false, reason };
}

function parseJson(text) {
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch (error) {
    // error-policy:J3 untrusted client bytes — a parse failure is an explicit
    // invalid result the sink answers 400 with, never a silently dropped body
    return invalid(`invalid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
}

// The `data=` field carries either raw JSON (no compression) or base64 of
// JSON (Base64 compression) — posthog-js picks per remote config, so both
// must decode.
function parseJsonMaybeBase64(text) {
  const trimmed = text.trim();
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    return parseJson(trimmed);
  }
  const decoded = Buffer.from(trimmed, "base64").toString("utf8");
  const result = parseJson(decoded);
  if (result.ok) return result;
  return invalid(`data= field is neither JSON nor base64-encoded JSON`);
}

/**
 * Decode a raw PostHog request body to its JSON payload. Returns
 * `{ ok: true, value }` or an explicit `{ ok: false, reason }` — the caller
 * decides how to surface the invalid input (the sink responds 400).
 */
export function decodePosthogBody(raw, { compression = "", contentType = "" } = {}) {
  const buffer = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
  const gzipped =
    compression === "gzip-js" ||
    (buffer.length >= 2 && buffer[0] === GZIP_MAGIC_0 && buffer[1] === GZIP_MAGIC_1);
  let text;
  if (gzipped) {
    try {
      text = gunzipSync(buffer).toString("utf8");
    } catch (error) {
      // error-policy:J3 untrusted client bytes — bad gzip streams surface as
      // an explicit invalid result, never as an empty event list
      return invalid(
        `gzip decode failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  } else {
    text = buffer.toString("utf8");
  }
  const trimmed = text.trim();
  if (trimmed.length === 0) {
    return invalid("empty body");
  }
  if (
    contentType.includes("application/x-www-form-urlencoded") ||
    trimmed.startsWith("data=") ||
    trimmed.includes("&data=")
  ) {
    const data = new URLSearchParams(trimmed).get("data");
    if (data === null) {
      return invalid("urlencoded body without data= field");
    }
    return parseJsonMaybeBase64(data);
  }
  return parseJson(trimmed);
}

/**
 * Flatten a decoded payload into event objects. posthog-js posts a bare
 * array, a single event object, or `{ batch: [...] }` depending on the
 * endpoint; non-object entries are dropped (they carry nothing routable).
 */
export function normalizeEvents(decoded) {
  const list = Array.isArray(decoded)
    ? decoded
    : decoded !== null && typeof decoded === "object" && Array.isArray(decoded.batch)
      ? decoded.batch
      : [decoded];
  return list.filter((entry) => entry !== null && typeof entry === "object");
}

function nonEmptyString(value) {
  return typeof value === "string" && value.length > 0 ? value : null;
}

/**
 * Stateful per-run router. `eliza_test_id` rides the super properties the app
 * module registers, but a handful of events can miss it (a $snapshot flushed
 * before `register()` lands, internal events that skip super props) — so the
 * router remembers which `$session_id` / `distinct_id` last announced a test
 * id and routes stragglers by association. Events with no test id and no
 * known association return `testId: null` (the sink's "unassigned" bucket).
 */
export function createEventRouter() {
  const bySession = new Map();
  const byDistinct = new Map();
  return {
    route(event) {
      const properties =
        event.properties !== null && typeof event.properties === "object"
          ? event.properties
          : {};
      const stream = event.event === "$snapshot" ? "snapshots" : "events";
      const sessionId = nonEmptyString(properties.$session_id);
      const distinctId =
        nonEmptyString(properties.distinct_id) ?? nonEmptyString(event.distinct_id);
      const explicit = nonEmptyString(properties.eliza_test_id);
      if (explicit) {
        if (sessionId) bySession.set(sessionId, explicit);
        if (distinctId) byDistinct.set(distinctId, explicit);
        return { testId: explicit, stream };
      }
      if (sessionId && bySession.has(sessionId)) {
        return { testId: bySession.get(sessionId), stream };
      }
      if (distinctId && byDistinct.has(distinctId)) {
        return { testId: byDistinct.get(distinctId), stream };
      }
      return { testId: null, stream };
    },
  };
}
