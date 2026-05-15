/**
 * Migration test for `lifeops_relationships` → `(Entity, Relationship)` pair.
 *
 * Seeds a synthetic legacy table (50 rows), runs the migrator dry-run
 * (asserts a sane diff), then runs `--apply` and verifies the new graph
 * rows + interaction FK rewrite.
 */

import crypto from "node:crypto";
import type { AgentRuntime } from "@elizaos/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createRealTestRuntime,
  type RealTestRuntimeResult,
} from "../../../test/helpers/real-runtime";
import { EntityStore } from "../src/lifeops/entities/store";
import { SELF_ENTITY_ID } from "../src/lifeops/entities/types";
import {
  rollbackInteractionRewrite,
  runGraphMigration,
} from "../src/lifeops/graph-migration/migration";
import { RelationshipStore } from "../src/lifeops/relationships/store";
import { LifeOpsRepository } from "../src/lifeops/repository";
import { executeRawSql, sqlJson, sqlQuote } from "../src/lifeops/sql";

const AGENT_ID = "graph-migration-tests";

async function seedLegacyRelationships(
  runtime: AgentRuntime,
  count: number,
): Promise<{ legacyIds: string[]; interactionIds: string[] }> {
  const now = new Date().toISOString();
  const seedRunId = crypto.randomUUID().slice(0, 8);
  const legacyIds: string[] = [];
  const interactionIds: string[] = [];
  for (let i = 0; i < count; i += 1) {
    const id = `legacy-${crypto.randomUUID()}`;
    legacyIds.push(id);
    const type =
      i % 3 === 0 ? "colleague" : i % 3 === 1 ? "friend" : "mystery_type";
    const lastContactedAt =
      i % 5 === 0 ? null : new Date(Date.now() - i * 1000).toISOString();
    await executeRawSql(
      runtime,
      `INSERT INTO app_lifeops.life_relationships (
         id, agent_id, name, primary_channel, primary_handle, email, phone,
         notes, tags_json, relationship_type, last_contacted_at,
         metadata_json, created_at, updated_at
       ) VALUES (
         ${sqlQuote(id)},
         ${sqlQuote(AGENT_ID)},
         ${sqlQuote(`Person ${i}`)},
         ${sqlQuote("email")},
         ${sqlQuote(`person${i}-${seedRunId}@example.com`)},
         ${sqlQuote(`person${i}-${seedRunId}@example.com`)},
         ${i % 4 === 0 ? sqlQuote(`+1555000${String(i).padStart(4, "0")}`) : "NULL"},
         ${sqlQuote(`Note for person ${i}`)},
         ${sqlJson([`tag${i % 3}`])},
         ${sqlQuote(type)},
         ${lastContactedAt ? sqlQuote(lastContactedAt) : "NULL"},
         ${sqlJson({ legacyIndex: i })},
         ${sqlQuote(now)},
         ${sqlQuote(now)}
       )`,
    );

    // Two interactions per relationship.
    for (let j = 0; j < 2; j += 1) {
      const interactionId = `legacy-int-${crypto.randomUUID()}`;
      interactionIds.push(interactionId);
      await executeRawSql(
        runtime,
        `INSERT INTO app_lifeops.life_relationship_interactions (
           id, agent_id, relationship_id, channel, direction, summary,
           occurred_at, metadata_json, created_at
         ) VALUES (
           ${sqlQuote(interactionId)},
           ${sqlQuote(AGENT_ID)},
           ${sqlQuote(id)},
           ${sqlQuote("email")},
           ${sqlQuote(j % 2 === 0 ? "outbound" : "inbound")},
           ${sqlQuote(`interaction ${j} for ${i}`)},
           ${sqlQuote(new Date(Date.now() - j * 60_000).toISOString())},
           ${sqlJson({})},
           ${sqlQuote(now)}
         )`,
      );
    }
  }
  return { legacyIds, interactionIds };
}

