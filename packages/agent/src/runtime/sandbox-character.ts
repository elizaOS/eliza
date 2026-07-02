/**
 * Cloud sandbox character loader (Path A).
 *
 * A Hetzner-provisioned container is meant to boot AS its assigned character
 * (e.g. "Nyx"), not as the generic bundled "Eliza" preset. The full character
 * config lives in the `agent_sandboxes.agent_config` column and is injected by
 * the provisioner as the `ELIZA_AGENT_CHARACTER_JSON` env var. Without this,
 * `buildCharacterFromConfig` falls back to the default style preset because
 * `config.agents.list[0]` is empty in a fresh container.
 *
 * This module parses that env var and merges it onto `config.agents.list[0]`
 * so the existing `buildCharacterFromConfig` path picks up the right name,
 * system prompt, bio, examples, topics, adjectives and style. It returns the
 * config unchanged when the env var is absent or unparseable,
 * so it is inert for every non-provisioned runtime.
 */

import { type CharacterSettings, logger } from "@elizaos/core";
import type { AgentConfig } from "@elizaos/shared";
import type { ElizaConfig } from "../config/config.ts";

/** Raw character shape as stored in `agent_sandboxes.agent_config`. */
interface SandboxCharacterJson {
  id?: string;
  name?: string;
  username?: string;
  system?: string;
  bio?: string[] | string;
  topics?: string[];
  adjectives?: string[];
  postExamples?: string[];
  style?: { all?: string[]; chat?: string[]; post?: string[] };
  // messageExamples may arrive in either the legacy [[{user,content}]] form
  // or the @elizaos/core {examples:[{name,content}]} form; buildCharacterFromConfig
  // normalises both, so we pass it through untouched.
  messageExamples?: unknown;
  settings?: CharacterSettings;
  knowledge?: AgentConfig["knowledge"];
  /**
   * Per-character connector config (e.g. `{ discord: { ... }, telegram: {...} }`).
   * Only applied when the container is the connector owner
   * (ELIZA_SANDBOX_OWNS_CONNECTORS=1) to avoid double-connecting the same bot
   * token from both the gateway and the container.
   */
  connectors?: Record<string, unknown>;
  [key: string]: unknown;
}

/**
 * Whether this container should own (connect directly to) its platform
 * connectors. Default false: the gateway owns the connection and forwards
 * inbound events to the container (resolves the double-connect seam). Set
 * ELIZA_SANDBOX_OWNS_CONNECTORS=1 only when the operator has linked the
 * connector to the container and disabled the gateway's connection row.
 */
export function sandboxOwnsConnectors(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return env.ELIZA_SANDBOX_OWNS_CONNECTORS?.trim() === "1";
}

function asStringArray(value: unknown): string[] | undefined {
  if (Array.isArray(value)) {
    return value.filter((v): v is string => typeof v === "string");
  }
  if (typeof value === "string" && value.trim()) return [value];
  return undefined;
}

/**
 * Resolve the routing agent id for this container: the id the gateways use to
 * resolve `agent:<id>:server` and to address `/agents/<id>/message`. This MUST
 * be the platform `character_id` (the same value the gateway's
 * `discord_connections.character_id` carries), not the sandbox id. The
 * provisioner injects it as SANDBOX_ROUTE_AGENT_ID. Falls back to null when
 * absent (non-provisioned runtime), in which case the runtime keeps its
 * name-derived agent id.
 */
export function resolveSandboxRouteAgentId(
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  return env.SANDBOX_ROUTE_AGENT_ID?.trim() || null;
}

/**
 * Apply the injected sandbox character (if any) onto the runtime config.
 * Returns the same config object (mutated) for chaining convenience.
 */
