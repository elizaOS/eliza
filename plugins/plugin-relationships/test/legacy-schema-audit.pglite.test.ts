/**
 * Real-PGlite proof for the retired relationship-schema inventory and guard.
 * The harness creates the historical tables in an isolated database, verifies
 * read-only inventory for absent, empty, and populated states, and proves that
 * populated rows make plugin startup fail closed without changing source data.
 */
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createRealTestRuntime,
  type RealTestRuntimeResult,
} from "../../../packages/app-core/test/helpers/real-runtime.ts";
import {
  inventoryLegacyRelationshipsSchema,
  LegacyRelationshipsSchemaAuditService,
} from "../src/services/legacy-schema-audit.js";

function rows(result: unknown): Array<Record<string, unknown>> {
  if (
    result &&
    typeof result === "object" &&
    "rows" in result &&
    Array.isArray(result.rows)
  ) {
    return result.rows.filter(
      (row): row is Record<string, unknown> =>
        typeof row === "object" && row !== null && !Array.isArray(row),
    );
  }
  return [];
}

describe("legacy relationships inventory — real PGlite", () => {
  let testRuntime: RealTestRuntimeResult;

  beforeAll(async () => {
    testRuntime = await createRealTestRuntime({
      characterName: "legacy-relationships-inventory",
    });
  }, 180_000);

  afterAll(async () => {
    await testRuntime?.cleanup();
  });

  async function execute(
    statement: string,
  ): Promise<Array<Record<string, unknown>>> {
    return rows(await testRuntime.runtime.db.execute(sql.raw(statement)));
  }

  it("distinguishes absent, empty, and populated tables without mutating legacy rows", async () => {
    await expect(inventoryLegacyRelationshipsSchema(execute)).resolves.toEqual({
      entities: 0,
      relationships: 0,
    });

    await execute("CREATE SCHEMA app_relationships");
    await execute(`
      CREATE TABLE app_relationships.entities (
        id uuid PRIMARY KEY,
        kind text NOT NULL,
        display_name text NOT NULL,
        attrs jsonb NOT NULL DEFAULT '{}'
      )
    `);
    await execute(`
      CREATE TABLE app_relationships.relationships (
        id uuid PRIMARY KEY,
        from_entity_id uuid NOT NULL,
        to_entity_id uuid NOT NULL,
        kind text NOT NULL,
        attrs jsonb NOT NULL DEFAULT '{}'
      )
    `);

    await expect(inventoryLegacyRelationshipsSchema(execute)).resolves.toEqual({
      entities: 0,
      relationships: 0,
    });

    await execute(`
      INSERT INTO app_relationships.entities (id, kind, display_name, attrs)
      VALUES
        ('00000000-0000-4000-8000-000000000001', 'person', 'Owner', '{"source":"fixture"}'),
        ('00000000-0000-4000-8000-000000000002', 'person', 'Friend', '{"source":"fixture"}')
    `);
    await execute(`
      INSERT INTO app_relationships.relationships (
        id, from_entity_id, to_entity_id, kind, attrs
      ) VALUES (
        '00000000-0000-4000-8000-000000000003',
        '00000000-0000-4000-8000-000000000001',
        '00000000-0000-4000-8000-000000000002',
        'knows',
        '{"evidence":["fixture"]}'
      )
    `);

    const beforeEntities = await execute(
      "SELECT id::text, kind, display_name, attrs FROM app_relationships.entities ORDER BY id",
    );
    const beforeRelationships = await execute(
      "SELECT id::text, from_entity_id::text, to_entity_id::text, kind, attrs FROM app_relationships.relationships ORDER BY id",
    );

    await expect(inventoryLegacyRelationshipsSchema(execute)).resolves.toEqual({
      entities: 2,
      relationships: 1,
    });
    await expect(
      LegacyRelationshipsSchemaAuditService.start(testRuntime.runtime),
    ).rejects.toMatchObject({
      code: "RELATIONSHIPS_LEGACY_SCHEMA_DATA_REQUIRES_IMPORT",
      context: { entities: 2, relationships: 1 },
    });

    expect(
      await execute(
        "SELECT id::text, kind, display_name, attrs FROM app_relationships.entities ORDER BY id",
      ),
    ).toEqual(beforeEntities);
    expect(
      await execute(
        "SELECT id::text, from_entity_id::text, to_entity_id::text, kind, attrs FROM app_relationships.relationships ORDER BY id",
      ),
    ).toEqual(beforeRelationships);
  });
});
