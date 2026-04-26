import "../utils/namespace-defaults.js";
import { existsSync } from "node:fs";
import { rename } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";
import {
  type BootElizaRuntimeOptions,
  getLastFailedPluginNames,
  loadElizaConfig,
  resolveDefaultAgentWorkspaceDir,
  resolveUserPath,
  type StartElizaOptions,
  applyCloudConfigToEnv as upstreamApplyCloudConfigToEnv,
  applyN8nConfigToEnv as upstreamApplyN8nConfigToEnv,
  bootElizaRuntime as upstreamBootElizaRuntime,
  collectPluginNames as upstreamCollectPluginNames,
  configureLocalEmbeddingPlugin as upstreamConfigureLocalEmbeddingPlugin,
  shutdownRuntime as upstreamShutdownRuntime,
  startEliza as upstreamStartEliza,
} from "@elizaos/agent";
import {
  CHANNEL_PLUGIN_MAP as upstreamChannelPluginMap,
} from "@elizaos/agent/runtime/plugin-collector";
import {
  type AgentRuntime,
  AutonomyService,
  ChannelType,
  logger,
  ModelType,
  type Plugin,
  stringToUuid,
} from "@elizaos/core";

export {
  CUSTOM_PLUGINS_DIRNAME,
  resolvePackageEntry,
  scanDropInPlugins,
} from "@elizaos/agent";

import {
  resolveServerOnlyPort,
  syncResolvedApiPort,
} from "@elizaos/shared";
import { isNativeServerPlatform } from "../platform/is-native-server.js";
import { syncAppEnvToEliza, syncElizaEnvAliases } from "../utils/env.js";
import { ensureRuntimeSqlCompatibility } from "../utils/sql-compat.js";
import type { EmbeddingProgressCallback } from "./embedding-manager-support.js";
import {
  DEFAULT_MODELS_DIR,
  embeddingGgufFilePresent,
  ensureModel,
  findExistingEmbeddingModelForWarmupReuse,
  isEmbeddingWarmupReuseDisabled,
} from "./embedding-manager-support.js";
import { detectEmbeddingPreset } from "./embedding-presets.js";
import { shouldWarmupLocalEmbeddingModel } from "./embedding-warmup-policy.js";
import { ensureLocalInferenceHandler } from "./ensure-local-inference-handler.js";
import {
  ensureTextToSpeechHandler,
  isEdgeTtsDisabled as isTextToSpeechEdgeTtsDisabled,
} from "./ensure-text-to-speech-handler.js";
import { updateStartupEmbeddingProgress } from "./startup-overlay.js";

const AUTONOMY_WORLD_ID = stringToUuid("00000000-0000-0000-0000-000000000001");
const AUTONOMY_ENTITY_ID = stringToUuid("00000000-0000-0000-0000-000000000002");
const AUTONOMY_MESSAGE_SERVER_ID = stringToUuid("autonomy-message-server");
const INTERNAL_CHANNEL_PLUGIN_OVERRIDES = {
  signal: "@elizaos/plugin-signal",
  whatsapp: "@elizaos/plugin-whatsapp",
  wechat: "elizaoswechat",
} as const;

/** Swarm / PTY paths call TEXT_TO_SPEECH; Edge TTS supplies that model with no API key. */
const AGENT_ORCHESTRATOR_PLUGIN = "agent-orchestrator";
const EDGE_TTS_PLUGIN = "@elizaos/plugin-edge-tts";
const require = createRequire(import.meta.url);
const DIRECT_HELP_FLAGS = new Set(["-h", "--help", "help"]);
const DIRECT_VERSION_FLAGS = new Set(["-v", "-V", "--version", "version"]);
const PLUGIN_SQL_GLOBAL_SINGLETONS = Symbol.for(
  "@elizaos/plugin-sql/global-singletons",
);
const ELIZA_AUTO_RESET_PGLITE_ERROR_CODE = "ELIZA_PGLITE_MANUAL_RESET_REQUIRED";

export const shutdownRuntime = upstreamShutdownRuntime;

interface PluginSqlGlobalSingletons {
  pgLiteClientManager?: {
    close?: () => Promise<unknown> | unknown;
  };
}

type ErrorWithCause = Error & {
  cause?: unknown;
  code?: unknown;
  dataDir?: unknown;
};

type AutonomyServiceLike = {
  enableAutonomy(): Promise<void>;
};

function isAutonomyService(value: unknown): value is AutonomyServiceLike {
  return (
    typeof value === "object" &&
    value !== null &&
    "enableAutonomy" in value &&
    typeof value.enableAutonomy === "function"
  );
}

export const CHANNEL_PLUGIN_MAP = {
  ...upstreamChannelPluginMap,
  ...INTERNAL_CHANNEL_PLUGIN_OVERRIDES,
};

/** Guards against registering signal handlers more than once. */
let signalHandlersRegistered = false;

interface EntityLike {
  id: string;
  agentId?: string;
  names?: string[];
  metadata?: Record<string, unknown>;
}

interface RuntimeAutonomyCompat {
  getEntityById?: (id: string) => Promise<EntityLike | null>;
  createEntity?: (entity: {
    id: string;
    names: string[];
    agentId: string;
    metadata?: Record<string, unknown>;
  }) => Promise<boolean>;
  updateEntity?: (entity: EntityLike & { agentId: string }) => Promise<boolean>;
  ensureWorldExists?: (world: {
    id: string;
    name: string;
    agentId: string;
    messageServerId?: string;
    metadata?: Record<string, unknown>;
  }) => Promise<unknown>;
  ensureRoomExists?: (room: {
    id: string;
    name: string;
    worldId: string;
    source: string;
    type: ChannelType;
    metadata?: Record<string, unknown>;
  }) => Promise<unknown>;
  ensureParticipantInRoom?: (
    entityId: string,
    roomId: string,
  ) => Promise<unknown>;
  addParticipant?: (entityId: string, roomId: string) => Promise<unknown>;
}

