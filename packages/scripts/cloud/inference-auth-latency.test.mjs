/** Validates the auth-latency probe's bounded parser, samples, summaries, and gates. */

import assert from "node:assert/strict";
import test from "node:test";

import {
  enforceAcceptance,
  parseArgs,
  parseAuthServerTiming,
  parseAuthTrace,
  probeAuthGuardSample,
  probeAuthSample,
  sanitizeInferenceAuthTail,
  sanitizeInferenceAuthTelemetry,
  summarizeAuthSamples,
  summarizeDeferredCacheWrites,
  waitForInferenceAuthTail,
} from "./inference-auth-latency.mjs";

const SHA = "a".repeat(40);

function authHeader(phase) {
  return phase === "hit"
    ? "v=1;credential=x_api_key;probe=off;available=available;backend=cloudflare_kv;read=hit;authoritative=not_run;write=not_run;result=authorized_cache"
    : "v=1;credential=x_api_key;probe=on;available=available;backend=cloudflare_kv;read=miss;authoritative=authorized;write=deferred;result=authorized_origin";
}

function timingHeader(phase, resolveMs = 10) {
  const shared = `auth_extract;dur=0.1, auth_cache_available;dur=0.2, auth_cache_read;dur=1, auth_resolve;dur=${resolveMs}`;
  return phase === "hit"
    ? shared
    : `${shared}, auth_key_lookup;dur=3, auth_user_org;dur=2, auth_moderation;dur=1`;
}

test("parseArgs requires exact HTTPS deployment provenance and sample counts", () => {
  assert.deepEqual(
    parseArgs([
      "--base-url",
      "https://preview.example/",
      "--api-key-env",
      "AUTH_KEY",
      "--suspended-api-key-env",
      "SUSPENDED_AUTH_KEY",
      "--probe-token-env",
      "PROBE_TOKEN",
      "--deploy-sha",
      SHA,
      "--hit-count",
      "31",
      "--miss-count",
      "11",
      "--enforce",
    ]),
    {
      baseUrl: "https://preview.example",
      apiKeyEnv: "AUTH_KEY",
      suspendedApiKeyEnv: "SUSPENDED_AUTH_KEY",
      probeTokenEnv: "PROBE_TOKEN",
      deploySha: SHA,
      hitCount: 31,
      missCount: 11,
      timeoutMs: 30_000,
      intervalMs: 250,
      enforce: true,
    },
  );
  assert.throws(
    () =>
      parseArgs([
        "--base-url",
        "http://preview.example",
        "--api-key-env",
        "AUTH_KEY",
        "--suspended-api-key-env",
        "SUSPENDED_AUTH_KEY",
        "--probe-token-env",
        "PROBE_TOKEN",
        "--deploy-sha",
        SHA,
      ]),
    /HTTPS/,
  );
});

test("auth parsers accept only bounded enums and finite auth durations", () => {
  assert.deepEqual(parseAuthTrace(authHeader("miss")), {
    v: "1",
    credential: "x_api_key",
    probe: "on",
    available: "available",
    backend: "cloudflare_kv",
    read: "miss",
    authoritative: "authorized",
    write: "deferred",
    result: "authorized_origin",
  });
  assert.throws(
    () => parseAuthTrace(`${authHeader("miss")};identity=customer@example.com`),
    /Invalid auth trace field/,
  );
  assert.deepEqual(
    parseAuthServerTiming(
      "provider;dur=999, auth_cache_read;dur=2.5, auth_resolve;dur=10",
    ),
    { auth_cache_read: 2.5, auth_resolve: 10 },
  );
  assert.throws(() => parseAuthServerTiming("auth_resolve;dur=-1"), /Invalid/);
});

