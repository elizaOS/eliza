/** Exposes shared mobile configuration and rejects runtime modes absent from this app. */
import { ElizaError } from "../../core/src/errors";
import {
  type IosRuntimeConfig,
  resolveIosRuntimeConfig as resolveSharedIosRuntimeConfig,
} from "../../ui/src/platform/ios-runtime";

export type {
  IosRuntimeConfig,
  IosRuntimeMode,
} from "../../ui/src/platform/ios-runtime";
export {
  apiBaseToDeviceBridgeUrl,
  DEFAULT_ELIZA_CLOUD_BASE,
  resolveCloudApiBase,
} from "../../ui/src/platform/ios-runtime";

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
