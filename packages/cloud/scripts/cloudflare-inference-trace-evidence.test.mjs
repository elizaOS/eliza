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
  traceDiscoverySlices,
  validateTraceKeysResponse,
} from "./cloudflare-inference-trace-evidence.mjs";

const SHA = "a".repeat(40);
const TRACE_A = "1".repeat(32);
const TRACE_B = "2".repeat(32);
const SETTLE_ROUNDS = 8;
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

function traceSummary(traceId = TRACE_A) {
  return {
    rootSpanName: "fetch",
    rootTransactionName: "POST /api/v1/chat/completions",
    service: ["eliza-cloud-api-staging"],
    spans: 8,
    traceDurationMs: 185,
    traceStartMs: 1_780_000_000_000,
    traceEndMs: 1_780_000_000_185,
    traceId,
  };
}

function containsFirstGatewayRequest(timeframe) {
  return (
    timeframe.from <= 1_780_000_000_000 && timeframe.to > 1_780_000_000_000
  );
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

test("trace discovery divides the complete window into consecutive 5-10 second slices", () => {
  const { timeframe } = pairedGatewayTraceWindow(pairedRecords());
  const slices = traceDiscoverySlices(timeframe);
  assert.equal(slices.length, 8);
  assert.equal(slices[0].from, timeframe.from);
  assert.equal(slices.at(-1).to, timeframe.to);
  for (let index = 0; index < slices.length; index++) {
    if (index > 0) assert.equal(slices[index - 1].to, slices[index].from);
    assert.ok(slices[index].to - slices[index].from >= 5_000);
    assert.ok(slices[index].to - slices[index].from <= 10_000);
  }
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
    ingressColo: "ORD",
    workerColo: "ORD",
    workerWallMs: 185,
    phases: {
      rate: {
        phase: "rate",
        workerColo: "ORD",
        doColo: "EWR",
        subrequestMs: 58.12,
        doWallMs: 4.46,
        storageInclusiveSumMs: 1.26,
        storageSpans: 1,
      },
      billing: {
        phase: "billing",
        workerColo: "ORD",
        doColo: "IAD",
        subrequestMs: 49.99,
        doWallMs: 5.44,
        storageInclusiveSumMs: 1.35,
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
  const missingUrl = completeTraceEvents();
  delete missingUrl.find((value) => value.$metadata.id === "rate-subrequest")
    .$metadata.url;
  assert.equal(sanitizeTraceEvents(missingUrl, references), null);
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
        if (url.endsWith("/keys")) return new Response(keysEnvelope());
        assert.equal(JSON.parse(init.body).view, "traces");
        return new Response(queryEnvelope("traces", []));
      },
    });
    assert.equal(evidence.status, "inconclusive_sampling");
    assert.equal(evidence.reason, "no_sampled_traces");
    assert.equal(evidence.coverage.gatewayRequests, 22);
    assert.equal(evidence.coverage.sampledTraces, 0);
    assert.equal(evidence.coverage.completeTraces, 0);
    assert.equal(evidence.coverage.incompleteTraces, 0);
    assert.equal(evidence.coverage.settleRounds, SETTLE_ROUNDS);
    assert.equal(evidence.coverage.discoverySlices.length, 8);
    assert.ok(
      evidence.coverage.discoverySlices.every(
        (slice) =>
          typeof slice.fromUtc === "string" &&
          typeof slice.toUtc === "string" &&
          slice.sampledTraces === 0,
      ),
    );
    assert.deepEqual(evidence.samples, []);
    assert.equal(calls.length, 1 + 8 * SETTLE_ROUNDS);
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
  const rootCallsBySlice = new Map();
  let eventCalls = 0;
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
      fetchImpl: async (url, init) => {
        if (url.endsWith("/keys")) return new Response(keysEnvelope());
        const body = JSON.parse(init.body);
        if (body.view === "events") {
          eventCalls++;
          const events = completeTraceEvents();
          const sweepRound = Math.floor((eventCalls - 1) / 8) + 1;
          const isFollowingSlice =
            body.timeframe.from > 1_780_000_000_000 &&
            body.timeframe.from - 1_780_000_000_000 <= 10_000;
          const sliceEvents = containsFirstGatewayRequest(body.timeframe)
            ? events.slice(0, 4)
            : isFollowingSlice
              ? [events[2], ...events.slice(4)]
              : [];
          return new Response(
            queryEnvelope(
              "events",
              sweepRound === 1
                ? sliceEvents.filter(
                    (value) => value.$metadata.id !== "billing-root",
                  )
                : sliceEvents,
            ),
          );
        }
        const sliceKey = `${body.timeframe.from}:${body.timeframe.to}`;
        const sliceCalls = (rootCallsBySlice.get(sliceKey) ?? 0) + 1;
        rootCallsBySlice.set(sliceKey, sliceCalls);
        if (containsFirstGatewayRequest(body.timeframe) && sliceCalls === 1) {
          return new Response(queryEnvelope("traces", [], "STARTED"));
        }
        const isPriorBoundarySlice =
          body.timeframe.to < 1_780_000_000_000 &&
          1_780_000_000_000 - body.timeframe.to <= 10_000;
        const traceIsVisible =
          (containsFirstGatewayRequest(body.timeframe) && sliceCalls >= 3) ||
          (isPriorBoundarySlice && sliceCalls >= 2);
        return new Response(
          queryEnvelope("traces", traceIsVisible ? [traceSummary()] : []),
        );
      },
    });
    assert.equal(evidence.status, "observed");
    assert.equal(evidence.reason, null);
    assert.equal(evidence.samples.length, 1);
    assert.equal(evidence.coverage.sampledTraces, 1);
    assert.equal(evidence.coverage.completeTraces, 1);
    assert.equal(evidence.coverage.incompleteTraces, 0);
    assert.equal(eventCalls, 16);
    assert.equal(evidence.coverage.eventSweeps.length, 1);
    assert.equal(evidence.coverage.eventSweeps[0].settleRounds, 2);
    assert.equal(evidence.coverage.eventSweeps[0].slices.length, 8);
    assert.ok(
      evidence.coverage.eventSweeps[0].slices.every(
        (slice) =>
          typeof slice.fromUtc === "string" &&
          typeof slice.toUtc === "string" &&
          Number.isSafeInteger(slice.eventCount),
      ),
    );
    assert.deepEqual(
      evidence.coverage.eventSweeps[0].slices
        .map((slice) => slice.eventCount)
        .filter((count) => count > 0),
      [4, 5],
    );
    assert.equal(JSON.stringify(evidence).includes(TRACE_A), false);
    assert.equal(
      evidence.coverage.discoverySlices.filter(
        (slice) => slice.sampledTraces === 1,
      ).length,
      2,
    );
    assert.equal(sleeps, 9);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("collector reports a sampled trace with an unclassifiable URL as inconclusive", async () => {
  const directory = await mkdtemp(join(tmpdir(), "eliza-trace-boundary-"));
  const incomplete = completeTraceEvents();
  delete incomplete.find((value) => value.$metadata.id === "rate-subrequest")
    .$metadata.url;
  let eventCalls = 0;
  try {
    const evidence = await collectInferenceTraceEvidence({
      pairedRecords: pairedRecords(),
      deploySha: SHA,
      accountId: "private-account-id",
      apiToken: "private-api-token",
      privateDirectory: directory,
      sleepImpl: async () => {},
      fetchImpl: async (url, init) => {
        if (url.endsWith("/keys")) return new Response(keysEnvelope());
        const body = JSON.parse(init.body);
        if (body.view === "events") {
          eventCalls++;
          return new Response(
            queryEnvelope(
              "events",
              containsFirstGatewayRequest(body.timeframe) ? incomplete : [],
            ),
          );
        }
        return new Response(
          queryEnvelope(
            "traces",
            containsFirstGatewayRequest(body.timeframe) ? [traceSummary()] : [],
          ),
        );
      },
    });
    assert.equal(evidence.status, "inconclusive_sampling");
    assert.equal(evidence.reason, "sampled_traces_incomplete");
    assert.deepEqual(evidence.samples, []);
    assert.equal(evidence.coverage.incompleteTraces, 1);
    assert.equal(eventCalls, 8 * SETTLE_ROUNDS);
    assert.equal(evidence.coverage.eventSweeps[0].settleRounds, SETTLE_ROUNDS);
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

test("trace placement uses the Worker span rather than the ingress Ray colo", () => {
  const { references } = pairedGatewayTraceWindow(pairedRecords());
  const events = completeTraceEvents();
  events[0].$metadata.region = "SJC";
  const sample = sanitizeTraceEvents(events, references);
  assert.equal(sample.ingressColo, "ORD");
  assert.equal(sample.workerColo, "SJC");
  delete events[0].$metadata.region;
  assert.equal(sanitizeTraceEvents(events, references), null);
});

test("collector follows event cursors and rejects incomplete, repeated, or conflicting pages", async () => {
  for (const mode of [
    "complete",
    "repeated",
    "empty",
    "mixed",
    "conflicting",
  ]) {
    const directory = await mkdtemp(join(tmpdir(), "eliza-trace-boundary-"));
    const events = completeTraceEvents();
    const secondPage =
      mode === "empty"
        ? []
        : mode === "repeated"
          ? events.slice(0, 4)
          : events.slice(4);
    if (mode === "mixed") secondPage[0].$metadata.traceId = TRACE_B;
    const bodies = [];
    let targetEventPage = 0;
    try {
      const capture = collectInferenceTraceEvidence({
        pairedRecords: pairedRecords(),
        deploySha: SHA,
        accountId: "private-account",
        apiToken: "private-token",
        privateDirectory: directory,
        sleepImpl: async () => {},
        fetchImpl: async (url, init) => {
          if (url.endsWith("/keys")) return new Response(keysEnvelope());
          const body = JSON.parse(init.body);
          bodies.push(body);
          if (body.view === "traces") {
            return new Response(
              queryEnvelope(
                "traces",
                containsFirstGatewayRequest(body.timeframe)
                  ? [traceSummary()]
                  : [],
              ),
            );
          }
          if (!containsFirstGatewayRequest(body.timeframe)) {
            if (
              mode === "conflicting" &&
              body.timeframe.from > 1_780_000_000_000 &&
              body.timeframe.from - 1_780_000_000_000 <= 10_000
            ) {
              const conflicting = structuredClone(events[0]);
              conflicting.$metadata.duration++;
              return new Response(queryEnvelope("events", [conflicting]));
            }
            return new Response(queryEnvelope("events", []));
          }
          targetEventPage++;
          return new Response(
            apiEnvelope({
              run: { status: "COMPLETED" },
              events: {
                count: 8,
                events: targetEventPage === 1 ? events.slice(0, 4) : secondPage,
              },
            }),
          );
        },
      });
      if (mode === "complete") {
        const result = await capture;
        assert.equal(result.status, "observed");
        assert.equal(result.samples[0].phases.billing.doColo, "IAD");
      } else if (mode === "conflicting") {
        await assert.rejects(capture, /conflicting/);
      } else {
        await assert.rejects(capture, /pagination/);
      }
      const eventBodies = bodies.filter((body) => body.view === "events");
      const continuation = eventBodies.find(
        (body) => body.offset === events[3].$metadata.id,
      );
      assert.equal(continuation.offsetDirection, "next");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }
});
