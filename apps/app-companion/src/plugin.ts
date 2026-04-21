/**
 * elizaOS runtime plugin for the companion app (VRM emotes, etc.).
 */

import { gatePluginSessionForHostedApp } from "@elizaos/agent/services/app-session-gate";
import type { Plugin } from "@elizaos/core";
import { emoteAction } from "./actions/emote.js";

const COMPANION_APP_NAME = "@elizaos/app-companion";

const rawCompanionPlugin: Plugin = {
  name: COMPANION_APP_NAME,
  description:
    "Companion overlay: VRM avatar emotes and related runtime hooks. Actions apply only while the companion app session is active.",
  actions: [emoteAction],
};

export const appCompanionPlugin: Plugin = gatePluginSessionForHostedApp(
  rawCompanionPlugin,
  COMPANION_APP_NAME,
);

export default appCompanionPlugin;

export { emoteAction } from "./actions/emote.js";
export * from "./emotes/catalog.js";
