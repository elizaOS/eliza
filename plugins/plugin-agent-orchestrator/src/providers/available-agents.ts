import type { IAgentRuntime, Memory, Provider, State } from "@elizaos/core";
import {
  getAcpService,
  labelFor,
  listSessionsWithin,
  shortId,
} from "../actions/common.js";
import { getTaskAgentFrameworkState } from "../services/task-agent-frameworks.js";

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

    const [agents, sessions, frameworkState] = await Promise.all([
      service.checkAvailableAgents?.() ??
        service.getAvailableAgents?.() ??
        Promise.resolve([]),
      listSessionsWithin(service, 2000),
      // opencode is wired through the shell adapter (not in
      // `coding-agent-adapters`'s registry), so `checkAvailableAgents`
      // misses it. Query the framework-state directly so the planner sees
      // opencode in its action context when authReady — otherwise the
      // model reads "no compatible agent available" and refuses to spawn.
      getTaskAgentFrameworkState(runtime).catch(() => null),
    ]);

    const lines = ["# acpx task agents"];
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
          `- ${agent.agentType ?? agent.adapter}: ${agent.installed ? "installed" : "not installed"}${auth}${reason}`,
        );
      }
    } else {
      lines.push(
        "No adapter inventory available. Defaulting to acpx runtime selection.",
      );
    }

    if (sessions.length > 0) {
      lines.push("", `## Active sessions (${sessions.length})`);
      for (const session of sessions) {
        lines.push(
          `- ${labelFor(session)} [${shortId(session.id)}] ${session.agentType} ${session.status} in ${session.workdir}`,
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
      },
    };
  },
};

export const acpAvailableAgentsProvider = availableAgentsProvider;
