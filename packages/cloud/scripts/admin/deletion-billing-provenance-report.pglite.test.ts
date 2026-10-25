import { afterEach, expect, spyOn, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { hydrateJob } from "../../shared/src/db/repositories/jobs";
import type { Job } from "../../shared/src/db/schemas/jobs";
import { isAgentDeleteJobData } from "../../shared/src/lib/services/provisioning-job-policy";
import {
  getObjectStorageClient,
  resetObjectStorageClientForTests,
} from "../../shared/src/lib/storage/s3-compatible-client";
import {
  DeletionBillingProvenanceReportError,
  deletionBillingGuardQueries,
  readDeletionBillingProvenance,
  readGuardedFailedDeleteJobFacts,
} from "./deletion-billing-provenance-report";

let db: PGlite | undefined;
afterEach(async () => {
  await db?.close();
  db = undefined;
});

const migration = await readFile(
  new URL(
    "../../shared/src/db/migrations/0398_provider_unconfirmed_deletion_billing.sql",
    import.meta.url,
  ),
  "utf8",
);
const org = "00000000-0000-4000-8000-000000000001";
const agent = "00000000-0000-4000-8000-000000000002";
const container = "00000000-0000-4000-8000-000000000003";

test("reports both actual migration guards without changing lifecycle or rate authority", async () => {
  db = new PGlite();
  await db.exec(`
    CREATE TABLE containers(id uuid, organization_id uuid, lifecycle_revision int, status text);
    CREATE TABLE compute_billing_rate_segments(id int, organization_id uuid, workload_kind text, workload_id uuid, lifecycle_revision int, billing_state text, rate_per_hour numeric, effective_at timestamptz);
    CREATE TABLE container_compute_stop_intents(organization_id uuid, container_id uuid, lifecycle_revision int, provider_confirmed_at timestamptz);
    CREATE TABLE agent_sandboxes(id uuid, organization_id uuid, status text, billing_status text, pool_status text, execution_tier text, deleted_at timestamptz, deletion_previous_billing_status text, deletion_previous_status text, last_backup_at timestamptz);
    CREATE TABLE agent_compute_funding(organization_id uuid, agent_id uuid, settled_at timestamptz, provider_stopped_at timestamptz, provider_stop_receipt jsonb, settled_through timestamptz);
    INSERT INTO containers VALUES('${container}', '${org}', 2, 'deleting');
    INSERT INTO agent_sandboxes VALUES('${agent}', '${org}', 'deletion_failed', 'suspended', NULL, 'dedicated', NULL, NULL, NULL, NULL);
  `);
  const first = await readDeletionBillingProvenance(db, migration);
  expect(first.unresolvedContainerHistoryCount).toBe(1);
  expect(first.unresolvedAgentProvenanceCount).toBe(1);
  expect(JSON.stringify(first)).not.toContain(org);
  expect(
    (
      await db.query(
        "SELECT count(*)::int AS count FROM compute_billing_rate_segments",
      )
    ).rows,
  ).toEqual([{ count: 0 }]);
  expect(
    (await db.query("SELECT status, billing_status FROM agent_sandboxes")).rows,
  ).toEqual([{ status: "deletion_failed", billing_status: "suspended" }]);

  // Existing consecutive lifecycle authority and an explicitly stopped,
  // never-backed-up agent satisfy the migration's own recovery predicates.
  await db.exec(`
    INSERT INTO compute_billing_rate_segments VALUES(1, '${org}', 'container', '${container}', 1, 'running', 0.01, '2026-10-01T00:00:00Z');
    INSERT INTO compute_billing_rate_segments VALUES(2, '${org}', 'container', '${container}', 2, 'not_billable', 0, '2026-10-02T00:00:00Z');
    UPDATE agent_sandboxes SET deletion_previous_status = 'stopped';
  `);
  const second = await readDeletionBillingProvenance(db, migration);
  expect(second.unresolvedContainerHistoryCount).toBe(0);
  expect(second.unresolvedAgentProvenanceCount).toBe(0);
  expect(
    (
      await db.query(
        "SELECT rate_per_hour::text AS rate FROM compute_billing_rate_segments ORDER BY id",
      )
    ).rows,
  ).toEqual([{ rate: "0.01" }, { rate: "0" }]);
});

test("refuses a changed guard contract before executing SQL", () => {
  expect(() => deletionBillingGuardQueries("SELECT 1;")).toThrow(
    "migration_guard_contract_changed",
  );
});

const fixtureKey = "owned-staging-fixture-test-credential";
const fixtureUser = "00000000-0000-4000-8000-000000000004";
const otherOrg = "00000000-0000-4000-8000-000000000005";

async function seedAuthorityFixture(db: PGlite) {
  await db.exec(`
    CREATE TABLE containers(id uuid, organization_id uuid, lifecycle_revision int, status text);
    CREATE TABLE compute_billing_rate_segments(id int, organization_id uuid, workload_kind text, workload_id uuid, lifecycle_revision int, billing_state text, rate_per_hour numeric, effective_at timestamptz);
    CREATE TABLE container_compute_stop_intents(organization_id uuid, container_id uuid, lifecycle_revision int, provider_confirmed_at timestamptz);
    CREATE TABLE agent_sandboxes(id uuid, organization_id uuid, user_id uuid, node_id text, container_name text, deletion_attempt_id uuid, status text, billing_status text, pool_status text, execution_tier text, deleted_at timestamptz, deletion_previous_billing_status text, deletion_previous_status text, last_backup_at timestamptz);
    CREATE TABLE agent_compute_funding(organization_id uuid, agent_id uuid, settled_at timestamptz, provider_stopped_at timestamptz, provider_stop_receipt jsonb, settled_through timestamptz);
    CREATE TABLE api_keys(key_hash text, organization_id uuid, user_id uuid, is_active bool, deleted_at timestamptz, expires_at timestamptz);
    CREATE TABLE users(id uuid, organization_id uuid, is_active bool, deleted_at timestamptz);
    CREATE TABLE jobs(organization_id uuid, agent_id text, type text, status text);
    CREATE TABLE agent_compute_stop_intents(organization_id uuid, agent_id uuid, status text, provider_confirmed_at timestamptz);
    INSERT INTO users VALUES('${fixtureUser}', '${org}', true, NULL);
    INSERT INTO api_keys VALUES('${createHash("sha256").update(fixtureKey).digest("hex")}', '${org}', '${fixtureUser}', true, NULL, NULL);
    INSERT INTO agent_sandboxes VALUES('${agent}', '${otherOrg}', '${fixtureUser}', 'private-node', 'private-container', '${container}', 'deletion_failed', 'suspended', NULL, 'dedicated-always', NULL, NULL, NULL, NULL);
    INSERT INTO jobs VALUES('${otherOrg}', '${agent}', 'agent_delete', 'failed');
  `);
}

test("classifies the exact guarded agent without exposing IDs or inventing missing authority", async () => {
  db = new PGlite();
  await seedAuthorityFixture(db);
  const report = await readDeletionBillingProvenance(db, migration, {
    fixtureApiKey: fixtureKey,
  });
  expect(report.unresolvedAgentProvenanceCount).toBe(1);
  expect(report.agentAuthorityFacts).toMatchObject({
    targetCount: 1,
    credentialOrganizationMatchCount: 0,
    credentialUserMatchCount: 0,
    missingPreviousStatusCount: 1,
    missingPreviousBillingStatusCount: 1,
    hasDeletionAttemptCount: 1,
    hasActiveDeleteJobCount: 0,
    hasCompletedDeleteJobCount: 0,
    hasFailedDeleteJobCount: 1,
    hasFundingCount: 0,
    hasProviderStoppedFundingReceiptCount: 0,
    hasProviderConfirmedStopIntentCount: 0,
    hasDockerLocatorCount: 1,
  });
  const closed = JSON.stringify(report);
  for (const forbidden of [
    agent,
    org,
    otherOrg,
    fixtureUser,
    fixtureKey,
    "private-node",
    "private-container",
  ])
    expect(closed).not.toContain(forbidden);
  await db.exec(`
    UPDATE agent_sandboxes SET organization_id = '${org}';
    UPDATE jobs SET organization_id = '${org}';
    INSERT INTO agent_compute_funding VALUES('${org}', '${agent}', NULL, NOW(), '{"fixture":true}', NULL);
    INSERT INTO agent_compute_stop_intents VALUES('${org}', '${agent}', 'provider_confirmed', NOW());
  `);
  const matched = await readDeletionBillingProvenance(db, migration, {
    fixtureApiKey: fixtureKey,
  });
  expect(matched.agentAuthorityFacts).toMatchObject({
    credentialOrganizationMatchCount: 1,
    credentialUserMatchCount: 1,
    hasFundingCount: 1,
    hasProviderStoppedFundingReceiptCount: 1,
    hasProviderConfirmedStopIntentCount: 1,
  });
  // Presence is not complete settled/fenced authority; the actual guard remains unresolved.
  expect(matched.unresolvedAgentProvenanceCount).toBe(1);
  expect(
    (
      await db.query(
        "SELECT status, billing_status, deletion_previous_status FROM agent_sandboxes",
      )
    ).rows,
  ).toEqual([
    {
      status: "deletion_failed",
      billing_status: "suspended",
      deletion_previous_status: null,
    },
  ]);
  await db.exec("UPDATE api_keys SET is_active = false");
  await expect(
    readDeletionBillingProvenance(db, migration, { fixtureApiKey: fixtureKey }),
  ).rejects.toThrow("fixture_identity_unavailable");
  // A failed identity read also rolls back and leaves the client usable.
  expect(
    (await db.query("SELECT count(*)::integer AS count FROM jobs")).rows,
  ).toEqual([{ count: 1 }]);
});

test("classifies complete offloaded failed jobs over real S3 HTTP and refuses missing authority", async () => {
  db = new PGlite();
  await seedAuthorityFixture(db);
  const directory = await mkdtemp(join(tmpdir(), "failed-job-object-fixture-"));
  const data = {
    agentId: agent,
    organizationId: otherOrg,
    userId: fixtureUser,
    authorization: "user_request",
    stateLossAcknowledged: true,
    stateLossAcknowledgedByUserId: fixtureUser,
    stateLossAcknowledgedAt: "2026-10-04T00:00:00.000Z",
  };
  const privateError = `private-diagnostic ${fixtureKey}\n${"x".repeat(70_000)}\nTypeError: value.toISOString is not a function\n`;
  await writeFile(join(directory, "data.json"), JSON.stringify(data));
  await writeFile(
    join(directory, "result.json"),
    JSON.stringify({
      cloudAgentId: agent,
      containerStopped: true,
      rowDeleted: false,
    }),
  );
  await writeFile(join(directory, "error.txt"), privateError);
  const reads: string[] = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      expect(request.method).toBe("GET");
      const path = new URL(request.url).pathname;
      reads.push(path);
      const key = path.replace("/guarded-job-fixture/", "");
      if (!["data.json", "result.json", "error.txt"].includes(key)) {
        return new Response("<Error><Code>NoSuchKey</Code></Error>", {
          status: 404,
          headers: { "content-type": "application/xml" },
        });
      }
      const file = Bun.file(join(directory, key));
      if (!(await file.exists())) {
        return new Response("<Error><Code>NoSuchKey</Code></Error>", {
          status: 404,
          headers: { "content-type": "application/xml" },
        });
      }
      return new Response(file);
    },
  });
  const environment = {
    STORAGE_PROVIDER: "s3",
    STORAGE_ENDPOINT: server.url.origin,
    STORAGE_REGION: "us-east-1",
    STORAGE_ACCESS_KEY_ID: "fixture-key",
    STORAGE_SECRET_ACCESS_KEY: "fixture-secret",
    STORAGE_FORCE_PATH_STYLE: "true",
    STORAGE_HEAVY_PAYLOADS_BUCKET: "guarded-job-fixture",
  };
  const previous = Object.fromEntries(
    Object.keys(environment).map((key) => [key, process.env[key]]),
  );
  Object.assign(process.env, environment);
  resetObjectStorageClientForTests();
  try {
    await db.exec(`
      ALTER TABLE jobs ADD COLUMN id uuid DEFAULT '${container}', ADD COLUMN created_at timestamptz DEFAULT NOW(),
        ADD COLUMN user_id uuid DEFAULT '${fixtureUser}', ADD COLUMN data jsonb DEFAULT '{}',
        ADD COLUMN data_storage text DEFAULT 'r2', ADD COLUMN data_key text DEFAULT 'data.json',
        ADD COLUMN result jsonb DEFAULT '{"containerStopped":false}', ADD COLUMN result_storage text DEFAULT 'r2',
        ADD COLUMN result_key text DEFAULT 'result.json', ADD COLUMN error text DEFAULT 'inline preview',
        ADD COLUMN error_storage text DEFAULT 'r2', ADD COLUMN error_key text DEFAULT 'error.txt';
      INSERT INTO jobs(organization_id, agent_id, type, status, id) VALUES('${org}', '${agent}', 'agent_delete', 'failed', '${fixtureUser}');
    `);
    const rawJob = (
      await db.query("SELECT * FROM jobs WHERE organization_id = $1", [
        otherOrg,
      ])
    ).rows[0] as Job;
    const completeJob = await hydrateJob(rawJob, { strict: true });
    expect(completeJob.data).toEqual(data);
    expect(isAgentDeleteJobData(completeJob.data)).toBe(true);
    expect(completeJob.error).toBe(privateError);
    expect(completeJob.result).toEqual({
      cloudAgentId: agent,
      containerStopped: true,
      rowDeleted: false,
    });
    reads.length = 0;
    const report = await readDeletionBillingProvenance(db, migration, {
      fixtureApiKey: fixtureKey,
      includeFailedJobs: true,
    });
    expect(report.failedDeleteJobFacts).toEqual({
      scope: "migration_0398_unresolved_agents_failed_delete_jobs",
      status: "failed",
      failedJobCount: 1,
      validDeleteJobDataCount: 1,
      tenantMetadataMatchCount: 1,
      completeStateLossAcknowledgementCount: 1,
      containerStoppedResultCount: 1,
      rowDeletedResultCount: 0,
      offloadedPayloadJobCount: 1,
      recordedErrorCount: 1,
      legacyDateFailureCount: 1,
    });
    expect(reads.sort()).toEqual([
      "/guarded-job-fixture/data.json",
      "/guarded-job-fixture/error.txt",
      "/guarded-job-fixture/result.json",
    ]);
    expect(report.agentAuthorityFacts?.missingPreviousStatusCount).toBe(1);
    expect(report.agentAuthorityFacts?.missingPreviousBillingStatusCount).toBe(
      1,
    );
    expect(report.unresolvedAgentProvenanceCount).toBe(1);
    const closed = JSON.stringify(report);
    for (const forbidden of [
      agent,
      otherOrg,
      fixtureUser,
      fixtureKey,
      privateError,
      data.stateLossAcknowledgedAt,
      "data.json",
      "private-diagnostic",
    ]) {
      expect(closed).not.toContain(forbidden);
    }
    // A payload naming another user is not this row's tenant metadata.
    await db.query("UPDATE jobs SET user_id = $1", [container]);
    const foreignUser = await readDeletionBillingProvenance(db, migration, {
      fixtureApiKey: fixtureKey,
      includeFailedJobs: true,
    });
    expect(foreignUser.failedDeleteJobFacts).toMatchObject({
      validDeleteJobDataCount: 1,
      tenantMetadataMatchCount: 0,
      completeStateLossAcknowledgementCount: 0,
    });
    await db.query("UPDATE jobs SET user_id = $1", [fixtureUser]);
    const legacyAcknowledgement: Partial<typeof data> = { ...data };
    delete legacyAcknowledgement.stateLossAcknowledgedByUserId;
    delete legacyAcknowledgement.stateLossAcknowledgedAt;
    await writeFile(
      join(directory, "data.json"),
      JSON.stringify(legacyAcknowledgement),
    );
    const legacy = await readDeletionBillingProvenance(db, migration, {
      fixtureApiKey: fixtureKey,
      includeFailedJobs: true,
    });
    expect(legacy.failedDeleteJobFacts?.validDeleteJobDataCount).toBe(1);
    expect(
      legacy.failedDeleteJobFacts?.completeStateLossAcknowledgementCount,
    ).toBe(0);
    await rm(join(directory, "error.txt"));
    await expect(
      readDeletionBillingProvenance(db, migration, {
        fixtureApiKey: fixtureKey,
        includeFailedJobs: true,
      }),
    ).rejects.toMatchObject({
      code: "failed_job_payload_unavailable",
      cause: { code: "OBJECT_STORAGE_FIELD_UNAVAILABLE" },
    });
    expect(
      (
        await db.query(
          "SELECT status, deletion_previous_status, deletion_previous_billing_status FROM agent_sandboxes",
        )
      ).rows,
    ).toEqual([
      {
        status: "deletion_failed",
        deletion_previous_status: null,
        deletion_previous_billing_status: null,
      },
    ]);
    expect(
      (await db.query("SELECT count(*)::int AS count FROM jobs")).rows,
    ).toEqual([{ count: 2 }]);
  } finally {
    getObjectStorageClient()?.destroy();
    resetObjectStorageClientForTests();
    await server.stop(true);
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await rm(directory, { recursive: true, force: true });
  }
});

