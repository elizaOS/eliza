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
 *   import type { LifeOpsHealthSignal } from "@elizaos/shared/contracts/health";
 *
 * The runtime semantics are identical to importing from `@elizaos/shared`
 * directly — these are pure type re-exports.
 *
 * Per `IMPLEMENTATION_PLAN.md` §3.2 / §9.4 and `wave1-interfaces.md` §5,
 * `plugin-health/src/contracts/health.ts` re-exports from this file so that
 * the plugin can be reasoned about in isolation.
 */

export type {
  // Connector provider / capability / metric
  LifeOpsHealthConnectorProvider,
  LifeOpsHealthConnectorCapability,
  LifeOpsHealthMetric,
  // Health-signal source + signal payload
  LifeOpsHealthSignalSource,
  LifeOpsHealthSignalSleepSummary,
  LifeOpsHealthSignalBiometrics,
  LifeOpsHealthSignal,
  // Connector status / wire envelopes
  LifeOpsHealthConnectorReason,
  LifeOpsHealthConnectorStatus,
  LifeOpsHealthMetricSample,
  LifeOpsHealthWorkout,
  LifeOpsHealthSyncState,
  // Sleep-stage + sleep-episode model
  LifeOpsHealthSleepStage,
  LifeOpsHealthSleepStageSample,
  LifeOpsHealthSleepEpisode,
  LifeOpsHealthDailySummary,
  // REST request/response surface
  GetLifeOpsHealthSummaryRequest,
  LifeOpsHealthSummaryResponse,
  StartLifeOpsHealthConnectorRequest,
  StartLifeOpsHealthConnectorResponse,
  DisconnectLifeOpsHealthConnectorRequest,
  SyncLifeOpsHealthConnectorRequest,
  // Circadian inference
  LifeOpsCircadianState,
  LifeOpsUnclearReason,
  LifeOpsScheduleSleepStatus,
  LifeOpsSleepCycleEvidenceSource,
  LifeOpsSleepCycleType,
  LifeOpsRegularityClass,
  LifeOpsScheduleRegularity,
  LifeOpsPersonalBaseline,
  LifeOpsAwakeProbabilitySource,
  LifeOpsAwakeProbabilityContributor,
  LifeOpsAwakeProbability,
  LifeOpsSleepCycleEvidence,
  LifeOpsSleepCycle,
  LifeOpsDayBoundaryAnchor,
  LifeOpsDayBoundary,
  LifeOpsRelativeTimeAnchorSource,
  LifeOpsRelativeTime,
  LifeOpsScheduleMealLabel,
  LifeOpsScheduleMealSource,
  LifeOpsScheduleMealInsight,
  LifeOpsCircadianRuleFiring,
  LifeOpsScheduleInsight,
  // Sleep / wake event filters
  LifeOpsSleepOnsetCandidateFilters,
  LifeOpsSleepDetectedFilters,
  LifeOpsSleepEndedFilters,
  LifeOpsWakeObservedFilters,
  LifeOpsWakeConfirmedFilters,
  LifeOpsNapDetectedFilters,
  LifeOpsBedtimeImminentFilters,
  LifeOpsRegularityChangedFilters,
  // Screen-time
  LifeOpsScreenTimePerAppUsage,
  LifeOpsScreenTimeSummaryPayload,
} from "./lifeops.js";

export {
  LIFEOPS_HEALTH_CONNECTOR_PROVIDERS,
  LIFEOPS_HEALTH_CONNECTOR_CAPABILITIES,
  LIFEOPS_HEALTH_METRICS,
  LIFEOPS_HEALTH_SIGNAL_SOURCES,
  LIFEOPS_HEALTH_CONNECTOR_REASONS,
  LIFEOPS_HEALTH_SLEEP_STAGES,
  LIFEOPS_CIRCADIAN_STATES,
  LIFEOPS_UNCLEAR_REASONS,
} from "./lifeops.js";
