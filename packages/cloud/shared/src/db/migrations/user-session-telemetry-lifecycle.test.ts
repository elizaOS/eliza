/** Applies the exact additive telemetry lifecycle migration to a legacy PGlite table. */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { PGlite } from "@electric-sql/pglite";

const migrationUrl = new URL("./0313_user_session_telemetry_lifecycle.sql", import.meta.url);
let pg: PGlite;

beforeAll(async () => {
  pg = new PGlite();
  await pg.exec(`
    CREATE TABLE user_sessions (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id uuid NOT NULL,
      session_token text NOT NULL UNIQUE,
      started_at timestamp NOT NULL DEFAULT now(),
      last_activity_at timestamp NOT NULL DEFAULT now(),
      ended_at timestamp,
      ip_address text,
      user_agent text,
      device_info jsonb NOT NULL DEFAULT '{}'::jsonb,
      updated_at timestamp NOT NULL DEFAULT now()
    );
    INSERT INTO user_sessions (user_id, session_token)
    VALUES ('00000000-0000-4000-8000-000000000001', 'legacy-hash');
  `);
  await pg.exec(await Bun.file(migrationUrl).text());
});

afterAll(async () => {
  await pg.close();
});

describe("user-session telemetry lifecycle migration", () => {
  test("adds lifecycle columns without relabelling legacy rows", async () => {
    const columns = await pg.query<{ column_name: string }>(`
      SELECT column_name FROM information_schema.columns
      WHERE table_name = 'user_sessions'
        AND column_name IN (
          'token_expires_at',
          'ended_reason',
          'retention_expires_at',
          'metadata_purged_at'
        )
      ORDER BY column_name
    `);
    expect(columns.rows.map((row) => row.column_name)).toEqual([
      "ended_reason",
      "metadata_purged_at",
      "retention_expires_at",
      "token_expires_at",
    ]);

    const legacy = await pg.query<{
      token_expires_at: Date | null;
      ended_reason: string | null;
    }>("SELECT token_expires_at, ended_reason FROM user_sessions");
    expect(legacy.rows).toEqual([{ token_expires_at: null, ended_reason: null }]);
  });

  test("accepts the documented reasons and rejects unknown lifecycle claims", async () => {
    await pg.exec("UPDATE user_sessions SET ended_reason = 'revoked'");
    await expect(
      pg.exec("UPDATE user_sessions SET ended_reason = 'authenticated'"),
    ).rejects.toThrow(/user_sessions_ended_reason_check/);
  });
});
