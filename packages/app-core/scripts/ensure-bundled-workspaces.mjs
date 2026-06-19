#!/usr/bin/env node

import { spawn } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveRepoRootFromImportMeta } from "./lib/repo-root.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DEFAULT_REPO_ROOT = resolveRepoRootFromImportMeta(import.meta.url);

export const BUNDLED_WORKSPACE_BUILDS = [
  {
    label: "@elizaos/plugin-agent-skills",
    cwd: path.join("plugins", "plugin-agent-skills", "typescript"),
    manifest: path.join(
      "plugins",
      "plugin-agent-skills",
      "typescript",
      "package.json",
    ),
    artifact: path.join(
      "plugins",
      "plugin-agent-skills",
      "typescript",
      "dist",
      "index.js",
    ),
    args: [
      "../../../packages/app-core/scripts/build-bundled-agent-skills-artifact.mjs",
    ],
  },
  // Only build workspaces that downstream packaging consumes directly. Building
  // every locally-linked plugin during postinstall makes unrelated plugin
  // compatibility bugs fail app setup.
];

function runCommand(command, args, { cwd, env = process.env, label } = {}) {
  const printable = label ?? `${command} ${args.join(" ")}`;

  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env,
      stdio: "inherit",
    });

    child.on("error", (error) => {
      reject(
        new Error(
          `${printable} failed: ${error instanceof Error ? error.message : String(error)}`,
        ),
      );
    });

    child.on("exit", (code, signal) => {
      if (signal) {
        reject(new Error(`${printable} exited due to signal ${signal}`));
        return;
      }

      if ((code ?? 1) !== 0) {
        reject(new Error(`${printable} exited with code ${code ?? 1}`));
        return;
      }

      resolve();
    });
  });
}

/**
 * Check if the source (package.json as proxy for "last submodule update")
 * is newer than the built artifact. This catches the case where the
 * submodule was updated with new source but the stale dist from a prior
 * version still exists on disk.
 */
function isArtifactStale(
  manifestPath,
  artifactPath,
  { pathExists = existsSync, stat = statSync } = {},
) {
  if (!pathExists(artifactPath)) return true;
  try {
    const srcMtime = stat(manifestPath).mtimeMs;
    const artMtime = stat(artifactPath).mtimeMs;
    return srcMtime > artMtime;
  } catch {
    // If stat fails, rebuild to be safe
    return true;
  }
}

export async function ensureBundledWorkspaceBuilds(
  repoRoot = DEFAULT_REPO_ROOT,
  {
    commandRunner = runCommand,
    pathExists = existsSync,
    stat = statSync,
    log = console.log,
  } = {},
) {
  for (const workspace of BUNDLED_WORKSPACE_BUILDS) {
    const manifestPath = path.join(repoRoot, workspace.manifest);
    const artifactPath = path.join(repoRoot, workspace.artifact);

    if (!pathExists(manifestPath)) {
      continue;
    }

    const stale = isArtifactStale(manifestPath, artifactPath, {
      pathExists,
      stat,
    });
    if (!stale) {
      continue;
    }

    const reason = !pathExists(artifactPath)
      ? `${workspace.artifact} is missing`
      : `${workspace.artifact} is older than ${workspace.manifest}`;
    log(
      `[ensure-bundled-workspaces] Building ${workspace.label} because ${reason}`,
    );
    await commandRunner("bun", workspace.args, {
      cwd: path.join(repoRoot, workspace.cwd),
      label: `bun ${workspace.args.join(" ")} (${workspace.label})`,
    });
  }
}

const isMain =
  process.argv[1] && path.resolve(process.argv[1]) === path.resolve(__filename);

if (isMain) {
  ensureBundledWorkspaceBuilds().catch((error) => {
    console.error(
      `[ensure-bundled-workspaces] Failed: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exit(1);
  });
}
