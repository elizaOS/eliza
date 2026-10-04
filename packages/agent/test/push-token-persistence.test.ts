import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentRuntime, type UUID } from "@elizaos/core";
import { SQLiteDatabaseAdapter } from "@elizaos/testing/runtime";
import { expect, it } from "vitest";
import { PushTokenRegistry } from "../src/services/push/push-token-registry";

it("persists concurrent registry updates without resurrecting revoked tokens", async () => {
  const directory = await mkdtemp(join(tmpdir(), "push-registry-"));
  const agentId = randomUUID() as UUID;
  const file = join(directory, "agent.sqlite");
  const runtime = new AgentRuntime({
    agentId,
    character: { name: "Push persistence", bio: [] },
    logLevel: "fatal",
  });
  const adapter = SQLiteDatabaseAdapter.create(file, agentId);
  runtime.registerDatabaseAdapter(adapter);
  await runtime.init();
  try {
    const first = new PushTokenRegistry(runtime);
    const second = new PushTokenRegistry(runtime);
    const legacy = [
      { token: " one ", platform: "ios", createdAt: 1 },
      { token: "one", platform: "ios", createdAt: 2 },
    ];
    await runtime.setCache(`push-tokens:${agentId}`, legacy);
    await first.hydrate();
    expect(await runtime.getCache(`push-tokens:${agentId}`)).toEqual([
      { token: "one", platform: "ios", createdAt: 2 },
    ]);
    await Promise.all([
      first.register("ios", "one"),
      second.register("android", "two"),
    ]);
    expect((await first.list()).map((record) => record.token).sort()).toEqual([
      "one",
      "two",
    ]);
    await Promise.all([
      first.unregister("one"),
      second.register("ios", "three"),
    ]);
    expect((await second.list()).map((record) => record.token).sort()).toEqual([
      "three",
      "two",
    ]);
    await runtime.close();
    const restarted = new AgentRuntime({
      agentId,
      character: { name: "Push persistence", bio: [] },
      logLevel: "fatal",
    });
    restarted.registerDatabaseAdapter(
      SQLiteDatabaseAdapter.create(file, agentId),
    );
    await restarted.init();
    try {
      expect(
        (await new PushTokenRegistry(restarted).list())
          .map((record) => record.token)
          .sort(),
      ).toEqual(["three", "two"]);
    } finally {
      const restoredRegistry = new PushTokenRegistry(restarted);
      await restoredRegistry.register("android", "two", true);
      expect(
        (await new PushTokenRegistry(restarted).list()).find(
          (r) => r.token === "two",
        )?.reminderDataNotifications,
      ).toBe(true);
      await expect(
        restoredRegistry.register("android", "bad-capability", "true" as never),
      ).rejects.toMatchObject({ code: "PUSH_TOKEN_INVALID" });
      await expect(
        restoredRegistry.register("ios", "bad-platform-capability", true),
      ).rejects.toMatchObject({ code: "PUSH_TOKEN_INVALID" });
      const persisted = await restoredRegistry.list();
      await restarted.setCache(
        `push-tokens:${agentId}`,
        persisted.map((r) => ({ ...r, reminderDataNotifications: "true" })),
      );
      expect(await restoredRegistry.list()).toEqual(
        persisted.map(
          ({ reminderDataNotifications: _cap, ...legacy }) => legacy,
        ),
      );
      await restoredRegistry.register("android", "two", true);
      await restoredRegistry.register("android", "two");
      expect(
        (await restoredRegistry.list()).find((r) => r.token === "two")
          ?.reminderDataNotifications,
      ).toBeUndefined();
      await restarted.close();
    }
  } finally {
    await runtime.close();
    await rm(directory, { recursive: true, force: true });
  }
});
