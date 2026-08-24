/**
 * Integration-backed tests for `createRealTestRuntime`, the primary helper for
 * converting mocked suites to real integration tests. Every case boots a real
 * `AgentRuntime` on a real PGlite database through the helper itself and
 * asserts the observable contract callers depend on: data-dir allocation and
 * uniqueness, character naming, caller plugin registration, embedding-dimension
 * defaults, and cleanup's env restoration plus directory removal semantics.
 * No LLM or connector plugins are involved (`withLLM`/`withDiscord`/
 * `withTelegram` stay off), so the suite is deterministic without API keys.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { AgentRuntime } from "../runtime.ts";
import type { Plugin } from "../types/index.ts";
import { isInMemoryPgliteDataDir } from "./pglite-storage.ts";
import { createRealTestRuntime } from "./real-runtime.ts";

/** Env vars the helper reads or mutates; snapshotted and restored per case. */
const MANAGED_ENV_VARS = [
	"PGLITE_DATA_DIR",
	"EMBEDDING_DIMENSION",
	"LOCAL_EMBEDDING_DIMENSIONS",
	"ELIZA_TEST_PGLITE_STORAGE",
] as const;

function snapshotManagedEnv(): Record<string, string | undefined> {
	const snapshot: Record<string, string | undefined> = {};
	for (const key of MANAGED_ENV_VARS) {
		snapshot[key] = process.env[key];
	}
	return snapshot;
}

function restoreManagedEnv(snapshot: Record<string, string | undefined>): void {
	for (const [key, value] of Object.entries(snapshot)) {
		if (value === undefined) {
			delete process.env[key];
		} else {
			process.env[key] = value;
		}
	}
}

/** A minimal caller plugin whose registration must surface in the runtime. */
const probePlugin: Plugin = {
	name: "real-runtime-probe-plugin",
	description: "Registers one probe action to prove caller plugins load.",
	actions: [
		{
			name: "REAL_RUNTIME_PROBE_ACTION",
			description: "Probe action asserted via getAllActions().",
			handler: async () => ({ success: true, text: "probe ok" }),
			validate: async () => true,
		},
	],
};

