/**
 * elizaOS runtime entry point for Eliza.
 *
 * Starts the elizaOS agent runtime with Eliza's plugin configuration.
 * Can be run directly via: node --import tsx src/runtime/eliza.ts
 * Or via the CLI: eliza start
 *
 * @module eliza
 */
import crypto from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import fs from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import * as readline from "node:readline";
import { fileURLToPath, pathToFileURL } from "node:url";

// ---------------------------------------------------------------------------
// Extracted modules — re-exported for backward compatibility
// ---------------------------------------------------------------------------
import { runFirstTimeSetup } from "./first-time-setup.js";
import { resolveConfigEnvForProcess } from "./operations/vault-bridge.js";
import { resolvePlugins } from "./plugin-resolver.js";
import {
  CUSTOM_PLUGINS_DIRNAME as CUSTOM_RUNTIME_PLUGINS_DIRNAME,
  type ResolvedPlugin as RuntimeResolvedPlugin,
  STATIC_ELIZA_PLUGINS,
} from "./plugin-types.js";

export {
  CHANNEL_PLUGIN_MAP,
  collectPluginNames,
  OPTIONAL_PLUGIN_MAP,
  PROVIDER_PLUGIN_MAP,
} from "./plugin-collector.js";

export {
  CUSTOM_PLUGINS_DIRNAME,
  EJECTED_PLUGINS_DIRNAME,
  ensureBrowserServerLink,
  findPluginBrowserStagehandDir,
  findRuntimePluginExport,
  mergeDropInPlugins,
  type PluginModuleShape,
  type ResolvedPlugin,
  repairBrokenInstallRecord,
  resolveElizaPluginImportSpecifier,
  resolvePackageEntry,
  STATIC_ELIZA_PLUGINS,
  scanDropInPlugins,
} from "./plugin-types.js";

// resolvePlugins is re-exported via index.ts from ./plugin-resolver

// `@elizaos/app-lifeops` and `@elizaos/app-companion` are NOT eagerly imported
// here. Both packages transitively import from `@elizaos/agent` (e.g.
// `hasOwnerAccess` from this package's barrel) — a top-level static import
// would form a module-init cycle that leaves named exports of the app-lifeops
// actions array as `undefined`, crashing `runtime.registerPlugin` when it
// iterates `plugin.actions`.
//
// Both apps still resolve at plugin-load time via headless dynamic-import
// entrypoints in `plugin-resolver.ts`, after the static module graph has fully
// evaluated, so the cycle never forms and browser-only UI exports stay out of
// the agent process.
// Keep this here as a single sentinel: if we ever need a static reference,
// add `as const` data only — never an `import * as` of an app-* package.
import {
  AgentRuntime,
  AutonomyService,
  addLogListener,
  ChannelType,
  type Component,
  createBasicCapabilitiesPlugin,
  createMessageMemory,
  type Entity,
  type LogEntry,
  logger,
  type Plugin,
  type Provider,
  stringToUuid,
  type TargetInfo,
  type UUID,
} from "@elizaos/core";
import {
  DEFAULT_ELIZA_CLOUD_TEXT_MODEL,
  formatError,
  isElizaSettingsDebugEnabled,
  isMobilePlatform,
  migrateLegacyRuntimeConfig,
  resolveDeploymentTargetInConfig,
  resolveElizaCloudTopology,
  resolveServerOnlyPort,
  resolveServiceRoutingInConfig,
  settingsDebugCloudSummary,
} from "@elizaos/shared";
import { buildCharacterFromConfig } from "./build-character-config.js";
import {
  resolvePreferredProviderId,
  resolvePreferredProviderPluginName,
  resolvePrimaryModel,
} from "./model-resolution.js";

const ELIZAMAKER_MODULE: string = "@elizaos/app-elizamaker";
const STEWARD_EVM_BRIDGE_MODULE: string =
  "@elizaos/app-steward/services/steward-evm-bridge";

type ElizaMakerModule = {
  initializeOGCode?: () => void;
};

type StewardEvmBridgeModule = {
  stewardEvmPreBoot?: (runtime: AgentRuntime) => Promise<void> | void;
  stewardEvmPostBoot?: (runtime: AgentRuntime) => Promise<void> | void;
};

async function loadElizaMakerModule(): Promise<ElizaMakerModule> {
  return (await import(
    /* @vite-ignore */ ELIZAMAKER_MODULE
  )) as ElizaMakerModule;
}

async function loadStewardEvmBridgeModule(): Promise<StewardEvmBridgeModule> {
  return (await import(
    /* @vite-ignore */ STEWARD_EVM_BRIDGE_MODULE
  )) as StewardEvmBridgeModule;
}

import {
  debugLogResolvedContext,
  validateRuntimeContext,
} from "../api/plugin-validation.js";
import { getWalletAddresses, syncSolanaPublicKeyEnv } from "../api/wallet.js";
import {
  configFileExists,
  type ElizaConfig,
  loadElizaConfig,
} from "../config/config.js";
import {
  CONNECTOR_ENV_MAP,
  collectConfigEnvVars,
  collectConnectorEnvVars,
} from "../config/env-vars.js";
import { resolveStateDir, resolveUserPath } from "../config/paths.js";
import {
  createHookEvent,
  type LoadHooksOptions,
  loadHooks,
  triggerHook,
} from "../hooks/index.js";
import { ensureAgentWorkspace } from "../providers/workspace.js";
import { SandboxAuditLog } from "../security/audit-log.js";
import {
  SandboxManager,
  type SandboxMode,
} from "../services/sandbox-manager.js";
import {
  resolveDefaultAgentWorkspaceDir,
  shouldBootstrapWorkspaceInitFiles,
} from "../shared/workspace-resolution.js";
import { CORE_PLUGINS, OPTIONAL_CORE_PLUGINS } from "./core-plugins.js";
import { seedBundledDocuments } from "./default-documents.js";
import discordLocalPlugin from "./discord-local-plugin.js";
import { createElizaPlugin } from "./eliza-plugin.js";
import { detectEmbeddingPreset } from "./embedding-presets.js";
import {
  runtimeDocumentsEnabled,
  runtimeTrajectoriesEnabled,
} from "./native-runtime-features.js";
import {
  createPgliteInitError,
  getPgliteErrorCode,
  PGLITE_ERROR_CODES,
} from "./pglite-error-compat.js";
import { installRuntimePluginLifecycle } from "./plugin-lifecycle.js";
import rolesPlugin from "./roles.js";
import { shouldEnableTrajectoryLoggingByDefault } from "./trajectory-persistence.js";

const require = createRequire(import.meta.url);

function isPluginSqlResolutionError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return (
    message.includes("Cannot find module '@elizaos/plugin-sql'") ||
    message.includes('Cannot find module "@elizaos/plugin-sql"') ||
    (message.includes("@elizaos/plugin-sql") &&
      (message.includes("ResolveMessage") ||
        message.includes("Module not found") ||
        message.includes("could not resolve") ||
        message.includes("Could not resolve")))
  );
}

async function loadRequiredPluginSql(): Promise<
  typeof import("@elizaos/plugin-sql")
> {
  try {
    return await import("@elizaos/plugin-sql");
  } catch (err) {
    const sourceEntry = path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      "../../../../plugins/plugin-sql/typescript/index.node.ts",
    );
    if (!isPluginSqlResolutionError(err) || !existsSync(sourceEntry)) {
      throw err;
    }
    logger.debug(
      `[eliza] Loading @elizaos/plugin-sql from workspace source at ${sourceEntry}`,
    );
    return (await import(
      pathToFileURL(sourceEntry).href
    )) as typeof import("@elizaos/plugin-sql");
  }
}

const pluginSql = await loadRequiredPluginSql();
// plugin-local-embedding is needed when local embeddings are enabled, but
// Docker no-embedding smokes must still boot if a published package advertises
// a missing dist entry.
let pluginLocalEmbedding:
  | typeof import("@elizaos/plugin-local-embedding")
  | null = null;
try {
  pluginLocalEmbedding = await import("@elizaos/plugin-local-embedding");
} catch {
  pluginLocalEmbedding = null;
}
// Agent orchestrator ships as the standalone @elizaos/plugin-agent-orchestrator package.
// Use top-level dynamic import because the package is ESM-only and fails under
// createRequire() in bun runtime; the await is resolved before module consumers read the binding.
let pluginAgentOrchestrator: unknown = null;
try {
  const packageName = "@elizaos/plugin-agent-orchestrator";
  pluginAgentOrchestrator = await import(packageName);
} catch {
  pluginAgentOrchestrator = null;
}
// Keep plugin-shell behind a guarded runtime require too. The published alpha
// tarball can declare dist/index.js without actually shipping it, which breaks
// CLI/bootstrap in published-only CI.
let pluginShell: unknown = null;
try {
  pluginShell = require("@elizaos/plugin-shell");
} catch {
  pluginShell = null;
}
// Keep plugin-commands behind a guarded runtime require. Some published alpha
// builds advertise dist/index.js without actually shipping it, and a static
// ESM import here makes the CLI fail before it can print --help/--version.
let pluginCommands: unknown = null;
try {
  pluginCommands = require("@elizaos/plugin-commands");
} catch {
  pluginCommands = null;
}
// Keep plugin-video behind a guarded runtime require. plugin-video's main
// points at dist/index.js, which is not built in test/CI flows that do not
// run a full plugin build first; a static ESM import then crashes vitest at
// resolution time. Same pattern as plugin-shell / plugin-commands above.
let pluginVideo: unknown = null;
try {
  pluginVideo = require("@elizaos/plugin-video");
} catch {
  pluginVideo = null;
}
// Keep plugin-elizacloud behind a guarded runtime require as well. Some
// published alpha builds advertise dist/node/index.node.js but do not ship
// that ESM entry, which breaks CLI bootstrap in published-only CI.
let pluginElizacloud: unknown = null;
try {
  pluginElizacloud = require("@elizaos/plugin-elizacloud");
} catch {
  pluginElizacloud = null;
}
// Keep plugin-ollama behind a guarded runtime require as well. Some published
// alpha builds advertise dist/node/index.node.js but do not ship that ESM
// entry, which breaks CLI bootstrap and startup smokes in published-only CI.
let pluginOllama: unknown = null;
try {
  pluginOllama = require("@elizaos/plugin-ollama");
} catch {
  pluginOllama = null;
}
// Keep plugin-anthropic behind a guarded runtime require too. Some published
// alpha builds advertise dist/node/index.node.js without shipping that entry,
// which breaks no-credential Docker startup smokes before provider selection.
let pluginAnthropic: unknown = null;
try {
  pluginAnthropic = require("@elizaos/plugin-anthropic");
} catch {
  pluginAnthropic = null;
}
// Keep plugin-openai behind a guarded runtime require too. Some published
// alpha builds advertise dist/node/index.node.js without shipping that entry,
// which breaks CLI bootstrap and validation in published-only CI.
let pluginOpenai: unknown = null;
try {
  pluginOpenai = require("@elizaos/plugin-openai");
} catch {
  pluginOpenai = null;
}
// Personality is bundled in @elizaos/core advanced capabilities (advancedCapabilities).

type SignalShutdownContext = {
  getRuntime: () => AgentRuntime;
  getSandboxManager: () => SandboxManager | null;
  beforeShutdown?: () => void | Promise<void>;
};

let activeSignalShutdownContext: SignalShutdownContext | null = null;
let signalHandlersRegistered = false;
let signalShutdownPromise: Promise<void> | null = null;

function registerSignalShutdownHandlers(context: SignalShutdownContext): void {
  activeSignalShutdownContext = context;
  if (signalHandlersRegistered) {
    return;
  }

  const shutdown = async (): Promise<void> => {
    if (signalShutdownPromise) {
      await signalShutdownPromise;
      return;
    }

    signalShutdownPromise = (async () => {
      const current = activeSignalShutdownContext;
      if (!current) {
        process.exit(0);
      }

      try {
        await current?.beforeShutdown?.();
      } catch (err) {
        logger.warn(`[eliza] Pre-shutdown cleanup error: ${formatError(err)}`);
      }

      try {
        const sandboxManager = current?.getSandboxManager();
        if (sandboxManager) {
          try {
            await sandboxManager.stop();
            logger.info("[eliza] Sandbox manager stopped");
          } catch (err) {
            logger.warn(
              `[eliza] Sandbox stop error: ${err instanceof Error ? err.message : String(err)}`,
            );
          }
        }
      } catch (err) {
        logger.warn(`[eliza] Sandbox shutdown error: ${formatError(err)}`);
      }

      try {
        const runtime = current?.getRuntime();
        if (runtime) {
          await shutdownRuntime(runtime, "signal shutdown");
        }
      } catch (err) {
        logger.warn(`[eliza] Error during shutdown: ${formatError(err)}`);
      }

      process.exit(0);
    })();

    await signalShutdownPromise;
  };

  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());
  signalHandlersRegistered = true;
}

/**
 * Map of baseline bundled @elizaos plugin names to their statically imported
 * modules.
 *
 * Post-release plugins are intentionally excluded so the packaged runtime can
 * ship a smaller baseline bundle. Those plugins fall through to dynamic
 * import() and can be installed later via the plugin installer.
 */
// Populate the shared STATIC_ELIZA_PLUGINS registry (defined in plugin-types.ts)
// so plugin-resolver.ts can read it without importing this module directly.
Object.assign(STATIC_ELIZA_PLUGINS, {
  "@elizaos/plugin-sql": pluginSql,
  ...(pluginLocalEmbedding
    ? { "@elizaos/plugin-local-embedding": pluginLocalEmbedding }
    : {}),
  // secrets (SECRETS service): now built-in core capability (ENABLE_SECRETS_MANAGER)
  ...(pluginAgentOrchestrator
    ? { "agent-orchestrator": pluginAgentOrchestrator }
    : {}),
  ...(pluginShell ? { "@elizaos/plugin-shell": pluginShell } : {}),
  // plugin-manager: now built-in core capability (ENABLE_PLUGIN_MANAGER)
  ...(pluginCommands ? { "@elizaos/plugin-commands": pluginCommands } : {}),
  ...(pluginVideo ? { "@elizaos/plugin-video": pluginVideo } : {}),
  ...(pluginOpenai ? { "@elizaos/plugin-openai": pluginOpenai } : {}),
  ...(pluginAnthropic ? { "@elizaos/plugin-anthropic": pluginAnthropic } : {}),
  ...(pluginOllama ? { "@elizaos/plugin-ollama": pluginOllama } : {}),
  ...(pluginElizacloud
    ? { "@elizaos/plugin-elizacloud": pluginElizacloud }
    : {}),
  // trust: now built-in core capability (ENABLE_TRUST)
  // `@elizaos/app-lifeops` and `@elizaos/app-companion` are intentionally
  // omitted from the static map — see the comment near the top of this file.
  // They resolve via headless dynamic-import entrypoints in plugin-resolver.ts.
  "@elizaos/plugin-discord-local": discordLocalPlugin,
  // personality: now built-in advanced capability (advancedCapabilities: true)
});

