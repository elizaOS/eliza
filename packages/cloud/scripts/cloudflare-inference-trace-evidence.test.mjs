/**
 * Exercises the real Cloudflare Observability response boundary with synthetic
 * API envelopes; no network, credentials, or provider calls are used.
 */

import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  buildRootTraceQuery,
  buildTraceEventsQuery,
  buildTraceKeysRequest,
  CloudflareTraceSchemaError,
  collectInferenceTraceEvidence,
  pairedGatewayTraceWindow,
  parseRootTraceResponse,
  parseTraceEventsResponse,
  sanitizeTraceEvents,
  validateTraceKeysResponse,
} from "./cloudflare-inference-trace-evidence.mjs";

const SHA = "a".repeat(40);
const TRACE_A = "1".repeat(32);
const TRACE_B = "2".repeat(32);
const REQUIRED_KEYS = [
  ["$metadata.duration", "number"],
  ["$metadata.parentSpanId", "string"],
  ["$metadata.rayId", "string"],
  ["$metadata.region", "string"],
  ["$metadata.service", "string"],
  ["$metadata.spanId", "string"],
  ["$metadata.spanName", "string"],
  ["$metadata.traceId", "string"],
  ["$metadata.url", "string"],
];

function apiEnvelope(result) {
  return JSON.stringify({ success: true, errors: [], messages: [], result });
}

function keysEnvelope(overrides = REQUIRED_KEYS) {
  return apiEnvelope(
    overrides.map(([key, type], index) => ({
      key,
      type,
      lastSeenAt: 1_780_000_000_000 + index,
    })),
  );
}

function pairedRecords() {
  const records = [];
  for (let index = 0; index < 22; index++) {
    records.push({
      target: "gateway",
      sequence: index + 1,
      observedAt: new Date(1_780_000_000_000 + index * 500).toISOString(),
      headers: {
        "cf-ray": `${(index + 1).toString(16).padStart(16, "0")}-ORD`,
      },
    });
    records.push({ target: "direct", sequence: index + 1 });
  }
  return records;
}

function event({
  id,
  traceId = TRACE_A,
  spanId,
  parentSpanId,
  spanName,
  duration,
  region,
  rayId,
  url,
  workers,
  privateValue = "private-request-value",
}) {
  return {
    $metadata: {
      id,
      traceId,
      service: "eliza-cloud-api-staging",
      spanId,
      ...(parentSpanId && { parentSpanId }),
      spanName,
      duration,
      region,
      ...(rayId && { rayId }),
      ...(url && { url }),
      secretMetadata: privateValue,
    },
    dataset: "cloudflare-workers",
    timestamp: 1_780_000_000_000,
    source: {
      headers: { authorization: privateValue },
      requestBody: privateValue,
      url: `https://private.invalid/${privateValue}`,
    },
    ...(workers
      ? {
          $workers: {
            ...workers,
            durableObjectId: privateValue,
            event: { body: privateValue },
            requestId: privateValue,
          },
        }
      : {}),
  };
}

function completeTraceEvents({
  traceId = TRACE_A,
  rayId = "0000000000000001",
  privateValue,
} = {}) {
  return [
    event({
      id: "root",
      traceId,
      spanId: "span-root",
      spanName: "fetch",
      duration: 185,
      region: "ORD",
      rayId,
      url: "https://api-staging.eliza.app/api/v1/chat/completions",
      workers: {
        eventType: "fetch",
        scriptName: "eliza-cloud-api-staging",
        executionModel: "stateless",
      },
      privateValue,
    }),
    event({
      id: "rate-subrequest",
      traceId,
      spanId: "span-rate-subrequest",
      parentSpanId: "span-root",
      spanName: "durable_object_subrequest",
      duration: 58.123,
      region: "ORD",
      url: "https://inference-admission.internal/rate-limit",
      privateValue,
    }),
    event({
      id: "rate-root",
      traceId,
      spanId: "span-rate-root",
      parentSpanId: "span-rate-subrequest",
      spanName: "fetch",
      duration: 4.5,
      region: "EWR",
      workers: {
        eventType: "fetch",
        scriptName: "eliza-cloud-api-staging",
        executionModel: "durableObject",
        entrypoint: "InferenceAdmissionGate",
        wallTimeMs: 4.456,
      },
      privateValue,
    }),
    event({
      id: "rate-storage",
      traceId,
      spanId: "span-rate-storage",
      parentSpanId: "span-rate-root",
      spanName: "durable_object_storage_kv_put",
      duration: 1.255,
      region: "EWR",
      privateValue,
    }),
    event({
      id: "billing-subrequest",
      traceId,
      spanId: "span-billing-subrequest",
      parentSpanId: "span-root",
      spanName: "durable_object_subrequest",
      duration: 49.987,
      region: "ORD",
      url: "https://inference-admission.internal/lease-dispatched-authorized",
      privateValue,
    }),
    event({
      id: "billing-root",
      traceId,
      spanId: "span-billing-root",
      parentSpanId: "span-billing-subrequest",
      spanName: "fetch",
      duration: 5.5,
      region: "IAD",
      workers: {
        eventType: "fetch",
        scriptName: "eliza-cloud-api-staging",
        executionModel: "durableObject",
        entrypoint: "InferenceAdmissionGate",
        wallTimeMs: 5.444,
      },
      privateValue,
    }),
    event({
      id: "billing-storage-one",
      traceId,
      spanId: "span-billing-storage-one",
      parentSpanId: "span-billing-root",
      spanName: "durable_object_storage_kv_put",
      duration: 1.1,
      region: "IAD",
      privateValue,
    }),
    event({
      id: "billing-storage-two",
      traceId,
      spanId: "span-billing-storage-two",
      parentSpanId: "span-billing-storage-one",
      spanName: "durable_object_storage_alarms_setAlarm",
      duration: 0.25,
      region: "IAD",
      privateValue,
    }),
  ];
}

