/** Exercises the protected diagnostic SQL against PostgreSQL with competing tenant records. */
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";

const workflow = Bun.YAML.parse(
  readFileSync(
    new URL("../../../.github/workflows/live-smoke.yml", import.meta.url),
    "utf8",
  ),
) as { jobs: Record<string, { steps: { name?: string; run?: string }[] }> };
const step = workflow.jobs["dedicated-diagnostic"].steps.find(
  (candidate) => candidate.name === "Diagnose activated target job origin",
);
const source = step?.run?.match(/WITH canary AS \([\s\S]+?(?=COMMIT;)/)?.[0];
if (!source) throw new Error("Missing hosted activation origin query");
const query = source.replace(":'suffix'", "$1");

test("reads only the bound owner's latest provision error and emits closed terms", async () => {
  const db = new PGlite();
  try {
    await db.exec(`
      CREATE TABLE agent_sandboxes (id text, agent_name text, organization_id text, user_id text);
      CREATE TABLE personal_dedicated_upgrade_authorities (dedicated_agent_id text, organization_id text, user_id text);
      CREATE TABLE jobs (id text, agent_id text, organization_id text, user_id text, type text,
        created_at timestamp, started_at timestamp, updated_at timestamp, attempts integer, error text, error_storage jsonb);
      INSERT INTO agent_sandboxes VALUES
        ('canary', 'managed-dedicated-canary-r33717318238a1', 'owner-org', 'owner-user'),
        ('target', 'personal', 'owner-org', 'owner-user'),
        ('foreign', 'personal', 'foreign-org', 'owner-user');
      INSERT INTO personal_dedicated_upgrade_authorities VALUES
        ('target', 'owner-org', 'owner-user'), ('foreign', 'foreign-org', 'owner-user');
      INSERT INTO jobs VALUES
        ('older', 'target', 'owner-org', 'owner-user', 'agent_provision', '2026-09-01', null, '2026-09-01', 1, 'Docker health timeout', null),
        ('foreign', 'target', 'foreign-org', 'owner-user', 'agent_provision', '2026-09-05', null, '2026-09-05', 1, 'SSH timeout', null),
        ('other-user', 'target', 'owner-org', 'other-user', 'agent_provision', '2026-09-05', null, '2026-09-05', 1, 'Headscale timeout', null);
    `);
    await db.query(
      "INSERT INTO jobs VALUES ('current', 'target', 'owner-org', 'owner-user', 'agent_provision', '2026-09-04', '2026-09-04', '2026-09-04', 3, $1, null)",
      [
        "timeout exceeded when trying to connect PRIVATE_CREDENTIAL https://private.example\n at /private/path/pg-pool/index.js:45:1",
      ],
    );
    const result = await db.query<{
      json_build_object: Record<string, unknown>;
    }>(query, ["r33717318238a1"]);
    const report = result.rows[0].json_build_object;
    expect(report).toMatchObject({
      targetCount: 1,
      jobCount: 1,
      attempts: 3,
      errorTerms: ["connect", "exceeded", "pool", "timeout", "trying"],
      stackModules: ["pg-pool/index.js"],
    });
    expect(JSON.stringify(report)).not.toMatch(
      /PRIVATE|private\.example|owner-org|owner-user|foreign|other-user/,
    );

    await db.exec(
      "INSERT INTO agent_sandboxes VALUES ('duplicate', 'managed-dedicated-canary-r33717318238a1', 'foreign-org', 'owner-user')",
    );
    const ambiguous = await db.query<{
      json_build_object: Record<string, unknown>;
    }>(query, ["r33717318238a1"]);
    expect(ambiguous.rows[0].json_build_object).toMatchObject({
      canaryCount: 2,
      targetCount: 0,
      jobCount: 0,
      errorTerms: [],
    });
    const missing = await db.query<{
      json_build_object: Record<string, unknown>;
    }>(query, ["missing"]);
    expect(missing.rows[0].json_build_object).toMatchObject({
      canaryCount: 0,
      targetCount: 0,
      jobCount: 0,
    });
  } finally {
    await db.close();
  }
});