// NODE_PATH so dynamic plugin imports (e.g. @elizaos/plugin-*) resolve.
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

/**
 * Temporary local compatibility shim for `@elizaos/core` not exporting
 * `SandboxFetchAuditEvent` on the current dependency line in this repo.
 * It preserves the runtime shape used by `sandboxAuditHandler`:
 * - `direction` and `url` are required
 * - `tokenIds` tracks tokens associated with the audit payload
 * Remove this local shim once the dependency line used here re-exports it.
 */
type SandboxFetchAuditEvent = {
  direction: "inbound" | "outbound";
  url: string;
  tokenIds: string[];
};

export function configureLocalEmbeddingPlugin(
  _plugin: Plugin,
  config?: ElizaConfig,
): void {
  const detectedPreset = detectEmbeddingPreset();
  const SQL_COMPATIBLE_EMBEDDING_DIMENSIONS = new Set([
    384, 512, 768, 1024, 1536, 3072,
  ]);

  const normalizeEmbeddingDimensions = (
    rawValue: string | undefined,
  ): string | undefined => {
    if (!rawValue) return undefined;
    const parsed = Number.parseInt(rawValue, 10);
    if (!Number.isInteger(parsed) || parsed <= 0) return undefined;
    return SQL_COMPATIBLE_EMBEDDING_DIMENSIONS.has(parsed)
      ? String(parsed)
      : "384";
  };

  const embeddingConfig = config?.embedding;
  const configuredModel = embeddingConfig?.model?.trim();
  const configuredRepo = embeddingConfig?.modelRepo?.trim();
  const configuredDimensions = normalizeEmbeddingDimensions(
    typeof embeddingConfig?.dimensions === "number" &&
      Number.isInteger(embeddingConfig.dimensions) &&
      embeddingConfig.dimensions > 0
      ? String(embeddingConfig.dimensions)
      : undefined,
  );
  const detectedDimensions = normalizeEmbeddingDimensions(
    String(detectedPreset.dimensions),
  );
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

  // Keep plugin-local-embedding aligned with Eliza's hardware-adaptive preset
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
    setEnvIfMissing("LOCAL_EMBEDDING_DIMENSIONS", detectedDimensions);
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

  // Default Groq model names — plugin-groq still ships a deprecated large-model
  // fallback. Seed runtime defaults before plugin init so direct Groq provider
  // sessions do not inherit the retired qwen-qwq-32b default.
  const currentSharedSmallModel =
    process.env.OPENAI_SMALL_MODEL ?? process.env.SMALL_MODEL;
  const currentSharedLargeModel =
    process.env.OPENAI_LARGE_MODEL ?? process.env.LARGE_MODEL;
  setEnvIfMissing(
    "GROQ_SMALL_MODEL",
    currentSharedSmallModel && !isLikelyOpenAiTextModel(currentSharedSmallModel)
      ? currentSharedSmallModel
      : "openai/gpt-oss-20b",
  );
  setEnvIfMissing(
    "GROQ_LARGE_MODEL",
    currentSharedLargeModel && !isLikelyOpenAiTextModel(currentSharedLargeModel)
      ? currentSharedLargeModel
      : "openai/gpt-oss-120b",
  );

  logger.info(
    `[eliza] Configured local embedding env: ${process.env.LOCAL_EMBEDDING_MODEL} (repo: ${process.env.LOCAL_EMBEDDING_MODEL_REPO ?? "auto"}, dims: ${process.env.LOCAL_EMBEDDING_DIMENSIONS ?? "auto"}, ctx: ${process.env.LOCAL_EMBEDDING_CONTEXT_SIZE ?? "auto"}, GPU: ${process.env.LOCAL_EMBEDDING_GPU_LAYERS}, mmap: ${process.env.LOCAL_EMBEDDING_USE_MMAP})`,
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function trimEnvString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

type MutableConfigEnv = Record<string, unknown> & {
  vars?: Record<string, unknown>;
};

function getMutableConfigEnv(config: ElizaConfig): MutableConfigEnv | null {
  if (
    !config.env ||
    typeof config.env !== "object" ||
    Array.isArray(config.env)
  ) {
    return null;
  }
  return config.env as MutableConfigEnv;
}

function getMutableConfigEnvVars(
  configEnv: MutableConfigEnv,
): Record<string, unknown> | null {
  if (
    !configEnv.vars ||
    typeof configEnv.vars !== "object" ||
    Array.isArray(configEnv.vars)
  ) {
    return null;
  }
  return configEnv.vars as Record<string, unknown>;
}

function readConfigEnvValue(
  config: ElizaConfig,
  key: string,
): string | undefined {
  const configEnv = getMutableConfigEnv(config);
  if (!configEnv) return undefined;
  const vars = getMutableConfigEnvVars(configEnv);
  return trimEnvString(vars?.[key]) ?? trimEnvString(configEnv[key]);
}

function readEffectiveEnvValue(
  config: ElizaConfig,
  key: string,
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  return trimEnvString(env[key]) ?? readConfigEnvValue(config, key);
}

function setConfigEnvValue(
  config: ElizaConfig,
  key: string,
  value: string,
): void {
  if (
    !config.env ||
    typeof config.env !== "object" ||
    Array.isArray(config.env)
  ) {
    config.env = {};
  }
  const configEnv = config.env as MutableConfigEnv;
  const vars = getMutableConfigEnvVars(configEnv);
  if (vars) {
    vars[key] = value;
    delete configEnv[key];
    return;
  }
  configEnv[key] = value;
}

function deleteConfigEnvValue(config: ElizaConfig, key: string): void {
  const configEnv = getMutableConfigEnv(config);
  if (!configEnv) return;

  const vars = getMutableConfigEnvVars(configEnv);
  if (vars) {
    delete vars[key];
    if (Object.keys(vars).length === 0) {
      delete configEnv.vars;
    }
  }

  delete configEnv[key];
}

function detectOpenAiBaseUrlProvider(baseUrl: string): "groq" | null {
  try {
    const hostname = new URL(baseUrl).hostname.trim().toLowerCase();
    if (hostname === "api.groq.com" || hostname.endsWith(".groq.com")) {
      return "groq";
    }
  } catch {
    return null;
  }

  return null;
}

function looksLikeGroqApiKey(value: string | undefined): boolean {
  return Boolean(value && /^gsk[-_]/i.test(value));
}

function isLikelyOpenAiTextModel(value: string | undefined): boolean {
  if (!value) return false;
  const normalized = value.trim().toLowerCase();
  return normalized.startsWith("gpt-") || normalized.startsWith("openai/");
}

/**
 * Normalize known-bad provider compatibility shims before plugin resolution.
 *
 * A common failure mode is routing the OpenAI plugin through Groq's
 * OpenAI-compatible base URL while leaving OpenAI defaults (`gpt-5.5`,
 * `gpt-5-mini`) in place. Structured output generation then fails during
 * message handling because Groq does not serve those model IDs.
 *
 * When we can confidently detect that state, rewrite the effective runtime
 * config to use the Groq plugin directly.
 */
/** @internal Exported for testing. */
export function normalizeOpenAiCompatibleProviderConfig(
  config: ElizaConfig,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const cloudInferenceEnabled = resolveElizaCloudTopology(
    config as Record<string, unknown>,
  ).services.inference;
  if (cloudInferenceEnabled) {
    return false;
  }

  const openaiBaseUrl = readEffectiveEnvValue(config, "OPENAI_BASE_URL", env);
  if (!openaiBaseUrl) {
    return false;
  }

  if (detectOpenAiBaseUrlProvider(openaiBaseUrl) !== "groq") {
    return false;
  }

  const openaiApiKey = readEffectiveEnvValue(config, "OPENAI_API_KEY", env);
  const groqApiKey = readEffectiveEnvValue(config, "GROQ_API_KEY", env);
  const inheritedGroqApiKey =
    groqApiKey ??
    (looksLikeGroqApiKey(openaiApiKey) ? openaiApiKey : undefined);
  if (!inheritedGroqApiKey) {
    return false;
  }

  const currentGroqSmallModel = readEffectiveEnvValue(
    config,
    "GROQ_SMALL_MODEL",
    env,
  );
  const currentGroqLargeModel = readEffectiveEnvValue(
    config,
    "GROQ_LARGE_MODEL",
    env,
  );
  const currentSharedSmallModel =
    readEffectiveEnvValue(config, "OPENAI_SMALL_MODEL", env) ??
    readEffectiveEnvValue(config, "SMALL_MODEL", env);
  const currentSharedLargeModel =
    readEffectiveEnvValue(config, "OPENAI_LARGE_MODEL", env) ??
    readEffectiveEnvValue(config, "LARGE_MODEL", env);

  const normalizedGroqSmallModel =
    currentGroqSmallModel ??
    (currentSharedSmallModel &&
    !isLikelyOpenAiTextModel(currentSharedSmallModel)
      ? currentSharedSmallModel
      : "llama-3.1-8b-instant");
  const normalizedGroqLargeModel =
    currentGroqLargeModel ??
    (currentSharedLargeModel &&
    !isLikelyOpenAiTextModel(currentSharedLargeModel)
      ? currentSharedLargeModel
      : "qwen/qwen3-32b");

  env.GROQ_API_KEY = inheritedGroqApiKey;
  env.GROQ_SMALL_MODEL = normalizedGroqSmallModel;
  env.GROQ_LARGE_MODEL = normalizedGroqLargeModel;
  setConfigEnvValue(config, "GROQ_API_KEY", inheritedGroqApiKey);
  setConfigEnvValue(config, "GROQ_SMALL_MODEL", normalizedGroqSmallModel);
  setConfigEnvValue(config, "GROQ_LARGE_MODEL", normalizedGroqLargeModel);

  delete env.OPENAI_BASE_URL;
  deleteConfigEnvValue(config, "OPENAI_BASE_URL");

  const shouldDisableOpenAiKey =
    !openaiApiKey ||
    openaiApiKey === groqApiKey ||
    looksLikeGroqApiKey(openaiApiKey);
  if (shouldDisableOpenAiKey) {
    delete env.OPENAI_API_KEY;
    deleteConfigEnvValue(config, "OPENAI_API_KEY");
  }

  const primaryModel = trimEnvString(config.agents?.defaults?.model?.primary);
  if (
    shouldDisableOpenAiKey &&
    primaryModel &&
    (primaryModel.toLowerCase() === "openai" ||
      isLikelyOpenAiTextModel(primaryModel))
  ) {
    config.agents ??= {};
    config.agents.defaults ??= {};
    config.agents.defaults.model = {
      ...config.agents.defaults.model,
      primary: "groq",
    };
  }

  logger.warn(
    "[eliza] Detected Groq routed through OPENAI_BASE_URL; normalizing runtime settings to use @elizaos/plugin-groq",
  );

  return true;
}

/** Redact username segments from filesystem paths to avoid leaking user info in logs. */
function _redactUserSegments(filepath: string): string {
  // Replace /Users/<name>/ or /home/<name>/ with /Users/<redacted>/ etc.
  return filepath.replace(/\/(Users|home)\/[^/]+\//g, "/$1/<redacted>/");
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
    logger.warn(`[eliza] ${context}: runtime stop failed: ${formatError(err)}`);
  }

  if (adapter && typeof adapter.close === "function") {
    try {
      await adapter.close();
    } catch (err) {
      if (!firstError) {
        firstError = err;
      }
      logger.warn(
        `[eliza] ${context}: database adapter close failed: ${formatError(err)}`,
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
            `[eliza] Skipping duplicate action "${action.name}" from plugin "${plugin.name}"`,
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

type TrajectoryLoggerRegistrationStatus =
  | "pending"
  | "registering"
  | "registered"
  | "failed"
  | "unknown";

/** Subset of AutonomyService used to enable the autonomy loop. */
interface AutonomyServiceLike {
  enableAutonomy(): Promise<void>;
}

/**
 * Retrieve the AutonomyService from the runtime, returning null if unavailable.
 * Uses a runtime property check to safely narrow the opaque Service return.
 */
function getAutonomyService(runtime: AgentRuntime): AutonomyServiceLike | null {
  const svc = runtime.getService("AUTONOMY") ?? runtime.getService("autonomy");
  if (
    svc &&
    "enableAutonomy" in svc &&
    typeof svc.enableAutonomy === "function"
  ) {
    return svc as AutonomyServiceLike;
  }
  return null;
}

async function startAndRegisterAutonomyService(
  runtime: AgentRuntime,
): Promise<AutonomyServiceLike> {
  const service = await AutonomyService.start(runtime);
  runtime.services.set("AUTONOMY" as never, [service as never]);
  return service as AutonomyServiceLike;
}

type TrajectoryLoggerRuntimeLike = {
  getServicesByType?: (serviceType: string) => unknown;
  getService?: (serviceType: string) => unknown;
  getServiceLoadPromise?: (serviceType: string) => Promise<unknown>;
  getServiceRegistrationStatus?: (
    serviceType: string,
  ) => TrajectoryLoggerRegistrationStatus;
};

async function waitForTrajectoriesService(
  runtime: AgentRuntime,
  context: string,
  timeoutMs = 3000,
): Promise<void> {
  if (!runtimeTrajectoriesEnabled(runtime)) {
    return;
  }

  const runtimeLike = runtime as TrajectoryLoggerRuntimeLike;

  // Check if already available
  if (typeof runtimeLike.getService === "function") {
    const existing = runtimeLike.getService("trajectories");
    if (existing) return;
  }

  const registrationStatus =
    typeof runtimeLike.getServiceRegistrationStatus === "function"
      ? runtimeLike.getServiceRegistrationStatus("trajectories")
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
      runtimeLike.getServiceLoadPromise("trajectories").then(() => {}),
      timeoutPromise,
    ]);
    if (timedOut) {
      logger.debug(
        `[eliza] trajectories still ${registrationStatus} after ${timeoutMs}ms (${context})`,
      );
    }
  } catch (err) {
    logger.debug(
      `[eliza] trajectories registration failed while waiting (${context}): ${formatError(err)}`,
    );
  } finally {
    if (timeoutHandle) clearTimeout(timeoutHandle);
  }
}

function ensureTrajectoryLoggerEnabled(
  runtime: AgentRuntime,
  context: string,
): void {
  if (!runtimeTrajectoriesEnabled(runtime)) {
    logger.info(`[eliza] Native trajectories disabled (${context})`);
    return;
  }

  const trajectoryLogger = runtime.getService("trajectories") as
    | TrajectoryLoggerControl
    | null
    | undefined;

  if (!trajectoryLogger) {
    logger.warn(
      `[eliza] trajectories service unavailable (${context}); trajectory capture disabled`,
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
      `[eliza] trajectories defaulted ${shouldEnable ? "on" : "off"} (${context})`,
    );
  }
}

async function installPromptOptimizationLayer(
  runtime: AgentRuntime,
  context: string,
  config?: ElizaConfig,
): Promise<void> {
  try {
    const { installPromptOptimizations } = await import(
      "./prompt-optimization.js"
    );
    installPromptOptimizations(runtime, config);
  } catch (err) {
    logger.warn(
      `[eliza] Failed to install prompt optimizations (${context}): ${err instanceof Error ? err.message : err}`,
    );
  }
}

async function prepareRuntimeForTrajectoryCapture(
  runtime: AgentRuntime,
  context: string,
  config?: ElizaConfig,
): Promise<void> {
  await waitForTrajectoriesService(runtime, context);
  ensureTrajectoryLoggerEnabled(runtime, context);
  await installPromptOptimizationLayer(runtime, context, config);
}

// ---------------------------------------------------------------------------
// Channel secret mapping
// ---------------------------------------------------------------------------

/**
 * Maps Eliza channel config fields to the environment variable names
 * that elizaOS plugins expect.
 *
 * Eliza stores channel credentials under `config.channels.<name>.<field>`,
 * while elizaOS plugins read them from process.env.
 */
const CHANNEL_ENV_MAP = CONNECTOR_ENV_MAP;

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

// CHANNEL_PLUGIN_MAP, PROVIDER_PLUGIN_MAP, and OPTIONAL_PLUGIN_MAP live in
// ./plugin-collector.ts and are re-exported from this module for backward compatibility.

// ---------------------------------------------------------------------------
// Custom / drop-in plugin discovery (moved to plugin-types.ts)
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Plugin resolution
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Browser server pre-flight
// ---------------------------------------------------------------------------

/**
 * Returns true if the given env var key is safe to forward to runtime.settings.
 * Blocks blockchain private keys, secrets, passwords, tokens, credentials,
 * mnemonics, and seed phrases while allowing API keys that plugins need.
 */
export function isEnvKeyAllowedForForwarding(key: string): boolean {
  const upper = key.toUpperCase();
  if (upper === "ALLOW_NO_DATABASE") return false;
  // Block blockchain private keys
  if (upper.includes("PRIVATE_KEY")) return false;
  if (upper.startsWith("EVM_") || upper.startsWith("SOLANA_")) return false;
  // Block secrets, passwords, tokens, and seed phrases (but not API_KEY which plugins need)
  if (/(SECRET|PASSWORD|CREDENTIAL|MNEMONIC|SEED_PHRASE)/i.test(key))
    return false;
  if (/(ACCESS_TOKEN|REFRESH_TOKEN|SESSION_TOKEN|AUTH_TOKEN)$/i.test(key))
    return false;
  // Block elizaCloud connection keys — these must only come from config.cloud
  // via applyCloudConfigToEnv(). Forwarding them from config.env.vars into
  // runtime.settings would let a stale env-var shadow the live cloud key that
  // the app sets when the user connects through the UI.
  if (
    upper === "ELIZAOS_CLOUD_API_KEY" ||
    upper === "ELIZAOS_CLOUD_ENABLED" ||
    upper === "ELIZAOS_CLOUD_BASE_URL" ||
    upper === "ELIZAOS_CLOUD_NANO_MODEL" ||
    upper === "ELIZAOS_CLOUD_MEDIUM_MODEL" ||
    upper === "ELIZAOS_CLOUD_SMALL_MODEL" ||
    upper === "ELIZAOS_CLOUD_LARGE_MODEL" ||
    upper === "ELIZAOS_CLOUD_MEGA_MODEL" ||
    upper === "ELIZAOS_CLOUD_RESPONSE_HANDLER_MODEL" ||
    upper === "ELIZAOS_CLOUD_SHOULD_RESPOND_MODEL" ||
    upper === "ELIZAOS_CLOUD_ACTION_PLANNER_MODEL" ||
    upper === "ELIZAOS_CLOUD_PLANNER_MODEL"
  )
    return false;
  return true;
}

function assertPersistentDatabaseRequired(
  runtime: Pick<AgentRuntime, "getSetting" | "agentId">,
): void {
  const raw =
    runtime.getSetting("ALLOW_NO_DATABASE") ?? process.env.ALLOW_NO_DATABASE;
  const normalized = String(raw ?? "")
    .trim()
    .toLowerCase();
  if (
    normalized === "true" ||
    normalized === "1" ||
    normalized === "yes" ||
    normalized === "on"
  ) {
    throw new Error(
      `Eliza requires persistent database storage and does not permit ALLOW_NO_DATABASE (agent ${runtime.agentId}). Remove ALLOW_NO_DATABASE from config/env and use @elizaos/plugin-sql.`,
    );
  }
}

function isElizaCloudManagedProcessEnvKey(key: string): boolean {
  const upper = key.toUpperCase();
  return (
    upper === "ELIZAOS_CLOUD_API_KEY" ||
    upper === "ELIZAOS_CLOUD_ENABLED" ||
    upper === "ELIZAOS_CLOUD_BASE_URL" ||
    upper === "ELIZAOS_CLOUD_NANO_MODEL" ||
    upper === "ELIZAOS_CLOUD_MEDIUM_MODEL" ||
    upper === "ELIZAOS_CLOUD_SMALL_MODEL" ||
    upper === "ELIZAOS_CLOUD_LARGE_MODEL" ||
    upper === "ELIZAOS_CLOUD_MEGA_MODEL" ||
    upper === "ELIZAOS_CLOUD_RESPONSE_HANDLER_MODEL" ||
    upper === "ELIZAOS_CLOUD_SHOULD_RESPOND_MODEL" ||
    upper === "ELIZAOS_CLOUD_ACTION_PLANNER_MODEL" ||
    upper === "ELIZAOS_CLOUD_PLANNER_MODEL"
  );
}

// findPluginBrowserStagehandDir, ensureBrowserServerLink,
// repairBrokenInstallRecord, resolvePackageEntry — moved to plugin-types.ts

// ---------------------------------------------------------------------------
// Config → Character mapping
// ---------------------------------------------------------------------------

/**
 * Propagate channel credentials from Eliza config into process.env so
 * that elizaOS plugins can find them.
 */
/** @internal Exported for testing. */
export function applyConnectorSecretsToEnv(config: ElizaConfig): void {
  // Prefer config.connectors, fall back to config.channels for backward compatibility
  const connectors =
    config.connectors ?? (config as Record<string, unknown>).channels ?? {};

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
        process.env.DISCORD_API_TOKEN = tokenValue;
        process.env.DISCORD_BOT_TOKEN = tokenValue;
      }
    }

    const envMap = CHANNEL_ENV_MAP[channelName];
    if (!envMap) continue;

    for (const [configField, envKey] of Object.entries(envMap)) {
      const value = configObj[configField];
      if (typeof value === "boolean" || typeof value === "number") {
        process.env[envKey] = String(value);
      } else if (typeof value === "string" && value.trim()) {
        process.env[envKey] = value;
      }
    }

    if (channelName === "whatsapp") {
      const allowFrom = configObj.allowFrom;
      if (Array.isArray(allowFrom) && allowFrom.length > 0) {
        const normalized = allowFrom
          .map((value) => String(value).trim())
          .filter(Boolean);
        if (normalized.length > 0) {
          process.env.WHATSAPP_ALLOW_FROM = normalized.join(",");
        }
      }

      const groupAllowFrom = configObj.groupAllowFrom;
      if (Array.isArray(groupAllowFrom) && groupAllowFrom.length > 0) {
        const normalized = groupAllowFrom
          .map((value) => String(value).trim())
          .filter(Boolean);
        if (normalized.length > 0) {
          process.env.WHATSAPP_GROUP_ALLOW_FROM = normalized.join(",");
        }
      }

      const accounts = configObj.accounts;
      if (
        accounts &&
        typeof accounts === "object" &&
        !Array.isArray(accounts)
      ) {
        const firstEnabledAccount = Object.values(
          accounts as Record<string, unknown>,
        ).find((account) => {
          if (
            !account ||
            typeof account !== "object" ||
            Array.isArray(account)
          ) {
            return false;
          }
          const candidate = account as Record<string, unknown>;
          return (
            candidate.enabled !== false && typeof candidate.authDir === "string"
          );
        }) as Record<string, unknown> | undefined;

        if (
          firstEnabledAccount &&
          typeof firstEnabledAccount.authDir === "string" &&
          firstEnabledAccount.authDir.trim()
        ) {
          process.env.WHATSAPP_AUTH_DIR = firstEnabledAccount.authDir.trim();
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
        `[eliza] Failed to auto-resolve Discord Application ID: ${res.status}`,
      );
      return;
    }

    const app = (await res.json()) as { id?: string };
    if (!app.id) return;

    process.env.DISCORD_APPLICATION_ID = app.id;
    logger.info(`[eliza] Auto-resolved Discord Application ID: ${app.id}`);
  } catch (err) {
    logger.warn(
      `[eliza] Could not auto-resolve Discord Application ID: ${err}`,
    );
  }
}

/**
 * Fetch GitHub OAuth token from cloud if available and no local token is set.
 * Called during async runtime init after cloud config is applied.
 *
 * Flow: If the agent has a managed GitHub connection in the cloud, and no
 * local GITHUB_TOKEN is set, fetch the OAuth token from the cloud API and
 * inject it into process.env so plugins (plugin-github, git-workspace-service)
 * can use it for API calls and git credential helpers.
 */
/** @internal Exported for testing. */
export async function autoFetchCloudGithubToken(
  agentId?: string,
): Promise<void> {
  // Skip if a local token is already configured
  if (process.env.GITHUB_TOKEN || process.env.GITHUB_PAT) return;

  // Need cloud credentials and an agent ID
  const cloudApiKey = process.env.ELIZAOS_CLOUD_API_KEY?.trim();
  const cloudBaseUrl =
    process.env.ELIZAOS_CLOUD_BASE_URL?.trim() || "https://api.elizacloud.ai";
  if (!cloudApiKey || !agentId) return;

  const managedNs = process.env.ELIZA_CLOUD_MANAGED_AGENTS_API_SEGMENT?.trim();
  if (!managedNs) return;

  try {
    const url = `${cloudBaseUrl}/api/v1/${managedNs}/agents/${encodeURIComponent(agentId)}/github/token`;
    const res = await fetch(url, {
      headers: {
        Authorization: `Bearer ${cloudApiKey}`,
        Accept: "application/json",
      },
      signal: AbortSignal.timeout(10_000),
    });

    if (!res.ok) {
      // 404 = no GitHub connection for this agent, which is fine
      if (res.status !== 404) {
        logger.warn(
          `[eliza] Failed to fetch cloud GitHub token: ${res.status}`,
        );
      }
      return;
    }

    const body = (await res.json()) as {
      success?: boolean;
      data?: { accessToken?: string; githubUsername?: string };
    };
    if (!body.success || !body.data?.accessToken) return;

    process.env.GITHUB_TOKEN = body.data.accessToken;
    logger.info(
      `[eliza] Fetched GitHub token from cloud for @${body.data.githubUsername || "unknown"}`,
    );
  } catch (err) {
    logger.warn(`[eliza] Could not fetch cloud GitHub token: ${err}`);
  }
}

/**
 * Propagate cloud config from Eliza config into process.env so the
 * ElizaCloud plugin can discover settings at startup.
 */
/** @internal Exported for testing. */
export function applyCloudConfigToEnv(config: ElizaConfig): void {
  migrateLegacyRuntimeConfig(config as Record<string, unknown>);
  const cloud = config.cloud;

  const isCloudContainer = process.env.ELIZA_CLOUD_PROVISIONED === "1";
  if (!cloud && !isCloudContainer) return;
  const topology = resolveElizaCloudTopology(config as Record<string, unknown>);

  // Cloud inference is selected from the canonical onboarding connection, not
  // just from raw cloud flags. This keeps linked cloud auth from re-enabling
  // Eliza Cloud after the user has switched to a local or remote provider.
  const effectivelyEnabled = topology.services.inference || isCloudContainer;
  const shouldLoadCloudPlugin = topology.shouldLoadPlugin || isCloudContainer;

  const setCloudUsageEnv = (key: string, enabled: boolean): void => {
    if (enabled) {
      process.env[key] = "true";
    } else {
      delete process.env[key];
    }
  };

  if (isElizaSettingsDebugEnabled()) {
    const c = (cloud ?? {}) as Record<string, unknown>;
    logger.debug(
      `[eliza][settings][runtime] applyCloudConfigToEnv inference=${effectivelyEnabled} shouldLoadPlugin=${shouldLoadCloudPlugin} isCloudContainer=${isCloudContainer} cloud=${JSON.stringify(settingsDebugCloudSummary(c))}`,
    );
  }

  setCloudUsageEnv("ELIZAOS_CLOUD_USE_INFERENCE", effectivelyEnabled);
  setCloudUsageEnv(
    "ELIZAOS_CLOUD_USE_TTS",
    topology.services.tts || isCloudContainer,
  );
  setCloudUsageEnv("ELIZAOS_CLOUD_USE_MEDIA", topology.services.media);
  setCloudUsageEnv(
    "ELIZAOS_CLOUD_USE_EMBEDDINGS",
    topology.services.embeddings,
  );
  setCloudUsageEnv("ELIZAOS_CLOUD_USE_RPC", topology.services.rpc);

  if (effectivelyEnabled) {
    process.env.ELIZAOS_CLOUD_ENABLED = "true";
  } else {
    delete process.env.ELIZAOS_CLOUD_ENABLED;
  }

  if (shouldLoadCloudPlugin) {
    logger.info(
      `[eliza] Cloud config: inference=${topology.services.inference}, runtime=${topology.runtime}, hasApiKey=${Boolean(cloud?.apiKey || process.env.ELIZAOS_CLOUD_API_KEY)}, baseUrl=${cloud?.baseUrl ?? "(default)"}, isCloudContainer=${isCloudContainer}`,
    );
    // Only propagate the API key when cloud is enabled AND it is a real
    // credential — never set the literal "[REDACTED]" placeholder (which can
    // leak into the config via UI round-trips through the redacted GET → PUT
    // cycle). WHY: when enabled is false (BYOK / disconnected), leaving the key
    // in process.env still auto-loads @elizaos/plugin-elizacloud and steals
    // TEXT_LARGE even if the JSON says cloud is off.
    const isRealApiKey =
      cloud?.apiKey && cloud.apiKey.trim().toUpperCase() !== "[REDACTED]";
    if (isRealApiKey) {
      process.env.ELIZAOS_CLOUD_API_KEY = cloud.apiKey;
    } else if (!isCloudContainer) {
      delete process.env.ELIZAOS_CLOUD_API_KEY;
    }
    if (cloud?.baseUrl) {
      process.env.ELIZAOS_CLOUD_BASE_URL = cloud.baseUrl;
    } else if (!isCloudContainer) {
      delete process.env.ELIZAOS_CLOUD_BASE_URL;
    }
  } else {
    delete process.env.ELIZAOS_CLOUD_NANO_MODEL;
    delete process.env.ELIZAOS_CLOUD_MEDIUM_MODEL;
    delete process.env.ELIZAOS_CLOUD_SMALL_MODEL;
    delete process.env.ELIZAOS_CLOUD_LARGE_MODEL;
    delete process.env.ELIZAOS_CLOUD_MEGA_MODEL;
    delete process.env.ELIZAOS_CLOUD_RESPONSE_HANDLER_MODEL;
    delete process.env.ELIZAOS_CLOUD_SHOULD_RESPOND_MODEL;
    delete process.env.ELIZAOS_CLOUD_ACTION_PLANNER_MODEL;
    delete process.env.ELIZAOS_CLOUD_PLANNER_MODEL;
    delete process.env.ELIZAOS_CLOUD_API_KEY;
    delete process.env.ELIZAOS_CLOUD_BASE_URL;
  }

  // Propagate model names so the cloud plugin picks them up. Falls back to
  // sensible defaults when cloud is enabled but no explicit selection exists.
  // Skip when inferenceMode is "byok"/"local" or services.inference is off —
  // user's own keys handle models.
  // If the user chose a subscription provider, treat that as "byok" unless
  // they explicitly set inferenceMode to "cloud".
  const llmText = resolveServiceRoutingInConfig(
    config as Record<string, unknown>,
  )?.llmText;
  const models = (config as Record<string, unknown>).models as
    | {
        nano?: string;
        small?: string;
        medium?: string;
        large?: string;
        mega?: string;
      }
    | undefined;
  if (effectivelyEnabled) {
    const nano =
      llmText?.nanoModel || models?.nano || DEFAULT_ELIZA_CLOUD_TEXT_MODEL;
    const small =
      llmText?.smallModel || models?.small || DEFAULT_ELIZA_CLOUD_TEXT_MODEL;
    const medium = llmText?.mediumModel || models?.medium || small;
    const large =
      llmText?.largeModel || models?.large || DEFAULT_ELIZA_CLOUD_TEXT_MODEL;
    const mega = llmText?.megaModel || models?.mega || large;
    const responseHandlerModel =
      llmText?.responseHandlerModel || llmText?.shouldRespondModel;
    const actionPlannerModel =
      llmText?.actionPlannerModel || llmText?.plannerModel;
    process.env.SMALL_MODEL = small;
    process.env.NANO_MODEL = nano;
    process.env.MEDIUM_MODEL = medium;
    process.env.LARGE_MODEL = large;
    process.env.MEGA_MODEL = mega;
    if (responseHandlerModel) {
      process.env.ELIZAOS_CLOUD_RESPONSE_HANDLER_MODEL = responseHandlerModel;
      process.env.ELIZAOS_CLOUD_SHOULD_RESPOND_MODEL = responseHandlerModel;
    } else {
      delete process.env.ELIZAOS_CLOUD_RESPONSE_HANDLER_MODEL;
      delete process.env.ELIZAOS_CLOUD_SHOULD_RESPOND_MODEL;
    }
    if (actionPlannerModel) {
      process.env.ELIZAOS_CLOUD_ACTION_PLANNER_MODEL = actionPlannerModel;
      process.env.ELIZAOS_CLOUD_PLANNER_MODEL = actionPlannerModel;
    } else {
      delete process.env.ELIZAOS_CLOUD_ACTION_PLANNER_MODEL;
      delete process.env.ELIZAOS_CLOUD_PLANNER_MODEL;
    }
    process.env.ELIZAOS_CLOUD_NANO_MODEL = nano;
    process.env.ELIZAOS_CLOUD_MEDIUM_MODEL = medium;
    process.env.ELIZAOS_CLOUD_SMALL_MODEL = small;
    process.env.ELIZAOS_CLOUD_LARGE_MODEL = large;
    process.env.ELIZAOS_CLOUD_MEGA_MODEL = mega;
  } else if (shouldLoadCloudPlugin) {
    // Cloud plugin may still be active for non-inference services; keep model
    // routing local by clearing the cloud model aliases.
    delete process.env.ELIZAOS_CLOUD_NANO_MODEL;
    delete process.env.ELIZAOS_CLOUD_MEDIUM_MODEL;
    delete process.env.ELIZAOS_CLOUD_SMALL_MODEL;
    delete process.env.ELIZAOS_CLOUD_LARGE_MODEL;
    delete process.env.ELIZAOS_CLOUD_MEGA_MODEL;
    delete process.env.ELIZAOS_CLOUD_RESPONSE_HANDLER_MODEL;
    delete process.env.ELIZAOS_CLOUD_SHOULD_RESPOND_MODEL;
    delete process.env.ELIZAOS_CLOUD_ACTION_PLANNER_MODEL;
    delete process.env.ELIZAOS_CLOUD_PLANNER_MODEL;
    delete process.env.NANO_MODEL;
    delete process.env.MEDIUM_MODEL;
    delete process.env.SMALL_MODEL;
    delete process.env.LARGE_MODEL;
    delete process.env.MEGA_MODEL;
  }

  // Propagate per-service disable flags so downstream code can check them
  // without needing direct access to the ElizaConfig object.
  if (!topology.services.tts) {
    process.env.ELIZA_CLOUD_TTS_DISABLED = "true";
  } else {
    delete process.env.ELIZA_CLOUD_TTS_DISABLED;
  }
  if (!topology.services.media) {
    process.env.ELIZA_CLOUD_MEDIA_DISABLED = "true";
  } else {
    delete process.env.ELIZA_CLOUD_MEDIA_DISABLED;
  }
  if (!topology.services.embeddings) {
    process.env.ELIZA_CLOUD_EMBEDDINGS_DISABLED = "true";
  } else {
    delete process.env.ELIZA_CLOUD_EMBEDDINGS_DISABLED;
  }
  if (!topology.services.rpc) {
    process.env.ELIZA_CLOUD_RPC_DISABLED = "true";
  } else {
    delete process.env.ELIZA_CLOUD_RPC_DISABLED;
  }
}

/**
 * Translate `config.database` into the environment variables that
 * `@elizaos/plugin-sql` reads at init time (`POSTGRES_URL`, `PGLITE_DATA_DIR`).
 *
 * When the provider is "postgres", we build a connection string from the
 * credentials (or use the explicit `connectionString` field) and set
 * `POSTGRES_URL`. When the provider is "pglite" (the default), we set
 * `PGLITE_DATA_DIR` to either the configured value or the resolved default
 * workspace (`<workspace>/.eliza/.elizadb`) and remove any stale
 * `POSTGRES_URL`.
 */
/** @internal Exported for testing. */
export function applyX402ConfigToEnv(config: ElizaConfig): void {
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

/**
 * Resolve N8N_HOST + N8N_API_KEY for @elizaos/plugin-n8n-workflow.
 *
 * Resolution order (first match wins, later sources are not consulted):
 *
 *   1. Explicit process.env (user override) — both N8N_HOST and N8N_API_KEY
 *      already set. Respected as-is.
 *
 *   2. Eliza Cloud minted token. When `cloud.apiKey` is set and
 *      `cloud.enabled !== false`, mint a short-lived scoped n8n token via
 *      `POST {cloudBaseUrl}/api/v1/n8n/tokens` (auth: `Bearer <cloud.apiKey>`,
 *      body: `{ purpose: "milady-runtime" }`). The full Cloud key is NEVER
 *      passed through as `N8N_API_KEY`. The minted token is cached at
 *      `<stateDir>/n8n/cloud-token.json` and reused while it has more than
 *      60s of life remaining. See `docs/cloud/n8n-gateway-contract.md` (§4).
 *
 *      404 from the gateway endpoint → fall through to (3).
 *      401/403 from the gateway → log error, fall through to (3).
 *      Network/timeout → retried once, then fall through to (3).
 *
 *   3. Local sidecar. When not on a mobile platform, boot the local n8n
 *      sidecar via the app-core sidecar bridge and await readiness. The
 *      sidecar handles owner-setup → login → api-key minting itself; we
 *      just wait for it to land in `ready` and surface its host + apiKey.
 *      Mobile platforms skip this entirely (no child_process available).
 *
 *   4. Disabled. Leave env unset. The plugin's init() warns and the actions
 *      return a structured error to the caller.
 *
 * Called from startEliza() after applyCloudConfigToEnv so cloud settings
 * are already reflected in process.env.
 *
 * @internal Exported for testing.
 */
export async function applyN8nConfigToEnv(
  config: ElizaConfig,
  _agentId: string,
): Promise<void> {
  // 1. Respect existing process.env overrides — the power-user path
  //    (their own n8n on their own VPS).
  if (process.env.N8N_HOST && process.env.N8N_API_KEY) return;

  // Master gate — when config.n8n.enabled is false, do not pump anything.
  if (config.n8n?.enabled === false) return;

  // 2. Eliza Cloud minted token.
  const cloud = config.cloud;
  const cloudAuthed = Boolean(cloud?.apiKey) && cloud?.enabled !== false;
  if (cloudAuthed && cloud?.apiKey) {
    try {
      const { resolveN8nCloudToken } = await import("./n8n-cloud-resolver.js");
      const stateDir = resolveStateDir();
      const resolved = await resolveN8nCloudToken(
        cloud.apiKey,
        cloud.baseUrl ?? "https://www.elizacloud.ai",
        stateDir,
      );
      if (resolved) {
        if (!process.env.N8N_HOST) process.env.N8N_HOST = resolved.host;
        if (!process.env.N8N_API_KEY) {
          process.env.N8N_API_KEY = resolved.apiKey;
        }
        return;
      }
    } catch (err) {
      logger.warn(
        `[N8nCloudResolver] resolver crashed, falling through to sidecar: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
    // Cloud failed but is configured — fall through to local sidecar
    // (the autostart bridge will own ongoing lifecycle; we boot here only
    // to populate env before the n8n plugin reads it).
  }

  // 2b. If the autostart bridge already populated config.n8n.host/apiKey
  //     (e.g. on a hot-reload after the sidecar has been ready for a while),
  //     prefer that over re-booting through the bridge.
  const n8n = config.n8n;
  if (n8n?.host && n8n?.apiKey) {
    if (!process.env.N8N_HOST) process.env.N8N_HOST = n8n.host;
    if (!process.env.N8N_API_KEY) process.env.N8N_API_KEY = n8n.apiKey;
    return;
  }

  // 3. Local sidecar. Skip on mobile (no child_process).
  if (isMobilePlatform()) {
    logger.info("[N8nSidecar] Skipping (mobile platform)");
    return;
  }
  if (n8n?.localEnabled === false) {
    return;
  }

  try {
    const { bootLocalN8nSidecar } = await import("./n8n-sidecar-bridge.js");
    const booted = await bootLocalN8nSidecar({
      enabled: true,
      version: n8n?.version,
      startPort: n8n?.startPort,
    });
    if (booted) {
      if (!process.env.N8N_HOST) process.env.N8N_HOST = booted.host;
      if (!process.env.N8N_API_KEY) process.env.N8N_API_KEY = booted.apiKey;
      return;
    }
  } catch (err) {
    logger.warn(
      `[N8nSidecar] bridge crashed: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }

  // 4. Fallback — leave unset. Legacy `config.env.vars` entries (N8N_HOST /
  //    N8N_API_KEY) still flow through the generic env-var pump in startEliza.
}

function resolveDefaultPgliteDataDir(config: ElizaConfig): string {
  const workspaceDir =
    config.agents?.defaults?.workspace ?? resolveDefaultAgentWorkspaceDir();
  return path.join(resolveUserPath(workspaceDir), ".eliza", ".elizadb");
}

/** @internal Exported for testing. */
export function applyDatabaseConfigToEnv(config: ElizaConfig): void {
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
        `[eliza] PGlite data dir: ${dataDir} (${alreadyExisted ? "existed" : "created"})`,
      );

      // Remove stale postmaster.pid left by a crashed process. Without this,
      // PGlite sees the lock and either fails or, with explicit destructive
      // recovery enabled, triggers the resetPgliteDataDir path.
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
  | "fail-active-lock"
  | "fail-manual-reset";

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
      logger.info(`[eliza] Removed malformed PGlite postmaster.pid`);
      return "cleared-malformed";
    }

    // Check if the process is still alive
    try {
      process.kill(pid, 0); // signal 0 = existence check, doesn't kill
      // Process exists — pid file is NOT stale, leave it alone
      logger.info(
        `[eliza] PGlite postmaster.pid references running process ${pid} — leaving intact`,
      );
      return "active";
    } catch (killErr: unknown) {
      const code = (killErr as NodeJS.ErrnoException).code;
      if (code === "ESRCH") {
        // Process doesn't exist — stale pid file, safe to remove
        unlinkSync(pidPath);
        logger.info(
          `[eliza] Removed stale PGlite postmaster.pid (process ${pid} not running)`,
        );
        return "cleared-stale";
      } else {
        // EPERM or other — process may be alive under a different user,
        // leave the file alone to avoid data directory corruption
        logger.warn(
          `[eliza] Cannot confirm postmaster.pid staleness (${code}) — leaving intact`,
        );
        return "active-unconfirmed";
      }
    }
  } catch (err) {
    logger.warn(
      `[eliza] Failed to check PGlite postmaster.pid: ${formatError(err)}`,
    );
    return "check-failed";
  }
}

/**
 * Check for and remove a stale postmaster.pid in the PGlite data directory.
 * The pid file is stale if the recorded process is no longer running.
 */
export function cleanStalePglitePid(dataDir: string): void {
  try {
    reconcilePglitePidFile(dataDir);
  } catch (err) {
    logger.warn(`[eliza] PGlite PID reconciliation failed: ${err}`);
  }
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
  const code = getPgliteErrorCode(err);
  if (
    code === PGLITE_ERROR_CODES.ACTIVE_LOCK ||
    code === PGLITE_ERROR_CODES.CORRUPT_DATA ||
    code === PGLITE_ERROR_CODES.MANUAL_RESET_REQUIRED
  ) {
    return true;
  }

  const haystack = collectErrorMessages(err).join("\n").toLowerCase();
  if (!haystack) return false;

  const hasAbort = haystack.includes("aborted(). build with -sassertions");
  const hasPglite = haystack.includes("pglite");
  const _hasSqlite = haystack.includes("sqlite");
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
    "could not read blocks",
    "read only ",
    "unreachable code should not be executed",
    "_pgl_backend",
  ].some((needle) => haystack.includes(needle));

  if (hasMigrationsSchema) return true;
  if (hasAbort && hasPglite) return true;
  if (hasRecoverableStorageSignal) return true;
  return false;
}

