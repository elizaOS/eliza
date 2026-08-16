/**
 * Runtime factory helpers using AgentFactoryOptions and safe defaults.
 *
 * Provides drop-in functions to create AgentRuntime instances with minimal
 * boilerplate, automatic adapter setup, and sensible defaults for common use cases.
 *
 * @example
 * ```ts
 * import { createAgent, createAgents } from "@elizaos/core/runtime-factory";
 * import { character } from "./character";
 *
 * // Single agent
 * const runtime = await createAgent({
 *   character,
 *   adapter: myAdapter,
 * });
 *
 * // Multiple agents from character files
 * const runtimes = await createAgents({
 *   characterPaths: ["./chars/alice.json", "./chars/bob.json"],
 *   adapter: myAdapter,
 * });
 * ```
 */

import { AgentRuntime } from "./runtime";
import type { AgentFactoryOptions } from "./types/agent-integration";
import type { IAgentRuntime } from "./types";
import type { IDatabaseAdapter } from "./types/database";
import { logger } from "./logger";

/**
 * Creates a single AgentRuntime from AgentFactoryOptions.
 *
 * @param options - Factory options (character required, adapter optional)
 * @returns Initialized AgentRuntime
 * @throws If character is invalid or initialization fails
 *
 * @example
 * ```ts
 * const runtime = await createAgent({
 *   character: myCharacter,
 *   adapter: postgresAdapter,
 *   modelProvider: "anthropic",
 *   logLevel: "debug",
 * });
 * ```
 */
export async function createAgent(
	options: AgentFactoryOptions,
): Promise<IAgentRuntime> {
	const {
		character,
		adapter,
		plugins,
		modelProvider,
		modelType,
		logLevel,
		settings,
	} = options;

	// Create settings map from character + override settings
	const runtimeSettings: Record<string, string> = {
		...((character.settings as Record<string, string>) || {}),
		...(settings as Record<string, string>),
	};

	// Set model provider if provided
	if (modelProvider) {
		runtimeSettings.MODEL_PROVIDER = modelProvider;
	}

	// Set model type if provided
	if (modelType) {
		runtimeSettings.MODEL_TYPE = modelType;
	}

	const runtime = new AgentRuntime({
		adapter,
		character,
		plugins: plugins || (character.plugins as any[]) || [],
		settings: runtimeSettings,
		logLevel,
	});

	await runtime.initialize();
	return runtime;
}

/**
 * Creates multiple AgentRuntimes from character files or array.
 *
 * @param options - Factory options with characterPaths or characters array
 * @returns Array of initialized runtimes
 * @throws If any character is invalid or initialization fails
 *
 * @example
 * ```ts
 * const runtimes = await createAgents({
 *   characterPaths: [
 *     "./characters/alice.json",
 *     "./characters/bob.json",
 *   ],
 *   adapter: postgresAdapter,
 * });
 * ```
 */
export async function createAgents(options: {
	characterPaths?: string[];
	characters?: AgentFactoryOptions[];
	adapter?: IDatabaseAdapter;
	plugins?: any[];
	modelProvider?: string;
	logLevel?: "debug" | "info" | "warn" | "error";
}): Promise<IAgentRuntime[]> {
	const {
		characterPaths,
		characters,
		adapter,
		plugins,
		modelProvider,
		logLevel,
	} = options;

	const factoryOptions: AgentFactoryOptions[] = [];

	if (characterPaths && characterPaths.length > 0) {
		const { loadCharacters } = await import("./runtime-composition");
		const loadedCharacters = await loadCharacters(characterPaths);
		for (const character of loadedCharacters) {
			factoryOptions.push({
				character,
				adapter,
				plugins,
				modelProvider,
				logLevel,
			});
		}
	} else if (characters && characters.length > 0) {
		factoryOptions.push(...characters);
	} else {
		throw new Error(
			"Either characterPaths or characters array must be provided",
		);
	}

	const runtimes: IAgentRuntime[] = [];
	for (const opts of factoryOptions) {
		try {
			const runtime = await createAgent({
				...opts,
				adapter: opts.adapter || adapter,
				plugins: opts.plugins || plugins,
				modelProvider: opts.modelProvider || modelProvider,
				logLevel: opts.logLevel || logLevel,
			});
			runtimes.push(runtime);
		} catch (error) {
			logger.error(
				`Failed to create runtime for character ${opts.character.name}:`,
				error instanceof Error ? error.message : String(error),
			);
			throw error;
		}
	}

	return runtimes;
}

/**
 * Stops all runtimes in a list.
 *
 * @param runtimes - Runtimes to stop
 * @example
 * ```ts
 * await stopAgents(runtimes);
 * ```
 */
export async function stopAgents(runtimes: IAgentRuntime[]): Promise<void> {
	for (const runtime of runtimes) {
		try {
			await runtime.stop?.();
		} catch (error) {
			logger.error(
				`Error stopping runtime ${runtime.character?.name}:`,
				error instanceof Error ? error.message : String(error),
			);
		}
	}
}