test("classifies a real failed-job query refusal without exporting its private cause", async () => {
  db = new PGlite();
  await seedAuthorityFixture(db);
  // This real schema deliberately lacks the canonical job timestamp columns.
  // The boundary must distinguish a query refusal from missing blob authority.
  const error = await readGuardedFailedDeleteJobFacts(db, migration).catch(
    (cause: unknown) => cause,
  );
  expect(error).toMatchObject({ code: "failed_job_query_failed" });
  if (!(error instanceof DeletionBillingProvenanceReportError)) throw error;
  expect(error.cause).toMatchObject({ code: "42703" });
  if (!(error.cause instanceof Error)) throw error.cause;
  expect(error.cause.message).toContain("created_at");
  expect(JSON.stringify(error)).not.toContain("created_at");
  expect(JSON.stringify(error)).not.toContain(org);
  expect(
    (await db.query("SELECT count(*)::integer AS count FROM jobs")).rows,
  ).toEqual([{ count: 1 }]);
});

test("provider diagnostic uses guarded database locators and preserves failed-deletion authority", async () => {
  db = new PGlite();
  await seedAuthorityFixture(db);
  await db.exec(`CREATE TABLE docker_nodes(node_id text, hostname text, metadata jsonb);
    INSERT INTO docker_nodes VALUES('private-node', '192.0.2.1', '{"hcloudServerId":123}');`);
  const before = (await db.query("SELECT * FROM agent_sandboxes")).rows;
  const request = spyOn(globalThis, "fetch").mockImplementation(
    async (url, init) => {
      expect(String(url)).toBe("https://api.hetzner.cloud/v1/servers/123");
      expect(init?.method).toBe("GET");
      expect(init?.redirect).toBe("error");
      return Response.json({
        server: {
          id: 123,
          name: "private-node",
          status: "running",
          public_net: { ipv4: { ip: "192.0.2.2" } },
        },
      });
    },
  );
  try {
    const found = await readDeletionBillingProvenance(db, migration, {
      providerToken: "private-token",
    });
    expect(found.providerFacts).toEqual([
      {
        subjectSha256: createHash("sha256").update(agent).digest("hex"),
        result: "found",
        recordedNameMatches: true,
        recordedAddressMatches: false,
        running: true,
        off: false,
      },
    ]);
    expect(JSON.stringify(found)).not.toMatch(
      /private-node|private-token|192\.0\.2|hcloudServerId/,
    );
    request.mockResolvedValueOnce(new Response(null, { status: 404 }));
    const absent = await readDeletionBillingProvenance(db, migration, {
      providerToken: "private-token",
    });
    expect(absent.providerFacts?.[0]?.result).toBe(
      "not_found_in_configured_project",
    );
    request.mockResolvedValueOnce(new Response(null, { status: 401 }));
    await expect(
      readDeletionBillingProvenance(db, migration, {
        providerToken: "private-token",
      }),
    ).rejects.toThrow("provider_lookup_failed");
    expect((await db.query("SELECT * FROM agent_sandboxes")).rows).toEqual(
      before,
    );
    expect(
      (await db.query("SELECT * FROM compute_billing_rate_segments")).rows,
    ).toEqual([]);
  } finally {
    request.mockRestore();
  }
});
