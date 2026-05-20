import {
  CAPABILITY_ROUTER_SERVICE_TYPE,
  type IAgentRuntime,
  type RemotePluginModuleManifest,
} from "@elizaos/core";
import {
  type RemoteCapabilityEndpointConfig,
  type RemoteCapabilityRouterConfig,
  RemoteCapabilityRouterService,
} from "./remote-capability-router.ts";
import {
  type RemotePluginSyncResult,
  type RemotePluginTrustDecision,
  type RemotePluginTrustPolicy,
  syncRemoteCapabilityPlugins,
} from "./remote-plugin-adapter.ts";
import type { TeeEvidenceProvider } from "./tee-evidence.ts";
import {
  evaluateTeeEvidencePolicy,
  type TeeEvidencePolicy,
  type TeeEvidencePolicyDecision,
} from "./tee-policy.ts";

const DEFAULT_REMOTE_ENDPOINT_ID = "direct";
const DEFAULT_REQUEST_TIMEOUT_MS = 60_000;

export type RemoteCapabilityEndpointProviderId =
  | "direct"
  | "cloud"
  | "dstack"
  | "dstack-cloud"
  | "cvm-direct"
  | "e2b"
  | "home-machine"
  | "mobile-companion"
  | "desktop-companion"
  | (string & {});

export type ProvisionedRemoteCapabilityEndpoint = {
  providerId: RemoteCapabilityEndpointProviderId;
  endpoint: RemoteCapabilityEndpointConfig;
  allowedModuleIds?: string[];
  trustPolicy?: RemoteCapabilityEndpointTrustPolicyOptions;
  agentId?: string;
  jobId?: string;
  metadata?: Record<string, unknown>;
};

export type RemoteCapabilityEndpointTrustPolicyOptions = Pick<
  RemotePluginTrustPolicy,
  | "allowedProvenanceIssuers"
  | "trustedProvenancePublicKeys"
  | "requireSignedProvenance"
  | "requireVerifiedProvenance"
  | "requireProvenanceDigestMatch"
> & {
  requireTeeEvidence?: boolean;
  teePolicy?: TeeEvidencePolicy;
};

export type RemoteCapabilityEndpointProvider<TOptions = unknown> = {
  id: RemoteCapabilityEndpointProviderId;
  provision: (
    options: TOptions,
  ) => Promise<ProvisionedRemoteCapabilityEndpoint>;
};

export type DirectRemoteCapabilityEndpointProviderOptions = {
  endpoint: RemoteCapabilityEndpointConfig;
  allowedModuleIds?: string[];
};

export type TeeRemoteCapabilityEndpointProviderOptions = {
  endpoint: RemoteCapabilityEndpointConfig;
  evidenceProvider: TeeEvidenceProvider;
  providerId?: RemoteCapabilityEndpointProviderId;
  allowedModuleIds?: string[];
  trustPolicy?: RemoteCapabilityEndpointTrustPolicyOptions;
  metadata?: Record<string, unknown>;
};

export type ConnectRemoteCapabilityEndpointProviderOptions<TOptions = unknown> =
  {
    provider: RemoteCapabilityEndpointProvider<TOptions>;
    provisionOptions: TOptions;
    unloadMissing?: boolean;
    requestTimeoutMs?: number;
    allowedModuleIds?: string[];
    trustPolicy?: RemoteCapabilityEndpointTrustPolicyOptions;
  };

export type ConnectRemoteCapabilityEndpointProviderResult =
  ProvisionedRemoteCapabilityEndpoint & {
    sync: RemotePluginSyncResult;
    teeTrustDecision?: TeeEvidencePolicyDecision;
  };

export function directRemoteCapabilityEndpointProvider(): RemoteCapabilityEndpointProvider<DirectRemoteCapabilityEndpointProviderOptions> {
  return {
    id: "direct",
    provision: async ({ endpoint, allowedModuleIds }) => ({
      providerId: "direct",
      endpoint: normalizeEndpoint(endpoint),
      ...(allowedModuleIds === undefined ? {} : { allowedModuleIds }),
    }),
  };
}

export function teeRemoteCapabilityEndpointProvider(): RemoteCapabilityEndpointProvider<TeeRemoteCapabilityEndpointProviderOptions> {
  return {
    id: "dstack",
    provision: async ({
      endpoint,
      evidenceProvider,
      providerId,
      allowedModuleIds,
      trustPolicy,
      metadata,
    }) => ({
      providerId: providerId ?? "dstack",
      endpoint: normalizeEndpoint(endpoint),
      ...(allowedModuleIds === undefined ? {} : { allowedModuleIds }),
      ...(trustPolicy === undefined ? {} : { trustPolicy }),
      metadata: {
        ...(metadata ?? {}),
        teeEvidence: await evidenceProvider.collectEvidence(),
      },
    }),
  };
}

