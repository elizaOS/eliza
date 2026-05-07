import type {
  Action,
  ActionResult,
  HandlerCallback,
  HandlerOptions,
  IAgentRuntime,
  Memory,
  State,
} from "@elizaos/core";
import { getCoordinator } from "../services/pty-service.js";
import { requireTaskAgentAccess } from "../services/task-policy.js";
import { resolveTaskThreadTarget } from "./task-thread-target.js";

const deprecatedActionWarnings = new Set<string>();

function warnDeprecatedSpawnSurface(
  actionName: string,
  replacement: string,
): void {
  if (deprecatedActionWarnings.has(actionName)) return;
  deprecatedActionWarnings.add(actionName);
  console.warn(
    `[plugin-agent-orchestrator] ${actionName} is deprecated. Use ${replacement} from @elizaos/plugin-acpx instead.`,
  );
}
type TaskControlOperation =
  | "pause"
  | "stop"
  | "resume"
  | "continue"
  | "archive"
  | "reopen";

function textValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : undefined;
}

function inferOperation(
  text: string,
  value?: string,
): TaskControlOperation | null {
  const normalized = value?.trim().toLowerCase();
  if (
    normalized === "pause" ||
    normalized === "stop" ||
    normalized === "resume" ||
    normalized === "continue" ||
    normalized === "archive" ||
    normalized === "reopen"
  ) {
    return normalized;
  }
  if (/\barchive\b/i.test(text)) return "archive";
  if (/\breopen\b/i.test(text)) return "reopen";
  if (/\bpause\b|\bhold on\b|\bthat's not right\b/i.test(text)) return "pause";
  if (/\bstop\b|\bcancel\b|\bkill\b/i.test(text)) return "stop";
  if (/\bresume\b|\bmake it so\b|\bdo it\b|\byea(h)? i'm down\b/i.test(text)) {
    return "resume";
  }
  if (/\bcontinue\b|\bgo ahead\b/i.test(text)) return "continue";
  return null;
}

/**
 * @deprecated The plugin-agent-orchestrator PTY spawn surface is deprecated.
 * Use @elizaos/plugin-acpx session control actions instead. This action remains during the migration window.
 */
export const taskControlAction: Action = {
  name: "TASK_CONTROL",
  similes: [
    "CONTROL_TASK",
    "PAUSE_TASK",
    "RESUME_TASK",
    "STOP_TASK",
    "CONTINUE_TASK",
    "ARCHIVE_TASK",
    "REOPEN_TASK",
  ],
  description:
    "Pause, stop, resume, continue, archive, or reopen a coordinator task thread while preserving the durable thread history.",
  descriptionCompressed:
    "Pause/stop/resume/archive/reopen coordinator task thread.",
  examples: [
    [
      {
        name: "{{user1}}",
        content: {
          text: "Hold on a second, can you pause that and let's discuss if it's right?",
        },
      },
      {
        name: "{{agentName}}",
        content: {
          text: "I'll pause the current task thread and preserve its state.",
          action: "TASK_CONTROL",
        },
      },
    ],
    [
      {
        name: "{{user1}}",
        content: { text: "Stop, stop, stop doing what you're doing." },
      },
      {
        name: "{{agentName}}",
        content: {
          text: "I'll stop the running task thread and keep the history intact.",
          action: "TASK_CONTROL",
        },
      },
    ],
  ],
  validate: async (runtime: IAgentRuntime): Promise<boolean> => {
    return Boolean(getCoordinator(runtime));
  },
  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    state?: State,
    options?: HandlerOptions,
    callback?: HandlerCallback,
  ): Promise<ActionResult | undefined> => {
    warnDeprecatedSpawnSurface(
      "taskControlAction",
      "@elizaos/plugin-acpx session control actions",
    );
    const access = await requireTaskAgentAccess(runtime, message, "interact");
    if (!access.allowed) {
      if (callback) {
        await callback({ text: access.reason });
      }
      return { success: false, error: "FORBIDDEN", text: access.reason };
    }

    const coordinator = getCoordinator(runtime);
    if (!coordinator) {
      if (callback) {
        await callback({ text: "Coordinator is not available." });
      }
      return { success: false, error: "SERVICE_UNAVAILABLE" };
    }

    const params =
      (options?.parameters as Record<string, unknown> | undefined) ?? {};
    const content = (message.content ?? {}) as Record<string, unknown>;
    const text = typeof content.text === "string" ? content.text : "";
    const operation = inferOperation(
      text,
      textValue(params.operation) ?? textValue(content.operation),
    );

    if (!operation) {
      if (callback) {
        await callback({
          text: "No task-control operation was specified. Use pause, stop, resume, continue, archive, or reopen.",
        });
      }
      return { success: false, error: "INVALID_OPERATION" };
    }

    const thread = await resolveTaskThreadTarget({
      coordinator,
      message,
      state,
      options: params,
      includeArchived: operation === "reopen" || operation === "archive",
    });
    if (!thread) {
      if (callback) {
        await callback({ text: "I could not find a matching task thread." });
      }
      return { success: false, error: "THREAD_NOT_FOUND" };
    }

    const note =
      textValue(params.note) ??
      textValue(content.note) ??
      (text.length > 0 ? text : undefined);
    const instruction =
      textValue(params.instruction) ??
      textValue(content.instruction) ??
      (operation === "continue" || operation === "resume" ? text : undefined);
    const requestedAgentType =
      textValue(params.agentType) ?? textValue(content.agentType);

    let responseText = "";
    let data: Record<string, unknown> = { threadId: thread.id, operation };

    if (operation === "pause") {
      const result = await coordinator.pauseTaskThread(thread.id, note);
      responseText = `Paused "${thread.title}" and preserved the thread for follow-up discussion.`;
      data = { ...data, ...result };
    } else if (operation === "stop") {
      const result = await coordinator.stopTaskThread(thread.id, note);
      responseText = `Stopped "${thread.title}" and kept the thread history intact.`;
      data = { ...data, ...result };
    } else if (operation === "archive") {
      await coordinator.archiveTaskThread(thread.id);
      responseText = `Archived "${thread.title}".`;
    } else if (operation === "reopen") {
      await coordinator.reopenTaskThread(thread.id);
      responseText = `Reopened "${thread.title}".`;
    } else if (operation === "continue") {
      const nextInstruction =
        instruction?.trim() || `Continue the task "${thread.title}".`;
      const result = await coordinator.continueTaskThread(
        thread.id,
        nextInstruction,
        requestedAgentType,
      );
      responseText = result.reusedSession
        ? `Sent follow-up instructions to "${thread.title}" on the existing task session.`
        : `Resumed "${thread.title}" on a new task session.`;
      data = { ...data, ...result };
    } else {
      const result = await coordinator.resumeTaskThread(
        thread.id,
        instruction?.trim() || undefined,
        requestedAgentType,
      );
      responseText = result.reusedSession
        ? `Resumed "${thread.title}" on the current task session.`
        : `Resumed "${thread.title}" on a new task session.`;
      data = { ...data, ...result };
    }

    if (callback) {
      await callback({ text: responseText });
    }
    return {
      success: true,
      text: responseText,
      data: data as ActionResult["data"],
    };
  },
  parameters: [
    {
      name: "operation",
      description: "Control operation to apply to the task thread.",
      required: true,
      schema: {
        type: "string" as const,
        enum: ["pause", "stop", "resume", "continue", "archive", "reopen"],
      },
    },
    {
      name: "threadId",
      description: "Specific task thread id to control.",
      required: false,
      schema: { type: "string" as const },
    },
    {
      name: "sessionId",
      description: "Task session id to resolve into a thread when needed.",
      required: false,
      schema: { type: "string" as const },
    },
    {
      name: "search",
      description: "Search text used to find the relevant thread.",
      descriptionCompressed: "Search text for finding relevant thread.",
      required: false,
      schema: { type: "string" as const },
    },
    {
      name: "note",
      description: "Optional reason for pausing or stopping the thread.",
      required: false,
      schema: { type: "string" as const },
    },
    {
      name: "instruction",
      description: "Follow-up instruction for resume or continue operations.",
      required: false,
      schema: { type: "string" as const },
    },
    {
      name: "agentType",
      description: "Optional framework override for a resumed task.",
      required: false,
      schema: { type: "string" as const },
    },
  ],
};
