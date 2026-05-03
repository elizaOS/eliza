import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { promisify } from "node:util";
import { getPluginInfo, resolveStateDir } from "@elizaos/agent";
import { logger } from "@elizaos/core";
import { createSerialise } from "../utils/serialise";
import {
  assertValidGitUrl,
  VALID_BRANCH,
  VALID_GIT_URL,
} from "./plugin-installer";

const execFileAsync = promisify(execFile);

const CORE_GIT_URL = "https://github.com/elizaos/eliza.git";
const CORE_BRANCH = "develop";
const CORE_PACKAGE_NAME = "@elizaos/core";
const DEFAULT_CORE_PATHS = ["../packages/typescript/src/index.node.ts"];
const DEFAULT_CORE_SUBPATHS = ["../packages/typescript/src/*"];
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

export interface CoreEjectResult {
  success: boolean;
  ejectedPath: string;
  upstreamCommit: string;
  error?: string;
}

export interface CoreSyncResult {
  success: boolean;
  ejectedPath: string;
  upstreamCommits: number;
  localChanges: boolean;
  conflicts: string[];
  commitHash: string;
  error?: string;
}

export interface CoreReinjectResult {
  success: boolean;
  removedPath: string;
  error?: string;
}

export interface CoreStatus {
  ejected: boolean;
  ejectedPath: string;
  monorepoPath: string;
  corePackagePath: string;
  coreDistPath: string;
  version: string;
  npmVersion: string;
  commitHash: string | null;
  localChanges: boolean;
  upstream: UpstreamMetadata | null;
}

interface TsConfig {
  compilerOptions?: {
    paths?: Record<string, string[]>;
  };
}

function coreBaseDir(): string {
  return path.join(resolveStateDir(), "core");
}

function coreMonorepoDir(): string {
  return path.join(coreBaseDir(), "eliza");
}

function corePackageDir(): string {
  return path.join(coreMonorepoDir(), "packages", "core");
}

function coreDistDir(): string {
  return path.join(corePackageDir(), "dist");
}

function upstreamFilePath(): string {
  return path.join(coreBaseDir(), ".upstream.json");
}

function tsconfigFilePath(): string {
  return path.join(process.cwd(), "tsconfig.json");
}

export function isWithinEjectedCoreDir(targetPath: string): boolean {
  const base = path.resolve(coreBaseDir());
  const resolved = path.resolve(targetPath);
  if (resolved === base) return false;
  return resolved.startsWith(`${base}${path.sep}`);
}

async function gitStdout(args: string[], cwd?: string): Promise<string> {
  const { stdout } = await execFileAsync("git", args, {
    cwd,
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
  });
  return stdout.trim();
}

async function pathExists(targetPath: string): Promise<boolean> {
  try {
    await fs.access(targetPath);
    return true;
  } catch (err) {
    logger.debug(
      `[core-eject] pathExists check failed for ${targetPath}: ${err instanceof Error ? err.message : String(err)}`,
    );
    return false;
  }
}

