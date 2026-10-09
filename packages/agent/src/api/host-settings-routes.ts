/** Host-owned runtime mode and transient stream settings. */
import type http from "node:http";
import { readRequestBody, sendJson, sendJsonError } from "@elizaos/host";
import {
  isMobilePlatform,
  normalizeDeploymentTargetConfig,
} from "@elizaos/host/protocol";

import { loadEffectiveElizaConfig } from "../config/config.ts";

/**
 * Visual/voice settings persisted by GET/POST /api/stream/settings. The
 * dashboard hydrates these at startup (client.getStreamSettings()); the
 * server keeps an in-process snapshot per boot.
 */
type StreamVisualSettings = {
  theme?: string;
  avatarIndex?: number;
  voice?: {
    enabled: boolean;
    autoSpeak?: boolean;
    provider?: string;
  };
};
const STREAM_SETTINGS_MAX_JSON_BYTES = 4096;
let streamSettings: StreamVisualSettings = {};
function validateStreamSettings(raw: unknown):
  | {
      settings: StreamVisualSettings;
      error?: undefined;
    }
  | {
      settings?: undefined;
      error: string;
    } {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { error: "Settings must be a non-array object" };
  }
  if (JSON.stringify(raw).length > STREAM_SETTINGS_MAX_JSON_BYTES) {
    return {
      error: `Settings payload exceeds ${STREAM_SETTINGS_MAX_JSON_BYTES} byte limit`,
    };
  }
  const input = raw as Record<string, unknown>;
  const result: StreamVisualSettings = {};
  if ("theme" in input) {
    if (typeof input.theme !== "string" || input.theme.length > 64) {
      return { error: "theme must be a string (max 64 chars)" };
    }
    result.theme = input.theme;
  }
  if ("avatarIndex" in input) {
    if (
      typeof input.avatarIndex !== "number" ||
      !Number.isInteger(input.avatarIndex) ||
      input.avatarIndex < 0 ||
      input.avatarIndex > 999
    ) {
      return { error: "avatarIndex must be an integer between 0 and 999" };
    }
    result.avatarIndex = input.avatarIndex;
  }
  if ("voice" in input) {
    if (
      !input.voice ||
      typeof input.voice !== "object" ||
      Array.isArray(input.voice)
    ) {
      return { error: "voice must be an object" };
    }
    const v = input.voice as Record<string, unknown>;
    const voice: NonNullable<StreamVisualSettings["voice"]> = {
      enabled: false,
    };
    if ("enabled" in v) {
      if (typeof v.enabled !== "boolean") {
        return { error: "voice.enabled must be a boolean" };
      }
      voice.enabled = v.enabled;
    }
    if ("autoSpeak" in v) {
      if (typeof v.autoSpeak !== "boolean") {
        return { error: "voice.autoSpeak must be a boolean" };
      }
      voice.autoSpeak = v.autoSpeak;
    }
    if ("provider" in v) {
      if (typeof v.provider !== "string" || v.provider.length > 64) {
        return { error: "voice.provider must be a string (max 64 chars)" };
      }
      voice.provider = v.provider;
    }
    result.voice = voice;
  }
  const knownKeys = new Set(["theme", "avatarIndex", "voice"]);
  for (const key of Object.keys(input)) {
    if (!knownKeys.has(key)) return { error: `Unknown settings key: ${key}` };
  }
  return { settings: result };
}
function isTrueMobileLocalAgent(): boolean {
  return isMobilePlatform() || process.env.ELIZA_MOBILE_LOCAL_AGENT === "1";
}
function getRuntimeModeFallbackSnapshot(): {
  mode: "local" | "cloud" | "remote";
  deploymentRuntime: "local" | "cloud" | "remote";
  isRemoteController: boolean;
  remoteApiBaseConfigured: boolean;
} {
  if (isTrueMobileLocalAgent()) {
    return {
      mode: "local",
      deploymentRuntime: "local",
      isRemoteController: false,
      remoteApiBaseConfigured: false,
    };
  }
  const deploymentTarget = normalizeDeploymentTargetConfig(
    loadEffectiveElizaConfig().deploymentTarget,
  );
  const deploymentRuntime = deploymentTarget?.runtime ?? "local";
  return {
    mode: deploymentRuntime,
    deploymentRuntime,
    isRemoteController: deploymentRuntime === "remote",
    remoteApiBaseConfigured: Boolean(
      deploymentRuntime === "remote" && deploymentTarget?.remoteApiBase?.trim(),
    ),
  };
}
function parseJsonPayload(raw: unknown): unknown {
  if (typeof raw !== "string") return raw;
  if (raw.trim().length === 0) return {};
  return JSON.parse(raw);
}
export async function handleHostSettingsRoutes(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  pathname: string,
  method: string,
): Promise<boolean> {
  if (method === "GET" && pathname === "/api/runtime/mode") {
    sendJson(res, getRuntimeModeFallbackSnapshot());
    return true;
  }
  if (method === "GET" && pathname === "/api/stream/settings") {
    sendJson(res, { ok: true, settings: streamSettings });
    return true;
  }
  if (method === "POST" && pathname === "/api/stream/settings") {
    try {
      const body = parseJsonPayload(await readRequestBody(req)) as
        | {
            settings?: unknown;
          }
        | undefined;
      const result = validateStreamSettings(body?.settings);
      if (result.error || !result.settings) {
        sendJsonError(res, result.error ?? "Invalid settings", 400);
        return true;
      }
      const settings = { ...streamSettings, ...result.settings };
      streamSettings = settings;
      sendJson(res, { ok: true, settings });
    } catch (err) {
      sendJsonError(
        res,
        err instanceof Error ? err.message : "Invalid stream settings",
        400,
      );
    }
    return true;
  }
  return false;
}
