/**
 * Client-safe exports for prediction markets
 *
 * This file exports only browser-compatible utilities that don't depend on
 * Node.js-specific modules like `fs`, `postgres`, etc.
 *
 * Use this import in client components:
 *   import { PredictionPricing, calculateExpectedPayout } from '@feed/core/markets/prediction/client';
 *
 * Use the main index for server-side code:
 *   import { PredictionDbAdapter, PredictionMarketService } from '@feed/core/markets/prediction';
 */

export * from "./positionSnapshot";
export * from "./pricing";
export * from "./types";