/** @internal Exported for testing. */
export function getPgliteRecoveryAction(
  err: unknown,
  dataDir: string,
): PgliteRecoveryAction {
  const code = getPgliteErrorCode(err);
  if (code === PGLITE_ERROR_CODES.ACTIVE_LOCK) {
    return "fail-active-lock";
  }
  if (
    code === PGLITE_ERROR_CODES.CORRUPT_DATA ||
    code === PGLITE_ERROR_CODES.MANUAL_RESET_REQUIRED
  ) {
    return "fail-manual-reset";
  }

  if (!isRecoverablePgliteInitError(err)) return "none";

  const pidStatus = reconcilePglitePidFile(dataDir);
  const treatPidAsActiveLock =
    code === PGLITE_ERROR_CODES.ACTIVE_LOCK || isPgliteLockError(err);
  if (
    (treatPidAsActiveLock && pidStatus === "active") ||
    (treatPidAsActiveLock && pidStatus === "active-unconfirmed") ||
    (treatPidAsActiveLock && pidStatus === "check-failed")
  ) {
    return "fail-active-lock";
  }
  if (pidStatus === "cleared-stale" || pidStatus === "cleared-malformed") {
    return "retry-without-reset";
  }
  return "fail-manual-reset";
}

function createActivePgliteLockError(dataDir: string, err: unknown): Error {
  if (
    getPgliteErrorCode(err) === PGLITE_ERROR_CODES.ACTIVE_LOCK &&
    err instanceof Error
  ) {
    return err;
  }
  return createPgliteInitError(
    PGLITE_ERROR_CODES.ACTIVE_LOCK,
    `PGLite data dir is already in use at ${dataDir}. Close the other Eliza or Eliza process, or set a different PGLITE_DATA_DIR before retrying.`,
    { cause: err, dataDir },
  );
}

