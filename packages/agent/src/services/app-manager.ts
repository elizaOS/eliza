/**
 * App Manager — manages app lifecycle: discover, install plugin, show viewer.
 *
 * Apps are hosted services. The manager's job is:
 * 1. List/search apps from the registry
 * 2. Install the game's plugin onto the agent (triggers restart)
 * 3. Return the viewer URL so the UI can embed the game client in an iframe
 *
 * @module services/app-manager
 */

import crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import type { IAgentRuntime, Plugin } from "@elizaos/core";
import { logger } from "@elizaos/core";
import {
  type AppLaunchDiagnostic,
  type AppLaunchPreparation,
  type AppLaunchResult,
  type AppRunActionResult,
  type AppRunAwaySummary,
  type AppRunCapabilityAvailability,
  type AppRunEvent,
  type AppRunSummary,
  type AppSessionJsonValue,
  type AppSessionState,
  type AppStopResult,
  type AppViewerAuthMessage,
  getElizaCuratedAppCatalogOrder,
  getElizaCuratedAppLookupNames,
  hasAppInterface,
  type InstalledAppInfo,
  normalizeElizaCuratedAppName,
  packageNameToAppDisplayName,
  packageNameToAppRouteSlug,
} from "@elizaos/shared";
import { loadElizaConfig, saveElizaConfig } from "../config/config.js";
import { shouldRestoreAgentsListAfterAppLaunch } from "./app-manager-agents-list-guard.js";
import {
  importAppPlugin,
  importAppRouteModule,
} from "./app-package-modules.js";
import { readAppRunStore, writeAppRunStore } from "./app-run-store.js";
import type {
  InstallProgressLike,
  PluginManagerLike,
  RegistryPluginInfo,
  RegistrySearchResult,
} from "./plugin-manager-types.js";
import { getPluginInfo, getRegistryPlugins } from "./registry-client.js";
import {
  mergeAppMeta as mergeRegistryAppMeta,
  resolveAppOverride,
} from "./registry-client-app-meta.js";
import {
  resolveAppHeroImage,
  scoreEntries,
  toSearchResults,
} from "./registry-client-queries.js";

const LOCAL_PLUGINS_DIR = "plugins";

export type {
  AppLaunchResult,
  AppRunActionResult,
  AppRunSummary,
  AppStopResult,
  AppViewerAuthMessage,
  InstalledAppInfo,
} from "@elizaos/shared";

const DEFAULT_VIEWER_SANDBOX = "allow-scripts allow-same-origin allow-popups";
const DEFAULT_RS_SDK_SERVER_URL = "https://rs-sdk-demo.fly.dev";
const HYPERSCAPE_APP_ROUTE_SLUG = "hyperscape";
const LOCAL_DEV_HYPERSCAPE_CLIENT_URL = "http://localhost:3333";
const PRODUCTION_HYPERSCAPE_CLIENT_URL = "https://hyperscape.gg";
const SAFE_APP_URL_PROTOCOLS = new Set(["http:", "https:"]);
const SAFE_APP_TEMPLATE_ENV_KEYS = new Set([
  "BOT_NAME",
  "HYPERSCAPE_CHARACTER_ID",
  "HYPERSCAPE_CLIENT_URL",
  "RS_SDK_BOT_NAME",
  "RS_SDK_BOT_PASSWORD",
  "RS_SDK_SERVER_URL",
]);
const RUN_REFRESH_MIN_INTERVAL_MS = 5_000;
const MAX_RUN_EVENTS = 20;
/**
 * How long a run can go without a heartbeat (UI ping or session refresh)
 * before the sweeper considers it abandoned and stops it. Tuned to comfortably
 * tolerate the 3s session-refresh poll + a few missed ticks on a slow tab,
 * while still reaping a closed/crashed browser within ~1.5 minutes.
 */
const RUN_HEARTBEAT_TIMEOUT_MS = 90_000;
/** How often the sweeper wakes to look for stale runs. */
const RUN_HEARTBEAT_SWEEP_INTERVAL_MS = 30_000;
const DEFAULT_REGISTRY_REFRESH_TIMEOUT_MS = 5_000;

type AgentsListSnapshot = unknown[] | undefined;

function cloneJsonValue<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function readAgentsListSnapshot(): AgentsListSnapshot {
  const list = loadElizaConfig().agents?.list;
  return Array.isArray(list) ? cloneJsonValue(list) : undefined;
}

function restoreAgentsListAfterAppLaunchIfNeeded(
  before: AgentsListSnapshot,
  appName: string,
  phase: string,
): void {
  const config = loadElizaConfig();
  const current = config.agents?.list;
  if (!shouldRestoreAgentsListAfterAppLaunch(before, current)) {
    return;
  }

  config.agents ??= {};
  if (!before) {
    delete config.agents.list;
  } else {
    config.agents.list = cloneJsonValue(before) as typeof config.agents.list;
  }
  saveElizaConfig(config);
  logger.warn(
    `[app-manager] Restored agents.list after ${appName} ${phase}; app launch must not replace the user's active character config.`,
  );
}

function isProductionRuntime(): boolean {
  return process.env.NODE_ENV === "production";
}

function resolveRegistryRefreshTimeoutMs(): number {
  const raw = process.env.ELIZA_APPS_REGISTRY_REFRESH_TIMEOUT_MS?.trim();
  if (!raw) return DEFAULT_REGISTRY_REFRESH_TIMEOUT_MS;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed >= 250
    ? parsed
    : DEFAULT_REGISTRY_REFRESH_TIMEOUT_MS;
}

