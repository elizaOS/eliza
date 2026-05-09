/**
 * Shared PGLite runtime helper for tests.
 *
 * Creates a real AgentRuntime backed by an in-process PGLite database.
 * Use this instead of mocking the database — PGLite needs no API keys
 * and runs entirely in-process.
 *
 * Usage:
 *   let runtime: AgentRuntime;
 *   let cleanup: () => Promise<void>;
 *
 *   beforeAll(async () => {
 *     ({ runtime, cleanup } = await createTestRuntime());
 *   }, 180_000);
 *
 *   afterAll(async () => {
 *     await cleanup();
 *   });
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Plugin } from "@elizaos/core";
import { AgentRuntime, createCharacter, logger } from "@elizaos/core";

export interface TestRuntimeOptions {
	/** Name for the test agent character. Defaults to "TestAgent". */
	characterName?: string;
	/** Additional plugins to register (plugin-sql is always included). */
	plugins?: Plugin[];
	/** Reuse an existing PGLite data directory instead of creating a temp one. */
	pgliteDir?: string;
	/**
	 * Remove the PGLite data directory during cleanup.
	 * Defaults to true only when this helper created the directory.
	 */
	removePgliteDirOnCleanup?: boolean;
}

export interface TestRuntimeResult {
	runtime: AgentRuntime;
	pgliteDir: string;
	/** Stops the runtime and removes the temp PGLite directory. */
	cleanup: () => Promise<void>;
}

type TrajectoryWriteService = {
	writeQueues?: Map<string, Promise<void>>;
};

type TrajectoryStorageModule = {
	flushTrajectoryWrites?: (runtime: AgentRuntime) => Promise<void>;
};

async function flushPendingTrajectoryWrites(
	runtime: AgentRuntime,
): Promise<void> {
	try {
		const modulePath = "../../../agent/src/runtime/trajectory-storage";
		const { flushTrajectoryWrites } = (await import(
			modulePath
		)) as TrajectoryStorageModule;
		await flushTrajectoryWrites?.(runtime);
	} catch {
		// Best effort only. Some test runtimes do not register this helper.
	}

	for (let attempt = 0; attempt < 3; attempt += 1) {
		const pending = runtime
			.getServicesByType("trajectories")
			.flatMap((service) => {
				const writeQueues = (service as TrajectoryWriteService).writeQueues;
				return writeQueues instanceof Map
					? Array.from(writeQueues.values())
					: [];
			});
		if (pending.length === 0) {
			return;
		}
		await Promise.allSettled(pending);
		await new Promise((resolve) => setTimeout(resolve, 0));
	}
}

/**
 * Create a real AgentRuntime with a PGLite database in a temp directory.
 *
 * The runtime is fully initialized and ready for use. Call `cleanup()` in
 * afterAll to stop the runtime and remove the temp directory.
 *
 * Callers should use a generous timeout (e.g. `beforeAll(async () => { ... }, 180_000)`)
 * since PGLite initialization can take a few seconds.
 */
export async function createTestRuntime(
	options?: TestRuntimeOptions,
): Promise<TestRuntimeResult> {
	const pgliteDir =
		options?.pgliteDir ??
		fs.mkdtempSync(path.join(os.tmpdir(), "eliza-test-pglite-"));
	const removePgliteDirOnCleanup =
		options?.removePgliteDirOnCleanup ?? options?.pgliteDir === undefined;

	const prevPgliteDir = process.env.PGLITE_DATA_DIR;
	process.env.PGLITE_DATA_DIR = pgliteDir;

	const character = createCharacter({
		name: options?.characterName ?? "TestAgent",
	});

	const runtime = new AgentRuntime({
		character,
		plugins: [],
		logLevel: "warn",
		enableAutonomy: false,
	});

	const { default: pluginSql } = await import("@elizaos/plugin-sql");
	await runtime.registerPlugin(pluginSql);
	for (const plugin of options?.plugins ?? []) {
		await runtime.registerPlugin(plugin);
	}
	await runtime.initialize();

	const cleanup = async () => {
		try {
			await flushPendingTrajectoryWrites(runtime);
		} catch (err) {
			logger.debug(`[test] trajectory flush error: ${err}`);
		}
		try {
			await runtime.stop();
		} catch (err) {
			logger.debug(`[test] runtime.stop() error: ${err}`);
		}
		try {
			await flushPendingTrajectoryWrites(runtime);
		} catch (err) {
			logger.debug(`[test] post-stop trajectory flush error: ${err}`);
		}
		try {
			await runtime.close();
		} catch (err) {
			logger.debug(`[test] runtime.close() error: ${err}`);
		}
		// Restore previous env
		if (prevPgliteDir !== undefined) {
			process.env.PGLITE_DATA_DIR = prevPgliteDir;
		} else {
			delete process.env.PGLITE_DATA_DIR;
		}
		if (removePgliteDirOnCleanup) {
			try {
				fs.rmSync(pgliteDir, { recursive: true, force: true });
			} catch {
				// ignore cleanup errors
			}
		}
	};

	return { runtime, pgliteDir, cleanup };
}