describe("createRealTestRuntime", () => {
	let managedEnvSnapshot: Record<string, string | undefined>;

	beforeEach(() => {
		managedEnvSnapshot = snapshotManagedEnv();
	});

	afterEach(() => {
		restoreManagedEnv(managedEnvSnapshot);
	});

	it("boots initialized runtimes on unique in-memory PGLite stores by default", async () => {
		process.env.ELIZA_TEST_PGLITE_STORAGE = "memory";

		const first = await createRealTestRuntime();
		try {
			expect(first.runtime).toBeInstanceOf(AgentRuntime);
			expect(isInMemoryPgliteDataDir(first.pgliteDir)).toBe(true);
			expect(first.pgliteDir).toMatch(/^memory:\/\/eliza-real-test-/);

			// While a runtime is alive, its store is exported to the env that
			// plugin-sql and adapters read.
			expect(process.env.PGLITE_DATA_DIR).toBe(first.pgliteDir);

			expect(first.providerName).toBeNull();
			expect(first.providerConfig).toBeNull();
			expect(typeof first.cleanup).toBe("function");

			// Uniqueness contract of createTestPgliteDataDir: a second runtime
			// must never alias the first one's database.
			const second = await createRealTestRuntime();
			try {
				expect(second.pgliteDir).not.toBe(first.pgliteDir);
				expect(second.runtime.character.name).toBe("TestAgent");
			} finally {
				await second.cleanup();
			}
		} finally {
			await first.cleanup();
		}
	}, 120_000);

	it("honors the requested character name", async () => {
		process.env.ELIZA_TEST_PGLITE_STORAGE = "memory";

		const result = await createRealTestRuntime({
			characterName: "Named Probe Agent",
		});
		try {
			expect(result.runtime.character.name).toBe("Named Probe Agent");
		} finally {
			await result.cleanup();
		}
	}, 120_000);

	it("registers caller-supplied plugins so their actions are available", async () => {
		process.env.ELIZA_TEST_PGLITE_STORAGE = "memory";

		const result = await createRealTestRuntime({ plugins: [probePlugin] });
		try {
			const actionNames = result.runtime.getAllActions().map((a) => a.name);
			expect(actionNames).toContain("REAL_RUNTIME_PROBE_ACTION");
		} finally {
			await result.cleanup();
		}
	}, 120_000);

	it("applies local embedding defaults when the environment leaves them unset", async () => {
		delete process.env.LOCAL_EMBEDDING_DIMENSIONS;
		delete process.env.EMBEDDING_DIMENSION;
		process.env.ELIZA_TEST_PGLITE_STORAGE = "memory";

		const result = await createRealTestRuntime();
		try {
			// Vector search needs a width shared by the DB schema and model;
			// the helper pins 384 when the host did not choose one.
			expect(process.env.LOCAL_EMBEDDING_DIMENSIONS).toBe("384");
			expect(process.env.EMBEDDING_DIMENSION).toBe("384");
		} finally {
			await result.cleanup();
		}
	}, 120_000);

	it("preserves embedding dimensions the environment already set", async () => {
		process.env.LOCAL_EMBEDDING_DIMENSIONS = "1536";
		process.env.EMBEDDING_DIMENSION = "1536";
		process.env.ELIZA_TEST_PGLITE_STORAGE = "memory";

		const result = await createRealTestRuntime();
		try {
			expect(process.env.LOCAL_EMBEDDING_DIMENSIONS).toBe("1536");
			expect(process.env.EMBEDDING_DIMENSION).toBe("1536");
		} finally {
			await result.cleanup();
		}
	}, 120_000);

	it("cleanup restores a previously-set PGLITE_DATA_DIR", async () => {
		process.env.PGLITE_DATA_DIR = "/tmp/eliza-real-runtime-prev-store";
		process.env.ELIZA_TEST_PGLITE_STORAGE = "memory";

		const result = await createRealTestRuntime();
		expect(process.env.PGLITE_DATA_DIR).toBe(result.pgliteDir);

		await result.cleanup();
		expect(process.env.PGLITE_DATA_DIR).toBe(
			"/tmp/eliza-real-runtime-prev-store",
		);
	}, 120_000);

	it("cleanup deletes PGLITE_DATA_DIR when it was previously unset", async () => {
		delete process.env.PGLITE_DATA_DIR;
		process.env.ELIZA_TEST_PGLITE_STORAGE = "memory";

		const result = await createRealTestRuntime();

		await result.cleanup();
		expect(process.env.PGLITE_DATA_DIR).toBeUndefined();
	}, 120_000);

	it("keeps caller-provided directories on cleanup by default", async () => {
		const callerDir = fs.mkdtempSync(
			path.join(os.tmpdir(), "eliza-real-runtime-probe-"),
		);

		const result = await createRealTestRuntime({ pgliteDir: callerDir });
		try {
			expect(result.pgliteDir).toBe(callerDir);
			expect(fs.existsSync(callerDir)).toBe(true);
		} finally {
			await result.cleanup();
			// Removal defaults to true only for auto-created dirs; a caller
			// that passes its own directory owns removing it.
			fs.rmSync(callerDir, { recursive: true, force: true });
		}
	}, 120_000);

	it("removes caller-provided directories when removePgliteDirOnCleanup is true", async () => {
		const callerDir = fs.mkdtempSync(
			path.join(os.tmpdir(), "eliza-real-runtime-remove-"),
		);

		const result = await createRealTestRuntime({
			pgliteDir: callerDir,
			removePgliteDirOnCleanup: true,
		});
		try {
			expect(fs.existsSync(callerDir)).toBe(true);
		} finally {
			await result.cleanup();
		}
		expect(fs.existsSync(callerDir)).toBe(false);
	}, 120_000);

	it("allocates and removes a disk-backed store automatically in disk mode", async () => {
		process.env.ELIZA_TEST_PGLITE_STORAGE = "disk";

		const result = await createRealTestRuntime();
		try {
			// Disk mode hands out a real temp directory, which flips the
			// removal default: the helper owns the directory it created.
			expect(isInMemoryPgliteDataDir(result.pgliteDir)).toBe(false);
			expect(fs.existsSync(result.pgliteDir)).toBe(true);
		} finally {
			await result.cleanup();
		}
		expect(fs.existsSync(result.pgliteDir)).toBe(false);
	}, 120_000);

	it("awaits the injected trajectory flusher before and after stopping", async () => {
		process.env.ELIZA_TEST_PGLITE_STORAGE = "memory";

		const flushedRuntimes: AgentRuntime[] = [];
		const result = await createRealTestRuntime({
			flushTrajectoryWrites: async (runtime) => {
				flushedRuntimes.push(runtime);
			},
		});
		try {
			expect(flushedRuntimes).toEqual([]);
			await result.cleanup();
		} finally {
			restoreManagedEnv(managedEnvSnapshot);
		}
		// Cleanup drains trajectory writes once pre-stop and once post-stop;
		// both flushes target this runtime instance.
		expect(flushedRuntimes.length).toBe(2);
		expect(flushedRuntimes[0]).toBe(result.runtime);
		expect(flushedRuntimes[1]).toBe(result.runtime);
	}, 120_000);
});
