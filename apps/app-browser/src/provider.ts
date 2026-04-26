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

  const lines = [
    `Eliza browser workspace (${mode}): ${tabs.length} tab${tabs.length === 1 ? "" : "s"} open.`,
  ];
  if (tabs.length === 0) {
    lines.push("- No tabs are open.");
  }
  for (const tab of tabs.slice(0, 8)) {
    lines.push(
      `- ${tab.id} [${tab.visible ? "visible" : "background"}] ${tab.url}`,
    );
  }

  if (!steward.configured) {
    lines.push("Eliza wallet: Steward not configured.");
  } else if (!steward.connected) {
    lines.push(
      `Eliza wallet: Steward unavailable${steward.error ? ` (${steward.error})` : "."}`,
    );
  } else {
    lines.push(
      `Eliza wallet: Steward connected${pendingApprovals.length > 0 ? ` with ${pendingApprovals.length} pending approval${pendingApprovals.length === 1 ? "" : "s"}` : " with no pending approvals"}.`,
    );
  }

  return {
    text: lines.join("\n"),
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
        text: `Eliza browser workspace error: ${message}`,
        data: { available: true, error: message },
      };
    }
  },
};
