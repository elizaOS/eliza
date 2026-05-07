import type { Action, ActionResult } from "@elizaos/core";
import type { AgentType, SpawnResult } from "../services/types.js";
import {
  callbackText,
  contentRecord,
  emitSessionEvent,
  errorResult,
  failureMessage,
  getAcpService,
  getTimeoutMs,
  type HandlerOptionsLike,
  hasExplicitPayload,
  logger,
  looksLikeTaskAgentRequest,
  messageText,
  paramsRecord,
  parseApproval,
  pickString,
  setCurrentSessions,
} from "./common.js";

const MAX_CONCURRENT_AGENTS = 8;

function looksLikeLifeOpsRequest(text: string | undefined | null): boolean {
  if (!text) return false;
  const normalized = text.toLowerCase().replace(/\s+/g, " ").trim();
  if (normalized.length === 0) return false;
  return /^(?:@\S+\s+)?(?:add|set|schedule|remind|track|log)\b[^.!?]{0,40}\b(todo|habit|reminder|goal|routine|alarm|chore|tasks?\s+for\s+(?:today|tomorrow|this\s+week))\b/i.test(
    normalized,
  );
}

function taskParts(
  params: Record<string, unknown>,
  content: Record<string, unknown>,
  fallbackText: string,
): string[] {
  const agents = pickString(params, content, "agents");
  if (!agents) return [pickString(params, content, "task") ?? fallbackText];
  return agents
    .split("|")
    .map((part) => part.trim())
    .filter(Boolean);
}

function parseAgentPrefix(
  part: string,
  fallbackAgentType: string,
): { task: string; agentType: string } {
  const match = part.match(/^([a-z][a-z0-9_-]{1,32})\s*:\s*(.+)$/i);
  if (!match) return { task: part, agentType: fallbackAgentType };
  return { agentType: match[1] ?? fallbackAgentType, task: match[2] ?? part };
}

function labelFrom(task: string, index: number): string {
  const cleaned = task.replace(/\s+/g, " ").trim();
  return cleaned ? cleaned.slice(0, 80) : `task-${index + 1}`;
}

async function runPromptAndClose(
  service: ReturnType<typeof getAcpService> & {},
  session: SpawnResult,
  task: string,
  timeoutMs: number | undefined,
  model: string | undefined,
): Promise<void> {
  const startedAt = Date.now();
  try {
    const result = service.sendPrompt
      ? await service.sendPrompt(session.sessionId, task, { timeoutMs, model })
      : await service.sendToSession(session.sessionId, task);
    if (result.error || result.stopReason === "error") {
      emitSessionEvent(service, session.sessionId, "error", {
        message: result.error ?? "acpx prompt ended with stopReason error",
        stopReason: result.stopReason,
      });
      throw new Error(result.error ?? "acpx prompt failed");
    }
    emitSessionEvent(service, session.sessionId, "task_complete", {
      response: result.finalText || result.response,
      durationMs: result.durationMs || Date.now() - startedAt,
      stopReason: result.stopReason,
    });
  } catch (error) {
    emitSessionEvent(service, session.sessionId, "error", {
      message: failureMessage(error),
    });
    throw error;
  } finally {
    try {
      await service.stopSession(session.sessionId);
    } finally {
      emitSessionEvent(service, session.sessionId, "stopped", {
        sessionId: session.sessionId,
      });
    }
  }
}

