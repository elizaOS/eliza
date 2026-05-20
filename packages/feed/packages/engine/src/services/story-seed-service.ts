/**
 * Story Seed Service
 *
 * @module engine/services/story-seed-service
 *
 * @description
 * Generates diverse story seeds not tied to prediction market questions.
 * Breaks the content generation flywheel by introducing topics that news
 * outlets can cover independently of trending/engagement.
 *
 * **Story Types:**
 * 1. **Beat Stories** - Based on organization's editorial focus
 * 2. **Investigative Seeds** - Topics that could later become questions
 * 3. **Analysis Pieces** - Market/industry trend analysis
 * 4. **Character Profiles** - Deep dives on game actors
 * 5. **Breaking Events** - Simulated news events in the game world
 *
 * @example
 * ```typescript
 * const storyService = new StorySeedService(llm);
 *
 * // Get story for specific outlet's beat
 * const story = await storyService.generateBeatStory('bloombairg', 'finance');
 *
 * // Get diverse stories for any outlet
 * const stories = await storyService.generateDiverseStories(5);
 * ```
 */

import { logger } from "@feed/shared";
import type { FeedLLMClient } from "../llm/openai-client";
import { StaticDataRegistry } from "./static-data-registry";
import {
  type EditorialBeat,
  getTopicDiversityService,
  ORGANIZATION_BEATS,
} from "./topic-diversity-service";

/**
 * A story seed that can be developed into an article
 */
export interface StorySeed {
  /** Unique seed identifier */
  id: string;
  /** Story headline/angle */
  headline: string;
  /** Brief description of the story */
  description: string;
  /** Editorial beat this covers */
  beat: EditorialBeat;
  /** Story type */
  type:
    | "beat"
    | "investigative"
    | "analysis"
    | "profile"
    | "breaking"
    | "opinion";
  /** Key actors/entities involved (game character IDs) */
  involvedActors: string[];
  /** Whether this could inspire a prediction market question */
  couldBecomeQuestion: boolean;
  /** Priority score 0-1 */
  priority: number;
  /** Suggested angle/take for the story */
  suggestedAngle: string;
}

/**
 * Templates for generating diverse stories
 */
