/**
 * NPC Persona Generator
 *
 * @module services/npc-persona-generator
 *
 * @description
 * Assigns consistent behavioral personas to NPCs to enable learnability.
 * Creates reliable patterns that agents can learn over time.
 *
 * **Key Responsibilities:**
 * - Assign reliability scores (truthfulness 0-1)
 * - Identify insiders with privileged information
 * - Mark deceivers who spread misinformation
 * - Define self-interest motivations
 * - Establish biases (favors/opposes)
 *
 * **Persona Types:**
 * - **Insiders** (0.7-0.9 reliability): Have insider knowledge about affiliated orgs
 * - **Experts** (0.6-0.8 reliability): Domain specialists, no insider access
 * - **Journalists** (0.5-0.7 reliability): Sometimes get bad sources
 * - **Politicians** (0.2-0.4 reliability): Lie for self-interest
 * - **Conspiracy theorists** (0.1-0.3 reliability): Spread misinformation
 *
 * **Why This Matters:**
 * Agents need consistent NPC personas to learn patterns:
 * - "Alice (insider at TechCorp, reliability 0.85) → Trust her TechCorp posts"
 * - "Bob (politician, reliability 0.3) → Verify his claims with other sources"
 * - "Carol (conspiracy theorist, reliability 0.15) → Discount/ignore"
 *
 * @example
 * ```typescript
 * const generator = new NPCPersonaGenerator();
 * const personas = generator.assignPersonas(actors, organizations);
 *
 * // Use persona to validate behavior
 * const alice = personas.get('alice');
 * console.log(`Alice reliability: ${alice.reliability}`);
 * console.log(`Alice has insider info about: ${alice.insiderOrgs.join(', ')}`);
 * ```
 */

import { logger } from "@feed/shared";
import { correlations } from "../data/organization-correlations";
import type { Actor, Organization } from "../types";
import { type RngFunction, randomChance } from "../utils/randomization";

/**
 * NPC Persona Assignment
 *
 * @interface PersonaAssignment
 *
 * @description
 * Complete persona definition for an NPC that determines their behavior,
 * information access, and reliability throughout the game.
 *
 * @property actorId - Actor ID this persona applies to
 * @property reliability - 0-1, how often this NPC tells the truth
 * @property insiderOrgs - Organization IDs they have insider knowledge about
 * @property expertise - Domain expertise areas
 * @property willingToLie - Whether this NPC will strategically deceive
 * @property selfInterest - Primary motivation (wealth, reputation, ideology, chaos)
 * @property favorsActors - Actor IDs they favor (will defend)
 * @property opposesActors - Actor IDs they oppose (will criticize)
 * @property favorsOrgs - Org IDs they favor (biased toward)
 * @property opposesOrgs - Org IDs they oppose (biased against)
 */
export interface PersonaAssignment {
  actorId: string;
  reliability: number;
  insiderOrgs: string[];
  expertise: string[];
  willingToLie: boolean;
  selfInterest: "wealth" | "reputation" | "ideology" | "chaos";
  favorsActors: string[];
  opposesActors: string[];
  favorsOrgs: string[];
  opposesOrgs: string[];
}

/**
 * NPC Persona Generator
 *
 * @class NPCPersonaGenerator
 *
 * @description
 * Generates consistent behavioral personas for all NPCs in the game.
 * Ensures NPCs maintain reliable patterns that agents can learn.
 *
 * **Distribution Strategy:**
 * - ~20% high reliability (0.7-0.9): Insiders and experts
 * - ~50% medium reliability (0.4-0.7): Journalists and analysts
 * - ~30% low reliability (0.1-0.4): Politicians and conspiracy theorists
 *
 * **Insider Detection:**
 * - NPCs with org affiliations get insider knowledge
 * - Reliability increased to 0.7+ for insiders
 * - Can access non-public information about their orgs
 *
 * @usage
 * Called once during game setup to assign all NPC personas.
 *
 * @example
 * ```typescript
 * const generator = new NPCPersonaGenerator();
 * const personas = generator.assignPersonas(actors, organizations);
 *
 * feedGenerator.setNPCPersonas(personas);
 * ```
 */
