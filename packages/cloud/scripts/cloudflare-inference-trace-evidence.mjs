/**
 * Collects Cloudflare Worker-to-Durable-Object traces for a completed staging
 * latency matrix and emits only coarse placement and rounded phase durations.
 * Raw telemetry and correlation identifiers never cross the private capture
 * directory boundary.
 */

import { writeFile } from "node:fs/promises";

const API_ORIGIN = "https://api.cloudflare.com/client/v4";
const STAGING_WORKER = "eliza-cloud-api-staging";
const GATE_ORIGIN = "https://inference-admission.internal";
const QUERY_TIMEOUT_MS = 30_000;
const QUERY_ATTEMPTS = 8;
const QUERY_RETRY_MS = 2_500;
const MAX_EVENTS = 2_000;
const MAX_TRACE_DURATION_MS = 300_000;
const TRACE_ID_PATTERN = /^[0-9a-f]{32}$/;
const EVENT_ID_PATTERN = /^[A-Za-z0-9_.:-]{1,256}$/;
const CF_RAY_PATTERN = /^([0-9a-f]{16,32})-([A-Z]{3})$/i;
const COLO_PATTERN = /^[A-Z]{3}$/;
const REQUIRED_KEYS = new Map([
  ["$metadata.duration", "number"],
  ["$metadata.parentSpanId", "string"],
  ["$metadata.rayId", "string"],
  ["$metadata.region", "string"],
  ["$metadata.service", "string"],
  ["$metadata.spanId", "string"],
  ["$metadata.spanName", "string"],
  ["$metadata.traceId", "string"],
  ["$metadata.url", "string"],
]);
const PHASE_BY_PATH = new Map([
  ["/rate-limit", "rate"],
  ["/lease-dispatched", "billing"],
  ["/lease-dispatched-authorized", "billing"],
]);

export class CloudflareTraceSchemaError extends Error {
  constructor(message, options) {
    super(message, options);
    this.name = "CloudflareTraceSchemaError";
  }
}

function object(value) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value
    : null;
}

function roundDuration(value, label) {
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    value < 0 ||
    value > MAX_TRACE_DURATION_MS
  ) {
    throw new CloudflareTraceSchemaError(
      `Cloudflare trace ${label} is invalid`,
    );
  }
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

function optionalDuration(value, label) {
  return value === undefined ? null : roundDuration(value, label);
}

function coarseColo(value) {
  if (typeof value !== "string") return null;
  const normalized = value.toUpperCase();
  return COLO_PATTERN.test(normalized) ? normalized : null;
}

function parseJson(text, label) {
  try {
    return JSON.parse(text);
  } catch (cause) {
    // error-policy:J2 retain the parser cause privately while the public error
    // contains no response bytes.
    throw new CloudflareTraceSchemaError(
      `Cloudflare ${label} response is not valid JSON`,
      { cause },
    );
  }
}

function readEnvelope(text, label, arrayResult = false) {
  const envelope = object(parseJson(text, label));
  if (
    envelope?.success !== true ||
    !Array.isArray(envelope.errors) ||
    envelope.errors.length !== 0 ||
    !(arrayResult ? Array.isArray(envelope.result) : object(envelope.result))
  ) {
    throw new CloudflareTraceSchemaError(
      `Cloudflare ${label} response failed its envelope contract`,
    );
  }
  return envelope.result;
}

export function pairedGatewayTraceWindow(records) {
  const references = [];
  const seenRays = new Set();
  for (const record of records) {
    if (record?.target !== "gateway") continue;
    const observedAt = Date.parse(record.observedAt);
    const rayHeader = record.headers?.["cf-ray"];
    const match =
      typeof rayHeader === "string" ? CF_RAY_PATTERN.exec(rayHeader) : null;
    if (
      !match ||
      !Number.isSafeInteger(record.sequence) ||
      record.sequence < 0 ||
      !Number.isFinite(observedAt)
    ) {
      throw new CloudflareTraceSchemaError(
        "Gateway latency evidence lacks trace correlation metadata",
      );
    }
    const rayId = match[1].toLowerCase();
    if (seenRays.has(rayId)) {
      throw new CloudflareTraceSchemaError(
        "Gateway latency evidence reused a Cloudflare Ray",
      );
    }
    seenRays.add(rayId);
    references.push({
      rayId,
      sequence: record.sequence,
      workerColo: match[2].toUpperCase(),
      observedAt,
    });
  }
  if (references.length !== 22) {
    throw new CloudflareTraceSchemaError(
      "Gateway latency evidence must contain 22 traceable requests",
    );
  }
  const observed = references.map((reference) => reference.observedAt);
  return {
    references,
    timeframe: {
      from: Math.floor(Math.min(...observed) - 30_000),
      to: Math.ceil(Math.max(...observed) + 30_000),
    },
  };
}

