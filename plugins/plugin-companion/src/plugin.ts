/**
 * elizaOS runtime plugin for the companion app (VRM emotes, etc.).
 */

import { gatePluginSessionForHostedApp } from "@elizaos/agent/services/app-session-gate";
import type { Plugin } from "@elizaos/core";
import { emoteAction } from "./actions/emote.js";

const COMPANION_APP_NAME = "@elizaos/plugin-companion";

const rawCompanionPlugin: Plugin = {
  name: COMPANION_APP_NAME,
  description:
    "Companion overlay: VRM avatar emotes and related runtime hooks. Actions apply only while the companion app session is active.",
  actions: [emoteAction],
  views: [
    // ONE declaration → GUI + XR + TUI, all drawn from the single CompanionView
    // spatial source. `modalities` is a plain literal here (plugin.ts is not in
    // the view bundle), so no brand-new `@elizaos/core` runtime export reaches
    // the bundle build. The TUI modality renders via the terminal registry
    // (see `register-terminal-view.tsx`), not a separate componentExport.
    {
      id: "companion",
      label: "Companion",
      description: "VRM avatar companion — 3D character overlay with emotes",
      icon: "Bot",
      path: "/companion",
      modalities: ["gui", "xr", "tui"],
      bundlePath: "dist/views/bundle.js",
      componentExport: "CompanionView",
      tags: ["companion", "avatar", "vrm"],
      visibleInManager: true,
      desktopTabEnabled: false,
    },
  ],
};

export const appCompanionPlugin: Plugin = gatePluginSessionForHostedApp(
  rawCompanionPlugin,
  COMPANION_APP_NAME,
);

export default appCompanionPlugin;

export { emoteAction } from "./actions/emote.js";
export * from "./emotes/catalog.js";