interface RuntimeAdapterAutonomyCompat {
  upsertEntities?: (
    entities: Array<{
      id: string;
      names: string[];
      agentId: string;
      metadata?: Record<string, unknown>;
    }>,
  ) => Promise<unknown>;
}

interface RuntimeModelCompat {
  useModel?: (
    type: (typeof ModelType)[keyof typeof ModelType] | string,
    params: { prompt: string },
  ) => Promise<unknown>;
}

function getAutonomyService(runtime: AgentRuntime): AutonomyServiceLike | null {
  const svc = runtime.getService("AUTONOMY") ?? runtime.getService("autonomy");
  if (isAutonomyService(svc)) {
    return svc;
  }
  return null;
}

async function startAndRegisterAutonomyService(
  runtime: AgentRuntime,
): Promise<AutonomyServiceLike> {
  const service = await AutonomyService.start(runtime);
  runtime.services.set("AUTONOMY" as never, [service as never]);
  return service;
}

function syncBrandEnvAliases(): void {
  syncElizaEnvAliases();
  syncAppEnvToEliza();
}

export function collectPluginNames(
  ...args: Parameters<typeof upstreamCollectPluginNames>
): ReturnType<typeof upstreamCollectPluginNames> {
  syncBrandEnvAliases();
  const [config] = args;
  const result = upstreamCollectPluginNames(...args);
  if (
    result.has(AGENT_ORCHESTRATOR_PLUGIN) &&
    !isTextToSpeechEdgeTtsDisabled(config) &&
    !result.has(EDGE_TTS_PLUGIN)
  ) {
    result.add(EDGE_TTS_PLUGIN);
  }
  syncBrandEnvAliases();
  return result;
}

export function applyCloudConfigToEnv(
  ...args: Parameters<typeof upstreamApplyCloudConfigToEnv>
): ReturnType<typeof upstreamApplyCloudConfigToEnv> {
  syncBrandEnvAliases();
  const result = upstreamApplyCloudConfigToEnv(...args);
  syncBrandEnvAliases();
  return result;
}

export function applyN8nConfigToEnv(
  ...args: Parameters<typeof upstreamApplyN8nConfigToEnv>
): ReturnType<typeof upstreamApplyN8nConfigToEnv> {
  syncBrandEnvAliases();
  // On mobile (iOS / Android) the local n8n sidecar cannot run — spawning a
  // child process via node:child_process is unavailable. Treat
  // `config.n8n.localEnabled` as false regardless of the stored user setting
  // so the env pump only considers the Eliza Cloud gateway path. The stored
  // config is not mutated.
  if (isNativeServerPlatform()) {
    const [config, agentId] = args;
    const mobileConfig =
      config?.n8n?.localEnabled === false
        ? config
        : { ...config, n8n: { ...(config.n8n ?? {}), localEnabled: false } };
    const result = upstreamApplyN8nConfigToEnv(mobileConfig, agentId);
    syncBrandEnvAliases();
    return result;
  }
  const result = upstreamApplyN8nConfigToEnv(...args);
  syncBrandEnvAliases();
  return result;
}

async function ensureAutonomyBootstrapContext(
  runtime: AgentRuntime,
): Promise<void> {
  const runtimeWithCompat = runtime as AgentRuntime & RuntimeAutonomyCompat;
  const adapter = runtime.adapter as RuntimeAdapterAutonomyCompat | undefined;
  const autonomousRoomId = stringToUuid(`autonomy-room-${runtime.agentId}`);

  await runtimeWithCompat.ensureWorldExists?.({
    id: AUTONOMY_WORLD_ID,
    name: "Autonomy World",
    agentId: runtime.agentId,
    messageServerId: AUTONOMY_MESSAGE_SERVER_ID,
    metadata: {
      type: "autonomy",
      description: "World for autonomous agent thinking",
    },
  });

  await runtimeWithCompat.ensureRoomExists?.({
    id: autonomousRoomId,
    name: "Autonomous Thoughts",
    worldId: AUTONOMY_WORLD_ID,
    source: "autonomy-service",
    type: ChannelType.SELF,
    metadata: {
      source: "autonomy-service",
      description: "Room for autonomous agent thinking",
    },
  });

  const autonomyEntity = {
    id: AUTONOMY_ENTITY_ID,
    names: ["Autonomy"],
    agentId: runtime.agentId,
    metadata: {
      type: "autonomy",
      description: "Dedicated entity for autonomy service prompts",
    },
  };
  const existingEntity =
    (await runtimeWithCompat.getEntityById?.(AUTONOMY_ENTITY_ID)) ?? null;

  if (!existingEntity) {
    const created = await runtimeWithCompat.createEntity?.(autonomyEntity);
    if (!created && adapter?.upsertEntities) {
      await adapter.upsertEntities([autonomyEntity]);
    }
  } else if (existingEntity.agentId !== runtime.agentId) {
    if (runtimeWithCompat.updateEntity) {
      await runtimeWithCompat.updateEntity({
        ...existingEntity,
        agentId: runtime.agentId,
      });
    } else if (adapter?.upsertEntities) {
      await adapter.upsertEntities([
        {
          id: existingEntity.id ?? AUTONOMY_ENTITY_ID,
          names:
            existingEntity.names && existingEntity.names.length > 0
              ? existingEntity.names
              : autonomyEntity.names,
          agentId: runtime.agentId,
          metadata: {
            ...autonomyEntity.metadata,
            ...(existingEntity.metadata ?? {}),
          },
        },
      ]);
    }
  }

  if (runtimeWithCompat.ensureParticipantInRoom) {
    await runtimeWithCompat.ensureParticipantInRoom(
      runtime.agentId,
      autonomousRoomId,
    );
    await runtimeWithCompat.ensureParticipantInRoom(
      AUTONOMY_ENTITY_ID,
      autonomousRoomId,
    );
  } else if (runtimeWithCompat.addParticipant) {
    await runtimeWithCompat.addParticipant(runtime.agentId, autonomousRoomId);
    await runtimeWithCompat.addParticipant(
      AUTONOMY_ENTITY_ID,
      autonomousRoomId,
    );
  }
}

