import { afterAll, beforeAll, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { organizations } from "@elizaos/cloud-shared/db/schemas/organizations";
import { users } from "@elizaos/cloud-shared/db/schemas/users";
import type { AppEnv } from "@elizaos/cloud-shared/types/cloud-worker-env";
import { sql } from "drizzle-orm";
import { getTableConfig } from "drizzle-orm/pg-core";
import { Hono } from "hono";
import { SignJWT } from "jose";

process.env.DATABASE_URL = "pglite://memory";
process.env.TEST_DATABASE_URL = "pglite://memory";
process.env.CACHE_ENABLED = "true";
process.env.CACHE_BACKEND = "memory";
process.env.NODE_ENV = "test";

const { dbWrite, closeDatabaseConnectionsForTests } = await import(
  "@elizaos/cloud-shared/db/client"
);
const { deriveMobileAppAuthS256Challenge } = await import(
  "@elizaos/cloud-shared/lib/services/mobile-app-auth"
);
const { mountShardRoutes } = await import("../src/_router.generated");
const { routeShardKey } = await import("../src/router-shards");
const { authMiddleware } = await import("../src/middleware/auth");
const backupPath = "/api/v1/app-auth/mobile/password-backup";
const organizationId = randomUUID();
const appId = randomUUID();
const ownerId = randomUUID();
const otherId = randomUUID();
const clientId = "example.private.backup";
const redirectUri = "https://example.com/auth/callback";
const env = {
  ENVIRONMENT: "staging",
  NODE_ENV: "test",
  ELIZA_MOBILE_APP_AUTH_ENABLED: "true",
  RATE_LIMIT_DISABLED: "true",
  STEWARD_JWT_SECRET: "synthetic-test-signing-key-32-bytes-minimum",
};
const ownerSubject = "synthetic-steward-owner";
const otherSubject = "synthetic-steward-other";
async function signedToken(subject: string, age: number) {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({ authMethod: "oauth", auth_time: now - age })
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .setSubject(subject)
    .setIssuedAt(now)
    .setExpirationTime(now + 3600)
    .sign(new TextEncoder().encode(env.STEWARD_JWT_SECRET));
}
const ownerToken = await signedToken(ownerSubject, 10);
const otherToken = await signedToken(otherSubject, 10);
const olderToken = await signedToken(ownerSubject, 301);

const verifier = "v".repeat(44);
const state = "s".repeat(44);
const bytes = new Uint8Array([0x31, 0x5a, 0x04, 0x87]);

const app = new Hono<AppEnv>();
app.use("*", authMiddleware);
await mountShardRoutes(app, routeShardKey(backupPath));

function quote(value: string) {
  return `"${value.replaceAll('"', '""')}"`;
}

async function installIdentityFixture() {
  const enums = new Set<string>();
  for (const table of [organizations, users]) {
    const config = getTableConfig(table);
    for (const column of config.columns) {
      const definition = "enum" in column ? column.enum : undefined;
      if (
        typeof definition !== "object" ||
        definition === null ||
        !("enumName" in definition) ||
        typeof definition.enumName !== "string" ||
        !("enumValues" in definition) ||
        !Array.isArray(definition.enumValues) ||
        enums.has(definition.enumName)
      )
        continue;
      const values = definition.enumValues.map(
        (value) => `'${String(value).replaceAll("'", "''")}'`,
      );
      await dbWrite.execute(
        sql.raw(
          `CREATE TYPE ${quote(definition.enumName)} AS ENUM (${values.join(",")})`,
        ),
      );
      enums.add(definition.enumName);
    }
    const columns = config.columns.map(
      (column) =>
        `${quote(column.name)} ${column.getSQLType()}${column.primary ? " PRIMARY KEY" : ""}`,
    );
    await dbWrite.execute(
      sql.raw(`CREATE TABLE ${quote(config.name)} (${columns.join(",")})`),
    );
  }
  await dbWrite.execute(
    sql`CREATE TABLE user_identities (user_id uuid, steward_user_id text)`,
  );
}

beforeAll(async () => {
  await dbWrite.execute(sql`CREATE TABLE apps (
    id uuid PRIMARY KEY, name text, description text, logo_url text, website_url text,
    app_url text, allowed_origins jsonb, is_active boolean, is_approved boolean
  )`);
  await installIdentityFixture();
  for (const name of [
    "0574_native_app_auth_client_registration",
    "0577_password_backup",
  ]) {
    const migration = await Bun.file(
      new URL(`../../shared/src/db/migrations/${name}.sql`, import.meta.url),
    ).text();
    for (const statement of migration.split("--> statement-breakpoint"))
      await dbWrite.execute(sql.raw(statement));
  }
  await dbWrite.execute(sql`INSERT INTO apps (id, name, app_url, allowed_origins, is_active, is_approved)
    VALUES (${appId}, 'Test', 'https://example.com', ${JSON.stringify([redirectUri])}::jsonb, true, true)`);
  await dbWrite.execute(sql`INSERT INTO organizations (id, is_active, account_lifecycle_state, account_lifecycle_revision)
    VALUES (${organizationId}, true, 'active', 0)`);
  await dbWrite.execute(sql`INSERT INTO users (id, steward_user_id, organization_id, is_active, account_lifecycle_state)
    VALUES (${ownerId}, ${ownerSubject}, ${organizationId}, true, 'active'), (${otherId}, ${otherSubject}, ${organizationId}, true, 'active')`);
  await dbWrite.execute(sql`INSERT INTO mobile_app_auth_clients (client_id, app_id, redirect_uri)
    VALUES (${clientId}, ${appId}, ${redirectUri})`);
}, 90_000);

afterAll(async () => {
  await closeDatabaseConnectionsForTests();
});

function issue(purpose: string, bearer = ownerToken) {
  return app.request(
    backupPath,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${bearer}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        purpose,
        clientId,
        environment: "staging",
        redirectUri,
        state,
        codeChallengeMethod: "S256",
        codeChallenge: deriveMobileAppAuthS256Challenge(verifier),
      }),
    },
    env,
  );
}

