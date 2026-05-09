import type http from "node:http";
import {
  type ConnectorAccount,
  type ConnectorAccountPatch,
  type ConnectorAccountPurpose,
  type ConnectorAccountRole,
  type ConnectorAccountStatus,
  type ConnectorOAuthFlow,
  DEFAULT_PRIVACY_LEVEL,
  getConnectorAccountManager,
  isPrivacyLevel,
  type Metadata,
} from "@elizaos/core";
import type { infer as ZodInfer } from "zod";
import * as zod from "zod";
import type { ReadJsonBodyOptions } from "@elizaos/shared";

const z = zod.z ?? zod;

export interface ConnectorAccountRouteContext {
  req: http.IncomingMessage;
  res: http.ServerResponse;
  method: string;
  pathname: string;
  state: {
    runtime: import("@elizaos/core").IAgentRuntime | null;
  };
  json: (res: http.ServerResponse, data: unknown, status?: number) => void;
  error: (res: http.ServerResponse, message: string, status?: number) => void;
  readJsonBody: <T extends object>(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    options?: ReadJsonBodyOptions,
  ) => Promise<T | null>;
  authorize?: (
    request: ConnectorAccountRouteAuthorizationRequest,
  ) => boolean | Promise<boolean>;
}

export interface ConnectorAccountRouteAuthorizationRequest {
  provider: string;
  namespace: "accounts" | "oauth" | "audit";
  method: string;
  pathname: string;
  action?: string;
  accountId?: string;
}

const CONNECTORS_PREFIX = "/api/connectors/";

const metadataSchema = z.record(z.string(), z.unknown()).optional();
const privacyLevelSchema = z.enum([
  "owner_only",
  "team_visible",
  "semi_public",
  "public",
]);
const confirmationSchema = z
  .object({
    role: z.string().trim().min(1).max(80).optional(),
    privacy: z.string().trim().min(1).max(80).optional(),
    publicAcknowledged: z.boolean().optional(),
  })
  .optional();
const AUDIT_REDACTED = "[REDACTED]";
const AUDIT_SECRET_KEY_PATTERN =
  /(access|refresh|id)?_?token|secret|password|credential|authorization|cookie|code[_-]?verifier|codeVerifier|client[_-]?secret|api_?key|private_?key|oauth_?code|state/i;
const CLIENT_RESERVED_METADATA_KEYS = new Set([
  "accessgate",
  "credentialrefs",
  "credentialrefstorage",
  "isdefault",
  "oauthcredentialrefs",
  "oauthcredentialversion",
  "ownerbindingid",
  "owneridentityid",
  "privacy",
  "purpose",
  "role",
  "status",
]);

const accountInputSchema = z.object({
  id: z.string().trim().min(1).max(200).optional(),
  label: z.string().trim().min(1).max(200).optional(),
  role: z.string().trim().min(1).max(80).optional(),
  purpose: z
    .union([
      z.string().trim().min(1).max(80),
      z.array(z.string().trim().min(1).max(80)).min(1).max(20),
    ])
    .optional(),
  accessGate: z.string().trim().min(1).max(80).optional(),
  status: z.string().trim().min(1).max(80).optional(),
  enabled: z.boolean().optional(),
  privacy: privacyLevelSchema.optional(),
  externalId: z.string().trim().min(1).max(500).optional(),
  displayHandle: z.string().trim().min(1).max(500).optional(),
  ownerBindingId: z.string().trim().min(1).max(200).optional(),
  ownerIdentityId: z.string().trim().min(1).max(200).optional(),
  metadata: metadataSchema,
  confirmation: confirmationSchema,
});

const accountPatchSchema = accountInputSchema
  .omit({ id: true })
  .extend({
    externalId: z
      .union([z.string().trim().min(1).max(500), z.null()])
      .optional(),
    displayHandle: z
      .union([z.string().trim().min(1).max(500), z.null()])
      .optional(),
    ownerBindingId: z
      .union([z.string().trim().min(1).max(200), z.null()])
      .optional(),
    ownerIdentityId: z
      .union([z.string().trim().min(1).max(200), z.null()])
      .optional(),
  })
  .refine((value) => Object.keys(value).length > 0, {
    message: "PATCH body must include at least one account field",
  });

