/** Mystical reading systems for ElizaOS agents (tarot, I Ching, astrology). */

import type { IAgentRuntime, Plugin, ServiceClass } from "@elizaos/core";
import { logger, validateActionKeywords, validateActionRegex } from "@elizaos/core";
import { createReadingRoutes } from "./routes/readings";

export { astrologyReadingAction } from "./actions/astrology-reading";
export { checkPaymentAction } from "./actions/check-payment";
export { ichingReadingAction } from "./actions/iching-reading";
export { deepenReadingAction, readingFollowupAction } from "./actions/reading-followup";
export { requestPaymentAction } from "./actions/request-payment";
export { tarotReadingAction } from "./actions/tarot-reading";
export type { AstrologyReadingState } from "./engines/astrology/index";
export { AstrologyEngine } from "./engines/astrology/index";
export { IChingEngine } from "./engines/iching/index";
export type { RevealResult } from "./engines/tarot/index";
export { TarotEngine } from "./engines/tarot/index";
export { astrologyIntakeForm } from "./forms/astrology-intake";
export { readingFeedbackForm } from "./forms/feedback";
export { tarotIntakeForm } from "./forms/tarot-intake";
export { economicContextProvider } from "./providers/economic-context";
export { mysticalKnowledgeProvider } from "./providers/mystical-knowledge";
export { readingContextProvider } from "./providers/reading-context";
export { createReadingRoutes } from "./routes/readings";
export { MysticismService } from "./services/mysticism-service";
export * from "./types";

