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

  descriptionCompressed:
    "Platform, screen size, tools, recent actions, approval queue.",
  get: async (runtime: IAgentRuntime, _message: Memory, _state: State) => {
    const service = runtime.getService("computeruse") as unknown as
      | ComputerUseService
      | undefined;
    if (!service) {
      return { text: "" };
    }

    const caps = service.getCapabilities();
    const screen = service.getScreenDimensions();
    const recent = service.getRecentActions();
    const approvals = service.getApprovalSnapshot();

    const text = `\`\`\`json\n${JSON.stringify({
      computer_use: {
        platform: currentPlatform(),
        screen: { width: screen.width, height: screen.height },
        approvals: {
          mode: approvals.mode,
          pendingCount: approvals.pendingCount,
          pending: approvals.pendingApprovals.slice(0, 5).map((approval) => ({
            id: approval.id,
            command: approval.command,
          })),
        },
        capabilities: {
          screenshot: caps.screenshot.available
            ? caps.screenshot.tool
            : "unavailable",
          mouseKeyboard: caps.computerUse.available
            ? caps.computerUse.tool
            : "unavailable",
          browser: caps.browser.available ? caps.browser.tool : "unavailable",
          windowList: caps.windowList.available
            ? caps.windowList.tool
            : "unavailable",
          terminal: caps.terminal.available
            ? caps.terminal.tool
            : "unavailable",
          fileSystem: caps.fileSystem.available
            ? caps.fileSystem.tool
            : "unavailable",
        },
        recentActions: recent.slice(-5).map((entry) => ({
          action: entry.action,
          success: entry.success,
        })),
      },
    }, null, 2)}\n\`\`\``;

    return {
      text,
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
