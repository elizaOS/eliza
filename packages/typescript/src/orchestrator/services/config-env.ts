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
import * as os from "node:os";
import * as path from "node:path";

function readConfig(): Record<string, unknown> | undefined {
  try {
    const configPath = path.join(
      process.env.ELIZA_STATE_DIR ??
        process.env.ELIZA_STATE_DIR ??
        path.join(os.homedir(), ".eliza"),
      process.env.ELIZA_NAMESPACE === "eliza" || !process.env.ELIZA_NAMESPACE
        ? "eliza.json"
        : `${process.env.ELIZA_NAMESPACE}.json`,
    );
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
