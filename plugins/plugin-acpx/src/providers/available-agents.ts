import type { IAgentRuntime, Memory, Provider, State } from "@elizaos/core";
import {
  getAcpService,
  labelFor,
  listSessionsWithin,
  shortId,
} from "../actions/common.js";

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
        "# acpx task agents\n@elizaos/plugin-acpx task-agent service is not available.";
      return {
        text,
        values: { availableAgents: text },
        data: { agents: [], activeSessions: [], serviceAvailable: false },
      };
    }

    const [agents, sessions] = await Promise.all([
      service.checkAvailableAgents?.() ??
        service.getAvailableAgents?.() ??
        Promise.resolve([]),
      listSessionsWithin(service, 2000),
    ]);

    const lines = ["# acpx task agents"];
    if (agents.length > 0) {
      lines.push("", "## Available adapters");
      for (const agent of agents) {
        const auth = agent.auth?.status ? `, auth: ${agent.auth.status}` : "";
        lines.push(
          `- ${agent.agentType ?? agent.adapter}: ${agent.installed ? "installed" : "not installed"}${auth}`,
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
