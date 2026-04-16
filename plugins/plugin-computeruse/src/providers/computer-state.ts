/**
 * ComputerStateProvider — injects current computer state into the LLM context.
 *
 * Provides platform info, screen dimensions, available capabilities,
 * and a summary of recent actions so the agent has continuity.
 */

import type {
  IAgentRuntime,
  Memory,
  Provider,
  State,
} from "@elizaos/core";
import { currentPlatform } from "../platform/helpers.js";
import type { ComputerUseService } from "../services/computer-use-service.js";

export const computerStateProvider: Provider = {
  name: "computerState",
  description:
    "Current computer state: platform, screen size, available tools, recent computer-use actions, and approval queue",

  get: async (
    runtime: IAgentRuntime,
    _message: Memory,
    _state: State,
  ) => {
    const service = runtime.getService("computeruse") as unknown as ComputerUseService | undefined;
    if (!service) {
      return { text: "" };
    }

    const caps = service.getCapabilities();
    const screen = service.getScreenDimensions();
    const recent = service.getRecentActions();
    const approvals = service.getApprovalSnapshot();

    const lines: string[] = [
      "# Computer Use",
      `Platform: ${currentPlatform()}`,
      `Screen: ${screen.width}x${screen.height}`,
      `Approval Mode: ${approvals.mode}`,
      `Pending Approvals: ${approvals.pendingCount}`,
      `Screenshot: ${caps.screenshot.available ? caps.screenshot.tool : "unavailable"}`,
      `Mouse/Keyboard: ${caps.computerUse.available ? caps.computerUse.tool : "unavailable"}`,
      `Browser: ${caps.browser.available ? caps.browser.tool : "unavailable"}`,
      `Window List: ${caps.windowList.available ? caps.windowList.tool : "unavailable"}`,
      `Terminal: ${caps.terminal.available ? caps.terminal.tool : "unavailable"}`,
      `Filesystem: ${caps.fileSystem.available ? caps.fileSystem.tool : "unavailable"}`,
    ];

    if (approvals.pendingApprovals.length > 0) {
      lines.push("");
      lines.push("Approval queue:");
      for (const approval of approvals.pendingApprovals.slice(0, 5)) {
        lines.push(`  - ${approval.command}`);
      }
    }

    if (recent.length > 0) {
      lines.push("");
      lines.push("Recent actions:");
      for (const entry of recent.slice(-5)) {
        const status = entry.success ? "ok" : "FAILED";
        lines.push(`  - ${entry.action} [${status}]`);
      }
    }

    return {
      text: lines.join("\n"),
      values: {
        platform: currentPlatform(),
        screenWidth: screen.width,
        screenHeight: screen.height,
      },
      data: {
        approvals,
        capabilities: caps,
        screenSize: screen,
        recentActions: recent,
      },
    };
  },
};
