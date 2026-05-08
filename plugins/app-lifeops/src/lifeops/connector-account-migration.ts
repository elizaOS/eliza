import type { IAgentRuntime } from "@elizaos/core";
import {
  executeRawSql,
  parseJsonArray,
  parseJsonRecord,
  sqlJson,
  sqlQuote,
  sqlText,
  toText,
} from "./sql.js";

export type LifeOpsConnectorAccountPurpose = "OWNER" | "AGENT" | "TEAM";

export interface LegacyLifeConnectorGrantRow {
  id: string;
  agentId: string;
  provider: string;
  connectorAccountId: string | null;
  side: string;
  identityJson: string;
  identityEmail: string | null;
  grantedScopesJson: string;
  capabilitiesJson: string;
  tokenRef: string | null;
  mode: string;
  executionTarget: string;
  sourceOfTruth: string;
  preferredByAgent: boolean;
  cloudConnectionId: string | null;
  metadataJson: string;
  lastRefreshAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ConnectorAccountMigrationAccountRow {
  id: string;
  agentId: string;
  provider: string;
  accountKey: string;
  metadata?: Record<string, unknown>;
}

export interface ConnectorAccountCredentialRow {
  accountId: string;
  credentialType: string;
  vaultRef: string;
}

export interface ConnectorAccountMigrationDraft {
  legacyGrantId: string;
  agentId: string;
  provider: string;
  accountKey: string;
  externalId: string | null;
  displayName: string | null;
  username: string | null;
  email: string | null;
  status: string;
  scopes: string[];
  capabilities: string[];
  profile: Record<string, unknown>;
  metadata: Record<string, unknown>;
  tokenRef: string | null;
  purpose: LifeOpsConnectorAccountPurpose;
  createdAt: string;
  updatedAt: string;
}

export interface ConnectorAccountGrantMigrationPlanItem {
  grant: LegacyLifeConnectorGrantRow;
  draft: ConnectorAccountMigrationDraft;
  existingAccount: ConnectorAccountMigrationAccountRow | null;
  existingCredential: ConnectorAccountCredentialRow | null;
}

export interface ConnectorAccountGrantMigrationSkip {
  grantId: string;
  reason: string;
}

export interface ConnectorAccountGrantMigrationPlan {
  items: ConnectorAccountGrantMigrationPlanItem[];
  skipped: ConnectorAccountGrantMigrationSkip[];
}

export interface CalendarCacheMigrationResult {
  backfilledEvents: number;
  backfilledSyncStates: number;
  markedEventsForPurgeResync: number;
  markedSyncStatesForPurgeResync: number;
  purgedEvents: number;
  purgedSyncStates: number;
}

export interface LifeConnectorGrantMigrationResult {
  dryRun: boolean;
  scannedGrants: number;
  plannedAccounts: number;
  createdAccounts: number;
  updatedAccounts: number;
  linkedGrants: number;
  preservedTokenRefs: number;
  skipped: ConnectorAccountGrantMigrationSkip[];
  calendarCache: CalendarCacheMigrationResult;
}

export interface LifeConnectorGrantMigrationOptions {
  agentId?: string;
  dryRun?: boolean;
  purgeCalendarLegacyCache?: boolean;
}

export interface LifeConnectorGrantMigrationStore {
  listLegacyConnectorGrants(
    agentId?: string,
  ): Promise<LegacyLifeConnectorGrantRow[]>;
  listConnectorAccounts(
    agentIds: readonly string[],
  ): Promise<ConnectorAccountMigrationAccountRow[]>;
  listConnectorAccountCredentials(
    accountIds: readonly string[],
  ): Promise<ConnectorAccountCredentialRow[]>;
  upsertConnectorAccount(
    draft: ConnectorAccountMigrationDraft,
  ): Promise<ConnectorAccountMigrationAccountRow>;
  setConnectorAccountCredentialRef(args: {
    accountId: string;
    agentId: string;
    provider: string;
    tokenRef: string;
    legacyGrantId: string;
  }): Promise<void>;
  updateLegacyGrantConnectorAccountId(args: {
    grantId: string;
    connectorAccountId: string;
    updatedAt: string;
  }): Promise<void>;
  migrateCalendarLegacyCache(args: {
    grantAccountIds: ReadonlyMap<string, string>;
    dryRun: boolean;
    purge: boolean;
    updatedAt: string;
  }): Promise<CalendarCacheMigrationResult>;
}

const LEGACY_TOKEN_CREDENTIAL_TYPE = "lifeops.legacy_token_ref";
const CALENDAR_AMBIGUOUS_REASON =
  "legacy_calendar_cache_ambiguous_grant_or_account";
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function emptyCalendarCacheMigrationResult(): CalendarCacheMigrationResult {
  return {
    backfilledEvents: 0,
    backfilledSyncStates: 0,
    markedEventsForPurgeResync: 0,
    markedSyncStatesForPurgeResync: 0,
    purgedEvents: 0,
    purgedSyncStates: 0,
  };
}

function normalizeOptionalString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function normalizeAccountKeySegment(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._@:-]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 160);
}

