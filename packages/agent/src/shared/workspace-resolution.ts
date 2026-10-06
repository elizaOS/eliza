/** Resolve explicit, selected-project, current-directory, and profile workspaces. */
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolveStateDir, resolveUserPath } from "@elizaos/core";
import { getActiveProject } from "@elizaos/host";

const PROJECT_WORKSPACE_MARKERS = [
  "AGENTS.md",
  "CLAUDE.md",
  "package.json",
  "skills",
  ".git",
] as const;

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
  const explicitWorkspaceDir = env.ELIZA_WORKSPACE_DIR?.trim();
  if (explicitWorkspaceDir) {
    return resolveUserPath(explicitWorkspaceDir);
  }

  const activeProject = getActiveProject(env);
  if (activeProject?.localPath?.trim()) {
    return resolveUserPath(activeProject.localPath);
  }

  if (!env.ELIZA_STATE_DIR?.trim()) {
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