function queryEnvelope(view, value, status = "COMPLETED") {
  return apiEnvelope({
    run: { status },
    statistics: { bytes_read: 1, elapsed: 0.01, rows_read: 1 },
    ...(view === "traces" ? { traces: value } : {}),
    ...(view === "events"
      ? {
          events: {
            count: value.length,
            events: value,
            fields: [],
            series: [],
          },
        }
      : {}),
  });
}

test("gateway references produce one bounded exact request window", () => {
  const result = pairedGatewayTraceWindow(pairedRecords());
  assert.equal(result.references.length, 22);
  assert.deepEqual(result.references[0], {
    rayId: "0000000000000001",
    sequence: 1,
    workerColo: "ORD",
    observedAt: 1_780_000_000_000,
  });
  assert.deepEqual(result.timeframe, {
    from: 1_779_999_970_000,
    to: 1_780_000_040_500,
  });
  assert.throws(
    () =>
      pairedGatewayTraceWindow(
        pairedRecords().map((record, index) =>
          index === 0
            ? { ...record, headers: { "cf-ray": "invalid" } }
            : record,
        ),
      ),
    CloudflareTraceSchemaError,
  );
});

test("request builders use only official ad-hoc telemetry query fields", () => {
  const { references, timeframe } = pairedGatewayTraceWindow(pairedRecords());
  assert.deepEqual(buildTraceKeysRequest(timeframe), {
    from: timeframe.from,
    to: timeframe.to,
    keyNeedle: { value: "$metadata.", isRegex: false, matchCase: true },
    limit: 1_000,
  });
  const roots = buildRootTraceQuery(timeframe, references);
  assert.equal(roots.view, "traces");
  assert.equal(roots.dry, true);
  assert.equal(roots.parameters.filters[1].filters.length, 22);
  const events = buildTraceEventsQuery(timeframe, TRACE_A);
  assert.equal(events.view, "events");
  assert.deepEqual(events.parameters.filters[1], {
    kind: "filter",
    key: "$metadata.traceId",
    operation: "eq",
    type: "string",
    value: TRACE_A,
  });
});

test("key discovery validates every filter and sanitizer field before querying", () => {
  assert.equal(
    validateTraceKeysResponse(keysEnvelope())["$metadata.traceId"],
    "string",
  );
  assert.throws(
    () => validateTraceKeysResponse(keysEnvelope(REQUIRED_KEYS.slice(1))),
    /key contract changed/,
  );
  assert.throws(
    () =>
      validateTraceKeysResponse(
        keysEnvelope(
          REQUIRED_KEYS.map(([key, type]) => [
            key,
            key === "$metadata.duration" ? "string" : type,
          ]),
        ),
      ),
    /duration/,
  );
});

test("query parsers distinguish incomplete runs, zero samples, and multiple samples", () => {
  assert.deepEqual(
    parseRootTraceResponse(queryEnvelope("traces", [], "STARTED")),
    { completed: false, traceIds: [] },
  );
  assert.deepEqual(parseRootTraceResponse(queryEnvelope("traces", [])), {
    completed: true,
    traceIds: [],
  });
  assert.deepEqual(
    parseRootTraceResponse(
      queryEnvelope(
        "traces",
        [TRACE_A, TRACE_B].map((traceId) => ({
          rootSpanName: "fetch",
          rootTransactionName: "POST /api/v1/chat/completions",
          service: ["eliza-cloud-api-staging"],
          spans: 8,
          traceDurationMs: 185,
          traceStartMs: 1_780_000_000_000,
          traceEndMs: 1_780_000_000_185,
          traceId,
        })),
      ),
    ),
    { completed: true, traceIds: [TRACE_A, TRACE_B] },
  );
  assert.equal(
    parseTraceEventsResponse(queryEnvelope("events", completeTraceEvents()))
      .events.length,
    8,
  );
  assert.throws(
    () =>
      parseTraceEventsResponse(
        apiEnvelope({
          run: { status: "COMPLETED" },
          events: { count: 7, events: completeTraceEvents() },
        }),
      ),
    /invalid total/,
  );
});

