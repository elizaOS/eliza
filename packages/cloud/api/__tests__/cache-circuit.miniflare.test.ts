/** Real Worker/KV cache calls and the production gate's relative timer receipt. */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { Miniflare } from "miniflare";

let mf: Miniflare;
let createRuntime: () => Miniflare;
let directory: string;
const deadline =
  process.env.CACHE_CIRCUIT_TEST_REAL_DEADLINE === "1" ? 60_000 : 500;
beforeAll(async () => {
  const built = await Bun.build({
    entrypoints: [
      fileURLToPath(
        new URL("../test/fixtures/cache-circuit-worker.ts", import.meta.url),
      ),
    ],
    target: "node",
    format: "esm",
    conditions: ["eliza-source", "worker", "browser"],
    external: ["cloudflare:*"],
    plugins: [
      {
        name: "cache-circuit-runtime-boundaries",
        setup(build) {
          // This path uses only ElizaError; keep the real type without unrelated
          // runtime/provider initialization from the package's side-effectful root.
          build.onResolve({ filter: /^@elizaos\/core$/ }, () => ({
            path: fileURLToPath(
              new URL("../../../core/src/errors.ts", import.meta.url),
            ),
          }));
          build.onLoad({ filter: /[\\/]db[\\/]client\.ts$/ }, () => ({
            loader: "ts",
            contents:
              "export async function runWithDbCacheAsync(operation) { return operation(); }",
          }));
          build.onLoad(
            { filter: /[\\/]inference-admission-recovery\.ts$/ },
            () => ({
              loader: "ts",
              contents:
                "export async function recoverExpiredInferenceAdmissionLease() { throw new Error('Cache clock cannot recover tenant admission'); }",
            }),
          );
          build.onResolve({ filter: /^wadis$/ }, () => ({
            path: "wadis",
            namespace: "not-worker",
          }));
          build.onResolve({ filter: /^redis$/ }, () => ({
            path: "redis",
            namespace: "not-worker",
          }));
          build.onLoad({ filter: /.*/, namespace: "not-worker" }, () => ({
            loader: "js",
            contents:
              "export function createClient() { throw new Error('Node Redis cannot run on Workers'); } export class Wadis { constructor() { throw new Error('Wadis cannot run on Workers'); } }",
          }));
          build.onLoad(
            { filter: /[/]inference-funded-budget-controller\.ts$/ },
            () => ({
              loader: "ts",
              contents:
                "export class InferenceFundedBudgetController { constructor() { throw new Error('Cache clock cannot enter tenant admission'); } }",
            }),
          );
          if (deadline !== 60_000) {
            build.onLoad(
              { filter: /[/]cache[/]cache-circuit-clock\.ts$/ },
              async (args) => ({
                loader: "ts",
                contents: (await Bun.file(args.path).text()).replace(
                  "export const CACHE_CIRCUIT_COOLDOWN_MS = 60_000;",
                  `export const CACHE_CIRCUIT_COOLDOWN_MS = ${deadline};`,
                ),
              }),
            );
          }
        },
      },
    ],
  });
  if (!built.success)
    throw new AggregateError(
      built.logs,
      "Worker circuit fixture failed to build",
    );
  directory = await mkdtemp(join(tmpdir(), "cache-circuit-workerd-"));
  const script = await built.outputs[0]!.text();
  createRuntime = () =>
    new Miniflare({
      modules: [
        { type: "ESModule", path: "cache-circuit-worker.js", contents: script },
      ],
      compatibilityDate: "2026-04-01",
      compatibilityFlags: ["nodejs_compat"],
      kvNamespaces: ["CACHE_KV"],
      durableObjects: {
        INFERENCE_ADMISSION_GATES: {
          className: "CacheCircuitTestGate",
          useSQLite: true,
        },
      },
      durableObjectsPersist: directory,
      bindings: {
        CACHE_ENABLED: "true",
        CACHE_BACKEND: "auto",
        MOCK_REDIS: "0",
        NODE_ENV: "test",
        ENVIRONMENT: "worker-circuit",
      },
    });
  mf = createRuntime();
  await mf.ready;
}, 30_000);
afterAll(async () => {
  await mf?.dispose();
  if (directory) await rm(directory, { recursive: true, force: true });
});

