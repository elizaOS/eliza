/**
 * Smithers task executor adapts the orchestrator ACP service to the structured
 * provision, turn, approval, and submit steps expected by the durable task
 * runner. The interface stays narrow so tests can substitute an AcpLike without
 * coupling the runner to AcpService internals.
 */

import { ElizaError } from "@elizaos/core";
import type {
  TaskApprovalResult,
  TaskProvisionResult,
  TaskStepContext,
  TaskStepExecutor,
  TaskSubmitResult,
  TaskTurnResult,
} from "./smithers-task-types";

/** Minimal ACP surface the executor needs. Satisfied by `AcpService`; faked in tests. */
export interface AcpLike {
  spawnSession(opts: {
    agentType?: string;
    workdir?: string;
    label?: string;
    initialTask?: string;
  }): Promise<{ sessionId: string }>;
  sendPrompt(
    sessionId: string,
    text: string,
  ): Promise<{
    stopReason?: string;
    finalText?: string;
    response?: string;
    error?: string;
  }>;
  /** Reattach to a still-resumable session for this label (durable resume). */
  findResumableSessionByLabel?(
    label: string,
  ): Promise<{ sessionId: string } | null | undefined>;
  cancelSession?(sessionId: string): Promise<void>;
}

export interface SmithersTaskExecutorOptions {
  agentType?: string;
  workdir?: string;
  /** Drive an already-spawned session instead of spawning/reattaching one. */
  sessionId?: string;
  /** Prompt sent on turns after the first when the agent isn't yet done. */
  continuePrompt?: string;
  onProvision?: (ctx: TaskStepContext) => Promise<TaskProvisionResult>;
  onApproval?: (ctx: TaskStepContext) => Promise<TaskApprovalResult>;
  onSubmit?: (ctx: TaskStepContext) => Promise<TaskSubmitResult>;
}

/**
 * Decide whether an agent turn finished the task. A clean turn is treated as
 * done (one-shot tasks complete in a single turn; the loop only sends another
 * turn when this returns false). Truncated/interrupted turns are not done so the
 * loop continues. Production may refine this via the `task_complete` event that
 * `SubAgentRouter` already tracks.
 */
export function detectTurnDone(result: {
  stopReason?: string;
  finalText?: string;
  error?: string;
}): boolean {
  if (result.error) return false;
  const reason = (result.stopReason ?? "").toLowerCase();
  if (
    reason === "error" ||
    reason === "cancelled" ||
    reason === "stopped" ||
    reason.includes("max") ||
    reason.includes("length") ||
    reason.includes("interrupt")
  ) {
    return false;
  }
  return true;
}

/**
 * {@link TaskStepExecutor} backed by the ACP services. Turns are driven through
 * `sendPrompt` (which resolves when the agent's turn completes); the session is
 * spawned lazily and reattached by label on resume so a crashed task continues
 * against the same agent workspace rather than a fresh one. Provision / approval
 * / submit are pluggable (workspace + approval-queue integration is injected by
 * the caller) so this stays unit-testable without the full plugin.
 */
export class SmithersTaskExecutor implements TaskStepExecutor {
  private sessionId: string | undefined;
  /** Final text from the most recent turn (for the host's task_complete event). */
  lastResponse: string | undefined;
  /**
   * Last turn error. Recorded so callers can propagate it even when a low
   * maxIterations loop swallows the throw via onMaxReached='return-last'.
   */
  lastError: Error | undefined;

  constructor(
    private readonly acp: AcpLike,
    private readonly opts: SmithersTaskExecutorOptions = {},
  ) {
    this.sessionId = opts.sessionId;
  }

  private async ensureSession(ctx: TaskStepContext): Promise<string> {
    if (this.sessionId) return this.sessionId;
    if (this.acp.findResumableSessionByLabel) {
      const existing = await this.acp.findResumableSessionByLabel(ctx.taskId);
      if (existing?.sessionId) {
        this.sessionId = existing.sessionId;
        return this.sessionId;
      }
    }
    const spawned = await this.acp.spawnSession({
      agentType: this.opts.agentType,
      workdir: this.opts.workdir,
      label: ctx.taskId,
    });
    this.sessionId = spawned.sessionId;
    return this.sessionId;
  }

  async provision(ctx: TaskStepContext): Promise<TaskProvisionResult> {
    if (this.opts.onProvision) return this.opts.onProvision(ctx);
    const sessionId = await this.ensureSession(ctx);
    return { workspace: { sessionId } };
  }

  async runTurn(ctx: TaskStepContext): Promise<TaskTurnResult> {
    const sessionId = await this.ensureSession(ctx);
    const prompt =
      (ctx.turn ?? 1) === 1
        ? (ctx.prompt ?? "")
        : (this.opts.continuePrompt ??
          "Continue working on the task. Reply when complete.");
    const result = await this.acp.sendPrompt(sessionId, prompt);
    const stopReason = (result.stopReason ?? "").toLowerCase();
    if (
      result.error ||
      stopReason === "error" ||
      stopReason === "cancelled" ||
      stopReason === "stopped"
    ) {
      const message =
        result.error ??
        (stopReason === "cancelled"
          ? "ACP task prompt was cancelled"
          : stopReason === "stopped"
            ? "ACP task prompt was stopped"
            : "ACP task prompt failed");
      this.lastError = new ElizaError(message, {
        code:
          stopReason === "cancelled"
            ? "ACP_TASK_PROMPT_CANCELLED"
            : stopReason === "stopped"
              ? "ACP_TASK_PROMPT_STOPPED"
              : "ACP_TASK_PROMPT_FAILED",
        context: { sessionId, stopReason: result.stopReason },
        severity: "ephemeral",
      });
      throw this.lastError;
    }
    this.lastResponse =
      result.finalText ?? result.response ?? this.lastResponse;
    return {
      done: detectTurnDone(result),
      output: { finalText: result.finalText, stopReason: result.stopReason },
    };
  }

  async requestApproval(ctx: TaskStepContext): Promise<TaskApprovalResult> {
    if (this.opts.onApproval) return this.opts.onApproval(ctx);
    return { approved: true };
  }

  async submit(ctx: TaskStepContext): Promise<TaskSubmitResult> {
    if (this.opts.onSubmit) return this.opts.onSubmit(ctx);
    return { output: {} };
  }
}
