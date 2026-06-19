/**
 * Post Intent Service
 *
 * Decides WHAT type of post an NPC should make before generating content.
 * Replaces the current approach where every NPC gets the same market-heavy
 * prompt template regardless of their domain/personality.
 *
 * Intent types:
 * - organic: Pure personality-driven post, no market data. "Just be yourself."
 * - topical: About a trending topic, filtered by domain relevance.
 * - market: Market commentary — only for finance/crypto/trading actors.
 * - social: Relationship-driven post about/directed at another NPC.
 */

import type { Actor, ActorRelationship } from "../types/shared";
import {
  getCharacterConfigOrDefault,
  shouldGenerateOrganicPost,
  shouldPostAboutTopic,
} from "./npc-character-config";
import { StaticDataRegistry } from "./static-data-registry";

/**
 * The decided intent for a single NPC post.
 */
export type PostIntent =
  | { type: "organic" }
  | { type: "topical"; topic: string }
  | { type: "market" }
  | { type: "social"; targetActorId: string; targetName: string };

/**
 * Domains that make an actor a "finance speaker" who naturally talks markets.
 */
const FINANCE_DOMAINS = new Set([
  "finance",
  "crypto",
  "trading",
  "defi",
  "nft",
  "business",
  "economics",
  "vc",
]);

/**
 * Check if an actor is a finance/market-oriented character.
 */
function isFinanceActor(actor: Pick<Actor, "domain">): boolean {
  if (!actor.domain || actor.domain.length === 0) return false;
  return actor.domain.some((d) => FINANCE_DOMAINS.has(d.toLowerCase()));
}

/**
 * Domain-specific hints for organic posts.
 * Tells the LLM what topics are in this character's world.
 */
const DOMAIN_HINTS: Record<string, string> = {
  activism: "climate, protests, policy, leaders, emissions, justice, movements",
  environment:
    "climate, carbon, renewables, sustainability, pollution, conservation",
  health:
    "protocols, supplements, sleep, biohacking, optimization, longevity, nutrition",
  longevity:
    "aging, supplements, biomarkers, sleep optimization, cellular health",
  sports:
    "games, competition, training, winning, discipline, teammates, championships",
  culture: "art, music, creativity, vision, fashion, influence, expression",
  music: "albums, production, art, creativity, concerts, sound, culture",
  entertainment: "shows, performances, celebrity, drama, media, stories",
  tech: "building, shipping, products, code, launches, breakthroughs, startups",
  ai: "models, capabilities, alignment, research, breakthroughs, compute",
  politics:
    "power, elections, policy, governance, legislation, campaigns, leadership",
  media: "stories, sources, investigations, scoops, coverage, breaking news",
  journalism: "reporting, sources, investigations, stories, truth, coverage",
  space: "rockets, launches, Mars, orbit, remotes, exploration, cosmos",
  safety: "alignment, risk, responsible AI, oversight, existential threats",
  research: "papers, studies, data, experiments, findings, breakthroughs",
  philosophy: "meaning, consciousness, existence, ethics, wisdom, truth",
  crypto:
    "bitcoin, ethereum, blockchain, decentralization, web3, tokens, protocol",
  finance:
    "markets, positions, valuations, deals, portfolios, capital, investments",
  trading:
    "positions, entries, exits, risk, leverage, setups, conviction plays",
};

/**
 * Build domain hint string from actor's domain list.
 */
export function getDomainHints(actor: Pick<Actor, "domain">): string {
  if (!actor.domain || actor.domain.length === 0) {
    return "whatever is on your mind";
  }
  const hints = actor.domain
    .map((d) => DOMAIN_HINTS[d.toLowerCase()])
    .filter(Boolean);
  if (hints.length === 0) return "whatever is on your mind";
  return hints.join(", ");
}

/**
 * Select the post intent for a given actor.
 *
 * Distribution is influenced by personality type (via shouldGenerateOrganicPost):
 * - Chaotic personalities: ~40% organic probability
 * - Provocative: ~35%
 * - Eccentric: ~30%
 * - Default: ~15%
 * - Analytical: ~10%
 * - Corporate: ~10%
 *
 * Finance actors always get a market intent floor. Non-finance actors never get market intent.
 *
 * @param actor - The actor to select intent for
 * @param trendingTopic - Current trending topic text (if any)
 * @param relationships - Actor's relationships for social intent
 * @param allActors - All actors (for social target selection)
 * @returns The selected post intent
 */
