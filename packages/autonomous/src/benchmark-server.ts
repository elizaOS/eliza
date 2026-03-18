import http from "node:http";
import path from "node:path";
import {
  AgentRuntime,
  ChannelType,
  type Content,
  elizaLogger,
  InMemoryDatabaseAdapter,
  type Memory,
  ModelType,
  type Plugin,
  stringToUuid,
  type UUID,
} from "@elizaos/core";
import dotenv from "dotenv";
import { createElizaPlugin } from "./runtime/eliza-plugin";

// Load environment variables BEFORE anything else
// This ensures API keys are available when plugins initialize
dotenv.config({ path: path.resolve(process.cwd(), ".env") });

const DEFAULT_PORT = 3939;
const BENCHMARK_WORLD_ID = stringToUuid("autonomous-benchmark-world");
const BENCHMARK_MESSAGE_SERVER_ID = stringToUuid(
  "autonomous-benchmark-message-server",
);

interface BenchmarkSession {
  benchmark: string;
  taskId: string;
  roomId: UUID;
  relayRoomId: UUID;
  userEntityId: UUID;
}

interface BenchmarkOutboxEntry {
  kind: "direct" | "room";
  targetId: string;
  text: string;
  source: string;
  ts: number;
}

interface BenchmarkTrajectoryStep {
  step: number;
  startedAt: number;
  finishedAt: number;
  inputText: string;
  promptText: string;
  context?: Record<string, unknown>;
  thought: string | null;
  responseText: string;
  actions: string[];
  params: Record<string, unknown>;
}

function formatUnknownError(error: unknown): string {
  if (error instanceof Error) {
    return `${error.name}: ${error.message}`;
  }
  return String(error);
}

function toPlugin(candidate: unknown, source: string): Plugin {
  if (!candidate || typeof candidate !== "object") {
    throw new Error(`Plugin from ${source} was not an object`);
  }

  const pluginLike = candidate as { name?: unknown };
  if (typeof pluginLike.name !== "string" || pluginLike.name.length === 0) {
    throw new Error(`Plugin from ${source} was missing a valid name`);
  }

  return candidate as Plugin;
}

function resolvePort(): number {
  const raw = process.env.AUTONOMOUS_BENCH_PORT;
  if (!raw) return DEFAULT_PORT;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 1 || parsed > 65535) {
    elizaLogger.warn(
      `[bench] Invalid AUTONOMOUS_BENCH_PORT="${raw}"; using ${DEFAULT_PORT}`,
    );
    return DEFAULT_PORT;
  }
  return Math.floor(parsed);
}

function extractRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  return value as Record<string, unknown>;
}

function extractTaskId(context: Record<string, unknown> | undefined): string {
  const bySnake = context?.task_id;
  if (typeof bySnake === "string" && bySnake.trim()) return bySnake.trim();
  const byCamel = context?.taskId;
  if (typeof byCamel === "string" && byCamel.trim()) return byCamel.trim();
  return "default-task";
}

function extractBenchmarkName(
  context: Record<string, unknown> | undefined,
): string {
  const benchmark = context?.benchmark;
  if (typeof benchmark === "string" && benchmark.trim()) {
    return benchmark.trim();
  }
  return "unknown";
}

function composeBenchmarkPrompt(params: {
  text: string;
  context?: Record<string, unknown>;
  image?: unknown;
  mode?: "message-service" | "direct-model";
}): string {
  const segments: string[] = [params.text.trim()];

  if (params.context && Object.keys(params.context).length > 0) {
    segments.push(
      [
        "BENCHMARK CONTEXT (authoritative):",
        JSON.stringify(params.context, null, 2),
      ].join("\n"),
    );
  }

  if (params.image !== undefined) {
    segments.push(
      ["IMAGE PAYLOAD:", JSON.stringify(params.image, null, 2)].join("\n"),
    );
  }

  if (params.mode === "message-service") {
    segments.push(
      "Respond using normal Eliza action output so actions/params can be executed and evaluated.",
    );
  } else {
    segments.push(
      "Reply directly to the benchmark prompt. If it asks for JSON, return JSON only with no extra narration.",
    );
  }

  return segments.join("\n\n");
}

