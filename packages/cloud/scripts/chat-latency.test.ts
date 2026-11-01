import assert from "node:assert/strict";
import test from "node:test";
import { probeOpenAi } from "./chat-latency.ts";

const probeCase = {
  model: "qwen-3.8-27b",
  reasoningEffort: "none",
  maxTokens: 64,
};

function warming(code = "billing_cache_warming") {
  return new Response(
    JSON.stringify({ error: { type: "service_unavailable", code } }),
    {
      status: 503,
      headers: { "content-type": "application/json", "retry-after": "0.01" },
    },
  );
}

function failing() {
  return new Response(JSON.stringify({ error: { code: "upstream_down" } }), {
    status: 503,
    headers: { "content-type": "application/json" },
  });
}

function probe(target, responses) {
  let calls = 0;
  return probeOpenAi({
    target,
    probeCase,
    baseUrl: "https://gateway.test",
    apiKey: "test-only",
    proof: "latency-proof-test",
    timeoutMs: 0,
    sequence: 1,
    metadata: {},
    fetchImpl: async () => responses[Math.min(calls++, responses.length - 1)](),
  }).then((record) => ({ record, calls }));
}

test("gateway warming refusals are retried and counted, timing from the first attempt", async () => {
  const { record, calls } = await probe("gateway", [warming, warming, failing]);
  assert.equal(calls, 3);
  assert.equal(record.warmingRetries, 2);
  assert.equal(record.status, 503);
  assert.equal(record.ok, false);
  assert.ok(record.responseHeadersMs >= 20);
});

test("a non-warming 503 and the direct target are never retried", async () => {
  const gateway = await probe("gateway", [failing]);
  assert.equal(gateway.calls, 1);
  assert.equal(gateway.record.warmingRetries, 0);
  const direct = await probe("direct", [warming]);
  assert.equal(direct.calls, 1);
  assert.equal(direct.record.warmingRetries, 0);
});

test("warming retries are bounded", async () => {
  const { record, calls } = await probe("gateway", [warming]);
  assert.equal(calls, 5);
  assert.equal(record.warmingRetries, 4);
  assert.equal(record.ok, false);
});
