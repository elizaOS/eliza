import { afterAll, beforeAll, expect, test } from "bun:test";
import { fileURLToPath } from "node:url";
import { Miniflare } from "miniflare";

let worker: Miniflare;
beforeAll(async () => {
  const build = await Bun.build({
    entrypoints: [
      fileURLToPath(
        new URL(
          "../test/fixtures/speech-revocation-worker.ts",
          import.meta.url,
        ),
      ),
    ],
    target: "browser",
    format: "esm",
  });
  if (!build.success)
    throw new AggregateError(build.logs, "Speech fence fixture did not build");
  worker = new Miniflare({
    modules: true,
    script: await build.outputs[0].text(),
    compatibilityDate: "2026-04-01",
    compatibilityFlags: ["nodejs_compat", "enable_request_signal"],
    durableObjects: { FENCE: "Fence" },
  });
});
afterAll(async () => {
  await worker?.dispose();
});

test("a healthy upgraded fence survives the HTTP deadline, then real socket loss revokes", async () => {
  const result = await (
    await worker.dispatchFetch("https://test/healthy")
  ).json();
  expect(result).toEqual({
    connected: true,
    healthy: { aborted: false, revoked: false },
    revoked: true,
  });
}, 10000);

test("intentional unsubscribe stays quiet after the HTTP deadline", async () => {
  const result = await (
    await worker.dispatchFetch("https://test/unsubscribe")
  ).json();
  expect(result).toEqual({
    connected: true,
    healthy: { aborted: false, revoked: false },
    revoked: false,
  });
}, 10000);

test("the HTTP upgrade and the ready message keep separate three-second deadlines", async () => {
  const slow = (await (
    await worker.dispatchFetch("https://test/slow")
  ).json()) as { connected: boolean; aborted: boolean; elapsedMs: number };
  expect(slow.connected).toBe(false);
  expect(slow.aborted).toBe(true);
  expect(slow.elapsedMs).toBeGreaterThanOrEqual(3000);
  const silent = (await (
    await worker.dispatchFetch("https://test/no-ready")
  ).json()) as { connected: boolean; aborted: boolean; elapsedMs: number };
  expect(silent.connected).toBe(false);
  expect(silent.aborted).toBe(false);
  expect(silent.elapsedMs).toBeGreaterThanOrEqual(3000);
}, 10000);
