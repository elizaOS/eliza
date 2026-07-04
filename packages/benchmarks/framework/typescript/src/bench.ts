#!/usr/bin/env bun
/**
 * Eliza Framework Benchmark — TypeScript Runtime
 *
 * Measures core agent framework performance with mock LLM handlers
 * and in-memory database. No real LLM calls, no disk I/O, no network.
 *
 * Pass --real-llm to use a real OpenAI model provider instead of the mock.
 * This is useful for end-to-end testing but results will include network
 * latency and are NOT suitable for framework overhead measurement.
 */
import { readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  AgentRuntime,
  ChannelType as ChannelTypes,
  type Character,
  type Content,
  InMemoryDatabaseAdapter,
  type Memory,
  ModelType,
  type Plugin,
  type UUID,
} from "@elizaos/core";
import {
  type BenchmarkResult,
  computeLatencyStats,
  computeThroughputStats,
  formatDuration,
  getSystemInfo,
  MemoryMonitor,
  PipelineTimer,
  printScenarioResult,
  type ScenarioResult,
  Timer,
} from "./metrics.js";
import { createDummyProviders, mockLlmPlugin } from "./mock-llm-plugin.js";

// ─── Real LLM support ───────────────────────────────────────────────────────

/**
 * Dynamically load the OpenAI plugin for real-LLM mode.
 * Isolated in a function so the import only happens when --real-llm is used.
 */
async function loadOpenAIPlugin(): Promise<Plugin> {
  const mod = (await import("@elizaos/plugin-openai")) as {
    openaiPlugin: Plugin;
    default: Plugin;
  };
  return mod.openaiPlugin;
}

/**
 * Dynamically load @elizaos/plugin-cli-inference for the CLI-subscription
 * (Claude Max / ChatGPT-Codex) real-LLM route. Isolated so the import only
 * happens when a CLI backend is selected.
 */
async function loadCliInferencePlugin(): Promise<Plugin> {
  const mod = (await import("@elizaos/plugin-cli-inference")) as {
    cliInferencePlugin?: Plugin;
    default: Plugin;
  };
  return mod.default ?? (mod.cliInferencePlugin as Plugin);
}

/** CLI-subscription backends @elizaos/plugin-cli-inference can serve. */
const CLI_BACKENDS = ["claude", "claude-sdk", "codex", "codex-sdk"] as const;

/**
 * The CLI-subscription backend explicitly requested via ELIZA_CHAT_VIA_CLI, or
 * null when unset / not a supported backend. Setting this env var is an explicit
 * opt-in to the subscription route (no API key), so it is honored ahead of any
 * OpenAI/Cerebras key — exactly what the gpt-5.5-via-Codex trajectory harvest
 * needs.
 */
function resolveCliBackend(): (typeof CLI_BACKENDS)[number] | null {
  const raw = process.env.ELIZA_CHAT_VIA_CLI?.trim().toLowerCase();
  return (CLI_BACKENDS as readonly string[]).includes(raw ?? "")
    ? (raw as (typeof CLI_BACKENDS)[number])
    : null;
}

/**
 * @elizaos/plugin-cli-inference registers large-tier handlers only (TEXT_LARGE
 * / TEXT_MEGA / RESPONSE_HANDLER, plus ACTION_PLANNER in text-planner mode). A
 * real message turn also needs a TEXT_EMBEDDING handler (memory writes) and a
 * TEXT_SMALL handler (should-respond / extraction). These two zero-cost shims
 * supply them so the CLI route drives the message loop end to end — mirroring
 * the proven scenario-runner cli path (runtime-factory.ts).
 */
function createEmbeddingFallbackPlugin(): Plugin {
  // Match the benchmark mock's 384-dim zero vector so the InMemory adapter's
  // vector shape stays consistent across mock and cli runs.
  const EMBEDDING_DIMENSIONS = 384;
  return {
    name: "benchmark-cli-embedding-fallback",
    description:
      "Zero-vector TEXT_EMBEDDING handler for the CLI-subscription route " +
      "(plugin-cli-inference registers no embedding handler).",
    priority: 100,
    models: {
      [ModelType.TEXT_EMBEDDING]: async () =>
        new Array<number>(EMBEDDING_DIMENSIONS).fill(0),
    },
  };
}

function createCliSmallTierBridgePlugin(): Plugin {
  return {
    name: "benchmark-cli-small-tier-bridge",
    description:
      "Routes TEXT_SMALL to TEXT_LARGE when the large-tier-only " +
      "CLI-subscription provider serves the benchmark runtime.",
    models: {
      [ModelType.TEXT_SMALL]: async (bridgeRuntime, params) =>
        bridgeRuntime.useModel(ModelType.TEXT_LARGE, params),
    },
  };
}

