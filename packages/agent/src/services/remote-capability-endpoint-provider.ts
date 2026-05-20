import {
  CAPABILITY_ROUTER_SERVICE_TYPE,
  type IAgentRuntime,
  type RemotePluginModuleManifest,
} from "@elizaos/core";
import type { RemoteCapabilityEndpointConfig } from "./remote-capability-router.ts";
import {
  type RemoteCapabilityRouterConfig,
  RemoteCapabilityRouterService,
} from "./remote-capability-router.ts";
import {
  type RemotePluginSyncResult,
  type RemotePluginTrustDecision,
  type RemotePluginTrustPolicy,
  syncRemoteCapabilityPlugins,
} from "./remote-plugin-adapter.ts";

export type RemoteCapabilityEndpointProviderId =
  | "direct"
  | "cloud"
  | "e2b"
  | "home-machine"
  | "mobile-companion"
  | "desktop-companion"
  | (string & {});

export type ProvisionedRemoteCapabilityEndpoint = {
  providerId: RemoteCapabilityEndpointProviderId;
  endpoint: RemoteCapabilityEndpointConfig;
  allowedModuleIds?: string[];
  agentId?: string;
  jobId?: string;
  metadata?: Record<string, unknown>;
};

export type RemoteCapabilityEndpointProvider<TOptions> = {
  id: RemoteCapabilityEndpointProviderId;
  provision: (
    options: TOptions,
  ) => Promise<ProvisionedRemoteCapabilityEndpoint>;
};

export type ConnectRemoteCapabilityEndpointProviderOptions<TOptions> = {
  provider: RemoteCapabilityEndpointProvider<TOptions>;
  provisionOptions: TOptions;
  unloadMissing?: boolean;
  requestTimeoutMs?: number;
  allowedModuleIds?: string[];
};

export type ConnectRemoteCapabilityEndpointProviderResult =
  ProvisionedRemoteCapabilityEndpoint & {
    sync: RemotePluginSyncResult;
  };

export async function connectRemoteCapabilityEndpointProvider<TOptions>(
  runtime: IAgentRuntime,
  options: ConnectRemoteCapabilityEndpointProviderOptions<TOptions>,
): Promise<ConnectRemoteCapabilityEndpointProviderResult> {
  const provisioned = await options.provider.provision(
    options.provisionOptions,
  );
  const service = installRemoteCapabilityEndpoint(runtime, {
    enabled: true,
    endpoints: [provisioned.endpoint],
    environment: "server",
    requestTimeoutMs: options.requestTimeoutMs ?? 60_000,
  });
  const allowedModuleIds =
    options.allowedModuleIds ?? provisioned.allowedModuleIds;
  const modules = (
    await service.plugin.listModules({ endpointId: provisioned.endpoint.id })
  ).modules;
  const { trustedModules, skipped, skippedTrustDecisions } =
    selectAllowedRemoteCapabilityModules(
      modules,
      provisioned.endpoint.id,
      allowedModuleIds,
    );
  const sync = await syncRemoteCapabilityPlugins(runtime, {
    unloadMissing: options.unloadMissing,
    unloadMissingEndpointIds: [provisioned.endpoint.id],
    modules: trustedModules,
    trustPolicy: buildRemoteCapabilityEndpointTrustPolicy(
      provisioned.endpoint.id,
      allowedModuleIds,
    ),
  });
  return {
    ...provisioned,
    allowedModuleIds,
    sync: {
      ...sync,
      skipped: mergeSkippedRemoteCapabilityPlugins(sync.skipped, skipped, {
        unloaded: sync.unloaded,
      }),
      trustDecisions: [...sync.trustDecisions, ...skippedTrustDecisions],
    },
  };
}

