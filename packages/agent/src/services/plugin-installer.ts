/**
 * Plugin Installer for Eliza.
 *
 * Cross-platform plugin installation and lifecycle management.
 *
 * Install targets:
 *   ~/.eliza/plugins/installed/<sanitised-name>/
 *
 * Works identically whether eliza is:
 *   - Running from source (dev)
 *   - Running as a CLI install (npm global)
 *   - Running inside a packaged desktop app bundle
 *   - Running on macOS, Linux, or Windows
 *
 * Strategy:
 *   1. npm/bun install to an isolated prefix directory
 *   2. Fallback: git clone from the plugin's GitHub repo
 *   3. Track the installation in eliza.json config
 *   4. Trigger agent restart to load the new plugin
 *
 * @module services/plugin-installer
 */

import { execFile } from "node:child_process";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { promisify } from "node:util";
import { logger, resolveStateDir } from "@elizaos/core";
import { createSerialise, requestRestart } from "@elizaos/shared";
import { loadElizaConfig, saveElizaConfig } from "../config/config.js";
import { getPluginInfo, type RegistryPluginInfo } from "./registry-client.js";

const execFileAsync = promisify(execFile);
const require = createRequire(import.meta.url);
const RELEASE_CHANNEL_ENV_KEYS = ["ELIZA_PLUGIN_RELEASE_CHANNEL"] as const;

// ---------------------------------------------------------------------------
// Input validation — prevent shell injection
// ---------------------------------------------------------------------------

/** npm package names: @scope/name or name. No shell metacharacters. */
export const VALID_PACKAGE_NAME =
  /^(@[a-zA-Z0-9][\w.-]*\/)?[a-zA-Z0-9][\w.-]*$/;

/** Version strings: semver, dist-tags, git refs. Conservative allowlist. */
const VALID_VERSION = /^[a-zA-Z0-9][\w.+-]*$/;

/** Git branch names: alphanumeric, hyphens, slashes, dots. No shell metacharacters. */
export const VALID_BRANCH = /^[a-zA-Z0-9][\w./-]*$/;

/** Git URLs: https:// only, no shell metacharacters. */
export const VALID_GIT_URL = /^https:\/\/[a-zA-Z0-9][\w./-]*\.git$/;

/** Registry package subdirectories inside a cloned repository. */
const VALID_REGISTRY_DIRECTORY = /^[a-zA-Z0-9][\w./-]*$/;

export function assertValidPackageName(name: string): void {
  if (!VALID_PACKAGE_NAME.test(name)) {
    throw new Error(`Invalid package name: "${name}"`);
  }
}

function assertValidVersion(version: string): void {
  if (!VALID_VERSION.test(version)) {
    throw new Error(`Invalid version string: "${version}"`);
  }
}

export function assertValidGitUrl(url: string): void {
  if (!VALID_GIT_URL.test(url)) {
    throw new Error(`Invalid git URL: "${url}"`);
  }
}

// ---------------------------------------------------------------------------
// Serialisation lock — prevents concurrent installs from corrupting config
// ---------------------------------------------------------------------------

const serialise = createSerialise();

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type InstallPhase =
  | "resolving"
  | "downloading"
  | "installing-deps"
  | "validating"
  | "configuring"
  | "restarting"
  | "complete"
  | "error";

export interface InstallProgress {
  phase: InstallPhase;
  pluginName: string;
  message: string;
}

export type ProgressCallback = (progress: InstallProgress) => void;

export interface InstallResult {
  success: boolean;
  pluginName: string;
  version: string;
  installPath: string;
  requiresRestart: boolean;
  error?: string;
}

export interface UninstallResult {
  success: boolean;
  pluginName: string;
  requiresRestart: boolean;
  error?: string;
}

// ---------------------------------------------------------------------------
// Cross-platform paths
// ---------------------------------------------------------------------------

function pluginsBaseDir(): string {
  return path.join(resolveStateDir(), "plugins", "installed");
}

function isWithinPluginsDir(targetPath: string): boolean {
  const base = path.resolve(pluginsBaseDir());
  const resolved = path.resolve(targetPath);
  if (resolved === base) return false;
  return resolved.startsWith(`${base}${path.sep}`);
}