interface ResolvedLlm {
  llmPlugins: Plugin[];
  isRealLlm: boolean;
  providerLabel: string;
}

/**
 * Resolve which LLM plugin(s) to use based on the --real-llm flag.
 *
 * Real-LLM mode has two routes:
 *
 *   1. CLI-subscription (ELIZA_CHAT_VIA_CLI = claude | claude-sdk | codex |
 *      codex-sdk): loads @elizaos/plugin-cli-inference, which serves inference
 *      by spawning the sanctioned local CLI (`codex exec -m gpt-5.5`,
 *      `claude --print`). The CLI reads its own on-disk subscription creds — no
 *      API key ever passes through eliza. Requires ELIZA_PLANNER_NATIVE_TOOLS=0
 *      (text-planner mode) for the free-text CLI to serve the planner; the
 *      large-tier-only plugin is paired with a zero-vector embedding shim + a
 *      TEXT_SMALL->TEXT_LARGE bridge so a real message turn runs end to end.
 *      This is the gpt-5.5-via-Codex trajectory-harvest route.
 *
 *   2. API key (OPENAI_API_KEY or CEREBRAS_API_KEY): loads @elizaos/plugin-openai.
 *      With the Cerebras key (and no OpenAI key) the OpenAI plugin is pointed at
 *      Cerebras's OpenAI-compatible endpoint.
 *
 * The CLI route is checked first: ELIZA_CHAT_VIA_CLI is an explicit opt-in, so it
 * wins over an ambient API key.
 */
async function resolveLlmPlugin(useRealLlm: boolean): Promise<ResolvedLlm> {
  if (!useRealLlm) {
    return {
      llmPlugins: [mockLlmPlugin],
      isRealLlm: false,
      providerLabel: "mock (deterministic)",
    };
  }

  const cliBackend = resolveCliBackend();
  if (cliBackend) {
    const isCodex = cliBackend.startsWith("codex");
    const model = isCodex
      ? process.env.ELIZA_CLI_CODEX_MODEL?.trim() || "gpt-5.5"
      : process.env.ELIZA_CLI_CLAUDE_MODEL?.trim() || "claude-opus-4-7";
    if (process.env.ELIZA_PLANNER_NATIVE_TOOLS?.trim() !== "0") {
      console.log(
        "NOTE: CLI-subscription route works best with ELIZA_PLANNER_NATIVE_TOOLS=0 " +
          "(text-planner mode); the free-text CLI cannot honor native-tool grammar.",
      );
    }
    const plugin = await loadCliInferencePlugin();
    return {
      llmPlugins: [
        plugin,
        createEmbeddingFallbackPlugin(),
        createCliSmallTierBridgePlugin(),
      ],
      isRealLlm: true,
      providerLabel: `real (cli:${cliBackend} ${model})`,
    };
  }

  const hasOpenAi = !!process.env.OPENAI_API_KEY;
  const hasCerebras = !!process.env.CEREBRAS_API_KEY;

  if (!hasOpenAi && !hasCerebras) {
    console.error(
      "ERROR: --real-llm requires ELIZA_CHAT_VIA_CLI (claude|claude-sdk|codex|codex-sdk), " +
        "OPENAI_API_KEY, or CEREBRAS_API_KEY to be set.",
    );
    process.exit(1);
  }

  if (hasCerebras && !hasOpenAi) {
    process.env.ELIZA_PROVIDER = process.env.ELIZA_PROVIDER ?? "cerebras";
    process.env.OPENAI_BASE_URL =
      process.env.OPENAI_BASE_URL ?? "https://api.cerebras.ai/v1";
    process.env.OPENAI_LARGE_MODEL =
      process.env.OPENAI_LARGE_MODEL ?? "llama3.1-8b";
    process.env.OPENAI_SMALL_MODEL =
      process.env.OPENAI_SMALL_MODEL ?? "llama3.1-8b";
    process.env.OPENAI_EMBEDDING_MODEL =
      process.env.OPENAI_EMBEDDING_MODEL ?? "none";
  }

  const plugin = await loadOpenAIPlugin();
  const providerLabel =
    hasCerebras && !hasOpenAi ? "real (Cerebras)" : "real (OpenAI)";
  return { llmPlugins: [plugin], isRealLlm: true, providerLabel };
}

// ─── Path resolution ────────────────────────────────────────────────────────

const __dirname = dirname(fileURLToPath(import.meta.url));
const SHARED_DIR = resolve(__dirname, "../../shared");
const RESULTS_DIR = resolve(__dirname, "../../results");

