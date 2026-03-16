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

export const browserSelectAction: Action = {
  name: "BROWSER_SELECT",
  similes: ["SELECT_OPTION", "CHOOSE", "PICK"],
  description: "Select an option from a dropdown on the webpage",

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
    return text.includes("select") || text.includes("choose") || text.includes("pick");
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
        "select option"
      );
      return {
        text: "Browser service is not available",
        success: false,
        data: {
          actionName: "BROWSER_SELECT",
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
        "select option"
      );
      return {
        text: "No active browser session",
        success: false,
        data: {
          actionName: "BROWSER_SELECT",
          error: "no_session",
        },
        values: {
          success: false,
          errorType: "no_session",
        },
      };
    }

    const text = message.content?.text ?? "";
    const match = text.match(/["']([^"']+)["']/);
    const option = match ? match[1] : "";

    const dropdownMatch = text.match(/from (?:the )?(.+)$/i);
    const dropdown = dropdownMatch ? dropdownMatch[1] : "dropdown";

    if (!option) {
      throw new ActionError("select", dropdown, new Error("No option specified to select"));
    }

    const result = await service.getClient().select(session.id, option, dropdown);
    if (!result.success) {
      throw new ActionError("select", dropdown, new Error(result.error ?? "Select failed"));
    }

    const responseContent: Content = {
      text: `I've selected "${option}" from the ${dropdown}`,
      actions: ["BROWSER_SELECT"],
      source: message.content?.source ?? "action",
    };

    await callback?.(responseContent);

    return {
      text: responseContent.text ?? "",
      success: true,
      data: {
        actionName: "BROWSER_SELECT",
        option,
        dropdown,
        sessionId: session.id,
      },
      values: {
        success: true,
        option,
        dropdown,
      },
    };
  },

  examples: [
    [
      {
        name: "{{user}}",
        content: { text: 'Select "United States" from the country dropdown' },
      },
      {
        name: "{{agent}}",
        content: {
          text: 'I\'ve selected "United States" from the country dropdown.',
          actions: ["BROWSER_SELECT"],
        },
      },
    ],
  ],
};
