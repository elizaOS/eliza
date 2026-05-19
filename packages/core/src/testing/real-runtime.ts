/**
 * Real runtime helper for integration tests.
 *
 * Extends pglite-runtime.ts with optional real LLM and connector plugins.
 * This is the primary helper for converting mocked tests to real integration tests.
 *
 * Usage:
 *   import { createRealTestRuntime } from "../../test/helpers/real-runtime";
 *
 *   let runtime: AgentRuntime;
 *   let cleanup: () => Promise<void>;
 *
 *   beforeAll(async () => {
 *     ({ runtime, cleanup } = await createRealTestRuntime({ withLLM: true }));
 *   }, 180_000);
 *
 *   afterAll(async () => { await cleanup(); });
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createCharacter } from "../character";
import { logger } from "../logger";
import { AgentRuntime } from "../runtime";
import type { Plugin } from "../types";

/** Workspace plugins may resolve `@elizaos/core` from npm while this package uses source types. */
type RegisterablePlugin = Parameters<AgentRuntime["registerPlugin"]>[0];

import {
	type LiveProviderConfig,
	type LiveProviderName,
	selectLiveProvider,
} from "./live-provider";

export interface RealTestRuntimeOptions {
	/** Name for the test agent character. Defaults to "TestAgent". */
	characterName?: string;
	/** Additional plugins to register. */
	plugins?: Plugin[];
	/** Register a real LLM plugin based on available API keys. Default: false. */
	withLLM?: boolean;
	/** Preferred LLM provider (e.g., "groq" for cheapest). */
	preferredProvider?: LiveProviderName;
	/** Register Discord plugin if DISCORD_BOT_TOKEN is available. Default: false. */
	withDiscord?: boolean;
	/** Register Telegram plugin if TELEGRAM_BOT_TOKEN is available. Default: false. */
	withTelegram?: boolean;
	/** Reuse an existing PGLite data directory. */
	pgliteDir?: string;
	/** Remove PGLite dir on cleanup. Defaults to true when dir is auto-created. */
	removePgliteDirOnCleanup?: boolean;
}

export interface RealTestRuntimeResult {
	runtime: AgentRuntime;
	pgliteDir: string;
	/** Which LLM provider was registered (null if withLLM was false or none available). */
	providerName: LiveProviderName | null;
	/** The full provider config if an LLM was registered. */
	providerConfig: LiveProviderConfig | null;
	/** Stops the runtime and removes the temp PGLite directory. */
	cleanup: () => Promise<void>;
}

function applyRuntimeSettings(
	runtime: AgentRuntime,
	settings: Record<string, string>,
): void {
	for (const [key, value] of Object.entries(settings)) {
		runtime.setSetting(
			key,
			value,
			/(API_KEY|TOKEN|SECRET|PASSWORD)/i.test(key),
		);
	}
}

type TrajectoryWriteService = {
	writeQueues?: Map<string, Promise<void>>;
};

type TrajectoryStorageModule = {
	flushTrajectoryWrites?: (runtime: AgentRuntime) => Promise<void>;
};

type AgentRuntimeModule = {
	configureLocalEmbeddingPlugin?: (plugin: Plugin) => void;
};

