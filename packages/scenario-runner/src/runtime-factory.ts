/**
 * Build a real AgentRuntime for scenario execution. Uses PGLite for storage
 * (no SQL mocks) and registers either the first available live LLM provider
 * via the core testing live-provider selector or the deterministic test LLM
 * proxy when mock mode is explicitly enabled.
 */

import "./react-runtime-stubs";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AgentRuntime, Plugin } from "@elizaos/core";
import {
  AgentRuntime as AgentRuntimeCtor,
  createBasicCapabilitiesPlugin,
  createCharacter,
  logger,
  ModelType,
  trajectoriesPlugin,
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
const SCHEDULED_DISPATCH_RENDER_PROMPT_PREFIX =
  "You are the owner's personal assistant. A scheduled task just fired and you must now write the message to send to the owner.";
const SCHEDULED_DISPATCH_RENDER_INSTRUCTION_MARKER = "\nInstruction:\n";
const SCHEDULED_DISPATCH_RENDER_FIRED_AT_MARKER = "\n\nFired at:";

async function createScenarioKnowledgeGraphPlugin(): Promise<Plugin> {
  const agentPackageName: string = "@elizaos/agent";
  const agentModule = (await import(agentPackageName)) as Record<
    string,
    unknown
  >;
  const KnowledgeGraphService = agentModule.KnowledgeGraphService;
  const knowledgeGraphSchema = agentModule.knowledgeGraphSchema;
  if (
    typeof KnowledgeGraphService !== "function" ||
    knowledgeGraphSchema === null ||
    typeof knowledgeGraphSchema !== "object"
  ) {
    throw new Error(
      "[scenario-runner] @elizaos/agent did not expose KnowledgeGraphService and knowledgeGraphSchema",
    );
  }

  return {
    name: "scenario-runner-knowledge-graph",
    description:
      "Scenario-runner runtime knowledge graph service and schema bootstrap.",
    schema: knowledgeGraphSchema as Plugin["schema"],
    services: [
      KnowledgeGraphService as NonNullable<Plugin["services"]>[number],
    ],
  };
}

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
    servicePromiseHandlers?: Map<string, { reject: (error: Error) => void }>;
  };
  const serviceType = "AGENT_SKILLS_SERVICE";
  if (!runtimeInternals.startingServices?.has(serviceType)) {
    return;
  }
  const error = new Error(
    "[scenario-runner] cancelled pending agent-skills lazy service start during cleanup",
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

export function isScheduledDispatchRenderPrompt(prompt: string): boolean {
  return (
    prompt.startsWith(SCHEDULED_DISPATCH_RENDER_PROMPT_PREFIX) &&
    prompt.includes(SCHEDULED_DISPATCH_RENDER_INSTRUCTION_MARKER) &&
    prompt.includes(SCHEDULED_DISPATCH_RENDER_FIRED_AT_MARKER) &&
    prompt.trimEnd().endsWith("Message:")
  );
}

export function deterministicScheduledDispatchRenderText(
  prompt: string,
): string {
  const instructionStart = prompt.indexOf(
    SCHEDULED_DISPATCH_RENDER_INSTRUCTION_MARKER,
  );
  const firedAtStart = prompt.indexOf(
    SCHEDULED_DISPATCH_RENDER_FIRED_AT_MARKER,
  );
  const instruction =
    instructionStart >= 0 && firedAtStart > instructionStart
      ? prompt
          .slice(
            instructionStart +
              SCHEDULED_DISPATCH_RENDER_INSTRUCTION_MARKER.length,
            firedAtStart,
          )
          .trim()
      : "";
  const ownerMessage = instruction
    .replace(/^remind the owner to\s+/i, "")
    .replace(/^ask the owner to\s+/i, "")
    .replace(/^tell the owner to\s+/i, "")
    .replace(/^gentle check-in:\s*/i, "")
    .replace(/\s+/g, " ")
    .trim();
  return ownerMessage
    ? `Quick nudge: ${ownerMessage}`
    : "Quick nudge: checking in.";
}

type ScenarioDeterministicLlmCall = {
  modelType?: unknown;
  latestUserText?: unknown;
  params?: {
    prompt?: unknown;
    messages?: unknown;
  };
};

function isRecordLike(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object";
}

function chatContentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => {
      if (typeof part === "string") return part;
      if (isRecordLike(part) && typeof part.text === "string") return part.text;
      return "";
    })
    .filter(Boolean)
    .join("\n");
}

function deterministicCallTextCandidates(
  call: ScenarioDeterministicLlmCall,
): string[] {
  const candidates: string[] = [];
  if (typeof call.params?.prompt === "string") {
    candidates.push(call.params.prompt);
  }
  if (typeof call.latestUserText === "string") {
    candidates.push(call.latestUserText);
  }
  if (Array.isArray(call.params?.messages)) {
    for (const message of call.params.messages) {
      if (!isRecordLike(message)) continue;
      const text = chatContentText(message.content);
      if (text) candidates.push(text);
    }
  }
  return candidates;
}

