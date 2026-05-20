/**
 * Timeframe Arc Planner
 *
 * @module services/timeframe-arc-planner
 *
 * @description
 * Creates compressed narrative arc plans for prediction markets with different
 * timeframes. Adapts the standard 30-day arc structure to work with markets
 * ranging from 15 minutes to 3 days.
 *
 * **Arc Compression Strategy:**
 * - Flash (15-30 min): No arc phases, immediate live trading
 * - Intraday (1-6 hours): 2 phases (active, climax)
 * - Daily (12-48 hours): 3 phases (setup, peak, resolution)
 * - Weekly (2-7 days): 4 phases (early, middle, late, climax)
 *
 * **Why Compressed Arcs:**
 * Short-timeframe markets don't have enough time for full 4-phase arcs.
 * Instead, we compress the signal distribution to fit the available time
 * while maintaining the core principle: uncertainty early, clarity late.
 */

import { logger } from '@feed/shared';
import type { Actor, Organization } from '../types';
import { shuffleArray } from '../utils/randomization';
import type { RngFunction } from './narrative-state-service';

/**
 * Timeframe categories for arc planning
 */
export type TimeframeCategory = 'flash' | 'intraday' | 'daily' | 'weekly';

/**
 * Phase targets for compressed arcs
 */
export interface CompressedPhaseTargets {
  /** Percentage of total time this phase takes (0-1) */
  timeRatio: number;
  /** Target correct signal ratio (0-1) */
  correctSignalRatio: number;
  /** Clue strength range [min, max] */
  clueStrength: [number, number];
}

/**
 * Compressed arc plan for short-timeframe markets
 */
export interface TimeframeArcPlan {
  questionId: string;
  timeframe: string;
  category: TimeframeCategory;
  outcome: boolean;
  durationMs: number;

  /** Phase configuration for this timeframe */
  phases: Record<string, CompressedPhaseTargets>;

  /** Phase order for iteration */
  phaseOrder: string[];

  /** Insider actor IDs (know the truth) */
  insiders: string[];

  /** Deceiver actor IDs (spread misinformation) */
  deceivers: string[];

  /** Affiliated organization IDs */
  affiliatedOrgIds: string[];

  /** Affiliated actor IDs */
  affiliatedActorIds: string[];

  /** Created timestamp */
  createdAt: Date;
}

/**
 * Phase configurations by category
 */
const PHASE_CONFIGS: Record<
  TimeframeCategory,
  Record<string, CompressedPhaseTargets>
> = {
  // Flash markets: No arc, just live trading
  flash: {
    live: {
      timeRatio: 1.0,
      correctSignalRatio: 0.5, // 50/50 uncertainty
      clueStrength: [0.3, 0.6],
    },
  },

  // Intraday: 2 phases - active (uncertainty) and climax (clarity)
  intraday: {
    active: {
      timeRatio: 0.7,
      correctSignalRatio: 0.55, // Slight signal
      clueStrength: [0.3, 0.6],
    },
    climax: {
      timeRatio: 0.3,
      correctSignalRatio: 0.85, // Strong clarity
      clueStrength: [0.7, 0.95],
    },
  },

  // Daily: 3 phases - setup, peak, resolution
  daily: {
    setup: {
      timeRatio: 0.4,
      correctSignalRatio: 0.45, // Misdirection possible
      clueStrength: [0.2, 0.5],
    },
    peak: {
      timeRatio: 0.35,
      correctSignalRatio: 0.6, // Emerging signal
      clueStrength: [0.4, 0.7],
    },
    resolution: {
      timeRatio: 0.25,
      correctSignalRatio: 0.9, // Clear signal
      clueStrength: [0.8, 1.0],
    },
  },

  // Weekly: 4 phases - early, middle, late, climax (similar to standard arc)
  weekly: {
    early: {
      timeRatio: 0.3,
      correctSignalRatio: 0.43, // 43% correct (misdirection)
      clueStrength: [0.2, 0.5],
    },
    middle: {
      timeRatio: 0.3,
      correctSignalRatio: 0.55, // 55% correct (uncertainty peak)
      clueStrength: [0.4, 0.7],
    },
    late: {
      timeRatio: 0.25,
      correctSignalRatio: 0.78, // 78% correct (truth emerges)
      clueStrength: [0.6, 0.9],
    },
    climax: {
      timeRatio: 0.15,
      correctSignalRatio: 1.0, // 100% correct (definitive)
      clueStrength: [0.85, 1.0],
    },
  },
};

/**
 * Timeframe Arc Planner
 *
 * Creates arc plans for markets with different timeframes, compressing
 * the standard narrative arc structure to fit the available time.
 */
export class TimeframeArcPlanner {
  /**
   * Get the timeframe category from a timeframe string
   */
  static getCategory(timeframe: string): TimeframeCategory {
    if (['15m', '30m'].includes(timeframe)) return 'flash';
    if (['1h', '6h'].includes(timeframe)) return 'intraday';
    if (['12h', '1d'].includes(timeframe)) return 'daily';
    return 'weekly'; // 2d, 3d
  }

