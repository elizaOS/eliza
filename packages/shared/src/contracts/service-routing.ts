import { asRecord } from "../type-guards.js";

export type LinkedAccountStatus = "linked" | "unlinked";

export type LinkedAccountSource =
  | "api-key"
  | "oauth"
  | "credentials"
  | "subscription";

/**
 * Legacy "is this provider linked" flag stored in `eliza.json` under
 * `linkedAccounts.{providerId}` (e.g. `linkedAccounts.elizacloud`).
 *
 * Predates the multi-account credential system. Kept for the
 * config-on-disk shape — actual per-account credential records live
 * in `~/.eliza/auth/{providerId}/{accountId}.json` (see
 * `account-storage.ts`) and are surfaced via the richer
 * {@link LinkedAccountConfig} below.
 */
export type LinkedAccountFlagConfig = {
  status?: LinkedAccountStatus;
  source?: LinkedAccountSource;
  userId?: string;
  organizationId?: string;
};

export type LinkedAccountFlagsConfig = Record<string, LinkedAccountFlagConfig>;

/**
 * Restricted set of provider IDs that can own multi-account credential
 * records. Cloud-managed providers (`elizacloud`, etc.) use the legacy
 * {@link LinkedAccountFlagConfig} flag instead.
 */
export type LinkedAccountProviderId =
  | "anthropic-subscription"
  | "openai-codex"
  | "anthropic-api"
  | "openai-api"
  | "deepseek-api"
  | "zai-api"
  | "moonshot-api";

export type LinkedAccountAccountSource = "oauth" | "api-key";

export type LinkedAccountHealth =
  | "ok"
  | "rate-limited"
  | "needs-reauth"
  | "invalid"
  | "unknown";

export interface LinkedAccountHealthDetail {
  /** epoch ms — when this state expires (e.g. rate-limit reset) */
  until?: number;
  lastError?: string;
  /** epoch ms */
  lastChecked?: number;
}

export interface LinkedAccountUsage {
  /** 0–100, current 5h window (Anthropic) or primary window (Codex) */
  sessionPct?: number;
  /** 0–100, 7-day (Anthropic only) */
  weeklyPct?: number;
  /** epoch ms */
  resetsAt?: number;
  /** epoch ms — when this snapshot was last refreshed */
  refreshedAt: number;
}

/**
 * First-class linked-account record. One per credential set —
 * surfaced by the accounts CRUD API (WS3) and the AccountPool service
 * (WS2). The on-disk credential blob is intentionally not part of this
 * type (callers consume it via `account-storage.ts`).
 */
export interface LinkedAccountConfig {
  id: string;
  providerId: LinkedAccountProviderId;
  label: string;
  source: LinkedAccountAccountSource;
  enabled: boolean;
  /** lower = higher priority */
  priority: number;
  /** epoch ms */
  createdAt: number;
  /** epoch ms */
  lastUsedAt?: number;
  health: LinkedAccountHealth;
  healthDetail?: LinkedAccountHealthDetail;
  usage?: LinkedAccountUsage;
  organizationId?: string;
  userId?: string;
  email?: string;
}

export type LinkedAccountsConfig = Record<string, LinkedAccountConfig>;

export type ServiceCapability =
  | "llmText"
  | "tts"
  | "media"
  | "embeddings"
  | "rpc";

export type ServiceTransport = "direct" | "cloud-proxy" | "remote";

export type ServiceRouteAccountStrategy =
  | "priority"
  | "round-robin"
  | "least-used"
  | "quota-aware";

export type ServiceRouteConfig = {
  backend?: string;
  transport?: ServiceTransport;
  /**
   * Backcompat shorthand for `accountIds: [accountId]`. Prefer
   * `accountIds` for new callers; the runtime treats both forms as
   * equivalent when only one of them is set.
   */
  accountId?: string;
  /** Pool of account IDs eligible to serve this capability. */
  accountIds?: string[];
  /** Default `"priority"` when `accountIds` has more than one entry. */
  strategy?: ServiceRouteAccountStrategy;
  primaryModel?: string;
  nanoModel?: string;
  smallModel?: string;
  mediumModel?: string;
  largeModel?: string;
  megaModel?: string;
  remoteApiBase?: string;

  /**
   * Per-step model overrides for the fine-tuned pipeline.
   * Each step can specify a model ID (e.g., a Vertex AI fine-tuned endpoint).
   * Falls back to: stepModel -> plugin override -> smallModel/largeModel -> system default.
   */
  responseHandlerModel?: string;
  shouldRespondModel?: string;
  actionPlannerModel?: string;
  plannerModel?: string;
  responseModel?: string;
  mediaDescriptionModel?: string;
};

