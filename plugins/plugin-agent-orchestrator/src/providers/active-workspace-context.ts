/**
 * Provider that injects active workspace and task-agent context into every prompt.
 *
 * Eliza needs to know what workspaces exist, which agents are running, and
 * their current status. This provider reads from the workspace service and ACP
 * service to build a live context summary that's always
 * available in the prompt.
 */

import type { IAgentRuntime, Memory, Provider, State } from "@elizaos/core";
import { getAcpService, logger } from "../actions/common.js";
import {
  formatTaskAgentStatus,
  getTaskAgentFrameworkState,
  TASK_AGENT_FRAMEWORK_LABELS,
} from "../services/task-agent-frameworks.js";
import type { SessionInfo } from "../services/types.js";
import type { WorkspaceResult } from "../services/workspace-service.js";
import { getCodingWorkspaceService } from "../services/workspace-service.js";

type FrameworkState = Awaited<ReturnType<typeof getTaskAgentFrameworkState>>;

const FALLBACK_FRAMEWORK_STATE: FrameworkState = {
  configuredSubscriptionProvider: undefined,
  frameworks: [],
  preferred: {
    id: "elizaos",
    reason: "Task-agent framework state unavailable.",
  },
};

export const activeWorkspaceContextProvider: Provider = {
  name: "ACTIVE_WORKSPACE_CONTEXT",
  description:
    "Live status of active coding workspaces and task-agent sessions",
  descriptionCompressed: "Live status of workspaces and task agents.",
  position: 1,
  contexts: ["code", "tasks", "agent_internal"],
  contextGate: { anyOf: ["code", "tasks", "agent_internal"] },
  cacheStable: false,
  cacheScope: "turn",
  // Live coding-workspace / task-agent state is operator context — admin+ only
  // (#12094 item 3).
  roleGate: { minRole: "ADMIN" },

  get: async (runtime: IAgentRuntime, _message: Memory, _state: State) => {
    const acpService = getAcpService(runtime);
    const wsService = getCodingWorkspaceService(runtime);
    let frameworkState = FALLBACK_FRAMEWORK_STATE;
    try {
      frameworkState = await getTaskAgentFrameworkState(runtime, acpService);
    } catch (err) {
      logger(runtime).debug?.(
        { error: err },
        "[activeWorkspaceContext] getTaskAgentFrameworkState failed",
      );
      frameworkState = FALLBACK_FRAMEWORK_STATE;
    }

    let sessions: SessionInfo[] = [];
    if (acpService) {
      try {
        sessions = await Promise.race([
          Promise.resolve(acpService.listSessions()),
          new Promise<SessionInfo[]>((resolve) =>
            setTimeout(() => resolve([]), 2000),
          ),
        ]);
      } catch (err) {
        logger(runtime).debug?.(
          { error: err },
          "[activeWorkspaceContext] listSessions failed",
        );
        sessions = [];
      }
    }

    let workspaces: WorkspaceResult[] = [];
    try {
      workspaces = wsService?.listWorkspaces() ?? [];
    } catch (err) {
      logger(runtime).debug?.(
        { error: err },
        "[activeWorkspaceContext] listWorkspaces failed",
      );
      workspaces = [];
    }
    // A session is reusable (safe to re-task via SEND_TO_AGENT) only when it is
    // idle — "ready" — not mid-turn (busy/running/tool_running) or terminal.
    // The prior filter compared against an always-empty task list, so it
    // advertised EVERY session (including busy, mid-turn ones) as reusable.
    const reusableSessions = sessions.filter(
      (session) => session.status === "ready",
    );

    const lines: string[] = [
      "active_workspace_context:",
      `  preferredFramework: ${TASK_AGENT_FRAMEWORK_LABELS[frameworkState.preferred.id]}`,
      `  preferredReason: ${frameworkState.preferred.reason}`,
      `  workspaceCount: ${workspaces.length}`,
      `  sessionCount: ${sessions.length}`,
    ];

    if (workspaces.length === 0 && sessions.length === 0) {
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
            `  ${workspace.label ?? workspace.id.slice(0, 8)},${workspace.repo},${workspace.branch},${agentSummary}`,
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

    if (sessions.length > 0) {
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
        // This provider surfaces workspace + session context only; durable task
        // state lives in OrchestratorTaskService and is surfaced elsewhere.
        currentTasks: [],
        preferredTaskAgent: frameworkState.preferred,
        frameworks: frameworkState.frameworks,
      },
      values: { activeWorkspaceContext: text },
      text,
    };
  },
};
