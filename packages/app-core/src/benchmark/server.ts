import crypto from "node:crypto";
import http from "node:http";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { CORE_PLUGINS, createElizaPlugin } from "@elizaos/agent";
import {
  AgentRuntime,
  type Content,
  elizaLogger,
  type Memory,
  type Plugin,
  stringToUuid,
} from "@elizaos/core";
import dotenv from "dotenv";
import {
  clearCapturedAction,
  createBenchmarkPlugin,
  getCapturedAction,
  setBenchmarkContext,
} from "./plugin";
import {
  type BenchmarkLlmCallUsage,
  type BenchmarkOutboxEntry,
  type BenchmarkSession,
  type BenchmarkTrajectoryStep,
  type BenchmarkTurnUsage,
  capturedActionToParams,
  coerceActions,
  coerceParams,
  composeBenchmarkPrompt,
  createSession,
  ensureBenchmarkSessionContext,
  extractBenchmarkName,
  extractRecord,
  extractTaskId,
  formatUnknownError,
  normalizeBenchmarkContext,
  resolveHost,
  resolvePort,
  sessionKey,
  toPlugin,
} from "./server-utils.js";

// Load environment variables BEFORE anything else
// This ensures API keys are available when plugins initialize
dotenv.config({ path: path.resolve(process.cwd(), ".env") });
const BENCH_TOKEN = process.env.ELIZA_BENCH_TOKEN?.trim() || null;
const OPENROUTER_PLUGIN_MODULE: string = "@elizaos/plugin-openrouter";

// ---------------------------------------------------------------------------
// Security: authentication + CORS
// ---------------------------------------------------------------------------

const DEFAULT_MAX_BODY_BYTES = 16 * 1024 * 1024;
const configuredMaxBodyBytes = Number(process.env.ELIZA_BENCH_MAX_BODY_BYTES);
const MAX_BODY_BYTES =
  Number.isFinite(configuredMaxBodyBytes) && configuredMaxBodyBytes > 0
    ? Math.floor(configuredMaxBodyBytes)
    : DEFAULT_MAX_BODY_BYTES;

/** Allowed CORS origins — only localhost variants. */
const LOCALHOST_ORIGINS = new Set(["http://localhost", "https://localhost"]);

function isAllowedOrigin(origin: string | undefined): boolean {
  if (!origin) return false;
  try {
    const { hostname, origin: canonical } = new URL(origin);
    if (LOCALHOST_ORIGINS.has(canonical)) return true;
    // Allow localhost with any port
    if (
      hostname === "localhost" ||
      hostname === "127.0.0.1" ||
      hostname === "[::1]"
    )
      return true;
    return false;
  } catch {
    return false;
  }
}

function resolveAllowedOrigin(req: http.IncomingMessage): string {
  const origin = req.headers.origin;
  if (typeof origin === "string" && isAllowedOrigin(origin)) return origin;
  return "http://localhost";
}

function resolveBenchToken(): string | null {
  return BENCH_TOKEN;
}

function tokenMatches(expected: string, provided: string): boolean {
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(provided, "utf8");
  if (a.length !== b.length) {
    // Pad to equal length to avoid length oracle
    const padded = Buffer.alloc(a.length);
    b.copy(padded, 0, 0, Math.min(b.length, a.length));
    return crypto.timingSafeEqual(a, padded) && false;
  }
  return crypto.timingSafeEqual(a, b);
}

function checkBenchAuth(
  req: http.IncomingMessage,
  res: http.ServerResponse,
): boolean {
  const expected = resolveBenchToken();
  if (!expected) {
    // If no token is configured, reject ALL mutating requests with an
    // actionable error message so operators know how to enable the server.
    res.writeHead(403, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        error:
          "Benchmark server requires ELIZA_BENCH_TOKEN to be set. " +
          "Generate one with: openssl rand -hex 32",
      }),
    );
    return false;
  }

  const authHeader = req.headers.authorization;
  const provided =
    typeof authHeader === "string" && authHeader.startsWith("Bearer ")
      ? authHeader.slice(7).trim()
      : "";

  if (!provided || !tokenMatches(expected, provided)) {
    res.writeHead(401, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Invalid or missing Bearer token" }));
    return false;
  }

  return true;
}

function disableManualCompactionAction(runtime: AgentRuntime): void {
  const runtimeWithActions = runtime as AgentRuntime & {
    actions?: Array<{ name?: string }>;
  };
  if (!Array.isArray(runtimeWithActions.actions)) {
    return;
  }
  const compactSessionIndex = runtimeWithActions.actions.findIndex(
    (action) => action?.name?.toUpperCase() === "COMPACT_SESSION",
  );
  if (compactSessionIndex === -1) {
    return;
  }
  runtimeWithActions.actions.splice(compactSessionIndex, 1);
  elizaLogger.info(
    "[bench] Disabled manual COMPACT_SESSION action; auto-compaction remains enabled",
  );
}

