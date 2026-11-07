/** Shared status contract for deterministic renderer fixtures; never used by a live host. */
import type { AgentStatus } from "@elizaos/ui";

export function fixtureAgentStatus(
  overrides: Partial<AgentStatus> = {},
): AgentStatus {
  return {
    state: "running",
    agentName: "Playwright Smoke",
    model: "ui-smoke",
    startedAt: undefined,
    uptime: undefined,
    ...overrides,
  };
}
