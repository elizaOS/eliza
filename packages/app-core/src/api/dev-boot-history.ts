/**
 * GET /api/dev/boot-history payload builder.
 *
 * Reads back the boot + memory telemetry the runtime already writes under
 * `<stateDir>/telemetry/` (see `@elizaos/agent` runtime/boot-telemetry.ts) plus
 * the in-memory plugin-load failures, so an operator or agent can see boot phase
 * timings, memory growth, restart count/cause, and the exact error for any
 * plugin that failed to load — without shell access to the state dir or log
 * scraping. Loopback dev route. Absent telemetry surfaces as `null`; this never
 * fabricates zeros (AGENTS.md §8).
 *
 * @module dev-boot-history
 */
import fs from "node:fs/promises";
import path from "node:path";

import {
  type FailedPluginDetail,
  getLastFailedPluginDetails,
} from "@elizaos/agent";
import { resolveStateDir } from "@elizaos/core";

export const ELIZA_DEV_BOOT_HISTORY_SCHEMA = "elizaos.dev.boot-history/v1";

export interface BootHistoryPayload {
  schema: typeof ELIZA_DEV_BOOT_HISTORY_SCHEMA;
  generatedAtEpochMs: number;
  /** Spawn timestamp of the current API child — restart-correlation key. */
  currentSpawnAtMs: number | null;
  /** True when the API runs under `node --watch` (ELIZA_DEV_NO_WATCH=0). */
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

/** ENOENT and parse errors collapse to null — the caller reads the null. */
async function readJson(filePath: string): Promise<unknown> {
  const raw = await fs.readFile(filePath, "utf8").catch(() => null);
  if (raw === null) {
    return null;
  }
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

export async function buildBootHistoryPayload(
  env: NodeJS.ProcessEnv = process.env,
): Promise<BootHistoryPayload> {
  const tel = (...segments: string[]): string =>
    path.join(resolveStateDir(), "telemetry", ...segments);

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
    watch: env.ELIZA_DEV_NO_WATCH === "0",
    latestBoot,
    memory,
    restarts,
    failedPlugins: getLastFailedPluginDetails(),
    hints: [
      "latestBoot===null means the runtime has not completed a boot since this process started (restart storm or hard crash) — check restarts and /api/dev/console-log.",
      "watch===true means the API runs under node --watch; a concurrent workspace build (tsc/vite) can rewrite watched files and trigger a restart loop.",
    ],
  };
}
