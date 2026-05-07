/** Builds a real AgentRuntime backed by PGLite and optional live plugins. */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { Plugin } from "@elizaos/core";
import { AgentRuntime, createCharacter, logger } from "@elizaos/core";
import { configureLocalEmbeddingPlugin } from "../../../agent/src/runtime/eliza";
import type { LiveProviderConfig, LiveProviderName } from "./live-provider";

const helperDir = path.dirname(fileURLToPath(import.meta.url));

export interface RealTestRuntimeOptions {
  /** Name for the test agent character. Defaults to "TestAgent". */
  characterName?: string;
  /** Enable built-in advanced capabilities (for example MODIFY_CHARACTER). */
  advancedCapabilities?: boolean;
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isPlugin(value: unknown): value is Plugin {
  return isRecord(value) && typeof value.name === "string";
}

function getPendingTrajectoryWrites(service: unknown): Promise<void>[] {
  if (!isRecord(service)) {
    return [];
  }

  const { writeQueues } = service;
  if (!(writeQueues instanceof Map)) {
    return [];
  }

  return Array.from(writeQueues.values()).filter(
    (pending): pending is Promise<void> => pending instanceof Promise,
  );
}

function extractPlugin(
  moduleExports: unknown,
  exportNames: readonly string[],
): Plugin | null {
  if (isPlugin(moduleExports)) {
    return moduleExports;
  }

  if (!isRecord(moduleExports)) {
    return null;
  }

  for (const exportName of exportNames) {
    const candidate = moduleExports[exportName];
    if (isPlugin(candidate)) {
      return candidate;
    }

    if (isRecord(candidate) && isPlugin(candidate.default)) {
      return candidate.default;
    }
  }

  for (const candidate of Object.values(moduleExports)) {
    if (isPlugin(candidate)) {
      return candidate;
    }

    if (isRecord(candidate) && isPlugin(candidate.default)) {
      return candidate.default;
    }
  }

  return null;
}

async function importPluginSql(): Promise<Plugin> {
  try {
    const { default: pluginSql } = await import("@elizaos/plugin-sql");
    return pluginSql as Plugin;
  } catch (packageError) {
    const fallbackPath = path.resolve(
      helperDir,
      "../../../../plugins/plugin-sql/typescript/index.node.ts",
    );
    try {
      const { default: pluginSql } = await import(
        pathToFileURL(fallbackPath).href
      );
      return pluginSql as Plugin;
    } catch (fallbackError) {
      const packageMessage =
        packageError instanceof Error
          ? packageError.message
          : String(packageError);
      const fallbackMessage =
        fallbackError instanceof Error
          ? fallbackError.message
          : String(fallbackError);
      throw new Error(
        `Failed to import @elizaos/plugin-sql. Package import: ${packageMessage}; fallback ${fallbackPath}: ${fallbackMessage}`,
      );
    }
  }
}

function suppressWindowDuringNodeRuntime(): () => void {
  if (typeof process === "undefined") {
    return () => {};
  }

  const descriptor = Object.getOwnPropertyDescriptor(globalThis, "window");
  if (!descriptor?.configurable) {
    return () => {};
  }

  Reflect.deleteProperty(globalThis, "window");

  return () => {
    Object.defineProperty(globalThis, "window", descriptor);
  };
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

async function flushPendingTrajectoryWrites(
  runtime: AgentRuntime,
): Promise<void> {
  try {
    const { flushTrajectoryWrites } = await import(
      "../../../agent/src/runtime/trajectory-storage"
    );
    await flushTrajectoryWrites(runtime);
  } catch {
    // Some test runtimes do not register this helper.
  }

  for (let attempt = 0; attempt < 3; attempt += 1) {
    const pending = runtime
      .getServicesByType("trajectories")
      .flatMap((service) => getPendingTrajectoryWrites(service));
    if (pending.length === 0) {
      return;
    }
    await Promise.allSettled(pending);
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

function hasConfiguredHostsPath(value: string | undefined): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function createCerebrasProviderConfigFromEnv(): LiveProviderConfig | null {
  const apiKey =
    process.env.CEREBRAS_API_KEY?.trim() ||
    process.env.ELIZA_E2E_CEREBRAS_API_KEY?.trim();
  if (!apiKey) return null;

  const baseUrl =
    process.env.OPENAI_BASE_URL?.trim() || "https://api.cerebras.ai/v1";
  const explicitProvider = process.env.MILADY_PROVIDER?.trim().toLowerCase();
  if (
    explicitProvider !== "cerebras" &&
    !/cerebras\.ai(?:\/|$)/i.test(baseUrl)
  ) {
    return null;
  }

  const smallModel =
    process.env.ELIZA_LIVE_TEST_SMALL_MODEL?.trim() ||
    process.env.OPENAI_SMALL_MODEL?.trim() ||
    "gpt-oss-120b";
  const largeModel =
    process.env.ELIZA_LIVE_TEST_LARGE_MODEL?.trim() ||
    process.env.OPENAI_LARGE_MODEL?.trim() ||
    "gpt-oss-120b";
  const env = {
    CEREBRAS_API_KEY: apiKey,
    OPENAI_BASE_URL: baseUrl,
    MILADY_PROVIDER: "cerebras",
    OPENAI_SMALL_MODEL: smallModel,
    OPENAI_LARGE_MODEL: largeModel,
    SMALL_MODEL: smallModel,
    LARGE_MODEL: largeModel,
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

/** Creates a fully initialized runtime for integration tests. */
export async function createRealTestRuntime(
  options?: RealTestRuntimeOptions,
): Promise<RealTestRuntimeResult> {
  const pgliteDir =
    options?.pgliteDir ??
    fs.mkdtempSync(path.join(os.tmpdir(), "eliza-real-test-"));
  const removePgliteDirOnCleanup =
    options?.removePgliteDirOnCleanup ?? options?.pgliteDir === undefined;
  const restoreWindow = suppressWindowDuringNodeRuntime();
  let selfControlTempDir: string | null = null;

  const prevPgliteDir = process.env.PGLITE_DATA_DIR;
  const prevWebsiteBlockerHostsPath =
    process.env.WEBSITE_BLOCKER_HOSTS_FILE_PATH;
  const prevSelfControlHostsPath = process.env.SELFCONTROL_HOSTS_FILE_PATH;
  process.env.PGLITE_DATA_DIR = pgliteDir;

  if (
    !hasConfiguredHostsPath(process.env.WEBSITE_BLOCKER_HOSTS_FILE_PATH) &&
    !hasConfiguredHostsPath(process.env.SELFCONTROL_HOSTS_FILE_PATH)
  ) {
    selfControlTempDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "eliza-real-selfcontrol-"),
    );
    const testHostsFilePath = path.join(selfControlTempDir, "hosts");
    fs.mkdirSync(path.dirname(testHostsFilePath), { recursive: true });
    if (!fs.existsSync(testHostsFilePath)) {
      fs.writeFileSync(testHostsFilePath, "127.0.0.1 localhost\n", "utf8");
    }
    process.env.WEBSITE_BLOCKER_HOSTS_FILE_PATH = testHostsFilePath;
    process.env.SELFCONTROL_HOSTS_FILE_PATH = testHostsFilePath;
  }

  // Apply local embedding defaults so PGLite vector search works
  if (!process.env.LOCAL_EMBEDDING_DIMENSIONS?.trim()) {
    process.env.LOCAL_EMBEDDING_DIMENSIONS = "384";
  }
  if (!process.env.EMBEDDING_DIMENSION?.trim()) {
    process.env.EMBEDDING_DIMENSION = "384";
  }

  try {
    const character = createCharacter({
      name: options?.characterName ?? "TestAgent",
    });

    const runtime = new AgentRuntime({
      character,
      plugins: [],
      logLevel: "warn",
      advancedCapabilities: options?.advancedCapabilities ?? false,
      enableAutonomy: false,
    });

    // Always register plugin-sql for PGLite database.
    await runtime.registerPlugin(await importPluginSql());

    if (options?.withLLM) {
      try {
        const { default: localEmbeddingPlugin } = await import(
          "@elizaos/plugin-local-embedding"
        );
        configureLocalEmbeddingPlugin(localEmbeddingPlugin as Plugin);
        await runtime.registerPlugin(localEmbeddingPlugin as Plugin);
        logger.info(
          "[real-runtime] Registered local embedding plugin for TEXT_EMBEDDING",
        );
      } catch (err) {
        logger.warn(
          `[real-runtime] Failed to register local embedding plugin: ${err}`,
        );
      }
    }

    // Register LLM plugin if requested
    let providerName: LiveProviderName | null = null;
    let providerConfig: LiveProviderConfig | null = null;

    if (options?.withLLM) {
      const { selectLiveProvider } = await import("./live-provider");
      providerConfig = selectLiveProvider(options.preferredProvider);
      if (!providerConfig && options.preferredProvider) {
        providerConfig = selectLiveProvider();
      }
      providerConfig ??= createCerebrasProviderConfigFromEnv();
      if (providerConfig) {
        providerName = providerConfig.name;
        // Set provider env vars so the plugin picks them up
        for (const [key, value] of Object.entries(providerConfig.env)) {
          process.env[key] = value;
        }
        applyRuntimeSettings(runtime, providerConfig.env);
        try {
          const pluginModule = await import(providerConfig.pluginPackage);
          const plugin = extractPlugin(pluginModule, [
            "default",
            "elizaPlugin",
          ]);
          if (plugin) {
            await runtime.registerPlugin(plugin);
            logger.info(
              `[real-runtime] Registered LLM plugin: ${providerConfig.pluginPackage} (${providerName})`,
            );
          } else {
            logger.warn(
              `[real-runtime] Loaded ${providerConfig.pluginPackage} but could not find a plugin export`,
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

    // Register Discord plugin if requested and token available
    if (options?.withDiscord && process.env.DISCORD_BOT_TOKEN?.trim()) {
      try {
        const { default: discordPlugin } = await import(
          "@elizaos/plugin-discord"
        );
        await runtime.registerPlugin(discordPlugin as Plugin);
        logger.info("[real-runtime] Registered Discord plugin");
      } catch (err) {
        logger.warn(`[real-runtime] Failed to register Discord plugin: ${err}`);
      }
    }

    // Register Telegram plugin if requested and token available
    if (options?.withTelegram && process.env.TELEGRAM_BOT_TOKEN?.trim()) {
      try {
        const { default: telegramPlugin } = await import(
          "@elizaos/plugin-telegram"
        );
        await runtime.registerPlugin(telegramPlugin as Plugin);
        logger.info("[real-runtime] Registered Telegram plugin");
      } catch (err) {
        logger.warn(
          `[real-runtime] Failed to register Telegram plugin: ${err}`,
        );
      }
    }

    // Register any additional plugins
    for (const plugin of options?.plugins ?? []) {
      await runtime.registerPlugin(plugin);
    }

    await runtime.initialize();
    runtime.registerSendHandler(
      "client_chat",
      async (_rt, _target, _content) => {
        // Benchmarks and integration tests do not have a real in-app transport.
        // Register a no-op handler so inbox digests and proactive reminders can
        // exercise their normal delivery path without crashing the runtime.
      },
    );

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
      if (prevWebsiteBlockerHostsPath !== undefined) {
        process.env.WEBSITE_BLOCKER_HOSTS_FILE_PATH =
          prevWebsiteBlockerHostsPath;
      } else {
        delete process.env.WEBSITE_BLOCKER_HOSTS_FILE_PATH;
      }
      if (prevSelfControlHostsPath !== undefined) {
        process.env.SELFCONTROL_HOSTS_FILE_PATH = prevSelfControlHostsPath;
      } else {
        delete process.env.SELFCONTROL_HOSTS_FILE_PATH;
      }
      restoreWindow();
      if (removePgliteDirOnCleanup) {
        try {
          fs.rmSync(pgliteDir, { recursive: true, force: true });
        } catch {
          // ignore cleanup errors
        }
      }
      if (selfControlTempDir) {
        try {
          fs.rmSync(selfControlTempDir, { recursive: true, force: true });
        } catch {
          // ignore cleanup errors
        }
      }
    };

    return { runtime, pgliteDir, providerName, providerConfig, cleanup };
  } catch (error) {
    if (prevPgliteDir !== undefined) {
      process.env.PGLITE_DATA_DIR = prevPgliteDir;
    } else {
      delete process.env.PGLITE_DATA_DIR;
    }
    restoreWindow();
    if (removePgliteDirOnCleanup) {
      try {
        fs.rmSync(pgliteDir, { recursive: true, force: true });
      } catch {
        // ignore cleanup errors
      }
    }
    if (selfControlTempDir) {
      try {
        fs.rmSync(selfControlTempDir, { recursive: true, force: true });
      } catch {
        // ignore cleanup errors
      }
    }
    throw error;
  }
}
