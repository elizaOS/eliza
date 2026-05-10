import { exec, execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import fs from "fs-extra";
import { logger } from "../../../logger.ts";
import type { IAgentRuntime } from "../../../types/runtime.ts";
import type { ServiceTypeName } from "../../../types/service.ts";
import { Service } from "../../../types/service.ts";
import { resolveStateDir } from "../utils/paths.ts";
import { getRegistryEntry } from "./pluginRegistryService.ts";

const execAsync = promisify(exec);
const execFileAsync = promisify(execFile);

const CORE_GIT_URL = "https://github.com/elizaos/eliza.git";
const CORE_BRANCH = "develop";
const CORE_PACKAGE_NAME = "@elizaos/core";
const _DEFAULT_CORE_PATHS = ["../packages/core/src/index.node.ts"];
const _DEFAULT_CORE_SUBPATHS = ["../packages/core/src/*"];

const VALID_GIT_URL = /^https:\/\/[a-zA-Z0-9][\w./-]*\.git$/;
const VALID_BRANCH = /^[a-zA-Z0-9][\w./-]*$/;

// Constants for state management
const CORE_MANAGER_SERVICE_TYPE = "core_manager" as ServiceTypeName;

export interface UpstreamMetadata {
	$schema: "eliza-upstream-v1";
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

export class CoreManagerService extends Service {
	static override serviceType: ServiceTypeName = CORE_MANAGER_SERVICE_TYPE;
	override capabilityDescription =
		"Manages the core ElizaOS installation (eject, sync, reinject)";

	private ejectLock: Promise<void> = Promise.resolve();

	static async start(runtime: IAgentRuntime): Promise<CoreManagerService> {
		return new CoreManagerService(runtime);
	}

	async stop(): Promise<void> {
		// No specific stop logic needed
	}

	// Helper to serialize async operations
	private serialise<T>(fn: () => Promise<T>): Promise<T> {
		const prev = this.ejectLock;
		let resolve: () => void;
		this.ejectLock = new Promise<void>((r) => {
			resolve = r;
		});
		return prev.then(fn).finally(() => resolve?.());
	}

	private coreBaseDir(): string {
		return path.join(resolveStateDir(), "core");
	}

	private coreMonorepoDir(): string {
		return path.join(this.coreBaseDir(), "eliza");
	}

	private corePackageDir(): string {
		return path.join(this.coreMonorepoDir(), "packages", "core");
	}

	private coreDistDir(): string {
		return path.join(this.corePackageDir(), "dist");
	}

	private upstreamFilePath(): string {
		return path.join(this.coreBaseDir(), ".upstream.json");
	}

	private tsconfigFilePath(): string {
		return path.join(process.cwd(), "tsconfig.json");
	}

	private isWithinEjectedCoreDir(targetPath: string): boolean {
		const base = path.resolve(this.coreBaseDir());
		const resolved = path.resolve(targetPath);
		if (resolved === base) return false;
		return resolved.startsWith(`${base}${path.sep}`);
	}

	private async gitStdout(args: string[], cwd?: string): Promise<string> {
		const { stdout } = await execAsync(`git ${args.join(" ")}`, {
			cwd,
			env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
		});
		return stdout.trim();
	}

	private async readCorePackageVersion(
		packageDir = this.corePackageDir(),
	): Promise<string> {
		try {
			const pkg = await fs.readJson(path.join(packageDir, "package.json"));
			if (typeof pkg.version === "string" && pkg.version.trim()) {
				return pkg.version.trim();
			}
		} catch {
			// Fall through
		}
		return "unknown";
	}

	private async resolveInstalledCoreVersion(): Promise<string> {
		try {
			const entry = await getRegistryEntry(CORE_PACKAGE_NAME);
			const _npmVersion =
				entry?.npm.v2Version ?? entry?.npm.v1Version ?? entry?.npm.package;
			const registryVersion = entry?.npm.v2Version || entry?.npm.v1Version;
			if (registryVersion) {
				return registryVersion;
			}
		} catch {
			// Ignored
		}

		try {
			const corePkgPath = path.resolve(
				process.cwd(),
				"node_modules",
				"@elizaos",
				"core",
				"package.json",
			);
			if (await fs.pathExists(corePkgPath)) {
				const pkg = await fs.readJson(corePkgPath);
				return pkg.version || "unknown";
			}
		} catch {
			// Keep unknown fallback
		}

		return "unknown";
	}

	private async readUpstreamMetadata(): Promise<UpstreamMetadata | null> {
		try {
			const raw = await fs.readFile(this.upstreamFilePath(), "utf-8");
			const parsed = JSON.parse(raw) as Partial<UpstreamMetadata>;
			if (
				parsed.$schema !== "eliza-upstream-v1" ||
				typeof parsed.gitUrl !== "string" ||
				typeof parsed.branch !== "string" ||
				typeof parsed.commitHash !== "string" ||
				typeof parsed.npmPackage !== "string" ||
				typeof parsed.npmVersion !== "string"
			) {
				return null;
			}

			return {
				$schema: "eliza-upstream-v1",
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
		} catch {
			return null;
		}
	}

	private async writeUpstreamMetadata(
		metadata: UpstreamMetadata,
	): Promise<void> {
		await fs.ensureDir(this.coreBaseDir());
		await fs.writeJson(this.upstreamFilePath(), metadata, { spaces: 2 });
	}

	private async readTsconfig(): Promise<TsConfig> {
		try {
			return await fs.readJson(this.tsconfigFilePath());
		} catch {
			return {};
		}
	}

	private async writeTsconfigCorePaths(
		targetDistPath: string | null,
	): Promise<void> {
		const config = await this.readTsconfig();
		if (!config.compilerOptions) config.compilerOptions = {};
		if (!config.compilerOptions.paths) config.compilerOptions.paths = {};

		if (!targetDistPath) {
			if (config.compilerOptions.paths[CORE_PACKAGE_NAME]) {
				delete config.compilerOptions.paths[CORE_PACKAGE_NAME];
			}
			if (config.compilerOptions.paths[`${CORE_PACKAGE_NAME}/*`]) {
				delete config.compilerOptions.paths[`${CORE_PACKAGE_NAME}/*`];
			}
		} else {
			const tsconfigDir = path.dirname(this.tsconfigFilePath());
			const relDist = path.relative(tsconfigDir, targetDistPath);
			const relSubpath = path.join(relDist, "*");
			config.compilerOptions.paths[CORE_PACKAGE_NAME] = [relDist];
			config.compilerOptions.paths[`${CORE_PACKAGE_NAME}/*`] = [relSubpath];
		}

		await fs.writeJson(this.tsconfigFilePath(), config, { spaces: 2 });
	}

	private async runCoreInstallAndBuild(monorepoDir: string): Promise<void> {
		await execAsync("bun install", { cwd: monorepoDir });
		await execAsync(`bun --filter ${CORE_PACKAGE_NAME} build`, {
			cwd: monorepoDir,
		});
	}

	private async ensureEjectedCoreExists(): Promise<
		{ ok: true } | { ok: false; error: string }
	> {
		const monorepoDir = this.coreMonorepoDir();
		if (!(await fs.pathExists(monorepoDir))) {
			return { ok: false, error: `${CORE_PACKAGE_NAME} is not ejected` };
		}
		if (!this.isWithinEjectedCoreDir(monorepoDir)) {
			return {
				ok: false,
				error: `Refusing to use core checkout outside ${this.coreBaseDir()}`,
			};
		}
		return { ok: true };
	}

	// Public API methods matching original functionality

	async ejectCore(): Promise<CoreEjectResult> {
		return this.serialise(async () => {
			const npmVersion = await this.resolveInstalledCoreVersion();

			if (!VALID_GIT_URL.test(CORE_GIT_URL)) {
				return {
					success: false,
					ejectedPath: "",
					upstreamCommit: "",
					error: `Invalid git URL: "${CORE_GIT_URL}"`,
				};
			}

			if (!VALID_BRANCH.test(CORE_BRANCH)) {
				return {
					success: false,
					ejectedPath: "",
					upstreamCommit: "",
					error: `Invalid git branch: "${CORE_BRANCH}"`,
				};
			}

			const base = this.coreBaseDir();
			await fs.ensureDir(base);

			const monorepoDir = this.coreMonorepoDir();
			if (!this.isWithinEjectedCoreDir(monorepoDir)) {
				return {
					success: false,
					ejectedPath: monorepoDir,
					upstreamCommit: "",
					error: `Refusing to write outside ${base}`,
				};
			}

			if (await fs.pathExists(monorepoDir)) {
				return {
					success: false,
					ejectedPath: monorepoDir,
					upstreamCommit: "",
					error: `${CORE_PACKAGE_NAME} is already ejected at ${monorepoDir}`,
				};
			}

			logger.info(`Cloning ${CORE_PACKAGE_NAME} from ${CORE_GIT_URL}...`);
			await execFileAsync(
				"git",
				[
					"clone",
					"--branch",
					CORE_BRANCH,
					"--single-branch",
					"--depth",
					"1",
					CORE_GIT_URL,
					monorepoDir,
				],
				{
					env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
				},
			);

			try {
				logger.info(
					`Installing dependencies and building ${CORE_PACKAGE_NAME}...`,
				);
				await this.runCoreInstallAndBuild(monorepoDir);

				const distPath = this.coreDistDir();
				if (!(await fs.pathExists(distPath))) {
					throw new Error(`Missing built output at ${distPath}`);
				}

				const commitHash = await this.gitStdout(
					["rev-parse", "HEAD"],
					monorepoDir,
				);
				const metadata: UpstreamMetadata = {
					$schema: "eliza-upstream-v1",
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

				await this.writeUpstreamMetadata(metadata);
				await this.writeTsconfigCorePaths(distPath);

				logger.success(
					`Successfully ejected ${CORE_PACKAGE_NAME} to ${monorepoDir}`,
				);
				return {
					success: true,
					ejectedPath: monorepoDir,
					upstreamCommit: commitHash,
				};
			} catch (err) {
				logger.error(`Failed to eject core: ${err}`);
				await fs.remove(monorepoDir);
				await fs.remove(this.upstreamFilePath());
				return {
					success: false,
					ejectedPath: monorepoDir,
					upstreamCommit: "",
					error: err instanceof Error ? err.message : String(err),
				};
			}
		});
	}

	async syncCore(): Promise<CoreSyncResult> {
		return this.serialise(async () => {
			const check = await this.ensureEjectedCoreExists();
			if (!check.ok) {
				const checkError = (check as { error: string }).error;
				return {
					success: false,
					ejectedPath: "",
					upstreamCommits: 0,
					localChanges: false,
					conflicts: [],
					commitHash: "",
					error: checkError,
				};
			}

			const monorepoDir = this.coreMonorepoDir();
			const upstream = await this.readUpstreamMetadata();
			if (!upstream) {
				return {
					success: false,
					ejectedPath: monorepoDir,
					upstreamCommits: 0,
					localChanges: false,
					conflicts: [],
					commitHash: "",
					error: `Missing or invalid ${this.upstreamFilePath()}`,
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

			// Check if shallow
			const isShallow = await this.gitStdout(
				["rev-parse", "--is-shallow-repository"],
				monorepoDir,
			).catch(() => "false");
			if (isShallow === "true") {
				try {
					await execAsync(`git fetch --unshallow origin ${upstream.branch}`, {
						cwd: monorepoDir,
						env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
					});
				} catch {
					// Ignore
				}
			}

			await execAsync(`git fetch origin ${upstream.branch}`, {
				cwd: monorepoDir,
				env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
			});

			const localChanges =
				(
					await this.gitStdout(["status", "--porcelain"], monorepoDir).catch(
						() => "",
					)
				).length > 0;
			const upstreamCountRaw = await this.gitStdout(
				["rev-list", "--count", `HEAD..origin/${upstream.branch}`],
				monorepoDir,
			);
			const upstreamCommits = Number.parseInt(upstreamCountRaw, 10) || 0;

			if (upstreamCommits > 0) {
				try {
					await execAsync(`git merge --no-edit origin/${upstream.branch}`, {
						cwd: monorepoDir,
						env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
					});
				} catch (err) {
					const conflictsRaw = await this.gitStdout(
						["diff", "--name-only", "--diff-filter=U"],
						monorepoDir,
					).catch(() => "");
					const conflicts = conflictsRaw
						.split("\n")
						.map((l) => l.trim())
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
				await this.runCoreInstallAndBuild(monorepoDir);
				await this.writeTsconfigCorePaths(this.coreDistDir());
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

			const commitHash = await this.gitStdout(
				["rev-parse", "HEAD"],
				monorepoDir,
			);

			const updated: UpstreamMetadata = {
				...upstream,
				commitHash,
				lastSyncAt: new Date().toISOString(),
			};
			await this.writeUpstreamMetadata(updated);

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

	async reinjectCore(): Promise<CoreReinjectResult> {
		return this.serialise(async () => {
			const monorepoDir = this.coreMonorepoDir();
			if (!(await fs.pathExists(monorepoDir))) {
				return {
					success: false,
					removedPath: "",
					error: `${CORE_PACKAGE_NAME} is not ejected`,
				};
			}

			if (!this.isWithinEjectedCoreDir(monorepoDir)) {
				return {
					success: false,
					removedPath: monorepoDir,
					error: `Refusing to remove core checkout outside ${this.coreBaseDir()}`,
				};
			}

			await fs.remove(monorepoDir);
			await fs.remove(this.upstreamFilePath());

			// Best effort cleanup of parent dir
			try {
				if ((await fs.readdir(this.coreBaseDir())).length === 0) {
					await fs.rmdir(this.coreBaseDir());
				}
			} catch {}

			await this.writeTsconfigCorePaths(null);

			return { success: true, removedPath: monorepoDir };
		});
	}

	async getCoreStatus(): Promise<CoreStatus> {
		const monorepoDir = this.coreMonorepoDir();
		const packageDir = this.corePackageDir();
		const distDir = this.coreDistDir();

		const npmVersion = await this.resolveInstalledCoreVersion();
		const ejected = await fs.pathExists(monorepoDir);

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

		if (!this.isWithinEjectedCoreDir(monorepoDir)) {
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

		const version = await this.readCorePackageVersion(packageDir);
		const commitHash = await this.gitStdout(
			["rev-parse", "HEAD"],
			monorepoDir,
		).catch(() => null);
		const localChanges =
			(
				await this.gitStdout(["status", "--porcelain"], monorepoDir).catch(
					() => "",
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
			upstream: await this.readUpstreamMetadata(),
		};
	}
}