export function buildTraceKeysRequest(timeframe) {
  return {
    from: timeframe.from,
    to: timeframe.to,
    keyNeedle: { value: "$metadata.", isRegex: false, matchCase: true },
    limit: 1_000,
  };
}

export function validateTraceKeysResponse(text) {
  const result = readEnvelope(text, "trace keys", true);
  if (!Array.isArray(result)) {
    throw new CloudflareTraceSchemaError(
      "Cloudflare trace keys response has no key list",
    );
  }
  const discovered = new Map();
  for (const item of result) {
    const entry = object(item);
    if (
      entry &&
      typeof entry.key === "string" &&
      (entry.type === "string" ||
        entry.type === "number" ||
        entry.type === "boolean")
    ) {
      discovered.set(entry.key, entry.type);
    }
  }
  for (const [key, type] of REQUIRED_KEYS) {
    if (discovered.get(key) !== type) {
      throw new CloudflareTraceSchemaError(
        `Cloudflare trace key contract changed for ${key}`,
      );
    }
  }
  return Object.fromEntries(REQUIRED_KEYS);
}

function filter(key, value) {
  return { kind: "filter", key, operation: "eq", type: "string", value };
}

export function buildRootTraceQuery(timeframe, references) {
  return {
    queryId: "eliza-inference-trace-roots-v1",
    timeframe,
    dry: true,
    limit: 100,
    view: "traces",
    parameters: {
      filterCombination: "and",
      filters: [
        filter("$metadata.service", STAGING_WORKER),
        {
          kind: "group",
          filterCombination: "or",
          filters: references.map((reference) =>
            filter("$metadata.rayId", reference.rayId),
          ),
        },
      ],
    },
  };
}

export function buildTraceEventsQuery(timeframe, traceId) {
  if (!TRACE_ID_PATTERN.test(traceId)) {
    throw new CloudflareTraceSchemaError(
      "Cloudflare returned an invalid trace correlation identifier",
    );
  }
  return {
    queryId: "eliza-inference-trace-events-v1",
    timeframe,
    dry: true,
    limit: MAX_EVENTS,
    view: "events",
    parameters: {
      filterCombination: "and",
      filters: [
        filter("$metadata.service", STAGING_WORKER),
        filter("$metadata.traceId", traceId),
      ],
    },
  };
}

function readCompletedRun(result, label) {
  const run = object(result.run);
  if (!run || (run.status !== "STARTED" && run.status !== "COMPLETED")) {
    throw new CloudflareTraceSchemaError(
      `Cloudflare ${label} response has an invalid run state`,
    );
  }
  return run.status === "COMPLETED";
}

export function parseRootTraceResponse(text) {
  const result = readEnvelope(text, "root trace query");
  if (!readCompletedRun(result, "root trace query")) {
    return { completed: false, traceIds: [] };
  }
  if (!Array.isArray(result.traces)) {
    throw new CloudflareTraceSchemaError(
      "Cloudflare root trace query has no trace summaries",
    );
  }
  const traceIds = [];
  const seen = new Set();
  for (const value of result.traces) {
    const trace = object(value);
    if (
      !trace ||
      !TRACE_ID_PATTERN.test(trace.traceId) ||
      !Array.isArray(trace.service) ||
      !trace.service.includes(STAGING_WORKER)
    ) {
      throw new CloudflareTraceSchemaError(
        "Cloudflare root trace summary changed schema",
      );
    }
    if (!seen.has(trace.traceId)) {
      seen.add(trace.traceId);
      traceIds.push(trace.traceId);
    }
  }
  if (traceIds.length > 22) {
    throw new CloudflareTraceSchemaError(
      "Cloudflare root trace query exceeded the request matrix",
    );
  }
  return { completed: true, traceIds };
}

