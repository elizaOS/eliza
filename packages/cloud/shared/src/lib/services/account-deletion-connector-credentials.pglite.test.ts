/**
 * connector_credentials erasure through the real OAuth service and generic
 * adapter on PGlite. The secret store and the token cache are in-memory
 * boundaries; credential rows and Google consent use real SQL.
 */
import { afterAll, beforeAll, beforeEach, expect, mock, setDefaultTimeout, test } from "bun:test";

process.env.DATABASE_URL = "pglite://memory";
process.env.NODE_ENV ||= "test";
setDefaultTimeout(60_000);

import { getTableConfig } from "drizzle-orm/pg-core";
import * as actualSecretRepo from "../../db/repositories/secrets";
import { organizations } from "../../db/schemas/organizations";
import { platformCredentials } from "../../db/schemas/platform-credentials";
import { secrets as secretsTable } from "../../db/schemas/secrets";
import { users } from "../../db/schemas/users";
import * as actualCache from "../cache/client";
import * as actualSecrets from "./secrets";
import * as actualUsers from "./users";

const ORG = "11111111-1111-4111-8111-111111111111";
const OTHER_ORG = "11111111-1111-4111-8111-222222222222";
const OWNER = "22222222-2222-4222-8222-222222222222";
const ACTIVE_GOOGLE = "33333333-3333-4333-8333-333333333331";
const REVOKED_LINEAR = "33333333-3333-4333-8333-333333333332";
const DISCORD = "33333333-3333-4333-8333-333333333333";
const FOREIGN = "33333333-3333-4333-8333-333333333334";

const secrets = new Map<string, string>();
let failingSecret: string | null = null;
const cacheVersions = new Map<string, number>();

mock.module("../cache/client", () => ({
  ...actualCache,
  cache: {
    ...actualCache.cache,
    isAvailable: () => true,
    get: async () => null,
    set: async () => {},
    del: async () => {},
    incr: async (key: string) => {
      const next = (cacheVersions.get(key) ?? 0) + 1;
      cacheVersions.set(key, next);
      return next;
    },
    expire: async () => {},
  },
}));
mock.module("./users", () => ({
  ...actualUsers,
  usersService: { ...actualUsers.usersService, invalidateCache: async () => {} },
}));
mock.module("../../db/repositories/secrets", () => ({
  ...actualSecretRepo,
  secretsRepository: {
    ...actualSecretRepo.secretsRepository,
    findById: async (id: string) => {
      const organizationId = secrets.get(id);
      return organizationId ? { id, organization_id: organizationId } : undefined;
    },
  },
}));
mock.module("./secrets", () => ({
  ...actualSecrets,
  secretsService: {
    ...actualSecrets.secretsService,
    delete: async (id: string, organizationId: string) => {
      if (id === failingSecret) throw new Error("Synthetic secret store outage");
      if (secrets.get(id) !== organizationId) throw new Error("Secret not found");
      secrets.delete(id);
    },
  },
}));

const { closeDatabaseConnectionsForTests, getPgliteClientForTests } = await import(
  "../../db/client"
);
const { createAccountDeletionProviderAdapters } = await import(
  "./account-deletion-provider-adapters"
);
type Context = import("./account-deletion-saga").AccountDeletionProviderContext;

const context = {
  requestId: "50000000-0000-4000-8000-000000000001",
  requestDigest: "a".repeat(64),
  userId: OWNER,
  organizationId: ORG,
  stewardUserId: "steward-personal",
  lifecycleRevision: 2,
  phaseReceiptId: "60000000-0000-4000-8000-000000000001",
  phaseGeneration: 1,
  blob: {},
} as Context;

const quote = (value: string) => `"${value.replaceAll('"', '""')}"`;
const pg = () => getPgliteClientForTests();

beforeAll(async () => {
  const seen = new Set<string>();
  // Secrets-stored platforms (Twitter, Twilio, Blooio) list from an empty table.
  for (const table of [organizations, users, platformCredentials, secretsTable]) {
    const config = getTableConfig(table);
    for (const column of config.columns) {
      const definition = (
        column as unknown as { enum?: { enumName: string; enumValues: string[] } }
      ).enum;
      if (definition && !seen.has(definition.enumName)) {
        await pg().exec(
          `CREATE TYPE ${quote(definition.enumName)} AS ENUM (${definition.enumValues.map((v) => `'${v.replaceAll("'", "''")}'`).join(",")})`,
        );
        seen.add(definition.enumName);
      }
    }
    await pg().exec(
      `CREATE TABLE ${quote(config.name)} (${config.columns
        .map(
          (column) =>
            `${quote(column.name)} ${column.getSQLType()}${column.name === "id" ? " PRIMARY KEY DEFAULT gen_random_uuid()" : ""}`,
        )
        .join(",")})`,
    );
  }
});

