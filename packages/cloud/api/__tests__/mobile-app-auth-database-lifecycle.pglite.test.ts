/**
 * End-to-end integration test proving the entire database-backed mobile App Auth lifecycle (#39257).
 *
 * Covers a database-only client (with ZERO environment configuration):
 * 1. Asset Links HTTP route (/.well-known/assetlinks.json)
 * 2. Mobile Config HTTP route (/api/v1/app-auth/mobile/config)
 * 3. User sign-in authorization code issuance
 * 4. Token exchange HTTP route (/api/v1/app-auth/mobile/token -> inactive credential)
 * 5. Token acknowledgement HTTP route (/api/v1/app-auth/mobile/ack -> active credential)
 * 6. Credential authority resolution from database
 * 7. Renewal HTTP route (/api/v1/app-auth/mobile/renew -> renewal authorization code)
 * 8. Renewal token exchange & acknowledgement -> renewed credential issuance and activation
 * 9. Deactivation fail-closed enforcement across routes
 * 10. Database outage fail-closed error propagation
 */
import { afterAll, beforeAll, beforeEach, expect, mock, test } from "bun:test";
import { randomBytes, randomUUID } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";
import * as realDb from "@elizaos/cloud-shared/db/client";
import { apiKeys } from "@elizaos/cloud-shared/db/schemas/api-keys";
import { apps } from "@elizaos/cloud-shared/db/schemas/apps";
import { authEvents } from "@elizaos/cloud-shared/db/schemas/auth-events";
import { managedDomains } from "@elizaos/cloud-shared/db/schemas/managed-domains";
import { organizations } from "@elizaos/cloud-shared/db/schemas/organizations";
import { users } from "@elizaos/cloud-shared/db/schemas/users";
import { getTableConfig } from "drizzle-orm/pg-core";
import { drizzle } from "drizzle-orm/pglite";
import { mobileAppAuthClients } from "../../shared/src/db/schemas/mobile-app-auth-clients";
import { mobileAppAuthGrants } from "../../shared/src/db/schemas/mobile-app-auth-grants";

const USER_ID = "22222222-2222-4222-8222-222222222222";
const ORG_ID = "11111111-1111-4111-8111-111111111111";
const APP_ID = "44444444-4444-4444-8444-444444444444";
const DB_CLIENT_ID = "com.acme.portal";
const DB_REDIRECT_URI = "https://acme.portal/auth/callback";
const ANDROID_PKG = "com.acme.portal";
const ANDROID_FINGERPRINT =
  "AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99:AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99";

const pg = new PGlite();
const database = drizzle(pg, {
  schema: {
    apiKeys,
    apps,
    authEvents,
    managedDomains,
    mobileAppAuthClients,
    mobileAppAuthGrants,
    organizations,
    users,
  },
});
const originalDb = { ...realDb };
mock.module("@elizaos/cloud-shared/db/client", () => ({
  ...originalDb,
  dbWrite: database,
  dbRead: database,
}));

const {
  deriveMobileAppAuthS256Challenge,
  issueMobileAppAuthCode,
  resolveMobileCredentialRegistration,
} = await import("@elizaos/cloud-shared/lib/services/mobile-app-auth");
const { default: assetLinksApp } = await import(
  "../.well-known/assetlinks.json/route"
);
const { default: configApp } = await import(
  "../v1/app-auth/mobile/config/route"
);
const { default: tokenApp } = await import("../v1/app-auth/mobile/token/route");
const { default: ackApp } = await import("../v1/app-auth/mobile/ack/route");
const { default: renewApp } = await import("../v1/app-auth/mobile/renew/route");

function quote(identifier: string): string {
  return `"${identifier.replaceAll('"', '""')}"`;
}

function env(): Record<string, string | undefined> {
  return {
    ENVIRONMENT: "production",
    NODE_ENV: "test",
    ELIZA_MOBILE_APP_AUTH_ENABLED: "true",
    RATE_LIMIT_DISABLED: "true",
  };
}

import { readFileSync } from "node:fs";

const migration = [
  "0572_mobile_app_auth_session_start",
  "0573_mobile_app_auth_renewal_lineage",
]
  .map((tag) =>
    readFileSync(
      new URL(`../../shared/src/db/migrations/${tag}.sql`, import.meta.url),
      "utf8",
    ),
  )
  .join("\n");
const MIGRATED_COLUMNS = new Set([
  "session_started_at",
  "session_id",
  "renewed_from_credential_id",
]);

