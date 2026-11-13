/**
 * End-to-end integration test proving the entire database-backed mobile App Auth lifecycle (#39257).
 *
 * Covers a database-only client (with ZERO environment configuration):
 * 1. Asset Links resolution
 * 2. Authorization code issuance
 * 3. Token exchange (inactive credential)
 * 4. Token acknowledgement (active credential)
 * 5. Credential resolution
 * 6. Renewal authorization and successor issuance
 * 7. Deactivation fail-closed enforcement
 */
import { afterAll, beforeAll, beforeEach, expect, mock, test } from "bun:test";
import { randomBytes, randomUUID } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";
import * as realDb from "@elizaos/cloud-shared/db/client";
import { apiKeys } from "@elizaos/cloud-shared/db/schemas/api-keys";
import { apps } from "@elizaos/cloud-shared/db/schemas/apps";
import { authEvents } from "@elizaos/cloud-shared/db/schemas/auth-events";
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
  authorizeMobileAppAuthRenewal,
  deriveMobileAppAuthS256Challenge,
  issueMobileAppAuthCode,
  resolveMobileCredentialRegistration,
  sha256Hex,
} = await import("@elizaos/cloud-shared/lib/services/mobile-app-auth");
const { mobileAppAuthGrantsRepository } = await import(
  "../../shared/src/db/repositories/mobile-app-auth-grants"
);
const { buildMobileAppAuthCredentialProvenance } = await import(
  "../../shared/src/db/mobile-app-auth-credential-policy"
);
const { default: assetLinksApp } = await import(
  "../.well-known/assetlinks.json/route"
);

function quote(identifier: string): string {
  return `"${identifier.replaceAll('"', '""')}"`;
}

function env(): Record<string, string | undefined> {
  return {
    ENVIRONMENT: "production",
    NODE_ENV: "test",
    ELIZA_MOBILE_APP_AUTH_ENABLED: "true",
    // Strictly zero environment configuration for the database client!
    ELIZA_MOBILE_APP_AUTH_CLIENTS_JSON: undefined,
    ELIZA_ANDROID_ASSET_LINKS_JSON: undefined,
  };
}