export function directRemoteCapabilityEndpointProvider(): RemoteCapabilityEndpointProvider<{
  endpoint: RemoteCapabilityEndpointConfig;
  allowedModuleIds?: string[];
}> {
  return {
    id: "direct",
    provision: async (options) => ({
      providerId: "direct",
      endpoint: options.endpoint,
      ...(options.allowedModuleIds === undefined
        ? {}
        : { allowedModuleIds: options.allowedModuleIds }),
    }),
  };
}

export function buildRemoteCapabilityEndpointTrustPolicy(
  endpointId: string,
  allowedModuleIds?: string[],
): RemotePluginTrustPolicy {
  return {
    allowedEndpointIds: [endpointId],
    ...(allowedModuleIds === undefined ? {} : { allowedModuleIds }),
    requireEndpointId: true,
  };
}

export function installRemoteCapabilityEndpoint(
  runtime: IAgentRuntime,
  config: RemoteCapabilityRouterConfig,
): RemoteCapabilityRouterService {
  const service = new RemoteCapabilityRouterService(runtime, {
    ...config,
    endpoints: mergeRemoteCapabilityEndpoints(
      getInstalledRemoteCapabilityEndpoints(runtime),
      config.endpoints ?? [],
    ),
  });
  runtime.services.set(CAPABILITY_ROUTER_SERVICE_TYPE as never, [service]);
  return service;
}

function getInstalledRemoteCapabilityEndpoints(
  runtime: IAgentRuntime,
): RemoteCapabilityEndpointConfig[] {
  const existing = runtime.getService?.(
    CAPABILITY_ROUTER_SERVICE_TYPE,
  ) as unknown as
    | { getEndpointConfigs?: () => RemoteCapabilityEndpointConfig[] }
    | null
    | undefined;
  return existing?.getEndpointConfigs?.() ?? [];
}

function mergeRemoteCapabilityEndpoints(
  existing: RemoteCapabilityEndpointConfig[],
  incoming: RemoteCapabilityEndpointConfig[],
): RemoteCapabilityEndpointConfig[] {
  const merged: RemoteCapabilityEndpointConfig[] = [];
  for (const endpoint of [...existing, ...incoming]) {
    const index = merged.findIndex(
      (item) =>
        item.id === endpoint.id ||
        stripTrailingSlash(item.baseUrl) ===
          stripTrailingSlash(endpoint.baseUrl),
    );
    if (index >= 0) {
      merged[index] = endpoint;
    } else {
      merged.push(endpoint);
    }
  }
  return merged;
}

function stripTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "");
}

function selectAllowedRemoteCapabilityModules(
  modules: RemotePluginModuleManifest[],
  endpointId: string,
  allowedModuleIds: string[] | undefined,
): {
  trustedModules: RemotePluginModuleManifest[];
  skipped: string[];
  skippedTrustDecisions: RemotePluginTrustDecision[];
} {
  if (allowedModuleIds === undefined) {
    return { trustedModules: modules, skipped: [], skippedTrustDecisions: [] };
  }
  const allowed = new Set(allowedModuleIds);
  const trustedModules: RemotePluginModuleManifest[] = [];
  const skipped: string[] = [];
  const skippedTrustDecisions: RemotePluginTrustDecision[] = [];
  for (const module of modules) {
    if (allowed.has(module.id)) {
      trustedModules.push(module);
    } else {
      skipped.push(module.name);
      skippedTrustDecisions.push({
        endpointId,
        moduleId: module.id,
        pluginName: module.name,
        trusted: false,
        reason: "module-not-allowed",
      });
    }
  }
  return { trustedModules, skipped, skippedTrustDecisions };
}

function mergeSkippedRemoteCapabilityPlugins(
  existing: string[],
  additional: string[],
  options: { unloaded: string[] },
): string[] {
  const unloaded = new Set(options.unloaded);
  const skipped = new Set<string>();
  for (const pluginName of [...existing, ...additional]) {
    if (unloaded.has(pluginName)) continue;
    skipped.add(pluginName);
  }
  return [...skipped];
}
