/** Exercises the host's actual migration schema against persisted, populated legacy tables across reopen; no storage or migration mocks. */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { expect, it } from "vitest";
import { RuntimeMigrator } from "../../../plugins/plugin-sql/src/runtime-migrator/runtime-migrator.ts";
import { createElizaPlugin } from "../src/runtime/eliza-plugin.ts";
import { retainedPendantSchema } from "../src/runtime/retained-pendant-schema.ts";

it("upgrades the host without dropping retired transcripts or tenant-scoped references", async () => {
  const directory = await mkdtemp(
    path.join(tmpdir(), "retired-pendant-upgrade-"),
  );
  let database = new PGlite(directory);
  const transcript = `  complete Unicode transcript 🌍\n${"retained segment\n".repeat(2000)}last line\n`;
  const readRows = async () => {
    const tables = [
      "pendant_sessions",
      "pendant_session_segments",
      "pendant_session_insight_refs",
    ];
    return Promise.all(
      tables.map(
        async (table) =>
          (
            await database.query(
              `SELECT * FROM app_lifeops.${table} ORDER BY owner_id, agent_id, id`,
            )
          ).rows,
      ),
    );
  };
  try {
    let migrator = new RuntimeMigrator(drizzle(database));
    await migrator.initialize();
    await migrator.migrate("eliza", retainedPendantSchema);
    for (const owner of ["owner-a", "owner-b"]) {
      await database.query(
        `INSERT INTO app_lifeops.pendant_sessions
        (id, owner_id, agent_id, started_at, state, processing_location, created_at, updated_at)
        VALUES ('session', $1, 'agent', '2026-01-01', 'complete', 'local', '2026-01-01', '2026-01-01')`,
        [owner],
      );
      await database.query(
        `INSERT INTO app_lifeops.pendant_session_segments
        (id, session_id, owner_id, agent_id, ordinal, status, text, words_json, started_at, created_at, updated_at)
        VALUES ('segment', 'session', $1, 'agent', 0, 'complete', $2, '[{"word":"complete"}]', '2026-01-01', '2026-01-01', '2026-01-01')`,
        [owner, transcript],
      );
      await database.query(
        `INSERT INTO app_lifeops.pendant_session_insight_refs
        (id, session_id, owner_id, agent_id, segment_ids_json, created_at, updated_at)
        VALUES ('insight', 'session', $1, 'agent', '["segment"]', '2026-01-01', '2026-01-01')`,
        [owner],
      );
    }
    const before = await readRows();
    await database.close();
    database = new PGlite(directory);
    migrator = new RuntimeMigrator(drizzle(database));
    await migrator.initialize();
    const schema = createElizaPlugin().schema;
    if (!schema) throw new Error("The host migration schema is required");
    await migrator.migrate("eliza", schema, { allowDataLoss: false });
    expect(await readRows()).toEqual(before);
    await migrator.migrate("eliza", schema, { allowDataLoss: false });
    expect(await readRows()).toEqual(before);
    // Retention must not weaken the migrator's destructive-change guard.
    const withoutRetired = { ...schema };
    for (const key of Object.keys(retainedPendantSchema))
      delete withoutRetired[key];
    await expect(
      migrator.migrate("eliza", withoutRetired, { allowDataLoss: false }),
    ).rejects.toThrow("Destructive migration blocked");
    expect(await readRows()).toEqual(before);
  } finally {
    await database.close();
    await rm(directory, { recursive: true, force: true });
  }
}, 120_000);