// ---------------------------------------------------------------------------
// App route plugins — Vincent, Shopify, Steward
// Phase 2 extraction: routes previously hardcoded in server.ts are now
// registered as proper plugins with rawPath routes.
// ---------------------------------------------------------------------------

async function registerAppRoutePlugins(runtime: AgentRuntime): Promise<void> {
  const pluginLoaders: Array<() => Promise<Plugin>> = [
    async () => (await import("@elizaos/app-vincent/plugin")).vincentPlugin,
    async () => (await import("@elizaos/app-shopify/plugin")).shopifyPlugin,
    async () => (await import("@elizaos/app-steward/plugin")).stewardPlugin,
    async () => (await import("@elizaos/app-lifeops/public")).lifeopsPlugin,
  ];

  for (const loadPlugin of pluginLoaders) {
    try {
      const plugin = await loadPlugin();
      // Push rawPath routes directly onto runtime.routes to avoid the core's
      // registerPlugin() path mangling (which prepends /<pluginName>/ to every
      // route path). The rawPath flag means these routes already have their
      // final absolute paths (e.g. /api/lifeops/app-state).
      if (plugin.routes?.length) {
        for (const route of plugin.routes) {
          const routePath = route.path.startsWith("/")
            ? route.path
            : `/${route.path}`;
          runtime.routes.push({ ...route, path: routePath });
        }
      }
      logger.info(
        `[eliza] Registered app route plugin: ${plugin.name} (${plugin.routes?.length ?? 0} routes)`,
      );
    } catch (err) {
      logger.warn(
        `[eliza] Failed to register app route plugin: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
}

/**
 * Register the nightly Track C training crons (trajectory export + skill
 * scoring) against the live runtime. The @elizaos/app-training package is
 * optional — if it is not installed, the dynamic import fails and we skip
 * silently. Each underlying registration also no-ops when the CRON service
 * is missing, so installs without plugin-cron are safe.
 */
async function registerTrackCTrainingCrons(
  runtime: AgentRuntime,
): Promise<void> {
  // `@elizaos/app-training` is an optional dependency: the package may not be
  // installed at all in minimal deployments. Scope the try/catch to the
  // dynamic imports so a missing package logs a skip, but real errors inside
  // the registration helpers propagate with full context.
  let exportMod: typeof import("@elizaos/app-training/core/trajectory-export-cron");
  let scoringMod: typeof import("@elizaos/app-training/core/skill-scoring-cron");
  let triggerMod: typeof import("@elizaos/app-training/services/training-trigger");
  try {
    [exportMod, scoringMod, triggerMod] = await Promise.all([
      import("@elizaos/app-training/core/trajectory-export-cron"),
      import("@elizaos/app-training/core/skill-scoring-cron"),
      import("@elizaos/app-training/services/training-trigger"),
    ]);
  } catch (err) {
    logger.warn(
      `[eliza] @elizaos/app-training not installed, skipping Track C training crons: ${err instanceof Error ? err.message : String(err)}`,
    );
    return;
  }

  await exportMod.registerTrajectoryExportCron(runtime);
  await scoringMod.registerSkillScoringCron(runtime);
  const triggerService = triggerMod.registerTrainingTriggerService(runtime);
  logger.info(
    "[eliza] Registered Track C training crons + auto-train trigger service",
  );
  // Phase 5.5 — Hermes-parity default-on bootstrap. Fire-and-forget so
  // runtime boot stays fast; the bootstrap helper short-circuits when
  // counters are below threshold or an artifact already exists. We log the
  // rejection instead of swallowing so a bug in the bootstrap helper is
  // surfaced at boot time rather than silently lost.
  void triggerMod
    .bootstrapOptimizationFromAccumulatedTrajectories(runtime, triggerService)
    .then((fired) => {
      if (fired.length > 0) {
        logger.info(
          `[eliza] Bootstrapped prompt optimization for ${fired.join(", ")}`,
        );
      }
    })
    .catch((err) => {
      logger.error(
        `[eliza] bootstrapOptimizationFromAccumulatedTrajectories failed: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`,
      );
    });
}

async function repairRuntimeAfterBoot(
  runtime: AgentRuntime,
): Promise<AgentRuntime> {
  await ensureRuntimeSqlCompatibility(runtime);
  await ensureTextToSpeechHandler(runtime);
  await ensureLocalInferenceHandler(runtime);
  await ensureAutonomyBootstrapContext(runtime);

  // ── Register app-specific route plugins (Phase 2 extraction) ────────
  // These were previously hardcoded dispatch blocks in server.ts. Now they
  // are proper plugins with rawPath routes served via the runtime plugin
  // route system.
  await registerAppRoutePlugins(runtime);

  // ── Register Track C training crons (trajectory export + skill scoring) ─
  // Optional: only runs when @elizaos/app-training is installed. Both cron
  // registrations internally no-op when the CRON service is unavailable, so
  // installs without plugin-cron are also safe.
  await registerTrackCTrainingCrons(runtime);

  if (!runtime.getService("AUTONOMY")) {
    try {
      await startAndRegisterAutonomyService(runtime);
      logger.info(
        "[eliza] AutonomyService started after SQL compatibility repair",
      );
    } catch (error) {
      throw new Error(
        `[eliza] AutonomyService restart after SQL compatibility repair failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  // Enable the autonomy loop so trigger/heartbeat instructions are processed.
  {
    const autonomySvc = getAutonomyService(runtime);
    if (autonomySvc) {
      try {
        await autonomySvc.enableAutonomy();
        logger.info(
          "[eliza] AutonomyService enabled — trigger instructions will be processed",
        );
      } catch (err) {
        throw new Error(
          `[eliza] Failed to enable autonomy loop: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  }

  // Ensure Telegram bot is polling. The upstream plugin's bot.launch() is
  // not awaited and silently fails on bun/Windows. We create a standalone
  // Telegraf instance with proper lifecycle management.
  await ensureTelegramBotPolling(runtime);

  // Bridge Eliza Cloud auth transitions → n8n sidecar lifecycle so signing
  // in releases the local sidecar (saves port 5678 + ~200MB) and signing
  // out proactively re-spawns it (when localEnabled and not mobile).
  await ensureN8nAuthBridge(runtime);

  // Kick the local n8n sidecar off at boot so the first Workflows-tab open
  // (or a scheduled job dispatch) doesn't pay the ~10-20s `bunx n8n` cold
  // start. Runs after the auth bridge so the bridge owns dispose-on-signin.
  await ensureN8nAutoStart(runtime);

  // Register the N8N_DISPATCH service so trigger dispatchers carrying
  // `kind: "workflow"` can call runtime.getService("N8N_DISPATCH").execute(id).
  // Mode selection (cloud / local / disabled) is deferred to each dispatch
  // call via resolveN8nMode, so this does not depend on autostart readiness.
  await ensureN8nDispatchService(runtime);

  return runtime;
}

// Module-level handle for the n8n auth bridge, reset across hot-reloads so
// the previous poller does not race the fresh runtime's CLOUD_AUTH service.
let _n8nAuthBridge: { stop: () => void } | null = null;

// Module-level handle for the boot-time n8n autostart. Like the auth
// bridge this is reset across hot-reloads so we never leave two timers
// racing the singleton.
let _n8nAutoStart: {
  stop: () => Promise<void>;
  poke: () => Promise<void>;
} | null = null;

// Module-level handle for the N8N_DISPATCH service instance. Kept across
// hot-reloads so we can clear the runtime.services slot on shutdown without
// leaking closures that hold a stale runtime reference.
let _n8nDispatch: { execute: (workflowId: string) => Promise<unknown> } | null =
  null;

async function ensureN8nAuthBridge(runtime: AgentRuntime): Promise<void> {
  if (_n8nAuthBridge) {
    try {
      _n8nAuthBridge.stop();
    } catch {
      /* ignore */
    }
    _n8nAuthBridge = null;
  }
  try {
    const [{ startN8nAuthBridge }, config] = await Promise.all([
      import("../services/n8n-auth-bridge.js"),
      Promise.resolve(loadElizaConfig()),
    ]);
    _n8nAuthBridge = startN8nAuthBridge(runtime, config, {
      getConfig: () => loadElizaConfig(),
    });
    logger.info("[eliza] n8n auth bridge armed");
  } catch (err) {
    logger.warn(
      `[eliza] Failed to start n8n auth bridge: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
}

async function ensureN8nAutoStart(runtime: AgentRuntime): Promise<void> {
  if (_n8nAutoStart) {
    try {
      await _n8nAutoStart.stop();
    } catch {
      /* ignore */
    }
    _n8nAutoStart = null;
  }
  try {
    const [{ startN8nAutoStart }, config] = await Promise.all([
      import("../services/n8n-autostart.js"),
      Promise.resolve(loadElizaConfig()),
    ]);
    _n8nAutoStart = startN8nAutoStart(runtime, config, {
      getConfig: () => loadElizaConfig(),
    });
    logger.info("[eliza] n8n autostart armed");
  } catch (err) {
    logger.warn(
      `[eliza] Failed to start n8n autostart: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
}

async function ensureN8nDispatchService(runtime: AgentRuntime): Promise<void> {
  // Clear any prior instance so a hot-reloaded runtime never holds a stale
  // closure binding to a discarded AgentRuntime.
  if (_n8nDispatch) {
    try {
      runtime.services.delete("N8N_DISPATCH" as never);
    } catch {
      /* ignore */
    }
    _n8nDispatch = null;
  }
  try {
    const { createN8nDispatchService } = await import(
      "../services/n8n-dispatch.js"
    );
    const dispatchInstance = createN8nDispatchService({
      runtime,
      getConfig: () => loadElizaConfig(),
    });
    _n8nDispatch = dispatchInstance;
    // Register directly into the runtime services map. `registerService`
    // expects a Service class with a static `start()`, which is a poor fit
    // for a pre-constructed function-based service. The map-set pattern
    // mirrors `runtime/plugin-lifecycle.ts` and `test/scripts/*.ts`.
    const serviceEntry = {
      execute: dispatchInstance.execute,
      // Minimum Service surface so downstream code that does instanceof or
      // reads `.stop()` does not throw. Dispatch has no external state to
      // tear down; stop is a no-op.
      stop: async () => {},
      capabilityDescription: "Executes n8n workflows by id.",
    };
    runtime.services.set("N8N_DISPATCH" as never, [serviceEntry as never]);
    logger.info("[eliza] n8n dispatch service registered");
  } catch (err) {
    logger.warn(
      `[eliza] Failed to register n8n dispatch service: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
}

// Module-level Telegraf bot reference for lifecycle management across restarts.
let _telegramBot: { stop: (reason?: string) => void } | null = null;

async function ensureTelegramBotPolling(runtime: AgentRuntime): Promise<void> {
  // Stop any previous bot instance
  if (_telegramBot) {
    try {
      _telegramBot.stop("restart");
    } catch {
      /* ignore */
    }
    _telegramBot = null;
    await new Promise((r) => setTimeout(r, 1000));
  }

  const botToken = process.env.TELEGRAM_BOT_TOKEN;
  if (!botToken) return;

  try {
    const { Telegraf } = await import("telegraf");
    const apiRoot = process.env.TELEGRAM_API_ROOT || "https://api.telegram.org";
    const bot = new Telegraf(botToken, { telegram: { apiRoot } });

    // Build character context for personality
    const char = runtime.character ?? ({} as Record<string, unknown>);
    const bioText = Array.isArray(char.bio)
      ? char.bio.join(" ")
      : (char.bio ?? "");
    const loreText = Array.isArray((char as Record<string, unknown>).lore)
      ? ((char as Record<string, unknown>).lore as string[]).join(" ")
      : "";
    const styleText = (() => {
      const s = (char as Record<string, unknown>).style as
        | Record<string, string[]>
        | undefined;
      if (!s) return "";
      const parts: string[] = [];
      if (s.all?.length) parts.push(s.all.join(" "));
      if (s.chat?.length) parts.push(s.chat.join(" "));
      return parts.join(" ");
    })();
    const systemPrompt = [
      `You are ${char.name}.`,
      char.system ?? "",
      bioText ? `Bio: ${bioText}` : "",
      loreText ? `Lore: ${loreText}` : "",
      styleText ? `Style: ${styleText}` : "",
      "Respond in character. Keep responses concise for chat.",
    ]
      .filter(Boolean)
      .join("\n");

    const chatHistories = new Map<
      number,
      Array<{ role: string; content: string }>
    >();

    bot.on(
      "message",
      async (ctx: {
        message: {
          text?: string;
          from?: { username?: string; first_name?: string };
          chat?: { id: number };
        };
        reply: (t: string) => Promise<unknown>;
      }) => {
        try {
          const text = ctx.message?.text;
          if (!text) return;
          const chatId = ctx.message.chat?.id ?? 0;

          // Check allowed chats (reads live from process.env — no restart needed)
          const allowedChats = process.env.TELEGRAM_ALLOWED_CHATS;
          if (
            allowedChats &&
            allowedChats.trim() !== "" &&
            allowedChats.trim() !== "[]"
          ) {
            try {
              if (
                !(JSON.parse(allowedChats) as string[]).includes(String(chatId))
              )
                return;
            } catch {
              return;
            }
          }

          const username =
            ctx.message.from?.username ??
            ctx.message.from?.first_name ??
            "Unknown";
          logger.info(
            `[eliza] Telegram message from @${username}: ${text.substring(0, 80)}`,
          );

          let history = chatHistories.get(chatId);
          if (!history) {
            history = [];
            // Evict least-recently-used chat to prevent unbounded memory growth
            if (chatHistories.size >= 500) {
              const oldest = chatHistories.keys().next().value;
              if (oldest !== undefined) chatHistories.delete(oldest);
            }
          } else {
            // Move to end of Map iteration order (most-recently-used)
            chatHistories.delete(chatId);
          }
          chatHistories.set(chatId, history);
          history.push({ role: "user", content: `@${username}: ${text}` });
          if (history.length > 20) history.splice(0, history.length - 20);

          try {
            const conv = history
              .map(
                (m) =>
                  `${m.role === "user" ? "User" : char.name}: ${m.content}`,
              )
              .join("\n");
            const modelRuntime = runtime as AgentRuntime & RuntimeModelCompat;
            if (typeof modelRuntime.useModel !== "function") {
              logger.warn("[eliza] Telegram runtime missing useModel");
              return;
            }
            // biome-ignore lint/correctness/useHookAtTopLevel: false positive, hook is at module level
            const response = await modelRuntime.useModel(ModelType.TEXT_LARGE, {
              prompt: `${systemPrompt}\n\nConversation:\n${conv}\n\n${char.name}:`,
            });
            const responseText =
              typeof response === "string"
                ? response
                : ((response as { text?: string })?.text ?? "");
            if (responseText) {
              history.push({ role: "assistant", content: responseText });
              await ctx.reply(responseText);
              logger.info(`[eliza] Telegram replied to @${username}`);
            }
          } catch (err) {
            logger.warn(
              `[eliza] Telegram response error: ${err instanceof Error ? err.message : String(err)}`,
            );
            await ctx
              .reply("Sorry, I encountered an error processing your message.")
              .catch(() => {});
          }
        } catch (outerErr) {
          logger.warn(
            `[eliza] Telegram handler error: ${outerErr instanceof Error ? outerErr.message : String(outerErr)}`,
          );
        }
      },
    );

    bot.catch((err: unknown) =>
      logger.warn(
        `[eliza] Telegram bot error: ${err instanceof Error ? err.message : String(err)}`,
      ),
    );

    // Fire-and-forget — bot.launch() only resolves on stop()
    bot
      .launch({
        dropPendingUpdates: true,
        allowedUpdates: ["message", "message_reaction"],
      })
      .catch((err: unknown) =>
        logger.warn(
          `[eliza] Telegram bot launch error: ${err instanceof Error ? err.message : String(err)}`,
        ),
      );

    _telegramBot = bot;
    // Telegram bot cleanup is handled by the central signal handler in
    // startEliza() via _telegramBot — no separate registration needed.

    await new Promise((r) => setTimeout(r, 500));
    logger.info("[eliza] Telegram bot polling started");
  } catch (err) {
    logger.warn(
      `[eliza] Telegram bot setup failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

/**
 * Eagerly download the embedding model file if not already present.
 * This ensures the GGUF is on disk before the runtime's first
 * generateEmbedding() call, avoiding a silent stall on first use.
 *
 * Uses the same env resolution as `configureLocalEmbeddingPlugin` (eliza.json
 * `embedding` + hardware tier). Warmup previously always used tier-only presets,
 * so a custom `embedding.model` caused a first download here and a *second*
 * download when the plugin looked for a different filename — nothing deleted
 * the first file; it was simply the wrong path/name.
 *
 * If the configured GGUF is **not** on disk but another known embedding file
 * already exists in `MODELS_DIR` (e.g. legacy bge-small after `eliza.json`
 * switched to the 7B E5 preset), we align `LOCAL_EMBEDDING_*` with that file
 * so we do not re-download multi‑GB models. Opt out:
 * `ELIZA_EMBEDDING_WARMUP_NO_REUSE=1`.
 */
async function warmupEmbeddingModel(
  onProgress?: EmbeddingProgressCallback,
): Promise<void> {
  if (!shouldWarmupLocalEmbeddingModel()) {
    logger.info(
      "[eliza] Skipping local embedding (GGUF) warmup — not needed for this configuration (e.g. Eliza Cloud embeddings, or local embeddings disabled).",
    );
    return;
  }

  const config = loadElizaConfig();
  upstreamConfigureLocalEmbeddingPlugin({} as Plugin, config);

  const preset = detectEmbeddingPreset();
  const modelsDir = process.env.MODELS_DIR ?? DEFAULT_MODELS_DIR;
  let model = process.env.LOCAL_EMBEDDING_MODEL?.trim() || preset.model;
  let modelRepo =
    process.env.LOCAL_EMBEDDING_MODEL_REPO?.trim() || preset.modelRepo;

  if (
    !isEmbeddingWarmupReuseDisabled() &&
    !embeddingGgufFilePresent(modelsDir, model)
  ) {
    const reuse = findExistingEmbeddingModelForWarmupReuse(modelsDir);
    if (reuse) {
      logger.info(
        `[eliza] Embedding warmup: configured file "${model}" not found in MODELS_DIR — reusing existing ${reuse.model} to avoid a large re-download. ` +
          "Set LOCAL_EMBEDDING_MODEL or ELIZA_EMBEDDING_WARMUP_NO_REUSE=1 to force the configured model.",
      );
      process.env.LOCAL_EMBEDDING_MODEL = reuse.model;
      process.env.LOCAL_EMBEDDING_MODEL_REPO = reuse.modelRepo;
      process.env.LOCAL_EMBEDDING_DIMENSIONS = String(reuse.dimensions);
      process.env.LOCAL_EMBEDDING_CONTEXT_SIZE = String(reuse.contextSize);
      process.env.LOCAL_EMBEDDING_GPU_LAYERS = reuse.gpuLayers;
      process.env.LOCAL_EMBEDDING_USE_MMAP =
        reuse.gpuLayers === "auto" ? "false" : "true";
      model = reuse.model;
      modelRepo = reuse.modelRepo;
    }
  }

  logger.info(
    `[eliza] Local embedding warmup: ${model} (hardware tier preset: ${preset.label}). ` +
      "This file is for TEXT_EMBEDDING / memory only (not your conversation model).",
  );

  const progressCb: EmbeddingProgressCallback = (phase, detail) => {
    updateStartupEmbeddingProgress(phase, detail);
    // Always log to stdout for server/container monitoring
    if (phase === "downloading") {
      logger.info(`[eliza] Embedding model: ${detail ?? "downloading..."}`);
    } else if (phase === "loading") {
      logger.info(`[eliza] Embedding model: loading ${detail ?? ""}`);
    } else if (phase === "ready") {
      logger.info(`[eliza] Embedding model: ready (${detail ?? ""})`);
    }
    // Forward to caller's callback (e.g. for TUI loading screen)
    onProgress?.(phase, detail);
  };

  try {
    await ensureModel(modelsDir, modelRepo, model, false, progressCb);
  } catch (err) {
    // Non-fatal: the plugin will attempt its own download on first use
    logger.warn(
      `[eliza] Embedding model warmup failed (will retry on first use): ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

export interface BootElizaRuntimeOptionsExt extends BootElizaRuntimeOptions {
  /** Optional callback for embedding model download/init progress. */
  onEmbeddingProgress?: EmbeddingProgressCallback;
}

export async function bootElizaRuntime(
  opts: BootElizaRuntimeOptionsExt = {},
): Promise<Awaited<ReturnType<typeof upstreamBootElizaRuntime>>> {
  syncAppEnvToEliza();

  try {
    // Eagerly download the embedding model before the full runtime boot.
    // This way the TUI loading screen (or server logs) can show download
    // progress instead of the app silently stalling on first embedding call.
    await warmupEmbeddingModel(opts.onEmbeddingProgress);

    // Cap embedding dimension to 384 — plugin-sql's DIMENSION_MAP only
    // supports up to 3072, and the performance-tier E5-Mistral-7B model
    // outputs 4096-dim vectors which would silently fall back to 384 anyway.
    if (!process.env.EMBEDDING_DIMENSION) {
      process.env.EMBEDDING_DIMENSION = "384";
    }

    const runtime = await upstreamBootElizaRuntime(opts);
    return runtime ? await repairRuntimeAfterBoot(runtime) : runtime;
  } finally {
    syncElizaEnvAliases();
  }
}

export interface StartElizaOptionsExt extends StartElizaOptions {
  /** Optional callback for embedding model download/init progress. */
  onEmbeddingProgress?: EmbeddingProgressCallback;
}

function collectErrorObjects(err: unknown): ErrorWithCause[] {
  const chain: ErrorWithCause[] = [];
  const seen = new Set<unknown>();
  let current: unknown = err;

  while (current && !seen.has(current)) {
    seen.add(current);
    if (current instanceof Error) {
      chain.push(current as ErrorWithCause);
      current = (current as ErrorWithCause).cause;
      continue;
    }
    if (typeof current === "object" && current !== null) {
      const candidate = current as ErrorWithCause;
      chain.push(candidate);
      current = candidate.cause;
      continue;
    }
    break;
  }

  return chain;
}

function getPgliteErrorCode(err: unknown): string | null {
  for (const current of collectErrorObjects(err)) {
    if (typeof current.code === "string" && current.code) {
      return current.code;
    }
  }
  return null;
}

function collectErrorMessages(err: unknown): string[] {
  const messages: string[] = [];

  for (const current of collectErrorObjects(err)) {
    if (typeof current.message === "string" && current.message) {
      messages.push(current.message);
    }
  }

  return messages;
}

function isManualResetPgliteError(err: unknown): boolean {
  if (getPgliteErrorCode(err) === ELIZA_AUTO_RESET_PGLITE_ERROR_CODE) {
    return true;
  }

  return collectErrorMessages(err).some((message) => {
    const normalized = message.toLowerCase();
    if (
      normalized.includes(
        "rename or delete only this directory before retrying",
      )
    ) {
      return true;
    }

    if (
      normalized.includes("@elizaos/plugin-sql") &&
      normalized.includes("migrations._migrations")
    ) {
      return true;
    }

    return false;
  });
}

function getPgliteDataDirFromError(err: unknown): string | null {
  for (const current of collectErrorObjects(err)) {
    if (typeof current.dataDir === "string" && current.dataDir.trim()) {
      return current.dataDir;
    }
  }

  for (const message of collectErrorMessages(err)) {
    const retryPathMatch = message.match(
      /before retrying:\s*([^\n]+?)(?:\s*$|\.)/,
    );
    if (retryPathMatch?.[1]) {
      return retryPathMatch[1].trim();
    }

    const initPathMatch = message.match(
      /PGlite initialization failed for (.+?):/i,
    );
    if (initPathMatch?.[1]) {
      return initPathMatch[1].trim();
    }
  }

  return null;
}

function resolveManagedPgliteDataDir(): string | null {
  const envDataDir = process.env.PGLITE_DATA_DIR?.trim();
  if (envDataDir) {
    return resolveUserPath(envDataDir);
  }

  const config = loadElizaConfig();
  if ((config.database?.provider ?? "pglite") === "postgres") {
    return null;
  }

  const configuredDataDir = config.database?.pglite?.dataDir?.trim();
  if (configuredDataDir) {
    return resolveUserPath(configuredDataDir);
  }

  const workspaceDir =
    config.agents?.defaults?.workspace ?? resolveDefaultAgentWorkspaceDir();
  return path.join(resolveUserPath(workspaceDir), ".eliza", ".elizadb");
}

function isAutoResettablePgliteDir(dataDir: string | null): dataDir is string {
  return typeof dataDir === "string" && path.basename(dataDir) === ".elizadb";
}

async function resetPluginSqlPgliteSingleton(context: string): Promise<void> {
  const globalSymbols = globalThis as typeof globalThis &
    Record<symbol, PluginSqlGlobalSingletons | undefined>;
  const singletons = globalSymbols[PLUGIN_SQL_GLOBAL_SINGLETONS];
  const manager = singletons?.pgLiteClientManager;

  if (manager && typeof manager.close === "function") {
    let closeTimedOut = false;
    let timeoutHandle: ReturnType<typeof setTimeout> | null = null;

    try {
      await Promise.race([
        Promise.resolve(manager.close()),
        new Promise<void>((resolve) => {
          timeoutHandle = setTimeout(() => {
            closeTimedOut = true;
            resolve();
          }, 1_000);
        }),
      ]);
    } catch (err) {
      logger.warn(
        `[eliza] ${context}: failed to close plugin-sql PGlite singleton: ${err instanceof Error ? err.message : String(err)}`,
      );
    } finally {
      if (timeoutHandle) {
        clearTimeout(timeoutHandle);
      }
    }

    if (closeTimedOut) {
      logger.warn(
        `[eliza] ${context}: plugin-sql PGlite singleton close timed out; continuing with a forced reset`,
      );
    }
  }

  if (singletons?.pgLiteClientManager) {
    delete singletons.pgLiteClientManager;
  }
}

async function quarantinePgliteDataDir(
  dataDir: string,
): Promise<string | null> {
  if (!existsSync(dataDir)) {
    return null;
  }

  const parentDir = path.dirname(dataDir);
  const baseName = path.basename(dataDir);
  let attempt = 0;

  while (attempt < 1000) {
    const suffix = attempt === 0 ? `${Date.now()}` : `${Date.now()}-${attempt}`;
    const backupDir = path.join(parentDir, `${baseName}.corrupt-${suffix}`);
    if (existsSync(backupDir)) {
      attempt += 1;
      continue;
    }
    await rename(dataDir, backupDir);
    return backupDir;
  }

  throw new Error(`Could not allocate a backup path for ${dataDir}`);
}

function normalizePgliteStartupError(err: unknown): unknown {
  if (!isManualResetPgliteError(err)) {
    return err;
  }

  if (
    err instanceof Error &&
    getPgliteErrorCode(err) === ELIZA_AUTO_RESET_PGLITE_ERROR_CODE
  ) {
    return err;
  }

  const dataDir =
    getPgliteDataDirFromError(err) ?? resolveManagedPgliteDataDir();
  const detail =
    collectErrorMessages(err)[0] ??
    (err instanceof Error ? err.message : String(err));
  const wrapped = new Error(
    dataDir
      ? `PGlite initialization failed for ${dataDir}: ${detail}. Stop the app, then rename or delete only this directory before retrying: ${dataDir}`
      : `PGlite initialization failed: ${detail}. Stop the app, then rename or delete only the managed PGlite data directory before retrying.`,
    { cause: err },
  ) as ErrorWithCause;
  wrapped.code = ELIZA_AUTO_RESET_PGLITE_ERROR_CODE;
  if (dataDir) {
    wrapped.dataDir = dataDir;
  }
  return wrapped;
}

async function upstreamStartElizaWithPgliteCompat(
  options?: StartElizaOptions,
): Promise<Awaited<ReturnType<typeof upstreamStartEliza>>> {
  try {
    return await upstreamStartEliza(options);
  } catch (err) {
    throw normalizePgliteStartupError(err);
  }
}

export async function attemptPgliteAutoReset(
  err: unknown,
): Promise<string | null> {
  if (!isManualResetPgliteError(err)) {
    return null;
  }

  const dataDir =
    getPgliteDataDirFromError(err) ?? resolveManagedPgliteDataDir();
  if (!isAutoResettablePgliteDir(dataDir)) {
    return null;
  }

  logger.warn(
    `[eliza] PGlite startup failed for ${dataDir}. Quarantining the local database before retrying.`,
  );

  await resetPluginSqlPgliteSingleton("PGlite auto-reset");
  const backupDir = await quarantinePgliteDataDir(dataDir);

  if (backupDir) {
    logger.warn(`[eliza] Moved the previous PGlite data dir to ${backupDir}`);
  }

  await resetPluginSqlPgliteSingleton("PGlite auto-reset retry");
  return backupDir;
}

export function getPgliteRecoveryRetrySkipPlugins(): string[] {
  return getLastFailedPluginNames();
}

export async function startEliza(
  options?: StartElizaOptionsExt,
): Promise<Awaited<ReturnType<typeof upstreamStartEliza>>> {
  syncAppEnvToEliza();
  // Eliza app: load PTY / coding-swarm orchestration unless explicitly opted out.
  const orchRaw = process.env.ELIZA_AGENT_ORCHESTRATOR?.trim().toLowerCase();
  if (orchRaw !== "0" && orchRaw !== "false" && orchRaw !== "no") {
    process.env.ELIZA_AGENT_ORCHESTRATOR = "1";
  }

  try {
    // Eagerly download the embedding model with progress reporting
    await warmupEmbeddingModel(options?.onEmbeddingProgress);

    // Cap embedding dimension to 384 — see comment in bootElizaRuntime.
    if (!process.env.EMBEDDING_DIMENSION) {
      process.env.EMBEDDING_DIMENSION = "384";
    }

    if (options?.serverOnly) {
      let currentRuntime =
        (await upstreamStartElizaWithPgliteCompat({
          ...options,
          headless: true,
          serverOnly: false,
        })) ?? undefined;

      currentRuntime = currentRuntime
        ? await repairRuntimeAfterBoot(currentRuntime)
        : currentRuntime;

      if (!currentRuntime) {
        return currentRuntime;
      }

      const { startApiServer } = await import("../api/server");
      const apiPort = resolveServerOnlyPort(process.env);
      const { port: actualApiPort } = await startApiServer({
        port: apiPort,
        runtime: currentRuntime,
        onRestart: async () => {
          if (!currentRuntime) {
            return null;
          }

          await upstreamShutdownRuntime(currentRuntime, "server-only restart");

          const restarted =
            (await upstreamStartElizaWithPgliteCompat({
              ...options,
              headless: true,
              serverOnly: false,
            })) ?? undefined;

          currentRuntime = restarted
            ? await repairRuntimeAfterBoot(restarted)
            : undefined;

          return currentRuntime ?? null;
        },
      });

      // WHY: `startApiServer` may bind a different port than requested (busy
      // socket, upstream policy). Shells, scripts, and follow-up code reading
      // env must match the real listener or health checks and user-facing URLs
      // disagree with `GET /api/health`.
      syncResolvedApiPort(process.env, actualApiPort, {
        overwriteUiPort: true,
      });
      // Invalidate cached CORS port set so the new port is allowed.
      try {
        const { invalidateCorsAllowedPorts } = await import(
          "../api/server-cors.js"
        );
        invalidateCorsAllowedPorts();
      } catch {}

      logger.info(
        `[eliza] API server listening on http://localhost:${actualApiPort}`,
      );
      console.log(`[eliza] Control UI: http://localhost:${actualApiPort}`);
      console.log("[eliza] Server running. Press Ctrl+C to stop.");

      const keepAlive = setInterval(() => {}, 1 << 30);
      let isCleaningUp = false;
      const cleanup = async () => {
        if (isCleaningUp) {
          return;
        }
        isCleaningUp = true;
        clearInterval(keepAlive);
        // Force exit if graceful shutdown hangs for more than 10 seconds.
        const forceExitTimer = setTimeout(() => {
          logger.warn("[eliza] Shutdown timed out after 10s — forcing exit");
          process.exit(1);
        }, 10_000);
        forceExitTimer.unref?.();
        // Stop Telegram bot if running (previously registered via separate process.once handlers)
        if (_telegramBot) {
          try {
            _telegramBot.stop("SIGINT");
          } catch {
            /* ignore */
          }
        }
        if (currentRuntime) {
          await upstreamShutdownRuntime(currentRuntime, "server-only shutdown");
        }
        // Clear the n8n dispatch service slot. The service owns no external
        // state (no timers, no sockets), so just drop the reference so a
        // subsequent boot registers a fresh closure on the new runtime.
        if (_n8nDispatch) {
          _n8nDispatch = null;
        }
        // Stop the boot-time autostart first so its pending evaluate()
        // cannot construct a new sidecar while we tear down.
        if (_n8nAutoStart) {
          try {
            await _n8nAutoStart.stop();
          } catch {
            /* ignore */
          }
          _n8nAutoStart = null;
        }
        // Stop the n8n auth bridge next so the poller does not try to
        // spawn a fresh sidecar while we are tearing down.
        if (_n8nAuthBridge) {
          try {
            _n8nAuthBridge.stop();
          } catch {
            /* ignore */
          }
          _n8nAuthBridge = null;
        }
        // Stop the n8n sidecar if it was started during this session. The
        // singleton is lazily constructed, so this is a no-op when n8n was
        // never used.
        try {
          const { disposeN8nSidecar } = await import(
            "../services/n8n-sidecar.js"
          );
          await disposeN8nSidecar();
        } catch {
          /* non-critical — best effort */
        }
        process.exit(0);
      };

      if (!signalHandlersRegistered) {
        signalHandlersRegistered = true;
        process.on("SIGINT", () => void cleanup());
        process.on("SIGTERM", () => void cleanup());
      }
      return currentRuntime;
    }

    const runtime = await upstreamStartElizaWithPgliteCompat(options);
    return runtime ? await repairRuntimeAfterBoot(runtime) : runtime;
  } finally {
    syncElizaEnvAliases();
  }
}

function isDirectRuntimeRun(): boolean {
  const scriptArg = process.argv[1];
  if (!scriptArg) {
    return false;
  }
  return import.meta.url === pathToFileURL(path.resolve(scriptArg)).href;
}

function printDirectRuntimeHelp(): void {
  console.log(`eliza runtime

Usage:
  bun packages/app-core/src/runtime/eliza.ts
  bun run start:eliza

Flags:
  --help, -h       Show this help
  --version, -v    Show the app-core package version

For full CLI help, run:
  bun run eliza --help`);
}

function printDirectRuntimeVersion(): void {
  const pkg = require("../../package.json") as { version?: string };
  console.log(pkg.version ?? "unknown");
}

if (isDirectRuntimeRun()) {
  const command = process.argv[2];
  if (DIRECT_HELP_FLAGS.has(command ?? "")) {
    printDirectRuntimeHelp();
  } else if (DIRECT_VERSION_FLAGS.has(command ?? "")) {
    printDirectRuntimeVersion();
  } else {
    startEliza().catch((err) => {
      console.error(
        "[eliza] Fatal error:",
        err instanceof Error ? (err.stack ?? err.message) : err,
      );
      process.exit(1);
    });
  }
}
