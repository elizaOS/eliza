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
import type { AppConfig } from "@elizaos/ui";

interface AppWebConfig {
  shortName: string;
  themeColor: string;
  backgroundColor: string;
  shareImagePath: string;
}

const config = {
  appName: "Eliza",
  appId: "app.eliza",
  orgName: "elizaos",
  repoName: "eliza",
  cliName: "eliza",
  description: "Open-source AI agents for everyone",
  envPrefix: "ELIZA",
  namespace: "eliza",
  defaultApps: ["@elizaos/app-lifeops"],

  desktop: {
    bundleId: "app.eliza",
    urlScheme: "elizaos",
  },

  web: {
    shortName: "Eliza",
    themeColor: "#08080a",
    backgroundColor: "#0a0a0a",
    shareImagePath: "/og-image.png",
  },

  branding: {
    appName: "Eliza",
    orgName: "elizaos",
    repoName: "eliza",
    docsUrl: "https://eliza.how",
    appUrl: "https://eliza.how",
    bugReportUrl: "https://github.com/elizaOS/eliza/issues/new",
    hashtag: "#elizaOS",
    fileExtension: ".eliza-agent",
    packageScope: "elizaos",
  },
} satisfies AppConfig & { web: AppWebConfig };

export default config;
