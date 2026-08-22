/**
 * `AVAILABLE_AGENTS` provider: the adapter inventory (which ACP coding backends
 * are installed and authenticated) plus a bounded list of recent/active
 * sessions, rendered into the planner context. Merges the `checkAvailableAgents`
 * inventory with framework state so shell-adapter backends still appear when
 * installed and auth-ready.
 */
import type { IAgentRuntime, Memory, Provider, State } from "@elizaos/core";
import {
  canonicalSessionId,
  getAcpService,
  labelFor,
  listSessionsWithin,
  reportProviderFetchFailure,
} from "../actions/common.js";
import {
  getTaskAgentFrameworkState,
  type TaskAgentFrameworkState,
} from "../services/task-agent-frameworks.js";
import {
  type SessionInfo,
  TERMINAL_SESSION_STATUSES,
} from "../services/types.js";

function sessionSortTime(session: SessionInfo): number {
  return new Date(session.lastActivityAt).getTime();
}

function sessionIsActive(session: SessionInfo): boolean {
  return !TERMINAL_SESSION_STATUSES.has(String(session.status));
}

function summarizeSessionsForPrompt(sessions: SessionInfo[]): SessionInfo[] {
  return sessions.slice().sort((a, b) => {
    const activeDelta = Number(sessionIsActive(b)) - Number(sessionIsActive(a));
    if (activeDelta !== 0) return activeDelta;
    return sessionSortTime(b) - sessionSortTime(a);
  });
}

export const availableAgentsProvider: Provider = {
  name: "AVAILABLE_AGENTS",
  description:
    "Live status of available acpx task-agent adapters and active sessions.",
  dynamic: true,
  position: 1,
  relevanceKeywords: ["agent", "task", "coding", "session", "acp"],
  get: async (runtime: IAgentRuntime, _message: Memory, _state: State) => {
    const service = getAcpService(runtime);
    if (!service) {
      const text =
        "# acpx task agents\n@elizaos/plugin-agent-orchestrator task-agent service is not available.";
      return {
        text,
        values: { availableAgents: text },
        data: { agents: [], activeSessions: [], serviceAvailable: false },
      };
    }

    let frameworkProbeFailed = false;
    const [agents, sessions] = await Promise.all([
      service.checkAvailableAgents?.() ??
        service.getAvailableAgents?.() ??
        Promise.resolve([]),
      listSessionsWithin(service),
      getTaskAgentFrameworkState(runtime).catch(
        (error): TaskAgentFrameworkState | null => {
          // error-policy:J7 framework probe failures remain visible to the
          // runtime while the provider degrades to the adapter registry.
          reportProviderFetchFailure(
            runtime,
            "AVAILABLE_AGENTS",
            "getTaskAgentFrameworkState",
            error,
          );
          frameworkProbeFailed = true;
          return null;
        },
      ),
    ]);

    const lines = ["# acpx task agents"];
    if (frameworkProbeFailed) {
      lines.push(
        "",
        "> framework probe unavailable — adapter inventory may be incomplete.",
      );
    }
    const augmentedAgents = agents;

    if (augmentedAgents.length > 0) {
      lines.push("", "## Available adapters");
      for (const agent of augmentedAgents) {
        const auth = agent.auth?.status ? `, auth: ${agent.auth.status}` : "";
        const reason =
          "reason" in agent && typeof agent.reason === "string"
            ? ` — ${agent.reason}`
            : "";
        lines.push(
          `- ${agent.agentType}: ${agent.installed ? "installed" : "not installed"}${auth}${reason}`,
        );
      }
    } else {
      lines.push(
        "No adapter inventory available. Defaulting to acpx runtime selection.",
      );
    }

    if (sessions.length > 0) {
      lines.push("", `## Active sessions (${sessions.length})`);
      const renderedSessions = summarizeSessionsForPrompt(sessions);
      for (const session of renderedSessions) {
        lines.push(
          `- ${labelFor(session)} [${canonicalSessionId(session.id)}] ${session.agentType} ${session.status} in ${session.workdir}`,
        );
      }
    } else {
      lines.push("", "No active task-agent sessions.");
    }

    const text = lines.join("\n");
    return {
      text,
      values: { availableAgents: text },
      data: {
        agents,
        activeSessions: sessions.map((session) => ({
          id: session.id,
          label: labelFor(session),
          agentType: session.agentType,
          status: session.status,
          workdir: session.workdir,
        })),
        serviceAvailable: true,
        frameworkProbeFailed,
      },
    };
  },
};

export const acpAvailableAgentsProvider = availableAgentsProvider;
