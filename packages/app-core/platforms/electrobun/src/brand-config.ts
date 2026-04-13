/**
 * Brand configuration for the elizaOS desktop shell.
 *
 * All user-facing brand strings (app name, identifiers, URLs) are resolved
 * here from environment variables with sensible defaults. Brand-specific
 * apps (e.g. Milady) override via env or by importing and calling
 * `overrideBrandConfig()` before the shell boots.
 *
 * Env precedence: ELIZA_ > MILADY_ (legacy) > default.
 */

export interface DesktopBrandConfig {
  /** Display name shown in menus, notifications, window titles. */
  appName: string;
  /** Reverse-DNS app identifier (macOS bundle ID, etc.). */
  appId: string;
  /** URL scheme for deep links (e.g. "elizaos" -> elizaos://). */
  urlScheme: string;
  /** Base URL for release/update artifacts. */
  releaseUrl: string;
  /** Config export file name. */
  configExportFileName: string;
  /** User-facing description. */
  appDescription: string;
  /** Default namespace for state directory (~/.eliza/ or ~/.milady/). */
  namespace: string;
  /** Config directory name (used under ~/.config/ on Unix, %APPDATA% on Windows). */
  configDirName: string;
  /** Startup log file name. */
  startupLogFileName: string;
  /** macOS launch agent plist file name. */
  macLaunchAgentPlist: string;
  /** macOS launch agent label. */
  macLaunchAgentLabel: string;
  /** Linux desktop file name (without path). */
  linuxDesktopFileName: string;
  /** Linux desktop entry display name. */
  linuxDesktopEntryName: string;
  /** Windows registry autostart value name. */
  windowsRegistryValueName: string;
  /** CEF version marker file name. */
  cefVersionMarkerFileName: string;
  /** Runtime dist directory name inside packaged bundles. */
  runtimeDistDirName: string;
  /** mDNS/Bonjour service type. */
  mdnsServiceType: string;
  /** Desktop music guild ID. */
  desktopMusicGuildId: string;
  /** Browser workspace partition name. */
  browserWorkspacePartition: string;
  /** Release notes partition name. */
  releaseNotesPartition: string;
  /** CEF desktop partition name. */
  cefDesktopPartition: string;
  /** Trusted close message type for cloud auth windows. */
  trustedCloseMessageType: string;
}

function env(key: string): string {
  return (process.env[key] ?? "").trim();
}

function envFallback(...keys: string[]): string {
  for (const key of keys) {
    const val = env(key);
    if (val) return val;
  }
  return "";
}

const DEFAULT_CONFIG: DesktopBrandConfig = {
  appName: "elizaOS",
  appId: "ai.elizaos.app",
  urlScheme: "elizaos",
  releaseUrl: "",
  configExportFileName: "eliza-config.json",
  appDescription: "AI agents for the desktop",
  namespace: "eliza",
  configDirName: "elizaOS",
  startupLogFileName: "eliza-startup.log",
  macLaunchAgentPlist: "ai.elizaos.app.plist",
  macLaunchAgentLabel: "ai.elizaos.app",
  linuxDesktopFileName: "elizaos.desktop",
  linuxDesktopEntryName: "elizaOS",
  windowsRegistryValueName: "elizaOS",
  cefVersionMarkerFileName: ".eliza-version",
  runtimeDistDirName: "eliza-dist",
  mdnsServiceType: "_eliza._tcp",
  desktopMusicGuildId: "eliza-desktop",
  browserWorkspacePartition: "persist:eliza-browser",
  releaseNotesPartition: "persist:eliza-release-notes",
  cefDesktopPartition: "persist:eliza-desktop-cef",
  trustedCloseMessageType: "eliza.trusted-eliza-window.close",
};

let resolvedConfig: DesktopBrandConfig | null = null;

/**
 * Override specific brand config values. Must be called before `getBrandConfig()`.
 */
export function overrideBrandConfig(
  overrides: Partial<DesktopBrandConfig>,
): void {
  resolvedConfig = { ...resolveBrandConfig(), ...overrides };
}

function resolveBrandConfig(): DesktopBrandConfig {
  const appName =
    envFallback("ELIZA_APP_NAME", "MILADY_APP_NAME") || DEFAULT_CONFIG.appName;
  const appId =
    envFallback("ELIZA_APP_ID", "MILADY_APP_ID") || DEFAULT_CONFIG.appId;

  return {
    ...DEFAULT_CONFIG,
    appName,
    appId,
    urlScheme:
      envFallback("ELIZA_URL_SCHEME", "MILADY_URL_SCHEME") ||
      DEFAULT_CONFIG.urlScheme,
    releaseUrl:
      envFallback("ELIZA_RELEASE_URL", "MILADY_RELEASE_URL") ||
      DEFAULT_CONFIG.releaseUrl,
    configExportFileName: `${appName.toLowerCase().replace(/\s+/g, "-")}-config.json`,
    namespace:
      envFallback("ELIZA_NAMESPACE", "MILADY_NAMESPACE") ||
      DEFAULT_CONFIG.namespace,
    configDirName: appName,
  };
}

/**
 * Get the resolved brand configuration. Values are resolved once and cached.
 */
export function getBrandConfig(): DesktopBrandConfig {
  if (!resolvedConfig) {
    resolvedConfig = resolveBrandConfig();
  }
  return resolvedConfig;
}

/**
 * Reset cached config (for tests).
 */
export function resetBrandConfigForTests(): void {
  resolvedConfig = null;
}
