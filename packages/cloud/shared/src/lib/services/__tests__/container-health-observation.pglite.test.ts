/** Real PGlite/production lifecycle writes; only node health response timing is controlled. */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";

process.env.DATABASE_URL = "pglite://memory";
process.env.TEST_DATABASE_URL = "pglite://memory";
process.env.NODE_ENV ||= "test";
const ORG = "00000000-0000-4000-8000-000000000001";
const ID = "00000000-0000-4000-8000-000000000002";
const metadata = {
  provider: "hetzner-docker",
  nodeId: "node-a",
  hostname: "127.0.0.1",
  containerName: "health-test",
  hostPort: 3000,
  image: "test:v1",
  containerPort: 3000,
};
let db: typeof import("../../../db/client").dbWrite;
let closeDb: typeof import("../../../db/client").closeDatabaseConnectionsForTests;
let repo: typeof import("../../../db/repositories/containers").containersRepository;
let retire: typeof import("../container-retirement").retireContainerWithDeleteJob;
let Client: typeof import("../containers/hetzner-client/client").HetznerContainersClient;

beforeAll(async () => {
  ({ dbWrite: db, closeDatabaseConnectionsForTests: closeDb } = await import("../../../db/client"));
  ({ containersRepository: repo } = await import("../../../db/repositories/containers"));
  ({ retireContainerWithDeleteJob: retire } = await import("../container-retirement"));
  ({ HetznerContainersClient: Client } = await import("../containers/hetzner-client/client"));
  await db.execute(CONTAINER_DDL);
  await db.execute(JOBS_DDL);
  const migration = await readFile(
    new URL("../../../db/migrations/0265_compute_billing_recovery.sql", import.meta.url),
    "utf8",
  );
  const start = migration.indexOf(
    "CREATE OR REPLACE FUNCTION advance_container_lifecycle_revision()",
  );
  const end = migration.indexOf("CREATE TABLE container_compute_stop_intents", start);
  if (start < 0 || end < 0) throw new Error("Canonical container lifecycle trigger is missing");
  const { getPgliteClientForTests } = await import("../../../db/client");
  await getPgliteClientForTests().exec(migration.slice(start, end));
  await getPgliteClientForTests().exec(
    await readFile(
      new URL("../../../db/migrations/0558_container_placement_revision.sql", import.meta.url),
      "utf8",
    ),
  );
}, 60_000);
afterAll(async () => {
  if (closeDb) await closeDb();
});
beforeEach(async () => {
  await db.execute("DELETE FROM jobs");
  await db.execute("DELETE FROM containers");
  await db.execute(
    `INSERT INTO containers (id,name,project_name,organization_id,user_id,status,image_tag,metadata) VALUES ('${ID}','health-test','health-test','${ORG}','${ORG}','deploying','test:v1','${JSON.stringify(metadata)}')`,
  );
});

async function current() {
  const result = await db.execute(
    `SELECT status, lifecycle_revision, last_health_check, error_message, metadata FROM containers WHERE id='${ID}'`,
  );
  return result.rows[0];
}
async function observe(
  response: string | Error,
  whilePending: () => Promise<void> = async () => {},
) {
  const started = Promise.withResolvers<void>();
  const reply = Promise.withResolvers<string>();
  const client = new Client();
  Object.defineProperty(client, "execOnNode", {
    value: async () => {
      started.resolve();
      return await reply.promise;
    },
  });
  const pending = client.monitorInflight();
  await started.promise;
  try {
    await whilePending();
  } finally {
    if (response instanceof Error) reply.reject(response);
    else reply.resolve(response);
  }
  return await pending;
}

