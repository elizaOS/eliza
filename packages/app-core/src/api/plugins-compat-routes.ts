import fs from "node:fs";
import type http from "node:http";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  applyPluginRuntimeMutation,
  type PluginRuntimeApplyResult,
} from "@elizaos/agent/api/plugin-runtime-apply";
import {
  findPrimaryEnvKey,
  readBundledPluginPackageMetadata,
} from "@elizaos/agent/api/server";
import { loadElizaConfig, saveElizaConfig } from "@elizaos/agent/config/config";
import { type AgentRuntime, logger } from "@elizaos/core";
import { asRecord } from "@elizaos/shared/type-guards";
import { CONNECTOR_ENV_MAP } from "../config/env-vars";
import {
  CONNECTOR_PLUGINS,
  STREAMING_PLUGINS,
} from "../config/plugin-auto-enable";
import {
  ensureCompatApiAuthorized,
  ensureCompatSensitiveRouteAuthorized,
} from "./auth";
import {
  entriesToLegacyManifest,
  loadRegistry,
} from "../registry";
import {
  type CompatRuntimeState,
  readCompatJsonBody,
  scheduleCompatRuntimeRestart,
} from "./compat-route-shared";
import {
  sendJsonError as sendJsonErrorResponse,
  sendJson as sendJsonResponse,
} from "./response";

const require = createRequire(import.meta.url);

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type PluginCategory =
  | "ai-provider"
  | "connector"
  | "streaming"
  | "database"
  | "app"
  | "feature";

interface ManifestPluginParameter {
  type?: string;
  description?: string;
  required?: boolean;
  optional?: boolean;
  sensitive?: boolean;
  default?: string | number | boolean;
  options?: string[];
}

interface ManifestPluginEntry {
  id: string;
  dirName?: string;
  name?: string;
  npmName?: string;
  description?: string;
  tags?: string[];
  category?: string;
  envKey?: string;
  configKeys?: string[];
  version?: string;
  pluginDeps?: string[];
  pluginParameters?: Record<string, ManifestPluginParameter>;
  configUiHints?: Record<string, Record<string, unknown>>;
  icon?: string | null;
  logoUrl?: string | null;
  homepage?: string;
  repository?: string;
  setupGuideUrl?: string;
}

interface PluginManifestFile {
  plugins?: ManifestPluginEntry[];
}

interface RuntimePluginLike {
  name?: string;
  description?: string;
}

interface CompatPluginParameter {
  key: string;
  type: string;
  description: string;
  required: boolean;
  sensitive: boolean;
  default?: string;
  options?: string[];
  currentValue: string | null;
  isSet: boolean;
}

interface CompatPluginRecord {
  id: string;
  name?: string;
  description?: string;
  enabled?: boolean;
  configured?: boolean;
  envKey?: string | null;
  category?: PluginCategory;
  source?: string;
  parameters: CompatPluginParameter[];
  validationErrors: Array<{ field: string; message: string }>;
  validationWarnings?: Array<{ field?: string; message: string }>;
  npmName?: string;
  version?: string;
  isActive?: boolean;
  tags?: string[];
  configKeys?: string[];
  pluginDeps?: string[];
  configUiHints?: Record<string, unknown>;
  icon?: string | null;
  homepage?: string;
  repository?: string;
  setupGuideUrl?: string;
  // Registry-sourced render hints. Replaces frontend lookups against
  // VISIBLE_CONNECTOR_IDS / DEFAULT_ICONS / FEATURE_SUBGROUP /
  // SUBGROUP_DISPLAY_ORDER. Optional during migration; required once the
  // frontend constants are deleted.
  iconName?: string;
  group?: string;
  groupOrder?: number;
  visible?: boolean;
}

type PluginDriftFlag =
  | "entries_vs_compat"
  | "entries_vs_allowlist"
  | "inactive_but_enabled"
  | "active_but_disabled";

interface PluginDriftDiagnostic {
  pluginId: string;
  npmName: string | null;
  category: PluginCategory;
  enabled_ui: boolean;
  enabled_allowlist: boolean | null;
  is_active: boolean;
  drift_flags: PluginDriftFlag[];
}

interface PluginDriftDiagnosticsSummary {
  total: number;
  withDrift: number;
  byFlag: Record<PluginDriftFlag, number>;
}

interface PluginDriftDiagnosticsReport {
  summary: PluginDriftDiagnosticsSummary;
  plugins: PluginDriftDiagnostic[];
}

type PluginDriftFlag =
  | "entries_vs_compat"
  | "entries_vs_allowlist"
  | "inactive_but_enabled"
  | "active_but_disabled";

interface PluginDriftDiagnostic {
  pluginId: string;
  npmName: string | null;
  category: PluginCategory;
  enabled_ui: boolean;
  enabled_allowlist: boolean | null;
  is_active: boolean;
  drift_flags: PluginDriftFlag[];
}

interface PluginDriftDiagnosticsSummary {
  total: number;
  withDrift: number;
  byFlag: Record<PluginDriftFlag, number>;
}

