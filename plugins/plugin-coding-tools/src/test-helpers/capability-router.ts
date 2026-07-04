/**
 * Test double for the core capability router that reports every plugin capability
 * as unavailable, so tests can exercise the coding tools' plugin-absent code paths
 * without wiring a real router.
 */
import {
  CapabilityError,
  type ElizaCapabilityRouter,
  type RemotePluginCapability,
} from "@elizaos/core";

type RouterWithoutPlugin = Omit<ElizaCapabilityRouter, "plugin">;

function pluginUnavailable(method: string): never {
  throw new CapabilityError({
    code: "CAPABILITY_UNAVAILABLE",
    message: "plugin capability unavailable",
    capability: "plugin",
    method,
  });
}

export const unavailablePluginCapability: RemotePluginCapability = {
  listModules: async () => pluginUnavailable("plugin.modules.list"),
  invokeAction: async () => pluginUnavailable("plugin.action.invoke"),
  getProvider: async () => pluginUnavailable("plugin.provider.get"),
  callRoute: async () => pluginUnavailable("plugin.route.call"),
  getAsset: async () => pluginUnavailable("plugin.asset.get"),
  shouldRunEvaluator: async () =>
    pluginUnavailable("plugin.evaluator.shouldRun"),
  prepareEvaluator: async () => pluginUnavailable("plugin.evaluator.prepare"),
  promptEvaluator: async () => pluginUnavailable("plugin.evaluator.prompt"),
  processEvaluator: async () => pluginUnavailable("plugin.evaluator.process"),
  shouldRunResponseHandlerEvaluator: async () =>
    pluginUnavailable("plugin.responseHandler.evaluator.shouldRun"),
  evaluateResponseHandlerEvaluator: async () =>
    pluginUnavailable("plugin.responseHandler.evaluator.evaluate"),
  shouldRunResponseHandlerFieldEvaluator: async () =>
    pluginUnavailable("plugin.responseHandler.fieldEvaluator.shouldRun"),
  parseResponseHandlerFieldEvaluator: async () =>
    pluginUnavailable("plugin.responseHandler.fieldEvaluator.parse"),
  handleResponseHandlerFieldEvaluator: async () =>
    pluginUnavailable("plugin.responseHandler.fieldEvaluator.handle"),
  callLifecycle: async () => pluginUnavailable("plugin.lifecycle.call"),
  handleEvent: async () => pluginUnavailable("plugin.event.handle"),
  invokeModel: async () => pluginUnavailable("plugin.model.invoke"),
  callService: async () => pluginUnavailable("plugin.service.call"),
  callAppBridge: async () => pluginUnavailable("plugin.appBridge.call"),
};

export function withUnavailablePlugin(
  router: RouterWithoutPlugin,
): ElizaCapabilityRouter {
  return {
    ...router,
    plugin: unavailablePluginCapability,
  };
}
