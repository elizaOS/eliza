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
import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  AgentRuntime,
  ChannelType as ChannelTypes,
  type Character,
  type Content,
  ElizaError,
  type Memory,
  type Plugin,
  type UUID,
} from "@elizaos/core";
import { createAssistantPlugin } from "@elizaos/plugin-assistant";
import { SQLiteDatabaseAdapter } from "@elizaos/testing/runtime";
import { testOutputPath } from "../../../../scripts/lib/test-output.ts";
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

interface ResolvedLlm {
  llmPlugins: Plugin[];
  isRealLlm: boolean;
  providerLabel: string;
}

/** Resolve deterministic conformance or an explicitly configured API provider. */
async function resolveLlmPlugin(useRealLlm: boolean): Promise<ResolvedLlm> {
  if (!useRealLlm) {
    return {
      llmPlugins: [mockLlmPlugin],
      isRealLlm: false,
      providerLabel: "mock (deterministic)",
    };
  }

  if (process.env.ELIZA_CHAT_VIA_CLI?.trim()) {
    throw new ElizaError(
      "The CLI inference plugin was retired. Use OPENAI_API_KEY or CEREBRAS_API_KEY for this harness, or the orchestrator subscription gateway.",
      { code: "BENCHMARK_PROVIDER_RETIRED" },
    );
  }

  const hasOpenAi = !!process.env.OPENAI_API_KEY;
  const hasCerebras = !!process.env.CEREBRAS_API_KEY;

  if (!hasOpenAi && !hasCerebras) {
    console.error(
      "ERROR: --real-llm requires OPENAI_API_KEY or CEREBRAS_API_KEY to be set.",
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
const RESULTS_DIR =
  process.env.BENCHMARK_OUTPUT_ROOT || testOutputPath("benchmark-framework");

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

// Keep service shutdown and database ownership on the runtime, including failures.
async function closeBenchmarkRuntime(
  runtime: AgentRuntime,
  operationFailures: unknown[] = [],
): Promise<void> {
  const cleanupFailures: unknown[] = [];
  try {
    await runtime.stop();
  } catch (error) {
    cleanupFailures.push(error);
  }
  try {
    await runtime.close();
  } catch (error) {
    cleanupFailures.push(error);
  }
  if (cleanupFailures.length) {
    throw new AggregateError(
      [...operationFailures, ...cleanupFailures],
      "Benchmark runtime teardown failed",
    );
  }
}

async function createBenchmarkRuntime(
  character: Character,
  extraPlugins: Plugin[] = [],
  config: ScenarioConfig = { warmup: 0, iterations: 1 },
  llmPlugins: Plugin[] = [mockLlmPlugin],
): Promise<AgentRuntime> {
  const adapter = SQLiteDatabaseAdapter.create(":memory:", AGENT_ID);

  const plugins: Plugin[] = [
    createAssistantPlugin(),
    ...llmPlugins,
    ...extraPlugins,
  ];

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
  });

  try {
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
  } catch (error) {
    await closeBenchmarkRuntime(runtime, [error]);
    throw error;
  }

  return runtime;
}

// ─── Pre-populate history ───────────────────────────────────────────────────

async function prePopulateHistory(
  runtime: AgentRuntime,
  count: number,
): Promise<void> {
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
    try {
      return await origComposeState(...args);
    } finally {
      pipelineTimer.recordInterval("compose_state", start, performance.now());
    }
  }) as typeof runtime.composeState;

  // Wrap useModel
  const origUseModel = runtime.useModel.bind(runtime);
  runtime.useModel = (async (...args: Parameters<typeof runtime.useModel>) => {
    const start = performance.now();
    try {
      return await origUseModel(...args);
    } finally {
      pipelineTimer.recordInterval("model_call", start, performance.now());
    }
  }) as typeof runtime.useModel;

  // Wrap runtime.createMemory. The current database adapter is batch-first;
  // runtime.createMemory is the supported single-message write path.
  const origCreateMemory = runtime.createMemory.bind(runtime);
  runtime.createMemory = (async (
    ...args: Parameters<typeof runtime.createMemory>
  ) => {
    const start = performance.now();
    try {
      return await origCreateMemory(...args);
    } finally {
      pipelineTimer.recordInterval("memory_create", start, performance.now());
    }
  }) as typeof runtime.createMemory;

  const adapter = runtime.adapter;
  if (adapter && "getMemories" in adapter) {
    const origGet = adapter.getMemories.bind(adapter);
    adapter.getMemories = (async (
      ...args: Parameters<typeof adapter.getMemories>
    ) => {
      const start = performance.now();
      try {
        return await origGet(...args);
      } finally {
        pipelineTimer.recordInterval("memory_get", start, performance.now());
      }
    }) as typeof adapter.getMemories;
  }
}

// ─── Instrumented message handling ──────────────────────────────────────────

async function processMessage(
  runtime: AgentRuntime,
  message: Memory,
): Promise<void> {
  const messageService = runtime.messageService;
  if (!messageService || !("handleMessage" in messageService)) {
    throw new Error("Message service not found on runtime");
  }

  const result = await messageService.handleMessage(
    runtime,
    message,
    async (_content: Content) => {
      // No-op callback — we don't need to send responses anywhere
      return [];
    },
  );
  if (
    result.outcome.status === "failed" ||
    result.outcome.status === "cancelled"
  ) {
    throw new ElizaError("Benchmark native turn failed", {
      code: "BENCHMARK_TURN_FAILED",
      context: { outcome: result.outcome },
    });
  }
}

// ─── Scenario runners ───────────────────────────────────────────────────────

