// Renderer-safe browser entry for @elizaos/plugin-personal-assistant.
//
// The legacy /lifeops dashboard was decomposed into domain views, but the app
// shell still imports this module for browser-only settings cards. Keep this
// facade thin so Vite never follows the server-side plugin entrypoint into
// connector/native dependencies. Renderer boot behavior (the LifeOps
// activity-signal capture) lives in ./register.ts, not here — this module is a
// pure export facade.
import "./api/client-lifeops.js";
import React from "react";
import { AppBlockerSettingsCard as AppBlockerSettingsCardImpl } from "./components/AppBlockerSettingsCard.js";
import { WebsiteBlockerSettingsCard as WebsiteBlockerSettingsCardImpl } from "./components/WebsiteBlockerSettingsCard.js";

import { dispatchQueuedLifeOpsGithubCallbackFromUrl } from "./platform/lifeops-github.js";
import type {
  AppBlockerSettingsCardProps,
  AppBlockerSettingsMode,
} from "./types/app-blocker-settings-card.js";
import type {
  WebsiteBlockerSettingsCardProps,
  WebsiteBlockerSettingsMode,
} from "./types/website-blocker-settings-card.js";

export function AppBlockerSettingsCard(props: AppBlockerSettingsCardProps) {
  return React.createElement(AppBlockerSettingsCardImpl, props);
}

export function WebsiteBlockerSettingsCard(
  props: WebsiteBlockerSettingsCardProps,
) {
  return React.createElement(WebsiteBlockerSettingsCardImpl, props);
}

export function registerLifeOpsApp(): void {
  // The host shell owns the route; this facade keeps renderer imports browser-safe.
}

export type { AppBlockerSettingsMode, WebsiteBlockerSettingsMode };
export { dispatchQueuedLifeOpsGithubCallbackFromUrl };