const oauthStartSchema = z.object({
  redirectUri: z.string().trim().url().optional(),
  accountId: z.string().trim().min(1).max(200).optional(),
  label: z.string().trim().min(1).max(200).optional(),
  scopes: z.array(z.string().trim().min(1).max(120)).max(50).optional(),
  metadata: metadataSchema,
});

function normalizeConnectorAccountRoleValue(
  value: unknown,
): ConnectorAccountRole | undefined {
  if (typeof value !== "string" || !value.trim()) return undefined;
  const normalized = value.trim().toUpperCase();
  switch (normalized) {
    case "OWNER":
      return "OWNER";
    case "AGENT":
    case "SERVICE":
      return "AGENT";
    case "TEAM":
    case "ADMIN":
    case "MEMBER":
    case "VIEWER":
      return "TEAM";
    default:
      return normalized as ConnectorAccountRole;
  }
}

function isConnectorAccountRoleValue(value: unknown): boolean {
  return (
    typeof value === "string" &&
    ["OWNER", "AGENT", "TEAM"].includes(value.trim().toUpperCase())
  );
}

function normalizeConnectorAccountStatus(
  status: ConnectorAccountStatus,
): string {
  switch (status) {
    case "disabled":
    case "revoked":
      return "disconnected";
    default:
      return status;
  }
}

const PRIVACY_RANK: Record<ZodInfer<typeof privacyLevelSchema>, number> = {
  owner_only: 0,
  team_visible: 1,
  semi_public: 2,
  public: 3,
};

function accountPrivacy(
  account: ConnectorAccount,
): ZodInfer<typeof privacyLevelSchema> {
  const value = account.metadata?.privacy;
  return isPrivacyLevel(value) ? value : DEFAULT_PRIVACY_LEVEL;
}

function requiresOwnerRoleConfirmation(
  existing: ConnectorAccount,
  requestedRole: unknown,
): boolean {
  return (
    normalizeConnectorAccountRoleValue(requestedRole) === "OWNER" &&
    normalizeConnectorAccountRoleValue(existing.role) !== "OWNER"
  );
}

function hasOwnerRoleConfirmation(
  confirmation: ZodInfer<typeof confirmationSchema>,
): boolean {
  return confirmation?.role?.trim().toUpperCase() === "OWNER";
}

function requiresPrivacyConfirmation(
  existing: ConnectorAccount,
  requestedPrivacy: ZodInfer<typeof privacyLevelSchema> | undefined,
): boolean {
  return Boolean(
    requestedPrivacy &&
      PRIVACY_RANK[requestedPrivacy] > PRIVACY_RANK[accountPrivacy(existing)],
  );
}

function hasPrivacyConfirmation(
  confirmation: ZodInfer<typeof confirmationSchema>,
  requestedPrivacy: ZodInfer<typeof privacyLevelSchema>,
): boolean {
  const phrase = confirmation?.privacy?.trim().toUpperCase();
  if (requestedPrivacy === "public") {
    return phrase === "PUBLIC" && confirmation?.publicAcknowledged === true;
  }
  return phrase === "SHARE";
}

function parseConnectorScopedPath(pathname: string): {
  provider: string;
  namespace: "accounts" | "oauth" | "audit";
  rest: string[];
} | null {
  if (!pathname.startsWith(CONNECTORS_PREFIX)) {
    return null;
  }
  const segments = pathname
    .slice(CONNECTORS_PREFIX.length)
    .split("/")
    .filter(Boolean)
    .map((segment) => decodeURIComponent(segment));
  if (segments.length < 2) return null;
  const provider = segments[0]?.trim().toLowerCase() ?? "";
  const namespace = segments[1];
  if (
    !provider ||
    (namespace !== "accounts" && namespace !== "oauth" && namespace !== "audit")
  ) {
    return null;
  }
  return {
    provider,
    namespace,
    rest: segments.slice(2),
  };
}

function isUnauthenticatedOAuthCallback(
  parsedPath: NonNullable<ReturnType<typeof parseConnectorScopedPath>>,
  method: string,
): boolean {
  return (
    parsedPath.namespace === "oauth" &&
    parsedPath.rest[0] === "callback" &&
    (method === "GET" || method === "POST")
  );
}

