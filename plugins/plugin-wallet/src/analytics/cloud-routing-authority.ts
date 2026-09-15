/**
 * Adapts wallet analytics routing to the immutable local-development Cloud
 * launch tuple without changing direct-provider setting precedence.
 */

import {
  type RuntimeSettings,
  toRuntimeSettings,
} from "@elizaos/cloud-routing";
import { captureDevCloudEnvAuthoritySnapshot } from "@elizaos/shared";

const AUTHORITY_OWNED_ROUTING_KEYS = new Set([
  "ELIZAOS_CLOUD_API_KEY",
  "ELIZAOS_CLOUD_BASE_URL",
  "ELIZAOS_CLOUD_ENABLED",
]);

/**
 * Return runtime settings with only the Cloud proxy tuple projected from the
 * frozen launcher snapshot. Local provider keys and service-specific settings
 * continue to come from the runtime.
 */
export function toWalletCloudRoutingSettings(runtime: {
  getSetting(key: string): unknown;
}): RuntimeSettings {
  const delegated = toRuntimeSettings(runtime);
  const snapshot = captureDevCloudEnvAuthoritySnapshot();
  if (!snapshot) return delegated;

  const activationBlocked =
    snapshot.authority === "staging-default" ||
    snapshot.authority === "offline";
  const authorityValues: Readonly<
    Record<string, string | boolean | undefined>
  > = Object.freeze({
    ELIZAOS_CLOUD_API_KEY: activationBlocked
      ? undefined
      : snapshot.values.ELIZAOS_CLOUD_API_KEY,
    ELIZAOS_CLOUD_BASE_URL: snapshot.values.ELIZAOS_CLOUD_BASE_URL,
    ELIZAOS_CLOUD_ENABLED: activationBlocked
      ? false
      : snapshot.values.ELIZAOS_CLOUD_ENABLED,
  });

  return {
    getSetting(key: string): string | boolean | number | null | undefined {
      if (AUTHORITY_OWNED_ROUTING_KEYS.has(key)) {
        return authorityValues[key];
      }
      return delegated.getSetting(key);
    },
  };
}
