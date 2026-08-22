/**
 * Proves app and initial API-key creation share one real PostgreSQL transaction.
 *
 * Two service calls run on independent pool sessions while an external holder
 * owns the organization row lock. Both calls must be blocked in open
 * transactions before the holder releases them; with one slot remaining,
 * exactly one linked app/key pair commits and the losing key rolls back.
 */

import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { pushSchema } from "drizzle-kit/api";
import { Client } from "pg";
import {
  acquireEphemeralPostgres,
  type EphemeralPostgres,
} from "../../../lib/services/tenant-db/__tests__/ephemeral-postgres";
import { apiKeys } from "../../schemas/api-keys";
import {
  appDeploymentStatusEnum,
  appReviewStatusEnum,
  apps,
  userDatabaseStatusEnum,
} from "../../schemas/apps";
import { organizations } from "../../schemas/organizations";
import { users } from "../../schemas/users";

const SKIP_REASON =
  "[app API-key atomicity] SKIPPED - no real PostgreSQL available. " +
  "Set APPS_TENANT_DB_EPHEMERAL=1 with Docker, or provide APPS_TENANT_DB_TEST_DSN.";
const ORIGINAL_ENV = {
  DATABASE_URL: process.env.DATABASE_URL,
  TEST_DATABASE_URL: process.env.TEST_DATABASE_URL,
  NODE_ENV: process.env.NODE_ENV,
  ENVIRONMENT: process.env.ENVIRONMENT,
  MOCK_REDIS: process.env.MOCK_REDIS,
  CACHE_ENABLED: process.env.CACHE_ENABLED,
  ELIZA_KMS_BACKEND: process.env.ELIZA_KMS_BACKEND,
  ELIZA_CLOUD_MAX_APPS_PER_ORG: process.env.ELIZA_CLOUD_MAX_APPS_PER_ORG,
  LOCAL_PG_POOL_MAX: process.env.LOCAL_PG_POOL_MAX,
};

let postgres: EphemeralPostgres | null = null;
let databaseName: string | null = null;
let isolatedDsn: string | null = null;
let closeDatabaseConnectionsForTests:
  | typeof import("../../client").closeDatabaseConnectionsForTests
  | undefined;
let dbWrite: typeof import("../../client").dbWrite | undefined;
let appsRepository: typeof import("../apps").appsRepository | undefined;
let apiKeysRepository: typeof import("../api-keys").apiKeysRepository | undefined;
let appsService: typeof import("../../../lib/services/apps").appsService | undefined;
let apiKeysService: typeof import("../../../lib/services/api-keys").apiKeysService | undefined;