export class NPCPersonaGenerator {
  /**
   * Lazy-initialized competitor lookup map.
   * Maps org ID -> Set of competitor org IDs (bidirectional).
   */
  private competitorMap: Map<string, Set<string>> | null = null;

  /**
   * Get or build the competitor map from correlations data.
   * Built once on first access, then cached.
   */
  private getCompetitorMap(): Map<string, Set<string>> {
    if (this.competitorMap) return this.competitorMap;

    this.competitorMap = new Map<string, Set<string>>();

    for (const c of correlations) {
      if (c.relationship !== "competitor") continue;

      // Add primary -> related
      if (!this.competitorMap.has(c.primary)) {
        this.competitorMap.set(c.primary, new Set());
      }
      this.competitorMap.get(c.primary)?.add(c.related);

      // Add related -> primary (bidirectional)
      if (!this.competitorMap.has(c.related)) {
        this.competitorMap.set(c.related, new Set());
      }
      this.competitorMap.get(c.related)?.add(c.primary);
    }

    return this.competitorMap;
  }

  /**
   * Invalidate the competitor map cache.
   * Call this if correlations data changes at runtime.
   */
  invalidateCompetitorCache(): void {
    this.competitorMap = null;
  }

  /**
   * Assign personas to all actors
   *
   * @param actors - All game actors
   * @param organizations - All game organizations
   * @param rng - Optional random number generator (defaults to Math.random)
   * @returns Map of actorId → persona assignment
   *
   * @description
   * Analyzes each actor's profile and generates an appropriate persona.
   * Considers role, tier, affiliations, domain, and personality traits.
   *
   * **Reliability Factors:**
   * - Insiders: 0.7-0.9 (high)
   * - Domain experts: 0.6-0.8 (medium-high)
   * - Journalists: 0.5-0.7 (medium)
   * - Politicians: 0.2-0.4 (low)
   * - Conspiracy theorists: 0.1-0.3 (very low)
   *
   * **Insider Assignment:**
   * - If actor.affiliations exists → insider for those orgs
   * - Reliability boosted to min 0.7
   * - Can access insider information
   *
   * @example
   * ```typescript
   * const personas = generator.assignPersonas(actors, orgs);
   *
   * // Check distribution
   * const avgReliability = calculateAvg(personas);
   * const insiders = countInsiders(personas);
   * const liars = countLiars(personas);
   * ```
   */
  assignPersonas(
    actors: Actor[],
    organizations: Organization[],
    rng: RngFunction = Math.random,
  ): Map<string, PersonaAssignment> {
    const personas = new Map<string, PersonaAssignment>();

    for (const actor of actors) {
      const persona = this.generatePersonaForActor(
        actor,
        actors,
        organizations,
        rng,
      );
      personas.set(actor.id, persona);
    }

    // Validate distribution makes sense
    this.validatePersonaDistribution(personas);

    logger.info(
      `Generated personas for ${personas.size} NPCs`,
      {
        avgReliability: this.calculateAvgReliability(personas),
        insiders: this.countInsiders(personas),
        liars: this.countLiars(personas),
      },
      "NPCPersonaGenerator",
    );

    return personas;
  }

