import type http from "node:http";
import { readRequestBody, sendJson, sendJsonError } from "@elizaos/core";
import { isMobilePlatform } from "@elizaos/shared";

let streamingSettingsModulePromise: Promise<{
  readStreamSettings: () => unknown;
  validateStreamSettings: (value: unknown) => unknown;
  writeStreamSettings: (value: unknown) => unknown;
}> | null = null;

function getStreamingSettingsModule() {
  if (!streamingSettingsModulePromise) {
    streamingSettingsModulePromise = import(
      "@elizaos/plugin-streaming"
    ) as Promise<{
      readStreamSettings: () => unknown;
      validateStreamSettings: (value: unknown) => {
        error?: string;
        settings?: Record<string, unknown>;
      };
      writeStreamSettings: (value: Record<string, unknown>) => void;
    }>;
  }
  return streamingSettingsModulePromise;
}

function mobileLocalCompatibilityEnabled(): boolean {
  return (
    isMobilePlatform() ||
    process.env.ELIZA_DEVICE_BRIDGE_ENABLED === "1" ||
    process.env.ELIZA_MOBILE_LOCAL_AGENT === "1"
  );
}

function parseJsonPayload(raw: unknown): unknown {
  if (typeof raw !== "string") return raw;
  if (raw.trim().length === 0) return {};
  return JSON.parse(raw);
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
