/**
 * App-local re-export barrel for the iOS runtime configuration helpers, which
 * actually live in `@elizaos/ui` (`platform/ios-runtime`). Surfaces the
 * `IosRuntimeConfig` / `IosRuntimeMode` types plus `resolveIosRuntimeConfig`,
 * its generated full-Bun capability resolver, connection helpers, and default
 * cloud base under a stable app-side import path.
 */
export type {
  IosRuntimeConfig,
  IosRuntimeMode,
} from "../../ui/src/platform/ios-runtime";
export {
  apiBaseToDeviceBridgeUrl,
  DEFAULT_ELIZA_CLOUD_BASE,
  resolveCloudApiBase,
  resolveIosFullBunAvailable,
  resolveIosRuntimeConfig,
} from "../../ui/src/platform/ios-runtime";
