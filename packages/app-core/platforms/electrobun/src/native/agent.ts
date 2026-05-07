/**
 * Agent Native Module for Electrobun
 *
 * Embeds the elizaOS agent runtime as an isolated child process
 * using Bun.spawn() and exposes it to the webview via RPC messages.
 *
 * Instead of dynamically importing the runtime into the main process
 * (which requires fighting ASAR, CJS/ESM mismatch, and NODE_PATH hacks),
 * we spawn a separate Bun process that runs the canonical CLI/server entry
 * (`entry.js start`). This gives us:
 *   - Clean process isolation (native module crashes don't kill the UI)
 *   - No ESM/CJS import gymnastics
 *   - Simple lifecycle management via SIGTERM/SIGKILL
 *   - stdout/stderr streaming for diagnostics
 *
 * The renderer never needs to know whether the API server is embedded or
 * remote -- it simply connects to `http://localhost:{port}`.
 *
 * **Port policy (WHY):** we resolve a **free** loopback desktop API port from
 * `ELIZA_API_PORT`, `ELIZA_API_PORT`, or `ELIZA_PORT` (see
 * `findFirstAvailableLoopbackPort`) instead of SIGKILL-ing listeners by
 * default, so two desktop apps can run side by side. Optional
 * `ELIZA_AGENT_RECLAIM_STALE_PORT=1` (legacy: `ELIZA_AGENT_RECLAIM_STALE_PORT`)
 * restores lsof-based reclaim for single-instance dev.
 */

import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { logger } from "../logger";
import {
	resolveApiToken,
	resolveDesktopApiPort,
	resolveDisableAutoApiToken,
	setApiToken,
} from "@elizaos/shared";

import { resolveDesktopRuntimeMode } from "../api-base";
import { getBrandConfig } from "../brand-config";
import { DEFAULT_API_PORT } from "../constants";
import { recordStartupPhase, resolveStartupBundlePath } from "../startup-trace";
import type { SendToWebview } from "../types.js";
import { findFirstAvailableLoopbackPort } from "./loopback-port";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface AgentStatus {
	state: "not_started" | "starting" | "running" | "stopped" | "error";
	agentName: string | null;
	port: number | null;
	startedAt: number | null;
	error: string | null;
}

export interface StartupDiagnosticsSnapshot {
	state: AgentStatus["state"];
	phase: string;
	updatedAt: string;
	lastError: string | null;
	agentName: string | null;
	port: number | null;
	startedAt: number | null;
	platform: string;
	arch: string;
	configDir: string;
	logPath: string;
	statusPath: string;
}

export interface BugReportBundleResult {
	directory: string;
	reportMarkdownPath: string;
	reportJsonPath: string;
	startupLogPath: string | null;
	startupStatusPath: string | null;
}

import type {
	ExistingElizaInstallInfo,
	ExistingElizaInstallSource,
} from "../rpc-schema";

export type { ExistingElizaInstallInfo, ExistingElizaInstallSource };

// Subprocess type from Bun.spawn
type BunSubprocess = ReturnType<typeof Bun.spawn>;

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const HEALTH_POLL_INTERVAL_MS = process.platform === "win32" ? 2_000 : 500;
const SIGTERM_GRACE_MS = 5_000;
const AGENT_NAME_FETCH_TIMEOUT_MS = 5_000;
const WINDOWS_ABS_PATH_RE = /^[A-Za-z]:[\\/]/;
const ELIZA_CONFIG_FILENAME = "eliza.json";

export function getHealthPollTimeoutMs(
	env: NodeJS.ProcessEnv = process.env,
	platform: string = process.platform,
): number {
	const raw = env.ELIZA_AGENT_HEALTH_TIMEOUT_MS?.trim();
	if (raw) {
		const parsed = Number.parseInt(raw, 10);
		if (Number.isFinite(parsed) && parsed > 0) {
			return parsed;
		}
	}

	// Windows packaged first-run startup can include PGLite initialization plus
	// a GGUF embedding model download before /api/health comes online.
	return platform === "win32" ? 240_000 : 120_000;
}

function isPosixAbsolutePath(value: string): boolean {
	return value.startsWith("/") && !WINDOWS_ABS_PATH_RE.test(value);
}

function resolvePortablePath(value: string): string {
	if (isPosixAbsolutePath(value) || WINDOWS_ABS_PATH_RE.test(value)) {
		return value;
	}
	return path.resolve(value);
}

function dirnamePortable(value: string): string {
	return isPosixAbsolutePath(value)
		? path.posix.dirname(value)
		: path.dirname(value);
}

function joinPortable(base: string, ...parts: string[]): string {
	return isPosixAbsolutePath(base)
		? path.posix.join(base, ...parts)
		: path.join(base, ...parts);
}

function resolveRelativePortable(base: string, relativePath: string): string {
	return isPosixAbsolutePath(base)
		? path.posix.resolve(base, relativePath)
		: path.resolve(base, relativePath);
}

function getDefaultModuleDir(): string {
	return import.meta.dir ?? path.join(process.cwd(), "src");
}

function normalizeEnvPath(value: string | undefined): string | null {
	const trimmed = value?.trim();
	return trimmed ? resolvePortablePath(trimmed) : null;
}

function listStateEntries(stateDir: string): string[] {
	try {
		return fs
			.readdirSync(stateDir)
			.filter(
				(entry) => entry !== "." && entry !== ".." && entry !== ".DS_Store",
			);
	} catch {
		return [];
	}
}

function buildExistingElizaInstallCandidates(opts?: {
	env?: NodeJS.ProcessEnv;
	homedir?: string;
}): Array<{
	source: ExistingElizaInstallSource;
	stateDir: string;
	configPath: string;
}> {
	const env = opts?.env ?? process.env;
	const homedir = opts?.homedir ?? os.homedir();
	const configPathFromEnv =
		normalizeEnvPath(env.ELIZA_CONFIG_PATH) ??
		normalizeEnvPath(env.ELIZA_CONFIG_PATH);
	const stateDirFromEnv =
		normalizeEnvPath(env.ELIZA_STATE_DIR) ??
		normalizeEnvPath(env.ELIZA_STATE_DIR);
	const defaultStateDir = joinPortable(homedir, ".eliza");

	const candidates = [
		configPathFromEnv
			? {
					source: "config-path-env" as const,
					stateDir: dirnamePortable(configPathFromEnv),
					configPath: configPathFromEnv,
				}
			: null,
		stateDirFromEnv
			? {
					source: "state-dir-env" as const,
					stateDir: stateDirFromEnv,
					configPath: joinPortable(stateDirFromEnv, ELIZA_CONFIG_FILENAME),
				}
			: null,
		{
			source: "default-state-dir" as const,
			stateDir: defaultStateDir,
			configPath: joinPortable(defaultStateDir, ELIZA_CONFIG_FILENAME),
		},
	].filter((candidate): candidate is NonNullable<typeof candidate> =>
		Boolean(candidate),
	);

	return candidates.filter(
		(candidate, index, all) =>
			all.findIndex(
				(other) =>
					other.stateDir === candidate.stateDir &&
					other.configPath === candidate.configPath,
			) === index,
	);
}

