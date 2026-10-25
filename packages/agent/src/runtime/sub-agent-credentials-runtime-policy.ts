/**
 * Boot-time gate for the sub-agent credentials plugin. Returns false inside a
 * spawned sandbox / PTY child runtime — detected via the SANDBOX_AGENT_ID,
 * SANDBOX_ROUTE_AGENT_ID, SANDBOX_SERVER_NAME, or ORCHESTRATOR_SESSION_ID env
 * markers — so only a parent runtime registers the credential broker. A bare
 * cloud-provisioning flag does not count as a child-runtime marker.
 */
import { TRACE_ENV } from "@elizaos/core";

export function shouldRegisterSubAgentCredentialsPlugin(
  env: Record<string, string | undefined> = process.env,
): boolean {
  return !(
    env.SANDBOX_AGENT_ID?.trim() ||
    env.SANDBOX_ROUTE_AGENT_ID?.trim() ||
    env.SANDBOX_SERVER_NAME?.trim() ||
    env[TRACE_ENV.SESSION_ID]?.trim()
  );
}
