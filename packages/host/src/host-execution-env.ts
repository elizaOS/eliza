/**
 * Owns the process-wide executable-search and Go-cache authority captured by a
 * Node host before runtime configuration or plugins can mutate `process.env`.
 * Host process launchers consume this narrow baseline; sandbox launchers do
 * not, because containers must retain their image-native environment.
 */

import { accessSync, constants } from "node:fs";
import { userInfo } from "node:os";
import path from "node:path";
import process from "node:process";

export interface HostExecutionBaseline {
  readonly path?: string;
  readonly goPath?: string;
  readonly goModCache?: string;
  readonly goCache?: string;
}

let capturedBaseline: HostExecutionBaseline | undefined;

function envValueForPlatform(
  env: NodeJS.ProcessEnv,
  name: string,
  platform: NodeJS.Platform,
): string | undefined {
  if (platform !== "win32") return env[name];
  const entries = Object.entries(env).filter(
    ([key, value]) => key.toUpperCase() === name && value !== undefined,
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

export function validateHostExecutionDirectory(
  value: string | undefined,
  platform: NodeJS.Platform = process.platform,
): string | undefined {
  if (!value || value.includes("\0")) return undefined;
  const pathApi = platform === "win32" ? path.win32 : path.posix;
  return pathApi.isAbsolute(value) ? pathApi.normalize(value) : undefined;
}

export function createHostExecutionBaseline(
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform = process.platform,
  homeDirectory: string | undefined = trustedHostHomeDirectory(),
): HostExecutionBaseline {
  const pathApi = platform === "win32" ? path.win32 : path.posix;
  const trustedHome = validateHostExecutionDirectory(homeDirectory, platform);
  const goPath =
    validateHostExecutionPath(
      envValueForPlatform(env, "GOPATH", platform),
      platform,
    ) ?? (trustedHome ? pathApi.join(trustedHome, "go") : undefined);
  const firstGoPath = goPath?.split(pathApi.delimiter)[0];
  const goModCache =
    validateHostExecutionDirectory(
      envValueForPlatform(env, "GOMODCACHE", platform),
      platform,
    ) ?? (firstGoPath ? pathApi.join(firstGoPath, "pkg", "mod") : undefined);
  const explicitGoCache = validateHostExecutionDirectory(
    envValueForPlatform(env, "GOCACHE", platform),
    platform,
  );
  const xdgCacheHome = validateHostExecutionDirectory(
    envValueForPlatform(env, "XDG_CACHE_HOME", platform),
    platform,
  );
  const localAppData = validateHostExecutionDirectory(
    envValueForPlatform(env, "LOCALAPPDATA", platform),
    platform,
  );
  const defaultGoCache = trustedHome
    ? platform === "darwin"
      ? pathApi.join(trustedHome, "Library", "Caches", "go-build")
      : platform === "win32"
        ? pathApi.join(
            localAppData ?? pathApi.join(trustedHome, "AppData", "Local"),
            "go-build",
          )
        : pathApi.join(
            xdgCacheHome ?? pathApi.join(trustedHome, ".cache"),
            "go-build",
          )
    : undefined;
  return Object.freeze({
    path: validateHostExecutionPath(
      envValueForPlatform(env, "PATH", platform),
      platform,
    ),
    goPath,
    goModCache,
    goCache: explicitGoCache ?? defaultGoCache,
  });
}

function trustedHostHomeDirectory(): string | undefined {
  try {
    return userInfo().homedir;
  } catch {
    // error-policy:J3 hosts without an OS account fail closed instead of
    // treating mutable HOME/USERPROFILE values as execution authority.
    return undefined;
  }
}

/**
 * Process-global mirrors of the captured host authority. Module state alone is
 * NOT process-global under bundling: an entrypoint that bundles this module
 * captures into ITS copy, while an externalized package (plugin-coding-tools
 * in the eliza-code ACP child) resolves a second instance from node_modules
 * whose `capturedBaseline` stays empty. The validated mirrors bridge those
 * instances and are replaced from the trusted baseline at every host spawn.
 */
const BASELINE_ENV_MIRRORS = {
  path: "ELIZA_HOST_EXECUTION_BASELINE_PATH",
  goPath: "ELIZA_HOST_EXECUTION_BASELINE_GOPATH",
  goModCache: "ELIZA_HOST_EXECUTION_BASELINE_GOMODCACHE",
  goCache: "ELIZA_HOST_EXECUTION_BASELINE_GOCACHE",
} as const;

export const HOST_EXECUTION_BASELINE_ENV_MIRROR_KEYS = Object.freeze(
  Object.values(BASELINE_ENV_MIRRORS),
);

const HOST_EXECUTION_GO_ENV_KEYS = new Set(["GOPATH", "GOMODCACHE", "GOCACHE"]);

export function isHostExecutionBaselineMirrorKey(key: string): boolean {
  const upper = key.toUpperCase();
  return HOST_EXECUTION_BASELINE_ENV_MIRROR_KEYS.some(
    (candidate) => candidate === upper,
  );
}

/** Go values and their internal mirrors are host-only spawn authority. */
export function isHostExecutionToolchainEnvKey(key: string): boolean {
  return (
    HOST_EXECUTION_GO_ENV_KEYS.has(key.toUpperCase()) ||
    isHostExecutionBaselineMirrorKey(key)
  );
}

function publishBaselineMirrors(baseline: HostExecutionBaseline): void {
  for (const [key, mirror] of Object.entries(BASELINE_ENV_MIRRORS) as Array<
    [keyof HostExecutionBaseline, string]
  >) {
    const value = baseline[key];
    if (value) process.env[mirror] = value;
    else delete process.env[mirror];
  }
}

/** Capture once. Later calls cannot replace the boot authority. */
export function captureHostExecutionBaseline(): HostExecutionBaseline {
  if (capturedBaseline) return capturedBaseline;
  capturedBaseline = createHostExecutionBaseline(process.env);
  publishBaselineMirrors(capturedBaseline);
  return capturedBaseline;
}

export function getHostExecutionBaseline(): HostExecutionBaseline {
  if (capturedBaseline) return capturedBaseline;
  const mirrored = {
    path: validateHostExecutionPath(process.env[BASELINE_ENV_MIRRORS.path]),
    goPath: validateHostExecutionPath(process.env[BASELINE_ENV_MIRRORS.goPath]),
    goModCache: validateHostExecutionDirectory(
      process.env[BASELINE_ENV_MIRRORS.goModCache],
    ),
    goCache: validateHostExecutionDirectory(
      process.env[BASELINE_ENV_MIRRORS.goCache],
    ),
  };
  if (Object.values(mirrored).some((value) => value !== undefined)) {
    capturedBaseline = createHostExecutionBaseline(
      {
        PATH: mirrored.path,
        GOPATH: mirrored.goPath,
        GOMODCACHE: mirrored.goModCache,
        GOCACHE: mirrored.goCache,
      },
      process.platform,
      trustedHostHomeDirectory(),
    );
    return capturedBaseline;
  }
  return Object.freeze({});
}

/**
 * Add only captured host authority to an already-sanitized child environment.
 * Case variants and caller-provided mirror values are removed so a mutable
 * runtime overlay cannot replace PATH or Go's workspace/cache locations.
 */
function applyBaseline(
  env: NodeJS.ProcessEnv,
  replacePath: boolean,
): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  const replacedKeys = new Set([
    "GOPATH",
    "GOMODCACHE",
    "GOCACHE",
    ...Object.values(BASELINE_ENV_MIRRORS),
  ]);
  if (replacePath) replacedKeys.add("PATH");
  for (const [key, value] of Object.entries(env)) {
    if (!replacedKeys.has(key.toUpperCase())) out[key] = value;
  }
  const baseline = getHostExecutionBaseline();
  if (replacePath && baseline.path) out.PATH = baseline.path;
  if (baseline.goPath) out.GOPATH = baseline.goPath;
  if (baseline.goModCache) out.GOMODCACHE = baseline.goModCache;
  if (baseline.goCache) out.GOCACHE = baseline.goCache;
  for (const [key, mirror] of Object.entries(BASELINE_ENV_MIRRORS) as Array<
    [keyof HostExecutionBaseline, string]
  >) {
    const value = baseline[key];
    if (value) out[mirror] = value;
  }
  return out;
}

/**
 * Replace caller-controlled Go values and every internal mirror while leaving
 * PATH itself intact for a separately validated per-session wrapper.
 */
export function applyHostToolchainExecutionBaseline(
  env: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  return applyBaseline(env, false);
}

export function applyHostExecutionBaseline(
  env: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  return applyBaseline(env, true);
}

export function resolveHostExecutable(nameOrPath: string): string | undefined {
  const trimmed = nameOrPath.trim();
  if (!trimmed || trimmed.includes("\0")) return undefined;
  const candidates: string[] = [];
  const baseline = getHostExecutionBaseline();
  const authorityDirectories =
    baseline.path?.split(path.delimiter).map((entry) => path.resolve(entry)) ??
    [];
  if (path.isAbsolute(trimmed)) {
    const candidate = path.resolve(trimmed);
    const candidateDirectory = path.dirname(candidate);
    const isAuthorized = authorityDirectories.some((directory) =>
      process.platform === "win32"
        ? directory.toLowerCase() === candidateDirectory.toLowerCase()
        : directory === candidateDirectory,
    );
    if (isAuthorized) candidates.push(candidate);
  } else if (!trimmed.includes("/") && !trimmed.includes("\\")) {
    for (const entry of authorityDirectories) {
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
