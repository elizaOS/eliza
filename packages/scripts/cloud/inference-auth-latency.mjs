/**
 * Privacy-safe live probe for inference-auth cache hits and controlled KV misses.
 * It authenticates against an exact Worker version, sends an empty JSON body so
 * no model or billing path runs, and retains only bounded outcomes, timings,
 * placement, trace ids, and deployment provenance.
 */

import { randomBytes, randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";

const AUTH_TRACE_HEADER = "x-eliza-auth-trace";
const AUTH_PROBE_HEADER = "X-Eliza-Auth-Probe";
const TRACE_HEADER = "X-Eliza-Trace-Id";
const AUTH_METRICS = new Set([
  "auth_extract",
  "auth_cache_available",
  "auth_cache_read",
  "auth_key_lookup",
  "auth_user_org",
  "auth_moderation",
  "auth_cache_write",
  "auth_resolve",
]);

const AUTH_ENUMS = Object.freeze({
  v: new Set(["1"]),
  credential: new Set(["x_api_key", "bearer_api_key", "other"]),
  probe: new Set(["on", "off"]),
  available: new Set(["not_checked", "available", "unavailable"]),
  backend: new Set([
    "cloudflare_kv",
    "memory",
    "redis_native",
    "redis_rest",
    "redis_socket",
    "wadis",
    "none",
    "unknown",
  ]),
  read: new Set(["not_run", "hit", "miss", "invalid", "unavailable", "error"]),
  authoritative: new Set([
    "not_run",
    "authorized",
    "suspended",
    "rejected",
    "error",
  ]),
  write: new Set([
    "not_run",
    "deferred",
    "written",
    "invalid",
    "unavailable",
    "error",
  ]),
  result: new Set([
    "authorized_cache",
    "authorized_origin",
    "suspended",
    "slow_path",
    "rejected",
    "error",
  ]),
});

const AUTH_TELEMETRY_ENUMS = Object.freeze({
  authSource: AUTH_ENUMS.credential,
  controlledProbe: AUTH_ENUMS.probe,
  cacheAvailability: AUTH_ENUMS.available,
  cacheBackend: AUTH_ENUMS.backend,
  cacheRead: AUTH_ENUMS.read,
  authoritative: AUTH_ENUMS.authoritative,
  cacheWrite: AUTH_ENUMS.write,
  result: AUTH_ENUMS.result,
});

const AUTH_TIMING_FIELDS = Object.freeze([
  "extractMs",
  "cacheAvailabilityMs",
  "cacheReadMs",
  "keyLookupMs",
  "userOrgLookupMs",
  "moderationMs",
  "cacheWriteMs",
  "totalMs",
]);

const TAIL_OUTCOMES = new Set([
  "ok",
  "canceled",
  "exception",
  "exceededCpu",
  "exceededMemory",
  "unknown",
]);

const OPAQUE_TRACE_ID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(value, keys) {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return (
    actual.length === expected.length &&
    actual.every((key, index) => key === expected[index])
  );
}

function boundedDuration(value, nullable) {
  if (nullable && value === null) return null;
  if (!Number.isFinite(value) || value < 0 || value > 3_600_000) {
    throw new Error("Worker auth log contains an invalid duration");
  }
  return value;
}

/**
 * Accept only the fixed telemetry schema before a raw Worker Tail event can
 * cross into an evidence artifact. Unknown fields fail closed because Tail
 * events also carry request headers and URLs outside this object.
 */
export function sanitizeInferenceAuthTelemetry(value) {
  const keys = [
    "v",
    "traceId",
    ...Object.keys(AUTH_TELEMETRY_ENUMS),
    "timings",
  ];
  if (!isRecord(value) || !hasExactKeys(value, keys) || value.v !== 1) {
    throw new Error(
      "Worker auth log does not match the bounded telemetry schema",
    );
  }
  if (!OPAQUE_TRACE_ID.test(value.traceId)) {
    throw new Error("Worker auth log has an invalid trace id");
  }
  const telemetry = { v: 1, traceId: value.traceId.toLowerCase() };
  for (const [name, allowed] of Object.entries(AUTH_TELEMETRY_ENUMS)) {
    if (!allowed.has(value[name])) {
      throw new Error(
        `Worker auth log contains an invalid bounded ${name} outcome`,
      );
    }
    telemetry[name] = value[name];
  }
  if (
    !isRecord(value.timings) ||
    !hasExactKeys(value.timings, AUTH_TIMING_FIELDS)
  ) {
    throw new Error("Worker auth log has an invalid timing schema");
  }
  telemetry.timings = {};
  for (const name of AUTH_TIMING_FIELDS) {
    telemetry.timings[name] = boundedDuration(
      value.timings[name],
      name !== "extractMs" && name !== "totalMs",
    );
  }
  return telemetry;
}

function sanitizeInferenceAuthCacheWriteTelemetry(value) {
  const keys = [
    "v",
    "kind",
    "traceId",
    "cacheBackend",
    "cacheWrite",
    "durationMs",
  ];
  if (
    !isRecord(value) ||
    !hasExactKeys(value, keys) ||
    value.v !== 1 ||
    value.kind !== "cache_write"
  ) {
    throw new Error(
      "Worker auth cache-write log does not match the bounded telemetry schema",
    );
  }
  if (!OPAQUE_TRACE_ID.test(value.traceId)) {
    throw new Error("Worker auth cache-write log has an invalid trace id");
  }
  if (!AUTH_ENUMS.backend.has(value.cacheBackend)) {
    throw new Error("Worker auth cache-write log has an invalid backend");
  }
  if (
    value.cacheWrite !== "written" &&
    value.cacheWrite !== "invalid" &&
    value.cacheWrite !== "unavailable" &&
    value.cacheWrite !== "error"
  ) {
    throw new Error("Worker auth cache-write log has an invalid outcome");
  }
  return {
    v: 1,
    kind: "cache_write",
    traceId: value.traceId.toLowerCase(),
    cacheBackend: value.cacheBackend,
    cacheWrite: value.cacheWrite,
    durationMs: boundedDuration(value.durationMs, false),
  };
}

function parseJsonObjectStream(text) {
  const values = [];
  let start = -1;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = 0; index < text.length; index++) {
    const character = text[index];
    if (start < 0) {
      if (character === "{") {
        start = index;
        depth = 1;
      }
      continue;
    }
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (character === "\\") {
        escaped = true;
      } else if (character === '"') {
        inString = false;
      }
      continue;
    }
    if (character === '"') {
      inString = true;
    } else if (character === "{") {
      depth++;
    } else if (character === "}") {
      depth--;
      if (depth === 0) {
        values.push(JSON.parse(text.slice(start, index + 1)));
        start = -1;
      }
    }
  }
  if (start >= 0 || inString)
    throw new Error("Worker Tail output ended mid-record");
  return values;
}

