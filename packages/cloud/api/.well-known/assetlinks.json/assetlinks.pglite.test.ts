/**
 * Tests GET /.well-known/assetlinks.json with real database rows in PGlite.
 */
import { afterAll, beforeAll, describe, expect, mock, test } from "bun:test";
import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import * as realDb from "@elizaos/cloud-shared/db/client";
import { apps } from "@elizaos/cloud-shared/db/schemas/apps";
import { mobileAppAuthClients } from "@elizaos/cloud-shared/db/schemas/mobile-app-auth-clients";
import { organizations } from "@elizaos/cloud-shared/db/schemas/organizations";
import { drizzle } from "drizzle-orm/pglite";

const pg = new PGlite();
const database = drizzle(pg, {
  schema: { apps, organizations, mobileAppAuthClients },
});
const originalDb = { ...realDb };
mock.module("@elizaos/cloud-shared/db/client", () => ({
  ...originalDb,
  dbWrite: database,
  dbRead: database,
}));

const { default: route } = await import("./route");

const ORG_ID = "11111111-1111-4111-8111-111111111111";
const APP_ID = "22222222-2222-4222-8222-222222222222";
const FINGERPRINT =
  "AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99:AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99";

const migrationUrl = new URL(
  "../../../shared/src/db/migrations/0574_native_app_auth_client_registration.sql",
  import.meta.url,
);

beforeAll(async () => {
  await database.execute("CREATE TABLE organizations (id uuid PRIMARY KEY)");
  await database.execute(`
    CREATE TABLE apps (
      id uuid PRIMARY KEY,
      name text NOT NULL DEFAULT 'Eliza App',
      description text, logo_url text, website_url text,
      slug text NOT NULL DEFAULT 'eliza',
      organization_id uuid NOT NULL REFERENCES organizations(id),
      app_url text NOT NULL DEFAULT 'https://eliza.app',
      allowed_origins jsonb NOT NULL DEFAULT '[]'::jsonb,
      is_active boolean NOT NULL DEFAULT true,
      is_approved boolean NOT NULL DEFAULT true,
      created_at timestamp NOT NULL DEFAULT now(),
      updated_at timestamp NOT NULL DEFAULT now()
    )
  `);

  for (const statement of readFileSync(migrationUrl, "utf8").split(
    "--> statement-breakpoint",
  )) {
    if (statement.trim()) await database.execute(statement);
  }

  await database.execute(`INSERT INTO organizations (id) VALUES ('${ORG_ID}')`);
  await database.execute(`
    INSERT INTO apps (id, organization_id, app_url, is_active, is_approved)
    VALUES ('${APP_ID}', '${ORG_ID}', 'https://eliza.app', true, true)
  `);
  await database.execute(`
    INSERT INTO mobile_app_auth_clients (
      client_id, app_id, redirect_uri, android_package_name, android_cert_fingerprints, enabled
    ) VALUES (
      'ai.elizaos.app', '${APP_ID}', 'https://eliza.app/auth/callback',
      'ai.elizaos.app', '["${FINGERPRINT}"]'::jsonb, true
    )
  `);
});

afterAll(async () => {
  await pg.close();
});

describe("GET /.well-known/assetlinks.json with PGlite", () => {
  test("dynamically serves statements from database rows without env vars", async () => {
    const response = await route.request(
      "/",
      {},
      { ENVIRONMENT: "production", ELIZA_MOBILE_APP_AUTH_ENABLED: "true" },
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("public, max-age=3600");

    const statements = await response.json();
    expect(statements).toEqual([
      {
        relation: ["delegate_permission/common.handle_all_urls"],
        target: {
          namespace: "android_app",
          package_name: "ai.elizaos.app",
          sha256_cert_fingerprints: [FINGERPRINT],
        },
      },
    ]);
  });
});
