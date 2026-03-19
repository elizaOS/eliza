/**
 * elizaOS runtime entry point for Milady.
 *
 * Starts the elizaOS agent runtime with Milady's plugin configuration.
 * Can be run directly via: node --import tsx src/runtime/eliza.ts
 * Or via the CLI: milady start
 *
 * @module eliza
 */
import crypto from "node:crypto";
import type { Dirent } from "node:fs";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  symlinkSync,
  unlinkSync,
} from "node:fs";
import fs from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import * as readline from "node:readline";
import { fileURLToPath, pathToFileURL } from "node:url";

// @clack/prompts is loaded lazily inside runFirstTimeSetup() so the
// packaged desktop app (which never runs interactive onboarding) does
// not crash when the package is unavailable.
type ClackModule = typeof import("@clack/prompts");
let _clack: ClackModule | null = null;
async function loadClack(): Promise<ClackModule> {
  if (!_clack) _clack = await import("@clack/prompts");
  return _clack;
}

import {
  AgentRuntime,
  AutonomyService,
  addLogListener,
  ChannelType,
  type Character,
  type Component,
  createMessageMemory,
  type Entity,
  type LogEntry,
  logger,
  // loggerScope, // removed
  mergeCharacterDefaults,
  type Plugin,
  type Provider,
  stringToUuid,
  type TargetInfo,
  type UUID,
} from "@elizaos/core";
import * as pluginAgentOrchestrator from "@elizaos/plugin-agent-orchestrator";
import * as pluginAgentSkills from "@elizaos/plugin-agent-skills";
import * as pluginAnthropic from "@elizaos/plugin-anthropic";
import * as pluginCron from "@elizaos/plugin-cron";
import * as pluginElizacloud from "@elizaos/plugin-elizacloud";
import * as pluginExperience from "@elizaos/plugin-experience";
import * as pluginForm from "@elizaos/plugin-form";
import * as pluginKnowledge from "@elizaos/plugin-knowledge";
import * as pluginLocalEmbedding from "@elizaos/plugin-local-embedding";
import * as pluginOllama from "@elizaos/plugin-ollama";
import * as pluginOpenai from "@elizaos/plugin-openai";
import * as pluginPdf from "@elizaos/plugin-pdf";
import * as pluginPersonality from "@elizaos/plugin-personality";
import * as pluginPluginManager from "@elizaos/plugin-plugin-manager";
import * as pluginRolodex from "@elizaos/plugin-rolodex";
import * as pluginSecretsManager from "@elizaos/plugin-secrets-manager";
import * as pluginShell from "@elizaos/plugin-shell";
import * as pluginSql from "@elizaos/plugin-sql";
import * as pluginTodo from "@elizaos/plugin-todo";
import * as pluginTrajectoryLogger from "@elizaos/plugin-trajectory-logger";
import * as pluginTrust from "@elizaos/plugin-trust";
import {
  debugLogResolvedContext,
  validateRuntimeContext,
} from "../api/plugin-validation";
import {
  configFileExists,
  loadMiladyConfig,
  type MiladyConfig,
  saveMiladyConfig,
} from "../config/config";
import { collectConfigEnvVars } from "../config/env-vars";
import { resolveStateDir, resolveUserPath } from "../config/paths";
import {
  type ApplyPluginAutoEnableParams,
  applyPluginAutoEnable,
} from "../config/plugin-auto-enable";
import type { AgentConfig } from "../config/types.agents";
import type { PluginInstallRecord } from "../config/types.milady";
import {
  createHookEvent,
  type LoadHooksOptions,
  loadHooks,
  triggerHook,
} from "../hooks/index";
import {
  ensureAgentWorkspace,
  resolveDefaultAgentWorkspaceDir,
} from "../providers/workspace";
import { SandboxAuditLog } from "../security/audit-log";
import { SandboxManager, type SandboxMode } from "../services/sandbox-manager";
import { diagnoseNoAIProvider } from "../services/version-compat";
import { CORE_PLUGINS, OPTIONAL_CORE_PLUGINS } from "./core-plugins";
import { detectEmbeddingPreset } from "./embedding-presets";
import { createMiladyPlugin } from "./milady-plugin";
import {
  installDatabaseTrajectoryLogger,
  shouldEnableTrajectoryLoggingByDefault,
} from "./trajectory-persistence";

/**
 * Map of baseline bundled @elizaos plugin names to their statically imported
 * modules.
 *
 * Post-release plugins are intentionally excluded so the packaged runtime can
 * ship a smaller baseline bundle. Those plugins fall through to dynamic
 * import() and can be installed later via the plugin installer.
 */
const STATIC_ELIZA_PLUGINS: Record<string, unknown> = {
  "@elizaos/plugin-sql": pluginSql,
  "@elizaos/plugin-local-embedding": pluginLocalEmbedding,
  "@elizaos/plugin-secrets-manager": pluginSecretsManager,
  "@elizaos/plugin-form": pluginForm,
  "@elizaos/plugin-knowledge": pluginKnowledge,
  "@elizaos/plugin-rolodex": pluginRolodex,
  "@elizaos/plugin-trajectory-logger": pluginTrajectoryLogger,
  "@elizaos/plugin-agent-orchestrator": pluginAgentOrchestrator,
  "@elizaos/plugin-cron": pluginCron,
  "@elizaos/plugin-shell": pluginShell,
  "@elizaos/plugin-plugin-manager": pluginPluginManager,
  "@elizaos/plugin-agent-skills": pluginAgentSkills,
  "@elizaos/plugin-pdf": pluginPdf,
  "@elizaos/plugin-openai": pluginOpenai,
  "@elizaos/plugin-anthropic": pluginAnthropic,
  "@elizaos/plugin-ollama": pluginOllama,
  "@elizaos/plugin-elizacloud": pluginElizacloud,
  "@elizaos/plugin-trust": pluginTrust,
  "@elizaos/plugin-todo": pluginTodo,
  "@elizaos/plugin-personality": pluginPersonality,
  "@elizaos/plugin-experience": pluginExperience,
};