export const mysticismPlugin: Plugin = {
  name: "mysticism",
  description:
    "Mystical reading systems (tarot, I Ching, astrology) with progressive revelation and emotional attunement",

  services: [
    {
      serviceType: "MYSTICISM",
      start: async (runtime: IAgentRuntime) => {
        const { MysticismService } = await import("./services/mysticism-service");
        return MysticismService.start(runtime);
      },
    } as unknown as ServiceClass,
  ],

  init: async (config: Record<string, string>, _runtime: IAgentRuntime) => {
    for (const key of [
      "MYSTICISM_PRICE_TAROT",
      "MYSTICISM_PRICE_ICHING",
      "MYSTICISM_PRICE_ASTROLOGY",
    ]) {
      const val = config[key];
      if (val !== undefined && (Number.isNaN(Number(val)) || Number(val) < 0)) {
        logger.warn(`[mysticism] Invalid pricing config for ${key}: "${val}", using default`);
      }
    }
    logger.info("[mysticism] Plugin initialized");
  },

  actions: [
    {
      name: "TAROT_READING",
      similes: ["READ_TAROT", "DRAW_CARDS", "TAROT_SPREAD", "CARD_READING"],
      description: "Initiate a tarot card reading for the user",
      validate: async (runtime, message, state) =>
        (await import("./actions/tarot-reading")).tarotReadingAction.validate(
          runtime,
          message,
          state
        ),
      handler: async (runtime, message, state, options, callback) =>
        (await import("./actions/tarot-reading")).tarotReadingAction.handler(
          runtime,
          message,
          state,
          options,
          callback
        ),
      examples: [
        [
          { name: "{{user1}}", content: { text: "Can you do a tarot reading for me?" } },
          {
            name: "{{agentName}}",
            content: {
              text: "I'd be happy to do a tarot reading for you. Let me shuffle the cards...",
            },
          },
        ],
      ],
    },
    {
      name: "ICHING_READING",
      similes: ["CAST_HEXAGRAM", "CONSULT_ICHING", "THROW_COINS", "ORACLE_READING"],
      description: "Initiate an I Ching divination reading",
      validate: async (runtime, message, state) =>
        (await import("./actions/iching-reading")).ichingReadingAction.validate(
          runtime,
          message,
          state
        ),
      handler: async (runtime, message, state, options, callback) =>
        (await import("./actions/iching-reading")).ichingReadingAction.handler(
          runtime,
          message,
          state,
          options,
          callback
        ),
      examples: [
        [
          { name: "{{user1}}", content: { text: "I'd like to consult the I Ching" } },
          {
            name: "{{agentName}}",
            content: {
              text: "Let us consult the ancient oracle. I'll cast the coins for your hexagram...",
            },
          },
        ],
      ],
    },
    {
      name: "ASTROLOGY_READING",
      similes: ["BIRTH_CHART", "NATAL_CHART", "HOROSCOPE_READING", "ZODIAC_READING"],
      description: "Initiate a natal chart / astrology reading",
      validate: async (runtime, message, state) =>
        (await import("./actions/astrology-reading")).astrologyReadingAction.validate(
          runtime,
          message,
          state
        ),
      handler: async (runtime, message, state, options, callback) =>
        (await import("./actions/astrology-reading")).astrologyReadingAction.handler(
          runtime,
          message,
          state,
          options,
          callback
        ),
      examples: [
        [
          { name: "{{user1}}", content: { text: "Can you read my birth chart?" } },
          {
            name: "{{agentName}}",
            content: {
              text: "I'd love to explore your natal chart. First, I'll need your birth details...",
            },
          },
        ],
      ],
    },
    {
      name: "READING_FOLLOWUP",
      similes: ["CONTINUE_READING", "NEXT_CARD", "NEXT_LINE", "PROCEED_READING"],
      description: "Continue an active reading by revealing the next element",
      validate: async (runtime, message, state) =>
        (await import("./actions/reading-followup")).readingFollowupAction.validate(
          runtime,
          message,
          state
        ),
      handler: async (runtime, message, state, options, callback) =>
        (await import("./actions/reading-followup")).readingFollowupAction.handler(
          runtime,
          message,
          state,
          options,
          callback
        ),
      examples: [
        [
          { name: "{{user1}}", content: { text: "Yes, that resonates. What's next?" } },
          {
            name: "{{agentName}}",
            content: { text: "Let me reveal the next element of your reading..." },
          },
        ],
      ],
    },
    {
      name: "DEEPEN_READING",
      similes: ["EXPLORE_DEEPER", "TELL_MORE", "ELABORATE_READING", "EXPAND_INTERPRETATION"],
      description: "Provide a deeper interpretation of a specific reading element",
      validate: async (runtime, message, state) =>
        (await import("./actions/reading-followup")).deepenReadingAction.validate(
          runtime,
          message,
          state
        ),
      handler: async (runtime, message, state, options, callback) =>
        (await import("./actions/reading-followup")).deepenReadingAction.handler(
          runtime,
          message,
          state,
          options,
          callback
        ),
      examples: [
        [
          { name: "{{user1}}", content: { text: "Tell me more about that card" } },
          {
            name: "{{agentName}}",
            content: { text: "Let me explore that element more deeply for you..." },
          },
        ],
      ],
    },
    {
      name: "REQUEST_PAYMENT",
      similes: ["CHARGE_USER", "ASK_FOR_PAYMENT", "SET_PRICE"],
      description: "Request payment from the user for a reading service",
      validate: async (runtime, message, state) =>
        (await import("./actions/request-payment")).requestPaymentAction.validate(
          runtime,
          message,
          state
        ),
      handler: async (runtime, message, state, options, callback) =>
        (await import("./actions/request-payment")).requestPaymentAction.handler(
          runtime,
          message,
          state,
          options,
          callback
        ),
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
    },
    {
      name: "CHECK_PAYMENT",
      similes: ["VERIFY_PAYMENT", "PAYMENT_STATUS"],
      description: "Check if payment has been received for the current reading session",
      validate: async (runtime, message, state) =>
        (await import("./actions/check-payment")).checkPaymentAction.validate(
          runtime,
          message,
          state
        ),
      handler: async (runtime, message, state, options, callback) =>
        (await import("./actions/check-payment")).checkPaymentAction.handler(
          runtime,
          message,
          state,
          options,
          callback
        ),
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
    },
  ],

  providers: [
    {
      name: "READING_CONTEXT",
      description: "Provides context about the active mystical reading session",
      dynamic: true,
      relevanceKeywords: [
        "reading",
        "context",
        "inlineprovider1",
        "plugin",
        "mysticism",
        "status",
        "state",
        "info",
        "details",
        "chat",
        "conversation",
        "agent",
        "room",
        "channel",
      ],
      get: async (runtime, message, state) => {
        const __providerKeywords = [
          "reading",
          "context",
          "inlineprovider1",
          "plugin",
          "mysticism",
          "status",
          "state",
          "info",
          "details",
          "chat",
          "conversation",
          "agent",
          "room",
          "channel",
        ];
        const __providerRegex = new RegExp(`\\b(${__providerKeywords.join("|")})\\b`, "i");
        const __recentMessages = state?.recentMessagesData || [];
        const __isRelevant =
          validateActionKeywords(message, __recentMessages, __providerKeywords) ||
          validateActionRegex(message, __recentMessages, __providerRegex);
        if (!__isRelevant) {
          return { text: "" };
        }

        const { readingContextProvider } = await import("./providers/reading-context");
        return readingContextProvider.get(runtime, message, state);
      },
    },
    {
      name: "ECONOMIC_CONTEXT",
      description: "Provides economic facts about payment history and revenue",
      dynamic: true,
      relevanceKeywords: [
        "economic",
        "context",
        "inlineprovider2",
        "plugin",
        "mysticism",
        "status",
        "state",
        "info",
        "details",
        "chat",
        "conversation",
        "agent",
        "room",
        "channel",
      ],
      get: async (runtime, message, state) => {
        const __providerKeywords = [
          "economic",
          "context",
          "inlineprovider2",
          "plugin",
          "mysticism",
          "status",
          "state",
          "info",
          "details",
          "chat",
          "conversation",
          "agent",
          "room",
          "channel",
        ];
        const __providerRegex = new RegExp(`\\b(${__providerKeywords.join("|")})\\b`, "i");
        const __recentMessages = state?.recentMessagesData || [];
        const __isRelevant =
          validateActionKeywords(message, __recentMessages, __providerKeywords) ||
          validateActionRegex(message, __recentMessages, __providerRegex);
        if (!__isRelevant) {
          return { text: "" };
        }

        const { economicContextProvider } = await import("./providers/economic-context");
        return economicContextProvider.get(runtime, message, state);
      },
    },
    {
      name: "MYSTICAL_KNOWLEDGE",
      description: "Provides mystical domain knowledge to ground the agent's interpretations",
      dynamic: true,
      relevanceKeywords: [
        "mystical",
        "knowledge",
        "inlineprovider3",
        "plugin",
        "mysticism",
        "status",
        "state",
        "context",
        "info",
        "details",
        "chat",
        "conversation",
        "agent",
        "room",
      ],
      get: async (runtime, message, state) => {
        const __providerKeywords = [
          "mystical",
          "knowledge",
          "inlineprovider3",
          "plugin",
          "mysticism",
          "status",
          "state",
          "context",
          "info",
          "details",
          "chat",
          "conversation",
          "agent",
          "room",
        ];
        const __providerRegex = new RegExp(`\\b(${__providerKeywords.join("|")})\\b`, "i");
        const __recentMessages = state?.recentMessagesData || [];
        const __isRelevant =
          validateActionKeywords(message, __recentMessages, __providerKeywords) ||
          validateActionRegex(message, __recentMessages, __providerRegex);
        if (!__isRelevant) {
          return { text: "" };
        }

        const { mysticalKnowledgeProvider } = await import("./providers/mystical-knowledge");
        return mysticalKnowledgeProvider.get(runtime, message, state);
      },
    },
  ],

  routes: createReadingRoutes(),
};

export default mysticismPlugin;
