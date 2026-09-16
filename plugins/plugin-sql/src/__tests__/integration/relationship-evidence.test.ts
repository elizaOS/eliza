/** Real SQL relationship writes, active readers, and source retirement preserve
 * independent data and archived observations across retries and later edits. */

import type { Memory } from "@elizaos/core";
import { ChannelType, type UUID } from "@elizaos/core";
import { sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { relationshipEvaluator } from "../../../../../packages/core/src/features/advanced-capabilities/evaluators/reflection-items.ts";
import { applyAddressedTo } from "../../../../../packages/core/src/runtime/addressed-to.ts";
import { EvaluatorService } from "../../../../../packages/core/src/services/evaluator.ts";
import { RelationshipsService } from "../../../../../packages/core/src/services/relationships.ts";
import type { DrizzleDatabase } from "../../types";
import { createIsolatedTestDatabase } from "../test-helpers";

const A = "00000000-0000-4000-8000-000000000081" as UUID;
const B = "00000000-0000-4000-8000-000000000082" as UUID;
const ROOM = "00000000-0000-4000-8000-000000000083" as UUID;
const OTHER_ROOM = "00000000-0000-4000-8000-000000000084" as UUID;
const SOURCE = "00000000-0000-4000-8000-000000000085";
const OTHER_SOURCE = "00000000-0000-4000-8000-000000000086";
const removal = {
  id: "remove-first",
  removedMessageIds: [SOURCE],
  changedMessageIds: [],
  currentSourceRevisions: {},
};

async function setup(name: string) {
  const fixture = await createIsolatedTestDatabase(name);
  await fixture.adapter.createEntities(
    [A, B].map((id) => ({ id, agentId: fixture.testAgentId, names: [id] }))
  );
  const service = new RelationshipsService(fixture.runtime);
  const db = fixture.adapter.getDatabase() as DrizzleDatabase;
  const rows = async () => (await db.execute(sql`SELECT * FROM relationships ORDER BY id`)).rows;
  const add = (roomId = ROOM, source = SOURCE, evidenceId = "first") =>
    service.upsertExtractedRelationship(
      A,
      B,
      {
        tags: [source === SOURCE ? "project-orion" : "neighbor"],
        metadata: { relationshipType: source === SOURCE ? "colleague" : "neighbor" },
      },
      { evidenceId, roomId, sourceRevisions: { [source]: "v1" }, isBackfill: true }
    );
  return { ...fixture, service, db, rows, add };
}

describe("Source-owned relationship observations", () => {
  it.each(["pending", "revision"])(
    "holds ambiguous legacy support for %s reconciliation without changing it",
    async (kind) => {
      const f = await setup(`relationship-legacy-${kind}`);
      try {
        await f.adapter.createRelationship({
          sourceEntityId: A,
          targetEntityId: B,
          tags: ["friend", "project-orion"],
          metadata: {
            manualNote: "keep",
            extractionEvidenceIds: ["legacy-batch"],
            extractionSourceRevisions: { [SOURCE]: "v1" },
          },
        });
        const before = await f.rows();
        await expect(
          f.service.reconcileRelationshipEvidence(ROOM, {
            id: `legacy-${kind}`,
            changedMessageIds: [],
            removedMessageIds: [],
            currentSourceRevisions: kind === "revision" ? { [SOURCE]: "v2" } : {},
            ...(kind === "pending" ? { pendingEvidenceId: "legacy-batch" } : {}),
          })
        ).rejects.toMatchObject({ code: "RELATIONSHIP_LEGACY_REVIEW_REQUIRED" });
        expect(await f.rows()).toEqual(before);
      } finally {
        await f.cleanup();
      }
    }
  );

  it("does not promote inferred fields when automatic addressed-to metadata is updated", async () => {
    const f = await setup("relationship-addressed-overlay");
    try {
      const runtime = f.runtime;
      const getService = runtime.getService.bind(runtime);
      runtime.getService = ((name: string) =>
        name === "relationships" ? f.service : getService(name)) as typeof runtime.getService;
      await runtime.createRooms([
        { id: ROOM, agentId: f.testAgentId, source: "test", type: ChannelType.GROUP },
      ]);
      await runtime.createRoomParticipants([A, B], ROOM);
      await f.adapter.createRelationship({
        sourceEntityId: A,
        targetEntityId: B,
        tags: ["addressed", "addressed:auto"],
        metadata: { source: "message_handler_addressedTo" },
      });
      await f.add();
      const result = await applyAddressedTo({
        runtime,
        addressedTo: [B],
        message: {
          id: OTHER_SOURCE as UUID,
          entityId: A,
          roomId: ROOM,
          agentId: f.testAgentId,
          content: { text: "Hello Bob" },
        },
      });
      expect(result.updated).toBe(1);
      await f.service.reconcileRelationshipEvidence(ROOM, removal);
      const restored = await f.adapter.getRelationship({ sourceEntityId: A, targetEntityId: B });
      expect(restored?.tags).toEqual(["addressed", "addressed:auto"]);
      expect(restored?.metadata).not.toHaveProperty("relationshipType");
      expect(restored?.metadata).toMatchObject({
        source: "message_handler_addressedTo",
        lastInteractionAt: expect.any(String),
      });
    } finally {
      await f.cleanup();
    }
  });

  it.each(["edit", "delete"])(
    "reconciles source %s through the actual evaluator journal",
    async (mutation) => {
      const f = await setup(`relationship-journal-${mutation}`);
      try {
        const runtime = f.runtime;
        const state = { values: {}, data: {}, text: "" };
        runtime.evaluators.length = 0;
        runtime.composeState = async () => state;
        const getService = runtime.getService.bind(runtime);
        runtime.getService = ((name: string) =>
          name === "relationships" ? f.service : getService(name)) as typeof runtime.getService;
        runtime.registerEvaluator(relationshipEvaluator);
        await runtime.createRooms([
          { id: ROOM, agentId: f.testAgentId, source: "test", type: ChannelType.GROUP },
        ]);
        await runtime.createRoomParticipants([A, B], ROOM);
        await f.adapter.createRelationship({
          sourceEntityId: A,
          targetEntityId: B,
          tags: ["friend"],
          metadata: { relationshipType: "friend", interactions: 4, manualNote: "keep" },
        });
        const message: Memory = {
          id: SOURCE as UUID,
          entityId: A,
          agentId: f.testAgentId,
          roomId: ROOM,
          createdAt: 10,
          content: { text: "We also work together on Orion." },
        };
        await runtime.upsertMemory(message, "messages");
        let calls = 0;
        let relationships = [
          {
            sourceEntityId: A,
            targetEntityId: B,
            relationshipType: "colleague",
            tags: ["project-orion"],
          },
        ];
        runtime.useModel = (async () => {
          calls++;
          return JSON.stringify({ relationships: { relationships } });
        }) as typeof runtime.useModel;
        const evaluator = (await EvaluatorService.start(runtime)) as EvaluatorService;
        const options = { phase: "post_turn" as const, didRespond: true };
        expect((await evaluator.run(message, state, options)).errors).toEqual([]);
        expect(
          (await f.adapter.getRelationship({ sourceEntityId: A, targetEntityId: B }))?.tags
        ).toContain("project-orion");
        const next = {
          ...message,
          id: OTHER_SOURCE as UUID,
          createdAt: 20,
          content: { text: "Thanks." },
        };
        await runtime.upsertMemory(next, "messages");
        if (mutation === "delete") await runtime.deleteMemory(SOURCE as UUID);
        else
          await runtime.updateMemory({
            id: SOURCE as UUID,
            content: { text: "Correction: we are friends, not colleagues." },
          });
        relationships = [];
        expect((await evaluator.run(next, state, options)).errors).toEqual([]);
        const restored = await f.adapter.getRelationship({ sourceEntityId: A, targetEntityId: B });
        expect(restored?.tags).toEqual(["friend"]);
        expect(restored?.metadata).toEqual({
          relationshipType: "friend",
          interactions: 4,
          manualNote: "keep",
        });
        const completedCalls = calls;
        expect((await evaluator.run(next, state, options)).errors).toEqual([]);
        expect(calls).toBe(completedCalls);
      } finally {
        await f.cleanup();
      }
    }
  );

  it("restores manual values and preserves another room's support, with exact retirement replay", async () => {
    const f = await setup("relationship-evidence-manual");
    try {
      await f.adapter.createRelationship({
        sourceEntityId: A,
        targetEntityId: B,
        tags: ["friend"],
        metadata: { relationshipType: "friend", manualNote: "keep", interactions: 4 },
      });
      await Promise.all([f.add(), f.add(OTHER_ROOM, OTHER_SOURCE, "other")]);
      await f.service.reconcileRelationshipEvidence(ROOM, removal);
      const [active] = await f.adapter.getRelationships({ entityIds: [A] });
      expect(active.tags).toEqual(["friend", "neighbor"]);
      expect(active.metadata).toMatchObject({
        relationshipType: "neighbor",
        manualNote: "keep",
        interactions: 4,
      });
      const after = await f.rows();
      await f.service.reconcileRelationshipEvidence(ROOM, removal);
      expect(await f.rows()).toEqual(after);
      await f.service.reconcileRelationshipEvidence(OTHER_ROOM, {
        ...removal,
        id: "remove-other",
        removedMessageIds: [OTHER_SOURCE],
      });
      const restored = await f.adapter.getRelationship({ sourceEntityId: A, targetEntityId: B });
      expect(restored?.tags).toEqual(["friend"]);
      expect(restored?.metadata).toEqual({
        relationshipType: "friend",
        manualNote: "keep",
        interactions: 4,
      });
      expect(restored).not.toHaveProperty("extractionEvidence");
    } finally {
      await f.cleanup();
    }
  });

  it("hides unsupported derived edges in every reader, retains archives, and permits explicit recreation", async () => {
    const f = await setup("relationship-evidence-retirement");
    try {
      await f.add();
      const first = await f.adapter.getRelationship({ sourceEntityId: A, targetEntityId: B });
      expect(first).not.toBeNull();
      await f.service.reconcileRelationshipEvidence(ROOM, removal);
      expect(await f.adapter.getRelationship({ sourceEntityId: A, targetEntityId: B })).toBeNull();
      expect(await f.adapter.getRelationships({ entityIds: [A] })).toEqual([]);
      expect(await f.adapter.getRelationshipsByIds([first!.id])).toEqual([]);
      expect(await f.rows()).toHaveLength(1);
      await expect(f.add()).rejects.toMatchObject({
        code: "RELATIONSHIP_EVIDENCE_REPLAY_MISMATCH",
      });
      expect(
        await f.adapter.createRelationship({
          sourceEntityId: A,
          targetEntityId: B,
          tags: ["confirmed"],
          metadata: { verified: true },
        })
      ).toBe(true);
      await f.service.reconcileRelationshipEvidence(ROOM, removal);
      expect(
        (await f.adapter.getRelationship({ sourceEntityId: A, targetEntityId: B }))?.tags
      ).toEqual(["confirmed"]);
      expect(await f.rows()).toHaveLength(1);
    } finally {
      await f.cleanup();
    }
  });

  it("preserves a later independent replacement instead of restoring an obsolete baseline", async () => {
    const f = await setup("relationship-evidence-replacement");
    try {
      await f.add();
      const original = await f.adapter.getRelationship({ sourceEntityId: A, targetEntityId: B });
      expect(original).not.toBeNull();
      await f.adapter.updateRelationship({
        ...original!,
        tags: ["verified-colleague"],
        metadata: {
          verified: true,
          relationshipType: "colleague",
          manualNote: "confirmed independently",
        },
      });
      await f.service.reconcileRelationshipEvidence(ROOM, removal);
      expect(
        (await f.adapter.getRelationship({ sourceEntityId: A, targetEntityId: B }))?.metadata
      ).toEqual({
        verified: true,
        relationshipType: "colleague",
        manualNote: "confirmed independently",
      });
    } finally {
      await f.cleanup();
    }
  });

  it("rolls back a failed first write and admits one retry without counting it twice", async () => {
    const f = await setup("relationship-evidence-retry");
    try {
      await f.db.execute(
        sql.raw(
          "CREATE FUNCTION deny_relationship_update() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'test failure'; END $$"
        )
      );
      await f.db.execute(
        sql.raw(
          "CREATE TRIGGER deny_relationship_update BEFORE UPDATE ON relationships FOR EACH ROW EXECUTE FUNCTION deny_relationship_update()"
        )
      );
      await expect(f.add()).rejects.toMatchObject({
        cause: expect.objectContaining({ message: "test failure" }),
      });
      expect(await f.rows()).toEqual([]);
      await f.db.execute(sql.raw("DROP TRIGGER deny_relationship_update ON relationships"));
      await f.add();
      const before = await f.rows();
      await f.add();
      expect(await f.rows()).toEqual(before);
    } finally {
      await f.cleanup();
    }
  });
});