function authorizationRequestForPath(
  parsedPath: NonNullable<ReturnType<typeof parseConnectorScopedPath>>,
  method: string,
  pathname: string,
): ConnectorAccountRouteAuthorizationRequest {
  const [first, second] = parsedPath.rest;
  const accountId =
    parsedPath.namespace === "accounts" && first && first !== "events"
      ? first
      : undefined;
  const action =
    parsedPath.namespace === "accounts"
      ? second
      : parsedPath.namespace === "oauth" || parsedPath.namespace === "audit"
        ? first
        : undefined;
  return {
    provider: parsedPath.provider,
    namespace: parsedPath.namespace,
    method,
    pathname,
    ...(action ? { action } : {}),
    ...(accountId ? { accountId } : {}),
  };
}

function isBlockedObjectKey(key: string): boolean {
  return key === "__proto__" || key === "constructor" || key === "prototype";
}

function normalizeMetadataKey(key: string): string {
  return key.replace(/[-_\s]/g, "").toLowerCase();
}

function isClientReservedMetadataKey(key: string): boolean {
  return CLIENT_RESERVED_METADATA_KEYS.has(normalizeMetadataKey(key));
}

function cleanMetadataValue(value: unknown): unknown {
  if (value === null || value === undefined) return value;
  if (Array.isArray(value)) {
    return value.map((item) => cleanMetadataValue(item));
  }
  if (typeof value !== "object") return value;

  const cleaned: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (
      isBlockedObjectKey(key) ||
      AUDIT_SECRET_KEY_PATTERN.test(key) ||
      isClientReservedMetadataKey(key)
    ) {
      continue;
    }
    cleaned[key] = cleanMetadataValue(item);
  }
  return cleaned;
}

function cleanMetadata(value: unknown): Metadata | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const cleaned = cleanMetadataValue(value) as Record<string, unknown>;
  return cleaned as Metadata;
}

function redactAuditMetadata(value: unknown): unknown {
  if (value === null || value === undefined) return value;
  if (Array.isArray(value))
    return value.map((item) => redactAuditMetadata(item));
  if (typeof value !== "object") return value;

  const redacted: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    redacted[key] = AUDIT_SECRET_KEY_PATTERN.test(key)
      ? AUDIT_REDACTED
      : redactAuditMetadata(item);
  }
  return redacted;
}

function accountPatchFromBody(
  body:
    | ZodInfer<typeof accountInputSchema>
    | ZodInfer<typeof accountPatchSchema>,
  baseMetadata?: Metadata,
): ConnectorAccountPatch {
  const purposeValues = Array.isArray(body.purpose)
    ? body.purpose
    : body.purpose
      ? [body.purpose]
      : [];
  const role =
    normalizeConnectorAccountRoleValue(body.role) ??
    purposeValues
      .map((value: string) => normalizeConnectorAccountRoleValue(value))
      .find((value): value is ConnectorAccountRole => Boolean(value));
  const purposeValuesWithoutRoles = purposeValues.filter(
    (value: string) => !isConnectorAccountRoleValue(value),
  ) as ConnectorAccountPurpose[];
  const purpose =
    purposeValuesWithoutRoles.length === 0
      ? undefined
      : Array.isArray(body.purpose)
        ? purposeValuesWithoutRoles
        : purposeValuesWithoutRoles[0];
  const metadata = cleanMetadata(body.metadata);
  const nextMetadata =
    metadata || body.privacy
      ? ({
          ...(baseMetadata ?? {}),
          ...(metadata ?? {}),
          ...(body.privacy ? { privacy: body.privacy } : {}),
        } as Metadata)
      : undefined;
  const status =
    (body.status as ConnectorAccountStatus | undefined) ??
    (body.enabled === false
      ? "disabled"
      : body.enabled === true
        ? "connected"
        : undefined);
  return {
    label: body.label,
    role,
    purpose,
    status,
    externalId: body.externalId as string | null | undefined,
    displayHandle: body.displayHandle as string | null | undefined,
    // Server-owned account policy fields are intentionally not accepted from
    // public HTTP bodies. Providers/pairing flows set owner bindings and access
    // gates after verification through the manager API.
    metadata: nextMetadata,
  };
}

