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
  stepCount?: number;
  llmCallCount: number;
  providerAccessCount?: number;
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

export interface TrajectoryStep {
  stepId?: string;
  timestamp: number;
  llmCalls?: TrajectoryLlmCall[];
  providerAccesses?: TrajectoryProviderAccess[];
}

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
