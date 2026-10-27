/**
 * Contract tests for the deployed plan-admission latency harness. Requests go
 * to an in-process fetch stub; no deployment, account or key is used.
 */

import assert from "node:assert/strict";
import test from "node:test";
import {
  classifyResponse,
  parseDeployedLatencyConfig,
  parseServerTiming,
  runDeployedLatency,
  summarize,
} from "./plan-admission-deployed-latency.ts";

const base = {
  apiBase: "https://api-staging.eliza.app",
  iterations: 5,
  warmup: 1,
  inference: { model: "synthetic/model" },
  maps: { query: "Synthetic Place" },
};

test("the config names keys by environment variable and refuses unsafe targets", () => {
  const config = parseDeployedLatencyConfig({
    ...base,
    conditions: {
      normal: { keyEnv: "BENCH_NORMAL_KEY" },
      "cache-miss": { keysEnv: "BENCH_FRESH_KEYS" },
      exhausted: { keyEnv: "BENCH_EXHAUSTED_KEY" },
    },
  });
  assert.deepEqual(config.conditions.normal?.expect.inference, ["admitted"]);
  assert.deepEqual(config.conditions.exhausted?.expect.maps, [
    "rate-limited",
    "allowance-exhausted",
  ]);
  for (const bad of [
    {
      ...base,
      apiBase: "http://api-staging.eliza.app",
      conditions: { normal: { keyEnv: "BENCH_KEY" } },
    },
    {
      ...base,
      apiBase: "https://api-staging.eliza.app/v1",
      conditions: { normal: { keyEnv: "BENCH_KEY" } },
    },
    { ...base, conditions: { normal: { key: "eliza_secret" } } },
    { ...base, conditions: { "cache-miss": { keyEnv: "BENCH_KEY" } } },
    { ...base, conditions: { surprise: { keyEnv: "BENCH_KEY" } } },
    {
      ...base,
      conditions: {
        normal: { keyEnv: "BENCH_KEY", expect: { maps: ["fine"] } },
      },
    },
    { ...base, iterations: 1, conditions: { normal: { keyEnv: "BENCH_KEY" } } },
    { ...base, inference: {}, conditions: { normal: { keyEnv: "BENCH_KEY" } } },
    { ...base, conditions: {} },
  ])
    assert.throws(
      () => parseDeployedLatencyConfig(bad),
      /Invalid deployed latency config/,
    );
});

test("Server-Timing durations and refusal bodies are classified without guessing", () => {
  assert.deepEqual(
    parseServerTiming(
      'gateway_auth;dur=3.5, gateway_preforward;dur=12;desc="x", bad name;dur=1, gateway_setup;dur=abc',
    ),
    { gateway_auth: 3.5, gateway_preforward: 12 },
  );
  assert.equal(classifyResponse(200, {}, null), "admitted");
  assert.equal(
    classifyResponse(
      429,
      { error: "rate_limited", retryAfterSeconds: 3 },
      null,
    ),
    "rate-limited",
  );
  assert.equal(
    classifyResponse(429, { error: { code: "allowance_exhausted" } }, null),
    "allowance-exhausted",
  );
  assert.equal(
    classifyResponse(402, { error: "subscription_required" }, null),
    "subscription-required",
  );
  assert.equal(classifyResponse(402, {}, null), "billing-refused");
  assert.equal(
    classifyResponse(503, { error: { code: "rate_limit_cache_warming" } }, "1"),
    "cache-warming",
  );
  assert.equal(classifyResponse(401, {}, null), "unauthorized");
  assert.equal(classifyResponse(502, null, null), "unavailable");
  assert.equal(classifyResponse(404, {}, null), "unexpected");
  assert.deepEqual(summarize([5, 1, 3, 2, 4]), {
    n: 5,
    p50: 3,
    p95: 5,
    mean: 3,
  });
  assert.equal(summarize([]), null);
});