interface PluginDriftDiagnosticsReport {
  summary: PluginDriftDiagnosticsSummary;
  plugins: PluginDriftDiagnostic[];
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const CAPABILITY_FEATURE_IDS = new Set([
  "vision",
  "browser",
  "computeruse",
  "coding-agent",
]);

// Key prefixes that contain wallet private keys or other high-value secrets
// require the hardened sensitive-route auth (loopback + elevated checks).
const SENSITIVE_KEY_PREFIXES = ["SOLANA_", "ETHEREUM_", "EVM_", "WALLET_"];

const REVEALABLE_KEY_PREFIXES = [
  "OPENAI_",
  "ANTHROPIC_",
  "GOOGLE_",
  "GROQ_",
  "MISTRAL_",
  "PERPLEXITY_",
  "COHERE_",
  "TOGETHER_",
  "FIREWORKS_",
  "REPLICATE_",
  "HUGGINGFACE_",
  "ELEVENLABS_",
  "DISCORD_",
  "TELEGRAM_",
  "TWITTER_",
  "SLACK_",
  "GITHUB_",
  "REDIS_",
  "POSTGRES_",
  "DATABASE_",
  "SUPABASE_",
  "PINECONE_",
  "QDRANT_",
  "WEAVIATE_",
  "CHROMADB_",
  "AWS_",
  "AZURE_",
  "CLOUDFLARE_",
  "ELIZA_",
  "ELIZA_",
  "PLUGIN_",
  "XAI_",
  "DEEPSEEK_",
  "OLLAMA_",
  "FAL_",
  "LETZAI_",
  "GAIANET_",
  "LIVEPEER_",
  ...SENSITIVE_KEY_PREFIXES,
];

const DRIFT_LOG_THROTTLE_MS = 5 * 60 * 1000;
let _lastDriftWarningAt = 0;
let _lastDriftWarningFingerprint = "";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function maskValue(value: string): string {
  if (value.length <= 8) return "****";
  return `${value.slice(0, 4)}...${value.slice(-4)}`;
}

function normalizePluginCategory(value: string | undefined): PluginCategory {
  switch (value) {
    case "ai-provider":
    case "connector":
    case "streaming":
    case "database":
    case "app":
      return value;
    default:
      return "feature";
  }
}

function normalizePluginId(rawName: string): string {
  return rawName
    .replace(/^@[^/]+\/plugin-/, "")
    .replace(/^@[^/]+\/app-/, "")
    .replace(/^@[^/]+\//, "")
    .replace(/^(plugin|app)-/, "");
}

function resolveCompatConfigKey(
  pluginId: string,
  npmName: string | undefined,
  pluginMap: Record<string, string>,
): string | null {
  const candidates = new Set<string>([pluginId, normalizePluginId(pluginId)]);
  if (typeof npmName === "string" && npmName.length > 0) {
    candidates.add(npmName);
    candidates.add(normalizePluginId(npmName));
  }

  for (const [configKey, packageName] of Object.entries(pluginMap)) {
    if (
      candidates.has(configKey) ||
      candidates.has(packageName) ||
      candidates.has(normalizePluginId(packageName))
    ) {
      return configKey;
    }
  }

  return null;
}

function readCompatSectionEnabled(
  section: unknown,
  configKey: string | null,
): boolean | undefined {
  if (!configKey) {
    return undefined;
  }

  const sectionRecord = asRecord(section);
  if (!sectionRecord) {
    return undefined;
  }

  const targetRecord = asRecord(sectionRecord[configKey]);
  if (!targetRecord || typeof targetRecord.enabled !== "boolean") {
    return undefined;
  }

  return targetRecord.enabled;
}

function writeCompatSectionEnabled(
  parent: Record<string, unknown>,
  sectionKey: string,
  configKey: string | null,
  enabled: boolean,
): void {
  if (!configKey) {
    return;
  }

  const section = asRecord(parent[sectionKey]) ?? {};
  const entry = asRecord(section[configKey]) ?? {};
  entry.enabled = enabled;
  section[configKey] = entry;
  parent[sectionKey] = section;
}

function syncCompatConnectorConfigValues(
  config: Record<string, unknown>,
  pluginId: string,
  npmName: string | undefined,
  values: Record<string, string>,
): void {
  const connectorKey = resolveCompatConfigKey(
    pluginId,
    npmName,
    CONNECTOR_PLUGINS,
  );
  if (!connectorKey) {
    return;
  }

  const envMap =
    CONNECTOR_ENV_MAP[connectorKey as keyof typeof CONNECTOR_ENV_MAP];
  if (!envMap) {
    return;
  }
  const typedEnvMap = envMap as Record<string, string>;

  const connectors = asRecord(config.connectors) ?? {};
  const connectorEntry = asRecord(connectors[connectorKey]) ?? {};
  const envToField = new Map<string, string>();

  for (const [field, envKey] of Object.entries(typedEnvMap)) {
    if (!envToField.has(envKey)) {
      envToField.set(envKey, field);
    }
  }

  let touched = false;
  for (const [envKey, field] of envToField.entries()) {
    if (!(envKey in values)) {
      continue;
    }

    touched = true;
    const value = values[envKey];
    if (value.trim()) {
      connectorEntry[field] = value;
    } else {
      delete connectorEntry[field];
    }
  }

  // Canonicalize Discord onto `connectors.discord.token`; keep the legacy
  // `botToken` alias cleared so the config does not drift between fields.
  if (connectorKey === "discord" && "DISCORD_API_TOKEN" in values) {
    touched = true;
    const tokenValue = values.DISCORD_API_TOKEN.trim();
    if (tokenValue) {
      connectorEntry.token = tokenValue;
    } else {
      delete connectorEntry.token;
    }
    delete connectorEntry.botToken;
  }

  if (!touched) {
    return;
  }

  connectors[connectorKey] = connectorEntry;
  config.connectors = connectors;
}

function resolvePersistedPluginEnabled(
  pluginId: string,
  category: PluginCategory,
  npmName: string | undefined,
  configEntries: Record<string, { enabled?: unknown }>,
  config: Record<string, unknown>,
): boolean | undefined {
  const pluginEnabled =
    typeof configEntries[pluginId]?.enabled === "boolean"
      ? Boolean(configEntries[pluginId]?.enabled)
      : undefined;

  if (category === "connector") {
    const connectorEnabled = readCompatSectionEnabled(
      config.connectors,
      resolveCompatConfigKey(pluginId, npmName, CONNECTOR_PLUGINS),
    );
    return connectorEnabled ?? pluginEnabled;
  }

  if (category === "streaming") {
    const streamingEnabled = readCompatSectionEnabled(
      config.streaming,
      resolveCompatConfigKey(pluginId, npmName, STREAMING_PLUGINS),
    );
    return streamingEnabled ?? pluginEnabled;
  }

  return pluginEnabled;
}

function shortPluginIdFromNpmName(npmName: string | null): string | null {
  if (!npmName || typeof npmName !== "string") {
    return null;
  }
  if (npmName.startsWith("@elizaos/app-")) {
    return npmName.slice("@elizaos/".length);
  }
  if (npmName.startsWith("@elizaos/plugin-")) {
    return npmName.slice("@elizaos/plugin-".length);
  }
  return normalizePluginId(npmName);
}

export function analyzePluginStateDrift(
  pluginList: CompatPluginRecord[],
  configRecord: Record<string, unknown>,
  configEntries: Record<string, { enabled?: unknown }>,
  allowList: Set<string>,
): PluginDriftDiagnosticsReport {
  const diagnostics = pluginList.map((plugin): PluginDriftDiagnostic => {
    const pluginId = String(plugin.id ?? "");
    const category = normalizePluginCategory(plugin.category);
    const npmName =
      typeof plugin.npmName === "string" && plugin.npmName.length > 0
        ? plugin.npmName
        : null;
    const shortId = shortPluginIdFromNpmName(npmName) ?? pluginId;
    const uiEnabled = Boolean(plugin.enabled);
    const compatEnabled =
      category === "connector"
        ? readCompatSectionEnabled(
            configRecord.connectors,
            resolveCompatConfigKey(pluginId, npmName ?? undefined, CONNECTOR_PLUGINS),
          )
        : category === "streaming"
          ? readCompatSectionEnabled(
              configRecord.streaming,
              resolveCompatConfigKey(
                pluginId,
                npmName ?? undefined,
                STREAMING_PLUGINS,
              ),
            )
          : undefined;
    const entryEnabled =
      typeof configEntries[pluginId]?.enabled === "boolean"
        ? Boolean(configEntries[pluginId]?.enabled)
        : undefined;
    const enabledAllowList =
      npmName == null
        ? null
        : allowList.has(npmName) || allowList.has(shortId);
    const isActive = Boolean(plugin.isActive);
    const driftFlags: PluginDriftFlag[] = [];

    if (
      compatEnabled !== undefined &&
      entryEnabled !== undefined &&
      compatEnabled !== entryEnabled
    ) {
      driftFlags.push("entries_vs_compat");
    }
    if (enabledAllowList !== null && entryEnabled !== undefined) {
      if (enabledAllowList !== entryEnabled) {
        driftFlags.push("entries_vs_allowlist");
      }
    }
    if (uiEnabled && !isActive) {
      driftFlags.push("inactive_but_enabled");
    }
    if (!uiEnabled && isActive) {
      driftFlags.push("active_but_disabled");
    }

    return {
      pluginId,
      npmName,
      category,
      enabled_ui: uiEnabled,
      enabled_allowlist: enabledAllowList,
      is_active: isActive,
      drift_flags: driftFlags,
    };
  });

  const withDrift = diagnostics.filter((plugin) => plugin.drift_flags.length > 0);
  const byFlag: Record<PluginDriftFlag, number> = {
    entries_vs_compat: 0,
    entries_vs_allowlist: 0,
    inactive_but_enabled: 0,
    active_but_disabled: 0,
  };
  for (const plugin of withDrift) {
    for (const flag of plugin.drift_flags) {
      byFlag[flag] += 1;
    }
  }

  return {
    summary: {
      total: diagnostics.length,
      withDrift: withDrift.length,
      byFlag,
    },
    plugins: diagnostics,
  };
}

function buildPluginDriftDiagnostics(
  runtime: AgentRuntime | null,
): PluginDriftDiagnosticsReport {
  const pluginList = buildPluginListResponse(runtime)
    .plugins as unknown as CompatPluginRecord[];
  const config = loadElizaConfig();
  const configRecord = config as Record<string, unknown>;
  const configEntries = config.plugins?.entries ?? {};
  const allowList = new Set(config.plugins?.allow ?? []);

  return analyzePluginStateDrift(
    pluginList,
    configRecord,
    configEntries,
    allowList,
  );
}

function maybeLogPluginStateDrift(report: PluginDriftDiagnosticsReport): void {
  if (report.summary.withDrift === 0) {
    return;
  }
  const drifted = report.plugins
    .filter((plugin) => plugin.drift_flags.length > 0)
    .map((plugin) => `${plugin.pluginId}:${plugin.drift_flags.join("+")}`)
    .sort();
  const fingerprint = drifted.join("|");
  const now = Date.now();
  if (
    fingerprint === _lastDriftWarningFingerprint &&
    now - _lastDriftWarningAt < DRIFT_LOG_THROTTLE_MS
  ) {
    return;
  }
  _lastDriftWarningAt = now;
  _lastDriftWarningFingerprint = fingerprint;
  logger.warn(
    {
      src: "api:plugins",
      driftCount: report.summary.withDrift,
      byFlag: report.summary.byFlag,
      plugins: drifted,
    },
    "Plugin enable-state drift detected between /api/plugins and /api/plugins/core models",
  );
}

// ── Enabled-state drift reconciliation ────────────────────────────────
//
// The write path (persistCompatPluginMutation) always updates both
// plugins.entries[id].enabled AND the compat connector/streaming section.
// However drift can occur if the config file is edited externally or a
// migration only touched one location.  This pass detects any mismatch
// and re-synchronises the compat section from plugins.entries, which is
// the canonical source for the Settings UI.
//
// Runs once per process on the first buildPluginListResponse() call.

let _enabledStateReconciled = false;

function reconcilePluginEnabledStates(): void {
  if (_enabledStateReconciled) return;
  _enabledStateReconciled = true;

  const config = loadElizaConfig();
  const configRecord = config as Record<string, unknown>;
  const entries = (config.plugins?.entries ?? {}) as Record<
    string,
    { enabled?: unknown }
  >;

  let dirty = false;

  for (const [pluginId, entry] of Object.entries(entries)) {
    if (typeof entry.enabled !== "boolean") continue;

    // Check connector section
    const connectorKey = resolveCompatConfigKey(
      pluginId,
      undefined,
      CONNECTOR_PLUGINS,
    );
    if (connectorKey) {
      const sectionEnabled = readCompatSectionEnabled(
        configRecord.connectors,
        connectorKey,
      );
      if (sectionEnabled !== undefined && sectionEnabled !== entry.enabled) {
        writeCompatSectionEnabled(
          configRecord,
          "connectors",
          connectorKey,
          entry.enabled,
        );
        dirty = true;
      }
    }

    // Check streaming section
    const streamingKey = resolveCompatConfigKey(
      pluginId,
      undefined,
      STREAMING_PLUGINS,
    );
    if (streamingKey) {
      const sectionEnabled = readCompatSectionEnabled(
        configRecord.streaming,
        streamingKey,
      );
      if (sectionEnabled !== undefined && sectionEnabled !== entry.enabled) {
        writeCompatSectionEnabled(
          configRecord,
          "streaming",
          streamingKey,
          entry.enabled,
        );
        dirty = true;
      }
    }
  }

  if (dirty) {
    saveElizaConfig(config);
    logger.info("[plugins] Reconciled drifted plugin enabled states in config");
  }
}

function compatMutationRequiresRestart(
  plugin: CompatPluginRecord,
  body: Record<string, unknown>,
): boolean {
  if (typeof body.enabled === "boolean") {
    return true;
  }

  if (
    body.config !== undefined &&
    (plugin.category === "connector" || plugin.category === "streaming")
  ) {
    return true;
  }

  return false;
}

function createCompatRuntimeApplyFallback(
  reason: string,
  requiresRestart: boolean,
): PluginRuntimeApplyResult {
  return {
    mode: requiresRestart ? "restart_required" : "none",
    requiresRestart,
    restartedRuntime: false,
    loadedPackages: [],
    unloadedPackages: [],
    reloadedPackages: [],
    appliedConfigPackage: null,
    reason,
  };
}

async function applyCompatRuntimeMutation(options: {
  state: CompatRuntimeState;
  pluginId: string;
  plugin: CompatPluginRecord;
  body: Record<string, unknown>;
  previousConfig: ReturnType<typeof loadElizaConfig>;
  nextConfig: ReturnType<typeof loadElizaConfig>;
}): Promise<PluginRuntimeApplyResult> {
  const { state, pluginId, plugin, body, previousConfig, nextConfig } = options;
  const reason =
    typeof body.enabled === "boolean"
      ? `Plugin toggle: ${pluginId}`
      : `Plugin config updated: ${pluginId}`;
  const requiresRestartFallback = compatMutationRequiresRestart(plugin, body);

  if (!state.current) {
    return createCompatRuntimeApplyFallback(reason, requiresRestartFallback);
  }

  try {
    return await applyPluginRuntimeMutation({
      runtime: state.current,
      previousConfig,
      nextConfig,
      changedPluginId: pluginId,
      changedPluginPackage: plugin.npmName,
      config:
        body.config &&
        typeof body.config === "object" &&
        !Array.isArray(body.config)
          ? (body.config as Record<string, string>)
          : undefined,
      expectRuntimeGraphChange: typeof body.enabled === "boolean",
      reason,
    });
  } catch (error) {
    logger.warn(
      `[api/plugins] Live runtime apply failed for "${pluginId}": ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return createCompatRuntimeApplyFallback(reason, true);
  }
}

function titleCasePluginId(id: string): string {
  return id
    .split("-")
    .filter((segment) => segment.length > 0)
    .map((segment) => segment.charAt(0).toUpperCase() + segment.slice(1))
    .join(" ");
}

function inferSensitiveConfigKey(key: string): boolean {
  return /(?:_API_KEY|_SECRET|_TOKEN|_PASSWORD|_PRIVATE_KEY|_SIGNING_|ENCRYPTION_)/i.test(
    key,
  );
}

function buildPluginParamDefs(
  parameters: Record<string, ManifestPluginParameter> | undefined,
  savedValues?: Record<string, string>,
): Array<{
  key: string;
  type: string;
  description: string;
  required: boolean;
  sensitive: boolean;
  default?: string;
  options?: string[];
  currentValue: string | null;
  isSet: boolean;
}> {
  if (!parameters) {
    return [];
  }

  // Drop generic fallback model keys (SMALL_MODEL, LARGE_MODEL, IMAGE_MODEL,
  // EMBEDDING_MODEL) when a provider-prefixed equivalent (e.g.
  // GOOGLE_SMALL_MODEL) is also declared. Plugins like @elizaos/plugin-google-genai
  // declare both — surfacing both creates confusing duplicate fields in the UI.
  const allKeys = Object.keys(parameters);
  const GENERIC_FALLBACK_SUFFIXES = [
    "SMALL_MODEL",
    "LARGE_MODEL",
    "IMAGE_MODEL",
    "EMBEDDING_MODEL",
  ];
  const filteredEntries = Object.entries(parameters).filter(([key]) => {
    if (!GENERIC_FALLBACK_SUFFIXES.includes(key)) return true;
    return !allKeys.some((other) => other !== key && other.endsWith(`_${key}`));
  });

  return filteredEntries.map(([key, definition]) => {
    const envValue = process.env[key]?.trim() || undefined;
    const savedValue = savedValues?.[key];
    const effectiveValue =
      envValue ?? (savedValue ? savedValue.trim() || undefined : undefined);
    const isSet = Boolean(effectiveValue);
    const sensitive =
      typeof definition.sensitive === "boolean"
        ? definition.sensitive
        : inferSensitiveConfigKey(key);
    const currentValue =
      !isSet || !effectiveValue
        ? null
        : sensitive
          ? maskValue(effectiveValue)
          : effectiveValue;

    return {
      key,
      type: definition.type ?? "string",
      description: definition.description ?? "",
      required:
        definition.required === true ||
        (definition.optional === false && definition.required !== false),
      sensitive,
      default:
        definition.default === undefined
          ? undefined
          : String(definition.default),
      options: Array.isArray(definition.options)
        ? definition.options
        : undefined,
      currentValue,
      isSet,
    };
  });
}

function findNearestFile(
  startDir: string,
  fileName: string,
  maxDepth = 12,
): string | null {
  let dir = path.resolve(startDir);

  for (let depth = 0; depth <= maxDepth; depth += 1) {
    const candidate = path.join(dir, fileName);
    if (fs.existsSync(candidate)) {
      return candidate;
    }
    const parent = path.dirname(dir);
    if (parent === dir) {
      break;
    }
    dir = parent;
  }

  return null;
}

export function resolvePluginManifestPath(): string | null {
  const moduleDir = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    process.cwd(),
    moduleDir,
    path.dirname(process.execPath),
    path.join(path.dirname(process.execPath), "..", "Resources", "app"),
  ];

  for (const candidate of candidates) {
    const manifestPath = findNearestFile(candidate, "plugins.json");
    if (manifestPath) {
      return manifestPath;
    }
  }

  return null;
}

function resolveInstalledPackageVersion(
  packageName: string | undefined,
): string | null {
  if (!packageName) {
    return null;
  }

  try {
    const packageJsonPath = require.resolve(`${packageName}/package.json`);
    const pkg = JSON.parse(fs.readFileSync(packageJsonPath, "utf8")) as {
      version?: unknown;
    };
    return typeof pkg.version === "string" ? pkg.version : null;
  } catch {
    return null;
  }
}

function resolveLoadedPluginNames(runtime: AgentRuntime | null): Set<string> {
  const loadedNames = new Set<string>();

  for (const plugin of runtime?.plugins ?? []) {
    const name = (plugin as RuntimePluginLike).name;
    if (typeof name === "string" && name.length > 0) {
      loadedNames.add(name);
    }
  }

  return loadedNames;
}

function isPluginLoaded(
  pluginId: string,
  npmName: string | undefined,
  loadedNames: Set<string>,
): boolean {
  const expectedNames = new Set<string>([
    pluginId,
    `plugin-${pluginId}`,
    `app-${pluginId}`,
    npmName ?? "",
  ]);

  for (const loadedName of loadedNames) {
    if (expectedNames.has(loadedName)) {
      return true;
    }
    if (
      loadedName.endsWith(`/plugin-${pluginId}`) ||
      loadedName.endsWith(`/app-${pluginId}`) ||
      loadedName.includes(pluginId)
    ) {
      return true;
    }
  }

  return false;
}

export function buildPluginListResponse(runtime: AgentRuntime | null): {
  plugins: CompatPluginRecord[];
} {
  reconcilePluginEnabledStates();
  const config = loadElizaConfig();
  const configRecord = config as Record<string, unknown>;
  const loadedNames = resolveLoadedPluginNames(runtime);
  // Source of truth: registry under packages/app-core/src/registry/data/.
  // The legacy adapter projects RegistryEntry[] back to the manifest shape
  // this route's transformation pipeline still expects. Once that pipeline
  // is rewritten to consume RegistryEntry directly, drop the adapter.
  const registry = loadRegistry();
  const manifestRoot = resolvePluginManifestPath()
    ? path.dirname(resolvePluginManifestPath() ?? "")
    : process.cwd();
  const manifest: PluginManifestFile = entriesToLegacyManifest(registry.all);

  const configEntries = config.plugins?.entries ?? {};
  const installEntries = config.plugins?.installs ?? {};
  const plugins = new Map<string, CompatPluginRecord>();

  for (const entry of manifest?.plugins ?? []) {
    const pluginId = normalizePluginId(entry.id);
    const category = normalizePluginCategory(entry.category);
    const bundledMeta =
      entry.dirName && manifestRoot
        ? readBundledPluginPackageMetadata(
            manifestRoot,
            entry.dirName,
            entry.npmName,
          )
        : undefined;
    const configKeys =
      Array.isArray(entry.configKeys) && entry.configKeys.length > 0
        ? entry.configKeys
        : (bundledMeta?.configKeys ?? []);
    const envKey = entry.envKey ?? findPrimaryEnvKey(configKeys);
    const parameters = buildPluginParamDefs(
      entry.pluginParameters ?? bundledMeta?.pluginParameters,
    );
    const active = isPluginLoaded(pluginId, entry.npmName, loadedNames);
    const enabled =
      active ||
      Boolean(
        resolvePersistedPluginEnabled(
          pluginId,
          category,
          entry.npmName,
          configEntries,
          configRecord,
        ),
      );
    const validationErrors = parameters
      .filter((parameter) => parameter.required && !parameter.isSet)
      .map((parameter) => ({
        field: parameter.key,
        message: "Required value is not configured.",
      }));

    const registryEntry = registry.byId.get(pluginId);
    plugins.set(pluginId, {
      id: pluginId,
      name: entry.name ?? titleCasePluginId(pluginId),
      description: entry.description ?? bundledMeta?.description ?? "",
      tags: entry.tags ?? [],
      enabled,
      configured: validationErrors.length === 0,
      envKey,
      category,
      source: "bundled",
      configKeys,
      parameters,
      validationErrors,
      validationWarnings: [],
      npmName: entry.npmName,
      version:
        resolveInstalledPackageVersion(entry.npmName) ??
        entry.version ??
        undefined,
      pluginDeps: entry.pluginDeps,
      isActive: active,
      configUiHints: entry.configUiHints ?? bundledMeta?.configUiHints,
      icon: entry.logoUrl ?? bundledMeta?.icon ?? null,
      homepage: entry.homepage ?? bundledMeta?.homepage,
      repository: entry.repository ?? bundledMeta?.repository,
      setupGuideUrl: entry.setupGuideUrl,
      iconName: registryEntry?.render.icon,
      group: registryEntry?.render.group,
      groupOrder: registryEntry?.render.groupOrder,
      visible: registryEntry?.render.visible ?? true,
    });
  }

  for (const plugin of runtime?.plugins ?? []) {
    const pluginName =
      typeof (plugin as RuntimePluginLike).name === "string"
        ? (plugin as RuntimePluginLike).name
        : "";
    if (!pluginName) {
      continue;
    }

    const pluginId = normalizePluginId(pluginName);
    const existing = plugins.get(pluginId);
    if (existing) {
      existing.isActive = true;
      if (
        existing.enabled !== true &&
        configEntries[pluginId]?.enabled == null
      ) {
        existing.enabled = true;
      }
      if (!existing.version) {
        existing.version =
          resolveInstalledPackageVersion(pluginName) ?? undefined;
      }
      continue;
    }

    plugins.set(pluginId, {
      id: pluginId,
      name: titleCasePluginId(pluginId),
      description:
        (plugin as RuntimePluginLike).description ??
        "Loaded runtime plugin discovered without manifest metadata.",
      tags: [],
      enabled:
        typeof configEntries[pluginId]?.enabled === "boolean"
          ? Boolean(configEntries[pluginId]?.enabled)
          : true,
      configured: true,
      envKey: null,
      category: "feature",
      source: "bundled",
      parameters: [],
      validationErrors: [],
      validationWarnings: [],
      npmName: pluginName,
      version: resolveInstalledPackageVersion(pluginName) ?? undefined,
      isActive: true,
      icon: null,
    });
  }

  for (const [pluginName, installRecord] of Object.entries(installEntries)) {
    const pluginId = normalizePluginId(pluginName);
    if (plugins.has(pluginId)) {
      continue;
    }

    plugins.set(pluginId, {
      id: pluginId,
      name: titleCasePluginId(pluginId),
      description: "Installed store plugin.",
      tags: [],
      enabled:
        typeof configEntries[pluginId]?.enabled === "boolean"
          ? Boolean(configEntries[pluginId]?.enabled)
          : false,
      configured: true,
      envKey: null,
      category: "feature",
      source: "store",
      parameters: [],
      validationErrors: [],
      validationWarnings: [],
      npmName: pluginName,
      version:
        typeof installRecord?.version === "string"
          ? installRecord.version
          : (resolveInstalledPackageVersion(pluginName) ?? undefined),
      isActive: isPluginLoaded(pluginId, pluginName, loadedNames),
      icon: null,
    });
  }

  const pluginList = Array.from(plugins.values()).sort((left, right) =>
    String(left.name ?? "").localeCompare(String(right.name ?? "")),
  );
  return { plugins: pluginList };
}

function validateCompatPluginConfig(
  plugin: CompatPluginRecord,
  config: Record<string, unknown>,
): {
  errors: Array<{ field: string; message: string }>;
  values: Record<string, string>;
} {
  const paramMap = new Map(
    plugin.parameters.map((parameter) => [parameter.key, parameter]),
  );
  const errors: Array<{ field: string; message: string }> = [];
  const values: Record<string, string> = {};

  for (const [key, rawValue] of Object.entries(config)) {
    const parameter = paramMap.get(key);
    if (!parameter) {
      errors.push({
        field: key,
        message: `${key} is not a declared config key for this plugin`,
      });
      continue;
    }

    if (typeof rawValue !== "string") {
      errors.push({
        field: key,
        message: "Plugin config values must be strings.",
      });
      continue;
    }

    const trimmed = rawValue.trim();
    if (parameter.required && trimmed.length === 0) {
      errors.push({
        field: key,
        message: "Required value is not configured.",
      });
      continue;
    }

    values[key] = rawValue;
  }

  return { errors, values };
}

export function persistCompatPluginMutation(
  pluginId: string,
  body: Record<string, unknown>,
  plugin: CompatPluginRecord,
): {
  status: number;
  payload: Record<string, unknown>;
} {
  const config = loadElizaConfig();
  const configRecord = config as Record<string, unknown>;
  config.plugins ??= {};
  config.plugins.entries ??= {};
  config.plugins.entries[pluginId] ??= {};
  const pluginEntry = config.plugins.entries[pluginId] as Record<
    string,
    unknown
  >;

  if (typeof body.enabled === "boolean") {
    pluginEntry.enabled = body.enabled;

    if (CAPABILITY_FEATURE_IDS.has(pluginId)) {
      config.features ??= {};
      config.features[pluginId] = body.enabled;
    }

    if (plugin.category === "connector") {
      writeCompatSectionEnabled(
        configRecord,
        "connectors",
        resolveCompatConfigKey(pluginId, plugin.npmName, CONNECTOR_PLUGINS),
        body.enabled,
      );
    }

    if (plugin.category === "streaming") {
      writeCompatSectionEnabled(
        configRecord,
        "streaming",
        resolveCompatConfigKey(pluginId, plugin.npmName, STREAMING_PLUGINS),
        body.enabled,
      );
    }
  }

  if (body.config !== undefined) {
    if (
      !body.config ||
      typeof body.config !== "object" ||
      Array.isArray(body.config)
    ) {
      return {
        status: 400,
        payload: { ok: false, error: "Plugin config must be a JSON object." },
      };
    }

    const configObject = body.config as Record<string, unknown>;
    const { errors, values } = validateCompatPluginConfig(plugin, configObject);
    if (errors.length > 0) {
      return {
        status: 422,
        payload: { ok: false, plugin, validationErrors: errors },
      };
    }

    const nextConfig =
      pluginEntry.config &&
      typeof pluginEntry.config === "object" &&
      !Array.isArray(pluginEntry.config)
        ? { ...(pluginEntry.config as Record<string, unknown>) }
        : {};

    config.env ??= {};
    for (const [key, value] of Object.entries(values)) {
      if (value.trim()) {
        config.env[key] = value;
        nextConfig[key] = value;
      } else {
        delete config.env[key];
        delete nextConfig[key];
      }
    }

    pluginEntry.config = nextConfig;
    if (plugin.category === "connector") {
      syncCompatConnectorConfigValues(
        configRecord,
        pluginId,
        plugin.npmName,
        values,
      );
    }

    saveElizaConfig(config);

    for (const [key, value] of Object.entries(values)) {
      try {
        if (value.trim()) {
          process.env[key] = value;
        } else {
          delete process.env[key];
        }
      } catch {
        // process.env may be read-only in sandboxed or frozen environments.
        // Config is already persisted to disk above, so this is non-fatal.
      }
    }
  } else {
    saveElizaConfig(config);
  }

  const refreshed = buildPluginListResponse(null).plugins.find(
    (candidate) => candidate.id === pluginId,
  );

  return {
    status: 200,
    payload: {
      ok: true,
      plugin: refreshed ?? plugin,
    },
  };
}

// ---------------------------------------------------------------------------
// Route handler
// ---------------------------------------------------------------------------

/**
 * Plugin management routes.
 *
 * Contract note:
 * - `/api/plugins` is the Settings/UI model.
 * - `/api/plugins/core` is the optional-core allow-list model.
 * - These can drift; use `/api/plugins/diagnostics` to inspect mismatches.
 *
 * - `GET  /api/plugins`             — returns filtered plugin list
 * - `GET  /api/plugins/diagnostics` — returns drift diagnostics
 * - `PUT  /api/plugins/:id`         — updates plugin config, writes env vars
 * - `POST /api/plugins/:id/test`    — tests plugin connectivity
 * - `POST /api/plugins/:id/reveal`  — reveals plugin env var value
 */
export async function handlePluginsCompatRoutes(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  state: CompatRuntimeState,
): Promise<boolean> {
  const method = (req.method ?? "GET").toUpperCase();
  const url = new URL(req.url ?? "/", "http://localhost");

  if (!url.pathname.startsWith("/api/plugins")) {
    return false;
  }

  if (method === "GET" && url.pathname === "/api/plugins") {
    if (!ensureCompatApiAuthorized(req, res)) {
      return true;
    }

    const pluginResponse = buildPluginListResponse(state.current);
    logger.debug(
      `[api/plugins] source=registry total=${pluginResponse.plugins.length} runtime=${state.current ? "active" : "null"}`,
    );
    maybeLogPluginStateDrift(buildPluginDriftDiagnostics(state.current));
    sendJsonResponse(res, 200, pluginResponse);
    return true;
  }

  if (method === "GET" && url.pathname === "/api/plugins/diagnostics") {
    if (!ensureCompatApiAuthorized(req, res)) {
      return true;
    }
    const diagnostics = buildPluginDriftDiagnostics(state.current);
    maybeLogPluginStateDrift(diagnostics);
    sendJsonResponse(res, 200, diagnostics);
    return true;
  }

  if (method === "PUT" && url.pathname.startsWith("/api/plugins/")) {
    if (!ensureCompatApiAuthorized(req, res)) {
      return true;
    }

    const body = await readCompatJsonBody(req, res);
    if (body == null) {
      return true;
    }

    const pluginId = normalizePluginId(
      decodeURIComponent(url.pathname.slice("/api/plugins/".length)),
    );
    const plugin = buildPluginListResponse(state.current).plugins.find(
      (candidate) => candidate.id === pluginId,
    );

    if (!plugin) {
      sendJsonErrorResponse(res, 404, `Plugin "${pluginId}" not found`);
      return true;
    }

    const previousConfig = structuredClone(loadElizaConfig());
    const result = persistCompatPluginMutation(pluginId, body, plugin);
    if (result.status === 200) {
      const nextConfig = loadElizaConfig();
      const runtimeApply = await applyCompatRuntimeMutation({
        state,
        pluginId,
        plugin,
        body,
        previousConfig,
        nextConfig,
      });

      if (runtimeApply.requiresRestart) {
        scheduleCompatRuntimeRestart(state, runtimeApply.reason);
      }

      const refreshed = buildPluginListResponse(state.current).plugins.find(
        (candidate) => candidate.id === pluginId,
      );

      result.payload.plugin = refreshed ?? result.payload.plugin ?? plugin;
      result.payload.applied = runtimeApply.mode;
      result.payload.requiresRestart = runtimeApply.requiresRestart;
      result.payload.restartedRuntime = runtimeApply.restartedRuntime;
      result.payload.loadedPackages = runtimeApply.loadedPackages;
      result.payload.unloadedPackages = runtimeApply.unloadedPackages;
      result.payload.reloadedPackages = runtimeApply.reloadedPackages;
      const diagnostics = buildPluginDriftDiagnostics(state.current);
      if (diagnostics.summary.withDrift > 0) {
        result.payload.diagnostics = diagnostics;
      }
    }
    sendJsonResponse(res, result.status, result.payload);
    return true;
  }

  const testMatch =
    method === "POST" && url.pathname.match(/^\/api\/plugins\/([^/]+)\/test$/);
  if (testMatch) {
    if (!ensureCompatApiAuthorized(req, res)) return true;
    const testPluginId = normalizePluginId(decodeURIComponent(testMatch[1]));
    const startMs = Date.now();

    if (testPluginId === "telegram") {
      const token = process.env.TELEGRAM_BOT_TOKEN;
      if (!token) {
        sendJsonResponse(res, 422, {
          success: false,
          pluginId: testPluginId,
          error: "No bot token configured",
          durationMs: Date.now() - startMs,
        });
        return true;
      }
      try {
        const apiRoot =
          process.env.TELEGRAM_API_ROOT || "https://api.telegram.org";
        const tgResp = await fetch(`${apiRoot}/bot${token}/getMe`);
        const tgData = (await tgResp.json()) as {
          ok: boolean;
          result?: { username?: string };
          description?: string;
        };
        sendJsonResponse(res, tgData.ok ? 200 : 422, {
          success: tgData.ok,
          pluginId: testPluginId,
          message: tgData.ok
            ? `Connected as @${tgData.result?.username}`
            : `Telegram API error: ${tgData.description}`,
          durationMs: Date.now() - startMs,
        });
      } catch (err) {
        sendJsonResponse(res, 422, {
          success: false,
          pluginId: testPluginId,
          error: err instanceof Error ? err.message : String(err),
          durationMs: Date.now() - startMs,
        });
      }
      return true;
    }

    sendJsonResponse(res, 200, {
      success: true,
      pluginId: testPluginId,
      message: "Plugin is loaded (no custom test available)",
      durationMs: Date.now() - startMs,
    });
    return true;
  }

  const revealMatch =
    method === "POST" &&
    url.pathname.match(/^\/api\/plugins\/([^/]+)\/reveal$/);
  if (revealMatch) {
    if (!ensureCompatApiAuthorized(req, res)) return true;
    const revealBody = await readCompatJsonBody(req, res);
    if (revealBody == null) return true;
    const key = (revealBody.key as string)?.trim();
    if (!key) {
      sendJsonErrorResponse(res, 400, "Missing key parameter");
      return true;
    }
    const upperKey = key.toUpperCase();
    if (
      !REVEALABLE_KEY_PREFIXES.some((prefix) => upperKey.startsWith(prefix))
    ) {
      sendJsonErrorResponse(
        res,
        403,
        "Key is not in the allowlist of revealable plugin config keys",
      );
      return true;
    }
    // Wallet / private-key prefixes require elevated auth to prevent
    // accidental exposure through the general plugin config UI.
    if (SENSITIVE_KEY_PREFIXES.some((prefix) => upperKey.startsWith(prefix))) {
      if (!ensureCompatSensitiveRouteAuthorized(req, res)) return true;
    }
    const config = loadElizaConfig();
    const value =
      process.env[key] ??
      (config.env as Record<string, string> | undefined)?.[key] ??
      null;
    sendJsonResponse(res, 200, { ok: true, value });
    return true;
  }

  return false;
}