export function buildRemoteCapabilityEndpointTrustPolicy(
  endpoint: RemoteCapabilityEndpointConfig,
  allowedModuleIds?: string[],
  trustPolicy?: RemoteCapabilityEndpointTrustPolicyOptions,
): RemotePluginTrustPolicy {
  const nextAllowedModuleIds = uniqueNonEmptyStrings(allowedModuleIds);
  return {
    allowedEndpointIds: [endpoint.id],
    ...(nextAllowedModuleIds.length === 0
      ? {}
      : { allowedModuleIds: nextAllowedModuleIds }),
    ...normalizeEndpointTrustPolicyOptions(trustPolicy),
    requireEndpointId: true,
  };
}

export function installRemoteCapabilityEndpoint(
  runtime: IAgentRuntime,
  config: Partial<RemoteCapabilityRouterConfig> &
    Pick<RemoteCapabilityRouterConfig, "environment">,
): RemoteCapabilityRouterService {
  const endpoints = mergeEndpointConfigs(
    existingEndpointConfigs(runtime),
    config.endpoints ?? [],
  );
  const router = new RemoteCapabilityRouterService(runtime, {
    enabled: config.enabled ?? true,
    environment: config.environment,
    requestTimeoutMs: config.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
    ...(config.baseUrl === undefined ? {} : { baseUrl: config.baseUrl }),
    ...(config.token === undefined ? {} : { token: config.token }),
    ...(endpoints.length === 0 ? {} : { endpoints }),
  });

  const runtimeWithServices = runtime as IAgentRuntime & {
    services?: Map<string, unknown[]>;
  };
  const services = runtimeWithServices.services;
  if (services instanceof Map) {
    services.set(CAPABILITY_ROUTER_SERVICE_TYPE, [router]);
  }
  return router;
}

export async function connectRemoteCapabilityEndpointProvider<TOptions>(
  runtime: IAgentRuntime,
  options: ConnectRemoteCapabilityEndpointProviderOptions<TOptions>,
): Promise<ConnectRemoteCapabilityEndpointProviderResult> {
  const provisioned = await options.provider.provision(
    options.provisionOptions,
  );
  const endpoint = normalizeEndpoint(provisioned.endpoint);
  const allowedModuleIds =
    options.allowedModuleIds ??
    provisioned.allowedModuleIds ??
    allowedModuleIdsFromProvisionOptions(options.provisionOptions);
  const trustPolicy = normalizeEndpointTrustPolicyOptions(
    options.trustPolicy ?? provisioned.trustPolicy,
  );
  const teeTrustDecision = evaluateProvisionedEndpointTeeTrust(
    provisioned,
    trustPolicy,
  );

  const router = installRemoteCapabilityEndpoint(runtime, {
    enabled: true,
    environment: "server",
    endpoints: [endpoint],
    requestTimeoutMs: options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
  });
  const modules = (await router.plugin.listModules({ endpointId: endpoint.id }))
    .modules;
  const { trustedModules, skipped, skippedTrustDecisions } =
    selectAllowedRemoteCapabilityModules(
      modules,
      endpoint.id,
      allowedModuleIds,
    );
  const sync = await syncRemoteCapabilityPlugins(runtime, {
    modules: trustedModules,
    unloadMissing: options.unloadMissing,
    unloadMissingEndpointIds: [endpoint.id],
    trustPolicy: buildRemoteCapabilityEndpointTrustPolicy(
      endpoint,
      allowedModuleIds,
      trustPolicy,
    ),
  });

  return {
    ...provisioned,
    endpoint,
    ...(allowedModuleIds === undefined ? {} : { allowedModuleIds }),
    ...(Object.keys(trustPolicy).length === 0 ? {} : { trustPolicy }),
    ...(teeTrustDecision === undefined ? {} : { teeTrustDecision }),
    sync: {
      ...sync,
      skipped: mergeSkippedRemoteCapabilityPlugins(sync.skipped, skipped, {
        unloaded: sync.unloaded,
      }),
      trustDecisions: [...sync.trustDecisions, ...skippedTrustDecisions],
    },
  };
}

export function normalizeEndpointTrustPolicyOptions(
  trustPolicy: RemoteCapabilityEndpointTrustPolicyOptions | undefined,
): RemoteCapabilityEndpointTrustPolicyOptions {
  if (!trustPolicy) return {};
  const allowedProvenanceIssuers = uniqueNonEmptyStrings(
    trustPolicy.allowedProvenanceIssuers,
  );
  const trustedProvenancePublicKeys = normalizeTrustedProvenancePublicKeys(
    trustPolicy.trustedProvenancePublicKeys,
  );
  return {
    ...(allowedProvenanceIssuers.length === 0
      ? {}
      : { allowedProvenanceIssuers }),
    ...(Object.keys(trustedProvenancePublicKeys).length === 0
      ? {}
      : { trustedProvenancePublicKeys }),
    ...(trustPolicy.requireSignedProvenance === true
      ? { requireSignedProvenance: true }
      : {}),
    ...(trustPolicy.requireVerifiedProvenance === true
      ? { requireVerifiedProvenance: true, requireSignedProvenance: true }
      : {}),
    ...(trustPolicy.requireProvenanceDigestMatch === true
      ? { requireProvenanceDigestMatch: true, requireSignedProvenance: true }
      : {}),
    ...(trustPolicy.requireTeeEvidence === true
      ? { requireTeeEvidence: true }
      : {}),
    ...(trustPolicy.teePolicy === undefined
      ? {}
      : { teePolicy: trustPolicy.teePolicy }),
  };
}