export function resolveScenarioDeterministicLlmCall(
  call: ScenarioDeterministicLlmCall,
): string | null {
  if (call.modelType !== ModelType.TEXT_LARGE) {
    return null;
  }
  const prompt = deterministicCallTextCandidates(call).find(
    isScheduledDispatchRenderPrompt,
  );
  return prompt ? deterministicScheduledDispatchRenderText(prompt) : null;
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

/**
 * Live lane: `prepareMockedTestEnvironment` boots the wire-level LLM mocks and
 * exports their base-URL overrides (`ELIZA_MOCK_OPENAI_BASE` /
 * `ELIZA_MOCK_ANTHROPIC_BASE`), which plugin-openai / plugin-anthropic treat as
 * authoritative over `OPENAI_BASE_URL` / `ANTHROPIC_BASE_URL`. Left set, every
 * "live" model call is silently answered by the mock server — Stage 1 returns
 * empty completions and scenarios fall back to REPLY — so live-lane trajectory
 * evidence would actually be mock traffic. Live means live: drop the LLM mock
 * overrides when a live provider is selected; connector mocks (gmail, etc.)
 * stay. The deterministic proxy lane keeps everything as-is.
 */
export function clearLlmWireMockEnvForLiveProvider(
  providerName: RuntimeFactoryResult["providerConfig"]["name"],
  env: NodeJS.ProcessEnv = process.env,
): void {
  if (providerName === DETERMINISTIC_LLM_PROXY_PROVIDER_NAME) return;
  delete env.ELIZA_MOCK_OPENAI_BASE;
  delete env.ELIZA_MOCK_ANTHROPIC_BASE;
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
      "[scenario-runner] no LLM provider configured. Set GROQ_API_KEY / OPENAI_API_KEY / ANTHROPIC_API_KEY / GOOGLE_GENERATIVE_AI_API_KEY / OPENROUTER_API_KEY, set ELIZA_CHAT_VIA_CLI=claude|claude-sdk|codex|codex-sdk on a subscription-only host, or enable deterministic test mode with SCENARIO_USE_LLM_PROXY=1.",
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
  clearLlmWireMockEnvForLiveProvider(providerConfig.name);

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
  const prevSkillsSyncCatalogOnStart = process.env.SKILLS_SYNC_CATALOG_ON_START;
  const prevSkillsDir = process.env.SKILLS_DIR;
  const scenarioSkillsRoot = prevSkillsDir?.trim()
    ? null
    : fs.mkdtempSync(path.join(os.tmpdir(), "scenario-runner-skills-"));
  let scenarioHostsRoot: string | null = null;
  process.env.PGLITE_DATA_DIR = pgliteDir;
  process.env.ELIZA_DISABLE_ACTIVITY_TRACKER = "1";
  process.env.ELIZA_DISABLE_PROACTIVE_AGENT = "1";
  process.env.ELIZA_DISABLE_LIFEOPS_SCHEDULER = "1";
  if (scenarioSkillsRoot) {
    process.env.SKILLS_DIR = scenarioSkillsRoot;
  }
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
    // The agent-skills service reads SKILLS_DIR / SKILLS_SYNC_CATALOG_ON_START
    // via runtime.getSetting(), which does NOT consult process.env. Mirror the
    // scenario env into runtime settings so skills storage lands in the
    // throwaway temp dir and the boot-time catalog sync stays off — otherwise
    // every scenario hits the real registry at boot (network dependency) and
    // pollutes ./skills in the repo.
    settings: {
      SKILLS_SYNC_CATALOG_ON_START:
        process.env.SKILLS_SYNC_CATALOG_ON_START ?? "false",
      ...(process.env.SKILLS_DIR ? { SKILLS_DIR: process.env.SKILLS_DIR } : {}),
      // Scenarios assert the raw action-callback text; the character-voice
      // rewrite (services/message) would spend an unfixtured TEXT_SMALL call and
      // restyle that text, so keep it off in the deterministic harness.
      ACTION_CALLBACK_VOICE_REWRITE: "false",
    },
  });

  const { default: pluginSql } = (await import("@elizaos/plugin-sql")) as {
    default: Plugin;
  };
  await runtime.registerPlugin(pluginSql);
  await runtime.registerPlugin(trajectoriesPlugin);
  await runtime.registerPlugin(await createScenarioKnowledgeGraphPlugin());

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
  // deterministic zero-vector TEXT_EMBEDDING fallback instead. The bundled
  // `eliza-1-2b-32k.gguf` is fetched from a gated HuggingFace repo on
  // first generation; without HF credentials each turn produces a fresh
  // 401-spam burst (LFS URL + Standard URL × ±GGUF suffix × every retry). The
  // scenario runner doesn't score on semantic retrieval, so a zero vector is
  // the right deterministic fallback. Match the bench server's dimension (1024 — see
  // `packages/lifeops-bench/src/server.ts`) so downstream code that
  // assumes that shape (vector columns sized at boot) still works.
  // Opt back into the real plugin with `ELIZA_BENCH_SKIP_EMBEDDING=0`.
  const skipEmbeddingPlugin =
    (process.env.ELIZA_BENCH_SKIP_EMBEDDING ?? "1") !== "0";
  if (skipEmbeddingPlugin) {
    const EMBEDDING_DIMENSIONS = 1024;
    const embeddingFallbackPlugin: Plugin = {
      name: "scenario-runner-embedding-fallback",
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
    await runtime.registerPlugin(embeddingFallbackPlugin);
    logger.info(
      `[scenario-runner] Registered zero-vector TEXT_EMBEDDING fallback (dim=${EMBEDDING_DIMENSIONS}); ` +
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
      resolve: resolveScenarioDeterministicLlmCall,
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

    if (providerConfig.name === "cli") {
      // @elizaos/plugin-cli-inference intentionally registers large-tier
      // handlers only (TEXT_LARGE / TEXT_MEGA / RESPONSE_HANDLER, plus
      // ACTION_PLANNER in text-planner mode). Core's MODEL_FALLBACK_CHAINS has
      // no TEXT_SMALL -> TEXT_LARGE edge, so the small-tier triage calls made
      // throughout the scenario path (should-respond, extraction, evaluators)
      // would find no handler at all. Bridge TEXT_SMALL to TEXT_LARGE: the
      // same real subscription-served model answers, just slower. TEXT_NANO
      // and TEXT_MEDIUM already fall back to TEXT_SMALL via core's chains.
      const cliSmallTierBridge: Plugin = {
        name: "scenario-runner-cli-small-tier-bridge",
        description:
          "Routes TEXT_SMALL to TEXT_LARGE when the large-tier-only " +
          "CLI-subscription provider serves the scenario runtime.",
        models: {
          TEXT_SMALL: async (bridgeRuntime, params) =>
            bridgeRuntime.useModel(ModelType.TEXT_LARGE, params),
        },
      };
      await runtime.registerPlugin(cliSmallTierBridge);
      logger.info(
        "[scenario-runner] Registered TEXT_SMALL→TEXT_LARGE bridge (cli provider registers large-tier handlers only)",
      );
    }
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

  const schedulingModule = (await import(
    "@elizaos/plugin-scheduling"
  )) as Record<string, unknown>;
  const schedulingPlugin = extractPlugin(schedulingModule, [
    "default",
    "schedulingPlugin",
  ]);
  if (!schedulingPlugin) {
    throw new Error(
      "[scenario-runner] @elizaos/plugin-scheduling did not export a Plugin",
    );
  }
  await runtime.registerPlugin(schedulingPlugin);

  const lifeOpsModule = (await import(
    "@elizaos/plugin-personal-assistant/plugin"
  )) as Record<string, unknown>;
  const lifeOpsPlugin = extractPlugin(lifeOpsModule, [
    "default",
    "personalAssistantPlugin",
  ]);
  if (!lifeOpsPlugin) {
    throw new Error(
      "[scenario-runner] @elizaos/plugin-personal-assistant did not export a Plugin",
    );
  }
  await runtime.registerPlugin(lifeOpsPlugin);

  // The LifeOps dashboard HTTP routes (/api/lifeops/*) live on a separate
  // routes-only plugin, not the main lifeops plugin. Register it so api-turn
  // scenarios can exercise reminder/scheduling/inbox outcomes on the keyless
  // pr-deterministic lane (the executor's api server is built from
  // `runtime.routes`). It is routes-only — no services/actions/providers — so
  // it only adds endpoints; non-api scenarios are unaffected. Its sole
  // dependency (@elizaos/plugin-google) is already registered above.
  const routesModule = (await import(
    "@elizaos/plugin-personal-assistant"
  )) as Record<string, unknown>;
  const lifeOpsRoutesPlugin = extractPlugin(routesModule, [
    "personalAssistantRoutesPlugin",
  ]);
  if (!lifeOpsRoutesPlugin) {
    throw new Error(
      "[scenario-runner] @elizaos/plugin-personal-assistant did not export personalAssistantRoutesPlugin",
    );
  }
  await runtime.registerPlugin(lifeOpsRoutesPlugin);

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

  // Deterministic scenarios share one runtime; seed first-run as already
  // complete so the firstRun provider stays silent and action-routing is
  // order-independent. Without this, scenarios run in --lane discovery order
  // can see a "first-run pending" planner context the strict fixtures do not
  // cover (e.g. deterministic-xr-view-actions when it runs last).
  await runtime.setCache("eliza:lifeops:first-run:v1", {
    status: "complete",
    partialAnswers: {},
    completionCount: 1,
    completedAt: "1970-01-01T00:00:00.000Z",
  });

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
      process.env.SKILLS_SYNC_CATALOG_ON_START = prevSkillsSyncCatalogOnStart;
    } else {
      delete process.env.SKILLS_SYNC_CATALOG_ON_START;
    }
    if (prevSkillsDir !== undefined) {
      process.env.SKILLS_DIR = prevSkillsDir;
    } else {
      delete process.env.SKILLS_DIR;
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
    if (scenarioSkillsRoot) {
      try {
        fs.rmSync(scenarioSkillsRoot, { recursive: true, force: true });
      } catch (err) {
        logger.debug(`[scenario-runner] skills cleanup error: ${err}`);
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