const STORY_TEMPLATES: Array<{
  beat: EditorialBeat;
  type: StorySeed["type"];
  templates: string[];
}> = [
  // Tech/AI stories
  {
    beat: "ai",
    type: "analysis",
    templates: [
      "The hidden costs of AI infrastructure that no one is talking about",
      "Why the next AI breakthrough might come from an unexpected place",
      "Inside the talent war reshaping AI research labs",
      "The regulatory blind spots in current AI governance frameworks",
      "How AI is quietly transforming industries beyond tech",
    ],
  },
  {
    beat: "ai",
    type: "investigative",
    templates: [
      "Sources reveal internal tensions at major AI labs over safety protocols",
      "The lobbying machine behind AI regulation (or lack thereof)",
      "Exclusive: What AI companies are really doing with your data",
      "The race to build AI chips and who is winning",
    ],
  },
  {
    beat: "tech",
    type: "analysis",
    templates: [
      "The platform consolidation trend and what it means for startups",
      "Why Big Tech antitrust cases keep failing",
      "The death of the freemium model and what replaces it",
      "Remote work is reshaping tech hubs in unexpected ways",
      "The infrastructure bottleneck holding back innovation",
    ],
  },
  {
    beat: "tech",
    type: "opinion",
    templates: [
      "We are thinking about tech monopolies all wrong",
      "The case for (and against) breaking up Big Tech",
      "Why founder-led companies outperform (or do they?)",
      "The myth of the 10x engineer",
    ],
  },

  // Finance/Markets stories
  {
    beat: "finance",
    type: "analysis",
    templates: [
      "The Fed signals that markets are misreading completely",
      "Why institutional investors are quietly repositioning",
      "The liquidity crisis no one is preparing for",
      "Bond market vs equity market: who is right?",
      "The real story behind recent market volatility",
    ],
  },
  {
    beat: "markets",
    type: "investigative",
    templates: [
      "Inside the trading strategies dominating this market",
      "The arbitrage opportunities hiding in plain sight",
      "How high-frequency traders are adapting to new regulations",
      "The concentrated bets driving market moves",
    ],
  },
  {
    beat: "finance",
    type: "opinion",
    templates: [
      "Why traditional valuation metrics are becoming obsolete",
      "The case for rethinking portfolio diversification",
      "What the smart money is getting wrong",
      "Is passive investing creating systemic risks?",
    ],
  },

  // Politics/Regulation stories
  {
    beat: "politics",
    type: "analysis",
    templates: [
      "The policy battles that will define tech for a decade",
      "Why both parties are getting tech regulation wrong",
      "The lobbying dollars reshaping tech policy",
      "International tech policy divergence and its consequences",
    ],
  },
  {
    beat: "regulation",
    type: "investigative",
    templates: [
      "The revolving door between regulators and tech companies",
      "How companies are preparing for potential breakups",
      "The enforcement actions that could reshape industries",
      "Inside the legal strategies of targeted tech giants",
    ],
  },

  // Business/Startups stories
  {
    beat: "startups",
    type: "analysis",
    templates: [
      "The funding winter is changing what VCs want",
      "Why profitability is the new growth",
      "The startup categories attracting serious capital now",
      "Bridge rounds and down rounds: the new normal",
      "What YC acceptance rates tell us about the startup ecosystem",
    ],
  },
  {
    beat: "business",
    type: "investigative",
    templates: [
      "The real unit economics of hyped startups",
      "Why certain unicorns are struggling to exit",
      "The talent exodus from Big Tech to startups (and back)",
      "Corporate venture arms: strategic or just FOMO?",
    ],
  },

  // Culture/Media stories
  {
    beat: "culture",
    type: "analysis",
    templates: [
      "The creator economy is consolidating faster than expected",
      "Why algorithm changes are reshaping online culture",
      "The attention economy is hitting its limits",
      "How streaming wars are changing content forever",
    ],
  },
  {
    beat: "media",
    type: "opinion",
    templates: [
      "The future of journalism in an AI-saturated world",
      "Why traditional media keeps missing the story",
      "The fragmentation of truth and what it means",
      "Social media as infrastructure: who should control it?",
    ],
  },
];

/**
 * Story Seed Service
 *
 * Generates diverse story ideas for news outlets to cover,
 * breaking the dependence on prediction market questions.
 */
export class StorySeedService {
  /** LLM client for future use in LLM-powered story generation */
  public readonly llm: FeedLLMClient;

  constructor(llm: FeedLLMClient) {
    this.llm = llm;
  }

  /**
   * Generate a story seed for a specific editorial beat
   *
   * @param orgId - Organization ID requesting the story
   * @param beat - Editorial beat to cover
   * @returns Story seed with headline and context
   */
  async generateBeatStory(
    orgId: string,
    beat?: EditorialBeat,
  ): Promise<StorySeed> {
    // Use org's beats if no specific beat provided
    const orgBeats = ORGANIZATION_BEATS[orgId] || ["tech", "business"];
    const targetBeat =
      beat || orgBeats[Math.floor(Math.random() * orgBeats.length)] || "tech";

    // Check topic diversity - prefer underrepresented beats
    const diversityService = getTopicDiversityService();
    const suggestions = await diversityService.suggestDiverseTopics(3);

    // If we have underrepresented beats, bias toward them
    let finalBeat = targetBeat;
    if (suggestions.length > 0 && Math.random() < 0.4) {
      // 40% chance to use underrepresented beat
      const underrep = suggestions.find((s) => orgBeats.includes(s.beat));
      if (underrep) {
        finalBeat = underrep.beat;
      }
    }

    // Find templates for this beat
    const beatTemplates = STORY_TEMPLATES.filter((t) => t.beat === finalBeat);
    if (beatTemplates.length === 0) {
      // Fallback to any template
      const fallback =
        STORY_TEMPLATES[Math.floor(Math.random() * STORY_TEMPLATES.length)];
      return this.templateToSeed(fallback!, orgId);
    }

    // Pick a random template set and story
    const templateSet =
      beatTemplates[Math.floor(Math.random() * beatTemplates.length)]!;

    return this.templateToSeed(templateSet, orgId);
  }

