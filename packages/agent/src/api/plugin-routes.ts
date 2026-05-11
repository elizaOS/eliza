import type http from "node:http";
import type { AgentRuntime } from "@elizaos/core";
import { logger } from "@elizaos/core";
import type { ReadJsonBodyOptions } from "@elizaos/shared";
import {
  asRecord,
  isElizaSettingsDebugEnabled,
  PostPluginCoreToggleRequestSchema,
  PostPluginInstallRequestSchema,
  PostPluginUninstallRequestSchema,
  PostPluginUpdateRequestSchema,
  PutPluginRequestSchema,
  PutSecretsRequestSchema,
  sanitizeForSettingsDebug,
  settingsDebugCloudSummary,
} from "@elizaos/shared";
import type { ElizaConfig } from "../config/config.ts";
import { loadElizaConfig, saveElizaConfig } from "../config/config.ts";
import {
  getPluginWidgets,
  type PluginWidgetDeclarationServer,
} from "../config/plugin-widgets.ts";
import {
  type AdvancedCapabilityPluginId,
  applyAdvancedCapabilitiesConfig,
  isAdvancedCapabilityPluginId,
  resolveAdvancedCapabilitiesEnabled,
} from "../runtime/advanced-capabilities-config.ts";
import {
  CORE_PLUGINS,
  OPTIONAL_CORE_PLUGINS,
} from "../runtime/core-plugins.ts";
import type { ResolvedPlugin } from "../runtime/plugin-types.ts";
import type {
  CoreManagerLike,
  InstallProgressLike,
  PluginManagerLike,
} from "../services/plugin-manager-types.ts";
import { resolveDefaultAgentWorkspaceDir } from "../shared/workspace-resolution.ts";
import { applyPluginRuntimeMutation } from "./plugin-runtime-apply.ts";
import {
  type PluginParamInfo,
  validatePluginConfig,
} from "./plugin-validation.ts";

/** Workspace packages use `@elizaos/plugin-*` or `@elizaos/app-*` — normalize list/toggle ids. */
function optionalPluginListId(npmName: string): string {
  if (npmName.startsWith("@elizaos/app-")) {
    return npmName.slice("@elizaos/".length);
  }
  return npmName.replace("@elizaos/plugin-", "");
}

const ADVANCED_CAPABILITY_SERVICE_BY_PLUGIN_ID: Partial<
  Record<AdvancedCapabilityPluginId, string>
> = {
  experience: "EXPERIENCE",
  personality: "CHARACTER_MANAGEMENT",
};

// ---------------------------------------------------------------------------
// Types — kept lean to avoid circular deps with server.ts
// ---------------------------------------------------------------------------

