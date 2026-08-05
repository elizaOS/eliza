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
import type { AppConfig } from "@elizaos/app-core";

interface AppWebConfig {
  shortName: string;
  themeColor: string;
  backgroundColor: string;
  shareImagePath: string;
}

const config = {
  appName: "My Project",
  appId: "com.example.myproject",
  orgName: "your-org",
  repoName: "my-project",
  cliName: "my-project",
  description: "An elizaOS app",
  // Sourced from cliName when unset; downstream tooling normalizes to UPPER_SNAKE.
  envPrefix: "my-project",
  namespace: "my-project",
  defaultApps: [],

  desktop: {
    bundleId: "com.example.myproject",
    urlScheme: "my-project",
  },

  web: {
    shortName: "My Project",
    themeColor: "#08080a",
    backgroundColor: "#0a0a0a",
    shareImagePath: "/og-image.png",
  },

  branding: {
    appName: "My Project",
    orgName: "your-org",
    repoName: "my-project",
    docsUrl: "https://example.com/my-project/docs",
    appUrl: "https://example.com/my-project",
    bugReportUrl: "https://github.com/your-org/my-project/issues/new",
    hashtag: "#MyProject",
    fileExtension: ".my-project.agent",
    packageScope: "myproject",
  },
} satisfies AppConfig & { web: AppWebConfig };

export default config;
