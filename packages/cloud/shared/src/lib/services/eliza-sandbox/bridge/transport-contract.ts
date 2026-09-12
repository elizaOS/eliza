/** Defines authenticated sandbox transport targets and routing configuration failures shared by the service facade and transport owner. */
import { type AgentSandbox } from "../../../../db/repositories/agent-sandboxes";

export type AgentNetworkTarget = Pick<
  AgentSandbox,
  | "id"
  | "bridge_url"
  | "health_url"
  | "node_id"
  | "bridge_port"
  | "web_ui_port"
  | "headscale_ip"
  | "sandbox_id"
>;

export type AgentApiTarget = AgentNetworkTarget & Pick<AgentSandbox, "environment_vars">;

export type AgentFetchTarget = {
  url: string;
  forwardedHost?: string;
};

export const AGENT_ID_RE = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;

export class AgentRouterConfigurationError extends Error {
  constructor(variable: "AGENT_ROUTER_ORIGIN_HOST" | "ELIZA_CLOUD_AGENT_BASE_DOMAIN") {
    super(`Worker agent routing requires a valid ${variable}`);
    this.name = "AgentRouterConfigurationError";
  }
}
