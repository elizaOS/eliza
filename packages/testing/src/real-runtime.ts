/**
 * Real runtime helper for integration tests.
 *
 * Extends pglite-runtime.ts with optional real LLM and connector plugins.
 * This is the primary helper for converting mocked tests to real integration tests.
 *
 * Usage:
 *   import { createRealTestRuntime } from "@elizaos/testing/runtime";
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

import type { AgentRuntime, Plugin } from "@elizaos/core";
import { ElizaError } from "@elizaos/core";
import {
  type LiveProviderConfig,
  type LiveProviderName,
  selectLiveProvider,
} from "./live-provider.ts";
import { createTestRuntime } from "./pglite-runtime.ts";

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
  /**
   * Reuse an existing PGLite data directory instead of the default per-call
   * in-memory database. Pass a real directory when the test proves restart
   * persistence (see ../testing/pglite-storage).
   */
  pgliteDir?: string;
  /** Remove PGLite dir on cleanup. Defaults to true when dir is auto-created. */
  removePgliteDirOnCleanup?: boolean;
  /**
   * Host-injected trajectory-write flush (the agent's `flushTrajectoryWrites`),
   * awaited during cleanup before the runtime stops. Injected for the same
   * ownership boundary; when omitted, cleanup relies on
   * draining the trajectories service's own write queues.
   */
  flushTrajectoryWrites?: (runtime: AgentRuntime) => Promise<void>;
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

async function loadPlugin(specifier: string): Promise<Plugin> {
  const module = (await import(specifier)) as {
    default?: Plugin;
    elizaPlugin?: Plugin;
  };
  const plugin = module.default ?? module.elizaPlugin;
  if (!plugin)
    throw new ElizaError(`No plugin exported by ${specifier}`, {
      code: "TEST_RUNTIME_PLUGIN_INVALID",
    });
  return plugin;
}

/** Composes live plugins over the same isolated storage and teardown as deterministic fixtures. */
export async function createRealTestRuntime(
  options: RealTestRuntimeOptions = {},
): Promise<RealTestRuntimeResult> {
  const plugins: Plugin[] = [];
  const providerConfig = options.withLLM
    ? selectLiveProvider(options.preferredProvider)
    : null;
  if (options.withLLM && !providerConfig) {
    throw new ElizaError(
      "A live model was requested but no provider is configured",
      { code: "TEST_RUNTIME_PROVIDER_UNAVAILABLE" },
    );
  }
  if (providerConfig)
    plugins.push(await loadPlugin(providerConfig.pluginPackage));
  for (const [enabled, token, specifier] of [
    [
      options.withDiscord,
      process.env.DISCORD_BOT_TOKEN,
      "@elizaos/plugin-discord",
    ],
    [
      options.withTelegram,
      process.env.TELEGRAM_BOT_TOKEN,
      "@elizaos/plugin-telegram",
    ],
  ] as const) {
    if (enabled && token?.trim()) plugins.push(await loadPlugin(specifier));
  }
  const result = await createTestRuntime({
    characterName: options.characterName,
    pgliteDir: options.pgliteDir,
    removePgliteDirOnCleanup: options.removePgliteDirOnCleanup,
    flushTrajectoryWrites: options.flushTrajectoryWrites,
    embeddingDimensions: 384,
    settings: providerConfig?.env,
    plugins: [...plugins, ...(options.plugins ?? [])],
  });
  return {
    ...result,
    providerName: providerConfig?.name ?? null,
    providerConfig,
  };
}
