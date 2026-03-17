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

import * as fs from "node:fs";
import * as path from "node:path";
import type { IAgentRuntime } from "@elizaos/core";
import { logger } from "@elizaos/core";
import { deriveEvmAddress, deriveSolanaAddress } from "../api/wallet";
import type {
  AppLaunchResult,
  AppStopResult,
  AppViewerAuthMessage,
  InstalledAppInfo,
} from "../contracts/apps";
import type {
  InstalledPluginInfo,
  InstallProgressLike,
  PluginManagerLike,
  RegistryPluginInfo,
  RegistrySearchResult,
} from "./plugin-manager-types";
import { getPluginInfo, getRegistryPlugins } from "./registry-client";

const LOCAL_PLUGINS_DIR = "plugins";

export type {
  AppLaunchResult,
  AppStopResult,
  AppViewerAuthMessage,
  InstalledAppInfo,
} from "../contracts/apps";

const DEFAULT_VIEWER_SANDBOX = "allow-scripts allow-same-origin allow-popups";
const RS_2004SCAPE_APP_NAME = "@elizaos/app-2004scape";
const RS_2004SCAPE_AUTH_MESSAGE_TYPE = "RS_2004SCAPE_AUTH";
const SAFE_APP_URL_PROTOCOLS = new Set(["http:", "https:"]);
const ALLOWED_APP_URL_TEMPLATE_KEYS = new Set([
  // Public display identity only.
  "BOT_NAME",
  "RS_SDK_BOT_NAME",
]);

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
}

interface ActiveAppSession {
  appName: string;
  pluginName: string;
  launchType: string;
  launchUrl: string | null;
  viewerUrl: string | null;
  startedAt: string;
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
    return "testbot";
  }
  return undefined;
}

function substituteTemplateVars(raw: string): string {
  return raw.replace(/\{([A-Z0-9_]+)\}/g, (_full, key: string) => {
    if (!ALLOWED_APP_URL_TEMPLATE_KEYS.has(key)) {
      return getTemplateFallbackValue(key) ?? "";
    }

    const value = process.env[key];
    if (value && value.trim().length > 0) {
      return value.trim();
    }
    return getTemplateFallbackValue(key) ?? "";
  });
}