function safeJsonRecord(
  value: string,
  grantId: string,
): Record<string, unknown> {
  try {
    return parseJsonRecord(value);
  } catch {
    return {
      legacyParseError: `invalid identity/metadata JSON on grant ${grantId}`,
    };
  }
}

function safeJsonArray(value: string): string[] {
  try {
    return parseJsonArray<unknown>(value).filter(
      (item): item is string =>
        typeof item === "string" && item.trim().length > 0,
    );
  } catch {
    return [];
  }
}

function pickIdentityString(
  identity: Record<string, unknown>,
  keys: readonly string[],
): string | null {
  for (const key of keys) {
    const value = normalizeOptionalString(identity[key]);
    if (value) return value;
  }
  return null;
}

function deriveIdentityEmail(
  grant: LegacyLifeConnectorGrantRow,
  identity: Record<string, unknown>,
): string | null {
  return (
    normalizeOptionalString(grant.identityEmail)?.toLowerCase() ??
    pickIdentityString(identity, [
      "email",
      "emailAddress",
      "primaryEmail",
    ])?.toLowerCase() ??
    null
  );
}

function deriveAccountIdentityKey(
  grant: LegacyLifeConnectorGrantRow,
  identity: Record<string, unknown>,
): string {
  const identityValue =
    pickIdentityString(identity, [
      "sub",
      "id",
      "externalId",
      "accountId",
      "userId",
    ]) ??
    deriveIdentityEmail(grant, identity) ??
    pickIdentityString(identity, ["handle", "username", "login"]) ??
    normalizeOptionalString(grant.cloudConnectionId) ??
    grant.id;
  return (
    normalizeAccountKeySegment(identityValue) ||
    normalizeAccountKeySegment(grant.id)
  );
}

export function mapLifeOpsConnectorSideToPurpose(
  side: string,
): LifeOpsConnectorAccountPurpose {
  const normalized = side.trim().toLowerCase();
  if (normalized === "owner") return "OWNER";
  if (normalized === "agent") return "AGENT";
  return "TEAM";
}

export function buildConnectorAccountDraftFromGrant(
  grant: LegacyLifeConnectorGrantRow,
): ConnectorAccountMigrationDraft {
  const identity = safeJsonRecord(grant.identityJson, grant.id);
  const grantMetadata = safeJsonRecord(grant.metadataJson, grant.id);
  const purpose = mapLifeOpsConnectorSideToPurpose(grant.side);
  const accountIdentityKey = deriveAccountIdentityKey(grant, identity);
  const scopes = safeJsonArray(grant.grantedScopesJson);
  const capabilities = safeJsonArray(grant.capabilitiesJson);
  const email = deriveIdentityEmail(grant, identity);
  const displayName =
    pickIdentityString(identity, ["displayName", "name", "fullName"]) ?? email;
  const username = pickIdentityString(identity, [
    "username",
    "handle",
    "login",
  ]);
  const externalId = pickIdentityString(identity, [
    "sub",
    "id",
    "externalId",
    "accountId",
    "userId",
  ]);

  return {
    legacyGrantId: grant.id,
    agentId: grant.agentId,
    provider: grant.provider,
    accountKey: `lifeops:${purpose.toLowerCase()}:${accountIdentityKey}`,
    externalId,
    displayName,
    username,
    email,
    status: "connected",
    scopes,
    capabilities,
    profile: identity,
    metadata: {
      ...grantMetadata,
      lifeops: {
        ...(typeof grantMetadata.lifeops === "object" &&
        grantMetadata.lifeops !== null &&
        !Array.isArray(grantMetadata.lifeops)
          ? (grantMetadata.lifeops as Record<string, unknown>)
          : {}),
        legacyGrantId: grant.id,
        side: grant.side,
        purpose,
        mode: grant.mode,
        executionTarget: grant.executionTarget,
        sourceOfTruth: grant.sourceOfTruth,
        preferredByAgent: grant.preferredByAgent,
        cloudConnectionId: grant.cloudConnectionId,
        lastRefreshAt: grant.lastRefreshAt,
        migratedFrom: "life_connector_grants",
      },
    },
    tokenRef: grant.tokenRef,
    purpose,
    createdAt: grant.createdAt,
    updatedAt: grant.updatedAt,
  };
}

