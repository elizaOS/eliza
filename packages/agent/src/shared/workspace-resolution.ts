/**
 * Resolves the agent's default workspace directory — the folder the runtime
 * treats as the user's project root for hooks, skills, and init files.
 * Precedence: an explicit `ELIZA_WORKSPACE_DIR` override, the desktop-picked
 * folder persisted to `<stateDir>/workspace-folder.json`, the current working
 * directory when it looks like a real project (and no `ELIZA_STATE_DIR` is
 * pinned), then a per-profile `workspace` folder under the state dir. Also
 * decides whether the cwd counts as a project workspace and whether init files
 * should be bootstrapped, excluding packaged desktop runtime directories.
 */
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { getActiveProject, readWorkspaceFolderConfig } from "@elizaos/core";
import { resolveStateDir, resolveUserPath } from "../config/paths.ts";

const EXPLICIT_WORKSPACE_DIR_KEYS = ["ELIZA_WORKSPACE_DIR"] as const;
const EXPLICIT_STATE_DIR_KEYS = ["ELIZA_STATE_DIR"] as const;
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

  // The active project in <stateDir>/projects.json wins over the legacy
  // single-folder config: it is the first-class replacement for it, and the
  // desktop picker upserts+activates a project here. When projects.json is
  // absent the registry synthesizes an active project from the legacy
  // workspace-folder.json (see readProjectRegistry), so this step subsumes the
  // legacy read below without changing behavior for a lone picked folder.
  const activeProject = getActiveProject(env);
  if (activeProject?.localPath?.trim()) {
    return resolveUserPath(activeProject.localPath);
  }

  // Store-distributed desktop builds write the user-picked workspace folder
  // to <stateDir>/workspace-folder.json via the Electrobun desktop RPC.
  // Honor that file as a higher-priority signal than the project-cwd auto-
  // detect heuristic so the user's explicit choice always wins under the
  // sandbox. Falls through silently when the file is absent or unreadable.
  try {
    const persisted = readWorkspaceFolderConfig(env);
    if (persisted?.path?.trim()) {
      return resolveUserPath(persisted.path);
    }
  } catch {
    // Ignore — fall through to cwd / state-dir defaults.
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
