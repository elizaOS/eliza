import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Miniflare } from "miniflare";

let worker: Miniflare, script: string, directory: string;
const start = () =>
  new Miniflare({
    compatibilityDate: "2026-04-01",
    compatibilityFlags: ["nodejs_compat"],
    modules: [{ type: "ESModule", path: "worker.mjs", contents: script }],
    durableObjects: {
      WEBHOOK_INGRESS_STATE: {
        className: "WebhookIngressState",
        useSQLite: true,
      },
    },
    durableObjectsPersist: directory,
    outboundService: () => {
      throw new Error("Unexpected external ingress I/O");
    },
  });
beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "webhook-ingress-"));
  const build = await Bun.build({
    entrypoints: [join(import.meta.dir, "webhook-ingress.fixture.ts")],
    target: "browser",
    external: ["node:*", "cloudflare:*"],
    conditions: ["eliza-source"],
  });
  if (!build.success)
    throw new AggregateError(build.logs, "Ingress fixture failed");
  const output = build.outputs[0];
  if (!output) throw new Error("No fixture output");
  script = await output.text();
  worker = start();
  await worker.ready;
}, 60_000);
afterAll(async () => {
  await worker?.dispose();
  if (directory) await rm(directory, { recursive: true, force: true });
});
const call = (input: object, path = "/exercise", token = "test-only") =>
  worker.dispatchFetch(`https://ingress.test${path}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
    body: JSON.stringify(input),
  });
const ok = async (input: object) => {
  const response = await call(input);
  expect(response.status).toBe(200);
  return (await response.json()) as { result: unknown; deliveries: number };
};
const key = "webhook:blooio:project:message:held";
test("complete ingress snapshot preserves content and expiry and cannot reopen after serving", async () => {
  const content = JSON.stringify({
    chunks: ["complete payload é".repeat(5000)],
  });
  const snapshot = {
    operation: "import",
    sourceQuiesced: true,
    kv: [
      { key: "webhook:telegram:history:plan", value: content, expiresAt: null },
      {
        key: "webhook:blooio:expired",
        value: "processing",
        expiresAt: Date.now() - 1000,
      },
    ],
    due: [],
  };
  expect(
    (await call({ ...snapshot, sourceQuiesced: false }, "/private")).status,
  ).toBe(400);
  expect((await call(snapshot, "/private")).status).toBe(200);
  expect((await call(snapshot, "/private")).status).toBe(200);
  expect((await call({ ...snapshot, kv: [] }, "/private")).status).toBe(409);
  expect(
    (await ok({ action: "get", key: "webhook:telegram:history:plan" })).result,
  ).toEqual(JSON.parse(content));
  expect(
    (await ok({ action: "get", key: "webhook:blooio:expired" })).result,
  ).toBeNull();
  await worker.dispose();
  worker = start();
  await worker.ready;
  expect((await call(snapshot, "/private")).status).toBe(409);
  expect(
    (await ok({ action: "get", key: "webhook:telegram:history:plan" })).result,
  ).toEqual(JSON.parse(content));
});
test("hold transaction fences stale owners and preserves a reopened marker during cleanup", async () => {
  const content = "full event content é".repeat(5000);
  await ok({ action: "hold", key, value: content });
  expect((await ok({ action: "get", key })).result).toBe("held");
  const stored = (
    await ok({ action: "get", key: `webhook:cutover-hold:${key}` })
  ).result as { event: { text: string } };
  expect(stored.event.text).toBe(content);
  await ok({
    action: "set",
    key: `webhook:cutover-hold-lease:${key}`,
    value: "new-owner",
    ex: 60,
  });
  expect(
    (
      await ok({
        action: "hold",
        key,
        value: "stale overwrite",
        token: "old-owner",
      })
    ).result,
  ).toBeNull();
  expect(
    (await ok({ action: "cleanup", key, token: "old-owner" })).result,
  ).toBe(0);
  expect(
    (await ok({ action: "cleanup", key, token: "new-owner" })).result,
  ).toBe(0);
  await ok({ action: "del", key: `webhook:cutover-hold-lease:${key}` });
  await worker.dispose();
  worker = start();
  await worker.ready;
  expect((await ok({ action: "due" })).result).toEqual([key]);
});
test("real hold drainer renews its native lease across long redelivery and does not dispatch twice", async () => {
  const first = ok({ action: "drain", delay: 2000 });
  await Bun.sleep(1200);
  expect(
    (await ok({ action: "get", key: `webhook:cutover-hold-lease:${key}` }))
      .result,
  ).not.toBeNull();
  const concurrent = await ok({ action: "drain" });
  expect(concurrent.deliveries).toBe(1);
  const done = await first;
  expect((done.result as { delivered: number }).delivered).toBe(1);
  expect((await ok({ action: "due" })).result).toEqual([]);
  await worker.dispose();
  worker = start();
  await worker.ready;
  expect((await ok({ action: "get", key })).result).toBe("delivered");
  expect((await ok({ action: "drain" })).deliveries).toBe(0);
});
test("public ingress transport rejects imports and unrelated keyspaces", async () => {
  expect(
    (
      await call(
        { operation: "get", key },
        "/internal/webhook-ingress",
        "wrong",
      )
    ).status,
  ).toBe(401);
  expect(
    (await call({ operation: "import" }, "/internal/webhook-ingress")).status,
  ).toBe(400);
  expect(
    (
      await call(
        { operation: "get", key: "authentication:nonce" },
        "/internal/webhook-ingress",
      )
    ).status,
  ).toBe(400);
  expect(
    (await call({ operation: ["get"], key }, "/internal/webhook-ingress"))
      .status,
  ).toBe(400);
});
