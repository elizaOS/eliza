import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import {
  getPluginInfo,
  resolveStateDir,
} from "@elizaos/agent";
import { logger } from "@elizaos/core";
import { createSerialise } from "../utils/serialise";
import {
  assertValidGitUrl,
  detectPackageManager,
  resolveGitBranch,
  sanitisePackageName,
  VALID_BRANCH,
  VALID_GIT_URL,
  VALID_PACKAGE_NAME,
} from "./plugin-installer";

const execFileAsync = promisify(execFile);
const UPSTREAM_SCHEMA = "eliza-upstream-v1";

function isSupportedUpstreamSchema(value: string): boolean {
  return value === UPSTREAM_SCHEMA;
}

const serialise = createSerialise();

export interface UpstreamMetadata {
  $schema: typeof UPSTREAM_SCHEMA;
  source: string;
  gitUrl: string;
  branch: string;
  commitHash: string;
  ejectedAt: string;
  npmPackage: string;
  npmVersion: string;
  lastSyncAt: string | null;
  localCommits: number;
}

export interface EjectedPluginInfo {
  name: string;
  path: string;
  version: string;
  upstream: UpstreamMetadata | null;
}

export interface EjectResult {
  success: boolean;
  pluginName: string;
  ejectedPath: string;
  upstreamCommit: string;
  error?: string;
}

export interface SyncResult {
  success: boolean;
  pluginName: string;
  ejectedPath: string;
  upstreamCommits: number;
  localChanges: boolean;
  conflicts: string[];
  commitHash: string;
  error?: string;
}

export interface ReinjectResult {
  success: boolean;
  pluginName: string;
  removedPath: string;
  error?: string;
}

function ejectedBaseDir(): string {
  return path.join(resolveStateDir(), "plugins", "ejected");
}

function upstreamFilePath(pluginDir: string): string {
  return path.join(pluginDir, ".upstream.json");
}

export function isWithinEjectedDir(targetPath: string): boolean {
  const base = path.resolve(ejectedBaseDir());
  const resolved = path.resolve(targetPath);
  if (resolved === base) return false;
  return resolved.startsWith(`${base}${path.sep}`);
}