export function applySandboxCharacterFromEnv(
  config: ElizaConfig,
  env: NodeJS.ProcessEnv = process.env,
): ElizaConfig {
  const raw = env.ELIZA_AGENT_CHARACTER_JSON?.trim();
  if (!raw) return config;

  let parsed: SandboxCharacterJson;
  try {
    parsed = JSON.parse(raw) as SandboxCharacterJson;
  } catch (err) {
    logger.warn(
      `[sandbox-character] ELIZA_AGENT_CHARACTER_JSON is not valid JSON; booting with default character: ${err instanceof Error ? err.message : String(err)}`,
    );
    return config;
  }

  if (!parsed || typeof parsed !== "object") return config;

  const name =
    parsed.name?.trim() ||
    env.ELIZA_AGENT_NAME?.trim() ||
    env.AGENT_NAME?.trim();
  if (!name) {
    logger.warn(
      "[sandbox-character] Injected character has no name; booting with default character",
    );
    return config;
  }

  // The id MUST be the routing character_id so the runtime's agentId matches
  // what the gateways resolve (`agent:<id>:server`) and address
  // (`/agents/<id>/message`). Fall back to the embedded character id, then
  // the sandbox id, then a name-derived slug.
  const id =
    resolveSandboxRouteAgentId(env) ||
    (typeof parsed.id === "string" && parsed.id.trim()) ||
    env.SANDBOX_AGENT_ID?.trim() ||
    name.toLowerCase().replace(/\s+/g, "-");

  const entry: AgentConfig = {
    id,
    default: true,
    name,
    ...(parsed.username ? { username: parsed.username } : {}),
    ...(parsed.system ? { system: parsed.system } : {}),
    ...(asStringArray(parsed.bio) ? { bio: asStringArray(parsed.bio) } : {}),
    ...(asStringArray(parsed.topics)
      ? { topics: asStringArray(parsed.topics) }
      : {}),
    ...(asStringArray(parsed.adjectives)
      ? { adjectives: asStringArray(parsed.adjectives) }
      : {}),
    ...(asStringArray(parsed.postExamples)
      ? { postExamples: asStringArray(parsed.postExamples) }
      : {}),
    ...(parsed.style ? { style: parsed.style } : {}),
    ...(parsed.messageExamples
      ? {
          messageExamples:
            parsed.messageExamples as AgentConfig["messageExamples"],
        }
      : {}),
    ...(parsed.settings ? { settings: parsed.settings } : {}),
    ...(parsed.knowledge ? { knowledge: parsed.knowledge } : {}),
  };

  const agents = (config.agents ?? {}) as NonNullable<ElizaConfig["agents"]>;
  const list = Array.isArray(agents.list) ? [...agents.list] : [];
  // Replace any existing primary entry; the injected character is authoritative.
  const existingIdx = list.findIndex((a) => a?.default) ?? -1;
  if (existingIdx >= 0) {
    list[existingIdx] = { ...list[existingIdx], ...entry };
  } else {
    list.unshift(entry);
  }

  config.agents = { ...agents, list };

  // Also surface the assistant name at the UI level so logging/prompts that
  // read config.ui.assistant.name agree with the loaded character.
  const ui = (config.ui ?? {}) as NonNullable<ElizaConfig["ui"]>;
  config.ui = {
    ...ui,
    assistant: { ...(ui.assistant ?? {}), name },
  } as ElizaConfig["ui"];

  // Connector ownership (Deliverable B / double-connect resolution). When the
  // operator makes the container the connector owner, apply the per-character
  // connector config so the runtime loads the connector plugin and connects
  // directly. Otherwise the gateway keeps the connection and forwards inbound
  // events to /agents/<id>/message here.
  if (
    sandboxOwnsConnectors(env) &&
    parsed.connectors &&
    typeof parsed.connectors === "object" &&
    !Array.isArray(parsed.connectors)
  ) {
    config.connectors = {
      ...(config.connectors ?? {}),
      ...(parsed.connectors as ElizaConfig["connectors"]),
    } as ElizaConfig["connectors"];
    logger.info(
      `[sandbox-character] Container owns connectors (${Object.keys(parsed.connectors).join(", ")}); will connect directly`,
    );
  }

  logger.info(
    `[sandbox-character] Loaded injected character "${name}" (id=${id}) from ELIZA_AGENT_CHARACTER_JSON`,
  );
  return config;
}

/** Connector bot-token env vars that trigger a direct platform connection. */
const CONNECTOR_TOKEN_ENV_KEYS = [
  "DISCORD_API_TOKEN",
  "DISCORD_BOT_TOKEN",
  "TELEGRAM_BOT_TOKEN",
] as const;

/** Connector keys whose config blocks would let the runtime re-derive a token. */
const CONNECTOR_CONFIG_KEYS = ["discord", "telegram"] as const;

/**
 * Resolve the double-connect seam for a provisioned container.
 *
 * In the default (gateway-owned) mode the gateway holds the Discord/Telegram
 * connection and forwards inbound events to this container; if the container
 * ALSO connected with the same bot token we would get token contention and
 * duplicate replies. So, unless the operator has explicitly made the
 * container the connector owner (ELIZA_SANDBOX_OWNS_CONNECTORS=1), we strip
 * the connector bot tokens from the environment AND clear the matching
 * config.connectors blocks so the container runs purely as an inference
 * target reached via /agents/<id>/message.
 *
 * IMPORTANT: callers must run this AFTER applyConnectorSecretsToEnv (which can
 * repopulate the env tokens from config.connectors) and BEFORE plugin
 * auto-enable / resolvePlugins.
 *
 * Skipped outside a provisioned container (ELIZA_CLOUD_PROVISIONED != "1"), so
 * local dev and the in-worker path are unaffected.
 */
export function applySandboxConnectorOwnership(
  env: NodeJS.ProcessEnv = process.env,
  config?: ElizaConfig,
): void {
  if (env.ELIZA_CLOUD_PROVISIONED !== "1") return;
  if (sandboxOwnsConnectors(env)) return;

  const stripped: string[] = [];
  for (const key of CONNECTOR_TOKEN_ENV_KEYS) {
    if (env[key]) {
      delete env[key];
      stripped.push(key);
    }
  }

  // Also drop the connector config blocks so nothing downstream
  // (plugin auto-enable, a later applyConnectorSecretsToEnv) re-derives the
  // token from config and reconnects.
  if (config?.connectors && typeof config.connectors === "object") {
    for (const key of CONNECTOR_CONFIG_KEYS) {
      if (key in config.connectors) {
        delete (config.connectors as Record<string, unknown>)[key];
        stripped.push(`config.connectors.${key}`);
      }
    }
  }

  if (stripped.length > 0) {
    logger.info(
      `[sandbox-character] Gateway owns connectors; not connecting directly (cleared ${stripped.join(", ")} to avoid double-connect). Set ELIZA_SANDBOX_OWNS_CONNECTORS=1 to connect from the container instead.`,
    );
  }
}
