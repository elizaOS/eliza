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
    {
      id: "companion",
      label: "Companion",
      description: "VRM avatar companion — 3D character overlay with emotes",
      icon: "Bot",
      path: "/companion",
      bundlePath: "dist/views/bundle.js",
      componentExport: "CompanionView",
      tags: ["companion", "avatar", "vrm"],
      visibleInManager: true,
      desktopTabEnabled: false,
    },
    {
      id: "companion",
      label: "Companion XR",
      description: "VRM avatar companion — 3D character overlay with emotes",
      icon: "Bot",
      path: "/companion",
      viewType: "xr",
      bundlePath: "dist/views/bundle.js",
      componentExport: "CompanionView",
      tags: ["companion", "avatar", "vrm"],
      visibleInManager: true,
      desktopTabEnabled: false,
    },
    {
      id: "companion",
      label: "Companion TUI",
      description: "Terminal VRM avatar companion and emote surface",
      icon: "Bot",
      path: "/companion/tui",
      viewType: "tui",
      bundlePath: "dist/views/bundle.js",
      componentExport: "CompanionTuiView",
      tags: ["companion", "avatar", "vrm", "terminal"],
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
