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
  DisconnectLifeOpsHealthConnectorRequest,
  // REST request/response surface
  GetLifeOpsHealthSummaryRequest,
  LifeOpsActivitySignalSource,
  LifeOpsAwakeProbability,
  LifeOpsAwakeProbabilityContributor,
  LifeOpsAwakeProbabilitySource,
  LifeOpsBedtimeImminentFilters,
  LifeOpsCircadianRuleFiring,
  // Circadian inference
  LifeOpsCircadianState,
  LifeOpsConnectorDegradation,
  LifeOpsConnectorExecutionTarget,
  LifeOpsConnectorGrant,
  // Auxiliary types referenced by health surface
  LifeOpsConnectorMode,
  LifeOpsConnectorSide,
  LifeOpsConnectorSourceOfTruth,
  LifeOpsDayBoundary,
  LifeOpsDayBoundaryAnchor,
  LifeOpsEventKind,
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
  // Telemetry mobile-health envelope
  LifeOpsMobileHealthPayload,
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
} from "@elizaos/shared";

export {
  LIFEOPS_CIRCADIAN_STATES,
  LIFEOPS_HEALTH_CONNECTOR_CAPABILITIES,
  LIFEOPS_HEALTH_CONNECTOR_PROVIDERS,
  LIFEOPS_HEALTH_CONNECTOR_REASONS,
  LIFEOPS_HEALTH_METRICS,
  LIFEOPS_HEALTH_SIGNAL_SOURCES,
  LIFEOPS_HEALTH_SLEEP_STAGES,
  LIFEOPS_UNCLEAR_REASONS,
} from "@elizaos/shared";