describe("container deployment health observation", () => {
  test("records a current healthy observation", async () => {
    expect(await observe("healthy")).toEqual({ checked: 1, running: 1, failed: 0 });
    const row = await current();
    expect(row?.status).toBe("running");
    expect(row?.last_health_check).toBeTruthy();
  });
  test("records a current stopped-runtime observation", async () => {
    expect(await observe("exited")).toEqual({ checked: 1, running: 0, failed: 1 });
    expect((await current())?.status).toBe("failed");
  });
  test("a starting runtime leaves the current deployment pending", async () => {
    expect(await observe("starting")).toEqual({ checked: 1, running: 0, failed: 0 });
    expect((await current())?.status).toBe("deploying");
    expect((await current())?.last_health_check).toBeNull();
  });
  test("a failed health request leaves the current deployment pending", async () => {
    expect(await observe(new Error("controlled health transport failure"))).toEqual({
      checked: 1,
      running: 0,
      failed: 0,
    });
    expect((await current())?.status).toBe("deploying");
    expect((await current())?.last_health_check).toBeNull();
  });
  test("a pending retirement cannot be undone by an older healthy probe", async () => {
    const result = await observe("healthy", async () => {
      expect((await retire(ID, ORG)).outcome).toBe("retired");
    });
    expect(result).toEqual({ checked: 1, running: 0, failed: 0 });
    const row = await current();
    expect(row?.status).toBe("deleting");
    expect(row?.last_health_check).toBeNull();
  });
  test("completed deletion cannot be resurrected by an older healthy probe", async () => {
    const result = await observe("healthy", async () => {
      await retire(ID, ORG);
      await repo.updateStatus(ID, "deleted");
    });
    expect(result).toEqual({ checked: 1, running: 0, failed: 0 });
    expect((await current())?.status).toBe("deleted");
  });
  test("an older failed probe cannot overwrite a newer deploying generation", async () => {
    const result = await observe("exited", async () => {
      await repo.update(ID, ORG, {
        image_tag: "test:v2",
        metadata: { ...metadata, image: "test:v2" },
      });
    });
    expect(result).toEqual({ checked: 1, running: 0, failed: 0 });
    const row = await current();
    expect(row?.status).toBe("deploying");
    expect(Number(row?.lifecycle_revision)).toBe(1);
    expect(row?.error_message).toBeNull();
    expect(await observe("healthy")).toEqual({ checked: 1, running: 1, failed: 0 });
  });
  test("metadata-only placement changes advance the canonical revision", async () => {
    const result = await observe("healthy", async () => {
      await repo.update(ID, ORG, {
        metadata: { ...metadata, hostname: "127.0.0.2", containerName: "replacement" },
      });
    });
    expect(result).toEqual({ checked: 1, running: 0, failed: 0 });
    const row = await current();
    expect(row?.status).toBe("deploying");
    expect(Number(row?.lifecycle_revision)).toBe(1);
  });
  test("status ABA cannot validate an older observation", async () => {
    const result = await observe("healthy", async () => {
      await repo.updateStatus(ID, "failed");
      await repo.updateStatus(ID, "deploying");
    });
    expect(result).toEqual({ checked: 1, running: 0, failed: 0 });
    expect((await current())?.status).toBe("deploying");
  });
  test("a recreated row with the same millisecond cannot accept the original row probe", async () => {
    await db.execute(
      `UPDATE containers SET created_at = timestamp '2026-11-07 00:00:00.123001' WHERE id='${ID}'`,
    );
    const result = await observe("healthy", async () => {
      await db.execute(`DELETE FROM containers WHERE id='${ID}'`);
      await db.execute(`INSERT INTO containers (id,name,project_name,organization_id,user_id,status,image_tag,metadata,created_at)
        VALUES ('${ID}','health-test','health-test','${ORG}','${ORG}','deploying','test:v1','${JSON.stringify(metadata)}',timestamp '2026-11-07 00:00:00.123999')`);
    });
    expect(result).toEqual({ checked: 1, running: 0, failed: 0 });
    expect((await current())?.status).toBe("deploying");
  });
  test("placement metadata ABA cannot validate an older observation", async () => {
    const result = await observe("healthy", async () => {
      await repo.update(ID, ORG, { metadata: { ...metadata, hostname: "127.0.0.2" } });
      await repo.update(ID, ORG, { metadata });
    });
    expect(result).toEqual({ checked: 1, running: 0, failed: 0 });
    expect((await current())?.status).toBe("deploying");
  });

  test("bookkeeping metadata keeps its revision but still invalidates a sampled snapshot", async () => {
    const result = await observe("healthy", async () => {
      await repo.update(ID, ORG, { metadata: { ...metadata, slotReleasedAt: "2026-11-07" } });
    });
    expect(result).toEqual({ checked: 1, running: 0, failed: 0 });
    expect(Number((await current())?.lifecycle_revision)).toBe(0);
  });
});