export function sanitisePackageName(name: string): string {
  return name.replace(/[^a-zA-Z0-9._-]/g, "_");
}

function pluginDir(pluginName: string): string {
  return path.join(pluginsBaseDir(), sanitisePackageName(pluginName));
}

function normaliseReleaseChannel(
  value: string | undefined,
): "beta" | "next" | null {
  const normalized = value?.trim().toLowerCase();
  if (normalized === "beta" || normalized === "next") {
    return normalized;
  }
  return null;
}

function resolveCurrentElizaReleaseChannel(): "beta" | "next" | null {
  for (const envKey of RELEASE_CHANNEL_ENV_KEYS) {
    const configuredChannel = normaliseReleaseChannel(process.env[envKey]);
    if (configuredChannel) {
      return configuredChannel;
    }
  }

  try {
    const pkgPath = require.resolve("@elizaos/agent/package.json");
    const pkg = JSON.parse(fsSync.readFileSync(pkgPath, "utf8")) as {
      version?: unknown;
    };
    const version =
      typeof pkg.version === "string" ? pkg.version.toLowerCase() : "";

    if (version.includes("beta")) {
      return "beta";
    }
    if (version.includes("next")) {
      return "next";
    }
  } catch (err) {
    logger.warn(
      `[plugin-installer] Failed to detect release channel from @elizaos/agent: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  return null;
}

function resolveInstallVersion(
  canonicalName: string,
  info: RegistryPluginInfo,
  requestedVersion?: string,
): string {
  if (requestedVersion) {
    return requestedVersion;
  }

  const currentReleaseChannel = resolveCurrentElizaReleaseChannel();
  if (canonicalName.startsWith("@elizaos/") && currentReleaseChannel) {
    return currentReleaseChannel;
  }

  return info.npm.v2Version || info.npm.v1Version || "next";
}

// ---------------------------------------------------------------------------
// Package manager detection
// ---------------------------------------------------------------------------

export async function detectPackageManager(): Promise<"bun" | "npm"> {
  for (const cmd of ["bun", "npm"] as const) {
    try {
      await execFileAsync(cmd, ["--version"]);
      return cmd;
    } catch (err) {
      logger.debug(
        `[plugin-installer] ${cmd} not available: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
  return "npm";
}

// ---------------------------------------------------------------------------
// Install
// ---------------------------------------------------------------------------

/**
 * Install a plugin from the registry.
 *
 * 1. Resolves the plugin name in the registry.
 * 2. Installs via npm/bun to ~/.eliza/plugins/installed/<name>/.
 * 3. Falls back to git clone if npm is not available for this package.
 * 4. Writes an install record to eliza.json.
 * 5. Returns metadata about the installation for the caller to
 *    decide whether to trigger a restart.
 *
 * @param pluginName - The plugin name (e.g., "@elizaos/plugin-discord")
 * @param onProgress - Optional progress callback
 * @param requestedVersion - Optional specific version to install (e.g., "2.0.0-beta.0")
 */
export function installPlugin(
  pluginName: string,
  onProgress?: ProgressCallback,
  requestedVersion?: string,
): Promise<InstallResult> {
  return serialise(() =>
    _installPlugin(pluginName, onProgress, requestedVersion),
  );
}

async function _installPlugin(
  pluginName: string,
  onProgress?: ProgressCallback,
  requestedVersion?: string,
): Promise<InstallResult> {
  const emit = (phase: InstallPhase, message: string) =>
    onProgress?.({ phase, pluginName, message });

  emit("resolving", `Looking up ${pluginName} in registry...`);

  const info = await getPluginInfo(pluginName);
  if (!info) {
    return {
      success: false,
      pluginName,
      version: "",
      installPath: "",
      requiresRestart: false,
      error: `Plugin "${pluginName}" not found in the registry`,
    };
  }

  // Determine the canonical package name and version to install
  const canonicalName = info.name;
  const npmVersion = resolveInstallVersion(
    canonicalName,
    info,
    requestedVersion,
  );
  const localPath = info.localPath;
  const targetDir = pluginDir(canonicalName);

  // Ensure the directory exists (idempotent)
  await fs.mkdir(targetDir, { recursive: true });

  // Initialise a package.json in the target dir if it doesn't exist
  // (required for `bun add` / `npm install` to work with --prefix)
  const targetPkgPath = path.join(targetDir, "package.json");
  try {
    await fs.access(targetPkgPath);
  } catch {
    await fs.writeFile(
      targetPkgPath,
      JSON.stringify({ private: true, dependencies: {} }, null, 2),
    );
  }

  // Try local workspace install (when available), then npm install, then git clone.
  let installedVersion = npmVersion;
  let installSource: "npm" | "path" = "npm";
  const pm = await detectPackageManager();
  let installed = false;

  if (localPath) {
    emit("downloading", `Installing ${canonicalName} from local workspace...`);
    try {
      await runLocalPathInstall(pm, canonicalName, localPath, targetDir);
      installedVersion = await readInstalledVersion(
        targetDir,
        canonicalName,
        npmVersion,
      );
      installSource = "path";
      installed = true;
    } catch (localErr) {
      logger.warn(
        `[plugin-installer] local install failed for ${canonicalName}: ${localErr instanceof Error ? localErr.message : String(localErr)}`,
      );
    }
  }

  if (!installed) {
    emit("downloading", `Installing ${canonicalName}@${npmVersion}...`);
    try {
      await runPackageInstall(pm, canonicalName, npmVersion, targetDir);
      installedVersion = await readInstalledVersion(
        targetDir,
        canonicalName,
        npmVersion,
      );
      installSource = "npm";
      installed = true;
    } catch (npmErr) {
      logger.warn(
        `[plugin-installer] npm failed for ${canonicalName}: ${npmErr instanceof Error ? npmErr.message : String(npmErr)}`,
      );
      emit("downloading", `npm failed, cloning from ${info.gitUrl}...`);

      try {
        await gitCloneInstall(info, targetDir, onProgress);
        installedVersion = info.npm.v2Version || info.npm.v1Version || "git";
        installSource = "path"; // git-cloned plugins are local path installs
        installed = true;
      } catch (gitErr) {
        const msg = gitErr instanceof Error ? gitErr.message : String(gitErr);
        emit("error", `Installation failed: ${msg}`);
        return {
          success: false,
          pluginName: canonicalName,
          version: "",
          installPath: targetDir,
          requiresRestart: false,
          error: msg,
        };
      }
    }
  }

  if (!installed) {
    emit("error", "Installation failed");
    return {
      success: false,
      pluginName: canonicalName,
      version: "",
      installPath: targetDir,
      requiresRestart: false,
      error: `Failed to install plugin "${canonicalName}"`,
    };
  }

  emit("validating", "Verifying plugin can be loaded...");

  // Validate the plugin is importable
  const entryPoint = await resolveEntryPoint(targetDir, canonicalName);
  if (!entryPoint) {
    emit("error", "Plugin installed but entry point not found");
    return {
      success: false,
      pluginName: canonicalName,
      version: installedVersion,
      installPath: targetDir,
      requiresRestart: false,
      error: "Plugin installed on disk but entry point could not be resolved",
    };
  }

  emit("configuring", "Recording installation in config...");

  // Write install record to eliza.json
  recordInstallation(canonicalName, {
    source: installSource,
    spec: `${canonicalName}@${installedVersion}`,
    installPath: targetDir,
    version: installedVersion,
    installedAt: new Date().toISOString(),
  });

  emit(
    "complete",
    `${canonicalName}@${installedVersion} installed successfully`,
  );

  return {
    success: true,
    pluginName: canonicalName,
    version: installedVersion,
    installPath: targetDir,
    requiresRestart: true,
  };
}

/**
 * Install a plugin and automatically restart the agent to pick it up.
 */
export async function installAndRestart(
  pluginName: string,
  onProgress?: ProgressCallback,
  requestedVersion?: string,
): Promise<InstallResult> {
  const result = await installPlugin(pluginName, onProgress, requestedVersion);

  if (result.success && result.requiresRestart) {
    onProgress?.({
      phase: "restarting",
      pluginName: result.pluginName,
      message: "Restarting agent to load new plugin...",
    });

    await requestRestart(`Plugin ${result.pluginName} installed`);
  }

  return result;
}

// ---------------------------------------------------------------------------
// Uninstall
// ---------------------------------------------------------------------------

/**
 * Uninstall a user-installed plugin.
 *
 * Removes the install directory and the config record.
 * Core / built-in plugins cannot be uninstalled.
 */
export function uninstallPlugin(pluginName: string): Promise<UninstallResult> {
  return serialise(() => _uninstallPlugin(pluginName));
}

async function _uninstallPlugin(pluginName: string): Promise<UninstallResult> {
  const config = loadElizaConfig();
  const installs = config.plugins?.installs;

  if (!installs?.[pluginName]) {
    return {
      success: false,
      pluginName,
      requiresRestart: false,
      error: `Plugin "${pluginName}" is not a user-installed plugin`,
    };
  }

  const record = installs[pluginName];
  const candidatePath = record.installPath || pluginDir(pluginName);

  if (!isWithinPluginsDir(candidatePath)) {
    return {
      success: false,
      pluginName,
      requiresRestart: false,
      error: `Refusing to remove plugin outside ${pluginsBaseDir()}`,
    };
  }

  const dirToRemove = candidatePath;

  // Remove from disk
  try {
    await fs.rm(dirToRemove, { recursive: true, force: false });
  } catch (err) {
    const code =
      typeof err === "object" &&
      err !== null &&
      "code" in err &&
      typeof (err as { code?: string }).code === "string"
        ? (err as { code: string }).code
        : undefined;
    if (code !== "ENOENT") {
      return {
        success: false,
        pluginName,
        requiresRestart: false,
        error: `Failed to remove plugin directory "${dirToRemove}": ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }

  // Remove from config
  delete installs[pluginName];
  saveElizaConfig(config);

  return {
    success: true,
    pluginName,
    requiresRestart: true,
  };
}

/**
 * Uninstall a plugin and restart the agent.
 */
export async function uninstallAndRestart(
  pluginName: string,
): Promise<UninstallResult> {
  const result = await uninstallPlugin(pluginName);

  if (result.success && result.requiresRestart) {
    await requestRestart(`Plugin ${pluginName} uninstalled`);
  }

  return result;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function runPackageInstall(
  pm: "bun" | "npm",
  packageName: string,
  version: string,
  targetDir: string,
): Promise<void> {
  assertValidPackageName(packageName);
  assertValidVersion(version);
  const spec = `${packageName}@${version}`;
  await installSpecWithFallback(pm, spec, targetDir);
}

async function runLocalPathInstall(
  pm: "bun" | "npm",
  packageName: string,
  sourcePath: string,
  targetDir: string,
): Promise<void> {
  assertValidPackageName(packageName);
  const resolvedSourcePath = path.resolve(sourcePath);
  const packageJsonPath = path.join(resolvedSourcePath, "package.json");
  await fs.access(packageJsonPath);
  const spec = `file:${resolvedSourcePath}`;
  await installSpecWithFallback(pm, spec, targetDir);
}

async function installSpecWithFallback(
  pm: "bun" | "npm",
  spec: string,
  targetDir: string,
): Promise<void> {
  try {
    await runInstallSpec(pm, spec, targetDir);
  } catch (primaryErr) {
    if (pm === "npm") throw primaryErr;
    logger.warn(
      `[plugin-installer] ${pm} install failed for ${spec}; retrying with npm: ${primaryErr instanceof Error ? primaryErr.message : String(primaryErr)}`,
    );
    await runInstallSpec("npm", spec, targetDir);
  }
}

async function runInstallSpec(
  pm: "bun" | "npm",
  spec: string,
  targetDir: string,
): Promise<void> {
  // SECURITY: --ignore-scripts prevents npm postinstall/preinstall scripts
  // from executing arbitrary code on the host. Without this flag, any
  // package (including compromised registered plugins) can run shell
  // commands as the current user — reading wallet keys, installing
  // backdoors, or exfiltrating credentials.
  switch (pm) {
    case "bun":
      await execFileAsync("bun", ["add", "--ignore-scripts", spec], {
        cwd: targetDir,
      });
      break;
    default:
      await execFileAsync("npm", [
        "install",
        "--ignore-scripts",
        spec,
        "--prefix",
        targetDir,
      ]);
  }
}

async function readInstalledVersion(
  targetDir: string,
  packageName: string,
  fallbackVersion: string,
): Promise<string> {
  const installedPkgPath = path.join(
    targetDir,
    "node_modules",
    ...packageName.split("/"),
    "package.json",
  );
  try {
    const pkg = JSON.parse(await fs.readFile(installedPkgPath, "utf-8")) as {
      version?: string;
    };
    if (typeof pkg.version === "string" && pkg.version.length > 0) {
      return pkg.version;
    }
  } catch (err) {
    logger.warn(
      `[plugin-installer] Failed to read installed version for ${packageName}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  return fallbackVersion;
}

async function remoteBranchExists(
  gitUrl: string,
  branch: string,
): Promise<boolean> {
  assertValidGitUrl(gitUrl);
  if (!VALID_BRANCH.test(branch)) return false;
  try {
    const { stdout } = await execFileAsync(
      "git",
      [
        "-c",
        "protocol.file.allow=never",
        "ls-remote",
        "--heads",
        "--",
        gitUrl,
        branch,
      ],
      { env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } },
    );
    return stdout.trim().length > 0;
  } catch (err) {
    logger.debug(
      `[plugin-installer] Failed to check remote branch "${branch}": ${err instanceof Error ? err.message : String(err)}`,
    );
    return false;
  }
}

async function listRemoteBranches(gitUrl: string): Promise<string[]> {
  assertValidGitUrl(gitUrl);
  try {
    const { stdout } = await execFileAsync(
      "git",
      ["-c", "protocol.file.allow=never", "ls-remote", "--heads", "--", gitUrl],
      { env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } },
    );
    const branches: string[] = [];
    for (const rawLine of stdout.split("\n")) {
      const line = rawLine.trim();
      if (!line) continue;
      const parts = line.split(/\s+/);
      if (parts.length < 2) continue;
      const ref = parts[1];
      if (!ref.startsWith("refs/heads/")) continue;
      const branch = ref.replace(/^refs\/heads\//, "");
      if (VALID_BRANCH.test(branch)) {
        branches.push(branch);
      }
    }
    return branches;
  } catch (err) {
    logger.warn(
      `[plugin-installer] Failed to list remote branches for ${gitUrl}: ${err instanceof Error ? err.message : String(err)}`,
    );
    return [];
  }
}

export async function resolveGitBranch(
  info: RegistryPluginInfo,
): Promise<string> {
  assertValidGitUrl(info.gitUrl);
  const rawCandidates = [
    info.git.v2Branch,
    info.git.v1Branch,
    "next",
    "main",
    "master",
  ];
  const candidates = [
    ...new Set(rawCandidates.filter((c): c is string => Boolean(c?.trim()))),
  ];
  for (const branch of candidates) {
    if (!VALID_BRANCH.test(branch)) continue;
    if (await remoteBranchExists(info.gitUrl, branch)) return branch;
  }
  const remoteBranches = await listRemoteBranches(info.gitUrl);
  if (remoteBranches.length > 0) {
    const preferred = ["main", "next", "master", "1.x", "develop", "dev"];
    for (const branch of preferred) {
      if (remoteBranches.includes(branch)) {
        return branch;
      }
    }
    return remoteBranches[0];
  }
  return "main";
}

async function gitCloneInstall(
  info: RegistryPluginInfo,
  targetDir: string,
  onProgress?: ProgressCallback,
): Promise<void> {
  assertValidGitUrl(info.gitUrl);
  const branch = await resolveGitBranch(info);
  if (!VALID_BRANCH.test(branch)) {
    throw new Error(`Refusing unsafe git branch: ${branch}`);
  }

  const tempDir = path.join(path.dirname(targetDir), `temp-${Date.now()}`);

  await fs.mkdir(tempDir, { recursive: true });

  try {
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
        info.gitUrl,
        tempDir,
      ],
      { env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } },
    );

    onProgress?.({
      phase: "installing-deps",
      pluginName: info.name,
      message: "Installing dependencies...",
    });

    const pm = await detectPackageManager();
    await execFileAsync(pm, ["install", "--ignore-scripts"], { cwd: tempDir });

    const registrySourceDir = resolveRegistrySourceDir(
      tempDir,
      info.directory,
    );
    if (registrySourceDir !== tempDir) {
      try {
        await execFileAsync(pm, ["run", "build"], { cwd: registrySourceDir });
      } catch (buildErr) {
        logger.warn(
          `[plugin-installer] build step failed for ${info.name}: ${buildErr instanceof Error ? buildErr.message : String(buildErr)}`,
        );
      }
      await fs.cp(registrySourceDir, targetDir, { recursive: true });
      return;
    }

    // If there's a typescript/ subdirectory (monorepo plugin structure),
    // build it and use that as the install target.
    const tsDir = path.join(tempDir, "typescript");
    try {
      await fs.access(tsDir);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        // No typescript/ dir — copy the whole repo
        await fs.cp(tempDir, targetDir, { recursive: true });
        return;
      }
      throw err;
    }
    let buildFailed = false;
    try {
      await execFileAsync(pm, ["run", "build"], { cwd: tsDir });
    } catch (buildErr) {
      buildFailed = true;
      logger.warn(
        `[plugin-installer] build step failed for ${info.name}: ${buildErr instanceof Error ? buildErr.message : String(buildErr)}`,
      );
    }
    // If the build fails, fall back to the raw source tree instead of copying
    // a partially-built typescript/ directory.
    await fs.cp(buildFailed ? tempDir : tsDir, targetDir, { recursive: true });
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
}

function resolveRegistrySourceDir(
  tempDir: string,
  directory: string | null | undefined,
): string {
  const rawDirectory = directory?.trim();
  if (!rawDirectory) {
    return tempDir;
  }
  if (
    rawDirectory.startsWith("/") ||
    rawDirectory.includes("..") ||
    !VALID_REGISTRY_DIRECTORY.test(rawDirectory)
  ) {
    throw new Error(`Refusing unsafe registry directory: ${rawDirectory}`);
  }
  const resolved = path.resolve(tempDir, rawDirectory);
  const relative = path.relative(tempDir, resolved);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`Refusing registry directory outside clone: ${rawDirectory}`);
  }
  return resolved;
}