test("sanitizer emits only phase, coarse colo, rounded duration, and coverage inputs", () => {
  const privateValue = "secret-account-request-object-id";
  const { references } = pairedGatewayTraceWindow(pairedRecords());
  const sample = sanitizeTraceEvents(
    completeTraceEvents({ privateValue }),
    references,
  );
  assert.deepEqual(sample, {
    sample: 1,
    workerColo: "ORD",
    phases: {
      rate: {
        phase: "rate",
        workerColo: "ORD",
        doColo: "EWR",
        subrequestMs: 58.12,
        doWallMs: 4.46,
        storageMs: 1.26,
        storageSpans: 1,
      },
      billing: {
        phase: "billing",
        workerColo: "ORD",
        doColo: "IAD",
        subrequestMs: 49.99,
        doWallMs: 5.44,
        storageMs: 1.35,
        storageSpans: 2,
      },
    },
  });
  const serialized = JSON.stringify(sample);
  assert.equal(serialized.includes(privateValue), false);
  for (const forbidden of [
    "traceId",
    "spanId",
    "rayId",
    "requestId",
    "durableObjectId",
    "authorization",
    "headers",
    "source",
    "url",
  ]) {
    assert.equal(serialized.includes(forbidden), false);
  }
});

test("unknown admission paths fail closed while missing sampled spans remain inconclusive", () => {
  const { references } = pairedGatewayTraceWindow(pairedRecords());
  const unknown = completeTraceEvents();
  unknown.find(
    (value) => value.$metadata.id === "rate-subrequest",
  ).$metadata.url = "https://inference-admission.internal/unreviewed-operation";
  assert.throws(
    () => sanitizeTraceEvents(unknown, references),
    /unknown phase/,
  );
  assert.equal(
    sanitizeTraceEvents(
      completeTraceEvents().filter(
        (value) => value.$metadata.id !== "billing-root",
      ),
      references,
    ),
    null,
  );
});

