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
import type { FeedbackEntry } from "../types";
import { getCurrentElement } from "../utils/reading-helpers";

export const readingFollowupAction: Action = {
  name: "READING_FOLLOWUP",
  similes: ["CONTINUE_READING", "NEXT_CARD", "READING_RESPONSE", "PROCEED_READING"],
  description:
    "Continue an active reading by processing user feedback and revealing the next element.",

  validate: async (runtime: any, message: any, state?: any, options?: any): Promise<boolean> => {
    const __avTextRaw = typeof message?.content?.text === "string" ? message.content.text : "";
    const __avText = __avTextRaw.toLowerCase();
    const __avKeywords = ["reading", "followup"];
    const __avKeywordOk =
      __avKeywords.length > 0 && __avKeywords.some((kw) => kw.length > 0 && __avText.includes(kw));
    const __avRegex = /\b(?:reading|followup)\b/i;
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

      const entityId = message.entityId;
      const session = service.getSession(entityId, message.roomId);
      if (!session) return false;

      return session.phase === "casting" || session.phase === "interpretation";
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
    callback?: HandlerCallback
  ): Promise<ActionResult | undefined> => {
    const service = runtime.getService<MysticismService>("MYSTICISM");
    if (!service) {
      return { success: false, text: "The mysticism service is not available." };
    }

    const entityId = message.entityId;
    const text = message.content.text ?? "";

    const crisis = service.detectCrisis(text);
    if (crisis.detected && crisis.severity === "high") {
      service.endSession(entityId, message.roomId);

      if (callback) {
        await callback({
          text:
            "I want to pause our reading for a moment. What you're expressing " +
            "concerns me, and I care about your wellbeing more than any reading.\n\n" +
            crisis.recommendedAction,
        });
      }

      return {
        success: true,
        text: "Crisis detected during reading — session ended, resources provided.",
      };
    }

    const session = service.getSession(entityId, message.roomId);
    if (!session) {
      return { success: false, text: "No active reading session found." };
    }

    const currentElement = getCurrentElement(session);
    const feedback: FeedbackEntry = {
      element: currentElement,
      userText: text,
      timestamp: Date.now(),
    };

    service.recordFeedback(entityId, message.roomId, feedback);

    const nextReveal = service.getNextReveal(entityId, message.roomId);

    if (nextReveal) {
      if (callback) {
        await callback({
          text: `**${nextReveal.element}**\n\n${nextReveal.prompt}`,
        });
      }

      logger.debug(
        { entityId, roomId: message.roomId, element: nextReveal.element },
        "Reading followup: next reveal"
      );

      return {
        success: true,
        text: `Revealed next element: ${nextReveal.element}`,
      };
    }

    return handleSynthesis(service, entityId, message.roomId, callback);
  },

  examples: [
    [
      {
        name: "{{user1}}",
        content: { text: "That really resonates with me. What's the next card?" },
      },
      {
        name: "{{agentName}}",
        content: {
          text: "I'm glad that speaks to you. Let me turn over the next card in your spread...",
          actions: ["READING_FOLLOWUP"],
        },
      },
    ],
    [
      {
        name: "{{user1}}",
        content: { text: "Interesting, please continue" },
      },
      {
        name: "{{agentName}}",
        content: {
          text: "Moving to the next element of your reading...",
          actions: ["READING_FOLLOWUP"],
        },
      },
    ],
    [
      {
        name: "{{user1}}",
        content: { text: "I don't think that applies to me. What's next?" },
      },
      {
        name: "{{agentName}}",
        content: {
          text: "I appreciate your honesty — sometimes the meaning reveals itself later. Let me show you the next card...",
          actions: ["READING_FOLLOWUP"],
        },
      },
    ],
  ],
};

