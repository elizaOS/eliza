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

export const browserExtractAction: Action = {
  name: "BROWSER_EXTRACT",
  similes: ["EXTRACT_DATA", "GET_TEXT", "SCRAPE"],
  description: "Extract data from the webpage",

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
    return (
      text.includes("extract") ||
      text.includes("get") ||
      text.includes("scrape") ||
      text.includes("find") ||
      text.includes("read")
    );
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
        "extract data"
      );
      return {
        text: "Browser service is not available",
        success: false,
        data: {
          actionName: "BROWSER_EXTRACT",
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
        "extract data"
      );
      return {
        text: "No active browser session",
        success: false,
        data: {
          actionName: "BROWSER_EXTRACT",
          error: "no_session",
        },
        values: {
          success: false,
          errorType: "no_session",
        },
      };
    }

    const text = message.content?.text ?? "";
    const match = text.match(/(?:extract|get|find|scrape|read) (?:the )?(.+?)(?:\s+from|\s*$)/i);
    const instruction = match ? match[1] : text;

    const result = await service.getClient().extract(session.id, instruction);
    if (!result.success) {
      throw new ActionError("extract", "page", new Error(result.error ?? "Extraction failed"));
    }

    const extractedData = result.data as { data?: string; found?: boolean } | undefined;
    const foundText = extractedData?.data ?? "No data found";
    const found = extractedData?.found ?? false;

    const responseContent: Content = {
      text: found
        ? `I found the ${instruction}: "${foundText}"`
        : `I couldn't find the requested ${instruction} on the page.`,
      actions: ["BROWSER_EXTRACT"],
      source: message.content?.source ?? "action",
    };

    await callback?.(responseContent);

    return {
      text: responseContent.text ?? "",
      success: true,
      data: {
        actionName: "BROWSER_EXTRACT",
        instruction,
        found,
        extractedData: foundText,
        sessionId: session.id,
      },
      values: {
        success: true,
        found,
        data: foundText,
      },
    };
  },

  examples: [
    [
      {
        name: "{{user}}",
        content: { text: "Extract the main heading from the page" },
      },
      {
        name: "{{agent}}",
        content: {
          text: 'I extracted the main heading: "Welcome to Our Website"',
          actions: ["BROWSER_EXTRACT"],
        },
      },
    ],
  ],
};