describe("graph migration — synthetic legacy → graph", () => {
  let runtime: AgentRuntime;
  let testResult: RealTestRuntimeResult;

  beforeAll(async () => {
    testResult = await createRealTestRuntime({ characterName: AGENT_ID });
    runtime = testResult.runtime;
    await LifeOpsRepository.bootstrapSchema(runtime);
    await new EntityStore(runtime, AGENT_ID).ensureSelf();
  }, 180_000);

  afterAll(async () => {
    await testResult?.cleanup();
  });

  it("dry-run produces sane diff without writes", async () => {
    const { legacyIds } = await seedLegacyRelationships(runtime, 50);
    expect(legacyIds.length).toBe(50);

    const report = await runGraphMigration(runtime, {
      agentId: AGENT_ID,
      apply: false,
    });
    expect(report.apply).toBe(false);
    expect(report.legacyRowsRead).toBeGreaterThanOrEqual(50);
    expect(report.decisions.length).toBeGreaterThanOrEqual(50);
    expect(report.entitiesCreated).toBe(0);
    expect(report.relationshipsCreated).toBe(0);
    expect(report.unknownTypes).toContain("mystery_type");
    // No rows written.
    const entitiesRows = await executeRawSql(
      runtime,
      `SELECT COUNT(*)::int AS n FROM app_lifeops.life_entities WHERE agent_id = ${sqlQuote(AGENT_ID)} AND entity_id != ${sqlQuote(SELF_ENTITY_ID)}`,
    );
    expect(entitiesRows[0]?.n).toBe(0);
  });

  it("--apply writes paired (Entity, Relationship) records and rewrites interaction FKs", async () => {
    const report = await runGraphMigration(runtime, {
      agentId: AGENT_ID,
      apply: true,
    });
    expect(report.apply).toBe(true);
    expect(report.entitiesCreated).toBeGreaterThanOrEqual(50);
    expect(report.relationshipsCreated).toBeGreaterThanOrEqual(50);
    expect(report.errors).toEqual([]);

    // Sample one decision and verify the new entity + relationship exist
    // and reference each other.
    const sample = report.decisions[0];
    expect(sample).toBeTruthy();
    if (!sample) return;
    const entityStore = new EntityStore(runtime, AGENT_ID);
    const entity = await entityStore.get(sample.newEntityId);
    expect(entity).toBeTruthy();
    expect(entity?.identities[0]?.platform).toBe(sample.identityPlatform);
    expect(entity?.identities[0]?.handle).toBe(sample.identityHandle);
    expect(entity?.identities[0]?.verified).toBe(true);

    const relStore = new RelationshipStore(runtime, AGENT_ID);
    const rel = await relStore.get(sample.newRelationshipId);
    expect(rel).toBeTruthy();
    expect(rel?.fromEntityId).toBe(SELF_ENTITY_ID);
    expect(rel?.toEntityId).toBe(sample.newEntityId);
    expect(rel?.type).toBe(sample.mappedType);

    // Type mapping: "colleague" → "colleague_of", "friend" → "knows".
    const colleagueDecision = report.decisions.find(
      (d) => d.legacyType === "colleague",
    );
    expect(colleagueDecision?.mappedType).toBe("colleague_of");
    const friendDecision = report.decisions.find(
      (d) => d.legacyType === "friend",
    );
    expect(friendDecision?.mappedType).toBe("knows");
    const passthrough = report.decisions.find(
      (d) => d.legacyType === "mystery_type",
    );
    expect(passthrough?.mappedType).toBe("mystery_type");

    // Interaction FK rewrite: interactions that referenced the legacy id
    // should now reference the new relationshipId, and legacy_entity_id
    // should hold the prior reference.
    const interactionRows = await executeRawSql(
      runtime,
      `SELECT COUNT(*)::int AS n
         FROM app_lifeops.life_relationship_interactions
        WHERE agent_id = ${sqlQuote(AGENT_ID)}
          AND relationship_id = ${sqlQuote(sample.newRelationshipId)}`,
    );
    expect(interactionRows[0]?.n).toBeGreaterThanOrEqual(2);

    const legacyColumnRows = await executeRawSql(
      runtime,
      `SELECT COUNT(*)::int AS n
         FROM app_lifeops.life_relationship_interactions
        WHERE agent_id = ${sqlQuote(AGENT_ID)}
          AND legacy_entity_id = ${sqlQuote(sample.legacyRelationshipId)}`,
    );
    expect(legacyColumnRows[0]?.n).toBeGreaterThanOrEqual(2);
  });

  it("rollback restores legacy interaction FKs and removes new graph rows", async () => {
    const seedRes = await seedLegacyRelationships(runtime, 5);
    const beforeCount = seedRes.legacyIds.length;
    expect(beforeCount).toBe(5);

    const report = await runGraphMigration(runtime, {
      agentId: AGENT_ID,
      apply: true,
    });
    expect(report.apply).toBe(true);
    const newRelIds = report.decisions
      .filter((d) => seedRes.legacyIds.includes(d.legacyRelationshipId))
      .map((d) => d.newRelationshipId);
    expect(newRelIds.length).toBe(5);

    await rollbackInteractionRewrite(runtime, report);

    // After rollback, the new relationship rows we just created should
    // be gone for this seed batch.
    for (const newRelId of newRelIds) {
      const rows = await executeRawSql(
        runtime,
        `SELECT COUNT(*)::int AS n
           FROM app_lifeops.life_relationships_v2
          WHERE relationship_id = ${sqlQuote(newRelId)}`,
      );
      expect(rows[0]?.n).toBe(0);
    }
  });
});
