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

const APP_ENV_PREFIX = normalizeEnvPrefix(appConfig.envPrefix);

const allowedHostsEnv =
  process.env.ELIZA_ALLOWED_HOSTS ??
  (APP_ENV_PREFIX ? process.env[`${APP_ENV_PREFIX}_ALLOWED_HOSTS`] : undefined);

function isIosStoreBuild(): boolean {
  return (
    process.env.ELIZA_CAPACITOR_BUILD_TARGET === "ios" &&
    (process.env.ELIZA_BUILD_VARIANT === "store" ||
      process.env.ELIZA_RELEASE_AUTHORITY === "apple-app-store")
  );
}

function normalizeHost(host: string): string {
  return host
    .trim()
    .toLowerCase()
    .replace(/^\[|\]$/g, "");
}

function isPrivateOrLoopbackHost(host: string): boolean {
  const normalized = normalizeHost(host);
  return (
    normalized === "localhost" ||
    normalized === "::1" ||
    normalized === "0.0.0.0" ||
    normalized.startsWith("127.") ||
    normalized.startsWith("10.") ||
    normalized.startsWith("192.168.") ||
    /^172\.(1[6-9]|2\d|3[0-1])\./.test(normalized) ||
    /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(normalized) ||
    normalized.startsWith("169.254.") ||
    (normalized.includes(":") &&
      (normalized.startsWith("fe80:") ||
        normalized.startsWith("fc") ||
        normalized.startsWith("fd"))) ||
    normalized === "local" ||
    normalized === "internal" ||
    normalized === "lan" ||
    normalized === "ts.net" ||
    normalized.endsWith(".local") ||
    normalized.endsWith(".internal") ||
    normalized.endsWith(".lan") ||
    normalized.endsWith(".ts.net")
  );
}

function filterIosStoreAllowedHosts(
  entries: ReturnType<typeof parseAllowedHostEnv>,
): ReturnType<typeof parseAllowedHostEnv> {
  if (!isIosStoreBuild()) return entries;
  return entries.filter((entry) => !isPrivateOrLoopbackHost(entry.host));
}

const allowNavigation: CapacitorAllowNavigation = [
  ...(isIosStoreBuild() ? [] : ["localhost", "127.0.0.1"]),
  "*.elizacloud.ai",
  "rs-sdk-demo.fly.dev",
  "*.fly.dev",
  "hyperscape.gg",
  "*.hyperscape.gg",
  ...toCapacitorAllowNavigation(
    filterIosStoreAllowedHosts(parseAllowedHostEnv(allowedHostsEnv)),
  ),
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
