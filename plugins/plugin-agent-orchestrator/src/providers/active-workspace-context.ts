/**
 * Provider that injects active workspace and task-agent context into every prompt.
 *
 * Eliza needs to know what workspaces exist, which agents are running, and
 * their current status. This provider reads from the workspace service and ACP
 * service to build a live context summary that's always
 * available in the prompt.
 */

import type { IAgentRuntime, Memory, Provider, State } from "@elizaos/core";
import {
  getAcpService,
  reportProviderFetchFailure,
} from "../actions/common.js";
import {
  formatTaskAgentStatus,
  getTaskAgentFrameworkState,
  TASK_AGENT_FRAMEWORK_LABELS,
} from "../services/task-agent-frameworks.js";
import type { SessionInfo } from "../services/types.js";
import type { WorkspaceResult } from "../services/workspace-service.js";
import { getCodingWorkspaceService } from "../services/workspace-service.js";

type FrameworkState = Awaited<ReturnType<typeof getTaskAgentFrameworkState>>;

// Unique sentinel so a genuine empty session list is distinguishable from the
// 2s timeout branch of the Promise.race (a hung backend, not "no sessions").
const SESSIONS_TIMEOUT_SENTINEL: SessionInfo[] = [];

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
    // Tracks whether a live-state read FAILED (backend threw) vs. was genuinely
    // empty. A failed read must not read to the planner as a clean slate: the
    // ACP/workspace backend could be hiding running sessions, and "clean slate"
    // guidance would prompt DUPLICATE spawns (#12273 exemplar 2).
    let degraded = false;
    let frameworkState = FALLBACK_FRAMEWORK_STATE;
    try {
      frameworkState = await getTaskAgentFrameworkState(runtime, acpService);
    } catch (err) {
      // error-policy:J7 framework probe failed — surface it (was invisible
      // debug) and fall back, but flag the whole context as degraded.
      reportProviderFetchFailure(
        runtime,
        "ACTIVE_WORKSPACE_CONTEXT",
        "getTaskAgentFrameworkState",
        err,
      );
      frameworkState = FALLBACK_FRAMEWORK_STATE;
      degraded = true;
    }

    let sessions: SessionInfo[] = [];
    if (acpService) {
      try {
        sessions = await Promise.race([
          Promise.resolve(acpService.listSessions()),
          // error-policy:J4 2s cap keeps a hung ACP backend from stalling every
          // turn; the timeout branch is treated as a degraded read below, not a
          // fabricated "no sessions" — see the sentinel wrap.
          new Promise<SessionInfo[]>((resolve) =>
            setTimeout(() => resolve(SESSIONS_TIMEOUT_SENTINEL), 2000),
          ),
        ]);
        if (sessions === SESSIONS_TIMEOUT_SENTINEL) {
          // Hung backend past the 2s cap — unknown, not empty. Flag degraded so
          // the planner doesn't read the empty session set as authoritative.
          reportProviderFetchFailure(
            runtime,
            "ACTIVE_WORKSPACE_CONTEXT",
            "listSessions:timeout",
            new Error("ACP listSessions exceeded 2000ms"),
          );
          sessions = [];
          degraded = true;
        }
      } catch (err) {
        // error-policy:J7 listSessions threw — backend down, not zero sessions.
        reportProviderFetchFailure(
          runtime,
          "ACTIVE_WORKSPACE_CONTEXT",
          "listSessions",
          err,
        );
        sessions = [];
        degraded = true;
      }
    }

    let workspaces: WorkspaceResult[] = [];
    try {
      workspaces = wsService?.listWorkspaces() ?? [];
    } catch (err) {
      // error-policy:J7 workspace listing threw — surface + flag degraded.
      reportProviderFetchFailure(
        runtime,
        "ACTIVE_WORKSPACE_CONTEXT",
        "listWorkspaces",
        err,
      );
      workspaces = [];
      degraded = true;
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

    // A degraded read means one or more live-state backends failed, so the
    // counts above are a floor, not the truth. Tell the planner explicitly so
    // it doesn't treat an empty/partial context as a clean slate and spawn
    // duplicate work over sessions it simply can't see.
    if (degraded) {
      lines.push("  status: degraded");
      lines.push(
        "  degradedNote: A live-state backend (task-agent/workspace service) failed to respond, so the counts above may be INCOMPLETE. Do NOT assume there are no running sessions or workspaces. Before spawning a new task, verify with the user or retry; treat this as 'unknown', not 'clean slate'.",
      );
    }

    if (!degraded && workspaces.length === 0 && sessions.length === 0) {
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
        // True when a live-state read failed; the counts above are then a
        // floor, not authoritative ground truth.
        degraded,
      },
      values: { activeWorkspaceContext: text },
      text,
    };
  },
};