// NODE_PATH so dynamic plugin imports (e.g. @elizaos/plugin-agent-orchestrator) resolve.
// WHY: When eliza is loaded from dist/ or by a test runner, Node's resolution does not
// search repo root node_modules; import("@elizaos/plugin-*") then fails. We prepend
// repo root node_modules only if not already in NODE_PATH (run-node.mjs may have set it)
// to avoid duplicate entries; _initPaths() makes Node re-read NODE_PATH. See docs/plugin-resolution-and-node-path.md.
// We walk up from this file to find node_modules — we do not assume a fixed depth
// (e.g. two levels for src/runtime/ or dist/runtime/) so we still work if build
// output structure changes (e.g. flat dist). First directory with node_modules wins.
const _elizaDir = path.dirname(fileURLToPath(import.meta.url));
let _dir = _elizaDir;
let _rootModules: string | null = null;
while (_dir !== path.dirname(_dir)) {
  const candidate = path.join(_dir, "node_modules");
  if (existsSync(candidate)) {
    _rootModules = candidate;
    break;
  }
  _dir = path.dirname(_dir);
}
if (_rootModules) {
  const prev = process.env.NODE_PATH ?? "";
  const entries = prev ? prev.split(path.delimiter) : [];
  const normalizedRoot = path.resolve(_rootModules);
  if (!entries.some((e) => path.resolve(e) === normalizedRoot)) {
    process.env.NODE_PATH = prev
      ? `${_rootModules}${path.delimiter}${prev}`
      : _rootModules;
    createRequire(import.meta.url)("node:module").Module._initPaths();
  }
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A successfully resolved plugin ready for AgentRuntime registration. */
interface ResolvedPlugin {
  /** npm package name (e.g. "@elizaos/plugin-anthropic"). */
  name: string;
  /** The Plugin instance extracted from the module. */
  plugin: Plugin;
}

/**
 * Temporary local compatibility shim for `@elizaos/core` not exporting
 * `SandboxFetchAuditEvent` on the current dependency line in this repo.
 * It preserves the runtime shape used by `sandboxAuditHandler`:
 * - `direction` and `url` are required
 * - `tokenIds` tracks tokens associated with the audit payload
 * TODO(elizaos): replace/remove when upstream re-exports this type.
 */
type SandboxFetchAuditEvent = {
  direction: "inbound" | "outbound";
  url: string;
  tokenIds: string[];
};

/** Shape we expect from a dynamically-imported plugin package. */
interface PluginModuleShape {
  default?: Plugin;
  plugin?: Plugin;
  [key: string]: Plugin | undefined;
}

export function configureLocalEmbeddingPlugin(
  _plugin: Plugin,
  config?: MiladyConfig,
): void {
  const detectedPreset = detectEmbeddingPreset();

  const embeddingConfig = config?.embedding;
  const configuredModel = embeddingConfig?.model?.trim();
  const configuredRepo = embeddingConfig?.modelRepo?.trim();
  const configuredDimensions =
    typeof embeddingConfig?.dimensions === "number" &&
    Number.isInteger(embeddingConfig.dimensions) &&
    embeddingConfig.dimensions > 0
      ? String(embeddingConfig.dimensions)
      : undefined;
  const configuredContextSize =
    typeof embeddingConfig?.contextSize === "number" &&
    Number.isInteger(embeddingConfig.contextSize) &&
    embeddingConfig.contextSize > 0
      ? String(embeddingConfig.contextSize)
      : undefined;

  const configuredGpuLayers = (() => {
    const value = embeddingConfig?.gpuLayers;
    if (typeof value === "number" && Number.isInteger(value) && value >= 0) {
      return String(value);
    }
    if (value === "auto" || value === "max") {
      // plugin-local-embedding understands "auto" and treats it as runtime max
      return "auto";
    }
    return undefined;
  })();

  const setEnvIfMissing = (key: string, value: string | undefined): void => {
    if (!value || process.env[key]) return;
    process.env[key] = value;
  };
  const setEnvFromConfig = (key: string, value: string | undefined): void => {
    if (!value) return;
    process.env[key] = value;
  };

  // Keep plugin-local-embedding aligned with Milady's hardware-adaptive preset
  // selection. Hard-coding the standard preset here forces slower first-run
  // downloads on Windows and low-spec machines.
  setEnvIfMissing(
    "LOCAL_EMBEDDING_MODEL",
    configuredModel || detectedPreset.model,
  );
  if (configuredRepo) {
    setEnvFromConfig("LOCAL_EMBEDDING_MODEL_REPO", configuredRepo);
  } else if (!configuredModel) {
    setEnvIfMissing("LOCAL_EMBEDDING_MODEL_REPO", detectedPreset.modelRepo);
  }
  if (configuredDimensions) {
    setEnvFromConfig("LOCAL_EMBEDDING_DIMENSIONS", configuredDimensions);
  } else if (!configuredModel) {
    setEnvIfMissing(
      "LOCAL_EMBEDDING_DIMENSIONS",
      String(detectedPreset.dimensions),
    );
  }
  if (configuredContextSize) {
    setEnvFromConfig("LOCAL_EMBEDDING_CONTEXT_SIZE", configuredContextSize);
  } else if (!configuredModel) {
    setEnvIfMissing(
      "LOCAL_EMBEDDING_CONTEXT_SIZE",
      String(detectedPreset.contextSize),
    );
  }

  if (configuredGpuLayers) {
    process.env.LOCAL_EMBEDDING_GPU_LAYERS = configuredGpuLayers;
  } else if (!process.env.LOCAL_EMBEDDING_GPU_LAYERS) {
    process.env.LOCAL_EMBEDDING_GPU_LAYERS = String(detectedPreset.gpuLayers);
  }

  // Performance tuning
  // Disable mmap on Metal to prevent "different text" errors with some models
  setEnvIfMissing(
    "LOCAL_EMBEDDING_USE_MMAP",
    detectedPreset.gpuLayers === "auto" ? "false" : "true",
  );

  // Set default models directory if not present
  setEnvIfMissing("MODELS_DIR", path.join(os.homedir(), ".eliza", "models"));

  // Normalize Google AI API key aliases — the elizaOS plugin and @google/genai
  // SDK expect different env var names. Canonicalize to the long form that
  // @elizaos/plugin-google-genai reads via runtime.getSetting(). Users can set
  // any of: GEMINI_API_KEY, GOOGLE_API_KEY, GOOGLE_GENERATIVE_AI_API_KEY.
  setEnvIfMissing(
    "GOOGLE_GENERATIVE_AI_API_KEY",
    process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY,
  );

  // Default Google model names — the Google GenAI plugin's getSetting() returns
  // null (not undefined) for missing keys, but the plugin checks !== undefined
  // causing String(null) = "null" to be sent as the model name. Set sensible
  // defaults so the plugin always has valid model names.
  setEnvIfMissing("GOOGLE_SMALL_MODEL", "gemini-3-flash-preview");
  setEnvIfMissing("GOOGLE_LARGE_MODEL", "gemini-3.1-pro-preview");

  logger.info(
    `[milady] Configured local embedding env: ${process.env.LOCAL_EMBEDDING_MODEL} (repo: ${process.env.LOCAL_EMBEDDING_MODEL_REPO ?? "auto"}, dims: ${process.env.LOCAL_EMBEDDING_DIMENSIONS ?? "auto"}, ctx: ${process.env.LOCAL_EMBEDDING_CONTEXT_SIZE ?? "auto"}, GPU: ${process.env.LOCAL_EMBEDDING_GPU_LAYERS}, mmap: ${process.env.LOCAL_EMBEDDING_USE_MMAP})`,
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Extract a human-readable error message from an unknown thrown value. */
function formatError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

type RuntimeAdapterWithClose = {
  close?: () => Promise<void> | void;
};

/**
 * Best-effort runtime shutdown that also closes the database adapter.
 *
 * AgentRuntime.stop() only stops services. plugin-sql keeps a process-global
 * PGlite manager, so restarts must close the adapter or the next runtime can
 * silently reuse the same broken manager instance.
 */
export async function shutdownRuntime(
  runtime: AgentRuntime | null | undefined,
  context: string,
): Promise<void> {
  if (!runtime) return;

  const adapter = runtime.adapter as RuntimeAdapterWithClose | undefined;
  let firstError: unknown = null;

  try {
    await runtime.stop();
  } catch (err) {
    firstError = err;
    logger.warn(
      `[milady] ${context}: runtime stop failed: ${formatError(err)}`,
    );
  }

  if (adapter && typeof adapter.close === "function") {
    try {
      await adapter.close();
    } catch (err) {
      if (!firstError) {
        firstError = err;
      }
      logger.warn(
        `[milady] ${context}: database adapter close failed: ${formatError(err)}`,
      );
    }
  }

  if (firstError) {
    throw firstError;
  }
}

/**
 * Remove duplicate actions across an ordered list of plugins.
 *
 * When multiple plugins define an action with the same `name`, only the first
 * occurrence is kept.  This prevents "Action already registered" warnings from
 * elizaOS core.  The function mutates each plugin's `actions` array in-place.
 */
export function deduplicatePluginActions(plugins: Plugin[]): void {
  const seen = new Set<string>();
  for (const plugin of plugins) {
    if (plugin.actions) {
      plugin.actions = plugin.actions.filter((action) => {
        if (seen.has(action.name)) {
          logger.debug(
            `[milady] Skipping duplicate action "${action.name}" from plugin "${plugin.name}"`,
          );
          return false;
        }
        seen.add(action.name);
        return true;
      });
    }
  }
}

interface TrajectoryLoggerControl {
  isEnabled?: () => boolean;
  setEnabled?: (enabled: boolean) => void;
}

interface TrajectoryLoggerOps {
  startTrajectory?: (
    stepIdOrAgentId: string,
    options?: {
      agentId?: string;
      roomId?: string;
      entityId?: string;
      source?: string;
      metadata?: Record<string, unknown>;
    },
  ) => Promise<string>;
  startStep?: (trajectoryId: string) => string;
  endTrajectory?: (
    stepIdOrTrajectoryId: string,
    status?: string,
  ) => Promise<void>;
}

type TrajectoryLoggerRegistrationStatus =
  | "pending"
  | "registering"
  | "registered"
  | "failed"
  | "unknown";

type TrajectoryLoggerRuntimeLike = {
  getServicesByType?: (serviceType: string) => unknown;
  getService?: (serviceType: string) => unknown;
  getServiceLoadPromise?: (serviceType: string) => Promise<unknown>;
  getServiceRegistrationStatus?: (
    serviceType: string,
  ) => TrajectoryLoggerRegistrationStatus;
};

function collectTrajectoryLoggerCandidates(
  runtimeLike: TrajectoryLoggerRuntimeLike,
): TrajectoryLoggerControl[] {
  const candidates: TrajectoryLoggerControl[] = [];
  if (typeof runtimeLike.getServicesByType === "function") {
    const byType = runtimeLike.getServicesByType("trajectory_logger");
    if (Array.isArray(byType) && byType.length > 0) {
      for (const service of byType) {
        if (service) candidates.push(service as TrajectoryLoggerControl);
      }
    } else if (byType && !Array.isArray(byType)) {
      candidates.push(byType as TrajectoryLoggerControl);
    }
  }
  if (typeof runtimeLike.getService === "function") {
    const single = runtimeLike.getService("trajectory_logger");
    if (single) candidates.push(single as TrajectoryLoggerControl);
  }
  return candidates;
}

async function waitForTrajectoryLoggerService(
  runtime: AgentRuntime,
  context: string,
  timeoutMs = 3000,
): Promise<void> {
  const runtimeLike = runtime as unknown as TrajectoryLoggerRuntimeLike;
  if (collectTrajectoryLoggerCandidates(runtimeLike).length > 0) return;

  const registrationStatus =
    typeof runtimeLike.getServiceRegistrationStatus === "function"
      ? runtimeLike.getServiceRegistrationStatus("trajectory_logger")
      : "unknown";

  if (
    registrationStatus !== "pending" &&
    registrationStatus !== "registering"
  ) {
    return;
  }

  if (typeof runtimeLike.getServiceLoadPromise !== "function") return;

  let timedOut = false;
  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<void>((resolve) => {
    timeoutHandle = setTimeout(() => {
      timedOut = true;
      resolve();
    }, timeoutMs);
  });

  try {
    await Promise.race([
      runtimeLike.getServiceLoadPromise("trajectory_logger").then(() => {}),
      timeoutPromise,
    ]);
    if (timedOut) {
      logger.debug(
        `[milady] trajectory_logger still ${registrationStatus} after ${timeoutMs}ms (${context})`,
      );
    }
  } catch (err) {
    logger.debug(
      `[milady] trajectory_logger registration failed while waiting (${context}): ${formatError(err)}`,
    );
  } finally {
    if (timeoutHandle) clearTimeout(timeoutHandle);
  }
}

function ensureTrajectoryLoggerEnabled(
  runtime: AgentRuntime,
  context: string,
): void {
  const runtimeLike = runtime as unknown as TrajectoryLoggerRuntimeLike;
  const candidates = collectTrajectoryLoggerCandidates(runtimeLike);

  let trajectoryLogger: TrajectoryLoggerControl | null = null;
  let bestScore = -1;
  for (const candidate of candidates) {
    const candidateWithRuntime = candidate as TrajectoryLoggerControl & {
      runtime?: { adapter?: unknown };
      initialized?: boolean;
      setEnabled?: unknown;
    };
    let score = 0;
    if (typeof candidate.isEnabled === "function") score += 2;
    if (typeof candidateWithRuntime.setEnabled === "function") score += 2;
    if (candidateWithRuntime.initialized === true) score += 3;
    if (candidateWithRuntime.runtime?.adapter) score += 3;
    const enabled =
      typeof candidate.isEnabled === "function" ? candidate.isEnabled() : true;
    if (enabled) score += 1;
    if (score > bestScore) {
      trajectoryLogger = candidate;
      bestScore = score;
    }
  }
  if (!trajectoryLogger) {
    logger.warn(
      `[milady] trajectory_logger service unavailable (${context}); trajectory capture disabled`,
    );
    return;
  }

  const isEnabled =
    typeof trajectoryLogger.isEnabled === "function"
      ? trajectoryLogger.isEnabled()
      : shouldEnableTrajectoryLoggingByDefault();
  const shouldEnable = shouldEnableTrajectoryLoggingByDefault();
  if (
    isEnabled !== shouldEnable &&
    typeof trajectoryLogger.setEnabled === "function"
  ) {
    trajectoryLogger.setEnabled(shouldEnable);
    logger.info(
      `[milady] trajectory_logger defaulted ${shouldEnable ? "on" : "off"} (${context})`,
    );
  }
}

function patchTrajectoryLoggerAliasCompatibility(runtime: AgentRuntime): void {
  const runtimeLike = runtime as unknown as TrajectoryLoggerRuntimeLike;
  const primary = collectTrajectoryLoggerCandidates(runtimeLike)[0] as
    | (TrajectoryLoggerControl & TrajectoryLoggerOps)
    | undefined;
  if (!primary) return;

  if (typeof runtimeLike.getService !== "function") return;
  const aliases: unknown[] = [
    runtimeLike.getService("logger5"),
    runtimeLike.getService("logger"),
  ];

  for (const alias of aliases) {
    if (!alias || typeof alias !== "object" || alias === primary) continue;
    const aliasOps = alias as TrajectoryLoggerOps;
    if (typeof aliasOps.startTrajectory !== "function") {
      aliasOps.startTrajectory = async (...args) => {
        if (typeof primary.startTrajectory === "function") {
          return primary.startTrajectory(...args);
        }
        return `step-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      };
    }
    if (typeof aliasOps.startStep !== "function") {
      aliasOps.startStep = (trajectoryId: string) => {
        if (typeof primary.startStep === "function") {
          return primary.startStep(trajectoryId);
        }
        return `step-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      };
    }
    if (typeof aliasOps.endTrajectory !== "function") {
      aliasOps.endTrajectory = async (...args) => {
        if (typeof primary.endTrajectory === "function") {
          await primary.endTrajectory(...args);
        }
      };
    }
  }
}

/**
 * Cancel the onboarding flow and exit cleanly.
 * Extracted to avoid duplicating the cancel+exit pattern 7 times.
 */
function cancelOnboarding(): never {
  // _clack is guaranteed to be loaded by the time onboarding calls this.
  _clack?.cancel("Maybe next time!");
  process.exit(0);
}

// ---------------------------------------------------------------------------
// Channel secret mapping
// ---------------------------------------------------------------------------

/**
 * Maps Milady channel config fields to the environment variable names
 * that elizaOS plugins expect.
 *
 * Milady stores channel credentials under `config.channels.<name>.<field>`,
 * while elizaOS plugins read them from process.env.
 */
const RETAKE_CHANNEL_ACCESS_TOKEN_ENV = "RETAKE_AGENT_TOKEN";

const CHANNEL_ENV_MAP: Readonly<
  Record<string, Readonly<Record<string, string>>>
> = {
  discord: {
    token: "DISCORD_API_TOKEN",
    botToken: "DISCORD_API_TOKEN",
    applicationId: "DISCORD_APPLICATION_ID",
  },
  telegram: {
    botToken: "TELEGRAM_BOT_TOKEN",
  },
  slack: {
    botToken: "SLACK_BOT_TOKEN",
    appToken: "SLACK_APP_TOKEN",
    userToken: "SLACK_USER_TOKEN",
  },
  signal: {
    authDir: "SIGNAL_AUTH_DIR",
    account: "SIGNAL_ACCOUNT_NUMBER",
    httpUrl: "SIGNAL_HTTP_URL",
    cliPath: "SIGNAL_CLI_PATH",
  },
  msteams: {
    appId: "MSTEAMS_APP_ID",
    appPassword: "MSTEAMS_APP_PASSWORD",
  },
  mattermost: {
    botToken: "MATTERMOST_BOT_TOKEN",
    baseUrl: "MATTERMOST_BASE_URL",
  },
  googlechat: {
    serviceAccountKey: "GOOGLE_CHAT_SERVICE_ACCOUNT_KEY",
  },
  blooio: {
    apiKey: "BLOOIO_API_KEY",
    fromNumber: "BLOOIO_PHONE_NUMBER",
    webhookSecret: "BLOOIO_WEBHOOK_SECRET",
    webhookUrl: "BLOOIO_WEBHOOK_URL",
    webhookPort: "BLOOIO_WEBHOOK_PORT",
  },
  retake: {
    accessToken: RETAKE_CHANNEL_ACCESS_TOKEN_ENV,
    apiUrl: "RETAKE_API_URL",
  },
};

// ---------------------------------------------------------------------------
// Plugin resolution
// ---------------------------------------------------------------------------

export { CORE_PLUGINS, OPTIONAL_CORE_PLUGINS };

/**
 * Optional plugins that require native binaries or specific config.
 * These are only loaded when explicitly enabled via features config,
 * NOT by default — they crash if their prerequisites are missing.
 */
const _OPTIONAL_NATIVE_PLUGINS: readonly string[] = [
  "@elizaos/plugin-browser", // requires browser server binary
  "@elizaos/plugin-vision", // requires @tensorflow/tfjs-node native addon
  "@elizaos/plugin-computeruse", // requires platform-specific binaries
];

/** Maps Milady channel names to plugin package names. */
export const CHANNEL_PLUGIN_MAP: Readonly<Record<string, string>> = {
  discord: "@elizaos/plugin-discord",
  telegram: "@elizaos/plugin-telegram",
  slack: "@elizaos/plugin-slack",
  twitter: "@elizaos/plugin-twitter",
  // Internal connector built from src/plugins/whatsapp (not an npm package).
  whatsapp: "@miladyai/plugin-whatsapp",
  // Internal connector built from src/plugins/signal (not an npm package).
  signal: "@miladyai/plugin-signal",
  imessage: "@elizaos/plugin-imessage",
  bluebubbles: "@elizaos/plugin-bluebubbles",
  farcaster: "@elizaos/plugin-farcaster",
  lens: "@elizaos/plugin-lens",
  msteams: "@elizaos/plugin-msteams",
  mattermost: "@elizaos/plugin-mattermost",
  googlechat: "@elizaos/plugin-google-chat",
  feishu: "@elizaos/plugin-feishu",
  matrix: "@elizaos/plugin-matrix",
  nostr: "@elizaos/plugin-nostr",
  retake: "@elizaos/plugin-retake",
  blooio: "@elizaos/plugin-blooio",
  twitch: "@elizaos/plugin-twitch",
};

const PI_AI_PLUGIN_PACKAGE = "@elizaos/plugin-pi-ai";

function isPiAiEnabledFromEnv(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env.MILADY_USE_PI_AI;
  if (!raw) return false;
  const value = String(raw).trim().toLowerCase();
  return value === "1" || value === "true" || value === "yes";
}

/** Maps environment variable names to model-provider plugin packages. */
const PROVIDER_PLUGIN_MAP: Readonly<Record<string, string>> = {
  ANTHROPIC_API_KEY: "@elizaos/plugin-anthropic",
  OPENAI_API_KEY: "@elizaos/plugin-openai",
  GEMINI_API_KEY: "@elizaos/plugin-google-genai",
  GOOGLE_API_KEY: "@elizaos/plugin-google-genai",
  GOOGLE_GENERATIVE_AI_API_KEY: "@elizaos/plugin-google-genai",
  GROQ_API_KEY: "@elizaos/plugin-groq",
  XAI_API_KEY: "@elizaos/plugin-xai",
  OPENROUTER_API_KEY: "@elizaos/plugin-openrouter",
  AI_GATEWAY_API_KEY: "@elizaos/plugin-vercel-ai-gateway",
  AIGATEWAY_API_KEY: "@elizaos/plugin-vercel-ai-gateway",
  OLLAMA_BASE_URL: "@elizaos/plugin-ollama",
  ZAI_API_KEY: "@homunculuslabs/plugin-zai",
  MILADY_USE_PI_AI: PI_AI_PLUGIN_PACKAGE,
  // ElizaCloud — loaded when API key is present OR cloud is explicitly enabled
  ELIZAOS_CLOUD_API_KEY: "@elizaos/plugin-elizacloud",
  ELIZAOS_CLOUD_ENABLED: "@elizaos/plugin-elizacloud",
};

/**
 * Optional feature plugins keyed by feature name.
 *
 * Mappings here support short IDs in allow-lists and feature toggles.
 * Keep this map in sync with optional plugin registration and tests.
 */
const OPTIONAL_PLUGIN_MAP: Readonly<Record<string, string>> = {
  browser: "@elizaos/plugin-browser",
  vision: "@elizaos/plugin-vision",
  cron: "@elizaos/plugin-cron",
  cua: "@elizaos/plugin-cua",
  computeruse: "@elizaos/plugin-computeruse",
  obsidian: "@elizaos/plugin-obsidian",
  repoprompt: "@elizaos/plugin-repoprompt",
  repoPrompt: "@elizaos/plugin-repoprompt",
  "pi-ai": PI_AI_PLUGIN_PACKAGE,
  piAi: PI_AI_PLUGIN_PACKAGE,
  x402: "@elizaos/plugin-x402",
  "coding-agent": "@elizaos/plugin-agent-orchestrator",
  "streaming-base": "@elizaos/plugin-streaming-base",
  "twitch-streaming": "@elizaos/plugin-twitch-streaming",
  "youtube-streaming": "@elizaos/plugin-youtube-streaming",
  "custom-rtmp": "@miladyai/plugin-custom-rtmp",
  "pumpfun-streaming": "@elizaos/plugin-pumpfun-streaming",
  "x-streaming": "@elizaos/plugin-x-streaming",
};

function looksLikePlugin(value: unknown): value is Plugin {
  if (!value || typeof value !== "object") return false;
  const obj = value as Record<string, unknown>;
  if (typeof obj.name !== "string" || typeof obj.description !== "string") {
    return false;
  }

  // Providers also expose { name, description } so we require at least one
  // plugin-like capability field before accepting named exports as plugins.
  return (
    Array.isArray(obj.services) ||
    Array.isArray(obj.providers) ||
    Array.isArray(obj.actions) ||
    Array.isArray(obj.routes) ||
    Array.isArray(obj.events) ||
    typeof obj.init === "function"
  );
}

function looksLikePluginBasic(
  value: unknown,
): value is Pick<Plugin, "name" | "description"> {
  if (!value || typeof value !== "object") return false;
  const obj = value as Record<string, unknown>;
  return typeof obj.name === "string" && typeof obj.description === "string";
}

export function findRuntimePluginExport(mod: PluginModuleShape): Plugin | null {
  // 1. Prefer explicit default export
  if (looksLikePlugin(mod.default)) return mod.default;
  // 2. Check for a named `plugin` export
  if (looksLikePlugin(mod.plugin)) return mod.plugin;
  // 3. Check if the module itself looks like a Plugin (CJS default pattern).
  if (looksLikePlugin(mod)) return mod as Plugin;

  // 4. Scan named exports in a deterministic order.
  // Prefer keys ending with "Plugin" before generic exports like providers.
  const namedKeys = Object.keys(mod).filter(
    (key) => key !== "default" && key !== "plugin",
  );
  const preferredKeys = namedKeys.filter(
    (key) => /plugin$/i.test(key) || /^plugin/i.test(key),
  );
  const fallbackKeys = namedKeys.filter((key) => !preferredKeys.includes(key));

  for (const key of [...preferredKeys, ...fallbackKeys]) {
    const value = mod[key];
    if (looksLikePlugin(value)) return value;
  }

  // 5. Final compatibility fallback: accept minimal plugin-like exports only
  // when the export name itself indicates it's a plugin.
  for (const key of preferredKeys) {
    const value = mod[key];
    if (looksLikePluginBasic(value)) return value as Plugin;
  }

  // 6. Legacy CJS compatibility for modules that export only { name, description }.
  if (looksLikePluginBasic(mod)) return mod as unknown as Plugin;
  if (looksLikePluginBasic(mod.default)) return mod.default as Plugin;
  if (looksLikePluginBasic(mod.plugin)) return mod.plugin as Plugin;

  return null;
}

/**
 * Collect the set of plugin package names that should be loaded
 * based on config, environment variables, and feature flags.
 */
/** @internal Exported for testing. */
export function collectPluginNames(config: MiladyConfig): Set<string> {
  const shellPluginDisabled = config.features?.shellEnabled === false;
  const localEmbeddingsExplicitlyDisabled = (() => {
    const raw = process.env.MILADY_DISABLE_LOCAL_EMBEDDINGS;
    if (!raw) return false;
    const normalized = raw.trim().toLowerCase();
    return normalized === "1" || normalized === "true" || normalized === "yes";
  })();
  const cloudMode = config.cloud?.enabled;
  const cloudHasApiKey = Boolean(config.cloud?.apiKey);
  const cloudExplicitlyDisabled = cloudMode === false;
  // Note: this is intentionally broader than the inference-path check in
  // applyCloudConfigToEnv (which requires explicit `enabled: true`).  Here
  // hasApiKey acts as an implicit enable signal so the cloud *plugin* gets
  // loaded for RPC/services (auth, credits, billing) even when inference
  // itself is handled by the user's own keys (BYOK).  The inference and
  // persistence paths gate on `cloud.enabled === true` separately.
  const cloudEffectivelyEnabled =
    cloudMode === true || (!cloudExplicitlyDisabled && cloudHasApiKey);
  // When inferenceMode is "byok" or "local", OR services.inference is false,
  // the user wants their own AI provider keys — cloud stays enabled for
  // RPC/services but does NOT hijack model inference.
  //
  // If the user chose a subscription provider (e.g. anthropic-subscription)
  // during onboarding and never explicitly set inferenceMode, treat that as
  // "byok" — the subscription IS the user's inference choice.
  const hasSubscriptionProvider = Boolean(
    config.agents?.defaults?.subscriptionProvider,
  );
  const explicitInferenceMode = config.cloud?.inferenceMode;
  const cloudInferenceMode =
    explicitInferenceMode ?? (hasSubscriptionProvider ? "byok" : "cloud");
  const cloudInferenceToggle = config.cloud?.services?.inference ?? true;
  const cloudHandlesInference =
    cloudEffectivelyEnabled &&
    cloudInferenceMode === "cloud" &&
    cloudInferenceToggle !== false;
  const configEnv = config.env as
    | (Record<string, unknown> & { vars?: Record<string, unknown> })
    | undefined;
  const configPiAiFlag =
    (configEnv?.vars &&
    typeof configEnv.vars === "object" &&
    !Array.isArray(configEnv.vars)
      ? (configEnv.vars as Record<string, unknown>).MILADY_USE_PI_AI
      : undefined) ?? configEnv?.MILADY_USE_PI_AI;
  const piAiEnabled =
    isPiAiEnabledFromEnv(process.env) ||
    (typeof configPiAiFlag === "string" &&
      isPiAiEnabledFromEnv({
        MILADY_USE_PI_AI: configPiAiFlag,
      } as NodeJS.ProcessEnv));

  const pluginEntries = (config.plugins as Record<string, unknown> | undefined)
    ?.entries as Record<string, { enabled?: boolean }> | undefined;

  const isPluginExplicitlyDisabled = (pluginPackageName: string): boolean => {
    const marker = "/plugin-";
    const markerIndex = pluginPackageName.lastIndexOf(marker);
    const pluginId =
      markerIndex >= 0
        ? pluginPackageName.slice(markerIndex + marker.length)
        : pluginPackageName;
    return pluginEntries?.[pluginId]?.enabled === false;
  };

  const providerPluginIdSet = new Set(
    Object.values(PROVIDER_PLUGIN_MAP).map((pluginPackageName) => {
      const marker = "/plugin-";
      const markerIndex = pluginPackageName.lastIndexOf(marker);
      return markerIndex >= 0
        ? pluginPackageName.slice(markerIndex + marker.length)
        : pluginPackageName;
    }),
  );
  const explicitProviderEntries = Object.entries(pluginEntries ?? {}).filter(
    ([pluginId]) => providerPluginIdSet.has(pluginId),
  );
  const hasExplicitEnabledProvider = explicitProviderEntries.some(
    ([, entry]) => entry?.enabled === true,
  );

  // Allow-list entries are additive (extra plugins), not exclusive.
  const allowList = config.plugins?.allow;
  const pluginsToLoad = new Set<string>(CORE_PLUGINS);
  if (localEmbeddingsExplicitlyDisabled) {
    pluginsToLoad.delete("@elizaos/plugin-local-embedding");
  }

  // Allow list is additive — extra plugins on top of auto-detection,
  // not an exclusive whitelist that blocks everything else.
  if (allowList && allowList.length > 0) {
    for (const item of allowList) {
      const pluginName =
        CHANNEL_PLUGIN_MAP[item] ?? OPTIONAL_PLUGIN_MAP[item] ?? item;
      pluginsToLoad.add(pluginName);
    }
  }

  // Connector plugins — load when connector has config entries
  // Prefer config.connectors, fall back to config.channels for backward compatibility
  const connectors = config.connectors ?? config.channels ?? {};
  for (const [channelName, channelConfig] of Object.entries(connectors)) {
    if (channelConfig && typeof channelConfig === "object") {
      const pluginName = CHANNEL_PLUGIN_MAP[channelName];
      if (pluginName) {
        pluginsToLoad.add(pluginName);
      }
    }
  }

  // Model-provider plugins — load when env key is present
  for (const [envKey, pluginName] of Object.entries(PROVIDER_PLUGIN_MAP)) {
    if (envKey === "MILADY_USE_PI_AI") {
      // pi-ai enablement uses dedicated boolean parsing + precedence logic below.
      continue;
    }
    if (
      cloudExplicitlyDisabled &&
      (envKey === "ELIZAOS_CLOUD_API_KEY" || envKey === "ELIZAOS_CLOUD_ENABLED")
    ) {
      continue;
    }
    if (isPluginExplicitlyDisabled(pluginName)) {
      continue;
    }
    if (hasExplicitEnabledProvider) {
      const marker = "/plugin-";
      const markerIndex = pluginName.lastIndexOf(marker);
      const pluginId =
        markerIndex >= 0
          ? pluginName.slice(markerIndex + marker.length)
          : pluginName;
      if (pluginEntries?.[pluginId]?.enabled !== true) {
        continue;
      }
    }
    if (process.env[envKey]?.trim()) {
      pluginsToLoad.add(pluginName);
    }
  }

  const shouldEnablePiAi =
    piAiEnabled && pluginEntries?.["pi-ai"]?.enabled !== false;

  const applyProviderPrecedence = (): void => {
    // Provider precedence:
    // 1) ElizaCloud for inference (when enabled AND inferenceMode is "cloud")
    // 2) pi-ai (when enabled and cloud inference is not active)
    // 3) direct provider plugins (api-key/env based)
    //
    // When inferenceMode is "byok" or "local", cloud stays loaded for
    // RPC/services but direct AI provider plugins are preserved so the
    // user's own API keys (e.g. Anthropic) handle model inference.
    if (cloudEffectivelyEnabled) {
      pluginsToLoad.add("@elizaos/plugin-elizacloud");

      if (cloudHandlesInference) {
        // Cloud handles ALL model calls — remove direct AI provider plugins.
        const directProviders = new Set(Object.values(PROVIDER_PLUGIN_MAP));
        directProviders.delete("@elizaos/plugin-elizacloud");
        for (const p of directProviders) {
          pluginsToLoad.delete(p);
        }
        return;
      }
      // inferenceMode is "byok" or "local" — keep direct provider plugins.
      // Cloud plugin stays loaded for non-inference cloud services (RPC, media, etc.)
      // Pi-ai takes priority over direct providers when cloud inference is disabled.
      if (shouldEnablePiAi) {
        pluginsToLoad.add(PI_AI_PLUGIN_PACKAGE);
        // Remove direct provider plugins — pi-ai handles inference selection.
        const directProviders = new Set(Object.values(PROVIDER_PLUGIN_MAP));
        directProviders.delete(PI_AI_PLUGIN_PACKAGE);
        directProviders.delete("@elizaos/plugin-elizacloud");
        for (const p of directProviders) {
          pluginsToLoad.delete(p);
        }
      }
      return;
    }

    if (shouldEnablePiAi) {
      pluginsToLoad.add(PI_AI_PLUGIN_PACKAGE);

      // When pi-ai is active, remove direct provider plugins + cloud plugin.
      // pi-ai performs the upstream provider selection itself.
      const directProviders = new Set(Object.values(PROVIDER_PLUGIN_MAP));
      directProviders.delete(PI_AI_PLUGIN_PACKAGE);
      for (const p of directProviders) {
        pluginsToLoad.delete(p);
      }
      pluginsToLoad.delete("@elizaos/plugin-elizacloud");
      return;
    }

    if (cloudExplicitlyDisabled) {
      // Cloud was explicitly disabled — remove elizacloud even though it's
      // in CORE_PLUGINS, so it cannot intercept model calls.
      pluginsToLoad.delete("@elizaos/plugin-elizacloud");
    }
  };

  // Apply once before additive plugin-entry/feature paths.
  applyProviderPrecedence();

  // Optional feature plugins from config.plugins.entries
  const pluginsConfig = config.plugins as
    | Record<string, Record<string, unknown>>
    | undefined;
  if (pluginsConfig?.entries) {
    for (const [key, entry] of Object.entries(pluginsConfig.entries)) {
      if (
        entry &&
        typeof entry === "object" &&
        (entry as Record<string, unknown>).enabled !== false
      ) {
        // Connector keys (telegram, discord, etc.) must use CHANNEL_PLUGIN_MAP
        // so the correct variant loads.
        const pluginName =
          CHANNEL_PLUGIN_MAP[key] ??
          OPTIONAL_PLUGIN_MAP[key] ??
          (key.includes("/") ? key : `@elizaos/plugin-${key}`);
        pluginsToLoad.add(pluginName);
      }
    }
  }

  // Feature flags (config.features)
  const features = config.features;
  if (features && typeof features === "object") {
    for (const [featureName, featureValue] of Object.entries(features)) {
      const isEnabled =
        featureValue === true ||
        (typeof featureValue === "object" &&
          featureValue !== null &&
          (featureValue as Record<string, unknown>).enabled !== false);
      if (isEnabled) {
        const pluginName = OPTIONAL_PLUGIN_MAP[featureName];
        if (pluginName) {
          pluginsToLoad.add(pluginName);
        }
      }
    }
  }

  // x402 plugin — auto-load when config section enabled
  if (config.x402?.enabled) {
    pluginsToLoad.add("@elizaos/plugin-x402");
  }

  // Opinion plugin — auto-load when API key is present.
  // NOT in PROVIDER_PLUGIN_MAP because it is a feature plugin, not a model
  // provider, and would be incorrectly removed during provider precedence.
  if (process.env.OPINION_API_KEY?.trim()) {
    pluginsToLoad.add("@miladyai/plugin-opinion");
  }

  // User-installed plugins from config.plugins.installs
  // These are plugins that were installed via the plugin-manager at runtime
  // and tracked in milady.json so they persist across restarts.
  const installs = config.plugins?.installs;
  if (installs && typeof installs === "object") {
    for (const [packageName, record] of Object.entries(installs)) {
      if (record && typeof record === "object") {
        pluginsToLoad.add(packageName);
      }
    }
  }

  // Re-apply provider precedence so later additive paths (entries, features,
  // installs) cannot accidentally re-introduce suppressed providers.
  applyProviderPrecedence();

  // Enforce feature gating last so allow-list entries cannot bypass it.
  if (shellPluginDisabled) {
    pluginsToLoad.delete("@elizaos/plugin-shell");
  }
  if (isPluginExplicitlyDisabled("@elizaos/plugin-agent-orchestrator")) {
    pluginsToLoad.delete("@elizaos/plugin-agent-orchestrator");
  }

  return pluginsToLoad;
}

// ---------------------------------------------------------------------------
// Custom / drop-in plugin discovery
// ---------------------------------------------------------------------------

/** Subdirectory under the Milady state dir for drop-in custom plugins. */
export const CUSTOM_PLUGINS_DIRNAME = "plugins/custom";
/** Subdirectory under the Milady state dir for ejected plugins. */
export const EJECTED_PLUGINS_DIRNAME = "plugins/ejected";

/**
 * Scan a directory for drop-in plugin packages. Each immediate subdirectory
 * is treated as a plugin; name comes from package.json or the directory name.
 */
export async function scanDropInPlugins(
  dir: string,
): Promise<Record<string, PluginInstallRecord>> {
  const records: Record<string, PluginInstallRecord> = {};

  let entries: Dirent[];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return records;
    }
    throw err;
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;

    const pluginDir = path.join(dir, entry.name);
    let pluginName = entry.name;
    let version = "0.0.0";

    try {
      const raw = await fs.readFile(
        path.join(pluginDir, "package.json"),
        "utf-8",
      );
      const pkg = JSON.parse(raw) as { name?: string; version?: string };
      if (typeof pkg.name === "string" && pkg.name.trim())
        pluginName = pkg.name.trim();
      if (typeof pkg.version === "string" && pkg.version.trim())
        version = pkg.version.trim();
    } catch (err) {
      if (
        (err as NodeJS.ErrnoException).code !== "ENOENT" &&
        !(err instanceof SyntaxError)
      ) {
        throw err;
      }
    }

    records[pluginName] = { source: "path", installPath: pluginDir, version };
  }

  return records;
}

/**
 * Merge drop-in plugins into the load set. Filters out denied, core-colliding,
 * and already-installed names. Mutates `pluginsToLoad` and `installRecords`.
 */
export function mergeDropInPlugins(params: {
  dropInRecords: Record<string, PluginInstallRecord>;
  installRecords: Record<string, PluginInstallRecord>;
  corePluginNames: ReadonlySet<string>;
  denyList: ReadonlySet<string>;
  pluginsToLoad: Set<string>;
}): { accepted: string[]; skipped: string[] } {
  const {
    dropInRecords,
    installRecords,
    corePluginNames,
    denyList,
    pluginsToLoad,
  } = params;
  const accepted: string[] = [];
  const skipped: string[] = [];

  for (const [name, record] of Object.entries(dropInRecords)) {
    if (denyList.has(name) || installRecords[name]) continue;
    if (corePluginNames.has(name)) {
      skipped.push(
        `[milady] Custom plugin "${name}" collides with core plugin — skipping`,
      );
      continue;
    }
    pluginsToLoad.add(name);
    installRecords[name] = record;
    accepted.push(name);
  }

  return { accepted, skipped };
}

const WORKSPACE_PLUGIN_OVERRIDES = new Set<string>([
  // "@elizaos/plugin-trajectory-logger",
  // "@elizaos/plugin-plugin-manager",
  // "@elizaos/plugin-media-generation",
  "@elizaos/plugin-twitch-streaming",
  "@elizaos/plugin-youtube-streaming",
  "@elizaos/plugin-retake",
]);

function getWorkspacePluginOverridePath(pluginName: string): string | null {
  if (process.env.MILADY_DISABLE_WORKSPACE_PLUGIN_OVERRIDES === "1") {
    return null;
  }
  if (!WORKSPACE_PLUGIN_OVERRIDES.has(pluginName)) {
    return null;
  }

  const pluginSegmentMatch = pluginName.match(/^@[^/]+\/(plugin-[^/]+)$/);
  const pluginSegment = pluginSegmentMatch?.[1];
  if (!pluginSegment) return null;

  const thisDir = path.dirname(fileURLToPath(import.meta.url));
  const miladyRoot = path.resolve(thisDir, "..", "..");
  const workspaceRoot = path.resolve(miladyRoot, "..");
  const candidates = [
    path.join(miladyRoot, "plugins", pluginSegment, "typescript"),
    path.join(workspaceRoot, "plugins", pluginSegment, "typescript"),
    path.join(miladyRoot, "plugins", pluginSegment),
    path.join(workspaceRoot, "plugins", pluginSegment),
    path.join(miladyRoot, "packages", pluginSegment),
    path.join(workspaceRoot, "packages", pluginSegment),
  ];

  for (const candidate of candidates) {
    if (existsSync(path.join(candidate, "package.json"))) {
      return candidate;
    }
  }

  return null;
}

export function resolveMiladyPluginImportSpecifier(
  pluginName: string,
  runtimeModuleUrl = import.meta.url,
): string {
  if (!pluginName.startsWith("@miladyai/plugin-")) {
    return pluginName;
  }

  const shortName = pluginName.replace("@miladyai/plugin-", "");
  const thisDir = path.dirname(fileURLToPath(runtimeModuleUrl));
  const distRoot = thisDir.endsWith("runtime")
    ? path.resolve(thisDir, "..")
    : thisDir;
  const indexPath = path.resolve(distRoot, "plugins", shortName, "index.js");

  return existsSync(indexPath) ? pathToFileURL(indexPath).href : pluginName;
}

export function shouldIgnoreMissingPluginExport(pluginName: string): boolean {
  return pluginName === "@elizaos/plugin-streaming-base";
}

// ---------------------------------------------------------------------------
// Plugin resolution
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Browser server pre-flight
// ---------------------------------------------------------------------------

/**
 * The `@elizaos/plugin-browser` npm package expects a `dist/server/` directory
 * containing the compiled stagehand-server, but the npm publish doesn't include
 * it.  The actual source/build lives in the workspace at
 * `plugins/plugin-browser/stagehand-server/`.
 *
 * This function checks whether the server is reachable from the installed
 * package and, if not, creates a symlink so the plugin's process-manager can
 * find it.  Returns `true` when the server index.js is available (or was made
 * available via symlink), `false` otherwise.
 */
/**
 * Returns true if the given env var key is safe to forward to runtime.settings.
 * Blocks blockchain private keys, secrets, passwords, tokens, credentials,
 * mnemonics, and seed phrases while allowing API keys that plugins need.
 */
export function isEnvKeyAllowedForForwarding(key: string): boolean {
  const upper = key.toUpperCase();
  // Block blockchain private keys
  if (upper.includes("PRIVATE_KEY")) return false;
  if (upper.startsWith("EVM_") || upper.startsWith("SOLANA_")) return false;
  // Block secrets, passwords, tokens, and seed phrases (but not API_KEY which plugins need)
  if (/(SECRET|PASSWORD|CREDENTIAL|MNEMONIC|SEED_PHRASE)/i.test(key))
    return false;
  if (/(ACCESS_TOKEN|REFRESH_TOKEN|SESSION_TOKEN|AUTH_TOKEN)$/i.test(key))
    return false;
  return true;
}

export function ensureBrowserServerLink(): boolean {
  try {
    // Resolve the plugin-browser package root via its package.json.
    const req = createRequire(import.meta.url);
    const pkgJsonPath = req.resolve("@elizaos/plugin-browser/package.json");
    const pluginRoot = path.dirname(pkgJsonPath);
    const serverDir = path.join(pluginRoot, "dist", "server");
    const serverIndex = path.join(serverDir, "dist", "index");

    // Already linked / available — nothing to do.
    if (existsSync(serverIndex)) return true;

    // Walk upward from this file to find the eliza-workspace root.
    // Layout: <workspace>/milady/src/runtime/eliza.ts
    const thisDir = path.dirname(fileURLToPath(import.meta.url));
    const miladyRoot = path.resolve(thisDir, "..", "..");
    const workspaceRoot = path.resolve(miladyRoot, "..");
    const stagehandDir = path.join(
      workspaceRoot,
      "plugins",
      "plugin-browser",
      "stagehand-server",
    );
    const stagehandIndex = path.join(stagehandDir, "dist", "index");

    if (!existsSync(stagehandIndex)) {
      logger.info(
        `[milady] Browser server not found at ${stagehandDir} — ` +
          `@elizaos/plugin-browser will not be loaded`,
      );
      return false;
    }

    // Create symlink: dist/server -> stagehand-server
    symlinkSync(stagehandDir, serverDir, "dir");
    logger.info(
      `[milady] Linked browser server: ${serverDir} -> ${stagehandDir}`,
    );
    return true;
  } catch (err) {
    logger.debug(`[milady] Could not link browser server: ${formatError(err)}`);
    return false;
  }
}

// ---------------------------------------------------------------------------
// Plugin resolution
// ---------------------------------------------------------------------------

/**
 * Resolve Milady plugins from config and auto-enable logic.
 * Returns an array of elizaOS Plugin instances ready for AgentRuntime.
 *
 * Handles three categories of plugins:
 * 1. Built-in/npm plugins — imported by package name
 * 2. User-installed plugins — from ~/.milady/plugins/installed/
 * 3. Custom/drop-in plugins — from ~/.milady/plugins/custom/ and plugins.load.paths
 *
 * Each plugin is loaded inside an error boundary so a single failing plugin
 * cannot crash the entire agent startup.
 */
/**
 * Resolve a statically-imported @elizaos plugin by name.
 * Returns the module if found in STATIC_ELIZA_PLUGINS, otherwise null.
 */
function resolveStaticElizaPlugin(pluginName: string): unknown | null {
  return STATIC_ELIZA_PLUGINS[pluginName] ?? null;
}

async function resolvePlugins(
  config: MiladyConfig,
  opts?: { quiet?: boolean },
): Promise<ResolvedPlugin[]> {
  const plugins: ResolvedPlugin[] = [];
  const failedPlugins: Array<{ name: string; error: string }> = [];
  const repairedInstallRecords = new Set<string>();

  applyPluginAutoEnable({
    config,
    env: process.env,
  } satisfies ApplyPluginAutoEnableParams);

  const pluginsToLoad = collectPluginNames(config);
  const corePluginSet = new Set<string>(CORE_PLUGINS);

  // Build a mutable map of install records so we can merge drop-in discoveries
  const installRecords: Record<string, PluginInstallRecord> = {
    ...(config.plugins?.installs ?? {}),
  };

  const denyList = new Set(config.plugins?.deny ?? []);

  // ── Auto-discover ejected plugins ───────────────────────────────────────
  // Ejected plugins override npm/core versions, so they are tracked
  // separately and consulted first at import time.
  const ejectedRecords = await scanDropInPlugins(
    path.join(resolveStateDir(), EJECTED_PLUGINS_DIRNAME),
  );
  const ejectedPluginNames: string[] = [];
  for (const [name, _record] of Object.entries(ejectedRecords)) {
    if (denyList.has(name)) continue;
    pluginsToLoad.add(name);
    ejectedPluginNames.push(name);
  }
  if (ejectedPluginNames.length > 0) {
    logger.info(
      `[milady] Discovered ${ejectedPluginNames.length} ejected plugin(s): ${ejectedPluginNames.join(", ")}`,
    );
  }

  // ── Auto-discover drop-in custom plugins ────────────────────────────────
  // Scan well-known dir + any extra dirs from plugins.load.paths (first wins).
  const scanDirs = [
    path.join(resolveStateDir(), CUSTOM_PLUGINS_DIRNAME),
    ...(config.plugins?.load?.paths ?? []).map(resolveUserPath),
  ];
  const dropInRecords: Record<string, PluginInstallRecord> = {};
  for (const dir of scanDirs) {
    for (const [name, record] of Object.entries(await scanDropInPlugins(dir))) {
      if (!dropInRecords[name]) dropInRecords[name] = record;
    }
  }

  // Merge into load set — deny list and core collisions are filtered out.
  const { accepted: customPluginNames, skipped } = mergeDropInPlugins({
    dropInRecords,
    installRecords,
    corePluginNames: corePluginSet,
    denyList,
    pluginsToLoad,
  });

  for (const msg of skipped) logger.warn(msg);
  if (customPluginNames.length > 0) {
    logger.info(
      `[milady] Discovered ${customPluginNames.length} custom plugin(s): ${customPluginNames.join(", ")}`,
    );
  }

  logger.info(`[milady] Resolving ${pluginsToLoad.size} plugins...`);
  const loadStartTime = Date.now();

  // Built once so we don't rebuild on every optional plugin failure.
  const optionalPluginNames = new Set([
    ...Object.values(OPTIONAL_PLUGIN_MAP),
    ...Object.values(CHANNEL_PLUGIN_MAP),
    ...OPTIONAL_CORE_PLUGINS,
  ]);

  // Load a single plugin - returns result or null on skip/failure
  async function loadSinglePlugin(pluginName: string): Promise<{
    name: string;
    plugin: Plugin;
  } | null> {
    const isCore = corePluginSet.has(pluginName);
    const ejectedRecord = ejectedRecords[pluginName];
    const installRecord = installRecords[pluginName];
    const workspaceOverridePath = getWorkspacePluginOverridePath(pluginName);

    // Pre-flight: ensure native dependencies are available for special plugins.
    if (pluginName === "@elizaos/plugin-browser") {
      if (!ensureBrowserServerLink()) {
        failedPlugins.push({
          name: pluginName,
          error: "browser server binary not found",
        });
        logger.warn(
          `[milady] Skipping ${pluginName}: browser server not available. ` +
            `Build the stagehand-server or remove the plugin from plugins.allow.`,
        );
        return null;
      }
    }

    try {
      let mod: PluginModuleShape;

      if (ejectedRecord?.installPath) {
        // Ejected plugin — always prefer local source over npm/core.
        logger.debug(
          `[milady] Loading ejected plugin: ${pluginName} from ${ejectedRecord.installPath}`,
        );
        mod = await importFromPath(ejectedRecord.installPath, pluginName);
      } else if (workspaceOverridePath) {
        logger.debug(
          `[milady] Loading workspace plugin override: ${pluginName} from ${workspaceOverridePath}`,
        );
        mod = await importFromPath(workspaceOverridePath, pluginName);
      } else if (installRecord?.installPath) {
        // Prefer bundled/node_modules copies for official Eliza plugins.
        const isOfficialElizaPlugin = pluginName.startsWith("@elizaos/plugin-");

        if (isOfficialElizaPlugin) {
          try {
            const staticMod = await resolveStaticElizaPlugin(pluginName);
            mod = staticMod
              ? (staticMod as PluginModuleShape)
              : ((await import(pluginName)) as PluginModuleShape);
            if (repairBrokenInstallRecord(config, pluginName)) {
              repairedInstallRecords.add(pluginName);
            }
          } catch (npmErr) {
            logger.warn(
              `[milady] Node_modules resolution failed for ${pluginName} (${formatError(npmErr)}). Trying installed path at ${installRecord.installPath}.`,
            );
            mod = await importFromPath(installRecord.installPath, pluginName);
          }
        } else {
          // User-installed plugin — load from its install directory on disk.
          try {
            mod = await importFromPath(installRecord.installPath, pluginName);
          } catch (installErr) {
            logger.warn(
              `[milady] Installed plugin ${pluginName} failed at ${installRecord.installPath} (${formatError(installErr)}). Falling back to node_modules resolution.`,
            );
            const staticMod = await resolveStaticElizaPlugin(pluginName);
            mod = staticMod
              ? (staticMod as PluginModuleShape)
              : ((await import(pluginName)) as PluginModuleShape);
            if (repairBrokenInstallRecord(config, pluginName)) {
              repairedInstallRecords.add(pluginName);
            }
          }
        }
      } else if (pluginName.startsWith("@miladyai/plugin-")) {
        // Milady plugins can resolve either from bundled local wrappers
        // under milady-dist/plugins/* or from packaged node_modules.
        mod = (await import(
          resolveMiladyPluginImportSpecifier(pluginName)
        )) as PluginModuleShape;
      } else {
        // Built-in/npm plugin — try bundled static import first, then
        // fall back to bare node_modules resolution.
        const staticMod = pluginName.startsWith("@elizaos/plugin-")
          ? await resolveStaticElizaPlugin(pluginName)
          : null;
        mod = staticMod
          ? (staticMod as PluginModuleShape)
          : ((await import(pluginName)) as PluginModuleShape);
      }

      const pluginInstance = findRuntimePluginExport(mod);

      if (pluginInstance) {
        // Wrap the plugin's init function with an error boundary
        const wrappedPlugin = wrapPluginWithErrorBoundary(
          pluginName,
          pluginInstance,
        );
        logger.debug(`[milady] ✓ Loaded plugin: ${pluginName}`);
        return { name: pluginName, plugin: wrappedPlugin };
      } else {
        if (shouldIgnoreMissingPluginExport(pluginName)) {
          logger.info(
            `[milady] Skipping helper package ${pluginName}: no Plugin export is expected`,
          );
          return null;
        }

        const msg = `[milady] Plugin ${pluginName} did not export a valid Plugin object`;
        failedPlugins.push({
          name: pluginName,
          error: "no valid Plugin export",
        });
        if (isCore) {
          logger.error(msg);
        } else {
          logger.warn(msg);
        }
        return null;
      }
    } catch (err) {
      const msg = formatError(err);

      failedPlugins.push({ name: pluginName, error: msg });
      if (isCore) {
        logger.error(
          `[milady] Failed to load core plugin ${pluginName}: ${msg}`,
        );
      } else {
        if (optionalPluginNames.has(pluginName)) {
          logger.debug(
            `[milady] Optional plugin ${pluginName} not available: ${msg}`,
          );
        } else {
          logger.info(`[milady] Could not load plugin ${pluginName}: ${msg}`);
        }
      }
      return null;
    }
  }

  // Load all plugins in parallel for faster startup
  const pluginResults = await Promise.all(
    Array.from(pluginsToLoad).map(loadSinglePlugin),
  );

  // Collect successful loads
  for (const result of pluginResults) {
    if (result) {
      plugins.push(result);
    }
  }

  const loadDuration = Date.now() - loadStartTime;
  logger.info(`[milady] Plugin loading took ${loadDuration}ms`);

  // Summary logging
  logger.info(
    `[milady] Plugin resolution complete: ${plugins.length}/${pluginsToLoad.size} loaded` +
      (failedPlugins.length > 0 ? `, ${failedPlugins.length} failed` : ""),
  );
  if (failedPlugins.length > 0) {
    logger.info(
      `[milady] Failed plugins: ${failedPlugins.map((f) => `${f.name} (${f.error})`).join(", ")}`,
    );
  }

  // Diagnose version-skew issues when AI providers failed to load (#10)
  const loadedNames = plugins.map((p) => p.name);
  const diagnostic = diagnoseNoAIProvider(loadedNames, failedPlugins);
  if (diagnostic) {
    if (opts?.quiet) {
      // In headless/GUI mode before onboarding, this is expected — the user
      // will configure a provider through the onboarding wizard and restart.
      logger.info(`[milady] ${diagnostic}`);
    } else {
      logger.error(`[milady] ${diagnostic}`);
    }
  }

  // Persist repaired install records so future startups do not keep trying
  // to import from stale install directories.
  if (repairedInstallRecords.size > 0) {
    try {
      saveMiladyConfig(config);
      logger.info(
        `[milady] Repaired ${repairedInstallRecords.size} plugin install record(s): ${Array.from(repairedInstallRecords).join(", ")}`,
      );
    } catch (err) {
      logger.warn(
        `[milady] Failed to persist plugin install repairs: ${formatError(err)}`,
      );
    }
  }

  return plugins;
}

/** @internal Exported for testing. */
export function repairBrokenInstallRecord(
  config: MiladyConfig,
  pluginName: string,
): boolean {
  const record = config.plugins?.installs?.[pluginName];
  if (!record || typeof record.installPath !== "string") return false;
  if (!record.installPath.trim()) return false;

  // Keep the plugin listed as installed but force node_modules resolution.
  record.installPath = "";
  record.source = "npm";
  return true;
}

/**
 * Wrap a plugin's `init` and `providers` with error boundaries so that a
 * crash in any single plugin does not take down the entire agent or GUI.
 *
 * NOTE: Actions are NOT wrapped here because elizaOS's action dispatch
 * already has its own error boundary.  Only `init` (startup) and
 * `providers` (called every turn) need protection at this layer.
 *
 * The wrapper catches errors, logs them with the plugin name for easy
 * debugging, and continues execution.
 */
function wrapPluginWithErrorBoundary(
  pluginName: string,
  plugin: Plugin,
): Plugin {
  const wrapped: Plugin = { ...plugin };

  // Wrap init if present
  if (plugin.init) {
    const originalInit = plugin.init;
    wrapped.init = async (...args: Parameters<typeof originalInit>) => {
      try {
        return await originalInit(...args);
      } catch (err) {
        logger.error(
          `[milady] Plugin "${pluginName}" crashed during init: ${formatError(err)}`,
        );
        // Surface the error but don't rethrow — the agent continues
        // without this plugin's init having completed.
        logger.warn(
          `[milady] Plugin "${pluginName}" will run in degraded mode (init failed)`,
        );
      }
    };
  }

  // Wrap providers with error boundaries
  if (plugin.providers && plugin.providers.length > 0) {
    wrapped.providers = plugin.providers.map((provider) => ({
      ...provider,
      get: async (...args: Parameters<typeof provider.get>) => {
        try {
          return await provider.get(...args);
        } catch (err) {
          const msg = formatError(err);
          logger.error(
            `[milady] Provider "${provider.name}" (plugin: ${pluginName}) crashed: ${msg}`,
          );
          // Return an error marker so downstream consumers can detect
          // the failure rather than silently using empty data.
          return {
            text: `[Provider ${provider.name} error: ${msg}]`,
            data: { _providerError: true },
          };
        }
      },
    }));
  }

  return wrapped;
}

/**
 * Import a plugin module from its install directory on disk.
 *
 * Handles two install layouts:
 *   1. npm layout:  <installPath>/node_modules/@scope/package/  (from `bun add`)
 *   2. git layout:  <installPath>/ is the package root directly  (from `git clone`)
 *
 * @param installPath  Root directory of the installation (e.g. ~/.milady/plugins/installed/foo/).
 * @param packageName  The npm package name (e.g. "@elizaos/plugin-discord") — used
 *                     to navigate directly into node_modules when present.
 */
async function importFromPath(
  installPath: string,
  packageName: string,
): Promise<PluginModuleShape> {
  const absPath = path.resolve(installPath);

  // npm/bun layout:  installPath/node_modules/@scope/name/
  // git layout:      installPath/ is the package itself
  const nmCandidate = path.join(
    absPath,
    "node_modules",
    ...packageName.split("/"),
  );
  let pkgRoot = absPath;
  try {
    if ((await fs.stat(nmCandidate)).isDirectory()) pkgRoot = nmCandidate;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      throw err;
    }
    /* git layout — pkgRoot stays as absPath */
  }

  // Resolve entry point from package.json
  const entryPoint = await resolvePackageEntry(pkgRoot);
  return (await import(pathToFileURL(entryPoint).href)) as PluginModuleShape;
}

