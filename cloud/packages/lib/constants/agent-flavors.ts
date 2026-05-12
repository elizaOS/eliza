/**
 * Agent Flavor Presets — predefined Docker image configurations for different
 * agent types. The default `eliza` flavor resolves its image at runtime via
 * `containersEnv.defaultAgentImage()` so operators can pin a tag without
 * touching code (`ELIZA_AGENT_IMAGE` / `CONTAINERS_DEFAULT_IMAGE` /
 * legacy `AGENT_DOCKER_IMAGE`).
 */

import { containersEnv } from "@/lib/config/containers-env";

export interface AgentFlavor {
  id: string;
  name: string;
  description: string;
  dockerImage: string;
  defaultEnvVars?: Record<string, string>;
}

/**
 * Built-in flavors. The first entry is the default; callers may override the
 * default image at runtime via `ELIZA_AGENT_IMAGE`. The "agent" flavor is
 * retained as a named preset for the parent Agent product, but the platform
 * default is the generic Eliza agent.
 */
export const AGENT_FLAVORS: AgentFlavor[] = [
  {
    id: "eliza",
    name: "Eliza Agent",
    description: "Default elizaOS agent — full runtime, web UI, bridge, and Steward integration.",
    dockerImage: containersEnv.defaultAgentImage(),
  },
  {
    id: "eliza-slim",
    name: "Eliza Agent (Slim)",
    description: "Lightweight elizaOS agent with bridge only, no UI.",
    dockerImage: "ghcr.io/elizaos/eliza:slim",
  },
  {
    id: "agent",
    name: "Agent",
    description: "Eliza agent with Steward wallet vault integration and VRM companion UI.",
    dockerImage: "ghcr.io/agent-ai/agent:v2.0.0-steward-5",
  },
  {
    id: "custom",
    name: "Custom Image",
    description: "Bring your own Docker image.",
    dockerImage: "",
  },
];

export function getFlavorById(id: string): AgentFlavor | undefined {
  return AGENT_FLAVORS.find((f) => f.id === id);
}

export function getDefaultFlavor(): AgentFlavor {
  return AGENT_FLAVORS[0]!;
}
