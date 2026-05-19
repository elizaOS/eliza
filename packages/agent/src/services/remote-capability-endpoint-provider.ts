import {
  CAPABILITY_ROUTER_SERVICE_TYPE,
  type IAgentRuntime,
} from "@elizaos/core";
import type { RemoteCapabilityEndpointConfig } from "./remote-capability-router.ts";
import {
  type RemoteCapabilityRouterConfig,
  RemoteCapabilityRouterService,
} from "./remote-capability-router.ts";
import {
  type RemotePluginSyncResult,
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
  const sync = await syncRemoteCapabilityPlugins(runtime, {
    unloadMissing: options.unloadMissing,
    unloadMissingEndpointIds: [provisioned.endpoint.id],
    modules,
    trustPolicy: buildRemoteCapabilityEndpointTrustPolicy(
      provisioned.endpoint.id,
      allowedModuleIds,
    ),
  });
  return { ...provisioned, allowedModuleIds, sync };
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