export function planLifeConnectorGrantMigration(args: {
  grants: readonly LegacyLifeConnectorGrantRow[];
  existingAccounts: readonly ConnectorAccountMigrationAccountRow[];
  existingCredentials?: readonly ConnectorAccountCredentialRow[];
}): ConnectorAccountGrantMigrationPlan {
  const existingByKey = new Map<string, ConnectorAccountMigrationAccountRow>();
  for (const account of args.existingAccounts) {
    existingByKey.set(
      `${account.agentId}:${account.provider}:${account.accountKey}`,
      account,
    );
  }

  const credentialsByAccountAndType = new Map<
    string,
    ConnectorAccountCredentialRow
  >();
  for (const credential of args.existingCredentials ?? []) {
    credentialsByAccountAndType.set(
      `${credential.accountId}:${credential.credentialType}`,
      credential,
    );
  }

  const items: ConnectorAccountGrantMigrationPlanItem[] = [];
  const skipped: ConnectorAccountGrantMigrationSkip[] = [];
  for (const grant of args.grants) {
    if (!UUID_PATTERN.test(grant.agentId)) {
      skipped.push({
        grantId: grant.id,
        reason: "agent_id is not UUID-compatible for connector_accounts",
      });
      continue;
    }
    const draft = buildConnectorAccountDraftFromGrant(grant);
    const existingAccount =
      existingByKey.get(
        `${draft.agentId}:${draft.provider}:${draft.accountKey}`,
      ) ?? null;
    const existingCredential = existingAccount
      ? (credentialsByAccountAndType.get(
          `${existingAccount.id}:${LEGACY_TOKEN_CREDENTIAL_TYPE}`,
        ) ?? null)
      : null;
    items.push({ grant, draft, existingAccount, existingCredential });
  }
  return { items, skipped };
}

