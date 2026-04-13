import { logger, type IAgentRuntime, type Plugin } from "@elizaos/core";
import { gatePluginSessionForHostedApp } from "@elizaos/agent/services/app-session-gate";
import { manageLifeOpsBrowserAction } from "./action.ts";
import { lifeOpsBrowserProvider } from "./provider.ts";
import { LifeOpsBrowserPluginService } from "./service.ts";
import {
  blockWebsitesAction,
  getWebsiteBlockStatusAction,
  requestWebsiteBlockingPermissionAction,
  unblockWebsitesAction,
} from "./selfcontrol/action.ts";
import { websiteBlockerProvider } from "./selfcontrol/provider.ts";
import {
  type SelfControlPluginConfig,
  getSelfControlStatus,
  setSelfControlPluginConfig,
} from "./selfcontrol/selfcontrol.ts";
import { WebsiteBlockerService } from "./selfcontrol/service.ts";

const rawAppLifeOpsPlugin: Plugin = {
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

export const appLifeOpsPlugin: Plugin = gatePluginSessionForHostedApp(
  rawAppLifeOpsPlugin,
  "@elizaos/app-lifeops",
);

export const lifeOpsBrowserPlugin = appLifeOpsPlugin;

export {
  LifeOpsBrowserPluginService,
  lifeOpsBrowserProvider,
  manageLifeOpsBrowserAction,
};

export * from "./selfcontrol/index.ts";

export default appLifeOpsPlugin;