export function inspectExistingElizaInstall(opts?: {
	env?: NodeJS.ProcessEnv;
	homedir?: string;
}): ExistingElizaInstallInfo {
	const candidates = buildExistingElizaInstallCandidates(opts);

	for (const candidate of candidates) {
		const configExists = fs.existsSync(candidate.configPath);
		const stateDirExists = fs.existsSync(candidate.stateDir);
		const hasStateEntries =
			stateDirExists && listStateEntries(candidate.stateDir).length > 0;

		if (configExists || hasStateEntries) {
			return {
				detected: true,
				stateDir: candidate.stateDir,
				configPath: candidate.configPath,
				configExists,
				stateDirExists,
				hasStateEntries,
				source: candidate.source,
			};
		}
	}

	const fallback = candidates[0] ?? {
		source: "default-state-dir" as const,
		stateDir: joinPortable(opts?.homedir ?? os.homedir(), ".eliza"),
		configPath: joinPortable(
			joinPortable(opts?.homedir ?? os.homedir(), ".eliza"),
			ELIZA_CONFIG_FILENAME,
		),
	};

	return {
		detected: false,
		stateDir: fallback.stateDir,
		configPath: fallback.configPath,
		configExists: false,
		stateDirExists: fs.existsSync(fallback.stateDir),
		hasStateEntries: false,
		source: fallback.source,
	};
}

// ---------------------------------------------------------------------------
// Diagnostic logging
// ---------------------------------------------------------------------------

/**
 * Resolve the platform-appropriate config directory for the desktop app.
 *   Windows: %APPDATA%\{configDirName}  (e.g. C:\Users\X\AppData\Roaming\elizaOS)
 *   macOS/Linux: ~/.config/{configDirName}
 *
 * Exported for testability — accepts explicit overrides so tests don't need
 * to mock process globals.
 */
export function resolveConfigDir(opts?: {
	platform?: string;
	appdata?: string;
	homedir?: string;
}): string {
	const platform = opts?.platform ?? process.platform;
	const homedir = opts?.homedir ?? os.homedir();
	const dirName = getBrandConfig().configDirName;
	if (platform === "win32") {
		const roaming =
			opts?.appdata ??
			process.env.APPDATA ??
			joinPortable(homedir, "AppData", "Roaming");
		return joinPortable(roaming, dirName);
	}
	return joinPortable(homedir, ".config", dirName);
}

export function ensureDesktopApiToken(
	env: NodeJS.ProcessEnv = process.env,
): string {
	const existingToken = resolveApiToken(env);
	if (existingToken) {
		setApiToken(env, existingToken);
		return existingToken;
	}

	if (resolveDisableAutoApiToken(env)) {
		return "";
	}

	const generated = crypto.randomBytes(16).toString("hex");
	setApiToken(env, generated);
	return generated;
}

export function configureDesktopLocalApiAuth(
	env: NodeJS.ProcessEnv = process.env,
): string {
	const token = ensureDesktopApiToken(env);
	env.ELIZA_PAIRING_DISABLED = "1";
	return token;
}

function getDesktopApiToken(
	env: NodeJS.ProcessEnv = process.env,
): string | null {
	return resolveApiToken(env);
}

function getDesktopApiHeaders(
	env: NodeJS.ProcessEnv = process.env,
): Record<string, string> | undefined {
	const token = getDesktopApiToken(env);
	if (!token) return undefined;
	return {
		Authorization: `Bearer ${token}`,
		"X-Api-Key": token,
		"X-Api-Token": token,
	};
}

let diagnosticLogPath: string | null = null;
let startupStatusPath: string | null = null;

export function getDiagnosticLogPath(): string {
	if (diagnosticLogPath !== null) return diagnosticLogPath;
	try {
		const configDir = resolveConfigDir();
		if (!fs.existsSync(configDir)) {
			fs.mkdirSync(configDir, { recursive: true });
		}
		diagnosticLogPath = path.join(
			configDir,
			getBrandConfig().startupLogFileName,
		);
	} catch {
		// Fallback to temp dir
		diagnosticLogPath = path.join(
			os.tmpdir(),
			getBrandConfig().startupLogFileName,
		);
	}
	return diagnosticLogPath;
}

export function getStartupStatusPath(): string {
	if (startupStatusPath !== null) return startupStatusPath;
	try {
		const configDir = resolveConfigDir();
		if (!fs.existsSync(configDir)) {
			fs.mkdirSync(configDir, { recursive: true });
		}
		startupStatusPath = path.join(configDir, "startup-status.json");
	} catch {
		startupStatusPath = path.join(os.tmpdir(), "startup-status.json");
	}
	return startupStatusPath;
}

export function diagnosticLog(message: string): void {
	const timestamp = new Date().toISOString();
	const line = `[${timestamp}] ${message}\n`;
	console.log(message);
	try {
		const logPath = getDiagnosticLogPath();
		fs.appendFileSync(logPath, line);
	} catch {
		// Ignore write errors
	}
}

/** One-line, truncated error string safe for UI (status.error). */
function shortError(err: unknown, maxLen = 280): string {
	const raw =
		err instanceof Error
			? err.message || (err.stack ?? String(err))
			: String(err);
	const oneLine = raw.replace(/\s+/g, " ").trim();
	if (oneLine.length <= maxLen) return oneLine;
	return `${oneLine.slice(0, maxLen)}... (see logs for full details)`;
}

export function redactSensitiveDiagnostics(input: string): string {
	return input
		.replace(
			/(authorization\s*[:=]\s*bearer\s+)([a-z0-9._-]+)/gi,
			"$1[REDACTED]",
		)
		.replace(
			/((?:x-api-key|x-api-token|api[_-]?key|bearer[_-]?token|access[_-]?token|secret|password)\s*[:=]\s*)([^\s]+)/gi,
			"$1[REDACTED]",
		);
}

function readFileTail(filePath: string, maxChars = 16_000): string {
	try {
		const content = fs.readFileSync(filePath, "utf8");
		return redactSensitiveDiagnostics(content.slice(-maxChars));
	} catch {
		return "";
	}
}

function writeStartupDiagnosticsSnapshot(
	snapshot: StartupDiagnosticsSnapshot,
): void {
	try {
		fs.writeFileSync(
			getStartupStatusPath(),
			`${JSON.stringify(snapshot, null, 2)}\n`,
			"utf8",
		);
	} catch {
		// Ignore write errors
	}
}

export function getStartupDiagnosticsSnapshot(): StartupDiagnosticsSnapshot {
	let parsed: Partial<StartupDiagnosticsSnapshot> | null = null;
	try {
		parsed = JSON.parse(
			fs.readFileSync(getStartupStatusPath(), "utf8"),
		) as Partial<StartupDiagnosticsSnapshot> | null;
	} catch {
		parsed = null;
	}

	return {
		state: parsed?.state ?? "not_started",
		phase: parsed?.phase ?? "unknown",
		updatedAt: parsed?.updatedAt ?? new Date().toISOString(),
		lastError: parsed?.lastError ?? null,
		agentName: parsed?.agentName ?? null,
		port: parsed?.port ?? null,
		startedAt: parsed?.startedAt ?? null,
		platform: parsed?.platform ?? process.platform,
		arch: parsed?.arch ?? process.arch,
		configDir: parsed?.configDir ?? resolveConfigDir(),
		logPath: parsed?.logPath ?? getDiagnosticLogPath(),
		statusPath: parsed?.statusPath ?? getStartupStatusPath(),
	};
}

