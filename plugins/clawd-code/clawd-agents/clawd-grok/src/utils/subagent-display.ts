export function formatSubagentName(agent: string): string {
  if (agent === "general") return "General";
  if (agent === "explore") return "Explore";
  if (agent === "vision") return "Vision";
  if (agent === "verify") return "Verify";
  if (agent === "verify-detect") return "Verify Detect";
  if (agent === "verify-manifest") return "Verify Manifest";
  if (agent === "computer") return "Computer";
  if (!agent) return "Sub-agent";
  return agent.charAt(0).toUpperCase() + agent.slice(1);
}
