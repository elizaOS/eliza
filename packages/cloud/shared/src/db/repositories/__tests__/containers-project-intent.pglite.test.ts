/**
 * Exercises project-intent admission and quota serialization against real
 * in-process PGlite. Parallel callers share the production repository and SQL;
 * no provider or network boundary is used.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";

process.env.DATABASE_URL = "pglite://memory";
process.env.TEST_DATABASE_URL = "pglite://memory";
process.env.NODE_ENV ||= "test";

const ORG_ID = "00000000-0000-4000-8000-000000000001";
const USER_ID = "00000000-0000-4000-8000-000000000002";
const TIMEOUT = 60_000;

let dbWrite: typeof import("../../client").dbWrite;
let closeDb: typeof import("../../client").closeDatabaseConnectionsForTests | undefined;
let repository: typeof import("../containers").containersRepository;
let QuotaExceededError: typeof import("../containers").QuotaExceededError;
let ready = true;

beforeAll(async () => {
  try {
    ({ closeDatabaseConnectionsForTests: closeDb, dbWrite } = await import("../../client"));
    ({ containersRepository: repository, QuotaExceededError } = await import("../containers"));
    const ddl = [
      `CREATE TABLE organizations (
        id uuid PRIMARY KEY,
        credit_balance numeric(12,6) NOT NULL DEFAULT 0
      )`,
      `CREATE TABLE organization_config (
        id uuid PRIMARY KEY,
        organization_id uuid NOT NULL UNIQUE,
        webhook_url text,
        webhook_secret text,
        max_api_requests integer DEFAULT 1000,
        max_tokens_per_request integer,
        allowed_models jsonb NOT NULL DEFAULT '[]',
        allowed_providers jsonb NOT NULL DEFAULT '[]',
        settings jsonb NOT NULL DEFAULT '{}',
        created_at timestamp NOT NULL DEFAULT now(),
        updated_at timestamp NOT NULL DEFAULT now()
      )`,
      `CREATE TABLE containers (
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
      )`,
      `INSERT INTO organizations (id, credit_balance) VALUES ('${ORG_ID}', 0)`,
      `INSERT INTO organization_config (id, organization_id, settings)
       VALUES ('00000000-0000-4000-8000-000000000003', '${ORG_ID}', '{"max_containers":2}')`,
    ];
    for (const statement of ddl) {
      await dbWrite.execute(statement);
    }
  } catch (error) {
    ready = false;
    console.error("[containers-project-intent] PGlite setup failed", error);
  }
}, TIMEOUT);

afterAll(async () => {
  if (closeDb) await closeDb();
});

function candidate(projectName: string) {
  return {
    name: projectName,
    project_name: projectName,
    organization_id: ORG_ID,
    user_id: USER_ID,
    image_tag: "ghcr.io/elizaos/eliza:stable",
    status: "pending",
  };
}

async function countRows(): Promise<number> {
  const result = await dbWrite.execute("SELECT count(*)::int AS count FROM containers");
  return Number((result.rows[0] as { count: number }).count);
}

describe("ContainersRepository project intent", () => {
  test(
    "same-project callers create one row and retry reconstructs it at cap",
    async () => {
      expect(ready).toBe(true);
      await dbWrite.execute("DELETE FROM containers");

      const [left, right] = await Promise.all([
        repository.createWithProjectIntentAndQuotaCheck(candidate("same-project")),
        repository.createWithProjectIntentAndQuotaCheck(candidate("same-project")),
      ]);
      expect([left.created, right.created].sort()).toEqual([false, true]);
      expect(left.container.id).toBe(right.container.id);
      expect(await countRows()).toBe(1);

      await repository.createWithQuotaCheck(candidate("fills-cap"));
      const retry = await repository.createWithProjectIntentAndQuotaCheck(
        candidate("same-project"),
      );
      expect(retry.created).toBe(false);
      expect(retry.container.id).toBe(left.container.id);
      expect(await countRows()).toBe(2);
    },
    TIMEOUT,
  );

  test(
    "distinct projects at limit minus one admit one and reject one canonically",
    async () => {
      expect(ready).toBe(true);
      await dbWrite.execute("DELETE FROM containers");
      await repository.createWithQuotaCheck(candidate("baseline"));

      const settled = await Promise.allSettled([
        repository.createWithProjectIntentAndQuotaCheck(candidate("left")),
        repository.createWithProjectIntentAndQuotaCheck(candidate("right")),
      ]);
      expect(settled.filter((result) => result.status === "fulfilled")).toHaveLength(1);
      const rejection = settled.find((result) => result.status === "rejected");
      expect(rejection?.status).toBe("rejected");
      if (rejection?.status === "rejected") {
        expect(rejection.reason).toBeInstanceOf(QuotaExceededError);
        expect(rejection.reason).toMatchObject({ current: 2, max: 2 });
      }
      expect(await countRows()).toBe(2);
    },
    TIMEOUT,
  );

  test(
    "a terminal prior generation does not block redeploy",
    async () => {
      expect(ready).toBe(true);
      await dbWrite.execute("DELETE FROM containers");
      const prior = await repository.createWithProjectIntentAndQuotaCheck(candidate("redeploy"));
      await dbWrite.execute(
        `UPDATE containers SET status = 'failed' WHERE id = '${prior.container.id}'`,
      );

      const next = await repository.createWithProjectIntentAndQuotaCheck(candidate("redeploy"));
      expect(next.created).toBe(true);
      expect(next.container.id).not.toBe(prior.container.id);
      expect(await countRows()).toBe(2);
    },
    TIMEOUT,
  );
});

test("PGlite schema applied — never a silent skip", () => {
  expect(ready).toBe(true);
});
