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

import { containersEnv } from "../config/containers-env";

export interface AgentFlavor {
  id: string;
  name: string;
  description: string;
  dockerImage: string;
  defaultEnvVars?: Record<string, string>;
}

/**
 * Per-env flavor catalog.
 *   - production → only the stable `eliza` flavor + `custom`
 *   - staging    → only the `eliza-develop` flavor + `custom`
 *   - local dev / unset → both eliza flavors + `custom` (so devs can pick)
 *
 * Signal priority:
 *   1. `import.meta.env.VITE_ENVIRONMENT` — build-time inlined by Vite into
 *      the SPA bundle. Required because Vite strips `process.env` for the
 *      browser, so the Worker `ENVIRONMENT` binding is invisible to the SPA.
 *   2. `process.env.ENVIRONMENT` — Worker `[vars]` binding from wrangler.toml.
 *   3. `process.env.NODE_ENV === "production"` — last-resort fallback.
 *
 * Wire `VITE_ENVIRONMENT` per env in `packages/cloud-frontend/wrangler.toml`
 * and the cloud-cf-deploy workflow build step so staging and prod SPAs each
 * see the correct mode.
 */
function readViteEnvironment(): string | undefined {
  // `import.meta.env` only exists in Vite-bundled code; in Worker/Node builds
  // the property access returns `undefined` (or `import.meta` itself has no
  // `env`). The try/catch and the optional chain keep this resilient.
  try {
    const meta = import.meta as { env?: Record<string, string | undefined> };
    return meta.env?.VITE_ENVIRONMENT;
  } catch {
    return undefined;
  }
}

function resolveEnvMode(): "production" | "staging" | "unknown" {
  const vite = readViteEnvironment();
  if (vite === "production") return "production";
  if (vite === "staging") return "staging";

  const env = (typeof process !== "undefined" && process.env) || {};
  const explicit = env.ENVIRONMENT;
  if (explicit === "production") return "production";
  if (explicit === "staging") return "staging";
  if (env.NODE_ENV === "production") return "production";
  return "unknown";
}

const FLAVOR_ELIZA_STABLE: AgentFlavor = {
  id: "eliza",
  name: "Eliza Agent",
  description:
    "V2 elizaOS agent — bridge API + Steward integration. Web UI enabled by default (token-gated by the agent-router via the per-agent ELIZA_API_TOKEN); disable per-agent with ELIZA_UI_ENABLE=false.",
  dockerImage: containersEnv.defaultAgentImage(),
};

const FLAVOR_ELIZA_DEVELOP: AgentFlavor = {
  id: "eliza-develop",
  name: "Eliza Agent (Develop)",
  description:
    "Latest develop build. Use for testing new features before they hit stable.",
  dockerImage: "ghcr.io/elizaos/eliza:develop",
};

const FLAVOR_CUSTOM: AgentFlavor = {
  id: "custom",
  name: "Custom Image",
  description: "Bring your own Docker image.",
  dockerImage: "",
};

/** Built-in flavors for the current deployment env. The first entry is the default. */
export function getAgentFlavorsForEnv(): AgentFlavor[] {
  const mode = resolveEnvMode();
  if (mode === "production") return [FLAVOR_ELIZA_STABLE, FLAVOR_CUSTOM];
  if (mode === "staging") return [FLAVOR_ELIZA_DEVELOP, FLAVOR_CUSTOM];
  // Local dev / unknown: surface both so devs can pick.
  return [FLAVOR_ELIZA_STABLE, FLAVOR_ELIZA_DEVELOP, FLAVOR_CUSTOM];
}

export function getFlavorById(id: string): AgentFlavor | undefined {
  return getAgentFlavorsForEnv().find((f) => f.id === id);
}

export function getDefaultFlavor(): AgentFlavor {
  return getAgentFlavorsForEnv()[0]!;
}