type RuntimePluginModule = {
	default?: Plugin;
	elizaPlugin?: Plugin;
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
 * Create a real AgentRuntime with PGLite database and optional real LLM/connectors.
 *
 * This is the go-to helper for integration tests. It creates a fully initialized
 * runtime backed by a real in-process PGLite database, with optional real LLM
 * inference and connector plugins.
 */
export async function createRealTestRuntime(
	options?: RealTestRuntimeOptions,
): Promise<RealTestRuntimeResult> {
	const pgliteDir =
		options?.pgliteDir ??
		fs.mkdtempSync(path.join(os.tmpdir(), "eliza-real-test-"));
	const removePgliteDirOnCleanup =
		options?.removePgliteDirOnCleanup ?? options?.pgliteDir === undefined;

	const prevPgliteDir = process.env.PGLITE_DATA_DIR;
	process.env.PGLITE_DATA_DIR = pgliteDir;

	// Apply local embedding defaults so PGLite vector search works
	if (!process.env.LOCAL_EMBEDDING_DIMENSIONS?.trim()) {
		process.env.LOCAL_EMBEDDING_DIMENSIONS = "384";
	}
	if (!process.env.EMBEDDING_DIMENSION?.trim()) {
		process.env.EMBEDDING_DIMENSION = "384";
	}

	const character = createCharacter({
		name: options?.characterName ?? "TestAgent",
	});

	const runtime = new AgentRuntime({
		character,
		plugins: [],
		logLevel: "warn",
		enableAutonomy: false,
	});

	// Always register plugin-sql for PGLite database
	const pluginSqlModule = (await import(
		["@elizaos", "plugin-sql"].join("/")
	)) as RuntimePluginModule;
	const pluginSql = pluginSqlModule.default ?? pluginSqlModule.elizaPlugin;
	if (!pluginSql) {
		throw new Error("plugin-sql did not export a plugin");
	}
	await runtime.registerPlugin(pluginSql as RegisterablePlugin);

	// Register LLM plugin if requested
	let providerName: LiveProviderName | null = null;
	let providerConfig: LiveProviderConfig | null = null;

	if (options?.withLLM) {
		providerConfig = selectLiveProvider(options.preferredProvider);
		if (providerConfig) {
			providerName = providerConfig.name;
			// Set provider env vars so the plugin picks them up
			for (const [key, value] of Object.entries(providerConfig.env)) {
				process.env[key] = value;
			}
			applyRuntimeSettings(runtime, providerConfig.env);
			try {
				const pluginModule = await import(providerConfig.pluginPackage);
				const plugin = pluginModule.default ?? pluginModule.elizaPlugin;
				if (plugin) {
					await runtime.registerPlugin(plugin as RegisterablePlugin);
					logger.info(
						`[real-runtime] Registered LLM plugin: ${providerConfig.pluginPackage} (${providerName})`,
					);
				}
			} catch (err) {
				logger.warn(
					`[real-runtime] Failed to register LLM plugin ${providerConfig.pluginPackage}: ${err}`,
				);
				providerName = null;
				providerConfig = null;
			}
		}
	}

	if (options?.withLLM && !providerConfig) {
		try {
			const pluginModule = (await import(
				["@elizaos", "plugin-local-embedding"].join("/")
			)) as RuntimePluginModule;
			const plugin = pluginModule.default ?? pluginModule.elizaPlugin;
			if (plugin) {
				const modulePath = "../../../agent/src/runtime/eliza";
				const agentRuntimeModule = (await import(
					modulePath
				)) as AgentRuntimeModule;
				agentRuntimeModule.configureLocalEmbeddingPlugin?.(plugin);
				await runtime.registerPlugin(plugin as RegisterablePlugin);
				logger.info(
					"[real-runtime] Registered local embedding plugin for TEXT_EMBEDDING",
				);
			}
		} catch (err) {
			logger.warn(
				`[real-runtime] Failed to register local embedding plugin: ${err}`,
			);
		}
	}

	// Register Discord plugin if requested and token available
	if (options?.withDiscord && process.env.DISCORD_BOT_TOKEN?.trim()) {
		try {
			const discordModule = (await import(
				["@elizaos", "plugin-discord"].join("/")
			)) as RuntimePluginModule;
			const plugin = discordModule.default ?? discordModule.elizaPlugin;
			if (plugin) {
				await runtime.registerPlugin(plugin as RegisterablePlugin);
				logger.info("[real-runtime] Registered Discord plugin");
			}
		} catch (err) {
			logger.warn(`[real-runtime] Failed to register Discord plugin: ${err}`);
		}
	}

	// Register Telegram plugin if requested and token available
	if (options?.withTelegram && process.env.TELEGRAM_BOT_TOKEN?.trim()) {
		try {
			const telegramModule = (await import(
				["@elizaos", "plugin-telegram"].join("/")
			)) as RuntimePluginModule;
			const plugin = telegramModule.default ?? telegramModule.elizaPlugin;
			if (plugin) {
				await runtime.registerPlugin(plugin as RegisterablePlugin);
				logger.info("[real-runtime] Registered Telegram plugin");
			}
		} catch (err) {
			logger.warn(`[real-runtime] Failed to register Telegram plugin: ${err}`);
		}
	}

	// Register any additional plugins
	for (const plugin of options?.plugins ?? []) {
		await runtime.registerPlugin(plugin);
	}

	await runtime.initialize();

	const cleanup = async () => {
		try {
			await flushPendingTrajectoryWrites(runtime);
		} catch (err) {
			logger.debug(`[real-runtime] trajectory flush error: ${err}`);
		}
		try {
			await runtime.stop();
		} catch (err) {
			logger.debug(`[real-runtime] runtime.stop() error: ${err}`);
		}
		try {
			await flushPendingTrajectoryWrites(runtime);
		} catch (err) {
			logger.debug(`[real-runtime] post-stop trajectory flush error: ${err}`);
		}
		try {
			await runtime.close();
		} catch (err) {
			logger.debug(`[real-runtime] runtime.close() error: ${err}`);
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

	return { runtime, pgliteDir, providerName, providerConfig, cleanup };
}
