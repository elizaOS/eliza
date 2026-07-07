// Verifies the web_push_subscriptions migration (dossier §3 PR-2): the table
// exists + is registered in the Drizzle journal, the schema is exported from
// the barrel, and — critically — the uniqueness/upsert target is the composite
// (endpoint, agent_id) so one installed PWA can subscribe to multiple agents
// without one agent's subscribe clobbering another's row. No live DB needed.
import { describe, expect, it } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const migrationsDir = join(import.meta.dirname, "migrations");
const schemasDir = join(import.meta.dirname, "schemas");

describe("web_push_subscriptions migration (PWA web push, §3 PR-2)", () => {
  const sqlPath = join(migrationsDir, "0172_web_push_subscriptions.sql");

  it("migration file exists and is registered in the journal", () => {
    expect(existsSync(sqlPath)).toBe(true);
    const journal = JSON.parse(
      readFileSync(join(migrationsDir, "meta", "_journal.json"), "utf8"),
    ) as { entries: Array<{ tag: string }> };
    expect(journal.entries.some((e) => e.tag === "0172_web_push_subscriptions")).toBe(true);
  });

  it("is additive + idempotent (CREATE ... IF NOT EXISTS)", () => {
    const sql = readFileSync(sqlPath, "utf8");
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS "web_push_subscriptions"');
    // No destructive statements.
    expect(sql).not.toMatch(/\bDROP\s+TABLE\b/i);
  });

  it("keys uniqueness on the composite (endpoint, agent_id), not endpoint alone", () => {
    const sql = readFileSync(sqlPath, "utf8");
    // The composite unique index must be present…
    expect(sql).toMatch(
      /CREATE UNIQUE INDEX[^\n]*web_push_subscriptions_endpoint_agent_uidx[^\n]*\("endpoint", "agent_id"\)/,
    );
    // …and there must be NO endpoint-only UNIQUE index (the multi-agent bug).
    expect(sql).not.toMatch(
      /CREATE UNIQUE INDEX[^\n]*ON "web_push_subscriptions" \("endpoint"\)\s*;/,
    );
  });

  it("cascades on user delete + has the prune-by-endpoint index", () => {
    const sql = readFileSync(sqlPath, "utf8");
    expect(sql).toMatch(/REFERENCES "users"\("id"\) ON DELETE CASCADE/);
    expect(sql).toMatch(/web_push_subscriptions_endpoint_idx/);
  });

  it("schema source is exported from the barrel", () => {
    const barrel = readFileSync(join(schemasDir, "index.ts"), "utf8");
    expect(barrel).toContain('export * from "./web-push-subscriptions"');
  });

  it("schema defines the composite unique index matching the migration", () => {
    const schema = readFileSync(join(schemasDir, "web-push-subscriptions.ts"), "utf8");
    expect(schema).toContain("web_push_subscriptions_endpoint_agent_uidx");
    expect(schema).toMatch(/\.on\(\s*table\.endpoint,\s*table\.agent_id,?\s*\)/);
  });
});
