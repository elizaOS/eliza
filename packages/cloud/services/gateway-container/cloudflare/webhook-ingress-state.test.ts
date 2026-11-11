import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Miniflare } from "miniflare";
import { withCloudflareIngress } from "../../gateway-webhook/src/cloudflare-ingress";
import { drainCutoverHolds } from "../../gateway-webhook/src/cutover-hold";
import type { GatewayRedis } from "../../gateway-webhook/src/redis";

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
  return (await response.json()) as {
    result: unknown;
    deliveries: number;
    settledAt?: number;
  };
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
test("slow redelivery retains the full retry delay after the held outcome", async () => {
  const retryKey = "webhook:blooio:project:message:slow-retry";
  const text = "durable retry payload é".repeat(500);
  await ok({ action: "hold", key: retryKey, value: text });
  const first = await ok({ action: "drain", delay: 2250, rehold: true });
  expect(first.result).toMatchObject({ rescheduled: 1, delivered: 0 });
  const { settledAt } = first;
  if (settledAt === undefined)
    throw new Error("Missing callback completion time");
  const eligibleUpperBound = Date.now() + 2000;
  const due = await ok({ action: "due", now: settledAt });
  const early = await ok({ action: "drain", now: settledAt });
  expect({
    due: due.result,
    callbacks: early.deliveries - first.deliveries,
  }).toEqual({
    due: [],
    callbacks: 0,
  });

  await worker.dispose();
  worker = start();
  await worker.ready;
  const pending = await ok({
    action: "get",
    key: `webhook:cutover-hold:${retryKey}`,
  });
  expect(pending.result).toMatchObject({ attempts: 1, event: { text } });
  expect((await ok({ action: "due", now: settledAt + 1999 })).result).toEqual(
    [],
  );
  expect((await ok({ action: "due", now: eligibleUpperBound })).result).toEqual(
    [retryKey],
  );
  const retried = await ok({ action: "drain", now: eligibleUpperBound });
  expect(retried.result).toMatchObject({ delivered: 1, rescheduled: 0 });
  expect(retried.deliveries).toBe(1);
  expect((await ok({ action: "due", now: eligibleUpperBound })).result).toEqual(
    [],
  );
}, 30_000);

test("a stale replica scan cannot redeliver a re-held member while another member is due", async () => {
  const target = "webhook:blooio:project:message:stale-scan";
  const unrelated = "webhook:blooio:project:message:unrelated-due";
  const text = "retain the complete held event é".repeat(500);
  await ok({ action: "hold", key: target, value: text });
  const fallback = new Proxy({} as GatewayRedis, {
    get: () => () => {
      throw new Error("Unexpected Redis fallback");
    },
  });
  const store = withCloudflareIngress(
    fallback,
    {
      CLOUD_WEBHOOK_INGRESS_BACKEND: "cloudflare",
      WEBHOOK_INGRESS_URL: "https://ingress.test/internal/webhook-ingress",
      WEBHOOK_INGRESS_TOKEN: "test-only",
    },
    async (url, init) => {
      if (typeof init.body !== "string")
        throw new Error("Expected JSON ingress request");
      const receipt = await worker.dispatchFetch(String(url), {
        method: init.method,
        headers: Object.fromEntries(new Headers(init.headers)),
        body: init.body,
      });
      return new Response(await receipt.arrayBuffer(), {
        status: receipt.status,
        headers: Object.fromEntries(receipt.headers),
      });
    },
  );
  const scanAt = Date.now();
  const captured = Promise.withResolvers<string[]>();
  const resume = Promise.withResolvers<void>();
  let holdFirstScan = true;
  const staleStore: GatewayRedis = {
    ...store,
    async zrangebyscore(...args) {
      const members = await store.zrangebyscore(...args);
      if (holdFirstScan) {
        holdFirstScan = false;
        captured.resolve(members);
        await resume.promise;
      }
      return members;
    },
  };
  const signal = { code: "personal_cutover_in_progress", retryAfterSeconds: 1 };
  const release = async () => {
    throw new Error("Unexpected hold expiration");
  };
  let staleCallbacks = 0;
  const stale = drainCutoverHolds(
    staleStore,
    {
      async redeliver() {
        staleCallbacks++;
        return { kind: "held", signal };
      },
      release,
    },
    { now: scanAt, limit: 1 },
  );
  try {
    const oldScan = await Promise.race([
      captured.promise,
      stale.then(() => {
        throw new Error(
          "The stale poll settled before capturing its due receipt",
        );
      }),
    ]);
    expect(oldScan).toEqual([target]);

    const first = await drainCutoverHolds(
      store,
      {
        async redeliver(held) {
          expect(held.dedupKey).toBe(target);
          expect(held.event.text).toBe(text);
          return { kind: "held", signal };
        },
        release,
      },
      { now: scanAt, limit: 1 },
    );
    expect(first).toMatchObject({ rescheduled: 1, delivered: 0 });
    await ok({
      action: "hold",
      key: unrelated,
      value: "a separate held event",
      now: scanAt - 2000,
    });
    expect((await ok({ action: "due", now: scanAt })).result).toEqual([
      unrelated,
    ]);
    resume.resolve();
    expect({ stats: await stale, callbacks: staleCallbacks }).toMatchObject({
      stats: {
        rescheduled: 0,
        delivered: 0,
        released: 0,
        expired: 0,
        stale: 0,
      },
      callbacks: 0,
    });
    expect((await ok({ action: "due", now: scanAt + 1999 })).result).toEqual([
      unrelated,
    ]);
    const pending = await ok({
      action: "get",
      key: `webhook:cutover-hold:${target}`,
    });
    expect(pending.result).toMatchObject({ attempts: 1, event: { text } });
    expect(
      (await ok({ action: "get", key: `webhook:cutover-hold-lease:${target}` }))
        .result,
    ).toBeNull();

    const completed: string[] = [];
    const final = await drainCutoverHolds(
      store,
      {
        async redeliver(held) {
          completed.push(held.dedupKey);
          if (held.dedupKey === target) expect(held.event.text).toBe(text);
          await store.set(held.dedupKey, "delivered", { ex: 60 });
          return { kind: "delivered" };
        },
        release,
      },
      { now: scanAt + 2000 },
    );
    expect(final.delivered).toBe(2);
    expect(completed).toEqual([unrelated, target]);
    expect((await ok({ action: "due", now: scanAt + 2000 })).result).toEqual(
      [],
    );
  } finally {
    resume.resolve();
    await stale;
  }
}, 30_000);

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