async function runStartupBenchmark(
  character: Character,
  config: ScenarioConfig,
  llmPlugins: Plugin[] = [mockLlmPlugin],
): Promise<ScenarioResult> {
  const timings: number[] = [];
  const memMonitor = new MemoryMonitor();
  try {
    memMonitor.start();

    for (let i = 0; i < config.iterations; i++) {
      const timer = new Timer();
      timer.start();
      const rt = await createBenchmarkRuntime(
        character,
        [],
        config,
        llmPlugins,
      );
      const operationFailures: unknown[] = [];
      try {
        const elapsed = timer.stop();
        timings.push(elapsed);
      } catch (error) {
        operationFailures.push(error);
        throw error;
      } finally {
        await closeBenchmarkRuntime(rt, operationFailures);
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
        provider_execution_avg_ms: null,
        should_respond_avg_ms: null,
        model_call_avg_ms: 0,
        action_dispatch_avg_ms: null,
        evaluator_avg_ms: null,
        memory_create_avg_ms: 0,
        memory_get_avg_ms: 0,
        model_time_total_ms: 0,
        framework_time_total_ms: 0,
      },
      resources,
    };
  } finally {
    memMonitor.stop();
  }
}

async function runDbBenchmark(
  character: Character,
  config: ScenarioConfig,
  llmPlugins: Plugin[] = [mockLlmPlugin],
): Promise<ScenarioResult> {
  const timings: number[] = [];
  const memMonitor = new MemoryMonitor();
  try {
    const count = config.dbCount ?? 10000;

    for (let i = 0; i < config.iterations; i++) {
      const runtime = await createBenchmarkRuntime(
        character,
        [],
        config,
        llmPlugins,
      );
      const operationFailures: unknown[] = [];
      try {
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
      } catch (error) {
        operationFailures.push(error);
        throw error;
      } finally {
        await closeBenchmarkRuntime(runtime, operationFailures);
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
        provider_execution_avg_ms: null,
        should_respond_avg_ms: null,
        model_call_avg_ms: 0,
        action_dispatch_avg_ms: null,
        evaluator_avg_ms: null,
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
  } finally {
    memMonitor.stop();
  }
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
  try {
    // Warm-up
    for (let w = 0; w < config.warmup; w++) {
      const runtime = await createBenchmarkRuntime(
        character,
        [],
        config,
        llmPlugins,
      );
      const operationFailures: unknown[] = [];
      try {
        if (config.prePopulateHistory) {
          await prePopulateHistory(runtime, config.prePopulateHistory);
        }
        for (let m = 0; m < messages.length; m++) {
          const msg = createMessage(messages[m].content, m);
          await processMessage(runtime, msg);
        }
      } catch (error) {
        operationFailures.push(error);
        throw error;
      } finally {
        await closeBenchmarkRuntime(runtime, operationFailures);
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
      const operationFailures: unknown[] = [];
      try {
        if (config.prePopulateHistory) {
          await prePopulateHistory(runtime, config.prePopulateHistory);
        }

        instrumentRuntime(runtime, pipelineTimer);
        const iterTimer = new Timer();
        iterTimer.start();

        if (config.concurrent && messages.length > 1) {
          // Run all messages concurrently
          const turns = await Promise.allSettled(
            messages.map((msg, m) => {
              const mem = createMessage(msg.content, m);
              return processMessage(runtime, mem);
            }),
          );
          const failures = turns.filter((turn) => turn.status === "rejected");
          if (failures.length)
            throw new AggregateError(
              failures.map((turn) => turn.reason),
              "Concurrent benchmark turns failed",
            );
        } else {
          // Run messages sequentially
          for (let m = 0; m < messages.length; m++) {
            const msg = createMessage(
              messages[m].content,
              m + i * messages.length,
            );
            await processMessage(runtime, msg);
          }
        }

        allTimings.push(iterTimer.stop());
      } catch (error) {
        operationFailures.push(error);
        throw error;
      } finally {
        await closeBenchmarkRuntime(runtime, operationFailures);
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
  } finally {
    memMonitor.stop();
  }
}

// ─── Run-count overrides ────────────────────────────────────────────────────

/** Parse `--flag=N` as a positive integer, or null when absent/invalid. */
function parsePositiveIntFlag(args: string[], flag: string): number | null {
  const raw = args.find((a) => a.startsWith(flag))?.slice(flag.length);
  if (raw === undefined) return null;
  const n = Number(raw);
  if (!/^\d+$/.test(raw) || !Number.isSafeInteger(n) || n <= 0)
    throw new Error(`Invalid ${flag}${raw}`);
  return n;
}

/** Parse `--flag=N` as a non-negative integer, or null when absent/invalid. */
function parseNonNegativeIntFlag(args: string[], flag: string): number | null {
  const raw = args.find((a) => a.startsWith(flag))?.slice(flag.length);
  if (raw === undefined) return null;
  const n = Number(raw);
  if (!/^\d+$/.test(raw) || !Number.isSafeInteger(n) || n < 0)
    throw new Error(`Invalid ${flag}${raw}`);
  return n;
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
  for (const arg of args) {
    if (
      ![
        "--all",
        "--real-llm",
        "--count-scenarios",
        "--validate-scenarios",
      ].includes(arg) &&
      !["--scenarios=", "--output=", "--iterations=", "--warmup="].some(
        (prefix) => arg.startsWith(prefix),
      )
    ) {
      throw new Error(`Unknown benchmark argument: ${arg}`);
    }
  }
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
  const outputPath = args
    .find((a) => a.startsWith("--output="))
    ?.slice("--output=".length);

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
    const unknown = ids.filter(
      (id) => !allScenarios.some((scenario) => scenario.id === id),
    );
    if (unknown.length)
      throw new Error(`Unknown benchmark scenarios: ${unknown.join(", ")}`);
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
  mkdirSync(dirname(outPath), { recursive: true });
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