beforeAll(async () => {
  const enums = new Set<string>();
  for (const table of [
    organizations,
    users,
    apiKeys,
    apps,
    authEvents,
    managedDomains,
    mobileAppAuthGrants,
    mobileAppAuthClients,
  ]) {
    const config = getTableConfig(table);
    for (const column of config.columns) {
      const definition = (
        column as unknown as {
          enum?: { enumName: string; enumValues: string[] };
        }
      ).enum;
      if (definition && !enums.has(definition.enumName)) {
        await pg.exec(
          `CREATE TYPE ${quote(definition.enumName)} AS ENUM (${definition.enumValues.map((v) => `'${v.replaceAll("'", "''")}'`).join(",")})`,
        );
        enums.add(definition.enumName);
      }
    }
  }

  for (const table of [
    organizations,
    users,
    apiKeys,
    apps,
    authEvents,
    managedDomains,
    mobileAppAuthGrants,
    mobileAppAuthClients,
  ]) {
    const config = getTableConfig(table);
    await pg.exec(
      `CREATE TABLE ${quote(config.name)} (${config.columns
        .filter(
          (column) =>
            table !== mobileAppAuthGrants || !MIGRATED_COLUMNS.has(column.name),
        )
        .map(
          (c) =>
            `${quote(c.name)} ${c.getSQLType()}${c.primary ? " PRIMARY KEY" : ""}`,
        )
        .join(",")})`,
    );
  }
  await pg.exec(`
    ALTER TABLE mobile_app_auth_grants ALTER COLUMN id SET DEFAULT gen_random_uuid();
    ALTER TABLE mobile_app_auth_grants ALTER COLUMN created_at SET DEFAULT now();
    ALTER TABLE mobile_app_auth_grants ALTER COLUMN updated_at SET DEFAULT now();
  `);
  await pg.exec(migration);
});

beforeEach(async () => {
  await pg.exec(
    "TRUNCATE organizations, users, api_keys, apps, auth_events, mobile_app_auth_grants, mobile_app_auth_clients, managed_domains CASCADE",
  );

  await pg.query(
    "INSERT INTO organizations (id, name, is_active, account_lifecycle_state, created_at, updated_at) VALUES ($1, $2, true, 'active', now(), now())",
    [ORG_ID, "Acme Org"],
  );
  await pg.query(
    "INSERT INTO users (id, organization_id, email, role, is_active, created_at, updated_at) VALUES ($1, $2, $3, $4, true, now(), now())",
    [USER_ID, ORG_ID, "developer@acme.portal", "owner"],
  );
  await pg.query(
    `INSERT INTO apps (id, organization_id, name, slug, app_url, allowed_origins, is_active, is_approved, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, true, true, now(), now())`,
    [
      APP_ID,
      ORG_ID,
      "Acme App",
      "acme-app",
      "https://acme.portal",
      JSON.stringify(["https://acme.portal/auth/callback"]),
    ],
  );

  // Seed the client in the database ONLY (zero environment variable configuration)
  await pg.query(
    `INSERT INTO mobile_app_auth_clients (
      client_id, app_id, redirect_uri, android_package_name, android_cert_fingerprints, credential_ttl_seconds, enabled, created_at, updated_at
    ) VALUES ($1, $2, $3, $4, $5, $6, true, now(), now())`,
    [
      DB_CLIENT_ID,
      APP_ID,
      DB_REDIRECT_URI,
      ANDROID_PKG,
      JSON.stringify([ANDROID_FINGERPRINT]),
      2592000,
    ],
  );
});

afterAll(async () => {
  await pg.close();
});