test("collector reports zero sampled traces explicitly and removes no privacy fields", async () => {
  const directory = await mkdtemp(join(tmpdir(), "eliza-trace-boundary-"));
  const calls = [];
  try {
    const evidence = await collectInferenceTraceEvidence({
      pairedRecords: pairedRecords(),
      deploySha: SHA,
      accountId: "private-account-id",
      apiToken: "private-api-token",
      privateDirectory: directory,
      sleepImpl: async () => {},
      fetchImpl: async (url, init) => {
        calls.push({ url, init });
        return new Response(
          calls.length === 1 ? keysEnvelope() : queryEnvelope("traces", []),
        );
      },
    });
    assert.equal(evidence.status, "inconclusive_sampling");
    assert.equal(evidence.reason, "no_sampled_traces");
    assert.deepEqual(evidence.coverage, {
      gatewayRequests: 22,
      sampledTraces: 0,
      completeTraces: 0,
      incompleteTraces: 0,
    });
    assert.deepEqual(evidence.samples, []);
    assert.equal(calls.length, 2);
    assert.match(calls[0].url, /\/telemetry\/keys$/);
    assert.equal(calls[0].init.method, "POST");
    assert.equal(
      calls[0].init.headers.Authorization,
      "Bearer private-api-token",
    );
    const serialized = JSON.stringify(evidence);
    assert.equal(serialized.includes("private-account-id"), false);
    assert.equal(serialized.includes("private-api-token"), false);
    assert.equal(
      (await readFile(join(directory, "001-keys.json"), "utf8")).length > 0,
      true,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("collector sanitizes one complete sampled trace and polls STARTED runs", async () => {
  const directory = await mkdtemp(join(tmpdir(), "eliza-trace-boundary-"));
  const responses = [
    keysEnvelope(),
    queryEnvelope("traces", [], "STARTED"),
    queryEnvelope("traces", [
      {
        rootSpanName: "fetch",
        rootTransactionName: "POST /api/v1/chat/completions",
        service: ["eliza-cloud-api-staging"],
        spans: 8,
        traceDurationMs: 185,
        traceStartMs: 1_780_000_000_000,
        traceEndMs: 1_780_000_000_185,
        traceId: TRACE_A,
      },
    ]),
    queryEnvelope("events", completeTraceEvents()),
  ];
  let sleeps = 0;
  try {
    const evidence = await collectInferenceTraceEvidence({
      pairedRecords: pairedRecords(),
      deploySha: SHA,
      accountId: "private-account-id",
      apiToken: "private-api-token",
      privateDirectory: directory,
      sleepImpl: async () => {
        sleeps++;
      },
      fetchImpl: async () => new Response(responses.shift()),
    });
    assert.equal(evidence.status, "observed");
    assert.equal(evidence.reason, null);
    assert.equal(evidence.samples.length, 1);
    assert.equal(evidence.coverage.sampledTraces, 1);
    assert.equal(evidence.coverage.completeTraces, 1);
    assert.equal(sleeps, 1);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("collector returns sampled-trace incompleteness without fabricating placement", async () => {
  const directory = await mkdtemp(join(tmpdir(), "eliza-trace-boundary-"));
  const incomplete = completeTraceEvents().filter(
    (value) => value.$metadata.id !== "billing-root",
  );
  const responses = [
    keysEnvelope(),
    queryEnvelope("traces", [
      {
        rootSpanName: "fetch",
        rootTransactionName: "POST /api/v1/chat/completions",
        service: ["eliza-cloud-api-staging"],
        spans: incomplete.length,
        traceDurationMs: 185,
        traceStartMs: 1_780_000_000_000,
        traceEndMs: 1_780_000_000_185,
        traceId: TRACE_A,
      },
    ]),
    queryEnvelope("events", incomplete),
  ];
  try {
    const evidence = await collectInferenceTraceEvidence({
      pairedRecords: pairedRecords(),
      deploySha: SHA,
      accountId: "private-account-id",
      apiToken: "private-api-token",
      privateDirectory: directory,
      sleepImpl: async () => {},
      fetchImpl: async () => new Response(responses.shift()),
    });
    assert.equal(evidence.status, "inconclusive_sampling");
    assert.equal(evidence.reason, "sampled_traces_incomplete");
    assert.deepEqual(evidence.samples, []);
    assert.equal(evidence.coverage.incompleteTraces, 1);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("API failures never copy private response content into errors", async () => {
  const directory = await mkdtemp(join(tmpdir(), "eliza-trace-boundary-"));
  try {
    const error = await collectInferenceTraceEvidence({
      pairedRecords: pairedRecords(),
      deploySha: SHA,
      accountId: "private-account-id",
      apiToken: "private-api-token",
      privateDirectory: directory,
      fetchImpl: async () =>
        new Response('{"secret":"do-not-echo"}', { status: 403 }),
    }).then(
      () => null,
      (failure) => failure,
    );
    assert.match(error.message, /HTTP 403/);
    assert.equal(error.message.includes("do-not-echo"), false);
    assert.equal(error.message.includes("private-account-id"), false);
    assert.equal(error.message.includes("private-api-token"), false);
    assert.equal(existsSync(join(directory, "001-keys.json")), true);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("collector follows event cursors and rejects incomplete or repeated pages", async () => {
  for (const mode of ["complete", "repeated", "empty", "mixed"]) {
    const directory = await mkdtemp(join(tmpdir(), "eliza-trace-boundary-"));
    const events = completeTraceEvents();
    const secondPage =
      mode === "empty"
        ? []
        : mode === "repeated"
          ? events.slice(0, 4)
          : events.slice(4);
    if (mode === "mixed") secondPage[0].$metadata.traceId = TRACE_B;
    const responses = [
      keysEnvelope(),
      queryEnvelope("traces", [
        { traceId: TRACE_A, service: ["eliza-cloud-api-staging"] },
      ]),
      apiEnvelope({
        run: { status: "COMPLETED" },
        events: { count: 8, events: events.slice(0, 4) },
      }),
      apiEnvelope({
        run: { status: "COMPLETED" },
        events: { count: 8, events: secondPage },
      }),
    ];
    const bodies = [];
    try {
      const capture = collectInferenceTraceEvidence({
        pairedRecords: pairedRecords(),
        deploySha: SHA,
        accountId: "private-account",
        apiToken: "private-token",
        privateDirectory: directory,
        fetchImpl: async (_url, init) => {
          bodies.push(JSON.parse(init.body));
          assert.ok(
            responses.length > 0,
            "collector must terminate within supplied pages",
          );
          return new Response(responses.shift());
        },
      });
      if (mode === "complete") {
        const result = await capture;
        assert.equal(result.status, "observed");
        assert.equal(result.samples[0].phases.billing.doColo, "IAD");
      } else {
        await assert.rejects(capture, /pagination/);
      }
      assert.equal(bodies[3].offset, events[3].$metadata.id);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }
});