export type ServiceRoutingConfig = Partial<
  Record<ServiceCapability, ServiceRouteConfig>
>;

export const DEFAULT_ELIZA_CLOUD_TEXT_MODEL = "openai/gpt-oss-120b:nitro";
export const DEFAULT_ELIZA_CLOUD_FREE_TEXT_MODEL = "openai/gpt-oss-120b:free";

const ELIZA_CLOUD_ROUTE_BASE = {
  backend: "elizacloud",
  transport: "cloud-proxy",
  accountId: "elizacloud",
} as const satisfies Pick<
  ServiceRouteConfig,
  "backend" | "transport" | "accountId"
>;

const ELIZA_CLOUD_DEFAULT_SERVICE_CAPABILITIES = [
  "tts",
  "media",
  "embeddings",
  "rpc",
] as const satisfies readonly Exclude<ServiceCapability, "llmText">[];

export type DeploymentTargetRuntime = "local" | "cloud" | "remote";

export type DeploymentTargetConfig = {
  runtime: DeploymentTargetRuntime;
  provider?: "elizacloud" | "remote";
  remoteApiBase?: string;
  remoteAccessToken?: string;
};

export const SERVICE_CAPABILITIES = [
  "llmText",
  "tts",
  "media",
  "embeddings",
  "rpc",
] as const satisfies readonly ServiceCapability[];

export function buildElizaCloudServiceRoute(
  args: {
    nanoModel?: string;
    smallModel?: string;
    mediumModel?: string;
    largeModel?: string;
    megaModel?: string;
    responseHandlerModel?: string;
    shouldRespondModel?: string;
    actionPlannerModel?: string;
    plannerModel?: string;
    responseModel?: string;
    mediaDescriptionModel?: string;
  } = {},
): ServiceRouteConfig {
  return {
    ...ELIZA_CLOUD_ROUTE_BASE,
    ...(args.nanoModel ? { nanoModel: args.nanoModel } : {}),
    ...(args.smallModel ? { smallModel: args.smallModel } : {}),
    ...(args.mediumModel ? { mediumModel: args.mediumModel } : {}),
    ...(args.largeModel ? { largeModel: args.largeModel } : {}),
    ...(args.megaModel ? { megaModel: args.megaModel } : {}),
    ...(args.responseHandlerModel
      ? { responseHandlerModel: args.responseHandlerModel }
      : {}),
    ...(args.shouldRespondModel
      ? { shouldRespondModel: args.shouldRespondModel }
      : {}),
    ...(args.actionPlannerModel
      ? { actionPlannerModel: args.actionPlannerModel }
      : {}),
    ...(args.plannerModel ? { plannerModel: args.plannerModel } : {}),
    ...(args.responseModel ? { responseModel: args.responseModel } : {}),
    ...(args.mediaDescriptionModel
      ? { mediaDescriptionModel: args.mediaDescriptionModel }
      : {}),
  };
}

export function buildDefaultElizaCloudServiceRouting(
  args: {
    base?: ServiceRoutingConfig | null;
    includeInference?: boolean;
    excludeServices?: readonly Exclude<ServiceCapability, "llmText">[];
    nanoModel?: string;
    smallModel?: string;
    mediumModel?: string;
    largeModel?: string;
    megaModel?: string;
    responseHandlerModel?: string;
    shouldRespondModel?: string;
    actionPlannerModel?: string;
    plannerModel?: string;
    responseModel?: string;
    mediaDescriptionModel?: string;
  } = {},
): ServiceRoutingConfig {
  const next: ServiceRoutingConfig = { ...args.base };
  const excluded = new Set(args.excludeServices ?? []);

  for (const capability of ELIZA_CLOUD_DEFAULT_SERVICE_CAPABILITIES) {
    if (excluded.has(capability)) continue;
    next[capability] ??= buildElizaCloudServiceRoute();
  }

  if (args.includeInference) {
    next.llmText ??= buildElizaCloudServiceRoute({
      nanoModel: args.nanoModel,
      smallModel: args.smallModel,
      mediumModel: args.mediumModel,
      largeModel: args.largeModel,
      megaModel: args.megaModel,
      responseHandlerModel: args.responseHandlerModel,
      shouldRespondModel: args.shouldRespondModel,
      actionPlannerModel: args.actionPlannerModel,
      plannerModel: args.plannerModel,
      responseModel: args.responseModel,
      mediaDescriptionModel: args.mediaDescriptionModel,
    });
  }

  return next;
}

