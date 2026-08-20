/**
 * Build a real AgentRuntime for scenario execution. Uses PGLite for storage
 * (no SQL mocks) and registers either the first available live LLM provider
 * via the core testing live-provider selector or the deterministic fixture
 * provider when deterministic mode is explicitly enabled.
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
  createDeterministicModelPlugin,
  type LiveProviderConfig,
  type LiveProviderName,
  selectLiveProvider,
} from "@elizaos/core/testing";
import {
  DEFAULT_SCENARIO_EXECUTION_PROFILE,
  type ScenarioExecutionProfile,
} from "@elizaos/scenario-runner/schema";
import {
  assertProviderQualifiedPluginPackages,
  pluginPackageIsRegistered,
  registerScenarioRequiredPlugins,
} from "./required-plugins.ts";

// Test helpers loaded lazily so the build rootDir stays within src/.
async function loadTestMocks() {
  // Keep these as file URL strings so runtime resolution is anchored to this
  // module instead of the process cwd or test runner transform root.
  const mockRuntimeSpecifier = new URL(
    "../../../plugins/plugin-personal-assistant/test/support/helpers/mock-runtime.ts",
    import.meta.url,
  ).href;
  const lifeopsSimulatorSpecifier = new URL(
    "../../../plugins/plugin-personal-assistant/test/support/helpers/lifeops-simulator.ts",
    import.meta.url,
  ).href;
  const benchmarkFixturesSpecifier = new URL(
    "../../../plugins/plugin-personal-assistant/test/support/helpers/seed-benchmark-fixtures.ts",
    import.meta.url,
  ).href;
  const grantsSpecifier = new URL(
    "../../../plugins/plugin-personal-assistant/test/support/helpers/seed-grants.ts",
    import.meta.url,
  ).href;
  const [mockRuntime, lifeopsSimulator, benchmarkFixtures, grants] =
    await Promise.all([
      import(mockRuntimeSpecifier),
      import(lifeopsSimulatorSpecifier),
      import(benchmarkFixturesSpecifier),
      import(grantsSpecifier),
    ]);
  return {
    prepareMockedTestEnvironment: mockRuntime.prepareMockedTestEnvironment,
    seedLifeOpsSimulatorRuntime: lifeopsSimulator.seedLifeOpsSimulatorRuntime,
    seedBenchmarkLifeOpsFixtures:
      benchmarkFixtures.seedBenchmarkLifeOpsFixtures,
    seedGoogleConnectorGrant: grants.seedGoogleConnectorGrant,
    seedXConnectorGrant: grants.seedXConnectorGrant,
  };
}

export async function loadScenarioTestMocksForTests() {
  return loadTestMocks();
}

const DETERMINISTIC_MODEL_PROVIDER_NAME =
  "deterministic-model-provider" as const;
const SCHEDULED_DISPATCH_RENDER_PROMPT_PREFIX =
  "You are the owner's personal assistant. A scheduled task just fired and you must now write the message to send to the owner.";
const SCHEDULED_DISPATCH_RENDER_INSTRUCTION_MARKER = "\nInstruction:\n";
const SCHEDULED_DISPATCH_RENDER_MESSAGE_MARKER = "\n\nMessage:";
const SCHEDULED_DISPATCH_RENDER_FIRED_AT_MARKER = "\n\nFired at:";
const SCHEDULED_DISPATCH_TITLE_PROMPT_PREFIX =
  "You are the owner's personal assistant. Write a concise notification title for the scheduled message below.";
const SCHEDULED_DISPATCH_TITLE_BODY_MARKER = "\nMessage body:\n";

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
  executionProfile: ScenarioExecutionProfile;
  registeredPluginPackages: readonly string[];
  providerName: LiveProviderName | typeof DETERMINISTIC_MODEL_PROVIDER_NAME;
  providerConfig:
    | LiveProviderConfig
    | {
        name: typeof DETERMINISTIC_MODEL_PROVIDER_NAME;
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
  useDeterministicModel?: boolean;
  executionProfile?: ScenarioExecutionProfile;
  requiredPlugins?: readonly string[];
  requiredServices?: readonly string[];
  backgroundWorkers?: readonly string[];
}

/** Resolve opt-in worker flags without starting a scenario process. */
export function resolveBackgroundServiceFlags(
  options: Pick<
    CreateScenarioRuntimeOptions,
    "requiredServices" | "backgroundWorkers"
  > = {},
): Record<
  | "ELIZA_DISABLE_ACTIVITY_TRACKER"
  | "ELIZA_DISABLE_PROACTIVE_AGENT"
  | "ELIZA_DISABLE_LIFEOPS_SCHEDULER",
  "0" | "1"
