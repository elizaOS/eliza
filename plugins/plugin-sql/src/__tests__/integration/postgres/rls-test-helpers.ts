import type { IDatabaseAdapter } from "@elizaos/core";
import { drizzle } from "drizzle-orm/node-postgres";
import { Client } from "pg";
import { plugin as sqlPlugin } from "../../../index";
import { DatabaseMigrationService } from "../../../migration-service";
import { applyEntityRLSToAllTables, applyRLSToNewTables, installRLSFunctions } from "../../../rls";

export function toPostgresSuperuserUrl(connectionString: string): string {
  const superuserUrl = new URL(connectionString);
  superuserUrl.username = "postgres";
  superuserUrl.password = "postgres";
  return superuserUrl.toString();
}

export async function bootstrapPostgresRlsSchema(connectionString: string): Promise<void> {
  const setupClient = new Client({ connectionString });
  const superuserClient = new Client({
    connectionString: toPostgresSuperuserUrl(connectionString),
  });

  const previousIsolationSetting = process.env.ENABLE_DATA_ISOLATION;

  await superuserClient.connect();
  await setupClient.connect();

  try {
    await superuserClient.query(`DROP SCHEMA IF EXISTS migrations CASCADE`);
    await superuserClient.query(`
      DO $$ DECLARE
        r RECORD;
      BEGIN
        FOR r IN (SELECT tablename FROM pg_tables WHERE schemaname = 'public') LOOP
          EXECUTE 'DROP TABLE IF EXISTS public.' || quote_ident(r.tablename) || ' CASCADE';
        END LOOP;
      END $$;
    `);

    process.env.ENABLE_DATA_ISOLATION = "true";

    const db = drizzle(setupClient);
    const migrationService = new DatabaseMigrationService();
    await migrationService.initializeWithDatabase(db);
    migrationService.discoverAndRegisterPluginSchemas([sqlPlugin]);
    await migrationService.runAllPluginMigrations();

    const adapter = { db } as IDatabaseAdapter;
    await installRLSFunctions(adapter);
    await applyRLSToNewTables(adapter);
    await applyEntityRLSToAllTables(adapter);

    await setupClient.query(`GRANT ALL ON ALL TABLES IN SCHEMA public TO eliza_test`);
    await setupClient.query(`GRANT ALL ON ALL SEQUENCES IN SCHEMA public TO eliza_test`);
  } finally {
    if (previousIsolationSetting === undefined) {
      delete process.env.ENABLE_DATA_ISOLATION;
    } else {
      process.env.ENABLE_DATA_ISOLATION = previousIsolationSetting;
    }

    await setupClient.end();
    await superuserClient.end();
  }
}
