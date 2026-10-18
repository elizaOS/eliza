/**
 * Drives the REAL `monitorAllContainers` sweep from `health-monitor` against
 * in-process PGlite and a live local health endpoint.
 *
 * The sweep is the only caller of `updateContainerHealth`, and that function
 * documents an atomic restore of `failed` back to `running` when a later check
 * passes. The sweep selects only `status = 'running'`, so the restore branch is
 * unreachable: one failed probe (a 10s timeout, a restarting container) takes a
 * container out of the sweep forever and the row stays `failed` after the
 * container answers again. `failed` is not a terminal status (`deleted` is).
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { sql } from "drizzle-orm";

process.env.DATABASE_URL = "pglite://memory";
process.env.TEST_DATABASE_URL = "pglite://memory";
process.env.NODE_ENV ||= "test";

const ORG_ID = "00000000-0000-4000-8000-000000000001";
const USER_ID = "00000000-0000-4000-8000-000000000002";

type ClientModule = typeof import("../../../db/client");
type HealthModule = typeof import("../health-monitor");

let dbWrite: ClientModule["dbWrite"];
let closeDb: ClientModule["closeDatabaseConnectionsForTests"] | undefined;
let monitorAllContainers: HealthModule["monitorAllContainers"];
let server: ReturnType<typeof Bun.serve> | undefined;
let baseUrl = "";

const CONTAINERS_DDL = `CREATE TABLE containers (
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

async function insertContainer(id: string, status: string): Promise<void> {
  await dbWrite.execute(sql`
    INSERT INTO containers (id, name, project_name, organization_id, user_id, status, load_balancer_url, error_message)
    VALUES (${id}, ${`c-${id}`}, 'p', ${ORG_ID}, ${USER_ID}, ${status}, ${baseUrl}, 'Health check failed')
  `);
}

async function readContainer(
  id: string,
): Promise<{ status: string; lastHealthCheck: Date | null }> {
  const result = await dbWrite.execute(
    sql`SELECT status, last_health_check FROM containers WHERE id = ${id}`,
  );
  const rows = result.rows as Array<{ status: string; last_health_check: string | null }>;
  return {
    status: rows[0].status,
    lastHealthCheck: rows[0].last_health_check ? new Date(rows[0].last_health_check) : null,
  };
}

beforeAll(async () => {
  ({ closeDatabaseConnectionsForTests: closeDb, dbWrite } = await import("../../../db/client"));
  ({ monitorAllContainers } = await import("../health-monitor"));
  await dbWrite.execute(CONTAINERS_DDL);

  server = Bun.serve({
    port: 0,
    fetch: () => new Response("ok", { status: 200 }),
  });
  baseUrl = `http://127.0.0.1:${server.port}`;
}, 120_000);

afterAll(async () => {
  server?.stop(true);
  await closeDb?.();
});

describe("monitorAllContainers recovery", () => {
  test("re-checks a failed container and restores it when the probe passes", async () => {
    const id = "00000000-0000-4000-8000-0000000000a1";
    await insertContainer(id, "failed");

    const results = await monitorAllContainers({ timeout: 2000 });

    const checked = results.filter((r) => r.containerId === id);
    expect(checked).toHaveLength(1);
    expect(checked[0].healthy).toBe(true);

    const stored = await readContainer(id);
    expect(stored.status).toBe("running");
    expect(stored.lastHealthCheck).not.toBeNull();
  }, 60_000);

  test("leaves a deleted container alone", async () => {
    const id = "00000000-0000-4000-8000-0000000000a2";
    await insertContainer(id, "deleted");

    await monitorAllContainers({ timeout: 2000 });

    const stored = await readContainer(id);
    expect(stored.status).toBe("deleted");
  }, 60_000);
});
