/**
 * Application Configuration
 *
 * Single source of truth for app identity. Used by:
 * - capacitor.config.ts (mobile builds)
 * - vite.config.ts and src/main.tsx (web builds)
 * - Electrobun desktop shell (via ELIZA_APP_NAME / ELIZA_APP_ID env vars)
 *
 * To create a new app: copy this file and change the values below.
 *
 * Scaffold placeholders are replaced by `elizaos create` at project
 * creation time. Edit any value below to change app identity.
 */
import type { AppConfig } from "@elizaos/ui";

interface AppWebConfig {
  shortName: string;
  themeColor: string;
  backgroundColor: string;
  shareImagePath: string;
}

const config = {
  appName: "__APP_NAME__",
  appId: "__BUNDLE_ID__",
  orgName: "__ORG_NAME__",
  repoName: "__REPO_NAME__",
  cliName: "__PROJECT_SLUG__",
  description: "An elizaOS app",
  // Sourced from cliName when unset; downstream tooling normalizes to UPPER_SNAKE.
  envPrefix: "__PROJECT_SLUG__",
  namespace: "__PROJECT_SLUG__",
  defaultApps: [],

  desktop: {
    bundleId: "__BUNDLE_ID__",
    urlScheme: "__PROJECT_SLUG__",
  },

  web: {
    shortName: "__APP_NAME__",
    themeColor: "#08080a",
    backgroundColor: "#0a0a0a",
    shareImagePath: "/og-image.png",
  },

  branding: {
    appName: "__APP_NAME__",
    orgName: "__ORG_NAME__",
    repoName: "__REPO_NAME__",
    docsUrl: "__DOCS_URL__",
    appUrl: "__APP_URL__",
    bugReportUrl: "__BUG_REPORT_URL__",
    hashtag: "__HASHTAG__",
    fileExtension: "__FILE_EXTENSION__",
    packageScope: "__PACKAGE_SCOPE__",
  },
} satisfies AppConfig & { web: AppWebConfig };

export default config;