export const deepenReadingAction: Action = {
  name: "DEEPEN_READING",
  similes: ["EXPLAIN_MORE", "GO_DEEPER", "ELABORATE_READING", "READING_DETAIL"],
  description: "Provide a deeper interpretation of a specific element in an active reading.",

  validate: async (runtime: any, message: any, state?: any, options?: any): Promise<boolean> => {
    const __avTextRaw = typeof message?.content?.text === "string" ? message.content.text : "";
    const __avText = __avTextRaw.toLowerCase();
    const __avKeywords = ["deepen", "reading"];
    const __avKeywordOk =
      __avKeywords.length > 0 && __avKeywords.some((kw) => kw.length > 0 && __avText.includes(kw));
    const __avRegex = /\b(?:deepen|reading)\b/i;
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

      const entityId = message.entityId;
      const session = service.getSession(entityId, message.roomId);
      if (!session) return false;

      return session.phase === "interpretation" || session.phase === "casting";
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
    callback?: HandlerCallback
  ): Promise<ActionResult | undefined> => {
    const service = runtime.getService<MysticismService>("MYSTICISM");
    if (!service) {
      return { success: false, text: "The mysticism service is not available." };
    }

    const entityId = message.entityId;
    const text = message.content.text ?? "";

    const session = service.getSession(entityId, message.roomId);
    if (!session) {
      return { success: false, text: "No active reading session found." };
    }

    if (session.type === "tarot" && session.tarot) {
      // The most recently revealed card is at revealedIndex - 1
      const lastRevealedIndex = session.tarot.revealedIndex - 1;

      if (lastRevealedIndex >= 0) {
        const deepenPrompt = service.getDeepeningPrompt(
          entityId,
          message.roomId,
          lastRevealedIndex,
          text
        );

        if (deepenPrompt && callback) {
          const card = session.tarot.drawnCards[lastRevealedIndex];
          const cardName = card.reversed ? `${card.card.name} (Reversed)` : card.card.name;

          await callback({
            text: `Let me look more deeply at the **${cardName}**...`,
          });

          logger.debug(
            { entityId, cardIndex: lastRevealedIndex, card: card.card.name },
            "Deepening tarot card"
          );

          return {
            success: true,
            text: `Deepened interpretation of ${cardName}`,
          };
        }
      }
    }

    if (callback) {
      const nextReveal = service.getNextReveal(entityId, message.roomId);
      if (nextReveal) {
        await callback({
          text:
            "Let me explore that further and connect it to the next element " +
            `of your reading...\n\n**${nextReveal.element}**\n\n${nextReveal.prompt}`,
        });

        return {
          success: true,
          text: `Deepened via next reveal: ${nextReveal.element}`,
        };
      }

      await callback({
        text:
          "We've explored all the elements of your reading. " +
          "Let me weave everything together into a final synthesis...",
      });

      return handleSynthesis(service, entityId, message.roomId, callback);
    }

    return { success: true, text: "Deepening handled." };
  },

  examples: [
    [
      {
        name: "{{user1}}",
        content: { text: "Tell me more about that card" },
      },
      {
        name: "{{agentName}}",
        content: {
          text: "Let me look more deeply at this card's symbolism and what it means in your specific situation...",
          actions: ["DEEPEN_READING"],
        },
      },
    ],
    [
      {
        name: "{{user1}}",
        content: { text: "Can you explain what that symbolism means?" },
      },
      {
        name: "{{agentName}}",
        content: {
          text: "Of course — let me dive deeper into the imagery and symbolism here...",
          actions: ["DEEPEN_READING"],
        },
      },
    ],
    [
      {
        name: "{{user1}}",
        content: { text: "Go deeper on the moon placement" },
      },
      {
        name: "{{agentName}}",
        content: {
          text: "Your Moon placement is rich with meaning. Let me elaborate on what this reveals about your emotional landscape...",
          actions: ["DEEPEN_READING"],
        },
      },
    ],
  ],
};

async function handleSynthesis(
  service: MysticismService,
  entityId: string,
  roomId: string,
  callback: HandlerCallback | undefined
): Promise<ActionResult> {
  const synthesis = service.getSynthesis(entityId, roomId);

  if (synthesis && callback) {
    await callback({
      text: "Now let me bring all the threads of your reading together...",
    });
  }

  service.endSession(entityId, roomId);

  logger.info({ entityId, roomId }, "Reading synthesis completed");

  return {
    success: true,
    text: "Reading complete — synthesis delivered and session ended.",
  };
}
