/**
 * Character override loader for provisioned sandboxes and local deployments.
 *
 * Cloud sandboxes inject `ELIZA_AGENT_CHARACTER_JSON` so the container boots AS
 * its assigned character instead of the bundled Eliza preset. Local deployments
 * can drop a `character.json` at the repo root (or set `ELIZA_CHARACTER_PATH`)
 * to the same effect. Both paths merge onto `config.agents.list[0]` so
 * `buildCharacterFromConfig` picks up name, system prompt, bio, examples, and
 * style. Returns the config unchanged when no override is present.
 */

import fs from "node:fs";
import path from "node:path";
import { type CharacterSettings, logger } from "@elizaos/core";
import type { AgentConfig } from "@elizaos/shared";
import {
  normalizeFirstRunProviderId,
  resolveElizaPackageRootSync,
} from "@elizaos/shared";
import type { ElizaConfig } from "../config/config.ts";

/** Injectable local-file seam used by deterministic character-loader tests. */
export interface CharacterOverrideFileAccess {
  cwd: string;
  argv1?: string;
  existsSync: (filePath: string) => boolean;
  readTextFileSync: (filePath: string) => string;
  resolvePackageRoot: (options: {
    cwd: string;
    argv1?: string;
  }) => string | null;
}

function defaultCharacterOverrideFileAccess(): CharacterOverrideFileAccess {
  return {
    cwd: process.cwd(),
    argv1: process.argv[1],
    existsSync: fs.existsSync,
    readTextFileSync: (filePath) => fs.readFileSync(filePath, "utf-8"),
    resolvePackageRoot: resolveElizaPackageRootSync,
  };
}

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
  lore?: string[];
  modelProvider?: string;
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

function resolveLocalCharacterJsonPath(
  env: NodeJS.ProcessEnv = process.env,
  fileAccess: CharacterOverrideFileAccess = defaultCharacterOverrideFileAccess(),
): string | null {
  if (env.ELIZA_DISABLE_LOCAL_CHARACTER?.trim() === "1") {
    return null;
  }

  const explicit = env.ELIZA_CHARACTER_PATH?.trim();
  if (explicit) {
    return path.isAbsolute(explicit)
      ? explicit
      : path.resolve(fileAccess.cwd, explicit);
  }

  const repoRoot = fileAccess.resolvePackageRoot({
    cwd: fileAccess.cwd,
    argv1: fileAccess.argv1,
  });
  if (!repoRoot) {
    return null;
  }

  const candidate = path.join(repoRoot, "character.json");
  return fileAccess.existsSync(candidate) ? candidate : null;
}

function readCharacterOverrideJson(
  env: NodeJS.ProcessEnv = process.env,
  fileAccess: CharacterOverrideFileAccess = defaultCharacterOverrideFileAccess(),
): { raw: string; source: string } | null {
  const envRaw = env.ELIZA_AGENT_CHARACTER_JSON?.trim();
  if (envRaw) {
    return { raw: envRaw, source: "ELIZA_AGENT_CHARACTER_JSON" };
  }

  const filePath = resolveLocalCharacterJsonPath(env, fileAccess);
  if (!filePath) {
    return null;
  }

  try {
    const raw = fileAccess.readTextFileSync(filePath).trim();
    return raw ? { raw, source: filePath } : null;
  } catch (err) {
    logger.warn(
      `[sandbox-character] Failed to read local character file ${filePath}: ${err instanceof Error ? err.message : String(err)}`,
    );
    return null;
  }
}

function mergeKnowledgeSources(
  parsed: SandboxCharacterJson,
): AgentConfig["knowledge"] | undefined {
  const knowledge = Array.isArray(parsed.knowledge)
    ? [...parsed.knowledge]
    : [];
  const lore = asStringArray(parsed.lore) ?? [];
  const merged = [...knowledge, ...lore];
  return merged.length > 0 ? merged : undefined;
}

function applyModelProviderRouting(
  config: ElizaConfig,
  modelProvider: string | undefined,
): void {
  const rawProvider = modelProvider?.trim();
  if (!rawProvider) {
    return;
  }
  const provider = normalizeFirstRunProviderId(rawProvider);
  if (!provider) {
    logger.warn(
      `[sandbox-character] Ignoring unsupported modelProvider "${rawProvider}"; retaining configured LLM routing`,
    );
    return;
  }

  const serviceRouting = {
    ...(config.serviceRouting ?? {}),
  } as NonNullable<ElizaConfig["serviceRouting"]>;
  const primaryModel = serviceRouting.llmText?.primaryModel;
  serviceRouting.llmText = {
    backend: provider,
    transport: "direct",
    ...(primaryModel ? { primaryModel } : {}),
  };
  config.serviceRouting = serviceRouting;
}

/**
 * Apply an injected or local character override onto the runtime config.
 * Returns the same config object (mutated) for chaining convenience.
 */
