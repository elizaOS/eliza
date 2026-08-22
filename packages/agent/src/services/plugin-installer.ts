/**
 * Plugin Installer for Eliza.
 *
 * Cross-platform plugin installation and lifecycle management.
 *
 * Install targets:
 *   <stateDir>/plugins/installed/<sanitised-name>/
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
import { ElizaError, logger, resolveStateDir } from "@elizaos/core";
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

/** Exact SemVer used by approval-bound installs; dist-tags are not approval proof. */
const VALID_EXACT_VERSION =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

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
  /** Present for successful installs; optional to preserve existing result consumers. */
  provenance?: InstallProvenance;
  error?: string;
}

/**
 * Registry identity approved by a caller before installation. Both fields are
 * required so a registry alias cannot drift to another package or release.
 */
export interface PluginInstallExpectation {
  packageName: string;
  version: string;
}

/** Additive options form; the existing third-argument version string remains supported. */
export interface PluginInstallOptions {
  version?: string;
  expected?: PluginInstallExpectation;
}

/**
 * Instance-local boundaries used by Cloud synthetic worlds. Production callers
 * omit this object and retain the canonical registry plus detected package
 * manager; a custom package registry is restricted to HTTPS or literal
 * loopback HTTP and is passed as an argument, never process-global npm config.
 */
export interface PluginInstallerRuntime {
  getPluginInfo: typeof getPluginInfo;
  packageRegistryUrl?: string;
  packageManager?: "bun" | "npm";
  packageManagerTimeoutMs?: number;
}

export type InstallProvenance =
  | {
      source: "local";
      packageName: string;
      version: string;
      localPath: string;
      packageManager: "bun" | "npm";
    }
  | {
      source: "npm";
      packageName: string;
      version: string;
      spec: string;
      resolved: string | null;
      integrity: string | null;
      packageManager: "bun" | "npm";
    }
  | {
      source: "git";
      packageName: string;
      version: string;
      gitUrl: string;
      branch: string;
      commit: string;
    };

