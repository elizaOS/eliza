/** Mystical reading systems for ElizaOS agents (tarot, I Ching, astrology). */

import type { IAgentRuntime, Memory, Plugin } from "@elizaos/core";
import {
  logger,
  promoteSubactionsToActions,
  validateActionKeywords,
  validateActionRegex,
} from "@elizaos/core";
import { paymentOpAction } from "./actions/payment-op";
import { readingOpAction } from "./actions/reading-op";
import { createReadingRoutes } from "./routes/readings";
import { MysticismService } from "./services/mysticism-service";

export { paymentOpAction } from "./actions/payment-op";
export { readingOpAction } from "./actions/reading-op";
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

  services: [MysticismService],

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
    ...promoteSubactionsToActions(readingOpAction),
    ...promoteSubactionsToActions(paymentOpAction),
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
        const __recentMessages = (state?.recentMessagesData || []) as Memory[];
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
        const __recentMessages = (state?.recentMessagesData || []) as Memory[];
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
        const __recentMessages = (state?.recentMessagesData || []) as Memory[];
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
