/**
 * Real generic adapter and refresh flow on PGlite: a provider that refuses the
 * refresh grant marks the connection expired, so status reads needs-reconnect.
 * A transient refresh failure leaves it active. Token endpoint and secret store
 * are synthetic.
 */
import { afterAll, beforeAll, beforeEach, expect, mock, test } from "bun:test";
import { PGlite } from "@electric-sql/pglite";
import { getTableConfig } from "drizzle-orm/pg-core";
import { drizzle } from "drizzle-orm/pglite";
import * as actualDb from "../../../../db/client";
import { platformCredentials } from "../../../../db/schemas/platform-credentials";
import * as actualSecrets from "../../secrets";
import * as actualVersion from "../cache-version";
import * as actualRegistry from "../provider-registry";

const ORG = "11111111-1111-4111-8111-111111111111";
const CONNECTION = "22222222-2222-4222-8222-222222222222";
const pg = new PGlite();
const database = drizzle(pg);
const originals = {
  db: { ...actualDb },
  secrets: { ...actualSecrets },
  version: { ...actualVersion },
  registry: { ...actualRegistry },
};
const savedFetch = globalThis.fetch;
let tokenResponse: Response;

mock.module("../../../../db/client", () => ({
  ...originals.db,
  dbRead: database,
  dbWrite: database,
}));
mock.module("../../secrets", () => ({
  ...originals.secrets,
  secretsService: {
    ...originals.secrets.secretsService,
    getDecryptedValue: async () => "stored-token",
    rotate: async () => {},
  },
}));
mock.module("../cache-version", () => ({
  ...originals.version,
  incrementOAuthVersion: async () => {},
}));
mock.module("../provider-registry", () => ({
  ...originals.registry,
  getProvider: () => ({
    id: "google",
    useGenericRoutes: true,
    endpoints: {
      authorization: "https://fixture.example.test/auth",
      token: "https://fixture.example.test/token",
    },
  }),
  getClientId: () => "synthetic-client",
  getClientSecret: () => "synthetic-secret",
}));

const { createGenericAdapter } = await import("./generic-adapter");
const adapter = createGenericAdapter("google");
const quote = (value: string) => `"${value.replaceAll('"', '""')}"`;

beforeAll(async () => {
  const config = getTableConfig(platformCredentials);
  for (const column of config.columns) {
    const definition = (column as unknown as { enum?: { enumName: string; enumValues: string[] } })
      .enum;
    if (definition) {
      await pg.exec(
        `CREATE TYPE ${quote(definition.enumName)} AS ENUM (${definition.enumValues.map((v) => `'${v}'`).join(",")})`,
      );
    }
  }
  await pg.exec(
    `CREATE TABLE ${quote(config.name)} (${config.columns
      .map((column) => `${quote(column.name)} ${column.getSQLType()}`)
      .join(",")})`,
  );
  globalThis.fetch = (async () => tokenResponse.clone()) as unknown as typeof fetch;
});

afterAll(() => {
  globalThis.fetch = savedFetch;
});

beforeEach(async () => {
  await pg.exec("TRUNCATE platform_credentials");
  await pg.query(
    `INSERT INTO platform_credentials
       (id, organization_id, platform, platform_user_id, status,
        access_token_secret_id, refresh_token_secret_id, token_expires_at)
     VALUES ($1, $2, 'google', 'google-user', 'active', gen_random_uuid(), gen_random_uuid(),
             now() - interval '1 hour')`,
    [CONNECTION, ORG],
  );
});

async function status(): Promise<string> {
  const rows = await pg.query<{ status: string }>(
    "SELECT status FROM platform_credentials WHERE id=$1",
    [CONNECTION],
  );
  return rows.rows[0]?.status ?? "missing";
}

test("a refused refresh grant marks the connection expired", async () => {
  tokenResponse = new Response(
    JSON.stringify({
      error: "invalid_grant",
      error_description: "Token has been expired or revoked.",
    }),
    { status: 400, headers: { "Content-Type": "application/json" } },
  );
  await expect(adapter.getToken(ORG, CONNECTION)).rejects.toMatchObject({
    code: "CONNECTION_EXPIRED",
    reconnectRequired: true,
  });
  expect(await status()).toBe("expired");
  const [connection] = await adapter.listConnections(ORG);
  expect(connection?.status).toBe("expired");
});

test("a transient refresh failure leaves the connection active", async () => {
  tokenResponse = new Response("upstream unavailable", { status: 503 });
  await expect(adapter.getToken(ORG, CONNECTION)).rejects.toMatchObject({
    code: "TOKEN_REFRESH_FAILED",
  });
  expect(await status()).toBe("active");
});