test("a run measures each condition on the existing routes, subtracts the baseline and counts mismatches", async () => {
  const config = parseDeployedLatencyConfig({
    ...base,
    conditions: {
      normal: { keyEnv: "BENCH_NORMAL_KEY" },
      "cache-miss": { keysEnv: "BENCH_FRESH_KEYS" },
      exhausted: { keyEnv: "BENCH_EXHAUSTED_KEY" },
      expired: { keyEnv: "BENCH_EXPIRED_KEY" },
      "billing-outage": {
        keyEnv: "BENCH_OUTAGE_KEY",
        apiBase: "https://api-outage.eliza.app",
      },
    },
  });
  const fresh = Array.from({ length: 10 }, (_, i) => `eliza_fresh_${i}`);
  const env = {
    BENCH_NORMAL_KEY: "eliza_normal_secret",
    BENCH_FRESH_KEYS: fresh.join(","),
    BENCH_EXHAUSTED_KEY: "eliza_exhausted_secret",
    BENCH_EXPIRED_KEY: "eliza_expired_secret",
    BENCH_OUTAGE_KEY: "eliza_outage_secret",
  };
  const seen: Array<{
    url: string;
    key: string | null;
    idempotency: string | null;
    body: unknown;
  }> = [];
  let clock = 0;
  const fetchStub = (async (
    input: string | URL | Request,
    init?: RequestInit,
  ) => {
    const url = String(input);
    const headers = new Headers(init?.headers);
    const key = headers.get("authorization")?.slice("Bearer ".length) ?? null;
    seen.push({
      url,
      key,
      idempotency: headers.get("idempotency-key"),
      body: init?.body ? JSON.parse(String(init.body)) : null,
    });
    assert.equal(init?.redirect, "error");
    clock += url.endsWith("/entitlement-keys") ? 10 : 25;
    const timing = {
      "Server-Timing": "gateway_auth;dur=2, gateway_preforward;dur=6",
    };
    if (!key) return Response.json({ keys: [] });
    if (key === env.BENCH_EXHAUSTED_KEY)
      return Response.json(
        { error: "rate_limited", retryAfterSeconds: 2 },
        { status: 429, headers: timing },
      );
    if (key === env.BENCH_EXPIRED_KEY)
      // One sample deliberately breaks the expectation so mismatches are reported.
      return seen.filter((row) => row.key === key).length === 3
        ? Response.json({}, { status: 200, headers: timing })
        : Response.json(
            { error: "subscription_required" },
            { status: 402, headers: timing },
          );
    return Response.json({ ok: true }, { headers: timing });
  }) as typeof fetch;
  const result = await runDeployedLatency(config, env, fetchStub, () => clock);
  assert.equal(result.baseline.client?.p50, 10);
  const row = (condition: string, service: string) =>
    result.series.find(
      (item) => item.condition === condition && item.service === service,
    );
  assert.equal(row("normal", "inference")?.addedOverBaseline?.p50, 15);
  assert.equal(row("normal", "inference")?.gatewayPreforward?.p50, 6);
  assert.deepEqual(row("exhausted", "maps")?.outcomes, { "rate-limited": 5 });
  assert.equal(row("expired", "inference")?.mismatches, 1);
  assert.equal(result.expectationsMet, false);
  // Cache-miss uses every fresh key exactly once, and only for measured requests.
  const freshUses = seen.filter((request) =>
    request.key?.startsWith("eliza_fresh_"),
  );
  assert.equal(freshUses.length, 10);
  assert.equal(new Set(freshUses.map((request) => request.key)).size, 10);
  // Existing client routes, smallest real requests, a fresh idempotency key each time.
  const inference = seen.find((request) =>
    request.url.endsWith("/api/v1/chat/completions"),
  );
  assert.deepEqual(inference?.body, {
    model: "synthetic/model",
    messages: [{ role: "user", content: "Reply with one word." }],
    max_tokens: 1,
    stream: false,
  });
  assert.deepEqual(
    seen.find((request) => request.url.endsWith("/api/v1/maps/geocode"))?.body,
    { query: "Synthetic Place", limit: 1 },
  );
  const keyed = seen.filter((request) => request.key);
  assert.equal(
    new Set(keyed.map((request) => request.idempotency)).size,
    keyed.length,
  );
  assert.ok(
    seen.some((request) =>
      request.url.startsWith("https://api-outage.eliza.app/"),
    ),
  );
  // No key appears in the report.
  const report = JSON.stringify(result);
  for (const secret of [...Object.values(env), ...fresh])
    assert.ok(!report.includes(secret));
  await assert.rejects(
    runDeployedLatency(
      config,
      { ...env, BENCH_FRESH_KEYS: "eliza_one" },
      fetchStub,
      () => clock,
    ),
    /cache-miss needs 10 fresh keys/,
  );
});
