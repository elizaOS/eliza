/** Actual startup migration from the saved pre-observation Drizzle schema. */
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { describe, expect, it } from "vitest";
import { DatabaseMigrationService } from "../../migration-service";
import { agentTable } from "../../schema/agent";
import { entityTable } from "../../schema/entity";
import { relationshipTable } from "../../schema/relationship";
import type { DrizzleDatabase } from "../../types";
import { legacyRelationshipTable } from "./fixtures/relationship-table-before-evidence";

describe("Relationship evidence additive upgrade", () => {
  it("adds nullable observation storage without changing legacy claims and survives restart", async () => {
    const client = new PGlite();
    try {
      const db = drizzle(client) as unknown as DrizzleDatabase;
      const legacy = new DatabaseMigrationService({ databaseBackend: "pglite" });
      await legacy.initializeWithDatabase(db);
      legacy.registerSchema("relationship-evidence-upgrade", {
        agentTable,
        entityTable,
        relationshipTable: legacyRelationshipTable,
      });
      await legacy.runAllPluginMigrations({ verbose: false });
      await client.exec(`INSERT INTO agents (id,name) VALUES ('00000000-0000-4000-8000-000000000001','Upgrade QA');
        INSERT INTO entities (id,agent_id) VALUES ('00000000-0000-4000-8000-000000000002','00000000-0000-4000-8000-000000000001');
        INSERT INTO entities (id,agent_id) VALUES ('00000000-0000-4000-8000-000000000003','00000000-0000-4000-8000-000000000001');
        INSERT INTO relationships (source_entity_id,target_entity_id,agent_id,tags,metadata)
        VALUES ('00000000-0000-4000-8000-000000000002','00000000-0000-4000-8000-000000000003','00000000-0000-4000-8000-000000000001',ARRAY['friend'],'{"verified":true,"manualNote":"keep"}')`);
      const before = (await client.query("SELECT to_jsonb(i) AS value FROM relationships i")).rows;
      const upgrade = new DatabaseMigrationService({ databaseBackend: "pglite" });
      await upgrade.initializeWithDatabase(db);
      upgrade.registerSchema("relationship-evidence-upgrade", {
        agentTable,
        entityTable,
        relationshipTable,
      });
      await upgrade.runAllPluginMigrations({ verbose: false });
      expect(
        (
          await client.query(
            "SELECT to_jsonb(i) - 'extraction_evidence' AS value FROM relationships i"
          )
        ).rows
      ).toEqual(before);
      expect((await client.query("SELECT extraction_evidence FROM relationships")).rows).toEqual([
        { extraction_evidence: null },
      ]);
      const restart = new DatabaseMigrationService({ databaseBackend: "pglite" });
      await restart.initializeWithDatabase(db);
      restart.registerSchema("relationship-evidence-upgrade", {
        agentTable,
        entityTable,
        relationshipTable,
      });
      await restart.runAllPluginMigrations({ verbose: false });
      expect(
        (
          await client.query(
            "SELECT to_jsonb(i) - 'extraction_evidence' AS value FROM relationships i"
          )
        ).rows
      ).toEqual(before);
    } finally {
      await client.close();
    }
  }, 30000);
});
