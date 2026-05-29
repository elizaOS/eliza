/**
 * Build a real AgentRuntime for scenario execution. Uses PGLite for storage
 * (no SQL mocks) and registers either the first available live LLM provider
 * via the core testing live-provider selector or the deterministic test LLM
 * proxy when mock mode is explicitly enabled.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AgentRuntime, Plugin } from "@elizaos/core";
import {
  AgentRuntime as AgentRuntimeCtor,
  createBasicCapabilitiesPlugin,
  createCharacter,
  logger,
} from "@elizaos/core";
import {
  type LiveProviderConfig,
  type LiveProviderName,
  selectLiveProvider,
} from "@elizaos/core/testing";

// Test helpers loaded lazily so the build rootDir stays within src/.
async function loadTestMocks() {
  // Keep these as file URL strings so runtime resolution is anchored to this
  // module instead of the process cwd or test runner transform root.
  const mockRuntimeSpecifier = new URL(
    "../../test/mocks/helpers/mock-runtime.ts",
    import.meta.url,
  ).href;
  const lifeopsSimulatorSpecifier = new URL(
    "../../test/mocks/helpers/lifeops-simulator.ts",
    import.meta.url,
  ).href;
  const benchmarkFixturesSpecifier = new URL(
    "../../test/mocks/helpers/seed-benchmark-fixtures.ts",
    import.meta.url,
  ).href;
  const grantsSpecifier = new URL(
    "../../test/mocks/helpers/seed-grants.ts",
    import.meta.url,
  ).href;
  const llmProxySpecifier = new URL(
    "../../test/mocks/helpers/llm-proxy-plugin.ts",
    import.meta.url,
  ).href;

  const [mockRuntime, lifeopsSimulator, benchmarkFixtures, grants, llmProxy] =
    await Promise.all([
      import(mockRuntimeSpecifier),
      import(lifeopsSimulatorSpecifier),
      import(benchmarkFixturesSpecifier),
      import(grantsSpecifier),
      import(llmProxySpecifier),
    ]);
  return {
    prepareMockedTestEnvironment: mockRuntime.prepareMockedTestEnvironment,
    seedLifeOpsSimulatorRuntime: lifeopsSimulator.seedLifeOpsSimulatorRuntime,
    seedBenchmarkLifeOpsFixtures:
      benchmarkFixtures.seedBenchmarkLifeOpsFixtures,
    seedGoogleConnectorGrant: grants.seedGoogleConnectorGrant,
    seedXConnectorGrant: grants.seedXConnectorGrant,
    createDeterministicLlmProxyPlugin:
      llmProxy.createDeterministicLlmProxyPlugin,
  };
}

export async function loadScenarioTestMocksForTests() {
  return loadTestMocks();
}

const DETERMINISTIC_LLM_PROXY_PROVIDER_NAME =
  "deterministic-llm-proxy" as const;

export interface RuntimeFactoryResult {
  runtime: AgentRuntime;
  pgliteDir: string;
  providerName: LiveProviderName | typeof DETERMINISTIC_LLM_PROXY_PROVIDER_NAME;
  providerConfig:
    | LiveProviderConfig
    | {
        name: typeof DETERMINISTIC_LLM_PROXY_PROVIDER_NAME;
        env: Record<string, string>;
        pluginPackage: null;
      };
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

function isPlugin(value: unknown): value is Plugin {
  return (
    value !== null &&
    typeof value === "object" &&
    typeof (value as { name?: unknown }).name === "string" &&
    typeof (value as { description?: unknown }).description === "string"
  );
}

function extractPlugin(mod: unknown, names: readonly string[]): Plugin | null {
  if (mod === null || typeof mod !== "object") return null;
  const record = mod as Record<string, unknown>;
  for (const key of names) {
    const candidate = record[key];
    if (isPlugin(candidate)) return candidate;
  }
  return null;
}

async function runCleanupStep(
  label: string,
  operation: () => Promise<void>,
  timeoutMs = 5_000,
): Promise<void> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<"timeout">((resolve) => {
    timeout = setTimeout(() => resolve("timeout"), timeoutMs);
  });
  const result = await Promise.race([
    operation().then(() => "done" as const),
    timeoutPromise,
  ]);
  if (timeout) {
    clearTimeout(timeout);
  }
  if (result === "timeout") {
    logger.warn(
      `[scenario-runner] cleanup step timed out after ${timeoutMs}ms: ${label}`,
    );
  }
}

function cancelScenarioOnlyLazyServiceStarts(runtime: AgentRuntime): void {
  const runtimeInternals = runtime as unknown as {
    startingServices?: Map<string, Promise<unknown>>;
    servicePromises?: Map<string, Promise<unknown>>;
    servicePromiseHandlers?: Map<
      string,
      { reject: (error: Error) => void }
    >;
  };
  const serviceType = "AGENT_SKILLS_SERVICE";
  if (!runtimeInternals.startingServices?.has(serviceType)) {
    return;
  }
  const error = new Error(
    "[scenario-runner] cancelled unfinished agent-skills lazy service start during cleanup",
  );
  runtimeInternals.servicePromiseHandlers?.get(serviceType)?.reject(error);
  runtimeInternals.servicePromiseHandlers?.delete(serviceType);
  runtimeInternals.servicePromises?.delete(serviceType);
  runtimeInternals.startingServices.delete(serviceType);
}

export interface CreateScenarioRuntimeOptions {
  characterName?: string;
  preferredProvider?: LiveProviderName;
  extraPlugins?: Plugin[];
  useDeterministicLlmProxy?: boolean;
}

const SAVE_TRAJECTORY_ENV_FLAGS = [
  "ELIZA_SAVE_TRAJECTORIES",
  "SCENARIO_SAVE_TRAJECTORIES",
] as const;

const SCENARIO_PGLITE_DIR_ENV_VARS = [
  "ELIZA_SCENARIO_PGLITE_DIR",
  "SCENARIO_PGLITE_DIR",
] as const;

function envFlag(value: string | undefined): boolean {
  const normalized = value?.trim().toLowerCase();
  return (
    normalized === "1" ||
    normalized === "true" ||
    normalized === "yes" ||
    normalized === "on"
  );
}

export function shouldUseDeterministicLlmProxy(
  options: Pick<CreateScenarioRuntimeOptions, "useDeterministicLlmProxy"> = {},
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return (
    options.useDeterministicLlmProxy === true ||
    envFlag(env.SCENARIO_USE_LLM_PROXY) ||
    envFlag(env.ELIZA_SCENARIO_USE_LLM_PROXY)
  );
}

export function shouldUseStrictDeterministicLlmProxy(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return (
    envFlag(env.SCENARIO_LLM_PROXY_STRICT) ||
    envFlag(env.ELIZA_SCENARIO_LLM_PROXY_STRICT)
  );
}

function deterministicLlmProxyProviderConfig(): RuntimeFactoryResult["providerConfig"] {
  return {
    name: DETERMINISTIC_LLM_PROXY_PROVIDER_NAME,
    env: {},
    pluginPackage: null,
  };
}

export function resolveScenarioProviderConfig(
  options: Pick<
    CreateScenarioRuntimeOptions,
    "preferredProvider" | "useDeterministicLlmProxy"
  > = {},
  env: NodeJS.ProcessEnv = process.env,
): RuntimeFactoryResult["providerConfig"] | null {
  if (shouldUseDeterministicLlmProxy(options, env)) {
    return deterministicLlmProxyProviderConfig();
  }
  return selectLiveProvider(options.preferredProvider);
}

export function shouldPreserveScenarioTrajectoryDb(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return SAVE_TRAJECTORY_ENV_FLAGS.some((name) => envFlag(env[name]));
}

export function scenarioPgliteDirOverride(
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  for (const name of SCENARIO_PGLITE_DIR_ENV_VARS) {
    const value = env[name]?.trim();
    if (value) return path.resolve(value);
  }
  return null;
}

export async function createScenarioRuntime(
  options?: CreateScenarioRuntimeOptions,
): Promise<RuntimeFactoryResult> {
  const providerConfig = resolveScenarioProviderConfig(options);
  if (!providerConfig) {
    throw new Error(
      "[scenario-runner] no LLM provider configured. Set GROQ_API_KEY / OPENAI_API_KEY / ANTHROPIC_API_KEY / GOOGLE_GENERATIVE_AI_API_KEY / OPENROUTER_API_KEY, or enable deterministic test mode with SCENARIO_USE_LLM_PROXY=1.",
    );
  }
  const {
    prepareMockedTestEnvironment,
    seedLifeOpsSimulatorRuntime,
    seedBenchmarkLifeOpsFixtures,
    seedGoogleConnectorGrant,
    seedXConnectorGrant,
    createDeterministicLlmProxyPlugin,
  } = await loadTestMocks();
  const mockedEnvironment = await prepareMockedTestEnvironment({
    seedLifeOpsSimulator: true,
  });
  for (const [key, value] of Object.entries(providerConfig.env)) {
    process.env[key] = value;
  }

  const explicitPgliteDir = scenarioPgliteDirOverride();
  const pgliteDir =
    explicitPgliteDir ??
    fs.mkdtempSync(path.join(os.tmpdir(), "scenario-runner-pglite-"));
  const removePgliteDirOnCleanup =
    !explicitPgliteDir && !shouldPreserveScenarioTrajectoryDb();
  if (explicitPgliteDir) {
    fs.mkdirSync(explicitPgliteDir, { recursive: true });
  }
  const prevPgliteDir = process.env.PGLITE_DATA_DIR;
  const prevWebsiteBlockerHostsFilePath =
    process.env.WEBSITE_BLOCKER_HOSTS_FILE_PATH;
  const prevSelfControlHostsFilePath = process.env.SELFCONTROL_HOSTS_FILE_PATH;
  const prevElizaDisableActivityTracker =
    process.env.ELIZA_DISABLE_ACTIVITY_TRACKER;
  const prevElizaDisableProactiveAgent =
    process.env.ELIZA_DISABLE_PROACTIVE_AGENT;
  const prevElizaDisableLifeOpsScheduler =
    process.env.ELIZA_DISABLE_LIFEOPS_SCHEDULER;
  const prevSkillsSyncCatalogOnStart =
    process.env.SKILLS_SYNC_CATALOG_ON_START;
  let scenarioHostsRoot: string | null = null;
  process.env.PGLITE_DATA_DIR = pgliteDir;
  process.env.ELIZA_DISABLE_ACTIVITY_TRACKER = "1";
  process.env.ELIZA_DISABLE_PROACTIVE_AGENT = "1";
  process.env.ELIZA_DISABLE_LIFEOPS_SCHEDULER = "1";
  process.env.SKILLS_SYNC_CATALOG_ON_START =
    prevSkillsSyncCatalogOnStart ?? "false";
  if (!process.env.LOCAL_EMBEDDING_DIMENSIONS?.trim()) {
    process.env.LOCAL_EMBEDDING_DIMENSIONS = "384";
  }
  if (!process.env.EMBEDDING_DIMENSION?.trim()) {
    process.env.EMBEDDING_DIMENSION = "384";
  }
  if (
    !prevWebsiteBlockerHostsFilePath?.trim() &&
    !prevSelfControlHostsFilePath?.trim()
  ) {
    scenarioHostsRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), "scenario-runner-hosts-"),
    );
    const scenarioHostsFilePath = path.join(scenarioHostsRoot, "hosts");
    fs.writeFileSync(
      scenarioHostsFilePath,
      ["127.0.0.1 localhost", "::1 localhost", ""].join("\n"),
      "utf8",
    );
    process.env.WEBSITE_BLOCKER_HOSTS_FILE_PATH = scenarioHostsFilePath;
    process.env.SELFCONTROL_HOSTS_FILE_PATH = scenarioHostsFilePath;
  }

  const character = createCharacter({
    name: options?.characterName ?? "ScenarioAgent",
  });
  const runtime = new AgentRuntimeCtor({
    character,
    plugins: [],
    logLevel: "warn",
    enableAutonomy: false,
  });

  const { default: pluginSql } = (await import("@elizaos/plugin-sql")) as {
    default: Plugin;
  };
  await runtime.registerPlugin(pluginSql);

  // Basic capabilities: REPLY, CHOICE, IGNORE, NONE actions, core providers
  // (CHARACTER, ACTIONS, MESSAGES, ENTITIES, ...), and baseline services
  // (TaskService, EmbeddingGenerationService). advancedCapabilities also
  // registers contact/message actions (ADD_CONTACT, MESSAGE, ...).
  // Without this plugin the runtime has no conversational reply action and
  // nearly every scenario fails with "expected 1 call(s) to REPLY, saw 0".
  await runtime.registerPlugin(
    createBasicCapabilitiesPlugin({ advancedCapabilities: true }),
  );

  // Skip @elizaos/plugin-local-inference by default and register a
  // deterministic zero-vector TEXT_EMBEDDING stub instead. The bundled
  // `eliza-1-0_8b-32k.gguf` is fetched from a gated HuggingFace repo on
  // first generation; without HF credentials each turn produces a fresh
  // 401-spam burst (LFS URL + Standard URL × ±GGUF suffix × every retry). The
  // scenario runner doesn't score on semantic retrieval, so a zero vector is
  // the right stub. Match the bench server's dimension (1024 — see
  // `packages/app-core/src/benchmark/server.ts`) so downstream code that
  // assumes that shape (vector columns sized at boot) still works.
  // Opt back into the real plugin with `ELIZA_BENCH_SKIP_EMBEDDING=0`.
  const skipEmbeddingPlugin =
    (process.env.ELIZA_BENCH_SKIP_EMBEDDING ?? "1") !== "0";
  if (skipEmbeddingPlugin) {
    const EMBEDDING_DIMENSIONS = 1024;
    const stubEmbeddingPlugin: Plugin = {
      name: "scenario-runner-stub-embedding",
      description:
        "Scenario-runner zero-vector TEXT_EMBEDDING handler. Replaces " +
        "@elizaos/plugin-local-inference so we never download the gated " +
        "HuggingFace GGUF on every turn during scenario runs.",
      // Higher than local-embedding's priority: 10 so we win unconditionally.
      priority: 100,
      models: {
        TEXT_EMBEDDING: async () =>
          new Array<number>(EMBEDDING_DIMENSIONS).fill(0),
      },
    };
    await runtime.registerPlugin(stubEmbeddingPlugin);
    logger.info(
      `[scenario-runner] Registered zero-vector TEXT_EMBEDDING stub (dim=${EMBEDDING_DIMENSIONS}); ` +
        "set ELIZA_BENCH_SKIP_EMBEDDING=0 to use @elizaos/plugin-local-inference instead.",
    );
  } else {
    const localEmbedding = (await import(
      "@elizaos/plugin-local-inference"
    )) as {
      default: Plugin;
    };
    await runtime.registerPlugin(localEmbedding.default);
  }

  applyRuntimeSettings(runtime, providerConfig.env);
  if (providerConfig.name === DETERMINISTIC_LLM_PROXY_PROVIDER_NAME) {
    const deterministicLlmProxyPlugin = createDeterministicLlmProxyPlugin({
      strict: shouldUseStrictDeterministicLlmProxy(),
    });
    await runtime.registerPlugin(deterministicLlmProxyPlugin);
    const runtimeWithScenarioFixtures = runtime as AgentRuntime & {
      scenarioLlmFixtures?: unknown;
      assertScenarioLlmFixturesConsumed?: () => void;
      getScenarioLlmFixtureDiagnostics?: () => unknown;
    };
    runtimeWithScenarioFixtures.scenarioLlmFixtures =
      deterministicLlmProxyPlugin.llmFixtures;
    runtimeWithScenarioFixtures.assertScenarioLlmFixturesConsumed =
      deterministicLlmProxyPlugin.assertFixturesConsumed;
    runtimeWithScenarioFixtures.getScenarioLlmFixtureDiagnostics =
      deterministicLlmProxyPlugin.getFixtureDiagnostics;
    logger.info(
      `[scenario-runner] Registered deterministic LLM proxy (${shouldUseStrictDeterministicLlmProxy() ? "strict" : "heuristic"} mode); no live provider key required.`,
    );
  } else {
    const providerModule = (await import(
      providerConfig.pluginPackage
    )) as Record<string, unknown>;
    const providerPlugin = extractPlugin(providerModule, [
      "default",
      "elizaPlugin",
    ]);
    if (!providerPlugin) {
      throw new Error(
        `[scenario-runner] provider package ${providerConfig.pluginPackage} did not export a Plugin`,
      );
    }
    await runtime.registerPlugin(providerPlugin);
  }

  const agentSkillsModule = (await import(
    "@elizaos/plugin-agent-skills"
  )) as Record<string, unknown>;
  const agentSkillsPlugin = extractPlugin(agentSkillsModule, [
    "default",
    "agentSkillsPlugin",
  ]);
  if (!agentSkillsPlugin) {
    throw new Error(
      "[scenario-runner] @elizaos/plugin-agent-skills did not export a Plugin",
    );
  }
  await runtime.registerPlugin(agentSkillsPlugin);

  const lifeOpsModule = (await import(
    "@elizaos/plugin-lifeops/plugin"
  )) as Record<string, unknown>;
  const lifeOpsPlugin = extractPlugin(lifeOpsModule, [
    "default",
    "appLifeOpsPlugin",
  ]);
  if (!lifeOpsPlugin) {
    throw new Error(
      "[scenario-runner] @elizaos/plugin-lifeops did not export a Plugin",
    );
  }
  await runtime.registerPlugin(lifeOpsPlugin);

  for (const extra of options?.extraPlugins ?? []) {
    await runtime.registerPlugin(extra);
  }

  await runtime.initialize();
  const cleanupRuntimeFixtures =
    await mockedEnvironment.applyRuntimeFixtures?.(runtime);
  await seedGoogleConnectorGrant(runtime);
  await seedXConnectorGrant(runtime);
  await seedBenchmarkLifeOpsFixtures(runtime);
  await seedLifeOpsSimulatorRuntime(runtime);

  // Remove upstream actions that reliably steal action-selection from the
  // domain actions scenarios actually care about. UPDATE_ENTITY's description
  // ("Add or edit contact details for a person you are talking to or
  // observing. Use this to modify entity profiles, metadata, or attributes.")
  // is broad enough that small-model classifiers pick it for any request that
  // mentions a person or fact ("remember my favorite color is blue",
  // "remind me to email Alex"), which crowds out CREATE_TASK, MESSAGE,
  // CONTACT, OWNER_REMINDERS, etc. For the scenario runner — which is testing
  // user-facing action routing, not profile editing — dropping it unblocks
  // the realistic cases. Real runtimes keep UPDATE_ENTITY enabled.
  const bannedActions = new Set(["UPDATE_ENTITY"]);
  const runtimeActions = runtime.actions;
  for (let i = runtimeActions.length - 1; i >= 0; i -= 1) {
    if (bannedActions.has(runtimeActions[i].name)) {
      runtimeActions.splice(i, 1);
    }
  }

  const cleanup = async (): Promise<void> => {
    await runCleanupStep("runtime fixtures", async () => {
      try {
        await cleanupRuntimeFixtures?.();
      } catch (err) {
        logger.debug(`[scenario-runner] runtime fixture cleanup error: ${err}`);
      }
    });
    cancelScenarioOnlyLazyServiceStarts(runtime);
    await runCleanupStep("runtime.stop()", async () => {
      try {
        await runtime.stop();
      } catch (err) {
        logger.debug(`[scenario-runner] runtime.stop() error: ${err}`);
      }
    });
    await runCleanupStep("runtime.close()", async () => {
      try {
        await runtime.close();
      } catch (err) {
        logger.debug(`[scenario-runner] runtime.close() error: ${err}`);
      }
    });
    if (prevPgliteDir !== undefined) {
      process.env.PGLITE_DATA_DIR = prevPgliteDir;
    } else {
      delete process.env.PGLITE_DATA_DIR;
    }
    if (prevWebsiteBlockerHostsFilePath !== undefined) {
      process.env.WEBSITE_BLOCKER_HOSTS_FILE_PATH =
        prevWebsiteBlockerHostsFilePath;
    } else {
      delete process.env.WEBSITE_BLOCKER_HOSTS_FILE_PATH;
    }
    if (prevSelfControlHostsFilePath !== undefined) {
      process.env.SELFCONTROL_HOSTS_FILE_PATH = prevSelfControlHostsFilePath;
    } else {
      delete process.env.SELFCONTROL_HOSTS_FILE_PATH;
    }
    if (prevElizaDisableActivityTracker !== undefined) {
      process.env.ELIZA_DISABLE_ACTIVITY_TRACKER =
        prevElizaDisableActivityTracker;
    } else {
      delete process.env.ELIZA_DISABLE_ACTIVITY_TRACKER;
    }
    if (prevElizaDisableProactiveAgent !== undefined) {
      process.env.ELIZA_DISABLE_PROACTIVE_AGENT =
        prevElizaDisableProactiveAgent;
    } else {
      delete process.env.ELIZA_DISABLE_PROACTIVE_AGENT;
    }
    if (prevElizaDisableLifeOpsScheduler !== undefined) {
      process.env.ELIZA_DISABLE_LIFEOPS_SCHEDULER =
        prevElizaDisableLifeOpsScheduler;
    } else {
      delete process.env.ELIZA_DISABLE_LIFEOPS_SCHEDULER;
    }
    if (prevSkillsSyncCatalogOnStart !== undefined) {
      process.env.SKILLS_SYNC_CATALOG_ON_START =
        prevSkillsSyncCatalogOnStart;
    } else {
      delete process.env.SKILLS_SYNC_CATALOG_ON_START;
    }
    await runCleanupStep("mocked environment", async () => {
      try {
        await mockedEnvironment.cleanup();
      } catch (err) {
        logger.debug(
          `[scenario-runner] mocked environment cleanup error: ${err}`,
        );
      }
    });
    if (removePgliteDirOnCleanup) {
      try {
        fs.rmSync(pgliteDir, { recursive: true, force: true });
      } catch (err) {
        logger.debug(`[scenario-runner] PGLite cleanup error: ${err}`);
      }
    } else {
      logger.info(
        `[scenario-runner] preserved scenario PGLite trajectory DB at ${pgliteDir}`,
      );
    }
    if (scenarioHostsRoot) {
      try {
        fs.rmSync(scenarioHostsRoot, { recursive: true, force: true });
      } catch (err) {
        logger.debug(`[scenario-runner] hosts cleanup error: ${err}`);
      }
    }
  };

  return {
    runtime,
    pgliteDir,
    providerName: providerConfig.name,
    providerConfig,
    cleanup,
  };
}