export const createTaskAction = {
  name: "CREATE_TASK",
  roleGate: { minRole: "OWNER" },
  similes: [
    "START_CODING_TASK",
    "LAUNCH_CODING_TASK",
    "RUN_CODING_TASK",
    "START_AGENT_TASK",
    "SPAWN_AND_PROVISION",
    "CODE_THIS",
    "LAUNCH_TASK",
    "CREATE_SUBTASK",
  ],
  description:
    "Create one or more asynchronous task agents for any open-ended multi-step job. Agents can code, debug, research, write, analyze, plan, document, and automate while the main agent remains available.",
  suppressPostActionContinuation: true,
  parameters: [
    {
      name: "repo",
      description: "Repository URL or slug",
      required: false,
      schema: { type: "string" },
    },
    {
      name: "agentType",
      description: "Agent type to launch",
      required: false,
      schema: { type: "string" },
    },
    {
      name: "task",
      description: "Task prompt",
      required: false,
      schema: { type: "string" },
    },
    {
      name: "agents",
      description: "Pipe-delimited multi-agent task list",
      required: false,
      schema: { type: "string" },
    },
    {
      name: "memoryContent",
      description: "Additional memory/context",
      required: false,
      schema: { type: "string" },
    },
    {
      name: "label",
      description: "Task label",
      required: false,
      schema: { type: "string" },
    },
    {
      name: "approvalPreset",
      description: "Approval policy",
      required: false,
      schema: {
        type: "string",
        enum: ["readonly", "standard", "permissive", "autonomous"],
      },
    },
    {
      name: "validator",
      description: "Optional verifier",
      required: false,
      schema: { type: "object" },
    },
    {
      name: "maxRetries",
      description: "Verifier retry count",
      required: false,
      schema: { type: "integer", minimum: 0 },
    },
    {
      name: "onVerificationFail",
      description: "Verifier failure behavior",
      required: false,
      schema: { type: "string", enum: ["retry", "escalate"] },
    },
    {
      name: "metadata",
      description: "Additional metadata",
      required: false,
      schema: { type: "object" },
    },
  ],
  validate: async (runtime, message) => {
    if (!getAcpService(runtime)) return false;
    if (
      hasExplicitPayload(message, [
        "task",
        "repo",
        "workdir",
        "agents",
        "agentType",
      ])
    )
      return true;
    const text = messageText(message);
    if (!text.trim()) return true;
    if (looksLikeLifeOpsRequest(text)) return false;
    return looksLikeTaskAgentRequest(text);
  },
  handler: async (
    runtime,
    message,
    state,
    options,
    callback,
  ): Promise<ActionResult> => {
    const service = getAcpService(runtime);
    if (!service) {
      const text =
        "ACP subprocess service is not available. Install acpx and ensure @elizaos/plugin-acpx is loaded.";
      await callbackText(callback, text);
      return errorResult("SERVICE_UNAVAILABLE");
    }

    const params = paramsRecord(options as HandlerOptionsLike | undefined);
    const content = contentRecord(message);
    const text = messageText(message);
    const tasks = taskParts(params, content, text);
    if (tasks.length > MAX_CONCURRENT_AGENTS) {
      const msg = `Too many task agents requested (${tasks.length}); maximum is ${MAX_CONCURRENT_AGENTS}.`;
      await callbackText(callback, msg);
      return errorResult("TOO_MANY_AGENTS", msg);
    }

    const baseAgentType =
      pickString(params, content, "agentType") ??
      String(
        (await service.resolveAgentType?.({
          task: tasks[0],
          subtaskCount: tasks.length,
        })) ?? "codex",
      );
    const workdir = pickString(params, content, "workdir") ?? process.cwd();
    const model = pickString(params, content, "model");
    const memoryContent = pickString(params, content, "memoryContent");
    const approvalPreset = parseApproval(
      pickString(params, content, "approvalPreset"),
    );
    const timeoutMs = getTimeoutMs(params, content);
    const baseLabel = pickString(params, content, "label");
    const settled = await Promise.allSettled(
      tasks.map(async (part, index) => {
        const parsed = parseAgentPrefix(part, baseAgentType);
        const task = parsed.task;
        const agentType = parsed.agentType as AgentType;
        const label = baseLabel ?? labelFrom(task, index);
        const session = await service.spawnSession({
          agentType,
          workdir,
          memoryContent,
          approvalPreset,
          model,
          timeoutMs,
          metadata: {
            requestedType: baseAgentType,
            messageId: message.id,
            roomId: message.roomId,
            worldId: message.worldId,
            userId: message.entityId,
            label,
            source: content.source,
          },
        });
        await runPromptAndClose(service, session, task, timeoutMs, model);
        return { session, label, agentType };
      }),
    );

    const results: Array<Record<string, unknown>> = [];
    const sessions: SpawnResult[] = [];
    for (const [index, outcome] of settled.entries()) {
      if (outcome.status === "fulfilled") {
        const { session, label } = outcome.value;
        sessions.push(session);
        results.push({
          id: session.sessionId,
          sessionId: session.sessionId,
          agentType: session.agentType,
          name: session.name,
          workdir: session.workdir,
          label,
          status: "completed",
        });
        continue;
      }
      const part = tasks[index];
      const parsed = parseAgentPrefix(part, baseAgentType);
      const agentType = parsed.agentType as AgentType;
      const label = baseLabel ?? labelFrom(parsed.task, index);
      const msg = failureMessage(outcome.reason);
      logger(runtime).error?.("CREATE_TASK launch failed", {
        error: msg,
        agentType,
        workdir,
      });
      results.push({
        sessionId: "",
        id: "",
        agentType,
        workdir,
        label,
        status: "failed",
        error: msg,
      });
    }

    setCurrentSessions(state, sessions);
    const failed = results.filter((result) => result.status === "failed");
    if (failed.length > 0) {
      const textOut = `I started some task agents, but ${failed.length} failed to launch: ${failed.map((item) => String(item.error)).join("; ")}.`;
      await callbackText(callback, textOut);
      return {
        success: false,
        text: textOut,
        data: { agents: results, suppressActionResultClipboard: true },
      };
    }

    return {
      success: true,
      text: "",
      data: { agents: results, suppressActionResultClipboard: true },
    };
  },
} as Action & { suppressPostActionContinuation: true };

export const startCodingTaskAction = createTaskAction;
