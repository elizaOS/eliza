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
    args: ["../../../scripts/build-bundled-agent-skills-artifact.mjs"],
  },
  // NOTE: earlier revisions of this file (cherry-picked from the
  // unmerged commit eb4846c50) tried to build 12 more workspace
  // plugins — plugin-anthropic, plugin-cron, plugin-edge-tts,
  // plugin-experience, plugin-local-embedding, plugin-ollama,
  // plugin-openai, plugin-personality, plugin-plugin-manager,
  // plugin-shell, plugin-sql, plugin-trust — so that their `dist/`
  // declarations would be available for TypeScript resolution when
  // `ELIZA_SKIP_LOCAL_UPSTREAMS=1`. In practice at least one of
  // those plugins (plugin-anthropic) has a pre-existing
  // `ModelType.TEXT_MEDIUM` compat bug against the current
  // `@elizaos/core`, which makes the postinstall fail as soon as
  // the anthropic build is attempted:
  //
  //   Error: index.ts(170,43): error TS2339: Property 'TEXT_MEDIUM'
  //   does not exist on type '{...}'.
  //
  // Nothing we ship here consumes those plugins at build-time from
  // source, so building them is a footgun. Keep only the two
  // historically-bundled builds (plugin-agent-skills) that actually need to be on disk for
  // downstream packaging to work.
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
