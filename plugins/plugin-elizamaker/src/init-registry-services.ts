/**
 * ERC-8004 RegistryService + DropService bootstrap.
 *
 * Previously inlined in `packages/agent/src/api/server.ts`
 * (`startDeferredStartupWork`). Moving the construction here keeps the
 * agent server out of the ERC-8004 contract wiring; consumers that need
 * the live services read them through the in-process registries
 * (drop-service-registry / registry-service-registry).
 *
 * Timing: the original block ran post-listen via setImmediate-equivalent
 * deferred startup. This function preserves that behavior by spawning the
 * actual work asynchronously — callers invoke it without awaiting from
 * within Plugin.init, which lets the runtime finish booting before the
 * outbound RPC probe runs.
 */

import {
  loadElizaConfig,
  normalizeJsonRpcUrl,
  probeJsonRpcEndpoint,
  RegistryService,
  TxService,
} from "@elizaos/agent";
import type { IAgentRuntime } from "@elizaos/core";
import { logger } from "@elizaos/core";
import { DropService } from "./drop-service.js";
import { setElizaMakerDropService } from "./drop-service-registry.js";
import { initializeOGCode } from "./og-tracker.js";
import { setElizaMakerRegistryService } from "./registry-service-registry.js";

interface RegistryConfigShape {
  registryAddress?: string;
  collectionAddress?: string;
  mainnetRpc?: string;
}

interface FeaturesShape {
  dropEnabled?: boolean;
}

interface ElizaConfigShape {
  registry?: RegistryConfigShape;
  features?: FeaturesShape;
  env?: Record<string, string>;
}

function readRuntimeSetting(
  runtime: IAgentRuntime,
  key: string,
): string | undefined {
  const value = runtime.getSetting?.(key);
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

export async function initializeRegistryAndDropServices(
  runtime: IAgentRuntime,
): Promise<void> {
  initializeOGCode();

  const config = loadElizaConfig() as ElizaConfigShape;

  const evmKey =
    readRuntimeSetting(runtime, "EVM_PRIVATE_KEY") ??
    config.env?.EVM_PRIVATE_KEY;
  const registryConfig = config.registry;
  if (
    !evmKey ||
    !registryConfig?.registryAddress ||
    !registryConfig.mainnetRpc
  ) {
    return;
  }

  try {
    const registryRpcUrl = normalizeJsonRpcUrl(registryConfig.mainnetRpc);
    const registryRpcProbe = await probeJsonRpcEndpoint(registryRpcUrl);
    if (!registryRpcProbe.ok) {
      logger.warn(
        {
          reason: registryRpcProbe.reason,
        },
        "ERC-8004 registry service disabled because mainnetRpc is unavailable",
      );
      return;
    }

    const txService = new TxService(registryRpcUrl, evmKey);
    const registryService = new RegistryService(
      txService,
      registryConfig.registryAddress,
    );
    setElizaMakerRegistryService(registryService);

    if (registryConfig.collectionAddress) {
      const dropEnabled = config.features?.dropEnabled === true;
      const dropService = new DropService(
        txService,
        registryConfig.collectionAddress,
        dropEnabled,
      );
      setElizaMakerDropService(dropService);
    } else {
      setElizaMakerDropService(null);
    }

    logger.info(
      `ERC-8004 registry service initialised (${registryConfig.registryAddress})`,
    );
  } catch (err) {
    logger.warn({ err }, "Failed to initialize ERC-8004 registry service");
  }
}