function formatPgliteFailure(err: unknown): string {
  return collectErrorMessages(err)[0] ?? formatError(err);
}

function createManualResetRequiredPgliteError(
  dataDir: string,
  err: unknown,
): Error {
  if (
    getPgliteErrorCode(err) === PGLITE_ERROR_CODES.MANUAL_RESET_REQUIRED &&
    err instanceof Error
  ) {
    return err;
  }

  const errorText = formatPgliteFailure(err);
  const cause =
    getPgliteErrorCode(err) === PGLITE_ERROR_CODES.CORRUPT_DATA
      ? err
      : createPgliteInitError(
          PGLITE_ERROR_CODES.CORRUPT_DATA,
          `PGlite data dir at ${dataDir} appears corrupt or unreadable: ${errorText}`,
          { cause: err, dataDir },
        );

  return createPgliteInitError(
    PGLITE_ERROR_CODES.MANUAL_RESET_REQUIRED,
    `PGlite initialization failed for ${dataDir}: ${errorText}. Stop Eliza, then rename or delete only this directory before retrying: ${dataDir}`,
    { cause, dataDir },
  );
}

export function isFatalPgliteStartupError(err: unknown): boolean {
  const code = getPgliteErrorCode(err);
  return (
    code === PGLITE_ERROR_CODES.ACTIVE_LOCK ||
    code === PGLITE_ERROR_CODES.CORRUPT_DATA ||
    code === PGLITE_ERROR_CODES.MANUAL_RESET_REQUIRED
  );
}