function restoreEnv(name: keyof typeof ORIGINAL_ENV, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

async function createIsolatedDatabase(baseDsn: string): Promise<string> {
  databaseName = `eliza_app_key_atomicity_${randomUUID().replaceAll("-", "")}`;
  const admin = new Client({ connectionString: baseDsn });
  await admin.connect();
  try {
    await admin.query(`CREATE DATABASE "${databaseName}"`);
  } finally {
    await admin.end();
  }
  const url = new URL(baseDsn);
  url.pathname = `/${databaseName}`;
  return url.toString();
}

async function waitUntilBlockedWaiters(observer: Client, minimum: number): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const result = await observer.query<{ waiters: number }>(`
      SELECT count(*)::int AS waiters
      FROM pg_stat_activity activity
      WHERE activity.datname = current_database()
        AND activity.pid <> pg_backend_pid()
        AND cardinality(pg_blocking_pids(activity.pid)) > 0
    `);
    if ((result.rows[0]?.waiters ?? 0) >= minimum) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for ${minimum} blocked app-create transactions`);
}

async function cleanupHarness(): Promise<void> {
  const acquiredPostgres = postgres;
  const databaseToDrop = databaseName;
  let firstError: unknown;
  const capture = async (operation: () => Promise<void>): Promise<void> => {
    try {
      await operation();
    } catch (error) {
      // error-policy:J6 Teardown continues through every resource so the first
      // cleanup failure does not leak the database or PostgreSQL process.
      firstError ??= error;
    }
  };

  await capture(async () => {
    await closeDatabaseConnectionsForTests?.();
  });
  closeDatabaseConnectionsForTests = undefined;

  if (acquiredPostgres && databaseToDrop) {
    await capture(async () => {
      const admin = new Client({ connectionString: acquiredPostgres.dsn });
      await admin.connect();
      try {
        await admin.query(
          "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()",
          [databaseToDrop],
        );
        await admin.query(`DROP DATABASE IF EXISTS "${databaseToDrop}"`);
      } finally {
        await admin.end();
      }
    });
  }

  await capture(async () => {
    await acquiredPostgres?.stop();
  });
  postgres = null;
  databaseName = null;
  isolatedDsn = null;
  for (const [name, value] of Object.entries(ORIGINAL_ENV)) {
    restoreEnv(name as keyof typeof ORIGINAL_ENV, value);
  }

  if (firstError) throw firstError;
}

async function initializeHarness(): Promise<void> {
  postgres = await acquireEphemeralPostgres();
  if (!postgres) {
    console.warn(SKIP_REASON);
    return;
  }

  isolatedDsn = await createIsolatedDatabase(postgres.dsn);
  process.env.DATABASE_URL = isolatedDsn;
  process.env.TEST_DATABASE_URL = isolatedDsn;
  process.env.NODE_ENV = "test";
  process.env.ENVIRONMENT = "local";
  process.env.MOCK_REDIS = "1";
  process.env.CACHE_ENABLED = "true";
  process.env.ELIZA_KMS_BACKEND = "memory";
  process.env.ELIZA_CLOUD_MAX_APPS_PER_ORG = "2";
  process.env.LOCAL_PG_POOL_MAX = "8";

  const clientModule = await import("../../client");
  closeDatabaseConnectionsForTests = clientModule.closeDatabaseConnectionsForTests;
  dbWrite = clientModule.dbWrite;
  const [appsRepositoryModule, apiKeysRepositoryModule, appsModule, apiKeysModule] =
    await Promise.all([
      import("../apps"),
      import("../api-keys"),
      import("../../../lib/services/apps"),
      import("../../../lib/services/api-keys"),
    ]);
  appsRepository = appsRepositoryModule.appsRepository;
  apiKeysRepository = apiKeysRepositoryModule.apiKeysRepository;
  appsService = appsModule.appsService;
  apiKeysService = apiKeysModule.apiKeysService;
}

afterAll(cleanupHarness, 60_000);

try {
  await initializeHarness();
} catch (error) {
  // error-policy:J2 Preserve initialization and cleanup failures together.
  try {
    await cleanupHarness();
  } catch (cleanupError) {
    // error-policy:J2 Aggregate both causes instead of masking either failure.
    throw new AggregateError(
      [error, cleanupError],
      "PostgreSQL app atomicity harness initialization and cleanup both failed",
    );
  }
  throw error;
}

beforeAll(async () => {
  if (!dbWrite) return;
  const schema = {
    organizations,
    users,
    apiKeys,
    apps,
    appDeploymentStatusEnum,
    appReviewStatusEnum,
    userDatabaseStatusEnum,
  };
  const { apply } = await pushSchema(schema as never, dbWrite as never);
  await apply();
}, 60_000);

const realPostgres = postgres ? describe : describe.skip;

realPostgres("app and initial API-key atomicity", () => {
  test("two creates competing for one slot commit exactly one linked key without compensation", async () => {
    if (
      !isolatedDsn ||
      !dbWrite ||
      !appsRepository ||
      !apiKeysRepository ||
      !appsService ||
      !apiKeysService
    ) {
      throw new Error("real PostgreSQL harness was not initialized");
    }
    const initializedAppsService = appsService;
    const initializedApiKeysRepository = apiKeysRepository;

    const initializedAppsService = appsService;
    const initializedApiKeysRepository = apiKeysRepository;

    const suffix = randomUUID();
    const [organization] = await dbWrite
      .insert(organizations)
      .values({ name: "Atomicity Org", slug: `atomicity-org-${suffix}` })
      .returning();
    const [user] = await dbWrite
      .insert(users)
      .values({
        steward_user_id: `atomicity-user-${suffix}`,
        organization_id: organization.id,
      })
      .returning();
    await appsRepository.create({
      name: "Existing Atomicity App",
      slug: `existing-atomicity-app-${suffix}`,
      organization_id: organization.id,
      created_by_user_id: user.id,
      app_url: "https://existing-atomicity.example",
      api_key_id: randomUUID(),
    });

    const names = [`Atomic Left ${suffix}`, `Atomic Right ${suffix}`] as const;
    const holder = new Client({ connectionString: isolatedDsn });
    const observer = new Client({ connectionString: isolatedDsn });
    await Promise.all([holder.connect(), observer.connect()]);
    await holder.query("BEGIN");
    await holder.query("SELECT id FROM organizations WHERE id = $1 FOR NO KEY UPDATE", [
      organization.id,
    ]);

    const deleteKey = spyOn(apiKeysService, "delete");
    const creates = names.map((name, index) =>
      initializedAppsService.create({
        name,
        organization_id: organization.id,
        created_by_user_id: user.id,
        app_url: `https://atomic-${index}.example`,
      }),
    );
    let holderReleased = false;

    try {
      await waitUntilBlockedWaiters(observer, 2);
      await holder.query("COMMIT");
      holderReleased = true;

      const outcomes = await Promise.allSettled(creates);
      const fulfilled = outcomes.filter(
        (outcome): outcome is PromiseFulfilledResult<Awaited<(typeof creates)[number]>> =>
          outcome.status === "fulfilled",
      );
      const rejected = outcomes.filter(
        (outcome): outcome is PromiseRejectedResult => outcome.status === "rejected",
      );

      expect(fulfilled).toHaveLength(1);
      expect(rejected).toHaveLength(1);
      const winner = fulfilled[0];
      const loser = rejected[0];
      if (!winner || !loser) throw new Error("expected one app-create winner and one loser");
      expect(loser.reason).toMatchObject({
        name: "AppCreationLimitError",
        organizationId: organization.id,
        limit: 2,
      });
      expect(await appsRepository.countByOrganization(organization.id)).toBe(2);

      const durableKeys = (
        await Promise.all(
          names.map((name) =>
            initializedApiKeysRepository.findByUserAndName(user.id, `${name} - App API Key`),
          ),
        )
      ).flat();
      const durableApps = (await appsRepository.listByOrganization(organization.id)).filter((app) =>
        names.includes(app.name as (typeof names)[number]),
      );

      expect(durableKeys).toHaveLength(1);
      expect(durableApps).toHaveLength(1);
      const durableKey = durableKeys[0];
      const durableApp = durableApps[0];
      if (!durableKey || !durableApp) throw new Error("winning app/key pair did not persist");
      expect(durableApp.api_key_id).toBe(durableKey.id);
      expect(winner.value.app.id).toBe(durableApp.id);
      expect(winner.value.app.api_key_id).toBe(durableKey.id);
      expect((await apiKeysService.validateApiKey(winner.value.apiKey))?.id).toBe(durableKey.id);
      expect(deleteKey).not.toHaveBeenCalled();
    } finally {
      if (!holderReleased) await holder.query("ROLLBACK");
      await Promise.allSettled(creates);
      deleteKey.mockRestore();
      await Promise.all([holder.end(), observer.end()]);
    }
  }, 30_000);
});