function evaluateProvisionedEndpointTeeTrust(
  provisioned: ProvisionedRemoteCapabilityEndpoint,
  trustPolicy: RemoteCapabilityEndpointTrustPolicyOptions,
): TeeEvidencePolicyDecision | undefined {
  const teePolicy =
    trustPolicy.teePolicy === undefined &&
    trustPolicy.requireTeeEvidence !== true
      ? undefined
      : {
          ...(trustPolicy.teePolicy ?? {}),
          ...(trustPolicy.requireTeeEvidence === true
            ? { required: true }
            : {}),
        };
  if (!teePolicy) return undefined;
  const decision = evaluateTeeEvidencePolicy(
    readProvisionedTeeEvidence(provisioned),
    teePolicy,
  );
  if (!decision.trusted) {
    throw new Error(
      `Remote capability endpoint "${provisioned.endpoint.id}" failed TEE trust policy: ${decision.detail ?? decision.reason}`,
    );
  }
  return decision;
}

function readProvisionedTeeEvidence(
  provisioned: ProvisionedRemoteCapabilityEndpoint,
): unknown {
  const metadata = provisioned.metadata;
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
    return undefined;
  }
  return (metadata as { teeEvidence?: unknown }).teeEvidence;
}

function normalizeTrustedProvenancePublicKeys(
  value: Record<string, string> | undefined,
): Record<string, string> {
  if (!value) return {};
  const result: Record<string, string> = {};
  for (const [issuer, publicKey] of Object.entries(value)) {
    const nextIssuer = issuer.trim();
    const nextPublicKey = publicKey.trim();
    if (nextIssuer && nextPublicKey) {
      result[nextIssuer] = nextPublicKey;
    }
  }
  return result;
}

function existingEndpointConfigs(
  runtime: IAgentRuntime,
): RemoteCapabilityEndpointConfig[] {
  const service = runtime.getService?.(CAPABILITY_ROUTER_SERVICE_TYPE) as
    | { getEndpointConfigs?: () => RemoteCapabilityEndpointConfig[] }
    | null
    | undefined;
  if (typeof service?.getEndpointConfigs !== "function") return [];
  return service.getEndpointConfigs().map(normalizeEndpoint);
}

function mergeEndpointConfigs(
  existing: RemoteCapabilityEndpointConfig[],
  incoming: RemoteCapabilityEndpointConfig[],
): RemoteCapabilityEndpointConfig[] {
  const merged: RemoteCapabilityEndpointConfig[] = [];
  for (const endpoint of [...existing, ...incoming]) {
    const next = normalizeEndpoint(endpoint);
    const index = merged.findIndex(
      (item) => item.id === next.id || item.baseUrl === next.baseUrl,
    );
    if (index >= 0) {
      merged[index] = next;
    } else {
      merged.push(next);
    }
  }
  return merged;
}

function normalizeEndpoint(
  endpoint: RemoteCapabilityEndpointConfig,
): RemoteCapabilityEndpointConfig {
  return {
    id: endpoint.id.trim() || DEFAULT_REMOTE_ENDPOINT_ID,
    baseUrl: normalizeBaseUrl(endpoint.baseUrl),
    ...(endpoint.token === undefined || !endpoint.token.trim()
      ? {}
      : { token: endpoint.token.trim() }),
  };
}

function normalizeBaseUrl(value: string): string {
  const url = new URL(value.trim());
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("Remote capability endpoint baseUrl must be http(s).");
  }
  url.hash = "";
  url.search = "";
  return url.toString().replace(/\/+$/, "");
}

function allowedModuleIdsFromProvisionOptions(
  value: unknown,
): string[] | undefined {
  if (!value || typeof value !== "object") return undefined;
  const allowedModuleIds = (value as { allowedModuleIds?: unknown })
    .allowedModuleIds;
  const normalized = uniqueNonEmptyStrings(allowedModuleIds);
  return normalized.length === 0 ? undefined : normalized;
}

function uniqueNonEmptyStrings(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [
    ...new Set(
      value
        .filter((item): item is string => typeof item === "string")
        .map((item) => item.trim())
        .filter(Boolean),
    ),
  ];
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
