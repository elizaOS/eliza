/**
 * Services-layer barrel for the trajectory subsystem: re-exports the
 * TrajectoriesService, its read routes, and the export/type modules, and
 * defines the public `TrajectoryProviderAccess`/`TrajectoryLlmCall` shapes —
 * the recorder records widened with their resolved step/run identifiers — that
 * external consumers depend on instead of reaching into runtime/.
 */
export { tryHandleTrajectoryReadRoutes } from "../features/trajectories/read-routes";
export { TrajectoriesService } from "../features/trajectories/TrajectoriesService";
export * from "./trajectory-export.ts";
export {
  sanitizeTrajectoryJsonValue,
  createTrajectoryJsonBudget,
  sanitizeTrajectoryJsonValueInBudget,
  sanitizeTrajectoryJsonObject,
  type SanitizationState,
  type TrajectoryJsonBudget,
} from "@elizaos/core";
export {
  recordedStageToSemanticStage,
  recordedStagesToSemanticStages,
  parseTrajectorySemanticStage,
  parseTrajectorySemanticStages,
  TRAJECTORY_SEMANTIC_STAGE_SCHEMA_VERSION,
  type TrajectorySemanticStageRecord,
} from "@elizaos/core";
export {
  type RecordedRetrievalPerStageScores,
  type RecordedRetrievalStageEntry,
  type RecordedToolSearchStage,
  ELIZA_NATIVE_TRAJECTORY_FORMAT,
  type ElizaNativeTrajectoryFormat,
  ELIZA_NATIVE_MODEL_BOUNDARIES,
  type ElizaNativeModelBoundary,
  type TrajectoryStatus,
  type TrajectoryListOptions,
  type TrajectorySummaryRecord,
  type TrajectoryListResult,
  type TrajectoryLlmCallRecord,
  type TrajectoryProviderAccessRecord,
  type TrajectoryStepKind,
  type TrajectoryStepId,
  type TrajectoryActionAttemptRecord,
  type TrajectorySkillInvocationTruncationMarker,
  type TrajectorySkillInvocationRecord,
  type TrajectoryStepRecord,
  type TrajectoryUsageTotalsRecord,
  type TrajectoryCacheStatsRecord,
  type TrajectoryDetailRecord,
  type TrajectoryFlattenedLlmCallRecord,
  type ElizaNativeModelRequestRecord,
  type ElizaNativeModelResponseRecord,
  type ElizaNativeTrajectoryRow,
  type TrajectoryJsonShape,
  type TrajectoryExportFormat,
  type TrajectoryExportOptions,
  type TrajectoryExportResult,
} from "@elizaos/core";

import type {
  TrajectoryData as SharedTrajectoryData,
  TrajectoryScalar as SharedTrajectoryScalar,
  TrajectoryLlmCallRecord,
  TrajectoryProviderAccessRecord,
} from "@elizaos/core";

export type TrajectoryScalar = SharedTrajectoryScalar;
export type TrajectoryData = SharedTrajectoryData;

export type TrajectoryProviderAccess = TrajectoryProviderAccessRecord & {
  stepId: string;
  providerName: string;
  purpose: string;
  data: TrajectoryData;
  query?: TrajectoryData;
  timestamp: number;
  runId?: string;
  roomId?: string;
  messageId?: string;
  executionTraceId?: string;
};

export type TrajectoryLlmCall = TrajectoryLlmCallRecord & {
  stepId: string;
  model: string;
  systemPrompt: string;
  userPrompt: string;
  response: string;
  temperature: number;
  maxTokens: number;
  maxTokensOmitted?: boolean;
  purpose: string;
  actionType: string;
  latencyMs: number;
  timestamp: number;
  modelSlot?: string;
  runId?: string;
  roomId?: string;
  messageId?: string;
  executionTraceId?: string;
};
