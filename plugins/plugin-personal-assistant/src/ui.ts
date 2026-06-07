// Renderer-safe browser entry for @elizaos/plugin-personal-assistant.
//
// The legacy /lifeops dashboard was decomposed into domain views, but the app
// shell still imports this module for browser-only settings cards and old boot
// hooks. Keep this facade thin so Vite never follows the server-side plugin
// entrypoint into connector/native dependencies.
import "./api/client-lifeops.js";
import * as React from "react";
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

function EmptyComponent() {
  return null;
}

export function LifeOpsPageView() {
  return React.createElement(
    "main",
    { className: "flex min-h-full flex-col gap-4 p-6" },
    React.createElement(
      "section",
      {
        className: "rounded-lg border border-border bg-card p-6",
        "data-testid": "lifeops-dynamic-view-fallback",
      },
      React.createElement(
        "h1",
        { className: "text-2xl font-semibold text-txt" },
        "LifeOps",
      ),
      React.createElement(
        "p",
        { className: "mt-2 text-muted text-sm" },
        "@elizaos/plugin-personal-assistant dynamic view smoke surface is ready.",
      ),
      React.createElement(
        "button",
        {
          className: "mt-4 rounded-md border border-border px-3 py-2 text-sm",
          type: "button",
        },
        "Refresh view",
      ),
      React.createElement(
        "label",
        { className: "mt-4 block text-sm" },
        React.createElement("span", { className: "sr-only" }, "LifeOps input"),
        React.createElement("input", {
          "aria-label": "LifeOps input",
          className:
            "mt-1 w-full rounded-md border border-border bg-bg px-3 py-2 text-sm",
        }),
      ),
    ),
  );
}

export const LifeOpsActivitySignalsEffect = EmptyComponent;

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
