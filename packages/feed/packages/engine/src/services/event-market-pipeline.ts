/**
 * Event to Market Pipeline
 *
 * Narrative events are logged as market signals but do NOT directly modify
 * prices. In a constant-product AMM, prices move only when someone trades.
 * NPCs see the events and decide to trade (or not) — those trades move
 * the AMM price organically.
 */

import type { StructuredEventData } from "@feed/db";
import { logger } from "@feed/shared";

/**
 * Log a structured event's intended market impacts for observability.
 * Does not modify any price state.
 */
export async function applyEventToMarkets(
  event: StructuredEventData,
): Promise<number> {
  for (const impact of event.marketImpacts) {
    logger.info(
      "Narrative event market signal (not applied to price)",
      {
        arcId: event.arcId,
        ticker: impact.stockTicker,
        direction: impact.direction,
        magnitude: impact.magnitude,
      },
      "EventMarketPipeline",
    );
  }

  return event.marketImpacts.length;
}
