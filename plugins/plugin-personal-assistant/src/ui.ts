/**
 * Renderer-safe browser entry for Personal Assistant settings and lifecycle
 * hooks. The app shell consumes this facade without following the server-side
 * plugin entrypoint into connector and native dependencies.
 */
import "./api/client-lifeops.js";
import { useAppSelector } from "@elizaos/ui/state";
import React, { useEffect } from "react";
import { AppBlockerSettingsCard as AppBlockerSettingsCardImpl } from "./components/AppBlockerSettingsCard.js";
import { WebsiteBlockerSettingsCard as WebsiteBlockerSettingsCardImpl } from "./components/WebsiteBlockerSettingsCard.js";
import { useLifeOpsActivitySignals } from "./hooks/useLifeOpsActivitySignals.js";

import { dispatchQueuedLifeOpsGithubCallbackFromUrl } from "./platform/lifeops-github.js";
import type {
  AppBlockerSettingsCardProps,
  AppBlockerSettingsMode,
} from "./types/app-blocker-settings-card.js";
import type {
  WebsiteBlockerSettingsCardProps,
  WebsiteBlockerSettingsMode,
} from "./types/website-blocker-settings-card.js";

const selectPlugins = (state: {
  plugins: Array<{ id: string; isActive?: boolean; npmName?: string }>;
}) => state.plugins;
const selectPluginsLoaded = (state: { pluginsLoaded: boolean }) =>
  state.pluginsLoaded;
const selectEnsurePluginsLoaded = (state: {
  ensurePluginsLoaded: () => Promise<void>;
}) => state.ensurePluginsLoaded;

export function LifeOpsActivitySignalsEffect() {
  const plugins = useAppSelector(selectPlugins);
  const pluginsLoaded = useAppSelector(selectPluginsLoaded);
  const ensurePluginsLoaded = useAppSelector(selectEnsurePluginsLoaded);

  useEffect(() => {
    if (!pluginsLoaded) {
      void ensurePluginsLoaded();
    }
  }, [ensurePluginsLoaded, pluginsLoaded]);

  const personalAssistantActive =
    pluginsLoaded &&
    plugins.some(
      (plugin) =>
        (plugin.id === "personal-assistant" ||
          plugin.npmName === "@elizaos/plugin-personal-assistant") &&
        plugin.isActive === true,
    );
  useLifeOpsActivitySignals(personalAssistantActive);
  return null;
}

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