function buildViewerUrl(
  baseUrl: string,
  embedParams?: Record<string, string>,
): string {
  if (!embedParams || Object.keys(embedParams).length === 0) {
    return substituteTemplateVars(baseUrl);
  }
  const resolvedBaseUrl = substituteTemplateVars(baseUrl);
  const [beforeHash, hashPartRaw] = resolvedBaseUrl.split("#", 2);
  const [pathPart, queryPartRaw] = beforeHash.split("?", 2);
  const queryParams = new URLSearchParams(queryPartRaw ?? "");
  for (const [key, rawValue] of Object.entries(embedParams)) {
    queryParams.set(key, substituteTemplateVars(rawValue));
  }
  const query = queryParams.toString();
  const hash = hashPartRaw ? `#${hashPartRaw}` : "";
  return `${pathPart}${query.length > 0 ? `?${query}` : ""}${hash}`;
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

function buildViewerAuthMessage(
  appName: string,
  postMessageAuth: boolean | undefined,
): AppViewerAuthMessage | undefined {
  if (!postMessageAuth) return undefined;

  // 2004scape auth - uses bot name and password from environment
  if (appName === RS_2004SCAPE_APP_NAME) {
    // Get username from RS_SDK_BOT_NAME or BOT_NAME, fallback to testbot
    const username =
      process.env.RS_SDK_BOT_NAME?.trim() ||
      process.env.BOT_NAME?.trim() ||
      "testbot";
    // Get password from RS_SDK_BOT_PASSWORD or BOT_PASSWORD
    const password =
      process.env.RS_SDK_BOT_PASSWORD?.trim() ||
      process.env.BOT_PASSWORD?.trim() ||
      "";

    return {
      type: RS_2004SCAPE_AUTH_MESSAGE_TYPE,
      authToken: username, // Using authToken field for username
      sessionToken: password, // Using sessionToken field for password
    };
  }

  return undefined;
}

function buildViewerConfig(
  appInfo: RegistryAppPlugin,
  launchUrl: string | null,
): AppViewerConfig | null {
  const viewerInfo = appInfo.viewer;
  if (viewerInfo) {
    const requestedPostMessageAuth = Boolean(viewerInfo.postMessageAuth);
    const authMessage = buildViewerAuthMessage(
      appInfo.name,
      requestedPostMessageAuth,
    );
    const postMessageAuth = requestedPostMessageAuth && Boolean(authMessage);
    if (requestedPostMessageAuth && !authMessage) {
      logger.warn(
        `[app-manager] ${appInfo.name} requires postMessage auth but no auth payload was generated.`,
      );
    }
    const viewerUrl = normalizeSafeAppUrl(
      buildViewerUrl(viewerInfo.url, viewerInfo.embedParams),
    );
    if (!viewerUrl) {
      throw new Error(
        `Refusing to launch app "${appInfo.name}": unsafe viewer URL`,
      );
    }

    return {
      url: viewerUrl,
      embedParams: viewerInfo.embedParams,
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

/**
 * Get wallet addresses from agent runtime settings (character secrets).
 * Falls back to process.env if runtime is not available.
 */
function getWalletAddressesFromRuntime(
  runtime: IAgentRuntime | null | undefined,
): { evmAddress: string | null; solanaAddress: string | null } {
  const PLACEHOLDER_RE =
    /^\[?\s*(REDACTED|PLACEHOLDER|TODO|CHANGEME|EMPTY)\s*]?$/i;
  let evmAddress: string | null = null;
  let solanaAddress: string | null = null;

  // Try runtime settings first (character secrets), fall back to process.env
  const evmKey =
    (runtime?.getSetting?.("EVM_PRIVATE_KEY") as string | undefined)?.trim() ||
    process.env.EVM_PRIVATE_KEY?.trim();

  if (evmKey && !PLACEHOLDER_RE.test(evmKey)) {
    try {
      evmAddress = deriveEvmAddress(evmKey);
    } catch (e) {
      logger.warn(`[app-manager] Bad EVM key: ${e}`);
    }
  }

  const solKey =
    (
      runtime?.getSetting?.("SOLANA_PRIVATE_KEY") as string | undefined
    )?.trim() || process.env.SOLANA_PRIVATE_KEY?.trim();

  if (solKey && !PLACEHOLDER_RE.test(solKey)) {
    try {
      solanaAddress = deriveSolanaAddress(solKey);
    } catch (e) {
      logger.warn(`[app-manager] Bad SOL key: ${e}`);
    }
  }

  return { evmAddress, solanaAddress };
}

export class AppManager {
  private readonly activeSessions = new Map<string, ActiveAppSession>();

  async listAvailable(
    pluginManager: PluginManagerLike,
  ): Promise<RegistryPluginInfo[]> {
    const registry = await pluginManager.refreshRegistry();
    // Merge in local workspace app entries that are discovered by our
    // registry-client but not by the elizaos
    // plugin-manager service.
    try {
      const localRegistry = await getRegistryPlugins();
      for (const [name, info] of localRegistry) {
        if (!registry.has(name) && info.kind === "app") {
          registry.set(name, info);
        }
      }
    } catch {
      // local discovery is best-effort
    }
    // Include app packages: those with "/app-" in the name OR kind === "app"
    const apps = Array.from(registry.values()).filter((plugin) => {
      if (plugin.kind === "app") return true;
      const name = plugin.name.toLowerCase();
      const npmPackage = plugin.npm.package.toLowerCase();
      return name.includes("/app-") || npmPackage.includes("/app-");
    });
    // Flatten appMeta into top-level fields for the frontend
    return apps.map((p) => {
      const meta = p.appMeta;
      if (!meta) return p;
      return {
        ...p,
        displayName: meta.displayName,
        launchType: meta.launchType,
        launchUrl: meta.launchUrl,
        icon: meta.icon,
        category: meta.category,
        capabilities: meta.capabilities,
        uiExtension: meta.uiExtension,
        viewer: meta.viewer,
      };
    });
  }

  async search(
    pluginManager: PluginManagerLike,
    query: string,
    limit = 15,
  ): Promise<RegistrySearchResult[]> {
    const results = await pluginManager.searchRegistry(query, limit);
    // Filter to only include app packages
    return results.filter((result) => {
      const name = result.name.toLowerCase();
      const npmPackage = result.npmPackage.toLowerCase();
      return name.includes("/app-") || npmPackage.includes("/app-");
    });
  }

  async getInfo(
    pluginManager: PluginManagerLike,
    name: string,
  ): Promise<RegistryPluginInfo | null> {
    return pluginManager.getRegistryPlugin(name);
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
    runtime?: IAgentRuntime | null,
  ): Promise<AppLaunchResult> {
    let appInfo = (await pluginManager.getRegistryPlugin(
      name,
    )) as RegistryAppPlugin | null;
    // Supplement with local registry metadata since the elizaos plugin-manager
    // service doesn't include our local workspace app discovery.
    try {
      const localInfo = await getPluginInfo(name);
      if (localInfo) {
        const meta = localInfo.appMeta;
        if (!appInfo) {
          appInfo = { ...localInfo } as RegistryAppPlugin;
          mergeAppMeta(appInfo, meta);
        } else if (meta && !appInfo.viewer) {
          // Merge local metadata into existing registry entry
          mergeAppMeta(appInfo, meta);
          appInfo.kind = localInfo.kind ?? appInfo.kind;
        }
      }
    } catch {
      // local lookup is best-effort
    }
    if (!appInfo) {
      throw new Error(`App "${name}" not found in the registry.`);
    }

    // The app's plugin is what the agent needs to play the game.
    // It's the same npm package name as the app, or a separate plugin ref.
    const pluginName = resolvePluginPackageName(appInfo);

    // Check if this is a local plugin (already present in plugins/ directory)
    const isLocal = isLocalPlugin(appInfo);

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
        const result = await pluginManager.installPlugin(
          pluginName,
          onProgress,
        );
        if (!result.success) {
          throw new Error(
            `Failed to install plugin "${pluginName}": ${result.error}`,
          );
        }
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

    // Build viewer config from registry app metadata
    const resolvedLaunchUrl = appInfo.launchUrl
      ? substituteTemplateVars(appInfo.launchUrl)
      : null;
    const launchUrl = resolvedLaunchUrl
      ? normalizeSafeAppUrl(resolvedLaunchUrl)
      : null;
    if (resolvedLaunchUrl && !launchUrl) {
      throw new Error(
        `Refusing to launch app "${appInfo.name}": unsafe launch URL`,
      );
    }
    const viewer = buildViewerConfig(appInfo, launchUrl);
    this.activeSessions.set(name, {
      appName: name,
      pluginName,
      launchType: appInfo.launchType ?? "connect",
      launchUrl,
      viewerUrl: viewer?.url ?? null,
      startedAt: new Date().toISOString(),
    });

    return {
      pluginInstalled,
      needsRestart,
      displayName: appInfo.displayName ?? appInfo.name,
      launchType: appInfo.launchType ?? "connect",
      launchUrl,
      viewer,
    };
  }

  async stop(
    pluginManager: PluginManagerLike,
    name: string,
  ): Promise<AppStopResult> {
    const appInfo = (await pluginManager.getRegistryPlugin(
      name,
    )) as RegistryAppPlugin | null;
    if (!appInfo) {
      throw new Error(`App "${name}" not found in the registry.`);
    }

    const hadSession = this.activeSessions.delete(name);
    const pluginName = resolvePluginPackageName(appInfo);
    const installed = await pluginManager.listInstalledPlugins();
    const isPluginInstalled = installed.some(
      (plugin) => plugin.name === pluginName,
    );
    if (!hadSession && !isPluginInstalled) {
      return {
        success: false,
        appName: name,
        stoppedAt: new Date().toISOString(),
        pluginUninstalled: false,
        needsRestart: false,
        stopScope: "no-op",
        message: `No active session or installed plugin found for "${name}".`,
      };
    }

    if (isPluginInstalled) {
      const uninstallResult = await pluginManager.uninstallPlugin(pluginName);
      if (!uninstallResult.success) {
        throw new Error(
          `Failed to stop "${name}": ${uninstallResult.error ?? "plugin uninstall failed"}`,
        );
      }
      return {
        success: true,
        appName: name,
        stoppedAt: new Date().toISOString(),
        pluginUninstalled: true,
        needsRestart: uninstallResult.requiresRestart,
        stopScope: "plugin-uninstalled",
        message: uninstallResult.requiresRestart
          ? `${name} disconnected and plugin uninstalled. Agent restart required.`
          : `${name} disconnected and plugin uninstalled.`,
      };
    }

    return {
      success: true,
      appName: name,
      stoppedAt: new Date().toISOString(),
      pluginUninstalled: false,
      needsRestart: false,
      stopScope: "viewer-session",
      message: `${name} viewer session stopped.`,
    };
  }

  /** List apps whose plugins are currently installed on the agent. */
  async listInstalled(
    pluginManager: PluginManagerLike,
  ): Promise<InstalledAppInfo[]> {
    const installed = await pluginManager.listInstalledPlugins();
    // Filter to only include app plugins (by name convention or known game plugins)
    const appPlugins = installed.filter((p: InstalledPluginInfo) => {
      const name = p.name.toLowerCase();
      return name.includes("/app-");
    });
    return appPlugins.map((p: InstalledPluginInfo) => ({
      name: p.name,
      displayName: p.name
        .replace(/^@elizaos\/(app-|plugin-)/, "")
        .replace(/-/g, " ")
        .replace(/\b\w/g, (c: string) => c.toUpperCase()),
      pluginName: p.name,
      version: p.version ?? "unknown",
      installedAt: new Date().toISOString(), // Ejected plugins don't track install time yet
    }));
  }
}