export function getStartupDiagnosticLogTail(maxChars = 16_000): string {
	return readFileTail(getDiagnosticLogPath(), maxChars);
}

function sanitizeBugReportPrefix(prefix: string | undefined): string {
	const trimmed = prefix?.trim();
	if (!trimmed) return "bug-report";

	const sanitized = trimmed
		.replace(/[\\/]+/g, "-")
		.replace(/\.\.+/g, "-")
		.replace(/[^a-zA-Z0-9._-]+/g, "-")
		.replace(/-+/g, "-")
		.replace(/^[._-]+|[._-]+$/g, "")
		.slice(0, 64);

	return sanitized || "bug-report";
}
export function createBugReportBundle(options: {
	reportMarkdown: string;
	reportJson: Record<string, unknown>;
	prefix?: string;
}): BugReportBundleResult {
	const configDir = resolveConfigDir();
	const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
	const prefix = sanitizeBugReportPrefix(options.prefix);
	const directory = path.join(
		configDir,
		"bug-reports",
		`${prefix}-${timestamp}`,
	);
	const reportMarkdownPath = path.join(directory, "report.md");
	const reportJsonPath = path.join(directory, "report.json");
	const logPath = getDiagnosticLogPath();
	const statusPath = getStartupStatusPath();
	const startupLogTarget = path.join(
		directory,
		getBrandConfig().startupLogFileName,
	);
	const startupStatusTarget = path.join(directory, "startup-status.json");
	const startupDiagnostics = getStartupDiagnosticsSnapshot();
	const includeLogTail =
		typeof options.reportJson.attachLogs === "boolean"
			? options.reportJson.attachLogs
			: true;
	const startupLogTail = includeLogTail ? getStartupDiagnosticLogTail() : "";
	const normalizedReportJson = {
		...options.reportJson,
		startupDiagnostics,
		startupLogTail,
	};

	fs.mkdirSync(directory, { recursive: true });
	fs.writeFileSync(reportMarkdownPath, options.reportMarkdown, "utf8");
	fs.writeFileSync(
		reportJsonPath,
		`${JSON.stringify(normalizedReportJson, null, 2)}\n`,
		"utf8",
	);

	let copiedLogPath: string | null = null;
	let copiedStatusPath: string | null = null;

	if (fs.existsSync(logPath)) {
		fs.copyFileSync(logPath, startupLogTarget);
		copiedLogPath = startupLogTarget;
	}
	if (fs.existsSync(statusPath)) {
		fs.copyFileSync(statusPath, startupStatusTarget);
		copiedStatusPath = startupStatusTarget;
	}

	return {
		directory,
		reportMarkdownPath,
		reportJsonPath,
		startupLogPath: copiedLogPath,
		startupStatusPath: copiedStatusPath,
	};
}

// ---------------------------------------------------------------------------
// Path resolution
// ---------------------------------------------------------------------------

/**
 * Resolve the runtime dist directory.
 *
 * Priority:
 *   1. ELIZA_DIST_PATH / ELIZA_DIST_PATH env var (explicit override)
 *   2. Walk up from import.meta.dir to find the runtime dist dir as a sibling
 */
export function getRuntimeDistFallbackCandidates(
	moduleDir: string = getDefaultModuleDir(),
	execPath: string = process.execPath,
): string[] {
	const execDir = execPath ? dirnamePortable(execPath) : moduleDir;
	const distDir = getBrandConfig().runtimeDistDirName;

	return [
		// macOS: inside .app bundle (Contents/Resources/app/<dist>)
		resolveRelativePortable(execDir, `../Resources/app/${distDir}`),
		// Windows NSIS/portable: resources/app/<dist> next to exe
		resolveRelativePortable(execDir, `resources/app/${distDir}`),
		resolveRelativePortable(execDir, `../resources/app/${distDir}`),
		resolveRelativePortable(moduleDir, `app/${distDir}`),
		resolveRelativePortable(moduleDir, `../${distDir}`),
		resolveRelativePortable(moduleDir, `../app/${distDir}`),
		resolveRelativePortable(moduleDir, `../../../${distDir}`),
		// Legacy eliza-dist fallback for existing packaged builds
		resolveRelativePortable(execDir, "../Resources/app/eliza-dist"),
		resolveRelativePortable(execDir, "resources/app/eliza-dist"),
		resolveRelativePortable(moduleDir, "../eliza-dist"),
		resolveRelativePortable(moduleDir, "../../../eliza-dist"),
	].filter((candidate, index, all) => all.indexOf(candidate) === index);
}

export function isPackagedDesktopRuntime(
	moduleDir: string = getDefaultModuleDir(),
	execPath: string = process.execPath,
): boolean {
	const normalizedModuleDir = moduleDir.replaceAll("\\", "/");
	const normalizedExecPath = execPath.replaceAll("\\", "/").toLowerCase();
	const looksLikePackagedExec =
		normalizedExecPath.includes(".app/contents/") ||
		normalizedExecPath.includes("/self-extraction/") ||
		normalizedExecPath.endsWith("/launcher") ||
		normalizedExecPath.endsWith("/launcher.exe");
	if (process.env.ELIZA_DIST_PATH?.trim() && !looksLikePackagedExec) {
		return false;
	}
	if (!normalizedModuleDir.includes("/src/")) {
		return true;
	}

	return looksLikePackagedExec;
}

export function resolveBunExecutablePath(opts?: {
	execPath?: string;
	moduleDir?: string;
	platform?: string;
}): string {
	const execPath = opts?.execPath ?? process.execPath;
	const moduleDir = opts?.moduleDir ?? getDefaultModuleDir();
	const platform = opts?.platform ?? process.platform;
	const packagedRuntime = isPackagedDesktopRuntime(moduleDir, execPath);
	const looksLikeMacBundleExec = execPath.includes(".app/Contents/MacOS/");
	const executableName =
		platform === "win32" && !looksLikeMacBundleExec ? "bun.exe" : "bun";
	const execDir = execPath ? dirnamePortable(execPath) : "";
	const packagedCandidates = [
		execPath,
		execDir ? joinPortable(execDir, executableName) : "",
		execDir
			? resolveRelativePortable(
					execDir,
					`../Resources/app/bun/${executableName}`,
				)
			: "",
		execDir
			? resolveRelativePortable(
					execDir,
					`../Resources/app/bun/bin/${executableName}`,
				)
			: "",
		moduleDir ? joinPortable(moduleDir, executableName) : "",
		moduleDir ? joinPortable(moduleDir, "bin", executableName) : "",
		moduleDir
			? resolveRelativePortable(moduleDir, `../bun/${executableName}`)
			: "",
		moduleDir
			? resolveRelativePortable(moduleDir, `../bun/bin/${executableName}`)
			: "",
	].filter(Boolean);

	for (const candidate of packagedCandidates) {
		if (!fs.existsSync(candidate)) continue;
		if (
			path.basename(candidate).toLowerCase() === executableName.toLowerCase()
		) {
			return candidate;
		}
	}

	if (packagedRuntime) {
		return (
			packagedCandidates.find(
				(candidate) =>
					path.basename(candidate).toLowerCase() ===
					executableName.toLowerCase(),
			) ?? executableName
		);
	}

	const _candidates = [
		execPath,
		execDir ? joinPortable(execDir, executableName) : "",
	].filter(Boolean);

	const bunGlobal = Bun as { which?: (binary: string) => string | null };
	const whichCandidate =
		typeof bunGlobal.which === "function" ? bunGlobal.which("bun") : null;
	if (whichCandidate) return whichCandidate;

	// Windows: bun is not always on PATH; check well-known install locations.
	if (process.platform === "win32") {
		const localAppData =
			process.env.LOCALAPPDATA ??
			joinPortable(os.homedir(), "AppData", "Local");
		const programFiles = process.env.ProgramFiles ?? "C:\\Program Files";
		const winCandidates = [
			joinPortable(localAppData, "bun", "bun.exe"),
			joinPortable(programFiles, "bun", "bun.exe"),
			joinPortable(os.homedir(), ".bun", "bin", "bun.exe"),
		];
		for (const candidate of winCandidates) {
			if (fs.existsSync(candidate)) return candidate;
		}
	}

	return "bun";
}