export function selectPostIntent(
  actor: Actor,
  trendingTopic: string | undefined,
  relationships: ActorRelationship[],
  allActors: Actor[],
): PostIntent {
  const isFinance = isFinanceActor(actor);

  // Use personality-based organic probability from character config
  // This respects chaotic vs analytical vs corporate personality types
  const wantsOrganic = shouldGenerateOrganicPost(actor.id);

  if (isFinance) {
    // Finance actors: mostly market-focused, with personality-driven organic breaks
    if (wantsOrganic) {
      return { type: "organic" };
    }
    // 15% topical (if topic matches their domain)
    if (Math.random() < 0.15 && trendingTopic) {
      if (shouldPostAboutTopic(actor.id, trendingTopic)) {
        return { type: "topical", topic: trendingTopic };
      }
    }
    // 20% social
    if (Math.random() < 0.25) {
      const socialTarget = pickSocialTarget(actor, relationships, allActors);
      if (socialTarget) {
        return socialTarget;
      }
    }
    // Default: market commentary
    return { type: "market" };
  }

  // Non-finance actors: personality-first, never market intent
  // Explicit probability split for the remaining (non-organic) budget:
  //   25% topical (if topic matches domain)
  //   40% social
  //   35% organic fallback
  if (wantsOrganic) {
    return { type: "organic" };
  }

  const roll = Math.random();

  // 0–0.25: topical
  if (roll < 0.25 && trendingTopic) {
    if (shouldPostAboutTopic(actor.id, trendingTopic)) {
      return { type: "topical", topic: trendingTopic };
    }
    // Topic doesn't match domain — fall through to organic
    return { type: "organic" };
  }

  // 0.25–0.65: social
  if (roll < 0.65) {
    const socialTarget = pickSocialTarget(actor, relationships, allActors);
    if (socialTarget) {
      return socialTarget;
    }
    // No social target available — fall through to organic
  }

  // 0.65–1.0 (or fallback): organic
  return { type: "organic" };
}

/**
 * Pick a social target for the actor based on relationships.
 * Prefers rivals and allies over random actors.
 */
function pickSocialTarget(
  actor: Actor,
  relationships: ActorRelationship[],
  allActors: Actor[],
): PostIntent | null {
  // Find actors this NPC has a relationship with
  const actorRelationships = relationships.filter(
    (r) => r.actor1Id === actor.id || r.actor2Id === actor.id,
  );

  // Get rivalry data from character config
  const config = getCharacterConfigOrDefault(actor.id);
  const rivalIds = new Set(config.rivals);

  // Also check persona for favored/opposed actors
  const favoredIds = new Set(actor.persona?.favorsActors ?? []);
  const opposedIds = new Set(actor.persona?.opposesActors ?? []);

  // Build weighted candidate list
  const candidates: Array<{ actorId: string; weight: number }> = [];

  // Rivals get highest weight
  for (const rivalId of rivalIds) {
    if (rivalId !== actor.id) {
      candidates.push({ actorId: rivalId, weight: 5 });
    }
  }

  // Opposed actors next
  for (const opposedId of opposedIds) {
    if (opposedId !== actor.id && !rivalIds.has(opposedId)) {
      candidates.push({ actorId: opposedId, weight: 4 });
    }
  }

  // Favored actors (allies)
  for (const favoredId of favoredIds) {
    if (favoredId !== actor.id) {
      candidates.push({ actorId: favoredId, weight: 3 });
    }
  }

  // Relationship-based targets
  for (const rel of actorRelationships) {
    const otherId = rel.actor1Id === actor.id ? rel.actor2Id : rel.actor1Id;
    if (
      otherId !== actor.id &&
      !rivalIds.has(otherId) &&
      !favoredIds.has(otherId) &&
      !opposedIds.has(otherId)
    ) {
      const sentiment = typeof rel.sentiment === "number" ? rel.sentiment : 0;
      // Strong sentiment (positive or negative) = more interesting interaction
      const weight = 1 + Math.abs(sentiment) * 2;
      candidates.push({ actorId: otherId, weight });
    }
  }

  // If no relationship-based candidates, pick a random actor
  if (candidates.length === 0) {
    const otherActors = allActors.filter((a) => a.id !== actor.id);
    if (otherActors.length === 0) return null;
    const randomTarget =
      otherActors[Math.floor(Math.random() * otherActors.length)];
    if (!randomTarget) return null;
    return {
      type: "social",
      targetActorId: randomTarget.id,
      targetName: randomTarget.name,
    };
  }

  // Weighted random selection
  const totalWeight = candidates.reduce((sum, c) => sum + c.weight, 0);
  let roll = Math.random() * totalWeight;
  for (const candidate of candidates) {
    roll -= candidate.weight;
    if (roll <= 0) {
      const targetActor =
        StaticDataRegistry.getActor(candidate.actorId) ??
        allActors.find((a) => a.id === candidate.actorId);
      if (!targetActor) continue;
      return {
        type: "social",
        targetActorId: candidate.actorId,
        targetName: targetActor.name,
      };
    }
  }

  // Fallback — pick first candidate
  const firstCandidate = candidates[0];
  if (!firstCandidate) return null;
  const fallbackTarget =
    StaticDataRegistry.getActor(firstCandidate.actorId) ??
    allActors.find((a) => a.id === firstCandidate.actorId);
  if (!fallbackTarget) return null;
  return {
    type: "social",
    targetActorId: firstCandidate.actorId,
    targetName: fallbackTarget.name,
  };
}

/**
 * Build domain-specific context for organic posts.
 * Returns a short framing of the actor's domain focus areas — no fake
 * current-events claims. Actual current context comes from realityGrounding
 * and world-context which are populated from real data sources.
 */
export function getDomainContext(actor: Pick<Actor, "domain">): string {
  if (!actor.domain || actor.domain.length === 0) return "";
  const hints = getDomainHints(actor);
  if (hints === "whatever is on your mind") return "";
  return `YOUR DOMAIN FOCUS: ${hints}`;
}
