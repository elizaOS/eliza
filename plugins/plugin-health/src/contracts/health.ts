/**
 * plugin-health canonical contract surface.
 *
 * Owns the sleep / circadian / health-metric / screen-time types locally so
 * runtime plugins stay decoupled from app/shared packages.
 */

export type {
  DisconnectLifeOpsHealthConnectorRequest,
  // REST request/response surface
  GetLifeOpsHealthSummaryRequest,
  LifeOpsActivitySignal,
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
  LifeOpsSleepHealthProvider,
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
