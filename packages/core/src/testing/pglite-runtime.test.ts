/**
 * Exercises the shared PGLite test-runtime factory (`createTestRuntime`)
 * against real AgentRuntime boots over real in-process PGLite databases — the
 * database is never mocked. Covers storage-mode defaults, environment
 * capture/restoration, embedding-dimension validation and propagation,
 * caller-provided data directories with their cleanup policy, and
 * trajectory-flush handling during teardown. No model inference runs, so the
 * suite is deterministic and touches no network.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { AgentRuntime } from "../runtime";
import type { Plugin } from "../types";
import { createTestRuntime } from "./pglite-runtime";
import { isInMemoryPgliteDataDir } from "./pglite-storage";

const MEMORY_DIR_PATTERN = /^memory:\/\/eliza-test-pglite-\d+-\d+$/;

const BOOT_TIMEOUT = 180_000;

const markerPlugin: Plugin = {
	name: "pglite-runtime-marker-plugin",
	description: "Verifies that configured plugins reach initialization",
	providers: [
		{
			name: "pglite-runtime-marker-provider",
			get: async () => ({ text: "marker" }),
		},
	],
};

function countStops(runtime: AgentRuntime): () => number {
	let stops = 0;
	const realStop = runtime.stop.bind(runtime);
	runtime.stop = async () => {
		stops += 1;
		await realStop();
	};
	return () => stops;
}

function restoreEnvVar(key: string, previous: string | undefined): void {
	if (previous === undefined) {
		delete process.env[key];
	} else {
		process.env[key] = previous;
	}
}

describe("createTestRuntime", () => {
	it(
		"boots an initialized runtime over a unique in-memory database by default",
		async () => {
			const prevPgliteDir = process.env.PGLITE_DATA_DIR;
			const result = await createTestRuntime();

			try {
				expect(result.runtime).toBeInstanceOf(AgentRuntime);
				expect(await result.runtime.isReady()).toBe(true);
				expect(result.runtime.character.name).toBe("TestAgent");
				expect(result.pgliteDir).toMatch(MEMORY_DIR_PATTERN);
				expect(isInMemoryPgliteDataDir(result.pgliteDir)).toBe(true);
				expect(process.env.PGLITE_DATA_DIR).toBe(result.pgliteDir);
			} finally {
				await result.cleanup();
			}

			if (prevPgliteDir === undefined) {
				expect(process.env.PGLITE_DATA_DIR).toBeUndefined();
			} else {
				expect(process.env.PGLITE_DATA_DIR).toBe(prevPgliteDir);
			}
		},
		BOOT_TIMEOUT,
	);

	it(
		"rejects embedding dimensions that are not positive safe integers",
		async () => {
			const prevPgliteDir = process.env.PGLITE_DATA_DIR;
			try {
				for (const embeddingDimensions of [
					0,
					-4,
					2.5,
					Number.NaN,
					Number.POSITIVE_INFINITY,
				]) {
					await expect(
						createTestRuntime({ embeddingDimensions }),
					).rejects.toThrow("embeddingDimensions must be a positive integer");
				}
			} finally {
				// The guard throws after capturing the data dir but before any
				// cleanup exists, so the captured env var has to be restored here.
				restoreEnvVar("PGLITE_DATA_DIR", prevPgliteDir);
			}
		},
		BOOT_TIMEOUT,
	);

	it(
		"publishes valid embedding dimensions into the environment and restores prior values on cleanup",
		async () => {
			process.env.EMBEDDING_DIMENSION = "prev-dimension";
			process.env.LOCAL_EMBEDDING_DIMENSIONS = "prev-local";
			const result = await createTestRuntime({ embeddingDimensions: 384 });

			try {
				expect(await result.runtime.isReady()).toBe(true);
				expect(process.env.EMBEDDING_DIMENSION).toBe("384");
				expect(process.env.LOCAL_EMBEDDING_DIMENSIONS).toBe("384");
			} finally {
				await result.cleanup();
			}

			expect(process.env.EMBEDDING_DIMENSION).toBe("prev-dimension");
			expect(process.env.LOCAL_EMBEDDING_DIMENSIONS).toBe("prev-local");
		},
		BOOT_TIMEOUT,
	);

	it(
		"deletes the embedding variables on cleanup when they were unset before creation",
		async () => {
			delete process.env.EMBEDDING_DIMENSION;
			delete process.env.LOCAL_EMBEDDING_DIMENSIONS;
			const result = await createTestRuntime({ embeddingDimensions: 64 });

			try {
				expect(process.env.EMBEDDING_DIMENSION).toBe("64");
				expect(process.env.LOCAL_EMBEDDING_DIMENSIONS).toBe("64");
			} finally {
				await result.cleanup();
			}

			expect(process.env.EMBEDDING_DIMENSION).toBeUndefined();
			expect(process.env.LOCAL_EMBEDDING_DIMENSIONS).toBeUndefined();
		},
		BOOT_TIMEOUT,
	);

	it(
		"honors characterName and registers caller plugins next to plugin-sql",
		async () => {
			const result = await createTestRuntime({
				characterName: "NamedAgent",
				plugins: [markerPlugin],
			});

			try {
				expect(result.runtime.character.name).toBe("NamedAgent");
				const providerNames = result.runtime.providers.map(
					(provider) => provider.name,
				);
				expect(providerNames).toContain("pglite-runtime-marker-provider");
			} finally {
				await result.cleanup();
			}
		},
		BOOT_TIMEOUT,
	);

	it(
		"keeps a caller-provided data directory through cleanup by default",
		async () => {
			const providedDir = fs.mkdtempSync(
				path.join(os.tmpdir(), "eliza-pglite-runtime-kept-"),
			);
			const result = await createTestRuntime({ pgliteDir: providedDir });

			try {
				expect(result.pgliteDir).toBe(providedDir);
				expect(isInMemoryPgliteDataDir(result.pgliteDir)).toBe(false);
				expect(await result.runtime.isReady()).toBe(true);
			} finally {
				await result.cleanup();
			}

			expect(fs.existsSync(providedDir)).toBe(true);
			fs.rmSync(providedDir, { recursive: true, force: true });
		},
		BOOT_TIMEOUT,
	);

	it(
		"removes the caller-provided directory on cleanup when removePgliteDirOnCleanup is set",
		async () => {
			const providedDir = fs.mkdtempSync(
				path.join(os.tmpdir(), "eliza-pglite-runtime-removed-"),
			);
			const result = await createTestRuntime({
				pgliteDir: providedDir,
				removePgliteDirOnCleanup: true,
			});

			try {
				expect(fs.existsSync(providedDir)).toBe(true);
			} finally {
				await result.cleanup();
			}

			expect(fs.existsSync(providedDir)).toBe(false);
		},
		BOOT_TIMEOUT,
	);

	it(
		"awaits the injected trajectory flush twice around stopping the runtime exactly once",
		async () => {
			const flushedRuntimes: AgentRuntime[] = [];
			const result = await createTestRuntime({
				flushTrajectoryWrites: async (runtime) => {
					flushedRuntimes.push(runtime);
				},
			});
			const stopCount = countStops(result.runtime);

			await result.cleanup();

			expect(stopCount()).toBe(1);
			expect(flushedRuntimes).toHaveLength(2);
			expect(flushedRuntimes[0]).toBe(result.runtime);
			expect(flushedRuntimes[1]).toBe(result.runtime);
		},
		BOOT_TIMEOUT,
	);

	it(
		"completes cleanup without rejecting when the injected trajectory flush fails",
		async () => {
			const result = await createTestRuntime({
				flushTrajectoryWrites: async () => {
					throw new Error("host flush exploded");
				},
			});
			const stopCount = countStops(result.runtime);

			await expect(result.cleanup()).resolves.toBeUndefined();

			expect(stopCount()).toBe(1);
		},
		BOOT_TIMEOUT,
	);
});
