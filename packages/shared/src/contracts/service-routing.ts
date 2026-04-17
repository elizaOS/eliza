export type LinkedAccountStatus = "linked" | "unlinked";

export type LinkedAccountSource =
  | "api-key"
  | "oauth"
  | "credentials"
  | "subscription";

export type LinkedAccountConfig = {
  status?: LinkedAccountStatus;
  source?: LinkedAccountSource;
  userId?: string;
  organizationId?: string;
};

export type LinkedAccountsConfig = Record<string, LinkedAccountConfig>;

export type ServiceCapability =
  | "llmText"
  | "tts"
  | "media"
  | "embeddings"
  | "rpc";

export type ServiceTransport = "direct" | "cloud-proxy" | "remote";

export type ServiceRouteConfig = {
  backend?: string;
  transport?: ServiceTransport;
  accountId?: string;
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
  const next: ServiceRoutingConfig = { ...(args.base ?? {}) };

  for (const capability of ELIZA_CLOUD_DEFAULT_SERVICE_CAPABILITIES) {
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

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
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

export function normalizeLinkedAccountConfig(
  value: unknown,
): LinkedAccountConfig | null {
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

export function normalizeLinkedAccountsConfig(
  value: unknown,
): LinkedAccountsConfig | null {
  const accounts = asRecord(value);
  if (!accounts) {
    return null;
  }

  const normalizedEntries: Array<[string, LinkedAccountConfig]> = [];
  for (const [accountId, accountValue] of Object.entries(accounts)) {
    const trimmedAccountId = accountId.trim();
    const normalizedAccount = normalizeLinkedAccountConfig(accountValue);
    if (!trimmedAccountId || !normalizedAccount) {
      continue;
    }
    normalizedEntries.push([trimmedAccountId, normalizedAccount]);
  }

  const normalized = Object.fromEntries(normalizedEntries);

  return Object.keys(normalized).length > 0 ? normalized : null;
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
