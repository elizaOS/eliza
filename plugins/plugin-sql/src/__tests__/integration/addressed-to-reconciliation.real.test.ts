/**
 * Canonical-storage reconciliation tests for applyAddressedTo (#29170 review):
 * when the speaker→target pair already exists as a NON-addressed relationship
 * (e.g. a seeded "friend" edge), the helper must upsert the addressed state
 * onto that canonical row — keeping its UUID, preserving its tags/metadata —
 * instead of calling createRelationship, which the canonical SQL store
 * rejects as a duplicate pair while the helper would still count a phantom
 * create. First block runs against a recording in-memory harness (tags
 * filter honored like the real store); second block runs the REAL
 * plugin-sql PGlite adapter + AgentRuntime wired by the repo's integration
 * helpers, proving the reconciliation on canonical SQL storage.
 */
import {
  type AgentRuntime,
  ChannelType,
  type Entity,
  type Relationship,
  type UUID,
} from "@elizaos/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
// Relative source import, the established pattern for core-internal helpers
// that are not re-exported on the package's public surface (see
// plugin-agent-orchestrator's tests): applyAddressedTo ships inside the
// bundled node entry, not as a standalone subpath export.
import { applyAddressedTo } from "../../../../../packages/core/src/runtime/addressed-to.ts";
import { relationshipTable } from "../../schema";
import type { DrizzleDatabase } from "../../types";
import { createIsolatedTestDatabase } from "../test-helpers";

const SPEAKER = "20000000-0000-4000-8000-000000000001" as UUID;
const TARGET = "20000000-0000-4000-8000-000000000002" as UUID;
const ROOM = "20000000-0000-4000-8000-000000000003" as UUID;
const AGENT = "20000000-0000-4000-8000-0000000000aa" as UUID;

function makeEntity(id: UUID, names: string[]): Entity {
  return { id, agentId: AGENT, names } as Entity;
}

describe("applyAddressedTo — canonical pair reconciliation (in-memory harness)", () => {
  interface Harness {
    runtime: unknown;
    relationships: Relationship[];
    createAttempts: number;
  }

  /** Tags-filter-respecting store, mirroring the real getRelationships. */
  function makeHarness(): Harness {
    const relationships: Relationship[] = [];
    const harness: Harness = {
      runtime: undefined,
      relationships,
      createAttempts: 0,
    };
    harness.runtime = {
      agentId: AGENT,
      character: { name: "Eliza" },
      getEntitiesForRoom: async () => [
        makeEntity(SPEAKER, ["nubilio"]),
        makeEntity(TARGET, ["sol"]),
      ],
      getRelationships: async (query: { entityIds?: UUID[]; tags?: string[] }) =>
        relationships.filter(
          (rel) =>
            (!query.entityIds || query.entityIds.includes(rel.sourceEntityId)) &&
            (!query.tags || query.tags.some((tag) => (rel.tags ?? []).includes(tag)))
        ),
      // Mirrors canonical stores: an insert for an EXISTING pair is a
      // no-op returning false (SQL: onConflictDoNothing → 0 rows).
      createRelationship: async (input: { sourceEntityId: UUID; targetEntityId: UUID }) => {
        harness.createAttempts += 1;
        if (
          relationships.some(
            (rel) =>
              rel.sourceEntityId === input.sourceEntityId &&
              rel.targetEntityId === input.targetEntityId
          )
        ) {
          return false;
        }
        relationships.push({
          id: `rel-${relationships.length + 1}` as UUID,
          ...input,
        } as unknown as Relationship);
        return true;
      },
      updateRelationship: async (rel: Relationship) => {
        const index = relationships.findIndex((r) => r.id === rel.id);
        if (index === -1) throw new Error("relationship not found");
        relationships[index] = rel;
      },
    };
    return harness;
  }

  it("upserts addressed state onto an existing NON-addressed edge instead of attempting a duplicate create", async () => {
    const harness = makeHarness();
    const { runtime, relationships } = harness;
    // Seed the canonical pair as a plain "friend" edge — no addressed tags,
    // its own metadata — exactly the reconciliation case the array harness
    // previously masked.
    relationships.push({
      id: "rel-friend" as UUID,
      sourceEntityId: SPEAKER,
      targetEntityId: TARGET,
      agentId: AGENT,
      tags: ["friend"],
      metadata: { since: "2024", note: "keep-me" },
    } as unknown as Relationship);

    const result = await applyAddressedTo({
      runtime: runtime as never,
      message: {
        id: "m1" as UUID,
        entityId: SPEAKER,
        roomId: ROOM,
        content: { text: "sol check this" },
      } as never,
      addressedTo: ["sol"],
    });

    // Reconciled onto the canonical row: counted as an update, never a create.
    expect(result).toMatchObject({ created: 0, updated: 1, resolved: [TARGET] });
    expect(harness.createAttempts).toBe(0);
    expect(relationships).toHaveLength(1);
    const row = relationships[0];
    // Same canonical UUID preserved — no duplicate legacy edge.
    expect(row.id).toBe("rel-friend");
    // Existing tags preserved, addressed tags added, no duplicates.
    expect(row.tags).toEqual(["friend", "addressed", "addressed:auto"]);
    const metadata = row.metadata as Record<string, unknown>;
    expect(metadata.since).toBe("2024");
    expect(metadata.note).toBe("keep-me");
    expect(metadata.source).toBe("message_handler_addressedTo");
    expect(metadata.lastInteractionAt).toBeTypeOf("string");
  });
});

