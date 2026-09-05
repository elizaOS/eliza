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
      CREATE TABLE agent_sandboxes (id text, agent_name text, organization_id text, user_id text,
        status text DEFAULT 'error', lifecycle_job_id text, lifecycle_execution_generation text, deletion_attempt_id text);
      CREATE TABLE organizations (id text, is_active boolean, account_lifecycle_state text,
        account_lifecycle_revision bigint, account_deletion_request_id text);
      CREATE TABLE job_execution_leases (job_id text, expires_at timestamp);
      CREATE TABLE personal_dedicated_upgrade_authorities (dedicated_agent_id text, organization_id text, user_id text);
      CREATE TABLE jobs (id text, agent_id text, organization_id text, user_id text, type text,
        created_at timestamp, started_at timestamp, updated_at timestamp, attempts integer, error text,
        error_storage text NOT NULL DEFAULT 'inline', execution_generation text, execution_quiesced_at timestamp);
      INSERT INTO organizations VALUES ('owner-org', true, 'active', 1, null);
      INSERT INTO agent_sandboxes (id, agent_name, organization_id, user_id) VALUES
        ('canary', 'managed-dedicated-canary-r33717318238a1', 'owner-org', 'owner-user'),
        ('target', 'personal', 'owner-org', 'owner-user'),
        ('foreign', 'personal', 'foreign-org', 'owner-user');
      INSERT INTO personal_dedicated_upgrade_authorities VALUES
        ('target', 'owner-org', 'owner-user'), ('foreign', 'foreign-org', 'owner-user');
      INSERT INTO jobs (id, agent_id, organization_id, user_id, type, created_at, started_at, updated_at, attempts, error) VALUES
        ('older', 'target', 'owner-org', 'owner-user', 'agent_provision', '2026-09-01', null, '2026-09-01', 1, 'Docker health timeout'),
        ('foreign', 'target', 'foreign-org', 'owner-user', 'agent_provision', '2026-09-05', null, '2026-09-05', 1, 'SSH timeout'),
        ('other-user', 'target', 'owner-org', 'other-user', 'agent_provision', '2026-09-05', null, '2026-09-05', 1, 'Headscale timeout');
    `);
    await db.query(
      "INSERT INTO jobs (id, agent_id, organization_id, user_id, type, created_at, started_at, updated_at, attempts, error) VALUES ('current', 'target', 'owner-org', 'owner-user', 'agent_provision', '2026-09-04', '2026-09-04', '2026-09-04', 3, $1)",
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
      errorStoredExternally: false,
      failureKind: "database_pool_timeout",
      organizationActive: true,
      accountLifecycleState: "active",
      accountLifecycleRevision: "1",
      accountDeletionRequested: false,
      jobHasLiveLease: false,
      errorTerms: ["connect", "credential", "exceeded", "timeout", "trying"],
      stackModules: ["pg-pool/index.js"],
    });
    expect(JSON.stringify(report)).not.toMatch(
      /PRIVATE|private\.example|owner-org|owner-user|foreign|other-user/,
    );

    await db.query("UPDATE jobs SET error = $1 WHERE id = 'current'", [
      "Unexpected operation failure\n at /private/provisioning-account-lifecycle-fence.ts:1:1\n at /private/with-timeout.ts:2:1",
    ]);
    const stackOnly = await db.query<{
      json_build_object: Record<string, unknown>;
    }>(query, ["r33717318238a1"]);
    expect(stackOnly.rows[0].json_build_object).toMatchObject({
      failureKind: "unclassified",
      errorTerms: ["operation"],
      stackFrames: [
        "provisioning-account-lifecycle-fence.ts:1:1",
        "with-timeout.ts:2:1",
      ],
    });

    await db.query("UPDATE jobs SET error = $1 WHERE id = 'current'", [
      "Error: UND_ERR_CONNECT_TIMEOUT (RequestTimeoutError)\n at /private/path/headscale-client.ts:555:10",
    ]);
    const machineCode = await db.query<{
      json_build_object: Record<string, unknown>;
    }>(query, ["r33717318238a1"]);
    expect(machineCode.rows[0].json_build_object).toMatchObject({
      failureKind: "timeout",
      errorTerms: ["connect", "request", "timeout"],
      stackFrames: ["headscale-client.ts:555:10"],
      stackModules: ["headscale-client.ts"],
    });

    await db.query("UPDATE jobs SET error = $1 WHERE id = 'current'", [
      "Error: VPN_REGISTRATION_TIMEOUT_MS must be at least 360000",
    ]);
    const configurationFailure = await db.query<{
      json_build_object: Record<string, unknown>;
    }>(query, ["r33717318238a1"]);
    expect(configurationFailure.rows[0].json_build_object).toMatchObject({
      failureKind: "vpn_registration_budget_invalid",
      errorTerms: ["timeout", "vpn"],
    });

    await db.exec(`
      UPDATE jobs SET error = 'Account lifecycle fenced provisioning job PRIVATE_ID', execution_generation = 'generation', execution_quiesced_at = NOW() WHERE id = 'current';
      UPDATE organizations SET is_active = false, account_lifecycle_state = 'deletion_recovery', account_lifecycle_revision = 2, account_deletion_request_id = 'PRIVATE_REQUEST';
      UPDATE agent_sandboxes SET lifecycle_job_id = 'current', lifecycle_execution_generation = 'generation' WHERE id = 'target';
      INSERT INTO job_execution_leases VALUES ('current', NOW() + INTERVAL '1 hour');
    `);
    const fenced = await db.query<{
      json_build_object: Record<string, unknown>;
    }>(query, ["r33717318238a1"]);
    expect(fenced.rows[0].json_build_object).toMatchObject({
      failureKind: "account_preparation_fenced",
      organizationActive: false,
      accountLifecycleState: "deletion_recovery",
      accountLifecycleRevision: "2",
      accountDeletionRequested: true,
      sandboxLifecycleJobMatches: true,
      sandboxGenerationMatches: true,
      jobHasLiveLease: true,
      jobQuiesced: true,
    });
    expect(JSON.stringify(fenced.rows)).not.toContain("PRIVATE");

    await db.exec(
      "UPDATE jobs SET error_storage = 'r2', error = null WHERE id = 'current'",
    );
    const external = await db.query<{
      json_build_object: Record<string, unknown>;
    }>(query, ["r33717318238a1"]);
    expect(external.rows[0].json_build_object).toMatchObject({
      errorStoredExternally: true,
      failureKind: "external_error",
    });

    await db.exec(
      "INSERT INTO agent_sandboxes (id, agent_name, organization_id, user_id) VALUES ('duplicate', 'managed-dedicated-canary-r33717318238a1', 'foreign-org', 'owner-user')",
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