/** Read package.json exports/main to find the importable entry file. */
/** @internal Exported for testing. */
export async function resolvePackageEntry(pkgRoot: string): Promise<string> {
  const fallback = path.join(pkgRoot, "dist", "index");
  const fallbackCandidates = [
    fallback,
    path.join(pkgRoot, "index"),
    path.join(pkgRoot, "index.mjs"),
    path.join(pkgRoot, "index.ts"),
    path.join(pkgRoot, "src", "index"),
    path.join(pkgRoot, "src", "index.mjs"),
    path.join(pkgRoot, "src", "index.ts"),
  ];

  const chooseExisting = (...paths: string[]): string => {
    const seen = new Set<string>();
    for (const p of paths) {
      const resolved = path.resolve(p);
      if (seen.has(resolved)) continue;
      seen.add(resolved);
      if (existsSync(resolved)) return resolved;
    }
    // Return first candidate even when missing so callers still get a useful path in errors.
    return path.resolve(paths[0] ?? fallback);
  };

  try {
    const raw = await fs.readFile(path.join(pkgRoot, "package.json"), "utf-8");
    const pkg = JSON.parse(raw) as {
      name?: string;
      main?: string;
      exports?: Record<string, string | Record<string, string>> | string;
    };

    if (typeof pkg.exports === "object" && pkg.exports["."] !== undefined) {
      const dot = pkg.exports["."];
      const resolved =
        typeof dot === "string" ? dot : dot.import || dot.default;
      if (typeof resolved === "string") {
        return chooseExisting(
          path.resolve(pkgRoot, resolved),
          ...fallbackCandidates,
        );
      }
    }
    if (typeof pkg.exports === "string") {
      return chooseExisting(
        path.resolve(pkgRoot, pkg.exports),
        ...fallbackCandidates,
      );
    }
    if (pkg.main) {
      return chooseExisting(
        path.resolve(pkgRoot, pkg.main),
        ...fallbackCandidates,
      );
    }
    return chooseExisting(...fallbackCandidates);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return chooseExisting(...fallbackCandidates);
    }
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Config → Character mapping
// ---------------------------------------------------------------------------

/**
 * Propagate channel credentials from Milady config into process.env so
 * that elizaOS plugins can find them.
 */
/** @internal Exported for testing. */
export function applyConnectorSecretsToEnv(config: MiladyConfig): void {
  // Prefer config.connectors, fall back to config.channels for backward compatibility
  const connectors = config.connectors ?? config.channels ?? {};

  for (const [channelName, channelConfig] of Object.entries(connectors)) {
    if (!channelConfig || typeof channelConfig !== "object") continue;
    const configObj = channelConfig as Record<string, unknown>;

    // Discord plugins in the ecosystem use both DISCORD_API_TOKEN and
    // DISCORD_BOT_TOKEN across versions. Mirror to both when available.
    if (channelName === "discord") {
      const tokenValue =
        (typeof configObj.token === "string" && configObj.token.trim()) ||
        (typeof configObj.botToken === "string" && configObj.botToken.trim()) ||
        "";
      if (tokenValue) {
        if (!process.env.DISCORD_API_TOKEN) {
          process.env.DISCORD_API_TOKEN = tokenValue;
        }
        if (!process.env.DISCORD_BOT_TOKEN) {
          process.env.DISCORD_BOT_TOKEN = tokenValue;
        }
      }
    }

    const envMap = CHANNEL_ENV_MAP[channelName];
    if (!envMap) continue;

    for (const [configField, envKey] of Object.entries(envMap)) {
      const value = configObj[configField];
      if (typeof value === "string" && value.trim()) {
        // Set if unset, or overwrite stale [REDACTED] placeholders
        const existing = process.env[envKey];
        if (!existing || existing.startsWith("[REDACT")) {
          process.env[envKey] = value;
        }
      }
    }
  }
}

/**
 * Auto-resolve Discord Application ID from the bot token via Discord API.
 * Called during async runtime init so that users only need a bot token.
 */
/** @internal Exported for testing. */
export async function autoResolveDiscordAppId(): Promise<void> {
  if (process.env.DISCORD_APPLICATION_ID) return;

  const discordToken =
    process.env.DISCORD_API_TOKEN || process.env.DISCORD_BOT_TOKEN;
  if (!discordToken) return;

  try {
    const res = await fetch(
      "https://discord.com/api/v10/oauth2/applications/@me",
      { headers: { Authorization: `Bot ${discordToken}` } },
    );

    if (!res.ok) {
      logger.warn(
        `[milady] Failed to auto-resolve Discord Application ID: ${res.status}`,
      );
      return;
    }

    const app = (await res.json()) as { id?: string };
    if (!app.id) return;

    process.env.DISCORD_APPLICATION_ID = app.id;
    logger.info(`[milady] Auto-resolved Discord Application ID: ${app.id}`);
  } catch (err) {
    logger.warn(
      `[milady] Could not auto-resolve Discord Application ID: ${err}`,
    );
  }
}

/**
 * Propagate cloud config from Milady config into process.env so the
 * ElizaCloud plugin can discover settings at startup.
 */
/** @internal Exported for testing. */
export function applyCloudConfigToEnv(config: MiladyConfig): void {
  const cloud = config.cloud;
  if (!cloud) return;

  const cloudMode = cloud.enabled;
  // Require explicit cloud.enabled = true. Previously, undefined + apiKey
  // would count as enabled, causing the model to revert to cloud on restart.
  const effectivelyEnabled = cloudMode === true;

  if (effectivelyEnabled) {
    process.env.ELIZAOS_CLOUD_ENABLED = "true";
    logger.info(
      `[milady] Cloud config: enabled=${cloud.enabled}, hasApiKey=${Boolean(cloud.apiKey)}, baseUrl=${cloud.baseUrl ?? "(default)"}`,
    );
  } else {
    delete process.env.ELIZAOS_CLOUD_ENABLED;
    delete process.env.ELIZAOS_CLOUD_SMALL_MODEL;
    delete process.env.ELIZAOS_CLOUD_LARGE_MODEL;
  }
  if (cloud.apiKey) {
    process.env.ELIZAOS_CLOUD_API_KEY = cloud.apiKey;
  } else {
    delete process.env.ELIZAOS_CLOUD_API_KEY;
  }
  if (cloud.baseUrl) {
    process.env.ELIZAOS_CLOUD_BASE_URL = cloud.baseUrl;
  } else {
    delete process.env.ELIZAOS_CLOUD_BASE_URL;
  }

  // Propagate model names so the cloud plugin picks them up.  Falls back to
  // sensible defaults when cloud is enabled but no explicit selection exists.
  // Skip when inferenceMode is "byok"/"local" or services.inference is off —
  // user's own keys handle models.
  // If the user chose a subscription provider, treat that as "byok" unless
  // they explicitly set inferenceMode to "cloud".
  const hasSubProvider = Boolean(config.agents?.defaults?.subscriptionProvider);
  const explicitMode = cloud.inferenceMode;
  const inferenceMode = explicitMode ?? (hasSubProvider ? "byok" : "cloud");
  const inferenceToggle = cloud.services?.inference ?? true;
  const cloudDoesInference =
    inferenceMode === "cloud" && inferenceToggle !== false;
  const models = (config as Record<string, unknown>).models as
    | { small?: string; large?: string }
    | undefined;
  if (effectivelyEnabled && cloudDoesInference) {
    const small = models?.small || "openai/gpt-5-mini";
    const large = models?.large || "anthropic/claude-sonnet-4.5";
    process.env.SMALL_MODEL = small;
    process.env.LARGE_MODEL = large;
    process.env.ELIZAOS_CLOUD_SMALL_MODEL = small;
    process.env.ELIZAOS_CLOUD_LARGE_MODEL = large;
  } else if (effectivelyEnabled) {
    // Cloud enabled but inference handled by user's own keys — clean cloud
    // model env vars so the cloud plugin doesn't intercept model calls.
    delete process.env.ELIZAOS_CLOUD_SMALL_MODEL;
    delete process.env.ELIZAOS_CLOUD_LARGE_MODEL;
  }

  // Propagate per-service disable flags so downstream code can check them
  // without needing direct access to the MiladyConfig object.
  const services = cloud.services;
  if (services) {
    if (services.tts === false) {
      process.env.MILADY_CLOUD_TTS_DISABLED = "true";
    } else {
      delete process.env.MILADY_CLOUD_TTS_DISABLED;
    }
    if (services.media === false) {
      process.env.MILADY_CLOUD_MEDIA_DISABLED = "true";
    } else {
      delete process.env.MILADY_CLOUD_MEDIA_DISABLED;
    }
    if (services.embeddings === false) {
      process.env.MILADY_CLOUD_EMBEDDINGS_DISABLED = "true";
    } else {
      delete process.env.MILADY_CLOUD_EMBEDDINGS_DISABLED;
    }
    if (services.rpc === false) {
      process.env.MILADY_CLOUD_RPC_DISABLED = "true";
    } else {
      delete process.env.MILADY_CLOUD_RPC_DISABLED;
    }
  }
}

/**
 * Translate `config.database` into the environment variables that
 * `@elizaos/plugin-sql` reads at init time (`POSTGRES_URL`, `PGLITE_DATA_DIR`).
 *
 * When the provider is "postgres", we build a connection string from the
 * credentials (or use the explicit `connectionString` field) and set
 * `POSTGRES_URL`. When the provider is "pglite" (the default), we set
 * `PGLITE_DATA_DIR` to either the configured value or a stable workspace
 * default (`~/.milady/workspace/.eliza/.elizadb`) and remove any stale
 * `POSTGRES_URL`.
 */
/** @internal Exported for testing. */
export function applyX402ConfigToEnv(config: MiladyConfig): void {
  const x402 = (config as Record<string, unknown>).x402 as
    | { enabled?: boolean; apiKey?: string; baseUrl?: string }
    | undefined;
  if (!x402?.enabled) return;
  if (!process.env.X402_ENABLED) process.env.X402_ENABLED = "true";
  if (x402.apiKey && !process.env.X402_API_KEY)
    process.env.X402_API_KEY = x402.apiKey;
  if (x402.baseUrl && !process.env.X402_BASE_URL)
    process.env.X402_BASE_URL = x402.baseUrl;
}

function resolveDefaultPgliteDataDir(config: MiladyConfig): string {
  const workspaceDir =
    config.agents?.defaults?.workspace ?? resolveDefaultAgentWorkspaceDir();
  return path.join(resolveUserPath(workspaceDir), ".eliza", ".elizadb");
}

/** @internal Exported for testing. */
export function applyDatabaseConfigToEnv(config: MiladyConfig): void {
  const db = config.database;
  const provider = db?.provider ?? "pglite";

  if (provider === "postgres" && db?.postgres) {
    const pg = db.postgres;
    let url = pg.connectionString;
    if (!url) {
      const host = pg.host ?? "localhost";
      const port = pg.port ?? 5432;
      const user = encodeURIComponent(pg.user ?? "postgres");
      const password = pg.password ? encodeURIComponent(pg.password) : "";
      const database = pg.database ?? "postgres";
      const auth = password ? `${user}:${password}` : user;
      const sslParam = pg.ssl ? "?sslmode=require" : "";
      url = `postgresql://${auth}@${host}:${port}/${database}${sslParam}`;
    }
    process.env.POSTGRES_URL = url;
    // Clear PGLite dir so plugin-sql does not fall back to PGLite
    delete process.env.PGLITE_DATA_DIR;
  } else {
    // PGLite mode (default): ensure no leftover POSTGRES_URL and pin
    // PGLite to the workspace path unless overridden by config/env.
    delete process.env.POSTGRES_URL;

    const configuredDataDir = db?.pglite?.dataDir?.trim();
    if (configuredDataDir) {
      process.env.PGLITE_DATA_DIR = resolveUserPath(configuredDataDir);
      // Fall through to directory creation below instead of returning early
    }

    const envDataDir = process.env.PGLITE_DATA_DIR?.trim();
    if (!envDataDir) {
      process.env.PGLITE_DATA_DIR = resolveDefaultPgliteDataDir(config);
    }

    // Ensure the PGlite data directory exists before init so PGlite does
    // not silently fall back to in-memory mode on first run.
    const dataDir = process.env.PGLITE_DATA_DIR;
    if (dataDir) {
      const alreadyExisted = existsSync(dataDir);
      mkdirSync(dataDir, { recursive: true });
      logger.info(
        `[milady] PGlite data dir: ${dataDir} (${alreadyExisted ? "existed" : "created"})`,
      );

      // Remove stale postmaster.pid left by a crashed process. Without this,
      // PGlite sees the lock and either fails or triggers the destructive
      // resetPgliteDataDir path, wiping all conversation history.
      cleanStalePglitePid(dataDir);
    }
  }
}

type PglitePidFileStatus =
  | "missing"
  | "active"
  | "active-unconfirmed"
  | "cleared-stale"
  | "cleared-malformed"
  | "check-failed";

type PgliteRecoveryAction =
  | "none"
  | "retry-without-reset"
  | "reset-data-dir"
  | "fail-active-lock";

function reconcilePglitePidFile(dataDir: string): PglitePidFileStatus {
  const pidPath = path.join(dataDir, "postmaster.pid");
  if (!existsSync(pidPath)) return "missing";

  try {
    const content = readFileSync(pidPath, "utf-8");
    const firstLine = content.split("\n")[0]?.trim();
    const pid = parseInt(firstLine, 10);

    if (Number.isNaN(pid) || pid <= 0) {
      // Malformed pid file — remove it
      unlinkSync(pidPath);
      logger.warn(`[milady] Removed malformed PGlite postmaster.pid`);
      return "cleared-malformed";
    }

    // Check if the process is still alive
    try {
      process.kill(pid, 0); // signal 0 = existence check, doesn't kill
      // Process exists — pid file is NOT stale, leave it alone
      logger.info(
        `[milady] PGlite postmaster.pid references running process ${pid} — leaving intact`,
      );
      return "active";
    } catch (killErr: unknown) {
      const code = (killErr as NodeJS.ErrnoException).code;
      if (code === "ESRCH") {
        // Process doesn't exist — stale pid file, safe to remove
        unlinkSync(pidPath);
        logger.warn(
          `[milady] Removed stale PGlite postmaster.pid (process ${pid} not running)`,
        );
        return "cleared-stale";
      } else {
        // EPERM or other — process may be alive under a different user,
        // leave the file alone to avoid data directory corruption
        logger.warn(
          `[milady] Cannot confirm postmaster.pid staleness (${code}) — leaving intact`,
        );
        return "active-unconfirmed";
      }
    }
  } catch (err) {
    logger.warn(
      `[milady] Failed to check PGlite postmaster.pid: ${formatError(err)}`,
    );
    return "check-failed";
  }
}

/**
 * Check for and remove a stale postmaster.pid in the PGlite data directory.
 * The pid file is stale if the recorded process is no longer running.
 */
export function cleanStalePglitePid(dataDir: string): void {
  void reconcilePglitePidFile(dataDir);
}

function collectErrorMessages(err: unknown): string[] {
  const messages: string[] = [];
  const seen = new Set<unknown>();
  let current: unknown = err;

  while (current && !seen.has(current)) {
    seen.add(current);

    if (typeof current === "string") {
      messages.push(current);
      break;
    }

    if (current instanceof Error) {
      if (current.message) messages.push(current.message);
      if (current.stack) messages.push(current.stack);
      current = (current as Error & { cause?: unknown }).cause;
      continue;
    }

    if (typeof current === "object") {
      const maybeErr = current as { message?: unknown; cause?: unknown };
      if (typeof maybeErr.message === "string" && maybeErr.message) {
        messages.push(maybeErr.message);
      }
      if (maybeErr.cause !== undefined) {
        current = maybeErr.cause;
        continue;
      }
    }

    break;
  }

  return messages;
}

function isPgliteLockError(err: unknown): boolean {
  const haystack = collectErrorMessages(err).join("\n").toLowerCase();
  if (!haystack) return false;

  const hasPglite = haystack.includes("pglite");
  const hasSqlite = haystack.includes("sqlite");
  const hasLockSignal =
    haystack.includes("database is locked") ||
    haystack.includes("lock file already exists");

  return hasLockSignal && (hasPglite || hasSqlite);
}

/** @internal Exported for testing. */
export function isRecoverablePgliteInitError(err: unknown): boolean {
  const haystack = collectErrorMessages(err).join("\n").toLowerCase();
  if (!haystack) return false;

  const hasAbort = haystack.includes("aborted(). build with -sassertions");
  const hasPglite = haystack.includes("pglite");
  const hasSqlite = haystack.includes("sqlite");
  const hasMigrationsSchema =
    haystack.includes("create schema if not exists migrations") ||
    haystack.includes("failed query: create schema if not exists migrations");
  const hasRecoverableStorageSignal = [
    "database disk image is malformed",
    "file is not a database",
    "malformed database schema",
    "database is locked",
    "lock file already exists",
    "wal file",
    "checkpoint failed",
    "checksum mismatch",
    "corrupt",
  ].some((needle) => haystack.includes(needle));

  if (hasMigrationsSchema) return true;
  if (hasAbort && hasPglite) return true;
  if (hasRecoverableStorageSignal && (hasPglite || hasSqlite)) return true;
  return false;
}

/** @internal Exported for testing. */
export function getPgliteRecoveryAction(
  err: unknown,
  dataDir: string,
): PgliteRecoveryAction {
  if (!isRecoverablePgliteInitError(err)) return "none";
  if (!isPgliteLockError(err)) return "reset-data-dir";

  const pidStatus = reconcilePglitePidFile(dataDir);
  if (
    pidStatus === "active" ||
    pidStatus === "active-unconfirmed" ||
    pidStatus === "check-failed"
  ) {
    return "fail-active-lock";
  }
  if (pidStatus === "cleared-stale" || pidStatus === "cleared-malformed") {
    return "retry-without-reset";
  }
  return "reset-data-dir";
}

function createActivePgliteLockError(dataDir: string, err: unknown): Error {
  return new Error(
    `PGLite data dir is already in use at ${dataDir}. Close the other Milady process or set a different PGLITE_DATA_DIR before retrying.`,
    { cause: err },
  );
}

function resolveActivePgliteDataDir(config: MiladyConfig): string | null {
  const provider = config.database?.provider ?? "pglite";
  if (provider === "postgres") return null;

  const configured = process.env.PGLITE_DATA_DIR?.trim();
  const dataDir = configured || resolveDefaultPgliteDataDir(config);
  return resolveUserPath(dataDir);
}

async function resetPgliteDataDir(dataDir: string): Promise<void> {
  const normalized = path.resolve(dataDir);
  const root = path.parse(normalized).root;
  if (normalized === root) {
    throw new Error(`Refusing to reset unsafe PGLite path: ${normalized}`);
  }

  const stamp = new Date()
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\..*$/, "")
    .replace("T", "-");
  const backupDir = `${normalized}.corrupt-${stamp}`;

  if (existsSync(normalized)) {
    try {
      await fs.rename(normalized, backupDir);
      logger.warn(
        `[milady] Backed up existing PGLite data dir to ${backupDir}`,
      );
    } catch (err) {
      logger.warn(
        `[milady] Failed to back up PGLite data dir (${formatError(err)}); deleting ${normalized} instead`,
      );
      await fs.rm(normalized, { recursive: true, force: true });
    }
  }

  await fs.mkdir(normalized, { recursive: true });
}

