import type { AgentStats } from "@/lib/cache/agent-state-cache";

/**
 * Dashboard display mapping of AgentStats (server actions and API reuse this alias).
 */
export type DashboardAgentStats = Omit<AgentStats, "agentId" | "uptime"> & {
  deploymentStatus: AgentStats["status"];
};