  /**
   * Generate persona for a single actor
   */
  private generatePersonaForActor(
    actor: Actor,
    allActors: Actor[],
    organizations: Organization[],
    rng: RngFunction,
  ): PersonaAssignment {
    // Determine base reliability from role/personality/domain
    let baseReliability = 0.5;
    let willingToLie = false;
    let selfInterest: "wealth" | "reputation" | "ideology" | "chaos" =
      "reputation";

    // Conspiracy theorists and contrarians: Very low reliability
    if (
      actor.personality?.includes("contrarian") ||
      actor.personality?.includes("conspiracy") ||
      actor.description?.toLowerCase().includes("conspiracy")
    ) {
      baseReliability = 0.15 + rng() * 0.15; // 0.15-0.30
      willingToLie = true;
      selfInterest = "chaos";
    }
    // Politicians: Low reliability, willing to lie
    else if (
      actor.domain?.includes("politics") ||
      actor.description?.toLowerCase().includes("politician") ||
      actor.role === "politician"
    ) {
      baseReliability = 0.25 + rng() * 0.15; // 0.25-0.40
      willingToLie = true;
      selfInterest = "reputation";
    }
    // Journalists: Medium reliability
    else if (
      actor.domain?.includes("media") ||
      actor.domain?.includes("journalism") ||
      actor.role === "journalist"
    ) {
      baseReliability = 0.55 + rng() * 0.15; // 0.55-0.70
      willingToLie = false;
      selfInterest = "reputation";
    }
    // Finance/Tech experts: Medium-high reliability, sometimes willing to lie
    else if (
      actor.domain?.includes("finance") ||
      actor.domain?.includes("tech") ||
      actor.role === "expert"
    ) {
      baseReliability = 0.6 + rng() * 0.2; // 0.60-0.80
      willingToLie = randomChance(0.3, rng); // 30% willing to lie for profit
      selfInterest = "wealth";
    }
    // Everyone else: Medium reliability
    else {
      baseReliability = 0.5 + rng() * 0.2; // 0.50-0.70
      willingToLie = randomChance(0.2, rng); // 20% willing to lie
      selfInterest = randomChance(0.5, rng) ? "reputation" : "wealth";
    }

    // Insiders get higher reliability about their orgs
    const insiderOrgs = actor.affiliations || [];
    if (insiderOrgs.length > 0) {
      baseReliability = Math.max(baseReliability, 0.7); // Insiders minimum 0.7
    }

    // Expertise from domain
    const expertise = actor.domain || [];

    // Determine favors/opposes from affiliations
    const favorsOrgs = insiderOrgs;

    // Find competitor orgs from correlations data
    const opposesOrgs = this.findCompetitorOrgs(insiderOrgs, organizations);

    // Find actors with shared affiliations (colleagues = allies)
    const favorsActors = this.findActorsWithSharedAffiliations(
      actor,
      allActors,
      insiderOrgs,
    );

    // Find actors from competing organizations (rivals)
    const opposesActors = this.findActorsFromCompetingOrgs(
      actor,
      allActors,
      opposesOrgs,
    );

    return {
      actorId: actor.id,
      reliability: baseReliability,
      insiderOrgs,
      expertise,
      willingToLie,
      selfInterest,
      favorsActors,
      opposesActors,
      favorsOrgs,
      opposesOrgs,
    };
  }

  /**
   * Validate persona distribution makes sense
   *
   * @description
   * Ensures the generated personas have a good distribution across
   * reliability levels. Warns if distribution seems unusual.
   *
   * **Expected Distribution:**
   * - Average reliability: 0.45-0.65 (balanced)
   * - High reliability (>0.7): 20-30%
   * - Low reliability (<0.4): 20-30%
   * - Medium reliability: 40-60%
   */
  private validatePersonaDistribution(
    personas: Map<string, PersonaAssignment>,
  ): void {
    const reliabilities = Array.from(personas.values()).map(
      (p) => p.reliability,
    );

    const avgReliability =
      reliabilities.reduce((a, b) => a + b, 0) / reliabilities.length;
    const insiders = Array.from(personas.values()).filter(
      (p) => p.insiderOrgs.length > 0,
    );
    const liars = Array.from(personas.values()).filter((p) => p.willingToLie);
    const highReliability = reliabilities.filter((r) => r > 0.7).length;
    const lowReliability = reliabilities.filter((r) => r < 0.4).length;

    logger.info(
      "Persona distribution",
      {
        total: personas.size,
        avgReliability: avgReliability.toFixed(2),
        insiders: insiders.length,
        liars: liars.length,
        highReliability,
        lowReliability,
        mediumReliability: personas.size - highReliability - lowReliability,
      },
      "NPCPersonaGenerator",
    );

    // Warn if distribution is unusual
    if (avgReliability < 0.4 || avgReliability > 0.7) {
      logger.warn(
        "Unusual reliability distribution",
        {
          avgReliability,
          expected: "0.45-0.65",
        },
        "NPCPersonaGenerator",
      );
    }

    if (insiders.length === 0 && personas.size > 10) {
      logger.warn(
        "No insiders detected - game may lack insider advantage",
        {
          totalNPCs: personas.size,
        },
        "NPCPersonaGenerator",
      );
    }
  }

