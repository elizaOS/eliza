/** The additive upgrade preserves unknown legacy precision and accepts every provider state. */
import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { VERTEX_TUNING_JOB_STATES } from "../../types/vertex-tuning";

test("0562 preserves legacy unknown precision and adds complete Vertex state authority", async () => {
  const db = new PGlite();
  try {
    await db.exec(`CREATE TYPE vertex_tuning_job_state AS ENUM ('JOB_STATE_PENDING','JOB_STATE_RUNNING','JOB_STATE_SUCCEEDED','JOB_STATE_FAILED','JOB_STATE_CANCELLED');
      CREATE TABLE vertex_tuning_jobs(id integer PRIMARY KEY,status vertex_tuning_job_state,updated_at timestamptz);
      INSERT INTO vertex_tuning_jobs VALUES (1,'JOB_STATE_RUNNING','2026-11-01T00:00:00.123456Z');`);
    const migration = await readFile(
      new URL("./0562_vertex_observation_authority.sql", import.meta.url),
      "utf8",
    );
    for (const statement of migration.split("--> statement-breakpoint"))
      if (statement.trim()) await db.exec(statement);
    expect(
      (
        await db.query(
          "SELECT provider_update_time,provider_payload_digest,observation_revision FROM vertex_tuning_jobs WHERE id=1",
        )
      ).rows,
    ).toEqual([
      { provider_update_time: null, provider_payload_digest: null, observation_revision: 0 },
    ]);
    for (const [index, state] of VERTEX_TUNING_JOB_STATES.entries()) {
      await db.query(
        "INSERT INTO vertex_tuning_jobs(id,status,provider_update_time,provider_payload_digest,observation_revision) VALUES($1,$2,$3,$4,1)",
        [index + 2, state, "2026-11-01T00:00:00.123456789Z", "a".repeat(64)],
      );
    }
    expect(
      (await db.query("SELECT count(*)::integer AS count FROM vertex_tuning_jobs")).rows,
    ).toEqual([{ count: 13 }]);
    await expect(
      db.query("UPDATE vertex_tuning_jobs SET provider_update_time=$1 WHERE id=1", [
        "2026-11-01T00:00:00.123456789Z",
      ]),
    ).rejects.toThrow();
    await expect(
      db.query("UPDATE vertex_tuning_jobs SET observation_revision=-1 WHERE id=1"),
    ).rejects.toThrow();
  } finally {
    await db.close();
  }
}, 30_000);