export async function migrateLifeConnectorGrantsToConnectorAccounts(
  store: LifeConnectorGrantMigrationStore,
  options: LifeConnectorGrantMigrationOptions = {},
): Promise<LifeConnectorGrantMigrationResult> {
  const dryRun = options.dryRun !== false;
  const now = new Date().toISOString();
  const grants = await store.listLegacyConnectorGrants(options.agentId);
  const agentIds = Array.from(new Set(grants.map((grant) => grant.agentId)));
  const existingAccounts = await store.listConnectorAccounts(agentIds);
  const existingCredentials = await store.listConnectorAccountCredentials(
    existingAccounts.map((account) => account.id),
  );
  const plan = planLifeConnectorGrantMigration({
    grants,
    existingAccounts,
    existingCredentials,
  });

  const result: LifeConnectorGrantMigrationResult = {
    dryRun,
    scannedGrants: grants.length,
    plannedAccounts: plan.items.length,
    createdAccounts: plan.items.filter((item) => !item.existingAccount).length,
    updatedAccounts: plan.items.filter((item) => item.existingAccount).length,
    linkedGrants: 0,
    preservedTokenRefs: 0,
    skipped: [...plan.skipped],
    calendarCache: emptyCalendarCacheMigrationResult(),
  };

  const grantAccountIds = new Map<string, string>();
  for (const item of plan.items) {
    const knownAccountId =
      item.existingAccount?.id ?? item.grant.connectorAccountId;
    if (dryRun) {
      if (knownAccountId) grantAccountIds.set(item.grant.id, knownAccountId);
      if (
        item.grant.connectorAccountId &&
        item.grant.connectorAccountId === knownAccountId
      ) {
        result.linkedGrants += 1;
      }
      if (item.draft.tokenRef) result.preservedTokenRefs += 1;
      continue;
    }

    const account = await store.upsertConnectorAccount(item.draft);
    grantAccountIds.set(item.grant.id, account.id);
    if (item.grant.connectorAccountId !== account.id) {
      await store.updateLegacyGrantConnectorAccountId({
        grantId: item.grant.id,
        connectorAccountId: account.id,
        updatedAt: now,
      });
    }
    result.linkedGrants += 1;
    if (item.draft.tokenRef) {
      if (
        !item.existingCredential ||
        item.existingCredential.vaultRef !== item.draft.tokenRef
      ) {
        await store.setConnectorAccountCredentialRef({
          accountId: account.id,
          agentId: item.draft.agentId,
          provider: item.draft.provider,
          tokenRef: item.draft.tokenRef,
          legacyGrantId: item.grant.id,
        });
      }
      result.preservedTokenRefs += 1;
    }
  }

  result.calendarCache = await store.migrateCalendarLegacyCache({
    grantAccountIds,
    dryRun,
    purge: options.purgeCalendarLegacyCache === true,
    updatedAt: now,
  });

  return result;
}

function parseLegacyGrantRow(
  row: Record<string, unknown>,
): LegacyLifeConnectorGrantRow {
  return {
    id: toText(row.id),
    agentId: toText(row.agent_id),
    provider: toText(row.provider),
    connectorAccountId: normalizeOptionalString(row.connector_account_id),
    side: toText(row.side, "owner"),
    identityJson: toText(row.identity_json, "{}"),
    identityEmail: normalizeOptionalString(row.identity_email),
    grantedScopesJson: toText(row.granted_scopes_json, "[]"),
    capabilitiesJson: toText(row.capabilities_json, "[]"),
    tokenRef: normalizeOptionalString(row.token_ref),
    mode: toText(row.mode, "oauth"),
    executionTarget: toText(row.execution_target, "local"),
    sourceOfTruth: toText(row.source_of_truth, "local_storage"),
    preferredByAgent:
      row.preferred_by_agent === true || row.preferred_by_agent === 1,
    cloudConnectionId: normalizeOptionalString(row.cloud_connection_id),
    metadataJson: toText(row.metadata_json, "{}"),
    lastRefreshAt: normalizeOptionalString(row.last_refresh_at),
    createdAt: toText(row.created_at),
    updatedAt: toText(row.updated_at),
  };
}

function parseConnectorAccountRow(
  row: Record<string, unknown>,
): ConnectorAccountMigrationAccountRow {
  return {
    id: toText(row.id),
    agentId: toText(row.agent_id),
    provider: toText(row.provider),
    accountKey: toText(row.account_key),
    metadata:
      row.metadata &&
      typeof row.metadata === "object" &&
      !Array.isArray(row.metadata)
        ? (row.metadata as Record<string, unknown>)
        : undefined,
  };
}

function parseCredentialRow(
  row: Record<string, unknown>,
): ConnectorAccountCredentialRow {
  return {
    accountId: toText(row.account_id),
    credentialType: toText(row.credential_type),
    vaultRef: toText(row.vault_ref),
  };
}

function sqlIn(values: readonly string[]): string {
  return values.length > 0
    ? values.map((value) => sqlQuote(value)).join(", ")
    : sqlQuote("__none__");
}

async function countQuery(
  runtime: IAgentRuntime,
  query: string,
): Promise<number> {
  const rows = await executeMaybeMissingTable(runtime, query);
  return Number(rows[0]?.count ?? rows.length ?? 0);
}

async function executeMaybeMissingTable(
  runtime: IAgentRuntime,
  query: string,
): Promise<Array<Record<string, unknown>>> {
  try {
    return await executeRawSql(runtime, query);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (
      /does not exist|no such table|relation .* not found|undefined_table/i.test(
        message,
      )
    ) {
      return [];
    }
    throw error;
  }
}