/**
 * Resolve the importable entry point for an installed plugin.
 *
 * For npm-installed plugins the entry is:
 *   <targetDir>/node_modules/<packageName>/
 *
 * For git-cloned plugins the entry is the targetDir itself.
 */
async function resolveEntryPoint(
  targetDir: string,
  packageName: string,
): Promise<string | null> {
  // npm layout: node_modules/@scope/package/
  const nmPath = path.join(
    targetDir,
    "node_modules",
    ...packageName.split("/"),
  );
  try {
    await fs.access(nmPath);
    return nmPath;
  } catch (err) {
    logger.debug(
      `[plugin-installer] npm layout not found for ${packageName}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  // Direct layout (git clone): check for package.json in targetDir
  const pkgPath = path.join(targetDir, "package.json");
  try {
    await fs.access(pkgPath);
    return targetDir;
  } catch (err) {
    logger.debug(
      `[plugin-installer] No package.json found in ${targetDir}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  return null;
}

function recordInstallation(
  pluginName: string,
  record: {
    source: "npm" | "path";
    spec?: string;
    installPath: string;
    version: string;
    installedAt: string;
  },
): void {
  const config = loadElizaConfig();

  // Ensure the plugins.installs path exists in the config object
  if (!config.plugins) {
    config.plugins = {};
  }
  if (!config.plugins.installs) {
    config.plugins.installs = {};
  }

  config.plugins.installs[pluginName] = record;
  saveElizaConfig(config);
}

// ---------------------------------------------------------------------------
// Introspection
// ---------------------------------------------------------------------------

/** List all user-installed plugins from the config. */
export function listInstalledPlugins(): Array<{
  name: string;
  version: string;
  installPath: string;
  installedAt: string;
}> {
  const config = loadElizaConfig();
  const installs = config.plugins?.installs ?? {};

  return Object.entries(installs).map(([name, record]) => ({
    name,
    version: record.version ?? "unknown",
    installPath: record.installPath ?? "",
    installedAt: record.installedAt ?? "",
  }));
}
