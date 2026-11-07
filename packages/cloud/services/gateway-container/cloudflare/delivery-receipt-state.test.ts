import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cloudflareDeliveryReceiptStore } from "@elizaos/cloud-services-common/delivery-receipts";
import { Miniflare } from "miniflare";
import { sendWithTwilioReplyFence } from "../../gateway-webhook/src/network-compliance";

let worker: Miniflare;
let directory: string;
let script: string;
const start = () =>
  new Miniflare({
    compatibilityDate: "2026-04-01",
    compatibilityFlags: ["nodejs_compat"],
    modules: [{ type: "ESModule", path: "worker.mjs", contents: script }],
    durableObjects: {
      DELIVERY_RECEIPT_STATE: {
        className: "DeliveryReceiptState",
        useSQLite: true,
      },
    },
    durableObjectsPersist: directory,
    outboundService: () => {
      throw new Error("Unexpected provider I/O");
    },
  });
beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "delivery-receipts-"));
  const build = await Bun.build({
    entrypoints: [join(import.meta.dir, "delivery-receipt.fixture.ts")],
    target: "browser",
    external: ["node:*", "cloudflare:*"],
    conditions: ["eliza-source"],
  });
  if (!build.success)
    throw new AggregateError(build.logs, "Receipt fixture build failed");
  const output = build.outputs[0];
  if (!output) throw new Error("Missing fixture");
  script = await output.text();
  worker = start();
  await worker.ready;
}, 60_000);
afterAll(async () => {
  await worker?.dispose();
  if (directory) await rm(directory, { recursive: true, force: true });
});
const key = (id: string) => `internal-delivery:blooio:project:${id}`;
const call = (input: object, path = "/private", token = "test-only") =>
  worker.dispatchFetch(`https://receipt.test${path}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
    body: JSON.stringify(input),
  });
const store = () =>
  cloudflareDeliveryReceiptStore(
    {
      GATEWAY_RECEIPTS_URL: "https://receipt.test/internal/delivery-receipts",
      GATEWAY_RECEIPTS_TOKEN: "test-only",
    },
    async (url, init) => {
      if (typeof init.body !== "string") throw new Error("JSON required");
      const r = await worker.dispatchFetch(String(url), {
        method: init.method,
        headers: Object.fromEntries(new Headers(init.headers)),
        body: init.body,
      });
      return new Response(await r.arrayBuffer(), {
        status: r.status,
        headers: Object.fromEntries(r.headers),
      });
    },
  );
test("one concurrent claimant wins and stale owners cannot replace or release a receipt", async () => {
  const results = await Promise.all(
    Array.from({ length: 20 }, (_, i) =>
      store().set(key("race"), `claim-${i}`, { ex: 60, nx: true }),
    ),
  );
  expect(results.filter((r) => r === "OK")).toHaveLength(1);
  const winner = await store().get<string>(key("race"));
  if (typeof winner !== "string") throw new Error("Missing winner");
  expect(
    await store().replaceIfEquals(key("race"), "stale", "indeterminate", 60),
  ).toBe(false);
  expect(await store().delIfEquals(key("race"), "stale")).toBe(false);
  expect(
    await store().replaceIfEquals(
      key("race"),
      winner,
      JSON.stringify({ state: "indeterminate", hash: "binding" }),
      60,
    ),
  ).toBe(true);
  await worker.dispose();
  worker = start();
  await worker.ready;
  expect(await store().get<Record<string, unknown>>(key("race"))).toEqual({
    state: "indeterminate",
    hash: "binding",
  });
  expect(
    await store().set(key("race"), "duplicate", { ex: 60, nx: true }),
  ).toBeNull();
  const receipt = {
    state: "complete",
    providerMessageIds: ["provider-id"],
    acceptedAt: "2026-10-22T00:00:00Z",
    hash: "binding",
  };
  await store().set(key("race"), JSON.stringify(receipt), { ex: 1209600 });
  expect(await store().get<Record<string, unknown>>(key("race"))).toEqual(
    receipt,
  );
  expect(await store().get(key("other"))).toBeNull();
});
test("import preserves original expiry and remains sealed after restart and deletion", async () => {
  const input = {
    operation: "import",
    key: key("import"),
    value: "indeterminate",
    expiresAt: Date.now() + 500,
    sourceQuiesced: true,
  };
  expect((await call({ ...input, sourceQuiesced: false })).status).toBe(400);
  expect((await call(input)).status).toBe(200);
  expect((await call(input)).status).toBe(200);
  expect((await call({ ...input, value: "different" })).status).toBe(409);
  expect(await store().get<string>(key("import"))).toBe("indeterminate");
  await Bun.sleep(550);
  expect(await store().get<string>(key("import"))).toBeNull();
  await worker.dispose();
  worker = start();
  await worker.ready;
  expect((await call(input)).status).toBe(409);
  expect(await store().del(key("import"))).toBe(false);
  expect((await call({ ...input, expiresAt: Date.now() + 60000 })).status).toBe(
    409,
  );
  expect(
    (
      await call(
        { ...input, key: key("foreign") },
        `/private?owner=${encodeURIComponent(key("import"))}`,
      )
    ).status,
  ).toBe(403);
});
test("public transport rejects imports, foreign namespaces, and unauthorized calls", async () => {
  const input = { operation: "get", key: key("auth") };
  expect(
    (
      await call(
        { ...input, operation: ["get"] },
        "/internal/delivery-receipts",
      )
    ).status,
  ).toBe(400);
  expect(
    (await call(input, "/internal/delivery-receipts", "wrong")).status,
  ).toBe(401);
  expect(
    (
      await call(
        { ...input, operation: "import" },
        "/internal/delivery-receipts",
      )
    ).status,
  ).toBe(400);
  expect(
    (await call({ ...input, key: "auth:nonce" }, "/internal/delivery-receipts"))
      .status,
  ).toBe(400);
  expect(
    (
      await call(
        { ...input, operation: "replace", value: "bad", seconds: 60 },
        "/internal/delivery-receipts",
      )
    ).status,
  ).toBe(400);
});

test("Discord delivery handler replays its durable receipt after restart without another send", async () => {
  const payload = {
    platform: "discord",
    discordUserId: "123456789",
    text: "fixture only",
    idempotencyKey: "discord-replay",
  };
  const deliver = () =>
    worker.dispatchFetch("https://receipt.test/discord/deliver", {
      method: "POST",
      headers: { "X-Internal-Secret": "delivery-test-only" },
      body: JSON.stringify(payload),
    });
  const first = await deliver();
  expect(first.status).toBe(200);
  expect(first.headers.get("X-Fixture-Sends")).toBe("1");
  expect(first.headers.get("X-Fixture-Nonce")).toMatch(/^[0-9]{1,25}$/);
  const original = (await first.json()) as Record<string, unknown>;
  expect(original.replayed).toBe(false);
  await worker.dispose();
  worker = start();
  await worker.ready;
  const replay = await deliver();
  expect(replay.status).toBe(200);
  expect(replay.headers.get("X-Fixture-Sends")).toBe("0");
  expect(await replay.json()).toEqual({ ...original, replayed: true });
  const unknownPayload = { ...payload, idempotencyKey: "discord-unknown" };
  const unknown = () =>
    worker.dispatchFetch(
      "https://receipt.test/discord/deliver?outcome=unknown",
      {
        method: "POST",
        headers: { "X-Internal-Secret": "delivery-test-only" },
        body: JSON.stringify(unknownPayload),
      },
    );
  expect((await unknown()).status).toBe(202);
  await worker.dispose();
  worker = start();
  await worker.ready;
  const uncertainReplay = await unknown();
  expect(uncertainReplay.status).toBe(202);
  expect(uncertainReplay.headers.get("X-Fixture-Sends")).toBe("0");
  expect(
    (
      await call(
        {
          operation: "get",
          key: "internal-delivery:discord:123456789:discord-replay",
        },
        "/internal/delivery-receipts",
      )
    ).status,
  ).toBe(403);
});

test("Twilio replies retain imported and uncertain fences across restart without another send", async () => {
  let sends = 0;
  const send = async () => {
    sends++;
    return ["SMfixture"];
  };
  const importedKey = "reply:twilio:network:SMimported";
  expect(
    (
      await call({
        operation: "import",
        key: importedKey,
        value: "indeterminate",
        expiresAt: Date.now() + 60_000,
        sourceQuiesced: true,
      })
    ).status,
  ).toBe(200);
  expect(
    await sendWithTwilioReplyFence(
      store(),
      "network",
      "SMimported",
      send,
      () => false,
    ),
  ).toBe("replayed");
  expect(sends).toBe(0);
  expect(
    await sendWithTwilioReplyFence(
      store(),
      "network",
      "SMnative",
      send,
      () => false,
    ),
  ).toBe("sent");
  expect(sends).toBe(1);
  await worker.dispose();
  worker = start();
  await worker.ready;
  expect(
    await sendWithTwilioReplyFence(
      store(),
      "network",
      "SMnative",
      send,
      () => false,
    ),
  ).toBe("replayed");
  expect(sends).toBe(1);
  expect(
    await store().get<Record<string, unknown>>("reply:twilio:network:SMnative"),
  ).toEqual({
    state: "complete",
    providerMessageIds: ["SMfixture"],
  });
  const failure = new Error("fixture transport uncertainty");
  await expect(
    sendWithTwilioReplyFence(
      store(),
      "network",
      "SMunknown",
      async () => {
        throw failure;
      },
      () => false,
    ),
  ).rejects.toThrow("fixture transport uncertainty");
  await worker.dispose();
  worker = start();
  await worker.ready;
  expect(
    await sendWithTwilioReplyFence(
      store(),
      "network",
      "SMunknown",
      send,
      () => false,
    ),
  ).toBe("replayed");
  expect(sends).toBe(1);
  await expect(
    sendWithTwilioReplyFence(
      store(),
      "network",
      "SMrejected",
      async () => {
        throw failure;
      },
      () => true,
    ),
  ).rejects.toThrow();
  expect(
    await sendWithTwilioReplyFence(
      store(),
      "network",
      "SMrejected",
      send,
      () => false,
    ),
  ).toBe("sent");
  expect(sends).toBe(2);
  expect(
    await sendWithTwilioReplyFence(
      store(),
      "network",
      "SMsuppressed",
      async () => false,
      () => false,
    ),
  ).toBe("suppressed");
  expect(
    await sendWithTwilioReplyFence(
      store(),
      "network",
      "SMsuppressed",
      send,
      () => false,
    ),
  ).toBe("replayed");
  expect(sends).toBe(2);
});