export function parseTraceEventsResponse(text) {
  const result = readEnvelope(text, "trace events query");
  if (!readCompletedRun(result, "trace events query")) {
    return { completed: false, events: [] };
  }
  const events = object(result.events);
  if (!events || !Array.isArray(events.events)) {
    throw new CloudflareTraceSchemaError(
      "Cloudflare trace events query has no event list",
    );
  }
  if (
    events.count !== undefined &&
    (!Number.isSafeInteger(events.count) || events.count < events.events.length)
  ) {
    throw new CloudflareTraceSchemaError(
      "Cloudflare trace events query returned an invalid total",
    );
  }
  if (events.events.length > MAX_EVENTS) {
    throw new CloudflareTraceSchemaError(
      "Cloudflare trace events query exceeded its page limit",
    );
  }
  return {
    completed: true,
    events: events.events,
    total: events.count ?? null,
  };
}

function phaseForEvent(event) {
  const metadata = object(event?.$metadata);
  if (metadata?.spanName !== "durable_object_subrequest") return null;
  if (typeof metadata.url !== "string") {
    throw new CloudflareTraceSchemaError(
      "Cloudflare Durable Object subrequest has no URL classification",
    );
  }
  let url;
  try {
    url = new URL(metadata.url);
  } catch (cause) {
    // error-policy:J2 retain URL parser context without exposing the raw URL.
    throw new CloudflareTraceSchemaError(
      "Cloudflare Durable Object subrequest URL is invalid",
      { cause },
    );
  }
  if (url.origin !== GATE_ORIGIN) return null;
  const phase = PHASE_BY_PATH.get(url.pathname);
  if (!phase) {
    throw new CloudflareTraceSchemaError(
      "Cloudflare inference admission trace contains an unknown phase",
    );
  }
  return phase;
}

function requireMetadata(event) {
  const metadata = object(event?.$metadata);
  if (
    !metadata ||
    typeof metadata.id !== "string" ||
    !EVENT_ID_PATTERN.test(metadata.id) ||
    typeof metadata.traceId !== "string" ||
    !TRACE_ID_PATTERN.test(metadata.traceId) ||
    typeof metadata.service !== "string" ||
    metadata.service !== STAGING_WORKER
  ) {
    throw new CloudflareTraceSchemaError(
      "Cloudflare trace event changed its metadata schema",
    );
  }
  return metadata;
}

function isDescendant(metadata, ancestorSpanId, bySpanId) {
  const visited = new Set();
  let parent = metadata.parentSpanId;
  while (typeof parent === "string" && !visited.has(parent)) {
    if (parent === ancestorSpanId) return true;
    visited.add(parent);
    parent = bySpanId.get(parent)?.parentSpanId;
  }
  return false;
}

function sanitizePhase(subrequest, phase, events, bySpanId) {
  const metadata = requireMetadata(subrequest);
  if (typeof metadata.spanId !== "string") {
    throw new CloudflareTraceSchemaError(
      "Cloudflare Durable Object subrequest has no span identity",
    );
  }
  const roots = events.filter((event) => {
    const childMetadata = requireMetadata(event);
    const workers = object(event.$workers);
    return (
      childMetadata.parentSpanId === metadata.spanId &&
      workers?.entrypoint === "InferenceAdmissionGate" &&
      workers.executionModel === "durableObject"
    );
  });
  if (roots.length !== 1) return null;
  const root = roots[0];
  const rootMetadata = requireMetadata(root);
  if (typeof rootMetadata.spanId !== "string") return null;
  const workers = object(root.$workers);
  const doColo = coarseColo(rootMetadata.region);
  if (!doColo) return null;
  const storage = events.filter((event) => {
    const candidate = requireMetadata(event);
    return (
      typeof candidate.spanName === "string" &&
      candidate.spanName.startsWith("durable_object_storage_") &&
      isDescendant(candidate, rootMetadata.spanId, bySpanId)
    );
  });
  let storageMs = 0;
  for (const event of storage) {
    storageMs += roundDuration(
      requireMetadata(event).duration,
      "storage duration",
    );
  }
  return {
    phase,
    workerColo: coarseColo(metadata.region),
    doColo,
    subrequestMs: roundDuration(metadata.duration, "subrequest duration"),
    doWallMs: optionalDuration(
      workers.wallTimeMs ?? rootMetadata.duration,
      "Durable Object wall duration",
    ),
    storageMs: Math.round(storageMs * 100) / 100,
    storageSpans: storage.length,
  };
}

