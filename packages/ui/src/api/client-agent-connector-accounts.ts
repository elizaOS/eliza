/**
 * Connector-account transport contracts and response normalization for the
 * agent client. Server vocabulary is validated here so UI consumers receive a
 * stable role, status, and metadata shape.
 */

export type ConnectorAccountRole = "OWNER" | "AGENT" | "TEAM";
export type ConnectorAccountPurpose =
  | "messaging"
  | "posting"
  | "reading"
  | "admin"
  | "automation"
  | (string & {});
export type ConnectorAccountPrivacy =
  | "owner_only"
  | "team_visible"
  | "semi_public"
  | "public";
export type ConnectorAccountStatus =
  | "connected"
  | "pending"
  | "needs-reauth"
  | "disconnected"
  | "error"
  | "unknown";

export interface ConnectorAccountRecord {
  id: string;
  provider: string;
  connectorId: string;
  label: string;
  handle?: string | null;
  externalId?: string | null;
  avatarUrl?: string | null;
  status?: ConnectorAccountStatus;
  statusDetail?: string | null;
  role?: ConnectorAccountRole;
  purpose?: ConnectorAccountPurpose[];
  privacy?: ConnectorAccountPrivacy;
  isDefault?: boolean;
  enabled?: boolean;
  createdAt?: number;
  updatedAt?: number;
  lastSyncedAt?: number;
  metadata?: Record<string, unknown>;
}

export interface ConnectorAccountsListResponse {
  provider: string;
  connectorId: string;
  defaultAccountId?: string | null;
  accounts: ConnectorAccountRecord[];
}

export interface ConnectorAccountCreateInput {
  label?: string;
  role?: ConnectorAccountRole;
  purpose?: ConnectorAccountPurpose | ConnectorAccountPurpose[];
  privacy?: ConnectorAccountPrivacy;
  metadata?: Record<string, unknown>;
  confirmation?: {
    role?: string;
    privacy?: string;
    publicAcknowledged?: boolean;
  };
}

export interface ConnectorAccountUpdateInput
  extends ConnectorAccountCreateInput {
  enabled?: boolean;
}

export interface ConnectorAccountOAuthStartInput {
  redirectUri?: string;
  accountId?: string;
  label?: string;
  scopes?: string[];
  metadata?: Record<string, unknown>;
}

export interface ConnectorAccountActionResult {
  ok: boolean;
  account?: ConnectorAccountRecord;
  accounts?: ConnectorAccountRecord[];
  defaultAccountId?: string | null;
  authUrl?: string;
  flow?: Record<string, unknown>;
  status?: ConnectorAccountStatus | string;
  error?: string;
}

export interface ConnectorAccountAuditEventRecord {
  id: string;
  accountId?: string | null;
  agentId?: string;
  provider: string;
  actorId?: string | null;
  action: string;
  outcome: "success" | "failure" | string;
  metadata?: Record<string, unknown>;
  createdAt?: number;
}

export interface ConnectorAccountAuditEventsQuery {
  accountId?: string;
  action?: string;
  outcome?: "success" | "failure";
  limit?: number;
}

export interface ConnectorAccountAuditEventsResponse {
  provider: string;
  events: ConnectorAccountAuditEventRecord[];
}

export const CONNECTOR_SERVER_ROLE_TO_UI_ROLE: Readonly<
  Record<string, ConnectorAccountRole>
> = {
  OWNER: "OWNER",
  AGENT: "AGENT",
  SERVICE: "AGENT",
  TEAM: "TEAM",
  ADMIN: "TEAM",
  MEMBER: "TEAM",
  VIEWER: "TEAM",
};

function normalizeRole(value: unknown): ConnectorAccountRole | undefined {
  if (typeof value !== "string" || !value.trim()) return undefined;
  return CONNECTOR_SERVER_ROLE_TO_UI_ROLE[value.trim().toUpperCase()];
}

function normalizeStatus(value: unknown): ConnectorAccountStatus {
  switch (value) {
    case "connected":
    case "pending":
    case "needs-reauth":
    case "disconnected":
    case "error":
      return value;
    case "disabled":
    case "revoked":
      return "disconnected";
    default:
      return "unknown";
  }
}