function readTrimmedString(
  source: Record<string, unknown> | null | undefined,
  key: string,
): string | undefined {
  const value = source?.[key];
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function normalizeLinkedAccountStatus(
  value: unknown,
): LinkedAccountStatus | undefined {
  return value === "linked" || value === "unlinked" ? value : undefined;
}

function normalizeLinkedAccountSource(
  value: unknown,
): LinkedAccountSource | undefined {
  return value === "api-key" ||
    value === "oauth" ||
    value === "credentials" ||
    value === "subscription"
    ? value
    : undefined;
}

function normalizeServiceTransport(
  value: unknown,
): ServiceTransport | undefined {
  return value === "direct" || value === "cloud-proxy" || value === "remote"
    ? value
    : undefined;
}

function normalizeServiceRouteAccountStrategy(
  value: unknown,
): ServiceRouteAccountStrategy | undefined {
  return value === "priority" ||
    value === "round-robin" ||
    value === "least-used" ||
    value === "quota-aware"
    ? value
    : undefined;
}

export function normalizeLinkedAccountFlagConfig(
  value: unknown,
): LinkedAccountFlagConfig | null {
  const account = asRecord(value);
  if (!account) {
    return null;
  }

  const status = normalizeLinkedAccountStatus(account.status);
  const source = normalizeLinkedAccountSource(account.source);
  const userId = readTrimmedString(account, "userId");
  const organizationId = readTrimmedString(account, "organizationId");

  if (!status && !source && !userId && !organizationId) {
    return null;
  }

  return {
    ...(status ? { status } : {}),
    ...(source ? { source } : {}),
    ...(userId ? { userId } : {}),
    ...(organizationId ? { organizationId } : {}),
  };
}

export function normalizeLinkedAccountFlagsConfig(
  value: unknown,
): LinkedAccountFlagsConfig | null {
  const accounts = asRecord(value);
  if (!accounts) {
    return null;
  }

  const normalizedEntries: Array<[string, LinkedAccountFlagConfig]> = [];
  for (const [accountId, accountValue] of Object.entries(accounts)) {
    const trimmedAccountId = accountId.trim();
    const normalizedAccount = normalizeLinkedAccountFlagConfig(accountValue);
    if (!trimmedAccountId || !normalizedAccount) {
      continue;
    }
    normalizedEntries.push([trimmedAccountId, normalizedAccount]);
  }

  const normalized = Object.fromEntries(normalizedEntries);

  return Object.keys(normalized).length > 0 ? normalized : null;
}

export function isLinkedAccountProviderId(
  value: unknown,
): value is LinkedAccountProviderId {
  return (
    value === "anthropic-subscription" ||
    value === "openai-codex" ||
    value === "anthropic-api" ||
    value === "openai-api" ||
    value === "deepseek-api" ||
    value === "zai-api" ||
    value === "moonshot-api"
  );
}

function normalizeLinkedAccountAccountSource(
  value: unknown,
): LinkedAccountAccountSource | undefined {
  return value === "oauth" || value === "api-key" ? value : undefined;
}

function normalizeLinkedAccountHealth(
  value: unknown,
): LinkedAccountHealth | undefined {
  return value === "ok" ||
    value === "rate-limited" ||
    value === "needs-reauth" ||
    value === "invalid" ||
    value === "unknown"
    ? value
    : undefined;
}

function normalizeLinkedAccountHealthDetail(
  value: unknown,
): LinkedAccountHealthDetail | undefined {
  const detail = asRecord(value);
  if (!detail) return undefined;
  const until =
    typeof detail.until === "number" && Number.isFinite(detail.until)
      ? detail.until
      : undefined;
  const lastError = readTrimmedString(detail, "lastError");
  const lastChecked =
    typeof detail.lastChecked === "number" &&
    Number.isFinite(detail.lastChecked)
      ? detail.lastChecked
      : undefined;
  if (until === undefined && !lastError && lastChecked === undefined) {
    return undefined;
  }
  return {
    ...(until !== undefined ? { until } : {}),
    ...(lastError ? { lastError } : {}),
    ...(lastChecked !== undefined ? { lastChecked } : {}),
  };
}

function normalizeLinkedAccountUsage(
  value: unknown,
): LinkedAccountUsage | undefined {
  const usage = asRecord(value);
  if (!usage) return undefined;
  const refreshedAt =
    typeof usage.refreshedAt === "number" && Number.isFinite(usage.refreshedAt)
      ? usage.refreshedAt
      : undefined;
  if (refreshedAt === undefined) return undefined;
  const sessionPct =
    typeof usage.sessionPct === "number" && Number.isFinite(usage.sessionPct)
      ? usage.sessionPct
      : undefined;
  const weeklyPct =
    typeof usage.weeklyPct === "number" && Number.isFinite(usage.weeklyPct)
      ? usage.weeklyPct
      : undefined;
  const resetsAt =
    typeof usage.resetsAt === "number" && Number.isFinite(usage.resetsAt)
      ? usage.resetsAt
      : undefined;
  return {
    refreshedAt,
    ...(sessionPct !== undefined ? { sessionPct } : {}),
    ...(weeklyPct !== undefined ? { weeklyPct } : {}),
    ...(resetsAt !== undefined ? { resetsAt } : {}),
  };
}

export function normalizeLinkedAccountRecord(
  value: unknown,
): LinkedAccountConfig | null {
  const record = asRecord(value);
  if (!record) return null;

  const id = readTrimmedString(record, "id");
  const providerId = isLinkedAccountProviderId(record.providerId)
    ? record.providerId
    : null;
  const label = readTrimmedString(record, "label");
  const source = normalizeLinkedAccountAccountSource(record.source);
  const createdAt =
    typeof record.createdAt === "number" && Number.isFinite(record.createdAt)
      ? record.createdAt
      : null;
  const enabled = typeof record.enabled === "boolean" ? record.enabled : null;
  const priority =
    typeof record.priority === "number" && Number.isFinite(record.priority)
      ? record.priority
      : null;
  const health = normalizeLinkedAccountHealth(record.health);

  if (
    !id ||
    !providerId ||
    !label ||
    !source ||
    createdAt === null ||
    enabled === null ||
    priority === null ||
    !health
  ) {
    return null;
  }

  const lastUsedAt =
    typeof record.lastUsedAt === "number" && Number.isFinite(record.lastUsedAt)
      ? record.lastUsedAt
      : undefined;
  const healthDetail = normalizeLinkedAccountHealthDetail(record.healthDetail);
  const usage = normalizeLinkedAccountUsage(record.usage);
  const organizationId = readTrimmedString(record, "organizationId");
  const userId = readTrimmedString(record, "userId");
  const email = readTrimmedString(record, "email");

  return {
    id,
    providerId,
    label,
    source,
    enabled,
    priority,
    createdAt,
    health,
    ...(lastUsedAt !== undefined ? { lastUsedAt } : {}),
    ...(healthDetail ? { healthDetail } : {}),
    ...(usage ? { usage } : {}),
    ...(organizationId ? { organizationId } : {}),
    ...(userId ? { userId } : {}),
    ...(email ? { email } : {}),
  };
}

export function normalizeLinkedAccountsRecords(
  value: unknown,
): LinkedAccountsConfig | null {
  const records = asRecord(value);
  if (!records) return null;

  const out: LinkedAccountsConfig = {};
  for (const [id, raw] of Object.entries(records)) {
    const trimmedId = id.trim();
    if (!trimmedId) continue;
    const normalized = normalizeLinkedAccountRecord(raw);
    if (!normalized) continue;
    if (normalized.id !== trimmedId) continue;
    out[trimmedId] = normalized;
  }

  return Object.keys(out).length > 0 ? out : null;
}

export function normalizeServiceRouteConfig(
  value: unknown,
): ServiceRouteConfig | null {
  const route = asRecord(value);
  if (!route) {
    return null;
  }

  const backend = readTrimmedString(route, "backend");
  const transport = normalizeServiceTransport(route.transport);
  const accountId = readTrimmedString(route, "accountId");
  const accountIdsRaw = Array.isArray(route.accountIds)
    ? (route.accountIds as unknown[])
    : null;
  const accountIds = accountIdsRaw
    ? Array.from(
        new Set(
          accountIdsRaw
            .filter((entry): entry is string => typeof entry === "string")
            .map((entry) => entry.trim())
            .filter((entry) => entry.length > 0),
        ),
      )
    : undefined;
  const strategy = normalizeServiceRouteAccountStrategy(route.strategy);
  const primaryModel = readTrimmedString(route, "primaryModel");
  const nanoModel = readTrimmedString(route, "nanoModel");
  const smallModel = readTrimmedString(route, "smallModel");
  const mediumModel = readTrimmedString(route, "mediumModel");
  const largeModel = readTrimmedString(route, "largeModel");
  const megaModel = readTrimmedString(route, "megaModel");
  const responseHandlerModel = readTrimmedString(route, "responseHandlerModel");
  const shouldRespondModel = readTrimmedString(route, "shouldRespondModel");
  const actionPlannerModel = readTrimmedString(route, "actionPlannerModel");
  const plannerModel = readTrimmedString(route, "plannerModel");
  const responseModel = readTrimmedString(route, "responseModel");
  const mediaDescriptionModel = readTrimmedString(
    route,
    "mediaDescriptionModel",
  );
  const remoteApiBase = readTrimmedString(route, "remoteApiBase");

  if (
    !backend &&
    !transport &&
    !accountId &&
    (!accountIds || accountIds.length === 0) &&
    !strategy &&
    !primaryModel &&
    !nanoModel &&
    !smallModel &&
    !mediumModel &&
    !largeModel &&
    !megaModel &&
    !responseHandlerModel &&
    !shouldRespondModel &&
    !actionPlannerModel &&
    !plannerModel &&
    !responseModel &&
    !mediaDescriptionModel &&
    !remoteApiBase
  ) {
    return null;
  }

  return {
    ...(backend ? { backend } : {}),
    ...(transport ? { transport } : {}),
    ...(accountId ? { accountId } : {}),
    ...(accountIds && accountIds.length > 0 ? { accountIds } : {}),
    ...(strategy ? { strategy } : {}),
    ...(primaryModel ? { primaryModel } : {}),
    ...(nanoModel ? { nanoModel } : {}),
    ...(smallModel ? { smallModel } : {}),
    ...(mediumModel ? { mediumModel } : {}),
    ...(largeModel ? { largeModel } : {}),
    ...(megaModel ? { megaModel } : {}),
    ...(responseHandlerModel ? { responseHandlerModel } : {}),
    ...(shouldRespondModel ? { shouldRespondModel } : {}),
    ...(actionPlannerModel ? { actionPlannerModel } : {}),
    ...(plannerModel ? { plannerModel } : {}),
    ...(responseModel ? { responseModel } : {}),
    ...(mediaDescriptionModel ? { mediaDescriptionModel } : {}),
    ...(remoteApiBase ? { remoteApiBase } : {}),
  };
}

export function normalizeServiceRoutingConfig(
  value: unknown,
): ServiceRoutingConfig | null {
  const routing = asRecord(value);
  if (!routing) {
    return null;
  }

  const normalized = Object.fromEntries(
    SERVICE_CAPABILITIES.map((capability) => [
      capability,
      normalizeServiceRouteConfig(routing[capability]),
    ]).filter(
      (entry): entry is [ServiceCapability, ServiceRouteConfig] =>
        entry[1] !== null,
    ),
  );

  return Object.keys(normalized).length > 0 ? normalized : null;
}

export function normalizeDeploymentTargetConfig(
  value: unknown,
): DeploymentTargetConfig | null {
  const target = asRecord(value);
  if (!target) {
    return null;
  }

  const runtime =
    target.runtime === "local" ||
    target.runtime === "cloud" ||
    target.runtime === "remote"
      ? target.runtime
      : null;
  if (!runtime) {
    return null;
  }

  const provider =
    target.provider === "elizacloud" || target.provider === "remote"
      ? target.provider
      : undefined;

  return {
    runtime,
    ...(provider ? { provider } : {}),
    ...(readTrimmedString(target, "remoteApiBase")
      ? { remoteApiBase: readTrimmedString(target, "remoteApiBase") }
      : {}),
    ...(readTrimmedString(target, "remoteAccessToken")
      ? { remoteAccessToken: readTrimmedString(target, "remoteAccessToken") }
      : {}),
  };
}
