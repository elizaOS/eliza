/** Actual startup migration from the saved pre-observation Drizzle schema. */
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { describe, expect, it } from "vitest";
import { DatabaseMigrationService } from "../../migration-service";
import { agentTable } from "../../schema/agent";
import { entityTable } from "../../schema/entity";
import { entityIdentityTable } from "../../schema/entityIdentity";
import type { DrizzleDatabase } from "../../types";
import { legacyIdentityTable } from "./fixtures/identity-table-before-evidence";

describe("Identity evidence additive upgrade", () => {
  it("adds nullable observation storage without changing legacy claims and survives restart", async () => {
    const client = new PGlite();
    try {
      const db = drizzle(client) as unknown as DrizzleDatabase;
      const legacy = new DatabaseMigrationService({ databaseBackend: "pglite" });
      await legacy.initializeWithDatabase(db);
      legacy.registerSchema("identity-evidence-upgrade", {
        agentTable,
        entityTable,
        entityIdentityTable: legacyIdentityTable,
      });
      await legacy.runAllPluginMigrations({ verbose: false });
      await client.exec(`INSERT INTO agents (id,name) VALUES ('00000000-0000-4000-8000-000000000001','Upgrade QA');
        INSERT INTO entities (id,agent_id) VALUES ('00000000-0000-4000-8000-000000000002','00000000-0000-4000-8000-000000000001');
        INSERT INTO entity_identities (entity_id,agent_id,platform,handle,verified,confidence,source,evidence_message_ids)
        VALUES ('00000000-0000-4000-8000-000000000002','00000000-0000-4000-8000-000000000001','github','legacy',true,0.8,'manual','["00000000-0000-4000-8000-000000000003"]')`);
      const before = (await client.query("SELECT to_jsonb(i) AS value FROM entity_identities i"))
        .rows;
      const upgrade = new DatabaseMigrationService({ databaseBackend: "pglite" });
      await upgrade.initializeWithDatabase(db);
      upgrade.registerSchema("identity-evidence-upgrade", {
        agentTable,
        entityTable,
        entityIdentityTable,
      });
      await upgrade.runAllPluginMigrations({ verbose: false });
      expect(
        (
          await client.query(
            "SELECT to_jsonb(i) - 'extraction_evidence' AS value FROM entity_identities i"
          )
        ).rows
      ).toEqual(before);
      expect(
        (await client.query("SELECT extraction_evidence FROM entity_identities")).rows
      ).toEqual([{ extraction_evidence: null }]);
      const restart = new DatabaseMigrationService({ databaseBackend: "pglite" });
      await restart.initializeWithDatabase(db);
      restart.registerSchema("identity-evidence-upgrade", {
        agentTable,
        entityTable,
        entityIdentityTable,
      });
      await restart.runAllPluginMigrations({ verbose: false });
      expect(
        (
          await client.query(
            "SELECT to_jsonb(i) - 'extraction_evidence' AS value FROM entity_identities i"
          )
        ).rows
      ).toEqual(before);
    } finally {
      await client.close();
    }
  }, 30000);
});
