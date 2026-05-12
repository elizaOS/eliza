import fs from "node:fs";
import path from "node:path";

export const DEFAULT_ELIZA_SOURCE_MODE = "packages";
export const DEFAULT_ELIZA_GIT_URL = "https://github.com/elizaOS/eliza.git";
export const DEFAULT_ELIZA_BRANCH = "develop";
export const DEFAULT_ELIZAOS_PACKAGE_DIST_TAG = "beta";

export const ELIZA_SOURCE_MODE_ENV_KEYS = ["ELIZA_SOURCE"];
export const LOCAL_UPSTREAM_SKIP_ENV_KEYS = ["ELIZA_SKIP_LOCAL_UPSTREAMS"];
export const LOCAL_UPSTREAM_FORCE_ENV_KEYS = ["ELIZA_FORCE_LOCAL_UPSTREAMS"];
export const ELIZAOS_PACKAGE_DIST_TAG_ENV_KEYS = [
  "ELIZAOS_DIST_TAG",
  "ELIZAOS_NPM_TAG",
];
export const ELIZAOS_PACKAGE_VERSION_ENV_KEYS = ["ELIZAOS_VERSION"];

const LOCAL_SOURCE_MODES = new Set(["local", "source", "workspace"]);
const PACKAGE_SOURCE_MODES = new Set([
  "package",
  "packages",
  "published",
  "npm",
  "registry",
  "global",
]);

function firstEnvValue(env, keys) {
  for (const key of keys) {
    const value = env[key];
    if (typeof value === "string" && value.trim().length > 0) {
      return value.trim();
    }
  }
  return null;
}

export function sourceModeMarkerPath(repoRoot) {
  return path.join(repoRoot, ".elizaos", "source-mode");
}

export function getMarkedElizaSourceMode(repoRoot) {
  try {
    const raw = fs.readFileSync(sourceModeMarkerPath(repoRoot), "utf8").trim();
    if (LOCAL_SOURCE_MODES.has(raw)) return "local";
    if (PACKAGE_SOURCE_MODES.has(raw)) return "packages";
  } catch {
    return null;
  }
  return null;
}

export function setMarkedElizaSourceMode(repoRoot, mode) {
  fs.mkdirSync(path.dirname(sourceModeMarkerPath(repoRoot)), {
    recursive: true,
  });
  fs.writeFileSync(sourceModeMarkerPath(repoRoot), `${mode}\n`);
}

export function getExplicitElizaSourceMode(env = process.env) {
  const rawMode = firstEnvValue(env, ELIZA_SOURCE_MODE_ENV_KEYS);
  if (!rawMode) return null;

  const mode = rawMode.toLowerCase();
  if (LOCAL_SOURCE_MODES.has(mode)) return "local";
  if (PACKAGE_SOURCE_MODES.has(mode)) return "packages";

  throw new Error(
    `Unsupported elizaOS source mode "${rawMode}". Use local or packages.`,
  );
}

export function getElizaSourceMode({
  env = process.env,
  repoRoot = process.cwd(),
} = {}) {
  return (
    getExplicitElizaSourceMode(env) ??
    getMarkedElizaSourceMode(repoRoot) ??
    DEFAULT_ELIZA_SOURCE_MODE
  );
}

export function isLocalElizaDisabled({
  env = process.env,
  repoRoot = process.cwd(),
} = {}) {
  if (getElizaSourceMode({ env, repoRoot }) === "packages") return true;
  return LOCAL_UPSTREAM_SKIP_ENV_KEYS.some((key) => env[key] === "1");
}

export function isLocalElizaForced({
  env = process.env,
  repoRoot = process.cwd(),
} = {}) {
  if (getExplicitElizaSourceMode(env) === "local") return true;
  if (getMarkedElizaSourceMode(repoRoot) === "local") return true;
  return LOCAL_UPSTREAM_FORCE_ENV_KEYS.some((key) => env[key] === "1");
}

export function getElizaGitUrl(env = process.env) {
  return firstEnvValue(env, ["ELIZA_GIT_URL"]) ?? DEFAULT_ELIZA_GIT_URL;
}

export function getElizaGitBranch(env = process.env) {
  return firstEnvValue(env, ["ELIZA_BRANCH"]) ?? DEFAULT_ELIZA_BRANCH;
}

export function getElizaosPackageExactVersion(env = process.env) {
  return firstEnvValue(env, ELIZAOS_PACKAGE_VERSION_ENV_KEYS);
}

export function getElizaosPackageDistTag(env = process.env) {
  return (
    firstEnvValue(env, ELIZAOS_PACKAGE_DIST_TAG_ENV_KEYS) ??
    DEFAULT_ELIZAOS_PACKAGE_DIST_TAG
  );
}

export function getElizaosPackageSpecifier(env = process.env) {
  return getElizaosPackageExactVersion(env) ?? getElizaosPackageDistTag(env);
}
