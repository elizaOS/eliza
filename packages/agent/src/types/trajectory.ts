/**
 * Agent-local aliases for the trajectory record types owned by `@elizaos/core`,
 * giving the API and services shorter names (Trajectory, TrajectoryStep,
 * TrajectoryLlmCall, TrajectoryListResult, ...) over the canonical Core*Record
 * shapes.
 */
import type {
  TrajectoryActionAttemptRecord as CoreTrajectoryActionAttemptRecord,
  TrajectoryCacheStatsRecord as CoreTrajectoryCacheStatsRecord,
  TrajectoryDetailRecord as CoreTrajectoryDetailRecord,
  TrajectoryExportFormat as CoreTrajectoryExportFormat,
  TrajectoryExportOptions as CoreTrajectoryExportOptions,
  TrajectoryExportResult as CoreTrajectoryExportResult,
  TrajectoryFlattenedLlmCallRecord as CoreTrajectoryFlattenedLlmCallRecord,
  TrajectoryJsonShape as CoreTrajectoryJsonShape,
  TrajectoryListOptions as CoreTrajectoryListOptions,
  TrajectoryListResult as CoreTrajectoryListResult,
  TrajectoryLlmCallRecord as CoreTrajectoryLlmCallRecord,
  TrajectoryProviderAccessRecord as CoreTrajectoryProviderAccessRecord,
  TrajectorySkillInvocationRecord as CoreTrajectorySkillInvocationRecord,
  TrajectoryStatus as CoreTrajectoryStatus,
  TrajectoryStepId as CoreTrajectoryStepId,
  TrajectoryStepKind as CoreTrajectoryStepKind,
  TrajectoryStepRecord as CoreTrajectoryStepRecord,
  TrajectorySummaryRecord as CoreTrajectorySummaryRecord,
  TrajectoryUsageTotalsRecord as CoreTrajectoryUsageTotalsRecord,
} from "@elizaos/core";

export type TrajectoryExportFormat = CoreTrajectoryExportFormat;
export type TrajectoryExportOptions = CoreTrajectoryExportOptions;
export type TrajectoryExportResult = CoreTrajectoryExportResult;
export type TrajectoryJsonShape = CoreTrajectoryJsonShape;
export type TrajectoryListOptions = CoreTrajectoryListOptions;
export type TrajectoryStatus = CoreTrajectoryStatus;
export type TrajectoryStepId = CoreTrajectoryStepId;
export type TrajectoryStepKind = CoreTrajectoryStepKind;
export type TrajectoryUsageTotals = CoreTrajectoryUsageTotalsRecord;
export type TrajectoryCacheStats = CoreTrajectoryCacheStatsRecord;
export type TrajectoryActionAttempt = CoreTrajectoryActionAttemptRecord;
export type TrajectoryFlattenedLlmCall = CoreTrajectoryFlattenedLlmCallRecord;

export type TrajectoryListItem = CoreTrajectorySummaryRecord;
export type TrajectoryListResult = CoreTrajectoryListResult<TrajectoryListItem>;
export type TrajectoryLlmCall = CoreTrajectoryLlmCallRecord;
export type TrajectoryProviderAccess = CoreTrajectoryProviderAccessRecord;
export type TrajectorySkillInvocation = CoreTrajectorySkillInvocationRecord;
export type TrajectoryStep = CoreTrajectoryStepRecord;
export type Trajectory = CoreTrajectoryDetailRecord;
