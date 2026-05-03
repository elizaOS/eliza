/**
 * Binary Detection Utility
 *
 * Cross-platform utilities for detecting binaries in PATH.
 * Used for skill eligibility gating - checking if required tools are available.
 *
 * @module utils/binary-detect
 */

import { getEnvironment } from "./environment.js";

// ============================================================
// TYPES
// ============================================================

/**
 * Result of a binary detection check.
 */
export interface BinaryDetectResult {
	/** Binary name that was checked */
	name: string;
	/** Whether the binary exists in PATH */
	found: boolean;
	/** Absolute path to the binary if found */
	path?: string;
	/** Version string if detected */
	version?: string;
	/** Error message if detection failed */
	error?: string;
}

/**
 * Result of checking multiple binaries.
 */
export interface BinariesCheckResult {
	/** All binaries are available */
	allFound: boolean;
	/** Results for each binary */
	results: BinaryDetectResult[];
	/** Names of missing binaries */
	missing: string[];
	/** Names of found binaries */
	found: string[];
}

function nodeOnlyDetectionFailure(name: string): BinaryDetectResult {
	return {
		name,
		found: false,
		error: "Binary detection requires Node.js environment",
	};
}

function toPackageManagerInfo(
	name: string,
	result: BinaryDetectResult,
): PackageManagerInfo | null {
	if (!result.found || !result.path) {
		return null;
	}

	return {
		name,
		path: result.path,
		version: result.version,
	};
}

async function detectNamedBinary(name: string): Promise<BinaryDetectResult> {
	return detectBinary(name);
}

// ============================================================
// PLATFORM DETECTION
// ============================================================

/**
 * Detected operating system platform.
 */
export type Platform = "windows" | "darwin" | "linux" | "unknown";

/**
 * Detect the current operating system.
 */
export function detectPlatform(): Platform {
	const env = getEnvironment();

	if (!env.isNode()) {
		return "unknown";
	}

	const platform = process.platform;
	if (platform === "win32") return "windows";
	if (platform === "darwin") return "darwin";
	if (platform === "linux") return "linux";
	return "unknown";
}

/**
 * Check if running on Windows.
 */
export function isWindows(): boolean {
	return detectPlatform() === "windows";
}

/**
 * Check if running on macOS.
 */
export function isDarwin(): boolean {
	return detectPlatform() === "darwin";
}

/**
 * Check if running on Linux.
 */
export function isLinux(): boolean {
	return detectPlatform() === "linux";
}

// ============================================================
// PATH UTILITIES
// ============================================================

/**
 * Get the PATH environment variable as an array of directories.
 */
export function getPathDirs(): string[] {
	const env = getEnvironment();
	const pathValue = env.get("PATH") || env.get("Path") || "";
	const separator = isWindows() ? ";" : ":";
	return pathValue.split(separator).filter(Boolean);
}

/**
 * Get standard binary search paths for the current platform.
 * These are checked in addition to PATH.
 */
export function getStandardBinaryPaths(): string[] {
	const platform = detectPlatform();

	switch (platform) {
		case "darwin":
			return [
				"/usr/local/bin",
				"/opt/homebrew/bin",
				"/usr/bin",
				"/bin",
				"/usr/sbin",
				"/sbin",
				`${process.env.HOME}/.local/bin`,
				`${process.env.HOME}/bin`,
				// Homebrew common locations
				"/opt/homebrew/opt",
				// Common tool locations
				`${process.env.HOME}/.cargo/bin`,
				`${process.env.HOME}/.npm-global/bin`,
				`${process.env.HOME}/.bun/bin`,
				"/usr/local/opt/python/libexec/bin",
			];

		case "linux":
			return [
				"/usr/local/bin",
				"/usr/bin",
				"/bin",
				"/usr/sbin",
				"/sbin",
				`${process.env.HOME}/.local/bin`,
				`${process.env.HOME}/bin`,
				`${process.env.HOME}/.cargo/bin`,
				`${process.env.HOME}/.npm-global/bin`,
				`${process.env.HOME}/.bun/bin`,
				"/snap/bin",
			];

		case "windows":
			return [
				`${process.env.USERPROFILE}\\AppData\\Local\\Programs`,
				`${process.env.USERPROFILE}\\.cargo\\bin`,
				`${process.env.USERPROFILE}\\AppData\\Roaming\\npm`,
				`${process.env.PROGRAMFILES}`,
				`${process.env["PROGRAMFILES(X86)"]}`,
				"C:\\Windows\\System32",
			];

		default:
			return [];
	}
}