// ─── Load shared configuration ──────────────────────────────────────────────

interface ScenarioMessage {
  content: string;
  role: string;
}

interface ScenarioConfig {
  checkShouldRespond?: boolean;
  multiStep?: boolean;
  warmup: number;
  iterations: number;
  dummyProviders?: number;
  prePopulateHistory?: number;
  concurrent?: boolean;
  dbOnly?: boolean;
  dbOperation?: "read" | "write";
  dbCount?: number;
  startupOnly?: boolean;
  minimalBootstrap?: boolean;
}

interface Scenario {
  id: string;
  name: string;
  description: string;
  messages: ScenarioMessage[] | string;
  config: ScenarioConfig;
}

type ScenarioVariant = {
  id: string;
  label: string;
  description: string;
  rewrite: (content: string) => string;
};

const EXPANSION_MULTIPLIER = 10;

const SCENARIO_VARIANTS: ScenarioVariant[] = [
  {
    id: "polite",
    label: "polite",
    description: "Polite user phrasing.",
    rewrite: (content) => `Please help with this benchmark request: ${content}`,
  },
  {
    id: "urgent",
    label: "urgent",
    description: "Urgent user phrasing.",
    rewrite: (content) => `This is time sensitive: ${content}`,
  },
  {
    id: "mobile",
    label: "mobile",
    description: "Mobile-message framing.",
    rewrite: (content) => `Sent from mobile, quick note: ${content}`,
  },
  {
    id: "followup",
    label: "follow-up",
    description: "Follow-up thread framing.",
    rewrite: (content) => `Following up from earlier: ${content}`,
  },
  {
    id: "quoted",
    label: "quoted",
    description: "Quoted forwarded request.",
    rewrite: (content) => `Forwarded request:\n> ${content}`,
  },
  {
    id: "context",
    label: "context",
    description: "Extra operational context.",
    rewrite: (content) => `Context: framework benchmark\n${content}`,
  },
  {
    id: "brief",
    label: "brief",
    description: "Brevity preference.",
    rewrite: (content) => `Keep this brief: ${content}`,
  },
  {
    id: "noisy",
    label: "noisy",
    description: "Natural chat filler.",
    rewrite: (content) => `Hey, sorry for the messy note, ${content}`,
  },
  {
    id: "boundary",
    label: "boundary",
    description: "Explicit user-intent boundary.",
    rewrite: (content) => `User intent starts here:\n${content}`,
  },
  {
    id: "handoff",
    label: "handoff",
    description: "Teammate handoff framing.",
    rewrite: (content) => `My teammate asked me to send this: ${content}`,
  },
];

if (SCENARIO_VARIANTS.length !== EXPANSION_MULTIPLIER) {
  throw new Error(
    `Framework benchmark expansion requires exactly ${EXPANSION_MULTIPLIER} variants, found ${SCENARIO_VARIANTS.length}`,
  );
}

function loadBaseScenarios(): Scenario[] {
  const raw = readFileSync(resolve(SHARED_DIR, "scenarios.json"), "utf-8");
  return JSON.parse(raw).scenarios;
}

function applyScenarioVariant(
  scenario: Scenario,
  variant: ScenarioVariant,
): Scenario {
  return {
    ...scenario,
    id: `${scenario.id}--edge-${variant.id}`,
    name: `${scenario.name} (${variant.label})`,
    description: `${scenario.description} Edge variant: ${variant.description}`,
    messages: Array.isArray(scenario.messages)
      ? scenario.messages.map((message) => ({
          ...message,
          content: variant.rewrite(message.content),
        }))
      : scenario.messages,
  };
}

function expandScenarios(baseScenarios: readonly Scenario[]): Scenario[] {
  const expanded = baseScenarios.flatMap((scenario) =>
    SCENARIO_VARIANTS.map((variant) => applyScenarioVariant(scenario, variant)),
  );
  if (expanded.length !== baseScenarios.length * EXPANSION_MULTIPLIER) {
    throw new Error(
      `Framework benchmark expansion mismatch: expected ${baseScenarios.length * EXPANSION_MULTIPLIER}, found ${expanded.length}`,
    );
  }
  return expanded;
}

function loadScenarios(): Scenario[] {
  const baseScenarios = loadBaseScenarios();
  return [...baseScenarios, ...expandScenarios(baseScenarios)];
}

function countScenarios(): {
  suite: "framework-benchmark";
  existing: number;
  added: number;
  total: number;
  multiplierAdded: number;
} {
  const baseScenarios = loadBaseScenarios();
  const expanded = expandScenarios(baseScenarios);
  return {
    suite: "framework-benchmark",
    existing: baseScenarios.length,
    added: expanded.length,
    total: baseScenarios.length + expanded.length,
    multiplierAdded: expanded.length / baseScenarios.length,
  };
}

