/**
 * NPC Character Configuration
 *
 * Derives character-specific settings from the existing actor data.
 * Uses the StaticDataRegistry to access actor definitions.
 *
 * NOTE: All character data (personality, postStyle, voice, postExample, domain)
 * is sourced from the currently loaded pack actor definitions.
 * This module provides derived configuration and utility functions.
 *
 * @module services/npc-character-config
 */

import { logger } from "@feed/shared";
import {
  type RngFunction,
  randomChance,
  shuffleArray,
} from "../utils/randomization";
import { StaticDataRegistry } from "./static-data-registry";

/**
 * Personality type derived from actor's personality field
 */
export type PersonalityType =
  | "chaotic" // High randomness, unpredictable
  | "provocative" // Controversial, attention-seeking
  | "corporate" // Measured, professional
  | "analytical" // Data-driven, precise
  | "eccentric" // Quirky, unique patterns
  | "default"; // Standard behavior

/**
 * Character-specific configuration derived from actor data
 */
export interface CharacterConfig {
  /** Generation temperature (0.5-1.0) */
  temperature: number;
  /** Personality type for behavior patterns */
  personalityType: PersonalityType;
  /** Primary domains this character cares about (from actor.domain) */
  domains: string[];
  /** Rival actor IDs - characters they naturally disagree with */
  rivals: string[];
  /** Voice patterns to check for consistency (derived from postStyle) */
  voicePatterns: RegExp[];
  /** Anti-patterns - things this character would NEVER say */
  antiPatterns: RegExp[];
  /** Example posts from actor data (actor.postExample) */
  templatePosts: string[];
  /** Probability of posting about off-domain topics (0-1) */
  offDomainProbability: number;
  /** Probability of posting organic (non-question) content (0-1) */
  organicPostProbability: number;
}

/**
 * Keywords that indicate personality types (matched against actor.personality)
 */
const PERSONALITY_KEYWORDS: Record<PersonalityType, string[]> = {
  chaotic: [
    "chaotic",
    "unhinged",
    "wild",
    "erratic",
    "manic",
    "unpredictable",
    "stream of consciousness",
  ],
  provocative: [
    "provocative",
    "controversial",
    "aggressive",
    "combative",
    "narcissist",
    "showman",
    "bully",
  ],
  corporate: [
    "corporate",
    "professional",
    "measured",
    "executive",
    "ceo",
    "director",
    "responsible",
  ],
  analytical: [
    "analytical",
    "data",
    "technical",
    "academic",
    "researcher",
    "scientist",
    "engineer",
  ],
  eccentric: [
    "eccentric",
    "quirky",
    "unique",
    "weird",
    "philosopher",
    "visionary",
  ],
  default: [],
};

/**
 * Temperature settings by personality type
 * All values are within LLM acceptable range (0-2)
 */
const PERSONALITY_TEMPERATURES = {
  chaotic: 0.95,
  provocative: 0.9,
  eccentric: 0.85,
  default: 0.8,
  analytical: 0.7,
  corporate: 0.6,
} as const satisfies Record<PersonalityType, number>;

/**
 * Organic post probability by personality type
 */
const ORGANIC_PROBABILITIES: Record<PersonalityType, number> = {
  chaotic: 0.4,
  provocative: 0.35,
  eccentric: 0.3,
  default: 0.15,
  analytical: 0.1,
  corporate: 0.1,
};

/**
 * Off-domain posting probability by personality type
 */
const OFFDOMAIN_PROBABILITIES: Record<PersonalityType, number> = {
  chaotic: 0.5,
  provocative: 0.4,
  eccentric: 0.4,
  default: 0.3,
  analytical: 0.15,
  corporate: 0.1,
};

/**
 * Build rivalry map for quick lookup.
 * Loads rivalries dynamically from StaticDataRegistry (pack data)
 * instead of a hardcoded array.
 */
function buildRivalryMap(): Map<string, string[]> {
  const map = new Map<string, string[]>();
  const rivalries = StaticDataRegistry.getRivalries();

  for (const [a, b] of rivalries) {
    map.set(a, [...(map.get(a) || []), b]);
    map.set(b, [...(map.get(b) || []), a]);
  }

  return map;
}

/** Lazily-built rivalry map — rebuilt each time it's accessed to reflect current pack data */
let _rivalryMapCache: Map<string, string[]> | null = null;
let _rivalryMapPackId: string | null = null;

