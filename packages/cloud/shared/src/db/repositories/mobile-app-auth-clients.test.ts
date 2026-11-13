/**
 * Tests for database-backed mobile App Auth client repository.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
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

const ORG_ID = "11111111-1111-4111-8111-111111111111";
const APP_ACTIVE_ID = "22222222-2222-4222-8222-222222222222";
const APP_INACTIVE_ID = "33333333-3333-4333-8333-333333333333";
const APP_UNAPPROVED_ID = "44444444-4444-4444-8444-444444444444";

const FINGERPRINT_1 =
  "11:22:33:44:55:66:77:88:99:AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99:AA:BB:CC:DD:EE:FF:00";
const FINGERPRINT_2 =
  "AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99:AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99";

beforeAll(async () => {
  ({ closeDatabaseConnectionsForTests, dbWrite } = await import("../client"));
  ({ mobileAppAuthClientsRepository } = await import("./mobile-app-auth-clients"));

  await dbWrite.execute("CREATE TABLE organizations (id uuid PRIMARY KEY)");
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
      is_active boolean NOT NULL DEFAULT true,
      is_approved boolean NOT NULL DEFAULT true,
      created_at timestamp NOT NULL DEFAULT now(),
      updated_at timestamp NOT NULL DEFAULT now()
    )
  `);

  for (const statement of readFileSync(clientRegistrationMigrationUrl, "utf8").split(
    "--> statement-breakpoint",
  )) {
    if (statement.trim()) await dbWrite.execute(statement);
  }

  await dbWrite.execute(`INSERT INTO organizations (id) VALUES ('${ORG_ID}')`);

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
      ('ai.disabled.app', '${APP_ACTIVE_ID}', 'https://eliza.app/disabled/callback', 2592000, 'ai.disabled.app', '["${FINGERPRINT_1}"]'::jsonb, false),
      ('ai.inactive.app', '${APP_INACTIVE_ID}', 'https://inactive.app/auth/callback', 2592000, 'ai.inactive.app', '["${FINGERPRINT_1}"]'::jsonb, true),
      ('ai.unapproved.app', '${APP_UNAPPROVED_ID}', 'https://unapproved.app/auth/callback', 2592000, 'ai.unapproved.app', '["${FINGERPRINT_1}"]'::jsonb, true),
      ('ai.secondary.client', '${APP_ACTIVE_ID}', 'https://eliza.app/secondary/callback', 1209600, 'ai.secondary.pkg', '["${FINGERPRINT_2}"]'::jsonb, true)
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
      expect(result?.app.id).toBe(APP_ACTIVE_ID);
      expect(result?.app.is_active).toBe(true);
      expect(result?.app.is_approved).toBe(true);
    });

    test("returns null for non-existent client", async () => {
      const result =
        await mobileAppAuthClientsRepository.findRegisteredMobileClient("non.existent.client");
      expect(result).toBeNull();
    });

    test("returns null for disabled client", async () => {
      const result =
        await mobileAppAuthClientsRepository.findRegisteredMobileClient("ai.disabled.app");
      expect(result).toBeNull();
    });

    test("returns null when parent app is inactive", async () => {
      const result =
        await mobileAppAuthClientsRepository.findRegisteredMobileClient("ai.inactive.app");
      expect(result).toBeNull();
    });

    test("returns null when parent app is unapproved", async () => {
      const result =
        await mobileAppAuthClientsRepository.findRegisteredMobileClient("ai.unapproved.app");
      expect(result).toBeNull();
    });
  });

  describe("listActiveAndroidAssetLinks", () => {
    test("returns asset link statements for active and approved apps only", async () => {
      const statements = await mobileAppAuthClientsRepository.listActiveAndroidAssetLinks();
      expect(statements.length).toBe(2);

      const packages = statements.map((s) => s.target.package_name);
      expect(packages).toContain("ai.elizaos.app");
      expect(packages).toContain("ai.secondary.pkg");
      expect(packages).not.toContain("ai.disabled.app");
      expect(packages).not.toContain("ai.inactive.app");
      expect(packages).not.toContain("ai.unapproved.app");

      const elizaStatement = statements.find((s) => s.target.package_name === "ai.elizaos.app");
      expect(elizaStatement?.relation).toEqual(["delegate_permission/common.handle_all_urls"]);
      expect(elizaStatement?.target.sha256_cert_fingerprints).toEqual([FINGERPRINT_1]);
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
});