function validateScenarios(): {
  valid: boolean;
  total: number;
  uniqueIds: number;
  duplicateIds: string[];
  expansionMatches: boolean;
} {
  const baseScenarios = loadBaseScenarios();
  const expanded = expandScenarios(baseScenarios);
  const allScenarios = [...baseScenarios, ...expanded];
  const ids = new Set<string>();
  const duplicateIds = new Set<string>();

  for (const scenario of allScenarios) {
    if (ids.has(scenario.id)) duplicateIds.add(scenario.id);
    ids.add(scenario.id);
  }

  const expansionMatches =
    expanded.length === baseScenarios.length * EXPANSION_MULTIPLIER;

  return {
    valid: duplicateIds.size === 0 && expansionMatches,
    total: allScenarios.length,
    uniqueIds: ids.size,
    duplicateIds: [...duplicateIds],
    expansionMatches,
  };
}

function loadCharacter(): Character {
  const raw = readFileSync(resolve(SHARED_DIR, "character.json"), "utf-8");
  return JSON.parse(raw) as Character;
}

/** Generate N messages with agent name included */
function generateMessages(count: number): ScenarioMessage[] {
  const msgs: ScenarioMessage[] = [];
  for (let i = 0; i < count; i++) {
    msgs.push({
      content: `BenchmarkAgent, benchmark message number ${i + 1}.`,
      role: "user",
    });
  }
  return msgs;
}

/** Resolve messages (handles _generate:N pattern) */
function resolveMessages(
  messages: ScenarioMessage[] | string,
): ScenarioMessage[] {
  if (typeof messages === "string" && messages.startsWith("_generate:")) {
    const count = parseInt(messages.split(":")[1], 10);
    return generateMessages(count);
  }
  return messages as ScenarioMessage[];
}

// ─── Fixed UUIDs for deterministic benchmark ────────────────────────────────

const AGENT_ID = "00000000-0000-0000-0000-000000000001" as UUID;
const USER_ENTITY_ID = "00000000-0000-0000-0000-000000000002" as UUID;
const ROOM_ID = "00000000-0000-0000-0000-000000000003" as UUID;
const WORLD_ID = "00000000-0000-0000-0000-000000000004" as UUID;

// ─── Runtime factory ────────────────────────────────────────────────────────

async function createBenchmarkRuntime(
  character: Character,
  extraPlugins: Plugin[] = [],
  config: ScenarioConfig = { warmup: 0, iterations: 1 },
  llmPlugins: Plugin[] = [mockLlmPlugin],
): Promise<AgentRuntime> {
  const adapter = new InMemoryDatabaseAdapter();

  const plugins: Plugin[] = [...llmPlugins, ...extraPlugins];

  // Add dummy providers if requested
  if (config.dummyProviders && config.dummyProviders > 0) {
    const dummyProviders = createDummyProviders(config.dummyProviders);
    plugins.push({
      name: "benchmark-dummy-providers",
      description: `${config.dummyProviders} dummy providers for scaling tests`,
      providers: dummyProviders,
    });
  }

  const runtime = new AgentRuntime({
    agentId: AGENT_ID,
    character: {
      ...character,
      settings: {
        ...character.settings,
        ALLOW_NO_DATABASE: "true",
        USE_MULTI_STEP: config.multiStep ? "true" : "false",
        VALIDATION_LEVEL: "trusted",
      },
    },
    plugins,
    adapter,
    checkShouldRespond: config.checkShouldRespond ?? false,
    logLevel: "fatal",
    // When minimalBootstrap is true, disable extended capabilities for a leaner test
    disableBasicCapabilities: false,
    enableExtendedCapabilities: config.minimalBootstrap ? false : undefined,
  });

  await runtime.initialize();

  // Set up world, room, entities, participants
  await runtime.createWorld({
    id: WORLD_ID,
    name: "BenchmarkWorld",
    agentId: AGENT_ID,
    messageServerId: "benchmark",
  });

  await runtime.createRoom({
    id: ROOM_ID,
    name: "BenchmarkRoom",
    agentId: AGENT_ID,
    source: "benchmark",
    type: ChannelTypes.GROUP,
    worldId: WORLD_ID,
  } as Parameters<typeof runtime.createRoom>[0]);

  await runtime.createEntities([
    {
      id: AGENT_ID,
      names: ["BenchmarkAgent"],
      agentId: AGENT_ID,
    } as Parameters<typeof runtime.createEntities>[0][number],
    {
      id: USER_ENTITY_ID,
      names: ["BenchmarkUser"],
      agentId: AGENT_ID,
    } as Parameters<typeof runtime.createEntities>[0][number],
  ]);

  await runtime.createRoomParticipants([USER_ENTITY_ID, AGENT_ID], ROOM_ID);

  return runtime;
}