  /**
   * Convert a template to a story seed
   */
  private templateToSeed(
    templateSet: (typeof STORY_TEMPLATES)[number],
    orgId: string,
  ): StorySeed {
    const headline =
      templateSet.templates[
        Math.floor(Math.random() * templateSet.templates.length)
      ] || "Breaking developments in the industry";

    // Find relevant actors for this beat
    const actors = StaticDataRegistry.getAllActors();
    const relevantActors = actors
      .filter((a) => {
        const domain = Array.isArray(a.domain) ? a.domain : [a.domain];
        return domain.some((d) => d?.toLowerCase().includes(templateSet.beat));
      })
      .slice(0, 3)
      .map((a) => a.id);

    return {
      id: `seed-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      headline,
      description: `${templateSet.type.charAt(0).toUpperCase() + templateSet.type.slice(1)} piece on ${templateSet.beat}`,
      beat: templateSet.beat,
      type: templateSet.type,
      involvedActors: relevantActors,
      couldBecomeQuestion: templateSet.type === "investigative",
      priority: Math.random() * 0.5 + 0.5, // 0.5-1.0
      suggestedAngle: this.getSuggestedAngle(templateSet.beat, orgId),
    };
  }

  /**
   * Get a suggested angle based on org personality
   */
  private getSuggestedAngle(beat: EditorialBeat, orgId: string): string {
    // Different outlets have different perspectives
    const orgAngles: Record<string, Record<EditorialBeat, string>> = {
      bloombairg: {
        tech: "Focus on market implications and institutional investor perspective",
        finance: "Terminal-first analysis with emphasis on data",
        politics: "How policy affects markets and wealth",
        crypto: "Institutional adoption angle",
        ai: "Enterprise AI and productivity gains",
        culture: "Business of entertainment and media",
        business: "Corporate strategy and M&A",
        science: "Commercial applications of research",
        regulation: "Compliance costs and market impact",
        markets: "Technical analysis and flow data",
        startups: "Unicorn valuations and exit potential",
        media: "Media companies as investments",
      },
      techcrainch: {
        tech: "Startup ecosystem and founder stories",
        finance: "VC funding and startup valuations",
        politics: "Impact on startup ecosystem",
        crypto: "Web3 startups and founder profiles",
        ai: "AI startup funding and product launches",
        culture: "Creator economy startups",
        business: "Startup growth strategies",
        science: "Deep tech startups",
        regulation: "Impact on startup formation",
        markets: "Startup liquidity events",
        startups: "Funding rounds and pivots",
        media: "Media tech startups",
      },
      politaico: {
        tech: "Policy and lobbying angles",
        finance: "Political implications of economic data",
        politics: "Inside baseball and horse race coverage",
        crypto: "Regulatory battles and political money",
        ai: "AI policy and political positioning",
        culture: "Culture war angles",
        business: "Corporate political donations",
        science: "Research funding politics",
        regulation: "Regulatory process and key players",
        markets: "Economic policy impact",
        startups: "Political connections of founders",
        media: "Media power dynamics",
      },
    };

    const defaultAngle = `Balanced coverage with focus on implications for ${beat} sector`;
    return orgAngles[orgId]?.[beat] || defaultAngle;
  }

  /**
   * Generate multiple diverse story seeds
   *
   * @param count - Number of seeds to generate
   * @param excludeBeats - Beats to exclude
   * @returns Array of diverse story seeds
   */
  async generateDiverseStories(
    count: number,
    excludeBeats: EditorialBeat[] = [],
  ): Promise<StorySeed[]> {
    const seeds: StorySeed[] = [];
    const usedBeats = new Set<EditorialBeat>();
    const usedTypes = new Set<string>();

    // Get underrepresented beats from diversity service
    const diversityService = getTopicDiversityService();
    const suggestions = await diversityService.suggestDiverseTopics(count);

    // Prioritize underrepresented beats
    for (const suggestion of suggestions) {
      if (seeds.length >= count) break;
      if (excludeBeats.includes(suggestion.beat)) continue;
      if (usedBeats.has(suggestion.beat) && seeds.length > 3) continue;

      const template = STORY_TEMPLATES.find(
        (t) => t.beat === suggestion.beat && !usedTypes.has(t.type),
      );
      if (template) {
        seeds.push(this.templateToSeed(template, "generic"));
        usedBeats.add(suggestion.beat);
        usedTypes.add(template.type);
      }
    }

    // Fill remaining with random diverse picks
    while (seeds.length < count) {
      const availableTemplates = STORY_TEMPLATES.filter(
        (t) =>
          !excludeBeats.includes(t.beat) &&
          (!usedBeats.has(t.beat) || seeds.length > count / 2),
      );

      if (availableTemplates.length === 0) break;

      const template =
        availableTemplates[
          Math.floor(Math.random() * availableTemplates.length)
        ]!;
      seeds.push(this.templateToSeed(template, "generic"));
      usedBeats.add(template.beat);
      usedTypes.add(template.type);
    }

    return seeds;
  }

  /**
   * Generate a profile story about a specific actor
   *
   * @param actorId - Actor to profile
   * @returns Story seed focused on the actor
   */
  async generateProfileStory(actorId: string): Promise<StorySeed | null> {
    const actor = StaticDataRegistry.getActor(actorId);
    if (!actor) {
      logger.warn(
        "Actor not found for profile story",
        { actorId },
        "StorySeedService",
      );
      return null;
    }

    const domain = Array.isArray(actor.domain) ? actor.domain[0] : actor.domain;
    const beat = this.domainToBeat(domain || "tech");

    return {
      id: `profile-${actorId}-${Date.now()}`,
      headline: `Profile: ${actor.name} and their impact on ${domain || "the industry"}`,
      description: `In-depth look at ${actor.name}'s trajectory and influence`,
      beat,
      type: "profile",
      involvedActors: [actorId],
      couldBecomeQuestion: false,
      priority: 0.7,
      suggestedAngle: `Focus on recent activities and industry influence`,
    };
  }

