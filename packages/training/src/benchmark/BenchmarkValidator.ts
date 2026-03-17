/**
 * Benchmark Data Validator
 *
 * Validates benchmark snapshot data to ensure it's properly formatted
 * and contains all required fields.
 */

import type { JsonValue } from "../adapter";
import { logger } from "../utils/logger";
import type { BenchmarkGameSnapshot } from "./BenchmarkDataGenerator";

export interface BenchmarkValidationResult {
  valid: boolean;
  errors: string[];
  warnings: string[];
}

/**
 * Validate a benchmark snapshot
 */
export function validate(snapshot: unknown): BenchmarkValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  // 1. Check required top-level fields
  if (!snapshot || typeof snapshot !== "object") {
    errors.push("Snapshot is null, undefined, or not an object");
    return { valid: false, errors, warnings };
  }

  const snap = snapshot as Record<string, JsonValue>;

  if (!snap.id) errors.push("Missing required field: id");
  if (!snap.version) errors.push("Missing required field: version");
  if (typeof snap.duration !== "number")
    errors.push("Missing or invalid field: duration");
  if (typeof snap.tickInterval !== "number")
    errors.push("Missing or invalid field: tickInterval");
  if (!snap.initialState) errors.push("Missing required field: initialState");
  if (!Array.isArray(snap.ticks))
    errors.push("Missing or invalid field: ticks (must be array)");
  if (!snap.groundTruth) errors.push("Missing required field: groundTruth");

  // 2. Validate initial state
  if (snap.initialState && typeof snap.initialState === "object") {
    const state = snap.initialState as Record<string, JsonValue>;

    if (typeof state.tick !== "number")
      errors.push("initialState.tick must be a number");
    if (state.tick !== 0) warnings.push("initialState.tick should be 0");

    if (!Array.isArray(state.predictionMarkets)) {
      errors.push("initialState.predictionMarkets must be an array");
    }

    if (!Array.isArray(state.perpetualMarkets)) {
      errors.push("initialState.perpetualMarkets must be an array");
    }

    if (!Array.isArray(state.agents)) {
      errors.push("initialState.agents must be an array");
    }
  }

  // 3. Validate ticks
  if (Array.isArray(snap.ticks)) {
    if (snap.ticks.length === 0) {
      warnings.push("Ticks array is empty");
    }

    snap.ticks.forEach((tick: JsonValue, index: number) => {
      if (!tick || typeof tick !== "object") {
        errors.push(`Tick ${index}: invalid tick object`);
        return;
      }
      const tickObj = tick as Record<string, JsonValue>;
      if (typeof tickObj.number !== "number") {
        errors.push(`Tick ${index}: missing or invalid 'number' field`);
      }

      if (!Array.isArray(tickObj.events)) {
        errors.push(`Tick ${index}: events must be an array`);
      }

      if (!tickObj.state) {
        errors.push(`Tick ${index}: missing state`);
      }
    });

    // Check tick numbering is sequential
    for (let i = 0; i < snap.ticks.length; i++) {
      const tick = snap.ticks[i] as Record<string, JsonValue> | undefined;
      if (tick && typeof tick.number === "number" && tick.number !== i) {
        warnings.push(`Tick ${i}: number ${tick.number} doesn't match index`);
      }
    }
  }

  // 4. Validate ground truth
  if (snap.groundTruth && typeof snap.groundTruth === "object") {
    const gt = snap.groundTruth as Record<string, JsonValue>;

    if (!gt.marketOutcomes || typeof gt.marketOutcomes !== "object") {
      errors.push("groundTruth.marketOutcomes must be an object");
    }

    if (!gt.priceHistory || typeof gt.priceHistory !== "object") {
      errors.push("groundTruth.priceHistory must be an object");
    }

    if (!Array.isArray(gt.optimalActions)) {
      errors.push("groundTruth.optimalActions must be an array");
    }

    if (!Array.isArray(gt.socialOpportunities)) {
      errors.push("groundTruth.socialOpportunities must be an array");
    }

    if (!Array.isArray(gt.hiddenFacts)) {
      errors.push("groundTruth.hiddenFacts must be an array");
    }

    if (!Array.isArray(gt.hiddenEvents)) {
      errors.push("groundTruth.hiddenEvents must be an array");
    }

    if (!gt.trueFacts || typeof gt.trueFacts !== "object") {
      errors.push("groundTruth.trueFacts must be an object");
    }
  }

  // 5. Cross-validate: markets in initialState should have outcomes in groundTruth
  if (
    snap.initialState &&
    typeof snap.initialState === "object" &&
    snap.groundTruth &&
    typeof snap.groundTruth === "object"
  ) {
    const initialState = snap.initialState as Record<string, JsonValue>;
    const groundTruth = snap.groundTruth as Record<string, JsonValue>;
    const markets = (
      Array.isArray(initialState.predictionMarkets)
        ? initialState.predictionMarkets
        : []
    ) as Array<Record<string, JsonValue>>;
    const outcomes = (
      groundTruth.marketOutcomes &&
      typeof groundTruth.marketOutcomes === "object"
        ? groundTruth.marketOutcomes
        : {}
    ) as Record<string, JsonValue>;

    markets.forEach((market) => {
      if (
        market.id &&
        typeof market.id === "string" &&
        !(market.id in outcomes)
      ) {
        warnings.push(
          `Market ${market.id} in initialState but no outcome in groundTruth`,
        );
      }
    });
  }

  logger.info("Benchmark validation complete", {
    valid: errors.length === 0,
    errors: errors.length,
    warnings: warnings.length,
  });

  return {
    valid: errors.length === 0,
    errors,
    warnings,
  };
}

/**
 * Quick sanity check (fast, minimal validation)
 */
export function sanityCheck(
  snapshot: unknown,
): snapshot is BenchmarkGameSnapshot {
  if (!snapshot || typeof snapshot !== "object") return false;
  const snap = snapshot as Record<string, JsonValue>;
  return !!(
    snap.id &&
    snap.initialState &&
    Array.isArray(snap.ticks) &&
    snap.groundTruth
  );
}

/**
 * Validate and throw if invalid
 */
export function validateOrThrow(
  snapshot: unknown,
): asserts snapshot is BenchmarkGameSnapshot {
  const result = validate(snapshot);

  if (!result.valid) {
    throw new Error(`Invalid benchmark data: ${result.errors.join(", ")}`);
  }
}
