/** Real PostgreSQL row contention across publication, retirement, activation and deletion. */
import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { randomInt, randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { generateDrizzleJson, generateMigration } from "drizzle-kit/api";
import { Client } from "pg";
import { testOutputPath } from "../../../../../../scripts/lib/test-output.ts";
import type {
  AppFrontendDeployment,
  FrontendManifest,
} from "../../../db/schemas/app-frontend-deployments";
import { appFrontendDeployments } from "../../../db/schemas/app-frontend-deployments";
import { runWithCloudBindingsAsync } from "../../runtime/cloud-bindings";

const sourceUrl =
  process.env.FRONTEND_PUBLICATION_TEST_POSTGRES_URL ??
  process.env.INFERENCE_POLICY_TEST_POSTGRES_URL;
const databaseName = `qa_frontend_${randomUUID().replaceAll("-", "")}`;
let admin: Client | undefined;
let databaseUrl: string;
let repository: typeof import("../../../db/repositories/app-frontend-deployments").appFrontendDeploymentsRepository;
let hosting: typeof import("../app-frontend-hosting").appFrontendHostingService;
let closeDatabases: typeof import("../../../db/client").closeDatabaseConnectionsForTests;
let setBucket: typeof import("../../storage/r2-runtime-binding").setRuntimeR2Bucket;
const manifest: FrontendManifest = {
  entrypoint: "index.html",
  spaFallback: false,
  files: [{ path: "index.html", hash: "a".repeat(64), contentType: "text/html", size: 4 }],
};
const organizationId = randomUUID();
const finalizeInput = {
  r2Prefix: "fixture/",
  manifest,
  contentHash: "b".repeat(64),
  fileCount: 1,
  totalBytes: 4,
};
const observations: Array<{
  transition: string;
  winner: number;
  contender: number;
  barrier: number;
}> = [];

async function makeScope() {
  const schema = `frontend_${randomUUID().replaceAll("-", "")}`;
  const appName = schema;
  const scoped = new URL(databaseUrl);
  scoped.searchParams.set(
    "options",
    `-c search_path=${schema},pg_catalog,public -c timezone=UTC -c lock_timeout=8s -c statement_timeout=12s`,
  );
  const connectionString = scoped.toString();
  const control = new Client({ connectionString, application_name: `${appName}_control` });
  const observer = new Client({ connectionString, application_name: `${appName}_observer` });
  await control.connect();
  await observer.connect();
  await control.query(`CREATE SCHEMA ${schema}; SET search_path TO ${schema},pg_catalog,public`);
  await control.query(
    "CREATE TABLE apps(id uuid PRIMARY KEY, organization_id uuid NOT NULL, deletion_job_id uuid)",
  );
  for (const statement of await generateMigration(
    generateDrizzleJson({}),
    generateDrizzleJson({ appFrontendDeployments }),
  )) {
    if (statement.startsWith("ALTER TABLE") && statement.includes("FOREIGN KEY")) continue;
    await control.query(statement);
  }
  await control.query(`CREATE TABLE frontend_test_barriers(deployment_id uuid PRIMARY KEY, transition text NOT NULL, lock_key bigint NOT NULL);
    CREATE FUNCTION pause_frontend_transition() RETURNS trigger LANGUAGE plpgsql AS $$
    DECLARE desired text; gate bigint;
    BEGIN
      desired := CASE WHEN TG_OP='DELETE' THEN 'delete' ELSE NEW.status END;
      SELECT lock_key INTO gate FROM frontend_test_barriers WHERE deployment_id=OLD.id AND transition=desired;
      IF FOUND THEN PERFORM pg_advisory_xact_lock(gate); END IF;
      IF TG_OP='DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
    END $$;
    CREATE TRIGGER frontend_transition_gate BEFORE UPDATE OR DELETE ON app_frontend_deployments
      FOR EACH ROW EXECUTE FUNCTION pause_frontend_transition();`);
  const run = <T>(fn: () => Promise<T>) =>
    runWithCloudBindingsAsync(
      {
        DATABASE_URL: connectionString,
        TEST_DATABASE_URL: connectionString,
        NODE_ENV: "test",
        ENVIRONMENT: "local",
        MOCK_REDIS: "1",
        LOCAL_PG_POOL_MAX: "4",
        RAILWAY_SERVICE_NAME: appName,
      },
      fn,
    );
  return { schema, appName, control, observer, run };
}
type Scope = Awaited<ReturnType<typeof makeScope>>;

async function inScope<T>(fn: (scope: Scope) => Promise<T>) {
  const scope = await makeScope();
  try {
    return await fn(scope);
  } finally {
    await scope.control.query("SELECT pg_advisory_unlock_all()");
    await scope.control.query(`DROP SCHEMA ${scope.schema} CASCADE`);
    await Promise.all([scope.control.end(), scope.observer.end()]);
  }
}

async function waitingOn(scope: Scope, blocker: number): Promise<number> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const result = await scope.observer.query<{ pid: number }>(
      `SELECT pid FROM pg_stat_activity WHERE datname=current_database()
       AND application_name=$1 AND wait_event_type='Lock' AND $2=ANY(pg_blocking_pids(pid))`,
      [scope.appName, blocker],
    );
    if (result.rows[0]) return result.rows[0].pid;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Expected an observed PostgreSQL session waiting on the controlled blocker");
}