async function post(path: string, body: Record<string, unknown> = {}) {
  const response = await mf.dispatchFetch(`https://cache.test${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return response;
}

test("Worker circuit crosses response boundaries using a relative DO timer", async () => {
  await post("/reset");
  const failed = (await (await post("/fail")).json()) as { available: boolean };
  expect(failed.available).toBe(false);
  expect(
    await (await post("/available", { wall: 1_800_003_600_000 })).json(),
  ).toEqual({ available: false });
  expect(
    await (await post("/available", { wall: 1_799_996_400_000 })).json(),
  ).toEqual({ available: false });
  await delay(deadline + 100);
  // A synchronous-only caller first requests an observation, then sees its receipt.
  expect(await (await post("/available")).json()).toEqual({ available: false });
  await delay(30);
  expect(await (await post("/available")).json()).toEqual({ available: true });
  expect(await (await post("/delete")).json()).toEqual({ confirmed: true });
}, 70_000);

test("a new request owns its probe while an older deferred clock reply is pending", async () => {
  await post("/reset", { ambient: true });
  await post("/fail", { ambient: true });
  await delay(deadline + 60);
  expect(
    await (
      await post("/available", { ambient: true, delayClockReply: true })
    ).json(),
  ).toEqual({ available: false });
  for (let attempt = 0; attempt < 40; attempt++) {
    if (
      ((await (await post("/pending")).json()) as { delayedReplies: number })
        .delayedReplies > 0
    )
      break;
    await delay(5);
  }
  expect(await (await post("/pending")).json()).toEqual({ delayedReplies: 1 });
  expect(await (await post("/available", { ambient: true })).json()).toEqual({
    available: false,
  });
  await delay(30);
  expect(await (await post("/available", { ambient: true })).json()).toEqual({
    available: true,
  });
  expect(await (await post("/pending")).json()).toEqual({ delayedReplies: 1 });
  await delay(1000);
}, 70_000);

test("clock identities cannot mutate tenant admission and the control Worker has no public clock route", async () => {
  const clock = `cache-circuit:${randomUUID()}`;
  const tenant = randomUUID();
  for (const path of ["/lease", "/hydrate", "/rate-limit", "/cache-circuit"]) {
    expect((await post("/outer", { path })).status).toBe(404);
    if (path !== "/cache-circuit")
      expect((await post("/gate", { gate: clock, path })).status).toBe(404);
  }
  expect(
    (
      await post("/gate", {
        gate: tenant,
        path: "/cache-circuit",
        generation: 1,
      })
    ).status,
  ).toBe(404);
  expect(
    (
      await post("/gate", {
        gate: clock,
        path: "/cache-circuit",
        method: "GET",
      })
    ).status,
  ).toBe(404);
  expect(
    (
      await post("/gate", {
        gate: "cache-circuit:invalid",
        path: "/cache-circuit",
        generation: 1,
      })
    ).status,
  ).toBe(400);
  expect(
    await (
      await post("/gate", { gate: clock, path: "/__test/storage" })
    ).json(),
  ).toEqual({});
  expect(
    await (
      await post("/gate", { gate: tenant, path: "/__test/storage" })
    ).json(),
  ).toEqual({});
});

test("an unknown clock acknowledgement retains its owner and restart can only extend its wait", async () => {
  const clock = `cache-circuit:${randomUUID()}`;
  const read = () =>
    post("/gate", { gate: clock, path: "/cache-circuit", generation: 1 });
  const stored = async () =>
    (await (
      await post("/gate", { gate: clock, path: "/__test/storage" })
    ).json()) as Record<
      string,
      { generation: number; owner: string; ready: boolean }
    >;
  // The actor's committed response is intentionally discarded by its caller.
  await read();
  const first = (await stored())["cache-circuit-clock"]!;
  expect(first.ready).toBe(false);
  expect(await (await read()).json()).toMatchObject({
    generation: 1,
    ready: false,
  });
  expect((await stored())["cache-circuit-clock"]!.owner).toBe(first.owner);
  await mf.dispose();
  mf = createRuntime();
  await mf.ready;
  expect(await (await read()).json()).toMatchObject({
    generation: 1,
    ready: false,
  });
  const restarted = (await stored())["cache-circuit-clock"]!;
  expect(restarted.owner).not.toBe(first.owner);
  expect(restarted.generation).toBe(1);
  await delay(deadline + 60);
  expect(await (await read()).json()).toMatchObject({
    generation: 1,
    ready: true,
  });
  await mf.dispose();
  mf = createRuntime();
  await mf.ready;
  expect(await (await read()).json()).toMatchObject({
    generation: 1,
    ready: true,
  });
  expect(
    (
      await post("/gate", {
        gate: clock,
        path: "/cache-circuit",
        generation: 2,
      })
    ).status,
  ).toBe(200);
  expect((await read()).status).toBe(409);
  expect(Object.keys(await stored())).toEqual(["cache-circuit-clock"]);
}, 70_000);

test("a delayed ready receipt cannot reopen a later failure generation", async () => {
  await post("/reset");
  expect(await (await post("/late-race")).json()).toMatchObject({
    oldOutcome: { kind: "unavailable" },
    confirmed: false,
    blocked: true,
    currentOutcome: { kind: "hit", value: { version: "original" } },
  });
}, 70_000);
