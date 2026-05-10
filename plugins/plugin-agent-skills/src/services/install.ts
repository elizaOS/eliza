/**
 * Skill Dependency Installation Service
 *
 * Handles installation of skill dependencies using various package managers:
 * - brew (Homebrew, macOS)
 * - apt (apt-get, Debian/Ubuntu Linux)
 * - node (bun/npm)
 * - pip (Python pip/pip3)
 * - cargo (Rust cargo)
 *
 * @module services/install
 */

import type {
	InstallDependencyOptions,
	InstallDependencyResult,
	InstallProgressCallback,
	OttoInstallOption,
} from "../types";

// ============================================================
// CONSTANTS
// ============================================================

/** Default timeout for installation commands (5 minutes) */
const DEFAULT_TIMEOUT = 300_000;

/** Node package managers in preference order */
const NODE_MANAGERS = ["bun", "npm", "yarn"] as const;

// ============================================================
// PLATFORM UTILITIES
// ============================================================

/**
 * Detect the current operating system.
 */
function detectPlatform(): "darwin" | "linux" | "windows" | "unknown" {
	if (typeof process === "undefined") return "unknown";
	const platform = process.platform;
	if (platform === "darwin") return "darwin";
	if (platform === "linux") return "linux";
	if (platform === "win32") return "windows";
	return "unknown";
}

/**
 * Check if a binary exists in PATH using which/where.
 */
async function binaryExists(name: string): Promise<boolean> {
	try {
		const { execSync } = await import("node:child_process");
		const platform = detectPlatform();
		const command = platform === "windows" ? `where ${name}` : `which ${name}`;
		execSync(command, { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] });
		return true;
	} catch {
		return false;
	}
}

// ============================================================
// PACKAGE MANAGER DETECTION
// ============================================================

/**
 * Get the preferred Node.js package manager.
 *
 * Order of preference:
 * 1. OTTO_NODE_MANAGER env var if set
 * 2. bun (fastest)
 * 3. npm (universal fallback)
 * 4. yarn
 */
export async function getPreferredNodeManager(): Promise<string | null> {
	// Check for explicit preference
	const preferred = process.env.OTTO_NODE_MANAGER;
	if (preferred && (await binaryExists(preferred))) {
		return preferred;
	}

	// Check in preference order
	for (const manager of NODE_MANAGERS) {
		if (await binaryExists(manager)) {
			return manager;
		}
	}

	return null;
}

/**
 * Check if Homebrew is available (macOS).
 */
export async function isHomebrewAvailable(): Promise<boolean> {
	return detectPlatform() === "darwin" && (await binaryExists("brew"));
}

/**
 * Check if apt-get is available (Debian/Ubuntu).
 */
export async function isAptAvailable(): Promise<boolean> {
	return detectPlatform() === "linux" && (await binaryExists("apt-get"));
}

/**
 * Check if pip is available.
 */
export async function isPipAvailable(): Promise<boolean> {
	return (await binaryExists("pip3")) || (await binaryExists("pip"));
}

/**
 * Check if cargo is available.
 */
export async function isCargoAvailable(): Promise<boolean> {
	return binaryExists("cargo");
}

// ============================================================
// COMMAND BUILDERS
// ============================================================

/**
 * Build the installation command for a given option.
 */
function buildInstallCommand(option: OttoInstallOption): string | null {
	switch (option.kind) {
		case "brew":
			return `brew install ${option.formula || option.package}`;

		case "apt":
			return `sudo apt-get install -y ${option.package}`;

		case "node": {
			// Will be resolved at runtime to user's preferred manager
			const pkg = option.package;
			return `__NODE_MANAGER__ install -g ${pkg}`;
		}

		case "pip":
			return `pip3 install ${option.package}`;

		case "cargo":
			return `cargo install ${option.package}`;

		case "manual":
			// Manual installation - return instructions
			return null;

		default:
			return null;
	}
}

/**
 * Resolve the __NODE_MANAGER__ placeholder in commands.
 */
async function resolveNodeManager(command: string): Promise<string> {
	if (!command.includes("__NODE_MANAGER__")) {
		return command;
	}

	const manager = await getPreferredNodeManager();
	if (!manager) {
		throw new Error(
			"No Node.js package manager found (tried bun, npm, yarn)",
		);
	}

	return command.replace("__NODE_MANAGER__", manager);
}

// ============================================================
// INSTALLATION EXECUTION
// ============================================================

/**
 * Execute an installation command.
 */
