/** Real admission SQL and migration guards; no provider calls. */
import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { generateDrizzleJson, generateMigration } from "drizzle-kit/api";
import { eq } from "drizzle-orm";

process.env.DATABASE_URL = "pglite://memory";
process.env.TEST_DATABASE_URL = "pglite://memory";
process.env.NODE_ENV = "test";
process.env.MOCK_REDIS = "1";

const { dbWrite, getPgliteClientForTests, closeDatabaseConnectionsForTests } = await import(
  "../../../db/client"
);
const appSchema = await import("../../../db/schemas/apps");
const { apps } = appSchema;
const { apiKeys } = await import("../../../db/schemas/api-keys");
const { mobileAppAuthGrants } = await import("../../../db/schemas/mobile-app-auth-grants");
const { appFrontendDeployments } = await import("../../../db/schemas/app-frontend-deployments");
const { jobs } = await import("../../../db/schemas/jobs");
const { appDeletionOperations } = await import("../../../db/repositories/app-deletion-operations");
const { appsRepository } = await import("../../../db/repositories/apps");
let appId: string;
let organizationId: string;
let userId: string;
const request = () => ({ appId, organizationId, userId, deleteGitHubRepo: false });

beforeAll(async () => {
  for (let statement of await generateMigration(
    generateDrizzleJson({}),
    generateDrizzleJson({
      ...appSchema,
      apiKeys,
      mobileAppAuthGrants,
      jobs,
      appFrontendDeployments,
    }),
  )) {
    if (statement.startsWith("ALTER TABLE") && statement.includes("FOREIGN KEY")) continue;
    // Build the pre-0563 schema, then execute the actual additive migration.
    if (statement.startsWith('CREATE TABLE "apps"'))
      statement = statement.replace(/\n\s*"deletion_job_id" uuid,/, "");
    await dbWrite.execute(statement);
  }
  const migration = readFileSync(
    new URL("../../../db/migrations/0566_app_deletion_authority.sql", import.meta.url),
    "utf8",
  );
  for (const statement of migration.split("--> statement-breakpoint"))
    if (statement.trim()) await getPgliteClientForTests().exec(statement);
  for (const statement of readFileSync(
    new URL("../../../db/migrations/0568_app_cleanup_manifest.sql", import.meta.url),
    "utf8",
  ).split("--> statement-breakpoint"))
    if (statement.trim()) await getPgliteClientForTests().exec(statement);
}, 120_000);
beforeEach(async () => {
  await getPgliteClientForTests().exec(
    "TRUNCATE apps CASCADE; TRUNCATE jobs CASCADE; TRUNCATE api_keys CASCADE;",
  );
  appId = randomUUID();
  organizationId = randomUUID();
  userId = randomUUID();
  await dbWrite.insert(apps).values({
    id: appId,
    organization_id: organizationId,
    name: "Delete me",
    slug: appId,
    app_url: "https://app.example",
    is_active: true,
  });
});
afterAll(closeDatabaseConnectionsForTests);

test("admission binds one original job and revokes mobile credentials in the same transaction", async () => {
  const credential = randomUUID();
  await dbWrite.insert(apiKeys).values({
    id: credential,
    name: "mobile",
    key_hash: credential,
    key_prefix: "eliza_mobile_",
    organization_id: organizationId,
    user_id: userId,
    source_app_id: appId,
    key_ciphertext: "ciphertext",
    is_active: true,
  });
  const first = await appDeletionOperations.admit(request());
  const replay = await appDeletionOperations.admit(request());
  expect(first?.job.id).toBe(replay?.job.id);
  expect(first?.app?.is_active).toBe(false);
  expect(first?.app?.deletion_job_id).toBe(first?.job.id);
  expect(first?.revokedKeys).toEqual([{ id: credential, organizationId }]);
  const [key] = await dbWrite.select().from(apiKeys);
  expect(key?.is_active).toBe(false);
  expect(key?.deleted_at).not.toBeNull();
  expect(key?.key_ciphertext).toBeNull();
  expect(await dbWrite.select().from(jobs)).toHaveLength(1);
});

test("the permanent deletion binding rejects ordinary and direct SQL reactivation", async () => {
  const admitted = await appDeletionOperations.admit(request());
  await expect(appsRepository.update(appId, { is_active: true })).rejects.toMatchObject({
    code: "APP_DELETION_IN_PROGRESS",
  });
  await expect(
    getPgliteClientForTests().query("UPDATE apps SET is_active=true WHERE id=$1", [appId]),
  ).rejects.toMatchObject({ code: "23514" });
  await expect(
    getPgliteClientForTests().query("UPDATE apps SET deletion_job_id=NULL WHERE id=$1", [appId]),
  ).rejects.toMatchObject({ code: "23514" });
  expect((await appsRepository.findById(appId))?.deletion_job_id).toBe(admitted?.job.id);
});

