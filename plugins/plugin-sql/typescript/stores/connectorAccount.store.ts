import { createHash } from "node:crypto";
import type {
  AppendConnectorAccountAuditEventParams,
  ConnectorAccountAuditEventRecord,
  ConnectorAccountAuditOutcome,
  ConnectorAccountCredentialRefRecord,
  ConnectorAccountJsonObject,
  ConnectorAccountRecord,
  ConsumeOAuthFlowStateParams,
  CreateOAuthFlowStateParams,
  DeleteConnectorAccountParams,
  GetConnectorAccountCredentialRefParams,
  GetConnectorAccountParams,
  JsonValue,
  ListConnectorAccountCredentialRefsParams,
  ListConnectorAccountsParams,
  OAuthFlowRecord,
  SetConnectorAccountCredentialRefParams,
  UpsertConnectorAccountParams,
  UUID,
} from "@elizaos/core";
import { and, desc, eq, gt, isNull } from "drizzle-orm";
import {
  connectorAccountAuditEventsTable,
  connectorAccountCredentialsTable,
  connectorAccountsTable,
  oauthFlowsTable,
} from "../schema/index";
import type { DrizzleDatabase } from "../types";
import type { Store, StoreContext } from "./types";

const CONNECTOR_AUDIT_REDACTED = "[REDACTED]";
const CONNECTOR_AUDIT_SECRET_KEY_PATTERN =
  /(access|refresh|id)?_?token|secret|password|credential|authorization|cookie|code_verifier|client_secret|api_?key|private_?key|oauth_?code|state/i;

function redactConnectorAuditValue(value: unknown): JsonValue {
  if (value === null || value === undefined) return null;
  if (Array.isArray(value)) {
    return value.map(redactConnectorAuditValue) as JsonValue;
  }
  if (typeof value === "object") {
    const redacted: ConnectorAccountJsonObject = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      redacted[key] = CONNECTOR_AUDIT_SECRET_KEY_PATTERN.test(key)
        ? CONNECTOR_AUDIT_REDACTED
        : redactConnectorAuditValue(item);
    }
    return redacted;
  }
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return value;
  }
  return String(value);
}

function redactConnectorAuditMetadata(
  metadata: Record<string, unknown> | undefined
): ConnectorAccountJsonObject {
  return redactConnectorAuditValue(metadata ?? {}) as ConnectorAccountJsonObject;
}

function sha256Hex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function dateToMillis(value: Date | null | undefined): number | null {
  if (value == null) return null;
  return value.getTime();
}

function paramDateToDate(value: number | Date | null | undefined): Date | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  return value instanceof Date ? value : new Date(value);
}

function asJsonObject(value: unknown): ConnectorAccountJsonObject {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as ConnectorAccountJsonObject;
  }
  return {};
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.map((entry) => String(entry)) : [];
}

type ConnectorAccountRow = typeof connectorAccountsTable.$inferSelect;
type ConnectorCredentialRow = typeof connectorAccountCredentialsTable.$inferSelect;
type ConnectorAuditRow = typeof connectorAccountAuditEventsTable.$inferSelect;
type OAuthFlowRow = typeof oauthFlowsTable.$inferSelect;

function mapAccountRow(row: ConnectorAccountRow): ConnectorAccountRecord {
  return {
    id: row.id as UUID,
    agentId: row.agentId as UUID,
    provider: row.provider,
    accountKey: row.accountKey,
    externalId: row.externalId ?? null,
    displayName: row.displayName ?? null,
    username: row.username ?? null,
    email: row.email ?? null,
    role: row.role,
    purpose: asStringArray(row.purpose),
    accessGate: row.accessGate,
    status: row.status,
    scopes: asStringArray(row.scopes),
    capabilities: asStringArray(row.capabilities),
    profile: asJsonObject(row.profile),
    metadata: asJsonObject(row.metadata),
    connectedAt: row.connectedAt.getTime(),
    lastSyncAt: dateToMillis(row.lastSyncAt),
    deletedAt: dateToMillis(row.deletedAt),
    createdAt: row.createdAt.getTime(),
    updatedAt: row.updatedAt.getTime(),
  };
}

