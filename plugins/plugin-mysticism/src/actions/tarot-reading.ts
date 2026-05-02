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

const TAROT_KEYWORDS: readonly string[] = [
  "tarot",
  "card reading",
  "draw cards",
  "read my cards",
  "tarot spread",
  "celtic cross",
  "card pull",
  "three card",
  "single card",
  "past present future",
  "pull a card",
  "tarot deck",
  "shuffle the deck",
];

const SPREAD_PATTERNS: ReadonlyArray<{ pattern: RegExp; spreadId: string }> = [
  { pattern: /celtic\s*cross/i, spreadId: "celtic_cross" },
  { pattern: /three\s*card/i, spreadId: "three_card" },
  { pattern: /past\s*present\s*future/i, spreadId: "three_card" },
  { pattern: /single\s*card/i, spreadId: "single_card" },
  { pattern: /one\s*card/i, spreadId: "single_card" },
  { pattern: /horseshoe/i, spreadId: "horseshoe" },
  { pattern: /relationship/i, spreadId: "relationship" },
];

function detectSpread(text: string): string {
  for (const { pattern, spreadId } of SPREAD_PATTERNS) {
    if (pattern.test(text)) {
      return spreadId;
    }
  }
  return "three_card";
}

function extractQuestion(text: string): string {
  const stripPatterns = [
    /(?:can you |could you |please |would you )?(?:do |give me |pull |draw |read )(?:a |an |my |me )?(?:tarot |card )?(?:reading|spread|cards?|pull)?\s*(?:about|regarding|for|on)?\s*/i,
    /(?:i(?:'d| would) (?:like|love) (?:a |an )?)?(?:tarot |card )?(?:reading|spread|pull)\s*(?:about|regarding|for|on)?\s*/i,
  ];

  let cleaned = text;
  for (const pattern of stripPatterns) {
    cleaned = cleaned.replace(pattern, "").trim();
  }

  if (cleaned.length < 5) {
    return "general guidance and insight";
  }

  return cleaned;
}

export const tarotReadingAction: Action = {
  name: "TAROT_READING",
  similes: ["READ_TAROT", "DRAW_CARDS", "TAROT_SPREAD", "CARD_READING"],
  description:
    "Perform a tarot card reading, drawing cards into a spread and revealing each one iteratively.",

  validate: async (runtime: any, message: any, state?: any, options?: any): Promise<boolean> => {
    const __avTextRaw = typeof message?.content?.text === "string" ? message.content.text : "";
    const __avText = __avTextRaw.toLowerCase();
    const __avKeywords = ["tarot", "reading"];
    const __avKeywordOk =
      __avKeywords.length > 0 && __avKeywords.some((kw) => kw.length > 0 && __avText.includes(kw));
    const __avRegex = /\b(?:tarot|reading)\b/i;
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
      const text = (message.content.text ?? "").toLowerCase();

      const hasTarotIntent = TAROT_KEYWORDS.some((kw) => text.includes(kw));
      if (!hasTarotIntent) return false;

      const service = runtime.getService<MysticismService>("MYSTICISM");
      if (!service) {
        logger.warn("TAROT_READING validation failed: MysticismService not found");
        return false;
      }

      // Don't start a new reading if one is already active
      const entityId = message.entityId;
      const existingSession = service.getSession(entityId, message.roomId);
      if (existingSession) {
        logger.debug(
          { entityId, roomId: message.roomId, type: existingSession.type },
          "TAROT_READING skipped: active session exists"
        );
        return false;
      }

      return true;
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
      logger.error("TAROT_READING handler: MysticismService not available");
      return { success: false, text: "The mysticism service is not available." };
    }

    const entityId = message.entityId;
    const text = message.content.text ?? "";

    const crisis = service.detectCrisis(text);
    if (crisis.detected && crisis.severity === "high") {
      if (callback) {
        await callback({
          text:
            "I can sense you're going through something very difficult right now. " +
            "Before we continue with any reading, I want you to know that there are " +
            "people who care and can help.\n\n" +
            crisis.recommendedAction,
        });
      }
      return {
        success: true,
        text: "Crisis detected — provided support resources instead of reading.",
      };
    }

    const spreadId = detectSpread(text);
    const question = extractQuestion(text);

    try {
      const session = service.startTarotReading(entityId, message.roomId, spreadId, question);

      logger.info(
        { entityId, roomId: message.roomId, spread: spreadId, question },
        "Tarot reading initiated"
      );

      return {
        success: true,
        text: `Started ${spreadId} tarot reading for: ${question}`,
        data: {
          sessionId: session.id,
          spreadName: session.tarot?.spread.name,
          cardCount: session.tarot?.drawnCards.length,
          question,
        },
      };
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : "Unknown error starting tarot reading";
      logger.error({ error: errorMsg }, "TAROT_READING handler failed");
      return { success: false, text: errorMsg };
    }
  },

  examples: [
    [
      {
        name: "{{user1}}",
        content: { text: "Can you read my tarot cards?" },
      },
      {
        name: "{{agentName}}",
        content: {
          text: "I'd love to do a reading for you. Let me shuffle the deck... What question or area of life would you like to explore?",
          actions: ["TAROT_READING"],
        },
      },
    ],
    [
      {
        name: "{{user1}}",
        content: { text: "I'd like a celtic cross spread about my career" },
      },
      {
        name: "{{agentName}}",
        content: {
          text: "A Celtic Cross — perfect for a deep dive into your career path. Let me lay out the cards for you...",
          actions: ["TAROT_READING"],
        },
      },
    ],
    [
      {
        name: "{{user1}}",
        content: { text: "Pull a single card for my day" },
      },
      {
        name: "{{agentName}}",
        content: {
          text: "Drawing one card to set the tone for your day... Let's see what the universe has in store.",
          actions: ["TAROT_READING"],
        },
      },
    ],
  ],
};