test("a retry cannot change the original deletion options or job payload", async () => {
  const admitted = await appDeletionOperations.admit(request());
  await expect(
    appDeletionOperations.admit({ ...request(), deleteGitHubRepo: true }),
  ).rejects.toMatchObject({ code: "APP_DELETION_REQUEST_CONFLICT" });
  await expect(
    getPgliteClientForTests().query(
      "UPDATE jobs SET data=jsonb_set(data,'{deleteGitHubRepo}','true') WHERE id=$1",
      [admitted?.job.id],
    ),
  ).rejects.toMatchObject({ code: "23514" });
  expect(await dbWrite.select().from(jobs)).toHaveLength(1);
});

test("foreign organization admission creates no operation and does not fence the app", async () => {
  expect(
    await appDeletionOperations.admit({ ...request(), organizationId: randomUUID() }),
  ).toBeUndefined();
  expect(await dbWrite.select().from(jobs)).toHaveLength(0);
  expect((await appsRepository.findById(appId))?.is_active).toBe(true);
});

test("credential revocation failure rolls back the job and permanent app fence", async () => {
  const id = randomUUID();
  await dbWrite.insert(apiKeys).values({
    id,
    name: "mobile",
    key_hash: id,
    key_prefix: "eliza_mobile_",
    organization_id: organizationId,
    user_id: userId,
    source_app_id: appId,
  });
  await getPgliteClientForTests().exec(
    "CREATE FUNCTION reject_app_delete_key() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'fixture rejection'; END $$; CREATE TRIGGER reject_app_delete_key BEFORE UPDATE ON api_keys FOR EACH ROW EXECUTE FUNCTION reject_app_delete_key();",
  );
  try {
    await expect(appDeletionOperations.admit(request())).rejects.toMatchObject({
      cause: { code: "P0001" },
    });
  } finally {
    await getPgliteClientForTests().exec(
      "DROP TRIGGER reject_app_delete_key ON api_keys; DROP FUNCTION reject_app_delete_key();",
    );
  }
  expect(await dbWrite.select().from(jobs)).toHaveLength(0);
  const [app] = await dbWrite.select().from(apps).where(eq(apps.id, appId));
  expect(app?.deletion_job_id).toBeNull();
  expect(app?.is_active).toBe(true);
});

test("an inconsistent ordinary app key cannot revoke another organization's credential", async () => {
  const key = randomUUID();
  await dbWrite.insert(apiKeys).values({
    id: key,
    name: "foreign",
    key_hash: key,
    key_prefix: "eliza_",
    organization_id: randomUUID(),
    user_id: randomUUID(),
    is_active: true,
  });
  await dbWrite.update(apps).set({ api_key_id: key }).where(eq(apps.id, appId));
  await expect(appDeletionOperations.admit(request())).rejects.toMatchObject({
    code: "APP_DELETION_KEY_OWNER_CONFLICT",
  });
  expect(await dbWrite.select().from(jobs)).toHaveLength(0);
  expect((await dbWrite.select().from(apiKeys))[0]?.is_active).toBe(true);
});

for (const target of ["credential", "grant"] as const)
  test(`suppressed ${target} retirement rolls back deletion admission`, async () => {
    const key = randomUUID();
    await dbWrite.insert(apiKeys).values({
      id: key,
      name: "mobile",
      key_hash: key,
      key_prefix: "eliza_mobile_",
      organization_id: organizationId,
      user_id: userId,
      source_app_id: appId,
    });
    if (target === "grant")
      await dbWrite.insert(mobileAppAuthGrants).values({
        code_hash: randomUUID(),
        app_id: appId,
        client_id: "fixture",
        user_id: userId,
        organization_id: organizationId,
        environment: "staging",
        redirect_uri: "ai.eliza.test:/return",
        state_hash: "state",
        code_challenge: "challenge",
        code_challenge_method: "S256",
        scopes: ["inference"],
        expires_at: new Date(Date.now() + 60_000),
      });
    const table = target === "credential" ? "api_keys" : "mobile_app_auth_grants";
    const event = target === "credential" ? "UPDATE" : "DELETE";
    await getPgliteClientForTests().exec(
      `CREATE FUNCTION suppress_retirement() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NULL; END $$; CREATE TRIGGER suppress_retirement BEFORE ${event} ON ${table} FOR EACH ROW EXECUTE FUNCTION suppress_retirement();`,
    );
    try {
      await expect(appDeletionOperations.admit(request())).rejects.toMatchObject({
        code: "APP_DELETION_REVOCATION_UNCONFIRMED",
      });
    } finally {
      await getPgliteClientForTests().exec(
        `DROP TRIGGER suppress_retirement ON ${table}; DROP FUNCTION suppress_retirement();`,
      );
    }
    expect(await dbWrite.select().from(jobs)).toHaveLength(0);
    expect((await appsRepository.findByIdForWrite(appId))?.is_active).toBe(true);
  });
