/**
 * Verifies the migration that removes the single-connection-per-user constraint
 * from platform_credentials. Uniqueness is now only enforced at
 * (organization_id, platform, platform_user_id), which allows a single user
 * to link multiple distinct Google accounts as separate rows.
 */

import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const MIGRATIONS_DIR = join(import.meta.dir, "..", "..", "db", "migrations");

function readMigration(tag: string): string {
  return readFileSync(join(MIGRATIONS_DIR, `${tag}.sql`), "utf8");
}

describe("platform_credentials multi-account migrations", () => {
  it("0067 drops platform_credentials_user_platform_idx", () => {
    const sql = readMigration("0067_allow_multiple_oauth_connections_per_user");
    expect(sql).toMatch(/DROP INDEX IF EXISTS "platform_credentials_user_platform_idx"/);
  });

  it("leaves the (org, platform, platform_user_id) unique index from migration 0019 in place", () => {
    // Migration 0019 created platform_credentials_platform_user_idx on
    // (organization_id, platform, platform_user_id). No later migration up to
    // and including 0067 should drop that index — it is the only remaining
    // uniqueness guarantee against linking the same Google account twice.
    const drop0067 = readMigration("0067_allow_multiple_oauth_connections_per_user");
    expect(drop0067).not.toMatch(/DROP INDEX[^;]*platform_credentials_platform_user_idx/i);
  });
});
