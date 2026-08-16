/**
 * Cloud-topology contract: the set of Eliza Cloud services (inference, tts,
 * media, embeddings, rpc) and helpers that resolve which of them a config routes
 * to Cloud versus local, from deployment-target and linked-account settings.
 */
import {
  normalizeFirstRunProviderId,
  resolveDeploymentTargetInConfig,
  resolveLinkedAccountsInConfig,
  resolveServiceRoutingInConfig,
} from "./first-run-options.js";

export type ElizaCloudService =
  | "inference"
  | "tts"
  | "media"
  | "embeddings"
  | "rpc";

export type ResolvedElizaCloudTopology = {
  linked: boolean;
  provider: "elizacloud" | null;
  runtime: "cloud" | "local";
  /**
   * Services the config routes to Cloud. This is declared *intent*: it stays
   * true when the account is unlinked, because the routing entry says so.
   */
  services: Record<ElizaCloudService, boolean>;
  /**
   * Services routed to Cloud that cannot actually be served because no Cloud
   * credential is linked. This is the reconciliation between the two sources
   * of truth that previously never met: config declares "use Cloud", while
   * handler registration silently requires a key, so the runtime fell back
   * without anything recording that it had (elizaOS/eliza#20045 R3/R4).
   *
   * Empty when the account is linked or when nothing routes to Cloud.
   */
  servicesUnreconciled: ElizaCloudService[];
  shouldLoadPlugin: boolean;
};

const REDACTED_SECRET = "[REDACTED]";

function asConfigRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function _readConfigString(
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

function normalizeSecretString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  if (!trimmed || trimmed.toUpperCase() === REDACTED_SECRET) {
    return undefined;
  }
  return trimmed;
}

export function isElizaCloudLinkedInConfig(
  config: Record<string, unknown> | null | undefined,
): boolean {
  const linkedAccounts = resolveLinkedAccountsInConfig(config);
  const linkedCloudAccount = linkedAccounts?.elizacloud;
  if (linkedCloudAccount?.status === "linked") {
    return true;
  }

  const cloud = asConfigRecord(config?.cloud);
  return Boolean(normalizeSecretString(cloud?.apiKey));
}

export function resolveElizaCloudTopology(
  config: Record<string, unknown> | null | undefined,
): ResolvedElizaCloudTopology {
  const deploymentTarget = resolveDeploymentTargetInConfig(config);
  const routing = resolveServiceRoutingInConfig(config);
  const provider =
    (normalizeFirstRunProviderId(routing?.llmText?.backend) === "elizacloud"
      ? "elizacloud"
      : null) ??
    (deploymentTarget.provider === "elizacloud" ? "elizacloud" : null);
  const runtime = deploymentTarget.runtime === "cloud" ? "cloud" : "local";
  const resolvedServices = {
    inference: Boolean(
      routing?.llmText?.transport === "cloud-proxy" &&
        normalizeFirstRunProviderId(routing.llmText.backend) === "elizacloud",
    ),
    tts: Boolean(
      routing?.tts?.transport === "cloud-proxy" &&
        normalizeFirstRunProviderId(routing.tts.backend) === "elizacloud",
    ),
    media: Boolean(
      routing?.media?.transport === "cloud-proxy" &&
        normalizeFirstRunProviderId(routing.media.backend) === "elizacloud",
    ),
    embeddings: Boolean(
      routing?.embeddings?.transport === "cloud-proxy" &&
        normalizeFirstRunProviderId(routing.embeddings.backend) ===
          "elizacloud",
    ),
    rpc: Boolean(
      routing?.rpc?.transport === "cloud-proxy" &&
        normalizeFirstRunProviderId(routing.rpc.backend) === "elizacloud",
    ),
  } satisfies Record<ElizaCloudService, boolean>;
  const cloudDeploymentSelected =
    deploymentTarget.runtime === "cloud" &&
    deploymentTarget.provider === "elizacloud";
  const linked = isElizaCloudLinkedInConfig(config);
  // A Cloud-routed service with no linked credential is configured but
  // unservable: plugin-elizacloud skips handler registration and the runtime
  // falls through to another provider. Naming that here gives the host and the
  // status surfaces one place to read "declared Cloud, cannot serve" instead
  // of each re-deriving it (or, as before, not noticing at all).
  const servicesUnreconciled = linked
    ? []
    : (Object.entries(resolvedServices) as [ElizaCloudService, boolean][])
        .filter(([, selected]) => selected)
        .map(([service]) => service);

  return {
    linked,
    provider: provider === "elizacloud" ? "elizacloud" : null,
    runtime,
    services: resolvedServices,
    servicesUnreconciled,
    shouldLoadPlugin:
      cloudDeploymentSelected || Object.values(resolvedServices).some(Boolean),
  };
}

/**
 * True when the config routes a service to Eliza Cloud that cannot be served
 * because no credential is linked. The host logs this at startup so the
 * silent fallback leaves a trace (#20045 R3).
 */
export function hasUnreconciledElizaCloudServices(
  config: Record<string, unknown> | null | undefined,
): boolean {
  return resolveElizaCloudTopology(config).servicesUnreconciled.length > 0;
}

export function isElizaCloudServiceSelectedInConfig(
  config: Record<string, unknown> | null | undefined,
  service: ElizaCloudService,
): boolean {
  return resolveElizaCloudTopology(config).services[service];
}

export function shouldLoadElizaCloudPluginInConfig(
  config: Record<string, unknown> | null | undefined,
): boolean {
  return resolveElizaCloudTopology(config).shouldLoadPlugin;
}