test("Worker Tail sanitizer retains only correlated bounded telemetry", () => {
  const traceId = "0190f2f1-8b5a-7000-8000-000000000001";
  const telemetry = {
    v: 1,
    traceId,
    authSource: "x_api_key",
    controlledProbe: "on",
    cacheAvailability: "available",
    cacheBackend: "cloudflare_kv",
    cacheRead: "miss",
    authoritative: "authorized",
    cacheWrite: "deferred",
    result: "authorized_origin",
    timings: {
      extractMs: 0.1,
      cacheAvailabilityMs: 0.1,
      cacheReadMs: 1,
      keyLookupMs: 4,
      userOrgLookupMs: 3,
      moderationMs: 2,
      cacheWriteMs: null,
      totalMs: 10.2,
    },
  };
  const deferredCacheWriteTelemetry = {
    v: 1,
    kind: "cache_write",
    traceId,
    cacheBackend: "cloudflare_kv",
    cacheWrite: "written",
    durationMs: 12,
  };
  const raw = [
    "wrangler banner that is not JSON",
    JSON.stringify(
      {
        outcome: "ok",
        logs: [
          {
            level: "info",
            message: [
              "[InferenceAuth] trace",
              {
                ...telemetry,
                traceId: "0190f2f1-8b5a-7000-8000-000000000099",
                result: "unbounded-private-result",
                userId: "private-user",
              },
            ],
          },
          { level: "info", message: ["[InferenceAuth] trace", telemetry] },
          {
            level: "info",
            message: ["[InferenceAuth] trace", deferredCacheWriteTelemetry],
          },
        ],
        event: {
          request: {
            url: "https://preview.example/api/v1/chat/completions?private=value",
            headers: { "X-API-Key": "eliza_private_api_key_material" },
          },
        },
      },
      null,
      4,
    ),
  ].join("\n");

  const records = sanitizeInferenceAuthTail(raw, [traceId], SHA);
  assert.deepEqual(records, [
    {
      kind: "worker_log",
      deploySha: SHA,
      traceId,
      outcome: "ok",
      telemetry,
      deferredCacheWrite: {
        outcome: "ok",
        telemetry: deferredCacheWriteTelemetry,
      },
    },
  ]);
  const retained = JSON.stringify(records);
  assert.equal(retained.includes("eliza_private_api_key_material"), false);
  assert.equal(retained.includes("preview.example"), false);
  assert.equal(retained.includes("private=value"), false);
  assert.deepEqual(summarizeDeferredCacheWrites(records), {
    p50: 12,
    p90: 12,
    p95: 12,
    max: 12,
  });

  assert.throws(
    () =>
      sanitizeInferenceAuthTelemetry({ ...telemetry, userId: "private-user" }),
    /bounded telemetry schema/,
  );
  assert.throws(
    () =>
      sanitizeInferenceAuthTail(
        raw,
        ["0190f2f1-8b5a-7000-8000-000000000002"],
        SHA,
      ),
    /omitted 1/,
  );
});

test("live sample retains timings and correlation but no credential, probe token, or body", async () => {
  const apiKey = "eliza_private_api_key_material";
  const probeToken = "private_probe_control_token";
  let sentProbeHeader = "";
  let sentBody = "";
  const record = await probeAuthSample({
    baseUrl: "https://preview.example",
    apiKey,
    probeToken,
    deploySha: SHA,
    phase: "miss",
    sequence: 0,
    timeoutMs: 1_000,
    now: (() => {
      const values = [100, 112];
      return () => values.shift();
    })(),
    fetchImpl: async (_url, init) => {
      sentProbeHeader = init.headers["X-Eliza-Auth-Probe"];
      sentBody = init.body;
      return new Response(null, {
        status: 400,
        headers: {
          "X-Eliza-Trace-Id": init.headers["X-Eliza-Trace-Id"],
          "X-Eliza-Auth-Trace": authHeader("miss"),
          "Server-Timing": timingHeader("miss"),
          "cf-placement": "remote-EWR",
          "cf-ray": "abc123-EWR",
        },
      });
    },
  });

  assert.match(sentProbeHeader, /^private_probe_control_token:[0-9a-f]{32}$/);
  assert.equal(sentBody, "{}");
  assert.equal(record.phase, "miss");
  assert.equal(record.totalMs, 12);
  assert.equal(record.placement, "remote-EWR");
  assert.equal(record.colo, "EWR");
  const retained = JSON.stringify(record);
  assert.equal(retained.includes(apiKey), false);
  assert.equal(retained.includes(probeToken), false);
  assert.equal(retained.includes("X-Eliza-Auth-Probe"), false);
  assert.equal(retained.includes("{}"), false);
});