function serializeAccount(account: ConnectorAccount): Record<string, unknown> {
  const metadata = account.metadata ?? {};
  const handle =
    account.displayHandle ??
    (typeof metadata.handle === "string" ? metadata.handle : undefined);
  return {
    id: account.id,
    provider: account.provider,
    label:
      account.label ??
      account.displayHandle ??
      account.externalId ??
      account.id,
    role: normalizeConnectorAccountRoleValue(account.role) ?? "OWNER",
    purpose: account.purpose,
    privacy: isPrivacyLevel(metadata.privacy)
      ? metadata.privacy
      : DEFAULT_PRIVACY_LEVEL,
    accessGate: account.accessGate,
    status: normalizeConnectorAccountStatus(account.status),
    externalId: account.externalId,
    handle,
    displayHandle: account.displayHandle,
    ownerBindingId: account.ownerBindingId,
    ownerIdentityId: account.ownerIdentityId,
    isDefault: metadata.isDefault === true && isUsableDefaultAccount(account),
    enabled: account.status !== "disabled" && account.status !== "revoked",
    createdAt: account.createdAt,
    updatedAt: account.updatedAt,
    metadata: redactAuditMetadata(metadata),
  };
}

function isUsableDefaultAccount(account: ConnectorAccount): boolean {
  return (
    account.status === "connected" &&
    account.accessGate !== "disabled" &&
    account.metadata?.disabled !== true
  );
}

function getDefaultAccountId(accounts: ConnectorAccount[]): string | null {
  return (
    accounts.find(
      (account) =>
        account.metadata?.isDefault === true && isUsableDefaultAccount(account),
    )?.id ??
    accounts.find((account) => isUsableDefaultAccount(account))?.id ??
    null
  );
}

function serializeFlow(flow: ConnectorOAuthFlow): Record<string, unknown> {
  return {
    id: flow.id,
    provider: flow.provider,
    state: flow.state,
    status: flow.status,
    accountId: flow.accountId,
    authUrl: flow.authUrl,
    error: flow.error,
    redirectUri: flow.redirectUri,
    createdAt: flow.createdAt,
    updatedAt: flow.updatedAt,
    expiresAt: flow.expiresAt,
    metadata: redactAuditMetadata(flow.metadata),
  };
}

function queryRecord(req: http.IncomingMessage): Record<string, string> {
  const url = new URL(req.url ?? "/", "http://localhost");
  const record: Record<string, string> = {};
  for (const [key, value] of url.searchParams.entries()) {
    record[key] = value;
  }
  return record;
}

interface ConnectorAccountAuditEventLike {
  id: string;
  accountId?: string | null;
  account_id?: string | null;
  agentId?: string;
  agent_id?: string;
  provider: string;
  actorId?: string | null;
  actor_id?: string | null;
  action: string;
  outcome: string;
  metadata?: unknown;
  createdAt?: number | string | Date;
  created_at?: number | string | Date;
}

