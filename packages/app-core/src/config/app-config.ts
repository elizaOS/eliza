/**
 * White-label application configuration.
 *
 * This is the top-level config that a white-label app provides to customize
 * the entire elizaOS experience — branding, defaults, deployment, and cloud
 * integration. Apps provide this via `app.config.ts` in their project root.
 *
 * Usage:
 *   import { AppConfig } from "@elizaos/app-core";
 *
 *   export default {
 *     appName: "MyAgent",
 *     appId: "com.example.myagent",
 *     orgName: "example-org",
 *     // ...
 *   } satisfies AppConfig;
 */

import { type BrandingConfig, DEFAULT_BRANDING } from "./branding";

export interface AppDesktopConfig {
  /** Reverse-domain bundle identifier (e.g. "com.elizaai.eliza") */
  bundleId: string;
  /** Custom URL scheme for deep links (e.g. "eliza", "myagent") */
  urlScheme: string;
  /** Release notes URL */
  releaseNotesUrl?: string;
  /** macOS app category */
  category?: string;
}

export interface AppPackagingConfig {
  debian?: {
    packageName: string;
    maintainer: string;
    homepage: string;
    description: string;
  };
  flatpak?: {
    appId: string;
    command: string;
  };
  msix?: {
    identityName: string;
    publisher: string;
    publisherDisplayName: string;
    description: string;
  };
  snap?: {
    name: string;
    summary: string;
    description: string;
  };
  homebrew?: {
    tapRepo: string;
    formulaName: string;
  };
  pypi?: {
    packageName: string;
    description: string;
  };
}

export interface AppWebConfig {
  /** Short display name for install surfaces like the PWA manifest */
  shortName?: string;
  /** Browser/PWA theme color */
  themeColor?: string;
  /** Browser/PWA background color */
  backgroundColor?: string;
  /** Social share image path, relative to the app origin */
  shareImagePath?: string;
}

/**
 * One brand-specific User-Agent marker that the Android `MainActivity`
 * should append to the WebView UA when the named system property is
 * set. Used by white-label forks that ship their own AOSP product
 * image (set by `vendor/<brand>/<brand>_common.mk`'s
 * `PRODUCT_PRODUCT_PROPERTIES`) and want their renderer to detect the
 * branded image at runtime via a stable UA suffix.
 *
 * The default `ElizaOS/<tag>` marker (driven by `ro.elizaos.product`)
 * is always emitted by the framework — these are *additional*
 * brand-specific markers, not replacements.
 *
 * Example:
 *
 *   android: {
 *     userAgentMarkers: [
 *       { systemProp: "ro.miladyos.product", uaPrefix: "MiladyOS/" },
 *     ],
 *   }
 *
 * Produces a UA like `... ElizaOS/<tag> MiladyOS/<tag>` on a MiladyOS
 * image, and an unmodified UA on stock Android.
 */
export interface AndroidUserAgentMarker {
  /**
   * Android system property to read via reflection. Empty string =
   * marker disabled (skipped silently).
   */
  systemProp: string;
  /**
   * Prefix for the UA token. The marker emits `<uaPrefix><value>`
   * where `<value>` is the system-property value. Conventionally ends
   * with `/` (e.g. `"MiladyOS/"`).
   */
  uaPrefix: string;
}

export interface AppAndroidConfig {
  /**
   * Brand-specific UA markers appended after the framework's
   * `ElizaOS/<tag>` marker. Only applied when the corresponding
   * system property is non-empty (i.e. the AOSP brand image is
   * actually running).
   *
   * Consumed by `run-mobile-build.mjs:overlayAndroid()`, which
   * generates additional Java methods + call sites in the templated
   * `MainActivity.java`. Stock Android APK installs see neither the
   * `ElizaOS/` marker nor any brand-specific marker.
   */
  userAgentMarkers?: AndroidUserAgentMarker[];
}

export interface AppConfig {
  /** Display name shown in UI, desktop title bars, etc. */
  appName: string;

  /** Reverse-domain app identifier */
  appId: string;

  /** Organization name (GitHub org, npm scope source) */
  orgName: string;

  /** Repository name */
  repoName: string;

  /** CLI command name (e.g. "eliza", "myagent") */
  cliName: string;

  /** Short tagline / description */
  description: string;

  /**
   * Eliza Cloud app ID for rev sharing.
   * When set, the app earns revenue through inference markups and
   * purchase-share settings on Eliza Cloud.
   */
  cloudAppId?: string;

  /** Full branding overrides (colors, URLs, etc.) */
  branding: Partial<BrandingConfig>;

  /**
   * Env var prefix for this app.
   * When set, the app's brand-env layer aliases `{PREFIX}_PORT` → `ELIZA_PORT`, etc.
   * Example: "ELIZA" generates ELIZA_PORT → ELIZA_PORT.
   */
  envPrefix?: string;

  /** Path to default character JSON (relative to project root) */
  defaultCharacter?: string;

  /** Plugins to auto-enable by default */
  defaultPlugins?: string[];

  /** Apps starred and pinned by default on a fresh client profile. */
  defaultApps?: string[];

  /** Desktop-specific configuration */
  desktop?: AppDesktopConfig;

  /** Web app manifest and share metadata overrides. */
  web?: AppWebConfig;

  /** Android-specific build-time configuration. */
  android?: AppAndroidConfig;

  /** Package manager configurations */
  packaging?: AppPackagingConfig;

  /**
   * Default ELIZA_NAMESPACE value.
   * Determines the state directory name (~/.{namespace}/) and config filename.
   * Defaults to the cliName if not set.
   */
  namespace?: string;
}

/**
 * Resolve a full BrandingConfig from an AppConfig.
 * Merges app-specific overrides with the framework defaults.
 */
export function resolveAppBranding(appConfig: AppConfig): BrandingConfig {
  return {
    ...DEFAULT_BRANDING,
    appName: appConfig.appName,
    orgName: appConfig.orgName,
    repoName: appConfig.repoName,
    ...appConfig.branding,
  };
}
