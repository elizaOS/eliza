/**
 * Pins the exact field set of the `Relationship` DTO returned by the SQL
 * adapter's list read, against a real isolated PGlite (or Postgres) adapter
 * with no mocks. `getRelationships` builds its rows from a raw query, so a
 * spread of the row would leak the snake_case storage columns beside the
 * contract fields; the single-row reader is the reference shape.
 */
import type { Entity, UUID } from "@elizaos/core";
import { v4 as uuidv4 } from "uuid";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PgDatabaseAdapter } from "../pg/adapter";
import type { PgliteDatabaseAdapter } from "../pglite/adapter";
import { createIsolatedTestDatabase } from "./test-helpers";

const RELATIONSHIP_KEYS = [
  "agentId",
  "createdAt",
  "id",
  "metadata",
  "sourceEntityId",
  "tags",
  "targetEntityId",
];

describe("getRelationships DTO shape", () => {
  let adapter: PgliteDatabaseAdapter | PgDatabaseAdapter;
  let cleanup: () => Promise<void>;
  let testAgentId: UUID;

  beforeAll(async () => {
    const setup = await createIsolatedTestDatabase("relationships-dto-shape");
    adapter = setup.adapter;
    cleanup = setup.cleanup;
    testAgentId = setup.testAgentId;
  });

  afterAll(async () => {
    if (cleanup) await cleanup();
  });

  it("returns only the Relationship contract fields, matching the single-row reader (#31977)", async () => {
    const sourceEntityId = uuidv4() as UUID;
    const targetEntityId = uuidv4() as UUID;
    await adapter.createEntities([
      { id: sourceEntityId, agentId: testAgentId, names: ["source"] } as Entity,
      { id: targetEntityId, agentId: testAgentId, names: ["target"] } as Entity,
    ]);
    expect(
      await adapter.createRelationship({
        sourceEntityId,
        targetEntityId,
        tags: ["friend"],
        metadata: { since: "2026" },
      })
    ).toBe(true);

    const listed = await adapter.getRelationships({ entityId: sourceEntityId });
    expect(listed).toHaveLength(1);
    expect(Object.keys(listed[0]).sort()).toEqual(RELATIONSHIP_KEYS);

    const single = await adapter.getRelationship({ sourceEntityId, targetEntityId });
    expect(single).not.toBeNull();
    expect(Object.keys(single ?? {}).sort()).toEqual(RELATIONSHIP_KEYS);
    expect(listed[0]).toEqual(single);
    expect(Date.parse(listed[0].createdAt ?? "")).not.toBeNaN();
    expect(listed[0].tags).toEqual(["friend"]);
    expect(listed[0].metadata).toEqual({ since: "2026" });
  });
});