interface PluginParamDef {
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

interface PluginEntry {
  id: string;
  name: string;
  description: string;
  tags: string[];
  enabled: boolean;
  configured: boolean;
  envKey: string | null;
  category:
    | "ai-provider"
    | "connector"
    | "streaming"
    | "database"
    | "app"
    | "feature";
  source: "bundled" | "store";
  configKeys: string[];
  parameters: PluginParamDef[];
  validationErrors: Array<{ field: string; message: string }>;
  validationWarnings: Array<{ field: string; message: string }>;
  npmName?: string;
  version?: string;
  releaseStream?: "latest" | "beta";
  requestedVersion?: string;
  latestVersion?: string | null;
  betaVersion?: string | null;
  pluginDeps?: string[];
  isActive?: boolean;
  loadError?: string;
  configUiHints?: Record<string, Record<string, unknown>>;
  icon?: string | null;
  homepage?: string;
  repository?: string;
  setupGuideUrl?: string;
  autoEnabled?: boolean;
  managementMode?: "standard" | "core-optional";
  capabilityStatus?:
    | "loaded"
    | "auto-enabled"
    | "blocked"
    | "missing-prerequisites"
    | "disabled";
  capabilityReason?: string | null;
  prerequisites?: Array<{ label: string; met: boolean }>;
  /** Widget declarations for this plugin (rendered by the UI widget system). */
  widgets?: PluginWidgetDeclarationServer[];
  /** App metadata (nav tabs, developer-only, app-store visibility). */
  app?: {
    displayName?: string;
    category?: string;
    icon?: string | null;
    developerOnly?: boolean;
    visibleInAppStore?: boolean;
    navTabs?: Array<{
      id: string;
      label: string;
      icon?: string;
      path: string;
      order?: number;
      developerOnly?: boolean;
      group?: string;
      componentExport?: string;
    }>;
  };
}

type PluginHealthProbeResult = {
  ok?: boolean;
  message?: string;
};

function getPluginHealthProbe(
  plugin: unknown,
): (() => PluginHealthProbeResult | Promise<PluginHealthProbeResult>) | null {
  if (!plugin || typeof plugin !== "object") {
    return null;
  }
  const record = plugin as Record<string, unknown>;
  for (const key of ["health", "healthCheck", "testConnection", "test"]) {
    const candidate = record[key];
    if (typeof candidate === "function") {
      return candidate as () =>
        | PluginHealthProbeResult
        | Promise<PluginHealthProbeResult>;
    }
  }
  return null;
}

interface SecretEntry {
  key: string;
  description: string;
  category: string;
  sensitive: boolean;
  required: boolean;
  isSet: boolean;
  maskedValue: string | null;
  usedBy: Array<{ pluginId: string; pluginName: string; enabled: boolean }>;
}

type CoreToggleDriftFlag = "entries_vs_allowlist" | "entries_vs_compat";

interface CoreToggleDriftDiagnostic {
  pluginId: string;
  npmName: string;
  enabled_allowlist: boolean;
  enabled_entries: boolean | null;
  enabled_compat: boolean | null;
  drift_flags: CoreToggleDriftFlag[];
}

export interface PluginRouteContext {
  req: http.IncomingMessage;
  res: http.ServerResponse;
  method: string;
  pathname: string;
  url: URL;
  state: {
    runtime: AgentRuntime | null;
    config: ElizaConfig;
    plugins: PluginEntry[];
    broadcastWs: ((data: object) => void) | null;
  };
  // Helpers from server.ts
  json: (res: http.ServerResponse, data: unknown, status?: number) => void;
  error: (res: http.ServerResponse, message: string, status?: number) => void;
  readJsonBody: <T extends object>(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    options?: ReadJsonBodyOptions,
  ) => Promise<T | null>;
  scheduleRuntimeRestart: (reason: string) => void;
  restartRuntime?: (reason: string) => Promise<boolean>;
  // Server.ts internal helpers
  BLOCKED_ENV_KEYS: Set<string>;
  discoverInstalledPlugins: (
    config: ElizaConfig,
    bundledIds: Set<string>,
  ) => PluginEntry[];
  maskValue: (value: string) => string;
  aggregateSecrets: (plugins: PluginEntry[]) => SecretEntry[];
  readProviderCache: (
    providerId: string,
  ) => { models: Array<{ id: string; name: string; category: string }> } | null;
  paramKeyToCategory: (paramKey: string) => string;
  buildPluginEvmDiagnosticEntry: (opts: {
    config: ElizaConfig;
    runtime: AgentRuntime | null;
  }) => PluginEntry;
  EVM_PLUGIN_PACKAGE: string;
  applyWhatsAppQrOverride: (
    plugins: PluginEntry[],
    workspaceDir: string,
  ) => void;
  applySignalQrOverride: (plugins: PluginEntry[], workspaceDir: string) => void;
  resolvePluginConfigMutationRejections: (
    parameters: PluginParamDef[],
    configObj: Record<string, string>,
  ) => Array<{ field: string; message: string }>;
  requirePluginManager: (runtime: AgentRuntime | null) => PluginManagerLike;
  requireCoreManager: (runtime: AgentRuntime | null) => CoreManagerLike;
}

const pluginsListInFlight = new WeakMap<
  PluginRouteContext["state"],
  Promise<PluginEntry[]>
>();

function readCompatEnabledFromConfig(
  config: ElizaConfig,
  pluginId: string,
): boolean | null {
  const container =
    asRecord(config.connectors)?.[pluginId] ??
    asRecord(config.streaming)?.[pluginId];
  const value = asRecord(container)?.enabled;
  return typeof value === "boolean" ? value : null;
}

function buildCoreToggleDiagnostics(
  config: ElizaConfig,
  npmName: string,
): CoreToggleDriftDiagnostic | null {
  const pluginId = optionalPluginListId(npmName);
  const isOptional = (OPTIONAL_CORE_PLUGINS as readonly string[]).includes(
    npmName,
  );
  if (!isOptional) {
    return null;
  }
  const allowList = new Set(config.plugins?.allow ?? []);
  const enabledAllowList = allowList.has(npmName) || allowList.has(pluginId);
  const entryEnabledRaw = config.plugins?.entries?.[pluginId]?.enabled;
  const enabledEntries =
    typeof entryEnabledRaw === "boolean" ? entryEnabledRaw : null;
  const enabledCompat = readCompatEnabledFromConfig(config, pluginId);
  const driftFlags: CoreToggleDriftFlag[] = [];

  if (enabledEntries !== null && enabledEntries !== enabledAllowList) {
    driftFlags.push("entries_vs_allowlist");
  }
  if (
    enabledEntries !== null &&
    enabledCompat !== null &&
    enabledEntries !== enabledCompat
  ) {
    driftFlags.push("entries_vs_compat");
  }

  return {
    pluginId,
    npmName,
    enabled_allowlist: enabledAllowList,
    enabled_entries: enabledEntries,
    enabled_compat: enabledCompat,
    drift_flags: driftFlags,
  };
}

// ---------------------------------------------------------------------------
// Route handler
// ---------------------------------------------------------------------------

/**
 * Handle plugin management routes (/api/plugins/*, /api/secrets, /api/core/*).
 * Returns `true` if the request was handled.
 */
export async function handlePluginRoutes(
  ctx: PluginRouteContext,
): Promise<boolean> {
  const {
    req,
    res,
    method,
    pathname,
    state,
    json,
    error,
    readJsonBody,
    scheduleRuntimeRestart,
    restartRuntime,
    BLOCKED_ENV_KEYS,
    discoverInstalledPlugins,
    maskValue,
    aggregateSecrets,
    readProviderCache,
    paramKeyToCategory,
    buildPluginEvmDiagnosticEntry,
    EVM_PLUGIN_PACKAGE,
    applyWhatsAppQrOverride,
    applySignalQrOverride,
    resolvePluginConfigMutationRejections,
    requirePluginManager,
    requireCoreManager,
  } = ctx;

  const buildPluginsListSnapshot = async (): Promise<PluginEntry[]> => {
    let freshConfig: ElizaConfig;
    try {
      freshConfig = loadElizaConfig();
    } catch {
      freshConfig = state.config;
    }

    const bundledIds = new Set(state.plugins.map((p) => p.id));
    const installedEntries = discoverInstalledPlugins(freshConfig, bundledIds);
    const allPlugins: PluginEntry[] = [...state.plugins, ...installedEntries];
    let installedMetadataByName = new Map<
      string,
      {
        version?: string;
        releaseStream?: "latest" | "beta";
        requestedVersion?: string;
        latestVersion?: string | null;
        betaVersion?: string | null;
      }
    >();
    try {
      const pluginManager = requirePluginManager(state.runtime);
      const installed = await pluginManager.listInstalledPlugins();
      installedMetadataByName = new Map(
        installed.map((plugin) => [
          plugin.name,
          {
            version: plugin.version,
            releaseStream: plugin.releaseStream,
            requestedVersion: plugin.requestedVersion,
            latestVersion: plugin.latestVersion,
            betaVersion: plugin.betaVersion,
          },
        ]),
      );
    } catch {
      // Keep the plugin list working even when the plugin-manager service is unavailable.
    }
    const evmDiagnostic = buildPluginEvmDiagnosticEntry({
      config: state.config,
      runtime: state.runtime,
    });
    const existingEvmPlugin = allPlugins.find(
      (plugin) =>
        plugin.id === "evm" ||
        plugin.id === "wallet" ||
        plugin.npmName === EVM_PLUGIN_PACKAGE,
    );
    if (existingEvmPlugin) {
      existingEvmPlugin.autoEnabled = evmDiagnostic.autoEnabled;
      existingEvmPlugin.managementMode = "core-optional";
      existingEvmPlugin.capabilityStatus = evmDiagnostic.capabilityStatus;
      existingEvmPlugin.capabilityReason = evmDiagnostic.capabilityReason;
      existingEvmPlugin.prerequisites = evmDiagnostic.prerequisites;
      existingEvmPlugin.setupGuideUrl =
        existingEvmPlugin.setupGuideUrl ?? evmDiagnostic.setupGuideUrl;
      existingEvmPlugin.tags = Array.from(
        new Set([...(existingEvmPlugin.tags ?? []), ...evmDiagnostic.tags]),
      );
    } else {
      allPlugins.push(evmDiagnostic);
    }

    const configEntries = (
      freshConfig.plugins as Record<string, unknown> | undefined
    )?.entries as Record<string, { enabled?: boolean }> | undefined;
    const advancedCapabilitiesEnabled =
      resolveAdvancedCapabilitiesEnabled(freshConfig);
    const loadedNames = state.runtime
      ? state.runtime.plugins.map((p) => p.name)
      : [];
    for (const plugin of allPlugins) {
      const installedMetadata =
        (plugin.npmName ? installedMetadataByName.get(plugin.npmName) : null) ??
        installedMetadataByName.get(plugin.name);
      if (installedMetadata) {
        plugin.version = installedMetadata.version ?? plugin.version;
        plugin.releaseStream =
          installedMetadata.releaseStream ?? plugin.releaseStream;
        plugin.requestedVersion =
          installedMetadata.requestedVersion ?? plugin.requestedVersion;
        plugin.latestVersion =
          installedMetadata.latestVersion ?? plugin.latestVersion ?? null;
        plugin.betaVersion =
          installedMetadata.betaVersion ?? plugin.betaVersion ?? null;
      }

      if (isAdvancedCapabilityPluginId(plugin.id)) {
        const serviceType = ADVANCED_CAPABILITY_SERVICE_BY_PLUGIN_ID[plugin.id];
        plugin.enabled = advancedCapabilitiesEnabled;
        plugin.isActive = advancedCapabilitiesEnabled
          ? serviceType
            ? Boolean(state.runtime?.getService(serviceType))
            : Boolean(state.runtime)
          : false;
        plugin.autoEnabled = advancedCapabilitiesEnabled;
        plugin.loadError = undefined;
        continue;
      }

      const suffix = `plugin-${plugin.id}`;
      const packageName = `@elizaos/plugin-${plugin.id}`;
      const npmPkgName = plugin.npmName;
      const isLoaded =
        loadedNames.length > 0 &&
        loadedNames.some((name) => {
          return (
            name === plugin.id ||
            name === suffix ||
            name === packageName ||
            (npmPkgName != null && name === npmPkgName) ||
            name.endsWith(`/${suffix}`) ||
            name.includes(plugin.id)
          );
        });
      plugin.isActive = isLoaded;
      const configEntry = configEntries?.[plugin.id];
      if (configEntry && typeof configEntry.enabled === "boolean") {
        plugin.enabled = configEntry.enabled;
      } else {
        plugin.enabled = isLoaded;
      }
      plugin.loadError = undefined;
      if (plugin.enabled && !isLoaded && state.runtime) {
        const installs = freshConfig.plugins?.installs as
          | Record<string, unknown>
          | undefined;
        const packageName = `@elizaos/plugin-${plugin.id}`;
        const hasInstallRecord =
          installs?.[packageName] || installs?.[plugin.id];
        if (hasInstallRecord) {
          plugin.loadError =
            "Plugin installed but failed to load — the package may be missing compiled files.";
        }
      }
      if (
        plugin.id === "evm" ||
        plugin.id === "wallet" ||
        plugin.npmName === EVM_PLUGIN_PACKAGE
      ) {
        plugin.enabled = evmDiagnostic.enabled;
        plugin.isActive = evmDiagnostic.isActive;
        plugin.autoEnabled = evmDiagnostic.autoEnabled;
        plugin.managementMode = "core-optional";
        plugin.capabilityStatus = evmDiagnostic.capabilityStatus;
        plugin.capabilityReason = evmDiagnostic.capabilityReason;
        plugin.prerequisites = evmDiagnostic.prerequisites;
      }
    }

    for (const plugin of allPlugins) {
      for (const param of plugin.parameters) {
        const envValue = process.env[param.key];
        param.isSet = Boolean(envValue?.trim());
        param.currentValue = param.isSet
          ? param.sensitive
            ? maskValue(envValue ?? "")
            : (envValue ?? "")
          : null;
      }
      const paramInfos: PluginParamInfo[] = plugin.parameters.map((p) => ({
        key: p.key,
        required: p.required,
        sensitive: p.sensitive,
        type: p.type,
        description: p.description,
        default: p.default,
      }));
      const validation = validatePluginConfig(
        plugin.id,
        plugin.category,
        plugin.envKey,
        plugin.configKeys,
        undefined,
        paramInfos,
      );
      plugin.validationErrors = validation.errors;
      plugin.validationWarnings = validation.warnings;
    }

    applyWhatsAppQrOverride(allPlugins, resolveDefaultAgentWorkspaceDir());
    applySignalQrOverride(allPlugins, resolveDefaultAgentWorkspaceDir());

    for (const plugin of allPlugins) {
      const providerModels = readProviderCache(plugin.id)?.models ?? [];

      for (const param of plugin.parameters) {
        if (!param.key.toUpperCase().includes("MODEL")) continue;

        const expectedCat = paramKeyToCategory(param.key);
        const filtered = providerModels.filter(
          (m) => m.category === expectedCat,
        );

        if (!plugin.configUiHints) plugin.configUiHints = {};
        plugin.configUiHints[param.key] = {
          ...plugin.configUiHints[param.key],
          type: "select",
          options: filtered.map((m) => ({
            value: m.id,
            label: m.name !== m.id ? `${m.name} (${m.id})` : m.id,
          })),
        };
      }
    }

    // Attach widget declarations: prefer each plugin instance's own
    // `widgets` field (canonical), fall back to the static map for plugins
    // that have not migrated yet.
    const runtimePlugins = state.runtime?.plugins ?? [];
    const normalizeId = (value: string): string => {
      let v = value.trim();
      if (v.startsWith("@")) {
        const slash = v.indexOf("/");
        if (slash > 0) v = v.slice(slash + 1);
      }
      if (v.startsWith("plugin-")) v = v.slice("plugin-".length);
      if (v.startsWith("app-")) v = v.slice("app-".length);
      return v;
    };
    for (const plugin of allPlugins) {
      const widgets = getPluginWidgets(plugin.id, runtimePlugins);
      if (widgets.length > 0) {
        plugin.widgets = widgets;
      }
      const normalizedPluginId = normalizeId(plugin.id);
      const matchedRuntime = runtimePlugins.find(
        (p) => normalizeId(p.name) === normalizedPluginId,
      );
      if (matchedRuntime?.app) {
        const a = matchedRuntime.app;
        plugin.app = {
          displayName: a.displayName,
          category: a.category,
          icon: a.icon,
          developerOnly: a.developerOnly,
          visibleInAppStore: a.visibleInAppStore,
          navTabs: a.navTabs?.map((t) => ({
            id: t.id,
            label: t.label,
            icon: t.icon,
            path: t.path,
            order: t.order,
            developerOnly: t.developerOnly,
            group: t.group,
            componentExport: t.componentExport,
          })),
        };
      }
    }

    return allPlugins;
  };

  const resolvePluginsSnapshot = async (
    config: ElizaConfig,
  ): Promise<ResolvedPlugin[]> => {
    const { resolvePlugins } = await import("../runtime/plugin-resolver.ts");
    return await resolvePlugins(config, { quiet: true });
  };

  const resolvePluginsSnapshotSafe = async (
    config: ElizaConfig,
    reason: string,
  ): Promise<ResolvedPlugin[] | undefined> => {
    try {
      return await resolvePluginsSnapshot(config);
    } catch (err) {
      logger.warn(
        `[plugin-routes] Failed to resolve plugin snapshot for ${reason}: ${err instanceof Error ? err.message : String(err)}`,
      );
      return undefined;
    }
  };

  const npmNamePattern =
    /^(@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*$/;

  const validateRegistryPluginPackageName = (
    pluginName: string,
  ): string | null => {
    const trimmedName = pluginName.trim();
    if (!trimmedName) {
      return "Request body must include 'name' (plugin package name)";
    }
    if (!npmNamePattern.test(trimmedName)) {
      return "Invalid plugin name format";
    }
    return null;
  };

  // ── GET /api/plugins ────────────────────────────────────────────────────
  if (method === "GET" && pathname === "/api/plugins") {
    let inFlight = pluginsListInFlight.get(state);
    if (!inFlight) {
      inFlight = buildPluginsListSnapshot();
      pluginsListInFlight.set(state, inFlight);
    }
    const allPlugins = await inFlight.finally(() => {
      pluginsListInFlight.delete(state);
    });
    json(res, { plugins: allPlugins });
    return true;
  }

  // ── PUT /api/plugins/:id ────────────────────────────────────────────────
  if (method === "PUT" && pathname.startsWith("/api/plugins/")) {
    const pluginId = pathname.slice("/api/plugins/".length);
    const rawPlugin = await readJsonBody<Record<string, unknown>>(req, res);
    if (rawPlugin === null) return true;
    const parsedPlugin = PutPluginRequestSchema.safeParse(rawPlugin);
    if (!parsedPlugin.success) {
      error(
        res,
        parsedPlugin.error.issues[0]?.message ?? "Invalid request body",
        400,
      );
      return true;
    }
    const body = parsedPlugin.data;

    if (isElizaSettingsDebugEnabled()) {
      logger.debug(
        `[eliza][settings][api] PUT /api/plugins/${pluginId} body=${JSON.stringify(
          sanitizeForSettingsDebug({
            enabled: body.enabled,
            configKeys: body.config ? Object.keys(body.config).sort() : [],
            config: body.config ?? {},
          }),
        )}`,
      );
    }

    // Search both bundled plugins AND store-installed plugins
    let plugin = state.plugins.find((p) => p.id === pluginId);
    if (!plugin) {
      // Check store-installed plugins from config
      let freshCfg: ElizaConfig;
      try {
        freshCfg = loadElizaConfig();
      } catch {
        freshCfg = state.config;
      }
      const bundledIds = new Set(state.plugins.map((p) => p.id));
      const installed = discoverInstalledPlugins(freshCfg, bundledIds);
      const found = installed.find((p) => p.id === pluginId);
      if (found) {
        // Temporarily add to state.plugins so toggle logic works the same way
        state.plugins.push(found);
        plugin = found;
      }
    }
    if (!plugin) {
      error(res, `Plugin "${pluginId}" not found`, 404);
      return true;
    }

    const previousConfig = structuredClone(state.config);
    const previousResolvedPlugins = state.runtime
      ? await resolvePluginsSnapshotSafe(previousConfig, "plugin update")
      : undefined;

    if (body.enabled !== undefined) {
      plugin.enabled = body.enabled;
    }
    if (body.config) {
      const configRejections = resolvePluginConfigMutationRejections(
        plugin.parameters,
        body.config,
      );
      if (configRejections.length > 0) {
        json(
          res,
          { ok: false, plugin, validationErrors: configRejections },
          422,
        );
        return true;
      }

      // Only validate the fields actually being submitted — not all required
      // fields. Users may save partial config (e.g. just the API key) from
      // the Settings page; blocking the save because OTHER required fields
      // aren't set yet is counterproductive.
      const configObj = body.config;
      const submittedParamInfos: PluginParamInfo[] = plugin.parameters
        .filter((p) => p.key in configObj)
        .map((p) => ({
          key: p.key,
          required: p.required,
          sensitive: p.sensitive,
          type: p.type,
          description: p.description,
          default: p.default,
        }));
      const configValidation = validatePluginConfig(
        pluginId,
        plugin.category,
        plugin.envKey,
        plugin.configKeys,
        body.config,
        submittedParamInfos,
      );

      if (!configValidation.valid) {
        json(
          res,
          { ok: false, plugin, validationErrors: configValidation.errors },
          422,
        );
        return true;
      }

      const allowedParamKeys = new Set(plugin.parameters.map((p) => p.key));

      // Persist config values to state.config.env so they survive restarts
      if (!state.config.env) {
        state.config.env = {};
      }
      for (const [key, value] of Object.entries(body.config)) {
        if (
          allowedParamKeys.has(key) &&
          !BLOCKED_ENV_KEYS.has(key.toUpperCase()) &&
          typeof value === "string" &&
          value.trim()
        ) {
          process.env[key] = value;
          (state.config.env as Record<string, unknown>)[key] = value;
        }
      }
      plugin.configured = true;

      // Save config even when only config values changed (no enable toggle)
      if (body.enabled === undefined) {
        try {
          saveElizaConfig(state.config);
        } catch (err) {
          logger.warn(
            `[eliza-api] Failed to save config: ${err instanceof Error ? err.message : err}`,
          );
        }
      }
    }

    // Refresh validation
    const refreshParamInfos: PluginParamInfo[] = plugin.parameters.map((p) => ({
      key: p.key,
      required: p.required,
      sensitive: p.sensitive,
      type: p.type,
      description: p.description,
      default: p.default,
    }));
    const updated = validatePluginConfig(
      pluginId,
      plugin.category,
      plugin.envKey,
      plugin.configKeys,
      undefined,
      refreshParamInfos,
    );
    plugin.validationErrors = updated.errors;
    plugin.validationWarnings = updated.warnings;

    // Update config.plugins.entries so the runtime loads/skips this plugin
    if (body.enabled !== undefined) {
      if (isAdvancedCapabilityPluginId(pluginId)) {
        applyAdvancedCapabilitiesConfig(state.config, body.enabled);
        for (const candidate of state.plugins) {
          if (isAdvancedCapabilityPluginId(candidate.id)) {
            candidate.enabled = body.enabled;
          }
        }

        logger.info(
          `[eliza-api] ${body.enabled ? "Enabled" : "Disabled"} advanced capabilities via plugin alias: ${pluginId}`,
        );
      } else {
        const packageName = `@elizaos/plugin-${pluginId}`;

        if (!state.config.plugins) {
          state.config.plugins = {};
        }
        if (!state.config.plugins.entries) {
          (state.config.plugins as Record<string, unknown>).entries = {};
        }

        const entries = (state.config.plugins as Record<string, unknown>)
          .entries as Record<string, Record<string, unknown>>;
        entries[pluginId] = { enabled: body.enabled };

        // Keep plugins.allow aligned with entries[pluginId].enabled so the
        // enable-state drift check in buildCoreToggleDiagnostics() stays clean.
        state.config.plugins.allow = state.config.plugins.allow ?? [];
        const allow = state.config.plugins.allow;
        if (body.enabled) {
          if (!allow.includes(pluginId) && !allow.includes(packageName)) {
            allow.push(pluginId);
          }
        } else {
          state.config.plugins.allow = allow.filter(
            (p: string) => p !== pluginId && p !== packageName,
          );
        }

        logger.info(
          `[eliza-api] ${body.enabled ? "Enabled" : "Disabled"} plugin: ${packageName}`,
        );
      }

      // Persist capability toggle state in config.features so the runtime
      // can gate related behaviour (e.g. disabling image description when
      // vision is toggled off).
      const CAPABILITY_FEATURE_IDS = new Set([
        "vision",
        "browser",
        "computeruse",
        "coding-agent",
      ]);
      if (CAPABILITY_FEATURE_IDS.has(pluginId)) {
        if (!state.config.features) {
          state.config.features = {};
        }
        state.config.features[pluginId] = body.enabled;
      }

      // Save updated config
      try {
        saveElizaConfig(state.config);
      } catch (err) {
        logger.warn(
          `[eliza-api] Failed to save config: ${err instanceof Error ? err.message : err}`,
        );
      }
    }

    const runtimeApply = await applyPluginRuntimeMutation({
      runtime: state.runtime,
      previousConfig,
      nextConfig: state.config,
      previousResolvedPlugins,
      changedPluginId: pluginId,
      changedPluginPackage: plugin.npmName,
      config: body.config,
      expectRuntimeGraphChange: body.enabled !== undefined,
      reason:
        body.enabled !== undefined
          ? `Plugin toggle: ${pluginId}`
          : `Plugin config updated: ${pluginId}`,
      restartRuntime,
    });

    if (runtimeApply.requiresRestart) {
      scheduleRuntimeRestart(runtimeApply.reason);
    }

    if (isElizaSettingsDebugEnabled()) {
      const cloud = (state.config as Record<string, unknown>).cloud as
        | Record<string, unknown>
        | undefined;
      logger.debug(
        `[eliza][settings][api] PUT /api/plugins/${pluginId} → done configured=${plugin.configured} enabled=${plugin.enabled} cloud=${JSON.stringify(settingsDebugCloudSummary(cloud))}`,
      );
    }

    json(res, {
      ok: true,
      plugin,
      applied: runtimeApply.mode,
      requiresRestart: runtimeApply.requiresRestart,
      restartedRuntime: runtimeApply.restartedRuntime,
      loadedPackages: runtimeApply.loadedPackages,
      unloadedPackages: runtimeApply.unloadedPackages,
      reloadedPackages: runtimeApply.reloadedPackages,
    });
    return true;
  }

  // ── GET /api/secrets ─────────────────────────────────────────────────
  if (method === "GET" && pathname === "/api/secrets") {
    // Merge bundled + installed plugins for full parameter coverage
    const bundledIds = new Set(state.plugins.map((p) => p.id));
    const installedEntries = discoverInstalledPlugins(state.config, bundledIds);
    const allPlugins: PluginEntry[] = [...state.plugins, ...installedEntries];

    // Sync enabled status from runtime (same logic as GET /api/plugins)
    if (state.runtime) {
      const loadedNames = state.runtime.plugins.map((p) => p.name);
      for (const plugin of allPlugins) {
        const suffix = `plugin-${plugin.id}`;
        const packageName = `@elizaos/plugin-${plugin.id}`;
        plugin.enabled = loadedNames.some(
          (name) =>
            name === plugin.id ||
            name === suffix ||
            name === packageName ||
            name.endsWith(`/${suffix}`) ||
            name.includes(plugin.id),
        );
      }
    }

    const secrets = aggregateSecrets(allPlugins);
    json(res, { secrets });
    return true;
  }

  // ── PUT /api/secrets ─────────────────────────────────────────────────
  if (method === "PUT" && pathname === "/api/secrets") {
    const rawSecrets = await readJsonBody<Record<string, unknown>>(req, res);
    if (rawSecrets === null) return true;
    const parsedSecrets = PutSecretsRequestSchema.safeParse(rawSecrets);
    if (!parsedSecrets.success) {
      error(
        res,
        parsedSecrets.error.issues[0]?.message ?? "Invalid request body",
        400,
      );
      return true;
    }
    const body = parsedSecrets.data;

    // Build allowlist from all plugin-declared sensitive params
    const bundledIds = new Set(state.plugins.map((p) => p.id));
    const installedEntries = discoverInstalledPlugins(state.config, bundledIds);
    const allPlugins: PluginEntry[] = [...state.plugins, ...installedEntries];
    const allowedKeys = new Set<string>();
    for (const plugin of allPlugins) {
      for (const param of plugin.parameters) {
        if (param.sensitive) allowedKeys.add(param.key);
      }
    }

    const updatedKeys: string[] = [];
    for (const [key, value] of Object.entries(body.secrets)) {
      if (typeof value !== "string" || !value.trim()) continue;
      if (!allowedKeys.has(key)) continue;
      if (BLOCKED_ENV_KEYS.has(key.toUpperCase())) continue;
      process.env[key] = value;
      updatedKeys.push(key);
    }

    // Mark affected plugins as configured
    for (const plugin of allPlugins) {
      const pluginKeys = new Set(plugin.parameters.map((p) => p.key));
      if (updatedKeys.some((k) => pluginKeys.has(k))) {
        plugin.configured = true;
      }
    }

    json(res, { ok: true, updated: updatedKeys });
    return true;
  }

  // ── POST /api/plugins/:id/test ────────────────────────────────────────
  // Test a plugin's connection / configuration validity.
  const pluginTestMatch =
    method === "POST" && pathname.match(/^\/api\/plugins\/([^/]+)\/test$/);
  if (pluginTestMatch) {
    const pluginId = decodeURIComponent(pluginTestMatch[1]);
    const startMs = Date.now();

    try {
      // Find the plugin in the runtime
      const allPlugins = state.runtime?.plugins ?? [];
      const normalizePluginId = (value: string): string => {
        const scopedPackage = value.match(/^@[^/]+\/plugin-(.+)$/);
        if (scopedPackage) {
          return scopedPackage[1] ?? value;
        }
        return value.replace(/^@[^/]+\//, "").replace(/^plugin-/, "");
      };

      const normalizedPluginId = normalizePluginId(pluginId);

      const plugin = allPlugins.find((p: { id?: string; name?: string }) => {
        const runtimeName = p.name ?? "";
        const runtimeId = normalizePluginId(runtimeName);
        return (
          p.id === pluginId ||
          p.name === pluginId ||
          runtimeId === pluginId ||
          runtimeId === normalizedPluginId
        );
      });

      if (!plugin) {
        json(
          res,
          {
            success: false,
            pluginId,
            error: "Plugin not found or not loaded",
            durationMs: Date.now() - startMs,
          },
          404,
        );
        return true;
      }

      // Check if plugin exposes a test/health method
      const testFn = getPluginHealthProbe(plugin);
      if (typeof testFn === "function") {
        const result = await testFn();
        json(res, {
          success: result.ok !== false,
          pluginId,
          message:
            result.message ??
            (result.ok !== false
              ? "Connection successful"
              : "Connection failed"),
          durationMs: Date.now() - startMs,
        });
        return true;
      }

      // No test function — return a basic "plugin is loaded" status
      json(res, {
        success: true,
        pluginId,
        message: "Plugin is loaded and active (no custom test available)",
        durationMs: Date.now() - startMs,
      });
    } catch (err) {
      json(
        res,
        {
          success: false,
          pluginId,
          error: err instanceof Error ? err.message : String(err),
          durationMs: Date.now() - startMs,
        },
        500,
      );
    }
    return true;
  }

  // ── POST /api/plugins/install ───────────────────────────────────────────
  // Install a plugin from the registry and restart the agent.
  if (method === "POST" && pathname === "/api/plugins/install") {
    const rawInstall = await readJsonBody<Record<string, unknown>>(req, res);
    if (rawInstall === null) return true;
    const parsedInstall = PostPluginInstallRequestSchema.safeParse(rawInstall);
    if (!parsedInstall.success) {
      error(
        res,
        parsedInstall.error.issues[0]?.message ?? "Invalid request body",
        400,
      );
      return true;
    }
    const body = parsedInstall.data;
    const pluginName = body.name;

    const installValidationError =
      validateRegistryPluginPackageName(pluginName);
    if (installValidationError) {
      error(res, installValidationError, 400);
      return true;
    }

    try {
      const previousConfig = structuredClone(state.config);
      const previousResolvedPlugins = state.runtime
        ? await resolvePluginsSnapshotSafe(previousConfig, "plugin install")
        : undefined;
      const pluginManager = requirePluginManager(state.runtime);
      const result = await pluginManager.installPlugin(
        pluginName,
        (progress: InstallProgressLike) => {
          logger.info(`[install] ${progress.phase}: ${progress.message}`);
          state.broadcastWs?.({
            type: "install-progress",
            pluginName: progress.pluginName,
            phase: progress.phase,
            message: progress.message,
          });
        },
        {
          releaseStream: body.stream,
          version: body.version,
        },
      );

      if (!result.success) {
        json(res, { ok: false, error: result.error }, 422);
        return true;
      }

      // Auto-enable the newly installed plugin so the runtime loads it after restart.
      const installedId = (result.pluginName ?? pluginName)
        .replace(/^@[^/]+\/plugin-/, "")
        .replace(/^@[^/]+\//, "")
        .replace(/^plugin-/, "");
      if (!state.config.plugins) {
        state.config.plugins = {};
      }
      if (!state.config.plugins.entries) {
        (state.config.plugins as Record<string, unknown>).entries = {};
      }
      const pluginEntries = (state.config.plugins as Record<string, unknown>)
        .entries as Record<string, Record<string, unknown>>;
      pluginEntries[installedId] = { enabled: true };

      // Record the install path so plugin-resolver can find the package.
      // Without this, the downloaded package in ~/.eliza/plugins/installed/
      // is invisible to the runtime loader.
      if (result.installPath) {
        if (
          !(state.config.plugins as Record<string, unknown>).installs ||
          typeof (state.config.plugins as Record<string, unknown>).installs !==
            "object"
        ) {
          (state.config.plugins as Record<string, unknown>).installs = {};
        }
        const installs = (state.config.plugins as Record<string, unknown>)
          .installs as Record<string, Record<string, unknown>>;
        installs[result.pluginName ?? pluginName] = {
          source: "npm",
          requestedVersion: result.requestedVersion,
          releaseStream: result.releaseStream,
          installPath: result.installPath,
          version: result.version ?? "unknown",
          installedAt: new Date().toISOString(),
        };
      }

      try {
        saveElizaConfig(state.config);
      } catch (err) {
        logger.warn(
          `[eliza-api] Failed to save config after install: ${err instanceof Error ? err.message : err}`,
        );
      }

      const runtimeApply = await applyPluginRuntimeMutation({
        runtime: state.runtime,
        previousConfig,
        nextConfig: state.config,
        previousResolvedPlugins,
        changedPluginId: installedId,
        changedPluginPackage: result.pluginName,
        expectRuntimeGraphChange: true,
        reason: `Plugin ${result.pluginName} installed`,
        restartRuntime,
      });

      if (runtimeApply.requiresRestart && body.autoRestart !== false) {
        scheduleRuntimeRestart(runtimeApply.reason);
      }

      json(res, {
        ok: true,
        pluginName: result.pluginName,
        plugin: {
          name: result.pluginName,
          version: result.version,
          installPath: result.installPath,
        },
        applied: runtimeApply.mode,
        requiresRestart: runtimeApply.requiresRestart,
        restartedRuntime: runtimeApply.restartedRuntime,
        loadedPackages: runtimeApply.loadedPackages,
        unloadedPackages: runtimeApply.unloadedPackages,
        reloadedPackages: runtimeApply.reloadedPackages,
        releaseStream: result.releaseStream,
        requestedVersion: result.requestedVersion,
        latestVersion: result.latestVersion,
        betaVersion: result.betaVersion,
        message: runtimeApply.requiresRestart
          ? `${result.pluginName} installed. Restart required to activate.`
          : `${result.pluginName} installed.`,
      });
    } catch (err) {
      error(
        res,
        `Install failed: ${err instanceof Error ? err.message : String(err)}`,
        500,
      );
    }
    return true;
  }

  // ── POST /api/plugins/update ────────────────────────────────────────────
  if (method === "POST" && pathname === "/api/plugins/update") {
    const rawUpdate = await readJsonBody<Record<string, unknown>>(req, res);
    if (rawUpdate === null) return true;
    const parsedUpdate = PostPluginUpdateRequestSchema.safeParse(rawUpdate);
    if (!parsedUpdate.success) {
      error(
        res,
        parsedUpdate.error.issues[0]?.message ?? "Invalid request body",
        400,
      );
      return true;
    }
    const body = parsedUpdate.data;
    const pluginName = body.name;

    const updateValidationError = validateRegistryPluginPackageName(pluginName);
    if (updateValidationError) {
      error(res, updateValidationError, 400);
      return true;
    }

    try {
      const previousConfig = structuredClone(state.config);
      const previousResolvedPlugins = state.runtime
        ? await resolvePluginsSnapshotSafe(previousConfig, "plugin update")
        : undefined;
      const pluginManager = requirePluginManager(state.runtime);
      const updatePlugin =
        typeof pluginManager.updatePlugin === "function"
          ? pluginManager.updatePlugin.bind(pluginManager)
          : pluginManager.installPlugin.bind(pluginManager);
      const result = await updatePlugin(
        pluginName,
        (progress: InstallProgressLike) => {
          logger.info(`[update] ${progress.phase}: ${progress.message}`);
          state.broadcastWs?.({
            type: "install-progress",
            pluginName: progress.pluginName,
            phase: progress.phase,
            message: progress.message,
          });
        },
        {
          releaseStream: body.stream,
          version: body.version,
        },
      );

      if (!result.success) {
        json(res, { ok: false, error: result.error }, 422);
        return true;
      }

      if (!state.config.plugins) {
        state.config.plugins = {};
      }
      if (!state.config.plugins.entries) {
        state.config.plugins.entries = {};
      }
      const updatedId = (result.pluginName ?? pluginName)
        .replace(/^@[^/]+\/plugin-/, "")
        .replace(/^@[^/]+\//, "")
        .replace(/^plugin-/, "");
      state.config.plugins.entries[updatedId] = { enabled: true };
      state.config.plugins.installs = state.config.plugins.installs ?? {};
      state.config.plugins.installs[result.pluginName ?? pluginName] = {
        source: "npm",
        requestedVersion: result.requestedVersion,
        releaseStream: result.releaseStream,
        installPath: result.installPath,
        version: result.version ?? "unknown",
        installedAt: new Date().toISOString(),
      };

      try {
        saveElizaConfig(state.config);
      } catch (err) {
        logger.warn(
          `[eliza-api] Failed to save config after update: ${err instanceof Error ? err.message : err}`,
        );
      }

      const runtimeApply = await applyPluginRuntimeMutation({
        runtime: state.runtime,
        previousConfig,
        nextConfig: state.config,
        previousResolvedPlugins,
        changedPluginId: updatedId,
        changedPluginPackage: result.pluginName,
        forceReloadPackages: [result.pluginName],
        expectRuntimeGraphChange: true,
        reason: `Plugin ${result.pluginName} updated`,
        restartRuntime,
      });

      if (runtimeApply.requiresRestart && body.autoRestart !== false) {
        scheduleRuntimeRestart(runtimeApply.reason);
      }

      json(res, {
        ok: true,
        pluginName: result.pluginName,
        plugin: {
          name: result.pluginName,
          version: result.version,
          installPath: result.installPath,
        },
        applied: runtimeApply.mode,
        requiresRestart: runtimeApply.requiresRestart,
        restartedRuntime: runtimeApply.restartedRuntime,
        loadedPackages: runtimeApply.loadedPackages,
        unloadedPackages: runtimeApply.unloadedPackages,
        reloadedPackages: runtimeApply.reloadedPackages,
        releaseStream: result.releaseStream,
        requestedVersion: result.requestedVersion,
        latestVersion: result.latestVersion,
        betaVersion: result.betaVersion,
        message: runtimeApply.requiresRestart
          ? `${result.pluginName} updated. Restart required to activate.`
          : `${result.pluginName} updated.`,
      });
    } catch (err) {
      error(
        res,
        `Update failed: ${err instanceof Error ? err.message : String(err)}`,
        500,
      );
    }
    return true;
  }

  // ── POST /api/plugins/uninstall ─────────────────────────────────────────
  if (method === "POST" && pathname === "/api/plugins/uninstall") {
    const rawUninstall = await readJsonBody<Record<string, unknown>>(req, res);
    if (rawUninstall === null) return true;
    const parsedUninstall =
      PostPluginUninstallRequestSchema.safeParse(rawUninstall);
    if (!parsedUninstall.success) {
      error(
        res,
        parsedUninstall.error.issues[0]?.message ?? "Invalid request body",
        400,
      );
      return true;
    }
    const body = parsedUninstall.data;
    const pluginName = body.name;

    const uninstallValidationError =
      validateRegistryPluginPackageName(pluginName);
    if (uninstallValidationError) {
      error(res, uninstallValidationError, 400);
      return true;
    }

    try {
      const previousConfig = structuredClone(state.config);
      const previousResolvedPlugins = state.runtime
        ? await resolvePluginsSnapshotSafe(previousConfig, "plugin uninstall")
        : undefined;
      const pluginManager = requirePluginManager(state.runtime);
      const result = await pluginManager.uninstallPlugin(pluginName);

      if (!result.success) {
        json(res, { ok: false, error: result.error }, 422);
        return true;
      }

      const removedId = (result.pluginName ?? pluginName)
        .replace(/^@[^/]+\/plugin-/, "")
        .replace(/^@[^/]+\//, "")
        .replace(/^plugin-/, "");
      const installs = state.config.plugins?.installs;
      if (installs && typeof installs === "object") {
        delete installs[result.pluginName ?? pluginName];
      }
      const entries = state.config.plugins?.entries;
      if (entries && typeof entries === "object") {
        delete entries[removedId];
      }

      try {
        saveElizaConfig(state.config);
      } catch (err) {
        logger.warn(
          `[eliza-api] Failed to save config after uninstall: ${err instanceof Error ? err.message : err}`,
        );
      }

      const runtimeApply = await applyPluginRuntimeMutation({
        runtime: state.runtime,
        previousConfig,
        nextConfig: state.config,
        previousResolvedPlugins,
        changedPluginId: removedId,
        changedPluginPackage: result.pluginName,
        expectRuntimeGraphChange: true,
        reason: `Plugin ${pluginName} uninstalled`,
        restartRuntime,
      });

      if (runtimeApply.requiresRestart && body.autoRestart !== false) {
        scheduleRuntimeRestart(runtimeApply.reason);
      }

      json(res, {
        ok: true,
        pluginName: result.pluginName,
        applied: runtimeApply.mode,
        requiresRestart: runtimeApply.requiresRestart,
        restartedRuntime: runtimeApply.restartedRuntime,
        loadedPackages: runtimeApply.loadedPackages,
        unloadedPackages: runtimeApply.unloadedPackages,
        reloadedPackages: runtimeApply.reloadedPackages,
        message: runtimeApply.requiresRestart
          ? `${pluginName} uninstalled. Restart required.`
          : `${pluginName} uninstalled.`,
      });
    } catch (err) {
      error(
        res,
        `Uninstall failed: ${err instanceof Error ? err.message : String(err)}`,
        500,
      );
    }
    return true;
  }

  // ── POST /api/plugins/:id/eject ─────────────────────────────────────────
  if (method === "POST" && pathname.match(/^\/api\/plugins\/[^/]+\/eject$/)) {
    const pluginName = decodeURIComponent(
      pathname.slice("/api/plugins/".length, pathname.length - "/eject".length),
    );
    try {
      const previousConfig = structuredClone(state.config);
      const previousResolvedPlugins = state.runtime
        ? await resolvePluginsSnapshotSafe(previousConfig, "plugin eject")
        : undefined;
      const pluginManager = requirePluginManager(state.runtime);
      // Ensure the method exists on the service (it should)
      if (typeof pluginManager.ejectPlugin !== "function") {
        throw new Error("Plugin manager does not support ejecting plugins");
      }
      const result = await pluginManager.ejectPlugin(pluginName);
      if (!result.success) {
        json(res, { ok: false, error: result.error }, 422);
        return true;
      }
      const runtimeApply = await applyPluginRuntimeMutation({
        runtime: state.runtime,
        previousConfig,
        nextConfig: state.config,
        previousResolvedPlugins,
        changedPluginId: pluginName,
        changedPluginPackage: result.pluginName,
        forceReloadPackages: [result.pluginName],
        expectRuntimeGraphChange: true,
        reason: `Plugin ${pluginName} ejected`,
        restartRuntime,
      });
      if (runtimeApply.requiresRestart) {
        scheduleRuntimeRestart(runtimeApply.reason);
      }
      json(res, {
        ok: true,
        pluginName: result.pluginName,
        applied: runtimeApply.mode,
        requiresRestart: runtimeApply.requiresRestart,
        restartedRuntime: runtimeApply.restartedRuntime,
        loadedPackages: runtimeApply.loadedPackages,
        unloadedPackages: runtimeApply.unloadedPackages,
        reloadedPackages: runtimeApply.reloadedPackages,
        message: `${pluginName} ejected to local source.`,
      });
    } catch (err) {
      error(
        res,
        `Eject failed: ${err instanceof Error ? err.message : String(err)}`,
        500,
      );
    }
    return true;
  }

  // ── POST /api/plugins/:id/sync ──────────────────────────────────────────
  if (method === "POST" && pathname.match(/^\/api\/plugins\/[^/]+\/sync$/)) {
    const pluginName = decodeURIComponent(
      pathname.slice("/api/plugins/".length, pathname.length - "/sync".length),
    );
    try {
      const previousConfig = structuredClone(state.config);
      const previousResolvedPlugins = state.runtime
        ? await resolvePluginsSnapshotSafe(previousConfig, "plugin sync")
        : undefined;
      const pluginManager = requirePluginManager(state.runtime);
      if (typeof pluginManager.syncPlugin !== "function") {
        throw new Error("Plugin manager does not support syncing plugins");
      }
      const result = await pluginManager.syncPlugin(pluginName);
      if (!result.success) {
        json(res, { ok: false, error: result.error }, 422);
        return true;
      }
      const runtimeApply = await applyPluginRuntimeMutation({
        runtime: state.runtime,
        previousConfig,
        nextConfig: state.config,
        previousResolvedPlugins,
        changedPluginId: pluginName,
        changedPluginPackage: result.pluginName,
        forceReloadPackages: result.requiresRestart ? [result.pluginName] : [],
        expectRuntimeGraphChange: true,
        reason: `Plugin ${pluginName} synced`,
        restartRuntime,
      });
      if (runtimeApply.requiresRestart) {
        scheduleRuntimeRestart(runtimeApply.reason);
      }
      json(res, {
        ok: true,
        pluginName: result.pluginName,
        applied: runtimeApply.mode,
        requiresRestart: runtimeApply.requiresRestart,
        restartedRuntime: runtimeApply.restartedRuntime,
        loadedPackages: runtimeApply.loadedPackages,
        unloadedPackages: runtimeApply.unloadedPackages,
        reloadedPackages: runtimeApply.reloadedPackages,
        message: `${pluginName} synced with upstream.`,
      });
    } catch (err) {
      error(
        res,
        `Sync failed: ${err instanceof Error ? err.message : String(err)}`,
        500,
      );
    }
    return true;
  }

  // ── POST /api/plugins/:id/reinject ──────────────────────────────────────
  if (
    method === "POST" &&
    pathname.match(/^\/api\/plugins\/[^/]+\/reinject$/)
  ) {
    const pluginName = decodeURIComponent(
      pathname.slice(
        "/api/plugins/".length,
        pathname.length - "/reinject".length,
      ),
    );
    try {
      const previousConfig = structuredClone(state.config);
      const previousResolvedPlugins = state.runtime
        ? await resolvePluginsSnapshotSafe(previousConfig, "plugin reinject")
        : undefined;
      const pluginManager = requirePluginManager(state.runtime);
      if (typeof pluginManager.reinjectPlugin !== "function") {
        throw new Error("Plugin manager does not support reinjecting plugins");
      }
      const result = await pluginManager.reinjectPlugin(pluginName);
      if (!result.success) {
        json(res, { ok: false, error: result.error }, 422);
        return true;
      }
      const runtimeApply = await applyPluginRuntimeMutation({
        runtime: state.runtime,
        previousConfig,
        nextConfig: state.config,
        previousResolvedPlugins,
        changedPluginId: pluginName,
        changedPluginPackage: result.pluginName,
        forceReloadPackages: [result.pluginName],
        expectRuntimeGraphChange: true,
        reason: `Plugin ${pluginName} reinjected`,
        restartRuntime,
      });
      if (runtimeApply.requiresRestart) {
        scheduleRuntimeRestart(runtimeApply.reason);
      }
      json(res, {
        ok: true,
        pluginName: result.pluginName,
        applied: runtimeApply.mode,
        requiresRestart: runtimeApply.requiresRestart,
        restartedRuntime: runtimeApply.restartedRuntime,
        loadedPackages: runtimeApply.loadedPackages,
        unloadedPackages: runtimeApply.unloadedPackages,
        reloadedPackages: runtimeApply.reloadedPackages,
        message: `${pluginName} restored to registry version.`,
      });
    } catch (err) {
      error(
        res,
        `Reinject failed: ${err instanceof Error ? err.message : String(err)}`,
        500,
      );
    }
    return true;
  }

  // ── GET /api/plugins/installed ──────────────────────────────────────────
  // List plugins that were installed from the registry at runtime.
  if (method === "GET" && pathname === "/api/plugins/installed") {
    try {
      const pluginManager = requirePluginManager(state.runtime);
      const installed = await pluginManager.listInstalledPlugins();
      json(res, { count: installed.length, plugins: installed });
    } catch (err) {
      error(
        res,
        `Failed to list installed plugins: ${err instanceof Error ? err.message : String(err)}`,
        500,
      );
    }
    return true;
  }

  // ── GET /api/plugins/ejected ────────────────────────────────────────────
  // List plugins ejected to local source checkouts with upstream metadata.
  if (method === "GET" && pathname === "/api/plugins/ejected") {
    try {
      const pluginManager = requirePluginManager(state.runtime);
      if (typeof pluginManager.listEjectedPlugins !== "function") {
        throw new Error(
          "Plugin manager does not support listing ejected plugins",
        );
      }
      const plugins = await pluginManager.listEjectedPlugins();
      json(res, { count: plugins.length, plugins });
    } catch (err) {
      error(
        res,
        `Failed to list ejected plugins: ${err instanceof Error ? err.message : String(err)}`,
        500,
      );
    }
    return true;
  }

  // ── GET /api/core/status ────────────────────────────────────────────────
  // Returns whether @elizaos/core is ejected or resolved from npm.
  if (method === "GET" && pathname === "/api/core/status") {
    try {
      const coreManager = requireCoreManager(state.runtime);
      const coreStatus = await coreManager.getCoreStatus();
      json(res, coreStatus);
    } catch (err) {
      error(
        res,
        `Failed to get core status: ${err instanceof Error ? err.message : String(err)}`,
        500,
      );
    }
    return true;
  }

  // ── GET /api/plugins/core ────────────────────────────────────────────
  // Returns all core and optional core plugins with their loaded/running status.
  if (method === "GET" && pathname === "/api/plugins/core") {
    // Build a set of loaded plugin names for robust matching.
    // Plugin internal names vary wildly (e.g. "local-ai" for plugin-local-embedding,
    // "coding-tools" for plugin-coding-tools), so we check loaded names against multiple
    // derived forms of the npm package name.
    const loadedNames: Set<string> = state.runtime
      ? new Set(state.runtime.plugins.map((p: { name: string }) => p.name))
      : new Set<string>();

    const isLoaded = (npmName: string): boolean => {
      if (loadedNames.has(npmName)) return true;
      // @elizaos/plugin-foo -> plugin-foo
      const withoutScope = npmName.replace("@elizaos/", "");
      if (loadedNames.has(withoutScope)) return true;
      // plugin-foo -> foo
      const shortId = withoutScope.replace("plugin-", "");
      if (loadedNames.has(shortId)) return true;
      // Check if ANY loaded name contains the short id or vice versa
      for (const n of loadedNames) {
        if (n.includes(shortId) || shortId.includes(n)) return true;
      }
      return false;
    };

    // Check which optional plugins are currently in the allow list
    const allowList = new Set(state.config.plugins?.allow ?? []);

    const makeEntry = (npm: string, isCore: boolean) => {
      const id = optionalPluginListId(npm);
      return {
        npmName: npm,
        id,
        name: id
          .split("-")
          .map((w: string) => w.charAt(0).toUpperCase() + w.slice(1))
          .join(" "),
        isCore,
        loaded: isLoaded(npm),
        enabled: isCore || allowList.has(npm) || allowList.has(id),
      };
    };

    const coreList = CORE_PLUGINS.map((npm: string) => makeEntry(npm, true));
    const optionalList = OPTIONAL_CORE_PLUGINS.map((npm: string) =>
      makeEntry(npm, false),
    );

    json(res, { core: coreList, optional: optionalList });
    return true;
  }

  // ── POST /api/plugins/core/toggle ─────────────────────────────────────
  // Enable or disable an optional core plugin by updating the allow list.
  if (method === "POST" && pathname === "/api/plugins/core/toggle") {
    const rawToggle = await readJsonBody<Record<string, unknown>>(req, res);
    if (rawToggle === null) return true;
    const parsedToggle = PostPluginCoreToggleRequestSchema.safeParse(rawToggle);
    if (!parsedToggle.success) {
      error(
        res,
        parsedToggle.error.issues[0]?.message ?? "Invalid request body",
        400,
      );
      return true;
    }
    const body = parsedToggle.data;

    // Only allow toggling optional plugins, not core
    const isCorePlugin = (CORE_PLUGINS as readonly string[]).includes(
      body.npmName,
    );
    if (isCorePlugin) {
      error(res, "Core plugins cannot be disabled");
      return true;
    }
    const isOptional = (OPTIONAL_CORE_PLUGINS as readonly string[]).includes(
      body.npmName,
    );
    if (!isOptional) {
      error(res, "Unknown optional plugin");
      return true;
    }

    const previousConfig = structuredClone(state.config);
    const previousResolvedPlugins = state.runtime
      ? await resolvePluginsSnapshotSafe(previousConfig, "core plugin toggle")
      : undefined;

    // Update the allow list in config
    state.config.plugins = state.config.plugins ?? {};
    state.config.plugins.allow = state.config.plugins.allow ?? [];
    const allow = state.config.plugins.allow;
    const shortId = optionalPluginListId(body.npmName);

    if (body.enabled) {
      if (!allow.includes(body.npmName) && !allow.includes(shortId)) {
        allow.push(body.npmName);
      }
    } else {
      state.config.plugins.allow = allow.filter(
        (p: string) => p !== body.npmName && p !== shortId,
      );
    }

    // Keep plugins.entries.enabled aligned with the toggle so optional baked-in
    // plugins that use strict `enabled === true` entry rules stay consistent.
    const pluginsRoot = state.config.plugins as Record<string, unknown>;
    const prevEntries =
      (pluginsRoot.entries as
        | Record<string, { enabled?: boolean; [k: string]: unknown }>
        | undefined) ?? {};
    pluginsRoot.entries = {
      ...prevEntries,
      [shortId]: {
        ...prevEntries[shortId],
        enabled: body.enabled,
      },
    };

    try {
      saveElizaConfig(state.config);
    } catch (err) {
      logger.warn(
        `[api] Config save failed: ${err instanceof Error ? err.message : err}`,
      );
    }

    const runtimeApply = await applyPluginRuntimeMutation({
      runtime: state.runtime,
      previousConfig,
      nextConfig: state.config,
      previousResolvedPlugins,
      changedPluginId: shortId,
      changedPluginPackage: body.npmName,
      expectRuntimeGraphChange: true,
      reason: `Plugin ${shortId} ${body.enabled ? "enabled" : "disabled"}`,
      restartRuntime,
    });

    if (runtimeApply.requiresRestart) {
      scheduleRuntimeRestart(runtimeApply.reason);
    }

    json(res, {
      ok: true,
      applied: runtimeApply.mode,
      requiresRestart: runtimeApply.requiresRestart,
      restartedRuntime: runtimeApply.restartedRuntime,
      loadedPackages: runtimeApply.loadedPackages,
      unloadedPackages: runtimeApply.unloadedPackages,
      reloadedPackages: runtimeApply.reloadedPackages,
      diagnostics: (() => {
        const diagnostic = buildCoreToggleDiagnostics(
          state.config,
          body.npmName,
        );
        return diagnostic && diagnostic.drift_flags.length > 0
          ? {
              withDrift: true,
              plugin: diagnostic,
            }
          : undefined;
      })(),
      message: runtimeApply.requiresRestart
        ? `${shortId} ${body.enabled ? "enabled" : "disabled"}. Restart required.`
        : `${shortId} ${body.enabled ? "enabled" : "disabled"}.`,
    });
    return true;
  }

  return false;
}
