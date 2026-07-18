/**
 * Integration boundary between TASKS and the durable Smithers runner. It gates
 * the structured task path behind runtime settings, normalizes AcpService's
 * optional methods into the executor shape, and falls back to the direct prompt
 * path when Smithers is disabled.
 */

import { ElizaError } from "@elizaos/core";
import type { AcpLike } from "./smithers-task-executor";
import { SmithersTaskExecutor } from "./smithers-task-executor";
import {
  collectDurableTaskTurns,
  runTaskWithSmithers,
} from "./smithers-task-runner";
import type { ApprovalPreset } from "./types";

type PromptOut = {
  stopReason?: string;
  finalText?: string;
  response?: string;
  error?: string;
};

export const SMITHERS_DURABLE_RUN_METADATA_KEY = "smithersDurableRun";

export type SmithersDurableRunState =
  | "pending"
  | "running"
  | "completed"
  | "superseded";

/**
 * Restart contract persisted on both the ACP session and its orchestrator-task
 * session row before the first prompt is sent. The stable task/run ids select
 * Smithers' existing graph after a host restart; the prompt and execution
 * options let startup recovery reconstruct the exact invocation without
 * consulting transient action state.
 */
export interface SmithersDurableRunLink {
  version: 1;
  orchestratorTaskId: string;
  taskId: string;
  runId: string;
  tenantId: string;
  initialPrompt: string;
  state: SmithersDurableRunState;
  timeoutMs?: number;
  model?: string;
  maxTurns?: number;
  /** Preserve least-privilege ACP policy when recovery must spawn a replacement. */
  approvalPreset?: ApprovalPreset;
  keepAliveAfterComplete: boolean;
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function approvalPreset(value: unknown): ApprovalPreset | undefined {
  return value === "readonly" ||
    value === "standard" ||
    value === "permissive" ||
    value === "autonomous" ||
    value === "verifier"
    ? value
    : undefined;
}

/** Parse the untrusted session-metadata copy of a durable Smithers run link. */
export function readSmithersDurableRunLink(
  metadata: Record<string, unknown> | undefined,
): SmithersDurableRunLink | undefined {
  const value = metadata?.[SMITHERS_DURABLE_RUN_METADATA_KEY];
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  if (
    record.version !== 1 ||
    !nonEmptyString(record.orchestratorTaskId) ||
    !nonEmptyString(record.taskId) ||
    !nonEmptyString(record.runId) ||
    !nonEmptyString(record.tenantId) ||
    !nonEmptyString(record.initialPrompt) ||
    (record.state !== "pending" &&
      record.state !== "running" &&
      record.state !== "completed" &&
      record.state !== "superseded") ||
    typeof record.keepAliveAfterComplete !== "boolean"
  ) {
    return undefined;
  }
  const timeoutMs =
    typeof record.timeoutMs === "number" &&
    Number.isFinite(record.timeoutMs) &&
    record.timeoutMs > 0
      ? record.timeoutMs
      : undefined;
  const maxTurns =
    typeof record.maxTurns === "number" &&
    Number.isInteger(record.maxTurns) &&
    record.maxTurns > 0
      ? record.maxTurns
      : undefined;
  const model = nonEmptyString(record.model) ? record.model : undefined;
  const recoveredApprovalPreset = approvalPreset(record.approvalPreset);
  return {
    version: 1,
    orchestratorTaskId: record.orchestratorTaskId,
    taskId: record.taskId,
    runId: record.runId,
    tenantId: record.tenantId,
    initialPrompt: record.initialPrompt,
    state: record.state,
    keepAliveAfterComplete: record.keepAliveAfterComplete,
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
    ...(maxTurns === undefined ? {} : { maxTurns }),
    ...(model === undefined ? {} : { model }),
    ...(recoveredApprovalPreset === undefined
      ? {}
      : { approvalPreset: recoveredApprovalPreset }),
  };
}

export function smithersDurableRunMetadata(
  link: SmithersDurableRunLink,
): Record<string, unknown> {
  return { [SMITHERS_DURABLE_RUN_METADATA_KEY]: link };
}

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
  cancelSession?(sessionId: string): Promise<void>;
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
  const cancelSession = service.cancelSession;
  if (!cancelSession) {
    throw new ElizaError("ACP service cannot cancel a durable task prompt", {
      code: "ACP_TASK_CANCEL_UNAVAILABLE",
    });
  }
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
    cancelSession: (sessionId) => cancelSession.call(service, sessionId),
    // Reattach-by-label is intentionally not wired here: runDurableTask drives an
    // already-spawned session by id, and the real lookup is workdir-aware. The
    // executor still supports reattach when given a capable AcpLike (see tests).
  };
}

/**
 * Drive one durable coding-task run against an already-spawned ACP session via
 * the Smithers engine. Single-turn by default (`maxTurns: 1`) so it is a
 * behaviour-preserving drop-in for a direct prompt, but the run is durable: a
 * TASKS supplies stable task/run ids that survive replacement ACP transports;
 * direct callers default those ids to the session id for compatibility.
 */
export async function runDurableTask(
  service: AcpTaskService,
  session: { sessionId: string },
  task: string,
  opts: {
    tenantId: string;
    taskId?: string;
    runId?: string;
    timeoutMs?: number;
    model?: string;
    maxTurns?: number;
    signal?: AbortSignal;
  },
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
      tenantId: opts.tenantId,
      taskId: opts.taskId ?? session.sessionId,
      runId: opts.runId ?? session.sessionId,
      initialPrompt: task,
      maxTurns: opts.maxTurns ?? 1,
    },
    executor,
    {
      ...(opts.timeoutMs === undefined ? {} : { timeoutMs: opts.timeoutMs }),
      ...(opts.signal === undefined ? {} : { signal: opts.signal }),
    },
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
  const recoveredResponse = collectDurableTaskTurns(result.execution)
    .map((turn) => turn.output?.finalText)
    .findLast(
      (value): value is string =>
        typeof value === "string" && value.trim().length > 0,
    );
  const lastResponse = executor.lastResponse ?? recoveredResponse;
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
