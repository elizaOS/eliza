/** Provides explicit provider fixtures for deterministic sandbox orchestration tests. Importing this module installs no hooks, spies, or lifecycle simulation. */
import {
  type SandboxCreateConfig,
  type SandboxHandle,
  type SandboxProvider,
} from "../../sandbox-provider-types";

export const replacementAwareProviderMarker = Symbol("replacement-aware-provider");

export const replacementAttemptCounter = { value: 0 };

/**
 * Makes the deterministic provider fixtures honor Docker's durable replacement
 * callback order. Real provider coverage owns the remote Docker/VPN mechanics;
 * this harness keeps orchestration tests faithful without opening SSH.
 */
export function replacementAwareProvider<T extends SandboxProvider>(provider: T): T {
  const mutable = provider as T & {
    [replacementAwareProviderMarker]?: true;
    stop?: (sandboxId: string) => Promise<void>;
  };
  if (mutable[replacementAwareProviderMarker]) return provider;
  mutable[replacementAwareProviderMarker] = true;
  const originalCreate = provider.create.bind(provider);
  if (!provider.stopForReplacement) {
    const legacyFixtureStop = mutable.stop?.bind(provider);
    provider.stopForReplacement = legacyFixtureStop
      ? legacyFixtureStop
      : async (sandboxId) => {
          const outcome = await provider.stopForDeletion(sandboxId);
          if (outcome.kind !== "not-running-proven") {
            throw new Error("Replacement fixture could not prove the sandbox stopped");
          }
        };
  }
  provider.create = async (config: SandboxCreateConfig): Promise<SandboxHandle> => {
    let intentCalled = false;
    let createdCalled = false;
    let vpnCalled = false;
    const wrappedConfig: SandboxCreateConfig = {
      ...config,
      onReplacementCreateIntent: config.onReplacementCreateIntent
        ? async (handle) => {
            intentCalled = true;
            await config.onReplacementCreateIntent?.(handle);
          }
        : undefined,
      onReplacementCreated: config.onReplacementCreated
        ? async (handle) => {
            createdCalled = true;
            await config.onReplacementCreated?.(handle);
          }
        : undefined,
      onReplacementVpnRegistered: config.onReplacementVpnRegistered
        ? async (handle) => {
            vpnCalled = true;
            await config.onReplacementVpnRegistered?.(handle);
          }
        : undefined,
    };
    const rawHandle = await originalCreate(wrappedConfig);
    const rawMetadata = rawHandle.metadata ?? {};
    const nodeId = typeof rawMetadata.nodeId === "string" ? rawMetadata.nodeId : "";
    const containerName =
      typeof rawMetadata.containerName === "string" ? rawMetadata.containerName : "";
    if (
      rawMetadata.provider !== "docker" ||
      !nodeId ||
      !containerName ||
      !config.onReplacementCreateIntent
    ) {
      return rawHandle;
    }

    replacementAttemptCounter.value += 1;
    const replacementAttemptId =
      typeof rawMetadata.replacementAttemptId === "string"
        ? rawMetadata.replacementAttemptId
        : `00000000-0000-4000-8000-${replacementAttemptCounter.value.toString().padStart(12, "0")}`;
    const baseMetadata = {
      ...rawMetadata,
      replacementAttemptId,
      allocationCounted: rawMetadata.allocationCounted !== false,
    };
    const intentHandle: SandboxHandle = {
      ...rawHandle,
      metadata: {
        ...baseMetadata,
        containerId: null,
        vpnNodeId: null,
      },
    };
    if (!intentCalled) await config.onReplacementCreateIntent(intentHandle);

    const createdHandle: SandboxHandle = {
      ...rawHandle,
      metadata: {
        ...baseMetadata,
        containerId:
          typeof rawMetadata.containerId === "string"
            ? rawMetadata.containerId
            : `container-${rawHandle.sandboxId}`,
        vpnNodeId: null,
      },
    };
    if (!createdCalled) await config.onReplacementCreated?.(createdHandle);

    if (typeof rawMetadata.vpnNodeId === "string") {
      const vpnHandle: SandboxHandle = {
        ...createdHandle,
        metadata: {
          ...createdHandle.metadata,
          vpnNodeId: rawMetadata.vpnNodeId,
        },
      };
      if (!vpnCalled) await config.onReplacementVpnRegistered?.(vpnHandle);
      return vpnHandle;
    }
    return createdHandle;
  };
  return provider;
}
