import {
  getBrowserWorkspaceMode,
  listBrowserWorkspaceTabs,
} from "@elizaos/agent";
import {
  getStewardPendingApprovals,
  getStewardWalletStatus,
} from "@elizaos/app-steward";
import type { Provider } from "@elizaos/core";

async function formatWorkspaceSummary(): Promise<{
  text: string;
  tabs: Awaited<ReturnType<typeof listBrowserWorkspaceTabs>>;
  mode: ReturnType<typeof getBrowserWorkspaceMode>;
  pendingCount: number;
  steward: Awaited<ReturnType<typeof getStewardWalletStatus>>;
}> {
  const mode = getBrowserWorkspaceMode();
  const tabs = await listBrowserWorkspaceTabs();
  const steward = await getStewardWalletStatus();
  const pendingApprovals = steward.connected
    ? await getStewardPendingApprovals().catch(() => [])
    : [];

  const stewardState = !steward.configured
    ? "not_configured"
    : !steward.connected
      ? "unavailable"
      : "connected";
  const text = JSON.stringify({
    app_browser_workspace: {
      mode,
      tabCount: tabs.length,
      tabs: tabs.slice(0, 8).map((tab) => ({
        id: tab.id,
        visible: tab.visible,
        url: tab.url,
        title: tab.title,
      })),
      steward: {
        state: stewardState,
        pendingApprovals: pendingApprovals.length,
        error: steward.error ?? "",
      },
    },
  }, null, 2);

  return {
    text,
    tabs,
    mode,
    pendingCount: pendingApprovals.length,
    steward,
  };
}

export const appBrowserWorkspaceProvider: Provider = {
  name: "app_browser_workspace",
  description:
    "Summarizes Eliza browser workspace tabs plus Steward wallet signing state for the agent.",
  descriptionCompressed:
    "Browser workspace tabs + Steward wallet signing state.",
  contexts: ["browser", "web"],
  contextGate: { anyOf: ["browser", "web"] },
  cacheStable: false,
  cacheScope: "turn",
  get: async () => {
    try {
      const summary = await formatWorkspaceSummary();
      return {
        text: summary.text,
        data: {
          available: true,
          mode: summary.mode,
          tabs: summary.tabs,
          steward: summary.steward,
          pendingApprovals: summary.pendingCount,
        },
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        text: JSON.stringify({
          app_browser_workspace: {
            available: false,
            error: message,
          },
        }, null, 2),
        data: { available: false, error: message },
      };
    }
  },
};