async function executeInstall(
	command: string,
	options: {
		timeout?: number;
		onProgress?: InstallProgressCallback;
		dryRun?: boolean;
	} = {},
): Promise<{ success: boolean; error?: string; duration: number }> {
	const { timeout = DEFAULT_TIMEOUT, onProgress, dryRun } = options;
	const startTime = Date.now();

	if (dryRun) {
		onProgress?.({
			phase: "complete",
			progress: 100,
			message: `[DRY RUN] Would execute: ${command}`,
		});
		return { success: true, duration: 0 };
	}

	try {
		const { spawn } = await import("node:child_process");

		onProgress?.({
			phase: "installing",
			progress: 10,
			message: `Executing: ${command}`,
		});

		return await new Promise((resolve) => {
			const child = spawn("sh", ["-c", command], {
				stdio: ["pipe", "pipe", "pipe"],
				timeout,
			});

			let stdout = "";
			let stderr = "";

			child.stdout?.on("data", (data) => {
				stdout += data.toString();
				onProgress?.({
					phase: "installing",
					progress: 50,
					message: data.toString().trim().slice(0, 200),
				});
			});

			child.stderr?.on("data", (data) => {
				stderr += data.toString();
			});

			child.on("close", (code) => {
				const duration = Date.now() - startTime;

				if (code === 0) {
					onProgress?.({
						phase: "complete",
						progress: 100,
						message: "Installation completed successfully",
					});
					resolve({ success: true, duration });
				} else {
					const error = stderr || stdout || `Process exited with code ${code}`;
					onProgress?.({
						phase: "error",
						message: "Installation failed",
						error,
					});
					resolve({ success: false, error, duration });
				}
			});

			child.on("error", (err) => {
				const duration = Date.now() - startTime;
				const error = err.message;
				onProgress?.({
					phase: "error",
					message: "Installation failed",
					error,
				});
				resolve({ success: false, error, duration });
			});
		});
	} catch (error) {
		const duration = Date.now() - startTime;
		const errorMessage =
			error instanceof Error ? error.message : "Unknown error";
		onProgress?.({
			phase: "error",
			message: "Installation failed",
			error: errorMessage,
		});
		return { success: false, error: errorMessage, duration };
	}
}

// ============================================================
// MAIN INSTALLATION FUNCTION
// ============================================================

/**
 * Install a skill dependency using the specified option.
 *
 * @param options - Installation options including the install option to use
 * @returns Installation result
 *
 * @example
 * ```ts
 * const result = await installSkillDependency({
 *   option: { id: "brew", kind: "brew", formula: "jq" },
 *   onProgress: (event) => console.log(event.message),
 * });
 * ```
 */
export async function installSkillDependency(
	options: InstallDependencyOptions,
): Promise<InstallDependencyResult> {
	const { option, onProgress, dryRun, timeout } = options;

	onProgress?.({
		phase: "installing",
		progress: 0,
		message: `Preparing to install via ${option.kind}...`,
	});

	// Check if the installation kind is available
	const _platform = detectPlatform();

	switch (option.kind) {
		case "brew":
			if (!(await isHomebrewAvailable())) {
				return {
					success: false,
					option,
					error: "Homebrew is not available (macOS only)",
				};
			}
			break;

		case "apt":
			if (!(await isAptAvailable())) {
				return {
					success: false,
					option,
					error: "apt-get is not available (Debian/Ubuntu only)",
				};
			}
			break;

		case "node":
			if (!(await getPreferredNodeManager())) {
				return {
					success: false,
					option,
					error: "No Node.js package manager found",
				};
			}
			break;

		case "pip":
			if (!(await isPipAvailable())) {
				return {
					success: false,
					option,
					error: "pip/pip3 is not available",
				};
			}
			break;

		case "cargo":
			if (!(await isCargoAvailable())) {
				return {
					success: false,
					option,
					error: "cargo is not available (Rust)",
				};
			}
			break;

		case "manual":
			return {
				success: false,
				option,
				error: `Manual installation required: ${option.label || "See skill documentation"}`,
			};
	}

	// Build and execute the command
	let command = buildInstallCommand(option);
	if (!command) {
		return {
			success: false,
			option,
			error: `Cannot build command for install kind: ${option.kind}`,
		};
	}

	// Resolve node manager placeholder
	try {
		command = await resolveNodeManager(command);
	} catch (error) {
		return {
			success: false,
			option,
			error:
				error instanceof Error
					? error.message
					: "Failed to resolve node manager",
		};
	}

	const result = await executeInstall(command, {
		timeout,
		onProgress,
		dryRun,
	});

	return {
		...result,
		option,
		command,
	};
}

/**
 * Find the best available install option for the current platform.
 *
 * @param options - Available install options
 * @returns Best option for current platform, or null if none available
 */
