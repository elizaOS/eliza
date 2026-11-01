import { expect, test } from "bun:test";
import {
  cacheWarmingRetryDelayMs,
  fetchRetryingCacheWarming,
} from "../test/e2e/_helpers/api";

const refusal = (body: unknown, status = 503) =>
  Response.json(body, { status, headers: { "Retry-After": "1" } });

test("only explicit pre-admission cache refusals permit E2E retries", async () => {
  for (const code of [
    "auth_cache_warming",
    "rate_limit_cache_warming",
    "inference_dependency_cache_warming",
    "billing_cache_warming",
    "inference_admission_cache_warming",
  ]) {
    expect(await cacheWarmingRetryDelayMs(refusal({ code }))).toBe(1000);
    expect(await cacheWarmingRetryDelayMs(refusal({ error: { code } }))).toBe(
      1000,
    );
  }
  expect(
    await cacheWarmingRetryDelayMs(
      refusal({
        jsonrpc: "2.0",
        error: { code: -32004, data: { code: "auth_cache_warming" } },
      }),
    ),
  ).toBe(1000);
  for (const body of [
    { code: "service_unavailable", details: { retryable: true } },
    { jsonrpc: "2.0", error: { code: -32004 } },
    {
      jsonrpc: "2.0",
      error: { code: -32004, data: { code: "billing_cache_warming" } },
    },
    { code: "unknown_cache_warming" },
    { code: "conversation_cache_warming" },
    { code: "agent_cache_warming" },
    { code: "shared_runtime_cache_warming" },
    null,
    ["auth_cache_warming"],
    "auth_cache_warming",
  ]) {
    expect(await cacheWarmingRetryDelayMs(refusal(body))).toBeNull();
  }
  expect(
    await cacheWarmingRetryDelayMs(
      refusal({ code: "auth_cache_warming" }, 502),
    ),
  ).toBeNull();
});

test("raw E2E fetch retries stay bounded and never replay a generic refusal", async () => {
  const originalFetch = globalThis.fetch;
  try {
    for (const code of ["auth_cache_warming", "service_unavailable"]) {
      let calls = 0;
      globalThis.fetch = Object.assign(
        async () => {
          calls++;
          return refusal({ code, details: { retryable: true } });
        },
        { preconnect() {} },
      );
      const response = await fetchRetryingCacheWarming("/synthetic", () => ({
        method: "POST",
        body: "unchanged synthetic request",
      }));
      expect(response.status).toBe(503);
      expect(calls).toBe(code === "auth_cache_warming" ? 4 : 1);
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
});
