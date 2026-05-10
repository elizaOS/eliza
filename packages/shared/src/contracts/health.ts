/**
 * Cross-package canonical contract surface for sleep / circadian / health-metric
 * / screen-time types.
 *
 * Wave-1 (W1-B) decision: the canonical implementations of these types live
 * in `./lifeops.ts` for now — a non-app-lifeops, non-plugin-health importer
 * (`test/mocks/fixtures/lifeops-presence-day.ts`) requires that the types
 * stay in `@elizaos/shared`, and the cross-file dependencies inside
 * `lifeops.ts` (e.g. `LifeOpsActivitySignal.health: LifeOpsHealthSignal`,
 * `LifeOpsMobileHealthPayload.signal: LifeOpsHealthSignal`,
 * `CaptureLifeOpsActivitySignalRequest.health: LifeOpsHealthSignal | null`,
 * `LifeOpsManualOverrideResult.circadianState: LifeOpsCircadianState`) are
 * deeply interleaved with non-health types. A physical split would require
 * Wave-2 work to untangle without churn on every importer.
 *
 * Instead, this file gives plugin-health (and any future cross-package
 * caller) a stable canonical alias to import from:
 *
 *   import type { LifeOpsHealthSignal } from "@elizaos/shared";
 *
 * The runtime semantics are identical to importing from `@elizaos/shared`
 * directly — these are pure type re-exports.
 *
 * Per `IMPLEMENTATION_PLAN.md` §3.2 / §9.4 and `wave1-interfaces.md` §5,
 * `plugin-health/src/contracts/health.ts` re-exports from this file so that
 * the plugin can be reasoned about in isolation.
 */

export type {
  DisconnectLifeOpsHealthConnectorRequest,
  // REST request/response surface
  GetLifeOpsHealthSummaryRequest,
  LifeOpsAwakeProbability,
  LifeOpsAwakeProbabilityContributor,
  LifeOpsAwakeProbabilitySource,
  LifeOpsBedtimeImminentFilters,
  LifeOpsCircadianRuleFiring,
  // Circadian inference
  LifeOpsCircadianState,
  LifeOpsDayBoundary,
  LifeOpsDayBoundaryAnchor,
  LifeOpsHealthConnectorCapability,
  // Connector provider / capability / metric
  LifeOpsHealthConnectorProvider,
  // Connector status / wire envelopes
  LifeOpsHealthConnectorReason,
  LifeOpsHealthConnectorStatus,
  LifeOpsHealthDailySummary,
  LifeOpsHealthMetric,
  LifeOpsHealthMetricSample,
  LifeOpsHealthSignal,
  LifeOpsHealthSignalBiometrics,
  LifeOpsHealthSignalSleepSummary,
  // Health-signal source + signal payload
  LifeOpsHealthSignalSource,
  LifeOpsHealthSleepEpisode,
  // Sleep-stage + sleep-episode model
  LifeOpsHealthSleepStage,
  LifeOpsHealthSleepStageSample,
  LifeOpsHealthSummaryResponse,
  LifeOpsHealthSyncState,
  LifeOpsHealthWorkout,
  LifeOpsNapDetectedFilters,
  LifeOpsPersonalBaseline,
  LifeOpsRegularityChangedFilters,
  LifeOpsRegularityClass,
  LifeOpsRelativeTime,
  LifeOpsRelativeTimeAnchorSource,
  LifeOpsScheduleInsight,
  LifeOpsScheduleMealInsight,
  LifeOpsScheduleMealLabel,
  LifeOpsScheduleMealSource,
  LifeOpsScheduleRegularity,
  LifeOpsScheduleSleepStatus,
  // Screen-time
  LifeOpsScreenTimePerAppUsage,
  LifeOpsScreenTimeSummaryPayload,
  LifeOpsSleepCycle,
  LifeOpsSleepCycleEvidence,
  LifeOpsSleepCycleEvidenceSource,
  LifeOpsSleepCycleType,
  LifeOpsSleepDetectedFilters,
  LifeOpsSleepEndedFilters,
  // Sleep / wake event filters
  LifeOpsSleepOnsetCandidateFilters,
  LifeOpsUnclearReason,
  LifeOpsWakeConfirmedFilters,
  LifeOpsWakeObservedFilters,
  StartLifeOpsHealthConnectorRequest,
  StartLifeOpsHealthConnectorResponse,
  SyncLifeOpsHealthConnectorRequest,
} from "./lifeops.js";

export {
  LIFEOPS_CIRCADIAN_STATES,
  LIFEOPS_HEALTH_CONNECTOR_CAPABILITIES,
  LIFEOPS_HEALTH_CONNECTOR_PROVIDERS,
  LIFEOPS_HEALTH_CONNECTOR_REASONS,
  LIFEOPS_HEALTH_METRICS,
  LIFEOPS_HEALTH_SIGNAL_SOURCES,
  LIFEOPS_HEALTH_SLEEP_STAGES,
  LIFEOPS_UNCLEAR_REASONS,
} from "./lifeops.js";