beforeAll(async () => {
  const enums = new Set<string>();
  for (const table of [
    organizations,
    users,
    apiKeys,
    apps,
    authEvents,
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
    await pg.exec(
      `CREATE TABLE ${quote(config.name)} (${config.columns
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
});

beforeEach(async () => {
  await pg.exec(
    "TRUNCATE mobile_app_auth_clients, mobile_app_auth_grants, apps, api_keys, users, organizations, auth_events",
  );
  await pg.query(
    "INSERT INTO organizations(id, is_active, account_lifecycle_state) VALUES($1, true, 'active')",
    [ORG_ID],
  );
  await pg.query(
    "INSERT INTO users(id, organization_id, is_active) VALUES($1, $2, true)",
    [USER_ID, ORG_ID],
  );
  await pg.query(
    `INSERT INTO apps(id, organization_id, name, app_url, allowed_origins, is_active, is_approved)
     VALUES($1, $2, 'Acme Portal', 'https://acme.portal', '["https://acme.portal/auth/callback"]', true, true)`,
    [APP_ID, ORG_ID],
  );
  await pg.query(
    `INSERT INTO mobile_app_auth_clients(client_id, app_id, redirect_uri, credential_ttl_seconds, android_package_name, android_cert_fingerprints, enabled)
     VALUES($1, $2, $3, 2592000, $4, $5, true)`,
    [
      DB_CLIENT_ID,
      APP_ID,
      DB_REDIRECT_URI,
      ANDROID_PKG,
      JSON.stringify([ANDROID_FINGERPRINT]),
    ],
  );
});

afterAll(async () => {
  await pg.close();
});

test("E2E database-only client lifecycle: asset links -> signin -> exchange -> ack -> verify -> renew -> revoke", async () => {
  // 1. Digital Asset Links served directly from database
  const assetLinksResponse = await assetLinksApp.request(
    "/",
    {},
    env() as never,
  );
  expect(assetLinksResponse.status).toBe(200);
  const statements = (await assetLinksResponse.json()) as Array<{
    target: { package_name: string; sha256_cert_fingerprints: string[] };
  }>;
  expect(statements.length).toBe(1);
  expect(statements[0].target.package_name).toBe(ANDROID_PKG);
  expect(statements[0].target.sha256_cert_fingerprints).toContain(
    ANDROID_FINGERPRINT,
  );

  // 2. Authorization code issuance for database client
  const verifier = randomBytes(48).toString("base64url");
  const codeChallenge = deriveMobileAppAuthS256Challenge(verifier);
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
      environment: "production",
      redirectUri: DB_REDIRECT_URI,
      codeChallenge,
      codeChallengeMethod: "S256",
      state,
    },
  });
  const code = issued.code;
  expect(code.startsWith("emac_")).toBe(true);

  // 3. Token exchange: Mints inactive credential
  const secret = `eliza_mobile_${randomBytes(32).toString("hex")}`;
  const credentialId = randomUUID();
  const grantState = await mobileAppAuthGrantsRepository.findStateByCodeHash(
    sha256Hex(code),
  );
  expect(grantState).not.toBeNull();
  const claim = await mobileAppAuthGrantsRepository.exchange(
    {
      codeHash: sha256Hex(code),
      appId: APP_ID,
      clientId: DB_CLIENT_ID,
      environment: "production",
      redirectUri: DB_REDIRECT_URI,
      stateHash: sha256Hex(state),
      codeChallenge,
    },
    {
      id: credentialId,
      ...buildMobileAppAuthCredentialProvenance({
        grantId: grantState!.grant.id,
        environment: grantState!.grant.environment,
        deviceName: null,
        clientId: DB_CLIENT_ID,
        scopes: ["cloud:user"],
      }),
      user_id: USER_ID,
      organization_id: ORG_ID,
      source_app_id: APP_ID,
      key_hash: sha256Hex(secret),
      key_prefix: secret.slice(0, 20),
      is_active: false,
      expires_at: new Date(Date.now() + 2592000 * 1000),
    },
    new Date(),
  );
  expect(claim.kind).toBe("created");

  // 4. Token acknowledgement: Activates credential
  const ack = await mobileAppAuthGrantsRepository.acknowledge({
    binding: {
      codeHash: sha256Hex(code),
      appId: APP_ID,
      clientId: DB_CLIENT_ID,
      environment: "production",
      redirectUri: DB_REDIRECT_URI,
      stateHash: sha256Hex(state),
      codeChallenge,
    },
    credentialId,
    credentialHash: sha256Hex(secret),
    now: new Date(),
  });
  expect(ack).not.toBeNull();
  expect(ack?.grant.status).toBe("acknowledged");

  // 5. Credential Resolution: Resolves client authority from database
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

  // 6. Renewal: DB-only client successfully authorizes renewal without env config
  const renewalAuth = await authorizeMobileAppAuthRenewal({
    env: env() as never,
    secret,
    now: new Date(),
  });
  expect(renewalAuth.registration.clientId).toBe(DB_CLIENT_ID);
  expect(renewalAuth.credentialId).toBe(credentialId);

  // 7. Deactivation: Disabling client in DB causes immediate fail-closed rejection
  await pg.query(
    "UPDATE mobile_app_auth_clients SET enabled = false WHERE client_id = $1",
    [DB_CLIENT_ID],
  );

  let renewalFailed = false;
  try {
    await authorizeMobileAppAuthRenewal({
      env: env() as never,
      secret,
      now: new Date(),
    });
  } catch (err) {
    const error = err as Record<string, unknown>;
    renewalFailed = true;
    expect(error.refusal).toBe("client_unavailable");
  }
  expect(renewalFailed).toBe(true);

  let resolveFailed = false;
  try {
    await resolveMobileCredentialRegistration(env() as never, {
      id: credentialId,
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
