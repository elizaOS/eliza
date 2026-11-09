/** Real PostgreSQL lock waits and enrolled cross-organization credential mutation. */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { is, SQL, sql } from "drizzle-orm";
import { getTableConfig, PgDialect } from "drizzle-orm/pg-core";
import { Client } from "pg";

const sourceUrl = process.env.APP_DELETION_TEST_POSTGRES_URL;
const databaseName = `quint_app_deletion_${randomUUID().replaceAll("-", "")}`;
let admin: Client, control: Client, observer: Client;
let databaseUrl: string;
let database: typeof import("../../../db/client");
let bindings: typeof import("../../runtime/cloud-bindings");
let deletion: typeof import("../../../db/repositories/app-deletion-operations");
let execution: typeof import("../../../db/repositories/app-deletion-execution");
let mobile: typeof import("../../../db/repositories/mobile-app-auth-grants");
let provenance: typeof import("../../../db/mobile-app-auth-credential-policy");
let policy: typeof import("../inference-policy-fence");
let organizationId: string,
  otherOrganizationId: string,
  userId: string,
  otherUserId: string,
  appId: string;
let begins: string[], commits: string[], rejectPermits: boolean;
const gate = {
  getByName(org: string) {
    return {
      async fetch(request: Request) {
        const path = new URL(request.url).pathname;
        const body = (await request.json()) as { mutationId: string };
        if (path === "/policy-mutation/begin") {
          if (rejectPermits) return new Response("Controlled unavailable", { status: 503 });
          begins.push(org);
          return Response.json({
            blocked: true,
            mutationId: body.mutationId,
            fenceToken: "local-fixture",
            validUntil: Date.now() + 60_000,
          });
        }
        if (path === "/policy-mutation/commit") {
          const receipt = await observer.query(
            "SELECT phase FROM inference_policy_mutations WHERE organization_id=$1 AND mutation_id=$2",
            [org, body.mutationId],
          );
          expect(receipt.rows[0]?.phase).toBe("applied");
          commits.push(org);
        }
        return Response.json({ committed: true, blocked: true });
      },
    };
  },
};
function run<T>(operation: () => Promise<T>, zone = "UTC", enrolled = true): Promise<T> {
  const url = new URL(databaseUrl);
  url.searchParams.set(
    "options",
    `-c timezone=${zone} -c lock_timeout=8s -c statement_timeout=12s`,
  );
  url.searchParams.set("application_name", `app-deletion-${zone}`);
  return bindings.runWithCloudBindingsAsync(
    {
      DATABASE_URL: url.toString(),
      TEST_DATABASE_URL: url.toString(),
      NODE_ENV: "test",
      ENVIRONMENT: "local",
      MOCK_REDIS: "1",
      ...(enrolled
        ? { INFERENCE_RATE_POLICY_ADMISSION: "true", INFERENCE_ADMISSION_GATES: gate }
        : {}),
    },
    operation,
  );
}
function fixtureDefault(value: unknown, type: string): string {
  if (value === undefined) return "";
  if (is(value, SQL)) {
    const query = new PgDialect().sqlToQuery(value);
    if (query.params.length) throw new Error("Nonliteral fixture default");
    return ` DEFAULT ${query.sql}`;
  }
  if (value === null) return " DEFAULT NULL";
  if (typeof value === "number" || typeof value === "bigint" || typeof value === "boolean")
    return ` DEFAULT ${String(value)}`;
  if (typeof value === "string") return ` DEFAULT '${value.replaceAll("'", "''")}'`;
  if (type === "jsonb" || type === "json")
    return ` DEFAULT '${JSON.stringify(value).replaceAll("'", "''")}'::${type}`;
  throw new Error("Unsupported fixture default");
}
async function waitsFor(blocker: number | number[], zone = "UTC", exclude = 0): Promise<number> {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const found = await observer.query(
      "SELECT pid FROM pg_stat_activity WHERE datname=current_database() AND application_name=$1 AND wait_event_type='Lock' AND pg_blocking_pids(pid) && $2::int[] AND pid<>$3",
      [`app-deletion-${zone}`, Array.isArray(blocker) ? blocker : [blocker], exclude],
    );
    if (found.rows[0]) return found.rows[0].pid;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Expected independently observed PostgreSQL lock wait");
}
async function appBarrier() {
  await control.query("BEGIN");
  await control.query("SELECT id FROM apps WHERE id=$1 FOR UPDATE", [appId]);
  return (await control.query("SELECT pg_backend_pid() AS pid")).rows[0].pid as number;
}
const input = () => ({ appId, organizationId, userId, deleteGitHubRepo: false });
async function seedKey(org = organizationId, user = userId) {
  const id = randomUUID();
  // The insert itself uses the real enrolled mutation and association guards.
  await run(() =>
    policy.withInferencePolicyMutation(
      { organizationIds: [org], userLockIds: [user] },
      async (tx) => {
        await tx.execute(
          sql`INSERT INTO api_keys(id,name,key_hash,key_prefix,organization_id,user_id,source_app_id,is_active) VALUES(${id},'fixture',${id},'eliza_mobile_',${org},${user},${appId},true)`,
        );
      },
    ),
  );
  return id;
}
async function seedMobileExchange() {
  const grantId = randomUUID();
  const binding = {
    codeHash: randomUUID(),
    appId,
    clientId: "isolated-native-client",
    environment: "staging",
    redirectUri: "ai.eliza.test:/callback",
    stateHash: randomUUID(),
    codeChallenge: randomUUID(),
  };
  await control.query(
    "INSERT INTO mobile_app_auth_grants(id,code_hash,app_id,client_id,user_id,organization_id,environment,redirect_uri,state_hash,code_challenge,code_challenge_method,scopes,status,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'S256','[\"inference\"]','pending',clock_timestamp()+interval '1 minute')",
    [
      grantId,
      binding.codeHash,
      appId,
      binding.clientId,
      otherUserId,
      otherOrganizationId,
      binding.environment,
      binding.redirectUri,
      binding.stateHash,
      binding.codeChallenge,
    ],
  );
  const attribution = provenance.buildMobileAppAuthCredentialProvenance({
    grantId,
    environment: binding.environment,
    clientId: binding.clientId,
    scopes: ["inference"],
  });
  const credential = {
    id: randomUUID(),
    ...attribution,
    organization_id: otherOrganizationId,
    user_id: otherUserId,
    source_app_id: appId,
    key_hash: randomUUID(),
    key_prefix: "test-only",
    is_active: false,
    expires_at: new Date(Date.now() + 3_600_000),
    key_ciphertext: "fixture-ciphertext",
    key_nonce: "fixture-nonce",
    key_auth_tag: "fixture-tag",
    key_kms_key_id: "fixture-key",
    key_kms_key_version: 1,
  };
  return { binding, credential };
}

