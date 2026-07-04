/**
 * `AVAILABLE_AGENTS` provider: the adapter inventory (which ACP coding backends
 * are installed and authenticated) plus a bounded list of recent/active
 * sessions, rendered into the planner context. Merges the `checkAvailableAgents`
 * inventory with framework state so shell-adapter backends like opencode — which
 * the adapter registry misses — still appear when installed and auth-ready.
 */
import type { IAgentRuntime, Memory, Provider, State } from "@elizaos/core";
import {
  getAcpService,
  labelFor,
  listSessionsWithin,
  reportProviderFetchFailure,
  shortId,
} from "../actions/common.js";
import {
  getTaskAgentFrameworkState,
  type TaskAgentFrameworkState,
} from "../services/task-agent-frameworks.js";
import {
  type SessionInfo,
  TERMINAL_SESSION_STATUSES,
} from "../services/types.js";

const MAX_RENDERED_ACTIVE_SESSIONS = 8;

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

    // opencode is wired through the shell adapter (not in
    // `coding-agent-adapters`'s registry), so `checkAvailableAgents`
    // misses it. Query the framework-state directly so the planner sees
    // opencode in its action context when authReady — otherwise the
    // model reads "no compatible agent available" and refuses to spawn.
    //
    // A THROWN framework probe is a broken backend, NOT "opencode absent":
    // swallowing it into `null` renders the same as a clean "opencode not
    // installed" slate, so the planner can't distinguish a real probe crash
    // from genuine absence and silently drops opencode from its options with
    // no signal (#12273 healthy-empty-from-catch). Surface it — warn +
    // reportError via reportProviderFetchFailure — and flag the context
    // degraded so the failure is visible instead of masquerading as absence.
    let frameworkProbeFailed = false;
    const [agents, sessions, frameworkState] = await Promise.all([
      service.checkAvailableAgents?.() ??
        service.getAvailableAgents?.() ??
        Promise.resolve([]),
      listSessionsWithin(service, 2000),
      getTaskAgentFrameworkState(runtime).catch(
        (error): TaskAgentFrameworkState | null => {
          // error-policy:J7 framework probe threw — backend down, not
          // "opencode absent". Surface it + degrade instead of a silent null.
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
        "> framework probe unavailable — adapter inventory below may be incomplete (a shell-adapter backend such as opencode could be installed but undetected). This is a probe failure, not confirmed absence.",
      );
    }
    const opencodeFramework = frameworkState?.frameworks.find(
      (framework) => framework.id === "opencode",
    );
    const augmentedAgents =
      opencodeFramework?.installed && opencodeFramework.authReady
        ? [
            ...agents,
            {
              agentType: "opencode",
              adapter: "OpenCode",
              installed: true,
              auth: { status: "authenticated" as const },
              reason: opencodeFramework.reason,
            },
          ]
        : agents;

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
        frameworkProbeFailed,
      },
    };
  },
};

export const acpAvailableAgentsProvider = availableAgentsProvider;