const CONTAINER_DDL = `CREATE TABLE containers (
        id uuid PRIMARY KEY,
        name text NOT NULL,
        project_name text NOT NULL,
        description text,
        organization_id uuid NOT NULL,
        user_id uuid NOT NULL,
        api_key_id uuid,
        character_id uuid,
        load_balancer_url text,
        public_hostname text,
        status text NOT NULL DEFAULT 'pending',
        image_tag text,
        environment_vars jsonb NOT NULL DEFAULT '{}',
        desired_count integer NOT NULL DEFAULT 1,
        cpu integer NOT NULL DEFAULT 1792,
        memory integer NOT NULL DEFAULT 1792,
        port integer NOT NULL DEFAULT 3000,
        health_check_path text DEFAULT '/health',
        node_id text,
        volume_path text,
        volume_size_gb integer,
        hcloud_volume_id integer,
        volume_location text,
        last_deployed_at timestamp,
        last_health_check timestamp,
        deployment_log text,
        deployment_log_storage text NOT NULL DEFAULT 'inline',
        deployment_log_key text,
        error_message text,
        metadata jsonb NOT NULL DEFAULT '{}',
        last_billed_at timestamp,
        next_billing_at timestamp,
        billing_status text NOT NULL DEFAULT 'active',
        shutdown_warning_sent_at timestamp,
        scheduled_shutdown_at timestamp,
        total_billed numeric(10,2) NOT NULL DEFAULT 0,
        lifecycle_revision integer NOT NULL DEFAULT 0,
        created_at timestamp NOT NULL DEFAULT now(),
        updated_at timestamp NOT NULL DEFAULT now()
      )`;

const JOBS_DDL = `CREATE TABLE IF NOT EXISTS jobs (
        id uuid PRIMARY KEY,
        type text NOT NULL,
        status text NOT NULL DEFAULT 'pending',
        data jsonb NOT NULL,
        data_storage text NOT NULL DEFAULT 'inline',
        data_key text,
        agent_id text,
        character_id text,
        result jsonb,
        result_storage text NOT NULL DEFAULT 'inline',
        result_key text,
        error text,
        error_storage text NOT NULL DEFAULT 'inline',
        error_key text,
        attempts integer NOT NULL DEFAULT 0,
        max_attempts integer NOT NULL DEFAULT 3,
        execution_interruptions integer NOT NULL DEFAULT 0,
        retryable_requeues integer NOT NULL DEFAULT 0,
        organization_id uuid NOT NULL,
        user_id uuid,
        api_key_id uuid,
        generation_id uuid,
        webhook_url text,
        webhook_status text,
        estimated_completion_at timestamp,
        scheduled_for timestamp NOT NULL DEFAULT now(),
        started_at timestamp,
        execution_generation uuid,
        execution_quiesced_at timestamp,
        completed_at timestamp,
        created_at timestamp NOT NULL DEFAULT now(),
        updated_at timestamp NOT NULL DEFAULT now(),
        CONSTRAINT reject_test_delete CHECK (
          type <> 'container_delete'
          OR data->>'containerId' <> '00000000-0000-4000-8000-000000515951'
        )
      );`;