/** Reduce raw Wrangler Tail output to one allowlisted record per retained probe. */
export function sanitizeInferenceAuthTail(
  rawText,
  expectedTraceIds,
  deploySha,
) {
  if (!/^[a-f0-9]{40}$/.test(deploySha))
    throw new Error("Invalid Worker Tail deployment SHA");
  const expected = new Set(expectedTraceIds);
  if (expected.size !== expectedTraceIds.length || expected.size === 0) {
    throw new Error("Worker Tail requires unique retained trace ids");
  }
  const byTrace = new Map();
  const cacheWritesByTrace = new Map();
  for (const event of parseJsonObjectStream(rawText)) {
    if (!isRecord(event) || !Array.isArray(event.logs)) continue;
    const outcome = TAIL_OUTCOMES.has(event.outcome)
      ? event.outcome
      : "unknown";
    for (const log of event.logs) {
      if (
        !isRecord(log) ||
        !Array.isArray(log.message) ||
        log.message[0] !== "[InferenceAuth] trace"
      ) {
        continue;
      }
      const rawTelemetry = log.message[1];
      const rawTraceId = isRecord(rawTelemetry)
        ? rawTelemetry.traceId
        : undefined;
      if (typeof rawTraceId !== "string" || !OPAQUE_TRACE_ID.test(rawTraceId)) {
        continue;
      }
      const traceId = rawTraceId.toLowerCase();
      // A Tail session can observe unrelated traffic on the isolated hostname.
      // Correlate on the one opaque field before validating or retaining any
      // other part of the raw object, then fail closed on the complete schema.
      if (!expected.has(traceId)) continue;
      if (rawTelemetry.kind === "cache_write") {
        const telemetry =
          sanitizeInferenceAuthCacheWriteTelemetry(rawTelemetry);
        if (cacheWritesByTrace.has(telemetry.traceId)) {
          throw new Error(
            "Worker Tail returned duplicate auth cache-write traces",
          );
        }
        cacheWritesByTrace.set(telemetry.traceId, {
          outcome,
          telemetry,
        });
        continue;
      }
      const telemetry = sanitizeInferenceAuthTelemetry(rawTelemetry);
      if (byTrace.has(telemetry.traceId)) {
        throw new Error("Worker Tail returned duplicate auth traces");
      }
      byTrace.set(telemetry.traceId, {
        kind: "worker_log",
        deploySha,
        traceId: telemetry.traceId,
        outcome,
        telemetry,
      });
    }
  }
  const missing = expectedTraceIds.filter((traceId) => !byTrace.has(traceId));
  if (missing.length > 0) {
    throw new Error(
      `Worker Tail omitted ${missing.length} retained auth traces`,
    );
  }
  return expectedTraceIds.map((traceId) => {
    const record = byTrace.get(traceId);
    const deferredCacheWrite = cacheWritesByTrace.get(traceId) ?? null;
    if (record.telemetry.cacheWrite === "deferred" && !deferredCacheWrite) {
      throw new Error("Worker Tail omitted a deferred auth cache-write trace");
    }
    if (record.telemetry.cacheWrite !== "deferred" && deferredCacheWrite) {
      throw new Error(
        "Worker Tail returned an unexpected auth cache-write trace",
      );
    }
    return { ...record, deferredCacheWrite };
  });
}

