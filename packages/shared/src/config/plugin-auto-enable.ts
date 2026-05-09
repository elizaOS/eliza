// Override applyPluginAutoEnable to inject WeChat auto-enable before upstream.
import {
  applyPluginAutoEnable as _upstreamApplyPluginAutoEnable,
  CONNECTOR_PLUGINS as _upstreamConnectorPlugins,
  type ApplyPluginAutoEnableParams,
  type ApplyPluginAutoEnableResult,
  AUTH_PROVIDER_PLUGINS,
  applyPluginSelfDeclaredAutoEnable,
  isConnectorConfigured,
  isStreamingDestinationConfigured,
  STREAMING_PLUGINS,
} from "@elizaos/agent/config/plugin-auto-enable";

export {
  AUTH_PROVIDER_PLUGINS,
  applyPluginSelfDeclaredAutoEnable,
  isConnectorConfigured,
  isStreamingDestinationConfigured,
  STREAMING_PLUGINS,
};

// Extend upstream CONNECTOR_PLUGINS with App-local connectors.
export const CONNECTOR_PLUGINS: Record<string, string> = {
  ..._upstreamConnectorPlugins,
  wechat: "elizaoswechat",
};

import { isNativeServerPlatform } from "../platform/is-native-server";
import { isWechatConfigured } from "./wechat-config";

export function applyPluginAutoEnable(
  params: ApplyPluginAutoEnableParams,
): ApplyPluginAutoEnableResult {
  const config = params.config as Record<string, unknown>;

  // Inject WeChat before upstream runs (upstream doesn't know about wechat)
  const connectors = config?.connectors as Record<string, unknown> | undefined;
  const wechatBlock = connectors?.wechat as Record<string, unknown> | undefined;

  if (wechatBlock && isWechatConfigured(wechatBlock)) {
    if (config.plugins == null) config.plugins = {};
    const plugins = config.plugins as Record<string, unknown>;
    if (plugins.allow == null) plugins.allow = [];
    const allow = plugins.allow as string[];
    if (!allow.includes("elizaoswechat") && !allow.includes("wechat")) {
      allow.push("elizaoswechat");
    }
  }

  // Auto-enable Steward wallet plugin when STEWARD_API_URL is configured
  const env = params.env ?? process.env;
  if ((env as Record<string, string | undefined>).STEWARD_API_URL?.trim()) {
    if (config.plugins == null) config.plugins = {};
    const plugins = config.plugins as Record<string, unknown>;
    if (plugins.allow == null) plugins.allow = [];
    const allow = plugins.allow as string[];
    if (!allow.includes("@stwd/eliza-plugin")) {
      allow.push("@stwd/eliza-plugin");
    }
  }

  // Delegate to upstream for all other connectors. The upstream auto-enable
  // gate requires cloud auth before enabling @elizaos/plugin-workflow.
  return _upstreamApplyPluginAutoEnable({
    ...params,
    isNativePlatform: params.isNativePlatform ?? isNativeServerPlatform(),
  });
}