// ============================================================
// BINARY DETECTION
// ============================================================

/**
 * Check if a binary exists in PATH.
 *
 * @param name - Binary name to check (e.g., "git", "python3")
 * @returns Detection result with path if found
 *
 * @example
 * ```ts
 * const result = await detectBinary("git");
 * if (result.found) {
 *   console.log(`Git found at: ${result.path}`);
 * }
 * ```
 */
export async function detectBinary(name: string): Promise<BinaryDetectResult> {
	const env = getEnvironment();

	if (!env.isNode()) {
		return nodeOnlyDetectionFailure(name);
	}

	try {
		const fs = await import("node:fs");
		const path = await import("node:path");

		const platform = detectPlatform();
		const executableExtensions =
			platform === "windows" ? [".exe", ".cmd", ".bat", ".ps1", ""] : [""];

		// Get all paths to search
		const pathDirs = getPathDirs();
		const standardPaths = getStandardBinaryPaths();
		const allPaths = [...new Set([...pathDirs, ...standardPaths])];

		for (const dir of allPaths) {
			if (!dir) continue;

			for (const ext of executableExtensions) {
				const fullPath = path.join(dir, name + ext);

				try {
					const stats = fs.statSync(fullPath);
					if (stats.isFile()) {
						// On Unix, check if executable
						if (platform !== "windows") {
							try {
								fs.accessSync(fullPath, fs.constants.X_OK);
							} catch {
								continue; // Not executable
							}
						}

						return {
							name,
							found: true,
							path: fullPath,
						};
					}
				} catch {
					// File doesn't exist at this path, continue searching
				}
			}
		}

		return {
			name,
			found: false,
		};
	} catch (error) {
		return {
			name,
			found: false,
			error: error instanceof Error ? error.message : "Detection failed",
		};
	}
}

/**
 * Check if a binary exists using the 'which' or 'where' command.
 * More reliable but slower than path scanning.
 *
 * @param name - Binary name to check
 * @returns Detection result with path if found
 */
export async function detectBinaryWithWhich(
	name: string,
): Promise<BinaryDetectResult> {
	const env = getEnvironment();

	if (!env.isNode()) {
		return nodeOnlyDetectionFailure(name);
	}

	try {
		const { execSync } = await import("node:child_process");
		const platform = detectPlatform();
		const command = platform === "windows" ? `where ${name}` : `which ${name}`;

		const result = execSync(command, {
			encoding: "utf-8",
			timeout: 5000,
			stdio: ["pipe", "pipe", "pipe"],
		}).trim();

		// which/where can return multiple paths, take the first
		const binaryPath = result.split("\n")[0].trim();

		return {
			name,
			found: true,
			path: binaryPath,
		};
	} catch {
		return {
			name,
			found: false,
		};
	}
}

/**
 * Check multiple binaries at once.
 *
 * @param names - Array of binary names to check
 * @returns Aggregated check result
 *
 * @example
 * ```ts
 * const result = await detectBinaries(["git", "node", "python3"]);
 * if (!result.allFound) {
 *   console.log(`Missing: ${result.missing.join(", ")}`);
 * }
 * ```
 */
export async function detectBinaries(
	names: string[],
): Promise<BinariesCheckResult> {
	const results = await Promise.all(names.map((name) => detectBinary(name)));

	const missing = results.filter((r) => !r.found).map((r) => r.name);
	const found = results.filter((r) => r.found).map((r) => r.name);

	return {
		allFound: missing.length === 0,
		results,
		missing,
		found,
	};
}

/**
 * Get list of missing binaries from a required list.
 *
 * @param required - Array of required binary names
 * @returns Array of missing binary names
 *
 * @example
 * ```ts
 * const missing = await getMissingBinaries(["git", "docker", "kubectl"]);
 * if (missing.length > 0) {
 *   console.log(`Please install: ${missing.join(", ")}`);
 * }
 * ```
 */
export async function getMissingBinaries(
	required: string[],
): Promise<string[]> {
	const result = await detectBinaries(required);
	return result.missing;
}