function resolveActivePgliteDataDir(config: ElizaConfig): string | null {
  const provider = config.database?.provider ?? "pglite";
  if (provider === "postgres") return null;

  const configured = process.env.PGLITE_DATA_DIR?.trim();
  const dataDir = configured || resolveDefaultPgliteDataDir(config);
  return resolveUserPath(dataDir);
}

/** Call whichever init method the adapter exposes (.init or .initialize). */
async function callAdapterInit(
  adapter: AgentRuntime["adapter"],
): Promise<void> {
  const fn =
    "init" in adapter &&
    typeof (adapter as Record<string, unknown>).init === "function"
      ? ((adapter as Record<string, unknown>).init as () => Promise<void>)
      : adapter.initialize;
  if (typeof fn === "function") await fn.call(adapter);
}

async function initializeDatabaseAdapter(
  runtime: AgentRuntime,
  config: ElizaConfig,
): Promise<void> {
  if (!runtime.adapter || (await runtime.adapter.isReady())) return;

  try {
    await callAdapterInit(runtime.adapter);
    logger.info(
      "[eliza] Database adapter initialized early (before plugin inits)",
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
    if (recoveryAction === "fail-manual-reset") {
      throw createManualResetRequiredPgliteError(pgliteDataDir, err);
    }

    logger.warn(
      `[eliza] PGLite init failed (${formatError(err)}). Cleared a stale PGLite lock in ${pgliteDataDir} and retrying without resetting data.`,
    );

    await callAdapterInit(runtime.adapter);
    logger.info(
      "[eliza] Database adapter recovered after clearing a stale PGLite lock",
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
async function verifyPgliteDataDir(config: ElizaConfig): Promise<void> {
  const pgliteDataDir = resolveActivePgliteDataDir(config);
  if (!pgliteDataDir || !existsSync(pgliteDataDir)) return;

  try {
    const files = await fs.readdir(pgliteDataDir);
    logger.info(
      `[eliza] PGlite health check: ${files.length} file(s) in ${pgliteDataDir}`,
    );
    if (files.length === 0) {
      logger.warn(
        `[eliza] PGlite data directory is empty after init — data may not persist across restarts`,
      );
    }
  } catch (err) {
    logger.warn(`[eliza] PGlite health check failed: ${formatError(err)}`);
  }
}

function isPluginAlreadyRegisteredError(err: unknown): boolean {
  return formatError(err).toLowerCase().includes("already registered");
}

interface RuntimeWithMethodBindings extends AgentRuntime {
  __elizaMethodBindingsInstalled?: boolean;
  __elizaComponentWriteDiagnosticsInstalled?: boolean;
  __elizaEntityWriteDiagnosticsInstalled?: boolean;
  __elizaEntityCreateMutex?: Promise<void>;
}

interface RuntimeWithActionAliases extends Omit<AgentRuntime, "actions"> {
  __elizaActionAliasesInstalled?: boolean;
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
  const previous = runtimeWithBindings.__elizaEntityCreateMutex;
  let release: () => void = () => {};
  runtimeWithBindings.__elizaEntityCreateMutex = new Promise<void>(
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
  if (runtimeWithBindings.__elizaMethodBindingsInstalled) {
    return;
  }

  installRuntimePluginLifecycle(runtime);

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
    "ZAI_API_KEY",
    "Z_AI_API_KEY",
    "MOONSHOT_API_KEY",
    "KIMI_API_KEY",
    "OPENAI_BASE_URL",
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

  // Add targeted diagnostics around component writes. Relationships reflection and
  // relationship extraction rely heavily on components; when inserts fail,
  // upstream logs often hide the concrete DB cause/constraint.
  if (!runtimeWithBindings.__elizaComponentWriteDiagnosticsInstalled) {
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
              const fallbackWorldId = room?.worldId ?? null;
              if (fallbackWorldId !== input.worldId) {
                logger.warn(
                  `[eliza] createComponent retry with ${fallbackWorldId ? `room worldId (${fallbackWorldId})` : "null worldId"} after FK violation`,
                );
                const recovered: Component = {
                  ...input,
                  worldId: fallbackWorldId,
                } as Component;
                return await originalCreate(recovered);
              }
            } catch (retryLookupError) {
              logger.warn(
                `[eliza] createComponent recovery lookup failed: ${formatError(retryLookupError)}`,
              );
            }
          }

          const component = summarizeComponentWrite(input);
          logger.error(
            `[eliza] createComponent failed: ${formatError(error)} | component=${JSON.stringify(component)}`,
          );
          logger.error(
            `[eliza] createComponent db details: ${JSON.stringify(toErrorDetails(error))}`,
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
            `[eliza] updateComponent failed: ${formatError(error)} | component=${JSON.stringify(component)}`,
          );
          logger.error(
            `[eliza] updateComponent db details: ${JSON.stringify(toErrorDetails(error))}`,
          );
          throw error;
        }
      };
    }

    runtimeWithBindings.__elizaComponentWriteDiagnosticsInstalled = true;
  }

  // Proactive guard for plugin-sql entity creation. Some evaluators may attempt
  // to create the same entity in rapid succession; plugin-sql's batch insert is
  // non-idempotent and can fail entire writes on duplicate/conflicting rows.
  if (!runtimeWithBindings.__elizaEntityWriteDiagnosticsInstalled) {
    type CreateEntitiesFn = (entities: Entity[]) => Promise<UUID[] | boolean>;
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
      runtimeWithEntityWrites.createEntities = async (entities: Entity[]) => {
        return withEntityCreateMutex(runtimeWithBindings, async () => {
          const uniqueById = new Map<UUID, Entity>();
          for (const entity of entities) {
            if (entity?.id) uniqueById.set(entity.id as UUID, entity);
          }
          const deduped = Array.from(uniqueById.values());
          if (deduped.length === 0) return deduped.map((e) => e.id as UUID);

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
                `[eliza] createEntities precheck failed; proceeding with guarded insert: ${formatError(err)}`,
              );
            }
          }
          if (missing.length === 0) return deduped.map((e) => e.id as UUID);

          const result = await originalCreateEntities(missing);
          if (Array.isArray(result) ? result.length > 0 : result)
            return deduped.map((e) => e.id as UUID);

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
                  `[eliza] ensureEntityExists recovery failed for ${String(entity.id)}: ${formatError(err)}`,
                );
              }
            }
            if (allRecovered) return deduped.map((e) => e.id as UUID);
          }

          logger.warn(
            `[eliza] createEntities unresolved after guarded retries (requested=${entities.length}, deduped=${deduped.length}, missing=${missing.length})`,
          );
          return [];
        });
      };
    }

    runtimeWithBindings.__elizaEntityWriteDiagnosticsInstalled = true;
  }

  runtimeWithBindings.__elizaMethodBindingsInstalled = true;
}

function installActionAliases(runtime: AgentRuntime): void {
  const runtimeWithAliases = runtime as RuntimeWithActionAliases;
  if (runtimeWithAliases.__elizaActionAliasesInstalled) {
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
      "[eliza] Disabled manual COMPACT_SESSION action; auto-compaction remains enabled",
    );
  }

  // Compatibility alias: older prompts/docs still reference CODE_TASK,
  // while agent-orchestrator exposes START_CODING_TASK.
  const codingTaskAction =
    actions.find(
      (action) => action?.name?.toUpperCase() === "START_CODING_TASK",
    ) ??
    actions.find((action) => action?.name?.toUpperCase() === "CREATE_TASK");
  if (codingTaskAction) {
    const similes = Array.isArray(codingTaskAction.similes)
      ? codingTaskAction.similes
      : [];
    const hasCodeTaskAlias = similes.some(
      (simile) => simile.toUpperCase() === "CODE_TASK",
    );
    if (!hasCodeTaskAlias) {
      codingTaskAction.similes = [...similes, "CODE_TASK"];
      logger.info(
        "[eliza] Added action alias CODE_TASK -> START_CODING_TASK for agent-orchestrator",
      );
    }
  }

  runtimeWithAliases.__elizaActionAliasesInstalled = true;
}

async function registerSqlPluginWithRecovery(
  runtime: AgentRuntime,
  sqlPlugin: RuntimeResolvedPlugin,
  config: ElizaConfig,
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
    if (recoveryAction === "fail-manual-reset") {
      throw createManualResetRequiredPgliteError(pgliteDataDir, registerError);
    }

    logger.warn(
      `[eliza] SQL plugin registration failed (${formatError(registerError)}). Cleared a stale PGLite lock in ${pgliteDataDir} and retrying without resetting data.`,
    );

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

export {
  buildCharacterFromConfig,
  resolvePreferredProviderId,
  resolvePreferredProviderPluginName,
  resolvePrimaryModel,
};

/**
 * Vision is a heavy optional plugin. When Eliza enables it, keep the service
 * loaded but idle until the user explicitly selects CAMERA, SCREEN, or BOTH.
 * This avoids background capture loops during normal app startup.
 */
export function resolveVisionModeSetting(
  config: ElizaConfig,
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  const explicitMode = env.VISION_MODE?.trim();
  if (explicitMode) return explicitMode;
  if (config.features?.vision === true) return "OFF";
  return undefined;
}

/** @internal Exported for testing. */
export function resolveWalletRuntimeSettings(
  config?: Partial<ElizaConfig>,
  env: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  const directRpcUrl = trimEnvString(env.SOLANA_RPC_URL);
  const solanaNoActions = trimEnvString(env.SOLANA_NO_ACTIONS);
  const configEnv = config?.env as
    | (Record<string, unknown> & { vars?: Record<string, unknown> })
    | undefined;
  const configVars =
    configEnv?.vars &&
    typeof configEnv.vars === "object" &&
    !Array.isArray(configEnv.vars)
      ? (configEnv.vars as Record<string, unknown>)
      : undefined;
  const getConfigEnvString = (key: string): string | undefined => {
    const value = configVars?.[key] ?? configEnv?.[key];
    return typeof value === "string" && value.trim() ? value.trim() : undefined;
  };
  const explicitSolanaPublicKey =
    trimEnvString(env.SOLANA_PUBLIC_KEY) ??
    trimEnvString(env.WALLET_PUBLIC_KEY) ??
    getConfigEnvString("SOLANA_PUBLIC_KEY") ??
    getConfigEnvString("WALLET_PUBLIC_KEY");
  const derivedSolanaPublicKey =
    trimEnvString(getWalletAddresses().solanaAddress) ??
    trimEnvString(
      syncSolanaPublicKeyEnv(getConfigEnvString("SOLANA_PRIVATE_KEY")),
    );
  const solanaPublicKey = explicitSolanaPublicKey ?? derivedSolanaPublicKey;

  const settings: Record<string, string> = {};

  if (directRpcUrl) {
    settings.SOLANA_RPC_URL = directRpcUrl;
  }

  if (solanaNoActions) {
    settings.SOLANA_NO_ACTIONS = solanaNoActions;
  }

  if (!solanaPublicKey) {
    return settings;
  }

  settings.SOLANA_PUBLIC_KEY = solanaPublicKey;
  settings.WALLET_PUBLIC_KEY = solanaPublicKey;

  return settings;
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
   * When true, require an existing ~/.eliza/eliza.json config file.
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
      "No config found. Run `eliza start` once to complete setup.",
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
        .sendMessageToTarget({ roomId: entry.roomId as UUID } as TargetInfo, {
          text: `\`\`\`\n${content}\n\`\`\``,
          source: "system",

          isLog: "true",
        })
        .catch((err) => {
          logger.debug(
            `[runtime] failed to send log message to target: ${err}`,
          );
        });
    }
  }
};

/**
 * Start the elizaOS runtime with Eliza's configuration.
 *
 * In headless mode the runtime is returned instead of entering the
 * interactive readline loop.
 */
