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

import type { BrandingConfig } from "./branding";

export interface AppDesktopConfig {
  /** Reverse-domain bundle identifier (e.g. "com.miladyai.milady") */
  bundleId: string;
  /** Custom URL scheme for deep links (e.g. "milady", "myagent") */
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
  /** Short app name used in the web manifest. */
  shortName?: string;
  /** Browser UI theme color used for the PWA manifest/meta tags. */
  themeColor?: string;
  /** Browser background color used for the PWA manifest/meta tags. */
  backgroundColor?: string;
  /** Social share image path relative to the deployed app root. */
  shareImagePath?: string;
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

  /** CLI command name (e.g. "milady", "myagent") */
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
   * Example: "MILADY" generates MILADY_PORT → ELIZA_PORT.
   */
  envPrefix?: string;

  /** Path to default character JSON (relative to project root) */
  defaultCharacter?: string;

  /** Plugins to auto-enable by default */
  defaultPlugins?: string[];

  /** Desktop-specific configuration */
  desktop?: AppDesktopConfig;

  /** Web app manifest and share metadata overrides. */
  web?: AppWebConfig;

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
  // NOTE: Inlined defaults mirror DEFAULT_BRANDING in ./branding.ts.
  // Requiring branding at call time was leaking into the browser bundle and
  // causing a runtime `require is not defined` failure.
  const defaults: BrandingConfig = {
    appName: "Eliza",
    orgName: "elizaos",
    repoName: "eliza",
    docsUrl: "https://docs.elizaos.ai",
    appUrl: "https://app.elizaos.ai",
    bugReportUrl:
      "https://github.com/elizaos/eliza/issues/new?template=bug_report.yml",
    hashtag: "#ElizaAgent",
    fileExtension: ".eliza-agent",
    packageScope: "elizaos",
  };

  return {
    ...defaults,
    appName: appConfig.appName,
    orgName: appConfig.orgName,
    repoName: appConfig.repoName,
    ...appConfig.branding,
  };
}
