/** Exposes shared mobile configuration and rejects runtime modes absent from this app. */
import { ElizaError } from "@elizaos/core/protocol";
import {
  type IosRuntimeConfig,
  resolveIosRuntimeConfig as resolveSharedIosRuntimeConfig,
} from "@elizaos/ui";

export {
  apiBaseToDeviceBridgeUrl,
  DEFAULT_ELIZA_CLOUD_BASE,
  type IosRuntimeConfig,
  type IosRuntimeMode,
  resolveCloudApiBase,
} from "@elizaos/ui";

export function assertSupportedIosRuntimeConfig(
  config: IosRuntimeConfig,
): void {
  if (config.mode === "tunnel-to-mobile") {
    throw new ElizaError(
      "The mobile tunnel runtime is no longer available. Select local, cloud, cloud-hybrid, or remote-mac mode.",
      {
        code: "MOBILE_TUNNEL_UNAVAILABLE",
        context: { mode: config.mode },
      },
    );
  }
}

export function resolveIosRuntimeConfig(
  env: Parameters<typeof resolveSharedIosRuntimeConfig>[0],
): IosRuntimeConfig {
  const config = resolveSharedIosRuntimeConfig(env);
  assertSupportedIosRuntimeConfig(config);
  return config;
}