export async function startEliza(
  opts?: StartElizaOptions,
): Promise<AgentRuntime | undefined> {
  // Start buffering logs early so startup messages appear in the UI log viewer
  const { captureEarlyLogs } = await import("../api/early-logs.js");
  captureEarlyLogs();

  // Register log listener for chat mirroring
  addLogListener(logToChatListener);

  // 1. Load Eliza config from ~/.eliza/eliza.json
  let config: ElizaConfig;
  try {
    config = loadElizaConfig();
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      logger.warn("[eliza] No config found, using defaults");
      // All ElizaConfig fields are optional, so an empty object is
      // structurally valid. The `as` cast is safe here.
      config = {} as ElizaConfig;
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

  // 2e. Boot-time vault hydration. Migrate plaintext sensitive values from
  // eliza.json + config.env + sensitive process.env keys into the OS-keychain
  // vault, then resolve any vault://KEY sentinels in `config.env` so the
  // legacy hydration loop below sees real values.
  {
    try {
      const { hydrateWalletKeysFromNodePlatformSecureStore } = await import(
        "@elizaos/app-core"
      );
      await hydrateWalletKeysFromNodePlatformSecureStore();
    } catch (err) {
      logger.warn(
        `[wallet][os-store] boot hydrate skipped: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    const { runVaultBootstrap } = await import(
      "@elizaos/app-core"
    );
    const { sharedVault } = await import(
      "@elizaos/app-core"
    );
    const bootResult = await runVaultBootstrap();
    logger.info(
      `[vault-bootstrap] migrated=${bootResult.migrated} failed=${bootResult.failed.length}`,
    );

    const { resolved, missing } = await resolveConfigEnvForProcess(
      config.env as Record<string, unknown> | undefined,
      sharedVault(),
    );
    if (missing.length > 0) {
      logger.warn(
        `[vault-bootstrap] sentinel(s) without vault entry: ${missing.join(", ")}`,
      );
    }
    if (
      config.env &&
      typeof config.env === "object" &&
      !Array.isArray(config.env)
    ) {
      for (const [key, value] of Object.entries(resolved)) {
        (config.env as Record<string, unknown>)[key] = value;
      }
    }
    const varsBag = (config.env as Record<string, unknown> | undefined)?.vars;
    if (varsBag && typeof varsBag === "object" && !Array.isArray(varsBag)) {
      const varsResult = await resolveConfigEnvForProcess(
        varsBag as Record<string, unknown>,
        sharedVault(),
      );
      for (const [key, value] of Object.entries(varsResult.resolved)) {
        (varsBag as Record<string, unknown>)[key] = value;
      }
    }
  }

  // 2f. Propagate arbitrary env vars from config.env into process.env.
  // Eliza stores user-defined env vars (plugin settings, API URLs, etc.)
  // in config.env; elizaOS plugins read them via process.env / getSetting.
  // Skip ELIZAOS_CLOUD_* — applyCloudConfigToEnv() owns those; otherwise a
  // stale key in config.env refills process.env after disconnect cleared it.
  if (
    config.env &&
    typeof config.env === "object" &&
    !Array.isArray(config.env)
  ) {
    for (const [key, value] of Object.entries(config.env)) {
      if (isElizaCloudManagedProcessEnvKey(key)) continue;
      if (typeof value === "string" && !process.env[key]) {
        process.env[key] = value;
      }
    }
    // Also hydrate from config.env.vars — setEnvValue writes API keys to
    // both config.env["KEY"] and config.env.vars["KEY"]. If the top-level
    // key was lost (e.g. pruneEnv, config migration), the nested form is
    // the authoritative source.
    const vars = (config.env as Record<string, unknown>).vars;
    if (vars && typeof vars === "object" && !Array.isArray(vars)) {
      for (const [key, value] of Object.entries(
        vars as Record<string, unknown>,
      )) {
        if (isElizaCloudManagedProcessEnvKey(key)) continue;
        if (typeof value === "string" && !process.env[key]) {
          process.env[key] = value;
        }
      }
    }
  }

  // Keep the canonical public key env in sync for Solana plugins that still
  // read process.env directly instead of runtime settings.
  syncSolanaPublicKeyEnv();

  normalizeOpenAiCompatibleProviderConfig(config);

  // Log active database configuration for debugging persistence issues
  {
    const dbProvider = config.database?.provider ?? "pglite";
    const pgliteDir = process.env.PGLITE_DATA_DIR;
    const postgresUrl = process.env.POSTGRES_URL;
    logger.info(
      `[eliza] Database provider: ${dbProvider}` +
        (dbProvider === "pglite" && pgliteDir
          ? ` | data dir: ${pgliteDir}`
          : "") +
        (dbProvider === "postgres" && postgresUrl
          ? ` | connection: ${(postgresUrl.length > 4096 ? postgresUrl.slice(0, 4096) : postgresUrl).replace(/:\/\/([^:@]{1,1024}):([^@]{1,1024})@/, "://$1:***@")}`
          : ""),
    );
  }

  // 2d-iii. OG tracking code initialization
  if (!isMobilePlatform()) {
    try {
      const { initializeOGCode } = await loadElizaMakerModule();
      initializeOGCode?.();
    } catch {
      // Silent — OG tracking is non-critical
    }
  }

  // 2d-ii. Allow destructive migrations (e.g. dropping tables removed between
  //        plugin versions) so the runtime doesn't silently stall.  Without this
  //        the migration system throws an error that gets swallowed, leaving the
  //        app hanging indefinitely with no output.
  if (!process.env.ELIZA_ALLOW_DESTRUCTIVE_MIGRATIONS) {
    process.env.ELIZA_ALLOW_DESTRUCTIVE_MIGRATIONS = "true";
  }

  // 2e-ii. SECRET_SALT must be stable across boots — multiple consumers key
  //        durable encryption off it (core/settings.ts encryptStringValue,
  //        encryptedCharacter for character.secrets, runtime.ts decryptSecret,
  //        advanced-capabilities settings). Previously we generated a random
  //        value per process, which silently invalidated every persisted
  //        ciphertext on restart (decryptStringValue returns the encrypted
  //        string on failure, so connector logins just stopped working
  //        without an error). Persist to <stateDir>/secret-salt instead.
  if (!process.env.SECRET_SALT) {
    const secretSaltPath = path.join(resolveStateDir(), "secret-salt");
    let salt: string | null = null;
    try {
      const cached = readFileSync(secretSaltPath, "utf8").trim();
      if (/^[0-9a-f]{64}$/.test(cached)) {
        salt = cached;
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
        throw err;
      }
    }
    if (!salt) {
      salt = crypto.randomBytes(32).toString("hex");
      mkdirSync(path.dirname(secretSaltPath), { recursive: true });
      // 0o600: only the user account that wrote it can read it. The salt
      // is a key-derivation input — anyone who reads it plus the
      // ciphertext can decrypt persisted secrets.
      writeFileSync(secretSaltPath, salt, { encoding: "utf8", mode: 0o600 });
      logger.info(
        `[eliza] Generated SECRET_SALT and persisted to ${secretSaltPath}`,
      );
    }
    process.env.SECRET_SALT = salt;
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
        `[eliza] ${gkey} appears invalid (length/format), clearing to skip Google AI plugin`,
      );
      delete process.env[gkey];
    }
  }

  // 2f. Install the multi-account pool shims and apply selected direct API
  //     accounts before plugin resolution snapshots process.env.
  try {
    const accountPool = await import("@elizaos/app-core");
    accountPool.getDefaultAccountPool();
    await accountPool.applyAccountPoolApiCredentials({
      activeBackend: resolveServiceRoutingInConfig(
        config as Record<string, unknown>,
      )?.llmText?.backend,
      accountStrategies: (
        config as Record<string, unknown> & {
          accountStrategies?: Record<string, unknown>;
        }
      ).accountStrategies,
      serviceRouting: resolveServiceRoutingInConfig(
        config as Record<string, unknown>,
      ),
    });
    accountPool.startAccountPoolKeepAlive();
  } catch (err) {
    logger.debug(`[eliza] Account pool bootstrap skipped: ${formatError(err)}`);
  }

  // 2g. Apply subscription-based credentials (Claude Max, Codex Max).
  //     Failure is non-fatal — the agent can still start with other providers.
  //     Config is NOT rolled back on failure; partial mutations may persist in
  //     the in-memory config but are not saved to disk until explicit save.
  try {
    const { applySubscriptionCredentials } = await import("../auth/index.js");
    await applySubscriptionCredentials(config);
  } catch (err) {
    logger.warn(
      `[eliza] Failed to apply subscription credentials (agent will continue without them): ${formatError(err)}`,
    );
  }

  // 2h. Cloud mode — if the user chose cloud during onboarding (or on a
  //     subsequent start with cloud config), skip local runtime setup and
  //     connect via the thin client instead.
  const deploymentTarget = resolveDeploymentTargetInConfig(
    config as Record<string, unknown>,
  );
  if (
    deploymentTarget.runtime === "cloud" &&
    deploymentTarget.provider === "elizacloud" &&
    config.cloud?.apiKey &&
    config.cloud?.agentId?.trim()
  ) {
    return startInCloudMode(config, config.cloud.agentId, opts);
  }

  // 2i. Pump N8N_HOST + N8N_API_KEY into process.env for
  //     @elizaos/plugin-n8n-workflow. Must run BEFORE
  //     buildCharacterFromConfig — that function snapshots
  //     `process.env.N8N_*` into character.secrets, which is what
  //     `runtime.getSetting()` reads. Setting env after the snapshot would
  //     leave the plugin with empty credentials.
  await applyN8nConfigToEnv(
    config,
    config.cloud?.agentId?.trim() ?? "milady-runtime",
  );

  // 3. Build elizaOS Character from Eliza config
  const character = buildCharacterFromConfig(config);

  const primaryModel = resolvePrimaryModel(config);
  const preferredProviderId = resolvePreferredProviderId(config);
  const preferredProviderPluginName =
    resolvePreferredProviderPluginName(config);

  // 4. Ensure workspace exists with required files
  const workspaceDir =
    config.agents?.defaults?.workspace ?? resolveDefaultAgentWorkspaceDir();
  await ensureAgentWorkspace({
    dir: workspaceDir,
    ensureInitFiles: shouldBootstrapWorkspaceInitFiles(workspaceDir),
  });

  // 4b. Ensure custom plugins directory exists for drop-in plugins
  await fs.mkdir(path.join(resolveStateDir(), CUSTOM_RUNTIME_PLUGINS_DIRNAME), {
    recursive: true,
  });

  // 5. Create the Eliza bridge plugin (workspace context + session keys + compaction)
  const agentId = character.name?.toLowerCase().replace(/\s+/g, "-") ?? "main";

  // 5-pre0. Apply per-agent vault profile overrides to process.env.
  //
  // Vault keys with multiple named profiles (work / personal / throwaway)
  // resolve the active profile for THIS agent through the vault's
  // routing layer, then write the resolved value into process.env so
  // the synchronous runtime.getSetting fast path picks it up. Idempotent;
  // safe to run multiple times. Opt-out via
  // ELIZA_DISABLE_VAULT_PROFILE_RESOLVER=1.
  if (process.env.ELIZA_DISABLE_VAULT_PROFILE_RESOLVER !== "1") {
    try {
      const { sharedVault } = await import(
        "@elizaos/app-core"
      );
      const { applyVaultProfilesForAgent } = await import(
        "./vault-profile-resolver.js"
      );
      await applyVaultProfilesForAgent(sharedVault(), agentId);
    } catch (err) {
      logger.warn(
        `[vault-profile-resolver] boot-time apply failed agent="${agentId}": ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  // 5-pre. Ensure each agent has its own EVM + Solana keypair in the vault.
  // The runtime-wide EVM_PRIVATE_KEY / SOLANA_PRIVATE_KEY (process.env) is
  // the *user* wallet; per-agent wallets live inside the encrypted vault and
  // are surfaced separately in the in-app browser. Idempotent — existing
  // wallets are preserved. Opt-out via ELIZA_DISABLE_AGENT_WALLET_BOOTSTRAP=1.
  if (process.env.ELIZA_DISABLE_AGENT_WALLET_BOOTSTRAP !== "1") {
    try {
      const { sharedVault } = await import(
        "@elizaos/app-core"
      );
      const { ensureAgentWallets } = await import("./agent-wallets.js");
      const descriptors = await ensureAgentWallets(
        sharedVault(),
        agentId,
        "agent-bootstrap",
      );
      const summary = descriptors
        .map((d) => `${d.chain}:${d.address}`)
        .join(" ");
      logger.info(
        `[agent-wallets] agent="${agentId}" wallets ready (${summary})`,
      );
    } catch (err) {
      logger.warn(
        `[agent-wallets] failed to ensure wallets for agent="${agentId}": ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  // 5a. If cloud is configured and no local GitHub token, try fetching from cloud
  await autoFetchCloudGithubToken(config.cloud?.agentId?.trim() || agentId);

  // 5b. (n8n env pump moved to step 2h, before buildCharacterFromConfig —
  //     character.secrets is snapshotted from process.env at character-build
  //     time, so the env must be populated before that runs.)

  const elizaPlugin = createElizaPlugin({
    workspaceDir,

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
        "[eliza] No plugins loaded yet — the onboarding wizard will configure a model provider",
      );
    } else {
      logger.error(
        "[eliza] No plugins loaded — at least one model provider plugin is required",
      );
      logger.error(
        "[eliza] Set an API key (e.g. ANTHROPIC_API_KEY, OPENAI_API_KEY) in your environment",
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
      preferredProvider: preferredProviderId ?? "(auto-detect)",
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
        `[eliza] Context validation issues detected: ${issues.join("; ")}`,
      );
    }
  }

  // 7. Create the AgentRuntime with Eliza plugin + resolved plugins
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
    // LOG_LEVEL=error override set by eliza/packages/app-core/scripts/dev-ui.mjs.
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
    logger.info(`[eliza] Bundled skills dir: ${bundledSkillsDir}`);
  } catch {
    logger.debug(
      "[eliza] @elizaos/skills not available — bundled skills will not be loaded",
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
    logger.info(`[eliza] Sandbox mode: ${sandboxMode}`);
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
        logger.info("[eliza] Sandbox manager started");
      } catch (err) {
        logger.error(
          `[eliza] Sandbox manager failed to start: ${err instanceof Error ? err.message : String(err)}`,
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

  // ── Boost preferred provider plugin priority ──────────────────────────
  // elizaOS selects the model handler with the highest `priority` for each
  // ModelType.  All provider plugins default to priority 0, so whichever
  // registers first wins — essentially random when using Promise.all.
  // When the user has explicitly selected a provider or model, prefer that
  // provider's plugin so its handlers are selected over registration order.
  const pluginsForRuntime = otherPlugins.map((p) => p.plugin);
  const visionModeSetting = resolveVisionModeSetting(config);
  if (preferredProviderPluginName) {
    for (const plugin of pluginsForRuntime) {
      if (plugin.name === preferredProviderPluginName) {
        plugin.priority = (plugin.priority ?? 0) + 10;
        logger.info(
          `[eliza] Boosted plugin "${plugin.name}" priority to ${plugin.priority} (preferred provider: ${preferredProviderId ?? "unknown"})`,
        );
        break;
      }
    }
  }

  // ── Strip upstream skill providers ──────────────────────────────────────
  // The upstream @elizaos/plugin-agent-skills registers providers that dump
  // ALL loaded skills into every prompt (~2000-4000 tokens).  Eliza replaces
  // them with a BM25-lite dynamic provider (see providers/skill-provider.ts)
  // that injects only the most relevant skills per turn.
  //
  // We keep:
  //   - agent_skills_overview  (lightweight stats, ~50 tokens)
  //   - all actions (USE_SKILL, SEARCH_SKILLS, INSTALL_SKILL, …)
  //   - the AGENT_SKILLS_SERVICE itself
  {
    const UPSTREAM_SKILL_PROVIDERS_TO_STRIP = new Set([
      "agent_skills",
      "agent_skill_instructions",
      "agent_skills_catalog",
    ]);
    for (const plugin of pluginsForRuntime) {
      if (
        plugin.name === "@elizaos/plugin-agent-skills" &&
        Array.isArray(plugin.providers)
      ) {
        const before = plugin.providers.length;
        plugin.providers = plugin.providers.filter(
          (p: { name?: string }) =>
            !UPSTREAM_SKILL_PROVIDERS_TO_STRIP.has(p.name ?? ""),
        );
        const removed = before - plugin.providers.length;
        if (removed > 0) {
          logger.info(
            `[eliza] Stripped ${removed} upstream skill provider(s) — using dynamic BM25-lite provider instead`,
          );
        }
      }
    }
  }

  // Deduplicate actions across all plugins to avoid "Action already registered"
  // warnings from elizaOS core. basic-capabilities is registered first by the
  // runtime, so include it in deduplication so its actions take precedence.
  const settings = character.settings ?? {};
  const basicCapabilitiesPlugin = createBasicCapabilitiesPlugin({
    disableBasic:
      settings.DISABLE_BASIC_CAPABILITIES === true ||
      settings.DISABLE_BASIC_CAPABILITIES === "true",
    enableExtended:
      settings.ENABLE_EXTENDED_CAPABILITIES === true ||
      settings.ENABLE_EXTENDED_CAPABILITIES === "true" ||
      settings.ADVANCED_CAPABILITIES === true ||
      settings.ADVANCED_CAPABILITIES === "true",
    skipCharacterProvider: false,
    enableAutonomy:
      settings.ENABLE_AUTONOMY === true || settings.ENABLE_AUTONOMY === "true",
  });
  deduplicatePluginActions([
    basicCapabilitiesPlugin,
    elizaPlugin,
    ...pluginsForRuntime,
  ]);

  let runtime = new AgentRuntime({
    character,
    // advancedCapabilities: true,
    actionPlanning: true,
    // advancedMemory is enabled via character.advancedMemory
    plugins: [elizaPlugin, ...pluginsForRuntime],
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
      // Forward non-sensitive Eliza config.env vars as runtime settings so
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
      // Forward connector config vars as-is. The connector env map is curated
      // and plugins need access to secrets like passwords and tokens via
      // runtime.getSetting() for real transports to boot.
      ...collectConnectorEnvVars(config),
      // Forward Eliza config env vars as runtime settings
      ...(preferredProviderId ? { MODEL_PROVIDER: preferredProviderId } : {}),
      ...(visionModeSetting ? { VISION_MODE: visionModeSetting } : {}),
      ...resolveWalletRuntimeSettings(config),
      ...(typeof config.agents?.defaults?.adminEntityId === "string" &&
      config.agents.defaults.adminEntityId.trim().length > 0
        ? {
            ELIZA_ADMIN_ENTITY_ID: config.agents.defaults.adminEntityId.trim(),
          }
        : {}),
      ...(config.agents?.defaults?.ownerContacts
        ? {
            ELIZA_OWNER_CONTACTS_JSON: JSON.stringify(
              config.agents.defaults.ownerContacts,
            ),
          }
        : {}),
      ...(config.roles?.connectorAdmins
        ? {
            ELIZA_ROLES_CONNECTOR_ADMINS_JSON: JSON.stringify(
              config.roles.connectorAdmins,
            ),
          }
        : {}),
      // Forward skills config so plugin-agent-skills can apply allow/deny filtering
      ...(config.skills?.allowBundled
        ? { SKILLS_ALLOWLIST: config.skills.allowBundled.join(",") }
        : {}),
      ...(config.skills?.denyBundled
        ? { SKILLS_DENYLIST: config.skills.denyBundled.join(",") }
        : {}),
      // Managed skills are stored in the Eliza state dir (~/.eliza/skills).
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

  // 7a. Mobile local inference must be registered before runtime.initialize().
  // Runtime services probe TEXT_EMBEDDING during init; registering the local
  // handler only after startEliza() returns leaves mobile local mode booting
  // with "no provider" diagnostics and disabled embedding services.
  if (process.env.ELIZA_LOCAL_LLAMA?.trim() === "1") {
    try {
      const { ensureAospLocalInferenceHandlers } = await import(
        "./aosp-local-inference-bootstrap.js"
      );
      await ensureAospLocalInferenceHandlers(runtime);
    } catch (err) {
      logger.warn(
        `[eliza] AOSP local inference pre-registration skipped: ${formatError(err)}`,
      );
    }
  } else if (process.env.ELIZA_DEVICE_BRIDGE_ENABLED?.trim() === "1") {
    try {
      const { ensureMobileDeviceBridgeInferenceHandlers } = await import(
        "./mobile-device-bridge-bootstrap.js"
      );
      await ensureMobileDeviceBridgeInferenceHandlers(runtime);
    } catch (err) {
      logger.warn(
        `[eliza] Mobile device bridge pre-registration skipped: ${formatError(err)}`,
      );
    }
  }

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
      `[eliza] @elizaos/plugin-sql was NOT found among resolved plugins. ` +
        `Loaded: [${loadedNames}]`,
    );
    throw new Error(
      "@elizaos/plugin-sql is required but was not loaded. " +
        "Ensure the package is installed and built (check for import errors above).",
    );
  }

  // 7d. Pre-register plugin-local-embedding so its TEXT_EMBEDDING handler
  //     (priority 10) is available before runtime.initialize() starts all
  //     plugins in parallel.  Without this, the basic-capabilities plugin's services
  //     (ActionFilterService, EmbeddingGenerationService) race ahead and use
  //     the cloud plugin's TEXT_EMBEDDING handler — which hits a paid API —
  //     because local-embedding's heavier init hasn't completed yet.
  if (localEmbeddingPlugin) {
    configureLocalEmbeddingPlugin(localEmbeddingPlugin.plugin, config);
    await runtime.registerPlugin(localEmbeddingPlugin.plugin);
    logger.info(
      "[eliza] plugin-local-embedding pre-registered (TEXT_EMBEDDING ready)",
    );
  } else {
    logger.warn(
      "[eliza] @elizaos/plugin-local-embedding not found — embeddings " +
        "will fall back to whatever TEXT_EMBEDDING handler is registered by " +
        "other plugins (may incur cloud API costs)",
    );
  }

  // 7e. Pre-register remaining core plugins sequentially in CORE_PLUGINS order.
  //     Each registerPlugin() call runs the plugin's init() before proceeding
  //     to the next, guaranteeing that cross-plugin getService() calls resolve.
  {
    try {
      logger.info("[eliza] Pre-registering roles capability...");
      await runtime.registerPlugin(rolesPlugin);
      logger.info("[eliza] ✓ roles capability pre-registered");
    } catch (err) {
      logger.warn(
        `[eliza] Roles capability pre-registration failed: ${formatError(err)}`,
      );
    }

    const alreadyPreRegistered = new Set([
      "@elizaos/plugin-sql",
      "@elizaos/plugin-local-embedding",
    ]);
    for (const name of CORE_PLUGINS) {
      if (alreadyPreRegistered.has(name)) continue;
      const resolved = resolvedPlugins.find((p) => p.name === name);
      if (!resolved) {
        logger.debug(
          `[eliza] Core plugin ${name} not resolved — skipping pre-registration`,
        );
        continue;
      }
      try {
        const regStart = Date.now();
        logger.info(`[eliza] Pre-registering core plugin: ${name}...`);
        const PLUGIN_REG_TIMEOUT_MS = 30_000;
        await Promise.race([
          runtime.registerPlugin(resolved.plugin),
          new Promise<never>((_resolve, reject) =>
            setTimeout(
              () =>
                reject(
                  new Error(`Timed out after ${PLUGIN_REG_TIMEOUT_MS / 1000}s`),
                ),
              PLUGIN_REG_TIMEOUT_MS,
            ),
          ),
        ]);
        logger.info(
          `[eliza] ✓ ${name} pre-registered (${Date.now() - regStart}ms)`,
        );
      } catch (err) {
        logger.warn(
          `[eliza] Core plugin ${name} pre-registration failed: ${formatError(err)}`,
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
          `[eliza] AgentSkills ready — ${stats.loaded} skills loaded, ` +
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
        logger.debug("[eliza] Patched getLoadedSkills to guard descriptions");
      }
    } catch (err) {
      // Non-fatal — the agent can operate without skills. This warm-up runs
      // async so it doesn't block startup.
      logger.debug(`[eliza] AgentSkillsService warm-up: ${formatError(err)}`);
    }
  };

  const initializeRuntimeServices = async (): Promise<void> => {
    if (process.env.ELIZA_LEGACY_STEWARD_EVM_BRIDGE !== "0") {
      try {
        const { stewardEvmPreBoot } = await loadStewardEvmBridgeModule();
        await stewardEvmPreBoot?.(runtime);
      } catch (err) {
        logger.debug(
          `[eliza] Steward EVM pre-boot skipped: ${formatError(err)}`,
        );
      }
    }

    // 7f. Pre-register ConnectorSetupService so connector plugins can access
    //     shared config/escalation/owner-contact helpers via runtime.getService().
    try {
      const { ConnectorSetupService } = await import(
        "../services/connector-setup-service.js"
      );
      await runtime.registerService(ConnectorSetupService);
    } catch (err) {
      logger.debug(
        `[eliza] ConnectorSetupService registration skipped: ${formatError(err)}`,
      );
    }

    // 8. Initialize the runtime (registers remaining plugins, starts services)
    assertPersistentDatabaseRequired(runtime);
    await runtime.initialize();
    await prepareRuntimeForTrajectoryCapture(
      runtime,
      "runtime.initialize()",
      config,
    );

    // 8a. Apply legacy role redaction to protected plugin providers.
    try {
      const { applyPluginRoleGating } = await import("./plugin-role-gating.js");
      applyPluginRoleGating(runtime.plugins ?? []);
    } catch (err) {
      logger.debug(
        `[eliza] Plugin provider role gating skipped: ${formatError(err)}`,
      );
    }

    // 8b. Register lightweight conversation-proximity post-message hook.
    // Updates relationship strength when people post near each other in a room.
    // No LLM calls — deterministic, runs on every message.
    try {
      const { updateProximityRelationships } = await import(
        "../services/conversation-proximity.js"
      );
      const { ActionMode } = await import("@elizaos/core");
      await runtime.registerPlugin({
        name: "eliza-conversation-proximity",
        description:
          "Lightweight relationship updates from conversation co-occurrence",
        actions: [
          {
            name: "CONVERSATION_PROXIMITY",
            description:
              "Update relationship strength for co-participants in a room",
            similes: [],
            examples: [],
            mode: ActionMode.ALWAYS_AFTER,
            modePriority: 100,
            validate: async (_runtime, message) => {
              const text = (message.content as { text?: string })?.text;
              return Boolean(text) && message.entityId !== _runtime.agentId;
            },
            handler: async (_runtime, message) => {
              await updateProximityRelationships(_runtime, message);
              return undefined;
            },
          },
        ],
      });
      logger.info("[eliza] ✓ conversation-proximity hook registered");
    } catch (err) {
      logger.debug(
        `[eliza] Conversation-proximity hook skipped: ${formatError(err)}`,
      );
    }

    try {
      if (runtimeDocumentsEnabled(runtime)) {
        await seedBundledDocuments(runtime);
      } else {
        logger.info(
          "[eliza] Native documents disabled; skipping bundled document seeding",
        );
      }
    } catch (err) {
      logger.warn(
        `[eliza] Failed to seed bundled documents: ${formatError(err)}`,
      );
    }

    if (process.env.ELIZA_LEGACY_STEWARD_EVM_BRIDGE !== "0") {
      try {
        const { stewardEvmPostBoot } = await loadStewardEvmBridgeModule();
        await stewardEvmPostBoot?.(runtime);
      } catch (err) {
        logger.debug(
          `[eliza] Steward EVM post-boot skipped: ${formatError(err)}`,
        );
      }
    }

    try {
      const { installAnthropicWebSearch } = await import(
        "./web-search-tools.js"
      );
      installAnthropicWebSearch(runtime);
    } catch (err) {
      logger.debug(
        `[eliza] Anthropic web search setup skipped: ${formatError(err)}`,
      );
    }

    // 8b. Ensure AutonomyService is available for trigger dispatch.
    // registers this service) from loading, so we start it explicitly.
    // Respect ENABLE_AUTONOMY env var — cloud-provisioned containers may
    // disable this to prevent runaway autonomous actions.
    const autonomyEnabled =
      (process.env.ENABLE_AUTONOMY ?? "true").toLowerCase() !== "false";

    if (autonomyEnabled && !runtime.getService("AUTONOMY")) {
      try {
        await startAndRegisterAutonomyService(runtime);
        logger.info("[eliza] AutonomyService started for trigger dispatch");
      } catch (err) {
        logger.warn(
          `[eliza] AutonomyService failed to start: ${formatError(err)}`,
        );
      }
    } else if (!autonomyEnabled) {
      logger.info("[eliza] AutonomyService skipped — ENABLE_AUTONOMY=false");
    }

    // Enable the autonomy loop so trigger/heartbeat instructions are
    // actually processed. Without this, memories created by
    // dispatchInstruction() sit in the DB and are never acted on.
    if (autonomyEnabled) {
      const autonomySvc = getAutonomyService(runtime);
      if (autonomySvc) {
        try {
          await autonomySvc.enableAutonomy();
          logger.info(
            "[eliza] AutonomyService enabled — trigger instructions will be processed",
          );
        } catch (err) {
          logger.warn(
            `[eliza] Failed to enable autonomy loop: ${formatError(err)}`,
          );
        }
      }
    }

    // Do not block runtime startup on skills warm-up.
    void warmAgentSkillsService().catch((err) => {
      logger.warn(`[eliza] Skills warm-up failed: ${formatError(err)}`);
    });
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
    if (recoveryAction === "fail-manual-reset") {
      throw createManualResetRequiredPgliteError(pgliteDataDir, err);
    }

    logger.warn(
      `[eliza] Runtime migrations failed (${formatError(err)}). Cleared a stale PGLite lock in ${pgliteDataDir} and retrying startup once without resetting data.`,
    );
    try {
      await shutdownRuntime(runtime, "PGLite recovery");
    } catch {
      // Ignore cleanup errors — retry creates a fresh runtime anyway.
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
    registerSignalShutdownHandlers({
      getRuntime: () => runtime,
      getSandboxManager: () => sandboxManager,
    });
  }

  const loadHooksSystem = async (): Promise<void> => {
    try {
      const internalHooksConfig = config.hooks
        ?.internal as LoadHooksOptions["internalConfig"];

      await loadHooks({
        workspacePath: workspaceDir,
        internalConfig: internalHooksConfig,
        elizaConfig: config as Record<string, unknown>,
      });

      const startupEvent = createHookEvent("gateway", "startup", "system", {
        cfg: config,
      });
      await triggerHook(startupEvent);
    } catch (err) {
      logger.warn(`[eliza] Hooks system could not load: ${formatError(err)}`);
    }
  };

  // ── Headless mode — return runtime for API server wiring ──────────────
  if (opts?.headless) {
    void loadHooksSystem().catch((err) => {
      logger.warn(`[eliza] Hooks system load failed: ${formatError(err)}`);
    });
    logger.info(
      "[eliza] Runtime initialised in headless mode (autonomy enabled)",
    );
    return runtime;
  }

  // 10. Load hooks system
  await loadHooksSystem();

  // ── Start API server for GUI access ──────────────────────────────────────
  // In CLI mode (non-headless), start the API server in the background so
  // the GUI can connect to the running agent.  This ensures full feature
  // parity: whether started via `npx elizaos`, `bun run dev`, or the
  // desktop app, the API server is always available for the GUI admin
  // surface.
  try {
    const { startApiServer } = await import("../api/server.js");
    const apiPort = resolveServerOnlyPort(process.env);
    const { port: actualApiPort } = await startApiServer({
      port: apiPort,
      runtime,
      onRestart: async () => {
        logger.info("[eliza] Hot-reload: Restarting runtime...");
        try {
          // Stop the old runtime to release resources (DB connections, timers, etc.)
          //
          // WHY the 2s timeout: some services — notably PTYService —
          // shut down gracefully by awaiting each active session with a
          // per-session timeout (up to ~5s). runtime.stop() awaits every
          // service.stop() sequentially, so a single idle PTY session
          // turns a provider switch into a multi-second block. During
          // that window the runtime-operations active-op slot +
          // agentState === "restarting" guard reject further clicks,
          // which is why flipping through providers rapidly feels stuck.
          //
          // Cap the shutdown window at 2s; if it doesn't finish, log and
          // bring the new runtime up anyway. Services that miss the
          // window get GC'd when the process unwinds. This is fine for a
          // user-initiated restart — the user asked for a new runtime;
          // in-flight work on the old one is already obsolete.
          try {
            const SHUTDOWN_TIMEOUT_MS = 2000;
            let shutdownTimedOut = false;
            await Promise.race([
              shutdownRuntime(runtime, "hot-reload cleanup"),
              new Promise<void>((resolve) =>
                setTimeout(() => {
                  shutdownTimedOut = true;
                  resolve();
                }, SHUTDOWN_TIMEOUT_MS),
              ),
            ]);
            if (shutdownTimedOut) {
              logger.warn(
                `[eliza] Hot-reload: old runtime shutdown exceeded ${SHUTDOWN_TIMEOUT_MS}ms; proceeding with new runtime`,
              );
            }
          } catch (stopErr) {
            logger.warn(
              `[eliza] Hot-reload: old runtime stop failed: ${formatError(stopErr)}`,
            );
          }

          // Reload config from disk (updated by API)
          const freshConfig = loadElizaConfig();

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
          await applyN8nConfigToEnv(
            freshConfig,
            freshConfig.cloud?.agentId?.trim() || agentId,
          );
          await autoFetchCloudGithubToken(
            freshConfig.cloud?.agentId?.trim() || agentId,
          );

          try {
            const accountPool = await import("@elizaos/app-core");
            accountPool.getDefaultAccountPool();
            await accountPool.applyAccountPoolApiCredentials({
              activeBackend: resolveServiceRoutingInConfig(
                freshConfig as Record<string, unknown>,
              )?.llmText?.backend,
              accountStrategies: (
                freshConfig as Record<string, unknown> & {
                  accountStrategies?: Record<string, unknown>;
                }
              ).accountStrategies,
              serviceRouting: resolveServiceRoutingInConfig(
                freshConfig as Record<string, unknown>,
              ),
            });
            accountPool.startAccountPoolKeepAlive();
          } catch (poolErr) {
            logger.debug(
              `[eliza] Hot-reload: account pool bootstrap skipped: ${formatError(poolErr)}`,
            );
          }

          // Apply subscription-based credentials (Claude Max, Codex Max)
          // that may have been set up during onboarding.
          try {
            const { applySubscriptionCredentials } = await import(
              "../auth/index.js"
            );
            await applySubscriptionCredentials(freshConfig);
          } catch (subErr) {
            logger.warn(
              `[eliza] Hot-reload: subscription credentials: ${formatError(subErr)}`,
            );
          }

          // Resolve plugins using same function as startup
          const resolvedPlugins = await resolvePlugins(freshConfig);

          // Rebuild character from the fresh config so onboarding changes
          // (name, bio, style, etc.) are picked up on restart.
          const freshCharacter = buildCharacterFromConfig(freshConfig);

          // Recreate Eliza plugin with fresh workspace
          const freshElizaPlugin = createElizaPlugin({
            workspaceDir:
              freshConfig.agents?.defaults?.workspace ?? workspaceDir,

            agentId:
              freshCharacter.name?.toLowerCase().replace(/\s+/g, "-") ?? "main",
          });

          // Create new runtime with updated plugins.
          // Filter out pre-registered plugins so they aren't double-loaded
          // inside initialize()'s Promise.all — same pattern as the initial
          // startup to avoid the TEXT_EMBEDDING race condition.
          const freshPreferredProviderId =
            resolvePreferredProviderId(freshConfig);
          const freshPreferredProviderPluginName =
            resolvePreferredProviderPluginName(freshConfig);
          const freshOtherPlugins = resolvedPlugins.filter(
            (p) => !PREREGISTER_PLUGINS.has(p.name),
          );
          // Boost the preferred provider plugin priority (same as initial startup)
          const freshPluginsForRuntime = freshOtherPlugins.map((p) => p.plugin);
          const freshVisionModeSetting = resolveVisionModeSetting(freshConfig);
          if (freshPreferredProviderPluginName) {
            for (const plugin of freshPluginsForRuntime) {
              if (plugin.name === freshPreferredProviderPluginName) {
                plugin.priority = (plugin.priority ?? 0) + 10;
                break;
              }
            }
          }
          const newRuntime = new AgentRuntime({
            character: freshCharacter,
            plugins: [freshElizaPlugin, ...freshPluginsForRuntime],
            ...(runtimeLogLevel ? { logLevel: runtimeLogLevel } : {}),
            settings: {
              ...(freshPreferredProviderId
                ? { MODEL_PROVIDER: freshPreferredProviderId }
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
            try {
              await newRuntime.registerPlugin(rolesPlugin);
            } catch (err) {
              logger.warn(
                `[eliza] Hot-reload: roles capability pre-registration failed: ${formatError(err)}`,
              );
            }

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
                  `[eliza] Hot-reload: core plugin ${name} pre-registration failed: ${formatError(err)}`,
                );
              }
            }
          }

          assertPersistentDatabaseRequired(newRuntime);
          try {
            const { ConnectorSetupService: CSSReload } = await import(
              "../services/connector-setup-service.js"
            );
            await newRuntime.registerService(CSSReload);
          } catch {
            // non-fatal
          }
          try {
            const { stewardEvmPreBoot: preBootHR } =
              await loadStewardEvmBridgeModule();
            await preBootHR?.(newRuntime);
          } catch {
            // non-fatal
          }
          assertPersistentDatabaseRequired(newRuntime);
          await newRuntime.initialize();
          await prepareRuntimeForTrajectoryCapture(
            newRuntime,
            "hot-reload runtime.initialize()",
            config,
          );

          try {
            const { applyPluginRoleGating } = await import(
              "./plugin-role-gating.js"
            );
            applyPluginRoleGating(newRuntime.plugins ?? []);
          } catch (err) {
            logger.debug(
              `[eliza] Hot-reload plugin provider role gating skipped: ${formatError(err)}`,
            );
          }

          try {
            const { stewardEvmPostBoot: postBootHR } =
              await loadStewardEvmBridgeModule();
            await postBootHR?.(newRuntime);
          } catch {
            // non-fatal
          }

          // Ensure AutonomyService survives hot-reload (respects ENABLE_AUTONOMY)
          const hotReloadAutonomyEnabled =
            (process.env.ENABLE_AUTONOMY ?? "true").toLowerCase() !== "false";

          if (hotReloadAutonomyEnabled && !newRuntime.getService("AUTONOMY")) {
            try {
              await startAndRegisterAutonomyService(newRuntime);
            } catch (err) {
              logger.warn(
                `[eliza] AutonomyService failed to start after hot-reload: ${formatError(err)}`,
              );
            }
          }

          // Enable the autonomy loop after hot-reload (same as initial boot)
          if (hotReloadAutonomyEnabled) {
            const svc = getAutonomyService(newRuntime);
            if (svc) {
              try {
                await svc.enableAutonomy();
              } catch (err) {
                logger.warn(
                  `[eliza] Failed to enable autonomy after hot-reload: ${formatError(err)}`,
                );
              }
            }
          }

          installActionAliases(newRuntime);
          runtime = newRuntime;
          logger.info("[eliza] Hot-reload: Runtime restarted successfully");
          return newRuntime;
        } catch (err) {
          logger.error(`[eliza] Hot-reload failed: ${formatError(err)}`);
          return null;
        }
      },
    });
    const dashboardUrl = `http://localhost:${actualApiPort}`;
    console.log(`[eliza] Control UI: ${dashboardUrl}`);
    logger.info(`[eliza] API server listening on ${dashboardUrl}`);
  } catch (apiErr) {
    // Log to both stderr (visible to Electrobun agent.ts) and the in-memory
    // logger so the error is never silently swallowed in packaged builds.
    const apiErrMsg = `[eliza] Could not start API server: ${formatError(apiErr)}`;
    console.error(apiErrMsg);
    logger.warn(apiErrMsg);

    // In server-only mode (Electrobun desktop), a missing API server is fatal
    // — nothing else can serve requests. Exit so the parent process sees a
    // non-zero exit code instead of the misleading "Server running" message.
    if (opts?.serverOnly) {
      console.error(
        "[eliza] Exiting: API server is required in server-only mode.",
      );
      process.exit(1);
    }
    // Non-fatal in CLI mode — the interactive chat loop still works.
  }

  // ── Server-only mode — keep running without chat loop ────────────────────
  if (opts?.serverOnly) {
    logger.info("[eliza] Running in server-only mode (no interactive chat)");
    console.log("[eliza] Server running. Press Ctrl+C to stop.");

    // Keep process alive — the API server handles all interaction
    const keepAlive = setInterval(() => {}, 1 << 30); // ~12 days

    registerSignalShutdownHandlers({
      getRuntime: () => runtime,
      getSandboxManager: () => sandboxManager,
      beforeShutdown: () => {
        clearInterval(keepAlive);
      },
    });

    return runtime;
  }

  // ── Interactive chat loop ────────────────────────────────────────────────
  const agentName = character.name ?? "Eliza";
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
      `[eliza] Could not establish chat room, retrying with fresh IDs: ${formatError(err)}`,
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
        `[eliza] Chat room setup failed after retry: ${formatError(retryErr)}`,
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
          logger.warn(`[eliza] Error stopping runtime: ${formatError(err)}`);
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
            "[eliza] runtime.messageService is not available — cannot process messages",
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
          `[eliza] Chat message handling failed: ${formatError(err)}`,
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
  config: ElizaConfig,
  agentId: string,
  opts?: StartElizaOptions,
): Promise<AgentRuntime | undefined> {
  const { CloudManager } = await import(
    "@elizaos/plugin-elizacloud/cloud/cloud-manager"
  );

  const cloudConfig = config.cloud;
  if (!cloudConfig) {
    throw new Error(
      "Cloud mode requires a cloud configuration block in the config",
    );
  }
  logger.info(
    `[eliza] Starting in cloud mode (agentId=${agentId}, baseUrl=${cloudConfig.baseUrl ?? "(default)"})`,
  );

  const manager = new CloudManager(cloudConfig, {
    onStatusChange: (status: string) => {
      logger.info(`[eliza] Cloud connection: ${status}`);
    },
  });

  try {
    await manager.init();
    const proxy = await manager.connect(agentId);

    if (opts?.headless || opts?.serverOnly) {
      // In headless/server mode, start the API server with the cloud proxy.
      // The proxy exposes the same interface the API server needs.
      logger.info(
        `[eliza] Cloud agent connected (headless). Agent: ${proxy.agentName}`,
      );
      // Return undefined here; GUI cloud mode is handled through the
      // dedicated cloud proxy routes instead of a local AgentRuntime.
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
    logger.error(`[eliza] Failed to connect to cloud agent: ${msg}`);
    throw new Error(
      `Failed to connect to cloud agent: ${msg}\n` +
        "You can retry with `eliza start`, or switch to local mode by setting `deploymentTarget.runtime` to `local`",
    );
  }
}

const isDirectRun = (() => {
  // Mobile (bundled) builds set ELIZA_DISABLE_DIRECT_RUN=1 via Bun's
  // `--define`. After bundling, `import.meta.url` and `process.argv[1]`
  // collapse to the same bundle path, so this check spuriously matches and
  // the runtime self-invokes a SECOND `startEliza()` alongside the CLI's
  // primary one. The second invocation lacks `{ serverOnly: true }` and
  // drops into the readline chat loop, which closes on stdin EOF and tears
  // the whole process down.
  if (process.env.ELIZA_DISABLE_DIRECT_RUN === "1") return false;
  const scriptArg = process.argv[1];
  if (!scriptArg) return false;
  const normalised = path.resolve(scriptArg);
  return import.meta.url === pathToFileURL(normalised).href;
})();

if (isDirectRun) {
  startEliza().catch((err) => {
    console.error(
      "[eliza] Fatal error:",
      err instanceof Error ? (err.stack ?? err.message) : err,
    );
    process.exit(1);
  });
}
