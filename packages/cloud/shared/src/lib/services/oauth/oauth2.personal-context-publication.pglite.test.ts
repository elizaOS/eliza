/** Actual primary Drizzle transactions; HTTP/cache/secret-store boundaries are synthetic. */
import { afterAll, beforeAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { PGlite } from "@electric-sql/pglite";
import { getTableConfig } from "drizzle-orm/pg-core";
import { drizzle } from "drizzle-orm/pglite";
import * as actualDb from "../../../db/client";
import * as actualSecretRepo from "../../../db/repositories/secrets";
import { organizations } from "../../../db/schemas/organizations";
import { platformCredentials } from "../../../db/schemas/platform-credentials";
import { users } from "../../../db/schemas/users";
import * as actualCache from "../../cache/client";
import * as actualBindings from "../../runtime/cloud-bindings";
import * as actualSecrets from "../secrets";
import { googlePersonalContextConsent } from "../shared-runtime/shared-google-consent";
import * as actualUsers from "../users";
import * as actualRegistry from "./provider-registry";

const ORG = "11111111-1111-4111-8111-111111111111";
const OWNER = "22222222-2222-4222-8222-222222222222";
const OLD_GRANT = "33333333-3333-4333-8333-333333333333";
const OLD_ACCESS = "44444444-4444-4444-8444-444444444444";
const OLD_REFRESH = "55555555-5555-4555-8555-555555555555";
const scopes = [
  "https://www.googleapis.com/auth/gmail.readonly",
  "https://www.googleapis.com/auth/calendar.readonly",
];
const pg = new PGlite();
const database = drizzle(pg);
const originals = {
  db: { ...actualDb },
  cache: { ...actualCache },
  bindings: { ...actualBindings },
  secrets: { ...actualSecrets },
  secretRepo: { ...actualSecretRepo },
  users: { ...actualUsers },
  registry: { ...actualRegistry },
};
const savedFetch = globalThis.fetch;
type StoredSecret = { id: string; name: string; description: string | null; value: string };
const secretRows = new Map<string, StoredSecret>();
let state: Record<string, unknown> | null;
let disableAt: "never" | "userinfo" | "secret" = "never";
let creationAuditFailure = false;
let cleanupFailure = false;
let commitAckFailure = false;
let rotated = 0;
let deleted = 0;
mock.module("../../../db/client", () => ({ ...originals.db, dbRead: database, dbWrite: database }));
mock.module("../../cache/client", () => ({
  ...originals.cache,
  cache: {
    get: async () => state,
    del: async () => {
      state = null;
    },
    set: async () => {},
  },
}));
mock.module("../../runtime/cloud-bindings", () => ({
  ...originals.bindings,
  getCloudAwareEnv: () => ({ NEXT_PUBLIC_APP_URL: "https://fixture.example.test" }),
}));
mock.module("./provider-registry", () => ({
  ...originals.registry,
  getClientId: () => "synthetic-client",
  getClientSecret: () => "synthetic-secret",
  getCallbackUrl: () => "https://fixture.example.test/callback",
  resolveRequestedScopes: () => scopes,
}));
mock.module("../users", () => ({
  ...originals.users,
  usersService: {
    ...originals.users.usersService,
    invalidateCache: async () => {},
  },
}));
mock.module("../../../db/repositories/secrets", () => ({
  ...originals.secretRepo,
  secretsRepository: {
    ...originals.secretRepo.secretsRepository,
    findByName: async (_org: string, name: string) =>
      [...secretRows.values()].find((row) => row.name === name),
  },
}));
mock.module("../secrets", () => ({
  ...originals.secrets,
  secretsService: {
    ...originals.secrets.secretsService,
    create: async (args: { name: string; description?: string; value: string }) => {
      const row = {
        id: crypto.randomUUID(),
        name: args.name,
        description: args.description ?? null,
        value: args.value,
      };
      secretRows.set(row.id, row);
      if (disableAt === "secret")
        await pg.query("UPDATE users SET is_active=false WHERE id=$1", [OWNER]);
      if (creationAuditFailure) throw new Error("Synthetic post-persistence audit failure");
      return row;
    },
    rotate: async () => {
      rotated += 1;
      throw new Error("Personal flow must not rotate preexisting secrets");
    },
    delete: async (id: string) => {
      if (cleanupFailure) throw new Error("Synthetic cleanup unavailable");
      if (id === OLD_ACCESS || id === OLD_REFRESH)
        throw new Error("Legacy secret deletion forbidden");
      secretRows.delete(id);
      deleted += 1;
    },
  },
}));
const actualHelpers = await import("../../../db/helpers");
const originalWriteTransaction = actualHelpers.writeTransaction;
mock.module("../../../db/helpers", () => ({
  ...actualHelpers,
  writeTransaction: async (fn: Parameters<typeof originalWriteTransaction>[0]) => {
    const result = await originalWriteTransaction(fn);
    if (commitAckFailure) throw new Error("Synthetic acknowledgement lost after real commit");
    return result;
  },
}));
const { handleOAuth2Callback } = await import("./oauth2");
const provider = {
  id: "google",
  pkce: false,
  endpoints: {
    authorization: "https://fixture.example.test/auth",
    token: "https://fixture.example.test/token",
    userInfo: "https://fixture.example.test/userinfo",
  },
} as Parameters<typeof handleOAuth2Callback>[0];
const quote = (value: string) => `"${value.replaceAll('"', '""')}"`;
beforeAll(async () => {
  const seen = new Set<string>();
  for (const table of [organizations, users, platformCredentials]) {
    const config = getTableConfig(table);
    for (const column of config.columns) {
      const definition = (
        column as unknown as { enum?: { enumName: string; enumValues: string[] } }
      ).enum;
      if (definition && !seen.has(definition.enumName)) {
        await pg.exec(
          `CREATE TYPE ${quote(definition.enumName)} AS ENUM (${definition.enumValues.map((v) => `'${v.replaceAll("'", "''")}'`).join(",")})`,
        );
        seen.add(definition.enumName);
      }
    }
    await pg.exec(
      `CREATE TABLE ${quote(config.name)} (${config.columns
        .map(
          (column) =>
            `${quote(column.name)} ${column.getSQLType()}${column.name === "id" ? " PRIMARY KEY DEFAULT gen_random_uuid()" : ""}`,
        )
        .join(",")})`,
    );
  }
  await pg.exec(
    "CREATE UNIQUE INDEX callback_grant_identity ON platform_credentials (organization_id,platform,platform_user_id)",
  );
});
beforeEach(async () => {
  await pg.exec("TRUNCATE platform_credentials, users, organizations");
  await pg.query(
    "INSERT INTO organizations (id,is_active,account_lifecycle_state) VALUES ($1,true,'active')",
    [ORG],
  );
  await pg.query(
    "INSERT INTO users (id,organization_id,is_active,preferences) VALUES ($1,$2,true,$3)",
    [OWNER, ORG, JSON.stringify({ theme: "dark" })],
  );
  disableAt = "never";
  creationAuditFailure = false;
  cleanupFailure = false;
  commitAckFailure = false;
  rotated = 0;
  deleted = 0;
  secretRows.clear();
  state = {
    organizationId: ORG,
    userId: OWNER,
    providerId: "google",
    connectionRole: "OWNER",
    scopes,
    redirectUrl: "/cloud/connectors",
    createdAt: Date.now(),
    personalGoogleContext: googlePersonalContextConsent(),
  };
  globalThis.fetch = mock(async (input: unknown) => {
    const url = String(input);
    if (url === provider.endpoints?.token)
      return Response.json({
        access_token: "synthetic-access",
        refresh_token: "synthetic-refresh",
        scope: scopes.join(" "),
      });
    if (url === provider.endpoints?.userInfo) {
      if (disableAt === "userinfo")
        await pg.query("UPDATE organizations SET account_deletion_request_id=$1 WHERE id=$2", [
          OLD_GRANT,
          ORG,
        ]);
      return Response.json({ id: "synthetic-google-account", email: "owner@example.test" });
    }
    throw new Error("Unexpected network in publication fixture");
  }) as typeof fetch;
});
afterAll(async () => {
  globalThis.fetch = savedFetch;
  mock.module("../../../db/helpers", () => ({
    ...actualHelpers,
    writeTransaction: originalWriteTransaction,
  }));
  mock.module("../../../db/client", () => originals.db);
  mock.module("../../cache/client", () => originals.cache);
  mock.module("../../runtime/cloud-bindings", () => originals.bindings);
  mock.module("./provider-registry", () => originals.registry);
  mock.module("../users", () => originals.users);
  mock.module("../secrets", () => originals.secrets);
  mock.module("../../../db/repositories/secrets", () => originals.secretRepo);
  await pg.close();
});
const callback = () => handleOAuth2Callback(provider, "synthetic-code", "synthetic-state");
async function snapshot() {
  return {
    grants: (await pg.query("SELECT * FROM platform_credentials ORDER BY id")).rows,
    preferences: (
      await pg.query<{ preferences: string }>("SELECT preferences FROM users WHERE id=$1", [OWNER])
    ).rows[0]?.preferences,
  };
}
async function legacyGrant() {
  secretRows.set(OLD_ACCESS, {
    id: OLD_ACCESS,
    name: "legacy-access",
    description: "legacy",
    value: "old-access",
  });
  secretRows.set(OLD_REFRESH, {
    id: OLD_REFRESH,
    name: "legacy-refresh",
    description: "legacy",
    value: "old-refresh",
  });
  await pg.query(
    "INSERT INTO platform_credentials (id,organization_id,user_id,platform,platform_user_id,status,access_token_secret_id,refresh_token_secret_id,scopes,source_context) VALUES ($1,$2,$3,'google','synthetic-google-account','active',$4,$5,$6::jsonb,$7::jsonb)",
    [
      OLD_GRANT,
      ORG,
      OWNER,
      OLD_ACCESS,
      OLD_REFRESH,
      JSON.stringify(["openid"]),
      JSON.stringify({ connectionRole: "OWNER", legacyMarker: true }),
    ],
  );
}

describe("personal OAuth grant publication", () => {
  test("valid callback commits the exact grant and selected consent together", async () => {
    const result = await callback();
    const after = await snapshot();
    expect(after.grants).toHaveLength(1);
    expect(JSON.parse(after.preferences ?? "{}").personalGoogleContext.grantId).toBe(
      result.connectionId,
    );
    expect(secretRows.size).toBe(2);
    expect(rotated).toBe(0);
  });
  test("owner lifecycle changed during userinfo publishes no active grant or consent and cleans staged secrets", async () => {
    disableAt = "userinfo";
    await expect(callback()).rejects.toThrow("GOOGLE_PERSONAL_CONTEXT_OWNER_CHANGED");
    expect((await snapshot()).grants).toHaveLength(0);
    expect(JSON.parse((await snapshot()).preferences ?? "{}")).toEqual({ theme: "dark" });
    expect(secretRows.size).toBe(0);
    expect(deleted).toBe(2);
  });
  test("lifecycle changed while staging preserves the complete legacy row, secret values and preferences", async () => {
    await legacyGrant();
    const before = await snapshot();
    disableAt = "secret";
    await expect(callback()).rejects.toThrow("GOOGLE_PERSONAL_CONTEXT_OWNER_CHANGED");
    expect(await snapshot()).toEqual(before);
    expect([...secretRows.values()].map(({ id, value }) => ({ id, value }))).toEqual([
      { id: OLD_ACCESS, value: "old-access" },
      { id: OLD_REFRESH, value: "old-refresh" },
    ]);
    expect(rotated).toBe(0);
  });
  test("consent publication failure rolls back an already-upserted legacy grant", async () => {
    await legacyGrant();
    await pg.query("UPDATE users SET preferences='[]' WHERE id=$1", [OWNER]);
    const before = await snapshot();
    await expect(callback()).rejects.toThrow("GOOGLE_PERSONAL_CONTEXT_OWNER_OR_GRANT_CHANGED");
    expect(await snapshot()).toEqual(before);
    expect(secretRows.size).toBe(2);
    expect(deleted).toBe(2);
    expect(rotated).toBe(0);
  });
  test("uncertain commit acknowledgement retains potentially published credentials for reconciliation", async () => {
    commitAckFailure = true;
    await expect(callback()).rejects.toThrow(
      "GOOGLE_PERSONAL_CONTEXT_PUBLICATION_OUTCOME_UNCONFIRMED",
    );
    const after = await snapshot();
    expect(after.grants).toHaveLength(1);
    expect(JSON.parse(after.preferences ?? "{}").personalGoogleContext).toBeDefined();
    expect(secretRows.size).toBe(2);
    expect(deleted).toBe(0);
  });
  test("post-persistence secret creation failure cleans only its tagged new row", async () => {
    await legacyGrant();
    const before = await snapshot();
    creationAuditFailure = true;
    await expect(callback()).rejects.toThrow("post-persistence audit failure");
    expect(await snapshot()).toEqual(before);
    expect(secretRows.size).toBe(2);
    expect(deleted).toBe(1);
    expect(rotated).toBe(0);
  });
  test("cleanup failure remains explicit while legacy publication is unchanged", async () => {
    await legacyGrant();
    const before = await snapshot();
    disableAt = "secret";
    cleanupFailure = true;
    await expect(callback()).rejects.toThrow("GOOGLE_PERSONAL_CONTEXT_SECRET_CLEANUP_INCOMPLETE");
    expect(await snapshot()).toEqual(before);
    expect(secretRows.get(OLD_ACCESS)?.value).toBe("old-access");
    expect(secretRows.get(OLD_REFRESH)?.value).toBe("old-refresh");
    expect(secretRows.size).toBe(4);
    expect(rotated).toBe(0);
  });
});