// ─── Pre-populate history ───────────────────────────────────────────────────

async function prePopulateHistory(
  runtime: AgentRuntime,
  count: number,
): Promise<void> {
  const _adapter = runtime.adapter;
  const baseTime = Date.now() - count * 1000; // Space out by 1 second each

  for (let i = 0; i < count; i++) {
    const memory: Memory = {
      id: `00000000-0000-0000-1000-${String(i).padStart(12, "0")}` as UUID,
      agentId: AGENT_ID,
      entityId: USER_ENTITY_ID,
      roomId: ROOM_ID,
      content: {
        text: `Historical message number ${i + 1} for benchmark testing.`,
        source: "benchmark",
      },
      createdAt: baseTime + i * 1000,
    };
    await runtime.createMemory(memory, "messages");
  }
}

// ─── Message creation ───────────────────────────────────────────────────────

function createMessage(text: string, index: number): Memory {
  return {
    id: `00000000-0000-0000-2000-${String(index).padStart(12, "0")}` as UUID,
    agentId: AGENT_ID,
    entityId: USER_ENTITY_ID,
    roomId: ROOM_ID,
    content: {
      text,
      source: "benchmark",
    } as Content,
    createdAt: Date.now(),
  };
}

// ─── Pipeline instrumentation via method wrapping ───────────────────────────

interface LegacyEvaluateRuntime {
  evaluate: (...args: unknown[]) => unknown | Promise<unknown>;
}

type LegacyEvaluate = LegacyEvaluateRuntime["evaluate"];

function getLegacyEvaluate(runtime: AgentRuntime): LegacyEvaluate | null {
  const evaluate = Reflect.get(runtime, "evaluate");
  if (typeof evaluate !== "function") return null;

  return (...args: unknown[]) => Reflect.apply(evaluate, runtime, args);
}

function setLegacyEvaluate(
  runtime: AgentRuntime,
  evaluate: LegacyEvaluate,
): void {
  Reflect.set(runtime, "evaluate", evaluate);
}

/**
 * Wrap key runtime methods with timing instrumentation.
 * This gives us real per-stage pipeline breakdown instead of just total time.
 * The wrapping is applied once per runtime instance.
 */
function instrumentRuntime(
  runtime: AgentRuntime,
  pipelineTimer: PipelineTimer,
): void {
  // Wrap composeState
  const origComposeState = runtime.composeState.bind(runtime);
  runtime.composeState = (async (
    ...args: Parameters<typeof runtime.composeState>
  ) => {
    const start = performance.now();
    const result = await origComposeState(...args);
    pipelineTimer.record("compose_state", performance.now() - start);
    return result;
  }) as typeof runtime.composeState;

  // Wrap useModel
  const origUseModel = runtime.useModel.bind(runtime);
  runtime.useModel = (async (...args: Parameters<typeof runtime.useModel>) => {
    const start = performance.now();
    const result = await origUseModel(...args);
    pipelineTimer.record("model_call", performance.now() - start);
    return result;
  }) as typeof runtime.useModel;

  // Wrap evaluate because the previous Evaluator plugin component was removed; older
  // runtimes still expose runtime.evaluate, newer ones do not — skip if absent).
  const origEvaluate = getLegacyEvaluate(runtime);
  if (origEvaluate) {
    setLegacyEvaluate(runtime, async (...args: unknown[]) => {
      const start = performance.now();
      const result = await origEvaluate(...args);
      pipelineTimer.record("evaluator", performance.now() - start);
      return result;
    });
  }

  // Wrap runtime.createMemory. The current database adapter is batch-first;
  // runtime.createMemory is the supported single-message write path.
  const origCreateMemory = runtime.createMemory.bind(runtime);
  runtime.createMemory = (async (
    ...args: Parameters<typeof runtime.createMemory>
  ) => {
    const start = performance.now();
    const result = await origCreateMemory(...args);
    pipelineTimer.record("memory_create", performance.now() - start);
    return result;
  }) as typeof runtime.createMemory;

  const adapter = runtime.adapter;
  if (adapter && "getMemories" in adapter) {
    const origGet = adapter.getMemories.bind(adapter);
    adapter.getMemories = (async (
      ...args: Parameters<typeof adapter.getMemories>
    ) => {
      const start = performance.now();
      const result = await origGet(...args);
      pipelineTimer.record("memory_get", performance.now() - start);
      return result;
    }) as typeof adapter.getMemories;
  }
}

