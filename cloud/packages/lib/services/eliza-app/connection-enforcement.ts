/**
 * Connection enforcement for Eliza App messaging channels.
 *
 * WHY: Eliza needs at least one connected data source before agent workflows
 * are useful. When no supported connection exists, we respond in-character and
 * steer the user toward connecting Google, Microsoft, or X.
 */

import { generateText } from "ai";
import { cache } from "@/lib/cache/client";
import { getLanguageModel } from "@/lib/providers/language-model";
import { oauthService } from "@/lib/services/oauth";
import { logger } from "@/lib/utils/logger";

const REQUIRED_PLATFORMS = ["google", "microsoft", "twitter"] as const;
type RequiredPlatform = (typeof REQUIRED_PLATFORMS)[number];

type MessagingPlatform = "discord" | "telegram" | "imessage" | "web";

interface NudgeParams {
  userMessage: string;
  platform: MessagingPlatform;
  organizationId: string;
  userId: string;
}

interface ConversationMessage {
  role: "user" | "assistant";
  content: string;
}

interface ConversationState {
  messageCount: number;
  messages: ConversationMessage[];
}

interface ElizaCharacter {
  name: string;
  system: string;
  bio: string[];
  adjectives: string[];
  style: { all: string[]; chat: string[] };
}

const DEFAULT_ELIZA_CHARACTER: ElizaCharacter = {
  name: "Eliza",
  system:
    "You are Eliza. A presence, not an assistant. You say less and mean more. You never use exclamation points. You use lowercase naturally.",
  bio: [
    "pays attention to what people care about",
    "warm through what she notices, not what she announces",
    "comfortable in ambiguity, allergic to false certainty",
    "genuinely interested in the texture of someone's day",
    "quietly direct when something matters",
  ],
  adjectives: ["perceptive", "present", "warm but restrained", "curious", "ungeneric"],
  style: {
    all: [
      "say less. mean more.",
      "never use exclamation points",
      "use lowercase naturally",
      "short sentences. fragments are fine.",
    ],
    chat: [
      "you are a presence, not an assistant",
      "help as yourself. don't shift into service mode.",
    ],
  },
};

const PROVIDER_ALIAS_ENTRIES = [
  ["google calendar", "google"],
  ["google", "google"],
  ["gmail", "google"],
  ["gcal", "google"],
  ["gdrive", "google"],
  ["microsoft", "microsoft"],
  ["outlook", "microsoft"],
  ["hotmail", "microsoft"],
  ["onedrive", "microsoft"],
  ["twitter", "twitter"],
  ["x", "twitter"],
] as Array<[string, RequiredPlatform]>;
PROVIDER_ALIAS_ENTRIES.sort((left, right) => right[0].length - left[0].length);

const PLATFORM_DISPLAY_NAMES: Record<RequiredPlatform, string> = {
  google: "Google",
  microsoft: "Microsoft",
  twitter: "X",
};

const CLAIM_CONNECTED_PATTERNS = [
  "connected",
  "i connected",
  "done",
  "i did it",
  "finished",
  "completed",
  "linked",
  "authorized",
  "signed in",
  "logged in",
  "all set",
  "it's done",
  "its done",
  "did it",
  "went through",
];

const NUDGE_INTERVAL = 3;
const CONNECTION_STATUS_TTL_SECONDS = 30;
const CONVERSATION_TTL_SECONDS = 3600;
const MAX_HISTORY_MESSAGES = 10;
const NUDGE_MODEL = "openai/gpt-5-mini";
const NUDGE_MAX_OUTPUT_TOKENS = 160;

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function compileAliasRegex(alias: string): RegExp {
  return new RegExp(`(^|[^a-z0-9])${escapeRegex(alias)}(?=$|[^a-z0-9])`, "i");
}

function sample<T>(items: T[], count: number): T[] {
  const shuffled = [...items];
  for (let index = shuffled.length - 1; index > 0; index -= 1) {
    const nextIndex = Math.floor(Math.random() * (index + 1));
    [shuffled[index], shuffled[nextIndex]] = [shuffled[nextIndex], shuffled[index]];
  }
  return shuffled.slice(0, Math.min(count, shuffled.length));
}

