import type { UUID } from "@elizaos/core";
import { sql } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DatabaseMigrationService } from "../../migration-service";
import type { PgDatabaseAdapter } from "../../pg/adapter";
import type { PgliteDatabaseAdapter } from "../../pglite/adapter";
import * as schema from "../../schema";
import type { DrizzleDatabase } from "../../types";
import { createIsolatedTestDatabase } from "../test-helpers";

describe("Connector account storage", () => {
  let adapter: PgliteDatabaseAdapter | PgDatabaseAdapter;
  let cleanup: () => Promise<void>;
  let testAgentId: UUID;
  let db: DrizzleDatabase;

  beforeEach(async () => {
    const setup = await createIsolatedTestDatabase("connector-account-storage");
    adapter = setup.adapter;
    cleanup = setup.cleanup;
    testAgentId = setup.testAgentId;
    db = adapter.getDatabase() as DrizzleDatabase;
  });

  afterEach(async () => {
    await cleanup?.();
  });

  it("migrates connector account tables idempotently", async () => {
    const migrationService = new DatabaseMigrationService();
    await migrationService.initializeWithDatabase(db);
    migrationService.discoverAndRegisterPluginSchemas([
      { name: "@elizaos/plugin-sql", description: "SQL plugin", schema },
    ]);

    await migrationService.runAllPluginMigrations();
    await migrationService.runAllPluginMigrations();

    const tables = await db.execute(sql`
      SELECT tablename FROM pg_tables
      WHERE schemaname = 'public'
        AND tablename IN (
          'connector_accounts',
          'connector_account_credentials',
          'connector_account_audit_events',
          'oauth_flows',
          'life_connector_grants'
        )
      ORDER BY tablename
    `);

    const tableNames = tables.rows.map((row) => String(row.tablename));
    expect(tableNames).toContain("connector_accounts");
    expect(tableNames).toContain("connector_account_credentials");
    expect(tableNames).toContain("connector_account_audit_events");
    expect(tableNames).toContain("oauth_flows");
    expect(tableNames).not.toContain("life_connector_grants");
  });

  it("upserts account metadata and stores only credential refs", async () => {
    const account = await adapter.upsertConnectorAccount({
      provider: "google",
      accountKey: "google-user-1",
      externalId: "google-sub-1",
      displayName: "Example User",
      email: "user@example.com",
      role: "OWNER",
      purpose: ["messaging"],
      accessGate: "open",
      scopes: ["email", "calendar.readonly"],
      capabilities: ["calendar"],
      metadata: { source: "oauth" },
    });

    const updated = await adapter.upsertConnectorAccount({
      provider: "google",
      accountKey: "google-user-1",
      displayName: "Updated User",
      scopes: ["email"],
    });

    expect(updated.id).toBe(account.id);
    expect(updated.displayName).toBe("Updated User");
    expect(updated.role).toBe("OWNER");
    expect(updated.purpose).toEqual(["messaging"]);

    const listed = await adapter.listConnectorAccounts({ provider: "google" });
    expect(listed).toHaveLength(1);

    const credential = await adapter.setConnectorAccountCredentialRef({
      accountId: account.id,
      credentialType: "oauth.refresh_token",
      vaultRef: `connector.${testAgentId}.google.${account.id}.refresh`,
      metadata: { rotatedBy: "test" },
    });
    expect(credential.vaultRef).toContain(".refresh");

    const retrievedCredential = await adapter.getConnectorAccountCredentialRef({
      accountId: account.id,
      credentialType: "oauth.refresh_token",
    });
    expect(retrievedCredential?.vaultRef).toBe(credential.vaultRef);

    const columns = await db.execute(sql`
      SELECT column_name FROM information_schema.columns
      WHERE table_name = 'connector_account_credentials'
      ORDER BY column_name
    `);
    const columnNames = columns.rows.map((row) => String(row.column_name));
    expect(columnNames).toContain("vault_ref");
    expect(columnNames).not.toContain("plaintext");
    expect(columnNames).not.toContain("ciphertext");
  });

  it("redacts audit metadata before insert", async () => {
    const account = await adapter.upsertConnectorAccount({
      provider: "slack",
      accountKey: "team:T123:user:U123",
      displayName: "Slack User",
    });

    const audit = await adapter.appendConnectorAccountAuditEvent({
      accountId: account.id,
      actorId: "owner:test",
      action: "credential.set",
      metadata: {
        accessToken: "xoxb-secret",
        nested: {
          refresh_token: "refresh-secret",
          safe: "visible",
        },
        attempts: 1,
      },
    });

    expect(audit.metadata.accessToken).toBe("[REDACTED]");
    expect((audit.metadata.nested as Record<string, unknown>).refresh_token).toBe("[REDACTED]");
    expect((audit.metadata.nested as Record<string, unknown>).safe).toBe("visible");
    expect(audit.metadata.attempts).toBe(1);
  });

  it("consumes OAuth flow state once and ignores expired state", async () => {
    const state = "opaque-oauth-state";
    const flow = await adapter.createOAuthFlowState({
      state,
      provider: "github",
      ttlMs: 60_000,
      codeVerifierRef: `connector.${testAgentId}.github.flow.pkce`,
      scopes: ["repo"],
    });

    expect(flow.stateHash).not.toBe(state);
    expect(flow.stateHash).toHaveLength(64);
    expect(flow.consumedAt).toBeNull();

    const firstConsume = await adapter.consumeOAuthFlowState({
      state,
      provider: "github",
      consumedBy: "oauth-callback",
    });
    expect(firstConsume?.consumedBy).toBe("oauth-callback");

    const secondConsume = await adapter.consumeOAuthFlowState({
      state,
      provider: "github",
      consumedBy: "oauth-callback",
    });
    expect(secondConsume).toBeNull();

    await adapter.createOAuthFlowState({
      state: "expired-state",
      provider: "github",
      expiresAt: Date.now() - 1_000,
    });
    const expired = await adapter.consumeOAuthFlowState({
      state: "expired-state",
      provider: "github",
    });
    expect(expired).toBeNull();
  });
});
