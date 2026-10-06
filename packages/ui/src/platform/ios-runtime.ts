import { ElizaError } from "@elizaos/core/protocol";

export const DEFAULT_ELIZA_CLOUD_BASE = "https://eliza.app";

export type IosRuntimeMode = "remote-mac" | "cloud" | "cloud-hybrid" | "local";

export interface IosRuntimeConfig {
  mode: IosRuntimeMode;
  fullBun: boolean;
  apiBase?: string;
  apiToken?: string;
  cloudApiBase: string;
  deviceBridgeUrl?: string;
  deviceBridgeToken?: string;
}

type RuntimeEnv = Record<string, string | boolean | undefined>;
type MobileRuntimePlatform = "ios" | "android";

function readString(env: RuntimeEnv, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = env[key];
    if (typeof value !== "string") continue;
    const trimmed = value.trim();
    if (trimmed.length > 0) return trimmed;
  }
  return undefined;
}

function normalizeMode(value: string | undefined): IosRuntimeMode {
  switch (value?.trim().toLowerCase()) {
    case undefined:
    case "cloud":
      return "cloud";
    case "remote-mac":
      return "remote-mac";
    case "cloud-hybrid":
      return "cloud-hybrid";
    case "local":
      return "local";
    default:
      throw new ElizaError("Invalid iOS runtime mode", {
        code: "INVALID_IOS_RUNTIME_MODE",
        context: { mode: value },
      });
  }
}

function readBool(env: RuntimeEnv, keys: string[]): boolean {
  for (const key of keys) {
    const value = env[key];
    if (typeof value === "boolean") return value;
    if (typeof value !== "string") continue;
    if (/^(1|true|yes|on)$/i.test(value.trim())) return true;
  }
  return false;
}

function mobileEnvKeys(
  platform: MobileRuntimePlatform,
  suffix: "RUNTIME_MODE" | "API_BASE" | "API_TOKEN",
): string[] {
  const platformName = platform === "ios" ? "IOS" : "ANDROID";
  return [
    `VITE_ELIZA_${platformName}_${suffix}`,
    `VITE_ELIZA_MOBILE_${suffix}`,
  ];
}

export function resolveCloudApiBase(env: RuntimeEnv): string {
  return (
    readString(env, ["VITE_ELIZA_CLOUD_BASE", "VITE_CLOUD_BASE"]) ??
    DEFAULT_ELIZA_CLOUD_BASE
  ).replace(/\/+$/, "");
}

export function apiBaseToDeviceBridgeUrl(apiBase: string): string {
  const parsed = new URL(apiBase);
  parsed.protocol = parsed.protocol === "https:" ? "wss:" : "ws:";
  parsed.pathname = "/api/local-inference/device-bridge";
  parsed.search = "";
  parsed.hash = "";
  return parsed.toString();
}

export function resolveIosRuntimeConfig(env: RuntimeEnv): IosRuntimeConfig {
  const mode = normalizeMode(
    readString(env, mobileEnvKeys("ios", "RUNTIME_MODE")),
  );
  const { apiBase, apiToken } = resolveMobileApiConnection("ios", env);
  const explicitDeviceBridgeUrl = readString(env, [
    "VITE_ELIZA_DEVICE_BRIDGE_URL",
  ]);
  const deviceBridgeToken = readString(env, ["VITE_ELIZA_DEVICE_BRIDGE_TOKEN"]);

  return {
    mode,
    fullBun: readBool(env, [
      "VITE_ELIZA_IOS_FULL_BUN_AVAILABLE",
      "VITE_ELIZA_IOS_FULL_BUN_STRICT",
      "VITE_ELIZA_IOS_FULL_BUN_SMOKE",
    ]),
    ...(apiBase ? { apiBase } : {}),
    ...(apiToken ? { apiToken } : {}),
    cloudApiBase: resolveCloudApiBase(env),
    ...(explicitDeviceBridgeUrl
      ? { deviceBridgeUrl: explicitDeviceBridgeUrl }
      : mode === "cloud-hybrid" && apiBase
        ? { deviceBridgeUrl: apiBaseToDeviceBridgeUrl(apiBase) }
        : {}),
    ...(deviceBridgeToken ? { deviceBridgeToken } : {}),
  };
}

export function resolveMobileApiConnection(
  platform: MobileRuntimePlatform,
  env: RuntimeEnv,
): { apiBase?: string; apiToken?: string } {
  const apiBase = readString(env, mobileEnvKeys(platform, "API_BASE"))?.replace(
    /\/+$/,
    "",
  );
  const apiToken = readString(env, mobileEnvKeys(platform, "API_TOKEN"));
  return { ...(apiBase ? { apiBase } : {}), ...(apiToken ? { apiToken } : {}) };
}