function resolveBenchmarkMessageMode(): "message-service" | "direct-model" {
  const raw = process.env.AUTONOMOUS_BENCH_MESSAGE_MODE?.trim().toLowerCase();
  if (raw === "message-service") return "message-service";
  return "direct-model";
}

function coerceActions(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === "string");
}

function coerceParams(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }

  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      // ignore malformed param strings
    }
  }

  return {};
}

function sessionKey(session: BenchmarkSession): string {
  return `${session.benchmark}:${session.taskId}`;
}

async function ensureBenchmarkSessionContext(
  runtime: AgentRuntime,
  session: BenchmarkSession,
): Promise<void> {
  await runtime.ensureWorldExists({
    id: BENCHMARK_WORLD_ID,
    name: "Autonomous Benchmark World",
    agentId: runtime.agentId,
    messageServerId: BENCHMARK_MESSAGE_SERVER_ID,
    metadata: {
      type: "benchmark",
      description: "World used for benchmark sessions",
      extra: {
        benchmark: session.benchmark,
      },
    },
  });

  // Use ChannelType.API to ensure the agent always responds to benchmark messages
  // (API channel type bypasses shouldRespond evaluation)
  await runtime.ensureRoomExists({
    id: session.roomId,
    name: `benchmark:${session.taskId}`,
    source: "benchmark",
    type: ChannelType.API,
    channelId: `bench-${session.taskId}`,
    messageServerId: BENCHMARK_MESSAGE_SERVER_ID,
    worldId: BENCHMARK_WORLD_ID,
    metadata: {
      benchmark: session.benchmark,
      taskId: session.taskId,
    },
  });

  await runtime.ensureRoomExists({
    id: session.relayRoomId,
    name: "relay-room",
    source: "benchmark",
    type: ChannelType.API,
    channelId: `relay-${session.taskId}`,
    messageServerId: BENCHMARK_MESSAGE_SERVER_ID,
    worldId: BENCHMARK_WORLD_ID,
    metadata: {
      benchmark: session.benchmark,
      taskId: session.taskId,
      role: "relay-room",
    },
  });

  await runtime.ensureConnection({
    entityId: session.userEntityId,
    roomId: session.roomId,
    worldId: BENCHMARK_WORLD_ID,
    userName: "Benchmark User",
    source: "benchmark",
    channelId: `bench-${session.taskId}`,
    type: ChannelType.API,
    messageServerId: BENCHMARK_MESSAGE_SERVER_ID,
    metadata: {
      benchmark: session.benchmark,
      taskId: session.taskId,
      role: "benchmark-room",
    },
  });
  // The benchmark transport only needs the relay room to exist so room-targeted
  // emissions can be attributed back to the active session. In benchmark mode
  // some runtime/database combinations do not expose the agent entity through
  // getEntitiesByIds(), which makes an explicit ensureParticipantInRoom() call
  // fail even though the primary benchmark room is already fully connected via
  // ensureConnection() above.
}

function createSession(taskId: string, benchmark: string): BenchmarkSession {
  const normalizedTaskId = taskId.trim() || "default-task";
  const normalizedBenchmark = benchmark.trim() || "unknown";
  const seed = `${normalizedBenchmark}:${normalizedTaskId}:${Date.now()}:${Math.random()}`;

  return {
    benchmark: normalizedBenchmark,
    taskId: normalizedTaskId,
    roomId: stringToUuid(`benchmark-room:${seed}`),
    relayRoomId: stringToUuid(`benchmark-relay:${seed}`),
    userEntityId: stringToUuid(`benchmark-user:${seed}`),
  };
}

