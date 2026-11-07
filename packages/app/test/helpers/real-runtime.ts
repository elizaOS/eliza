/** App host composition over the shared SQL runtime and draining lifecycle. */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { flushTrajectoryWrites } from "@elizaos/agent/runtime/trajectory-storage";
import {
  type AgentRuntime,
  ElizaError,
  OPTIMIZED_PROMPT_SERVICE,
  type Plugin,
} from "@elizaos/core";
import {
  DEFAULT_CEREBRAS_TEXT_MODEL,
  installHttpPluginLifecycle,
} from "@elizaos/host/protocol";
import { createAssistantPlugin } from "@elizaos/plugin-assistant";
import { createTestRuntime } from "@elizaos/testing/runtime";
import {
  type LiveProviderConfig,
  type LiveProviderName,
  selectLiveProvider,
} from "./live-provider.ts";
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
  deliveries: Array<{ target: unknown; content: unknown }>;
}
function createCerebrasProviderConfigFromEnv(): LiveProviderConfig | null {
  const apiKey =
    process.env.CEREBRAS_API_KEY?.trim() ||
    process.env.ELIZA_E2E_CEREBRAS_API_KEY?.trim();
  if (!apiKey) return null;
  // CEREBRAS_API_KEY alone is NOT enough to opt the agent runtime into
  // Cerebras. Lifeops uses Cerebras for *evaluation/training* by default
  // (see `lifeops-eval-model.ts`); the agent under test stays on Anthropic
  // Opus 4.7 unless the operator explicitly opts in with one of:
  //   - ELIZA_PROVIDER=cerebras
  //   - OPENAI_BASE_URL set to a *.cerebras.ai endpoint
  // Otherwise the eval key would leak into the agent runtime and the
  // benchmark would grade Cerebras-vs-Cerebras instead of Anthropic-vs-Cerebras.
  const explicitProvider = process.env.ELIZA_PROVIDER?.trim().toLowerCase();
  const explicitBaseUrl = process.env.OPENAI_BASE_URL?.trim();
  const baseUrlIsCerebras =
    !!explicitBaseUrl && /cerebras\.ai(?:\/|$)/i.test(explicitBaseUrl);
  if (explicitProvider !== "cerebras" && !baseUrlIsCerebras) {
    return null;
  }
  const baseUrl = explicitBaseUrl || "https://api.cerebras.ai/v1";
  const smallModel =
    process.env.ELIZA_LIVE_TEST_SMALL_MODEL?.trim() ||
    process.env.OPENAI_SMALL_MODEL?.trim() ||
    DEFAULT_CEREBRAS_TEXT_MODEL;
  const largeModel =
    process.env.ELIZA_LIVE_TEST_LARGE_MODEL?.trim() ||
    process.env.OPENAI_LARGE_MODEL?.trim() ||
    DEFAULT_CEREBRAS_TEXT_MODEL;
  const mediumModel =
    process.env.OPENAI_MEDIUM_MODEL?.trim() ||
    process.env.MEDIUM_MODEL?.trim() ||
    largeModel;
  const actionPlannerModel =
    process.env.OPENAI_ACTION_PLANNER_MODEL?.trim() ||
    process.env.OPENAI_PLANNER_MODEL?.trim() ||
    process.env.ACTION_PLANNER_MODEL?.trim() ||
    process.env.PLANNER_MODEL?.trim() ||
    largeModel;
  const env = {
    CEREBRAS_API_KEY: apiKey,
    OPENAI_API_KEY: apiKey,
    OPENAI_BASE_URL: baseUrl,
    ELIZA_PROVIDER: "cerebras",
    OPENAI_SMALL_MODEL: smallModel,
    OPENAI_MEDIUM_MODEL: mediumModel,
    OPENAI_LARGE_MODEL: largeModel,
    OPENAI_ACTION_PLANNER_MODEL: actionPlannerModel,
    OPENAI_PLANNER_MODEL: actionPlannerModel,
    SMALL_MODEL: smallModel,
    MEDIUM_MODEL: mediumModel,
    LARGE_MODEL: largeModel,
    ACTION_PLANNER_MODEL: actionPlannerModel,
    PLANNER_MODEL: actionPlannerModel,
  };
  return {
    name: "cerebras",
    apiKey,
    baseUrl,
    smallModel,
    largeModel,
    pluginPackage: "@elizaos/plugin-openai",
    env,
  };
}

