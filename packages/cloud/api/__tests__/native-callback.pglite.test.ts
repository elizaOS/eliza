/**
 * Tests the hosted native sign-in callback and billing return fallback pages
 * served dynamically by the API Worker using mobileAppAuthClientsRepository.findByRedirectUri.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";

process.env.DATABASE_URL = "pglite://memory";
process.env.TEST_DATABASE_URL = "pglite://memory";
process.env.NODE_ENV = "test";

const APP_ID = "11111111-1111-4111-8111-111111111111";
const ORG_ID = "22222222-2222-4222-8222-222222222222";

let dbWrite: typeof import("@elizaos/cloud-shared/db/client").dbWrite;
let closeDatabaseConnectionsForTests:
  | typeof import("@elizaos/cloud-shared/db/client").closeDatabaseConnectionsForTests
  | undefined;
let app: Awaited<ReturnType<typeof import("../src/bootstrap-app").createApp>>;

async function applyMigrationFile(relPath: string): Promise<void> {
  const url = new URL(
    `../../shared/src/db/migrations/${relPath}`,
    import.meta.url,
  );
  for (const statement of readFileSync(url, "utf8").split(
    "--> statement-breakpoint",
  )) {
    if (statement.trim()) await dbWrite.execute(statement);
  }
}

beforeAll(async () => {
  ({ closeDatabaseConnectionsForTests, dbWrite } = await import(
    "@elizaos/cloud-shared/db/client"
  ));

  await dbWrite.execute("CREATE TABLE organizations (id uuid PRIMARY KEY)");
  await dbWrite.execute("CREATE TABLE users (id uuid PRIMARY KEY)");
  await dbWrite.execute(`
    CREATE TABLE apps (
      id uuid PRIMARY KEY,
      name text NOT NULL,
      description text,
      logo_url text,
      website_url text,
      app_url text NOT NULL,
      allowed_origins jsonb DEFAULT '[]'::jsonb NOT NULL,
      is_active boolean DEFAULT true NOT NULL,
      is_approved boolean DEFAULT true NOT NULL,
      created_at timestamp with time zone DEFAULT now() NOT NULL
    )
  `);
  await dbWrite.execute("CREATE TABLE api_keys (id uuid PRIMARY KEY)");

  await applyMigrationFile("0277_mobile_app_auth_pkce_grants.sql");
  await applyMigrationFile("0279_mobile_app_auth_device_name.sql");
  await applyMigrationFile("0574_native_app_auth_client_registration.sql");

  await dbWrite.execute(`INSERT INTO organizations (id) VALUES ('${ORG_ID}')`);
  await dbWrite.execute(
    `INSERT INTO apps (id, name, app_url, allowed_origins, is_active, is_approved)
     VALUES ('${APP_ID}', 'Eliza Official', 'https://eliza.app', '["https://eliza.app/auth/callback"]'::jsonb, true, true)`,
  );

  // Seed primary client
  await dbWrite.execute(`
    INSERT INTO mobile_app_auth_clients (
      client_id, app_id, redirect_uri, android_package_name, enabled
    ) VALUES (
      'ai.elizaos.app', '${APP_ID}', 'https://eliza.app/auth/callback', 'ai.elizaos.app', true
    ) ON CONFLICT (client_id) DO NOTHING
  `);

  const { createApp } = await import("../src/bootstrap-app");
  app = await createApp({ requestPath: "/auth/callback" });
}, 60_000);

afterAll(async () => {
  await closeDatabaseConnectionsForTests?.();
});

describe("hosted native callback and billing return routes", () => {
  test("serves fallback HTML for database-registered client without any environment variable", async () => {
    const res = await app.request(
      "https://eliza.app/auth/callback?code=synthetic-code-12345&state=synthetic-state-67890",
      { method: "GET" },
      {
        ENVIRONMENT: "production",
        ELIZA_MOBILE_APP_AUTH_ENABLED: "true",
      } as never,
    );

    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toContain("text/html");
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    expect(res.headers.get("X-Robots-Tag")).toBe("noindex, nofollow");

    const html = await res.text();
    expect(html).toContain("Return to Eliza Official");
    expect(html).toContain("package=ai.elizaos.app;end");
    expect(html).toContain(
      'href="intent://eliza.app/auth/callback#Intent;scheme=https;package=ai.elizaos.app;end"',
    );
    // Never reflects raw code into server-rendered HTML
    expect(html).not.toContain("synthetic-code-12345");
  });

  test("immediately reflects client or app renaming without server deployment", async () => {
    const customAppId = randomUUID();
    await dbWrite.execute(
      `INSERT INTO apps (id, name, app_url, allowed_origins, is_active, is_approved)
       VALUES ('${customAppId}', 'Reader Pro', 'https://eliza.app', '["https://eliza.app/reader/auth/callback"]'::jsonb, true, true)`,
    );
    await dbWrite.execute(`
      INSERT INTO mobile_app_auth_clients (
        client_id, app_id, redirect_uri, android_package_name, enabled
      ) VALUES (
        'org.example.reader', '${customAppId}', 'https://eliza.app/reader/auth/callback', 'org.example.reader', true
      )
    `);

    // 1. Initial request with original name
    const initialRes = await app.request(
      "https://eliza.app/reader/auth/callback?state=123",
      { method: "GET" },
      {
        ENVIRONMENT: "production",
        ELIZA_MOBILE_APP_AUTH_ENABLED: "true",
      } as never,
    );
    expect(initialRes.status).toBe(200);
    const initialHtml = await initialRes.text();
    expect(initialHtml).toContain("Return to Reader Pro");
    expect(initialHtml).toContain("package=org.example.reader;end");

    // 2. Rename in database: change package and app name
    await dbWrite.execute(
      `UPDATE apps SET name = 'Reader Ultra' WHERE id = '${customAppId}'`,
    );
    await dbWrite.execute(
      `UPDATE mobile_app_auth_clients SET android_package_name = 'org.example.reader.ultra' WHERE client_id = 'org.example.reader'`,
    );

    // 3. Next request immediately reflects the updated database rows
    const updatedRes = await app.request(
      "https://eliza.app/reader/auth/callback?state=123",
      { method: "GET" },
      {
        ENVIRONMENT: "production",
        ELIZA_MOBILE_APP_AUTH_ENABLED: "true",
      } as never,
    );
    expect(updatedRes.status).toBe(200);
    const updatedHtml = await updatedRes.text();
    expect(updatedHtml).toContain("Return to Reader Ultra");
    expect(updatedHtml).toContain("package=org.example.reader.ultra;end");
  });

  test("serves native billing return fallback page with session parameters", async () => {
    const res = await app.request(
      "https://eliza.app/billing/return?result=success&session_id=cs_live_1234567890",
      { method: "GET" },
      {
        ENVIRONMENT: "production",
        ELIZA_MOBILE_APP_AUTH_ENABLED: "true",
      } as never,
    );

    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toContain("text/html");
    expect(res.headers.get("Cache-Control")).toBe("no-store");

    const html = await res.text();
    expect(html).toContain("Return to Eliza Official");
    expect(html).toContain("session_id=cs_live_1234567890");
    expect(html).toContain("result=success");
    expect(html).toContain("package=ai.elizaos.app;end");
  });

  test("returns 404 for un-registered redirect URI", async () => {
    const res = await app.request(
      "https://eliza.app/unregistered/auth/callback",
      { method: "GET" },
      {
        ENVIRONMENT: "production",
        ELIZA_MOBILE_APP_AUTH_ENABLED: "true",
      } as never,
    );
    expect(res.status).toBe(404);
  });

  test("returns 404 when client is disabled in database", async () => {
    const disabledAppId = randomUUID();
    await dbWrite.execute(
      `INSERT INTO apps (id, name, app_url, allowed_origins, is_active, is_approved)
       VALUES ('${disabledAppId}', 'Disabled App', 'https://eliza.app', '["https://eliza.app/disabled/auth/callback"]'::jsonb, true, true)`,
    );
    await dbWrite.execute(`
      INSERT INTO mobile_app_auth_clients (
        client_id, app_id, redirect_uri, android_package_name, enabled
      ) VALUES (
        'org.example.disabled', '${disabledAppId}', 'https://eliza.app/disabled/auth/callback', 'org.example.disabled', false
      )
    `);

    const res = await app.request(
      "https://eliza.app/disabled/auth/callback",
      { method: "GET" },
      {
        ENVIRONMENT: "production",
        ELIZA_MOBILE_APP_AUTH_ENABLED: "true",
      } as never,
    );
    expect(res.status).toBe(404);
  });

  test("returns 404 when parent app is unapproved", async () => {
    const unapprovedAppId = randomUUID();
    await dbWrite.execute(
      `INSERT INTO apps (id, name, app_url, allowed_origins, is_active, is_approved)
       VALUES ('${unapprovedAppId}', 'Unapproved App', 'https://eliza.app', '["https://eliza.app/unapproved/auth/callback"]'::jsonb, true, false)`,
    );
    await dbWrite.execute(`
      INSERT INTO mobile_app_auth_clients (
        client_id, app_id, redirect_uri, android_package_name, enabled
      ) VALUES (
        'org.example.unapproved', '${unapprovedAppId}', 'https://eliza.app/unapproved/auth/callback', 'org.example.unapproved', true
      )
    `);

    const res = await app.request(
      "https://eliza.app/unapproved/auth/callback",
      { method: "GET" },
      {
        ENVIRONMENT: "production",
        ELIZA_MOBILE_APP_AUTH_ENABLED: "true",
      } as never,
    );
    expect(res.status).toBe(404);
  });
});