// Proper robust server implementation
export async function startBenchmarkServer() {
  const port = resolvePort();
  const messageMode = resolveBenchmarkMessageMode();
  elizaLogger.info(
    `[bench] Initializing autonomous benchmark runtime on port ${port} (message_mode=${messageMode})...`,
  );

  // Benchmark mode prefers a stable, comparable runtime over full production
  // plugin parity. A smaller allowlist avoids startup-only side effects from
  // plugins that are useful in the full app but unnecessary for benchmark I/O.
  const benchmarkCorePlugins = [
    "@elizaos/plugin-sql",
    "@elizaos/plugin-local-embedding",
    "@elizaos/plugin-secrets-manager",
    "@elizaos/plugin-rolodex",
    "@elizaos/plugin-trust",
    "@elizaos/plugin-todo",
    "@elizaos/plugin-experience",
  ] as const;

  const plugins: Plugin[] = [];
  const loadedPlugins: string[] = [];
  const failedPlugins: string[] = [];

  // Plugins to skip in benchmark context — these require external auth or
  // interfere with benchmark operation
  const skipPlugins = new Set([
    "@elizaos/plugin-elizacloud", // Requires ElizaOS cloud auth, conflicts with local LLM
    "@elizaos/plugin-trajectory-logger", // Bench server records trajectories itself
    "@elizaos/plugin-cron", // Scheduled services are noise in one-shot benchmark mode
    "@elizaos/plugin-agent-skills", // Expects skill-catalog services that benchmark mode does not wire up
  ]);

  for (const pluginName of benchmarkCorePlugins) {
    if (skipPlugins.has(pluginName)) {
      elizaLogger.debug(
        `[bench] Skipping plugin (benchmark mode): ${pluginName}`,
      );
      continue;
    }
    try {
      const pluginModule = await import(pluginName);
      const plugin =
        pluginModule.default ?? pluginModule[Object.keys(pluginModule)[0]];
      if (plugin) {
        plugins.push(toPlugin(plugin, pluginName));
        loadedPlugins.push(pluginName);
      }
    } catch (error: unknown) {
      // Some plugins may not be available in all environments — that's OK
      failedPlugins.push(pluginName);
      elizaLogger.debug(
        `[bench] Plugin not available: ${pluginName} (${formatUnknownError(error)})`,
      );
    }
  }

  elizaLogger.info(
    `[bench] Loaded ${loadedPlugins.length}/${benchmarkCorePlugins.length} benchmark plugins`,
  );
  if (failedPlugins.length > 0) {
    elizaLogger.debug(
      `[bench] Unavailable plugins: ${failedPlugins.join(", ")}`,
    );
  }

  // Load the autonomous orchestration plugin — provides workspace context,
  // session keys, autonomous state, custom actions, and lifecycle actions.
  try {
    const workspaceDir = process.env.AUTONOMOUS_WORKSPACE_DIR ?? process.cwd();
    const autonomousPlugin = createElizaPlugin({
      workspaceDir,
      agentId: "benchmark",
    });
    plugins.push(toPlugin(autonomousPlugin, "autonomous-plugin"));
    elizaLogger.info(
      `[bench] Loaded autonomous plugin with workspace: ${workspaceDir}`,
    );
  } catch (error: unknown) {
    elizaLogger.error(
      `[bench] Failed to load autonomous plugin: ${formatUnknownError(error)}`,
    );
  }

  // Load trust plugin — provides trust engine, security module, and permission system
  // (may already be in CORE_PLUGINS but we want to ensure it's loaded)
  if (!loadedPlugins.includes("@elizaos/plugin-trust")) {
    try {
      const { default: trustPlugin } = await import("@elizaos/plugin-trust");
      plugins.push(toPlugin(trustPlugin, "@elizaos/plugin-trust"));
      elizaLogger.info("[bench] Loaded plugin: @elizaos/plugin-trust");
    } catch (error: unknown) {
      elizaLogger.debug(
        `[bench] Trust plugin not available: ${formatUnknownError(error)}`,
      );
    }
  }

  // Load LLM provider plugins based on environment
  const groqApiKey = process.env.GROQ_API_KEY?.trim();
  if (groqApiKey) {
    process.env.GROQ_API_KEY = groqApiKey;
    try {
      const { default: groqPlugin } = await import("@elizaos/plugin-groq");
      plugins.push(toPlugin(groqPlugin, "@elizaos/plugin-groq"));
      elizaLogger.info("[bench] Loaded LLM plugin: @elizaos/plugin-groq");
    } catch (error: unknown) {
      elizaLogger.warn(
        `[bench] Groq plugin not available: ${formatUnknownError(error)}`,
      );
    }
  }

  // const rawOllamaBaseUrl =
  //   process.env.OLLAMA_BASE_URL?.trim() ??
  //   process.env.OLLAMA_API_ENDPOINT?.trim();
  // if (rawOllamaBaseUrl) {
  //   const normalizedOllamaBaseUrl = rawOllamaBaseUrl.replace(/\/api\/?$/, "");
  //   process.env.OLLAMA_BASE_URL = normalizedOllamaBaseUrl;
  //   process.env.OLLAMA_API_ENDPOINT =
  //     process.env.OLLAMA_API_ENDPOINT ??
  //     `${normalizedOllamaBaseUrl.replace(/\/$/, "")}/api`;
  //   try {
  //     const { default: ollamaPlugin } = await import("@elizaos/plugin-ollama");
  //     plugins.push(toPlugin(ollamaPlugin, "@elizaos/plugin-ollama"));
  //     elizaLogger.info("[bench] Loaded LLM plugin: @elizaos/plugin-ollama");
  //   } catch (error: unknown) {
  //     elizaLogger.warn(
  //       `[bench] Ollama plugin not available: ${formatUnknownError(error)}`,
  //     );
  //   }
  // }

  const openAiApiKey = process.env.OPENAI_API_KEY?.trim();
  if (
    openAiApiKey &&
    !openAiApiKey.startsWith("gsk_")
    // && !rawOllamaBaseUrl
  ) {
    process.env.OPENAI_API_KEY = openAiApiKey;
    try {
      const { default: openaiPlugin } = await import("@elizaos/plugin-openai");
      plugins.push(toPlugin(openaiPlugin, "@elizaos/plugin-openai"));
      elizaLogger.info("[bench] Loaded LLM plugin: @elizaos/plugin-openai");
    } catch (error: unknown) {
      elizaLogger.debug(
        `[bench] OpenAI plugin not available: ${formatUnknownError(error)}`,
      );
    }
  }

  // Load computer use plugin if enabled
  if (process.env.AUTONOMOUS_ENABLE_COMPUTERUSE) {
    try {
      process.env.COMPUTERUSE_ENABLED ??= "true";
      process.env.COMPUTERUSE_MODE ??= "local";
      const localComputerusePath =
        "../../../plugins/plugin-computeruse/typescript/src/index.ts";
      const computeruseModule = (await import(localComputerusePath)) as Record<
        string,
        unknown
      >;
      const computerusePlugin =
        computeruseModule.computerusePlugin ??
        computeruseModule.computerUsePlugin ??
        computeruseModule.default;
      if (computerusePlugin) {
        plugins.push(toPlugin(computerusePlugin, localComputerusePath));
        elizaLogger.info(
          "[bench] Loaded local plugin: @elizaos/plugin-computeruse",
        );
      }
    } catch (error: unknown) {
      elizaLogger.debug(
        `[bench] Computer use plugin not available: ${formatUnknownError(error)}`,
      );
    }
  }

  // Load mock plugin for testing (file is gitignored for local-only use)
  if (process.env.AUTONOMOUS_BENCH_MOCK === "true") {
    try {
      // @ts-ignore - mock-plugin.ts is gitignored, only exists for local benchmarking
      const { mockPlugin } = await import("./mock-plugin.ts");
      plugins.push(toPlugin(mockPlugin, "./mock-plugin.ts"));
      elizaLogger.info("[bench] Loaded mock benchmark plugin");
    } catch (error: unknown) {
      elizaLogger.error(
        `[bench] Failed to load mock benchmark plugin: ${formatUnknownError(error)}`,
      );
    }
  }

  // Build settings object from environment variables
  // These are needed by plugins like Groq that use runtime.getSetting()
  const settings: Record<string, string> = {
    // Use in-memory database for benchmarks to avoid pglite corruption issues
    // and ensure a clean state for each benchmark run
    PGLITE_DATA_DIR: "memory://",
  };
  const envKeys = [
    "GROQ_API_KEY",
    "OPENAI_API_KEY",
    "ANTHROPIC_API_KEY",
    "OPENROUTER_API_KEY",
    "GOOGLE_GENERATIVE_AI_API_KEY",
  ];
  for (const key of envKeys) {
    const value = process.env[key]?.trim();
    if (value) {
      settings[key] = value;
    }
  }

  // Pre-register the SQL and local-embedding plugins before initialize().
  // AgentRuntime initializes character plugins in parallel, which can race
  // plugin startup against SQL adapter setup and leave runtime.db unset.
  const preregisterPluginNames = new Set([
    "@elizaos/plugin-sql",
    "@elizaos/plugin-local-embedding",
  ]);
  const preregisterPlugins = plugins.filter((plugin) =>
    preregisterPluginNames.has(plugin.name),
  );
  const deferredPlugins = plugins.filter(
    (plugin) => !preregisterPluginNames.has(plugin.name),
  );

  const runtime = new AgentRuntime({
    character: {
      name: "Kira",
      bio: ["A benchmark execution agent."],
      messageExamples: [],
      topics: [],
      adjectives: [],
      plugins: [],
      settings: {
        secrets: settings,
      },
    },
    adapter: new InMemoryDatabaseAdapter(),
    plugins: deferredPlugins,
  });

  let databaseAdapterMode = "plugin-sql";
  const runtimeWithAdapter = runtime as AgentRuntime & {
    adapter: {
      init: () => Promise<void>;
      isReady: () => Promise<boolean>;
    };
  };

  const sqlPlugin = preregisterPlugins.find(
    (candidate) => candidate.name === "@elizaos/plugin-sql",
  );
  if (sqlPlugin) {
    try {
      await runtime.registerPlugin(sqlPlugin);
      elizaLogger.info(`[bench] Pre-registered plugin: ${sqlPlugin.name}`);
      if (
        runtimeWithAdapter.adapter &&
        !(await runtimeWithAdapter.adapter.isReady())
      ) {
        await runtimeWithAdapter.adapter.init();
        elizaLogger.info(
          "[bench] Database adapter initialized before runtime init",
        );
      }
    } catch (error: unknown) {
      databaseAdapterMode = "in-memory-fallback";
      runtime.adapter = new InMemoryDatabaseAdapter();
      elizaLogger.warn(
        `[bench] Falling back to in-memory database adapter: ${formatUnknownError(error)}`,
      );
    }
  } else {
    databaseAdapterMode = "in-memory-fallback";
    runtime.adapter = new InMemoryDatabaseAdapter();
    elizaLogger.warn(
      "[bench] SQL plugin unavailable; using in-memory database adapter for benchmark mode",
    );
  }

  const localEmbeddingPlugin = preregisterPlugins.find(
    (candidate) => candidate.name === "@elizaos/plugin-local-embedding",
  );
  if (localEmbeddingPlugin) {
    await runtime.registerPlugin(localEmbeddingPlugin);
    elizaLogger.info(
      `[bench] Pre-registered plugin: ${localEmbeddingPlugin.name}`,
    );
  }

  await runtime.initialize();
  const modelHandlers = (
    runtime as unknown as { models?: Map<string, unknown[]> }
  ).models;
  const modelHandlerSummary = Object.fromEntries(
    [...(modelHandlers?.entries() ?? [])].map(([modelType, handlers]) => [
      modelType,
      (handlers as Array<{ provider?: string; priority?: number }>).map(
        (handler) => ({
          provider: handler.provider ?? "unknown",
          priority: handler.priority ?? 0,
        }),
      ),
    ]),
  );
  elizaLogger.info(
    `[bench] Model handlers: ${JSON.stringify(modelHandlerSummary)}`,
  );
  const textGenerationModelTypes = new Set([
    "TEXT_SMALL",
    "TEXT_LARGE",
    "REASONING_SMALL",
    "REASONING_LARGE",
    "TEXT_COMPLETION",
  ]);
  const hasTextGenerationModel = [...(modelHandlers?.entries() ?? [])].some(
    ([modelType, handlers]) =>
      textGenerationModelTypes.has(String(modelType)) &&
      Array.isArray(handlers) &&
      handlers.length > 0,
  );
  elizaLogger.info(`[bench] Database adapter mode: ${databaseAdapterMode}`);
  elizaLogger.info(
    `[bench] Runtime initialized — agent=${runtime.character.name}, plugins=${plugins.length}`,
  );

  const roomToSession = new Map<string, string>();
  const entityToSession = new Map<string, string>();
  const trajectoriesBySession = new Map<string, BenchmarkTrajectoryStep[]>();
  const outboxBySession = new Map<string, BenchmarkOutboxEntry[]>();

  const benchmarkTransport = {
    sendDirectMessage: async (targetEntityId: string, content: Content) => {
      const key = entityToSession.get(targetEntityId);
      const text = typeof content.text === "string" ? content.text : "";
      const source =
        typeof content.source === "string" ? content.source : "benchmark";
      if (!key) return;
      const current = outboxBySession.get(key) ?? [];
      current.push({
        kind: "direct",
        targetId: targetEntityId,
        text,
        source,
        ts: Date.now(),
      });
      outboxBySession.set(key, current);
    },
    sendRoomMessage: async (targetRoomId: string, content: Content) => {
      const key = roomToSession.get(targetRoomId);
      const text = typeof content.text === "string" ? content.text : "";
      const source =
        typeof content.source === "string" ? content.source : "benchmark";
      if (!key) return;
      const current = outboxBySession.get(key) ?? [];
      current.push({
        kind: "room",
        targetId: targetRoomId,
        text,
        source,
        ts: Date.now(),
      });
      outboxBySession.set(key, current);
    },
  };

  const runtimeWithServiceOverride = runtime as unknown as {
    getService: (serviceType: string) => unknown;
  };
  const originalGetService =
    runtimeWithServiceOverride.getService.bind(runtime);
  runtimeWithServiceOverride.getService = (serviceType: string) => {
    if (serviceType === "benchmark") {
      return benchmarkTransport;
    }
    return originalGetService(serviceType);
  };

  const sessions = new Map<string, BenchmarkSession>();
  let activeSession: BenchmarkSession | null = null;

  const registerSessionRefs = (session: BenchmarkSession): void => {
    const key = sessionKey(session);
    roomToSession.set(session.roomId, key);
    roomToSession.set(session.relayRoomId, key);
    entityToSession.set(session.userEntityId, key);
  };

  const resolveSession = (
    taskId: string,
    benchmark: string,
    createIfMissing = true,
  ): BenchmarkSession | null => {
    const key = `${benchmark}:${taskId}`;
    const existing = sessions.get(key);
    if (existing) {
      activeSession = existing;
      return existing;
    }
    if (!createIfMissing) return null;
    const created = createSession(taskId, benchmark);
    sessions.set(key, created);
    registerSessionRefs(created);
    activeSession = created;
    return created;
  };

  const server = http.createServer(async (req, res) => {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "POST, GET, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");

    const requestUrl = new URL(req.url ?? "/", "http://localhost");
    const pathname = requestUrl.pathname;

    if (req.method === "OPTIONS") {
      res.writeHead(200);
      res.end();
      return;
    }

    if (pathname === "/api/benchmark/health" && req.method === "GET") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          status: "ready",
          agent_name: runtime.character.name ?? "Autonomous",
          plugins: plugins.length,
          database_adapter: databaseAdapterMode,
          has_text_model: hasTextGenerationModel,
          message_mode: messageMode,
          model_handlers: modelHandlerSummary,
          active_session: activeSession
            ? {
              benchmark: activeSession.benchmark,
              task_id: activeSession.taskId,
              room_id: activeSession.roomId,
            }
            : null,
        }),
      );
      return;
    }

    if (pathname === "/api/benchmark/reset" && req.method === "POST") {
      let body = "";
      req.on("data", (chunk) => (body += chunk));
      req.on("end", async () => {
        try {
          const parsed = body.trim()
            ? (JSON.parse(body) as {
              task_id?: unknown;
              benchmark?: unknown;
            })
            : {};
          const taskId =
            typeof parsed.task_id === "string" &&
              parsed.task_id.trim().length > 0
              ? parsed.task_id
              : "default-task";
          const benchmark =
            typeof parsed.benchmark === "string" &&
              parsed.benchmark.trim().length > 0
              ? parsed.benchmark
              : "unknown";

          const session = resolveSession(taskId, benchmark, true);
          if (!session) {
            throw new Error("Failed to initialize benchmark session");
          }
          const key = sessionKey(session);
          trajectoriesBySession.set(key, []);
          outboxBySession.set(key, []);

          await ensureBenchmarkSessionContext(runtime, session);

          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({
              status: "ok",
              room_id: session.roomId,
              task_id: session.taskId,
              benchmark: session.benchmark,
            }),
          );
        } catch (err: unknown) {
          const errorMessage = err instanceof Error ? err.message : String(err);
          elizaLogger.error(`[bench] Reset error: ${formatUnknownError(err)}`);
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: errorMessage }));
        }
      });
      return;
    }

    if (pathname === "/api/benchmark/outbox" && req.method === "GET") {
      const context = extractRecord({
        benchmark: requestUrl.searchParams.get("benchmark") ?? undefined,
        task_id:
          requestUrl.searchParams.get("task_id") ??
          requestUrl.searchParams.get("taskId") ??
          undefined,
      });
      const taskId = extractTaskId(context);
      const benchmark = extractBenchmarkName(context);
      const session =
        resolveSession(taskId, benchmark, false) ??
        activeSession ??
        resolveSession("default-task", "unknown", false);

      if (!session) {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ status: "ok", outbox: [] }));
        return;
      }

      const key = sessionKey(session);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          status: "ok",
          benchmark: session.benchmark,
          task_id: session.taskId,
          room_id: session.roomId,
          outbox: outboxBySession.get(key) ?? [],
        }),
      );
      return;
    }

    if (pathname === "/api/benchmark/trajectory" && req.method === "GET") {
      const context = extractRecord({
        benchmark: requestUrl.searchParams.get("benchmark") ?? undefined,
        task_id:
          requestUrl.searchParams.get("task_id") ??
          requestUrl.searchParams.get("taskId") ??
          undefined,
      });
      const taskId = extractTaskId(context);
      const benchmark = extractBenchmarkName(context);
      const session =
        resolveSession(taskId, benchmark, false) ??
        activeSession ??
        resolveSession("default-task", "unknown", false);

      if (!session) {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            status: "ok",
            steps: [],
            outbox: [],
          }),
        );
        return;
      }

      const key = sessionKey(session);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          status: "ok",
          benchmark: session.benchmark,
          task_id: session.taskId,
          room_id: session.roomId,
          relay_room_id: session.relayRoomId,
          steps: trajectoriesBySession.get(key) ?? [],
          outbox: outboxBySession.get(key) ?? [],
        }),
      );
      return;
    }

    if (pathname === "/api/benchmark/message" && req.method === "POST") {
      let body = "";
      req.on("data", (chunk) => (body += chunk));
      req.on("end", async () => {
        try {
          const parsed = JSON.parse(body) as {
            text?: unknown;
            context?: unknown;
            image?: unknown;
          };

          const text =
            typeof parsed.text === "string" ? parsed.text.trim() : "";
          if (!text) {
            throw new Error(
              "Request body must include non-empty string `text`",
            );
          }

          const context = extractRecord(parsed.context);
          const taskId = extractTaskId(context);
          const benchmark = extractBenchmarkName(context);
          const session =
            resolveSession(taskId, benchmark, true) ??
            activeSession ??
            resolveSession("default-task", "unknown", true);
          if (!session) {
            throw new Error("Failed to resolve benchmark session");
          }
          const key = sessionKey(session);
          const trajectory = trajectoriesBySession.get(key) ?? [];
          const startedAt = Date.now();

          await ensureBenchmarkSessionContext(runtime, session);

          const composedPrompt = composeBenchmarkPrompt({
            text,
            context,
            image: parsed.image,
            mode: messageMode,
          });

          const incomingMessage: Memory = {
            id: stringToUuid(`benchmark-msg:${Date.now()}:${Math.random()}`),
            content: {
              text: composedPrompt,
              source: "benchmark",
              metadata: {
                benchmark: session.benchmark,
                taskId: session.taskId,
                ...(context ? { contextJson: JSON.stringify(context) } : {}),
              },
            },
            entityId: session.userEntityId,
            agentId: runtime.agentId,
            roomId: session.roomId,
            createdAt: Date.now(),
          };

          if (!hasTextGenerationModel) {
            throw new Error(
              "No text generation model provider is configured for benchmark runtime",
            );
          }

          let responseText = "";
          let thought: string | null = null;
          let actions: string[] = [];
          let params: Record<string, unknown> = {};

          if (messageMode === "direct-model") {
            responseText = (
              await runtime.useModel(ModelType.TEXT_SMALL, {
                prompt: composedPrompt,
                maxTokens: 1024,
                temperature: 0,
              })
            ).trim();
          } else {
            const callbackTexts: string[] = [];
            const callback = async (content: Content): Promise<Memory[]> => {
              if (
                typeof content.text === "string" &&
                content.text.trim().length > 0
              ) {
                callbackTexts.push(content.text.trim());
              }
              return [];
            };

            if (!runtime.messageService) {
              throw new Error("Runtime message service is not available");
            }

            const result = await runtime.messageService.handleMessage(
              runtime,
              incomingMessage,
              callback,
            );

            responseText =
              typeof result.responseContent?.text === "string"
                ? result.responseContent.text
                : callbackTexts.join("\n\n");
            thought =
              typeof result.responseContent?.thought === "string"
                ? result.responseContent.thought
                : null;
            actions = coerceActions(result.responseContent?.actions);
            params = coerceParams(result.responseContent?.params);
          }
          const finishedAt = Date.now();

          trajectory.push({
            step: trajectory.length + 1,
            startedAt,
            finishedAt,
            inputText: text,
            promptText: composedPrompt,
            context,
            thought,
            responseText,
            actions,
            params,
          });
          trajectoriesBySession.set(key, trajectory);

          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({
              text: responseText,
              thought,
              actions,
              params,
              benchmark: session.benchmark,
              task_id: session.taskId,
              room_id: session.roomId,
              trajectory_step: trajectory.length,
            }),
          );
        } catch (err: unknown) {
          const errorMessage = err instanceof Error ? err.message : String(err);
          const errorDetail =
            err instanceof Error && err.stack
              ? err.stack
              : formatUnknownError(err);
          elizaLogger.error(`[bench] Request error: ${errorDetail}`);
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: errorMessage }));
        }
      });
      return;
    }

    res.writeHead(404);
    res.end("Not Found");
  });

  server.listen(port, () => {
    elizaLogger.info(
      `[bench] Autonomous benchmark server listening on port ${port}`,
    );
    console.log(`AUTONOMOUS_BENCH_READY port=${port}`);
  });
}

startBenchmarkServer().catch((err) => {
  console.error("Failed to start benchmark server:", err);
  process.exit(1);
});
