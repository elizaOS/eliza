import type {
  Action,
  ActionResult,
  HandlerCallback,
  HandlerOptions,
  IAgentRuntime,
  JsonValue,
  Memory,
  State,
} from "@elizaos/core";

import type { MysticismService } from "../services/mysticism-service";

export const checkPaymentAction: Action = {
  name: "CHECK_PAYMENT",
  similes: ["VERIFY_PAYMENT", "PAYMENT_STATUS"],
  description: "Check if payment has been received for the current reading session.",

  validate: async (runtime: any, message: any, state?: any, options?: any): Promise<boolean> => {
    const __avTextRaw = typeof message?.content?.text === "string" ? message.content.text : "";
    const __avText = __avTextRaw.toLowerCase();
    const __avKeywords = ["check", "payment"];
    const __avKeywordOk =
      __avKeywords.length > 0 && __avKeywords.some((kw) => kw.length > 0 && __avText.includes(kw));
    const __avRegex = /\b(?:check|payment)\b/i;
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
      message: Memory,
      _state: State | undefined
    ): Promise<boolean> => {
      const service = runtime.getService<MysticismService>("MYSTICISM");
      if (!service) return false;
      const session = service.getSession(message.entityId, message.roomId);
      return session !== null && session.paymentStatus !== "none";
    };
    try {
      return Boolean(await (__avLegacyValidate as any)(runtime, message, state, options));
    } catch {
      return false;
    }
  },

  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    _state?: State,
    _options?: HandlerOptions | Record<string, JsonValue | undefined>,
    _callback?: HandlerCallback
  ): Promise<ActionResult | undefined> => {
    const service = runtime.getService<MysticismService>("MYSTICISM");
    if (!service) {
      return { success: false, text: "Mysticism service not available." };
    }

    const session = service.getSession(message.entityId, message.roomId);
    if (!session) {
      return { success: false, text: "No active session." };
    }

    return {
      success: true,
      text: `Payment status: ${session.paymentStatus}`,
      data: {
        paymentStatus: session.paymentStatus,
        amount: session.paymentAmount,
        txHash: session.paymentTxHash,
        readingType: session.type,
      },
    };
  },

  examples: [
    [
      {
        name: "{{agentName}}",
        content: {
          text: "Let me check if your payment has come through...",
          actions: ["CHECK_PAYMENT"],
        },
      },
    ],
  ],
};
