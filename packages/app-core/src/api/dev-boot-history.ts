/**
 * Exposes persisted boot, memory and restart diagnostics to the loopback dev API.
 * Missing records mean telemetry has not been written; unreadable or malformed
 * records are failures so operators can distinguish corruption from absent history.
 */
import fs from "node:fs/promises";
import path from "node:path";

import {
  type FailedPluginDetail,
  getLastFailedPluginDetails,
} from "@elizaos/agent";
import { ElizaError, resolveStateDir } from "@elizaos/core";
import { isDevApiWatchEnabled } from "@elizaos/shared/runtime-env";

export const ELIZA_DEV_BOOT_HISTORY_SCHEMA = "elizaos.dev.boot-history/v1";

export interface BootHistoryPayload {
  schema: typeof ELIZA_DEV_BOOT_HISTORY_SCHEMA;
  generatedAtEpochMs: number;
  /** Spawn timestamp of the current API child — restart-correlation key. */
  currentSpawnAtMs: number | null;
  /** True when the API is running under an active dev watcher. */
  watch: boolean;
  /** Latest completed boot record, or null if no boot has completed. */
  latestBoot: unknown;
  /** Latest memory-sampler record, or null. */
  memory: unknown;
  /** Supervisor restart events, or null until the events file exists. */
  restarts: unknown;
  /** Plugins that failed to load, with their error messages. */
  failedPlugins: FailedPluginDetail[];
  hints: string[];
}

async function readJson(filePath: string): Promise<unknown> {
  let raw: string;
  try {
    raw = await fs.readFile(filePath, "utf8");
  } catch (cause) {
    // error-policy:J3 Optional telemetry is absent only when the file does not exist.
    if (cause instanceof Error && "code" in cause && cause.code === "ENOENT")
      return null;
    throw new ElizaError("Boot telemetry could not be read.", {
      code: "BOOT_HISTORY_READ_FAILED",
      context: { filePath },
      cause,
    });
  }
  try {
    return JSON.parse(raw);
  } catch (cause) {
    // error-policy:J3 Corrupt persisted telemetry is reported by the dev API boundary.
    throw new ElizaError("Boot telemetry contains invalid JSON.", {
      code: "BOOT_HISTORY_INVALID_JSON",
      context: { filePath },
      cause,
    });
  }
}

export async function buildBootHistoryPayload(
  env: NodeJS.ProcessEnv = process.env,
): Promise<BootHistoryPayload> {
  const tel = (...segments: string[]): string =>
    path.join(resolveStateDir(env), "telemetry", ...segments);

  const [latestBoot, memory, restarts] = await Promise.all([
    readJson(tel("boot", "latest.json")),
    readJson(tel("memory", "latest.json")),
    readJson(tel("restart", "events.json")),
  ]);

  const spawnAt = Number(env.ELIZA_API_PROCESS_SPAWNED_AT_MS);

  return {
    schema: ELIZA_DEV_BOOT_HISTORY_SCHEMA,
    generatedAtEpochMs: Date.now(),
    currentSpawnAtMs: Number.isFinite(spawnAt) && spawnAt > 0 ? spawnAt : null,
    watch: isDevApiWatchEnabled(env),
    latestBoot,
    memory,
    restarts,
    failedPlugins: getLastFailedPluginDetails(),
    hints: [
      "latestBoot===null means no completed boot record is stored — check restarts and /api/dev/console-log.",
      "watch===true means the API is running under an active dev watcher (ELIZA_DESKTOP_API_WATCH, ELIZA_DEV_SOURCE_WATCH, or --watch); inspect restarts if source edits are bouncing the API.",
    ],
  };
}
