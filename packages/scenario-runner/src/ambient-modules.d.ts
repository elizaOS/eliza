declare module "@elizaos/app-task-coordinator" {
  export type CoordinationDecisionKind =
    | "respond"
    | "escalate"
    | "ignore"
    | "complete"
    | "auto_resolved"
    | "stopped";

  export interface CoordinationDecision {
    timestamp: number;
    event: string;
    promptText: string;
    decision: CoordinationDecisionKind;
    response?: string;
    reasoning: string;
  }

  export type CoordinatorTaskStatus =
    | "active"
    | "blocked"
    | "tool_running"
    | "completed"
    | "error"
    | "stopped";

  export interface TaskContext {
    threadId: string;
    taskNodeId?: string;
    sessionId: string;
    agentType: string;
    label: string;
    originalTask: string;
    workdir: string;
    repo?: string;
    originRoomId?: string;
    originMetadata?: Record<string, unknown>;
    status: CoordinatorTaskStatus;
    decisions: CoordinationDecision[];
    autoResolvedCount: number;
    registeredAt: number;
    lastActivityAt: number;
    idleCheckCount: number;
    taskDelivered: boolean;
    completionSummary?: string;
    validationSummary?: string;
    lastSeenDecisionIndex: number;
    lastInputSentAt?: number;
    stoppedAt?: number;
  }

  export interface SwarmEvent {
    type: string;
    sessionId: string;
    timestamp: number;
    data: unknown;
  }

  export interface TaskCompletionSummary {
    sessionId: string;
    label: string;
    agentType: string;
    originalTask: string;
    status: string;
    completionSummary: string;
    validationSummary?: string;
    [key: string]: unknown;
  }
}
