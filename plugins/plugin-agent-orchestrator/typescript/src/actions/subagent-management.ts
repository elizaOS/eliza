import type {
  Action,
  ActionResult,
  HandlerCallback,
  HandlerOptions,
  IAgentRuntime,
  Memory,
  State,
  UUID,
} from "@elizaos/core";
import type { SubagentService } from "../services/subagent-service.js";
import {
  extractAgentIdFromSessionKey,
  formatDurationShort,
  sessionKeyToRoomId,
} from "../utils/session.js";

function getSubagentService(runtime: IAgentRuntime): SubagentService {
  const svc = runtime.getService("SUBAGENT") as SubagentService | null;
  if (!svc) {
    throw new Error("SubagentService not available (SUBAGENT)");
  }
  return svc;
}

function extractSessionContext(
  runtime: IAgentRuntime,
  message: Memory,
): { sessionKey?: string; roomId?: UUID } {
  const metadata = message.content?.metadata as Record<string, unknown> | undefined;
  const sessionKey = typeof metadata?.sessionKey === "string" ? metadata.sessionKey : undefined;

  const result: { sessionKey?: string; roomId?: UUID } = {};
  if (sessionKey) result.sessionKey = sessionKey;
  if (message.roomId) result.roomId = message.roomId;
  return result;
}

// ============================================================================
// SPAWN_SUBAGENT
// ============================================================================

export const spawnSubagentAction: Action = {
  name: "SPAWN_SUBAGENT",
  similes: ["SPAWN_TASK", "BACKGROUND_TASK", "START_SUBAGENT", "SESSIONS_SPAWN", "CREATE_SUBAGENT"],
  description:
    "Spawn a background sub-agent run to execute a task asynchronously. The subagent will complete the task and announce results back.",
  validate: async (runtime: IAgentRuntime, message: Memory): Promise<boolean> => {
    // Check if subagent service is available
    const svc = runtime.getService("SUBAGENT");
    if (!svc) {
      return false;
    }

    const text = message.content.text?.toLowerCase() ?? "";
    const hasSpawnIntent =
      text.includes("spawn") ||
      text.includes("background") ||
      text.includes("subagent") ||
      text.includes("async task");
    const hasTaskWords =
      text.includes("task") ||
      text.includes("research") ||
      text.includes("investigate") ||
      text.includes("analyze") ||
      text.includes("look into");
    return hasSpawnIntent || (hasTaskWords && text.includes("in background"));
  },
  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    _state?: State,
    options?: HandlerOptions,
    callback?: HandlerCallback,
  ): Promise<ActionResult> => {
    const svc = getSubagentService(runtime);
    const context = extractSessionContext(runtime, message);

    const opts = options as
      | {
          task?: string;
          label?: string;
          agentId?: string;
          model?: string;
          thinking?: string;
          timeoutSeconds?: number;
          cleanup?: "delete" | "keep";
        }
      | undefined;

    const task = opts?.task ?? message.content.text ?? "";
    if (!task.trim()) {
      const msg = "Please specify a task for the subagent to execute.";
      await callback?.({ content: { text: msg } });
      return { success: false, text: msg };
    }

    // Build spawn params, only including defined optional properties
    const spawnParams: Parameters<typeof svc.spawnSubagent>[0] = {
      task,
      runTimeoutSeconds: opts?.timeoutSeconds ?? 300,
      cleanup: opts?.cleanup ?? "keep",
    };
    if (opts?.label) spawnParams.label = opts.label;
    if (opts?.agentId) spawnParams.agentId = opts.agentId;
    if (opts?.model) spawnParams.model = opts.model;
    if (opts?.thinking) spawnParams.thinking = opts.thinking;

    const result = await svc.spawnSubagent(spawnParams, context);

    if (result.status !== "accepted") {
      const msg = `Failed to spawn subagent: ${result.error ?? "unknown error"}`;
      await callback?.({ content: { text: msg } });
      return { success: false, text: msg };
    }

    const labelText = opts?.label ? ` "${opts.label}"` : "";
    const msg = `Spawned background task${labelText}. Run ID: ${result.runId?.slice(0, 8)}...\nI'll announce results when complete.`;

    await callback?.({ content: { text: msg } });

    return {
      success: true,
      text: msg,
      data: {
        runId: result.runId,
        childSessionKey: result.childSessionKey,
        childRoomId: result.childRoomId,
      },
    };
  },
};

// ============================================================================
// SEND_TO_SESSION
// ============================================================================

