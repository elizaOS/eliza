/**
 * Migration 0196 relocates Cloud identity-approval onto distinct table names
 * so plugin-sql's `approval_requests` queue is never selected by Drizzle.
 * Deterministic string contracts — no live database.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const MIGRATION = join(
  import.meta.dir,
  "migrations/0196_cloud_approval_requests_distinct_tables.sql",
);
const SCHEMA = join(import.meta.dir, "schemas/approval-requests.ts");

describe("0196 cloud approval requests distinct tables (#18074)", () => {
  const sql = readFileSync(MIGRATION, "utf8");
  const schema = readFileSync(SCHEMA, "utf8");

  test("creates Cloud tables under distinct names", () => {
    expect(sql).toContain("CREATE TABLE IF NOT EXISTS cloud_approval_requests");
    expect(sql).toContain(
      "CREATE TABLE IF NOT EXISTS cloud_approval_request_events",
    );
  });

  test("never drops or alters plugin-sql approval_requests", () => {
    expect(sql).not.toMatch(/DROP\s+TABLE\s+.*approval_requests/i);
    expect(sql).not.toMatch(/ALTER\s+TABLE\s+approval_requests/i);
  });

  test("copies only when the colliding name is Cloud-shaped", () => {
    expect(sql).toContain("column_name = 'organization_id'");
    expect(sql).toContain("INSERT INTO cloud_approval_requests");
  });

  test("preflight verifies required Cloud columns", () => {
    expect(sql).toContain("cloud_approval_requests catalog mismatch");
    expect(sql).toContain("'challenge_kind'");
    expect(sql).toContain("'signature_text'");
  });

  test("Drizzle schema targets the distinct Cloud table names", () => {
    expect(schema).toContain('"cloud_approval_requests"');
    expect(schema).toContain('"cloud_approval_request_events"');
    expect(schema).not.toMatch(/pgTable\(\s*"approval_requests"/);
  });
});
