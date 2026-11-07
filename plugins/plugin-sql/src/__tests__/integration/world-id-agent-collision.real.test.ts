/**
 * Verifies a world id owned by another agent on the same database fails with
 * a typed, non-retried collision, and that agent-scoped world ids let two
 * agents connect side by side (real PGlite).
 */
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ChannelType, ensureConnection, stringToUuid, type UUID } from "@elizaos/core";
import { afterEach, beforeEach, expect, test } from "vitest";
import { createDatabaseAdapter, plugin } from "../../index";

const id = () => randomUUID() as UUID;

let directory: string | undefined;
let adapter: ReturnType<typeof createDatabaseAdapter>;
let ownerId: UUID;
let otherId: UUID;

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "world-id-collision-"));
  ownerId = id();
  otherId = id();
  adapter = createDatabaseAdapter({ dataDir: directory }, ownerId);
  await adapter.initialize();
  if (!adapter.runPluginMigrations) throw new Error("SQL migrations unavailable");
  await adapter.runPluginMigrations([plugin]);
  await adapter.createAgents([
    { id: ownerId, name: "Owner", createdAt: Date.now(), updatedAt: Date.now() },
  ]);
  await adapter.withAgentScope(otherId, async (scoped) => {
    await scoped.createAgents([
      { id: otherId, name: "Other", createdAt: Date.now(), updatedAt: Date.now() },
    ]);
  });
}, 120000);

afterEach(async () => {
  try {
    if (adapter) await adapter.close();
  } finally {
    if (directory) await rm(directory, { recursive: true, force: true });
    directory = undefined;
  }
}, 120000);

test("creating a world id another agent owns fails with a non-retried typed error", async () => {
  const world = id();
  await adapter.createWorlds([{ id: world, agentId: ownerId, name: "Owner world" }]);

  await adapter.withAgentScope(otherId, async (scoped) => {
    await expect(
      scoped.createWorld({ id: world, agentId: otherId, name: "Collision" })
    ).rejects.toMatchObject({ code: "WORLD_OWNED_BY_OTHER_AGENT" });
  });
  await expect(
    adapter.createWorld({ id: world, agentId: ownerId, name: "Duplicate" })
  ).rejects.toMatchObject({ code: "WORLD_ALREADY_EXISTS" });
  expect((await adapter.getWorld(world))?.name).toBe("Owner world");
}, 60000);

test("two agents on one database each connect through their own agent-scoped world", async () => {
  const serverName = "pod-1";
  const connect = async (agentId: UUID, target: typeof adapter) =>
    ensureConnection(target, {
      agentId,
      entityId: stringToUuid(`user:${agentId}`),
      roomId: stringToUuid(`${agentId}:user`),
      worldId: stringToUuid(`server:${serverName}:${agentId}`),
      userName: "user",
      source: "agent-server",
      channelId: `${agentId}-user`,
      type: ChannelType.DM,
    });

  // The runtime registers each agent's own entity before any connection.
  await adapter.createEntities([{ id: ownerId, agentId: ownerId, names: ["Owner"] }]);
  await connect(ownerId, adapter);
  await adapter.withAgentScope(otherId, async (scoped) => {
    await scoped.createEntities([{ id: otherId, agentId: otherId, names: ["Other"] }]);
    await connect(otherId, scoped);
    expect((await scoped.getWorld(stringToUuid(`server:${serverName}:${otherId}`)))?.agentId).toBe(
      otherId
    );
  });
  expect((await adapter.getWorld(stringToUuid(`server:${serverName}:${ownerId}`)))?.agentId).toBe(
    ownerId
  );
}, 60000);