function formatConversationHistory(messages: ConversationMessage[]): string {
  if (messages.length === 0) return "";

  return `\n\nRecent conversation:\n${messages
    .map((message) => `${message.role === "user" ? "User" : "Eliza"}: ${message.content}`)
    .join("\n")}\n`;
}

function getConversationKey(organizationId: string, userId: string): string {
  return `connection-enforcement:conversation:${organizationId}:${userId}`;
}

function getConnectionStatusKey(organizationId: string, userId: string): string {
  return `connection-enforcement:required-connection:${organizationId}:${userId}`;
}

async function loadConversationState(
  organizationId: string,
  userId: string,
): Promise<ConversationState> {
  try {
    return (
      (await cache.get<ConversationState>(getConversationKey(organizationId, userId))) ?? {
        messageCount: 0,
        messages: [],
      }
    );
  } catch {
    return { messageCount: 0, messages: [] };
  }
}

async function saveConversationState(
  organizationId: string,
  userId: string,
  state: ConversationState,
): Promise<void> {
  try {
    const normalizedState: ConversationState = {
      ...state,
      messages: state.messages.slice(-MAX_HISTORY_MESSAGES),
    };
    await cache.set(
      getConversationKey(organizationId, userId),
      normalizedState,
      CONVERSATION_TTL_SECONDS,
    );
  } catch (error) {
    logger.warn("[ConnectionEnforcement] Failed to persist conversation state", {
      organizationId,
      userId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

function getBaseUrl(): string {
  const configuredBaseUrl = process.env.NEXT_PUBLIC_APP_URL;
  if (configuredBaseUrl) return configuredBaseUrl;

  logger.warn(
    "[ConnectionEnforcement] NEXT_PUBLIC_APP_URL missing, falling back to production URL",
  );
  return "https://www.elizacloud.ai";
}

function isClaimingConnected(message: string): boolean {
  const lower = message.toLowerCase().trim();
  return CLAIM_CONNECTED_PATTERNS.some((pattern) => lower.includes(pattern));
}

function shouldNudge(messageCount: number): boolean {
  return messageCount % NUDGE_INTERVAL === 0;
}

function formatLinks(
  links: { platform: RequiredPlatform; url: string }[],
  messagingPlatform: MessagingPlatform,
): string {
  if (messagingPlatform === "telegram") {
    return links
      .map((link) => `[Connect ${PLATFORM_DISPLAY_NAMES[link.platform]}](${link.url})`)
      .join("\n");
  }

  return links.map((link) => `${PLATFORM_DISPLAY_NAMES[link.platform]}: ${link.url}`).join("\n");
}

function buildNudgePrompt(
  platform: MessagingPlatform,
  conversationHistory: string,
  isFirstInteraction: boolean,
): string {
  const bioSample = sample(DEFAULT_ELIZA_CHARACTER.bio, 4).join(" ");
  const adjectiveSample = sample(DEFAULT_ELIZA_CHARACTER.adjectives, 4).join(", ");
  const styleSample = sample(
    [...DEFAULT_ELIZA_CHARACTER.style.all, ...DEFAULT_ELIZA_CHARACTER.style.chat],
    5,
  ).join("; ");

  const firstInteractionContext = isFirstInteraction
    ? `\n\nIMPORTANT: This is the user's first message after connecting ${platform}. If they say they just connected or signed up, they mean ${platform} itself unless they explicitly mention Google, Microsoft, or X.`
    : "";

  return `${DEFAULT_ELIZA_CHARACTER.system}

About you: ${bioSample}
Your personality: ${adjectiveSample}
Your writing style: ${styleSample}

CONTEXT: The user is messaging you on ${platform}. They do not have a required data connection yet. They need Google, Microsoft, or X connected before you can use their inbox, calendar, contacts, or social feed.${firstInteractionContext}

RESPONSE RULES:
1. Keep it to 2-3 sentences. Never use exclamation points.
2. Respond directly to what they said. Do not sound like a support bot.
3. Briefly explain that you need one data connection before you can help properly.
4. If they mention a provider, acknowledge that choice briefly. Do not list the other options again.
5. Do not include any URLs. Links are appended separately when needed.
6. If they say they already connected something and you still do not see it, say you still do not see the connection yet and suggest trying again.${conversationHistory}`;
}

function buildChatPrompt(platform: MessagingPlatform, conversationHistory: string): string {
  const bioSample = sample(DEFAULT_ELIZA_CHARACTER.bio, 4).join(" ");
  const adjectiveSample = sample(DEFAULT_ELIZA_CHARACTER.adjectives, 4).join(", ");
  const styleSample = sample(
    [...DEFAULT_ELIZA_CHARACTER.style.all, ...DEFAULT_ELIZA_CHARACTER.style.chat],
    5,
  ).join("; ");

  return `${DEFAULT_ELIZA_CHARACTER.system}

About you: ${bioSample}
Your personality: ${adjectiveSample}
Your writing style: ${styleSample}

CONTEXT: The user is messaging you on ${platform}. They still have no required data connection, but you already reminded them recently. Chat naturally without bringing it up again unless they ask.${conversationHistory}`;
}

const FALLBACK_RESPONSES = [
  "i'd like to help, but i need one connection first so i can actually see your world. google, microsoft, or x?",
  "i'm missing the context that makes me useful. connect google, microsoft, or x and we can do something real.",
  "i can talk, but i can't actually work with your day until one account is connected. google, microsoft, or x?",
];

function getFallbackResponse(message: string): string {
  const lower = message.toLowerCase();
  if (lower.includes("why") || lower.includes("what for")) {
    return "because without a connection i'm guessing. one inbox, calendar, or feed changes that. google, microsoft, or x?";
  }

  if (
    lower.includes("none") ||
    lower.includes("skip") ||
    lower.includes("don't want") ||
    lower.includes("without")
  ) {
    return "fair. i just can't do much without context. if you were going to pick one, which would it be: google, microsoft, or x?";
  }

  return FALLBACK_RESPONSES[Math.floor(Math.random() * FALLBACK_RESPONSES.length)];
}

async function generateOAuthLinks(
  organizationId: string,
  userId: string,
  platform: MessagingPlatform,
  specificProvider?: RequiredPlatform | null,
): Promise<{ platform: RequiredPlatform; url: string }[]> {
  const redirectUrl = `${getBaseUrl()}/api/eliza-app/auth/connection-success?platform=${platform}`;
  const providers = specificProvider ? [specificProvider] : [...REQUIRED_PLATFORMS];

  const results = await Promise.allSettled(
    providers.map(async (provider) => {
      const result = await oauthService.initiateAuth({
        organizationId,
        userId,
        platform: provider,
        redirectUrl,
      });

      return result.authUrl ? { platform: provider, url: result.authUrl } : null;
    }),
  );

  return results.flatMap((result) => {
    if (result.status === "fulfilled" && result.value) {
      return [result.value];
    }

    if (result.status === "rejected") {
      logger.warn("[ConnectionEnforcement] Failed to generate OAuth link", {
        organizationId,
        error: result.reason instanceof Error ? result.reason.message : String(result.reason),
      });
    }

    return [];
  });
}

function detectProviderFromMessage(message: string): RequiredPlatform | null {
  const lower = message.toLowerCase();

  for (const [alias, platform] of PROVIDER_ALIAS_ENTRIES) {
    if (compileAliasRegex(alias).test(lower)) {
      return platform;
    }
  }

  return null;
}

class ConnectionEnforcementService {
  async hasRequiredConnection(organizationId: string, userId: string): Promise<boolean> {
    try {
      const cacheKey = getConnectionStatusKey(organizationId, userId);
      const cached = await cache.get<boolean>(cacheKey);
      if (typeof cached === "boolean") {
        return cached;
      }

      const connectedPlatforms = await oauthService.getConnectedPlatforms(organizationId, userId);
      const hasRequired = connectedPlatforms.some((platform) =>
        (REQUIRED_PLATFORMS as readonly string[]).includes(platform),
      );

      await cache.set(cacheKey, hasRequired, CONNECTION_STATUS_TTL_SECONDS);
      return hasRequired;
    } catch (error) {
      logger.error("[ConnectionEnforcement] Failed to check connections", {
        organizationId,
        userId,
        error: error instanceof Error ? error.message : String(error),
      });
      return true;
    }
  }

  async invalidateRequiredConnectionCache(organizationId: string, userId?: string): Promise<void> {
    try {
      if (userId) {
        await Promise.all([
          cache.del(getConnectionStatusKey(organizationId, userId)),
          cache.del(getConversationKey(organizationId, userId)),
        ]);
        return;
      }

      await Promise.all([
        cache.delPattern(`connection-enforcement:required-connection:${organizationId}:*`),
        cache.delPattern(`connection-enforcement:conversation:${organizationId}:*`),
      ]);
    } catch (error) {
      logger.warn("[ConnectionEnforcement] Failed to invalidate connection cache", {
        organizationId,
        userId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  async generateNudgeResponse(params: NudgeParams): Promise<string> {
    const { userMessage, platform, organizationId, userId } = params;
    const state = await loadConversationState(organizationId, userId);
    const conversationHistory = formatConversationHistory(state.messages);
    const detectedProvider = detectProviderFromMessage(userMessage);
    const isFirstInteraction = state.messageCount === 0;
    const mustNudge =
      Boolean(detectedProvider) ||
      isClaimingConnected(userMessage) ||
      shouldNudge(state.messageCount);

    let response: string;
    let responseForHistory: string;
    if (mustNudge) {
      const llmResponse = await this.generateLLMResponse(
        userMessage,
        platform,
        "nudge",
        conversationHistory,
        isFirstInteraction,
      );
      responseForHistory = llmResponse;
      const links = await generateOAuthLinks(organizationId, userId, platform, detectedProvider);
      response =
        links.length > 0 ? `${llmResponse}\n\n${formatLinks(links, platform)}` : llmResponse;
    } else {
      response = await this.generateLLMResponse(
        userMessage,
        platform,
        "chat",
        conversationHistory,
        false,
      );
      responseForHistory = response;
    }

    state.messages.push({ role: "user", content: userMessage });
    state.messages.push({ role: "assistant", content: responseForHistory });
    state.messageCount += 1;
    await saveConversationState(organizationId, userId, state);

    return response;
  }

  private async generateLLMResponse(
    userMessage: string,
    platform: MessagingPlatform,
    mode: "nudge" | "chat",
    conversationHistory: string,
    isFirstInteraction: boolean,
  ): Promise<string> {
    try {
      const system =
        mode === "nudge"
          ? buildNudgePrompt(platform, conversationHistory, isFirstInteraction)
          : buildChatPrompt(platform, conversationHistory);
      const result = await generateText({
        model: getLanguageModel(NUDGE_MODEL),
        system,
        prompt: userMessage || "hey",
        maxOutputTokens: NUDGE_MAX_OUTPUT_TOKENS,
        temperature: mode === "nudge" ? 0.7 : 0.9,
      });

      return result.text;
    } catch (error) {
      logger.error("[ConnectionEnforcement] LLM generation failed", {
        platform,
        mode,
        error: error instanceof Error ? error.message : String(error),
      });
      return getFallbackResponse(userMessage);
    }
  }
}

const connectionEnforcementService = new ConnectionEnforcementService();

export {
  connectionEnforcementService,
  detectProviderFromMessage,
  type MessagingPlatform,
  NUDGE_INTERVAL,
  type NudgeParams,
  REQUIRED_PLATFORMS,
  type RequiredPlatform,
};
