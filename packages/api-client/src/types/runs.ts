import { UUID } from '@elizaos/core';

export type RunStatus = 'completed' | 'timeout' | 'error' | 'started';

export interface RunCounts {
  actions: number;
  modelCalls: number;
  errors: number;
  evaluators: number;
}

export interface RunSummary {
  runId: UUID;
  status: RunStatus;
  startedAt: number | null;
  endedAt?: number | null;
  durationMs?: number | null;
  messageId?: UUID;
  roomId?: UUID;
  entityId?: UUID;
  counts?: RunCounts;
  metadata?: Record<string, unknown>;
}

export type RunEventType =
  | 'RUN_STARTED'
  | 'RUN_ENDED'
  | 'ACTION_STARTED'
  | 'ACTION_COMPLETED'
  | 'MODEL_USED'
  | 'EVALUATOR_COMPLETED'
  | 'EMBEDDING_EVENT';

export interface RunEvent {
  type: RunEventType;
  timestamp: number;
  data: Record<string, unknown>;
}

export interface RunDetail {
  summary: RunSummary;
  events: RunEvent[];
}

export interface ListRunsParams {
  roomId?: UUID;
  status?: RunStatus | 'all';
  limit?: number;
  from?: number; // epoch ms
  to?: number; // epoch ms
}