async function collectSessionDiagnostics(
  runtime: AgentRuntime,
  session: BenchmarkSession,
): Promise<Record<string, unknown>> {
  const room = await runtime.getRoom(session.roomId);
  const rawLastCompactionAt = room?.metadata?.lastCompactionAt;
  const lastCompactionAt =
    typeof rawLastCompactionAt === "number" ? rawLastCompactionAt : null;

  const [allMessages, recentMessages, factsInRoom, factsForUser] =
    await Promise.all([
      runtime.getMemories({
        tableName: "messages",
        roomId: session.roomId,
        limit: 2000,
        unique: false,
      }),
      runtime.getMemories({
        tableName: "messages",
        roomId: session.roomId,
        limit: 2000,
        unique: false,
        ...(lastCompactionAt !== null ? { start: lastCompactionAt } : {}),
      }),
      runtime.getMemories({
        tableName: "facts",
        roomId: session.roomId,
        limit: 2000,
        unique: false,
      }),
      runtime.getMemories({
        tableName: "facts",
        roomId: session.roomId,
        entityId: session.userEntityId,
        limit: 500,
        unique: false,
      }),
    ]);

  const compactionSummaries = allMessages
    .filter((m) => m.content?.source === "compaction")
    .sort((a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0));
  const latestCompactionSummary = compactionSummaries.at(-1) ?? null;
  const latestSummaryText =
    typeof latestCompactionSummary?.content?.text === "string"
      ? latestCompactionSummary.content.text
      : "";
  const summaryPreview = latestSummaryText.slice(0, 400);

  const providerNames = runtime.providers.map((provider) => provider.name);
  const evaluatorNames =
    (runtime as { evaluators?: Array<{ name?: string }> }).evaluators
      ?.map((evaluator) => evaluator?.name ?? "")
      .filter((name) => name.length > 0) ?? [];
  const actionNames =
    (runtime as { actions?: Array<{ name?: string }> }).actions
      ?.map((action) => action?.name?.toUpperCase() ?? "")
      .filter((name) => name.length > 0) ?? [];

  return {
    benchmark: session.benchmark,
    task_id: session.taskId,
    room_id: session.roomId,
    relay_room_id: session.relayRoomId,
    room_metadata: {
      last_compaction_at: lastCompactionAt,
      compaction_history: Array.isArray(room?.metadata?.compactionHistory)
        ? room.metadata.compactionHistory
        : [],
    },
    memory_counts: {
      messages_total: allMessages.length,
      messages_since_last_compaction: recentMessages.length,
      compaction_summaries: compactionSummaries.length,
      facts_room_total: factsInRoom.length,
      facts_for_user_total: factsForUser.length,
    },
    latest_compaction_summary: latestCompactionSummary
      ? {
          memory_id: latestCompactionSummary.id,
          created_at: latestCompactionSummary.createdAt ?? null,
          preview: summaryPreview,
        }
      : null,
    capability_flags: {
      has_recent_messages_provider: providerNames.includes("RECENT_MESSAGES"),
      has_facts_provider: providerNames.includes("FACTS"),
      has_reflection_evaluator: evaluatorNames.some((name) =>
        name.toUpperCase().includes("REFLECTION"),
      ),
      has_relationship_evaluator: evaluatorNames.some((name) =>
        name.toUpperCase().includes("RELATIONSHIP"),
      ),
      has_manual_compaction_action: actionNames.includes("COMPACT_SESSION"),
    },
    providers: providerNames,
    evaluators: evaluatorNames,
    actions: actionNames,
  };
}

