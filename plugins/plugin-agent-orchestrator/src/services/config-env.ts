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
  // Prefer the config file's env section: the UI writes settings there and
  // changes take effect without a process restart. Fall back to process.env
  // so operators who set values via a systemd EnvironmentFile (service.env)
  // or shell export are honoured — these paths were silently ignored before,
  // causing `ELIZA_OPENCODE_*` overrides to be dropped on the floor.
  const config = readConfig();
  const val = (config?.env as Record<string, unknown> | undefined)?.[key];
  if (typeof val === "string" && val.length > 0) return val;
  const fromProcessEnv = process.env[key];
  return typeof fromProcessEnv === "string" && fromProcessEnv.length > 0
    ? fromProcessEnv
    : undefined;
}

/** Read a key from the cloud section of the config (e.g. "apiKey"). */
export function readConfigCloudKey(key: string): string | undefined {
  const config = readConfig();
  const val = (config?.cloud as Record<string, unknown> | undefined)?.[key];
  return typeof val === "string" ? val : undefined;
}
