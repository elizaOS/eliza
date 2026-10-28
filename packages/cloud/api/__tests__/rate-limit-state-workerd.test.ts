import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Miniflare } from "miniflare";

describe("real Cloudflare rate state", () => {
  let worker: Miniflare;
  let directory: string;
  let script: string;
  const start = (binding = true, persist = directory) =>
    new Miniflare({
      compatibilityDate: "2026-04-01",
      compatibilityFlags: ["nodejs_compat"],
      modules: [{ type: "ESModule", path: "worker.mjs", contents: script }],
      bindings: {
        CLOUD_RATE_STATE_BACKEND: "cloudflare",
        NODE_ENV: "production",
      },
      durableObjects: binding
        ? { RATE_LIMIT_STATE: { className: "RateLimitState", useSQLite: true } }
        : {},
      durableObjectsPersist: persist,
    });
  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), "eliza-rate-state-"));
    const built = await Bun.build({
      entrypoints: [
        fileURLToPath(
          new URL(
            "../test/fixtures/rate-limit-state-worker.ts",
            import.meta.url,
          ),
        ),
      ],
      format: "esm",
      target: "browser",
      conditions: ["eliza-source"],
      external: ["node:*", "cloudflare:*"],
    });
    if (!built.success)
      throw new AggregateError(built.logs, "Rate fixture build failed");
    script = await built.outputs[0].text();
    worker = start();
  });
  afterAll(async () => {
    await worker?.dispose();
    if (directory) await rm(directory, { recursive: true, force: true });
  });
  const fixed = (key: string) =>
    worker.dispatchFetch("https://rate.test/fixed", {
      headers: { "x-test-key": key },
    });
  const sliding = async (
    key: string,
    operation = "check",
    carriedCount = 0,
  ) => {
    const response = await worker.dispatchFetch("https://rate.test/sliding", {
      method: "POST",
      body: JSON.stringify({ key, operation, carriedCount }),
    });
    expect(response.status).toBe(200);
    return response.json() as Promise<{
      allowed: boolean;
      count: number;
      remaining: number;
    }>;
  };
  test("fixed limit admits exactly three concurrent callers and survives restart", async () => {
    const responses = await Promise.all(
      Array.from({ length: 16 }, () => fixed("fixed-concurrent")),
    );
    expect(responses.filter((r) => r.status === 200)).toHaveLength(3);
    expect(responses.filter((r) => r.status === 429)).toHaveLength(13);
    expect(responses[0].headers.get("X-RateLimit-Policy")).toBe(
      "cloudflare-durable",
    );
    await worker.dispose();
    worker = start();
    expect((await fixed("fixed-concurrent")).status).toBe(429);
    expect((await fixed("another-user")).status).toBe(200);
    await new Promise((resolve) => setTimeout(resolve, 10100));
    expect((await fixed("fixed-concurrent")).status).toBe(200);
  }, 20000);
  test("sliding limit counts concurrent requests, carry, status, and clear", async () => {
    const results = await Promise.all(
      Array.from({ length: 12 }, () => sliding("sliding-concurrent")),
    );
    expect(results.filter((r) => r.allowed)).toHaveLength(3);
    expect((await sliding("sliding-concurrent", "status")).count).toBe(12);
    await worker.dispose();
    worker = start();
    expect((await sliding("sliding-concurrent", "status")).count).toBe(12);
    expect((await sliding("carry", "check", 3)).allowed).toBe(false);
    expect((await sliding("carry", "status")).count).toBe(4);
    await sliding("carry", "clear");
    expect((await sliding("carry")).remaining).toBe(2);
    await new Promise((resolve) => setTimeout(resolve, 10100));
    expect((await sliding("sliding-concurrent", "status")).count).toBe(0);
    expect((await sliding("sliding-concurrent")).allowed).toBe(true);
  }, 20000);
  test("transfers expiring and persistent source counters without resetting allowance", async () => {
    await worker.dispose();
    const persist = join(directory, "transfer");
    worker = start(true, persist);
    const importKey = (body: Record<string, unknown>) =>
      worker.dispatchFetch("https://rate.test/import", {
        method: "POST",
        body: JSON.stringify(body),
      });
    const persistent = {
      key: "ratelimit:retained",
      mode: "fixed",
      count: 10,
      expiresAt: null,
    };
    const expiring = {
      key: "ratelimit:expiring",
      mode: "fixed",
      count: 3,
      expiresAt: Date.now() + 10000,
    };
    const events = {
      key: "local:ratelimit:retained-events",
      mode: "sliding",
      events: [{ at: Date.now(), count: 3 }],
      expiresAt: Date.now() + 20000,
    };
    expect((await importKey(persistent)).status).toBe(200);
    expect(await (await importKey(persistent)).json()).toEqual({
      status: "identical",
    });
    expect((await importKey({ ...persistent, count: 0 })).status).toBe(409);
    expect((await importKey(expiring)).status).toBe(200);
    expect((await importKey(events)).status).toBe(200);
    expect((await fixed("retained")).status).toBe(429);
    expect((await fixed("expiring")).status).toBe(429);
    expect((await sliding("retained-events")).allowed).toBe(false);
    await worker.dispose();
    worker = start(true, persist);
    expect((await importKey(persistent)).status).toBe(409);
    await new Promise((resolve) => setTimeout(resolve, 10100));
    expect((await fixed("retained")).status).toBe(200);
    expect((await fixed("expiring")).status).toBe(200);
    expect((await sliding("retained-events")).allowed).toBe(true);
    expect((await importKey(persistent)).status).toBe(409);
  }, 20000);
  test("missing selected binding rejects instead of using the configured local fallback", async () => {
    await worker.dispose();
    worker = start(false);
    expect((await fixed("missing")).status).toBe(503);
  });
});