export function resolveRuntimeDistPath(opts?: {
	env?: NodeJS.ProcessEnv;
	moduleDir?: string;
	execPath?: string;
}): string {
	const env = opts?.env ?? process.env;
	const moduleDir = opts?.moduleDir ?? getDefaultModuleDir();
	const execPath = opts?.execPath ?? process.execPath;
	const packagedRuntime = isPackagedDesktopRuntime(moduleDir, execPath);
	const distDir = getBrandConfig().runtimeDistDirName;
	const fallbackCandidates = getRuntimeDistFallbackCandidates(
		moduleDir,
		execPath,
	);

	if (packagedRuntime) {
		for (const candidate of fallbackCandidates) {
			if (fs.existsSync(candidate)) {
				return candidate;
			}
		}
		const fallback = fallbackCandidates[0];
		diagnosticLog(
			`[Agent] Could not find packaged runtime dist; using fallback: ${fallback}`,
		);
		return fallback;
	}

	// 1. Env override
	const envPath = env.ELIZA_DIST_PATH;
	if (envPath) {
		const resolved = resolvePortablePath(envPath);
		if (fs.existsSync(resolved)) {
			return resolved;
		}
		diagnosticLog(
			`[Agent] ELIZA_DIST_PATH set but does not exist: ${resolved}`,
		);
	}

	// 2. Walk up from import.meta.dir looking for runtime dist or dev dist
	let dir = moduleDir;
	const maxDepth = 15;
	for (let i = 0; i < maxDepth; i++) {
		// Packaged: runtime dist sibling
		const runtimeDist = joinPortable(dir, distDir);
		if (fs.existsSync(runtimeDist)) {
			return runtimeDist;
		}
		// Legacy eliza-dist sibling (existing packaged builds)
		const legacyDist = joinPortable(dir, "eliza-dist");
		if (fs.existsSync(legacyDist)) {
			return legacyDist;
		}
		// Dev monorepo: dist/ sibling containing the canonical CLI entrypoint
		const devDist = joinPortable(dir, "dist");
		if (fs.existsSync(joinPortable(devDist, "entry.js"))) {
			return devDist;
		}
		const parent = dirnamePortable(dir);
		if (parent === dir) break; // reached filesystem root
		dir = parent;
	}

	// 3. Packaged/dev fallbacks derived from the launcher path and module dir.
	for (const candidate of fallbackCandidates) {
		if (fs.existsSync(candidate)) {
			diagnosticLog(
				`[Agent] Could not find runtime dist by walking up; using fallback: ${candidate}`,
			);
			return candidate;
		}
	}

	const fallback = fallbackCandidates[0];
	diagnosticLog(
		`[Agent] Could not find runtime dist by walking up; using fallback: ${fallback}`,
	);
	return fallback;
}

export function buildChildNodePaths(
	runtimeDistPath: string,
	opts?: { packagedRuntime?: boolean },
): string[] {
	const nodePaths = new Set<string>();
	const distModules = joinPortable(runtimeDistPath, "node_modules");
	if (fs.existsSync(distModules)) {
		nodePaths.add(distModules);
	}

	if (opts?.packagedRuntime) {
		return [...nodePaths];
	}

	let searchDir = runtimeDistPath;
	while (searchDir !== dirnamePortable(searchDir)) {
		const candidate = joinPortable(searchDir, "node_modules");
		if (fs.existsSync(candidate) && candidate !== distModules) {
			nodePaths.add(candidate);
			break;
		}
		searchDir = dirnamePortable(searchDir);
	}

	return [...nodePaths];
}

function resolveRuntimeEntryPath(runtimeDistPath: string): string | null {
	const candidates = [joinPortable(runtimeDistPath, "entry.js")];

	for (const candidate of candidates) {
		if (fs.existsSync(candidate)) {
			return candidate;
		}
	}

	return null;
}

// ---------------------------------------------------------------------------
// Health check polling
// ---------------------------------------------------------------------------

async function waitForHealthy(
	getPort: () => number,
	timeoutMs: number = getHealthPollTimeoutMs(),
	childProcess?: BunSubprocess | null,
): Promise<boolean> {
	const deadline = Date.now() + timeoutMs;
	const headers = getDesktopApiHeaders();

	while (Date.now() < deadline) {
		// Bail early if the child process has already exited
		if (childProcess && childProcess.exitCode !== null) {
			return false;
		}

		const port = getPort();
		const url = `http://127.0.0.1:${port}/api/health`;
		try {
			const response = await fetch(url, {
				headers,
				signal: AbortSignal.timeout(2_000),
			});
			if (response.ok) {
				const health = (await response.json().catch(() => null)) as {
					ready?: boolean;
					agentState?: string;
					startup?: { phase?: string };
				} | null;
				if (!health) {
					return true;
				}
				if (typeof health.ready === "boolean") {
					if (health.ready) {
						return true;
					}
				} else if (
					health.agentState !== "starting" &&
					health.agentState !== "restarting"
				) {
					return true;
				}
			}
		} catch {
			// Server not ready yet
		}
		await Bun.sleep(HEALTH_POLL_INTERVAL_MS);
	}
	return false;
}

// ---------------------------------------------------------------------------
// Stdout watcher for "listening on port" detection
// ---------------------------------------------------------------------------

async function watchStdoutForReady(
	stream: ReadableStream<Uint8Array>,
	onLine: (line: string) => void,
	signal: AbortSignal,
): Promise<void> {
	const decoder = new TextDecoder();
	let buffer = "";

	try {
		const reader = stream.getReader();
		while (!signal.aborted) {
			const { done, value } = await reader.read();
			if (done) break;

			buffer += decoder.decode(value, { stream: true });
			const lines = buffer.split("\n");
			buffer = lines.pop() ?? "";

			for (const line of lines) {
				if (line.trim()) {
					onLine(line);
				}
			}
		}
		// Flush remaining buffer
		if (buffer.trim()) {
			onLine(buffer);
		}
		reader.releaseLock();
	} catch (err) {
		if (!signal.aborted) {
			diagnosticLog(
				`[Agent] stdout watcher error: ${err instanceof Error ? err.message : String(err)}`,
			);
		}
	}
}

