/**
 * Shared PGLite runtime helper for live scripts under `test/live/`.
 *
 * Duplicated from app-core test helpers so `@elizaos/core` live scenarios
 * stay colocated with the orchestrator implementation.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Plugin } from "@elizaos/core";
import { AgentRuntime, createCharacter, logger } from "@elizaos/core";

export interface TestRuntimeOptions {
	characterName?: string;
	plugins?: Plugin[];
	pgliteDir?: string;
	removePgliteDirOnCleanup?: boolean;
}

export interface TestRuntimeResult {
	runtime: AgentRuntime;
	pgliteDir: string;
	cleanup: () => Promise<void>;
}

type TrajectoryWriteService = {
	writeQueues?: Map<string, Promise<void>>;
};

async function flushPendingTrajectoryWrites(
	runtime: AgentRuntime,
): Promise<void> {
	try {
		const { flushTrajectoryWrites } = await import(
			"../../../agent/src/runtime/trajectory-storage"
		);
		await flushTrajectoryWrites(runtime);
	} catch {
		// Best effort only.
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
