/**
 * Read settings from the eliza/eliza config file's env section.
 *
 * runtime.getSetting() checks character.settings but NOT the config's env
 * section which is where the UI writes settings. This reads the config
 * file directly so settings take effect without restart.
 *
 * @module services/config-env
 */

import { readFileSync } from "node:fs";
import * as path from "node:path";
import { getElizaNamespace, resolveStateDir } from "@elizaos/core";

function readConfig(): Record<string, unknown> | undefined {
  try {
    const namespace = getElizaNamespace();
    const filename = namespace === "eliza" ? "eliza.json" : `${namespace}.json`;
    const configPath = path.join(resolveStateDir(), filename);
    const raw = readFileSync(configPath, "utf-8");
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

export function readConfigEnvKey(key: string): string | undefined {
  const config = readConfig();
  const val = (config?.env as Record<string, unknown> | undefined)?.[key];
  return typeof val === "string" ? val : undefined;
}

/** Read a key from the cloud section of the config (e.g. "apiKey"). */
export function readConfigCloudKey(key: string): string | undefined {
  const config = readConfig();
  const val = (config?.cloud as Record<string, unknown> | undefined)?.[key];
  return typeof val === "string" ? val : undefined;
}

/**
 * Read the `agents.defaults.orchestrator.codexSubscriptionRestrictedToCodexFramework`
 * flag from Eliza's config. Returns false when the flag is unset or the
 * config file is missing/malformed.
 *
 * When true, Codex (ChatGPT Plus/Pro) subscription tokens are only usable when
 * the orchestrator targets the `codex` framework — other frameworks
 * (claude/gemini/aider) must fall back to API keys instead.
 */
export function readConfigCodexSubscriptionRestrictedToCodexFramework(): boolean {
  const config = readConfig();
  if (!config || typeof config !== "object") return false;
  const agents = (config as Record<string, unknown>).agents;
  if (!agents || typeof agents !== "object" || Array.isArray(agents))
    return false;
  const defaults = (agents as Record<string, unknown>).defaults;
  if (!defaults || typeof defaults !== "object" || Array.isArray(defaults))
    return false;
  const orchestrator = (defaults as Record<string, unknown>).orchestrator;
  if (
    !orchestrator ||
    typeof orchestrator !== "object" ||
    Array.isArray(orchestrator)
  )
    return false;
  const flag = (orchestrator as Record<string, unknown>)
    .codexSubscriptionRestrictedToCodexFramework;
  return flag === true;
}