async function initializeDatabaseAdapter(
  runtime: AgentRuntime,
  config: MiladyConfig,
): Promise<void> {
  if (!runtime.adapter || (await runtime.adapter.isReady())) return;

  try {
    await runtime.adapter.init();
    logger.info(
      "[milady] Database adapter initialized early (before plugin inits)",
    );
  } catch (err) {
    const pgliteDataDir = resolveActivePgliteDataDir(config);
    if (!pgliteDataDir) {
      throw err;
    }

    const recoveryAction = getPgliteRecoveryAction(err, pgliteDataDir);
    if (recoveryAction === "none") {
      throw err;
    }
    if (recoveryAction === "fail-active-lock") {
      throw createActivePgliteLockError(pgliteDataDir, err);
    }

    if (recoveryAction === "retry-without-reset") {
      logger.warn(
        `[milady] PGLite init failed (${formatError(err)}). Cleared a stale PGLite lock in ${pgliteDataDir} and retrying without resetting data.`,
      );
    } else {
      logger.warn(
        `[milady] PGLite init failed (${formatError(err)}). Resetting local DB at ${pgliteDataDir} and retrying once.`,
      );
      await resetPgliteDataDir(pgliteDataDir);
      process.env.PGLITE_DATA_DIR = pgliteDataDir;
    }

    await runtime.adapter.init();
    logger.info(
      recoveryAction === "retry-without-reset"
        ? "[milady] Database adapter recovered after clearing a stale PGLite lock"
        : "[milady] Database adapter recovered after resetting PGLite data",
    );
  }

  // Health check: verify PGlite data directory has files after init.
  // Runs on BOTH the happy path and the recovery path.
  await verifyPgliteDataDir(config);
}

/**
 * Verify PGlite data directory contains files after init.
 * Warns if the directory is empty (suggests ephemeral/in-memory fallback).
 */
async function verifyPgliteDataDir(config: MiladyConfig): Promise<void> {
  const pgliteDataDir = resolveActivePgliteDataDir(config);
  if (!pgliteDataDir || !existsSync(pgliteDataDir)) return;

  try {
    const files = await fs.readdir(pgliteDataDir);
    logger.info(
      `[milady] PGlite health check: ${files.length} file(s) in ${pgliteDataDir}`,
    );
    if (files.length === 0) {
      logger.warn(
        `[milady] PGlite data directory is empty after init — data may not persist across restarts`,
      );
    }
  } catch (err) {
    logger.warn(`[milady] PGlite health check failed: ${formatError(err)}`);
  }
}

function isPluginAlreadyRegisteredError(err: unknown): boolean {
  return formatError(err).toLowerCase().includes("already registered");
}

