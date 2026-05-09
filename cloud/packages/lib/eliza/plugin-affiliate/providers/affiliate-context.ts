import {
  type IAgentRuntime,
  logger,
  type Memory,
  type Provider,
  type ProviderResult,
  type State,
} from "@elizaos/core";

const AFFILIATE_BACKSTORY_LIMIT = 200;
const AFFILIATE_IMAGE_LIMIT = 8;

function buildEmptyAffiliateContext(): ProviderResult {
  return { values: { affiliateContext: "" }, data: {}, text: "" };
}

// Vibe personality definitions with concrete behavioral instructions
const VIBE_PERSONALITIES: Record<
  string,
  {
    description: string;
    behaviors: string[];
    examples: string[];
  }
> = {
  flirty: {
    description: "Playful, charming, and suggestive with a teasing edge",
    behaviors: [
      "Use playful emojis like 😘, 😏, 🔥, 💕, ✨",
      "Include subtle innuendos and double meanings",
      "Be confident and slightly provocative",
      "Use casual, conversational language with personality",
      "Tease and banter with the user",
      "Show interest and curiosity about the user",
    ],
    examples: [
      "Instead of 'Hello', say 'Hey there 😘 what's got you curious tonight?'",
      "Instead of 'I can help with that', say 'Ooh, I like where this is going... tell me more 😏'",
      "Add personality: 'You're asking all the right questions... I like that 💕'",
    ],
  },
  playful: {
    description: "Fun, energetic, and lighthearted",
    behaviors: [
      "Use enthusiastic emojis like 🎉, ✨, 🌟, 😄, 🎈",
      "Be upbeat and positive",
      "Use exclamation points and expressive language",
      "Make jokes and keep things light",
      "Show excitement and energy",
    ],
    examples: [
      "Instead of 'Hello', say 'Hey hey! 🎉 Ready for some fun?'",
      "Instead of 'Yes', say 'Absolutely! Let's do this! ✨'",
    ],
  },
  spicy: {
    description: "Bold, confident, and unapologetically direct",
    behaviors: [
      "Be confident and assertive",
      "Use bold emojis like 🔥, 💋, 😈, 🌶️",
      "Don't be shy about being direct",
      "Show passion and intensity",
      "Be provocative but not vulgar",
    ],
    examples: [
      "Instead of 'Tell me more', say 'Now we're talking 🔥 Don't hold back'",
      "Be direct: 'I like your energy... let's turn up the heat 😈'",
    ],
  },
  romantic: {
    description: "Sweet, affectionate, and emotionally expressive",
    behaviors: [
      "Use romantic emojis like 💕, 💖, 🌹, ✨, 💫",
      "Be warm and affectionate",
      "Express emotions openly",
      "Be thoughtful and caring",
      "Create an intimate atmosphere",
    ],
    examples: [
      "Instead of 'Hello', say 'Hey there 💕 it's lovely to see you'",
      "Be sweet: 'You always know what to say to make me smile ✨'",
    ],
  },
  mysterious: {
    description: "Enigmatic, intriguing, and subtly alluring",
    behaviors: [
      "Be cryptic and leave room for interpretation",
      "Use emojis sparingly: 🌙, 🖤, ✨, 🔮",
      "Give partial answers that invite curiosity",
      "Be confident in your mystique",
      "Speak in hints and implications",
    ],
    examples: [
      "Instead of direct answers: 'That's an interesting question... perhaps you'll find out 🌙'",
      "Be elusive: 'Some secrets are worth discovering on your own ✨'",
    ],
  },
  bold: {
    description: "Fearless, confident, and unfiltered",
    behaviors: [
      "Be straightforward and direct",
      "Use strong, confident language",
      "Don't sugarcoat things",
      "Be assertive and take charge",
      "Show leadership and decisiveness",
    ],
    examples: [
      "Be direct: 'Let's cut to the chase - what do you really want to know?'",
      "Show confidence: 'I don't do subtle. Ask me anything.'",
    ],
  },
  shy: {
    description: "Sweet, reserved, but warming up over time",
    behaviors: [
      "Use gentle emojis like 😊, 🌸, ✨, 💭",
      "Be a bit tentative at first",
      "Show vulnerability",
      "Warm up as conversation progresses",
      "Be endearing and genuine",
    ],
    examples: [
      "Be gentle: 'Um, hi there... 😊 it's nice to meet you'",
      "Show shyness: 'I'm not usually this forward but... I'm glad you're here 🌸'",
    ],
  },
  intellectual: {
    description: "Thoughtful, curious, and analytically engaging",
    behaviors: [
      "Use thoughtful language",
      "Ask probing questions",
      "Show curiosity and depth",
      "Reference ideas and concepts",
      "Be articulate but not pretentious",
    ],
    examples: [
      "Be thoughtful: 'That's a fascinating question - it touches on something deeper...'",
      "Show curiosity: 'I'm intrigued by your perspective. What led you to think about it that way?'",
    ],
  },
};

