/**
 * Services-layer barrel for the trajectory subsystem: re-exports the
 * TrajectoriesService, its read routes, and the export/type modules, and
 * defines the public `TrajectoryProviderAccess`/`TrajectoryLlmCall` shapes —
 * the recorder records widened with their resolved step/run identifiers — that
 * external consumers depend on instead of reaching into runtime/.
 */

export {
  createTrajectoryJsonBudget,
  ELIZA_NATIVE_MODEL_BOUNDARIES,
  ELIZA_NATIVE_TRAJECTORY_FORMAT,
  type ElizaNativeModelBoundary,
  type ElizaNativeModelRequestRecord,
  type ElizaNativeModelResponseRecord,
  type ElizaNativeTrajectoryFormat,
  type ElizaNativeTrajectoryRow,
  parseTrajectorySemanticStage,
  parseTrajectorySemanticStages,
  type RecordedRetrievalPerStageScores,
  type RecordedRetrievalStageEntry,
  type RecordedToolSearchStage,
  recordedStagesToSemanticStages,
  recordedStageToSemanticStage,
  type SanitizationState,
  sanitizeTrajectoryJsonObject,
  sanitizeTrajectoryJsonValue,
  sanitizeTrajectoryJsonValueInBudget,
  TRAJECTORY_SEMANTIC_STAGE_SCHEMA_VERSION,
  type TrajectoryActionAttemptRecord,
  type TrajectoryCacheStatsRecord,
  type TrajectoryDetailRecord,
  type TrajectoryExportFormat,
  type TrajectoryExportOptions,
  type TrajectoryExportResult,
  type TrajectoryFlattenedLlmCallRecord,
  type TrajectoryJsonBudget,
  type TrajectoryJsonShape,
  type TrajectoryListOptions,
  type TrajectoryListResult,
  type TrajectoryLlmCallRecord,
  type TrajectoryProviderAccessRecord,
  type TrajectorySemanticStageRecord,
  type TrajectorySkillInvocationRecord,
  type TrajectorySkillInvocationTruncationMarker,
  type TrajectoryStatus,
  type TrajectoryStepId,
  type TrajectoryStepKind,
  type TrajectoryStepRecord,
  type TrajectorySummaryRecord,
  type TrajectoryUsageTotalsRecord,
} from "@elizaos/core";
export { tryHandleTrajectoryReadRoutes } from "../features/trajectories/read-routes";
export { TrajectoriesService } from "../features/trajectories/TrajectoriesService";
export * from "./trajectory-export.ts";

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
