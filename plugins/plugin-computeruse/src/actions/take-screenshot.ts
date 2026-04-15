/**
 * TAKE_SCREENSHOT action — dedicated screen capture.
 *
 * A simpler entry point than USE_COMPUTER for when the agent just needs
 * to see the current screen state. No parameters needed.
 */

import type {
  Action,
  HandlerCallback,
  IAgentRuntime,
  Memory,
  State,
} from "@elizaos/core";
import type { ComputerUseService } from "../services/computer-use-service.js";

export const takeScreenshotAction: Action = {
  name: "TAKE_SCREENSHOT",

  similes: [
    "CAPTURE_SCREEN",
    "SCREEN_CAPTURE",
    "GET_SCREENSHOT",
    "SEE_SCREEN",
    "LOOK_AT_SCREEN",
    "VIEW_SCREEN",
    "SCREEN_STATE",
  ],

  description:
    "Take a screenshot of the current screen to see what is displayed. " +
    "Use this to observe the desktop state before deciding what actions to take. " +
    "Returns a full-resolution PNG screenshot of the primary display.",

  parameters: [],

  examples: [
    [
      {
        name: "{{user1}}",
        content: { text: "What's on my screen right now?" },
      },
      {
        name: "{{agentName}}",
        content: { text: "Let me take a screenshot to see.", action: "TAKE_SCREENSHOT" },
      },
    ],
    [
      {
        name: "{{user1}}",
        content: { text: "Show me what the desktop looks like." },
      },
      {
        name: "{{agentName}}",
        content: { text: "I'll capture the screen.", action: "TAKE_SCREENSHOT" },
      },
    ],
  ],

  validate: async (runtime: IAgentRuntime, _message: Memory, _state?: State): Promise<boolean> => {
    const service = runtime.getService<ComputerUseService>("computeruse");
    if (!service) return false;
    return service.getCapabilities().screenshot.available;
  },

  handler: async (
    runtime: IAgentRuntime,
    _message: Memory,
    _state?: State,
    _options?: unknown,
    callback?: HandlerCallback,
  ) => {
    const service = runtime.getService<ComputerUseService>("computeruse");
    if (!service) {
      return { success: false, error: "ComputerUseService not available" };
    }

    try {
      const buf = await service.captureScreen();
      const b64 = buf.toString("base64");

      if (callback) {
        await callback({
          text: "Here is the current screen.",
          attachments: [
            {
              id: `screenshot-${Date.now()}`,
              url: `data:image/png;base64,${b64}`,
              title: "Screenshot",
              source: "computeruse",
              description: "Full screen capture",
              contentType: "image/png",
            },
          ],
        });
      }

      return { success: true };
    } catch (err) {
      if (callback) {
        await callback({ text: `Screenshot failed: ${String(err)}` });
      }
      return { success: false, error: String(err) };
    }
  },
};