function getRivalryMap(): Map<string, string[]> {
  const currentPackId = StaticDataRegistry.getPackId();
  if (_rivalryMapCache === null || _rivalryMapPackId !== currentPackId) {
    _rivalryMapCache = buildRivalryMap();
    _rivalryMapPackId = currentPackId;
  }
  return _rivalryMapCache;
}

/**
 * Domain keywords for topic matching
 * Maps broad domain categories to specific keywords
 */
const DOMAIN_KEYWORDS: Record<string, string[]> = {
  ai: [
    "artificial intelligence",
    "machine learning",
    "neural",
    "model",
    "llm",
    "gpt",
    "claude",
    "agi",
  ],
  tech: [
    "technology",
    "software",
    "hardware",
    "computer",
    "digital",
    "app",
    "platform",
  ],
  crypto: ["bitcoin", "ethereum", "blockchain", "token", "defi", "nft", "web3"],
  finance: [
    "market",
    "stock",
    "investment",
    "trading",
    "fund",
    "asset",
    "capital",
  ],
  politics: [
    "government",
    "congress",
    "senate",
    "election",
    "policy",
    "regulation",
  ],
  health: ["medical", "vaccine", "disease", "healthcare", "pharmaceutical"],
  climate: ["environment", "carbon", "renewable", "energy", "sustainability"],
  space: ["rocket", "remote", "mars", "orbit", "launch"],
  culture: ["art", "music", "fashion", "entertainment", "media"],
  safety: ["alignment", "risk", "responsible", "constitutional"],
  research: ["study", "paper", "science", "academic"],
};

/**
 * Memoization cache for compiled voice patterns
 * Prevents recompiling regex on every getCharacterConfig() call
 */
const voicePatternsCache = new Map<string, RegExp[]>();

/**
 * Determine personality type from actor's personality field
 */
function derivePersonalityType(
  personality: string | undefined,
): PersonalityType {
  if (!personality) return "default";

  const lowerPersonality = personality.toLowerCase();

  for (const [type, keywords] of Object.entries(PERSONALITY_KEYWORDS) as Array<
    [PersonalityType, string[]]
  >) {
    if (type === "default") continue;
    if (keywords.some((kw) => lowerPersonality.includes(kw))) {
      return type;
    }
  }

  return "default";
}

/**
 * Derive voice patterns from postStyle
 * Creates regex patterns to check for characteristic voice elements
 * Uses memoization to avoid recompiling regex on every call
 */
