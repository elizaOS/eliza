export type WorkThreadStatus =
  | "active"
  | "waiting"
  | "paused"
  | "stopped"
  | "completed";

export interface ThreadSourceRef {
  connector: string;
  channelName?: string;
  channelKind?: string;
  roomId?: string;
  externalThreadId?: string;
  accountId?: string;
  grantId?: string;
  canRead?: boolean;
  canMutate?: boolean;
}

export interface WorkThread {
  id: string;
  agentId: string;
  ownerEntityId?: string | null;
  status: WorkThreadStatus;
  title: string;
  summary: string;
  currentPlanSummary?: string | null;
  primarySourceRef: ThreadSourceRef;
  sourceRefs: ThreadSourceRef[];
  participantEntityIds: string[];
  currentScheduledTaskId?: string | null;
  workflowRunId?: string | null;
  approvalId?: string | null;
  lastMessageMemoryId?: string | null;
  /**
   * Optimistic-concurrency version. Incremented on every persisted UPDATE.
   * Callers that want atomic compare-and-set semantics pass the last-known
   * value into `upsertWorkThread` via `expectedVersion`; the SQL UPDATE
   * filters on it and the upsert throws {@link import("../sql.js").OptimisticLockError}
   * when 0 rows match. Default `1` on insert.
   */
  version: number;
  createdAt: string;
  updatedAt: string;
  lastActivityAt: string;
  metadata?: Record<string, unknown>;
}

export type WorkThreadEventType =
  | "created"
  | "steered"
  | "stopped"
  | "waiting"
  | "completed"
  | "merged"
  | "merged_into"
  | "source_attached"
  | "followup_scheduled"
  | "updated";

export interface WorkThreadEvent {
  id: string;
  agentId: string;
  workThreadId: string;
  occurredAt: string;
  type: WorkThreadEventType;
  reason?: string | null;
  detail?: Record<string, unknown>;
}

export interface WorkThreadListFilter {
  statuses?: WorkThreadStatus[];
  roomId?: string;
  ownerEntityId?: string;
  includeCrossChannel?: boolean;
  limit?: number;
}
