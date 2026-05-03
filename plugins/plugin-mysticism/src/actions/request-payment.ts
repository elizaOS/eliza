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
import { logger } from "@elizaos/core";

import type { MysticismService } from "../services/mysticism-service";

export const requestPaymentAction: Action = {
  name: "REQUEST_PAYMENT",
  similes: ["CHARGE_USER", "ASK_FOR_PAYMENT", "SET_PRICE"],
  description: "Request payment from the user for a reading service. Specify the amount to charge.",

  validate: async (runtime: any, message: any, state?: any, options?: any): Promise<boolean> => {
    const __avTextRaw = typeof message?.content?.text === "string" ? message.content.text : "";
    const __avText = __avTextRaw.toLowerCase();
    const __avKeywords = ["request", "payment"];
    const __avKeywordOk =
      __avKeywords.length > 0 && __avKeywords.some((kw) => kw.length > 0 && __avText.includes(kw));
    const __avRegex = /\b(?:request|payment)\b/i;
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
      // Only valid if there's an active session that hasn't been paid yet
      return session !== null && session.paymentStatus === "none";
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
      return { success: false, text: "No active reading session." };
    }

    // The LLM decides the amount. Extract it from the message or use a default.
    // The agent will have mentioned a price in its message to the user.
    // We parse the amount from the agent's own message content or from options.
    const text = message.content.text ?? "";
    const amountMatch = text.match(/\$?([\d.]+)/);
    const amount = amountMatch ? amountMatch[1] : "1.00";

    service.markPaymentRequested(message.entityId, message.roomId, amount);

    logger.info(
      { entityId: message.entityId, roomId: message.roomId, amount },
      "Payment requested for reading"
    );

    return {
      success: true,
      text: `Payment of $${amount} requested for ${session.type} reading.`,
      data: {
        sessionId: session.id,
        amount,
        readingType: session.type,
        paymentStatus: "requested",
      },
    };
  },

  examples: [
    [
      {
        name: "{{agentName}}",
        content: {
          text: "For a full Celtic Cross reading, I'd ask $3.00.",
          actions: ["REQUEST_PAYMENT"],
        },
      },
    ],
  ],
};
