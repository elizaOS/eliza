import { hasOwnerAccess } from "@elizaos/agent/security/access";
import type {
  IAgentRuntime,
  Memory,
  Provider,
  ProviderResult,
  State,
} from "@elizaos/core";
import type { LifeOpsBrowserSession } from "@elizaos/shared";
import { LifeOpsService } from "./lifeops/service.js";

const MAX_COMPANIONS = 4;
const MAX_TABS = 6;
const MAX_SESSIONS = 6;

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
    "Owner-only context for the user's real Chrome and Safari browsers connected through Agent Browser Bridge. Separate from Eliza Desktop Browser.",
  descriptionCompressed: "Owner: real Chrome/Safari browser context.",
  dynamic: true,
  position: 13,
  contexts: ["browser", "settings"],
  contextGate: { anyOf: ["browser", "settings"] },
  cacheScope: "turn",
  roleGate: { minRole: "OWNER" },
  async get(
    runtime: IAgentRuntime,
    message: Memory,
    _state: State,
  ): Promise<ProviderResult> {
    if (!(await hasOwnerAccess(runtime, message))) {
      return { text: "", values: {}, data: {} };
    }

    try {
      const service = new LifeOpsService(runtime);
      const [settings, companions, tabs, currentPage, sessions] =
        await Promise.all([
          service.getBrowserSettings(),
          service.listBrowserCompanions(),
          service.listBrowserTabs(),
          service.getCurrentBrowserPage(),
          service.listBrowserSessions(),
        ]);
      const activeSessions = sessions
        .filter(
          (session: LifeOpsBrowserSession) =>
            session.status === "awaiting_confirmation" ||
            session.status === "queued" ||
            session.status === "running",
        )
        .slice(0, MAX_SESSIONS);
      const listedCompanions = companions.slice(0, MAX_COMPANIONS);
      const listedTabs = tabs.slice(0, MAX_TABS);
      const lines = [
        "## Agent Browser Bridge",
        "This is the user's real browser profile connected through Agent Browser Bridge, not Eliza Desktop Browser.",
        formatSettingsLine(settings),
        `Companions: ${companions.length}. Active sessions: ${activeSessions.length}.`,
      ];
      if (currentPage) {
        lines.push(`Current page: ${currentPage.title} ${currentPage.url}`);
      }
      if (companions.length > 0) {
        lines.push("Companion status:");
        lines.push(...listedCompanions.map(formatCompanionLine));
      }
      if (tabs.length > 0) {
        lines.push("Remembered tabs:");
        lines.push(...listedTabs.map(formatTabLine));
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
          companions: listedCompanions,
          tabs: listedTabs,
          currentPage,
          sessions: activeSessions,
        },
      };
    } catch {
      return {
        text: "",
        values: {
          lifeOpsBrowserEnabled: false,
          lifeOpsBrowserTrackingMode: "off",
          lifeOpsBrowserControlEnabled: false,
          lifeOpsBrowserCurrentUrl: "",
        },
        data: {},
      };
    }
  },
};

export const browserBridgeProvider = lifeOpsBrowserProvider;
