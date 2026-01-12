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

export const browserTypeAction: Action = {
  name: "BROWSER_TYPE",
  similes: ["TYPE_TEXT", "INPUT", "ENTER_TEXT"],
  description: "Type text into an input field on the webpage",

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
    return text.includes("type") || text.includes("input") || text.includes("enter");
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
        "type text"
      );
      return {
        text: "Browser service is not available",
        success: false,
        data: {
          actionName: "BROWSER_TYPE",
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
        "type text"
      );
      return {
        text: "No active browser session",
        success: false,
        data: {
          actionName: "BROWSER_TYPE",
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
    const textToType = match ? match[1] : "";

    const fieldMatch = text.match(/(?:in|into) (?:the )?(.+)$/i);
    const field = fieldMatch ? fieldMatch[1] : "input field";

    if (!textToType) {
      throw new ActionError("type", field, new Error("No text specified to type"));
    }

    const result = await service.getClient().type(session.id, textToType, field);
    if (!result.success) {
      throw new ActionError("type", field, new Error(result.error ?? "Type failed"));
    }

    const responseContent: Content = {
      text: `I've typed "${textToType}" in the ${field}`,
      actions: ["BROWSER_TYPE"],
      source: message.content?.source ?? "action",
    };

    await callback?.(responseContent);

    return {
      text: responseContent.text ?? "",
      success: true,
      data: {
        actionName: "BROWSER_TYPE",
        textTyped: textToType,
        field,
        sessionId: session.id,
      },
      values: {
        success: true,
        textTyped: textToType,
        field,
      },
    };
  },

  examples: [
    [
      {
        name: "{{user}}",
        content: { text: 'Type "hello world" in the search box' },
      },
      {
        name: "{{agent}}",
        content: {
          text: 'I\'ve typed "hello world" in the search box.',
          actions: ["BROWSER_TYPE"],
        },
      },
    ],
  ],
};
