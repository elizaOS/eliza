import "./api/client-lifeops.js";

import { type OverlayApp, registerOverlayApp } from "@elizaos/ui";
import { LifeOpsPageView } from "./components/LifeOpsPageView.js";

const LIFEOPS_APP_NAME = "@elizaos/plugin-lifeops";

export const lifeOpsOverlayApp: OverlayApp = {
  name: LIFEOPS_APP_NAME,
  displayName: "LifeOps",
  description:
    "Personal assistant workspace for inbox, calendar, reminders, documents, money admin, and owner operations.",
  category: "utility",
  icon: null,
  loader: async () => ({ default: LifeOpsPageView }),
};

export function registerLifeOpsApp(): void {
  registerOverlayApp(lifeOpsOverlayApp);
}

export * from "./components/AppBlockerSettingsCard.js";
export { LifeOpsActivitySignalsEffect } from "./components/LifeOpsActivitySignalsEffect.js";
export * from "./components/LifeOpsAssistantSection.helpers.ts";
export * from "./components/LifeOpsAssistantSection.js";
export * from "./components/LifeOpsPageSections.helpers.js";
export * from "./components/LifeOpsPageSections.js";
export * from "./components/LifeOpsPageView.js";
export * from "./components/LifeOpsSettingsSection.js";
export * from "./components/LifeOpsWorkspaceView.js";
export * from "./components/WebsiteBlockerSettingsCard.js";
export { dispatchQueuedLifeOpsGithubCallbackFromUrl } from "./platform/lifeops-github.js";
export type {
  AppBlockerSettingsCardProps,
  AppBlockerSettingsMode,
  WebsiteBlockerSettingsCardProps,
  WebsiteBlockerSettingsMode,
} from "./types/index.js";
