/**
 * App-local re-export barrel for the iOS runtime configuration helpers, which
 * actually live in `@elizaos/ui` (`platform/ios-runtime`). Surfaces the
 * `IosRuntimeConfig` / `IosRuntimeMode` types plus `resolveIosRuntimeConfig`,
 * `apiBaseToDeviceBridgeUrl`, `resolveCloudApiBase`, and
 * `DEFAULT_ELIZA_CLOUD_BASE` under a stable app-side import path.
 */
export type {
  IosRuntimeConfig,
  IosRuntimeMode,
} from "../../ui/src/platform/ios-runtime";
export {
  apiBaseToDeviceBridgeUrl,
  DEFAULT_ELIZA_CLOUD_BASE,
  resolveCloudApiBase,
  resolveIosRuntimeConfig,
} from "../../ui/src/platform/ios-runtime";
