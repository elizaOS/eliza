import type {
  Action,
  HandlerCallback,
  IAgentRuntime,
  Memory,
  State,
} from "@elizaos/core";
import type { ComputerUseService } from "../services/computer-use-service.js";
import { buildScreenshotAttachment } from "./helpers.js";

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
    "Capture the current screen through the computer-use service. This uses the same approval, permission, and history path as USE_COMPUTER action=screenshot.",
  parameters: [],
  validate: async (
    runtime: IAgentRuntime,
    _message: Memory,
    _state?: State,
  ): Promise<boolean> => {
    const service =
      (runtime.getService("computeruse") as unknown as ComputerUseService) ??
      null;
    return !!service && service.getCapabilities().screenshot.available;
  },
  handler: async (
    runtime: IAgentRuntime,
    _message: Memory,
    _state?: State,
    _options?: unknown,
    callback?: HandlerCallback,
  ) => {
    const service =
      (runtime.getService("computeruse") as unknown as ComputerUseService) ??
      null;
    if (!service) {
      return { success: false, error: "ComputerUseService not available" };
    }

    const result = await service.executeDesktopAction({ action: "screenshot" });

    if (callback) {
      await callback({
        text: result.success
          ? "Here is the current screen."
          : `Screenshot failed: ${result.error}`,
        ...(result.screenshot
          ? {
              attachments: [
                buildScreenshotAttachment({
                  idPrefix: "screenshot",
                  screenshot: result.screenshot,
                  title: "Screenshot",
                  description: "Full screen capture",
                }),
              ],
            }
          : {}),
      });
    }

    return result as unknown as any;
  },
};
