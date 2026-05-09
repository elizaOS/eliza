/**
 * Anchor contributions exposed by plugin-health.
 *
 * The actual `registerHealthAnchors` implementation + the `HEALTH_ANCHORS`
 * tuple live in `../connectors/index.ts` (alongside the connector / bus-
 * family registration entry points so a single registry-detection pass
 * runs all three at boot). This file re-exports them so external callers
 * can import from `@elizaos/plugin-health/anchors`.
 *
 * Per `IMPLEMENTATION_PLAN.md` §3.2: BOTH `wake.observed` AND `wake.confirmed`
 * are registered as separate anchors — `observed` = first signal that fits
 * a wake pattern, `confirmed` = sustained signal that survives the
 * `WAKE_CONFIRM_WINDOW_MS` hysteresis window in `circadian-rules.ts`.
 *
 * Per `wave1-interfaces.md` §5.2: the anchor set is
 *   `["wake.observed", "wake.confirmed", "bedtime.target", "nap.start"]`.
 */

export {
  HEALTH_ANCHORS,
  registerHealthAnchors,
  type AnchorContribution,
  type AnchorRegistry,
} from "../connectors/index.js";