// Proper robust server implementation
export async function startBenchmarkServer() {
  const port = resolvePort();
  elizaLogger.info(
    `[bench] Initializing eliza benchmark runtime on port ${port}...`,
  );

  // ═══════════════════════════════════════════════════════════════════════════
  // PLUGIN LOADING — Use full CORE_PLUGINS to test with realistic context
  // ═══════════════════════════════════════════════════════════════════════════
  // We intentionally load the full Eliza plugin set to ensure benchmarks test
  // the agent's ability to perform tasks despite context "pollution" from all
  // the default actions, providers, evaluators, etc. If the agent can still
  // succeed with a crowded context, it demonstrates sufficient context handling.
  // ═══════════════════════════════════════════════════════════════════════════

  const plugins: Plugin[] = [];
  const loadedPlugins: string[] = [];
  const failedPlugins: string[] = [];

  // Plugins to skip in benchmark context — these require external auth or
  // interfere with benchmark operation
  const skipPlugins = new Set([
    "@elizaos/plugin-elizacloud", // Requires elizaOS cloud auth, conflicts with local LLM
  ]);

  const skipCorePlugins = process.env.ELIZA_BENCH_SKIP_CORE_PLUGINS === "true";
  const corePluginsToLoad = skipCorePlugins
    ? ["@elizaos/plugin-sql"]
    : CORE_PLUGINS;
  if (skipCorePlugins) {
    elizaLogger.info(
      "[bench] Loading minimal core plugins for benchmark smoke run",
    );
  }

  // Load all CORE_PLUGINS by default; smoke runs can opt into the minimal
  // required set so credential-free bridge checks start quickly.
  for (const pluginName of corePluginsToLoad) {
    if (skipPlugins.has(pluginName)) {
      elizaLogger.debug(
        `[bench] Skipping plugin (benchmark mode): ${pluginName}`,
      );
      continue;
    }
    try {
      let pluginModule: Record<string, unknown>;
      try {
        pluginModule = (await import(pluginName)) as Record<string, unknown>;
      } catch (error) {
        if (pluginName !== "@elizaos/plugin-sql") {
          throw error;
        }
        const fallbackPath = path.resolve(
          process.cwd(),
          "../../plugins/plugin-sql/typescript/index.ts",
        );
        elizaLogger.warn(
          `[bench] @elizaos/plugin-sql package entry is unavailable; falling back to workspace source at ${fallbackPath}`,
        );
        pluginModule = (await import(
          pathToFileURL(fallbackPath).href
        )) as Record<string, unknown>;
      }
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
    `[bench] Loaded ${loadedPlugins.length}/${corePluginsToLoad.length} core plugins`,
  );
  if (failedPlugins.length > 0) {
    elizaLogger.debug(
      `[bench] Unavailable plugins: ${failedPlugins.join(", ")}`,
    );
  }

  // Load Eliza plugin — provides workspace context, session keys, autonomous state,
  // custom actions, and lifecycle actions (restart, trigger tasks)
  try {
    const workspaceDir = process.env.ELIZA_WORKSPACE_DIR ?? process.cwd();
    const elizaPlugin = createElizaPlugin({
      workspaceDir,
      agentId: "benchmark",
    });
    plugins.push(toPlugin(elizaPlugin, "eliza-plugin"));
    elizaLogger.info(
      `[bench] Loaded eliza plugin with workspace: ${workspaceDir}`,
    );
  } catch (error: unknown) {
    elizaLogger.error(
      `[bench] Failed to load eliza plugin: ${formatUnknownError(error)}`,
    );
  }

  // Load benchmark plugin — provides benchmark provider + BENCHMARK_ACTION
  try {
    const benchmarkPlugin = createBenchmarkPlugin();
    plugins.push(toPlugin(benchmarkPlugin, "benchmark-plugin"));
    elizaLogger.info("[bench] Loaded benchmark plugin");
  } catch (error: unknown) {
    elizaLogger.error(
      `[bench] Failed to load benchmark plugin: ${formatUnknownError(error)}`,
    );
  }

  // Trust is now a built-in core capability — enable via ENABLE_TRUST character setting.
  // No need to load as a separate plugin.

  // Load LLM provider plugins based on environment.
  //
  // Multi-plugin guard: when both Groq and another OpenAI-compatible
  // provider are configured (e.g. Cerebras via OPENAI_BASE_URL), Groq's
  // TEXT_LARGE handler races to register first and the runtime then calls
  // it with whatever LARGE_MODEL is set. With cerebras runs the model
  // name is `gpt-oss-120b`, which Groq exposes only as
  // `openai/gpt-oss-120b` — Groq's handler errors and the v5 runtime
  // falls back to the structured-failure template ("Something went
  // wrong on my end. Please try again."). Suppress Groq when the
  // explicit intent is a different provider.
  const groqApiKey = process.env.GROQ_API_KEY?.trim();
  const _openAiBaseUrl = process.env.OPENAI_BASE_URL?.trim();
  const _cerebrasIntent =
    !!_openAiBaseUrl && /(^|\.)cerebras\.ai(\/|$)/i.test(_openAiBaseUrl);
  const _explicitProvider = process.env.MILADY_PROVIDER?.trim().toLowerCase();
  const _benchProvider =
    process.env.BENCHMARK_MODEL_PROVIDER?.trim().toLowerCase();
  const _suppressGroqForOtherProvider =
    _cerebrasIntent ||
    (_explicitProvider !== undefined &&
      _explicitProvider !== "" &&
      _explicitProvider !== "groq") ||
    (_benchProvider !== undefined &&
      _benchProvider !== "" &&
      _benchProvider !== "groq");
  if (groqApiKey && !_suppressGroqForOtherProvider) {
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
  } else if (groqApiKey && _suppressGroqForOtherProvider) {
    elizaLogger.info(
      "[bench] Skipping @elizaos/plugin-groq: another provider is the explicit intent " +
        `(cerebras=${_cerebrasIntent}, MILADY_PROVIDER=${_explicitProvider ?? ""}, BENCHMARK_MODEL_PROVIDER=${_benchProvider ?? ""})`,
    );
  }

  // Load the OpenAI plugin when either:
  //   - OPENAI_API_KEY is set (and is not actually a Groq key, prefix `gsk_`), or
  //   - OPENAI_BASE_URL points at an OpenAI-compatible third-party endpoint
  //     (e.g. Cerebras at *.cerebras.ai) and the matching provider key is set
  //     (e.g. CEREBRAS_API_KEY). The openai plugin's `getApiKey` helper
  //     resolves CEREBRAS_API_KEY automatically when the base URL matches.
  const openAiApiKey = process.env.OPENAI_API_KEY?.trim();
  const openAiBaseURL = process.env.OPENAI_BASE_URL?.trim();
  const cerebrasApiKey = process.env.CEREBRAS_API_KEY?.trim();
  const miladyProvider = process.env.MILADY_PROVIDER?.trim().toLowerCase();
  const baseUrlIsCerebras =
    !!openAiBaseURL && /(^|\.)cerebras\.ai(\/|$)/i.test(openAiBaseURL);
  const providerIsCerebras = miladyProvider === "cerebras";
  const hasOpenAiCompatibleKey =
    (openAiApiKey && !openAiApiKey.startsWith("gsk_")) ||
    ((baseUrlIsCerebras || providerIsCerebras) && !!cerebrasApiKey);
  if (hasOpenAiCompatibleKey) {
    if (openAiApiKey) {
      process.env.OPENAI_API_KEY = openAiApiKey;
    }
    try {
      const { default: openaiPlugin } = await import("@elizaos/plugin-openai");
      const openaiPluginResolved = toPlugin(
        openaiPlugin,
        "@elizaos/plugin-openai",
      );
      // Cerebras has no /v1/embeddings endpoint. The openai plugin's
      // TEXT_EMBEDDING handler will 404 against api.cerebras.ai and stall
      // Stage 1 of the message pipeline before the planner picks an action.
      // Strip TEXT_EMBEDDING when cerebras is the explicit intent so
      // plugin-local-embedding (loaded via CORE_PLUGINS) wins for embeddings
      // while the openai plugin still serves TEXT_LARGE / TEXT_SMALL.
      let strippedEmbedding = false;
      if (
        (baseUrlIsCerebras || providerIsCerebras) &&
        openaiPluginResolved.models &&
        "TEXT_EMBEDDING" in openaiPluginResolved.models
      ) {
        const filteredModels = { ...openaiPluginResolved.models } as Record<
          string,
          unknown
        >;
        delete filteredModels.TEXT_EMBEDDING;
        plugins.push({
          ...openaiPluginResolved,
          models: filteredModels as typeof openaiPluginResolved.models,
        });
        strippedEmbedding = true;
      } else {
        plugins.push(openaiPluginResolved);
      }
      elizaLogger.info(
        `[bench] Loaded LLM plugin: @elizaos/plugin-openai (baseURL=${openAiBaseURL ?? "default"}, key=${
          openAiApiKey
            ? "OPENAI_API_KEY"
            : cerebrasApiKey
              ? "CEREBRAS_API_KEY"
              : "none"
        }${strippedEmbedding ? ", TEXT_EMBEDDING stripped (cerebras)" : ""})`,
      );
      if (strippedEmbedding) {
        elizaLogger.info(
          "[bench] Cerebras detected: removed openai plugin's TEXT_EMBEDDING handler so @elizaos/plugin-local-embedding serves embeddings.",
        );
      }
    } catch (error: unknown) {
      elizaLogger.warn(
        `[bench] OpenAI plugin not available: ${formatUnknownError(error)}`,
      );
    }
  } else {
    elizaLogger.warn(
      `[bench] Skipping @elizaos/plugin-openai: no usable key found ` +
        `(OPENAI_API_KEY=${openAiApiKey ? (openAiApiKey.startsWith("gsk_") ? "groq-key (excluded)" : "set") : "unset"}, ` +
        `OPENAI_BASE_URL=${openAiBaseURL ?? "unset"}, ` +
        `CEREBRAS_API_KEY=${cerebrasApiKey ? "set" : "unset"}). ` +
        `TEXT_LARGE / TEXT_SMALL handlers will be missing — useModel() will throw.`,
    );
  }

  const openRouterApiKey = process.env.OPENROUTER_API_KEY?.trim();
  if (openRouterApiKey) {
    process.env.OPENROUTER_API_KEY = openRouterApiKey;
    try {
      const { default: openrouterPlugin } = await import(
        OPENROUTER_PLUGIN_MODULE
      );
      plugins.push(toPlugin(openrouterPlugin, "@elizaos/plugin-openrouter"));
      elizaLogger.info("[bench] Loaded LLM plugin: @elizaos/plugin-openrouter");
    } catch (error: unknown) {
      elizaLogger.warn(
        `[bench] OpenRouter plugin not available: ${formatUnknownError(error)}`,
      );
    }
  }

  const anthropicApiKey = process.env.ANTHROPIC_API_KEY?.trim();
  if (anthropicApiKey) {
    process.env.ANTHROPIC_API_KEY = anthropicApiKey;
    try {
      const { default: anthropicPlugin } = await import(
        "@elizaos/plugin-anthropic"
      );
      plugins.push(toPlugin(anthropicPlugin, "@elizaos/plugin-anthropic"));
      elizaLogger.info("[bench] Loaded LLM plugin: @elizaos/plugin-anthropic");
    } catch (error: unknown) {
      elizaLogger.debug(
        `[bench] Anthropic plugin not available: ${formatUnknownError(error)}`,
      );
    }
  }

  // Load computer use plugin if enabled
  if (process.env.ELIZA_ENABLE_COMPUTERUSE) {
    try {
      process.env.COMPUTERUSE_ENABLED ??= "true";
      process.env.COMPUTERUSE_MODE ??= "local";
      const localComputerusePath =
        "../../../../plugins/plugin-computeruse/src/index.ts";
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
  if (process.env.ELIZA_BENCH_MOCK === "true") {
    try {
      const mockLocation = "./mock-plugin.ts";
      const { mockPlugin } = await import(mockLocation);
      plugins.push(toPlugin(mockPlugin, mockLocation));
      elizaLogger.info("[bench] Loaded mock benchmark plugin");
    } catch (error: unknown) {
      elizaLogger.error(
        `[bench] Failed to load mock benchmark plugin: ${formatUnknownError(error)}`,
      );
    }
  }

  // Load plugin-social-alpha when the bench session targets the social-alpha
  // benchmark. The plugin exposes CommunityInvestorService (TrustScoreService),
  // socialAlphaProvider, and balancedTrustScoreCalculator — i.e. the actual
  // TS implementation that the Python harness used to port. Loading it here
  // makes the eliza TS agent the surface under test.
  const benchName = process.env.ELIZA_BENCH_NAME?.trim().toLowerCase() ?? "";
  const enableSocialAlphaPlugin =
    process.env.ELIZA_BENCH_LOAD_SOCIAL_ALPHA === "true" ||
    benchName === "social_alpha" ||
    benchName === "social-alpha";
  if (enableSocialAlphaPlugin) {
    try {
      const socialAlphaSrcPath = path.resolve(
        process.cwd(),
        "../../plugins/plugin-social-alpha/src/index.ts",
      );
      const socialAlphaModule = (await import(
        pathToFileURL(socialAlphaSrcPath).href
      )) as Record<string, unknown>;
      const socialAlphaPlugin =
        socialAlphaModule.socialAlphaPlugin ?? socialAlphaModule.default;
      if (socialAlphaPlugin) {
        plugins.push(
          toPlugin(socialAlphaPlugin, "@elizaos/plugin-social-alpha"),
        );
        elizaLogger.info(
          "[bench] Loaded LLM plugin: @elizaos/plugin-social-alpha (services=CommunityInvestorService; providers=socialAlphaProvider)",
        );
      } else {
        elizaLogger.warn(
          "[bench] @elizaos/plugin-social-alpha module did not expose socialAlphaPlugin",
        );
      }
    } catch (error: unknown) {
      elizaLogger.warn(
        `[bench] @elizaos/plugin-social-alpha not loaded: ${formatUnknownError(error)}`,
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

  // Optional runtime setting passthrough for deterministic benchmark tuning.
  // Useful for forcing compaction behavior in context-stress scenarios.
  const runtimeSettingKeys = [
    "MAX_CONVERSATION_TOKENS",
    "AUTO_COMPACT",
    "CONVERSATION_LENGTH",
    "ADVANCED_CAPABILITIES",
    "SMALL_MODEL",
    "LARGE_MODEL",
    "NANO_MODEL",
    "MEDIUM_MODEL",
    "MEGA_MODEL",
    "ACTION_PLANNER_MODEL",
    "PLANNER_MODEL",
    "RESPONSE_HANDLER_MODEL",
    "SHOULD_RESPOND_MODEL",
    "GROQ_SMALL_MODEL",
    "GROQ_LARGE_MODEL",
    "GROQ_NANO_MODEL",
    "GROQ_MEDIUM_MODEL",
    "GROQ_MEGA_MODEL",
    "GROQ_ACTION_PLANNER_MODEL",
    "GROQ_PLANNER_MODEL",
    "GROQ_RESPONSE_HANDLER_MODEL",
    "GROQ_SHOULD_RESPOND_MODEL",
    "OPENAI_SMALL_MODEL",
    "OPENAI_LARGE_MODEL",
    "OPENAI_NANO_MODEL",
    "OPENAI_MEDIUM_MODEL",
    "OPENAI_MEGA_MODEL",
    "OPENAI_ACTION_PLANNER_MODEL",
    "OPENAI_PLANNER_MODEL",
    "OPENAI_RESPONSE_HANDLER_MODEL",
    "OPENAI_SHOULD_RESPOND_MODEL",
    "OPENROUTER_SMALL_MODEL",
    "OPENROUTER_LARGE_MODEL",
    "OPENROUTER_NANO_MODEL",
    "OPENROUTER_MEDIUM_MODEL",
    "OPENROUTER_MEGA_MODEL",
    "OPENROUTER_ACTION_PLANNER_MODEL",
    "OPENROUTER_PLANNER_MODEL",
    "OPENROUTER_RESPONSE_HANDLER_MODEL",
    "OPENROUTER_SHOULD_RESPOND_MODEL",
    "ANTHROPIC_SMALL_MODEL",
    "ANTHROPIC_LARGE_MODEL",
    "ANTHROPIC_NANO_MODEL",
    "ANTHROPIC_MEDIUM_MODEL",
    "ANTHROPIC_MEGA_MODEL",
    "ANTHROPIC_ACTION_PLANNER_MODEL",
    "ANTHROPIC_PLANNER_MODEL",
    "ANTHROPIC_RESPONSE_HANDLER_MODEL",
    "ANTHROPIC_SHOULD_RESPOND_MODEL",
  ];
  for (const key of runtimeSettingKeys) {
    const value = process.env[key]?.trim();
    if (value) {
      settings[key] = value;
    }
  }

  const runtime = new AgentRuntime({
    character: {
      name: "Kira",
      bio: ["A benchmark execution agent."],
      messageExamples: [],
      adjectives: [],
      plugins: [],
      settings: {
        secrets: settings,
      },
    },
    plugins,
  });

  await runtime.initialize();
  disableManualCompactionAction(runtime);
  const modelHandlers = (runtime as { models?: Map<string, unknown[]> }).models;
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
  elizaLogger.info(
    `[bench] Runtime initialized — agent=${runtime.character.name}, plugins=${plugins.length}`,
  );

  // ── LLM usage capture ────────────────────────────────────────────────────
  // Plugins (currently @elizaos/plugin-openai, @elizaos/plugin-anthropic) emit
  // a MODEL_USED event for each LLM call with token usage and provider-side
  // cache hit info. We collect those into a per-turn buffer that handle-message
  // installs at the start of a turn and snapshots into the trajectory at end.
  // Buffer is `null` when no turn is in flight; events outside a turn are
  // ignored. This is safe because the bench server processes one turn at a
  // time per session and sessions don't run concurrent handleMessage calls.
  let activeUsageBuffer: BenchmarkLlmCallUsage[] | null = null;
  try {
    const registerEvent = runtime.registerEvent.bind(runtime) as (
      type: string,
      handler: (payload: unknown) => void | Promise<void>,
    ) => void;
    if (typeof registerEvent === "function") {
      registerEvent("MODEL_USED", (payload: unknown) => {
        if (!activeUsageBuffer) return;
        if (!payload || typeof payload !== "object") return;
        const p = payload as {
          type?: unknown;
          source?: unknown;
          provider?: unknown;
          tokens?: {
            prompt?: unknown;
            completion?: unknown;
            total?: unknown;
            cached?: unknown;
          };
        };
        const tokens = p.tokens ?? {};
        const promptTokens =
          typeof tokens.prompt === "number" ? tokens.prompt : 0;
        const completionTokens =
          typeof tokens.completion === "number" ? tokens.completion : 0;
        const totalTokens =
          typeof tokens.total === "number"
            ? tokens.total
            : promptTokens + completionTokens;
        const cachedTokens =
          typeof tokens.cached === "number" ? tokens.cached : undefined;
        activeUsageBuffer.push({
          modelType: typeof p.type === "string" ? p.type : "unknown",
          provider: typeof p.provider === "string" ? p.provider : undefined,
          source: typeof p.source === "string" ? p.source : undefined,
          promptTokens,
          completionTokens,
          totalTokens,
          ...(cachedTokens !== undefined ? { cachedTokens } : {}),
        });
      });
      elizaLogger.info(
        "[bench] Registered MODEL_USED listener for trajectory usage capture",
      );
    } else {
      elizaLogger.warn(
        "[bench] runtime.registerEvent is not available; trajectory usage will be unset",
      );
    }
  } catch (err: unknown) {
    elizaLogger.warn(
      `[bench] Could not register MODEL_USED listener: ${formatUnknownError(err)}`,
    );
  }

  const summarizeUsage = (
    calls: BenchmarkLlmCallUsage[],
  ): BenchmarkTurnUsage => {
    let promptTokens = 0;
    let completionTokens = 0;
    let totalTokens = 0;
    let cachedTokens = 0;
    for (const call of calls) {
      promptTokens += call.promptTokens;
      completionTokens += call.completionTokens;
      totalTokens += call.totalTokens;
      if (typeof call.cachedTokens === "number") {
        cachedTokens += call.cachedTokens;
      }
    }
    const cacheHitRatio = promptTokens > 0 ? cachedTokens / promptTokens : 0;
    return {
      promptTokens,
      completionTokens,
      totalTokens,
      cachedTokens,
      cacheHitRatio,
      callCount: calls.length,
      calls,
    };
  };

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

  const runtimeWithServiceOverride = runtime as {
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
  let lastSessionKey: string | null = null;

  // Session TTL eviction (R4)
  const SESSION_TTL_MS = 24 * 60 * 60 * 1000;
  const SESSION_SWEEP_INTERVAL_MS = 60_000;
  const sessionCreatedAt = new Map<string, number>();

  const evictStaleSessions = (): void => {
    const now = Date.now();
    for (const [key, createdAt] of sessionCreatedAt.entries()) {
      if (now - createdAt > SESSION_TTL_MS) {
        sessions.delete(key);
        trajectoriesBySession.delete(key);
        outboxBySession.delete(key);
        sessionCreatedAt.delete(key);
        for (const [k, v] of roomToSession.entries()) {
          if (v === key) roomToSession.delete(k);
        }
        for (const [k, v] of entityToSession.entries()) {
          if (v === key) entityToSession.delete(k);
        }
      }
    }
  };

  const sweepInterval = setInterval(
    evictStaleSessions,
    SESSION_SWEEP_INTERVAL_MS,
  );
  sweepInterval.unref();

  const registerSessionRefs = (session: BenchmarkSession): void => {
    const key = sessionKey(session);
    roomToSession.set(session.roomId, key);
    roomToSession.set(session.relayRoomId, key);
    entityToSession.set(session.userEntityId, key);
  };

  const getLastSession = (): BenchmarkSession | null =>
    lastSessionKey ? (sessions.get(lastSessionKey) ?? null) : null;

  const resolveSession = (
    taskId: string,
    benchmark: string,
    createIfMissing = true,
  ): BenchmarkSession | null => {
    const key = `${benchmark}:${taskId}`;
    const existing = sessions.get(key);
    if (existing) {
      lastSessionKey = key;
      return existing;
    }
    if (!createIfMissing) return null;
    const created = createSession(taskId, benchmark);
    sessions.set(key, created);
    sessionCreatedAt.set(key, Date.now());
    registerSessionRefs(created);
    lastSessionKey = key;
    return created;
  };

  const server = http.createServer(async (req, res) => {
    // Security: restrict CORS to localhost origins only.
    const allowedOrigin = resolveAllowedOrigin(req);
    res.setHeader("Access-Control-Allow-Origin", allowedOrigin);
    res.setHeader("Access-Control-Allow-Methods", "POST, GET, OPTIONS");
    res.setHeader(
      "Access-Control-Allow-Headers",
      "Content-Type, Authorization",
    );
    res.setHeader("Vary", "Origin");

    const requestUrl = new URL(req.url ?? "/", "http://localhost");
    const pathname = requestUrl.pathname;

    if (req.method === "OPTIONS") {
      res.writeHead(200);
      res.end();
      return;
    }

    if (pathname === "/api/benchmark/health" && req.method === "GET") {
      const activeSession = getLastSession();
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          status: "ready",
          agent_name: runtime.character.name ?? "Eliza",
          plugins: plugins.length,
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
      if (!checkBenchAuth(req, res)) return;
      let body = "";
      let bodyBytes = 0;
      req.on("data", (chunk: Buffer) => {
        bodyBytes += chunk.length;
        if (bodyBytes > MAX_BODY_BYTES) {
          req.destroy();
          return;
        }
        body += chunk;
      });
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
          elizaLogger.error(`[bench] Reset error: ${formatUnknownError(err)}`);
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Internal benchmark error" }));
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
        getLastSession() ??
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
        getLastSession() ??
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

    if (pathname === "/api/benchmark/diagnostics" && req.method === "GET") {
      try {
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
          getLastSession() ??
          resolveSession("default-task", "unknown", false);

        if (!session) {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ status: "ok", diagnostics: null }));
          return;
        }

        const diagnostics = await collectSessionDiagnostics(runtime, session);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ status: "ok", diagnostics }));
      } catch (err: unknown) {
        elizaLogger.error(
          `[bench] Diagnostics error: ${formatUnknownError(err)}`,
        );
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Internal benchmark error" }));
      }
      return;
    }

    if (pathname === "/api/benchmark/message" && req.method === "POST") {
      if (!checkBenchAuth(req, res)) return;
      let body = "";
      let bodyBytes = 0;
      req.on("data", (chunk: Buffer) => {
        bodyBytes += chunk.length;
        if (bodyBytes > MAX_BODY_BYTES) {
          req.destroy();
          return;
        }
        body += chunk;
      });
      req.on("end", async () => {
        try {
          let parsed: {
            text?: unknown;
            context?: unknown;
            image?: unknown;
          };
          try {
            parsed = JSON.parse(body) as {
              text?: unknown;
              context?: unknown;
              image?: unknown;
            };
          } catch {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(
              JSON.stringify({ error: "Malformed JSON in request body" }),
            );
            return;
          }

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
            getLastSession() ??
            resolveSession("default-task", "unknown", true);
          if (!session) {
            throw new Error("Failed to resolve benchmark session");
          }
          const key = sessionKey(session);
          const trajectory = trajectoriesBySession.get(key) ?? [];
          const startedAt = Date.now();

          await ensureBenchmarkSessionContext(runtime, session);

          const benchmarkContext = normalizeBenchmarkContext(session, context);
          const composedPrompt = composeBenchmarkPrompt({
            text,
            context: benchmarkContext,
            image: parsed.image,
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
          const messageService = runtime.messageService;

          clearCapturedAction();
          setBenchmarkContext(benchmarkContext);
          const turnUsageBuffer: BenchmarkLlmCallUsage[] = [];
          activeUsageBuffer = turnUsageBuffer;
          const result = await (async () => {
            try {
              return await messageService.handleMessage(
                runtime,
                incomingMessage,
                callback,
              );
            } finally {
              setBenchmarkContext(null);
              activeUsageBuffer = null;
            }
          })();
          const turnUsage = summarizeUsage(turnUsageBuffer);

          const capturedAction = getCapturedAction();

          const responseText =
            typeof result.responseContent?.text === "string"
              ? result.responseContent.text
              : callbackTexts.join("\n\n");
          const thought =
            typeof result.responseContent?.thought === "string"
              ? result.responseContent.thought
              : null;
          const actionList = coerceActions(result.responseContent?.actions);
          const actions =
            actionList.length > 0
              ? actionList
              : capturedAction
                ? ["BENCHMARK_ACTION"]
                : [];
          const parsedParams = coerceParams(result.responseContent?.params);
          const params =
            Object.keys(parsedParams).length > 0
              ? parsedParams
              : capturedActionToParams(capturedAction);
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
            usage: turnUsage,
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
          // Log full detail server-side but never expose stack traces to clients.
          elizaLogger.error(
            `[bench] Request error: ${formatUnknownError(err)}`,
          );
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Internal benchmark error" }));
        }
      });
      return;
    }

    res.writeHead(404);
    res.end("Not Found");
  });

  // Bump per-connection timeouts so long-running benchmark turns (slow LLM
  // calls, growing context) do not hit Node's defaults mid-flight. Defaults
  // in Node 22 are: requestTimeout 300s, headersTimeout 60s, keepAlive 5s.
  // Vending-bench in particular sees the server drop the keep-alive socket
  // between turns when the prompt context grows large; raise everything
  // generously and let benchmarks override via env var.
  const benchRequestTimeoutMs = Number(
    process.env.ELIZA_BENCH_REQUEST_TIMEOUT_MS ?? 30 * 60 * 1000,
  );
  const benchHeadersTimeoutMs = Number(
    process.env.ELIZA_BENCH_HEADERS_TIMEOUT_MS ?? 30 * 60 * 1000,
  );
  const benchKeepAliveTimeoutMs = Number(
    process.env.ELIZA_BENCH_KEEPALIVE_TIMEOUT_MS ?? 5 * 60 * 1000,
  );
  server.requestTimeout = Number.isFinite(benchRequestTimeoutMs)
    ? benchRequestTimeoutMs
    : 30 * 60 * 1000;
  server.headersTimeout = Number.isFinite(benchHeadersTimeoutMs)
    ? benchHeadersTimeoutMs
    : 30 * 60 * 1000;
  server.keepAliveTimeout = Number.isFinite(benchKeepAliveTimeoutMs)
    ? benchKeepAliveTimeoutMs
    : 5 * 60 * 1000;
  // Disable Node's per-socket idle timeout: benchmark turns can be longer
  // than any reasonable default while waiting for a model response.
  server.timeout = 0;

  const host = resolveHost();
  server.listen(port, host, () => {
    elizaLogger.info(
      `[bench] Eliza benchmark server listening on ${host}:${port} ` +
        `(requestTimeout=${server.requestTimeout}ms, ` +
        `headersTimeout=${server.headersTimeout}ms, ` +
        `keepAliveTimeout=${server.keepAliveTimeout}ms)`,
    );
    console.log(`ELIZA_BENCH_READY host=${host} port=${port}`);
  });
}

startBenchmarkServer().catch((err) => {
  console.error("Failed to start benchmark server:", err);
  process.exit(1);
});
