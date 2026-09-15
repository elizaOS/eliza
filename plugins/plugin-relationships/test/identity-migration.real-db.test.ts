/**
 * Exercises the external plugin identity upgrade against isolated PGlite storage.
 * Existing owner rows and the old migration ledger survive the canonical name's
 * first migration and a subsequent restart-style replay.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { expect, it } from "vitest";
import { PGliteClientManager } from "../../plugin-sql/src/pglite/manager.ts";
import { RuntimeMigrator } from "../../plugin-sql/src/runtime-migrator/runtime-migrator.ts";
import * as schema from "../src/db/index.ts";
import { relationshipsPlugin } from "../src/plugin.ts";

it("preserves owner records across external plugin identity migration", async () => {
  const directory = mkdtempSync(join(tmpdir(), "relationships-identity-"));
  const manager = new PGliteClientManager({ dataDir: directory });
  try {
    await manager.initialize();
    const db = drizzle(manager.getConnection());
    await new RuntimeMigrator(db).migrate("relationships", schema);
    const [existing] = await db
      .insert(schema.entitiesTable)
      .values({
        kind: "person",
        displayName: "Existing owner record",
      })
      .returning();
    for (let startup = 0; startup < 2; startup += 1) {
      await new RuntimeMigrator(db).migrate(relationshipsPlugin.name, schema);
      expect(await db.select().from(schema.entitiesTable)).toEqual([existing]);
    }
    const ledger = await db.execute<{ plugin_name: string }>(
      sql`SELECT plugin_name FROM migrations._migrations ORDER BY created_at`,
    );
    expect(ledger.rows.map((row) => row.plugin_name)).toEqual([
      "relationships",
      "@elizaos/plugin-relationships",
    ]);
  } finally {
    await manager.close();
    rmSync(directory, { recursive: true, force: true });
  }
}, 60_000);
