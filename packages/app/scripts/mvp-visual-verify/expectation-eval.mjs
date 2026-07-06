/**
 * Compatibility exports for declarative MVP visual expectations. The shared
 * evidence primitive module owns the forbidden-token, no-blue, orange-accent,
 * and horizontal-overflow thresholds used by every screenshot-review lane.
 */

export {
  DEFAULT_BLUE_COVERAGE_LIMIT,
  DEFAULT_ORANGE_COVERAGE_MIN,
  DEFAULT_OVERFLOW_TOLERANCE_PX,
  evaluateExpectations,
  resolveSpec,
} from "@elizaos/evidence/visual-primitives";