beforeEach(async () => {
  await pg().exec("TRUNCATE platform_credentials, users, organizations");
  secrets.clear();
  failingSecret = null;
  await pg().query("INSERT INTO organizations (id) VALUES ($1), ($2)", [ORG, OTHER_ORG]);
  await pg().query("INSERT INTO users (id, organization_id, preferences) VALUES ($1, $2, $3)", [
    OWNER,
    ORG,
    JSON.stringify({ personalGoogleContext: { grantId: ACTIVE_GOOGLE } }),
  ]);
  const rows: Array<[string, string, string, string, string[]]> = [
    [ACTIVE_GOOGLE, ORG, "google", "active", ["access-google", "refresh-google"]],
    [REVOKED_LINEAR, ORG, "linear", "revoked", ["access-linear"]],
    [DISCORD, ORG, "discord", "active", ["api-discord"]],
    [FOREIGN, OTHER_ORG, "google", "active", ["access-foreign"]],
  ];
  for (const [id, organizationId, platform, status, secretNames] of rows) {
    const secretIds = secretNames.map(() => crypto.randomUUID());
    for (const secretId of secretIds) secrets.set(secretId, organizationId);
    const apiKey = platform === "discord";
    await pg().query(
      `INSERT INTO platform_credentials
        (id, organization_id, user_id, platform, platform_user_id, status,
         access_token_secret_id, refresh_token_secret_id, api_key_secret_id, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, now(), now())`,
      [
        id,
        organizationId,
        organizationId === ORG ? OWNER : null,
        platform,
        `${platform}-user`,
        status,
        apiKey ? null : (secretIds[0] ?? null),
        apiKey ? null : (secretIds[1] ?? null),
        apiKey ? secretIds[0] : null,
      ],
    );
  }
});

afterAll(async () => {
  await closeDatabaseConnectionsForTests();
});

async function credentialIds(): Promise<string[]> {
  const result = await pg().query<{ id: string }>(
    "SELECT id FROM platform_credentials ORDER BY id",
  );
  return result.rows.map((row) => row.id);
}

function orgSecrets(organizationId: string): string[] {
  return [...secrets].filter(([, owner]) => owner === organizationId).map(([id]) => id);
}

test("revokes, deletes secrets and removes every credential row, then inspects complete", async () => {
  const adapter = createAccountDeletionProviderAdapters().connector_credentials;
  expect((await adapter.inspect(context)).state).toBe("needs_execution");

  await adapter.execute(context, "idempotency");

  expect(await credentialIds()).toEqual([FOREIGN]);
  expect(orgSecrets(ORG)).toEqual([]);
  expect(orgSecrets(OTHER_ORG)).toHaveLength(1);
  // The Google revoke ran before the row was removed: consent is cleared and
  // the token cache version moved for Google only.
  const owner = await pg().query<{ preferences: string }>(
    "SELECT preferences FROM users WHERE id=$1",
    [OWNER],
  );
  expect(JSON.parse(owner.rows[0]?.preferences ?? "{}")).toEqual({});
  expect([...cacheVersions.keys()]).toEqual([`oauth:version:${ORG}:google`]);
  expect((await adapter.inspect(context)).state).toBe("complete");
});

test("a failing secret delete keeps the row and the phase incomplete until it recovers", async () => {
  const adapter = createAccountDeletionProviderAdapters().connector_credentials;
  const [apiKey] = (
    await pg().query<{ api_key_secret_id: string }>(
      "SELECT api_key_secret_id FROM platform_credentials WHERE id=$1",
      [DISCORD],
    )
  ).rows;
  failingSecret = apiKey?.api_key_secret_id ?? null;

  await expect(adapter.execute(context, "idempotency")).rejects.toThrow(
    "Connector secret could not be deleted",
  );
  expect(await credentialIds()).toContain(DISCORD);
  expect((await adapter.inspect(context)).state).toBe("needs_execution");

  failingSecret = null;
  await adapter.execute(context, "idempotency");
  expect(await credentialIds()).toEqual([FOREIGN]);
  expect(orgSecrets(ORG)).toEqual([]);
  expect((await adapter.inspect(context)).state).toBe("complete");
});
