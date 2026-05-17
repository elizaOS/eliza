import type http from "node:http";
import { readRequestBody, sendJson, sendJsonError } from "@elizaos/core";
import type { StreamVisualSettings } from "@elizaos/plugin-streaming";
import {
  isMobilePlatform,
  normalizeDeploymentTargetConfig,
} from "@elizaos/shared";
import { loadElizaConfig } from "../config/config.ts";

type StreamingSettingsModule = {
  readStreamSettings: () => StreamVisualSettings;
  validateStreamSettings: (value: unknown) => {
    error?: string;
    settings?: StreamVisualSettings;
  };
  writeStreamSettings: (value: StreamVisualSettings) => void;
};

let streamingSettingsModulePromise: Promise<StreamingSettingsModule> | null =
  null;

const EMPTY_MOBILE_APPROVAL_SNAPSHOT = {
  mode: "off",
  pendingCount: 0,
  pendingApprovals: [],
} as const;
const STREAM_SETTINGS_MAX_JSON_BYTES = 4096;
let mobileFallbackStreamSettings: StreamVisualSettings = {};

function validateMobileFallbackStreamSettings(
  raw: unknown,
):
  | { settings: StreamVisualSettings; error?: undefined }
  | { settings?: undefined; error: string } {
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

function mobileFallbackStreamingSettingsModule(): StreamingSettingsModule {
  return {
    readStreamSettings: () => mobileFallbackStreamSettings,
    validateStreamSettings: validateMobileFallbackStreamSettings,
    writeStreamSettings: (value) => {
      mobileFallbackStreamSettings = value;
    },
  };
}

function isStreamingSettingsModule(
  value: unknown,
): value is StreamingSettingsModule {
  const mod = value as Partial<StreamingSettingsModule> | null | undefined;
  return (
    typeof mod?.readStreamSettings === "function" &&
    typeof mod.validateStreamSettings === "function" &&
    typeof mod.writeStreamSettings === "function"
  );
}

function getStreamingSettingsModule(): Promise<StreamingSettingsModule> {
  streamingSettingsModulePromise ??= (async () => {
    try {
      const mod = await import("@elizaos/plugin-streaming");
      if (isStreamingSettingsModule(mod)) return mod;
    } catch {
      // Mobile bundles intentionally stub optional desktop/streaming plugins.
    }
    return mobileFallbackStreamingSettingsModule();
  })();
  return streamingSettingsModulePromise;
}

function mobileLocalCompatibilityEnabled(): boolean {
  return (
    isMobilePlatform() ||
    process.env.ELIZA_DEVICE_BRIDGE_ENABLED === "1" ||
    process.env.ELIZA_MOBILE_LOCAL_AGENT === "1"
  );
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
    loadElizaConfig().deploymentTarget,
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

function sendEmptyComputerUseApprovalStream(
  req: http.IncomingMessage,
  res: http.ServerResponse,
): void {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
  });
  res.write(
    `data: ${JSON.stringify({
      type: "snapshot",
      snapshot: EMPTY_MOBILE_APPROVAL_SNAPSHOT,
    })}\n\n`,
  );

  const heartbeat = setInterval(() => {
    res.write(": keepalive\n\n");
  }, 30_000);
  heartbeat.unref?.();

  const cleanup = () => {
    clearInterval(heartbeat);
    res.end();
  };
  req.once("close", cleanup);
  req.once("aborted", cleanup);
}

export async function handleMobileOptionalRoutes(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  pathname: string,
  method: string,
): Promise<boolean> {
  if (!mobileLocalCompatibilityEnabled()) {
    return false;
  }

  if (method === "GET" && pathname === "/api/runtime/mode") {
    sendJson(res, getRuntimeModeFallbackSnapshot());
    return true;
  }

  if (method === "GET" && pathname === "/api/computer-use/approvals") {
    sendJson(res, EMPTY_MOBILE_APPROVAL_SNAPSHOT);
    return true;
  }

  if (method === "GET" && pathname === "/api/computer-use/approvals/stream") {
    sendEmptyComputerUseApprovalStream(req, res);
    return true;
  }

  if (method === "POST" && pathname === "/api/computer-use/approval-mode") {
    try {
      const body = parseJsonPayload(await readRequestBody(req)) as
        | { mode?: unknown }
        | undefined;
      if (body?.mode !== undefined && body.mode !== "off") {
        sendJsonError(
          res,
          "Mobile fallback only supports approval mode off",
          400,
        );
        return true;
      }
    } catch (err) {
      sendJsonError(
        res,
        err instanceof Error ? err.message : "Invalid approval mode payload",
        400,
      );
      return true;
    }
    sendJson(res, { mode: EMPTY_MOBILE_APPROVAL_SNAPSHOT.mode });
    return true;
  }

  if (method === "GET" && pathname === "/api/stream/settings") {
    const { readStreamSettings } = await getStreamingSettingsModule();
    sendJson(res, { ok: true, settings: readStreamSettings() });
    return true;
  }

  if (method === "POST" && pathname === "/api/stream/settings") {
    try {
      const {
        readStreamSettings,
        validateStreamSettings,
        writeStreamSettings,
      } = await getStreamingSettingsModule();
      const body = parseJsonPayload(await readRequestBody(req)) as
        | { settings?: unknown }
        | undefined;
      const result = validateStreamSettings(body?.settings);
      if (result.error || !result.settings) {
        sendJsonError(res, result.error ?? "Invalid settings", 400);
        return true;
      }
      const settings = { ...readStreamSettings(), ...result.settings };
      writeStreamSettings(settings);
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

  if (method === "GET" && pathname === "/api/catalog/apps") {
    sendJson(res, []);
    return true;
  }

  if (method === "GET" && pathname === "/api/drop/status") {
    sendJson(res, {
      dropEnabled: false,
      publicMintOpen: false,
      whitelistMintOpen: false,
      mintedOut: false,
      currentSupply: 0,
      maxSupply: 2138,
      shinyPrice: "0.1",
      userHasMinted: false,
    });
    return true;
  }

  if (method === "GET" && pathname === "/api/coding-agents/preflight") {
    sendJson(res, { installed: [], available: false });
    return true;
  }

  if (
    method === "GET" &&
    pathname === "/api/coding-agents/coordinator/status"
  ) {
    sendJson(res, {
      supervisionLevel: "unavailable",
      taskCount: 0,
      tasks: [],
      pendingConfirmations: 0,
      taskThreadCount: 0,
      taskThreads: [],
      frameworks: [],
    });
    return true;
  }

  if (pathname === "/api/lifeops/activity-signals") {
    if (method === "GET") {
      sendJson(res, { signals: [] });
      return true;
    }
    if (method === "POST") {
      await readRequestBody(req).catch(() => undefined);
      sendJson(res, {
        ok: true,
        stored: false,
        reason: "lifeops_unavailable_in_mobile_local_mode",
      });
      return true;
    }
  }

  return false;
}
