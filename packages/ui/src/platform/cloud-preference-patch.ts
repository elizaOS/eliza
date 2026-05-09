import {
  getOnboardingProviderOption,
  isElizaCloudLinkedInConfig,
  resolveDeploymentTargetInConfig,
  resolveElizaCloudTopology,
  resolveServiceRoutingInConfig,
} from "@elizaos/shared";
import { asRecord, readString } from "../state/config-readers";
import type {
  CloudPreferenceClientLike as ClientLike,
  CloudPreferencePatchState as PatchState,
} from "./types";

const PATCH_STATE = Symbol.for("elizaos.cloudPreferencePatch");
type PatchableClient = ClientLike & { [PATCH_STATE]?: PatchState };

type StorageConfig = Record<string, unknown>;

function hasRemoteConnection(
  config: StorageConfig | null | undefined,
): boolean {
  return (
    resolveDeploymentTargetInConfig(config as Record<string, unknown>)
      .runtime === "remote"
  );
}

function cloudHandlesInference(
  config: StorageConfig | null | undefined,
): boolean {
  return resolveElizaCloudTopology(config as Record<string, unknown>).services
    .inference;
}

function hasInactiveCloudSignals(
  config: StorageConfig | null | undefined,
): boolean {
  return isElizaCloudLinkedInConfig(config as Record<string, unknown>);
}

export function shouldPreferLocalProviderConfig(
  config: StorageConfig | null | undefined,
): boolean {
  if (!config) return false;

  const llmText = resolveServiceRoutingInConfig(
    config as Record<string, unknown>,
  )?.llmText;
  const directProvider = getOnboardingProviderOption(llmText?.backend)?.id;
  if (llmText?.transport !== "direct" || !directProvider) {
    return false;
  }

  return Boolean(
    !hasRemoteConnection(config) &&
      !cloudHandlesInference(config) &&
      hasInactiveCloudSignals(config),
  );
}

export function normalizeConfigForLocalProviderPreference(
  config: StorageConfig | null | undefined,
): StorageConfig | null | undefined {
  if (!config || !shouldPreferLocalProviderConfig(config)) {
    return config;
  }

  // Strip cloud capability flags (enabled, provider, inferenceMode, services)
  // but preserve the apiKey so the cloud account link remains intact for
  // non-inference services (e.g. RPC proxy, storage).
  const cloud = asRecord(config.cloud);
  const apiKey = readString(cloud, "apiKey");
  const nextCloud: Record<string, unknown> = {};
  if (apiKey) nextCloud.apiKey = apiKey;

  return { ...config, cloud: nextCloud };
}

export function shouldMaskInactiveCloudStatus(args: {
  config: StorageConfig | null | undefined;
  status: unknown;
}): boolean {
  if (!shouldPreferLocalProviderConfig(args.config)) {
    return false;
  }

  const status = asRecord(args.status);
  if (!status) {
    return false;
  }

  if (readString(status, "userId") || readString(status, "organizationId")) {
    return false;
  }

  return status.connected === true || status.hasApiKey === true;
}

export function installLocalProviderCloudPreferencePatch(
  client: ClientLike,
): () => void {
  const patchableClient = client as PatchableClient;
  const existingPatch = patchableClient[PATCH_STATE];
  if (existingPatch) {
    return () => {};
  }

  const originalGetConfig = client.getConfig.bind(client);

  patchableClient[PATCH_STATE] = {
    getConfig: client.getConfig,
    getCloudStatus: client.getCloudStatus,
    getCloudCredits: client.getCloudCredits,
  } satisfies PatchState;

  client.getConfig = (async () => {
    const config = (await originalGetConfig()) as
      | StorageConfig
      | null
      | undefined;
    return normalizeConfigForLocalProviderPreference(config) as Record<
      string,
      unknown
    >;
  }) as typeof client.getConfig;

  return () => {
    const patchState = patchableClient[PATCH_STATE];
    if (!patchState) {
      return;
    }
    client.getConfig = patchState.getConfig;
    client.getCloudStatus = patchState.getCloudStatus;
    if (patchState.getCloudCredits) {
      client.getCloudCredits = patchState.getCloudCredits;
    } else {
      delete client.getCloudCredits;
    }
    delete patchableClient[PATCH_STATE];
  };
}
