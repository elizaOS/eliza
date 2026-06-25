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

interface AppWebConfig {
  shortName: string;
  themeColor: string;
  backgroundColor: string;
  shareImagePath: string;
}

const config = {
  appName: "Eliza",
  appId: "ai.elizaos.app",
  orgName: "elizaos",
  repoName: "eliza",
  cliName: "eliza",
  description: "Open-source AI agents for everyone",
  envPrefix: "ELIZA",
  namespace: "eliza",
  defaultApps: ["@elizaos/plugin-personal-assistant"],

  desktop: {
    bundleId: "ai.elizaos.app",
    urlScheme: "elizaos",
  },

  web: {
    shortName: "Eliza",
    // Launch/loading orange used by manifest theme_color + background_color,
    // <meta name="theme-color">, and PWA launch surfaces. Matches the default
    // home-background orange (#ef5a1f = DEFAULT_BACKGROUND_COLOR) so chrome and
    // splash never flash a different orange before the home background appears
    // (issue #9565). The brand accent (logos, buttons) stays #FF5800 / the CSS
    // --brand-orange and is intentionally separate from these launch surfaces.
    themeColor: "#ef5a1f",
    backgroundColor: "#ef5a1f",
    shareImagePath: "/brand/ogembeds/eliza_ogembed.svg",
  },

  branding: {
    appName: "Eliza",
    orgName: "elizaos",
    repoName: "eliza",
    docsUrl: "https://eliza.app",
    appUrl: "https://eliza.app",
    bugReportUrl: "https://github.com/elizaOS/eliza/issues/new",
    hashtag: "#elizaOS",
    fileExtension: ".eliza-agent",
    packageScope: "elizaos",
  },
} satisfies AppConfig & { web: AppWebConfig };

export default config;
