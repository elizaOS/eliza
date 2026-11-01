/** Real PostgreSQL proof that managed writers lock users before requesting organization permits. */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { sql } from "drizzle-orm";
import { Client } from "pg";

const url = process.env.INFERENCE_POLICY_TEST_POSTGRES_URL;
const schema = `inference_user_lock_${randomUUID().replaceAll("-", "_")}`;
const organizationId = randomUUID();
const userId = randomUUID();
let setup: Client;
let observer: Client;
let scopedUrl: string;
let fence: typeof import("./inference-policy-fence");
let database: typeof import("../../db/client");
let helpers: typeof import("../../db/helpers");
let bindings: typeof import("../runtime/cloud-bindings");
let checkLock: (() => Promise<void>) | undefined;
let checks = 0;

const gate = {
  getByName() {
    return {
      async fetch(request: Request) {
        const body = (await request.json()) as { mutationId: string };
        if (new URL(request.url).pathname === "/policy-mutation/begin") {
          await checkLock?.();
          checks++;
          return Response.json({
            blocked: true,
            mutationId: body.mutationId,
            fenceToken: "local-test-permit",
            validUntil: Date.now() + 30_000,
          });
        }
        return Response.json({ committed: true });
      },
    };
  },
};

async function run<T>(operation: () => Promise<T>): Promise<T> {
  return bindings.runWithCloudBindingsAsync(
    {
      DATABASE_URL: scopedUrl,
      TEST_DATABASE_URL: scopedUrl,
      INFERENCE_RATE_POLICY_ADMISSION: "true",
      INFERENCE_ADMISSION_GATES: gate,
    },
    operation,
  );
}

async function probe(shared: boolean): Promise<boolean> {
  const result = await observer.query(
    shared
      ? "SELECT pg_try_advisory_xact_lock_shared(hashtextextended('inference-user-policy:' || $1::uuid::text,0)) AS acquired"
      : "SELECT pg_try_advisory_xact_lock(hashtextextended('inference-user-policy:' || $1::uuid::text,0)) AS acquired",
    [userId],
  );
  return result.rows[0].acquired;
}

describe.skipIf(!url)("managed inference user lock order", () => {
  beforeAll(async () => {
    const parsed = new URL(url!);
    if (
      !["127.0.0.1", "localhost", "::1", "[::1]"].includes(parsed.hostname) ||
      !parsed.username.startsWith("qa_")
    )
      throw Error("This suite requires an isolated loopback PostgreSQL QA role");
    setup = new Client({ connectionString: url });
    observer = new Client({ connectionString: url });
    await Promise.all([setup.connect(), observer.connect()]);
    await setup.query(`CREATE SCHEMA ${schema}; SET search_path TO ${schema}`);
    parsed.searchParams.set("options", `-c search_path=${schema},pg_catalog`);
    scopedUrl = parsed.toString();
    await setup.query(`
      CREATE TABLE organizations(id uuid PRIMARY KEY);
      CREATE TABLE users(id uuid PRIMARY KEY,organization_id uuid);
      CREATE TABLE api_keys(id uuid PRIMARY KEY,organization_id uuid,user_id uuid);
      CREATE TABLE inference_policy_authorities(organization_id uuid PRIMARY KEY,enabled boolean,rate_enabled boolean,epoch bigint,updated_at timestamptz);
      CREATE TABLE inference_policy_mutations(organization_id uuid,mutation_id text,fence_token text,permit_expires_at timestamptz,applying_txid bigint,phase text,epoch bigint,updated_at timestamptz);
    `);
    // Use the migration's exact shared/exclusive lock implementation.
    const migration = await readFile(
      new URL("../../db/migrations/0553_inference_policy_snapshot_fence.sql", import.meta.url),
      "utf8",
    );
    const lockStatement = migration
      .split("--> statement-breakpoint")
      .find((statement) => statement.includes("CREATE FUNCTION lock_inference_policy_users"));
    if (!lockStatement) throw Error("User lock migration is missing");
    await setup.query(lockStatement);
    await setup.query("INSERT INTO organizations VALUES($1)", [organizationId]);
    await setup.query("INSERT INTO users VALUES($1,$2)", [userId, organizationId]);
    await setup.query("INSERT INTO inference_policy_authorities VALUES($1,false,true,1,now())", [
      organizationId,
    ]);
    database = await import("../../db/client");
    helpers = await import("../../db/helpers");
    bindings = await import("../runtime/cloud-bindings");
    fence = await import("./inference-policy-fence");
  }, 60_000);

  afterAll(async () => {
    if (database) await database.closeDatabaseConnectionsForTests();
    if (observer) await observer.end();
    if (setup) {
      await setup.query(`DROP SCHEMA ${schema} CASCADE`);
      await setup.end();
    }
  });

  test("standing has the exclusive user lock before the organization permit, including an existing transaction", async () => {
    checkLock = async () => {
      await observer.query("BEGIN");
      try {
        expect(await probe(true)).toBe(false);
        expect(await probe(false)).toBe(false);
      } finally {
        await observer.query("ROLLBACK");
      }
    };
    const before = checks;
    await run(() =>
      helpers.writeTransaction((tx) =>
        fence.withInferenceUserPolicyMutation(userId.toUpperCase(), [], async () => {}, tx),
      ),
    );
    expect(checks).toBe(before + 1);
  });

  test("key association takes the same canonical user lock in shared mode before its organization permit", async () => {
    checkLock = async () => {
      await observer.query("BEGIN");
      try {
        expect(await probe(true)).toBe(true);
        expect(await probe(false)).toBe(false);
      } finally {
        await observer.query("ROLLBACK");
      }
    };
    const before = checks;
    await run(() =>
      fence.withInferencePolicyMutation(
        {
          organizationIds: [organizationId],
          userLockIds: [userId.toUpperCase(), userId],
        },
        async (tx) => {
          await tx.execute(sql`SELECT 1`);
        },
      ),
    );
    expect(checks).toBe(before + 1);
  });
});