let windowOwners = 0;
let savedWindow: PropertyDescriptor | undefined;
function ownNodeWindow(): () => void {
  if (windowOwners === 0) {
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, "window");
    if (!descriptor?.configurable) return () => {};
    savedWindow = descriptor;
    Reflect.deleteProperty(globalThis, "window");
  }
  windowOwners++;
  let closed = false;
  return () => {
    if (closed) return;
    closed = true;
    if (--windowOwners === 0 && savedWindow) {
      if (!Object.hasOwn(globalThis, "window"))
        Object.defineProperty(globalThis, "window", savedWindow);
      savedWindow = undefined;
    }
  };
}
async function loadPlugin(specifier: string): Promise<Plugin> {
  const exports = await import(/* @vite-ignore */ specifier);
  const plugin = exports.default ?? exports.elizaPlugin;
  if (!plugin || typeof plugin.name !== "string")
    throw new ElizaError(`No plugin exported by ${specifier}`, {
      code: "APP_TEST_PLUGIN_INVALID",
    });
  return plugin;
}
export async function createRealTestRuntime(
  options: RealTestRuntimeOptions = {},
): Promise<RealTestRuntimeResult> {
  const providerConfig = options.withLLM
    ? (selectLiveProvider(options.preferredProvider) ??
      (!options.preferredProvider
        ? createCerebrasProviderConfigFromEnv()
        : null))
    : null;
  if (options.withLLM && !providerConfig)
    throw new ElizaError("The requested live provider is not configured", {
      code: "APP_TEST_PROVIDER_UNAVAILABLE",
    });
  const plugins: Plugin[] = [createAssistantPlugin()];
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
  plugins.push(...(options.plugins ?? []));
  const configuredHosts =
    process.env.WEBSITE_BLOCKER_HOSTS_FILE_PATH?.trim() ||
    process.env.SELFCONTROL_HOSTS_FILE_PATH?.trim();
  const hostsRoot = configuredHosts
    ? undefined
    : fs.mkdtempSync(path.join(os.tmpdir(), "eliza-test-hosts-"));
  const hostsFile =
    configuredHosts ?? (hostsRoot ? path.join(hostsRoot, "hosts") : undefined);
  if (!hostsFile)
    throw new ElizaError("Missing app fixture hosts path", {
      code: "APP_TEST_HOSTS_PATH_MISSING",
    });
  let fixture: Awaited<ReturnType<typeof createTestRuntime>> | undefined;
  const restoreWindow = ownNodeWindow();
  let closing: Promise<void> | undefined;
  const cleanup = () =>
    (closing ??= (async () => {
      const failures: unknown[] = [];
      for (const dispose of [
        () => fixture?.cleanup(),
        restoreWindow,
        () => {
          if (hostsRoot) fs.rmSync(hostsRoot, { recursive: true, force: true });
        },
      ]) {
        try {
          await dispose();
        } catch (error) {
          failures.push(error);
        }
      }
      if (failures.length)
        throw new AggregateError(failures, "App fixture cleanup failed");
    })());
  try {
    if (hostsRoot) fs.writeFileSync(hostsFile, "127.0.0.1 localhost\n", "utf8");
    fixture = await createTestRuntime({
      characterName: options.characterName,
      pgliteDir: options.pgliteDir,
      removePgliteDirOnCleanup: options.removePgliteDirOnCleanup,
      embeddingDimensions: 384,
      plugins,
      settings: {
        ...providerConfig?.env,
        WEBSITE_BLOCKER_HOSTS_FILE_PATH: hostsFile,
        SELFCONTROL_HOSTS_FILE_PATH: hostsFile,
      },
      configureRuntime: (runtime) => {
        installHttpPluginLifecycle(runtime);
      },
      flushTrajectoryWrites,
    });
    const { runtime } = fixture;
    for (const plugin of options.plugins ?? [])
      for (const service of plugin.services ?? [])
        await runtime.getServiceLoadPromise(service.serviceType);
    runtime.getService(OPTIMIZED_PROMPT_SERVICE);
    await runtime.getServiceLoadPromise(OPTIMIZED_PROMPT_SERVICE);
    // This host's in-process delivery transport records complete fixture messages.
    const deliveries: Array<{ target: unknown; content: unknown }> = [];
    runtime.registerSendHandler(
      "client_chat",
      async (_runtime, target, content) => {
        deliveries.push({
          target: structuredClone(target),
          content: structuredClone(content),
        });
      },
    );
    return {
      runtime,
      pgliteDir: fixture.pgliteDir,
      providerName: providerConfig?.name ?? null,
      providerConfig,
      deliveries,
      cleanup,
    };
  } catch (error) {
    // error-policy:J6 Preserve startup failures together with complete rollback failures.
    try {
      await cleanup();
    } catch (cleanupError) {
      throw new AggregateError(
        [error, cleanupError],
        "App fixture initialization and rollback failed",
      );
    }
    throw error;
  }
}