function recordFromUnknown(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

function normalizePurposes(value: unknown): ConnectorAccountPurpose[] {
  const values = Array.isArray(value)
    ? value
    : typeof value === "string"
      ? [value]
      : [];
  return values
    .map((item) => (typeof item === "string" ? item.trim() : ""))
    .filter(
      (item): item is ConnectorAccountPurpose =>
        Boolean(item) && normalizeRole(item) === undefined,
    );
}

export function normalizeConnectorAccountRecord(
  provider: string,
  connectorId: string,
  raw: unknown,
): ConnectorAccountRecord {
  const record = recordFromUnknown(raw);
  const role = normalizeRole(record.role) ?? normalizeRole(record.purpose);
  return {
    ...(record as Partial<ConnectorAccountRecord>),
    id: String(record.id ?? ""),
    provider: nonEmptyString(record.provider) ?? provider,
    connectorId,
    label:
      nonEmptyString(record.label) ??
      nonEmptyString(record.displayHandle) ??
      nonEmptyString(record.handle) ??
      nonEmptyString(record.externalId) ??
      String(record.id ?? "unknown"),
    handle:
      nonEmptyString(record.handle) ?? nonEmptyString(record.displayHandle),
    externalId:
      typeof record.externalId === "string" ? record.externalId : null,
    status: normalizeStatus(record.status),
    role,
    purpose: normalizePurposes(record.purpose),
    isDefault: record.isDefault === true,
    enabled: record.enabled !== false,
    metadata:
      record.metadata &&
      typeof record.metadata === "object" &&
      !Array.isArray(record.metadata)
        ? (record.metadata as Record<string, unknown>)
        : undefined,
  };
}

export function normalizeConnectorAccountsListResponse(
  provider: string,
  connectorId: string,
  raw: unknown,
): ConnectorAccountsListResponse {
  const record = recordFromUnknown(raw);
  const accounts = Array.isArray(record.accounts)
    ? record.accounts.map((item) =>
        normalizeConnectorAccountRecord(provider, connectorId, item),
      )
    : [];
  return {
    provider: nonEmptyString(record.provider) ?? provider,
    connectorId,
    defaultAccountId:
      typeof record.defaultAccountId === "string"
        ? record.defaultAccountId
        : (accounts.find(
            (account) =>
              account.isDefault === true &&
              account.enabled !== false &&
              account.status === "connected",
          )?.id ?? null),
    accounts,
  };
}

export function normalizeConnectorAccountActionResult(
  provider: string,
  connectorId: string,
  raw: unknown,
): ConnectorAccountActionResult {
  const record = recordFromUnknown(raw);
  const account =
    record.account ?? (typeof record.id === "string" ? record : null);
  const flow = recordFromUnknown(record.flow);
  const authUrl =
    nonEmptyString(record.authUrl) ?? nonEmptyString(flow.authUrl) ?? undefined;
  const flowError = nonEmptyString(flow.error) ?? undefined;
  return {
    ...(record as Partial<ConnectorAccountActionResult>),
    ok:
      typeof record.ok === "boolean"
        ? record.ok
        : record.deleted === true ||
          (!("error" in record) &&
            flowError === undefined &&
            (account !== null || authUrl !== undefined)),
    account: account
      ? normalizeConnectorAccountRecord(provider, connectorId, account)
      : undefined,
    accounts: Array.isArray(record.accounts)
      ? record.accounts.map((item) =>
          normalizeConnectorAccountRecord(provider, connectorId, item),
        )
      : undefined,
    defaultAccountId:
      typeof record.defaultAccountId === "string"
        ? record.defaultAccountId
        : null,
    flow: Object.keys(flow).length > 0 ? flow : undefined,
    authUrl,
    status:
      typeof record.status === "string"
        ? normalizeStatus(record.status)
        : typeof flow.status === "string"
          ? normalizeStatus(flow.status)
          : undefined,
    error: nonEmptyString(record.error) ?? flowError,
  };
}

export function connectorAccountsPath(
  provider: string,
  _connectorId?: string,
  accountId?: string,
  action?: "test" | "refresh" | "default",
): string {
  const base = `/api/connectors/${encodeURIComponent(provider)}/accounts`;
  if (!accountId) return base;
  const withAccount = `${base}/${encodeURIComponent(accountId)}`;
  return action ? `${withAccount}/${action}` : withAccount;
}

export function connectorAccountOAuthPath(
  provider: string,
  action: "start" | "status",
): string {
  return `/api/connectors/${encodeURIComponent(provider)}/oauth/${action}`;
}

export function connectorAccountAuditPath(
  provider: string,
  query: ConnectorAccountAuditEventsQuery = {},
): string {
  const params = new URLSearchParams();
  if (query.accountId) params.set("accountId", query.accountId);
  if (query.action) params.set("action", query.action);
  if (query.outcome) params.set("outcome", query.outcome);
  if (typeof query.limit === "number") params.set("limit", String(query.limit));
  const queryString = params.toString();
  return `/api/connectors/${encodeURIComponent(provider)}/audit/events${queryString ? `?${queryString}` : ""}`;
}
