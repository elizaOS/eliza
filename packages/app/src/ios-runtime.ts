export const DEFAULT_ELIZA_CLOUD_BASE = "https://www.elizacloud.ai";

export type IosRuntimeMode = "remote-mac" | "cloud" | "cloud-hybrid" | "local";

export interface IosRuntimeConfig {
  mode: IosRuntimeMode;
  apiBase?: string;
  apiToken?: string;
  cloudApiBase: string;
  deviceBridgeUrl?: string;
  deviceBridgeToken?: string;
}

type RuntimeEnv = Record<string, string | boolean | undefined>;

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
    case "remote":
    case "remote-mac":
    case "mac":
      return "remote-mac";
    case "hybrid":
    case "cloud-hybrid":
    case "cloud+local":
    case "cloud-local":
      return "cloud-hybrid";
    case "local":
      return "local";
    default:
      return "cloud";
  }
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
    readString(env, [
      "VITE_MILADY_ANDROID_RUNTIME_MODE",
      "VITE_MILADY_IOS_RUNTIME_MODE",
      "VITE_MILADY_MOBILE_RUNTIME_MODE",
      "VITE_ELIZA_ANDROID_RUNTIME_MODE",
      "VITE_ELIZA_IOS_RUNTIME_MODE",
      "VITE_ELIZA_MOBILE_RUNTIME_MODE",
    ]),
  );
  const apiBase = readString(env, [
    "VITE_MILADY_ANDROID_API_BASE",
    "VITE_MILADY_IOS_API_BASE",
    "VITE_MILADY_MOBILE_API_BASE",
    "VITE_ELIZA_ANDROID_API_BASE",
    "VITE_ELIZA_IOS_API_BASE",
    "VITE_ELIZA_MOBILE_API_BASE",
  ])?.replace(/\/+$/, "");
  const apiToken = readString(env, [
    "VITE_MILADY_ANDROID_API_TOKEN",
    "VITE_MILADY_IOS_API_TOKEN",
    "VITE_MILADY_MOBILE_API_TOKEN",
    "VITE_ELIZA_ANDROID_API_TOKEN",
    "VITE_ELIZA_IOS_API_TOKEN",
    "VITE_ELIZA_MOBILE_API_TOKEN",
  ]);
  const explicitDeviceBridgeUrl = readString(env, [
    "VITE_MILADY_DEVICE_BRIDGE_URL",
    "VITE_ELIZA_DEVICE_BRIDGE_URL",
  ]);
  const deviceBridgeToken = readString(env, [
    "VITE_MILADY_DEVICE_BRIDGE_TOKEN",
    "VITE_ELIZA_DEVICE_BRIDGE_TOKEN",
  ]);

  return {
    mode,
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