function deriveVoicePatterns(
  actorId: string,
  postStyle: string | undefined,
): RegExp[] {
  if (!postStyle) return [];

  // Check cache first
  const cached = voicePatternsCache.get(actorId);
  if (cached) return cached;

  const patterns: RegExp[] = [];
  const styleLower = postStyle.toLowerCase();

  // Check for ALL CAPS style
  if (styleLower.includes("all caps") || styleLower.includes("caps")) {
    patterns.push(/^[A-Z\s\d.,!?'"()-]+$/);
  }

  // Check for specific style indicators
  if (styleLower.includes("exclamation")) {
    patterns.push(/!{2,}/);
  }

  if (styleLower.includes("stream of consciousness")) {
    patterns.push(/\.\.\.|—|–/);
  }

  // Cache the compiled patterns
  voicePatternsCache.set(actorId, patterns);
  return patterns;
}

/**
 * Default configuration for characters without specific config
 */
const DEFAULT_CONFIG: CharacterConfig = {
  temperature: 0.8,
  personalityType: "default",
  domains: [],
  rivals: [],
  voicePatterns: [],
  antiPatterns: [],
  templatePosts: [],
  offDomainProbability: 0.3,
  organicPostProbability: 0.15,
};

/**
 * Get configuration for a specific character
 * Derives config from the actor's existing data in StaticDataRegistry
 *
 * @param actorId - The actor's ID
 * @returns Full character configuration
 */
export function getCharacterConfig(actorId: string): CharacterConfig {
  const actor = StaticDataRegistry.getActor(actorId);

  if (!actor) {
    throw new Error(`Actor '${actorId}' not found in StaticDataRegistry`);
  }

  const personalityType = derivePersonalityType(actor.personality);
  const domains = actor.domain || [];
  const rivals = getRivalryMap().get(actorId) || [];
  const voicePatterns = deriveVoicePatterns(actorId, actor.postStyle);
  const templatePosts = actor.postExample || [];

  return {
    temperature: PERSONALITY_TEMPERATURES[personalityType],
    personalityType,
    domains,
    rivals,
    voicePatterns,
    antiPatterns: [], // Could be derived from personality if needed
    templatePosts,
    offDomainProbability: OFFDOMAIN_PROBABILITIES[personalityType],
    organicPostProbability: ORGANIC_PROBABILITIES[personalityType],
  };
}

/**
 * Get configuration for a specific character, returning default config if not found.
 * Use this variant when caller can handle missing actors gracefully.
 *
 * @param actorId - The actor's ID
 * @returns Full character configuration or default config
 */
export function getCharacterConfigOrDefault(actorId: string): CharacterConfig {
  const actor = StaticDataRegistry.getActor(actorId);

  if (!actor) {
    return DEFAULT_CONFIG;
  }

  const personalityType = derivePersonalityType(actor.personality);
  const domains = actor.domain || [];
  const rivals = getRivalryMap().get(actorId) || [];
  const voicePatterns = deriveVoicePatterns(actorId, actor.postStyle);
  const templatePosts = actor.postExample || [];

  return {
    temperature: PERSONALITY_TEMPERATURES[personalityType],
    personalityType,
    domains,
    rivals,
    voicePatterns,
    antiPatterns: [],
    templatePosts,
    offDomainProbability: OFFDOMAIN_PROBABILITIES[personalityType],
    organicPostProbability: ORGANIC_PROBABILITIES[personalityType],
  };
}

/**
 * Get temperature for a specific character
 * Returns default temperature for unknown actors.
 */
export function getCharacterTemperature(actorId: string): number {
  const config = getCharacterConfigOrDefault(actorId);
  return config.temperature;
}

/**
 * Check if a post matches the character's voice patterns
 *
 * @param actorId - The actor's ID
 * @param postContent - The generated post content
 * @returns Object with match status and details
 */
export function checkVoiceConsistency(
  actorId: string,
  postContent: string,
): {
  matchesVoice: boolean;
  matchedPatterns: string[];
  violatedAntiPatterns: string[];
  voiceScore: number;
} {
  const config = getCharacterConfigOrDefault(actorId);

  const matchedPatterns: string[] = [];
  const violatedAntiPatterns: string[] = [];

  // Check voice patterns (positive)
  for (const pattern of config.voicePatterns) {
    if (pattern.test(postContent)) {
      matchedPatterns.push(pattern.source);
    }
  }

  // Check anti-patterns (negative)
  for (const pattern of config.antiPatterns) {
    if (pattern.test(postContent)) {
      violatedAntiPatterns.push(pattern.source);
    }
  }

  // Calculate voice score
  const voiceScore =
    config.voicePatterns.length > 0
      ? matchedPatterns.length / config.voicePatterns.length
      : 1;

  const matchesVoice =
    violatedAntiPatterns.length === 0 &&
    (config.voicePatterns.length === 0 || matchedPatterns.length > 0);

  return {
    matchesVoice,
    matchedPatterns,
    violatedAntiPatterns,
    voiceScore,
  };
}

/**
 * Check if an actor should post about a given topic based on their domain
 *
 * @param actorId - The actor's ID
 * @param topicText - The topic/question text
 * @param rng - Optional random number generator (defaults to Math.random)
 * @returns Whether the actor should post about this topic
 */
export function shouldPostAboutTopic(
  actorId: string,
  topicText: string,
  rng: RngFunction = Math.random,
): boolean {
  const actor = StaticDataRegistry.getActor(actorId);
  const config = getCharacterConfigOrDefault(actorId);

  // Normalize text: lowercase, remove punctuation (hyphens, etc.), collapse whitespace
  const normalizeText = (text: string): string =>
    text.toLowerCase().replace(/[-_]/g, " ").replace(/\s+/g, " ").trim();

  /**
   * Check if keyword matches as a whole word in text.
   * Uses word boundaries to prevent "gpu" matching "GPUpdate" or "tech" matching "biotech".
   */
  const matchesWholeWord = (text: string, keyword: string): boolean => {
    const escapedKeyword = keyword.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const wordBoundaryPattern = new RegExp(`\\b${escapedKeyword}\\b`, "i");
    return wordBoundaryPattern.test(text);
  };

  const topicNormalized = normalizeText(topicText);

  // Check ignoreTopics first - if actor explicitly ignores this topic, skip
  if (actor?.ignoreTopics && actor.ignoreTopics.length > 0) {
    const isIgnored = actor.ignoreTopics.some((ignoredTopic) => {
      const keywords = DOMAIN_KEYWORDS[ignoredTopic] || [ignoredTopic];
      return keywords.some((kw) =>
        matchesWholeWord(topicNormalized, normalizeText(kw)),
      );
    });
    if (isIgnored) {
      logger.debug(
        `Actor ${actorId} ignoring topic`,
        { topicText: topicText.substring(0, 50) },
        "NPCCharacterConfig",
      );
      return false;
    }
  }

  // If no domains defined, can post about anything
  if (config.domains.length === 0) {
    return true;
  }

  // Check if topic matches any of the actor's domains
  const isOnDomain = config.domains.some((domain) => {
    // Direct domain match (whole word)
    if (matchesWholeWord(topicNormalized, normalizeText(domain))) return true;

    // Domain keyword expansions
    const keywords = DOMAIN_KEYWORDS[domain] || [];
    return keywords.some((kw) =>
      matchesWholeWord(topicNormalized, normalizeText(kw)),
    );
  });

  // If on-domain, always allow
  if (isOnDomain) {
    return true;
  }

  // For off-domain topics, check engagement threshold
  const engagementThreshold = actor?.engagementThreshold ?? 0.5;

  // Off-domain probability, scaled by engagement threshold
  // Higher threshold = less likely to post off-domain
  const scaledProbability =
    config.offDomainProbability * (1 - engagementThreshold);

  if (randomChance(scaledProbability, rng)) {
    logger.debug(
      `Actor ${actorId} posting off-domain`,
      { topicText: topicText.substring(0, 50), probability: scaledProbability },
      "NPCCharacterConfig",
    );
    return true;
  }

  return false;
}

/**
 * Check if actor should generate an organic (non-question) post
 *
 * @param actorId - The actor's ID
 * @param rng - Optional random number generator (defaults to Math.random)
 * @returns Whether to generate an organic post
 */
export function shouldGenerateOrganicPost(
  actorId: string,
  rng: RngFunction = Math.random,
): boolean {
  const config = getCharacterConfigOrDefault(actorId);
  return randomChance(config.organicPostProbability, rng);
}

/**
 * Get template posts (postExample) for few-shot examples
 *
 * @param actorId - The actor's ID
 * @param count - Number of templates to return
 * @param rng - Optional random number generator (defaults to Math.random)
 * @returns Array of template posts
 */
export function getTemplatePosts(
  actorId: string,
  count: number = 3,
  rng: RngFunction = Math.random,
): string[] {
  const config = getCharacterConfigOrDefault(actorId);

  if (config.templatePosts.length === 0) {
    return [];
  }

  // Shuffle using shared utility and take requested count
  const shuffled = shuffleArray(config.templatePosts, rng);
  return shuffled.slice(0, Math.min(count, shuffled.length));
}

/**
 * Get rivals for an actor
 *
 * @param actorId - The actor's ID
 * @returns Array of rival actor IDs
 */
export function getActorRivals(actorId: string): string[] {
  return getRivalryMap().get(actorId) || [];
}

/**
 * Log voice consistency metrics for monitoring
 *
 * @param actorId - The actor's ID
 * @param postContent - The generated post
 */
export function logVoiceMetrics(actorId: string, postContent: string): void {
  const result = checkVoiceConsistency(actorId, postContent);

  if (!result.matchesVoice) {
    logger.warn(
      "Voice consistency issue detected",
      {
        actorId,
        voiceScore: result.voiceScore,
        matchedPatterns: result.matchedPatterns.length,
        violatedAntiPatterns: result.violatedAntiPatterns,
        postPreview: postContent.slice(0, 100),
      },
      "VoiceMetrics",
    );
  } else if (result.voiceScore < 0.3 && result.matchedPatterns.length === 0) {
    logger.debug(
      "Low voice score (no distinctive patterns matched)",
      {
        actorId,
        voiceScore: result.voiceScore,
        postPreview: postContent.slice(0, 100),
      },
      "VoiceMetrics",
    );
  }
}

/**
 * Get all configured character IDs (all actors in the registry)
 */
export function getConfiguredCharacters(): string[] {
  return StaticDataRegistry.getAllActors().map((a) => a.id);
}
