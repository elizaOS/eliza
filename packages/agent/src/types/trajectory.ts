/**
 * Shared trajectory type definitions.
 *
 * Used by both the persistence layer (runtime/trajectory-persistence.ts)
 * and the API routes (api/trajectory-routes.ts).
 */

export type TrajectoryStatus = "active" | "completed" | "error" | "timeout";

export interface TrajectoryListOptions {
  limit?: number;
  offset?: number;
  source?: string;
  status?: TrajectoryStatus;
  startDate?: string;
  endDate?: string;
  search?: string;
  scenarioId?: string;
  batchId?: string;
  isTrainingData?: boolean;
}

export interface TrajectoryListItem {
  id: string;
  agentId: string;
  source: string;
  status: TrajectoryStatus;
  startTime: number;
  endTime: number | null;
  durationMs: number | null;
  stepCount: number;
  llmCallCount: number;
  providerAccessCount: number;
  totalPromptTokens: number;
  totalCompletionTokens: number;
  scenarioId?: string;
  batchId?: string;
  createdAt: string;
  updatedAt?: string;
  metadata?: Record<string, unknown>;
}

export interface TrajectoryListResult {
  trajectories: TrajectoryListItem[];
  total: number;
  offset: number;
  limit: number;
}

export interface TrajectoryLlmCall {
  callId?: string;
  timestamp?: number;
  model?: string;
  systemPrompt?: string;
  userPrompt?: string;
  response?: string;
  temperature?: number;
  maxTokens?: number;
  purpose?: string;
  actionType?: string;
  stepType?: string;
  tags?: string[];
  latencyMs?: number;
  promptTokens?: number;
  completionTokens?: number;
}

export interface TrajectoryProviderAccess {
  providerId?: string;
  providerName?: string;
  purpose?: string;
  data?: Record<string, unknown>;
  query?: Record<string, unknown>;
  timestamp?: number;
}

/**
 * Discriminator for the kind of work a trajectory step represents.
 *
 * - `"llm"`: a model call step (the historical default — emitted whenever an
 *   LLM call is logged against a step that has no other classification).
 * - `"action"`: a single action handler invocation step.
 * - `"executeCode"`: a code-execution wrapper step that may have child steps
 *   under `childSteps` (each child action dispatched from within the script
 *   inherits `parentStepId` via `TrajectoryContext`).
 */
export type TrajectoryStepKind = "llm" | "action" | "executeCode";

export type TrajectoryStepId = string;

export interface TrajectoryStep {
  stepId?: TrajectoryStepId;
  timestamp: number;
  llmCalls?: TrajectoryLlmCall[];
  providerAccesses?: TrajectoryProviderAccess[];
  /**
   * Discriminator for what produced this step. Defaults to `"llm"` for legacy
   * rows that predate the field. Persisted in `steps_json`.
   */
  kind?: TrajectoryStepKind;
  /**
   * Step IDs of child steps spawned underneath this step (used by
   * `executeCode` steps to enumerate the action calls dispatched from the
   * script). Order is significant — earliest dispatch first.
   */
  childSteps?: TrajectoryStepId[];
  /**
   * Source script for `executeCode` steps. Capped at 4096 characters; if the
   * original script exceeds the cap, `script` holds the truncated prefix and
   * `scriptHash` carries the sha256 of the full source.
   */
  script?: string;
  /**
   * sha256 hex digest of the full script source when the script exceeded the
   * inline cap and was truncated into `script`. Optional otherwise.
   */
  scriptHash?: string;
  /**
   * Names of skills the step relied on (populated by Track C). Empty/undefined
   * when no skill annotation is available.
   */
  usedSkills?: string[];
}

/** Maximum bytes of script source persisted inline on a trajectory step. */
export const TRAJECTORY_STEP_SCRIPT_MAX_CHARS = 4096;

export interface Trajectory {
  trajectoryId: string;
  agentId: string;
  startTime: number;
  endTime?: number;
  durationMs?: number;
  scenarioId?: string;
  batchId?: string;
  steps?: TrajectoryStep[];
  metrics?: { finalStatus?: string };
  metadata?: Record<string, unknown>;
  stepsJson?: string;
}

export type TrajectoryExportFormat = "json" | "csv" | "art" | "zip";

export interface TrajectoryExportOptions {
  format: TrajectoryExportFormat;
  includePrompts?: boolean;
  trajectoryIds?: string[];
  startDate?: string;
  endDate?: string;
  scenarioId?: string;
  batchId?: string;
}

export interface TrajectoryExportResult {
  filename: string;
  data: string | Uint8Array;
  mimeType: string;
}