interface RuntimeWithMethodBindings extends AgentRuntime {
  __miladyMethodBindingsInstalled?: boolean;
  __miladyComponentWriteDiagnosticsInstalled?: boolean;
  __miladyEntityWriteDiagnosticsInstalled?: boolean;
  __miladyEntityCreateMutex?: Promise<void>;
}

interface RuntimeWithActionAliases extends Omit<AgentRuntime, "actions"> {
  __miladyActionAliasesInstalled?: boolean;
  actions?: Array<{ name?: string; similes?: string[] }>;
}

type DbErrorLike = {
  name?: unknown;
  message?: unknown;
  code?: unknown;
  detail?: unknown;
  hint?: unknown;
  constraint?: unknown;
  schema?: unknown;
  table?: unknown;
  column?: unknown;
  where?: unknown;
  cause?: unknown;
};

function getConstraintName(error: unknown): string | null {
  if (!error || typeof error !== "object") return null;
  const err = error as DbErrorLike;
  if (typeof err.constraint === "string" && err.constraint.length > 0) {
    return err.constraint;
  }
  if (err.cause) return getConstraintName(err.cause);
  return null;
}

function isComponentsWorldFkViolation(error: unknown): boolean {
  return getConstraintName(error) === "components_world_id_worlds_id_fk";
}

function toErrorDetails(error: unknown, depth = 0): Record<string, unknown> {
  if (!error || typeof error !== "object") {
    return { value: String(error) };
  }
  const err = error as DbErrorLike;
  const details: Record<string, unknown> = {};
  for (const key of [
    "name",
    "message",
    "code",
    "detail",
    "hint",
    "constraint",
    "schema",
    "table",
    "column",
    "where",
  ] as const) {
    const value = err[key];
    if (typeof value === "string" || typeof value === "number") {
      details[key] = value;
    }
  }
  if (depth < 2 && err.cause) {
    details.cause = toErrorDetails(err.cause, depth + 1);
  }
  return details;
}

async function withEntityCreateMutex<T>(
  runtimeWithBindings: RuntimeWithMethodBindings,
  fn: () => Promise<T>,
): Promise<T> {
  const previous = runtimeWithBindings.__miladyEntityCreateMutex;
  let release: () => void = () => {};
  runtimeWithBindings.__miladyEntityCreateMutex = new Promise<void>(
    (resolve) => {
      release = resolve;
    },
  );
  if (previous) {
    await previous;
  }
  try {
    return await fn();
  } finally {
    release();
  }
}

function summarizeComponentWrite(input: unknown): Record<string, unknown> {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return { inputType: typeof input };
  }
  const record = input as Record<string, unknown>;
  const data = record.data;
  const dataKeys =
    data && typeof data === "object" && !Array.isArray(data)
      ? Object.keys(data as Record<string, unknown>).slice(0, 20)
      : [];

  return {
    id: record.id,
    type: record.type,
    entityId: record.entityId ?? record.entity_id,
    sourceEntityId: record.sourceEntityId ?? record.source_entity_id,
    roomId: record.roomId ?? record.room_id,
    worldId: record.worldId ?? record.world_id,
    agentId: record.agentId ?? record.agent_id,
    dataKeys,
  };
}

export function installRuntimeMethodBindings(runtime: AgentRuntime): void {
  const runtimeWithBindings = runtime as RuntimeWithMethodBindings;
  if (runtimeWithBindings.__miladyMethodBindingsInstalled) {
    return;
  }

  // Some plugin builds store this method and invoke it later without the
  // runtime receiver, which breaks private-field access in AgentRuntime.
  runtime.getConversationLength = runtime.getConversationLength.bind(runtime);

  // Wrap getSetting() to fall back to process.env for known keys when the
  // core returns null. elizaOS core returns null for missing keys, but some
  // plugins (e.g. @elizaos/plugin-google-genai) check `!== undefined` and
  // convert null to the string "null", causing API calls like `models/null`.
  // Scoped to an allowlist to avoid leaking arbitrary env vars to plugins.
  const GETSETTING_ENV_ALLOWLIST = new Set([
    // Model provider API keys
    "ANTHROPIC_API_KEY",
    "OPENAI_API_KEY",
    "GOOGLE_GENERATIVE_AI_API_KEY",
    "GOOGLE_API_KEY",
    "GEMINI_API_KEY",
    "GROQ_API_KEY",
    "XAI_API_KEY",
    "DEEPSEEK_API_KEY",
    "OPENROUTER_API_KEY",
    // Google model defaults
    "GOOGLE_SMALL_MODEL",
    "GOOGLE_LARGE_MODEL",
    // GitHub
    "GITHUB_TOKEN",
    "GITHUB_OAUTH_CLIENT_ID",
    // Coding agent model preferences
    "PARALLAX_CLAUDE_MODEL_POWERFUL",
    "PARALLAX_CLAUDE_MODEL_FAST",
    "PARALLAX_GEMINI_MODEL_POWERFUL",
    "PARALLAX_GEMINI_MODEL_FAST",
    "PARALLAX_CODEX_MODEL_POWERFUL",
    "PARALLAX_CODEX_MODEL_FAST",
    "PARALLAX_AIDER_PROVIDER",
    "PARALLAX_AIDER_MODEL_POWERFUL",
    "PARALLAX_AIDER_MODEL_FAST",
    // Custom credential forwarding — intentionally broad: users configure which env vars
    // to forward to coding agents via this comma-separated key list (e.g. MCP server tokens).
    "CUSTOM_CREDENTIAL_KEYS",
  ]);
  const originalGetSetting = runtime.getSetting.bind(runtime);
  runtime.getSetting = (key: string) => {
    const result = originalGetSetting(key);
    if (result !== null && result !== undefined) return result;
    if (GETSETTING_ENV_ALLOWLIST.has(key)) {
      const envVal = process.env[key];
      if (envVal !== undefined && envVal.trim() !== "") return envVal;
    }
    return result;
  };

  // Add targeted diagnostics around component writes. Rolodex reflection and
  // relationship extraction rely heavily on components; when inserts fail,
  // upstream logs often hide the concrete DB cause/constraint.
  if (!runtimeWithBindings.__miladyComponentWriteDiagnosticsInstalled) {
    type CreateComponentFn = (component: Component) => Promise<boolean>;
    type UpdateComponentFn = (component: Component) => Promise<void>;
    const runtimeWithComponentWrites = runtime as AgentRuntime & {
      createComponent?: CreateComponentFn;
      updateComponent?: UpdateComponentFn;
    };

    if (typeof runtimeWithComponentWrites.createComponent === "function") {
      const originalCreate =
        runtimeWithComponentWrites.createComponent.bind(runtime);
      runtimeWithComponentWrites.createComponent = async (input: Component) => {
        try {
          return await originalCreate(input);
        } catch (error) {
          // Recovery path: some evaluators (e.g. relationship extraction)
          // compute a synthetic worldId that may not exist yet. If we hit the
          // components->worlds FK, retry once with the room's canonical worldId.
          if (
            isComponentsWorldFkViolation(error) &&
            input.roomId &&
            typeof runtime.getRoom === "function"
          ) {
            try {
              const room = await runtime.getRoom(input.roomId);
              if (room?.worldId && room.worldId !== input.worldId) {
                logger.warn(
                  `[milady] createComponent retry with room worldId (${room.worldId}) after FK violation`,
                );
                const recovered: Component = {
                  ...input,
                  worldId: room.worldId,
                };
                return await originalCreate(recovered);
              }
            } catch (retryLookupError) {
              logger.warn(
                `[milady] createComponent recovery lookup failed: ${formatError(retryLookupError)}`,
              );
            }
          }

          const component = summarizeComponentWrite(input);
          logger.error(
            `[milady] createComponent failed: ${formatError(error)} | component=${JSON.stringify(component)}`,
          );
          logger.error(
            `[milady] createComponent db details: ${JSON.stringify(toErrorDetails(error))}`,
          );
          throw error;
        }
      };
    }

    if (typeof runtimeWithComponentWrites.updateComponent === "function") {
      const originalUpdate =
        runtimeWithComponentWrites.updateComponent.bind(runtime);
      runtimeWithComponentWrites.updateComponent = async (input: Component) => {
        try {
          return await originalUpdate(input);
        } catch (error) {
          const component = summarizeComponentWrite(input);
          logger.error(
            `[milady] updateComponent failed: ${formatError(error)} | component=${JSON.stringify(component)}`,
          );
          logger.error(
            `[milady] updateComponent db details: ${JSON.stringify(toErrorDetails(error))}`,
          );
          throw error;
        }
      };
    }

    runtimeWithBindings.__miladyComponentWriteDiagnosticsInstalled = true;
  }

  // Proactive guard for plugin-sql entity creation. Some evaluators may attempt
  // to create the same entity in rapid succession; plugin-sql's batch insert is
  // non-idempotent and can fail entire writes on duplicate/conflicting rows.
  if (!runtimeWithBindings.__miladyEntityWriteDiagnosticsInstalled) {
    type CreateEntitiesFn = (entities: Entity[]) => Promise<boolean>;
    type GetEntitiesByIdsFn = (entityIds: UUID[]) => Promise<Entity[]>;
    type EnsureEntityExistsFn = (entity: Entity) => Promise<boolean>;
    const runtimeWithEntityWrites = runtime as AgentRuntime & {
      createEntities?: CreateEntitiesFn;
      getEntitiesByIds?: GetEntitiesByIdsFn;
      ensureEntityExists?: EnsureEntityExistsFn;
    };

    if (typeof runtimeWithEntityWrites.createEntities === "function") {
      const originalCreateEntities =
        runtimeWithEntityWrites.createEntities.bind(runtime);
      runtimeWithEntityWrites.createEntities = async (
        entities: Entity[],
      ): Promise<boolean> => {
        return withEntityCreateMutex(runtimeWithBindings, async () => {
          const uniqueById = new Map<UUID, Entity>();
          for (const entity of entities) {
            if (entity?.id) uniqueById.set(entity.id as UUID, entity);
          }
          const deduped = Array.from(uniqueById.values());
          if (deduped.length === 0) return true;

          let missing = deduped;
          if (typeof runtimeWithEntityWrites.getEntitiesByIds === "function") {
            try {
              const existing =
                (await runtimeWithEntityWrites.getEntitiesByIds(
                  deduped.map((e) => e.id as UUID),
                )) ?? [];
              const existingIds = new Set<UUID>();
              for (const entity of existing) {
                if (entity?.id) existingIds.add(entity.id as UUID);
              }
              missing = deduped.filter(
                (entity) => !existingIds.has(entity.id as UUID),
              );
            } catch (err) {
              logger.warn(
                `[milady] createEntities precheck failed; proceeding with guarded insert: ${formatError(err)}`,
              );
            }
          }
          if (missing.length === 0) return true;

          const ok = await originalCreateEntities(missing);
          if (ok) return true;

          if (
            typeof runtimeWithEntityWrites.ensureEntityExists === "function"
          ) {
            let allRecovered = true;
            for (const entity of missing) {
              try {
                const ensured =
                  await runtimeWithEntityWrites.ensureEntityExists(entity);
                allRecovered = allRecovered && ensured;
              } catch (err) {
                allRecovered = false;
                logger.warn(
                  `[milady] ensureEntityExists recovery failed for ${String(entity.id)}: ${formatError(err)}`,
                );
              }
            }
            if (allRecovered) return true;
          }

          logger.warn(
            `[milady] createEntities unresolved after guarded retries (requested=${entities.length}, deduped=${deduped.length}, missing=${missing.length})`,
          );
          return false;
        });
      };
    }

    runtimeWithBindings.__miladyEntityWriteDiagnosticsInstalled = true;
  }

  runtimeWithBindings.__miladyMethodBindingsInstalled = true;
}

function installActionAliases(runtime: AgentRuntime): void {
  const runtimeWithAliases = runtime as RuntimeWithActionAliases;
  if (runtimeWithAliases.__miladyActionAliasesInstalled) {
    return;
  }

  const actions = Array.isArray(runtimeWithAliases.actions)
    ? runtimeWithAliases.actions
    : [];

  // Keep compaction automatic-only; do not allow manual COMPACT_SESSION invokes.
  const compactSessionIndex = actions.findIndex(
    (action) => action?.name?.toUpperCase() === "COMPACT_SESSION",
  );
  if (compactSessionIndex !== -1) {
    actions.splice(compactSessionIndex, 1);
    logger.info(
      "[milady] Disabled manual COMPACT_SESSION action; auto-compaction remains enabled",
    );
  }

  // Compatibility alias: older prompts/docs still reference CODE_TASK,
  // while plugin-agent-orchestrator exposes CREATE_TASK.
  const createTaskAction = actions.find(
    (action) => action?.name?.toUpperCase() === "CREATE_TASK",
  );
  if (createTaskAction) {
    const similes = Array.isArray(createTaskAction.similes)
      ? createTaskAction.similes
      : [];
    const hasCodeTaskAlias = similes.some(
      (simile) => simile.toUpperCase() === "CODE_TASK",
    );
    if (!hasCodeTaskAlias) {
      createTaskAction.similes = [...similes, "CODE_TASK"];
      logger.info(
        "[milady] Added action alias CODE_TASK -> CREATE_TASK for agent-orchestrator",
      );
    }
  }

  runtimeWithAliases.__miladyActionAliasesInstalled = true;
}

async function registerSqlPluginWithRecovery(
  runtime: AgentRuntime,
  sqlPlugin: ResolvedPlugin,
  config: MiladyConfig,
): Promise<void> {
  let registerError: unknown = null;

  try {
    await runtime.registerPlugin(sqlPlugin.plugin);
  } catch (err) {
    registerError = err;
  }

  if (registerError) {
    const pgliteDataDir = resolveActivePgliteDataDir(config);
    if (!pgliteDataDir) {
      throw registerError;
    }

    const recoveryAction = getPgliteRecoveryAction(
      registerError,
      pgliteDataDir,
    );
    if (recoveryAction === "none") {
      throw registerError;
    }
    if (recoveryAction === "fail-active-lock") {
      throw createActivePgliteLockError(pgliteDataDir, registerError);
    }

    if (recoveryAction === "retry-without-reset") {
      logger.warn(
        `[milady] SQL plugin registration failed (${formatError(registerError)}). Cleared a stale PGLite lock in ${pgliteDataDir} and retrying without resetting data.`,
      );
    } else {
      logger.warn(
        `[milady] SQL plugin registration failed (${formatError(registerError)}). Resetting local PGLite DB at ${pgliteDataDir} and retrying once.`,
      );
      await resetPgliteDataDir(pgliteDataDir);
      process.env.PGLITE_DATA_DIR = pgliteDataDir;
    }

    try {
      await runtime.registerPlugin(sqlPlugin.plugin);
    } catch (retryErr) {
      if (!isPluginAlreadyRegisteredError(retryErr)) {
        throw retryErr;
      }
    }
  }

  await initializeDatabaseAdapter(runtime, config);
}

/**
 * Build an elizaOS Character from the Milady config.
 *
 * Resolves the agent name from `config.agents.list` (first entry) or
 * `config.ui.assistant.name`, falling back to "Milady".  Character
 * personality data (bio, system prompt, style, etc.) is stored in the
 * database — not the config file — so we only provide sensible defaults
 * here for the initial bootstrap.
 */
/** @internal Exported for testing. */
export function buildCharacterFromConfig(config: MiladyConfig): Character {
  // Resolve name: agents list → ui assistant → "Milady"
  const agentEntry = config.agents?.list?.[0];
  const name = agentEntry?.name ?? config.ui?.assistant?.name ?? "Milady";
  const bundledPreset = (() => {
    const presetByName: Record<string, string> = {
      Reimu: "uwu~",
      Marisa: "hell yeah",
      Yukari: "lol k",
      Sakuya: "Noted.",
      Koishi: "hehe~",
      Remilia: "...",
      Reisen: "locked in",
    };
    const presetCatchphrase = presetByName[name.trim()];
    if (!presetCatchphrase) return undefined;
    return STYLE_PRESETS.find(
      (preset) => preset.catchphrase === presetCatchphrase,
    );
  })();

  // Read personality fields from the agent config entry (set during
  // onboarding from the chosen style preset).  Fall back to generic
  // defaults when the preset data is not present (e.g. pre-onboarding
  // bootstrap or configs created before this change). For built-in default
  // characters, fall back to the bundled preset so legacy name-only configs
  // still retain their default posts/messages.
  const bio = agentEntry?.bio ??
    bundledPreset?.bio ?? [
      "{{name}} is an AI assistant powered by Milady and elizaOS.",
    ];
  const systemPrompt =
    agentEntry?.system ??
    bundledPreset?.system ??
    "You are {{name}}, an autonomous AI agent powered by elizaOS.";
  const style = agentEntry?.style ?? bundledPreset?.style;
  const adjectives = agentEntry?.adjectives ?? bundledPreset?.adjectives;
  const postExamples = agentEntry?.postExamples ?? bundledPreset?.postExamples;
  const messageExamples =
    agentEntry?.messageExamples ?? bundledPreset?.messageExamples;

  // Collect secrets from process.env (API keys the plugins need)
  const secretKeys = [
    "ANTHROPIC_API_KEY",
    "OPENAI_API_KEY",
    "GEMINI_API_KEY",
    "GOOGLE_API_KEY",
    "GOOGLE_GENERATIVE_AI_API_KEY",
    "GROQ_API_KEY",
    "XAI_API_KEY",
    "OPENROUTER_API_KEY",
    "AI_GATEWAY_API_KEY",
    "AIGATEWAY_API_KEY",
    "AI_GATEWAY_BASE_URL",
    "AI_GATEWAY_SMALL_MODEL",
    "AI_GATEWAY_LARGE_MODEL",
    "AI_GATEWAY_EMBEDDING_MODEL",
    "AI_GATEWAY_EMBEDDING_DIMENSIONS",
    "AI_GATEWAY_IMAGE_MODEL",
    "AI_GATEWAY_TIMEOUT_MS",
    "OLLAMA_BASE_URL",
    "DISCORD_API_TOKEN",
    "DISCORD_APPLICATION_ID",
    "DISCORD_BOT_TOKEN",
    "TELEGRAM_BOT_TOKEN",
    "SLACK_BOT_TOKEN",
    "SLACK_APP_TOKEN",
    "SLACK_USER_TOKEN",
    "SIGNAL_ACCOUNT_NUMBER",
    "MSTEAMS_APP_ID",
    "MSTEAMS_APP_PASSWORD",
    "MATTERMOST_BOT_TOKEN",
    "MATTERMOST_BASE_URL",
    // ElizaCloud secrets
    "ELIZAOS_CLOUD_API_KEY",
    "ELIZAOS_CLOUD_BASE_URL",
    "ELIZAOS_CLOUD_ENABLED",
    // Wallet / blockchain secrets
    "EVM_PRIVATE_KEY",
    "SOLANA_PRIVATE_KEY",
    "ALCHEMY_API_KEY",
    "HELIUS_API_KEY",
    "BIRDEYE_API_KEY",
    "SOLANA_RPC_URL",
    "X402_PRIVATE_KEY",
    "X402_NETWORK",
    "X402_PAY_TO",
    "X402_FACILITATOR_URL",
    "X402_MAX_PAYMENT_USD",
    "X402_MAX_TOTAL_USD",
    "X402_ENABLED",
    "X402_DB_PATH",
    // GitHub access for coding agent plugin
    "GITHUB_TOKEN",
    "GITHUB_OAUTH_CLIENT_ID",
  ];

  const secrets: Record<string, string> = {};
  for (const key of secretKeys) {
    const value = process.env[key];
    if (value?.trim()) {
      secrets[key] = value;
    }
  }

  // Normalise messageExamples to the {examples: [{name,content}]} shape
  // that @elizaos/core expects.  Config may contain EITHER format:
  //   OLD (preset/onboarding): [[{user, content}, ...], ...]
  //   NEW (@elizaos/core):     [{examples: [{name, content}, ...]}, ...]
  const mappedExamples = messageExamples?.map((item: unknown) => {
    // Already in new format — pass through
    if (
      item &&
      typeof item === "object" &&
      "examples" in (item as Record<string, unknown>)
    ) {
      return item as {
        examples: { name: string; content: { text: string } }[];
      };
    }
    // Old format — array of {user, content} entries
    const arr = item as {
      user?: string;
      name?: string;
      content: { text: string };
    }[];
    return {
      examples: arr.map((msg) => ({
        name: msg.name ?? msg.user ?? "",
        content: msg.content,
      })),
    };
  });

  return mergeCharacterDefaults({
    name,
    ...(agentEntry?.username ? { username: agentEntry.username } : {}),
    bio,
    system: systemPrompt,
    ...(agentEntry?.topics ? { topics: agentEntry.topics } : {}),
    ...(style ? { style } : {}),
    ...(adjectives ? { adjectives } : {}),
    ...(postExamples ? { postExamples } : {}),
    ...(mappedExamples ? { messageExamples: mappedExamples } : {}),
    secrets,
  });
}

/**
 * Resolve the primary model identifier from Milady config.
 *
 * Milady stores the model under `agents.defaults.model.primary` as an
 * AgentModelListConfig object. Returns undefined when no model is
 * explicitly configured (elizaOS falls back to whichever model
 * plugin is loaded).
 */
/** @internal Exported for testing. */
export function resolvePrimaryModel(config: MiladyConfig): string | undefined {
  const modelConfig = config.agents?.defaults?.model;
  if (!modelConfig) return undefined;

  // AgentDefaultsConfig.model is AgentModelListConfig: { primary?, fallbacks? }
  return modelConfig.primary;
}

/**
 * Vision is a heavy optional plugin. When Milady enables it, keep the service
 * loaded but idle until the user explicitly selects CAMERA, SCREEN, or BOTH.
 * This avoids background capture loops during normal app startup.
 */
export function resolveVisionModeSetting(
  config: MiladyConfig,
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  const explicitMode = env.VISION_MODE?.trim();
  if (explicitMode) return explicitMode;
  if (config.features?.vision === true) return "OFF";
  return undefined;
}

// ---------------------------------------------------------------------------
// First-run onboarding
// ---------------------------------------------------------------------------

