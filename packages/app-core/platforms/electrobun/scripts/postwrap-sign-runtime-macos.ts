#!/usr/bin/env bun

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

type MachOKind = "executable" | "library" | null;
type ExecFileSyncFn = typeof execFileSync;

const NATIVE_EXTENSIONS = new Set([".bare", ".dylib", ".node", ".so"]);
const KNOWN_NATIVE_HELPERS = new Set(["spawn-helper"]);
const CODESIGN_MAX_ATTEMPTS = 4;
const CODESIGN_RETRY_DELAY_MS = 5_000;
const WINDOWS_ABS_PATH_RE = /^[A-Za-z]:[\\/]/;

function isPosixAbsolutePath(value: string): boolean {
	return value.startsWith("/") && !WINDOWS_ABS_PATH_RE.test(value);
}

function resolvePortablePath(value: string): string {
	return isPosixAbsolutePath(value) || WINDOWS_ABS_PATH_RE.test(value)
		? value
		: path.resolve(value);
}

function joinPortable(base: string, ...parts: string[]): string {
	return isPosixAbsolutePath(base)
		? path.posix.join(base, ...parts)
		: path.join(base, ...parts);
}

export function classifyMachOKind(description: string): MachOKind {
	const normalized = description.toLowerCase();
	if (!normalized.includes("mach-o")) {
		return null;
	}
	if (normalized.includes("executable")) {
		return "executable";
	}
	if (
		normalized.includes("bundle") ||
		normalized.includes("shared library") ||
		normalized.includes("dynamically linked shared library") ||
		normalized.includes("dylib")
	) {
		return "library";
	}
	return null;
}

function materializeRuntimePath(inputPath: string): string {
	const resolved = resolvePortablePath(inputPath);
	if (resolved.endsWith(".app")) {
		return joinPortable(
			resolved,
			"Contents",
			"Resources",
			"app",
			"eliza-dist",
			"node_modules",
		);
	}
	if (path.basename(resolved) === "eliza-dist") {
		return joinPortable(resolved, "node_modules");
	}
	return resolved;
}