test("E2E database-only client lifecycle: asset links -> signin -> exchange -> ack -> verify -> renew -> revoke", async () => {
  // 1. Asset Links HTTP Route: Serves statements dynamically from DB rows without env vars
  const assetLinksRes = await assetLinksApp.request("/", {}, env() as never);
  expect(assetLinksRes.status).toBe(200);
  const assetLinks = await assetLinksRes.json();
  expect(assetLinks).toEqual([
    {
      relation: ["delegate_permission/common.handle_all_urls"],
      target: {
        namespace: "android_app",
        package_name: ANDROID_PKG,
        sha256_cert_fingerprints: [ANDROID_FINGERPRINT],
      },
    },
  ]);

  // 2. Mobile Config HTTP Route: Resolves public metadata strictly from DB without env vars
  const configRes = await configApp.request(
    `/?clientId=${DB_CLIENT_ID}&environment=production&redirectUri=${encodeURIComponent(DB_REDIRECT_URI)}`,
    {},
    env() as never,
  );
  expect(configRes.status).toBe(200);
  const config = await configRes.json();
  expect(config.success).toBe(true);
  expect(config.clientId).toBe(DB_CLIENT_ID);
  expect(config.redirectUri).toBe(DB_REDIRECT_URI);
  expect(config.app.name).toBe("Acme App");

  // 3. User Sign-In Authorization Code Issuance
  const codeVerifier = randomBytes(32).toString("base64url");
  const codeChallenge = deriveMobileAppAuthS256Challenge(codeVerifier);
  const state = randomBytes(32).toString("base64url");

  const issued = await issueMobileAppAuthCode({
    registration: {
      appId: APP_ID,
      clientId: DB_CLIENT_ID,
      environment: "production",
      redirectUri: DB_REDIRECT_URI,
      scopes: ["cloud:user"],
      credentialTtlSeconds: 2592000,
    },
    userId: USER_ID,
    organizationId: ORG_ID,
    binding: {
      clientId: DB_CLIENT_ID,
      codeChallenge,
      codeChallengeMethod: "S256",
      environment: "production",
      redirectUri: DB_REDIRECT_URI,
      state,
    },
  });
  const code = issued.code;
  expect(code.startsWith("emac_")).toBe(true);

  // 4. Token Exchange HTTP Route: Mints inactive credential via public route
  const tokenRes = await tokenApp.request(
    "/",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        grantType: "authorization_code",
        clientId: DB_CLIENT_ID,
        environment: "production",
        redirectUri: DB_REDIRECT_URI,
        state,
        code,
        codeVerifier,
      }),
    },
    env() as never,
  );
  expect(tokenRes.status).toBe(200);
  const tokenBody = await tokenRes.json();
  expect(tokenBody.success).toBe(true);
  expect(tokenBody.acknowledgementRequired).toBe(true);
  expect(tokenBody.tokenType).toBe("Bearer");
  const { credentialId, secret } = tokenBody;
  expect(typeof credentialId).toBe("string");
  expect(typeof secret).toBe("string");
  expect(secret.startsWith("eliza_mobile_")).toBe(true);

  // 5. Token Acknowledgement HTTP Route: Activates credential via public route
  const ackRes = await ackApp.request(
    "/",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        clientId: DB_CLIENT_ID,
        environment: "production",
        redirectUri: DB_REDIRECT_URI,
        state,
        code,
        codeVerifier,
        credentialId,
        secret,
      }),
    },
    env() as never,
  );
  expect(ackRes.status).toBe(200);
  const ackBody = await ackRes.json();
  expect(ackBody.success).toBe(true);
  expect(ackBody.status).toBe("acknowledged");
  expect(ackBody.credentialId).toBe(credentialId);

  // 6. Credential Resolution: Resolves client authority from database for active key
  const registration = await resolveMobileCredentialRegistration(
    env() as never,
    {
      id: credentialId,
      user_id: USER_ID,
      organization_id: ORG_ID,
      source_app_id: APP_ID,
    },
  );
  expect(registration.clientId).toBe(DB_CLIENT_ID);
  expect(registration.appId).toBe(APP_ID);
  expect(registration.redirectUri).toBe(DB_REDIRECT_URI);

  // 7. Renewal HTTP Route: Caller presents active key to mint renewal code via public route
  const renewalVerifier = randomBytes(32).toString("base64url");
  const renewalChallenge = deriveMobileAppAuthS256Challenge(renewalVerifier);
  const renewalState = randomBytes(32).toString("base64url");

  const renewRes = await renewApp.request(
    "/",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${secret}`,
      },
      body: JSON.stringify({
        clientId: DB_CLIENT_ID,
        environment: "production",
        redirectUri: DB_REDIRECT_URI,
        state: renewalState,
        codeChallenge: renewalChallenge,
        codeChallengeMethod: "S256",
      }),
    },
    env() as never,
  );
  expect(renewRes.status).toBe(200);
  const renewBody = await renewRes.json();
  expect(renewBody.success).toBe(true);
  const renewalCode = renewBody.code;
  expect(renewalCode.startsWith("emac_")).toBe(true);

  // 8. Renewal Token Exchange & Acknowledgement: Issues and activates successor credential
  const renewTokenRes = await tokenApp.request(
    "/",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        grantType: "authorization_code",
        clientId: DB_CLIENT_ID,
        environment: "production",
        redirectUri: DB_REDIRECT_URI,
        state: renewalState,
        code: renewalCode,
        codeVerifier: renewalVerifier,
      }),
    },
    env() as never,
  );
  expect(renewTokenRes.status).toBe(200);
  const renewTokenBody = await renewTokenRes.json();
  expect(renewTokenBody.success).toBe(true);
  const renewedCredentialId = renewTokenBody.credentialId;
  const renewedSecret = renewTokenBody.secret;
  expect(typeof renewedCredentialId).toBe("string");
  expect(typeof renewedSecret).toBe("string");
  expect(renewedSecret.startsWith("eliza_mobile_")).toBe(true);

  const renewAckRes = await ackApp.request(
    "/",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        clientId: DB_CLIENT_ID,
        environment: "production",
        redirectUri: DB_REDIRECT_URI,
        state: renewalState,
        code: renewalCode,
        codeVerifier: renewalVerifier,
        credentialId: renewedCredentialId,
        secret: renewedSecret,
      }),
    },
    env() as never,
  );
  expect(renewAckRes.status).toBe(200);
  const renewAckBody = await renewAckRes.json();
  expect(renewAckBody.success).toBe(true);
  expect(renewAckBody.status).toBe("acknowledged");
  expect(renewAckBody.credentialId).toBe(renewedCredentialId);

  // Verify renewed successor credential resolves authority from database
  const renewedRegistration = await resolveMobileCredentialRegistration(
    env() as never,
    {
      id: renewedCredentialId,
      user_id: USER_ID,
      organization_id: ORG_ID,
      source_app_id: APP_ID,
    },
  );
  expect(renewedRegistration.clientId).toBe(DB_CLIENT_ID);
  expect(renewedRegistration.appId).toBe(APP_ID);

  // 9. Deactivation: Disabling client in DB causes immediate fail-closed rejection across routes
  await pg.query(
    "UPDATE mobile_app_auth_clients SET enabled = false WHERE client_id = $1",
    [DB_CLIENT_ID],
  );

  const disabledConfigRes = await configApp.request(
    `/?clientId=${DB_CLIENT_ID}&environment=production&redirectUri=${encodeURIComponent(DB_REDIRECT_URI)}`,
    {},
    env() as never,
  );
  expect(disabledConfigRes.status).toBe(401);

  const disabledRenewRes = await renewApp.request(
    "/",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${renewedSecret}`,
      },
      body: JSON.stringify({
        clientId: DB_CLIENT_ID,
        environment: "production",
        redirectUri: DB_REDIRECT_URI,
        state: renewalState,
        codeChallenge: renewalChallenge,
        codeChallengeMethod: "S256",
      }),
    },
    env() as never,
  );
  expect(disabledRenewRes.status).toBe(401);

  let resolveFailed = false;
  try {
    await resolveMobileCredentialRegistration(env() as never, {
      id: renewedCredentialId,
      user_id: USER_ID,
      organization_id: ORG_ID,
      source_app_id: APP_ID,
    });
  } catch (err) {
    const error = err as Record<string, unknown>;
    resolveFailed = true;
    expect(error.protocolCode).toBe("invalid_client");
  }
  expect(resolveFailed).toBe(true);
});

