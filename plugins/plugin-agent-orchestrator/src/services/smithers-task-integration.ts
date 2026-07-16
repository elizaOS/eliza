/**
 * Integration boundary between TASKS and the durable Smithers runner. It gates
 * the structured task path behind runtime settings, normalizes AcpService's
 * optional methods into the executor shape, and falls back to the direct prompt
 * path when Smithers is disabled.
 */

import { ElizaError } from "@elizaos/core";
import type { AcpLike } from "./smithers-task-executor";
import { SmithersTaskExecutor } from "./smithers-task-executor";
import { runTaskWithSmithers } from "./smithers-task-runner";

type PromptOut = {
  stopReason?: string;
  finalText?: string;
  response?: string;
  error?: string;
};

/** Structural subset of `AcpService` the durable task path uses (methods optional, as on the real service). */
export interface AcpTaskService {
  spawnSession?(opts: {
    agentType?: string;
    workdir?: string;
    metadata?: Record<string, unknown>;
  }): Promise<{ sessionId: string }>;
  sendPrompt?(
    sessionId: string,
    text: string,
    opts?: { timeoutMs?: number; model?: string },
  ): Promise<PromptOut>;
  sendToSession?(sessionId: string, text: string): Promise<PromptOut>;
}

/**
 * Whether the durable Smithers task path is enabled. Default ON; set
 * `ELIZA_ORCHESTRATOR_SMITHERS=0` to fall back to the direct prompt path.
 */
export function shouldUseSmithersTaskRunner(): boolean {
  return process.env.ELIZA_ORCHESTRATOR_SMITHERS !== "0";
}

/** Adapt the ACP service to the executor's minimal contract. */
export function acpServiceToAcpLike(
  service: AcpTaskService,
  defaults: { timeoutMs?: number; model?: string } = {},
): AcpLike {
  return {
    spawnSession: (opts) => {
      if (!service.spawnSession)
        return Promise.reject(new Error("ACP service has no spawnSession"));
      return service
        .spawnSession({
          agentType: opts.agentType,
          workdir: opts.workdir,
          metadata: { label: opts.label },
        })
        .then((r) => ({ sessionId: r.sessionId }));
    },
    sendPrompt: (sessionId, text) => {
      if (service.sendPrompt) {
        return service.sendPrompt(sessionId, text, {
          timeoutMs: defaults.timeoutMs,
          model: defaults.model,
        });
      }
      if (service.sendToSession) return service.sendToSession(sessionId, text);
      return Promise.reject(
        new Error("ACP service has neither sendPrompt nor sendToSession"),
      );
    },
    // Reattach-by-label is intentionally not wired here: runDurableTask drives an
    // already-spawned session by id, and the real lookup is workdir-aware. The
    // executor still supports reattach when given a capable AcpLike (see tests).
  };
}

/**
 * Drive one durable coding-task run against an already-spawned ACP session via
 * the Smithers engine. Single-turn by default (`maxTurns: 1`) so it is a
 * behaviour-preserving drop-in for a direct prompt, but the run is durable: a
 * crash mid-task resumes from the same `runId` (the session id) on restart.
 */
export async function runDurableTask(
  service: AcpTaskService,
  session: { sessionId: string },
  task: string,
  opts: { timeoutMs?: number; model?: string; maxTurns?: number } = {},
): Promise<{
  status: "completed";
  lastResponse: string;
  turns: number;
}> {
  const executor = new SmithersTaskExecutor(
    acpServiceToAcpLike(service, opts),
    {
      sessionId: session.sessionId,
    },
  );
  const result = await runTaskWithSmithers(
    {
      taskId: session.sessionId,
      runId: session.sessionId,
      initialPrompt: task,
      maxTurns: opts.maxTurns ?? 1,
    },
    executor,
  );
  // A single-turn loop can swallow a turn throw via onMaxReached='return-last';
  // surface it so the host reports the failure (matching the direct path).
  if (executor.lastError) throw executor.lastError;
  if (result.status !== "completed") {
    throw new ElizaError("Durable task did not reach completion", {
      code: "SMITHERS_TASK_INCOMPLETE",
      context: {
        sessionId: session.sessionId,
        status: result.status,
        turns: result.turns,
      },
      severity: "ephemeral",
    });
  }
  const lastResponse = executor.lastResponse;
  if (typeof lastResponse !== "string" || lastResponse.trim().length === 0) {
    throw new ElizaError("Durable task completed without a response", {
      code: "SMITHERS_TASK_RESPONSE_MISSING",
      context: {
        sessionId: session.sessionId,
        status: result.status,
        turns: result.turns,
      },
    });
  }
  return {
    status: "completed",
    lastResponse,
    turns: result.turns,
  };
}