(sourceUrl ? describe : describe.skip)("app deletion PostgreSQL authority", () => {
  beforeAll(async () => {
    const url = new URL(sourceUrl!);
    if (
      !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) ||
      !url.username.startsWith("qa_")
    )
      throw new Error("Requires a loopback qa_* role");
    admin = new Client({ connectionString: sourceUrl });
    await admin.connect();
    await admin.query(`CREATE DATABASE ${databaseName}`);
    url.pathname = `/${databaseName}`;
    databaseUrl = url.toString();
    control = new Client({ connectionString: databaseUrl });
    observer = new Client({ connectionString: databaseUrl });
    await Promise.all([control.connect(), observer.connect()]);
    const tables = await import("../../../db/schemas");
    const enums = new Set<string>();
    for (const table of [
      tables.organizations,
      tables.users,
      tables.userIdentities,
      tables.apiKeys,
      tables.apps,
      tables.mobileAppAuthGrants,
      tables.jobs,
      tables.jobExecutionLeases,
      tables.appFrontendDeployments,
    ]) {
      const config = getTableConfig(table);
      for (const column of config.columns) {
        const enumeration = (
          column as unknown as { enum?: { enumName: string; enumValues: string[] } }
        ).enum;
        if (enumeration && !enums.has(enumeration.enumName)) {
          await control.query(
            `CREATE TYPE "${enumeration.enumName}" AS ENUM (${enumeration.enumValues.map((v) => `'${v}'`).join(",")})`,
          );
          enums.add(enumeration.enumName);
        }
      }
      await control.query(
        `CREATE TABLE "${config.name}" (${config.columns
          .filter((c) => !(config.name === "apps" && c.name === "deletion_job_id"))
          .map(
            (c) =>
              `"${c.name}" ${c.getSQLType()}${c.primary ? " PRIMARY KEY" : ""}${fixtureDefault(c.default, c.getSQLType())}`,
          )
          .join(",")})`,
      );
    }
    for (const table of [
      "organization_subscription_authorities",
      "organization_entitlements",
      "billing_subscriptions",
      "billing_subscription_revisions",
      "subscription_grants",
      "org_rate_limit_overrides",
      "organization_config",
      "organization_payment_reversal_holds",
      "subscription_allowance_periods",
    ])
      await control.query(`CREATE TABLE ${table}(organization_id uuid)`);
    await control.query(
      "CREATE TABLE user_moderation_status(user_id uuid,status text,total_violations integer)",
    );
    for (const name of [
      "0545_inference_policy_mutation_fences.sql",
      "0552_inference_rate_policy_fences.sql",
      "0553_inference_policy_snapshot_fence.sql",
      "0566_app_deletion_authority.sql",
      "0567_job_utc_clock_defaults.sql",
      "0568_app_cleanup_manifest.sql",
    ]) {
      for (const statement of readFileSync(
        new URL(`../../../db/migrations/${name}`, import.meta.url),
        "utf8",
      ).split("--> statement-breakpoint"))
        if (statement.trim()) await control.query(statement);
    }
    await control.query(
      "ALTER TABLE jobs ADD CONSTRAINT cleanup_test_org_fk FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE",
    );
    database = await import("../../../db/client");
    bindings = await import("../../runtime/cloud-bindings");
    deletion = await import("../../../db/repositories/app-deletion-operations");
    execution = await import("../../../db/repositories/app-deletion-execution");
    mobile = await import("../../../db/repositories/mobile-app-auth-grants");
    provenance = await import("../../../db/mobile-app-auth-credential-policy");
    policy = await import("../inference-policy-fence");
  }, 120_000);
  beforeEach(async () => {
    await control.query("ROLLBACK");
    await control.query(
      "TRUNCATE apps,jobs,job_execution_leases,api_keys,mobile_app_auth_grants,users,user_identities,inference_policy_mutations,inference_policy_authorities,organizations CASCADE",
    );
    organizationId = randomUUID();
    otherOrganizationId = randomUUID();
    userId = randomUUID();
    otherUserId = randomUUID();
    appId = randomUUID();
    begins = [];
    commits = [];
    rejectPermits = false;
    for (const [org, user] of [
      [organizationId, userId],
      [otherOrganizationId, otherUserId],
    ]) {
      await control.query("INSERT INTO organizations(id,is_active) VALUES($1,true)", [org]);
      await control.query("INSERT INTO users(id,organization_id,is_active) VALUES($1,$2,true)", [
        user,
        org,
      ]);
      await control.query("INSERT INTO inference_policy_authorities(organization_id) VALUES($1)", [
        org,
      ]);
      await control.query("BEGIN");
      await control.query(
        "INSERT INTO inference_policy_mutations(organization_id,mutation_id,fence_token,permit_expires_at,applying_txid,phase) VALUES($1,'seed','local',clock_timestamp()+interval '1 minute',txid_current(),'applying')",
        [org],
      );
      await control.query(
        "UPDATE inference_policy_authorities SET rate_enabled=true,epoch=1 WHERE organization_id=$1",
        [org],
      );
      await control.query(
        "UPDATE inference_policy_mutations SET phase='complete',epoch=1 WHERE organization_id=$1",
        [org],
      );
      await control.query("COMMIT");
    }
    await control.query(
      "INSERT INTO apps(id,organization_id,created_by_user_id,is_active,is_approved) VALUES($1,$2,$3,true,true)",
      [appId, organizationId, userId],
    );
  });
  afterAll(async () => {
    await database?.closeDatabaseConnectionsForTests();
    await control?.end();
    await observer?.end();
    if (admin) {
      try {
        await admin.query(`DROP DATABASE IF EXISTS ${databaseName} WITH (FORCE)`);
      } finally {
        await admin.end();
      }
    }
  }, 30_000);

  test("a queued cross-organization mobile issuance is included by the stable key-set recheck", async () => {
    await seedKey();
    const incoming = await seedMobileExchange();
    const blocker = await appBarrier();
    const issue = run(() =>
      mobile.mobileAppAuthGrantsRepository.exchange(
        incoming.binding,
        incoming.credential,
        new Date(),
      ),
    );
    void issue.catch(() => {});
    const issuerPid = await waitsFor(blocker);
    const remove = run(() => deletion.appDeletionOperations.admit(input()));
    void remove.catch(() => {});
    const deleterPid = await waitsFor([blocker, issuerPid], "UTC", issuerPid);
    expect(deleterPid).not.toBe(issuerPid);
    await control.query("COMMIT");
    expect((await issue).kind).toBe("created");
    const admitted = await remove;
    expect(admitted?.revokedKeys.map((k) => k.id)).toContain(incoming.credential.id);
    const keys = await observer.query("SELECT is_active,deleted_at FROM api_keys ORDER BY id");
    expect(keys.rows).toHaveLength(2);
    expect(keys.rows.every((k) => k.is_active === false && k.deleted_at !== null)).toBe(true);
    expect((await observer.query("SELECT * FROM jobs")).rowCount).toBe(1);
    expect(begins).toContain(otherOrganizationId);
    expect(
      (
        await run(() =>
          mobile.mobileAppAuthGrantsRepository.exchange(
            incoming.binding,
            incoming.credential,
            new Date(),
          ),
        )
      ).kind,
    ).toBe("invalid");
  }, 30_000);

  test("revocation waiting on a deletion shares policy order and exact replay opens no new permits", async () => {
    const key = await seedKey(otherOrganizationId, otherUserId);
    const blocker = await appBarrier();
    const remove = run(() => deletion.appDeletionOperations.admit(input()));
    void remove.catch(() => {});
    const deletingPid = await waitsFor(blocker);
    const revoke = run(() =>
      policy.withInferencePolicyMutation(
        { organizationIds: [otherOrganizationId], userLockIds: [otherUserId] },
        async (tx) => {
          await tx.execute(sql`UPDATE api_keys SET is_active=false WHERE id=${key}`);
        },
      ),
    );
    void revoke.catch(() => {});
    await waitsFor(deletingPid);
    await control.query("COMMIT");
    const original = await remove;
    await revoke;
    const before = begins.length;
    rejectPermits = true;
    const replay = await run(() =>
      deletion.appDeletionOperations.admit({ ...input(), userId: otherUserId }),
    );
    expect(replay?.job.id).toBe(original?.job.id);
    expect(begins).toHaveLength(before);
    expect(
      (await observer.query("SELECT is_active FROM api_keys WHERE id=$1", [key])).rows[0].is_active,
    ).toBe(false);
  }, 30_000);

  for (const zone of ["UTC", "America/New_York", "Asia/Kathmandu"])
    test(`post-lock lease expiry uses naive UTC authority in ${zone}`, async () => {
      // No enrolled mutation is needed for this isolated lease test.
      await control.query("TRUNCATE inference_policy_authorities CASCADE");
      const admitted = await run(() => deletion.appDeletionOperations.admit(input()), zone, false);
      const defaultId = randomUUID();
      await run(
        () =>
          database.dbWrite.execute(
            sql`INSERT INTO jobs(id,type,organization_id,data) VALUES(${defaultId}, 'fixture_default_only', ${organizationId}, '{}'::jsonb)`,
          ),
        zone,
        false,
      );
      const defaults = await observer.query(
        "SELECT abs(extract(epoch FROM scheduled_for - (clock_timestamp() AT TIME ZONE 'UTC'))) < 2 AND abs(extract(epoch FROM created_at - (clock_timestamp() AT TIME ZONE 'UTC'))) < 2 AND abs(extract(epoch FROM updated_at - (clock_timestamp() AT TIME ZONE 'UTC'))) < 2 AS correct FROM jobs WHERE id=$1",
        [defaultId],
      );
      expect(defaults.rows[0].correct).toBe(true);
      const jobs = await import("../../../db/repositories/jobs");
      const owner = randomUUID();
      const [claimed] = await run(
        () =>
          jobs.jobsRepository.claimPendingJobs({
            type: "app_delete",
            organizationId,
            limit: 1,
            executionOwnerId: owner,
            executionLeaseMs: 1000,
          }),
        zone,
        false,
      );
      expect(claimed?.id).toBe(admitted?.job.id);
      if (!claimed?.execution_generation)
        throw new Error("Canonical app deletion claim is unavailable");
      const authority = {
        jobId: claimed.id,
        organizationId,
        executionGeneration: claimed.execution_generation,
        executionOwnerId: owner,
      };
      expect(
        await run(() => jobs.jobsRepository.renewExecutionLease(claimed, owner, 1000), zone, false),
      ).toBe("renewed");
      const lease = await observer.query(
        "SELECT abs(extract(epoch FROM expires_at - (clock_timestamp() AT TIME ZONE 'UTC'))) < 2 AND abs(extract(epoch FROM created_at - (clock_timestamp() AT TIME ZONE 'UTC'))) < 2 AND abs(extract(epoch FROM heartbeat_at - (clock_timestamp() AT TIME ZONE 'UTC'))) < 2 AS correct FROM job_execution_leases WHERE job_id=$1",
        [authority.jobId],
      );
      expect(lease.rows[0].correct).toBe(true);
      expect(
        await run(
          () =>
            execution.withAppDeletionExecution(
              authority,
              async (tx) =>
                (await tx.execute(sql`SELECT current_setting('TimeZone') AS zone`)).rows[0]?.zone,
            ),
          zone,
          false,
        ),
      ).toBe(zone);
      const blocker = await appBarrier();
      let changed = false;
      const pending = run(
        () =>
          execution.withAppDeletionExecution(authority, async () => {
            changed = true;
          }),
        zone,
        false,
      );
      void pending.catch(() => {});
      await waitsFor(blocker, zone);
      while (
        !(
          await observer.query(
            "SELECT (clock_timestamp() AT TIME ZONE 'UTC') >= expires_at AS expired FROM job_execution_leases WHERE job_id=$1",
            [authority.jobId],
          )
        ).rows[0]?.expired
      )
        await new Promise((resolve) => setTimeout(resolve, 10));
      await control.query("COMMIT");
      await expect(pending).rejects.toMatchObject({ name: "StaleJobExecutionError" });
      expect(changed).toBe(false);
    }, 30_000);
  async function preparedCleanup() {
    await control.query("TRUNCATE inference_policy_authorities CASCADE");
    const admitted = await run(() => deletion.appDeletionOperations.admit(input()), "UTC", false);
    if (!admitted) throw new Error("No original root");
    const owner = randomUUID();
    const repository = (await import("../../../db/repositories/jobs")).jobsRepository;
    const [job] = await run(
      () =>
        repository.claimPendingJobs({
          type: "app_delete",
          organizationId,
          limit: 1,
          executionOwnerId: owner,
          executionLeaseMs: 60000,
        }),
      "UTC",
      false,
    );
    if (!job?.execution_generation) throw new Error("No cleanup lease");
    const plan = (await import("../app-deletion-cleanup-plan")).buildAppDeletionCleanupPlan([
      {
        id: randomUUID(),
        r2_prefix: "original/",
        status: "ready",
        manifest: {
          entrypoint: "a",
          spaFallback: false,
          files: [0, 1].map((n) => ({
            path: String(n),
            hash: String(n).repeat(64),
            contentType: "text/plain",
            size: 1,
          })),
        },
      },
    ]);
    await control.query(
      "UPDATE jobs SET data=data || jsonb_build_object('frontendCleanupPlan',$2::jsonb), result=$3 WHERE id=$1",
      [
        job.id,
        JSON.stringify(plan),
        JSON.stringify({
          appDeleted: true,
          appId,
          deletionJobId: job.id,
          cleanupManifestDigest: plan.digest,
          cleanupObjectCount: 2,
          cleanupCursor: 0,
          cleanupConfirmed: false,
        }),
      ],
    );
    await control.query("DELETE FROM apps WHERE id=$1", [appId]);
    return {
      authority: {
        jobId: job.id,
        organizationId,
        executionGeneration: job.execution_generation,
        executionOwnerId: owner,
      },
      plan,
    };
  }

  test("competing cleanup acknowledgements advance one original cursor and retain the organization", async () => {
    const { authority, plan } = await preparedCleanup();
    const { advanceAppDeletionCleanup } = await import(
      "../../../db/repositories/app-deletion-cleanup"
    );
    await control.query("BEGIN");
    await control.query("SELECT id FROM jobs WHERE id=$1 FOR UPDATE", [authority.jobId]);
    const blocker = (await control.query("SELECT pg_backend_pid() AS pid")).rows[0].pid;
    const first = run(
      () => advanceAppDeletionCleanup(authority, plan.digest, 2, 0, true),
      "UTC",
      false,
    );
    void first.catch(() => {});
    const firstPid = await waitsFor(blocker);
    const second = run(
      () => advanceAppDeletionCleanup(authority, plan.digest, 2, 0, true),
      "UTC",
      false,
    );
    void second.catch(() => {});
    const secondPid = await waitsFor([blocker, firstPid], "UTC", firstPid);
    expect(secondPid).not.toBe(firstPid);
    await control.query("COMMIT");
    const outcomes = await Promise.allSettled([first, second]);
    expect(outcomes.filter((x) => x.status === "fulfilled")).toHaveLength(1);
    expect(outcomes.filter((x) => x.status === "rejected")).toHaveLength(1);
    expect(
      (
        await observer.query("SELECT result->>'cleanupCursor' AS cursor FROM jobs WHERE id=$1", [
          authority.jobId,
        ])
      ).rows[0].cursor,
    ).toBe("1");
    await control.query("DELETE FROM inference_policy_mutations WHERE organization_id=$1", [
      organizationId,
    ]);
    await expect(
      control.query("DELETE FROM organizations WHERE id=$1", [organizationId]),
    ).rejects.toMatchObject({ code: "23514" });
    expect(
      (await observer.query("SELECT id FROM organizations WHERE id=$1", [organizationId])).rowCount,
    ).toBe(1);
    await run(() => advanceAppDeletionCleanup(authority, plan.digest, 2, 1, true), "UTC", false);
    await control.query("DELETE FROM organizations WHERE id=$1", [organizationId]);
    expect(
      (await observer.query("SELECT id FROM jobs WHERE id=$1", [authority.jobId])).rowCount,
    ).toBe(0);
  }, 30000);

  for (const zone of ["UTC", "America/New_York", "Asia/Kathmandu"])
    test(`cleanup acknowledgement rejects a lease that expires during its job lock wait in ${zone}`, async () => {
      const { authority, plan } = await preparedCleanup();
      const { advanceAppDeletionCleanup } = await import(
        "../../../db/repositories/app-deletion-cleanup"
      );
      await control.query("BEGIN");
      await control.query("SELECT id FROM jobs WHERE id=$1 FOR UPDATE", [authority.jobId]);
      const blocker = (await control.query("SELECT pg_backend_pid() AS pid")).rows[0].pid;
      const attempt = run(
        () => advanceAppDeletionCleanup(authority, plan.digest, 2, 0, true),
        zone,
        false,
      );
      void attempt.catch(() => {});
      await waitsFor(blocker, zone);
      await control.query(
        "UPDATE job_execution_leases SET expires_at=(clock_timestamp() AT TIME ZONE 'UTC')-interval '1 second' WHERE job_id=$1",
        [authority.jobId],
      );
      await control.query("COMMIT");
      await expect(attempt).rejects.toMatchObject({ name: "StaleJobExecutionError" });
      expect(
        (
          await observer.query("SELECT result->>'cleanupCursor' AS cursor FROM jobs WHERE id=$1", [
            authority.jobId,
          ])
        ).rows[0].cursor,
      ).toBe("0");
    }, 30000);

  test("a paused PostgreSQL uploader retains its full plan until deletion admission stops and quiesces it", async () => {
    await control.query("TRUNCATE inference_policy_authorities CASCADE");
    const { setRuntimeR2Bucket } = await import("../../storage/r2-runtime-binding");
    const { appFrontendHostingService } = await import("../app-frontend-hosting");
    const { buildAppDeletionCleanupPlan } = await import("../app-deletion-cleanup-plan");
    const { appFrontendDeployments } = await import("../../../db/schemas/app-frontend-deployments");
    let arrived!: () => void,
      release!: () => void,
      puts = 0;
    const seen = new Promise<void>((resolve) => {
      arrived = resolve;
    });
    const resume = new Promise<void>((resolve) => {
      release = resolve;
    });
    setRuntimeR2Bucket({
      get: async () => null,
      delete: async () => {},
      put: async () => {
        puts++;
        arrived();
        await resume;
        return {};
      },
    });
    const upload = run(
      () =>
        appFrontendHostingService.deployBundle({
          app: { id: appId, organization_id: organizationId },
          files: [
            { path: "index.html", content: "original" },
            { path: "second.txt", content: "second" },
          ],
        }),
      "UTC",
      false,
    );
    void upload.catch(() => {});
    try {
      await seen;
      const [inFlight] = await run(
        () => database.dbWrite.select().from(appFrontendDeployments),
        "UTC",
        false,
      );
      expect(inFlight?.upload_plan?.files).toHaveLength(2);
      expect(inFlight?.upload_quiesced_at).toBeNull();
      const root = await run(() => deletion.appDeletionOperations.admit(input()), "UTC", false);
      expect(root?.job.id).toBeDefined();
      expect(() => buildAppDeletionCleanupPlan([inFlight!])).toThrow(
        "Frontend upload completion is unconfirmed",
      );
      release();
      await expect(upload).rejects.toMatchObject({ code: "FRONTEND_UPLOAD_AUTHORITY_LOST" });
      const [quiescent] = await run(
        () => database.dbWrite.select().from(appFrontendDeployments),
        "UTC",
        false,
      );
      expect(quiescent?.upload_quiesced_at).toBeInstanceOf(Date);
      expect(quiescent?.status).toBe("failed");
      expect(buildAppDeletionCleanupPlan([quiescent!]).objectCount).toBe(2);
      expect(puts).toBe(1);
    } finally {
      release();
      await upload.catch(() => {});
      setRuntimeR2Bucket(null);
    }
  }, 30000);
});