export const sendToSessionAction: Action = {
  name: "SEND_TO_SESSION",
  similes: ["SESSIONS_SEND", "SEND_MESSAGE", "MESSAGE_AGENT", "A2A_SEND"],
  description:
    "Send a message to another agent session. Use sessionKey or label to identify the target.",
  validate: async (runtime: IAgentRuntime, message: Memory): Promise<boolean> => {
    // Check if subagent service is available
    const svc = runtime.getService("SUBAGENT");
    if (!svc) {
      return false;
    }

    const text = message.content.text?.toLowerCase() ?? "";
    return (
      text.includes("send to session") ||
      text.includes("message session") ||
      (text.includes("send") && text.includes("agent")) ||
      text.includes("sessions_send")
    );
  },
  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    _state?: State,
    options?: HandlerOptions,
    callback?: HandlerCallback,
  ): Promise<ActionResult> => {
    const svc = getSubagentService(runtime);
    const context = extractSessionContext(runtime, message);

    const opts = options as
      | {
          sessionKey?: string;
          label?: string;
          agentId?: string;
          message?: string;
          timeoutSeconds?: number;
        }
      | undefined;

    const targetMessage = opts?.message ?? message.content.text ?? "";
    if (!targetMessage.trim()) {
      const msg = "Please specify a message to send.";
      await callback?.({ content: { text: msg } });
      return { success: false, text: msg };
    }

    if (!opts?.sessionKey && !opts?.label) {
      const msg = "Please specify either a sessionKey or label to identify the target session.";
      await callback?.({ content: { text: msg } });
      return { success: false, text: msg };
    }

    // Build send params, only including defined optional properties
    const sendParams: Parameters<typeof svc.sendToAgent>[0] = {
      message: targetMessage,
      timeoutSeconds: opts?.timeoutSeconds ?? 30,
    };
    if (opts?.sessionKey) sendParams.sessionKey = opts.sessionKey;
    if (opts?.label) sendParams.label = opts.label;
    if (opts?.agentId) sendParams.agentId = opts.agentId;

    const result = await svc.sendToAgent(sendParams, context);

    if (result.status === "forbidden") {
      const msg = `Access denied: ${result.error}`;
      await callback?.({ content: { text: msg } });
      return { success: false, text: msg };
    }

    if (result.status === "error") {
      const msg = `Failed to send message: ${result.error ?? "unknown error"}`;
      await callback?.({ content: { text: msg } });
      return { success: false, text: msg };
    }

    if (result.status === "timeout") {
      const msg = `Request timed out waiting for response.`;
      await callback?.({ content: { text: msg } });
      return { success: false, text: msg };
    }

    const replyText = result.reply ? `\n\nReply: ${result.reply}` : "";
    const msg = `Message sent to ${result.sessionKey}.${replyText}`;

    await callback?.({ content: { text: msg } });

    return {
      success: true,
      text: msg,
      data: {
        runId: result.runId,
        sessionKey: result.sessionKey,
        reply: result.reply,
      },
    };
  },
};

// ============================================================================
// LIST_SUBAGENTS
// ============================================================================

export const listSubagentsAction: Action = {
  name: "LIST_SUBAGENTS",
  similes: ["SHOW_SUBAGENTS", "SUBAGENT_STATUS", "RUNNING_TASKS"],
  description: "List active and recent subagent runs.",
  validate: async (runtime: IAgentRuntime, message: Memory): Promise<boolean> => {
    // Check if subagent service is available
    const svc = runtime.getService("SUBAGENT");
    if (!svc) {
      return false;
    }

    const text = message.content.text?.toLowerCase() ?? "";
    return (
      text.includes("list subagent") ||
      text.includes("show subagent") ||
      text.includes("subagent status") ||
      text.includes("running task") ||
      text.includes("background task")
    );
  },
  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    _state?: State,
    _options?: HandlerOptions,
    callback?: HandlerCallback,
  ): Promise<ActionResult> => {
    const svc = getSubagentService(runtime);
    const context = extractSessionContext(runtime, message);

    const runs = svc.listSubagentRuns(context.sessionKey);

    if (runs.length === 0) {
      const msg = "No subagent runs found.";
      await callback?.({ content: { text: msg } });
      return { success: true, text: msg };
    }

    const lines: string[] = ["Subagent Runs:"];

    for (const run of runs.slice(0, 20)) {
      const status = run.outcome?.status ?? (run.endedAt ? "done" : "running");
      const duration = run.endedAt
        ? formatDurationShort(run.endedAt - (run.startedAt ?? run.createdAt))
        : "...";
      const label = run.label || run.task.slice(0, 40);
      lines.push(`- [${status}] ${label} (${duration})`);
    }

    const msg = lines.join("\n");
    await callback?.({ content: { text: msg } });

    return {
      success: true,
      text: msg,
      data: { count: runs.length },
    };
  },
};

