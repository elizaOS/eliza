import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Miniflare } from "miniflare";
import { discordCoordinationStore } from "../../gateway-discord/src/cloudflare-coordination-store";

let worker: Miniflare, directory: string, script: string;
const start = () =>
  new Miniflare({
    compatibilityDate: "2026-04-01",
    compatibilityFlags: ["nodejs_compat"],
    modules: [{ type: "ESModule", path: "worker.mjs", contents: script }],
    durableObjects: {
      DISCORD_COORDINATION_STATE: {
        className: "DiscordCoordinationState",
        useSQLite: true,
      },
    },
    durableObjectsPersist: directory,
    outboundService: () => {
      throw new Error("Unexpected external Discord I/O");
    },
  });
beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "discord-coordination-"));
  const build = await Bun.build({
    entrypoints: [join(import.meta.dir, "discord-coordination.fixture.ts")],
    target: "browser",
    external: ["node:*", "cloudflare:*"],
    conditions: ["eliza-source"],
  });
  if (!build.success)
    throw new AggregateError(build.logs, "Coordinator fixture failed");
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
const call = (body: object, path = "/exercise", token = "test-only") =>
  worker.dispatchFetch(`https://coord.test${path}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
const ok = async (body: object) => {
  const r = await call(body);
  expect(r.status).toBe(200);
  return r.json();
};
const leader = "discord:eliza-app-bot:leader";
const channels = "discord:eliza-app-bot:dm-channels";
const snapshot = {
  operation: "import",
  sourceQuiesced: true,
  entries: [
    {
      key: channels,
      kind: "set",
      value: ["channel-b", "channel-a"],
      expiresAt: null,
    },
    {
      key: "discord:eliza-app-bot:dm-state:channel-a",
      kind: "string",
      value: JSON.stringify({
        channelId: "channel-a",
        userId: "user-a",
        lastMessageId: "123",
        complete: "完整".repeat(20000),
      }),
      expiresAt: null,
    },
    {
      key: "discord:pod:already-expired",
      kind: "string",
      value: "expired",
      expiresAt: 1,
    },
  ],
};
test("private snapshot retains persistent sets, full cursor values, and original expiry", async () => {
  expect(
    (await call({ ...snapshot, sourceQuiesced: false }, "/private")).status,
  ).toBe(400);
  expect(await (await call(snapshot, "/private")).json()).toBe("imported");
  expect(await (await call(snapshot, "/private")).json()).toBe("identical");
  expect((await call({ ...snapshot, entries: [] }, "/private")).status).toBe(
    409,
  );
  expect(await ok({ action: "members", key: channels })).toEqual([
    "channel-a",
    "channel-b",
  ]);
  expect(
    await ok({
      action: "get",
      key: "discord:eliza-app-bot:dm-state:channel-a",
    }),
  ).toEqual(JSON.parse(snapshot.entries[1]!.value as string));
  expect(
    await ok({ action: "get", key: "discord:pod:already-expired" }),
  ).toBeNull();
  expect((await call(snapshot, "/private")).status).toBe(409);
});
test("real concurrent claims choose one owner and stale owners cannot renew or release successors", async () => {
  const claims = await Promise.all(
    Array.from({ length: 20 }, (_, i) =>
      ok({ action: "set", key: leader, value: `owner-${i}`, nx: true, ex: 1 }),
    ),
  );
  expect(claims.filter((v) => v === "OK")).toHaveLength(1);
  const oldOwner = await ok({ action: "get", key: leader });
  expect(typeof oldOwner).toBe("string");
  await new Promise((resolve) => setTimeout(resolve, 1100));
  expect(
    await ok({
      action: "set",
      key: leader,
      value: "successor",
      nx: true,
      ex: 10,
    }),
  ).toBe("OK");
  expect(
    await ok({
      action: "compareExpire",
      key: leader,
      value: oldOwner,
      seconds: 100,
    }),
  ).toBe(0);
  expect(
    await ok({ action: "compareDelete", key: leader, value: oldOwner }),
  ).toBe(0);
  expect(await ok({ action: "get", key: leader })).toBe("successor");
  expect(
    await ok({
      action: "compareExpire",
      key: leader,
      value: "successor",
      seconds: 1,
    }),
  ).toBe(1);
  await new Promise((resolve) => setTimeout(resolve, 1100));
  expect(await ok({ action: "get", key: leader })).toBeNull();
  expect(
    await ok({ action: "set", key: leader, value: "final", nx: true, ex: 10 }),
  ).toBe("OK");
  expect(
    await ok({ action: "compareDelete", key: leader, value: "final" }),
  ).toBe(1);
}, 15_000);
test("pod membership, cursor state, expiry, and serving seal survive owner restart", async () => {
  expect(
    await ok({
      action: "addMembers",
      key: channels,
      members: ["channel-c", "channel-c", "channel-d"],
    }),
  ).toBe(2);
  expect(
    await ok({
      action: "removeMembers",
      key: channels,
      members: ["channel-c", "missing"],
    }),
  ).toBe(1);
  expect(
    await ok({
      action: "setex",
      key: "discord:session:short",
      seconds: 1,
      value: "short-session",
    }),
  ).toBe("OK");
  await worker.dispose();
  worker = start();
  await worker.ready;
  expect(
    ((await ok({ action: "members", key: channels })) as string[]).sort(),
  ).toEqual(["channel-a", "channel-b", "channel-d"]);
  expect(
    await ok({
      action: "get",
      key: "discord:eliza-app-bot:dm-state:channel-a",
    }),
  ).toEqual(JSON.parse(snapshot.entries[1]!.value as string));
  await new Promise((resolve) => setTimeout(resolve, 1100));
  expect(await ok({ action: "get", key: "discord:session:short" })).toBeNull();
  expect((await call(snapshot, "/private")).status).toBe(409);
}, 15_000);
test("public boundary excludes other stores and imports; mixed deletes are atomic", async () => {
  expect(
    (
      await call(
        { operation: "get", key: leader },
        "/internal/discord-coordination",
        "wrong",
      )
    ).status,
  ).toBe(401);
  expect(
    (await call({ operation: "get", key: leader }, "/wrong-kind")).status,
  ).toBe(404);
  expect((await call(snapshot, "/internal/discord-coordination")).status).toBe(
    400,
  );
  expect(
    (
      await call(
        { operation: ["get"], key: leader },
        "/internal/discord-coordination",
      )
    ).status,
  ).toBe(400);
  expect(
    (
      await call(
        { operation: "get", key: "discord:eliza-app:install-welcome:pending" },
        "/internal/discord-coordination",
      )
    ).status,
  ).toBe(400);
  expect(
    (
      await call(
        { operation: "delete", keys: [channels, "other:tenant"] },
        "/internal/discord-coordination",
      )
    ).status,
  ).toBe(400);
  expect(
    (await ok({ action: "members", key: channels })) as string[],
  ).toHaveLength(3);
  expect(
    (
      await call(
        { operation: "set", key: leader, value: "owner", ex: 1, px: 1 },
        "/internal/discord-coordination",
      )
    ).status,
  ).toBe(400);
  expect(
    (
      await call(
        { operation: "get", key: channels },
        "/internal/discord-coordination",
      )
    ).status,
  ).toBe(409);
});
test("native selection cannot fall back to Redis or leave welcome and receipt writes behind", () => {
  expect(discordCoordinationStore({})).toBeNull();
  expect(() =>
    discordCoordinationStore({ CLOUD_DISCORD_COORDINATION_BACKEND: "invalid" }),
  ).toThrow("Invalid");
  expect(() =>
    discordCoordinationStore({
      CLOUD_DISCORD_COORDINATION_BACKEND: "cloudflare",
      MOCK_REDIS: "1",
    }),
  ).toThrow("requires native welcome and receipt");
  expect(() =>
    discordCoordinationStore({
      CLOUD_DISCORD_COORDINATION_BACKEND: "cloudflare",
      CLOUD_DISCORD_WELCOME_BACKEND: "cloudflare",
      CLOUD_GATEWAY_RECEIPTS_BACKEND: "cloudflare",
    }),
  ).toThrow("DISCORD_COORDINATION_URL");
});