/**
 * Check if all required binaries are available.
 *
 * @param required - Array of required binary names
 * @returns True if all binaries are found
 */
export async function hasAllBinaries(required: string[]): Promise<boolean> {
	const result = await detectBinaries(required);
	return result.allFound;
}

// ============================================================
// VERSION DETECTION
// ============================================================

/**
 * Common version flags to try when detecting binary versions.
 */
const VERSION_FLAGS = ["--version", "-v", "-V", "version"];

/**
 * Detect a binary and try to get its version.
 *
 * @param name - Binary name
 * @param versionFlag - Version flag to use (default: tries common flags)
 * @returns Detection result with version if available
 */
export async function detectBinaryWithVersion(
	name: string,
	versionFlag?: string,
): Promise<BinaryDetectResult> {
	const baseResult = await detectBinary(name);

	if (!baseResult.found || !baseResult.path) {
		return baseResult;
	}

	const env = getEnvironment();
	if (!env.isNode()) {
		return baseResult;
	}

	try {
		const { execSync } = await import("node:child_process");

		const flagsToTry = versionFlag ? [versionFlag] : VERSION_FLAGS;

		for (const flag of flagsToTry) {
			try {
				const output = execSync(`"${baseResult.path}" ${flag}`, {
					encoding: "utf-8",
					timeout: 5000,
					stdio: ["pipe", "pipe", "pipe"],
				}).trim();

				// Try to extract version number from output
				const versionMatch = output.match(/(\d+(?:\.\d+)+(?:-[a-zA-Z0-9.]+)?)/);

				if (versionMatch) {
					return {
						...baseResult,
						version: versionMatch[1],
					};
				}
			} catch {
				// This flag didn't work, try next
			}
		}

		return baseResult;
	} catch {
		return baseResult;
	}
}

// ============================================================
// PACKAGE MANAGER DETECTION
// ============================================================

/**
 * Detected package manager information.
 */
export interface PackageManagerInfo {
	/** Package manager name */
	name: string;
	/** Binary path */
	path: string;
	/** Version if detected */
	version?: string;
}

/**
 * Detect available Node.js package managers.
 *
 * @returns Array of available package managers in preference order
 */
export async function detectNodePackageManagers(): Promise<
	PackageManagerInfo[]
> {
	const managers = ["bun", "pnpm", "npm", "yarn"];
	const available: PackageManagerInfo[] = [];

	for (const manager of managers) {
		const result = await detectBinaryWithVersion(manager);
		const info = toPackageManagerInfo(manager, result);
		if (info) {
			available.push(info);
		}
	}

	return available;
}

/**
 * Get the preferred Node.js package manager.
 *
 * Order of preference:
 * 1. $OTTO_NODE_MANAGER env var if set
 * 2. bun (fastest)
 * 3. pnpm (efficient)
 * 4. npm (universal fallback)
 * 5. yarn
 *
 * @returns Preferred package manager or null if none found
 */
export async function getPreferredNodeManager(): Promise<PackageManagerInfo | null> {
	const env = getEnvironment();

	// Check for explicit preference
	const preferred = env.get("OTTO_NODE_MANAGER");
	if (preferred) {
		const result = await detectBinaryWithVersion(preferred);
		const info = toPackageManagerInfo(preferred, result);
		if (info) {
			return info;
		}
	}

	// Fall back to detected managers in preference order
	const managers = await detectNodePackageManagers();
	return managers.length > 0 ? managers[0] : null;
}

/**
 * Detect if Homebrew is available (macOS).
 */
export async function detectHomebrew(): Promise<BinaryDetectResult> {
	return detectNamedBinary("brew");
}

/**
 * Detect if apt is available (Debian/Ubuntu).
 */
export async function detectApt(): Promise<BinaryDetectResult> {
	return detectNamedBinary("apt-get");
}

/**
 * Detect if pip is available (Python).
 */
export async function detectPip(): Promise<BinaryDetectResult> {
	// Try pip3 first, then pip
	const pip3 = await detectNamedBinary("pip3");
	if (pip3.found) return { ...pip3, name: "pip" };

	return detectNamedBinary("pip");
}

/**
 * Detect if cargo is available (Rust).
 */
export async function detectCargo(): Promise<BinaryDetectResult> {
	return detectNamedBinary("cargo");
}