describe("applyAddressedTo — canonical pair reconciliation (real plugin-sql storage)", () => {
  let runtime: AgentRuntime;
  let cleanup: () => Promise<void>;
  let db: DrizzleDatabase;

  beforeAll(async () => {
    const setup = await createIsolatedTestDatabase("addressed-to-reconciliation");
    runtime = setup.runtime;
    cleanup = setup.cleanup;
    db = setup.adapter.getDatabase() as DrizzleDatabase;
    await runtime.createRoom({
      id: ROOM,
      name: "reconciliation-room",
      worldId: ROOM,
      source: "test",
      type: ChannelType.GROUP,
    });
    await runtime.createEntities([makeEntity(SPEAKER, ["nubilio"]), makeEntity(TARGET, ["sol"])]);
    await runtime.createRoomParticipants([SPEAKER, TARGET], ROOM);
  });

  afterAll(async () => {
    if (cleanup) await cleanup();
  });

  it("seeds a non-addressed friend pair, then upserts addressed state onto the same canonical row", async () => {
    // Seed the canonical pair WITHOUT addressed tags, via the runtime's own
    // canonical creator.
    const seeded = await runtime.createRelationship({
      sourceEntityId: SPEAKER,
      targetEntityId: TARGET,
      tags: ["friend"],
      metadata: { since: "2024", note: "keep-me" },
    });
    expect(seeded).toBe(true);
    const seededRow = await runtime.getRelationship({
      sourceEntityId: SPEAKER,
      targetEntityId: TARGET,
    });
    expect(seededRow?.id).toBeTypeOf("string");
    const canonicalId = seededRow?.id as UUID;

    const result = await applyAddressedTo({
      runtime,
      message: {
        id: "m1" as UUID,
        entityId: SPEAKER,
        roomId: ROOM,
        content: { text: "sol check this" },
      } as never,
      addressedTo: ["sol"],
    });

    expect(result).toMatchObject({ created: 0, updated: 1, resolved: [TARGET] });

    // Persisted-state readback: exactly one row owns the pair, same UUID,
    // friend tag + addressed tags + preserved metadata.
    const rows = await db.select().from(relationshipTable);
    expect(rows).toHaveLength(1);
    const persisted = rows[0];
    expect(persisted.id).toBe(canonicalId);
    expect(persisted.tags).toContain("friend");
    expect(persisted.tags).toContain("addressed");
    expect(persisted.tags).toContain("addressed:auto");
    const metadata = (persisted.metadata ?? {}) as Record<string, unknown>;
    expect(metadata.since).toBe("2024");
    expect(metadata.note).toBe("keep-me");
    expect(metadata.source).toBe("message_handler_addressedTo");
  });
});
