/** Actual Hono and schema-derived PostgreSQL queries; only auth and Google I/O are synthetic. */
import { afterAll, beforeAll, beforeEach, expect, mock, test } from "bun:test";
import { PGlite } from "@electric-sql/pglite";
import * as realAuth from "@elizaos/cloud-shared/auth";
import * as realDb from "@elizaos/cloud-shared/db/client";
import { organizations } from "@elizaos/cloud-shared/db/schemas/organizations";
import { users } from "@elizaos/cloud-shared/db/schemas/users";
import * as realGoogle from "@elizaos/cloud-shared/lib/services/agent-google-connector";
import { googlePersonalContextConsent } from "@elizaos/cloud-shared/lib/services/shared-runtime/shared-google-consent";
import { getTableConfig } from "drizzle-orm/pg-core";
import { drizzle } from "drizzle-orm/pglite";

const ORG = "11111111-1111-4111-8111-111111111111";
const OWNER = "22222222-2222-4222-8222-222222222222";
const GRANT = "44444444-4444-4444-8444-444444444444";
const pg = new PGlite();
const database = drizzle(pg);
const originalDb = { ...realDb };
const originalAuth = { ...realAuth };
const originalGoogle = { ...realGoogle };
const statusCalls: unknown[] = [];
let missingGrant = false;
mock.module("@elizaos/cloud-shared/db/client", () => ({
  ...originalDb,
  dbRead: database,
  dbWrite: database,
}));
mock.module("@elizaos/cloud-shared/auth", () => ({
  ...originalAuth,
  requireUserOrApiKeyWithOrg: async () => ({
    id: OWNER,
    organization_id: ORG,
    preferences: "{}",
  }),
}));
mock.module(
  "@elizaos/cloud-shared/lib/services/agent-google-connector",
  () => ({
    ...originalGoogle,
    getManagedGoogleConnectorStatus: async (scope: { grantId?: string }) => {
      statusCalls.push(scope);
      if (missingGrant)
        throw new realGoogle.AgentGoogleConnectorError(
          404,
          "Grant unavailable",
        );
      return { connected: true, connectionId: scope.grantId };
    },
  }),
);
const { default: app } = await import("./route");
const purpose = "personal_google_context_v1";
const selected = { ...googlePersonalContextConsent(), grantId: GRANT };
const quote = (name: string) => `"${name.replaceAll('"', '""')}"`;

beforeAll(async () => {
  const enums = new Set<string>();
  for (const table of [organizations, users]) {
    const config = getTableConfig(table);
    for (const column of config.columns) {
      const definition = (
        column as unknown as {
          enum?: { enumName: string; enumValues: string[] };
        }
      ).enum;
      if (definition && !enums.has(definition.enumName)) {
        await pg.exec(
          `CREATE TYPE ${quote(definition.enumName)} AS ENUM (${definition.enumValues
            .map((value) => `'${value.replaceAll("'", "''")}'`)
            .join(",")})`,
        );
        enums.add(definition.enumName);
      }
    }
    await pg.exec(
      `CREATE TABLE ${quote(config.name)} (${config.columns
        .map((column) => `${quote(column.name)} ${column.getSQLType()}`)
        .join(",")})`,
    );
  }
});
beforeEach(async () => {
  statusCalls.length = 0;
  missingGrant = false;
  await pg.exec("TRUNCATE users, organizations");
  await pg.query(
    "INSERT INTO organizations (id,is_active,account_lifecycle_state) VALUES ($1,true,'active')",
    [ORG],
  );
  await pg.query(
    "INSERT INTO users (id,organization_id,is_active,preferences) VALUES ($1,$2,true,'{}')",
    [OWNER, ORG],
  );
});
afterAll(async () => {
  mock.module("@elizaos/cloud-shared/db/client", () => originalDb);
  mock.module("@elizaos/cloud-shared/auth", () => originalAuth);
  mock.module(
    "@elizaos/cloud-shared/lib/services/agent-google-connector",
    () => originalGoogle,
  );
  await pg.close();
});

test("personal status reads current selected owner consent without a legacy grant or caller override", async () => {
  const absent = await app.request(`/?purpose=${purpose}`);
  expect(await absent.json()).toEqual({
    purpose,
    selectedConnectionId: null,
    status: null,
  });
  expect(statusCalls).toHaveLength(0);
  await pg.query("UPDATE users SET preferences=$1 WHERE id=$2", [
    JSON.stringify({ personalGoogleContext: selected }),
    OWNER,
  ]);
  const response = await app.request(`/?side=owner&purpose=${purpose}`);
  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(await response.json()).toMatchObject({
    purpose,
    selectedConnectionId: GRANT,
    status: { connectionId: GRANT },
  });
  expect(statusCalls).toEqual([
    { organizationId: ORG, userId: OWNER, side: "owner", grantId: GRANT },
  ]);
  for (const query of [
    `purpose=${purpose}&side=agent`,
    `purpose=${purpose}&grantId=caller-selected`,
    "purpose=unknown",
  ]) {
    expect((await app.request(`/?${query}`)).status).toBe(400);
  }
  expect(statusCalls).toHaveLength(1);
});

test("inactive owner or organization denies reads; a missing exact grant never selects a fallback", async () => {
  await pg.query("UPDATE users SET preferences=$1 WHERE id=$2", [
    JSON.stringify({ personalGoogleContext: selected }),
    OWNER,
  ]);
  missingGrant = true;
  const missing = await app.request(`/?purpose=${purpose}`);
  expect(missing.status).toBe(200);
  expect(await missing.json()).toEqual({
    purpose,
    selectedConnectionId: GRANT,
    status: null,
  });
  await pg.query("UPDATE users SET organization_id=$1 WHERE id=$2", [
    "33333333-3333-4333-8333-333333333333",
    OWNER,
  ]);
  expect((await app.request(`/?purpose=${purpose}`)).status).toBe(403);
  await pg.query("UPDATE users SET organization_id=$1 WHERE id=$2", [
    ORG,
    OWNER,
  ]);
  await pg.query("UPDATE users SET is_active=false WHERE id=$1", [OWNER]);
  expect((await app.request(`/?purpose=${purpose}`)).status).toBe(403);
  await pg.query("UPDATE users SET is_active=true WHERE id=$1", [OWNER]);
  await pg.query("UPDATE organizations SET is_active=false WHERE id=$1", [ORG]);
  expect((await app.request(`/?purpose=${purpose}`)).status).toBe(403);
  expect(statusCalls).toHaveLength(1);
});