export function sanitizeTraceEvents(rawEvents, references) {
  const events = rawEvents.map((event) => {
    const value = object(event);
    if (!value) {
      throw new CloudflareTraceSchemaError(
        "Cloudflare trace event is not an object",
      );
    }
    requireMetadata(value);
    return value;
  });
  const bySpanId = new Map();
  for (const event of events) {
    const metadata = requireMetadata(event);
    if (typeof metadata.spanId === "string")
      bySpanId.set(metadata.spanId, metadata);
  }
  const rayRoots = events.filter((event) => {
    const metadata = requireMetadata(event);
    return typeof metadata.rayId === "string";
  });
  const matchedReferences = new Set();
  for (const event of rayRoots) {
    const rayId = requireMetadata(event).rayId.toLowerCase();
    const reference = references.find((candidate) => candidate.rayId === rayId);
    if (reference) matchedReferences.add(reference);
  }
  if (matchedReferences.size !== 1) return null;
  const [reference] = matchedReferences;
  const workerRoots = rayRoots.filter((event) => {
    const metadata = requireMetadata(event);
    return (
      metadata.rayId.toLowerCase() === reference.rayId &&
      metadata.spanName === "fetch" &&
      object(event.$workers)?.executionModel === "stateless"
    );
  });
  if (workerRoots.length !== 1) return null;
  const workerColo = coarseColo(requireMetadata(workerRoots[0]).region);
  if (!workerColo) return null;
  const subrequests = events
    .map((event) => ({ event, phase: phaseForEvent(event) }))
    .filter((candidate) => candidate.phase !== null);
  const counts = new Map();
  for (const candidate of subrequests) {
    counts.set(candidate.phase, (counts.get(candidate.phase) ?? 0) + 1);
  }
  if (counts.get("rate") !== 1 || counts.get("billing") !== 1) return null;
  const phases = subrequests.map(({ event, phase }) =>
    sanitizePhase(event, phase, events, bySpanId),
  );
  if (phases.some((phase) => phase === null)) return null;
  return {
    sample: reference.sequence,
    ingressColo: reference.workerColo,
    workerColo,
    workerWallMs: roundDuration(
      requireMetadata(workerRoots[0]).duration,
      "Worker root duration",
    ),
    phases: Object.fromEntries(phases.map((phase) => [phase.phase, phase])),
  };
}

async function writeRaw(directory, sequence, label, text) {
  const path = `${directory}/${String(sequence).padStart(3, "0")}-${label}.json`;
  await writeFile(path, text, { mode: 0o600, flag: "wx" });
}

async function apiRequest({
  accountId,
  apiToken,
  endpoint,
  body,
  privateDirectory,
  rawSequence,
  rawLabel,
  fetchImpl,
}) {
  let response;
  try {
    response = await fetchImpl(
      `${API_ORIGIN}/accounts/${encodeURIComponent(accountId)}/workers/observability/telemetry/${endpoint}`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(QUERY_TIMEOUT_MS),
      },
    );
  } catch (cause) {
    // error-policy:J2 preserve the transport cause without copying its URL or
    // credential-bearing request into the bounded diagnostic message.
    throw new CloudflareTraceSchemaError(
      "Cloudflare trace telemetry request failed",
      { cause },
    );
  }
  const text = await response.text();
  await writeRaw(privateDirectory, rawSequence, rawLabel, text);
  if (!response.ok) {
    throw new CloudflareTraceSchemaError(
      `Cloudflare trace telemetry returned HTTP ${response.status}`,
    );
  }
  return text;
}

