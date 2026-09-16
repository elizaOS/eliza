/**
 * elizaOS — Application Configuration
 *
 * Single source of truth for app identity. Used by:
 * - capacitor.config.ts (mobile builds)
 * - main.tsx (React boot)
 * - run-mobile-build.mjs (native overlay — reads appId/appName via regex)
 * - Electrobun desktop shell (via ELIZA_APP_NAME / ELIZA_APP_ID env vars)
 *
 * To create a new app, copy this file and change the values below.
 */
import type { AppConfig } from "@elizaos/app-core";
import { EXTERNAL_URLS } from "@elizaos/shared/brand";

interface AppWebConfig {
  shortName: string;
  themeColor: string;
  backgroundColor: string;
  shareImagePath: string;
  iconBackgroundColor?: string;
}

interface AppIdentityEnv {
  readonly [key: string]: string | undefined;
  ELIZA_ANDROID_VPS_SIDECAR?: string;
}

function isEnabled(value: string | undefined): boolean {
  return /^(1|true|yes|on)$/i.test((value ?? "").trim());
}

const CANONICAL_IDENTITY = {
  appName: "Eliza",
  appId: "ai.elizaos.app",
  namespace: "eliza",
  urlScheme: "elizaos",
} as const;

const VPS_SIDECAR_IDENTITY = {
  appName: "Eliza VPS",
  appId: "ai.elizaos.app.vps",
  namespace: "eliza-vps",
  urlScheme: "elizavps",
} as const;

/**
 * Resolve the one alternate Android identity that intentionally installs next
 * to the canonical Cloud app. All ordinary builds retain the canonical app
 * config byte-for-byte; the sidecar identity exists only behind its explicit
 * build flag.
 */
export function resolveAppConfig(env: AppIdentityEnv = process.env) {
  const vpsSidecar = isEnabled(env.ELIZA_ANDROID_VPS_SIDECAR);
  const identity = vpsSidecar ? VPS_SIDECAR_IDENTITY : CANONICAL_IDENTITY;

  return {
    appName: identity.appName,
    appId: identity.appId,
    orgName: "elizaos",
    repoName: "eliza",
    cliName: "eliza",
    description:
      "Eliza manages your digital life so you can focus on what matters.",
    envPrefix: "ELIZA",
    namespace: identity.namespace,
    defaultApps: ["@elizaos/plugin-personal-assistant"],

    desktop: {
      bundleId: identity.appId,
      urlScheme: identity.urlScheme,
    },

    web: {
      shortName: identity.appName,
      ...(vpsSidecar ? { iconBackgroundColor: "#202124" } : {}),
      // Launch/loading surface used by manifest theme_color + background_color,
      // <meta name="theme-color">, and PWA launch surfaces. Matches the default
      // home background base (#000000 = DEFAULT_BACKGROUND_COLOR, the black
      // field under the orange ember glow) so chrome and splash never flash a
      // different color before the home background appears (issue #9565). On
      // iOS standalone PWAs theme-color paints the home-indicator safe-area
      // inset, so matching the black field keeps any inset bleed-through
      // invisible. The brand accent (logos, buttons) stays #FF5800 / the CSS
      // --brand-orange and is intentionally separate from these launch surfaces.
      themeColor: "#000000",
      backgroundColor: "#000000",
      // PNG, not SVG: link-preview scrapers (X, Discord, iMessage, Slack) do
      // not render SVG share images.
      shareImagePath: "/brand/ogembeds/eliza_ogembed.png",
    },

    branding: {
      appName: identity.appName,
      orgName: "elizaos",
      repoName: "eliza",
      docsUrl: EXTERNAL_URLS.docs,
      appUrl: EXTERNAL_URLS.app,
      bugReportUrl: "https://github.com/elizaOS/eliza/issues/new",
      hashtag: "#elizaOS",
      fileExtension: ".eliza-agent",
      packageScope: "elizaos",
    },
  } satisfies AppConfig & { web: AppWebConfig };
}

const config = resolveAppConfig();

export default config;
