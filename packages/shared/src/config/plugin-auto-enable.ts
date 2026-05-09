// Backward-compat surface for callers that imported from the old wrapper path.
// All real logic lives in plugin-auto-enable-engine.ts. The wechat connector
// and Steward auto-enable that this file used to add are now baked into the
// engine's CONNECTOR_PLUGINS map and Steward block respectively, so this
// wrapper exists only to:
//   1. Keep the public surface stable (named exports unchanged).
//   2. Pass a sensible default for `isNativePlatform` when callers don't set it.
import {
  type ApplyPluginAutoEnableParams,
  type ApplyPluginAutoEnableResult,
  applyPluginAutoEnable as _applyPluginAutoEnableEngine,
} from "./plugin-auto-enable-engine";

export {
  type ApplyPluginAutoEnableParams,
  type ApplyPluginAutoEnableResult,
  applyPluginSelfDeclaredAutoEnable,
  AUTH_PROVIDER_PLUGINS,
  CONNECTOR_PLUGINS,
  isConnectorConfigured,
  isStreamingDestinationConfigured,
  STREAMING_PLUGINS,
} from "./plugin-auto-enable-engine";

import { isNativeServerPlatform } from "../platform/is-native-server";

export function applyPluginAutoEnable(
  params: ApplyPluginAutoEnableParams,
): ApplyPluginAutoEnableResult {
  return _applyPluginAutoEnableEngine({
    ...params,
    isNativePlatform: params.isNativePlatform ?? isNativeServerPlatform(),
  });
}