export interface PluginInstallPlan {
  packageName: string;
  version: string;
  approvalBound: boolean;
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

function normaliseInstallOptions(
  requestedVersionOrOptions?: string | PluginInstallOptions,
): PluginInstallOptions {
  return typeof requestedVersionOrOptions === "string"
    ? { version: requestedVersionOrOptions }
    : (requestedVersionOrOptions ?? {});
}

/**
 * Resolve the immutable identity an install will use. This function performs
 * every approval and registry identity check before the installer creates a
 * directory or starts a child process.
 */
export function resolvePluginInstallPlan(
  info: RegistryPluginInfo,
  requestedVersionOrOptions?: string | PluginInstallOptions,
): PluginInstallPlan {
  const options = normaliseInstallOptions(requestedVersionOrOptions);
  const registryPackage = info.npm?.package;
  const packageName =
    typeof registryPackage === "string" ? registryPackage.trim() : "";
  if (!packageName || !VALID_PACKAGE_NAME.test(packageName)) {
    throw new ElizaError(
      "Registry entry has an invalid canonical npm package",
      {
        code: "PLUGIN_INSTALL_INVALID_REGISTRY_PACKAGE",
        context: { registryName: info.name, packageName: packageName ?? null },
        severity: "fatal",
      },
    );
  }

  if (options.version !== undefined && !VALID_VERSION.test(options.version)) {
    throw new ElizaError(`Invalid version string: "${options.version}"`, {
      code: "PLUGIN_INSTALL_INVALID_VERSION",
      context: { packageName, version: options.version },
    });
  }

  const expected = options.expected;
  if (expected !== undefined) {
    if (
      typeof expected !== "object" ||
      expected === null ||
      Array.isArray(expected)
    ) {
      throw new ElizaError("Invalid plugin install expectation", {
        code: "PLUGIN_INSTALL_INVALID_EXPECTATION",
        context: { packageName },
      });
    }
    if (
      typeof expected.packageName !== "string" ||
      !VALID_PACKAGE_NAME.test(expected.packageName)
    ) {
      throw new ElizaError("Invalid expected canonical package name", {
        code: "PLUGIN_INSTALL_INVALID_EXPECTATION",
        context: { packageName },
      });
    }
    if (
      typeof expected.version !== "string" ||
      !VALID_EXACT_VERSION.test(expected.version)
    ) {
      throw new ElizaError(
        "Expected plugin version must be an exact semantic version",
        {
          code: "PLUGIN_INSTALL_INVALID_EXPECTATION",
          context: { packageName, expectedVersion: expected.version ?? null },
        },
      );
    }
    if (expected.packageName !== packageName) {
      throw new ElizaError(
        `Approved package "${expected.packageName}" does not match registry package "${packageName}"`,
        {
          code: "PLUGIN_INSTALL_APPROVAL_MISMATCH",
          context: {
            registryName: info.name,
            expectedPackageName: expected.packageName,
            resolvedPackageName: packageName,
          },
        },
      );
    }
    const registryVersion = info.npm.v2Version || info.npm.v1Version;
    if (registryVersion !== expected.version) {
      throw new ElizaError(
        `Approved version "${expected.version}" does not match registry version "${registryVersion ?? "unavailable"}"`,
        {
          code: "PLUGIN_INSTALL_APPROVAL_MISMATCH",
          context: {
            packageName,
            expectedVersion: expected.version,
            registryVersion,
          },
        },
      );
    }
    if (options.version !== undefined && options.version !== expected.version) {
      throw new ElizaError(
        `Requested version "${options.version}" does not match approved version "${expected.version}"`,
        {
          code: "PLUGIN_INSTALL_APPROVAL_MISMATCH",
          context: {
            packageName,
            expectedVersion: expected.version,
            requestedVersion: options.version,
          },
        },
      );
    }

    return {
      packageName,
      version: expected.version,
      approvalBound: true,
    };
  }

  return {
    packageName,
    version: resolveInstallVersion(packageName, info, options.version),
    approvalBound: false,
  };
}

// ---------------------------------------------------------------------------
// Package manager detection
// ---------------------------------------------------------------------------

export async function detectPackageManager(): Promise<"bun" | "npm"> {
  for (const cmd of ["bun", "npm"] as const) {
    try {
      await execFileAsync(cmd, ["--version"], {
        // npm is a `.cmd` shim on Windows; Node can't spawn it without a shell.
        shell: process.platform === "win32",
      });
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
 * 2. Installs via npm/bun to `<stateDir>/plugins/installed/<name>/`.
 * 3. Falls back to git clone if npm is not available for this package.
 * 4. Writes an install record to eliza.json.
 * 5. Returns metadata about the installation for the caller to
 *    decide whether to trigger a restart.
 *
 * @param pluginName - The plugin name (e.g., "@elizaos/plugin-discord")
 * @param onProgress - Optional progress callback
 * @param requestedVersionOrOptions - Existing version string or additive options
 *   containing an exact package/version approval binding.
 */
export function installPlugin(
  pluginName: string,
  onProgress?: ProgressCallback,
  requestedVersionOrOptions?: string | PluginInstallOptions,
): Promise<InstallResult> {
  return installPluginWithRuntime(
    pluginName,
    onProgress,
    requestedVersionOrOptions,
    { getPluginInfo },
  );
}

/** Exercise the production installer with an isolated registry/runtime. */
export function installPluginWithRuntime(
  pluginName: string,
  onProgress: ProgressCallback | undefined,
  requestedVersionOrOptions: string | PluginInstallOptions | undefined,
  runtime: PluginInstallerRuntime,
): Promise<InstallResult> {
  return serialise(() =>
    _installPlugin(pluginName, onProgress, requestedVersionOrOptions, runtime),
  );
}

async function _installPlugin(
  pluginName: string,
  onProgress?: ProgressCallback,
  requestedVersionOrOptions?: string | PluginInstallOptions,
  runtime: PluginInstallerRuntime = { getPluginInfo },
): Promise<InstallResult> {
  const emit = (phase: InstallPhase, message: string) =>
    onProgress?.({ phase, pluginName, message });

  emit("resolving", `Looking up ${pluginName} in registry...`);

  const info = await runtime.getPluginInfo(pluginName);
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

  // Resolve and approval-check the canonical npm package before any install
  // directory is created or child process can execute.
  let plan: PluginInstallPlan;
  let packageRegistryUrl: string | undefined;
  let packageManagerTimeoutMs: number | undefined;
  try {
    plan = resolvePluginInstallPlan(info, requestedVersionOrOptions);
    packageRegistryUrl = runtime.packageRegistryUrl
      ? validatePackageRegistryUrl(runtime.packageRegistryUrl)
      : undefined;
    packageManagerTimeoutMs = validatePackageManagerTimeout(
      runtime.packageManagerTimeoutMs,
    );
  } catch (err) {
    // error-policy:J1 installPlugin translates validation failures into its
    // established structured result boundary.
    const message = err instanceof Error ? err.message : String(err);
    emit("error", message);
    return {
      success: false,
      pluginName,
      version: "",
      installPath: "",
      requiresRestart: false,
      error: message,
    };
  }

  const canonicalName = plan.packageName;
  const npmVersion = plan.version;
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
  let provenance: InstallProvenance | undefined;
  const pm = runtime.packageManager ?? (await detectPackageManager());
  let installed = false;

  // Approval-bound installs intentionally use the exact npm package/version.
  // Local workspaces and moving Git refs cannot satisfy that binding.
  if (localPath && !plan.approvalBound) {
    emit("downloading", `Installing ${canonicalName} from local workspace...`);
    try {
      const packageManager = await runLocalPathInstall(
        pm,
        canonicalName,
        localPath,
        targetDir,
      );
      installedVersion = await readInstalledVersion(
        targetDir,
        canonicalName,
        npmVersion,
      );
      installSource = "path";
      provenance = {
        source: "local",
        packageName: canonicalName,
        version: installedVersion,
        localPath: path.resolve(localPath),
        packageManager,
      };
      installed = true;
    } catch (localErr) {
      logger.warn(
        `[plugin-installer] local install failed for ${canonicalName}: ${localErr instanceof Error ? localErr.message : String(localErr)}`,
      );
      await cleanupInstallTarget(targetDir);
      await fs.mkdir(targetDir, { recursive: true });
      await fs.writeFile(
        targetPkgPath,
        JSON.stringify({ private: true, dependencies: {} }, null, 2),
      );
    }
  }

  if (!installed) {
    emit("downloading", `Installing ${canonicalName}@${npmVersion}...`);
    try {
      const packageManager = await runPackageInstall(
        pm,
        canonicalName,
        npmVersion,
        targetDir,
        packageRegistryUrl,
        packageManagerTimeoutMs,
      );
      installedVersion = await readInstalledVersion(
        targetDir,
        canonicalName,
        npmVersion,
        plan.approvalBound
          ? { packageName: canonicalName, version: npmVersion }
          : undefined,
      );
      installSource = "npm";
      const npmLock = await readPackageManagerLockProvenance(
        targetDir,
        canonicalName,
        packageManager,
        installedVersion,
      );
      provenance = {
        source: "npm",
        packageName: canonicalName,
        version: installedVersion,
        spec: `${canonicalName}@${npmVersion}`,
        resolved: npmLock?.resolved ?? null,
        integrity: npmLock?.integrity ?? null,
        packageManager,
      };
      installed = true;
    } catch (npmErr) {
      logger.warn(
        `[plugin-installer] npm failed for ${canonicalName}: ${npmErr instanceof Error ? npmErr.message : String(npmErr)}`,
      );
      await cleanupInstallTarget(targetDir);
      if (
        plan.approvalBound ||
        packageRegistryUrl !== undefined ||
        isIntegrityFailure(npmErr) ||
        isPackageManagerFallbackSafetyFailure(npmErr)
      ) {
        const authority = plan.approvalBound ? "Approved" : "Authoritative";
        const msg = `${authority} npm install failed for ${canonicalName}@${npmVersion}; refusing local or Git fallback`;
        emit("error", msg);
        return {
          success: false,
          pluginName: canonicalName,
          version: "",
          installPath: targetDir,
          requiresRestart: false,
          error: msg,
        };
      }
      emit("downloading", `npm failed, cloning from ${info.gitUrl}...`);

      try {
        const git = await gitCloneInstall(info, targetDir, onProgress);
        installedVersion = await readDirectInstalledVersion(
          targetDir,
          info.npm.v2Version || info.npm.v1Version || "git",
        );
        installSource = "path"; // git-cloned plugins are local path installs
        provenance = {
          source: "git",
          packageName: canonicalName,
          version: installedVersion,
          gitUrl: info.gitUrl,
          branch: git.branch,
          commit: git.commit,
        };
        installed = true;
      } catch (gitErr) {
        await cleanupInstallTarget(targetDir);
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

  if (!installed || !provenance) {
    await cleanupInstallTarget(targetDir);
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
    await cleanupInstallTarget(targetDir);
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
    provenance,
  };
}

/**
 * Install a plugin and automatically restart the agent to pick it up.
 */
export async function installAndRestart(
  pluginName: string,
  onProgress?: ProgressCallback,
  requestedVersionOrOptions?: string | PluginInstallOptions,
): Promise<InstallResult> {
  const result = await installPlugin(
    pluginName,
    onProgress,
    requestedVersionOrOptions,
  );

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
  packageRegistryUrl?: string,
  timeoutMs?: number,
): Promise<"bun" | "npm"> {
  assertValidPackageName(packageName);
  assertValidVersion(version);
  const spec = `${packageName}@${version}`;
  return installSpecWithFallback(
    pm,
    spec,
    targetDir,
    packageRegistryUrl,
    timeoutMs,
  );
}

async function runLocalPathInstall(
  pm: "bun" | "npm",
  packageName: string,
  sourcePath: string,
  targetDir: string,
): Promise<"bun" | "npm"> {
  assertValidPackageName(packageName);
  const resolvedSourcePath = path.resolve(sourcePath);
  const packageJsonPath = path.join(resolvedSourcePath, "package.json");
  await fs.access(packageJsonPath);
  const spec = `file:${resolvedSourcePath}`;
  return installSpecWithFallback(pm, spec, targetDir);
}

async function installSpecWithFallback(
  pm: "bun" | "npm",
  spec: string,
  targetDir: string,
  packageRegistryUrl?: string,
  timeoutMs?: number,
): Promise<"bun" | "npm"> {
  try {
    await runInstallSpec(pm, spec, targetDir, packageRegistryUrl, timeoutMs);
    return pm;
  } catch (primaryErr) {
    if (pm === "npm") throw primaryErr;
    logger.warn(
      `[plugin-installer] ${pm} install failed for ${spec}; cleaning the isolated target before retrying with npm: ${primaryErr instanceof Error ? primaryErr.message : String(primaryErr)}`,
    );
    await resetInstallTargetForPackageManagerFallback(targetDir);
    await runInstallSpec("npm", spec, targetDir, packageRegistryUrl, timeoutMs);
    return "npm";
  }
}

async function resetInstallTargetForPackageManagerFallback(
  targetDir: string,
): Promise<void> {
  if (!isWithinPluginsDir(targetDir)) {
    throw new ElizaError(
      "Refusing package-manager fallback outside the plugin install directory",
      {
        code: "PLUGIN_INSTALL_FALLBACK_TARGET_UNSAFE",
        context: { targetDir },
        severity: "fatal",
      },
    );
  }
  try {
    await fs.rm(targetDir, { recursive: true, force: true });
    await fs.mkdir(targetDir, { recursive: true });
    await fs.writeFile(
      path.join(targetDir, "package.json"),
      JSON.stringify({ private: true, dependencies: {} }, null, 2),
      { encoding: "utf8", flag: "wx" },
    );
  } catch (cause) {
    // error-policy:J2 npm must never inherit partial Bun output; failure to
    // prove a clean isolated target aborts the fallback with its cause.
    throw new ElizaError(
      "Could not establish a clean target for package-manager fallback",
      {
        code: "PLUGIN_INSTALL_FALLBACK_TARGET_NOT_CLEAN",
        context: { targetDir },
        cause,
        severity: "fatal",
      },
    );
  }
}

async function runInstallSpec(
  pm: "bun" | "npm",
  spec: string,
  targetDir: string,
  packageRegistryUrl?: string,
  timeoutMs?: number,
): Promise<void> {
  const registryArgs = packageRegistryUrl
    ? ["--registry", validatePackageRegistryUrl(packageRegistryUrl)]
    : [];
  const isolatedRegistryArgs = packageRegistryUrl
    ? [
        "--prefer-online",
        "--fetch-retries",
        "0",
        "--cache",
        path.join(targetDir, ".npm-cache"),
      ]
    : [];
  // SECURITY: --ignore-scripts prevents npm postinstall/preinstall scripts
  // from executing arbitrary code on the host. Without this flag, any
  // package (including compromised registered plugins) can run shell
  // commands as the current user — reading wallet keys, installing
  // backdoors, or exfiltrating credentials.
  switch (pm) {
    case "bun":
      await execFileAsync(
        "bun",
        ["add", "--ignore-scripts", ...registryArgs, spec],
        { cwd: targetDir, timeout: timeoutMs },
      );
      break;
    default:
      await execFileAsync(
        "npm",
        [
          "install",
          "--ignore-scripts",
          "--no-audit",
          "--no-fund",
          ...isolatedRegistryArgs,
          ...registryArgs,
          spec,
          "--prefix",
          targetDir,
        ],
        // npm is a `.cmd` shim on Windows; Node can't spawn it without a shell.
        // `spec` is validated by assertValidPackageName/assertValidVersion.
        { shell: process.platform === "win32", timeout: timeoutMs },
      );
  }
}

function validatePackageManagerTimeout(
  value: number | undefined,
): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isInteger(value) || value < 1 || value > 300_000) {
    throw new ElizaError(
      "Package manager timeout must be an integer from 1 to 300000ms",
      {
        code: "PLUGIN_INSTALL_INVALID_TIMEOUT",
        context: {},
      },
    );
  }
  return value;
}

function isIntegrityFailure(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /\bEINTEGRITY\b|integrity checksum failed/i.test(message);
}

function isPackageManagerFallbackSafetyFailure(error: unknown): boolean {
  return (
    error instanceof ElizaError &&
    (error.code === "PLUGIN_INSTALL_FALLBACK_TARGET_UNSAFE" ||
      error.code === "PLUGIN_INSTALL_FALLBACK_TARGET_NOT_CLEAN")
  );
}

function validatePackageRegistryUrl(raw: string): string {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch (cause) {
    throw new ElizaError("Package registry URL must be absolute", {
      code: "PLUGIN_INSTALL_INVALID_REGISTRY_URL",
      context: {},
      cause,
    });
  }
  const loopback =
    parsed.hostname === "127.0.0.1" ||
    parsed.hostname === "::1" ||
    parsed.hostname === "[::1]";
  if (
    (parsed.protocol !== "https:" &&
      !(parsed.protocol === "http:" && loopback)) ||
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash
  ) {
    throw new ElizaError(
      "Package registry URL must use HTTPS or literal loopback HTTP and contain no credentials, query, or fragment",
      {
        code: "PLUGIN_INSTALL_INVALID_REGISTRY_URL",
        context: {},
      },
    );
  }
  return parsed.toString();
}

async function cleanupInstallTarget(targetDir: string): Promise<void> {
  if (!isWithinPluginsDir(targetDir)) {
    logger.error(
      `[plugin-installer] Refusing to clean install target outside the plugins directory: ${targetDir}`,
    );
    return;
  }

  try {
    await fs.rm(targetDir, { recursive: true, force: true });
  } catch (err) {
    // error-policy:J2 cleanup is best-effort after a failed install; the
    // original failure remains the user-facing result while preserving the
    // bounded target path guard above.
    logger.error(
      `[plugin-installer] Failed to clean partial install ${targetDir}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

async function readInstalledVersion(
  targetDir: string,
  packageName: string,
  fallbackVersion: string,
  expectedIdentity?: PluginInstallExpectation,
): Promise<string> {
  const installedPkgPath = path.join(
    targetDir,
    "node_modules",
    ...packageName.split("/"),
    "package.json",
  );
  try {
    const pkg = JSON.parse(await fs.readFile(installedPkgPath, "utf-8")) as {
      name?: unknown;
      version?: unknown;
    };
    if (expectedIdentity) {
      if (
        pkg.name !== expectedIdentity.packageName ||
        pkg.version !== expectedIdentity.version
      ) {
        throw new Error(
          `Installed package manifest identity mismatch: expected ${expectedIdentity.packageName}@${expectedIdentity.version}`,
        );
      }
      return expectedIdentity.version;
    }
    if (typeof pkg.version === "string" && pkg.version.length > 0) {
      return pkg.version;
    }
  } catch (err) {
    if (expectedIdentity) {
      throw new Error(
        `Installed package manifest is missing, unreadable, or malformed for ${expectedIdentity.packageName}@${expectedIdentity.version}`,
        { cause: err },
      );
    }
    logger.warn(
      `[plugin-installer] Failed to read installed version for ${packageName}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  return fallbackVersion;
}

export interface PackageIntegrityProvenance {
  resolved: string | null;
  integrity: string | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validSubresourceIntegrity(value: unknown): string | null {
  return typeof value === "string" &&
    /^sha(256|384|512)-[A-Za-z0-9+/]+={0,2}$/i.test(value)
    ? value
    : null;
}

/** Extract npm's resolved tarball and SRI without inventing absent metadata. */
export function extractNpmLockProvenance(
  lock: unknown,
  packageName: string,
  expectedVersion?: string,
): PackageIntegrityProvenance | null {
  if (!isRecord(lock)) return null;

  const packageKey = `node_modules/${packageName}`;
  const packages = isRecord(lock.packages) ? lock.packages : null;
  const dependencies = isRecord(lock.dependencies) ? lock.dependencies : null;
  const packageCandidates = packages
    ? Object.entries(packages)
        .filter(
          ([key, value]) =>
            isRecord(value) &&
            (key === packageKey ||
              key.replaceAll("\\", "/").endsWith(`/${packageKey}`)),
        )
        .map(([, value]) => value as Record<string, unknown>)
    : [];
  const candidate =
    (packageCandidates.length === 1 ? packageCandidates[0] : null) ??
    (dependencies && isRecord(dependencies[packageName])
      ? dependencies[packageName]
      : null);
  if (!candidate) return null;
  if (
    expectedVersion !== undefined &&
    (typeof candidate.version !== "string" ||
      candidate.version !== expectedVersion)
  ) {
    return null;
  }

  return {
    resolved:
      typeof candidate.resolved === "string" ? candidate.resolved : null,
    integrity: validSubresourceIntegrity(candidate.integrity),
  };
}

/** Extract Bun's package SRI; Bun lockfiles do not record a tarball URL. */
export function extractBunLockProvenance(
  lock: unknown,
  packageName: string,
  expectedVersion?: string,
): PackageIntegrityProvenance | null {
  if (!isRecord(lock) || !isRecord(lock.packages)) return null;
  const candidate = lock.packages[packageName];
  if (!Array.isArray(candidate)) return null;
  if (expectedVersion !== undefined) {
    const packageSpecs = candidate.filter(
      (value): value is string =>
        typeof value === "string" && value.startsWith(`${packageName}@`),
    );
    if (
      packageSpecs.length !== 1 ||
      packageSpecs[0] !== `${packageName}@${expectedVersion}`
    ) {
      return null;
    }
  }
  let integrity: string | undefined;
  for (let index = candidate.length - 1; index >= 0; index -= 1) {
    const value: unknown = candidate[index];
    const validIntegrity = validSubresourceIntegrity(value);
    if (validIntegrity) {
      integrity = validIntegrity;
      break;
    }
  }
  return integrity ? { resolved: null, integrity } : null;
}

async function readPackageManagerLockProvenance(
  targetDir: string,
  packageName: string,
  packageManager: "bun" | "npm",
  expectedVersion: string,
): Promise<PackageIntegrityProvenance | null> {
  const lockName = packageManager === "npm" ? "package-lock.json" : "bun.lock";
  try {
    const lock = JSON.parse(
      await fs.readFile(path.join(targetDir, lockName), "utf8"),
    ) as unknown;
    return packageManager === "npm"
      ? extractNpmLockProvenance(lock, packageName, expectedVersion)
      : extractBunLockProvenance(lock, packageName, expectedVersion);
  } catch (err) {
    logger.debug(
      `[plugin-installer] ${packageManager} lock provenance unavailable for ${packageName}: ${err instanceof Error ? err.message : String(err)}`,
    );
    return null;
  }
}

async function readDirectInstalledVersion(
  targetDir: string,
  fallbackVersion: string,
): Promise<string> {
  try {
    const pkg = JSON.parse(
      await fs.readFile(path.join(targetDir, "package.json"), "utf8"),
    ) as { version?: unknown };
    if (typeof pkg.version === "string" && pkg.version.length > 0) {
      return pkg.version;
    }
  } catch (err) {
    logger.debug(
      `[plugin-installer] direct install version unavailable: ${err instanceof Error ? err.message : String(err)}`,
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
): Promise<{ branch: string; commit: string }> {
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
    const { stdout: commitOutput } = await execFileAsync(
      "git",
      ["-C", tempDir, "rev-parse", "HEAD"],
      { env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } },
    );
    const commit = commitOutput.trim();
    if (!/^[0-9a-f]{40}$/i.test(commit)) {
      throw new Error(`Unable to resolve cloned Git commit for ${info.name}`);
    }

    onProgress?.({
      phase: "installing-deps",
      pluginName: info.name,
      message: "Installing dependencies...",
    });

    const pm = await detectPackageManager();
    await execFileAsync(pm, ["install", "--ignore-scripts"], {
      cwd: tempDir,
      // `pm` is npm.cmd on Windows when bun is absent; needs a shell to resolve.
      shell: process.platform === "win32",
    });

    const registrySourceDir = resolveRegistrySourceDir(tempDir, info.directory);
    if (registrySourceDir !== tempDir) {
      try {
        await execFileAsync(pm, ["run", "build"], {
          cwd: registrySourceDir,
          shell: process.platform === "win32",
        });
      } catch (buildErr) {
        logger.warn(
          `[plugin-installer] build step failed for ${info.name}: ${buildErr instanceof Error ? buildErr.message : String(buildErr)}`,
        );
      }
      await fs.cp(registrySourceDir, targetDir, { recursive: true });
      return { branch, commit };
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
        return { branch, commit };
      }
      throw err;
    }
    let buildFailed = false;
    try {
      await execFileAsync(pm, ["run", "build"], {
        cwd: tsDir,
        shell: process.platform === "win32",
      });
    } catch (buildErr) {
      buildFailed = true;
      logger.warn(
        `[plugin-installer] build step failed for ${info.name}: ${buildErr instanceof Error ? buildErr.message : String(buildErr)}`,
      );
    }
    // If the build fails, fall back to the raw source tree instead of copying
    // a partially-built typescript/ directory.
    await fs.cp(buildFailed ? tempDir : tsDir, targetDir, { recursive: true });
    return { branch, commit };
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
    throw new Error(
      `Refusing registry directory outside clone: ${rawDirectory}`,
    );
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