async function drainStderrToLog(
	stream: ReadableStream<Uint8Array>,
	signal: AbortSignal,
	onLine?: (line: string) => void,
): Promise<void> {
	const decoder = new TextDecoder();
	let buffer = "";

	try {
		const reader = stream.getReader();
		while (!signal.aborted) {
			const { done, value } = await reader.read();
			if (done) break;

			buffer += decoder.decode(value, { stream: true });
			const lines = buffer.split("\n");
			buffer = lines.pop() ?? "";

			for (const line of lines) {
				if (line.trim()) {
					diagnosticLog(`[Agent][stderr] ${line}`);
					onLine?.(line);
				}
			}
		}
		if (buffer.trim()) {
			diagnosticLog(`[Agent][stderr] ${buffer}`);
			onLine?.(buffer);
		}
		reader.releaseLock();
	} catch (err) {
		if (!signal.aborted) {
			diagnosticLog(
				`[Agent] stderr drain error: ${err instanceof Error ? err.message : String(err)}`,
			);
		}
	}
}

const PGLITE_LOCK_RE =
	/pglite data dir is already in use|database is locked|lock file already exists/i;
const PGLITE_RECOVERY_RE =
	/failed query:\s*(?:create schema if not exists|create table if not exists life_)|aborted\(\)\. build with -sassertions|database disk image is malformed|file is not a database|malformed database schema|checksum mismatch|checkpoint failed|wal file/i;

function shouldAutoRecoverPgliteFailure(line: string): boolean {
	if (PGLITE_LOCK_RE.test(line)) {
		return false;
	}

	return (
		PGLITE_RECOVERY_RE.test(line) ||
		(/corrupt/i.test(line) && /pglite|sqlite/i.test(line))
	);
}

/**
 * Opt-in: kill processes listening on `port` (lsof + SIGKILL). Default off so a
 * second desktop instance can coexist on the same machine when ports differ.
 * Set ELIZA_AGENT_RECLAIM_STALE_PORT=1 (legacy: ELIZA_AGENT_RECLAIM_STALE_PORT)
 * to restore the old “take over default port” behavior.
 */
async function maybeReclaimPortWithSigkill(port: number): Promise<void> {
	const raw = process.env.ELIZA_AGENT_RECLAIM_STALE_PORT?.trim().toLowerCase();
	if (raw !== "1" && raw !== "true" && raw !== "yes") {
		return;
	}
	try {
		const lsofResult = Bun.spawnSync(["lsof", "-ti", `tcp:${port}`]);
		const pids = new TextDecoder()
			.decode(lsofResult.stdout)
			.trim()
			.split("\n")
			.filter(Boolean);
		for (const pid of pids) {
			const numPid = parseInt(pid, 10);
			if (!Number.isNaN(numPid) && numPid !== process.pid) {
				diagnosticLog(
					`[Agent] Reclaim: killing process ${numPid} on port ${port} (ELIZA_AGENT_RECLAIM_STALE_PORT)`,
				);
				try {
					process.kill(numPid, "SIGKILL");
				} catch {
					// Process may have already exited
				}
			}
		}
		if (pids.length > 0) {
			await new Promise((r) => setTimeout(r, 500));
		}
	} catch {
		// lsof missing — ignore
	}
}

function resolvePgliteDataDir(): string {
	return joinPortable(
		os.homedir(),
		`.${getBrandConfig().namespace}`,
		"workspace",
		".eliza",
		".elizadb",
	);
}

/**
 * Removes only the PGLite database folder (agent memory / conversations).
 * GGUF embedding weights live under `MODELS_DIR` / `~/.eliza/models` by default — never deleted here.
 */
function deletePgliteDataDir(): void {
	const dir = resolvePgliteDataDir();
	if (path.basename(dir) !== ".elizadb") {
		diagnosticLog(
			`[Agent] deletePgliteDataDir: refused — basename must be .elizadb, got: ${dir}`,
		);
		return;
	}
	try {
		if (fs.existsSync(dir)) {
			fs.rmSync(dir, { recursive: true, force: true });
			diagnosticLog(
				`[Agent] Deleted PGLite data dir (GGUF model cache elsewhere): ${dir}`,
			);
		}
	} catch (err) {
		diagnosticLog(
			`[Agent] Failed to delete PGLite data dir: ${err instanceof Error ? err.message : String(err)}`,
		);
	}
}

// ---------------------------------------------------------------------------
// AgentManager -- singleton
// ---------------------------------------------------------------------------

export class AgentManager {
	private sendToWebview: SendToWebview | null = null;
	private readonly statusListeners = new Set<
		(status: Readonly<AgentStatus>) => void
	>();
	private status: AgentStatus = {
		state: "not_started",
		agentName: null,
		port: null,
		startedAt: null,
		error: null,
	};
	private childProcess: BunSubprocess | null = null;
	private stdioAbortController: AbortController | null = null;
	private hasPgliteError = false;
	private pgliteRecoveryDone = false;
	private startupPhase = "not_started";

	constructor() {
		this.persistStartupDiagnostics();
	}

	setSendToWebview(fn: SendToWebview): void {
		this.sendToWebview = fn;
	}

	onStatusChange(
		listener: (status: Readonly<AgentStatus>) => void,
	): () => void {
		this.statusListeners.add(listener);
		return () => {
			this.statusListeners.delete(listener);
		};
	}

