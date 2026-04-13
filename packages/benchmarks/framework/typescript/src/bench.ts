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
import { readFileSync, writeFileSync, statSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
// Direct source imports — Bun transpiles TS at runtime, no build step needed
import { AgentRuntime } from "../../../../packages/typescript/src/runtime";
import { InMemoryDatabaseAdapter } from "../../../../packages/typescript/src/database/inMemoryAdapter";
import type { Plugin } from "../../../../packages/typescript/src/types/plugin";
import type { Memory } from "../../../../packages/typescript/src/types/memory";
import type { UUID, Content } from "../../../../packages/typescript/src/types/primitives";
import type { Character } from "../../../../packages/typescript/src/types/agent";
import { mockLlmPlugin, createDummyProviders } from "./mock-llm-plugin.js";
import {
  Timer,
  MemoryMonitor,
  PipelineTimer,
  computeLatencyStats,
  computeThroughputStats,
  getSystemInfo,
  formatDuration,
  printScenarioResult,
  type BenchmarkResult,
  type ScenarioResult,
} from "./metrics.js";

// ─── Real LLM support ───────────────────────────────────────────────────────

/**
 * Dynamically load the OpenAI plugin for real-LLM mode.
 * Isolated in a function so the import only happens when --real-llm is used.
 */
async function loadOpenAIPlugin(): Promise<Plugin> {
  const mod = await import(
    "../../../../plugins/plugin-openai/typescript/index.js"
  ) as { openaiPlugin: Plugin; default: Plugin };
  return mod.openaiPlugin ?? mod.default;
}

/**
 * Resolve which LLM plugin to use based on the --real-llm flag.
 * Returns the plugin and a boolean indicating real-LLM mode.
 */
async function resolveLlmPlugin(useRealLlm: boolean): Promise<{ llmPlugin: Plugin; isRealLlm: boolean }> {
  if (!useRealLlm) {
    return { llmPlugin: mockLlmPlugin, isRealLlm: false };
  }

  if (!process.env.OPENAI_API_KEY) {
    console.error(
      "ERROR: --real-llm requires OPENAI_API_KEY to be set in the environment.",
    );
    process.exit(1);
  }

  const plugin = await loadOpenAIPlugin();
  return { llmPlugin: plugin, isRealLlm: true };
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

function loadScenarios(): Scenario[] {
  const raw = readFileSync(resolve(SHARED_DIR, "scenarios.json"), "utf-8");
  return JSON.parse(raw).scenarios;
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
function resolveMessages(messages: ScenarioMessage[] | string): ScenarioMessage[] {
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
  llmPlugin: Plugin = mockLlmPlugin,
): Promise<AgentRuntime> {
  const adapter = new InMemoryDatabaseAdapter();

  const plugins: Plugin[] = [llmPlugin, ...extraPlugins];

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
  await adapter.createWorld({
    id: WORLD_ID,
    name: "BenchmarkWorld",
    agentId: AGENT_ID,
    messageServerId: "benchmark",
  });

  await adapter.createRoom({
    id: ROOM_ID,
    name: "BenchmarkRoom",
    agentId: AGENT_ID,
    source: "benchmark",
    type: "GROUP",
    worldId: WORLD_ID,
  } as Parameters<typeof adapter.createRoom>[0]);

  await adapter.createEntities([
    {
      id: AGENT_ID,
      names: ["BenchmarkAgent"],
      agentId: AGENT_ID,
    } as Parameters<typeof adapter.createEntities>[0][number],
    {
      id: USER_ENTITY_ID,
      names: ["BenchmarkUser"],
      agentId: AGENT_ID,
    } as Parameters<typeof adapter.createEntities>[0][number],
  ]);

  await adapter.addParticipantsRoom([USER_ENTITY_ID, AGENT_ID], ROOM_ID);

  return runtime;
}

// ─── Pre-populate history ───────────────────────────────────────────────────

async function prePopulateHistory(
  runtime: AgentRuntime,
  count: number,
): Promise<void> {
  const adapter = runtime.adapter;
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
    await adapter.createMemory(memory, "messages");
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
function instrumentRuntime(runtime: AgentRuntime, pipelineTimer: PipelineTimer): void {
  // Wrap composeState
  const origComposeState = runtime.composeState.bind(runtime);
  (runtime as Record<string, Function>).composeState = async (...args: unknown[]) => {
    const start = performance.now();
    const result = await origComposeState(...args);
    pipelineTimer.record("compose_state", performance.now() - start);
    return result;
  };

  // Wrap useModel
  const origUseModel = runtime.useModel.bind(runtime);
  (runtime as Record<string, Function>).useModel = async (...args: unknown[]) => {
    const start = performance.now();
    const result = await origUseModel(...args);
    pipelineTimer.record("model_call", performance.now() - start);
    return result;
  };

  // Wrap processActions
  const origProcessActions = runtime.processActions.bind(runtime);
  (runtime as Record<string, Function>).processActions = async (...args: unknown[]) => {
    const start = performance.now();
    const result = await origProcessActions(...args);
    pipelineTimer.record("action_dispatch", performance.now() - start);
    return result;
  };

  // Wrap evaluate
  const origEvaluate = runtime.evaluate.bind(runtime);
  (runtime as Record<string, Function>).evaluate = async (...args: unknown[]) => {
    const start = performance.now();
    const result = await origEvaluate(...args);
    pipelineTimer.record("evaluator", performance.now() - start);
    return result;
  };

  // Wrap adapter.createMemory
  const adapter = runtime.adapter;
  if (adapter && "createMemory" in adapter) {
    const origCreate = adapter.createMemory.bind(adapter);
    (adapter as Record<string, Function>).createMemory = async (...args: unknown[]) => {
      const start = performance.now();
      const result = await origCreate(...args);
      pipelineTimer.record("memory_create", performance.now() - start);
      return result;
    };
  }

  // Wrap adapter.getMemories
  if (adapter && "getMemories" in adapter) {
    const origGet = adapter.getMemories.bind(adapter);
    (adapter as Record<string, Function>).getMemories = async (...args: unknown[]) => {
      const start = performance.now();
      const result = await origGet(...args);
      pipelineTimer.record("memory_get", performance.now() - start);
      return result;
    };
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
  llmPlugin: Plugin = mockLlmPlugin,
): Promise<ScenarioResult> {
  const timings: number[] = [];
  const memMonitor = new MemoryMonitor();
  memMonitor.start();

  for (let i = 0; i < config.iterations; i++) {
    const timer = new Timer();
    timer.start();
    const rt = await createBenchmarkRuntime(character, [], config, llmPlugin);
    const elapsed = timer.stop();
    timings.push(elapsed);

    // Clean up
    if (rt.adapter && "close" in rt.adapter) {
      await (rt.adapter as { close: () => Promise<void> }).close();
    }
  }

  const resources = memMonitor.stop();
  return {
    iterations: config.iterations,
    warmup: 0,
    latency: computeLatencyStats(timings),
    throughput: computeThroughputStats(config.iterations, timings.reduce((a, b) => a + b, 0)),
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
  llmPlugin: Plugin = mockLlmPlugin,
): Promise<ScenarioResult> {
  const timings: number[] = [];
  const memMonitor = new MemoryMonitor();
  const count = config.dbCount ?? 10000;

  for (let i = 0; i < config.iterations; i++) {
    const runtime = await createBenchmarkRuntime(character, [], config, llmPlugin);
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
          content: { text: `Write benchmark message ${j}`, source: "benchmark" },
          createdAt: Date.now(),
        };
        await adapter.createMemory(memory, "messages");
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
      memory_create_avg_ms: config.dbOperation === "write" ? totalTime / (count * config.iterations) : 0,
      memory_get_avg_ms: config.dbOperation === "read" ? totalTime / (count * config.iterations) : 0,
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
  llmPlugin: Plugin = mockLlmPlugin,
): Promise<ScenarioResult> {
  const allTimings: number[] = [];
  const pipelineTimer = new PipelineTimer();
  const memMonitor = new MemoryMonitor();

  // Warm-up
  for (let w = 0; w < config.warmup; w++) {
    const runtime = await createBenchmarkRuntime(character, [], config, llmPlugin);
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
    const runtime = await createBenchmarkRuntime(character, [], config, llmPlugin);
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

// ─── Main orchestrator ──────────────────────────────────────────────────────

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const scenarioFilter = args.find((a) => a.startsWith("--scenarios="));
  const runAll = args.includes("--all");
  const useRealLlm = args.includes("--real-llm");
  const outputPath = args.find((a) => a.startsWith("--output="))?.split("=")[1];

  // Resolve which LLM plugin to use
  const { llmPlugin, isRealLlm } = await resolveLlmPlugin(useRealLlm);

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
    console.log("      and are not suitable for framework overhead measurement.");
    console.log();
  }

  const sysInfo = getSystemInfo();
  console.log(`System: ${sysInfo.os} ${sysInfo.arch} | ${sysInfo.cpus} CPUs | ${sysInfo.memory_gb}GB RAM`);
  console.log(`Runtime: ${sysInfo.runtime_version}`);
  console.log(`LLM Mode: ${isRealLlm ? "real (OpenAI)" : "mock (deterministic)"}`);
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

    let scenarioResult: ScenarioResult;

    if (scenario.config.startupOnly) {
      scenarioResult = await runStartupBenchmark(character, scenario.config, llmPlugin);
    } else if (scenario.config.dbOnly) {
      scenarioResult = await runDbBenchmark(character, scenario.config, llmPlugin);
    } else {
      const messages = resolveMessages(scenario.messages);
      scenarioResult = await runMessageBenchmark(character, messages, scenario.config, llmPlugin);
    }

    const totalElapsed = performance.now() - startTime;
    console.log(` done (${formatDuration(totalElapsed)})`);
    printScenarioResult(scenario.id, scenarioResult, isRealLlm);

    results.scenarios[scenario.id] = scenarioResult;
  }

  // Try to get binary/bundle size
  try {
    const corePkg = resolve(__dirname, "../../../packages/typescript/dist/node/index.node.js");
    const stat = statSync(corePkg);
    results.binary_size_bytes = stat.size;
    console.log(`\nBundle size: ${(stat.size / 1024).toFixed(1)}KB`);
  } catch {
    // Not built yet, skip
  }

  // Write results
  const outPath = outputPath ?? resolve(RESULTS_DIR, `typescript-${Date.now()}.json`);
  writeFileSync(outPath, JSON.stringify(results, null, 2));
  console.log(`\nResults written to: ${outPath}`);
}

main().then(() => {
  process.exit(0);
}).catch((err) => {
  console.error("Benchmark failed:", err);
  process.exit(1);
});
