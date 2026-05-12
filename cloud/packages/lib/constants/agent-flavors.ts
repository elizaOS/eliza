/**
 * Agent Flavor Presets — predefined Docker image configurations the cloud
 * dashboard exposes when a user creates a sandbox. The `eliza` flavor (default)
 * resolves its image at runtime via `containersEnv.defaultAgentImage()` so
 * operators can pin a tag without touching code (`ELIZA_AGENT_IMAGE` /
 * `CONTAINERS_DEFAULT_IMAGE` / legacy `AGENT_DOCKER_IMAGE`).
 *
 * Tags map to the continuous-publication workflow at
 * .github/workflows/build-agent-image.yml:
 *   :stable  — head of main
 *   :develop — head of develop
 *   :latest  — alias of :stable for legacy hardcoded callers
 */

import { containersEnv } from "@/lib/config/containers-env";

export interface AgentFlavor {
  id: string;
  name: string;
  description: string;
  dockerImage: string;
  defaultEnvVars?: Record<string, string>;
}

/** Built-in flavors. The first entry is the default. */
export const AGENT_FLAVORS: AgentFlavor[] = [
  {
    id: "eliza",
    name: "Eliza Agent",
    description:
      "V2 elizaOS agent — bridge API + Steward integration. Web UI disabled by default; enable with ELIZA_UI_ENABLE=true.",
    dockerImage: containersEnv.defaultAgentImage(),
  },
  {
    id: "eliza-develop",
    name: "Eliza Agent (Develop)",
    description:
      "Latest develop build. Use for testing new features before they hit stable.",
    dockerImage: "ghcr.io/elizaos/eliza:develop",
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
