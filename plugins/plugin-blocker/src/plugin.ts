/**
 * elizaOS runtime plugin for the Focus / blocker app.
 *
 * Owns the website/app blocking platform:
 *   - WebsiteBlockerService and AppBlockerService (Service lifecycle)
 *   - websiteBlockerProvider and appBlockerProvider (per-turn context)
 *   - the SelfControl hosts-file engine + native website-blocker backend registry
 *   - the macOS / mobile app-blocking engine
 *   - the drizzle pgSchema('app_blocker') so the SQL plugin can migrate it
 *   - a "focus" view for the dashboard / overlay shell
 *
 * The BLOCK umbrella action is still registered by the personal-assistant
 * plugin this slice (its persistence couples to the lifeops SQL layer), so it
 * is intentionally not registered here to avoid double-registration.
 */

import { type IAgentRuntime, logger, type Plugin } from "@elizaos/core";

import * as dbSchema from "./db/index.ts";
import { appBlockerProvider } from "./providers/app-blocker.ts";
import { websiteBlockerProvider } from "./providers/website-blocker.ts";
import { AppBlockerService } from "./services/app-blocker/service.ts";
import {
  getSelfControlStatus,
  registerWebsiteBlockerTaskWorker,
  type SelfControlPluginConfig,
  setSelfControlPluginConfig,
  WebsiteBlockerService,
} from "./services/website-blocker/index.ts";
import { BLOCKER_LOG_PREFIX } from "./types.ts";

const BLOCKER_PLUGIN_NAME = "@elizaos/plugin-blocker";

export const blockerPlugin: Plugin = {
  name: BLOCKER_PLUGIN_NAME,
  description:
    "Focus / distraction control — website blocking via the SelfControl-style hosts engine and macOS app blocking. Exposes websiteBlockerProvider + appBlockerProvider, WebsiteBlockerService + AppBlockerService, and the Focus overlay view. Backed by drizzle pgSchema('app_blocker'); requires @elizaos/plugin-sql.",
  dependencies: ["@elizaos/plugin-sql"],
  providers: [websiteBlockerProvider, appBlockerProvider],
  services: [WebsiteBlockerService, AppBlockerService],
  schema: dbSchema,
  views: [
    {
      id: "focus",
      label: "Focus",
      description:
        "Website + app blocking schedule and active session controls",
      icon: "ShieldOff",
      path: "/focus",
      bundlePath: "dist/views/bundle.js",
      componentExport: "FocusView",
      tags: ["focus", "blocker", "distraction-control"],
      visibleInManager: true,
      desktopTabEnabled: true,
    },
  ],
  init: async (
    pluginConfig: Record<string, unknown>,
    runtime: IAgentRuntime,
  ) => {
    registerWebsiteBlockerTaskWorker(runtime);
    setSelfControlPluginConfig(pluginConfig as SelfControlPluginConfig);
    const status = await getSelfControlStatus();
    if (status.available) {
      logger.info(
        `${BLOCKER_LOG_PREFIX} Hosts-file blocker ready${
          status.active && status.endsAt
            ? ` until ${status.endsAt}`
            : status.active
              ? " until manually unblocked"
              : ""
        }`,
      );
    } else {
      logger.warn(
        `${BLOCKER_LOG_PREFIX} Plugin loaded, but local website blocking is unavailable: ${status.reason ?? "unknown reason"}`,
      );
    }
  },
  async dispose(runtime) {
    const website = runtime.getService<WebsiteBlockerService>(
      WebsiteBlockerService.serviceType,
    );
    await website?.stop();
    const app = runtime.getService<AppBlockerService>(
      AppBlockerService.serviceType,
    );
    await app?.stop();
  },
};

export default blockerPlugin;
