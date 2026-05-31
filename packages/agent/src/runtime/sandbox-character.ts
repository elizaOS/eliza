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
 * system prompt, bio, examples, topics, adjectives and style. It is a no-op
 * (returns the config unchanged) when the env var is absent or unparseable,
 * so it is inert for every non-provisioned runtime.
 */

import { logger } from "@elizaos/core";
import type { AgentConfig, ElizaConfig } from "../config/config.ts";

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
  settings?: Record<string, unknown>;
  [key: string]: unknown;
}

function asStringArray(value: unknown): string[] | undefined {
  if (Array.isArray(value)) {
    return value.filter((v): v is string => typeof v === "string");
  }
  if (typeof value === "string" && value.trim()) return [value];
  return undefined;
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

  // A stable id keeps memory/rooms consistent across container restarts.
  const id =
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

  logger.info(
    `[sandbox-character] Loaded injected character "${name}" (id=${id}) from ELIZA_AGENT_CHARACTER_JSON`,
  );
  return config;
}
