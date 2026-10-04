/** Public compatibility names for the canonical core trajectory records. */
export type {
  TrajectoryActionAttemptRecord as TrajectoryActionAttempt,
  TrajectoryCacheStatsRecord as TrajectoryCacheStats,
  TrajectoryDetailRecord as Trajectory,
  TrajectoryExportFormat,
  TrajectoryExportOptions,
  TrajectoryExportResult,
  TrajectoryFlattenedLlmCallRecord as TrajectoryFlattenedLlmCall,
  TrajectoryJsonShape,
  TrajectoryListOptions,
  TrajectoryLlmCallRecord as TrajectoryLlmCall,
  TrajectoryProviderAccessRecord as TrajectoryProviderAccess,
  TrajectorySkillInvocationRecord as TrajectorySkillInvocation,
  TrajectoryStatus,
  TrajectoryStepId,
  TrajectoryStepKind,
  TrajectoryStepRecord as TrajectoryStep,
  TrajectorySummaryRecord as TrajectoryListItem,
  TrajectoryUsageTotalsRecord as TrajectoryUsageTotals,
} from "@elizaos/core";

import type {
  TrajectoryListResult as CoreTrajectoryListResult,
  TrajectorySummaryRecord,
} from "@elizaos/core";
export type TrajectoryListResult =
  CoreTrajectoryListResult<TrajectorySummaryRecord>;