test("Tail readiness waits for an observed authenticated trace", async () => {
  const traceIds = [];
  let reads = 0;
  const attempts = await waitForInferenceAuthTail({
    baseUrl: "https://preview.example",
    apiKey: "eliza_private_api_key_material",
    probeToken: "private_probe_control_token",
    deploySha: SHA,
    timeoutMs: 1_000,
    attempts: 3,
    pollsPerAttempt: 1,
    pollIntervalMs: 1,
    sleep: async () => {},
    readTail: () => {
      reads++;
      return traceIds.length > 1
        ? JSON.stringify({ traceId: traceIds[1] })
        : "";
    },
    fetchImpl: async (_url, init) => {
      traceIds.push(init.headers["X-Eliza-Trace-Id"]);
      return new Response(null, {
        status: 400,
        headers: {
          "X-Eliza-Trace-Id": init.headers["X-Eliza-Trace-Id"],
          "X-Eliza-Auth-Trace": authHeader("hit"),
          "Server-Timing": timingHeader("hit"),
        },
      });
    },
  });

  assert.equal(attempts, 2);
  assert.equal(reads, 2);
  assert.equal(traceIds.length, 2);
});

test("Tail readiness retries a transient workers.dev propagation response", async () => {
  let requests = 0;
  let observedTraceId = "";
  const attempts = await waitForInferenceAuthTail({
    baseUrl: "https://preview.example",
    apiKey: "eliza_private_api_key_material",
    probeToken: "private_probe_control_token",
    deploySha: SHA,
    timeoutMs: 1_000,
    attempts: 2,
    pollsPerAttempt: 1,
    pollIntervalMs: 1,
    sleep: async () => {},
    readTail: () => observedTraceId,
    fetchImpl: async (_url, init) => {
      requests++;
      if (requests === 1) return new Response(null, { status: 404 });
      observedTraceId = init.headers["X-Eliza-Trace-Id"];
      return new Response(null, {
        status: 400,
        headers: {
          "X-Eliza-Trace-Id": observedTraceId,
          "X-Eliza-Auth-Trace": authHeader("hit"),
          "Server-Timing": timingHeader("hit"),
        },
      });
    },
  });

  assert.equal(attempts, 2);
  assert.equal(requests, 2);
});

test("Tail readiness fails fast on non-propagation HTTP responses", async () => {
  let requests = 0;
  const failure = await waitForInferenceAuthTail({
    baseUrl: "https://preview.example",
    apiKey: "eliza_private_api_key_material",
    probeToken: "private_probe_control_token",
    deploySha: SHA,
    timeoutMs: 1_000,
    attempts: 3,
    pollsPerAttempt: 1,
    pollIntervalMs: 1,
    sleep: async () => {},
    readTail: () => "",
    fetchImpl: async () => {
      requests++;
      return new Response(null, { status: 401 });
    },
  }).then(
    () => null,
    (error) => error,
  );

  assert.match(failure.message, /HTTP 401/);
  assert.equal(requests, 1);
});

test("Tail readiness reports bounded route-propagation exhaustion", async () => {
  const apiKey = "eliza_private_api_key_material";
  const probeToken = "private_probe_control_token";
  let requests = 0;
  const failure = await waitForInferenceAuthTail({
    baseUrl: "https://preview.example",
    apiKey,
    probeToken,
    deploySha: SHA,
    timeoutMs: 1_000,
    attempts: 2,
    pollsPerAttempt: 1,
    pollIntervalMs: 1,
    sleep: async () => {},
    readTail: () => "",
    fetchImpl: async () => {
      requests++;
      return new Response(null, { status: 404 });
    },
  }).then(
    () => null,
    (error) => error,
  );

  assert.match(failure.message, /route did not stabilize/);
  assert.equal(failure.message.includes(apiKey), false);
  assert.equal(failure.message.includes(probeToken), false);
  assert.equal(requests, 2);
});

test("Tail readiness fails after bounded attempts without exposing credentials", async () => {
  const apiKey = "eliza_private_api_key_material";
  const probeToken = "private_probe_control_token";
  const failure = await waitForInferenceAuthTail({
    baseUrl: "https://preview.example",
    apiKey,
    probeToken,
    deploySha: SHA,
    timeoutMs: 1_000,
    attempts: 2,
    pollsPerAttempt: 1,
    pollIntervalMs: 1,
    sleep: async () => {},
    readTail: () => "",
    fetchImpl: async (_url, init) =>
      new Response(null, {
        status: 400,
        headers: {
          "X-Eliza-Trace-Id": init.headers["X-Eliza-Trace-Id"],
          "X-Eliza-Auth-Trace": authHeader("hit"),
          "Server-Timing": timingHeader("hit"),
        },
      }),
  }).then(
    () => null,
    (error) => error,
  );

  assert.match(failure.message, /did not observe/);
  assert.equal(failure.message.includes(apiKey), false);
  assert.equal(failure.message.includes(probeToken), false);
});