function mapCredentialRow(row: ConnectorCredentialRow): ConnectorAccountCredentialRefRecord {
  return {
    id: row.id as UUID,
    accountId: row.accountId as UUID,
    agentId: row.agentId as UUID,
    provider: row.provider,
    credentialType: row.credentialType,
    vaultRef: row.vaultRef,
    metadata: asJsonObject(row.metadata),
    expiresAt: dateToMillis(row.expiresAt),
    lastVerifiedAt: dateToMillis(row.lastVerifiedAt),
    createdAt: row.createdAt.getTime(),
    updatedAt: row.updatedAt.getTime(),
  };
}

function mapAuditRow(row: ConnectorAuditRow): ConnectorAccountAuditEventRecord {
  return {
    id: row.id as UUID,
    accountId: (row.accountId ?? null) as UUID | null,
    agentId: row.agentId as UUID,
    provider: row.provider,
    actorId: row.actorId ?? null,
    action: row.action,
    outcome: row.outcome as ConnectorAccountAuditOutcome,
    metadata: asJsonObject(row.metadata),
    createdAt: row.createdAt.getTime(),
  };
}

function mapOAuthFlowRow(row: OAuthFlowRow): OAuthFlowRecord {
  return {
    stateHash: row.stateHash,
    agentId: row.agentId as UUID,
    provider: row.provider,
    accountId: (row.accountId ?? null) as UUID | null,
    redirectUri: row.redirectUri ?? null,
    codeVerifierRef: row.codeVerifierRef ?? null,
    scopes: asStringArray(row.scopes),
    metadata: asJsonObject(row.metadata),
    createdAt: row.createdAt.getTime(),
    expiresAt: row.expiresAt.getTime(),
    consumedAt: dateToMillis(row.consumedAt),
    consumedBy: row.consumedBy ?? null,
  };
}

export interface ListConnectorAccountAuditEventsParams {
  agentId?: string;
  provider?: string;
  accountId?: string;
  action?: string;
  outcome?: string;
  limit?: number;
}

export class ConnectorAccountStore implements Store {
  constructor(public readonly ctx: StoreContext) {}

  private get db(): DrizzleDatabase {
    return this.ctx.getDb();
  }

  async listAccounts(
    params: ListConnectorAccountsParams = {}
  ): Promise<ConnectorAccountRecord[]> {
    return this.ctx.withRetry(async () => {
      const agentId = (params.agentId ?? this.ctx.agentId) as UUID;
      const conditions = [eq(connectorAccountsTable.agentId, agentId)];
      if (params.provider) {
        conditions.push(eq(connectorAccountsTable.provider, params.provider));
      }
      if (params.status) {
        conditions.push(eq(connectorAccountsTable.status, params.status));
      }
      const limit = params.limit ?? 100;
      const offset = params.offset ?? 0;
      const rows = await this.db
        .select()
        .from(connectorAccountsTable)
        .where(and(...conditions))
        .orderBy(desc(connectorAccountsTable.updatedAt), connectorAccountsTable.id)
        .limit(limit)
        .offset(offset);
      return rows.map(mapAccountRow);
    }, "ConnectorAccountStore.listAccounts");
  }

  async getAccount(params: GetConnectorAccountParams): Promise<ConnectorAccountRecord | null> {
    return this.ctx.withRetry(async () => {
      const conditions = [];
      if (params.id) {
        conditions.push(eq(connectorAccountsTable.id, params.id));
      } else {
        if (!params.provider || !params.accountKey) {
          throw new Error("getConnectorAccount requires id or provider + accountKey");
        }
        const agentId = (params.agentId ?? this.ctx.agentId) as UUID;
        conditions.push(
          eq(connectorAccountsTable.agentId, agentId),
          eq(connectorAccountsTable.provider, params.provider),
          eq(connectorAccountsTable.accountKey, params.accountKey)
        );
      }
      const rows = await this.db
        .select()
        .from(connectorAccountsTable)
        .where(and(...conditions))
        .limit(1);
      const row = rows[0];
      return row ? mapAccountRow(row) : null;
    }, "ConnectorAccountStore.getAccount");
  }

