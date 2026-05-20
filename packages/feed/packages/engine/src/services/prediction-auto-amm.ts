/**
 * Prediction Market Auto-AMM Service
 *
 * Drives prediction market prices based on narrative signals instead of NPC trading.
 * NPCs no longer trade prediction markets directly — this service provides liquidity
 * and price discovery based on:
 * - Narrative arc state and signal direction
 * - Time decay toward resolution
 *
 * System-level trades with no NPC identity and no scoring impact.
 */

import { PredictionPricing } from "@feed/core/markets/prediction";
import { and, arcStates, db, eq, gte, markets, questions } from "@feed/db";
import { logger } from "@feed/shared";
import { calculateAutoAmmTargetNudge } from "./prediction-auto-amm-helpers";
import { buildPredictionMarketProfile } from "./prediction-market-profiles";

// =============================================================================
// Types
// =============================================================================

interface ArcSignal {
  marketId: string;
  direction: "YES" | "NO" | "NEUTRAL";
  /** Arc state maps to a phase intensity */
  stateIntensity: number;
}

interface AutoAMMResult {
  marketsProcessed: number;
  priceAdjustments: number;
}

// =============================================================================
// Configuration
// =============================================================================

/** State intensity multipliers — later arc states have stronger signals */
const STATE_INTENSITY: Record<string, number> = {
  setup: 0.3,
  tension: 0.5,
  escalation: 1.0,
  crisis: 1.5,
  revelation: 2.0,
  resolution: 0,
  // Intraday/flash states
  morning: 0.3,
  midday: 0.5,
  afternoon: 1.0,
  evening: 1.5,
  opening: 0.3,
  movement: 0.5,
  peak: 1.5,
  settling: 1.0,
};

// =============================================================================
// Service
// =============================================================================

/**
 * Process prediction market auto-AMM for one tick.
 *
 * For each active prediction market:
 * 1. Look up its narrative arc signal (if any)
 * 2. Calculate target price movement
 * 3. Apply as system-level share adjustment (no NPC wallet)
 */
export async function processAutoAMM(): Promise<AutoAMMResult> {
  const result: AutoAMMResult = {
    marketsProcessed: 0,
    priceAdjustments: 0,
  };

  try {
    // Get active, unresolved prediction markets
    const activeMarkets = await db
      .select({
        id: markets.id,
        question: markets.question,
        yesShares: markets.yesShares,
        noShares: markets.noShares,
        endDate: markets.endDate,
      })
      .from(markets)
      .where(and(eq(markets.resolved, false), gte(markets.endDate, new Date())))
      .limit(20);

    if (activeMarkets.length === 0) {
      return result;
    }

    // Get arc signals — market.id = question.id = arcStates.questionId
    const arcSignals = await getArcSignals(activeMarkets);

    for (const market of activeMarkets) {
      result.marketsProcessed++;

      const yesShares = Number(market.yesShares || 1);
      const noShares = Number(market.noShares || 1);
      const total = yesShares + noShares;
      const currentYesPrice = PredictionPricing.getCurrentPrice(
        yesShares,
        noShares,
        "yes",
      );
      const profile = buildPredictionMarketProfile({
        marketId: market.id,
        question: market.question,
        endDate: market.endDate,
      });

      const signal = arcSignals.get(market.id);

      const targetNudge = calculateAutoAmmTargetNudge({
        currentYesPrice,
        signalDirection: signal?.direction ?? "NEUTRAL",
        signalIntensity: signal?.stateIntensity ?? 0,
        signalSensitivity: profile.signalSensitivity,
        autoAmmNudgeMultiplier: profile.autoAmmNudgeMultiplier,
        neutralReversionMultiplier: profile.neutralReversionMultiplier,
      });

      // Skip negligible adjustments
      if (Math.abs(targetNudge) < 0.001) continue;

      // Calculate new share distribution
      const adjustmentShares = Math.abs(targetNudge) * total * 0.5;

      let newYesShares = yesShares;
      let newNoShares = noShares;

      if (targetNudge > 0) {
        // Push YES price up: add NO shares, remove YES shares
        newNoShares += adjustmentShares;
        newYesShares = Math.max(1, newYesShares - adjustmentShares);
      } else {
        // Push YES price down: add YES shares, remove NO shares
        newYesShares += adjustmentShares;
        newNoShares = Math.max(1, newNoShares - adjustmentShares);
      }

      await db
        .update(markets)
        .set({
          yesShares: String(newYesShares),
          noShares: String(newNoShares),
        })
        .where(eq(markets.id, market.id));

      result.priceAdjustments++;

      const newYesPrice = PredictionPricing.getCurrentPrice(
        newYesShares,
        newNoShares,
        "yes",
      );

      logger.debug(
        `Auto-AMM: ${market.question.slice(0, 40)}... YES ${(currentYesPrice * 100).toFixed(1)}% → ${(newYesPrice * 100).toFixed(1)}%`,
        {
          marketId: market.id,
          signal: signal?.direction ?? "NEUTRAL",
          nudge: targetNudge.toFixed(4),
        },
        "AutoAMM",
      );
    }

    if (result.priceAdjustments > 0) {
      logger.info(
        `Auto-AMM processed ${result.priceAdjustments}/${result.marketsProcessed} markets`,
        {
          marketsProcessed: result.marketsProcessed,
          priceAdjustments: result.priceAdjustments,
        },
        "AutoAMM",
      );
    }
  } catch (error) {
    logger.error(
      "Auto-AMM processing failed",
      { error: error instanceof Error ? error.message : String(error) },
      "AutoAMM",
    );
  }

  return result;
}

/**
 * Extract arc signals for active markets.
 * Market ID = Question ID = arcStates.questionId
 */
async function getArcSignals(
  activeMarkets: Array<{ id: string }>,
): Promise<Map<string, ArcSignal>> {
  const signals = new Map<string, ArcSignal>();

  try {
    const marketIds = activeMarkets.map((m) => m.id);
    if (marketIds.length === 0) return signals;

    // Arc states where questionId matches a market ID
    const arcs = await db
      .select({
        questionId: arcStates.questionId,
        currentState: arcStates.currentState,
      })
      .from(arcStates)
      .limit(30);

    const marketIdSet = new Set(marketIds);

    // Fetch actual outcomes for these questions so we push the correct direction
    const outcomeMap = new Map<string, boolean>();
    try {
      const questionData = await db
        .select({ id: questions.id, outcome: questions.outcome })
        .from(questions)
        .limit(50);
      for (const q of questionData) {
        outcomeMap.set(q.id, q.outcome);
      }
    } catch {
      // If outcome lookup fails, we'll default to NEUTRAL
    }

    for (const arc of arcs) {
      if (!marketIdSet.has(arc.questionId)) continue;

      const state = arc.currentState;
      const intensity = STATE_INTENSITY[state] ?? 0.5;

      // Use actual outcome to determine direction — later arc states
      // push toward the CORRECT answer (not always YES)
      let direction: "YES" | "NO" | "NEUTRAL" = "NEUTRAL";
      if (
        state === "escalation" ||
        state === "crisis" ||
        state === "revelation"
      ) {
        const outcome = outcomeMap.get(arc.questionId);
        if (outcome === true) direction = "YES";
        else if (outcome === false) direction = "NO";
        else direction = "YES"; // fallback if unknown
      }

      signals.set(arc.questionId, {
        marketId: arc.questionId,
        direction,
        stateIntensity: intensity,
      });
    }
  } catch (error) {
    logger.warn(
      "Failed to get arc signals for auto-AMM",
      { error: error instanceof Error ? error.message : String(error) },
      "AutoAMM",
    );
  }

  return signals;
}