  /**
   * Convert a domain to an editorial beat
   */
  private domainToBeat(domain: string): EditorialBeat {
    const domainLower = domain.toLowerCase();
    if (domainLower.includes("crypto") || domainLower.includes("web3"))
      return "crypto";
    if (domainLower.includes("ai") || domainLower.includes("ml")) return "ai";
    if (domainLower.includes("politic")) return "politics";
    if (domainLower.includes("financ") || domainLower.includes("invest"))
      return "finance";
    if (domainLower.includes("media")) return "media";
    if (domainLower.includes("startup")) return "startups";
    return "tech";
  }

  /**
   * Generate a breaking news story seed (simulated event)
   *
   * @returns Breaking news story seed
   */
  async generateBreakingStory(): Promise<StorySeed> {
    const breakingTemplates = [
      {
        beat: "tech" as EditorialBeat,
        headline: "Major tech company announces surprise leadership change",
      },
      {
        beat: "finance" as EditorialBeat,
        headline: "Markets react to unexpected economic data release",
      },
      {
        beat: "regulation" as EditorialBeat,
        headline: "Regulators announce new enforcement action",
      },
      {
        beat: "ai" as EditorialBeat,
        headline: "AI lab unveils capability that raises new questions",
      },
      {
        beat: "politics" as EditorialBeat,
        headline: "Key policy vote approaches with uncertain outcome",
      },
    ];

    const template =
      breakingTemplates[Math.floor(Math.random() * breakingTemplates.length)]!;

    return {
      id: `breaking-${Date.now()}`,
      headline: template.headline,
      description: "Breaking news requiring immediate coverage",
      beat: template.beat,
      type: "breaking",
      involvedActors: [],
      couldBecomeQuestion: true,
      priority: 1.0, // Breaking news is always high priority
      suggestedAngle: "Fast, factual reporting with expert reaction quotes",
    };
  }
}

// Singleton instance
let storySeedServiceInstance: StorySeedService | null = null;

/**
 * Get the singleton StorySeedService instance
 */
export function getStorySeedService(llm: FeedLLMClient): StorySeedService {
  if (!storySeedServiceInstance) {
    storySeedServiceInstance = new StorySeedService(llm);
  }
  return storySeedServiceInstance;
}

/**
 * Reset the singleton (for testing)
 */
export function resetStorySeedService(): void {
  storySeedServiceInstance = null;
}