  async upsertAccount(params: UpsertConnectorAccountParams): Promise<ConnectorAccountRecord> {
    return this.ctx.withRetry(async () => {
      const agentId = (params.agentId ?? this.ctx.agentId) as UUID;
      const connectedAt = paramDateToDate(params.connectedAt);
      const lastSyncAt = paramDateToDate(params.lastSyncAt);
      const deletedAt = paramDateToDate(params.deletedAt);

      const insertValues: typeof connectorAccountsTable.$inferInsert = {
        agentId,
        provider: params.provider,
        accountKey: params.accountKey,
        externalId: params.externalId ?? null,
        displayName: params.displayName ?? null,
        username: params.username ?? null,
        email: params.email ?? null,
        role: params.role ?? "OWNER",
        purpose: params.purpose ? [...params.purpose] : ["messaging"],
        accessGate: params.accessGate ?? "open",
        status: params.status ?? "active",
        scopes: params.scopes ? [...params.scopes] : [],
        capabilities: params.capabilities ? [...params.capabilities] : [],
        profile: params.profile ?? {},
        metadata: params.metadata ?? {},
        ...(params.id ? { id: params.id } : {}),
        ...(connectedAt !== undefined ? { connectedAt: connectedAt ?? new Date() } : {}),
        ...(lastSyncAt !== undefined ? { lastSyncAt } : {}),
        ...(deletedAt !== undefined ? { deletedAt } : {}),
      };

      const updateSet: Record<string, unknown> = {
        updatedAt: new Date(),
      };
      if (params.externalId !== undefined) updateSet.externalId = params.externalId;
      if (params.displayName !== undefined) updateSet.displayName = params.displayName;
      if (params.username !== undefined) updateSet.username = params.username;
      if (params.email !== undefined) updateSet.email = params.email;
      if (params.role !== undefined) updateSet.role = params.role;
      if (params.purpose !== undefined) updateSet.purpose = [...params.purpose];
      if (params.accessGate !== undefined) updateSet.accessGate = params.accessGate;
      if (params.status !== undefined) updateSet.status = params.status;
      if (params.scopes !== undefined) updateSet.scopes = [...params.scopes];
      if (params.capabilities !== undefined) updateSet.capabilities = [...params.capabilities];
      if (params.profile !== undefined) updateSet.profile = params.profile;
      if (params.metadata !== undefined) updateSet.metadata = params.metadata;
      if (connectedAt !== undefined && connectedAt !== null) {
        updateSet.connectedAt = connectedAt;
      }
      if (lastSyncAt !== undefined) updateSet.lastSyncAt = lastSyncAt;
      if (deletedAt !== undefined) updateSet.deletedAt = deletedAt;

      const inserted = await this.db
        .insert(connectorAccountsTable)
        .values(insertValues)
        .onConflictDoUpdate({
          target: [
            connectorAccountsTable.agentId,
            connectorAccountsTable.provider,
            connectorAccountsTable.accountKey,
          ],
          set: updateSet,
        })
        .returning();

      const row = inserted[0];
      if (!row) {
        throw new Error("Failed to upsert connector account");
      }
      return mapAccountRow(row);
    }, "ConnectorAccountStore.upsertAccount");
  }

  async deleteAccount(params: DeleteConnectorAccountParams): Promise<boolean> {
    return this.ctx.withRetry(async () => {
      const conditions = [];
      if (params.id) {
        conditions.push(eq(connectorAccountsTable.id, params.id));
      } else {
        if (!params.provider || !params.accountKey) {
          throw new Error("deleteConnectorAccount requires id or provider + accountKey");
        }
        const agentId = (params.agentId ?? this.ctx.agentId) as UUID;
        conditions.push(
          eq(connectorAccountsTable.agentId, agentId),
          eq(connectorAccountsTable.provider, params.provider),
          eq(connectorAccountsTable.accountKey, params.accountKey)
        );
      }
      const now = new Date();
      const updated = await this.db
        .update(connectorAccountsTable)
        .set({ deletedAt: now, updatedAt: now })
        .where(and(...conditions))
        .returning();
      return updated.length > 0;
    }, "ConnectorAccountStore.deleteAccount");
  }