	/** Start the agent runtime as a child process. Idempotent. */
	async start(): Promise<AgentStatus> {
		recordStartupPhase("agent_start_entered", {
			pid: process.pid,
			exec_path: process.execPath,
			bundle_path: resolveStartupBundlePath(process.execPath),
		});
		this.setStartupPhase("start_requested");
		recordStartupPhase("agent_start_entered", {
			pid: process.pid,
			exec_path: process.execPath,
			bundle_path: resolveStartupBundlePath(process.execPath),
		});
		diagnosticLog(
			`[Agent] start() called, current state: ${this.status.state}`,
		);
		diagnosticLog(`[Agent] Diagnostic log file: ${getDiagnosticLogPath()}`);

		if (this.status.state === "running" || this.status.state === "starting") {
			return this.status;
		}

		const runtimeMode = resolveDesktopRuntimeMode(
			process.env as Record<string, string | undefined>,
		);
		if (runtimeMode.mode !== "local") {
			const reason =
				runtimeMode.mode === "external"
					? `Embedded desktop runtime is disabled because ${runtimeMode.externalApi.source} points at ${runtimeMode.externalApi.base}.`
					: "Embedded desktop runtime is disabled by ELIZA_DESKTOP_SKIP_EMBEDDED_AGENT=1.";
			diagnosticLog(`[Agent] ${reason}`);
			this.setStartupPhase("startup_disabled", reason);
			throw new Error(reason);
		}

		let packagedRuntime: boolean;
		let apiPort: number;
		let preferredPort: number;
		try {
			configureDesktopLocalApiAuth();
			packagedRuntime = isPackagedDesktopRuntime();

			// Reset per-startup flags
			this.pgliteRecoveryDone = false;

			// Clean up any stale process before starting
			if (this.childProcess) {
				await this.killChildProcess();
			}

			preferredPort = resolveDesktopApiPort(process.env) || DEFAULT_API_PORT;
			diagnosticLog(
				`[Agent] Preferred port: ${preferredPort} (packaged: ${packagedRuntime})`,
			);
			if (!packagedRuntime) {
				await maybeReclaimPortWithSigkill(preferredPort);
			}
			apiPort = await findFirstAvailableLoopbackPort(preferredPort);
		} catch (err) {
			const msg =
				err instanceof Error ? err.message : "Failed during pre-startup";
			diagnosticLog(`[Agent] ${msg}`);
			this.status = {
				state: "error",
				agentName: null,
				port: null,
				startedAt: null,
				error: msg,
			};
			recordStartupPhase("fatal", {
				port: null,
				error: msg,
			});
			this.setStartupPhase("port_allocation_failed", msg);
			this.emitStatus();
			return this.status;
		}
		if (apiPort !== preferredPort) {
			diagnosticLog(
				`[Agent] Port ${preferredPort} busy — using ${apiPort} for embedded API (set ELIZA_AGENT_RECLAIM_STALE_PORT=1 to try reclaiming the preferred port first)`,
			);
		}
		recordStartupPhase("port_selected", {
			port: apiPort,
		});

		this.status = {
			state: "starting",
			agentName: null,
			port: null,
			startedAt: null,
			error: null,
		};
		this.setStartupPhase("starting_runtime");
		this.emitStatus();

		try {
			// Resolve the bundled runtime dist path.
			this.setStartupPhase("resolving_runtime");
			const runtimeDistPath = resolveRuntimeDistPath();
			diagnosticLog(`[Agent] Resolved runtime dist: ${runtimeDistPath}`);

			// Packaged builds can expose the runnable entry either at the dist root
			// or under runtime/. Prefer the root file but accept both layouts.
			const runtimeEntryPath = resolveRuntimeEntryPath(runtimeDistPath);
			if (!runtimeEntryPath) {
				const distExists = fs.existsSync(runtimeDistPath);
				let contents = "<directory missing>";
				if (distExists) {
					try {
						contents = fs.readdirSync(runtimeDistPath).join(", ");
					} catch {
						contents = "<unreadable>";
					}
				}
				const errMsg = `No runnable runtime entry found in ${runtimeDistPath} (checked entry.js; dist exists: ${distExists}, contents: ${contents})`;
				diagnosticLog(`[Agent] ${errMsg}`);
				this.status = {
					state: "error",
					agentName: null,
					port: null,
					startedAt: null,
					error: errMsg,
				};
				recordStartupPhase("fatal", {
					port: apiPort,
					error: errMsg,
				});
				this.setStartupPhase("runtime_entry_missing", errMsg);
				recordStartupPhase("fatal", {
					port: apiPort,
					error: errMsg,
				});
				this.emitStatus();
				return this.status;
			}

			diagnosticLog(`[Agent] runtime entry: exists (${runtimeEntryPath})`);
			recordStartupPhase("runtime_path_resolved", {
				port: apiPort,
			});

			diagnosticLog(`[Agent] Starting child process on port ${apiPort}...`);
			this.setStartupPhase("spawning_runtime");

			// Build NODE_PATH so the child can find node_modules
			const nodePaths = buildChildNodePaths(runtimeDistPath, {
				packagedRuntime,
			});
			if (packagedRuntime && nodePaths.length === 0) {
				const errMsg =
					`Packaged runtime is missing bundle-local node_modules under ${runtimeDistPath}; ` +
					"refusing to inherit the parent NODE_PATH";
				diagnosticLog(`[Agent] ${errMsg}`);
				this.status = {
					state: "error",
					agentName: null,
					port: apiPort,
					startedAt: null,
					error: errMsg,
				};
				recordStartupPhase("fatal", {
					port: apiPort,
					error: errMsg,
				});
				this.emitStatus();
				return this.status;
			}

			const childEnv: Record<string, string> = {
				...(process.env as Record<string, string>),
				ELIZA_API_PORT: String(apiPort),
				ELIZA_PORT: String(apiPort),
			};
			childEnv.ELIZA_NAMESPACE =
				childEnv.ELIZA_NAMESPACE?.trim() || getBrandConfig().namespace;
			childEnv.ELIZA_NAMESPACE =
				childEnv.ELIZA_NAMESPACE?.trim() || childEnv.ELIZA_NAMESPACE;
			delete childEnv.ELIZA_PORT;
			delete childEnv.NODE_PATH;

			// node-llama-cpp crashes Bun on Windows during packaged startup.
			// Disable local embeddings until upstream fix lands.
			if (process.platform === "win32") {
				childEnv.ELIZA_DISABLE_LOCAL_EMBEDDINGS = "1";
			}

			// Propagate PGlite data dir from parent env so CI/smoke test overrides
			// (e.g. a short Windows path avoiding MAX_PATH issues) reach the runtime.
			if (process.env.PGLITE_DATA_DIR) {
				childEnv.PGLITE_DATA_DIR = process.env.PGLITE_DATA_DIR;
			}

			if (nodePaths.length > 0) {
				childEnv.NODE_PATH = nodePaths.join(path.delimiter);
				diagnosticLog(`[Agent] Child NODE_PATH: ${childEnv.NODE_PATH}`);
			}

			const bunExecutable = resolveBunExecutablePath();
			diagnosticLog(`[Agent] Using Bun executable: ${bunExecutable}`);
			diagnosticLog(
				`[Agent] Bun exists on disk: ${fs.existsSync(bunExecutable)}`,
			);

			// Ensure bun's directory is on PATH so child_process.exec calls
			// (e.g. plugin-manager running `bun add ...`) can find it.
			const bunDir = path.dirname(bunExecutable);
			const existingPath = childEnv.PATH ?? "";
			if (!existingPath.split(path.delimiter).includes(bunDir)) {
				childEnv.PATH = bunDir + path.delimiter + existingPath;
				diagnosticLog(`[Agent] Prepended bun dir to child PATH: ${bunDir}`);
			}

			// Spawn the child process
			const spawnTime = Date.now();
			const proc = Bun.spawn(
				[bunExecutable, "run", runtimeEntryPath, "start"],
				{
					cwd: runtimeDistPath,
					env: childEnv,
					stdout: "pipe",
					stderr: "pipe",
				},
			);

			this.childProcess = proc;
			diagnosticLog(
				`[Agent] Child spawned pid=${proc.pid} elapsed=${Date.now() - spawnTime}ms`,
			);
			recordStartupPhase("child_spawned", {
				port: apiPort,
				child_pid: proc.pid,
			});

			// Set up abort controller for stdio watchers
			this.stdioAbortController = new AbortController();
			const { signal } = this.stdioAbortController;

			// Surface the port immediately while waiting for ready
			this.status = {
				...this.status,
				port: apiPort,
			};
			this.emitStatus();

			// Track whether we detected the "listening" message from stdout
			let detectedListening = false;

			// Watch stdout for "listening on port" or similar ready messages
			if (proc.stdout) {
				watchStdoutForReady(
					proc.stdout,
					(line: string) => {
						diagnosticLog(`[Agent][stdout] ${line}`);
						const lower = line.toLowerCase();
						// Parse dynamic port from "[eliza-api] Listening on http://host:PORT"
						const portMatch = line.match(
							/Listening on https?:\/\/[^:]+:(\d+)/i,
						);
						if (portMatch) {
							const parsedPort = parseInt(portMatch[1], 10);
							if (!Number.isNaN(parsedPort) && parsedPort > 0) {
								if (parsedPort !== apiPort) {
									diagnosticLog(
										`[Agent] Server bound to dynamic port ${parsedPort} (requested ${apiPort})`,
									);
									apiPort = parsedPort;
								}
								detectedListening = true;
							}
						} else if (
							lower.includes("listening on port") ||
							lower.includes("server started") ||
							lower.includes("ready on")
						) {
							detectedListening = true;
						}
						// Update status port so callers see the actual bound port
						this.status = { ...this.status, port: apiPort };
						this.emitStatus();
					},
					signal,
				).catch(() => {
					// Stream ended or aborted -- expected on shutdown
				});
			}

			// Drain stderr to diagnostic log; detect PGLite migration failures
			this.hasPgliteError = false;
			if (proc.stderr) {
				drainStderrToLog(proc.stderr, signal, (line) => {
					if (shouldAutoRecoverPgliteFailure(line)) {
						this.hasPgliteError = true;
					}
				}).catch(() => {
					// Stream ended or aborted -- expected on shutdown
				});
			}

			// Monitor child process exit
			this.monitorChildExit(proc);

			// Wait for the health endpoint to respond
			// Use a getter so the health check follows dynamic port reassignment from stdout
			diagnosticLog(
				`[Agent] Waiting for health endpoint at http://127.0.0.1:${apiPort}/api/health ...`,
			);
			this.setStartupPhase("waiting_for_health");
			const healthPollTimeoutMs = getHealthPollTimeoutMs();
			const healthy = await waitForHealthy(
				() => apiPort,
				healthPollTimeoutMs,
				proc,
			);

			if (!healthy) {
				// Check if process already exited
				if (proc.exitCode !== null) {
					const errMsg = `Child process exited with code ${proc.exitCode} before becoming healthy`;
					diagnosticLog(`[Agent] ${errMsg}`);
					this.childProcess = null;
					this.status = {
						state: "error",
						agentName: null,
						port: apiPort,
						startedAt: null,
						error: errMsg,
					};
					recordStartupPhase("fatal", {
						port: apiPort,
						child_pid: proc.pid,
						error: errMsg,
						exit_code: proc.exitCode,
					});
					this.setStartupPhase("startup_failed", errMsg);
					recordStartupPhase("fatal", {
						port: apiPort,
						child_pid: proc.pid,
						error: errMsg,
						exit_code: proc.exitCode,
					});
					this.emitStatus();
					return this.status;
				}

				const errMsg = detectedListening
					? "Server reported listening but health check timed out"
					: `Health check timed out after ${healthPollTimeoutMs}ms`;
				diagnosticLog(`[Agent] ${errMsg}`);
				this.status = {
					state: "error",
					agentName: null,
					port: apiPort,
					startedAt: null,
					error: errMsg,
				};
				recordStartupPhase("fatal", {
					port: apiPort,
					child_pid: proc.pid,
					error: errMsg,
				});
				this.setStartupPhase("startup_failed", errMsg);
				recordStartupPhase("fatal", {
					port: apiPort,
					child_pid: proc.pid,
					error: errMsg,
				});
				this.emitStatus();
				return this.status;
			}
			recordStartupPhase("health_ready", {
				port: apiPort,
				child_pid: proc.pid,
			});

			this.setStartupPhase("fetching_agent_metadata");
			const startedAt = Date.now();
			const startupMs = startedAt - spawnTime;

			this.status = {
				state: "running",
				agentName: getBrandConfig().appName,
				port: apiPort,
				startedAt,
				error: null,
			};
			this.setStartupPhase("ready", null);
			this.emitStatus();
			diagnosticLog(
				`[Agent] Runtime ready -- port: ${apiPort}, pid: ${proc.pid}, startup_ms: ${startupMs}`,
			);
			recordStartupPhase("runtime_ready", {
				port: apiPort,
				child_pid: proc.pid,
			});
			void this.refreshAgentMetadata(proc, apiPort, startupMs);
			return this.status;
		} catch (err) {
			const errMsg =
				err instanceof Error ? err.stack || err.message : String(err);
			diagnosticLog(`[Agent] Failed to start: ${errMsg}`);
			recordStartupPhase("fatal", {
				port: this.status.port,
				error: errMsg,
			});

			// Clean up child if it was spawned
			if (this.childProcess) {
				await this.killChildProcess();
			}

			this.status = {
				state: "error",
				agentName: null,
				port: this.status.port, // preserve port if set
				startedAt: null,
				error: shortError(err),
			};
			this.setStartupPhase("startup_failed", shortError(err));
			this.emitStatus();
			return this.status;
		}
	}

