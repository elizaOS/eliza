/**
 * Scenario Matchmaker
 *
 * Pairs red team (scammer) agents with blue team (victim) agents for scam
 * defense training. Ensures diverse attack coverage by tracking which
 * pairs have interacted and which attack types each agent has seen.
 *
 * Usage:
 *   const matchmaker = new ScenarioMatchmaker();
 *   await matchmaker.loadActors();
 *   const pairings = matchmaker.generatePairings(5);
 *   // → [{ attacker: 'chad-sterling', defender: 'iris-chen', scenarioType: 'social-engineering' }, ...]
 */

import { logger } from "@feed/shared";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type Team = "red" | "blue" | "gray";
export type ScamProfile = "scammer" | "manipulator" | "naive" | "wary";
export type AttackCategory =
  | "prompt-injection"
  | "social-engineering"
  | "secret-exfiltration"
  | "credential-theft"
  | "impersonation"
  | "research-assisted"
  | "advance-fee-fraud";

export interface ActorProfile {
  id: string;
  name: string;
  team: Team;
  alignment: "good" | "evil" | "neutral";
  scamProfile: ScamProfile;
  competence: "high" | "mid" | "low";
}

export interface Pairing {
  attacker: ActorProfile;
  defender: ActorProfile;
  scenarioType: AttackCategory;
  difficulty: number; // 1-7
  channel: "dm" | "group-chat" | "support-ticket";
}

// ---------------------------------------------------------------------------
// Interaction tracking
// ---------------------------------------------------------------------------

interface InteractionRecord {
  attackerId: string;
  defenderId: string;
  scenarioType: AttackCategory;
  timestamp: number;
  defenderWon: boolean;
}

// ---------------------------------------------------------------------------
// Matchmaker
// ---------------------------------------------------------------------------

const ALL_ATTACK_CATEGORIES: AttackCategory[] = [
  "prompt-injection",
  "social-engineering",
  "secret-exfiltration",
  "credential-theft",
  "impersonation",
  "research-assisted",
  "advance-fee-fraud",
];

const CHANNELS = ["dm", "group-chat", "support-ticket"] as const;

export class ScenarioMatchmaker {
  private attackers: ActorProfile[] = [];
  private defenders: ActorProfile[] = [];
  private history: InteractionRecord[] = [];
  private pairCounts: Map<string, number> = new Map(); // "attacker:defender" → count
  private defenderAttackExposure: Map<string, Set<AttackCategory>> = new Map();
  private defenderDifficultyFrontier: Map<string, number> = new Map();

  /**
   * Register actors from a character pack.
   */
  registerActors(actors: ActorProfile[]): void {
    for (const actor of actors) {
      if (actor.team === "red" || actor.alignment === "evil") {
        this.attackers.push(actor);
      } else {
        this.defenders.push(actor);
      }
    }
    logger.info(
      `Matchmaker: ${this.attackers.length} attackers, ${this.defenders.length} defenders`,
    );
  }

  /**
   * Generate N pairings with maximum diversity.
   *
   * Strategy:
   * 1. For each defender, pick the attack category they've seen least
   * 2. Pick the attacker who has interacted least with this defender
   * 3. Set difficulty based on defender's performance history
   */
  generatePairings(count: number): Pairing[] {
    if (this.attackers.length === 0 || this.defenders.length === 0) {
      logger.warn("Matchmaker: no attackers or defenders registered");
      return [];
    }

    const pairings: Pairing[] = [];

    // Shuffle defenders for variety each round
    const shuffledDefenders = [...this.defenders].sort(
      () => Math.random() - 0.5,
    );

    for (let i = 0; i < count; i++) {
      const defender = shuffledDefenders[i % shuffledDefenders.length]!;

      // 1. Find least-seen attack category for this defender
      const exposure =
        this.defenderAttackExposure.get(defender.id) ?? new Set();
      const unseenCategories = ALL_ATTACK_CATEGORIES.filter(
        (c) => !exposure.has(c),
      );
      const scenarioType =
        unseenCategories.length > 0
          ? unseenCategories[
              Math.floor(Math.random() * unseenCategories.length)
            ]!
          : ALL_ATTACK_CATEGORIES[
              Math.floor(Math.random() * ALL_ATTACK_CATEGORIES.length)
            ]!;

      // 2. Find attacker with least interaction with this defender
      const attacker = this.pickLeastInteractedAttacker(defender.id);

      // 3. Determine difficulty based on defender's frontier
      const baseDifficulty =
        this.defenderDifficultyFrontier.get(defender.id) ?? 1;
      const difficulty = Math.min(7, baseDifficulty);

      // 4. Pick channel
      const channel = CHANNELS[i % CHANNELS.length]!;

      pairings.push({
        attacker,
        defender,
        scenarioType,
        difficulty,
        channel,
      });
    }

    return pairings;
  }

  /**
   * Record the outcome of an interaction.
   */
  recordOutcome(
    attackerId: string,
    defenderId: string,
    scenarioType: AttackCategory,
    defenderWon: boolean,
  ): void {
    this.history.push({
      attackerId,
      defenderId,
      scenarioType,
      timestamp: Date.now(),
      defenderWon,
    });

    // Update pair count
    const key = `${attackerId}:${defenderId}`;
    this.pairCounts.set(key, (this.pairCounts.get(key) ?? 0) + 1);

    // Update defender attack exposure
    if (!this.defenderAttackExposure.has(defenderId)) {
      this.defenderAttackExposure.set(defenderId, new Set());
    }
    this.defenderAttackExposure.get(defenderId)?.add(scenarioType);

    // Update difficulty frontier: advance if defender won, hold if lost
    const current = this.defenderDifficultyFrontier.get(defenderId) ?? 1;
    if (defenderWon) {
      this.defenderDifficultyFrontier.set(defenderId, Math.min(7, current + 1));
    }
    // Don't decrease on loss — maintain difficulty floor
  }

  /**
   * Get interaction stats for reporting.
   */
  getStats(): {
    totalInteractions: number;
    pairsUsed: number;
    avgDifficulty: number;
    categoryDistribution: Record<string, number>;
    defenderWinRate: number;
  } {
    const categoryDist: Record<string, number> = {};
    let wins = 0;

    for (const record of this.history) {
      categoryDist[record.scenarioType] =
        (categoryDist[record.scenarioType] ?? 0) + 1;
      if (record.defenderWon) wins++;
    }

    const difficulties = Array.from(this.defenderDifficultyFrontier.values());
    const avgDiff =
      difficulties.length > 0
        ? difficulties.reduce((a, b) => a + b, 0) / difficulties.length
        : 1;

    return {
      totalInteractions: this.history.length,
      pairsUsed: this.pairCounts.size,
      avgDifficulty: avgDiff,
      categoryDistribution: categoryDist,
      defenderWinRate: this.history.length > 0 ? wins / this.history.length : 0,
    };
  }

  private pickLeastInteractedAttacker(defenderId: string): ActorProfile {
    let minCount = Infinity;
    let best = this.attackers[0]!;

    for (const attacker of this.attackers) {
      const key = `${attacker.id}:${defenderId}`;
      const count = this.pairCounts.get(key) ?? 0;
      if (count < minCount) {
        minCount = count;
        best = attacker;
      }
    }

    return best;
  }
}

export const scenarioMatchmaker = new ScenarioMatchmaker();
