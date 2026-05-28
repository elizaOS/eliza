import type { AgentStatus, ElizaClient } from "../api";

/**
 * First-run can overlap a runtime restart already in flight on slower boots.
 * Use the waitable restart path so "already restarting" is treated as
 * recoverable rather than surfacing a setup failure.
 */
export async function restartAgentAfterFirstRun(
  client: Pick<ElizaClient, "restartAndWait">,
  maxWaitMs = 120_000,
): Promise<AgentStatus> {
  return client.restartAndWait(maxWaitMs);
}