async function contend<T, U>(
  scope: Scope,
  id: string,
  transition: string,
  winner: () => Promise<T>,
  contender: () => Promise<U>,
): Promise<[T, U]> {
  const key = randomInt(1, 1_000_000_000);
  await scope.control.query("INSERT INTO frontend_test_barriers VALUES($1,$2,$3)", [
    id,
    transition,
    key,
  ]);
  await scope.control.query("SELECT pg_advisory_lock($1)", [key]);
  const controlResult = await scope.control.query<{ pid: number }>(
    "SELECT pg_backend_pid() AS pid",
  );
  const barrierPid = controlResult.rows[0]?.pid;
  if (!barrierPid) throw new Error("Missing control session identity");
  const pending: Array<Promise<unknown>> = [];
  try {
    const first = scope.run(winner);
    pending.push(first);
    // Observe and handle a rejection even if a later barrier assertion fails.
    void first.catch(() => undefined);
    const winnerPid = await waitingOn(scope, barrierPid);
    const second = scope.run(contender);
    pending.push(second);
    void second.catch(() => undefined);
    const contenderPid = await waitingOn(scope, winnerPid);
    expect(contenderPid).not.toBe(winnerPid);
    observations.push({
      transition,
      winner: winnerPid,
      contender: contenderPid,
      barrier: barrierPid,
    });
    await scope.control.query("SELECT pg_advisory_unlock($1)", [key]);
    return await Promise.all([first, second]);
  } finally {
    await scope.control.query("SELECT pg_advisory_unlock($1)", [key]);
    await Promise.allSettled(pending);
    await scope.control.query("DELETE FROM frontend_test_barriers WHERE deployment_id=$1", [id]);
  }
}

async function uploading(scope: Scope, appId: string) {
  await scope.control.query(
    "INSERT INTO apps(id,organization_id) VALUES($1,$2) ON CONFLICT DO NOTHING",
    [appId, organizationId],
  );
  const row = await scope.run(() =>
    repository.create({ appId, organizationId, r2Prefix: "fixture/" }),
  );
  const result = await scope.run(() =>
    repository.beginUpload({ id: appId, organization_id: organizationId }, row.id),
  );
  if (!result) throw new Error("Fixture upload did not start");
  return result;
}
async function ready(scope: Scope, appId: string) {
  const row = await uploading(scope, appId);
  const result = await scope.run(() => repository.finalize(row.id, finalizeInput));
  if (!result) throw new Error("Fixture did not finalize");
  return result;
}
async function rowStatus(scope: Scope, id: string) {
  const result = await scope.control.query<{ status: string }>(
    "SELECT status FROM app_frontend_deployments WHERE id=$1",
    [id],
  );
  return result.rows[0]?.status;
}

