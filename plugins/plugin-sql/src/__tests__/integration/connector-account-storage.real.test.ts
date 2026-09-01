/**
 * Verifies connector-account storage end to end against a real isolated
 * database: plugin-sql migrations create the connector/OAuth tables
 * idempotently, account upsert stores only credential refs (never plaintext
 * secrets), audit metadata is redacted before insert, and OAuth flow state is
 * single-use and expiry-aware.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getConnectorAccountManager, type IAgentRuntime, type UUID } from "@elizaos/core";
import { sql } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DatabaseMigrationService } from "../../migration-service";
import type { PgDatabaseAdapter } from "../../pg/adapter";
import type { PgliteDatabaseAdapter } from "../../pglite/adapter";
import * as schema from "../../schema";
import type { DrizzleDatabase } from "../../types";
import { createIsolatedTestDatabase } from "../test-helpers";

const EXTERNAL_ROLE_MIGRATION_PATH = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../drizzle/migrations/0005_connector_account_external_role.sql"
);
const EXTERNAL_ROLE_ROLLBACK_PATH = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../drizzle/rollbacks/0005_connector_account_external_role.sql"
);

async function applySqlMigrationFile(db: DrizzleDatabase, filePath: string): Promise<void> {
  const migrationSql = fs.readFileSync(filePath, "utf8");
  for (const statement of migrationSql.split(/-->\s*statement-breakpoint/)) {
    const trimmed = statement.trim();
    if (trimmed.length > 0) {
      await db.execute(sql.raw(trimmed));
    }
  }
}

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

    // Simulate an install created by 0001 before the role-scoped external
    // identity migration, then prove the committed 0005 DDL is repeatable.
    await db.execute(
      sql.raw(`DROP INDEX IF EXISTS "connector_accounts_agent_provider_external_role_uniq"`)
    );
    await db.execute(
      sql.raw(
        `CREATE UNIQUE INDEX "connector_accounts_agent_provider_external_uniq" ` +
          `ON "connector_accounts" USING btree ("agent_id", "provider", "external_id") ` +
          `WHERE "deleted_at" IS NULL`
      )
    );
    await applySqlMigrationFile(db, EXTERNAL_ROLE_MIGRATION_PATH);
    await applySqlMigrationFile(db, EXTERNAL_ROLE_MIGRATION_PATH);

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

    const accountIndexes = await db.execute(sql`
      SELECT indexname FROM pg_indexes
      WHERE schemaname = 'public'
        AND tablename = 'connector_accounts'
      ORDER BY indexname
    `);
    const indexNames = accountIndexes.rows.map((row) => String(row.indexname));
    expect(indexNames).toContain("connector_accounts_agent_provider_external_role_uniq");
    expect(indexNames).not.toContain("connector_accounts_agent_provider_external_uniq");
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

  it("keeps role-scoped Google grants distinct and lazily upgrades a legacy account key", async () => {
    const subject = "shared-google-subject";
    const ownerKey = `acct_google_${"1".repeat(32)}`;
    const agentKey = `acct_google_${"2".repeat(32)}`;
    const legacyOwner = await adapter.upsertConnectorAccount({
      provider: "google",
      accountKey: subject,
      externalId: subject,
      role: "OWNER",
    });
    const credential = await adapter.setConnectorAccountCredentialRef({
      accountId: legacyOwner.id,
      credentialType: "oauth.tokens",
      vaultRef: `connector.${testAgentId}.google.${legacyOwner.id}.oauth_tokens`,
    });
    const runtime = {
      adapter,
      getService: () => null,
    } as unknown as IAgentRuntime;
    const manager = getConnectorAccountManager(runtime);
    const accountShape = {
      provider: "google",
      purpose: ["automation" as const],
      accessGate: "open" as const,
      status: "connected" as const,
      externalId: subject,
      createdAt: 1,
      updatedAt: 1,
    };

    const owner = await manager.upsertAccount("google", {
      ...accountShape,
      id: ownerKey,
      accountKey: ownerKey,
      role: "OWNER",
    });
    const agent = await manager.upsertAccount("google", {
      ...accountShape,
      id: agentKey,
      accountKey: agentKey,
      role: "AGENT",
    });

    expect(owner.id).toBe(legacyOwner.id);
    expect(agent.id).not.toBe(owner.id);
    await expect(
      adapter.getConnectorAccountCredentialRef({
        accountId: owner.id as UUID,
        credentialType: "oauth.tokens",
      })
    ).resolves.toMatchObject({ vaultRef: credential.vaultRef });

    const ownerRetry = await manager.upsertAccount("google", {
      ...accountShape,
      id: ownerKey,
      accountKey: ownerKey,
      role: "OWNER",
    });
    expect(ownerRetry.id).toBe(owner.id);
    await expect(
      manager.upsertAccount("google", {
        ...accountShape,
        id: agentKey,
        accountKey: agentKey,
        role: "OWNER",
      })
    ).rejects.toThrow();

    const listed = await adapter.listConnectorAccounts({ provider: "google" });
    expect(listed).toHaveLength(2);
    expect(listed).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ accountKey: ownerKey, externalId: subject, role: "OWNER" }),
        expect.objectContaining({ accountKey: agentKey, externalId: subject, role: "AGENT" }),
      ])
    );
  });

  it("archives role siblings before restoring the legacy external-identity index", async () => {
    const subject = "rollback-google-subject";
    const owner = await adapter.upsertConnectorAccount({
      provider: "google",
      accountKey: "rollback-owner-key",
      externalId: subject,
      role: "OWNER",
    });
    const agent = await adapter.upsertConnectorAccount({
      provider: "google",
      accountKey: "rollback-agent-key",
      externalId: subject,
      role: "AGENT",
    });
    await adapter.setConnectorAccountCredentialRef({
      accountId: agent.id,
      credentialType: "oauth.tokens",
      vaultRef: `connector.${testAgentId}.google.${agent.id}.oauth_tokens`,
    });

    await applySqlMigrationFile(db, EXTERNAL_ROLE_ROLLBACK_PATH);

    const rows = await db.execute(sql`
      SELECT "id", "role", "deleted_at"
      FROM "connector_accounts"
      WHERE "external_id" = ${subject}
      ORDER BY "role"
    `);
    expect(rows.rows).toHaveLength(2);
    expect(rows.rows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: owner.id, role: "OWNER", deleted_at: null }),
        expect.objectContaining({ id: agent.id, role: "AGENT" }),
      ])
    );
    expect(rows.rows.find((row) => row.id === agent.id)?.deleted_at).not.toBeNull();
    const archivedCredential = await db.execute(sql`
      SELECT "account_id" FROM "connector_account_credentials"
      WHERE "account_id" = ${agent.id} AND "credential_type" = 'oauth.tokens'
    `);
    expect(archivedCredential.rows).toEqual([expect.objectContaining({ account_id: agent.id })]);

    const indexes = await db.execute(sql`
      SELECT indexname FROM pg_indexes
      WHERE schemaname = 'public' AND tablename = 'connector_accounts'
    `);
    const names = indexes.rows.map((row) => String(row.indexname));
    expect(names).toContain("connector_accounts_agent_provider_external_uniq");
    expect(names).not.toContain("connector_accounts_agent_provider_external_role_uniq");
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