async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  label: string,
): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => {
          reject(new Error(`${label} timed out after ${timeoutMs}ms`));
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

type AppViewerConfig = NonNullable<AppLaunchResult["viewer"]>;

interface RegistryAppPlugin extends RegistryPluginInfo {
  viewer?: {
    url: string;
    embedParams?: Record<string, string>;
    postMessageAuth?: boolean;
    sandbox?: string;
  };
  launchType?: "connect" | "local";
  launchUrl?: string;
  displayName?: string;
  runtimePlugin?: string;
  session?: {
    mode: AppSessionState["mode"];
    features?: Array<
      "commands" | "telemetry" | "pause" | "resume" | "suggestions"
    >;
  };
}

interface ActiveAppSession {
  runId: string;
  appName: string;
  pluginName: string;
  launchType: string;
  launchUrl: string | null;
  viewerUrl: string | null;
  startedAt: string;
}

interface AppManagerOptions {
  stateDir?: string;
  /**
   * How long a run can go without a heartbeat before the sweeper reaps it.
   * Defaults to {@link RUN_HEARTBEAT_TIMEOUT_MS}. Tests override to a small
   * value to exercise the sweeper deterministically.
   */
  heartbeatTimeoutMs?: number;
  /**
   * How often the sweeper wakes. Defaults to
   * {@link RUN_HEARTBEAT_SWEEP_INTERVAL_MS}. Tests can use a small value or
   * call {@link AppManager.reapStaleRuns} directly instead of starting the
   * sweeper interval.
   */
  heartbeatSweepIntervalMs?: number;
}

function isAppRegistryPlugin(
  plugin: RegistryPluginInfo,
): plugin is RegistryAppPlugin {
  return hasAppInterface(plugin);
}

function isHyperscapeAppName(appName: string): boolean {
  return packageNameToAppRouteSlug(appName) === HYPERSCAPE_APP_ROUTE_SLUG;
}

function resolveDisplayViewerInfo(
  viewer: RegistryPluginInfo["viewer"],
): RegistryPluginInfo["viewer"] {
  if (!viewer) return viewer;

  const embedParams = viewer.embedParams
    ? Object.fromEntries(
        Object.entries(viewer.embedParams)
          .map(([key, value]) => [key, substituteTemplateVars(value).trim()])
          .filter(([, value]) => value.length > 0),
      )
    : undefined;

  return {
    ...viewer,
    url: substituteTemplateVars(viewer.url),
    embedParams,
  };
}

function flattenAppInfo<T extends RegistryPluginInfo>(appInfo: T): T {
  const meta = appInfo.appMeta;
  if (!meta) return appInfo;
  return {
    ...appInfo,
    displayName: meta.displayName ?? appInfo.displayName,
    launchType: meta.launchType ?? appInfo.launchType,
    launchUrl:
      substituteTemplateVars(meta.launchUrl ?? appInfo.launchUrl ?? "") || null,
    icon: meta.icon ?? appInfo.icon,
    heroImage: resolveAppHeroImage(appInfo.name, meta.heroImage ?? null),
    category: meta.category ?? appInfo.category,
    capabilities: meta.capabilities ?? appInfo.capabilities,
    uiExtension: meta.uiExtension ?? appInfo.uiExtension,
    viewer: resolveDisplayViewerInfo(meta.viewer ?? appInfo.viewer),
    session: meta.session ?? appInfo.session,
  };
}

function cloneRegistryPluginInfo<T extends RegistryPluginInfo>(appInfo: T): T {
  return {
    ...appInfo,
    topics: [...appInfo.topics],
    npm: { ...appInfo.npm },
    git: { ...appInfo.git },
    supports: { ...appInfo.supports },
    appMeta: appInfo.appMeta
      ? {
          ...appInfo.appMeta,
          capabilities: [...appInfo.appMeta.capabilities],
          viewer: appInfo.appMeta.viewer
            ? {
                ...appInfo.appMeta.viewer,
                embedParams: appInfo.appMeta.viewer.embedParams
                  ? { ...appInfo.appMeta.viewer.embedParams }
                  : undefined,
              }
            : undefined,
          session: appInfo.appMeta.session
            ? {
                ...appInfo.appMeta.session,
                features: appInfo.appMeta.session.features
                  ? [...appInfo.appMeta.session.features]
                  : undefined,
              }
            : undefined,
        }
      : undefined,
  };
}

function canonicalizeCuratedRegistryPlugin<T extends RegistryPluginInfo>(
  appInfo: T,
  canonicalName: string,
): T {
  if (appInfo.name === canonicalName && appInfo.npm.package === canonicalName) {
    return cloneRegistryPluginInfo(appInfo);
  }

  const next = cloneRegistryPluginInfo(appInfo);
  next.name = canonicalName;
  // Only rewrite npm.package if it was derived from the name (no separate
  // runtime plugin). When npm.package differs from name (e.g. Hyperscape:
  // app=@hyperscape/plugin-hyperscape, plugin=@elizaos/plugin-hyperscape),
  // preserve the original so resolvePluginPackageName stays correct.
  if (!next.npm.package || next.npm.package === appInfo.name) {
    next.npm = {
      ...next.npm,
      package: canonicalName,
    };
  }
  return next;
}

function mergeCatalogVariant<T extends RegistryPluginInfo>(
  target: T,
  candidate: RegistryPluginInfo,
): T {
  mergeLocalRegistryInfo(target, candidate);
  target.stars = Math.max(target.stars, candidate.stars);
  return target;
}

function compareCuratedCatalogCandidates(
  left: RegistryPluginInfo,
  right: RegistryPluginInfo,
): number {
  const orderDiff =
    getElizaCuratedAppCatalogOrder(left.name) -
    getElizaCuratedAppCatalogOrder(right.name);
  if (orderDiff !== 0) {
    return orderDiff;
  }

  const leftCanonicalName = normalizeElizaCuratedAppName(left.name);
  const rightCanonicalName = normalizeElizaCuratedAppName(right.name);
  const leftCanonicalPenalty = left.name === leftCanonicalName ? 0 : 1;
  const rightCanonicalPenalty = right.name === rightCanonicalName ? 0 : 1;
  if (leftCanonicalPenalty !== rightCanonicalPenalty) {
    return leftCanonicalPenalty - rightCanonicalPenalty;
  }

  const leftLocalPenalty = left.localPath ? 0 : 1;
  const rightLocalPenalty = right.localPath ? 0 : 1;
  if (leftLocalPenalty !== rightLocalPenalty) {
    return leftLocalPenalty - rightLocalPenalty;
  }

  return right.stars - left.stars || left.name.localeCompare(right.name);
}

function curateCatalogApps(
  apps: Iterable<RegistryPluginInfo>,
): RegistryAppPlugin[] {
  const curated = new Map<string, RegistryAppPlugin>();
  const candidates = Array.from(apps).sort(compareCuratedCatalogCandidates);

  for (const app of candidates) {
    const canonicalName = normalizeElizaCuratedAppName(app.name);
    if (!canonicalName) {
      continue;
    }

    const normalized = canonicalizeCuratedRegistryPlugin(
      app,
      canonicalName,
    ) as RegistryAppPlugin;
    const existing = curated.get(canonicalName);
    if (!existing) {
      curated.set(canonicalName, normalized);
      continue;
    }

    mergeCatalogVariant(existing, normalized);
  }

  return Array.from(curated.values()).sort(compareCuratedCatalogCandidates);
}

async function resolveCuratedAppInfo(
  pluginManager: PluginManagerLike,
  name: string,
): Promise<RegistryAppPlugin | null> {
  const canonicalName = normalizeElizaCuratedAppName(name);
  if (!canonicalName) {
    return null;
  }

  const lookupNames = getElizaCuratedAppLookupNames(name);
  let appInfo: RegistryAppPlugin | null = null;

  for (const candidateName of lookupNames) {
    const remote = (await pluginManager.getRegistryPlugin(
      candidateName,
    )) as RegistryAppPlugin | null;
    if (!remote) {
      continue;
    }

    const normalized = canonicalizeCuratedRegistryPlugin(
      remote,
      canonicalName,
    ) as RegistryAppPlugin;
    if (!appInfo) {
      appInfo = normalized;
      continue;
    }

    mergeCatalogVariant(appInfo, normalized);
  }

  for (const candidateName of lookupNames) {
    const localPluginInfo = await getPluginInfo(candidateName).catch(
      () => null,
    );
    if (!localPluginInfo) {
      continue;
    }

    const normalized = canonicalizeCuratedRegistryPlugin(
      localPluginInfo,
      canonicalName,
    ) as RegistryAppPlugin;
    if (!appInfo) {
      appInfo = mergeLocalRegistryInfo(normalized, normalized);
      continue;
    }

    mergeCatalogVariant(appInfo, normalized);
  }

  if (!appInfo) {
    return null;
  }

  appInfo.appMeta = resolveEffectiveAppMeta(canonicalName, appInfo);
  return flattenAppInfo(appInfo);
}

async function resolveNamedAppInfo(
  pluginManager: PluginManagerLike,
  name: string,
): Promise<RegistryAppPlugin | null> {
  let appInfo = (await pluginManager.getRegistryPlugin(
    name,
  )) as RegistryAppPlugin | null;
  const localPluginInfo = await getPluginInfo(name).catch(() => null);

  if (localPluginInfo) {
    if (!appInfo) {
      appInfo = mergeLocalRegistryInfo(
        cloneRegistryPluginInfo(localPluginInfo) as RegistryAppPlugin,
        localPluginInfo,
      );
    } else {
      mergeLocalRegistryInfo(appInfo, localPluginInfo);
    }
  }

  if (!appInfo) {
    return null;
  }

  appInfo.appMeta = resolveEffectiveAppMeta(name, appInfo);
  return flattenAppInfo(appInfo);
}

function resolvePluginPackageName(appInfo: RegistryPluginInfo): string {
  const npmPackage = appInfo.npm.package.trim();
  return npmPackage && npmPackage.length > 0 ? npmPackage : appInfo.name;
}

function mergeAppMeta(
  appInfo: RegistryPluginInfo,
  meta: RegistryPluginInfo["appMeta"],
): void {
  if (!meta) return;
  appInfo.viewer = meta.viewer ?? appInfo.viewer;
  appInfo.launchUrl = meta.launchUrl ?? appInfo.launchUrl;
  appInfo.launchType = meta.launchType ?? appInfo.launchType;
  appInfo.displayName = meta.displayName ?? appInfo.displayName;
  appInfo.category = meta.category ?? appInfo.category;
  appInfo.capabilities = meta.capabilities ?? appInfo.capabilities;
  appInfo.icon = meta.icon ?? appInfo.icon;
  appInfo.runtimePlugin = meta.runtimePlugin ?? appInfo.runtimePlugin;
  appInfo.session = meta.session ?? appInfo.session;
}

function mergeLocalRegistryInfo<T extends RegistryPluginInfo>(
  appInfo: T,
  localInfo: RegistryPluginInfo,
): T {
  appInfo.localPath = localInfo.localPath ?? appInfo.localPath;
  appInfo.kind = localInfo.kind ?? appInfo.kind;
  appInfo.appMeta = localInfo.appMeta ?? appInfo.appMeta;
  if (!appInfo.description && localInfo.description) {
    appInfo.description = localInfo.description;
  }
  if (!appInfo.homepage && localInfo.homepage) {
    appInfo.homepage = localInfo.homepage;
  }
  mergeAppMeta(appInfo, localInfo.appMeta);
  return appInfo;
}

function deriveAppMetaFromPluginInfo(
  appInfo: RegistryPluginInfo &
    Partial<NonNullable<RegistryPluginInfo["appMeta"]>>,
): RegistryPluginInfo["appMeta"] | undefined {
  const hasTopLevelAppMeta =
    appInfo.displayName !== undefined ||
    appInfo.category !== undefined ||
    appInfo.launchType !== undefined ||
    appInfo.launchUrl !== undefined ||
    appInfo.icon !== undefined ||
    appInfo.heroImage !== undefined ||
    appInfo.capabilities !== undefined ||
    appInfo.runtimePlugin !== undefined ||
    appInfo.uiExtension !== undefined ||
    appInfo.viewer !== undefined ||
    appInfo.session !== undefined;

  if (!hasTopLevelAppMeta) {
    return undefined;
  }

  return {
    displayName:
      appInfo.displayName ?? packageNameToAppDisplayName(appInfo.name),
    category: appInfo.category ?? "game",
    launchType: appInfo.launchType ?? "url",
    launchUrl: appInfo.launchUrl ?? null,
    icon: appInfo.icon ?? null,
    heroImage: appInfo.heroImage ?? null,
    capabilities: appInfo.capabilities ?? [],
    minPlayers: null,
    maxPlayers: null,
    runtimePlugin: appInfo.runtimePlugin,
    uiExtension: appInfo.uiExtension,
    viewer: appInfo.viewer,
    session: appInfo.session,
  };
}

function resolveEffectiveAppMeta(
  packageName: string,
  appInfo: RegistryPluginInfo,
): RegistryPluginInfo["appMeta"] | undefined {
  const derivedAppMeta = deriveAppMetaFromPluginInfo(appInfo);
  const baseAppMeta = mergeRegistryAppMeta(derivedAppMeta, appInfo.appMeta);
  if (baseAppMeta) {
    return resolveAppOverride(packageName, baseAppMeta) ?? baseAppMeta;
  }
  return resolveAppOverride(packageName, undefined);
}

function isAutoInstallable(appInfo: RegistryPluginInfo): boolean {
  const supportsRuntime =
    appInfo.supports.v0 || appInfo.supports.v1 || appInfo.supports.v2;
  const hasVersion = Boolean(
    appInfo.npm.v0Version || appInfo.npm.v1Version || appInfo.npm.v2Version,
  );
  return supportsRuntime && hasVersion;
}

/**
 * Check if a plugin exists locally in the plugins/ directory.
 * Local plugins don't need to be installed - they're already available.
 */
function isLocalPlugin(appInfo: RegistryPluginInfo): boolean {
  const pluginsDir = path.resolve(process.cwd(), LOCAL_PLUGINS_DIR);
  if (!fs.existsSync(pluginsDir)) {
    return false;
  }

  // Check for directory names that match the app
  // E.g., @elizaos/app-babylon -> app-babylon
  const bareName = appInfo.name.replace(/^@[^/]+\//, "");
  const possibleDirs = [bareName, appInfo.name.replace("/", "-")];

  for (const dirName of possibleDirs) {
    const pluginPath = path.join(pluginsDir, dirName);
    const pluginJsonPath = path.join(pluginPath, "elizaos.plugin.json");
    if (fs.existsSync(pluginJsonPath)) {
      return true;
    }
  }

  return false;
}

function getTemplateFallbackValue(key: string): string | undefined {
  if (key === "RS_SDK_BOT_NAME") {
    const runtimeBotName = process.env.BOT_NAME?.trim();
    if (runtimeBotName && runtimeBotName.length > 0) {
      return runtimeBotName;
    }
    return undefined;
  }
  if (key === "RS_SDK_BOT_PASSWORD") {
    const runtimeBotPassword = process.env.BOT_PASSWORD?.trim();
    if (runtimeBotPassword && runtimeBotPassword.length > 0) {
      return runtimeBotPassword;
    }
    return undefined;
  }
  if (key === "RS_SDK_SERVER_URL") {
    return DEFAULT_RS_SDK_SERVER_URL;
  }
  return undefined;
}

function resolveSettingLike(
  runtime: IAgentRuntime | null | undefined,
  key: string,
): string | undefined {
  const fromRuntime = runtime?.getSetting?.(key);
  if (typeof fromRuntime === "string" && fromRuntime.trim().length > 0) {
    return fromRuntime.trim();
  }
  const fromEnv = process.env[key];
  if (typeof fromEnv === "string" && fromEnv.trim().length > 0) {
    return fromEnv.trim();
  }
  return undefined;
}

function readSafeTemplateEnv(key: string): string | undefined {
  if (!SAFE_APP_TEMPLATE_ENV_KEYS.has(key)) {
    return undefined;
  }
  const value = process.env[key];
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : undefined;
}

function substituteTemplateVars(
  raw: string,
  options?: {
    preserveUnknown?: boolean;
    /** Resolve `{HYPERSCAPE_CLIENT_URL}` for launch (not for catalog display). */
    hyperscapeClientDefault?: boolean;
    runtime?: IAgentRuntime | null;
  },
): string {
  const preserveUnknown = options?.preserveUnknown ?? true;
  const hyperscapeClientDefault = options?.hyperscapeClientDefault === true;
  return raw.replace(/\{([A-Z0-9_]+)\}/g, (_full, key: string) => {
    const value =
      (SAFE_APP_TEMPLATE_ENV_KEYS.has(key)
        ? resolveSettingLike(options?.runtime, key)
        : undefined) ??
      readSafeTemplateEnv(key) ??
      (hyperscapeClientDefault && key === "HYPERSCAPE_CLIENT_URL"
        ? isProductionRuntime()
          ? PRODUCTION_HYPERSCAPE_CLIENT_URL
          : LOCAL_DEV_HYPERSCAPE_CLIENT_URL
        : undefined) ??
      getTemplateFallbackValue(key);
    if (value !== undefined) {
      return value;
    }
    return preserveUnknown ? `{${key}}` : "";
  });
}

function buildViewerUrl(
  baseUrl: string,
  embedParams?: Record<string, string>,
  runtime?: IAgentRuntime | null,
): string {
  if (!embedParams || Object.keys(embedParams).length === 0) {
    return substituteTemplateVars(baseUrl, {
      preserveUnknown: false,
      hyperscapeClientDefault: true,
      runtime,
    });
  }
  const resolvedBaseUrl = substituteTemplateVars(baseUrl, {
    preserveUnknown: false,
    hyperscapeClientDefault: true,
    runtime,
  });
  const [beforeHash, hashPartRaw] = resolvedBaseUrl.split("#", 2);
  const [pathPart, queryPartRaw] = beforeHash.split("?", 2);
  const queryParams = new URLSearchParams(queryPartRaw ?? "");
  for (const [key, rawValue] of Object.entries(embedParams)) {
    const nextValue = substituteTemplateVars(rawValue, {
      preserveUnknown: false,
      hyperscapeClientDefault: true,
      runtime,
    }).trim();
    if (!nextValue) {
      queryParams.delete(key);
      continue;
    }
    queryParams.set(key, nextValue);
  }
  const query = queryParams.toString();
  const hash = hashPartRaw ? `#${hashPartRaw}` : "";
  return `${pathPart}${query.length > 0 ? `?${query}` : ""}${hash}`;
}

function resolveViewerEmbedParams(
  embedParams?: Record<string, string>,
  runtime?: IAgentRuntime | null,
): Record<string, string> | undefined {
  if (!embedParams) return undefined;
  const resolved = Object.fromEntries(
    Object.entries(embedParams)
      .map(([key, value]) => [
        key,
        substituteTemplateVars(value, {
          preserveUnknown: false,
          hyperscapeClientDefault: true,
          runtime,
        }).trim(),
      ])
      .filter(([, value]) => value.length > 0),
  );
  return Object.keys(resolved).length > 0 ? resolved : undefined;
}

function normalizeSafeAppUrl(url: string): string | null {
  const trimmed = url.trim();
  if (!trimmed) return null;

  if (trimmed.startsWith("/")) {
    // Disallow protocol-relative form (`//evil.test`) which escapes same-origin.
    return trimmed.startsWith("//") ? null : trimmed;
  }

  try {
    const parsed = new URL(trimmed);
    if (!SAFE_APP_URL_PROTOCOLS.has(parsed.protocol)) {
      return null;
    }
    return trimmed;
  } catch {
    return null;
  }
}

async function buildViewerAuthMessage(
  appInfo: RegistryAppPlugin,
  launchUrl: string | null,
  runtime?: IAgentRuntime | null,
): Promise<AppViewerAuthMessage | undefined> {
  const postMessageAuth = appInfo.viewer?.postMessageAuth;
  if (!postMessageAuth) return undefined;

  const routeModule = await importAppRouteModule(appInfo.name);
  if (typeof routeModule?.resolveViewerAuthMessage === "function") {
    return (
      (await routeModule.resolveViewerAuthMessage({
        appName: appInfo.name,
        launchUrl,
        runtime: runtime ?? null,
        viewer: null,
      })) ?? undefined
    );
  }

  return undefined;
}

async function buildViewerConfig(
  appInfo: RegistryAppPlugin,
  launchUrl: string | null,
  runtime?: IAgentRuntime | null,
): Promise<AppViewerConfig | null> {
  const viewerInfo = appInfo.viewer;
  if (viewerInfo) {
    const requestedPostMessageAuth = Boolean(viewerInfo.postMessageAuth);
    const authMessage = await buildViewerAuthMessage(
      appInfo,
      launchUrl,
      runtime,
    );
    const postMessageAuth = requestedPostMessageAuth && Boolean(authMessage);
    if (requestedPostMessageAuth && !authMessage) {
      logger.warn(
        `[app-manager] ${appInfo.name} requires postMessage auth but no auth payload was generated.`,
      );
    }
    const resolvedEmbedParams = {
      ...(resolveViewerEmbedParams(viewerInfo.embedParams, runtime) ?? {}),
    };
    if (authMessage?.followEntity && !resolvedEmbedParams.followEntity) {
      resolvedEmbedParams.followEntity = authMessage.followEntity;
    }
    const finalEmbedParams =
      Object.keys(resolvedEmbedParams).length > 0
        ? resolvedEmbedParams
        : undefined;
    const viewerUrl = normalizeSafeAppUrl(
      buildViewerUrl(viewerInfo.url, finalEmbedParams, runtime),
    );
    if (!viewerUrl) {
      throw new Error(
        `Refusing to launch app "${appInfo.name}": unsafe viewer URL`,
      );
    }

    return {
      url: viewerUrl,
      embedParams: finalEmbedParams,
      postMessageAuth,
      sandbox: viewerInfo.sandbox ?? DEFAULT_VIEWER_SANDBOX,
      authMessage,
    };
  }
  if (
    (appInfo.launchType === "connect" || appInfo.launchType === "local") &&
    launchUrl
  ) {
    const viewerUrl = normalizeSafeAppUrl(launchUrl);
    if (!viewerUrl) {
      throw new Error(
        `Refusing to launch app "${appInfo.name}": unsafe launch URL`,
      );
    }
    return {
      url: viewerUrl,
      sandbox: DEFAULT_VIEWER_SANDBOX,
    };
  }
  return null;
}

function buildAppSession(
  appInfo: RegistryAppPlugin,
  authMessage: AppViewerAuthMessage | undefined,
  runtime?: IAgentRuntime | null,
): AppSessionState | null {
  if (!appInfo.session) return null;

  const runtimeAgentId =
    typeof runtime?.agentId === "string" && runtime.agentId.trim().length > 0
      ? runtime.agentId
      : undefined;
  const sessionId =
    authMessage?.agentId || authMessage?.characterId || runtimeAgentId;
  if (!sessionId) return null;
  const features = new Set(appInfo.session.features ?? []);
  const controls: AppSessionState["controls"] = [];
  if (features.has("pause")) {
    controls.push("pause");
  }
  if (features.has("resume")) {
    controls.push("resume");
  }
  const canSendCommands =
    features.has("commands") || features.has("suggestions");
  const characterId =
    authMessage?.characterId ??
    (isHyperscapeAppName(appInfo.name)
      ? resolveSettingLike(runtime, "HYPERSCAPE_CHARACTER_ID")
      : undefined);
  const followEntity = authMessage?.followEntity ?? characterId ?? undefined;

  return {
    sessionId,
    appName: appInfo.name,
    mode: appInfo.session.mode,
    status: "connecting",
    displayName: appInfo.displayName ?? appInfo.name,
    agentId: authMessage?.agentId ?? runtimeAgentId,
    characterId,
    followEntity,
    canSendCommands,
    controls,
    summary: "Connecting session...",
  };
}

function buildUnavailableSession(
  run: AppRunSummary,
  status: "disconnected" | "offline",
  summary: string,
): AppSessionState | null {
  if (!run.session) return null;
  return {
    ...run.session,
    status,
    canSendCommands: false,
    controls: [],
    goalLabel: null,
    suggestedPrompts: [],
    telemetry: null,
    summary,
  };
}

async function resolveLaunchSession(
  appInfo: RegistryAppPlugin,
  viewer: AppLaunchResult["viewer"] | null,
  launchUrl: string | null,
  runtime: IAgentRuntime | null,
): Promise<AppSessionState | null> {
  const routeModule = await importAppRouteModule(appInfo.name);
  if (typeof routeModule?.resolveLaunchSession === "function") {
    return routeModule.resolveLaunchSession({
      appName: appInfo.name,
      launchUrl,
      runtime,
      viewer,
    });
  }

  return buildAppSession(appInfo, viewer?.authMessage, runtime);
}

/**
 * Invoke the plugin's `stopRun` bridge hook (if defined) when an app run is
 * removed. Plugins use this to tear down per-run resources (WebSocket
 * connections, game-loop timers, bot sessions, embedded servers).
 *
 * Errors are logged but never re-thrown — removal from the app-manager
 * registry is authoritative.
 */
async function invokeAppStopRunHook(
  run: AppRunSummary,
  runtime: IAgentRuntime | null,
): Promise<void> {
  try {
    const routeModule = await importAppRouteModule(run.appName);
    if (typeof routeModule?.stopRun !== "function") {
      return;
    }
    await routeModule.stopRun({
      appName: run.appName,
      launchUrl: run.launchUrl,
      runtime,
      viewer: run.viewer,
      runId: run.runId,
      session: run.session,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.warn(
      `[app-manager] stopRun hook for "${run.appName}" (runId=${run.runId}) failed: ${message}`,
    );
  }
}

async function prepareLaunch(
  appInfo: RegistryAppPlugin,
  launchUrl: string | null,
  runtime: IAgentRuntime | null,
): Promise<AppLaunchPreparation> {
  const routeModule = await importAppRouteModule(appInfo.name);

  if (typeof routeModule?.prepareLaunch === "function") {
    return (
      (await routeModule.prepareLaunch({
        appName: appInfo.name,
        launchUrl,
        runtime,
        viewer: null,
      })) ?? {}
    );
  }

  return {};
}

function mergePreparedViewer(
  base: RegistryAppPlugin["viewer"],
  override: NonNullable<AppLaunchPreparation["viewer"]>,
): RegistryAppPlugin["viewer"] {
  return {
    ...(base ?? {}),
    ...override,
    embedParams: {
      ...(base?.embedParams ?? {}),
      ...(override.embedParams ?? {}),
    },
  };
}

function applyLaunchPreparation(
  appInfo: RegistryAppPlugin,
  preparation: AppLaunchPreparation,
): RegistryAppPlugin {
  const launchUrl =
    preparation.launchUrl !== undefined
      ? (preparation.launchUrl ?? undefined)
      : appInfo.launchUrl;
  const viewer =
    preparation.viewer === undefined
      ? appInfo.viewer
      : preparation.viewer === null
        ? undefined
        : mergePreparedViewer(appInfo.viewer, preparation.viewer);

  return {
    ...appInfo,
    launchUrl,
    viewer,
  };
}

function isRuntimePluginActive(
  appInfo: RegistryAppPlugin,
  runtime: IAgentRuntime | null,
): boolean {
  if (!runtime || !Array.isArray(runtime.plugins)) {
    return false;
  }

  const pluginNames = new Set<string>([
    appInfo.name,
    appInfo.runtimePlugin ?? resolvePluginPackageName(appInfo),
  ]);
  return runtime.plugins.some(
    (plugin) =>
      typeof plugin?.name === "string" && pluginNames.has(plugin.name),
  );
}

function isRuntimePluginReady(
  appInfo: RegistryAppPlugin,
  runtime: IAgentRuntime | null,
): boolean {
  if (!isRuntimePluginActive(appInfo, runtime)) {
    return false;
  }
  if (isHyperscapeAppName(appInfo.name)) {
    return Boolean(
      runtime?.hasService?.("hyperscapeService") ||
        runtime?.getService?.("hyperscapeService"),
    );
  }
  return true;
}

function getRuntimePluginCandidates(appInfo: RegistryAppPlugin): string[] {
  const candidates = [
    appInfo.runtimePlugin,
    appInfo.name,
    resolvePluginPackageName(appInfo),
  ];
  return Array.from(
    new Set(
      candidates.filter(
        (candidate): candidate is string =>
          typeof candidate === "string" && candidate.trim().length > 0,
      ),
    ),
  );
}

async function collectLaunchDiagnostics(
  appInfo: RegistryAppPlugin,
  viewer: AppViewerConfig | null,
  session: AppSessionState | null,
  launchUrl: string | null,
  runtime: IAgentRuntime | null,
): Promise<AppLaunchDiagnostic[]> {
  const routeModule = await importAppRouteModule(appInfo.name);
  const diagnosticViewer =
    viewer && appInfo.viewer?.postMessageAuth && !viewer.authMessage
      ? { ...viewer, postMessageAuth: true }
      : viewer;
  if (typeof routeModule?.collectLaunchDiagnostics === "function") {
    return routeModule.collectLaunchDiagnostics({
      appName: appInfo.name,
      launchUrl,
      runtime,
      viewer: diagnosticViewer,
      session,
    });
  }
  return [];
}

async function ensureRuntimePluginRegistered(
  appInfo: RegistryAppPlugin,
  runtime: IAgentRuntime | null,
  isLocal: boolean,
): Promise<boolean> {
  if (!runtime) {
    return false;
  }

  if (isRuntimePluginReady(appInfo, runtime)) {
    return true;
  }

  const pluginNames = getRuntimePluginCandidates(appInfo);
  for (const pluginPackageName of pluginNames) {
    let plugin: Plugin | null = null;
    try {
      plugin = await importAppPlugin(pluginPackageName);
    } catch (err) {
      logger.warn(
        `[app-manager] importAppPlugin(${pluginPackageName}) threw: ${err instanceof Error ? err.message : String(err)}`,
      );
      continue;
    }
    if (!plugin) {
      continue;
    }

    try {
      await runtime.registerPlugin(plugin);
    } catch (err) {
      logger.warn(
        `[app-manager] registerPlugin(${plugin.name}) threw: ${err instanceof Error ? err.message : String(err)}`,
      );
      continue;
    }
    if (isRuntimePluginReady(appInfo, runtime)) {
      return true;
    }
  }

  if (!isLocal) {
    return false;
  }

  throw new Error(
    `Local runtime plugin for "${appInfo.name}" could not be loaded.`,
  );
}

async function ensureRuntimeReady(
  appInfo: RegistryAppPlugin,
  viewer: AppViewerConfig | null,
  launchUrl: string | null,
  runtime: IAgentRuntime | null,
): Promise<void> {
  if (!runtime) {
    return;
  }
  const routeModule = await importAppRouteModule(appInfo.name);
  if (typeof routeModule?.ensureRuntimeReady !== "function") {
    return;
  }
  const ctx = {
    appName: appInfo.name,
    launchUrl,
    runtime,
    viewer,
  };
  try {
    await routeModule.ensureRuntimeReady(ctx);
  } catch (error) {
    const pluginNames = getRuntimePluginCandidates(appInfo);
    let recovered = false;
    for (const pluginPackageName of pluginNames) {
      const plugin = await importAppPlugin(pluginPackageName);
      if (!plugin) {
        continue;
      }
      await runtime.registerPlugin(plugin);
      recovered = true;
    }
    if (!recovered) {
      throw error;
    }
    await routeModule.ensureRuntimeReady(ctx);
  }
}

function deriveRunHealth(
  status: string,
  summary: string | null,
): AppRunSummary["health"] {
  const normalized = status.trim().toLowerCase();

  if (
    normalized === "running" ||
    normalized === "connected" ||
    normalized === "active"
  ) {
    return {
      state: "healthy",
      message: summary,
    };
  }

  if (
    normalized === "stopped" ||
    normalized === "offline" ||
    normalized === "error" ||
    normalized === "failed"
  ) {
    return {
      state: "offline",
      message: summary,
    };
  }

  return {
    state: "degraded",
    message: summary,
  };
}

function buildRunEvent(input: {
  kind: AppRunEvent["kind"];
  message: string;
  severity?: AppRunEvent["severity"];
  status?: string | null;
  details?: Record<string, AppSessionJsonValue> | null;
  createdAt?: string;
}): AppRunEvent {
  return {
    eventId: crypto.randomUUID(),
    kind: input.kind,
    severity: input.severity ?? "info",
    message: input.message,
    createdAt: input.createdAt ?? new Date().toISOString(),
    status: input.status ?? null,
    details: input.details ?? null,
  };
}

function normalizeRunEvents(events: AppRunEvent[]): AppRunEvent[] {
  return [...events]
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .slice(0, MAX_RUN_EVENTS);
}

function deriveChatAvailability(
  session: AppSessionState | null,
): AppRunCapabilityAvailability {
  if (!session) {
    return "unknown";
  }
  return session.canSendCommands ? "available" : "unavailable";
}

function deriveControlAvailability(
  session: AppSessionState | null,
): AppRunCapabilityAvailability {
  if (!session) {
    return "unknown";
  }
  return session.canSendCommands || (session.controls?.length ?? 0) > 0
    ? "available"
    : "unavailable";
}

function deriveHealthFacetState(
  availability: AppRunCapabilityAvailability,
): AppRunSummary["healthDetails"]["auth"]["state"] {
  if (availability === "available") {
    return "healthy";
  }
  if (availability === "unavailable") {
    return "degraded";
  }
  return "unknown";
}

function deriveRunHealthDetails(
  run: AppRunSummary,
): AppRunSummary["healthDetails"] {
  const viewerState: AppRunSummary["healthDetails"]["viewer"]["state"] =
    !run.viewer
      ? "unknown"
      : run.viewerAttachment === "attached"
        ? "healthy"
        : run.viewerAttachment === "detached"
          ? "degraded"
          : "offline";
  const authState: AppRunSummary["healthDetails"]["auth"]["state"] = run.session
    ? run.viewerAttachment === "attached" || run.viewer == null
      ? "healthy"
      : "degraded"
    : "unknown";

  return {
    checkedAt: run.updatedAt,
    auth: {
      state: authState,
      message: run.session?.summary ?? run.summary,
    },
    runtime: {
      state: run.health.state,
      message: run.health.message,
    },
    viewer: {
      state: viewerState,
      message:
        run.viewerAttachment === "attached"
          ? "Viewer attached."
          : run.viewerAttachment === "detached"
            ? "Viewer detached."
            : "Viewer unavailable.",
    },
    chat: {
      state: deriveHealthFacetState(run.chatAvailability),
      message:
        run.chatAvailability === "available"
          ? "Operator chat is available."
          : run.chatAvailability === "unavailable"
            ? "Operator chat is unavailable."
            : "Operator chat availability is unknown.",
    },
    control: {
      state: deriveHealthFacetState(run.controlAvailability),
      message:
        run.controlAvailability === "available"
          ? "Control actions are available."
          : run.controlAvailability === "unavailable"
            ? "Control actions are unavailable."
            : "Control availability is unknown.",
    },
    message: run.health.message,
  };
}

function deriveAwaySummary(run: AppRunSummary): AppRunAwaySummary {
  const recent = run.recentEvents.slice(0, 3).map((event) => event.message);
  return {
    generatedAt: run.updatedAt,
    message:
      recent.length > 0
        ? recent.join(" ")
        : (run.summary ?? `${run.displayName} is ${run.status}.`),
    eventCount: run.recentEvents.length,
    since: run.recentEvents.at(-1)?.createdAt ?? run.startedAt,
    until: run.recentEvents[0]?.createdAt ?? run.updatedAt,
  };
}

function normalizeRunSummary(run: AppRunSummary): AppRunSummary {
  const status = run.session?.status ?? run.status;
  const summary = run.session?.summary ?? run.summary;
  const next: AppRunSummary = {
    ...run,
    characterId: run.characterId ?? run.session?.characterId ?? null,
    agentId: run.agentId ?? run.session?.agentId ?? null,
    chatAvailability: deriveChatAvailability(run.session),
    controlAvailability: deriveControlAvailability(run.session),
    supportsViewerDetach:
      typeof run.supportsViewerDetach === "boolean"
        ? run.supportsViewerDetach
        : Boolean(run.supportsBackground),
    recentEvents: normalizeRunEvents(run.recentEvents),
    status,
    summary,
    lastHeartbeatAt: run.session ? run.updatedAt : run.lastHeartbeatAt,
    health: deriveRunHealth(status, summary),
  };

  return {
    ...next,
    awaySummary: deriveAwaySummary(next),
    healthDetails: deriveRunHealthDetails(next),
  };
}

function buildRunSummary(input: {
  runId: string;
  appName: string;
  displayName: string;
  pluginName: string;
  launchType: string;
  launchUrl: string | null;
  viewer: AppViewerConfig | null;
  session: AppSessionState | null;
  startedAt?: string;
  viewerAttachment?: AppRunSummary["viewerAttachment"];
}): AppRunSummary {
  const now = new Date().toISOString();
  const status =
    input.session?.status ?? (input.viewer ? "running" : "launching");
  const summary = input.session?.summary ?? null;
  const health = deriveRunHealth(status, summary);

  return normalizeRunSummary({
    runId: input.runId,
    appName: input.appName,
    displayName: input.displayName,
    pluginName: input.pluginName,
    launchType: input.launchType,
    launchUrl: input.launchUrl,
    viewer: input.viewer,
    session: input.session,
    characterId: input.session?.characterId ?? null,
    agentId: input.session?.agentId ?? null,
    status,
    summary,
    startedAt: input.startedAt ?? now,
    updatedAt: now,
    lastHeartbeatAt: input.session ? now : null,
    supportsBackground: true,
    viewerAttachment:
      input.viewerAttachment ?? (input.viewer ? "attached" : "unavailable"),
    chatAvailability: deriveChatAvailability(input.session),
    controlAvailability: deriveControlAvailability(input.session),
    supportsViewerDetach: true,
    recentEvents: [
      buildRunEvent({
        kind: "launch",
        message:
          summary ??
          `${input.displayName} launched with ${input.viewer ? "a viewer" : "no viewer"}.`,
        status,
        details: {
          runId: input.runId,
          appName: input.appName,
          viewerAttachment:
            input.viewerAttachment ??
            (input.viewer ? "attached" : "unavailable"),
          characterId: input.session?.characterId ?? null,
          agentId: input.session?.agentId ?? null,
        },
      }),
    ],
    awaySummary: null,
    health,
    healthDetails: {
      checkedAt: now,
      auth: {
        state: "unknown",
        message: summary,
      },
      runtime: {
        state: health.state,
        message: summary,
      },
      viewer: {
        state: "unknown",
        message: null,
      },
      chat: {
        state: "unknown",
        message: null,
      },
      control: {
        state: "unknown",
        message: null,
      },
      message: summary,
    },
  });
}

function updateRunSummary(
  run: AppRunSummary,
  patch: Partial<AppRunSummary>,
  event?: Parameters<typeof buildRunEvent>[0],
): AppRunSummary {
  const updatedAt = new Date().toISOString();
  const next = normalizeRunSummary({
    ...run,
    ...patch,
    updatedAt,
    lastHeartbeatAt: patch.session ? updatedAt : run.lastHeartbeatAt,
    recentEvents: event
      ? normalizeRunEvents([
          buildRunEvent({
            ...event,
            createdAt: updatedAt,
          }),
          ...run.recentEvents,
        ])
      : run.recentEvents,
  } satisfies AppRunSummary);

  return next;
}

function sameRunIdentity(
  run: AppRunSummary,
  appName: string,
  session: AppSessionState | null,
  viewer: AppViewerConfig | null,
): boolean {
  if (run.appName !== appName) return false;
  if (session?.sessionId && run.session?.sessionId === session.sessionId) {
    return true;
  }
  return Boolean(viewer?.url && run.viewer?.url === viewer.url);
}

export class AppManager {
  private readonly activeSessions = new Map<string, ActiveAppSession>();
  private readonly knownAppNames = new Set<string>();
  private readonly runRefreshAt = new Map<string, number>();
  private readonly runRefreshInFlight = new Map<
    string,
    Promise<AppRunSummary>
  >();
  private readonly stateDir?: string;
  private readonly heartbeatTimeoutMs: number;
  private readonly heartbeatSweepIntervalMs: number;
  private appRuns = new Map<string, AppRunSummary>();
  private sweeperTimer: ReturnType<typeof setInterval> | null = null;
  private sweeperRuntimeFn: (() => IAgentRuntime | null) | null = null;
  private sweeperReapInFlight = false;

  constructor(options: AppManagerOptions = {}) {
    this.stateDir = options.stateDir;
    this.heartbeatTimeoutMs =
      options.heartbeatTimeoutMs ?? RUN_HEARTBEAT_TIMEOUT_MS;
    this.heartbeatSweepIntervalMs =
      options.heartbeatSweepIntervalMs ?? RUN_HEARTBEAT_SWEEP_INTERVAL_MS;
    for (const run of readAppRunStore(this.stateDir)) {
      this.appRuns.set(run.runId, run);
      this.knownAppNames.add(run.appName);
    }
  }

  /**
   * Bump a run's `lastHeartbeatAt` to "now" without invoking any plugin
   * routes. Returns the updated run, or `null` if the runId is unknown.
   *
   * The UI calls this on a short interval while the GameView is mounted so
   * the sweeper knows the tab is still alive. When the tab goes away the
   * heartbeat stops and {@link reapStaleRuns} reclaims the run after
   * `heartbeatTimeoutMs`.
   */
  recordHeartbeat(runId: string): AppRunSummary | null {
    const run = this.appRuns.get(runId);
    if (!run) return null;
    const now = new Date().toISOString();
    const next: AppRunSummary = {
      ...run,
      lastHeartbeatAt: now,
    };
    this.appRuns.set(runId, next);
    this.persistRuns();
    return next;
  }

  /**
   * Stop and remove every run whose last heartbeat is older than
   * `heartbeatTimeoutMs`. Runs that never received a heartbeat (no UI ever
   * attached) are reaped only once they are also older than the timeout to
   * avoid racing with the launch -> first-poll window.
   *
   * For each reaped run the route module's `stopRun` hook is invoked the
   * same way the explicit Stop button does — so plugins get a single,
   * uniform shutdown path regardless of why a run is going away.
   */
  async reapStaleRuns(
    runtime: IAgentRuntime | null,
    nowMs: number = Date.now(),
  ): Promise<AppRunSummary[]> {
    const reaped: AppRunSummary[] = [];
    for (const run of [...this.appRuns.values()]) {
      const heartbeat = run.lastHeartbeatAt
        ? Date.parse(run.lastHeartbeatAt)
        : null;
      const startedAt = Date.parse(run.startedAt);
      const reference = heartbeat ?? startedAt;
      if (!Number.isFinite(reference)) continue;
      if (nowMs - reference < this.heartbeatTimeoutMs) continue;
      const removed = this.removeRun(run.runId);
      if (!removed) continue;
      reaped.push(removed);
      await invokeAppStopRunHook(removed, runtime);
      logger.info(
        `[app-manager] Reaped stale app run "${removed.runId}" (${removed.appName}); ` +
          `last heartbeat ${run.lastHeartbeatAt ?? "never"}`,
      );
    }
    return reaped;
  }

  /**
   * Start the periodic stale-run sweeper. Idempotent — calling twice does
   * not start two timers. The runtime is resolved lazily via `getRuntime`
   * so the sweeper picks up runtime changes (e.g. agent restart) without
   * needing to be re-wired.
   *
   * The interval is wrapped in `unref()` so a stuck sweeper never keeps a
   * Node process alive on shutdown.
   */
  startStaleRunSweeper(getRuntime: () => IAgentRuntime | null): void {
    this.sweeperRuntimeFn = getRuntime;
    if (this.sweeperTimer) return;
    this.sweeperTimer = setInterval(() => {
      void this.runSweeperTick();
    }, this.heartbeatSweepIntervalMs);
    if (typeof this.sweeperTimer.unref === "function") {
      this.sweeperTimer.unref();
    }
  }

  /** Stop the periodic stale-run sweeper. Safe to call multiple times. */
  stopStaleRunSweeper(): void {
    if (!this.sweeperTimer) return;
    clearInterval(this.sweeperTimer);
    this.sweeperTimer = null;
  }

  private async runSweeperTick(): Promise<void> {
    if (this.sweeperReapInFlight) return;
    this.sweeperReapInFlight = true;
    try {
      const runtime = this.sweeperRuntimeFn?.() ?? null;
      await this.reapStaleRuns(runtime);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.warn(`[app-manager] Stale-run sweeper failed: ${message}`);
    } finally {
      this.sweeperReapInFlight = false;
    }
  }

  private persistRuns(): void {
    writeAppRunStore(Array.from(this.appRuns.values()), this.stateDir);
  }

  private listRunsSorted(): AppRunSummary[] {
    return [...this.appRuns.values()].sort((a, b) =>
      b.updatedAt.localeCompare(a.updatedAt),
    );
  }

  private storeRun(run: AppRunSummary): AppRunSummary {
    this.knownAppNames.add(run.appName);
    this.appRuns.set(run.runId, run);
    this.persistRuns();
    return run;
  }

  private removeRun(runId: string): AppRunSummary | null {
    const run = this.appRuns.get(runId) ?? null;
    if (!run) return null;
    this.appRuns.delete(runId);
    this.activeSessions.delete(runId);
    this.runRefreshAt.delete(runId);
    this.runRefreshInFlight.delete(runId);
    this.persistRuns();
    return run;
  }

  private findRun(runId: string): AppRunSummary | null {
    return this.appRuns.get(runId) ?? null;
  }

  private findMatchingRun(
    appName: string,
    session: AppSessionState | null,
    viewer: AppViewerConfig | null,
  ): AppRunSummary | null {
    for (const run of this.listRunsSorted()) {
      if (sameRunIdentity(run, appName, session, viewer)) {
        return run;
      }
    }
    return null;
  }

  private shouldSkipRunRefresh(run: AppRunSummary, force: boolean): boolean {
    if (force) return false;
    const lastRefreshAt = this.runRefreshAt.get(run.runId) ?? 0;
    return Date.now() - lastRefreshAt < RUN_REFRESH_MIN_INTERVAL_MS;
  }

  private async refreshRunSession(
    run: AppRunSummary,
    runtime: IAgentRuntime | null,
  ): Promise<AppRunSummary> {
    const routeModule = await importAppRouteModule(run.appName);
    if (typeof routeModule?.refreshRunSession !== "function") {
      return run;
    }

    try {
      const nextSession = await routeModule.refreshRunSession({
        appName: run.appName,
        launchUrl: run.launchUrl,
        runtime,
        viewer: run.viewer,
        runId: run.runId,
        session: run.session,
      });
      if (!nextSession) {
        const summary = "Run session is no longer available.";
        const nextRun = this.storeRun(
          updateRunSummary(
            run,
            {
              session: buildUnavailableSession(run, "offline", summary),
              status: "offline",
              summary,
            },
            {
              kind: "health",
              severity: "warning",
              message: summary,
              status: "offline",
              details: {
                runId: run.runId,
                appName: run.appName,
              },
            },
          ),
        );
        return nextRun;
      }
      const nextRun = this.storeRun(
        updateRunSummary(
          run,
          {
            session: nextSession,
            status: nextSession.status,
            summary: nextSession.summary ?? run.summary,
          },
          {
            kind: "refresh",
            severity: nextSession.status === "running" ? "info" : "warning",
            message:
              nextSession.summary ?? `${run.displayName} session refreshed.`,
            status: nextSession.status,
            details: {
              runId: run.runId,
              appName: run.appName,
              sessionId: nextSession.sessionId,
            },
          },
        ),
      );
      return nextRun;
    } catch (error) {
      const message =
        error instanceof Error
          ? `Run verification failed: ${error.message}`
          : "Run verification failed.";
      const nextStatus = run.session ? "disconnected" : "offline";
      const nextRun = this.storeRun(
        updateRunSummary(
          run,
          {
            session: buildUnavailableSession(run, nextStatus, message),
            status: nextStatus,
            summary: message,
          },
          {
            kind: "health",
            severity: "error",
            message,
            status: nextStatus,
            details: {
              runId: run.runId,
              appName: run.appName,
            },
          },
        ),
      );
      return nextRun;
    }
  }

  private async refreshRun(
    run: AppRunSummary,
    runtime: IAgentRuntime | null,
    options: { force?: boolean } = {},
  ): Promise<AppRunSummary> {
    const force = options.force === true;
    if (this.shouldSkipRunRefresh(run, force)) {
      return this.findRun(run.runId) ?? run;
    }

    const inFlight = this.runRefreshInFlight.get(run.runId);
    if (inFlight) {
      return inFlight;
    }

    this.runRefreshAt.set(run.runId, Date.now());
    const refreshPromise = this.refreshRunSession(run, runtime).finally(() => {
      this.runRefreshInFlight.delete(run.runId);
    });
    this.runRefreshInFlight.set(run.runId, refreshPromise);
    return refreshPromise;
  }

  async listAvailable(
    pluginManager: PluginManagerLike,
  ): Promise<RegistryPluginInfo[]> {
    void pluginManager;
    const registry = await getRegistryPlugins();
    const apps = curateCatalogApps(
      Array.from(registry.values()).filter(isAppRegistryPlugin),
    );
    return apps.map(flattenAppInfo);
  }

  async search(
    pluginManager: PluginManagerLike,
    query: string,
    limit = 15,
  ): Promise<RegistrySearchResult[]> {
    const appEntries = (await this.listAvailable(pluginManager)).map(
      flattenAppInfo,
    );
    const results = scoreEntries(
      appEntries,
      query,
      limit,
      (p) => [
        p.appMeta?.displayName?.toLowerCase() ??
          p.displayName?.toLowerCase() ??
          "",
      ],
      (p) => p.appMeta?.capabilities ?? p.capabilities ?? [],
    );
    return toSearchResults(results);
  }

  async getInfo(
    pluginManager: PluginManagerLike,
    name: string,
  ): Promise<RegistryPluginInfo | null> {
    return (
      (await resolveCuratedAppInfo(pluginManager, name)) ??
      (await resolveNamedAppInfo(pluginManager, name))
    );
  }

  async listRuns(
    runtime: IAgentRuntime | null = null,
  ): Promise<AppRunSummary[]> {
    const runs = this.listRunsSorted();
    if (runs.length === 0) {
      return runs;
    }

    const refreshed = await Promise.all(
      runs.map((run) => this.refreshRun(run, runtime)),
    );
    return refreshed.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  async getRun(
    runId: string,
    runtime: IAgentRuntime | null = null,
  ): Promise<AppRunSummary | null> {
    const run = this.findRun(runId);
    if (!run) {
      return null;
    }
    return this.refreshRun(run, runtime, { force: true });
  }

  async attachRun(
    runId: string,
    runtime: IAgentRuntime | null = null,
  ): Promise<AppRunActionResult> {
    const existingRun = this.findRun(runId);
    const run = existingRun
      ? await this.refreshRun(existingRun, runtime, { force: true })
      : null;
    if (!run) {
      return {
        success: false,
        message: `App run "${runId}" was not found.`,
      };
    }

    const updated = this.storeRun(
      updateRunSummary(
        run,
        {
          viewerAttachment: run.viewer ? "attached" : "unavailable",
        },
        {
          kind: "attach",
          message: run.viewer
            ? `${run.displayName} viewer attached.`
            : `${run.displayName} viewer is unavailable.`,
          status: run.session?.status ?? run.status,
          details: {
            runId: run.runId,
            appName: run.appName,
          },
        },
      ),
    );

    return {
      success: true,
      message: `${updated.displayName} attached.`,
      run: updated,
    };
  }

  async detachRun(runId: string): Promise<AppRunActionResult> {
    const run = this.findRun(runId);
    if (!run) {
      return {
        success: false,
        message: `App run "${runId}" was not found.`,
      };
    }

    const updated = this.storeRun(
      updateRunSummary(
        run,
        {
          viewerAttachment: run.viewer ? "detached" : "unavailable",
        },
        {
          kind: "detach",
          message: run.viewer
            ? `${run.displayName} viewer detached.`
            : `${run.displayName} viewer is unavailable.`,
          status: run.session?.status ?? run.status,
          details: {
            runId: run.runId,
            appName: run.appName,
          },
        },
      ),
    );

    return {
      success: true,
      message: `${updated.displayName} detached.`,
      run: updated,
    };
  }

  /**
   * Launch an app: install its plugin (if needed) and return the viewer URL.
   *
   * The plugin connects the agent to the game server. The viewer URL is what
   * the UI shows in an iframe so the user can watch the agent play.
   *
   * After installing a new plugin, the agent needs to restart. The UI should
   * handle this by showing "connecting..." while the runtime restarts.
   */
  async launch(
    pluginManager: PluginManagerLike,
    name: string,
    onProgress?: (progress: InstallProgressLike) => void,
    _runtime?: IAgentRuntime | null,
  ): Promise<AppLaunchResult> {
    let appInfo =
      (await resolveCuratedAppInfo(pluginManager, name)) ??
      (await resolveNamedAppInfo(pluginManager, name));
    if (!appInfo) {
      throw new Error(`App "${name}" not found in the registry.`);
    }
    const agentsListBeforeLaunch = readAgentsListSnapshot();

    // The app's plugin is what the agent needs to play the game.
    // It's the same npm package name as the app, or a separate plugin ref.
    const pluginName =
      appInfo.runtimePlugin ?? resolvePluginPackageName(appInfo);

    // Check if this is a local plugin (already present in plugins/ directory)
    const isLocal = Boolean(appInfo.localPath) || isLocalPlugin(appInfo);

    // Check if the plugin is already installed
    const installed = await pluginManager.listInstalledPlugins();
    const alreadyInstalled = installed.some((p) => p.name === pluginName);
    let pluginInstalled = alreadyInstalled || isLocal;

    let needsRestart = false;

    if (isLocal) {
      // Local plugins are already available, no installation needed
      logger.info(
        `[app-manager] Using local plugin for ${name}: ${pluginName}`,
      );
    } else if (!alreadyInstalled) {
      if (isAutoInstallable(appInfo)) {
        logger.info(`[app-manager] Installing plugin for app: ${pluginName}`);
        let result = await pluginManager
          .installPlugin(pluginName, onProgress)
          .catch((err: unknown) => ({
            success: false as const,
            pluginName,
            version: "",
            installPath: "",
            requiresRestart: false,
            error: err instanceof Error ? err.message : String(err),
          }));
        if (
          !result.success &&
          (result.error?.includes("requires a running agent runtime") ||
            !_runtime)
        ) {
          // Runtime plugin manager unavailable — fall back to the app-core
          // installer which writes to ~/.eliza/plugins/installed and can be
          // picked up by the app-package-modules resolver without restart.
          const { installPlugin: installPluginDirect } = await import(
            /* webpackIgnore: true */ "@elizaos/app-core"
          );
          result = await installPluginDirect(pluginName, onProgress);
        }
        if (!result.success) {
          throw new Error(
            `Failed to install plugin "${pluginName}": ${result.error}`,
          );
        }
        restoreAgentsListAfterAppLaunchIfNeeded(
          agentsListBeforeLaunch,
          name,
          "plugin install",
        );
        pluginInstalled = true;
        needsRestart = result.requiresRestart;
        logger.info(
          `[app-manager] Plugin installed: ${pluginName} v${result.version}`,
        );
      } else {
        logger.info(
          `[app-manager] Skipping plugin install for ${name}: no installable runtime package/version in registry metadata.`,
        );
      }
    } else {
      logger.info(`[app-manager] Plugin already installed: ${pluginName}`);
    }

    const initialLaunchUrl = appInfo.launchUrl
      ? normalizeSafeAppUrl(
          substituteTemplateVars(appInfo.launchUrl, {
            preserveUnknown: false,
            hyperscapeClientDefault: true,
          }),
        )
      : null;
    const launchPreparation = await prepareLaunch(
      appInfo,
      initialLaunchUrl,
      _runtime ?? null,
    );
    restoreAgentsListAfterAppLaunchIfNeeded(
      agentsListBeforeLaunch,
      name,
      "launch preparation",
    );
    const launchPreparationDiagnostics = launchPreparation.diagnostics ?? [];
    appInfo = applyLaunchPreparation(appInfo, launchPreparation);

    const resolvedLaunchUrl = appInfo.launchUrl
      ? substituteTemplateVars(appInfo.launchUrl, {
          preserveUnknown: false,
          hyperscapeClientDefault: true,
        })
      : null;
    const launchUrl = resolvedLaunchUrl
      ? normalizeSafeAppUrl(resolvedLaunchUrl)
      : null;
    if (resolvedLaunchUrl && !launchUrl) {
      throw new Error(
        `Refusing to launch app "${appInfo.name}": unsafe launch URL`,
      );
    }

    const skipPluginRegistration =
      launchPreparation.skipRuntimePluginRegistration === true;

    let runtimePluginRegistered = false;
    if (!skipPluginRegistration) {
      runtimePluginRegistered = await ensureRuntimePluginRegistered(
        appInfo,
        _runtime ?? null,
        isLocal,
      );
      restoreAgentsListAfterAppLaunchIfNeeded(
        agentsListBeforeLaunch,
        name,
        "runtime plugin registration",
      );
    }
    if (runtimePluginRegistered) {
      pluginInstalled = true;
    }
    const viewer = await buildViewerConfig(appInfo, launchUrl, _runtime);
    const runtimeReadyDiagnostics: AppLaunchDiagnostic[] = [];
    try {
      await ensureRuntimeReady(appInfo, viewer, launchUrl, _runtime ?? null);
    } catch (readyError) {
      const message =
        readyError instanceof Error ? readyError.message : String(readyError);
      logger.warn(
        `[app-manager] ensureRuntimeReady(${appInfo.name}) failed: ${message}`,
      );
      runtimeReadyDiagnostics.push({
        code: "runtime-service-unavailable",
        severity: "warning",
        message: `${appInfo.displayName ?? appInfo.name} runtime service could not initialize: ${message}. The viewer will open but live agent control may be unavailable until the underlying service is reachable.`,
      });
    }

    // Build viewer config from registry app metadata
    let session: AppSessionState | null;
    try {
      session = viewer
        ? await resolveLaunchSession(
            appInfo,
            viewer,
            launchUrl,
            _runtime ?? null,
          )
        : buildAppSession(appInfo, undefined, _runtime);
    } catch (sessionError) {
      const message =
        sessionError instanceof Error
          ? sessionError.message
          : String(sessionError);
      logger.warn(
        `[app-manager] resolveLaunchSession(${appInfo.name}) failed: ${message}`,
      );
      runtimeReadyDiagnostics.push({
        code: "session-resolve-failed",
        severity: "warning",
        message: `Could not resolve launch session for ${appInfo.displayName ?? appInfo.name}: ${message}.`,
      });
      session = buildAppSession(appInfo, undefined, _runtime);
    }
    const diagnostics = [
      ...launchPreparationDiagnostics,
      ...runtimeReadyDiagnostics,
      ...(await collectLaunchDiagnostics(
        appInfo,
        viewer,
        session,
        launchUrl,
        _runtime ?? null,
      )),
    ];
    const existingRun = this.findMatchingRun(name, session, viewer);
    const run = this.storeRun(
      existingRun
        ? updateRunSummary(
            existingRun,
            {
              displayName: appInfo.displayName ?? appInfo.name,
              pluginName,
              launchType: appInfo.launchType ?? "connect",
              launchUrl,
              viewer,
              session,
              viewerAttachment: viewer ? "attached" : "unavailable",
            },
            {
              kind: "refresh",
              message:
                session?.summary ??
                `${appInfo.displayName ?? appInfo.name} launch state refreshed.`,
              status: session?.status ?? (viewer ? "running" : "launching"),
              details: {
                runId: existingRun.runId,
                appName: name,
                sessionId: session?.sessionId ?? null,
              },
            },
          )
        : buildRunSummary({
            runId: crypto.randomUUID(),
            appName: name,
            displayName: appInfo.displayName ?? appInfo.name,
            pluginName,
            launchType: appInfo.launchType ?? "connect",
            launchUrl,
            viewer,
            session,
          }),
    );

    this.activeSessions.set(run.runId, {
      runId: run.runId,
      appName: name,
      pluginName,
      launchType: appInfo.launchType ?? "connect",
      launchUrl,
      viewerUrl: viewer?.url ?? null,
      startedAt: run.startedAt,
    });

    restoreAgentsListAfterAppLaunchIfNeeded(
      agentsListBeforeLaunch,
      name,
      "launch",
    );

    return {
      pluginInstalled,
      needsRestart,
      displayName: appInfo.displayName ?? appInfo.name,
      launchType: appInfo.launchType ?? "connect",
      launchUrl,
      viewer,
      session,
      run,
      diagnostics,
    };
  }

  async stop(
    pluginManager: PluginManagerLike,
    name: string,
    runId?: string,
    runtime?: IAgentRuntime | null,
  ): Promise<AppStopResult> {
    const stoppedAt = new Date().toISOString();

    if (runId) {
      const removedRun = this.removeRun(runId);
      if (!removedRun) {
        return {
          success: false,
          appName: name,
          runId,
          stoppedAt,
          pluginUninstalled: false,
          needsRestart: false,
          stopScope: "no-op",
          message: `App run "${runId}" was not found.`,
        };
      }

      await invokeAppStopRunHook(removedRun, runtime ?? null);

      return {
        success: true,
        appName: removedRun.appName,
        runId: removedRun.runId,
        stoppedAt,
        pluginUninstalled: false,
        needsRestart: false,
        stopScope: "viewer-session",
        message: `${removedRun.displayName} stopped.`,
      };
    }

    const runsForApp = this.listRunsSorted().filter(
      (run) => run.appName === name,
    );
    if (runsForApp.length === 0) {
      if (!this.knownAppNames.has(name)) {
        const appInfo = (await pluginManager.getRegistryPlugin(
          name,
        )) as RegistryAppPlugin | null;
        if (!appInfo) {
          throw new Error(`App "${name}" not found in the registry.`);
        }
        this.knownAppNames.add(name);
      }

      return {
        success: false,
        appName: name,
        runId: null,
        stoppedAt,
        pluginUninstalled: false,
        needsRestart: false,
        stopScope: "no-op",
        message: `No active app run found for "${name}".`,
      };
    }

    for (const run of runsForApp) {
      this.removeRun(run.runId);
      await invokeAppStopRunHook(run, runtime ?? null);
    }

    return {
      success: true,
      appName: name,
      runId: null,
      stoppedAt,
      pluginUninstalled: false,
      needsRestart: false,
      stopScope: "viewer-session",
      message:
        runsForApp.length === 1
          ? `${runsForApp[0]?.displayName ?? name} stopped.`
          : `${runsForApp.length} app runs stopped for "${name}".`,
    };
  }

  /** List apps whose plugins are currently installed on the agent. */
  async listInstalled(
    pluginManager: PluginManagerLike,
  ): Promise<InstalledAppInfo[]> {
    const installed = await pluginManager.listInstalledPlugins();
    const registry = await getRegistryPlugins();
    const refreshedRegistry = await withTimeout(
      pluginManager.refreshRegistry(),
      resolveRegistryRefreshTimeoutMs(),
      "app registry refresh",
    ).catch(() => new Map<string, RegistryPluginInfo>());
    const mergedRegistry = new Map<string, RegistryPluginInfo>(registry);
    for (const [name, info] of refreshedRegistry.entries()) {
      if (!mergedRegistry.has(name)) {
        mergedRegistry.set(name, info);
      }
    }
    const installedByName = new Map(
      installed.map((plugin) => [plugin.name, plugin] as const),
    );

    const appEntries = Array.from(mergedRegistry.values())
      .filter(isAppRegistryPlugin)
      .map(flattenAppInfo);

    return appEntries
      .map((appInfo): InstalledAppInfo | null => {
        const pluginName =
          appInfo.runtimePlugin ?? resolvePluginPackageName(appInfo);
        const installedPlugin =
          installedByName.get(pluginName) ?? installedByName.get(appInfo.name);
        if (!installedPlugin) return null;

        return {
          name: appInfo.name,
          displayName:
            appInfo.displayName ?? packageNameToAppDisplayName(appInfo.name),
          pluginName,
          version: installedPlugin.version ?? "unknown",
          installedAt: installedPlugin.installedAt ?? "",
        };
      })
      .filter((app): app is InstalledAppInfo => app !== null);
  }
}