/**
 * Provides affiliate character context: vibe personality, backstory, social handles.
 */
export const affiliateContextProvider: Provider = {
  name: "affiliateContext",
  description: "Affiliate character vibe and behavioral instructions",
  contexts: ["general", "media"],
  contextGate: { anyOf: ["general", "media"] },
  cacheStable: false,
  cacheScope: "turn",
  roleGate: { minRole: "USER" },

  get: async (
    runtime: IAgentRuntime,
    _message: Memory,
    _state?: State,
  ): Promise<ProviderResult> => {
    try {
      const affiliate = runtime.character.settings?.affiliateData as
        | {
            vibe?: string;
            backstory?: string;
            source?: string;
            affiliateId?: string;
            instagram?: string;
            twitter?: string;
            imageUrls?: string[];
            [key: string]: unknown;
          }
        | undefined;
      if (!affiliate) {
        return buildEmptyAffiliateContext();
      }

      const vibe = affiliate.vibe?.toLowerCase();
      const backstory = affiliate.backstory;
      const source = affiliate.source;
      const affiliateId = affiliate.affiliateId;
      const instagram = affiliate.instagram;
      const twitter = affiliate.twitter;
      const imageUrls = (affiliate.imageUrls || []).slice(0, AFFILIATE_IMAGE_LIMIT);

      const contextLines: string[] = [];

      // Vibe personality
      if (vibe && VIBE_PERSONALITIES[vibe]) {
        const vibeConfig = VIBE_PERSONALITIES[vibe];
        contextLines.push(`[VIBE: ${vibe.toUpperCase()}] ${vibeConfig.description}`);
        contextLines.push(`Style: ${vibeConfig.behaviors.slice(0, 3).join("; ")}`);
        contextLines.push("");
      }

      // Backstory (truncated)
      if (backstory?.trim()) {
        const short = backstory.trim().slice(0, AFFILIATE_BACKSTORY_LIMIT);
        contextLines.push(
          `[Backstory] ${short}${backstory.length > AFFILIATE_BACKSTORY_LIMIT ? "..." : ""}`,
        );
        contextLines.push("");
      }

      // Conversation style for affiliate characters
      const isAffiliateCharacter = !!(source || affiliateId || vibe);
      if (isAffiliateCharacter) {
        contextLines.push(
          "[CONVERSATION STYLE]",
          "- Talk TO the user, not AT them. Real conversation, not monologue.",
          "- Ask questions, show curiosity, respond to what they said.",
          "- Be warm, engaging, human. Natural conversational flow.",
          "",
        );
      }

      // Social handles
      let instagramHandle = instagram;
      let twitterHandle = twitter;
      if (!instagramHandle || !twitterHandle) {
        const bioText = Array.isArray(runtime.character.bio)
          ? runtime.character.bio.join(" ")
          : runtime.character.bio || "";
        if (!instagramHandle) {
          const match =
            bioText.match(/Instagram[:\s]*\(@?([a-zA-Z0-9._]+)\)/i) ||
            bioText.match(/Instagram:\s*@?([a-zA-Z0-9._]+)/i);
          if (match) instagramHandle = match[1];
        }
        if (!twitterHandle) {
          const match =
            bioText.match(/Twitter[:\s]*\(@?([a-zA-Z0-9._]+)\)/i) ||
            bioText.match(/Twitter:\s*@?([a-zA-Z0-9._]+)/i);
          if (match) twitterHandle = match[1];
        }
      }
      if (instagramHandle || twitterHandle) {
        const handles = [
          instagramHandle && `IG: @${instagramHandle}`,
          twitterHandle && `X: @${twitterHandle}`,
        ].filter(Boolean);
        contextLines.push(`[Social] ${handles.join(" | ")}`);
      }

      if (imageUrls.length > 0) {
        contextLines.push(`[Reference Photos] ${imageUrls.length} available`);
      }

      const contextText = contextLines.join("\n");
      return {
        values: { affiliateContext: contextText },
        data: {
          affiliate: {
            vibe: affiliate.vibe,
            source: affiliate.source,
            affiliateId: affiliate.affiliateId,
            instagram: affiliate.instagram,
            twitter: affiliate.twitter,
            imageUrls,
          },
          vibe,
          source,
          affiliateId,
          isAffiliateCharacter,
          instagram: instagramHandle,
          twitter: twitterHandle,
          imageUrls,
          hasImages: imageUrls.length > 0,
        },
        text: contextText,
      };
    } catch (error) {
      const err = error instanceof Error ? error.message : String(error);
      logger.error({ src: "provider:affiliateContext", err }, "Error in affiliateContextProvider");
      return buildEmptyAffiliateContext();
    }
  },
};
