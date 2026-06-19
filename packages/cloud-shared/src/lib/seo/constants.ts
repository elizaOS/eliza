/**
 * SEO constants for site-wide metadata configuration.
 *
 * Default values are sourced from the English catalog at `./locales/en.ts`.
 * For locale-aware copy, use `getSeoConstants(locale)` / `getRouteMetadata(locale)`.
 */

import { seoMessages as en } from "./locales/en";
import { getSeoMessages, type SeoMessages } from "./messages";

const DEFAULT_KEYWORDS = [
  "AI",
  "agents",
  "elizaOS",
  "platform",
  "development",
  "hosting",
  "machine learning",
  "artificial intelligence",
  "LLM",
  "deployment",
] as const;

const OG_IMAGE_DIMENSIONS = {
  width: 1200,
  height: 630,
} as const;

const ROUTE_KEYWORDS = {
  home: ["AI platform", "agent development", "elizaOS", "AI hosting", "LLM deployment"],
  dashboard: ["dashboard", "AI management", "Eliza Cloud dashboard"],
  containers: ["containers", "deployment", "AWS ECS", "Docker", "elizaOS deploy"],
  eliza: ["Chat", "AI chat", "elizaOS runtime", "AI agent"],
  characterCreator: ["character creator", "AI characters", "agent builder", "elizaOS characters"],
  myAgents: ["my agents", "personal agents", "AI characters", "agent management"],
  textGeneration: ["text generation", "GPT-4", "Claude", "AI writing", "LLM API"],
  imageGeneration: ["image generation", "AI images", "Gemini", "AI art", "image AI"],
  videoGeneration: ["video generation", "AI video", "Veo3", "Kling", "video AI"],
  voiceCloning: ["voice cloning", "ElevenLabs", "voice AI", "TTS", "voice synthesis"],
  apiExplorer: ["API explorer", "API docs", "REST API", "Eliza Cloud API"],
  billing: ["billing", "credits", "pricing", "payment", "Stripe"],
  apiKeys: ["API keys", "authentication", "API access", "tokens"],
  analytics: ["analytics", "usage tracking", "metrics", "monitoring"],
  storage: ["storage", "files", "R2", "cloud storage"],
  gallery: ["gallery", "generated images", "AI art", "content library"],
  account: ["account", "settings", "profile", "preferences"],
} as const;

type RouteKey = keyof SeoMessages["routes"];

/**
 * Builds the SEO_CONSTANTS shape from a locale catalog.
 */
function buildSeoConstants(messages: SeoMessages) {
  return {
    siteName: messages.siteName,
    twitterHandle: "@elizaos",
    defaultTitle: messages.defaultTitle,
    defaultDescription: messages.defaultDescription,
    defaultKeywords: DEFAULT_KEYWORDS,
    ogImageDimensions: OG_IMAGE_DIMENSIONS,
    twitterCardType: "summary_large_image" as const,
    locale: "en_US",
  };
}

/**
 * Builds the ROUTE_METADATA shape from a locale catalog.
 */
function buildRouteMetadata(messages: SeoMessages) {
  const out = {} as Record<RouteKey, { title: string; description: string; keywords: string[] }>;
  for (const key of Object.keys(messages.routes) as RouteKey[]) {
    out[key] = {
      title: messages.routes[key].title,
      description: messages.routes[key].description,
      keywords: [...ROUTE_KEYWORDS[key]],
    };
  }
  return out;
}

/**
 * Locale-aware accessor for site-wide SEO constants.
 */
export function getSeoConstants(locale?: string | null) {
  return buildSeoConstants(getSeoMessages(locale));
}

/**
 * Locale-aware accessor for route-specific metadata.
 */
export function getRouteMetadata(locale?: string | null) {
  return buildRouteMetadata(getSeoMessages(locale));
}

/**
 * Default English SEO constants. Prefer `getSeoConstants(locale)` for new
 * callers that have a locale in context.
 */
export const SEO_CONSTANTS = buildSeoConstants(en);

/**
 * Default English route metadata. Prefer `getRouteMetadata(locale)` for new
 * callers that have a locale in context.
 */
export const ROUTE_METADATA = buildRouteMetadata(en);