function requiredValue(args, index, name) {
  const value = args[index + 1];
  if (!value || value.startsWith("--"))
    throw new Error(`${name} requires a value`);
  return value;
}

export function parseArgs(args) {
  const options = {
    baseUrl: "",
    apiKeyEnv: "",
    suspendedApiKeyEnv: "",
    probeTokenEnv: "",
    deploySha: "",
    hitCount: 30,
    missCount: 10,
    timeoutMs: 30_000,
    intervalMs: 250,
    enforce: false,
  };
  for (let index = 0; index < args.length; index++) {
    const name = args[index];
    if (name === "--enforce") {
      options.enforce = true;
      continue;
    }
    const value = requiredValue(args, index, name);
    index++;
    switch (name) {
      case "--base-url":
        options.baseUrl = value.replace(/\/$/, "");
        break;
      case "--api-key-env":
        options.apiKeyEnv = value;
        break;
      case "--suspended-api-key-env":
        options.suspendedApiKeyEnv = value;
        break;
      case "--probe-token-env":
        options.probeTokenEnv = value;
        break;
      case "--deploy-sha":
        options.deploySha = value;
        break;
      case "--hit-count":
        options.hitCount = Number(value);
        break;
      case "--miss-count":
        options.missCount = Number(value);
        break;
      case "--timeout-ms":
        options.timeoutMs = Number(value);
        break;
      case "--interval-ms":
        options.intervalMs = Number(value);
        break;
      default:
        throw new Error(`Unknown option ${name}`);
    }
  }
  if (!/^https:\/\//.test(options.baseUrl))
    throw new Error("--base-url must use HTTPS");
  if (!/^[A-Z][A-Z0-9_]+$/.test(options.apiKeyEnv)) {
    throw new Error("--api-key-env must name an environment variable");
  }
  if (!/^[A-Z][A-Z0-9_]+$/.test(options.suspendedApiKeyEnv)) {
    throw new Error(
      "--suspended-api-key-env must name an environment variable",
    );
  }
  if (!/^[A-Z][A-Z0-9_]+$/.test(options.probeTokenEnv)) {
    throw new Error("--probe-token-env must name an environment variable");
  }
  if (!/^[a-f0-9]{40}$/.test(options.deploySha)) {
    throw new Error("--deploy-sha must be a lowercase 40-character commit");
  }
  for (const [name, value] of [
    ["--hit-count", options.hitCount],
    ["--miss-count", options.missCount],
    ["--timeout-ms", options.timeoutMs],
    ["--interval-ms", options.intervalMs],
  ]) {
    if (
      !Number.isInteger(value) ||
      value < (name === "--interval-ms" ? 0 : 1)
    ) {
      throw new Error(`${name} must be a valid integer`);
    }
  }
  return options;
}

export function parseAuthTrace(value) {
  if (!value || value.length > 512)
    throw new Error("Missing or oversized auth trace header");
  const parsed = {};
  for (const part of value.split(";")) {
    const separator = part.indexOf("=");
    if (separator <= 0) throw new Error("Malformed auth trace header");
    const name = part.slice(0, separator);
    const field = part.slice(separator + 1);
    const allowed = Object.hasOwn(AUTH_ENUMS, name)
      ? AUTH_ENUMS[name]
      : undefined;
    if (!allowed?.has(field) || Object.hasOwn(parsed, name)) {
      throw new Error("Invalid auth trace field");
    }
    parsed[name] = field;
  }
  for (const name of Object.keys(AUTH_ENUMS)) {
    if (!Object.hasOwn(parsed, name))
      throw new Error("Incomplete auth trace header");
  }
  return parsed;
}

export function parseAuthServerTiming(value) {
  const timings = {};
  for (const rawMetric of (value ?? "").split(",")) {
    const [rawName, ...parameters] = rawMetric.trim().split(";");
    if (!AUTH_METRICS.has(rawName)) continue;
    const durationText = parameters
      .map((part) => part.trim())
      .find((part) => part.startsWith("dur="))
      ?.slice(4)
      .replace(/^"|"$/g, "");
    const duration = Number(durationText);
    if (!Number.isFinite(duration) || duration < 0) {
      throw new Error("Invalid auth Server-Timing duration");
    }
    timings[rawName] = duration;
  }
  return timings;
}

function boundedPlacement(value) {
  return /^(?:local|remote-[A-Z]{3})$/.test(value ?? "") ? value : "unknown";
}

function boundedColo(value) {
  const match = value?.match(/^[0-9a-f]+-([A-Z]{3})$/i);
  return match ? match[1].toUpperCase() : "unknown";
}

function assertRequiredTimings(timings, auth) {
  const required = [
    "auth_extract",
    "auth_cache_available",
    "auth_cache_read",
    "auth_resolve",
  ];
  if (auth.result === "authorized_origin") {
    required.push("auth_key_lookup", "auth_user_org", "auth_moderation");
    if (auth.write !== "deferred") required.push("auth_cache_write");
  }
  for (const name of required) {
    if (!Object.hasOwn(timings, name))
      throw new Error(`Missing required ${auth.result} timing`);
  }
}

export async function verifyDeployment(
  baseUrl,
  expectedSha,
  fetchImpl = fetch,
) {
  let response;
  try {
    response = await fetchImpl(`${baseUrl}/api/health`, {
      headers: { "user-agent": "eliza-inference-auth-latency/1.0" },
      signal: AbortSignal.timeout(30_000),
    });
  } catch (cause) {
    // error-policy:J2 context-adding rethrow: the outer boundary emits only the
    // bounded message, while local debugging retains the network cause.
    throw new Error("Worker health request failed", { cause });
  }
  if (!response.ok)
    throw new Error(`Worker health returned HTTP ${response.status}`);
  const body = await response.json();
  if (body?.commit !== expectedSha)
    throw new Error("Worker did not serve the expected commit");
  return {
    kind: "deployment",
    deploySha: expectedSha,
    environment:
      typeof body.environment === "string" &&
      /^[a-z0-9-]{1,64}$/.test(body.environment)
        ? body.environment
        : "unknown",
  };
}

export async function probeAuthSample({
  baseUrl,
  apiKey,
  probeToken,
  deploySha,
  phase,
  sequence,
  timeoutMs,
  fetchImpl = fetch,
  now = performance.now.bind(performance),
}) {
  const traceId = randomUUID();
  const headers = {
    "Content-Type": "application/json",
    "User-Agent": "eliza-inference-auth-latency/1.0",
    "X-API-Key": apiKey,
    [TRACE_HEADER]: traceId,
  };
  if (phase === "miss") {
    headers[AUTH_PROBE_HEADER] =
      `${probeToken}:${randomBytes(16).toString("hex")}`;
  }

  const startedAt = now();
  let response;
  try {
    response = await fetchImpl(`${baseUrl}/api/v1/chat/completions`, {
      method: "POST",
      headers,
      body: "{}",
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (cause) {
    // error-policy:J2 context-adding rethrow: never echo a request object that
    // carries credential headers through the CLI boundary.
    throw new Error("Auth probe request failed", { cause });
  }
  const totalMs = Math.round((now() - startedAt) * 100) / 100;
  if (response.status !== 400)
    throw new AuthProbeHttpStatusError(response.status);
  const returnedTraceId = response.headers.get(TRACE_HEADER);
  if (returnedTraceId !== traceId)
    throw new Error("Auth probe trace correlation failed");

  const auth = parseAuthTrace(response.headers.get(AUTH_TRACE_HEADER));
  const timings = parseAuthServerTiming(response.headers.get("server-timing"));
  assertRequiredTimings(timings, auth);
  if (auth.credential !== "x_api_key" || auth.backend !== "cloudflare_kv") {
    throw new Error(
      "Auth probe did not use the expected credential/cache path",
    );
  }
  if (
    phase === "hit" &&
    (auth.probe !== "off" ||
      auth.read !== "hit" ||
      auth.result !== "authorized_cache")
  ) {
    throw new Error("Warm auth probe did not produce a cache hit");
  }
  if (
    phase === "miss" &&
    (auth.probe !== "on" ||
      auth.read !== "miss" ||
      auth.authoritative !== "authorized" ||
      auth.write !== "deferred" ||
      auth.result !== "authorized_origin")
  ) {
    throw new Error(
      "Controlled auth probe did not produce an authoritative miss",
    );
  }
  if (
    phase === "prime" &&
    !(
      (auth.probe === "off" &&
        auth.read === "hit" &&
        auth.result === "authorized_cache") ||
      (auth.probe === "off" &&
        auth.read === "miss" &&
        auth.authoritative === "authorized" &&
        auth.write === "deferred" &&
        auth.result === "authorized_origin")
    )
  ) {
    throw new Error(
      "Canonical cache-prime request used an unexpected auth path",
    );
  }

  return {
    kind: "sample",
    deploySha,
    phase,
    sequence,
    traceId,
    status: response.status,
    placement: boundedPlacement(response.headers.get("cf-placement")),
    colo: boundedColo(response.headers.get("cf-ray")),
    totalMs,
    auth,
    timings,
  };
}

class AuthProbeHttpStatusError extends Error {
  constructor(status) {
    super(`Auth probe returned HTTP ${status}`);
    this.name = "AuthProbeHttpStatusError";
    this.status = status;
  }
}

/**
 * Prove a Wrangler Tail websocket is receiving authenticated invocations before
 * the retained sample window starts. Process liveness is insufficient because
 * Tail creation can remain pending while the CLI process is already running.
 */
export async function waitForInferenceAuthTail({
  baseUrl,
  apiKey,
  probeToken,
  deploySha,
  timeoutMs,
  readTail,
  attempts = 24,
  pollsPerAttempt = 10,
  pollIntervalMs = 250,
  fetchImpl = fetch,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
}) {
  if (
    typeof readTail !== "function" ||
    !Number.isInteger(attempts) ||
    attempts < 1 ||
    !Number.isInteger(pollsPerAttempt) ||
    pollsPerAttempt < 1 ||
    !Number.isInteger(pollIntervalMs) ||
    pollIntervalMs < 1
  ) {
    throw new Error("Invalid Worker Tail readiness configuration");
  }
  let routePropagationPending = false;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    let sample;
    try {
      sample = await probeAuthSample({
        baseUrl,
        apiKey,
        probeToken,
        deploySha,
        phase: "prime",
        sequence: attempt,
        timeoutMs,
        fetchImpl,
      });
    } catch (error) {
      // error-policy:J1 workers.dev can briefly return its propagation 404
      // after health is live; this readiness boundary retries only that status.
      if (
        !(error instanceof AuthProbeHttpStatusError) ||
        error.status !== 404
      ) {
        throw error;
      }
      routePropagationPending = true;
      await sleep(Math.max(pollIntervalMs, 1_000));
      continue;
    }
    routePropagationPending = false;
    for (let poll = 0; poll < pollsPerAttempt; poll++) {
      await sleep(pollIntervalMs);
      if (readTail().includes(sample.traceId)) return attempt;
    }
  }
  if (routePropagationPending) {
    throw new Error(
      "Worker route did not stabilize before Tail readiness completed",
    );
  }
  throw new Error(
    "Worker Tail did not observe an authenticated readiness trace",
  );
}

/** Exercise rejection and probe-authentication boundaries without retaining inputs. */
export async function probeAuthGuardSample({
  baseUrl,
  apiKey,
  probeToken,
  deploySha,
  guard,
  timeoutMs,
  fetchImpl = fetch,
  now = performance.now.bind(performance),
}) {
  if (
    guard !== "invalid_key" &&
    guard !== "suspended_key" &&
    guard !== "forged_probe"
  ) {
    throw new Error("Unknown auth guard probe");
  }
  const traceId = randomUUID();
  const headers = {
    "Content-Type": "application/json",
    "User-Agent": "eliza-inference-auth-latency/1.0",
    "X-API-Key":
      guard === "invalid_key"
        ? `eliza_${randomBytes(32).toString("hex")}`
        : apiKey,
    [TRACE_HEADER]: traceId,
  };
  if (guard === "forged_probe") {
    headers[AUTH_PROBE_HEADER] =
      `invalid-control:${randomBytes(16).toString("hex")}`;
  } else if (guard === "suspended_key") {
    headers[AUTH_PROBE_HEADER] =
      `${probeToken}:${randomBytes(16).toString("hex")}`;
  }

  const startedAt = now();
  let response;
  try {
    response = await fetchImpl(`${baseUrl}/api/v1/chat/completions`, {
      method: "POST",
      headers,
      body: "{}",
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (cause) {
    // error-policy:J2 context-adding rethrow: retain the network cause locally,
    // while the CLI boundary emits only this bounded message.
    throw new Error("Auth guard probe request failed", { cause });
  }
  const totalMs = Math.round((now() - startedAt) * 100) / 100;
  const expectedStatus =
    guard === "invalid_key" ? 401 : guard === "suspended_key" ? 403 : 400;
  if (response.status !== expectedStatus) {
    throw new Error(`Auth guard probe returned HTTP ${response.status}`);
  }
  if (response.headers.get(TRACE_HEADER) !== traceId) {
    throw new Error("Auth guard trace correlation failed");
  }
  const auth = parseAuthTrace(response.headers.get(AUTH_TRACE_HEADER));
  const timings = parseAuthServerTiming(response.headers.get("server-timing"));
  if (guard === "invalid_key") {
    if (
      auth.read !== "miss" ||
      auth.authoritative !== "rejected" ||
      auth.result !== "rejected" ||
      !Object.hasOwn(timings, "auth_key_lookup")
    ) {
      throw new Error(
        "Invalid-key probe did not preserve the 401 rejection path",
      );
    }
  } else if (guard === "suspended_key") {
    if (
      auth.probe !== "on" ||
      auth.read !== "miss" ||
      auth.authoritative !== "suspended" ||
      auth.write !== "not_run" ||
      auth.result !== "suspended" ||
      !Object.hasOwn(timings, "auth_moderation")
    ) {
      throw new Error(
        "Suspended-key probe did not preserve the 403 moderation path",
      );
    }
  } else if (
    auth.probe !== "off" ||
    auth.read !== "hit" ||
    auth.result !== "authorized_cache"
  ) {
    throw new Error("Forged probe control changed the cache decision");
  }

  return {
    kind: "guard",
    deploySha,
    guard,
    traceId,
    status: response.status,
    placement: boundedPlacement(response.headers.get("cf-placement")),
    colo: boundedColo(response.headers.get("cf-ray")),
    totalMs,
    auth,
    timings,
  };
}

function percentile(values, fraction) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)];
}

function metricSummary(records, selector) {
  const values = records
    .map(selector)
    .filter((value) => Number.isFinite(value));
  return {
    p50: percentile(values, 0.5),
    p90: percentile(values, 0.9),
    p95: percentile(values, 0.95),
    max: values.length === 0 ? null : Math.max(...values),
  };
}

/** Summarize the completed KV writes paired to authoritative miss traces. */
export function summarizeDeferredCacheWrites(workerLogs) {
  return metricSummary(
    workerLogs.filter(
      (record) => record.telemetry.result === "authorized_origin",
    ),
    (record) => record.deferredCacheWrite?.telemetry.durationMs,
  );
}

export function summarizeAuthSamples(records, deploySha) {
  const hits = records.filter((record) => record.phase === "hit");
  const misses = records.filter((record) => record.phase === "miss");
  return {
    kind: "summary",
    deploySha,
    counts: { hit: hits.length, miss: misses.length },
    hitAuthResolveMs: metricSummary(
      hits,
      (record) => record.timings.auth_resolve,
    ),
    missAuthResolveMs: metricSummary(
      misses,
      (record) => record.timings.auth_resolve,
    ),
    missKeyLookupMs: metricSummary(
      misses,
      (record) => record.timings.auth_key_lookup,
    ),
    missUserOrgMs: metricSummary(
      misses,
      (record) => record.timings.auth_user_org,
    ),
    missModerationMs: metricSummary(
      misses,
      (record) => record.timings.auth_moderation,
    ),
    missCacheReadMs: metricSummary(
      misses,
      (record) => record.timings.auth_cache_read,
    ),
    missCacheWriteMs: metricSummary(
      misses,
      (record) => record.timings.auth_cache_write,
    ),
  };
}

export function enforceAcceptance(summary) {
  if (summary.counts.hit < 30 || summary.counts.miss < 10) {
    throw new Error("Acceptance requires at least 30 hit and 10 miss samples");
  }
  if (
    summary.hitAuthResolveMs.p95 >= 50 ||
    summary.hitAuthResolveMs.max > 250
  ) {
    throw new Error("Cache-hit auth latency exceeded its acceptance threshold");
  }
  if (
    summary.missAuthResolveMs.p90 >= 1_602 ||
    summary.missAuthResolveMs.max >= 2_000
  ) {
    throw new Error("Authoritative auth latency retained a multi-second tail");
  }
}

function sleep(durationMs) {
  return new Promise((resolve) => setTimeout(resolve, durationMs));
}

export async function runAuthProbes(options, dependencies = {}) {
  const env = dependencies.env ?? process.env;
  const apiKey = env[options.apiKeyEnv];
  const suspendedApiKey = env[options.suspendedApiKeyEnv];
  const probeToken = env[options.probeTokenEnv];
  if (!apiKey)
    throw new Error("Auth probe API key environment variable is missing");
  if (!suspendedApiKey)
    throw new Error(
      "Suspended auth probe API key environment variable is missing",
    );
  if (!probeToken)
    throw new Error("Auth probe control-token environment variable is missing");
  const fetchImpl = dependencies.fetchImpl ?? fetch;
  const emit =
    dependencies.emit ??
    ((record) => process.stdout.write(`${JSON.stringify(record)}\n`));
  const wait = dependencies.sleep ?? sleep;

  const deployment = await verifyDeployment(
    options.baseUrl,
    options.deploySha,
    fetchImpl,
  );
  emit(deployment);

  // Populate the canonical IAC once; this request is intentionally not retained
  // because the acceptance sample begins only after the cache state is proven.
  await probeAuthSample({
    baseUrl: options.baseUrl,
    apiKey,
    probeToken,
    deploySha: options.deploySha,
    phase: "miss",
    sequence: -1,
    timeoutMs: options.timeoutMs,
    fetchImpl,
  });

  // Deferred KV population can finish after the miss response. Poll with
  // unretained canonical requests until one proves the cache hit, which also
  // absorbs edge/KV first-access cost before retained samples begin.
  let cachePrimed = false;
  for (let attempt = 0; attempt < 10; attempt++) {
    if (attempt > 0) await wait(250);
    const prime = await probeAuthSample({
      baseUrl: options.baseUrl,
      apiKey,
      deploySha: options.deploySha,
      phase: "prime",
      sequence: -1,
      timeoutMs: options.timeoutMs,
      fetchImpl,
    });
    if (prime.auth.result === "authorized_cache") {
      cachePrimed = true;
      break;
    }
  }
  if (!cachePrimed) {
    throw new Error("Canonical inference auth cache did not become readable");
  }

  const records = [];
  for (let sequence = 0; sequence < options.hitCount; sequence++) {
    const record = await probeAuthSample({
      baseUrl: options.baseUrl,
      apiKey,
      deploySha: options.deploySha,
      phase: "hit",
      sequence,
      timeoutMs: options.timeoutMs,
      fetchImpl,
    });
    records.push(record);
    emit(record);
    if (options.intervalMs > 0) await wait(options.intervalMs);
  }

  const guards = [];
  for (const guard of ["invalid_key", "suspended_key", "forged_probe"]) {
    const record = await probeAuthGuardSample({
      baseUrl: options.baseUrl,
      apiKey: guard === "suspended_key" ? suspendedApiKey : apiKey,
      probeToken,
      deploySha: options.deploySha,
      guard,
      timeoutMs: options.timeoutMs,
      fetchImpl,
    });
    guards.push(record);
    emit(record);
  }
  for (let sequence = 0; sequence < options.missCount; sequence++) {
    const record = await probeAuthSample({
      baseUrl: options.baseUrl,
      apiKey,
      probeToken,
      deploySha: options.deploySha,
      phase: "miss",
      sequence,
      timeoutMs: options.timeoutMs,
      fetchImpl,
    });
    records.push(record);
    emit(record);
    if (options.intervalMs > 0) await wait(options.intervalMs);
  }

  const summary = summarizeAuthSamples(records, options.deploySha);
  emit(summary);
  if (options.enforce) enforceAcceptance(summary);
  return { deployment, records, guards, summary };
}

export async function runCli(args = process.argv.slice(2)) {
  return await runAuthProbes(parseArgs(args));
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  runCli().catch((error) => {
    // error-policy:J1 CLI boundary: emit one bounded failure and a non-zero
    // status; raw response bodies, request headers, and nested causes stay out.
    process.stderr.write(
      `[inference-auth-latency] ${error instanceof Error ? error.message : "unknown failure"}\n`,
    );
    process.exitCode = 1;
  });
}
