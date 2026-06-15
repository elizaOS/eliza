/**
 * elizaOS runtime plugin for the Focus / blocker app.
 *
 * Registers:
 *   - BLOCK umbrella action (target = app | website)
 *   - websiteBlockerProvider and appBlockerProvider (per-turn context)
 *   - WebsiteBlockerService and AppBlockerService (Service lifecycle)
 *   - The drizzle pgSchema('app_blocker') so the SQL plugin can migrate it
 *   - A "focus" view for the dashboard / overlay shell
 *
 * The action / providers / services are stubs in this initial scaffold. Real
 * implementations are migrated from plugin-lifeops in a follow-up pass — see
 * the TODO(migration) comments in each file.
 */

import type { Plugin } from "@elizaos/core";

import { blockAction } from "./actions/block.ts";
import * as dbSchema from "./db/index.ts";
import { appBlockerProvider } from "./providers/app-blocker.ts";
import { websiteBlockerProvider } from "./providers/website-blocker.ts";
import { AppBlockerService } from "./services/app-blocker.ts";
import { WebsiteBlockerService } from "./services/website-blocker.ts";

const BLOCKER_PLUGIN_NAME = "@elizaos/plugin-blocker";

export const blockerPlugin: Plugin = {
  name: BLOCKER_PLUGIN_NAME,
  description:
    "Focus / distraction control — website blocking via the SelfControl-style hosts engine and macOS app blocking. Exposes the BLOCK umbrella action, websiteBlockerProvider + appBlockerProvider, WebsiteBlockerService + AppBlockerService, and the Focus overlay view. Backed by drizzle pgSchema('app_blocker'); requires @elizaos/plugin-sql.",
  dependencies: ["@elizaos/plugin-sql"],
  actions: [blockAction],
  providers: [websiteBlockerProvider, appBlockerProvider],
  services: [WebsiteBlockerService, AppBlockerService],
  schema: dbSchema,
  views: [
    {
      id: "focus",
      label: "Focus",
      description: "Website + app blocking schedule and active session controls",
      icon: "ShieldOff",
      path: "/focus",
      bundlePath: "dist/views/bundle.js",
      componentExport: "FocusView",
      tags: ["focus", "blocker", "distraction-control"],
      visibleInManager: true,
      desktopTabEnabled: true,
    },
  ],
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