// ─── Instrumented message handling ──────────────────────────────────────────

async function processMessage(
  runtime: AgentRuntime,
  message: Memory,
  _pipelineTimer: PipelineTimer,
): Promise<void> {
  const messageService = runtime.messageService;
  if (!messageService || !("handleMessage" in messageService)) {
    throw new Error("Message service not found on runtime");
  }

  await messageService.handleMessage(
    runtime,
    message,
    async (_content: Content) => {
      // No-op callback — we don't need to send responses anywhere
      return [];
    },
  );
}

// ─── Scenario runners ───────────────────────────────────────────────────────

async function runStartupBenchmark(
  character: Character,
  config: ScenarioConfig,
  llmPlugins: Plugin[] = [mockLlmPlugin],
): Promise<ScenarioResult> {
  const timings: number[] = [];
  const memMonitor = new MemoryMonitor();
  memMonitor.start();

  for (let i = 0; i < config.iterations; i++) {
    const timer = new Timer();
    timer.start();
    const rt = await createBenchmarkRuntime(character, [], config, llmPlugins);
    const elapsed = timer.stop();
    timings.push(elapsed);

    // Releases benchmark runtime resources
    if (rt.adapter && "close" in rt.adapter) {
      await (rt.adapter as { close: () => Promise<void> }).close();
    }
  }

  const resources = memMonitor.stop();
  return {
    iterations: config.iterations,
    warmup: 0,
    latency: computeLatencyStats(timings),
    throughput: computeThroughputStats(
      config.iterations,
      timings.reduce((a, b) => a + b, 0),
    ),
    pipeline: {
      compose_state_avg_ms: 0,
      provider_execution_avg_ms: 0,
      should_respond_avg_ms: 0,
      model_call_avg_ms: 0,
      action_dispatch_avg_ms: 0,
      evaluator_avg_ms: 0,
      memory_create_avg_ms: 0,
      memory_get_avg_ms: 0,
      model_time_total_ms: 0,
      framework_time_total_ms: 0,
    },
    resources,
  };
}

async function runDbBenchmark(
  character: Character,
  config: ScenarioConfig,
  llmPlugins: Plugin[] = [mockLlmPlugin],
): Promise<ScenarioResult> {
  const timings: number[] = [];
  const memMonitor = new MemoryMonitor();
  const count = config.dbCount ?? 10000;

  for (let i = 0; i < config.iterations; i++) {
    const runtime = await createBenchmarkRuntime(
      character,
      [],
      config,
      llmPlugins,
    );
    const adapter = runtime.adapter;

    if (config.dbOperation === "write") {
      memMonitor.start();
      const timer = new Timer();
      timer.start();

      for (let j = 0; j < count; j++) {
        const memory: Memory = {
          id: `00000000-0000-0000-3000-${String(j).padStart(12, "0")}` as UUID,
          agentId: AGENT_ID,
          entityId: USER_ENTITY_ID,
          roomId: ROOM_ID,
          content: {
            text: `Write benchmark message ${j}`,
            source: "benchmark",
          },
          createdAt: Date.now(),
        };
        await runtime.createMemory(memory, "messages");
      }

      timings.push(timer.stop());
    } else {
      // Pre-populate for read test
      await prePopulateHistory(runtime, count);

      memMonitor.start();
      const timer = new Timer();
      timer.start();

      for (let j = 0; j < count; j++) {
        await adapter.getMemories({
          tableName: "messages",
          roomId: ROOM_ID,
          count: 1,
          offset: j,
        });
      }

      timings.push(timer.stop());
    }

    if (adapter && "close" in adapter) {
      await (adapter as { close: () => Promise<void> }).close();
    }
  }

  const resources = memMonitor.stop();
  const totalTime = timings.reduce((a, b) => a + b, 0);

  return {
    iterations: config.iterations,
    warmup: config.warmup,
    latency: computeLatencyStats(timings),
    throughput: computeThroughputStats(count * config.iterations, totalTime),
    pipeline: {
      compose_state_avg_ms: 0,
      provider_execution_avg_ms: 0,
      should_respond_avg_ms: 0,
      model_call_avg_ms: 0,
      action_dispatch_avg_ms: 0,
      evaluator_avg_ms: 0,
      memory_create_avg_ms:
        config.dbOperation === "write"
          ? totalTime / (count * config.iterations)
          : 0,
      memory_get_avg_ms:
        config.dbOperation === "read"
          ? totalTime / (count * config.iterations)
          : 0,
      model_time_total_ms: 0,
      framework_time_total_ms: 0,
    },
    resources,
  };
}