// ============================================================================
// CANCEL_SUBAGENT
// ============================================================================

export const cancelSubagentAction: Action = {
  name: "CANCEL_SUBAGENT",
  similes: ["STOP_SUBAGENT", "ABORT_TASK", "KILL_SUBAGENT"],
  description: "Cancel a running subagent by its run ID.",
  validate: async (runtime: IAgentRuntime, message: Memory): Promise<boolean> => {
    // Check if subagent service is available
    const svc = runtime.getService("SUBAGENT");
    if (!svc) {
      return false;
    }

    const text = message.content.text?.toLowerCase() ?? "";
    return (
      (text.includes("cancel") || text.includes("stop") || text.includes("abort")) &&
      (text.includes("subagent") || text.includes("background"))
    );
  },
  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    _state?: State,
    options?: HandlerOptions,
    callback?: HandlerCallback,
  ): Promise<ActionResult> => {
    const svc = getSubagentService(runtime);

    const opts = options as { runId?: string } | undefined;
    const runId = opts?.runId;

    if (!runId) {
      const msg = "Please specify the run ID to cancel. Use LIST_SUBAGENTS to see active runs.";
      await callback?.({ content: { text: msg } });
      return { success: false, text: msg };
    }

    const cancelled = svc.cancelSubagentRun(runId);

    if (!cancelled) {
      const msg = `No active run found with ID: ${runId.slice(0, 8)}...`;
      await callback?.({ content: { text: msg } });
      return { success: false, text: msg };
    }

    const msg = `Cancelled subagent run: ${runId.slice(0, 8)}...`;
    await callback?.({ content: { text: msg } });

    return { success: true, text: msg, data: { runId } };
  },
};

// ============================================================================
// GET_SUBAGENT_STATUS
// ============================================================================

export const getSubagentStatusAction: Action = {
  name: "GET_SUBAGENT_STATUS",
  similes: ["SUBAGENT_INFO", "TASK_STATUS", "CHECK_SUBAGENT"],
  description: "Get detailed status of a specific subagent run.",
  validate: async (runtime: IAgentRuntime, message: Memory): Promise<boolean> => {
    // Check if subagent service is available
    const svc = runtime.getService("SUBAGENT");
    if (!svc) {
      return false;
    }

    const text = message.content.text?.toLowerCase() ?? "";
    return (
      text.includes("subagent status") ||
      text.includes("task status") ||
      text.includes("check subagent") ||
      text.includes("subagent info")
    );
  },
  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    _state?: State,
    options?: HandlerOptions,
    callback?: HandlerCallback,
  ): Promise<ActionResult> => {
    const svc = getSubagentService(runtime);

    const opts = options as { runId?: string } | undefined;
    const runId = opts?.runId;

    if (!runId) {
      const msg = "Please specify the run ID to check. Use LIST_SUBAGENTS to see available runs.";
      await callback?.({ content: { text: msg } });
      return { success: false, text: msg };
    }

    const run = svc.getSubagentRun(runId);

    if (!run) {
      const msg = `No run found with ID: ${runId.slice(0, 8)}...`;
      await callback?.({ content: { text: msg } });
      return { success: false, text: msg };
    }

    const status = run.outcome?.status ?? (run.endedAt ? "done" : "running");
    const duration = run.endedAt
      ? formatDurationShort(run.endedAt - (run.startedAt ?? run.createdAt))
      : "in progress";

    const lines = [
      `## Subagent Run: ${runId.slice(0, 8)}...`,
      "",
      `**Status:** ${status}`,
      `**Task:** ${run.task}`,
      run.label ? `**Label:** ${run.label}` : undefined,
      `**Duration:** ${duration}`,
      `**Session:** ${run.childSessionKey}`,
      run.outcome?.error ? `**Error:** ${run.outcome.error}` : undefined,
    ].filter((l): l is string => l !== undefined);

    const msg = lines.join("\n");
    await callback?.({ content: { text: msg } });

    return { success: true, text: msg, data: { run } };
  },
};
