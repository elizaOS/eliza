/**
 * App auth codes are single use. In a Worker the cache is Cloudflare KV, whose
 * get-then-delete lets parallel readers all see the code. Real Workerd with a
 * KV namespace and the authentication state Durable Object.
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { join } from "node:path";
import { Miniflare } from "miniflare";

let worker: Miniflare;
const SHARED = join(import.meta.dir, "../../shared/src/lib");
const KV_ADAPTER = join(SHARED, "cache/adapters/kv-cache-adapter.ts");
const CLOUD_BINDINGS = join(SHARED, "runtime/cloud-bindings.ts");

beforeAll(async () => {
  const build = await Bun.build({
    entrypoints: [
      join(import.meta.dir, "../test/fixtures/single-use-records-worker.ts"),
    ],
    target: "browser",
    external: ["node:*", "cloudflare:*"],
    conditions: ["eliza-source"],
    plugins: [
      {
        name: "worker-kv-cache",
        setup(build) {
          // The deployed Worker cache: CacheClient over KvCacheAdapter, which
          // reports no atomic operations. The Redis fallbacks of the full
          // client do not bundle for Workerd and are not used there.
          build.onLoad(
            { filter: /[\\/]lib[\\/]cache[\\/]client\.ts$/ },
            () => ({
              loader: "ts",
              contents: `
              import { KvCacheAdapter } from ${JSON.stringify(KV_ADAPTER)};
              import { getCloudBinding } from ${JSON.stringify(CLOUD_BINDINGS)};
              const kv = () => new KvCacheAdapter(getCloudBinding("CACHE_KV"));
              export const cache = {
                isAvailable: () => true,
                supportsAtomicOperations: () => false,
                async setIfNotExists(key, value, ttlMs) {
                  return (await kv().set(key, JSON.stringify(value), { nx: true, px: ttlMs })) === "OK";
                },
                async getAndDelete(key) {
                  const value = await kv().getdel(key);
                  return value === null ? null : JSON.parse(value);
                },
              };
            `,
            }),
          );
        },
      },
    ],
  });
  if (!build.success)
    throw new AggregateError(build.logs, "Workerd fixture build failed");
  worker = new Miniflare({
    compatibilityDate: "2026-04-01",
    compatibilityFlags: ["nodejs_compat"],
    modules: [
      {
        type: "ESModule",
        path: "worker.mjs",
        contents: await build.outputs[0]!.text(),
      },
    ],
    kvNamespaces: ["CACHE_KV"],
    durableObjects: {
      AUTHENTICATION_STATE: {
        className: "AuthenticationState",
        useSQLite: true,
      },
    },
  });
}, 60_000);

afterAll(async () => {
  await worker?.dispose();
});

async function call(input: { operation: "issue" | "consume"; code?: string }) {
  const response = await worker.dispatchFetch("https://single-use.test/", {
    method: "POST",
    body: JSON.stringify(input),
    headers: { "Content-Type": "application/json" },
  });
  expect(response.status).toBe(200);
  return response.json();
}

test("an app auth code has exactly one consumer under parallel reads", async () => {
  const code = (await call({ operation: "issue" })) as string;
  const results = await Promise.all(
    Array.from({ length: 16 }, () => call({ operation: "consume", code })),
  );
  const winners = results.filter((result) => result !== null);
  expect(winners).toHaveLength(1);
  expect(winners[0]).toMatchObject({ appId: "app-a", userId: "user-a" });
}, 60_000);
