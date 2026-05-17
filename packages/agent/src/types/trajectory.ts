import {
  type TrajectoryCacheStatsRecord as CoreTrajectoryCacheStatsRecord,
  type TrajectoryDetailRecord as CoreTrajectoryDetailRecord,
  type TrajectoryExportFormat as CoreTrajectoryExportFormat,
  type TrajectoryExportOptions as CoreTrajectoryExportOptions,
  type TrajectoryExportResult as CoreTrajectoryExportResult,
  type TrajectoryFlattenedLlmCallRecord as CoreTrajectoryFlattenedLlmCallRecord,
  type TrajectoryJsonShape as CoreTrajectoryJsonShape,
  type TrajectoryListOptions as CoreTrajectoryListOptions,
  type TrajectoryListResult as CoreTrajectoryListResult,
  type TrajectoryLlmCallRecord as CoreTrajectoryLlmCallRecord,
  type TrajectoryProviderAccessRecord as CoreTrajectoryProviderAccessRecord,
  type TrajectorySkillInvocationRecord as CoreTrajectorySkillInvocationRecord,
  type TrajectoryStatus as CoreTrajectoryStatus,
  type TrajectoryStepId as CoreTrajectoryStepId,
  type TrajectoryStepKind as CoreTrajectoryStepKind,
  type TrajectoryStepRecord as CoreTrajectoryStepRecord,
  type TrajectorySummaryRecord as CoreTrajectorySummaryRecord,
  type TrajectoryUsageTotalsRecord as CoreTrajectoryUsageTotalsRecord,
  TRAJECTORY_STEP_SCRIPT_MAX_CHARS,
} from "@elizaos/core";

export { TRAJECTORY_STEP_SCRIPT_MAX_CHARS };

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
export type TrajectoryFlattenedLlmCall = CoreTrajectoryFlattenedLlmCallRecord;

export type TrajectoryListItem = CoreTrajectorySummaryRecord;
export type TrajectoryListResult = CoreTrajectoryListResult<TrajectoryListItem>;
export type TrajectoryLlmCall = CoreTrajectoryLlmCallRecord;
export type TrajectoryProviderAccess = CoreTrajectoryProviderAccessRecord;
export type TrajectorySkillInvocation = CoreTrajectorySkillInvocationRecord;
export type TrajectoryStep = CoreTrajectoryStepRecord;
export type Trajectory = CoreTrajectoryDetailRecord;
