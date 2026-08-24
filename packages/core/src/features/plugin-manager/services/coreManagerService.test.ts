/**
 * Exercises the core manager's lifecycle, serialized operations, filesystem
 * state transitions, tsconfig rewrites, metadata parsing, and real Git status
 * discovery while keeping clone/install boundaries out of the unit harness.
 */

import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { IAgentRuntime } from "../../../types/runtime.ts";
import {
	CoreManagerService,
	type UpstreamMetadata,
} from "./coreManagerService.ts";
import { resetRegistryCache } from "./pluginRegistryService.ts";

const originalCwd = process.cwd();
const originalStateDir = process.env.ELIZA_STATE_DIR;

let temporaryDirectory: string;
let stateDirectory: string;
let runtime: IAgentRuntime;

function coreBaseDirectory(): string {
	return path.join(stateDirectory, "core");
}

function monorepoDirectory(): string {
	return path.join(coreBaseDirectory(), "eliza");
}

async function writeJson(filePath: string, value: unknown): Promise<void> {
	await mkdir(path.dirname(filePath), { recursive: true });
	await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function createInstalledCore(version = "9.8.7"): Promise<void> {
	await writeJson(
		path.join(
			temporaryDirectory,
			"node_modules",
			"@elizaos",
			"core",
			"package.json",
		),
		{ version },
	);
}

async function createEjectedGitRepository(): Promise<string> {
	const monorepoDir = monorepoDirectory();
	const packageDir = path.join(monorepoDir, "packages", "core");
	await writeJson(path.join(packageDir, "package.json"), {
		version: "2.1.0-local",
	});
	await writeFile(path.join(monorepoDir, "tracked.txt"), "committed\n", "utf8");
	execFileSync("git", ["init", "--initial-branch=develop"], {
		cwd: monorepoDir,
	});
	execFileSync("git", ["config", "user.email", "tests@elizaos.ai"], {
		cwd: monorepoDir,
	});
	execFileSync("git", ["config", "user.name", "elizaOS Tests"], {
		cwd: monorepoDir,
	});
	execFileSync("git", ["add", "."], { cwd: monorepoDir });
	execFileSync("git", ["commit", "-m", "test fixture"], {
		cwd: monorepoDir,
	});
	return execFileSync("git", ["rev-parse", "HEAD"], {
		cwd: monorepoDir,
		encoding: "utf8",
	}).trim();
}

beforeEach(async () => {
	temporaryDirectory = await mkdtemp(path.join(tmpdir(), "core-manager-"));
	stateDirectory = path.join(temporaryDirectory, "state");
	process.env.ELIZA_STATE_DIR = stateDirectory;
	process.chdir(temporaryDirectory);
	await createInstalledCore();
	await writeJson(path.join(temporaryDirectory, "tsconfig.json"), {
		compilerOptions: {},
	});
	runtime = {
		reportError: vi.fn(),
	} as unknown as IAgentRuntime;
	vi.stubGlobal(
		"fetch",
		vi.fn().mockRejectedValue(new Error("offline registry")),
	);
});

afterEach(async () => {
	process.chdir(originalCwd);
	if (originalStateDir === undefined) {
		delete process.env.ELIZA_STATE_DIR;
	} else {
		process.env.ELIZA_STATE_DIR = originalStateDir;
	}
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
	resetRegistryCache();
	await rm(temporaryDirectory, { recursive: true, force: true });
});

describe("CoreManagerService", () => {
	it("exposes its service contract and lifecycle", async () => {
		const service = await CoreManagerService.start(runtime);

		expect(CoreManagerService.serviceType).toBe("core_manager");
		expect(service).toBeInstanceOf(CoreManagerService);
		expect(service.capabilityDescription).toBe(
			"Manages the core ElizaOS installation (eject, sync, reinject)",
		);
		await expect(service.stop()).resolves.toBeUndefined();
	});

	it("reports the packaged core when no ejected checkout exists", async () => {
		const service = new CoreManagerService(runtime);

		await expect(service.getCoreStatus()).resolves.toEqual({
			ejected: false,
			ejectedPath: monorepoDirectory(),
			monorepoPath: monorepoDirectory(),
			corePackagePath: path.join(monorepoDirectory(), "packages", "core"),
			coreDistPath: path.join(monorepoDirectory(), "packages", "core", "dist"),
			version: "9.8.7",
			npmVersion: "9.8.7",
			commitHash: null,
			localChanges: false,
			upstream: null,
		});
		expect(runtime.reportError).toHaveBeenCalledOnce();
	});

	it("returns explicit missing-state results without creating core storage", async () => {
		const service = new CoreManagerService(runtime);

		await expect(service.syncCore()).resolves.toEqual({
			success: false,
			error: "@elizaos/core is not ejected",
		});
		await expect(service.reinjectCore()).resolves.toEqual({
			success: false,
			error: "@elizaos/core is not ejected",
		});
		await expect(readFile(path.join(stateDirectory, "core"))).rejects.toThrow();
	});

	it("refuses to eject over an existing checkout", async () => {
		await mkdir(monorepoDirectory(), { recursive: true });
		const service = new CoreManagerService(runtime);

		await expect(service.ejectCore()).resolves.toEqual({
			success: false,
			ejectedPath: monorepoDirectory(),
			error: `@elizaos/core is already ejected at ${monorepoDirectory()}`,
		});
	});

	it("reinjects using real files and preserves unrelated tsconfig paths", async () => {
		await mkdir(monorepoDirectory(), { recursive: true });
		await writeFile(
			path.join(coreBaseDirectory(), "keep.txt"),
			"keep\n",
			"utf8",
		);
		await writeJson(path.join(coreBaseDirectory(), ".upstream.json"), {
			$schema: "eliza-upstream-v1",
		});
		await writeJson(path.join(temporaryDirectory, "tsconfig.json"), {
			compilerOptions: {
				paths: {
					"@elizaos/core": ["state/core/eliza/packages/core/dist"],
					"@elizaos/core/*": ["state/core/eliza/packages/core/dist/*"],
					"@fixture/*": ["fixtures/*"],
				},
			},
		});
		const service = new CoreManagerService(runtime);

		await expect(service.reinjectCore()).resolves.toEqual({
			success: true,
			removedPath: monorepoDirectory(),
		});
		await expect(
			readFile(path.join(coreBaseDirectory(), "keep.txt"), "utf8"),
		).resolves.toBe("keep\n");
		await expect(
			readFile(path.join(coreBaseDirectory(), ".upstream.json")),
		).rejects.toThrow();
		expect(
			JSON.parse(
				await readFile(path.join(temporaryDirectory, "tsconfig.json"), "utf8"),
			),
		).toEqual({ compilerOptions: { paths: { "@fixture/*": ["fixtures/*"] } } });
	});

	it("removes an empty core parent directory after reinjection", async () => {
		await mkdir(monorepoDirectory(), { recursive: true });
		await writeJson(path.join(coreBaseDirectory(), ".upstream.json"), {
			$schema: "eliza-upstream-v1",
		});
		const service = new CoreManagerService(runtime);

		await expect(service.reinjectCore()).resolves.toMatchObject({
			success: true,
		});
		await expect(readFile(coreBaseDirectory())).rejects.toThrow();
	});

	it("reads real Git state and normalizes optional upstream metadata", async () => {
		const commitHash = await createEjectedGitRepository();
		const metadata = {
			$schema: "eliza-upstream-v1",
			gitUrl: "https://github.com/elizaOS/eliza.git",
			branch: "develop",
			commitHash,
			npmPackage: "@elizaos/core",
			npmVersion: "2.0.3-beta.7",
			ejectedAt: 42,
			lastSyncAt: false,
			localCommits: Number.NaN,
		};
		await writeJson(path.join(coreBaseDirectory(), ".upstream.json"), metadata);
		await writeFile(
			path.join(monorepoDirectory(), "tracked.txt"),
			"changed\n",
			"utf8",
		);
		const service = new CoreManagerService(runtime);

		const status = await service.getCoreStatus();

		expect(status).toMatchObject({
			ejected: true,
			version: "2.1.0-local",
			npmVersion: "9.8.7",
			commitHash,
			localChanges: true,
		});
		expect(status.upstream).toMatchObject({
			$schema: "eliza-upstream-v1",
			source: "github:elizaos/eliza",
			gitUrl: metadata.gitUrl,
			branch: "develop",
			commitHash,
			npmPackage: "@elizaos/core",
			npmVersion: "2.0.3-beta.7",
			lastSyncAt: null,
			localCommits: 0,
		} satisfies Partial<UpstreamMetadata>);
		expect(Date.parse(status.upstream?.ejectedAt ?? "")).not.toBeNaN();
	});

	it("releases the serialized lock after a rejected sync", async () => {
		await mkdir(monorepoDirectory(), { recursive: true });
		await writeJson(path.join(coreBaseDirectory(), ".upstream.json"), {
			$schema: "eliza-upstream-v1",
			source: "github:elizaos/eliza",
			gitUrl: "https://github.com/elizaOS/eliza.git",
			branch: "develop",
			commitHash: "not-a-repository",
			ejectedAt: "2026-08-23T00:00:00.000Z",
			npmPackage: "@elizaos/core",
			npmVersion: "9.8.7",
			lastSyncAt: null,
			localCommits: 0,
		} satisfies UpstreamMetadata);
		const service = new CoreManagerService(runtime);

		const sync = service.syncCore().catch((error: unknown) => error);
		const reinject = service.reinjectCore();

		expect(await sync).toBeInstanceOf(Error);
		await expect(reinject).resolves.toEqual({
			success: true,
			removedPath: monorepoDirectory(),
		});
	});
});
