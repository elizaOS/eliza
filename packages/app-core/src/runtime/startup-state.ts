/**
 * Defines the server host's startup lifecycle and validates transitions before
 * projecting them into the agent API. This keeps readiness semantics typed and
 * shared by initial boot, deferred onboarding, restart, failure, and shutdown.
 */
export const APP_STARTUP_PHASES = [
  "api-binding",
  "api-bound",
  "awaiting-onboarding",
  "runtime-starting",
  "runtime-ready",
  "features-starting",
  "ready",
  "degraded",
  "stopping",
  "failed",
] as const;

export type AppStartupPhase = (typeof APP_STARTUP_PHASES)[number];
export type AppAgentState =
  | "not_started"
  | "starting"
  | "running"
  | "stopped"
  | "error";

export interface AppStartupSnapshot {
  phase: AppStartupPhase;
  agentState: AppAgentState;
  attempt: number;
  changedAt: number;
}

const AGENT_STATE_BY_PHASE: Record<AppStartupPhase, AppAgentState> = {
  "api-binding": "starting",
  "api-bound": "starting",
  "awaiting-onboarding": "not_started",
  "runtime-starting": "starting",
  "runtime-ready": "running",
  "features-starting": "running",
  ready: "running",
  degraded: "running",
  stopping: "stopped",
  failed: "error",
};

const ALLOWED: Record<AppStartupPhase, ReadonlySet<AppStartupPhase>> = {
  "api-binding": new Set(["api-bound", "failed", "stopping"]),
  "api-bound": new Set([
    "awaiting-onboarding",
    "runtime-starting",
    "failed",
    "stopping",
  ]),
  "awaiting-onboarding": new Set(["runtime-starting", "failed", "stopping"]),
  "runtime-starting": new Set([
    "runtime-ready",
    "features-starting",
    "ready",
    "degraded",
    "failed",
    "stopping",
  ]),
  "runtime-ready": new Set([
    "features-starting",
    "ready",
    "degraded",
    "runtime-starting",
    "stopping",
  ]),
  "features-starting": new Set([
    "ready",
    "degraded",
    "runtime-starting",
    "stopping",
  ]),
  ready: new Set(["runtime-starting", "degraded", "stopping"]),
  degraded: new Set(["runtime-starting", "ready", "stopping"]),
  stopping: new Set(["failed"]),
  failed: new Set(["runtime-starting", "stopping"]),
};

export class AppStartupStateMachine {
  #snapshot: AppStartupSnapshot;

  constructor(now: () => number = Date.now) {
    this.now = now;
    this.#snapshot = {
      phase: "api-binding",
      agentState: "starting",
      attempt: 0,
      changedAt: now(),
    };
  }

  private readonly now: () => number;

  get snapshot(): AppStartupSnapshot {
    return this.#snapshot;
  }

  transition(phase: AppStartupPhase): AppStartupSnapshot {
    if (phase === this.#snapshot.phase) return this.#snapshot;
    if (!ALLOWED[this.#snapshot.phase].has(phase)) {
      throw new Error(
        `Invalid startup transition: ${this.#snapshot.phase} -> ${phase}`,
      );
    }
    const attempt =
      phase === "runtime-starting"
        ? this.#snapshot.attempt + 1
        : this.#snapshot.attempt;
    this.#snapshot = {
      phase,
      agentState: AGENT_STATE_BY_PHASE[phase],
      attempt,
      changedAt: this.now(),
    };
    return this.#snapshot;
  }
}