> {
  const requiredServices = new Set(options.requiredServices ?? []);
  const backgroundWorkers = new Set(options.backgroundWorkers ?? []);
  return {
    ELIZA_DISABLE_ACTIVITY_TRACKER: requiredServices.has("activity_tracker")
      ? "0"
      : "1",
    ELIZA_DISABLE_PROACTIVE_AGENT: backgroundWorkers.has("PROACTIVE_AGENT")
      ? "0"
      : "1",
    ELIZA_DISABLE_LIFEOPS_SCHEDULER: backgroundWorkers.has("LIFEOPS_SCHEDULER")
      ? "0"
      : "1",
  };
}

type LoadedScenarioTestMocks = Awaited<ReturnType<typeof loadTestMocks>>;
type MockedScenarioEnvironment = Awaited<
  ReturnType<LoadedScenarioTestMocks["prepareMockedTestEnvironment"]>
>;

export type ScenarioExecutionEnvironment =
  | {
      executionProfile: "simulated";
      testMocks: LoadedScenarioTestMocks;
      mockedEnvironment: MockedScenarioEnvironment;
    }
  | {
      executionProfile: "provider-qualified";
      testMocks: null;
      mockedEnvironment: null;
    };

const PROVIDER_BASE_URL_ENV_NAMES = new Set([
  "ANTHROPIC_BASE_URL",
  "CEREBRAS_BASE_URL",
  "GITHUB_API_URL",
  "NTFY_BASE_URL",
  "OPENAI_BASE_URL",
]);

function isForbiddenProviderBaseUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    const hostname = parsed.hostname.toLowerCase();
    return (
      hostname === "localhost" ||
      hostname === "::1" ||
      hostname === "0.0.0.0" ||
      hostname.startsWith("127.") ||
      hostname.endsWith(".localhost") ||
      hostname.includes("mock") ||
      hostname.includes("fixture")
    );
  } catch {
    return true;
  }
}

export function providerQualifiedEnvironmentProblems(
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  const problems = new Set<string>();
  for (const [name, rawValue] of Object.entries(env)) {
    const value = rawValue?.trim();
    if (!value) continue;
    if (name.startsWith("ELIZA_MOCK_")) {
      problems.add(`${name} is a mock override`);
      continue;
    }
    if (
      name.includes("FIXTURE") &&
      (name.endsWith("_BASE") || name.endsWith("_BASE_URL"))
    ) {
      problems.add(`${name} is a fixture endpoint`);
      continue;
    }
    if (
      (PROVIDER_BASE_URL_ENV_NAMES.has(name) ||
        name.endsWith("_PROVIDER_BASE_URL")) &&
      isForbiddenProviderBaseUrl(value)
    ) {
      problems.add(`${name} is not a production provider endpoint`);
    }
  }
  if (envFlag(env.SCENARIO_USE_DETERMINISTIC_MODEL)) {
    problems.add(
      "SCENARIO_USE_DETERMINISTIC_MODEL enables the deterministic provider",
    );
  }
  if (envFlag(env.ELIZA_SCENARIO_USE_DETERMINISTIC_MODEL)) {
    problems.add(
      "ELIZA_SCENARIO_USE_DETERMINISTIC_MODEL enables the deterministic provider",
    );
  }
  if (envFlag(env.ELIZA_DISABLE_LIFEOPS_SCHEDULER)) {
    problems.add("ELIZA_DISABLE_LIFEOPS_SCHEDULER disables the scheduler");
  }
  if (envFlag(env.ELIZA_BLOCK_REAL_GMAIL_WRITES)) {
    problems.add("ELIZA_BLOCK_REAL_GMAIL_WRITES enables connector test mode");
  }
  return [...problems].sort();
}

