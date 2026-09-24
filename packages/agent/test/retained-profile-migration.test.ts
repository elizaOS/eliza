/** Existing profile rows survive the real host schema upgrade with destructive changes disabled. */
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { UUID } from "@elizaos/core";
import { sql } from "drizzle-orm";
import { expect, it, vi } from "vitest";
import { DatabaseMigrationService } from "../../../plugins/plugin-sql/src/migration-service.ts";
import { PgliteDatabaseAdapter } from "../../../plugins/plugin-sql/src/pglite/adapter.ts";
import { PGliteClientManager } from "../../../plugins/plugin-sql/src/pglite/manager.ts";
import { schema as sqlSchema } from "../../../plugins/plugin-sql/src/schema.ts";
import { createElizaPlugin } from "../src/runtime/eliza-plugin.ts";
import { retainedPendantSessionSchema } from "../src/runtime/retained-pendant-schema.ts";

it("keeps retired session, segment and insight rows during host migration", async () => {
  vi.stubEnv("ELIZA_ALLOW_DESTRUCTIVE_MIGRATIONS", "false");
  vi.stubEnv("ELIZA_DATABASE_PROVIDER", undefined);
  const directory = await mkdtemp(join(tmpdir(), "eliza-retained-schema-"));
  const manager = new PGliteClientManager({ dataDir: directory });
  const adapter = new PgliteDatabaseAdapter(randomUUID() as UUID, manager);
  const content = "Keep  exact\ntext — including spacing.";
  try {
    await adapter.init();
    const migrations = new DatabaseMigrationService();
    await migrations.initializeWithDatabase(adapter.db);
    migrations.discoverAndRegisterPluginSchemas([
      { name: "@elizaos/plugin-sql", description: "SQL", schema: sqlSchema },
      {
        name: "eliza",
        description: "Previous profile",
        schema: retainedPendantSessionSchema,
      },
    ]);
    await migrations.runAllPluginMigrations();
    await adapter.db.execute(sql`INSERT INTO app_lifeops.pendant_sessions
      (id, owner_id, agent_id, started_at, state, processing_location, revision, created_at, updated_at)
      VALUES ('session', 'owner', 'agent', '2026-09-23', 'complete', 'local', 7, '2026-09-23', '2026-09-23')`);
    await adapter.db.execute(sql`INSERT INTO app_lifeops.pendant_session_segments
      (id, session_id, owner_id, agent_id, ordinal, status, text, started_at, created_at, updated_at)
      VALUES ('segment', 'session', 'owner', 'agent', 0, 'final', ${content}, '2026-09-23', '2026-09-23', '2026-09-23')`);
    await adapter.db.execute(sql`INSERT INTO app_lifeops.pendant_session_insight_refs
      (id, session_id, owner_id, agent_id, segment_ids_json, created_at, updated_at)
      VALUES ('insight', 'session', 'owner', 'agent', '["segment"]', '2026-09-23', '2026-09-23')`);
    migrations.discoverAndRegisterPluginSchemas([
      createElizaPlugin({
        workspaceDir: directory,
        sessionStorePath: join(directory, "sessions.json"),
      }),
    ]);
    await migrations.runAllPluginMigrations();
    const sessions = await adapter.db.execute(
      sql`SELECT id, owner_id, agent_id, revision FROM app_lifeops.pendant_sessions`,
    );
    const segments = await adapter.db.execute(
      sql`SELECT text, ordinal FROM app_lifeops.pendant_session_segments`,
    );
    const insights = await adapter.db.execute(
      sql`SELECT segment_ids_json FROM app_lifeops.pendant_session_insight_refs`,
    );
    expect(sessions.rows).toEqual([
      { id: "session", owner_id: "owner", agent_id: "agent", revision: 7 },
    ]);
    expect(segments.rows).toEqual([{ text: content, ordinal: 0 }]);
    expect(insights.rows).toEqual([{ segment_ids_json: '["segment"]' }]);
  } finally {
    await adapter.close();
    vi.unstubAllEnvs();
    await rm(directory, { recursive: true, force: true });
  }
}, 120_000);