test("guard probes retain 401 taxonomy and reject forged probe controls", async () => {
  const fetchImpl = async (_url, init) => {
    const key = init.headers["X-API-Key"];
    const invalid = key !== "eliza_valid" && key !== "eliza_suspended";
    const suspended = key === "eliza_suspended";
    const phase = invalid ? "invalid" : suspended ? "suspended" : "hit";
    return new Response(null, {
      status: invalid ? 401 : suspended ? 403 : 400,
      headers: {
        "X-Eliza-Trace-Id": init.headers["X-Eliza-Trace-Id"],
        "X-Eliza-Auth-Trace": invalid
          ? "v=1;credential=x_api_key;probe=off;available=available;backend=cloudflare_kv;read=miss;authoritative=rejected;write=not_run;result=rejected"
          : suspended
            ? "v=1;credential=x_api_key;probe=on;available=available;backend=cloudflare_kv;read=miss;authoritative=suspended;write=not_run;result=suspended"
            : authHeader(phase),
        "Server-Timing": invalid
          ? "auth_extract;dur=0.1, auth_cache_available;dur=0.1, auth_cache_read;dur=1, auth_key_lookup;dur=3, auth_resolve;dur=5"
          : suspended
            ? "auth_extract;dur=0.1, auth_cache_available;dur=0.1, auth_cache_read;dur=1, auth_key_lookup;dur=3, auth_user_org;dur=2, auth_moderation;dur=1, auth_resolve;dur=8"
            : timingHeader(phase),
      },
    });
  };

  const invalid = await probeAuthGuardSample({
    baseUrl: "https://preview.example",
    apiKey: "eliza_valid",
    deploySha: SHA,
    guard: "invalid_key",
    timeoutMs: 1_000,
    fetchImpl,
  });
  assert.equal(invalid.status, 401);
  assert.equal(invalid.auth.result, "rejected");

  const suspended = await probeAuthGuardSample({
    baseUrl: "https://preview.example",
    apiKey: "eliza_suspended",
    probeToken: "private_probe_control_token",
    deploySha: SHA,
    guard: "suspended_key",
    timeoutMs: 1_000,
    fetchImpl,
  });
  assert.equal(suspended.status, 403);
  assert.equal(suspended.auth.result, "suspended");
  assert.equal(
    JSON.stringify(suspended).includes("private_probe_control_token"),
    false,
  );

  const forged = await probeAuthGuardSample({
    baseUrl: "https://preview.example",
    apiKey: "eliza_valid",
    deploySha: SHA,
    guard: "forged_probe",
    timeoutMs: 1_000,
    fetchImpl,
  });
  assert.equal(forged.status, 400);
  assert.equal(forged.auth.probe, "off");
  assert.equal(forged.auth.read, "hit");
});

function sample(phase, resolveMs) {
  return {
    phase,
    timings: {
      auth_resolve: resolveMs,
      auth_key_lookup: phase === "miss" ? resolveMs / 2 : undefined,
      auth_user_org: phase === "miss" ? 1 : undefined,
      auth_moderation: phase === "miss" ? 1 : undefined,
      auth_cache_read: 1,
      auth_cache_write: phase === "miss" ? 1 : undefined,
    },
  };
}

test("summary and acceptance enforce sample volume, hit tails, and 50% cold improvement", () => {
  const passing = [
    ...Array.from({ length: 30 }, () => sample("hit", 10)),
    ...Array.from({ length: 10 }, () => sample("miss", 1_000)),
  ];
  const summary = summarizeAuthSamples(passing, SHA);
  assert.deepEqual(summary.counts, { hit: 30, miss: 10 });
  assert.doesNotThrow(() => enforceAcceptance(summary));

  const slow = summarizeAuthSamples(
    [
      ...Array.from({ length: 30 }, () => sample("hit", 10)),
      ...Array.from({ length: 10 }, () => sample("miss", 2_100)),
    ],
    SHA,
  );
  assert.throws(() => enforceAcceptance(slow), /multi-second tail/);
});
