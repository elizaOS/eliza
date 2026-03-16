import type {
  Action,
  ActionResult,
  Content,
  HandlerCallback,
  HandlerOptions,
  IAgentRuntime,
  Memory,
  State,
} from "@elizaos/core";
import { ServiceType } from "@elizaos/core";
import type { BrowserService } from "../services/browser-service.js";
import {
  ActionError,
  handleBrowserError,
  ServiceNotAvailableError,
  SessionError,
} from "../utils/errors.js";

export const browserScreenshotAction: Action = {
  name: "BROWSER_SCREENSHOT",
  similes: ["TAKE_SCREENSHOT", "CAPTURE_PAGE", "SCREENSHOT"],
  description: "Take a screenshot of the current page",

  validate: async (runtime: IAgentRuntime, message: Memory, _state?: State): Promise<boolean> => {
    const browserEnabled =
      runtime.getSetting("ENABLE_BROWSER") === "true" ||
      runtime.getSetting("BROWSER_ENABLED") === "true";

    if (!browserEnabled) {
      return false;
    }

    const service = runtime.getService<BrowserService>(ServiceType.BROWSER);
    if (!service) {
      return false;
    }

    const text = message.content?.text?.toLowerCase() ?? "";
    return text.includes("screenshot") || text.includes("capture") || text.includes("snap");
  },

  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    _state?: State,
    _options?: HandlerOptions,
    callback?: HandlerCallback,
    _responses?: Memory[]
  ): Promise<ActionResult | undefined> => {
    const service = runtime.getService<BrowserService>(ServiceType.BROWSER);
    if (!service) {
      const error = new ServiceNotAvailableError();
      handleBrowserError(
        error,
        callback as (content: { text: string; error?: boolean }) => Promise<unknown>,
        "take screenshot"
      );
      return {
        text: "Browser service is not available",
        success: false,
        data: {
          actionName: "BROWSER_SCREENSHOT",
          error: "service_not_available",
        },
        values: {
          success: false,
          errorType: "service_not_available",
        },
      };
    }

    const session = await service.getOrCreateSession();
    if (!session) {
      const error = new SessionError("No active browser session");
      handleBrowserError(
        error,
        callback as (content: { text: string; error?: boolean }) => Promise<unknown>,
        "take screenshot"
      );
      return {
        text: "No active browser session",
        success: false,
        data: {
          actionName: "BROWSER_SCREENSHOT",
          error: "no_session",
        },
        values: {
          success: false,
          errorType: "no_session",
        },
      };
    }

    const result = await service.getClient().screenshot(session.id);
    if (!result.success) {
      throw new ActionError("screenshot", "page", new Error(result.error ?? "Screenshot failed"));
    }

    const screenshotData = result.data as
      | {
          screenshot?: string;
          mimeType?: string;
          url?: string;
          title?: string;
        }
      | undefined;

    const url = screenshotData?.url ?? "unknown";
    const title = screenshotData?.title ?? "Untitled";

    const responseContent: Content = {
      text: `I've taken a screenshot of the page "${title}" at ${url}`,
      actions: ["BROWSER_SCREENSHOT"],
      source: message.content?.source ?? "action",
      data: {
        screenshot: screenshotData?.screenshot ?? "",
        mimeType: screenshotData?.mimeType ?? "image/png",
        url,
        title,
      },
    };

    await callback?.(responseContent);

    return {
      text: responseContent.text ?? "",
      success: true,
      data: {
        actionName: "BROWSER_SCREENSHOT",
        url,
        title,
        sessionId: session.id,
        screenshot: screenshotData?.screenshot ?? "",
      },
      values: {
        success: true,
        url,
        title,
      },
    };
  },

  examples: [
    [
      {
        name: "{{user}}",
        content: { text: "Take a screenshot of the page" },
      },
      {
        name: "{{agent}}",
        content: {
          text: "I've taken a screenshot of the page.",
          actions: ["BROWSER_SCREENSHOT"],
        },
      },
    ],
  ],
};
