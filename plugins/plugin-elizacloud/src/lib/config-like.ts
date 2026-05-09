import type {
  DeploymentTargetConfig,
  ElizaConfig,
  LinkedAccountFlagsConfig,
  ServiceCapability,
  ServiceRoutingConfig,
} from "@elizaos/shared";

export type { ElizaConfig };

export interface CloudProxyConfigLike {
  cloud?: {
    apiKey?: string;
    baseUrl?: string;
    enabled?: boolean;
    serviceKey?: string;
  };
}

export interface AutonomousConfigLike {
  [key: string]: unknown;
}

type MutableElizaConfig = Partial<ElizaConfig> & {
  cloud?: Record<string, unknown>;
  deploymentTarget?: DeploymentTargetConfig;
  linkedAccounts?: LinkedAccountFlagsConfig;
  serviceRouting?: ServiceRoutingConfig;
};

function ensureLinkedAccounts(
  config: MutableElizaConfig,
): LinkedAccountFlagsConfig {
  config.linkedAccounts ??= {};
  return config.linkedAccounts;
}

function ensureServiceRouting(
  config: MutableElizaConfig,
): ServiceRoutingConfig {
  config.serviceRouting ??= {};
  return config.serviceRouting;
}

function persistDeploymentTarget(
  config: MutableElizaConfig,
  deploymentTarget: DeploymentTargetConfig | null | undefined,
): void {
  if (!deploymentTarget) {
    delete config.deploymentTarget;
    return;
  }
  config.deploymentTarget = { ...deploymentTarget };
}

function persistLinkedAccounts(
  config: MutableElizaConfig,
  linkedAccounts: LinkedAccountFlagsConfig | null | undefined,
): void {
  if (!linkedAccounts) return;

  const existing = ensureLinkedAccounts(config);
  for (const [accountId, account] of Object.entries(linkedAccounts)) {
    if (!account || Object.keys(account).length === 0) {
      delete existing[accountId];
      continue;
    }
    existing[accountId] = {
      ...existing[accountId],
      ...account,
    };
  }

  if (Object.keys(existing).length === 0) {
    delete config.linkedAccounts;
  }
}

function persistServiceRouting(
  config: MutableElizaConfig,
  serviceRouting: ServiceRoutingConfig | null | undefined,
  clearRoutes: readonly ServiceCapability[] = [],
): void {
  const existing = ensureServiceRouting(config);

  for (const capability of clearRoutes) {
    delete existing[capability];
  }

  if (serviceRouting) {
    for (const [capability, route] of Object.entries(serviceRouting)) {
      const serviceKey = capability as ServiceCapability;
      if (!route || Object.keys(route).length === 0) {
        delete existing[serviceKey];
        continue;
      }
      existing[serviceKey] = { ...route };
    }
  }

  if (Object.keys(existing).length === 0) {
    delete config.serviceRouting;
  }
}

export function applyCanonicalOnboardingConfig(
  config: MutableElizaConfig,
  args: {
    deploymentTarget?: DeploymentTargetConfig | null;
    linkedAccounts?: LinkedAccountFlagsConfig | null;
    serviceRouting?: ServiceRoutingConfig | null;
    clearRoutes?: readonly ServiceCapability[];
  },
): void {
  if (args.deploymentTarget !== undefined) {
    persistDeploymentTarget(config, args.deploymentTarget);
  }
  if (args.linkedAccounts !== undefined) {
    persistLinkedAccounts(config, args.linkedAccounts);
  }
  if (args.serviceRouting !== undefined || args.clearRoutes?.length) {
    persistServiceRouting(config, args.serviceRouting, args.clearRoutes);
  }
}

export function normalizeEnvValue(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed || undefined;
}

export function isTimeoutError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  if (error.name === "TimeoutError" || error.name === "AbortError") return true;
  const message = error.message.toLowerCase();
  return message.includes("timed out") || message.includes("timeout");
}
