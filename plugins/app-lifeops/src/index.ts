import { type IAgentRuntime, logger, type Plugin } from "@elizaos/core";
import { manageLifeOpsBrowserAction } from "./action";
import { lifeOpsBrowserProvider } from "./provider";
import { LifeOpsBrowserPluginService } from "./service";

// Self-control (hosts-file website blocker) — merged in
import {
  blockWebsitesAction,
  getWebsiteBlockStatusAction,
  requestWebsiteBlockingPermissionAction,
  unblockWebsitesAction,
} from "./selfcontrol/action.js";
import { websiteBlockerProvider } from "./selfcontrol/provider.js";
import {
  type SelfControlPluginConfig,
  getSelfControlStatus,
  setSelfControlPluginConfig,
} from "./selfcontrol/selfcontrol.js";
import { WebsiteBlockerService } from "./selfcontrol/service.js";

export const appLifeOpsPlugin: Plugin = {
  name: "@elizaos/app-lifeops",
  description:
    "LifeOps: browser companions (Chrome/Safari), hosts-file website blocking, and related surfaces.",
  actions: [
    manageLifeOpsBrowserAction,
    blockWebsitesAction,
    getWebsiteBlockStatusAction,
    requestWebsiteBlockingPermissionAction,
    unblockWebsitesAction,
  ],
  providers: [lifeOpsBrowserProvider, websiteBlockerProvider],
  services: [LifeOpsBrowserPluginService, WebsiteBlockerService],
  init: async (
    pluginConfig: Record<string, unknown>,
    _runtime: IAgentRuntime,
  ) => {
    setSelfControlPluginConfig(pluginConfig as SelfControlPluginConfig);
    const status = await getSelfControlStatus();

    if (status.available) {
      logger.info(
        `[selfcontrol] Hosts-file blocker ready${status.active && status.endsAt ? ` until ${status.endsAt}` : status.active ? " until manually unblocked" : ""}`,
      );
    } else {
      logger.warn(
        `[selfcontrol] Plugin loaded, but local website blocking is unavailable: ${status.reason ?? "unknown reason"}`,
      );
    }
  },
};

/** Alias for older imports; prefer `appLifeOpsPlugin`. */
export const lifeOpsBrowserPlugin = appLifeOpsPlugin;

export {
  LifeOpsBrowserPluginService,
  lifeOpsBrowserProvider,
  manageLifeOpsBrowserAction,
};

export * from "./selfcontrol/index.js";

export default appLifeOpsPlugin;