export function assertProviderQualifiedEnvironment(
  env: NodeJS.ProcessEnv = process.env,
): void {
  const problems = providerQualifiedEnvironmentProblems(env);
  if (problems.length > 0) {
    throw new Error(
      `[scenario-runner] provider-qualified environment preflight failed: ${problems.join("; ")}`,
    );
  }
}

export async function prepareScenarioExecutionEnvironment(
  executionProfile: ScenarioExecutionProfile,
  testMocksLoader: () => Promise<LoadedScenarioTestMocks> = loadTestMocks,
): Promise<ScenarioExecutionEnvironment> {
  if (executionProfile === "provider-qualified") {
    assertProviderQualifiedEnvironment();
    return {
      executionProfile,
      testMocks: null,
      mockedEnvironment: null,
    };
  }
  const testMocks = await testMocksLoader();
  const mockedEnvironment = await testMocks.prepareMockedTestEnvironment({
    seedLifeOpsSimulator: true,
  });
  return { executionProfile, testMocks, mockedEnvironment };
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

export function shouldUseDeterministicModel(
  options: Pick<CreateScenarioRuntimeOptions, "useDeterministicModel"> = {},
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return (
    options.useDeterministicModel === true ||
    envFlag(env.SCENARIO_USE_DETERMINISTIC_MODEL) ||
    envFlag(env.ELIZA_SCENARIO_USE_DETERMINISTIC_MODEL)
  );
}

const EXACT_LIVE_PROVIDER_CREDENTIALS: Partial<
  Record<LiveProviderName, readonly string[]>
> = {
  groq: ["GROQ_API_KEY"],
  openai: ["OPENAI_API_KEY"],
  anthropic: ["ANTHROPIC_API_KEY"],
  google: ["GOOGLE_GENERATIVE_AI_API_KEY", "GOOGLE_API_KEY"],
  openrouter: ["OPENROUTER_API_KEY"],
};

function configuredEnvValue(
  env: NodeJS.ProcessEnv,
  names: readonly string[],
): boolean {
  return names.some((name) => Boolean(env[name]?.trim()));
}

function resolvedLiveProviderIdentity(
  providerConfig: LiveProviderConfig,
): string {
  if (providerConfig.name !== "openai") return providerConfig.name;
  try {
    const hostname = new URL(providerConfig.baseUrl).hostname.toLowerCase();
    if (hostname === "cerebras.ai" || hostname.endsWith(".cerebras.ai")) {
      return "cerebras";
    }
  } catch {
    // Provider configuration validates the URL at its own transport boundary.
  }
  return providerConfig.env.ELIZA_PROVIDER?.trim().toLowerCase() || "openai";
}

/**
 * Rejects credential aliasing and self-judging before a live runtime starts.
 * An explicit provider is an identity claim: its own credential must exist,
 * even when the shared core selector supports protocol-compatible fallbacks.
 */
export function scenarioLiveProviderPreflightProblems(
  preferredProvider: LiveProviderName | undefined,
  providerConfig?: LiveProviderConfig | null,
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  const problems = new Set<string>();
  const exactCredentials = preferredProvider
    ? EXACT_LIVE_PROVIDER_CREDENTIALS[preferredProvider]
    : undefined;
  if (exactCredentials && !configuredEnvValue(env, exactCredentials)) {
    problems.add(
      `--provider ${preferredProvider} requires ${exactCredentials.join(" or ")}; compatible provider credentials cannot satisfy an explicit provider selection`,
    );
  }

  const strictJudge = envFlag(env.SCENARIO_JUDGE_REQUIRE_INDEPENDENT);
  const judgeProvider =
    env.EVAL_MODEL_PROVIDER?.trim().toLowerCase() ||
    env.EVAL_PROVIDER?.trim().toLowerCase() ||
    "cerebras";
  if (strictJudge) {
    if (judgeProvider !== "cerebras") {
      problems.add(
        `SCENARIO_JUDGE_REQUIRE_INDEPENDENT requires the supported independent judge provider cerebras; resolved ${judgeProvider}`,
      );
    } else if (
      !configuredEnvValue(env, ["EVAL_CEREBRAS_API_KEY", "CEREBRAS_API_KEY"])
    ) {
      problems.add(
        "SCENARIO_JUDGE_REQUIRE_INDEPENDENT requires EVAL_CEREBRAS_API_KEY or CEREBRAS_API_KEY",
      );
    }
  }

  if (providerConfig) {
    const actingProvider = resolvedLiveProviderIdentity(providerConfig);
    if (preferredProvider && actingProvider !== preferredProvider) {
      problems.add(
        `requested acting provider ${preferredProvider} resolved to ${actingProvider}`,
      );
    }
    if (strictJudge && actingProvider === judgeProvider) {
      problems.add(
        `acting provider ${actingProvider} cannot also be the independent judge provider`,
      );
    }
  }
  return [...problems].sort();
}

export function assertScenarioLiveProviderPreflight(
  preferredProvider: LiveProviderName | undefined,
  providerConfig?: LiveProviderConfig | null,
  env: NodeJS.ProcessEnv = process.env,
): void {
  const problems = scenarioLiveProviderPreflightProblems(
    preferredProvider,
    providerConfig,
    env,
  );
  if (problems.length > 0) {
    throw new Error(
      `[scenario-runner] live provider preflight failed: ${problems.join("; ")}`,
    );
  }
}

function deterministicModelProviderConfig(): RuntimeFactoryResult["providerConfig"] {
  return {
    name: DETERMINISTIC_MODEL_PROVIDER_NAME,
    env: {},
    pluginPackage: null,
  };
}

export function isScheduledDispatchRenderPrompt(prompt: string): boolean {
  return (
    prompt.startsWith(SCHEDULED_DISPATCH_RENDER_PROMPT_PREFIX) &&
    prompt.includes(SCHEDULED_DISPATCH_RENDER_INSTRUCTION_MARKER) &&
    prompt.trimEnd().endsWith("Message:")
  );
}

export function deterministicScheduledDispatchRenderText(
  prompt: string,
): string {
  const instructionStart = prompt.indexOf(
    SCHEDULED_DISPATCH_RENDER_INSTRUCTION_MARKER,
  );
  // The instruction section ends at "Message:" in the current prompt shape;
  // legacy prompts carried a trailing "Fired at:" line first. Stop at whichever
  // marker follows the instruction earliest.
  const instructionEnd = Math.min(
    ...[
      prompt.indexOf(SCHEDULED_DISPATCH_RENDER_FIRED_AT_MARKER),
      prompt.lastIndexOf(SCHEDULED_DISPATCH_RENDER_MESSAGE_MARKER),
    ].filter((index) => index > instructionStart),
  );
  const instruction =
    instructionStart >= 0 && Number.isFinite(instructionEnd)
      ? prompt
          .slice(
            instructionStart +
              SCHEDULED_DISPATCH_RENDER_INSTRUCTION_MARKER.length,
            instructionEnd,
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
  // A deterministic stand-in for the dispatch-render model must be predictable
  // so scenarios can assert the delivered copy exactly, but the renderer's
  // instruction-echo guard rejects copy that equals (or, at >=64 chars,
  // contains) the raw instruction. Prefix the de-framed instruction and clamp
  // long instructions so the deterministic copy always passes that guard.
  if (!ownerMessage) return "checking in.";
  const clamped =
    ownerMessage.length >= 64
      ? `${ownerMessage.slice(0, 60).trimEnd()}…`
      : ownerMessage;
  return `Heads up: ${clamped}`;
}

// The dispatcher renders a notification TITLE through a second model call
// after the body. Left unanswered, the strict proxy rejects it, the in_app
// dispatcher's notify branch swallows the throw, and delivery silently drops to
// zero surfaces — reported as `disconnected`, so the task advances without firing
// (concurrent-day, multiday-journey, and the corpus reminder scenarios).
export function isScheduledDispatchTitlePrompt(prompt: string): boolean {
  return (
    prompt.startsWith(SCHEDULED_DISPATCH_TITLE_PROMPT_PREFIX) &&
    prompt.includes(SCHEDULED_DISPATCH_TITLE_BODY_MARKER) &&
    prompt.includes(SCHEDULED_DISPATCH_RENDER_FIRED_AT_MARKER) &&
    prompt.trimEnd().endsWith("Title:")
  );
}

export function deterministicScheduledDispatchTitleText(
  prompt: string,
): string {
  const bodyStart = prompt.indexOf(SCHEDULED_DISPATCH_TITLE_BODY_MARKER);
  const firedAtStart = prompt.indexOf(
    SCHEDULED_DISPATCH_RENDER_FIRED_AT_MARKER,
  );
  const body =
    bodyStart >= 0 && firedAtStart > bodyStart
      ? prompt
          .slice(
            bodyStart + SCHEDULED_DISPATCH_TITLE_BODY_MARKER.length,
            firedAtStart,
          )
          .trim()
      : "";
  const words = body
    .replace(/\s+/g, " ")
    .trim()
    .split(" ")
    .filter(Boolean)
    .slice(0, 6);
  return words.length > 0 ? words.join(" ") : "Reminder";
}

type ScenarioDeterministicModelCall = {
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
  call: ScenarioDeterministicModelCall,
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

export function resolveScenarioDeterministicModelCall(
  call: ScenarioDeterministicModelCall,
): string | null {
  // Scheduled-dispatch voicing renders through TEXT_SMALL (dispatch-render.ts);
  // older callers used TEXT_LARGE. Accept both so zero-key scenario lanes keep
  // deterministic copy for either surface.
  if (
    call.modelType !== ModelType.TEXT_LARGE &&
    call.modelType !== ModelType.TEXT_SMALL
  ) {
    return null;
  }
  const candidates = deterministicCallTextCandidates(call);
  const bodyPrompt = candidates.find(isScheduledDispatchRenderPrompt);
  if (bodyPrompt) {
    return deterministicScheduledDispatchRenderText(bodyPrompt);
  }
  const titlePrompt = candidates.find(isScheduledDispatchTitlePrompt);
  if (titlePrompt) {
    return deterministicScheduledDispatchTitleText(titlePrompt);
  }
  return null;
}

export function resolveScenarioProviderConfig(
  options: Pick<
    CreateScenarioRuntimeOptions,
    "preferredProvider" | "useDeterministicModel"
  > = {},
  env: NodeJS.ProcessEnv = process.env,
): RuntimeFactoryResult["providerConfig"] | null {
  if (shouldUseDeterministicModel(options, env)) {
    if (options.preferredProvider) {
      throw new Error(
        `[scenario-runner] preferred live provider ${options.preferredProvider} cannot be combined with the deterministic model provider`,
      );
    }
    return deterministicModelProviderConfig();
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
 * stay. The deterministic provider lane keeps everything as-is.
 */
export function clearLlmWireMockEnvForLiveProvider(
  providerName: RuntimeFactoryResult["providerConfig"]["name"],
  env: NodeJS.ProcessEnv = process.env,
): void {
  if (providerName === DETERMINISTIC_MODEL_PROVIDER_NAME) return;
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
  const executionProfile =
    options?.executionProfile ?? DEFAULT_SCENARIO_EXECUTION_PROFILE;
  if (executionProfile === "provider-qualified") {
    assertProviderQualifiedEnvironment();
    if (options?.useDeterministicModel === true) {
      throw new Error(
        "[scenario-runner] provider-qualified execution cannot use the deterministic model provider",
      );
    }
    if ((options?.extraPlugins?.length ?? 0) > 0) {
      throw new Error(
        "[scenario-runner] provider-qualified execution accepts only scenario-declared plugin packages; extraPlugins are simulated/test injection",
      );
    }
    assertProviderQualifiedPluginPackages(options?.requiredPlugins ?? []);
  }
  const providerConfig = resolveScenarioProviderConfig(options);
  if (!providerConfig) {
    throw new Error(
      "[scenario-runner] no LLM provider configured. Set GROQ_API_KEY / OPENAI_API_KEY / ANTHROPIC_API_KEY / GOOGLE_GENERATIVE_AI_API_KEY / OPENROUTER_API_KEY, set ELIZA_CHAT_VIA_CLI=claude|claude-sdk|codex|codex-sdk on a subscription-only host, or enable deterministic test mode with SCENARIO_USE_DETERMINISTIC_MODEL=1.",
    );
  }
  if (providerConfig.name !== DETERMINISTIC_MODEL_PROVIDER_NAME) {
    assertScenarioLiveProviderPreflight(
      options?.preferredProvider,
      providerConfig,
    );
  }
  if (
    executionProfile === "provider-qualified" &&
    providerConfig.name === DETERMINISTIC_MODEL_PROVIDER_NAME
  ) {
    throw new Error(
      "[scenario-runner] provider-qualified execution requires a live model provider",
    );
  }
  const preparedEnvironment =
    await prepareScenarioExecutionEnvironment(executionProfile);
  const { testMocks, mockedEnvironment } = preparedEnvironment;
  for (const [key, value] of Object.entries(providerConfig.env)) {
    process.env[key] = value;
  }
  clearLlmWireMockEnvForLiveProvider(providerConfig.name);
  if (executionProfile === "provider-qualified") {
    assertProviderQualifiedEnvironment();
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
  const prevSkillsDir = process.env.SKILLS_DIR;
  const scenarioSkillsRoot =
    executionProfile === "simulated" && !prevSkillsDir?.trim()
      ? fs.mkdtempSync(path.join(os.tmpdir(), "scenario-runner-skills-"))
      : null;
  let scenarioHostsRoot: string | null = null;
  process.env.PGLITE_DATA_DIR = pgliteDir;
  const backgroundFlags = resolveBackgroundServiceFlags(options);
  process.env.ELIZA_DISABLE_ACTIVITY_TRACKER =
    backgroundFlags.ELIZA_DISABLE_ACTIVITY_TRACKER;
  process.env.ELIZA_DISABLE_PROACTIVE_AGENT =
    backgroundFlags.ELIZA_DISABLE_PROACTIVE_AGENT;
  if (executionProfile === "simulated") {
    process.env.ELIZA_DISABLE_LIFEOPS_SCHEDULER =
      backgroundFlags.ELIZA_DISABLE_LIFEOPS_SCHEDULER;
  }
  if (scenarioSkillsRoot) {
    process.env.SKILLS_DIR = scenarioSkillsRoot;
  }
  if (!process.env.LOCAL_EMBEDDING_DIMENSIONS?.trim()) {
    process.env.LOCAL_EMBEDDING_DIMENSIONS = "384";
  }
  if (!process.env.EMBEDDING_DIMENSION?.trim()) {
    process.env.EMBEDDING_DIMENSION = "384";
  }
  if (
    executionProfile === "simulated" &&
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
  const scenarioRuntimeSettings =
    executionProfile === "simulated"
      ? {
          ...(process.env.SKILLS_DIR
            ? { SKILLS_DIR: process.env.SKILLS_DIR }
            : {}),
          ACTION_CALLBACK_VOICE_REWRITE: "false",
          LIFEOPS_INBOX_PRIORITY_SCORING: "false",
        }
      : {};
  const runtime = new AgentRuntimeCtor({
    character,
    plugins: [],
    logLevel: "warn",
    enableAutonomy: false,
    // The agent-skills service reads SKILLS_DIR via runtime.getSetting(), which
    // does not consult process.env. Mirror the scenario env into runtime
    // settings so skills storage lands in the throwaway temp directory.
    // These settings exist only to keep the legacy simulated harness
    // deterministic. Provider-qualified runs inherit the production defaults.
    settings: scenarioRuntimeSettings,
  });
  const registeredPluginPackages = new Set<string>();

  const { default: pluginSql } = (await import("@elizaos/plugin-sql")) as {
    default: Plugin;
  };
  await runtime.registerPlugin(pluginSql);
  registeredPluginPackages.add("@elizaos/plugin-sql");
  await runtime.registerPlugin(trajectoriesPlugin);
  registeredPluginPackages.add("@elizaos/plugin-trajectories");
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

  // Simulated scenarios omit embeddings because their assertions do not score
  // semantic retrieval. AgentRuntime treats an absent embedding provider as an
  // explicit disabled capability, avoiding both model downloads and fabricated
  // vectors. Provider-qualified runs retain the production local provider.
  const skipEmbeddingPlugin =
    executionProfile === "simulated" &&
    (process.env.ELIZA_BENCH_SKIP_EMBEDDING ?? "1") !== "0";
  if (skipEmbeddingPlugin) {
    logger.info(
      "[scenario-runner] Embedding generation is disabled for the simulated profile; " +
        "set ELIZA_BENCH_SKIP_EMBEDDING=0 to use @elizaos/plugin-local-inference.",
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
  if (providerConfig.name === DETERMINISTIC_MODEL_PROVIDER_NAME) {
    if (!testMocks) {
      throw new Error(
        "[scenario-runner] deterministic model provider requested without the simulated test environment",
      );
    }
    const deterministicModelPlugin = createDeterministicModelPlugin({
      resolve: resolveScenarioDeterministicModelCall,
    });
    await runtime.registerPlugin(deterministicModelPlugin);
    const runtimeWithScenarioFixtures = runtime as AgentRuntime & {
      scenarioModelFixtures?: unknown;
      assertScenarioModelFixturesConsumed?: () => void;
      getScenarioModelFixtureDiagnostics?: () => unknown;
    };
    runtimeWithScenarioFixtures.scenarioModelFixtures =
      deterministicModelPlugin.fixtures;
    runtimeWithScenarioFixtures.assertScenarioModelFixturesConsumed =
      deterministicModelPlugin.assertFixturesConsumed;
    runtimeWithScenarioFixtures.getScenarioModelFixtureDiagnostics =
      deterministicModelPlugin.getFixtureDiagnostics;
    logger.info(
      "[scenario-runner] Registered deterministic fixture model provider; no live provider key required.",
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

  if (executionProfile === "simulated") {
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
    registeredPluginPackages.add("@elizaos/plugin-agent-skills");

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
    registeredPluginPackages.add("@elizaos/plugin-scheduling");

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
    registeredPluginPackages.add("@elizaos/plugin-personal-assistant/plugin");

    // Dashboard routes remain a compatibility-harness capability. Qualified
    // runs receive only packages declared by the scenario, preventing an
    // ambient route bundle from making a missing production dependency pass.
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
    registeredPluginPackages.add("@elizaos/plugin-personal-assistant");

    for (const extra of options?.extraPlugins ?? []) {
      await runtime.registerPlugin(extra);
    }
  }

  const requiredPluginPackages = await registerScenarioRequiredPlugins(
    runtime,
    options?.requiredPlugins ?? [],
    executionProfile,
  );
  for (const packageName of requiredPluginPackages) {
    registeredPluginPackages.add(packageName);
  }

  await runtime.initialize();
  const cleanupRuntimeFixtures =
    mockedEnvironment && testMocks
      ? await mockedEnvironment.applyRuntimeFixtures?.(runtime)
      : undefined;
  if (executionProfile === "simulated" && testMocks) {
    await testMocks.seedGoogleConnectorGrant(runtime);
    await testMocks.seedXConnectorGrant(runtime);
    await testMocks.seedBenchmarkLifeOpsFixtures(runtime);
    await testMocks.seedLifeOpsSimulatorRuntime(runtime);

    // The shared simulated runtime treats onboarding as complete so action
    // routing is independent of scenario discovery order.
    await runtime.setCache("eliza:lifeops:first-run:v1", {
      status: "complete",
      partialAnswers: {},
      completionCount: 1,
      completedAt: "1970-01-01T00:00:00.000Z",
    });

    // UPDATE_ENTITY is excluded only from the compatibility harness because
    // its broad description crowds out the domain actions those deterministic
    // fixtures target. Qualified runs retain production action selection.
    const bannedActions = new Set(["UPDATE_ENTITY"]);
    const runtimeActions = runtime.actions;
    for (let i = runtimeActions.length - 1; i >= 0; i -= 1) {
      if (bannedActions.has(runtimeActions[i].name)) {
        runtimeActions.splice(i, 1);
      }
    }
  } else {
    assertProviderQualifiedEnvironment();
    const missingRequiredPlugins = (options?.requiredPlugins ?? []).filter(
      (packageName) => !pluginPackageIsRegistered(runtime, packageName),
    );
    if (missingRequiredPlugins.length > 0) {
      throw new Error(
        `[scenario-runner] provider-qualified runtime is missing declared plugin(s) after initialization: ${missingRequiredPlugins.join(", ")}`,
      );
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
    if (prevSkillsDir !== undefined) {
      process.env.SKILLS_DIR = prevSkillsDir;
    } else {
      delete process.env.SKILLS_DIR;
    }
    await runCleanupStep("mocked environment", async () => {
      if (!mockedEnvironment) {
        return;
      }
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
    executionProfile,
    registeredPluginPackages: [...registeredPluginPackages].sort(),
    providerName: providerConfig.name,
    providerConfig,
    cleanup,
  };
}
