import {
  type Action,
  type ActionResult,
  type HandlerCallback,
  type HandlerOptions,
  type IAgentRuntime,
  logger,
  type Memory,
  type State,
} from "@elizaos/core";
import type { LinearService } from "../services/linear";

export const clearActivityAction: Action = {
  name: "CLEAR_LINEAR_ACTIVITY",
  description: "Clear the Linear activity log",
  similes: ["clear-linear-activity", "reset-linear-activity", "delete-linear-activity"],

  examples: [
    [
      {
        name: "User",
        content: {
          text: "Clear the Linear activity log",
        },
      },
      {
        name: "Assistant",
        content: {
          text: "I'll clear the Linear activity log for you.",
          actions: ["CLEAR_LINEAR_ACTIVITY"],
        },
      },
    ],
    [
      {
        name: "User",
        content: {
          text: "Reset Linear activity",
        },
      },
      {
        name: "Assistant",
        content: {
          text: "I'll reset the Linear activity log now.",
          actions: ["CLEAR_LINEAR_ACTIVITY"],
        },
      },
    ],
  ],

  validate: async (runtime: any, message: any, state?: any, options?: any): Promise<boolean> => {
    const __avTextRaw = typeof message?.content?.text === "string" ? message.content.text : "";
    const __avText = __avTextRaw.toLowerCase();
    const __avKeywords = ["clear", "linear", "activity"];
    const __avKeywordOk =
      __avKeywords.length > 0 &&
      __avKeywords.some((word) => word.length > 0 && __avText.includes(word));
    const __avRegex = /\b(?:clear|linear|activity)\b/i;
    const __avRegexOk = __avRegex.test(__avText);
    const __avSource = String(message?.content?.source ?? message?.source ?? "");
    const __avExpectedSource = "";
    const __avSourceOk = __avExpectedSource
      ? __avSource === __avExpectedSource
      : Boolean(
          __avSource || state || runtime?.agentId || runtime?.getService || runtime?.getSetting
        );
    const __avOptions = options && typeof options === "object" ? options : {};
    const __avInputOk =
      __avText.trim().length > 0 ||
      Object.keys(__avOptions as Record<string, unknown>).length > 0 ||
      Boolean(message?.content && typeof message.content === "object");

    if (!(__avKeywordOk && __avRegexOk && __avSourceOk && __avInputOk)) {
      return false;
    }

    const __avLegacyValidate = async (
      runtime: any,
      message: any,
      state?: any,
      options?: any
    ): Promise<boolean> => {
      const __avTextRaw = typeof message?.content?.text === "string" ? message.content.text : "";
      const __avText = __avTextRaw.toLowerCase();
      const __avKeywords = ["clear", "linear", "activity"];
      const __avKeywordOk =
        __avKeywords.length > 0 &&
        __avKeywords.some((word) => word.length > 0 && __avText.includes(word));
      const __avRegex = /\b(?:clear|linear|activity)\b/i;
      const __avRegexOk = __avRegex.test(__avText);
      const __avSource = String(message?.content?.source ?? message?.source ?? "");
      const __avExpectedSource = "";
      const __avSourceOk = __avExpectedSource
        ? __avSource === __avExpectedSource
        : Boolean(
            __avSource || state || runtime?.agentId || runtime?.getService || runtime?.getSetting
          );
      const __avOptions = options && typeof options === "object" ? options : {};
      const __avInputOk =
        __avText.trim().length > 0 ||
        Object.keys(__avOptions as Record<string, unknown>).length > 0 ||
        Boolean(message?.content && typeof message.content === "object");

      if (!(__avKeywordOk && __avRegexOk && __avSourceOk && __avInputOk)) {
        return false;
      }

      const __avLegacyValidate = async (
        runtime: any,
        message: any,
        state?: any,
        options?: any
      ): Promise<boolean> => {
        const __avTextRaw = typeof message?.content?.text === "string" ? message.content.text : "";
        const __avText = __avTextRaw.toLowerCase();
        const __avKeywords = ["clear", "linear", "activity"];
        const __avKeywordOk =
          __avKeywords.length > 0 &&
          __avKeywords.some((kw) => kw.length > 0 && __avText.includes(kw));
        const __avRegex = /\b(?:clear|linear|activity)\b/i;
        const __avRegexOk = __avRegex.test(__avText);
        const __avSource = String(message?.content?.source ?? message?.source ?? "");
        const __avExpectedSource = "";
        const __avSourceOk = __avExpectedSource
          ? __avSource === __avExpectedSource
          : Boolean(__avSource || state || runtime?.agentId || runtime?.getService);
        const __avOptions = options && typeof options === "object" ? options : {};
        const __avInputOk =
          __avText.trim().length > 0 ||
          Object.keys(__avOptions as Record<string, unknown>).length > 0 ||
          Boolean(message?.content && typeof message.content === "object");

        if (!(__avKeywordOk && __avRegexOk && __avSourceOk && __avInputOk)) {
          return false;
        }

        const __avLegacyValidate = async (
          runtime: IAgentRuntime,
          _message: Memory,
          _state?: State
        ) => {
          const apiKey = runtime.getSetting("LINEAR_API_KEY");
          return !!apiKey;
        };
        try {
          return Boolean(await (__avLegacyValidate as any)(runtime, message, state, options));
        } catch {
          return false;
        }
      };
      try {
        return Boolean(await (__avLegacyValidate as any)(runtime, message, state, options));
      } catch {
        return false;
      }
    };
    try {
      return Boolean(await (__avLegacyValidate as any)(runtime, message, state, options));
    } catch {
      return false;
    }
  },

  async handler(
    runtime: IAgentRuntime,
    message: Memory,
    _state?: State,
    _options?: HandlerOptions,
    callback?: HandlerCallback
  ): Promise<ActionResult> {
    try {
      const linearService = runtime.getService<LinearService>("linear");
      if (!linearService) {
        throw new Error("Linear service not available");
      }

      await linearService.clearActivityLog();

      const successMessage = "✅ Linear activity log has been cleared.";
      await callback?.({
        text: successMessage,
        source: message.content.source,
      });

      return {
        text: successMessage,
        success: true,
      };
    } catch (error) {
      logger.error("Failed to clear Linear activity:", error);
      const errorMessage = `❌ Failed to clear Linear activity: ${error instanceof Error ? error.message : "Unknown error"}`;
      await callback?.({
        text: errorMessage,
        source: message.content.source,
      });
      return {
        text: errorMessage,
        success: false,
      };
    }
  },
};
