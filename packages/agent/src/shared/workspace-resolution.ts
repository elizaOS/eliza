import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolveStateDir, resolveUserPath } from "../config/paths.ts";

const EXPLICIT_WORKSPACE_DIR_KEYS = ["ELIZA_WORKSPACE_DIR"] as const;
const EXPLICIT_STATE_DIR_KEYS = [
  "MILADY_STATE_DIR",
  "ELIZA_STATE_DIR",
] as const;
const PROJECT_WORKSPACE_MARKERS = [
  "AGENTS.md",
  "CLAUDE.md",
  "package.json",
  "skills",
  ".git",
] as const;

function readWorkspaceDirOverride(env: NodeJS.ProcessEnv): string | undefined {
  for (const key of EXPLICIT_WORKSPACE_DIR_KEYS) {
    const value = env[key]?.trim();
    if (value) {
      return value;
    }
  }
  return undefined;
}

function hasExplicitStateDirOverride(env: NodeJS.ProcessEnv): boolean {
  return EXPLICIT_STATE_DIR_KEYS.some((key) => Boolean(env[key]?.trim()));
}

function isLikelyPackagedRuntimeDir(dir: string): boolean {
  if (typeof dir !== "string") return false;
  const normalized = dir.replace(/\\/g, "/").toLowerCase();
  return (
    normalized.includes("/eliza-dist") ||
    normalized.includes("/contents/resources/app/") ||
    normalized.includes("/resources/app/") ||
    normalized.includes("/self-extraction/")
  );
}

export function shouldUseRuntimeCwdWorkspace(candidateDir: string): boolean {
  const resolvedDir = resolveUserPath(candidateDir);
  if (
    !resolvedDir ||
    typeof resolvedDir !== "string" ||
    isLikelyPackagedRuntimeDir(resolvedDir)
  ) {
    return false;
  }

  return PROJECT_WORKSPACE_MARKERS.some((marker) =>
    existsSync(path.join(resolvedDir, marker)),
  );
}

export function shouldBootstrapWorkspaceInitFiles(
  candidateDir: string,
): boolean {
  return !shouldUseRuntimeCwdWorkspace(candidateDir);
}

export function resolveDefaultAgentWorkspaceDir(
  env: NodeJS.ProcessEnv = process.env,
  homedir: () => string = os.homedir,
  cwd: () => string = process.cwd,
): string {
  const explicitWorkspaceDir = readWorkspaceDirOverride(env);
  if (explicitWorkspaceDir) {
    return resolveUserPath(explicitWorkspaceDir);
  }

  if (!hasExplicitStateDirOverride(env)) {
    const runtimeCwd = typeof cwd === "function" ? cwd() : undefined;
    if (
      typeof runtimeCwd === "string" &&
      runtimeCwd.trim() &&
      shouldUseRuntimeCwdWorkspace(runtimeCwd.trim())
    ) {
      return resolveUserPath(runtimeCwd);
    }
  }

  const profile = env.ELIZA_PROFILE?.trim();
  const stateDir = resolveStateDir(env, homedir);
  if (profile && profile.toLowerCase() !== "default") {
    return path.join(stateDir, `workspace-${profile}`);
  }
  return path.join(stateDir, "workspace");
}

export const DEFAULT_AGENT_WORKSPACE_DIR = resolveDefaultAgentWorkspaceDir();