async function readCorePackageVersion(
  packageDir = corePackageDir(),
): Promise<string> {
  try {
    const raw = await fs.readFile(
      path.join(packageDir, "package.json"),
      "utf-8",
    );
    const parsed = JSON.parse(raw) as { version?: string };
    if (typeof parsed.version === "string" && parsed.version.trim()) {
      return parsed.version.trim();
    }
  } catch (err) {
    logger.warn(
      `[core-eject] Failed to read core package version: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  return "unknown";
}

async function resolveInstalledCoreVersion(): Promise<string> {
  try {
    const info = await getPluginInfo(CORE_PACKAGE_NAME);
    const npmVersion =
      info?.npm.v2Version ?? info?.npm.v1Version ?? info?.npm.v0Version;
    if (typeof npmVersion === "string" && npmVersion.trim()) {
      return npmVersion.trim();
    }
  } catch (err) {
    logger.warn(
      `[core-eject] Registry lookup for installed core version failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  try {
    const require = createRequire(import.meta.url);
    const pkgPath = require.resolve(`${CORE_PACKAGE_NAME}/package.json`);
    const raw = await fs.readFile(pkgPath, "utf-8");
    const pkg = JSON.parse(raw) as { version?: string };
    if (typeof pkg.version === "string" && pkg.version.trim()) {
      return pkg.version.trim();
    }
  } catch (err) {
    logger.warn(
      `[core-eject] Failed to resolve installed core version via require: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  return "unknown";
}

async function readUpstreamMetadata(): Promise<UpstreamMetadata | null> {
  try {
    const raw = await fs.readFile(upstreamFilePath(), "utf-8");
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
        typeof parsed.source === "string"
          ? parsed.source
          : "github:elizaos/eliza",
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
      `[core-eject] Failed to read upstream metadata: ${err instanceof Error ? err.message : String(err)}`,
    );
    return null;
  }
}

async function writeUpstreamMetadata(
  metadata: UpstreamMetadata,
): Promise<void> {
  await fs.mkdir(coreBaseDir(), { recursive: true });
  await fs.writeFile(
    upstreamFilePath(),
    `${JSON.stringify(metadata, null, 2)}\n`,
    "utf-8",
  );
}

async function readTsconfig(): Promise<TsConfig> {
  const raw = await fs.readFile(tsconfigFilePath(), "utf-8");
  return JSON.parse(raw) as TsConfig;
}

async function writeTsconfigCorePaths(
  targetDistPath: string | null,
): Promise<void> {
  const config = await readTsconfig();
  if (!config.compilerOptions) config.compilerOptions = {};
  if (!config.compilerOptions.paths) config.compilerOptions.paths = {};

  if (!targetDistPath) {
    config.compilerOptions.paths[CORE_PACKAGE_NAME] = [...DEFAULT_CORE_PATHS];
    config.compilerOptions.paths[`${CORE_PACKAGE_NAME}/*`] = [
      ...DEFAULT_CORE_SUBPATHS,
    ];
  } else {
    const tsconfigDir = path.dirname(tsconfigFilePath());
    const relDist = path.relative(tsconfigDir, targetDistPath);
    const relSubpath = path.join(relDist, "*");
    config.compilerOptions.paths[CORE_PACKAGE_NAME] = [relDist];
    config.compilerOptions.paths[`${CORE_PACKAGE_NAME}/*`] = [relSubpath];
  }

  await fs.writeFile(
    tsconfigFilePath(),
    `${JSON.stringify(config, null, 2)}\n`,
    "utf-8",
  );
}

async function runCoreInstallAndBuild(monorepoDir: string): Promise<void> {
  // SECURITY: --ignore-scripts prevents postinstall lifecycle scripts from
  // executing arbitrary code on the host (see PR #573 for full analysis).
  await execFileAsync("bun", ["install", "--ignore-scripts"], {
    cwd: monorepoDir,
  });
  await execFileAsync("bun", ["run", "--filter", CORE_PACKAGE_NAME, "build"], {
    cwd: monorepoDir,
  });
}

async function ensureEjectedCoreExists(): Promise<
  { ok: true } | { ok: false; error: string }
> {
  const monorepoDir = coreMonorepoDir();
  if (!(await pathExists(monorepoDir))) {
    return { ok: false, error: `${CORE_PACKAGE_NAME} is not ejected` };
  }
  if (!isWithinEjectedCoreDir(monorepoDir)) {
    return {
      ok: false,
      error: `Refusing to use core checkout outside ${coreBaseDir()}`,
    };
  }
  return { ok: true };
}

export function ejectCore(): Promise<CoreEjectResult> {
  return serialise(async () => {
    const npmVersion = await resolveInstalledCoreVersion();

    if (!VALID_GIT_URL.test(CORE_GIT_URL)) {
      return {
        success: false,
        ejectedPath: "",
        upstreamCommit: "",
        error: `Invalid git URL: "${CORE_GIT_URL}"`,
      };
    }
    assertValidGitUrl(CORE_GIT_URL);

    if (!VALID_BRANCH.test(CORE_BRANCH)) {
      return {
        success: false,
        ejectedPath: "",
        upstreamCommit: "",
        error: `Invalid git branch: "${CORE_BRANCH}"`,
      };
    }

    const base = coreBaseDir();
    await fs.mkdir(base, { recursive: true });

    const monorepoDir = coreMonorepoDir();
    if (!isWithinEjectedCoreDir(monorepoDir)) {
      return {
        success: false,
        ejectedPath: monorepoDir,
        upstreamCommit: "",
        error: `Refusing to write outside ${base}`,
      };
    }

    if (await pathExists(monorepoDir)) {
      return {
        success: false,
        ejectedPath: monorepoDir,
        upstreamCommit: "",
        error: `${CORE_PACKAGE_NAME} is already ejected at ${monorepoDir}`,
      };
    }

    await execFileAsync(
      "git",
      [
        "-c",
        "protocol.file.allow=never",
        "clone",
        "--branch",
        CORE_BRANCH,
        "--single-branch",
        "--depth",
        "1",
        "--",
        CORE_GIT_URL,
        monorepoDir,
      ],
      { env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } },
    );

    try {
      await runCoreInstallAndBuild(monorepoDir);

      const distPath = coreDistDir();
      if (!(await pathExists(distPath))) {
        throw new Error(`Missing built output at ${distPath}`);
      }

      const commitHash = await gitStdout(["rev-parse", "HEAD"], monorepoDir);
      const metadata: UpstreamMetadata = {
        $schema: UPSTREAM_SCHEMA,
        source: "github:elizaos/eliza",
        gitUrl: CORE_GIT_URL,
        branch: CORE_BRANCH,
        commitHash,
        ejectedAt: new Date().toISOString(),
        npmPackage: CORE_PACKAGE_NAME,
        npmVersion,
        lastSyncAt: null,
        localCommits: 0,
      };

      await writeUpstreamMetadata(metadata);
      await writeTsconfigCorePaths(distPath);

      return {
        success: true,
        ejectedPath: monorepoDir,
        upstreamCommit: commitHash,
      };
    } catch (err) {
      await fs.rm(monorepoDir, { recursive: true, force: true });
      await fs.rm(upstreamFilePath(), { force: true });
      return {
        success: false,
        ejectedPath: monorepoDir,
        upstreamCommit: "",
        error: err instanceof Error ? err.message : String(err),
      };
    }
  });
}

export function syncCore(): Promise<CoreSyncResult> {
  return serialise(async () => {
    const check = await ensureEjectedCoreExists();
    if (!check.ok) {
      return {
        success: false,
        ejectedPath: "",
        upstreamCommits: 0,
        localChanges: false,
        conflicts: [],
        commitHash: "",
        error: check.error,
      };
    }

    const monorepoDir = coreMonorepoDir();
    const upstream = await readUpstreamMetadata();
    if (!upstream) {
      return {
        success: false,
        ejectedPath: monorepoDir,
        upstreamCommits: 0,
        localChanges: false,
        conflicts: [],
        commitHash: "",
        error: `Missing or invalid ${upstreamFilePath()}`,
      };
    }

    if (
      !VALID_GIT_URL.test(upstream.gitUrl) ||
      !VALID_BRANCH.test(upstream.branch)
    ) {
      return {
        success: false,
        ejectedPath: monorepoDir,
        upstreamCommits: 0,
        localChanges: false,
        conflicts: [],
        commitHash: "",
        error: "Invalid upstream metadata",
      };
    }

    const isShallow = await gitStdout(
      ["rev-parse", "--is-shallow-repository"],
      monorepoDir,
    ).catch((err: unknown) => {
      logger.warn(
        `[core-eject] Failed to check shallow status: ${err instanceof Error ? err.message : String(err)}`,
      );
      return "false";
    });

    if (isShallow === "true") {
      try {
        await execFileAsync(
          "git",
          ["fetch", "--unshallow", "origin", upstream.branch],
          {
            cwd: monorepoDir,
            env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
          },
        );
      } catch (err) {
        logger.warn(
          `[core-eject] git fetch --unshallow failed, continuing with normal fetch: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    await execFileAsync("git", ["fetch", "origin", upstream.branch], {
      cwd: monorepoDir,
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    });

    const localChanges =
      (await gitStdout(["status", "--porcelain"], monorepoDir)).length > 0;
    const upstreamCountRaw = await gitStdout(
      ["rev-list", "--count", `HEAD..origin/${upstream.branch}`],
      monorepoDir,
    );
    const upstreamCommits = Number.parseInt(upstreamCountRaw, 10) || 0;

    if (upstreamCommits > 0) {
      try {
        await execFileAsync(
          "git",
          ["merge", "--no-edit", `origin/${upstream.branch}`],
          {
            cwd: monorepoDir,
            env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
          },
        );
      } catch (err) {
        const conflictsRaw = await gitStdout(
          ["diff", "--name-only", "--diff-filter=U"],
          monorepoDir,
        ).catch((diffErr: unknown) => {
          logger.warn(
            `[core-eject] Failed to list merge conflicts: ${diffErr instanceof Error ? (diffErr as Error).message : String(diffErr)}`,
          );
          return "";
        });
        const conflicts = conflictsRaw
          .split("\n")
          .map((line) => line.trim())
          .filter(Boolean);

        return {
          success: false,
          ejectedPath: monorepoDir,
          upstreamCommits,
          localChanges,
          conflicts,
          commitHash: "",
          error: err instanceof Error ? err.message : String(err),
        };
      }
    }

    try {
      await runCoreInstallAndBuild(monorepoDir);
      await writeTsconfigCorePaths(coreDistDir());
    } catch (err) {
      return {
        success: false,
        ejectedPath: monorepoDir,
        upstreamCommits,
        localChanges,
        conflicts: [],
        commitHash: "",
        error: err instanceof Error ? err.message : String(err),
      };
    }

    const commitHash = await gitStdout(["rev-parse", "HEAD"], monorepoDir);
    const localCommitsRaw = await gitStdout(
      ["rev-list", "--count", `origin/${upstream.branch}..HEAD`],
      monorepoDir,
    );
    const localCommits = Number.parseInt(localCommitsRaw, 10) || 0;

    const updated: UpstreamMetadata = {
      ...upstream,
      commitHash,
      lastSyncAt: new Date().toISOString(),
      localCommits,
    };
    await writeUpstreamMetadata(updated);

    return {
      success: true,
      ejectedPath: monorepoDir,
      upstreamCommits,
      localChanges,
      conflicts: [],
      commitHash,
    };
  });
}

export function reinjectCore(): Promise<CoreReinjectResult> {
  return serialise(async () => {
    const monorepoDir = coreMonorepoDir();
    if (!(await pathExists(monorepoDir))) {
      return {
        success: false,
        removedPath: "",
        error: `${CORE_PACKAGE_NAME} is not ejected`,
      };
    }

    if (!isWithinEjectedCoreDir(monorepoDir)) {
      return {
        success: false,
        removedPath: monorepoDir,
        error: `Refusing to remove core checkout outside ${coreBaseDir()}`,
      };
    }

    await fs.rm(monorepoDir, { recursive: true, force: false });
    await fs.rm(upstreamFilePath(), { force: true });

    try {
      const entries = await fs.readdir(coreBaseDir());
      if (entries.length === 0) {
        await fs.rmdir(coreBaseDir());
      }
    } catch (err) {
      logger.warn(
        `[core-eject] Best-effort cleanup of empty core dir failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    await writeTsconfigCorePaths(null);

    return {
      success: true,
      removedPath: monorepoDir,
    };
  });
}

export async function getCoreStatus(): Promise<CoreStatus> {
  const monorepoDir = coreMonorepoDir();
  const packageDir = corePackageDir();
  const distDir = coreDistDir();

  const npmVersion = await resolveInstalledCoreVersion();
  const ejected = await pathExists(monorepoDir);
  if (!ejected) {
    return {
      ejected: false,
      ejectedPath: monorepoDir,
      monorepoPath: monorepoDir,
      corePackagePath: packageDir,
      coreDistPath: distDir,
      version: npmVersion,
      npmVersion,
      commitHash: null,
      localChanges: false,
      upstream: null,
    };
  }

  if (!isWithinEjectedCoreDir(monorepoDir)) {
    logger.warn(
      `[core-eject] Ignoring core checkout outside ejected root: ${monorepoDir}`,
    );
    return {
      ejected: false,
      ejectedPath: monorepoDir,
      monorepoPath: monorepoDir,
      corePackagePath: packageDir,
      coreDistPath: distDir,
      version: npmVersion,
      npmVersion,
      commitHash: null,
      localChanges: false,
      upstream: null,
    };
  }

  const version = await readCorePackageVersion(packageDir);
  const commitHash = await gitStdout(["rev-parse", "HEAD"], monorepoDir).catch(
    (err: unknown) => {
      logger.warn(
        `[core-eject] Failed to read HEAD commit hash: ${err instanceof Error ? err.message : String(err)}`,
      );
      return null;
    },
  );
  const localChanges =
    (
      await gitStdout(["status", "--porcelain"], monorepoDir).catch(
        (err: unknown) => {
          logger.warn(
            `[core-eject] Failed to check local changes: ${err instanceof Error ? err.message : String(err)}`,
          );
          return "";
        },
      )
    ).length > 0;

  return {
    ejected: true,
    ejectedPath: monorepoDir,
    monorepoPath: monorepoDir,
    corePackagePath: packageDir,
    coreDistPath: distDir,
    version,
    npmVersion,
    commitHash,
    localChanges,
    upstream: await readUpstreamMetadata(),
  };
}
