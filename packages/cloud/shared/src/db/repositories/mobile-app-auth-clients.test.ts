/**
 * Tests for database-backed mobile App Auth client repository and private owner credential authorization.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

process.env.DATABASE_URL = "pglite://memory";
process.env.TEST_DATABASE_URL = "pglite://memory";
process.env.NODE_ENV = "test";

const clientRegistrationMigrationUrl = new URL(
  "../migrations/0574_native_app_auth_client_registration.sql",
  import.meta.url,
);

let dbWrite: typeof import("../client").dbWrite;
let closeDatabaseConnectionsForTests:
  | typeof import("../client").closeDatabaseConnectionsForTests
  | undefined;
let mobileAppAuthClientsRepository: typeof import("./mobile-app-auth-clients").mobileAppAuthClientsRepository;
let requirePrivateOwnerCredential: typeof import("../../lib/auth/private-owner-credential").requirePrivateOwnerCredential;

const ORG_ID = "11111111-1111-4111-8111-111111111111";
const USER_ID = "55555555-5555-4555-8555-555555555555";
const APP_ACTIVE_ID = "22222222-2222-4222-8222-222222222222";
const APP_INACTIVE_ID = "33333333-3333-4333-8333-333333333333";
const APP_UNAPPROVED_ID = "44444444-4444-4444-8444-444444444444";

const KEY_PROD_ID = "66666666-6666-4666-8666-666666666666";
const KEY_STAGING_ID = "77777777-7777-4777-8777-777777777777";
const KEY_DISABLED_ID = "88888888-8888-4888-8888-888888888888";
const SECRET_RAW = "synthetic-secret-token";
const SECRET_HASH = createHash("sha256").update(SECRET_RAW).digest("hex");

const FINGERPRINT_1 =
  "11:22:33:44:55:66:77:88:99:AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99:AA:BB:CC:DD:EE:FF:00";
const FINGERPRINT_2 =
  "AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99:AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99";

beforeAll(async () => {
  ({ closeDatabaseConnectionsForTests, dbWrite } = await import("../client"));
  ({ mobileAppAuthClientsRepository } = await import("./mobile-app-auth-clients"));
  ({ requirePrivateOwnerCredential } = await import("../../lib/auth/private-owner-credential"));

  await dbWrite.execute(
    "CREATE TABLE organizations (id uuid PRIMARY KEY, is_active boolean DEFAULT true, account_lifecycle_state text DEFAULT 'active', account_deletion_request_id uuid)",
  );
  await dbWrite.execute(
    "CREATE TABLE users (id uuid PRIMARY KEY, organization_id uuid REFERENCES organizations(id), is_active boolean DEFAULT true, deleted_at timestamp, account_lifecycle_state text DEFAULT 'active', account_deletion_request_id uuid, expires_at timestamp)",
  );
  await dbWrite.execute(`
    CREATE TABLE apps (
      id uuid PRIMARY KEY,
      name text NOT NULL DEFAULT 'App',
      description text,
      logo_url text,
      website_url text,
      slug text NOT NULL DEFAULT 'slug',
      organization_id uuid NOT NULL REFERENCES organizations(id),
      app_url text NOT NULL DEFAULT 'https://example.com',
      allowed_origins jsonb NOT NULL DEFAULT '[]'::jsonb,
      api_key_id uuid,
      is_active boolean NOT NULL DEFAULT true,
      is_approved boolean NOT NULL DEFAULT true,
      created_at timestamp NOT NULL DEFAULT now(),
      updated_at timestamp NOT NULL DEFAULT now()
    )
  `);
  await dbWrite.execute(`
    CREATE TABLE api_keys (
      id uuid PRIMARY KEY,
      user_id uuid NOT NULL REFERENCES users(id),
      organization_id uuid NOT NULL REFERENCES organizations(id),
      source_app_id uuid,
      key_hash text NOT NULL,
      is_active boolean NOT NULL DEFAULT true,
      deleted_at timestamp,
      expires_at timestamp NOT NULL DEFAULT now() + interval '30 days',
      created_at timestamp NOT NULL DEFAULT now(),
      updated_at timestamp NOT NULL DEFAULT now()
    )
  `);
  await dbWrite.execute(`
    CREATE TABLE mobile_app_auth_grants (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      code_hash text NOT NULL,
      app_id uuid NOT NULL REFERENCES apps(id),
      client_id text NOT NULL,
      user_id uuid NOT NULL REFERENCES users(id),
      organization_id uuid NOT NULL REFERENCES organizations(id),
      environment text NOT NULL,
      redirect_uri text NOT NULL,
      state_hash text NOT NULL,
      code_challenge text NOT NULL,
      code_challenge_method text NOT NULL,
      scopes jsonb NOT NULL,
      status text NOT NULL DEFAULT 'acknowledged',
      credential_id uuid REFERENCES api_keys(id),
      expires_at timestamp with time zone NOT NULL,
      acknowledged_at timestamp with time zone DEFAULT now(),
      created_at timestamp with time zone DEFAULT now(),
      updated_at timestamp with time zone DEFAULT now()
    )
  `);

  for (const statement of readFileSync(clientRegistrationMigrationUrl, "utf8").split(
    "--> statement-breakpoint",
  )) {
    if (statement.trim()) await dbWrite.execute(statement);
  }

  await dbWrite.execute(`INSERT INTO organizations (id) VALUES ('${ORG_ID}')`);
  await dbWrite.execute(
    `INSERT INTO users (id, organization_id) VALUES ('${USER_ID}', '${ORG_ID}')`,
  );

  await dbWrite.execute(`
    INSERT INTO apps (id, organization_id, app_url, allowed_origins, is_active, is_approved)
    VALUES
      ('${APP_ACTIVE_ID}', '${ORG_ID}', 'https://eliza.app', '["https://eliza.app/auth/callback"]'::jsonb, true, true),
      ('${APP_INACTIVE_ID}', '${ORG_ID}', 'https://inactive.app', '["https://inactive.app/auth/callback"]'::jsonb, false, true),
      ('${APP_UNAPPROVED_ID}', '${ORG_ID}', 'https://unapproved.app', '["https://unapproved.app/auth/callback"]'::jsonb, true, false)
  `);

  await dbWrite.execute(`
    INSERT INTO mobile_app_auth_clients (
      client_id, app_id, redirect_uri, credential_ttl_seconds, android_package_name, android_cert_fingerprints, enabled
    ) VALUES
      ('ai.elizaos.app', '${APP_ACTIVE_ID}', 'https://eliza.app/auth/callback', 2592000, 'ai.elizaos.app', '["${FINGERPRINT_1}"]'::jsonb, true),
      ('ai.second.client', '${APP_ACTIVE_ID}', 'https://eliza.app/second/callback', 2592000, 'ai.elizaos.app', '["${FINGERPRINT_2}"]'::jsonb, true),
      ('ai.disabled.app', '${APP_ACTIVE_ID}', 'https://eliza.app/disabled/callback', 2592000, 'ai.disabled.app', '["${FINGERPRINT_1}"]'::jsonb, false),
      ('ai.inactive.app', '${APP_INACTIVE_ID}', 'https://inactive.app/auth/callback', 2592000, 'ai.inactive.app', '["${FINGERPRINT_1}"]'::jsonb, true),
      ('ai.unapproved.app', '${APP_UNAPPROVED_ID}', 'https://unapproved.app/auth/callback', 2592000, 'ai.unapproved.app', '["${FINGERPRINT_1}"]'::jsonb, true),
      ('ai.secondary.client', '${APP_ACTIVE_ID}', 'https://eliza.app/secondary/callback', 1209600, 'ai.secondary.pkg', '["${FINGERPRINT_2}"]'::jsonb, true)
  `);

  await dbWrite.execute(`
    INSERT INTO api_keys (id, user_id, organization_id, source_app_id, key_hash, is_active)
    VALUES
      ('${KEY_PROD_ID}', '${USER_ID}', '${ORG_ID}', '${APP_ACTIVE_ID}', '${SECRET_HASH}', true),
      ('${KEY_STAGING_ID}', '${USER_ID}', '${ORG_ID}', '${APP_ACTIVE_ID}', '${SECRET_HASH}', true),
      ('${KEY_DISABLED_ID}', '${USER_ID}', '${ORG_ID}', '${APP_ACTIVE_ID}', '${SECRET_HASH}', true)
  `);

  await dbWrite.execute(`
    INSERT INTO mobile_app_auth_grants (
      code_hash, app_id, client_id, user_id, organization_id, environment, redirect_uri, state_hash, code_challenge, code_challenge_method, scopes, status, credential_id, expires_at, acknowledged_at
    ) VALUES
      ('code_hash_prod', '${APP_ACTIVE_ID}', 'ai.elizaos.app', '${USER_ID}', '${ORG_ID}', 'production', 'https://eliza.app/auth/callback', 'state_prod', 'challenge', 'S256', '["cloud:user"]'::jsonb, 'acknowledged', '${KEY_PROD_ID}', now() + interval '30 days', now()),
      ('code_hash_staging', '${APP_ACTIVE_ID}', 'ai.elizaos.app', '${USER_ID}', '${ORG_ID}', 'staging', 'https://eliza.app/auth/callback', 'state_staging', 'challenge', 'S256', '["cloud:user"]'::jsonb, 'acknowledged', '${KEY_STAGING_ID}', now() + interval '30 days', now()),
      ('code_hash_disabled', '${APP_ACTIVE_ID}', 'ai.disabled.app', '${USER_ID}', '${ORG_ID}', 'production', 'https://eliza.app/disabled/callback', 'state_disabled', 'challenge', 'S256', '["cloud:user"]'::jsonb, 'acknowledged', '${KEY_DISABLED_ID}', now() + interval '30 days', now())
  `);
}, 60_000);

afterAll(async () => {
  await closeDatabaseConnectionsForTests?.();
});

describe("mobileAppAuthClientsRepository", () => {
  describe("findRegisteredMobileClient", () => {
    test("returns registration and app for active enabled client", async () => {
      const result =
        await mobileAppAuthClientsRepository.findRegisteredMobileClient("ai.elizaos.app");
      expect(result).not.toBeNull();
      expect(result?.client.client_id).toBe("ai.elizaos.app");
      expect(result?.client.redirect_uri).toBe("https://eliza.app/auth/callback");
      expect(result?.client.credential_ttl_seconds).toBe(2592000);
      expect(result?.client.enabled).toBe(true);
      expect(result?.app.id).toBe(APP_ACTIVE_ID);
      expect(result?.app.is_active).toBe(true);
      expect(result?.app.is_approved).toBe(true);
    });

    test("returns row with enabled=false for disabled client", async () => {
      const result =
        await mobileAppAuthClientsRepository.findRegisteredMobileClient("ai.disabled.app");
      expect(result).not.toBeNull();
      expect(result?.client.enabled).toBe(false);
    });

    test("returns null for non-existent client", async () => {
      const result =
        await mobileAppAuthClientsRepository.findRegisteredMobileClient("non.existent.client");
      expect(result).toBeNull();
    });
  });

  describe("listActiveAndroidAssetLinks", () => {
    test("merges fingerprints across multiple clients for the same package", async () => {
      const statements = await mobileAppAuthClientsRepository.listActiveAndroidAssetLinks({
        ENVIRONMENT: "production",
        ELIZA_MOBILE_APP_AUTH_ENABLED: "true",
      });
      expect(statements.length).toBe(2);

      const packages = statements.map((s) => s.target.package_name);
      expect(packages).toContain("ai.elizaos.app");
      expect(packages).toContain("ai.secondary.pkg");

      const elizaStatement = statements.find((s) => s.target.package_name === "ai.elizaos.app");
      expect(elizaStatement?.relation).toEqual(["delegate_permission/common.handle_all_urls"]);
      // Both fingerprints should be merged and present
      expect(elizaStatement?.target.sha256_cert_fingerprints).toContain(FINGERPRINT_1);
      expect(elizaStatement?.target.sha256_cert_fingerprints).toContain(FINGERPRINT_2);
      expect(elizaStatement?.target.sha256_cert_fingerprints.length).toBe(2);
    });
  });

  describe("findByRedirectUri", () => {
    test("finds client by exact redirect URI", async () => {
      const result = await mobileAppAuthClientsRepository.findByRedirectUri(
        "https://eliza.app/auth/callback",
      );
      expect(result).not.toBeNull();
      expect(result?.client.client_id).toBe("ai.elizaos.app");
    });

    test("returns null for unknown redirect URI", async () => {
      const result = await mobileAppAuthClientsRepository.findByRedirectUri(
        "https://other.app/callback",
      );
      expect(result).toBeNull();
    });
  });

  describe("requirePrivateOwnerCredential environment and disabled DB checks", () => {
    test("admits matching production grant on production environment", async () => {
      await expect(
        requirePrivateOwnerCredential({
          userId: USER_ID,
          organizationId: ORG_ID,
          authMethod: "api_key",
          apiKeyId: KEY_PROD_ID,
          apiKeyHash: SECRET_HASH,
          env: { ENVIRONMENT: "production", ELIZA_MOBILE_APP_AUTH_ENABLED: "true" },
        }),
      ).resolves.toBeUndefined();
    });

    test("refuses staging grant on production environment", async () => {
      await expect(
        requirePrivateOwnerCredential({
          userId: USER_ID,
          organizationId: ORG_ID,
          authMethod: "api_key",
          apiKeyId: KEY_STAGING_ID,
          apiKeyHash: SECRET_HASH,
          env: { ENVIRONMENT: "production", ELIZA_MOBILE_APP_AUTH_ENABLED: "true" },
        }),
      ).rejects.toThrow();
    });

    test("refuses disabled DB client immediately without fallback", async () => {
      await expect(
        requirePrivateOwnerCredential({
          userId: USER_ID,
          organizationId: ORG_ID,
          authMethod: "api_key",
          apiKeyId: KEY_DISABLED_ID,
          apiKeyHash: SECRET_HASH,
          env: { ENVIRONMENT: "production", ELIZA_MOBILE_APP_AUTH_ENABLED: "true" },
        }),
      ).rejects.toThrow();
    });
  });
});