// Name pool + random picker shared with the web UI API server.
// See src/runtime/onboarding-names.ts for the canonical list.
import { pickRandomNames } from "./onboarding-names";

// ---------------------------------------------------------------------------
// Style presets — shared between CLI and GUI onboarding
// ---------------------------------------------------------------------------

import { STYLE_PRESETS } from "../onboarding-presets";

/**
 * Detect whether this is the first run (no agent name configured)
 * and run the onboarding flow:
 *
 *   1. Welcome banner
 *   2. Name selector (4 random + Custom)
 *   3. Catchphrase / writing-style selector
 *   4. Persist agent name to `agents.list[0]` in config
 *
 * Character personality (bio, system prompt, style) is stored in the
 * database at runtime — only the agent name lives in config.
 *
 * Subsequent runs skip this entirely.
 */
async function runFirstTimeSetup(config: MiladyConfig): Promise<MiladyConfig> {
  const agentEntry = config.agents?.list?.[0];
  const hasName = Boolean(agentEntry?.name || config.ui?.assistant?.name);
  if (hasName) return config;

  // Only prompt when stdin is a TTY (interactive terminal)
  if (!process.stdin.isTTY) return config;

  // Load @clack/prompts lazily — only needed for interactive CLI onboarding.
  const clack = await loadClack();

  // ── Step 1: Welcome ────────────────────────────────────────────────────
  clack.intro("WELCOME TO MILADY!");

  // ── Step 2: Name ───────────────────────────────────────────────────────
  const randomNames = pickRandomNames(4);

  const nameChoice = await clack.select({
    message: "♡♡milady♡♡: Hey there, I'm.... err, what was my name again?",
    options: [
      ...randomNames.map((n) => ({ value: n, label: n })),
      { value: "_custom_", label: "Custom...", hint: "type your own" },
    ],
  });

  if (clack.isCancel(nameChoice)) cancelOnboarding();

  let name: string;

  if (nameChoice === "_custom_") {
    const customName = await clack.text({
      message: "OK, what should I be called?",
      placeholder: "Milady",
    });

    if (clack.isCancel(customName)) cancelOnboarding();

    name = customName.trim() || "Milady";
  } else {
    name = nameChoice;
  }

  clack.log.message(`♡♡${name}♡♡: Oh that's right, I'm ${name}!`);

  // ── Step 3: Catchphrase / writing style ────────────────────────────────
  const styleChoice = await clack.select({
    message: `${name}: Now... how do I like to talk again?`,
    options: STYLE_PRESETS.map((preset) => ({
      value: preset.catchphrase,
      label: preset.catchphrase,
      hint: preset.hint,
    })),
  });

  if (clack.isCancel(styleChoice)) cancelOnboarding();

  const chosenTemplate = STYLE_PRESETS.find(
    (p) => p.catchphrase === styleChoice,
  );

  // ── Step 3.5: Runtime selection (Cloud vs Local) ───────────────────────
  // Present the user with a choice of where to run their agent. Cloud mode
  // skips the local AI provider, wallet, and GitHub steps.
  let cloudOnboardingResult:
    | import("./cloud-onboarding").CloudOnboardingResult
    | null = null;
  let isCloudMode = false;

  const runtimeChoice = await clack.select({
    message: `${name}: Where should I live?`,
    options: [
      {
        value: "cloud",
        label: "☁️  Eliza Cloud (recommended)",
        hint: "zero setup — hosted, always online",
      },
      {
        value: "local",
        label: "💻  Run locally",
        hint: "full control — runs on this machine",
      },
      {
        value: "later",
        label: "⏭️  Decide later",
        hint: "start local, switch to cloud anytime",
      },
    ],
  });

  if (clack.isCancel(runtimeChoice)) cancelOnboarding();

  if (runtimeChoice === "later") {
    // User deferred the decision — continue with local setup (steps 4–7).
    clack.log.info(
      "No problem! Starting with local setup. You can switch to cloud anytime with `milady cloud connect`.",
    );
  } else if (runtimeChoice === "cloud") {
    const { runCloudOnboarding } = await import("./cloud-onboarding");
    cloudOnboardingResult = await runCloudOnboarding(
      clack,
      name,
      chosenTemplate,
    );

    if (cloudOnboardingResult?.agentId) {
      isCloudMode = true;
      clack.log.success(`${name} is now running in the cloud! ☁️`);
    } else if (cloudOnboardingResult) {
      // Auth succeeded but no agent provisioned — save auth for later
      clack.log.info(
        "Cloud auth saved. You can provision later with `milady cloud connect`.",
      );
    } else {
      // Cloud flow cancelled / failed — fall back to local
      clack.log.info("No worries! Setting up locally instead.");
    }
  }

  // ── Steps 4–7: Local-only setup ─────────────────────────────────────────
  // These steps are skipped when the user chose Eliza Cloud, since the cloud
  // handles inference, wallets can be configured via the dashboard, and
  // GitHub access is not needed for the initial cloud agent.
  let providerEnvKey: string | undefined;
  let providerApiKey: string | undefined;

  // Snapshot whether wallet keys already exist BEFORE onboarding touches
  // process.env, so the persistence block later can guard against
  // overwriting pre-existing values.
  const hasEvmKey = Boolean(process.env.EVM_PRIVATE_KEY?.trim());
  const hasSolKey = Boolean(process.env.SOLANA_PRIVATE_KEY?.trim());

  if (!isCloudMode) {
    // ── Step 4: Model provider ───────────────────────────────────────────────
    // Skip provider selection in cloud mode — Eliza Cloud handles inference.
    // Check whether an API key is already set in the environment (from .env or
    // shell).  If none is found, ask the user to pick a provider and enter a key.
    const PROVIDER_OPTIONS = [
      {
        id: "anthropic",
        label: "Anthropic (Claude)",
        envKey: "ANTHROPIC_API_KEY",
        detectKeys: ["ANTHROPIC_API_KEY"],
        hint: "sk-ant-...",
      },
      {
        id: "openai",
        label: "OpenAI (GPT)",
        envKey: "OPENAI_API_KEY",
        detectKeys: ["OPENAI_API_KEY"],
        hint: "sk-...",
      },
      {
        id: "openrouter",
        label: "OpenRouter",
        envKey: "OPENROUTER_API_KEY",
        detectKeys: ["OPENROUTER_API_KEY"],
        hint: "sk-or-...",
      },
      {
        id: "vercel-ai-gateway",
        label: "Vercel AI Gateway",
        envKey: "AI_GATEWAY_API_KEY",
        detectKeys: ["AI_GATEWAY_API_KEY", "AIGATEWAY_API_KEY"],
        hint: "aigw_...",
      },
      {
        id: "gemini",
        label: "Google Gemini",
        envKey: "GOOGLE_GENERATIVE_AI_API_KEY",
        detectKeys: [
          "GOOGLE_GENERATIVE_AI_API_KEY",
          "GOOGLE_API_KEY",
          "GEMINI_API_KEY",
        ],
        hint: "AI...",
      },
      {
        id: "grok",
        label: "xAI (Grok)",
        envKey: "XAI_API_KEY",
        detectKeys: ["XAI_API_KEY"],
        hint: "xai-...",
      },
      {
        id: "groq",
        label: "Groq",
        envKey: "GROQ_API_KEY",
        detectKeys: ["GROQ_API_KEY"],
        hint: "gsk_...",
      },
      {
        id: "deepseek",
        label: "DeepSeek",
        envKey: "DEEPSEEK_API_KEY",
        detectKeys: ["DEEPSEEK_API_KEY"],
        hint: "sk-...",
      },
      {
        id: "mistral",
        label: "Mistral",
        envKey: "MISTRAL_API_KEY",
        detectKeys: ["MISTRAL_API_KEY"],
        hint: "",
      },
      {
        id: "together",
        label: "Together AI",
        envKey: "TOGETHER_API_KEY",
        detectKeys: ["TOGETHER_API_KEY"],
        hint: "",
      },
      {
        id: "ollama",
        label: "Ollama (local, free)",
        envKey: "OLLAMA_BASE_URL",
        detectKeys: ["OLLAMA_BASE_URL"],
        hint: "http://localhost:11434",
      },
    ] as const;

    // Detect if any provider key is already configured
    const detectedProvider = PROVIDER_OPTIONS.find((p) =>
      p.detectKeys.some((key) => process.env[key]?.trim()),
    );

    if (detectedProvider) {
      clack.log.success(
        `Found existing ${detectedProvider.label} key in environment (${detectedProvider.envKey})`,
      );
    } else {
      const providerChoice = await clack.select({
        message: `${name}: One more thing — which AI provider should I use?`,
        options: [
          ...PROVIDER_OPTIONS.map((p) => ({
            value: p.id,
            label: p.label,
            hint: p.id === "ollama" ? "no API key needed" : undefined,
          })),
          {
            value: "_skip_",
            label: "Skip for now",
            hint: "set an API key later via env or config",
          },
        ],
      });

      if (clack.isCancel(providerChoice)) cancelOnboarding();

      if (providerChoice !== "_skip_") {
        const chosen = PROVIDER_OPTIONS.find((p) => p.id === providerChoice);
        if (chosen) {
          providerEnvKey = chosen.envKey;

          if (chosen.id === "ollama") {
            // Ollama just needs a base URL, default to localhost
            const ollamaUrl = await clack.text({
              message: "Ollama base URL:",
              placeholder: "http://localhost:11434",
              defaultValue: "http://localhost:11434",
            });

            if (clack.isCancel(ollamaUrl)) cancelOnboarding();

            providerApiKey = ollamaUrl.trim() || "http://localhost:11434";
          } else {
            const apiKeyInput = await clack.password({
              message: `Paste your ${chosen.label} API key:`,
            });

            if (clack.isCancel(apiKeyInput)) cancelOnboarding();

            providerApiKey = apiKeyInput.trim();
          }
        }
      }
    }

    // ── Step 4b: Embedding model preset ────────────────────────────────────
    // (Simplified: always use the standard/reliable model preset. No user choice.)

    // ── Step 5: Wallet setup ───────────────────────────────────────────────
    // Offer to generate or import wallets for EVM and Solana. Keys are
    // stored in config.env and process.env, making them available to
    // plugins at runtime.
    const { generateWalletKeys, importWallet } = await import("../api/wallet");

    // hasEvmKey and hasSolKey are hoisted above the if (!isCloudMode) block
    // so they're also available in the persistence section.
    if (!hasEvmKey || !hasSolKey) {
      const walletAction = await clack.select({
        message: `${name}: Do you want me to set up crypto wallets? (for trading, NFTs, DeFi)`,
        options: [
          {
            value: "generate",
            label: "Generate new wallets",
            hint: "creates fresh EVM + Solana keypairs",
          },
          {
            value: "import",
            label: "Import existing wallets",
            hint: "paste your private keys",
          },
          {
            value: "skip",
            label: "Skip for now",
            hint: "wallets can be added later",
          },
        ],
      });

      if (clack.isCancel(walletAction)) cancelOnboarding();

      if (walletAction === "generate") {
        const keys = generateWalletKeys();

        if (!hasEvmKey) {
          process.env.EVM_PRIVATE_KEY = keys.evmPrivateKey;
          clack.log.success(`Generated EVM wallet: ${keys.evmAddress}`);
        }
        if (!hasSolKey) {
          process.env.SOLANA_PRIVATE_KEY = keys.solanaPrivateKey;
          clack.log.success(`Generated Solana wallet: ${keys.solanaAddress}`);
        }
      } else if (walletAction === "import") {
        // EVM import
        if (!hasEvmKey) {
          const evmKeyInput = await clack.password({
            message: "Paste your EVM private key (0x... hex, or skip):",
          });

          if (!clack.isCancel(evmKeyInput) && evmKeyInput.trim()) {
            const result = importWallet("evm", evmKeyInput.trim());
            if (result.success) {
              clack.log.success(`Imported EVM wallet: ${result.address}`);
            } else {
              clack.log.warn(`EVM import failed: ${result.error}`);
            }
          }
        }

        // Solana import
        if (!hasSolKey) {
          const solKeyInput = await clack.password({
            message: "Paste your Solana private key (base58, or skip):",
          });

          if (!clack.isCancel(solKeyInput) && solKeyInput.trim()) {
            const result = importWallet("solana", solKeyInput.trim());
            if (result.success) {
              clack.log.success(`Imported Solana wallet: ${result.address}`);
            } else {
              clack.log.warn(`Solana import failed: ${result.error}`);
            }
          }
        }
      }
      // "skip" — do nothing
    }

    // ── Step 6: Skills Registry (ClawHub default) ──────────────────────────
    const hasSkillsRegistry = Boolean(
      process.env.SKILLS_REGISTRY?.trim() ||
        process.env.CLAWHUB_REGISTRY?.trim(),
    );
    const hasSkillsmpKey = Boolean(process.env.SKILLSMP_API_KEY?.trim());
    if (!hasSkillsRegistry) {
      process.env.SKILLS_REGISTRY = "https://clawhub.ai";
    }

    // ── Step 7: GitHub access (for coding agents, issue management) ─────────
    const hasGithubToken = Boolean(process.env.GITHUB_TOKEN?.trim());
    const hasGithubOAuth = Boolean(process.env.GITHUB_OAUTH_CLIENT_ID?.trim());
    if (!hasGithubToken) {
      const options: Array<{ value: string; label: string; hint?: string }> = [
        {
          value: "skip",
          label: "Skip for now",
          hint: "you can add this later",
        },
        {
          value: "pat",
          label: "Paste a Personal Access Token",
          hint: "github.com/settings/tokens",
        },
      ];
      if (hasGithubOAuth) {
        options.push({
          value: "oauth",
          label: "Use OAuth (authorize in browser)",
          hint: "recommended",
        });
      }

      const githubChoice = await clack.select({
        message:
          "Configure GitHub access? (needed for coding agents, issue management, PRs)",
        options,
      });

      if (!clack.isCancel(githubChoice) && githubChoice === "pat") {
        const tokenInput = await clack.password({
          message: "Paste your GitHub token (or skip):",
        });
        if (!clack.isCancel(tokenInput) && tokenInput.trim()) {
          process.env.GITHUB_TOKEN = tokenInput.trim();
          clack.log.success("GitHub token configured.");
        }
      } else if (!clack.isCancel(githubChoice) && githubChoice === "oauth") {
        clack.log.info(
          "GitHub OAuth will activate when coding agents need access.",
        );
      }
    }
  } // end if (!isCloudMode)

  // ── Step 8: Persist agent + style + provider + embedding config ─────────
  // Save the agent name and chosen personality template into config so that
  // the same character data is used regardless of whether the user onboarded
  // via CLI or GUI.  This ensures full parity between onboarding surfaces.
  const existingList: AgentConfig[] = config.agents?.list ?? [];
  const mainEntry: AgentConfig = existingList[0] ?? {
    id: "main",
    default: true,
  };
  const agentConfigEntry: AgentConfig = { ...mainEntry, name };

  // Apply the chosen style template to the agent config entry so the
  // personality is persisted — not just the name.
  if (chosenTemplate) {
    agentConfigEntry.bio = chosenTemplate.bio;
    agentConfigEntry.system = chosenTemplate.system;
    agentConfigEntry.style = chosenTemplate.style;
    agentConfigEntry.adjectives = chosenTemplate.adjectives;
    agentConfigEntry.postExamples = chosenTemplate.postExamples;
    agentConfigEntry.messageExamples = chosenTemplate.messageExamples;
  }

  const updatedList: AgentConfig[] = [
    agentConfigEntry,
    ...existingList.slice(1),
  ];

  const updated: MiladyConfig = {
    ...config,
    agents: {
      ...config.agents,
      list: updatedList,
    },
  };

  // Persist the provider API key and wallet keys in config.env so they
  // survive restarts.  Initialise the env bucket once to avoid the
  // repeated `if (!updated.env)` pattern.
  if (!updated.env) updated.env = {};
  const envBucket = updated.env as Record<string, string>;

  // Only persist local-mode env vars when not in cloud mode (those vars
  // were never prompted for / set during cloud onboarding).
  if (!isCloudMode) {
    if (providerEnvKey && providerApiKey) {
      envBucket[providerEnvKey] = providerApiKey;
      // Also set immediately in process.env for the current run
      process.env[providerEnvKey] = providerApiKey;
    }
    if (process.env.EVM_PRIVATE_KEY && !hasEvmKey) {
      envBucket.EVM_PRIVATE_KEY = process.env.EVM_PRIVATE_KEY;
    }
    if (process.env.SOLANA_PRIVATE_KEY && !hasSolKey) {
      envBucket.SOLANA_PRIVATE_KEY = process.env.SOLANA_PRIVATE_KEY;
    }
    if (process.env.SKILLS_REGISTRY) {
      envBucket.SKILLS_REGISTRY = process.env.SKILLS_REGISTRY;
    }
    if (process.env.SKILLSMP_API_KEY) {
      envBucket.SKILLSMP_API_KEY = process.env.SKILLSMP_API_KEY;
    }
    if (process.env.GITHUB_TOKEN) {
      envBucket.GITHUB_TOKEN = process.env.GITHUB_TOKEN;
    }
    if (process.env.GITHUB_OAUTH_CLIENT_ID) {
      envBucket.GITHUB_OAUTH_CLIENT_ID = process.env.GITHUB_OAUTH_CLIENT_ID;
    }
  }

  // ── Cloud config persistence ───────────────────────────────────────────
  // If the user completed cloud onboarding, persist the cloud credentials
  // and agent ID so subsequent `milady start` connects directly.
  if (cloudOnboardingResult) {
    updated.cloud = {
      ...updated.cloud,
      enabled: isCloudMode,
      provider: "elizacloud",
      apiKey: cloudOnboardingResult.apiKey,
      baseUrl: cloudOnboardingResult.baseUrl,
      inferenceMode: isCloudMode ? "cloud" : updated.cloud?.inferenceMode,
      runtime: isCloudMode ? "cloud" : "local",
    };
    if (cloudOnboardingResult.agentId) {
      updated.cloud.agentId = cloudOnboardingResult.agentId;
    }
  }

  try {
    saveMiladyConfig(updated);
  } catch (err) {
    // Non-fatal: the agent can still start, but choices won't persist.
    clack.log.warn(`Could not save config: ${formatError(err)}`);
  }
  clack.log.message(`${name}: ${styleChoice} Alright, that's me.`);
  clack.outro(
    isCloudMode ? "Your agent is live in the cloud! ☁️" : "Let's get started!",
  );

  return updated;
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/** Options accepted by {@link startEliza}. */
export interface StartElizaOptions {
  /**
   * When true, skip the interactive CLI chat loop and return the
   * initialised {@link AgentRuntime} so it can be wired into the API
   * server (used by `dev-server.ts`).
   */
  headless?: boolean;
  /**
   * When true, start the API server and keep running without entering
   * the interactive chat loop. Used by `bun run start` for production
   * server mode (like dev but without watch).
   */
  serverOnly?: boolean;
  /**
   * Internal guard to prevent infinite retry loops when recovering from
   * corrupt PGLite state.
   */
  pgliteRecoveryAttempted?: boolean;
}

export interface BootElizaRuntimeOptions {
  /**
   * When true, require an existing ~/.milady/milady.json config file.
   * This is used by non-CLI UIs (like the @elizaos/tui interface) where interactive
   * onboarding prompts would break the alternate screen.
   */
  requireConfig?: boolean;
}

/**
 * Boot the elizaOS runtime without starting the readline chat loop.
 *
 * This is a convenience wrapper around {@link startEliza} in headless mode,
 * with optional config guards.
 */
export async function bootElizaRuntime(
  opts: BootElizaRuntimeOptions = {},
): Promise<AgentRuntime> {
  if (opts.requireConfig && !configFileExists()) {
    throw new Error(
      "No config found. Run `milady start` once to complete setup.",
    );
  }

  const runtime = await startEliza({ headless: true });
  if (!runtime) {
    throw new Error("Failed to boot runtime");
  }
  return runtime;
}

const LEVEL_TO_NAME: Record<number, string> = {
  10: "trace",
  20: "debug",
  27: "success",
  28: "progress",
  29: "log",
  30: "info",
  40: "warn",
  50: "error",
  60: "fatal",
};

export const logToChatListener = (entry: LogEntry) => {
  if (entry.roomId && entry.runtime) {
    const runtime = entry.runtime as unknown as AgentRuntime & {
      logLevelOverrides?: Map<string, string>;
    };
    // access dynamic property
    const overrides = runtime.logLevelOverrides;
    const overrideLevel = overrides?.get(String(entry.roomId));

    if (overrideLevel) {
      const levelKey = entry.level as number;
      const levelName = (
        levelKey && LEVEL_TO_NAME[levelKey] ? LEVEL_TO_NAME[levelKey] : "log"
      ).toUpperCase();

      const prefix = `[${levelName}]`;
      const content = `${prefix} ${entry.msg}`;

      // Prevent infinite loops by suppressing logs from this action
      runtime
        .sendMessageToTarget(
          { roomId: entry.roomId } as unknown as TargetInfo,
          {
            text: `\`\`\`\n${content}\n\`\`\``,
            source: "system",

            isLog: "true",
          },
        )
        .catch(() => {});
    }
  }
};

/**
 * Start the elizaOS runtime with Milady's configuration.
 *
 * In headless mode the runtime is returned instead of entering the
 * interactive readline loop.
 */
export async function startEliza(
  opts?: StartElizaOptions,
): Promise<AgentRuntime | undefined> {
  // Start buffering logs early so startup messages appear in the UI log viewer
  const { captureEarlyLogs } = await import("../api/early-logs");
  captureEarlyLogs();

  // Register log listener for chat mirroring
  addLogListener(logToChatListener);

  // 1. Load Milady config from ~/.milady/milady.json
  let config: MiladyConfig;
  try {
    config = loadMiladyConfig();
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      logger.warn("[milady] No config found, using defaults");
      // All MiladyConfig fields are optional, so an empty object is
      // structurally valid. The `as` cast is safe here.
      config = {} as MiladyConfig;
    } else {
      throw err;
    }
  }

  // 1b. First-run onboarding — ask for agent name if not configured.
  //     In headless mode (GUI) the onboarding is handled by the web UI,
  //     so we skip the interactive CLI prompt and let the runtime start
  //     with defaults.  The GUI will restart the agent after onboarding.
  if (!opts?.headless) {
    config = await runFirstTimeSetup(config);
  }

  // 1c. Apply logging level from config to process.env so the global
  //     @elizaos/core logger (used by plugins) respects it.
  //     config.logging.level is guaranteed to be set (defaults to "error").
  //     Users can still opt into noisy logs via config.logging.level or
  //     an explicit LOG_LEVEL environment variable.
  if (!process.env.LOG_LEVEL) {
    process.env.LOG_LEVEL = config.logging?.level ?? "error";
  }

  // 2. Push channel secrets into process.env for plugin discovery
  applyConnectorSecretsToEnv(config);
  await autoResolveDiscordAppId();

  // 2b. Propagate cloud config into process.env for ElizaCloud plugin
  applyCloudConfigToEnv(config);

  // 2c. Propagate x402 config into process.env
  applyX402ConfigToEnv(config);

  // 2d. Propagate database config into process.env for plugin-sql
  applyDatabaseConfigToEnv(config);

  // 2e. Propagate arbitrary env vars from config.env into process.env.
  // Milady stores user-defined env vars (plugin settings, API URLs, etc.)
  // in config.env; elizaOS plugins read them via process.env / getSetting.
  if (
    config.env &&
    typeof config.env === "object" &&
    !Array.isArray(config.env)
  ) {
    for (const [key, value] of Object.entries(config.env)) {
      if (typeof value === "string" && !process.env[key]) {
        process.env[key] = value;
      }
    }
  }

  // Log active database configuration for debugging persistence issues
  {
    const dbProvider = config.database?.provider ?? "pglite";
    const pgliteDir = process.env.PGLITE_DATA_DIR;
    const postgresUrl = process.env.POSTGRES_URL;
    logger.info(
      `[milady] Database provider: ${dbProvider}` +
        (dbProvider === "pglite" && pgliteDir
          ? ` | data dir: ${pgliteDir}`
          : "") +
        (dbProvider === "postgres" && postgresUrl
          ? ` | connection: ${postgresUrl.replace(/:\/\/([^:]+):([^@]+)@/, "://$1:***@")}`
          : ""),
    );
  }

  // 2d-iii. OG tracking code initialization
  try {
    const { initializeOGCode } = await import("../api/og-tracker");
    initializeOGCode();
  } catch {
    // Silent — OG tracking is non-critical
  }

  // 2d-ii. Allow destructive migrations (e.g. dropping tables removed between
  //        plugin versions) so the runtime doesn't silently stall.  Without this
  //        the migration system throws an error that gets swallowed, leaving the
  //        app hanging indefinitely with no output.
  if (!process.env.ELIZA_ALLOW_DESTRUCTIVE_MIGRATIONS) {
    process.env.ELIZA_ALLOW_DESTRUCTIVE_MIGRATIONS = "true";
  }

  // 2e. Prevent @elizaos/core from auto-loading @elizaos/plugin-bootstrap.
  //     Milady uses @elizaos/plugin-trust which provides the settings/roles
  //     providers and actions.  plugin-bootstrap (v1.x) is incompatible with
  //     the 2.0.0-alpha.x runtime used here.
  if (!process.env.IGNORE_BOOTSTRAP) {
    process.env.IGNORE_BOOTSTRAP = "true";
  }

  // 2e-ii. Ensure SECRET_SALT is set to suppress the @elizaos/core default
  //        warning and avoid using a predictable value in production.
  if (!process.env.SECRET_SALT) {
    process.env.SECRET_SALT = crypto.randomBytes(32).toString("hex");
    logger.info("[milady] Generated random SECRET_SALT for this session");
  }

  // 2e-iii. Pre-flight validation for Google AI API keys.  If the key looks
  //         obviously invalid (too short, placeholder, wrong prefix), clear it
  //         to prevent plugin-google-genai from making a failing API call.
  for (const gkey of [
    "GEMINI_API_KEY",
    "GOOGLE_API_KEY",
    "GOOGLE_GENERATIVE_AI_API_KEY",
  ] as const) {
    const val = process.env[gkey]?.trim();
    if (
      val &&
      (val.length < 20 || val === "your-key-here" || val.startsWith("sk-"))
    ) {
      logger.warn(
        `[milady] ${gkey} appears invalid (length/format), clearing to skip Google AI plugin`,
      );
      delete process.env[gkey];
    }
  }

  // 2f. Apply subscription-based credentials (Claude Max, Codex Max)
  try {
    const { applySubscriptionCredentials } = await import("../auth/index");
    await applySubscriptionCredentials(config);
  } catch (err) {
    logger.warn(`[milady] Failed to apply subscription credentials: ${err}`);
  }

  // 2g. Cloud mode — if the user chose cloud during onboarding (or on a
  //     subsequent start with cloud config), skip local runtime setup and
  //     connect via the thin client instead.
  if (
    config.cloud?.enabled &&
    config.cloud?.apiKey &&
    config.cloud?.agentId &&
    config.cloud?.runtime === "cloud"
  ) {
    return startInCloudMode(config, config.cloud.agentId, opts);
  }

  // 3. Build elizaOS Character from Milady config
  const character = buildCharacterFromConfig(config);

  const primaryModel = resolvePrimaryModel(config);

  // 4. Ensure workspace exists with bootstrap files
  const workspaceDir =
    config.agents?.defaults?.workspace ?? resolveDefaultAgentWorkspaceDir();
  await ensureAgentWorkspace({ dir: workspaceDir, ensureBootstrapFiles: true });

  // 4b. Ensure custom plugins directory exists for drop-in plugins
  await fs.mkdir(path.join(resolveStateDir(), CUSTOM_PLUGINS_DIRNAME), {
    recursive: true,
  });

  // 5. Create the Milady bridge plugin (workspace context + session keys + compaction)
  const agentId = character.name?.toLowerCase().replace(/\s+/g, "-") ?? "main";
  const miladyPlugin = createMiladyPlugin({
    workspaceDir,
    bootstrapMaxChars: config.agents?.defaults?.bootstrapMaxChars,

    agentId,
  });

  // 6. Resolve and load plugins
  // In headless (GUI) mode before onboarding, the user hasn't configured a
  // provider yet.  Downgrade diagnostics so the expected "no AI provider"
  // state doesn't appear as a scary Error in the terminal.
  const preOnboarding = opts?.headless && !config.agents;
  const resolvedPlugins = await resolvePlugins(config, {
    quiet: preOnboarding,
  });

  if (resolvedPlugins.length === 0) {
    if (preOnboarding) {
      logger.info(
        "[milady] No plugins loaded yet — the onboarding wizard will configure a model provider",
      );
    } else {
      logger.error(
        "[milady] No plugins loaded — at least one model provider plugin is required",
      );
      logger.error(
        "[milady] Set an API key (e.g. ANTHROPIC_API_KEY, OPENAI_API_KEY) in your environment",
      );
      throw new Error("No plugins loaded");
    }
  }

  // 6b. Debug logging — print full context after provider + plugin resolution
  {
    const pluginNames = resolvedPlugins.map((p) => p.name);
    const providerNames = resolvedPlugins
      .flatMap((p) => p.plugin.providers ?? [])
      .map((prov: Provider) => prov.name);
    // Build a context summary for validation
    const contextSummary: Record<string, unknown> = {
      agentName: character.name,
      pluginCount: resolvedPlugins.length,
      providerCount: providerNames.length,
      primaryModel: primaryModel ?? "(auto-detect)",
      workspaceDir,
    };
    debugLogResolvedContext(pluginNames, providerNames, contextSummary, (msg) =>
      logger.debug(msg),
    );

    // Validate the context and surface issues early
    const contextValidation = validateRuntimeContext(contextSummary);
    if (!contextValidation.valid) {
      const issues: string[] = [];
      if (contextValidation.nullFields.length > 0) {
        issues.push(`null: ${contextValidation.nullFields.join(", ")}`);
      }
      if (contextValidation.undefinedFields.length > 0) {
        issues.push(
          `undefined: ${contextValidation.undefinedFields.join(", ")}`,
        );
      }
      if (contextValidation.emptyFields.length > 0) {
        issues.push(`empty: ${contextValidation.emptyFields.join(", ")}`);
      }
      logger.warn(
        `[milady] Context validation issues detected: ${issues.join("; ")}`,
      );
    }
  }

  // 7. Create the AgentRuntime with Milady plugin + resolved plugins
  //    All CORE_PLUGINS are pre-registered sequentially (in CORE_PLUGINS
  //    order) before runtime.initialize() so that cross-plugin getService()
  //    calls always resolve.  runtime.initialize() registers remaining
  //    characterPlugins (connectors, providers, custom) in parallel — those
  //    are NOT core and don't have ordering dependencies.
  const PREREGISTER_PLUGINS = new Set(CORE_PLUGINS);
  const sqlPlugin = resolvedPlugins.find(
    (p) => p.name === "@elizaos/plugin-sql",
  );
  const localEmbeddingPlugin = resolvedPlugins.find(
    (p) => p.name === "@elizaos/plugin-local-embedding",
  );
  const otherPlugins = resolvedPlugins.filter(
    (p) => !PREREGISTER_PLUGINS.has(p.name),
  );

  // Resolve the runtime log level from config (AgentRuntime doesn't support
  // "silent", so we map it to "fatal" as the quietest supported level).
  const runtimeLogLevel = (() => {
    // process.env.LOG_LEVEL is already resolved (set explicitly or from
    // config.logging.level above), so prefer it to honour the dev-mode
    // LOG_LEVEL=error override set by scripts/dev-ui.mjs.
    const lvl = process.env.LOG_LEVEL ?? config.logging?.level ?? "error";
    if (lvl === "silent") return "fatal" as const;
    return lvl as "trace" | "debug" | "info" | "warn" | "error" | "fatal";
  })();

  // 7a. Resolve bundled skills directory from @elizaos/skills so
  //     plugin-agent-skills auto-loads them on startup.
  let bundledSkillsDir: string | null = null;
  try {
    const { getSkillsDir } = (await import("@elizaos/skills")) as {
      getSkillsDir: () => string;
    };
    bundledSkillsDir = getSkillsDir();
    logger.info(`[milady] Bundled skills dir: ${bundledSkillsDir}`);
  } catch {
    logger.debug(
      "[milady] @elizaos/skills not available — bundled skills will not be loaded",
    );
  }

  // Workspace skills directory (highest precedence for overrides)
  const workspaceSkillsDir = workspaceDir ? `${workspaceDir}/skills` : null;
  const managedSkillsDir = path.join(resolveStateDir(), "skills");

  // ── Sandbox mode setup ──────────────────────────────────────────────────
  const sandboxConfig = config.agents?.defaults?.sandbox;
  const sandboxModeStr = (sandboxConfig as Record<string, unknown> | undefined)
    ?.mode as string | undefined;
  const sandboxMode: SandboxMode =
    sandboxModeStr === "light" ||
    sandboxModeStr === "standard" ||
    sandboxModeStr === "max"
      ? sandboxModeStr
      : "off";
  const isSandboxActive = sandboxMode !== "off";

  let sandboxManager: SandboxManager | null = null;
  let sandboxAuditLog: SandboxAuditLog | null = null;

  if (isSandboxActive) {
    logger.info(`[milady] Sandbox mode: ${sandboxMode}`);
    sandboxAuditLog = new SandboxAuditLog({ console: true });

    // Standard/max modes also start the container sandbox manager
    if (sandboxMode === "standard" || sandboxMode === "max") {
      const dockerSettings = (
        sandboxConfig as Record<string, unknown> | undefined
      )?.docker as Record<string, unknown> | undefined;
      const browserSettings = (
        sandboxConfig as Record<string, unknown> | undefined
      )?.browser as Record<string, unknown> | undefined;

      sandboxManager = new SandboxManager({
        mode: sandboxMode,
        image: (dockerSettings?.image as string) ?? undefined,
        containerPrefix:
          (dockerSettings?.containerPrefix as string) ?? undefined,
        network: (dockerSettings?.network as string) ?? undefined,
        memory: (dockerSettings?.memory as string) ?? undefined,
        cpus: (dockerSettings?.cpus as number) ?? undefined,
        workspaceRoot: workspaceDir ?? undefined,
        browser: browserSettings
          ? {
              enabled: (browserSettings.enabled as boolean) ?? false,
              image: (browserSettings.image as string) ?? undefined,
              cdpPort: (browserSettings.cdpPort as number) ?? undefined,
              vncPort: (browserSettings.vncPort as number) ?? undefined,
              noVncPort: (browserSettings.noVncPort as number) ?? undefined,
              headless: (browserSettings.headless as boolean) ?? undefined,
              enableNoVnc:
                (browserSettings.enableNoVnc as boolean) ?? undefined,
              autoStart: (browserSettings.autoStart as boolean) ?? true,
              autoStartTimeoutMs:
                (browserSettings.autoStartTimeoutMs as number) ?? undefined,
            }
          : undefined,
      });

      try {
        await sandboxManager.start();
        logger.info("[milady] Sandbox manager started");
      } catch (err) {
        logger.error(
          `[milady] Sandbox manager failed to start: ${err instanceof Error ? err.message : String(err)}`,
        );
        // Non-fatal: light mode fallback
      }
    }

    sandboxAuditLog.record({
      type: "sandbox_lifecycle",
      summary: `Sandbox initialized: mode=${sandboxMode}`,
      severity: "info",
    });
  }
  // ── End sandbox setup ───────────────────────────────────────────────────

  // ── Boost preferred model plugin priority ─────────────────────────────
  // elizaOS selects the model handler with the highest `priority` for each
  // ModelType.  All provider plugins default to priority 0, so whichever
  // registers first wins — essentially random when using Promise.all.
  // When the user has explicitly chosen a primary model provider (via
  // `model.primary` in config), we bump that plugin's priority so its
  // handlers are always selected over other providers.
  const pluginsForRuntime = otherPlugins.map((p) => p.plugin);
  const visionModeSetting = resolveVisionModeSetting(config);
  if (primaryModel) {
    for (const plugin of pluginsForRuntime) {
      if (plugin.name === primaryModel) {
        plugin.priority = (plugin.priority ?? 0) + 10;
        logger.info(
          `[milady] Boosted plugin "${plugin.name}" priority to ${plugin.priority} (model.primary)`,
        );
        break;
      }
    }
  }

  // Deduplicate actions across all plugins to avoid "Action already registered"
  // warnings from elizaOS core. First plugin wins (miladyPlugin is first).
  deduplicatePluginActions([miladyPlugin, ...pluginsForRuntime]);

  let runtime = new AgentRuntime({
    character,
    // advancedCapabilities: true,
    actionPlanning: true,
    // advancedMemory: true, // Not supported in this version of AgentRuntime
    plugins: [miladyPlugin, ...pluginsForRuntime],
    ...(runtimeLogLevel ? { logLevel: runtimeLogLevel } : {}),
    // Sandbox options — only active when mode != "off"
    ...(isSandboxActive
      ? {
          sandboxMode: true,
          sandboxAuditHandler: sandboxAuditLog
            ? (event: SandboxFetchAuditEvent) => {
                sandboxAuditLog.recordTokenReplacement(
                  event.direction,
                  event.url,
                  event.tokenIds,
                );
              }
            : undefined,
        }
      : {}),
    settings: {
      VALIDATION_LEVEL: "fast",
      // Forward non-sensitive Milady config.env vars as runtime settings so
      // plugins can access them via runtime.getSetting(). This fixes a bug where
      // plugins (e.g. @elizaos/plugin-google-genai) call runtime.getSetting()
      // which returns null for keys not in settings, but the plugin checks
      // !== undefined causing it to use "null" as the model name.
      //
      // Security: Filter out blockchain private keys and secrets. API keys are
      // allowed since plugins need them via runtime.getSetting(). Private keys
      // should only be accessed via process.env by signing services.
      ...Object.fromEntries(
        Object.entries(collectConfigEnvVars(config)).filter(([key]) =>
          isEnvKeyAllowedForForwarding(key),
        ),
      ),
      // Forward Milady config env vars as runtime settings
      ...(primaryModel ? { MODEL_PROVIDER: primaryModel } : {}),
      ...(visionModeSetting ? { VISION_MODE: visionModeSetting } : {}),
      // Forward skills config so plugin-agent-skills can apply allow/deny filtering
      ...(config.skills?.allowBundled
        ? { SKILLS_ALLOWLIST: config.skills.allowBundled.join(",") }
        : {}),
      ...(config.skills?.denyBundled
        ? { SKILLS_DENYLIST: config.skills.denyBundled.join(",") }
        : {}),
      // Managed skills are stored in the Milady state dir (~/.milady/skills).
      SKILLS_DIR: managedSkillsDir,
      // Tell plugin-agent-skills where to find bundled + workspace skills
      ...(bundledSkillsDir ? { BUNDLED_SKILLS_DIRS: bundledSkillsDir } : {}),
      ...(workspaceSkillsDir
        ? { WORKSPACE_SKILLS_DIR: workspaceSkillsDir }
        : {}),
      // Also forward extra dirs from config
      ...(config.skills?.load?.extraDirs?.length
        ? { EXTRA_SKILLS_DIRS: config.skills.load.extraDirs.join(",") }
        : {}),
      // Disable image description when vision is explicitly toggled off.
      // The cloud plugin always registers IMAGE_DESCRIPTION, so we need a
      // runtime setting to prevent the message service from calling it.
      ...(config.features?.vision === false
        ? { DISABLE_IMAGE_DESCRIPTION: "true" }
        : {}),
    },
  });
  installRuntimeMethodBindings(runtime);

  // 7b. Pre-register plugin-sql so the adapter is ready before other plugins init.
  //     This is OPTIONAL — without it, some features (memory, todos) won't work.
  //     runtime.db is a getter that returns this.adapter.db and throws when
  //     this.adapter is undefined, so plugins that use runtime.db will fail.
  if (sqlPlugin) {
    // 7c. Eagerly initialize the database adapter so it's fully ready
    //     BEFORE other plugins run their init(). When legacy/corrupt PGLite
    //     state causes startup aborts, reset the local DB dir and retry once.
    await registerSqlPluginWithRecovery(runtime, sqlPlugin, config);
  } else {
    const loadedNames = resolvedPlugins.map((p) => p.name).join(", ");
    logger.error(
      `[milady] @elizaos/plugin-sql was NOT found among resolved plugins. ` +
        `Loaded: [${loadedNames}]`,
    );
    throw new Error(
      "@elizaos/plugin-sql is required but was not loaded. " +
        "Ensure the package is installed and built (check for import errors above).",
    );
  }

  // 7d. Pre-register plugin-local-embedding so its TEXT_EMBEDDING handler
  //     (priority 10) is available before runtime.initialize() starts all
  //     plugins in parallel.  Without this, the bootstrap plugin's services
  //     (ActionFilterService, EmbeddingGenerationService) race ahead and use
  //     the cloud plugin's TEXT_EMBEDDING handler — which hits a paid API —
  //     because local-embedding's heavier init hasn't completed yet.
  if (localEmbeddingPlugin) {
    configureLocalEmbeddingPlugin(localEmbeddingPlugin.plugin, config);
    await runtime.registerPlugin(localEmbeddingPlugin.plugin);
    logger.info(
      "[milady] plugin-local-embedding pre-registered (TEXT_EMBEDDING ready)",
    );
  } else {
    logger.warn(
      "[milady] @elizaos/plugin-local-embedding not found — embeddings " +
        "will fall back to whatever TEXT_EMBEDDING handler is registered by " +
        "other plugins (may incur cloud API costs)",
    );
  }

  // 7e. Pre-register remaining core plugins sequentially in CORE_PLUGINS order.
  //     Each registerPlugin() call runs the plugin's init() before proceeding
  //     to the next, guaranteeing that cross-plugin getService() calls resolve.
  {
    const alreadyPreRegistered = new Set([
      "@elizaos/plugin-sql",
      "@elizaos/plugin-local-embedding",
    ]);
    for (const name of CORE_PLUGINS) {
      if (alreadyPreRegistered.has(name)) continue;
      const resolved = resolvedPlugins.find((p) => p.name === name);
      if (!resolved) {
        logger.debug(
          `[milady] Core plugin ${name} not resolved — skipping pre-registration`,
        );
        continue;
      }
      try {
        await runtime.registerPlugin(resolved.plugin);
      } catch (err) {
        logger.warn(
          `[milady] Core plugin ${name} pre-registration failed: ${formatError(err)}`,
        );
      }
    }
  }

  const warmAgentSkillsService = async (): Promise<void> => {
    // Let runtime startup complete first; this warm-up runs asynchronously
    // so API + agent come online immediately.
    try {
      const skillServicePromise = runtime.getServiceLoadPromise(
        "AGENT_SKILLS_SERVICE",
      );
      const timeout = new Promise<never>((_resolve, reject) => {
        setTimeout(() => {
          reject(
            new Error(
              "AgentSkillsService warm-up timed out (10s) — non-blocking, agent will function without skills",
            ),
          );
        }, 10_000);
      });
      await Promise.race([skillServicePromise, timeout]);

      const svc = runtime.getService("AGENT_SKILLS_SERVICE") as
        | {
            getCatalogStats?: () => {
              loaded: number;
              total: number;
              storageType: string;
            };
          }
        | null
        | undefined;
      if (svc?.getCatalogStats) {
        const stats = svc.getCatalogStats();
        logger.info(
          `[milady] AgentSkills ready — ${stats.loaded} skills loaded, ` +
            `${stats.total} in catalog (storage: ${stats.storageType})`,
        );
      }

      // Guard against non-string skill.description values.
      // The bundled YAML parser produces {} for multi-line descriptions, which
      // crashes findBestLocalMatch / scoreSkillMatch (call .toLowerCase() on it).
      // Instead of a one-shot sanitize (which misses skills loaded later by
      // syncCatalog / autoRefresh), we monkey-patch getLoadedSkills to always
      // return sanitized values.
      const svcAny = svc as Record<string, unknown> | null | undefined;
      const origGetLoaded = svcAny?.getLoadedSkills as
        | ((...args: unknown[]) => Array<Record<string, unknown>>)
        | undefined;
      if (origGetLoaded && svcAny) {
        (svcAny as Record<string, unknown>).getLoadedSkills = function (
          ...args: unknown[]
        ) {
          const skills = origGetLoaded.apply(this, args);
          for (const skill of skills) {
            if (typeof skill.description !== "string") {
              skill.description =
                skill.description == null
                  ? ""
                  : JSON.stringify(skill.description);
            }
          }
          return skills;
        };
        logger.debug("[milady] Patched getLoadedSkills to guard descriptions");
      }
    } catch (err) {
      // Non-fatal — the agent can operate without skills. This warm-up runs
      // async so it doesn't block startup.
      logger.debug(`[milady] AgentSkillsService warm-up: ${formatError(err)}`);
    }
  };

  const initializeRuntimeServices = async (): Promise<void> => {
    // 8. Initialize the runtime (registers remaining plugins, starts services)
    await runtime.initialize();
    await waitForTrajectoryLoggerService(runtime, "runtime.initialize()");
    ensureTrajectoryLoggerEnabled(runtime, "runtime.initialize()");
    installDatabaseTrajectoryLogger(runtime);
    patchTrajectoryLoggerAliasCompatibility(runtime);

    // 8b. Ensure AutonomyService is available for trigger dispatch.
    // IGNORE_BOOTSTRAP=true prevents the bootstrap plugin (which normally
    // registers this service) from loading, so we start it explicitly.
    if (!runtime.getService("AUTONOMY")) {
      try {
        await AutonomyService.start(runtime);
        logger.info("[milady] AutonomyService started for trigger dispatch");
      } catch (err) {
        logger.warn(
          `[milady] AutonomyService failed to start: ${formatError(err)}`,
        );
      }
    }

    // Do not block runtime startup on skills warm-up.
    void warmAgentSkillsService();
  };

  try {
    await initializeRuntimeServices();
  } catch (err) {
    const pgliteDataDir = resolveActivePgliteDataDir(config);
    const recoveryAction =
      !opts?.pgliteRecoveryAttempted && pgliteDataDir
        ? getPgliteRecoveryAction(err, pgliteDataDir)
        : "none";

    if (!pgliteDataDir || recoveryAction === "none") {
      throw err;
    }
    if (recoveryAction === "fail-active-lock") {
      throw createActivePgliteLockError(pgliteDataDir, err);
    }

    logger.warn(
      recoveryAction === "retry-without-reset"
        ? `[milady] Runtime migrations failed (${formatError(err)}). Cleared a stale PGLite lock in ${pgliteDataDir} and retrying startup once without resetting data.`
        : `[milady] Runtime migrations failed (${formatError(err)}). Resetting local PGLite DB at ${pgliteDataDir} and retrying startup once.`,
    );
    try {
      await shutdownRuntime(runtime, "PGLite recovery");
    } catch {
      // Ignore cleanup errors — retry creates a fresh runtime anyway.
    }

    if (recoveryAction === "reset-data-dir") {
      await resetPgliteDataDir(pgliteDataDir);
      process.env.PGLITE_DATA_DIR = pgliteDataDir;
    }

    return await startEliza({
      ...opts,
      pgliteRecoveryAttempted: true,
    });
  }

  installActionAliases(runtime);

  // 9. Graceful shutdown handler
  //
  // In headless mode the caller (dev-server / desktop shell) owns the process
  // lifecycle, so we must NOT register signal handlers here — they would
  // stack on every hot-restart, close over stale runtime references, and
  // race with bun --watch's own process teardown.
  if (!opts?.headless) {
    let isShuttingDown = false;

    const shutdown = async (): Promise<void> => {
      if (isShuttingDown) return;
      isShuttingDown = true;

      try {
        // Stop sandbox manager before runtime
        if (sandboxManager) {
          try {
            await sandboxManager.stop();
            logger.info("[milady] Sandbox manager stopped");
          } catch (err) {
            logger.warn(
              `[milady] Sandbox stop error: ${err instanceof Error ? err.message : String(err)}`,
            );
          }
        }
      } catch (err) {
        logger.warn(`[milady] Sandbox shutdown error: ${formatError(err)}`);
      }

      try {
        await shutdownRuntime(runtime, "signal shutdown");
      } catch (err) {
        logger.warn(`[milady] Error during shutdown: ${formatError(err)}`);
      }
      process.exit(0);
    };

    process.on("SIGINT", () => void shutdown());
    process.on("SIGTERM", () => void shutdown());
  }

  const loadHooksSystem = async (): Promise<void> => {
    try {
      const internalHooksConfig = config.hooks
        ?.internal as LoadHooksOptions["internalConfig"];

      await loadHooks({
        workspacePath: workspaceDir,
        internalConfig: internalHooksConfig,
        miladyConfig: config as Record<string, unknown>,
      });

      const startupEvent = createHookEvent("gateway", "startup", "system", {
        cfg: config,
      });
      await triggerHook(startupEvent);
    } catch (err) {
      logger.warn(`[milady] Hooks system could not load: ${formatError(err)}`);
    }
  };

  // ── Headless mode — return runtime for API server wiring ──────────────
  if (opts?.headless) {
    void loadHooksSystem();
    logger.info(
      "[milady] Runtime initialised in headless mode (autonomy enabled)",
    );
    return runtime;
  }

  // 10. Load hooks system
  await loadHooksSystem();

  // ── Start API server for GUI access ──────────────────────────────────────
  // In CLI mode (non-headless), start the API server in the background so
  // the GUI can connect to the running agent.  This ensures full feature
  // parity: whether started via `npx miladyai`, `bun run dev`, or the
  // desktop app, the API server is always available for the GUI admin
  // surface.
  try {
    const { startApiServer } = await import("../api/server");
    const apiPort = Number(process.env.MILADY_PORT) || 2138;
    const { port: actualApiPort } = await startApiServer({
      port: apiPort,
      runtime,
      onRestart: async () => {
        logger.info("[milady] Hot-reload: Restarting runtime...");
        try {
          // Stop the old runtime to release resources (DB connections, timers, etc.)

          try {
            await shutdownRuntime(runtime, "hot-reload cleanup");
          } catch (stopErr) {
            logger.warn(
              `[milady] Hot-reload: old runtime stop failed: ${formatError(stopErr)}`,
            );
          }

          // Reload config from disk (updated by API)
          const freshConfig = loadMiladyConfig();

          // Propagate secrets & cloud config into process.env so plugins
          // (especially plugin-elizacloud) can discover them.  The initial
          // startup does this in startEliza(); the hot-reload must repeat it
          // because the config may have changed (e.g. cloud enabled during
          // onboarding).
          applyConnectorSecretsToEnv(freshConfig);
          await autoResolveDiscordAppId();
          applyCloudConfigToEnv(freshConfig);
          applyX402ConfigToEnv(freshConfig);
          applyDatabaseConfigToEnv(freshConfig);

          // Apply subscription-based credentials (Claude Max, Codex Max)
          // that may have been set up during onboarding.
          try {
            const { applySubscriptionCredentials } = await import(
              "../auth/index"
            );
            await applySubscriptionCredentials(freshConfig);
          } catch (subErr) {
            logger.warn(
              `[milady] Hot-reload: subscription credentials: ${formatError(subErr)}`,
            );
          }

          // Resolve plugins using same function as startup
          const resolvedPlugins = await resolvePlugins(freshConfig);

          // Rebuild character from the fresh config so onboarding changes
          // (name, bio, style, etc.) are picked up on restart.
          const freshCharacter = buildCharacterFromConfig(freshConfig);

          // Recreate Milady plugin with fresh workspace
          const freshMiladyPlugin = createMiladyPlugin({
            workspaceDir:
              freshConfig.agents?.defaults?.workspace ?? workspaceDir,
            bootstrapMaxChars: freshConfig.agents?.defaults?.bootstrapMaxChars,

            agentId:
              freshCharacter.name?.toLowerCase().replace(/\s+/g, "-") ?? "main",
          });

          // Create new runtime with updated plugins.
          // Filter out pre-registered plugins so they aren't double-loaded
          // inside initialize()'s Promise.all — same pattern as the initial
          // startup to avoid the TEXT_EMBEDDING race condition.
          const freshPrimaryModel = resolvePrimaryModel(freshConfig);
          const freshOtherPlugins = resolvedPlugins.filter(
            (p) => !PREREGISTER_PLUGINS.has(p.name),
          );
          // Boost preferred model plugin priority (same as initial startup)
          const freshPluginsForRuntime = freshOtherPlugins.map((p) => p.plugin);
          const freshVisionModeSetting = resolveVisionModeSetting(freshConfig);
          if (freshPrimaryModel) {
            for (const plugin of freshPluginsForRuntime) {
              if (plugin.name === freshPrimaryModel) {
                plugin.priority = (plugin.priority ?? 0) + 10;
                break;
              }
            }
          }
          const newRuntime = new AgentRuntime({
            character: freshCharacter,
            plugins: [freshMiladyPlugin, ...freshPluginsForRuntime],
            ...(runtimeLogLevel ? { logLevel: runtimeLogLevel } : {}),
            settings: {
              ...(freshPrimaryModel
                ? { MODEL_PROVIDER: freshPrimaryModel }
                : {}),
              ...(freshVisionModeSetting
                ? { VISION_MODE: freshVisionModeSetting }
                : {}),
              // Disable image description when vision is explicitly toggled off.
              ...(freshConfig.features?.vision === false
                ? { DISABLE_IMAGE_DESCRIPTION: "true" }
                : {}),
            },
          });
          installRuntimeMethodBindings(newRuntime);

          // Pre-register plugin-sql + local-embedding before initialize()
          // to avoid the same race condition as the initial startup.
          // Re-derive from freshly resolved plugins (not outer closure) so
          // hot-reload picks up any plugin updates.
          const freshSqlPlugin = resolvedPlugins.find(
            (p) => p.name === "@elizaos/plugin-sql",
          );
          const freshLocalEmbeddingPlugin = resolvedPlugins.find(
            (p) => p.name === "@elizaos/plugin-local-embedding",
          );
          if (freshSqlPlugin) {
            await registerSqlPluginWithRecovery(
              newRuntime,
              freshSqlPlugin,
              freshConfig,
            );
          }
          if (freshLocalEmbeddingPlugin) {
            configureLocalEmbeddingPlugin(
              freshLocalEmbeddingPlugin.plugin,
              freshConfig,
            );
            await newRuntime.registerPlugin(freshLocalEmbeddingPlugin.plugin);
          }

          // Pre-register remaining core plugins sequentially (same as startup)
          {
            const alreadyPreRegistered = new Set([
              "@elizaos/plugin-sql",
              "@elizaos/plugin-local-embedding",
            ]);
            for (const name of CORE_PLUGINS) {
              if (alreadyPreRegistered.has(name)) continue;
              const resolved = resolvedPlugins.find((p) => p.name === name);
              if (!resolved) continue;
              try {
                await newRuntime.registerPlugin(resolved.plugin);
              } catch (err) {
                logger.warn(
                  `[milady] Hot-reload: core plugin ${name} pre-registration failed: ${formatError(err)}`,
                );
              }
            }
          }

          await newRuntime.initialize();
          await waitForTrajectoryLoggerService(
            newRuntime,
            "hot-reload runtime.initialize()",
          );
          ensureTrajectoryLoggerEnabled(
            newRuntime,
            "hot-reload runtime.initialize()",
          );

          // Ensure AutonomyService survives hot-reload
          if (!newRuntime.getService("AUTONOMY")) {
            try {
              await AutonomyService.start(newRuntime);
            } catch (err) {
              logger.warn(
                `[milady] AutonomyService failed to start after hot-reload: ${formatError(err)}`,
              );
            }
          }

          installActionAliases(newRuntime);
          runtime = newRuntime;
          logger.info("[milady] Hot-reload: Runtime restarted successfully");
          return newRuntime;
        } catch (err) {
          logger.error(`[milady] Hot-reload failed: ${formatError(err)}`);
          return null;
        }
      },
    });
    const dashboardUrl = `http://localhost:${actualApiPort}`;
    console.log(`[milady] Control UI: ${dashboardUrl}`);
    logger.info(`[milady] API server listening on ${dashboardUrl}`);
  } catch (apiErr) {
    // Log to both stderr (visible to Electrobun agent.ts) and the in-memory
    // logger so the error is never silently swallowed in packaged builds.
    const apiErrMsg = `[milady] Could not start API server: ${formatError(apiErr)}`;
    console.error(apiErrMsg);
    logger.warn(apiErrMsg);

    // In server-only mode (Electrobun desktop), a missing API server is fatal
    // — nothing else can serve requests. Exit so the parent process sees a
    // non-zero exit code instead of the misleading "Server running" message.
    if (opts?.serverOnly) {
      console.error(
        "[milady] Exiting: API server is required in server-only mode.",
      );
      process.exit(1);
    }
    // Non-fatal in CLI mode — the interactive chat loop still works.
  }

  // ── Server-only mode — keep running without chat loop ────────────────────
  if (opts?.serverOnly) {
    logger.info("[milady] Running in server-only mode (no interactive chat)");
    console.log("[milady] Server running. Press Ctrl+C to stop.");

    // Keep process alive — the API server handles all interaction
    const keepAlive = setInterval(() => {}, 1 << 30); // ~12 days

    // Cleanup on exit
    const cleanup = async () => {
      clearInterval(keepAlive);
      try {
        await shutdownRuntime(runtime, "server-only shutdown");
      } catch (err) {
        logger.warn(`[milady] Error stopping runtime: ${formatError(err)}`);
      }
      process.exit(0);
    };

    process.on("SIGINT", () => void cleanup());
    process.on("SIGTERM", () => void cleanup());

    return runtime;
  }

  // ── Interactive chat loop ────────────────────────────────────────────────
  const agentName = character.name ?? "Milady";
  const userId = crypto.randomUUID() as UUID;
  // Use `let` so the fallback path can reassign to fresh IDs.
  let roomId = stringToUuid(`${agentName}-chat-room`);

  try {
    const worldId = stringToUuid(`${agentName}-chat-world`);
    // Use a deterministic messageServerId so the settings provider
    // can reference the world by serverId after it is found.
    const messageServerId = stringToUuid(`${agentName}-cli-server`) as UUID;
    await runtime.ensureConnection({
      entityId: userId,
      roomId,
      worldId,
      userName: "User",
      source: "cli",
      channelId: `${agentName}-chat`,
      type: ChannelType.DM,
      messageServerId,
      metadata: { ownership: { ownerId: userId } },
    });
    // Ensure the world has ownership metadata so the settings
    // provider can locate it via findWorldsForOwner during onboarding.
    // This also handles worlds that already exist from a prior session
    // but were created without ownership metadata.
    const world = await runtime.getWorld(worldId);
    if (world) {
      let needsUpdate = false;
      if (!world.metadata) {
        world.metadata = {};
        needsUpdate = true;
      }
      if (
        !world.metadata.ownership ||
        typeof world.metadata.ownership !== "object" ||
        (world.metadata.ownership as { ownerId: string }).ownerId !== userId
      ) {
        world.metadata.ownership = { ownerId: userId };
        needsUpdate = true;
      }
      if (needsUpdate) {
        await runtime.updateWorld(world);
      }
    }
  } catch (err) {
    logger.warn(
      `[milady] Could not establish chat room, retrying with fresh IDs: ${formatError(err)}`,
    );

    // Fall back to unique IDs if deterministic ones conflict with stale data.
    // IMPORTANT: reassign roomId so the message loop below uses the same room.
    roomId = crypto.randomUUID() as UUID;
    const freshWorldId = crypto.randomUUID() as UUID;
    const freshServerId = crypto.randomUUID() as UUID;
    try {
      await runtime.ensureConnection({
        entityId: userId,
        roomId,
        worldId: freshWorldId,
        userName: "User",
        source: "cli",
        channelId: `${agentName}-chat`,
        type: ChannelType.DM,
        messageServerId: freshServerId,
        metadata: { ownership: { ownerId: userId } },
      });
      // Same ownership metadata fix for the fallback world.
      const fallbackWorld = await runtime.getWorld(freshWorldId);
      if (fallbackWorld) {
        let needsUpdate = false;
        if (!fallbackWorld.metadata) {
          fallbackWorld.metadata = {};
          needsUpdate = true;
        }
        if (
          !fallbackWorld.metadata.ownership ||
          typeof fallbackWorld.metadata.ownership !== "object" ||
          (fallbackWorld.metadata.ownership as { ownerId: string }).ownerId !==
            userId
        ) {
          fallbackWorld.metadata.ownership = { ownerId: userId };
          needsUpdate = true;
        }
        if (needsUpdate) {
          await runtime.updateWorld(fallbackWorld);
        }
      }
    } catch (retryErr) {
      logger.error(
        `[milady] Chat room setup failed after retry: ${formatError(retryErr)}`,
      );
      throw retryErr;
    }
  }

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  console.log(`\n💬 Chat with ${agentName} (type 'exit' to quit)\n`);

  const prompt = () => {
    rl.question("You: ", async (input) => {
      const text = input.trim();

      if (text.toLowerCase() === "exit" || text.toLowerCase() === "quit") {
        console.log("\nGoodbye!");
        rl.close();
        try {
          await shutdownRuntime(runtime, "cli shutdown");
        } catch (err) {
          logger.warn(`[milady] Error stopping runtime: ${formatError(err)}`);
        }
        process.exit(0);
      }

      if (!text) {
        prompt();
        return;
      }

      try {
        const message = createMessageMemory({
          id: crypto.randomUUID() as UUID,
          entityId: userId,
          roomId,
          content: {
            text,
            source: "client_chat",
            channelType: ChannelType.DM,
          },
        });

        process.stdout.write(`${agentName}: `);

        if (!runtime.messageService) {
          logger.error(
            "[milady] runtime.messageService is not available — cannot process messages",
          );
          console.log("[Error: message service unavailable]\n");
          prompt();
          return;
        }

        await runtime.messageService.handleMessage(
          runtime,
          message,
          async (content) => {
            if (content?.text) {
              process.stdout.write(content.text);
            }
            return [];
          },
        );

        console.log("\n");
      } catch (err) {
        // Log the error and continue the prompt loop — don't let a single
        // failed message kill the interactive session.
        console.log(`\n[Error: ${formatError(err)}]\n`);
        logger.error(
          `[milady] Chat message handling failed: ${formatError(err)}`,
        );
      }
      prompt();
    });
  };

  prompt();
}