export class RuntimeLifeConnectorGrantMigrationStore
  implements LifeConnectorGrantMigrationStore
{
  constructor(private readonly runtime: IAgentRuntime) {}

  async listLegacyConnectorGrants(
    agentId?: string,
  ): Promise<LegacyLifeConnectorGrantRow[]> {
    const where = agentId ? `WHERE agent_id = ${sqlQuote(agentId)}` : "";
    const rows = await executeMaybeMissingTable(
      this.runtime,
      `SELECT *
         FROM life_connector_grants
         ${where}
        ORDER BY agent_id ASC, provider ASC, created_at ASC`,
    );
    return rows.map(parseLegacyGrantRow);
  }

  async listConnectorAccounts(
    agentIds: readonly string[],
  ): Promise<ConnectorAccountMigrationAccountRow[]> {
    const uuidAgentIds = agentIds.filter((agentId) =>
      UUID_PATTERN.test(agentId),
    );
    if (uuidAgentIds.length === 0) return [];
    const rows = await executeMaybeMissingTable(
      this.runtime,
      `SELECT id, agent_id, provider, account_key, metadata
         FROM connector_accounts
        WHERE agent_id IN (${sqlIn(uuidAgentIds)})`,
    );
    return rows.map(parseConnectorAccountRow);
  }

  async listConnectorAccountCredentials(
    accountIds: readonly string[],
  ): Promise<ConnectorAccountCredentialRow[]> {
    if (accountIds.length === 0) return [];
    const rows = await executeMaybeMissingTable(
      this.runtime,
      `SELECT account_id, credential_type, vault_ref
         FROM connector_account_credentials
        WHERE account_id IN (${sqlIn(accountIds)})
          AND credential_type = ${sqlQuote(LEGACY_TOKEN_CREDENTIAL_TYPE)}`,
    );
    return rows.map(parseCredentialRow);
  }

  async upsertConnectorAccount(
    draft: ConnectorAccountMigrationDraft,
  ): Promise<ConnectorAccountMigrationAccountRow> {
    const rows = await executeRawSql(
      this.runtime,
      `INSERT INTO connector_accounts (
        agent_id, provider, account_key, external_id, display_name, username,
        email, status, scopes, capabilities, profile, metadata, connected_at,
        created_at, updated_at
      ) VALUES (
        ${sqlQuote(draft.agentId)},
        ${sqlQuote(draft.provider)},
        ${sqlQuote(draft.accountKey)},
        ${sqlText(draft.externalId)},
        ${sqlText(draft.displayName)},
        ${sqlText(draft.username)},
        ${sqlText(draft.email)},
        ${sqlQuote(draft.status)},
        ${sqlJson(draft.scopes)}::jsonb,
        ${sqlJson(draft.capabilities)}::jsonb,
        ${sqlJson(draft.profile)}::jsonb,
        ${sqlJson(draft.metadata)}::jsonb,
        ${sqlQuote(draft.createdAt)}::timestamptz,
        ${sqlQuote(draft.createdAt)}::timestamptz,
        ${sqlQuote(draft.updatedAt)}::timestamptz
      )
      ON CONFLICT(agent_id, provider, account_key) DO UPDATE SET
        external_id = excluded.external_id,
        display_name = excluded.display_name,
        username = excluded.username,
        email = excluded.email,
        status = excluded.status,
        scopes = excluded.scopes,
        capabilities = excluded.capabilities,
        profile = excluded.profile,
        metadata = connector_accounts.metadata || excluded.metadata,
        updated_at = excluded.updated_at,
        deleted_at = NULL
      RETURNING id, agent_id, provider, account_key, metadata`,
    );
    const row = rows[0];
    if (!row) throw new Error("Failed to upsert connector account");
    return parseConnectorAccountRow(row);
  }

  async setConnectorAccountCredentialRef(args: {
    accountId: string;
    agentId: string;
    provider: string;
    tokenRef: string;
    legacyGrantId: string;
  }): Promise<void> {
    await executeRawSql(
      this.runtime,
      `INSERT INTO connector_account_credentials (
        account_id, agent_id, provider, credential_type, vault_ref, metadata,
        created_at, updated_at
      ) VALUES (
        ${sqlQuote(args.accountId)},
        ${sqlQuote(args.agentId)},
        ${sqlQuote(args.provider)},
        ${sqlQuote(LEGACY_TOKEN_CREDENTIAL_TYPE)},
        ${sqlQuote(args.tokenRef)},
        ${sqlJson({ lifeopsLegacyGrantId: args.legacyGrantId })}::jsonb,
        now(),
        now()
      )
      ON CONFLICT(account_id, credential_type) DO UPDATE SET
        vault_ref = excluded.vault_ref,
        metadata = connector_account_credentials.metadata || excluded.metadata,
        updated_at = now()`,
    );
  }

  async updateLegacyGrantConnectorAccountId(args: {
    grantId: string;
    connectorAccountId: string;
    updatedAt: string;
  }): Promise<void> {
    await executeRawSql(
      this.runtime,
      `UPDATE life_connector_grants
          SET connector_account_id = ${sqlQuote(args.connectorAccountId)},
              updated_at = ${sqlQuote(args.updatedAt)}
        WHERE id = ${sqlQuote(args.grantId)}`,
    );
  }

  async migrateCalendarLegacyCache(args: {
    grantAccountIds: ReadonlyMap<string, string>;
    dryRun: boolean;
    purge: boolean;
    updatedAt: string;
  }): Promise<CalendarCacheMigrationResult> {
    await this.ensureCalendarMigrationColumns();
    const result = emptyCalendarCacheMigrationResult();
    if (args.grantAccountIds.size > 0) {
      for (const [grantId, accountId] of args.grantAccountIds.entries()) {
        if (args.dryRun) {
          result.backfilledEvents += await countQuery(
            this.runtime,
            `SELECT COUNT(*) AS count
               FROM life_calendar_events
              WHERE grant_id = ${sqlQuote(grantId)}
                AND connector_account_id IS NULL`,
          );
          result.backfilledSyncStates += await countQuery(
            this.runtime,
            `SELECT COUNT(*) AS count
               FROM life_calendar_sync_states
              WHERE grant_id = ${sqlQuote(grantId)}
                AND connector_account_id IS NULL`,
          );
          continue;
        }
        const eventRows = await executeMaybeMissingTable(
          this.runtime,
          `UPDATE life_calendar_events
              SET connector_account_id = ${sqlQuote(accountId)},
                  updated_at = ${sqlQuote(args.updatedAt)}
            WHERE grant_id = ${sqlQuote(grantId)}
              AND connector_account_id IS NULL
            RETURNING id`,
        );
        result.backfilledEvents += eventRows.length;

        const syncRows = await executeMaybeMissingTable(
          this.runtime,
          `UPDATE life_calendar_sync_states
              SET connector_account_id = ${sqlQuote(accountId)},
                  updated_at = ${sqlQuote(args.updatedAt)}
            WHERE grant_id = ${sqlQuote(grantId)}
              AND connector_account_id IS NULL
            RETURNING id`,
        );
        result.backfilledSyncStates += syncRows.length;
      }
    }

    if (args.dryRun) {
      result.markedEventsForPurgeResync = await countQuery(
        this.runtime,
        `SELECT COUNT(*) AS count
           FROM life_calendar_events
          WHERE connector_account_id IS NULL
            AND (
              grant_id IS NULL
              OR grant_id = ''
              OR NOT EXISTS (
                SELECT 1
                  FROM life_connector_grants
                 WHERE life_connector_grants.id = life_calendar_events.grant_id
                   AND life_connector_grants.connector_account_id IS NOT NULL
              )
            )`,
      );
      result.markedSyncStatesForPurgeResync = await countQuery(
        this.runtime,
        `SELECT COUNT(*) AS count
           FROM life_calendar_sync_states
          WHERE connector_account_id IS NULL
            AND (
              grant_id IS NULL
              OR grant_id = ''
              OR NOT EXISTS (
                SELECT 1
                  FROM life_connector_grants
                 WHERE life_connector_grants.id = life_calendar_sync_states.grant_id
                   AND life_connector_grants.connector_account_id IS NOT NULL
              )
            )`,
      );
      return result;
    }

    const markedEvents = await executeMaybeMissingTable(
      this.runtime,
      `UPDATE life_calendar_events
          SET purge_resync_required = TRUE,
              purge_resync_reason = ${sqlQuote(CALENDAR_AMBIGUOUS_REASON)},
              updated_at = ${sqlQuote(args.updatedAt)}
        WHERE connector_account_id IS NULL
          AND (
            grant_id IS NULL
            OR grant_id = ''
            OR NOT EXISTS (
              SELECT 1
                FROM life_connector_grants
               WHERE life_connector_grants.id = life_calendar_events.grant_id
                 AND life_connector_grants.connector_account_id IS NOT NULL
            )
          )
        RETURNING id`,
    );
    result.markedEventsForPurgeResync = markedEvents.length;

    const markedSyncStates = await executeMaybeMissingTable(
      this.runtime,
      `UPDATE life_calendar_sync_states
          SET purge_resync_required = TRUE,
              purge_resync_reason = ${sqlQuote(CALENDAR_AMBIGUOUS_REASON)},
              updated_at = ${sqlQuote(args.updatedAt)}
        WHERE connector_account_id IS NULL
          AND (
            grant_id IS NULL
            OR grant_id = ''
            OR NOT EXISTS (
              SELECT 1
                FROM life_connector_grants
               WHERE life_connector_grants.id = life_calendar_sync_states.grant_id
                 AND life_connector_grants.connector_account_id IS NOT NULL
            )
          )
        RETURNING id`,
    );
    result.markedSyncStatesForPurgeResync = markedSyncStates.length;

    if (args.purge) {
      const purgedEvents = await executeMaybeMissingTable(
        this.runtime,
        `DELETE FROM life_calendar_events
          WHERE purge_resync_required = TRUE
        RETURNING id`,
      );
      result.purgedEvents = purgedEvents.length;
      const purgedSyncStates = await executeMaybeMissingTable(
        this.runtime,
        `DELETE FROM life_calendar_sync_states
          WHERE purge_resync_required = TRUE
        RETURNING id`,
      );
      result.purgedSyncStates = purgedSyncStates.length;
    }

    return result;
  }

  private async ensureCalendarMigrationColumns(): Promise<void> {
    await executeMaybeMissingTable(
      this.runtime,
      "ALTER TABLE life_calendar_events ADD COLUMN IF NOT EXISTS purge_resync_required BOOLEAN NOT NULL DEFAULT FALSE",
    );
    await executeMaybeMissingTable(
      this.runtime,
      "ALTER TABLE life_calendar_events ADD COLUMN IF NOT EXISTS purge_resync_reason TEXT",
    );
    await executeMaybeMissingTable(
      this.runtime,
      "ALTER TABLE life_calendar_sync_states ADD COLUMN IF NOT EXISTS connector_account_id TEXT",
    );
    await executeMaybeMissingTable(
      this.runtime,
      "ALTER TABLE life_calendar_sync_states ADD COLUMN IF NOT EXISTS purge_resync_required BOOLEAN NOT NULL DEFAULT FALSE",
    );
    await executeMaybeMissingTable(
      this.runtime,
      "ALTER TABLE life_calendar_sync_states ADD COLUMN IF NOT EXISTS purge_resync_reason TEXT",
    );
  }
}

export function createRuntimeLifeConnectorGrantMigrationStore(
  runtime: IAgentRuntime,
): RuntimeLifeConnectorGrantMigrationStore {
  return new RuntimeLifeConnectorGrantMigrationStore(runtime);
}

export async function migrateRuntimeLifeConnectorGrantsToConnectorAccounts(
  runtime: IAgentRuntime,
  options: LifeConnectorGrantMigrationOptions = {},
): Promise<LifeConnectorGrantMigrationResult> {
  return migrateLifeConnectorGrantsToConnectorAccounts(
    createRuntimeLifeConnectorGrantMigrationStore(runtime),
    options,
  );
}

export const lifeOpsConnectorGrantMigrationConstants = {
  legacyTokenCredentialType: LEGACY_TOKEN_CREDENTIAL_TYPE,
  calendarAmbiguousReason: CALENDAR_AMBIGUOUS_REASON,
} as const;
