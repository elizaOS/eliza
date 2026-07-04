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
  services: Record<ElizaCloudService, boolean>;
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

  return {
    linked: isElizaCloudLinkedInConfig(config),
    provider: provider === "elizacloud" ? "elizacloud" : null,
    runtime,
    services: resolvedServices,
    shouldLoadPlugin:
      cloudDeploymentSelected || Object.values(resolvedServices).some(Boolean),
  };
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
