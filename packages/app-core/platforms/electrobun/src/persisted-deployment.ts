import fs from "node:fs";
import path from "node:path";
import { resolveStateDir, resolveUserPath } from "@elizaos/core";
import { normalizeDeploymentTargetConfig } from "@elizaos/shared";
import type { PersistedDeployment } from "./api-base";
import { logger } from "./logger";

const CONFIG_FILENAME = "eliza.json";

/**
 * Resolve the canonical `eliza.json` path the agent persists its config to.
 * Mirrors `@elizaos/agent`'s `resolveConfigPath` (state-dir + filename, with
 * the `ELIZA_CONFIG_PATH` override) without importing the agent boot module,
 * so the desktop main process can read the persisted deployment target without
 * pulling the agent into the static boot graph.
 */
function resolveElizaConfigPath(
  env: Record<string, string | undefined>,
): string {
  const override = env.ELIZA_CONFIG_PATH?.trim();
  if (override) {
    return resolveUserPath(override);
  }
  return path.join(resolveStateDir(env as NodeJS.ProcessEnv), CONFIG_FILENAME);
}

/**
 * Read the persisted `deploymentTarget` from `eliza.json` as a
 * {@link PersistedDeployment} (`runtime` + the cloud-hosted/external agent's
 * `remoteApiBase`). Best-effort and fail-safe: any missing file, parse error,
 * or absent deployment target resolves to `null`, which the caller treats as
 * "no cloud-hosted target" and keeps the existing local-agent boot path. The
 * persisted config is written by `saveElizaConfig` as strict JSON, so a strict
 * `JSON.parse` is sufficient.
 */
export function readPersistedDeployment(
  env: Record<string, string | undefined> = process.env as Record<
    string,
    string | undefined
  >,
): PersistedDeployment | null {
  const configPath = resolveElizaConfigPath(env);
  let raw: string;
  try {
    raw = fs.readFileSync(configPath, "utf-8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    logger.warn(
      `[Deployment] Could not read ${configPath}: ${err instanceof Error ? err.message : String(err)}`,
    );
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    logger.warn(
      `[Deployment] Could not parse ${configPath}: ${err instanceof Error ? err.message : String(err)}`,
    );
    return null;
  }

  const deploymentTarget = normalizeDeploymentTargetConfig(
    (parsed as { deploymentTarget?: unknown } | null)?.deploymentTarget,
  );
  if (!deploymentTarget) {
    return null;
  }
  return {
    runtime: deploymentTarget.runtime,
    remoteApiBase: deploymentTarget.remoteApiBase ?? null,
  };
}

let cachedDeployment: PersistedDeployment | null | undefined;

/**
 * Cached read of the persisted deployment for the lifetime of the desktop
 * process. The deployment target only changes via a first-run flow that
 * restarts the shell, so a single read at boot is the source of truth for every
 * runtime-mode decision in `main()`.
 */
export function getPersistedDeployment(): PersistedDeployment | null {
  if (cachedDeployment === undefined) {
    cachedDeployment = readPersistedDeployment();
  }
  return cachedDeployment;
}
