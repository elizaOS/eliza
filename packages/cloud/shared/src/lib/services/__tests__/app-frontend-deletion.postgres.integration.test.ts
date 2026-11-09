/** The real app snapshot/deletion must not deadlock a rollback activation. */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { randomInt, randomUUID } from "node:crypto";
import { generateDrizzleJson, generateMigration } from "drizzle-kit/api";
import { Client } from "pg";
import { apiKeys } from "../../../db/schemas/api-keys";
import { appFrontendDeployments } from "../../../db/schemas/app-frontend-deployments";
import * as appSchema from "../../../db/schemas/apps";
import { mobileAppAuthGrants } from "../../../db/schemas/mobile-app-auth-grants";
import { runWithCloudBindingsAsync } from "../../runtime/cloud-bindings";

const sourceUrl =
  process.env.APP_FRONTEND_DELETION_TEST_POSTGRES_URL ??
  process.env.INFERENCE_POLICY_TEST_POSTGRES_URL;
let admin: Client;
let control: Client;
let observer: Client;
let scopedUrl: string;
let closeDatabases: typeof import("../../../db/client").closeDatabaseConnectionsForTests;
const dbName = `qa_frontend_delete_${randomUUID().replaceAll("-", "")}`;
const appName = dbName;
const run = <T>(fn: () => Promise<T>) =>
  runWithCloudBindingsAsync(
    {
      DATABASE_URL: scopedUrl,
      TEST_DATABASE_URL: scopedUrl,
      NODE_ENV: "test",
      ENVIRONMENT: "local",
      MOCK_REDIS: "1",
      LOCAL_PG_POOL_MAX: "4",
      RAILWAY_SERVICE_NAME: appName,
    },
    fn,
  );

beforeAll(async () => {
  if (!sourceUrl)
    throw new Error("App deletion conformance requires a loopback qa_* PostgreSQL URL");
  const url = new URL(sourceUrl);
  if (
    !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) ||
    !decodeURIComponent(url.username).startsWith("qa_")
  )
    throw new Error("Refusing non-QA PostgreSQL");
  admin = new Client({ connectionString: sourceUrl });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${dbName}`);
  url.pathname = `/${dbName}`;
  // Force the unordered baseline to visit older physical rows first; the
  // repaired query's explicit active-first order is independent of that plan.
  url.searchParams.set(
    "options",
    "-c enable_indexscan=off -c enable_bitmapscan=off -c lock_timeout=8s -c statement_timeout=12s",
  );
  scopedUrl = url.toString();
  control = new Client({ connectionString: scopedUrl });
  observer = new Client({ connectionString: scopedUrl });
  await control.connect();
  await observer.connect();
  for (const statement of await generateMigration(
    generateDrizzleJson({}),
    generateDrizzleJson({ ...appSchema, apiKeys, mobileAppAuthGrants, appFrontendDeployments }),
  )) {
    if (statement.startsWith("ALTER TABLE") && statement.includes("FOREIGN KEY")) continue;
    await control.query(statement);
  }
  await control.query(
    "ALTER TABLE app_frontend_deployments ADD CONSTRAINT frontend_test_app_fk FOREIGN KEY (app_id) REFERENCES apps(id) ON DELETE CASCADE",
  );
  ({ closeDatabaseConnectionsForTests: closeDatabases } = await import("../../../db/client"));
}, 120_000);
afterAll(async () => {
  await closeDatabases?.();
  await control?.end();
  await observer?.end();
  if (admin) {
    try {
      await admin.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    } finally {
      await admin.end();
    }
  }
});

async function waitOn(blocker: number) {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const result = await observer.query<{ pid: number }>(
      "SELECT pid FROM pg_stat_activity WHERE datname=current_database() AND application_name=$1 AND $2=ANY(pg_blocking_pids(pid))",
      [appName, blocker],
    );
    if (result.rows[0]) return result.rows[0].pid;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Expected a real independent PostgreSQL row-lock wait");
}

async function exerciseParentLock(queueThird: boolean) {
  const { appsRepository } = await import("../../../db/repositories/apps");
  const { appFrontendDeploymentsRepository: frontends } = await import(
    "../../../db/repositories/app-frontend-deployments"
  );
  const app = randomUUID();
  const organizationId = randomUUID();
  const ownerApp = { id: app, organization_id: organizationId };
  const old = randomUUID();
  const current = randomUUID();
  const gate = randomInt(1, 1_000_000_000);
  await control.query(
    "INSERT INTO apps(id,organization_id,name,slug,app_url,is_active) VALUES($1,$2,'Lock fixture',$3,'https://example.test',false)",
    [app, organizationId, app],
  );
  await control.query(
    "INSERT INTO app_frontend_deployments(id,app_id,version,status,r2_prefix) VALUES($1,$3,1,'ready','old/'),($2,$3,2,'active','current/')",
    [old, current, app],
  );
  await control.query(`DROP TRIGGER IF EXISTS pause_activation ON app_frontend_deployments;
    CREATE OR REPLACE FUNCTION pause_activation() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF OLD.id='${current}' AND NEW.status='superseded' THEN PERFORM pg_advisory_xact_lock(${gate}); END IF; RETURN NEW; END $$;
    CREATE TRIGGER pause_activation BEFORE UPDATE ON app_frontend_deployments FOR EACH ROW EXECUTE FUNCTION pause_activation();`);
  await control.query("SELECT pg_advisory_lock($1)", [gate]);
  const blocker = (await control.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0]!
    .pid;
  const pending: Promise<unknown>[] = [];
  try {
    const activation = run(() => frontends.activate(ownerApp, old));
    pending.push(activation);
    void activation.catch(() => undefined);
    const activationPid = await waitOn(blocker);
    const deletion = run(() => appsRepository.finalizeDelete(app));
    pending.push(deletion);
    void deletion.catch(() => undefined);
    const deletionPid = await waitOn(activationPid);
    expect(deletionPid).not.toBe(activationPid);
    let third: ReturnType<typeof frontends.activate> | undefined;
    if (queueThird) {
      third = run(() => frontends.activate(ownerApp, current));
      pending.push(third);
      void third.catch(() => undefined);
      expect(await waitOn(deletionPid)).not.toBe(deletionPid);
    }
    await control.query("SELECT pg_advisory_unlock($1)", [gate]);
    const [activated, deleted] = await Promise.all([activation, deletion]);
    expect(activated?.id).toBe(old);
    expect(deleted?.frontendDeployments.map((row) => row.id).sort()).toEqual([old, current].sort());
    expect((await control.query("SELECT id FROM apps WHERE id=$1", [app])).rows).toHaveLength(0);
    expect(
      (await control.query("SELECT id FROM app_frontend_deployments WHERE app_id=$1", [app])).rows,
    ).toHaveLength(0);
    if (third) expect(await third).toBeUndefined();
  } finally {
    await control.query("SELECT pg_advisory_unlock($1)", [gate]);
    await Promise.allSettled(pending);
  }
}

test(
  "app deletion and rollback activation share the parent app lock",
  () => exerciseParentLock(false),
  30_000,
);
test(
  "a queued third activation cannot bypass the pending app deletion parent lock",
  () => exerciseParentLock(true),
  30_000,
);