async function completedQuery(options, body, parser, label, state) {
  for (let attempt = 0; attempt < QUERY_ATTEMPTS; attempt++) {
    if (attempt > 0) await options.sleepImpl(QUERY_RETRY_MS);
    const text = await apiRequest({
      ...options,
      endpoint: "query",
      body,
      rawSequence: state.rawSequence++,
      rawLabel: `${label}-${attempt + 1}`,
    });
    const parsed = parser(text);
    if (parsed.completed) return parsed;
  }
  throw new CloudflareTraceSchemaError(
    `Cloudflare ${label} query did not complete`,
  );
}

async function completeTraceEvents(options, body, state) {
  const events = [];
  const seenIds = new Set();
  let offset;
  let total = null;
  // Bound diagnostic work explicitly; never report partial pages as a trace.
  for (let page = 0; page < 20; page++) {
    const response = await completedQuery(
      options,
      { ...body, ...(offset === undefined ? {} : { offset }) },
      parseTraceEventsResponse,
      "events",
      state,
    );
    if (total !== null && response.total !== null && total !== response.total) {
      throw new CloudflareTraceSchemaError(
        "Cloudflare trace total changed during pagination",
      );
    }
    total = response.total ?? total;
    for (const event of response.events) {
      const metadata = requireMetadata(event);
      if (
        metadata.traceId !== body.parameters.filters[1].value ||
        seenIds.has(metadata.id)
      ) {
        throw new CloudflareTraceSchemaError(
          "Cloudflare trace pagination returned unrelated or repeated events",
        );
      }
      seenIds.add(metadata.id);
      events.push(event);
    }
    if (total !== null && events.length > total) {
      throw new CloudflareTraceSchemaError(
        "Cloudflare trace pagination exceeded its total",
      );
    }
    if (
      total !== null
        ? events.length === total
        : response.events.length < MAX_EVENTS
    )
      return events;
    if (response.events.length === 0) {
      throw new CloudflareTraceSchemaError(
        "Cloudflare trace pagination ended before its total",
      );
    }
    offset = requireMetadata(response.events.at(-1)).id;
  }
  throw new CloudflareTraceSchemaError(
    "Cloudflare trace pagination exceeded its diagnostic budget",
  );
}

export async function collectInferenceTraceEvidence({
  pairedRecords,
  deploySha,
  accountId,
  apiToken,
  privateDirectory,
  fetchImpl = fetch,
  sleepImpl = (duration) =>
    new Promise((resolvePromise) => setTimeout(resolvePromise, duration)),
}) {
  const { references, timeframe } = pairedGatewayTraceWindow(pairedRecords);
  const state = { rawSequence: 1 };
  const requestOptions = {
    accountId,
    apiToken,
    privateDirectory,
    fetchImpl,
    sleepImpl,
  };
  const keysText = await apiRequest({
    ...requestOptions,
    endpoint: "keys",
    body: buildTraceKeysRequest(timeframe),
    rawSequence: state.rawSequence++,
    rawLabel: "keys",
  });
  validateTraceKeysResponse(keysText);
  const rootQuery = await completedQuery(
    requestOptions,
    buildRootTraceQuery(timeframe, references),
    parseRootTraceResponse,
    "roots",
    state,
  );
  const complete = [];
  let incompleteTraces = 0;
  for (const traceId of rootQuery.traceIds) {
    const events = await completeTraceEvents(
      requestOptions,
      buildTraceEventsQuery(timeframe, traceId),
      state,
    );
    const sample = sanitizeTraceEvents(events, references);
    if (sample) complete.push(sample);
    else incompleteTraces++;
  }
  complete.sort((left, right) => left.sample - right.sample);
  const status = complete.length > 0 ? "observed" : "inconclusive_sampling";
  return {
    schemaVersion: 1,
    kind: "inference_distributed_trace_evidence",
    deploySha,
    environment: "staging",
    status,
    reason:
      status === "observed"
        ? null
        : rootQuery.traceIds.length === 0
          ? "no_sampled_traces"
          : "sampled_traces_incomplete",
    coverage: {
      gatewayRequests: references.length,
      sampledTraces: rootQuery.traceIds.length,
      completeTraces: complete.length,
      incompleteTraces,
    },
    samples: complete,
  };
}