// When run directly (not imported), start immediately.
// Use path.resolve to normalise both sides before comparing so that
// symlinks, trailing slashes, and relative paths don't cause false negatives.
// ---------------------------------------------------------------------------
// Cloud thin-client mode
// ---------------------------------------------------------------------------

/**
 * Start in cloud mode — connect to a remote cloud agent via the thin client.
 * Skips all local runtime construction (plugins, database, etc.).
 */
export async function startInCloudMode(
  config: MiladyConfig,
  agentId: string,
  opts?: StartElizaOptions,
): Promise<AgentRuntime | undefined> {
  const { CloudManager } = await import("../cloud/cloud-manager");
  const { normalizeCloudSiteUrl } = await import("../cloud/base-url");

  const cloudConfig = config.cloud!;
  logger.info(
    `[milady] Starting in cloud mode (agentId=${agentId}, baseUrl=${cloudConfig.baseUrl ?? "(default)"})`,
  );

  const manager = new CloudManager(cloudConfig, {
    onStatusChange: (status) => {
      logger.info(`[milady] Cloud connection: ${status}`);
    },
  });

  try {
    await manager.init();
    const proxy = await manager.connect(agentId);

    if (opts?.headless || opts?.serverOnly) {
      // In headless/server mode, start the API server with the cloud proxy.
      // The proxy exposes the same interface the API server needs.
      logger.info(
        `[milady] Cloud agent connected (headless). Agent: ${proxy.agentName}`,
      );
      // Return undefined — the cloud proxy handles everything.
      // TODO: Wire proxy into the API server for GUI mode.
      return undefined;
    }

    // Interactive CLI mode — simple chat loop against the cloud agent
    console.log(
      `\n☁️  Connected to cloud agent "${proxy.agentName}" (${agentId})\n`,
    );
    console.log("Type a message to chat, or Ctrl+C to quit.\n");

    const rl = (await import("node:readline")).createInterface({
      input: process.stdin,
      output: process.stdout,
    });

    const prompt = () => {
      rl.question("You: ", async (input) => {
        const text = input.trim();
        if (!text) {
          prompt();
          return;
        }

        try {
          // Use streaming if available
          let response = "";
          process.stdout.write(`${proxy.agentName}: `);
          for await (const chunk of proxy.handleChatMessageStream(text)) {
            process.stdout.write(chunk);
            response += chunk;
          }
          if (!response) {
            // Fallback to non-streaming
            response = await proxy.handleChatMessage(text);
            process.stdout.write(response);
          }
          console.log("\n");
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          console.error(`\n[error] ${msg}\n`);
        }

        prompt();
      });
    };

    rl.on("close", async () => {
      console.log("\nDisconnecting from cloud agent...");
      await manager.disconnect();
      process.exit(0);
    });

    prompt();

    // Keep the process alive
    return undefined;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error(`[milady] Failed to connect to cloud agent: ${msg}`);
    throw new Error(
      `Failed to connect to cloud agent: ${msg}\n` +
        "You can retry with `milady start`, or switch to local mode with `milady config set cloud.runtime local`",
    );
  }
}

const isDirectRun = (() => {
  const scriptArg = process.argv[1];
  if (!scriptArg) return false;
  const normalised = path.resolve(scriptArg);
  // Exact match against this module's file URL
  if (import.meta.url === pathToFileURL(normalised).href) return true;
  // Fallback: match the specific filename (handles tsx rewriting)
  const base = path.basename(normalised);
  return base === "eliza.ts" || base === "eliza";
})();

if (isDirectRun) {
  startEliza().catch((err) => {
    console.error(
      "[milady] Fatal error:",
      err instanceof Error ? (err.stack ?? err.message) : err,
    );
    process.exit(1);
  });
}
