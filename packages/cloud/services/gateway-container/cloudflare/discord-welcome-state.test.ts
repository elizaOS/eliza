import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DISCORD_WELCOME_DELIVERED } from "@elizaos/cloud-services-common/discord-welcome-state";
import { Miniflare } from "miniflare";

let worker: Miniflare, script: string, directory: string;
const start = () =>
  new Miniflare({
    compatibilityDate: "2026-04-01",
    compatibilityFlags: ["nodejs_compat"],
    modules: [{ type: "ESModule", path: "worker.mjs", contents: script }],
    durableObjects: {
      DISCORD_WELCOME_STATE: {
        className: "DiscordWelcomeState",
        useSQLite: true,
      },
    },
    durableObjectsPersist: directory,
    outboundService: () => {
      throw new Error("Unexpected external Discord I/O");
    },
  });
beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "discord-welcome-"));
  const build = await Bun.build({
    entrypoints: [join(import.meta.dir, "discord-welcome.fixture.ts")],
    target: "browser",
    external: ["node:*", "cloudflare:*"],
    conditions: ["eliza-source"],
  });
  if (!build.success)
    throw new AggregateError(build.logs, "Welcome fixture failed");
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
const call = (input: object, path = "/exercise", token = "test-only") =>
  worker.dispatchFetch(`https://welcome.test${path}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
    body: JSON.stringify(input),
  });
const ok = async (input: object) => {
  const response = await call(input);
  expect(response.status).toBe(200);
  return (await response.json()) as {
    result: unknown;
    messages: Array<Record<string, unknown>>;
  };
};
const job = (id: string) => ({
  id,
  eventTimestamp: "2026-10-22T00:00:00Z",
  user: { id: `user-${id}`, globalName: id },
});
test("quiesced import preserves FIFO order, processing recovery, and delivered markers", async () => {
  const snapshot = {
    operation: "import",
    sourceQuiesced: true,
    pending: [JSON.stringify(job("B")), JSON.stringify(job("A"))],
    processing: [JSON.stringify(job("C"))],
    delivered: [
      {
        key: DISCORD_WELCOME_DELIVERED + "B",
        value: "1",
        expiresAt: Date.now() + 60000,
      },
      {
        key: DISCORD_WELCOME_DELIVERED + "expired",
        value: "1",
        expiresAt: Date.now() - 1000,
      },
    ],
  };
  expect(
    (await call({ ...snapshot, sourceQuiesced: false }, "/private")).status,
  ).toBe(400);
  expect((await call(snapshot, "/private")).status).toBe(200);
  expect((await call(snapshot, "/private")).status).toBe(200);
  expect((await call({ ...snapshot, pending: [] }, "/private")).status).toBe(
    409,
  );
  expect(
    (await ok({ action: "marker", key: DISCORD_WELCOME_DELIVERED + "expired" }))
      .result,
  ).toBeNull();
  const first = await ok({ action: "drain" });
  expect(first.result).toBe(true);
  expect(first.messages).toHaveLength(1);
  expect(first.messages[0]?.content).toContain("Hey A");
  expect(first.messages[0]?.enforce_nonce).toBe(true);
  const skipped = await ok({ action: "drain" });
  expect(skipped.messages).toHaveLength(1);
  const recovered = await ok({ action: "drain" });
  expect(recovered.messages).toHaveLength(2);
  expect(recovered.messages[1]?.content).toContain("Hey C");
  expect((await ok({ action: "drain" })).result).toBe(false);
  await worker.dispose();
  worker = start();
  await worker.ready;
  expect((await call(snapshot, "/private")).status).toBe(409);
  await ok({ action: "enqueue", job: job("A") });
  expect((await ok({ action: "drain" })).messages).toHaveLength(0);
});
test("an abandoned processing claim survives restart with its complete payload", async () => {
  const queued = {
    ...job("crash"),
    user: { id: "user-crash", globalName: "complete é".repeat(5000) },
  };
  await ok({ action: "enqueue", job: queued });
  expect((await ok({ action: "claim" })).result).toBe(JSON.stringify(queued));
  await worker.dispose();
  worker = start();
  await worker.ready;
  const recovered = await ok({ action: "drain" });
  expect(recovered.messages).toHaveLength(1);
  expect(recovered.messages[0]?.content).toContain(queued.user.globalName);
  await worker.dispose();
  worker = start();
  await worker.ready;
  await ok({ action: "enqueue", job: queued });
  expect((await ok({ action: "drain" })).messages).toHaveLength(0);
});
test("public queue transport rejects imports, unauthorized callers and foreign lists", async () => {
  expect(
    (
      await call(
        { operation: "get", key: DISCORD_WELCOME_DELIVERED + "A" },
        "/internal/discord-welcome",
        "wrong",
      )
    ).status,
  ).toBe(401);
  expect(
    (await call({ operation: "import" }, "/internal/discord-welcome")).status,
  ).toBe(400);
  expect(
    (
      await call(
        { operation: "push", key: "another-queue", values: ["payload"] },
        "/internal/discord-welcome",
      )
    ).status,
  ).toBe(400);
  expect(
    (
      await call(
        { operation: ["get"], key: DISCORD_WELCOME_DELIVERED + "A" },
        "/internal/discord-welcome",
      )
    ).status,
  ).toBe(400);
});