async function runMessageBenchmark(
  character: Character,
  messages: ScenarioMessage[],
  config: ScenarioConfig,
  llmPlugins: Plugin[] = [mockLlmPlugin],
): Promise<ScenarioResult> {
  const allTimings: number[] = [];
  const pipelineTimer = new PipelineTimer();
  const memMonitor = new MemoryMonitor();

  // Warm-up
  for (let w = 0; w < config.warmup; w++) {
    const runtime = await createBenchmarkRuntime(
      character,
      [],
      config,
      llmPlugins,
    );
    instrumentRuntime(runtime, new PipelineTimer()); // warmup instrumentation discarded
    if (config.prePopulateHistory) {
      await prePopulateHistory(runtime, config.prePopulateHistory);
    }
    for (let m = 0; m < messages.length; m++) {
      const msg = createMessage(messages[m].content, m);
      await processMessage(runtime, msg, pipelineTimer);
    }
    if (runtime.adapter && "close" in runtime.adapter) {
      await (runtime.adapter as { close: () => Promise<void> }).close();
    }
  }

  // Force GC if available
  if (typeof globalThis.gc === "function") {
    globalThis.gc();
  }

  memMonitor.start();

  for (let i = 0; i < config.iterations; i++) {
    const runtime = await createBenchmarkRuntime(
      character,
      [],
      config,
      llmPlugins,
    );
    instrumentRuntime(runtime, pipelineTimer); // real instrumentation recorded
    if (config.prePopulateHistory) {
      await prePopulateHistory(runtime, config.prePopulateHistory);
    }

    const iterTimer = new Timer();
    iterTimer.start();

    if (config.concurrent && messages.length > 1) {
      // Run all messages concurrently
      await Promise.all(
        messages.map((msg, m) => {
          const mem = createMessage(msg.content, m);
          return processMessage(runtime, mem, pipelineTimer);
        }),
      );
    } else {
      // Run messages sequentially
      for (let m = 0; m < messages.length; m++) {
        const msg = createMessage(messages[m].content, m + i * messages.length);
        await processMessage(runtime, msg, pipelineTimer);
      }
    }

    allTimings.push(iterTimer.stop());

    if (runtime.adapter && "close" in runtime.adapter) {
      await (runtime.adapter as { close: () => Promise<void> }).close();
    }
  }

  const resources = memMonitor.stop();
  const totalTime = allTimings.reduce((a, b) => a + b, 0);
  const totalMessages = messages.length * config.iterations;

  const pipeline = pipelineTimer.getBreakdown();
  // Compute framework time as wall-clock total minus model time
  pipeline.framework_time_total_ms = totalTime - pipeline.model_time_total_ms;

  return {
    iterations: config.iterations,
    warmup: config.warmup,
    latency: computeLatencyStats(allTimings),
    throughput: computeThroughputStats(totalMessages, totalTime),
    pipeline,
    resources,
  };
}

// ─── Run-count overrides ────────────────────────────────────────────────────