  /**
   * Calculate average reliability across all personas
   */
  private calculateAvgReliability(
    personas: Map<string, PersonaAssignment>,
  ): number {
    const reliabilities = Array.from(personas.values()).map(
      (p) => p.reliability,
    );
    return reliabilities.reduce((a, b) => a + b, 0) / reliabilities.length;
  }

  /**
   * Count number of insiders
   */
  private countInsiders(personas: Map<string, PersonaAssignment>): number {
    return Array.from(personas.values()).filter((p) => p.insiderOrgs.length > 0)
      .length;
  }

  /**
   * Count number of liars (willing to deceive)
   */
  private countLiars(personas: Map<string, PersonaAssignment>): number {
    return Array.from(personas.values()).filter((p) => p.willingToLie).length;
  }

  // ===========================================================================
  // Relationship Inference Helpers
  // ===========================================================================

  /**
   * Find competitor organizations for an actor's affiliations
   *
   * Uses the precomputed competitor map for O(1) lookup per affiliation.
   *
   * @param affiliations - The actor's affiliated organization IDs
   * @param organizations - All organizations (for validation)
   * @returns Array of competitor organization IDs
   */
  private findCompetitorOrgs(
    affiliations: string[],
    organizations: Organization[],
  ): string[] {
    if (affiliations.length === 0) return [];

    const validOrgIds = new Set(organizations.map((o) => o.id));
    const competitors = new Set<string>();
    const competitorMap = this.getCompetitorMap();

    for (const affiliation of affiliations) {
      const orgCompetitors = competitorMap.get(affiliation);
      if (orgCompetitors) {
        for (const competitor of orgCompetitors) {
          // Only include valid orgs from the current game
          if (validOrgIds.has(competitor)) {
            competitors.add(competitor);
          }
        }
      }
    }

    return Array.from(competitors);
  }

  /**
   * Find actors who share affiliations with this actor (colleagues/allies)
   *
   * Actors working at the same organizations are natural allies who will
   * defend each other and share favorable views.
   *
   * @param actor - The current actor
   * @param allActors - All actors in the game
   * @param affiliations - The actor's affiliated organization IDs
   * @returns Array of allied actor IDs
   */
  private findActorsWithSharedAffiliations(
    actor: Actor,
    allActors: Actor[],
    affiliations: string[],
  ): string[] {
    if (affiliations.length === 0) return [];

    const affiliationSet = new Set(affiliations);
    const allies: string[] = [];

    for (const otherActor of allActors) {
      // Skip self
      if (otherActor.id === actor.id) continue;

      // Check if any affiliations overlap
      const otherAffiliations = otherActor.affiliations || [];
      const hasSharedAffiliation = otherAffiliations.some((a) =>
        affiliationSet.has(a),
      );

      if (hasSharedAffiliation) {
        allies.push(otherActor.id);
      }
    }

    return allies;
  }

  /**
   * Find actors from competing organizations (rivals)
   *
   * Actors working at competing organizations have natural opposition.
   * They will be skeptical of each other and may actively criticize.
   *
   * @param actor - The current actor
   * @param allActors - All actors in the game
   * @param competitorOrgs - Organization IDs that compete with this actor's orgs
   * @returns Array of rival actor IDs
   */
  private findActorsFromCompetingOrgs(
    actor: Actor,
    allActors: Actor[],
    competitorOrgs: string[],
  ): string[] {
    if (competitorOrgs.length === 0) return [];

    const competitorSet = new Set(competitorOrgs);
    const rivals: string[] = [];

    for (const otherActor of allActors) {
      // Skip self
      if (otherActor.id === actor.id) continue;

      // Check if actor works at a competitor org
      const otherAffiliations = otherActor.affiliations || [];
      const worksAtCompetitor = otherAffiliations.some((a) =>
        competitorSet.has(a),
      );

      if (worksAtCompetitor) {
        rivals.push(otherActor.id);
      }
    }

    return rivals;
  }
}
