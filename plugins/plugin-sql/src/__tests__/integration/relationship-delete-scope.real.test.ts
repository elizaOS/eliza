/** Verifies deleteRelationships is scoped to the adapter's agent on real PGlite. */
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { UUID } from "@elizaos/core";
import { afterEach, beforeEach, expect, test } from "vitest";
import { createDatabaseAdapter, plugin } from "../../index";

const id = () => randomUUID() as UUID;

let directory: string | undefined;
let adapter: ReturnType<typeof createDatabaseAdapter>;
let hostAgentId: UUID;

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "relationship-delete-scope-"));
  hostAgentId = id();
  adapter = createDatabaseAdapter({ dataDir: directory }, hostAgentId);
  await adapter.initialize();
  if (!adapter.runPluginMigrations) throw new Error("SQL migrations unavailable");
  await adapter.runPluginMigrations([plugin]);
  await adapter.createAgents([
    { id: hostAgentId, name: "Host", createdAt: Date.now(), updatedAt: Date.now() },
  ]);
}, 120000);

afterEach(async () => {
  try {
    if (adapter) await adapter.close();
  } finally {
    if (directory) await rm(directory, { recursive: true, force: true });
    directory = undefined;
  }
}, 120000);

test("deleteRelationships does not delete another agent's relationships", async () => {
  const foreign = id();
  const sourceEntity = id();
  const targetEntity = id();
  const relationshipId = id();

  await adapter.createEntities([
    { id: sourceEntity, agentId: hostAgentId, names: ["Source"] },
    { id: targetEntity, agentId: hostAgentId, names: ["Target"] },
  ]);
  await adapter.createRelationship({
    sourceEntityId: sourceEntity,
    targetEntityId: targetEntity,
    tags: ["knows"],
    metadata: {},
  });
  const created = await adapter.getRelationships({
    entityId: sourceEntity,
    tags: ["knows"],
  });
  expect(created).toHaveLength(1);
  const relId = (created[0].id ?? relationshipId) as UUID;

  // A foreign-scoped adapter attempts to delete the host's relationship.
  await adapter.withAgentScope(foreign, async (scoped) => {
    await scoped.deleteRelationships([relId]);
  });

  // The host's row must survive.
  const afterForeign = await adapter.getRelationships({
    entityId: sourceEntity,
    tags: ["knows"],
  });
  expect(afterForeign).toHaveLength(1);

  // The host can still delete its own relationship.
  await adapter.deleteRelationships([relId]);
  const afterOwn = await adapter.getRelationships({
    entityId: sourceEntity,
    tags: ["knows"],
  });
  expect(afterOwn).toHaveLength(0);
}, 120000);
