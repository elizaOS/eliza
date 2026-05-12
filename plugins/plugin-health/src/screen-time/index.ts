/**
 * Screen-time domain entry point.
 *
 * Wave-1 (W1-B) note: the bulk of the screen-time aggregation lives in
 * `app-lifeops/src/lifeops/service-mixin-screentime.ts`. That mixin
 * pre-dates the plugin-health extraction and is deeply coupled to the
 * `LifeOpsServiceBase` repository / activity-profile reporting layer
 * (`getActivityReportBetween`, `isSystemInactivityApp`, etc.). Moving it
 * physically to plugin-health would require either dragging the entire
 * activity-profile module or introducing a circular package dependency
 * (plugin-health → app-lifeops). Wave-2 (W2-D: Signal-bus + anchors +
 * identity-observation cleanup) is the right home for that decoupling.
 *
 * For now, plugin-health publishes the `LifeOpsScreenTimeSummaryPayload`
 * contract (re-exported from `../contracts/health.ts`); app-lifeops
 * continues to host the aggregator and emits payloads on the W2-D bus once
 * it lands.
 *
 * No runtime exports here — the type re-export carries the canonical
 * contract surface.
 */

export type {
  LifeOpsScreenTimePerAppUsage,
  LifeOpsScreenTimeSummaryPayload,
} from "../contracts/health.js";
