/** Uses one monotonic deadline for drain, routing cleanup and transport shutdown. */
import { settleBeforeDeadline } from "./agent-lifecycle";

export type AgentShutdownPhase = "drain" | "cleanup" | "quit" | "disconnect";
export class AgentShutdownTimeoutError extends Error {
  readonly code = "AGENT_SERVER_SHUTDOWN_TIMEOUT";
  constructor(readonly phase: AgentShutdownPhase) {
    super(`Agent-server shutdown deadline expired during ${phase}`);
  }
}

export async function shutdownBeforeDeadline(
  operations: {
    drain(): Promise<unknown>;
    cleanup(): Promise<unknown>;
    quit(): Promise<unknown>;
    disconnect(): void;
    onFailure(phase: AgentShutdownPhase, error: unknown): void;
  },
  deadline: number,
): Promise<boolean> {
  let failed = false;
  let quitCompleted = false;
  for (const phase of ["drain", "cleanup", "quit"] as const) {
    if (performance.now() >= deadline) {
      failed = true;
      operations.onFailure(phase, new AgentShutdownTimeoutError(phase));
      break;
    }
    try {
      if (!(await settleBeforeDeadline(operations[phase](), deadline))) {
        failed = true;
        operations.onFailure(phase, new AgentShutdownTimeoutError(phase));
        break;
      }
      if (phase === "quit") quitCompleted = true;
    } catch (error) {
      failed = true;
      operations.onFailure(phase, error);
    }
  }
  if (!quitCompleted) {
    try {
      operations.disconnect();
    } catch (error) {
      failed = true;
      operations.onFailure("disconnect", error);
    }
  }
  return failed;
}
