import { hasAdminAccess } from "@elizaos/agent/security";
import type {
  IAgentRuntime,
  Memory,
  Provider,
  ProviderResult,
  State,
} from "@elizaos/core";
import type { LifeOpsBrowserSession } from "@elizaos/shared/contracts/lifeops";
import { LifeOpsService } from "./lifeops/service.js";

function formatSettingsLine(
  settings: Awaited<ReturnType<LifeOpsService["getBrowserSettings"]>>,
): string {
  const status = settings.enabled ? settings.trackingMode : "off";
  const control = settings.allowBrowserControl ? "control on" : "control off";
  const paused = settings.pauseUntil
    ? `, paused until ${settings.pauseUntil}`
    : "";
  return `Agent Browser Bridge: ${status}, ${control}${paused}.`;
}

function formatCompanionLine(
  companion: Awaited<
    ReturnType<LifeOpsService["listBrowserCompanions"]>
  >[number],
): string {
  return `- ${companion.browser}/${companion.profileLabel || companion.profileId}: ${companion.connectionState}${companion.lastSeenAt ? `, seen ${companion.lastSeenAt}` : ""}`;
}

function formatTabLine(
  tab: Awaited<ReturnType<LifeOpsService["listBrowserTabs"]>>[number],
): string {
  const flags = [
    tab.focusedActive ? "focused" : null,
    tab.activeInWindow ? "active" : null,
  ].filter(Boolean);
  return `- ${tab.title} (${tab.browser}/${tab.profileId}${flags.length > 0 ? `, ${flags.join(", ")}` : ""}) ${tab.url}`;
}

export const lifeOpsBrowserProvider: Provider = {
  name: "lifeops_browser",
  description:
    "Owner/admin-only context for the user's real Chrome and Safari browsers connected through Agent Browser Bridge. Separate from Milady Desktop Browser.",
  descriptionCompressed: "Owner: real Chrome/Safari browser context.",
  dynamic: true,
  position: 13,
  async get(
    runtime: IAgentRuntime,
    message: Memory,
    _state: State,
  ): Promise<ProviderResult> {
    if (!(await hasAdminAccess(runtime, message))) {
      return { text: "", values: {}, data: {} };
    }

    const service = new LifeOpsService(runtime);
    const [settings, companions, tabs, currentPage, sessions] =
      await Promise.all([
        service.getBrowserSettings(),
        service.listBrowserCompanions(),
        service.listBrowserTabs(),
        service.getCurrentBrowserPage(),
        service.listBrowserSessions(),
      ]);
    const activeSessions = sessions.filter(
      (session: LifeOpsBrowserSession) =>
        session.status === "awaiting_confirmation" ||
        session.status === "queued" ||
        session.status === "running",
    );
    const lines = [
      "## Agent Browser Bridge",
      "This is the user's real browser profile connected through Agent Browser Bridge, not Milady Desktop Browser.",
      formatSettingsLine(settings),
      `Companions: ${companions.length}. Active sessions: ${activeSessions.length}.`,
    ];
    if (currentPage) {
      lines.push(`Current page: ${currentPage.title} ${currentPage.url}`);
    }
    if (companions.length > 0) {
      lines.push("Companion status:");
      lines.push(...companions.slice(0, 4).map(formatCompanionLine));
    }
    if (tabs.length > 0) {
      lines.push("Remembered tabs:");
      lines.push(...tabs.slice(0, 6).map(formatTabLine));
    }

    return {
      text: lines.join("\n"),
      values: {
        lifeOpsBrowserEnabled: settings.enabled,
        lifeOpsBrowserTrackingMode: settings.trackingMode,
        lifeOpsBrowserControlEnabled: settings.allowBrowserControl,
        lifeOpsBrowserCurrentUrl: currentPage?.url ?? "",
      },
      data: {
        settings,
        companions,
        tabs,
        currentPage,
        sessions: activeSessions,
      },
    };
  },
};

export const browserBridgeProvider = lifeOpsBrowserProvider;