  /**
   * Create an arc plan for a timeframe-specific market
   */
  planTimeframeArc(
    questionId: string,
    questionText: string,
    timeframe: string,
    durationMs: number,
    outcome: boolean,
    actors: Actor[],
    organizations: Organization[],
    affiliatedActorIds: string[] = [],
    affiliatedOrgIds: string[] = []
  ): TimeframeArcPlan {
    const category = TimeframeArcPlanner.getCategory(timeframe);
    const phases = PHASE_CONFIGS[category];
    const phaseOrder = Object.keys(phases);

    // Select insiders and deceivers
    const insiders = this.selectInsiders(
      questionText,
      actors,
      organizations,
      affiliatedActorIds
    );
    const deceivers = this.selectDeceivers(actors, category);

    const plan: TimeframeArcPlan = {
      questionId,
      timeframe,
      category,
      outcome,
      durationMs,
      phases,
      phaseOrder,
      insiders,
      deceivers,
      affiliatedOrgIds,
      affiliatedActorIds,
      createdAt: new Date(),
    };

    logger.info(
      'Created timeframe arc plan',
      {
        questionId,
        timeframe,
        category,
        phases: phaseOrder.length,
        insiders: insiders.length,
        deceivers: deceivers.length,
        durationHours: durationMs / (60 * 60 * 1000),
      },
      'TimeframeArcPlanner'
    );

    return plan;
  }

  /**
   * Get the current phase for a market based on elapsed time
   */
  getCurrentPhase(
    startTime: Date,
    now: Date,
    arcPlan: TimeframeArcPlan
  ): string | null {
    const elapsed = now.getTime() - startTime.getTime();
    const progress = elapsed / arcPlan.durationMs;

    if (progress < 0 || progress > 1) return null;

    let cumulative = 0;
    for (const phase of arcPlan.phaseOrder) {
      const phaseConfig = arcPlan.phases[phase];
      if (!phaseConfig) continue;
      cumulative += phaseConfig.timeRatio;
      if (progress <= cumulative) {
        return phase;
      }
    }

    return arcPlan.phaseOrder[arcPlan.phaseOrder.length - 1] ?? null;
  }

  /**
   * Get the expected signal direction for the current phase
   *
   * @param phase - Current phase name
   * @param arcPlan - The arc plan for the question
   * @param rng - Optional random number generator for reproducibility (defaults to Math.random)
   */
  getSignalDirection(
    phase: string,
    arcPlan: TimeframeArcPlan,
    rng: RngFunction = Math.random
  ): 'correct' | 'wrong' | 'ambiguous' {
    const phaseConfig = arcPlan.phases[phase];
    if (!phaseConfig) return 'ambiguous';

    const rand = rng();

    if (rand < phaseConfig.correctSignalRatio) {
      return 'correct';
    } else {
      return 'wrong';
    }
  }

  /**
   * Get the clue strength for the current phase
   *
   * @param phase - Current phase name
   * @param arcPlan - The arc plan for the question
   * @param rng - Optional random number generator for reproducibility (defaults to Math.random)
   */
  getClueStrength(
    phase: string,
    arcPlan: TimeframeArcPlan,
    rng: RngFunction = Math.random
  ): number {
    const phaseConfig = arcPlan.phases[phase];
    if (!phaseConfig) return 0.5;

    const [min, max] = phaseConfig.clueStrength;
    return min + rng() * (max - min);
  }

  /**
   * Calculate expected certainty at a given progress point (0-1)
   */
  calculateExpectedCertainty(
    progress: number,
    arcPlan: TimeframeArcPlan
  ): number {
    let cumulative = 0;

    for (const phase of arcPlan.phaseOrder) {
      const phaseConfig = arcPlan.phases[phase];
      if (!phaseConfig) continue;
      cumulative += phaseConfig.timeRatio;

      if (progress <= cumulative) {
        return phaseConfig.correctSignalRatio;
      }
    }

    return 0.5;
  }

  /**
   * Select insider NPCs who know the truth
   */
  private selectInsiders(
    questionText: string,
    actors: Actor[],
    organizations: Organization[],
    affiliatedActorIds: string[]
  ): string[] {
    // Start with explicitly affiliated actors
    const insiders = new Set(affiliatedActorIds);

    // Find actors affiliated with orgs mentioned in the question
    const questionLower = questionText.toLowerCase();
    const relatedOrgIds = organizations
      .filter((org) => questionLower.includes(org.name.toLowerCase()))
      .map((o) => o.id);

    const potentialInsiders = actors.filter(
      (a) =>
        a.affiliations?.some((orgId) => relatedOrgIds.includes(orgId)) &&
        (a.tier === 'S_TIER' || a.tier === 'A_TIER' || a.tier === 'B_TIER')
    );

    // Add 1-2 additional insiders
    const shuffled = shuffleArray(potentialInsiders);
    for (const actor of shuffled.slice(0, 2)) {
      insiders.add(actor.id);
    }

    return Array.from(insiders);
  }

  /**
   * Select deceiver NPCs who spread misinformation
   */
  private selectDeceivers(
    actors: Actor[],
    category: TimeframeCategory
  ): string[] {
    // Fewer deceivers for short timeframes (less time for misdirection)
    const maxDeceivers =
      category === 'flash' ? 0 : category === 'intraday' ? 1 : 2;

    const potentialDeceivers = actors.filter(
      (a) =>
        a.personality?.includes('contrarian') ||
        a.personality?.includes('conspiracy') ||
        a.description?.toLowerCase().includes('conspiracy')
    );

    const shuffled = shuffleArray(potentialDeceivers);
    return shuffled.slice(0, maxDeceivers).map((a) => a.id);
  }
}

// Export singleton instance for convenience
export const timeframeArcPlanner = new TimeframeArcPlanner();
