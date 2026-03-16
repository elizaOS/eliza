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

export const browserClickAction: Action = {
  name: "BROWSER_CLICK",
  similes: ["CLICK_ELEMENT", "TAP", "PRESS_BUTTON"],
  description: "Click on an element on the webpage",

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
    return text.includes("click") || text.includes("tap") || text.includes("press");
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
        "click on element"
      );
      return {
        text: "Browser service is not available",
        success: false,
        data: {
          actionName: "BROWSER_CLICK",
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
        "click on element"
      );
      return {
        text: "No active browser session",
        success: false,
        data: {
          actionName: "BROWSER_CLICK",
          error: "no_session",
        },
        values: {
          success: false,
          errorType: "no_session",
        },
      };
    }

    const text = message.content?.text ?? "";
    const match = text.match(/click (?:on |the )?(.+)$/i);
    const description = match ? match[1] : "element";

    const result = await service.getClient().click(session.id, description);
    if (!result.success) {
      throw new ActionError("click", description, new Error(result.error ?? "Click failed"));
    }

    const responseContent: Content = {
      text: `I've successfully clicked on "${description}"`,
      actions: ["BROWSER_CLICK"],
      source: message.content?.source ?? "action",
    };

    await callback?.(responseContent);

    return {
      text: responseContent.text ?? "",
      success: true,
      data: {
        actionName: "BROWSER_CLICK",
        element: description,
        sessionId: session.id,
      },
      values: {
        success: true,
        element: description,
      },
    };
  },

  examples: [
    [
      {
        name: "{{user}}",
        content: { text: "Click on the search button" },
      },
      {
        name: "{{agent}}",
        content: {
          text: "I've clicked on the search button.",
          actions: ["BROWSER_CLICK"],
        },
      },
    ],
  ],
};
