/**
 * Provider that injects active workspace and task-agent context into every prompt.
 *
 * Eliza needs to know what workspaces exist, which agents are running, and
 * their current status. This provider reads from the workspace service, PTY
 * service, and coordinator to build a live context summary that's always
 * available in the prompt.
 *
 * @module providers/active-workspace-context
 */

import type { IAgentRuntime, Memory, Provider, State } from "@elizaos/core";
import type { PTYService } from "../services/pty-service.js";
import { getCoordinator } from "../services/pty-service.js";
import type { SessionInfo } from "../services/pty-types.js";
import {
  formatTaskAgentStatus,
  getTaskAgentFrameworkState,
  TASK_AGENT_FRAMEWORK_LABELS,
  truncateTaskAgentText,
} from "../services/task-agent-frameworks.js";
import type {
  CodingWorkspaceService,
  WorkspaceResult,
} from "../services/workspace-service.js";

interface TaskLike {
  sessionId: string;
  agentType: string;
  label: string;
  originalTask: string;
  status: string;
  decisions: Array<{ reasoning?: string }>;
  completionSummary?: string;
  registeredAt: number;
}

type FrameworkState = Awaited<ReturnType<typeof getTaskAgentFrameworkState>>;

const FALLBACK_FRAMEWORK_STATE: FrameworkState = {
  configuredSubscriptionProvider: undefined,
  frameworks: [],
  preferred: {
    id: "codex",
    reason: "Task-agent framework state unavailable.",
  },
};

function uniqueTasks(tasks: TaskLike[]): TaskLike[] {
  const seen = new Set<string>();
  const result: TaskLike[] = [];
  for (const task of tasks) {
    if (seen.has(task.sessionId)) continue;
    seen.add(task.sessionId);
    result.push(task);
  }
  return result;
}