async function grant(purpose: string, user?: string) {
  const response = await issue(purpose, user);
  expect(response.status).toBe(200);
  const approval: {
    code: string;
    scope: string;
    ownerId: string;
    organizationId: string;
  } = await response.json();
  expect(approval).toMatchObject({
    ownerId: user === otherToken ? otherId : ownerId,
    organizationId,
  });
  return approval;
}

function use(
  code: string,
  method: string,
  extra: Record<string, string> = {},
  body?: BodyInit,
) {
  return app.request(
    backupPath,
    {
      method,
      headers: {
        Authorization: `Bearer ${code}`,
        "X-Backup-Verifier": verifier,
        "X-Backup-State": state,
        ...extra,
      },
      body,
    },
    env,
  );
}

test("proof-bound approvals protect encrypted snapshot round-trip, replay, delete, and revision", async () => {
  const readiness = await app.request(
    `${backupPath}/readiness?clientId=${clientId}`,
    undefined,
    env,
  );
  expect([
    readiness.status,
    readiness.headers.get("X-Password-Backup-Version"),
  ]).toEqual([204, "2"]);
  const unregistered = await app.request(
    `${backupPath}/readiness`,
    undefined,
    env,
  );
  expect([
    unregistered.status,
    unregistered.headers.get("X-Password-Backup-Version"),
  ]).toEqual([404, null]);
  expect((await issue("save", "eliza_mobile_inference")).status).toBe(401);
  const staleAuthentication = await issue("save", olderToken);
  expect(staleAuthentication.status).toBe(401);
  expect(await staleAuthentication.json()).toMatchObject({
    code: "recent_auth_required",
  });
  expect((await use("eliza_mobile_inference", "GET")).status).toBe(401);
  const verification = await grant("verify");
  expect((await use(verification.code, "GET")).status).toBe(401);
  const create = await grant("save");
  expect((await use(create.code, "GET")).status).toBe(401);
  expect(
    (
      await use(
        create.code,
        "PUT",
        {
          "X-Backup-Verifier": "w".repeat(44),
          "If-None-Match": "*",
          "Content-Type": "application/octet-stream",
        },
        bytes,
      )
    ).status,
  ).toBe(401);
  const stored = await use(
    create.code,
    "PUT",
    { "If-None-Match": "*", "Content-Type": "application/octet-stream" },
    bytes,
  );
  expect([stored.status, stored.headers.get("ETag")]).toEqual([204, '"1"']);
  const read = await grant("read");
  const reads = await Promise.all([
    use(read.code, "GET"),
    use(read.code, "GET"),
  ]);
  expect(reads.map((response) => response.status).sort()).toEqual([200, 401]);
  const snapshot = reads.find((response) => response.status === 200);
  if (!snapshot) throw new Error("Missing successful backup read");
  expect(snapshot.headers.get("Cache-Control")).toBe("no-store");
  expect(new Uint8Array(await snapshot.arrayBuffer())).toEqual(bytes);
  const other = await grant("read", otherToken);
  expect(other.scope).not.toEqual(create.scope);
  expect((await use(other.code, "GET")).status).toBe(404);
  const stale = await grant("save");
  expect(
    (
      await use(
        stale.code,
        "PUT",
        { "If-Match": '"9"', "Content-Type": "application/octet-stream" },
        bytes,
      )
    ).status,
  ).toBe(412);
  const oversized = await grant("save");
  expect(
    (
      await use(
        oversized.code,
        "PUT",
        { "If-Match": '"1"', "Content-Type": "application/octet-stream" },
        new Uint8Array(2 * 1024 * 1024 + 1),
      )
    ).status,
  ).toBe(413);
  const interrupted = await grant("save");
  const stream = new ReadableStream<Uint8Array<ArrayBuffer>>(
    {
      async pull(writer) {
        await dbWrite.execute(
          sql`UPDATE mobile_app_auth_clients SET enabled = false WHERE client_id = ${clientId}`,
        );
        writer.enqueue(new Uint8Array(bytes));
        writer.close();
      },
    },
    { highWaterMark: 0 },
  );
  expect(
    (
      await use(
        interrupted.code,
        "PUT",
        { "If-Match": '"1"', "Content-Type": "application/octet-stream" },
        stream,
      )
    ).status,
  ).toBe(401);
  await dbWrite.execute(
    sql`UPDATE mobile_app_auth_clients SET enabled = true WHERE client_id = ${clientId}`,
  );
  const remove = await grant("delete");
  expect((await use(remove.code, "DELETE", { "If-Match": '"1"' })).status).toBe(
    204,
  );
  const after = await grant("read");
  const deleted = await use(after.code, "GET");
  expect([deleted.status, deleted.headers.get("ETag")]).toEqual([404, '"2"']);
  const revoked = await grant("read");
  await dbWrite.execute(
    sql`UPDATE mobile_app_auth_clients SET enabled = false WHERE client_id = ${clientId}`,
  );
  expect((await use(revoked.code, "GET")).status).toBe(401);
});