export async function findBestInstallOption(
	options: OttoInstallOption[],
): Promise<OttoInstallOption | null> {
	const platform = detectPlatform();

	// Platform preference order
	const preferenceOrder: Array<OttoInstallOption["kind"]> = [];

	if (platform === "darwin") {
		preferenceOrder.push("brew", "node", "pip", "cargo");
	} else if (platform === "linux") {
		preferenceOrder.push("apt", "node", "pip", "cargo");
	} else {
		preferenceOrder.push("node", "pip", "cargo");
	}

	for (const kind of preferenceOrder) {
		const option = options.find((o) => o.kind === kind);
		if (option) {
			// Verify the package manager is available
			switch (kind) {
				case "brew":
					if (await isHomebrewAvailable()) return option;
					break;
				case "apt":
					if (await isAptAvailable()) return option;
					break;
				case "node":
					if (await getPreferredNodeManager()) return option;
					break;
				case "pip":
					if (await isPipAvailable()) return option;
					break;
				case "cargo":
					if (await isCargoAvailable()) return option;
					break;
			}
		}
	}

	// Fall back to manual if available
	const manual = options.find((o) => o.kind === "manual");
	return manual || null;
}

/**
 * Get installation options that are available on the current platform.
 *
 * @param options - All install options
 * @returns Options available on current platform
 */
export async function getAvailableInstallOptions(
	options: OttoInstallOption[],
): Promise<OttoInstallOption[]> {
	const available: OttoInstallOption[] = [];

	for (const option of options) {
		switch (option.kind) {
			case "brew":
				if (await isHomebrewAvailable()) available.push(option);
				break;
			case "apt":
				if (await isAptAvailable()) available.push(option);
				break;
			case "node":
				if (await getPreferredNodeManager()) available.push(option);
				break;
			case "pip":
				if (await isPipAvailable()) available.push(option);
				break;
			case "cargo":
				if (await isCargoAvailable()) available.push(option);
				break;
			case "manual":
				available.push(option);
				break;
		}
	}

	return available;
}

// ============================================================
// SKILL-LEVEL INSTALLATION
// ============================================================

/**
 * Install all required dependencies for a skill.
 *
 * @param skill - The skill with metadata containing install options
 * @param options - Installation options
 * @returns Array of installation results
 */
export async function installSkillDependencies(
	skill: {
		slug: string;
		frontmatter: {
			metadata?: {
				otto?: { install?: OttoInstallOption[] };
			};
		};
	},
	options: {
		onProgress?: InstallProgressCallback;
		dryRun?: boolean;
	} = {},
): Promise<InstallDependencyResult[]> {
	const metadata = skill.frontmatter.metadata?.otto;
	const installOptions = metadata?.install || [];

	if (installOptions.length === 0) {
		return [];
	}

	const results: InstallDependencyResult[] = [];
	const { onProgress, dryRun } = options;

	// Group options by the binaries they provide
	const binsByOption = new Map<string, OttoInstallOption[]>();

	for (const option of installOptions) {
		const bins = option.bins || [];
		for (const bin of bins) {
			if (!binsByOption.has(bin)) {
				binsByOption.set(bin, []);
			}
			binsByOption.get(bin)?.push(option);
		}
	}

	// For each required binary, find the best option and install
	for (const [bin, opts] of binsByOption) {
		// Check if already installed
		if (await binaryExists(bin)) {
			onProgress?.({
				phase: "complete",
				message: `${bin} is already installed`,
			});
			continue;
		}

		// Find best option
		const bestOption = await findBestInstallOption(opts);
		if (!bestOption) {
			results.push({
				success: false,
				option: opts[0],
				error: `No available installation method for ${bin}`,
			});
			continue;
		}

		// Install
		const result = await installSkillDependency({
			option: bestOption,
			onProgress,
			dryRun,
		});

		results.push(result);

		// If failed, don't continue installing other deps
		if (!result.success) {
			break;
		}
	}

	return results;
}

/**
 * Get a summary of what would be installed for a skill.
 */
export async function getInstallPlan(skill: {
	slug: string;
	frontmatter: {
		metadata?: {
			otto?: { install?: OttoInstallOption[]; requires?: { bins?: string[] } };
		};
	};
}): Promise<{
	requiredBins: string[];
	missingBins: string[];
	availableOptions: OttoInstallOption[];
	recommendedOptions: OttoInstallOption[];
}> {
	const metadata = skill.frontmatter.metadata?.otto;

	const requiredBins = metadata?.requires?.bins || [];
	const installOptions = metadata?.install || [];

	// Check which bins are missing
	const missingBins: string[] = [];
	for (const bin of requiredBins) {
		if (!(await binaryExists(bin))) {
			missingBins.push(bin);
		}
	}

	// Get available options
	const availableOptions = await getAvailableInstallOptions(installOptions);

	// Get recommended options (one per missing binary)
	const recommendedOptions: OttoInstallOption[] = [];
	for (const bin of missingBins) {
		const opts = installOptions.filter((o) => o.bins?.includes(bin));
		const best = await findBestInstallOption(opts);
		if (best && !recommendedOptions.includes(best)) {
			recommendedOptions.push(best);
		}
	}

	return {
		requiredBins,
		missingBins,
		availableOptions,
		recommendedOptions,
	};
}