  async setCredentialRef(
    params: SetConnectorAccountCredentialRefParams
  ): Promise<ConnectorAccountCredentialRefRecord> {
    return this.ctx.withRetry(async () => {
      const account = await this.getAccount({ id: params.accountId });
      if (!account) {
        throw new Error(`Connector account not found: ${params.accountId}`);
      }
      const expiresAt = paramDateToDate(params.expiresAt);
      const lastVerifiedAt = paramDateToDate(params.lastVerifiedAt);

      const insertValues: typeof connectorAccountCredentialsTable.$inferInsert = {
        accountId: params.accountId,
        agentId: account.agentId,
        provider: account.provider,
        credentialType: params.credentialType,
        vaultRef: params.vaultRef,
        metadata: params.metadata ?? {},
        ...(expiresAt !== undefined ? { expiresAt } : {}),
        ...(lastVerifiedAt !== undefined ? { lastVerifiedAt } : {}),
      };

      const updateSet: Record<string, unknown> = {
        vaultRef: params.vaultRef,
        updatedAt: new Date(),
      };
      if (params.metadata !== undefined) updateSet.metadata = params.metadata;
      if (expiresAt !== undefined) updateSet.expiresAt = expiresAt;
      if (lastVerifiedAt !== undefined) updateSet.lastVerifiedAt = lastVerifiedAt;

      const inserted = await this.db
        .insert(connectorAccountCredentialsTable)
        .values(insertValues)
        .onConflictDoUpdate({
          target: [
            connectorAccountCredentialsTable.accountId,
            connectorAccountCredentialsTable.credentialType,
          ],
          set: updateSet,
        })
        .returning();

      const row = inserted[0];
      if (!row) {
        throw new Error("Failed to upsert connector account credential ref");
      }
      return mapCredentialRow(row);
    }, "ConnectorAccountStore.setCredentialRef");
  }

  async getCredentialRef(
    params: GetConnectorAccountCredentialRefParams
  ): Promise<ConnectorAccountCredentialRefRecord | null> {
    return this.ctx.withRetry(async () => {
      const rows = await this.db
        .select()
        .from(connectorAccountCredentialsTable)
        .where(
          and(
            eq(connectorAccountCredentialsTable.accountId, params.accountId),
            eq(connectorAccountCredentialsTable.credentialType, params.credentialType)
          )
        )
        .limit(1);
      const row = rows[0];
      return row ? mapCredentialRow(row) : null;
    }, "ConnectorAccountStore.getCredentialRef");
  }

  async listCredentialRefs(
    params: ListConnectorAccountCredentialRefsParams
  ): Promise<ConnectorAccountCredentialRefRecord[]> {
    return this.ctx.withRetry(async () => {
      const rows = await this.db
        .select()
        .from(connectorAccountCredentialsTable)
        .where(eq(connectorAccountCredentialsTable.accountId, params.accountId))
        .orderBy(
          desc(connectorAccountCredentialsTable.updatedAt),
          connectorAccountCredentialsTable.id
        );
      return rows.map(mapCredentialRow);
    }, "ConnectorAccountStore.listCredentialRefs");
  }

  async appendAuditEvent(
    params: AppendConnectorAccountAuditEventParams
  ): Promise<ConnectorAccountAuditEventRecord> {
    return this.ctx.withRetry(async () => {
      let agentId = (params.agentId ?? this.ctx.agentId) as UUID;
      let provider = params.provider;
      if (params.accountId && (!params.agentId || !provider)) {
        const account = await this.getAccount({ id: params.accountId });
        if (!account) {
          throw new Error(`Connector account not found: ${params.accountId}`);
        }
        agentId = account.agentId;
        provider = account.provider;
      }
      if (!provider) {
        throw new Error("appendConnectorAccountAuditEvent requires provider or accountId");
      }
      const createdAt = paramDateToDate(params.createdAt);
      const insertValues: typeof connectorAccountAuditEventsTable.$inferInsert = {
        accountId: params.accountId ?? null,
        agentId,
        provider,
        actorId: params.actorId ?? null,
        action: params.action,
        outcome: params.outcome ?? "success",
        metadata: redactConnectorAuditMetadata(params.metadata),
        ...(createdAt ? { createdAt } : {}),
      };
      const inserted = await this.db
        .insert(connectorAccountAuditEventsTable)
        .values(insertValues)
        .returning();
      const row = inserted[0];
      if (!row) {
        throw new Error("Failed to insert connector account audit event");
      }
      return mapAuditRow(row);
    }, "ConnectorAccountStore.appendAuditEvent");
  }

