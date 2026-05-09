/**
 * plugin-health canonical contract surface.
 *
 * Re-exports the sleep / circadian / health-metric / screen-time types from
 * `@elizaos/shared` so plugin-health code has a stable local import path.
 *
 * Wave-1 (W1-B) decision (per `IMPLEMENTATION_PLAN.md` §9.4 / §3.2): the
 * canonical type definitions remain in `@elizaos/shared/contracts/lifeops.ts`
 * because a non-app-lifeops, non-plugin-health importer
 * (`test/mocks/fixtures/lifeops-presence-day.ts`) requires the types stay
 * cross-package importable, AND the cross-file dependencies inside lifeops.ts
 * (`LifeOpsActivitySignal.health`, `LifeOpsMobileHealthPayload.signal`,
 * `CaptureLifeOpsActivitySignalRequest.health`,
 * `LifeOpsManualOverrideResult.circadianState`, etc.) deeply interleave
 * health and non-health types. A physical split is Wave-2 work.
 *
 * `@elizaos/shared/contracts/health` (the canonical alias) re-exports the
 * relevant types from `@elizaos/shared/contracts/lifeops`. plugin-health code
 * imports from this file (`../contracts/health.js`) so a future canonical
 * relocation is a single edit here.
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
  // Telemetry mobile-health envelope
  LifeOpsMobileHealthPayload,
  // Auxiliary types referenced by health surface
  LifeOpsConnectorMode,
  LifeOpsConnectorSide,
  LifeOpsConnectorExecutionTarget,
  LifeOpsConnectorSourceOfTruth,
  LifeOpsConnectorGrant,
  LifeOpsConnectorDegradation,
  LifeOpsActivitySignalSource,
  LifeOpsEventKind,
} from "@elizaos/shared";

export {
  LIFEOPS_HEALTH_CONNECTOR_PROVIDERS,
  LIFEOPS_HEALTH_CONNECTOR_CAPABILITIES,
  LIFEOPS_HEALTH_METRICS,
  LIFEOPS_HEALTH_SIGNAL_SOURCES,
  LIFEOPS_HEALTH_CONNECTOR_REASONS,
  LIFEOPS_HEALTH_SLEEP_STAGES,
  LIFEOPS_CIRCADIAN_STATES,
  LIFEOPS_UNCLEAR_REASONS,
} from "@elizaos/shared";