/** Parse `--flag=N` as a positive integer, or null when absent/invalid. */
function parsePositiveIntFlag(args: string[], flag: string): number | null {
  const raw = args.find((a) => a.startsWith(flag))?.slice(flag.length);
  if (raw === undefined) return null;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** Parse `--flag=N` as a non-negative integer, or null when absent/invalid. */
function parseNonNegativeIntFlag(args: string[], flag: string): number | null {
  const raw = args.find((a) => a.startsWith(flag))?.slice(flag.length);
  if (raw === undefined) return null;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

/**
 * Clamp a scenario's iteration + warmup counts to the CLI overrides. Used to run
 * exactly one real model turn (`--iterations=1 --warmup=0`) during live-LLM
 * trajectory harvesting instead of the 50×5 perf default.
 */
function applyRunCountOverrides(
  config: ScenarioConfig,
  iterationsOverride: number | null,
  warmupOverride: number | null,
): ScenarioConfig {
  if (iterationsOverride === null && warmupOverride === null) return config;
  return {
    ...config,
    iterations: iterationsOverride ?? config.iterations,
    warmup: warmupOverride ?? config.warmup,
  };
}

// ─── Main orchestrator ──────────────────────────────────────────────────────

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.includes("--count-scenarios")) {
    console.log(JSON.stringify(countScenarios(), null, 2));
    return;
  }
  if (args.includes("--validate-scenarios")) {
    const validation = validateScenarios();
    console.log(JSON.stringify(validation, null, 2));
    if (!validation.valid) process.exitCode = 1;
    return;
  }

  const scenarioFilter = args.find((a) => a.startsWith("--scenarios="));
  const runAll = args.includes("--all");
  const useRealLlm = args.includes("--real-llm");
  const outputPath = args.find((a) => a.startsWith("--output="))?.split("=")[1];

  // --iterations=N / --warmup=N clamp each scenario's iteration + warmup count.
  // The default perf configs run 50 iterations × 5 warmups — sensible for mock
  // overhead measurement, but far too many real model calls for a live-LLM
  // trajectory harvest. Clamping to `--iterations=1 --warmup=0` captures exactly
  // one real turn (one trajectory) per scenario at minimal subscription cost.
  const iterationsOverride = parsePositiveIntFlag(args, "--iterations=");
  const warmupOverride = parseNonNegativeIntFlag(args, "--warmup=");

  // Resolve which LLM plugin(s) to use
  const { llmPlugins, isRealLlm, providerLabel } =
    await resolveLlmPlugin(useRealLlm);

  const allScenarios = loadScenarios();
  const character = loadCharacter();

  let selectedScenarios: Scenario[];

  if (scenarioFilter) {
    const ids = scenarioFilter.split("=")[1].split(",");
    selectedScenarios = allScenarios.filter((s) => ids.includes(s.id));
  } else if (runAll) {
    selectedScenarios = allScenarios;
  } else {
    // Default: run key scenarios
    const defaultIds = [
      "single-message",
      "conversation-10",
      "burst-100",
      "with-should-respond",
      "provider-scaling-10",
      "provider-scaling-50",
      "history-scaling-100",
      "history-scaling-1000",
      "concurrent-10",
      "db-write-throughput",
      "db-read-throughput",
      "startup-cold",
    ];
    selectedScenarios = allScenarios.filter((s) => defaultIds.includes(s.id));
  }

  console.log("╔══════════════════════════════════════════════════════════╗");
  console.log("║         Eliza Framework Benchmark — TypeScript          ║");
  console.log("╚══════════════════════════════════════════════════════════╝");
  console.log();

  if (isRealLlm) {
    console.log("NOTE: Using real LLM. Results will include network latency");
    console.log(
      "      and are not suitable for framework overhead measurement.",
    );
    console.log();
  }

  const sysInfo = getSystemInfo();
  console.log(
    `System: ${sysInfo.os} ${sysInfo.arch} | ${sysInfo.cpus} CPUs | ${sysInfo.memory_gb}GB RAM`,
  );
  console.log(`Runtime: ${sysInfo.runtime_version}`);
  console.log(`LLM Mode: ${providerLabel}`);
  console.log(`Scenarios: ${selectedScenarios.length} selected`);
  console.log();

  const results: BenchmarkResult = {
    runtime: "typescript",
    timestamp: new Date().toISOString(),
    system: sysInfo,
    scenarios: {},
  };

  for (const scenario of selectedScenarios) {
    process.stdout.write(`Running: ${scenario.name}...`);
    const startTime = performance.now();

    const config = applyRunCountOverrides(
      scenario.config,
      iterationsOverride,
      warmupOverride,
    );

    let scenarioResult: ScenarioResult;

    if (config.startupOnly) {
      scenarioResult = await runStartupBenchmark(character, config, llmPlugins);
    } else if (config.dbOnly) {
      scenarioResult = await runDbBenchmark(character, config, llmPlugins);
    } else {
      const messages = resolveMessages(scenario.messages);
      scenarioResult = await runMessageBenchmark(
        character,
        messages,
        config,
        llmPlugins,
      );
    }

    const totalElapsed = performance.now() - startTime;
    console.log(` done (${formatDuration(totalElapsed)})`);
    printScenarioResult(scenario.id, scenarioResult, isRealLlm);

    results.scenarios[scenario.id] = scenarioResult;
  }

  // Try to get binary/bundle size
  try {
    const corePkg = resolve(
      __dirname,
      "../../../../core/dist/node/index.node.js",
    );
    const stat = statSync(corePkg);
    results.binary_size_bytes = stat.size;
    console.log(`\nBundle size: ${(stat.size / 1024).toFixed(1)}KB`);
  } catch {
    // Not built yet, skip
  }

  // Write results
  const outPath =
    outputPath ?? resolve(RESULTS_DIR, `typescript-${Date.now()}.json`);
  writeFileSync(outPath, JSON.stringify(results, null, 2));
  console.log(`\nResults written to: ${outPath}`);
}

main()
  .then(() => {
    process.exit(0);
  })
  .catch((err) => {
    console.error("Benchmark failed:", err);
    process.exit(1);
  });
