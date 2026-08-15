/**
 * Owns the process-wide executable-search authority captured by a Node host
 * before runtime configuration or plugins can mutate `process.env`. Host
 * process launchers consume this narrow PATH baseline; sandbox launchers do
 * not, because containers must retain their image-native environment.
 */

import { accessSync, constants } from "node:fs";
import path from "node:path";
import process from "node:process";

export interface HostExecutionBaseline {
  readonly path?: string;
}

let capturedBaseline: HostExecutionBaseline | undefined;

function pathValueForPlatform(
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
): string | undefined {
  if (platform !== "win32") return env.PATH;
  const entries = Object.entries(env).filter(
    ([key, value]) => key.toUpperCase() === "PATH" && value !== undefined,
  );
  return entries.length === 1 ? entries[0]?.[1] : undefined;
}

export function validateHostExecutionPath(
  value: string | undefined,
  platform: NodeJS.Platform = process.platform,
): string | undefined {
  if (!value || value.includes("\0")) return undefined;
  const pathApi = platform === "win32" ? path.win32 : path.posix;
  const entries = value.split(pathApi.delimiter);
  if (
    entries.length === 0 ||
    entries.some((entry) => entry.length === 0 || !pathApi.isAbsolute(entry))
  ) {
    return undefined;
  }
  return value;
}

export function createHostExecutionBaseline(
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform = process.platform,
): HostExecutionBaseline {
  return Object.freeze({
    path: validateHostExecutionPath(
      pathValueForPlatform(env, platform),
      platform,
    ),
  });
}

/** Capture once. Later calls cannot replace the boot authority. */
export function captureHostExecutionBaseline(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): HostExecutionBaseline {
  if (capturedBaseline) return capturedBaseline;
  capturedBaseline = createHostExecutionBaseline(env, platform);
  return capturedBaseline;
}

export function getHostExecutionBaseline(): HostExecutionBaseline {
  return capturedBaseline ?? Object.freeze({});
}

/**
 * Add only the captured PATH to an already-sanitized host child environment.
 * Case variants are removed so Windows cannot retain a second mutable value.
 */
export function applyHostExecutionBaseline(
  env: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(env)) {
    if (key.toUpperCase() !== "PATH") out[key] = value;
  }
  const baseline = getHostExecutionBaseline();
  if (baseline.path) out.PATH = baseline.path;
  return out;
}

export function resolveHostExecutable(nameOrPath: string): string | undefined {
  const trimmed = nameOrPath.trim();
  if (!trimmed || trimmed.includes("\0")) return undefined;
  const candidates: string[] = [];
  if (path.isAbsolute(trimmed)) {
    candidates.push(trimmed);
  } else if (!trimmed.includes("/") && !trimmed.includes("\\")) {
    const baseline = getHostExecutionBaseline();
    for (const entry of baseline.path?.split(path.delimiter) ?? []) {
      candidates.push(path.join(entry, trimmed));
      if (process.platform === "win32" && path.extname(trimmed) === "") {
        candidates.push(path.join(entry, `${trimmed}.exe`));
        candidates.push(path.join(entry, `${trimmed}.cmd`));
      }
    }
  }
  for (const candidate of candidates) {
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      // error-policy:J3 executable probing returns an explicit absence.
    }
  }
  return undefined;
}
