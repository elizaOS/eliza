import type { CapacitorConfig } from "@capacitor/cli";
import {
  parseAllowedHostEnv,
  toCapacitorAllowNavigation,
} from "@elizaos/shared";
import appConfig from "./app.config";

type CapacitorAllowNavigation = NonNullable<
  NonNullable<CapacitorConfig["server"]>["allowNavigation"]
>;

function normalizeEnvPrefix(value: string): string {
  return value
    .trim()
    .replace(/[^A-Za-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .toUpperCase();
}

const APP_ENV_PREFIX = normalizeEnvPrefix(
  appConfig.envPrefix ?? appConfig.cliName,
);

const allowedHostsEnv =
  process.env.ELIZA_ALLOWED_HOSTS ??
  (APP_ENV_PREFIX ? process.env[`${APP_ENV_PREFIX}_ALLOWED_HOSTS`] : undefined);

const allowNavigation: CapacitorAllowNavigation = [
  "localhost",
  "127.0.0.1",
  "*.elizacloud.ai",
  "rs-sdk-demo.fly.dev",
  "*.fly.dev",
  "hyperscape.gg",
  "*.hyperscape.gg",
  ...toCapacitorAllowNavigation(parseAllowedHostEnv(allowedHostsEnv)),
];

const config: CapacitorConfig = {
  appId: appConfig.appId,
  appName: appConfig.appName,
  webDir: "dist",
  server: {
    androidScheme: "https",
    iosScheme: "https",
    // Self-hosters add their own domains via {APP_ENV_PREFIX}_ALLOWED_HOSTS
    // (build-time env, comma-separated). Listed entries are baseline.
    allowNavigation,
  },
  plugins: {
    Keyboard: {
      resize: "body",
      resizeOnFullScreen: true,
    },
    StatusBar: {
      style: "dark",
      backgroundColor: "#0a0a0a",
    },
  },
  ios: {
    contentInset: "automatic",
    preferredContentMode: "mobile",
    backgroundColor: "#0a0a0a",
    allowsLinkPreview: false,
  },
  android: {
    backgroundColor: "#0a0a0a",
    allowMixedContent: false,
    captureInput: true,
    webContentsDebuggingEnabled: false,
  },
};

export default config;