function toShortId(name: string): string {
  return name.replace(/^@[^/]+\//, "").replace(/^plugin-/, "");
}

async function gitStdout(args: string[], cwd?: string): Promise<string> {
  const { stdout } = await execFileAsync("git", args, {
    cwd,
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
  });
  return stdout.trim();
}

async function readPackageNameVersion(pluginDir: string): Promise<{
  name: string;
  version: string;
}> {
  let name = path.basename(pluginDir);
  let version = "0.0.0";
  try {
    const raw = await fs.readFile(
      path.join(pluginDir, "package.json"),
      "utf-8",
    );
    const pkg = JSON.parse(raw) as { name?: string; version?: string };
    if (typeof pkg.name === "string" && pkg.name.trim()) name = pkg.name.trim();
    if (typeof pkg.version === "string" && pkg.version.trim()) {
      version = pkg.version.trim();
    }
  } catch (err) {
    logger.warn(
      `[plugin-eject] Failed to read package.json in ${pluginDir}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  return { name, version };
}

async function readUpstreamMetadata(
  pluginDir: string,
): Promise<UpstreamMetadata | null> {
  try {
    const raw = await fs.readFile(upstreamFilePath(pluginDir), "utf-8");
    const parsed = JSON.parse(raw) as Partial<UpstreamMetadata>;
    if (
      typeof parsed.$schema !== "string" ||
      !isSupportedUpstreamSchema(parsed.$schema) ||
      typeof parsed.gitUrl !== "string" ||
      typeof parsed.branch !== "string" ||
      typeof parsed.commitHash !== "string" ||
      typeof parsed.npmPackage !== "string" ||
      typeof parsed.npmVersion !== "string"
    ) {
      return null;
    }
    return {
      $schema: UPSTREAM_SCHEMA,
      source:
        typeof parsed.source === "string" ? parsed.source : parsed.npmPackage,
      gitUrl: parsed.gitUrl,
      branch: parsed.branch,
      commitHash: parsed.commitHash,
      ejectedAt:
        typeof parsed.ejectedAt === "string"
          ? parsed.ejectedAt
          : new Date().toISOString(),
      npmPackage: parsed.npmPackage,
      npmVersion: parsed.npmVersion,
      lastSyncAt:
        typeof parsed.lastSyncAt === "string" || parsed.lastSyncAt === null
          ? parsed.lastSyncAt
          : null,
      localCommits:
        typeof parsed.localCommits === "number" &&
        Number.isFinite(parsed.localCommits)
          ? parsed.localCommits
          : 0,
    };
  } catch (err) {
    logger.warn(
      `[plugin-eject] Failed to read upstream metadata for ${pluginDir}: ${err instanceof Error ? err.message : String(err)}`,
    );
    return null;
  }
}

async function writeUpstreamMetadata(
  pluginDir: string,
  metadata: UpstreamMetadata,
): Promise<void> {
  await fs.writeFile(
    upstreamFilePath(pluginDir),
    `${JSON.stringify(metadata, null, 2)}\n`,
    "utf-8",
  );
}

async function runInstallDeps(cwd: string): Promise<void> {
  // SECURITY: --ignore-scripts prevents postinstall lifecycle scripts from
  // executing arbitrary code on the host (see PR #573 for full analysis).
  const pm = await detectPackageManager();
  try {
    await execFileAsync(pm, ["install", "--ignore-scripts"], { cwd });
  } catch (err) {
    if (pm === "npm") throw err;
    logger.warn(
      `[plugin-eject] ${pm} install failed; retrying with npm: ${err instanceof Error ? err.message : String(err)}`,
    );
    await execFileAsync("npm", ["install", "--ignore-scripts"], { cwd });
  }
}

async function maybeRunBuild(cwd: string): Promise<void> {
  try {
    const raw = await fs.readFile(path.join(cwd, "package.json"), "utf-8");
    const pkg = JSON.parse(raw) as {
      scripts?: Record<string, string>;
    };
    if (!pkg.scripts?.build) return;
  } catch (err) {
    logger.warn(
      `[plugin-eject] Failed to read package.json for build check in ${cwd}: ${err instanceof Error ? err.message : String(err)}`,
    );
    return;
  }

  const pm = await detectPackageManager();
  try {
    await execFileAsync(pm, ["run", "build"], { cwd });
  } catch (err) {
    logger.warn(
      `[plugin-eject] Build script failed (non-fatal); continuing: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

async function resolveEjectedDirById(pluginId: string): Promise<string | null> {
  const trimmed = pluginId.trim();
  if (!trimmed) return null;
  const targetLower = trimmed.toLowerCase();
  const base = ejectedBaseDir();

  let entries: Array<import("node:fs").Dirent>;
  try {
    entries = await fs.readdir(base, { withFileTypes: true });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const dir = path.join(base, entry.name);
    const info = await readPackageNameVersion(dir);
    const upstream = await readUpstreamMetadata(dir);
    const candidates = new Set<string>([
      entry.name.toLowerCase(),
      info.name.toLowerCase(),
      toShortId(info.name).toLowerCase(),
    ]);
    if (upstream) {
      candidates.add(upstream.npmPackage.toLowerCase());
      candidates.add(toShortId(upstream.npmPackage).toLowerCase());
    }
    if (candidates.has(targetLower)) return dir;
  }

  return null;
}

export function ejectPlugin(pluginId: string): Promise<EjectResult> {
  return serialise(async () => {
    const id = pluginId.trim();
    if (!id) {
      return {
        success: false,
        pluginName: pluginId,
        ejectedPath: "",
        upstreamCommit: "",
        error: "Plugin ID is required",
      };
    }

    const info = await getPluginInfo(id);
    if (!info) {
      return {
        success: false,
        pluginName: id,
        ejectedPath: "",
        upstreamCommit: "",
        error: `Plugin "${id}" not found in registry`,
      };
    }

    const canonicalName = info.name;
    if (!VALID_PACKAGE_NAME.test(canonicalName)) {
      return {
        success: false,
        pluginName: canonicalName,
        ejectedPath: "",
        upstreamCommit: "",
        error: `Invalid package name: "${canonicalName}"`,
      };
    }

    const gitUrl = info.gitUrl;
    if (!VALID_GIT_URL.test(gitUrl)) {
      return {
        success: false,
        pluginName: canonicalName,
        ejectedPath: "",
        upstreamCommit: "",
        error: `Invalid git URL: "${gitUrl}"`,
      };
    }
    assertValidGitUrl(gitUrl);

    const branch = await resolveGitBranch(info);
    if (!VALID_BRANCH.test(branch)) {
      return {
        success: false,
        pluginName: canonicalName,
        ejectedPath: "",
        upstreamCommit: "",
        error: `Invalid git branch: "${branch}"`,
      };
    }

    const base = ejectedBaseDir();
    await fs.mkdir(base, { recursive: true });

    const targetDir = path.join(base, sanitisePackageName(canonicalName));
    if (!isWithinEjectedDir(targetDir)) {
      return {
        success: false,
        pluginName: canonicalName,
        ejectedPath: targetDir,
        upstreamCommit: "",
        error: `Refusing to write outside ${base}`,
      };
    }

    try {
      await fs.access(targetDir);
      return {
        success: false,
        pluginName: canonicalName,
        ejectedPath: targetDir,
        upstreamCommit: "",
        error: `Plugin "${canonicalName}" is already ejected at ${targetDir}`,
      };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
        throw err;
      }
    }

    await execFileAsync(
      "git",
      [
        "-c",
        "protocol.file.allow=never",
        "clone",
        "--branch",
        branch,
        "--single-branch",
        "--depth",
        "1",
        "--",
        gitUrl,
        targetDir,
      ],
      { env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } },
    );

    try {
      await runInstallDeps(targetDir);
      await maybeRunBuild(targetDir);
      const commitHash = await gitStdout(["rev-parse", "HEAD"], targetDir);

      const metadata: UpstreamMetadata = {
        $schema: UPSTREAM_SCHEMA,
        source: `github:${info.gitRepo}`,
        gitUrl,
        branch,
        commitHash,
        ejectedAt: new Date().toISOString(),
        npmPackage: info.npm.package || canonicalName,
        npmVersion:
          info.npm.v2Version ||
          info.npm.v1Version ||
          info.npm.v0Version ||
          "unknown",
        lastSyncAt: null,
        localCommits: 0,
      };
      await writeUpstreamMetadata(targetDir, metadata);

      return {
        success: true,
        pluginName: canonicalName,
        ejectedPath: targetDir,
        upstreamCommit: commitHash,
      };
    } catch (err) {
      await fs.rm(targetDir, { recursive: true, force: true });
      return {
        success: false,
        pluginName: canonicalName,
        ejectedPath: targetDir,
        upstreamCommit: "",
        error: err instanceof Error ? err.message : String(err),
      };
    }
  });
}

export function syncPlugin(pluginId: string): Promise<SyncResult> {
  return serialise(async () => {
    const pluginDir = await resolveEjectedDirById(pluginId);
    if (!pluginDir) {
      return {
        success: false,
        pluginName: pluginId,
        ejectedPath: "",
        upstreamCommits: 0,
        localChanges: false,
        conflicts: [],
        commitHash: "",
        error: `Plugin "${pluginId}" is not ejected`,
      };
    }
    if (!isWithinEjectedDir(pluginDir)) {
      return {
        success: false,
        pluginName: pluginId,
        ejectedPath: pluginDir,
        upstreamCommits: 0,
        localChanges: false,
        conflicts: [],
        commitHash: "",
        error: `Refusing to sync plugin outside ${ejectedBaseDir()}`,
      };
    }

    const pkg = await readPackageNameVersion(pluginDir);
    const upstream = await readUpstreamMetadata(pluginDir);
    if (!upstream) {
      return {
        success: false,
        pluginName: pkg.name,
        ejectedPath: pluginDir,
        upstreamCommits: 0,
        localChanges: false,
        conflicts: [],
        commitHash: "",
        error: `Missing or invalid ${upstreamFilePath(pluginDir)}`,
      };
    }
    if (
      !VALID_GIT_URL.test(upstream.gitUrl) ||
      !VALID_BRANCH.test(upstream.branch)
    ) {
      return {
        success: false,
        pluginName: pkg.name,
        ejectedPath: pluginDir,
        upstreamCommits: 0,
        localChanges: false,
        conflicts: [],
        commitHash: "",
        error: "Invalid upstream metadata",
      };
    }

    const isShallow = await gitStdout(
      ["rev-parse", "--is-shallow-repository"],
      pluginDir,
    ).catch((err: unknown) => {
      logger.warn(
        `[plugin-eject] Failed to check shallow status: ${err instanceof Error ? err.message : String(err)}`,
      );
      return "false";
    });
    if (isShallow === "true") {
      try {
        await execFileAsync(
          "git",
          ["fetch", "--unshallow", "origin", upstream.branch],
          {
            cwd: pluginDir,
            env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
          },
        );
      } catch (err) {
        logger.warn(
          `[plugin-eject] git fetch --unshallow failed, continuing with normal fetch: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    await execFileAsync("git", ["fetch", "origin", upstream.branch], {
      cwd: pluginDir,
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    });

    const localChanges =
      (await gitStdout(["status", "--porcelain"], pluginDir)).length > 0;
    const upstreamCountRaw = await gitStdout(
      ["rev-list", "--count", `HEAD..origin/${upstream.branch}`],
      pluginDir,
    );
    const upstreamCommits = Number.parseInt(upstreamCountRaw, 10) || 0;

    if (upstreamCommits > 0) {
      try {
        await execFileAsync(
          "git",
          ["merge", "--no-edit", `origin/${upstream.branch}`],
          {
            cwd: pluginDir,
            env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
          },
        );
      } catch (err) {
        const conflictsRaw = await gitStdout(
          ["diff", "--name-only", "--diff-filter=U"],
          pluginDir,
        ).catch((diffErr: unknown) => {
          logger.warn(
            `[plugin-eject] Failed to list merge conflicts: ${diffErr instanceof Error ? diffErr.message : String(diffErr)}`,
          );
          return "";
        });
        const conflicts = conflictsRaw
          .split("\n")
          .map((line) => line.trim())
          .filter(Boolean);
        return {
          success: false,
          pluginName: pkg.name,
          ejectedPath: pluginDir,
          upstreamCommits,
          localChanges,
          conflicts,
          commitHash: "",
          error: err instanceof Error ? err.message : String(err),
        };
      }
    }

    try {
      await runInstallDeps(pluginDir);
      await maybeRunBuild(pluginDir);
    } catch (err) {
      return {
        success: false,
        pluginName: pkg.name,
        ejectedPath: pluginDir,
        upstreamCommits,
        localChanges,
        conflicts: [],
        commitHash: "",
        error: `Post-sync build failed: ${err instanceof Error ? err.message : String(err)}`,
      };
    }

    const commitHash = await gitStdout(["rev-parse", "HEAD"], pluginDir);
    const localCommitsRaw = await gitStdout(
      ["rev-list", "--count", `origin/${upstream.branch}..HEAD`],
      pluginDir,
    );
    const localCommits = Number.parseInt(localCommitsRaw, 10) || 0;

    const updated: UpstreamMetadata = {
      ...upstream,
      commitHash,
      lastSyncAt: new Date().toISOString(),
      localCommits,
    };
    await writeUpstreamMetadata(pluginDir, updated);

    return {
      success: true,
      pluginName: pkg.name,
      ejectedPath: pluginDir,
      upstreamCommits,
      localChanges,
      conflicts: [],
      commitHash,
    };
  });
}

export function reinjectPlugin(pluginId: string): Promise<ReinjectResult> {
  return serialise(async () => {
    const pluginDir = await resolveEjectedDirById(pluginId);
    if (!pluginDir) {
      return {
        success: false,
        pluginName: pluginId,
        removedPath: "",
        error: `Plugin "${pluginId}" is not ejected`,
      };
    }
    if (!isWithinEjectedDir(pluginDir)) {
      return {
        success: false,
        pluginName: pluginId,
        removedPath: pluginDir,
        error: `Refusing to remove plugin outside ${ejectedBaseDir()}`,
      };
    }

    const pkg = await readPackageNameVersion(pluginDir);
    await fs.rm(pluginDir, { recursive: true, force: false });
    return {
      success: true,
      pluginName: pkg.name,
      removedPath: pluginDir,
    };
  });
}

export async function listEjectedPlugins(): Promise<EjectedPluginInfo[]> {
  const base = ejectedBaseDir();
  let entries: Array<import("node:fs").Dirent>;
  try {
    entries = await fs.readdir(base, { withFileTypes: true });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }

  const plugins: EjectedPluginInfo[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const pluginDir = path.join(base, entry.name);
    if (!isWithinEjectedDir(pluginDir)) continue;
    const pkg = await readPackageNameVersion(pluginDir);
    plugins.push({
      name: pkg.name,
      path: pluginDir,
      version: pkg.version,
      upstream: await readUpstreamMetadata(pluginDir),
    });
  }

  plugins.sort((a, b) => a.name.localeCompare(b.name));
  return plugins;
}