export const activeWorkspaceContextProvider: Provider = {
  name: "ACTIVE_WORKSPACE_CONTEXT",
  description:
    "Live status of active workspaces, task-agent sessions, and current task progress",
  descriptionCompressed:
    "Live status of workspaces, task agents, and progress.",
  position: 1,
  contexts: ["code", "tasks", "agent_internal"],
  contextGate: { anyOf: ["code", "tasks", "agent_internal"] },
  cacheStable: false,
  cacheScope: "turn",

  get: async (runtime: IAgentRuntime, _message: Memory, _state: State) => {
    const ptyService = runtime.getService("PTY_SERVICE") as unknown as
      | PTYService
      | undefined;
    const wsService = runtime.getService(
      "CODING_WORKSPACE_SERVICE",
    ) as unknown as CodingWorkspaceService | undefined;
    const coordinator = getCoordinator(runtime);
    let frameworkState = FALLBACK_FRAMEWORK_STATE;
    try {
      frameworkState = await getTaskAgentFrameworkState(runtime, ptyService);
    } catch {
      frameworkState = FALLBACK_FRAMEWORK_STATE;
    }

    let sessions: SessionInfo[] = [];
    if (ptyService) {
      try {
        sessions = await Promise.race([
          ptyService.listSessions(),
          new Promise<SessionInfo[]>((resolve) =>
            setTimeout(() => resolve([]), 2000),
          ),
        ]);
      } catch {
        sessions = [];
      }
    }

    let workspaces: WorkspaceResult[] = [];
    try {
      workspaces = wsService?.listWorkspaces() ?? [];
    } catch {
      workspaces = [];
    }
    const tasks = uniqueTasks(
      ((coordinator?.getAllTaskContexts?.() ?? []) as TaskLike[]).slice(),
    );
    const reusableSessions = sessions.filter((session) => {
      const currentTask = tasks.find((task) => task.sessionId === session.id);
      return !currentTask || currentTask.status !== "active";
    });

    const lines: string[] = [
      "active_workspace_context:",
      `  preferredFramework: ${TASK_AGENT_FRAMEWORK_LABELS[frameworkState.preferred.id]}`,
      `  preferredReason: ${frameworkState.preferred.reason}`,
      `  workspaceCount: ${workspaces.length}`,
      `  sessionCount: ${sessions.length}`,
      `  taskCount: ${tasks.length}`,
    ];

    if (
      workspaces.length === 0 &&
      sessions.length === 0 &&
      tasks.length === 0
    ) {
      lines.push("guidance:");
      lines.push(
        "  createTask: Use ACPX CREATE_AGENT_TASK when the user needs anything more involved than a simple direct reply.",
      );
    } else {
      if (workspaces.length > 0) {
        lines.push(
          `workspaces[${workspaces.length}]{label,repo,branch,agents}:`,
        );
        for (const workspace of workspaces) {
          const workspaceSessions = sessions.filter(
            (session) => session.workdir === workspace.path,
          );
          const agentSummary =
            workspaceSessions.length > 0
              ? workspaceSessions
                  .map(
                    (session) =>
                      `${session.agentType}:${formatTaskAgentStatus(session.status)}`,
                  )
                  .join(", ")
              : "no task agents";
          lines.push(
            `  ${workspace.label ?? workspace.id.slice(0, 8)},${workspace.repo ?? "scratch"},${workspace.branch ?? "no branch"},${agentSummary}`,
          );
        }
      }

      const trackedPaths = new Set(
        workspaces.map((workspace) => workspace.path),
      );
      const standaloneSessions = sessions.filter(
        (session) => !trackedPaths.has(session.workdir),
      );

      if (standaloneSessions.length > 0) {
        lines.push(
          `standaloneSessions[${standaloneSessions.length}]{label,agentType,status,sessionId}:`,
        );
        for (const session of standaloneSessions) {
          const label =
            typeof session.metadata?.label === "string"
              ? session.metadata.label
              : session.name;
          lines.push(
            `  ${label},${session.agentType},${formatTaskAgentStatus(session.status)},${session.id}`,
          );
        }
      }

      if (tasks.length > 0) {
        lines.push(`tasks[${tasks.length}]{status,label,agentType,detail}:`);
        for (const task of tasks
          .slice()
          .sort((left, right) => right.registeredAt - left.registeredAt)) {
          const latestDecision = task.decisions.at(-1);
          const detail =
            task.completionSummary ||
            latestDecision?.reasoning ||
            truncateTaskAgentText(task.originalTask, 110);
          lines.push(
            `  ${task.status},${task.label},${task.agentType},${detail.replace(/\s+/g, " ").trim()}`,
          );
        }
      }

      const pending = coordinator?.getPendingConfirmations?.() ?? [];
      if (pending.length > 0) {
        lines.push("pendingConfirmations:");
        lines.push(`  count: ${pending.length}`);
        lines.push(
          `  supervision: ${coordinator?.getSupervisionLevel?.() ?? "unknown"}`,
        );
        lines.push(
          `pendingItems[${pending.length}]{label,prompt,suggestedAction}:`,
        );
        for (const confirmation of pending) {
          lines.push(
            `  ${confirmation.taskContext.label},${truncateTaskAgentText(confirmation.promptText, 140)},${confirmation.llmDecision.action ?? "review"}`,
          );
        }
      }

      if (reusableSessions.length > 0) {
        lines.push(
          `reusableAgents[${reusableSessions.length}]{label,agentType,status,nextAction}:`,
        );
        for (const session of reusableSessions) {
          const label =
            typeof session.metadata?.label === "string"
              ? session.metadata.label
              : session.name;
          lines.push(
            `  ${label},${session.agentType},${formatTaskAgentStatus(session.status)},SEND_TO_AGENT`,
          );
        }
      }
    }

    if (sessions.length > 0 || tasks.length > 0) {
      lines.push("actions:");
      lines.push("  unblockOrAssign: SEND_TO_AGENT");
      lines.push("  inspectProgress: provider.active_workspace_context");
      lines.push("  cancel: STOP_AGENT");
      lines.push("  wrapUp: FINALIZE_WORKSPACE");
    }

    const text = lines.join("\n");
    return {
      data: {
        activeWorkspaces: workspaces.map((ws: WorkspaceResult) => ({
          id: ws.id,
          label: ws.label,
          repo: ws.repo,
          branch: ws.branch,
          path: ws.path,
        })),
        activeSessions: sessions.map((session) => ({
          id: session.id,
          label:
            typeof session.metadata?.label === "string"
              ? session.metadata.label
              : session.name,
          agentType: session.agentType,
          status: session.status,
          workdir: session.workdir,
        })),
        currentTasks: tasks,
        preferredTaskAgent: frameworkState.preferred,
        frameworks: frameworkState.frameworks,
      },
      values: { activeWorkspaceContext: text },
      text,
    };
  },
};
