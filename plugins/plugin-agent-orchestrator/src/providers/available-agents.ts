import type { IAgentRuntime, Memory, Provider, State } from "@elizaos/core";
import {
  getAcpService,
  labelFor,
  listSessionsWithin,
  shortId,
} from "../actions/common.js";
import { getTaskAgentFrameworkState } from "../services/task-agent-frameworks.js";
import type { AvailableAgentInfo, SessionInfo } from "../services/types.js";

const MAX_RENDERED_ACTIVE_SESSIONS = 8;
const TERMINAL_SESSION_STATUSES = new Set([
  "completed",
  "stopped",
  "errored",
  "cancelled",
]);

function sessionSortTime(session: SessionInfo): number {
  return new Date(session.lastActivityAt).getTime();
}

function sessionIsActive(session: SessionInfo): boolean {
  return !TERMINAL_SESSION_STATUSES.has(String(session.status));
}

function summarizeSessionsForPrompt(sessions: SessionInfo[]): SessionInfo[] {
  return sessions
    .slice()
    .sort((a, b) => {
      const activeDelta =
        Number(sessionIsActive(b)) - Number(sessionIsActive(a));
      if (activeDelta !== 0) return activeDelta;
      return sessionSortTime(b) - sessionSortTime(a);
    })
    .slice(0, MAX_RENDERED_ACTIVE_SESSIONS);
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

    const [rawAgents, sessions, frameworkState] = await Promise.all([
      service.checkAvailableAgents?.() ??
        service.getAvailableAgents?.() ??
        Promise.resolve([]),
      listSessionsWithin(service, 2000),
      // Some adapters are wired through custom ACP commands or vendored shims
      // `coding-agent-adapters`'s registry), so `checkAvailableAgents`
      // can miss them. Query framework-state directly so the planner sees
      // configured adapters in its action context when authReady; otherwise the
      // model reads "no compatible agent available" and refuses to spawn.
      getTaskAgentFrameworkState(runtime).catch(() => null),
    ]);
    const agents = rawAgents as AvailableAgentInfo[];

    const lines = ["# acpx task agents"];
    const knownAgentIds = new Set(
      agents.map((agent) => String(agent.agentType)),
    );
    const augmentedAgents = [
      ...agents,
      ...(frameworkState?.frameworks
        .filter(
          (framework) =>
            framework.installed &&
            framework.authReady &&
            !knownAgentIds.has(framework.id),
        )
        .map((framework) => ({
          agentType: framework.id,
          adapter: framework.label,
          installed: true,
          auth: { status: "authenticated" as const },
          reason: framework.reason,
        })) ?? []),
    ];

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
          `- ${labelFor(session)} [${shortId(session.id)}] ${session.agentType} ${session.status} in ${session.workdir}`,
        );
      }
      const omitted = sessions.length - renderedSessions.length;
      if (omitted > 0) {
        lines.push(`... (+${omitted} older sessions omitted)`);
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
      },
    };
  },
};

export const acpAvailableAgentsProvider = availableAgentsProvider;