interface ConnectorAccountAuditReader {
  listConnectorAccountAuditEvents?: (params: {
    agentId?: string;
    provider?: string;
    accountId?: string;
    action?: string;
    outcome?: string;
    limit?: number;
  }) => Promise<ConnectorAccountAuditEventLike[]>;
  db?: {
    execute?: (query: unknown) => Promise<unknown>;
  };
  getDatabase?: () => {
    execute?: (query: unknown) => Promise<unknown>;
  };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function extractRows(value: unknown): Record<string, unknown>[] {
  if (Array.isArray(value)) {
    return value
      .map(asRecord)
      .filter((row): row is Record<string, unknown> => row !== null);
  }
  const record = asRecord(value);
  if (!record || !Array.isArray(record.rows)) return [];
  return record.rows
    .map(asRecord)
    .filter((row): row is Record<string, unknown> => row !== null);
}

function sqlQuote(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function parseAuditLimit(value: string | undefined): number {
  if (!value) return 50;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return 50;
  return Math.max(1, Math.min(100, Math.trunc(parsed)));
}

function toEpochMillis(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (value instanceof Date) return value.getTime();
  if (typeof value === "string" && value.trim()) {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

function serializeAuditEvent(
  event: ConnectorAccountAuditEventLike | Record<string, unknown>,
): Record<string, unknown> {
  const accountId = event.accountId ?? event.account_id ?? null;
  const agentId = event.agentId ?? event.agent_id;
  const actorId = event.actorId ?? event.actor_id ?? null;
  const createdAt = toEpochMillis(event.createdAt ?? event.created_at);
  return {
    id: String(event.id),
    accountId:
      accountId === null || accountId === undefined ? null : String(accountId),
    agentId: agentId === undefined ? undefined : String(agentId),
    provider: String(event.provider),
    actorId: actorId === null || actorId === undefined ? null : String(actorId),
    action: String(event.action),
    outcome: String(event.outcome),
    metadata: redactAuditMetadata(event.metadata ?? {}),
    createdAt,
  };
}

async function executeRawAuditQuery(
  adapter: ConnectorAccountAuditReader,
  query: string,
): Promise<Record<string, unknown>[]> {
  const db = adapter.db ?? adapter.getDatabase?.();
  if (!db?.execute) return [];
  const { sql } = (await import("drizzle-orm")) as {
    sql: { raw: (query: string) => unknown };
  };
  const result = await db.execute(sql.raw(query));
  return extractRows(result);
}

async function listConnectorAuditEvents(args: {
  runtime: import("@elizaos/core").IAgentRuntime | null;
  provider: string;
  accountId?: string;
  action?: string;
  outcome?: string;
  limit: number;
}): Promise<ConnectorAccountAuditEventLike[]> {
  const runtimeWithAdapter = args.runtime as
    | (import("@elizaos/core").IAgentRuntime & {
        adapter?: ConnectorAccountAuditReader;
      })
    | null;
  const adapter = runtimeWithAdapter?.adapter;
  const agentId =
    typeof runtimeWithAdapter?.agentId === "string"
      ? runtimeWithAdapter.agentId
      : undefined;
  if (!adapter) return [];

  if (typeof adapter.listConnectorAccountAuditEvents === "function") {
    return adapter.listConnectorAccountAuditEvents({
      agentId,
      provider: args.provider,
      accountId: args.accountId,
      action: args.action,
      outcome: args.outcome,
      limit: args.limit,
    });
  }

  const conditions = [`provider = ${sqlQuote(args.provider)}`];
  if (agentId) conditions.push(`agent_id = ${sqlQuote(agentId)}`);
  if (args.accountId)
    conditions.push(`account_id = ${sqlQuote(args.accountId)}`);
  if (args.action) conditions.push(`action = ${sqlQuote(args.action)}`);
  if (args.outcome) conditions.push(`outcome = ${sqlQuote(args.outcome)}`);

  const rows = await executeRawAuditQuery(
    adapter,
    `SELECT id, account_id, agent_id, provider, actor_id, action, outcome, metadata, created_at
       FROM connector_account_audit_events
      WHERE ${conditions.join(" AND ")}
      ORDER BY created_at DESC, id DESC
      LIMIT ${args.limit}`,
  );
  return rows as unknown as ConnectorAccountAuditEventLike[];
}

export async function handleConnectorAccountRoutes(
  ctx: ConnectorAccountRouteContext,
): Promise<boolean> {
  const { req, res, method, pathname, json, error, readJsonBody } = ctx;
  const parsedPath = parseConnectorScopedPath(pathname);
  if (!parsedPath) {
    return false;
  }
  const { provider, namespace, rest } = parsedPath;
  if (isBlockedObjectKey(provider)) {
    error(res, "Invalid connector provider", 400);
    return true;
  }
  if (!isUnauthenticatedOAuthCallback(parsedPath, method) && ctx.authorize) {
    const allowed = await ctx.authorize(
      authorizationRequestForPath(parsedPath, method, pathname),
    );
    if (!allowed) {
      error(res, "Forbidden", 403);
      return true;
    }
  }

  const manager = getConnectorAccountManager(ctx.state.runtime);

  if (namespace === "accounts") {
    if (rest.length === 0 && method === "GET") {
      const accounts = await manager.listAccounts(provider);
      json(res, {
        provider,
        defaultAccountId: getDefaultAccountId(accounts),
        accounts: accounts.map(serializeAccount),
      });
      return true;
    }

    if (rest.length === 0 && method === "POST") {
      const body = await readJsonBody(req, res);
      if (!body) return true;
      const parsed = accountInputSchema.safeParse(body);
      if (!parsed.success) {
        error(
          res,
          parsed.error.issues[0]?.message ?? "Invalid account body",
          400,
        );
        return true;
      }
      if (
        parsed.data.privacy &&
        parsed.data.privacy !== DEFAULT_PRIVACY_LEVEL &&
        !hasPrivacyConfirmation(parsed.data.confirmation, parsed.data.privacy)
      ) {
        error(res, "Privacy escalation requires confirmation", 403);
        return true;
      }
      const account = await manager.createAccount(provider, {
        ...accountPatchFromBody(parsed.data),
        ...(parsed.data.id ? { id: parsed.data.id } : {}),
      } as ConnectorAccountPatch);
      json(res, serializeAccount(account), 201);
      return true;
    }

    if (rest.length === 1) {
      const accountId = rest[0];
      if (!accountId || isBlockedObjectKey(accountId)) {
        error(res, "Invalid connector account id", 400);
        return true;
      }

      if (method === "GET") {
        const account = await manager.getAccount(provider, accountId);
        if (!account) {
          error(res, "Connector account not found", 404);
          return true;
        }
        json(res, serializeAccount(account));
        return true;
      }

      if (method === "PATCH") {
        const body = await readJsonBody(req, res);
        if (!body) return true;
        const parsed = accountPatchSchema.safeParse(body);
        if (!parsed.success) {
          error(
            res,
            parsed.error.issues[0]?.message ?? "Invalid account body",
            400,
          );
          return true;
        }
        const existing = await manager.getAccount(provider, accountId);
        if (!existing) {
          error(res, "Connector account not found", 404);
          return true;
        }
        const patch = accountPatchFromBody(parsed.data, existing.metadata);
        if (
          requiresOwnerRoleConfirmation(existing, patch.role) &&
          !hasOwnerRoleConfirmation(parsed.data.confirmation)
        ) {
          error(res, "OWNER role assignment requires confirmation", 403);
          return true;
        }
        const requestedPrivacy = parsed.data.privacy;
        if (
          requestedPrivacy &&
          requiresPrivacyConfirmation(existing, requestedPrivacy) &&
          !hasPrivacyConfirmation(parsed.data.confirmation, requestedPrivacy)
        ) {
          error(res, "Privacy escalation requires confirmation", 403);
          return true;
        }
        const account = await manager.patchAccount(provider, accountId, patch);
        if (!account) {
          error(res, "Connector account not found", 404);
          return true;
        }
        json(res, serializeAccount(account));
        return true;
      }

      if (method === "DELETE") {
        const deleted = await manager.deleteAccount(provider, accountId);
        json(res, { deleted });
        return true;
      }
    }

    if (rest.length === 2 && method === "POST") {
      const [accountId, action] = rest;
      if (!accountId || isBlockedObjectKey(accountId)) {
        error(res, "Invalid connector account id", 400);
        return true;
      }
      const account = await manager.getAccount(provider, accountId);
      if (!account) {
        error(res, "Connector account not found", 404);
        return true;
      }

      if (action === "test") {
        const ok = isUsableDefaultAccount(account);
        json(res, {
          ok,
          provider,
          account: serializeAccount(account),
          status: normalizeConnectorAccountStatus(account.status),
        });
        return true;
      }

      if (action === "refresh") {
        const refreshed = await manager.patchAccount(provider, accountId, {
          metadata: {
            ...(account.metadata ?? {}),
            lastSyncedAt: Date.now(),
          },
        });
        json(res, {
          ok: true,
          provider,
          account: serializeAccount(refreshed ?? account),
          status: normalizeConnectorAccountStatus(
            (refreshed ?? account).status,
          ),
        });
        return true;
      }

      if (action === "default") {
        if (!isUsableDefaultAccount(account)) {
          error(
            res,
            "Only connected, enabled connector accounts can be default",
            400,
          );
          return true;
        }
        const accounts = await manager.listAccounts(provider);
        for (const item of accounts) {
          const isTarget = item.id === accountId;
          if (item.metadata?.isDefault === isTarget) continue;
          await manager.patchAccount(provider, item.id, {
            metadata: {
              ...(item.metadata ?? {}),
              isDefault: isTarget,
            },
          });
        }
        const updatedAccounts = await manager.listAccounts(provider);
        const updatedAccount =
          updatedAccounts.find((item) => item.id === accountId) ?? account;
        json(res, {
          ok: true,
          provider,
          account: serializeAccount(updatedAccount),
          accounts: updatedAccounts.map(serializeAccount),
          defaultAccountId: accountId,
        });
        return true;
      }

      error(res, "Connector account action not found", 404);
      return true;
    }

    error(res, "Connector account route not found", 404);
    return true;
  }

  if (namespace === "audit") {
    if (rest.length === 1 && rest[0] === "events" && method === "GET") {
      const query = queryRecord(req);
      const outcome = query.outcome?.trim();
      if (outcome && outcome !== "success" && outcome !== "failure") {
        error(res, "outcome must be success or failure", 400);
        return true;
      }
      const events = await listConnectorAuditEvents({
        runtime: ctx.state.runtime,
        provider,
        accountId: query.accountId?.trim() || undefined,
        action: query.action?.trim() || undefined,
        outcome: outcome || undefined,
        limit: parseAuditLimit(query.limit),
      });
      json(res, {
        provider,
        events: events.map(serializeAuditEvent),
      });
      return true;
    }

    error(res, "Connector account audit route not found", 404);
    return true;
  }

  if (namespace === "oauth") {
    const action = rest[0];
    if (action === "start" && rest.length === 1 && method === "POST") {
      const body = await readJsonBody(req, res);
      if (!body) return true;
      const parsed = oauthStartSchema.safeParse(body);
      if (!parsed.success) {
        error(
          res,
          parsed.error.issues[0]?.message ?? "Invalid OAuth body",
          400,
        );
        return true;
      }
      try {
        const flow = await manager.startOAuth(provider, {
          ...parsed.data,
          metadata: cleanMetadata(parsed.data.metadata),
        });
        json(res, { provider, flow: serializeFlow(flow) }, 201);
      } catch (err) {
        error(
          res,
          err instanceof Error ? err.message : "Failed to start OAuth flow",
          400,
        );
      }
      return true;
    }

    if (action === "status" && method === "GET") {
      const query = queryRecord(req);
      const flowId = rest[1] ?? query.flowId ?? query.state;
      if (!flowId) {
        error(res, "Missing flowId or state", 400);
        return true;
      }
      const flow = await manager.getOAuthFlow(provider, flowId);
      if (!flow) {
        error(res, "OAuth flow not found", 404);
        return true;
      }
      json(res, { provider, flow: serializeFlow(flow) });
      return true;
    }

    if (action === "callback" && (method === "GET" || method === "POST")) {
      const query = queryRecord(req);
      const body =
        method === "POST"
          ? await readJsonBody<Record<string, unknown>>(req, res)
          : undefined;
      if (method === "POST" && !body) return true;
      const state =
        typeof body?.state === "string" ? body.state : (query.state ?? rest[1]);
      if (!state) {
        error(res, "Missing OAuth state", 400);
        return true;
      }
      try {
        const result = await manager.completeOAuth(provider, {
          state,
          code: typeof body?.code === "string" ? body.code : query.code,
          error: typeof body?.error === "string" ? body.error : query.error,
          errorDescription:
            typeof body?.error_description === "string"
              ? body.error_description
              : query.error_description,
          query,
          body: body ?? undefined,
        });
        const serializedFlow = serializeFlow(result.flow);
        json(res, {
          provider,
          ok: true,
          flow: {
            id: serializedFlow.id,
            status: serializedFlow.status,
            error: serializedFlow.error,
          },
          accountId: result.account?.id ?? result.flow.accountId,
          redirectUrl: result.redirectUrl,
        });
      } catch (err) {
        error(
          res,
          err instanceof Error ? err.message : "Failed to complete OAuth flow",
          400,
        );
      }
      return true;
    }

    error(res, "Connector OAuth route not found", 404);
    return true;
  }

  return false;
}