test("Database outage fails closed: rethrows error rather than silently serving stale env fallback", async () => {
  // Temporarily rename table to simulate complete database / query outage
  await pg.exec(
    "ALTER TABLE mobile_app_auth_clients RENAME TO mobile_app_auth_clients_outage",
  );

  try {
    // 1. Asset links route returns 500 error instead of masking outage
    const assetLinksRes = await assetLinksApp.request("/", {}, env() as never);
    expect(assetLinksRes.status).toBe(500);

    // 2. Config route fails closed (503 / 500) on database outage
    const configRes = await configApp.request(
      `/?clientId=${DB_CLIENT_ID}&environment=production&redirectUri=${encodeURIComponent(DB_REDIRECT_URI)}`,
      {},
      env() as never,
    );
    expect([500, 503]).toContain(configRes.status);

    // 3. Credential resolution rethrows DB error instead of masking outage
    let resolveFailed = false;
    try {
      await resolveMobileCredentialRegistration(env() as never, {
        id: randomUUID(),
        user_id: USER_ID,
        organization_id: ORG_ID,
        source_app_id: APP_ID,
      });
    } catch {
      resolveFailed = true;
    }
    expect(resolveFailed).toBe(true);
  } finally {
    await pg.exec(
      "ALTER TABLE mobile_app_auth_clients_outage RENAME TO mobile_app_auth_clients",
    );
  }
});