	/** Stop the agent runtime. */
	async stop(): Promise<void> {
		if (this.status.state !== "running" && this.status.state !== "starting") {
			return;
		}

		diagnosticLog("[Agent] Stopping...");
		this.setStartupPhase("stopping");

		// Abort stdio watchers
		if (this.stdioAbortController) {
			this.stdioAbortController.abort();
			this.stdioAbortController = null;
		}

		await this.killChildProcess();

		this.status = {
			state: "stopped",
			agentName: this.status.agentName,
			port: null,
			startedAt: null,
			error: null,
		};
		this.setStartupPhase("stopped", null);
		this.emitStatus();
		diagnosticLog("[Agent] Runtime stopped");
	}

	/**
	 * Restart the agent runtime -- stops the current instance and starts a
	 * fresh one, picking up config/plugin changes.
	 */
	async restart(): Promise<AgentStatus> {
		diagnosticLog("[Agent] Restart requested -- stopping current runtime...");
		this.setStartupPhase("restart_requested");
		await this.stop();
		diagnosticLog("[Agent] Restarting...");
		return this.start();
	}

	/**
	 * Used after `POST /api/agent/reset`: stop the child, delete local PGLite
	 * (conversations / agent memory under `~/.${getBrandConfig().namespace}/workspace/.eliza/.elizadb`),
	 * then start fresh. Does not remove downloaded **GGUF** models (`MODELS_DIR`,
	 * default ~/.eliza/models), env-backed wallet keys, or eliza.json (the API
	 * reset already rewrote config on disk).
	 *
	 * When `ELIZA_DESKTOP_API_BASE` points at an external dev API (e.g. :31337),
	 * the embedded child is never used — this is a no-op so the renderer can
	 * bounce the real API via `POST /api/agent/restart` instead.
	 */
	async restartClearingLocalDb(): Promise<AgentStatus> {
		const runtimeMode = resolveDesktopRuntimeMode(
			process.env as Record<string, string | undefined>,
		);
		if (runtimeMode.mode !== "local") {
			diagnosticLog(
				`[Agent] restartClearingLocalDb skipped — mode=${runtimeMode.mode} externalBase=${runtimeMode.externalApi.base ?? "n/a"} source=${runtimeMode.externalApi.source ?? "n/a"} (renderer uses POST /api/agent/restart)`,
			);
			return this.getStatus();
		}

		diagnosticLog(
			`[Agent] restartClearingLocalDb: local mode — stop → rm PGLite (${resolvePgliteDataDir()}) → start`,
		);
		await this.stop();
		this.hasPgliteError = false;
		this.pgliteRecoveryDone = false;
		deletePgliteDataDir();
		const next = await this.start();
		diagnosticLog(
			`[Agent] restartClearingLocalDb: start() finished state=${next.state} port=${next.port ?? "null"}`,
		);
		return next;
	}

	getStatus(): AgentStatus {
		return { ...this.status };
	}

	inspectExistingInstall(): ExistingElizaInstallInfo {
		return inspectExistingElizaInstall();
	}

	getPort(): number | null {
		return this.status.port;
	}