function normalizeBundleStem(value: string): string {
	return value.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function resolveBuildBundlePath(env: NodeJS.ProcessEnv): string | null {
	const buildDir = env.ELECTROBUN_BUILD_DIR?.trim();
	if (!buildDir || env.ELECTROBUN_OS !== "macos") {
		return null;
	}

	const resolvedBuildDir = resolvePortablePath(buildDir);
	if (!fs.existsSync(resolvedBuildDir)) {
		return null;
	}

	const bundleCandidates = fs
		.readdirSync(resolvedBuildDir, { withFileTypes: true })
		.filter((entry) => entry.isDirectory() && entry.name.endsWith(".app"))
		.map((entry) => joinPortable(resolvedBuildDir, entry.name));

	if (bundleCandidates.length === 0) {
		return null;
	}

	if (bundleCandidates.length === 1) {
		const [bundleCandidate] = bundleCandidates;
		return bundleCandidate ?? null;
	}

	const appName = env.ELECTROBUN_APP_NAME?.trim();
	if (appName) {
		const normalizedAppName = normalizeBundleStem(appName);
		const matched = bundleCandidates.find((candidate) => {
			const stem = path.basename(candidate, ".app");
			return normalizeBundleStem(stem) === normalizedAppName;
		});
		if (matched) {
			return matched;
		}
	}

	throw new Error(
		`runtime-sign: multiple app bundles found in ${resolvedBuildDir}: ${bundleCandidates.join(", ")}`,
	);
}

export function resolveRuntimeNodeModulesPath(
	args = process.argv.slice(2),
	env: NodeJS.ProcessEnv = process.env,
): string {
	const explicitPath = args.find((arg) => arg.trim().length > 0);
	if (explicitPath) {
		return materializeRuntimePath(explicitPath);
	}

	const wrapperBundle = env.ELECTROBUN_WRAPPER_BUNDLE_PATH?.trim();
	if (wrapperBundle) {
		return materializeRuntimePath(wrapperBundle);
	}

	const buildBundle = resolveBuildBundlePath(env);
	if (buildBundle) {
		return materializeRuntimePath(buildBundle);
	}

	throw new Error(
		"runtime-sign: runtime node_modules path not provided and no Electrobun bundle path was available",
	);
}

export function shouldConsiderForCodesign(
	filePath: string,
	stats: Pick<fs.Stats, "isFile" | "mode">,
): boolean {
	if (!stats.isFile()) {
		return false;
	}

	if (NATIVE_EXTENSIONS.has(path.extname(filePath).toLowerCase())) {
		return true;
	}

	if (KNOWN_NATIVE_HELPERS.has(path.basename(filePath).toLowerCase())) {
		return true;
	}

	return (stats.mode & 0o111) !== 0;
}

export function buildCodesignArgs(
	machOKind: Exclude<MachOKind, null>,
	developerId: string,
	filePath: string,
): string[] {
	const args = ["--force", "--timestamp", "--sign", developerId];
	if (machOKind === "executable") {
		args.push("--options", "runtime");
	}
	args.push(filePath);
	return args;
}

export function isRetryableCodesignFailure(message: string): boolean {
	const normalized = message.toLowerCase();
	return normalized.includes("timestamp service is not available");
}

function formatExecSyncFailure(error: unknown): string {
	if (error instanceof Error) {
		const stderrValue = (error as NodeJS.ErrnoException & { stderr?: unknown })
			.stderr;
		const stderr =
			typeof stderrValue === "string"
				? stderrValue
				: Buffer.isBuffer(stderrValue)
					? stderrValue.toString("utf8")
					: "";
		const trimmedStderr = stderr.trim();
		if (trimmedStderr) {
			return trimmedStderr;
		}
		return error.message;
	}
	return String(error);
}

function sleepMs(ms: number): void {
	Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function resolveDeveloperId(
	env: NodeJS.ProcessEnv = process.env,
): string | null {
	const explicitIdentity = env.ELECTROBUN_DEVELOPER_ID?.trim();
	if (explicitIdentity) {
		return explicitIdentity;
	}

	try {
		const output = execFileSync(
			"security",
			["find-identity", "-v", "-p", "codesigning"],
			{
				encoding: "utf8",
				stdio: ["ignore", "pipe", "pipe"],
			},
		);
		const match = output.match(/"([^"]*Developer ID Application[^"]*)"/);
		return match?.[1] ?? null;
	} catch {
		return null;
	}
}

function collectNativeCandidates(rootDir: string): string[] {
	const candidates: string[] = [];

	const visit = (currentDir: string): void => {
		for (const entry of fs.readdirSync(currentDir, { withFileTypes: true })) {
			const entryPath = path.join(currentDir, entry.name);
			if (entry.isSymbolicLink()) {
				continue;
			}
			if (entry.isDirectory()) {
				visit(entryPath);
				continue;
			}

			const stats = fs.statSync(entryPath);
			if (shouldConsiderForCodesign(entryPath, stats)) {
				candidates.push(entryPath);
			}
		}
	};

	visit(rootDir);

	return candidates.sort((left, right) => {
		const depthDelta =
			right.split(path.sep).length - left.split(path.sep).length;
		if (depthDelta !== 0) {
			return depthDelta;
		}
		return left.localeCompare(right);
	});
}

function signRuntimeFile(
	filePath: string,
	developerId: string,
	execFile: ExecFileSyncFn = execFileSync,
): boolean {
	const fileDescription = execFileSync("file", ["-b", filePath], {
		encoding: "utf8",
		stdio: ["ignore", "pipe", "pipe"],
	}).trim();
	const machOKind = classifyMachOKind(fileDescription);
	if (!machOKind) {
		return false;
	}

	const codesignArgs = buildCodesignArgs(machOKind, developerId, filePath);

	for (let attempt = 1; attempt <= CODESIGN_MAX_ATTEMPTS; attempt += 1) {
		try {
			execFile("codesign", codesignArgs, {
				encoding: "utf8",
				stdio: ["ignore", "pipe", "pipe"],
			});
			return true;
		} catch (error) {
			const message = formatExecSyncFailure(error);
			process.stderr.write(`${message.trim()}\n`);

			if (
				attempt >= CODESIGN_MAX_ATTEMPTS ||
				!isRetryableCodesignFailure(message)
			) {
				throw error;
			}

			console.warn(
				`[runtime-sign] codesign failed for ${filePath} (attempt ${attempt}/${CODESIGN_MAX_ATTEMPTS}) with a retryable timestamp error; retrying in ${CODESIGN_RETRY_DELAY_MS / 1000}s`,
			);
			sleepMs(CODESIGN_RETRY_DELAY_MS);
		}
	}

	return true;
}

function shouldRun(env: NodeJS.ProcessEnv = process.env): boolean {
	if (process.platform !== "darwin") {
		return false;
	}
	if (env.ELECTROBUN_OS && env.ELECTROBUN_OS !== "macos") {
		return false;
	}
	if (env.ELECTROBUN_SKIP_CODESIGN === "1") {
		return false;
	}
	return true;
}

function main(): void {
	if (!shouldRun()) {
		console.log("[runtime-sign] skipping nested runtime codesign");
		return;
	}

	const runtimeNodeModulesPath = resolveRuntimeNodeModulesPath();
	if (!fs.existsSync(runtimeNodeModulesPath)) {
		console.log(
			`[runtime-sign] runtime node_modules not found at ${runtimeNodeModulesPath}, skipping nested native signing.`,
		);
		return;
	}

	const developerId = resolveDeveloperId();
	if (!developerId) {
		throw new Error(
			"[runtime-sign] no Developer ID Application identity available for codesign. Set ELECTROBUN_SKIP_CODESIGN=1 to skip runtime signing explicitly.",
		);
	}

	let signedCount = 0;
	for (const candidate of collectNativeCandidates(runtimeNodeModulesPath)) {
		if (signRuntimeFile(candidate, developerId)) {
			signedCount += 1;
		}
	}

	console.log(
		`[runtime-sign] signed ${signedCount} Mach-O file(s) under ${runtimeNodeModulesPath}`,
	);
}

if (
	process.argv[1] &&
	path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
	main();
}
