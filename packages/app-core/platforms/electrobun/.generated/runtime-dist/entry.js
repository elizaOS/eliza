#!/usr/bin/env node
import { createRequire } from "node:module";
import process$1 from "node:process";
import os, { homedir } from "node:os";
import * as path$1 from "node:path";
import path, { dirname, join, resolve } from "node:path";
import fs, { accessSync, appendFileSync, constants, existsSync, mkdirSync, promises, readFileSync, readdirSync, realpathSync, renameSync, statfsSync, writeFileSync } from "node:fs";
import { RESTART_EXIT_CODE, asRecord, deriveOnboardingCredentialPersistencePlan, getDefaultStylePreset, getStylePresets, isCloudInferenceSelectedInConfig, isElizaCloudServiceSelectedInConfig, isElizaSettingsDebugEnabled, isLoopbackBindHost, isMobilePlatform, isTruthyEnvValue, migrateLegacyRuntimeConfig, normalizeCharacterLanguage, normalizeDeploymentTargetConfig, normalizeLinkedAccountFlagsConfig, normalizeLinkedAccountsConfig, normalizeOnboardingCredentialInputs, normalizeOnboardingProviderId, normalizeServiceRoutingConfig, resolveApiBindHost, resolveApiSecurityConfig, resolveApiToken, resolveDeploymentTargetInConfig, resolveLinkedAccountsInConfig, resolveServerOnlyPort, resolveServiceRoutingInConfig, resolveStylePresetByAvatarIndex, resolveStylePresetById, resolveStylePresetByName, sanitizeForSettingsDebug, sanitizeSpeechText, setApiToken, setRestartHandler, settingsDebugCloudSummary, syncResolvedApiPort } from "@elizaos/shared";
import { AGENT_EVENT_ALLOWED_STREAMS, CONFIG_WRITE_ALLOWED_TOP_KEYS, CONNECTOR_ENV_MAP, EMBEDDING_PRESETS, applyCanonicalOnboardingConfig, applyOnboardingCredentialPersistence, applyPluginRuntimeMutation, buildCharacterFromConfig, checkForUpdate, clearPersistedOnboardingConfig, cloneWithoutBlockedObjectKeys, createIntegrationTelemetrySpan, detectEmbeddingTier, discoverInstalledPlugins, discoverPluginsFromManifest, discoverPluginsFromManifest as discoverPluginsFromManifest$1, ensureApiTokenForBindHost, extractAuthToken, fetchWithTimeoutGuard, fetchWithTimeoutGuard as fetchWithTimeoutGuard$1, findPrimaryEnvKey, getPluginInfo, handleCloudBillingRoute, handleCloudCompatRoute, handleCloudRoute, initStewardWalletCache, injectApiBaseIntoHtml, isAdvancedCapabilityPluginId, isAllowedHost, isAuthorized, isPluginManagerLike, isSafeResetStateDir, loadElizaConfig, loadElizaConfig as loadElizaConfig$3, normalizeCloudSiteUrl, normalizeWsClientId, persistConversationRoomTitle, readBundledPluginPackageMetadata, requestRestart, resolveAdvancedCapabilitiesEnabled, resolveAppHeroImage, resolveChannel, resolveCloudApiBaseUrl, resolveConfigPath, resolveConfigPath as resolveConfigPath$1, resolveCorsOrigin, resolveDefaultAgentWorkspaceDir, resolveElizaVersion, resolveMcpServersRejection, resolveMcpTerminalAuthorizationRejection, resolvePluginConfigMutationRejections, resolveTerminalRunClientId, resolveTerminalRunRejection, resolveUserPath, resolveWalletExportRejection, resolveWebSocketUpgradeRejection, routeAutonomyTextToUser, saveElizaConfig, saveElizaConfig as saveElizaConfig$2, startApiServer, streamResponseBodyWithByteLimit, validateCloudBaseUrl, validateMcpServerConfig } from "@elizaos/agent";
import { AgentRuntime, AutonomyService, ChannelType, EventType, ModelType, PluginManagerService, lifeOpsPassiveConnectorsEnabled, logger, stringToUuid } from "@elizaos/core";
import chalk, { Chalk } from "chalk";
import { execFile, execFileSync, spawn, spawnSync } from "node:child_process";
import fs$1, { rename } from "node:fs/promises";
import { promisify } from "node:util";
import { fileURLToPath, pathToFileURL } from "node:url";
import { applyCloudConfigToEnv, applyN8nConfigToEnv, bootElizaRuntime, configureLocalEmbeddingPlugin, shutdownRuntime, startEliza } from "@elizaos/agent/runtime/eliza";
import { CHANNEL_PLUGIN_MAP, collectPluginNames } from "@elizaos/agent/runtime/plugin-collector";
import { getLastFailedPluginNames } from "@elizaos/agent/runtime/plugin-resolver";
import { CUSTOM_PLUGINS_DIRNAME, resolvePackageEntry, scanDropInPlugins } from "@elizaos/agent/runtime/plugin-types";
import { z } from "zod";
import https from "node:https";
import crypto, { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID, scryptSync } from "node:crypto";
import { createConnection, createServer, isIP } from "node:net";
import { executeTriggerTask, listTriggerTasks, readTriggerConfig, taskToTriggerSummary, triggersFeatureEnabled } from "@elizaos/agent/triggers/runtime";
import http from "node:http";
import { loadElizaConfig as loadElizaConfig$1, saveElizaConfig as saveElizaConfig$1 } from "@elizaos/agent/config";
import { and, desc, eq, isNull, lte, ne } from "@elizaos/plugin-sql/drizzle";
import { authAuditEventTable, authBootstrapJtiSeenTable, authIdentityTable, authOwnerBindingTable, authOwnerLoginTokenTable, authSessionTable } from "@elizaos/plugin-sql/schema";
import { extractConversationMetadataFromRoom, isAutomationConversationMetadata } from "@elizaos/agent/api/conversation-metadata";
import { toWorkbenchTask } from "@elizaos/agent/api/workbench-helpers";
import { loadElizaConfig as loadElizaConfig$2 } from "@elizaos/agent/config/config";
import { createLocalJWKSet, jwtVerify } from "jose";
import { hash, verify } from "@node-rs/argon2";
import { getAccessToken, listProviderAccounts } from "@elizaos/agent/auth/credentials";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { isVaultRef, parseVaultRef } from "@elizaos/agent/runtime/operations/vault-bridge";
import { CONNECTOR_PLUGINS, STREAMING_PLUGINS } from "@elizaos/agent/config/plugin-auto-enable";
import { EventEmitter } from "node:events";
import { Command } from "commander";
import JSON5 from "json5";

//#region \0rolldown/runtime.js
var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __esmMin = (fn, res) => () => (fn && (res = fn(fn = 0)), res);
var __commonJSMin = (cb, mod) => () => (mod || cb((mod = { exports: {} }).exports, mod), mod.exports);
var __exportAll = (all, no_symbols) => {
	let target = {};
	for (var name in all) {
		__defProp(target, name, {
			get: all[name],
			enumerable: true
		});
	}
	if (!no_symbols) {
		__defProp(target, Symbol.toStringTag, { value: "Module" });
	}
	return target;
};
var __copyProps = (to, from, except, desc) => {
	if (from && typeof from === "object" || typeof from === "function") {
		for (var keys = __getOwnPropNames(from), i = 0, n = keys.length, key; i < n; i++) {
			key = keys[i];
			if (!__hasOwnProp.call(to, key) && key !== except) {
				__defProp(to, key, {
					get: ((k) => from[k]).bind(null, key),
					enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable
				});
			}
		}
	}
	return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", {
	value: mod,
	enumerable: true
}) : target, mod));
var __toCommonJS = (mod) => __hasOwnProp.call(mod, "module.exports") ? mod["module.exports"] : __copyProps(__defProp({}, "__esModule", { value: true }), mod);
var __require = /* @__PURE__ */ createRequire(import.meta.url);

//#endregion
//#region node_modules/.bun/@elizaos+app-core@2.0.0-alpha.537+72829346cb4c43b1/node_modules/@elizaos/app-core/packages/app-core/src/utils/namespace-defaults.js
function trimEnvValue(value) {
	const trimmed = value?.trim();
	return trimmed ? trimmed : void 0;
}
/**
* App entrypoints should consistently default to the app namespace even
* when they bypass the CLI/profile bootstrap path.
*/
function ensureNamespaceDefaults(env = process$1.env) {
	if (!trimEnvValue(env.ELIZA_NAMESPACE)) env.ELIZA_NAMESPACE = "eliza";
}
var init_namespace_defaults = __esmMin((() => {
	ensureNamespaceDefaults();
}));

//#endregion
//#region node_modules/.bun/@elizaos+app-core@2.0.0-alpha.537+72829346cb4c43b1/node_modules/@elizaos/app-core/packages/app-core/src/cli/profile-utils.js
init_namespace_defaults();
const PROFILE_NAME_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/i;
function isValidProfileName(value) {
	if (!value) return false;
	return PROFILE_NAME_RE.test(value);
}

//#endregion
//#region node_modules/.bun/@elizaos+app-core@2.0.0-alpha.537+72829346cb4c43b1/node_modules/@elizaos/app-core/packages/app-core/src/cli/profile.js
function takeValue(raw, next) {
	if (raw.includes("=")) {
		const [, value] = raw.split("=", 2);
		return {
			value: (value ?? "").trim() || null,
			consumedNext: false
		};
	}
	return {
		value: (next ?? "").trim() || null,
		consumedNext: Boolean(next)
	};
}
function parseCliProfileArgs(argv) {
	if (argv.length < 2) return {
		ok: true,
		profile: null,
		argv
	};
	const out = argv.slice(0, 2);
	let profile = null;
	let sawDev = false;
	let sawCommand = false;
	const args = argv.slice(2);
	for (let i = 0; i < args.length; i += 1) {
		const arg = args[i];
		if (arg === void 0) continue;
		if (sawCommand) {
			out.push(arg);
			continue;
		}
		if (arg === "--dev") {
			if (profile && profile !== "dev") return {
				ok: false,
				error: "Cannot combine --dev with --profile"
			};
			sawDev = true;
			profile = "dev";
			continue;
		}
		if (arg === "--profile" || arg.startsWith("--profile=")) {
			if (sawDev) return {
				ok: false,
				error: "Cannot combine --dev with --profile"
			};
			const next = args[i + 1];
			const { value, consumedNext } = takeValue(arg, next);
			if (consumedNext) i += 1;
			if (!value) return {
				ok: false,
				error: "--profile requires a value"
			};
			if (!isValidProfileName(value)) return {
				ok: false,
				error: "Invalid --profile (use letters, numbers, \"_\", \"-\" only)"
			};
			profile = value;
			continue;
		}
		if (!arg.startsWith("-")) {
			sawCommand = true;
			out.push(arg);
			continue;
		}
		out.push(arg);
	}
	return {
		ok: true,
		profile,
		argv: out
	};
}
function resolveProfileStateDir(profile, namespace, homedir) {
	const suffix = profile.toLowerCase() === "default" ? "" : `-${profile}`;
	return path.join(homedir(), `.${namespace}${suffix}`);
}
function applyCliProfileEnv(params) {
	const env = params.env ?? process.env;
	const homedir = params.homedir ?? os.homedir;
	const profile = params.profile.trim();
	if (!profile) return;
	env.ELIZA_PROFILE = profile;
	const namespace = env.ELIZA_NAMESPACE?.trim() || "eliza";
	env.ELIZA_NAMESPACE = namespace;
	if (!env.ELIZA_STATE_DIR?.trim()) env.ELIZA_STATE_DIR = resolveProfileStateDir(profile, namespace, homedir);
	if (!env.ELIZA_CONFIG_PATH?.trim()) env.ELIZA_CONFIG_PATH = path.join(env.ELIZA_STATE_DIR, `${namespace}.json`);
	if (profile === "dev" && !env.ELIZA_GATEWAY_PORT?.trim()) env.ELIZA_GATEWAY_PORT = "19001";
}

//#endregion
//#region node_modules/.bun/@elizaos+app-core@2.0.0-alpha.537+72829346cb4c43b1/node_modules/@elizaos/app-core/packages/app-core/src/utils/log-prefix.js
function getLogPrefix() {
	if (cachedPrefix !== null) return cachedPrefix;
	const appCliName = process.env.APP_CLI_NAME?.trim();
	if (appCliName) {
		cachedPrefix = `[${appCliName}]`;
		return cachedPrefix;
	}
	const nameArgMatch = process.argv.find((a) => a.startsWith("--name="));
	if (nameArgMatch) {
		cachedPrefix = `[${nameArgMatch.split("=")[1]}]`;
		return cachedPrefix;
	}
	try {
		const pkgPath = path$1.join(process.cwd(), "package.json");
		if (existsSync(pkgPath)) {
			const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
			if (pkg.name) {
				let name = pkg.name;
				if (name.startsWith("@")) name = name.split("/")[1];
				if (name === "elizaos" || name.includes("eliza")) {
					cachedPrefix = "[eliza]";
					return cachedPrefix;
				}
				if (name === "elizaos" || name.includes("eliza")) {
					cachedPrefix = "[eliza]";
					return cachedPrefix;
				}
				cachedPrefix = `[${name}]`;
				return cachedPrefix;
			}
		}
	} catch (_e) {}
	if (process.cwd().includes("eliza-workspace") || process.cwd().includes("eliza")) {
		cachedPrefix = "[eliza]";
		return cachedPrefix;
	}
	cachedPrefix = "[eliza]";
	return cachedPrefix;
}
var cachedPrefix;
var init_log_prefix = __esmMin((() => {
	cachedPrefix = null;
}));

//#endregion
//#region node_modules/.bun/@elizaos+app-core@2.0.0-alpha.537+72829346cb4c43b1/node_modules/@elizaos/app-core/packages/app-core/src/runtime/error-handlers.js
/**
* Shared error-formatting utilities for global process handlers.
* Used by both the CLI (run-main.ts) and the dev-server (dev-server.ts).
* Intentionally dependency-free — only string operations.
*/
function formatUncaughtError(error) {
	if (error instanceof Error) return error.stack ?? error.message;
	return String(error);
}
function hasInsufficientCreditsSignal(input) {
	return /\b(insufficient(?:[_\s]+(?:credits?|quota))|insufficient_quota|out of credits|payment required|statuscode:\s*402)\b/i.test(input);
}
/**
* Returns `true` when the rejection looks like an AI provider credit-exhaustion
* error — these are noisy but not fatal, so callers should warn instead of crash.
*/
function shouldIgnoreUnhandledRejection(reason) {
	const formatted = formatUncaughtError(reason);
	if (!/AI_NoOutputGeneratedError|No output generated|AI_APICallError|AI_RetryError/i.test(formatted)) return false;
	if (hasInsufficientCreditsSignal(formatted)) return true;
	const seen = /* @__PURE__ */ new Set();
	let current = reason;
	while (current && typeof current === "object" && !seen.has(current)) {
		seen.add(current);
		if (current.statusCode === 402) return true;
		const responseBody = current.responseBody;
		if (typeof responseBody === "string" && hasInsufficientCreditsSignal(responseBody)) return true;
		const errors = current.errors;
		if (Array.isArray(errors)) {
			for (const inner of errors) if (shouldIgnoreUnhandledRejection(inner)) return true;
		}
		current = current.cause;
	}
	return false;
}
var init_error_handlers = __esmMin((() => {}));

//#endregion
//#region node_modules/.bun/@elizaos+app-core@2.0.0-alpha.537+72829346cb4c43b1/node_modules/@elizaos/app-core/packages/app-core/src/utils/number-parsing.js
function sanitizeNumericText(value) {
	return value == null ? "" : value.trim();
}
function normalizeFallback(fallback) {
	return Number.isFinite(fallback) ? fallback : void 0;
}
function parseClampedInteger(value, options = {}) {
	const raw = sanitizeNumericText(value);
	if (!raw) return normalizeFallback(options.fallback);
	const parsed = Number.parseInt(raw, 10);
	if (!Number.isFinite(parsed)) return normalizeFallback(options.fallback);
	const { min, max } = options;
	if (min !== void 0 && parsed < min) return min;
	if (max !== void 0 && parsed > max) return max;
	return parsed;
}
var init_number_parsing = __esmMin((() => {}));

//#endregion
//#region node_modules/.bun/@elizaos+app-core@2.0.0-alpha.537+72829346cb4c43b1/node_modules/@elizaos/app-core/packages/app-core/src/cli/argv.js
function hasHelpOrVersion(argv) {
	return argv.some((arg) => HELP_FLAGS.has(arg) || VERSION_FLAGS.has(arg));
}
function hasFlag(argv, name) {
	const args = argv.slice(2);
	for (const arg of args) {
		if (arg === FLAG_TERMINATOR) break;
		if (arg === name) return true;
	}
	return false;
}
function getVerboseFlag(argv, options) {
	if (hasFlag(argv, "--verbose")) return true;
	if (options?.includeDebug && hasFlag(argv, "--debug")) return true;
	return false;
}
function getCommandPath(argv, depth = 2) {
	const args = argv.slice(2);
	const path = [];
	for (let i = 0; i < args.length; i += 1) {
		const arg = args[i];
		if (!arg) continue;
		if (arg === "--") break;
		if (arg.startsWith("-")) continue;
		path.push(arg);
		if (path.length >= depth) break;
	}
	return path;
}
function getPrimaryCommand(argv) {
	const [primary] = getCommandPath(argv, 1);
	return primary ?? null;
}
function buildParseArgv(params) {
	const baseArgv = params.rawArgs && params.rawArgs.length > 0 ? params.rawArgs : params.fallbackArgv && params.fallbackArgv.length > 0 ? params.fallbackArgv : process.argv;
	const programName = params.programName ?? "";
	const normalizedArgv = programName && baseArgv[0] === programName ? baseArgv.slice(1) : baseArgv[0]?.endsWith("eliza") || baseArgv[0]?.endsWith("elizaai") ? baseArgv.slice(1) : baseArgv;
	const executable = (normalizedArgv[0]?.split(/[/\\]/).pop() ?? "").toLowerCase();
	if (normalizedArgv.length >= 2 && (isNodeExecutable(executable) || isBunExecutable(executable))) return normalizedArgv;
	return [
		"node",
		programName || "eliza",
		...normalizedArgv
	];
}
function isNodeExecutable(executable) {
	return executable === "node" || executable === "node.exe" || executable === "nodejs" || executable === "nodejs.exe" || nodeExecutablePattern.test(executable);
}
function isBunExecutable(executable) {
	return executable === "bun" || executable === "bun.exe";
}
var HELP_FLAGS, VERSION_FLAGS, FLAG_TERMINATOR, nodeExecutablePattern;
var init_argv = __esmMin((() => {
	HELP_FLAGS = new Set(["-h", "--help"]);
	VERSION_FLAGS = new Set([
		"-v",
		"-V",
		"--version"
	]);
	FLAG_TERMINATOR = "--";
	nodeExecutablePattern = /^node-\d+(?:\.\d+)*(?:\.exe)?$/;
}));

//#endregion
//#region node_modules/.bun/@elizaos+app-core@2.0.0-alpha.537+72829346cb4c43b1/node_modules/@elizaos/app-core/packages/app-core/src/utils/serialise.js
/**
* Creates a serialised (sequential) promise queue.
*
* Each call to the returned function chains the provided async `fn` after
* the previous one completes, ensuring only one operation runs at a time.
*
* Usage:
*   const run = createSerialise();
*   await run(async () => { ... });
*/
function createSerialise() {
	let lock = Promise.resolve();
	return (fn) => {
		const prev = lock;
		let resolve;
		lock = new Promise((r) => {
			resolve = r;
		});
		return prev.then(fn).finally(() => resolve?.());
	};
}
var init_serialise = __esmMin((() => {}));

//#endregion
//#region node_modules/.bun/@elizaos+app-core@2.0.0-alpha.537+72829346cb4c43b1/node_modules/@elizaos/app-core/packages/app-core/src/services/plugin-installer.js
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
var plugin_installer_exports = /* @__PURE__ */ __exportAll({
	VALID_BRANCH: () => VALID_BRANCH,
	VALID_GIT_URL: () => VALID_GIT_URL,
	VALID_PACKAGE_NAME: () => VALID_PACKAGE_NAME,
	assertValidGitUrl: () => assertValidGitUrl,
	assertValidPackageName: () => assertValidPackageName,
	detectPackageManager: () => detectPackageManager,
	installAndRestart: () => installAndRestart,
	installPlugin: () => installPlugin,
	listInstalledPlugins: () => listInstalledPlugins,
	resolveGitBranch: () => resolveGitBranch,
	sanitisePackageName: () => sanitisePackageName,
	uninstallAndRestart: () => uninstallAndRestart,
	uninstallPlugin: () => uninstallPlugin
});
function assertValidPackageName(name) {
	if (!VALID_PACKAGE_NAME.test(name)) throw new Error(`Invalid package name: "${name}"`);
}
function assertValidVersion(version) {
	if (!VALID_VERSION.test(version)) throw new Error(`Invalid version string: "${version}"`);
}
function assertValidGitUrl(url) {
	if (!VALID_GIT_URL.test(url)) throw new Error(`Invalid git URL: "${url}"`);
}
function pluginsBaseDir() {
	const base = process.env.ELIZA_STATE_DIR?.trim() || path.join(os.homedir(), ".eliza");
	return path.join(base, "plugins", "installed");
}
function isWithinPluginsDir(targetPath) {
	const base = path.resolve(pluginsBaseDir());
	const resolved = path.resolve(targetPath);
	if (resolved === base) return false;
	return resolved.startsWith(`${base}${path.sep}`);
}
function sanitisePackageName(name) {
	return name.replace(/[^a-zA-Z0-9._-]/g, "_");
}
function pluginDir(pluginName) {
	return path.join(pluginsBaseDir(), sanitisePackageName(pluginName));
}
function normaliseReleaseChannel(value) {
	const normalized = value?.trim().toLowerCase();
	if (normalized === "alpha" || normalized === "next") return normalized;
	return null;
}
function resolveCurrentElizaReleaseChannel() {
	for (const envKey of RELEASE_CHANNEL_ENV_KEYS) {
		const configuredChannel = normaliseReleaseChannel(process.env[envKey]);
		if (configuredChannel) return configuredChannel;
	}
	try {
		const pkgPath = require$3.resolve("@elizaos/agent/package.json");
		const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
		const version = typeof pkg.version === "string" ? pkg.version.toLowerCase() : "";
		if (version.includes("alpha")) return "alpha";
		if (version.includes("next")) return "next";
	} catch (err) {
		logger.warn(`[plugin-installer] Failed to detect release channel from @elizaos/agent: ${err instanceof Error ? err.message : String(err)}`);
	}
	return null;
}
function resolveInstallVersion(canonicalName, info, requestedVersion) {
	if (requestedVersion) return requestedVersion;
	const currentReleaseChannel = resolveCurrentElizaReleaseChannel();
	if (canonicalName.startsWith("@elizaos/") && currentReleaseChannel) return currentReleaseChannel;
	return info.npm.v2Version || info.npm.v1Version || "next";
}
async function detectPackageManager() {
	for (const cmd of ["bun", "npm"]) try {
		await execFileAsync$1(cmd, ["--version"]);
		return cmd;
	} catch (err) {
		logger.debug(`[plugin-installer] ${cmd} not available: ${err instanceof Error ? err.message : String(err)}`);
	}
	return "npm";
}
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
* @param requestedVersion - Optional specific version to install (e.g., "1.2.23-alpha.0")
*/
function installPlugin(pluginName, onProgress, requestedVersion) {
	return serialise(() => _installPlugin(pluginName, onProgress, requestedVersion));
}
async function _installPlugin(pluginName, onProgress, requestedVersion) {
	const emit = (phase, message) => onProgress?.({
		phase,
		pluginName,
		message
	});
	emit("resolving", `Looking up ${pluginName} in registry...`);
	const info = await getPluginInfo(pluginName);
	if (!info) return {
		success: false,
		pluginName,
		version: "",
		installPath: "",
		requiresRestart: false,
		error: `Plugin "${pluginName}" not found in the registry`
	};
	const canonicalName = info.name;
	const npmVersion = resolveInstallVersion(canonicalName, info, requestedVersion);
	const localPath = info.localPath;
	const targetDir = pluginDir(canonicalName);
	await fs$1.mkdir(targetDir, { recursive: true });
	const targetPkgPath = path.join(targetDir, "package.json");
	try {
		await fs$1.access(targetPkgPath);
	} catch {
		await fs$1.writeFile(targetPkgPath, JSON.stringify({
			private: true,
			dependencies: {}
		}, null, 2));
	}
	let installedVersion = npmVersion;
	let installSource = "npm";
	const pm = await detectPackageManager();
	let installed = false;
	if (localPath) {
		emit("downloading", `Installing ${canonicalName} from local workspace...`);
		try {
			await runLocalPathInstall(pm, canonicalName, localPath, targetDir);
			installedVersion = await readInstalledVersion(targetDir, canonicalName, npmVersion);
			installSource = "path";
			installed = true;
		} catch (localErr) {
			logger.warn(`[plugin-installer] local install failed for ${canonicalName}: ${localErr instanceof Error ? localErr.message : String(localErr)}`);
		}
	}
	if (!installed) {
		emit("downloading", `Installing ${canonicalName}@${npmVersion}...`);
		try {
			await runPackageInstall(pm, canonicalName, npmVersion, targetDir);
			installedVersion = await readInstalledVersion(targetDir, canonicalName, npmVersion);
			installSource = "npm";
			installed = true;
		} catch (npmErr) {
			logger.warn(`[plugin-installer] npm failed for ${canonicalName}: ${npmErr instanceof Error ? npmErr.message : String(npmErr)}`);
			emit("downloading", `npm failed, cloning from ${info.gitUrl}...`);
			try {
				await gitCloneInstall(info, targetDir, onProgress);
				installedVersion = info.npm.v2Version || info.npm.v1Version || "git";
				installSource = "path";
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
					error: msg
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
			error: `Failed to install plugin "${canonicalName}"`
		};
	}
	emit("validating", "Verifying plugin can be loaded...");
	if (!await resolveEntryPoint(targetDir, canonicalName)) {
		emit("error", "Plugin installed but entry point not found");
		return {
			success: false,
			pluginName: canonicalName,
			version: installedVersion,
			installPath: targetDir,
			requiresRestart: false,
			error: "Plugin installed on disk but entry point could not be resolved"
		};
	}
	emit("configuring", "Recording installation in config...");
	recordInstallation(canonicalName, {
		source: installSource,
		spec: `${canonicalName}@${installedVersion}`,
		installPath: targetDir,
		version: installedVersion,
		installedAt: (/* @__PURE__ */ new Date()).toISOString()
	});
	emit("complete", `${canonicalName}@${installedVersion} installed successfully`);
	return {
		success: true,
		pluginName: canonicalName,
		version: installedVersion,
		installPath: targetDir,
		requiresRestart: true
	};
}
/**
* Install a plugin and automatically restart the agent to pick it up.
*/
async function installAndRestart(pluginName, onProgress, requestedVersion) {
	const result = await installPlugin(pluginName, onProgress, requestedVersion);
	if (result.success && result.requiresRestart) {
		onProgress?.({
			phase: "restarting",
			pluginName: result.pluginName,
			message: "Restarting agent to load new plugin..."
		});
		await requestRestart(`Plugin ${result.pluginName} installed`);
	}
	return result;
}
/**
* Uninstall a user-installed plugin.
*
* Removes the install directory and the config record.
* Core / built-in plugins cannot be uninstalled.
*/
function uninstallPlugin(pluginName) {
	return serialise(() => _uninstallPlugin(pluginName));
}
async function _uninstallPlugin(pluginName) {
	const config = loadElizaConfig();
	const installs = config.plugins?.installs;
	if (!installs?.[pluginName]) return {
		success: false,
		pluginName,
		requiresRestart: false,
		error: `Plugin "${pluginName}" is not a user-installed plugin`
	};
	const candidatePath = installs[pluginName].installPath || pluginDir(pluginName);
	if (!isWithinPluginsDir(candidatePath)) return {
		success: false,
		pluginName,
		requiresRestart: false,
		error: `Refusing to remove plugin outside ${pluginsBaseDir()}`
	};
	const dirToRemove = candidatePath;
	try {
		await fs$1.rm(dirToRemove, {
			recursive: true,
			force: false
		});
	} catch (err) {
		if ((typeof err === "object" && err !== null && "code" in err && typeof err.code === "string" ? err.code : void 0) !== "ENOENT") return {
			success: false,
			pluginName,
			requiresRestart: false,
			error: `Failed to remove plugin directory "${dirToRemove}": ${err instanceof Error ? err.message : String(err)}`
		};
	}
	delete installs[pluginName];
	saveElizaConfig(config);
	return {
		success: true,
		pluginName,
		requiresRestart: true
	};
}
/**
* Uninstall a plugin and restart the agent.
*/
async function uninstallAndRestart(pluginName) {
	const result = await uninstallPlugin(pluginName);
	if (result.success && result.requiresRestart) await requestRestart(`Plugin ${pluginName} uninstalled`);
	return result;
}
async function runPackageInstall(pm, packageName, version, targetDir) {
	assertValidPackageName(packageName);
	assertValidVersion(version);
	await installSpecWithFallback(pm, `${packageName}@${version}`, targetDir);
}
async function runLocalPathInstall(pm, packageName, sourcePath, targetDir) {
	assertValidPackageName(packageName);
	const resolvedSourcePath = path.resolve(sourcePath);
	const packageJsonPath = path.join(resolvedSourcePath, "package.json");
	await fs$1.access(packageJsonPath);
	await installSpecWithFallback(pm, `file:${resolvedSourcePath}`, targetDir);
}
async function installSpecWithFallback(pm, spec, targetDir) {
	try {
		await runInstallSpec(pm, spec, targetDir);
	} catch (primaryErr) {
		if (pm === "npm") throw primaryErr;
		logger.warn(`[plugin-installer] ${pm} install failed for ${spec}; retrying with npm: ${primaryErr instanceof Error ? primaryErr.message : String(primaryErr)}`);
		await runInstallSpec("npm", spec, targetDir);
	}
}
async function runInstallSpec(pm, spec, targetDir) {
	switch (pm) {
		case "bun":
			await execFileAsync$1("bun", [
				"add",
				"--ignore-scripts",
				spec
			], { cwd: targetDir });
			break;
		default: await execFileAsync$1("npm", [
			"install",
			"--ignore-scripts",
			spec,
			"--prefix",
			targetDir
		]);
	}
}
async function readInstalledVersion(targetDir, packageName, fallbackVersion) {
	const installedPkgPath = path.join(targetDir, "node_modules", ...packageName.split("/"), "package.json");
	try {
		const pkg = JSON.parse(await fs$1.readFile(installedPkgPath, "utf-8"));
		if (typeof pkg.version === "string" && pkg.version.length > 0) return pkg.version;
	} catch (err) {
		logger.warn(`[plugin-installer] Failed to read installed version for ${packageName}: ${err instanceof Error ? err.message : String(err)}`);
	}
	return fallbackVersion;
}
async function remoteBranchExists(gitUrl, branch) {
	assertValidGitUrl(gitUrl);
	if (!VALID_BRANCH.test(branch)) return false;
	try {
		const { stdout } = await execFileAsync$1("git", [
			"-c",
			"protocol.file.allow=never",
			"ls-remote",
			"--heads",
			"--",
			gitUrl,
			branch
		], { env: {
			...process.env,
			GIT_TERMINAL_PROMPT: "0"
		} });
		return stdout.trim().length > 0;
	} catch (err) {
		logger.debug(`[plugin-installer] Failed to check remote branch "${branch}": ${err instanceof Error ? err.message : String(err)}`);
		return false;
	}
}
async function listRemoteBranches(gitUrl) {
	assertValidGitUrl(gitUrl);
	try {
		const { stdout } = await execFileAsync$1("git", [
			"-c",
			"protocol.file.allow=never",
			"ls-remote",
			"--heads",
			"--",
			gitUrl
		], { env: {
			...process.env,
			GIT_TERMINAL_PROMPT: "0"
		} });
		const branches = [];
		for (const rawLine of stdout.split("\n")) {
			const line = rawLine.trim();
			if (!line) continue;
			const parts = line.split(/\s+/);
			if (parts.length < 2) continue;
			const ref = parts[1];
			if (!ref.startsWith("refs/heads/")) continue;
			const branch = ref.replace(/^refs\/heads\//, "");
			if (VALID_BRANCH.test(branch)) branches.push(branch);
		}
		return branches;
	} catch (err) {
		logger.warn(`[plugin-installer] Failed to list remote branches for ${gitUrl}: ${err instanceof Error ? err.message : String(err)}`);
		return [];
	}
}
async function resolveGitBranch(info) {
	assertValidGitUrl(info.gitUrl);
	const rawCandidates = [
		info.git.v2Branch,
		info.git.v1Branch,
		"next",
		"main",
		"master"
	];
	const candidates = [...new Set(rawCandidates.filter((c) => Boolean(c?.trim())))];
	for (const branch of candidates) {
		if (!VALID_BRANCH.test(branch)) continue;
		if (await remoteBranchExists(info.gitUrl, branch)) return branch;
	}
	const remoteBranches = await listRemoteBranches(info.gitUrl);
	if (remoteBranches.length > 0) {
		for (const branch of [
			"main",
			"next",
			"master",
			"1.x",
			"develop",
			"dev"
		]) if (remoteBranches.includes(branch)) return branch;
		return remoteBranches[0];
	}
	return "main";
}
async function gitCloneInstall(info, targetDir, onProgress) {
	assertValidGitUrl(info.gitUrl);
	const branch = await resolveGitBranch(info);
	if (!VALID_BRANCH.test(branch)) throw new Error(`Refusing unsafe git branch: ${branch}`);
	const tempDir = path.join(path.dirname(targetDir), `temp-${Date.now()}`);
	await fs$1.mkdir(tempDir, { recursive: true });
	try {
		await execFileAsync$1("git", [
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
			tempDir
		], { env: {
			...process.env,
			GIT_TERMINAL_PROMPT: "0"
		} });
		onProgress?.({
			phase: "installing-deps",
			pluginName: info.name,
			message: "Installing dependencies..."
		});
		const pm = await detectPackageManager();
		await execFileAsync$1(pm, ["install", "--ignore-scripts"], { cwd: tempDir });
		const tsDir = path.join(tempDir, "typescript");
		try {
			await fs$1.access(tsDir);
		} catch (err) {
			if (err.code === "ENOENT") {
				await fs$1.cp(tempDir, targetDir, { recursive: true });
				return;
			}
			throw err;
		}
		let buildFailed = false;
		try {
			await execFileAsync$1(pm, ["run", "build"], { cwd: tsDir });
		} catch (buildErr) {
			buildFailed = true;
			logger.warn(`[plugin-installer] build step failed for ${info.name}: ${buildErr instanceof Error ? buildErr.message : String(buildErr)}`);
		}
		await fs$1.cp(buildFailed ? tempDir : tsDir, targetDir, { recursive: true });
	} finally {
		await fs$1.rm(tempDir, {
			recursive: true,
			force: true
		});
	}
}
/**
* Resolve the importable entry point for an installed plugin.
*
* For npm-installed plugins the entry is:
*   <targetDir>/node_modules/<packageName>/
*
* For git-cloned plugins the entry is the targetDir itself.
*/
async function resolveEntryPoint(targetDir, packageName) {
	const nmPath = path.join(targetDir, "node_modules", ...packageName.split("/"));
	try {
		await fs$1.access(nmPath);
		return nmPath;
	} catch (err) {
		logger.debug(`[plugin-installer] npm layout not found for ${packageName}: ${err instanceof Error ? err.message : String(err)}`);
	}
	const pkgPath = path.join(targetDir, "package.json");
	try {
		await fs$1.access(pkgPath);
		return targetDir;
	} catch (err) {
		logger.debug(`[plugin-installer] No package.json found in ${targetDir}: ${err instanceof Error ? err.message : String(err)}`);
	}
	return null;
}
function recordInstallation(pluginName, record) {
	const config = loadElizaConfig();
	if (!config.plugins) config.plugins = {};
	if (!config.plugins.installs) config.plugins.installs = {};
	config.plugins.installs[pluginName] = record;
	saveElizaConfig(config);
}
/** List all user-installed plugins from the config. */
function listInstalledPlugins() {
	const installs = loadElizaConfig().plugins?.installs ?? {};
	return Object.entries(installs).map(([name, record]) => ({
		name,
		version: record.version ?? "unknown",
		installPath: record.installPath ?? "",
		installedAt: record.installedAt ?? ""
	}));
}
var execFileAsync$1, require$3, RELEASE_CHANNEL_ENV_KEYS, VALID_PACKAGE_NAME, VALID_VERSION, VALID_BRANCH, VALID_GIT_URL, serialise;
var init_plugin_installer = __esmMin((() => {
	init_serialise();
	execFileAsync$1 = promisify(execFile);
	require$3 = createRequire(import.meta.url);
	RELEASE_CHANNEL_ENV_KEYS = ["ELIZA_PLUGIN_RELEASE_CHANNEL"];
	VALID_PACKAGE_NAME = /^(@[a-zA-Z0-9][\w.-]*\/)?[a-zA-Z0-9][\w.-]*$/;
	VALID_VERSION = /^[a-zA-Z0-9][\w.+-]*$/;
	VALID_BRANCH = /^[a-zA-Z0-9][\w./-]*$/;
	VALID_GIT_URL = /^https:\/\/[a-zA-Z0-9][\w./-]*\.git$/;
	serialise = createSerialise();
}));

//#endregion
//#region node_modules/.bun/@elizaos+app-core@2.0.0-alpha.537+72829346cb4c43b1/node_modules/@elizaos/app-core/packages/app-core/src/config/config.js
var config_exports = /* @__PURE__ */ __exportAll({
	isCloudActiveFromProviders: () => isCloudActiveFromProviders,
	loadElizaConfig: () => loadElizaConfig$3,
	migrateCloudEnabledToProviders: () => migrateCloudEnabledToProviders,
	saveElizaConfig: () => saveElizaConfig$2
});
function isCloudActiveFromProviders(providers) {
	if (!Array.isArray(providers) || providers.length === 0) return false;
	return providers.includes("elizacloud");
}
function migrateCloudEnabledToProviders(config) {
	if (!(config?.cloud?.enabled === true)) return config;
	const existingProviders = Array.isArray(config.providers) ? config.providers : [];
	if (existingProviders.includes("elizacloud")) return config;
	return {
		...config,
		providers: [...existingProviders, "elizacloud"]
	};
}
var init_config = __esmMin((() => {}));

//#endregion
//#region node_modules/.bun/@elizaos+app-core@2.0.0-alpha.537+72829346cb4c43b1/node_modules/@elizaos/app-core/packages/app-core/src/platform/is-native-server.js
/**
* Server-safe native-platform detection.
*
* On Capacitor-hosted mobile (iOS / Android), an in-process Node / Bun
* runtime boots the Eliza server inside the native shell, and Capacitor
* installs a global `Capacitor` object. On desktop (Electrobun) and plain
* Node / Bun servers, that global is absent.
*
* This module purposely does not import `@capacitor/core` so it is safe to
* use from server-only code (routes, sidecar lifecycle, config resolution)
* without pulling DOM/renderer concerns into a Node bundle.
*/
function isNativeServerPlatform() {
	return globalThis.Capacitor?.isNativePlatform?.() === true;
}
var init_is_native_server = __esmMin((() => {}));

//#endregion
//#region node_modules/.bun/@elizaos+app-core@2.0.0-alpha.537+72829346cb4c43b1/node_modules/@elizaos/app-core/packages/app-core/src/registry/schema.js
var configFieldType, configFieldOption, visibilityCondition, configFieldSchema, renderActionSchema, secondarySurfaceSchema, renderSchema, resourcesSchema, appViewerSchema, appSessionSchema, appSupportsSchema, appNpmSchema, appRoutePluginSchema, appLaunchSchema, commonFields, pluginSubtype, connectorSubtype, pluginEntrySchema, connectorEntrySchema, appEntrySchema, registryEntrySchema, registryRuntimeOverlaySchema;
var init_schema = __esmMin((() => {
	configFieldType = z.enum([
		"string",
		"secret",
		"boolean",
		"number",
		"select",
		"multiselect",
		"json",
		"textarea",
		"url",
		"file-path"
	]);
	configFieldOption = z.object({
		value: z.string(),
		label: z.string(),
		description: z.string().optional(),
		icon: z.string().optional(),
		disabled: z.boolean().optional()
	});
	visibilityCondition = z.object({
		key: z.string(),
		equals: z.unknown().optional(),
		in: z.array(z.unknown()).optional(),
		notEquals: z.unknown().optional()
	});
	configFieldSchema = z.object({
		type: configFieldType,
		required: z.boolean(),
		sensitive: z.boolean().optional(),
		default: z.union([
			z.string(),
			z.number(),
			z.boolean(),
			z.null()
		]).optional(),
		label: z.string().optional(),
		help: z.string().optional(),
		placeholder: z.string().optional(),
		group: z.string().optional(),
		order: z.number().int().optional(),
		width: z.enum([
			"full",
			"half",
			"third"
		]).optional(),
		advanced: z.boolean().optional(),
		hidden: z.boolean().optional(),
		readonly: z.boolean().optional(),
		icon: z.string().optional(),
		options: z.array(configFieldOption).optional(),
		pattern: z.string().optional(),
		patternError: z.string().optional(),
		min: z.number().optional(),
		max: z.number().optional(),
		step: z.number().optional(),
		unit: z.string().optional(),
		visible: visibilityCondition.optional()
	});
	renderActionSchema = z.enum([
		"enable",
		"configure",
		"launch",
		"attach",
		"detach",
		"stop",
		"uninstall",
		"install",
		"setup-guide"
	]);
	secondarySurfaceSchema = z.enum([
		"chat-apps-section",
		"companion-shell",
		"settings-integrations"
	]);
	renderSchema = z.object({
		visible: z.boolean().default(true),
		pinTo: z.array(secondarySurfaceSchema).default([]),
		style: z.enum([
			"card",
			"setup-panel",
			"hero-card"
		]).default("card"),
		icon: z.string().optional(),
		heroImage: z.string().optional(),
		group: z.string(),
		groupOrder: z.number().int().optional(),
		actions: z.array(renderActionSchema).default([])
	});
	resourcesSchema = z.object({
		homepage: z.string().url().optional(),
		repository: z.string().url().optional(),
		setupGuideUrl: z.string().url().optional()
	});
	appViewerSchema = z.object({
		url: z.string(),
		embedParams: z.record(z.string(), z.string()).optional(),
		postMessageAuth: z.boolean().optional(),
		sandbox: z.string().optional()
	});
	appSessionSchema = z.object({
		mode: z.enum([
			"viewer",
			"spectate-and-steer",
			"external"
		]),
		features: z.array(z.enum([
			"commands",
			"telemetry",
			"pause",
			"resume",
			"suggestions"
		])).optional()
	});
	appSupportsSchema = z.object({
		v0: z.boolean(),
		v1: z.boolean(),
		v2: z.boolean()
	});
	appNpmSchema = z.object({
		package: z.string(),
		v0Version: z.string().nullable(),
		v1Version: z.string().nullable(),
		v2Version: z.string().nullable()
	});
	appRoutePluginSchema = z.object({
		specifier: z.string().min(1),
		exportName: z.string().min(1).optional()
	});
	appLaunchSchema = z.object({
		type: z.enum([
			"internal-tab",
			"overlay",
			"server-launch"
		]),
		target: z.string().optional(),
		url: z.string().nullable().optional(),
		viewer: appViewerSchema.optional(),
		session: appSessionSchema.optional(),
		supports: appSupportsSchema.optional(),
		npm: appNpmSchema.optional(),
		capabilities: z.array(z.string()).default([]),
		uiExtension: z.object({ detailPanelId: z.string() }).optional(),
		curatedSlug: z.string().optional(),
		routePlugin: appRoutePluginSchema.optional()
	});
	commonFields = {
		id: z.string().min(1).regex(/^[a-z0-9][a-z0-9-]*$/, "id must be kebab-case ascii"),
		name: z.string().min(1),
		description: z.string().optional(),
		npmName: z.string().optional(),
		version: z.string().optional(),
		releaseStream: z.enum(["latest", "alpha"]).optional(),
		source: z.enum(["bundled", "store"]).default("bundled"),
		tags: z.array(z.string()).default([]),
		config: z.record(z.string(), configFieldSchema).default({}),
		render: renderSchema,
		resources: resourcesSchema.default({}),
		dependsOn: z.array(z.string()).default([])
	};
	pluginSubtype = z.enum([
		"ai-provider",
		"feature",
		"database",
		"voice",
		"knowledge",
		"blockchain",
		"media",
		"agents",
		"automation",
		"storage",
		"gaming",
		"devtools",
		"other"
	]);
	connectorSubtype = z.enum([
		"messaging",
		"social",
		"streaming",
		"email",
		"calendar",
		"other"
	]);
	pluginEntrySchema = z.object({
		...commonFields,
		kind: z.literal("plugin"),
		subtype: pluginSubtype
	});
	connectorEntrySchema = z.object({
		...commonFields,
		kind: z.literal("connector"),
		subtype: connectorSubtype,
		auth: z.object({
			kind: z.enum([
				"token",
				"oauth",
				"credentials",
				"none"
			]),
			credentialKeys: z.array(z.string()).default([])
		}).optional()
	});
	appEntrySchema = z.object({
		...commonFields,
		kind: z.literal("app"),
		subtype: z.enum([
			"game",
			"tool",
			"shell",
			"marketplace",
			"trading",
			"other"
		]),
		launch: appLaunchSchema
	});
	registryEntrySchema = z.discriminatedUnion("kind", [
		pluginEntrySchema,
		connectorEntrySchema,
		appEntrySchema
	]);
	registryRuntimeOverlaySchema = z.object({
		id: z.string(),
		enabled: z.boolean(),
		configured: z.boolean(),
		isActive: z.boolean(),
		loadError: z.string().optional(),
		validationErrors: z.array(z.object({
			field: z.string(),
			message: z.string()
		})).default([]),
		validationWarnings: z.array(z.object({
			field: z.string(),
			message: z.string()
		})).default([]),
		installedVersion: z.string().optional(),
		latestVersion: z.string().nullable().optional()
	});
}));

//#endregion
//#region node_modules/.bun/@elizaos+app-core@2.0.0-alpha.537+72829346cb4c43b1/node_modules/@elizaos/app-core/packages/app-core/src/registry/loader.js
function loadRegistryFromRawEntries(raws) {
	const seenIds = /* @__PURE__ */ new Set();
	const all = [];
	for (const { file, data } of raws) {
		const parsed = registryEntrySchema.safeParse(data);
		if (!parsed.success) throw new RegistryValidationError(file, parsed.error);
		const entry = parsed.data;
		if (seenIds.has(entry.id)) throw new RegistryValidationError(file, `duplicate id "${entry.id}" — every registry entry must have a unique id`);
		seenIds.add(entry.id);
		all.push(entry);
	}
	return indexEntries(all);
}
function indexEntries(entries) {
	const byId = /* @__PURE__ */ new Map();
	const byKind = new Map([
		["app", []],
		["plugin", []],
		["connector", []]
	]);
	const byGroup = /* @__PURE__ */ new Map();
	const byNpmName = /* @__PURE__ */ new Map();
	for (const entry of entries) {
		byId.set(entry.id, entry);
		byKind.get(entry.kind)?.push(entry);
		const groupBucket = byGroup.get(entry.render.group);
		if (groupBucket) groupBucket.push(entry);
		else byGroup.set(entry.render.group, [entry]);
		if (entry.npmName) byNpmName.set(entry.npmName, entry);
	}
	for (const [group, bucket] of byGroup) {
		bucket.sort(compareEntriesForDisplay);
		byGroup.set(group, bucket);
	}
	return {
		byId,
		byKind,
		byGroup,
		byNpmName,
		all: entries
	};
}
function compareEntriesForDisplay(a, b) {
	const aOrder = a.render.groupOrder ?? Number.MAX_SAFE_INTEGER;
	const bOrder = b.render.groupOrder ?? Number.MAX_SAFE_INTEGER;
	if (aOrder !== bOrder) return aOrder - bOrder;
	return a.name.localeCompare(b.name);
}
function getApps(registry) {
	return registry.byKind.get("app") ?? [];
}
var RegistryValidationError;
var init_loader = __esmMin((() => {
	init_schema();
	RegistryValidationError = class extends Error {
		file;
		cause;
		constructor(file, cause) {
			super(`Registry entry at ${file} failed validation: ${String(cause)}`);
			this.name = "RegistryValidationError";
			this.file = file;
			this.cause = cause;
		}
	};
}));

//#endregion
//#region node_modules/.bun/@elizaos+app-core@2.0.0-alpha.537+72829346cb4c43b1/node_modules/@elizaos/app-core/packages/app-core/src/registry/legacy-adapter.js
function pluginSubtypeToCategory(entry) {
	if (entry.kind !== "plugin") return KIND_TO_LEGACY_CATEGORY[entry.kind];
	if (entry.subtype === "ai-provider") return "ai-provider";
	if (entry.subtype === "database") return "database";
	return "feature";
}
function connectorSubtypeToCategory(entry) {
	if (entry.kind !== "connector") return "connector";
	if (entry.subtype === "streaming") return "streaming";
	return "connector";
}
function categoryFor(entry) {
	if (entry.kind === "plugin") return pluginSubtypeToCategory(entry);
	if (entry.kind === "connector") return connectorSubtypeToCategory(entry);
	return KIND_TO_LEGACY_CATEGORY[entry.kind];
}
function envKeyFor(entry) {
	if (entry.kind === "connector" && entry.auth) {
		const [first] = entry.auth.credentialKeys;
		if (first) return first;
	}
	for (const [key, field] of Object.entries(entry.config)) if (field.required && (field.type === "secret" || field.sensitive)) return key;
}
function fieldToLegacyParameter(field) {
	const param = {
		type: FIELD_TYPE_TO_LEGACY[field.type],
		description: field.help ?? field.label ?? "",
		required: field.required,
		sensitive: field.sensitive ?? field.type === "secret"
	};
	if (field.default !== void 0 && field.default !== null) param.default = String(field.default);
	if (field.options) param.options = field.options.map((option) => option.value);
	return param;
}
function entryToLegacyManifestEntry(entry) {
	const pluginParameters = {};
	for (const [key, field] of Object.entries(entry.config)) pluginParameters[key] = fieldToLegacyParameter(field);
	return {
		id: entry.id,
		dirName: entry.npmName?.replace(/^@[^/]+\//, ""),
		name: entry.name,
		npmName: entry.npmName,
		description: entry.description,
		tags: entry.tags,
		category: categoryFor(entry),
		envKey: envKeyFor(entry),
		configKeys: Object.keys(entry.config),
		version: entry.version,
		pluginParameters,
		icon: entry.render.icon ?? null,
		homepage: entry.resources.homepage,
		repository: entry.resources.repository,
		setupGuideUrl: entry.resources.setupGuideUrl
	};
}
function entriesToLegacyManifest(entries) {
	return { plugins: entries.map(entryToLegacyManifestEntry) };
}
var FIELD_TYPE_TO_LEGACY, KIND_TO_LEGACY_CATEGORY;
var init_legacy_adapter = __esmMin((() => {
	FIELD_TYPE_TO_LEGACY = {
		string: "string",
		secret: "string",
		url: "string",
		"file-path": "string",
		textarea: "string",
		json: "string",
		select: "string",
		multiselect: "string",
		boolean: "boolean",
		number: "number"
	};
	KIND_TO_LEGACY_CATEGORY = {
		app: "app",
		connector: "connector",
		plugin: "feature"
	};
}));

//#endregion
//#region node_modules/.bun/@elizaos+app-core@2.0.0-alpha.537+72829346cb4c43b1/node_modules/@elizaos/app-core/packages/app-core/src/registry/index.js
function loadRegistry() {
	if (cache) return cache;
	const raws = [];
	for (const kind of [
		"apps",
		"plugins",
		"connectors"
	]) {
		const kindDir = join(entriesDir, kind);
		let entries;
		try {
			entries = readdirSync(kindDir);
		} catch {
			console.warn(`[registry] ${kind} directory missing: ${kindDir}`);
			continue;
		}
		for (const filename of entries) {
			if (!filename.endsWith(".json")) continue;
			const file = join(kindDir, filename);
			const data = JSON.parse(readFileSync(file, "utf-8"));
			raws.push({
				file,
				data
			});
		}
	}
	cache = loadRegistryFromRawEntries(raws);
	return cache;
}
var entriesDir, cache;
var init_registry$1 = __esmMin((() => {
	init_loader();
	init_legacy_adapter();
	init_schema();
	entriesDir = join(dirname(fileURLToPath(import.meta.url)), "entries");
	cache = null;
}));

//#endregion
//#region node_modules/.bun/@elizaos+app-core@2.0.0-alpha.537+72829346cb4c43b1/node_modules/@elizaos/app-core/packages/app-core/src/config/boot-config-store.js
/** Resolve the global object (browser or Node) with symbol-key access. */
function getGlobalSlot() {
	return globalThis;
}
function getBootConfigStore() {
	const globalObject = getGlobalSlot();
	const mirroredWindowConfig = globalObject[BOOT_CONFIG_WINDOW_KEY];
	if (mirroredWindowConfig) {
		const mirroredStore = { current: mirroredWindowConfig };
		globalObject[BOOT_CONFIG_STORE_KEY] = mirroredStore;
		return mirroredStore;
	}
	const existing = globalObject[BOOT_CONFIG_STORE_KEY];
	if (existing && typeof existing === "object" && "current" in existing) return existing;
	const store = { current: DEFAULT_BOOT_CONFIG };
	globalObject[BOOT_CONFIG_STORE_KEY] = store;
	globalObject[BOOT_CONFIG_WINDOW_KEY] = store.current;
	return store;
}
/** Read the boot config from non-React code. */
function getBootConfig() {
	return getBootConfigStore().current;
}
/** Sync brand env vars → Eliza equivalents. Server-side only. */
function syncBrandEnvToEliza(aliases) {
	const env = getProcessEnv();
	if (!env) return;
	for (const [brandKey, elizaKey] of aliases) {
		const value = env[brandKey];
		if (typeof value === "string") {
			env[elizaKey] = value;
			mirroredElizaKeys.add(elizaKey);
		} else if (mirroredElizaKeys.has(elizaKey)) {
			delete env[elizaKey];
			mirroredElizaKeys.delete(elizaKey);
		}
	}
}
/** Sync Eliza env vars → brand equivalents. Server-side only. */
function syncElizaEnvToBrand(aliases) {
	const env = getProcessEnv();
	if (!env) return;
	for (const [brandKey, elizaKey] of aliases) {
		const value = env[elizaKey];
		if (typeof value === "string") {
			env[brandKey] = value;
			mirroredBrandKeys.add(brandKey);
		} else if (mirroredBrandKeys.has(brandKey)) {
			delete env[brandKey];
			mirroredBrandKeys.delete(brandKey);
		}
	}
}
var DEFAULT_BOOT_CONFIG, BOOT_CONFIG_STORE_KEY, BOOT_CONFIG_WINDOW_KEY, mirroredBrandKeys, mirroredElizaKeys, getProcessEnv;
var init_boot_config_store = __esmMin((() => {
	DEFAULT_BOOT_CONFIG = {
		branding: {},
		cloudApiBase: "https://www.elizacloud.ai"
	};
	BOOT_CONFIG_STORE_KEY = Symbol.for("elizaos.app.boot-config");
	BOOT_CONFIG_WINDOW_KEY = "__ELIZAOS_APP_BOOT_CONFIG__";
	mirroredBrandKeys = /* @__PURE__ */ new Set();
	mirroredElizaKeys = /* @__PURE__ */ new Set();
	getProcessEnv = () => {
		try {
			return globalThis.process?.env ?? null;
		} catch {
			return null;
		}
	};
}));

//#endregion
//#region node_modules/.bun/@elizaos+app-core@2.0.0-alpha.537+72829346cb4c43b1/node_modules/@elizaos/app-core/packages/app-core/src/config/boot-config.js
var init_boot_config = __esmMin((() => {
	init_boot_config_store();
}));

//#endregion
//#region node_modules/.bun/@elizaos+app-core@2.0.0-alpha.537+72829346cb4c43b1/node_modules/@elizaos/app-core/packages/app-core/src/utils/env.js
/**
* Environment variable normalization helpers.
*
* Consolidates the `normalizeSecret` / `normalizeEnvValue` pattern that was
* independently implemented in cloud-connection.ts, steward-bridge.ts, and
* server-wallet-trade.ts.
*/
/**
* Normalize an env value: trim whitespace, return `undefined` for empty/missing.
* Accepts `unknown` so callers don't need to narrow first (useful for config objects).
*/
function normalizeEnvValue(value) {
	if (typeof value !== "string") return void 0;
	return value.trim() || void 0;
}
function syncAppEnvToEliza() {
	const aliases = getBootConfig().envAliases;
	if (aliases) syncBrandEnvToEliza(aliases);
}
function syncElizaEnvAliases() {
	const aliases = getBootConfig().envAliases;
	if (aliases) syncElizaEnvToBrand(aliases);
}
var init_env = __esmMin((() => {
	init_boot_config();
}));

//#endregion
//#region node_modules/.bun/@elizaos+app-core@2.0.0-alpha.537+72829346cb4c43b1/node_modules/@elizaos/app-core/packages/app-core/src/utils/sql-compat.js
function quoteIdent(name) {
	return `"${name.replace(/"/g, "\"\"")}"`;
}
function sanitizeIdentifier(value) {
	if (typeof value !== "string") return null;
	const trimmed = value.trim();
	if (!trimmed) return null;
	const sanitized = trimmed.replace(/[^a-zA-Z0-9_]/g, "");
	if (sanitized.length === 0 || sanitized.length > 128) return null;
	return sanitized;
}
function sqlLiteral(value) {
	return `'${value.replace(/'/g, "''")}'`;
}
async function executeRawSql(runtime, sqlText) {
	const db = runtime.adapter?.db;
	if (!db?.execute) throw new Error("Database adapter not available");
	const { sql } = await import("drizzle-orm");
	const result = await db.execute(sql.raw(sqlText));
	const rows = Array.isArray(result.rows) ? result.rows : [];
	return {
		rows,
		columns: Array.isArray(result.fields) ? result.fields.map((field) => field.name) : Object.keys(rows[0] ?? {})
	};
}
async function getTableColumnNames(runtime, tableName, schemaName = "public") {
	const columns = /* @__PURE__ */ new Set();
	try {
		const { rows } = await executeRawSql(runtime, `SELECT column_name
         FROM information_schema.columns
        WHERE table_schema = ${sqlLiteral(schemaName)}
          AND table_name = ${sqlLiteral(tableName)}
        ORDER BY ordinal_position`);
		for (const row of rows) {
			const value = row.column_name;
			if (typeof value === "string" && value.length > 0) columns.add(value);
		}
	} catch {}
	if (columns.size > 0) return columns;
	try {
		const safeTableName = sanitizeIdentifier(tableName);
		if (!safeTableName) return columns;
		const { rows } = await executeRawSql(runtime, `PRAGMA table_info(${safeTableName})`);
		for (const row of rows) {
			const value = row.name;
			if (typeof value === "string" && value.length > 0) columns.add(value);
		}
	} catch {}
	return columns;
}
async function addColumnIfMissing(runtime, tableName, columnName, definition) {
	if ((await getTableColumnNames(runtime, tableName)).has(columnName)) return;
	throw new Error(`[sql-compat] Missing required column ${quoteIdent(tableName)}.${quoteIdent(columnName)} (${definition}). Run the appropriate database migrations before starting the app.`);
}
async function ensureRuntimeSqlCompatibility(runtime) {
	if (!runtime?.adapter?.db) return;
	if (repairedRuntimes.has(runtime)) return;
	const existingRepair = repairPromises.get(runtime);
	if (existingRepair) {
		await existingRepair;
		return;
	}
	const repairPromise = (async () => {
		await addColumnIfMissing(runtime, "participants", "agent_id", "uuid REFERENCES \"agents\"(\"id\") ON DELETE CASCADE");
		await addColumnIfMissing(runtime, "participants", "room_state", "text");
		for (const [columnName, definition] of [
			["step_count", "integer NOT NULL DEFAULT 0"],
			["llm_call_count", "integer NOT NULL DEFAULT 0"],
			["total_prompt_tokens", "integer NOT NULL DEFAULT 0"],
			["total_completion_tokens", "integer NOT NULL DEFAULT 0"],
			["total_reward", "real NOT NULL DEFAULT 0"],
			["scenario_id", "text"],
			["batch_id", "text"]
		]) await addColumnIfMissing(runtime, "trajectories", columnName, definition);
		repairedRuntimes.add(runtime);
	})().finally(() => {
		repairPromises.delete(runtime);
	});
	repairPromises.set(runtime, repairPromise);
	await repairPromise;
}
var repairedRuntimes, repairPromises;
var init_sql_compat = __esmMin((() => {
	repairedRuntimes = /* @__PURE__ */ new WeakSet();
	repairPromises = /* @__PURE__ */ new WeakMap();
}));

//#endregion
//#region node_modules/.bun/@elizaos+app-core@2.0.0-alpha.537+72829346cb4c43b1/node_modules/@elizaos/app-core/packages/app-core/src/runtime/app-route-plugin-registry.js
function getRegistryStore() {
	const globalObject = globalThis;
	const existing = globalObject[APP_ROUTE_PLUGIN_REGISTRY_KEY];
	if (existing) return existing;
	const created = { entries: /* @__PURE__ */ new Map() };
	globalObject[APP_ROUTE_PLUGIN_REGISTRY_KEY] = created;
	return created;
}
function listAppRoutePluginLoaders() {
	return [...getRegistryStore().entries.values()];
}
var APP_ROUTE_PLUGIN_REGISTRY_KEY;
var init_app_route_plugin_registry = __esmMin((() => {
	APP_ROUTE_PLUGIN_REGISTRY_KEY = Symbol.for("elizaos.app.route-plugin-registry");
}));

//#endregion
//#region node_modules/.bun/@elizaos+app-core@2.0.0-alpha.537+72829346cb4c43b1/node_modules/@elizaos/app-core/packages/app-core/src/utils/format.js
/**
* Format a byte count in human-readable units.
*/
function formatByteSize(bytes, options = {}) {
	const { unknownLabel = "unknown", kbPrecision = 1, mbPrecision = 1, gbPrecision = 1, tbPrecision = 1 } = options;
	if (!Number.isFinite(bytes) || bytes < 0) return unknownLabel;
	if (bytes >= 1024 ** 4) return `${(bytes / 1024 ** 4).toFixed(tbPrecision)} TB`;
	if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(gbPrecision)} GB`;
	if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(mbPrecision)} MB`;
	if (bytes >= 1024) return `${(bytes / 1024).toFixed(kbPrecision)} KB`;
	return `${bytes} B`;
}
var init_format = __esmMin((() => {}));

//#endregion
//#region node_modules/.bun/@elizaos+app-core@2.0.0-alpha.537+72829346cb4c43b1/node_modules/@elizaos/app-core/packages/app-core/src/runtime/embedding-presets.js
function detectEmbeddingPreset() {
	return EMBEDDING_PRESETS$1[detectEmbeddingTier()];
}
var EMBEDDING_PRESETS$1;
var init_embedding_presets = __esmMin((() => {
	EMBEDDING_PRESETS$1 = {
		...EMBEDDING_PRESETS,
		performance: {
			...EMBEDDING_PRESETS.performance,
			label: "Efficient (compact text embedding)",
			description: "384-dim compact text-embedding model (~133MB). Powers memory / knowledge vectors only — not chat. The framework keeps the default SQL-safe and fast instead of auto-selecting a multi-GB embedding GGUF."
		}
	};
}));

//#endregion
//#region node_modules/.bun/@elizaos+app-core@2.0.0-alpha.537+72829346cb4c43b1/node_modules/@elizaos/app-core/packages/app-core/src/runtime/embedding-manager-support.js
function getLogger() {
	if (_logger) return _logger;
	try {
		const core = __require("@elizaos/core");
		if (core?.logger) {
			_logger = core.logger;
			return _logger;
		}
	} catch {}
	_logger = console;
	return _logger;
}
function safeUnlink(filepath) {
	try {
		if (fs.existsSync(filepath)) fs.unlinkSync(filepath);
	} catch {}
}
function parseContentLength(contentLength) {
	if (!contentLength || Array.isArray(contentLength)) return null;
	const parsed = Number.parseInt(contentLength, 10);
	return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}
function isAllowedDownloadHost(hostname) {
	return hostname === "huggingface.co" || hostname.endsWith(".huggingface.co") || hostname === "hf.co" || hostname.endsWith(".hf.co");
}
function validateDownloadUrl(rawUrl) {
	let parsed;
	try {
		parsed = new URL(rawUrl);
	} catch {
		throw new Error(`Download failed: invalid URL "${rawUrl}"`);
	}
	if (parsed.protocol !== "https:") throw new Error("Download failed: only https:// URLs are allowed");
	if (!isAllowedDownloadHost(parsed.hostname.toLowerCase())) throw new Error(`Download failed: host "${parsed.hostname}" is not allowed`);
	return parsed;
}
function sanitizeModelRepo(repo) {
	const trimmed = repo.trim();
	if (!/^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/.test(trimmed)) throw new Error(`Invalid embedding model repo: ${repo}`);
	return trimmed;
}
function sanitizeModelFilename(filename) {
	const trimmed = filename.trim();
	if (!/^[A-Za-z0-9._-]+\.gguf$/i.test(trimmed)) throw new Error(`Invalid embedding model filename: ${filename}`);
	return trimmed;
}
function resolveModelPath(modelsDir, filename) {
	const resolvedDir = path.resolve(modelsDir);
	const resolvedPath = path.resolve(resolvedDir, filename);
	if (resolvedPath !== resolvedDir && !resolvedPath.startsWith(`${resolvedDir}${path.sep}`)) throw new Error("Invalid embedding model path");
	return resolvedPath;
}
function warmupReuseEmbeddingCandidates() {
	return [{
		model: EMBEDDING_PRESETS$1.performance.model,
		modelRepo: EMBEDDING_PRESETS$1.performance.modelRepo,
		dimensions: EMBEDDING_PRESETS$1.performance.dimensions,
		contextSize: EMBEDDING_PRESETS$1.performance.contextSize,
		gpuLayers: String(EMBEDDING_PRESETS$1.performance.gpuLayers)
	}];
}
/** True if a sanitized GGUF with this basename exists under `modelsDir`. */
function embeddingGgufFilePresent(modelsDir, filename) {
	try {
		const safe = sanitizeModelFilename(filename);
		return fs.existsSync(resolveModelPath(modelsDir, safe));
	} catch {
		return false;
	}
}
/**
* When the configured embedding file is missing, reuse only the compact,
* SQL-safe embedding GGUF already on disk. The framework intentionally avoids
* reviving legacy larger defaults from MODELS_DIR because they would reintroduce
* dimension mismatches and unnecessary RAM/download cost.
*/
function findExistingEmbeddingModelForWarmupReuse(modelsDir) {
	const dir = path.resolve(modelsDir);
	if (!fs.existsSync(dir)) return null;
	for (const c of warmupReuseEmbeddingCandidates()) if (embeddingGgufFilePresent(dir, c.model)) return c;
	return null;
}
function isEmbeddingWarmupReuseDisabled() {
	const raw = process.env.ELIZA_EMBEDDING_WARMUP_NO_REUSE?.trim().toLowerCase() ?? "";
	return raw === "1" || raw === "true" || raw === "yes";
}
/** Alias for the shared byte-size formatter with precision tuned for download progress. */
function formatBytes(bytes) {
	return formatByteSize(bytes, {
		kbPrecision: 0,
		mbPrecision: 1,
		gbPrecision: 2
	});
}
function downloadFile(url, dest, maxRedirects = 5, onProgress) {
	return new Promise((resolve, reject) => {
		let settled = false;
		let redirectCount = 0;
		const request = (reqUrl) => {
			let validatedUrl;
			try {
				validatedUrl = validateDownloadUrl(reqUrl);
			} catch (error) {
				reject(error instanceof Error ? error : /* @__PURE__ */ new Error("Invalid download URL"));
				return;
			}
			const file = fs.createWriteStream(dest);
			let bytesReceived = 0;
			let expectedBytes = null;
			let lastProgressPercent = -1;
			const settleError = (err) => {
				if (settled) return;
				settled = true;
				file.close();
				safeUnlink(dest);
				reject(err);
			};
			const settleSuccess = () => {
				if (settled) return;
				if (expectedBytes != null && bytesReceived !== expectedBytes) {
					settleError(/* @__PURE__ */ new Error(`${getLogPrefix()} Download failed: bytes received (${bytesReceived}) does not match Content-Length (${expectedBytes})`));
					return;
				}
				settled = true;
				file.close();
				resolve();
			};
			https.get(validatedUrl.toString(), { headers: { "User-Agent": "eliza" } }, (res) => {
				expectedBytes = parseContentLength(res.headers["content-length"]);
				if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
					res.resume();
					file.close();
					safeUnlink(dest);
					redirectCount += 1;
					if (redirectCount > maxRedirects) {
						settleError(/* @__PURE__ */ new Error(`Download failed: too many redirects (>${maxRedirects})`));
						return;
					}
					let next;
					try {
						next = new URL(res.headers.location, validatedUrl.toString()).toString();
					} catch {
						settleError(/* @__PURE__ */ new Error(`Download failed: malformed redirect URL "${res.headers.location}"`));
						return;
					}
					request(next);
					return;
				}
				if (res.statusCode !== 200) {
					settleError(/* @__PURE__ */ new Error(`Download failed: HTTP ${res.statusCode} for ${validatedUrl.toString()}`));
					return;
				}
				res.on("data", (chunk) => {
					bytesReceived += chunk.length;
					if (onProgress) {
						const pct = expectedBytes ? Math.floor(bytesReceived / expectedBytes * 50) : -1;
						if (pct !== lastProgressPercent) {
							lastProgressPercent = pct;
							onProgress(bytesReceived, expectedBytes);
						}
					}
				});
				res.pipe(file);
				file.on("finish", settleSuccess);
				file.on("error", settleError);
			}).on("error", settleError);
		};
		request(url);
	});
}
async function ensureModel(modelsDir, repo, filename, force, onProgress) {
	const safeRepo = sanitizeModelRepo(repo);
	const safeFilename = sanitizeModelFilename(filename);
	const modelPath = resolveModelPath(modelsDir, safeFilename);
	if (force) safeUnlink(modelPath);
	onProgress?.("checking", safeFilename);
	if (fs.existsSync(modelPath)) {
		onProgress?.("ready", "model already downloaded");
		return modelPath;
	}
	const log = getLogger();
	fs.mkdirSync(path.resolve(modelsDir), { recursive: true });
	const url = `https://huggingface.co/${safeRepo}/resolve/main/${safeFilename}`;
	log.info(`${getLogPrefix()} Downloading TEXT_EMBEDDING / memory vector model (not chat LLM): ${safeFilename} from ${safeRepo}`);
	onProgress?.("downloading", `${safeFilename} — TEXT_EMBEDDING for memory, not chat · ${safeRepo}`);
	await downloadFile(url, modelPath, 5, onProgress ? (downloaded, total) => {
		const totalStr = total ? formatBytes(total) : "unknown size";
		onProgress("downloading", `${safeFilename} ${total ? Math.round(downloaded / total * 100) : 0}% of ${totalStr}`);
	} : void 0);
	log.info(`${getLogPrefix()} Embedding model downloaded: ${modelPath}`);
	return modelPath;
}
var DEFAULT_IDLE_TIMEOUT_MS, DEFAULT_MODELS_DIR, EMBEDDING_META_DIR, EMBEDDING_META_PATH, _logger;
var init_embedding_manager_support = __esmMin((() => {
	init_format();
	init_log_prefix();
	init_embedding_presets();
	DEFAULT_IDLE_TIMEOUT_MS = 1800 * 1e3;
	DEFAULT_MODELS_DIR = path.join(os.homedir(), ".eliza", "models");
	EMBEDDING_META_DIR = process.env.ELIZA_EMBEDDING_META_DIR ?? path.join(os.homedir(), ".eliza", "state");
	EMBEDDING_META_PATH = process.env.ELIZA_EMBEDDING_META_PATH ?? path.join(EMBEDDING_META_DIR, "embedding-meta.json");
	;
}));

//#endregion
//#region node_modules/.bun/@elizaos+app-core@2.0.0-alpha.537+72829346cb4c43b1/node_modules/@elizaos/app-core/packages/app-core/src/runtime/embedding-warmup-policy.js
/**
* Whether to prefetch the local GGUF embedding model before runtime boot.
*
* Chat/inference provider (what you pick in onboarding) is separate from
* **embeddings** (vector memory / RAG). By default The framework keeps
* `@elizaos/plugin-local-embedding` loaded because API-based model plugins do
* not implement TEXT_EMBEDDING — so a local model was historically always
* warmed up. When Eliza Cloud is connected with **cloud embeddings** enabled,
* the cloud plugin handles embeddings instead; skipping warmup avoids a large
* download unrelated to “local inference” for chat.
*/
function isTruthyEnv(...names) {
	for (const name of names) {
		const v = process.env[name]?.trim().toLowerCase();
		if (v === "1" || v === "true" || v === "yes") return true;
	}
	return false;
}
function shouldWarmupLocalEmbeddingModel() {
	if (isTruthyEnv("ELIZA_DISABLE_LOCAL_EMBEDDINGS")) return false;
	if (isTruthyEnv("ELIZA_CLOUD_EMBEDDINGS_DISABLED")) return true;
	if (isTruthyEnv("ELIZAOS_CLOUD_USE_EMBEDDINGS")) return false;
	return true;
}
var init_embedding_warmup_policy = __esmMin((() => {}));

//#endregion
//#region node_modules/.bun/@elizaos+app-core@2.0.0-alpha.537+72829346cb4c43b1/node_modules/@elizaos/app-core/packages/app-core/src/services/local-inference/catalog.js
function findCatalogModel(id) {
	return MODEL_CATALOG.find((m) => m.id === id);
}
/**
* Construct the HuggingFace resolve URL for a given catalog entry.
*
* Respects `ELIZA_HF_BASE_URL` when set so self-hosted HF mirrors and the
* downloader e2e test suite can redirect all downloads without touching
* the catalog.
*/
function buildHuggingFaceResolveUrl(model) {
	const base = process.env.ELIZA_HF_BASE_URL?.trim().replace(/\/+$/, "") || "https://huggingface.co";
	const encodedPath = model.ggufFile.split("/").map((segment) => encodeURIComponent(segment)).join("/");
	return `${base}/${model.hfRepo}/resolve/main/${encodedPath}?download=true`;
}
var MODEL_CATALOG;
var init_catalog = __esmMin((() => {
	MODEL_CATALOG = [
		{
			id: "smollm2-360m",
			displayName: "SmolLM2 360M Instruct",
			hfRepo: "bartowski/SmolLM2-360M-Instruct-GGUF",
			ggufFile: "SmolLM2-360M-Instruct-Q4_K_M.gguf",
			params: "360M",
			quant: "Q4_K_M",
			sizeGb: .27,
			minRamGb: 1,
			category: "tiny",
			bucket: "small",
			blurb: "Mobile-friendly default. ~270MB on disk, runs on phones and 1GB-RAM hosts."
		},
		{
			id: "smollm2-1.7b",
			displayName: "SmolLM2 1.7B Instruct",
			hfRepo: "bartowski/SmolLM2-1.7B-Instruct-GGUF",
			ggufFile: "SmolLM2-1.7B-Instruct-Q4_K_M.gguf",
			params: "1.7B",
			quant: "Q4_K_M",
			sizeGb: 1.1,
			minRamGb: 3,
			category: "tiny",
			bucket: "small",
			blurb: "Smallest genuinely useful chat model. Perfect for CI and smoke tests."
		},
		{
			id: "llama-3.2-1b",
			displayName: "Llama 3.2 1B Instruct",
			hfRepo: "bartowski/Llama-3.2-1B-Instruct-GGUF",
			ggufFile: "Llama-3.2-1B-Instruct-Q4_K_M.gguf",
			params: "1B",
			quant: "Q4_K_M",
			sizeGb: .8,
			minRamGb: 2,
			category: "tiny",
			bucket: "small",
			blurb: "Ultra-light Llama for edge devices and integration tests."
		},
		{
			id: "llama-3.2-3b",
			displayName: "Llama 3.2 3B Instruct",
			hfRepo: "bartowski/Llama-3.2-3B-Instruct-GGUF",
			ggufFile: "Llama-3.2-3B-Instruct-Q4_K_M.gguf",
			params: "3B",
			quant: "Q4_K_M",
			sizeGb: 2,
			minRamGb: 4,
			category: "chat",
			bucket: "small",
			blurb: "Fast general chat for 8GB laptops; coherent summaries and Q&A."
		},
		{
			id: "qwen2.5-3b",
			displayName: "Qwen2.5 3B Instruct",
			hfRepo: "bartowski/Qwen2.5-3B-Instruct-GGUF",
			ggufFile: "Qwen2.5-3B-Instruct-Q4_K_M.gguf",
			params: "3B",
			quant: "Q4_K_M",
			sizeGb: 2,
			minRamGb: 4,
			category: "chat",
			bucket: "small",
			blurb: "Punchy small model with strong multilingual and instruction following."
		},
		{
			id: "llama-3.1-8b",
			displayName: "Llama 3.1 8B Instruct",
			hfRepo: "bartowski/Meta-Llama-3.1-8B-Instruct-GGUF",
			ggufFile: "Meta-Llama-3.1-8B-Instruct-Q4_K_M.gguf",
			params: "8B",
			quant: "Q4_K_M",
			sizeGb: 4.9,
			minRamGb: 10,
			category: "chat",
			bucket: "mid",
			blurb: "Battle-tested general chat; the default 8GB-VRAM daily driver."
		},
		{
			id: "qwen2.5-7b",
			displayName: "Qwen2.5 7B Instruct",
			hfRepo: "bartowski/Qwen2.5-7B-Instruct-GGUF",
			ggufFile: "Qwen2.5-7B-Instruct-Q4_K_M.gguf",
			params: "7B",
			quant: "Q4_K_M",
			sizeGb: 4.7,
			minRamGb: 10,
			category: "chat",
			bucket: "mid",
			blurb: "Strong reasoning and multilingual chat; rivals Llama-3.1-8B."
		},
		{
			id: "gemma-2-9b",
			displayName: "Gemma 2 9B Instruct",
			hfRepo: "bartowski/gemma-2-9b-it-GGUF",
			ggufFile: "gemma-2-9b-it-Q4_K_M.gguf",
			params: "9B",
			quant: "Q4_K_M",
			sizeGb: 5.8,
			minRamGb: 12,
			category: "chat",
			bucket: "mid",
			blurb: "Google Gemma. Excellent writing quality and safety tuning."
		},
		{
			id: "qwen2.5-coder-7b",
			displayName: "Qwen2.5 Coder 7B Instruct",
			hfRepo: "bartowski/Qwen2.5-Coder-7B-Instruct-GGUF",
			ggufFile: "Qwen2.5-Coder-7B-Instruct-Q4_K_M.gguf",
			params: "7B",
			quant: "Q4_K_M",
			sizeGb: 4.7,
			minRamGb: 10,
			category: "code",
			bucket: "mid",
			blurb: "Top small coder. Fill-in-the-middle, repo-level context, 128k window."
		},
		{
			id: "hermes-3-llama-8b",
			displayName: "Hermes 3 Llama 3.1 8B",
			hfRepo: "bartowski/Hermes-3-Llama-3.1-8B-GGUF",
			ggufFile: "Hermes-3-Llama-3.1-8B-Q4_K_M.gguf",
			params: "8B",
			quant: "Q4_K_M",
			sizeGb: 4.9,
			minRamGb: 10,
			category: "tools",
			bucket: "mid",
			blurb: "Nous Hermes 3. Function calling, JSON mode, agentic tool use."
		},
		{
			id: "bonsai-8b-1bit",
			displayName: "Bonsai 8B 1-bit (TurboQuant)",
			hfRepo: "apothic/bonsai-8B-1bit-turboquant",
			ggufFile: "models/gguf/8B/Bonsai-8B.gguf",
			params: "8B",
			quant: "1-bit TurboQuant",
			sizeGb: 1.2,
			minRamGb: 8,
			category: "chat",
			bucket: "mid",
			blurb: "1-bit weights with TurboQuant KV-cache compression (~4-4.6x KV memory cut) on phone CPU via the apothic/llama.cpp-1bit-turboquant fork. Auto-enabled when the AOSP runtime loads any GGUF whose filename contains \"bonsai\" (k=tbq4_0, v=tbq3_0); override with ELIZA_LLAMA_CACHE_TYPE_K/_V. Apple Silicon (Metal) and Vulkan GPU still run at full fp16 KV cache."
		},
		{
			id: "deepseek-coder-v2-lite",
			displayName: "DeepSeek Coder V2 Lite 16B",
			hfRepo: "bartowski/DeepSeek-Coder-V2-Lite-Instruct-GGUF",
			ggufFile: "DeepSeek-Coder-V2-Lite-Instruct-Q4_K_M.gguf",
			params: "16B",
			quant: "Q4_K_M",
			sizeGb: 10.4,
			minRamGb: 20,
			category: "code",
			bucket: "large",
			blurb: "MoE coder. Near-32B coding quality with ~2.4B active params."
		},
		{
			id: "qwen2.5-coder-14b",
			displayName: "Qwen2.5 Coder 14B Instruct",
			hfRepo: "bartowski/Qwen2.5-Coder-14B-Instruct-GGUF",
			ggufFile: "Qwen2.5-Coder-14B-Instruct-Q4_K_M.gguf",
			params: "14B",
			quant: "Q4_K_M",
			sizeGb: 9,
			minRamGb: 18,
			category: "code",
			bucket: "large",
			blurb: "Sweet-spot coder for 16GB VRAM. Fluent in most languages."
		},
		{
			id: "mistral-small-3-24b",
			displayName: "Mistral Small 3 24B Instruct",
			hfRepo: "bartowski/Mistral-Small-24B-Instruct-2501-GGUF",
			ggufFile: "Mistral-Small-24B-Instruct-2501-Q4_K_M.gguf",
			params: "24B",
			quant: "Q4_K_M",
			sizeGb: 14.3,
			minRamGb: 28,
			category: "chat",
			bucket: "large",
			blurb: "Mistral's 2025 flagship small. Strong reasoning, creative writing."
		},
		{
			id: "gemma-2-27b",
			displayName: "Gemma 2 27B Instruct",
			hfRepo: "bartowski/gemma-2-27b-it-GGUF",
			ggufFile: "gemma-2-27b-it-Q4_K_M.gguf",
			params: "27B",
			quant: "Q4_K_M",
			sizeGb: 16.6,
			minRamGb: 32,
			category: "chat",
			bucket: "large",
			blurb: "Largest Gemma 2. Excellent for long-form writing and reasoning."
		},
		{
			id: "qwq-32b",
			displayName: "QwQ 32B Reasoning",
			hfRepo: "bartowski/QwQ-32B-GGUF",
			ggufFile: "QwQ-32B-Q4_K_M.gguf",
			params: "32B",
			quant: "Q4_K_M",
			sizeGb: 19.9,
			minRamGb: 38,
			category: "reasoning",
			bucket: "xl",
			blurb: "Qwen reasoning model. Chain-of-thought, math, code. o1-class open model."
		},
		{
			id: "deepseek-r1-distill-qwen-32b",
			displayName: "DeepSeek R1 Distill Qwen 32B",
			hfRepo: "bartowski/DeepSeek-R1-Distill-Qwen-32B-GGUF",
			ggufFile: "DeepSeek-R1-Distill-Qwen-32B-Q4_K_M.gguf",
			params: "32B",
			quant: "Q4_K_M",
			sizeGb: 19.9,
			minRamGb: 38,
			category: "reasoning",
			bucket: "xl",
			blurb: "R1 reasoning distilled into Qwen-32B. 128k context, strong math/code."
		}
	];
}));

//#endregion
//#region node_modules/.bun/@elizaos+app-core@2.0.0-alpha.537+72829346cb4c43b1/node_modules/@elizaos/app-core/packages/app-core/src/services/local-inference/paths.js
/**
* Path resolution for the local-inference service.
*
* All Eliza-owned files live under `$STATE_DIR/local-inference/` to match
* the convention established by `plugin-installer.ts` and the rest of
* app-core. We never write to paths outside of this root.
*
* The state dir is resolved in `ELIZA_STATE_DIR` → `ELIZA_STATE_DIR` →
* `~/.eliza` order. The `.eliza` fallback is preserved for desktop
* backward-compat with existing installs; on AOSP `ELIZA_STATE_DIR` is
* set by `ElizaAgentService.java` to `/data/data/<pkg>/files/.eliza`,
* so models land at `<that>/local-inference/models/` and not under a
* stray homedir-derived path.
*/
function localInferenceRoot() {
	const base = process.env.ELIZA_STATE_DIR?.trim() || path.join(os.homedir(), ".eliza");
	return path.join(base, "local-inference");
}
/** Directory for models Eliza downloaded itself. Safe to delete. */
function elizaModelsDir() {
	return path.join(localInferenceRoot(), "models");
}
/** JSON file tracking installed-model metadata (downloaded + discovered). */
function registryPath() {
	return path.join(localInferenceRoot(), "registry.json");
}
/** Partial-download staging directory; files here are resume candidates. */
function downloadsStagingDir() {
	return path.join(localInferenceRoot(), "downloads");
}
/** True when `target` is inside Eliza's local-inference root. */
function isWithinElizaRoot(target) {
	const root = path.resolve(localInferenceRoot());
	const resolved = path.resolve(target);
	if (resolved === root) return false;
	return resolved.startsWith(`${root}${path.sep}`);
}
var init_paths = __esmMin((() => {}));

//#endregion
//#region node_modules/.bun/@elizaos+app-core@2.0.0-alpha.537+72829346cb4c43b1/node_modules/@elizaos/app-core/packages/app-core/src/services/local-inference/external-scanner.js
/**
* Discover GGUF files already on disk from other local-inference tools.
*
* Users often have LM Studio, Jan, Ollama, or raw HuggingFace downloads
* lying around. We scan their default cache paths and surface those models
* in the Model Hub with `source: "external-scan"` so Eliza can load them
* without re-downloading. Eliza never modifies or deletes these files —
* the uninstall endpoint refuses when `source !== "eliza-download"`.
*
* Ollama is special: its blobs live under `models/blobs/sha256-*` with no
* `.gguf` extension, and the human name only exists in adjacent manifests.
* We parse the manifests to recover the mapping; blobs we can't map stay
* hidden rather than surfacing as opaque hashes.
*/
function candidateRoots() {
	const home = os.homedir();
	const platform = process.platform;
	const roots = [];
	roots.push({
		origin: "lm-studio",
		dir: path.join(home, ".lmstudio", "models"),
		kind: "flat"
	}, {
		origin: "lm-studio",
		dir: path.join(home, ".cache", "lm-studio", "models"),
		kind: "flat"
	});
	if (platform === "darwin") roots.push({
		origin: "jan",
		dir: path.join(home, "Library", "Application Support", "Jan", "data", "models"),
		kind: "flat"
	});
	else if (platform === "win32") {
		const appdata = process.env.APPDATA ?? path.join(home, "AppData", "Roaming");
		roots.push({
			origin: "jan",
			dir: path.join(appdata, "Jan", "data", "models"),
			kind: "flat"
		});
	} else {
		const xdg = process.env.XDG_CONFIG_HOME ?? path.join(home, ".config");
		roots.push({
			origin: "jan",
			dir: path.join(xdg, "Jan", "data", "models"),
			kind: "flat"
		});
	}
	roots.push({
		origin: "jan",
		dir: path.join(home, "jan", "models"),
		kind: "flat"
	});
	const ollamaOverride = process.env.OLLAMA_MODELS?.trim();
	if (ollamaOverride) roots.push({
		origin: "ollama",
		dir: ollamaOverride,
		kind: "ollama"
	});
	roots.push({
		origin: "ollama",
		dir: path.join(home, ".ollama", "models"),
		kind: "ollama"
	});
	if (platform === "linux") roots.push({
		origin: "ollama",
		dir: "/usr/share/ollama/.ollama/models",
		kind: "ollama"
	}, {
		origin: "ollama",
		dir: "/var/lib/ollama/.ollama/models",
		kind: "ollama"
	});
	const hfOverride = process.env.HF_HUB_CACHE?.trim() || (process.env.HF_HOME ? path.join(process.env.HF_HOME, "hub") : null);
	const hfDefault = path.join(home, ".cache", "huggingface", "hub");
	roots.push({
		origin: "huggingface",
		dir: hfOverride || hfDefault,
		kind: "hf-snapshots"
	});
	roots.push({
		origin: "text-gen-webui",
		dir: path.join(home, "text-generation-webui", "user_data", "models"),
		kind: "flat"
	}, {
		origin: "text-gen-webui",
		dir: path.join(home, "text-generation-webui", "models"),
		kind: "flat"
	});
	return roots;
}
async function dirExists(dir) {
	try {
		return (await fs$1.stat(dir)).isDirectory();
	} catch {
		return false;
	}
}
async function* walkForGgufs(root, maxDepth = 6) {
	const stack = [{
		dir: root,
		depth: 0
	}];
	while (stack.length > 0) {
		const frame = stack.pop();
		if (!frame) break;
		const { dir, depth } = frame;
		let entries;
		try {
			entries = await fs$1.readdir(dir, { withFileTypes: true });
		} catch {
			continue;
		}
		for (const entry of entries) {
			const full = path.join(dir, entry.name);
			if (entry.isDirectory()) {
				if (depth < maxDepth) stack.push({
					dir: full,
					depth: depth + 1
				});
				continue;
			}
			const isLink = entry.isSymbolicLink();
			if (!isLink && !entry.isFile()) continue;
			if (!full.toLowerCase().endsWith(".gguf")) continue;
			try {
				const realPath = isLink ? await fs$1.realpath(full) : full;
				const stat = await fs$1.stat(realPath);
				if (!stat.isFile()) continue;
				yield {
					absPath: full,
					realPath,
					size: stat.size,
					mtimeMs: stat.mtimeMs
				};
			} catch {}
		}
	}
}
async function scanOllama(root) {
	const manifestsRoot = path.join(root, "manifests");
	const blobsRoot = path.join(root, "blobs");
	if (!await dirExists(manifestsRoot) || !await dirExists(blobsRoot)) return [];
	const results = [];
	const stack = [manifestsRoot];
	while (stack.length > 0) {
		const dir = stack.pop();
		if (!dir) break;
		let entries;
		try {
			entries = await fs$1.readdir(dir, { withFileTypes: true });
		} catch {
			continue;
		}
		for (const entry of entries) {
			const full = path.join(dir, entry.name);
			if (entry.isDirectory()) {
				stack.push(full);
				continue;
			}
			if (!entry.isFile()) continue;
			let manifest;
			try {
				const raw = await fs$1.readFile(full, "utf8");
				manifest = JSON.parse(raw);
			} catch {
				continue;
			}
			const modelLayer = manifest.layers?.find((l) => l.mediaType?.includes("model"));
			if (!modelLayer?.digest) continue;
			const digest = modelLayer.digest.replace("sha256:", "sha256-");
			const blobPath = path.join(blobsRoot, digest);
			let size = modelLayer.size;
			try {
				size = (await fs$1.stat(blobPath)).size;
			} catch {
				continue;
			}
			const displayName = `ollama: ${path.relative(manifestsRoot, full).split(path.sep).slice(-2).join(":")}`;
			results.push({
				id: `external-ollama-${digest}`,
				displayName,
				path: blobPath,
				sizeBytes: size,
				installedAt: (/* @__PURE__ */ new Date()).toISOString(),
				lastUsedAt: null,
				source: "external-scan",
				externalOrigin: "ollama"
			});
		}
	}
	return results;
}
async function scanExternalModels() {
	const roots = candidateRoots();
	const seenRealPaths = /* @__PURE__ */ new Set();
	const results = [];
	await Promise.all(roots.map(async (root) => {
		if (!await dirExists(root.dir)) return;
		if (root.kind === "ollama") {
			const ollamaModels = await scanOllama(root.dir);
			for (const model of ollamaModels) {
				if (seenRealPaths.has(model.path)) continue;
				seenRealPaths.add(model.path);
				results.push(model);
			}
			return;
		}
		for await (const found of walkForGgufs(root.dir)) {
			if (seenRealPaths.has(found.realPath)) continue;
			seenRealPaths.add(found.realPath);
			const displayName = path.basename(found.absPath, ".gguf");
			results.push({
				id: `external-${root.origin}-${Buffer.from(found.realPath).toString("base64url").slice(0, 16)}`,
				displayName: `${displayName} (${root.origin})`,
				path: found.realPath,
				sizeBytes: found.size,
				installedAt: new Date(found.mtimeMs).toISOString(),
				lastUsedAt: null,
				source: "external-scan",
				externalOrigin: root.origin
			});
		}
	}));
	return results;
}
var init_external_scanner = __esmMin((() => {}));

//#endregion
//#region node_modules/.bun/@elizaos+app-core@2.0.0-alpha.537+72829346cb4c43b1/node_modules/@elizaos/app-core/packages/app-core/src/services/local-inference/registry.js
/**
* On-disk registry of installed models.
*
* Two sources feed the registry:
*   1. Eliza-owned downloads (source: "eliza-download") — written on
*      successful completion by the downloader.
*   2. External scans (source: "external-scan") — merged in at read time
*      from `scanExternalModels()`. These are never persisted to the
*      registry file; a rescan runs whenever we read.
*
* The JSON file only holds Eliza-owned entries. That way, if a user
* cleans up LM Studio models we don't show stale ghosts.
*/
async function ensureRootDir() {
	await fs$1.mkdir(localInferenceRoot(), { recursive: true });
}
async function readElizaOwned() {
	try {
		const raw = await fs$1.readFile(registryPath(), "utf8");
		const parsed = JSON.parse(raw);
		if (!parsed || parsed.version !== 1 || !Array.isArray(parsed.models)) return [];
		return parsed.models.filter((m) => m && typeof m === "object" && m.source === "eliza-download");
	} catch {
		return [];
	}
}
async function writeElizaOwned(models) {
	await ensureRootDir();
	const tmp = `${registryPath()}.tmp`;
	const payload = {
		version: 1,
		models
	};
	await fs$1.writeFile(tmp, JSON.stringify(payload, null, 2), "utf8");
	await fs$1.rename(tmp, registryPath());
}
/**
* Return all models currently usable: persisted Eliza downloads plus a
* fresh external-tool scan. External duplicates of Eliza-owned files are
* filtered out by path.
*/
async function listInstalledModels() {
	const [owned, external] = await Promise.all([readElizaOwned(), scanExternalModels()]);
	const ownedPaths = new Set(owned.map((m) => path.resolve(m.path)));
	const dedupedExternal = external.filter((m) => !ownedPaths.has(path.resolve(m.path)));
	return [...owned, ...dedupedExternal];
}
/** Add or update a Eliza-owned entry. External entries are rejected. */
async function upsertElizaModel(model) {
	if (model.source !== "eliza-download") throw new Error("[local-inference] registry only accepts Eliza-owned models");
	if (!isWithinElizaRoot(model.path)) throw new Error("[local-inference] Eliza-owned models must live under the local-inference root");
	const withoutCurrent = (await readElizaOwned()).filter((m) => m.id !== model.id);
	withoutCurrent.push(model);
	await writeElizaOwned(withoutCurrent);
}
/** Mark an existing Eliza-owned model as most-recently-used. */
async function touchElizaModel(id) {
	const owned = await readElizaOwned();
	const target = owned.find((m) => m.id === id);
	if (!target) return;
	target.lastUsedAt = (/* @__PURE__ */ new Date()).toISOString();
	await writeElizaOwned(owned);
}
/**
* Delete a Eliza-owned model from the registry and from disk.
*
* Refuses if the model was discovered from another tool — Eliza must not
* touch files it doesn't own. Callers surface that refusal as a 4xx.
*/
async function removeElizaModel(id) {
	const owned = await readElizaOwned();
	const target = owned.find((m) => m.id === id);
	if (!target) {
		if ((await scanExternalModels()).some((m) => m.id === id)) return {
			removed: false,
			reason: "external"
		};
		return {
			removed: false,
			reason: "not-found"
		};
	}
	if (!isWithinElizaRoot(target.path)) return {
		removed: false,
		reason: "external"
	};
	try {
		await fs$1.rm(target.path, { force: true });
	} catch {}
	await writeElizaOwned(owned.filter((m) => m.id !== id));
	return { removed: true };
}
var init_registry = __esmMin((() => {
	init_external_scanner();
	init_paths();
}));

//#endregion
//#region node_modules/.bun/@elizaos+app-core@2.0.0-alpha.537+72829346cb4c43b1/node_modules/@elizaos/app-core/packages/app-core/src/services/local-inference/assignments.js
/**
* Per-ModelType model assignment store.
*
* Separate from the "active loaded model" concept in `ActiveModelCoordinator`.
* Assignments are a *policy* — the user's declared intent that
* `ModelType.TEXT_SMALL` should be served by model X and `TEXT_LARGE` by
* model Y. The runtime's model handlers lazy-load whichever assignment
* fires; the coordinator handles the actual swap in and out of memory.
*
* Stored in `$ELIZA_STATE_DIR/local-inference/assignments.json`. Cheap
* enough to rewrite on every change — we never mutate in place.
*/
function assignmentsPath() {
	return path.join(localInferenceRoot(), ASSIGNMENTS_FILENAME);
}
async function ensureRoot$1() {
	await fs$1.mkdir(localInferenceRoot(), { recursive: true });
}
async function readAssignments() {
	try {
		const raw = await fs$1.readFile(assignmentsPath(), "utf8");
		const parsed = JSON.parse(raw);
		if (!parsed || parsed.version !== 1 || !parsed.assignments) return {};
		return parsed.assignments;
	} catch {
		return {};
	}
}
function pickLargestInstalledModel(installed) {
	return installed.filter((model) => typeof model.id === "string" && model.id.length > 0).sort((left, right) => right.sizeBytes - left.sizeBytes)[0] ?? null;
}
function buildRecommendedAssignments(installed) {
	const best = pickLargestInstalledModel(installed);
	if (!best) return {};
	return {
		TEXT_SMALL: best.id,
		TEXT_LARGE: best.id
	};
}
async function readEffectiveAssignments() {
	const [saved, installed] = await Promise.all([readAssignments(), listInstalledModels()]);
	return {
		...buildRecommendedAssignments(installed),
		...saved
	};
}
async function writeAssignments(assignments) {
	await ensureRoot$1();
	const payload = {
		version: 1,
		assignments
	};
	const tmp = `${assignmentsPath()}.tmp`;
	await fs$1.writeFile(tmp, JSON.stringify(payload, null, 2), "utf8");
	await fs$1.rename(tmp, assignmentsPath());
}
async function setAssignment(slot, modelId) {
	const next = { ...await readAssignments() };
	if (modelId) next[slot] = modelId;
	else delete next[slot];
	await writeAssignments(next);
	return next;
}
/**
* Decide which slots a freshly-installed model is a sensible default for.
*
* Today the curated catalog tags models with `category` ∈
* `chat | code | tools | tiny | reasoning` and `bucket` ∈
* `small | mid | large | xl` — no explicit "embedding" tag, because the
* default catalog ships only generative models. The defensive check below
* still recognizes an "embedding" category/bucket for future catalog
* additions and for external-scan models whose ids contain a recognizable
* embedding-family marker (`nomic-embed`, `bge`, `all-minilm`, `gte`,
* `e5-`). External GGUFs without a catalog entry default to generative.
*/
function isEmbeddingModelId(modelId) {
	const catalog = findCatalogModel(modelId);
	if (catalog) {
		if (catalog.category === "embedding") return true;
		if (catalog.bucket === "embedding") return true;
		return false;
	}
	const lowered = modelId.toLowerCase();
	return lowered.includes("nomic-embed") || lowered.includes("bge-") || lowered.includes("all-minilm") || lowered.includes("gte-") || lowered.includes("e5-");
}
/**
* Fill empty assignment slots with `modelId`. Idempotent: never overwrites
* an existing slot. Embedding models only fill `TEXT_EMBEDDING`; generative
* models only fill `TEXT_SMALL` and `TEXT_LARGE`. Returns the resulting
* assignment map (read state is `readAssignments()`, not effective +
* recommended).
*
* Wired from the downloader's success path and the runtime boot's
* "exactly one model installed, no assignments" branch so first-light
* users land in chat without a Settings detour. The hard error in
* `ensure-local-inference-handler.ts` only fires when the operator has
* actively cleared the assignment.
*/
async function ensureDefaultAssignment(modelId) {
	const current = await readAssignments();
	const next = { ...current };
	if (isEmbeddingModelId(modelId)) {
		if (!next.TEXT_EMBEDDING) next.TEXT_EMBEDDING = modelId;
	} else {
		if (!next.TEXT_SMALL) next.TEXT_SMALL = modelId;
		if (!next.TEXT_LARGE) next.TEXT_LARGE = modelId;
	}
	if (next.TEXT_SMALL === current.TEXT_SMALL && next.TEXT_LARGE === current.TEXT_LARGE && next.TEXT_EMBEDDING === current.TEXT_EMBEDDING && next.OBJECT_SMALL === current.OBJECT_SMALL && next.OBJECT_LARGE === current.OBJECT_LARGE) return current;
	await writeAssignments(next);
	return next;
}
/**
* Boot-time helper. If exactly one model is installed and no assignment
* file exists yet, auto-fill its slots so the first session works without
* the user opening Settings. No-op when assignments are already present
* or when more than one model is installed (we cannot guess intent).
*/
async function autoAssignAtBoot(installed) {
	if (installed.length !== 1) return null;
	const current = await readAssignments();
	if (Object.keys(current).length > 0) return null;
	const onlyInstalled = installed[0];
	if (!onlyInstalled || typeof onlyInstalled.id !== "string") return null;
	return ensureDefaultAssignment(onlyInstalled.id);
}
var ASSIGNMENTS_FILENAME;
var init_assignments = __esmMin((() => {
	init_catalog();
	init_paths();
	init_registry();
	ASSIGNMENTS_FILENAME = "assignments.json";
}));

//#endregion
//#region node_modules/.bun/@elizaos+app-core@2.0.0-alpha.537+72829346cb4c43b1/node_modules/@elizaos/app-core/packages/app-core/src/services/local-inference/device-bridge.js
/**
* Device-bridge: agent-side half of the "inference on the user's phone,
* agent in a container" architecture.
*
* Multi-device aware. Any number of devices can dial in; each `generate`
* is routed to the highest-scoring connected device at call time. A phone
* and a Mac paired to the same agent → requests go to the Mac; when the
* Mac disconnects, new requests fall through to the phone automatically.
*
* Scoring (higher = preferred):
*   - desktop / electrobun: 100 base
*   - ios / android:        10 base
*   - per GB of total RAM:  +2
*   - per GB of VRAM:       +5 (dedicated GPU wins big)
*   - has loaded the right model already: +50 (avoid a swap)
*
* Disconnect tolerance
* --------------------
* A pending request stays in `pendingGenerates` until either (a) a device
* (same or different) returns a matching correlation-id, or (b) the
* timeout fires. On any device (re)connect we re-route orphaned
* generates to the new best device.
*
* Durability
* ----------
* Pending requests are best-effort persisted to a JSON log under
* `$ELIZA_STATE_DIR/local-inference/pending-requests.json` so a brief
* agent restart doesn't lose the queue. Persistence is async and
* non-blocking — failures fall back to in-memory only.
*/
/**
* Scoring function — pick the most powerful device available.
* Pure, synchronous, and easy to test.
*/
function scoreDevice(device, opts = {}) {
	const cap = device.capabilities;
	const platformBase = cap.platform === "desktop" || cap.platform === "electrobun" ? 100 : cap.platform === "ios" || cap.platform === "android" ? 10 : 0;
	const ramScore = cap.totalRamGb * 2;
	const vramScore = cap.gpu?.available ? (cap.gpu.totalVramGb ?? cap.totalRamGb) * 5 : 0;
	const loadedBonus = opts.preferLoadedPath && device.loadedPath === opts.preferLoadedPath ? 50 : 0;
	return platformBase + ramScore + vramScore + loadedBonus;
}
var DEFAULT_CALL_TIMEOUT_MS, DEFAULT_LOAD_TIMEOUT_MS, HEARTBEAT_INTERVAL_MS, PENDING_LOG_FILENAME, DeviceBridge, deviceBridge;
var init_device_bridge = __esmMin((() => {
	init_paths();
	DEFAULT_CALL_TIMEOUT_MS = 6e4;
	DEFAULT_LOAD_TIMEOUT_MS = 12e4;
	HEARTBEAT_INTERVAL_MS = 15e3;
	PENDING_LOG_FILENAME = "pending-requests.json";
	DeviceBridge = class {
		devices = /* @__PURE__ */ new Map();
		wss = null;
		restored = false;
		pendingLoads = /* @__PURE__ */ new Map();
		pendingUnloads = /* @__PURE__ */ new Map();
		pendingGenerates = /* @__PURE__ */ new Map();
		pendingEmbeds = /* @__PURE__ */ new Map();
		statusListeners = /* @__PURE__ */ new Set();
		expectedPairingToken = process.env.ELIZA_DEVICE_PAIRING_TOKEN?.trim() || null;
		status() {
			const summaries = [];
			for (const device of this.devices.values()) {
				const score = scoreDevice(device);
				const activeRequests = this.countRouted(this.pendingGenerates, device.deviceId) + this.countRouted(this.pendingEmbeds, device.deviceId) + this.countRouted(this.pendingLoads, device.deviceId) + this.countRouted(this.pendingUnloads, device.deviceId);
				summaries.push({
					deviceId: device.deviceId,
					capabilities: device.capabilities,
					loadedPath: device.loadedPath,
					connectedSince: new Date(device.connectedAt).toISOString(),
					score,
					activeRequests,
					isPrimary: false
				});
			}
			summaries.sort((a, b) => b.score - a.score);
			if (summaries[0]) summaries[0].isPrimary = true;
			const primary = summaries[0] ?? null;
			const pendingRequests = this.pendingGenerates.size + this.pendingEmbeds.size + this.pendingLoads.size + this.pendingUnloads.size;
			return {
				connected: summaries.length > 0,
				devices: summaries,
				primaryDeviceId: primary?.deviceId ?? null,
				pendingRequests,
				deviceId: primary?.deviceId ?? null,
				capabilities: primary?.capabilities ?? null,
				loadedPath: primary?.loadedPath ?? null,
				connectedSince: primary?.connectedSince ?? null
			};
		}
		countRouted(map, deviceId) {
			let n = 0;
			for (const value of map.values()) if (value.routedDeviceId === deviceId) n += 1;
			return n;
		}
		subscribeStatus(listener) {
			this.statusListeners.add(listener);
			return () => {
				this.statusListeners.delete(listener);
			};
		}
		emitStatus() {
			const snapshot = this.status();
			for (const listener of this.statusListeners) try {
				listener(snapshot);
			} catch {
				this.statusListeners.delete(listener);
			}
		}
		async attachToHttpServer(server) {
			if (this.wss) return;
			const ws = await import("ws");
			const wss = new ws.WebSocketServer({
				noServer: true,
				maxPayload: 1024 * 1024
			});
			this.wss = wss;
			wss.on("error", (err) => {
				logger.warn("[device-bridge] WSS error:", err.message);
			});
			server.on("upgrade", (request, socket, head) => {
				const url = new URL(request.url ?? "/", "http://localhost");
				if (url.pathname !== "/api/local-inference/device-bridge") return;
				wss.handleUpgrade(request, socket, head, (client) => {
					this.handleConnection(client, ws.WebSocket, url);
				});
			});
			if (!this.restored) {
				this.restored = true;
				await this.restorePendingGenerates();
			}
		}
		handleConnection(socket, WsCtor, url) {
			const queryToken = url.searchParams.get("token")?.trim();
			if (this.expectedPairingToken && queryToken !== this.expectedPairingToken) {
				logger.warn("[device-bridge] Rejecting connection: bad query token");
				socket.close(4001, "unauthorized");
				return;
			}
			let registered = false;
			let registeredDeviceId = null;
			socket.on("message", (raw) => {
				let msg;
				try {
					const text = typeof raw === "string" ? raw : raw.toString("utf8");
					msg = JSON.parse(text);
				} catch {
					logger.warn("[device-bridge] Ignoring non-JSON frame");
					return;
				}
				if (!registered) {
					if (msg.type !== "register") {
						logger.warn("[device-bridge] First frame must be register");
						socket.close(4002, "must-register-first");
						return;
					}
					if (this.expectedPairingToken && msg.payload.pairingToken !== this.expectedPairingToken) {
						logger.warn("[device-bridge] Rejecting register: bad pairing token");
						socket.close(4001, "unauthorized");
						return;
					}
					registered = true;
					registeredDeviceId = msg.payload.deviceId;
					this.onDeviceRegistered(socket, WsCtor, msg.payload);
					return;
				}
				this.handleDeviceMessage(msg);
			});
			socket.on("close", () => {
				if (!registered || !registeredDeviceId) return;
				const current = this.devices.get(registeredDeviceId);
				if (current && current.socket === socket) this.onDeviceDisconnected(registeredDeviceId);
			});
			socket.on("error", (err) => {
				logger.warn("[device-bridge] Socket error:", err.message);
			});
		}
		onDeviceRegistered(socket, WsCtor, registration) {
			const existing = this.devices.get(registration.deviceId);
			if (existing) {
				try {
					existing.socket.close(4003, "superseded");
				} catch {}
				clearInterval(existing.heartbeatTimer);
			}
			const device = {
				deviceId: registration.deviceId,
				socket,
				capabilities: registration.capabilities,
				loadedPath: registration.loadedPath,
				connectedAt: Date.now(),
				lastHeartbeatAt: Date.now(),
				heartbeatTimer: setInterval(() => {
					if (socket.readyState !== WsCtor.OPEN) return;
					try {
						this.sendToDevice(device.deviceId, {
							type: "ping",
							at: Date.now()
						});
					} catch {}
				}, HEARTBEAT_INTERVAL_MS)
			};
			if (typeof device.heartbeatTimer === "object" && device.heartbeatTimer && "unref" in device.heartbeatTimer) device.heartbeatTimer.unref();
			this.devices.set(device.deviceId, device);
			logger.info(`[device-bridge] Device connected: ${device.deviceId} (${device.capabilities.platform}, score=${scoreDevice(device)})`);
			for (const pending of this.pendingLoads.values()) {
				if (pending.routedDeviceId === device.deviceId) continue;
				if (!this.devices.has(pending.routedDeviceId)) {
					clearTimeout(pending.timeout);
					this.pendingLoads.delete(pending.correlationId);
					pending.reject(/* @__PURE__ */ new Error("DEVICE_RECONNECTED: retry model load after reconnect"));
				}
			}
			for (const pending of this.pendingUnloads.values()) if (!this.devices.has(pending.routedDeviceId)) {
				clearTimeout(pending.timeout);
				this.pendingUnloads.delete(pending.correlationId);
				pending.reject(/* @__PURE__ */ new Error("DEVICE_RECONNECTED: retry model unload after reconnect"));
			}
			for (const pending of this.pendingGenerates.values()) if (pending.routedDeviceId === null) {
				const best = this.pickBestDevice();
				if (best) {
					pending.routedDeviceId = best.deviceId;
					try {
						this.sendToDevice(best.deviceId, pending.request);
					} catch (err) {
						pending.reject(err instanceof Error ? err : /* @__PURE__ */ new Error("Failed to re-route after reconnect"));
					}
				}
			}
			for (const pending of this.pendingEmbeds.values()) if (pending.routedDeviceId === null) {
				const best = this.pickBestDevice();
				if (best) {
					pending.routedDeviceId = best.deviceId;
					try {
						this.sendToDevice(best.deviceId, pending.request);
					} catch (err) {
						pending.reject(err instanceof Error ? err : /* @__PURE__ */ new Error("Failed to re-route after reconnect"));
					}
				}
			}
			this.emitStatus();
		}
		onDeviceDisconnected(deviceId) {
			const device = this.devices.get(deviceId);
			if (!device) return;
			clearInterval(device.heartbeatTimer);
			this.devices.delete(deviceId);
			let orphaned = 0;
			for (const pending of this.pendingGenerates.values()) if (pending.routedDeviceId === deviceId) {
				pending.routedDeviceId = null;
				orphaned += 1;
			}
			for (const pending of this.pendingEmbeds.values()) if (pending.routedDeviceId === deviceId) {
				pending.routedDeviceId = null;
				orphaned += 1;
			}
			logger.info(`[device-bridge] Device disconnected: ${deviceId}; ${orphaned} request(s) orphaned`);
			if (this.devices.size > 0) {
				for (const pending of this.pendingGenerates.values()) if (pending.routedDeviceId === null) {
					const best = this.pickBestDevice();
					if (best) {
						pending.routedDeviceId = best.deviceId;
						try {
							this.sendToDevice(best.deviceId, pending.request);
						} catch {}
					}
				}
				for (const pending of this.pendingEmbeds.values()) if (pending.routedDeviceId === null) {
					const best = this.pickBestDevice();
					if (best) {
						pending.routedDeviceId = best.deviceId;
						try {
							this.sendToDevice(best.deviceId, pending.request);
						} catch {}
					}
				}
			}
			this.emitStatus();
		}
		handleDeviceMessage(msg) {
			if (msg.type === "pong") return;
			if (msg.type === "loadResult") {
				const pending = this.pendingLoads.get(msg.correlationId);
				if (!pending) return;
				clearTimeout(pending.timeout);
				this.pendingLoads.delete(msg.correlationId);
				if (msg.ok === false) pending.reject(new Error(msg.error));
				else {
					const device = this.devices.get(pending.routedDeviceId);
					if (device) device.loadedPath = msg.loadedPath;
					pending.resolve();
					this.emitStatus();
				}
				return;
			}
			if (msg.type === "unloadResult") {
				const pending = this.pendingUnloads.get(msg.correlationId);
				if (!pending) return;
				clearTimeout(pending.timeout);
				this.pendingUnloads.delete(msg.correlationId);
				if (msg.ok === false) pending.reject(new Error(msg.error));
				else {
					const device = this.devices.get(pending.routedDeviceId);
					if (device) device.loadedPath = null;
					pending.resolve();
					this.emitStatus();
				}
				return;
			}
			if (msg.type === "generateResult") {
				const pending = this.pendingGenerates.get(msg.correlationId);
				if (!pending) return;
				clearTimeout(pending.timeout);
				this.pendingGenerates.delete(msg.correlationId);
				this.persistPendingGenerates();
				if (msg.ok === false) pending.reject(new Error(msg.error));
				else pending.resolve(msg.text);
				return;
			}
			if (msg.type === "embedResult") {
				const pending = this.pendingEmbeds.get(msg.correlationId);
				if (!pending) return;
				clearTimeout(pending.timeout);
				this.pendingEmbeds.delete(msg.correlationId);
				if (msg.ok === false) pending.reject(new Error(msg.error));
				else pending.resolve({
					embedding: msg.embedding,
					tokens: msg.tokens
				});
				return;
			}
		}
		sendToDevice(deviceId, msg) {
			const device = this.devices.get(deviceId);
			if (!device) throw new Error(`DEVICE_DISCONNECTED: ${deviceId}`);
			device.socket.send(JSON.stringify(msg));
		}
		/** Highest-scoring connected device, optionally boosted for an already-loaded model. */
		pickBestDevice(opts) {
			let best = null;
			let bestScore = -Infinity;
			for (const device of this.devices.values()) {
				const score = scoreDevice(device, opts);
				if (score > bestScore) {
					best = device;
					bestScore = score;
				}
			}
			return best;
		}
		async loadModel(args) {
			const best = this.pickBestDevice({ preferLoadedPath: args.modelPath });
			if (!best) throw new Error("DEVICE_DISCONNECTED: no mobile / desktop bridge device attached");
			const correlationId = randomUUID();
			return new Promise((resolve, reject) => {
				const timeout = setTimeout(() => {
					this.pendingLoads.delete(correlationId);
					reject(/* @__PURE__ */ new Error("DEVICE_TIMEOUT: model load exceeded deadline"));
				}, DEFAULT_LOAD_TIMEOUT_MS);
				if (typeof timeout === "object" && timeout && "unref" in timeout) timeout.unref();
				this.pendingLoads.set(correlationId, {
					correlationId,
					modelPath: args.modelPath,
					resolve,
					reject,
					timeout,
					routedDeviceId: best.deviceId
				});
				try {
					this.sendToDevice(best.deviceId, {
						type: "load",
						correlationId,
						modelPath: args.modelPath,
						contextSize: args.contextSize,
						useGpu: args.useGpu
					});
				} catch (err) {
					clearTimeout(timeout);
					this.pendingLoads.delete(correlationId);
					reject(err instanceof Error ? err : new Error(String(err)));
				}
			});
		}
		async unloadModel() {
			const targets = [...this.devices.values()].filter((d) => d.loadedPath);
			if (targets.length === 0) return;
			await Promise.allSettled(targets.map((device) => new Promise((resolve, reject) => {
				const correlationId = randomUUID();
				const timeout = setTimeout(() => {
					this.pendingUnloads.delete(correlationId);
					reject(/* @__PURE__ */ new Error("DEVICE_TIMEOUT: unload exceeded deadline"));
				}, DEFAULT_CALL_TIMEOUT_MS);
				if (typeof timeout === "object" && timeout && "unref" in timeout) timeout.unref();
				this.pendingUnloads.set(correlationId, {
					correlationId,
					resolve,
					reject,
					timeout,
					routedDeviceId: device.deviceId
				});
				try {
					this.sendToDevice(device.deviceId, {
						type: "unload",
						correlationId
					});
				} catch (err) {
					clearTimeout(timeout);
					this.pendingUnloads.delete(correlationId);
					reject(err instanceof Error ? err : new Error(String(err)));
				}
			})));
		}
		currentModelPath() {
			return this.pickBestDevice()?.loadedPath ?? null;
		}
		async embed(args) {
			const envTimeout = Number.parseInt(process.env.ELIZA_DEVICE_GENERATE_TIMEOUT_MS?.trim() ?? "", 10);
			const timeoutMs = Number.isFinite(envTimeout) && envTimeout > 0 ? envTimeout : DEFAULT_CALL_TIMEOUT_MS;
			const correlationId = randomUUID();
			const request = {
				type: "embed",
				correlationId,
				input: args.input
			};
			const best = this.pickBestDevice();
			return new Promise((resolve, reject) => {
				const timeout = setTimeout(() => {
					this.pendingEmbeds.delete(correlationId);
					reject(/* @__PURE__ */ new Error(`DEVICE_TIMEOUT: no device responded to embed within ${timeoutMs}ms`));
				}, timeoutMs);
				if (typeof timeout === "object" && timeout && "unref" in timeout) timeout.unref();
				const pending = {
					correlationId,
					resolve,
					reject,
					timeout,
					request,
					routedDeviceId: best?.deviceId ?? null,
					submittedAt: (/* @__PURE__ */ new Date()).toISOString()
				};
				this.pendingEmbeds.set(correlationId, pending);
				if (best) try {
					this.sendToDevice(best.deviceId, request);
				} catch {
					pending.routedDeviceId = null;
				}
				else logger.debug(`[device-bridge] No device available; parking embed ${correlationId} pending connection`);
			});
		}
		async generate(args) {
			const envTimeout = Number.parseInt(process.env.ELIZA_DEVICE_GENERATE_TIMEOUT_MS?.trim() ?? "", 10);
			const timeoutMs = Number.isFinite(envTimeout) && envTimeout > 0 ? envTimeout : DEFAULT_CALL_TIMEOUT_MS;
			const correlationId = randomUUID();
			const request = {
				type: "generate",
				correlationId,
				prompt: args.prompt,
				stopSequences: args.stopSequences,
				maxTokens: args.maxTokens,
				temperature: args.temperature
			};
			const best = this.pickBestDevice();
			return new Promise((resolve, reject) => {
				const timeout = setTimeout(() => {
					this.pendingGenerates.delete(correlationId);
					this.persistPendingGenerates();
					reject(/* @__PURE__ */ new Error(`DEVICE_TIMEOUT: no device responded within ${timeoutMs}ms`));
				}, timeoutMs);
				if (typeof timeout === "object" && timeout && "unref" in timeout) timeout.unref();
				const pending = {
					correlationId,
					resolve,
					reject,
					timeout,
					request,
					routedDeviceId: best?.deviceId ?? null,
					submittedAt: (/* @__PURE__ */ new Date()).toISOString()
				};
				this.pendingGenerates.set(correlationId, pending);
				this.persistPendingGenerates();
				if (best) try {
					this.sendToDevice(best.deviceId, request);
				} catch {
					pending.routedDeviceId = null;
				}
				else logger.debug(`[device-bridge] No device available; parking generate ${correlationId} pending connection`);
			});
		}
		pendingLogPath() {
			return path.join(localInferenceRoot(), PENDING_LOG_FILENAME);
		}
		/**
		* Rewrite the pending-generate log. Called after every mutation to the
		* pendingGenerates map. We only persist `generate` — loads/unloads are
		* bound to a specific device's current state and aren't safely replayable
		* across restart.
		*/
		async persistPendingGenerates() {
			try {
				await fs$1.mkdir(localInferenceRoot(), { recursive: true });
				const payload = [...this.pendingGenerates.values()].map((p) => ({
					correlationId: p.correlationId,
					request: p.request,
					submittedAt: p.submittedAt
				}));
				const tmp = `${this.pendingLogPath()}.tmp`;
				await fs$1.writeFile(tmp, JSON.stringify(payload, null, 2), "utf8");
				await fs$1.rename(tmp, this.pendingLogPath());
			} catch (err) {
				logger.debug("[device-bridge] Failed to persist pending generates:", err instanceof Error ? err.message : String(err));
			}
		}
		/**
		* On startup, read persisted pending requests back into memory. Their
		* promises are gone (the original caller's process is dead) so they can
		* only be resolved externally — for now we just re-queue them with a
		* fresh timeout, and the first device that connects will process them.
		* If nothing consumes them within the timeout they reject quietly.
		*
		* Stale entries older than 24h are purged rather than resurrected.
		*/
		async restorePendingGenerates() {
			let raw;
			try {
				raw = await fs$1.readFile(this.pendingLogPath(), "utf8");
			} catch {
				return;
			}
			let items;
			try {
				items = JSON.parse(raw);
				if (!Array.isArray(items)) return;
			} catch {
				return;
			}
			const cutoff = Date.now() - 1440 * 60 * 1e3;
			let restored = 0;
			for (const item of items) {
				if (!item.correlationId || !item.request || item.request.type !== "generate") continue;
				const submittedAt = Date.parse(item.submittedAt);
				if (!Number.isFinite(submittedAt) || submittedAt < cutoff) continue;
				if (this.pendingGenerates.has(item.correlationId)) continue;
				const timeout = setTimeout(() => {
					this.pendingGenerates.delete(item.correlationId);
					this.persistPendingGenerates();
				}, DEFAULT_CALL_TIMEOUT_MS);
				if (typeof timeout === "object" && timeout && "unref" in timeout) timeout.unref();
				this.pendingGenerates.set(item.correlationId, {
					correlationId: item.correlationId,
					request: item.request,
					submittedAt: item.submittedAt,
					routedDeviceId: null,
					timeout,
					resolve: () => {},
					reject: () => {}
				});
				restored += 1;
			}
			if (restored > 0) logger.info(`[device-bridge] Restored ${restored} pending generate(s) from persistent log`);
		}
	};
	deviceBridge = new DeviceBridge();
}));

//#endregion
//#region node_modules/.bun/@elizaos+app-core@2.0.0-alpha.537+72829346cb4c43b1/node_modules/@elizaos/app-core/packages/app-core/src/services/local-inference/engine.js
var LocalInferenceEngine, localInferenceEngine;
var init_engine = __esmMin((() => {
	LocalInferenceEngine = class {
		llama = null;
		loadedModel = null;
		loadedContext = null;
		loadedSession = null;
		loadedPath = null;
		bindingChecked = false;
		bindingModule = null;
		/** Serialises generate calls so concurrent requests don't corrupt session state. */
		generationQueue = Promise.resolve();
		async available() {
			if (!this.bindingChecked) {
				this.bindingModule = await this.loadBinding();
				this.bindingChecked = true;
			}
			return this.bindingModule !== null;
		}
		currentModelPath() {
			return this.loadedPath;
		}
		hasLoadedModel() {
			return this.loadedModel !== null;
		}
		async unload() {
			if (!this.loadedModel) return;
			const session = this.loadedSession;
			const context = this.loadedContext;
			const model = this.loadedModel;
			this.loadedSession = null;
			this.loadedContext = null;
			this.loadedModel = null;
			this.loadedPath = null;
			try {
				await session?.dispose?.();
			} catch {}
			try {
				await context?.dispose();
			} catch {}
			await model.dispose();
		}
		async load(modelPath) {
			if (this.loadedPath === modelPath && this.loadedModel) return;
			if (!await this.available() || !this.bindingModule) throw new Error("node-llama-cpp is not installed in this build; add it as a dependency to enable local inference");
			if (this.loadedModel) await this.unload();
			if (!this.llama) this.llama = await this.bindingModule.getLlama({ gpu: "auto" });
			const model = await this.llama.loadModel({
				modelPath,
				gpuLayers: "auto"
			});
			const context = await model.createContext();
			const sequence = context.getSequence();
			const session = new this.bindingModule.LlamaChatSession({ contextSequence: sequence });
			this.loadedModel = model;
			this.loadedContext = context;
			this.loadedSession = session;
			this.loadedPath = modelPath;
		}
		/**
		* Generate text from the loaded model. Serialised — a new call waits for
		* any in-flight generation to finish so the chat session's internal state
		* stays consistent.
		*/
		async generate(args) {
			if (!this.loadedSession) throw new Error("No local model is active. Select one in Settings → Local models before using local inference.");
			const session = this.loadedSession;
			const run = async () => {
				await session.resetChatHistory?.();
				return session.prompt(args.prompt, {
					maxTokens: args.maxTokens ?? 2048,
					temperature: args.temperature ?? .7,
					topP: args.topP ?? .9,
					customStopTriggers: args.stopSequences
				});
			};
			const job = this.generationQueue.then(run, run);
			this.generationQueue = job.catch(() => {});
			return job;
		}
		async loadBinding() {
			try {
				const mod = await import("node-llama-cpp");
				if (mod && typeof mod === "object" && "getLlama" in mod && "LlamaChatSession" in mod && typeof mod.getLlama === "function") return mod;
				return null;
			} catch {
				return null;
			}
		}
	};
	localInferenceEngine = new LocalInferenceEngine();
}));

//#endregion
//#region node_modules/.bun/@elizaos+app-core@2.0.0-alpha.537+72829346cb4c43b1/node_modules/@elizaos/app-core/packages/app-core/src/services/local-inference/handler-registry.js
/**
* Side-registry of model handlers registered on an AgentRuntime.
*
* The elizaOS core exposes `runtime.registerModel(type, handler, provider,
* priority)` but no way to list who registered what. This module intercepts
* `registerModel` at runtime to record every registration in a Map keyed by
* model type, plus fires status listeners so the UI can render a live
* [ModelType × Provider] routing table.
*
* Because we monkey-patch `registerModel` we also keep the original
* handler reference — the router-handler (see `router-handler.ts`) uses
* this to dispatch inference calls by policy without going through
* `runtime.useModel` (which would loop back to us and recurse).
*/
/**
* One-shot patch of `AgentRuntime.prototype.registerModel` so every runtime
* instance — including ones constructed later in boot — records through
* the singleton handler registry. Idempotent.
*/
function installPrototypePatch() {
	if (prototypePatched) return;
	const proto = AgentRuntime.prototype;
	const original = proto.registerModel;
	if (typeof original !== "function") return;
	if (original[PATCH_MARK]) {
		prototypePatched = true;
		return;
	}
	const patched = function patchedRegisterModel(modelType, handler, provider, priority) {
		try {
			handlerRegistry.recordFromPrototype({
				modelType: String(modelType),
				provider: String(provider),
				priority: typeof priority === "number" ? priority : 0,
				registeredAt: (/* @__PURE__ */ new Date()).toISOString(),
				handler
			});
		} catch {}
		original.call(this, modelType, handler, provider, priority);
	};
	patched[PATCH_MARK] = true;
	proto.registerModel = patched;
	prototypePatched = true;
}
function toPublicRegistration(reg) {
	return {
		modelType: reg.modelType,
		provider: reg.provider,
		priority: reg.priority,
		registeredAt: reg.registeredAt
	};
}
var HandlerRegistry, PATCH_MARK, prototypePatched, handlerRegistry;
var init_handler_registry = __esmMin((() => {
	HandlerRegistry = class {
		registrations = /* @__PURE__ */ new Map();
		listeners = /* @__PURE__ */ new Set();
		installedOn = /* @__PURE__ */ new WeakSet();
		/**
		* Snapshot of all registrations grouped by model type, sorted by
		* priority descending inside each group (matches core's selection
		* order). Callers must not mutate the returned array.
		*/
		getAll() {
			const out = [];
			for (const list of this.registrations.values()) out.push(...list);
			return out;
		}
		/** All registrations for a given model type, sorted by priority desc. */
		getForType(modelType) {
			const list = this.registrations.get(modelType);
			return list ? [...list] : [];
		}
		/**
		* Registrations excluding a specific provider. Used by the router-handler
		* to find "all providers except me" when dispatching.
		*/
		getForTypeExcluding(modelType, excludeProvider) {
			return this.getForType(modelType).filter((r) => r.provider !== excludeProvider);
		}
		subscribe(listener) {
			this.listeners.add(listener);
			return () => {
				this.listeners.delete(listener);
			};
		}
		emit() {
			const snapshot = this.getAll();
			for (const listener of this.listeners) try {
				listener(snapshot);
			} catch {
				this.listeners.delete(listener);
			}
		}
		record(reg) {
			const filtered = (this.registrations.get(reg.modelType) ?? []).filter((r) => r.provider !== reg.provider);
			filtered.push(reg);
			filtered.sort((a, b) => b.priority - a.priority);
			this.registrations.set(reg.modelType, filtered);
			this.emit();
		}
		/**
		* Install the interception on a runtime. Idempotent per runtime instance.
		* For most boot paths the prototype-level patch below already covers the
		* runtime before any plugin registers; this method is the belt-and-braces
		* fallback for runtimes constructed before the patch ran.
		*/
		installOn(runtime) {
			installPrototypePatch();
			const rt = runtime;
			if (typeof rt.registerModel !== "function") return;
			if (this.installedOn.has(rt)) return;
			this.installedOn.add(rt);
			const protoMethod = Object.getPrototypeOf(rt)?.registerModel;
			if (protoMethod && protoMethod[PATCH_MARK]) return;
			const original = rt.registerModel.bind(runtime);
			rt.registerModel = ((modelType, handler, provider, priority) => {
				this.record({
					modelType: String(modelType),
					provider: String(provider),
					priority: typeof priority === "number" ? priority : 0,
					registeredAt: (/* @__PURE__ */ new Date()).toISOString(),
					handler
				});
				return original(modelType, handler, provider, priority);
			});
		}
		/** Exposed so the prototype patch can record through the singleton. */
		recordFromPrototype(reg) {
			this.record(reg);
		}
	};
	PATCH_MARK = Symbol.for("eliza.local-inference.registerModel.patched");
	prototypePatched = false;
	installPrototypePatch();
	handlerRegistry = new HandlerRegistry();
}));

//#endregion
//#region node_modules/.bun/@elizaos+app-core@2.0.0-alpha.537+72829346cb4c43b1/node_modules/@elizaos/app-core/packages/app-core/src/services/local-inference/routing-policy.js
var RING_SIZE, RingBuffer, COST_PER_MILLION_TOKENS, PolicyEngine, policyEngine;
var init_routing_policy = __esmMin((() => {
	RING_SIZE = 32;
	RingBuffer = class {
		buf = [];
		push(sample) {
			this.buf.push(sample);
			if (this.buf.length > RING_SIZE) this.buf.shift();
		}
		p50() {
			if (this.buf.length === 0) return null;
			const sorted = [...this.buf].map((s) => s.durationMs).sort((a, b) => a - b);
			return sorted[Math.floor(sorted.length / 2)] ?? null;
		}
		size() {
			return this.buf.length;
		}
	};
	COST_PER_MILLION_TOKENS = {
		"eliza-local-inference": {
			input: 0,
			output: 0
		},
		"eliza-device-bridge": {
			input: 0,
			output: 0
		},
		"capacitor-llama": {
			input: 0,
			output: 0
		},
		"anthropic-subscription": {
			input: .1,
			output: .1
		},
		"openai-codex": {
			input: .1,
			output: .1
		},
		"openai-subscription": {
			input: .1,
			output: .1
		},
		anthropic: {
			input: 3,
			output: 15
		},
		openai: {
			input: 2.5,
			output: 10
		},
		grok: {
			input: 5,
			output: 15
		},
		google: {
			input: 1.25,
			output: 5
		},
		"google-genai": {
			input: 1.25,
			output: 5
		},
		moonshot: {
			input: 1.25,
			output: 5
		},
		kimi: {
			input: 1.25,
			output: 5
		},
		zai: {
			input: 1.25,
			output: 5
		},
		glm: {
			input: 1.25,
			output: 5
		},
		mistral: {
			input: 2,
			output: 6
		},
		elizacloud: {
			input: 30,
			output: 60
		}
	};
	PolicyEngine = class {
		stats = /* @__PURE__ */ new Map();
		statsFor(provider) {
			let s = this.stats.get(provider);
			if (!s) {
				s = {
					latency: /* @__PURE__ */ new Map(),
					lastPicked: /* @__PURE__ */ new Map()
				};
				this.stats.set(provider, s);
			}
			return s;
		}
		recordLatency(provider, modelType, durationMs) {
			const s = this.statsFor(provider);
			let buf = s.latency.get(modelType);
			if (!buf) {
				buf = new RingBuffer();
				s.latency.set(modelType, buf);
			}
			buf.push({
				durationMs,
				at: Date.now()
			});
		}
		recordPick(provider, modelType) {
			this.statsFor(provider).lastPicked.set(modelType, Date.now());
		}
		p50(provider, modelType) {
			return this.statsFor(provider).latency.get(modelType)?.p50() ?? null;
		}
		lastPicked(provider, modelType) {
			return this.statsFor(provider).lastPicked.get(modelType) ?? null;
		}
		costOf(provider) {
			const c = COST_PER_MILLION_TOKENS[provider];
			if (!c) return null;
			return c.input * .25 + c.output * .75;
		}
		/**
		* Pick a provider for this (modelType, policy) given the registry.
		* Returns the HandlerRegistration whose handler the router-handler
		* should dispatch to, or null if no eligible handler exists.
		*
		* `preferredProvider` is only honoured for policy === "manual".
		*/
		pickProvider(args) {
			const eligible = args.candidates.filter((c) => c.provider !== args.selfProvider).slice().sort((a, b) => b.priority - a.priority);
			if (eligible.length === 0) return null;
			switch (args.policy) {
				case "manual":
					if (args.preferredProvider) {
						const match = eligible.find((c) => c.provider === args.preferredProvider);
						if (match) return match;
					}
					return eligible[0] ?? null;
				case "cheapest": return [...eligible].sort((a, b) => {
					const ca = this.costOf(a.provider) ?? Number.POSITIVE_INFINITY;
					const cb = this.costOf(b.provider) ?? Number.POSITIVE_INFINITY;
					if (ca !== cb) return ca - cb;
					return b.priority - a.priority;
				})[0] ?? null;
				case "fastest": return [...eligible].sort((a, b) => {
					const la = this.p50(a.provider, args.modelType);
					const lb = this.p50(b.provider, args.modelType);
					const va = la ?? Number.POSITIVE_INFINITY;
					const vb = lb ?? Number.POSITIVE_INFINITY;
					if (va !== vb) return va - vb;
					return b.priority - a.priority;
				})[0] ?? null;
				case "prefer-local": {
					const local = eligible.find((c) => c.provider === "eliza-local-inference" || c.provider === "capacitor-llama");
					if (local) return local;
					const bridge = eligible.find((c) => c.provider === "eliza-device-bridge");
					if (bridge) return bridge;
					return eligible[0] ?? null;
				}
				case "round-robin": return [...eligible].sort((a, b) => {
					const la = this.lastPicked(a.provider, args.modelType) ?? 0;
					const lb = this.lastPicked(b.provider, args.modelType) ?? 0;
					if (la !== lb) return la - lb;
					return b.priority - a.priority;
				})[0] ?? null;
			}
		}
		/** For tests and diagnostics. */
		snapshot() {
			const out = {};
			for (const [provider, stats] of this.stats) {
				out[provider] = {};
				for (const [modelType, buf] of stats.latency) {
					const row = out[provider];
					if (row) row[modelType] = buf.p50();
				}
			}
			return out;
		}
	};
	policyEngine = new PolicyEngine();
}));

//#endregion
//#region node_modules/.bun/@elizaos+app-core@2.0.0-alpha.537+72829346cb4c43b1/node_modules/@elizaos/app-core/packages/app-core/src/services/local-inference/routing-preferences.js
/**
* Per-model-type user override: "for TEXT_LARGE, prefer this provider".
*
* Persisted to `$STATE_DIR/local-inference/routing.json` and read by the
* router-handler (see `router-handler.ts`) to pick a provider at dispatch
* time. When a slot has no override, the runtime's native priority order
* wins — i.e. this is layered over the existing registration priority
* rather than replacing it.
*/
function routingPath() {
	return path.join(localInferenceRoot(), "routing.json");
}
async function ensureRoot() {
	await fs$1.mkdir(localInferenceRoot(), { recursive: true });
}
async function readRoutingPreferences() {
	try {
		const raw = await fs$1.readFile(routingPath(), "utf8");
		const parsed = JSON.parse(raw);
		if (!parsed || parsed.version !== 1 || !parsed.preferences) return EMPTY;
		return {
			preferredProvider: parsed.preferences.preferredProvider ?? {},
			policy: parsed.preferences.policy ?? {}
		};
	} catch {
		return EMPTY;
	}
}
async function writeRoutingPreferences(prefs) {
	await ensureRoot();
	const payload = {
		version: 1,
		preferences: prefs
	};
	const tmp = `${routingPath()}.tmp`;
	await fs$1.writeFile(tmp, JSON.stringify(payload, null, 2), "utf8");
	await fs$1.rename(tmp, routingPath());
}
async function setPreferredProvider(slot, provider) {
	const current = await readRoutingPreferences();
	const next = {
		preferredProvider: { ...current.preferredProvider },
		policy: { ...current.policy }
	};
	if (provider) next.preferredProvider[slot] = provider;
	else delete next.preferredProvider[slot];
	await writeRoutingPreferences(next);
	return next;
}
async function setPolicy(slot, policy) {
	const current = await readRoutingPreferences();
	const next = {
		preferredProvider: { ...current.preferredProvider },
		policy: { ...current.policy }
	};
	if (policy) next.policy[slot] = policy;
	else delete next.policy[slot];
	await writeRoutingPreferences(next);
	return next;
}
var DEFAULT_ROUTING_POLICY, EMPTY;
var init_routing_preferences = __esmMin((() => {
	init_paths();
	DEFAULT_ROUTING_POLICY = "prefer-local";
	EMPTY = {
		preferredProvider: {},
		policy: {}
	};
}));

//#endregion
//#region node_modules/.bun/@elizaos+app-core@2.0.0-alpha.537+72829346cb4c43b1/node_modules/@elizaos/app-core/packages/app-core/src/services/local-inference/types.js
var AGENT_MODEL_SLOTS;
var init_types$1 = __esmMin((() => {
	AGENT_MODEL_SLOTS = [
		"TEXT_SMALL",
		"TEXT_LARGE",
		"TEXT_EMBEDDING",
		"OBJECT_SMALL",
		"OBJECT_LARGE"
	];
}));

//#endregion
//#region node_modules/.bun/@elizaos+app-core@2.0.0-alpha.537+72829346cb4c43b1/node_modules/@elizaos/app-core/packages/app-core/src/services/local-inference/router-handler.js
/**
* Top-priority router handler.
*
* Registers a model handler for every `AgentModelSlot` at priority
* `Number.MAX_SAFE_INTEGER`, which guarantees the runtime dispatches to
* us first. At dispatch time we:
*
*   1. Read the user's per-slot policy + preferred-provider choice from
*      `routing-preferences.ts`.
*   2. Ask the `policyEngine` to pick a provider from the handler
*      registry's current set (excluding ourselves).
*   3. Invoke that provider's original handler directly — bypassing
*      `runtime.useModel` which would recurse into us.
*   4. Record the observed latency so future "fastest" picks have data.
*
* If no other handler exists we throw a clear error rather than return
* garbage — the caller is meant to see "no provider configured" so they
* know to set one up.
*
* Because the router sits at the top of the priority stack, the user's
* preference is always authoritative regardless of what plugins register
* at lower priorities. This is the mechanism that unifies cloud + local
* + device-bridge routing from one settings panel.
*/
function slotToModelType(slot) {
	switch (slot) {
		case "TEXT_SMALL": return ModelType.TEXT_SMALL;
		case "TEXT_LARGE": return ModelType.TEXT_LARGE;
		case "TEXT_EMBEDDING": return ModelType.TEXT_EMBEDDING;
		case "OBJECT_SMALL": return ModelType.OBJECT_SMALL;
		case "OBJECT_LARGE": return ModelType.OBJECT_LARGE;
	}
}
function shouldForceLocalInference(policy, preferredProvider) {
	return policy === "manual" && preferredProvider === "eliza-local-inference";
}
function filterUnavailableLocalInferenceCandidates(candidates, localInferenceAvailable, forceLocalInference) {
	if (forceLocalInference || localInferenceAvailable) return candidates;
	return candidates.filter((candidate) => candidate.provider !== "eliza-local-inference");
}
async function filterUnavailableLocalInference(slot, policy, preferredProvider, candidates) {
	if (!candidates.some((candidate) => candidate.provider === "eliza-local-inference")) return candidates;
	const assignments = await readEffectiveAssignments();
	return filterUnavailableLocalInferenceCandidates(candidates, Boolean(assignments[slot]) || localInferenceEngine.hasLoadedModel(), shouldForceLocalInference(policy, preferredProvider));
}
function makeRouterHandler(slot) {
	return async (runtime, params) => {
		const modelType = slotToModelType(slot);
		if (!modelType) throw new Error(`[router] Unknown agent slot: ${slot}`);
		const prefs = await readRoutingPreferences();
		const policy = prefs.policy[slot] ?? DEFAULT_ROUTING_POLICY;
		const preferred = prefs.preferredProvider[slot] ?? null;
		const candidates = await filterUnavailableLocalInference(slot, policy, preferred, handlerRegistry.getForTypeExcluding(modelType, ROUTER_PROVIDER));
		const pick = policyEngine.pickProvider({
			modelType,
			policy,
			preferredProvider: preferred,
			candidates,
			selfProvider: ROUTER_PROVIDER
		});
		if (!pick) throw new Error(`[router] No provider registered for ${slot}. Configure a cloud provider, enable local inference, or pair a device.`);
		policyEngine.recordPick(pick.provider, modelType);
		const start = Date.now();
		try {
			const result = await pick.handler(runtime, params);
			policyEngine.recordLatency(pick.provider, modelType, Date.now() - start);
			return result;
		} catch (err) {
			policyEngine.recordLatency(pick.provider, modelType, Date.now() - start);
			throw err;
		}
	};
}
/**
* Install the router as the top-priority handler for every slot.
*
* Idempotent per-runtime via the handler-registry's "last write wins"
* behaviour — re-registering our handlers just refreshes them in place.
* Called from `ensure-local-inference-handler.ts` after `handlerRegistry`
* has been installed on the runtime.
*/
function installRouterHandler(runtime) {
	const rt = runtime;
	if (typeof rt.registerModel !== "function") return;
	for (const slot of AGENT_MODEL_SLOTS) {
		const modelType = slotToModelType(slot);
		if (!modelType) continue;
		rt.registerModel(modelType, makeRouterHandler(slot), ROUTER_PROVIDER, ROUTER_PRIORITY);
	}
}
var ROUTER_PROVIDER, ROUTER_PRIORITY;
var init_router_handler = __esmMin((() => {
	init_assignments();
	init_engine();
	init_handler_registry();
	init_routing_policy();
	init_routing_preferences();
	init_types$1();
	ROUTER_PROVIDER = "eliza-router";
	ROUTER_PRIORITY = Number.MAX_SAFE_INTEGER;
}));

//#endregion
//#region node_modules/.bun/tslib@2.8.1/node_modules/tslib/tslib.es6.mjs
var tslib_es6_exports = /* @__PURE__ */ __exportAll({
	__addDisposableResource: () => __addDisposableResource,
	__assign: () => __assign,
	__asyncDelegator: () => __asyncDelegator,
	__asyncGenerator: () => __asyncGenerator,
	__asyncValues: () => __asyncValues,
	__await: () => __await,
	__awaiter: () => __awaiter,
	__classPrivateFieldGet: () => __classPrivateFieldGet,
	__classPrivateFieldIn: () => __classPrivateFieldIn,
	__classPrivateFieldSet: () => __classPrivateFieldSet,
	__createBinding: () => __createBinding,
	__decorate: () => __decorate,
	__disposeResources: () => __disposeResources,
	__esDecorate: () => __esDecorate,
	__exportStar: () => __exportStar,
	__extends: () => __extends,
	__generator: () => __generator,
	__importDefault: () => __importDefault,
	__importStar: () => __importStar,
	__makeTemplateObject: () => __makeTemplateObject,
	__metadata: () => __metadata,
	__param: () => __param,
	__propKey: () => __propKey,
	__read: () => __read,
	__rest: () => __rest,
	__rewriteRelativeImportExtension: () => __rewriteRelativeImportExtension$2,
	__runInitializers: () => __runInitializers,
	__setFunctionName: () => __setFunctionName,
	__spread: () => __spread,
	__spreadArray: () => __spreadArray,
	__spreadArrays: () => __spreadArrays,
	__values: () => __values,
	default: () => tslib_es6_default
});
function __extends(d, b) {
	if (typeof b !== "function" && b !== null) throw new TypeError("Class extends value " + String(b) + " is not a constructor or null");
	extendStatics(d, b);
	function __() {
		this.constructor = d;
	}
	d.prototype = b === null ? Object.create(b) : (__.prototype = b.prototype, new __());
}
function __rest(s, e) {
	var t = {};
	for (var p in s) if (Object.prototype.hasOwnProperty.call(s, p) && e.indexOf(p) < 0) t[p] = s[p];
	if (s != null && typeof Object.getOwnPropertySymbols === "function") {
		for (var i = 0, p = Object.getOwnPropertySymbols(s); i < p.length; i++) if (e.indexOf(p[i]) < 0 && Object.prototype.propertyIsEnumerable.call(s, p[i])) t[p[i]] = s[p[i]];
	}
	return t;
}
function __decorate(decorators, target, key, desc) {
	var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
	if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
	else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
	return c > 3 && r && Object.defineProperty(target, key, r), r;
}
function __param(paramIndex, decorator) {
	return function(target, key) {
		decorator(target, key, paramIndex);
	};
}
function __esDecorate(ctor, descriptorIn, decorators, contextIn, initializers, extraInitializers) {
	function accept(f) {
		if (f !== void 0 && typeof f !== "function") throw new TypeError("Function expected");
		return f;
	}
	var kind = contextIn.kind, key = kind === "getter" ? "get" : kind === "setter" ? "set" : "value";
	var target = !descriptorIn && ctor ? contextIn["static"] ? ctor : ctor.prototype : null;
	var descriptor = descriptorIn || (target ? Object.getOwnPropertyDescriptor(target, contextIn.name) : {});
	var _, done = false;
	for (var i = decorators.length - 1; i >= 0; i--) {
		var context = {};
		for (var p in contextIn) context[p] = p === "access" ? {} : contextIn[p];
		for (var p in contextIn.access) context.access[p] = contextIn.access[p];
		context.addInitializer = function(f) {
			if (done) throw new TypeError("Cannot add initializers after decoration has completed");
			extraInitializers.push(accept(f || null));
		};
		var result = (0, decorators[i])(kind === "accessor" ? {
			get: descriptor.get,
			set: descriptor.set
		} : descriptor[key], context);
		if (kind === "accessor") {
			if (result === void 0) continue;
			if (result === null || typeof result !== "object") throw new TypeError("Object expected");
			if (_ = accept(result.get)) descriptor.get = _;
			if (_ = accept(result.set)) descriptor.set = _;
			if (_ = accept(result.init)) initializers.unshift(_);
		} else if (_ = accept(result)) if (kind === "field") initializers.unshift(_);
		else descriptor[key] = _;
	}
	if (target) Object.defineProperty(target, contextIn.name, descriptor);
	done = true;
}
function __runInitializers(thisArg, initializers, value) {
	var useValue = arguments.length > 2;
	for (var i = 0; i < initializers.length; i++) value = useValue ? initializers[i].call(thisArg, value) : initializers[i].call(thisArg);
	return useValue ? value : void 0;
}
function __propKey(x) {
	return typeof x === "symbol" ? x : "".concat(x);
}
function __setFunctionName(f, name, prefix) {
	if (typeof name === "symbol") name = name.description ? "[".concat(name.description, "]") : "";
	return Object.defineProperty(f, "name", {
		configurable: true,
		value: prefix ? "".concat(prefix, " ", name) : name
	});
}
function __metadata(metadataKey, metadataValue) {
	if (typeof Reflect === "object" && typeof Reflect.metadata === "function") return Reflect.metadata(metadataKey, metadataValue);
}
function __awaiter(thisArg, _arguments, P, generator) {
	function adopt(value) {
		return value instanceof P ? value : new P(function(resolve) {
			resolve(value);
		});
	}
	return new (P || (P = Promise))(function(resolve, reject) {
		function fulfilled(value) {
			try {
				step(generator.next(value));
			} catch (e) {
				reject(e);
			}
		}
		function rejected(value) {
			try {
				step(generator["throw"](value));
			} catch (e) {
				reject(e);
			}
		}
		function step(result) {
			result.done ? resolve(result.value) : adopt(result.value).then(fulfilled, rejected);
		}
		step((generator = generator.apply(thisArg, _arguments || [])).next());
	});
}
function __generator(thisArg, body) {
	var _ = {
		label: 0,
		sent: function() {
			if (t[0] & 1) throw t[1];
			return t[1];
		},
		trys: [],
		ops: []
	}, f, y, t, g = Object.create((typeof Iterator === "function" ? Iterator : Object).prototype);
	return g.next = verb(0), g["throw"] = verb(1), g["return"] = verb(2), typeof Symbol === "function" && (g[Symbol.iterator] = function() {
		return this;
	}), g;
	function verb(n) {
		return function(v) {
			return step([n, v]);
		};
	}
	function step(op) {
		if (f) throw new TypeError("Generator is already executing.");
		while (g && (g = 0, op[0] && (_ = 0)), _) try {
			if (f = 1, y && (t = op[0] & 2 ? y["return"] : op[0] ? y["throw"] || ((t = y["return"]) && t.call(y), 0) : y.next) && !(t = t.call(y, op[1])).done) return t;
			if (y = 0, t) op = [op[0] & 2, t.value];
			switch (op[0]) {
				case 0:
				case 1:
					t = op;
					break;
				case 4:
					_.label++;
					return {
						value: op[1],
						done: false
					};
				case 5:
					_.label++;
					y = op[1];
					op = [0];
					continue;
				case 7:
					op = _.ops.pop();
					_.trys.pop();
					continue;
				default:
					if (!(t = _.trys, t = t.length > 0 && t[t.length - 1]) && (op[0] === 6 || op[0] === 2)) {
						_ = 0;
						continue;
					}
					if (op[0] === 3 && (!t || op[1] > t[0] && op[1] < t[3])) {
						_.label = op[1];
						break;
					}
					if (op[0] === 6 && _.label < t[1]) {
						_.label = t[1];
						t = op;
						break;
					}
					if (t && _.label < t[2]) {
						_.label = t[2];
						_.ops.push(op);
						break;
					}
					if (t[2]) _.ops.pop();
					_.trys.pop();
					continue;
			}
			op = body.call(thisArg, _);
		} catch (e) {
			op = [6, e];
			y = 0;
		} finally {
			f = t = 0;
		}
		if (op[0] & 5) throw op[1];
		return {
			value: op[0] ? op[1] : void 0,
			done: true
		};
	}
}
function __exportStar(m, o) {
	for (var p in m) if (p !== "default" && !Object.prototype.hasOwnProperty.call(o, p)) __createBinding(o, m, p);
}
function __values(o) {
	var s = typeof Symbol === "function" && Symbol.iterator, m = s && o[s], i = 0;
	if (m) return m.call(o);
	if (o && typeof o.length === "number") return { next: function() {
		if (o && i >= o.length) o = void 0;
		return {
			value: o && o[i++],
			done: !o
		};
	} };
	throw new TypeError(s ? "Object is not iterable." : "Symbol.iterator is not defined.");
}
function __read(o, n) {
	var m = typeof Symbol === "function" && o[Symbol.iterator];
	if (!m) return o;
	var i = m.call(o), r, ar = [], e;
	try {
		while ((n === void 0 || n-- > 0) && !(r = i.next()).done) ar.push(r.value);
	} catch (error) {
		e = { error };
	} finally {
		try {
			if (r && !r.done && (m = i["return"])) m.call(i);
		} finally {
			if (e) throw e.error;
		}
	}
	return ar;
}
/** @deprecated */
function __spread() {
	for (var ar = [], i = 0; i < arguments.length; i++) ar = ar.concat(__read(arguments[i]));
	return ar;
}
/** @deprecated */
function __spreadArrays() {
	for (var s = 0, i = 0, il = arguments.length; i < il; i++) s += arguments[i].length;
	for (var r = Array(s), k = 0, i = 0; i < il; i++) for (var a = arguments[i], j = 0, jl = a.length; j < jl; j++, k++) r[k] = a[j];
	return r;
}
function __spreadArray(to, from, pack) {
	if (pack || arguments.length === 2) {
		for (var i = 0, l = from.length, ar; i < l; i++) if (ar || !(i in from)) {
			if (!ar) ar = Array.prototype.slice.call(from, 0, i);
			ar[i] = from[i];
		}
	}
	return to.concat(ar || Array.prototype.slice.call(from));
}
function __await(v) {
	return this instanceof __await ? (this.v = v, this) : new __await(v);
}
function __asyncGenerator(thisArg, _arguments, generator) {
	if (!Symbol.asyncIterator) throw new TypeError("Symbol.asyncIterator is not defined.");
	var g = generator.apply(thisArg, _arguments || []), i, q = [];
	return i = Object.create((typeof AsyncIterator === "function" ? AsyncIterator : Object).prototype), verb("next"), verb("throw"), verb("return", awaitReturn), i[Symbol.asyncIterator] = function() {
		return this;
	}, i;
	function awaitReturn(f) {
		return function(v) {
			return Promise.resolve(v).then(f, reject);
		};
	}
	function verb(n, f) {
		if (g[n]) {
			i[n] = function(v) {
				return new Promise(function(a, b) {
					q.push([
						n,
						v,
						a,
						b
					]) > 1 || resume(n, v);
				});
			};
			if (f) i[n] = f(i[n]);
		}
	}
	function resume(n, v) {
		try {
			step(g[n](v));
		} catch (e) {
			settle(q[0][3], e);
		}
	}
	function step(r) {
		r.value instanceof __await ? Promise.resolve(r.value.v).then(fulfill, reject) : settle(q[0][2], r);
	}
	function fulfill(value) {
		resume("next", value);
	}
	function reject(value) {
		resume("throw", value);
	}
	function settle(f, v) {
		if (f(v), q.shift(), q.length) resume(q[0][0], q[0][1]);
	}
}
function __asyncDelegator(o) {
	var i, p;
	return i = {}, verb("next"), verb("throw", function(e) {
		throw e;
	}), verb("return"), i[Symbol.iterator] = function() {
		return this;
	}, i;
	function verb(n, f) {
		i[n] = o[n] ? function(v) {
			return (p = !p) ? {
				value: __await(o[n](v)),
				done: false
			} : f ? f(v) : v;
		} : f;
	}
}
function __asyncValues(o) {
	if (!Symbol.asyncIterator) throw new TypeError("Symbol.asyncIterator is not defined.");
	var m = o[Symbol.asyncIterator], i;
	return m ? m.call(o) : (o = typeof __values === "function" ? __values(o) : o[Symbol.iterator](), i = {}, verb("next"), verb("throw"), verb("return"), i[Symbol.asyncIterator] = function() {
		return this;
	}, i);
	function verb(n) {
		i[n] = o[n] && function(v) {
			return new Promise(function(resolve, reject) {
				v = o[n](v), settle(resolve, reject, v.done, v.value);
			});
		};
	}
	function settle(resolve, reject, d, v) {
		Promise.resolve(v).then(function(v) {
			resolve({
				value: v,
				done: d
			});
		}, reject);
	}
}
function __makeTemplateObject(cooked, raw) {
	if (Object.defineProperty) Object.defineProperty(cooked, "raw", { value: raw });
	else cooked.raw = raw;
	return cooked;
}
function __importStar(mod) {
	if (mod && mod.__esModule) return mod;
	var result = {};
	if (mod != null) {
		for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
	}
	__setModuleDefault(result, mod);
	return result;
}
function __importDefault(mod) {
	return mod && mod.__esModule ? mod : { default: mod };
}
function __classPrivateFieldGet(receiver, state, kind, f) {
	if (kind === "a" && !f) throw new TypeError("Private accessor was defined without a getter");
	if (typeof state === "function" ? receiver !== state || !f : !state.has(receiver)) throw new TypeError("Cannot read private member from an object whose class did not declare it");
	return kind === "m" ? f : kind === "a" ? f.call(receiver) : f ? f.value : state.get(receiver);
}
function __classPrivateFieldSet(receiver, state, value, kind, f) {
	if (kind === "m") throw new TypeError("Private method is not writable");
	if (kind === "a" && !f) throw new TypeError("Private accessor was defined without a setter");
	if (typeof state === "function" ? receiver !== state || !f : !state.has(receiver)) throw new TypeError("Cannot write private member to an object whose class did not declare it");
	return kind === "a" ? f.call(receiver, value) : f ? f.value = value : state.set(receiver, value), value;
}
function __classPrivateFieldIn(state, receiver) {
	if (receiver === null || typeof receiver !== "object" && typeof receiver !== "function") throw new TypeError("Cannot use 'in' operator on non-object");
	return typeof state === "function" ? receiver === state : state.has(receiver);
}
function __addDisposableResource(env, value, async) {
	if (value !== null && value !== void 0) {
		if (typeof value !== "object" && typeof value !== "function") throw new TypeError("Object expected.");
		var dispose, inner;
		if (async) {
			if (!Symbol.asyncDispose) throw new TypeError("Symbol.asyncDispose is not defined.");
			dispose = value[Symbol.asyncDispose];
		}
		if (dispose === void 0) {
			if (!Symbol.dispose) throw new TypeError("Symbol.dispose is not defined.");
			dispose = value[Symbol.dispose];
			if (async) inner = dispose;
		}
		if (typeof dispose !== "function") throw new TypeError("Object not disposable.");
		if (inner) dispose = function() {
			try {
				inner.call(this);
			} catch (e) {
				return Promise.reject(e);
			}
		};
		env.stack.push({
			value,
			dispose,
			async
		});
	} else if (async) env.stack.push({ async: true });
	return value;
}
function __disposeResources(env) {
	function fail(e) {
		env.error = env.hasError ? new _SuppressedError(e, env.error, "An error was suppressed during disposal.") : e;
		env.hasError = true;
	}
	var r, s = 0;
	function next() {
		while (r = env.stack.pop()) try {
			if (!r.async && s === 1) return s = 0, env.stack.push(r), Promise.resolve().then(next);
			if (r.dispose) {
				var result = r.dispose.call(r.value);
				if (r.async) return s |= 2, Promise.resolve(result).then(next, function(e) {
					fail(e);
					return next();
				});
			} else s |= 1;
		} catch (e) {
			fail(e);
		}
		if (s === 1) return env.hasError ? Promise.reject(env.error) : Promise.resolve();
		if (env.hasError) throw env.error;
	}
	return next();
}
function __rewriteRelativeImportExtension$2(path, preserveJsx) {
	if (typeof path === "string" && /^\.\.?\//.test(path)) return path.replace(/\.(tsx)$|((?:\.d)?)((?:\.[^./]+?)?)\.([cm]?)ts$/i, function(m, tsx, d, ext, cm) {
		return tsx ? preserveJsx ? ".jsx" : ".js" : d && (!ext || !cm) ? m : d + ext + "." + cm.toLowerCase() + "js";
	});
	return path;
}
var extendStatics, __assign, __createBinding, __setModuleDefault, ownKeys, _SuppressedError, tslib_es6_default;
var init_tslib_es6 = __esmMin((() => {
	extendStatics = function(d, b) {
		extendStatics = Object.setPrototypeOf || { __proto__: [] } instanceof Array && function(d, b) {
			d.__proto__ = b;
		} || function(d, b) {
			for (var p in b) if (Object.prototype.hasOwnProperty.call(b, p)) d[p] = b[p];
		};
		return extendStatics(d, b);
	};
	__assign = function() {
		__assign = Object.assign || function __assign(t) {
			for (var s, i = 1, n = arguments.length; i < n; i++) {
				s = arguments[i];
				for (var p in s) if (Object.prototype.hasOwnProperty.call(s, p)) t[p] = s[p];
			}
			return t;
		};
		return __assign.apply(this, arguments);
	};
	__createBinding = Object.create ? (function(o, m, k, k2) {
		if (k2 === void 0) k2 = k;
		var desc = Object.getOwnPropertyDescriptor(m, k);
		if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) desc = {
			enumerable: true,
			get: function() {
				return m[k];
			}
		};
		Object.defineProperty(o, k2, desc);
	}) : (function(o, m, k, k2) {
		if (k2 === void 0) k2 = k;
		o[k2] = m[k];
	});
	__setModuleDefault = Object.create ? (function(o, v) {
		Object.defineProperty(o, "default", {
			enumerable: true,
			value: v
		});
	}) : function(o, v) {
		o["default"] = v;
	};
	ownKeys = function(o) {
		ownKeys = Object.getOwnPropertyNames || function(o) {
			var ar = [];
			for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
			return ar;
		};
		return ownKeys(o);
	};
	_SuppressedError = typeof SuppressedError === "function" ? SuppressedError : function(error, suppressed, message) {
		var e = new Error(message);
		return e.name = "SuppressedError", e.error = error, e.suppressed = suppressed, e;
	};
	tslib_es6_default = {
		__extends,
		__assign,
		__rest,
		__decorate,
		__param,
		__esDecorate,
		__runInitializers,
		__propKey,
		__setFunctionName,
		__metadata,
		__awaiter,
		__generator,
		__createBinding,
		__exportStar,
		__values,
		__read,
		__spread,
		__spreadArrays,
		__spreadArray,
		__await,
		__asyncGenerator,
		__asyncDelegator,
		__asyncValues,
		__makeTemplateObject,
		__importStar,
		__importDefault,
		__classPrivateFieldGet,
		__classPrivateFieldSet,
		__classPrivateFieldIn,
		__addDisposableResource,
		__disposeResources,
		__rewriteRelativeImportExtension: __rewriteRelativeImportExtension$2
	};
}));

//#endregion
//#region node_modules/.bun/@capacitor+core@8.3.1/node_modules/@capacitor/core/dist/index.cjs.js
/*! Capacitor: https://capacitorjs.com/ - MIT License */
var require_index_cjs = /* @__PURE__ */ __commonJSMin(((exports) => {
	Object.defineProperty(exports, "__esModule", { value: true });
	exports.ExceptionCode = void 0;
	(function(ExceptionCode) {
		/**
		* API is not implemented.
		*
		* This usually means the API can't be used because it is not implemented for
		* the current platform.
		*/
		ExceptionCode["Unimplemented"] = "UNIMPLEMENTED";
		/**
		* API is not available.
		*
		* This means the API can't be used right now because:
		*   - it is currently missing a prerequisite, such as network connectivity
		*   - it requires a particular platform or browser version
		*/
		ExceptionCode["Unavailable"] = "UNAVAILABLE";
	})(exports.ExceptionCode || (exports.ExceptionCode = {}));
	var CapacitorException = class extends Error {
		constructor(message, code, data) {
			super(message);
			this.message = message;
			this.code = code;
			this.data = data;
		}
	};
	const getPlatformId = (win) => {
		var _a, _b;
		if (win === null || win === void 0 ? void 0 : win.androidBridge) return "android";
		else if ((_b = (_a = win === null || win === void 0 ? void 0 : win.webkit) === null || _a === void 0 ? void 0 : _a.messageHandlers) === null || _b === void 0 ? void 0 : _b.bridge) return "ios";
		else return "web";
	};
	const createCapacitor = (win) => {
		const capCustomPlatform = win.CapacitorCustomPlatform || null;
		const cap = win.Capacitor || {};
		const Plugins = cap.Plugins = cap.Plugins || {};
		const getPlatform = () => {
			return capCustomPlatform !== null ? capCustomPlatform.name : getPlatformId(win);
		};
		const isNativePlatform = () => getPlatform() !== "web";
		const isPluginAvailable = (pluginName) => {
			const plugin = registeredPlugins.get(pluginName);
			if (plugin === null || plugin === void 0 ? void 0 : plugin.platforms.has(getPlatform())) return true;
			if (getPluginHeader(pluginName)) return true;
			return false;
		};
		const getPluginHeader = (pluginName) => {
			var _a;
			return (_a = cap.PluginHeaders) === null || _a === void 0 ? void 0 : _a.find((h) => h.name === pluginName);
		};
		const handleError = (err) => win.console.error(err);
		const registeredPlugins = /* @__PURE__ */ new Map();
		const registerPlugin = (pluginName, jsImplementations = {}) => {
			const registeredPlugin = registeredPlugins.get(pluginName);
			if (registeredPlugin) {
				console.warn(`Capacitor plugin "${pluginName}" already registered. Cannot register plugins twice.`);
				return registeredPlugin.proxy;
			}
			const platform = getPlatform();
			const pluginHeader = getPluginHeader(pluginName);
			let jsImplementation;
			const loadPluginImplementation = async () => {
				if (!jsImplementation && platform in jsImplementations) jsImplementation = typeof jsImplementations[platform] === "function" ? jsImplementation = await jsImplementations[platform]() : jsImplementation = jsImplementations[platform];
				else if (capCustomPlatform !== null && !jsImplementation && "web" in jsImplementations) jsImplementation = typeof jsImplementations["web"] === "function" ? jsImplementation = await jsImplementations["web"]() : jsImplementation = jsImplementations["web"];
				return jsImplementation;
			};
			const createPluginMethod = (impl, prop) => {
				var _a, _b;
				if (pluginHeader) {
					const methodHeader = pluginHeader === null || pluginHeader === void 0 ? void 0 : pluginHeader.methods.find((m) => prop === m.name);
					if (methodHeader) if (methodHeader.rtype === "promise") return (options) => cap.nativePromise(pluginName, prop.toString(), options);
					else return (options, callback) => cap.nativeCallback(pluginName, prop.toString(), options, callback);
					else if (impl) return (_a = impl[prop]) === null || _a === void 0 ? void 0 : _a.bind(impl);
				} else if (impl) return (_b = impl[prop]) === null || _b === void 0 ? void 0 : _b.bind(impl);
				else throw new CapacitorException(`"${pluginName}" plugin is not implemented on ${platform}`, exports.ExceptionCode.Unimplemented);
			};
			const createPluginMethodWrapper = (prop) => {
				let remove;
				const wrapper = (...args) => {
					const p = loadPluginImplementation().then((impl) => {
						const fn = createPluginMethod(impl, prop);
						if (fn) {
							const p = fn(...args);
							remove = p === null || p === void 0 ? void 0 : p.remove;
							return p;
						} else throw new CapacitorException(`"${pluginName}.${prop}()" is not implemented on ${platform}`, exports.ExceptionCode.Unimplemented);
					});
					if (prop === "addListener") p.remove = async () => remove();
					return p;
				};
				wrapper.toString = () => `${prop.toString()}() { [capacitor code] }`;
				Object.defineProperty(wrapper, "name", {
					value: prop,
					writable: false,
					configurable: false
				});
				return wrapper;
			};
			const addListener = createPluginMethodWrapper("addListener");
			const removeListener = createPluginMethodWrapper("removeListener");
			const addListenerNative = (eventName, callback) => {
				const call = addListener({ eventName }, callback);
				const remove = async () => {
					removeListener({
						eventName,
						callbackId: await call
					}, callback);
				};
				const p = new Promise((resolve) => call.then(() => resolve({ remove })));
				p.remove = async () => {
					console.warn(`Using addListener() without 'await' is deprecated.`);
					await remove();
				};
				return p;
			};
			const proxy = new Proxy({}, { get(_, prop) {
				switch (prop) {
					case "$$typeof": return;
					case "toJSON": return () => ({});
					case "addListener": return pluginHeader ? addListenerNative : addListener;
					case "removeListener": return removeListener;
					default: return createPluginMethodWrapper(prop);
				}
			} });
			Plugins[pluginName] = proxy;
			registeredPlugins.set(pluginName, {
				name: pluginName,
				proxy,
				platforms: new Set([...Object.keys(jsImplementations), ...pluginHeader ? [platform] : []])
			});
			return proxy;
		};
		if (!cap.convertFileSrc) cap.convertFileSrc = (filePath) => filePath;
		cap.getPlatform = getPlatform;
		cap.handleError = handleError;
		cap.isNativePlatform = isNativePlatform;
		cap.isPluginAvailable = isPluginAvailable;
		cap.registerPlugin = registerPlugin;
		cap.Exception = CapacitorException;
		cap.DEBUG = !!cap.DEBUG;
		cap.isLoggingEnabled = !!cap.isLoggingEnabled;
		return cap;
	};
	const initCapacitorGlobal = (win) => win.Capacitor = createCapacitor(win);
	const Capacitor = /* @__PURE__ */ initCapacitorGlobal(typeof globalThis !== "undefined" ? globalThis : typeof self !== "undefined" ? self : typeof window !== "undefined" ? window : typeof global !== "undefined" ? global : {});
	const registerPlugin = Capacitor.registerPlugin;
	/**
	* Base class web plugins should extend.
	*/
	var WebPlugin = class {
		constructor() {
			this.listeners = {};
			this.retainedEventArguments = {};
			this.windowListeners = {};
		}
		addListener(eventName, listenerFunc) {
			let firstListener = false;
			if (!this.listeners[eventName]) {
				this.listeners[eventName] = [];
				firstListener = true;
			}
			this.listeners[eventName].push(listenerFunc);
			const windowListener = this.windowListeners[eventName];
			if (windowListener && !windowListener.registered) this.addWindowListener(windowListener);
			if (firstListener) this.sendRetainedArgumentsForEvent(eventName);
			const remove = async () => this.removeListener(eventName, listenerFunc);
			return Promise.resolve({ remove });
		}
		async removeAllListeners() {
			this.listeners = {};
			for (const listener in this.windowListeners) this.removeWindowListener(this.windowListeners[listener]);
			this.windowListeners = {};
		}
		notifyListeners(eventName, data, retainUntilConsumed) {
			const listeners = this.listeners[eventName];
			if (!listeners) {
				if (retainUntilConsumed) {
					let args = this.retainedEventArguments[eventName];
					if (!args) args = [];
					args.push(data);
					this.retainedEventArguments[eventName] = args;
				}
				return;
			}
			listeners.forEach((listener) => listener(data));
		}
		hasListeners(eventName) {
			var _a;
			return !!((_a = this.listeners[eventName]) === null || _a === void 0 ? void 0 : _a.length);
		}
		registerWindowListener(windowEventName, pluginEventName) {
			this.windowListeners[pluginEventName] = {
				registered: false,
				windowEventName,
				pluginEventName,
				handler: (event) => {
					this.notifyListeners(pluginEventName, event);
				}
			};
		}
		unimplemented(msg = "not implemented") {
			return new Capacitor.Exception(msg, exports.ExceptionCode.Unimplemented);
		}
		unavailable(msg = "not available") {
			return new Capacitor.Exception(msg, exports.ExceptionCode.Unavailable);
		}
		async removeListener(eventName, listenerFunc) {
			const listeners = this.listeners[eventName];
			if (!listeners) return;
			const index = listeners.indexOf(listenerFunc);
			this.listeners[eventName].splice(index, 1);
			if (!this.listeners[eventName].length) this.removeWindowListener(this.windowListeners[eventName]);
		}
		addWindowListener(handle) {
			window.addEventListener(handle.windowEventName, handle.handler);
			handle.registered = true;
		}
		removeWindowListener(handle) {
			if (!handle) return;
			window.removeEventListener(handle.windowEventName, handle.handler);
			handle.registered = false;
		}
		sendRetainedArgumentsForEvent(eventName) {
			const args = this.retainedEventArguments[eventName];
			if (!args) return;
			delete this.retainedEventArguments[eventName];
			args.forEach((arg) => {
				this.notifyListeners(eventName, arg);
			});
		}
	};
	const WebView = /* @__PURE__ */ registerPlugin("WebView");
	/******** END WEB VIEW PLUGIN ********/
	/******** COOKIES PLUGIN ********/
	/**
	* Safely web encode a string value (inspired by js-cookie)
	* @param str The string value to encode
	*/
	const encode = (str) => encodeURIComponent(str).replace(/%(2[346B]|5E|60|7C)/g, decodeURIComponent).replace(/[()]/g, escape);
	/**
	* Safely web decode a string value (inspired by js-cookie)
	* @param str The string value to decode
	*/
	const decode = (str) => str.replace(/(%[\dA-F]{2})+/gi, decodeURIComponent);
	var CapacitorCookiesPluginWeb = class extends WebPlugin {
		async getCookies() {
			const cookies = document.cookie;
			const cookieMap = {};
			cookies.split(";").forEach((cookie) => {
				if (cookie.length <= 0) return;
				let [key, value] = cookie.replace(/=/, "CAP_COOKIE").split("CAP_COOKIE");
				key = decode(key).trim();
				value = decode(value).trim();
				cookieMap[key] = value;
			});
			return cookieMap;
		}
		async setCookie(options) {
			try {
				const encodedKey = encode(options.key);
				const encodedValue = encode(options.value);
				const expires = options.expires ? `; expires=${options.expires.replace("expires=", "")}` : "";
				const path = (options.path || "/").replace("path=", "");
				const domain = options.url != null && options.url.length > 0 ? `domain=${options.url}` : "";
				document.cookie = `${encodedKey}=${encodedValue || ""}${expires}; path=${path}; ${domain};`;
			} catch (error) {
				return Promise.reject(error);
			}
		}
		async deleteCookie(options) {
			try {
				document.cookie = `${options.key}=; Max-Age=0`;
			} catch (error) {
				return Promise.reject(error);
			}
		}
		async clearCookies() {
			try {
				const cookies = document.cookie.split(";") || [];
				for (const cookie of cookies) document.cookie = cookie.replace(/^ +/, "").replace(/=.*/, `=;expires=${(/* @__PURE__ */ new Date()).toUTCString()};path=/`);
			} catch (error) {
				return Promise.reject(error);
			}
		}
		async clearAllCookies() {
			try {
				await this.clearCookies();
			} catch (error) {
				return Promise.reject(error);
			}
		}
	};
	const CapacitorCookies = registerPlugin("CapacitorCookies", { web: () => new CapacitorCookiesPluginWeb() });
	/**
	* Read in a Blob value and return it as a base64 string
	* @param blob The blob value to convert to a base64 string
	*/
	const readBlobAsBase64 = async (blob) => new Promise((resolve, reject) => {
		const reader = new FileReader();
		reader.onload = () => {
			const base64String = reader.result;
			resolve(base64String.indexOf(",") >= 0 ? base64String.split(",")[1] : base64String);
		};
		reader.onerror = (error) => reject(error);
		reader.readAsDataURL(blob);
	});
	/**
	* Normalize an HttpHeaders map by lowercasing all of the values
	* @param headers The HttpHeaders object to normalize
	*/
	const normalizeHttpHeaders = (headers = {}) => {
		const originalKeys = Object.keys(headers);
		return Object.keys(headers).map((k) => k.toLocaleLowerCase()).reduce((acc, key, index) => {
			acc[key] = headers[originalKeys[index]];
			return acc;
		}, {});
	};
	/**
	* Builds a string of url parameters that
	* @param params A map of url parameters
	* @param shouldEncode true if you should encodeURIComponent() the values (true by default)
	*/
	const buildUrlParams = (params, shouldEncode = true) => {
		if (!params) return null;
		return Object.entries(params).reduce((accumulator, entry) => {
			const [key, value] = entry;
			let encodedValue;
			let item;
			if (Array.isArray(value)) {
				item = "";
				value.forEach((str) => {
					encodedValue = shouldEncode ? encodeURIComponent(str) : str;
					item += `${key}=${encodedValue}&`;
				});
				item.slice(0, -1);
			} else {
				encodedValue = shouldEncode ? encodeURIComponent(value) : value;
				item = `${key}=${encodedValue}`;
			}
			return `${accumulator}&${item}`;
		}, "").substr(1);
	};
	/**
	* Build the RequestInit object based on the options passed into the initial request
	* @param options The Http plugin options
	* @param extra Any extra RequestInit values
	*/
	const buildRequestInit = (options, extra = {}) => {
		const output = Object.assign({
			method: options.method || "GET",
			headers: options.headers
		}, extra);
		const type = normalizeHttpHeaders(options.headers)["content-type"] || "";
		if (typeof options.data === "string") output.body = options.data;
		else if (type.includes("application/x-www-form-urlencoded")) {
			const params = new URLSearchParams();
			for (const [key, value] of Object.entries(options.data || {})) params.set(key, value);
			output.body = params.toString();
		} else if (type.includes("multipart/form-data") || options.data instanceof FormData) {
			const form = new FormData();
			if (options.data instanceof FormData) options.data.forEach((value, key) => {
				form.append(key, value);
			});
			else for (const key of Object.keys(options.data)) form.append(key, options.data[key]);
			output.body = form;
			const headers = new Headers(output.headers);
			headers.delete("content-type");
			output.headers = headers;
		} else if (type.includes("application/json") || typeof options.data === "object") output.body = JSON.stringify(options.data);
		return output;
	};
	var CapacitorHttpPluginWeb = class extends WebPlugin {
		/**
		* Perform an Http request given a set of options
		* @param options Options to build the HTTP request
		*/
		async request(options) {
			const requestInit = buildRequestInit(options, options.webFetchExtra);
			const urlParams = buildUrlParams(options.params, options.shouldEncodeUrlParams);
			const url = urlParams ? `${options.url}?${urlParams}` : options.url;
			const response = await fetch(url, requestInit);
			const contentType = response.headers.get("content-type") || "";
			let { responseType = "text" } = response.ok ? options : {};
			if (contentType.includes("application/json")) responseType = "json";
			let data;
			let blob;
			switch (responseType) {
				case "arraybuffer":
				case "blob":
					blob = await response.blob();
					data = await readBlobAsBase64(blob);
					break;
				case "json":
					data = await response.json();
					break;
				default: data = await response.text();
			}
			const headers = {};
			response.headers.forEach((value, key) => {
				headers[key] = value;
			});
			return {
				data,
				headers,
				status: response.status,
				url: response.url
			};
		}
		/**
		* Perform an Http GET request given a set of options
		* @param options Options to build the HTTP request
		*/
		async get(options) {
			return this.request(Object.assign(Object.assign({}, options), { method: "GET" }));
		}
		/**
		* Perform an Http POST request given a set of options
		* @param options Options to build the HTTP request
		*/
		async post(options) {
			return this.request(Object.assign(Object.assign({}, options), { method: "POST" }));
		}
		/**
		* Perform an Http PUT request given a set of options
		* @param options Options to build the HTTP request
		*/
		async put(options) {
			return this.request(Object.assign(Object.assign({}, options), { method: "PUT" }));
		}
		/**
		* Perform an Http PATCH request given a set of options
		* @param options Options to build the HTTP request
		*/
		async patch(options) {
			return this.request(Object.assign(Object.assign({}, options), { method: "PATCH" }));
		}
		/**
		* Perform an Http DELETE request given a set of options
		* @param options Options to build the HTTP request
		*/
		async delete(options) {
			return this.request(Object.assign(Object.assign({}, options), { method: "DELETE" }));
		}
	};
	const CapacitorHttp = registerPlugin("CapacitorHttp", { web: () => new CapacitorHttpPluginWeb() });
	/******** END HTTP PLUGIN ********/
	/******** SYSTEM BARS PLUGIN ********/
	/**
	* Available status bar styles.
	*/
	exports.SystemBarsStyle = void 0;
	(function(SystemBarsStyle) {
		/**
		* Light system bar content on a dark background.
		*
		* @since 8.0.0
		*/
		SystemBarsStyle["Dark"] = "DARK";
		/**
		* For dark system bar content on a light background.
		*
		* @since 8.0.0
		*/
		SystemBarsStyle["Light"] = "LIGHT";
		/**
		* The style is based on the device appearance or the underlying content.
		* If the device is using Dark mode, the system bars content will be light.
		* If the device is using Light mode, the system bars content will be dark.
		*
		* @since 8.0.0
		*/
		SystemBarsStyle["Default"] = "DEFAULT";
	})(exports.SystemBarsStyle || (exports.SystemBarsStyle = {}));
	/**
	* Available system bar types.
	*/
	exports.SystemBarType = void 0;
	(function(SystemBarType) {
		/**
		* The top status bar on both Android and iOS.
		*
		* @since 8.0.0
		*/
		SystemBarType["StatusBar"] = "StatusBar";
		/**
		* The navigation bar (or gesture bar on iOS) on both Android and iOS.
		*
		* @since 8.0.0
		*/
		SystemBarType["NavigationBar"] = "NavigationBar";
	})(exports.SystemBarType || (exports.SystemBarType = {}));
	var SystemBarsPluginWeb = class extends WebPlugin {
		async setStyle() {
			this.unavailable("not available for web");
		}
		async setAnimation() {
			this.unavailable("not available for web");
		}
		async show() {
			this.unavailable("not available for web");
		}
		async hide() {
			this.unavailable("not available for web");
		}
	};
	const SystemBars = registerPlugin("SystemBars", { web: () => new SystemBarsPluginWeb() });
	/******** END SYSTEM BARS PLUGIN ********/
	exports.Capacitor = Capacitor;
	exports.CapacitorCookies = CapacitorCookies;
	exports.CapacitorException = CapacitorException;
	exports.CapacitorHttp = CapacitorHttp;
	exports.SystemBars = SystemBars;
	exports.WebPlugin = WebPlugin;
	exports.WebView = WebView;
	exports.buildRequestInit = buildRequestInit;
	exports.registerPlugin = registerPlugin;
}));

//#endregion
//#region node_modules/.bun/llama-cpp-capacitor@0.1.5+2a604cb248d57ff2/node_modules/llama-cpp-capacitor/dist/plugin.cjs.js
var require_plugin_cjs = /* @__PURE__ */ __commonJSMin(((exports) => {
	var tslib = (init_tslib_es6(), __toCommonJS(tslib_es6_exports));
	var core = require_index_cjs();
	var _a, _b, _c;
	const LLAMACPP_MTMD_DEFAULT_MEDIA_MARKER = "<__media__>";
	const EVENT_ON_INIT_CONTEXT_PROGRESS = "@LlamaCpp_onInitContextProgress";
	const EVENT_ON_TOKEN = "@LlamaCpp_onToken";
	const EVENT_ON_NATIVE_LOG = "@LlamaCpp_onNativeLog";
	const LlamaCpp = core.registerPlugin("LlamaCpp");
	const logListeners = [];
	LlamaCpp.addListener(EVENT_ON_NATIVE_LOG, (evt) => {
		logListeners.forEach((listener) => listener(evt.level, evt.text));
	});
	(_c = (_b = (_a = LlamaCpp === null || LlamaCpp === void 0 ? void 0 : LlamaCpp.toggleNativeLog) === null || _a === void 0 ? void 0 : _a.call(LlamaCpp, { enabled: false })) === null || _b === void 0 ? void 0 : _b.catch) === null || _c === void 0 || _c.call(_b, () => {});
	const RNLLAMA_MTMD_DEFAULT_MEDIA_MARKER = LLAMACPP_MTMD_DEFAULT_MEDIA_MARKER;
	const validCacheTypes = [
		"f16",
		"f32",
		"bf16",
		"q8_0",
		"q4_0",
		"q4_1",
		"iq4_nl",
		"q5_0",
		"q5_1"
	];
	const getJsonSchema = (responseFormat) => {
		var _a;
		if ((responseFormat === null || responseFormat === void 0 ? void 0 : responseFormat.type) === "json_schema") return (_a = responseFormat.json_schema) === null || _a === void 0 ? void 0 : _a.schema;
		if ((responseFormat === null || responseFormat === void 0 ? void 0 : responseFormat.type) === "json_object") return responseFormat.schema || {};
		return null;
	};
	const jsonSchemaToGrammar = async (schema) => {
		try {
			return await LlamaCpp.convertJsonSchemaToGrammar({ schema: JSON.stringify(schema) });
		} catch (error) {
			console.warn("Failed to convert JSON schema to GBNF, using fallback:", error);
			return `root ::= "{" ws object_content ws "}"
object_content ::= string_field ("," ws string_field)*
string_field ::= "\\"" [a-zA-Z_][a-zA-Z0-9_]* "\\"" ws ":" ws value
value ::= string | number | boolean | "null"
string ::= "\\"" [^"]* "\\""
number ::= "-"? [0-9]+ ("." [0-9]+)?
boolean ::= "true" | "false"
ws ::= [ \\t\\n]*`;
		}
	};
	var LlamaContext = class {
		constructor({ contextId, gpu, reasonNoGPU, model }) {
			this.gpu = false;
			this.reasonNoGPU = "";
			this.id = contextId;
			this.gpu = gpu;
			this.reasonNoGPU = reasonNoGPU;
			this.model = model;
		}
		/**
		* Load cached prompt & completion state from a file.
		*/
		async loadSession(filepath) {
			let path = filepath;
			if (path.startsWith("file://")) path = path.slice(7);
			return LlamaCpp.loadSession({
				contextId: this.id,
				filepath: path
			});
		}
		/**
		* Save current cached prompt & completion state to a file.
		*/
		async saveSession(filepath, options) {
			return LlamaCpp.saveSession({
				contextId: this.id,
				filepath,
				size: (options === null || options === void 0 ? void 0 : options.tokenSize) || -1
			});
		}
		isLlamaChatSupported() {
			return !!this.model.chatTemplates.llamaChat;
		}
		isJinjaSupported() {
			const { minja } = this.model.chatTemplates;
			return !!(minja === null || minja === void 0 ? void 0 : minja.toolUse) || !!(minja === null || minja === void 0 ? void 0 : minja.default);
		}
		async getFormattedChat(messages, template, params) {
			var _a;
			const mediaPaths = [];
			const chat = messages.map((msg) => {
				if (Array.isArray(msg.content)) {
					const content = msg.content.map((part) => {
						var _a;
						if (part.type === "image_url") {
							let path = ((_a = part.image_url) === null || _a === void 0 ? void 0 : _a.url) || "";
							if (path === null || path === void 0 ? void 0 : path.startsWith("file://")) path = path.slice(7);
							mediaPaths.push(path);
							return {
								type: "text",
								text: RNLLAMA_MTMD_DEFAULT_MEDIA_MARKER
							};
						} else if (part.type === "input_audio") {
							const { input_audio: audio } = part;
							if (!audio) throw new Error("input_audio is required");
							const { format } = audio;
							if (format != "wav" && format != "mp3") throw new Error(`Unsupported audio format: ${format}`);
							if (audio.url) {
								const path = audio.url.replace(/file:\/\//, "");
								mediaPaths.push(path);
							} else if (audio.data) mediaPaths.push(audio.data);
							return {
								type: "text",
								text: RNLLAMA_MTMD_DEFAULT_MEDIA_MARKER
							};
						}
						return part;
					});
					return Object.assign(Object.assign({}, msg), { content });
				}
				return msg;
			});
			const useJinja = this.isJinjaSupported() && (params === null || params === void 0 ? void 0 : params.jinja);
			let tmpl;
			if (template) tmpl = template;
			const jsonSchema = getJsonSchema(params === null || params === void 0 ? void 0 : params.response_format);
			const result = await LlamaCpp.getFormattedChat({
				contextId: this.id,
				messages: JSON.stringify(chat),
				chatTemplate: tmpl,
				params: {
					jinja: useJinja,
					json_schema: jsonSchema ? JSON.stringify(jsonSchema) : void 0,
					tools: (params === null || params === void 0 ? void 0 : params.tools) ? JSON.stringify(params.tools) : void 0,
					parallel_tool_calls: (params === null || params === void 0 ? void 0 : params.parallel_tool_calls) ? JSON.stringify(params.parallel_tool_calls) : void 0,
					tool_choice: params === null || params === void 0 ? void 0 : params.tool_choice,
					enable_thinking: (_a = params === null || params === void 0 ? void 0 : params.enable_thinking) !== null && _a !== void 0 ? _a : true,
					add_generation_prompt: params === null || params === void 0 ? void 0 : params.add_generation_prompt,
					now: typeof (params === null || params === void 0 ? void 0 : params.now) === "number" ? params.now.toString() : params === null || params === void 0 ? void 0 : params.now,
					chat_template_kwargs: (params === null || params === void 0 ? void 0 : params.chat_template_kwargs) ? JSON.stringify(Object.entries(params.chat_template_kwargs).reduce((acc, [key, value]) => {
						acc[key] = JSON.stringify(value);
						return acc;
					}, {})) : void 0
				}
			});
			if (!useJinja) return {
				type: "llama-chat",
				prompt: result,
				has_media: mediaPaths.length > 0,
				media_paths: mediaPaths
			};
			const jinjaResult = result;
			jinjaResult.type = "jinja";
			jinjaResult.has_media = mediaPaths.length > 0;
			jinjaResult.media_paths = mediaPaths;
			return jinjaResult;
		}
		/**
		* Generate a completion based on the provided parameters
		* @param params Completion parameters including prompt or messages
		* @param callback Optional callback for token-by-token streaming
		* @returns Promise resolving to the completion result
		*
		* Note: For multimodal support, you can include an media_paths parameter.
		* This will process the images and add them to the context before generating text.
		* Multimodal support must be enabled via initMultimodal() first.
		*/
		async completion(params, callback) {
			const nativeParams = Object.assign(Object.assign({}, params), {
				prompt: params.prompt || "",
				emit_partial_completion: !!callback
			});
			if (params.messages) {
				const formattedResult = await this.getFormattedChat(params.messages, params.chat_template || params.chatTemplate, {
					jinja: params.jinja,
					tools: params.tools,
					parallel_tool_calls: params.parallel_tool_calls,
					tool_choice: params.tool_choice,
					enable_thinking: params.enable_thinking,
					add_generation_prompt: params.add_generation_prompt,
					now: params.now,
					chat_template_kwargs: params.chat_template_kwargs
				});
				if (formattedResult.type === "jinja") {
					const jinjaResult = formattedResult;
					nativeParams.prompt = jinjaResult.prompt || "";
					if (typeof jinjaResult.chat_format === "number") nativeParams.chat_format = jinjaResult.chat_format;
					if (jinjaResult.grammar) nativeParams.grammar = jinjaResult.grammar;
					if (typeof jinjaResult.grammar_lazy === "boolean") nativeParams.grammar_lazy = jinjaResult.grammar_lazy;
					if (jinjaResult.grammar_triggers) nativeParams.grammar_triggers = jinjaResult.grammar_triggers;
					if (jinjaResult.preserved_tokens) nativeParams.preserved_tokens = jinjaResult.preserved_tokens;
					if (jinjaResult.additional_stops) {
						if (!nativeParams.stop) nativeParams.stop = [];
						nativeParams.stop.push(...jinjaResult.additional_stops);
					}
					if (jinjaResult.has_media) nativeParams.media_paths = jinjaResult.media_paths;
				} else if (formattedResult.type === "llama-chat") {
					const llamaChatResult = formattedResult;
					nativeParams.prompt = llamaChatResult.prompt || "";
					if (llamaChatResult.has_media) nativeParams.media_paths = llamaChatResult.media_paths;
				}
			} else nativeParams.prompt = params.prompt || "";
			if (!nativeParams.media_paths && params.media_paths) nativeParams.media_paths = params.media_paths;
			if (params.grammar) nativeParams.grammar = params.grammar;
			else if (nativeParams.response_format && !nativeParams.grammar) {
				const jsonSchema = getJsonSchema(params.response_format);
				if (jsonSchema) try {
					nativeParams.grammar = await jsonSchemaToGrammar(jsonSchema);
				} catch (error) {
					console.warn("Failed to convert JSON schema to grammar, falling back to json_schema parameter:", error);
					nativeParams.json_schema = JSON.stringify(jsonSchema);
				}
			}
			let tokenListener = callback && LlamaCpp.addListener(EVENT_ON_TOKEN, (evt) => {
				const { contextId, tokenResult } = evt;
				if (contextId !== this.id) return;
				callback(tokenResult);
			});
			if (!nativeParams.prompt) throw new Error("Prompt is required");
			return LlamaCpp.completion({
				contextId: this.id,
				params: nativeParams
			}).then((completionResult) => {
				tokenListener === null || tokenListener === void 0 || tokenListener.remove();
				tokenListener = null;
				return completionResult;
			}).catch((err) => {
				tokenListener === null || tokenListener === void 0 || tokenListener.remove();
				tokenListener = null;
				throw err;
			});
		}
		stopCompletion() {
			return LlamaCpp.stopCompletion({ contextId: this.id });
		}
		/**
		* Tokenize text or text with images
		* @param text Text to tokenize
		* @param params.media_paths Array of image paths to tokenize (if multimodal is enabled)
		* @returns Promise resolving to the tokenize result
		*/
		tokenize(text, { media_paths: mediaPaths } = {}) {
			return LlamaCpp.tokenize({
				contextId: this.id,
				text,
				imagePaths: mediaPaths
			});
		}
		detokenize(tokens) {
			return LlamaCpp.detokenize({
				contextId: this.id,
				tokens
			});
		}
		embedding(text, params) {
			return LlamaCpp.embedding({
				contextId: this.id,
				text,
				params: params || {}
			});
		}
		/**
		* Rerank documents based on relevance to a query
		* @param query The query text to rank documents against
		* @param documents Array of document texts to rank
		* @param params Optional reranking parameters
		* @returns Promise resolving to an array of ranking results with scores and indices
		*/
		async rerank(query, documents, params) {
			return (await LlamaCpp.rerank({
				contextId: this.id,
				query,
				documents,
				params: params || {}
			})).map((result) => Object.assign(Object.assign({}, result), { document: documents[result.index] })).sort((a, b) => b.score - a.score);
		}
		async bench(pp, tg, pl, nr) {
			const result = await LlamaCpp.bench({
				contextId: this.id,
				pp,
				tg,
				pl,
				nr
			});
			const [modelDesc, modelSize, modelNParams, ppAvg, ppStd, tgAvg, tgStd] = JSON.parse(result);
			return {
				modelDesc,
				modelSize,
				modelNParams,
				ppAvg,
				ppStd,
				tgAvg,
				tgStd
			};
		}
		async applyLoraAdapters(loraList) {
			let loraAdapters = [];
			if (loraList) loraAdapters = loraList.map((l) => ({
				path: l.path.replace(/file:\/\//, ""),
				scaled: l.scaled
			}));
			return LlamaCpp.applyLoraAdapters({
				contextId: this.id,
				loraAdapters
			});
		}
		async removeLoraAdapters() {
			return LlamaCpp.removeLoraAdapters({ contextId: this.id });
		}
		async getLoadedLoraAdapters() {
			return LlamaCpp.getLoadedLoraAdapters({ contextId: this.id });
		}
		/**
		* Initialize multimodal support with a mmproj file
		* @param params Parameters for multimodal support
		* @param params.path Path to the multimodal projector file
		* @param params.use_gpu Whether to use GPU
		* @returns Promise resolving to true if initialization was successful
		*/
		async initMultimodal({ path, use_gpu: useGpu }) {
			if (path.startsWith("file://")) path = path.slice(7);
			return LlamaCpp.initMultimodal({
				contextId: this.id,
				params: {
					path,
					use_gpu: useGpu !== null && useGpu !== void 0 ? useGpu : true
				}
			});
		}
		/**
		* Check if multimodal support is enabled
		* @returns Promise resolving to true if multimodal is enabled
		*/
		async isMultimodalEnabled() {
			return await LlamaCpp.isMultimodalEnabled({ contextId: this.id });
		}
		/**
		* Check multimodal support
		* @returns Promise resolving to an object with vision and audio support
		*/
		async getMultimodalSupport() {
			return await LlamaCpp.getMultimodalSupport({ contextId: this.id });
		}
		/**
		* Release multimodal support
		* @returns Promise resolving to void
		*/
		async releaseMultimodal() {
			return await LlamaCpp.releaseMultimodal({ contextId: this.id });
		}
		/**
		* Initialize TTS support with a vocoder model
		* @param params Parameters for TTS support
		* @param params.path Path to the vocoder model
		* @param params.n_batch Batch size for the vocoder model
		* @returns Promise resolving to true if initialization was successful
		*/
		async initVocoder({ path, n_batch: nBatch }) {
			if (path.startsWith("file://")) path = path.slice(7);
			return await LlamaCpp.initVocoder({
				contextId: this.id,
				params: {
					path,
					n_batch: nBatch
				}
			});
		}
		/**
		* Check if TTS support is enabled
		* @returns Promise resolving to true if TTS is enabled
		*/
		async isVocoderEnabled() {
			return await LlamaCpp.isVocoderEnabled({ contextId: this.id });
		}
		/**
		* Get a formatted audio completion prompt
		* @param speakerJsonStr JSON string representing the speaker
		* @param textToSpeak Text to speak
		* @returns Promise resolving to the formatted audio completion result with prompt and grammar
		*/
		async getFormattedAudioCompletion(speaker, textToSpeak) {
			return await LlamaCpp.getFormattedAudioCompletion({
				contextId: this.id,
				speakerJsonStr: speaker ? JSON.stringify(speaker) : "",
				textToSpeak
			});
		}
		/**
		* Get guide tokens for audio completion
		* @param textToSpeak Text to speak
		* @returns Promise resolving to the guide tokens
		*/
		async getAudioCompletionGuideTokens(textToSpeak) {
			return await LlamaCpp.getAudioCompletionGuideTokens({
				contextId: this.id,
				textToSpeak
			});
		}
		/**
		* Decode audio tokens
		* @param tokens Array of audio tokens
		* @returns Promise resolving to the decoded audio tokens
		*/
		async decodeAudioTokens(tokens) {
			return await LlamaCpp.decodeAudioTokens({
				contextId: this.id,
				tokens
			});
		}
		/**
		* Release TTS support
		* @returns Promise resolving to void
		*/
		async releaseVocoder() {
			return await LlamaCpp.releaseVocoder({ contextId: this.id });
		}
		async release() {
			return LlamaCpp.releaseContext({ contextId: this.id });
		}
	};
	async function toggleNativeLog(enabled) {
		return LlamaCpp.toggleNativeLog({ enabled });
	}
	function addNativeLogListener(listener) {
		logListeners.push(listener);
		return { remove: () => {
			logListeners.splice(logListeners.indexOf(listener), 1);
		} };
	}
	async function setContextLimit(limit) {
		return LlamaCpp.setContextLimit({ limit });
	}
	let contextIdCounter = 0;
	const contextIdRandom = () => Math.floor(Math.random() * 1e5);
	const modelInfoSkip = [
		"tokenizer.ggml.tokens",
		"tokenizer.ggml.token_type",
		"tokenizer.ggml.merges",
		"tokenizer.ggml.scores"
	];
	async function loadLlamaModelInfo(model) {
		let path = model;
		if (path.startsWith("file://")) path = path.slice(7);
		return LlamaCpp.modelInfo({
			path,
			skip: modelInfoSkip
		});
	}
	const poolTypeMap = {
		none: 0,
		mean: 1,
		cls: 2,
		last: 3,
		rank: 4
	};
	async function initLlama(_a, onProgress) {
		var { model, is_model_asset: isModelAsset, pooling_type: poolingType, lora, lora_list: loraList } = _a, rest = tslib.__rest(_a, [
			"model",
			"is_model_asset",
			"pooling_type",
			"lora",
			"lora_list"
		]);
		let path = model;
		if (path.startsWith("file://")) path = path.slice(7);
		let loraPath = lora;
		if (loraPath === null || loraPath === void 0 ? void 0 : loraPath.startsWith("file://")) loraPath = loraPath.slice(7);
		let loraAdapters = [];
		if (loraList) loraAdapters = loraList.map((l) => ({
			path: l.path.replace(/file:\/\//, ""),
			scaled: l.scaled
		}));
		const contextId = contextIdCounter + contextIdRandom();
		contextIdCounter += 1;
		let removeProgressListener = null;
		if (onProgress) removeProgressListener = LlamaCpp.addListener(EVENT_ON_INIT_CONTEXT_PROGRESS, (evt) => {
			if (evt.contextId !== contextId) return;
			onProgress(evt.progress);
		});
		const poolType = poolTypeMap[poolingType];
		if (rest.cache_type_k && !validCacheTypes.includes(rest.cache_type_k)) {
			console.warn(`[LlamaCpp] initLlama: Invalid cache K type: ${rest.cache_type_k}, falling back to f16`);
			delete rest.cache_type_k;
		}
		if (rest.cache_type_v && !validCacheTypes.includes(rest.cache_type_v)) {
			console.warn(`[LlamaCpp] initLlama: Invalid cache V type: ${rest.cache_type_v}, falling back to f16`);
			delete rest.cache_type_v;
		}
		if (rest.draft_model) console.log(`🚀 Initializing with speculative decoding:
      - Main model: ${path}
      - Draft model: ${rest.draft_model}
      - Speculative samples: ${rest.speculative_samples || 3}
      - Mobile optimization: ${rest.mobile_speculative !== false ? "enabled" : "disabled"}`);
		const { gpu, reasonNoGPU, model: modelDetails, androidLib } = await LlamaCpp.initContext({
			contextId,
			params: Object.assign({
				model: path,
				is_model_asset: !!isModelAsset,
				use_progress_callback: !!onProgress,
				pooling_type: poolType,
				lora: loraPath,
				lora_list: loraAdapters
			}, rest)
		}).catch((err) => {
			removeProgressListener === null || removeProgressListener === void 0 || removeProgressListener.remove();
			throw err;
		});
		removeProgressListener === null || removeProgressListener === void 0 || removeProgressListener.remove();
		return new LlamaContext({
			contextId,
			gpu,
			reasonNoGPU,
			model: modelDetails,
			androidLib
		});
	}
	async function releaseAllLlama() {
		return LlamaCpp.releaseAllContexts();
	}
	async function downloadModel(url, filename) {
		return LlamaCpp.downloadModel({
			url,
			filename
		});
	}
	async function getDownloadProgress(url) {
		return LlamaCpp.getDownloadProgress({ url });
	}
	async function cancelDownload(url) {
		return LlamaCpp.cancelDownload({ url });
	}
	async function getAvailableModels() {
		return LlamaCpp.getAvailableModels();
	}
	/**
	* Convert a JSON schema to GBNF grammar format
	* @param schema JSON schema object
	* @returns Promise resolving to GBNF grammar string
	*/
	async function convertJsonSchemaToGrammar(schema) {
		return jsonSchemaToGrammar(schema);
	}
	const BuildInfo = {
		number: "1.0.0",
		commit: "capacitor-llama-cpp"
	};
	exports.BuildInfo = BuildInfo;
	exports.LLAMACPP_MTMD_DEFAULT_MEDIA_MARKER = LLAMACPP_MTMD_DEFAULT_MEDIA_MARKER;
	exports.LlamaContext = LlamaContext;
	exports.LlamaCpp = LlamaCpp;
	exports.RNLLAMA_MTMD_DEFAULT_MEDIA_MARKER = RNLLAMA_MTMD_DEFAULT_MEDIA_MARKER;
	exports.addNativeLogListener = addNativeLogListener;
	exports.cancelDownload = cancelDownload;
	exports.convertJsonSchemaToGrammar = convertJsonSchemaToGrammar;
	exports.downloadModel = downloadModel;
	exports.getAvailableModels = getAvailableModels;
	exports.getDownloadProgress = getDownloadProgress;
	exports.initLlama = initLlama;
	exports.loadLlamaModelInfo = loadLlamaModelInfo;
	exports.releaseAllLlama = releaseAllLlama;
	exports.setContextLimit = setContextLimit;
	exports.toggleNativeLog = toggleNativeLog;
}));

//#endregion
//#region node_modules/.bun/@elizaos+capacitor-llama@0.1.0+2a604cb248d57ff2/node_modules/@elizaos/capacitor-llama/dist/esm/capacitor-llama-adapter.js
function isObject(value) {
	return typeof value === "object" && value !== null;
}
function isLlamaCppPluginLike(value) {
	return isObject(value) && typeof value.initContext === "function" && typeof value.releaseContext === "function" && typeof value.releaseAllContexts === "function" && typeof value.generateText === "function" && typeof value.stopCompletion === "function" && typeof value.addListener === "function";
}
function resolveLlamaCppPlugin(mod) {
	if (!isObject(mod)) return null;
	if (isLlamaCppPluginLike(mod.LlamaCpp)) return mod.LlamaCpp;
	if (isLlamaCppPluginLike(mod.default)) return mod.default;
	if (isObject(mod.default) && isLlamaCppPluginLike(mod.default.LlamaCpp)) return mod.default.LlamaCpp;
	return null;
}
function isCapacitorNative() {
	var _a;
	const cap = globalThis.Capacitor;
	return Boolean((_a = cap === null || cap === void 0 ? void 0 : cap.isNativePlatform) === null || _a === void 0 ? void 0 : _a.call(cap));
}
function detectPlatform() {
	var _a;
	const cap = globalThis.Capacitor;
	const platform = (_a = cap === null || cap === void 0 ? void 0 : cap.getPlatform) === null || _a === void 0 ? void 0 : _a.call(cap);
	if (platform === "ios") return "ios";
	if (platform === "android") return "android";
	return "web";
}
function registerCapacitorLlamaLoader(runtime) {
	if (typeof runtime.registerService !== "function") return;
	runtime.registerService("localInferenceLoader", {
		async loadModel(args) {
			await capacitorLlama.load({ modelPath: args.modelPath });
		},
		async unloadModel() {
			await capacitorLlama.unload();
		},
		currentModelPath() {
			return capacitorLlama.currentModelPath();
		},
		async generate(args) {
			return (await capacitorLlama.generate({
				prompt: args.prompt,
				stopSequences: args.stopSequences,
				maxTokens: args.maxTokens,
				temperature: args.temperature
			})).text;
		},
		async embed(args) {
			return capacitorLlama.embed({ input: args.input });
		}
	});
}
var CONTEXT_ID, CapacitorLlamaAdapter, capacitorLlama;
var init_capacitor_llama_adapter = __esmMin((() => {
	CONTEXT_ID = 1;
	CapacitorLlamaAdapter = class {
		constructor() {
			this.plugin = null;
			/** Cached loader promise so concurrent `load()` calls don't race to register duplicate listeners. */
			this.pluginLoadPromise = null;
			this.loadedPath = null;
			this.tokenIndex = 0;
			this.tokenListeners = /* @__PURE__ */ new Set();
			this.pluginListenerHandle = null;
		}
		async loadPlugin() {
			if (this.plugin) return this.plugin;
			if (this.pluginLoadPromise) return this.pluginLoadPromise;
			this.pluginLoadPromise = (async () => {
				const plugin = resolveLlamaCppPlugin(await Promise.resolve().then(() => /* @__PURE__ */ __toESM(require_plugin_cjs())));
				if (!plugin) throw new Error("llama-cpp-capacitor did not expose an initContext method");
				const tokenListenerHandle = await plugin.addListener("@LlamaCpp_onToken", (data) => {
					var _a, _b;
					const token = (_b = (_a = data.tokenResult) === null || _a === void 0 ? void 0 : _a.token) !== null && _b !== void 0 ? _b : data.token;
					if (!token) return;
					this.tokenIndex += 1;
					for (const listener of this.tokenListeners) try {
						listener(token, this.tokenIndex);
					} catch (_c) {
						this.tokenListeners.delete(listener);
					}
				});
				this.pluginListenerHandle = tokenListenerHandle !== null && tokenListenerHandle !== void 0 ? tokenListenerHandle : null;
				this.plugin = plugin;
				return plugin;
			})();
			try {
				return await this.pluginLoadPromise;
			} catch (err) {
				this.pluginLoadPromise = null;
				throw err;
			}
		}
		async getHardwareInfo() {
			var _a;
			const platform = detectPlatform();
			const nav = globalThis.navigator;
			return {
				platform,
				deviceModel: platform,
				totalRamGb: 0,
				availableRamGb: null,
				cpuCores: (_a = nav === null || nav === void 0 ? void 0 : nav.hardwareConcurrency) !== null && _a !== void 0 ? _a : 0,
				gpu: null,
				gpuSupported: platform !== "web"
			};
		}
		async isLoaded() {
			return {
				loaded: this.loadedPath !== null,
				modelPath: this.loadedPath
			};
		}
		currentModelPath() {
			return this.loadedPath;
		}
		async load(options) {
			var _a, _b;
			if (!isCapacitorNative()) throw new Error("capacitor-llama is only available on iOS and Android builds");
			const plugin = await this.loadPlugin();
			if (this.loadedPath && this.loadedPath !== options.modelPath) {
				await plugin.releaseAllContexts();
				this.loadedPath = null;
			}
			await plugin.initContext({
				contextId: CONTEXT_ID,
				params: {
					model: options.modelPath,
					n_ctx: (_a = options.contextSize) !== null && _a !== void 0 ? _a : 4096,
					n_gpu_layers: options.useGpu === false ? 0 : 99,
					n_threads: (_b = options.maxThreads) !== null && _b !== void 0 ? _b : 0,
					use_mmap: true
				}
			});
			this.loadedPath = options.modelPath;
		}
		async unload() {
			if (!this.plugin || !this.loadedPath) return;
			try {
				await this.plugin.releaseContext({ contextId: CONTEXT_ID });
			} catch (_a) {
				await this.plugin.releaseAllContexts();
			}
			this.loadedPath = null;
		}
		async generate(options) {
			var _a, _b, _c, _d;
			if (!this.plugin || !this.loadedPath) throw new Error("No model loaded. Call load() first.");
			this.tokenIndex = 0;
			const params = {
				n_predict: (_a = options.maxTokens) !== null && _a !== void 0 ? _a : 2048,
				temperature: (_b = options.temperature) !== null && _b !== void 0 ? _b : .7,
				top_p: (_c = options.topP) !== null && _c !== void 0 ? _c : .9
			};
			if (options.stopSequences && options.stopSequences.length > 0) params.stop = options.stopSequences;
			if (options.stream) params.emit_partial_completion = true;
			const started = Date.now();
			const result = await this.plugin.generateText({
				contextId: CONTEXT_ID,
				prompt: options.prompt,
				params
			});
			const duration = ((_d = result.timings) === null || _d === void 0 ? void 0 : _d.predicted_ms) != null ? Math.round(result.timings.predicted_ms) : Date.now() - started;
			return {
				text: result.text,
				promptTokens: result.tokens_evaluated,
				outputTokens: result.tokens_predicted,
				durationMs: duration
			};
		}
		async cancelGenerate() {
			if (!this.plugin) return;
			await this.plugin.stopCompletion({ contextId: CONTEXT_ID });
		}
		async embed(options) {
			var _a;
			if (!this.plugin || !this.loadedPath) throw new Error("No model loaded. Call load() first.");
			if (typeof this.plugin.embedding !== "function") throw new Error("llama-cpp-capacitor does not expose embedding() on this build; upgrade or use a cloud embedding provider");
			const params = { embd_normalize: (_a = options.embdNormalize) !== null && _a !== void 0 ? _a : 0 };
			const result = await this.plugin.embedding({
				contextId: CONTEXT_ID,
				text: options.input,
				params
			});
			let tokenCount = 0;
			if (typeof this.plugin.tokenize === "function") try {
				tokenCount = (await this.plugin.tokenize({
					contextId: CONTEXT_ID,
					text: options.input
				})).tokens.length;
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				console.debug("[capacitor-llama] tokenize fallback", { error: message });
				tokenCount = 0;
			}
			return {
				embedding: result.embedding,
				tokens: tokenCount
			};
		}
		onToken(listener) {
			this.tokenListeners.add(listener);
			return () => {
				this.tokenListeners.delete(listener);
			};
		}
		async dispose() {
			this.tokenListeners.clear();
			if (this.pluginListenerHandle) {
				await this.pluginListenerHandle.remove();
				this.pluginListenerHandle = null;
			}
			await this.unload();
			this.plugin = null;
			this.pluginLoadPromise = null;
		}
	};
	capacitorLlama = new CapacitorLlamaAdapter();
}));

//#endregion
//#region node_modules/.bun/@elizaos+capacitor-llama@0.1.0+2a604cb248d57ff2/node_modules/@elizaos/capacitor-llama/dist/esm/definitions.js
var init_definitions = __esmMin((() => {}));

//#endregion
//#region node_modules/.bun/@elizaos+capacitor-llama@0.1.0+2a604cb248d57ff2/node_modules/@elizaos/capacitor-llama/dist/esm/load-capacitor-llama.js
async function loadCapacitorLlama() {
	if (cachedAdapter) return cachedAdapter;
	cachedAdapter = capacitorLlama;
	return cachedAdapter;
}
var cachedAdapter;
var init_load_capacitor_llama = __esmMin((() => {
	init_capacitor_llama_adapter();
	cachedAdapter = null;
}));

//#endregion
//#region node_modules/.bun/@elizaos+capacitor-llama@0.1.0+2a604cb248d57ff2/node_modules/@elizaos/capacitor-llama/dist/esm/device-bridge-client.js
/**
* Convenience helper for the mobile bootstrap: starts a bridge client
* using values from the Eliza config or hardcoded env.
*
* The host app is expected to call this once during Capacitor bootstrap.
* `agentUrl` and `pairingToken` come from the user's pairing flow and
* should be persisted across launches.
*/
function startDeviceBridgeClient(config) {
	const client = new DeviceBridgeClient(config);
	client.start();
	return client;
}
var INITIAL_BACKOFF_MS, MAX_BACKOFF_MS, DeviceBridgeClient;
var init_device_bridge_client = __esmMin((() => {
	init_load_capacitor_llama();
	INITIAL_BACKOFF_MS = 1e3;
	MAX_BACKOFF_MS = 3e4;
	DeviceBridgeClient = class {
		constructor(config) {
			this.socket = null;
			this.reconnectAttempt = 0;
			this.stopped = false;
			this.config = config;
		}
		start() {
			this.stopped = false;
			this.connect();
		}
		stop() {
			this.stopped = true;
			if (this.socket) {
				try {
					this.socket.close(1e3, "client-stop");
				} catch (_a) {}
				this.socket = null;
			}
		}
		computeBackoffMs() {
			const exp = Math.min(MAX_BACKOFF_MS, INITIAL_BACKOFF_MS * 2 ** Math.min(this.reconnectAttempt, 6));
			return Math.floor(Math.random() * exp);
		}
		connect() {
			var _a, _b, _c, _d;
			if (this.stopped) return;
			(_b = (_a = this.config).onStateChange) === null || _b === void 0 || _b.call(_a, "connecting");
			const url = this.buildUrl();
			let ws;
			try {
				ws = new WebSocket(url);
			} catch (err) {
				(_d = (_c = this.config).onStateChange) === null || _d === void 0 || _d.call(_c, "error", err instanceof Error ? err.message : String(err));
				this.scheduleReconnect();
				return;
			}
			this.socket = ws;
			ws.onopen = () => {
				this.reconnectAttempt = 0;
				this.sendRegister(ws);
			};
			ws.onmessage = (event) => {
				let msg;
				try {
					msg = JSON.parse(String(event.data));
				} catch (_a) {
					return;
				}
				this.handleAgentMessage(ws, msg);
			};
			ws.onerror = () => {
				var _a, _b;
				(_b = (_a = this.config).onStateChange) === null || _b === void 0 || _b.call(_a, "error", "websocket error");
			};
			ws.onclose = () => {
				var _a, _b;
				this.socket = null;
				(_b = (_a = this.config).onStateChange) === null || _b === void 0 || _b.call(_a, "disconnected");
				this.scheduleReconnect();
			};
		}
		buildUrl() {
			if (!this.config.pairingToken) return this.config.agentUrl;
			const sep = this.config.agentUrl.includes("?") ? "&" : "?";
			return `${this.config.agentUrl}${sep}token=${encodeURIComponent(this.config.pairingToken)}`;
		}
		scheduleReconnect() {
			if (this.stopped) return;
			const delay = this.computeBackoffMs();
			this.reconnectAttempt += 1;
			setTimeout(() => this.connect(), delay);
		}
		async sendRegister(ws) {
			var _a, _b;
			const capacitorLlama = await loadCapacitorLlama();
			const hardware = await capacitorLlama.getHardwareInfo();
			const loaded = await capacitorLlama.isLoaded();
			const msg = {
				type: "register",
				payload: {
					deviceId: this.config.deviceId,
					pairingToken: this.config.pairingToken,
					capabilities: {
						platform: hardware.platform,
						deviceModel: hardware.deviceModel,
						totalRamGb: hardware.totalRamGb,
						cpuCores: hardware.cpuCores,
						gpu: hardware.gpu
					},
					loadedPath: loaded.modelPath
				}
			};
			this.send(ws, msg);
			(_b = (_a = this.config).onStateChange) === null || _b === void 0 || _b.call(_a, "connected");
		}
		send(ws, msg) {
			if (ws.readyState !== WebSocket.OPEN) return;
			ws.send(JSON.stringify(msg));
		}
		async handleAgentMessage(ws, msg) {
			if (msg.type === "ping") {
				this.send(ws, {
					type: "pong",
					at: Date.now()
				});
				return;
			}
			if (msg.type === "load") {
				try {
					await (await loadCapacitorLlama()).load({
						modelPath: msg.modelPath,
						contextSize: msg.contextSize,
						useGpu: msg.useGpu
					});
					this.send(ws, {
						type: "loadResult",
						correlationId: msg.correlationId,
						ok: true,
						loadedPath: msg.modelPath
					});
				} catch (err) {
					this.send(ws, {
						type: "loadResult",
						correlationId: msg.correlationId,
						ok: false,
						error: err instanceof Error ? err.message : String(err)
					});
				}
				return;
			}
			if (msg.type === "unload") {
				try {
					await (await loadCapacitorLlama()).unload();
					this.send(ws, {
						type: "unloadResult",
						correlationId: msg.correlationId,
						ok: true
					});
				} catch (err) {
					this.send(ws, {
						type: "unloadResult",
						correlationId: msg.correlationId,
						ok: false,
						error: err instanceof Error ? err.message : String(err)
					});
				}
				return;
			}
			if (msg.type === "generate") {
				try {
					const result = await (await loadCapacitorLlama()).generate({
						prompt: msg.prompt,
						stopSequences: msg.stopSequences,
						maxTokens: msg.maxTokens,
						temperature: msg.temperature
					});
					this.send(ws, {
						type: "generateResult",
						correlationId: msg.correlationId,
						ok: true,
						text: result.text,
						promptTokens: result.promptTokens,
						outputTokens: result.outputTokens,
						durationMs: result.durationMs
					});
				} catch (err) {
					this.send(ws, {
						type: "generateResult",
						correlationId: msg.correlationId,
						ok: false,
						error: err instanceof Error ? err.message : String(err)
					});
				}
				return;
			}
		}
	};
}));

//#endregion
//#region node_modules/.bun/@elizaos+capacitor-llama@0.1.0+2a604cb248d57ff2/node_modules/@elizaos/capacitor-llama/dist/esm/index.js
var esm_exports = /* @__PURE__ */ __exportAll({
	DeviceBridgeClient: () => DeviceBridgeClient,
	capacitorLlama: () => capacitorLlama,
	registerCapacitorLlamaLoader: () => registerCapacitorLlamaLoader,
	startDeviceBridgeClient: () => startDeviceBridgeClient
});
var init_esm = __esmMin((() => {
	init_capacitor_llama_adapter();
	init_definitions();
	init_device_bridge_client();
}));

//#endregion
//#region node_modules/.bun/@elizaos+app-core@2.0.0-alpha.537+72829346cb4c43b1/node_modules/@elizaos/app-core/packages/app-core/src/runtime/ensure-local-inference-handler.js
/**
* Registers the standalone llama.cpp engine as the runtime handler for
* `ModelType.TEXT_SMALL` and `ModelType.TEXT_LARGE`.
*
* Priority is 0 — same band as cloud and direct provider plugins. Tie-breaks
* between local and cloud are owned by the routing-policy layer
* (`router-handler.ts` + `routing-policy.ts`), not by this priority value:
* the router sits at MAX_SAFE_INTEGER and consults the user's policy
* (manual / cheapest / fastest / prefer-local / round-robin) on every call.
*
* Until the cuttlefish smoke landed this was -1 to "let cloud win by default,"
* but that conflated routing-policy (a user preference) with handler
* priority (a registration ordinal). The runtime's getModel() returns
* undefined when no priority-0 handler is registered, which manifested as
* "No handler found for delegate type: TEXT_SMALL" on AOSP builds where
* the AOSP local inference loader is the only provider. Both cloud-only and
* local-only deployments now have a registered priority-0 handler; the
* router decides which one fires per request.
*
* Parallels `ensure-text-to-speech-handler.ts` — same shape, same guards.
*/
function getLoader(runtime) {
	const candidate = runtime.getService?.("localInferenceLoader");
	if (!candidate || typeof candidate !== "object") return null;
	const loader = candidate;
	if (typeof loader.loadModel === "function" && typeof loader.unloadModel === "function") return candidate;
	return null;
}
/**
* Look up the model assigned to a given agent slot and ensure it's the
* one loaded before generation runs. Loads lazily on first call; swaps
* when a different slot's assignment fires with a different model.
*
* If no assignment is set for the slot, falls back to whatever is
* currently loaded (keeps the old "one active model" behaviour).
*/
async function ensureAssignedModelLoaded(loader, slot) {
	const assignedId = (await readEffectiveAssignments())[slot];
	if (!assignedId) return;
	if (!loader && localInferenceEngine.currentModelPath()) {
		if ((await listInstalledModels()).find((m) => m.path === localInferenceEngine.currentModelPath())?.id === assignedId) return;
	}
	if (loader) {
		const currentPath = loader.currentModelPath();
		if (currentPath) {
			if ((await listInstalledModels()).find((m) => m.path === currentPath)?.id === assignedId) return;
		}
	}
	const target = (await listInstalledModels()).find((m) => m.id === assignedId);
	if (!target) throw new Error(`[local-inference] Slot ${slot} assigned to ${assignedId}, but that model is not installed.`);
	if (loader) {
		await loader.unloadModel();
		await loader.loadModel({ modelPath: target.path });
	} else await localInferenceEngine.load(target.path);
}
function makeHandler(slot) {
	return async (runtime, params) => {
		const loader = getLoader(runtime);
		await ensureAssignedModelLoaded(loader, slot);
		if (loader?.generate) return loader.generate({
			prompt: params.prompt,
			stopSequences: params.stopSequences
		});
		if (!await localInferenceEngine.available()) throw new Error(`[local-inference] No llama.cpp binding available for ${slot} request`);
		if (!localInferenceEngine.hasLoadedModel()) throw new Error(`[local-inference] No local model is active. Assign a model to ${slot} or activate one in Settings → Local models.`);
		return localInferenceEngine.generate({
			prompt: params.prompt,
			stopSequences: params.stopSequences
		});
	};
}
/**
* Normalize the runtime's TEXT_EMBEDDING input shape — `params` may be the
* structured `TextEmbeddingParams` (when called from a typed plugin), a
* raw string (when called from action runners), or `null` (an internal
* warmup probe used to size the shipped embedding vector).
*/
function extractEmbeddingText(params) {
	if (params === null) return "";
	if (typeof params === "string") return params;
	return params.text;
}
/**
* Build the TEXT_EMBEDDING handler. Mirrors `makeHandler` for generate:
* routes through the loader's `embed` if available, otherwise throws so
* the runtime falls back to a non-local provider rather than serving a
* silent zero-vector (Commandment 8: don't hide broken pipelines).
*/
function makeEmbeddingHandler() {
	return async (runtime, params) => {
		const loader = getLoader(runtime);
		if (!loader?.embed) throw new Error("[local-inference] Active loader does not implement embed; falling through to next provider");
		await ensureAssignedModelLoaded(loader, "TEXT_EMBEDDING");
		const text = extractEmbeddingText(params);
		return (await loader.embed({ input: text })).embedding;
	};
}
/**
* Register the device-bridge loader on the runtime. Accepts load/generate
* calls whether or not a mobile device is currently connected — parked
* calls resolve on reconnect (up to a timeout). Cheaper than waiting for
* the first device register to register the service: ordering is already
* handled inside `DeviceBridge.generate`.
*/
function registerDeviceBridgeLoader(runtime) {
	const withRegistration = runtime;
	if (typeof withRegistration.registerService !== "function") return;
	withRegistration.registerService("localInferenceLoader", {
		loadModel: (args) => deviceBridge.loadModel(args),
		unloadModel: () => deviceBridge.unloadModel(),
		currentModelPath: () => deviceBridge.currentModelPath(),
		generate: (args) => deviceBridge.generate(args),
		embed: (args) => deviceBridge.embed(args)
	});
}
/**
* AOSP-only path: load `libllama.so` directly into the bun process via
* `bun:ffi`. The adapter no-ops at runtime when `ELIZA_LOCAL_LLAMA !== "1"`,
* so the dynamic import below is safe on every platform; we only attempt
* registration when the user explicitly opted in.
*
* The `try`/`catch` is justified because the AOSP build can ship the .so on
* one ABI but be invoked on another (e.g. cuttlefish_x86_64 reporting both
* x86_64 and arm64-v8a). When `ELIZA_LOCAL_LLAMA=1` is set but registration
* fails, the adapter logs at `error` level — we must NOT silently fall
* through to the device-bridge or stock engine: the operator opted in and
* deserves the failure surfaced clearly.
*/
async function tryRegisterAospLlamaLoader(runtime) {
	if (process.env.ELIZA_LOCAL_LLAMA?.trim() !== "1") return false;
	try {
		const mod = await import("@elizaos/agent/runtime/aosp-llama-adapter");
		if (typeof mod.registerAospLlamaLoader !== "function") {
			logger.error("[local-inference] AOSP llama adapter import resolved but missing registerAospLlamaLoader export");
			return false;
		}
		const result = await mod.registerAospLlamaLoader(runtime);
		return Boolean(result);
	} catch (err) {
		logger.error("[local-inference] AOSP llama adapter unavailable while ELIZA_LOCAL_LLAMA=1:", err instanceof Error ? err.message : String(err));
		return false;
	}
}
async function tryRegisterCapacitorLoader(runtime) {
	if (!globalThis.Capacitor?.isNativePlatform?.()) return false;
	try {
		const mod = await Promise.resolve().then(() => (init_esm(), esm_exports));
		if (typeof mod.registerCapacitorLlamaLoader === "function") {
			mod.registerCapacitorLlamaLoader(runtime);
			logger.info("[local-inference] Registered capacitor-llama loader for mobile on-device inference");
			return true;
		}
	} catch (err) {
		logger.debug("[local-inference] capacitor-llama not available:", err instanceof Error ? err.message : String(err));
	}
	return false;
}
async function ensureLocalInferenceHandler(runtime) {
	const runtimeWithRegistration = runtime;
	if (typeof runtimeWithRegistration.getModel !== "function" || typeof runtimeWithRegistration.registerModel !== "function") return;
	handlerRegistry.installOn(runtime);
	const aospRegistered = await tryRegisterAospLlamaLoader(runtime);
	const capacitorRegistered = !aospRegistered && await tryRegisterCapacitorLoader(runtime);
	const deviceBridgeEnabled = process.env.ELIZA_DEVICE_BRIDGE_ENABLED?.trim() === "1";
	if (!aospRegistered && !capacitorRegistered && deviceBridgeEnabled) {
		registerDeviceBridgeLoader(runtime);
		logger.info("[local-inference] Registered device-bridge loader; inference routes to paired mobile device when connected");
	}
	if (!aospRegistered && !capacitorRegistered && !deviceBridgeEnabled && !await localInferenceEngine.available()) {
		logger.debug("[local-inference] No local inference backend available; skipping model registration");
		return;
	}
	try {
		const filled = await autoAssignAtBoot(await listInstalledModels());
		if (filled) logger.info(`[local-inference] Auto-assigned single installed model to empty slots: ${JSON.stringify(filled)}`);
	} catch (err) {
		logger.warn("[local-inference] autoAssignAtBoot failed:", err instanceof Error ? err.message : String(err));
	}
	const provider = aospRegistered ? AOSP_LLAMA_PROVIDER : capacitorRegistered ? CAPACITOR_LLAMA_PROVIDER$1 : deviceBridgeEnabled ? DEVICE_BRIDGE_PROVIDER$1 : LOCAL_INFERENCE_PROVIDER;
	const slots = [[ModelType.TEXT_SMALL, "TEXT_SMALL"], [ModelType.TEXT_LARGE, "TEXT_LARGE"]];
	for (const [modelType, slot] of slots) try {
		runtimeWithRegistration.registerModel(modelType, makeHandler(slot), provider, LOCAL_INFERENCE_PRIORITY);
	} catch (err) {
		logger.warn("[local-inference] Could not register ModelType", modelType, err instanceof Error ? err.message : String(err));
	}
	const loaderForEmbed = runtime.getService?.("localInferenceLoader");
	if (loaderForEmbed && typeof loaderForEmbed.embed === "function") try {
		runtimeWithRegistration.registerModel(ModelType.TEXT_EMBEDDING, makeEmbeddingHandler(), provider, LOCAL_INFERENCE_PRIORITY);
		logger.info(`[local-inference] Registered ${provider} embedding handler for TEXT_EMBEDDING at priority ${LOCAL_INFERENCE_PRIORITY}`);
	} catch (err) {
		logger.warn("[local-inference] Could not register TEXT_EMBEDDING handler", err instanceof Error ? err.message : String(err));
	}
	logger.info(`[local-inference] Registered ${provider} llama.cpp handler for TEXT_SMALL / TEXT_LARGE at priority ${LOCAL_INFERENCE_PRIORITY}`);
	installRouterHandler(runtime);
	logger.info("[local-inference] Installed top-priority router for cross-provider routing");
}
var LOCAL_INFERENCE_PROVIDER, DEVICE_BRIDGE_PROVIDER$1, CAPACITOR_LLAMA_PROVIDER$1, AOSP_LLAMA_PROVIDER, LOCAL_INFERENCE_PRIORITY;
var init_ensure_local_inference_handler = __esmMin((() => {
	init_assignments();
	init_device_bridge();
	init_engine();
	init_handler_registry();
	init_registry();
	init_router_handler();
	LOCAL_INFERENCE_PROVIDER = "eliza-local-inference";
	DEVICE_BRIDGE_PROVIDER$1 = "eliza-device-bridge";
	CAPACITOR_LLAMA_PROVIDER$1 = "capacitor-llama";
	AOSP_LLAMA_PROVIDER = "eliza-aosp-llama";
	LOCAL_INFERENCE_PRIORITY = 0;
}));

//#endregion
//#region node_modules/.bun/@elizaos+app-core@2.0.0-alpha.537+72829346cb4c43b1/node_modules/@elizaos/app-core/packages/app-core/src/runtime/ensure-text-to-speech-handler.js
var ensure_text_to_speech_handler_exports = /* @__PURE__ */ __exportAll({
	ensureTextToSpeechHandler: () => ensureTextToSpeechHandler,
	isEdgeTtsDisabled: () => isEdgeTtsDisabled
});
function isEdgeTtsDisabled(config) {
	if (config.plugins?.entries?.["edge-tts"]?.enabled === false) return true;
	const raw = process$1?.env ? process$1.env.ELIZA_DISABLE_EDGE_TTS : void 0;
	if (!raw || typeof raw !== "string") return false;
	const normalized = raw.trim().toLowerCase();
	return normalized === "1" || normalized === "true" || normalized === "yes";
}
function readHandler(plugin) {
	const handler = plugin?.models?.[ModelType.TEXT_TO_SPEECH];
	return typeof handler === "function" ? handler : void 0;
}
/**
* `@elizaos/agent` boot calls its own `collectPluginNames`, so the app wrapper
* that adds Edge TTS is bypassed. Register the Edge TTS model handler on the
* live runtime so streaming / swarm voice can still resolve TEXT_TO_SPEECH.
*/
async function ensureTextToSpeechHandler(runtime) {
	if (isEdgeTtsDisabled(loadElizaConfig())) return;
	const runtimeWithRegistration = runtime;
	if (typeof runtimeWithRegistration.getModel !== "function" || typeof runtimeWithRegistration.registerModel !== "function") return;
	if (runtimeWithRegistration.getModel(ModelType.TEXT_TO_SPEECH)) return;
	try {
		const handler = readHandler((await import("@elizaos/plugin-edge-tts/node")).default);
		if (!handler) throw new Error("@elizaos/plugin-edge-tts/node did not expose a TEXT_TO_SPEECH handler");
		runtimeWithRegistration.registerModel(ModelType.TEXT_TO_SPEECH, handler, "edge-tts", 0);
		logger.info("[eliza] Registered Edge TTS for runtime TEXT_TO_SPEECH (streaming / swarm voice)");
	} catch (error) {
		throw new Error(`[eliza] Could not register Edge TTS for TEXT_TO_SPEECH: ${error instanceof Error ? error.message : String(error)}`);
	}
}
var init_ensure_text_to_speech_handler = __esmMin((() => {}));

//#endregion
//#region node_modules/.bun/@elizaos+app-core@2.0.0-alpha.537+72829346cb4c43b1/node_modules/@elizaos/app-core/packages/app-core/src/runtime/mobile-local-inference-gate.js
/**
* On a mobile platform (`ELIZA_PLATFORM=android` / `ios`) the runtime skips
* nearly every boot helper because they shell out to subprocesses,
* platform-specific binaries, or optional packages that aren't in the mobile
* bundle. Two mobile-safe inference paths still need wiring:
*
*   - `ELIZA_DEVICE_BRIDGE_ENABLED=1`: the agent (this process) hosts the
*     device-bridge WSS and dials whichever paired device connects. On the
*     Capacitor APK the WebView's `@elizaos/capacitor-llama` is the intended
*     dialer over loopback. The Capacitor build always exports this env so
*     the bridge is ready as soon as onboarding picks the local mode.
*
*   - `ELIZA_LOCAL_LLAMA=1`: AOSP-only path that loads node-llama-cpp
*     directly inside the Android process. Wired here so the gate is in
*     place ahead of sub-task 2 — the AOSP build flag flips this on.
*
* Kept dependency-free so it can be unit-tested without instantiating the
* full runtime.
*/
function shouldEnableMobileLocalInference(env = process.env) {
	const deviceBridge = env.ELIZA_DEVICE_BRIDGE_ENABLED?.trim() === "1";
	const localLlama = env.ELIZA_LOCAL_LLAMA?.trim() === "1";
	return deviceBridge || localLlama;
}
var init_mobile_local_inference_gate = __esmMin((() => {}));

//#endregion
//#region node_modules/.bun/@elizaos+app-core@2.0.0-alpha.537+72829346cb4c43b1/node_modules/@elizaos/app-core/packages/app-core/src/runtime/startup-overlay.js
/** Extract a 0–100 percentage from progress strings like "45% of 95 MB". */
function parseEmbeddingProgressPercent(detail) {
	if (!detail) return void 0;
	const m = detail.match(/(\d+(?:\.\d+)?)\s*%/);
	if (!m) return void 0;
	const n = Number.parseFloat(m[1] ?? "");
	if (!Number.isFinite(n)) return void 0;
	return Math.max(0, Math.min(100, Math.round(n)));
}
function updateStartupEmbeddingProgress(phase, detail) {
	snapshot = {
		phase,
		detail,
		updatedAt: Date.now()
	};
	if (phase === "ready") snapshot = null;
}
/**
* Fields merged into the JSON `startup` object on GET /api/status (Compat layer).
*/
function getStartupEmbeddingAugmentation() {
	if (!snapshot) return null;
	if (Date.now() - snapshot.updatedAt > STALE_MS) {
		snapshot = null;
		return null;
	}
	if (snapshot.phase === "ready") return null;
	const out = { embeddingPhase: snapshot.phase };
	if (snapshot.detail) {
		out.embeddingDetail = snapshot.detail;
		const pct = parseEmbeddingProgressPercent(snapshot.detail);
		if (pct !== void 0) out.embeddingProgressPct = pct;
	}
	return out;
}
var snapshot, STALE_MS;
var init_startup_overlay = __esmMin((() => {
	snapshot = null;
	STALE_MS = 12e4;
}));

//#endregion
//#region node_modules/.bun/@elizaos+app-core@2.0.0-alpha.537+72829346cb4c43b1/node_modules/@elizaos/app-core/packages/app-core/src/runtime/telegram-standalone-policy.js
function isExplicitTrue(value) {
	if (!value) return false;
	const normalized = value.trim().toLowerCase();
	return normalized === "1" || normalized === "true" || normalized === "yes";
}
function shouldStartTelegramStandaloneBot(env = process.env) {
	if (lifeOpsPassiveConnectorsEnabled(null, env)) return false;
	return isExplicitTrue(env.ELIZA_TELEGRAM_STANDALONE_BOT);
}
var init_telegram_standalone_policy = __esmMin((() => {}));

//#endregion
//#region node_modules/.bun/@elizaos+app-core@2.0.0-alpha.537+72829346cb4c43b1/node_modules/@elizaos/app-core/packages/app-core/src/services/n8n-sidecar.js
/**
* n8n local sidecar: lifecycle + readiness + API-key provisioning.
*
* Fallback for the @elizaos/plugin-n8n-workflow plugin when the user has
* no Eliza Cloud session. Spawns `bunx n8n@<pinned>` (no package.json
* dependency on n8n — that tree is ~300MB), polls `/rest/login` until
* the instance is reachable, then provisions a personal API key via
* `/rest/me/api-keys` so the plugin has `N8N_HOST` + `N8N_API_KEY` to
* talk to.
*
* ── Lifecycle state diagram ─────────────────────────────────────────
*
*   stopped ──start()──▶ starting ──ready_probe_ok──▶ ready
*      ▲                    │
*      │                    └──start_error / probe_timeout──▶ error
*      │                                                         │
*      │                                                  retry_backoff
*      │                                                         │
*      ├────stop()──── ready                                      │
*      │                    │                                     │
*      │                   crash                                  │
*      │                    ▼                                     │
*      │                 error ◀──max_retries_exceeded────────────┘
*      │                    │
*      └────stop()──────────┘
*
* Transitions are emitted via an observable so the UI can live-render
* "Cloud n8n connected" vs "Local n8n starting…". Secrets never cross
* the logger at INFO — the provisioned API key is logged as a redacted
* fingerprint only.
*
* Matches the develop sidecar conventions used by StewardSidecar:
*   - Prefers `Bun.spawn` when available, falls back to node:child_process
*   - `onStatusChange` + `onLog` callbacks in config (parallels steward)
*   - Bounded restart with exponential backoff
*/
var n8n_sidecar_exports = /* @__PURE__ */ __exportAll({
	N8nSidecar: () => N8nSidecar,
	disposeN8nSidecar: () => disposeN8nSidecar,
	getN8nSidecar: () => getN8nSidecar,
	getN8nSidecarAsync: () => getN8nSidecarAsync,
	isBinaryMissingMessage: () => isBinaryMissingMessage,
	peekN8nSidecar: () => peekN8nSidecar
});
function defaultStateDir$1() {
	const home = process.env.HOME ?? process.env.USERPROFILE ?? os.tmpdir();
	return path.join(home, ".eliza", "n8n");
}
/** Async port picker: asks the OS for a free port starting at `start`. */
async function pickFreePortDefault(start) {
	const maxAttempts = 50;
	for (let offset = 0; offset < maxAttempts; offset++) {
		const candidate = start + offset;
		if (candidate > 65535) break;
		const ipv4Free = await canBindTcpPortDefault(candidate, "127.0.0.1");
		const ipv6Free = await canBindTcpPortDefault(candidate, "::");
		if (ipv4Free && ipv6Free) return candidate;
	}
	throw new Error(`no free port available starting from ${start}`);
}
function canBindTcpPortDefault(port, host) {
	return new Promise((resolve) => {
		const server = createServer();
		let settled = false;
		const finish = (free) => {
			if (settled) return;
			settled = true;
			resolve(free);
		};
		server.once("error", (err) => {
			if (host === "::" && (err.code === "EADDRNOTAVAIL" || err.code === "EAFNOSUPPORT")) {
				finish(true);
				return;
			}
			finish(false);
		});
		server.once("listening", () => {
			server.close(() => finish(true));
		});
		server.listen({
			port,
			host
		});
	});
}
function sleepDefault(ms) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}
function isProcessAliveDefault(pid) {
	if (!Number.isInteger(pid) || pid <= 0) return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch (err) {
		if (err?.code === "EPERM") return true;
		return false;
	}
}
async function readProcessCommandDefault(pid) {
	if (!Number.isInteger(pid) || pid <= 0) return null;
	try {
		return (await fs$1.readFile(`/proc/${pid}/cmdline`, "utf-8")).replace(/\0/g, " ").trim();
	} catch {}
	try {
		const { spawn } = await import("node:child_process");
		return await new Promise((resolve) => {
			const proc = spawn("ps", [
				"-p",
				String(pid),
				"-o",
				"command="
			], { stdio: [
				"ignore",
				"pipe",
				"ignore"
			] });
			let out = "";
			proc.stdout?.on("data", (buf) => {
				out += buf.toString();
			});
			proc.once("error", () => resolve(null));
			proc.once("exit", (code) => {
				if (code === 0) {
					const trimmed = out.trim();
					resolve(trimmed.length ? trimmed : null);
				} else resolve(null);
			});
		});
	} catch {
		return null;
	}
}
function killPidDefault(pid, signal) {
	if (!Number.isInteger(pid) || pid <= 0) return;
	try {
		process.kill(pid, signal);
	} catch {}
}
async function preflightBinaryDefault(binary) {
	await new Promise((resolve, reject) => {
		const proc = spawn(binary, ["--version"], { stdio: [
			"ignore",
			"pipe",
			"pipe"
		] });
		const timer = setTimeout(() => {
			try {
				proc.kill("SIGKILL");
			} catch {}
			reject(/* @__PURE__ */ new Error(`${binary} --version timed out; bun runtime not found on PATH — required for local n8n. Install from https://bun.sh.`));
		}, 5e3);
		timer.unref?.();
		proc.once("error", (err) => {
			clearTimeout(timer);
			reject(/* @__PURE__ */ new Error(`${binary} runtime not found on PATH — required for local n8n. Install from https://bun.sh. (${err.message})`));
		});
		proc.once("exit", (code) => {
			clearTimeout(timer);
			if (code === 0) resolve();
			else reject(/* @__PURE__ */ new Error(`${binary} --version exited with code ${code ?? "null"} — required for local n8n. Install from https://bun.sh.`));
		});
	});
}
/** Redact a secret to a short fingerprint that's safe to log. */
function fingerprint(secret) {
	if (!secret || secret.length < 8) return "***";
	return `${secret.slice(0, 4)}…${secret.slice(-2)} (len=${secret.length})`;
}
function isBinaryMissingMessage(message) {
	return BINARY_MISSING_PATTERNS.some((re) => re.test(message));
}
/**
* Extract the n8n-auth cookie from a `Response` for re-use on subsequent
* calls. Returns a ready-to-send `Cookie:` header value, or null if the
* response didn't set one. Tolerates fetch implementations that expose
* multiple Set-Cookie values through `getSetCookie()` (Node 20.18+) or
* a single joined `set-cookie` header (older runtimes and the test fetch
* mock we use in unit tests).
*/
function extractAuthCookie$1(res) {
	const headers = res.headers;
	const list = typeof headers.getSetCookie === "function" ? headers.getSetCookie() : (headers.get("set-cookie") ?? "").split(/,(?=\s*[\w-]+=)/).filter((s) => s.length > 0);
	for (const raw of list) {
		const first = raw.split(";")[0]?.trim();
		if (first?.startsWith("n8n-auth=")) return first;
	}
	return null;
}
function resolveConfig(config) {
	return {
		enabled: config.enabled ?? true,
		version: config.version ?? DEFAULT_N8N_VERSION,
		startPort: config.startPort ?? DEFAULT_START_PORT,
		host: config.host ?? DEFAULT_HOST,
		binary: config.binary ?? DEFAULT_BINARY,
		stateDir: config.stateDir ?? defaultStateDir$1(),
		readinessTimeoutMs: config.readinessTimeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS,
		readinessIntervalMs: config.readinessIntervalMs ?? DEFAULT_PROBE_INTERVAL_MS,
		maxRetries: config.maxRetries ?? DEFAULT_MAX_RETRIES,
		backoffBaseMs: config.backoffBaseMs ?? DEFAULT_BACKOFF_BASE_MS,
		onStatusChange: config.onStatusChange,
		onLog: config.onLog
	};
}
/**
* Returns the process-wide n8n sidecar singleton, constructing it lazily
* on first access.
*
* If the singleton already exists, the provided config is merged via
* `updateConfig()` — changes that require a respawn (binary/host/port/
* stateDir/version) log a warning and do NOT take effect until an explicit
* stop()+start() cycle. Non-respawn fields (timeouts, callbacks, retries)
* apply immediately.
*
* NOTE: This accessor is synchronous for backwards compatibility with
* existing callers. If a disposal is currently in flight, you may get a
* sidecar that races with the old one. Prefer `getN8nSidecarAsync()` in
* new code.
*/
function getN8nSidecar(config = {}) {
	if (_disposing !== null) logger.warn("[n8n-sidecar] getN8nSidecar() called during disposal; prefer getN8nSidecarAsync()");
	if (!_singleton) {
		_singleton = new N8nSidecar(config);
		return _singleton;
	}
	_singleton.updateConfig(config);
	return _singleton;
}
/**
* Async-safe variant of getN8nSidecar(). Awaits any in-flight disposal
* before constructing or returning the singleton. Use this from code that
* can be async (most callers already are).
*/
async function getN8nSidecarAsync(config = {}) {
	if (_disposing !== null) await _disposing;
	return getN8nSidecar(config);
}
/**
* Returns the singleton if one has already been constructed. Used by
* routes that should only surface state if the sidecar was explicitly
* initialized (avoids side-effectful construction on a read).
*/
function peekN8nSidecar() {
	return _singleton;
}
/**
* Stops and clears the singleton. Tests + shutdown paths use this.
*
* Concurrency contract: concurrent callers all await the same in-flight
* stop() before `_singleton` is cleared. Once disposal resolves, the
* singleton slot is free and a new sidecar can be constructed.
*/
async function disposeN8nSidecar() {
	if (_disposing !== null) {
		await _disposing;
		return;
	}
	const existing = _singleton;
	if (!existing) return;
	_disposing = (async () => {
		try {
			await existing.stop();
		} finally {
			_singleton = null;
			_disposing = null;
		}
	})();
	await _disposing;
}
var DEFAULT_N8N_VERSION, DEFAULT_START_PORT, DEFAULT_HOST, DEFAULT_BINARY, DEFAULT_PROBE_TIMEOUT_MS, DEFAULT_PROBE_INTERVAL_MS, DEFAULT_MAX_RETRIES, DEFAULT_BACKOFF_BASE_MS, RETRY_RESET_AFTER_MS, ORPHAN_SIGTERM_GRACE_MS, TERMINAL_STATUSES, BINARY_MISSING_PATTERNS, N8nSidecar, _singleton, _disposing;
var init_n8n_sidecar = __esmMin((() => {
	DEFAULT_N8N_VERSION = "1.100.0";
	DEFAULT_START_PORT = 5678;
	DEFAULT_HOST = "127.0.0.1";
	DEFAULT_BINARY = "npx";
	DEFAULT_PROBE_TIMEOUT_MS = 18e4;
	DEFAULT_PROBE_INTERVAL_MS = 750;
	DEFAULT_MAX_RETRIES = 3;
	DEFAULT_BACKOFF_BASE_MS = 2e3;
	RETRY_RESET_AFTER_MS = 300 * 1e3;
	ORPHAN_SIGTERM_GRACE_MS = 5e3;
	TERMINAL_STATUSES = new Set(["stopped", "error"]);
	BINARY_MISSING_PATTERNS = [
		/^sh:\s*\d+:\s*\S+:\s*not found$/i,
		/:\s*command not found$/i,
		/\bnot found on PATH\b/i,
		/\bexited with code 127\b/i
	];
	N8nSidecar = class N8nSidecar {
		config;
		deps;
		state = {
			status: "stopped",
			host: null,
			port: null,
			errorMessage: null,
			pid: null,
			retries: 0,
			recentOutput: []
		};
		static RECENT_OUTPUT_CAP = 200;
		/** Ring buffer of the child's recent stdout/stderr lines (see state.recentOutput). */
		recentOutput = [];
		child = null;
		/** Cached API key — secret, never logged, never serialized via getState(). */
		apiKey = null;
		listeners = /* @__PURE__ */ new Set();
		stopping = false;
		supervisorRunning = false;
		/**
		* Handle for the retry-reset timer. A sidecar that stays ready for
		* RETRY_RESET_AFTER_MS is declared healthy and its retry count is zeroed
		* so a future crash doesn't count as part of the original burst.
		*/
		retryResetTimer = null;
		constructor(config = {}, deps = {}) {
			this.config = resolveConfig(config);
			this.deps = {
				spawn: deps.spawn ?? spawn,
				fetch: deps.fetch ?? fetch,
				pickPort: deps.pickPort ?? pickFreePortDefault,
				sleep: deps.sleep ?? sleepDefault,
				isProcessAlive: deps.isProcessAlive ?? isProcessAliveDefault,
				readProcessCommand: deps.readProcessCommand ?? readProcessCommandDefault,
				killPid: deps.killPid ?? killPidDefault,
				preflightBinary: deps.preflightBinary ?? preflightBinaryDefault,
				now: deps.now ?? (() => Date.now()),
				setTimer: deps.setTimer ?? ((fn, ms) => {
					const handle = setTimeout(fn, ms);
					handle.unref?.();
					return handle;
				}),
				clearTimer: deps.clearTimer ?? ((handle) => {
					if (handle) clearTimeout(handle);
				})
			};
		}
		getState() {
			return { ...this.state };
		}
		/**
		* Returns the provisioned API key. Separate from `getState()` so state
		* snapshots can be broadcast to UI/WS clients without leaking the secret.
		*/
		getApiKey() {
			return this.apiKey;
		}
		/**
		* Merge new config into the existing sidecar. Safe to call at any time.
		*
		* - If the sidecar has not been spawned yet (no child), the next call to
		*   start() will pick up the new values.
		* - If the sidecar is currently running AND a field that requires a
		*   respawn (binary, host, startPort, stateDir, version) changed, we log
		*   a warning and keep the old values live. Callers must stop() + start()
		*   explicitly to apply those changes.
		*/
		updateConfig(next) {
			const merged = resolveConfig({
				...this.snapshotConfig(),
				...next
			});
			if (!this.child) {
				this.config = merged;
				return;
			}
			const changed = [
				"binary",
				"host",
				"startPort",
				"stateDir",
				"version"
			].filter((field) => merged[field] !== this.config[field]);
			if (changed.length > 0) logger.warn(`[n8n-sidecar] updateConfig: ${changed.join(", ")} changed while sidecar is running; restart required to apply`);
			this.config = {
				...merged,
				binary: this.config.binary,
				host: this.config.host,
				startPort: this.config.startPort,
				stateDir: this.config.stateDir,
				version: this.config.version
			};
		}
		/**
		* Return the current ResolvedConfig as an N8nSidecarConfig input (used by
		* updateConfig for the merge). Excludes internal timer state.
		*/
		snapshotConfig() {
			return {
				enabled: this.config.enabled,
				version: this.config.version,
				startPort: this.config.startPort,
				host: this.config.host,
				binary: this.config.binary,
				stateDir: this.config.stateDir,
				readinessTimeoutMs: this.config.readinessTimeoutMs,
				readinessIntervalMs: this.config.readinessIntervalMs,
				maxRetries: this.config.maxRetries,
				backoffBaseMs: this.config.backoffBaseMs,
				onStatusChange: this.config.onStatusChange,
				onLog: this.config.onLog
			};
		}
		subscribe(fn) {
			this.listeners.add(fn);
			try {
				fn(this.getState());
			} catch {}
			return () => {
				this.listeners.delete(fn);
			};
		}
		emit() {
			const snapshot = this.getState();
			for (const fn of this.listeners) try {
				fn(snapshot);
			} catch {}
			try {
				this.config.onStatusChange?.(snapshot);
			} catch {}
		}
		setState(patch) {
			this.state = {
				...this.state,
				...patch
			};
			this.emit();
		}
		/**
		* Start the sidecar. Safe to call multiple times — no-ops if already
		* starting/ready. Never throws; failures mark status=error and resolve.
		*/
		async start() {
			if (!this.config.enabled) {
				this.setState({
					status: "stopped",
					errorMessage: "disabled"
				});
				return;
			}
			if (this.state.status === "starting" || this.state.status === "ready") return;
			this.stopping = false;
			this.setState({
				status: "starting",
				errorMessage: null,
				retries: 0
			});
			const supervisorPromise = this.runSupervisor();
			await new Promise((resolve) => {
				if (this.state.status === "ready" || this.state.status === "error") {
					resolve();
					return;
				}
				const unsubscribe = this.subscribe((state) => {
					if (state.status === "ready" || state.status === "error") {
						unsubscribe();
						resolve();
					}
				});
			});
			supervisorPromise.catch(() => void 0);
		}
		/**
		* Supervisor loop: spawn → probe readiness → (on crash) exponential
		* backoff. Bounded by `maxRetries`; beyond that we land in `error`.
		*/
		async runSupervisor() {
			if (this.supervisorRunning) return;
			this.supervisorRunning = true;
			try {
				while (!this.stopping) {
					try {
						try {
							mkdirSync(this.config.stateDir, { recursive: true });
						} catch (err) {
							logger.warn(`[n8n-sidecar] mkdir state dir failed: ${err instanceof Error ? err.message : String(err)}`);
						}
						const port = await this.deps.pickPort(this.config.startPort);
						const preferredHost = `http://${this.config.host}:${this.config.startPort}`;
						if (port !== this.config.startPort && await this.attachExistingInstance(preferredHost, this.config.startPort)) return;
						const host = `http://${this.config.host}:${port}`;
						this.setState({
							host,
							port
						});
						await this.deps.preflightBinary(this.config.binary);
						await this.reapOrphan();
						await this.spawnChild(port);
						await this.writePidfile(this.child?.pid ?? null);
						if (!await this.probeReadiness(host)) throw new Error(`readiness probe timed out after ${this.config.readinessTimeoutMs}ms`);
						try {
							const key = await this.ensureApiKey(host);
							if (key) {
								this.apiKey = key;
								logger.info(`[n8n-sidecar] using api key ${fingerprint(key)}`);
							}
						} catch (err) {
							logger.warn(`[n8n-sidecar] api key provisioning failed: ${err instanceof Error ? err.message : String(err)}`);
						}
						this.setState({
							status: "ready",
							errorMessage: null
						});
						this.armRetryResetTimer();
						await this.waitForChildExitWithTimeout();
						this.cancelRetryResetTimer();
						if (this.stopping) return;
						logger.warn("[n8n-sidecar] child exited unexpectedly");
						this.setState({
							status: "starting",
							pid: null
						});
					} catch (err) {
						const msg = err instanceof Error ? err.message : String(err);
						await this.clearNpmCacheAfterJsonParseFailure();
						if (isBinaryMissingMessage(msg)) logger.debug(`[n8n-sidecar] start attempt failed: ${msg}`);
						else logger.warn(`[n8n-sidecar] start attempt failed: ${msg}`);
						this.cancelRetryResetTimer();
						this.setState({
							status: "starting",
							errorMessage: msg,
							pid: null
						});
						this.killChild();
					}
					if (this.stopping) return;
					const nextRetries = this.state.retries + 1;
					if (nextRetries > this.config.maxRetries) {
						this.setState({
							status: "error",
							errorMessage: this.state.errorMessage ?? "max retries exceeded",
							retries: nextRetries
						});
						return;
					}
					const backoff = this.config.backoffBaseMs * 2 ** (nextRetries - 1);
					this.setState({ retries: nextRetries });
					await this.deps.sleep(backoff);
				}
			} finally {
				this.supervisorRunning = false;
			}
		}
		async spawnChild(port) {
			const npmCacheDir = path.join(this.config.stateDir, ".npm-cache");
			mkdirSync(npmCacheDir, { recursive: true });
			const env = {
				...process.env,
				NODE_ENV: "production",
				N8N_PORT: String(port),
				N8N_HOST: this.config.host,
				N8N_PROTOCOL: "http",
				N8N_USER_MANAGEMENT_DISABLED: "true",
				N8N_DIAGNOSTICS_ENABLED: "false",
				N8N_VERSION_NOTIFICATIONS_ENABLED: "false",
				N8N_PERSONALIZATION_ENABLED: "false",
				N8N_HIRING_BANNER_ENABLED: "false",
				N8N_USER_FOLDER: this.config.stateDir,
				NPM_CONFIG_CACHE: npmCacheDir,
				npm_config_cache: npmCacheDir,
				DB_TYPE: "sqlite",
				DB_SQLITE_DATABASE: path.join(this.config.stateDir, "database.sqlite"),
				N8N_DISABLED_MODULES: "insights,external-secrets"
			};
			const versioned = `n8n@${this.config.version}`;
			const binaryBase = this.config.binary.split("/").pop() ?? this.config.binary;
			const launcherArgs = binaryBase === "npx" ? [
				"--yes",
				versioned,
				"start"
			] : binaryBase === "bunx" ? [
				"--",
				versioned,
				"start"
			] : [versioned, "start"];
			this.recordOutput(`[spawn] ${this.config.binary} ${launcherArgs.join(" ")} (port ${port}, stateDir ${this.config.stateDir}, npmCache ${npmCacheDir}, NODE_ENV=${env.NODE_ENV ?? "(unset)"}, PATH len=${(env.PATH ?? "").length})`);
			const child = this.deps.spawn(this.config.binary, launcherArgs, {
				cwd: this.config.stateDir,
				env,
				stdio: [
					"ignore",
					"pipe",
					"pipe"
				],
				detached: false
			});
			this.child = child;
			this.setState({ pid: child.pid ?? null });
			const captureOutput = (chunk, stream) => {
				const text = chunk.toString();
				for (const line of text.split("\n")) {
					const trimmed = line.trimEnd();
					if (!trimmed) continue;
					this.recordOutput(`[${stream}] ${trimmed}`);
					if (stream === "stderr") if (isBinaryMissingMessage(trimmed)) logger.debug(`[n8n-sidecar:stderr] ${trimmed}`);
					else logger.warn(`[n8n-sidecar:stderr] ${trimmed}`);
					else logger.debug(`[n8n-sidecar:stdout] ${trimmed}`);
					try {
						this.config.onLog?.(trimmed, stream);
					} catch {}
				}
			};
			child.stdout?.on("data", (buf) => captureOutput(buf, "stdout"));
			child.stderr?.on("data", (buf) => captureOutput(buf, "stderr"));
			child.on("close", (code, signal) => {
				const summary = code !== null ? `exit code ${code}` : signal !== null ? `signal ${signal}` : "exit (no code/signal)";
				this.recordOutput(`[exit] n8n child ${summary}`);
			});
			child.on("error", (err) => {
				this.recordOutput(`[error] spawn error: ${err.message}`);
				logger.warn(`[n8n-sidecar] spawn error: ${err.message}`);
			});
		}
		/** Push a line into the bounded recent-output buffer and publish. */
		recordOutput(line) {
			this.recentOutput.push(line);
			if (this.recentOutput.length > N8nSidecar.RECENT_OUTPUT_CAP) this.recentOutput.splice(0, this.recentOutput.length - N8nSidecar.RECENT_OUTPUT_CAP);
			this.state = {
				...this.state,
				recentOutput: [...this.recentOutput]
			};
		}
		async clearNpmCacheAfterJsonParseFailure() {
			if (!this.recentOutput.some((line) => line.includes("EJSONPARSE") || line.includes("Invalid package.json") || line.includes("JSON.parse"))) return;
			const npmCacheDir = path.join(this.config.stateDir, ".npm-cache");
			try {
				await fs$1.rm(npmCacheDir, {
					recursive: true,
					force: true
				});
				logger.warn(`[n8n-sidecar] cleared npm cache after package.json parse failure: ${npmCacheDir}`);
			} catch (err) {
				logger.warn(`[n8n-sidecar] failed to clear npm cache after package.json parse failure: ${err instanceof Error ? err.message : String(err)}`);
			}
		}
		/**
		* Block until the current child exits. Returns early if the child is null
		* or if `stop()` has flipped `stopping`. No timeout — n8n is a long-running
		* service, so timing out here would SIGKILL a healthy child and bounce the
		* supervisor into a "child exited unexpectedly" → retry loop that ends in
		* the `max retries exceeded` error state. Shutdown-side timeouts live in
		* `killChild()` (SIGTERM with a 5s SIGKILL fallback).
		*/
		waitForChildExitWithTimeout() {
			return new Promise((resolve) => {
				const child = this.child;
				if (!child) {
					resolve();
					return;
				}
				if (this.stopping) {
					resolve();
					return;
				}
				const settle = () => {
					child.removeListener("exit", onExit);
					resolve();
				};
				const onExit = () => settle();
				child.once("exit", onExit);
			});
		}
		killChild() {
			const child = this.child;
			this.child = null;
			if (!child) return;
			try {
				child.kill("SIGTERM");
				setTimeout(() => {
					if (!child.killed) try {
						child.kill("SIGKILL");
					} catch {}
				}, 5e3).unref?.();
			} catch (err) {
				logger.warn(`[n8n-sidecar] kill error: ${err instanceof Error ? err.message : String(err)}`);
			}
		}
		async attachExistingInstance(host, port) {
			if (!await this.probeExistingInstance(host)) return false;
			this.child = null;
			this.recordOutput(`[attach] existing n8n detected at ${host}; reusing it`);
			logger.info(`[n8n-sidecar] reusing existing n8n at ${host}`);
			this.setState({
				host,
				port,
				pid: null
			});
			try {
				const key = await this.ensureApiKey(host);
				if (key) {
					this.apiKey = key;
					logger.info(`[n8n-sidecar] using api key ${fingerprint(key)}`);
				}
			} catch (err) {
				logger.warn(`[n8n-sidecar] api key provisioning failed: ${err instanceof Error ? err.message : String(err)}`);
			}
			this.setState({
				status: "ready",
				errorMessage: null
			});
			this.armRetryResetTimer();
			return true;
		}
		async probeExistingInstance(host) {
			try {
				const res = await this.deps.fetch(`${host}/rest/login`, {
					method: "GET",
					signal: AbortSignal.timeout(2e3)
				});
				return res.status === 200 || res.status === 401;
			} catch {
				return false;
			}
		}
		/**
		* Polls GET {host}/rest/login until 200 or 401 (both mean "up"). 503
		* means "still booting". Times out per `readinessTimeoutMs`.
		*
		* Returns true on success, false on timeout.
		*/
		async probeReadiness(host) {
			const deadline = Date.now() + this.config.readinessTimeoutMs;
			const url = `${host}/rest/login`;
			while (Date.now() < deadline) {
				if (this.stopping) return false;
				const child = this.child;
				if (child && typeof child.exitCode === "number" && child.exitCode !== 0) throw new Error(`n8n child exited with code ${child.exitCode} before readiness probe succeeded`);
				try {
					const res = await this.deps.fetch(url, {
						method: "GET",
						signal: AbortSignal.timeout(2e3)
					});
					if (res.status === 200 || res.status === 401) return true;
				} catch {}
				await this.deps.sleep(this.config.readinessIntervalMs);
			}
			return false;
		}
		/**
		* Resolve an API key for this sidecar.
		*
		* Strategy:
		*   1. If a key is cached on the filesystem at {stateDir}/api-key, try
		*      it first. If /rest/api-keys accepts it, reuse it — this preserves
		*      webhook configs across restarts.
		*   2. Otherwise provision a new key via /rest/me/api-keys and persist
		*      it mode-600 for the next boot.
		*   3. If everything fails, return null. The caller logs a warning but
		*      does not fail readiness.
		*/
		async ensureApiKey(host) {
			const cached = await this.loadPersistedApiKey();
			if (cached) {
				if (await this.validateApiKey(host, cached)) return cached;
				logger.warn("[n8n-sidecar] cached api key rejected; re-provisioning");
			}
			const fresh = await this.provisionApiKey(host);
			if (fresh) await this.persistApiKey(fresh);
			return fresh;
		}
		apiKeyPath() {
			return path.join(this.config.stateDir, "api-key");
		}
		async loadPersistedApiKey() {
			const raw = await fs$1.readFile(this.apiKeyPath(), "utf-8").catch(() => null);
			if (!raw) return null;
			const trimmed = raw.trim();
			return trimmed.length ? trimmed : null;
		}
		async persistApiKey(key) {
			try {
				await fs$1.mkdir(this.config.stateDir, { recursive: true });
				await fs$1.writeFile(this.apiKeyPath(), key, { mode: 384 });
				await fs$1.chmod(this.apiKeyPath(), 384).catch(() => void 0);
			} catch (err) {
				logger.warn(`[n8n-sidecar] failed to persist api key: ${err instanceof Error ? err.message : String(err)}`);
			}
		}
		/**
		* Validate a cached API key by calling the public REST API that accepts
		* the X-N8N-API-KEY header. A 2xx means the key is still live; 401/403
		* means it was revoked.
		*
		* Important: /rest/api-keys is the internal endpoint that requires the
		* JWT cookie and will always 401 for an X-N8N-API-KEY regardless of
		* whether the key itself is valid. Using /api/v1/workflows instead —
		* the same endpoint the proxy hits, so "valid for probe" = "valid for
		* real traffic".
		*/
		async validateApiKey(host, key) {
			try {
				return (await this.deps.fetch(`${host}/api/v1/workflows?limit=1`, {
					method: "GET",
					headers: { "X-N8N-API-KEY": key },
					signal: AbortSignal.timeout(5e3)
				})).ok;
			} catch {
				return false;
			}
		}
		/**
		* Provision an API key by driving n8n's owner-setup → login → api-key flow.
		*
		* n8n ≥ 1.90-ish removed the anonymous `/rest/me/api-keys` endpoint. The
		* supported path now requires:
		*   1. POST /rest/owner/setup   { email, firstName, lastName, password }
		*      – returns `Set-Cookie: n8n-auth=<JWT>` when no owner exists yet.
		*   2. POST /rest/login         { emailOrLdapLoginId, password }
		*      – returns the same cookie on restarts, once the owner is set.
		*   3. GET  /rest/api-keys/scopes
		*      – enumerates the scopes the current role is allowed to grant.
		*   4. POST /rest/api-keys      { label, scopes, expiresAt: null }
		*      – returns `data.rawApiKey` which stays valid across restarts until
		*        explicitly revoked.
		*
		* Credentials are persisted to `{stateDir}/owner.json` (mode-600) so the
		* same login works on every subsequent boot; we never re-generate. Password
		* is random per install — there's no user-facing n8n UI flow in Eliza, so
		* storing it here is safe for a local single-user sidecar.
		*/
		async provisionApiKey(host) {
			const log = (msg) => {
				logger.warn(`[n8n-sidecar] ${msg}`);
				this.recordOutput(`[provisionApiKey] ${msg}`);
			};
			try {
				const owner = await this.loadOrCreateOwnerCreds();
				const cookie = await this.acquireOwnerCookie(host, owner, log);
				if (!cookie) {
					log("acquireOwnerCookie returned null — cannot create api key");
					return null;
				}
				const scopes = await this.fetchApiKeyScopes(host, cookie);
				if (!scopes || scopes.length === 0) {
					log("/rest/api-keys/scopes returned no scopes");
					return null;
				}
				const label = "eliza-sidecar";
				const createKey = async () => this.deps.fetch(`${host}/rest/api-keys`, {
					method: "POST",
					headers: {
						"content-type": "application/json",
						cookie
					},
					body: JSON.stringify({
						label,
						scopes,
						expiresAt: null
					}),
					signal: AbortSignal.timeout(5e3)
				});
				let res = await createKey();
				if (!res.ok) {
					const bodyText = await res.text().catch(() => "");
					if (res.status === 500 && /already\s+an?\s+entry\s+with\s+this\s+name/i.test(bodyText)) {
						log("api-key label already exists in n8n — deleting and re-creating");
						if (await this.deleteApiKeysByLabel(host, cookie, label) > 0) res = await createKey();
					}
					if (!res.ok) {
						const finalBody = bodyText || await res.text().catch(() => "");
						log(`api-key create failed: ${res.status} ${res.statusText}${finalBody ? ` — ${finalBody.slice(0, 200)}` : ""}`);
						return null;
					}
				}
				const body = await res.json();
				const key = body.data?.rawApiKey ?? body.data?.apiKey ?? body.rawApiKey ?? body.apiKey ?? null;
				if (!key) log("api-key create returned no rawApiKey in body");
				return key;
			} catch (err) {
				log(`provisionApiKey threw: ${err instanceof Error ? err.message : String(err)}`);
				return null;
			}
		}
		/**
		* Load owner credentials from `{stateDir}/owner.json`, or generate a fresh
		* pair and persist them mode-600. The email is deterministic (matches the
		* label we show to the user); the password is a long random token.
		*/
		async loadOrCreateOwnerCreds() {
			const ownerPath = path.join(this.config.stateDir, "owner.json");
			try {
				const raw = await fs$1.readFile(ownerPath, "utf-8");
				const parsed = JSON.parse(raw);
				if (typeof parsed.email === "string" && typeof parsed.password === "string" && parsed.email.length > 0 && parsed.password.length > 0) return {
					email: parsed.email,
					firstName: typeof parsed.firstName === "string" ? parsed.firstName : "Eliza",
					lastName: typeof parsed.lastName === "string" ? parsed.lastName : "Local",
					password: parsed.password
				};
			} catch {}
			const creds = {
				email: "eliza@eliza.local",
				firstName: "Eliza",
				lastName: "Local",
				password: this.generateRandomPassword()
			};
			try {
				await fs$1.mkdir(this.config.stateDir, { recursive: true });
				await fs$1.writeFile(ownerPath, JSON.stringify(creds, null, 2), { mode: 384 });
				await fs$1.chmod(ownerPath, 384).catch(() => void 0);
			} catch (err) {
				logger.warn(`[n8n-sidecar] failed to persist owner creds: ${err instanceof Error ? err.message : String(err)}`);
			}
			return creds;
		}
		/**
		* Returns a `Cookie: n8n-auth=<jwt>` string by either creating the owner
		* (first boot) or logging in (subsequent boots). Returns null if both
		* fail so the caller can back off gracefully.
		*/
		async acquireOwnerCookie(host, owner, log = () => void 0) {
			const setup = await this.deps.fetch(`${host}/rest/owner/setup`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					email: owner.email,
					firstName: owner.firstName,
					lastName: owner.lastName,
					password: owner.password
				}),
				signal: AbortSignal.timeout(1e4)
			}).catch((err) => {
				log(`owner/setup fetch threw: ${err instanceof Error ? err.message : String(err)}`);
				return null;
			});
			if (setup?.ok) {
				const cookie = extractAuthCookie$1(setup);
				if (cookie) return cookie;
				log("owner/setup 200 but no n8n-auth cookie in response");
			} else if (setup) {
				const text = await setup.text().catch(() => "");
				log(`owner/setup ${setup.status}${text ? ` — ${text.slice(0, 160)}` : ""}`);
			}
			const login = await this.deps.fetch(`${host}/rest/login`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					emailOrLdapLoginId: owner.email,
					password: owner.password
				}),
				signal: AbortSignal.timeout(1e4)
			}).catch((err) => {
				log(`login fetch threw: ${err instanceof Error ? err.message : String(err)}`);
				return null;
			});
			if (login?.ok) {
				const cookie = extractAuthCookie$1(login);
				if (cookie) return cookie;
				log("login 200 but no n8n-auth cookie in response");
			} else if (login) {
				const text = await login.text().catch(() => "");
				log(`login ${login.status}${text ? ` — ${text.slice(0, 160)}` : ""}`);
			}
			return null;
		}
		/** List scopes the current role may grant when creating an API key. */
		async fetchApiKeyScopes(host, cookie) {
			try {
				const res = await this.deps.fetch(`${host}/rest/api-keys/scopes`, {
					method: "GET",
					headers: { cookie },
					signal: AbortSignal.timeout(5e3)
				});
				if (!res.ok) return null;
				const body = await res.json();
				return Array.isArray(body.data) ? body.data : null;
			} catch {
				return null;
			}
		}
		/**
		* Delete every api-key row with a matching label. Used to recover from the
		* "already exists" case when a previous provisioning run created the label
		* but lost the `rawApiKey` (n8n only returns the raw key at creation time,
		* so a partially-persisted state wedges the next boot unless we can delete
		* and re-create). Returns the number of rows deleted.
		*/
		async deleteApiKeysByLabel(host, cookie, label) {
			try {
				const listRes = await this.deps.fetch(`${host}/rest/api-keys`, {
					method: "GET",
					headers: { cookie },
					signal: AbortSignal.timeout(5e3)
				});
				if (!listRes.ok) return 0;
				const matches = ((await listRes.json()).data ?? []).filter((row) => typeof row.id === "string" && typeof row.label === "string" && row.label === label);
				let deleted = 0;
				for (const row of matches) if ((await this.deps.fetch(`${host}/rest/api-keys/${encodeURIComponent(row.id)}`, {
					method: "DELETE",
					headers: { cookie },
					signal: AbortSignal.timeout(5e3)
				})).ok) deleted += 1;
				return deleted;
			} catch {
				return 0;
			}
		}
		/** 48 bytes of base64url entropy — ~64 chars, far above n8n's min length. */
		generateRandomPassword() {
			return __require("node:crypto").randomBytes(48).toString("base64url");
		}
		/** Stop the sidecar. Idempotent. */
		async stop() {
			this.stopping = true;
			this.cancelRetryResetTimer();
			this.killChild();
			await this.removePidfile();
			this.setState({
				status: "stopped",
				host: null,
				port: null,
				pid: null,
				errorMessage: null,
				retries: 0
			});
			this.apiKey = null;
		}
		/** Public helper so callers can gate feature activation on running state. */
		isRunning() {
			return !TERMINAL_STATUSES.has(this.state.status);
		}
		pidfilePath() {
			return path.join(this.config.stateDir, "pid");
		}
		async readPidfile() {
			const raw = await fs$1.readFile(this.pidfilePath(), "utf-8").catch(() => null);
			if (!raw) return null;
			const parsed = Number.parseInt(raw.trim(), 10);
			return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
		}
		async writePidfile(pid) {
			if (pid === null) return;
			try {
				await fs$1.mkdir(this.config.stateDir, { recursive: true });
				await fs$1.writeFile(this.pidfilePath(), String(pid), { mode: 384 });
			} catch (err) {
				logger.warn(`[n8n-sidecar] failed to write pidfile: ${err instanceof Error ? err.message : String(err)}`);
			}
		}
		async removePidfile() {
			await fs$1.unlink(this.pidfilePath()).catch(() => void 0);
		}
		/**
		* If the pidfile points at a live n8n process, kill it before spawning.
		* Guards against orphans created by SIGKILL'ing the parent — without this,
		* each cold boot leaks a port and eventually a zombie per start.
		*
		* We do two levels of verification to avoid nuking an unrelated pid that
		* may have been reused by the OS:
		*   1. The pid must be alive.
		*   2. The pid's cmdline must mention "n8n".
		*/
		async reapOrphan() {
			const pid = await this.readPidfile();
			if (pid === null) return;
			if (!this.deps.isProcessAlive(pid)) {
				await this.removePidfile();
				return;
			}
			const cmd = await this.deps.readProcessCommand(pid);
			if (!cmd || !/n8n/i.test(cmd)) {
				await this.removePidfile();
				return;
			}
			logger.warn(`[n8n-sidecar] reaping orphan n8n pid=${pid} before spawn (cmd=${cmd.slice(0, 120)})`);
			this.deps.killPid(pid, "SIGTERM");
			const deadline = this.deps.now() + ORPHAN_SIGTERM_GRACE_MS;
			while (this.deps.now() < deadline) {
				if (!this.deps.isProcessAlive(pid)) {
					await this.removePidfile();
					return;
				}
				await this.deps.sleep(250);
			}
			if (this.deps.isProcessAlive(pid)) {
				logger.warn(`[n8n-sidecar] orphan pid=${pid} survived SIGTERM; SIGKILL`);
				this.deps.killPid(pid, "SIGKILL");
			}
			await this.removePidfile();
		}
		armRetryResetTimer() {
			this.cancelRetryResetTimer();
			this.retryResetTimer = this.deps.setTimer(() => {
				this.retryResetTimer = null;
				if (this.state.status === "ready" && this.state.retries !== 0) {
					logger.info("[n8n-sidecar] retry count reset after sustained healthy uptime");
					this.setState({ retries: 0 });
				}
			}, RETRY_RESET_AFTER_MS);
		}
		cancelRetryResetTimer() {
			if (this.retryResetTimer !== null) {
				this.deps.clearTimer(this.retryResetTimer);
				this.retryResetTimer = null;
			}
		}
	};
	_singleton = null;
	_disposing = null;
}));

//#endregion
//#region node_modules/.bun/@elizaos+app-core@2.0.0-alpha.537+72829346cb4c43b1/node_modules/@elizaos/app-core/packages/app-core/src/services/n8n-auth-bridge.js
/**
* n8n auth bridge — wires Eliza Cloud auth-state transitions to the local
* n8n sidecar lifecycle.
*
* Motivation: when a user signs in to Eliza Cloud we route workflows
* through the cloud gateway, so the local sidecar is dead weight (port
* 5678, ~200MB RAM, a child Node/n8n process). When they sign out, we
* want the local sidecar back — but only when `config.n8n.localEnabled`
* is set and we are not running on a mobile shell (where no local
* runtime exists).
*
* CLOUD_AUTH (from @elizaos/plugin-elizacloud) does not expose a native
* observable; `isAuthenticated()` is read synchronously. We therefore
* poll that method on a short interval and emit transitions. A 2s
* debounce window guards against flap during init or token refresh.
*
* Lifecycle contract:
*   - unauth → auth:
*       if peekN8nSidecar() status is "starting" or "ready",
*       call disposeN8nSidecar().
*   - auth → unauth:
*       if config.n8n.localEnabled and not mobile,
*       call getN8nSidecar(resolvedConfig).start().
*
* This bridge never throws; subscription failures are logged and
* swallowed so boot cannot be broken by sidecar lifecycle hiccups.
*/
var n8n_auth_bridge_exports = /* @__PURE__ */ __exportAll({ startN8nAuthBridge: () => startN8nAuthBridge });
function readCloudAuth(runtime) {
	if (!runtime || typeof runtime.getService !== "function") return null;
	const service = runtime.getService("CLOUD_AUTH");
	return service && typeof service === "object" ? service : null;
}
function readIsAuthenticated(runtime) {
	const auth = readCloudAuth(runtime);
	return Boolean(auth?.isAuthenticated?.());
}
function resolveSidecarConfig$1(cfg) {
	const sidecar = { enabled: cfg.n8n?.localEnabled ?? true };
	if (cfg.n8n?.version) sidecar.version = cfg.n8n.version;
	if (typeof cfg.n8n?.startPort === "number") sidecar.startPort = cfg.n8n.startPort;
	return sidecar;
}
/**
* Start an auth-state bridge that reacts to Eliza Cloud login/logout and
* manages the local n8n sidecar accordingly.
*
* The caller owns lifetime — call `stop()` on shutdown.
*/
function startN8nAuthBridge(runtime, config, options = {}) {
	const pollIntervalMs = options.pollIntervalMs ?? 1e3;
	const debounceMs = options.debounceMs ?? 2e3;
	const isMobile = options.isMobile ?? (() => false);
	const getConfig = options.getConfig ?? (() => config);
	let lastState = readIsAuthenticated(runtime);
	let lastTransitionAt = 0;
	let stopped = false;
	const handleTransition = (next) => {
		const now = Date.now();
		if (lastTransitionAt > 0 && now - lastTransitionAt < debounceMs) {
			logger.debug(`[n8n-auth-bridge] ignoring transition ${lastState}→${next} (debounced ${now - lastTransitionAt}ms < ${debounceMs}ms)`);
			return;
		}
		const prev = lastState;
		lastState = next;
		lastTransitionAt = now;
		if (prev === false && next === true) {
			const sidecar = peekN8nSidecar();
			const status = sidecar?.getState().status;
			if (sidecar && (status === "starting" || status === "ready")) {
				logger.info("[n8n] cloud authenticated — releasing local sidecar");
				disposeN8nSidecar().catch((err) => {
					logger.warn(`[n8n-auth-bridge] disposeN8nSidecar failed: ${err instanceof Error ? err.message : String(err)}`);
				});
			}
			return;
		}
		if (prev === true && next === false) {
			const cfg = getConfig();
			if (!(cfg.n8n?.localEnabled ?? false)) return;
			if (isMobile()) return;
			logger.info("[n8n] cloud signed out — starting local sidecar");
			getN8nSidecar(resolveSidecarConfig$1(cfg)).start().catch((err) => {
				logger.warn(`[n8n-auth-bridge] sidecar.start failed: ${err instanceof Error ? err.message : String(err)}`);
			});
		}
	};
	const tick = () => {
		if (stopped) return;
		const next = readIsAuthenticated(runtime);
		if (next !== lastState) handleTransition(next);
	};
	const timer = setInterval(tick, pollIntervalMs);
	if (typeof timer.unref === "function") timer.unref();
	return {
		stop: () => {
			if (stopped) return;
			stopped = true;
			clearInterval(timer);
		},
		poke: () => {
			tick();
			return lastState;
		}
	};
}
var init_n8n_auth_bridge = __esmMin((() => {
	init_n8n_sidecar();
}));

//#endregion
//#region node_modules/.bun/@elizaos+app-core@2.0.0-alpha.537+72829346cb4c43b1/node_modules/@elizaos/app-core/packages/app-core/src/services/n8n-mode.js
/**
* Shared n8n mode resolution — cloud vs local vs disabled.
*
* Used by the HTTP routes to report state and by the autostart bridge to
* decide whether to spawn the local sidecar at runtime boot. Keeping the
* decision in one place ensures the UI status surface and the boot-time
* spawn stay in lockstep.
*
* Desired mode is a pure function of:
*   - cloud auth state (CLOUD_AUTH.isAuthenticated() or config.cloud.apiKey)
*   - config.n8n.localEnabled
*   - whether we are on a mobile (Capacitor) shell where the sidecar
*     cannot run regardless of user setting
*/
/**
* Returns true when a cloud session is usable for n8n. Mirrors the
* semantics used by cloud-status-routes: a live CLOUD_AUTH service counts,
* and a configured API key is accepted as a fallback even without a
* runtime service (matches the dev path where the service is not yet
* registered but credentials are present).
*/
function isCloudConnected(config, runtime) {
	if (!config.cloud?.enabled) return false;
	if ((runtime && typeof runtime.getService === "function" ? runtime.getService("CLOUD_AUTH") : null)?.isAuthenticated?.()) return true;
	return Boolean(config.cloud.apiKey?.trim());
}
/**
* Pure mode resolver. No side effects, no I/O — safe to call from any
* context (route handler, autostart tick, status probe).
*/
function resolveN8nMode(input) {
	const { config, runtime, native } = input;
	const cloudConnected = isCloudConnected(config, runtime);
	const localEnabled = native ? false : config.n8n?.localEnabled ?? true;
	let mode;
	if (cloudConnected) mode = "cloud";
	else if (localEnabled) mode = "local";
	else mode = "disabled";
	return {
		mode,
		localEnabled,
		cloudConnected
	};
}
var init_n8n_mode = __esmMin((() => {}));

//#endregion
//#region node_modules/.bun/@elizaos+app-core@2.0.0-alpha.537+72829346cb4c43b1/node_modules/@elizaos/app-core/packages/app-core/src/services/n8n-autostart.js
/**
* n8n autostart — boot-time sidecar spawn.
*
* Motivation: previously the local n8n sidecar was only spawned lazily
* when the user opened the Workflows tab (N8nWorkflowsPanel → `POST
* /api/n8n/sidecar/start`). That meant the first workflow action paid a
* cold-start tax (~10-20s of `bunx n8n@<pinned>`) and any scheduled job
* that tried to dispatch a workflow before the user ever visited the tab
* would fail. We now kick the sidecar off at agent boot when the desired
* mode is "local".
*
* Desired state is computed via the shared `resolveN8nMode` helper:
*   - mode === "local" AND no sidecar already spawned → start one.
*   - otherwise → do nothing. The auth bridge owns the dispose-on-signin
*     path; we do not stop anything here.
*
* Lifecycle contract:
*   - First tick runs 50ms after `startN8nAutoStart()` returns so the
*     caller (repairRuntimeAfterBoot) can finish the rest of its work
*     without blocking on `bunx n8n` spawning.
*   - Failures are caught and logged. The runtime must never fail boot
*     because the n8n sidecar could not start.
*   - `poke()` re-evaluates immediately — used after config hot-reload.
*   - `stop()` is idempotent and cancels any pending first-tick timer.
*/
var n8n_autostart_exports = /* @__PURE__ */ __exportAll({ startN8nAutoStart: () => startN8nAutoStart });
function resolveSidecarConfig(cfg) {
	const sidecar = { enabled: cfg.n8n?.localEnabled ?? true };
	if (cfg.n8n?.version) sidecar.version = cfg.n8n.version;
	if (typeof cfg.n8n?.startPort === "number") sidecar.startPort = cfg.n8n.startPort;
	return sidecar;
}
/**
* Start the autostart handle. Returns a handle whose lifecycle the
* caller owns. Never throws — failures to spawn log a warning and leave
* the sidecar un-started so the UI can still fall back to the lazy
* Workflows-tab path.
*/
function startN8nAutoStart(runtime, config, options = {}) {
	const initialDelayMs = options.initialDelayMs ?? 50;
	const isMobile = options.isMobile ?? (() => isNativeServerPlatform());
	const getConfig = options.getConfig ?? (() => config);
	const getSidecar = options.getSidecar ?? getN8nSidecarAsync;
	const peekSidecar = options.peekSidecar ?? peekN8nSidecar;
	const setTimer = options.setTimer ?? ((fn, ms) => {
		const handle = setTimeout(fn, ms);
		handle.unref?.();
		return handle;
	});
	const clearTimer = options.clearTimer ?? ((handle) => {
		if (handle) clearTimeout(handle);
	});
	let stopped = false;
	let firstTickTimer = null;
	const evaluate = async () => {
		if (stopped) return;
		const cfg = getConfig();
		const { mode } = resolveN8nMode({
			config: cfg,
			runtime,
			native: isMobile()
		});
		if (mode !== "local") {
			logger.debug(`[n8n-autostart] desired mode=${mode} — skipping boot spawn`);
			return;
		}
		const existing = peekSidecar();
		const existingStatus = existing?.getState().status;
		if (existing && (existingStatus === "starting" || existingStatus === "ready")) {
			logger.debug(`[n8n-autostart] sidecar already ${existingStatus} — skipping boot spawn`);
			return;
		}
		logger.info("[n8n] auto-starting local sidecar at boot");
		try {
			(await getSidecar(resolveSidecarConfig(cfg))).start().catch((err) => {
				logger.warn(`[n8n-autostart] boot start failed: ${err instanceof Error ? err.message : String(err)}`);
			});
		} catch (err) {
			logger.warn(`[n8n-autostart] boot start failed: ${err instanceof Error ? err.message : String(err)}`);
		}
	};
	firstTickTimer = setTimer(() => {
		firstTickTimer = null;
		evaluate();
	}, initialDelayMs);
	return {
		stop: async () => {
			if (stopped) return;
			stopped = true;
			if (firstTickTimer !== null) {
				clearTimer(firstTickTimer);
				firstTickTimer = null;
			}
		},
		poke: async () => {
			if (stopped) return;
			if (firstTickTimer !== null) {
				clearTimer(firstTickTimer);
				firstTickTimer = null;
			}
			await evaluate();
		}
	};
}
var init_n8n_autostart = __esmMin((() => {
	init_is_native_server();
	init_n8n_mode();
	init_n8n_sidecar();
}));

//#endregion
//#region node_modules/.bun/@elizaos+app-core@2.0.0-alpha.537+72829346cb4c43b1/node_modules/@elizaos/app-core/packages/app-core/src/services/n8n-dispatch.js
/**
* n8n dispatch service — executes an n8n workflow by id.
*
* Consumed by the trigger dispatcher (Track F1) at boot: triggers carrying
* `kind: "workflow"` resolve a workflow id and call
*   runtime.getService("N8N_DISPATCH").execute(workflowId).
*
* Mode selection mirrors n8n-routes proxy:
*   - Cloud mode → POST ${cloudBaseUrl}/api/v1/agents/${agentId}/n8n/workflows/{id}/execute
*                  Authorization: Bearer ${cloud.apiKey}
*   - Local mode → GET workflow via /api/v1 with X-N8N-API-KEY, then
*                  POST ${sidecar.host}/rest/workflows/{id}/run with the
*                  local owner n8n-auth cookie. n8n's manual run endpoint is
*                  an internal UI route and does not accept API-key auth.
*   - Disabled   → immediate `{ ok: false, error: "n8n disabled" }` (no fetch)
*
* This module is I/O only — it does not own the sidecar lifecycle, and
* does not probe readiness. Readiness for the local path is asserted by the
* presence of a host + api key; callers that want a readiness guarantee
* should ensure the autostart handle has completed before dispatch.
*/
var n8n_dispatch_exports = /* @__PURE__ */ __exportAll({ createN8nDispatchService: () => createN8nDispatchService });
function normalizeBaseUrl$1(raw) {
	const trimmed = (raw ?? "").trim();
	return (trimmed.length > 0 ? trimmed : DEFAULT_CLOUD_API_BASE_URL$2).replace(/\/+$/, "");
}
function defaultResolveAgentId(runtime) {
	const ref = runtime;
	return ref.agentId ?? ref.character?.id ?? ZERO_AGENT_ID;
}
function defaultStateDir() {
	const home = process.env.HOME ?? process.env.USERPROFILE ?? os.tmpdir();
	return path.join(home, ".eliza", "n8n");
}
function extractAuthCookie(res) {
	const headers = res.headers;
	const list = typeof headers.getSetCookie === "function" ? headers.getSetCookie() : (headers.get("set-cookie") ?? "").split(/,(?=\s*[\w-]+=)/).filter((value) => value.length > 0);
	for (const raw of list) {
		const first = raw.split(";")[0]?.trim();
		if (first?.startsWith("n8n-auth=")) return first;
	}
	return null;
}
async function defaultGetLocalOwnerCookie(host, config) {
	const stateDir = config.n8n?.stateDir?.trim() || defaultStateDir();
	const ownerPath = path.join(stateDir, "owner.json");
	let owner;
	try {
		owner = JSON.parse(await fs$1.readFile(ownerPath, "utf-8"));
	} catch (error) {
		logger.warn(`[n8n-dispatch] failed to read local n8n owner credentials: ${error instanceof Error ? error.message : String(error)}`);
		return null;
	}
	if (typeof owner.email !== "string" || typeof owner.password !== "string") return null;
	const response = await fetch(`${host.replace(/\/+$/, "")}/rest/login`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({
			emailOrLdapLoginId: owner.email,
			password: owner.password
		}),
		signal: AbortSignal.timeout(1e4)
	}).catch((error) => {
		logger.warn(`[n8n-dispatch] local n8n owner login failed: ${error instanceof Error ? error.message : String(error)}`);
		return null;
	});
	return response?.ok ? extractAuthCookie(response) : null;
}
function extractExecutionId(body) {
	if (!body || typeof body !== "object") return void 0;
	const obj = body;
	const candidates = [obj.executionId, obj.execution_id];
	const data = obj.data;
	if (data && typeof data === "object") {
		const dataObj = data;
		candidates.push(dataObj.executionId, dataObj.execution_id, dataObj.id);
	}
	for (const c of candidates) if (typeof c === "string" && c.length > 0) return c;
}
async function readJsonBody$2(res) {
	if (!(res.headers.get("content-type") ?? "").includes("application/json")) return null;
	try {
		return await res.json();
	} catch {
		return null;
	}
}
function extractWorkflowBody(body) {
	if (!body || typeof body !== "object") return null;
	const obj = body;
	if (obj.data && typeof obj.data === "object") return obj.data;
	return obj;
}
/**
* Construct the dispatch service. The returned value is registered under
* `"N8N_DISPATCH"` on the runtime by `ensureN8nDispatchService` in
* runtime/eliza.ts.
*/
function createN8nDispatchService(options) {
	const { runtime, getConfig, fetchImpl = fetch, isNativePlatform = isNativeServerPlatform, peekSidecar = peekN8nSidecar, resolveAgentId = defaultResolveAgentId, getLocalOwnerCookie = defaultGetLocalOwnerCookie } = options;
	const execute = async (workflowId, payload = {}) => {
		const id = workflowId.trim();
		if (!id) return {
			ok: false,
			error: "workflow id required"
		};
		const config = getConfig();
		const { mode } = resolveN8nMode({
			config,
			runtime,
			native: isNativePlatform()
		});
		if (mode === "disabled") return {
			ok: false,
			error: "n8n disabled"
		};
		let url;
		let headers;
		let requestBody = payload;
		if (mode === "cloud") {
			const apiKey = config.cloud?.apiKey?.trim();
			if (!apiKey) return {
				ok: false,
				error: "n8n cloud api key missing"
			};
			const baseUrl = normalizeBaseUrl$1(config.cloud?.baseUrl);
			const agentId = resolveAgentId(runtime);
			url = `${baseUrl}/api/v1/agents/${encodeURIComponent(agentId)}/n8n/workflows/${encodeURIComponent(id)}/execute`;
			headers = {
				Authorization: `Bearer ${apiKey}`,
				"Content-Type": "application/json",
				Accept: "application/json"
			};
		} else {
			const sidecar = peekSidecar();
			const host = sidecar?.getState().host ?? config.n8n?.host ?? null;
			if (!host) return {
				ok: false,
				error: "n8n local host unknown"
			};
			const apiKey = sidecar?.getApiKey() ?? config.n8n?.apiKey ?? null;
			if (!apiKey) return {
				ok: false,
				error: "n8n local api key missing"
			};
			const baseHost = host.replace(/\/+$/, "");
			const workflowResponse = await fetchImpl(`${baseHost}/api/v1/workflows/${encodeURIComponent(id)}`, {
				method: "GET",
				headers: {
					"X-N8N-API-KEY": apiKey,
					Accept: "application/json"
				}
			}).catch((err) => {
				const message = err instanceof Error ? err.message : String(err);
				logger.warn(`[n8n-dispatch] workflow fetch failed for ${id}: ${message}`);
				return null;
			});
			if (!workflowResponse) return {
				ok: false,
				error: "n8n workflow fetch failed"
			};
			if (!workflowResponse.ok) return {
				ok: false,
				error: `n8n workflow fetch returned ${workflowResponse.status}: ${workflowResponse.statusText}`
			};
			const workflow = extractWorkflowBody(await readJsonBody$2(workflowResponse));
			if (!workflow) return {
				ok: false,
				error: "n8n workflow fetch returned invalid body"
			};
			const cookie = await getLocalOwnerCookie(baseHost, config);
			if (!cookie) return {
				ok: false,
				error: "n8n local owner login failed"
			};
			url = `${baseHost}/rest/workflows/${encodeURIComponent(id)}/run?partialExecutionVersion=1`;
			headers = {
				cookie,
				"Content-Type": "application/json",
				Accept: "application/json"
			};
			requestBody = {
				...payload,
				workflowData: workflow
			};
		}
		let res;
		try {
			res = await fetchImpl(url, {
				method: "POST",
				headers,
				body: JSON.stringify(requestBody)
			});
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			logger.warn(`[n8n-dispatch] fetch failed for workflow ${id}: ${message}`);
			return {
				ok: false,
				error: `n8n fetch failed: ${message}`
			};
		}
		if (!res.ok) return {
			ok: false,
			error: `n8n returned ${res.status}: ${res.statusText}`
		};
		const executionId = extractExecutionId(await readJsonBody$2(res));
		return executionId ? {
			ok: true,
			executionId
		} : { ok: true };
	};
	return { execute };
}
var DEFAULT_CLOUD_API_BASE_URL$2, ZERO_AGENT_ID;
var init_n8n_dispatch = __esmMin((() => {
	init_is_native_server();
	init_n8n_mode();
	init_n8n_sidecar();
	DEFAULT_CLOUD_API_BASE_URL$2 = "https://api.eliza.how";
	ZERO_AGENT_ID = "00000000-0000-0000-0000-000000000000";
}));

//#endregion
//#region node_modules/.bun/@elizaos+app-core@2.0.0-alpha.537+72829346cb4c43b1/node_modules/@elizaos/app-core/packages/app-core/src/services/trigger-event-bridge.js
/**
* Trigger event bridge — routes runtime event-bus emissions to enabled
* event-kind triggers via the existing `executeTriggerTask` pipeline.
*
* `executeTriggerTask` already handles `source: "event"` (see
* `eliza/packages/agent/src/triggers/runtime.ts`), but nothing in the
* runtime subscribes to `MESSAGE_RECEIVED` etc. and routes the payload
* through it. Without this bridge, event-kind triggers can be created
* and stored but will never fire from a real Discord / Telegram / WeChat
* message.
*
* On `start()` the bridge calls `runtime.registerEvent(eventType, handler)`
* for every `EventType` in `EXPOSED_EVENTS`. Each handler:
*   1. Honours the `ELIZA_TRIGGERS_ENABLED` kill switch.
*   2. Lists enabled trigger tasks via `listTriggerTasks(runtime)`.
*   3. Filters to `triggerType === "event" && eventKind === <the event>`.
*   4. Rate-limits per-trigger so a chatty channel cannot DoS the
*      autonomy loop (default 1000 ms floor per trigger).
*   5. Calls `executeTriggerTask(runtime, task, { source: "event", event })`
*      for each permitted trigger, isolating each dispatch so one bad
*      trigger does not break sibling dispatches.
*
* `stop()` unregisters every handler (using the original function
* reference) and clears the rate-limit map.
*/
var trigger_event_bridge_exports = /* @__PURE__ */ __exportAll({
	EXPOSED_EVENTS: () => EXPOSED_EVENTS,
	startTriggerEventBridge: () => startTriggerEventBridge
});
/**
* Extract the forwardable payload from an event. `runtime.emitEvent`
* injects `runtime` and `source` into every handler's argument; those
* are not part of the trigger's event payload and must not leak into
* persisted run records (they would serialize circularly and bloat the
* metadata blob).
*/
function stripRuntimeFields(payload) {
	const out = {};
	const source = payload;
	for (const [key, value] of Object.entries(source)) {
		if (key === "runtime" || key === "source") continue;
		if (typeof value === "function") continue;
		out[key] = value;
	}
	return out;
}
function readPayloadSource(payload) {
	const record = payload;
	const message = record.message;
	const content = message?.content;
	const candidates = [
		record.source,
		content?.source,
		message?.source
	];
	for (const candidate of candidates) if (typeof candidate === "string" && candidate.trim().length > 0) return candidate.trim().toLowerCase();
	return null;
}
function isPassiveConnectorEvent(runtime, payload) {
	if (!lifeOpsPassiveConnectorsEnabled(runtime)) return false;
	const source = readPayloadSource(payload);
	return source !== null && PASSIVE_CONNECTOR_SOURCES.has(source);
}
function startTriggerEventBridge(runtime, options = {}) {
	const minIntervalMs = options.minIntervalMs ?? DEFAULT_MIN_INTERVAL_MS;
	const events = options.events ?? EXPOSED_EVENTS;
	const listTriggers = options.listTriggers ?? listTriggerTasks;
	const dispatch = options.dispatch ?? executeTriggerTask;
	const now = options.now ?? Date.now;
	const lastDispatchMs = /* @__PURE__ */ new Map();
	const registered = /* @__PURE__ */ new Map();
	let cachedTasks = null;
	let cacheTimestamp = 0;
	let eventTypesWithTriggers = /* @__PURE__ */ new Set();
	const getCachedTriggers = async () => {
		const current = now();
		if (cachedTasks !== null && current - cacheTimestamp < TRIGGER_CACHE_TTL_MS) return cachedTasks;
		const tasks = await listTriggers(runtime);
		cachedTasks = tasks;
		cacheTimestamp = current;
		const newEventTypes = /* @__PURE__ */ new Set();
		for (const task of tasks) {
			const trigger = readTriggerConfig(task);
			if (trigger?.enabled && trigger.triggerType === "event" && trigger.eventKind) newEventTypes.add(trigger.eventKind);
		}
		eventTypesWithTriggers = newEventTypes;
		return tasks;
	};
	/** Check if there are any triggers for the given event type (uses cached knowledge). */
	const hasTriggersForEvent = (eventType) => {
		if (cachedTasks === null || now() - cacheTimestamp >= TRIGGER_CACHE_TTL_MS) return true;
		return eventTypesWithTriggers.has(eventType);
	};
	const buildHandler = (eventType) => {
		return async (payload) => {
			if (!triggersFeatureEnabled(runtime)) return;
			if (isPassiveConnectorEvent(runtime, payload)) return;
			if (!hasTriggersForEvent(eventType)) return;
			let tasks;
			try {
				tasks = await getCachedTriggers();
			} catch (err) {
				runtime.logger.error({
					src: "trigger-event-bridge",
					eventKind: eventType,
					error: err instanceof Error ? err.message : String(err)
				}, "trigger-event-bridge failed to list triggers — skipping event");
				return;
			}
			const forwardedPayload = stripRuntimeFields(payload);
			for (const task of tasks) {
				const trigger = readTriggerConfig(task);
				if (!trigger) continue;
				if (!trigger.enabled) continue;
				if (trigger.triggerType !== "event") continue;
				if (trigger.eventKind !== eventType) continue;
				const triggerId = trigger.triggerId;
				const last = lastDispatchMs.get(triggerId);
				const current = now();
				if (last !== void 0 && current - last < minIntervalMs) {
					runtime.logger.debug?.({
						src: "trigger-event-bridge",
						triggerId,
						eventKind: eventType,
						sinceLastMs: current - last,
						minIntervalMs
					}, "trigger rate-limited, skipping event dispatch");
					continue;
				}
				lastDispatchMs.set(triggerId, current);
				try {
					await dispatch(runtime, task, {
						source: "event",
						event: {
							kind: eventType,
							payload: forwardedPayload
						}
					});
				} catch (err) {
					runtime.logger.error({
						src: "trigger-event-bridge",
						triggerId,
						eventKind: eventType,
						error: err instanceof Error ? err.message : String(err)
					}, "trigger-event-bridge dispatch threw — continuing with remaining triggers");
				}
			}
		};
	};
	for (const eventType of events) {
		const handler = buildHandler(eventType);
		registered.set(eventType, handler);
		runtime.registerEvent(eventType, handler);
	}
	return { stop: () => {
		for (const [eventType, handler] of registered.entries()) runtime.unregisterEvent(eventType, handler);
		registered.clear();
		lastDispatchMs.clear();
		cachedTasks = null;
		cacheTimestamp = 0;
		eventTypesWithTriggers.clear();
	} };
}
var DEFAULT_MIN_INTERVAL_MS, TRIGGER_CACHE_TTL_MS, PASSIVE_CONNECTOR_SOURCES, EXPOSED_EVENTS;
var init_trigger_event_bridge = __esmMin((() => {
	DEFAULT_MIN_INTERVAL_MS = 1e3;
	TRIGGER_CACHE_TTL_MS = 500;
	PASSIVE_CONNECTOR_SOURCES = new Set([
		"discord",
		"telegram",
		"signal",
		"imessage",
		"whatsapp",
		"wechat",
		"slack",
		"sms",
		"x_dm"
	]);
	EXPOSED_EVENTS = [
		EventType.MESSAGE_RECEIVED,
		EventType.MESSAGE_SENT,
		EventType.REACTION_RECEIVED,
		EventType.ENTITY_JOINED
	];
}));

//#endregion
//#region node_modules/.bun/@elizaos+app-core@2.0.0-alpha.537+72829346cb4c43b1/node_modules/@elizaos/app-core/packages/app-core/src/services/discord-target-source.js
var discord_target_source_exports = /* @__PURE__ */ __exportAll({
	DISCORD_FACT_CACHE_TTL_MS: () => DISCORD_FACT_CACHE_TTL_MS,
	createDiscordSourceCache: () => createDiscordSourceCache,
	fetchDiscordEnumeration: () => fetchDiscordEnumeration,
	formatDiscordEnumerationAsFacts: () => formatDiscordEnumerationAsFacts
});
function createDiscordSourceCache() {
	return /* @__PURE__ */ new Map();
}
/**
* Enumerate the Discord bot's guilds and text channels. Cached per-token
* for `DISCORD_FACT_CACHE_TTL_MS`. The cache is provided by the caller so
* the runtime-context-provider and the catalog can share a single window.
*/
async function fetchDiscordEnumeration(botToken, options = {}) {
	const fetchImpl = options.fetchImpl ?? fetch;
	const now = options.now ?? Date.now;
	const cache = options.cache;
	const logger = options.logger;
	if (cache) {
		const cached = cache.get(botToken);
		if (cached && cached.expiresAt > now()) return cached.result;
	}
	const writeCache = (result) => {
		if (cache) cache.set(botToken, {
			expiresAt: now() + DISCORD_FACT_CACHE_TTL_MS,
			result
		});
		return result;
	};
	let guilds;
	try {
		const guildsRes = await fetchImpl("https://discord.com/api/v10/users/@me/guilds", { headers: { Authorization: `Bot ${botToken}` } });
		if (!guildsRes.ok) {
			logger?.warn?.({
				src: "discord-target-source",
				status: guildsRes.status
			}, "Discord guilds REST returned non-ok");
			return writeCache([]);
		}
		guilds = await guildsRes.json();
	} catch (err) {
		logger?.warn?.({
			src: "discord-target-source",
			err: err instanceof Error ? err.message : String(err)
		}, "Discord guilds REST threw");
		return [];
	}
	const headers = { Authorization: `Bot ${botToken}` };
	const out = [];
	for (const guild of guilds) try {
		const channelsRes = await fetchImpl(`https://discord.com/api/v10/guilds/${guild.id}/channels`, { headers });
		if (!channelsRes.ok) {
			out.push({
				guildId: guild.id,
				guildName: guild.name,
				channelsError: { status: channelsRes.status }
			});
			continue;
		}
		const channels = await channelsRes.json();
		out.push({
			guildId: guild.id,
			guildName: guild.name,
			channels: channels.filter((c) => c.type === DISCORD_TEXT_CHANNEL_TYPE).map((c) => ({
				id: c.id,
				name: c.name
			}))
		});
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		logger?.warn?.({
			src: "discord-target-source",
			guildId: guild.id,
			err: message
		}, "Discord channels REST threw");
		out.push({
			guildId: guild.id,
			guildName: guild.name,
			channelsError: { message }
		});
	}
	return writeCache(out);
}
/**
* Format an enumeration result as the human-readable fact strings the n8n
* runtime-context provider injects into the LLM prompt.
*/
function formatDiscordEnumerationAsFacts(results) {
	const facts = [];
	for (const guild of results) {
		if (guild.channels) {
			const text = guild.channels.map((c) => `#${c.name} (${c.id})`).join(", ");
			facts.push(text.length > 0 ? `Discord guild "${guild.guildName}" (id ${guild.guildId}) channels: ${text}.` : `Discord guild "${guild.guildName}" (id ${guild.guildId}) — no text channels visible to the bot.`);
			continue;
		}
		if (guild.channelsError) {
			const detail = typeof guild.channelsError.status === "number" ? `status ${guild.channelsError.status}` : guild.channelsError.message ?? "unknown error";
			facts.push(`Discord guild "${guild.guildName}" (id ${guild.guildId}) — channels not enumerable (${detail}).`);
		}
	}
	return facts;
}
var DISCORD_FACT_CACHE_TTL_MS, DISCORD_TEXT_CHANNEL_TYPE;
var init_discord_target_source = __esmMin((() => {
	DISCORD_FACT_CACHE_TTL_MS = 300 * 1e3;
	DISCORD_TEXT_CHANNEL_TYPE = 0;
}));

//#endregion
//#region node_modules/.bun/@elizaos+app-core@2.0.0-alpha.537+72829346cb4c43b1/node_modules/@elizaos/app-core/packages/app-core/src/services/n8n-runtime-context-provider.js
var n8n_runtime_context_provider_exports = /* @__PURE__ */ __exportAll({
	N8N_RUNTIME_CONTEXT_PROVIDER_SERVICE_TYPE: () => SERVICE_TYPE,
	startElizaN8nRuntimeContextProvider: () => startElizaN8nRuntimeContextProvider
});
/**
* Render a trigger-source fact line the LLM can read as part of the
* `## Runtime Facts` block. Returns `undefined` when the trigger context
* is empty / has no actionable platform routing info.
*/
function formatTriggerContextFact(ctx) {
	if (!ctx) return void 0;
	const channelName = ctx.resolvedNames?.channel;
	const serverName = ctx.resolvedNames?.server;
	if (ctx.discord?.channelId) {
		const channelLabel = channelName ? `#${channelName}` : "the channel";
		const serverPart = ctx.discord.guildId ? serverName ? ` within "${serverName}" (id ${ctx.discord.guildId})` : ` within guild id ${ctx.discord.guildId}` : "";
		return `This workflow was prompted from a Discord conversation in ${channelLabel} (id ${ctx.discord.channelId})${serverPart}. When the user references "this channel" or "back to here", target that channel ID.`;
	}
	if (ctx.telegram?.chatId !== void 0) return `This workflow was prompted from a Telegram chat (id ${ctx.telegram.chatId}). When the user references "this chat" or "back to here", target that chat ID.`;
	if (ctx.slack?.channelId) {
		const teamPart = ctx.slack.teamId ? ` in team ${ctx.slack.teamId}` : "";
		return `This workflow was prompted from a Slack channel (id ${ctx.slack.channelId})${teamPart}. When the user references "this channel" or "back to here", target that channel ID.`;
	}
	if (ctx.source) return `This workflow was prompted from a ${ctx.source} conversation.`;
}
function startElizaN8nRuntimeContextProvider(runtime, options) {
	const { getConfig, credProvider } = options;
	const fetchImpl = options.fetchImpl ?? fetch;
	const now = options.now ?? Date.now;
	const discordCache = options.discordCache ?? createDiscordSourceCache();
	/**
	* Enumerate the Discord bot's guilds and text channels via the shared
	* source, then format the structured result as the LLM-facing fact lines.
	*/
	const fetchDiscordFacts = async (botToken) => {
		return formatDiscordEnumerationAsFacts(await fetchDiscordEnumeration(botToken, {
			fetchImpl,
			now,
			cache: discordCache,
			logger: { warn: runtime.logger.warn?.bind(runtime.logger) }
		}));
	};
	/**
	* Filter the static CRED_TYPE_FACTS to types that are (a) listed in
	* ELIZA_SUPPORTED_CRED_TYPES, (b) appear in the requested
	* `relevantCredTypes` (so we only advertise types the LLM might actually
	* use), and (c) the cred provider can satisfy with `credential_data`
	* (so we don't promise a credential the user hasn't wired up yet).
	*/
	const computeSupportedCredentials = async (userId, relevantCredTypes) => {
		const out = [];
		for (const credType of relevantCredTypes) {
			if (!ELIZA_SUPPORTED_CRED_TYPES.has(credType)) continue;
			const meta = CRED_TYPE_FACTS[credType];
			if (!meta) continue;
			if (credProvider) try {
				const result = await credProvider.resolve(userId, credType);
				if (!result || result.status !== "credential_data") continue;
			} catch (err) {
				runtime.logger.warn?.({
					src: "n8n-runtime-context-provider",
					credType,
					err: err instanceof Error ? err.message : String(err)
				}, "credential provider resolve() threw — skipping cred type");
				continue;
			}
			out.push({
				credType,
				friendlyName: meta.friendlyName,
				nodeTypes: meta.nodeTypes
			});
		}
		return out;
	};
	const getRuntimeContext = async (input) => {
		const connectors = getConfig().connectors ?? {};
		const supportedCredentials = await computeSupportedCredentials(input.userId, input.relevantCredTypes);
		const facts = [];
		if (input.relevantNodes.some((n) => n.name.startsWith("n8n-nodes-base.discord"))) {
			const token = connectors.discord?.token?.trim();
			if (token) {
				const discordFacts = await fetchDiscordFacts(token);
				for (const f of discordFacts) facts.push(f);
			}
		}
		if (input.relevantNodes.some((n) => n.name.startsWith("n8n-nodes-base.gmail"))) {
			const email = connectors.gmail?.email?.trim();
			if (email) facts.push(`Connected Gmail account: ${email}.`);
		}
		const triggerFact = formatTriggerContextFact(input.triggerContext);
		if (triggerFact) facts.push(triggerFact);
		return {
			supportedCredentials,
			facts
		};
	};
	const service = {
		getRuntimeContext,
		stop: async () => {
			discordCache.clear();
		},
		capabilityDescription: "Provides Eliza runtime facts (Discord guilds/channels, Gmail email) and supported credential types to the n8n workflow generator."
	};
	runtime.services.set(SERVICE_TYPE, [service]);
	return {
		service,
		stop: () => {
			try {
				runtime.services.delete(SERVICE_TYPE);
			} catch {}
		}
	};
}
var SERVICE_TYPE, ELIZA_SUPPORTED_CRED_TYPES, CRED_TYPE_FACTS;
var init_n8n_runtime_context_provider = __esmMin((() => {
	init_discord_target_source();
	SERVICE_TYPE = "n8n_runtime_context_provider";
	ELIZA_SUPPORTED_CRED_TYPES = new Set([
		"discordApi",
		"discordBotApi",
		"telegramApi",
		"gmailOAuth2",
		"gmailOAuth2Api",
		"googleSheetsOAuth2Api",
		"googleCalendarOAuth2Api",
		"googleDriveOAuth2Api",
		"slackApi",
		"slackOAuth2Api"
	]);
	CRED_TYPE_FACTS = {
		discordApi: {
			friendlyName: "Discord Bot",
			nodeTypes: ["n8n-nodes-base.discord"]
		},
		discordBotApi: {
			friendlyName: "Discord Bot",
			nodeTypes: ["n8n-nodes-base.discord"]
		},
		telegramApi: {
			friendlyName: "Telegram Bot",
			nodeTypes: ["n8n-nodes-base.telegram", "n8n-nodes-base.telegramTrigger"]
		},
		gmailOAuth2: {
			friendlyName: "Gmail Account",
			nodeTypes: ["n8n-nodes-base.gmail", "n8n-nodes-base.gmailTrigger"]
		},
		gmailOAuth2Api: {
			friendlyName: "Gmail Account",
			nodeTypes: ["n8n-nodes-base.gmail", "n8n-nodes-base.gmailTrigger"]
		},
		googleSheetsOAuth2Api: {
			friendlyName: "Google Sheets",
			nodeTypes: ["n8n-nodes-base.googleSheets"]
		},
		googleCalendarOAuth2Api: {
			friendlyName: "Google Calendar",
			nodeTypes: ["n8n-nodes-base.googleCalendar"]
		},
		googleDriveOAuth2Api: {
			friendlyName: "Google Drive",
			nodeTypes: ["n8n-nodes-base.googleDrive"]
		},
		slackOAuth2Api: {
			friendlyName: "Slack Workspace",
			nodeTypes: ["n8n-nodes-base.slack"]
		},
		slackApi: {
			friendlyName: "Slack Workspace",
			nodeTypes: ["n8n-nodes-base.slack"]
		}
	};
}));

//#endregion
//#region node_modules/.bun/@elizaos+app-core@2.0.0-alpha.537+72829346cb4c43b1/node_modules/@elizaos/app-core/packages/app-core/src/services/connector-target-catalog.js
var connector_target_catalog_exports = /* @__PURE__ */ __exportAll({ createElizaConnectorTargetCatalog: () => createElizaConnectorTargetCatalog });
function createElizaConnectorTargetCatalog(options) {
	const fetchImpl = options.fetchImpl ?? fetch;
	const now = options.now ?? Date.now;
	const discordCache = options.discordCache ?? createDiscordSourceCache();
	const logger = options.logger;
	const listDiscordGroups = async (groupId) => {
		const token = options.getConfig().connectors?.discord?.token?.trim();
		if (!token) return [];
		const enumeration = await fetchDiscordEnumeration(token, {
			fetchImpl,
			now,
			cache: discordCache,
			logger
		});
		const groups = [];
		for (const guild of enumeration) {
			if (groupId && guild.guildId !== groupId) continue;
			groups.push({
				platform: "discord",
				groupId: guild.guildId,
				groupName: guild.guildName,
				targets: (guild.channels ?? []).map((c) => ({
					id: c.id,
					name: c.name,
					kind: "channel"
				}))
			});
		}
		return groups;
	};
	return { async listGroups(opts = {}) {
		const platform = opts.platform;
		const all = [];
		if (!platform || platform === "discord") for (const g of await listDiscordGroups(opts.groupId)) all.push(g);
		return all;
	} };
}
var init_connector_target_catalog = __esmMin((() => {
	init_discord_target_source();
}));

//#endregion
//#region node_modules/.bun/@elizaos+app-core@2.0.0-alpha.537+72829346cb4c43b1/node_modules/@elizaos/app-core/packages/app-core/src/services/cloud-jwks-store.js
/**
* Disk-backed JWKS cache for the Eliza Cloud bootstrap-token verifier.
*
* The cloud control plane publishes its public keys at
* `${ELIZA_CLOUD_ISSUER}/.well-known/jwks.json`. We fetch on first use and
* cache to disk under the eliza state dir so a container restart does not
* require an online round-trip just to read its own boot token.
*
* State dir resolution honours `ELIZA_STATE_DIR` then `ELIZA_STATE_DIR`,
* falling back to `~/.eliza`. The default cache TTL is 6h per the plan.
*/
/**
* Resolve the eliza state directory.
*
* Order: `ELIZA_STATE_DIR` → `ELIZA_STATE_DIR` → `~/.eliza`.
*/
function resolveElizaStateDir$1(env = process.env) {
	const explicit = env.ELIZA_STATE_DIR?.trim();
	if (explicit) return path.resolve(explicit);
	return path.join(os.homedir(), ".eliza");
}
/**
* Resolve the on-disk path for the JWKS cache.
*
* Layout: `<state>/auth/cloud-jwks.json`.
*/
function resolveJwksCachePath(env = process.env) {
	return path.join(resolveElizaStateDir$1(env), "auth", JWKS_CACHE_FILENAME);
}
function isFiniteNumber$1(value) {
	return typeof value === "number" && Number.isFinite(value);
}
function isJwksKey(value) {
	if (!value || typeof value !== "object") return false;
	return typeof value.kty === "string";
}
function isJwksDocument(value) {
	if (!value || typeof value !== "object") return false;
	const candidate = value;
	return Array.isArray(candidate.keys) && candidate.keys.every(isJwksKey);
}
function parseEnvelope(raw) {
	let parsed;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return null;
	}
	if (!parsed || typeof parsed !== "object") return null;
	const candidate = parsed;
	if (!isFiniteNumber$1(candidate.fetchedAt) || typeof candidate.issuer !== "string" || !isJwksDocument(candidate.jwks)) return null;
	return {
		fetchedAt: candidate.fetchedAt,
		issuer: candidate.issuer,
		jwks: candidate.jwks
	};
}
/**
* Read the cached JWKS for `issuer`.
*
* Returns `null` if the cache file is missing, malformed, written for a
* different issuer, or older than `ttlMs`. Callers must treat `null` as
* "must refresh from network" — never as "no keys, allow through".
*/
async function readCachedJwks(issuer, options = {}) {
	const env = options.env ?? process.env;
	const now = options.now ?? Date.now();
	const ttlMs = options.ttlMs ?? DEFAULT_JWKS_TTL_MS;
	const filePath = resolveJwksCachePath(env);
	let raw;
	try {
		raw = await fs$1.readFile(filePath, "utf8");
	} catch (err) {
		if (err.code === "ENOENT") return null;
		throw err;
	}
	const envelope = parseEnvelope(raw);
	if (!envelope) return null;
	if (envelope.issuer !== issuer) return null;
	if (now - envelope.fetchedAt > ttlMs) return null;
	return envelope.jwks;
}
/**
* Write the JWKS document to disk. The parent directory is created with mode
* 0700 to keep cached keys out of unrelated reads.
*/
async function writeCachedJwks(issuer, jwks, options = {}) {
	const env = options.env ?? process.env;
	const now = options.now ?? Date.now();
	const filePath = resolveJwksCachePath(env);
	const dir = path.dirname(filePath);
	await fs$1.mkdir(dir, {
		recursive: true,
		mode: 448
	});
	const envelope = {
		fetchedAt: now,
		issuer,
		jwks
	};
	await fs$1.writeFile(filePath, `${JSON.stringify(envelope, null, 2)}\n`, {
		encoding: "utf8",
		mode: 384
	});
}
var DEFAULT_JWKS_TTL_MS, JWKS_CACHE_FILENAME;
var init_cloud_jwks_store = __esmMin((() => {
	DEFAULT_JWKS_TTL_MS = 360 * 60 * 1e3;
	JWKS_CACHE_FILENAME = "cloud-jwks.json";
}));

//#endregion
//#region node_modules/.bun/@elizaos+app-core@2.0.0-alpha.537+72829346cb4c43b1/node_modules/@elizaos/app-core/packages/app-core/src/api/auth/audit.js
/**
* Auth audit emitter.
*
* Every sensitive auth action ends up in two places:
*   1. `auth_audit_events` table via `AuthStore.appendAuditEvent`.
*   2. JSONL file at `<state>/auth/audit.log`, rotated at 10MB, so the
*      operator can read history even if pglite is wiped.
*
* Both writes happen synchronously from the caller's perspective. If the DB
* write throws the file write still happens (and vice versa) — the operator
* notices a divergence rather than losing the event entirely.
*
* Token-shaped values (20+ characters of `[A-Za-z0-9_-]`) are redacted in
* `metadata` before either write, so a misconfigured caller can't smuggle a
* bearer token into an audit row.
*/
function truncateUserAgent(value) {
	if (!value) return null;
	return value.length > 200 ? value.slice(0, 200) : value;
}
/**
* Replace token-shaped runs in `metadata` with the literal `<redacted>` string.
*
* Only string values are scanned; numbers and booleans pass through unchanged.
*/
function redactMetadata(metadata) {
	const out = {};
	for (const [key, raw] of Object.entries(metadata)) {
		if (typeof raw !== "string") {
			out[key] = raw;
			continue;
		}
		out[key] = AUDIT_REDACTION_RE.test(raw) ? "<redacted>" : raw;
	}
	return out;
}
function resolveAuditLogPath(env = process.env) {
	return path.join(resolveElizaStateDir$1(env), "auth", AUDIT_LOG_FILENAME);
}
function resolveAuditLogRotatedPath(env = process.env) {
	return path.join(resolveElizaStateDir$1(env), "auth", AUDIT_LOG_ROTATE_FILENAME);
}
async function rotateIfNeeded(filePath) {
	let size;
	try {
		size = (await fs$1.stat(filePath)).size;
	} catch (err) {
		if (err.code === "ENOENT") return;
		throw err;
	}
	if (size < AUDIT_LOG_MAX_BYTES) return;
	const rotated = `${filePath}.1`;
	await fs$1.rename(filePath, rotated).catch(async (err) => {
		if (err.code !== "ENOENT") throw err;
	});
}
async function appendJsonLine(filePath, line) {
	await fs$1.mkdir(path.dirname(filePath), {
		recursive: true,
		mode: 448
	});
	await rotateIfNeeded(filePath);
	await fs$1.appendFile(filePath, `${JSON.stringify(line)}\n`, {
		encoding: "utf8",
		mode: 384
	});
}
/**
* Append an audit event to the database AND the JSONL log.
*
* Both writes are attempted. The first error is rethrown to the caller —
* an audit-write failure is a real problem and should surface, not be
* swallowed.
*/
async function appendAuditEvent(input, options) {
	const env = options.env ?? process.env;
	const now = options.now?.() ?? Date.now();
	const id = crypto.randomUUID();
	const safeMetadata = redactMetadata(input.metadata ?? {});
	const userAgent = truncateUserAgent(input.userAgent);
	const filePath = resolveAuditLogPath(env);
	const line = {
		id,
		ts: now,
		actorIdentityId: input.actorIdentityId,
		ip: input.ip,
		userAgent,
		action: input.action,
		outcome: input.outcome,
		metadata: safeMetadata
	};
	let firstError = null;
	const fileWrite = appendJsonLine(filePath, line).catch((err) => {
		if (firstError === null) firstError = err;
	});
	const dbWrite = options.store.appendAuditEvent({
		id,
		ts: now,
		actorIdentityId: input.actorIdentityId,
		ip: input.ip,
		userAgent,
		action: input.action,
		outcome: input.outcome,
		metadata: safeMetadata
	}).catch((err) => {
		if (firstError === null) firstError = err;
	});
	await Promise.all([fileWrite, dbWrite]);
	if (firstError !== null) throw firstError;
}
var AUDIT_LOG_FILENAME, AUDIT_LOG_ROTATE_FILENAME, AUDIT_LOG_MAX_BYTES, AUDIT_REDACTION_RE;
var init_audit$1 = __esmMin((() => {
	init_cloud_jwks_store();
	AUDIT_LOG_FILENAME = "audit.log";
	AUDIT_LOG_ROTATE_FILENAME = "audit.log.1";
	AUDIT_LOG_MAX_BYTES = 10 * 1024 * 1024;
	AUDIT_REDACTION_RE = /[A-Za-z0-9_-]{20,}/;
}));

//#endregion
//#region node_modules/.bun/@elizaos+app-core@2.0.0-alpha.537+72829346cb4c43b1/node_modules/@elizaos/app-core/packages/app-core/src/api/auth/tokens.js
/** Timing-safe token comparison (constant-time regardless of input length). */
function tokenMatches(expected, provided) {
	const a = Buffer.from(expected, "utf8");
	const b = Buffer.from(provided, "utf8");
	const maxLen = Math.max(a.length, b.length);
	const aPadded = Buffer.alloc(maxLen);
	const bPadded = Buffer.alloc(maxLen);
	a.copy(aPadded);
	b.copy(bPadded);
	const contentMatch = crypto.timingSafeEqual(aPadded, bPadded);
	return a.length === b.length && contentMatch;
}
var init_tokens = __esmMin((() => {}));

//#endregion
//#region node_modules/.bun/@elizaos+app-core@2.0.0-alpha.537+72829346cb4c43b1/node_modules/@elizaos/app-core/packages/app-core/src/api/auth/sessions.js
/**
* Session lifecycle on top of `AuthStore`.
*
* This module owns:
*   - browser session creation + sliding-TTL math
*   - machine session creation (absolute TTL)
*   - session lookup with sliding-window refresh
*   - revoke (single + all-but-current)
*   - CSRF derive / verify (HMAC-SHA256 over `session.csrfSecret`)
*   - cookie serialize / parse for the `eliza_session` cookie
*
* Hard rule: every helper fails closed. A malformed cookie returns null;
* a CSRF mismatch returns false; a session lookup error propagates. We do
* NOT pretend bad input is good input.
*/
/** 256-bit hex session id. Cookie value. */
function generateSessionId() {
	return crypto.randomBytes(32).toString("hex");
}
/** 256-bit hex CSRF secret. Per-session, never sent to clients raw. */
function generateCsrfSecret() {
	return crypto.randomBytes(32).toString("hex");
}
/**
* Mint a browser session. Uses sliding TTL (`BROWSER_SESSION_TTL_MS`) capped
* at 30 days when `rememberDevice` is set; otherwise the cap equals the
* sliding window.
*
* Returns the persisted session and a derived CSRF token suitable for the
* `eliza_csrf` cookie.
*/
async function createBrowserSession(store, options) {
	const now = options.now ?? Date.now();
	const id = generateSessionId();
	const csrfSecret = generateCsrfSecret();
	const expiresAt = now + BROWSER_SESSION_TTL_MS$1;
	const session = await store.createSession({
		id,
		identityId: options.identityId,
		kind: "browser",
		createdAt: now,
		lastSeenAt: now,
		expiresAt,
		rememberDevice: Boolean(options.rememberDevice),
		csrfSecret,
		ip: options.ip,
		userAgent: options.userAgent,
		scopes: []
	});
	return {
		session,
		csrfToken: deriveCsrfToken(session)
	};
}
/**
* Mint a machine session. Absolute TTL (`MACHINE_SESSION_TTL_MS`); no sliding
* refresh on access. Scopes are persisted exactly as supplied — caller is
* responsible for shaping them.
*/
async function createMachineSession(store, options) {
	const now = options.now ?? Date.now();
	const id = generateSessionId();
	const csrfSecret = generateCsrfSecret();
	const expiresAt = now + MACHINE_SESSION_TTL_MS;
	const session = await store.createSession({
		id,
		identityId: options.identityId,
		kind: "machine",
		createdAt: now,
		lastSeenAt: now,
		expiresAt,
		rememberDevice: false,
		csrfSecret,
		ip: options.ip ?? null,
		userAgent: options.label ?? null,
		scopes: [...options.scopes]
	});
	return {
		session,
		csrfToken: deriveCsrfToken(session)
	};
}
/**
* Look up an active session by id and slide its expiry forward when it is a
* browser session. Machine sessions get `lastSeenAt` updated but no expiry
* extension (absolute TTL by spec).
*
* Returns `null` for missing / expired / revoked sessions. Errors propagate;
* we do NOT silently treat a DB error as "session valid".
*/
async function findActiveSession(store, sessionId, now = Date.now()) {
	const found = await store.findSession(sessionId, now);
	if (!found) return null;
	if (found.kind === "browser") {
		const cap = found.rememberDevice ? found.createdAt + BROWSER_SESSION_REMEMBER_CAP_MS : found.createdAt + BROWSER_SESSION_TTL_MS$1;
		const proposed = now + BROWSER_SESSION_TTL_MS$1;
		const nextExpiresAt = Math.min(proposed, cap);
		if (nextExpiresAt <= now) return null;
		if (nextExpiresAt !== found.expiresAt || now !== found.lastSeenAt) await store.touchSession(found.id, now, nextExpiresAt);
		return {
			...found,
			lastSeenAt: now,
			expiresAt: nextExpiresAt
		};
	}
	if (found.kind === "machine") {
		if (now !== found.lastSeenAt) await store.touchSession(found.id, now, found.expiresAt);
		return {
			...found,
			lastSeenAt: now
		};
	}
	return found;
}
async function revokeSession(sessionId, options) {
	const now = options.now ?? Date.now();
	const ok = await options.store.revokeSession(sessionId, now);
	await appendAuditEvent({
		id: crypto.randomUUID(),
		ts: now,
		actorIdentityId: options.actorIdentityId,
		ip: options.ip,
		userAgent: options.userAgent,
		action: "auth.session.revoke",
		outcome: ok ? "success" : "failure",
		metadata: {
			sessionId,
			reason: options.reason
		}
	}, { store: options.store });
	return ok;
}
async function revokeAllSessionsForIdentity(options) {
	const now = options.now ?? Date.now();
	const count = await options.store.revokeAllSessionsForIdentity(options.identityId, now, options.exceptSessionId);
	await appendAuditEvent({
		actorIdentityId: options.identityId,
		ip: options.ip,
		userAgent: options.userAgent,
		action: "auth.session.revoke_all",
		outcome: "success",
		metadata: {
			identityId: options.identityId,
			reason: options.reason,
			revoked: count
		}
	}, { store: options.store });
	return count;
}
/**
* Derive the CSRF token for a session. HMAC-SHA256 over the literal
* `csrf:<sessionId>` payload using the per-session `csrfSecret` as the key.
* The derivation is stable, so repeated calls return the same token until
* the session is rotated.
*/
function deriveCsrfToken(session) {
	return crypto.createHmac("sha256", session.csrfSecret).update(`csrf:${session.id}`).digest("hex");
}
/**
* Timing-safe compare of an incoming CSRF header against the expected
* derived token. Empty / missing headers fail closed.
*/
function verifyCsrfToken(session, provided) {
	if (typeof provided !== "string" || provided.length === 0) return false;
	return tokenMatches(deriveCsrfToken(session), provided);
}
/**
* Should the cookie carry the `Secure` attribute? Plan §4.1: drop `Secure`
* only when bound on loopback (the Electrobun shell). Detect via the same
* env helpers as the rest of the runtime.
*/
function shouldEmitSecureFlag(env) {
	return !isLoopbackBindHost(resolveApiBindHost(env));
}
/**
* Serialize the `eliza_session` cookie. The value is the opaque session id;
* attributes follow plan §4.1.
*
* Returns the full `Set-Cookie` header value (without the leading
* `Set-Cookie:` token). Caller is responsible for `res.setHeader`.
*/
function serializeSessionCookie(session, options = {}) {
	const env = options.env ?? process.env;
	const now = Date.now();
	const ageMs = options.maxAgeMs ?? Math.max(0, session.expiresAt - now);
	const ageSec = Math.floor(ageMs / 1e3);
	const parts = [
		`${SESSION_COOKIE_NAME$1}=${encodeURIComponent(session.id)}`,
		"Path=/",
		"HttpOnly",
		"SameSite=Lax",
		`Max-Age=${ageSec}`
	];
	if (shouldEmitSecureFlag(env)) parts.push("Secure");
	return parts.join("; ");
}
/**
* Serialize the readable companion CSRF cookie. Same lifetime as the
* session cookie. NOT `HttpOnly` so the SPA can mirror it into the
* `x-eliza-csrf` header.
*/
function serializeCsrfCookie(session, options = {}) {
	const env = options.env ?? process.env;
	const now = Date.now();
	const ageMs = options.maxAgeMs ?? Math.max(0, session.expiresAt - now);
	const ageSec = Math.floor(ageMs / 1e3);
	const csrfToken = deriveCsrfToken(session);
	const parts = [
		`${CSRF_COOKIE_NAME}=${encodeURIComponent(csrfToken)}`,
		"Path=/",
		"SameSite=Lax",
		`Max-Age=${ageSec}`
	];
	if (shouldEmitSecureFlag(env)) parts.push("Secure");
	return parts.join("; ");
}
/** Build the cookie that destroys the session client-side (logout). */
function serializeSessionExpiryCookie(options = {}) {
	const env = options.env ?? process.env;
	const parts = [
		`${SESSION_COOKIE_NAME$1}=`,
		"Path=/",
		"HttpOnly",
		"SameSite=Lax",
		"Max-Age=0"
	];
	if (shouldEmitSecureFlag(env)) parts.push("Secure");
	return parts.join("; ");
}
/** Companion expiry cookie for `eliza_csrf`. */
function serializeCsrfExpiryCookie(options = {}) {
	const env = options.env ?? process.env;
	const parts = [
		`${CSRF_COOKIE_NAME}=`,
		"Path=/",
		"SameSite=Lax",
		"Max-Age=0"
	];
	if (shouldEmitSecureFlag(env)) parts.push("Secure");
	return parts.join("; ");
}
/**
* Parse a raw `Cookie:` header into a typed map. Returns `Map<string,string>`
* — keys are cookie names, values are URL-decoded raw values. Invalid or
* empty cookies are dropped silently (per RFC 6265 §5.2 step 1).
*/
function parseCookieHeader(headerValue) {
	const out = /* @__PURE__ */ new Map();
	if (!headerValue) return out;
	for (const part of headerValue.split(";")) {
		const eq = part.indexOf("=");
		if (eq < 0) continue;
		const k = part.slice(0, eq).trim();
		if (!k) continue;
		const v = part.slice(eq + 1).trim();
		if (v.length === 0) continue;
		try {
			out.set(k, decodeURIComponent(v));
		} catch {
			out.set(k, v);
		}
	}
	return out;
}
/**
* Read the eliza session id from the request cookie header. Returns null
* when the cookie is absent or empty.
*/
function parseSessionCookie(req) {
	const raw = req.headers.cookie;
	const value = parseCookieHeader((Array.isArray(raw) ? raw[0] : raw) ?? null).get(SESSION_COOKIE_NAME$1);
	return value && value.length > 0 ? value : null;
}
var BROWSER_SESSION_TTL_MS$1, BROWSER_SESSION_REMEMBER_CAP_MS, MACHINE_SESSION_TTL_MS, SESSION_COOKIE_NAME$1, CSRF_COOKIE_NAME, CSRF_HEADER_NAME;
var init_sessions = __esmMin((() => {
	init_audit$1();
	init_tokens();
	BROWSER_SESSION_TTL_MS$1 = 720 * 60 * 1e3;
	BROWSER_SESSION_REMEMBER_CAP_MS = 720 * 60 * 60 * 1e3;
	MACHINE_SESSION_TTL_MS = 2160 * 60 * 60 * 1e3;
	SESSION_COOKIE_NAME$1 = "eliza_session";
	CSRF_COOKIE_NAME = "eliza_csrf";
	CSRF_HEADER_NAME = "x-eliza-csrf";
}));

//#endregion
//#region node_modules/.bun/@elizaos+app-core@2.0.0-alpha.537+72829346cb4c43b1/node_modules/@elizaos/app-core/packages/app-core/src/api/response.js
/**
* Shared HTTP JSON response helpers for the app API layer.
*
* Consolidates the `sendJson` / `sendJsonError` / `sendJsonResponse` pattern
* that was independently defined in server.ts, cloud-routes.ts, and others.
*/
function scrubStackFields(value) {
	if (value instanceof Error) return { error: value.message || "Internal error" };
	if (Array.isArray(value)) return value.map(scrubStackFields);
	if (value && typeof value === "object") {
		const out = {};
		for (const [k, v] of Object.entries(value)) {
			if (k === "stack" || k === "stackTrace") continue;
			out[k] = scrubStackFields(v);
		}
		return out;
	}
	return value;
}
/** Send a JSON response. No-op if headers already sent. */
function sendJson$2(res, status, body) {
	if (res.headersSent) return;
	res.statusCode = status;
	res.setHeader("content-type", "application/json; charset=utf-8");
	res.end(JSON.stringify(scrubStackFields(body)));
}
/** Send a JSON `{ error: message }` response. */
function sendJsonError(res, status, message) {
	sendJson$2(res, status, { error: message });
}
var init_response = __esmMin((() => {}));

//#endregion
//#region node_modules/.bun/@elizaos+app-core@2.0.0-alpha.537+72829346cb4c43b1/node_modules/@elizaos/app-core/packages/app-core/src/api/compat-route-shared.js
function clearCompatRuntimeRestart(state) {
	state.pendingRestartReasons = [];
}
function scheduleCompatRuntimeRestart(state, reason) {
	if (state.pendingRestartReasons.includes(reason)) return;
	if (state.pendingRestartReasons.length >= 50) state.pendingRestartReasons.splice(1, state.pendingRestartReasons.length - 1);
	state.pendingRestartReasons.push(reason);
}
function isLoopbackRemoteAddress(remoteAddress) {
	if (!remoteAddress) return false;
	const normalized = remoteAddress.trim().toLowerCase();
	return normalized === "127.0.0.1" || normalized === "::1" || normalized === "0:0:0:0:0:0:0:1" || normalized === "::ffff:127.0.0.1" || normalized === "::ffff:0:127.0.0.1";
}
function firstHeaderValue(value) {
	if (typeof value === "string") return value;
	if (Array.isArray(value) && typeof value[0] === "string") return value[0];
	return null;
}
function headerValues(value) {
	if (typeof value === "string") return [value];
	if (Array.isArray(value)) return value.filter((item) => typeof item === "string");
	return [];
}
function isClientIpProxyHeaderName(name) {
	const normalized = name.toLowerCase();
	return CLIENT_IP_PROXY_HEADERS.has(normalized) || normalized.endsWith("-client-ip") || normalized.endsWith("-connecting-ip") || normalized.endsWith("-real-ip");
}
function extractForwardedForCandidates(raw) {
	const candidates = [];
	for (const match of raw.matchAll(/(?:^|[;,])\s*for=(?:"([^"]*)"|([^;,]*))/gi)) candidates.push(match[1] ?? match[2] ?? "");
	return candidates;
}
function extractProxyClientAddressCandidates(headerName, raw) {
	if (headerName === "forwarded") return extractForwardedForCandidates(raw);
	const forwardedCandidates = raw.toLowerCase().includes("for=") ? extractForwardedForCandidates(raw) : [];
	if (forwardedCandidates.length > 0) return forwardedCandidates;
	return raw.split(",");
}
function stripMatchingQuotes(value) {
	const trimmed = value.trim();
	if (trimmed.startsWith("\"") && trimmed.endsWith("\"") || trimmed.startsWith("'") && trimmed.endsWith("'")) return trimmed.slice(1, -1);
	return trimmed;
}
function isNeutralProxyClientAddress(raw) {
	const normalized = stripMatchingQuotes(raw).trim().toLowerCase();
	return !normalized || normalized === "unknown" || normalized === "null" || normalized.startsWith("_");
}
function normalizeProxyClientIp(raw) {
	let normalized = stripMatchingQuotes(raw).trim();
	if (!normalized) return null;
	if (normalized.startsWith("[")) {
		const close = normalized.indexOf("]");
		if (close > 0) normalized = normalized.slice(1, close);
	} else {
		const ipv4HostPort = /^(\d{1,3}(?:\.\d{1,3}){3})(?::\d+)$/.exec(normalized);
		if (ipv4HostPort?.[1]) normalized = ipv4HostPort[1];
	}
	const zoneIndex = normalized.indexOf("%");
	if (zoneIndex >= 0) normalized = normalized.slice(0, zoneIndex);
	normalized = normalized.trim().toLowerCase();
	return isIP(normalized) ? normalized : null;
}
function isLoopbackProxyClientIp(ip) {
	const normalized = ip.trim().toLowerCase();
	return normalized === "::1" || normalized === "0:0:0:0:0:0:0:1" || normalized.startsWith("127.") || normalized.startsWith("::ffff:127.") || normalized.startsWith("::ffff:0:127.");
}
function proxyClientHeaderBlocksLocalTrust(headers) {
	for (const [rawName, rawValue] of Object.entries(headers)) {
		const headerName = rawName.toLowerCase();
		if (!isClientIpProxyHeaderName(headerName)) continue;
		for (const value of headerValues(rawValue)) for (const candidate of extractProxyClientAddressCandidates(headerName, value)) {
			if (isNeutralProxyClientAddress(candidate)) continue;
			const ip = normalizeProxyClientIp(candidate);
			if (!ip || !isLoopbackProxyClientIp(ip)) return true;
		}
	}
	return false;
}
function isCloudProvisionedByEnv() {
	return process.env.ELIZA_CLOUD_PROVISIONED === "1";
}
function isTrustedLocalOrigin(raw) {
	const trimmed = raw.trim();
	if (!trimmed || trimmed === "null") return true;
	try {
		const parsed = new URL(trimmed);
		if (parsed.protocol === "file:" || parsed.protocol === "app:" || parsed.protocol === "tauri:" || parsed.protocol === "capacitor:" || parsed.protocol === "capacitor-electron:" || parsed.protocol === "electrobun:") return true;
		return isLoopbackBindHost(parsed.hostname);
	} catch {
		return false;
	}
}
/**
* Same-machine dashboard access. This is intentionally stricter than just
* checking `remoteAddress`: the browser must also be targeting a loopback Host
* and must not present cross-site browser metadata.
*/
function isTrustedLocalRequest(req) {
	if (isCloudProvisionedByEnv()) return false;
	if (!isLoopbackRemoteAddress(req.socket?.remoteAddress)) return false;
	if (proxyClientHeaderBlocksLocalTrust(req.headers)) return false;
	const host = firstHeaderValue(req.headers.host);
	if (host && !isLoopbackBindHost(host)) return false;
	if (firstHeaderValue(req.headers["sec-fetch-site"])?.toLowerCase() === "cross-site") return false;
	const origin = firstHeaderValue(req.headers.origin);
	if (origin && !isTrustedLocalOrigin(origin)) return false;
	const referer = firstHeaderValue(req.headers.referer);
	if (!origin && referer && !isTrustedLocalOrigin(referer)) return false;
	return true;
}
async function readCompatJsonBody(req, res) {
	const chunks = [];
	let totalBytes = 0;
	try {
		for await (const chunk of req) {
			const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
			totalBytes += buf.length;
			if (totalBytes > MAX_BODY_BYTES$1) {
				req.destroy();
				sendJsonError(res, 413, "Request body too large");
				return null;
			}
			chunks.push(buf);
		}
	} catch {
		sendJsonError(res, 400, "Invalid request body");
		return null;
	}
	if (chunks.length === 0) return {};
	try {
		const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
			sendJsonError(res, 400, "Invalid JSON body");
			return null;
		}
		return parsed;
	} catch {
		sendJsonError(res, 400, "Invalid JSON body");
		return null;
	}
}
function hasCompatPersistedOnboardingState(config) {
	if (config.meta?.onboardingComplete === true) return true;
	const deploymentTarget = resolveDeploymentTargetInConfig(config);
	const llmText = resolveServiceRoutingInConfig(config)?.llmText;
	const backend = normalizeOnboardingProviderId(llmText?.backend);
	const remoteApiBase = llmText?.remoteApiBase?.trim() ?? deploymentTarget.remoteApiBase?.trim();
	if (llmText?.transport === "direct" && Boolean(backend && backend !== "elizacloud") || llmText?.transport === "remote" && Boolean(remoteApiBase) || llmText?.transport === "cloud-proxy" && backend === "elizacloud" && Boolean(llmText.smallModel?.trim() && llmText.largeModel?.trim()) || deploymentTarget.runtime === "remote" && Boolean(deploymentTarget.remoteApiBase?.trim())) return true;
	if (Array.isArray(config.agents?.list) && config.agents.list.length > 0) return true;
	return Boolean(config.agents?.defaults?.workspace?.trim() || config.agents?.defaults?.adminEntityId?.trim());
}
function getConfiguredCompatAgentName() {
	const config = loadElizaConfig();
	const listAgent = config.agents?.list?.[0];
	const listAgentName = typeof listAgent?.name === "string" ? listAgent.name.trim() : "";
	if (listAgentName) return listAgentName;
	return (typeof config.ui?.assistant?.name === "string" ? config.ui.assistant.name.trim() : "") || null;
}
/**
* Best-effort grab of the Drizzle DB handle off the live runtime adapter.
* Returns null when the runtime is not yet up or the adapter has not
* exposed a `db` field. Callers MUST treat null as "service unavailable"
* — it is never authentication.
*/
function getCompatDrizzleDb(state) {
	const runtime = state.current;
	if (!runtime) return null;
	const adapter = runtime.adapter;
	if (!adapter?.db) return null;
	return adapter.db;
}
var MAX_BODY_BYTES$1, DATABASE_UNAVAILABLE_MESSAGE, CLIENT_IP_PROXY_HEADERS;
var init_compat_route_shared = __esmMin((() => {
	init_response();
	MAX_BODY_BYTES$1 = 1048576;
	DATABASE_UNAVAILABLE_MESSAGE = "Database not available. The agent may not be running or the database adapter is not initialized.";
	CLIENT_IP_PROXY_HEADERS = new Set([
		"forwarded",
		"forwarded-for",
		"x-forwarded",
		"x-forwarded-for",
		"x-original-forwarded-for",
		"x-real-ip",
		"x-client-ip",
		"x-forwarded-client-ip",
		"x-cluster-client-ip",
		"cf-connecting-ip",
		"true-client-ip",
		"fastly-client-ip",
		"x-appengine-user-ip",
		"x-azure-clientip"
	]);
}));

//#endregion
//#region node_modules/.bun/@elizaos+app-core@2.0.0-alpha.537+72829346cb4c43b1/node_modules/@elizaos/app-core/packages/app-core/src/api/auth/legacy-bearer.js
var legacy_bearer_exports = /* @__PURE__ */ __exportAll({
	LEGACY_DEPRECATION_HEADER: () => LEGACY_DEPRECATION_HEADER,
	LEGACY_GRACE_WINDOW_MS: () => LEGACY_GRACE_WINDOW_MS,
	LEGACY_INVALIDATE_AUDIT_ACTION: () => LEGACY_INVALIDATE_AUDIT_ACTION,
	LEGACY_REJECT_AUDIT_ACTION: () => LEGACY_REJECT_AUDIT_ACTION,
	LEGACY_USE_AUDIT_ACTION: () => LEGACY_USE_AUDIT_ACTION,
	_peekLegacyBearerDeadline: () => _peekLegacyBearerDeadline,
	_peekLegacyBearerInvalidated: () => _peekLegacyBearerInvalidated,
	_resetLegacyBearerState: () => _resetLegacyBearerState,
	decideLegacyBearer: () => decideLegacyBearer,
	markLegacyBearerInvalidated: () => markLegacyBearerInvalidated,
	recordLegacyBearerRejection: () => recordLegacyBearerRejection,
	recordLegacyBearerUse: () => recordLegacyBearerUse
});
/** Reset internal state. Test-only. */
function _resetLegacyBearerState() {
	state.deadline = null;
	state.invalidated = false;
}
function parseEnvDeadline(env) {
	const raw = env.ELIZA_LEGACY_GRACE_UNTIL?.trim();
	if (!raw) return null;
	const parsed = Number(raw);
	if (!Number.isFinite(parsed) || parsed <= 0) return null;
	return parsed;
}
async function decideLegacyBearer(_store, env = process.env, now = Date.now()) {
	if (state.invalidated) return {
		allowed: false,
		reason: "invalidated"
	};
	const envDeadline = parseEnvDeadline(env);
	if (envDeadline) {
		state.deadline = envDeadline;
		if (now >= envDeadline) return {
			allowed: false,
			reason: "post_grace"
		};
		return { allowed: true };
	}
	if (state.deadline === null) state.deadline = now + LEGACY_GRACE_WINDOW_MS;
	if (now >= state.deadline) return {
		allowed: false,
		reason: "post_grace"
	};
	return { allowed: true };
}
/**
* Audit-emit a successful legacy bearer use (deprecation event). Caller
* should await; failures propagate.
*/
async function recordLegacyBearerUse(store, meta) {
	await appendAuditEvent({
		actorIdentityId: null,
		ip: meta.ip,
		userAgent: meta.userAgent,
		action: LEGACY_USE_AUDIT_ACTION,
		outcome: "success",
		metadata: {}
	}, { store });
}
/** Audit-emit a rejected legacy bearer attempt (post-grace or invalidated). */
async function recordLegacyBearerRejection(store, meta) {
	await appendAuditEvent({
		actorIdentityId: null,
		ip: meta.ip,
		userAgent: meta.userAgent,
		action: LEGACY_REJECT_AUDIT_ACTION,
		outcome: "failure",
		metadata: { reason: meta.reason }
	}, { store });
}
/**
* Mark legacy bearer use as immediately rejected for the rest of this
* runtime. Called when a real auth method lands (password setup, cloud SSO
* link, owner binding verified). Also revokes existing `legacy`-scoped
* machine sessions in the DB so they can't smuggle access through the
* session layer.
*/
async function markLegacyBearerInvalidated(store, meta) {
	state.invalidated = true;
	state.deadline = 0;
	const revoked = await store.revokeLegacyBearerSessions(Date.now());
	await appendAuditEvent({
		actorIdentityId: meta.actorIdentityId,
		ip: meta.ip,
		userAgent: meta.userAgent,
		action: LEGACY_INVALIDATE_AUDIT_ACTION,
		outcome: "success",
		metadata: { revoked }
	}, { store });
}
/** Test helper for test files that want to predict the deadline. */
function _peekLegacyBearerDeadline() {
	return state.deadline;
}
function _peekLegacyBearerInvalidated() {
	return state.invalidated;
}
var LEGACY_GRACE_WINDOW_MS, LEGACY_DEPRECATION_HEADER, LEGACY_USE_AUDIT_ACTION, LEGACY_REJECT_AUDIT_ACTION, LEGACY_INVALIDATE_AUDIT_ACTION, state;
var init_legacy_bearer = __esmMin((() => {
	init_audit$1();
	LEGACY_GRACE_WINDOW_MS = 336 * 60 * 60 * 1e3;
	LEGACY_DEPRECATION_HEADER = "x-eliza-legacy-token-deprecated";
	LEGACY_USE_AUDIT_ACTION = "auth.legacy_token.used";
	LEGACY_REJECT_AUDIT_ACTION = "auth.legacy_token.rejected";
	LEGACY_INVALIDATE_AUDIT_ACTION = "auth.legacy_token.invalidated";
	state = {
		deadline: null,
		invalidated: false
	};
}));

//#endregion
//#region node_modules/.bun/@elizaos+app-core@2.0.0-alpha.537+72829346cb4c43b1/node_modules/@elizaos/app-core/packages/app-core/src/services/auth-store.js
/**
* pglite-backed repositories for the auth subsystem.
*
* The store operates on a Drizzle database handle obtained from the agent
* runtime's database adapter (`@elizaos/plugin-sql`). Tables are owned by the
* plugin-sql schema attached to the root plugin export.
*
* Every method is fail-fast: errors propagate to the caller. The auth code
* path must NEVER swallow a DB error and pretend a request was authenticated.
*/
var auth_store_exports = /* @__PURE__ */ __exportAll({ AuthStore: () => AuthStore });
function nullableString(value) {
	return value === void 0 ? null : value;
}
function rowToIdentity(row) {
	return {
		id: row.id,
		kind: row.kind === "machine" ? "machine" : "owner",
		displayName: row.displayName,
		createdAt: Number(row.createdAt),
		passwordHash: row.passwordHash ?? null,
		cloudUserId: row.cloudUserId ?? null
	};
}
function rowToSession(row) {
	return {
		id: row.id,
		identityId: row.identityId,
		kind: row.kind === "machine" ? "machine" : "browser",
		createdAt: Number(row.createdAt),
		lastSeenAt: Number(row.lastSeenAt),
		expiresAt: Number(row.expiresAt),
		rememberDevice: row.rememberDevice,
		csrfSecret: row.csrfSecret,
		ip: row.ip ?? null,
		userAgent: row.userAgent ?? null,
		scopes: Array.isArray(row.scopes) ? row.scopes : [],
		revokedAt: row.revokedAt === null || row.revokedAt === void 0 ? null : Number(row.revokedAt)
	};
}
function rowToOwnerBinding(row) {
	return {
		id: row.id,
		identityId: row.identityId,
		connector: row.connector,
		externalId: row.externalId,
		displayHandle: row.displayHandle,
		instanceId: row.instanceId,
		verifiedAt: Number(row.verifiedAt),
		pendingCodeHash: row.pendingCodeHash ?? null,
		pendingExpiresAt: row.pendingExpiresAt === null || row.pendingExpiresAt === void 0 ? null : Number(row.pendingExpiresAt)
	};
}
function rowToOwnerLoginToken(row) {
	return {
		tokenHash: row.tokenHash,
		identityId: row.identityId,
		bindingId: row.bindingId,
		issuedAt: Number(row.issuedAt),
		expiresAt: Number(row.expiresAt),
		consumedAt: row.consumedAt === null || row.consumedAt === void 0 ? null : Number(row.consumedAt)
	};
}
var AuthStore;
var init_auth_store = __esmMin((() => {
	AuthStore = class {
		db;
		constructor(db) {
			this.db = db;
		}
		async createIdentity(input) {
			const row = (await this.db.insert(authIdentityTable).values({
				id: input.id,
				kind: input.kind,
				displayName: input.displayName,
				createdAt: input.createdAt,
				passwordHash: nullableString(input.passwordHash),
				cloudUserId: nullableString(input.cloudUserId)
			}).returning())[0];
			if (!row) throw new Error("auth-store: createIdentity returned no row");
			return rowToIdentity(row);
		}
		async findIdentity(id) {
			const row = (await this.db.select().from(authIdentityTable).where(eq(authIdentityTable.id, id)).limit(1))[0];
			return row ? rowToIdentity(row) : null;
		}
		async findIdentityByCloudUserId(cloudUserId) {
			const row = (await this.db.select().from(authIdentityTable).where(eq(authIdentityTable.cloudUserId, cloudUserId)).limit(1))[0];
			return row ? rowToIdentity(row) : null;
		}
		async findIdentityByDisplayName(displayName) {
			const row = (await this.db.select().from(authIdentityTable).where(eq(authIdentityTable.displayName, displayName)).limit(1))[0];
			return row ? rowToIdentity(row) : null;
		}
		async updateIdentityPassword(id, passwordHash) {
			await this.db.update(authIdentityTable).set({ passwordHash }).where(eq(authIdentityTable.id, id));
		}
		async listIdentitiesByKind(kind) {
			return (await this.db.select().from(authIdentityTable).where(eq(authIdentityTable.kind, kind))).map(rowToIdentity);
		}
		async hasOwnerIdentity() {
			return (await this.db.select({ id: authIdentityTable.id }).from(authIdentityTable).where(eq(authIdentityTable.kind, "owner")).limit(1)).length > 0;
		}
		async createSession(input) {
			const row = (await this.db.insert(authSessionTable).values({
				id: input.id,
				identityId: input.identityId,
				kind: input.kind,
				createdAt: input.createdAt,
				lastSeenAt: input.lastSeenAt,
				expiresAt: input.expiresAt,
				rememberDevice: input.rememberDevice,
				csrfSecret: input.csrfSecret,
				ip: nullableString(input.ip),
				userAgent: nullableString(input.userAgent),
				scopes: input.scopes
			}).returning())[0];
			if (!row) throw new Error("auth-store: createSession returned no row");
			return rowToSession(row);
		}
		/**
		* Look up a session by id. Returns `null` for unknown id, expired session,
		* or revoked session — the caller MUST treat `null` as "not authenticated"
		* and never as "transient error".
		*/
		async findSession(id, now = Date.now()) {
			const row = (await this.db.select().from(authSessionTable).where(eq(authSessionTable.id, id)).limit(1))[0];
			if (!row) return null;
			const session = rowToSession(row);
			if (session.revokedAt !== null) return null;
			if (session.expiresAt <= now) return null;
			return session;
		}
		async revokeSession(id, now = Date.now()) {
			const result = await this.db.update(authSessionTable).set({ revokedAt: now }).where(and(eq(authSessionTable.id, id), isNull(authSessionTable.revokedAt)));
			return typeof result.rowCount === "number" ? result.rowCount > 0 : true;
		}
		/**
		* Slide the browser session forward: bump `lastSeenAt` and extend
		* `expiresAt`. Caller computes the new `expiresAt` so the store stays
		* policy-free.
		*/
		async touchSession(id, lastSeenAt, expiresAt) {
			await this.db.update(authSessionTable).set({
				lastSeenAt,
				expiresAt
			}).where(and(eq(authSessionTable.id, id), isNull(authSessionTable.revokedAt)));
		}
		/**
		* Revoke every active session for an identity, except optionally the one
		* currently in use. Returns the number of rows updated. Implemented in a
		* single statement — no read/write race window.
		*/
		async revokeAllSessionsForIdentity(identityId, now = Date.now(), exceptSessionId) {
			const condition = exceptSessionId ? and(eq(authSessionTable.identityId, identityId), isNull(authSessionTable.revokedAt), ne(authSessionTable.id, exceptSessionId)) : and(eq(authSessionTable.identityId, identityId), isNull(authSessionTable.revokedAt));
			const result = await this.db.update(authSessionTable).set({ revokedAt: now }).where(condition);
			return typeof result.rowCount === "number" ? result.rowCount : 0;
		}
		/**
		* Mark every active legacy machine session (scopes containing the literal
		* "legacy" entry) as revoked. Used when a real auth method lands and the
		* legacy bearer must be retired immediately.
		*/
		async revokeLegacyBearerSessions(now = Date.now()) {
			const allMachine = await this.db.select().from(authSessionTable).where(and(eq(authSessionTable.kind, "machine"), isNull(authSessionTable.revokedAt)));
			let revoked = 0;
			for (const row of allMachine) {
				const session = rowToSession(row);
				if (!session.scopes.includes("legacy")) continue;
				await this.db.update(authSessionTable).set({ revokedAt: now }).where(eq(authSessionTable.id, session.id));
				revoked += 1;
			}
			return revoked;
		}
		/**
		* List every active (unrevoked, unexpired) session for an identity, newest
		* first. Used by `/api/auth/sessions` to populate the security UI.
		*/
		async listSessionsForIdentity(identityId, now = Date.now()) {
			const rows = await this.db.select().from(authSessionTable).where(eq(authSessionTable.identityId, identityId)).orderBy(desc(authSessionTable.lastSeenAt));
			const out = [];
			for (const row of rows) {
				const session = rowToSession(row);
				if (session.revokedAt !== null) continue;
				if (session.expiresAt <= now) continue;
				out.push(session);
			}
			return out;
		}
		/**
		* Atomic test-and-set on the bootstrap-token replay set.
		*
		* Returns `true` when this `jti` was unseen and is now recorded.
		* Returns `false` when the `jti` was already present — indicating a replay.
		*
		* Implemented via INSERT … ON CONFLICT DO NOTHING so the check is one
		* round trip and there is no TOCTOU window.
		*/
		async recordJtiSeen(jti, now = Date.now()) {
			return (await this.db.insert(authBootstrapJtiSeenTable).values({
				jti,
				seenAt: now
			}).onConflictDoNothing({ target: authBootstrapJtiSeenTable.jti }).returning()).length > 0;
		}
		async pruneJtiSeenBefore(thresholdTs) {
			await this.db.delete(authBootstrapJtiSeenTable).where(lte(authBootstrapJtiSeenTable.seenAt, thresholdTs));
		}
		async appendAuditEvent(input) {
			const row = (await this.db.insert(authAuditEventTable).values({
				id: input.id,
				ts: input.ts,
				actorIdentityId: nullableString(input.actorIdentityId),
				ip: nullableString(input.ip),
				userAgent: nullableString(input.userAgent),
				action: input.action,
				outcome: input.outcome,
				metadata: input.metadata
			}).returning())[0];
			if (!row) throw new Error("auth-store: appendAuditEvent returned no row");
			return {
				id: row.id,
				ts: Number(row.ts),
				actorIdentityId: row.actorIdentityId ?? null,
				ip: row.ip ?? null,
				userAgent: row.userAgent ?? null,
				action: row.action,
				outcome: row.outcome === "failure" ? "failure" : "success",
				metadata: row.metadata ?? {}
			};
		}
		async createOwnerBinding(input) {
			await this.db.insert(authOwnerBindingTable).values({
				id: input.id,
				identityId: input.identityId,
				connector: input.connector,
				externalId: input.externalId,
				displayHandle: input.displayHandle,
				instanceId: input.instanceId,
				verifiedAt: input.verifiedAt,
				pendingCodeHash: nullableString(input.pendingCodeHash),
				pendingExpiresAt: input.pendingExpiresAt === null || input.pendingExpiresAt === void 0 ? null : input.pendingExpiresAt
			});
		}
		async findOwnerBinding(id) {
			const row = (await this.db.select().from(authOwnerBindingTable).where(eq(authOwnerBindingTable.id, id)).limit(1))[0];
			return row ? rowToOwnerBinding(row) : null;
		}
		async findOwnerBindingByPendingCodeHash(pendingCodeHash, instanceId) {
			const row = (await this.db.select().from(authOwnerBindingTable).where(and(eq(authOwnerBindingTable.pendingCodeHash, pendingCodeHash), eq(authOwnerBindingTable.instanceId, instanceId))).limit(1))[0];
			return row ? rowToOwnerBinding(row) : null;
		}
		async findOwnerBindingByConnectorPair(input) {
			const row = (await this.db.select().from(authOwnerBindingTable).where(and(eq(authOwnerBindingTable.connector, input.connector), eq(authOwnerBindingTable.externalId, input.externalId), eq(authOwnerBindingTable.instanceId, input.instanceId))).limit(1))[0];
			return row ? rowToOwnerBinding(row) : null;
		}
		async listOwnerBindingsForIdentity(identityId) {
			return (await this.db.select().from(authOwnerBindingTable).where(eq(authOwnerBindingTable.identityId, identityId)).orderBy(desc(authOwnerBindingTable.verifiedAt))).map(rowToOwnerBinding);
		}
		async updateOwnerBindingPending(id, pendingCodeHash, pendingExpiresAt) {
			await this.db.update(authOwnerBindingTable).set({
				pendingCodeHash,
				pendingExpiresAt
			}).where(eq(authOwnerBindingTable.id, id));
		}
		async markOwnerBindingVerified(id, verifiedAt, displayHandle) {
			await this.db.update(authOwnerBindingTable).set({
				verifiedAt,
				displayHandle,
				pendingCodeHash: null,
				pendingExpiresAt: null
			}).where(eq(authOwnerBindingTable.id, id));
		}
		async deleteOwnerBinding(id) {
			const result = await this.db.delete(authOwnerBindingTable).where(eq(authOwnerBindingTable.id, id));
			return typeof result.rowCount === "number" ? result.rowCount > 0 : true;
		}
		async createOwnerLoginToken(input) {
			await this.db.insert(authOwnerLoginTokenTable).values({
				tokenHash: input.tokenHash,
				identityId: input.identityId,
				bindingId: input.bindingId,
				issuedAt: input.issuedAt,
				expiresAt: input.expiresAt
			});
		}
		async findOwnerLoginToken(tokenHash) {
			const row = (await this.db.select().from(authOwnerLoginTokenTable).where(eq(authOwnerLoginTokenTable.tokenHash, tokenHash)).limit(1))[0];
			return row ? rowToOwnerLoginToken(row) : null;
		}
		/**
		* Atomically mark the token as consumed. Returns true when the consume
		* succeeded (token existed, was unconsumed, was unexpired). Returns
		* false otherwise — the caller MUST treat false as "auth failure" and
		* never as "transient error".
		*/
		async consumeOwnerLoginToken(tokenHash, now) {
			const result = await this.db.update(authOwnerLoginTokenTable).set({ consumedAt: now }).where(and(eq(authOwnerLoginTokenTable.tokenHash, tokenHash), isNull(authOwnerLoginTokenTable.consumedAt)));
			return typeof result.rowCount === "number" ? result.rowCount > 0 : true;
		}
	};
}));

//#endregion
//#region node_modules/.bun/@elizaos+app-core@2.0.0-alpha.537+72829346cb4c43b1/node_modules/@elizaos/app-core/packages/app-core/src/api/auth.js
/**
* API authentication helpers extracted from server.ts.
*
* Centralises token extraction from multiple header formats and
* timing-safe comparison so route handlers don't reimplement it.
*/
/**
* Normalise a potentially multi-valued HTTP header into a single string.
* Returns `null` when the header is absent or empty.
*/
function extractHeaderValue(value) {
	if (typeof value === "string") return value;
	return Array.isArray(value) && typeof value[0] === "string" ? value[0] : null;
}
/**
* Read the configured API token from env (`ELIZA_API_TOKEN` / `ELIZA_API_TOKEN`).
* Returns `null` when no token is configured (open access).
*/
function getCompatApiToken$1() {
	return resolveApiToken(process.env);
}
/**
* Extract the API token from an incoming request.
*
* Checks (in order):
*   1. `Authorization: Bearer <token>`
*   2. `x-eliza-token`
*   3. `x-elizaos-token`
*   4. `x-api-key` / `x-api-token`
*/
function getProvidedApiToken(req) {
	const authHeader = extractHeaderValue(req.headers.authorization)?.slice(0, 1024)?.trim();
	if (authHeader) {
		const match = /^Bearer\s{1,8}(.+)$/i.exec(authHeader);
		if (match?.[1]) return match[1].trim();
	}
	return (extractHeaderValue(req.headers["x-eliza-token"]) ?? extractHeaderValue(req.headers["x-elizaos-token"]) ?? extractHeaderValue(req.headers["x-api-key"]) ?? extractHeaderValue(req.headers["x-api-token"]))?.trim() || null;
}
function isAuthRateLimited(ip) {
	const key = ip ?? "unknown";
	const now = Date.now();
	const entry = authAttempts.get(key);
	if (!entry || now > entry.resetAt) return false;
	return entry.count >= AUTH_RATE_LIMIT_MAX;
}
function recordFailedAuth(ip) {
	const key = ip ?? "unknown";
	const now = Date.now();
	const entry = authAttempts.get(key);
	if (!entry || now > entry.resetAt) authAttempts.set(key, {
		count: 1,
		resetAt: now + AUTH_RATE_LIMIT_WINDOW_MS
	});
	else entry.count += 1;
}
/**
* Gate a request behind the configured API token (sync, bearer-only).
*
* Use this only on cold paths where no `AuthStore` exists yet (boot
* sequence, or before plugin-sql has attached its adapter). Every route
* that runs after the runtime is up should use
* {@link ensureCompatApiAuthorizedAsync} instead, which understands
* session cookies + CSRF.
*/
function ensureCompatApiAuthorized(req, res) {
	if (isTrustedLocalRequest(req)) return true;
	const expectedToken = getCompatApiToken$1();
	if (!expectedToken) {
		sendJsonError(res, 401, "Unauthorized");
		return false;
	}
	const ip = req.socket?.remoteAddress ?? null;
	if (isAuthRateLimited(ip)) {
		sendJsonError(res, 429, "Too many authentication attempts");
		return false;
	}
	const providedToken = getProvidedApiToken(req);
	if (providedToken && tokenMatches(expectedToken, providedToken)) return true;
	recordFailedAuth(ip);
	sendJsonError(res, 401, "Unauthorized");
	return false;
}
/**
* Cookie-aware authorisation gate. Tries (in order):
*   1. valid `eliza_session` cookie → session in DB → authorised.
*   2. configured static bearer (legacy) → 14-day grace window via
*      `decideLegacyBearer`; emits the deprecation header on success.
*   3. open-access fallback when no token is configured.
*
* For cookie-bound sessions, state-changing methods (POST/PUT/PATCH/DELETE)
* MUST present a valid `x-eliza-csrf` header that matches the per-session
* `csrfSecret` derivation. Reject 403 otherwise. Bearer-auth requests are
* exempt (not cookie-bound, so no CSRF risk).
*
* Returns `true` when the request may proceed; `false` after sending a
* 401/403/429.
*
* Caller supplies an `AuthStore` because importing one here would create a
* cycle with `services/auth-store.ts`. Routes typically construct one
* once per handler.
*/
async function ensureCompatApiAuthorizedAsync(req, res, options) {
	const ip = req.socket?.remoteAddress ?? null;
	if (isAuthRateLimited(ip)) {
		sendJsonError(res, 429, "Too many authentication attempts");
		return false;
	}
	if (isTrustedLocalRequest(req)) return true;
	const method = (req.method ?? "GET").toUpperCase();
	const csrfRequired = !options.skipCsrf && CSRF_REQUIRED_METHODS.has(method);
	const sessionCookie = readCookie(req, SESSION_COOKIE_NAME);
	if (sessionCookie) {
		const session = await findActiveSession(options.store, sessionCookie, options.now).catch(() => null);
		if (session) {
			if (csrfRequired) {
				if (!verifyCsrfToken(session, extractHeaderValue(req.headers[CSRF_HEADER_NAME]))) {
					sendJsonError(res, 403, "csrf_required");
					return false;
				}
			}
			return true;
		}
	}
	const provided = getProvidedApiToken(req);
	if (provided) {
		if (await findActiveSession(options.store, provided, options.now).catch(() => null)) return true;
		const expectedToken = getCompatApiToken$1();
		if (expectedToken && tokenMatches(expectedToken, provided)) {
			const userAgent = extractHeaderValue(req.headers["user-agent"]);
			const { decideLegacyBearer, recordLegacyBearerRejection, recordLegacyBearerUse, LEGACY_DEPRECATION_HEADER } = await Promise.resolve().then(() => (init_legacy_bearer(), legacy_bearer_exports));
			const decision = await decideLegacyBearer(options.store, process.env, options.now);
			if (decision.allowed) {
				if (!res.headersSent) res.setHeader(LEGACY_DEPRECATION_HEADER, "1");
				await recordLegacyBearerUse(options.store, {
					ip,
					userAgent
				}).catch((err) => {
					logger.error(`[auth] legacy bearer audit failed: ${err instanceof Error ? err.message : String(err)}`);
				});
				return true;
			}
			await recordLegacyBearerRejection(options.store, {
				ip,
				userAgent,
				reason: decision.reason ?? "post_grace"
			}).catch((err) => {
				logger.error(`[auth] legacy bearer rejection audit failed: ${err instanceof Error ? err.message : String(err)}`);
			});
			recordFailedAuth(ip);
			sendJsonError(res, 401, "Unauthorized");
			return false;
		}
	}
	if (!getCompatApiToken$1()) {
		sendJsonError(res, 401, "Unauthorized");
		return false;
	}
	recordFailedAuth(ip);
	sendJsonError(res, 401, "Unauthorized");
	return false;
}
/**
* Read the named cookie from the `cookie` header. Returns `null` when the
* header is missing or the cookie is not set.
*
* Pulled out here so route handlers don't reimplement parsing — the existing
* `compat-route-shared.ts` predates the cookie-based session model.
*/
function readCookie(req, name) {
	const raw = extractHeaderValue(req.headers.cookie);
	if (!raw) return null;
	for (const part of raw.split(";")) {
		const eq = part.indexOf("=");
		if (eq < 0) continue;
		if (part.slice(0, eq).trim() !== name) continue;
		const v = part.slice(eq + 1).trim();
		return v.length > 0 ? decodeURIComponent(v) : null;
	}
	return null;
}
/**
* Gate a sensitive route. Without a configured token, only trusted same-machine
* dashboard requests are allowed. Remote callers need a real auth method.
*/
function ensureCompatSensitiveRouteAuthorized(req, res) {
	if (!getCompatApiToken$1()) {
		if (isTrustedLocalRequest(req)) return true;
		sendJsonError(res, 403, "Sensitive endpoint requires API token authentication");
		return false;
	}
	return ensureCompatApiAuthorized(req, res);
}
/**
* Canonical async route guard. Replaces every call site of
* {@link ensureCompatApiAuthorized}. Behaviour:
*
*   - When the runtime DB is up, delegate to
*     {@link ensureCompatApiAuthorizedAsync} so cookie + CSRF +
*     legacy-bearer + machine-session paths all work.
*   - When the runtime DB is not yet available (early boot), fall back
*     to {@link ensureCompatApiAuthorized} (bearer-only). This preserves
*     the existing behaviour for cold boot probes that ran before the
*     auth subsystem was available.
*
* Pass `skipCsrf: true` for routes that mint cookies / handle their own
* CSRF (login, setup, bootstrap exchange) where the SPA cannot present a
* CSRF token because the session doesn't exist yet.
*/
async function ensureRouteAuthorized(req, res, state, options = {}) {
	const db = (state.current?.adapter)?.db;
	if (!db) return ensureCompatApiAuthorized(req, res);
	const { AuthStore } = await Promise.resolve().then(() => (init_auth_store(), auth_store_exports));
	return ensureCompatApiAuthorizedAsync(req, res, {
		store: new AuthStore(db),
		now: options.now,
		skipCsrf: options.skipCsrf
	});
}
var AUTH_RATE_LIMIT_WINDOW_MS, AUTH_RATE_LIMIT_MAX, authAttempts, authSweepTimer, CSRF_REQUIRED_METHODS, SESSION_COOKIE_NAME;
var init_auth$1 = __esmMin((() => {
	init_sessions();
	init_tokens();
	init_compat_route_shared();
	init_response();
	AUTH_RATE_LIMIT_WINDOW_MS = 60 * 1e3;
	AUTH_RATE_LIMIT_MAX = 20;
	authAttempts = /* @__PURE__ */ new Map();
	authSweepTimer = setInterval(() => {
		const now = Date.now();
		for (const [key, entry] of authAttempts) if (now > entry.resetAt) authAttempts.delete(key);
	}, 300 * 1e3);
	if (typeof authSweepTimer === "object" && "unref" in authSweepTimer) authSweepTimer.unref();
	CSRF_REQUIRED_METHODS = new Set([
		"POST",
		"PUT",
		"PATCH",
		"DELETE"
	]);
	SESSION_COOKIE_NAME = "eliza_session";
}));

//#endregion
//#region node_modules/.bun/@elizaos+app-core@2.0.0-alpha.537+72829346cb4c43b1/node_modules/@elizaos/app-core/packages/app-core/src/api/automation-node-contributors.js
function listAutomationNodeContributors() {
	return [...contributors.values()];
}
var contributors;
var init_automation_node_contributors = __esmMin((() => {
	contributors = /* @__PURE__ */ new Map();
}));

//#endregion
//#region node_modules/.bun/@elizaos+app-core@2.0.0-alpha.537+72829346cb4c43b1/node_modules/@elizaos/app-core/packages/app-core/src/api/n8n-clarification.js
function isStructuredClarification(v) {
	if (!v || typeof v !== "object") return false;
	const o = v;
	if (typeof o.question !== "string" || o.question.trim().length === 0) return false;
	return true;
}
function coerceClarifications(raw) {
	if (!Array.isArray(raw) || raw.length === 0) return [];
	const out = [];
	for (const item of raw) {
		if (typeof item === "string") {
			const trimmed = item.trim();
			if (trimmed.length === 0) continue;
			out.push({
				kind: "free_text",
				question: trimmed,
				paramPath: ""
			});
			continue;
		}
		if (!isStructuredClarification(item)) continue;
		const o = item;
		const kindRaw = typeof o.kind === "string" ? o.kind : "free_text";
		const kind = VALID_KINDS.has(kindRaw) ? kindRaw : "free_text";
		const platform = typeof o.platform === "string" ? o.platform : void 0;
		let scope;
		if (o.scope && typeof o.scope === "object" && typeof o.scope.guildId === "string") scope = { guildId: o.scope.guildId };
		const paramPath = typeof o.paramPath === "string" ? o.paramPath : "";
		out.push({
			kind,
			platform,
			scope,
			question: o.question.trim(),
			paramPath
		});
	}
	return out;
}
/**
* Tokenizer for paramPath. Handles three segment forms:
*   - dot identifier:        `parameters`
*   - bracketed quoted key:  `["Discord Send"]` or `['k']`
*   - bracketed numeric:     `[0]`
*/
function parseParamPath(path) {
	const segments = [];
	let i = 0;
	const n = path.length;
	while (i < n) {
		const ch = path[i];
		if (ch === ".") {
			i += 1;
			continue;
		}
		if (ch === "[") {
			const close = path.indexOf("]", i);
			if (close < 0) throw new Error(`unterminated bracket at index ${i}`);
			const inner = path.slice(i + 1, close).trim();
			if (inner.length === 0) throw new Error(`empty bracket at index ${i}`);
			const first = inner[0];
			const last = inner[inner.length - 1];
			if (first === "\"" && last === "\"" || first === "'" && last === "'") segments.push(inner.slice(1, -1));
			else if (/^[0-9]+$/.test(inner)) segments.push(inner);
			else segments.push(inner);
			i = close + 1;
			continue;
		}
		let j = i;
		while (j < n && path[j] !== "." && path[j] !== "[") j += 1;
		const ident = path.slice(i, j).trim();
		if (ident.length === 0) throw new Error(`empty identifier at index ${i}`);
		segments.push(ident);
		i = j;
	}
	if (segments.length === 0) throw new Error("paramPath has no segments");
	return segments;
}
/**
* Mutate `obj` so that its value at `paramPath` becomes `value`. Creates
* intermediate plain objects as needed; never replaces an existing
* non-object intermediate (those throw, since the path is invalid).
*
* Numeric segments index into arrays. If the segment expects an array but
* the existing intermediate is a non-array object, we treat it as an
* object key (n8n workflow shapes mix arrays and objects fairly freely;
* we err on the side of preserving the existing structure).
*/
function setByDotPath(obj, paramPath, value) {
	const segments = parseParamPath(paramPath);
	let cur = obj;
	for (let i = 0; i < segments.length - 1; i += 1) {
		const seg = segments[i];
		const isArrayIndex = /^[0-9]+$/.test(seg);
		if (Array.isArray(cur)) {
			if (!isArrayIndex) throw new Error(`paramPath segment "${seg}" is not a valid array index at depth ${i}`);
			const idx = Number(seg);
			let next = cur[idx];
			if (next === void 0 || next === null) {
				next = /^[0-9]+$/.test(segments[i + 1]) ? [] : {};
				cur[idx] = next;
			}
			if (typeof next !== "object" || next === null) throw new Error(`paramPath cannot descend into non-object at "${seg}" (depth ${i})`);
			cur = next;
			continue;
		}
		let next = cur[seg];
		if (next === void 0 || next === null) {
			next = /^[0-9]+$/.test(segments[i + 1]) ? [] : {};
			cur[seg] = next;
		}
		if (typeof next !== "object" || next === null) throw new Error(`paramPath cannot descend into non-object at "${seg}" (depth ${i})`);
		cur = next;
	}
	const last = segments[segments.length - 1];
	if (Array.isArray(cur)) {
		if (!/^[0-9]+$/.test(last)) throw new Error(`paramPath terminal segment "${last}" must be numeric at array`);
		cur[Number(last)] = value;
	} else cur[last] = value;
}
function applyResolutions(draft, resolutions) {
	for (const r of resolutions) {
		if (!r || typeof r.paramPath !== "string" || r.paramPath.length === 0) return {
			ok: false,
			error: "resolution missing paramPath"
		};
		if (typeof r.value !== "string") return {
			ok: false,
			error: "resolution value must be a string",
			paramPath: r.paramPath
		};
		try {
			setByDotPath(draft, r.paramPath, r.value);
		} catch (err) {
			return {
				ok: false,
				error: err instanceof Error ? err.message : String(err),
				paramPath: r.paramPath
			};
		}
	}
	return { ok: true };
}
/**
* Drop the resolved clarifications from the draft's `_meta` so the next
* read of the draft does not re-prompt the user for the same parameter.
*/
function pruneResolvedClarifications(draft, resolved) {
	const meta = draft._meta;
	if (!meta || typeof meta !== "object") return;
	const list = meta.requiresClarification;
	if (!Array.isArray(list)) return;
	const remaining = list.filter((item) => {
		if (typeof item === "string") return true;
		if (item && typeof item === "object") {
			const path = item.paramPath;
			if (typeof path === "string" && resolved.has(path)) return false;
		}
		return true;
	});
	if (remaining.length === 0) delete meta.requiresClarification;
	else meta.requiresClarification = remaining;
}
/**
* Build a catalog snapshot for the platforms referenced by `clarifications`.
* If multiple clarifications reference the same platform, we union their
* groupId scopes — broader queries (no scope) always win.
*/
async function buildCatalogSnapshot(catalog, clarifications) {
	const platforms = /* @__PURE__ */ new Set();
	for (const c of clarifications) if (c.platform) platforms.add(c.platform);
	if (platforms.size === 0) return [];
	const out = [];
	const seen = /* @__PURE__ */ new Set();
	for (const platform of platforms) {
		const groups = await catalog.listGroups({ platform });
		for (const g of groups) {
			const key = `${g.platform}::${g.groupId}`;
			if (seen.has(key)) continue;
			seen.add(key);
			out.push(g);
		}
	}
	return out;
}
var VALID_KINDS;
var init_n8n_clarification = __esmMin((() => {
	VALID_KINDS = new Set([
		"target_channel",
		"target_server",
		"recipient",
		"value",
		"free_text"
	]);
}));

//#endregion
//#region node_modules/.bun/@elizaos+app-core@2.0.0-alpha.537+72829346cb4c43b1/node_modules/@elizaos/app-core/packages/app-core/src/api/n8n-routes.js
/**
* n8n routes — status surface + workflow CRUD proxy + sidecar lifecycle.
*
* Exposes:
*   GET    /api/n8n/status                          — mode + sidecar state
*   POST   /api/n8n/sidecar/start                   — fire-and-forget sidecar boot
*   GET    /api/n8n/workflows                       — list workflows
*   POST   /api/n8n/workflows                       — create workflow
*   POST   /api/n8n/workflows/generate              — generate + create/update workflow
*   PUT    /api/n8n/workflows/{id}                  — update workflow
*   POST   /api/n8n/workflows/{id}/activate         — activate workflow
*   POST   /api/n8n/workflows/{id}/deactivate       — deactivate workflow
*   DELETE /api/n8n/workflows/{id}                  — delete workflow
*
* Status is the only read-only surface. The workflow CRUD handlers proxy
* to the actual n8n backend:
*   - Cloud mode  → `${cloudBaseUrl}/api/v1/agents/${agentId}/n8n/workflows/...`
*                   with `Authorization: Bearer ${cloud.apiKey}`
*   - Local mode  → `${sidecar.host}/rest/workflows/...`
*                   with `X-N8N-API-KEY: ${sidecar.getApiKey()}` (n8n native)
*   - Disabled / sidecar not ready → 503 `{ error, status }`
*
* The provisioned API key is never returned to the UI.
*
* Context shape is `{ req, res, method, pathname, config, runtime, json }`.
* The sidecar instance is read from the module-level singleton in
* services/n8n-sidecar.ts rather than being threaded through state.
*/
async function probeCloudHealth(baseUrl, fetchImpl) {
	const url = `${normalizeBaseUrl(baseUrl)}/api/v1/health`;
	try {
		return (await fetchImpl(url, {
			method: "GET",
			headers: { Accept: "application/json" },
			signal: AbortSignal.timeout(CLOUD_HEALTH_PROBE_TIMEOUT_MS)
		})).ok ? "ok" : "degraded";
	} catch (err) {
		logger.debug(`[n8n-routes] cloud health probe failed: ${err instanceof Error ? err.message : String(err)}`);
		return "degraded";
	}
}
async function getCloudHealth(baseUrl, fetchImpl) {
	const key = normalizeBaseUrl(baseUrl);
	const now = Date.now();
	const cached = cloudHealthCache.get(key);
	if (cached && cached.expiresAt > now) return cached.health;
	const health = await probeCloudHealth(key, fetchImpl);
	cloudHealthCache.set(key, {
		health,
		expiresAt: now + CLOUD_HEALTH_CACHE_TTL_MS
	});
	return health;
}
/**
* Dynamically import the sidecar module. Keeps `node:child_process` out of
* the module graph for mobile bundles — `isNativeServerPlatform()` is true
* on Capacitor-hosted iOS / Android, in which case the sidecar code path
* is never reached.
*/
async function loadSidecarModule() {
	if (isNativeServerPlatform()) return null;
	return await Promise.resolve().then(() => (init_n8n_sidecar(), n8n_sidecar_exports));
}
function normalizeBaseUrl(raw) {
	const trimmed = (raw ?? "").trim();
	return (trimmed.length > 0 ? trimmed : DEFAULT_CLOUD_API_BASE_URL$1).replace(/\/+$/, "");
}
function resolveAgentId(ctx) {
	if (ctx.agentId?.trim()) return ctx.agentId.trim();
	const runtimeAny = ctx.runtime;
	return runtimeAny?.agentId ?? runtimeAny?.character?.id ?? "00000000-0000-0000-0000-000000000000";
}
function sendJson$1(ctx, status, body) {
	const json = ctx.json;
	json(ctx.res, body, status);
}
/** Strip any credential material from node descriptors before forwarding. */
function sanitizeNode(n) {
	if (!n || typeof n !== "object") return {};
	const obj = n;
	return {
		...typeof obj.id === "string" ? { id: obj.id } : {},
		...typeof obj.name === "string" ? { name: obj.name } : {},
		...typeof obj.type === "string" ? { type: obj.type } : {},
		...typeof obj.typeVersion === "number" ? { typeVersion: obj.typeVersion } : {}
	};
}
/**
* Full node sanitizer for single-workflow GET — includes position and
* parameters (needed by the graph viewer). Credentials are still stripped.
*/
function sanitizeNodeFull(n) {
	if (!n || typeof n !== "object") return {};
	const obj = n;
	const base = sanitizeNode(n);
	const pos = obj.position;
	const position = Array.isArray(pos) && pos.length >= 2 && typeof pos[0] === "number" && typeof pos[1] === "number" ? [pos[0], pos[1]] : void 0;
	const parameters = obj.parameters && typeof obj.parameters === "object" ? obj.parameters : void 0;
	return {
		...base,
		...position !== void 0 ? { position } : {},
		...parameters !== void 0 ? { parameters } : {},
		...typeof obj.notes === "string" ? { notes: obj.notes } : {},
		...typeof obj.notesInFlow === "boolean" ? { notesInFlow: obj.notesInFlow } : {}
	};
}
/** Normalize an n8n workflow payload to our client-facing shape. */
function normalizeWorkflow(raw) {
	if (!raw || typeof raw !== "object") return null;
	const obj = raw;
	const id = typeof obj.id === "string" ? obj.id : String(obj.id ?? "");
	const name = typeof obj.name === "string" ? obj.name : "";
	if (!id) return null;
	const nodes = (Array.isArray(obj.nodes) ? obj.nodes : []).map(sanitizeNode);
	return {
		id,
		name,
		active: Boolean(obj.active),
		...typeof obj.description === "string" ? { description: obj.description } : {},
		nodes,
		nodeCount: nodes.length
	};
}
/**
* Full normalizer for single-workflow GET responses.
*
* Tradeoff: the list endpoint stays shallow (id/name/type only) to keep
* sidebar payloads small — n8n workflows can have hundreds of nodes with
* large parameter blobs. The single-workflow endpoint passes through
* position, parameters, and connections so the graph viewer has everything
* it needs without a second request.
*/
function normalizeWorkflowFull(raw) {
	if (!raw || typeof raw !== "object") return null;
	const obj = raw;
	const id = typeof obj.id === "string" ? obj.id : String(obj.id ?? "");
	const name = typeof obj.name === "string" ? obj.name : "";
	if (!id) return null;
	const nodes = (Array.isArray(obj.nodes) ? obj.nodes : []).map(sanitizeNodeFull);
	const connections = obj.connections && typeof obj.connections === "object" ? obj.connections : void 0;
	return {
		id,
		name,
		active: Boolean(obj.active),
		...typeof obj.description === "string" ? { description: obj.description } : {},
		nodes,
		nodeCount: nodes.length,
		...connections !== void 0 ? { connections } : {}
	};
}
/**
* Resolve the backend target for a workflow-CRUD call. Returns null target
* if the n8n backend is not currently available; caller emits a 503.
*
* `sidecar` is passed in so the caller can either skip the sidecar module
* import on mobile (where it is unsupported) or inject a test stub. When
* `sidecar` is undefined, the handler treats that as "no sidecar singleton
* yet" — identical to the old `peekN8nSidecar()` → `null` case.
*/
function resolveProxyTarget(ctx, subpath, sidecar, native) {
	const { cloudConnected, localEnabled } = resolveN8nMode({
		config: ctx.config,
		runtime: ctx.runtime,
		native
	});
	if (cloudConnected) {
		const apiKey = ctx.config.cloud?.apiKey?.trim();
		if (!apiKey) return {
			target: null,
			reason: {
				message: "cloud api key missing",
				status: "error"
			}
		};
		const baseUrl = normalizeBaseUrl(ctx.config.cloud?.baseUrl);
		const agentId = resolveAgentId(ctx);
		return { target: {
			url: `${baseUrl}/api/v1/agents/${encodeURIComponent(agentId)}/n8n/workflows${subpath}`,
			headers: {
				Authorization: `Bearer ${apiKey}`,
				Accept: "application/json"
			}
		} };
	}
	if (!localEnabled) return {
		target: null,
		reason: {
			message: "n8n disabled",
			status: "stopped"
		}
	};
	const sidecarState = sidecar?.getState();
	const status = sidecarState?.status ?? "stopped";
	if (status !== "ready") return {
		target: null,
		reason: {
			message: `n8n not ready (${status})`,
			status
		}
	};
	const host = sidecarState?.host ?? ctx.config.n8n?.host ?? null;
	if (!host) return {
		target: null,
		reason: {
			message: "n8n host unknown",
			status: "error"
		}
	};
	const apiKey = sidecar?.getApiKey() ?? ctx.config.n8n?.apiKey ?? null;
	const headers = { Accept: "application/json" };
	if (apiKey) headers["X-N8N-API-KEY"] = apiKey;
	return { target: {
		url: `${host.replace(/\/+$/, "")}/api/v1/workflows${subpath}`,
		headers
	} };
}
async function fetchTargetAsJson(ctx, target, init) {
	const fetchImpl = ctx.fetchImpl ?? fetch;
	const headers = { ...target.headers };
	if (init.body != null) headers["content-type"] = "application/json";
	let res;
	try {
		res = await fetchImpl(target.url, {
			method: init.method,
			headers,
			...init.body != null ? { body: init.body } : {},
			signal: AbortSignal.timeout(1e4)
		});
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		logger.warn(`[n8n-routes] proxy fetch failed: ${message}`);
		return {
			ok: false,
			status: 502,
			body: { error: message }
		};
	}
	let parsed = null;
	if ((res.headers.get("content-type") ?? "").includes("application/json")) try {
		parsed = await res.json();
	} catch {
		parsed = null;
	}
	else try {
		parsed = await res.text();
	} catch {
		parsed = null;
	}
	return {
		ok: res.ok,
		status: res.status,
		body: parsed
	};
}
/**
* Extracts a workflows array from an n8n or cloud-gateway list response.
* n8n returns `{ data: [...] }`; our cloud gateway may return `{ workflows }`
* or `{ data }`. We accept both.
*/
function extractWorkflowList(body) {
	if (!body || typeof body !== "object") return [];
	const obj = body;
	if (Array.isArray(obj.workflows)) return obj.workflows;
	if (Array.isArray(obj.data)) return obj.data;
	return [];
}
function extractWorkflowSingle(body) {
	if (!body || typeof body !== "object") return null;
	const obj = body;
	if (obj.data && typeof obj.data === "object") return obj.data;
	if (obj.workflow && typeof obj.workflow === "object") return obj.workflow;
	return body;
}
function asRecord$3(value) {
	return value && typeof value === "object" && !Array.isArray(value) ? value : null;
}
function readOptionalString(obj, key) {
	const value = obj[key];
	return typeof value === "string" && value.trim().length > 0 ? value.trim() : void 0;
}
function readOptionalBoolean(obj, key) {
	const value = obj[key];
	return typeof value === "boolean" ? value : void 0;
}
function readOptionalNumber(obj, key) {
	const value = obj[key];
	return typeof value === "number" && Number.isFinite(value) ? value : void 0;
}
/**
* Read the originating conversation's tail inbound message metadata and
* derive a `TriggerContext`. Reads both the canonical
* `metadata.discord.{channelId,guildId,messageId}` /
* `metadata.telegram.{chatId,threadId}` blocks AND the flat
* `discordChannelId` / `discordServerId` / `discordMessageId` fields the
* upstream Discord plugin currently writes (pre-existing schema gap —
* canonical wins when present, flat is the fallback so nothing today
* breaks).
*
* Returns `undefined` when the conversation has no inbound platform
* metadata or the runtime can't read memories.
*/
async function buildTriggerContextFromConversation(runtime, roomId) {
	if (!runtime || typeof runtime.getMemories !== "function") return void 0;
	let memories;
	try {
		memories = await runtime.getMemories({
			roomId,
			tableName: "messages",
			count: 12
		});
	} catch (err) {
		logger.debug?.(`[n8n-routes] buildTriggerContextFromConversation: getMemories threw: ${err instanceof Error ? err.message : String(err)}`);
		return;
	}
	if (!Array.isArray(memories) || memories.length === 0) return void 0;
	const inbound = memories.find((m) => m.entityId && m.entityId !== runtime.agentId);
	if (!inbound?.metadata) return void 0;
	const meta = inbound.metadata;
	const discord = meta.discord ?? {};
	const telegram = meta.telegram ?? {};
	const slack = meta.slack ?? {};
	const discordChannelId = (typeof discord.channelId === "string" ? discord.channelId : void 0) ?? (typeof meta.discordChannelId === "string" ? meta.discordChannelId : void 0);
	const discordGuildId = (typeof discord.guildId === "string" ? discord.guildId : void 0) ?? (typeof meta.discordServerId === "string" ? meta.discordServerId : void 0);
	const discordThreadId = typeof discord.threadId === "string" ? discord.threadId : void 0;
	const telegramChatId = typeof telegram.chatId === "string" || typeof telegram.chatId === "number" ? telegram.chatId : void 0;
	const telegramThreadId = typeof telegram.threadId === "string" || typeof telegram.threadId === "number" ? telegram.threadId : void 0;
	const slackChannelId = typeof slack.channelId === "string" ? slack.channelId : void 0;
	const slackTeamId = typeof slack.teamId === "string" ? slack.teamId : void 0;
	if (discordChannelId) return {
		source: "discord",
		discord: {
			...discordChannelId ? { channelId: discordChannelId } : {},
			...discordGuildId ? { guildId: discordGuildId } : {},
			...discordThreadId ? { threadId: discordThreadId } : {}
		}
	};
	if (telegramChatId !== void 0) return {
		source: "telegram",
		telegram: {
			chatId: telegramChatId,
			...telegramThreadId !== void 0 ? { threadId: telegramThreadId } : {}
		}
	};
	if (slackChannelId) return {
		source: "slack",
		slack: {
			channelId: slackChannelId,
			...slackTeamId ? { teamId: slackTeamId } : {}
		}
	};
}
function readPosition(value) {
	return Array.isArray(value) && value.length >= 2 && typeof value[0] === "number" && typeof value[1] === "number" ? [value[0], value[1]] : null;
}
function readCredentials(value) {
	const raw = asRecord$3(value);
	if (!raw) return void 0;
	const credentials = {};
	for (const [key, credentialValue] of Object.entries(raw)) {
		const credential = asRecord$3(credentialValue);
		if (!credential) continue;
		const id = readOptionalString(credential, "id");
		const name = readOptionalString(credential, "name");
		if (!id || !name) continue;
		credentials[key] = {
			id,
			name
		};
	}
	return Object.keys(credentials).length > 0 ? credentials : void 0;
}
function normalizeWorkflowWriteNode(value, index) {
	const obj = asRecord$3(value);
	if (!obj) return null;
	const name = readOptionalString(obj, "name");
	const type = readOptionalString(obj, "type");
	if (!name || !type) return null;
	const position = readPosition(obj.position) ?? [index * 260, 0];
	const parameters = asRecord$3(obj.parameters) ?? {};
	const typeVersion = readOptionalNumber(obj, "typeVersion") ?? 1;
	const credentials = readCredentials(obj.credentials);
	return {
		...readOptionalString(obj, "id") ? { id: readOptionalString(obj, "id") } : {},
		name,
		type,
		typeVersion,
		position,
		parameters,
		...credentials ? { credentials } : {},
		...readOptionalBoolean(obj, "disabled") !== void 0 ? { disabled: readOptionalBoolean(obj, "disabled") } : {},
		...readOptionalString(obj, "notes") ? { notes: readOptionalString(obj, "notes") } : {},
		...readOptionalBoolean(obj, "notesInFlow") !== void 0 ? { notesInFlow: readOptionalBoolean(obj, "notesInFlow") } : {},
		...readOptionalString(obj, "color") ? { color: readOptionalString(obj, "color") } : {},
		...readOptionalBoolean(obj, "continueOnFail") !== void 0 ? { continueOnFail: readOptionalBoolean(obj, "continueOnFail") } : {},
		...readOptionalBoolean(obj, "executeOnce") !== void 0 ? { executeOnce: readOptionalBoolean(obj, "executeOnce") } : {},
		...readOptionalBoolean(obj, "alwaysOutputData") !== void 0 ? { alwaysOutputData: readOptionalBoolean(obj, "alwaysOutputData") } : {},
		...readOptionalBoolean(obj, "retryOnFail") !== void 0 ? { retryOnFail: readOptionalBoolean(obj, "retryOnFail") } : {},
		...readOptionalNumber(obj, "maxTries") !== void 0 ? { maxTries: readOptionalNumber(obj, "maxTries") } : {},
		...readOptionalNumber(obj, "waitBetweenTries") !== void 0 ? { waitBetweenTries: readOptionalNumber(obj, "waitBetweenTries") } : {},
		...obj.onError === "continueErrorOutput" || obj.onError === "continueRegularOutput" || obj.onError === "stopWorkflow" ? { onError: obj.onError } : {}
	};
}
function normalizeWorkflowConnections(value) {
	const raw = asRecord$3(value);
	if (!raw) return {};
	const connections = {};
	for (const [sourceName, outputValue] of Object.entries(raw)) {
		const outputMap = asRecord$3(outputValue);
		if (!outputMap) continue;
		const mainRaw = outputMap.main;
		if (!Array.isArray(mainRaw)) continue;
		connections[sourceName] = { main: mainRaw.map((group) => Array.isArray(group) ? group.map((connection) => {
			const obj = asRecord$3(connection);
			const node = obj ? readOptionalString(obj, "node") : void 0;
			if (!obj || !node) return null;
			return {
				node,
				type: "main",
				index: readOptionalNumber(obj, "index") ?? 0
			};
		}).filter((connection) => connection !== null) : []) };
	}
	return connections;
}
function normalizeWorkflowWritePayload(body) {
	const name = readOptionalString(body, "name");
	if (!name) return { error: "workflow name required" };
	const nodes = (Array.isArray(body.nodes) ? body.nodes : []).map((node, index) => normalizeWorkflowWriteNode(node, index)).filter((node) => node !== null);
	if (nodes.length === 0) return { error: "workflow must include at least one valid node" };
	return { payload: {
		name,
		nodes,
		connections: normalizeWorkflowConnections(body.connections),
		settings: asRecord$3(body.settings) ?? {}
	} };
}
function propagateError(ctx, upstream) {
	const status = upstream.status >= 400 && upstream.status < 600 ? upstream.status : 502;
	let message = `upstream responded with ${upstream.status}`;
	if (upstream.body && typeof upstream.body === "object") {
		const b = upstream.body;
		const candidate = b.error ?? b.message;
		if (typeof candidate === "string" && candidate.length > 0) message = candidate;
	} else if (typeof upstream.body === "string" && upstream.body.length > 0) message = upstream.body;
	sendJson$1(ctx, status, { error: message });
}
/**
* Parse `/api/n8n/workflows/{id}[/activate|/deactivate]` into (id, action).
* Returns null if pathname doesn't match.
*/
function parseWorkflowPath(pathname) {
	if (!pathname.startsWith("/api/n8n/workflows/")) return null;
	const rest = pathname.slice(19);
	if (!rest) return null;
	const parts = rest.split("/").filter(Boolean);
	if (parts.length === 1) return {
		id: decodeURIComponent(parts[0] ?? ""),
		action: "get"
	};
	if (parts.length === 2) {
		const action = parts[1];
		if (action === "activate" || action === "deactivate") return {
			id: decodeURIComponent(parts[0] ?? ""),
			action
		};
	}
	return null;
}
/**
* Resolve the sidecar singleton for this request. On mobile the sidecar
* module is never imported; callers receive `null` and the downstream
* resolver treats that as "no local backend available". Tests inject a
* concrete stub via `ctx.n8nSidecar`.
*/
async function resolveSidecarForRequest(ctx, native) {
	if (ctx.n8nSidecar !== void 0) return ctx.n8nSidecar;
	if (native) return null;
	return (await loadSidecarModule())?.peekN8nSidecar() ?? null;
}
async function handleN8nRoutes(ctx) {
	const { method, pathname, config } = ctx;
	const native = ctx.isNativePlatform ?? isNativeServerPlatform();
	if (method === "GET" && pathname === "/api/n8n/status") return handleStatus(ctx, await resolveSidecarForRequest(ctx, native), native);
	if (method === "POST" && pathname === "/api/n8n/sidecar/start") {
		if (native) {
			sendJson$1(ctx, 409, {
				error: "Local n8n not supported on mobile. Use Eliza Cloud.",
				platform: "mobile"
			});
			return true;
		}
		const mod = await loadSidecarModule();
		const sidecar = ctx.n8nSidecar ?? mod?.getN8nSidecar({
			enabled: config.n8n?.localEnabled ?? true,
			...config.n8n?.version ? { version: config.n8n.version } : {},
			...config.n8n?.startPort ? { startPort: config.n8n.startPort } : {}
		});
		if (!sidecar) {
			sendJson$1(ctx, 500, { error: "n8n sidecar module unavailable" });
			return true;
		}
		sidecar.start();
		sendJson$1(ctx, 202, { ok: true });
		return true;
	}
	if (method === "GET" && pathname === "/api/n8n/workflows") return handleListWorkflows(ctx, await resolveSidecarForRequest(ctx, native), native);
	if (method === "POST" && pathname === "/api/n8n/workflows/generate") return handleGenerateWorkflow(ctx);
	if (method === "POST" && pathname === "/api/n8n/workflows/resolve-clarification") return handleResolveClarification(ctx);
	if (method === "POST" && pathname === "/api/n8n/workflows") return handleCreateWorkflow(ctx, await resolveSidecarForRequest(ctx, native), native);
	const parsed = parseWorkflowPath(pathname);
	if (parsed) {
		if (method === "POST" && parsed.action === "activate") {
			const sidecar = await resolveSidecarForRequest(ctx, native);
			return handleToggleWorkflow(ctx, parsed.id, true, sidecar, native);
		}
		if (method === "POST" && parsed.action === "deactivate") {
			const sidecar = await resolveSidecarForRequest(ctx, native);
			return handleToggleWorkflow(ctx, parsed.id, false, sidecar, native);
		}
		if (method === "GET" && parsed.action === "get") {
			const sidecar = await resolveSidecarForRequest(ctx, native);
			return handleGetWorkflow(ctx, parsed.id, sidecar, native);
		}
		if (method === "PUT" && parsed.action === "get") {
			const sidecar = await resolveSidecarForRequest(ctx, native);
			return handleUpdateWorkflow(ctx, parsed.id, sidecar, native);
		}
		if (method === "DELETE" && parsed.action === "get") {
			const sidecar = await resolveSidecarForRequest(ctx, native);
			return handleDeleteWorkflow(ctx, parsed.id, sidecar, native);
		}
	}
	return false;
}
async function handleStatus(ctx, sidecar, native) {
	const { config, runtime } = ctx;
	const { mode, localEnabled, cloudConnected } = resolveN8nMode({
		config,
		runtime,
		native
	});
	const sidecarState = sidecar?.getState();
	const status = sidecarState?.status ?? "stopped";
	const host = mode === "local" ? sidecarState?.host ?? config.n8n?.host ?? null : null;
	let cloudHealth = "unknown";
	if (mode === "cloud") if (ctx.cloudHealthOverride !== void 0) cloudHealth = ctx.cloudHealthOverride;
	else cloudHealth = await getCloudHealth(config.cloud?.baseUrl ?? DEFAULT_CLOUD_API_BASE_URL$1, ctx.fetchImpl ?? fetch);
	const payload = {
		mode,
		host,
		status,
		cloudConnected,
		localEnabled,
		platform: native ? "mobile" : "desktop",
		cloudHealth,
		...sidecarState ? {
			errorMessage: sidecarState.errorMessage,
			retries: sidecarState.retries,
			recentOutput: sidecarState.recentOutput
		} : {}
	};
	ctx.json(ctx.res, payload);
	return true;
}
async function handleListWorkflows(ctx, sidecar, native) {
	const resolved = resolveProxyTarget(ctx, "", sidecar, native);
	if (!resolved.target) {
		sendJson$1(ctx, 503, {
			error: resolved.reason?.message ?? "n8n not ready",
			status: resolved.reason?.status ?? "stopped"
		});
		return true;
	}
	const upstream = await fetchTargetAsJson(ctx, resolved.target, { method: "GET" });
	if (!upstream.ok) {
		propagateError(ctx, upstream);
		return true;
	}
	sendJson$1(ctx, 200, { workflows: extractWorkflowList(upstream.body).map(normalizeWorkflow).filter((w) => w !== null) });
	return true;
}
/**
* GET /api/n8n/workflows/:id — single-workflow fetch with full graph payload.
*
* Unlike the list endpoint (which stays shallow for sidebar performance),
* this response includes node `position`, `parameters`, and the `connections`
* map so the graph viewer can render nodes and edges without a second request.
* Credentials are still stripped from node descriptors.
*/
async function handleGetWorkflow(ctx, id, sidecar, native) {
	if (!id) {
		sendJson$1(ctx, 400, { error: "workflow id required" });
		return true;
	}
	const resolved = resolveProxyTarget(ctx, `/${encodeURIComponent(id)}`, sidecar, native);
	if (!resolved.target) {
		sendJson$1(ctx, 503, {
			error: resolved.reason?.message ?? "n8n not ready",
			status: resolved.reason?.status ?? "stopped"
		});
		return true;
	}
	const upstream = await fetchTargetAsJson(ctx, resolved.target, { method: "GET" });
	if (!upstream.ok) {
		propagateError(ctx, upstream);
		return true;
	}
	const normalized = normalizeWorkflowFull(extractWorkflowSingle(upstream.body));
	if (!normalized) {
		sendJson$1(ctx, 502, { error: "unexpected upstream shape" });
		return true;
	}
	sendJson$1(ctx, 200, normalized);
	return true;
}
async function writeWorkflow(ctx, method, subpath, payload, sidecar, native) {
	const resolved = resolveProxyTarget(ctx, subpath, sidecar, native);
	if (!resolved.target) {
		sendJson$1(ctx, 503, {
			error: resolved.reason?.message ?? "n8n not ready",
			status: resolved.reason?.status ?? "stopped"
		});
		return true;
	}
	const upstream = await fetchTargetAsJson(ctx, resolved.target, {
		method,
		body: JSON.stringify(payload)
	});
	if (!upstream.ok) {
		propagateError(ctx, upstream);
		return true;
	}
	const normalized = normalizeWorkflowFull(extractWorkflowSingle(upstream.body));
	if (!normalized) {
		sendJson$1(ctx, 502, { error: "unexpected upstream shape" });
		return true;
	}
	sendJson$1(ctx, 200, normalized);
	return true;
}
async function handleCreateWorkflow(ctx, sidecar, native) {
	const body = await readCompatJsonBody(ctx.req, ctx.res);
	if (!body) return true;
	const { payload, error } = normalizeWorkflowWritePayload(body);
	if (!payload) {
		sendJson$1(ctx, 400, { error: error ?? "invalid workflow payload" });
		return true;
	}
	return writeWorkflow(ctx, "POST", "", payload, sidecar, native);
}
async function handleUpdateWorkflow(ctx, id, sidecar, native) {
	if (!id) {
		sendJson$1(ctx, 400, { error: "workflow id required" });
		return true;
	}
	const body = await readCompatJsonBody(ctx.req, ctx.res);
	if (!body) return true;
	const { payload, error } = normalizeWorkflowWritePayload(body);
	if (!payload) {
		sendJson$1(ctx, 400, { error: error ?? "invalid workflow payload" });
		return true;
	}
	return writeWorkflow(ctx, "PUT", `/${encodeURIComponent(id)}`, payload, sidecar, native);
}
function getN8nWorkflowService(ctx) {
	const service = ctx.runtime?.getService?.("n8n_workflow");
	if (typeof service?.generateWorkflowDraft !== "function" || typeof service.deployWorkflow !== "function" || typeof service.getWorkflow !== "function") return null;
	return service;
}
function getConnectorTargetCatalog(ctx) {
	const candidate = ctx.runtime?.getService?.("connector_target_catalog");
	if (candidate && typeof candidate.listGroups === "function") return candidate;
	return null;
}
async function deployAndRespond(ctx, service, draft) {
	const userId = resolveAgentId(ctx);
	const deployed = await service.deployWorkflow?.(draft, userId);
	if (!deployed) {
		sendJson$1(ctx, 500, { error: "deployWorkflow not available" });
		return;
	}
	if (deployed.missingCredentials.length > 0) {
		sendJson$1(ctx, 200, {
			...deployed,
			warning: "missing credentials"
		});
		return;
	}
	sendJson$1(ctx, 200, await service.getWorkflow?.(deployed.id));
}
async function handleGenerateWorkflow(ctx) {
	const body = await readCompatJsonBody(ctx.req, ctx.res);
	if (!body) return true;
	const prompt = readOptionalString(body, "prompt");
	if (!prompt) {
		sendJson$1(ctx, 400, { error: "prompt required" });
		return true;
	}
	const name = readOptionalString(body, "name");
	const workflowId = readOptionalString(body, "workflowId");
	const bridgeConversationId = readOptionalString(body, "bridgeConversationId");
	const service = getN8nWorkflowService(ctx);
	if (!service) {
		sendJson$1(ctx, 503, { error: "n8n workflow service unavailable" });
		return true;
	}
	const triggerContext = bridgeConversationId ? await buildTriggerContextFromConversation(ctx.runtime, bridgeConversationId) : void 0;
	const draft = triggerContext ? await service.generateWorkflowDraft?.(prompt, { triggerContext }) : await service.generateWorkflowDraft?.(prompt);
	if (name?.trim()) draft.name = name.trim();
	if (workflowId) draft.id = workflowId;
	const rawClarifications = draft._meta?.requiresClarification;
	const clarifications = coerceClarifications(rawClarifications);
	if (clarifications.length > 0) {
		const catalogService = getConnectorTargetCatalog(ctx);
		sendJson$1(ctx, 200, {
			status: "needs_clarification",
			draft,
			clarifications,
			catalog: catalogService ? await buildCatalogSnapshot(catalogService, clarifications) : []
		});
		return true;
	}
	await deployAndRespond(ctx, service, draft);
	return true;
}
async function handleResolveClarification(ctx) {
	const body = await readCompatJsonBody(ctx.req, ctx.res);
	if (!body) return true;
	const draftRaw = body.draft;
	if (!draftRaw || typeof draftRaw !== "object" || Array.isArray(draftRaw)) {
		sendJson$1(ctx, 400, { error: "draft required" });
		return true;
	}
	const draft = draftRaw;
	const resolutionsRaw = body.resolutions;
	if (!Array.isArray(resolutionsRaw) || resolutionsRaw.length === 0) {
		sendJson$1(ctx, 400, { error: "resolutions required" });
		return true;
	}
	const resolutions = resolutionsRaw;
	const name = readOptionalString(body, "name");
	const workflowId = readOptionalString(body, "workflowId");
	const service = getN8nWorkflowService(ctx);
	if (!service) {
		sendJson$1(ctx, 503, { error: "n8n workflow service unavailable" });
		return true;
	}
	const result = applyResolutions(draft, resolutions);
	if (!result.ok) {
		sendJson$1(ctx, 400, {
			error: result.error,
			paramPath: result.paramPath
		});
		return true;
	}
	pruneResolvedClarifications(draft, new Set(resolutions.map((r) => r.paramPath).filter((p) => typeof p === "string" && p.length > 0)));
	if (name?.trim()) draft.name = name.trim();
	if (workflowId) draft.id = workflowId;
	const meta = draft._meta;
	const remaining = coerceClarifications(meta?.requiresClarification);
	if (remaining.length > 0) {
		const catalogService = getConnectorTargetCatalog(ctx);
		sendJson$1(ctx, 200, {
			status: "needs_clarification",
			draft,
			clarifications: remaining,
			catalog: catalogService ? await buildCatalogSnapshot(catalogService, remaining) : []
		});
		return true;
	}
	await deployAndRespond(ctx, service, draft);
	return true;
}
async function handleToggleWorkflow(ctx, id, activate, sidecar, native) {
	if (!id) {
		sendJson$1(ctx, 400, { error: "workflow id required" });
		return true;
	}
	const resolved = resolveProxyTarget(ctx, `/${encodeURIComponent(id)}/${activate ? "activate" : "deactivate"}`, sidecar, native);
	if (!resolved.target) {
		sendJson$1(ctx, 503, {
			error: resolved.reason?.message ?? "n8n not ready",
			status: resolved.reason?.status ?? "stopped"
		});
		return true;
	}
	const upstream = await fetchTargetAsJson(ctx, resolved.target, {
		method: "POST",
		body: JSON.stringify({})
	});
	if (!upstream.ok) {
		propagateError(ctx, upstream);
		return true;
	}
	const normalized = normalizeWorkflow(extractWorkflowSingle(upstream.body));
	if (!normalized) {
		sendJson$1(ctx, 200, {
			id,
			name: "",
			active: activate,
			nodes: [],
			nodeCount: 0
		});
		return true;
	}
	sendJson$1(ctx, 200, normalized);
	return true;
}
async function handleDeleteWorkflow(ctx, id, sidecar, native) {
	if (!id) {
		sendJson$1(ctx, 400, { error: "workflow id required" });
		return true;
	}
	const resolved = resolveProxyTarget(ctx, `/${encodeURIComponent(id)}`, sidecar, native);
	if (!resolved.target) {
		sendJson$1(ctx, 503, {
			error: resolved.reason?.message ?? "n8n not ready",
			status: resolved.reason?.status ?? "stopped"
		});
		return true;
	}
	const upstream = await fetchTargetAsJson(ctx, resolved.target, { method: "DELETE" });
	if (!upstream.ok) {
		propagateError(ctx, upstream);
		return true;
	}
	sendJson$1(ctx, 200, { ok: true });
	return true;
}
var CLOUD_HEALTH_CACHE_TTL_MS, CLOUD_HEALTH_PROBE_TIMEOUT_MS, cloudHealthCache, DEFAULT_CLOUD_API_BASE_URL$1;
var init_n8n_routes = __esmMin((() => {
	init_is_native_server();
	init_n8n_mode();
	init_compat_route_shared();
	init_n8n_clarification();
	CLOUD_HEALTH_CACHE_TTL_MS = 3e4;
	CLOUD_HEALTH_PROBE_TIMEOUT_MS = 2e3;
	cloudHealthCache = /* @__PURE__ */ new Map();
	DEFAULT_CLOUD_API_BASE_URL$1 = "https://api.eliza.how";
}));

//#endregion
//#region node_modules/.bun/@elizaos+app-core@2.0.0-alpha.537+72829346cb4c43b1/node_modules/@elizaos/app-core/packages/app-core/src/api/automations-compat-routes.js
function asRecord$2(value) {
	if (!value || typeof value !== "object" || Array.isArray(value)) return null;
	return value;
}
function asString(value) {
	if (typeof value !== "string") return;
	const trimmed = value.trim();
	return trimmed.length > 0 ? trimmed : void 0;
}
function normalizeDateValue(value) {
	if (typeof value === "string") {
		const parsed = Date.parse(value);
		return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
	}
	if (typeof value === "number" && Number.isFinite(value)) return new Date(value).toISOString();
	if (value instanceof Date) return value.toISOString();
	return null;
}
function humanizeCapabilityName(value) {
	return value.trim().replace(/[_-]+/g, " ").replace(/\s+/g, " ").toLowerCase().replace(/\b\w/g, (char) => char.toUpperCase());
}
function resolveAgentName(runtime, config) {
	return runtime?.character?.name?.trim() || config.ui?.assistant?.name?.trim() || "Eliza";
}
function resolveAdminEntityId(config, agentName) {
	const configured = config.agents?.defaults?.adminEntityId?.trim();
	if (configured) return configured;
	return stringToUuid(`${agentName}-admin-entity`);
}
function isSystemTask(task) {
	if (SYSTEM_TASK_NAMES.has(task.name)) return true;
	const tags = new Set(task.tags ?? []);
	return tags.has("queue") && tags.has("repeat");
}
function choosePreferredSystemTask(current, candidate) {
	const currentHasDescription = current.description.trim().length > 0;
	const candidateHasDescription = candidate.description.trim().length > 0;
	if (candidateHasDescription && !currentHasDescription) return candidate;
	if (currentHasDescription && !candidateHasDescription) return current;
	return (candidate.updatedAt ?? 0) > (current.updatedAt ?? 0) ? candidate : current;
}
function deduplicateSystemTasks(tasks) {
	const systemTasksByName = /* @__PURE__ */ new Map();
	const userTasks = [];
	for (const task of tasks) {
		if (!isSystemTask(task)) {
			userTasks.push(task);
			continue;
		}
		const existing = systemTasksByName.get(task.name);
		if (!existing) {
			systemTasksByName.set(task.name, task);
			continue;
		}
		systemTasksByName.set(task.name, choosePreferredSystemTask(existing, task));
	}
	return [...userTasks, ...systemTasksByName.values()];
}
function buildRoomBinding(room) {
	if (!room) return null;
	return {
		conversationId: room.conversationId,
		roomId: room.roomId,
		scope: room.metadata.scope ?? "general",
		...room.metadata.sourceConversationId ? { sourceConversationId: room.metadata.sourceConversationId } : {},
		...room.metadata.terminalBridgeConversationId ? { terminalBridgeConversationId: room.metadata.terminalBridgeConversationId } : {}
	};
}
function readAutomationRoomRecord(room) {
	const roomId = asString(room.id);
	if (!roomId) return null;
	const metadata = extractConversationMetadataFromRoom(room);
	if (!metadata || !isAutomationConversationMetadata(metadata)) return null;
	const webConversation = asRecord$2(asRecord$2(room.metadata)?.webConversation);
	return {
		title: asString(room.name) ?? "Automation",
		roomId,
		conversationId: asString(webConversation?.conversationId) ?? null,
		metadata,
		updatedAt: normalizeDateValue(room.updatedAt)
	};
}
async function listAutomationRooms(runtime, agentName) {
	const worldId = stringToUuid(`${agentName}-web-chat-world`);
	return (await runtime.getRooms(worldId)).map((room) => readAutomationRoomRecord(room)).filter((room) => room !== null);
}
async function invokeN8nCompatRoute(req, res, state, pathname) {
	let payload = null;
	let status = 200;
	await handleN8nRoutes({
		req,
		res,
		method: "GET",
		pathname,
		config: loadElizaConfig$2(),
		runtime: state.current,
		json: (_res, body, nextStatus = 200) => {
			payload = body;
			status = nextStatus;
		}
	});
	return {
		status,
		payload
	};
}
function extractErrorMessage(payload) {
	const record = asRecord$2(payload);
	const errorValue = record?.error ?? record?.message;
	return typeof errorValue === "string" && errorValue.trim().length > 0 ? errorValue : null;
}
function buildCoordinatorTaskItem(task, room) {
	const system = isSystemTask(task);
	return {
		id: `task:${task.id}`,
		type: "coordinator_text",
		source: "workbench_task",
		title: task.name,
		description: task.description,
		status: system ? "system" : task.isCompleted ? "completed" : "active",
		enabled: !task.isCompleted,
		system,
		isDraft: false,
		hasBackingWorkflow: false,
		updatedAt: room?.updatedAt ?? normalizeDateValue(task.updatedAt),
		taskId: task.id,
		task,
		schedules: [],
		room: buildRoomBinding(room)
	};
}
function buildCoordinatorTriggerItem(trigger, room) {
	return {
		id: `trigger:${trigger.id}`,
		type: "coordinator_text",
		source: "trigger",
		title: trigger.displayName,
		description: trigger.instructions,
		status: trigger.enabled ? "active" : "paused",
		enabled: trigger.enabled,
		system: false,
		isDraft: false,
		hasBackingWorkflow: false,
		updatedAt: room?.updatedAt ?? normalizeDateValue(trigger.updatedAt) ?? normalizeDateValue(trigger.lastRunAtIso),
		triggerId: trigger.id,
		trigger,
		schedules: [trigger],
		room: buildRoomBinding(room)
	};
}
function buildWorkflowDraftItem(room) {
	const metadata = room.metadata;
	const title = metadata.workflowName?.trim() || room.title.trim() || WORKFLOW_DRAFT_TITLE;
	return {
		id: `workflow-draft:${metadata.draftId}`,
		type: "n8n_workflow",
		source: "workflow_draft",
		title,
		description: "",
		status: "draft",
		enabled: true,
		system: false,
		isDraft: true,
		hasBackingWorkflow: false,
		updatedAt: room.updatedAt,
		draftId: room.metadata.draftId,
		schedules: [],
		room: buildRoomBinding(room)
	};
}
function buildAutomationDraftItem(room) {
	const metadata = room.metadata;
	const trimmedTitle = room.title.trim();
	const title = trimmedTitle && trimmedTitle.toLowerCase() !== "default" ? trimmedTitle : "New automation";
	return {
		id: `automation-draft:${metadata.draftId}`,
		type: "automation_draft",
		source: "automation_draft",
		title,
		description: "",
		status: "draft",
		enabled: true,
		system: false,
		isDraft: true,
		hasBackingWorkflow: false,
		updatedAt: room.updatedAt,
		draftId: metadata.draftId,
		schedules: [],
		room: buildRoomBinding(room)
	};
}
function buildWorkflowItem(workflow, room, fallback) {
	const missingBackingWorkflow = !workflow && !fallback.trigger;
	const title = workflow?.name?.trim() || room?.metadata.workflowName?.trim() || fallback.workflowName?.trim() || fallback.workflowId;
	const enabled = missingBackingWorkflow === true ? false : workflow?.active ?? fallback.trigger?.enabled ?? false;
	const description = workflow?.description?.trim() || (fallback.trigger ? `Scheduled workflow automation for ${title}.` : "");
	return {
		id: `workflow:${fallback.workflowId}`,
		type: "n8n_workflow",
		source: workflow ? "n8n_workflow" : "workflow_shadow",
		title,
		description,
		status: missingBackingWorkflow ? "draft" : enabled ? "active" : "paused",
		enabled,
		system: false,
		isDraft: missingBackingWorkflow,
		hasBackingWorkflow: Boolean(workflow),
		updatedAt: room?.updatedAt ?? normalizeDateValue(fallback.trigger?.updatedAt) ?? normalizeDateValue(fallback.trigger?.lastRunAtIso),
		workflowId: fallback.workflowId,
		workflow,
		schedules: fallback.trigger ? [fallback.trigger] : [],
		room: buildRoomBinding(room)
	};
}
function compareAutomationItems(left, right) {
	if (left.system !== right.system) return left.system ? 1 : -1;
	if (left.isDraft !== right.isDraft) return left.isDraft ? -1 : 1;
	const leftUpdated = left.updatedAt ? Date.parse(left.updatedAt) : 0;
	const rightUpdated = right.updatedAt ? Date.parse(right.updatedAt) : 0;
	if (rightUpdated !== leftUpdated) return rightUpdated - leftUpdated;
	return left.title.localeCompare(right.title);
}
async function buildAutomationListResponse(req, res, state) {
	const runtime = state.current;
	if (!runtime) throw new Error("Agent runtime is not available");
	const rooms = await listAutomationRooms(runtime, resolveAgentName(runtime, loadElizaConfig$2()));
	const taskRooms = new Map(rooms.filter((room) => room.metadata.taskId).map((room) => [room.metadata.taskId, room]));
	const triggerRooms = new Map(rooms.filter((room) => room.metadata.triggerId).map((room) => [room.metadata.triggerId, room]));
	const workflowRooms = new Map(rooms.filter((room) => room.metadata.workflowId).map((room) => [room.metadata.workflowId, room]));
	const workflowDraftItems = rooms.filter((room) => room.metadata.scope === "automation-workflow-draft").filter((room) => typeof room.metadata.draftId === "string").map((room) => buildWorkflowDraftItem(room));
	const automationDraftItems = rooms.filter((room) => room.metadata.scope === "automation-draft").filter((room) => typeof room.metadata.draftId === "string").map((room) => buildAutomationDraftItem(room));
	const tasks = deduplicateSystemTasks((await runtime.getTasks({})).map((task) => toWorkbenchTask(task)).filter((task) => task !== null));
	const triggerItems = (await listTriggerTasks(runtime)).map((task) => taskToTriggerSummary(task)).filter((trigger) => trigger !== null);
	const triggerTaskIds = new Set(triggerItems.map((trigger) => trigger.taskId));
	const taskItems = tasks.filter((task) => !triggerTaskIds.has(task.id)).map((task) => buildCoordinatorTaskItem(task, taskRooms.get(task.id)));
	const n8nStatusResult = await invokeN8nCompatRoute(req, res, state, "/api/n8n/status");
	const n8nStatus = n8nStatusResult.status === 200 ? n8nStatusResult.payload : null;
	const n8nWorkflowsResult = await invokeN8nCompatRoute(req, res, state, "/api/n8n/workflows");
	const workflowFetchError = n8nWorkflowsResult.status === 200 ? null : extractErrorMessage(n8nWorkflowsResult.payload) ?? "Unable to load workflows";
	const workflowList = n8nWorkflowsResult.status === 200 && Array.isArray(n8nWorkflowsResult.payload?.workflows) ? n8nWorkflowsResult.payload.workflows : [];
	const workflowItemsById = /* @__PURE__ */ new Map();
	for (const workflow of workflowList) workflowItemsById.set(workflow.id, buildWorkflowItem(workflow, workflowRooms.get(workflow.id), {
		workflowId: workflow.id,
		workflowName: workflow.name
	}));
	for (const trigger of triggerItems) if (trigger.kind === "workflow" && trigger.workflowId) {
		const existing = workflowItemsById.get(trigger.workflowId);
		if (existing) {
			existing.schedules = [...existing.schedules, trigger];
			existing.updatedAt = existing.updatedAt ?? normalizeDateValue(trigger.updatedAt) ?? normalizeDateValue(trigger.lastRunAtIso);
			continue;
		}
		workflowItemsById.set(trigger.workflowId, buildWorkflowItem(void 0, workflowRooms.get(trigger.workflowId), {
			workflowId: trigger.workflowId,
			workflowName: trigger.workflowName,
			trigger
		}));
	}
	if (workflowFetchError !== null) {
		for (const [workflowId, room] of workflowRooms.entries()) if (!workflowItemsById.has(workflowId)) workflowItemsById.set(workflowId, buildWorkflowItem(void 0, room, {
			workflowId,
			workflowName: room.metadata.workflowName
		}));
	}
	const coordinatorTriggerItems = triggerItems.filter((trigger) => trigger.kind !== "workflow").map((trigger) => buildCoordinatorTriggerItem(trigger, triggerRooms.get(trigger.id)));
	const automations = [
		...automationDraftItems,
		...workflowDraftItems,
		...taskItems,
		...coordinatorTriggerItems,
		...workflowItemsById.values()
	].sort(compareAutomationItems);
	return {
		automations,
		summary: {
			total: automations.length,
			coordinatorCount: automations.filter((automation) => automation.type === "coordinator_text").length,
			workflowCount: automations.filter((automation) => automation.type === "n8n_workflow").length,
			scheduledCount: automations.filter((automation) => automation.schedules.length > 0).length,
			draftCount: automations.filter((automation) => automation.isDraft).length
		},
		n8nStatus,
		workflowFetchError
	};
}
function normalizeCapabilityName(value) {
	return value.trim().toLowerCase();
}
function getRuntimeActionCapabilityNames(runtime) {
	const names = /* @__PURE__ */ new Set();
	for (const action of runtime.actions) {
		names.add(normalizeCapabilityName(action.name));
		for (const simile of action.similes ?? []) names.add(normalizeCapabilityName(simile));
	}
	return names;
}
function getRuntimePluginNames(runtime) {
	return new Set((runtime.plugins ?? []).map((plugin) => normalizeCapabilityName(plugin.name)).filter((name) => name.length > 0));
}
function hasMatchingRuntimeCapability(spec, actionNames, pluginNames) {
	if (spec.enabledWithoutRuntimeCapability) return true;
	return spec.actionNames.some((name) => actionNames.has(normalizeCapabilityName(name))) || spec.pluginNames.some((name) => pluginNames.has(normalizeCapabilityName(name)));
}
function buildStaticAutomationNode(spec, actionNames, pluginNames) {
	const enabled = hasMatchingRuntimeCapability(spec, actionNames, pluginNames);
	return {
		id: spec.id,
		label: spec.label,
		description: spec.description,
		class: spec.class,
		source: "static_catalog",
		backingCapability: spec.backingCapability,
		ownerScoped: spec.ownerScoped,
		requiresSetup: !enabled,
		availability: enabled ? "enabled" : "disabled",
		...enabled ? {} : { disabledReason: spec.disabledReason }
	};
}
async function buildAutomationNodeCatalog(state) {
	const runtime = state.current;
	if (!runtime) throw new Error("Agent runtime is not available");
	const config = loadElizaConfig$2();
	const agentName = resolveAgentName(runtime, config);
	const adminEntityId = resolveAdminEntityId(config, agentName);
	const runtimeActionNodes = runtime.actions.slice().sort((left, right) => left.name.localeCompare(right.name)).map((action) => ({
		id: `action:${action.name}`,
		label: humanizeCapabilityName(action.name),
		description: action.description || `${action.name} runtime action`,
		class: action.name === "CREATE_TASK" || action.name === "CODE_TASK" ? "agent" : "action",
		source: "runtime_action",
		backingCapability: action.name,
		ownerScoped: false,
		requiresSetup: false,
		availability: "enabled"
	}));
	const runtimeProviderNodes = runtime.providers.slice().filter((provider) => !BLOCKED_AUTOMATION_PROVIDER_NODES.has(provider.name)).sort((left, right) => left.name.localeCompare(right.name)).map((provider) => ({
		id: `provider:${provider.name}`,
		label: humanizeCapabilityName(provider.name),
		description: provider.description || `${provider.name} runtime provider`,
		class: "context",
		source: "runtime_provider",
		backingCapability: provider.name,
		ownerScoped: false,
		requiresSetup: false,
		availability: "enabled"
	}));
	const runtimeActionCapabilityNames = getRuntimeActionCapabilityNames(runtime);
	const runtimePluginNames = getRuntimePluginNames(runtime);
	const staticAutomationNodes = STATIC_AUTOMATION_NODE_SPECS.map((spec) => buildStaticAutomationNode(spec, runtimeActionCapabilityNames, runtimePluginNames));
	const contributorNodes = (await Promise.all(listAutomationNodeContributors().map((contributor) => contributor({
		runtime,
		config,
		agentName,
		adminEntityId
	})))).flat();
	const nodes = [
		...runtimeActionNodes,
		...runtimeProviderNodes,
		...staticAutomationNodes,
		...contributorNodes
	].sort((left, right) => {
		if (left.class !== right.class) return left.class.localeCompare(right.class);
		return left.label.localeCompare(right.label);
	});
	return {
		nodes,
		summary: {
			total: nodes.length,
			enabled: nodes.filter((node) => node.availability === "enabled").length,
			disabled: nodes.filter((node) => node.availability === "disabled").length
		}
	};
}
async function handleAutomationsCompatRoutes(req, res, state) {
	const method = (req.method ?? "GET").toUpperCase();
	const url = new URL(req.url ?? "/", "http://localhost");
	if (!url.pathname.startsWith("/api/automations")) return false;
	if (!await ensureRouteAuthorized(req, res, state)) return true;
	if (method === "GET" && url.pathname === "/api/automations") {
		if (!state.current) {
			sendJsonError(res, 503, "Agent runtime is not available");
			return true;
		}
		sendJson$2(res, 200, await buildAutomationListResponse(req, res, state));
		return true;
	}
	if (method === "GET" && url.pathname === "/api/automations/nodes") {
		if (!state.current) {
			sendJsonError(res, 503, "Agent runtime is not available");
			return true;
		}
		sendJson$2(res, 200, await buildAutomationNodeCatalog(state));
		return true;
	}
	return false;
}
var WORKFLOW_DRAFT_TITLE, SYSTEM_TASK_NAMES, BLOCKED_AUTOMATION_PROVIDER_NODES, STATIC_AUTOMATION_NODE_SPECS;
var init_automations_compat_routes = __esmMin((() => {
	init_auth$1();
	init_automation_node_contributors();
	init_n8n_routes();
	init_response();
	WORKFLOW_DRAFT_TITLE = "New Workflow Draft";
	SYSTEM_TASK_NAMES = new Set([
		"EMBEDDING_DRAIN",
		"PROACTIVE_AGENT",
		"LIFEOPS_SCHEDULER",
		"TRIGGER_DISPATCH",
		"heartbeat"
	]);
	BLOCKED_AUTOMATION_PROVIDER_NODES = new Set(["recent-conversations", "relevant-conversations"]);
	STATIC_AUTOMATION_NODE_SPECS = [
		{
			id: "crypto:evm.swap",
			label: "EVM swap",
			description: "EVM token swap automation backed by a loaded EVM runtime action.",
			class: "action",
			backingCapability: "SWAP",
			actionNames: [
				"SWAP",
				"SWAP_TOKENS",
				"SWAP_TOKEN"
			],
			pluginNames: [
				"evm",
				"wallet",
				"plugin-wallet",
				"@elizaos/plugin-wallet"
			],
			ownerScoped: true,
			enabledWithoutRuntimeCapability: false,
			disabledReason: "Load the EVM plugin with swap support."
		},
		{
			id: "crypto:evm.bridge",
			label: "EVM bridge",
			description: "EVM cross-chain bridge automation backed by a loaded EVM runtime action.",
			class: "action",
			backingCapability: "CROSS_CHAIN_TRANSFER",
			actionNames: [
				"CROSS_CHAIN_TRANSFER",
				"BRIDGE",
				"BRIDGE_TOKENS"
			],
			pluginNames: [
				"evm",
				"wallet",
				"plugin-wallet",
				"@elizaos/plugin-wallet"
			],
			ownerScoped: true,
			enabledWithoutRuntimeCapability: false,
			disabledReason: "Load the EVM plugin with bridge support."
		},
		{
			id: "crypto:solana.swap",
			label: "Solana swap",
			description: "Solana token swap automation backed by a loaded Solana runtime action.",
			class: "action",
			backingCapability: "SWAP_SOLANA",
			actionNames: [
				"SWAP_SOLANA",
				"SWAP_SOL",
				"SWAP_TOKENS_SOLANA",
				"TOKEN_SWAP_SOLANA",
				"TRADE_TOKENS_SOLANA",
				"EXCHANGE_TOKENS_SOLANA"
			],
			pluginNames: [
				"chain_solana",
				"solana",
				"wallet",
				"plugin-wallet",
				"@elizaos/plugin-wallet"
			],
			ownerScoped: true,
			enabledWithoutRuntimeCapability: false,
			disabledReason: "Load the Solana plugin with swap support."
		},
		{
			id: "crypto:hyperliquid.action",
			label: "Hyperliquid action",
			description: "Hyperliquid automation entry point backed by a loaded Hyperliquid runtime plugin.",
			class: "action",
			backingCapability: "HYPERLIQUID_ACTION",
			actionNames: [
				"HYPERLIQUID_ACTION",
				"HYPERLIQUID_ORDER",
				"HYPERLIQUID_TRADE"
			],
			pluginNames: [
				"hyperliquid",
				"plugin-hyperliquid",
				"@elizaos/plugin-hyperliquid"
			],
			ownerScoped: true,
			enabledWithoutRuntimeCapability: false,
			disabledReason: "Load the Hyperliquid runtime plugin."
		},
		{
			id: "crypto:polymarket.action",
			label: "Polymarket action",
			description: "Polymarket automation entry point backed by a loaded Polymarket runtime plugin.",
			class: "action",
			backingCapability: "POLYMARKET_ACTION",
			actionNames: [
				"POLYMARKET_ACTION",
				"POLYMARKET_ORDER",
				"POLYMARKET_TRADE"
			],
			pluginNames: [
				"polymarket",
				"plugin-polymarket",
				"@elizaos/plugin-polymarket"
			],
			ownerScoped: true,
			enabledWithoutRuntimeCapability: false,
			disabledReason: "Load the Polymarket runtime plugin."
		},
		{
			id: "trigger:order.schedule",
			label: "Order schedule",
			description: "Schedule order-intent workflows; venue execution still requires a loaded trading action.",
			class: "trigger",
			backingCapability: "ORDER_SCHEDULE",
			actionNames: [],
			pluginNames: [],
			ownerScoped: false,
			enabledWithoutRuntimeCapability: true,
			disabledReason: "Automation schedules are unavailable."
		},
		{
			id: "trigger:order.event",
			label: "Order event",
			description: "React to order lifecycle events emitted by a loaded trading venue plugin.",
			class: "trigger",
			backingCapability: "ORDER_EVENT",
			actionNames: [
				"ORDER_EVENT",
				"ORDER_FILLED",
				"ORDER_UPDATED",
				"HYPERLIQUID_ACTION",
				"POLYMARKET_ACTION"
			],
			pluginNames: [
				"hyperliquid",
				"plugin-hyperliquid",
				"@elizaos/plugin-hyperliquid",
				"polymarket",
				"plugin-polymarket",
				"@elizaos/plugin-polymarket"
			],
			ownerScoped: false,
			enabledWithoutRuntimeCapability: false,
			disabledReason: "Load an order-event-capable runtime plugin."
		}
	];
}));

//#endregion
//#region node_modules/.bun/@elizaos+app-core@2.0.0-alpha.537+72829346cb4c43b1/node_modules/@elizaos/app-core/packages/app-core/src/utils/tts-debug.js
/**
* TTS pipeline tracing (opt-in). Prefix: `[eliza][tts]`.
* Never pass secrets in `detail`. With debug on, `preview` fields may contain
* user-visible spoken text — disable in shared logs / production.
*
* Playback phases (browser console): `play:web-audio:start|end` (ElevenLabs /
* cloud MP3), `speakBrowser:enter`, `play:browser:web-speech:enqueued`,
* `play:browser:speechSynthesis:start|end|error`, `play:talkmode:dispatch|speak-failed`,
* `play:browser:no-synth`. Server logs: `server:cloud-tts:*` (includes optional
* `messageId`, `clipSegment`, `hearingFull` when the client sends
* `x-elizaos-tts-*` headers on `/api/tts/cloud`), ChatView: `chat:*`.
*
* Enable with:
* - **Node / API:** `ELIZA_TTS_DEBUG=1` (or `true`, `yes`, `on`) — logs appear in the API
*   terminal / `[api]` aggregator only for **server** routes (e.g. `server:cloud-tts:*`).
* - **Renderer (WebView / browser):** same env is mirrored via Vite `define` in
*   `apps/app/vite.config.ts` when you start dev with `ELIZA_TTS_DEBUG=1`. Those lines
*   go to the **renderer** JavaScript console (Electrobun: Web Inspector on the window),
*   not `LOG_LEVEL` on the API process alone.
*/
function ttsDebugEnabled() {
	const truthy = (raw) => {
		if (raw == null) return false;
		const v = String(raw).trim().toLowerCase();
		return v === "1" || v === "true" || v === "yes" || v === "on";
	};
	if (typeof process !== "undefined" && process.env) {
		if (truthy(process.env.ELIZA_TTS_DEBUG)) return true;
	}
	try {
		if (truthy(String(import.meta.env.ELIZA_TTS_DEBUG ?? ""))) return true;
		if (truthy(String(import.meta.env.VITE_ELIZA_TTS_DEBUG ?? ""))) return true;
	} catch {}
	return false;
}
/**
* Single-line preview of text for TTS debug logs (avoids huge console lines).
* Enable `ELIZA_TTS_DEBUG` only when you accept that spoken lines may appear in logs.
*/
function ttsDebugTextPreview(text, maxChars = DEFAULT_PREVIEW_MAX) {
	const singleLine = text.replace(/\r?\n/g, "↵ ").replace(/\s+/g, " ").trim();
	if (singleLine.length <= maxChars) return singleLine;
	return `${singleLine.slice(0, maxChars)}…`;
}
function ttsDebug(phase, detail) {
	if (!ttsDebugEnabled()) return;
	if (detail && Object.keys(detail).length > 0) console.info(`[eliza][tts] ${phase}`, detail);
	else console.info(`[eliza][tts] ${phase}`);
}
var DEFAULT_PREVIEW_MAX;
var init_tts_debug = __esmMin((() => {
	DEFAULT_PREVIEW_MAX = 160;
}));

//#endregion
//#region node_modules/.bun/@elizaos+app-core@2.0.0-alpha.537+72829346cb4c43b1/node_modules/@elizaos/app-core/packages/app-core/src/api/cloud-secrets.js
/**
* Read a cloud secret without exposing it in process.env.
* Falls back to process.env for backwards compatibility with code that
* sets the key before this module loads (e.g. docker entrypoints).
*/
function getCloudSecret(key) {
	return _cloudSecrets[key] ?? process.env[key];
}
/** Scrub cloud secrets from process.env and capture into the sealed store. */
function scrubCloudSecretsFromEnv() {
	for (const key of ["ELIZAOS_CLOUD_API_KEY", "ELIZAOS_CLOUD_ENABLED"]) if (process.env[key] !== void 0) {
		_cloudSecrets[key] = process.env[key];
		delete process.env[key];
	}
}
/** Clear any sealed cloud secrets after an explicit disconnect. */
function clearCloudSecrets() {
	for (const key of ["ELIZAOS_CLOUD_API_KEY", "ELIZAOS_CLOUD_ENABLED"]) delete _cloudSecrets[key];
}
var _cloudSecrets;
var init_cloud_secrets = __esmMin((() => {
	_cloudSecrets = Object.create(null);
	Object.defineProperty(_cloudSecrets, Symbol.toStringTag, {
		value: "CloudSecrets",
		enumerable: false
	});
}));

//#endregion
//#region node_modules/.bun/@elizaos+app-core@2.0.0-alpha.537+72829346cb4c43b1/node_modules/@elizaos/app-core/packages/app-core/src/api/server-cloud-tts.js
/** Browser → API correlation (never forwarded to Eliza Cloud). */
function readTtsDebugClientHeaders(req) {
	const pick = (name) => {
		const raw = req.headers[name];
		if (raw == null) return void 0;
		const v = Array.isArray(raw) ? raw[0] : raw;
		return typeof v === "string" && v.trim() ? v.trim() : void 0;
	};
	const decode = (enc) => {
		if (!enc) return void 0;
		try {
			return decodeURIComponent(enc);
		} catch {
			return enc;
		}
	};
	return {
		messageId: decode(pick("x-elizaos-tts-message-id")),
		clipSegment: decode(pick("x-elizaos-tts-clip-segment")),
		hearingFull: decode(pick("x-elizaos-tts-full-preview"))
	};
}
function ttsClientDbgFields(hdr) {
	const o = {};
	if (hdr.messageId) o.messageId = hdr.messageId;
	if (hdr.clipSegment) o.clipSegment = hdr.clipSegment;
	if (hdr.hearingFull) o.hearingFull = hdr.hearingFull;
	return o;
}
function normalizeSecretEnvValue(value) {
	const trimmed = value?.trim();
	if (!trimmed) return null;
	if (trimmed === "REDACTED" || trimmed === "[REDACTED]" || /^\*+$/.test(trimmed)) return null;
	return trimmed;
}
/** Edge / Azure neural ids (e.g. `en-US-AriaNeural`) are not ElevenLabs `voiceId`s. */
function isLikelyEdgeOrAzureNeuralVoiceId(raw) {
	const t = raw.trim();
	return /^[a-z]{2}-[A-Z]{2}-/i.test(t) && /Neural$/i.test(t);
}
function normalizeElizaCloudVoiceId(raw) {
	const trimmed = raw.trim();
	if (!trimmed) return DEFAULT_ELIZA_CLOUD_TTS_VOICE_ID;
	const lower = trimmed.toLowerCase();
	if (OPENAI_STYLE_VOICE_ALIASES.has(lower)) return DEFAULT_ELIZA_CLOUD_TTS_VOICE_ID;
	if (isLikelyEdgeOrAzureNeuralVoiceId(trimmed)) return DEFAULT_ELIZA_CLOUD_TTS_VOICE_ID;
	return trimmed;
}
/**
* Resolve `voiceId` for Eliza Cloud TTS (ElevenLabs ids). OpenAI-style names
* in the request are replaced with the default premade voice.
*/
function resolveElizaCloudTtsVoiceId(bodyVoiceId, env = process.env) {
	if (typeof bodyVoiceId === "string" && bodyVoiceId.trim()) return normalizeElizaCloudVoiceId(bodyVoiceId);
	const envVoice = env.ELIZAOS_CLOUD_TTS_VOICE?.trim() ?? "";
	if (envVoice) return normalizeElizaCloudVoiceId(envVoice);
	return DEFAULT_ELIZA_CLOUD_TTS_VOICE_ID;
}
function resolveCloudApiKey$1(env = process.env) {
	const envKey = normalizeSecretEnvValue(env.ELIZAOS_CLOUD_API_KEY);
	if (envKey) return envKey;
	try {
		const config = loadElizaConfig();
		const configKey = normalizeSecretEnvValue(typeof config.cloud?.apiKey === "string" ? config.cloud.apiKey : void 0);
		if (configKey) return configKey;
	} catch {}
	const sealedKey = normalizeSecretEnvValue(getCloudSecret("ELIZAOS_CLOUD_API_KEY"));
	if (sealedKey) return sealedKey;
	return null;
}
function __resetCloudBaseUrlCache() {
	cachedCloudBaseUrlFromConfig = void 0;
	hasResolvedCloudBaseUrlFromConfig = false;
}
function resolveCloudBaseUrlFromConfig() {
	if (hasResolvedCloudBaseUrlFromConfig) return cachedCloudBaseUrlFromConfig ?? null;
	try {
		const config = loadElizaConfig();
		const raw = typeof config.cloud?.baseUrl === "string" ? config.cloud.baseUrl.trim() : "";
		cachedCloudBaseUrlFromConfig = raw.length > 0 ? raw : null;
		hasResolvedCloudBaseUrlFromConfig = true;
		return cachedCloudBaseUrlFromConfig;
	} catch {
		cachedCloudBaseUrlFromConfig = null;
		hasResolvedCloudBaseUrlFromConfig = true;
		return null;
	}
}
function pickBodyString(body, camel, snake) {
	const a = body[camel];
	if (typeof a === "string" && a.trim()) return a;
	const b = body[snake];
	if (typeof b === "string" && b.trim()) return b;
}
async function readRawRequestBody(req) {
	const chunks = [];
	for await (const chunk of req) chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
	return Buffer.concat(chunks);
}
function sendJsonResponse(res, status, body) {
	if (res.headersSent) return;
	res.statusCode = status;
	res.setHeader("content-type", "application/json; charset=utf-8");
	res.end(JSON.stringify(body));
}
function sendJsonErrorResponse(res, status, message) {
	sendJsonResponse(res, status, { error: message });
}
/**
* After a non-OK upstream response, only try the next URL for likely-transient /
* wrong-route issues. Avoid retrying 401/402/429 etc. so we do not double-charge TTS.
*/
function shouldRetryCloudTtsUpstream(status) {
	return status === 404 || status === 502 || status === 503;
}
function forwardCloudTtsUpstreamError(res, status, bodyText) {
	if (res.headersSent) return;
	const trimmed = bodyText.trim();
	if (trimmed.startsWith("{") && trimmed.endsWith("}") || trimmed.startsWith("[") && trimmed.endsWith("]")) try {
		sendJsonResponse(res, status, JSON.parse(trimmed));
		return;
	} catch {}
	res.statusCode = status;
	res.setHeader("content-type", "application/json; charset=utf-8");
	res.end(JSON.stringify({ error: trimmed || "Eliza Cloud TTS request failed" }));
}
/**
* Coerce stored/configured values to an ElevenLabs model id Eliza Cloud accepts.
* Maps OpenAI TTS ids and common copy-paste mistakes; passes through real `eleven_*` ids.
*/
function normalizeElizaCloudTtsModelId(raw) {
	const trimmed = raw.trim();
	if (!trimmed) return DEFAULT_ELIZA_CLOUD_TTS_MODEL_ID;
	const lower = trimmed.toLowerCase();
	if (OPENAI_STYLE_VOICE_ALIASES.has(lower)) return DEFAULT_ELIZA_CLOUD_TTS_MODEL_ID;
	if (/^gpt-/i.test(trimmed)) return DEFAULT_ELIZA_CLOUD_TTS_MODEL_ID;
	if (/^tts-1/i.test(trimmed)) return DEFAULT_ELIZA_CLOUD_TTS_MODEL_ID;
	if (/mini-tts/i.test(trimmed)) return DEFAULT_ELIZA_CLOUD_TTS_MODEL_ID;
	return trimmed;
}
/** Eliza Cloud TTS `modelId` (ElevenLabs), from body or env or default. */
function resolveCloudProxyTtsModel(bodyModel, env = process.env) {
	const envModel = env.ELIZAOS_CLOUD_TTS_MODEL?.trim() ?? "";
	const chosen = (typeof bodyModel === "string" && bodyModel.trim() ? bodyModel.trim() : "") || envModel;
	if (!chosen) return DEFAULT_ELIZA_CLOUD_TTS_MODEL_ID;
	return normalizeElizaCloudTtsModelId(chosen);
}
function resolveElevenLabsApiKeyForCloudMode(env = process.env) {
	const directKey = normalizeSecretEnvValue(env.ELEVENLABS_API_KEY);
	if (directKey) return directKey;
	let configWantsCloudTts = false;
	try {
		configWantsCloudTts = isElizaCloudServiceSelectedInConfig(loadElizaConfig(), "tts");
	} catch {
		configWantsCloudTts = false;
	}
	if (!(env.ELIZAOS_CLOUD_USE_TTS === "true" || env.ELIZAOS_CLOUD_USE_TTS === void 0 && configWantsCloudTts)) return null;
	if (env.ELIZA_CLOUD_TTS_DISABLED === "true") return null;
	return resolveCloudApiKey$1(env);
}
function ensureCloudTtsApiKeyAlias(env = process.env) {
	if (normalizeSecretEnvValue(env.ELEVENLABS_API_KEY)) return false;
	const cloudBackedKey = resolveElevenLabsApiKeyForCloudMode(env);
	if (!cloudBackedKey) return false;
	env.ELEVENLABS_API_KEY = cloudBackedKey;
	return true;
}
function resolveCloudTtsBaseUrl(env = process.env) {
	const fromEnv = env.ELIZAOS_CLOUD_BASE_URL?.trim() ?? "";
	const fromConfig = fromEnv.length > 0 ? null : resolveCloudBaseUrlFromConfig();
	const configured = fromEnv.length > 0 ? fromEnv : fromConfig?.trim() ?? "";
	const fallback = "https://www.elizacloud.ai/api/v1";
	const base = configured.length > 0 ? configured : fallback;
	try {
		const parsed = new URL(base);
		let path = parsed.pathname.replace(/\/+$/, "");
		if (!path || path === "/") path = "/api/v1";
		parsed.pathname = path;
		return parsed.toString().replace(/\/$/, "");
	} catch {
		return fallback;
	}
}
function resolveCloudTtsCandidateUrls(env = process.env) {
	const base = resolveCloudTtsBaseUrl(env).replace(/\/+$/, "");
	const candidates = /* @__PURE__ */ new Set();
	const addEndpointsForApiV1Base = (baseUrl) => {
		const trimmed = baseUrl.replace(/\/+$/, "");
		candidates.add(`${trimmed}/voice/tts`);
		try {
			const u = new URL(trimmed);
			if (u.pathname.replace(/\/+$/, "").endsWith("/api/v1")) candidates.add(`${u.origin}/api/elevenlabs/tts`);
		} catch {}
	};
	addEndpointsForApiV1Base(base);
	try {
		const parsed = new URL(base);
		if (parsed.hostname.startsWith("www.")) {
			parsed.hostname = parsed.hostname.slice(4);
			addEndpointsForApiV1Base(parsed.toString().replace(/\/$/, ""));
		} else {
			parsed.hostname = `www.${parsed.hostname}`;
			addEndpointsForApiV1Base(parsed.toString().replace(/\/$/, ""));
		}
	} catch {}
	return [...candidates];
}
async function handleCloudTtsPreviewRoute(req, res) {
	const dbgExtra = ttsClientDbgFields(readTtsDebugClientHeaders(req));
	const cloudApiKey = resolveCloudApiKey$1();
	if (!cloudApiKey) {
		ttsDebug("server:cloud-tts:reject", {
			reason: "no_api_key",
			...dbgExtra
		});
		sendJsonErrorResponse(res, 401, "Eliza Cloud is not connected. Connect your Eliza Cloud account first.");
		return true;
	}
	const rawBody = await readRawRequestBody(req);
	let body;
	try {
		body = JSON.parse(rawBody.toString("utf8"));
	} catch {
		sendJsonErrorResponse(res, 400, "Invalid JSON request body");
		return true;
	}
	const text = sanitizeSpeechText(typeof body.text === "string" ? body.text : "");
	if (!text) {
		sendJsonErrorResponse(res, 400, "Missing text");
		return true;
	}
	if (text.length > ELIZA_CLOUD_TTS_MAX_TEXT_CHARS) {
		sendJsonErrorResponse(res, 400, `Text too long. Maximum length is ${ELIZA_CLOUD_TTS_MAX_TEXT_CHARS} characters`);
		return true;
	}
	const cloudModel = resolveCloudProxyTtsModel(pickBodyString(body, "modelId", "model_id"));
	const cloudVoice = resolveElizaCloudTtsVoiceId(pickBodyString(body, "voiceId", "voice_id"));
	const cloudUrls = resolveCloudTtsCandidateUrls();
	const ttsPreview = ttsDebugTextPreview(text);
	ttsDebug("server:cloud-tts:proxy", {
		textChars: text.length,
		preview: ttsPreview,
		modelId: cloudModel,
		voiceId: cloudVoice,
		urlCandidates: cloudUrls.length,
		...dbgExtra
	});
	try {
		let lastStatus = 0;
		let lastDetails = "unknown error";
		let cloudResponse = null;
		for (let i = 0; i < cloudUrls.length; i++) {
			const cloudUrl = cloudUrls[i];
			if (cloudUrl === void 0) continue;
			const attempt = await fetch(cloudUrl, {
				method: "POST",
				headers: {
					Authorization: `Bearer ${cloudApiKey}`,
					"x-api-key": cloudApiKey,
					"Content-Type": "application/json",
					Accept: "audio/mpeg"
				},
				body: JSON.stringify({
					text,
					voiceId: cloudVoice,
					modelId: cloudModel
				})
			});
			if (attempt.ok) {
				cloudResponse = attempt;
				ttsDebug("server:cloud-tts:upstream-ok", {
					urlIndex: i,
					status: attempt.status,
					preview: ttsPreview,
					...dbgExtra
				});
				break;
			}
			lastStatus = attempt.status;
			lastDetails = await attempt.text().catch(() => "unknown error");
			ttsDebug("server:cloud-tts:upstream-retry", {
				urlIndex: i,
				status: attempt.status,
				preview: ttsPreview,
				...dbgExtra
			});
			if (!(i < cloudUrls.length - 1) || !shouldRetryCloudTtsUpstream(attempt.status)) break;
		}
		if (!cloudResponse) {
			ttsDebug("server:cloud-tts:reject", {
				reason: "upstream_failed",
				lastStatus,
				preview: ttsPreview,
				...dbgExtra
			});
			if (lastStatus === 400 || lastStatus === 401 || lastStatus === 402 || lastStatus === 403 || lastStatus === 429) {
				forwardCloudTtsUpstreamError(res, lastStatus, lastDetails);
				return true;
			}
			sendJsonErrorResponse(res, 502, `Eliza Cloud TTS failed (${lastStatus || 502}): ${lastDetails}`);
			return true;
		}
		const audioBuffer = Buffer.from(await cloudResponse.arrayBuffer());
		ttsDebug("server:cloud-tts:success", {
			bytes: audioBuffer.length,
			preview: ttsPreview,
			...dbgExtra
		});
		res.statusCode = 200;
		res.setHeader("Content-Type", "audio/mpeg");
		res.setHeader("Cache-Control", "no-store");
		res.end(audioBuffer);
		return true;
	} catch (err) {
		sendJsonErrorResponse(res, 502, `Eliza Cloud TTS request failed: ${err instanceof Error ? err.message : String(err)}`);
		return true;
	}
}
function mirrorCompatHeaders(req) {
	for (const [appHeader, elizaHeader] of [
		["x-elizaos-token", "x-eliza-token"],
		["x-elizaos-export-token", "x-eliza-export-token"],
		["x-elizaos-client-id", "x-eliza-client-id"],
		["x-elizaos-terminal-token", "x-eliza-terminal-token"],
		["x-elizaos-ui-language", "x-eliza-ui-language"],
		["x-elizaos-agent-action", "x-eliza-agent-action"]
	]) {
		const appValue = req.headers[appHeader];
		const elizaValue = req.headers[elizaHeader];
		if (appValue != null && elizaValue == null) req.headers[elizaHeader] = appValue;
		if (elizaValue != null && appValue == null) req.headers[appHeader] = elizaValue;
	}
}
var OPENAI_STYLE_VOICE_ALIASES, DEFAULT_ELIZA_CLOUD_TTS_VOICE_ID, DEFAULT_ELIZA_CLOUD_TTS_MODEL_ID, ELIZA_CLOUD_TTS_MAX_TEXT_CHARS, cachedCloudBaseUrlFromConfig, hasResolvedCloudBaseUrlFromConfig;
var init_server_cloud_tts = __esmMin((() => {
	init_tts_debug();
	init_cloud_secrets();
	OPENAI_STYLE_VOICE_ALIASES = new Set([
		"alloy",
		"ash",
		"ballad",
		"coral",
		"echo",
		"nova",
		"sage",
		"shimmer",
		"verse"
	]);
	DEFAULT_ELIZA_CLOUD_TTS_VOICE_ID = "EXAVITQu4vr4xnSDxMaL";
	DEFAULT_ELIZA_CLOUD_TTS_MODEL_ID = "eleven_flash_v2_5";
	ELIZA_CLOUD_TTS_MAX_TEXT_CHARS = 5e3;
	;
	hasResolvedCloudBaseUrlFromConfig = false;
}));

//#endregion
//#region node_modules/.bun/@elizaos+app-core@2.0.0-alpha.537+72829346cb4c43b1/node_modules/@elizaos/app-core/packages/app-core/src/api/server-config-filter.js
/**
* Strip sensitive env vars from a config object before it is sent in a GET
* /api/config response. Returns a shallow-cloned config with a filtered env
* block — the original object is never mutated.
*/
function filterConfigEnvForResponse(config) {
	const env = config.env;
	if (!env || typeof env !== "object" || Array.isArray(env)) return config;
	const filteredEnv = {};
	for (const [key, value] of Object.entries(env)) {
		if (SENSITIVE_ENV_RESPONSE_KEYS.has(key.toUpperCase())) continue;
		filteredEnv[key] = value;
	}
	return {
		...config,
		env: filteredEnv
	};
}
var SENSITIVE_ENV_RESPONSE_KEYS;
var init_server_config_filter = __esmMin((() => {
	SENSITIVE_ENV_RESPONSE_KEYS = new Set([
		"EVM_PRIVATE_KEY",
		"SOLANA_PRIVATE_KEY",
		"ELIZA_CLOUD_CLIENT_ADDRESS_KEY",
		"ELIZA_API_TOKEN",
		"ELIZA_WALLET_EXPORT_TOKEN",
		"ELIZA_TERMINAL_RUN_TOKEN",
		"HYPERSCAPE_AUTH_TOKEN",
		"ELIZAOS_CLOUD_API_KEY",
		"GITHUB_TOKEN",
		"DATABASE_URL",
		"POSTGRES_URL"
	]);
}));

//#endregion
//#region node_modules/.bun/@elizaos+app-core@2.0.0-alpha.537+72829346cb4c43b1/node_modules/@elizaos/app-core/packages/app-core/src/api/server-cors.js
var server_cors_exports = /* @__PURE__ */ __exportAll({
	buildCorsAllowedPorts: () => buildCorsAllowedPorts,
	getAllowedRemoteOrigins: () => getAllowedRemoteOrigins,
	getCachedRemoteOrigins: () => getCachedRemoteOrigins,
	getCorsAllowedPorts: () => getCorsAllowedPorts,
	invalidateCorsAllowedPorts: () => invalidateCorsAllowedPorts,
	isAllowedLocalOrigin: () => isAllowedLocalOrigin,
	isAllowedOrigin: () => isAllowedOrigin
});
/**
* Pure CORS allowlist helpers shared by the server and focused tests.
*
* Kept separate from server.ts so helper-only tests do not need to load the
* full API runtime dependency graph.
*/
/**
* Build the set of localhost ports allowed for CORS.
* Reads from env vars at call time so tests can override.
*/
function buildCorsAllowedPorts() {
	const ports = new Set([
		String(process.env.ELIZA_API_PORT ?? process.env.ELIZA_PORT ?? "31337"),
		String(process.env.ELIZA_PORT ?? "2138"),
		String(process.env.ELIZA_GATEWAY_PORT ?? "18789"),
		String(process.env.ELIZA_HOME_PORT ?? "2142")
	]);
	for (let p = 5174; p <= 5200; p++) ports.add(String(p));
	return ports;
}
/**
* Comma-separated explicit origins allowed by the operator (e.g. a
* remote dashboard host like https://bot.example.com). Localhost gets
* a built-in pass via {@link isAllowedLocalOrigin}; this is the only
* way to allow non-loopback hosts.
*/
function getAllowedRemoteOrigins() {
	const raw = process.env.ELIZA_ALLOWED_ORIGINS ?? "";
	return new Set(raw.split(",").map((s) => s.trim()).filter(Boolean).map((origin) => {
		try {
			return originString(new URL(origin));
		} catch {
			return origin;
		}
	}));
}
function getCorsAllowedPorts() {
	if (!cachedCorsAllowedPorts) cachedCorsAllowedPorts = buildCorsAllowedPorts();
	return cachedCorsAllowedPorts;
}
function getCachedRemoteOrigins() {
	if (!cachedRemoteOrigins) cachedRemoteOrigins = getAllowedRemoteOrigins();
	return cachedRemoteOrigins;
}
/** Invalidate the cached CORS port set so it is recomputed on next request. */
function invalidateCorsAllowedPorts() {
	cachedCorsAllowedPorts = void 0;
	cachedRemoteOrigins = void 0;
}
/**
* URL.origin returns the literal string "null" for non-special schemes
* (capacitor:, ionic:), so we compare protocol+host instead.
*/
function originString(u) {
	return `${u.protocol}//${u.host}`;
}
/**
* Check whether a URL string is an allowed origin for CORS:
*   - a configured local API port,
*   - a Capacitor / Ionic WebView origin (mobile app builds),
*   - or an explicit operator-allowed remote origin.
*/
function isAllowedOrigin(urlStr, allowedPorts, allowedRemoteOrigins) {
	const ports = allowedPorts ?? getCorsAllowedPorts();
	const remoteOrigins = allowedRemoteOrigins ?? getCachedRemoteOrigins();
	try {
		const u = new URL(urlStr);
		const origin = originString(u);
		if (CAPACITOR_WEBVIEW_ORIGINS.has(origin)) return true;
		if (u.protocol !== "http:" && u.protocol !== "https:") return false;
		if (remoteOrigins.has(origin)) return true;
		const h = u.hostname.toLowerCase();
		const isLocal = h === "localhost" || h === "127.0.0.1" || h === "[::1]" || h === "::1";
		const port = u.port || (u.protocol === "https:" ? "443" : "80");
		return isLocal && ports.has(port);
	} catch {
		return false;
	}
}
var cachedCorsAllowedPorts, cachedRemoteOrigins, CAPACITOR_WEBVIEW_ORIGINS, isAllowedLocalOrigin;
var init_server_cors = __esmMin((() => {
	;
	;
	CAPACITOR_WEBVIEW_ORIGINS = new Set([
		"capacitor://localhost",
		"ionic://localhost",
		"https://localhost"
	]);
	isAllowedLocalOrigin = isAllowedOrigin;
}));

//#endregion
//#region node_modules/.bun/@elizaos+app-core@2.0.0-alpha.537+72829346cb4c43b1/node_modules/@elizaos/app-core/packages/app-core/src/api/server-html.js
/** HTML injection — inject API base URL into served HTML pages. */
function injectApiBaseIntoHtml$1(...args) {
	return injectApiBaseIntoHtml(...args);
}
var init_server_html = __esmMin((() => {}));

//#endregion
//#region node_modules/.bun/@elizaos+app-core@2.0.0-alpha.537+72829346cb4c43b1/node_modules/@elizaos/app-core/packages/app-core/src/api/wallet-export-guard.js
/**
* Hardened wallet private key export guard.
*
* Wraps the upstream resolveWalletExportRejection with:
*   1. Per-IP rate limiting (1 successful export per 10 minutes)
*   2. Audit logging with IP, User-Agent, and timestamp
*   3. Forced confirmation delay (10s countdown)
*
* The upstream function validates the export token. This module adds
* defence-in-depth so a compromised session cannot instantly extract
* keys without leaving an audit trail and hitting rate limits.
*/
/**
* Get client IP from the socket directly. X-Forwarded-For is not trusted
* because this is a local server — trusting XFF would let attackers spoof
* IPs to bypass rate limits and nonce IP binding.
*/
function getClientIp(req) {
	return req.socket?.remoteAddress ?? null;
}
function getUserAgent(req) {
	return req.headers["user-agent"] ?? "unknown";
}
function recordAudit(entry) {
	auditLog.push(entry);
	if (auditLog.length > MAX_AUDIT_ENTRIES) auditLog.shift();
	const logLine = `[wallet-export-audit] ${entry.outcome} ip=${entry.ip} ua="${entry.userAgent}"${entry.reason ? ` reason="${entry.reason}"` : ""}`;
	console.warn(logLine);
}
function issueExportNonce(ip) {
	const now = Date.now();
	for (const [key, value] of pendingExportNonces) if (now - value.issuedAt > NONCE_TTL_MS) pendingExportNonces.delete(key);
	let countForIp = 0;
	for (const entry of pendingExportNonces.values()) if (entry.ip === ip) countForIp++;
	if (countForIp >= MAX_PENDING_NONCES_PER_IP) return null;
	const nonce = `wxn_${crypto.randomBytes(16).toString("hex")}`;
	pendingExportNonces.set(nonce, {
		issuedAt: Date.now(),
		ip
	});
	return nonce;
}
function validateExportNonce(nonce, ip) {
	const entry = pendingExportNonces.get(nonce);
	if (!entry) return {
		valid: false,
		reason: "Invalid or expired export nonce."
	};
	if (entry.ip !== ip) return {
		valid: false,
		reason: "Export nonce was issued to a different client."
	};
	const elapsed = Date.now() - entry.issuedAt;
	if (elapsed < EXPORT_DELAY_MS) return {
		valid: false,
		reason: `Export confirmation delay not met. Wait ${Math.ceil((EXPORT_DELAY_MS - elapsed) / 1e3)} more seconds.`
	};
	pendingExportNonces.delete(nonce);
	return { valid: true };
}
/**
* Create a hardened wallet export rejection function that wraps the upstream
* token validation with rate limiting, audit logging, and a forced delay.
*
* Two-phase export flow:
*   1. POST /api/wallet/export  { confirm: true, exportToken: "...", requestNonce: true }
*      → 403 with { nonce, delaySeconds } — client must wait
*   2. POST /api/wallet/export  { confirm: true, exportToken: "...", exportNonce: "wxn_..." }
*      → 200 with keys (if delay elapsed and rate limit not hit)
*/
function createHardenedExportGuard(upstream) {
	return (req, body) => {
		const ip = getClientIp(req);
		const ua = getUserAgent(req);
		if (!ip) {
			recordAudit({
				timestamp: (/* @__PURE__ */ new Date()).toISOString(),
				ip: "unknown",
				userAgent: ua,
				outcome: "rejected",
				reason: "No client IP available on socket"
			});
			return {
				status: 400,
				reason: "Unable to determine client IP; request rejected."
			};
		}
		const upstreamRejection = upstream(req, body);
		if (upstreamRejection) {
			recordAudit({
				timestamp: (/* @__PURE__ */ new Date()).toISOString(),
				ip,
				userAgent: ua,
				outcome: "rejected",
				reason: upstreamRejection.reason
			});
			return upstreamRejection;
		}
		if (body.requestNonce) {
			const nonce = issueExportNonce(ip);
			if (!nonce) {
				recordAudit({
					timestamp: (/* @__PURE__ */ new Date()).toISOString(),
					ip,
					userAgent: ua,
					outcome: "rejected",
					reason: "Too many pending nonces for this IP"
				});
				return {
					status: 429,
					reason: `Too many pending export requests. Complete or wait for existing nonces to expire.`
				};
			}
			recordAudit({
				timestamp: (/* @__PURE__ */ new Date()).toISOString(),
				ip,
				userAgent: ua,
				outcome: "rejected",
				reason: "Nonce issued, waiting for confirmation delay"
			});
			return {
				status: 403,
				reason: JSON.stringify({
					countdown: true,
					nonce,
					delaySeconds: EXPORT_DELAY_MS / 1e3,
					message: `Export nonce issued. Wait ${EXPORT_DELAY_MS / 1e3} seconds, then re-submit with exportNonce: "${nonce}".`
				})
			};
		}
		if (!body.exportNonce) {
			recordAudit({
				timestamp: (/* @__PURE__ */ new Date()).toISOString(),
				ip,
				userAgent: ua,
				outcome: "rejected",
				reason: "Missing export nonce"
			});
			return {
				status: 403,
				reason: "Export requires a confirmation delay. First send { \"confirm\": true, \"exportToken\": \"...\", \"requestNonce\": true } to start the countdown."
			};
		}
		const nonceResult = validateExportNonce(body.exportNonce, ip);
		if (!nonceResult.valid) {
			recordAudit({
				timestamp: (/* @__PURE__ */ new Date()).toISOString(),
				ip,
				userAgent: ua,
				outcome: "rejected",
				reason: nonceResult.reason
			});
			return {
				status: 403,
				reason: nonceResult.reason
			};
		}
		const rateLimitEntry = rateLimitMap.get(ip);
		if (rateLimitEntry) {
			const elapsed = Date.now() - rateLimitEntry.lastExportAt;
			if (elapsed < RATE_LIMIT_WINDOW_MS) {
				const retryAfter = Math.ceil((RATE_LIMIT_WINDOW_MS - elapsed) / 1e3);
				recordAudit({
					timestamp: (/* @__PURE__ */ new Date()).toISOString(),
					ip,
					userAgent: ua,
					outcome: "rate-limited",
					reason: `Rate limited, retry after ${retryAfter}s`
				});
				return {
					status: 429,
					reason: `Rate limit exceeded. One export per ${RATE_LIMIT_WINDOW_MS / 6e4} minutes. Retry after ${retryAfter} seconds.`
				};
			}
		}
		rateLimitMap.set(ip, { lastExportAt: Date.now() });
		recordAudit({
			timestamp: (/* @__PURE__ */ new Date()).toISOString(),
			ip,
			userAgent: ua,
			outcome: "allowed"
		});
		return null;
	};
}
var RATE_LIMIT_WINDOW_MS, RATE_LIMIT_SWEEP_INTERVAL_MS, rateLimitMap, sweepTimer$2, auditLog, MAX_AUDIT_ENTRIES, EXPORT_DELAY_MS, MAX_PENDING_NONCES_PER_IP, pendingExportNonces, NONCE_TTL_MS;
var init_wallet_export_guard = __esmMin((() => {
	RATE_LIMIT_WINDOW_MS = 600 * 1e3;
	RATE_LIMIT_SWEEP_INTERVAL_MS = 900 * 1e3;
	rateLimitMap = /* @__PURE__ */ new Map();
	sweepTimer$2 = setInterval(() => {
		const now = Date.now();
		for (const [key, entry] of rateLimitMap) if (now - entry.lastExportAt > RATE_LIMIT_WINDOW_MS * 2) rateLimitMap.delete(key);
	}, RATE_LIMIT_SWEEP_INTERVAL_MS);
	if (typeof sweepTimer$2 === "object" && "unref" in sweepTimer$2) sweepTimer$2.unref();
	auditLog = [];
	MAX_AUDIT_ENTRIES = 100;
	EXPORT_DELAY_MS = 1e4;
	MAX_PENDING_NONCES_PER_IP = 3;
	pendingExportNonces = /* @__PURE__ */ new Map();
	NONCE_TTL_MS = 300 * 1e3;
}));

//#endregion
//#region node_modules/.bun/@elizaos+app-core@2.0.0-alpha.537+72829346cb4c43b1/node_modules/@elizaos/app-core/packages/app-core/src/api/server-wallet-trade.js
function normalizeCompatReason(reason) {
	return reason;
}
function normalizeCompatRejection(rejection) {
	if (!rejection) return rejection;
	return {
		...rejection,
		reason: normalizeCompatReason(rejection.reason)
	};
}
function runWithCompatAuthContext(req, operation) {
	syncElizaEnvAliases();
	syncAppEnvToEliza();
	mirrorCompatHeaders(req);
	try {
		return operation();
	} finally {
		syncAppEnvToEliza();
		syncElizaEnvAliases();
	}
}
function resolveCompatWalletExportRejection(...args) {
	const [req] = args;
	return runWithCompatAuthContext(req, () => normalizeCompatRejection(resolveWalletExportRejection(...args)));
}
/**
* Hardened wallet export rejection function.
*
* Wraps the upstream token validation with per-IP rate limiting (1 per 10 min),
* audit logging (IP + UA), and a 10s confirmation delay via single-use nonces.
*/
function resolveWalletExportRejection$1(...args) {
	const [req] = args;
	return runWithCompatAuthContext(req, () => normalizeCompatRejection(hardenedGuard(...args)));
}
var hardenedGuard;
var init_server_wallet_trade = __esmMin((() => {
	init_env();
	init_server_cloud_tts();
	init_wallet_export_guard();
	hardenedGuard = createHardenedExportGuard(resolveCompatWalletExportRejection);
}));

//#endregion
//#region node_modules/.bun/@elizaos+app-core@2.0.0-alpha.537+72829346cb4c43b1/node_modules/@elizaos/app-core/packages/app-core/src/api/server-security.js
/**
* Security / auth helpers — WebSocket upgrade rejection, terminal run
* rejection, MCP terminal authorization, and API token binding.
*/
function resolveMcpTerminalAuthorizationRejection$1(...args) {
	const [req] = args;
	return runWithCompatAuthContext(req, () => normalizeCompatRejection(resolveMcpTerminalAuthorizationRejection(...args)));
}
function resolveTerminalRunRejection$1(...args) {
	const [req] = args;
	return runWithCompatAuthContext(req, () => normalizeCompatRejection(resolveTerminalRunRejection(...args)));
}
function resolveWebSocketUpgradeRejection$1(...args) {
	const [req] = args;
	return runWithCompatAuthContext(req, () => resolveWebSocketUpgradeRejection(...args));
}
function resolveTerminalRunClientId$1(...args) {
	const [req] = args;
	return runWithCompatAuthContext(req, () => resolveTerminalRunClientId(...args));
}
function ensureApiTokenForBindHost$1(...args) {
	syncAppEnvToEliza();
	const result = ensureApiTokenForBindHost(...args);
	syncElizaEnvAliases();
	return result;
}
var init_server_security = __esmMin((() => {
	init_env();
	init_server_wallet_trade();
}));

//#endregion
//#region node_modules/.bun/@elizaos+app-core@2.0.0-alpha.537+72829346cb4c43b1/node_modules/@elizaos/app-core/packages/app-core/src/api/server-startup.js
/**
* Server startup helpers — safe state dir check, package root resolution,
* and CORS origin resolution.
*/
function isSafeResetStateDir$1(...args) {
	if (isSafeResetStateDir(...args)) return true;
	const [resolvedState, homeDir] = args;
	const normalizedState = path.resolve(resolvedState);
	const normalizedHome = path.resolve(homeDir);
	if (normalizedState === path.parse(normalizedState).root || normalizedState === normalizedHome) return false;
	const relativeToHome = path.relative(normalizedHome, normalizedState);
	if (!(relativeToHome.length > 0 && !relativeToHome.startsWith("..") && !path.isAbsolute(relativeToHome))) return false;
	return normalizedState.split(path.sep).some((segment) => {
		const lower = segment.trim().toLowerCase();
		if (lower === ".eliza") return true;
		for (const name of PACKAGE_ROOT_NAMES) if (lower === `.${name}`) return true;
		return false;
	});
}
function findOwnPackageRoot(startDir) {
	let dir = startDir;
	for (let i = 0; i < 10; i += 1) {
		const packageJsonPath = path.join(dir, "package.json");
		if (fs.existsSync(packageJsonPath)) try {
			const pkg = JSON.parse(fs.readFileSync(packageJsonPath, "utf8"));
			const packageName = typeof pkg.name === "string" ? pkg.name.toLowerCase() : "";
			if (PACKAGE_ROOT_NAMES.has(packageName)) return dir;
			if (fs.existsSync(path.join(dir, "plugins.json"))) return dir;
		} catch {}
		const parent = path.dirname(dir);
		if (parent === dir) break;
		dir = parent;
	}
	return startDir;
}
function resolveCorsOrigin$1(...args) {
	syncElizaEnvAliases();
	syncAppEnvToEliza();
	const result = resolveCorsOrigin(...args);
	syncAppEnvToEliza();
	syncElizaEnvAliases();
	return result;
}
var PACKAGE_ROOT_NAMES;
var init_server_startup = __esmMin((() => {
	init_env();
	PACKAGE_ROOT_NAMES = new Set([
		"eliza",
		"elizaai",
		"elizaos",
		"eliza"
	]);
}));

//#endregion
//#region node_modules/.bun/@elizaos+app-core@2.0.0-alpha.537+72829346cb4c43b1/node_modules/@elizaos/app-core/packages/app-core/src/utils/character-message-examples.js
function extractLikelyJson(input) {
	const trimmed = (input.length > 2e5 ? input.slice(0, 2e5) : input).trim();
	if (!trimmed) return trimmed;
	const withoutFences = trimmed.replace(/^```(?:json)?[ \t\r\n]{0,1024}/i, "").replace(/[ \t\r\n]{0,1024}```$/i, "").trim();
	if (withoutFences.startsWith("{") || withoutFences.startsWith("[")) return withoutFences;
	const starts = [withoutFences.indexOf("["), withoutFences.indexOf("{")].filter((index) => index >= 0);
	if (starts.length === 0) return withoutFences;
	const start = Math.min(...starts);
	const closer = withoutFences[start] === "[" ? "]" : "}";
	const end = withoutFences.lastIndexOf(closer);
	if (end <= start) return withoutFences;
	return withoutFences.slice(start, end + 1);
}
function normalizeSpeakerName(rawName, fallbackAgentName, options) {
	const fallbackMissingSpeaker = options.fallbackMissingSpeaker ?? true;
	if (typeof rawName === "string" && rawName.trim()) {
		const trimmed = rawName.trim();
		const normalized = trimmed.toLowerCase();
		if (normalized === "assistant" || normalized === "agent" || normalized === "ai" || normalized === "model" || normalized === "{{agentname}}") return fallbackAgentName;
		if (normalized === "user" || normalized === "human" || normalized === "{{user}}" || normalized === "customer") return "{{user1}}";
		return trimmed;
	}
	return fallbackMissingSpeaker ? fallbackAgentName : "";
}
function normalizeConversation(conversation, fallbackAgentName, options) {
	const rawExamples = Array.isArray(conversation) ? conversation : conversation && typeof conversation === "object" && "examples" in conversation && Array.isArray(conversation.examples) ? conversation.examples : null;
	if (!rawExamples) return null;
	const examples = [];
	for (const message of rawExamples) {
		const record = message && typeof message === "object" ? message : null;
		if (!record) continue;
		const contentRecord = record.content && typeof record.content === "object" ? record.content : null;
		const textSource = contentRecord?.text ?? record.text ?? record.message ?? record.content;
		const text = typeof textSource === "string" ? textSource.trim() : "";
		if (!text) continue;
		const actions = Array.isArray(contentRecord?.actions) ? contentRecord.actions.filter((action) => typeof action === "string" && action.trim().length > 0) : void 0;
		const name = normalizeSpeakerName(record.name ?? record.user ?? record.speaker ?? record.role, fallbackAgentName, options);
		if (!name) continue;
		examples.push({
			name,
			content: {
				text,
				...actions && actions.length > 0 ? { actions } : {}
			}
		});
	}
	if (examples.length === 0) return null;
	return { examples };
}
function normalizeCharacterMessageExamples(input, fallbackAgentName = "Agent", options = {}) {
	let parsed = input;
	if (typeof input === "string") {
		const candidate = extractLikelyJson(input);
		try {
			parsed = JSON.parse(candidate);
		} catch {
			return [];
		}
	}
	const source = parsed && typeof parsed === "object" && "messageExamples" in parsed && Array.isArray(parsed.messageExamples) ? parsed.messageExamples : parsed;
	if (!Array.isArray(source)) return [];
	return (source.length > 0 && source.every((entry) => entry && typeof entry === "object" && "examples" in entry && Array.isArray(entry.examples)) ? source : source.every((entry) => Array.isArray(entry)) ? source : [source]).map((group) => normalizeConversation(group, fallbackAgentName, options)).filter((group) => Boolean(group));
}
var init_character_message_examples = __esmMin((() => {}));

//#endregion
//#region node_modules/.bun/@elizaos+app-core@2.0.0-alpha.537+72829346cb4c43b1/node_modules/@elizaos/app-core/packages/app-core/src/runtime/build-character-from-config.js
function syncBrandEnvAliases$1() {
	syncElizaEnvAliases();
	syncAppEnvToEliza();
}
function resolveAppPreset(config, name) {
	const uiConfig = config.ui ?? {};
	const language = normalizeCharacterLanguage(uiConfig.language);
	const matchedPreset = (typeof uiConfig.presetId === "string" && uiConfig.presetId ? resolveStylePresetById(uiConfig.presetId, language) : void 0) ?? resolveStylePresetByAvatarIndex(uiConfig.avatarIndex, language) ?? resolveStylePresetByName(name, language);
	if (matchedPreset) return matchedPreset;
	return name ? void 0 : getDefaultStylePreset(language);
}
function buildCharacterFromConfig$1(...args) {
	syncBrandEnvAliases$1();
	const [config] = args;
	const character = buildCharacterFromConfig(...args);
	syncBrandEnvAliases$1();
	const agentEntry = config.agents?.list?.[0];
	const bundledPreset = resolveAppPreset(config, character.name);
	if ((character.messageExamples?.length ?? 0) > 0) character.messageExamples = normalizeCharacterMessageExamples(character.messageExamples, character.name);
	if (bundledPreset) {
		if (!agentEntry?.style && !character.style && bundledPreset.style) character.style = {
			all: [...bundledPreset.style.all],
			chat: [...bundledPreset.style.chat],
			post: [...bundledPreset.style.post]
		};
		if (!agentEntry?.adjectives && (!character.adjectives || character.adjectives.length === 0) && bundledPreset.adjectives.length > 0) character.adjectives = [...bundledPreset.adjectives];
		if (!agentEntry?.topics && (!Array.isArray(character.topics) || character.topics.length === 0) && Array.isArray(bundledPreset.topics) && bundledPreset.topics.length > 0) character.topics = [...bundledPreset.topics];
		if (!agentEntry?.postExamples && (character.postExamples?.length ?? 0) === 0) character.postExamples = [...bundledPreset.postExamples];
		if (!agentEntry?.messageExamples && (character.messageExamples?.length ?? 0) === 0) character.messageExamples = normalizeCharacterMessageExamples(bundledPreset.messageExamples, character.name);
	}
	return character;
}
var init_build_character_from_config = __esmMin((() => {
	init_character_message_examples();
	init_env();
}));

//#endregion
//#region node_modules/.bun/@elizaos+app-core@2.0.0-alpha.537+72829346cb4c43b1/node_modules/@elizaos/app-core/packages/app-core/src/api/auth/auth-context.js
/**
* Resolve the request to a session + identity if possible. Returns null on
* any failure path; never throws on bad input. The caller is responsible
* for sending the 401.
*/
async function ensureSessionForRequest(req, res, options) {
	const { store } = options;
	const env = options.env ?? process.env;
	const now = options.now ?? Date.now();
	const allowLegacy = options.allowLegacyBearer ?? true;
	const allowBootstrap = options.allowBootstrapBearer ?? true;
	const ip = req.socket?.remoteAddress ?? null;
	const userAgent = extractHeaderValue(req.headers["user-agent"]);
	const cookieSessionId = parseSessionCookie(req);
	if (cookieSessionId) {
		const session = await findActiveSession(store, cookieSessionId, now).catch(() => null);
		if (session) {
			const identity = await store.findIdentity(session.identityId).catch(() => null);
			if (identity) return {
				session,
				identity,
				source: "cookie",
				legacy: false
			};
			return null;
		}
	}
	const bearer = getProvidedApiToken(req);
	if (bearer) {
		const session = await findActiveSession(store, bearer, now).catch(() => null);
		if (session) {
			const identity = await store.findIdentity(session.identityId).catch(() => null);
			if (identity) return {
				session,
				identity,
				source: "bearer-session",
				legacy: false
			};
			return null;
		}
		const legacyToken = getCompatApiToken$1();
		if (allowLegacy && legacyToken && tokenMatches(legacyToken, bearer)) {
			const decision = await decideLegacyBearer(store, env, now);
			if (decision.allowed) {
				if (!res.headersSent) res.setHeader(LEGACY_DEPRECATION_HEADER, "1");
				await recordLegacyBearerUse(store, {
					ip,
					userAgent
				}).catch((err) => {
					console.error("[auth] legacy bearer audit failed:", err);
				});
				return {
					session: null,
					identity: null,
					source: "bearer-legacy",
					legacy: true
				};
			}
			await recordLegacyBearerRejection(store, {
				ip,
				userAgent,
				reason: decision.reason ?? "post_grace"
			}).catch((err) => {
				console.error("[auth] legacy bearer rejection audit failed:", err);
			});
			return null;
		}
		if (allowBootstrap) return {
			session: null,
			identity: null,
			source: "bearer-bootstrap",
			legacy: false
		};
	}
	return null;
}
var init_auth_context = __esmMin((() => {
	init_auth$1();
	init_legacy_bearer();
	init_sessions();
}));

//#endregion
//#region node_modules/.bun/@elizaos+app-core@2.0.0-alpha.537+72829346cb4c43b1/node_modules/@elizaos/app-core/packages/app-core/src/api/auth/bootstrap-token.js
/**
* Bootstrap-token verifier.
*
* The Eliza Cloud control plane mints an RS256-signed JWT, injects it as
* `ELIZA_CLOUD_BOOTSTRAP_TOKEN`, and the user pastes the same value into the
* dashboard exactly once. We verify here and reject everything that doesn't
* match: wrong issuer, wrong container, expired, replayed, signed with the
* wrong algorithm, or by an unknown key.
*
* Hard rule: this module fails closed. There is no `try { … } catch { return
* { authenticated: true } }` shortcut. Any error path returns
* `{ ok: false, reason }` and the caller MUST refuse the request.
*/
function isFiniteNumber(value) {
	return typeof value === "number" && Number.isFinite(value);
}
function isNonEmptyString(value) {
	return typeof value === "string" && value.length > 0;
}
function shapeClaims(payload) {
	if (!isNonEmptyString(payload.iss) || !isNonEmptyString(payload.sub) || !isNonEmptyString(payload.containerId) || !isNonEmptyString(payload.jti) || !isFiniteNumber(payload.iat) || !isFiniteNumber(payload.exp)) return {
		ok: false,
		reason: "claims_invalid"
	};
	if (payload.scope !== BOOTSTRAP_TOKEN_SCOPE) return {
		ok: false,
		reason: "scope_mismatch"
	};
	return {
		ok: true,
		claims: {
			iss: payload.iss,
			sub: payload.sub,
			containerId: payload.containerId,
			scope: BOOTSTRAP_TOKEN_SCOPE,
			iat: payload.iat,
			exp: payload.exp,
			jti: payload.jti
		}
	};
}
async function loadJwks(issuer, options) {
	const env = options.env ?? process.env;
	const now = options.now?.() ?? Date.now();
	const cached = await readCachedJwks(issuer, {
		env,
		now
	});
	if (cached) return cached;
	const response = await (options.fetchImpl ?? fetch)(`${issuer.replace(/\/$/, "")}/.well-known/jwks.json`, { headers: { accept: "application/json" } });
	if (!response.ok) return null;
	const body = await response.json();
	if (!body || typeof body !== "object") return null;
	const candidate = body;
	if (!Array.isArray(candidate.keys)) return null;
	const document = { keys: candidate.keys };
	await writeCachedJwks(issuer, document, {
		env,
		now
	});
	return document;
}
/**
* Verify a bootstrap token.
*
* On success the same `jti` is recorded as seen so a second presentation
* fails immediately with `replay`. The caller must NOT call this twice for
* the same exchange — `recordJtiSeen` is consumed atomically here.
*/
async function verifyBootstrapToken(token, options) {
	const env = options.env ?? process.env;
	const issuer = env.ELIZA_CLOUD_ISSUER?.trim();
	const expectedContainerId = env.ELIZA_CLOUD_CONTAINER_ID?.trim();
	if (!issuer) return {
		ok: false,
		reason: "missing_issuer_env"
	};
	if (!expectedContainerId) return {
		ok: false,
		reason: "missing_container_env"
	};
	if (!token || typeof token !== "string" || token.length < 8) return {
		ok: false,
		reason: "missing_token"
	};
	let jwks;
	try {
		jwks = await loadJwks(issuer, options);
	} catch {
		return {
			ok: false,
			reason: "jwks_fetch_failed"
		};
	}
	if (!jwks || jwks.keys.length === 0) return {
		ok: false,
		reason: "jwks_fetch_failed"
	};
	const localJwks = createLocalJWKSet({ keys: jwks.keys });
	let payload;
	try {
		payload = (await jwtVerify(token, localJwks, {
			algorithms: [BOOTSTRAP_TOKEN_ALG],
			issuer
		})).payload;
	} catch (err) {
		const code = err.code;
		if (code === "ERR_JWT_EXPIRED") return {
			ok: false,
			reason: "expired"
		};
		if (code === "ERR_JWT_CLAIM_VALIDATION_FAILED") {
			if (err.claim === "iss") return {
				ok: false,
				reason: "issuer_mismatch"
			};
			return {
				ok: false,
				reason: "claims_invalid"
			};
		}
		if (code === "ERR_JWS_SIGNATURE_VERIFICATION_FAILED") return {
			ok: false,
			reason: "signature_invalid"
		};
		if (code === "ERR_JOSE_ALG_NOT_ALLOWED" || code === "ERR_JWS_INVALID") return {
			ok: false,
			reason: "alg_not_allowed"
		};
		return {
			ok: false,
			reason: "signature_invalid"
		};
	}
	const shape = shapeClaims(payload);
	if (!shape.ok) return shape;
	const claims = shape.claims;
	if (claims.iss !== issuer) return {
		ok: false,
		reason: "issuer_mismatch"
	};
	if (claims.containerId !== expectedContainerId) return {
		ok: false,
		reason: "container_mismatch"
	};
	const now = options.now?.() ?? Date.now();
	if (claims.exp * 1e3 <= now) return {
		ok: false,
		reason: "expired"
	};
	let unseen;
	try {
		unseen = await options.authStore.recordJtiSeen(claims.jti, now);
	} catch {
		return {
			ok: false,
			reason: "store_error"
		};
	}
	if (!unseen) return {
		ok: false,
		reason: "replay"
	};
	return {
		ok: true,
		claims
	};
}
var BOOTSTRAP_TOKEN_ALG, BOOTSTRAP_TOKEN_SCOPE;
var init_bootstrap_token = __esmMin((() => {
	init_cloud_jwks_store();
	BOOTSTRAP_TOKEN_ALG = "RS256";
	BOOTSTRAP_TOKEN_SCOPE = "bootstrap";
}));

//#endregion
//#region node_modules/.bun/@elizaos+app-core@2.0.0-alpha.537+72829346cb4c43b1/node_modules/@elizaos/app-core/packages/app-core/src/api/auth/passwords.js
/**
* Password hashing + strength gating for the P1 auth path.
*
* Backed by `@node-rs/argon2` per plan §11 (Rust prebuilt binaries, no
* native compile step on Bun/Linux CI). We use argon2id with parameters
* lifted from current OWASP Password Storage guidance:
*
*   memoryCost: 19_456 KiB (≈19 MiB)
*   timeCost:   2 iterations
*   parallelism: 1
*
* `verifyPassword` delegates to `@node-rs/argon2`'s `verify`, which is
* timing-safe by construction. We never short-circuit on hash shape or
* length comparison — every verify runs through the full KDF.
*
* Hard rule: this module fails closed. Any error during `hash` or `verify`
* propagates to the caller. We do NOT swallow exceptions and pretend the
* password matched.
*/
/**
* Refuse passwords under {@link PASSWORD_MIN_LENGTH} characters or with
* trivially weak composition. We deliberately do not pull in `zxcvbn` to
* avoid adding a runtime dep without explicit confirmation; the length +
* composition floor is the documented fallback in the task brief.
*
* Throws {@link WeakPasswordError} on rejection.
*/
function assertPasswordStrong(plain) {
	if (typeof plain !== "string" || plain.length < PASSWORD_MIN_LENGTH) throw new WeakPasswordError("too_short");
	if (!/[A-Za-z]/.test(plain)) throw new WeakPasswordError("missing_letter");
	if (!/[0-9\W_]/.test(plain)) throw new WeakPasswordError("missing_digit_or_symbol");
}
/**
* Hash `plain` with argon2id. Returns the encoded string (parameters + salt
* + tag) suitable for direct DB storage.
*
* Errors propagate to the caller — fail-fast policy.
*/
async function hashPassword(plain) {
	return await hash(plain, ARGON2_PARAMS);
}
/**
* Compare `plain` against a stored argon2id hash. Returns `true` on match,
* `false` on mismatch. Always runs the full KDF; never short-circuits.
*
* If the encoded hash is malformed or hashed with a different algorithm,
* `@node-rs/argon2` throws — we propagate. The caller MUST treat a thrown
* error as a verification failure (i.e., `await verifyPassword(...).catch(()
* => false)` is wrong; let it surface).
*/
async function verifyPassword(plain, encodedHash) {
	return await verify(encodedHash, plain);
}
var ARGON2_PARAMS, PASSWORD_MIN_LENGTH, WeakPasswordError;
var init_passwords = __esmMin((() => {
	ARGON2_PARAMS = {
		algorithm: 2,
		memoryCost: 19456,
		timeCost: 2,
		parallelism: 1
	};
	PASSWORD_MIN_LENGTH = 12;
	WeakPasswordError = class extends Error {
		reason;
		constructor(reason) {
			super(`weak_password:${reason}`);
			this.name = "WeakPasswordError";
			this.reason = reason;
		}
	};
}));

//#endregion
//#region node_modules/.bun/@elizaos+app-core@2.0.0-alpha.537+72829346cb4c43b1/node_modules/@elizaos/app-core/packages/app-core/src/api/auth/sensitive-rate-limit.js
/**
* Look up (or lazily create) the named sensitive-route limiter. Use one
* name per logical operation — e.g. `auth.bootstrap.exchange`,
* `auth.login.sso.start`, `auth.owner.bind.start`.
*
* Buckets are kept in a central registry so the sweep timer and the
* `_resetSensitiveLimiters` test helper handle them all.
*/
function getSensitiveLimiter(name) {
	let limiter = limiterRegistry.get(name);
	if (!limiter) {
		limiter = new SensitiveRateLimiter();
		limiterRegistry.set(name, limiter);
	}
	return limiter;
}
/** Reset state. Test-only. */
function _resetSensitiveLimiters() {
	for (const limiter of limiterRegistry.values()) limiter.reset();
}
var SENSITIVE_RATE_LIMIT_WINDOW_MS, SENSITIVE_RATE_LIMIT_MAX, SensitiveRateLimiter, limiterRegistry, bootstrapExchangeLimiter, sweepTimer$1;
var init_sensitive_rate_limit = __esmMin((() => {
	SENSITIVE_RATE_LIMIT_WINDOW_MS = 60 * 1e3;
	SENSITIVE_RATE_LIMIT_MAX = 5;
	SensitiveRateLimiter = class {
		buckets = /* @__PURE__ */ new Map();
		/**
		* Returns true when the request is allowed, false when the limit is
		* exhausted. Each successful call increments the bucket, so repeated
		* `consume` calls in the same window will eventually return false even
		* for valid traffic — this is intentional.
		*/
		consume(ip, now = Date.now()) {
			const key = ip ?? "unknown";
			const entry = this.buckets.get(key);
			if (!entry || now > entry.resetAt) {
				this.buckets.set(key, {
					count: 1,
					resetAt: now + SENSITIVE_RATE_LIMIT_WINDOW_MS
				});
				return true;
			}
			if (entry.count >= SENSITIVE_RATE_LIMIT_MAX) return false;
			entry.count += 1;
			return true;
		}
		reset() {
			this.buckets.clear();
		}
		sweep(now = Date.now()) {
			for (const [key, entry] of this.buckets) if (now > entry.resetAt) this.buckets.delete(key);
		}
	};
	limiterRegistry = /* @__PURE__ */ new Map();
	bootstrapExchangeLimiter = getSensitiveLimiter("auth.bootstrap.exchange");
	sweepTimer$1 = setInterval(() => {
		for (const limiter of limiterRegistry.values()) limiter.sweep();
	}, 300 * 1e3);
	if (typeof sweepTimer$1 === "object" && "unref" in sweepTimer$1) sweepTimer$1.unref();
}));

//#endregion
//#region node_modules/.bun/@elizaos+app-core@2.0.0-alpha.537+72829346cb4c43b1/node_modules/@elizaos/app-core/packages/app-core/src/api/auth/index.js
var auth_exports = /* @__PURE__ */ __exportAll({
	ARGON2_PARAMS: () => ARGON2_PARAMS,
	AUDIT_LOG_FILENAME: () => AUDIT_LOG_FILENAME,
	AUDIT_LOG_MAX_BYTES: () => AUDIT_LOG_MAX_BYTES,
	AUDIT_LOG_ROTATE_FILENAME: () => AUDIT_LOG_ROTATE_FILENAME,
	AUDIT_REDACTION_RE: () => AUDIT_REDACTION_RE,
	BOOTSTRAP_TOKEN_ALG: () => BOOTSTRAP_TOKEN_ALG,
	BOOTSTRAP_TOKEN_SCOPE: () => BOOTSTRAP_TOKEN_SCOPE,
	BROWSER_SESSION_REMEMBER_CAP_MS: () => BROWSER_SESSION_REMEMBER_CAP_MS,
	BROWSER_SESSION_TTL_MS: () => BROWSER_SESSION_TTL_MS$1,
	CSRF_COOKIE_NAME: () => CSRF_COOKIE_NAME,
	CSRF_HEADER_NAME: () => CSRF_HEADER_NAME,
	LEGACY_DEPRECATION_HEADER: () => LEGACY_DEPRECATION_HEADER,
	LEGACY_GRACE_WINDOW_MS: () => LEGACY_GRACE_WINDOW_MS,
	LEGACY_INVALIDATE_AUDIT_ACTION: () => LEGACY_INVALIDATE_AUDIT_ACTION,
	LEGACY_REJECT_AUDIT_ACTION: () => LEGACY_REJECT_AUDIT_ACTION,
	LEGACY_USE_AUDIT_ACTION: () => LEGACY_USE_AUDIT_ACTION,
	MACHINE_SESSION_TTL_MS: () => MACHINE_SESSION_TTL_MS,
	PASSWORD_MIN_LENGTH: () => PASSWORD_MIN_LENGTH,
	SENSITIVE_RATE_LIMIT_MAX: () => SENSITIVE_RATE_LIMIT_MAX,
	SENSITIVE_RATE_LIMIT_WINDOW_MS: () => SENSITIVE_RATE_LIMIT_WINDOW_MS,
	SESSION_COOKIE_NAME: () => SESSION_COOKIE_NAME$1,
	WeakPasswordError: () => WeakPasswordError,
	_peekLegacyBearerDeadline: () => _peekLegacyBearerDeadline,
	_peekLegacyBearerInvalidated: () => _peekLegacyBearerInvalidated,
	_resetLegacyBearerState: () => _resetLegacyBearerState,
	_resetSensitiveLimiters: () => _resetSensitiveLimiters,
	appendAuditEvent: () => appendAuditEvent,
	assertPasswordStrong: () => assertPasswordStrong,
	bootstrapExchangeLimiter: () => bootstrapExchangeLimiter,
	createBrowserSession: () => createBrowserSession,
	createMachineSession: () => createMachineSession,
	decideLegacyBearer: () => decideLegacyBearer,
	deriveCsrfToken: () => deriveCsrfToken,
	ensureSessionForRequest: () => ensureSessionForRequest,
	findActiveSession: () => findActiveSession,
	getSensitiveLimiter: () => getSensitiveLimiter,
	hashPassword: () => hashPassword,
	markLegacyBearerInvalidated: () => markLegacyBearerInvalidated,
	parseCookieHeader: () => parseCookieHeader,
	parseSessionCookie: () => parseSessionCookie,
	recordLegacyBearerRejection: () => recordLegacyBearerRejection,
	recordLegacyBearerUse: () => recordLegacyBearerUse,
	redactMetadata: () => redactMetadata,
	resolveAuditLogPath: () => resolveAuditLogPath,
	resolveAuditLogRotatedPath: () => resolveAuditLogRotatedPath,
	revokeAllSessionsForIdentity: () => revokeAllSessionsForIdentity,
	revokeSession: () => revokeSession,
	serializeCsrfCookie: () => serializeCsrfCookie,
	serializeCsrfExpiryCookie: () => serializeCsrfExpiryCookie,
	serializeSessionCookie: () => serializeSessionCookie,
	serializeSessionExpiryCookie: () => serializeSessionExpiryCookie,
	verifyBootstrapToken: () => verifyBootstrapToken,
	verifyCsrfToken: () => verifyCsrfToken,
	verifyPassword: () => verifyPassword
});
var init_auth = __esmMin((() => {
	init_audit$1();
	init_auth_context();
	init_bootstrap_token();
	init_legacy_bearer();
	init_passwords();
	init_sensitive_rate_limit();
	init_sessions();
}));

//#endregion
//#region node_modules/.bun/@elizaos+app-core@2.0.0-alpha.537+72829346cb4c43b1/node_modules/@elizaos/app-core/packages/app-core/src/api/auth-bootstrap-routes.js
/**
* Bootstrap-token exchange route.
*
* The cloud control plane mints a single-use RS256 JWT and injects it as
* `ELIZA_CLOUD_BOOTSTRAP_TOKEN`. The dashboard pastes the same value into
* this endpoint exactly once; on success we mint a long-lived browser
* session row and return its id. The UI uses the id as a bearer until P1
* lands the cookie + CSRF infrastructure.
*
* This is the only place that flips bootstrap → session. The token's `jti`
* is consumed atomically by the verifier so a replay (even after a crash
* mid-mint) is rejected.
*/
function getDrizzleDb$1(state) {
	const runtime = state.current;
	if (!runtime) return null;
	const adapter = runtime.adapter;
	if (!adapter?.db) return null;
	return adapter.db;
}
function deriveIdentityIdFromCloudUser(cloudUserId) {
	const hash = crypto.createHash("sha256").update(cloudUserId, "utf8").digest("hex");
	return [
		hash.slice(0, 8),
		hash.slice(8, 12),
		hash.slice(12, 16),
		hash.slice(16, 20),
		hash.slice(20, 32)
	].join("-");
}
/**
* POST /api/auth/bootstrap/exchange
*
* Body: `{ token: string }`
*
* Success: 200 with `{ sessionId, identityId, expiresAt }`. The caller stores
* the session id and presents it as a bearer (`Authorization: Bearer …`)
* on subsequent requests until P1 ships cookie auth.
*
* Failure: 401 / 403 / 429 with `{ error, reason }`. Reason is one of the
* `VerifyBootstrapFailureReason` values plus `rate_limited` and
* `db_unavailable`.
*/
async function handleAuthBootstrapRoutes(req, res, state) {
	const method = (req.method ?? "GET").toUpperCase();
	const url = new URL(req.url ?? "/", "http://localhost");
	if (method !== "POST" || url.pathname !== "/api/auth/bootstrap/exchange") return false;
	const ip = req.socket?.remoteAddress ?? null;
	if (!bootstrapExchangeLimiter.consume(ip)) {
		sendJson$2(res, 429, {
			error: "rate_limited",
			reason: "rate_limited"
		});
		return true;
	}
	const db = getDrizzleDb$1(state);
	if (!db) {
		sendJson$2(res, 503, {
			error: "db_unavailable",
			reason: "db_unavailable"
		});
		return true;
	}
	const store = new AuthStore(db);
	const body = await readCompatJsonBody(req, res);
	if (body == null) return true;
	const token = typeof body.token === "string" ? body.token.trim() : "";
	if (!token) {
		sendJsonError(res, 400, "missing_token");
		return true;
	}
	const userAgent = extractHeaderValue(req.headers["user-agent"]);
	const result = await verifyBootstrapToken(token, { authStore: store });
	if (!result.ok) {
		await appendAuditEvent({
			actorIdentityId: null,
			ip,
			userAgent,
			action: "auth.bootstrap.exchange",
			outcome: "failure",
			metadata: { reason: result.reason }
		}, { store }).catch((err) => {
			console.error("[auth] audit append failed:", err);
		});
		sendJson$2(res, result.reason === "missing_token" ? 400 : result.reason === "missing_issuer_env" || result.reason === "missing_container_env" ? 503 : 401, {
			error: "auth_required",
			reason: result.reason
		});
		return true;
	}
	const claims = result.claims;
	const now = Date.now();
	const identityId = deriveIdentityIdFromCloudUser(claims.sub);
	if (!await store.findIdentity(identityId)) await store.createIdentity({
		id: identityId,
		kind: "owner",
		displayName: `Cloud user ${claims.sub.slice(0, 8)}`,
		createdAt: now,
		passwordHash: null,
		cloudUserId: claims.sub
	});
	const sessionId = crypto.randomBytes(32).toString("hex");
	const csrfSecret = crypto.randomBytes(32).toString("hex");
	const expiresAt = now + BROWSER_SESSION_TTL_MS;
	const session = await store.createSession({
		id: sessionId,
		identityId,
		kind: "browser",
		createdAt: now,
		lastSeenAt: now,
		expiresAt,
		rememberDevice: false,
		csrfSecret,
		ip,
		userAgent,
		scopes: []
	});
	res.setHeader("set-cookie", [serializeSessionCookie(session), serializeCsrfCookie(session)]);
	await markLegacyBearerInvalidated(store, {
		actorIdentityId: identityId,
		ip,
		userAgent
	}).catch((err) => {
		console.error("[auth] legacy invalidate audit failed:", err);
	});
	await appendAuditEvent({
		actorIdentityId: identityId,
		ip,
		userAgent,
		action: "auth.bootstrap.exchange",
		outcome: "success",
		metadata: {
			containerId: claims.containerId,
			jti: claims.jti
		}
	}, { store }).catch((err) => {
		console.error("[auth] audit append failed:", err);
	});
	sendJson$2(res, 200, {
		sessionId,
		identityId,
		expiresAt
	});
	isLoopbackRemoteAddress(ip);
	return true;
}
var BROWSER_SESSION_TTL_MS;
var init_auth_bootstrap_routes = __esmMin((() => {
	init_auth_store();
	init_auth$1();
	init_auth();
	init_compat_route_shared();
	init_response();
	BROWSER_SESSION_TTL_MS = 720 * 60 * 1e3;
}));

//#endregion
//#region node_modules/.bun/@elizaos+app-core@2.0.0-alpha.537+72829346cb4c43b1/node_modules/@elizaos/app-core/packages/app-core/src/voice/types.js
var PREMADE_VOICES;
var init_types = __esmMin((() => {
	PREMADE_VOICES = [
		{
			id: "rachel",
			name: "Rachel",
			voiceId: "21m00Tcm4TlvDq8ikWAM",
			gender: "female",
			hint: "Calm, clear",
			hintKey: "voice.hint.calm_clear",
			previewUrl: "https://storage.googleapis.com/eleven-public-prod/premade/voices/21m00Tcm4TlvDq8ikWAM/df6788f9-5c96-470d-8312-aab3b3d8f50a.mp3"
		},
		{
			id: "sarah",
			name: "Sarah",
			voiceId: "EXAVITQu4vr4xnSDxMaL",
			gender: "female",
			hint: "Soft, warm",
			hintKey: "voice.hint.soft_warm",
			previewUrl: "https://storage.googleapis.com/eleven-public-prod/premade/voices/EXAVITQu4vr4xnSDxMaL/6851ec91-9950-471f-8586-357c52539069.mp3"
		},
		{
			id: "matilda",
			name: "Matilda",
			voiceId: "XrExE9yKIg1WjnnlVkGX",
			gender: "female",
			hint: "Warm, friendly",
			hintKey: "voice.hint.warm_friendly",
			previewUrl: "https://storage.googleapis.com/eleven-public-prod/premade/voices/XrExE9yKIg1WjnnlVkGX/b930e18d-6b4d-466e-bab2-0ae97c6d8535.mp3"
		},
		{
			id: "lily",
			name: "Lily",
			voiceId: "pFZP5JQG7iQjIQuC4Bku",
			gender: "female",
			hint: "British, raspy",
			hintKey: "voice.hint.british_raspy",
			previewUrl: "https://storage.googleapis.com/eleven-public-prod/premade/voices/pFZP5JQG7iQjIQuC4Bku/0ab8bd74-fcd2-489d-b70a-3e1bcde8c999.mp3"
		},
		{
			id: "alice",
			name: "Alice",
			voiceId: "Xb7hH8MSUJpSbSDYk0k2",
			gender: "female",
			hint: "British, confident",
			hintKey: "voice.hint.british_confident",
			previewUrl: "https://storage.googleapis.com/eleven-public-prod/premade/voices/Xb7hH8MSUJpSbSDYk0k2/f5409e2f-d9c3-4ac9-9e7d-916a5dbd1ef1.mp3"
		},
		{
			id: "brian",
			name: "Brian",
			voiceId: "nPczCjzI2devNBz1zQrb",
			gender: "male",
			hint: "Deep, smooth",
			hintKey: "voice.hint.deep_smooth",
			previewUrl: "https://storage.googleapis.com/eleven-public-prod/premade/voices/nPczCjzI2devNBz1zQrb/f4dbda0c-aff0-45c0-93fa-f5d5ec95a2eb.mp3"
		},
		{
			id: "adam",
			name: "Adam",
			voiceId: "pNInz6obpgDQGcFmaJgB",
			gender: "male",
			hint: "Deep, authoritative",
			hintKey: "voice.hint.deep_authoritative",
			previewUrl: "https://storage.googleapis.com/eleven-public-prod/premade/voices/pNInz6obpgDQGcFmaJgB/38a69695-2ca9-4b9e-b9ec-f07ced494a58.mp3"
		},
		{
			id: "josh",
			name: "Josh",
			voiceId: "TxGEqnHWrfWFTfGW9XjX",
			gender: "male",
			hint: "Young, deep",
			hintKey: "voice.hint.young_deep",
			previewUrl: "https://storage.googleapis.com/eleven-public-prod/premade/voices/TxGEqnHWrfWFTfGW9XjX/3ae2fc71-d5f9-4769-bb71-2a43633cd186.mp3"
		},
		{
			id: "daniel",
			name: "Daniel",
			voiceId: "onwK4e9ZLuTAKqWW03F9",
			gender: "male",
			hint: "British, presenter",
			hintKey: "voice.hint.british_presenter",
			previewUrl: "https://storage.googleapis.com/eleven-public-prod/premade/voices/onwK4e9ZLuTAKqWW03F9/7eee0236-1a72-4b86-b303-5dcadc007ba9.mp3"
		},
		{
			id: "liam",
			name: "Liam",
			voiceId: "TX3LPaxmHKxFdv7VOQHJ",
			gender: "male",
			hint: "Young, natural",
			hintKey: "voice.hint.young_natural",
			previewUrl: "https://storage.googleapis.com/eleven-public-prod/premade/voices/TX3LPaxmHKxFdv7VOQHJ/63148076-6363-42db-aea8-31424308b92c.mp3"
		},
		{
			id: "gigi",
			name: "Gigi",
			voiceId: "jBpfuIE2acCO8z3wKNLl",
			gender: "character",
			hint: "Childish, cute",
			hintKey: "voice.hint.childish_cute",
			previewUrl: "https://storage.googleapis.com/eleven-public-prod/premade/voices/jBpfuIE2acCO8z3wKNLl/3a7e4339-78fa-404e-8d10-c3ef5587935b.mp3"
		},
		{
			id: "mimi",
			name: "Mimi",
			voiceId: "zrHiDhphv9ZnVXBqCLjz",
			gender: "character",
			hint: "Cute, animated",
			hintKey: "voice.hint.cute_animated",
			previewUrl: "https://storage.googleapis.com/eleven-public-prod/premade/voices/zrHiDhphv9ZnVXBqCLjz/decbf20b-0f57-4fac-985b-a4f0290ebfc4.mp3"
		},
		{
			id: "dorothy",
			name: "Dorothy",
			voiceId: "ThT5KcBeYPX3keUQqHPh",
			gender: "character",
			hint: "Sweet, storybook",
			hintKey: "voice.hint.sweet_storybook",
			previewUrl: "https://storage.googleapis.com/eleven-public-prod/premade/voices/ThT5KcBeYPX3keUQqHPh/981f0855-6598-48d2-9f8f-b6d92fbbe3fc.mp3"
		},
		{
			id: "glinda",
			name: "Glinda",
			voiceId: "z9fAnlkpzviPz146aGWa",
			gender: "character",
			hint: "Magical, whimsical",
			hintKey: "voice.hint.magical_whimsical",
			previewUrl: "https://storage.googleapis.com/eleven-public-prod/premade/voices/z9fAnlkpzviPz146aGWa/cbc60443-7b61-4ebb-b8e1-5c03237ea01d.mp3"
		},
		{
			id: "charlotte",
			name: "Charlotte",
			voiceId: "XB0fDUnXU5powFXDhCwa",
			gender: "character",
			hint: "Alluring, game NPC",
			hintKey: "voice.hint.alluring_game_npc",
			previewUrl: "https://storage.googleapis.com/eleven-public-prod/premade/voices/XB0fDUnXU5powFXDhCwa/942356dc-f10d-4d89-bda5-4f8505ee038b.mp3"
		},
		{
			id: "callum",
			name: "Callum",
			voiceId: "N2lVS1w4EtoT3dr4eOWO",
			gender: "character",
			hint: "Gruff, game hero",
			hintKey: "voice.hint.gruff_game_hero",
			previewUrl: "https://storage.googleapis.com/eleven-public-prod/premade/voices/N2lVS1w4EtoT3dr4eOWO/ac833bd8-ffda-4938-9ebc-b0f99ca25481.mp3"
		},
		{
			id: "momo",
			name: "Momo",
			voiceId: "n7Wi4g1bhpw4Bs8HK5ph",
			gender: "female",
			hint: "Custom Voice",
			hintKey: "voice.hint.custom_voice",
			previewUrl: ""
		},
		{
			id: "yuki",
			name: "Yuki",
			voiceId: "4tRn1lSkEn13EVTuqb0g",
			gender: "female",
			hint: "Custom Voice",
			hintKey: "voice.hint.custom_voice",
			previewUrl: ""
		},
		{
			id: "rin",
			name: "Rin",
			voiceId: "cNYrMw9glwJZXR8RwbuR",
			gender: "female",
			hint: "Custom Voice",
			hintKey: "voice.hint.custom_voice",
			previewUrl: ""
		},
		{
			id: "kei",
			name: "Kei",
			voiceId: "eadgjmk4R4uojdsheG9t",
			gender: "male",
			hint: "Custom Voice",
			hintKey: "voice.hint.custom_voice",
			previewUrl: ""
		},
		{
			id: "jin",
			name: "Jin",
			voiceId: "6IwYbsNENZgAB1dtBZDp",
			gender: "male",
			hint: "Custom Voice",
			hintKey: "voice.hint.custom_voice",
			previewUrl: ""
		},
		{
			id: "satoshi",
			name: "Satoshi",
			voiceId: "7cOBG34AiHrAzs842Rdi",
			gender: "male",
			hint: "Custom Voice",
			hintKey: "voice.hint.custom_voice",
			previewUrl: ""
		},
		{
			id: "ryu",
			name: "Ryu",
			voiceId: "QzTKubutNn9TjrB7Xb2Q",
			gender: "male",
			hint: "Custom Voice",
			hintKey: "voice.hint.custom_voice",
			previewUrl: ""
		}
	];
}));

//#endregion
//#region node_modules/.bun/@elizaos+app-core@2.0.0-alpha.537+72829346cb4c43b1/node_modules/@elizaos/app-core/packages/app-core/src/services/account-usage.js
/**
* Account usage probes + local JSONL counters.
*
* Two responsibilities:
*  1. Probe provider usage APIs (`pollAnthropicUsage`, `pollCodexUsage`)
*     to populate the `LinkedAccountUsage` snapshot on each account.
*  2. Maintain append-only JSONL counters per `(providerId, accountId, day)`
*     so we can answer "calls made today / tokens used / errors" without
*     re-reading every trajectory.
*
* The probes throw on HTTP error so the caller can decide whether to mark
* the account as `rate-limited` / `needs-reauth` / `invalid`. The counters
* are best-effort and synchronous — at our scale appendFileSync is fine.
*/
function utilizationToPct(value) {
	if (typeof value !== "number" || !Number.isFinite(value)) return void 0;
	return Math.max(0, Math.min(100, value * 100));
}
function normalizeResetTimestamp(value) {
	if (typeof value === "number" && Number.isFinite(value)) return value < 0xe8d4a51000 ? value * 1e3 : value;
	if (typeof value === "string" && value.length > 0) {
		const parsed = Date.parse(value);
		return Number.isFinite(parsed) ? parsed : void 0;
	}
}
/**
* Probe Anthropic's OAuth usage endpoint.
*
* Endpoint: `GET https://api.anthropic.com/api/oauth/usage`
* Headers : `Authorization: Bearer <accessToken>`,
*           `anthropic-beta: oauth-2025-04-20`,
*           `Content-Type: application/json`
*
* Handles both legacy flat (`five_hour_utilization`) and new nested
* (`five_hour: { utilization }`) response shapes. Throws on any HTTP
* error with the status code included in the message.
*/
async function pollAnthropicUsage(accessToken, fetchImpl = fetch) {
	const res = await fetchImpl(ANTHROPIC_USAGE_URL, {
		method: "GET",
		headers: {
			Authorization: `Bearer ${accessToken}`,
			"anthropic-beta": "oauth-2025-04-20",
			"Content-Type": "application/json"
		}
	});
	if (!res.ok) throw new Error(`Anthropic usage probe failed: HTTP ${res.status}`);
	const payload = await res.json();
	const fiveHour = payload.five_hour;
	const sevenDay = payload.seven_day;
	const sessionPct = utilizationToPct(fiveHour?.utilization) ?? utilizationToPct(payload.five_hour_utilization);
	const weeklyPct = utilizationToPct(sevenDay?.utilization) ?? utilizationToPct(payload.seven_day_utilization);
	const resetsAt = normalizeResetTimestamp(fiveHour?.resets_at) ?? normalizeResetTimestamp(payload.five_hour_resets_at);
	return {
		refreshedAt: Date.now(),
		...sessionPct !== void 0 ? { sessionPct } : {},
		...weeklyPct !== void 0 ? { weeklyPct } : {},
		...resetsAt !== void 0 ? { resetsAt } : {}
	};
}
/**
* Probe Codex / ChatGPT's usage endpoint.
*
* Endpoint: `GET https://chatgpt.com/backend-api/wham/usage`
* Headers : `Authorization: Bearer <accessToken>`,
*           `ChatGPT-Account-Id: <openAIAccountId>`,
*           `User-Agent: codex-cli`
*
* `used_percent` is already on the 0..100 scale. `reset_at` is epoch
* seconds. Codex has no weekly equivalent, so `weeklyPct` stays undefined.
*/
async function pollCodexUsage(accessToken, accountId, fetchImpl = fetch) {
	const res = await fetchImpl(CODEX_USAGE_URL, {
		method: "GET",
		headers: {
			Authorization: `Bearer ${accessToken}`,
			"ChatGPT-Account-Id": accountId,
			"User-Agent": "codex-cli"
		}
	});
	if (!res.ok) throw new Error(`Codex usage probe failed: HTTP ${res.status}`);
	const primary = (await res.json()).rate_limit?.primary_window;
	let sessionPct;
	if (typeof primary?.used_percent === "number" && Number.isFinite(primary.used_percent)) sessionPct = Math.max(0, Math.min(100, primary.used_percent));
	const resetsAt = normalizeResetTimestamp(primary?.reset_at);
	return {
		refreshedAt: Date.now(),
		...sessionPct !== void 0 ? { sessionPct } : {},
		...resetsAt !== void 0 ? { resetsAt } : {}
	};
}
function elizaHome() {
	return process.env.ELIZA_HOME || path.join(os.homedir(), ".eliza");
}
function dayStamp(ts = Date.now()) {
	const d = new Date(ts);
	return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
}
function counterFile(providerId, accountId, ts = Date.now()) {
	return path.join(elizaHome(), "usage", providerId, accountId, `${dayStamp(ts)}.jsonl`);
}
/**
* Append a usage entry for the given `(providerId, accountId)` pair.
* One line per call, written synchronously with mode 0o600. The day
* directory is created on demand.
*/
function recordCall(providerId, accountId, entry) {
	const ts = Date.now();
	const line = {
		ts,
		...entry
	};
	const file = counterFile(providerId, accountId, ts);
	const dir = path.dirname(file);
	if (!existsSync(dir)) mkdirSync(dir, {
		recursive: true,
		mode: 448
	});
	appendFileSync(file, `${JSON.stringify(line)}\n`, {
		flag: "a",
		mode: 384
	});
}
var ANTHROPIC_USAGE_URL, CODEX_USAGE_URL;
var init_account_usage = __esmMin((() => {
	ANTHROPIC_USAGE_URL = "https://api.anthropic.com/api/oauth/usage";
	CODEX_USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";
}));

//#endregion
//#region node_modules/.bun/@elizaos+app-core@2.0.0-alpha.537+72829346cb4c43b1/node_modules/@elizaos/app-core/packages/app-core/src/services/account-pool.js
/**
* Multi-account selection brain.
*
* Owns the runtime decision "which `LinkedAccountConfig` should serve this
* request?" given a strategy (priority / round-robin / least-used /
* quota-aware), session affinity, and per-account health state.
*
* The pool never reads OAuth credentials directly — callers resolve them
* via `getAccessToken(providerId, accountId)` from `@elizaos/agent` once
* the pool returns an account. Health, priority, and usage live in this
* layer; the OAuth blob lives under `~/.eliza/auth/` (see WS1's
* `account-storage.ts`).
*
* Persistence: the pool layers rich metadata (priority, enabled, health,
* usage) on top of WS1's credential records. The metadata is written to
* `<ELIZA_HOME>/auth/_pool-metadata.json` atomically so it survives
* process restarts and is independent of WS3's eventual `eliza.json`
* field — when WS3 lands its CRUD API on top of `LinkedAccountsConfig`
* we can swap `createDefaultAccountPool()`'s deps without touching the
* pool itself.
*/
function poolRecordKey(providerId, accountId) {
	return `${providerId}:${accountId}`;
}
function findAccountById(all, accountId) {
	const direct = all[accountId];
	if (direct) return direct;
	return Object.values(all).find((account) => account.id === accountId) ?? null;
}
function byPriorityThenAge(a, b) {
	if (a.priority !== b.priority) return a.priority - b.priority;
	return (a.lastUsedAt ?? 0) - (b.lastUsedAt ?? 0);
}
function byLeastUsedThenPriority(a, b) {
	const aPct = a.usage?.sessionPct ?? 0;
	const bPct = b.usage?.sessionPct ?? 0;
	if (aPct !== bPct) return aPct - bPct;
	return byPriorityThenAge(a, b);
}
function authRoot() {
	return path.join(process.env.ELIZA_HOME || path.join(os.homedir(), ".eliza"), "auth");
}
function metadataFile() {
	return path.join(authRoot(), "_pool-metadata.json");
}
function isPoolProviderId(value) {
	return value === "anthropic-subscription" || value === "openai-codex" || value === "anthropic-api" || value === "openai-api";
}
function readMetaStore() {
	const file = metadataFile();
	if (!existsSync(file)) return {};
	try {
		const raw = readFileSync(file, "utf-8");
		const parsed = JSON.parse(raw);
		if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed;
	} catch {}
	return {};
}
function writeMetaStore(store) {
	const file = metadataFile();
	const dir = path.dirname(file);
	if (!existsSync(dir)) mkdirSync(dir, {
		recursive: true,
		mode: 448
	});
	const tmp = `${file}.tmp`;
	writeFileSync(tmp, JSON.stringify(store, null, 2), {
		encoding: "utf-8",
		mode: 384
	});
	renameSync(tmp, file);
}
function recordToLinked(record, meta, providerId, defaultPriority) {
	return {
		id: record.id,
		providerId,
		label: meta?.label ?? record.label,
		source: record.source,
		enabled: meta?.enabled ?? true,
		priority: meta?.priority ?? defaultPriority,
		createdAt: record.createdAt,
		health: meta?.health ?? "ok",
		...record.lastUsedAt !== void 0 ? { lastUsedAt: record.lastUsedAt } : {},
		...meta?.healthDetail ? { healthDetail: meta.healthDetail } : {},
		...meta?.usage ? { usage: meta.usage } : {},
		...record.organizationId ? { organizationId: record.organizationId } : {},
		...record.userId ? { userId: record.userId } : {},
		...record.email ? { email: record.email } : {}
	};
}
function loadAllAccounts() {
	const subscriptionProviders = ["anthropic-subscription", "openai-codex"];
	const meta = readMetaStore();
	const out = {};
	for (const provider of subscriptionProviders) {
		const records = listProviderAccounts(provider);
		let priorityCounter = 0;
		const sorted = [...records].sort((a, b) => a.createdAt - b.createdAt);
		for (const record of sorted) {
			const providerMeta = meta[provider]?.[record.id];
			out[poolRecordKey(provider, record.id)] = recordToLinked(record, providerMeta, provider, priorityCounter);
			priorityCounter += 1;
		}
	}
	return out;
}
async function persistAccount(account) {
	if (!isPoolProviderId(account.providerId)) return;
	const store = readMetaStore();
	if (!store[account.providerId]) store[account.providerId] = {};
	store[account.providerId][account.id] = {
		label: account.label,
		enabled: account.enabled,
		priority: account.priority,
		health: account.health,
		...account.healthDetail ? { healthDetail: account.healthDetail } : {},
		...account.usage ? { usage: account.usage } : {}
	};
	writeMetaStore(store);
}
async function deleteAccountMeta(providerId, accountId) {
	const store = readMetaStore();
	const bucket = store[providerId];
	if (!bucket) return;
	if (!(accountId in bucket)) return;
	delete bucket[accountId];
	writeMetaStore(store);
}
/**
* Module-level singleton for the default pool wired against WS1's
* `account-storage` and the pool-owned metadata file. Plugins / runtime
* resolvers should import `getDefaultAccountPool()` rather than building
* a new pool. WS3 may later swap the default deps to read/write the
* `LinkedAccountsConfig` field directly out of `eliza.json`; consumers
* keep the same accessor.
*/
function getDefaultAccountPool() {
	if (!cachedDefaultPool) {
		cachedDefaultPool = new AccountPool({
			readAccounts: () => loadAllAccounts(),
			writeAccount: persistAccount,
			deleteAccount: deleteAccountMeta
		});
		installAnthropicShim(cachedDefaultPool);
		installOrchestratorShim(cachedDefaultPool);
		installSubscriptionSelectorShim(cachedDefaultPool);
	}
	return cachedDefaultPool;
}
/**
* Install the `globalThis`-keyed shim that plugin-anthropic's
* credential-store reads. Idempotent — repeated installs replace the
* previous shim.
*/
function installAnthropicShim(pool) {
	if (typeof globalThis === "undefined") return;
	const shim = {
		selectAnthropicSubscription: async (opts) => {
			const account = await pool.select({
				providerId: "anthropic-subscription",
				sessionKey: opts?.sessionKey,
				exclude: opts?.exclude
			});
			if (!account) return null;
			return {
				id: account.id,
				expiresAt: Number.POSITIVE_INFINITY
			};
		},
		getAccessToken: (providerId, accountId) => getAccessToken(providerId, accountId),
		markInvalid: (accountId, detail) => pool.markInvalid(accountId, detail),
		markRateLimited: (accountId, untilMs, detail) => pool.markRateLimited(accountId, untilMs, detail)
	};
	globalThis[ANTHROPIC_POOL_SHIM_SYMBOL] = shim;
}
function installOrchestratorShim(pool) {
	if (typeof globalThis === "undefined") return;
	const shim = {
		pickAnthropicTokenForSpawn: async ({ sessionKey }) => {
			const account = await pool.select({
				providerId: "anthropic-subscription",
				sessionKey
			});
			if (!account) return null;
			const token = await getAccessToken("anthropic-subscription", account.id);
			if (!token) return null;
			return {
				accessToken: token,
				accountId: account.id
			};
		},
		markRateLimited: (accountId, untilMs, detail) => {
			pool.markRateLimited(accountId, untilMs, detail);
		},
		markInvalid: (accountId, detail) => {
			pool.markInvalid(accountId, detail);
		},
		markNeedsReauth: (accountId, detail) => {
			pool.markNeedsReauth(accountId, detail);
		}
	};
	globalThis[ORCHESTRATOR_POOL_SHIM_SYMBOL] = shim;
}
function installSubscriptionSelectorShim(pool) {
	if (typeof globalThis === "undefined") return;
	const shim = { pickAccountId: async (providerId) => {
		return (await pool.select({ providerId }))?.id ?? null;
	} };
	globalThis[SUBSCRIPTION_SELECTOR_SHIM_SYMBOL] = shim;
}
var DEFAULT_RATE_LIMIT_BACKOFF_MS, QUOTA_AWARE_SKIP_PCT, SESSION_AFFINITY_MAX_ATTEMPTS, AccountPool, ANTHROPIC_POOL_SHIM_SYMBOL, ORCHESTRATOR_POOL_SHIM_SYMBOL, SUBSCRIPTION_SELECTOR_SHIM_SYMBOL, cachedDefaultPool;
var init_account_pool = __esmMin((() => {
	init_account_usage();
	DEFAULT_RATE_LIMIT_BACKOFF_MS = 6e4;
	QUOTA_AWARE_SKIP_PCT = 85;
	SESSION_AFFINITY_MAX_ATTEMPTS = 3;
	AccountPool = class {
		deps;
		affinity = /* @__PURE__ */ new Map();
		roundRobinCursor = /* @__PURE__ */ new Map();
		constructor(deps) {
			this.deps = deps;
		}
		async select(input) {
			const all = this.deps.readAccounts();
			const eligible = this.filterEligible(all, input);
			if (eligible.length === 0) return null;
			if (input.sessionKey) {
				const cached = this.affinity.get(input.sessionKey);
				if (cached && cached.attempts < SESSION_AFFINITY_MAX_ATTEMPTS && eligible.some((a) => a.id === cached.accountId)) {
					cached.attempts += 1;
					const account = eligible.find((a) => a.id === cached.accountId);
					if (account) return account;
				}
			}
			const strategy = input.strategy ?? "priority";
			const picked = this.applyStrategy(strategy, eligible, input.providerId);
			if (!picked) return null;
			if (input.sessionKey) this.affinity.set(input.sessionKey, {
				accountId: picked.id,
				attempts: 1
			});
			return picked;
		}
		filterEligible(all, input) {
			const exclude = new Set(input.exclude ?? []);
			const explicit = input.accountIds && input.accountIds.length > 0 ? new Set(input.accountIds) : null;
			const now = Date.now();
			return Object.values(all).filter((account) => {
				if (account.providerId !== input.providerId) return false;
				if (!account.enabled) return false;
				if (exclude.has(account.id)) return false;
				if (explicit && !explicit.has(account.id)) return false;
				if (account.health === "ok") return true;
				if (account.health === "rate-limited" && typeof account.healthDetail?.until === "number" && account.healthDetail.until < now) return true;
				return false;
			});
		}
		applyStrategy(strategy, eligible, providerId) {
			if (eligible.length === 0) return null;
			if (eligible.length === 1) return eligible[0] ?? null;
			switch (strategy) {
				case "round-robin": {
					const sorted = [...eligible].sort(byPriorityThenAge);
					const index = ((this.roundRobinCursor.get(providerId) ?? -1) + 1) % sorted.length;
					this.roundRobinCursor.set(providerId, index);
					return sorted[index] ?? null;
				}
				case "least-used": return [...eligible].sort(byLeastUsedThenPriority)[0] ?? null;
				case "quota-aware": {
					const underQuota = eligible.filter((a) => (a.usage?.sessionPct ?? 0) < QUOTA_AWARE_SKIP_PCT);
					return [...underQuota.length > 0 ? underQuota : eligible].sort(byPriorityThenAge)[0] ?? null;
				}
				default: return [...eligible].sort(byPriorityThenAge)[0] ?? null;
			}
		}
		list(providerId) {
			const all = Object.values(this.deps.readAccounts());
			if (!providerId) return all;
			return all.filter((a) => a.providerId === providerId);
		}
		get(accountId) {
			return findAccountById(this.deps.readAccounts(), accountId);
		}
		async upsert(account) {
			await this.deps.writeAccount(account);
		}
		async deleteMetadata(providerId, accountId) {
			if (!this.deps.deleteAccount) return;
			await this.deps.deleteAccount(providerId, accountId);
		}
		async recordCall(accountId, result) {
			const account = findAccountById(this.deps.readAccounts(), accountId);
			if (!account) return;
			recordCall(account.providerId, account.id, result);
			const next = {
				...account,
				lastUsedAt: Date.now()
			};
			await this.deps.writeAccount(next);
		}
		async refreshUsage(accountId, accessToken, opts) {
			const account = findAccountById(this.deps.readAccounts(), accountId);
			if (!account) return;
			let usage;
			if (account.providerId === "anthropic-subscription") usage = await pollAnthropicUsage(accessToken, opts?.fetch);
			else if (account.providerId === "openai-codex") {
				const codexAccountId = opts?.codexAccountId ?? account.organizationId;
				if (!codexAccountId) throw new Error(`[AccountPool] Codex usage probe needs the OpenAI account_id (account ${accountId} has no organizationId).`);
				usage = await pollCodexUsage(accessToken, codexAccountId, opts?.fetch);
			} else return;
			await this.deps.writeAccount({
				...account,
				health: "ok",
				usage
			});
		}
		async markRateLimited(accountId, untilMs, detail) {
			const account = findAccountById(this.deps.readAccounts(), accountId);
			if (!account) return;
			const healthDetail = {
				until: Number.isFinite(untilMs) && untilMs > Date.now() ? untilMs : Date.now() + DEFAULT_RATE_LIMIT_BACKOFF_MS,
				lastChecked: Date.now(),
				...detail ? { lastError: detail } : {}
			};
			await this.deps.writeAccount({
				...account,
				health: "rate-limited",
				healthDetail
			});
		}
		async markNeedsReauth(accountId, detail) {
			const account = findAccountById(this.deps.readAccounts(), accountId);
			if (!account) return;
			await this.deps.writeAccount({
				...account,
				health: "needs-reauth",
				healthDetail: {
					lastChecked: Date.now(),
					...detail ? { lastError: detail } : {}
				}
			});
		}
		async markInvalid(accountId, detail) {
			const account = findAccountById(this.deps.readAccounts(), accountId);
			if (!account) return;
			await this.deps.writeAccount({
				...account,
				health: "invalid",
				healthDetail: {
					lastChecked: Date.now(),
					...detail ? { lastError: detail } : {}
				}
			});
		}
		async markHealthy(accountId) {
			const account = findAccountById(this.deps.readAccounts(), accountId);
			if (!account) return;
			if (account.health === "ok") return;
			await this.deps.writeAccount({
				...account,
				health: "ok",
				...account.healthDetail ? { healthDetail: void 0 } : {}
			});
		}
		/**
		* Re-probe accounts whose `health` is non-OK and whose `healthDetail.until`
		* has passed (or is absent). Used by background sweepers to recover
		* temporarily flagged accounts. We don't load access tokens here — the
		* caller probes via `refreshUsage` separately.
		*/
		async reprobeFlagged() {
			const all = this.deps.readAccounts();
			const now = Date.now();
			const ready = [];
			for (const account of Object.values(all)) {
				if (account.health === "ok") continue;
				if (account.health === "rate-limited") {
					const until = account.healthDetail?.until;
					if (typeof until === "number" && until > now) continue;
				}
				ready.push(account.id);
			}
			return ready;
		}
	};
	ANTHROPIC_POOL_SHIM_SYMBOL = Symbol.for("eliza.account-pool.anthropic.v1");
	ORCHESTRATOR_POOL_SHIM_SYMBOL = Symbol.for("eliza.account-pool.orchestrator.v1");
	SUBSCRIPTION_SELECTOR_SHIM_SYMBOL = Symbol.for("eliza.account-pool.subscription-selector.v1");
	cachedDefaultPool = null;
}));

//#endregion
//#region node_modules/.bun/@elizaos+app-core@2.0.0-alpha.537+72829346cb4c43b1/node_modules/@elizaos/app-core/packages/app-core/src/api/credential-resolver.js
/**
* Server-side credential resolver — scans local credential stores
* and hydrates credentials into the canonical server config + secret state.
*
* Credential sources:
*   1. Claude Code OAuth → ~/.claude/.credentials.json or macOS Keychain
*      (uses subscription auth flow, NOT direct api.anthropic.com)
*   2. OpenAI Codex → ~/.codex/auth.json
*   3. Environment variables → process.env
*
* The OAuth token from Claude Code is an "anthropic-subscription" credential
* that goes through applySubscriptionCredentials(), not a direct API key.
*/
function readJsonSafe(filePath) {
	try {
		if (!fs.existsSync(filePath)) return null;
		return JSON.parse(fs.readFileSync(filePath, "utf8"));
	} catch {
		return null;
	}
}
function extractOauthAccessToken(value) {
	if (!value || typeof value !== "object" || Array.isArray(value)) return null;
	const record = value;
	const direct = record.accessToken ?? record.access_token;
	if (typeof direct === "string" && direct.trim()) return direct.trim();
	for (const v of Object.values(record)) if (v && typeof v === "object") {
		const token = extractOauthAccessToken(v);
		if (token) return token;
	}
	return null;
}
function readKeychainValue(service) {
	if (process.platform !== "darwin") return null;
	try {
		const trimmed = execFileSync("security", [
			"find-generic-password",
			"-s",
			service,
			"-w"
		], {
			encoding: "utf8",
			timeout: 3e3,
			stdio: [
				"pipe",
				"pipe",
				"pipe"
			]
		}).trim();
		return trimmed.length > 0 ? trimmed : null;
	} catch {
		return null;
	}
}
/** Resolve Claude OAuth token — this is a SUBSCRIPTION token, not a direct API key. */
function resolveClaudeOAuthToken() {
	const home = os.homedir();
	const fileToken = extractOauthAccessToken(readJsonSafe(path.join(home, ".claude", ".credentials.json")));
	if (fileToken) return fileToken;
	const keychainData = readKeychainValue("Claude Code-credentials");
	if (!keychainData) return null;
	try {
		return extractOauthAccessToken(JSON.parse(keychainData));
	} catch {
		return keychainData;
	}
}
/** Resolve OpenAI API key from Codex auth file. */
function resolveCodexApiKey() {
	return readJsonSafe(path.join(os.homedir(), ".codex", "auth.json"))?.OPENAI_API_KEY?.trim() || null;
}
/**
* Resolve the real credential for a specific provider.
*/
function resolveProviderCredential(providerId) {
	for (const source of CREDENTIAL_SOURCES) {
		if (source.providerId !== providerId) continue;
		const key = source.resolve();
		if (key) {
			logger.info(`[credential-resolver] Resolved ${source.envVar} for ${providerId} (${key.length} chars, ${source.authType})`);
			return {
				providerId: source.providerId,
				envVar: source.envVar,
				apiKey: key,
				authType: source.authType
			};
		}
	}
	return null;
}
var CREDENTIAL_SOURCES;
var init_credential_resolver = __esmMin((() => {
	init_account_pool();
	CREDENTIAL_SOURCES = [
		{
			providerId: "anthropic-subscription",
			envVar: "ANTHROPIC_API_KEY",
			authType: "subscription",
			resolve: resolveClaudeOAuthToken
		},
		{
			providerId: "anthropic",
			envVar: "ANTHROPIC_API_KEY",
			authType: "api-key",
			resolve: () => process.env.ANTHROPIC_API_KEY?.trim() || null
		},
		{
			providerId: "openai",
			envVar: "OPENAI_API_KEY",
			authType: "api-key",
			resolve: () => resolveCodexApiKey() || process.env.OPENAI_API_KEY?.trim() || null
		},
		{
			providerId: "groq",
			envVar: "GROQ_API_KEY",
			authType: "api-key",
			resolve: () => process.env.GROQ_API_KEY?.trim() || null
		},
		{
			providerId: "gemini",
			envVar: "GOOGLE_GENERATIVE_AI_API_KEY",
			authType: "api-key",
			resolve: () => process.env.GOOGLE_GENERATIVE_AI_API_KEY?.trim() || process.env.GOOGLE_API_KEY?.trim() || null
		},
		{
			providerId: "openrouter",
			envVar: "OPENROUTER_API_KEY",
			authType: "api-key",
			resolve: () => process.env.OPENROUTER_API_KEY?.trim() || null
		},
		{
			providerId: "grok",
			envVar: "XAI_API_KEY",
			authType: "api-key",
			resolve: () => process.env.XAI_API_KEY?.trim() || null
		},
		{
			providerId: "deepseek",
			envVar: "DEEPSEEK_API_KEY",
			authType: "api-key",
			resolve: () => process.env.DEEPSEEK_API_KEY?.trim() || null
		},
		{
			providerId: "mistral",
			envVar: "MISTRAL_API_KEY",
			authType: "api-key",
			resolve: () => process.env.MISTRAL_API_KEY?.trim() || null
		},
		{
			providerId: "together",
			envVar: "TOGETHER_API_KEY",
			authType: "api-key",
			resolve: () => process.env.TOGETHER_API_KEY?.trim() || null
		},
		{
			providerId: "zai",
			envVar: "ZAI_API_KEY",
			authType: "api-key",
			resolve: () => process.env.ZAI_API_KEY?.trim() || null
		}
	];
}));

//#endregion
//#region node_modules/.bun/@elizaos+app-core@2.0.0-alpha.537+72829346cb4c43b1/node_modules/@elizaos/app-core/packages/app-core/src/api/server-onboarding-compat.js
/**
* Onboarding compat helpers — API key persistence, onboarding defaults,
* cloud-mode detection, and cloud-provisioned container detection.
*/
/** Resolve the API token using app-first priority. */
function getCompatApiToken() {
	const token = process.env.ELIZA_API_TOKEN?.trim();
	return token ? token : null;
}
function trimToUndefined(value) {
	if (typeof value !== "string") return;
	const trimmed = value.trim();
	return trimmed.length > 0 ? trimmed : void 0;
}
function resolveCompatOnboardingStyle(body, language) {
	const presets = getStylePresets(language);
	const requestedPresetId = trimToUndefined(body.presetId);
	if (requestedPresetId) {
		const byId = presets.find((preset) => preset.id === requestedPresetId);
		if (byId) return byId;
	}
	if (typeof body.avatarIndex === "number" && Number.isFinite(body.avatarIndex)) {
		const byAvatar = presets.find((preset) => preset.avatarIndex === Number(body.avatarIndex));
		if (byAvatar) return byAvatar;
	}
	const requestedName = trimToUndefined(body.name);
	if (requestedName) {
		const byName = presets.find((preset) => preset.name === requestedName);
		if (byName) return byName;
	}
	return getDefaultStylePreset(language);
}
function hasLegacyOnboardingRequestFields(body) {
	return LEGACY_ONBOARDING_REQUEST_KEYS.some((key) => Object.hasOwn(body, key));
}
/**
* Extract canonical onboarding credential inputs from an onboarding request body
* and persist them to config + process.env. Returns the env key name if a local
* provider API key was persisted, or null.
*/
async function extractAndPersistOnboardingApiKey(body) {
	const credentialInputs = normalizeOnboardingCredentialInputs(body.credentialInputs);
	const explicitDeploymentTarget = normalizeDeploymentTargetConfig(body.deploymentTarget);
	const explicitServiceRouting = normalizeServiceRoutingConfig(body.serviceRouting);
	logger.info(`[onboarding] extractAndPersistOnboardingApiKey: credentialInputs=${credentialInputs ? "present" : "missing"}, keys=${Object.keys(body).join(",")}`);
	const initialPlan = deriveOnboardingCredentialPersistencePlan({
		credentialInputs,
		deploymentTarget: explicitDeploymentTarget,
		serviceRouting: explicitServiceRouting
	});
	let effectiveCredentialInputs = credentialInputs;
	let effectiveServiceRouting = explicitServiceRouting;
	let llmSelection = initialPlan.llmSelection;
	if (!llmSelection && !initialPlan.cloudApiKey) {
		logger.warn("[onboarding] No onboarding credentials resolved from request body");
		return null;
	}
	logger.info(`[onboarding] Resolved selection: transport=${llmSelection?.transport ?? "none"}, provider=${llmSelection?.backend ?? "N/A"}, hasKey=${Boolean(llmSelection?.apiKey)}, hasCloudKey=${Boolean(initialPlan.cloudApiKey)}`);
	if (llmSelection?.transport === "direct" && llmSelection.backend !== "elizacloud" && !llmSelection.apiKey?.startsWith("****")) {
		const resolved = resolveProviderCredential(llmSelection.backend);
		if (resolved && resolved.authType === "subscription") {
			effectiveCredentialInputs = {
				...effectiveCredentialInputs ?? {},
				llmApiKey: resolved.apiKey
			};
			effectiveServiceRouting = normalizeServiceRoutingConfig({
				...effectiveServiceRouting ?? {},
				llmText: {
					...effectiveServiceRouting?.llmText ?? {},
					backend: resolved.providerId,
					transport: "direct"
				}
			});
			logger.info(`[onboarding] Using subscription auth for ${resolved.providerId}`);
		} else if (resolved) {
			effectiveCredentialInputs = {
				...effectiveCredentialInputs ?? {},
				llmApiKey: resolved.apiKey
			};
			logger.info(`[onboarding] Resolved real key for ${llmSelection.backend} via credential-resolver`);
		} else if (!llmSelection.apiKey) {
			logger.warn(`[onboarding] No key found for ${llmSelection.backend} — cannot persist`);
			return null;
		}
		llmSelection = deriveOnboardingCredentialPersistencePlan({
			credentialInputs: effectiveCredentialInputs,
			deploymentTarget: explicitDeploymentTarget,
			serviceRouting: effectiveServiceRouting
		}).llmSelection;
	}
	const config = loadElizaConfig();
	const result = await applyOnboardingCredentialPersistence(config, {
		credentialInputs: effectiveCredentialInputs,
		deploymentTarget: explicitDeploymentTarget,
		serviceRouting: effectiveServiceRouting
	});
	saveElizaConfig(config);
	if (result) logger.info(`[onboarding] Persisted ${result} from onboarding credentials`);
	return result;
}
function persistCompatOnboardingDefaults(body) {
	const name = typeof body.name === "string" ? body.name.trim() : "";
	if (!name) return null;
	const config = loadElizaConfig();
	const language = normalizeCharacterLanguage(body.language);
	const stylePreset = resolveCompatOnboardingStyle(body, language);
	if (!config.agents || typeof config.agents !== "object") config.agents = {};
	const agents = config.agents;
	if (!agents.defaults || typeof agents.defaults !== "object") agents.defaults = {};
	const adminEntityId = stringToUuid(`${name}-admin-entity`);
	agents.defaults.adminEntityId = adminEntityId;
	if (!Array.isArray(agents.list) || agents.list.length === 0) agents.list = [{
		id: "main",
		default: true
	}];
	const agentEntry = agents.list[0];
	agentEntry.name = name;
	if (Array.isArray(body.bio)) agentEntry.bio = body.bio;
	if (typeof body.systemPrompt === "string" && body.systemPrompt.trim()) agentEntry.system = body.systemPrompt.trim();
	if (body.style && typeof body.style === "object") agentEntry.style = body.style;
	if (Array.isArray(body.adjectives)) agentEntry.adjectives = body.adjectives;
	if (Array.isArray(body.topics)) agentEntry.topics = body.topics;
	if (Array.isArray(body.postExamples)) agentEntry.postExamples = body.postExamples;
	if (Array.isArray(body.messageExamples)) agentEntry.messageExamples = body.messageExamples;
	if (!config.ui || typeof config.ui !== "object") config.ui = {};
	const ui = config.ui;
	ui.assistant = {
		...ui.assistant && typeof ui.assistant === "object" ? ui.assistant : {},
		name
	};
	ui.language = language;
	if (typeof body.avatarIndex === "number" && Number.isFinite(body.avatarIndex)) ui.avatarIndex = Number(body.avatarIndex);
	else if (typeof stylePreset?.avatarIndex === "number") ui.avatarIndex = stylePreset.avatarIndex;
	if (trimToUndefined(body.presetId)) ui.presetId = trimToUndefined(body.presetId);
	else if (stylePreset?.id) ui.presetId = stylePreset.id;
	const elevenLabsApiKey = process.env.ELEVENLABS_API_KEY?.trim();
	const voicePresetId = stylePreset?.voicePresetId?.trim();
	const voiceId = voicePresetId ? ELEVENLABS_VOICE_ID_BY_PRESET.get(voicePresetId) : void 0;
	if (elevenLabsApiKey && voiceId) {
		if (!config.messages || typeof config.messages !== "object") config.messages = {};
		const messages = config.messages;
		const existingTts = messages.tts && typeof messages.tts === "object" ? messages.tts : {};
		const existingElevenlabs = existingTts.elevenlabs && typeof existingTts.elevenlabs === "object" ? existingTts.elevenlabs : {};
		messages.tts = {
			...existingTts,
			provider: "elevenlabs",
			elevenlabs: {
				...existingElevenlabs,
				voiceId,
				modelId: typeof existingElevenlabs.modelId === "string" && existingElevenlabs.modelId.trim() ? existingElevenlabs.modelId.trim() : DEFAULT_ELEVENLABS_TTS_MODEL
			}
		};
	}
	migrateLegacyRuntimeConfig(config);
	saveElizaConfig(config);
	return adminEntityId;
}
function deriveCompatOnboardingReplayBody(body) {
	const explicitDeploymentTarget = normalizeDeploymentTargetConfig(body.deploymentTarget);
	const explicitCredentialInputs = normalizeOnboardingCredentialInputs(body.credentialInputs);
	const deploymentTarget = explicitDeploymentTarget ?? void 0;
	const linkedAccounts = normalizeLinkedAccountFlagsConfig(body.linkedAccounts) ?? void 0;
	const serviceRouting = normalizeServiceRoutingConfig(body.serviceRouting) ?? void 0;
	const isCloudMode = deploymentTarget?.runtime === "cloud";
	const replayBody = { ...body };
	for (const key of LEGACY_ONBOARDING_REQUEST_KEYS) delete replayBody[key];
	if (deploymentTarget) replayBody.deploymentTarget = deploymentTarget;
	if (linkedAccounts) replayBody.linkedAccounts = linkedAccounts;
	if (serviceRouting) replayBody.serviceRouting = serviceRouting;
	if (explicitCredentialInputs) replayBody.credentialInputs = explicitCredentialInputs;
	return {
		isCloudMode,
		replayBody
	};
}
/**
* Check if this is a cloud-provisioned container.
*
* METADATA-ONLY as of P0 of the remote-auth hardening. This function now
* exists strictly so unrelated routes (e.g. `/api/cloud/status`) can branch
* on cloud-provisioned shape. It does NOT authorise anything: callers must
* still pass through `ensureCompatApiAuthorized` (legacy bearer) or — once
* the dashboard mints sessions — `ensureAuthSessionOrBootstrap`. The
* audited bypasses at `auth-pairing-compat-routes.ts:124,140` and the
* onboarding-skip used to read this; both have been removed.
*
* See `docs/security/remote-auth-hardening-plan.md` §3.4.
*/
function isCloudProvisioned() {
	const hasCloudFlag = process.env.ELIZA_CLOUD_PROVISIONED === "1";
	const hasCloudApiKeyProvisioning = process.env.ELIZAOS_CLOUD_ENABLED === "true" && Boolean(process.env.ELIZAOS_CLOUD_API_KEY?.trim());
	const hasPlatformToken = Boolean(process.env.STEWARD_AGENT_TOKEN?.trim() || getCompatApiToken() || hasCloudApiKeyProvisioning);
	return hasCloudFlag && hasPlatformToken;
}
var DEFAULT_ELEVENLABS_TTS_MODEL, ELEVENLABS_VOICE_ID_BY_PRESET, LEGACY_ONBOARDING_REQUEST_KEYS;
var init_server_onboarding_compat = __esmMin((() => {
	init_types();
	init_credential_resolver();
	DEFAULT_ELEVENLABS_TTS_MODEL = "eleven_flash_v2_5";
	ELEVENLABS_VOICE_ID_BY_PRESET = new Map(PREMADE_VOICES.map((voice) => [voice.id, voice.voiceId]));
	LEGACY_ONBOARDING_REQUEST_KEYS = [
		"connection",
		"runMode",
		"cloudProvider",
		"provider",
		"providerApiKey",
		"primaryModel",
		"smallModel",
		"largeModel"
	];
}));

//#endregion
//#region node_modules/.bun/@elizaos+app-core@2.0.0-alpha.537+72829346cb4c43b1/node_modules/@elizaos/app-core/packages/app-core/src/api/auth-pairing-compat-routes.js
var auth_pairing_compat_routes_exports = /* @__PURE__ */ __exportAll({
	_resetAuthPairingStateForTests: () => _resetAuthPairingStateForTests,
	ensureAuthPairingCodeForRemoteAccess: () => ensureAuthPairingCodeForRemoteAccess,
	handleAuthPairingCompatRoutes: () => handleAuthPairingCompatRoutes
});
function _resetAuthPairingStateForTests() {
	pairingCode = null;
	pairingExpiresAt = 0;
	pairingAttempts.clear();
}
function pairingEnabled() {
	return Boolean(getCompatApiToken$1()) && process.env.ELIZA_PAIRING_DISABLED !== "1" && !isCloudProvisioned();
}
function normalizePairingCode(code) {
	return code.replace(/[^a-zA-Z0-9]/g, "").toUpperCase();
}
function generatePairingCode() {
	let raw = "";
	for (let i = 0; i < 12; i += 1) raw += PAIRING_ALPHABET[crypto.randomInt(0, 32)];
	return `${raw.slice(0, 4)}-${raw.slice(4, 8)}-${raw.slice(8, 12)}`;
}
function ensurePairingCode() {
	if (!pairingEnabled()) return null;
	const now = Date.now();
	if (!pairingCode || now > pairingExpiresAt) {
		pairingCode = generatePairingCode();
		pairingExpiresAt = now + PAIRING_TTL_MS;
		logger.warn(`[api] Pairing code for remote devices: ${pairingCode} (valid for 10 minutes)`);
	}
	return pairingCode;
}
function ensureAuthPairingCodeForRemoteAccess() {
	const code = ensurePairingCode();
	return code ? {
		code,
		expiresAt: pairingExpiresAt
	} : null;
}
async function requestHasActiveSession(req, store) {
	const cookieSessionId = parseSessionCookie(req);
	if (cookieSessionId) {
		if (await findActiveSession(store, cookieSessionId).catch(() => null)) return true;
	}
	const bearer = getProvidedApiToken(req);
	if (bearer) {
		if (await findActiveSession(store, bearer).catch(() => null)) return true;
	}
	return false;
}
function rateLimitPairing(ip) {
	const key = ip ?? "unknown";
	const now = Date.now();
	const current = pairingAttempts.get(key);
	if (!current || now > current.resetAt) {
		pairingAttempts.set(key, {
			count: 1,
			resetAt: now + PAIRING_WINDOW_MS
		});
		return true;
	}
	if (current.count >= PAIRING_MAX_ATTEMPTS) return false;
	current.count += 1;
	return true;
}
/**
* Auth / pairing routes:
*
* - `GET  /api/onboarding/status`
* - `GET  /api/auth/status`
* - `POST /api/auth/pair`
*/
async function handleAuthPairingCompatRoutes(req, res, state) {
	const method = (req.method ?? "GET").toUpperCase();
	const url = new URL(req.url ?? "/", "http://localhost");
	if (method === "GET" && url.pathname === "/api/onboarding/status") {
		if (!await ensureRouteAuthorized(req, res, state)) return true;
		sendJson$2(res, 200, {
			complete: hasCompatPersistedOnboardingState(loadElizaConfig()),
			cloudProvisioned: isCloudProvisioned()
		});
		return true;
	}
	if (method === "GET" && url.pathname === "/api/auth/status") {
		const localAccess = isTrustedLocalRequest(req);
		const db = getCompatDrizzleDb(state);
		let passwordConfigured = false;
		let sessionAuthenticated = false;
		if (db) {
			const { AuthStore } = await Promise.resolve().then(() => (init_auth_store(), auth_store_exports));
			const store = new AuthStore(db);
			const owner = (await store.listIdentitiesByKind("owner"))[0];
			passwordConfigured = Boolean(owner?.passwordHash);
			sessionAuthenticated = await requestHasActiveSession(req, store);
		}
		const cloudProvisioned = isCloudProvisioned();
		const tokenRequired = Boolean(getCompatApiToken$1());
		const loginRequired = !localAccess && !tokenRequired && !cloudProvisioned;
		const providedToken = getProvidedApiToken(req);
		const configuredToken = getCompatApiToken$1();
		const staticTokenAuthenticated = !cloudProvisioned && Boolean(providedToken && configuredToken && tokenMatches(configuredToken, providedToken));
		const authenticated = sessionAuthenticated || staticTokenAuthenticated;
		const required = !localAccess && !authenticated && (tokenRequired || passwordConfigured || cloudProvisioned || loginRequired);
		const enabled = pairingEnabled();
		if (enabled) ensurePairingCode();
		sendJson$2(res, 200, {
			required,
			authenticated,
			loginRequired,
			bootstrapRequired: required && cloudProvisioned,
			localAccess,
			passwordConfigured,
			pairingEnabled: enabled,
			expiresAt: enabled ? pairingExpiresAt : null
		});
		return true;
	}
	if (method === "POST" && url.pathname === "/api/auth/pair") {
		const body = await readCompatJsonBody(req, res);
		if (body == null) return true;
		const token = getCompatApiToken$1();
		if (!token) {
			sendJsonError(res, 400, "Pairing not enabled");
			return true;
		}
		if (!pairingEnabled()) {
			sendJsonError(res, 403, "Pairing disabled");
			return true;
		}
		const remoteAddress = req.socket.remoteAddress;
		if (!remoteAddress) {
			sendJsonError(res, 403, "Cannot determine client address");
			return true;
		}
		if (!rateLimitPairing(remoteAddress)) {
			sendJsonError(res, 429, "Too many attempts. Try again later.");
			return true;
		}
		const provided = normalizePairingCode(typeof body.code === "string" ? body.code : "");
		const current = ensurePairingCode();
		if (!current || Date.now() > pairingExpiresAt) {
			ensurePairingCode();
			sendJsonError(res, 410, "Pairing code expired. Check server logs for a new code.");
			return true;
		}
		if (!tokenMatches(normalizePairingCode(current), provided)) {
			sendJsonError(res, 403, "Invalid pairing code");
			return true;
		}
		pairingCode = null;
		pairingExpiresAt = 0;
		sendJson$2(res, 200, { token });
		return true;
	}
	return false;
}
var PAIRING_TTL_MS, PAIRING_WINDOW_MS, PAIRING_MAX_ATTEMPTS, PAIRING_ALPHABET, pairingCode, pairingExpiresAt, pairingAttempts, pairingSweepTimer;
var init_auth_pairing_compat_routes = __esmMin((() => {
	init_auth$1();
	init_sessions();
	init_compat_route_shared();
	init_response();
	init_server_onboarding_compat();
	PAIRING_TTL_MS = 600 * 1e3;
	PAIRING_WINDOW_MS = 600 * 1e3;
	PAIRING_MAX_ATTEMPTS = 5;
	PAIRING_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
	pairingCode = null;
	pairingExpiresAt = 0;
	pairingAttempts = /* @__PURE__ */ new Map();
	pairingSweepTimer = setInterval(() => {
		const now = Date.now();
		for (const [key, entry] of pairingAttempts) if (now > entry.resetAt) pairingAttempts.delete(key);
	}, 300 * 1e3);
	if (typeof pairingSweepTimer === "object" && "unref" in pairingSweepTimer) pairingSweepTimer.unref();
}));

//#endregion
//#region node_modules/.bun/@elizaos+app-core@2.0.0-alpha.537+72829346cb4c43b1/node_modules/@elizaos/app-core/packages/app-core/src/api/auth-session-routes.js
/**
* Session lifecycle routes for password and cookie auth.
*
*   POST /api/auth/setup            — first-run owner identity + password
*   POST /api/auth/login/password   — password login → session cookie
*   POST /api/auth/logout           — destroy current session
*   GET  /api/auth/me               — current identity + session
*   GET  /api/auth/sessions         — list active sessions for identity
*   POST /api/auth/sessions/:id/revoke — revoke one session
*
* Hard rules:
*   - Every write path is rate-limited via the auth bucket in `auth.ts`.
*   - Every write path emits an audit event (success or failure) before
*     returning.
*   - Setup is one-shot — once an owner identity exists, /setup returns 409.
*   - Logout uses the auth context to find the session id; we do NOT trust
*     the body.
*/
function getDrizzleDb(state) {
	const runtime = state.current;
	if (!runtime) return null;
	const adapter = runtime.adapter;
	if (!adapter?.db) return null;
	return adapter.db;
}
function isValidDisplayName(value) {
	return typeof value === "string" && DISPLAY_NAME_RE.test(value.trim());
}
function consumeAuthBucket(ip, now = Date.now()) {
	const key = ip ?? "unknown";
	const entry = sessionRouteAttempts.get(key);
	if (!entry || now > entry.resetAt) {
		sessionRouteAttempts.set(key, {
			count: 1,
			resetAt: now + AUTH_ATTEMPT_WINDOW_MS
		});
		return true;
	}
	if (entry.count >= AUTH_ATTEMPT_MAX) return false;
	entry.count += 1;
	return true;
}
function setSessionCookies(res, session) {
	res.setHeader("set-cookie", [serializeSessionCookie(session), serializeCsrfCookie(session)]);
}
function clearSessionCookies(res) {
	res.setHeader("set-cookie", [serializeSessionExpiryCookie(), serializeCsrfExpiryCookie()]);
}
/**
* Dispatch table for the session routes. Returns true when a route
* matched and the response was sent; false to fall through to the rest of
* the API surface.
*/
async function handleAuthSessionRoutes(req, res, state) {
	const method = (req.method ?? "GET").toUpperCase();
	const url = new URL(req.url ?? "/", "http://localhost");
	if (!url.pathname.startsWith("/api/auth/")) return false;
	const db = getDrizzleDb(state);
	if (!db) {
		if (url.pathname === "/api/auth/setup" || url.pathname === "/api/auth/login/password" || url.pathname === "/api/auth/password/change" || url.pathname === "/api/auth/logout" || url.pathname === "/api/auth/me" || url.pathname === "/api/auth/sessions" || url.pathname.startsWith("/api/auth/sessions/")) {
			sendJson$2(res, 503, {
				error: "db_unavailable",
				reason: "db_unavailable"
			});
			return true;
		}
		return false;
	}
	const store = new AuthStore(db);
	const ip = req.socket?.remoteAddress ?? null;
	const userAgent = extractHeaderValue(req.headers["user-agent"]);
	if (method === "POST" && url.pathname === "/api/auth/setup") return await handleSetup(req, res, store, {
		ip,
		userAgent
	});
	if (method === "POST" && url.pathname === "/api/auth/login/password") return await handleLoginPassword(req, res, store, {
		ip,
		userAgent
	});
	if (method === "POST" && url.pathname === "/api/auth/password/change") return await handleChangePassword(req, res, store, {
		ip,
		userAgent
	});
	if (method === "POST" && url.pathname === "/api/auth/logout") return await handleLogout(req, res, store, {
		ip,
		userAgent
	});
	if (method === "GET" && url.pathname === "/api/auth/me") return await handleMe(req, res, store);
	if (method === "GET" && url.pathname === "/api/auth/sessions") return await handleListSessions(req, res, store);
	const revokeMatch = method === "POST" ? /^\/api\/auth\/sessions\/([^/]+)\/revoke$/.exec(url.pathname) : null;
	if (revokeMatch) return await handleRevoke(req, res, store, revokeMatch[1], {
		ip,
		userAgent
	});
	return false;
}
async function handleSetup(req, res, store, meta) {
	if (!consumeAuthBucket(meta.ip)) {
		sendJsonError(res, 429, "Too many requests");
		return true;
	}
	if (await store.hasOwnerIdentity()) {
		sendJson$2(res, 409, {
			error: "already_initialized",
			reason: "already_initialized"
		});
		return true;
	}
	const body = await readCompatJsonBody(req, res);
	if (body == null) return true;
	const password = typeof body.password === "string" ? body.password : "";
	const displayNameRaw = typeof body.displayName === "string" ? body.displayName.trim() : "";
	if (!isValidDisplayName(displayNameRaw)) {
		sendJsonError(res, 400, "invalid_display_name");
		return true;
	}
	try {
		assertPasswordStrong(password);
	} catch (err) {
		if (err instanceof WeakPasswordError) {
			sendJson$2(res, 400, {
				error: "weak_password",
				reason: err.reason
			});
			return true;
		}
		throw err;
	}
	const passwordHash = await hashPassword(password);
	const identityId = crypto.randomUUID();
	const now = Date.now();
	await store.createIdentity({
		id: identityId,
		kind: "owner",
		displayName: displayNameRaw,
		createdAt: now,
		passwordHash,
		cloudUserId: null
	});
	const { session, csrfToken } = await createBrowserSession(store, {
		identityId,
		ip: meta.ip,
		userAgent: meta.userAgent,
		rememberDevice: false,
		now
	});
	setSessionCookies(res, session);
	await markLegacyBearerInvalidated(store, {
		actorIdentityId: identityId,
		ip: meta.ip,
		userAgent: meta.userAgent
	}).catch((err) => {
		logger.error(`[auth] legacy invalidate audit failed: ${err instanceof Error ? err.message : String(err)}`);
	});
	await appendAuditEvent({
		actorIdentityId: identityId,
		ip: meta.ip,
		userAgent: meta.userAgent,
		action: "auth.setup",
		outcome: "success",
		metadata: { method: "password" }
	}, { store });
	sendJson$2(res, 200, {
		identity: {
			id: identityId,
			displayName: displayNameRaw,
			kind: "owner"
		},
		session: {
			id: session.id,
			kind: session.kind,
			expiresAt: session.expiresAt
		},
		csrfToken
	});
	return true;
}
async function handleLoginPassword(req, res, store, meta) {
	if (!consumeAuthBucket(meta.ip)) {
		sendJsonError(res, 429, "Too many requests");
		return true;
	}
	const body = await readCompatJsonBody(req, res);
	if (body == null) return true;
	const displayName = typeof body.displayName === "string" ? body.displayName.trim() : "";
	const password = typeof body.password === "string" ? body.password : "";
	const rememberDevice = body.rememberDevice === true;
	if (!isValidDisplayName(displayName) || password.length === 0) {
		await appendAuditEvent({
			actorIdentityId: null,
			ip: meta.ip,
			userAgent: meta.userAgent,
			action: "auth.login.password",
			outcome: "failure",
			metadata: { reason: "invalid_input" }
		}, { store });
		sendJsonError(res, 400, "invalid_credentials");
		return true;
	}
	const identity = await store.findIdentityByDisplayName(displayName);
	if (!identity?.passwordHash) {
		await appendAuditEvent({
			actorIdentityId: identity?.id ?? null,
			ip: meta.ip,
			userAgent: meta.userAgent,
			action: "auth.login.password",
			outcome: "failure",
			metadata: { reason: "unknown_identity" }
		}, { store });
		sendJsonError(res, 401, "invalid_credentials");
		return true;
	}
	let ok = false;
	try {
		ok = await verifyPassword(password, identity.passwordHash);
	} catch {
		ok = false;
	}
	if (!ok) {
		await appendAuditEvent({
			actorIdentityId: identity.id,
			ip: meta.ip,
			userAgent: meta.userAgent,
			action: "auth.login.password",
			outcome: "failure",
			metadata: { reason: "bad_password" }
		}, { store });
		sendJsonError(res, 401, "invalid_credentials");
		return true;
	}
	const now = Date.now();
	const { session, csrfToken } = await createBrowserSession(store, {
		identityId: identity.id,
		ip: meta.ip,
		userAgent: meta.userAgent,
		rememberDevice,
		now
	});
	setSessionCookies(res, session);
	await markLegacyBearerInvalidated(store, {
		actorIdentityId: identity.id,
		ip: meta.ip,
		userAgent: meta.userAgent
	}).catch((err) => {
		logger.error(`[auth] legacy invalidate audit failed: ${err instanceof Error ? err.message : String(err)}`);
	});
	await appendAuditEvent({
		actorIdentityId: identity.id,
		ip: meta.ip,
		userAgent: meta.userAgent,
		action: "auth.login.password",
		outcome: "success",
		metadata: { method: "password" }
	}, { store });
	sendJson$2(res, 200, {
		identity: {
			id: identity.id,
			displayName: identity.displayName,
			kind: identity.kind
		},
		session: {
			id: session.id,
			kind: session.kind,
			expiresAt: session.expiresAt
		},
		csrfToken
	});
	return true;
}
async function handleLogout(req, res, store, meta) {
	const sessionId = parseSessionCookie(req) ?? getProvidedApiToken(req) ?? null;
	if (!sessionId) {
		clearSessionCookies(res);
		sendJson$2(res, 200, { ok: true });
		return true;
	}
	const session = await findActiveSession(store, sessionId).catch(() => null);
	if (session) await revokeSession(session.id, {
		store,
		reason: "user_logout",
		actorIdentityId: session.identityId,
		ip: meta.ip,
		userAgent: meta.userAgent
	});
	clearSessionCookies(res);
	sendJson$2(res, 200, { ok: true });
	return true;
}
async function handleMe(req, res, store) {
	if (isTrustedLocalRequest(req)) {
		const owner = (await store.listIdentitiesByKind("owner"))[0] ?? null;
		sendJson$2(res, 200, {
			identity: owner ? {
				id: owner.id,
				displayName: owner.displayName,
				kind: owner.kind
			} : {
				id: "local-loopback",
				displayName: "Local",
				kind: "owner"
			},
			session: {
				id: "local-loopback",
				kind: "local",
				expiresAt: null
			},
			access: {
				mode: "local",
				passwordConfigured: Boolean(owner?.passwordHash),
				ownerConfigured: Boolean(owner)
			}
		});
		return true;
	}
	const ctx = await ensureSessionForRequest(req, res, {
		store,
		allowLegacyBearer: true,
		allowBootstrapBearer: false
	});
	if (ctx?.legacy && !ctx.session && !ctx.identity) {
		const owner = (await store.listIdentitiesByKind("owner"))[0] ?? null;
		sendJson$2(res, 200, {
			identity: owner ? {
				id: owner.id,
				displayName: owner.displayName,
				kind: owner.kind
			} : {
				id: "bearer",
				displayName: "API Token",
				kind: "machine"
			},
			session: {
				id: "bearer",
				kind: "machine",
				expiresAt: null
			},
			access: {
				mode: "bearer",
				passwordConfigured: Boolean(owner?.passwordHash),
				ownerConfigured: Boolean(owner)
			}
		});
		return true;
	}
	if (!ctx?.session || !ctx.identity) {
		const owner = (await store.listIdentitiesByKind("owner"))[0] ?? null;
		sendJson$2(res, 401, {
			error: "Unauthorized",
			reason: owner?.passwordHash ? "remote_auth_required" : "remote_password_not_configured",
			access: {
				mode: "remote",
				passwordConfigured: Boolean(owner?.passwordHash),
				ownerConfigured: Boolean(owner)
			}
		});
		return true;
	}
	sendJson$2(res, 200, {
		identity: {
			id: ctx.identity.id,
			displayName: ctx.identity.displayName,
			kind: ctx.identity.kind
		},
		session: {
			id: ctx.session.id,
			kind: ctx.session.kind,
			expiresAt: ctx.session.expiresAt
		},
		access: {
			mode: "session",
			passwordConfigured: Boolean(ctx.identity.passwordHash),
			ownerConfigured: true
		}
	});
	return true;
}
async function handleChangePassword(req, res, store, meta) {
	if (!consumeAuthBucket(meta.ip)) {
		sendJsonError(res, 429, "Too many requests");
		return true;
	}
	const body = await readCompatJsonBody(req, res);
	if (body == null) return true;
	const currentPassword = typeof body.currentPassword === "string" ? body.currentPassword : "";
	const newPassword = typeof body.newPassword === "string" ? body.newPassword : "";
	try {
		assertPasswordStrong(newPassword);
	} catch (err) {
		if (err instanceof WeakPasswordError) {
			sendJson$2(res, 400, {
				error: "weak_password",
				reason: err.reason
			});
			return true;
		}
		throw err;
	}
	const localAccess = isTrustedLocalRequest(req);
	const ctx = localAccess ? null : await ensureSessionForRequest(req, res, {
		store,
		allowLegacyBearer: false,
		allowBootstrapBearer: false
	});
	const identity = localAccess ? (await store.listIdentitiesByKind("owner"))[0] ?? null : ctx?.identity ?? null;
	if (!identity) {
		sendJsonError(res, 404, "owner_not_found");
		return true;
	}
	if (!localAccess) {
		if (!identity.passwordHash || currentPassword.length === 0) {
			sendJsonError(res, 401, "invalid_credentials");
			return true;
		}
		if (!await verifyPassword(currentPassword, identity.passwordHash)) {
			await appendAuditEvent({
				actorIdentityId: identity.id,
				ip: meta.ip,
				userAgent: meta.userAgent,
				action: "auth.password.change",
				outcome: "failure",
				metadata: { reason: "bad_current_password" }
			}, { store });
			sendJsonError(res, 401, "invalid_credentials");
			return true;
		}
	}
	const passwordHash = await hashPassword(newPassword);
	await store.updateIdentityPassword(identity.id, passwordHash);
	await appendAuditEvent({
		actorIdentityId: identity.id,
		ip: meta.ip,
		userAgent: meta.userAgent,
		action: "auth.password.change",
		outcome: "success",
		metadata: { localAccess }
	}, { store });
	sendJson$2(res, 200, { ok: true });
	return true;
}
async function handleListSessions(req, res, store) {
	if (isTrustedLocalRequest(req)) {
		const owner = (await store.listIdentitiesByKind("owner"))[0] ?? null;
		const sessions = owner ? await store.listSessionsForIdentity(owner.id) : [];
		sendJson$2(res, 200, { sessions: [{
			id: "local-loopback",
			kind: "local",
			ip: req.socket?.remoteAddress ?? "127.0.0.1",
			userAgent: extractHeaderValue(req.headers["user-agent"]),
			lastSeenAt: Date.now(),
			expiresAt: null,
			current: true
		}, ...sessions.map((s) => ({
			id: s.id,
			kind: s.kind,
			ip: s.ip,
			userAgent: s.userAgent,
			lastSeenAt: s.lastSeenAt,
			expiresAt: s.expiresAt,
			current: false
		}))] });
		return true;
	}
	const ctx = await ensureSessionForRequest(req, res, {
		store,
		allowLegacyBearer: false,
		allowBootstrapBearer: false
	});
	if (!ctx?.identity) {
		sendJsonError(res, 401, "Unauthorized");
		return true;
	}
	const sessions = await store.listSessionsForIdentity(ctx.identity.id);
	const currentId = ctx.session?.id ?? null;
	sendJson$2(res, 200, { sessions: sessions.map((s) => ({
		id: s.id,
		kind: s.kind,
		ip: s.ip,
		userAgent: s.userAgent,
		lastSeenAt: s.lastSeenAt,
		expiresAt: s.expiresAt,
		current: s.id === currentId
	})) });
	return true;
}
async function handleRevoke(req, res, store, targetSessionId, meta) {
	const ctx = await ensureSessionForRequest(req, res, {
		store,
		allowLegacyBearer: false,
		allowBootstrapBearer: false
	});
	if (!ctx?.identity) {
		sendJsonError(res, 401, "Unauthorized");
		return true;
	}
	const target = await store.findSession(targetSessionId).catch(() => null);
	if (!target || target.identityId !== ctx.identity.id) {
		sendJsonError(res, 404, "session_not_found");
		return true;
	}
	await revokeSession(targetSessionId, {
		store,
		reason: "user_revoke",
		actorIdentityId: ctx.identity.id,
		ip: meta.ip,
		userAgent: meta.userAgent
	});
	if (ctx.session && ctx.session.id === targetSessionId) clearSessionCookies(res);
	sendJson$2(res, 200, { ok: true });
	return true;
}
var DISPLAY_NAME_RE, AUTH_ATTEMPT_WINDOW_MS, AUTH_ATTEMPT_MAX, sessionRouteAttempts, sweepTimer;
var init_auth_session_routes = __esmMin((() => {
	init_auth_store();
	init_auth$1();
	init_auth();
	init_sessions();
	init_compat_route_shared();
	init_response();
	DISPLAY_NAME_RE = /^[A-Za-z0-9 _.\-@]{1,64}$/;
	AUTH_ATTEMPT_WINDOW_MS = 6e4;
	AUTH_ATTEMPT_MAX = 20;
	sessionRouteAttempts = /* @__PURE__ */ new Map();
	sweepTimer = setInterval(() => {
		const now = Date.now();
		for (const [k, v] of sessionRouteAttempts) if (now > v.resetAt) sessionRouteAttempts.delete(k);
	}, 300 * 1e3);
	if (typeof sweepTimer === "object" && "unref" in sweepTimer) sweepTimer.unref();
}));

//#endregion
//#region node_modules/.bun/@elizaos+app-core@2.0.0-alpha.537+72829346cb4c43b1/node_modules/@elizaos/app-core/packages/app-core/src/api/catalog-routes.js
function appEntryToRegistryAppInfo(entry) {
	const launchType = entry.launch.type === "server-launch" ? "server" : entry.launch.type;
	const packageName = entry.npmName ?? entry.id;
	const heroImage = entry.render.heroImage ?? resolveAppHeroImage(packageName, null);
	return {
		name: packageName,
		displayName: entry.name,
		description: entry.description ?? "",
		category: entry.subtype,
		launchType,
		launchUrl: entry.launch.url ?? null,
		icon: entry.render.icon ?? null,
		heroImage,
		capabilities: entry.launch.capabilities ?? [],
		stars: 0,
		repository: entry.resources.repository ?? "",
		latestVersion: entry.version ?? null,
		supports: entry.launch.supports ?? {
			v0: false,
			v1: false,
			v2: true
		},
		npm: entry.launch.npm ?? {
			package: entry.npmName ?? entry.id,
			v0Version: null,
			v1Version: null,
			v2Version: entry.version ?? null
		},
		viewer: entry.launch.viewer,
		uiExtension: entry.launch.uiExtension
	};
}
async function handleCatalogRoutes(req, res, state) {
	const method = (req.method ?? "GET").toUpperCase();
	const url = new URL(req.url ?? "/", "http://localhost");
	if (!url.pathname.startsWith("/api/catalog")) return false;
	if (method === "GET" && url.pathname === "/api/catalog/apps") {
		if (!await ensureRouteAuthorized(req, res, state)) return true;
		sendJson$2(res, 200, getApps(loadRegistry()).filter((a) => a.render.visible).map(appEntryToRegistryAppInfo));
		return true;
	}
	return false;
}
var init_catalog_routes = __esmMin((() => {
	init_registry$1();
	init_auth$1();
	init_response();
}));

//#endregion
//#region node_modules/.bun/@elizaos+app-core@2.0.0-alpha.537+72829346cb4c43b1/node_modules/@elizaos/app-core/packages/app-core/src/utils/errors.js
/**
* Shared error classification helpers.
*
* Consolidates the timeout detection pattern that was independently
* implemented in cloud-routes.ts and cloud-connection.ts.
*/
/** Classify an error as a fetch/AbortSignal timeout. */
function isTimeoutError(error) {
	if (!(error instanceof Error)) return false;
	if (error.name === "TimeoutError" || error.name === "AbortError") return true;
	const msg = error.message.toLowerCase();
	return msg.includes("timed out") || msg.includes("timeout");
}
var init_errors = __esmMin((() => {}));

//#endregion
//#region node_modules/.bun/@elizaos+app-core@2.0.0-alpha.537+72829346cb4c43b1/node_modules/@elizaos/app-core/packages/app-core/src/api/cloud-connection.js
function cloudCreditsHttpErrorMessage(status, creditResponse) {
	const err = creditResponse.error;
	if (typeof err === "string" && err.trim()) return err.trim();
	if (err && typeof err === "object" && "message" in err) {
		const msg = err.message;
		if (typeof msg === "string" && msg.trim()) return msg.trim();
	}
	return `HTTP ${status}`;
}
function asRuntimeCloud(runtime) {
	return runtime;
}
function getCloudAuth(runtime) {
	const runtimeWithServices = asRuntimeCloud(runtime);
	if (typeof runtimeWithServices?.getService !== "function") return null;
	const service = runtimeWithServices.getService("CLOUD_AUTH");
	return service && typeof service === "object" ? service : null;
}
function resolvePersistedCloudIdentity(runtime) {
	const runtimeWithCloud = asRuntimeCloud(runtime);
	return {
		organizationId: normalizeEnvValue(runtimeWithCloud?.getSetting?.("ELIZA_CLOUD_ORGANIZATION_ID")) ?? normalizeEnvValue(runtimeWithCloud?.character?.secrets?.ELIZA_CLOUD_ORGANIZATION_ID),
		userId: normalizeEnvValue(runtimeWithCloud?.getSetting?.("ELIZA_CLOUD_USER_ID")) ?? normalizeEnvValue(runtimeWithCloud?.character?.secrets?.ELIZA_CLOUD_USER_ID)
	};
}
function resolveCloudApiBaseUrl$1(rawBaseUrl) {
	return resolveCloudApiBaseUrl(rawBaseUrl ?? DEFAULT_CLOUD_API_BASE_URL) ?? DEFAULT_CLOUD_API_BASE_URL;
}
function resolveCloudApiKey(config, runtime) {
	migrateLegacyRuntimeConfig(config);
	const configApiKey = normalizeEnvValue(config.cloud?.apiKey);
	if (configApiKey) return configApiKey;
	if (!isCloudInferenceSelectedInConfig(config)) return;
	const sealedKey = normalizeEnvValue(getCloudSecret("ELIZAOS_CLOUD_API_KEY"));
	if (sealedKey) return sealedKey;
	const envKey = normalizeEnvValue(process.env.ELIZAOS_CLOUD_API_KEY);
	if (envKey) return envKey;
	const runtimeSettingKey = normalizeEnvValue(runtime?.getSetting?.("ELIZAOS_CLOUD_API_KEY"));
	if (runtimeSettingKey) return runtimeSettingKey;
	const runtimeKey = normalizeEnvValue(runtime?.character?.secrets?.ELIZAOS_CLOUD_API_KEY);
	if (runtimeKey) return runtimeKey;
}
function resolveCloudConnectionSnapshot(config, runtime) {
	migrateLegacyRuntimeConfig(config);
	config.cloud && typeof config.cloud === "object" && config.cloud;
	const enabled = isCloudInferenceSelectedInConfig(config);
	const apiKey = resolveCloudApiKey(config, runtime);
	const cloudAuth = getCloudAuth(runtime);
	const authConnected = Boolean(cloudAuth?.isAuthenticated?.());
	const hasApiKey = Boolean(apiKey);
	const persistedIdentity = resolvePersistedCloudIdentity(runtime);
	const shouldExposeIdentity = authConnected || hasApiKey;
	return {
		apiKey,
		authConnected,
		cloudAuth,
		connected: authConnected || hasApiKey,
		enabled,
		hasApiKey,
		organizationId: shouldExposeIdentity ? normalizeEnvValue(cloudAuth?.getOrganizationId?.()) ?? persistedIdentity.organizationId : void 0,
		userId: shouldExposeIdentity ? normalizeEnvValue(cloudAuth?.getUserId?.()) ?? persistedIdentity.userId : void 0
	};
}
/**
* Coerce an Eliza Cloud `balance` field into a number. The cloud API
* returns `balance` as `string | number` (per the Bridge client + config
* type definitions) — string when the upstream is using a fixed-precision
* decimal, number when it's been arithmetic'd. Treat both as the same
* dollar amount; reject anything else as an unexpected response.
*/
function coerceCloudBalance(value) {
	if (typeof value === "number" && Number.isFinite(value)) return value;
	if (typeof value === "string") {
		const trimmed = value.trim();
		if (!trimmed) return null;
		const parsed = Number.parseFloat(trimmed);
		return Number.isFinite(parsed) ? parsed : null;
	}
	return null;
}
async function fetchCloudCreditsByApiKey(baseUrl, apiKey) {
	const response = await fetch(`${baseUrl}/credits/balance`, {
		headers: {
			Accept: "application/json",
			Authorization: `Bearer ${apiKey}`
		},
		redirect: "manual",
		signal: AbortSignal.timeout(1e4)
	});
	if (response.status >= 300 && response.status < 400) throw new Error("Cloud credits request was redirected; redirects are not allowed");
	const creditResponse = await response.json().catch((err) => {
		console.warn("[cloud-connection] Failed to parse credit balance response JSON:", err);
		return {};
	});
	if (response.status === 401) throw new CloudCreditsAuthRejectedError(cloudCreditsHttpErrorMessage(401, creditResponse));
	if (!response.ok) throw new Error(cloudCreditsHttpErrorMessage(response.status, creditResponse));
	return coerceCloudBalance(creditResponse.balance) ?? coerceCloudBalance(creditResponse.data?.balance);
}
function withCreditFlags(balance) {
	return {
		connected: true,
		balance,
		low: balance < CREDIT_LOW_THRESHOLD,
		critical: balance < CREDIT_CRITICAL_THRESHOLD,
		topUpUrl: CLOUD_BILLING_URL
	};
}
async function fetchCloudCredits(config, runtime) {
	const snapshot = resolveCloudConnectionSnapshot(config, runtime);
	let authenticatedFailure = null;
	let authenticatedUnexpectedResponse = false;
	if (!snapshot.connected) return {
		balance: null,
		connected: false
	};
	const cloudClient = snapshot.cloudAuth?.getClient?.();
	if (snapshot.authConnected && typeof cloudClient?.get === "function") try {
		const creditResponse = await cloudClient.get("/credits/balance");
		const rawBalance = coerceCloudBalance(creditResponse?.balance) ?? coerceCloudBalance(creditResponse?.data?.balance);
		if (typeof rawBalance === "number") return withCreditFlags(rawBalance);
		authenticatedUnexpectedResponse = true;
		logger.debug(`[cloud/credits] Unexpected authenticated response shape: ${JSON.stringify(creditResponse)}`);
	} catch (err) {
		const msg = err instanceof Error ? err.message : "cloud API unreachable";
		authenticatedFailure = msg;
		logger.debug(`[cloud/credits] Authenticated balance fetch failed: ${msg}`);
	}
	if (!snapshot.apiKey) return {
		balance: null,
		connected: snapshot.connected,
		error: authenticatedFailure ?? (authenticatedUnexpectedResponse ? "unexpected response" : "missing cloud api key")
	};
	const resolvedBaseUrl = resolveCloudApiBaseUrl$1(config.cloud?.baseUrl);
	const baseUrlRejection = await validateCloudBaseUrl(resolvedBaseUrl);
	if (baseUrlRejection) return {
		balance: null,
		connected: true,
		error: baseUrlRejection
	};
	try {
		const balance = await fetchCloudCreditsByApiKey(resolvedBaseUrl, snapshot.apiKey);
		if (typeof balance !== "number") return {
			balance: null,
			connected: true,
			error: "unexpected response"
		};
		return withCreditFlags(balance);
	} catch (err) {
		if (err instanceof CloudCreditsAuthRejectedError) {
			logger.debug(`[cloud/credits] API key rejected: ${err.message}`);
			return {
				balance: null,
				connected: true,
				authRejected: true,
				error: err.message,
				topUpUrl: CLOUD_BILLING_URL
			};
		}
		const msg = err instanceof Error ? err.message : "cloud API unreachable";
		logger.debug(`[cloud/credits] Failed to fetch balance via API key: ${msg}`);
		return {
			balance: null,
			connected: true,
			error: msg
		};
	}
}
async function clearCloudAuthService(cloudAuth) {
	if (!cloudAuth) return;
	const seen = /* @__PURE__ */ new Set();
	for (const methodName of CLOUD_AUTH_CLEAR_METHODS) {
		const method = cloudAuth[methodName];
		if (typeof method !== "function" || seen.has(method)) continue;
		seen.add(method);
		try {
			await method.call(cloudAuth);
			break;
		} catch (err) {
			logger.warn(`[cloud/disconnect] Failed to invoke CLOUD_AUTH.${methodName}: ${err instanceof Error ? err.message : String(err)}`);
		}
	}
}
function clearCloudEnv() {
	for (const key of CLOUD_ENV_KEYS) delete process.env[key];
	clearCloudSecrets();
	scrubCloudSecretsFromEnv();
}
async function clearRuntimeCloudState(runtime) {
	const runtimeWithCloud = asRuntimeCloud(runtime);
	if (!runtimeWithCloud) return;
	const nextSecrets = { ...runtimeWithCloud.character.secrets ?? {} };
	for (const key of CLOUD_RUNTIME_SECRET_KEYS) delete nextSecrets[key];
	runtimeWithCloud.character.secrets = nextSecrets;
	if (runtimeWithCloud.character.settings && typeof runtimeWithCloud.character.settings === "object") for (const key of CLOUD_RUNTIME_SETTING_KEYS) delete runtimeWithCloud.character.settings[key];
	if (typeof runtimeWithCloud.setSetting === "function") for (const key of CLOUD_RUNTIME_SETTING_KEYS) try {
		runtimeWithCloud.setSetting(key, null);
	} catch (err) {
		logger.warn(`[cloud/disconnect] Failed to clear runtime setting ${key}: ${err instanceof Error ? err.message : String(err)}`);
	}
	if (typeof runtimeWithCloud.updateAgent === "function") try {
		await runtimeWithCloud.updateAgent(runtimeWithCloud.agentId, { secrets: { ...nextSecrets } });
	} catch (err) {
		logger.warn(`[cloud/disconnect] Failed to clear cloud secrets from agent DB: ${err instanceof Error ? err.message : String(err)}`);
	}
}
async function disconnectCloudConnection(args) {
	const { cloudManager = null, config, runtime, saveConfig } = args;
	if (isElizaSettingsDebugEnabled()) {
		const c = config.cloud;
		logger.debug(`[eliza][settings][cloud] disconnectCloudConnection start cloud=${JSON.stringify(settingsDebugCloudSummary(c))}`);
	}
	if (typeof cloudManager?.disconnect === "function") try {
		await cloudManager.disconnect();
	} catch (err) {
		logger.warn(`[cloud/disconnect] Failed to disconnect cloud manager: ${err instanceof Error ? err.message : String(err)}`);
	}
	await clearCloudAuthService(getCloudAuth(runtime));
	const nextCloud = { ...config.cloud ?? {} };
	delete nextCloud.apiKey;
	config.cloud = nextCloud;
	applyCanonicalOnboardingConfig(config, {
		deploymentTarget: { runtime: "local" },
		linkedAccounts: { elizacloud: {
			status: "unlinked",
			source: "api-key"
		} },
		clearRoutes: [
			"llmText",
			"tts",
			"media",
			"embeddings",
			"rpc"
		]
	});
	migrateLegacyRuntimeConfig(config);
	try {
		saveConfig?.(config);
		if (isElizaSettingsDebugEnabled()) {
			const c = config.cloud;
			logger.debug(`[eliza][settings][cloud] disconnectCloudConnection saveConfig OK cloud=${JSON.stringify(settingsDebugCloudSummary(c))}`);
		}
	} catch (err) {
		logger.warn(`[cloud/disconnect] Failed to save cloud disconnect state: ${err instanceof Error ? err.message : String(err)}`);
	}
	clearCloudEnv();
	await clearRuntimeCloudState(runtime);
	if (isElizaSettingsDebugEnabled()) logger.debug("[eliza][settings][cloud] disconnectCloudConnection done (env cleared + runtime cloud state cleared)");
}
var DEFAULT_CLOUD_API_BASE_URL, CLOUD_BILLING_URL, CLOUD_ENV_KEYS, CLOUD_RUNTIME_SECRET_KEYS, CLOUD_RUNTIME_SETTING_KEYS, CLOUD_AUTH_CLEAR_METHODS, CloudCreditsAuthRejectedError, CREDIT_LOW_THRESHOLD, CREDIT_CRITICAL_THRESHOLD, disconnectUnifiedCloudConnection;
var init_cloud_connection = __esmMin((() => {
	init_env();
	init_cloud_secrets();
	DEFAULT_CLOUD_API_BASE_URL = "https://www.elizacloud.ai/api/v1";
	CLOUD_BILLING_URL = "https://www.elizacloud.ai/dashboard/settings?tab=billing";
	CLOUD_ENV_KEYS = [
		"ELIZAOS_CLOUD_API_KEY",
		"ELIZAOS_CLOUD_ENABLED",
		"ELIZAOS_CLOUD_BASE_URL",
		"ELIZAOS_CLOUD_NANO_MODEL",
		"ELIZAOS_CLOUD_MEDIUM_MODEL",
		"ELIZAOS_CLOUD_SMALL_MODEL",
		"ELIZAOS_CLOUD_LARGE_MODEL",
		"ELIZAOS_CLOUD_MEGA_MODEL",
		"ELIZAOS_CLOUD_RESPONSE_HANDLER_MODEL",
		"ELIZAOS_CLOUD_SHOULD_RESPOND_MODEL",
		"ELIZAOS_CLOUD_ACTION_PLANNER_MODEL",
		"ELIZAOS_CLOUD_PLANNER_MODEL",
		"ELIZAOS_CLOUD_USE_INFERENCE",
		"ELIZAOS_CLOUD_USE_TTS",
		"ELIZAOS_CLOUD_USE_MEDIA",
		"ELIZAOS_CLOUD_USE_EMBEDDINGS",
		"ELIZAOS_CLOUD_USE_RPC"
	];
	CLOUD_RUNTIME_SECRET_KEYS = [
		"ELIZAOS_CLOUD_API_KEY",
		"ELIZAOS_CLOUD_ENABLED",
		"ELIZAOS_CLOUD_BASE_URL",
		"ELIZAOS_CLOUD_NANO_MODEL",
		"ELIZAOS_CLOUD_MEDIUM_MODEL",
		"ELIZAOS_CLOUD_SMALL_MODEL",
		"ELIZAOS_CLOUD_LARGE_MODEL",
		"ELIZAOS_CLOUD_MEGA_MODEL",
		"ELIZAOS_CLOUD_RESPONSE_HANDLER_MODEL",
		"ELIZAOS_CLOUD_SHOULD_RESPOND_MODEL",
		"ELIZAOS_CLOUD_ACTION_PLANNER_MODEL",
		"ELIZAOS_CLOUD_PLANNER_MODEL",
		"ELIZA_CLOUD_AUTH_TOKEN",
		"ELIZA_CLOUD_USER_ID",
		"ELIZA_CLOUD_ORGANIZATION_ID"
	];
	CLOUD_RUNTIME_SETTING_KEYS = [
		"ELIZA_CLOUD_AUTH_TOKEN",
		"ELIZA_CLOUD_USER_ID",
		"ELIZA_CLOUD_ORGANIZATION_ID"
	];
	CLOUD_AUTH_CLEAR_METHODS = [
		"disconnect",
		"logout",
		"signOut",
		"signout",
		"clearSession",
		"clearAuth",
		"resetAuth",
		"reset"
	];
	CloudCreditsAuthRejectedError = class extends Error {
		name = "CloudCreditsAuthRejectedError";
		constructor(message = "Eliza Cloud API key was rejected") {
			super(message);
		}
	};
	CREDIT_LOW_THRESHOLD = Number(process.env.ELIZA_CREDIT_LOW_THRESHOLD ?? "2.0");
	CREDIT_CRITICAL_THRESHOLD = Number(process.env.ELIZA_CREDIT_CRITICAL_THRESHOLD ?? "0.5");
	disconnectUnifiedCloudConnection = disconnectCloudConnection;
}));

//#endregion
//#region node_modules/.bun/@elizaos+app-core@2.0.0-alpha.537+72829346cb4c43b1/node_modules/@elizaos/app-core/packages/app-core/src/api/cloud-routes.js
function isRedirectResponse(response) {
	return response.status >= 300 && response.status < 400;
}
function createNoopTelemetrySpan() {
	return {
		success: () => {},
		failure: () => {}
	};
}
function getTelemetrySpan(meta) {
	return meta.services.createIntegrationTelemetrySpan(meta) ?? createNoopTelemetrySpan();
}
async function fetchCloudLoginStatus(sessionId, baseUrl) {
	return fetch(`${baseUrl}/api/auth/cli-session/${encodeURIComponent(sessionId)}`, {
		redirect: "manual",
		signal: AbortSignal.timeout(CLOUD_LOGIN_POLL_TIMEOUT_MS)
	});
}
async function persistCloudLoginStatus(args) {
	if (args.epochAtPollStart !== void 0 && args.epochAtPollStart !== cloudDisconnectEpoch) {
		logger.warn("[cloud-login] Skipping login persist: a disconnect occurred while the login poll was in-flight");
		return;
	}
	migrateLegacyRuntimeConfig(args.state.config);
	const runtime = args.state.runtime;
	const cloudAuth = getCloudAuth(runtime);
	await clearCloudAuthService(cloudAuth);
	const cloud = { ...args.state.config.cloud ?? {} };
	cloud.apiKey = args.apiKey;
	const cloudInferenceSelected = isCloudInferenceSelectedInConfig(args.state.config);
	args.state.config.cloud = cloud;
	args.services.applyCanonicalOnboardingConfig(args.state.config, { linkedAccounts: { elizacloud: {
		status: "linked",
		source: "api-key"
	} } });
	migrateLegacyRuntimeConfig(args.state.config);
	try {
		args.services.saveElizaConfig(args.state.config);
		logger.info("[cloud-login] Saved cloud API key to config file");
		logger.warn("[cloud-login] Cloud API key is stored in cleartext in ~/.eliza/eliza.json. Ensure this file has restrictive permissions (chmod 600).");
	} catch (saveErr) {
		logger.error(`[cloud-login] Failed to save cloud API key to config: ${saveErr instanceof Error ? saveErr.message : String(saveErr)}`);
	}
	clearCloudSecrets();
	process.env.ELIZAOS_CLOUD_API_KEY = args.apiKey;
	if (cloudInferenceSelected) process.env.ELIZAOS_CLOUD_ENABLED = "true";
	else delete process.env.ELIZAOS_CLOUD_ENABLED;
	scrubCloudSecretsFromEnv();
	const cloudManager = args.state.cloudManager;
	if (cloudManager && typeof cloudManager.replaceApiKey === "function") await cloudManager.replaceApiKey(args.apiKey);
	else if (cloudManager && !cloudManager.getClient() && typeof cloudManager.init === "function") await cloudManager.init();
	if (typeof cloudAuth?.authenticateWithApiKey === "function") cloudAuth.authenticateWithApiKey({
		apiKey: args.apiKey,
		organizationId: args.organizationId,
		userId: args.userId
	});
	const relayService = runtime?.getService("CLOUD_MANAGED_GATEWAY_RELAY") ?? runtime?.getService("cloud-managed-gateway-relay") ?? runtime?.getService("cloudManagedGatewayRelay");
	if (typeof relayService?.startRelayLoopIfReady === "function") await relayService.startRelayLoopIfReady();
	if (!runtime || typeof runtime.updateAgent !== "function") return;
	try {
		const nextSecrets = {
			...runtime.character.secrets ?? {},
			ELIZAOS_CLOUD_API_KEY: args.apiKey
		};
		if (args.userId) {
			nextSecrets.ELIZA_CLOUD_USER_ID = args.userId;
			nextSecrets.ELIZAOS_CLOUD_USER_ID = args.userId;
		} else {
			delete nextSecrets.ELIZA_CLOUD_USER_ID;
			delete nextSecrets.ELIZAOS_CLOUD_USER_ID;
		}
		if (args.organizationId) {
			nextSecrets.ELIZA_CLOUD_ORGANIZATION_ID = args.organizationId;
			nextSecrets.ELIZAOS_CLOUD_ORG_ID = args.organizationId;
		} else {
			delete nextSecrets.ELIZA_CLOUD_ORGANIZATION_ID;
			delete nextSecrets.ELIZAOS_CLOUD_ORG_ID;
		}
		if (cloudInferenceSelected) nextSecrets.ELIZAOS_CLOUD_ENABLED = "true";
		else delete nextSecrets.ELIZAOS_CLOUD_ENABLED;
		runtime.character.secrets = nextSecrets;
		if (typeof runtime.setSetting === "function") {
			runtime.setSetting("ELIZA_CLOUD_USER_ID", args.userId ?? null);
			runtime.setSetting("ELIZAOS_CLOUD_USER_ID", args.userId ?? null);
			runtime.setSetting("ELIZA_CLOUD_ORGANIZATION_ID", args.organizationId ?? null);
			runtime.setSetting("ELIZAOS_CLOUD_ORG_ID", args.organizationId ?? null);
		}
		await runtime.updateAgent(runtime.agentId, { secrets: { ...nextSecrets } });
	} catch (err) {
		logger.warn(`[cloud-routes] Failed to persist cloud secrets to agent DB: ${String(err)}`);
	}
}
function getCloudRouteServices(state) {
	return {
		...DEFAULT_CLOUD_ROUTE_SERVICES,
		...state.services
	};
}
function toAutonomousState(state, services) {
	return {
		...state,
		saveConfig: () => services.saveElizaConfig(state.config),
		createTelemetrySpan: services.createIntegrationTelemetrySpan
	};
}
async function handleCloudRoute$1(req, res, pathname, method, state) {
	const services = getCloudRouteServices(state);
	if (method === "GET" && pathname === "/api/cloud/relay-status") {
		const relayService = state.runtime?.getService("CLOUD_MANAGED_GATEWAY_RELAY") ?? state.runtime?.getService("cloud-managed-gateway-relay") ?? state.runtime?.getService("cloudManagedGatewayRelay");
		if (typeof relayService?.getSessionInfo !== "function") {
			sendJson$2(res, 200, {
				available: false,
				status: "not_registered",
				reason: "Gateway relay service not active. Connect to Eliza Cloud in Settings to enable instance routing."
			});
			return true;
		}
		try {
			sendJson$2(res, 200, {
				available: true,
				...relayService.getSessionInfo()
			});
		} catch (error) {
			sendJson$2(res, 200, {
				available: false,
				status: "error",
				reason: error instanceof Error ? error.message : String(error)
			});
		}
		return true;
	}
	if (method === "POST" && pathname === "/api/cloud/disconnect") {
		cloudDisconnectEpoch++;
		try {
			await disconnectUnifiedCloudConnection({
				cloudManager: state.cloudManager,
				config: state.config,
				runtime: state.runtime,
				saveConfig: services.saveElizaConfig
			});
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			logger.error(`[cloud/disconnect] failed: ${message}`);
			sendJson$2(res, 500, {
				ok: false,
				error: message
			});
			return true;
		}
		sendJson$2(res, 200, {
			ok: true,
			status: "disconnected"
		});
		return true;
	}
	if (method === "POST" && pathname === "/api/cloud/login/persist") {
		const chunks = [];
		for await (const chunk of req) chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
		try {
			const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
			if (typeof body.apiKey !== "string" || !body.apiKey.trim()) {
				sendJson$2(res, 400, {
					ok: false,
					error: "apiKey is required"
				});
				return true;
			}
			await persistCloudLoginStatus({
				apiKey: body.apiKey.trim(),
				organizationId: typeof body.organizationId === "string" ? body.organizationId.trim() : void 0,
				services,
				state,
				userId: typeof body.userId === "string" ? body.userId.trim() : void 0
			});
			sendJson$2(res, 200, { ok: true });
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			logger.error(`[cloud/login/persist] Failed: ${msg}`);
			sendJson$2(res, 500, {
				ok: false,
				error: msg
			});
		}
		return true;
	}
	if (method === "GET" && pathname.startsWith("/api/cloud/login/status")) {
		const sessionId = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`).searchParams.get("sessionId");
		if (!sessionId) {
			sendJsonError(res, 400, "sessionId query parameter is required");
			return true;
		}
		const baseUrl = services.normalizeCloudSiteUrl(state.config.cloud?.baseUrl);
		const urlError = await services.validateCloudBaseUrl(baseUrl);
		if (urlError) {
			sendJsonError(res, 400, urlError);
			return true;
		}
		const epochBeforePoll = cloudDisconnectEpoch;
		const loginPollSpan = getTelemetrySpan({
			boundary: "cloud",
			operation: "login_poll_status",
			services,
			timeoutMs: CLOUD_LOGIN_POLL_TIMEOUT_MS
		});
		let pollRes;
		try {
			pollRes = await fetchCloudLoginStatus(sessionId, baseUrl);
		} catch (fetchErr) {
			if (isTimeoutError(fetchErr)) {
				loginPollSpan.failure({
					error: fetchErr,
					statusCode: 504
				});
				sendJson$2(res, 504, {
					status: "error",
					error: "Eliza Cloud status request timed out"
				});
				return true;
			}
			loginPollSpan.failure({
				error: fetchErr,
				statusCode: 502
			});
			sendJson$2(res, 502, {
				status: "error",
				error: "Failed to reach Eliza Cloud"
			});
			return true;
		}
		if (isRedirectResponse(pollRes)) {
			loginPollSpan.failure({
				statusCode: pollRes.status,
				errorKind: "redirect_response"
			});
			sendJson$2(res, 502, {
				status: "error",
				error: "Eliza Cloud status request was redirected; redirects are not allowed"
			});
			return true;
		}
		if (!pollRes.ok) {
			loginPollSpan.failure({
				statusCode: pollRes.status,
				errorKind: "http_error"
			});
			sendJson$2(res, 200, pollRes.status === 404 ? {
				status: "expired",
				error: "Session not found or expired"
			} : {
				status: "error",
				error: `Eliza Cloud returned HTTP ${pollRes.status}`
			});
			return true;
		}
		let data;
		try {
			data = await pollRes.json();
		} catch (parseErr) {
			loginPollSpan.failure({
				error: parseErr,
				statusCode: pollRes.status
			});
			sendJson$2(res, 502, {
				status: "error",
				error: "Eliza Cloud returned invalid JSON"
			});
			return true;
		}
		loginPollSpan.success({ statusCode: pollRes.status });
		if (data.status === "authenticated" && typeof data.apiKey === "string") {
			await persistCloudLoginStatus({
				apiKey: data.apiKey,
				organizationId: typeof data.organizationId === "string" ? data.organizationId : void 0,
				services,
				state,
				epochAtPollStart: epochBeforePoll,
				userId: typeof data.userId === "string" ? data.userId : void 0
			});
			sendJson$2(res, 200, {
				status: "authenticated",
				keyPrefix: typeof data.keyPrefix === "string" ? data.keyPrefix : void 0,
				organizationId: typeof data.organizationId === "string" ? data.organizationId : void 0,
				userId: typeof data.userId === "string" ? data.userId : void 0
			});
			return true;
		}
		sendJson$2(res, 200, { status: typeof data.status === "string" ? data.status : "error" });
		return true;
	}
	const result = await services.handleAutonomousCloudRoute(req, res, pathname, method, toAutonomousState(state, services));
	scrubCloudSecretsFromEnv();
	return result;
}
var CLOUD_LOGIN_POLL_TIMEOUT_MS, DEFAULT_CLOUD_ROUTE_SERVICES, cloudDisconnectEpoch;
var init_cloud_routes = __esmMin((() => {
	init_errors();
	init_cloud_connection();
	init_cloud_secrets();
	init_response();
	CLOUD_LOGIN_POLL_TIMEOUT_MS = 1e4;
	DEFAULT_CLOUD_ROUTE_SERVICES = {
		applyCanonicalOnboardingConfig,
		createIntegrationTelemetrySpan,
		handleAutonomousCloudRoute: handleCloudRoute,
		normalizeCloudSiteUrl,
		saveElizaConfig,
		validateCloudBaseUrl
	};
	cloudDisconnectEpoch = 0;
}));

//#endregion
//#region node_modules/.bun/@elizaos+app-core@2.0.0-alpha.537+72829346cb4c43b1/node_modules/@elizaos/app-core/packages/app-core/src/api/cloud-status-routes.js
async function handleCloudStatusRoutes(ctx) {
	const { res, method, pathname, config, runtime, json } = ctx;
	const typedConfig = config;
	if (method === "GET" && pathname === "/api/cloud/status") {
		const snapshot = resolveCloudConnectionSnapshot(typedConfig, runtime);
		const cloudVoiceProxyAvailable = isElizaCloudServiceSelectedInConfig(typedConfig, "tts");
		if (snapshot.connected) {
			json(res, {
				connected: true,
				enabled: snapshot.enabled,
				cloudVoiceProxyAvailable,
				hasApiKey: snapshot.hasApiKey,
				userId: snapshot.userId,
				organizationId: snapshot.organizationId,
				topUpUrl: CLOUD_BILLING_URL,
				reason: snapshot.authConnected ? void 0 : runtime ? "api_key_present_not_authenticated" : "api_key_present_runtime_not_started"
			});
			return true;
		}
		if (!runtime) {
			json(res, {
				connected: false,
				enabled: snapshot.enabled,
				cloudVoiceProxyAvailable,
				hasApiKey: snapshot.hasApiKey,
				reason: "runtime_not_started"
			});
			return true;
		}
		json(res, {
			connected: false,
			enabled: snapshot.enabled,
			cloudVoiceProxyAvailable,
			hasApiKey: snapshot.hasApiKey,
			reason: "not_authenticated"
		});
		return true;
	}
	if (method === "GET" && pathname === "/api/cloud/credits") {
		json(res, await fetchCloudCredits(typedConfig, runtime));
		return true;
	}
	return false;
}
var init_cloud_status_routes = __esmMin((() => {
	init_cloud_connection();
}));

//#endregion
//#region node_modules/.bun/@elizaos+app-core@2.0.0-alpha.537+72829346cb4c43b1/node_modules/@elizaos/app-core/packages/app-core/src/api/computer-use-compat-routes.js
function isApprovalMode(value) {
	return VALID_APPROVAL_MODES.includes(value);
}
function getComputerUseService(state) {
	const runtime = state.current;
	if (!runtime?.getService) return null;
	const service = runtime.getService("computeruse");
	if (!service || typeof service !== "object") return null;
	const candidate = service;
	if (typeof candidate.getApprovalSnapshot !== "function" || typeof candidate.setApprovalMode !== "function" || typeof candidate.resolveApproval !== "function") return null;
	return candidate;
}
function isStreamAuthorized$1(req, res, url) {
	const expectedToken = getCompatApiToken$1();
	if (!expectedToken) return true;
	const headerToken = getProvidedApiToken(req);
	const providedToken = url.searchParams.get("token")?.trim();
	if (headerToken && tokenMatches(expectedToken, headerToken) || providedToken && tokenMatches(expectedToken, providedToken)) return true;
	res.writeHead(401, { "Content-Type": "application/json" });
	res.end(JSON.stringify({ error: "Unauthorized" }));
	return false;
}
function writeSseEvent$1(res, payload) {
	res.write(`data: ${JSON.stringify(payload)}\n\n`);
}
async function handleComputerUseCompatRoutes(req, res, state) {
	const method = (req.method ?? "GET").toUpperCase();
	const url = new URL(req.url ?? "/", "http://localhost");
	if (!url.pathname.startsWith("/api/computer-use/")) return false;
	if (method === "GET" && url.pathname === "/api/computer-use/approvals/stream") {
		if (!isStreamAuthorized$1(req, res, url)) return true;
		const service = getComputerUseService(state);
		if (!service) {
			sendJsonError(res, 404, "Computer use service not available");
			return true;
		}
		res.writeHead(200, {
			"Content-Type": "text/event-stream",
			"Cache-Control": "no-cache, no-transform",
			Connection: "keep-alive",
			"X-Accel-Buffering": "no"
		});
		writeSseEvent$1(res, {
			type: "snapshot",
			snapshot: service.getApprovalSnapshot()
		});
		const heartbeat = setInterval(() => {
			res.write(": heartbeat\n\n");
		}, 15e3);
		if (typeof heartbeat === "object" && "unref" in heartbeat) heartbeat.unref();
		const unsubscribe = service.subscribeApprovals?.((snapshot) => {
			writeSseEvent$1(res, {
				type: "snapshot",
				snapshot
			});
		});
		const cleanup = () => {
			clearInterval(heartbeat);
			unsubscribe?.();
		};
		req.on("close", cleanup);
		req.on("aborted", cleanup);
		return true;
	}
	if (method === "GET" && url.pathname === "/api/computer-use/approvals") {
		if (!await ensureRouteAuthorized(req, res, state)) return true;
		const service = getComputerUseService(state);
		if (!service) {
			sendJsonError(res, 404, "Computer use service not available");
			return true;
		}
		sendJson$2(res, 200, service.getApprovalSnapshot());
		return true;
	}
	if (method === "POST" && url.pathname === "/api/computer-use/approval-mode") {
		if (!ensureCompatSensitiveRouteAuthorized(req, res)) return true;
		const body = await readCompatJsonBody(req, res);
		if (!body) return true;
		if (typeof body.mode !== "string" || !isApprovalMode(body.mode)) {
			sendJsonError(res, 400, "mode must be one of full_control, smart_approve, approve_all, off");
			return true;
		}
		const service = getComputerUseService(state);
		if (!service) {
			sendJsonError(res, 404, "Computer use service not available");
			return true;
		}
		sendJson$2(res, 200, { mode: service.setApprovalMode(body.mode) });
		return true;
	}
	const match = url.pathname.match(/^\/api\/computer-use\/approvals\/([^/]+)$/);
	if (method === "POST" && match) {
		if (!ensureCompatSensitiveRouteAuthorized(req, res)) return true;
		const body = await readCompatJsonBody(req, res);
		if (!body) return true;
		if (typeof body.approved !== "boolean") {
			sendJsonError(res, 400, "approved must be a boolean");
			return true;
		}
		const service = getComputerUseService(state);
		if (!service) {
			sendJsonError(res, 404, "Computer use service not available");
			return true;
		}
		const approvalId = match[1];
		if (approvalId === void 0) {
			sendJsonError(res, 400, "Missing approval id");
			return true;
		}
		const resolution = service.resolveApproval(decodeURIComponent(approvalId), body.approved, typeof body.reason === "string" ? body.reason : void 0);
		if (!resolution) {
			sendJsonError(res, 404, "Approval not found");
			return true;
		}
		sendJson$2(res, 200, resolution);
		return true;
	}
	sendJsonError(res, 404, "Not found");
	return true;
}
var VALID_APPROVAL_MODES;
var init_computer_use_compat_routes = __esmMin((() => {
	init_auth$1();
	init_compat_route_shared();
	init_response();
	VALID_APPROVAL_MODES = [
		"full_control",
		"smart_approve",
		"approve_all",
		"off"
	];
}));

//#endregion
//#region node_modules/.bun/@elizaos+app-core@2.0.0-alpha.537+72829346cb4c43b1/node_modules/@elizaos/app-core/packages/app-core/src/api/database-rows-compat-routes.js
async function handleDatabaseRowsCompatRoute(req, res, state) {
	const pathname = new URL(req.url ?? "/", "http://localhost").pathname;
	const match = /^\/api\/database\/tables\/([^/]+)\/rows$/.exec(pathname);
	if ((req.method ?? "GET").toUpperCase() !== "GET" || !match) return false;
	if (!await ensureRouteAuthorized(req, res, state)) return true;
	const runtime = state.current;
	if (!runtime) {
		sendJsonError(res, 503, DATABASE_UNAVAILABLE_MESSAGE);
		return true;
	}
	const tableName = sanitizeIdentifier(decodeURIComponent(match[1]));
	const requestUrl = new URL(req.url ?? "/", "http://localhost");
	const schemaName = sanitizeIdentifier(requestUrl.searchParams.get("schema"));
	if (!tableName) {
		sendJsonError(res, 400, "Invalid table name");
		return true;
	}
	let resolvedSchema = schemaName;
	if (!resolvedSchema) {
		const { rows } = await executeRawSql(runtime, `SELECT table_schema AS schema
         FROM information_schema.tables
        WHERE table_name = ${sqlLiteral(tableName)}
          AND table_schema NOT IN ('pg_catalog', 'information_schema')
          AND table_type = 'BASE TABLE'
        ORDER BY CASE WHEN table_schema = 'public' THEN 0 ELSE 1 END,
                 table_schema`);
		const schemas = rows.map((row) => row.schema).filter((value) => typeof value === "string");
		if (schemas.length === 0) {
			sendJsonError(res, 404, `Unknown table "${tableName}"`);
			return true;
		}
		if (schemas.length > 1 && !schemas.includes("public")) {
			sendJsonError(res, 409, `Table "${tableName}" exists in multiple schemas; specify ?schema=<name>.`);
			return true;
		}
		resolvedSchema = schemas.includes("public") ? "public" : schemas[0];
	}
	const columns = (await executeRawSql(runtime, `SELECT column_name
       FROM information_schema.columns
      WHERE table_name = ${sqlLiteral(tableName)}
        AND table_schema = ${sqlLiteral(resolvedSchema)}
      ORDER BY ordinal_position`)).rows.map((row) => row.column_name).filter((value) => typeof value === "string");
	if (columns.length === 0) {
		sendJsonError(res, 404, `No readable columns found for ${resolvedSchema}.${tableName}`);
		return true;
	}
	const limit = Math.max(1, Math.min(500, Number.parseInt(requestUrl.searchParams.get("limit") ?? "", 10) || 50));
	const offset = Math.max(0, Number.parseInt(requestUrl.searchParams.get("offset") ?? "", 10) || 0);
	const sortColumn = sanitizeIdentifier(requestUrl.searchParams.get("sort"));
	const order = requestUrl.searchParams.get("order") === "desc" ? "DESC" : "ASC";
	const search = requestUrl.searchParams.get("search")?.trim();
	const filters = [];
	if (search) {
		const searchLiteral = sqlLiteral(`%${search.replace(/\\/g, "\\\\").replace(/%/g, "\\%").replace(/_/g, "\\_")}%`);
		filters.push(`(${columns.map((columnName) => `CAST(${quoteIdent(columnName)} AS TEXT) ILIKE ${searchLiteral}`).join(" OR ")})`);
	}
	const whereClause = filters.length > 0 ? `WHERE ${filters.join(" AND ")}` : "";
	const orderBy = sortColumn && columns.includes(sortColumn) ? `ORDER BY ${quoteIdent(sortColumn)} ${order}` : "";
	const qualifiedTable = `${quoteIdent(resolvedSchema)}.${quoteIdent(tableName)}`;
	const countResult = await executeRawSql(runtime, `SELECT count(*)::int AS total FROM ${qualifiedTable} ${whereClause}`);
	const total = typeof countResult.rows[0]?.total === "number" ? countResult.rows[0].total : Number(countResult.rows[0]?.total ?? 0);
	const rowsResult = await executeRawSql(runtime, `SELECT * FROM ${qualifiedTable}
      ${whereClause}
      ${orderBy}
      LIMIT ${limit}
     OFFSET ${offset}`);
	sendJson$2(res, 200, {
		table: tableName,
		schema: resolvedSchema,
		rows: rowsResult.rows,
		columns,
		total,
		offset,
		limit
	});
	return true;
}
var init_database_rows_compat_routes = __esmMin((() => {
	init_sql_compat();
	init_auth$1();
	init_compat_route_shared();
	init_response();
}));

//#endregion
//#region node_modules/.bun/@elizaos+app-core@2.0.0-alpha.537+72829346cb4c43b1/node_modules/@elizaos/app-core/packages/app-core/src/api/dev-stack.js
var init_dev_stack = __esmMin((() => {}));

//#endregion
//#region node_modules/.bun/@elizaos+app-core@2.0.0-alpha.537+72829346cb4c43b1/node_modules/@elizaos/app-core/packages/app-core/src/api/dev-compat-routes.js
/**
* Dev observability routes (loopback where noted).
*
* - `GET /api/dev/stack`
* - `GET /api/dev/cursor-screenshot`
* - `GET /api/dev/console-log`
*/
async function handleDevCompatRoutes(req, res, state) {
	const method = (req.method ?? "GET").toUpperCase();
	const url = new URL(req.url ?? "/", "http://localhost");
	if (!url.pathname.startsWith("/api/dev/")) return false;
	sendJsonError(res, 404, "Not found");
	return true;
}
var init_dev_compat_routes = __esmMin((() => {
	init_auth$1();
	init_compat_route_shared();
	init_dev_stack();
	init_response();
}));

//#endregion
//#region node_modules/.bun/@elizaos+app-core@2.0.0-alpha.537+72829346cb4c43b1/node_modules/@elizaos/app-core/packages/app-core/src/services/github-credentials.js
/**
* Local GitHub credential storage for the eliza desktop / VPS install.
*
* Stores a single per-user GitHub PAT at
* `<state-dir>/credentials/github.json` (chmod 600). The token itself is
* write-only from the UI side: `loadCredentials()` returns the full record
* for runtime consumers (orchestrator spawn env, route handlers) but the
* HTTP route that powers the settings card never returns it — only
* `getMetadata()` is safe to send back to the browser.
*
* Storage shape mirrors the convention used elsewhere under
* `<state-dir>/` (see `~/.claude/.credentials.json` and the auth-store
* module): plain JSON, file mode 600, no encryption layer. Encryption at
* rest is a deliberately separate concern and would land in a follow-up.
*
* Cloud users (Eliza Cloud session active) are out of scope here — they
* use the `platformCredentials` table in `cloud/packages/db/schemas/` via
* the dedicated OAuth flow. This module is the local-first surface only.
*/
function resolveStateDir() {
	const explicit = process.env.ELIZA_STATE_DIR?.trim();
	if (explicit) return path.resolve(explicit);
	const home = process.env.HOME?.trim() || process.env.USERPROFILE?.trim() || process.cwd();
	return path.join(home, ".eliza");
}
/** Resolve the on-disk path for the credential file. */
function getCredentialFilePath() {
	return path.join(resolveStateDir(), "credentials", "github.json");
}
function isGitHubCredentials(value) {
	if (!value || typeof value !== "object") return false;
	const v = value;
	return typeof v.token === "string" && typeof v.username === "string" && Array.isArray(v.scopes) && v.scopes.every((s) => typeof s === "string") && typeof v.savedAt === "number";
}
/**
* Read the saved credentials, or null if no file exists / the file is
* unreadable / the contents don't conform to the expected shape. Callers
* that need to surface a specific cause should check the file path
* themselves; we treat all failure modes the same here so the UI never
* has to reason about transient FS errors during render.
*/
async function loadCredentials() {
	const filePath = getCredentialFilePath();
	let raw;
	try {
		raw = await fs$1.readFile(filePath, "utf-8");
	} catch {
		return null;
	}
	let parsed;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return null;
	}
	return isGitHubCredentials(parsed) ? parsed : null;
}
/** Read just the metadata: same as `loadCredentials` minus the token. */
async function loadMetadata() {
	const creds = await loadCredentials();
	if (!creds) return null;
	const { token: _token, ...metadata } = creds;
	return metadata;
}
/**
* Persist credentials to disk atomically with mode 0600. Creates the
* parent directory if needed. Overwrites any existing record for the
* single-user/single-token storage model.
*/
async function saveCredentials(creds) {
	const filePath = getCredentialFilePath();
	const directory = path.dirname(filePath);
	await fs$1.mkdir(directory, {
		recursive: true,
		mode: 448
	});
	await fs$1.chmod(directory, 448);
	const tmpPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
	await fs$1.writeFile(tmpPath, JSON.stringify(creds, null, 2), { mode: 384 });
	await fs$1.rename(tmpPath, filePath);
}
/**
* Remove the credential file. Idempotent — succeeds silently when nothing
* is saved. Any other FS error propagates so callers can surface it.
*/
async function clearCredentials() {
	const filePath = getCredentialFilePath();
	try {
		await fs$1.unlink(filePath);
	} catch (err) {
		if (err.code === "ENOENT") return;
		throw err;
	}
}
/**
* Build the credential record from a GitHub `/user` API response. Kept
* tiny and pure so the route handler can call it without pulling in any
* I/O surface. The route is responsible for the actual `fetch`.
*/
function buildCredentialsFromUserResponse(token, user, scopes, now = Date.now()) {
	return {
		token,
		username: user.login,
		scopes,
		savedAt: now
	};
}
var init_github_credentials = __esmMin((() => {}));

//#endregion
//#region node_modules/.bun/@elizaos+app-core@2.0.0-alpha.537+72829346cb4c43b1/node_modules/@elizaos/app-core/packages/app-core/src/api/github-routes.js
/**
* GitHub PAT routes — power the "GitHub" connection card in Settings →
* Coding Agents and surface the same token to the orchestrator's
* sub-agent spawn env.
*
* Exposes:
*   GET    /api/github/token   — `{ connected: bool, username?, scopes?, savedAt? }`.
*                                 Token itself is never returned.
*   POST   /api/github/token   — body `{ token }`. Validates by calling
*                                 GitHub's `/user` endpoint, then persists
*                                 the credential record to disk.
*   DELETE /api/github/token   — clears the saved credential and returns
*                                 `{ connected: false }`.
*
* Auth gating sits in front of every handler at the server.ts call site
* (mirrors `/api/n8n/*`). The handler returns `true` when it owned the
* request so the dispatcher can short-circuit.
*/
async function readJsonBody$1(req) {
	const chunks = [];
	let total = 0;
	for await (const chunk of req) {
		const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
		total += buf.length;
		if (total > MAX_BODY_BYTES) return null;
		chunks.push(buf);
	}
	if (chunks.length === 0) return null;
	try {
		const parsed = JSON.parse(Buffer.concat(chunks).toString("utf-8"));
		return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
	} catch {
		return null;
	}
}
function sendJson(ctx, status, body) {
	if (ctx.json) {
		ctx.json(status, body);
		return;
	}
	ctx.res.statusCode = status;
	ctx.res.setHeader("Content-Type", "application/json; charset=utf-8");
	ctx.res.end(JSON.stringify(body));
}
function metadataToStatus(metadata) {
	if (!metadata) return { connected: false };
	return {
		connected: true,
		username: metadata.username,
		scopes: metadata.scopes,
		savedAt: metadata.savedAt
	};
}
/**
* Validate a token by calling GitHub's `/user` endpoint. Returns the
* authenticated user + the granted OAuth scopes (parsed from the
* `X-OAuth-Scopes` response header). Throws when the token is invalid,
* lacks `read:user`, or the network call fails.
*/
async function validateToken(token, fetchImpl) {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), VALIDATION_TIMEOUT_MS);
	let response;
	try {
		response = await fetchImpl(GITHUB_USER_URL, {
			headers: {
				Authorization: `Bearer ${token}`,
				Accept: "application/vnd.github+json",
				"User-Agent": "eliza-github-connection"
			},
			signal: controller.signal
		});
	} finally {
		clearTimeout(timer);
	}
	if (response.status === 401) throw new Error("Token rejected by GitHub: bad credentials.");
	if (response.status === 403) throw new Error("Token rejected by GitHub: forbidden. Check the token has at least `read:user` scope.");
	if (!response.ok) throw new Error(`GitHub returned ${response.status} validating the token. Try again or generate a new token.`);
	const body = await response.json();
	if (typeof body?.login !== "string" || body.login.length === 0) throw new Error("GitHub /user response was missing the login field.");
	return {
		user: body,
		scopes: (response.headers.get("x-oauth-scopes") ?? "").split(",").map((s) => s.trim()).filter((s) => s.length > 0)
	};
}
async function handleGetToken(ctx) {
	sendJson(ctx, 200, metadataToStatus(await loadMetadata()));
	return true;
}
async function handlePostToken(ctx) {
	const body = await readJsonBody$1(ctx.req);
	const token = body && typeof body.token === "string" ? body.token.trim() : "";
	if (token.length === 0) {
		sendJson(ctx, 400, { error: "Missing `token` in request body." });
		return true;
	}
	const fetchImpl = ctx.fetch ?? fetch;
	let validated;
	try {
		validated = await validateToken(token, fetchImpl);
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		logger.warn(`[github-routes] token validation failed: ${message}`);
		sendJson(ctx, 400, { error: message });
		return true;
	}
	const credentials = buildCredentialsFromUserResponse(token, validated.user, validated.scopes);
	await saveCredentials(credentials);
	logger.info(`[github-routes] saved github token for @${validated.user.login} (scopes=${validated.scopes.join(",") || "(none)"})`);
	sendJson(ctx, 200, metadataToStatus(credentials));
	return true;
}
async function handleDeleteToken(ctx) {
	await clearCredentials();
	logger.info("[github-routes] cleared saved github token");
	sendJson(ctx, 200, { connected: false });
	return true;
}
/**
* Dispatch entry point. Returns `true` when this module owned the request.
* Caller is responsible for auth (mirrors `/api/n8n/*` in server.ts).
*/
async function handleGitHubRoutes(ctx) {
	if (ctx.pathname !== "/api/github/token") return false;
	switch (ctx.method) {
		case "GET": return handleGetToken(ctx);
		case "POST": return handlePostToken(ctx);
		case "DELETE": return handleDeleteToken(ctx);
		default:
			sendJson(ctx, 405, { error: "Method not allowed" });
			return true;
	}
}
var GITHUB_USER_URL, VALIDATION_TIMEOUT_MS, MAX_BODY_BYTES;
var init_github_routes = __esmMin((() => {
	init_github_credentials();
	GITHUB_USER_URL = "https://api.github.com/user";
	VALIDATION_TIMEOUT_MS = 1e4;
	MAX_BODY_BYTES = 8 * 1024;
}));

//#endregion
//#region node_modules/.bun/@elizaos+app-core@2.0.0-alpha.537+72829346cb4c43b1/node_modules/@elizaos/app-core/packages/app-core/src/services/local-inference/providers.js
/**
* Provider registry.
*
* Treats every inference source the same way — cloud subscription, cloud
* API, local llama.cpp engine, paired-device bridge, Capacitor on-device
* — each is a `ProviderDefinition` with an `id`, a human label, a set of
* supported model slots, and a pluggable `getEnableState()` that inspects
* whatever underlying gate controls it (API key presence, subscription
* status, env flag, file on disk).
*
* The cloud-provider status readers are intentionally permissive: they
* report what they can introspect without depending on the specific
* cloud-plugin internals, and hand off to the existing ProviderSwitcher
* UI for actual enable/disable via `configureHref`. That avoids the
* "combined enable matrix is an architectural project" problem by making
* configuration navigable rather than centralised.
*/
/** Resolve which slots have at least one registered handler from this provider. */
function getRegisteredSlotsForProvider(providerId) {
	const regs = handlerRegistry.getAll();
	const slots = /* @__PURE__ */ new Set();
	for (const r of regs) if (r.provider === providerId) slots.add(r.modelType);
	return [...slots];
}
function subscriptionEnableState(providerId) {
	if (providerId !== "anthropic-subscription" && providerId !== "openai-codex") return {
		enabled: false,
		reason: "Unsupported subscription"
	};
	const accounts = getDefaultAccountPool().list(providerId).filter((account) => account.enabled && account.health === "ok");
	if (accounts.length === 0) return {
		enabled: false,
		reason: "No linked account"
	};
	return {
		enabled: true,
		reason: `${accounts.length} linked account${accounts.length === 1 ? "" : "s"}`
	};
}
async function snapshotProviders() {
	return await Promise.all(BUILT_IN_PROVIDERS.map(async (def) => {
		const state = await def.getEnableState();
		return {
			id: def.id,
			label: def.label,
			kind: def.kind,
			description: def.description,
			supportedSlots: def.supportedSlots,
			configureHref: def.configureHref,
			enableState: state,
			registeredSlots: getRegisteredSlotsForProvider(def.id)
		};
	}));
}
var LOCAL_PROVIDER, DEVICE_BRIDGE_PROVIDER, CAPACITOR_LLAMA_PROVIDER, ANTHROPIC_PROVIDER, OPENAI_PROVIDER, GROK_PROVIDER, ELIZACLOUD_PROVIDER, ANTHROPIC_SUBSCRIPTION_PROVIDER, OPENAI_CODEX_PROVIDER, GOOGLE_PROVIDER, MISTRAL_PROVIDER, BUILT_IN_PROVIDERS;
var init_providers = __esmMin((() => {
	init_account_pool();
	init_device_bridge();
	init_handler_registry();
	init_paths();
	LOCAL_PROVIDER = {
		id: "eliza-local-inference",
		label: "Local llama.cpp",
		kind: "local",
		description: "On-device inference using node-llama-cpp. Free, private, runs on your machine's CPU/GPU.",
		supportedSlots: ["TEXT_SMALL", "TEXT_LARGE"],
		async getEnableState() {
			try {
				return (await fs$1.readdir(`${localInferenceRoot()}/models`, { withFileTypes: true })).some((e) => e.isFile() && e.name.toLowerCase().endsWith(".gguf")) ? {
					enabled: true,
					reason: "GGUF model installed"
				} : {
					enabled: false,
					reason: "No local model installed"
				};
			} catch {
				return {
					enabled: false,
					reason: "No local model installed"
				};
			}
		},
		configureHref: "#local-inference-panel"
	};
	DEVICE_BRIDGE_PROVIDER = {
		id: "eliza-device-bridge",
		label: "Paired device bridge",
		kind: "device-bridge",
		description: "Inference on a paired mobile or desktop device over WebSocket. Useful when the agent runs in a container but the model lives on your phone or laptop.",
		supportedSlots: ["TEXT_SMALL", "TEXT_LARGE"],
		async getEnableState() {
			if (!(process.env.ELIZA_DEVICE_BRIDGE_ENABLED?.trim() === "1")) return {
				enabled: false,
				reason: "Set ELIZA_DEVICE_BRIDGE_ENABLED=1 to enable"
			};
			const status = deviceBridge.status();
			if (status.connected) return {
				enabled: true,
				reason: `${status.devices.length} device(s) connected`
			};
			return {
				enabled: true,
				reason: "Waiting for a device to connect"
			};
		},
		configureHref: "#device-bridge-status"
	};
	CAPACITOR_LLAMA_PROVIDER = {
		id: "capacitor-llama",
		label: "On-device llama.cpp (mobile)",
		kind: "local",
		description: "Runs llama.cpp natively on iOS or Android via Capacitor. Only available in mobile builds.",
		supportedSlots: ["TEXT_SMALL", "TEXT_LARGE"],
		async getEnableState() {
			if (globalThis.Capacitor?.isNativePlatform?.()) return {
				enabled: true,
				reason: "Native Capacitor runtime detected"
			};
			return {
				enabled: false,
				reason: "Only available in iOS/Android builds"
			};
		},
		configureHref: null
	};
	ANTHROPIC_PROVIDER = {
		id: "anthropic",
		label: "Anthropic API",
		kind: "cloud-api",
		description: "Claude models via the Anthropic API. Requires an API key.",
		supportedSlots: [
			"TEXT_SMALL",
			"TEXT_LARGE",
			"OBJECT_SMALL",
			"OBJECT_LARGE"
		],
		async getEnableState() {
			return process.env.ANTHROPIC_API_KEY?.trim() ? {
				enabled: true,
				reason: "API key set"
			} : {
				enabled: false,
				reason: "No API key"
			};
		},
		configureHref: "#ai-model"
	};
	OPENAI_PROVIDER = {
		id: "openai",
		label: "OpenAI API",
		kind: "cloud-api",
		description: "GPT models via the OpenAI API. Requires an API key.",
		supportedSlots: [
			"TEXT_SMALL",
			"TEXT_LARGE",
			"TEXT_EMBEDDING",
			"OBJECT_SMALL",
			"OBJECT_LARGE"
		],
		async getEnableState() {
			return process.env.OPENAI_API_KEY?.trim() ? {
				enabled: true,
				reason: "API key set"
			} : {
				enabled: false,
				reason: "No API key"
			};
		},
		configureHref: "#ai-model"
	};
	GROK_PROVIDER = {
		id: "grok",
		label: "Grok API",
		kind: "cloud-api",
		description: "xAI Grok models. Requires an API key.",
		supportedSlots: ["TEXT_SMALL", "TEXT_LARGE"],
		async getEnableState() {
			return process.env.GROK_API_KEY?.trim() ?? process.env.XAI_API_KEY?.trim() ? {
				enabled: true,
				reason: "API key set"
			} : {
				enabled: false,
				reason: "No API key"
			};
		},
		configureHref: "#ai-model"
	};
	ELIZACLOUD_PROVIDER = {
		id: "elizacloud",
		label: "Eliza Cloud",
		kind: "cloud-subscription",
		description: "Eliza-hosted inference routed through your subscription. No API key to manage.",
		supportedSlots: [
			"TEXT_SMALL",
			"TEXT_LARGE",
			"TEXT_EMBEDDING",
			"OBJECT_SMALL",
			"OBJECT_LARGE"
		],
		async getEnableState() {
			return process.env.ELIZA_CLOUD_TOKEN?.trim() ?? process.env.ELIZACLOUD_TOKEN?.trim() ?? process.env.ELIZAOS_API_KEY?.trim() ? {
				enabled: true,
				reason: "Cloud token set"
			} : {
				enabled: false,
				reason: "Not signed in"
			};
		},
		configureHref: "#ai-model"
	};
	ANTHROPIC_SUBSCRIPTION_PROVIDER = {
		id: "anthropic-subscription",
		label: "Claude subscription",
		kind: "cloud-subscription",
		description: "Claude Code task-agent access through linked accounts.",
		supportedSlots: [
			"TEXT_SMALL",
			"TEXT_LARGE",
			"OBJECT_SMALL",
			"OBJECT_LARGE"
		],
		async getEnableState() {
			return subscriptionEnableState("anthropic-subscription");
		},
		configureHref: "#ai-model"
	};
	OPENAI_CODEX_PROVIDER = {
		id: "openai-codex",
		label: "Codex subscription",
		kind: "cloud-subscription",
		description: "Codex and ChatGPT subscription access through linked accounts.",
		supportedSlots: [
			"TEXT_SMALL",
			"TEXT_LARGE",
			"OBJECT_SMALL",
			"OBJECT_LARGE"
		],
		async getEnableState() {
			return subscriptionEnableState("openai-codex");
		},
		configureHref: "#ai-model"
	};
	GOOGLE_PROVIDER = {
		id: "google",
		label: "Google (Gemini)",
		kind: "cloud-api",
		description: "Gemini models via Google Generative AI. Requires an API key.",
		supportedSlots: [
			"TEXT_SMALL",
			"TEXT_LARGE",
			"OBJECT_SMALL",
			"OBJECT_LARGE"
		],
		async getEnableState() {
			return process.env.GOOGLE_API_KEY?.trim() ?? process.env.GEMINI_API_KEY?.trim() ? {
				enabled: true,
				reason: "API key set"
			} : {
				enabled: false,
				reason: "No API key"
			};
		},
		configureHref: "#ai-model"
	};
	MISTRAL_PROVIDER = {
		id: "mistral",
		label: "Mistral API",
		kind: "cloud-api",
		description: "Mistral models via la Plateforme. Requires an API key.",
		supportedSlots: ["TEXT_SMALL", "TEXT_LARGE"],
		async getEnableState() {
			return process.env.MISTRAL_API_KEY?.trim() ? {
				enabled: true,
				reason: "API key set"
			} : {
				enabled: false,
				reason: "No API key"
			};
		},
		configureHref: "#ai-model"
	};
	BUILT_IN_PROVIDERS = [
		LOCAL_PROVIDER,
		DEVICE_BRIDGE_PROVIDER,
		CAPACITOR_LLAMA_PROVIDER,
		ANTHROPIC_SUBSCRIPTION_PROVIDER,
		OPENAI_CODEX_PROVIDER,
		ELIZACLOUD_PROVIDER,
		ANTHROPIC_PROVIDER,
		OPENAI_PROVIDER,
		GOOGLE_PROVIDER,
		GROK_PROVIDER,
		MISTRAL_PROVIDER
	];
}));

//#endregion
//#region node_modules/.bun/@elizaos+app-core@2.0.0-alpha.537+72829346cb4c43b1/node_modules/@elizaos/app-core/packages/app-core/src/services/local-inference/active-model.js
function isLoader(value) {
	if (!value || typeof value !== "object") return false;
	const candidate = value;
	return typeof candidate.loadModel === "function" && typeof candidate.unloadModel === "function" && typeof candidate.currentModelPath === "function";
}
var ActiveModelCoordinator;
var init_active_model = __esmMin((() => {
	init_engine();
	init_registry();
	ActiveModelCoordinator = class {
		state = {
			modelId: null,
			loadedAt: null,
			status: "idle"
		};
		listeners = /* @__PURE__ */ new Set();
		snapshot() {
			return { ...this.state };
		}
		subscribe(listener) {
			this.listeners.add(listener);
			return () => {
				this.listeners.delete(listener);
			};
		}
		emit() {
			const current = { ...this.state };
			for (const listener of this.listeners) try {
				listener(current);
			} catch {
				this.listeners.delete(listener);
			}
		}
		/** Return the loader service from the current runtime, if registered. */
		getLoader(runtime) {
			if (!runtime) return null;
			const candidate = runtime.getService?.("localInferenceLoader");
			return isLoader(candidate) ? candidate : null;
		}
		async switchTo(runtime, installed) {
			this.state = {
				modelId: installed.id,
				loadedAt: null,
				status: "loading"
			};
			this.emit();
			const loader = this.getLoader(runtime);
			try {
				if (loader) {
					await loader.unloadModel();
					await loader.loadModel({ modelPath: installed.path });
				} else await localInferenceEngine.load(installed.path);
				this.state = {
					modelId: installed.id,
					loadedAt: (/* @__PURE__ */ new Date()).toISOString(),
					status: "ready"
				};
				if (installed.source === "eliza-download") await touchElizaModel(installed.id);
			} catch (err) {
				this.state = {
					modelId: installed.id,
					loadedAt: null,
					status: "error",
					error: err instanceof Error ? err.message : String(err)
				};
			}
			this.emit();
			return this.snapshot();
		}
		async unload(runtime) {
			const loader = this.getLoader(runtime);
			try {
				if (loader) await loader.unloadModel();
				else await localInferenceEngine.unload();
			} catch (err) {
				this.state = {
					modelId: null,
					loadedAt: null,
					status: "error",
					error: err instanceof Error ? err.message : String(err)
				};
				this.emit();
				return this.snapshot();
			}
			this.state = {
				modelId: null,
				loadedAt: null,
				status: "idle"
			};
			this.emit();
			return this.snapshot();
		}
	};
}));

//#endregion
//#region node_modules/.bun/@elizaos+app-core@2.0.0-alpha.537+72829346cb4c43b1/node_modules/@elizaos/app-core/packages/app-core/src/services/local-inference/bundled-models.js
/**
* Bundled-models bootstrap for AOSP / on-device installs.
*
* The AOSP build pipeline stages a small chat model + a small embedding
* model into the APK at `assets/agent/models/{file}.gguf` plus a
* `manifest.json` describing each one (id, role, sha256, sizeBytes).
* `ElizaAgentService.extractAssetsIfNeeded()` copies those files into
* `$ELIZA_STATE_DIR/local-inference/models/` on first launch.
*
* This module reads the manifest at runtime startup and registers each
* file as a eliza-owned model in the local-inference registry, so the
* auto-assign pass picks them up for TEXT_LARGE / TEXT_SMALL /
* TEXT_EMBEDDING slots without needing the user to download anything.
*
* Idempotent: re-running with the registry already populated is a
* no-op for unchanged entries (`upsertElizaModel` overwrites entries
* with the same id, so updated sha256s on a future re-bundle replace
* the old metadata cleanly).
*
* Source classification: the runtime treats bundled models as
* `source: "eliza-download"` because Eliza ships the file and Eliza
* owns it on disk — same lifecycle as a user-initiated download
* (uninstall removes the file, the registry tracks the install). The
* only difference is the file arrived via APK extraction rather than
* an HTTP transfer.
*/
function manifestPath() {
	return path.join(elizaModelsDir(), "manifest.json");
}
async function readManifest() {
	try {
		const raw = await fs$1.readFile(manifestPath(), "utf8");
		const parsed = JSON.parse(raw);
		if (parsed?.version !== 1 || !Array.isArray(parsed.models)) return null;
		return parsed;
	} catch {
		return null;
	}
}
/**
* Walk the manifest and register every bundled GGUF file in the
* local-inference registry. Returns the number of entries successfully
* registered. A missing manifest is normal on Capacitor / desktop /
* non-AOSP installs and returns 0 silently.
*/
async function registerBundledModels() {
	const manifest = await readManifest();
	if (!manifest) return 0;
	const dir = elizaModelsDir();
	let registered = 0;
	for (const entry of manifest.models) {
		const filePath = path.join(dir, entry.ggufFile);
		let sizeBytes = entry.sizeBytes;
		try {
			sizeBytes = (await fs$1.stat(filePath)).size;
		} catch {
			continue;
		}
		await upsertElizaModel({
			id: entry.id,
			displayName: entry.displayName,
			path: filePath,
			sizeBytes,
			hfRepo: entry.hfRepo,
			installedAt: (/* @__PURE__ */ new Date()).toISOString(),
			lastUsedAt: null,
			source: "eliza-download",
			sha256: entry.sha256 ?? void 0
		});
		await ensureDefaultAssignment(entry.id);
		registered += 1;
	}
	return registered;
}
var init_bundled_models = __esmMin((() => {
	init_assignments();
	init_paths();
	init_registry();
}));

//#endregion
//#region node_modules/.bun/@elizaos+app-core@2.0.0-alpha.537+72829346cb4c43b1/node_modules/@elizaos/app-core/packages/app-core/src/services/local-inference/verify.js
/**
* Model-file integrity verification.
*
* GGUF files are large (0.8 – 20 GB). Corrupted files surface as cryptic
* llama.cpp errors much later, so we verify at install time and expose a
* manual verify button for users who want to re-check after a system
* event (crash, disk fill, external tool edited the file, etc).
*
* We don't require SHA256 from HuggingFace — HF doesn't publish per-file
* hashes in the standard API, and hand-curating them in the catalog would
* drift. Instead, after a successful download we compute the SHA256
* ourselves and stash it on the InstalledModel. Re-verify compares the
* file's current hash against the stashed one. A mismatch means the file
* changed on disk since we installed it — user can redownload.
*
* For GGUF specifically we also do a cheap structural header check
* (the file starts with the magic bytes "GGUF") so obvious truncations
* flag instantly without having to hash a 10GB file.
*/
async function fileExists(path) {
	try {
		return (await fs$1.stat(path)).isFile();
	} catch {
		return false;
	}
}
async function isGgufHeader(path) {
	try {
		const fd = await fs$1.open(path, "r");
		try {
			const buf = Buffer.alloc(4);
			await fd.read(buf, 0, 4, 0);
			return buf.equals(GGUF_MAGIC);
		} finally {
			await fd.close();
		}
	} catch {
		return false;
	}
}
async function hashFile(path) {
	return new Promise((resolve, reject) => {
		const hasher = createHash("sha256");
		const stream = fs.createReadStream(path, { highWaterMark: 1 << 20 });
		stream.on("data", (chunk) => {
			hasher.update(chunk);
		});
		stream.on("end", () => resolve(hasher.digest("hex")));
		stream.on("error", reject);
	});
}
/**
* Run the full verification pipeline on a model. Returns the state and
* the freshly computed hash so the caller can persist it to the registry.
*/
async function verifyInstalledModel(model) {
	if (!await fileExists(model.path)) return {
		state: "missing",
		currentSha256: null,
		expectedSha256: model.sha256 ?? null,
		currentBytes: null
	};
	const stat = await fs$1.stat(model.path);
	if (!await isGgufHeader(model.path)) return {
		state: "truncated",
		currentSha256: null,
		expectedSha256: model.sha256 ?? null,
		currentBytes: stat.size
	};
	const currentSha256 = await hashFile(model.path);
	if (!model.sha256) return {
		state: "unknown",
		currentSha256,
		expectedSha256: null,
		currentBytes: stat.size
	};
	return {
		state: currentSha256 === model.sha256 ? "ok" : "mismatch",
		currentSha256,
		expectedSha256: model.sha256,
		currentBytes: stat.size
	};
}
var GGUF_MAGIC;
var init_verify = __esmMin((() => {
	GGUF_MAGIC = Buffer.from("GGUF", "ascii");
}));

//#endregion
//#region node_modules/.bun/@elizaos+app-core@2.0.0-alpha.537+72829346cb4c43b1/node_modules/@elizaos/app-core/packages/app-core/src/services/local-inference/downloader.js
/**
* Resumable GGUF downloader.
*
* Streams directly from HuggingFace to a staging file under
* `$STATE_DIR/local-inference/downloads/<id>.part`, then atomically moves
* it into `models/<id>.gguf` on success. On restart the staging file is
* still there; `resumeIfPossible` sends a Range request starting at the
* current partial size.
*
* Concurrency model: at most one download per model id. Callers use
* `subscribe()` to receive progress events; the service facade wires that
* to SSE.
*
* The runtime `fetch` follows HuggingFace redirects and still gives us a body
* stream that can be piped into a Node WriteStream.
*/
function stagingFilename(modelId) {
	return `${modelId.replace(/[^a-zA-Z0-9._-]/g, "_")}.part`;
}
function finalFilename(model) {
	return `${model.id.replace(/[^a-zA-Z0-9._-]/g, "_")}.gguf`;
}
async function ensureDirs() {
	await fs$1.mkdir(downloadsStagingDir(), { recursive: true });
	await fs$1.mkdir(elizaModelsDir(), { recursive: true });
}
async function partialSize(stagingPath) {
	try {
		const stat = await fs$1.stat(stagingPath);
		return stat.isFile() ? stat.size : 0;
	} catch {
		return 0;
	}
}
var PROGRESS_THROTTLE_MS, Downloader;
var init_downloader = __esmMin((() => {
	init_assignments();
	init_catalog();
	init_paths();
	init_registry();
	init_verify();
	PROGRESS_THROTTLE_MS = 250;
	Downloader = class {
		active = /* @__PURE__ */ new Map();
		listeners = /* @__PURE__ */ new Set();
		lastEmit = /* @__PURE__ */ new Map();
		subscribe(listener) {
			this.listeners.add(listener);
			return () => {
				this.listeners.delete(listener);
			};
		}
		snapshot() {
			return [...this.active.values()].map((a) => ({ ...a.job }));
		}
		isActive(modelId) {
			const current = this.active.get(modelId);
			return !!current && (current.job.state === "queued" || current.job.state === "downloading");
		}
		/**
		* Start a download for a model. Accepts either a curated catalog id, or
		* a full `CatalogModel` spec for ad-hoc HF-search results. Idempotent —
		* returns the existing job if one is already running for the same id.
		*/
		async start(modelIdOrSpec) {
			const catalogEntry = typeof modelIdOrSpec === "string" ? findCatalogModel(modelIdOrSpec) : modelIdOrSpec;
			if (!catalogEntry) throw new Error(`Unknown model id: ${typeof modelIdOrSpec === "string" ? modelIdOrSpec : "(no id)"}`);
			const modelId = catalogEntry.id;
			const existing = this.active.get(modelId);
			if (existing && (existing.job.state === "queued" || existing.job.state === "downloading")) return { ...existing.job };
			await ensureDirs();
			const stagingPath = path.join(downloadsStagingDir(), stagingFilename(modelId));
			const finalPath = path.join(elizaModelsDir(), finalFilename(catalogEntry));
			const job = {
				jobId: randomUUID(),
				modelId,
				state: "queued",
				received: await partialSize(stagingPath),
				total: Math.round(catalogEntry.sizeGb * 1024 ** 3),
				bytesPerSec: 0,
				etaMs: null,
				startedAt: (/* @__PURE__ */ new Date()).toISOString(),
				updatedAt: (/* @__PURE__ */ new Date()).toISOString()
			};
			const record = {
				job,
				abortController: new AbortController(),
				stagingPath,
				finalPath
			};
			this.active.set(modelId, record);
			this.runJob(catalogEntry, record).catch(() => {});
			this.emit({
				type: "progress",
				job: { ...job }
			});
			return { ...job };
		}
		cancel(modelId) {
			const record = this.active.get(modelId);
			if (!record) return false;
			if (record.job.state !== "downloading" && record.job.state !== "queued") return false;
			record.abortController.abort();
			this.updateState(record, "cancelled");
			this.emit({
				type: "cancelled",
				job: { ...record.job }
			});
			this.active.delete(modelId);
			return true;
		}
		emit(event) {
			for (const listener of this.listeners) try {
				listener(event);
			} catch {
				this.listeners.delete(listener);
			}
		}
		updateState(record, state) {
			record.job.state = state;
			record.job.updatedAt = (/* @__PURE__ */ new Date()).toISOString();
		}
		throttleEmit(record) {
			const now = Date.now();
			if (now - (this.lastEmit.get(record.job.modelId) ?? 0) < PROGRESS_THROTTLE_MS) return;
			this.lastEmit.set(record.job.modelId, now);
			this.emit({
				type: "progress",
				job: { ...record.job }
			});
		}
		async runJob(catalogEntry, record) {
			try {
				this.updateState(record, "downloading");
				const url = buildHuggingFaceResolveUrl(catalogEntry);
				const httpClient = await this.loadHttpClient();
				const startByte = record.job.received;
				const headers = { "user-agent": "Eliza-LocalInference/1.0" };
				if (startByte > 0) headers.range = `bytes=${startByte}-`;
				const response = await httpClient.request(url, {
					method: "GET",
					headers,
					signal: record.abortController.signal
				});
				if (response.statusCode >= 400) throw new Error(`HTTP ${response.statusCode} from HuggingFace for ${catalogEntry.hfRepo}`);
				const contentLengthHeader = response.headers["content-length"];
				const contentLength = Array.isArray(contentLengthHeader) ? Number.parseInt(contentLengthHeader[0] ?? "0", 10) : Number.parseInt(contentLengthHeader ?? "0", 10);
				if (Number.isFinite(contentLength) && contentLength > 0) record.job.total = startByte + contentLength;
				const writeStream = fs.createWriteStream(record.stagingPath, { flags: startByte > 0 ? "a" : "w" });
				let lastSampleBytes = record.job.received;
				let lastSampleAt = Date.now();
				const bodyStream = Readable.from(response.body);
				bodyStream.on("data", (chunk) => {
					record.job.received += chunk.length;
					const now = Date.now();
					const elapsed = now - lastSampleAt;
					if (elapsed >= 1e3) {
						record.job.bytesPerSec = (record.job.received - lastSampleBytes) * 1e3 / elapsed;
						record.job.etaMs = record.job.bytesPerSec > 0 ? (record.job.total - record.job.received) * 1e3 / record.job.bytesPerSec : null;
						lastSampleAt = now;
						lastSampleBytes = record.job.received;
					}
					this.throttleEmit(record);
				});
				await pipeline(bodyStream, writeStream);
				await fs$1.rename(record.stagingPath, record.finalPath);
				const finalStat = await fs$1.stat(record.finalPath);
				const sha256 = await hashFile(record.finalPath);
				const installed = {
					id: catalogEntry.id,
					displayName: catalogEntry.displayName,
					path: record.finalPath,
					sizeBytes: finalStat.size,
					hfRepo: catalogEntry.hfRepo,
					installedAt: (/* @__PURE__ */ new Date()).toISOString(),
					lastUsedAt: null,
					source: "eliza-download",
					sha256,
					lastVerifiedAt: (/* @__PURE__ */ new Date()).toISOString()
				};
				await upsertElizaModel(installed);
				await ensureDefaultAssignment(installed.id);
				this.updateState(record, "completed");
				record.job.received = finalStat.size;
				record.job.total = finalStat.size;
				this.emit({
					type: "completed",
					job: { ...record.job }
				});
			} catch (err) {
				if (record.abortController.signal.aborted) {
					this.updateState(record, "cancelled");
					this.emit({
						type: "cancelled",
						job: { ...record.job }
					});
				} else {
					this.updateState(record, "failed");
					record.job.error = err instanceof Error ? err.message : String(err);
					this.emit({
						type: "failed",
						job: { ...record.job }
					});
				}
			} finally {
				this.active.delete(record.job.modelId);
			}
		}
		async loadHttpClient() {
			const fetchImpl = globalThis.fetch;
			return { request: async (url, options) => {
				const response = await fetchImpl(url, {
					method: options.method,
					headers: options.headers,
					signal: options.signal,
					redirect: "follow"
				});
				if (!response.body) throw new Error(`Empty response body from ${url}`);
				return {
					statusCode: response.status,
					headers: Object.fromEntries(response.headers.entries()),
					body: Readable.fromWeb(response.body)
				};
			} };
		}
	};
}));

//#endregion
//#region node_modules/.bun/@elizaos+app-core@2.0.0-alpha.537+72829346cb4c43b1/node_modules/@elizaos/app-core/packages/app-core/src/services/local-inference/hardware.js
/**
* Hardware probe for local inference sizing.
*
* Uses `node-llama-cpp` when available to read GPU backend + VRAM. Falls back
* to Node's `os` module when the binding isn't installed — we don't require
* the plugin to be loaded for the probe endpoint to return useful data.
*
* Dynamic import is intentional: the binding pulls a native prebuilt that we
* don't want eagerly required at module-load time (breaks CI environments
* without the trusted-dependency flag).
*/
function bytesToGb(bytes) {
	return Math.round(bytes / BYTES_PER_GB * 10) / 10;
}
/**
* Pick a default bucket based on total available memory and architecture.
*
* On Apple Silicon the GPU shares system RAM, so shared memory acts as VRAM.
* On discrete-GPU x86 boxes we weight VRAM higher than system RAM.
*/
function recommendBucket(totalRamGb, vramGb, appleSilicon) {
	const effective = appleSilicon ? totalRamGb : vramGb > 0 ? Math.max(vramGb * 1.25, totalRamGb * .5) : totalRamGb * .5;
	if (effective >= 36) return "xl";
	if (effective >= 18) return "large";
	if (effective >= 9) return "mid";
	return "small";
}
async function loadLlamaBinding() {
	try {
		const mod = await import("node-llama-cpp");
		if (mod && typeof mod === "object" && "getLlama" in mod && typeof mod.getLlama === "function") return mod;
		return null;
	} catch {
		return null;
	}
}
/**
* Read current system + GPU state. Cheap enough to call per-request; no
* internal caching so the UI always reflects live VRAM usage.
*/
async function probeHardware() {
	const totalRamBytes = os.totalmem();
	const freeRamBytes = os.freemem();
	const cpuCores = os.cpus().length;
	const platform = process.platform;
	const arch = process.arch;
	const appleSilicon = platform === "darwin" && arch === "arm64";
	const binding = await loadLlamaBinding();
	if (!binding) {
		const totalRamGb = bytesToGb(totalRamBytes);
		return {
			totalRamGb,
			freeRamGb: bytesToGb(freeRamBytes),
			gpu: null,
			cpuCores,
			platform,
			arch,
			appleSilicon,
			recommendedBucket: recommendBucket(totalRamGb, 0, appleSilicon),
			source: "os-fallback"
		};
	}
	const llama = await binding.getLlama({ gpu: "auto" });
	const totalRamGb = bytesToGb(totalRamBytes);
	const freeRamGb = bytesToGb(freeRamBytes);
	if (llama.gpu === false) return {
		totalRamGb,
		freeRamGb,
		gpu: null,
		cpuCores,
		platform,
		arch,
		appleSilicon,
		recommendedBucket: recommendBucket(totalRamGb, 0, appleSilicon),
		source: "node-llama-cpp"
	};
	const vram = await llama.getVramState();
	const totalVramGb = bytesToGb(vram.total);
	const freeVramGb = bytesToGb(vram.free);
	return {
		totalRamGb,
		freeRamGb,
		gpu: {
			backend: llama.gpu,
			totalVramGb,
			freeVramGb
		},
		cpuCores,
		platform,
		arch,
		appleSilicon,
		recommendedBucket: recommendBucket(totalRamGb, totalVramGb, appleSilicon),
		source: "node-llama-cpp"
	};
}
var BYTES_PER_GB;
var init_hardware = __esmMin((() => {
	BYTES_PER_GB = 1024 ** 3;
}));

//#endregion
//#region node_modules/.bun/@elizaos+app-core@2.0.0-alpha.537+72829346cb4c43b1/node_modules/@elizaos/app-core/packages/app-core/src/services/local-inference/hf-search.js
function pickQuantFile(siblings) {
	const ggufs = siblings.filter((s) => s.rfilename?.toLowerCase().endsWith(".gguf"));
	if (ggufs.length === 0) return null;
	for (const quant of QUANT_PREFERENCE) {
		const match = ggufs.find((s) => s.rfilename?.toUpperCase().includes(quant));
		if (match) return match;
	}
	return [...ggufs].sort((a, b) => (a.size ?? 0) - (b.size ?? 0))[0] ?? null;
}
function extractQuantLabel(filename) {
	for (const quant of QUANT_PREFERENCE) if (filename.toUpperCase().includes(quant)) return quant;
	return "GGUF";
}
/**
* Very rough parameter-count inference from model name / tags. We use this
* only to pick a bucket label — not for any hard memory check.
*/
function inferParams(name, tags) {
	const lower = `${name} ${tags.join(" ")}`.toLowerCase();
	for (const [re, params, bucket] of [
		[
			/\b70b\b/,
			"70B",
			"xl"
		],
		[
			/\b32b\b/,
			"32B",
			"xl"
		],
		[
			/\b27b\b/,
			"27B",
			"large"
		],
		[
			/\b24b\b/,
			"24B",
			"large"
		],
		[
			/\b22b\b/,
			"22B",
			"large"
		],
		[
			/\b16b\b/,
			"16B",
			"large"
		],
		[
			/\b14b\b/,
			"14B",
			"large"
		],
		[
			/\b13b\b/,
			"14B",
			"large"
		],
		[
			/\b9b\b/,
			"9B",
			"mid"
		],
		[
			/\b8b\b/,
			"8B",
			"mid"
		],
		[
			/\b7b\b/,
			"7B",
			"mid"
		],
		[
			/\b3b\b/,
			"3B",
			"small"
		],
		[
			/\b1\.7b\b/,
			"1.7B",
			"small"
		],
		[
			/\b1b\b/,
			"1B",
			"small"
		]
	]) if (re.test(lower)) return {
		params,
		bucket
	};
	return {
		params: "7B",
		bucket: "mid"
	};
}
function inferCategory(tags, pipelineTag) {
	const lowerTags = tags.map((t) => t.toLowerCase());
	if (lowerTags.some((t) => t.includes("code") || t.includes("coder"))) return "code";
	if (lowerTags.some((t) => t.includes("reasoning") || t === "math" || t.includes("r1"))) return "reasoning";
	if (lowerTags.some((t) => t.includes("function") || t.includes("tool") || t.includes("hermes"))) return "tools";
	if (pipelineTag === "text-generation") return "chat";
	return "chat";
}
async function fetchWithTimeout(url, init) {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), SEARCH_TIMEOUT_MS);
	try {
		return await fetch(url, {
			...init,
			signal: controller.signal
		});
	} finally {
		clearTimeout(timer);
	}
}
/**
* Search HuggingFace for GGUF repos matching `query`, returning
* catalog-shaped entries ready for the Model Hub UI.
*/
async function searchHuggingFaceGguf(query, limit = 12) {
	const trimmed = query.trim();
	if (trimmed.length === 0) return [];
	const searchUrl = new URL(`${HF_API}/models`);
	searchUrl.searchParams.set("search", trimmed);
	searchUrl.searchParams.set("filter", "gguf");
	searchUrl.searchParams.set("limit", String(Math.min(50, Math.max(1, limit * 2))));
	searchUrl.searchParams.set("sort", "downloads");
	searchUrl.searchParams.set("direction", "-1");
	const searchRes = await fetchWithTimeout(searchUrl.toString(), { headers: { accept: "application/json" } });
	if (!searchRes.ok) throw new Error(`HuggingFace search failed: HTTP ${searchRes.status}`);
	const candidates = (await searchRes.json()).map((r) => r.id ?? r.modelId).filter((id) => typeof id === "string" && id.length > 0).slice(0, limit);
	const details = await Promise.all(candidates.map(async (id) => {
		try {
			const res = await fetchWithTimeout(`${HF_API}/models/${encodeURIComponent(id)}`, { headers: { accept: "application/json" } });
			if (!res.ok) return null;
			return await res.json();
		} catch {
			return null;
		}
	}));
	const results = [];
	for (let i = 0; i < candidates.length; i++) {
		const id = candidates[i];
		const detail = details[i];
		if (!id || !detail?.siblings) continue;
		const sibling = pickQuantFile(detail.siblings);
		if (!sibling?.rfilename) continue;
		const sizeBytes = sibling.size ?? 0;
		const sizeGb = sizeBytes > 0 ? sizeBytes / 1024 ** 3 : 4;
		const { params, bucket } = inferParams(id, detail.tags ?? []);
		const quant = extractQuantLabel(sibling.rfilename);
		const category = inferCategory(detail.tags ?? [], detail.pipeline_tag);
		const displayName = id.split("/").pop() ?? id;
		const minRamGb = Math.max(4, Math.round(sizeGb * 2));
		results.push({
			id: `hf:${id}::${sibling.rfilename}`,
			displayName,
			hfRepo: id,
			ggufFile: sibling.rfilename,
			params,
			quant,
			sizeGb: Math.round(sizeGb * 10) / 10,
			minRamGb,
			category,
			bucket,
			blurb: (detail.tags ?? []).slice(0, 4).join(" · ") || `${detail.downloads ?? 0} downloads · ${detail.likes ?? 0} likes`
		});
	}
	return results;
}
var HF_API, SEARCH_TIMEOUT_MS, QUANT_PREFERENCE;
var init_hf_search = __esmMin((() => {
	HF_API = "https://huggingface.co/api";
	SEARCH_TIMEOUT_MS = 1e4;
	QUANT_PREFERENCE = [
		"Q4_K_M",
		"Q5_K_M",
		"Q4_0",
		"Q5_0",
		"Q3_K_M",
		"Q8_0",
		"Q2_K"
	];
}));

//#endregion
//#region node_modules/.bun/@elizaos+app-core@2.0.0-alpha.537+72829346cb4c43b1/node_modules/@elizaos/app-core/packages/app-core/src/services/local-inference/service.js
var LocalInferenceService, localInferenceService;
var init_service = __esmMin((() => {
	init_active_model();
	init_assignments();
	init_bundled_models();
	init_catalog();
	init_downloader();
	init_hardware();
	init_hf_search();
	init_registry();
	init_verify();
	LocalInferenceService = class {
		downloader = new Downloader();
		activeModel = new ActiveModelCoordinator();
		bundledBootstrap = null;
		getCatalog() {
			return MODEL_CATALOG;
		}
		/**
		* Register any bundled GGUF files staged by the AOSP build (or any
		* other install path that drops a `manifest.json` next to the model
		* files) into the registry. Runs at most once per process; the
		* promise is cached so concurrent first callers wait on the same
		* work.
		*/
		bootstrapBundled() {
			if (!this.bundledBootstrap) this.bundledBootstrap = registerBundledModels().then(() => void 0).catch(() => void 0);
			return this.bundledBootstrap;
		}
		async getInstalled() {
			await this.bootstrapBundled();
			return listInstalledModels();
		}
		async getHardware() {
			return probeHardware();
		}
		getDownloads() {
			return this.downloader.snapshot();
		}
		getActive() {
			return this.activeModel.snapshot();
		}
		async getAssignments() {
			return readEffectiveAssignments();
		}
		async setSlotAssignment(slot, modelId) {
			await setAssignment(slot, modelId);
			return readEffectiveAssignments();
		}
		async snapshot() {
			const [installed, hardware, assignments] = await Promise.all([
				this.getInstalled(),
				this.getHardware(),
				this.getAssignments()
			]);
			return {
				catalog: this.getCatalog(),
				installed,
				active: this.getActive(),
				downloads: this.getDownloads(),
				hardware,
				assignments
			};
		}
		async startDownload(modelIdOrSpec) {
			return this.downloader.start(modelIdOrSpec);
		}
		async searchHuggingFace(query, limit) {
			return searchHuggingFaceGguf(query, limit);
		}
		/**
		* Verify an installed model's file integrity. When the model was a
		* Eliza-download and there was no stored sha256 yet (legacy entry), the
		* computed hash is persisted so subsequent verifies have a baseline.
		*/
		async verifyModel(id) {
			const model = (await listInstalledModels()).find((m) => m.id === id);
			if (!model) throw new Error(`Model not installed: ${id}`);
			const result = await verifyInstalledModel(model);
			if (result.state === "unknown" && result.currentSha256 && model.source === "eliza-download") {
				await upsertElizaModel({
					...model,
					sha256: result.currentSha256,
					lastVerifiedAt: (/* @__PURE__ */ new Date()).toISOString()
				});
				return {
					...result,
					state: "ok",
					expectedSha256: result.currentSha256
				};
			}
			if (result.state === "ok" && model.source === "eliza-download") await upsertElizaModel({
				...model,
				lastVerifiedAt: (/* @__PURE__ */ new Date()).toISOString()
			});
			return result;
		}
		cancelDownload(modelId) {
			return this.downloader.cancel(modelId);
		}
		subscribeDownloads(listener) {
			return this.downloader.subscribe(listener);
		}
		subscribeActive(listener) {
			return this.activeModel.subscribe(listener);
		}
		async setActive(runtime, modelId) {
			const installed = (await this.getInstalled()).find((m) => m.id === modelId);
			if (!installed) throw new Error(`Model not installed: ${modelId}`);
			return this.activeModel.switchTo(runtime, installed);
		}
		async clearActive(runtime) {
			return this.activeModel.unload(runtime);
		}
		async uninstall(modelId) {
			if (this.activeModel.snapshot().modelId === modelId) await this.activeModel.unload(null);
			return removeElizaModel(modelId);
		}
	};
	localInferenceService = new LocalInferenceService();
}));

//#endregion
//#region node_modules/.bun/@elizaos+app-core@2.0.0-alpha.537+72829346cb4c43b1/node_modules/@elizaos/app-core/packages/app-core/src/api/local-inference-compat-routes.js
function isStreamAuthorized(req, res, url) {
	const expected = getCompatApiToken$1();
	if (!expected) return true;
	const headerToken = getProvidedApiToken(req);
	const queryToken = url.searchParams.get("token")?.trim();
	if (headerToken && tokenMatches(expected, headerToken) || queryToken && tokenMatches(expected, queryToken)) return true;
	res.writeHead(401, { "Content-Type": "application/json" });
	res.end(JSON.stringify({ error: "Unauthorized" }));
	return false;
}
function writeSseEvent(res, payload) {
	res.write(`data: ${JSON.stringify(payload)}\n\n`);
}
function stringBody(body, key) {
	if (!body) return null;
	const raw = body[key];
	return typeof raw === "string" && raw.trim().length > 0 ? raw.trim() : null;
}
/**
* Match POST/DELETE/GET for `/api/local-inference/installed/:id`.
* Returns the trimmed id or null.
*/
function matchInstalledId(pathname) {
	return /^\/api\/local-inference\/installed\/([^/]+)$/.exec(pathname)?.[1] ?? null;
}
async function handleLocalInferenceCompatRoutes(req, res, state) {
	const method = (req.method ?? "GET").toUpperCase();
	const url = new URL(req.url ?? "/", "http://localhost");
	const pathname = url.pathname;
	if (!pathname.startsWith("/api/local-inference/")) return false;
	if (method === "GET" && pathname === "/api/local-inference/downloads/stream") {
		if (!isStreamAuthorized(req, res, url)) return true;
		res.writeHead(200, {
			"Content-Type": "text/event-stream",
			"Cache-Control": "no-cache, no-transform",
			Connection: "keep-alive",
			"X-Accel-Buffering": "no"
		});
		writeSseEvent(res, {
			type: "snapshot",
			downloads: localInferenceService.getDownloads(),
			active: localInferenceService.getActive()
		});
		const unsubscribeDownloads = localInferenceService.subscribeDownloads((event) => {
			writeSseEvent(res, {
				type: event.type,
				job: event.job
			});
		});
		const unsubscribeActive = localInferenceService.subscribeActive((active) => {
			writeSseEvent(res, {
				type: "active",
				active
			});
		});
		const heartbeat = setInterval(() => {
			res.write(": heartbeat\n\n");
		}, 15e3);
		if (typeof heartbeat === "object" && "unref" in heartbeat) heartbeat.unref();
		const cleanup = () => {
			clearInterval(heartbeat);
			unsubscribeDownloads();
			unsubscribeActive();
		};
		req.on("close", cleanup);
		req.on("aborted", cleanup);
		return true;
	}
	if (method === "GET" && pathname === "/api/local-inference/hub") {
		if (!await ensureRouteAuthorized(req, res, state)) return true;
		try {
			sendJson$2(res, 200, await localInferenceService.snapshot());
		} catch (err) {
			sendJsonError(res, 500, err instanceof Error ? err.message : "Failed to load hub");
		}
		return true;
	}
	if (method === "GET" && pathname === "/api/local-inference/hardware") {
		if (!await ensureRouteAuthorized(req, res, state)) return true;
		try {
			sendJson$2(res, 200, await localInferenceService.getHardware());
		} catch (err) {
			sendJsonError(res, 500, err instanceof Error ? err.message : "Failed to probe hardware");
		}
		return true;
	}
	if (method === "GET" && pathname === "/api/local-inference/catalog") {
		if (!await ensureRouteAuthorized(req, res, state)) return true;
		sendJson$2(res, 200, { models: localInferenceService.getCatalog() });
		return true;
	}
	if (method === "GET" && pathname === "/api/local-inference/installed") {
		if (!await ensureRouteAuthorized(req, res, state)) return true;
		try {
			sendJson$2(res, 200, { models: await localInferenceService.getInstalled() });
		} catch (err) {
			sendJsonError(res, 500, err instanceof Error ? err.message : "Failed to list installed models");
		}
		return true;
	}
	if (method === "POST" && pathname === "/api/local-inference/downloads") {
		if (!ensureCompatSensitiveRouteAuthorized(req, res)) return true;
		const body = await readCompatJsonBody(req, res);
		if (!body) return true;
		const modelId = stringBody(body, "modelId");
		const rawSpec = body.spec;
		try {
			let job;
			if (rawSpec && typeof rawSpec === "object" && !Array.isArray(rawSpec)) job = await localInferenceService.startDownload(rawSpec);
			else if (modelId) job = await localInferenceService.startDownload(modelId);
			else {
				sendJsonError(res, 400, "modelId or spec is required");
				return true;
			}
			sendJson$2(res, 202, { job });
		} catch (err) {
			sendJsonError(res, 400, err instanceof Error ? err.message : "Failed to start download");
		}
		return true;
	}
	if (method === "GET" && pathname === "/api/local-inference/providers") {
		if (!await ensureRouteAuthorized(req, res, state)) return true;
		try {
			sendJson$2(res, 200, { providers: await snapshotProviders() });
		} catch (err) {
			sendJsonError(res, 500, err instanceof Error ? err.message : "Failed to read providers");
		}
		return true;
	}
	if (method === "GET" && pathname === "/api/local-inference/routing") {
		if (!await ensureRouteAuthorized(req, res, state)) return true;
		try {
			const [prefs, registrations] = await Promise.all([readRoutingPreferences(), Promise.resolve(handlerRegistry.getAll().map(toPublicRegistration))]);
			sendJson$2(res, 200, {
				registrations,
				preferences: prefs
			});
		} catch (err) {
			sendJsonError(res, 500, err instanceof Error ? err.message : "Failed to read routing state");
		}
		return true;
	}
	if (method === "POST" && pathname === "/api/local-inference/routing/preferred") {
		if (!ensureCompatSensitiveRouteAuthorized(req, res)) return true;
		const body = await readCompatJsonBody(req, res);
		if (!body) return true;
		const slot = stringBody(body, "slot");
		if (!slot || !AGENT_MODEL_SLOTS.includes(slot)) {
			sendJsonError(res, 400, "slot is required and must be a valid AgentModelSlot");
			return true;
		}
		const raw = body.provider;
		const provider = raw === null ? null : typeof raw === "string" && raw.trim().length > 0 ? raw.trim() : null;
		try {
			sendJson$2(res, 200, { preferences: await setPreferredProvider(slot, provider) });
		} catch (err) {
			sendJsonError(res, 500, err instanceof Error ? err.message : "Failed to write preferred provider");
		}
		return true;
	}
	if (method === "POST" && pathname === "/api/local-inference/routing/policy") {
		if (!ensureCompatSensitiveRouteAuthorized(req, res)) return true;
		const body = await readCompatJsonBody(req, res);
		if (!body) return true;
		const slot = stringBody(body, "slot");
		if (!slot || !AGENT_MODEL_SLOTS.includes(slot)) {
			sendJsonError(res, 400, "slot is required and must be a valid AgentModelSlot");
			return true;
		}
		const raw = body.policy;
		const validPolicies = [
			"manual",
			"cheapest",
			"fastest",
			"prefer-local",
			"round-robin"
		];
		const policy = raw === null ? null : typeof raw === "string" && validPolicies.includes(raw) ? raw : null;
		if (raw !== null && policy === null) {
			sendJsonError(res, 400, `policy must be one of ${validPolicies.join(", ")} or null`);
			return true;
		}
		try {
			sendJson$2(res, 200, { preferences: await setPolicy(slot, policy) });
		} catch (err) {
			sendJsonError(res, 500, err instanceof Error ? err.message : "Failed to write routing policy");
		}
		return true;
	}
	if (method === "GET" && pathname === "/api/local-inference/assignments") {
		if (!await ensureRouteAuthorized(req, res, state)) return true;
		try {
			sendJson$2(res, 200, { assignments: await localInferenceService.getAssignments() });
		} catch (err) {
			sendJsonError(res, 500, err instanceof Error ? err.message : "Failed to read assignments");
		}
		return true;
	}
	if (method === "POST" && pathname === "/api/local-inference/assignments") {
		if (!ensureCompatSensitiveRouteAuthorized(req, res)) return true;
		const body = await readCompatJsonBody(req, res);
		if (!body) return true;
		const slot = stringBody(body, "slot");
		if (!slot || !AGENT_MODEL_SLOTS.includes(slot)) {
			sendJsonError(res, 400, `slot must be one of ${AGENT_MODEL_SLOTS.join(", ")}`);
			return true;
		}
		const rawModelId = body.modelId;
		const modelId = rawModelId === null ? null : typeof rawModelId === "string" && rawModelId.trim().length > 0 ? rawModelId.trim() : null;
		try {
			sendJson$2(res, 200, { assignments: await localInferenceService.setSlotAssignment(slot, modelId) });
		} catch (err) {
			sendJsonError(res, 500, err instanceof Error ? err.message : "Failed to write assignment");
		}
		return true;
	}
	if (method === "GET" && pathname === "/api/local-inference/device") {
		if (!await ensureRouteAuthorized(req, res, state)) return true;
		sendJson$2(res, 200, deviceBridge.status());
		return true;
	}
	if (method === "GET" && pathname === "/api/local-inference/device/stream") {
		if (!isStreamAuthorized(req, res, url)) return true;
		res.writeHead(200, {
			"Content-Type": "text/event-stream",
			"Cache-Control": "no-cache, no-transform",
			Connection: "keep-alive",
			"X-Accel-Buffering": "no"
		});
		writeSseEvent(res, {
			type: "status",
			status: deviceBridge.status()
		});
		const unsubscribe = deviceBridge.subscribeStatus((status) => {
			writeSseEvent(res, {
				type: "status",
				status
			});
		});
		const heartbeat = setInterval(() => {
			res.write(": heartbeat\n\n");
		}, 15e3);
		if (typeof heartbeat === "object" && "unref" in heartbeat) heartbeat.unref();
		const cleanup = () => {
			clearInterval(heartbeat);
			unsubscribe();
		};
		req.on("close", cleanup);
		req.on("aborted", cleanup);
		return true;
	}
	if (method === "GET" && pathname === "/api/local-inference/hf-search") {
		if (!await ensureRouteAuthorized(req, res, state)) return true;
		const q = url.searchParams.get("q")?.trim() ?? "";
		if (q.length === 0) {
			sendJson$2(res, 200, { models: [] });
			return true;
		}
		const limitRaw = url.searchParams.get("limit");
		const limit = limitRaw ? Math.max(1, Math.min(50, Number.parseInt(limitRaw, 10) || 12)) : 12;
		try {
			sendJson$2(res, 200, { models: await localInferenceService.searchHuggingFace(q, limit) });
		} catch (err) {
			sendJsonError(res, 502, err instanceof Error ? err.message : "HuggingFace search failed");
		}
		return true;
	}
	{
		const match = /^\/api\/local-inference\/downloads\/([^/]+)$/.exec(pathname);
		if (method === "DELETE" && match) {
			if (!ensureCompatSensitiveRouteAuthorized(req, res)) return true;
			const cancelled = localInferenceService.cancelDownload(match[1] ?? "");
			sendJson$2(res, cancelled ? 200 : 404, { cancelled });
			return true;
		}
	}
	if (method === "GET" && pathname === "/api/local-inference/active") {
		if (!await ensureRouteAuthorized(req, res, state)) return true;
		sendJson$2(res, 200, localInferenceService.getActive());
		return true;
	}
	if (method === "POST" && pathname === "/api/local-inference/active") {
		if (!ensureCompatSensitiveRouteAuthorized(req, res)) return true;
		const body = await readCompatJsonBody(req, res);
		if (!body) return true;
		const modelId = stringBody(body, "modelId");
		if (!modelId) {
			sendJsonError(res, 400, "modelId is required");
			return true;
		}
		try {
			sendJson$2(res, 200, await localInferenceService.setActive(state.current, modelId));
		} catch (err) {
			sendJsonError(res, 400, err instanceof Error ? err.message : "Failed to set active model");
		}
		return true;
	}
	if (method === "DELETE" && pathname === "/api/local-inference/active") {
		if (!ensureCompatSensitiveRouteAuthorized(req, res)) return true;
		try {
			sendJson$2(res, 200, await localInferenceService.clearActive(state.current));
		} catch (err) {
			sendJsonError(res, 500, err instanceof Error ? err.message : "Failed to unload model");
		}
		return true;
	}
	{
		const match = /^\/api\/local-inference\/installed\/([^/]+)\/verify$/.exec(pathname);
		if (method === "POST" && match) {
			if (!await ensureRouteAuthorized(req, res, state)) return true;
			try {
				sendJson$2(res, 200, await localInferenceService.verifyModel(match[1] ?? ""));
			} catch (err) {
				sendJsonError(res, 404, err instanceof Error ? err.message : "Failed to verify model");
			}
			return true;
		}
	}
	{
		const id = matchInstalledId(pathname);
		if (method === "DELETE" && id) {
			if (!ensureCompatSensitiveRouteAuthorized(req, res)) return true;
			try {
				const result = await localInferenceService.uninstall(id);
				if (result.removed) sendJson$2(res, 200, { removed: true });
				else if (result.reason === "external") sendJsonError(res, 409, "Model was discovered from another tool; Eliza will not delete files it does not own");
				else sendJsonError(res, 404, "Model not installed");
			} catch (err) {
				sendJsonError(res, 500, err instanceof Error ? err.message : "Failed to uninstall model");
			}
			return true;
		}
	}
	return false;
}
var init_local_inference_compat_routes = __esmMin((() => {
	init_device_bridge();
	init_handler_registry();
	init_providers();
	init_routing_preferences();
	init_service();
	init_types$1();
	init_auth$1();
	init_compat_route_shared();
	init_response();
}));

//#endregion
//#region node_modules/.bun/@elizaos+app-core@2.0.0-alpha.537+72829346cb4c43b1/node_modules/@elizaos/app-core/packages/app-core/src/api/onboarding-compat-routes.js
async function syncCompatOnboardingConfigState(req, config) {
	const loopbackPort = req.socket.localPort;
	if (!loopbackPort) return;
	const syncPatch = {};
	for (const key of [
		"meta",
		"agents",
		"ui",
		"messages",
		"deploymentTarget",
		"linkedAccounts",
		"serviceRouting",
		"features",
		"connectors",
		"cloud"
	]) if (Object.hasOwn(config, key)) syncPatch[key] = config[key];
	if (Object.keys(syncPatch).length === 0) return;
	const headers = { "content-type": "application/json" };
	const authorization = req.headers.authorization;
	if (typeof authorization === "string" && authorization.trim()) headers.authorization = authorization;
	const response = await fetch(`http://127.0.0.1:${loopbackPort}/api/config`, {
		method: "PUT",
		headers,
		body: JSON.stringify(syncPatch)
	});
	if (!response.ok) throw new Error(`Loopback config sync failed (${response.status}): ${await response.text()}`);
}
function scheduleCloudApiKeyResave(apiKey) {
	setTimeout(() => {
		try {
			const freshConfig = loadElizaConfig();
			if (!freshConfig.cloud?.apiKey) {
				if (!freshConfig.cloud) freshConfig.cloud = {};
				freshConfig.cloud.apiKey = apiKey;
				migrateLegacyRuntimeConfig(freshConfig);
				saveElizaConfig(freshConfig);
				logger.info("[api] Re-saved cloud.apiKey after upstream handler clobbered it");
			}
		} catch {}
	}, 3e3);
}
async function handleOnboardingCompatRoute(req, res, state) {
	const method = (req.method ?? "GET").toUpperCase();
	const url = new URL(req.url ?? "/", "http://localhost");
	if (method !== "POST" || url.pathname !== "/api/onboarding") return false;
	if (!await ensureRouteAuthorized(req, res, state)) return true;
	const chunks = [];
	try {
		for await (const chunk of req) chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
	} catch {
		req.push(null);
		return false;
	}
	const rawBody = Buffer.concat(chunks);
	let capturedCloudApiKey;
	try {
		const body = JSON.parse(rawBody.toString("utf8"));
		if (hasLegacyOnboardingRequestFields(body)) {
			sendJson$2(res, 400, { error: "legacy onboarding payloads are no longer supported; send deploymentTarget, linkedAccounts, serviceRouting, and credentialInputs" });
			return true;
		}
		await extractAndPersistOnboardingApiKey(body);
		persistCompatOnboardingDefaults(body);
		if (typeof body.name === "string" && body.name.trim()) state.pendingAgentName = body.name.trim();
		const { replayBody: replayBodyRecord } = deriveCompatOnboardingReplayBody(body);
		const replayDeploymentTarget = normalizeDeploymentTargetConfig(replayBodyRecord.deploymentTarget);
		const replayLinkedAccounts = normalizeLinkedAccountsConfig(replayBodyRecord.linkedAccounts);
		const replayServiceRouting = normalizeServiceRoutingConfig(replayBodyRecord.serviceRouting);
		const cloudInferenceSelected = Boolean(replayServiceRouting?.llmText?.transport === "cloud-proxy" && normalizeOnboardingProviderId(replayServiceRouting.llmText.backend) === "elizacloud");
		const shouldResolveCloudApiKey = replayDeploymentTarget?.runtime === "cloud" || cloudInferenceSelected || replayLinkedAccounts?.elizacloud?.status === "linked";
		let resolvedCloudApiKey;
		try {
			const config = loadElizaConfig();
			if (!config.meta) config.meta = {};
			config.meta.onboardingComplete = true;
			applyCanonicalOnboardingConfig(config, {
				deploymentTarget: replayDeploymentTarget,
				linkedAccounts: replayLinkedAccounts,
				serviceRouting: replayServiceRouting
			});
			if (shouldResolveCloudApiKey) {
				if (!config.cloud) config.cloud = {};
				resolvedCloudApiKey = config.cloud.apiKey;
				if (!resolvedCloudApiKey) {
					resolvedCloudApiKey = getCloudSecret("ELIZAOS_CLOUD_API_KEY") ?? void 0;
					if (resolvedCloudApiKey) config.cloud.apiKey = resolvedCloudApiKey;
				}
				if (!resolvedCloudApiKey) {
					resolvedCloudApiKey = process.env.ELIZAOS_CLOUD_API_KEY;
					if (resolvedCloudApiKey) config.cloud.apiKey = resolvedCloudApiKey;
				}
				if (!resolvedCloudApiKey) logger.warn("[api] Cloud-linked onboarding but no API key found on disk, in sealed secrets, or in env. The upstream handler will save config WITHOUT cloud.apiKey.");
				else logger.info("[api] Cloud-linked onboarding: resolved API key, injecting into replay body");
				capturedCloudApiKey = resolvedCloudApiKey;
			}
			saveElizaConfig(config);
			await syncCompatOnboardingConfigState(req, config);
		} catch (err) {
			logger.warn(`[api] Failed to persist onboarding state: ${err instanceof Error ? err.message : String(err)}`);
		}
	} catch {}
	sendJson$2(res, 200, { ok: true });
	if (capturedCloudApiKey) scheduleCloudApiKeyResave(capturedCloudApiKey);
	return true;
}
var init_onboarding_compat_routes = __esmMin((() => {
	init_auth$1();
	init_cloud_secrets();
	init_response();
	init_server_onboarding_compat();
}));

//#endregion
//#region node_modules/.bun/@elizaos+vault@2.0.0-alpha.537/node_modules/@elizaos/vault/dist/crypto.js
function generateMasterKey() {
	return randomBytes(KEY_BYTES);
}
function encrypt(masterKey, plaintext, aad) {
	if (masterKey.length !== KEY_BYTES) throw new CryptoError(`master key must be ${KEY_BYTES} bytes`);
	const nonce = randomBytes(NONCE_BYTES);
	const cipher = createCipheriv("aes-256-gcm", masterKey, nonce);
	cipher.setAAD(Buffer.from(aad, "utf8"));
	const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
	const tag = cipher.getAuthTag();
	return `v1:${nonce.toString("base64")}:${tag.toString("base64")}:${ct.toString("base64")}`;
}
function decrypt(masterKey, ciphertext, aad) {
	if (masterKey.length !== KEY_BYTES) throw new CryptoError(`master key must be ${KEY_BYTES} bytes`);
	const parts = ciphertext.split(":");
	if (parts.length !== 4 || parts[0] !== "v1") throw new CryptoError("malformed ciphertext or unsupported version");
	const nonceB64 = parts[1];
	const tagB64 = parts[2];
	const ctB64 = parts[3];
	if (nonceB64 === void 0 || tagB64 === void 0 || ctB64 === void 0) throw new CryptoError("malformed ciphertext");
	const nonce = Buffer.from(nonceB64, "base64");
	const tag = Buffer.from(tagB64, "base64");
	const ct = Buffer.from(ctB64, "base64");
	if (nonce.length !== NONCE_BYTES || tag.length !== TAG_BYTES) throw new CryptoError("malformed ciphertext");
	const decipher = createDecipheriv("aes-256-gcm", masterKey, nonce);
	decipher.setAAD(Buffer.from(aad, "utf8"));
	decipher.setAuthTag(tag);
	try {
		return Buffer.concat([decipher.update(ct), decipher.final()]).toString("utf8");
	} catch (err) {
		throw new CryptoError(err instanceof Error ? `decryption failed: ${err.message}` : "decryption failed");
	}
}
var KEY_BYTES, NONCE_BYTES, TAG_BYTES, CryptoError;
var init_crypto = __esmMin((() => {
	KEY_BYTES = 32;
	NONCE_BYTES = 12;
	TAG_BYTES = 16;
	CryptoError = class extends Error {
		constructor(message) {
			super(message);
			this.name = "CryptoError";
		}
	};
}));

//#endregion
//#region node_modules/.bun/@elizaos+vault@2.0.0-alpha.537/node_modules/@elizaos/vault/dist/master-key.js
/**
* Master key derived from a passphrase via scrypt. Use this when no OS
* keychain is available — typically headless Linux servers or containers.
*
* The same passphrase + salt + cost always produces the same key, so
* operators MUST keep their passphrase stable across restarts (otherwise
* existing ciphertext can no longer be decrypted).
*/
function passphraseMasterKey(opts) {
	if (typeof opts.passphrase !== "string") throw new MasterKeyUnavailableError("passphraseMasterKey: passphrase must be a string");
	if (opts.passphrase.length < PASSPHRASE_MIN_LENGTH) throw new MasterKeyUnavailableError(`passphraseMasterKey: passphrase must be at least ${PASSPHRASE_MIN_LENGTH} characters`);
	const service = opts.service ?? "eliza";
	const salt = opts.salt ?? `${service}.vault.masterKey.v1`;
	const cost = opts.cost ?? DEFAULT_SCRYPT_COST;
	return {
		async load() {
			try {
				const derived = scryptSync(opts.passphrase, salt, KEY_BYTES, {
					N: cost,
					r: DEFAULT_SCRYPT_BLOCK_SIZE,
					p: DEFAULT_SCRYPT_PARALLELIZATION,
					maxmem: 64 * 1024 * 1024
				});
				if (derived.length !== KEY_BYTES) throw new MasterKeyUnavailableError(`passphraseMasterKey: scrypt returned ${derived.length} bytes, expected ${KEY_BYTES}`);
				return derived;
			} catch (err) {
				if (err instanceof MasterKeyUnavailableError) throw err;
				throw new MasterKeyUnavailableError(`passphraseMasterKey: scrypt derivation failed: ${err instanceof Error ? err.message : String(err)}`);
			}
		},
		describe() {
			return `passphrase://${service}`;
		}
	};
}
/**
* Construct a passphrase resolver from `ELIZA_VAULT_PASSPHRASE` env. Returns
* `null` when the env var is absent or empty so callers can fall through
* to the next strategy without a try/catch dance.
*/
function passphraseMasterKeyFromEnv(service) {
	const raw = process.env.ELIZA_VAULT_PASSPHRASE;
	if (!raw || raw.length === 0) return null;
	return passphraseMasterKey({
		passphrase: raw,
		...service ? { service } : {}
	});
}
/**
* Detects hosts where invoking `@napi-rs/keyring` is known to crash the
* process at the native level instead of throwing a catchable JS error:
*
*   - explicit opt-out via `ELIZA_VAULT_DISABLE_KEYCHAIN=1`
*   - headless Linux with no reachable D-Bus session (the libsecret
*     backend aborts at the C level when it can't reach the Secret
*     Service)
*
* D-Bus reachability on Linux is checked two ways:
*
*   1. `DBUS_SESSION_BUS_ADDRESS` env var — the classical signal,
*      reliably set by desktop session startup and `dbus-launch`.
*   2. `$XDG_RUNTIME_DIR/bus` socket — modern systemd user sessions
*      socket-activate D-Bus and don't always export the env var
*      (notably SSH sessions without env forwarding, and Fedora /
*      Arch / Ubuntu 22+ desktops). Treat the socket file's presence
*      as equivalent to the env var.
*
* This is intentionally a heuristic: it never returns `false` (safe)
* for a host that would actually crash, and may return `false` (safe)
* for a host where the keychain ultimately fails with a regular JS
* error. That's the desired direction — we'd rather attempt the
* keychain and let the existing try/catch handle a JS-level failure
* than refuse on a host where it would have worked.
*/
function isKeychainUnsafe() {
	if (process.env.ELIZA_VAULT_DISABLE_KEYCHAIN === "1") return true;
	if (process.platform !== "linux") return false;
	if (process.env.DBUS_SESSION_BUS_ADDRESS) return false;
	const xdgRuntime = process.env.XDG_RUNTIME_DIR;
	if (xdgRuntime && existsSync(join(xdgRuntime, "bus"))) return false;
	return true;
}
function keychainUnsafeMessage(prefix) {
	return `${prefix}OS keychain is unsafe on this host (headless Linux with no reachable D-Bus session, or ELIZA_VAULT_DISABLE_KEYCHAIN=1). Set ELIZA_VAULT_PASSPHRASE (≥${PASSPHRASE_MIN_LENGTH} chars) to enable a passphrase-derived master key, or pass an inMemoryMasterKey.`;
}
/**
* Default resolver: try the OS keychain first, then a passphrase-derived
* key from `ELIZA_VAULT_PASSPHRASE`. If both fail, throws a single
* `MasterKeyUnavailableError` whose message lists every remediation
* option so operators on a fresh headless box see one actionable line.
*
* Tests should NOT use this — pass `inMemoryMasterKey(...)` to
* `createVault()` directly. Production paths that already inject a
* resolver are unaffected.
*/
function defaultMasterKey(opts = {}) {
	const keychain = osKeychainMasterKey(opts);
	return {
		async load() {
			if (isKeychainUnsafe()) {
				const passphrase = passphraseMasterKeyFromEnv(opts.service);
				if (passphrase) return passphrase.load();
				throw new MasterKeyUnavailableError(keychainUnsafeMessage("vault: "));
			}
			try {
				return await keychain.load();
			} catch (keychainErr) {
				const passphrase = passphraseMasterKeyFromEnv(opts.service);
				if (passphrase) try {
					return await passphrase.load();
				} catch (passphraseErr) {
					throw new MasterKeyUnavailableError(`vault master key unavailable. Keychain: ${keychainErr instanceof Error ? keychainErr.message : String(keychainErr)}. Passphrase: ${passphraseErr instanceof Error ? passphraseErr.message : String(passphraseErr)}.`);
				}
				throw new MasterKeyUnavailableError(`vault master key unavailable. ${keychainErr instanceof Error ? keychainErr.message : String(keychainErr)} To use a passphrase-derived key on a headless host, set ELIZA_VAULT_PASSPHRASE (≥${PASSPHRASE_MIN_LENGTH} chars) and restart.`);
			}
		},
		describe() {
			const passphrase = passphraseMasterKeyFromEnv(opts.service);
			if (isKeychainUnsafe()) return passphrase ? `${passphrase.describe()} (keychain bypassed: host unsafe)` : `unavailable (keychain bypassed: host unsafe; no ELIZA_VAULT_PASSPHRASE set)`;
			return passphrase ? `${keychain.describe()} (fallback: ${passphrase.describe()})` : keychain.describe();
		}
	};
}
function osKeychainMasterKey(opts = {}) {
	const service = opts.service ?? "eliza";
	const account = opts.account ?? "vault.masterKey";
	return {
		async load() {
			if (isKeychainUnsafe()) throw new MasterKeyUnavailableError(keychainUnsafeMessage(`OS keychain (${service}/${account}): `));
			let Entry;
			try {
				({Entry} = await import("@napi-rs/keyring"));
			} catch (err) {
				throw new MasterKeyUnavailableError(`OS keychain binding unavailable (${service}/${account}): ${err instanceof Error ? err.message : String(err)}`);
			}
			let entry;
			try {
				entry = new Entry(service, account);
			} catch (err) {
				throw new MasterKeyUnavailableError(`OS keychain entry construction failed (${service}/${account}): ${err instanceof Error ? err.message : String(err)}`);
			}
			let existing = null;
			try {
				existing = entry.getPassword();
			} catch (err) {
				throw new MasterKeyUnavailableError(`OS keychain read failed (${service}/${account}): ${err instanceof Error ? err.message : String(err)}. On Linux, ensure libsecret + a Secret Service agent (gnome-keyring / kwallet) is running, or pass an inMemoryMasterKey.`);
			}
			if (existing && existing.length > 0) {
				const buf = Buffer.from(existing, "base64");
				if (buf.length !== KEY_BYTES) throw new MasterKeyUnavailableError(`OS keychain entry ${service}/${account} is not a ${KEY_BYTES}-byte key`);
				return buf;
			}
			const created = generateMasterKey();
			try {
				entry.setPassword(created.toString("base64"));
			} catch (err) {
				throw new MasterKeyUnavailableError(`OS keychain write failed (${service}/${account}): ${err instanceof Error ? err.message : String(err)}`);
			}
			return created;
		},
		describe() {
			return `keychain://${service}/${account}`;
		}
	};
}
var MasterKeyUnavailableError, PASSPHRASE_MIN_LENGTH, DEFAULT_SCRYPT_COST, DEFAULT_SCRYPT_BLOCK_SIZE, DEFAULT_SCRYPT_PARALLELIZATION;
var init_master_key = __esmMin((() => {
	init_crypto();
	MasterKeyUnavailableError = class extends Error {
		constructor(message) {
			super(message);
			this.name = "MasterKeyUnavailableError";
		}
	};
	PASSPHRASE_MIN_LENGTH = 12;
	DEFAULT_SCRYPT_COST = 32768;
	DEFAULT_SCRYPT_BLOCK_SIZE = 8;
	DEFAULT_SCRYPT_PARALLELIZATION = 1;
}));

//#endregion
//#region node_modules/.bun/@elizaos+vault@2.0.0-alpha.537/node_modules/@elizaos/vault/dist/password-managers.js
async function resolveReference(ref) {
	if (ref.source === "1password") return resolve1Password(ref.path);
	if (ref.source === "protonpass") return resolveProtonPass(ref.path);
	throw new PasswordManagerError(ref.source, "unsupported source");
}
async function resolve1Password(path) {
	const uri = path.startsWith("op://") ? path : `op://${path}`;
	try {
		const { stdout } = await exec$2("op", ["read", uri], {
			encoding: "utf8",
			timeout: 5e3
		});
		const value = stdout.trim();
		if (value.length === 0) throw new PasswordManagerError("1password", `${uri} is empty`);
		return value;
	} catch (err) {
		if (err.code === "ENOENT") throw new PasswordManagerError("1password", "`op` CLI not found. Install from https://developer.1password.com/docs/cli, then sign in (`eval $(op signin)`).");
		if (err instanceof PasswordManagerError) throw err;
		const msg = err instanceof Error ? err.message : String(err);
		if (/not signed in|not authenticated/i.test(msg)) throw new PasswordManagerError("1password", "`op` is not signed in. Unlock the 1Password desktop app or run `eval $(op signin)`.");
		throw new PasswordManagerError("1password", msg);
	}
}
async function resolveProtonPass(_path) {
	throw new PasswordManagerError("protonpass", "Proton Pass integration is scaffolded; vendor CLI / SDK is not yet stable. File a request to prioritize.");
}
var exec$2, PasswordManagerError;
var init_password_managers = __esmMin((() => {
	exec$2 = promisify(execFile);
	PasswordManagerError = class extends Error {
		source;
		constructor(source, message) {
			super(`[${source}] ${message}`);
			this.source = source;
			this.name = "PasswordManagerError";
		}
	};
}));

//#endregion
//#region node_modules/.bun/@elizaos+vault@2.0.0-alpha.537/node_modules/@elizaos/vault/dist/store.js
function emptyStore() {
	return {
		version: STORE_VERSION,
		entries: {}
	};
}
async function readStore(path) {
	let raw;
	try {
		raw = await promises.readFile(path, "utf8");
	} catch (err) {
		if (err.code === "ENOENT") return emptyStore();
		throw err;
	}
	let parsed;
	try {
		parsed = JSON.parse(raw);
	} catch (err) {
		throw new StoreFormatError(`parse error: ${err instanceof Error ? err.message : String(err)}`);
	}
	return validateShape(parsed);
}
async function writeStore(path, data) {
	await promises.mkdir(dirname(path), { recursive: true });
	const tmp = `${path}.tmp.${process.pid}.${randomBytes(8).toString("hex")}`;
	const body = `${JSON.stringify(data, null, 2)}\n`;
	await promises.writeFile(tmp, body, {
		mode: 384,
		flag: "w"
	});
	try {
		await promises.rename(tmp, path);
	} catch (renameErr) {
		await promises.rm(tmp, { force: true }).catch(() => {});
		throw renameErr;
	}
}
function setEntry(data, key, entry) {
	return {
		version: data.version,
		entries: {
			...data.entries,
			[key]: entry
		}
	};
}
function removeEntry(data, key) {
	if (!(key in data.entries)) return data;
	const next = { ...data.entries };
	delete next[key];
	return {
		version: data.version,
		entries: next
	};
}
function validateShape(parsed) {
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new StoreFormatError("root must be an object");
	const root = parsed;
	if (typeof root.version !== "number") throw new StoreFormatError("version must be a number");
	const version = root.version;
	if (version > STORE_VERSION) throw new StoreFormatError(`version ${version} is newer than supported (${STORE_VERSION})`);
	if (!root.entries || typeof root.entries !== "object" || Array.isArray(root.entries)) throw new StoreFormatError("entries must be an object");
	const entriesRaw = root.entries;
	const entries = {};
	for (const [key, value] of Object.entries(entriesRaw)) entries[key] = validateEntry(key, value);
	return {
		version: STORE_VERSION,
		entries
	};
}
function validateEntry(key, raw) {
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new StoreFormatError(`entry ${key}: must be an object`);
	const e = raw;
	if (typeof e.lastModified !== "number") throw new StoreFormatError(`entry ${key}: lastModified must be a number`);
	const lastModified = e.lastModified;
	if (e.kind === "value") {
		if (typeof e.value !== "string") throw new StoreFormatError(`entry ${key}: value must be a string`);
		return {
			kind: "value",
			value: e.value,
			lastModified
		};
	}
	if (e.kind === "secret") {
		if (typeof e.ciphertext !== "string" || e.ciphertext.length === 0) throw new StoreFormatError(`entry ${key}: missing ciphertext`);
		return {
			kind: "secret",
			ciphertext: e.ciphertext,
			lastModified
		};
	}
	if (e.kind === "reference") {
		if (e.source !== "1password" && e.source !== "protonpass") throw new StoreFormatError(`entry ${key}: invalid reference source`);
		if (typeof e.path !== "string" || e.path.length === 0) throw new StoreFormatError(`entry ${key}: missing reference path`);
		return {
			kind: "reference",
			source: e.source,
			path: e.path,
			lastModified
		};
	}
	throw new StoreFormatError(`entry ${key}: unknown kind ${JSON.stringify(e.kind)}`);
}
var STORE_VERSION, StoreFormatError;
var init_store = __esmMin((() => {
	STORE_VERSION = 1;
	StoreFormatError = class extends Error {
		constructor(message) {
			super(`vault store: ${message}`);
			this.name = "StoreFormatError";
		}
	};
}));

//#endregion
//#region node_modules/.bun/@elizaos+vault@2.0.0-alpha.537/node_modules/@elizaos/vault/dist/audit.js
var AuditLog;
var init_audit = __esmMin((() => {
	AuditLog = class {
		path;
		logger;
		constructor(path, logger) {
			this.path = path;
			this.logger = logger;
		}
		async record(entry) {
			const record = {
				ts: entry.ts ?? Date.now(),
				...entry
			};
			const line = `${JSON.stringify(record)}\n`;
			try {
				await promises.mkdir(dirname(this.path), { recursive: true });
				await promises.appendFile(this.path, line, { mode: 384 });
			} catch (err) {
				this.logger?.warn(`[vault] failed to append audit record to ${this.path}`, err);
			}
		}
	};
}));

//#endregion
//#region node_modules/.bun/@elizaos+vault@2.0.0-alpha.537/node_modules/@elizaos/vault/dist/vault.js
function createVault(opts = {}) {
	const root = opts.workDir ?? process.env.ELIZA_STATE_DIR ?? join(homedir(), `.${process.env.ELIZA_NAMESPACE?.trim() || "eliza"}`);
	return new VaultImpl(join(root, "vault.json"), join(root, "audit", "vault.jsonl"), opts.masterKey ?? defaultMasterKey(), opts.logger);
}
function assertKey(key) {
	if (typeof key !== "string" || key.length === 0) throw new TypeError("vault: key must be a non-empty string");
	if (key.length > 256) throw new TypeError("vault: key must be 256 characters or fewer");
}
function optsCaller(opts) {
	return opts.caller ? { caller: opts.caller } : {};
}
async function withStoreMutationLock(storePath, fn) {
	const key = resolve(storePath);
	const previous = PROCESS_STORE_LOCKS.get(key) ?? Promise.resolve();
	let releaseProcessLock;
	const current = new Promise((resolveLock) => {
		releaseProcessLock = resolveLock;
	});
	const chained = previous.then(() => current, () => current);
	PROCESS_STORE_LOCKS.set(key, chained);
	await previous;
	const lockDir = `${key}.lock`;
	await promises.mkdir(dirname(lockDir), { recursive: true });
	let lockAcquired = false;
	try {
		await acquireFsLock(lockDir);
		lockAcquired = true;
		return await fn();
	} finally {
		if (lockAcquired) await promises.rm(lockDir, {
			recursive: true,
			force: true
		}).catch(() => {});
		releaseProcessLock();
		if (PROCESS_STORE_LOCKS.get(key) === chained) PROCESS_STORE_LOCKS.delete(key);
	}
}
async function acquireFsLock(lockDir) {
	const startedAt = Date.now();
	while (true) try {
		await promises.mkdir(lockDir, { mode: 448 });
		return;
	} catch (err) {
		if (err.code !== "EEXIST") throw err;
		if (Date.now() - startedAt > 1e4) throw new Error(`vault store lock timed out: ${lockDir}`);
		await new Promise((resolveWait) => setTimeout(resolveWait, 25));
	}
}
var VaultImpl, VaultMissError, PROCESS_STORE_LOCKS;
var init_vault = __esmMin((() => {
	init_crypto();
	init_master_key();
	init_password_managers();
	init_store();
	init_audit();
	VaultImpl = class {
		storePath;
		auditPath;
		masterKey;
		logger;
		cachedKey = null;
		mutex = Promise.resolve();
		audit;
		constructor(storePath, auditPath, masterKey, logger) {
			this.storePath = storePath;
			this.auditPath = auditPath;
			this.masterKey = masterKey;
			this.logger = logger;
			this.audit = new AuditLog(auditPath, logger);
		}
		async set(key, value, opts = {}) {
			assertKey(key);
			if (typeof value !== "string") throw new TypeError("vault.set: value must be a string");
			if (opts.sensitive) {
				const ciphertext = encrypt(await this.loadMasterKey(), value, key);
				await this.mutate((s) => setEntry(s, key, {
					kind: "secret",
					ciphertext,
					lastModified: Date.now()
				}));
			} else await this.mutate((s) => setEntry(s, key, {
				kind: "value",
				value,
				lastModified: Date.now()
			}));
			await this.recordAudit({
				action: "set",
				key,
				...optsCaller(opts)
			});
		}
		async setReference(key, ref) {
			assertKey(key);
			if (ref.source !== "1password" && ref.source !== "protonpass") throw new TypeError(`unsupported password manager: ${ref.source}`);
			if (ref.path.trim().length === 0) throw new TypeError("setReference: path required");
			await this.mutate((s) => setEntry(s, key, {
				kind: "reference",
				source: ref.source,
				path: ref.path,
				lastModified: Date.now()
			}));
			await this.recordAudit({
				action: "setReference",
				key
			});
		}
		async get(key) {
			assertKey(key);
			const value = await this.readValue(key);
			await this.recordAudit({
				action: "get",
				key
			});
			return value;
		}
		async reveal(key, caller) {
			assertKey(key);
			const value = await this.readValue(key);
			await this.recordAudit({
				action: "reveal",
				key,
				...caller ? { caller } : {}
			});
			return value;
		}
		async has(key) {
			assertKey(key);
			return key in (await this.loadStore()).entries;
		}
		async remove(key) {
			assertKey(key);
			await this.mutate((s) => removeEntry(s, key));
			await this.recordAudit({
				action: "remove",
				key
			});
		}
		async list(prefix) {
			const store = await this.loadStore();
			const keys = Object.keys(store.entries);
			if (!prefix) return keys;
			return keys.filter((k) => k === prefix || k.startsWith(`${prefix}.`));
		}
		async describe(key) {
			assertKey(key);
			const entry = (await this.loadStore()).entries[key];
			if (!entry) return null;
			if (entry.kind === "value") return {
				key,
				source: "file",
				sensitive: false,
				lastModified: entry.lastModified
			};
			if (entry.kind === "secret") return {
				key,
				source: "keychain-encrypted",
				sensitive: true,
				lastModified: entry.lastModified
			};
			return {
				key,
				source: entry.source,
				sensitive: true,
				lastModified: entry.lastModified
			};
		}
		async stats() {
			const store = await this.loadStore();
			let sensitive = 0;
			let nonSensitive = 0;
			let references = 0;
			for (const e of Object.values(store.entries)) if (e.kind === "value") nonSensitive += 1;
			else if (e.kind === "secret") sensitive += 1;
			else references += 1;
			return {
				total: sensitive + nonSensitive + references,
				sensitive,
				nonSensitive,
				references
			};
		}
		async readValue(key) {
			const entry = (await this.loadStore()).entries[key];
			if (!entry) throw new VaultMissError(key);
			if (entry.kind === "value") return entry.value;
			if (entry.kind === "secret") return decrypt(await this.loadMasterKey(), entry.ciphertext, key);
			return resolveReference({
				source: entry.source,
				path: entry.path
			});
		}
		async loadStore() {
			return readStore(this.storePath);
		}
		async loadMasterKey() {
			if (this.cachedKey) return this.cachedKey;
			this.cachedKey = await this.masterKey.load();
			return this.cachedKey;
		}
		async mutate(mutator) {
			const previous = this.mutex;
			let release;
			this.mutex = new Promise((resolve) => {
				release = resolve;
			});
			try {
				await previous;
				await withStoreMutationLock(this.storePath, async () => {
					const next = mutator(await readStore(this.storePath));
					await writeStore(this.storePath, next);
				});
			} finally {
				release();
			}
		}
		async recordAudit(entry) {
			await this.audit.record(entry);
		}
	};
	VaultMissError = class extends Error {
		key;
		constructor(key) {
			super(`vault: no entry for ${JSON.stringify(key)}`);
			this.key = key;
			this.name = "VaultMissError";
		}
	};
	PROCESS_STORE_LOCKS = /* @__PURE__ */ new Map();
}));

//#endregion
//#region node_modules/.bun/@elizaos+vault@2.0.0-alpha.537/node_modules/@elizaos/vault/dist/credentials.js
/** Encode an account segment so vault key parsing stays unambiguous. */
function encodeAccount(username) {
	return encodeURIComponent(username);
}
function decodeAccount(segment) {
	return decodeURIComponent(segment);
}
/** Lower-case domains so `Github.com` and `github.com` collide. */
function normalizeDomain(domain) {
	return domain.trim().toLowerCase();
}
function loginKey(domain, username) {
	return `${PREFIX}.${normalizeDomain(domain)}.${encodeAccount(username)}`;
}
function autoallowKey(domain) {
	return `${PREFIX}.${normalizeDomain(domain)}.${AUTOALLOW_SEGMENT}`;
}
/** Persist (or replace) a login. Stamps `lastModified` automatically. */
async function setSavedLogin(vault, login) {
	if (login.domain.trim().length === 0) throw new TypeError("setSavedLogin: domain required");
	if (login.username.length === 0) throw new TypeError("setSavedLogin: username required");
	if (typeof login.password !== "string" || login.password.length === 0) throw new TypeError("setSavedLogin: password required");
	const record = {
		domain: normalizeDomain(login.domain),
		username: login.username,
		password: login.password,
		...login.otpSeed ? { otpSeed: login.otpSeed } : {},
		...login.notes ? { notes: login.notes } : {},
		lastModified: Date.now()
	};
	await vault.set(loginKey(login.domain, login.username), JSON.stringify(record), { sensitive: true });
}
/** Read a login. Returns null when missing. */
async function getSavedLogin(vault, domain, username) {
	const key = loginKey(domain, username);
	if (!await vault.has(key)) return null;
	return parseLogin(await vault.get(key));
}
/**
* List logins. With no `domain`, returns every saved login summary
* across the vault. With a domain, scopes to that hostname.
*
* Returns metadata only. The password values stay encrypted at rest;
* callers must `getSavedLogin` to decrypt one entry at a time.
*/
async function listSavedLogins(vault, domain) {
	const prefix = domain ? `${PREFIX}.${normalizeDomain(domain)}` : PREFIX;
	const keys = await vault.list(prefix);
	const summaries = [];
	const failures = [];
	for (const key of keys) {
		const parsed = parseLoginKey(key);
		if (!parsed) continue;
		if (parsed.account === AUTOALLOW_SEGMENT) continue;
		const descriptor = await vault.describe(key);
		if (!descriptor) continue;
		summaries.push({
			domain: parsed.domain,
			username: decodeAccount(parsed.account),
			lastModified: descriptor.lastModified
		});
	}
	if (failures.length > 0) throw new Error(`listSavedLogins: failed to describe ${failures.length} key(s): ${failures.join(", ")}`);
	return summaries;
}
/** Remove a single login. Idempotent. */
async function deleteSavedLogin(vault, domain, username) {
	await vault.remove(loginKey(domain, username));
}
/** Read the autoallow flag for a domain. False when unset. */
async function getAutofillAllowed(vault, domain) {
	const key = autoallowKey(domain);
	if (!await vault.has(key)) return false;
	return await vault.get(key) === "1";
}
/** Toggle the autoallow flag. `true` skips consent on next autofill for that domain. */
async function setAutofillAllowed(vault, domain, allowed) {
	await vault.set(autoallowKey(domain), allowed ? "1" : "0");
}
function parseLoginKey(key) {
	if (!key.startsWith(`${PREFIX}.`)) return null;
	const rest = key.slice(6);
	const lastDot = rest.lastIndexOf(".");
	if (lastDot <= 0) return null;
	const domain = rest.slice(0, lastDot);
	const account = rest.slice(lastDot + 1);
	if (!domain || !account) return null;
	return {
		domain,
		account
	};
}
function parseLogin(raw) {
	const parsed = JSON.parse(raw);
	if (typeof parsed.domain !== "string" || typeof parsed.username !== "string" || typeof parsed.password !== "string" || typeof parsed.lastModified !== "number") throw new Error(`vault credentials: stored entry is malformed (got keys: ${Object.keys(parsed).join(", ")})`);
	return {
		domain: parsed.domain,
		username: parsed.username,
		password: parsed.password,
		...parsed.otpSeed ? { otpSeed: parsed.otpSeed } : {},
		...parsed.notes ? { notes: parsed.notes } : {},
		lastModified: parsed.lastModified
	};
}
var PREFIX, AUTOALLOW_SEGMENT;
var init_credentials = __esmMin((() => {
	PREFIX = "creds";
	AUTOALLOW_SEGMENT = ":autoallow";
}));

//#endregion
//#region node_modules/.bun/@elizaos+vault@2.0.0-alpha.537/node_modules/@elizaos/vault/dist/external-credentials.js
async function listOnePasswordLogins(vault, exec) {
	const items = parseJsonArray((await exec("op", [
		...await readOnePasswordSessionArgs(vault, exec),
		"item",
		"list",
		"--categories",
		"Login",
		"--format=json"
	], { timeoutMs: 1e4 })).stdout);
	if (items.length === 0) return [];
	const out = [];
	for (const item of items) {
		const url = pickPrimaryUrl(item.urls);
		const username = typeof item.additional_information === "string" ? item.additional_information : "";
		out.push({
			source: "1password",
			externalId: item.id,
			title: typeof item.title === "string" && item.title.length > 0 ? item.title : item.id,
			username,
			domain: url ? extractHostname(url) : null,
			url: url ?? null,
			updatedAt: parseDate(item.updated_at)
		});
	}
	return out;
}
async function revealOnePasswordLogin(vault, exec, externalId) {
	if (!externalId) throw new TypeError("revealOnePasswordLogin: externalId required");
	const item = parseJsonObject((await exec("op", [
		...await readOnePasswordSessionArgs(vault, exec),
		"item",
		"get",
		externalId,
		"--format=json"
	], { timeoutMs: 1e4 })).stdout);
	const username = pickOnePasswordUsername(item) ?? "";
	const password = pickOnePasswordField(item, "password") ?? "";
	const totp = pickOnePasswordField(item, "one-time password") ?? pickOnePasswordField(item, "totp");
	const url = pickPrimaryUrl(item.urls);
	if (!password) throw new Error(`[1password] item ${externalId} has no password field`);
	return {
		source: "1password",
		externalId: item.id,
		title: typeof item.title === "string" && item.title.length > 0 ? item.title : item.id,
		username,
		domain: url ? extractHostname(url) : null,
		url: url ?? null,
		updatedAt: parseDate(item.updated_at),
		password,
		...totp ? { totp } : {}
	};
}
function pickOnePasswordUsername(item) {
	if (!item?.fields) return null;
	const byPurpose = item.fields.find((f) => f.purpose === "USERNAME" && typeof f.value === "string");
	if (byPurpose?.value) return byPurpose.value;
	return item.fields.find((f) => f.label === "username" && typeof f.value === "string")?.value ?? null;
}
function pickOnePasswordField(item, label) {
	if (!item.fields) return null;
	if (label === "password") {
		const byPurpose = item.fields.find((f) => f.purpose === "PASSWORD" && typeof f.value === "string");
		if (byPurpose?.value) return byPurpose.value;
	}
	const lowered = label.toLowerCase();
	return item.fields.find((f) => typeof f.label === "string" && f.label.toLowerCase() === lowered && typeof f.value === "string")?.value ?? null;
}
async function listBitwardenLogins(vault, exec) {
	const session = await readSessionToken(vault, "bitwarden");
	const items = parseJsonArray((await exec("bw", ["list", "items"], {
		env: {
			...process.env,
			BW_SESSION: session
		},
		timeoutMs: 15e3
	})).stdout);
	const result = [];
	for (const item of items) {
		if (item.type !== 1 || !item.login) continue;
		const url = pickBitwardenUrl(item.login.uris ?? null);
		result.push({
			source: "bitwarden",
			externalId: item.id,
			title: typeof item.name === "string" && item.name.length > 0 ? item.name : item.id,
			username: typeof item.login.username === "string" ? item.login.username : "",
			domain: url ? extractHostname(url) : null,
			url: url ?? null,
			updatedAt: parseDate(item.revisionDate)
		});
	}
	return result;
}
async function revealBitwardenLogin(vault, exec, externalId) {
	if (!externalId) throw new TypeError("revealBitwardenLogin: externalId required");
	const session = await readSessionToken(vault, "bitwarden");
	const item = parseJsonObject((await exec("bw", [
		"get",
		"item",
		externalId
	], {
		env: {
			...process.env,
			BW_SESSION: session
		},
		timeoutMs: 1e4
	})).stdout);
	if (item.type !== 1 || !item.login) throw new Error(`[bitwarden] item ${externalId} is not a login`);
	const password = item.login.password ?? "";
	if (!password) throw new Error(`[bitwarden] item ${externalId} has no password`);
	const url = pickBitwardenUrl(item.login.uris ?? null);
	return {
		source: "bitwarden",
		externalId: item.id,
		title: typeof item.name === "string" && item.name.length > 0 ? item.name : item.id,
		username: typeof item.login.username === "string" ? item.login.username : "",
		domain: url ? extractHostname(url) : null,
		url: url ?? null,
		updatedAt: parseDate(item.revisionDate),
		password,
		...item.login.totp ? { totp: item.login.totp } : {}
	};
}
function pickBitwardenUrl(uris) {
	if (!uris || uris.length === 0) return null;
	for (const u of uris) if (typeof u.uri === "string" && u.uri.length > 0) return u.uri;
	return null;
}
async function readSessionToken(vault, source) {
	const key = `pm.${source}.session`;
	if (!await vault.has(key)) throw new BackendNotSignedInError(source);
	const token = (await vault.get(key)).trim();
	if (!token) throw new BackendNotSignedInError(source);
	return token;
}
/**
* Resolve op-invocation args (account + session) for one CLI call.
*
* 1Password 8's `op` CLI refuses to pick a default account when more than
* one is registered — `op whoami` exits 1 with "account is not signed in"
* even when the desktop app integration is fully active. The fix: probe
* `op account list` once, pick the first registered account's shorthand,
* and pass `--account=<shorthand>` on every subsequent call. Then desktop
* integration triggers the normal Touch ID flow and the session-token
* fallback is only used when no account is registered at all.
*
* Returns `["--account=<sh>"]` for desktop-app and
* `["--account=<sh>", "--session=<token>"]` for session-token.
*/
async function readOnePasswordSessionArgs(vault, exec) {
	const account = await readDefaultOpAccount$1(exec);
	const accountArg = account ? [`--account=${account}`] : [];
	if (await isOnePasswordDesktopActiveWithExec(exec, accountArg)) return accountArg;
	const session = await readSessionToken(vault, "1password");
	return [...accountArg, `--session=${session}`];
}
async function readDefaultOpAccount$1(exec) {
	try {
		const accounts = parseJsonArray((await exec("op", [
			"account",
			"list",
			"--format=json"
		], { timeoutMs: 3e3 })).stdout);
		for (const a of accounts) {
			if (typeof a.shorthand === "string" && a.shorthand.length > 0) return a.shorthand;
			if (typeof a.url === "string") {
				const sub = a.url.split(".")[0];
				if (sub) return sub;
			}
		}
		return null;
	} catch {
		return null;
	}
}
async function isOnePasswordDesktopActiveWithExec(exec, accountArg) {
	if (accountArg.length === 0) return false;
	try {
		await exec("op", [
			...accountArg,
			"vault",
			"list",
			"--format=json"
		], { timeoutMs: 3e3 });
		return true;
	} catch {
		return false;
	}
}
function pickPrimaryUrl(urls) {
	if (!urls || urls.length === 0) return null;
	const primary = urls.find((u) => u.primary === true && typeof u.href === "string");
	if (primary?.href) return primary.href;
	for (const u of urls) if (typeof u.href === "string" && u.href.length > 0) return u.href;
	return null;
}
function extractHostname(url) {
	try {
		const host = new URL(url.includes("://") ? url : `https://${url}`).hostname.toLowerCase();
		return host.length > 0 ? host : null;
	} catch {
		return null;
	}
}
function parseDate(value) {
	if (!value) return 0;
	const ms = Date.parse(value);
	return Number.isFinite(ms) ? ms : 0;
}
function parseJsonArray(raw) {
	const trimmed = raw.trim();
	if (trimmed.length === 0) return [];
	const parsed = JSON.parse(trimmed);
	if (!Array.isArray(parsed)) throw new Error("expected JSON array, got non-array");
	return parsed;
}
function parseJsonObject(raw) {
	const trimmed = raw.trim();
	if (trimmed.length === 0) throw new Error("expected JSON object, got empty output");
	const parsed = JSON.parse(trimmed);
	if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("expected JSON object, got non-object");
	return parsed;
}
/**
* Production `ExecFn` wrapping `node:child_process.execFile`. Tests inject
* stubs instead of using this. Lives here so callers can `import` a single
* default rather than wiring `child_process` themselves.
*/
function defaultExecFn() {
	return async (cmd, args, opts) => {
		const childProcess = await import("node:child_process");
		return new Promise((resolve, reject) => {
			const child = childProcess.execFile(cmd, [...args], {
				...opts.env ? { env: opts.env } : {},
				timeout: opts.timeoutMs ?? 1e4,
				maxBuffer: 16 * 1024 * 1024,
				encoding: "utf8"
			}, (error, stdout, stderr) => {
				if (error) {
					reject(error);
					return;
				}
				resolve({
					stdout,
					stderr
				});
			});
			if (opts.stdin !== void 0 && child.stdin) {
				child.stdin.write(opts.stdin);
				child.stdin.end();
			}
		});
	};
}
var BackendNotSignedInError;
var init_external_credentials = __esmMin((() => {
	BackendNotSignedInError = class extends Error {
		source;
		constructor(source) {
			super(`[${source}] not signed in — sign in via Settings → Secrets storage`);
			this.source = source;
			this.name = "BackendNotSignedInError";
		}
	};
}));

//#endregion
//#region node_modules/.bun/@elizaos+vault@2.0.0-alpha.537/node_modules/@elizaos/vault/dist/inventory.js
/**
* Heuristic categorization for keys without an explicit `_meta.*` entry.
* Order matters: more specific patterns run first.
*/
function categorizeKey(key) {
	if (key.startsWith("creds.")) return "credential";
	if (key.startsWith("pm.")) return "session";
	if (key.startsWith("_manager.") || key === ROUTING_KEY) return "system";
	if (/(?:_PRIVATE_KEY|_MNEMONIC|_SEED_PHRASE)$/i.test(key) || /^(?:EVM|SOLANA|BTC|ETH|BITCOIN)_/i.test(key) || key.startsWith("wallet.") || /(?:^|\.)wallet\./i.test(key)) return "wallet";
	if (/_API_KEY$/.test(key)) {
		if (PROVIDER_KEY_PATTERNS.some((rx) => rx.test(key))) return "provider";
		return "plugin";
	}
	if (PROVIDER_EXACT_KEYS.has(key)) return "provider";
	return "plugin";
}
/**
* Provider id derivation when no explicit meta is set. Returns null
* when the key isn't a recognized provider env var.
*/
function inferProviderId(key) {
	const lookup = PROVIDER_KEY_TO_ID[key];
	if (lookup) return lookup;
	const m = /^([A-Z][A-Z0-9_]*)_API_KEY$/.exec(key);
	if (m) return m[1].toLowerCase();
	return null;
}
function defaultLabel(key, providerId) {
	if (providerId && PROVIDER_LABELS[providerId]) return PROVIDER_LABELS[providerId];
	return key;
}
/**
* Read the meta record for `key`, parsing the underlying JSON. Returns
* null when no meta has been written. Malformed JSON is treated as
* "no meta" and logged at warn — we never silently coerce a corrupt
* blob into a valid meta to mask the underlying problem.
*/
async function readEntryMeta(vault, key) {
	const metaKey = `${META_PREFIX}${key}`;
	if (!await vault.has(metaKey)) return null;
	return parseMetaRecord(await vault.get(metaKey), metaKey);
}
async function setEntryMeta(vault, key, partial) {
	const metaKey = `${META_PREFIX}${key}`;
	const merged = { ...await readEntryMeta(vault, key) ?? {} };
	for (const [k, v] of Object.entries(partial)) {
		if (v === null) {
			delete merged[k];
			continue;
		}
		if (v === void 0) continue;
		merged[k] = v;
	}
	merged.lastModified = Date.now();
	await vault.set(metaKey, JSON.stringify(merged));
}
/**
* Drop the meta record for `key`. Callers are responsible for also
* removing the underlying value(s) and profile entries — this only
* touches `_meta.<key>`.
*/
async function removeEntryMeta(vault, key) {
	const metaKey = `${META_PREFIX}${key}`;
	if (await vault.has(metaKey)) await vault.remove(metaKey);
}
/**
* List every meaningful vault entry, grouped by category. Reserved
* `_meta.*` and `_routing.*` keys are filtered out, as are the
* `_manager.*` preferences keys.
*
* For keys with profile entries (`<K>.profile.<id>`), only the parent
* `<K>` is surfaced — the profile rows roll up under it.
*/
async function listVaultInventory(vault) {
	const allKeys = await vault.list();
	const profileChildren = /* @__PURE__ */ new Set();
	for (const k of allKeys) if (k.indexOf(`.${PROFILE_SEGMENT}.`) > 0) profileChildren.add(k);
	const parentKeys = /* @__PURE__ */ new Set();
	for (const key of allKeys) {
		if (key.startsWith(META_PREFIX)) {
			parentKeys.add(key.slice(6));
			continue;
		}
		if (key === ROUTING_KEY) continue;
		if (key.startsWith("_manager.")) continue;
		if (profileChildren.has(key)) continue;
		parentKeys.add(key);
	}
	const out = [];
	for (const key of parentKeys) {
		const descriptor = await vault.describe(key);
		const meta = await readEntryMeta(vault, key);
		if (!descriptor && !meta) continue;
		const kind = descriptor ? descriptorKind(descriptor.source) : "secret";
		const providerId = meta?.providerId ?? inferProviderId(key) ?? void 0;
		const category = meta?.category ?? categorizeKey(key);
		const label = meta?.label ?? defaultLabel(key, providerId ?? null);
		const profiles = meta?.profiles ?? [];
		const hasProfiles = profiles.length > 0;
		out.push({
			key,
			category,
			label,
			...providerId ? { providerId } : {},
			hasProfiles,
			...meta?.activeProfile ? { activeProfile: meta.activeProfile } : {},
			...hasProfiles ? { profiles } : {},
			...meta?.lastModified !== void 0 ? { lastModified: meta.lastModified } : descriptor?.lastModified !== void 0 ? { lastModified: descriptor.lastModified } : {},
			...meta?.lastUsed !== void 0 ? { lastUsed: meta.lastUsed } : {},
			kind
		});
	}
	return out;
}
/**
* Vault key for the storage backing one profile of a parent key.
*
* Profiles use dot separators so `vault.list("<KEY>")` matches both the
* parent and every profile via the existing prefix logic.
*/
function profileStorageKey(key, profileId) {
	if (typeof profileId !== "string" || profileId.length === 0) throw new TypeError("profileStorageKey: profileId must be non-empty");
	if (!/^[a-zA-Z0-9_-]+$/.test(profileId)) throw new TypeError(`profileStorageKey: profileId must match [a-zA-Z0-9_-]+, got ${JSON.stringify(profileId)}`);
	return `${key}.${PROFILE_SEGMENT}.${profileId}`;
}
function descriptorKind(source) {
	if (source === "file") return "value";
	if (source === "keychain-encrypted") return "secret";
	return "reference";
}
function parseMetaRecord(raw, metaKey) {
	const parsed = JSON.parse(raw);
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error(`vault: meta entry ${metaKey} is not a JSON object (got ${typeof parsed})`);
	const obj = parsed;
	const out = {};
	const cat = obj.category;
	if (typeof cat === "string" && isCategory(cat)) out.category = cat;
	if (typeof obj.label === "string" && obj.label.length > 0) out.label = obj.label;
	if (typeof obj.providerId === "string" && obj.providerId.length > 0) out.providerId = obj.providerId;
	if (typeof obj.lastModified === "number") out.lastModified = obj.lastModified;
	if (typeof obj.lastUsed === "number") out.lastUsed = obj.lastUsed;
	if (typeof obj.activeProfile === "string" && obj.activeProfile.length > 0) out.activeProfile = obj.activeProfile;
	if (Array.isArray(obj.profiles)) {
		const profiles = [];
		for (const p of obj.profiles) {
			if (!p || typeof p !== "object") continue;
			const rec = p;
			if (typeof rec.id !== "string" || rec.id.length === 0) continue;
			const label = typeof rec.label === "string" && rec.label.length > 0 ? rec.label : rec.id;
			const profile = {
				id: rec.id,
				label,
				...typeof rec.createdAt === "number" ? { createdAt: rec.createdAt } : {}
			};
			profiles.push(profile);
		}
		if (profiles.length > 0) out.profiles = profiles;
	}
	return out;
}
function isCategory(v) {
	return v === "provider" || v === "plugin" || v === "wallet" || v === "credential" || v === "system" || v === "session";
}
var META_PREFIX, ROUTING_KEY, PROFILE_SEGMENT, PROVIDER_KEY_TO_ID, PROVIDER_EXACT_KEYS, PROVIDER_KEY_PATTERNS, PROVIDER_LABELS;
var init_inventory = __esmMin((() => {
	META_PREFIX = "_meta.";
	ROUTING_KEY = "_routing.config";
	PROFILE_SEGMENT = "profile";
	PROVIDER_KEY_TO_ID = {
		OPENAI_API_KEY: "openai",
		ANTHROPIC_API_KEY: "anthropic",
		OPENROUTER_API_KEY: "openrouter",
		GROQ_API_KEY: "groq",
		XAI_API_KEY: "grok",
		DEEPSEEK_API_KEY: "deepseek",
		MISTRAL_API_KEY: "mistral",
		TOGETHER_API_KEY: "together",
		GOOGLE_GENERATIVE_AI_API_KEY: "gemini",
		GOOGLE_API_KEY: "gemini",
		GEMINI_API_KEY: "gemini"
	};
	PROVIDER_EXACT_KEYS = new Set(Object.keys(PROVIDER_KEY_TO_ID));
	PROVIDER_KEY_PATTERNS = [
		/^OPENAI_API_KEY$/,
		/^ANTHROPIC_API_KEY$/,
		/^OPENROUTER_API_KEY$/,
		/^GROQ_API_KEY$/,
		/^XAI_API_KEY$/,
		/^DEEPSEEK_API_KEY$/,
		/^MISTRAL_API_KEY$/,
		/^TOGETHER_API_KEY$/,
		/^GOOGLE_(?:GENERATIVE_AI_)?API_KEY$/,
		/^GEMINI_API_KEY$/,
		/^PERPLEXITY_API_KEY$/
	];
	PROVIDER_LABELS = {
		openai: "OpenAI",
		anthropic: "Anthropic",
		openrouter: "OpenRouter",
		groq: "Groq",
		grok: "xAI Grok",
		deepseek: "DeepSeek",
		mistral: "Mistral",
		together: "Together",
		gemini: "Gemini"
	};
}));

//#endregion
//#region node_modules/.bun/@elizaos+vault@2.0.0-alpha.537/node_modules/@elizaos/vault/dist/profiles.js
/**
* Resolve `key` against (a) per-context routing rules, (b) the key's
* `activeProfile`, (c) the global `defaultProfile`, then (d) the bare
* key value.
*
* Throws when none of the above resolves to a stored value — callers
* decide how to surface the miss (e.g. inventory routes return 404,
* runtime callers fall back to env var).
*/
async function resolveActiveValue(vault, key, ctx) {
	const meta = await readEntryMeta(vault, key);
	const profiles = meta?.profiles ?? [];
	if (profiles.length > 0) {
		const routing = await readRoutingConfig(vault);
		const candidateOrder = [
			pickRule(routing.rules, key, ctx)?.profileId,
			meta?.activeProfile,
			routing.defaultProfile
		].filter((v) => typeof v === "string" && v.length > 0);
		const allowed = new Set(profiles.map((p) => p.id));
		for (const candidate of candidateOrder) {
			if (!allowed.has(candidate)) continue;
			const profileKey = profileStorageKey(key, candidate);
			if (await vault.has(profileKey)) return vault.get(profileKey);
		}
	}
	return vault.get(key);
}
/**
* Read the routing config blob from the vault. Missing or malformed
* entries return `EMPTY_ROUTING` — routing is best-effort overlay,
* not a load-bearing contract.
*/
async function readRoutingConfig(vault) {
	if (!await vault.has(ROUTING_KEY)) return EMPTY_ROUTING;
	return parseRoutingConfig(await vault.get(ROUTING_KEY));
}
/** Persist the routing config blob. Caller-validated input. */
async function writeRoutingConfig(vault, config) {
	const normalized = normalizeRoutingConfig(config);
	await vault.set(ROUTING_KEY, JSON.stringify(normalized));
}
function pickRule(rules, key, ctx) {
	if (!ctx) return null;
	for (const rule of rules) {
		if (rule.keyPattern !== key) continue;
		if (matchesScope(rule.scope, ctx)) return rule;
	}
	return null;
}
function matchesScope(scope, ctx) {
	if (scope.kind === "agent") return typeof scope.agentId === "string" && typeof ctx.agentId === "string" && scope.agentId === ctx.agentId;
	if (scope.kind === "app") return typeof scope.appName === "string" && typeof ctx.appName === "string" && scope.appName === ctx.appName;
	if (scope.kind === "skill") return typeof scope.skillId === "string" && typeof ctx.skillId === "string" && scope.skillId === ctx.skillId;
	return false;
}
function parseRoutingConfig(raw) {
	const parsed = JSON.parse(raw);
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return EMPTY_ROUTING;
	const obj = parsed;
	const rules = [];
	if (Array.isArray(obj.rules)) for (const r of obj.rules) {
		const normalized = normalizeRule(r);
		if (normalized) rules.push(normalized);
	}
	return {
		rules,
		...typeof obj.defaultProfile === "string" && obj.defaultProfile.length > 0 ? { defaultProfile: obj.defaultProfile } : {}
	};
}
function normalizeRoutingConfig(config) {
	const rules = [];
	for (const r of config.rules ?? []) {
		const normalized = normalizeRule(r);
		if (normalized) rules.push(normalized);
	}
	return {
		rules,
		...typeof config.defaultProfile === "string" && config.defaultProfile.length > 0 ? { defaultProfile: config.defaultProfile } : {}
	};
}
function normalizeRule(r) {
	if (!r || typeof r !== "object") return null;
	const rec = r;
	if (typeof rec.keyPattern !== "string" || rec.keyPattern.length === 0) return null;
	if (rec.keyPattern.startsWith(META_PREFIX) || rec.keyPattern === ROUTING_KEY) return null;
	if (typeof rec.profileId !== "string" || rec.profileId.length === 0) return null;
	const scope = rec.scope;
	if (!scope || typeof scope !== "object") return null;
	const scopeRec = scope;
	const kind = scopeRec.kind;
	if (kind !== "agent" && kind !== "app" && kind !== "skill") return null;
	if (kind === "agent" && typeof scopeRec.agentId === "string") return {
		keyPattern: rec.keyPattern,
		scope: {
			kind: "agent",
			agentId: scopeRec.agentId
		},
		profileId: rec.profileId
	};
	if (kind === "app" && typeof scopeRec.appName === "string") return {
		keyPattern: rec.keyPattern,
		scope: {
			kind: "app",
			appName: scopeRec.appName
		},
		profileId: rec.profileId
	};
	if (kind === "skill" && typeof scopeRec.skillId === "string") return {
		keyPattern: rec.keyPattern,
		scope: {
			kind: "skill",
			skillId: scopeRec.skillId
		},
		profileId: rec.profileId
	};
	return null;
}
var EMPTY_ROUTING;
var init_profiles = __esmMin((() => {
	init_inventory();
	EMPTY_ROUTING = { rules: [] };
}));

//#endregion
//#region node_modules/.bun/@elizaos+vault@2.0.0-alpha.537/node_modules/@elizaos/vault/dist/manager.js
function createManager(opts = {}) {
	return new ManagerImpl(opts.vault ?? createVault(), opts.exec ?? defaultExecFn());
}
function normalizePreferences(prefs) {
	const validIds = new Set([
		"in-house",
		"1password",
		"protonpass",
		"bitwarden"
	]);
	const enabled = (Array.isArray(prefs.enabled) ? prefs.enabled : []).filter((id) => validIds.has(id));
	if (enabled.length === 0) enabled.push("in-house");
	const routing = {};
	if (prefs.routing && typeof prefs.routing === "object") {
		for (const [k, v] of Object.entries(prefs.routing)) if (typeof k === "string" && validIds.has(v)) routing[k] = v;
	}
	return {
		enabled,
		...Object.keys(routing).length > 0 ? { routing } : {}
	};
}
function detectInHouse() {
	return {
		id: "in-house",
		label: "Eliza (local, encrypted)",
		available: true,
		signedIn: true
	};
}
async function readStoredSession(vault, backend) {
	try {
		return (await vault.get(`pm.${backend}.session`)).trim() || null;
	} catch {
		return null;
	}
}
async function detectOnePassword(vault) {
	if (!await isCommandAvailable("op")) return {
		id: "1password",
		label: "1Password",
		available: false,
		detail: "`op` CLI not installed. Get it at https://developer.1password.com/docs/cli",
		authMode: null
	};
	const account = await readDefaultOpAccount();
	if (await isOnePasswordDesktopActive(account)) return {
		id: "1password",
		label: "1Password",
		available: true,
		signedIn: true,
		authMode: "desktop-app",
		detail: "Authenticated via 1Password desktop app."
	};
	const session = await readStoredSession(vault, "1password");
	if (!session) return {
		id: "1password",
		label: "1Password",
		available: true,
		signedIn: false,
		authMode: null,
		detail: "`op` is installed but not signed in. Enable 1Password desktop app integration (Settings → Developer → Integrate with 1Password CLI) or use the Sign-in button."
	};
	const accountArg = account ? [`--account=${account}`] : [];
	try {
		await exec$1("op", [
			...accountArg,
			"whoami",
			`--session=${session}`
		], { timeout: 3e3 });
		return {
			id: "1password",
			label: "1Password",
			available: true,
			signedIn: true,
			authMode: "session-token"
		};
	} catch {
		return {
			id: "1password",
			label: "1Password",
			available: true,
			signedIn: false,
			authMode: null,
			detail: "Stored 1Password session is no longer valid. Sign in again."
		};
	}
}
/** Read the first registered 1Password account shorthand, or null. */
async function readDefaultOpAccount() {
	try {
		const { stdout } = await exec$1("op", [
			"account",
			"list",
			"--format=json"
		], {
			timeout: 3e3,
			encoding: "utf8"
		});
		const accounts = JSON.parse(stdout);
		for (const a of accounts) {
			if (typeof a.shorthand === "string" && a.shorthand.length > 0) return a.shorthand;
			if (typeof a.url === "string") {
				const sub = a.url.split(".")[0];
				if (sub) return sub;
			}
		}
		return null;
	} catch {
		return null;
	}
}
/**
* True when a real vault query succeeds without a session token — i.e.
* 1Password desktop app integration is active. `op whoami` is unusable
* here: even with desktop integration active it exits 1 demanding a
* session token. A vault list query IS handled by desktop session
* delegation, so probe with that instead. Requires a known account.
*/
async function isOnePasswordDesktopActive(account) {
	if (!account) return false;
	try {
		await exec$1("op", [
			`--account=${account}`,
			"vault",
			"list",
			"--format=json"
		], { timeout: 3e3 });
		return true;
	} catch {
		return false;
	}
}
async function detectProtonPass() {
	const present = await isCommandAvailable("protonpass-cli");
	return {
		id: "protonpass",
		label: "Proton Pass",
		available: present,
		authMode: null,
		detail: present ? "Detected; reference storage will be wired when the vendor CLI stabilizes." : "`protonpass-cli` not installed (vendor CLI is in beta)."
	};
}
async function detectBitwarden(vault) {
	if (!await isCommandAvailable("bw")) return {
		id: "bitwarden",
		label: "Bitwarden",
		available: false,
		detail: "`bw` CLI not installed. https://bitwarden.com/help/cli/",
		authMode: null
	};
	const session = await readStoredSession(vault, "bitwarden");
	const env = session ? {
		...process.env,
		BW_SESSION: session
	} : process.env;
	try {
		const { stdout } = await exec$1("bw", ["status"], {
			timeout: 3e3,
			encoding: "utf8",
			env
		});
		const status = JSON.parse(stdout.trim());
		if (status.status === "unlocked") return {
			id: "bitwarden",
			label: "Bitwarden",
			available: true,
			signedIn: true,
			authMode: session ? "session-token" : null
		};
		return {
			id: "bitwarden",
			label: "Bitwarden",
			available: true,
			signedIn: false,
			authMode: null,
			detail: session ? "Stored Bitwarden session is no longer valid. Sign in again." : status.status === "locked" ? "`bw` is signed in but locked. Use the Sign-in button." : "`bw` is installed but not signed in. Use the Sign-in button."
		};
	} catch {
		return {
			id: "bitwarden",
			label: "Bitwarden",
			available: true,
			signedIn: false,
			authMode: null,
			detail: "`bw status` failed; CLI may need an update."
		};
	}
}
function mapExternalReveal(out) {
	return {
		source: out.source,
		identifier: out.externalId,
		username: out.username,
		password: out.password,
		domain: out.domain,
		...out.totp ? { totp: out.totp } : {}
	};
}
async function safeListExternal(_source, fn) {
	try {
		return {
			ok: true,
			entries: await fn()
		};
	} catch (err) {
		return {
			ok: false,
			message: err instanceof Error ? err.message : String(err)
		};
	}
}
async function isCommandAvailable(cmd) {
	try {
		if (process.platform === "win32") await exec$1("where.exe", [cmd], { timeout: 3e3 });
		else await exec$1("which", [cmd], { timeout: 3e3 });
		return true;
	} catch {
		return false;
	}
}
var exec$1, DEFAULT_PREFERENCES, PREFERENCES_KEY, ManagerImpl;
var init_manager = __esmMin((() => {
	init_credentials();
	init_external_credentials();
	init_profiles();
	init_vault();
	exec$1 = promisify(execFile);
	DEFAULT_PREFERENCES = { enabled: ["in-house"] };
	PREFERENCES_KEY = "_manager.preferences";
	ManagerImpl = class {
		vault;
		execFn;
		constructor(vault, execFn) {
			this.vault = vault;
			this.execFn = execFn;
		}
		async getPreferences() {
			try {
				const raw = await this.vault.get(PREFERENCES_KEY);
				return normalizePreferences(JSON.parse(raw));
			} catch (err) {
				if (err instanceof VaultMissError) return DEFAULT_PREFERENCES;
				throw err;
			}
		}
		async setPreferences(prefs) {
			const normalized = normalizePreferences(prefs);
			await this.vault.set(PREFERENCES_KEY, JSON.stringify(normalized), { sensitive: true });
		}
		async set(key, value, opts = {}) {
			const target = await this.resolveTargetBackend(key, opts);
			if (target === "in-house") {
				await this.vault.set(key, value, {
					...opts.sensitive ? { sensitive: true } : {},
					...opts.caller ? { caller: opts.caller } : {}
				});
				return;
			}
			throw new Error(`manager.set: backend "${target}" cannot accept direct writes yet. Store the secret in that password manager first and save a reference explicitly.`);
		}
		async get(key) {
			return this.vault.get(key);
		}
		async getActive(key, ctx) {
			return resolveActiveValue(this.vault, key, ctx);
		}
		async has(key) {
			return this.vault.has(key);
		}
		async remove(key) {
			return this.vault.remove(key);
		}
		async list(prefix) {
			return (await this.vault.list(prefix)).filter((k) => !k.startsWith("_manager.") && !k.startsWith("_meta.") && k !== "_routing.config");
		}
		async detectBackends() {
			return Promise.all([
				Promise.resolve(detectInHouse()),
				detectOnePassword(this.vault),
				detectProtonPass(),
				detectBitwarden(this.vault)
			]);
		}
		async listAllSavedLogins(opts = {}) {
			const requestedDomain = opts.domain ? opts.domain.trim().toLowerCase() : void 0;
			const failures = [];
			const inHouseEntries = await this.fetchInHouseEntries(requestedDomain);
			const externalEntries = [];
			const backends = await this.detectBackends();
			const onePasswordReady = backends.find((b) => b.id === "1password")?.signedIn === true;
			const bitwardenReady = backends.find((b) => b.id === "bitwarden")?.signedIn === true;
			if (onePasswordReady) {
				const result = await safeListExternal("1password", () => listOnePasswordLogins(this.vault, this.execFn));
				if (result.ok === true) externalEntries.push(...result.entries);
				else failures.push({
					source: "1password",
					message: result.message
				});
			}
			if (bitwardenReady) {
				const result = await safeListExternal("bitwarden", () => listBitwardenLogins(this.vault, this.execFn));
				if (result.ok === true) externalEntries.push(...result.entries);
				else failures.push({
					source: "bitwarden",
					message: result.message
				});
			}
			const externalUnified = (requestedDomain ? externalEntries.filter((e) => e.domain !== null && e.domain.toLowerCase() === requestedDomain) : externalEntries).map((e) => ({
				source: e.source,
				identifier: e.externalId,
				domain: e.domain,
				username: e.username,
				title: e.title,
				updatedAt: e.updatedAt
			})).sort((a, b) => b.updatedAt - a.updatedAt);
			return {
				logins: [...[...inHouseEntries].sort((a, b) => {
					const dA = (a.domain ?? "").toLowerCase();
					const dB = (b.domain ?? "").toLowerCase();
					if (dA !== dB) return dA < dB ? -1 : 1;
					return a.username < b.username ? -1 : a.username > b.username ? 1 : 0;
				}), ...externalUnified],
				failures
			};
		}
		async revealSavedLogin(source, identifier) {
			if (typeof identifier !== "string" || identifier.length === 0) throw new TypeError("revealSavedLogin: identifier required");
			if (source === "in-house") {
				const colon = identifier.indexOf(":");
				if (colon <= 0) throw new TypeError(`revealSavedLogin: in-house identifier must be "<domain>:<username>", got "${identifier}"`);
				const domain = identifier.slice(0, colon);
				const username = identifier.slice(colon + 1);
				const login = await getSavedLogin(this.vault, domain, username);
				if (!login) throw new Error(`revealSavedLogin: no in-house login for ${domain}:${username}`);
				return {
					source: "in-house",
					identifier,
					username: login.username,
					password: login.password,
					domain: login.domain,
					...login.otpSeed ? { totp: login.otpSeed } : {}
				};
			}
			if (source === "1password") return mapExternalReveal(await revealOnePasswordLogin(this.vault, this.execFn, identifier));
			return mapExternalReveal(await revealBitwardenLogin(this.vault, this.execFn, identifier));
		}
		async fetchInHouseEntries(requestedDomain) {
			return (requestedDomain ? await listSavedLogins(this.vault, requestedDomain) : await listSavedLogins(this.vault)).map((s) => ({
				source: "in-house",
				identifier: `${s.domain}:${s.username}`,
				domain: s.domain,
				username: s.username,
				title: s.username,
				updatedAt: s.lastModified
			}));
		}
		async resolveTargetBackend(key, opts) {
			if (opts.store) return opts.store;
			if (!opts.sensitive) return "in-house";
			const prefs = await this.getPreferences();
			const routed = prefs.routing?.[key];
			if (routed) return routed;
			return prefs.enabled[0] ?? "in-house";
		}
	};
}));

//#endregion
//#region node_modules/.bun/@elizaos+vault@2.0.0-alpha.537/node_modules/@elizaos/vault/dist/install.js
/**
* Install spec — what install methods exist for each external secrets-manager
* backend on which OS, and how to detect whether a given package manager is
* present on the host.
*
* Detection-only. The actual `child_process` execution and streaming live in
* the consumer (app-core's `secrets-manager-installer`); this module is pure
* data + small async checks so it stays usable from the vault package
* without pulling in spawn/PTY machinery.
*/
async function detectPackageManagers() {
	if (_packageManagerCache) return _packageManagerCache;
	const [brew, npm] = await Promise.all([isCommandRunnable("brew"), isCommandRunnable("npm")]);
	_packageManagerCache = {
		brew,
		npm
	};
	return _packageManagerCache;
}
async function isCommandRunnable(cmd) {
	try {
		await exec(cmd, ["--version"], { timeout: 5e3 });
		return true;
	} catch {
		return false;
	}
}
/**
* Resolve the install methods that are *runnable on this host* for a given
* backend. Manual methods are always returned (so the UI can show the doc
* link); brew/npm methods are filtered to those whose tool is present.
*/
async function resolveRunnableMethods(id, platform = currentPlatform()) {
	const candidates = BACKEND_INSTALL_SPECS[id].methods[platform] ?? [];
	if (candidates.length === 0) return [];
	const tools = await detectPackageManagers();
	return candidates.filter((m) => {
		if (m.kind === "brew") return tools.brew;
		if (m.kind === "npm") return tools.npm;
		return true;
	});
}
function currentPlatform() {
	const p = process.platform;
	if (p === "darwin" || p === "linux" || p === "win32") return p;
	return "linux";
}
/**
* Build the argv for a given install method. Caller spawns directly with
* argv (no shell interpolation). Returns null for `manual` — those have no
* automated execution path.
*/
function buildInstallCommand(method) {
	if (method.kind === "brew") return {
		command: "brew",
		args: method.cask ? [
			"install",
			"--cask",
			method.package
		] : ["install", method.package]
	};
	if (method.kind === "npm") return {
		command: "npm",
		args: [
			"install",
			"-g",
			method.package
		]
	};
	return null;
}
var exec, BACKEND_INSTALL_SPECS, _packageManagerCache;
var init_install = __esmMin((() => {
	exec = promisify(execFile);
	BACKEND_INSTALL_SPECS = {
		"1password": {
			id: "1password",
			methods: {
				darwin: [{
					kind: "brew",
					package: "1password-cli",
					cask: true
				}, {
					kind: "manual",
					instructions: "Download the 1Password CLI installer for macOS from the official page.",
					url: "https://developer.1password.com/docs/cli/get-started"
				}],
				linux: [{
					kind: "manual",
					instructions: "Follow the official Linux install instructions (apt/dnf/zypper repo with signed packages).",
					url: "https://developer.1password.com/docs/cli/get-started/#linux"
				}],
				win32: [{
					kind: "manual",
					instructions: "Install via winget or the MSI from the official 1Password CLI page.",
					url: "https://developer.1password.com/docs/cli/get-started/#windows"
				}]
			}
		},
		bitwarden: {
			id: "bitwarden",
			methods: {
				darwin: [{
					kind: "brew",
					package: "bitwarden-cli",
					cask: false
				}, {
					kind: "npm",
					package: "@bitwarden/cli"
				}],
				linux: [{
					kind: "npm",
					package: "@bitwarden/cli"
				}],
				win32: [{
					kind: "npm",
					package: "@bitwarden/cli"
				}]
			}
		},
		protonpass: {
			id: "protonpass",
			methods: {
				darwin: [{
					kind: "manual",
					instructions: "Proton Pass CLI is in closed beta. Track Proton's roadmap or use the desktop app.",
					url: "https://proton.me/pass"
				}],
				linux: [{
					kind: "manual",
					instructions: "Proton Pass CLI is in closed beta. Track Proton's roadmap or use the desktop app.",
					url: "https://proton.me/pass"
				}],
				win32: [{
					kind: "manual",
					instructions: "Proton Pass CLI is in closed beta. Track Proton's roadmap or use the desktop app.",
					url: "https://proton.me/pass"
				}]
			}
		}
	};
	_packageManagerCache = null;
}));

//#endregion
//#region node_modules/.bun/@elizaos+vault@2.0.0-alpha.537/node_modules/@elizaos/vault/dist/index.js
var init_dist = __esmMin((() => {
	init_vault();
	init_master_key();
	init_password_managers();
	init_manager();
	init_install();
	init_credentials();
	init_inventory();
	init_profiles();
}));

//#endregion
//#region node_modules/.bun/@elizaos+app-core@2.0.0-alpha.537+72829346cb4c43b1/node_modules/@elizaos/app-core/packages/app-core/src/config/env-vars.js
var TELEGRAM_ACCOUNT_ENV_MAP, CONNECTOR_ENV_MAP$1;
var init_env_vars = __esmMin((() => {
	TELEGRAM_ACCOUNT_ENV_MAP = {
		phone: "TELEGRAM_ACCOUNT_PHONE",
		appId: "TELEGRAM_ACCOUNT_APP_ID",
		appHash: "TELEGRAM_ACCOUNT_APP_HASH",
		deviceModel: "TELEGRAM_ACCOUNT_DEVICE_MODEL",
		systemVersion: "TELEGRAM_ACCOUNT_SYSTEM_VERSION"
	};
	CONNECTOR_ENV_MAP$1 = {
		...CONNECTOR_ENV_MAP,
		telegramAccount: CONNECTOR_ENV_MAP.telegramAccount ?? TELEGRAM_ACCOUNT_ENV_MAP
	};
}));

//#endregion
//#region node_modules/.bun/@elizaos+app-core@2.0.0-alpha.537+72829346cb4c43b1/node_modules/@elizaos/app-core/packages/app-core/src/config/plugin-auto-enable.js
var CONNECTOR_PLUGINS$1;
var init_plugin_auto_enable = __esmMin((() => {
	CONNECTOR_PLUGINS$1 = {
		...CONNECTOR_PLUGINS,
		wechat: "elizaoswechat"
	};
}));

//#endregion
//#region node_modules/.bun/@elizaos+app-core@2.0.0-alpha.537+72829346cb4c43b1/node_modules/@elizaos/app-core/packages/app-core/src/services/vault-mirror.js
/**
* Write-through mirror to @elizaos/vault for plugin sensitive fields.
*
* Extracted from plugins-compat-routes.ts so unit tests can exercise the
* mirror logic without dragging in the entire @elizaos/agent runtime.
*
* Concurrency: the vault PUT path is hit concurrently when the UI saves
* multiple plugin configs in parallel. `VaultImpl.mutate()` has its own
* process and filesystem locks; the process-level manager cache keeps the
* plugin-save path and `/api/secrets/manager/*` routes sharing one facade.
*/
function sharedSecretsManager() {
	if (!cachedManager) cachedManager = createManager();
	return cachedManager;
}
function sharedVault() {
	return sharedSecretsManager().vault;
}
/**
* Test-only: drop the cached vault so the next `sharedVault()` call
* re-initializes from the (possibly newly configured) environment.
* Also lets tests inject a test vault built via `createTestVault`.
*/
function _resetSharedVaultForTesting(next = null) {
	cachedManager = next ? createManager({ vault: next }) : null;
}
/**
* Write-through mirror to @elizaos/vault. Iterates the plugin's
* declared parameters, finds sensitive ones, and writes whatever
* value the user just submitted into the vault as a sensitive entry.
*
* Returns the list of keys that failed to write. The PUT handler
* surfaces them under `vaultMirrorFailures` in the response so the UI
* can warn the user that their secret was saved to legacy config but
* not mirrored to the vault. Per-key try/catch keeps one failed key
* from aborting the rest of the loop.
*
* Vault key shape: the env-var name itself (e.g.
* `OPENROUTER_API_KEY`). Stable, matches what the legacy code uses,
* and lets the read-side hydration round-trip cleanly.
*/
async function mirrorPluginSensitiveToVault(plugin, body) {
	const failures = [];
	const config = asRecord(body)?.config;
	const configRecord = asRecord(config);
	if (!configRecord) return { failures };
	const sensitiveKeys = plugin.parameters.filter((p) => p.sensitive).map((p) => p.key);
	if (sensitiveKeys.length === 0) return { failures };
	const manager = sharedSecretsManager();
	for (const key of sensitiveKeys) {
		const value = configRecord[key];
		if (typeof value !== "string") continue;
		try {
			if (value.length === 0) await manager.remove(key);
			else await manager.set(key, value, {
				sensitive: true,
				caller: "plugins-compat"
			});
		} catch (err) {
			failures.push(key);
			logger.warn(`[plugins-compat] vault mirror for ${key} failed: ${err instanceof Error ? err.message : String(err)}`);
		}
	}
	return { failures };
}
var cachedManager;
var init_vault_mirror = __esmMin((() => {
	init_dist();
	cachedManager = null;
}));

//#endregion
//#region node_modules/.bun/@elizaos+app-core@2.0.0-alpha.537+72829346cb4c43b1/node_modules/@elizaos/app-core/packages/app-core/src/api/plugins-compat-routes.js
var plugins_compat_routes_exports = /* @__PURE__ */ __exportAll({
	_resetSharedVaultForTesting: () => _resetSharedVaultForTesting,
	analyzePluginStateDrift: () => analyzePluginStateDrift,
	buildPluginListResponse: () => buildPluginListResponse,
	handlePluginsCompatRoutes: () => handlePluginsCompatRoutes,
	mirrorPluginSensitiveToVault: () => mirrorPluginSensitiveToVault,
	persistCompatPluginMutation: () => persistCompatPluginMutation,
	resolveAdvancedCapabilityCompatStatus: () => resolveAdvancedCapabilityCompatStatus,
	resolveCompatPluginEnabledForList: () => resolveCompatPluginEnabledForList,
	resolvePluginManifestPath: () => resolvePluginManifestPath
});
function maskValue(value) {
	if (value.length <= 8) return "****";
	return `${value.slice(0, 4)}...${value.slice(-4)}`;
}
function normalizePluginCategory(value) {
	switch (value) {
		case "ai-provider":
		case "connector":
		case "streaming":
		case "database":
		case "app": return value;
		default: return "feature";
	}
}
function normalizePluginId(rawName) {
	const scopedPackage = rawName.match(/^@[^/]+\/(?:plugin|app)-(.+)$/);
	if (scopedPackage) return scopedPackage[1] ?? rawName;
	return rawName.replace(/^@[^/]+\//, "").replace(/^(plugin|app)-/, "");
}
function resolveCompatConfigKey(pluginId, npmName, pluginMap) {
	const candidates = new Set([pluginId, normalizePluginId(pluginId)]);
	if (typeof npmName === "string" && npmName.length > 0) {
		candidates.add(npmName);
		candidates.add(normalizePluginId(npmName));
	}
	for (const [configKey, packageName] of Object.entries(pluginMap)) if (candidates.has(configKey) || candidates.has(packageName) || candidates.has(normalizePluginId(packageName))) return configKey;
	return null;
}
function readCompatSectionEnabled(section, configKey) {
	if (!configKey) return;
	const sectionRecord = asRecord(section);
	if (!sectionRecord) return;
	const targetRecord = asRecord(sectionRecord[configKey]);
	if (!targetRecord || typeof targetRecord.enabled !== "boolean") return;
	return targetRecord.enabled;
}
function writeCompatSectionEnabled(parent, sectionKey, configKey, enabled) {
	if (!configKey) return;
	const section = asRecord(parent[sectionKey]) ?? {};
	const entry = asRecord(section[configKey]) ?? {};
	entry.enabled = enabled;
	section[configKey] = entry;
	parent[sectionKey] = section;
}
function syncCompatConnectorConfigValues(config, pluginId, npmName, values) {
	const connectorKey = resolveCompatConfigKey(pluginId, npmName, CONNECTOR_PLUGINS$1);
	if (!connectorKey) return;
	const envMap = CONNECTOR_ENV_MAP$1[connectorKey];
	if (!envMap) return;
	const typedEnvMap = envMap;
	const connectors = asRecord(config.connectors) ?? {};
	const connectorEntry = asRecord(connectors[connectorKey]) ?? {};
	const envToField = /* @__PURE__ */ new Map();
	for (const [field, envKey] of Object.entries(typedEnvMap)) if (!envToField.has(envKey)) envToField.set(envKey, field);
	let touched = false;
	for (const [envKey, field] of envToField.entries()) {
		if (!(envKey in values)) continue;
		touched = true;
		const value = values[envKey];
		if (value.trim()) connectorEntry[field] = value;
		else delete connectorEntry[field];
	}
	if (connectorKey === "discord" && "DISCORD_API_TOKEN" in values) {
		touched = true;
		const tokenValue = values.DISCORD_API_TOKEN.trim();
		if (tokenValue) connectorEntry.token = tokenValue;
		else delete connectorEntry.token;
		delete connectorEntry.botToken;
	}
	if (!touched) return;
	connectors[connectorKey] = connectorEntry;
	config.connectors = connectors;
}
function resolvePersistedPluginEnabled(pluginId, category, npmName, configEntries, config) {
	const pluginEnabled = typeof configEntries[pluginId]?.enabled === "boolean" ? Boolean(configEntries[pluginId]?.enabled) : void 0;
	if (category === "connector") return readCompatSectionEnabled(config.connectors, resolveCompatConfigKey(pluginId, npmName, CONNECTOR_PLUGINS$1)) ?? pluginEnabled;
	if (category === "streaming") return readCompatSectionEnabled(config.streaming, resolveCompatConfigKey(pluginId, npmName, STREAMING_PLUGINS)) ?? pluginEnabled;
	return pluginEnabled;
}
function resolveCompatPluginEnabledForList(active, persistedEnabled, advancedCapabilityEnabled) {
	return advancedCapabilityEnabled ?? persistedEnabled ?? active;
}
function shortPluginIdFromNpmName(npmName) {
	if (!npmName || typeof npmName !== "string") return null;
	if (npmName.startsWith("@elizaos/app-")) return npmName.slice(9);
	if (npmName.startsWith("@elizaos/plugin-")) return npmName.slice(16);
	return normalizePluginId(npmName);
}
function analyzePluginStateDrift(pluginList, configRecord, configEntries, allowList) {
	const diagnostics = pluginList.map((plugin) => {
		const pluginId = String(plugin.id ?? "");
		const category = normalizePluginCategory(plugin.category);
		const npmName = typeof plugin.npmName === "string" && plugin.npmName.length > 0 ? plugin.npmName : null;
		const shortId = shortPluginIdFromNpmName(npmName) ?? pluginId;
		const uiEnabled = Boolean(plugin.enabled);
		const compatEnabled = category === "connector" ? readCompatSectionEnabled(configRecord.connectors, resolveCompatConfigKey(pluginId, npmName ?? void 0, CONNECTOR_PLUGINS$1)) : category === "streaming" ? readCompatSectionEnabled(configRecord.streaming, resolveCompatConfigKey(pluginId, npmName ?? void 0, STREAMING_PLUGINS)) : void 0;
		const entryEnabled = typeof configEntries[pluginId]?.enabled === "boolean" ? Boolean(configEntries[pluginId]?.enabled) : void 0;
		const enabledAllowList = allowList === null || npmName == null ? null : allowList.has(npmName) || allowList.has(shortId);
		const isActive = Boolean(plugin.isActive);
		const driftFlags = [];
		if (compatEnabled !== void 0 && entryEnabled !== void 0 && compatEnabled !== entryEnabled) driftFlags.push("entries_vs_compat");
		if (enabledAllowList !== null && entryEnabled !== void 0) {
			if (enabledAllowList !== entryEnabled) driftFlags.push("entries_vs_allowlist");
		}
		if (uiEnabled && !isActive) driftFlags.push("inactive_but_enabled");
		if (!uiEnabled && isActive) driftFlags.push("active_but_disabled");
		return {
			pluginId,
			npmName,
			category,
			enabled_ui: uiEnabled,
			enabled_allowlist: enabledAllowList,
			is_active: isActive,
			drift_flags: driftFlags
		};
	});
	const withDrift = diagnostics.filter((plugin) => plugin.drift_flags.length > 0);
	const byFlag = {
		entries_vs_compat: 0,
		entries_vs_allowlist: 0,
		inactive_but_enabled: 0,
		active_but_disabled: 0
	};
	for (const plugin of withDrift) for (const flag of plugin.drift_flags) byFlag[flag] += 1;
	return {
		summary: {
			total: diagnostics.length,
			withDrift: withDrift.length,
			byFlag
		},
		plugins: diagnostics
	};
}
function buildPluginDriftDiagnostics(runtime) {
	const pluginList = buildPluginListResponse(runtime).plugins;
	const config = loadElizaConfig();
	return analyzePluginStateDrift(pluginList, config, config.plugins?.entries ?? {}, Array.isArray(config.plugins?.allow) ? new Set(config.plugins.allow) : null);
}
function maybeLogPluginStateDrift(report) {
	if (report.summary.withDrift === 0) return;
	const drifted = report.plugins.filter((plugin) => plugin.drift_flags.length > 0).map((plugin) => `${plugin.pluginId}:${plugin.drift_flags.join("+")}`).sort();
	const fingerprint = drifted.join("|");
	const now = Date.now();
	if (fingerprint === _lastDriftWarningFingerprint && now - _lastDriftWarningAt < DRIFT_LOG_THROTTLE_MS) return;
	_lastDriftWarningAt = now;
	_lastDriftWarningFingerprint = fingerprint;
	logger.warn({
		src: "api:plugins",
		driftCount: report.summary.withDrift,
		byFlag: report.summary.byFlag,
		plugins: drifted
	}, "Plugin enable-state drift detected between /api/plugins and /api/plugins/core models");
}
function reconcilePluginEnabledStates() {
	if (_enabledStateReconciled) return;
	_enabledStateReconciled = true;
	const config = loadElizaConfig();
	const configRecord = config;
	const entries = config.plugins?.entries ?? {};
	let dirty = false;
	for (const [pluginId, entry] of Object.entries(entries)) {
		if (typeof entry.enabled !== "boolean") continue;
		const connectorKey = resolveCompatConfigKey(pluginId, void 0, CONNECTOR_PLUGINS$1);
		if (connectorKey) {
			const sectionEnabled = readCompatSectionEnabled(configRecord.connectors, connectorKey);
			if (sectionEnabled !== void 0 && sectionEnabled !== entry.enabled) {
				writeCompatSectionEnabled(configRecord, "connectors", connectorKey, entry.enabled);
				dirty = true;
			}
		}
		const streamingKey = resolveCompatConfigKey(pluginId, void 0, STREAMING_PLUGINS);
		if (streamingKey) {
			const sectionEnabled = readCompatSectionEnabled(configRecord.streaming, streamingKey);
			if (sectionEnabled !== void 0 && sectionEnabled !== entry.enabled) {
				writeCompatSectionEnabled(configRecord, "streaming", streamingKey, entry.enabled);
				dirty = true;
			}
		}
	}
	if (dirty) {
		saveElizaConfig(config);
		logger.info("[plugins] Reconciled drifted plugin enabled states in config");
	}
}
function compatMutationRequiresRestart(plugin, body) {
	if (typeof body.enabled === "boolean") return true;
	if (body.config !== void 0 && (plugin.category === "connector" || plugin.category === "streaming")) return true;
	return false;
}
function createCompatRuntimeApplyFallback(reason, requiresRestart) {
	return {
		mode: requiresRestart ? "restart_required" : "none",
		requiresRestart,
		restartedRuntime: false,
		loadedPackages: [],
		unloadedPackages: [],
		reloadedPackages: [],
		appliedConfigPackage: null,
		reason
	};
}
async function applyCompatRuntimeMutation(options) {
	const { state, pluginId, plugin, body, previousConfig, nextConfig } = options;
	const reason = typeof body.enabled === "boolean" ? `Plugin toggle: ${pluginId}` : `Plugin config updated: ${pluginId}`;
	const requiresRestartFallback = compatMutationRequiresRestart(plugin, body);
	if (!state.current) return createCompatRuntimeApplyFallback(reason, requiresRestartFallback);
	try {
		return await applyPluginRuntimeMutation({
			runtime: state.current,
			previousConfig,
			nextConfig,
			changedPluginId: pluginId,
			changedPluginPackage: plugin.npmName,
			config: body.config && typeof body.config === "object" && !Array.isArray(body.config) ? body.config : void 0,
			expectRuntimeGraphChange: typeof body.enabled === "boolean",
			reason
		});
	} catch (error) {
		logger.warn(`[api/plugins] Live runtime apply failed for "${pluginId}": ${error instanceof Error ? error.message : String(error)}`);
		return createCompatRuntimeApplyFallback(reason, true);
	}
}
function titleCasePluginId(id) {
	return id.split("-").filter((segment) => segment.length > 0).map((segment) => segment.charAt(0).toUpperCase() + segment.slice(1)).join(" ");
}
function inferSensitiveConfigKey(key) {
	return /(?:_API_KEY|_SECRET|_TOKEN|_PASSWORD|_PRIVATE_KEY|_SIGNING_|ENCRYPTION_)/i.test(key);
}
function buildPluginParamDefs(parameters, savedValues) {
	if (!parameters) return [];
	const allKeys = Object.keys(parameters);
	const GENERIC_FALLBACK_SUFFIXES = [
		"SMALL_MODEL",
		"LARGE_MODEL",
		"IMAGE_MODEL",
		"EMBEDDING_MODEL"
	];
	return Object.entries(parameters).filter(([key]) => {
		if (!GENERIC_FALLBACK_SUFFIXES.includes(key)) return true;
		return !allKeys.some((other) => other !== key && other.endsWith(`_${key}`));
	}).map(([key, definition]) => {
		const envValue = process.env[key]?.trim() || void 0;
		const savedValue = savedValues?.[key];
		const effectiveValue = envValue ?? (savedValue ? savedValue.trim() || void 0 : void 0);
		const isSet = Boolean(effectiveValue);
		const sensitive = typeof definition.sensitive === "boolean" ? definition.sensitive : inferSensitiveConfigKey(key);
		const currentValue = !isSet || !effectiveValue ? null : sensitive ? maskValue(effectiveValue) : effectiveValue;
		return {
			key,
			type: definition.type ?? "string",
			description: definition.description ?? "",
			required: definition.required === true || definition.optional === false && definition.required !== false,
			sensitive,
			default: definition.default === void 0 ? void 0 : String(definition.default),
			options: Array.isArray(definition.options) ? definition.options : void 0,
			currentValue,
			isSet
		};
	});
}
function findNearestFile(startDir, fileName, maxDepth = 12) {
	let dir = path.resolve(startDir);
	for (let depth = 0; depth <= maxDepth; depth += 1) {
		const candidate = path.join(dir, fileName);
		if (fs.existsSync(candidate)) return candidate;
		const parent = path.dirname(dir);
		if (parent === dir) break;
		dir = parent;
	}
	return null;
}
function resolvePluginManifestPath() {
	const moduleDir = path.dirname(fileURLToPath(import.meta.url));
	const candidates = [
		process.cwd(),
		moduleDir,
		path.dirname(process.execPath),
		path.join(path.dirname(process.execPath), "..", "Resources", "app")
	];
	for (const candidate of candidates) {
		const manifestPath = findNearestFile(candidate, "plugins.json");
		if (manifestPath) return manifestPath;
	}
	return null;
}
function resolveInstalledPackageVersion(packageName) {
	if (!packageName) return null;
	try {
		const packageJsonPath = require$2.resolve(`${packageName}/package.json`);
		const pkg = JSON.parse(fs.readFileSync(packageJsonPath, "utf8"));
		return typeof pkg.version === "string" ? pkg.version : null;
	} catch {
		return null;
	}
}
function resolveLoadedPluginNames(runtime) {
	const loadedNames = /* @__PURE__ */ new Set();
	for (const plugin of runtime?.plugins ?? []) {
		const name = plugin.name;
		if (typeof name === "string" && name.length > 0) loadedNames.add(name);
	}
	return loadedNames;
}
function isPluginLoaded(pluginId, npmName, loadedNames) {
	const expectedNames = new Set([
		pluginId,
		`plugin-${pluginId}`,
		`app-${pluginId}`,
		npmName ?? ""
	]);
	for (const loadedName of loadedNames) {
		if (expectedNames.has(loadedName)) return true;
		if (loadedName.endsWith(`/plugin-${pluginId}`) || loadedName.endsWith(`/app-${pluginId}`) || loadedName.includes(pluginId)) return true;
	}
	return false;
}
function resolveAdvancedCapabilityCompatStatus(pluginId, config, runtime) {
	if (!isAdvancedCapabilityPluginId(pluginId)) return null;
	if (!resolveAdvancedCapabilitiesEnabled(config)) return {
		enabled: false,
		isActive: false
	};
	const serviceType = ADVANCED_CAPABILITY_SERVICE_BY_PLUGIN_ID[pluginId];
	return {
		enabled: true,
		isActive: serviceType ? Boolean(runtime?.getService(serviceType)) : Boolean(runtime)
	};
}
function buildPluginListResponse(runtime) {
	reconcilePluginEnabledStates();
	const config = loadElizaConfig();
	const configRecord = config;
	const loadedNames = resolveLoadedPluginNames(runtime);
	const registry = loadRegistry();
	const manifestRoot = resolvePluginManifestPath() ? path.dirname(resolvePluginManifestPath() ?? "") : process.cwd();
	const manifest = entriesToLegacyManifest(registry.all);
	const configEntries = config.plugins?.entries ?? {};
	const installEntries = config.plugins?.installs ?? {};
	const plugins = /* @__PURE__ */ new Map();
	for (const entry of manifest?.plugins ?? []) {
		const pluginId = normalizePluginId(entry.id);
		const category = normalizePluginCategory(entry.category);
		const bundledMeta = entry.dirName && manifestRoot ? readBundledPluginPackageMetadata(manifestRoot, entry.dirName, entry.npmName) : void 0;
		const configKeys = Array.isArray(entry.configKeys) && entry.configKeys.length > 0 ? entry.configKeys : bundledMeta?.configKeys ?? [];
		const envKey = entry.envKey ?? findPrimaryEnvKey(configKeys);
		const parameters = buildPluginParamDefs(entry.pluginParameters ?? bundledMeta?.pluginParameters);
		const advancedCapabilityStatus = resolveAdvancedCapabilityCompatStatus(pluginId, config, runtime);
		const active = advancedCapabilityStatus?.isActive ?? isPluginLoaded(pluginId, entry.npmName, loadedNames);
		const enabled = resolveCompatPluginEnabledForList(active, resolvePersistedPluginEnabled(pluginId, category, entry.npmName, configEntries, configRecord), advancedCapabilityStatus?.enabled);
		const validationErrors = parameters.filter((parameter) => parameter.required && !parameter.isSet).map((parameter) => ({
			field: parameter.key,
			message: "Required value is not configured."
		}));
		const registryEntry = registry.byId.get(pluginId);
		plugins.set(pluginId, {
			id: pluginId,
			name: entry.name ?? titleCasePluginId(pluginId),
			description: entry.description ?? bundledMeta?.description ?? "",
			tags: entry.tags ?? [],
			enabled,
			configured: validationErrors.length === 0,
			envKey,
			category,
			source: "bundled",
			configKeys,
			parameters,
			validationErrors,
			validationWarnings: [],
			npmName: entry.npmName,
			version: resolveInstalledPackageVersion(entry.npmName) ?? entry.version ?? void 0,
			pluginDeps: entry.pluginDeps,
			isActive: active,
			configUiHints: entry.configUiHints ?? bundledMeta?.configUiHints,
			icon: entry.logoUrl ?? bundledMeta?.icon ?? null,
			homepage: entry.homepage ?? bundledMeta?.homepage,
			repository: entry.repository ?? bundledMeta?.repository,
			setupGuideUrl: entry.setupGuideUrl,
			iconName: registryEntry?.render.icon,
			group: registryEntry?.render.group,
			groupOrder: registryEntry?.render.groupOrder,
			visible: registryEntry?.render.visible ?? true
		});
	}
	for (const entry of discoverPluginsFromManifest()) {
		const pluginId = normalizePluginId(entry.id);
		const category = normalizePluginCategory(entry.category);
		if (category === "app" || plugins.has(pluginId)) continue;
		const active = isPluginLoaded(pluginId, entry.npmName, loadedNames);
		const persistedEnabled = resolvePersistedPluginEnabled(pluginId, category, entry.npmName, configEntries, configRecord);
		plugins.set(pluginId, {
			id: pluginId,
			name: entry.name,
			description: entry.description,
			tags: entry.tags ?? [],
			enabled: resolveCompatPluginEnabledForList(active, persistedEnabled),
			configured: entry.configured,
			envKey: entry.envKey,
			category,
			source: entry.source,
			configKeys: entry.configKeys,
			parameters: entry.parameters,
			validationErrors: entry.validationErrors,
			validationWarnings: entry.validationWarnings,
			npmName: entry.npmName,
			version: resolveInstalledPackageVersion(entry.npmName) ?? entry.version ?? void 0,
			pluginDeps: entry.pluginDeps,
			isActive: active,
			configUiHints: entry.configUiHints,
			icon: entry.icon ?? null,
			homepage: entry.homepage,
			repository: entry.repository,
			setupGuideUrl: entry.setupGuideUrl,
			visible: true
		});
	}
	for (const plugin of runtime?.plugins ?? []) {
		const pluginName = typeof plugin.name === "string" ? plugin.name : "";
		if (!pluginName) continue;
		const pluginId = normalizePluginId(pluginName);
		const existing = plugins.get(pluginId);
		if (existing) {
			existing.isActive = true;
			if (existing.enabled !== true && configEntries[pluginId]?.enabled == null) existing.enabled = true;
			if (!existing.version) existing.version = resolveInstalledPackageVersion(pluginName) ?? void 0;
			continue;
		}
		plugins.set(pluginId, {
			id: pluginId,
			name: titleCasePluginId(pluginId),
			description: plugin.description ?? "Loaded runtime plugin discovered without manifest metadata.",
			tags: [],
			enabled: typeof configEntries[pluginId]?.enabled === "boolean" ? Boolean(configEntries[pluginId]?.enabled) : true,
			configured: true,
			envKey: null,
			category: "feature",
			source: "bundled",
			parameters: [],
			validationErrors: [],
			validationWarnings: [],
			npmName: pluginName,
			version: resolveInstalledPackageVersion(pluginName) ?? void 0,
			isActive: true,
			icon: null
		});
	}
	for (const [pluginName, installRecord] of Object.entries(installEntries)) {
		const pluginId = normalizePluginId(pluginName);
		if (plugins.has(pluginId)) continue;
		plugins.set(pluginId, {
			id: pluginId,
			name: titleCasePluginId(pluginId),
			description: "Installed store plugin.",
			tags: [],
			enabled: typeof configEntries[pluginId]?.enabled === "boolean" ? Boolean(configEntries[pluginId]?.enabled) : false,
			configured: true,
			envKey: null,
			category: "feature",
			source: "store",
			parameters: [],
			validationErrors: [],
			validationWarnings: [],
			npmName: pluginName,
			version: typeof installRecord?.version === "string" ? installRecord.version : resolveInstalledPackageVersion(pluginName) ?? void 0,
			isActive: isPluginLoaded(pluginId, pluginName, loadedNames),
			icon: null
		});
	}
	return { plugins: Array.from(plugins.values()).sort((left, right) => String(left.name ?? "").localeCompare(String(right.name ?? ""))) };
}
function validateCompatPluginConfig(plugin, config) {
	const paramMap = new Map(plugin.parameters.map((parameter) => [parameter.key, parameter]));
	const errors = [];
	const values = {};
	for (const [key, rawValue] of Object.entries(config)) {
		const parameter = paramMap.get(key);
		if (!parameter) {
			errors.push({
				field: key,
				message: `${key} is not a declared config key for this plugin`
			});
			continue;
		}
		if (typeof rawValue !== "string") {
			errors.push({
				field: key,
				message: "Plugin config values must be strings."
			});
			continue;
		}
		const trimmed = rawValue.trim();
		if (parameter.required && trimmed.length === 0) {
			errors.push({
				field: key,
				message: "Required value is not configured."
			});
			continue;
		}
		values[key] = rawValue;
	}
	return {
		errors,
		values
	};
}
function persistCompatPluginMutation(pluginId, body, plugin) {
	const config = loadElizaConfig();
	const configRecord = config;
	config.plugins ??= {};
	config.plugins.entries ??= {};
	config.plugins.entries[pluginId] ??= {};
	const pluginEntry = config.plugins.entries[pluginId];
	if (typeof body.enabled === "boolean") {
		pluginEntry.enabled = body.enabled;
		if (CAPABILITY_FEATURE_IDS.has(pluginId)) {
			config.features ??= {};
			config.features[pluginId] = body.enabled;
		}
		if (plugin.category === "connector") writeCompatSectionEnabled(configRecord, "connectors", resolveCompatConfigKey(pluginId, plugin.npmName, CONNECTOR_PLUGINS$1), body.enabled);
		if (plugin.category === "streaming") writeCompatSectionEnabled(configRecord, "streaming", resolveCompatConfigKey(pluginId, plugin.npmName, STREAMING_PLUGINS), body.enabled);
	}
	if (body.config !== void 0) {
		if (!body.config || typeof body.config !== "object" || Array.isArray(body.config)) return {
			status: 400,
			payload: {
				ok: false,
				error: "Plugin config must be a JSON object."
			}
		};
		const configObject = body.config;
		const { errors, values } = validateCompatPluginConfig(plugin, configObject);
		if (errors.length > 0) return {
			status: 422,
			payload: {
				ok: false,
				plugin,
				validationErrors: errors
			}
		};
		const nextConfig = pluginEntry.config && typeof pluginEntry.config === "object" && !Array.isArray(pluginEntry.config) ? { ...pluginEntry.config } : {};
		config.env ??= {};
		for (const [key, value] of Object.entries(values)) if (value.trim()) {
			config.env[key] = value;
			nextConfig[key] = value;
		} else {
			delete config.env[key];
			delete nextConfig[key];
		}
		pluginEntry.config = nextConfig;
		if (plugin.category === "connector") syncCompatConnectorConfigValues(configRecord, pluginId, plugin.npmName, values);
		saveElizaConfig(config);
		for (const [key, value] of Object.entries(values)) try {
			if (value.trim()) process.env[key] = value;
			else delete process.env[key];
		} catch {}
	} else saveElizaConfig(config);
	return {
		status: 200,
		payload: {
			ok: true,
			plugin: buildPluginListResponse(null).plugins.find((candidate) => candidate.id === pluginId) ?? plugin
		}
	};
}
/**
* Plugin management routes.
*
* Contract note:
* - `/api/plugins` is the Settings/UI model.
* - `/api/plugins/core` is the optional-core allow-list model.
* - These can drift; use `/api/plugins/diagnostics` to inspect mismatches.
*
* - `GET  /api/plugins`             — returns filtered plugin list
* - `GET  /api/plugins/diagnostics` — returns drift diagnostics
* - `PUT  /api/plugins/:id`         — updates plugin config, writes env vars
* - `POST /api/plugins/:id/test`    — tests plugin connectivity
* - `POST /api/plugins/:id/reveal`  — reveals plugin env var value
*/
async function handlePluginsCompatRoutes(req, res, state) {
	const method = (req.method ?? "GET").toUpperCase();
	const url = new URL(req.url ?? "/", "http://localhost");
	if (!url.pathname.startsWith("/api/plugins")) return false;
	if (method === "GET" && url.pathname === "/api/plugins") {
		if (!await ensureRouteAuthorized(req, res, state)) return true;
		const pluginResponse = buildPluginListResponse(state.current);
		logger.debug(`[api/plugins] source=registry total=${pluginResponse.plugins.length} runtime=${state.current ? "active" : "null"}`);
		maybeLogPluginStateDrift(buildPluginDriftDiagnostics(state.current));
		sendJson$2(res, 200, pluginResponse);
		return true;
	}
	if (method === "GET" && url.pathname === "/api/plugins/diagnostics") {
		if (!await ensureRouteAuthorized(req, res, state)) return true;
		const diagnostics = buildPluginDriftDiagnostics(state.current);
		maybeLogPluginStateDrift(diagnostics);
		sendJson$2(res, 200, diagnostics);
		return true;
	}
	if (method === "PUT" && url.pathname.startsWith("/api/plugins/")) {
		if (!await ensureRouteAuthorized(req, res, state)) return true;
		const body = await readCompatJsonBody(req, res);
		if (body == null) return true;
		const pluginId = normalizePluginId(decodeURIComponent(url.pathname.slice(13)));
		const plugin = buildPluginListResponse(state.current).plugins.find((candidate) => candidate.id === pluginId);
		if (!plugin) {
			sendJsonError(res, 404, `Plugin "${pluginId}" not found`);
			return true;
		}
		const previousConfig = structuredClone(loadElizaConfig());
		const result = persistCompatPluginMutation(pluginId, body, plugin);
		if (result.status === 200) {
			const runtimeApply = await applyCompatRuntimeMutation({
				state,
				pluginId,
				plugin,
				body,
				previousConfig,
				nextConfig: loadElizaConfig()
			});
			if (runtimeApply.requiresRestart) scheduleCompatRuntimeRestart(state, runtimeApply.reason);
			const refreshed = buildPluginListResponse(state.current).plugins.find((candidate) => candidate.id === pluginId);
			result.payload.plugin = refreshed ?? result.payload.plugin ?? plugin;
			result.payload.applied = runtimeApply.mode;
			result.payload.requiresRestart = runtimeApply.requiresRestart;
			result.payload.restartedRuntime = runtimeApply.restartedRuntime;
			result.payload.loadedPackages = runtimeApply.loadedPackages;
			result.payload.unloadedPackages = runtimeApply.unloadedPackages;
			result.payload.reloadedPackages = runtimeApply.reloadedPackages;
			const mirrorResult = await mirrorPluginSensitiveToVault(plugin, body);
			if (mirrorResult.failures.length > 0) result.payload.vaultMirrorFailures = mirrorResult.failures;
			const diagnostics = buildPluginDriftDiagnostics(state.current);
			if (diagnostics.summary.withDrift > 0) result.payload.diagnostics = diagnostics;
		}
		sendJson$2(res, result.status, result.payload);
		return true;
	}
	const testMatch = method === "POST" && url.pathname.match(/^\/api\/plugins\/([^/]+)\/test$/);
	if (testMatch) {
		if (!await ensureRouteAuthorized(req, res, state)) return true;
		const testPluginId = normalizePluginId(decodeURIComponent(testMatch[1]));
		const startMs = Date.now();
		if (testPluginId === "telegram") {
			const token = process.env.TELEGRAM_BOT_TOKEN;
			if (!token) {
				sendJson$2(res, 422, {
					success: false,
					pluginId: testPluginId,
					error: "No bot token configured",
					durationMs: Date.now() - startMs
				});
				return true;
			}
			try {
				const apiRoot = process.env.TELEGRAM_API_ROOT || "https://api.telegram.org";
				const tgData = await (await fetch(`${apiRoot}/bot${token}/getMe`)).json();
				sendJson$2(res, tgData.ok ? 200 : 422, {
					success: tgData.ok,
					pluginId: testPluginId,
					message: tgData.ok ? `Connected as @${tgData.result?.username}` : `Telegram API error: ${tgData.description}`,
					durationMs: Date.now() - startMs
				});
			} catch (err) {
				sendJson$2(res, 422, {
					success: false,
					pluginId: testPluginId,
					error: err instanceof Error ? err.message : String(err),
					durationMs: Date.now() - startMs
				});
			}
			return true;
		}
		sendJson$2(res, 200, {
			success: true,
			pluginId: testPluginId,
			message: "Plugin is loaded (no custom test available)",
			durationMs: Date.now() - startMs
		});
		return true;
	}
	const revealMatch = method === "POST" && url.pathname.match(/^\/api\/plugins\/([^/]+)\/reveal$/);
	if (revealMatch) {
		if (!await ensureRouteAuthorized(req, res, state)) return true;
		const revealBody = await readCompatJsonBody(req, res);
		if (revealBody == null) return true;
		const key = revealBody.key?.trim();
		if (!key) {
			sendJsonError(res, 400, "Missing key parameter");
			return true;
		}
		const upperKey = key.toUpperCase();
		if (!REVEALABLE_KEY_PREFIXES.some((prefix) => upperKey.startsWith(prefix))) {
			sendJsonError(res, 403, "Key is not in the allowlist of revealable plugin config keys");
			return true;
		}
		if (SENSITIVE_KEY_PREFIXES.some((prefix) => upperKey.startsWith(prefix))) {
			if (!ensureCompatSensitiveRouteAuthorized(req, res)) return true;
		}
		try {
			sendJson$2(res, 200, {
				ok: true,
				value: await sharedVault().reveal(key, `plugins:${decodeURIComponent(revealMatch[1])}:reveal`)
			});
			return true;
		} catch (err) {
			if (!(err instanceof VaultMissError)) {
				logger.warn(`[api/plugins] Vault reveal failed for ${key}: ${err instanceof Error ? err.message : String(err)}`);
				sendJsonError(res, 500, "Vault reveal failed");
				return true;
			}
		}
		const config = loadElizaConfig();
		const fallbackValue = process.env[key] ?? config.env?.[key] ?? null;
		if (typeof fallbackValue === "string" && isVaultRef(fallbackValue)) {
			const innerKey = parseVaultRef(fallbackValue);
			if (innerKey) try {
				const inner = await sharedVault().get(innerKey);
				if (inner) {
					sendJson$2(res, 200, {
						ok: true,
						value: inner
					});
					return true;
				}
			} catch {}
			sendJson$2(res, 200, {
				ok: true,
				value: null
			});
			return true;
		}
		sendJson$2(res, 200, {
			ok: true,
			value: fallbackValue
		});
		return true;
	}
	return false;
}
var require$2, CAPABILITY_FEATURE_IDS, ADVANCED_CAPABILITY_SERVICE_BY_PLUGIN_ID, SENSITIVE_KEY_PREFIXES, REVEALABLE_KEY_PREFIXES, DRIFT_LOG_THROTTLE_MS, _lastDriftWarningAt, _lastDriftWarningFingerprint, _enabledStateReconciled;
var init_plugins_compat_routes = __esmMin((() => {
	init_dist();
	init_env_vars();
	init_plugin_auto_enable();
	init_registry$1();
	init_vault_mirror();
	init_auth$1();
	init_compat_route_shared();
	init_response();
	require$2 = createRequire(import.meta.url);
	CAPABILITY_FEATURE_IDS = new Set([
		"vision",
		"browser",
		"computeruse",
		"coding-agent"
	]);
	ADVANCED_CAPABILITY_SERVICE_BY_PLUGIN_ID = {
		experience: "EXPERIENCE",
		form: "FORM",
		personality: "CHARACTER_MANAGEMENT"
	};
	SENSITIVE_KEY_PREFIXES = [
		"SOLANA_",
		"ETHEREUM_",
		"EVM_",
		"WALLET_"
	];
	REVEALABLE_KEY_PREFIXES = [
		"OPENAI_",
		"ANTHROPIC_",
		"GOOGLE_",
		"GROQ_",
		"MISTRAL_",
		"PERPLEXITY_",
		"COHERE_",
		"TOGETHER_",
		"FIREWORKS_",
		"REPLICATE_",
		"HUGGINGFACE_",
		"ELEVENLABS_",
		"DISCORD_",
		"TELEGRAM_",
		"TWITTER_",
		"SLACK_",
		"GITHUB_",
		"REDIS_",
		"POSTGRES_",
		"DATABASE_",
		"SUPABASE_",
		"PINECONE_",
		"QDRANT_",
		"WEAVIATE_",
		"CHROMADB_",
		"AWS_",
		"AZURE_",
		"CLOUDFLARE_",
		"ELIZA_",
		"ELIZA_",
		"PLUGIN_",
		"XAI_",
		"DEEPSEEK_",
		"OLLAMA_",
		"FAL_",
		"LETZAI_",
		"GAIANET_",
		"LIVEPEER_",
		...SENSITIVE_KEY_PREFIXES
	];
	DRIFT_LOG_THROTTLE_MS = 300 * 1e3;
	_lastDriftWarningAt = 0;
	_lastDriftWarningFingerprint = "";
	_enabledStateReconciled = false;
}));

//#endregion
//#region node_modules/.bun/@elizaos+app-core@2.0.0-alpha.537+72829346cb4c43b1/node_modules/@elizaos/app-core/packages/app-core/src/api/secrets-inventory-routes.js
function isReservedKey(key) {
	return key.startsWith("_meta.") || key.startsWith("_manager.") || key === ROUTING_KEY;
}
async function handleSecretsInventoryRoute(req, res, pathname, method) {
	if (!pathname.startsWith("/api/secrets/inventory") && !pathname.startsWith("/api/secrets/routing")) return false;
	if (pathname === "/api/secrets/routing") {
		if (method === "GET") {
			sendJson$2(res, 200, {
				ok: true,
				config: await readRoutingConfig(sharedVault())
			});
			return true;
		}
		if (method === "PUT") {
			if (!ensureCompatSensitiveRouteAuthorized(req, res)) return true;
			const body = await readJsonBody(req);
			if (body === null) {
				sendJsonError(res, 400, "invalid JSON body");
				return true;
			}
			const config = body.config;
			if (!config || typeof config !== "object") {
				sendJsonError(res, 400, "missing `config` field");
				return true;
			}
			const vault = sharedVault();
			await writeRoutingConfig(vault, config);
			sendJson$2(res, 200, {
				ok: true,
				config: await readRoutingConfig(vault)
			});
			return true;
		}
		sendJsonError(res, 405, "method not allowed");
		return true;
	}
	if (pathname === "/api/secrets/inventory/migrate-to-profiles") {
		if (method !== "POST") {
			sendJsonError(res, 405, "method not allowed");
			return true;
		}
		if (!ensureCompatSensitiveRouteAuthorized(req, res)) return true;
		const body = await readJsonBody(req);
		const targetKey = typeof body?.key === "string" ? body.key : null;
		if (!targetKey || !KEY_RE.test(targetKey) || isReservedKey(targetKey)) {
			sendJsonError(res, 400, "invalid `key`");
			return true;
		}
		sendJson$2(res, 200, {
			ok: true,
			...await migrateKeyToProfiles(targetKey)
		});
		return true;
	}
	if (pathname === "/api/secrets/inventory") {
		if (method !== "GET") {
			sendJsonError(res, 405, "method not allowed");
			return true;
		}
		const categoryParam = new URL(req.url ?? "", "http://localhost").searchParams.get("category");
		if (categoryParam !== null && !CATEGORY_VALUES.has(categoryParam)) {
			sendJsonError(res, 400, "`category` must be a known VaultEntryCategory");
			return true;
		}
		const all = await listVaultInventory(sharedVault());
		sendJson$2(res, 200, {
			ok: true,
			entries: categoryParam ? all.filter((e) => e.category === categoryParam) : all
		});
		return true;
	}
	const match = /^\/api\/secrets\/inventory\/(.+)$/.exec(pathname);
	if (!match) return false;
	const tail = match[1] ?? "";
	const profileIdRe = /^([^/]+)\/profiles\/([^/]+)$/;
	const profilesRe = /^([^/]+)\/profiles$/;
	const activeProfileRe = /^([^/]+)\/active-profile$/;
	let key = null;
	let profileId = null;
	let segment = "key";
	const profileIdMatch = profileIdRe.exec(tail);
	const profilesMatch = profilesRe.exec(tail);
	const activeProfileMatch = activeProfileRe.exec(tail);
	if (profileIdMatch) {
		key = decodeURIComponent(profileIdMatch[1] ?? "");
		profileId = decodeURIComponent(profileIdMatch[2] ?? "");
		segment = "profile";
	} else if (profilesMatch) {
		key = decodeURIComponent(profilesMatch[1] ?? "");
		segment = "profiles";
	} else if (activeProfileMatch) {
		key = decodeURIComponent(activeProfileMatch[1] ?? "");
		segment = "active-profile";
	} else if (!tail.includes("/")) {
		key = decodeURIComponent(tail);
		segment = "key";
	} else return false;
	if (!key || !KEY_RE.test(key) || isReservedKey(key)) {
		sendJsonError(res, 400, "invalid `key`");
		return true;
	}
	if (profileId !== null && !PROFILE_ID_RE.test(profileId)) {
		sendJsonError(res, 400, "invalid `profileId`");
		return true;
	}
	if (segment === "key") return handleKeyRoute(req, res, method, key);
	if (segment === "profiles") return handleProfilesRoute(req, res, method, key);
	if (segment === "profile") {
		if (profileId === null) {
			sendJsonError(res, 400, "missing `profileId`");
			return true;
		}
		return handleSingleProfileRoute(req, res, method, key, profileId);
	}
	return handleActiveProfileRoute(req, res, method, key);
}
async function handleKeyRoute(req, res, method, key) {
	const vault = sharedVault();
	if (method === "GET") {
		if (!ensureCompatSensitiveRouteAuthorized(req, res)) return true;
		const meta = await readEntryMeta(vault, key);
		if (meta?.activeProfile) {
			const profileKey = profileStorageKey(key, meta.activeProfile);
			if (await vault.has(profileKey)) {
				sendJson$2(res, 200, {
					ok: true,
					value: await vault.reveal(profileKey, "inventory-routes"),
					source: "profile",
					profileId: meta.activeProfile
				});
				return true;
			}
		}
		if (!await vault.has(key)) {
			sendJsonError(res, 404, "no entry for key");
			return true;
		}
		sendJson$2(res, 200, {
			ok: true,
			value: await vault.reveal(key, "inventory-routes"),
			source: "bare"
		});
		return true;
	}
	if (method === "PUT") {
		if (!ensureCompatSensitiveRouteAuthorized(req, res)) return true;
		const body = await readJsonBody(req);
		if (body === null) {
			sendJsonError(res, 400, "invalid JSON body");
			return true;
		}
		const v = body;
		if (typeof v.value !== "string" || v.value.length === 0) {
			sendJsonError(res, 400, "`value` is required");
			return true;
		}
		if (v.label !== void 0 && typeof v.label !== "string") {
			sendJsonError(res, 400, "`label` must be string when set");
			return true;
		}
		if (v.providerId !== void 0 && typeof v.providerId !== "string") {
			sendJsonError(res, 400, "`providerId` must be string when set");
			return true;
		}
		if (v.category !== void 0 && (typeof v.category !== "string" || !CATEGORY_VALUES.has(v.category))) {
			sendJsonError(res, 400, "`category` must be a known VaultEntryCategory");
			return true;
		}
		await vault.set(key, v.value, {
			sensitive: true,
			caller: "inventory-routes"
		});
		const metaPartial = {};
		if (typeof v.label === "string") metaPartial.label = v.label;
		if (typeof v.providerId === "string") metaPartial.providerId = v.providerId;
		if (typeof v.category === "string") metaPartial.category = v.category;
		if (Object.keys(metaPartial).length > 0) await setEntryMeta(vault, key, metaPartial);
		sendJson$2(res, 200, { ok: true });
		return true;
	}
	if (method === "DELETE") {
		if (!ensureCompatSensitiveRouteAuthorized(req, res)) return true;
		if (await vault.has(key)) await vault.remove(key);
		const all = await vault.list(key);
		for (const k of all) {
			if (k === key) continue;
			if (k.startsWith(`${key}.profile.`)) await vault.remove(k);
		}
		await removeEntryMeta(vault, key);
		sendJson$2(res, 200, { ok: true });
		return true;
	}
	sendJsonError(res, 405, "method not allowed");
	return true;
}
async function handleProfilesRoute(req, res, method, key) {
	const vault = sharedVault();
	if (method === "GET") {
		const meta = await readEntryMeta(vault, key);
		sendJson$2(res, 200, {
			ok: true,
			profiles: meta?.profiles ?? [],
			activeProfile: meta?.activeProfile ?? null
		});
		return true;
	}
	if (method === "POST") {
		if (!ensureCompatSensitiveRouteAuthorized(req, res)) return true;
		const body = await readJsonBody(req);
		if (body === null) {
			sendJsonError(res, 400, "invalid JSON body");
			return true;
		}
		const v = body;
		if (typeof v.id !== "string" || !PROFILE_ID_RE.test(v.id)) {
			sendJsonError(res, 400, "`id` must match [A-Za-z0-9_-]+");
			return true;
		}
		if (typeof v.value !== "string" || v.value.length === 0) {
			sendJsonError(res, 400, "`value` is required");
			return true;
		}
		const label = typeof v.label === "string" && v.label.length > 0 ? v.label : v.id;
		const meta = await readEntryMeta(vault, key);
		const profiles = (meta?.profiles ?? []).slice();
		if (profiles.some((p) => p.id === v.id)) {
			sendJsonError(res, 409, "profile id already exists");
			return true;
		}
		profiles.push({
			id: v.id,
			label,
			createdAt: Date.now()
		});
		await vault.set(profileStorageKey(key, v.id), v.value, {
			sensitive: true,
			caller: "inventory-routes"
		});
		await setEntryMeta(vault, key, {
			profiles,
			...meta?.activeProfile ? {} : { activeProfile: v.id }
		});
		sendJson$2(res, 200, { ok: true });
		return true;
	}
	sendJsonError(res, 405, "method not allowed");
	return true;
}
async function handleSingleProfileRoute(req, res, method, key, profileId) {
	const vault = sharedVault();
	if (method === "PATCH") {
		if (!ensureCompatSensitiveRouteAuthorized(req, res)) return true;
		const body = await readJsonBody(req);
		if (body === null) {
			sendJsonError(res, 400, "invalid JSON body");
			return true;
		}
		const v = body;
		if (v.label !== void 0 && typeof v.label !== "string") {
			sendJsonError(res, 400, "`label` must be string when set");
			return true;
		}
		if (v.value !== void 0 && (typeof v.value !== "string" || v.value.length === 0)) {
			sendJsonError(res, 400, "`value` must be a non-empty string when set");
			return true;
		}
		const profiles = ((await readEntryMeta(vault, key))?.profiles ?? []).slice();
		const idx = profiles.findIndex((p) => p.id === profileId);
		if (idx < 0) {
			sendJsonError(res, 404, "no such profile");
			return true;
		}
		if (typeof v.value === "string") await vault.set(profileStorageKey(key, profileId), v.value, {
			sensitive: true,
			caller: "inventory-routes"
		});
		if (typeof v.label === "string") {
			const existing = profiles[idx];
			if (!existing) {
				sendJsonError(res, 404, "no such profile");
				return true;
			}
			profiles[idx] = {
				...existing,
				label: v.label
			};
			await setEntryMeta(vault, key, { profiles });
		}
		sendJson$2(res, 200, { ok: true });
		return true;
	}
	if (method === "DELETE") {
		if (!ensureCompatSensitiveRouteAuthorized(req, res)) return true;
		const meta = await readEntryMeta(vault, key);
		const profiles = (meta?.profiles ?? []).slice();
		const idx = profiles.findIndex((p) => p.id === profileId);
		if (idx < 0) {
			sendJsonError(res, 404, "no such profile");
			return true;
		}
		profiles.splice(idx, 1);
		const profileKey = profileStorageKey(key, profileId);
		if (await vault.has(profileKey)) await vault.remove(profileKey);
		const activeProfile = meta?.activeProfile === profileId ? profiles[0]?.id ?? null : meta?.activeProfile ?? null;
		await setEntryMeta(vault, key, {
			profiles: profiles.length > 0 ? profiles : null,
			activeProfile: activeProfile === null ? null : activeProfile
		});
		sendJson$2(res, 200, { ok: true });
		return true;
	}
	sendJsonError(res, 405, "method not allowed");
	return true;
}
async function handleActiveProfileRoute(req, res, method, key) {
	if (method !== "PUT") {
		sendJsonError(res, 405, "method not allowed");
		return true;
	}
	if (!ensureCompatSensitiveRouteAuthorized(req, res)) return true;
	const body = await readJsonBody(req);
	if (body === null) {
		sendJsonError(res, 400, "invalid JSON body");
		return true;
	}
	const v = body;
	if (typeof v.profileId !== "string" || !PROFILE_ID_RE.test(v.profileId)) {
		sendJsonError(res, 400, "`profileId` is required");
		return true;
	}
	const vault = sharedVault();
	if (!((await readEntryMeta(vault, key))?.profiles ?? []).some((p) => p.id === v.profileId)) {
		sendJsonError(res, 404, "profile id not found for key");
		return true;
	}
	await setEntryMeta(vault, key, { activeProfile: v.profileId });
	sendJson$2(res, 200, { ok: true });
	return true;
}
async function migrateKeyToProfiles(key) {
	const vault = sharedVault();
	if ((await readEntryMeta(vault, key))?.profiles?.length) return {
		migrated: false,
		reason: "already-has-profiles"
	};
	if (!await vault.has(key)) return {
		migrated: false,
		reason: "key-not-found"
	};
	const value = await vault.reveal(key, "inventory-migrate");
	await vault.set(profileStorageKey(key, "default"), value, {
		sensitive: true,
		caller: "inventory-migrate"
	});
	await setEntryMeta(vault, key, {
		profiles: [{
			id: "default",
			label: "Default",
			createdAt: Date.now()
		}],
		activeProfile: "default"
	});
	return {
		migrated: true,
		profileId: "default"
	};
}
async function readJsonBody(req) {
	let body = "";
	for await (const chunk of req) body += chunk;
	if (!body) return {};
	try {
		return JSON.parse(body);
	} catch {
		return null;
	}
}
var KEY_RE, PROFILE_ID_RE, CATEGORY_VALUES;
var init_secrets_inventory_routes = __esmMin((() => {
	init_dist();
	init_vault_mirror();
	init_auth$1();
	init_response();
	KEY_RE = /^[A-Za-z0-9_.-]+$/;
	PROFILE_ID_RE = /^[A-Za-z0-9_-]+$/;
	CATEGORY_VALUES = new Set([
		"provider",
		"plugin",
		"wallet",
		"credential",
		"system",
		"session"
	]);
}));

//#endregion
//#region node_modules/.bun/@elizaos+app-core@2.0.0-alpha.537+72829346cb4c43b1/node_modules/@elizaos/app-core/packages/app-core/src/services/secrets-manager-installer.js
/**
* Secrets-manager installer + signin orchestration.
*
* Drives the lifecycle the UI cares about for the three external secrets-manager
* backends (1Password, Bitwarden, Proton Pass):
*
*   1. **Install**       — spawn the chosen package manager (brew or npm) with
*                          a clean argv. Streams stdout/stderr lines back to
*                          subscribers, emits a final `done` / `error` event
*                          when the child exits.
*   2. **Sign in**       — runs the vendor's non-interactive signin flow with
*                          credentials supplied once via the API. Captures the
*                          session token from stdout and persists it in the
*                          in-house vault as `pm.<backend>.session`.
*   3. **Sign out**      — clears the persisted session token.
*
* Master passwords / API secrets enter the process exactly once per request
* via `child.stdin`; they are never written to disk. The session tokens that
* come back are integration metadata (not user secrets), but we still mark
* them `sensitive: true` so they're encrypted at rest under the OS keychain.
*
* Singleton: one installer per process, owns a Map<jobId, InstallJob>. The
* stream of events is also persisted in-memory on the job so a UI that
* subscribes after spawn (race) can replay history.
*/
function sessionKey(backendId) {
	return `${SESSION_KEY_PREFIX}.${backendId}.session`;
}
/**
* Run a child process with optional stdin, capture stdout/stderr, return
* when it exits. Hard timeout via SIGKILL; never leaves a dangling child.
*/
function spawnCapture(spawnFn, command, args, stdin, env, timeoutMs = DEFAULT_SIGNIN_TIMEOUT_MS) {
	return new Promise((resolve, reject) => {
		const child = spawnFn(command, args, {
			stdio: [
				stdin === null ? "ignore" : "pipe",
				"pipe",
				"pipe"
			],
			shell: false,
			env: env ?? process.env
		});
		let stdout = "";
		let stderr = "";
		child.stdout?.on("data", (chunk) => {
			stdout += chunk.toString("utf8");
		});
		child.stderr?.on("data", (chunk) => {
			stderr += chunk.toString("utf8");
		});
		const timer = setTimeout(() => {
			child.kill("SIGKILL");
			reject(/* @__PURE__ */ new Error(`${command} timed out after ${timeoutMs}ms`));
		}, timeoutMs);
		timer.unref?.();
		child.once("error", (err) => {
			clearTimeout(timer);
			reject(err);
		});
		child.once("close", (code) => {
			clearTimeout(timer);
			resolve({
				exitCode: code ?? 1,
				stdout,
				stderr
			});
		});
		if (stdin !== null && child.stdin) child.stdin.end(stdin);
	});
}
function pipeLines(stream, onLine) {
	if (!stream) return;
	let buf = "";
	stream.setEncoding("utf8");
	stream.on("data", (chunk) => {
		buf += chunk;
		let newlineIdx = buf.indexOf("\n");
		while (newlineIdx >= 0) {
			const line = buf.slice(0, newlineIdx).replace(/\r$/, "");
			buf = buf.slice(newlineIdx + 1);
			onLine(line);
			newlineIdx = buf.indexOf("\n");
		}
	});
	stream.on("end", () => {
		if (buf.length > 0) {
			onLine(buf);
			buf = "";
		}
	});
}
function snapshotOf(job) {
	return {
		id: job.id,
		backendId: job.backendId,
		method: job.method,
		status: job.status,
		startedAt: job.startedAt,
		endedAt: job.endedAt,
		exitCode: job.exitCode,
		errorMessage: job.errorMessage,
		history: [...job.history]
	};
}
function truncateError(message, max = 800) {
	const clean = message.replace(/\s+/g, " ").trim();
	return clean.length > max ? `${clean.slice(0, max)}…` : clean;
}
function getSecretsManagerInstaller(manager) {
	if (!_installer) _installer = new SecretsManagerInstaller({ manager: manager ?? createManager() });
	return _installer;
}
var SESSION_KEY_PREFIX, MAX_LINE_LENGTH, MAX_HISTORY_EVENTS, DEFAULT_SIGNIN_TIMEOUT_MS, SecretsManagerInstaller, _installer;
var init_secrets_manager_installer = __esmMin((() => {
	init_dist();
	SESSION_KEY_PREFIX = "pm";
	MAX_LINE_LENGTH = 2e3;
	MAX_HISTORY_EVENTS = 500;
	DEFAULT_SIGNIN_TIMEOUT_MS = 6e4;
	SecretsManagerInstaller = class {
		jobs = /* @__PURE__ */ new Map();
		manager;
		spawn;
		constructor(deps) {
			this.manager = deps.manager;
			this.spawn = deps.spawn ?? spawn;
		}
		/** Snapshot of the install methods runnable on this host for a backend. */
		async getInstallMethods(id) {
			return resolveRunnableMethods(id);
		}
		/**
		* Spawn the install command for `method` on backend `id`. Returns a job id
		* the UI can subscribe to. The caller is expected to call `subscribeJob`
		* (or read `getJob` to poll) before the child finishes; events that fire
		* before the first subscriber are kept on `job.history` so SSE clients
		* that connect after spawn still see the full log.
		*/
		startInstall(id, method) {
			if (method.kind === "manual") throw new TypeError(`Cannot automate install for "${id}": method is manual. Direct the user to ${method.url}`);
			const built = buildInstallCommand(method);
			if (!built) throw new Error(`buildInstallCommand returned null for non-manual method (${method.kind})`);
			const job = {
				id: randomUUID(),
				backendId: id,
				method,
				status: "pending",
				startedAt: Date.now(),
				endedAt: null,
				exitCode: null,
				errorMessage: null,
				history: [],
				emitter: new EventEmitter(),
				child: null
			};
			this.jobs.set(job.id, job);
			setImmediate(() => this.runInstallJob(job, built.command, built.args));
			return snapshotOf(job);
		}
		/** Subscribe to events for a running job. Returns an unsubscribe function. */
		subscribeJob(jobId, listener) {
			const job = this.jobs.get(jobId);
			if (!job) throw new Error(`unknown install job: ${jobId}`);
			for (const event of job.history) listener(event);
			if (job.status !== "running" && job.status !== "pending") return () => void 0;
			job.emitter.on("event", listener);
			return () => job.emitter.off("event", listener);
		}
		getJob(jobId) {
			const job = this.jobs.get(jobId);
			return job ? snapshotOf(job) : null;
		}
		/**
		* Run the vendor's non-interactive signin flow and persist the session token.
		* Throws on validation or CLI failure with a message safe to surface to UI.
		*/
		async signIn(request) {
			if (request.backendId === "1password") return this.signInOnePassword(request);
			if (request.backendId === "bitwarden") return this.signInBitwarden(request);
			throw new Error(`Sign-in for "${request.backendId}" is not implemented. Vendor CLI is unstable.`);
		}
		async signOut(backendId) {
			if (await this.manager.has(sessionKey(backendId))) await this.manager.remove(sessionKey(backendId));
		}
		/** Read the cached session token (or null if not signed in). */
		async getSession(backendId) {
			if (!await this.manager.has(sessionKey(backendId))) return null;
			return this.manager.get(sessionKey(backendId));
		}
		runInstallJob(job, command, args) {
			this.transition(job, "running");
			const child = this.spawn(command, args, {
				stdio: [
					"ignore",
					"pipe",
					"pipe"
				],
				shell: false
			});
			job.child = child;
			const onLine = (stream, line) => {
				this.emit(job, {
					type: "log",
					stream,
					line: line.length > MAX_LINE_LENGTH ? line.slice(0, MAX_LINE_LENGTH) : line
				});
			};
			pipeLines(child.stdout, (line) => onLine("stdout", line));
			pipeLines(child.stderr, (line) => onLine("stderr", line));
			child.on("error", (err) => {
				const message = err instanceof Error ? err.message : `unknown spawn error: ${String(err)}`;
				job.errorMessage = message;
				this.emit(job, {
					type: "error",
					message
				});
				this.terminate(job, "failed", null);
			});
			child.on("close", (code) => {
				const exitCode = code ?? 1;
				job.exitCode = exitCode;
				if (exitCode === 0) {
					this.emit(job, {
						type: "done",
						exitCode
					});
					this.terminate(job, "succeeded", exitCode);
				} else {
					const message = `install exited with code ${exitCode}`;
					job.errorMessage = message;
					this.emit(job, {
						type: "error",
						message
					});
					this.terminate(job, "failed", exitCode);
				}
			});
		}
		emit(job, event) {
			job.history.push(event);
			if (job.history.length > MAX_HISTORY_EVENTS) job.history = job.history.slice(-MAX_HISTORY_EVENTS / 2);
			job.emitter.emit("event", event);
		}
		transition(job, next) {
			job.status = next;
			this.emit(job, {
				type: "status",
				status: next
			});
		}
		terminate(job, final, exitCode) {
			job.endedAt = Date.now();
			job.exitCode = exitCode;
			this.transition(job, final);
			job.emitter.removeAllListeners();
			job.child = null;
		}
		/**
		* Adds a 1Password account (idempotent — if the account already exists `op`
		* succeeds without re-prompting), then performs `op signin --raw` piping
		* the master password on stdin. Captures the session token returned on
		* stdout and persists it under `pm.1password.session`.
		*/
		async signInOnePassword(request) {
			if (!request.email) throw new Error("1Password sign-in requires `email`");
			if (!request.secretKey) throw new Error("1Password sign-in requires `secretKey` (the 34-char Secret Key)");
			if (!request.masterPassword) throw new Error("1Password sign-in requires `masterPassword`");
			const signInAddress = request.signInAddress?.trim() || "my.1password.com";
			const addArgs = [
				"account",
				"add",
				"--address",
				signInAddress,
				"--email",
				request.email,
				"--secret-key",
				request.secretKey,
				"--signin",
				"--raw"
			];
			const add = await spawnCapture(this.spawn, "op", addArgs, request.masterPassword);
			let sessionToken = add.stdout.trim();
			if (!sessionToken) {
				const signin = await spawnCapture(this.spawn, "op", [
					"signin",
					"--account",
					signInAddress,
					"--raw"
				], request.masterPassword);
				if (signin.exitCode !== 0 || !signin.stdout.trim()) throw new Error(truncateError(`op signin failed (exit ${signin.exitCode}): ${signin.stderr || signin.stdout}`));
				sessionToken = signin.stdout.trim();
			}
			if (add.exitCode !== 0 && !sessionToken) throw new Error(truncateError(`op account add failed (exit ${add.exitCode}): ${add.stderr || add.stdout}`));
			await this.manager.vault.set(sessionKey("1password"), sessionToken, {
				sensitive: true,
				caller: "secrets-manager-installer"
			});
			return {
				backendId: "1password",
				sessionStored: true,
				message: `Signed in as ${request.email} at ${signInAddress}`
			};
		}
		/**
		* Bitwarden non-interactive flow:
		*   1. `bw login --apikey` with BW_CLIENTID / BW_CLIENTSECRET in env
		*   2. `bw unlock --raw` piping the master password on stdin
		* Captures the session token from `bw unlock --raw` and persists it.
		*/
		async signInBitwarden(request) {
			if (!request.bitwardenClientId) throw new Error("Bitwarden sign-in requires `bitwardenClientId` (BW_CLIENTID)");
			if (!request.bitwardenClientSecret) throw new Error("Bitwarden sign-in requires `bitwardenClientSecret` (BW_CLIENTSECRET)");
			if (!request.masterPassword) throw new Error("Bitwarden sign-in requires `masterPassword`");
			const env = {
				...process.env,
				BW_CLIENTID: request.bitwardenClientId,
				BW_CLIENTSECRET: request.bitwardenClientSecret
			};
			const login = await spawnCapture(this.spawn, "bw", ["login", "--apikey"], null, env);
			const alreadyLoggedIn = login.exitCode !== 0 && /already logged in/i.test(login.stderr + login.stdout);
			if (login.exitCode !== 0 && !alreadyLoggedIn) throw new Error(truncateError(`bw login failed (exit ${login.exitCode}): ${login.stderr || login.stdout}`));
			const unlock = await spawnCapture(this.spawn, "bw", [
				"unlock",
				"--raw",
				"--passwordenv",
				"BW_PASSWORD"
			], null, {
				...env,
				BW_PASSWORD: request.masterPassword
			});
			const sessionToken = unlock.stdout.trim();
			if (unlock.exitCode !== 0 || !sessionToken) throw new Error(truncateError(`bw unlock failed (exit ${unlock.exitCode}): ${unlock.stderr || unlock.stdout}`));
			await this.manager.vault.set(sessionKey("bitwarden"), sessionToken, {
				sensitive: true,
				caller: "secrets-manager-installer"
			});
			return {
				backendId: "bitwarden",
				sessionStored: true,
				message: alreadyLoggedIn ? "Already logged in; vault unlocked" : "Signed in via API key; vault unlocked"
			};
		}
	};
	_installer = null;
}));

//#endregion
//#region node_modules/.bun/@elizaos+app-core@2.0.0-alpha.537+72829346cb4c43b1/node_modules/@elizaos/app-core/packages/app-core/src/api/secrets-manager-routes.js
function getManager() {
	if (!_manager) _manager = createManager({ vault: sharedVault() });
	return _manager;
}
function getInstaller() {
	return getSecretsManagerInstaller(getManager());
}
function isInstallableBackend(value) {
	return typeof value === "string" && INSTALLABLE_BACKENDS.includes(value);
}
async function handleSecretsManagerRoute(req, res, pathname, method) {
	if (!pathname.startsWith("/api/secrets/manager") && !pathname.startsWith("/api/secrets/logins")) return false;
	const manager = getManager();
	if (pathname.startsWith("/api/secrets/logins")) return handleSavedLoginsRoute(req, res, pathname, method, manager);
	if (method === "GET" && pathname === "/api/secrets/manager/backends") {
		sendJson$2(res, 200, {
			ok: true,
			backends: await manager.detectBackends()
		});
		return true;
	}
	if (method === "GET" && pathname === "/api/secrets/manager/preferences") {
		sendJson$2(res, 200, {
			ok: true,
			preferences: await manager.getPreferences()
		});
		return true;
	}
	if (method === "PUT" && pathname === "/api/secrets/manager/preferences") {
		let body = "";
		for await (const chunk of req) body += chunk;
		let parsed;
		try {
			parsed = JSON.parse(body || "{}");
		} catch {
			sendJsonError(res, 400, "invalid JSON body");
			return true;
		}
		const prefs = parsed.preferences;
		if (!prefs || typeof prefs !== "object") {
			sendJsonError(res, 400, "missing `preferences` field");
			return true;
		}
		await manager.setPreferences(prefs);
		sendJson$2(res, 200, {
			ok: true,
			preferences: await manager.getPreferences()
		});
		return true;
	}
	if (method === "GET" && pathname === "/api/secrets/manager/install/methods") {
		const out = {
			"1password": [],
			bitwarden: [],
			protonpass: []
		};
		for (const id of INSTALLABLE_BACKENDS) out[id] = await resolveRunnableMethods(id);
		sendJson$2(res, 200, {
			ok: true,
			methods: out
		});
		return true;
	}
	if (method === "POST" && pathname === "/api/secrets/manager/install") {
		let body = "";
		for await (const chunk of req) body += chunk;
		let parsed;
		try {
			parsed = JSON.parse(body || "{}");
		} catch {
			sendJsonError(res, 400, "invalid JSON body");
			return true;
		}
		const { backendId, method: rawMethod } = parsed;
		if (!isInstallableBackend(backendId)) {
			sendJsonError(res, 400, `invalid \`backendId\`; expected one of ${INSTALLABLE_BACKENDS.join(", ")}`);
			return true;
		}
		if (!isInstallMethodPayload(rawMethod)) {
			sendJsonError(res, 400, "invalid `method` payload");
			return true;
		}
		if (rawMethod.kind === "manual") {
			sendJsonError(res, 400, "manual install methods cannot be automated; open the docs URL instead");
			return true;
		}
		const matched = (await resolveRunnableMethods(backendId)).find((m) => methodMatches(m, rawMethod));
		if (!matched) {
			sendJsonError(res, 400, `install method ${rawMethod.kind}:${rawMethod.package ?? ""} is not available on this host`);
			return true;
		}
		sendJson$2(res, 202, {
			ok: true,
			jobId: getInstaller().startInstall(backendId, matched).id
		});
		return true;
	}
	const sseMatch = pathname.match(/^\/api\/secrets\/manager\/install\/([0-9a-f-]{36})$/);
	if (method === "GET" && sseMatch) {
		const jobId = sseMatch[1];
		if (!jobId) {
			sendJsonError(res, 400, "missing job id");
			return true;
		}
		const installer = getInstaller();
		if (!installer.getJob(jobId)) {
			sendJsonError(res, 404, "unknown job id");
			return true;
		}
		res.writeHead(200, {
			"Content-Type": "text/event-stream",
			"Cache-Control": "no-cache, no-transform",
			Connection: "keep-alive",
			"X-Accel-Buffering": "no"
		});
		const heartbeat = setInterval(() => {
			res.write(": heartbeat\n\n");
		}, 15e3);
		if (typeof heartbeat === "object" && "unref" in heartbeat) heartbeat.unref();
		const writeEvent = (event) => {
			if (res.writableEnded) return;
			res.write(`data: ${JSON.stringify(event)}\n\n`);
			if (event.type === "done" || event.type === "error") {
				clearInterval(heartbeat);
				res.end();
			}
		};
		const unsubscribe = installer.subscribeJob(jobId, writeEvent);
		const cleanup = () => {
			clearInterval(heartbeat);
			unsubscribe();
		};
		req.on("close", cleanup);
		req.on("aborted", cleanup);
		return true;
	}
	if (method === "POST" && pathname === "/api/secrets/manager/signin") {
		let body = "";
		for await (const chunk of req) body += chunk;
		let parsed;
		try {
			parsed = JSON.parse(body || "{}");
		} catch {
			sendJsonError(res, 400, "invalid JSON body");
			return true;
		}
		const request = parsed;
		if (!isInstallableBackend(request.backendId)) {
			sendJsonError(res, 400, "invalid `backendId`");
			return true;
		}
		if (typeof request.masterPassword !== "string" || !request.masterPassword) {
			sendJsonError(res, 400, "missing `masterPassword`");
			return true;
		}
		const installer = getInstaller();
		try {
			sendJson$2(res, 200, {
				ok: true,
				result: await installer.signIn({
					backendId: request.backendId,
					masterPassword: request.masterPassword,
					...request.email ? { email: request.email } : {},
					...request.secretKey ? { secretKey: request.secretKey } : {},
					...request.signInAddress ? { signInAddress: request.signInAddress } : {},
					...request.bitwardenClientId ? { bitwardenClientId: request.bitwardenClientId } : {},
					...request.bitwardenClientSecret ? { bitwardenClientSecret: request.bitwardenClientSecret } : {}
				})
			});
		} catch (err) {
			sendJsonError(res, 400, err instanceof Error ? err.message : "sign-in failed");
		}
		return true;
	}
	if (method === "POST" && pathname === "/api/secrets/manager/signout") {
		let body = "";
		for await (const chunk of req) body += chunk;
		let parsed;
		try {
			parsed = JSON.parse(body || "{}");
		} catch {
			sendJsonError(res, 400, "invalid JSON body");
			return true;
		}
		const id = parsed.backendId;
		if (!isInstallableBackend(id)) {
			sendJsonError(res, 400, "invalid `backendId`");
			return true;
		}
		await getInstaller().signOut(id);
		sendJson$2(res, 200, { ok: true });
		return true;
	}
	return false;
}
function isUnifiedSource(v) {
	return v === "in-house" || v === "1password" || v === "bitwarden";
}
async function handleSavedLoginsRoute(req, res, pathname, method, manager) {
	const vault = sharedVault();
	if (method === "GET" && pathname === "/api/secrets/logins") {
		const domain = new URL(req.url ?? "", "http://localhost").searchParams.get("domain") ?? void 0;
		const result = await manager.listAllSavedLogins(domain ? { domain } : {});
		sendJson$2(res, 200, {
			ok: true,
			logins: result.logins,
			failures: result.failures
		});
		return true;
	}
	if (method === "GET" && pathname === "/api/secrets/logins/reveal") {
		const url = new URL(req.url ?? "", "http://localhost");
		const source = url.searchParams.get("source");
		const identifier = url.searchParams.get("identifier");
		if (!isUnifiedSource(source)) {
			sendJsonError(res, 400, "`source` must be one of: in-house, 1password, bitwarden");
			return true;
		}
		if (!identifier) {
			sendJsonError(res, 400, "`identifier` is required");
			return true;
		}
		try {
			sendJson$2(res, 200, {
				ok: true,
				login: await manager.revealSavedLogin(source, identifier)
			});
		} catch (err) {
			sendJsonError(res, 404, err instanceof Error ? err.message : "reveal failed");
		}
		return true;
	}
	if (method === "POST" && pathname === "/api/secrets/logins") {
		let body = "";
		for await (const chunk of req) body += chunk;
		let parsed;
		try {
			parsed = JSON.parse(body || "{}");
		} catch {
			sendJsonError(res, 400, "invalid JSON body");
			return true;
		}
		const p = parsed;
		if (typeof p.domain !== "string" || p.domain.trim().length === 0) {
			sendJsonError(res, 400, "`domain` is required");
			return true;
		}
		if (typeof p.username !== "string" || p.username.length === 0) {
			sendJsonError(res, 400, "`username` is required");
			return true;
		}
		if (typeof p.password !== "string" || p.password.length === 0) {
			sendJsonError(res, 400, "`password` is required");
			return true;
		}
		if (p.otpSeed !== void 0 && typeof p.otpSeed !== "string") {
			sendJsonError(res, 400, "`otpSeed` must be a string when provided");
			return true;
		}
		if (p.notes !== void 0 && typeof p.notes !== "string") {
			sendJsonError(res, 400, "`notes` must be a string when provided");
			return true;
		}
		await setSavedLogin(vault, {
			domain: p.domain,
			username: p.username,
			password: p.password,
			...typeof p.otpSeed === "string" ? { otpSeed: p.otpSeed } : {},
			...typeof p.notes === "string" ? { notes: p.notes } : {}
		});
		sendJson$2(res, 200, { ok: true });
		return true;
	}
	const autoallowMatch = pathname.match(LOGIN_AUTOALLOW_RE);
	if (autoallowMatch) {
		const rawDomain = autoallowMatch[1];
		if (!rawDomain) {
			sendJsonError(res, 400, "missing domain");
			return true;
		}
		const domain = decodeURIComponent(rawDomain);
		if (method === "GET") {
			sendJson$2(res, 200, {
				ok: true,
				allowed: await getAutofillAllowed(vault, domain)
			});
			return true;
		}
		if (method === "PUT") {
			let body = "";
			for await (const chunk of req) body += chunk;
			let parsed;
			try {
				parsed = JSON.parse(body || "{}");
			} catch {
				sendJsonError(res, 400, "invalid JSON body");
				return true;
			}
			const allowed = parsed.allowed;
			if (typeof allowed !== "boolean") {
				sendJsonError(res, 400, "`allowed` must be boolean");
				return true;
			}
			await setAutofillAllowed(vault, domain, allowed);
			sendJson$2(res, 200, {
				ok: true,
				allowed
			});
			return true;
		}
	}
	const match = pathname.match(LOGIN_PATH_RE);
	if (match) {
		const rawDomain = match[1];
		const rawUser = match[2];
		if (!rawDomain || !rawUser) {
			sendJsonError(res, 400, "missing path segment");
			return true;
		}
		const domain = decodeURIComponent(rawDomain);
		const username = decodeURIComponent(rawUser);
		if (method === "GET") {
			const login = await getSavedLogin(vault, domain, username);
			if (!login) {
				sendJsonError(res, 404, "no saved login for domain/username");
				return true;
			}
			sendJson$2(res, 200, {
				ok: true,
				login
			});
			return true;
		}
		if (method === "DELETE") {
			await deleteSavedLogin(vault, domain, username);
			sendJson$2(res, 200, { ok: true });
			return true;
		}
	}
	return false;
}
function isInstallMethodPayload(value) {
	if (!value || typeof value !== "object") return false;
	const v = value;
	if (v.kind === "brew") {
		const m = value;
		return typeof m.package === "string" && typeof m.cask === "boolean";
	}
	if (v.kind === "npm") return typeof value.package === "string";
	if (v.kind === "manual") {
		const m = value;
		return typeof m.url === "string" && typeof m.instructions === "string";
	}
	return false;
}
function methodMatches(a, b) {
	if (a.kind !== b.kind) return false;
	if (a.kind === "brew" && b.kind === "brew") return a.package === b.package && a.cask === b.cask;
	if (a.kind === "npm" && b.kind === "npm") return a.package === b.package;
	if (a.kind === "manual" && b.kind === "manual") return a.url === b.url;
	return false;
}
var _manager, INSTALLABLE_BACKENDS, LOGIN_PATH_RE, LOGIN_AUTOALLOW_RE;
var init_secrets_manager_routes = __esmMin((() => {
	init_dist();
	init_secrets_manager_installer();
	init_vault_mirror();
	init_response();
	_manager = null;
	INSTALLABLE_BACKENDS = [
		"1password",
		"bitwarden",
		"protonpass"
	];
	LOGIN_PATH_RE = /^\/api\/secrets\/logins\/([^/]+)\/([^/]+)$/;
	LOGIN_AUTOALLOW_RE = /^\/api\/secrets\/logins\/([^/]+)\/autoallow$/;
}));

//#endregion
//#region node_modules/.bun/@elizaos+app-core@2.0.0-alpha.537+72829346cb4c43b1/node_modules/@elizaos/app-core/packages/app-core/src/api/wallet-market-overview-route.js
function marketOverviewErrorMessage(error) {
	return error instanceof Error && error.message.trim().length > 0 ? error.message.trim() : "Upstream market feed failed";
}
function buildMarketOverviewSource(source, { available, stale, error }) {
	return {
		...source,
		available,
		stale,
		error
	};
}
function markMarketOverviewSourcesStale(sources) {
	return {
		prices: {
			...sources.prices,
			stale: true
		},
		movers: {
			...sources.movers,
			stale: true
		},
		predictions: {
			...sources.predictions,
			stale: true
		}
	};
}
function asRecord$1(value) {
	return value && typeof value === "object" && !Array.isArray(value) ? value : null;
}
function numberFromUnknown(value) {
	if (typeof value === "number" && Number.isFinite(value)) return value;
	if (typeof value !== "string" || value.trim().length === 0) return null;
	const parsed = Number.parseFloat(value);
	return Number.isFinite(parsed) ? parsed : null;
}
function integerFromUnknown(value) {
	const parsed = numberFromUnknown(value);
	if (parsed === null) return null;
	return Number.isInteger(parsed) ? parsed : Math.round(parsed);
}
function stringFromUnknown(value) {
	return typeof value === "string" && value.trim().length > 0 ? value : null;
}
function parseStringArray(value) {
	if (Array.isArray(value)) return value.filter((item) => typeof item === "string");
	if (typeof value !== "string" || value.trim().length === 0) return [];
	try {
		const parsed = JSON.parse(value);
		return Array.isArray(parsed) ? parsed.filter((item) => typeof item === "string") : [];
	} catch {
		return [];
	}
}
function clampProbability(value) {
	if (value === null || !Number.isFinite(value)) return null;
	return Math.min(1, Math.max(0, value));
}
function isStableAsset(market) {
	const id = market.id.toLowerCase();
	const symbol = market.symbol.toLowerCase();
	return STABLE_ASSET_IDS.has(id) || STABLE_ASSET_SYMBOLS.has(symbol);
}
function mapCoinGeckoMarket(input) {
	const record = asRecord$1(input);
	if (!record) return null;
	const id = stringFromUnknown(record.id);
	const symbol = stringFromUnknown(record.symbol);
	const name = stringFromUnknown(record.name);
	const currentPriceUsd = numberFromUnknown(record.current_price);
	const change24hPct = numberFromUnknown(record.price_change_percentage_24h);
	if (!id || !symbol || !name || currentPriceUsd === null || change24hPct === null) return null;
	return {
		id,
		symbol: symbol.toUpperCase(),
		name,
		currentPriceUsd,
		change24hPct,
		marketCapRank: integerFromUnknown(record.market_cap_rank),
		imageUrl: stringFromUnknown(record.image)
	};
}
function mapPolymarketMarket(input) {
	const record = asRecord$1(input);
	if (!record) return null;
	const question = stringFromUnknown(record.question);
	if (!question) return null;
	const outcomeLabels = parseStringArray(record.outcomes);
	const outcomeProbabilities = parseStringArray(record.outcomePrices).map((value) => clampProbability(numberFromUnknown(value))).filter((value) => value !== null);
	const volume24hUsd = numberFromUnknown(record.volume24hr);
	if (volume24hUsd === null) return null;
	return {
		slug: stringFromUnknown(record.slug),
		question,
		outcomeLabels,
		outcomeProbabilities,
		volume24hUsd,
		totalVolumeUsd: numberFromUnknown(record.volume),
		endsAt: stringFromUnknown(record.endDate),
		imageUrl: stringFromUnknown(record.image) ?? stringFromUnknown(record.icon)
	};
}
function highlightedPredictionOutcome(market) {
	const yesIndex = market.outcomeLabels.findIndex((label) => label.trim().toLowerCase() === "yes");
	if (yesIndex >= 0) return {
		label: market.outcomeLabels[yesIndex] ?? "Yes",
		probability: market.outcomeProbabilities[yesIndex] ?? null
	};
	let highestIndex = -1;
	let highestProbability = -1;
	for (const [index, probability] of market.outcomeProbabilities.entries()) if (probability > highestProbability) {
		highestIndex = index;
		highestProbability = probability;
	}
	if (highestIndex >= 0) return {
		label: market.outcomeLabels[highestIndex] ?? "Top",
		probability: market.outcomeProbabilities[highestIndex] ?? null
	};
	return {
		label: "Top",
		probability: null
	};
}
async function fetchCoinGeckoMarkets() {
	const url = new URL("https://api.coingecko.com/api/v3/coins/markets");
	url.searchParams.set("vs_currency", "usd");
	url.searchParams.set("order", "market_cap_desc");
	url.searchParams.set("per_page", String(COINGECKO_MARKET_LIMIT));
	url.searchParams.set("page", "1");
	url.searchParams.set("price_change_percentage", "24h");
	const response = await walletMarketOverviewFetch(url, {
		method: "GET",
		headers: {
			accept: "application/json",
			"user-agent": "Eliza Wallet Market Feed/1.0"
		}
	}, MARKET_OVERVIEW_FETCH_TIMEOUT_MS);
	if (!response.ok) throw new Error(`CoinGecko responded ${response.status}`);
	const payload = await response.json();
	if (!Array.isArray(payload)) throw new Error("CoinGecko payload was not an array");
	return payload.map(mapCoinGeckoMarket).filter((market) => market !== null);
}
async function fetchPolymarketMarkets() {
	const url = new URL("https://gamma-api.polymarket.com/markets");
	url.searchParams.set("active", "true");
	url.searchParams.set("closed", "false");
	url.searchParams.set("order", "volume24hr");
	url.searchParams.set("ascending", "false");
	url.searchParams.set("limit", String(POLYMARKET_MARKET_LIMIT));
	const response = await walletMarketOverviewFetch(url, {
		method: "GET",
		headers: {
			accept: "application/json",
			"user-agent": "Eliza Wallet Market Feed/1.0"
		}
	}, MARKET_OVERVIEW_FETCH_TIMEOUT_MS);
	if (!response.ok) throw new Error(`Polymarket responded ${response.status}`);
	const payload = await response.json();
	if (!Array.isArray(payload)) throw new Error("Polymarket payload was not an array");
	return payload.map(mapPolymarketMarket).filter((market) => market !== null);
}
function buildPriceSnapshots(markets) {
	const byId = new Map(markets.map((market) => [market.id, market]));
	return MARKET_PRICE_IDS.reduce((items, id) => {
		const market = byId.get(id);
		if (!market) return items;
		items.push({
			id: market.id,
			symbol: market.symbol,
			name: market.name,
			priceUsd: market.currentPriceUsd,
			change24hPct: market.change24hPct,
			imageUrl: market.imageUrl
		});
		return items;
	}, []);
}
function buildMovers(markets) {
	return markets.filter((market) => !MARKET_PRICE_ID_SET.has(market.id)).filter((market) => !isStableAsset(market)).filter((market) => market.marketCapRank === null || market.marketCapRank <= 200).sort((left, right) => Math.abs(right.change24hPct) - Math.abs(left.change24hPct)).slice(0, 6).map((market) => ({
		id: market.id,
		symbol: market.symbol,
		name: market.name,
		priceUsd: market.currentPriceUsd,
		change24hPct: market.change24hPct,
		marketCapRank: market.marketCapRank,
		imageUrl: market.imageUrl
	}));
}
function buildPredictions(markets) {
	const seenQuestions = /* @__PURE__ */ new Set();
	const predictions = [];
	for (const market of markets) {
		const normalizedQuestion = market.question.trim().toLowerCase();
		if (seenQuestions.has(normalizedQuestion)) continue;
		seenQuestions.add(normalizedQuestion);
		const highlightedOutcome = highlightedPredictionOutcome(market);
		predictions.push({
			id: market.slug ?? normalizedQuestion,
			slug: market.slug,
			question: market.question,
			highlightedOutcomeLabel: highlightedOutcome.label,
			highlightedOutcomeProbability: highlightedOutcome.probability,
			volume24hUsd: market.volume24hUsd,
			totalVolumeUsd: market.totalVolumeUsd,
			endsAt: market.endsAt,
			imageUrl: market.imageUrl
		});
	}
	return predictions.slice(0, 6);
}
function isWalletMarketOverviewSource(value) {
	const record = asRecord$1(value);
	return record !== null && typeof record.providerId === "string" && typeof record.providerName === "string" && typeof record.providerUrl === "string" && typeof record.available === "boolean" && typeof record.stale === "boolean" && (typeof record.error === "string" || record.error === null);
}
function isWalletMarketOverviewResponse(value) {
	const record = asRecord$1(value);
	const sources = asRecord$1(record?.sources);
	return record !== null && typeof record.generatedAt === "string" && typeof record.cacheTtlSeconds === "number" && typeof record.stale === "boolean" && sources !== null && isWalletMarketOverviewSource(sources.prices) && isWalletMarketOverviewSource(sources.movers) && isWalletMarketOverviewSource(sources.predictions) && Array.isArray(record.prices) && Array.isArray(record.movers) && Array.isArray(record.predictions);
}
function resolveWalletMarketOverviewCloudPreviewUrl() {
	return `${resolveCloudApiBaseUrl$1(process.env.ELIZAOS_CLOUD_BASE_URL)}${CLOUD_MARKET_OVERVIEW_PREVIEW_PATH}`;
}
async function fetchCloudWalletMarketOverview(clientAddress) {
	const response = await walletMarketOverviewFetch(resolveWalletMarketOverviewCloudPreviewUrl(), {
		method: "GET",
		headers: {
			accept: "application/json",
			"user-agent": "Eliza Wallet Market Feed/1.0",
			...clientAddress !== "unknown" ? { "x-forwarded-for": clientAddress } : {}
		}
	}, MARKET_OVERVIEW_FETCH_TIMEOUT_MS);
	if (!response.ok) throw new Error(`Cloud preview responded ${response.status}`);
	const payload = await response.json();
	if (!isWalletMarketOverviewResponse(payload)) throw new Error("Cloud preview payload was invalid");
	return payload;
}
async function buildWalletMarketOverview(clientAddress) {
	const [cloudPreviewResult, polymarketResult] = await Promise.allSettled([fetchCloudWalletMarketOverview(clientAddress), fetchPolymarketMarkets()]);
	const polymarketMarkets = polymarketResult.status === "fulfilled" ? polymarketResult.value : [];
	const polymarketError = polymarketResult.status === "rejected" ? marketOverviewErrorMessage(polymarketResult.reason) : null;
	if (cloudPreviewResult.status === "fulfilled") {
		if (polymarketError) logger.warn(`[WalletMarketOverviewRoute] Polymarket feed unavailable (${polymarketError})`);
		return {
			...cloudPreviewResult.value,
			sources: {
				...cloudPreviewResult.value.sources,
				predictions: buildMarketOverviewSource(POLYMARKET_SOURCE, {
					available: polymarketError === null,
					stale: false,
					error: polymarketError
				})
			},
			predictions: polymarketError === null ? buildPredictions(polymarketMarkets) : []
		};
	}
	{
		const error = cloudPreviewResult.reason;
		logger.warn(`[WalletMarketOverviewRoute] Cloud preview unavailable (${marketOverviewErrorMessage(error)}); falling back to direct feeds`);
	}
	const [coinGeckoResult] = await Promise.allSettled([fetchCoinGeckoMarkets()]);
	const coinGeckoMarkets = coinGeckoResult.status === "fulfilled" ? coinGeckoResult.value : [];
	const coinGeckoError = coinGeckoResult.status === "rejected" ? marketOverviewErrorMessage(coinGeckoResult.reason) : null;
	if (coinGeckoError) logger.warn(`[WalletMarketOverviewRoute] CoinGecko feed unavailable (${coinGeckoError})`);
	if (polymarketError) logger.warn(`[WalletMarketOverviewRoute] Polymarket feed unavailable (${polymarketError})`);
	if (coinGeckoError && polymarketError) throw new Error(`CoinGecko: ${coinGeckoError}; Polymarket: ${polymarketError}`);
	return {
		generatedAt: (/* @__PURE__ */ new Date()).toISOString(),
		cacheTtlSeconds: Math.floor(MARKET_OVERVIEW_CACHE_TTL_MS / 1e3),
		stale: false,
		sources: {
			prices: buildMarketOverviewSource(COINGECKO_SOURCE, {
				available: coinGeckoError === null,
				stale: false,
				error: coinGeckoError
			}),
			movers: buildMarketOverviewSource(COINGECKO_SOURCE, {
				available: coinGeckoError === null,
				stale: false,
				error: coinGeckoError
			}),
			predictions: buildMarketOverviewSource(POLYMARKET_SOURCE, {
				available: polymarketError === null,
				stale: false,
				error: polymarketError
			})
		},
		prices: buildPriceSnapshots(coinGeckoMarkets),
		movers: buildMovers(coinGeckoMarkets),
		predictions: buildPredictions(polymarketMarkets)
	};
}
function freshCachedWalletMarketOverview() {
	if (!cachedWalletMarketOverview || cachedWalletMarketOverview.expiresAt <= Date.now()) return null;
	return cachedWalletMarketOverview.response;
}
function staleCachedWalletMarketOverview() {
	if (!cachedWalletMarketOverview) return null;
	return {
		...cachedWalletMarketOverview.response,
		stale: true,
		sources: markMarketOverviewSourcesStale(cachedWalletMarketOverview.response.sources)
	};
}
function resolveClientAddress(req) {
	const forwardedFor = req.headers["x-forwarded-for"];
	if (typeof forwardedFor === "string" && forwardedFor.trim().length > 0) return forwardedFor.split(",")[0]?.trim() || "unknown";
	if (Array.isArray(forwardedFor) && forwardedFor.length > 0) return forwardedFor[0]?.trim() || "unknown";
	return req.socket.remoteAddress ?? "unknown";
}
function consumeRefreshSlot(clientAddress) {
	const now = Date.now();
	for (const [key, bucket] of walletMarketRefreshBuckets) if (bucket.resetAt <= now) walletMarketRefreshBuckets.delete(key);
	const bucket = walletMarketRefreshBuckets.get(clientAddress);
	if (!bucket || bucket.resetAt <= now) {
		walletMarketRefreshBuckets.set(clientAddress, {
			count: 1,
			resetAt: now + MARKET_OVERVIEW_REFRESH_WINDOW_MS
		});
		return {
			allowed: true,
			retryAfterSeconds: Math.ceil(MARKET_OVERVIEW_REFRESH_WINDOW_MS / 1e3)
		};
	}
	if (bucket.count >= MARKET_OVERVIEW_REFRESH_LIMIT) return {
		allowed: false,
		retryAfterSeconds: Math.max(1, Math.ceil((bucket.resetAt - now) / 1e3))
	};
	bucket.count += 1;
	walletMarketRefreshBuckets.set(clientAddress, bucket);
	return {
		allowed: true,
		retryAfterSeconds: Math.max(1, Math.ceil((bucket.resetAt - now) / 1e3))
	};
}
function setPublicMarketHeaders(res) {
	res.setHeader("Access-Control-Allow-Origin", "*");
	res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
	res.setHeader("Cache-Control", CACHE_CONTROL_VALUE);
}
async function loadWalletMarketOverview(clientAddress) {
	const fresh = freshCachedWalletMarketOverview();
	if (fresh) return fresh;
	if (!walletMarketOverviewInFlight) walletMarketOverviewInFlight = buildWalletMarketOverview(clientAddress).then((response) => {
		cachedWalletMarketOverview = {
			response,
			expiresAt: Date.now() + MARKET_OVERVIEW_CACHE_TTL_MS
		};
		return response;
	}).catch((error) => {
		const stale = staleCachedWalletMarketOverview();
		if (stale) {
			logger.warn(`[WalletMarketOverviewRoute] Refresh failed; serving stale market overview (${error instanceof Error ? error.message : String(error)})`);
			return stale;
		}
		throw error;
	}).finally(() => {
		walletMarketOverviewInFlight = null;
	});
	return walletMarketOverviewInFlight;
}
async function handleWalletMarketOverviewRoute(req, res) {
	const method = (req.method ?? "GET").toUpperCase();
	if (new URL(req.url ?? "/", "http://localhost").pathname !== MARKET_OVERVIEW_PATH) return false;
	setPublicMarketHeaders(res);
	if (method === "OPTIONS") {
		res.statusCode = 204;
		res.end();
		return true;
	}
	if (method !== "GET") {
		sendJsonError(res, 405, "Method not allowed");
		return true;
	}
	const clientAddress = resolveClientAddress(req);
	const fresh = freshCachedWalletMarketOverview();
	if (fresh) {
		sendJson$2(res, 200, fresh);
		return true;
	}
	if (!walletMarketOverviewInFlight) {
		const rateLimit = consumeRefreshSlot(clientAddress);
		if (!rateLimit.allowed) {
			const stale = staleCachedWalletMarketOverview();
			if (stale) {
				sendJson$2(res, 200, stale);
				return true;
			}
			res.setHeader("Retry-After", String(rateLimit.retryAfterSeconds));
			sendJsonError(res, 429, "Too many market overview refreshes");
			return true;
		}
	}
	try {
		sendJson$2(res, 200, await loadWalletMarketOverview(clientAddress));
	} catch (error) {
		logger.error(`[WalletMarketOverviewRoute] Failed to load market overview (${error instanceof Error ? error.message : String(error)})`);
		sendJsonError(res, 502, "Failed to load market overview");
	}
	return true;
}
var MARKET_OVERVIEW_PATH, CLOUD_MARKET_OVERVIEW_PREVIEW_PATH, MARKET_OVERVIEW_CACHE_TTL_MS, MARKET_OVERVIEW_FETCH_TIMEOUT_MS, MARKET_OVERVIEW_REFRESH_WINDOW_MS, MARKET_OVERVIEW_REFRESH_LIMIT, COINGECKO_MARKET_LIMIT, POLYMARKET_MARKET_LIMIT, CACHE_CONTROL_VALUE, MARKET_PRICE_IDS, MARKET_PRICE_ID_SET, COINGECKO_SOURCE, POLYMARKET_SOURCE, STABLE_ASSET_IDS, STABLE_ASSET_SYMBOLS, cachedWalletMarketOverview, walletMarketOverviewInFlight, walletMarketRefreshBuckets, walletMarketOverviewFetch;
var init_wallet_market_overview_route = __esmMin((() => {
	init_cloud_connection();
	init_response();
	MARKET_OVERVIEW_PATH = "/api/wallet/market-overview";
	CLOUD_MARKET_OVERVIEW_PREVIEW_PATH = "/market/preview/wallet-overview";
	MARKET_OVERVIEW_CACHE_TTL_MS = 12e4;
	MARKET_OVERVIEW_FETCH_TIMEOUT_MS = 8e3;
	MARKET_OVERVIEW_REFRESH_WINDOW_MS = 6e4;
	MARKET_OVERVIEW_REFRESH_LIMIT = 24;
	COINGECKO_MARKET_LIMIT = 80;
	POLYMARKET_MARKET_LIMIT = 10;
	CACHE_CONTROL_VALUE = "public, max-age=60, stale-while-revalidate=180";
	MARKET_PRICE_IDS = [
		"bitcoin",
		"ethereum",
		"solana"
	];
	MARKET_PRICE_ID_SET = new Set(MARKET_PRICE_IDS);
	COINGECKO_SOURCE = {
		providerId: "coingecko",
		providerName: "CoinGecko",
		providerUrl: "https://www.coingecko.com/"
	};
	POLYMARKET_SOURCE = {
		providerId: "polymarket",
		providerName: "Polymarket",
		providerUrl: "https://polymarket.com/"
	};
	STABLE_ASSET_IDS = new Set([
		"tether",
		"usd-coin",
		"binance-usd",
		"first-digital-usd",
		"dai",
		"ethena-usde",
		"true-usd",
		"usds"
	]);
	STABLE_ASSET_SYMBOLS = new Set([
		"usdt",
		"usdc",
		"busd",
		"fdusd",
		"dai",
		"usde",
		"tusd",
		"usds"
	]);
	cachedWalletMarketOverview = null;
	walletMarketOverviewInFlight = null;
	walletMarketRefreshBuckets = /* @__PURE__ */ new Map();
	walletMarketOverviewFetch = fetchWithTimeoutGuard;
}));

//#endregion
//#region node_modules/.bun/@elizaos+app-core@2.0.0-alpha.537+72829346cb4c43b1/node_modules/@elizaos/app-core/packages/app-core/src/api/workbench-compat-routes.js
function asCompatObject(value) {
	if (!value || typeof value !== "object" || Array.isArray(value)) return null;
	return value;
}
function readCompatTaskMetadata(task) {
	return asCompatObject(task.metadata) ?? {};
}
function normalizeCompatStringArray(value) {
	if (!Array.isArray(value)) return [];
	return value.filter((entry) => typeof entry === "string").map((entry) => entry.trim()).filter((entry) => entry.length > 0);
}
function parseCompatNullableNumber(value) {
	if (value === null || value === void 0 || value === "") return null;
	if (typeof value === "number" && Number.isFinite(value)) return Math.trunc(value);
	if (typeof value === "string") {
		const parsed = Number.parseInt(value, 10);
		return Number.isNaN(parsed) ? null : parsed;
	}
	return null;
}
function readCompatTaskCompleted(task) {
	const metadata = readCompatTaskMetadata(task);
	if (typeof metadata.isCompleted === "boolean") return metadata.isCompleted;
	const todoMeta = asCompatObject(metadata.workbenchTodo) ?? asCompatObject(metadata.todo);
	if (todoMeta && typeof todoMeta.isCompleted === "boolean") return todoMeta.isCompleted;
	return false;
}
function normalizeCompatTodoTags(value, defaults) {
	const tags = new Set(defaults.map((entry) => entry.trim()).filter((entry) => entry.length > 0));
	for (const tag of normalizeCompatStringArray(value)) tags.add(tag);
	return [...tags];
}
function toTaskBackedWorkbenchTodo(task) {
	if (!task) return null;
	const id = typeof task.id === "string" && task.id.trim().length > 0 ? task.id : null;
	if (!id) return null;
	const tags = new Set(normalizeCompatStringArray(task.tags));
	const metadata = readCompatTaskMetadata(task);
	const todoMeta = asCompatObject(metadata.workbenchTodo) ?? asCompatObject(metadata.todo);
	if (!tags.has(WORKBENCH_TODO_TAG) && !tags.has("todo") && !todoMeta) return null;
	return {
		id,
		name: typeof task.name === "string" && task.name.trim().length > 0 ? task.name : "Todo",
		description: typeof todoMeta?.description === "string" ? todoMeta.description : typeof task.description === "string" ? task.description : "",
		priority: parseCompatNullableNumber(todoMeta?.priority),
		isUrgent: todoMeta?.isUrgent === true,
		isCompleted: readCompatTaskCompleted(task),
		type: typeof todoMeta?.type === "string" && todoMeta.type.trim().length > 0 ? todoMeta.type : "task"
	};
}
function runtimeHasTodoDatabase(runtime) {
	const db = runtime?.db;
	return !!db && typeof db === "object";
}
function decodeCompatTodoId(rawValue, res) {
	try {
		const decoded = decodeURIComponent(rawValue);
		if (decoded.trim().length === 0) {
			sendJsonError(res, 400, "Invalid todo id");
			return null;
		}
		return decoded;
	} catch {
		sendJsonError(res, 400, "Invalid todo id");
		return null;
	}
}
async function handleTaskBackedWorkbenchTodoRoute(req, res, state, pathname, method) {
	const runtime = state.current;
	if (!runtime) return false;
	if (pathname !== "/api/workbench/todos" && !pathname.startsWith("/api/workbench/todos/")) return false;
	if (!await ensureRouteAuthorized(req, res, state)) return true;
	let operation = "route";
	try {
		const getTaskList = async () => await runtime.getTasks({});
		if (method === "GET" && pathname === "/api/workbench/todos") {
			operation = "list todos";
			sendJson$2(res, 200, { todos: (await getTaskList()).map((task) => toTaskBackedWorkbenchTodo(task)).filter((todo) => todo !== null).sort((left, right) => left.name.localeCompare(right.name)) });
			return true;
		}
		if (method === "POST" && pathname === "/api/workbench/todos") {
			const body = await readCompatJsonBody(req, res);
			if (body == null) return true;
			const name = typeof body.name === "string" ? body.name.trim() : "";
			if (!name) {
				sendJsonError(res, 400, "name is required");
				return true;
			}
			const description = typeof body.description === "string" ? body.description : "";
			const type = typeof body.type === "string" && body.type.trim().length > 0 ? body.type.trim() : "task";
			operation = "create todo";
			const taskId = await runtime.createTask({
				name,
				description,
				tags: normalizeCompatTodoTags(body.tags, [WORKBENCH_TODO_TAG, "todo"]),
				metadata: {
					isCompleted: false,
					workbenchTodo: {
						description,
						priority: parseCompatNullableNumber(body.priority),
						isUrgent: body.isUrgent === true,
						isCompleted: false,
						type
					}
				}
			});
			operation = "load created todo";
			const todo = toTaskBackedWorkbenchTodo(await runtime.getTask(taskId));
			if (!todo) {
				sendJsonError(res, 500, "Todo created but unavailable");
				return true;
			}
			sendJson$2(res, 201, { todo });
			return true;
		}
		const todoCompleteMatch = /^\/api\/workbench\/todos\/([^/]+)\/complete$/.exec(pathname);
		if (method === "POST" && todoCompleteMatch) {
			const todoId = decodeCompatTodoId(todoCompleteMatch[1], res);
			if (!todoId) return true;
			const body = await readCompatJsonBody(req, res);
			if (body == null) return true;
			operation = "load todo for completion";
			const todoTask = await runtime.getTask(todoId);
			const todo = toTaskBackedWorkbenchTodo(todoTask);
			if (!todoTask || !todo) {
				sendJsonError(res, 404, "Todo not found");
				return true;
			}
			const metadata = readCompatTaskMetadata(todoTask);
			const todoMeta = asCompatObject(metadata.workbenchTodo) ?? asCompatObject(metadata.todo);
			const isCompleted = body.isCompleted === true;
			operation = "update todo completion";
			await runtime.updateTask(todoId, { metadata: {
				...metadata,
				isCompleted,
				workbenchTodo: {
					...todoMeta ?? {},
					isCompleted
				}
			} });
			sendJson$2(res, 200, { ok: true });
			return true;
		}
		const todoItemMatch = /^\/api\/workbench\/todos\/([^/]+)$/.exec(pathname);
		if (!todoItemMatch) return false;
		const todoId = decodeCompatTodoId(todoItemMatch[1], res);
		if (!todoId) return true;
		if (method === "GET") {
			operation = "load todo";
			const todoTask = await runtime.getTask(todoId);
			const todo = toTaskBackedWorkbenchTodo(todoTask);
			if (!todoTask || !todo) {
				sendJsonError(res, 404, "Todo not found");
				return true;
			}
			sendJson$2(res, 200, { todo });
			return true;
		}
		if (method === "DELETE") {
			operation = "load todo for deletion";
			const todoTask = await runtime.getTask(todoId);
			if (!todoTask || !toTaskBackedWorkbenchTodo(todoTask)) {
				sendJsonError(res, 404, "Todo not found");
				return true;
			}
			operation = "delete todo";
			await runtime.deleteTask(todoId);
			sendJson$2(res, 200, { ok: true });
			return true;
		}
		if (method === "PUT") {
			const body = await readCompatJsonBody(req, res);
			if (body == null) return true;
			operation = "load todo for update";
			const todoTask = await runtime.getTask(todoId);
			const existingTodo = toTaskBackedWorkbenchTodo(todoTask);
			if (!todoTask || !existingTodo) {
				sendJsonError(res, 404, "Todo not found");
				return true;
			}
			if (typeof body.name === "string" && body.name.trim().length === 0) {
				sendJsonError(res, 400, "name cannot be empty");
				return true;
			}
			const metadata = readCompatTaskMetadata(todoTask);
			const nextTodoMeta = { ...asCompatObject(metadata.workbenchTodo) ?? asCompatObject(metadata.todo) ?? {} };
			const update = {};
			if (typeof body.name === "string") update.name = body.name.trim();
			if (typeof body.description === "string") {
				update.description = body.description;
				nextTodoMeta.description = body.description;
			}
			if (body.priority !== void 0) nextTodoMeta.priority = parseCompatNullableNumber(body.priority);
			if (typeof body.isUrgent === "boolean") nextTodoMeta.isUrgent = body.isUrgent;
			if (typeof body.type === "string" && body.type.trim().length > 0) nextTodoMeta.type = body.type.trim();
			if (body.tags !== void 0) update.tags = normalizeCompatTodoTags(body.tags, [WORKBENCH_TODO_TAG, "todo"]);
			const isCompleted = typeof body.isCompleted === "boolean" ? body.isCompleted : existingTodo.isCompleted;
			nextTodoMeta.isCompleted = isCompleted;
			update.metadata = {
				...metadata,
				isCompleted,
				workbenchTodo: nextTodoMeta
			};
			operation = "update todo";
			await runtime.updateTask(todoId, update);
			operation = "load updated todo";
			const todo = toTaskBackedWorkbenchTodo(await runtime.getTask(todoId));
			if (!todo) {
				sendJsonError(res, 500, "Todo updated but unavailable");
				return true;
			}
			sendJson$2(res, 200, { todo });
			return true;
		}
		return false;
	} catch (err) {
		logger.error(`[workbench/todos] ${operation} failed: ${err instanceof Error ? err.message : String(err)}`);
		sendJsonError(res, 500, `Failed to ${operation}`);
		return true;
	}
}
async function handleWorkbenchCompatRoutes(req, res, state) {
	const method = (req.method ?? "GET").toUpperCase();
	const url = new URL(req.url ?? "/", "http://localhost");
	if (url.pathname.startsWith("/api/workbench/todos") && !runtimeHasTodoDatabase(state.current)) return handleTaskBackedWorkbenchTodoRoute(req, res, state, url.pathname, method);
	return false;
}
var WORKBENCH_TODO_TAG;
var init_workbench_compat_routes = __esmMin((() => {
	init_auth$1();
	init_compat_route_shared();
	init_response();
	WORKBENCH_TODO_TAG = "workbench:todo";
}));

//#endregion
//#region node_modules/.bun/@elizaos+app-core@2.0.0-alpha.537+72829346cb4c43b1/node_modules/@elizaos/app-core/packages/app-core/src/security/agent-vault-id.js
/**
* Canonical state directory for this process (same semantics as `ELIZA_STATE_DIR` default).
* Uses `realpathSync` when the path exists so symlinks normalize consistently.
*/
function resolveCanonicalStateDir() {
	const raw = process.env.ELIZA_STATE_DIR?.trim();
	const base = raw && raw.length > 0 ? raw : path.join(os.homedir(), ".eliza");
	const resolved = path.resolve(base);
	try {
		return fs.realpathSync(resolved);
	} catch {
		return resolved;
	}
}
/**
* Opaque vault id for OS secret stores: `mldy1-` + first 16 chars of base64url(sha256(canonicalStateDir)).
*/
function deriveAgentVaultId(canonicalStateDir = resolveCanonicalStateDir()) {
	const hash = createHash("sha256").update(canonicalStateDir, "utf8").digest();
	return `mldy1-${Buffer.from(hash).toString("base64url").slice(0, 16)}`;
}
function keychainAccountForSecretKind(vaultId, kind) {
	return `${vaultId}:${kind}`;
}
var ELIZA_AGENT_VAULT_SERVICE;
var init_agent_vault_id = __esmMin((() => {
	ELIZA_AGENT_VAULT_SERVICE = "ai.elizaos.agent.vault";
}));

//#endregion
//#region node_modules/.bun/@elizaos+app-core@2.0.0-alpha.537+72829346cb4c43b1/node_modules/@elizaos/app-core/packages/app-core/src/security/platform-secure-store-node.js
function isDarwin() {
	return process.platform === "darwin";
}
function isLinux() {
	return process.platform === "linux";
}
/**
* Write a password to the macOS Keychain via stdin to avoid argv exposure.
* The `security add-generic-password` command reads from stdin when `-w`
* is the last argument with no value. It prompts twice (password + retype),
* so we write the value twice separated by a newline.
*/
function keychainSetViaStdin(args, password) {
	return new Promise((resolve, reject) => {
		const child = spawn("security", args, { stdio: [
			"pipe",
			"pipe",
			"pipe"
		] });
		let stderr = "";
		child.stderr.setEncoding("utf8");
		child.stderr.on("data", (chunk) => {
			stderr += chunk;
		});
		child.on("error", reject);
		child.on("close", (code) => {
			if (code === 0) {
				resolve();
				return;
			}
			reject(Object.assign(new Error(stderr.trim() || `security exited ${code}`), {
				stderr,
				code
			}));
		});
		child.stdin.on("error", () => {});
		child.stdin.write(`${password}\n${password}\n`, () => {
			child.stdin.end();
		});
	});
}
function secretToolStoreWithStdin(args, secretLine) {
	return new Promise((resolve, reject) => {
		const child = spawn("secret-tool", args, { stdio: [
			"pipe",
			"pipe",
			"pipe"
		] });
		let stderr = "";
		child.stderr.setEncoding("utf8");
		child.stderr.on("data", (chunk) => {
			stderr += chunk;
		});
		child.on("error", reject);
		child.on("close", (code) => {
			if (code === 0) {
				resolve();
				return;
			}
			reject(Object.assign(new Error(stderr.trim() || `secret-tool exited ${code}`), {
				stderr,
				code
			}));
		});
		const line = secretLine.endsWith("\n") ? secretLine : `${secretLine}\n`;
		child.stdin.write(line, "utf8");
		child.stdin.end();
	});
}
/**
* Check if `secret-tool` is available on PATH without spawning a shell.
* Iterates PATH entries directly and checks for the executable.
*/
async function secretToolOnPath() {
	if (process.platform === "win32") return false;
	const pathEnv = process.env.PATH ?? "";
	for (const dir of pathEnv.split(path.delimiter)) {
		if (!dir) continue;
		const candidate = path.join(dir, "secret-tool");
		try {
			fs.accessSync(candidate, fs.constants.X_OK);
			return true;
		} catch {}
	}
	return false;
}
function macErrReason(stderr, code) {
	const s = stderr.toLowerCase();
	if (s.includes("could not be found") || s.includes("the specified item could not be found")) return {
		ok: false,
		reason: "not_found"
	};
	if (s.includes("user canceled") || s.includes("user cancelled")) return {
		ok: false,
		reason: "denied"
	};
	return {
		ok: false,
		reason: code === 44 || code === 45 ? "denied" : "error",
		message: stderr.trim().slice(0, 300)
	};
}
/**
* Node-side factory: macOS Keychain, Linux `secret-tool`, or unavailable placeholder.
* Windows Credential Manager is not wired yet (`none`).
*/
function createNodePlatformSecureStore() {
	if (isDarwin()) return new MacOSKeychainPlatformSecureStore();
	if (isLinux()) return new LinuxSecretToolPlatformSecureStore();
	return new NonePlatformSecureStore();
}
/**
* Opt in: `ELIZA_WALLET_OS_STORE=1` / `true` / `on` / `yes`.
*
* Defaults to **off** until the macOS argv exposure is resolved via
* Security.framework / Bun FFI. Users who accept the risk can enable
* explicitly.
*/
function isWalletOsStoreReadEnabled() {
	const raw = process.env.ELIZA_WALLET_OS_STORE?.trim().toLowerCase();
	return raw === "1" || raw === "true" || raw === "on" || raw === "yes";
}
var execFileAsync, MacOSKeychainPlatformSecureStore, LinuxSecretToolPlatformSecureStore, NonePlatformSecureStore;
var init_platform_secure_store_node = __esmMin((() => {
	init_agent_vault_id();
	execFileAsync = promisify(execFile);
	MacOSKeychainPlatformSecureStore = class {
		backend = "macos_keychain";
		async isAvailable() {
			try {
				await execFileAsync("security", ["-h"], { encoding: "utf8" });
				return true;
			} catch {
				return false;
			}
		}
		async get(vaultId, kind) {
			const account = keychainAccountForSecretKind(vaultId, kind);
			try {
				const { stdout, stderr: _stderr } = await execFileAsync("security", [
					"find-generic-password",
					"-s",
					ELIZA_AGENT_VAULT_SERVICE,
					"-a",
					account,
					"-w"
				], { encoding: "utf8" });
				const value = stdout.trim();
				if (!value) return {
					ok: false,
					reason: "not_found"
				};
				return {
					ok: true,
					value
				};
			} catch (err) {
				const e = err;
				return macErrReason(String(e.stderr ?? err), e.code ?? null);
			}
		}
		async set(vaultId, kind, value) {
			const account = keychainAccountForSecretKind(vaultId, kind);
			try {
				await keychainSetViaStdin([
					"add-generic-password",
					"-s",
					ELIZA_AGENT_VAULT_SERVICE,
					"-a",
					account,
					"-U",
					"-w"
				], value);
				return { ok: true };
			} catch (err) {
				return {
					ok: false,
					reason: "error",
					message: String(err.stderr ?? err).trim().slice(0, 300)
				};
			}
		}
		async delete(vaultId, kind) {
			const account = keychainAccountForSecretKind(vaultId, kind);
			try {
				await execFileAsync("security", [
					"delete-generic-password",
					"-s",
					ELIZA_AGENT_VAULT_SERVICE,
					"-a",
					account
				]);
			} catch {}
		}
	};
	LinuxSecretToolPlatformSecureStore = class {
		backend = "linux_secret_service";
		async isAvailable() {
			return secretToolOnPath();
		}
		account(vaultId, kind) {
			return keychainAccountForSecretKind(vaultId, kind);
		}
		async get(vaultId, kind) {
			const account = this.account(vaultId, kind);
			try {
				const { stdout } = await execFileAsync("secret-tool", [
					"lookup",
					"service",
					ELIZA_AGENT_VAULT_SERVICE,
					"account",
					account
				], { encoding: "utf8" });
				const value = stdout.trim();
				if (!value) return {
					ok: false,
					reason: "not_found"
				};
				return {
					ok: true,
					value
				};
			} catch (err) {
				const e = err;
				const stderr = String(e.stderr ?? "");
				if (e.code === 1 || stderr.includes("not found")) return {
					ok: false,
					reason: "not_found"
				};
				return {
					ok: false,
					reason: "error",
					message: stderr.trim().slice(0, 300)
				};
			}
		}
		async set(vaultId, kind, value) {
			const account = this.account(vaultId, kind);
			try {
				await secretToolStoreWithStdin([
					"store",
					"--label=Eliza agent wallet",
					"service",
					ELIZA_AGENT_VAULT_SERVICE,
					"account",
					account
				], value);
				return { ok: true };
			} catch (err) {
				const e = err;
				return {
					ok: false,
					reason: "error",
					message: String(e.stderr ?? err).trim().slice(0, 300)
				};
			}
		}
		async delete(vaultId, kind) {
			const account = this.account(vaultId, kind);
			try {
				await execFileAsync("secret-tool", [
					"clear",
					"service",
					ELIZA_AGENT_VAULT_SERVICE,
					"account",
					account
				]);
			} catch {}
		}
	};
	NonePlatformSecureStore = class {
		backend;
		constructor(backend = "none") {
			this.backend = backend;
		}
		async isAvailable() {
			return false;
		}
		async get() {
			return {
				ok: false,
				reason: "unavailable"
			};
		}
		async set() {
			return {
				ok: false,
				reason: "unavailable"
			};
		}
		async delete() {}
	};
}));

//#endregion
//#region node_modules/.bun/@elizaos+app-core@2.0.0-alpha.537+72829346cb4c43b1/node_modules/@elizaos/app-core/packages/app-core/src/security/hydrate-wallet-keys-from-platform-store.js
/**
* One-shot copy of legacy OS-keystore wallet keys into the shared vault.
* Returns the env keys that were copied across so the caller can log /
* surface a migration banner.
*/
async function migrateOsStoreWalletKeysIntoVault(envKeys, opts = {}) {
	if (envKeys.length === 0) return [];
	if (!isWalletOsStoreReadEnabled()) return [];
	const store = createNodePlatformSecureStore();
	if (!await store.isAvailable()) return [];
	const vault = sharedVault();
	const vaultId = deriveAgentVaultId();
	const keychainKindFor = {
		EVM_PRIVATE_KEY: "wallet.evm_private_key",
		SOLANA_PRIVATE_KEY: "wallet.solana_private_key"
	};
	const migrated = [];
	for (const envKey of envKeys) {
		const kind = keychainKindFor[envKey];
		if (!kind) continue;
		const got = await store.get(vaultId, kind);
		if (!got.ok) continue;
		process.env[envKey] = got.value;
		if ((opts.overwriteVaultKeys?.has(envKey) ?? false) || !await vault.has(envKey)) {
			await vault.set(envKey, got.value, {
				sensitive: true,
				caller: "wallet-os-store-migrate"
			});
			migrated.push(String(envKey));
		}
	}
	return migrated;
}
/**
* Fills `process.env` wallet keys from the shared vault (now the source
* of truth). On first boot after the storage unification, copies any
* legacy OS-keystore values into the vault and then proceeds normally.
*
* Steward env vars stay on the OS-keystore path — the steward backend's
* lifecycle is independent of the unified wallet vault.
*
* Runs before upstream `startApiServer` merges `config.env`, so persisted
* config only fills gaps that neither vault nor OS keystore supplies.
*/
async function hydrateWalletKeysFromNodePlatformSecureStore() {
	const vault = sharedVault();
	const missingWalletKeys = [];
	const unreadableWalletKeys = /* @__PURE__ */ new Set();
	for (const envKey of WALLET_VAULT_KEYS) {
		const cur = process.env[envKey];
		if (typeof cur === "string" && cur.trim()) continue;
		if (await vault.has(envKey)) {
			try {
				const value = await vault.reveal(envKey, "wallet-hydrate-boot");
				process.env[envKey] = value;
			} catch (err) {
				unreadableWalletKeys.add(envKey);
				missingWalletKeys.push(envKey);
				logger.warn(`[wallet][vault] failed to reveal ${envKey}: ${err instanceof Error ? err.message : String(err)}. Will try legacy OS-store recovery if available.`);
			}
			continue;
		}
		missingWalletKeys.push(envKey);
	}
	if (missingWalletKeys.length > 0) try {
		const migrated = await migrateOsStoreWalletKeysIntoVault(missingWalletKeys, { overwriteVaultKeys: unreadableWalletKeys });
		if (migrated.length > 0) logger.info(`[wallet][vault] migrated ${migrated.length} key(s) from OS keystore: ${migrated.join(", ")}`);
	} catch (err) {
		logger.warn(`[wallet][vault] os-store migration failed: ${err instanceof Error ? err.message : String(err)}`);
	}
	if (!isWalletOsStoreReadEnabled()) return;
	try {
		const store = createNodePlatformSecureStore();
		if (!await store.isAvailable()) return;
		const vaultId = deriveAgentVaultId();
		for (const [envKey, kind] of STEWARD_OS_PAIRS) {
			const cur = process.env[envKey];
			if (typeof cur === "string" && cur.trim()) continue;
			const got = await store.get(vaultId, kind);
			if (got.ok) process.env[envKey] = got.value;
		}
	} catch (err) {
		logger.warn(`[wallet][os-store] steward hydrate failed: ${err instanceof Error ? err.message : String(err)}`);
	}
}
var WALLET_VAULT_KEYS, STEWARD_OS_PAIRS;
var init_hydrate_wallet_keys_from_platform_store = __esmMin((() => {
	init_vault_mirror();
	init_agent_vault_id();
	init_platform_secure_store_node();
	WALLET_VAULT_KEYS = ["EVM_PRIVATE_KEY", "SOLANA_PRIVATE_KEY"];
	STEWARD_OS_PAIRS = [
		["STEWARD_API_URL", "steward.api_url"],
		["STEWARD_AGENT_ID", "steward.agent_id"],
		["STEWARD_AGENT_TOKEN", "steward.agent_token"]
	];
}));

//#endregion
//#region node_modules/.bun/@elizaos+app-core@2.0.0-alpha.537+72829346cb4c43b1/node_modules/@elizaos/app-core/packages/app-core/src/security/wallet-os-store-actions.js
/**
* Remove main wallet keys from BOTH the vault and the OS keystore.
* Used by `POST /api/agent/reset` and the equivalent CLI flow.
*/
async function deleteWalletSecretsFromOsStore() {
	const vault = sharedVault();
	for (const [envKey] of WALLET_PAIRS) if (await vault.has(envKey)) await vault.remove(envKey);
	if (!isWalletOsStoreReadEnabled()) return;
	const store = createNodePlatformSecureStore();
	if (!await store.isAvailable()) return;
	const vaultId = deriveAgentVaultId();
	await store.delete(vaultId, "wallet.evm_private_key");
	await store.delete(vaultId, "wallet.solana_private_key");
}
var WALLET_PAIRS;
var init_wallet_os_store_actions = __esmMin((() => {
	init_dist();
	init_vault_mirror();
	init_agent_vault_id();
	init_platform_secure_store_node();
	WALLET_PAIRS = [["EVM_PRIVATE_KEY", "wallet.evm_private_key"], ["SOLANA_PRIVATE_KEY", "wallet.solana_private_key"]];
}));

//#endregion
//#region node_modules/.bun/@elizaos+app-core@2.0.0-alpha.537+72829346cb4c43b1/node_modules/@elizaos/app-core/packages/app-core/src/config/plugin-ui-spec.js
var plugin_ui_spec_exports = /* @__PURE__ */ __exportAll({
	buildPluginConfigUiSpec: () => buildPluginConfigUiSpec,
	buildPluginListUiSpec: () => buildPluginListUiSpec
});
/**
* Generates UiSpec JSON for plugin/connector configuration forms.
*
* When the agent wants to help a user configure a plugin, it generates
* a UiSpec that renders as an interactive form in chat. The form fields
* are derived from the plugin's parameter definitions.
*
* Actions:
*   - "plugin:save" → saves config via PUT /api/plugins/:id
*   - "plugin:enable" → enables the plugin
*   - "plugin:test" → tests connectivity
*/
function buildPluginConfigUiSpec(plugin) {
	const elements = {};
	const rootChildren = [];
	const state = { pluginId: plugin.id };
	elements.header = {
		type: "Stack",
		props: {
			gap: "1",
			children: ["title", "desc"]
		}
	};
	rootChildren.push("header");
	elements.title = {
		type: "Heading",
		props: {
			level: 3,
			text: `Configure ${plugin.name}`
		}
	};
	if (plugin.description) elements.desc = {
		type: "Text",
		props: {
			text: plugin.description,
			className: "text-xs text-muted"
		}
	};
	elements.status = {
		type: "Badge",
		props: {
			text: plugin.enabled ? plugin.parameters.every((p) => !p.required || p.isSet) ? "Ready" : "Needs Configuration" : "Disabled",
			variant: plugin.enabled ? plugin.parameters.every((p) => !p.required || p.isSet) ? "default" : "secondary" : "outline"
		}
	};
	rootChildren.push("status");
	elements.sep = {
		type: "Separator",
		props: {}
	};
	rootChildren.push("sep");
	const fieldIds = [];
	for (const param of plugin.parameters) {
		const fieldId = `field_${param.key}`;
		const statePath = `config.${param.key}`;
		fieldIds.push(fieldId);
		state[`config.${param.key}`] = "";
		const isSecret = param.key.includes("KEY") || param.key.includes("TOKEN") || param.key.includes("SECRET") || param.key.includes("PASSWORD");
		elements[fieldId] = {
			type: "Input",
			props: {
				label: param.label || param.key,
				placeholder: param.isSet ? "••••••• (already set)" : param.required ? "Required" : "Optional",
				statePath,
				type: isSecret ? "password" : "text",
				className: "font-mono text-xs"
			},
			...param.required ? { validation: { checks: [{
				rule: "required",
				message: `${param.key} is required`
			}] } } : {}
		};
		if (param.description) {
			const hintId = `hint_${param.key}`;
			fieldIds.push(hintId);
			elements[hintId] = {
				type: "Text",
				props: {
					text: param.description,
					className: "text-2xs text-muted -mt-1 mb-1"
				}
			};
		}
	}
	elements.fields = {
		type: "Stack",
		props: {
			gap: "3",
			children: fieldIds
		}
	};
	rootChildren.push("fields");
	const buttonChildren = ["saveBtn"];
	elements.saveBtn = {
		type: "Button",
		props: {
			text: "Save Configuration",
			variant: "default",
			className: "font-semibold",
			on: { press: {
				action: "plugin:save",
				params: { pluginId: plugin.id }
			} }
		}
	};
	if (!plugin.enabled) {
		buttonChildren.push("enableBtn");
		elements.enableBtn = {
			type: "Button",
			props: {
				text: "Enable Plugin",
				variant: "outline",
				on: { press: {
					action: "plugin:enable",
					params: { pluginId: plugin.id }
				} }
			}
		};
	}
	if (plugin.category === "connector") {
		buttonChildren.push("testBtn");
		elements.testBtn = {
			type: "Button",
			props: {
				text: "Test Connection",
				variant: "outline",
				on: { press: {
					action: "plugin:test",
					params: { pluginId: plugin.id }
				} }
			}
		};
	}
	elements.actions = {
		type: "Stack",
		props: {
			direction: "row",
			gap: "2",
			children: buttonChildren
		}
	};
	rootChildren.push("actions");
	elements.root = {
		type: "Card",
		props: {
			children: rootChildren,
			className: "p-4 space-y-3"
		}
	};
	return {
		version: 1,
		root: "root",
		elements,
		state
	};
}
/**
* Generate a compact plugin list UiSpec for the agent to show available
* plugins matching a query.
*/
function buildPluginListUiSpec(plugins, title) {
	const elements = {};
	const cardIds = [];
	elements.heading = {
		type: "Heading",
		props: {
			level: 3,
			text: title
		}
	};
	for (let i = 0; i < plugins.length; i++) {
		const p = plugins[i];
		const cardId = `card_${i}`;
		const nameId = `name_${i}`;
		const descId = `desc_${i}`;
		const badgeId = `badge_${i}`;
		const configBtnId = `cfgBtn_${i}`;
		cardIds.push(cardId);
		elements[nameId] = {
			type: "Text",
			props: {
				text: p.name,
				className: "font-semibold text-sm"
			}
		};
		elements[descId] = {
			type: "Text",
			props: {
				text: p.description || "No description",
				className: "text-xs text-muted"
			}
		};
		elements[badgeId] = {
			type: "Badge",
			props: {
				text: p.enabled ? "Enabled" : "Available",
				variant: p.enabled ? "default" : "outline"
			}
		};
		elements[configBtnId] = {
			type: "Button",
			props: {
				text: "Configure",
				variant: "outline",
				size: "sm",
				on: { press: {
					action: "plugin:configure",
					params: { pluginId: p.id }
				} }
			}
		};
		elements[cardId] = {
			type: "Card",
			props: {
				children: [
					nameId,
					descId,
					badgeId,
					configBtnId
				],
				className: "p-3 space-y-1"
			}
		};
	}
	elements.list = {
		type: "Stack",
		props: {
			gap: "2",
			children: cardIds
		}
	};
	elements.root = {
		type: "Stack",
		props: {
			gap: "3",
			children: ["heading", "list"]
		}
	};
	return {
		version: 1,
		root: "root",
		elements,
		state: {}
	};
}
var init_plugin_ui_spec = __esmMin((() => {}));

//#endregion
//#region node_modules/.bun/@elizaos+app-core@2.0.0-alpha.537+72829346cb4c43b1/node_modules/@elizaos/app-core/packages/app-core/src/api/server.js
var server_exports = /* @__PURE__ */ __exportAll({
	AGENT_EVENT_ALLOWED_STREAMS: () => AGENT_EVENT_ALLOWED_STREAMS,
	CONFIG_WRITE_ALLOWED_TOP_KEYS: () => CONFIG_WRITE_ALLOWED_TOP_KEYS,
	DATABASE_UNAVAILABLE_MESSAGE: () => DATABASE_UNAVAILABLE_MESSAGE,
	SENSITIVE_ENV_RESPONSE_KEYS: () => SENSITIVE_ENV_RESPONSE_KEYS,
	__resetCloudBaseUrlCache: () => __resetCloudBaseUrlCache,
	buildCorsAllowedPorts: () => buildCorsAllowedPorts,
	cloneWithoutBlockedObjectKeys: () => cloneWithoutBlockedObjectKeys,
	discoverInstalledPlugins: () => discoverInstalledPlugins,
	discoverPluginsFromManifest: () => discoverPluginsFromManifest$1,
	ensureApiTokenForBindHost: () => ensureApiTokenForBindHost$1,
	ensureCloudTtsApiKeyAlias: () => ensureCloudTtsApiKeyAlias,
	extractAuthToken: () => extractAuthToken,
	fetchWithTimeoutGuard: () => fetchWithTimeoutGuard$1,
	filterConfigEnvForResponse: () => filterConfigEnvForResponse,
	findOwnPackageRoot: () => findOwnPackageRoot,
	getConfiguredCompatAgentName: () => getConfiguredCompatAgentName,
	handleElizaCompatRoute: () => handleElizaCompatRoute,
	hasCompatPersistedOnboardingState: () => hasCompatPersistedOnboardingState,
	injectApiBaseIntoHtml: () => injectApiBaseIntoHtml$1,
	invalidateCorsAllowedPorts: () => invalidateCorsAllowedPorts,
	isAllowedHost: () => isAllowedHost,
	isAllowedLocalOrigin: () => isAllowedLocalOrigin,
	isAuthorized: () => isAuthorized,
	isLoopbackRemoteAddress: () => isLoopbackRemoteAddress,
	isSafeResetStateDir: () => isSafeResetStateDir$1,
	normalizeWsClientId: () => normalizeWsClientId,
	patchHttpCreateServerForCompat: () => patchHttpCreateServerForCompat,
	persistConversationRoomTitle: () => persistConversationRoomTitle,
	readCompatJsonBody: () => readCompatJsonBody,
	resolveCloudTtsBaseUrl: () => resolveCloudTtsBaseUrl,
	resolveCorsOrigin: () => resolveCorsOrigin$1,
	resolveElevenLabsApiKeyForCloudMode: () => resolveElevenLabsApiKeyForCloudMode,
	resolveMcpServersRejection: () => resolveMcpServersRejection,
	resolveMcpTerminalAuthorizationRejection: () => resolveMcpTerminalAuthorizationRejection$1,
	resolvePluginConfigMutationRejections: () => resolvePluginConfigMutationRejections,
	resolveTerminalRunClientId: () => resolveTerminalRunClientId$1,
	resolveTerminalRunRejection: () => resolveTerminalRunRejection$1,
	resolveWalletExportRejection: () => resolveWalletExportRejection$1,
	resolveWebSocketUpgradeRejection: () => resolveWebSocketUpgradeRejection$1,
	routeAutonomyTextToUser: () => routeAutonomyTextToUser,
	setResolvedLoopbackPort: () => setResolvedLoopbackPort,
	startApiServer: () => startApiServer$1,
	streamResponseBodyWithByteLimit: () => streamResponseBodyWithByteLimit,
	syncCompatConfigFiles: () => syncCompatConfigFiles,
	validateMcpServerConfig: () => validateMcpServerConfig
});
function hydrateWalletOsStoreFlagFromConfig() {
	if (process.env.ELIZA_WALLET_OS_STORE?.trim()) return;
	try {
		const config = loadElizaConfig$1();
		const raw = (config.env && typeof config.env === "object" && !Array.isArray(config.env) ? config.env : void 0)?.ELIZA_WALLET_OS_STORE;
		if (typeof raw === "string" && raw.trim()) process.env.ELIZA_WALLET_OS_STORE = raw.trim();
	} catch {}
}
function resolveCompatConfigPaths() {
	const sharedStateDir = process.env.ELIZA_STATE_DIR?.trim();
	const configPath = process.env.ELIZA_CONFIG_PATH?.trim() || (sharedStateDir ? path.join(sharedStateDir, "eliza.json") : void 0);
	return {
		elizaConfigPath: configPath,
		appConfigPath: configPath
	};
}
function syncCompatConfigFiles() {
	const { elizaConfigPath, appConfigPath } = resolveCompatConfigPaths();
	if (!elizaConfigPath || !appConfigPath || elizaConfigPath === appConfigPath) return;
	const elizaExists = fs.existsSync(elizaConfigPath);
	const appExists = fs.existsSync(appConfigPath);
	if (!elizaExists && !appExists) return;
	let sourcePath;
	let targetPath;
	if (elizaExists && !appExists) {
		sourcePath = elizaConfigPath;
		targetPath = appConfigPath;
	} else if (!elizaExists && appExists) {
		sourcePath = appConfigPath;
		targetPath = elizaConfigPath;
	} else {
		const elizaStat = fs.statSync(elizaConfigPath);
		const appStat = fs.statSync(appConfigPath);
		if (appStat.mtimeMs > elizaStat.mtimeMs) {
			sourcePath = appConfigPath;
			targetPath = elizaConfigPath;
		} else if (elizaStat.mtimeMs > appStat.mtimeMs) {
			sourcePath = elizaConfigPath;
			targetPath = appConfigPath;
		} else return;
	}
	fs.mkdirSync(path.dirname(targetPath), { recursive: true });
	fs.copyFileSync(sourcePath, targetPath);
}
function resolveCompatPgliteDataDir(config) {
	const explicitDataDir = process.env.PGLITE_DATA_DIR?.trim();
	if (explicitDataDir) return resolveUserPath(explicitDataDir);
	const configuredDataDir = config.database?.pglite?.dataDir?.trim();
	if (configuredDataDir) return resolveUserPath(configuredDataDir);
	const workspaceDir = config.agents?.defaults?.workspace ?? resolveDefaultAgentWorkspaceDir();
	return path.join(resolveUserPath(workspaceDir), ".eliza", ".elizadb");
}
/** Called from startApiServer after the upstream server resolves. */
function setResolvedLoopbackPort(port) {
	_resolvedLoopbackPort = port;
}
/**
* Build the loopback base URL for internal server-to-self API calls.
* Always targets 127.0.0.1 — never trusts the incoming Host header,
* which would allow an attacker to redirect loopback fetches (and the
* attached API token) to an external server.
*
* Priority: actual listener port > env vars > default 31337.
*/
function resolveCompatLoopbackApiBase(_req) {
	return `http://127.0.0.1:${_resolvedLoopbackPort ?? (Number(process.env.ELIZA_API_PORT?.trim() || process.env.ELIZA_PORT?.trim() || "31337") || 31337)}`;
}
function buildCompatLoopbackHeaders(_req, init) {
	const headers = new Headers(init?.headers ?? {});
	if (!headers.has("Accept")) headers.set("Accept", "application/json");
	if (!headers.has("Content-Type") && init?.body) headers.set("Content-Type", "application/json");
	const apiToken = getCompatApiToken$1();
	if (apiToken && !headers.has("Authorization")) headers.set("Authorization", `Bearer ${apiToken}`);
	return headers;
}
async function compatLoopbackFetchJson(req, pathname, init) {
	const response = await fetch(new URL(pathname, resolveCompatLoopbackApiBase(req)), {
		...init,
		headers: buildCompatLoopbackHeaders(req, init)
	});
	if (!response.ok) throw new Error(`${response.status} ${response.statusText}: ${pathname}`);
	return await response.json();
}
async function compatLoopbackRequest(req, pathname, init) {
	const response = await fetch(new URL(pathname, resolveCompatLoopbackApiBase(req)), {
		...init,
		headers: buildCompatLoopbackHeaders(req, init)
	});
	if (!response.ok) throw new Error(`${response.status} ${response.statusText}: ${pathname}`);
}
async function clearCompatRuntimeStateViaApi(req) {
	try {
		const conversations = await compatLoopbackFetchJson(req, "/api/conversations");
		for (const conversation of conversations.conversations ?? []) {
			if (!conversation?.id) continue;
			await compatLoopbackRequest(req, `/api/conversations/${encodeURIComponent(conversation.id)}`, { method: "DELETE" });
		}
	} catch (err) {
		logger.warn(`[eliza][reset] Failed to clear conversations before reset: ${err instanceof Error ? err.message : String(err)}`);
	}
	try {
		const knowledge = await compatLoopbackFetchJson(req, "/api/knowledge/documents");
		for (const document of knowledge.documents ?? []) {
			if (!document?.id) continue;
			await compatLoopbackRequest(req, `/api/knowledge/documents/${encodeURIComponent(document.id)}`, { method: "DELETE" });
		}
	} catch (err) {
		logger.warn(`[eliza][reset] Failed to clear knowledge documents before reset: ${err instanceof Error ? err.message : String(err)}`);
	}
	try {
		await compatLoopbackRequest(req, "/api/trajectories", {
			method: "DELETE",
			body: JSON.stringify({ all: true })
		});
	} catch (err) {
		logger.warn(`[eliza][reset] Failed to clear trajectories before reset: ${err instanceof Error ? err.message : String(err)}`);
	}
}
async function clearCompatPgliteDataDir(runtime, config) {
	if (typeof runtime?.stop === "function") await runtime.stop();
	const dataDir = resolveCompatPgliteDataDir(config);
	if (path.basename(dataDir) !== ".elizadb") {
		logger.warn(`[eliza][reset] Refusing to delete unexpected PGlite dir: ${dataDir}`);
		return;
	}
	try {
		if (fs.existsSync(dataDir)) {
			fs.rmSync(dataDir, {
				recursive: true,
				force: true
			});
			logger.info(`[eliza][reset] Deleted PGlite data dir (GGUF models preserved): ${dataDir}`);
		}
	} catch (err) {
		logger.warn(`[eliza][reset] Failed to delete PGlite data dir: ${err instanceof Error ? err.message : String(err)}`);
	}
}
function resolveCompatStatusAgentName(state) {
	if (state.pendingAgentName) return state.pendingAgentName;
	if (state.current) return null;
	return getConfiguredCompatAgentName();
}
function mergeEmbeddingIntoStatusPayload(payload) {
	const aug = getStartupEmbeddingAugmentation();
	if (!aug) return;
	const existing = payload.startup;
	payload.startup = {
		...existing && typeof existing === "object" && !Array.isArray(existing) ? { ...existing } : {
			phase: "embedding-warmup",
			attempt: 0
		},
		...aug
	};
}
function rewriteCompatStatusBody(bodyText, state) {
	const agentName = resolveCompatStatusAgentName(state);
	try {
		const parsed = JSON.parse(bodyText);
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return bodyText;
		const payload = parsed;
		mergeEmbeddingIntoStatusPayload(payload);
		const upstreamPendingRestartReasons = Array.isArray(payload.pendingRestartReasons) ? payload.pendingRestartReasons.filter((value) => typeof value === "string") : [];
		const pendingRestartReasons = Array.from(new Set([...upstreamPendingRestartReasons, ...state.pendingRestartReasons]));
		if (pendingRestartReasons.length > 0 || typeof payload.pendingRestart === "boolean") {
			payload.pendingRestart = pendingRestartReasons.length > 0;
			payload.pendingRestartReasons = pendingRestartReasons;
		}
		if (!agentName) return JSON.stringify(payload);
		if (payload.agentName === agentName) return JSON.stringify(payload);
		return JSON.stringify({
			...payload,
			agentName
		});
	} catch {
		return bodyText;
	}
}
function patchCompatStatusResponse(req, res, state) {
	const method = (req.method ?? "GET").toUpperCase();
	const pathname = new URL(req.url ?? "/", "http://localhost").pathname;
	if (method !== "GET" || pathname !== "/api/status") return;
	const originalEnd = res.end.bind(res);
	res.end = ((chunk, encoding, cb) => {
		let resolvedEncoding;
		let resolvedCallback;
		if (typeof encoding === "function") resolvedCallback = encoding;
		else {
			resolvedEncoding = encoding;
			resolvedCallback = cb;
		}
		if (chunk == null) return resolvedCallback ? originalEnd(resolvedCallback) : originalEnd();
		return originalEnd(rewriteCompatStatusBody(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString(resolvedEncoding ?? "utf8"), state), "utf8", resolvedCallback);
	});
}
/**
* Load config from disk and backfill `cloud.apiKey` from sealed secrets when the
* user is still linked to Eliza Cloud but a stale write dropped the key.
*/
function resolveCloudConfig(runtime) {
	const config = loadElizaConfig$1();
	const cloudRec = config.cloud && typeof config.cloud === "object" ? config.cloud : void 0;
	if (isElizaSettingsDebugEnabled()) logger.debug(`[eliza][settings][compat] resolveCloudConfig disk cloud=${JSON.stringify(settingsDebugCloudSummary(cloudRec))} topKeys=${Object.keys(config).sort().join(",")}`);
	if (resolveLinkedAccountsInConfig(config)?.elizacloud?.status === "unlinked") {
		if (isElizaSettingsDebugEnabled()) logger.debug("[eliza][settings][compat] resolveCloudConfig skip backfill (linkedAccounts.elizacloud.status===unlinked)");
		return config;
	}
	if (!config.cloud?.apiKey) {
		const backfillKey = getCloudSecret("ELIZAOS_CLOUD_API_KEY") || process.env.ELIZAOS_CLOUD_API_KEY || runtime?.character?.secrets?.ELIZAOS_CLOUD_API_KEY;
		if (backfillKey) {
			if (isElizaSettingsDebugEnabled()) logger.debug("[eliza][settings][compat] resolveCloudConfig backfilling cloud.apiKey from env/secrets/runtime");
			if (!config.cloud) config.cloud = {};
			config.cloud.apiKey = backfillKey;
			try {
				saveElizaConfig$1(config);
				logger.info("[cloud] Backfilled missing cloud.apiKey to config file");
			} catch {}
		}
	}
	if (isElizaSettingsDebugEnabled()) {
		const outCloud = config.cloud;
		logger.debug(`[eliza][settings][compat] resolveCloudConfig → return cloud=${JSON.stringify(settingsDebugCloudSummary(outCloud))}`);
	}
	return config;
}
function buildCloudLoginSyncPatch(config) {
	const cloud = config.cloud && typeof config.cloud === "object" ? config.cloud : void 0;
	const apiKey = typeof cloud?.apiKey === "string" ? cloud.apiKey.trim() : "";
	if (!apiKey) return null;
	const nextCloud = { apiKey };
	const baseUrl = typeof cloud?.baseUrl === "string" ? cloud.baseUrl.trim() : "";
	if (baseUrl) nextCloud.baseUrl = baseUrl;
	return {
		cloud: nextCloud,
		linkedAccounts: { elizacloud: {
			status: "linked",
			source: "api-key"
		} }
	};
}
async function syncCloudLoginToUpstreamConfigState(req, config) {
	const cloudLoginPatch = buildCloudLoginSyncPatch(config);
	if (!cloudLoginPatch) return;
	if (isElizaSettingsDebugEnabled()) logger.debug(`[eliza][settings][compat] cloud login → loopback PUT /api/config patch=${JSON.stringify(sanitizeForSettingsDebug(cloudLoginPatch))}`);
	try {
		await compatLoopbackRequest(req, "/api/config", {
			method: "PUT",
			body: JSON.stringify(cloudLoginPatch)
		});
		if (isElizaSettingsDebugEnabled()) logger.debug("[eliza][settings][compat] cloud login loopback sync OK");
	} catch (err) {
		logger.warn(`[eliza][cloud/login] Failed to sync cloud login to upstream state: ${err instanceof Error ? err.message : String(err)}`);
	}
}
async function handleCompatRoute(req, res, state) {
	const method = (req.method ?? "GET").toUpperCase();
	const url = new URL(req.url ?? "/", "http://localhost");
	if (url.pathname.startsWith("/api/cloud/compat/") || url.pathname.startsWith("/api/cloud/v1/")) {
		if (!await ensureRouteAuthorized(req, res, state)) return true;
		return handleCloudCompatRoute(req, res, url.pathname, method, {
			config: resolveCloudConfig(state.current),
			runtime: state.current
		});
	}
	if (url.pathname.startsWith("/api/cloud/billing/")) {
		if (!await ensureRouteAuthorized(req, res, state)) return true;
		return handleCloudBillingRoute(req, res, url.pathname, method, {
			config: resolveCloudConfig(state.current),
			runtime: state.current
		});
	}
	if (await handleDevCompatRoutes(req, res, state)) return true;
	if (await handleAuthBootstrapRoutes(req, res, state)) return true;
	if (await handleAuthSessionRoutes(req, res, state)) return true;
	if (await handleAuthPairingCompatRoutes(req, res, state)) return true;
	if (await handleComputerUseCompatRoutes(req, res, state)) return true;
	if (await handleLocalInferenceCompatRoutes(req, res, state)) return true;
	if (await handleAutomationsCompatRoutes(req, res, state)) return true;
	if (url.pathname.startsWith("/api/n8n/")) {
		if (!await ensureRouteAuthorized(req, res, state)) return true;
		return handleN8nRoutes({
			req,
			res,
			method,
			pathname: url.pathname,
			config: loadElizaConfig$1(),
			runtime: state.current,
			json: (_res, body, status = 200) => {
				sendJson$2(res, status, body);
			}
		});
	}
	if (url.pathname === "/api/github/token") {
		if (!await ensureRouteAuthorized(req, res, state)) return true;
		return handleGitHubRoutes({
			req,
			res,
			method,
			pathname: url.pathname,
			json: (status, body) => {
				sendJson$2(res, status, body);
			}
		});
	}
	if (method === "POST" && url.pathname === "/api/tts/cloud") {
		if (!await ensureRouteAuthorized(req, res, state)) return true;
		return await handleCloudTtsPreviewRoute(req, res);
	}
	if (method === "POST" && url.pathname === "/api/tts/elevenlabs") return false;
	if (await handleWorkbenchCompatRoutes(req, res, state)) return true;
	if (await handleWalletMarketOverviewRoute(req, res)) return true;
	if (url.pathname.startsWith("/api/secrets/")) {
		if (!await ensureRouteAuthorized(req, res, state)) return true;
		if (await handleSecretsInventoryRoute(req, res, url.pathname, method)) return true;
		if (await handleSecretsManagerRoute(req, res, url.pathname, method)) return true;
	}
	if (url.pathname.startsWith("/api/cloud/") && !url.pathname.startsWith("/api/cloud/compat/") && !url.pathname.startsWith("/api/cloud/billing/")) {
		if (!(isCloudProvisioned() && method === "GET" && url.pathname === "/api/cloud/status") && !await ensureRouteAuthorized(req, res, state)) return true;
		const config = resolveCloudConfig(state.current);
		if (url.pathname === "/api/cloud/status" || url.pathname === "/api/cloud/credits") return handleCloudStatusRoutes({
			req,
			res,
			method,
			pathname: url.pathname,
			config,
			runtime: state.current,
			json: (_res, body, status = 200) => {
				sendJson$2(res, status, body);
			}
		});
		const handled = await handleCloudRoute$1(req, res, url.pathname, method, {
			config,
			runtime: state.current,
			cloudManager: null
		});
		if (handled && (method === "POST" && url.pathname === "/api/cloud/login/persist" || method === "GET" && url.pathname.startsWith("/api/cloud/login/status"))) await syncCloudLoginToUpstreamConfigState(req, config);
		if (handled && method === "POST" && url.pathname === "/api/cloud/disconnect") {
			const disconnectPatch = {
				cloud: {
					enabled: false,
					apiKey: null
				},
				serviceRouting: {
					llmText: null,
					tts: null,
					media: null,
					embeddings: null,
					rpc: null
				},
				linkedAccounts: { elizacloud: {
					status: "unlinked",
					source: "api-key"
				} }
			};
			if (isElizaSettingsDebugEnabled()) logger.debug(`[eliza][settings][compat] POST /api/cloud/disconnect → loopback PUT /api/config patch=${JSON.stringify(sanitizeForSettingsDebug(disconnectPatch))}`);
			try {
				await compatLoopbackRequest(req, "/api/config", {
					method: "PUT",
					body: JSON.stringify(disconnectPatch)
				});
				if (isElizaSettingsDebugEnabled()) logger.debug("[eliza][settings][compat] POST /api/cloud/disconnect loopback sync OK");
			} catch (err) {
				logger.warn(`[eliza][cloud/disconnect] Failed to sync cloud disable to upstream state: ${err instanceof Error ? err.message : String(err)}`);
			}
		}
		return handled;
	}
	if (method === "POST" && url.pathname === "/api/agent/reset") {
		if (!ensureCompatSensitiveRouteAuthorized(req, res)) {
			logger.warn("[eliza][reset] POST /api/agent/reset rejected (sensitive route not authorized)");
			return true;
		}
		try {
			logger.info("[eliza][reset] POST /api/agent/reset: loading config, will clear onboarding state, persisted provider config, and cloud keys (GGUF / MODELS_DIR untouched)");
			const config = loadElizaConfig$1();
			await clearCompatRuntimeStateViaApi(req);
			await clearCompatPgliteDataDir(state.current, config);
			state.current = null;
			clearPersistedOnboardingConfig(config);
			saveElizaConfig$1(config);
			clearCloudSecrets();
			try {
				await deleteWalletSecretsFromOsStore();
			} catch (osErr) {
				logger.warn(`[eliza][reset] OS wallet store cleanup: ${osErr instanceof Error ? osErr.message : String(osErr)}`);
			}
			logger.info("[eliza][reset] POST /api/agent/reset: eliza.json saved — renderer should restart API process if embedded/external dev");
			sendJson$2(res, 200, { ok: true });
		} catch (err) {
			logger.warn(`[eliza][reset] POST /api/agent/reset failed: ${err instanceof Error ? err.message : String(err)}`);
			sendJson$2(res, 500, { error: err instanceof Error ? err.message : "Reset failed" });
		}
		return true;
	}
	if (await handlePluginsCompatRoutes(req, res, state)) return true;
	if (await handleCatalogRoutes(req, res, state)) return true;
	if (await handleOnboardingCompatRoute(req, res, state)) return true;
	const uiSpecMatch = method === "GET" && url.pathname.match(/^\/api\/plugins\/([^/]+)\/ui-spec$/);
	if (uiSpecMatch) {
		if (!await ensureRouteAuthorized(req, res, state)) return true;
		const pluginId = decodeURIComponent(uiSpecMatch[1]);
		const { buildPluginConfigUiSpec } = await Promise.resolve().then(() => (init_plugin_ui_spec(), plugin_ui_spec_exports));
		const { buildPluginListResponse } = await Promise.resolve().then(() => (init_plugins_compat_routes(), plugins_compat_routes_exports));
		const plugin = buildPluginListResponse(state.current).plugins.find((p) => p.id === pluginId);
		if (!plugin) {
			sendJson$2(res, 404, { error: `Plugin "${pluginId}" not found` });
			return true;
		}
		sendJson$2(res, 200, { spec: buildPluginConfigUiSpec(plugin) });
		return true;
	}
	if (method === "GET" && url.pathname === "/api/agents") {
		if (!await ensureRouteAuthorized(req, res, state)) return true;
		const character = buildCharacterFromConfig$1(loadElizaConfig$1());
		sendJson$2(res, 200, { agents: [{
			id: state.current?.agentId ?? character.id ?? "00000000-0000-0000-0000-000000000000",
			name: character.name,
			status: state.current ? "running" : "stopped"
		}] });
		return true;
	}
	if (method === "GET" && url.pathname === "/api/config") {
		if (!await ensureRouteAuthorized(req, res, state)) return true;
		sendJson$2(res, 200, filterConfigEnvForResponse(loadElizaConfig$1()));
		return true;
	}
	return handleDatabaseRowsCompatRoute(req, res, state);
}
async function handleElizaCompatRoute(req, res, state) {
	return await handleCompatRoute(req, res, state);
}
function patchHttpCreateServerForCompat(state) {
	const originalCreateServer = http.createServer.bind(http);
	http.createServer = ((...args) => {
		const [firstArg, secondArg] = args;
		const listener = typeof firstArg === "function" ? firstArg : typeof secondArg === "function" ? secondArg : void 0;
		if (!listener) return originalCreateServer(...args);
		const wrappedListener = async (req, res) => {
			syncAppEnvToEliza();
			syncElizaEnvAliases();
			ensureCloudTtsApiKeyAlias();
			mirrorCompatHeaders(req);
			if (state) patchCompatStatusResponse(req, res, state);
			const originHeader = req.headers.origin ?? "";
			const corsAllowedPorts = new Set(getCorsAllowedPorts());
			const localPort = req.socket.localPort;
			if (typeof localPort === "number") corsAllowedPorts.add(String(localPort));
			const allowOrigin = (() => {
				if (originHeader !== "") return isAllowedOrigin(originHeader, corsAllowedPorts) ? originHeader : null;
				const ref = req.headers.referer;
				if (!ref) return null;
				try {
					const u = new URL(ref);
					return isAllowedOrigin(ref, corsAllowedPorts) ? u.origin : null;
				} catch {
					return null;
				}
			})();
			if (originHeader !== "" && !allowOrigin) {
				res.writeHead(403, { "Content-Type": "application/json" });
				res.end(JSON.stringify({ error: "cors_origin_denied" }));
				return;
			}
			if (allowOrigin) {
				res.setHeader("Access-Control-Allow-Origin", allowOrigin);
				res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS");
				res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-API-Token, X-Api-Key, X-ElizaOS-Client-Id, X-ElizaOS-UI-Language, X-ElizaOS-Token, X-Eliza-Export-Token, X-Eliza-Terminal-Token, X-Eliza-CSRF");
				res.setHeader("Access-Control-Allow-Credentials", "true");
			}
			if (req.method === "OPTIONS") {
				res.statusCode = 204;
				res.end();
				return;
			}
			res.on("finish", () => {
				syncElizaEnvAliases();
				syncCompatConfigFiles();
			});
			if (state) {
				const pathname = new URL(req.url ?? "/", "http://localhost").pathname;
				if (pathname.startsWith("/api/database") || pathname.startsWith("/api/trajectories")) await ensureRuntimeSqlCompatibility(state.current);
				try {
					if (await handleCompatRoute(req, res, state)) return;
				} catch (err) {
					logger.error({
						error: err instanceof Error ? err.message : String(err),
						stack: err instanceof Error ? err.stack : void 0
					}, "[CompatApiServer] Unhandled compat route error");
					if (!res.headersSent) {
						res.statusCode = 500;
						res.setHeader("content-type", "application/json; charset=utf-8");
						res.end(JSON.stringify({ error: "Internal server error" }));
					}
					return;
				}
			}
			Promise.resolve(listener(req, res)).catch((err) => {
				logger.error({
					error: err instanceof Error ? err.message : String(err),
					stack: err instanceof Error ? err.stack : void 0
				}, "[CompatApiServer] Upstream listener error");
				if (!res.headersSent) {
					res.statusCode = 500;
					res.setHeader("content-type", "application/json; charset=utf-8");
					res.end(JSON.stringify({ error: "Internal server error" }));
				}
			});
		};
		const created = typeof firstArg === "function" ? originalCreateServer(wrappedListener) : originalCreateServer(firstArg, wrappedListener);
		deviceBridge.attachToHttpServer(created).catch((err) => {
			logger.warn("[compat] Failed to attach device-bridge WS handler:", err instanceof Error ? err.message : String(err));
		});
		return created;
	});
	return () => {
		http.createServer = originalCreateServer;
	};
}
async function startApiServer$1(...args) {
	syncAppEnvToEliza();
	syncElizaEnvAliases();
	ensureCloudTtsApiKeyAlias();
	hydrateWalletOsStoreFlagFromConfig();
	await hydrateWalletKeysFromNodePlatformSecureStore();
	await initStewardWalletCache();
	const compatState = {
		current: args[0]?.runtime ?? null,
		pendingAgentName: null,
		pendingRestartReasons: []
	};
	const restoreCreateServer = patchHttpCreateServerForCompat(compatState);
	try {
		if (compatState.current) {
			await ensureRuntimeSqlCompatibility(compatState.current);
			await (await lazyEnsureTTS())(compatState.current);
		}
		const server = await startApiServer(...args);
		if (typeof server.port === "number" && server.port > 0) setResolvedLoopbackPort(server.port);
		const originalUpdateRuntime = server.updateRuntime;
		server.updateRuntime = (runtime) => {
			compatState.current = runtime;
			clearCompatRuntimeRestart(compatState);
			originalUpdateRuntime(runtime);
			(async () => {
				try {
					await ensureRuntimeSqlCompatibility(runtime);
				} catch (err) {
					logger.error(`[eliza][runtime] SQL compatibility init failed: ${err instanceof Error ? err.message : String(err)}`);
				}
				try {
					await (await lazyEnsureTTS())(runtime);
				} catch (err) {
					logger.warn(`[eliza][runtime] TTS init failed (non-critical): ${err instanceof Error ? err.message : String(err)}`);
				}
			})();
		};
		syncElizaEnvAliases();
		syncCompatConfigFiles();
		return server;
	} finally {
		restoreCreateServer();
	}
}
var lazyEnsureTTS, _resolvedLoopbackPort;
var init_server = __esmMin((() => {
	init_auth$1();
	init_automations_compat_routes();
	init_compat_route_shared();
	init_response();
	init_server_cloud_tts();
	init_server_config_filter();
	init_server_cors();
	init_server_html();
	init_server_security();
	init_server_startup();
	init_server_wallet_trade();
	init_build_character_from_config();
	init_device_bridge();
	init_sql_compat();
	init_auth_bootstrap_routes();
	init_auth_pairing_compat_routes();
	init_auth_session_routes();
	init_catalog_routes();
	init_cloud_routes();
	init_cloud_status_routes();
	init_computer_use_compat_routes();
	init_database_rows_compat_routes();
	init_dev_compat_routes();
	init_github_routes();
	init_local_inference_compat_routes();
	init_n8n_routes();
	init_onboarding_compat_routes();
	init_plugins_compat_routes();
	init_secrets_inventory_routes();
	init_secrets_manager_routes();
	init_server_onboarding_compat();
	init_wallet_market_overview_route();
	init_workbench_compat_routes();
	init_env();
	init_startup_overlay();
	init_hydrate_wallet_keys_from_platform_store();
	init_wallet_os_store_actions();
	init_cloud_secrets();
	createRequire(import.meta.url);
	lazyEnsureTTS = () => Promise.resolve().then(() => (init_ensure_text_to_speech_handler(), ensure_text_to_speech_handler_exports)).then((m) => m.ensureTextToSpeechHandler);
	_resolvedLoopbackPort = null;
}));

//#endregion
//#region node_modules/.bun/@elizaos+app-core@2.0.0-alpha.537+72829346cb4c43b1/node_modules/@elizaos/app-core/packages/app-core/src/runtime/eliza.js
var eliza_exports = /* @__PURE__ */ __exportAll({
	CHANNEL_PLUGIN_MAP: () => CHANNEL_PLUGIN_MAP$1,
	CUSTOM_PLUGINS_DIRNAME: () => CUSTOM_PLUGINS_DIRNAME,
	applyCloudConfigToEnv: () => applyCloudConfigToEnv$1,
	applyN8nConfigToEnv: () => applyN8nConfigToEnv$1,
	attemptPgliteAutoReset: () => attemptPgliteAutoReset,
	bootElizaRuntime: () => bootElizaRuntime$1,
	collectPluginNames: () => collectPluginNames$1,
	getPgliteRecoveryRetrySkipPlugins: () => getPgliteRecoveryRetrySkipPlugins,
	resolvePackageEntry: () => resolvePackageEntry,
	scanDropInPlugins: () => scanDropInPlugins,
	shutdownRuntime: () => shutdownRuntime$1,
	startEliza: () => startEliza$1
});
function isAutonomyService(value) {
	return typeof value === "object" && value !== null && "enableAutonomy" in value && typeof value.enableAutonomy === "function";
}
function getAutonomyService(runtime) {
	const svc = runtime.getService("AUTONOMY") ?? runtime.getService("autonomy");
	if (isAutonomyService(svc)) return svc;
	return null;
}
async function startAndRegisterAutonomyService(runtime) {
	const service = await AutonomyService.start(runtime);
	runtime.services.set("AUTONOMY", [service]);
	return service;
}
function syncBrandEnvAliases() {
	syncElizaEnvAliases();
	syncAppEnvToEliza();
}
function collectPluginNames$1(...args) {
	syncBrandEnvAliases();
	const [config] = args;
	const result = collectPluginNames(...args);
	if (result.has(AGENT_ORCHESTRATOR_PLUGIN) && !isEdgeTtsDisabled(config) && !result.has(EDGE_TTS_PLUGIN)) result.add(EDGE_TTS_PLUGIN);
	syncBrandEnvAliases();
	return result;
}
function applyCloudConfigToEnv$1(...args) {
	syncBrandEnvAliases();
	const result = applyCloudConfigToEnv(...args);
	syncBrandEnvAliases();
	return result;
}
function applyN8nConfigToEnv$1(...args) {
	syncBrandEnvAliases();
	if (isNativeServerPlatform() || isMobilePlatform()) {
		const [config, agentId] = args;
		const result = applyN8nConfigToEnv(config?.n8n?.localEnabled === false ? config : {
			...config,
			n8n: {
				...config.n8n ?? {},
				localEnabled: false
			}
		}, agentId);
		syncBrandEnvAliases();
		return result;
	}
	const result = applyN8nConfigToEnv(...args);
	syncBrandEnvAliases();
	return result;
}
async function ensureAutonomyBootstrapContext(runtime) {
	const runtimeWithCompat = runtime;
	const adapter = runtime.adapter;
	const autonomousRoomId = stringToUuid(`autonomy-room-${runtime.agentId}`);
	await runtimeWithCompat.ensureWorldExists?.({
		id: AUTONOMY_WORLD_ID,
		name: "Autonomy World",
		agentId: runtime.agentId,
		messageServerId: AUTONOMY_MESSAGE_SERVER_ID,
		metadata: {
			type: "autonomy",
			description: "World for autonomous agent thinking"
		}
	});
	await runtimeWithCompat.ensureRoomExists?.({
		id: autonomousRoomId,
		name: "Autonomous Thoughts",
		worldId: AUTONOMY_WORLD_ID,
		source: "autonomy-service",
		type: ChannelType.SELF,
		metadata: {
			source: "autonomy-service",
			description: "Room for autonomous agent thinking"
		}
	});
	const autonomyEntity = {
		id: AUTONOMY_ENTITY_ID,
		names: ["Autonomy"],
		agentId: runtime.agentId,
		metadata: {
			type: "autonomy",
			description: "Dedicated entity for autonomy service prompts"
		}
	};
	const existingEntity = await runtimeWithCompat.getEntityById?.(AUTONOMY_ENTITY_ID) ?? null;
	if (!existingEntity) {
		if (!await runtimeWithCompat.createEntity?.(autonomyEntity) && adapter?.upsertEntities) await adapter.upsertEntities([autonomyEntity]);
	} else if (existingEntity.agentId !== runtime.agentId) {
		if (runtimeWithCompat.updateEntity) await runtimeWithCompat.updateEntity({
			...existingEntity,
			agentId: runtime.agentId
		});
		else if (adapter?.upsertEntities) await adapter.upsertEntities([{
			id: existingEntity.id ?? AUTONOMY_ENTITY_ID,
			names: existingEntity.names && existingEntity.names.length > 0 ? existingEntity.names : autonomyEntity.names,
			agentId: runtime.agentId,
			metadata: {
				...autonomyEntity.metadata,
				...existingEntity.metadata ?? {}
			}
		}]);
	}
	if (runtimeWithCompat.ensureParticipantInRoom) {
		await runtimeWithCompat.ensureParticipantInRoom(runtime.agentId, autonomousRoomId);
		await runtimeWithCompat.ensureParticipantInRoom(AUTONOMY_ENTITY_ID, autonomousRoomId);
	} else if (runtimeWithCompat.addParticipant) {
		await runtimeWithCompat.addParticipant(runtime.agentId, autonomousRoomId);
		await runtimeWithCompat.addParticipant(AUTONOMY_ENTITY_ID, autonomousRoomId);
	}
}
function isPlugin(value) {
	return typeof value === "object" && value !== null && "name" in value && typeof value.name === "string";
}
function resolvePluginExport(module, exportName) {
	if (exportName) {
		const plugin = module[exportName];
		if (isPlugin(plugin)) return plugin;
		throw new Error(`Missing plugin export "${exportName}"`);
	}
	const defaultExport = module.default;
	if (isPlugin(defaultExport)) return defaultExport;
	for (const value of Object.values(module)) if (isPlugin(value)) return value;
	throw new Error("No plugin export found");
}
async function loadAppRoutePluginFromSpecifier(specifier, exportName) {
	return resolvePluginExport(await import(__rewriteRelativeImportExtension$1(
		/* webpackIgnore: true */
		specifier
	)), exportName);
}
function getRegistryAppRoutePluginLoaders() {
	return getApps(loadRegistry()).flatMap((app) => {
		const routePlugin = app.launch.routePlugin;
		if (!routePlugin) return [];
		return [{
			id: app.npmName ?? app.id,
			load: () => loadAppRoutePluginFromSpecifier(routePlugin.specifier, routePlugin.exportName)
		}];
	});
}
function getAppRoutePluginLoaders() {
	const byId = /* @__PURE__ */ new Map();
	for (const entry of getRegistryAppRoutePluginLoaders()) byId.set(entry.id, entry);
	for (const entry of listAppRoutePluginLoaders()) byId.set(entry.id, entry);
	return [...byId.values()];
}
async function registerAppRoutePlugins(runtime) {
	for (const { id, load } of getAppRoutePluginLoaders()) try {
		const plugin = await load();
		if (plugin.routes?.length) for (const route of plugin.routes) {
			const routePath = route.path.startsWith("/") ? route.path : `/${route.path}`;
			runtime.routes.push({
				...route,
				path: routePath
			});
		}
		logger.info(`[eliza] Registered app route plugin: ${plugin.name} (${plugin.routes?.length ?? 0} routes)`);
	} catch (err) {
		logger.warn(`[eliza] Failed to register app route plugin ${id}: ${err instanceof Error ? err.message : String(err)}`);
	}
}
async function registerTrainingRuntimeHooks(runtime) {
	let hookMod;
	try {
		hookMod = await import(__rewriteRelativeImportExtension$1(TRAINING_RUNTIME_HOOKS_SPECIFIER));
	} catch (err) {
		logger.warn(`[eliza] @elizaos/app-training not installed, skipping runtime hooks: ${err instanceof Error ? err.message : String(err)}`);
		return;
	}
	if (!hookMod.registerTrainingRuntimeHooks) throw new Error(`[eliza] ${TRAINING_RUNTIME_HOOKS_SPECIFIER} did not export registerTrainingRuntimeHooks`);
	await hookMod.registerTrainingRuntimeHooks(runtime);
}
async function repairRuntimeAfterBoot(runtime) {
	await ensureRuntimeSqlCompatibility(runtime);
	if (isMobilePlatform()) {
		if (shouldEnableMobileLocalInference()) await ensureLocalInferenceHandler(runtime);
		logger.info("[eliza] Mobile platform detected — skipping desktop-only boot helpers");
		return runtime;
	}
	await ensureTextToSpeechHandler(runtime);
	await ensureLocalInferenceHandler(runtime);
	await ensureAutonomyBootstrapContext(runtime);
	await registerAppRoutePlugins(runtime);
	await registerTrainingRuntimeHooks(runtime);
	if (!runtime.getService("AUTONOMY")) try {
		await startAndRegisterAutonomyService(runtime);
		logger.info("[eliza] AutonomyService started after SQL compatibility repair");
	} catch (error) {
		throw new Error(`[eliza] AutonomyService restart after SQL compatibility repair failed: ${error instanceof Error ? error.message : String(error)}`);
	}
	{
		const autonomySvc = getAutonomyService(runtime);
		if (autonomySvc) try {
			await autonomySvc.enableAutonomy();
			logger.info("[eliza] AutonomyService enabled — trigger instructions will be processed");
		} catch (err) {
			throw new Error(`[eliza] Failed to enable autonomy loop: ${err instanceof Error ? err.message : String(err)}`);
		}
	}
	if (shouldStartTelegramStandaloneBot()) await ensureTelegramBotPolling(runtime);
	else stopTelegramBotPolling("passive-lifeops-connectors");
	await ensureN8nAuthBridge(runtime);
	await ensureN8nAutoStart(runtime);
	await ensureN8nDispatchService(runtime);
	await ensureTriggerEventBridge(runtime);
	await ensureN8nRuntimeContextProvider(runtime);
	await ensureConnectorTargetCatalog(runtime);
	return runtime;
}
async function ensureN8nAuthBridge(runtime) {
	if (_n8nAuthBridge) {
		try {
			_n8nAuthBridge.stop();
		} catch {}
		_n8nAuthBridge = null;
	}
	try {
		const [{ startN8nAuthBridge }, config] = await Promise.all([Promise.resolve().then(() => (init_n8n_auth_bridge(), n8n_auth_bridge_exports)), Promise.resolve(loadElizaConfig())]);
		_n8nAuthBridge = startN8nAuthBridge(runtime, config, { getConfig: () => loadElizaConfig() });
		logger.info("[eliza] n8n auth bridge armed");
	} catch (err) {
		logger.warn(`[eliza] Failed to start n8n auth bridge: ${err instanceof Error ? err.message : String(err)}`);
	}
}
async function ensureN8nAutoStart(runtime) {
	if (_n8nAutoStart) {
		try {
			await _n8nAutoStart.stop();
		} catch {}
		_n8nAutoStart = null;
	}
	try {
		const [{ startN8nAutoStart }, config] = await Promise.all([Promise.resolve().then(() => (init_n8n_autostart(), n8n_autostart_exports)), Promise.resolve(loadElizaConfig())]);
		_n8nAutoStart = startN8nAutoStart(runtime, config, { getConfig: () => loadElizaConfig() });
		logger.info("[eliza] n8n autostart armed");
	} catch (err) {
		logger.warn(`[eliza] Failed to start n8n autostart: ${err instanceof Error ? err.message : String(err)}`);
	}
}
async function ensureN8nDispatchService(runtime) {
	if (_n8nDispatch) {
		try {
			runtime.services.delete("N8N_DISPATCH");
		} catch {}
		_n8nDispatch = null;
	}
	try {
		const { createN8nDispatchService } = await Promise.resolve().then(() => (init_n8n_dispatch(), n8n_dispatch_exports));
		const dispatchInstance = createN8nDispatchService({
			runtime,
			getConfig: () => loadElizaConfig()
		});
		_n8nDispatch = dispatchInstance;
		const serviceEntry = {
			execute: dispatchInstance.execute,
			stop: async () => {},
			capabilityDescription: "Executes n8n workflows by id."
		};
		runtime.services.set("N8N_DISPATCH", [serviceEntry]);
		logger.info("[eliza] n8n dispatch service registered");
	} catch (err) {
		logger.warn(`[eliza] Failed to register n8n dispatch service: ${err instanceof Error ? err.message : String(err)}`);
	}
}
async function ensureTriggerEventBridge(runtime) {
	if (_triggerEventBridge) {
		try {
			_triggerEventBridge.stop();
		} catch {}
		_triggerEventBridge = null;
	}
	try {
		const { startTriggerEventBridge } = await Promise.resolve().then(() => (init_trigger_event_bridge(), trigger_event_bridge_exports));
		_triggerEventBridge = startTriggerEventBridge(runtime);
		logger.info("[eliza] trigger event bridge armed");
	} catch (err) {
		logger.warn(`[eliza] Failed to start trigger event bridge: ${err instanceof Error ? err.message : String(err)}`);
	}
}
async function ensureN8nRuntimeContextProvider(runtime) {
	if (_n8nRuntimeContextProvider) {
		try {
			_n8nRuntimeContextProvider.stop();
		} catch {}
		_n8nRuntimeContextProvider = null;
	}
	const { createDiscordSourceCache } = await Promise.resolve().then(() => (init_discord_target_source(), discord_target_source_exports));
	_discordEnumerationCache = createDiscordSourceCache();
	try {
		const { startElizaN8nRuntimeContextProvider } = await Promise.resolve().then(() => (init_n8n_runtime_context_provider(), n8n_runtime_context_provider_exports));
		const credProviderInstance = (runtime.services.get("n8n_credential_provider") ?? [])[0];
		_n8nRuntimeContextProvider = startElizaN8nRuntimeContextProvider(runtime, {
			getConfig: () => loadElizaConfig(),
			credProvider: credProviderInstance && typeof credProviderInstance.resolve === "function" ? credProviderInstance : void 0,
			discordCache: _discordEnumerationCache ?? void 0
		});
		logger.info("[eliza] n8n runtime-context provider registered");
	} catch (err) {
		logger.warn(`[eliza] Failed to register n8n runtime-context provider: ${err instanceof Error ? err.message : String(err)}`);
	}
}
async function ensureConnectorTargetCatalog(runtime) {
	if (_connectorTargetCatalog) {
		try {
			_connectorTargetCatalog.stop();
		} catch {}
		_connectorTargetCatalog = null;
	}
	try {
		const { createElizaConnectorTargetCatalog } = await Promise.resolve().then(() => (init_connector_target_catalog(), connector_target_catalog_exports));
		const catalog = createElizaConnectorTargetCatalog({
			getConfig: () => loadElizaConfig(),
			discordCache: _discordEnumerationCache ?? void 0,
			logger: { warn: runtime.logger.warn?.bind(runtime.logger) }
		});
		runtime.services.set(CONNECTOR_TARGET_CATALOG_SERVICE_TYPE, [catalog]);
		_connectorTargetCatalog = { stop: () => {
			try {
				runtime.services.delete(CONNECTOR_TARGET_CATALOG_SERVICE_TYPE);
			} catch {}
		} };
		logger.info("[eliza] connector-target-catalog registered");
	} catch (err) {
		logger.warn(`[eliza] Failed to register connector-target-catalog: ${err instanceof Error ? err.message : String(err)}`);
	}
}
function stopTelegramBotPolling(reason) {
	if (!_telegramBot) return;
	try {
		_telegramBot.stop(reason);
	} catch {}
	_telegramBot = null;
}
async function ensureTelegramBotPolling(runtime) {
	if (_telegramBot) {
		stopTelegramBotPolling("restart");
		await new Promise((r) => setTimeout(r, 1e3));
	}
	const botToken = process$1.env.TELEGRAM_BOT_TOKEN;
	if (!botToken) return;
	try {
		const { Telegraf } = await import("telegraf");
		const bot = new Telegraf(botToken, { telegram: { apiRoot: process$1.env.TELEGRAM_API_ROOT || "https://api.telegram.org" } });
		const char = runtime.character ?? {};
		const bioText = Array.isArray(char.bio) ? char.bio.join(" ") : char.bio ?? "";
		const loreText = Array.isArray(char.lore) ? char.lore.join(" ") : "";
		const styleText = (() => {
			const s = char.style;
			if (!s) return "";
			const parts = [];
			if (s.all?.length) parts.push(s.all.join(" "));
			if (s.chat?.length) parts.push(s.chat.join(" "));
			return parts.join(" ");
		})();
		const systemPrompt = [
			`You are ${char.name}.`,
			char.system ?? "",
			bioText ? `Bio: ${bioText}` : "",
			loreText ? `Lore: ${loreText}` : "",
			styleText ? `Style: ${styleText}` : "",
			"Respond in character. Keep responses concise for chat."
		].filter(Boolean).join("\n");
		const chatHistories = /* @__PURE__ */ new Map();
		bot.on("message", async (ctx) => {
			try {
				const text = ctx.message?.text;
				if (!text) return;
				const chatId = ctx.message.chat?.id ?? 0;
				const allowedChats = process$1.env.TELEGRAM_ALLOWED_CHATS;
				if (allowedChats && allowedChats.trim() !== "" && allowedChats.trim() !== "[]") try {
					if (!JSON.parse(allowedChats).includes(String(chatId))) return;
				} catch {
					return;
				}
				const username = ctx.message.from?.username ?? ctx.message.from?.first_name ?? "Unknown";
				logger.info(`[eliza] Telegram message from @${username}: ${text.substring(0, 80)}`);
				try {
					const telegramRoomId = stringToUuid(`telegram:${chatId}`);
					const entityId = stringToUuid(`telegram-user:${username}:${chatId}`);
					const memory = {
						id: stringToUuid(`telegram:${chatId}:${username}:${Date.now()}`),
						entityId,
						agentId: runtime.agentId,
						roomId: telegramRoomId,
						content: {
							text,
							source: "telegram"
						},
						createdAt: Date.now()
					};
					await runtime.emitEvent(EventType.MESSAGE_RECEIVED, {
						runtime,
						message: memory,
						source: "telegram"
					});
				} catch (emitErr) {
					logger.warn(`[eliza] Telegram MESSAGE_RECEIVED emit failed: ${emitErr instanceof Error ? emitErr.message : String(emitErr)}`);
				}
				let history = chatHistories.get(chatId);
				if (!history) {
					history = [];
					if (chatHistories.size >= 500) {
						const oldest = chatHistories.keys().next().value;
						if (oldest !== void 0) chatHistories.delete(oldest);
					}
				} else chatHistories.delete(chatId);
				chatHistories.set(chatId, history);
				history.push({
					role: "user",
					content: `@${username}: ${text}`
				});
				if (history.length > 20) history.splice(0, history.length - 20);
				try {
					const conv = history.map((m) => `${m.role === "user" ? "User" : char.name}: ${m.content}`).join("\n");
					const modelRuntime = runtime;
					if (typeof modelRuntime.useModel !== "function") {
						logger.warn("[eliza] Telegram runtime missing useModel");
						return;
					}
					const response = await modelRuntime.useModel(ModelType.TEXT_LARGE, { prompt: `${systemPrompt}\n\nConversation:\n${conv}\n\n${char.name}:` });
					const responseText = typeof response === "string" ? response : response?.text ?? "";
					if (responseText) {
						history.push({
							role: "assistant",
							content: responseText
						});
						await ctx.reply(responseText);
						logger.info(`[eliza] Telegram replied to @${username}`);
					}
				} catch (err) {
					logger.warn(`[eliza] Telegram response error: ${err instanceof Error ? err.message : String(err)}`);
					await ctx.reply("Sorry, I encountered an error processing your message.").catch(() => {});
				}
			} catch (outerErr) {
				logger.warn(`[eliza] Telegram handler error: ${outerErr instanceof Error ? outerErr.message : String(outerErr)}`);
			}
		});
		bot.catch((err) => logger.warn(`[eliza] Telegram bot error: ${err instanceof Error ? err.message : String(err)}`));
		bot.launch({
			dropPendingUpdates: true,
			allowedUpdates: ["message", "message_reaction"]
		}).catch((err) => logger.warn(`[eliza] Telegram bot launch error: ${err instanceof Error ? err.message : String(err)}`));
		_telegramBot = bot;
		await new Promise((r) => setTimeout(r, 500));
		logger.info("[eliza] Telegram bot polling started");
	} catch (err) {
		logger.warn(`[eliza] Telegram bot setup failed: ${err instanceof Error ? err.message : String(err)}`);
	}
}
/**
* Eagerly download the embedding model file if not already present.
* This ensures the GGUF is on disk before the runtime's first
* generateEmbedding() call, avoiding a silent stall on first use.
*
* Uses the same env resolution as `configureLocalEmbeddingPlugin` (eliza.json
* `embedding` + hardware tier). Warmup previously always used tier-only presets,
* so a custom `embedding.model` caused a first download here and a *second*
* download when the plugin looked for a different filename — nothing deleted
* the first file; it was simply the wrong path/name.
*
* If the configured GGUF is **not** on disk but another known embedding file
* already exists in `MODELS_DIR` (e.g. legacy bge-small after `eliza.json`
* switched to the 7B E5 preset), we align `LOCAL_EMBEDDING_*` with that file
* so we do not re-download multi‑GB models. Opt out:
* `ELIZA_EMBEDDING_WARMUP_NO_REUSE=1`.
*/
async function warmupEmbeddingModel(onProgress) {
	if (isMobilePlatform()) {
		logger.info("[eliza] Skipping local embedding warmup — running on mobile (ELIZA_PLATFORM=android|ios)");
		return;
	}
	if (!shouldWarmupLocalEmbeddingModel()) {
		logger.info("[eliza] Skipping local embedding (GGUF) warmup — not needed for this configuration (e.g. Eliza Cloud embeddings, or local embeddings disabled).");
		return;
	}
	configureLocalEmbeddingPlugin({}, loadElizaConfig());
	const preset = detectEmbeddingPreset();
	const modelsDir = process$1.env.MODELS_DIR ?? DEFAULT_MODELS_DIR;
	let model = process$1.env.LOCAL_EMBEDDING_MODEL?.trim() || preset.model;
	let modelRepo = process$1.env.LOCAL_EMBEDDING_MODEL_REPO?.trim() || preset.modelRepo;
	if (!isEmbeddingWarmupReuseDisabled() && !embeddingGgufFilePresent(modelsDir, model)) {
		const reuse = findExistingEmbeddingModelForWarmupReuse(modelsDir);
		if (reuse) {
			logger.info(`[eliza] Embedding warmup: configured file "${model}" not found in MODELS_DIR — reusing existing ${reuse.model} to avoid a large re-download. Set LOCAL_EMBEDDING_MODEL or ELIZA_EMBEDDING_WARMUP_NO_REUSE=1 to force the configured model.`);
			process$1.env.LOCAL_EMBEDDING_MODEL = reuse.model;
			process$1.env.LOCAL_EMBEDDING_MODEL_REPO = reuse.modelRepo;
			process$1.env.LOCAL_EMBEDDING_DIMENSIONS = String(reuse.dimensions);
			process$1.env.LOCAL_EMBEDDING_CONTEXT_SIZE = String(reuse.contextSize);
			process$1.env.LOCAL_EMBEDDING_GPU_LAYERS = reuse.gpuLayers;
			process$1.env.LOCAL_EMBEDDING_USE_MMAP = reuse.gpuLayers === "auto" ? "false" : "true";
			model = reuse.model;
			modelRepo = reuse.modelRepo;
		}
	}
	logger.info(`[eliza] Local embedding warmup: ${model} (hardware tier preset: ${preset.label}). This file is for TEXT_EMBEDDING / memory only (not your conversation model).`);
	const progressCb = (phase, detail) => {
		updateStartupEmbeddingProgress(phase, detail);
		if (phase === "downloading") logger.info(`[eliza] Embedding model: ${detail ?? "downloading..."}`);
		else if (phase === "loading") logger.info(`[eliza] Embedding model: loading ${detail ?? ""}`);
		else if (phase === "ready") logger.info(`[eliza] Embedding model: ready (${detail ?? ""})`);
		onProgress?.(phase, detail);
	};
	try {
		await ensureModel(modelsDir, modelRepo, model, false, progressCb);
	} catch (err) {
		logger.warn(`[eliza] Embedding model warmup failed (will retry on first use): ${err instanceof Error ? err.message : String(err)}`);
	}
}
async function bootElizaRuntime$1(opts = {}) {
	syncAppEnvToEliza();
	try {
		await warmupEmbeddingModel(opts.onEmbeddingProgress);
		if (!process$1.env.EMBEDDING_DIMENSION) process$1.env.EMBEDDING_DIMENSION = "384";
		const runtime = await bootElizaRuntime(opts);
		return runtime ? await repairRuntimeAfterBoot(runtime) : runtime;
	} finally {
		syncElizaEnvAliases();
	}
}
function collectErrorObjects(err) {
	const chain = [];
	const seen = /* @__PURE__ */ new Set();
	let current = err;
	while (current && !seen.has(current)) {
		seen.add(current);
		if (current instanceof Error) {
			chain.push(current);
			current = current.cause;
			continue;
		}
		if (typeof current === "object" && current !== null) {
			const candidate = current;
			chain.push(candidate);
			current = candidate.cause;
			continue;
		}
		break;
	}
	return chain;
}
function getPgliteErrorCode(err) {
	for (const current of collectErrorObjects(err)) if (typeof current.code === "string" && current.code) return current.code;
	return null;
}
function collectErrorMessages(err) {
	const messages = [];
	for (const current of collectErrorObjects(err)) if (typeof current.message === "string" && current.message) messages.push(current.message);
	return messages;
}
function isManualResetPgliteError(err) {
	if (getPgliteErrorCode(err) === ELIZA_AUTO_RESET_PGLITE_ERROR_CODE) return true;
	return collectErrorMessages(err).some((message) => {
		const normalized = message.toLowerCase();
		if (normalized.includes("rename or delete only this directory before retrying")) return true;
		if (normalized.includes("@elizaos/plugin-sql") && normalized.includes("migrations._migrations")) return true;
		return false;
	});
}
function getPgliteDataDirFromError(err) {
	for (const current of collectErrorObjects(err)) if (typeof current.dataDir === "string" && current.dataDir.trim()) return current.dataDir;
	for (const rawMessage of collectErrorMessages(err)) {
		const message = rawMessage.length > 4096 ? rawMessage.slice(0, 4096) : rawMessage;
		const retryPathMatch = message.match(/before retrying:[ \t]{0,16}([^\n]{1,1024}?)(?:[ \t]*$|\.)/);
		if (retryPathMatch?.[1]) return retryPathMatch[1].trim();
		const initPathMatch = message.match(/PGlite initialization failed for ([^:\n]{1,1024}):/i);
		if (initPathMatch?.[1]) return initPathMatch[1].trim();
	}
	return null;
}
function resolveManagedPgliteDataDir() {
	const envDataDir = process$1.env.PGLITE_DATA_DIR?.trim();
	if (envDataDir) return resolveUserPath(envDataDir);
	const config = loadElizaConfig();
	if ((config.database?.provider ?? "pglite") === "postgres") return null;
	const configuredDataDir = config.database?.pglite?.dataDir?.trim();
	if (configuredDataDir) return resolveUserPath(configuredDataDir);
	const workspaceDir = config.agents?.defaults?.workspace ?? resolveDefaultAgentWorkspaceDir();
	return path.join(resolveUserPath(workspaceDir), ".eliza", ".elizadb");
}
function isAutoResettablePgliteDir(dataDir) {
	return typeof dataDir === "string" && path.basename(dataDir) === ".elizadb";
}
async function resetPluginSqlPgliteSingleton(context) {
	const singletons = globalThis[PLUGIN_SQL_GLOBAL_SINGLETONS];
	const manager = singletons?.pgLiteClientManager;
	if (manager && typeof manager.close === "function") {
		let closeTimedOut = false;
		let timeoutHandle = null;
		try {
			await Promise.race([Promise.resolve(manager.close()), new Promise((resolve) => {
				timeoutHandle = setTimeout(() => {
					closeTimedOut = true;
					resolve();
				}, 1e3);
			})]);
		} catch (err) {
			logger.warn(`[eliza] ${context}: failed to close plugin-sql PGlite singleton: ${err instanceof Error ? err.message : String(err)}`);
		} finally {
			if (timeoutHandle) clearTimeout(timeoutHandle);
		}
		if (closeTimedOut) logger.warn(`[eliza] ${context}: plugin-sql PGlite singleton close timed out; continuing with a forced reset`);
	}
	if (singletons?.pgLiteClientManager) delete singletons.pgLiteClientManager;
}
async function quarantinePgliteDataDir(dataDir) {
	if (!existsSync(dataDir)) return null;
	const parentDir = path.dirname(dataDir);
	const baseName = path.basename(dataDir);
	let attempt = 0;
	while (attempt < 1e3) {
		const suffix = attempt === 0 ? `${Date.now()}` : `${Date.now()}-${attempt}`;
		const backupDir = path.join(parentDir, `${baseName}.corrupt-${suffix}`);
		if (existsSync(backupDir)) {
			attempt += 1;
			continue;
		}
		await rename(dataDir, backupDir);
		return backupDir;
	}
	throw new Error(`Could not allocate a backup path for ${dataDir}`);
}
function normalizePgliteStartupError(err) {
	if (!isManualResetPgliteError(err)) return err;
	if (err instanceof Error && getPgliteErrorCode(err) === ELIZA_AUTO_RESET_PGLITE_ERROR_CODE) return err;
	const dataDir = getPgliteDataDirFromError(err) ?? resolveManagedPgliteDataDir();
	const detail = collectErrorMessages(err)[0] ?? (err instanceof Error ? err.message : String(err));
	const wrapped = new Error(dataDir ? `PGlite initialization failed for ${dataDir}: ${detail}. Stop the app, then rename or delete only this directory before retrying: ${dataDir}` : `PGlite initialization failed: ${detail}. Stop the app, then rename or delete only the managed PGlite data directory before retrying.`, { cause: err });
	wrapped.code = ELIZA_AUTO_RESET_PGLITE_ERROR_CODE;
	if (dataDir) wrapped.dataDir = dataDir;
	return wrapped;
}
async function upstreamStartElizaWithPgliteCompat(options) {
	try {
		return await startEliza(options);
	} catch (err) {
		throw normalizePgliteStartupError(err);
	}
}
async function attemptPgliteAutoReset(err) {
	if (!isManualResetPgliteError(err)) return null;
	const dataDir = getPgliteDataDirFromError(err) ?? resolveManagedPgliteDataDir();
	if (!isAutoResettablePgliteDir(dataDir)) return null;
	logger.warn(`[eliza] PGlite startup failed for ${dataDir}. Quarantining the local database before retrying.`);
	await resetPluginSqlPgliteSingleton("PGlite auto-reset");
	const backupDir = await quarantinePgliteDataDir(dataDir);
	if (backupDir) logger.warn(`[eliza] Moved the previous PGlite data dir to ${backupDir}`);
	await resetPluginSqlPgliteSingleton("PGlite auto-reset retry");
	return backupDir;
}
function getPgliteRecoveryRetrySkipPlugins() {
	return getLastFailedPluginNames();
}
async function startEliza$1(options) {
	syncAppEnvToEliza();
	const orchRaw = process$1.env.ELIZA_AGENT_ORCHESTRATOR?.trim().toLowerCase();
	if (orchRaw !== "0" && orchRaw !== "false" && orchRaw !== "no") process$1.env.ELIZA_AGENT_ORCHESTRATOR = "1";
	try {
		await warmupEmbeddingModel(options?.onEmbeddingProgress);
		if (!process$1.env.EMBEDDING_DIMENSION) process$1.env.EMBEDDING_DIMENSION = "384";
		if (options?.serverOnly) {
			let currentRuntime = await upstreamStartElizaWithPgliteCompat({
				...options,
				headless: true,
				serverOnly: false
			}) ?? void 0;
			currentRuntime = currentRuntime ? await repairRuntimeAfterBoot(currentRuntime) : currentRuntime;
			if (!currentRuntime) return currentRuntime;
			const { startApiServer } = await Promise.resolve().then(() => (init_server(), server_exports));
			const { port: actualApiPort } = await startApiServer({
				port: resolveServerOnlyPort(process$1.env),
				runtime: currentRuntime,
				onRestart: async () => {
					if (!currentRuntime) return null;
					await shutdownRuntime(currentRuntime, "server-only restart");
					const restarted = await upstreamStartElizaWithPgliteCompat({
						...options,
						headless: true,
						serverOnly: false
					}) ?? void 0;
					currentRuntime = restarted ? await repairRuntimeAfterBoot(restarted) : void 0;
					return currentRuntime ?? null;
				}
			});
			syncResolvedApiPort(process$1.env, actualApiPort, { overwriteUiPort: true });
			try {
				const { invalidateCorsAllowedPorts } = await Promise.resolve().then(() => (init_server_cors(), server_cors_exports));
				invalidateCorsAllowedPorts();
			} catch {}
			logger.info(`[eliza] API server listening on http://localhost:${actualApiPort}`);
			console.log(`[eliza] Control UI: http://localhost:${actualApiPort}`);
			console.log("[eliza] Server running. Press Ctrl+C to stop.");
			const keepAlive = setInterval(() => {}, 1 << 30);
			let isCleaningUp = false;
			const cleanup = async () => {
				if (isCleaningUp) return;
				isCleaningUp = true;
				clearInterval(keepAlive);
				setTimeout(() => {
					logger.warn("[eliza] Shutdown timed out after 10s — forcing exit");
					process$1.exit(1);
				}, 1e4).unref?.();
				stopTelegramBotPolling("SIGINT");
				if (currentRuntime) await shutdownRuntime(currentRuntime, "server-only shutdown");
				if (_n8nDispatch) _n8nDispatch = null;
				if (_n8nAutoStart) {
					try {
						await _n8nAutoStart.stop();
					} catch {}
					_n8nAutoStart = null;
				}
				if (_n8nAuthBridge) {
					try {
						_n8nAuthBridge.stop();
					} catch {}
					_n8nAuthBridge = null;
				}
				if (_triggerEventBridge) {
					try {
						_triggerEventBridge.stop();
					} catch {}
					_triggerEventBridge = null;
				}
				try {
					const { disposeN8nSidecar } = await Promise.resolve().then(() => (init_n8n_sidecar(), n8n_sidecar_exports));
					await disposeN8nSidecar();
				} catch {}
				process$1.exit(0);
			};
			if (!signalHandlersRegistered) {
				signalHandlersRegistered = true;
				process$1.on("SIGINT", () => void cleanup());
				process$1.on("SIGTERM", () => void cleanup());
			}
			return currentRuntime;
		}
		const runtime = await upstreamStartElizaWithPgliteCompat(options);
		return runtime ? await repairRuntimeAfterBoot(runtime) : runtime;
	} finally {
		syncElizaEnvAliases();
	}
}
function isDirectRuntimeRun() {
	const scriptArg = process$1.argv[1];
	if (!scriptArg) return false;
	return import.meta.url === pathToFileURL(path.resolve(scriptArg)).href;
}
function printDirectRuntimeHelp() {
	console.log(`eliza runtime

Usage:
  bun packages/app-core/src/runtime/eliza.ts
  bun run start:eliza

Flags:
  --help, -h       Show this help
  --version, -v    Show the app-core package version

For full CLI help, run:
  bun run eliza --help`);
}
function printDirectRuntimeVersion() {
	const pkg = require$1("../../package.json");
	console.log(pkg.version ?? "unknown");
}
var __rewriteRelativeImportExtension$1, AUTONOMY_WORLD_ID, AUTONOMY_ENTITY_ID, AUTONOMY_MESSAGE_SERVER_ID, INTERNAL_CHANNEL_PLUGIN_OVERRIDES, AGENT_ORCHESTRATOR_PLUGIN, EDGE_TTS_PLUGIN, require$1, DIRECT_HELP_FLAGS, DIRECT_VERSION_FLAGS, PLUGIN_SQL_GLOBAL_SINGLETONS, ELIZA_AUTO_RESET_PGLITE_ERROR_CODE, shutdownRuntime$1, CHANNEL_PLUGIN_MAP$1, signalHandlersRegistered, TRAINING_RUNTIME_HOOKS_SPECIFIER, _n8nAuthBridge, _n8nAutoStart, _n8nDispatch, _triggerEventBridge, _n8nRuntimeContextProvider, _discordEnumerationCache, _connectorTargetCatalog, CONNECTOR_TARGET_CATALOG_SERVICE_TYPE, _telegramBot;
var init_eliza = __esmMin((() => {
	init_namespace_defaults();
	init_is_native_server();
	init_registry$1();
	init_env();
	init_sql_compat();
	init_app_route_plugin_registry();
	init_embedding_manager_support();
	init_embedding_presets();
	init_embedding_warmup_policy();
	init_ensure_local_inference_handler();
	init_ensure_text_to_speech_handler();
	init_mobile_local_inference_gate();
	init_startup_overlay();
	init_telegram_standalone_policy();
	__rewriteRelativeImportExtension$1 = void 0 && (void 0).__rewriteRelativeImportExtension || function(path, preserveJsx) {
		if (typeof path === "string" && /^\.\.?\//.test(path)) return path.replace(/\.(tsx)$|((?:\.d)?)((?:\.[^./]+?)?)\.([cm]?)ts$/i, function(m, tsx, d, ext, cm) {
			return tsx ? preserveJsx ? ".jsx" : ".js" : d && (!ext || !cm) ? m : d + ext + "." + cm.toLowerCase() + "js";
		});
		return path;
	};
	AUTONOMY_WORLD_ID = stringToUuid("00000000-0000-0000-0000-000000000001");
	AUTONOMY_ENTITY_ID = stringToUuid("00000000-0000-0000-0000-000000000002");
	AUTONOMY_MESSAGE_SERVER_ID = stringToUuid("autonomy-message-server");
	INTERNAL_CHANNEL_PLUGIN_OVERRIDES = {
		signal: "@elizaos/plugin-signal",
		whatsapp: "@elizaos/plugin-whatsapp",
		wechat: "elizaoswechat"
	};
	AGENT_ORCHESTRATOR_PLUGIN = "agent-orchestrator";
	EDGE_TTS_PLUGIN = "@elizaos/plugin-edge-tts";
	require$1 = createRequire(import.meta.url);
	DIRECT_HELP_FLAGS = new Set([
		"-h",
		"--help",
		"help"
	]);
	DIRECT_VERSION_FLAGS = new Set([
		"-v",
		"-V",
		"--version",
		"version"
	]);
	PLUGIN_SQL_GLOBAL_SINGLETONS = Symbol.for("@elizaos/plugin-sql/global-singletons");
	ELIZA_AUTO_RESET_PGLITE_ERROR_CODE = "ELIZA_PGLITE_MANUAL_RESET_REQUIRED";
	shutdownRuntime$1 = shutdownRuntime;
	CHANNEL_PLUGIN_MAP$1 = {
		...CHANNEL_PLUGIN_MAP,
		...INTERNAL_CHANNEL_PLUGIN_OVERRIDES
	};
	signalHandlersRegistered = false;
	TRAINING_RUNTIME_HOOKS_SPECIFIER = "@elizaos/app-training/register-runtime";
	_n8nAuthBridge = null;
	_n8nAutoStart = null;
	_n8nDispatch = null;
	_triggerEventBridge = null;
	_n8nRuntimeContextProvider = null;
	_discordEnumerationCache = null;
	_connectorTargetCatalog = null;
	CONNECTOR_TARGET_CATALOG_SERVICE_TYPE = "connector_target_catalog";
	_telegramBot = null;
	if (isDirectRuntimeRun()) {
		const command = process$1.argv[2];
		if (DIRECT_HELP_FLAGS.has(command ?? "")) printDirectRuntimeHelp();
		else if (DIRECT_VERSION_FLAGS.has(command ?? "")) printDirectRuntimeVersion();
		else startEliza$1().catch((err) => {
			console.error("[eliza] Fatal error:", err instanceof Error ? err.stack ?? err.message : err);
			process$1.exit(1);
		});
	}
}));

//#endregion
//#region node_modules/.bun/@elizaos+app-core@2.0.0-alpha.537+72829346cb4c43b1/node_modules/@elizaos/app-core/packages/app-core/src/cli/plugins-cli.js
var plugins_cli_exports = /* @__PURE__ */ __exportAll({
	findPluginExport: () => findPluginExport,
	normalizePluginName: () => normalizePluginName,
	parsePluginSpec: () => parsePluginSpec,
	registerPluginsCli: () => registerPluginsCli,
	validatePluginPath: () => validatePluginPath
});
/** Validate that a resolved plugin path is within allowed boundaries. */
function validatePluginPath(resolved) {
	const home = os.homedir();
	const cwd = process.cwd();
	if (!path.isAbsolute(resolved) || !resolved.startsWith(home + path.sep) && resolved !== home && !resolved.startsWith(cwd + path.sep) && resolved !== cwd) throw new Error(`Plugin path ${resolved} is outside allowed boundaries (must be under ${home} or ${cwd})`);
}
/**
* Normalize a user-provided plugin name to its fully-qualified form.
* Accepts `@scope/plugin-x`, `plugin-x`, or shorthand `x` (→ `@elizaos/plugin-x`).
*/
function normalizePluginName(name) {
	if (name.startsWith("@") || name.startsWith("plugin-")) return name;
	return `@elizaos/plugin-${name}`;
}
/**
* Parse plugin name and optional version from user input.
* Examples:
*   - "discord" → { name: "@elizaos/plugin-discord", version: undefined }
*   - "discord@1.2.3" → { name: "@elizaos/plugin-discord", version: "1.2.3" }
*   - "@custom/plugin-foo@2.0.0" → { name: "@custom/plugin-foo", version: "2.0.0" }
*/
function parsePluginSpec(input) {
	const trimmed = input.trim();
	let namePart = trimmed;
	let versionPart;
	if (trimmed.startsWith("@")) {
		const secondAt = trimmed.indexOf("@", 1);
		if (secondAt !== -1) {
			namePart = trimmed.slice(0, secondAt);
			versionPart = trimmed.slice(secondAt + 1);
		}
	} else {
		const atIndex = trimmed.indexOf("@");
		if (atIndex !== -1) {
			namePart = trimmed.slice(0, atIndex);
			versionPart = trimmed.slice(atIndex + 1);
		}
	}
	const version = versionPart?.trim() || void 0;
	return {
		name: normalizePluginName(namePart),
		version
	};
}
/**
* Display plugin configuration parameters in a formatted table.
*/
function displayPluginConfig(plugin, currentEnv) {
	const params = plugin.parameters ?? [];
	if (params.length === 0) {
		console.log(chalk.dim("  No configurable parameters."));
		return;
	}
	for (const param of params) {
		const hint = plugin.configUiHints?.[param.key] ?? {};
		const label = hint.label ?? param.key;
		const value = currentEnv[param.key];
		const isSet = value != null && value !== "";
		const isSensitive = param.sensitive || hint.sensitive;
		const displayValue = !isSet ? chalk.dim("(not set)") : isSensitive ? chalk.dim("●●●●●●●●") : chalk.white(value);
		const required = param.required ? chalk.red(" *") : "";
		const help = hint.help ?? param.description ? chalk.dim(` — ${hint.help ?? param.description}`) : "";
		console.log(`  ${chalk.cyan(label.padEnd(30))} ${displayValue}${required}${help}`);
	}
}
async function getPluginManager() {
	const pluginManager = new PluginManagerService({
		plugins: [],
		actions: [],
		providers: [],
		evaluators: [],
		services: /* @__PURE__ */ new Map(),
		getService: () => null,
		registerService: async () => {},
		registerAction: () => {},
		registerProvider: () => {},
		registerEvaluator: () => {},
		registerEvent: () => {}
	});
	if (!isPluginManagerLike(pluginManager)) throw new Error("Plugin manager service does not match the CLI contract");
	return pluginManager;
}
function registerPluginsCli(program) {
	const pluginsCommand = program.command("plugins").description("Browse, search, install, and manage elizaOS plugins from the registry");
	pluginsCommand.command("list").description("List all plugins from the registry (next branch)").option("-q, --query <query>", "Filter plugins by name or keyword").option("-l, --limit <number>", "Max results to show", "30").action(async (opts) => {
		try {
			const pluginManager = await getPluginManager();
			const limit = parseClampedInteger(opts.limit, {
				min: 1,
				max: 500,
				fallback: 30
			});
			const installed = await pluginManager.listInstalledPlugins();
			const installedNames = new Set(installed.map((p) => p.name));
			if (opts.query) {
				const results = await pluginManager.searchRegistry(opts.query, limit);
				if (results.length === 0) {
					console.log(`\nNo plugins found matching "${opts.query}"\n`);
					return;
				}
				console.log(`\n${chalk.bold(`Found ${results.length} plugins matching "${opts.query}":`)}\n`);
				for (const r of results) {
					const versionBadges = [];
					if (r.supports.v0) versionBadges.push("v0");
					if (r.supports.v1) versionBadges.push("v1");
					if (r.supports.v2) versionBadges.push("v2");
					const badge = installedNames.has(r.name) ? chalk.green(" ✓ installed") : "";
					console.log(`  ${chalk.cyan(r.name)} ${r.latestVersion ? chalk.dim(`v${r.latestVersion}`) : ""}${badge}`);
					if (r.description) console.log(`    ${r.description}`);
					if (r.tags.length > 0) console.log(`    ${chalk.dim(`tags: ${r.tags.slice(0, 5).join(", ")}`)}`);
					if (versionBadges.length > 0) console.log(`    ${chalk.dim(`supports: ${versionBadges.join(", ")}`)}`);
					console.log();
				}
			} else {
				const registry = await pluginManager.refreshRegistry();
				const all = Array.from(registry.values());
				const installedCount = all.filter((p) => installedNames.has(p.name)).length;
				console.log(`\n${chalk.bold(`${all.length} plugins available in registry`)}${installedCount > 0 ? chalk.green(` (${installedCount} installed)`) : ""}${chalk.bold(":")}\n`);
				const sorted = all.sort((a, b) => a.name.localeCompare(b.name)).slice(0, limit);
				for (const plugin of sorted) {
					const desc = plugin.description ? ` — ${plugin.description}` : "";
					const badge = installedNames.has(plugin.name) ? chalk.green(" ✓") : "";
					console.log(`  ${chalk.cyan(plugin.name)}${badge}${chalk.dim(desc)}`);
				}
				if (all.length > limit) console.log(chalk.dim(`\n  ... and ${all.length - limit} more (use --limit to show more)`));
				console.log();
			}
			console.log(chalk.dim("Install a plugin: eliza plugins install <name>"));
			console.log(chalk.dim("Search:           eliza plugins list -q <keyword>"));
			console.log();
		} catch (err) {
			console.error(chalk.red(err instanceof Error ? err.message : String(err)));
			process.exitCode = 1;
		}
	});
	pluginsCommand.command("search <query>").description("Search the plugin registry by keyword").option("-l, --limit <number>", "Max results", "15").action(async (query, opts) => {
		try {
			const pluginManager = await getPluginManager();
			const limit = parseClampedInteger(opts.limit, {
				min: 1,
				max: 50,
				fallback: 15
			});
			const results = await pluginManager.searchRegistry(query, limit);
			if (results.length === 0) {
				console.log(`\nNo plugins found matching "${query}"\n`);
				return;
			}
			console.log(`\n${chalk.bold(`${results.length} results for "${query}":`)}\n`);
			for (const r of results) {
				const match = (r.score * 100).toFixed(0);
				console.log(`  ${chalk.cyan(r.name)} ${chalk.dim(`(${match}% match)`)}`);
				if (r.description) console.log(`    ${r.description}`);
				if (r.stars > 0) console.log(`    ${chalk.dim(`stars: ${r.stars}`)}`);
				console.log();
			}
		} catch (err) {
			console.error(chalk.red(err instanceof Error ? err.message : String(err)));
			process.exitCode = 1;
		}
	});
	pluginsCommand.command("info <name>").description("Show detailed information about a plugin").action(async (name) => {
		try {
			const pluginManager = await getPluginManager();
			const normalizedName = normalizePluginName(name);
			const info = await pluginManager.getRegistryPlugin(normalizedName);
			if (!info) {
				console.log(`\n${chalk.red("Not found:")} ${normalizedName}`);
				console.log(chalk.dim("Run 'eliza plugins search <keyword>' to find plugins.\n"));
				return;
			}
			console.log();
			console.log(chalk.bold(info.name));
			console.log(chalk.dim("─".repeat(info.name.length)));
			if (info.description) console.log(`\n  ${info.description}`);
			console.log(`\n  ${chalk.dim("Repository:")}  https://github.com/${info.gitRepo}`);
			if (info.homepage) console.log(`  ${chalk.dim("Homepage:")}    ${info.homepage}`);
			console.log(`  ${chalk.dim("Language:")}    ${info.language}`);
			console.log(`  ${chalk.dim("Stars:")}       ${info.stars}`);
			if (info.topics.length > 0) console.log(`  ${chalk.dim("Topics:")}      ${info.topics.join(", ")}`);
			const versions = [];
			if (info.npm.v0Version) versions.push(`v0: ${info.npm.v0Version}`);
			if (info.npm.v1Version) versions.push(`v1: ${info.npm.v1Version}`);
			if (info.npm.v2Version) versions.push(`v2: ${info.npm.v2Version}`);
			if (versions.length > 0) console.log(`  ${chalk.dim("npm:")}         ${versions.join("  |  ")}`);
			const supported = [];
			if (info.supports.v0) supported.push("v0");
			if (info.supports.v1) supported.push("v1");
			if (info.supports.v2) supported.push("v2");
			if (supported.length > 0) console.log(`  ${chalk.dim("Supports:")}    ${supported.join(", ")}`);
			console.log(`\n  Install: ${chalk.cyan(`eliza plugins install ${info.name}`)}\n`);
		} catch (err) {
			console.error(chalk.red(err instanceof Error ? err.message : String(err)));
			process.exitCode = 1;
		}
	});
	pluginsCommand.command("install <name>").description("Install a plugin from the registry. Optionally pin to a specific version or dist-tag (e.g., twitter@1.2.3, twitter@next)").option("--no-restart", "Install without restarting the agent").action(async (name, opts) => {
		try {
			const { name: normalizedName, version } = parsePluginSpec(name);
			const displayName = version ? `${normalizedName}@${version}` : normalizedName;
			console.log(`\nInstalling ${chalk.cyan(displayName)}...\n`);
			const progressHandler = (progress) => {
				console.log(`  [${progress.phase}] ${progress.message}`);
			};
			const { installPlugin } = await Promise.resolve().then(() => (init_plugin_installer(), plugin_installer_exports));
			const result = await installPlugin(normalizedName, progressHandler, version);
			if (result.success) {
				console.log(`\n${chalk.green("Success!")} ${result.pluginName}@${result.version} installed.`);
				if (result.requiresRestart && !opts.restart) console.log(chalk.yellow("\nRestart your agent to load the new plugin."));
				else if (result.requiresRestart) {
					console.log(chalk.dim("Agent is restarting to load the new plugin..."));
					const { requestRestart } = await import("@elizaos/agent/runtime/restart");
					await Promise.resolve(requestRestart(`Plugin ${result.pluginName} installed`));
				}
			} else {
				console.log(`\n${chalk.red("Failed:")} ${result.error}`);
				process.exitCode = 1;
			}
			console.log();
		} catch (err) {
			console.error(chalk.red(err instanceof Error ? err.message : String(err)));
			process.exitCode = 1;
		}
	});
	pluginsCommand.command("uninstall <name>").description("Uninstall a user-installed plugin").option("--no-restart", "Uninstall without restarting the agent").action(async (name, opts) => {
		try {
			const pluginManager = await getPluginManager();
			console.log(`\nUninstalling ${chalk.cyan(name)}...\n`);
			const result = await pluginManager.uninstallPlugin(name);
			if (result.success) {
				console.log(`${chalk.green("Success!")} ${result.pluginName} uninstalled.`);
				if (result.requiresRestart && !opts.restart) console.log(chalk.yellow("\nRestart your agent to apply changes."));
			} else {
				console.log(`\n${chalk.red("Failed:")} ${result.error}`);
				process.exitCode = 1;
			}
			console.log();
		} catch (err) {
			console.error(chalk.red(err instanceof Error ? err.message : String(err)));
			process.exitCode = 1;
		}
	});
	pluginsCommand.command("installed").description("List plugins installed from the registry").action(async () => {
		try {
			const plugins = await (await getPluginManager()).listInstalledPlugins();
			if (plugins.length === 0) {
				console.log("\nNo plugins installed from the registry.\n");
				console.log(chalk.dim("Install one: eliza plugins install <name>\n"));
				return;
			}
			console.log(`\n${chalk.bold(`${plugins.length} user-installed plugins:`)}\n`);
			for (const p of plugins) {
				console.log(`  ${chalk.cyan(p.name)} ${chalk.dim(`v${p.version}`)}`);
				console.log();
			}
		} catch (err) {
			console.error(chalk.red(err instanceof Error ? err.message : String(err)));
			process.exitCode = 1;
		}
	});
	pluginsCommand.command("refresh").description("Force-refresh the plugin registry cache").action(async () => {
		try {
			const pluginManager = await getPluginManager();
			console.log("\nRefreshing registry cache...");
			const registry = await pluginManager.refreshRegistry();
			console.log(`${chalk.green("Done!")} ${registry.size} plugins loaded.\n`);
		} catch (err) {
			console.error(chalk.red(err instanceof Error ? err.message : String(err)));
			process.exitCode = 1;
		}
	});
	pluginsCommand.command("test").description("Validate custom drop-in plugins in ~/.eliza/plugins/custom/").action(async () => {
		try {
			const nodePath = await import("node:path");
			const { pathToFileURL } = await import("node:url");
			const fsPromises = await import("node:fs/promises");
			const { resolveStateDir, resolveUserPath } = await import("@elizaos/agent/config/paths");
			const { loadElizaConfig } = await Promise.resolve().then(() => (init_config(), config_exports));
			const { CUSTOM_PLUGINS_DIRNAME, scanDropInPlugins, resolvePackageEntry } = await Promise.resolve().then(() => (init_eliza(), eliza_exports));
			const customDir = nodePath.join(resolveStateDir(), CUSTOM_PLUGINS_DIRNAME);
			const scanDirs = [customDir];
			let config = null;
			try {
				config = loadElizaConfig();
			} catch (err) {
				console.log(chalk.dim(`  (Could not read eliza.json: ${err instanceof Error ? err.message : String(err)} — scanning default directory only)\n`));
			}
			for (const p of config?.plugins?.load?.paths ?? []) {
				const rp = resolveUserPath(p);
				validatePluginPath(rp);
				scanDirs.push(rp);
			}
			console.log(`\n${chalk.bold("Custom plugins directory:")} ${chalk.dim(customDir)}\n`);
			const candidates = [];
			for (const dir of scanDirs) for (const [name, record] of Object.entries(await scanDropInPlugins(dir))) candidates.push({
				name,
				installPath: record.installPath ?? "",
				version: record.version ?? ""
			});
			if (candidates.length === 0) {
				console.log("  No custom plugins found.\n");
				console.log(chalk.dim(`  Drop a plugin directory into ${customDir} and run this command again.\n`));
				return;
			}
			console.log(`${chalk.bold(`Found ${candidates.length} custom plugin(s):`)}\n`);
			let validCount = 0;
			let failedCount = 0;
			const fail = (msg) => {
				console.log(`    ${chalk.red("✗")} ${msg}`);
				failedCount++;
				console.log();
			};
			for (const candidate of candidates) {
				const ver = candidate.version !== "0.0.0" ? chalk.dim(` v${candidate.version}`) : "";
				console.log(`  ${chalk.cyan(candidate.name)}${ver}`);
				console.log(`    ${chalk.dim("Path:")} ${candidate.installPath}`);
				let entryPoint;
				try {
					entryPoint = await resolvePackageEntry(candidate.installPath);
				} catch (err) {
					fail(`Entry point failed: ${err instanceof Error ? err.message : String(err)}`);
					continue;
				}
				console.log(`    ${chalk.dim("Entry:")} ${nodePath.relative(candidate.installPath, entryPoint)}`);
				try {
					await fsPromises.access(entryPoint);
				} catch {
					fail(`File not found: ${entryPoint}`);
					continue;
				}
				let mod;
				try {
					mod = await import(__rewriteRelativeImportExtension(pathToFileURL(entryPoint).href));
				} catch (err) {
					fail(`Import failed: ${err instanceof Error ? err.message : String(err)}`);
					continue;
				}
				const plugin = findPluginExport(mod);
				if (plugin) {
					console.log(`    ${chalk.green("✓ Valid plugin")} — ${plugin.name}: ${chalk.dim(plugin.description)}`);
					validCount++;
				} else {
					fail("No valid Plugin export — needs { name: string, description: string }");
					continue;
				}
				console.log();
			}
			const parts = [];
			if (validCount > 0) parts.push(chalk.green(`${validCount} valid`));
			if (failedCount > 0) parts.push(chalk.red(`${failedCount} failed`));
			console.log(`  ${chalk.bold("Summary:")} ${parts.join(", ")} out of ${candidates.length}\n`);
		} catch (err) {
			console.error(chalk.red(err instanceof Error ? err.message : String(err)));
			process.exitCode = 1;
		}
	});
	pluginsCommand.command("add-path <path>").description("Register an additional plugin search directory in config").action(async (rawPath) => {
		try {
			await import("node:path");
			const nodeFs = await import("node:fs");
			const { resolveUserPath } = await import("@elizaos/agent/config/paths");
			const { loadElizaConfig, saveElizaConfig } = await Promise.resolve().then(() => (init_config(), config_exports));
			const resolved = resolveUserPath(rawPath);
			validatePluginPath(resolved);
			if (!nodeFs.existsSync(resolved) || !nodeFs.statSync(resolved).isDirectory()) {
				console.log(`\n${chalk.red("Error:")} ${resolved} is not a directory.\n`);
				process.exitCode = 1;
				return;
			}
			let config;
			try {
				config = loadElizaConfig();
			} catch {
				config = {};
			}
			if (!config.plugins) config.plugins = {};
			if (!config.plugins.load) config.plugins.load = {};
			if (!config.plugins.load.paths) config.plugins.load.paths = [];
			if (config.plugins.load.paths.map((p) => {
				const rp = resolveUserPath(p);
				validatePluginPath(rp);
				return rp;
			}).includes(resolved)) {
				console.log(`\n${chalk.yellow("Already registered:")} ${rawPath}\n`);
				return;
			}
			config.plugins.load.paths.push(rawPath);
			saveElizaConfig(config);
			console.log(`\n${chalk.green("Added:")} ${rawPath} → ${resolved}`);
			console.log(chalk.dim("Restart your agent to load plugins from this path.\n"));
		} catch (err) {
			console.error(chalk.red(err instanceof Error ? err.message : String(err)));
			process.exitCode = 1;
		}
	});
	pluginsCommand.command("paths").description("List all plugin search directories and their contents").action(async () => {
		try {
			const nodePath = await import("node:path");
			const { resolveStateDir, resolveUserPath } = await import("@elizaos/agent/config/paths");
			const { loadElizaConfig } = await Promise.resolve().then(() => (init_config(), config_exports));
			const { CUSTOM_PLUGINS_DIRNAME, scanDropInPlugins } = await Promise.resolve().then(() => (init_eliza(), eliza_exports));
			let config = null;
			try {
				config = loadElizaConfig();
			} catch {}
			const customDir = nodePath.join(resolveStateDir(), CUSTOM_PLUGINS_DIRNAME);
			const dirs = [{
				label: customDir,
				path: customDir,
				origin: "custom"
			}];
			for (const p of config?.plugins?.load?.paths ?? []) dirs.push({
				label: p,
				path: resolveUserPath(p),
				origin: "config"
			});
			console.log(`\n${chalk.bold("Plugin search directories:")}\n`);
			for (const dir of dirs) {
				const records = await scanDropInPlugins(dir.path);
				const count = Object.keys(records).length;
				const badge = chalk.dim(`[${dir.origin}]`);
				const countStr = count > 0 ? chalk.green(`${count} plugin${count !== 1 ? "s" : ""}`) : chalk.dim("empty");
				console.log(`  ${badge}  ${dir.label}  (${countStr})`);
				for (const [name, record] of Object.entries(records)) {
					const ver = record.version !== "0.0.0" ? ` v${record.version}` : "";
					console.log(`         ${chalk.cyan(name)}${chalk.dim(ver)}`);
				}
			}
			console.log();
		} catch (err) {
			console.error(chalk.red(err instanceof Error ? err.message : String(err)));
			process.exitCode = 1;
		}
	});
	pluginsCommand.command("config <name>").description("Show or edit plugin configuration").option("-e, --edit", "Interactive edit mode").action(async (name, opts) => {
		try {
			const nodeFs = await import("node:fs");
			const pluginsPath = (await import("node:path")).resolve(process.cwd(), "plugins.json");
			let catalog;
			try {
				catalog = JSON.parse(nodeFs.readFileSync(pluginsPath, "utf8"));
			} catch (err) {
				console.log(`\n${chalk.red("Error:")} Could not read plugins.json: ${err instanceof Error ? err.message : String(err)}\n`);
				process.exitCode = 1;
				return;
			}
			const plugin = (catalog.plugins ?? []).find((p) => p.id === name || p.npmName === name || typeof p.name === "string" && p.name.toLowerCase().includes(name.toLowerCase()));
			if (!plugin) {
				console.log(`\n${chalk.red("Not found:")} ${name}`);
				console.log(chalk.dim("Run 'eliza plugins list' to see available plugins.\n"));
				process.exitCode = 1;
				return;
			}
			const pluginId = String(plugin.id ?? "");
			const pluginName = String(plugin.name ?? pluginId);
			const params = plugin.pluginParameters;
			const configUiHints = plugin.configUiHints;
			if (!opts.edit) {
				console.log(`\n${chalk.bold(pluginName)} ${chalk.dim(`(${pluginId})`)}`);
				console.log(chalk.dim("─".repeat(pluginName.length + pluginId.length + 3)));
				displayPluginConfig({
					id: pluginId,
					name: pluginName,
					parameters: params ? Object.entries(params).map(([key, param]) => ({
						key,
						description: param.description,
						required: param.required,
						sensitive: param.sensitive
					})) : [],
					configUiHints
				}, process.env);
				console.log();
				return;
			}
			const clack = await import("@clack/prompts");
			console.log(`\n${chalk.bold("Configure")} ${chalk.cyan(pluginName)}\n`);
			const newValues = {};
			if (!params || Object.keys(params).length === 0) {
				console.log(chalk.dim("  No configurable parameters.\n"));
				return;
			}
			for (const [key, param] of Object.entries(params)) {
				const hint = configUiHints?.[key] ?? {};
				const label = hint.label ?? key;
				const currentValue = process.env[key];
				const isSensitive = param.sensitive || hint.sensitive;
				const help = hint.help ?? param.description ?? "";
				const displayCurrent = currentValue ? isSensitive ? chalk.dim("●●●●●●●●") : chalk.dim(`(current: ${currentValue})`) : chalk.dim("(not set)");
				let promptValue;
				if (param.type === "boolean") promptValue = await clack.confirm({
					message: `${label} ${displayCurrent}`,
					initialValue: currentValue === "true"
				});
				else if (isSensitive) promptValue = await clack.password({
					message: `${label} ${displayCurrent}`,
					validate: (v) => param.required && !v ? "This field is required" : void 0
				});
				else promptValue = await clack.text({
					message: `${label} ${displayCurrent}`,
					placeholder: help || void 0,
					validate: (v) => param.required && !v ? "This field is required" : void 0
				});
				if (clack.isCancel(promptValue)) {
					clack.cancel("Configuration cancelled.");
					process.exit(0);
				}
				if (typeof promptValue === "boolean") newValues[key] = String(promptValue);
				else if (typeof promptValue === "string" && promptValue !== "") newValues[key] = promptValue;
			}
			const { loadElizaConfig, saveElizaConfig } = await Promise.resolve().then(() => (init_config(), config_exports));
			let config;
			try {
				config = loadElizaConfig();
			} catch {
				config = {};
			}
			const configAny = config;
			if (!configAny.plugins || typeof configAny.plugins !== "object") configAny.plugins = {};
			const pluginsObj = configAny.plugins;
			if (!pluginsObj.entries || typeof pluginsObj.entries !== "object") pluginsObj.entries = {};
			const entries = pluginsObj.entries;
			if (!entries[pluginId]) entries[pluginId] = {
				enabled: true,
				config: {}
			};
			if (!entries[pluginId].config || typeof entries[pluginId].config !== "object") entries[pluginId].config = {};
			const pluginConfig = entries[pluginId].config;
			for (const [key, value] of Object.entries(newValues)) {
				process.env[key] = value;
				pluginConfig[key] = value;
			}
			saveElizaConfig(config);
			console.log(`\n${chalk.green("Success!")} Configuration saved for ${pluginName}.`);
			console.log(chalk.dim("Restart your agent to apply changes.\n"));
		} catch (err) {
			console.error(chalk.red(err instanceof Error ? err.message : String(err)));
			process.exitCode = 1;
		}
	});
	pluginsCommand.command("open [name-or-path]").description("Open a plugin directory (or the custom plugins folder) in your editor").action(async (nameOrPath) => {
		try {
			const nodePath = await import("node:path");
			const nodeFs = await import("node:fs");
			const { spawnSync } = await import("node:child_process");
			const { resolveStateDir, resolveUserPath } = await import("@elizaos/agent/config/paths");
			const { CUSTOM_PLUGINS_DIRNAME, scanDropInPlugins } = await Promise.resolve().then(() => (init_eliza(), eliza_exports));
			const customDir = nodePath.join(resolveStateDir(), CUSTOM_PLUGINS_DIRNAME);
			let targetDir;
			if (!nameOrPath) targetDir = customDir;
			else if (nodeFs.existsSync(resolveUserPath(nameOrPath)) && nodeFs.statSync(resolveUserPath(nameOrPath)).isDirectory()) targetDir = resolveUserPath(nameOrPath);
			else {
				const records = await scanDropInPlugins(customDir);
				const match = records[nameOrPath];
				if (match?.installPath) targetDir = match.installPath;
				else {
					console.log(`\n${chalk.red("Not found:")} "${nameOrPath}" is not a path or known custom plugin.`);
					console.log(chalk.dim(`Custom plugins: ${Object.keys(records).join(", ") || "(none)"}\n`));
					process.exitCode = 1;
					return;
				}
			}
			function splitCommand(command) {
				const trimmed = command.trim();
				if (!trimmed) return {
					cmd: "code",
					args: []
				};
				const tokens = [];
				let current = "";
				let quote = null;
				let escaped = false;
				for (let i = 0; i < trimmed.length; i++) {
					const char = trimmed[i];
					if (escaped) {
						current += char;
						escaped = false;
						continue;
					}
					if (char === "\\") {
						if (quote === "'") {
							current += char;
							continue;
						}
						const next = trimmed[i + 1];
						if (next === "\"" || next === "'" || next === "\\" || next && /\s/.test(next)) {
							escaped = true;
							continue;
						}
						current += char;
						continue;
					}
					if (quote) {
						if (char === quote) {
							quote = null;
							continue;
						}
						current += char;
						continue;
					}
					if (char === "\"" || char === "'") {
						quote = char;
						continue;
					}
					if (/\s/.test(char)) {
						if (current) {
							tokens.push(current);
							current = "";
						}
						continue;
					}
					current += char;
				}
				if (current) tokens.push(current);
				const [cmd, ...args] = tokens.length > 0 ? tokens : ["code"];
				return {
					cmd,
					args
				};
			}
			const { cmd: editorCmd, args: editorArgs } = splitCommand(process.env.EDITOR || "code");
			console.log(`\nOpening ${chalk.cyan(targetDir)} with ${editorCmd}...\n`);
			try {
				const result = spawnSync(editorCmd, [...editorArgs, targetDir], { stdio: "inherit" });
				if (result.error) throw result.error;
			} catch {}
		} catch (err) {
			console.error(chalk.red(err instanceof Error ? err.message : String(err)));
			process.exitCode = 1;
		}
	});
}
/** Find the first export that looks like a Plugin ({ name, description }). */
function findPluginExport(mod) {
	const isPluginBasic = (v) => v !== null && typeof v === "object" && typeof v.name === "string" && typeof v.description === "string";
	const hasPluginCapabilities = (v) => {
		if (v === null || typeof v !== "object") return false;
		const obj = v;
		return Array.isArray(obj.services) || Array.isArray(obj.providers) || Array.isArray(obj.actions) || Array.isArray(obj.routes) || Array.isArray(obj.events) || typeof obj.init === "function";
	};
	const isPluginStrict = (v) => isPluginBasic(v) && hasPluginCapabilities(v);
	if (isPluginStrict(mod.default)) return mod.default;
	if (isPluginStrict(mod.plugin)) return mod.plugin;
	if (isPluginStrict(mod)) return mod;
	const keys = Object.keys(mod).filter((key) => key !== "default" && key !== "plugin");
	const preferred = keys.filter((key) => /plugin$/i.test(key) || /^plugin/i.test(key));
	const fallback = keys.filter((key) => !preferred.includes(key));
	for (const key of [...preferred, ...fallback]) {
		const value = mod[key];
		if (isPluginStrict(value)) return value;
	}
	for (const key of preferred) {
		const value = mod[key];
		if (isPluginBasic(value)) return value;
	}
	if (isPluginBasic(mod.default)) return mod.default;
	if (isPluginBasic(mod.plugin)) return mod.plugin;
	if (isPluginBasic(mod)) return mod;
	return null;
}
var __rewriteRelativeImportExtension;
var init_plugins_cli = __esmMin((() => {
	init_number_parsing();
	__rewriteRelativeImportExtension = void 0 && (void 0).__rewriteRelativeImportExtension || function(path, preserveJsx) {
		if (typeof path === "string" && /^\.\.?\//.test(path)) return path.replace(/\.(tsx)$|((?:\.d)?)((?:\.[^./]+?)?)\.([cm]?)ts$/i, function(m, tsx, d, ext, cm) {
			return tsx ? preserveJsx ? ".jsx" : ".js" : d && (!ext || !cm) ? m : d + ext + "." + cm.toLowerCase() + "js";
		});
		return path;
	};
}));

//#endregion
//#region node_modules/.bun/@elizaos+app-core@2.0.0-alpha.537+72829346cb4c43b1/node_modules/@elizaos/app-core/packages/app-core/src/cli/program/register.models.js
var register_models_exports = /* @__PURE__ */ __exportAll({ registerModelsCli: () => registerModelsCli });
function registerModelsCli(program) {
	program.command("models").description("Show configured model providers").action(() => {
		const envKeys = [
			["ANTHROPIC_API_KEY", "Anthropic (Claude)"],
			["OPENAI_API_KEY", "OpenAI (GPT)"],
			["AI_GATEWAY_API_KEY", "Vercel AI Gateway"],
			["GOOGLE_API_KEY", "Google (Gemini)"],
			["GOOGLE_CLOUD_API_KEY", "Google Antigravity (Vertex AI)"],
			["GROQ_API_KEY", "Groq"],
			["XAI_API_KEY", "xAI (Grok)"],
			["OPENROUTER_API_KEY", "OpenRouter"],
			["DEEPSEEK_API_KEY", "DeepSeek"],
			["TOGETHER_API_KEY", "Together AI"],
			["MISTRAL_API_KEY", "Mistral"],
			["COHERE_API_KEY", "Cohere"],
			["PERPLEXITY_API_KEY", "Perplexity"],
			["ZAI_API_KEY", "Zai"],
			["OLLAMA_BASE_URL", "Ollama (local)"],
			["ELIZAOS_CLOUD_API_KEY", "elizaOS Cloud"]
		];
		console.log(`${getLogPrefix()} Model providers:`);
		for (const [key, name] of envKeys) {
			const status = process.env[key] ? "configured" : "not set";
			console.log(`  ${name}: ${status}`);
		}
	});
}
var init_register_models = __esmMin((() => {
	init_log_prefix();
}));

//#endregion
//#region node_modules/.bun/@elizaos+app-core@2.0.0-alpha.537+72829346cb4c43b1/node_modules/@elizaos/app-core/packages/app-core/src/cli/program/register.subclis.js
function resolveActionArgs(command) {
	return command?.args ?? [];
}
function removeCommand(program, command) {
	const commands = program.commands;
	const index = commands.indexOf(command);
	if (index >= 0) commands.splice(index, 1);
}
async function registerSubCliByName(program, name) {
	const entry = entries.find((e) => e.name === name);
	if (!entry) return false;
	const existing = program.commands.find((cmd) => cmd.name() === entry.name);
	if (existing) removeCommand(program, existing);
	await entry.register(program);
	return true;
}
function registerLazyCommand(program, entry) {
	const placeholder = program.command(entry.name).description(entry.description);
	placeholder.allowUnknownOption(true);
	placeholder.allowExcessArguments(true);
	placeholder.action(async (...actionArgs) => {
		removeCommand(program, placeholder);
		await entry.register(program);
		const actionCommand = actionArgs.at(-1);
		const rawArgs = (actionCommand?.parent ?? program).rawArgs;
		const actionArgsList = resolveActionArgs(actionCommand);
		const fallbackArgv = actionCommand?.name() ? [actionCommand.name(), ...actionArgsList] : actionArgsList;
		const parseArgv = buildParseArgv({
			programName: program.name(),
			rawArgs,
			fallbackArgv
		});
		await program.parseAsync(parseArgv);
	});
}
function registerSubCliCommands(program, argv = process.argv) {
	if (isTruthyEnvValue(process.env.ELIZA_DISABLE_LAZY_SUBCOMMANDS)) {
		for (const entry of entries) entry.register(program);
		return;
	}
	if (!hasHelpOrVersion(argv)) {
		const primary = getPrimaryCommand(argv);
		const entry = primary ? entries.find((e) => e.name === primary) : void 0;
		if (entry) {
			registerLazyCommand(program, entry);
			return;
		}
	}
	for (const entry of entries) registerLazyCommand(program, entry);
}
var entries;
var init_register_subclis = __esmMin((() => {
	init_argv();
	entries = [{
		name: "plugins",
		description: "Plugin management (elizaOS plugins)",
		register: async (program) => {
			(await Promise.resolve().then(() => (init_plugins_cli(), plugins_cli_exports))).registerPluginsCli(program);
		}
	}, {
		name: "models",
		description: "Model configuration",
		register: async (program) => {
			(await Promise.resolve().then(() => (init_register_models(), register_models_exports))).registerModelsCli(program);
		}
	}];
}));

//#endregion
//#region node_modules/.bun/@elizaos+app-core@2.0.0-alpha.537+72829346cb4c43b1/node_modules/@elizaos/app-core/packages/app-core/src/cli/version.js
var CLI_VERSION;
var init_version = __esmMin((() => {
	CLI_VERSION = resolveElizaVersion(import.meta.url);
}));

//#endregion
//#region node_modules/.bun/@elizaos+app-core@2.0.0-alpha.537+72829346cb4c43b1/node_modules/@elizaos/app-core/packages/app-core/src/terminal/palette.js
var CLI_PALETTE;
var init_palette = __esmMin((() => {
	CLI_PALETTE = {
		accent: "#FF5A2D",
		accentBright: "#FF7A3D",
		accentDim: "#D14A22",
		info: "#FF8A5B",
		success: "#2FBF71",
		warn: "#FFB020",
		error: "#E23D2D",
		muted: "#8B7F77"
	};
}));

//#endregion
//#region node_modules/.bun/@elizaos+app-core@2.0.0-alpha.537+72829346cb4c43b1/node_modules/@elizaos/app-core/packages/app-core/src/terminal/theme.js
var hasForceColor, baseChalk, hex, theme, cyberGreen, isRich;
var init_theme = __esmMin((() => {
	init_palette();
	hasForceColor = typeof process.env.FORCE_COLOR === "string" && process.env.FORCE_COLOR.trim().length > 0 && process.env.FORCE_COLOR.trim() !== "0";
	baseChalk = process.env.NO_COLOR !== void 0 && !hasForceColor ? new Chalk({ level: 0 }) : chalk;
	hex = (value) => baseChalk.hex(value);
	theme = {
		accent: hex(CLI_PALETTE.accent),
		accentBright: hex(CLI_PALETTE.accentBright),
		accentDim: hex(CLI_PALETTE.accentDim),
		info: hex(CLI_PALETTE.info),
		success: hex(CLI_PALETTE.success),
		warn: hex(CLI_PALETTE.warn),
		error: hex(CLI_PALETTE.error),
		muted: hex(CLI_PALETTE.muted),
		heading: baseChalk.bold.hex(CLI_PALETTE.accent),
		command: hex(CLI_PALETTE.accentBright),
		option: hex(CLI_PALETTE.warn)
	};
	cyberGreen = hex("#00FF41");
	isRich = () => Boolean(baseChalk.level > 0);
}));

//#endregion
//#region node_modules/.bun/@elizaos+app-core@2.0.0-alpha.537+72829346cb4c43b1/node_modules/@elizaos/app-core/packages/app-core/src/cli/cli-utils.js
async function runCommandWithRuntime(runtime, action, onError) {
	try {
		await action();
	} catch (err) {
		if (onError) {
			onError(err);
			return;
		}
		runtime.error(String(err));
		runtime.exit(1);
	}
}
var init_cli_utils = __esmMin((() => {}));

//#endregion
//#region node_modules/.bun/@elizaos+app-core@2.0.0-alpha.537+72829346cb4c43b1/node_modules/@elizaos/app-core/packages/app-core/src/cli/program/register.auth.js
/**
* `eliza auth` subcommand.
*
* Currently exposes:
*   - `eliza auth reset` — loopback-only recovery path.
*
* The reset command revokes every active session and immediately rejects
* the legacy static API token. It does NOT touch identities or password
* hashes — the operator can still log in afterwards via password or SSO.
*
* Hard rules:
*   - Refuse to run when `ELIZA_API_BIND` resolves to a non-loopback host.
*     A remote attacker over the network has no filesystem on the server,
*     so combined with the proof step this is a meaningful trust boundary.
*   - Filesystem proof: print a fresh 32-byte hex challenge token; require
*     it to be written verbatim into `<state>/auth/RESET_PROOF.txt`; verify
*     contents and only then proceed. The file is deleted as part of the
*     successful path.
*/
/** Resolve the eliza state dir without importing service modules. */
function resolveElizaStateDir() {
	const explicit = process.env.ELIZA_STATE_DIR?.trim();
	if (explicit) return path.resolve(explicit);
	const home = process.env.HOME?.trim() || process.env.USERPROFILE?.trim() || process.cwd();
	return path.join(home, ".eliza");
}
/**
* Open a pglite-backed AuthStore against the configured state dir. Falls
* back to throwing if the runtime adapter or schema isn't available — we
* don't silently no-op a security operation.
*/
async function openAuthStoreFromCli() {
	const { createDatabaseAdapter, DatabaseMigrationService, plugin } = await import("@elizaos/plugin-sql");
	const { AuthStore } = await Promise.resolve().then(() => (init_auth_store(), auth_store_exports));
	const stateDir = resolveElizaStateDir();
	const dataDir = path.join(stateDir, "db");
	await fs$1.mkdir(dataDir, {
		recursive: true,
		mode: 448
	});
	const adapter = createDatabaseAdapter({ dataDir }, "00000000-0000-0000-0000-000000000001");
	if (typeof adapter.initialize === "function") await adapter.initialize();
	else if (typeof adapter.init === "function") await adapter.init();
	if (!adapter.db) throw new Error("CLI auth: adapter has no .db handle");
	const db = adapter.db;
	const migrations = new DatabaseMigrationService();
	await migrations.initializeWithDatabase(db);
	migrations.discoverAndRegisterPluginSchemas([plugin]);
	await migrations.runAllPluginMigrations();
	return {
		store: new AuthStore(db),
		close: async () => {
			try {
				await adapter.close?.();
			} catch {}
		}
	};
}
/**
* Wait for the operator to write the challenge token into the proof file.
* Returns true on match, false on timeout or read failure.
*/
async function waitForProofMatch(options) {
	const interval = options.pollIntervalMs ?? 500;
	const timeoutMs = options.timeoutMs ?? 300 * 1e3;
	const start = Date.now();
	while (Date.now() - start < timeoutMs) {
		const seen = await options.reader();
		if (seen !== null && seen.trim() === options.challenge) return true;
		await new Promise((resolve) => setTimeout(resolve, interval));
	}
	return false;
}
/**
* Test-callable entry point. Real CLI action wraps this in commander glue.
*/
async function runElizaAuthReset(params = {}) {
	const log = params.log ?? ((line) => console.log(line));
	const bind = resolveApiBindHost(params.env ?? process.env);
	if (!isLoopbackBindHost(bind)) return {
		ok: false,
		reason: "not_loopback",
		message: `refusing to run: ELIZA_API_BIND=${bind} is not a loopback address`
	};
	const challenge = params.challenge ?? crypto.randomBytes(32).toString("hex");
	const stateDir = resolveElizaStateDir();
	const proofPath = path.join(stateDir, "auth", RESET_PROOF_FILENAME);
	log(theme.heading("Eliza auth reset"));
	log(theme.muted("This revokes every active session and retires the legacy"));
	log(theme.muted("static API token immediately. Identities and password"));
	log(theme.muted("hashes are NOT touched — log in afterwards as usual."));
	log("");
	log("To prove filesystem access, write the following 32-byte hex token");
	log(`into ${theme.command(proofPath)} and then re-run this command:`);
	log("");
	log(`  ${theme.command(challenge)}`);
	log("");
	if (!await waitForProofMatch({
		proofPath,
		challenge,
		reader: params.proofReader ?? (async () => {
			try {
				return await fs$1.readFile(proofPath, "utf8");
			} catch (err) {
				if (err.code === "ENOENT") return null;
				throw err;
			}
		}),
		log,
		pollIntervalMs: params.proofPollIntervalMs,
		timeoutMs: params.proofTimeoutMs
	})) return {
		ok: false,
		reason: "proof_failed",
		message: "filesystem proof was not written within the timeout"
	};
	let store = params.store;
	let cleanup = params.cleanup;
	if (!store) {
		const opened = await openAuthStoreFromCli();
		store = opened.store;
		cleanup = opened.close;
	}
	const now = Date.now();
	const owners = await store.listIdentitiesByKind("owner");
	let revoked = 0;
	for (const ident of owners) revoked += await store.revokeAllSessionsForIdentity(ident.id, now);
	const machines = await store.listIdentitiesByKind("machine");
	for (const ident of machines) revoked += await store.revokeAllSessionsForIdentity(ident.id, now);
	const { markLegacyBearerInvalidated } = await Promise.resolve().then(() => (init_auth(), auth_exports));
	await markLegacyBearerInvalidated(store, {
		actorIdentityId: null,
		ip: null,
		userAgent: "eliza-cli auth reset"
	});
	const { appendAuditEvent } = await Promise.resolve().then(() => (init_auth(), auth_exports));
	await appendAuditEvent({
		actorIdentityId: null,
		ip: null,
		userAgent: "eliza-cli auth reset",
		action: "auth.reset.cli",
		outcome: "success",
		metadata: { revoked }
	}, { store });
	if (!params.skipProofCleanup) await fs$1.rm(proofPath, { force: true });
	if (cleanup) await cleanup();
	log("");
	log(theme.success(`auth reset complete — revoked ${revoked} session(s)`));
	return { ok: true };
}
function registerAuthCommand(program) {
	program.command("auth").description("Manage Eliza auth state").command("reset").description("Revoke all sessions and retire the legacy static token (loopback only)").action(async () => {
		await runCommandWithRuntime(defaultRuntime$4, async () => {
			const result = await runElizaAuthReset();
			if (!result.ok) {
				console.error(theme.error(result.message ?? "auth reset failed"));
				process.exitCode = 1;
			}
		});
	});
}
var defaultRuntime$4, RESET_PROOF_FILENAME;
var init_register_auth = __esmMin((() => {
	init_theme();
	init_cli_utils();
	defaultRuntime$4 = {
		error: console.error,
		exit: process.exit
	};
	RESET_PROOF_FILENAME = "RESET_PROOF.txt";
}));

//#endregion
//#region node_modules/.bun/@elizaos+app-core@2.0.0-alpha.537+72829346cb4c43b1/node_modules/@elizaos/app-core/packages/app-core/src/cli/program/register.benchmark.js
function registerBenchmarkCommand(program) {
	program.command("benchmark").description("Run a benchmark task headlessly against the agent").option("--task <path>", "Path to task JSON file").option("--server", "Keep runtime alive and accept tasks via stdin (line-delimited JSON)").option("--timeout <ms>", "Timeout per task in milliseconds", "120000").action(async (opts) => {
		const { runBenchmark } = await import("@elizaos/agent/cli/benchmark");
		await runBenchmark(opts);
	});
}
var init_register_benchmark = __esmMin((() => {}));

//#endregion
//#region node_modules/.bun/@elizaos+app-core@2.0.0-alpha.537+72829346cb4c43b1/node_modules/@elizaos/app-core/packages/app-core/src/cli/program/register.config.js
function registerConfigCli(program) {
	const config = program.command("config").description("Config helpers (get/path)");
	config.command("get <key>").description("Get a config value").action(async (key) => {
		const { loadElizaConfig } = await import("@elizaos/agent/config/config");
		let elizaConfig;
		try {
			elizaConfig = loadElizaConfig();
		} catch (err) {
			const detail = err instanceof Error ? err.message : String(err);
			console.error(`${getLogPrefix()} Could not load config: ${detail}`);
			process.exit(1);
		}
		const parts = key.split(".");
		let value = elizaConfig;
		for (const part of parts) if (value && typeof value === "object") value = value[part];
		else {
			value = void 0;
			break;
		}
		if (value === void 0) console.log(`${theme.muted("(not set)")}`);
		else console.log(typeof value === "object" ? JSON.stringify(value, null, 2) : String(value));
	});
	config.command("path").description("Print the resolved config file path").action(async () => {
		const { resolveConfigPath } = await import("@elizaos/agent/config/paths");
		console.log(resolveConfigPath());
	});
	config.command("show").description("Display all configuration values grouped by section").option("-a, --all", "Include advanced/hidden fields").option("--json", "Output as raw JSON").action(async (opts) => {
		const { loadElizaConfig } = await import("@elizaos/agent/config/config");
		const { buildConfigSchema } = await import("@elizaos/agent/config/schema");
		let config;
		try {
			config = loadElizaConfig();
		} catch (err) {
			console.error(theme.error(`Could not load config: ${err instanceof Error ? err.message : String(err)}`));
			process.exit(1);
		}
		if (opts.json) {
			console.log(JSON.stringify(config, null, 2));
			return;
		}
		const { uiHints } = buildConfigSchema();
		displayConfig(config ?? {}, uiHints, { showAdvanced: !!opts.all });
	});
}
/**
* Flatten a nested object to dot-notation keys.
*/
function flattenConfig(obj, prefix = "") {
	const result = {};
	if (obj === null || typeof obj !== "object") return { [prefix]: obj };
	for (const [key, value] of Object.entries(obj)) {
		const path = prefix ? `${prefix}.${key}` : key;
		if (value !== null && typeof value === "object" && !Array.isArray(value)) Object.assign(result, flattenConfig(value, path));
		else result[path] = value;
	}
	return result;
}
/**
* Infer a group name from a key path (e.g., "gateway.auth.token" → "Gateway").
*/
function inferGroup(key) {
	const segments = key.split(".");
	if (segments.length === 0) return "General";
	const first = segments[0];
	return first.charAt(0).toUpperCase() + first.slice(1);
}
/**
* Display config values grouped by section.
*/
function displayConfig(config, uiHints, opts) {
	const flat = flattenConfig(config);
	const groups = /* @__PURE__ */ new Map();
	for (const [key, value] of Object.entries(flat)) {
		const hint = uiHints[key];
		if (hint?.hidden) continue;
		if (!opts.showAdvanced && hint?.advanced) continue;
		const group = hint?.group ?? inferGroup(key);
		if (!groups.has(group)) groups.set(group, []);
		groups.get(group)?.push([key, value]);
	}
	const sortedGroups = Array.from(groups.entries()).sort((a, b) => a[0].localeCompare(b[0]));
	for (const [groupName, fields] of sortedGroups) {
		console.log(`\n${theme.heading(groupName)}`);
		for (const [key, value] of fields) {
			const hint = uiHints[key];
			const label = hint?.label ?? key;
			const isSensitive = hint?.sensitive ?? false;
			const isSet = value !== void 0 && value !== null && value !== "";
			let displayValue;
			if (!isSet) displayValue = theme.muted("(not set)");
			else if (isSensitive) displayValue = theme.muted("●●●●●●●●");
			else if (typeof value === "object") displayValue = JSON.stringify(value);
			else displayValue = String(value);
			const help = hint?.help ? `  ${theme.muted(`(${hint.help})`)}` : "";
			const paddedLabel = label.padEnd(24);
			console.log(`  ${theme.accent(paddedLabel)} ${displayValue}${help}`);
		}
	}
	console.log();
}
var init_register_config = __esmMin((() => {
	init_theme();
	init_log_prefix();
}));

//#endregion
//#region node_modules/.bun/@elizaos+app-core@2.0.0-alpha.537+72829346cb4c43b1/node_modules/@elizaos/app-core/packages/app-core/src/terminal/links.js
function formatTerminalLink(label, url, opts) {
	const safeLabel = label.replaceAll("\x1B", "");
	const safeUrl = url.replaceAll("\x1B", "");
	if (!(opts?.force ?? Boolean(process.stdout.isTTY))) return opts?.fallback ?? `${safeLabel} (${safeUrl})`;
	return `\u001b]8;;${safeUrl}\u0007${safeLabel}\u001b]8;;\u0007`;
}
function formatDocsLink(path, label, opts) {
	const trimmed = path.trim();
	const url = trimmed.startsWith("http") ? trimmed : `${DOCS_ROOT}${trimmed.startsWith("/") ? trimmed : `/${trimmed}`}`;
	return formatTerminalLink(label ?? url, url, {
		fallback: opts?.fallback ?? url,
		force: opts?.force
	});
}
var DOCS_ROOT;
var init_links = __esmMin((() => {
	DOCS_ROOT = "https://docs.eliza.ai";
}));

//#endregion
//#region node_modules/.bun/@elizaos+app-core@2.0.0-alpha.537+72829346cb4c43b1/node_modules/@elizaos/app-core/packages/app-core/src/cli/program/register.configure.js
function registerConfigureCommand(program) {
	program.command("configure").description("Configuration guidance").addHelpText("after", () => `\n${theme.muted("Docs:")} ${formatDocsLink("/configuration", "docs.eliza.ai/configuration")}\n`).action(() => {
		console.log(`\n${theme.heading("Configuration")}\n`);
		console.log("Set values with:");
		console.log(`  ${theme.command("eliza config get <key>")}     Read a config value`);
		console.log(`  Edit ~/.eliza/eliza.json directly for full control.\n`);
		console.log("Common environment variables:");
		console.log(`  ${theme.command("ANTHROPIC_API_KEY")}    Anthropic (Claude)`);
		console.log(`  ${theme.command("OPENAI_API_KEY")}       OpenAI (GPT)`);
		console.log(`  ${theme.command("AI_GATEWAY_API_KEY")}   Vercel AI Gateway`);
		console.log(`  ${theme.command("GOOGLE_API_KEY")}       Google (Gemini)\n`);
	});
}
var init_register_configure = __esmMin((() => {
	init_links();
	init_theme();
}));

//#endregion
//#region node_modules/.bun/@elizaos+app-core@2.0.0-alpha.537+72829346cb4c43b1/node_modules/@elizaos/app-core/packages/app-core/src/utils/eliza-root.js
var eliza_root_exports = /* @__PURE__ */ __exportAll({
	resolveElizaPackageRoot: () => resolveElizaPackageRoot,
	resolveElizaPackageRootSync: () => resolveElizaPackageRootSync
});
async function readPackageName(dir) {
	try {
		const raw = await fs$1.readFile(path.join(dir, "package.json"), "utf-8");
		const parsed = JSON.parse(raw);
		return typeof parsed.name === "string" ? parsed.name : null;
	} catch {
		return null;
	}
}
function readPackageNameSync(dir) {
	try {
		const raw = fs.readFileSync(path.join(dir, "package.json"), "utf-8");
		const parsed = JSON.parse(raw);
		return typeof parsed.name === "string" ? parsed.name : null;
	} catch {
		return null;
	}
}
function listAncestorDirs(startDir, maxDepth = 12) {
	const dirs = [];
	let current = path.resolve(startDir);
	for (let i = 0; i < maxDepth; i += 1) {
		dirs.push(current);
		const parent = path.dirname(current);
		if (parent === current) break;
		current = parent;
	}
	return dirs;
}
async function findPackageRoot(startDir, maxDepth = 12) {
	for (const candidate of listAncestorDirs(startDir, maxDepth)) if (await readPackageName(candidate) === CORE_PACKAGE_NAME) return candidate;
	return null;
}
function findPackageRootSync(startDir, maxDepth = 12) {
	for (const candidate of listAncestorDirs(startDir, maxDepth)) if (readPackageNameSync(candidate) === CORE_PACKAGE_NAME) return candidate;
	return null;
}
function candidateDirsFromArgv1(argv1) {
	const normalized = path.resolve(argv1);
	const candidates = [path.dirname(normalized)];
	const parts = normalized.split(path.sep);
	const binIndex = parts.lastIndexOf(".bin");
	if (binIndex > 0 && parts[binIndex - 1] === "node_modules") {
		const binName = path.basename(normalized);
		const nodeModulesDir = parts.slice(0, binIndex).join(path.sep);
		candidates.push(path.join(nodeModulesDir, binName));
	}
	return candidates;
}
function candidateDirsFromOptions(opts) {
	const candidates = [];
	if (opts.moduleUrl) candidates.push(path.dirname(fileURLToPath(opts.moduleUrl)));
	if (opts.argv1) candidates.push(...candidateDirsFromArgv1(opts.argv1));
	if (opts.cwd) candidates.push(opts.cwd);
	return candidates;
}
async function resolveElizaPackageRoot(opts) {
	const candidates = candidateDirsFromOptions(opts);
	for (const candidate of candidates) {
		const found = await findPackageRoot(candidate);
		if (found) return found;
	}
	return null;
}
function resolveElizaPackageRootSync(opts) {
	const candidates = candidateDirsFromOptions(opts);
	for (const candidate of candidates) {
		const found = findPackageRootSync(candidate);
		if (found) return found;
	}
	return null;
}
var CORE_PACKAGE_NAME;
var init_eliza_root = __esmMin((() => {
	CORE_PACKAGE_NAME = "eliza";
}));

//#endregion
//#region node_modules/.bun/@elizaos+app-core@2.0.0-alpha.537+72829346cb4c43b1/node_modules/@elizaos/app-core/packages/app-core/src/cli/program/register.dashboard.js
async function isPortListening(port, host = "127.0.0.1", timeoutMs = 800) {
	const net = await import("node:net");
	return new Promise((resolve) => {
		const socket = new net.Socket();
		socket.setTimeout(timeoutMs);
		socket.once("connect", () => {
			socket.destroy();
			resolve(true);
		});
		socket.once("timeout", () => {
			socket.destroy();
			resolve(false);
		});
		socket.once("error", () => {
			socket.destroy();
			resolve(false);
		});
		socket.connect(port, host);
	});
}
async function openInBrowser(url) {
	const { spawn } = await import("node:child_process");
	const isWin = process.platform === "win32";
	const child = spawn(process.platform === "darwin" ? "open" : isWin ? "cmd" : "xdg-open", isWin ? [
		"/c",
		"start",
		"",
		url
	] : [url], { stdio: "ignore" });
	child.on("error", () => {
		console.log(theme.warn("Could not open browser automatically."));
		console.log(`${theme.muted("Open manually:")} ${url}`);
	});
	child.unref();
}
function registerDashboardCommand(program) {
	program.command("dashboard").description("Open the Control UI in your browser").option("--port <port>", "Server port to check", String(DEFAULT_PORT)).option("--url <url>", "Server URL (overrides --port)").action(async (opts) => {
		const rawPort = Number(opts.port ?? DEFAULT_PORT);
		const port = Number.isFinite(rawPort) && rawPort > 0 && rawPort <= 65535 ? rawPort : DEFAULT_PORT;
		if (opts.url) {
			console.log(`${theme.muted("→")} Opening Control UI: ${opts.url}`);
			openInBrowser(opts.url);
			return;
		}
		if (await isPortListening(port)) {
			const url = `http://localhost:${port}`;
			console.log(`${theme.muted("→")} Opening Control UI: ${url}`);
			openInBrowser(url);
			return;
		}
		if (await isPortListening(APP_DEV_PORT)) {
			const url = `http://localhost:${APP_DEV_PORT}`;
			console.log(`${theme.muted("→")} Opening Control UI (dev server): ${url}`);
			openInBrowser(url);
			return;
		}
		console.log(`${theme.muted("→")} Server not running on port ${port}; starting app dev server…`);
		const path = await import("node:path");
		const fs = await import("node:fs");
		const { resolveElizaPackageRootSync } = await Promise.resolve().then(() => (init_eliza_root(), eliza_root_exports));
		const pkgRoot = resolveElizaPackageRootSync({
			cwd: process.cwd(),
			argv1: process.argv[1],
			moduleUrl: import.meta.url
		});
		if (!pkgRoot) {
			console.log(theme.error("Could not locate eliza package root."));
			process.exitCode = 1;
			return;
		}
		const appDir = path.join(pkgRoot, "apps", "app");
		if (!fs.existsSync(path.join(appDir, "package.json"))) {
			console.log(theme.error("App UI is not available in this installation."));
			console.log(theme.muted("The app dev server requires a development checkout."));
			console.log(theme.muted("Start the agent with `eliza start` and use the API at http://localhost:31337"));
			process.exitCode = 1;
			return;
		}
		const { spawn } = await import("node:child_process");
		const child = spawn("npx", ["vite"], {
			cwd: appDir,
			stdio: [
				"ignore",
				"pipe",
				"pipe"
			],
			env: { ...process.env }
		});
		let opened = false;
		const tryOpen = () => {
			if (opened) return;
			opened = true;
			const devUrl = `http://localhost:${APP_DEV_PORT}`;
			console.log(`${theme.muted("→")} Opening Control UI: ${devUrl}`);
			openInBrowser(devUrl);
		};
		child.stdout?.on("data", (chunk) => {
			const text = chunk.toString();
			process.stdout.write(text);
			if (!opened && text.includes("Local:")) tryOpen();
		});
		child.stderr?.on("data", (chunk) => {
			process.stderr.write(chunk.toString());
		});
		child.on("error", (err) => {
			console.log(theme.error(`Failed to start app dev server: ${err.message}`));
			process.exitCode = 1;
		});
		setTimeout(tryOpen, 1e4);
		const cleanup = () => {
			child.kill("SIGTERM");
		};
		process.on("SIGINT", cleanup);
		process.on("SIGTERM", cleanup);
	});
}
var DEFAULT_PORT, APP_DEV_PORT;
var init_register_dashboard = __esmMin((() => {
	init_theme();
	DEFAULT_PORT = 2138;
	APP_DEV_PORT = 2138;
}));

//#endregion
//#region node_modules/.bun/@elizaos+app-core@2.0.0-alpha.537+72829346cb4c43b1/node_modules/@elizaos/app-core/packages/app-core/src/cli/program/register.db.js
function resolveDbDir(env = process.env) {
	const stateDir = env.ELIZA_STATE_DIR ?? path.join(os.homedir(), ".eliza");
	return path.join(stateDir, "workspace", ".eliza", ".elizadb");
}
function registerDbCommand(program) {
	program.command("db").description("Database management").command("reset").description("Delete the local agent database (will be re-created on next start)").option("--yes", "Skip confirmation prompt").action(async (opts) => {
		await runCommandWithRuntime(defaultRuntime$3, async () => {
			const dbDir = resolveDbDir();
			if (!fs.existsSync(dbDir)) {
				console.log(`${theme.muted("→")} Database not found at ${dbDir} — nothing to reset.`);
				return;
			}
			if (!opts.yes) {
				const { createInterface } = await import("node:readline");
				const rl = createInterface({
					input: process.stdin,
					output: process.stdout
				});
				if (!await new Promise((resolve) => {
					rl.question(`${theme.warn("⚠")}  This will delete ${theme.command(dbDir)}.\n   All agent memory and conversation history will be lost.\n   Continue? ${theme.muted("(y/N) ")}`, (answer) => {
						rl.close();
						resolve(answer.trim().toLowerCase() === "y");
					});
				})) {
					console.log(`${theme.muted("→")} Cancelled.`);
					return;
				}
			}
			fs.rmSync(dbDir, {
				recursive: true,
				force: true
			});
			console.log(`${theme.success("✓")} Database deleted: ${dbDir}`);
			console.log(`${theme.muted("→")} Run ${theme.command("eliza start")} to initialize a fresh database.`);
		});
	});
}
var defaultRuntime$3;
var init_register_db = __esmMin((() => {
	init_theme();
	init_cli_utils();
	defaultRuntime$3 = {
		error: console.error,
		exit: process.exit
	};
}));

//#endregion
//#region node_modules/.bun/@elizaos+app-core@2.0.0-alpha.537+72829346cb4c43b1/node_modules/@elizaos/app-core/packages/app-core/src/cli/doctor/checks.js
/**
* Health check functions for `eliza doctor`.
*
* All functions are pure / injectable — no top-level side effects — so they
* can be unit-tested without touching the filesystem or network.
*/
var checks_exports = /* @__PURE__ */ __exportAll({
	MODEL_KEY_VARS: () => MODEL_KEY_VARS,
	checkBuildArtifacts: () => checkBuildArtifacts,
	checkConfigFile: () => checkConfigFile,
	checkDatabase: () => checkDatabase,
	checkDiskSpace: () => checkDiskSpace,
	checkElizaWorkspace: () => checkElizaWorkspace,
	checkHostConfig: () => checkHostConfig,
	checkModelKey: () => checkModelKey,
	checkNodeModules: () => checkNodeModules,
	checkPort: () => checkPort,
	checkRuntime: () => checkRuntime,
	checkStateDir: () => checkStateDir,
	getPortOwner: () => getPortOwner,
	runAllChecks: () => runAllChecks
});
function checkRuntime() {
	if ("Bun" in globalThis) {
		const bun = globalThis.Bun;
		const [major] = bun.version.split(".").map(Number);
		if (major < 1) return {
			label: "Runtime",
			category: "system",
			status: "fail",
			detail: `Bun ${bun.version} (requires >=1.0)`,
			fix: "curl -fsSL https://bun.sh/install | bash"
		};
		return {
			label: "Runtime",
			category: "system",
			status: "pass",
			detail: `Bun ${bun.version}`
		};
	}
	const ver = process$1.version;
	const match = ver.match(/^v(\d+)/);
	if ((match ? Number(match[1]) : 0) < 22) return {
		label: "Runtime",
		category: "system",
		status: "fail",
		detail: `Node.js ${ver} (requires >=22)`,
		fix: "Install Node.js 22+ — https://nodejs.org"
	};
	return {
		label: "Runtime",
		category: "system",
		status: "pass",
		detail: `Node.js ${ver}`
	};
}
function checkNodeModules(projectRoot) {
	const root = projectRoot ?? path.resolve(process$1.env.ELIZA_PROJECT_ROOT ?? process$1.cwd());
	const nmDir = path.join(root, "node_modules");
	if (!existsSync(nmDir)) return {
		label: "node_modules",
		category: "system",
		status: "fail",
		detail: "Not installed",
		fix: "bun install",
		autoFixable: false
	};
	return {
		label: "node_modules",
		category: "system",
		status: "pass",
		detail: nmDir
	};
}
function checkBuildArtifacts(projectRoot) {
	const root = projectRoot ?? path.resolve(process$1.env.ELIZA_PROJECT_ROOT ?? process$1.cwd());
	if (!existsSync(path.join(root, "dist", "entry.js"))) return {
		label: "Build artifacts",
		category: "system",
		status: "warn",
		detail: "dist/entry.js not found — CLI running from source",
		fix: "bun run build"
	};
	return {
		label: "Build artifacts",
		category: "system",
		status: "pass",
		detail: path.join(root, "dist")
	};
}
function checkConfigFile(configPath, env = process$1.env) {
	const resolved = configPath ?? resolveConfigPath(env);
	if (!existsSync(resolved)) return {
		label: "Config file",
		category: "config",
		status: "warn",
		detail: `Not found: ${resolved}`,
		fix: "eliza setup",
		autoFixable: true
	};
	try {
		JSON.parse(readFileSync(resolved, "utf-8"));
		return {
			label: "Config file",
			category: "config",
			status: "pass",
			detail: resolved
		};
	} catch {
		return {
			label: "Config file",
			category: "config",
			status: "fail",
			detail: `Invalid JSON: ${resolved}`,
			fix: `Edit and fix: ${resolved}`
		};
	}
}
function checkModelKey(env = process$1.env) {
	for (const entry of MODEL_KEY_VARS) {
		if ((entry.key === "ELIZAOS_CLOUD_API_KEY" ? getCloudSecret("ELIZAOS_CLOUD_API_KEY") ?? env[entry.key] : env[entry.key])?.trim()) return {
			label: "Model API key",
			category: "config",
			status: "pass",
			detail: `${entry.key} set (${entry.label})`
		};
		if ("alias" in entry && entry.alias && env[entry.alias]?.trim()) return {
			label: "Model API key",
			category: "config",
			status: "pass",
			detail: `${entry.alias} set (${entry.label})`
		};
	}
	return {
		label: "Model API key",
		category: "config",
		status: "fail",
		detail: "No model provider API key found",
		fix: "eliza setup",
		autoFixable: true
	};
}
function checkStateDir(env = process$1.env) {
	const dir = env.ELIZA_STATE_DIR ?? path.join(os.homedir(), ".eliza");
	if (!existsSync(dir)) return {
		label: "State directory",
		category: "storage",
		status: "warn",
		detail: `${dir} (created on first run)`
	};
	try {
		accessSync(dir, constants.W_OK);
		return {
			label: "State directory",
			category: "storage",
			status: "pass",
			detail: dir
		};
	} catch {
		return {
			label: "State directory",
			category: "storage",
			status: "fail",
			detail: `${dir} is not writable`,
			fix: `chmod u+w "${dir}"`
		};
	}
}
function checkDatabase(env = process$1.env) {
	const stateDir = env.ELIZA_STATE_DIR ?? path.join(os.homedir(), ".eliza");
	const dbDir = path.join(stateDir, "workspace", ".eliza", ".elizadb");
	if (!existsSync(dbDir)) return {
		label: "Database",
		category: "storage",
		status: "warn",
		detail: "Not initialized (created automatically on first start)"
	};
	return {
		label: "Database",
		category: "storage",
		status: "pass",
		detail: dbDir
	};
}
function checkDiskSpace(env = process$1.env) {
	const dir = env.ELIZA_STATE_DIR ?? os.homedir();
	try {
		const stats = statfsSync(dir);
		const freeBytes = stats.bsize * stats.bavail;
		const freeGB = (freeBytes / 1024 ** 3).toFixed(1);
		if (freeBytes < MIN_FREE_BYTES) return {
			label: "Disk space",
			category: "storage",
			status: "warn",
			detail: `${freeGB} GB free on state volume (recommend >=1 GB)`
		};
		return {
			label: "Disk space",
			category: "storage",
			status: "pass",
			detail: `${freeGB} GB free`
		};
	} catch {
		return {
			label: "Disk space",
			category: "storage",
			status: "skip",
			detail: "Could not read filesystem stats"
		};
	}
}
function checkHostConfig(env = process$1.env) {
	const config = resolveApiSecurityConfig(env);
	const rawBind = config.bindHost;
	const bindHost = rawBind.replace(/:\d+$/, "").toLowerCase();
	const token = config.token ?? "";
	const allowedHosts = config.allowedHosts.join(",");
	const isWildcard = WILDCARD_BIND_RE.test(bindHost);
	const isLoopback = LOOPBACK_BIND_RE.test(bindHost);
	if (isWildcard && !token) return {
		label: "Host binding",
		category: "config",
		status: "warn",
		detail: `ELIZA_API_BIND=${rawBind} — token is auto-generated each restart`,
		fix: "Set a stable ELIZA_API_TOKEN=<secret> in your environment"
	};
	if (!isLoopback && !isWildcard && !token) return {
		label: "Host binding",
		category: "config",
		status: "warn",
		detail: `ELIZA_API_BIND=${rawBind} without ELIZA_API_TOKEN — token auto-generated each restart`,
		fix: "Set a stable ELIZA_API_TOKEN=<secret>"
	};
	if (allowedHosts) return {
		label: "Host binding",
		category: "config",
		status: "pass",
		detail: `${rawBind} + ELIZA_ALLOWED_HOSTS=${allowedHosts}`
	};
	if (!isLoopback) return {
		label: "Host binding",
		category: "config",
		status: "pass",
		detail: `${rawBind} (token protected)`
	};
	return {
		label: "Host binding",
		category: "config",
		status: "pass",
		detail: "Loopback only (default)"
	};
}
/** Returns the process name holding a port, or null if unknown / not Unix. */
async function getPortOwner(port) {
	if (process$1.platform === "win32") return null;
	try {
		const { execFile } = await import("node:child_process");
		const { promisify } = await import("node:util");
		const execFileAsync = promisify(execFile);
		const { stdout: pidOut } = await execFileAsync("lsof", [
			"-ti",
			`:${port}`,
			"-sTCP:LISTEN"
		]);
		const pid = pidOut.trim().split("\n")[0];
		if (!pid) return null;
		const { stdout: nameOut } = await execFileAsync("ps", [
			"-o",
			"comm=",
			"-p",
			pid
		]);
		const name = nameOut.trim();
		return name ? `${name} (pid ${pid})` : null;
	} catch {
		return null;
	}
}
async function checkPort(port) {
	if (!await new Promise((resolve) => {
		const socket = createConnection({
			port,
			host: "127.0.0.1"
		});
		socket.once("connect", () => {
			socket.destroy();
			resolve(true);
		});
		socket.once("error", () => {
			socket.destroy();
			resolve(false);
		});
	})) return {
		label: `Port ${port}`,
		category: "network",
		status: "pass",
		detail: "Available"
	};
	const owner = await getPortOwner(port);
	return {
		label: `Port ${port}`,
		category: "network",
		status: "warn",
		detail: owner ? `In use by ${owner}` : "In use by another process",
		fix: `ELIZA_PORT=<other> eliza start (current default ${resolveServerOnlyPort(process$1.env)})`
	};
}
function checkElizaWorkspace(projectRoot) {
	const root = projectRoot ?? path.resolve(process$1.env.ELIZA_PROJECT_ROOT ?? process$1.cwd());
	const elizaRoot = path.join(root, "eliza");
	const pluginsRoot = path.join(elizaRoot, "plugins");
	const hasElizaRoot = existsSync(path.join(elizaRoot, "package.json"));
	const hasPluginsRoot = existsSync(pluginsRoot);
	if (!hasElizaRoot && !hasPluginsRoot) return {
		label: "Local upstreams",
		category: "system",
		status: "warn",
		detail: "Vendored source workspace not found at ./eliza (needed only for repo-local @elizaos development)",
		fix: "bun run setup:upstreams"
	};
	if (existsSync(elizaRoot) && !hasElizaRoot) return {
		label: "Local upstreams",
		category: "system",
		status: "warn",
		detail: `${elizaRoot} exists but missing package.json`,
		fix: "bun run setup:upstreams"
	};
	const coreLink = path.join(root, "node_modules", "@elizaos", "core");
	try {
		if (realpathSync(coreLink).startsWith(elizaRoot)) return {
			label: "Local upstreams",
			category: "system",
			status: "pass",
			detail: "Vendored @elizaos/core workspace is active (includes the orchestrator runtime)"
		};
	} catch {}
	return {
		label: "Local upstreams",
		category: "system",
		status: "pass",
		detail: `Found vendored sources at ${[hasElizaRoot ? "./eliza" : null, hasPluginsRoot ? "./eliza/plugins" : null].filter((value) => Boolean(value)).join(" and ")} (run setup:upstreams to refresh workspace links)`
	};
}
async function runAllChecks(opts = {}) {
	const env = opts.env ?? process$1.env;
	const sync = [
		checkRuntime(),
		checkNodeModules(opts.projectRoot),
		checkBuildArtifacts(opts.projectRoot),
		checkElizaWorkspace(opts.projectRoot),
		checkConfigFile(opts.configPath, env),
		checkModelKey(env),
		checkHostConfig(env),
		checkStateDir(env),
		checkDatabase(env),
		checkDiskSpace(env)
	];
	if (opts.checkPorts === false) return sync;
	const portResults = await Promise.all([checkPort(opts.apiPort ?? 31337), checkPort(opts.uiPort ?? 2138)]);
	return [...sync, ...portResults];
}
var MODEL_KEY_VARS, MIN_FREE_BYTES, WILDCARD_BIND_RE, LOOPBACK_BIND_RE;
var init_checks = __esmMin((() => {
	init_cloud_secrets();
	MODEL_KEY_VARS = [
		{
			key: "ANTHROPIC_API_KEY",
			alias: "CLAUDE_API_KEY",
			label: "Anthropic (Claude)"
		},
		{
			key: "OPENAI_API_KEY",
			label: "OpenAI"
		},
		{
			key: "GOOGLE_API_KEY",
			alias: "GOOGLE_GENERATIVE_AI_API_KEY",
			label: "Google (Gemini)"
		},
		{
			key: "GROQ_API_KEY",
			label: "Groq"
		},
		{
			key: "XAI_API_KEY",
			alias: "GROK_API_KEY",
			label: "xAI (Grok)"
		},
		{
			key: "OPENROUTER_API_KEY",
			label: "OpenRouter"
		},
		{
			key: "DEEPSEEK_API_KEY",
			label: "DeepSeek"
		},
		{
			key: "TOGETHER_API_KEY",
			label: "Together AI"
		},
		{
			key: "MISTRAL_API_KEY",
			label: "Mistral"
		},
		{
			key: "COHERE_API_KEY",
			label: "Cohere"
		},
		{
			key: "PERPLEXITY_API_KEY",
			label: "Perplexity"
		},
		{
			key: "ZAI_API_KEY",
			alias: "Z_AI_API_KEY",
			label: "Zai"
		},
		{
			key: "AI_GATEWAY_API_KEY",
			alias: "AIGATEWAY_API_KEY",
			label: "Vercel AI Gateway"
		},
		{
			key: "ELIZAOS_CLOUD_API_KEY",
			label: "elizaOS Cloud"
		},
		{
			key: "OLLAMA_BASE_URL",
			label: "Ollama (local)"
		}
	];
	MIN_FREE_BYTES = 1 * 1024 * 1024 * 1024;
	WILDCARD_BIND_RE = /^(0\.0\.0\.0|::|0:0:0:0:0:0:0:0)$/;
	LOOPBACK_BIND_RE = /^(localhost|127\.0\.0\.1|::1|\[::1\]|0:0:0:0:0:0:0:1)$/;
}));

//#endregion
//#region node_modules/.bun/@elizaos+app-core@2.0.0-alpha.537+72829346cb4c43b1/node_modules/@elizaos/app-core/packages/app-core/src/cli/program/register.doctor.js
function statusIcon(status) {
	switch (status) {
		case "pass": return theme.success("✓");
		case "fail": return theme.error("✗");
		case "warn": return theme.warn("⚠");
		case "skip": return theme.muted("–");
	}
}
function printResult(result) {
	const icon = statusIcon(result.status);
	const label = result.label.padEnd(20);
	const detail = result.detail ? theme.muted(result.detail) : "";
	console.log(`  ${icon} ${label} ${detail}`);
	if (result.fix && result.status !== "pass") console.log(`      ${theme.muted("fix:")} ${theme.command(result.fix)}`);
}
function printGrouped(results) {
	const byCategory = /* @__PURE__ */ new Map();
	const order = [
		"system",
		"config",
		"storage",
		"network"
	];
	for (const cat of order) byCategory.set(cat, []);
	for (const r of results) byCategory.get(r.category)?.push(r);
	let first = true;
	for (const cat of order) {
		const group = byCategory.get(cat);
		if (!group?.length) continue;
		if (!first) console.log();
		first = false;
		console.log(`  ${theme.muted(CATEGORY_LABELS[cat])}`);
		for (const result of group) printResult(result);
	}
}
function attemptFix(result) {
	if (!result.fix || !result.autoFixable) return false;
	if (!result.fix.startsWith("eliza ")) return false;
	const args = result.fix.split(/\s+/).slice(1);
	console.log(`\n  ${theme.muted("→ auto-fix:")} ${theme.command(result.fix)}\n`);
	return spawnSync(process.env.ELIZA_BIN ?? (process.execArgv.length === 0 ? process.argv[1] : null) ?? "eliza", args, { stdio: "inherit" }).status === 0;
}
function registerDoctorCommand(program) {
	program.command("doctor").description("Check environment health and diagnose common issues").option("--no-ports", "Skip port availability checks").option("--fix", "Automatically fix issues where possible").option("--json", "Output results as JSON (CI-friendly)").action(async (opts) => {
		await runCommandWithRuntime(defaultRuntime$2, async () => {
			const { runAllChecks } = await Promise.resolve().then(() => (init_checks(), checks_exports));
			const results = await runAllChecks({ checkPorts: opts.ports });
			if (opts.json) {
				const summary = {
					pass: results.filter((r) => r.status === "pass").length,
					warn: results.filter((r) => r.status === "warn").length,
					fail: results.filter((r) => r.status === "fail").length,
					skip: results.filter((r) => r.status === "skip").length
				};
				process.stdout.write(`${JSON.stringify({
					summary,
					checks: results
				}, null, 2)}\n`);
				if (summary.fail > 0) process.exit(1);
				return;
			}
			console.log(`\n${theme.heading("Eliza Health Check")}\n`);
			printGrouped(results);
			const failures = results.filter((r) => r.status === "fail");
			const warnings = results.filter((r) => r.status === "warn");
			console.log();
			if (failures.length === 0 && warnings.length === 0) console.log(`  ${theme.success("Everything looks good.")} Ready to run ${theme.command("eliza start")}.`);
			else if (failures.length > 0) {
				const plural = failures.length === 1 ? "issue" : "issues";
				console.log(`  ${theme.error(`${failures.length} ${plural} found.`)}${opts.fix ? "" : ` Run ${theme.command("eliza doctor --fix")} to auto-remediate.`}`);
			} else console.log(`  ${theme.warn(`${warnings.length} warning${warnings.length === 1 ? "" : "s"}. Things should still work.`)}`);
			if (opts.fix) {
				const fixable = results.filter((r) => r.status !== "pass" && r.autoFixable);
				if (fixable.length === 0) console.log(`\n  ${theme.muted("No auto-fixable issues. Manual steps shown above.")}`);
				else for (const r of fixable) attemptFix(r);
			}
			console.log();
			if (failures.length > 0) process.exit(1);
		});
	});
}
var defaultRuntime$2, CATEGORY_LABELS;
var init_register_doctor = __esmMin((() => {
	init_theme();
	init_cli_utils();
	defaultRuntime$2 = {
		error: console.error,
		exit: process.exit
	};
	CATEGORY_LABELS = {
		system: "System",
		config: "Configuration",
		storage: "Storage",
		network: "Network"
	};
}));

//#endregion
//#region node_modules/.bun/@elizaos+app-core@2.0.0-alpha.537+72829346cb4c43b1/node_modules/@elizaos/app-core/packages/app-core/src/cli/program/register.setup.js
async function ask(prompt) {
	if (!process.stdin.isTTY) return "";
	const { createInterface } = await import("node:readline");
	const rl = createInterface({
		input: process.stdin,
		output: process.stdout
	});
	return new Promise((resolve) => {
		rl.question(prompt, (answer) => {
			rl.close();
			resolve(answer.trim());
		});
	});
}
async function askSecret(prompt) {
	if (!process.stdin.isTTY) return "";
	const { createInterface } = await import("node:readline");
	process.stdout.write(prompt);
	const rl = createInterface({
		input: process.stdin,
		output: process.stdout,
		terminal: false
	});
	return new Promise((resolve, reject) => {
		let value = "";
		let closed = false;
		const cleanup = () => {
			if (closed) return;
			closed = true;
			process.stdin.setRawMode?.(false);
			process.stdin.removeListener("data", handler);
			rl.close();
		};
		const finish = () => {
			cleanup();
			process.stdout.write("\n");
			resolve(value);
		};
		const handler = (chunk) => {
			try {
				const char = chunk.toString();
				if (char === "\r" || char === "\n") finish();
				else if (char === "") {
					cleanup();
					process.exit(0);
				} else if (char === "") {
					if (value.length > 0) value = value.slice(0, -1);
				} else value += char;
			} catch (error) {
				cleanup();
				reject(error);
			}
		};
		try {
			process.stdin.setRawMode?.(true);
			process.stdin.on("data", handler);
		} catch (error) {
			cleanup();
			reject(error);
		}
	});
}
async function readStdinValue() {
	if (process.stdin.isTTY) return "";
	const chunks = [];
	for await (const chunk of process.stdin) chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
	return Buffer.concat(chunks).toString("utf-8").trim();
}
function loadConfig(configPath) {
	if (!fs.existsSync(configPath)) return {};
	try {
		const raw = fs.readFileSync(configPath, "utf-8");
		const parsed = JSON5.parse(raw);
		return typeof parsed === "object" && parsed !== null ? parsed : {};
	} catch {
		return {};
	}
}
function saveConfig(configPath, config) {
	const dir = path.dirname(configPath);
	if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
	fs.writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf-8");
}
function resolveLaunchCommand(cwd = process.cwd()) {
	const localEntry = path.join(cwd, "eliza.mjs");
	const localPackage = path.join(cwd, "package.json");
	return fs.existsSync(localEntry) && fs.existsSync(localPackage) ? "node eliza.mjs start" : "eliza start";
}
function getEnvSection(config) {
	const env = config.env;
	if (env && typeof env === "object" && !Array.isArray(env)) return { ...env };
	return {};
}
function hasModelKey(env) {
	return [
		"ANTHROPIC_API_KEY",
		"CLAUDE_API_KEY",
		"OPENAI_API_KEY",
		"GOOGLE_API_KEY",
		"GOOGLE_GENERATIVE_AI_API_KEY",
		"GROQ_API_KEY",
		"XAI_API_KEY",
		"GROK_API_KEY",
		"OPENROUTER_API_KEY",
		"DEEPSEEK_API_KEY",
		"TOGETHER_API_KEY",
		"MISTRAL_API_KEY",
		"COHERE_API_KEY",
		"PERPLEXITY_API_KEY",
		"ZAI_API_KEY",
		"Z_AI_API_KEY",
		"AI_GATEWAY_API_KEY",
		"ELIZAOS_CLOUD_API_KEY",
		"OLLAMA_BASE_URL"
	].find((k) => env[k]?.trim()) ?? null;
}
async function runProviderWizard(configPath, options = {}) {
	const prompt = options.ask ?? ask;
	const promptSecret = options.askSecret ?? askSecret;
	const env = options.env ?? process.env;
	const log = options.log ?? console.log;
	const config = loadConfig(configPath);
	const envSection = getEnvSection(config);
	const existingKey = hasModelKey({
		...env,
		...envSection
	});
	if (existingKey) {
		log(`\n${theme.success("✓")} Model API key already set: ${theme.command(existingKey)}`);
		if ((await prompt(`  Reconfigure? ${theme.muted("(y/N) ")}`)).toLowerCase() !== "y") return;
	}
	log(`\n${theme.heading("Model Provider Setup")}\n`);
	log("  Choose your AI model provider:\n");
	PROVIDERS.forEach((p, i) => {
		log(`  ${theme.muted(`${i + 1}.`)} ${p.label}`);
	});
	const choice = await prompt(`\n  Provider ${theme.muted("[1]")} `);
	const index = choice === "" ? 0 : Number(choice) - 1;
	if (Number.isNaN(index) || index < 0 || index >= PROVIDERS.length) {
		log(`${theme.warn("⚠")}  Invalid choice. Skipping model setup.`);
		return;
	}
	const provider = PROVIDERS[index];
	if (provider.key === null) {
		log(`${theme.muted("→")} Skipped. Set a key later with ${theme.command("eliza setup")}.`);
		return;
	}
	const hint = provider.keyHint ? ` ${theme.muted(`(e.g. ${provider.keyHint})`)}` : "";
	const isUrl = provider.key === "OLLAMA_BASE_URL";
	const valueLabel = isUrl ? "Base URL" : "API key";
	let value;
	if (isUrl) {
		value = await prompt(`  ${valueLabel}${hint} ${theme.muted(`[http://localhost:11434]`)} `);
		if (value === "") value = "http://localhost:11434";
	} else value = await promptSecret(`  ${valueLabel}${hint}: `);
	if (!value) {
		log(`${theme.warn("⚠")}  No value entered. Skipping.`);
		return;
	}
	envSection[provider.key] = value;
	config.env = envSection;
	saveConfig(configPath, config);
	log(`${theme.success("✓")} Saved ${theme.command(provider.key)} to ${configPath}`);
}
function registerSetupCommand(program) {
	program.command("setup").description("Initialize ~/.eliza/eliza.json and the agent workspace").addHelpText("after", () => `\n${theme.muted("Docs:")} ${formatDocsLink("/getting-started/setup", "docs.eliza.ai/getting-started/setup")}\n`).option("--workspace <dir>", "Agent workspace directory").option("--provider <name>", "Model provider (non-interactive)").option("--key <value>", "Unsafe: API key or URL via argv (prefer --key-stdin)").option("--key-stdin", "Read the API key or URL from stdin").option("--no-wizard", "Skip the model provider wizard").action(async (opts) => {
		await runCommandWithRuntime(defaultRuntime$1, async () => {
			const { loadElizaConfig } = await Promise.resolve().then(() => (init_config(), config_exports));
			const { ensureAgentWorkspace, resolveDefaultAgentWorkspaceDir } = await import("@elizaos/agent/providers/workspace");
			const configPath = resolveConfigPath$1();
			const keyFromStdin = opts.keyStdin ? await readStdinValue() : "";
			const keyValue = opts.key ?? keyFromStdin;
			if (opts.key && opts.keyStdin) throw new Error("Use either --key or --key-stdin, not both.");
			if (opts.keyStdin && !keyFromStdin) throw new Error("No API key or URL received on stdin.");
			if (opts.provider && keyValue) {
				const providerQuery = opts.provider.toLowerCase();
				const envKey = PROVIDERS.find((p) => p.label.toLowerCase().includes(providerQuery) || (p.key ?? "").toLowerCase().includes(providerQuery))?.key ?? opts.provider.toUpperCase().replace(/[^A-Z0-9]/g, "_") + "_API_KEY";
				const config = loadConfig(configPath);
				const envSection = getEnvSection(config);
				envSection[envKey] = keyValue;
				config.env = envSection;
				saveConfig(configPath, config);
				console.log(`${theme.success("✓")} Saved ${theme.command(envKey)}`);
				if (opts.key) console.log(`${theme.warn("⚠")} ${theme.muted("Passing secrets via --key exposes them in shell history and process lists. Prefer --key-stdin.")}`);
			}
			if (opts.wizard !== false && process.stdin.isTTY && !opts.provider) await runProviderWizard(configPath);
			let config = {};
			try {
				config = loadElizaConfig();
				console.log(`${theme.success("✓")} Config loaded`);
			} catch (err) {
				if (err.code === "ENOENT") console.log(`${theme.muted("→")} No config found, using defaults`);
				else throw err;
			}
			const agents = config.agents;
			const workspaceDir = opts.workspace ?? agents?.defaults?.workspace ?? resolveDefaultAgentWorkspaceDir();
			await ensureAgentWorkspace({ dir: workspaceDir });
			console.log(`${theme.success("✓")} Agent workspace ready: ${workspaceDir}`);
			if (process.stdin.isTTY) {
				console.log(`\n${theme.success("Setup complete.")} Running health check...\n`);
				const { runAllChecks } = await Promise.resolve().then(() => (init_checks(), checks_exports));
				const results = await runAllChecks({ checkPorts: false });
				for (const result of results) {
					const icon = result.status === "pass" ? theme.success("✓") : result.status === "fail" ? theme.error("✗") : theme.warn("⚠");
					const detail = result.detail ? theme.muted(` ${result.detail}`) : "";
					console.log(`  ${icon} ${result.label}${detail}`);
				}
				console.log(`\n  Run ${theme.command(resolveLaunchCommand())} to launch your agent.\n`);
			} else console.log(`\n${theme.success("Setup complete.")}`);
		});
	});
}
var defaultRuntime$1, PROVIDERS;
var init_register_setup = __esmMin((() => {
	init_links();
	init_theme();
	init_cli_utils();
	defaultRuntime$1 = {
		error: console.error,
		exit: process.exit
	};
	PROVIDERS = [
		{
			label: "Anthropic (Claude)",
			key: "ANTHROPIC_API_KEY",
			keyHint: "sk-ant-..."
		},
		{
			label: "OpenAI (GPT)",
			key: "OPENAI_API_KEY",
			keyHint: "sk-..."
		},
		{
			label: "Google (Gemini)",
			key: "GOOGLE_API_KEY",
			keyHint: "AIza..."
		},
		{
			label: "Groq",
			key: "GROQ_API_KEY",
			keyHint: "gsk_..."
		},
		{
			label: "xAI (Grok)",
			key: "XAI_API_KEY",
			keyHint: "xai-..."
		},
		{
			label: "OpenRouter",
			key: "OPENROUTER_API_KEY",
			keyHint: "sk-or-..."
		},
		{
			label: "Mistral",
			key: "MISTRAL_API_KEY",
			keyHint: ""
		},
		{
			label: "Ollama (local, no key)",
			key: "OLLAMA_BASE_URL",
			keyHint: "http://localhost:11434"
		},
		{
			label: "Skip for now",
			key: null,
			keyHint: ""
		}
	];
}));

//#endregion
//#region node_modules/.bun/@elizaos+app-core@2.0.0-alpha.537+72829346cb4c43b1/node_modules/@elizaos/app-core/packages/app-core/src/cli/program/register.start.js
/**
* Generate a random connection key for remote access.
* Only called when explicitly requested via --connection-key flag
* without a value, or when binding to a non-localhost address.
*/
function generateConnectionKey() {
	const generated = crypto.randomBytes(16).toString("hex");
	setApiToken(process.env, generated);
	return generated;
}
/**
* Check if the server is binding to a network-accessible address
* (not localhost), which requires a connection key for security.
*/
function isNetworkBind() {
	return !isLoopbackBindHost(resolveApiBindHost(process.env));
}
function shouldDisableAutoConnectionKey() {
	return resolveApiSecurityConfig(process.env).disableAutoApiToken;
}
async function startAction() {
	if (!resolveApiToken(process.env) && isNetworkBind() && !shouldDisableAutoConnectionKey()) generateConnectionKey();
	const connectionKey = resolveApiToken(process.env);
	await runCommandWithRuntime(defaultRuntime, async () => {
		const { startEliza } = await Promise.resolve().then(() => (init_eliza(), eliza_exports));
		const { ensureAuthPairingCodeForRemoteAccess } = await Promise.resolve().then(() => (init_auth_pairing_compat_routes(), auth_pairing_compat_routes_exports));
		await startEliza({
			serverOnly: true,
			onEmbeddingProgress: (phase, detail) => {
				if (phase === "downloading") console.log(`[eliza] Embedding: ${detail ?? "downloading..."}`);
				else if (phase === "ready") console.log(`[eliza] Embedding model ready`);
			}
		});
		const port = String(resolveServerOnlyPort(process.env));
		const pairing = ensureAuthPairingCodeForRemoteAccess();
		console.log("");
		console.log("╭──────────────────────────────────────────╮");
		console.log("│  Server is running.                      │");
		console.log("│                                          │");
		console.log(`│  Connect at: http://localhost:${port.padEnd(13)}│`);
		if (connectionKey) console.log(`│  Connection key: ${("*".repeat(Math.max(0, connectionKey.length - 4)) + connectionKey.slice(-4)).padEnd(22)}│`);
		if (pairing) console.log(`│  Pairing code: ${pairing.code.padEnd(24)}│`);
		console.log("╰──────────────────────────────────────────╯");
		console.log("");
	});
}
function registerStartCommand(program) {
	program.command("start").description("Start the elizaOS agent runtime").option("--connection-key [key]", "Set or auto-generate a connection key for remote access").addHelpText("after", () => `\n${theme.muted("Docs:")} ${formatDocsLink("/getting-started", "docs.eliza.ai/getting-started")}\n`).action(async (opts) => {
		if (typeof opts.connectionKey === "string" && opts.connectionKey) setApiToken(process.env, opts.connectionKey);
		else if (opts.connectionKey === true) generateConnectionKey();
		await startAction();
	});
	program.command("run").description("Alias for start").option("--connection-key [key]", "Set or auto-generate a connection key for remote access").action(async (opts) => {
		if (typeof opts.connectionKey === "string" && opts.connectionKey) setApiToken(process.env, opts.connectionKey);
		else if (opts.connectionKey === true) generateConnectionKey();
		await startAction();
	});
}
var defaultRuntime;
var init_register_start = __esmMin((() => {
	init_links();
	init_theme();
	init_cli_utils();
	defaultRuntime = {
		error: console.error,
		exit: process.exit
	};
}));

//#endregion
//#region node_modules/.bun/@elizaos+app-core@2.0.0-alpha.537+72829346cb4c43b1/node_modules/@elizaos/app-core/packages/app-core/src/cli/program/register.update.js
function channelLabel(ch) {
	return CHANNEL_LABELS[ch](ch);
}
function parseChannelOrExit(raw) {
	if (ALL_CHANNELS.includes(raw)) return raw;
	console.error(theme.error(`Invalid channel "${raw}". Valid channels: ${ALL_CHANNELS.join(", ")}`));
	process.exit(1);
}
async function updateAction(opts) {
	const { loadElizaConfig, saveElizaConfig } = await import("@elizaos/agent/config/config");
	const { checkForUpdate, resolveChannel } = await import("@elizaos/agent/services/update-checker");
	const { detectInstallMethod, performUpdate } = await import("@elizaos/agent/services/self-updater");
	const config = loadElizaConfig();
	let newChannel;
	if (opts.channel) {
		newChannel = parseChannelOrExit(opts.channel);
		const oldChannel = resolveChannel(config.update);
		if (newChannel !== oldChannel) {
			saveElizaConfig({
				...config,
				update: {
					...config.update,
					channel: newChannel,
					lastCheckAt: void 0,
					lastCheckVersion: void 0
				}
			});
			console.log(`\nRelease channel changed: ${channelLabel(oldChannel)} -> ${channelLabel(newChannel)}`);
			console.log(theme.muted(`  ${CHANNEL_DESCRIPTIONS[newChannel]}\n`));
		}
	}
	const effectiveChannel = newChannel ?? resolveChannel(config.update);
	console.log(`\n${theme.heading("Eliza Update")}  ${theme.muted(`(channel: ${effectiveChannel})`)}`);
	console.log(theme.muted(`Current version: ${CLI_VERSION}\n`));
	console.log("Checking for updates...\n");
	const result = await checkForUpdate({ force: opts.force ?? !!newChannel });
	if (result.error) {
		console.error(theme.warn(`  ${result.error}\n`));
		if (!opts.check) process.exit(1);
		return;
	}
	if (!result.updateAvailable) {
		console.log(theme.success(`  Already up to date! (${CLI_VERSION} is the latest on ${effectiveChannel})\n`));
		return;
	}
	console.log(`  ${theme.accent("Update available:")} ${CLI_VERSION} -> ${theme.success(result.latestVersion ?? "unknown")}`);
	console.log(theme.muted(`  Channel: ${effectiveChannel} | dist-tag: ${result.distTag}\n`));
	if (opts.check) {
		console.log(theme.muted("  Run `eliza update` to install the update.\n"));
		return;
	}
	const method = detectInstallMethod();
	if (method === "local-dev") {
		console.log(theme.warn("  Local development install detected. Use `git pull` to update.\n"));
		return;
	}
	console.log(theme.muted(`  Install method: ${method}`));
	console.log("  Installing update...\n");
	const updateResult = await performUpdate(CLI_VERSION, effectiveChannel, method);
	if (!updateResult.success) {
		console.error(theme.error(`\n  Update failed: ${updateResult.error}\n`));
		console.log(theme.muted(`  Command: ${updateResult.command}\n  You can try running it manually.\n`));
		process.exit(1);
	}
	if (updateResult.newVersion) console.log(theme.success(`\n  Updated successfully! ${CLI_VERSION} -> ${updateResult.newVersion}`));
	else {
		console.log(theme.success("\n  Update command completed successfully."));
		console.log(theme.warn(`  Could not verify the new version. Expected: ${result.latestVersion ?? "unknown"}`));
	}
	console.log(theme.muted("  Restart eliza for the new version to take effect.\n"));
}
async function statusAction() {
	const { loadElizaConfig } = await import("@elizaos/agent/config/config");
	const { resolveChannel, fetchAllChannelVersions } = await import("@elizaos/agent/services/update-checker");
	const { detectInstallMethod } = await import("@elizaos/agent/services/self-updater");
	console.log(`\n${theme.heading("Version Status")}\n`);
	const config = loadElizaConfig();
	const channel = resolveChannel(config.update);
	console.log(`  Installed:  ${theme.accent(CLI_VERSION)}`);
	console.log(`  Channel:    ${channelLabel(channel)}`);
	console.log(`  Install:    ${theme.muted(detectInstallMethod())}`);
	console.log(`\n${theme.heading("Available Versions")}\n`);
	console.log("  Fetching from npm registry...\n");
	const versions = await fetchAllChannelVersions();
	for (const ch of ALL_CHANNELS) {
		const ver = versions[ch] ?? theme.muted("(not published)");
		const marker = ch === channel ? theme.accent(" <-- current") : "";
		console.log(`  ${channelLabel(ch).padEnd(22)} ${ver}${marker}`);
	}
	if (config.update?.lastCheckAt) console.log(`\n  ${theme.muted(`Last checked: ${new Date(config.update.lastCheckAt).toLocaleString()}`)}`);
	console.log();
}
async function channelAction(channelArg) {
	const { loadElizaConfig, saveElizaConfig } = await import("@elizaos/agent/config/config");
	const { resolveChannel } = await import("@elizaos/agent/services/update-checker");
	const config = loadElizaConfig();
	const current = resolveChannel(config.update);
	if (!channelArg) {
		console.log(`\n${theme.heading("Release Channel")}\n`);
		console.log(`  Current: ${channelLabel(current)}`);
		console.log(theme.muted(`  ${CHANNEL_DESCRIPTIONS[current]}\n`));
		console.log("  Available channels:");
		for (const ch of ALL_CHANNELS) {
			const marker = ch === current ? theme.accent(" (active)") : "";
			console.log(`    ${channelLabel(ch)}${marker}  ${theme.muted(CHANNEL_DESCRIPTIONS[ch])}`);
		}
		console.log(`\n  ${theme.muted("Switch with: eliza update channel <stable|beta|nightly>")}\n`);
		return;
	}
	const newChannel = parseChannelOrExit(channelArg);
	if (newChannel === current) {
		console.log(`\n  Already on ${channelLabel(current)} channel. No change needed.\n`);
		return;
	}
	saveElizaConfig({
		...config,
		update: {
			...config.update,
			channel: newChannel,
			lastCheckAt: void 0,
			lastCheckVersion: void 0
		}
	});
	console.log(`\n  Channel changed: ${channelLabel(current)} -> ${channelLabel(newChannel)}`);
	console.log(theme.muted(`  ${CHANNEL_DESCRIPTIONS[newChannel]}`));
	console.log(`\n  ${theme.muted("Run `eliza update` to fetch the latest version from this channel.")}\n`);
}
function registerUpdateCommand(program) {
	const updateCmd = program.command("update").description("Check for and install updates").option("-c, --channel <channel>", "Switch release channel (stable, beta, nightly)").option("--check", "Check for updates without installing").option("--force", "Force update check (bypass interval cache)").action(updateAction);
	updateCmd.command("status").description("Show current version and available updates across all channels").action(statusAction);
	updateCmd.command("channel [channel]").description("View or change the release channel").action(channelAction);
}
var ALL_CHANNELS, CHANNEL_LABELS, CHANNEL_DESCRIPTIONS;
var init_register_update = __esmMin((() => {
	init_theme();
	init_version();
	ALL_CHANNELS = [
		"stable",
		"beta",
		"nightly"
	];
	CHANNEL_LABELS = {
		stable: theme.success,
		beta: theme.warn,
		nightly: theme.accent
	};
	CHANNEL_DESCRIPTIONS = {
		stable: "Production-ready releases. Recommended for most users.",
		beta: "Release candidates. May contain minor issues.",
		nightly: "Latest development builds. May be unstable."
	};
}));

//#endregion
//#region node_modules/.bun/@elizaos+app-core@2.0.0-alpha.537+72829346cb4c43b1/node_modules/@elizaos/app-core/packages/app-core/src/cli/program/command-registry.js
function registerProgramCommands(program, argv = process.argv) {
	registerStartCommand(program);
	registerBenchmarkCommand(program);
	registerSetupCommand(program);
	registerDoctorCommand(program);
	registerDbCommand(program);
	registerConfigureCommand(program);
	registerConfigCli(program);
	registerDashboardCommand(program);
	registerUpdateCommand(program);
	registerAuthCommand(program);
	registerSubCliCommands(program, argv);
}
var init_command_registry = __esmMin((() => {
	init_register_auth();
	init_register_benchmark();
	init_register_config();
	init_register_configure();
	init_register_dashboard();
	init_register_db();
	init_register_doctor();
	init_register_setup();
	init_register_start();
	init_register_subclis();
	init_register_update();
}));

//#endregion
//#region node_modules/.bun/@elizaos+app-core@2.0.0-alpha.537+72829346cb4c43b1/node_modules/@elizaos/app-core/packages/app-core/src/cli/git-commit.js
function formatCommit(value) {
	const trimmed = value?.trim();
	if (!trimmed) return null;
	return trimmed.slice(0, 7);
}
function resolveGitHead(startDir) {
	let current = startDir;
	for (let i = 0; i < 12; i += 1) {
		const gitPath = path.join(current, ".git");
		try {
			const stat = fs.statSync(gitPath);
			if (stat.isDirectory()) return path.join(gitPath, "HEAD");
			if (stat.isFile()) {
				const match = fs.readFileSync(gitPath, "utf-8").match(/gitdir:\s*(.+)/i);
				if (match?.[1]) return path.join(path.resolve(current, match[1].trim()), "HEAD");
			}
		} catch (err) {
			if (err.code !== "ENOENT") throw err;
		}
		const parent = path.dirname(current);
		if (parent === current) break;
		current = parent;
	}
	return null;
}
function readCommitFromPackageJson() {
	try {
		const pkg = createRequire(import.meta.url)("../../package.json");
		return formatCommit(pkg.gitHead ?? pkg.githead);
	} catch (err) {
		if (err.code === "MODULE_NOT_FOUND") return null;
		throw err;
	}
}
function readCommitFromBuildInfo() {
	const req = createRequire(import.meta.url);
	for (const candidate of ["../build-info.json", "./build-info.json"]) try {
		const formatted = formatCommit(req(candidate).commit);
		if (formatted) return formatted;
	} catch (err) {
		if (err.code !== "MODULE_NOT_FOUND") throw err;
	}
	return null;
}
function readCommitFromGitHead(cwd) {
	const headPath = resolveGitHead(cwd);
	if (!headPath) return null;
	const head = fs.readFileSync(headPath, "utf-8").trim();
	if (!head) return null;
	if (head.startsWith("ref:")) {
		const ref = head.replace(/^ref:\s*/i, "").trim();
		const refPath = path.resolve(path.dirname(headPath), ref);
		return formatCommit(fs.readFileSync(refPath, "utf-8").trim());
	}
	return formatCommit(head);
}
function resolveCommitHash(options = {}) {
	if (cachedCommit !== void 0) return cachedCommit;
	const env = options.env ?? process.env;
	cachedCommit = formatCommit(env.GIT_COMMIT?.trim() || env.GIT_SHA?.trim()) ?? readCommitFromBuildInfo() ?? readCommitFromPackageJson() ?? (() => {
		try {
			return readCommitFromGitHead(options.cwd ?? process.cwd());
		} catch (err) {
			if (err.code === "ENOENT") return null;
			throw err;
		}
	})();
	return cachedCommit;
}
var cachedCommit;
var init_git_commit = __esmMin((() => {
	;
}));

//#endregion
//#region node_modules/.bun/@elizaos+app-core@2.0.0-alpha.537+72829346cb4c43b1/node_modules/@elizaos/app-core/packages/app-core/src/cli/banner.js
function formatCliBannerLine(version, options = {}) {
	const commitLabel = options.commit ?? resolveCommitHash({ env: options.env }) ?? "unknown";
	const rich = options.richTty ?? isRich();
	const title = (options.env?.APP_CLI_NAME ?? "eliza").charAt(0).toUpperCase() + (options.env?.APP_CLI_NAME ?? "eliza").slice(1);
	if (rich) return `${theme.heading(title)} ${theme.info(version)} ${theme.muted(`(${commitLabel})`)}`;
	return `${title} ${version} (${commitLabel})`;
}
function emitCliBanner(version, options = {}) {
	if (bannerEmitted) return;
	const argv = options.argv ?? process.argv;
	if (!process.stdout.isTTY) return;
	if (argv.some((a) => a === "--json" || a.startsWith("--json="))) return;
	if (argv.some((a) => a === "--version" || a === "-V" || a === "-v")) return;
	options.richTty ?? isRich();
	const line = formatCliBannerLine(version, options);
	process.stdout.write(`${line}\n\n`);
	bannerEmitted = true;
}
function hasEmittedCliBanner() {
	return bannerEmitted;
}
var bannerEmitted;
var init_banner = __esmMin((() => {
	init_theme();
	init_git_commit();
	bannerEmitted = false;
}));

//#endregion
//#region node_modules/.bun/@elizaos+app-core@2.0.0-alpha.537+72829346cb4c43b1/node_modules/@elizaos/app-core/packages/app-core/src/cli/cli-name.js
function resolveCliName(argv = process.argv) {
	const argv1 = argv[1];
	if (!argv1) return CLI_NAME$1;
	const base = path.basename(argv1).trim();
	return base === CLI_NAME$1 ? base : CLI_NAME$1;
}
function replaceCliName(command, cliName = resolveCliName()) {
	if (!command.trim() || !CLI_PREFIX_RE.test(command)) return command;
	return command.replace(CLI_PREFIX_RE, (_match, runner) => {
		return `${runner ?? ""}${cliName}`;
	});
}
var CLI_NAME$1, CLI_PREFIX_RE;
var init_cli_name = __esmMin((() => {
	CLI_NAME$1 = process.env.APP_CLI_NAME?.trim() || "eliza";
	CLI_PREFIX_RE = /^(?:((?:pnpm|bun|npm|bunx|npx)\s+))?(?:eliza|elizaos)\b/;
}));

//#endregion
//#region node_modules/.bun/@elizaos+app-core@2.0.0-alpha.537+72829346cb4c43b1/node_modules/@elizaos/app-core/packages/app-core/src/cli/program/help.js
function configureProgramHelp(program, programVersion) {
	program.name(CLI_NAME).description("").version(programVersion, "-v, --version").option("--verbose", "Enable informational runtime logs").option("--debug", "Enable debug-level runtime logs").option("--dev", "Dev profile: isolate state under ~/.eliza-dev with separate config and ports").option("--profile <name>", "Use a named profile (isolates state and config under ~/.eliza-<name>)");
	program.option("--no-color", "Disable ANSI colors", false);
	program.configureHelp({
		optionTerm: (option) => theme.option(option.flags),
		subcommandTerm: (cmd) => theme.command(cmd.name())
	});
	program.configureOutput({
		writeOut: (str) => {
			const colored = str.replace(/^Usage:/gm, theme.heading("Usage:")).replace(/^Options:/gm, theme.heading("Options:")).replace(/^Commands:/gm, theme.heading("Commands:"));
			process.stdout.write(colored);
		},
		writeErr: (str) => process.stderr.write(str),
		outputError: (str, write) => write(theme.error(str))
	});
	program.addHelpText("beforeAll", () => {
		if (hasEmittedCliBanner()) return "";
		return `\n${formatCliBannerLine(programVersion, { richTty: isRich() })}\n`;
	});
	const fmtExamples = EXAMPLES.map(([cmd, desc]) => `  ${theme.command(replaceCliName(cmd, CLI_NAME))}\n    ${theme.muted(desc)}`).join("\n");
	program.addHelpText("afterAll", ({ command }) => {
		if (command !== program) return "";
		const docs = formatDocsLink("/cli", "docs.eliza.ai/cli");
		return `\n${theme.heading("Examples:")}\n${fmtExamples}\n\n${theme.muted("Docs:")} ${docs}\n`;
	});
}
var CLI_NAME, EXAMPLES;
var init_help = __esmMin((() => {
	init_links();
	init_theme();
	init_banner();
	init_cli_name();
	CLI_NAME = resolveCliName();
	EXAMPLES = [
		["eliza", "Start Eliza in the interactive TUI."],
		["eliza start", "Start the classic runtime/chat loop."],
		["eliza dashboard", "Open the Control UI in your browser."],
		["eliza setup", "Initialize ~/.eliza/eliza.json and the agent workspace."],
		["eliza config get agents.defaults.model.primary", "Read a config value."],
		["eliza models", "Show configured model providers."],
		["eliza plugins list", "List available plugins."],
		["eliza update", "Check for and install the latest version."],
		["eliza update channel beta", "Switch to the beta release channel."]
	];
}));

//#endregion
//#region node_modules/.bun/@elizaos+app-core@2.0.0-alpha.537+72829346cb4c43b1/node_modules/@elizaos/app-core/packages/app-core/src/utils/globals.js
function setVerbose(v) {
	globalVerbose = v;
}
var globalVerbose;
var init_globals = __esmMin((() => {
	init_theme();
	globalVerbose = false;
}));

//#endregion
//#region node_modules/.bun/@elizaos+app-core@2.0.0-alpha.537+72829346cb4c43b1/node_modules/@elizaos/app-core/packages/app-core/src/services/update-notifier.js
/**
* Fire-and-forget background update check. Prints a one-line notice
* to stderr if a newer version is available (like npm's update-notifier).
*/
var update_notifier_exports = /* @__PURE__ */ __exportAll({ scheduleUpdateNotification: () => scheduleUpdateNotification });
function scheduleUpdateNotification() {
	if (notified) return;
	notified = true;
	let config = {};
	try {
		config = loadElizaConfig();
	} catch {}
	if (config.update?.checkOnStart === false) return;
	if (process.env.CI || !process.stderr.isTTY) return;
	checkForUpdate().then((result) => {
		if (!result.updateAvailable || !result.latestVersion) return;
		const channel = resolveChannel(config.update);
		const suffix = channel !== "stable" ? ` (${channel})` : "";
		process.stderr.write(`\n${theme.accent("Update available:")} ${theme.muted(result.currentVersion)} -> ${theme.success(result.latestVersion)}${theme.muted(suffix)}\n${theme.muted("Run")} ${theme.command("eliza update")} ${theme.muted("to install")}\n\n`);
	}).catch(() => {});
}
var notified;
var init_update_notifier = __esmMin((() => {
	init_theme();
	notified = false;
}));

//#endregion
//#region node_modules/.bun/@elizaos+app-core@2.0.0-alpha.537+72829346cb4c43b1/node_modules/@elizaos/app-core/packages/app-core/src/cli/program/preaction.js
function setProcessTitleForCommand(actionCommand) {
	let current = actionCommand;
	while (current.parent?.parent) current = current.parent;
	const name = current.name();
	const cliName = resolveCliName();
	if (!name || name === cliName) return;
	process.title = `${cliName}-${name}`;
}
function registerPreActionHooks(program, programVersion) {
	program.hook("preAction", async (_thisCommand, actionCommand) => {
		setProcessTitleForCommand(actionCommand);
		const argv = process.argv;
		if (hasHelpOrVersion(argv)) return;
		const commandPath = getCommandPath(argv, 2);
		if (!(isTruthyEnvValue(process.env.ELIZA_HIDE_BANNER) || commandPath[0] === "update" || commandPath[0] === "completion")) {
			emitCliBanner(programVersion);
			const { scheduleUpdateNotification } = await Promise.resolve().then(() => (init_update_notifier(), update_notifier_exports));
			scheduleUpdateNotification();
		}
		const verbose = getVerboseFlag(argv, { includeDebug: true });
		setVerbose(verbose);
		if (!verbose) process.env.NODE_NO_WARNINGS ??= "1";
	});
}
var init_preaction = __esmMin((() => {
	init_globals();
	init_argv();
	init_banner();
	init_cli_name();
}));

//#endregion
//#region node_modules/.bun/@elizaos+app-core@2.0.0-alpha.537+72829346cb4c43b1/node_modules/@elizaos/app-core/packages/app-core/src/cli/program/build-program.js
function buildProgram() {
	const program = new Command();
	configureProgramHelp(program, CLI_VERSION);
	registerPreActionHooks(program, CLI_VERSION);
	registerProgramCommands(program);
	return program;
}
var init_build_program = __esmMin((() => {
	init_version();
	init_command_registry();
	init_help();
	init_preaction();
}));

//#endregion
//#region node_modules/.bun/@elizaos+app-core@2.0.0-alpha.537+72829346cb4c43b1/node_modules/@elizaos/app-core/packages/app-core/src/cli/program.js
var program_exports = /* @__PURE__ */ __exportAll({ buildProgram: () => buildProgram });
var init_program = __esmMin((() => {
	init_build_program();
}));

//#endregion
//#region node_modules/.bun/@elizaos+app-core@2.0.0-alpha.537+72829346cb4c43b1/node_modules/@elizaos/app-core/packages/app-core/src/cli/run-main.js
var run_main_exports = /* @__PURE__ */ __exportAll({ runCli: () => runCli });
function registerCliRestartHandler() {
	if (cliRestartHandlerRegistered) return;
	cliRestartHandlerRegistered = true;
	setRestartHandler((reason) => {
		console.error(`${getLogPrefix()} restart requested: ${reason ?? "unspecified"} — exiting with ${RESTART_EXIT_CODE}`);
		process$1.exit(RESTART_EXIT_CODE);
	});
}
async function loadDotEnv() {
	try {
		const { config } = await import("dotenv");
		config({ quiet: true });
	} catch (err) {
		if (err.code !== "MODULE_NOT_FOUND" && err.code !== "ERR_MODULE_NOT_FOUND") throw err;
	}
}
async function runCli(argv = process$1.argv) {
	registerCliRestartHandler();
	await loadDotEnv();
	if (!process$1.env.ZAI_API_KEY?.trim() && process$1.env.Z_AI_API_KEY?.trim()) process$1.env.ZAI_API_KEY = process$1.env.Z_AI_API_KEY;
	const { buildProgram } = await Promise.resolve().then(() => (init_program(), program_exports));
	const program = buildProgram();
	program.exitOverride();
	process$1.on("unhandledRejection", (reason) => {
		if (shouldIgnoreUnhandledRejection(reason)) {
			console.warn(`${getLogPrefix()} Provider credits appear exhausted; request failed without output. Top up credits and retry.`);
			return;
		}
		console.error(`${getLogPrefix()} Unhandled rejection:`, formatUncaughtError(reason));
		process$1.exit(1);
	});
	process$1.on("uncaughtException", (error) => {
		console.error(`${getLogPrefix()} Uncaught exception:`, formatUncaughtError(error));
		process$1.exit(1);
	});
	const primary = getPrimaryCommand(argv);
	if (primary && !hasHelpOrVersion(argv)) await registerSubCliByName(program, primary);
	try {
		await program.parseAsync(argv);
	} catch (err) {
		if (err && typeof err === "object" && "code" in err && "exitCode" in err) {
			process$1.exitCode = err.exitCode ?? 1;
			return;
		}
		throw err;
	}
}
var cliRestartHandlerRegistered;
var init_run_main = __esmMin((() => {
	init_error_handlers();
	init_log_prefix();
	init_argv();
	init_register_subclis();
	cliRestartHandlerRegistered = false;
}));

//#endregion
//#region node_modules/.bun/@elizaos+app-core@2.0.0-alpha.537+72829346cb4c43b1/node_modules/@elizaos/app-core/packages/app-core/src/entry.js
init_namespace_defaults();
init_log_prefix();
process$1.title = process$1.env.APP_CLI_NAME?.trim() || "eliza";
if (process$1.argv.includes("--no-color")) {
	process$1.env.NO_COLOR = "1";
	process$1.env.FORCE_COLOR = "0";
}
if (!process$1.env.LOG_LEVEL) if (process$1.argv.includes("--debug")) process$1.env.LOG_LEVEL = "debug";
else if (process$1.argv.includes("--verbose")) process$1.env.LOG_LEVEL = "info";
else process$1.env.LOG_LEVEL = "error";
if (!process$1.env.NODE_LLAMA_CPP_LOG_LEVEL) {
	const logLevel = String(process$1.env.LOG_LEVEL).toLowerCase();
	process$1.env.NODE_LLAMA_CPP_LOG_LEVEL = logLevel === "debug" ? "debug" : logLevel === "info" ? "info" : "error";
}
const parsed = parseCliProfileArgs(process$1.argv);
if (!parsed.ok) {
	console.error(`${getLogPrefix()} ${parsed.error}`);
	process$1.exit(2);
}
if (parsed.profile) {
	applyCliProfileEnv({ profile: parsed.profile });
	process$1.argv = parsed.argv;
}
Promise.resolve().then(() => (init_run_main(), run_main_exports)).then(({ runCli }) => runCli(process$1.argv)).catch((error) => {
	console.error(`${getLogPrefix()} Failed to start CLI:`, error instanceof Error ? error.stack ?? error.message : error);
	process$1.exit(1);
});

//#endregion
export {  };