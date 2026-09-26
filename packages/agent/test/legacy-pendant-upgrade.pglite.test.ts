/** Real host migration keeps retired pendant rows and owner/agent constraints on upgrade. */
import { PGlite } from "@electric-sql/pglite";
import { vector } from "@electric-sql/pglite/vector";
import { knowledgeGraphSchema } from "@elizaos/plugin-relationships";
import { drizzle } from "drizzle-orm/pglite";
import { afterEach, expect, it, vi } from "vitest";
import { RuntimeMigrator } from "../../../plugins/plugin-sql/src/runtime-migrator/runtime-migrator.ts";
import { elizaSchema } from "../src/runtime/eliza-schema.ts";
import { pendantSessionSchema } from "../src/runtime/legacy-pendant-schema.ts";

let database: PGlite | undefined;
afterEach(async () => {
  await database?.close();
  vi.unstubAllEnvs();
});

it("upgrades the installed host schema without deleting transcripts, references or lease state", async () => {
  vi.stubEnv("POSTGRES_URL", "");
  vi.stubEnv("DATABASE_URL", "");
  vi.stubEnv("ELIZA_ALLOW_DESTRUCTIVE_MIGRATIONS", "false");
  database = new PGlite({ extensions: { vector } });
  const connection = database;
  const migrator = new RuntimeMigrator(drizzle(database));
  // The installed APK registered these tables under the eliza host, not PA.
  await migrator.migrate("eliza", {
    ...knowledgeGraphSchema,
    ...pendantSessionSchema,
  });
  await database.exec(`
    INSERT INTO app_lifeops.pendant_sessions
      (id, owner_id, agent_id, started_at, state, processing_location, revision,
       capture_lease_holder, capture_lease_expires_at, capture_lease_token_digest, created_at, updated_at)
    VALUES ('session', 'owner', 'agent', '2026-09-01T12:00:00Z', 'capturing', 'local', 7,
      'device', '2026-09-01T13:00:00Z', 'fixture-digest', '2026-09-01T12:00:00Z', '2026-09-01T12:05:00Z');
    INSERT INTO app_lifeops.pendant_session_segments
      (id, session_id, owner_id, agent_id, ordinal, status, text, words_json,
       speaker_cluster, speaker_alias, confidence, error, started_at, ended_at, revision, created_at, updated_at)
    VALUES ('segment', 'session', 'owner', 'agent', 1, 'complete', 'Original transcript 最後🙂',
      '[{"word":"Original","start":0}]', 'speaker-1', 'Owner', 0.875, NULL,
      '2026-09-01T12:00:00Z', '2026-09-01T12:01:00Z', 3, '2026-09-01T12:00:00Z', '2026-09-01T12:01:00Z');
    INSERT INTO app_lifeops.pendant_session_insight_refs
      (id, session_id, owner_id, agent_id, segment_ids_json, revision, created_at, updated_at)
    VALUES ('insight', 'session', 'owner', 'agent', '["segment"]', 2, '2026-09-01T12:01:00Z', '2026-09-01T12:02:00Z');
  `);
  const read = async () => {
    const rows = [];
    for (const table of [
      "pendant_sessions",
      "pendant_session_segments",
      "pendant_session_insight_refs",
    ]) {
      rows.push(
        (
          await connection.query(
            `SELECT to_jsonb(t) AS row FROM app_lifeops.${table} t`,
          )
        ).rows,
      );
    }
    return rows;
  };
  const before = await read();
  // Demonstrate the removed-schema regression is blocked, never authorized.
  await expect(
    migrator.migrate("eliza", knowledgeGraphSchema),
  ).rejects.toThrow();
  expect(await read()).toEqual(before);
  await migrator.migrate("eliza", elizaSchema);
  await migrator.migrate("eliza", elizaSchema);
  expect(await read()).toEqual(before);
  expect(before.map((rows) => rows.length)).toEqual([1, 1, 1]);

  // The tenant composite key and FK still reject a reference across owners.
  await expect(
    database.query(`
    INSERT INTO app_lifeops.pendant_session_insight_refs
      (id, session_id, owner_id, agent_id, created_at, updated_at)
    VALUES ('other', 'session', 'other-owner', 'agent', 'now', 'now')
  `),
  ).rejects.toMatchObject({ code: "23503" });
  await expect(
    database.query(`
    INSERT INTO app_lifeops.pendant_session_segments
      (id, session_id, owner_id, agent_id, ordinal, status, text, started_at, created_at, updated_at)
    VALUES ('duplicate', 'session', 'owner', 'agent', 1, 'complete', 'duplicate', 'now', 'now', 'now')
  `),
  ).rejects.toMatchObject({ code: "23505" });
  expect(await read()).toEqual(before);
});