(sourceUrl ? describe : describe.skip)("PostgreSQL frontend publication contention", () => {
  beforeAll(async () => {
    if (!sourceUrl) throw new Error("Missing isolated PostgreSQL URL");
    const parsed = new URL(sourceUrl);
    if (
      !["127.0.0.1", "localhost", "[::1]"].includes(parsed.hostname) ||
      !decodeURIComponent(parsed.username).startsWith("qa_")
    ) {
      throw new Error("Frontend PostgreSQL tests require a loopback qa_* role");
    }
    admin = new Client({ connectionString: sourceUrl });
    await admin.connect();
    await admin.query(`CREATE DATABASE ${databaseName}`);
    parsed.pathname = `/${databaseName}`;
    databaseUrl = parsed.toString();
    ({ closeDatabaseConnectionsForTests: closeDatabases } = await import("../../../db/client"));
    ({ appFrontendDeploymentsRepository: repository } = await import(
      "../../../db/repositories/app-frontend-deployments"
    ));
    ({ appFrontendHostingService: hosting } = await import("../app-frontend-hosting"));
    ({ setRuntimeR2Bucket: setBucket } = await import("../../storage/r2-runtime-binding"));
  }, 120_000);
  afterAll(async () => {
    setBucket?.(null);
    await closeDatabases?.();
    if (admin) {
      try {
        await admin.query(`DROP DATABASE IF EXISTS ${databaseName} WITH (FORCE)`);
      } finally {
        await admin.end();
      }
    }
  });

  test(
    "ownership changed while creation waits cannot allocate a deployment",
    async () =>
      inScope(async (scope) => {
        const appId = randomUUID();
        await scope.control.query("INSERT INTO apps(id,organization_id) VALUES($1,$2)", [
          appId,
          organizationId,
        ]);
        const {
          rows: [owner],
        } = await scope.control.query<{ pid: number }>("SELECT pg_backend_pid() AS pid");
        if (!owner) throw new Error("Missing controlled owner connection");
        let attempt: Promise<AppFrontendDeployment> | undefined;
        try {
          await scope.control.query("BEGIN");
          await scope.control.query("UPDATE apps SET organization_id=$2 WHERE id=$1", [
            appId,
            randomUUID(),
          ]);
          attempt = scope.run(() =>
            repository.create({ appId, organizationId, r2Prefix: "original-owner/" }),
          );
          void attempt.catch(() => undefined);
          expect(await waitingOn(scope, owner.pid)).not.toBe(owner.pid);
          await scope.control.query("COMMIT");
          await expect(attempt).rejects.toMatchObject({ code: "FRONTEND_APP_OWNER_UNAVAILABLE" });
          const {
            rows: [count],
          } = await scope.control.query<{ count: string }>(
            "SELECT count(*)::text AS count FROM app_frontend_deployments WHERE app_id=$1",
            [appId],
          );
          expect(count?.count).toBe("0");
        } finally {
          await scope.control.query("ROLLBACK");
          await attempt?.catch(() => undefined);
        }
      }),
    30_000,
  );

  test(
    "acknowledged publication wins a waiting retirement and keeps its manifest",
    async () =>
      inScope(async (scope) => {
        const row = await uploading(scope, randomUUID());
        const [published, retired] = await contend(
          scope,
          row.id,
          "ready",
          () => repository.finalize(row.id, finalizeInput),
          () => repository.markFailed(row.id, "late upload failure"),
        );
        expect(published?.status).toBe("ready");
        expect(retired).toBeUndefined();
        expect(await rowStatus(scope, row.id)).toBe("ready");
        expect((await scope.run(() => repository.getById(row.id)))?.manifest).toEqual(manifest);
      }),
    30_000,
  );

  test(
    "acknowledged retirement wins a waiting publication and cannot be revived",
    async () =>
      inScope(async (scope) => {
        const row = await uploading(scope, randomUUID());
        const [retired, published] = await contend(
          scope,
          row.id,
          "failed",
          () => repository.markFailed(row.id, "upload rejected"),
          () => repository.finalize(row.id, finalizeInput),
        );
        expect(retired?.status).toBe("failed");
        expect(published).toBeUndefined();
        expect(await rowStatus(scope, row.id)).toBe("failed");
        expect((await scope.run(() => repository.getById(row.id)))?.manifest).toBeNull();
      }),
    30_000,
  );

  test(
    "activation wins a waiting deletion without losing the active deployment",
    async () =>
      inScope(async (scope) => {
        const appId = randomUUID();
        const app = { id: appId, organization_id: organizationId };
        const old = await ready(scope, appId);
        await scope.run(() => repository.activate(app, old.id));
        const target = await ready(scope, appId);
        const [activated, deleted] = await contend(
          scope,
          target.id,
          "active",
          () => repository.activate(app, target.id),
          () => repository.deleteInactive(appId, target.id),
        );
        expect(activated?.status).toBe("active");
        expect(deleted).toBeUndefined();
        expect(await rowStatus(scope, target.id)).toBe("active");
        expect(await rowStatus(scope, old.id)).toBe("superseded");
        expect((await scope.run(() => repository.getActive(appId)))?.id).toBe(target.id);
      }),
    30_000,
  );

  test(
    "deletion wins a waiting activation and rolls back the old active demotion",
    async () =>
      inScope(async (scope) => {
        const appId = randomUUID();
        const app = { id: appId, organization_id: organizationId };
        const old = await ready(scope, appId);
        await scope.run(() => repository.activate(app, old.id));
        const target = await ready(scope, appId);
        const [deleted, activated] = await contend(
          scope,
          target.id,
          "delete",
          () => repository.deleteInactive(appId, target.id),
          () => repository.activate(app, target.id),
        );
        expect(deleted?.id).toBe(target.id);
        expect(activated).toBeUndefined();
        expect(await rowStatus(scope, target.id)).toBeUndefined();
        expect(await rowStatus(scope, old.id)).toBe("active");
        expect((await scope.run(() => repository.getActive(appId)))?.id).toBe(old.id);
      }),
    30_000,
  );

  test(
    "a lost finalization acknowledgement cannot delete PostgreSQL-published active objects",
    async () =>
      inScope(async (scope) => {
        const app = { id: randomUUID(), organization_id: randomUUID() };
        await scope.control.query("INSERT INTO apps(id,organization_id) VALUES($1,$2)", [
          app.id,
          app.organization_id,
        ]);
        const files = [
          { path: "index.html", content: "<html>complete site</html>" },
          { path: "asset.txt", content: "complete asset" },
        ];
        const objects = new Map<string, Uint8Array>();
        const removed: string[] = [];
        setBucket({
          put: async (key, body) => {
            objects.set(key, new Uint8Array(await new Response(body as BodyInit).arrayBuffer()));
            return {};
          },
          get: async (key) => {
            const bytes = objects.get(key);
            return bytes
              ? {
                  text: async () => new TextDecoder().decode(bytes),
                  arrayBuffer: async () => Uint8Array.from(bytes).buffer,
                }
              : null;
          },
          delete: async (key) => {
            removed.push(key);
            objects.delete(key);
          },
        });
        const original = repository.finalize.bind(repository);
        const spy = spyOn(repository, "finalize").mockImplementation(async (...args) => {
          const result = await original(...args);
          if (!result) throw new Error("Fixture did not publish");
          await repository.activate(app, result.id);
          throw new Error("controlled lost PostgreSQL publication acknowledgement");
        });
        try {
          await expect(scope.run(() => hosting.deployBundle({ app, files }))).rejects.toThrow(
            "controlled lost PostgreSQL publication acknowledgement",
          );
        } finally {
          spy.mockRestore();
        }
        const active: AppFrontendDeployment | undefined = await scope.run(() =>
          repository.getActive(app.id),
        );
        expect(active?.status).toBe("active");
        expect(active?.manifest?.files).toHaveLength(2);
        expect(removed).toEqual([]);
        for (const file of active?.manifest?.files ?? []) {
          expect(new TextDecoder().decode(objects.get(`${active?.r2_prefix}${file.hash}`))).toBe(
            files.find((source) => source.path === file.path)?.content,
          );
        }
        setBucket(null);
      }),
    30_000,
  );

  afterAll(async () => {
    const directory = testOutputPath("frontend-publication-postgres");
    await mkdir(directory, { recursive: true });
    await writeFile(
      path.join(directory, "contention.json"),
      `${JSON.stringify({ databaseName, observedWaits: observations }, null, 2)}\n`,
    );
    expect(observations).toHaveLength(4);
  });
});