  async listAuditEvents(
    params: ListConnectorAccountAuditEventsParams = {}
  ): Promise<ConnectorAccountAuditEventRecord[]> {
    return this.ctx.withRetry(async () => {
      const conditions = [];
      const agentId = (params.agentId ?? this.ctx.agentId) as UUID;
      conditions.push(eq(connectorAccountAuditEventsTable.agentId, agentId));
      if (params.provider) {
        conditions.push(eq(connectorAccountAuditEventsTable.provider, params.provider));
      }
      if (params.accountId) {
        conditions.push(
          eq(connectorAccountAuditEventsTable.accountId, params.accountId as UUID)
        );
      }
      if (params.action) {
        conditions.push(eq(connectorAccountAuditEventsTable.action, params.action));
      }
      if (params.outcome) {
        conditions.push(eq(connectorAccountAuditEventsTable.outcome, params.outcome));
      }
      const limit = params.limit ?? 50;
      const rows = await this.db
        .select()
        .from(connectorAccountAuditEventsTable)
        .where(and(...conditions))
        .orderBy(
          desc(connectorAccountAuditEventsTable.createdAt),
          desc(connectorAccountAuditEventsTable.id)
        )
        .limit(limit);
      return rows.map(mapAuditRow);
    }, "ConnectorAccountStore.listAuditEvents");
  }

  async createOAuthFlowState(params: CreateOAuthFlowStateParams): Promise<OAuthFlowRecord> {
    return this.ctx.withRetry(async () => {
      const stateHash = sha256Hex(params.state);
      const agentId = (params.agentId ?? this.ctx.agentId) as UUID;
      const now = new Date();
      const explicitExpiresAt = paramDateToDate(params.expiresAt);
      const ttlMs = params.ttlMs ?? 10 * 60_000;
      const expiresAt = explicitExpiresAt ?? new Date(now.getTime() + ttlMs);

      const insertValues: typeof oauthFlowsTable.$inferInsert = {
        stateHash,
        agentId,
        provider: params.provider,
        accountId: params.accountId ?? null,
        redirectUri: params.redirectUri ?? null,
        codeVerifierRef: params.codeVerifierRef ?? null,
        scopes: params.scopes ? [...params.scopes] : [],
        metadata: params.metadata ?? {},
        expiresAt,
      };

      const inserted = await this.db
        .insert(oauthFlowsTable)
        .values(insertValues)
        .onConflictDoUpdate({
          target: oauthFlowsTable.stateHash,
          set: {
            agentId,
            provider: params.provider,
            accountId: params.accountId ?? null,
            redirectUri: params.redirectUri ?? null,
            codeVerifierRef: params.codeVerifierRef ?? null,
            scopes: params.scopes ? [...params.scopes] : [],
            metadata: params.metadata ?? {},
            expiresAt,
            consumedAt: null,
            consumedBy: null,
          },
        })
        .returning();

      const row = inserted[0];
      if (!row) {
        throw new Error("Failed to insert OAuth flow state");
      }
      return mapOAuthFlowRow(row);
    }, "ConnectorAccountStore.createOAuthFlowState");
  }

  async consumeOAuthFlowState(
    params: ConsumeOAuthFlowStateParams
  ): Promise<OAuthFlowRecord | null> {
    return this.ctx.withRetry(async () => {
      const stateHash = sha256Hex(params.state);
      const now = paramDateToDate(params.now) ?? new Date();
      const conditions = [
        eq(oauthFlowsTable.stateHash, stateHash),
        isNull(oauthFlowsTable.consumedAt),
        gt(oauthFlowsTable.expiresAt, now),
      ];
      if (params.agentId) {
        conditions.push(eq(oauthFlowsTable.agentId, params.agentId));
      }
      if (params.provider) {
        conditions.push(eq(oauthFlowsTable.provider, params.provider));
      }
      const updated = await this.db
        .update(oauthFlowsTable)
        .set({
          consumedAt: now,
          consumedBy: params.consumedBy ?? null,
        })
        .where(and(...conditions))
        .returning();
      const row = updated[0];
      return row ? mapOAuthFlowRow(row) : null;
    }, "ConnectorAccountStore.consumeOAuthFlowState");
  }
}