	/** Clean up on app quit. */
	async dispose(): Promise<void> {
		if (this.stdioAbortController) {
			this.stdioAbortController.abort();
			this.stdioAbortController = null;
		}
		try {
			await this.killChildProcess();
		} catch (err) {
			logger.warn(
				`[Agent] dispose error: ${err instanceof Error ? err.message : String(err)}`,
			);
		}
	}

	// -----------------------------------------------------------------------
	// Private helpers
	// -----------------------------------------------------------------------

	private emitStatus(): void {
		this.persistStartupDiagnostics();
		if (this.sendToWebview) {
			this.sendToWebview("agentStatusUpdate", this.status);
		}
		const statusSnapshot = { ...this.status };
		for (const listener of this.statusListeners) {
			try {
				listener(statusSnapshot);
			} catch (err) {
				logger.warn(
					`[Agent] status listener failed: ${err instanceof Error ? err.message : String(err)}`,
				);
			}
		}
	}

	private async refreshAgentMetadata(
		proc: BunSubprocess,
		port: number,
		startupMs: number,
	): Promise<void> {
		const agentName = await this.fetchAgentName(port);
		if (
			this.childProcess !== proc ||
			this.status.state !== "running" ||
			this.status.port !== port
		) {
			return;
		}

		if (this.status.agentName !== agentName) {
			this.status = {
				...this.status,
				agentName,
			};
			this.emitStatus();
		}

		diagnosticLog(
			`[Agent] Runtime started -- agent: ${agentName}, port: ${port}, pid: ${proc.pid}, startup_ms: ${startupMs}`,
		);
		recordStartupPhase("metadata_ready", {
			port,
			child_pid: proc.pid,
		});
	}
	private setStartupPhase(phase: string, lastError?: string | null): void {
		this.startupPhase = phase;
		this.persistStartupDiagnostics(lastError);
	}

	private persistStartupDiagnostics(lastError?: string | null): void {
		writeStartupDiagnosticsSnapshot({
			state: this.status.state,
			phase: this.startupPhase,
			updatedAt: new Date().toISOString(),
			lastError: lastError ?? this.status.error,
			agentName: this.status.agentName,
			port: this.status.port,
			startedAt: this.status.startedAt,
			platform: process.platform,
			arch: process.arch,
			configDir: resolveConfigDir(),
			logPath: getDiagnosticLogPath(),
			statusPath: getStartupStatusPath(),
		});
	}

	/**
	 * Monitor the child process for unexpected exits and update status.
	 */
	private monitorChildExit(proc: BunSubprocess): void {
		// Bun.spawn provides an `exited` promise that resolves when the process exits
		proc.exited
			.then((exitCode: number) => {
				// Only update status if this is still our active child process
				if (this.childProcess !== proc) return;

				const wasRunning = this.status.state === "running";
				const wasStarting = this.status.state === "starting";

				if (wasRunning || wasStarting) {
					diagnosticLog(
						`[Agent] Child process exited unexpectedly with code ${exitCode} (pid: ${proc.pid})`,
					);
					recordStartupPhase("fatal", {
						port: this.status.port,
						child_pid: proc.pid,
						error: `Process exited unexpectedly with code ${exitCode}`,
						exit_code: exitCode,
					});
					this.childProcess = null;

					// Auto-recover from PGLite migration failures by deleting the DB
					// and spawning a fresh process (new process = fresh WASM state).
					if (this.hasPgliteError && !this.pgliteRecoveryDone) {
						this.pgliteRecoveryDone = true;
						diagnosticLog(
							"[Agent] PGLite migration error detected — deleting DB and retrying with fresh process",
						);
						deletePgliteDataDir();
						this.status = {
							state: "not_started",
							agentName: null,
							port: null,
							startedAt: null,
							error: null,
						};
						this.setStartupPhase("recovering_pglite");
						// Delay slightly so OS releases file handles before respawn
						setTimeout(() => void this.start(), 500);
						return;
					}

					this.status = {
						state: "error",
						agentName: this.status.agentName,
						port: this.status.port,
						startedAt: null,
						error: `Process exited unexpectedly with code ${exitCode}`,
					};
					this.setStartupPhase(
						"process_exited_unexpectedly",
						`Process exited unexpectedly with code ${exitCode}`,
					);
					this.emitStatus();
				} else {
					// Expected exit (we called stop)
					this.childProcess = null;
				}
			})
			.catch((err: unknown) => {
				if (this.childProcess !== proc) return;
				diagnosticLog(
					`[Agent] Child process exited with error: ${err instanceof Error ? err.message : String(err)}`,
				);
				recordStartupPhase("fatal", {
					port: this.status.port,
					child_pid: proc.pid,
					error: err instanceof Error ? err.message : String(err),
				});
				this.childProcess = null;
				if (
					this.status.state === "running" ||
					this.status.state === "starting"
				) {
					this.status = {
						state: "error",
						agentName: this.status.agentName,
						port: this.status.port,
						startedAt: null,
						error: shortError(err),
					};
					this.setStartupPhase("process_exit_error", shortError(err));
					this.emitStatus();
				}
			});
	}

	/**
	 * Kill the child process gracefully with SIGTERM, escalating to SIGKILL
	 * after a timeout.
	 */
	private async killChildProcess(): Promise<void> {
		const proc = this.childProcess;
		if (!proc) return;

		this.childProcess = null;

		// Already exited
		if (proc.exitCode !== null) return;

		diagnosticLog(`[Agent] Sending SIGTERM to pid ${proc.pid}`);
		proc.kill("SIGTERM");

		// Wait for graceful shutdown or timeout
		const exited = await Promise.race([
			proc.exited.then(() => true as const),
			Bun.sleep(SIGTERM_GRACE_MS).then(() => false as const),
		]);

		if (!exited) {
			diagnosticLog(
				`[Agent] Process did not exit within ${SIGTERM_GRACE_MS}ms, sending SIGKILL`,
			);
			try {
				proc.kill("SIGKILL");
			} catch {
				// Process may have already exited between check and kill
			}
			// Wait briefly for SIGKILL to take effect
			await Promise.race([proc.exited.catch(() => {}), Bun.sleep(1_000)]);
		}

		diagnosticLog("[Agent] Child process terminated");
	}

	/**
	 * Attempt to fetch the agent name from the running API server.
	 * Falls back to the configured desktop app name if the endpoint is unavailable.
	 */
	private async fetchAgentName(port: number): Promise<string> {
		try {
			const headers = getDesktopApiHeaders();
			const response = await fetch(`http://127.0.0.1:${port}/api/agents`, {
				headers,
				signal: AbortSignal.timeout(AGENT_NAME_FETCH_TIMEOUT_MS),
			});
			if (response.ok) {
				const data = (await response.json()) as
					| { agents?: Array<{ name?: string }> }
					| Array<{ name?: string }>;
				const agents = Array.isArray(data) ? data : data.agents;
				if (agents && agents.length > 0 && agents[0].name) {
					return agents[0].name;
				}
			}
		} catch {
			diagnosticLog("[Agent] Could not fetch agent name, using default");
		}
		return getBrandConfig().appName;
	}
}

// ---------------------------------------------------------------------------
// Singleton
// ---------------------------------------------------------------------------

let agentManager: AgentManager | null = null;

export function getAgentManager(): AgentManager {
	if (!agentManager) {
		agentManager = new AgentManager();
	}
	return agentManager;
}
