/**
 * Shared cloud-connector routing helpers used by the Plugins view.
 * These helpers stay in the UI package because connector configuration is a
 * host-owned surface; the cloud dashboard and its billing helpers live in the
 * Eliza Cloud plugin.
 */
import type { CloudCompatAgent } from "../api";
import { pathForTab } from "../navigation";

const MANAGED_DISCORD_GATEWAY_AGENT_NAME = "Discord Gateway";

export function buildManagedDiscordSettingsReturnUrl(
  rawUrl: string,
): string | null {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    // error-policy:J3 explicit invalid signal — no return URL is built from
    // an unparseable location; the caller skips the redirect.
    return null;
  }

  const settingsPath = pathForTab("settings");

  if (url.protocol === "file:") {
    url.hash = settingsPath;
    url.search = "";
    return url.toString();
  }

  const normalizedPath = url.pathname.replace(/\/+$/, "") || "/";
  const settingsPathname = normalizedPath.replace(/\/[^/]*$/, settingsPath);
  url.pathname = settingsPathname === "" ? settingsPath : settingsPathname;
  url.search = "";
  url.hash = "";
  return url.toString();
}

export function resolveManagedDiscordAgentChoice(agents: CloudCompatAgent[]):
  | { mode: "none"; agent: null; selectedAgentId: null }
  | { mode: "bootstrap"; agent: null; selectedAgentId: null }
  | {
      mode: "direct";
      agent: CloudCompatAgent;
      selectedAgentId: string;
    }
  | { mode: "picker"; agent: null; selectedAgentId: string } {
  const gatewayAgents = agents.filter(isManagedDiscordGatewayAgent);
  if (agents.length === 0) {
    return { mode: "none", agent: null, selectedAgentId: null };
  }

  if (gatewayAgents.length === 0) {
    return { mode: "bootstrap", agent: null, selectedAgentId: null };
  }

  if (gatewayAgents.length === 1) {
    return {
      mode: "direct",
      agent: gatewayAgents[0],
      selectedAgentId: gatewayAgents[0].agent_id,
    };
  }

  return {
    mode: "picker",
    agent: null,
    selectedAgentId: (gatewayAgents[0] ?? agents[0]).agent_id,
  };
}

function isManagedDiscordGatewayAgent(agent: CloudCompatAgent): boolean {
  const config =
    typeof agent.agent_config === "object" && agent.agent_config !== null
      ? (agent.agent_config as Record<string, unknown>)
      : null;
  const gatewayConfig = config?.__managedDiscordGateway;
  if (
    typeof gatewayConfig === "object" &&
    gatewayConfig !== null &&
    (gatewayConfig as Record<string, unknown>).mode === "shared-gateway"
  ) {
    return true;
  }

  return (
    agent.agent_name.trim().toLowerCase() ===
    MANAGED_DISCORD_GATEWAY_AGENT_NAME.toLowerCase()
  );
}