export function applySandboxCharacterFromEnv(
  config: ElizaConfig,
  env: NodeJS.ProcessEnv = process.env,
  fileAccess: CharacterOverrideFileAccess = defaultCharacterOverrideFileAccess(),
): ElizaConfig {
  const override = readCharacterOverrideJson(env, fileAccess);
  if (!override) return config;

  let parsed: SandboxCharacterJson;
  try {
    parsed = JSON.parse(override.raw) as SandboxCharacterJson;
  } catch (err) {
    logger.warn(
      `[sandbox-character] Character override from ${override.source} is not valid JSON; booting with default character: ${err instanceof Error ? err.message : String(err)}`,
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
      "[sandbox-character] Character override has no name; booting with default character",
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

  const knowledge = mergeKnowledgeSources(parsed);

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
    ...(knowledge ? { knowledge } : {}),
  };

  const agents = config.agents as ElizaConfig["agents"] | undefined;
  const list = Array.isArray(agents?.list) ? [...agents.list] : [];
  // buildCharacterFromConfig consumes list[0], so the authoritative injected
  // identity must occupy that position even when a persisted default is later.
  const existingIdx = list.findIndex((a) => a?.default);
  if (existingIdx >= 0) {
    const [existing] = list.splice(existingIdx, 1);
    list.unshift({ ...existing, ...entry });
  } else {
    list.unshift(entry);
  }

  config.agents = { ...agents, list };

  applyModelProviderRouting(config, parsed.modelProvider);

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
    `[sandbox-character] Loaded character "${name}" (id=${id}) from ${override.source}`,
  );
  return config;
}

/** Apply the complete provisioned identity contract for initial boot or reload. */
export function applySandboxIdentityFromEnv(
  config: ElizaConfig,
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  applySandboxCharacterFromEnv(config, env);
  return resolveSandboxRouteAgentId(env);
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
  const stripRecordKeys = (
    value: unknown,
    keys: readonly string[],
    recordPath: string,
  ): void => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return;
    const record = value as Record<string, unknown>;
    for (const key of keys) {
      if (key in record) {
        delete record[key];
        stripped.push(`${recordPath}.${key}`);
      }
    }
  };

  for (const key of CONNECTOR_TOKEN_ENV_KEYS) {
    if (env[key]) {
      delete env[key];
      stripped.push(key);
    }
  }

  // Also drop the connector config blocks so nothing downstream
  // (plugin auto-enable, a later applyConnectorSecretsToEnv) re-derives the
  // token from config and reconnects.
  if (config) {
    stripRecordKeys(
      config.connectors,
      CONNECTOR_CONFIG_KEYS,
      "config.connectors",
    );
    stripRecordKeys(
      (config as Record<string, unknown>).channels,
      CONNECTOR_CONFIG_KEYS,
      "config.channels",
    );

    const configEnv = config.env as Record<string, unknown> | undefined;
    stripRecordKeys(configEnv, CONNECTOR_TOKEN_ENV_KEYS, "config.env");
    stripRecordKeys(
      configEnv?.vars,
      CONNECTOR_TOKEN_ENV_KEYS,
      "config.env.vars",
    );

    for (const [index, agent] of (config.agents?.list ?? []).entries()) {
      const settings = agent?.settings as Record<string, unknown> | undefined;
      const settingsPath = `config.agents.list[${index}].settings`;
      stripRecordKeys(settings, CONNECTOR_CONFIG_KEYS, settingsPath);
      stripRecordKeys(settings, CONNECTOR_TOKEN_ENV_KEYS, settingsPath);
      stripRecordKeys(
        settings?.extra,
        CONNECTOR_TOKEN_ENV_KEYS,
        `${settingsPath}.extra`,
      );
      stripRecordKeys(
        settings?.secrets,
        CONNECTOR_TOKEN_ENV_KEYS,
        `${settingsPath}.secrets`,
      );
    }
  }

  if (stripped.length > 0) {
    logger.info(
      `[sandbox-character] Gateway owns connectors; not connecting directly (cleared ${stripped.join(", ")} to avoid double-connect). Set ELIZA_SANDBOX_OWNS_CONNECTORS=1 to connect from the container instead.`,
    );
  }
}

/**
 * Apply the provisioned config transformations in their required order.
 * Connector projection runs after identity injection so container-owned
 * character connectors are discoverable, while ownership runs last so a
 * gateway-owned container cannot retain credentials projected from config.
 */
export function prepareSandboxRuntimeConfig(
  config: ElizaConfig,
  projectConnectorSecrets: (
    config: ElizaConfig,
    env: NodeJS.ProcessEnv,
  ) => void,
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  const routeAgentId = applySandboxIdentityFromEnv(config, env);
  projectConnectorSecrets(config, env);
  applySandboxConnectorOwnership(env, config);
  return routeAgentId;
}
