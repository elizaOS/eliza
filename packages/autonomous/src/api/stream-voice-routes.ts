import type { IncomingMessage, ServerResponse } from "node:http";
import { logger } from "@elizaos/core";
import { readRequestBody, sendJson, sendJsonError } from "./http-helpers";
import type { StreamRouteState } from "./stream-route-state";

interface StreamVoiceSettings {
  enabled?: boolean;
  autoSpeak?: boolean;
  provider?: string;
}

interface StreamSettingsLike {
  voice?: StreamVoiceSettings;
}

interface TtsBridgeLike {
  isSpeaking(): boolean;
  isAttached(): boolean;
  speak(text: string, config: Record<string, unknown>): Promise<boolean>;
}

export interface StreamVoiceRouteContext {
  req: IncomingMessage;
  res: ServerResponse;
  pathname: string;
  method: string;
  state: StreamRouteState;
  getTtsProviderStatus: (config: unknown) => {
    resolvedProvider: string | null;
    configuredProvider: string | null;
    hasApiKey: boolean;
  };
  resolveTtsConfig: (config: unknown) => Record<string, unknown> | null;
  ttsStreamBridge: TtsBridgeLike;
  sanitizeSpeechText: (text: string) => string;
  readStreamSettings: () => StreamSettingsLike;
  writeStreamSettings: (settings: StreamSettingsLike) => void;
}

const SPEAK_TEXT_MAX_CHARS = 2000;

function json(res: ServerResponse, data: unknown, status = 200): void {
  sendJson(res, data, status);
}

function error(res: ServerResponse, message: string, status: number): void {
  sendJsonError(res, message, status);
}

export async function handleStreamVoiceRoute(
  ctx: StreamVoiceRouteContext,
): Promise<boolean> {
  const {
    req,
    res,
    pathname,
    method,
    state,
    getTtsProviderStatus,
    resolveTtsConfig,
    ttsStreamBridge,
    sanitizeSpeechText,
    readStreamSettings,
    writeStreamSettings,
  } = ctx;

  if (method === "GET" && pathname === "/api/stream/voice") {
    try {
      const settings = readStreamSettings();
      const ttsConf = state.config?.messages?.tts;
      const providerStatus = getTtsProviderStatus(ttsConf);
      json(res, {
        ok: true,
        enabled: settings.voice?.enabled === true,
        autoSpeak: settings.voice?.autoSpeak !== false,
        provider: providerStatus.resolvedProvider,
        configuredProvider: providerStatus.configuredProvider,
        hasApiKey: providerStatus.hasApiKey,
        isSpeaking: ttsStreamBridge.isSpeaking(),
        isAttached: ttsStreamBridge.isAttached(),
      });
    } catch (err) {
      error(
        res,
        err instanceof Error ? err.message : "Failed to read voice config",
        500,
      );
    }
    return true;
  }

  if (method === "POST" && pathname === "/api/stream/voice") {
    try {
      const body = await readRequestBody(req);
      const parsed = typeof body === "string" ? JSON.parse(body) : body;
      const current = readStreamSettings();
      const voice: StreamVoiceSettings = {
        enabled: current.voice?.enabled ?? false,
        autoSpeak: current.voice?.autoSpeak ?? true,
      };
      if (typeof parsed?.enabled === "boolean") voice.enabled = parsed.enabled;
      if (typeof parsed?.autoSpeak === "boolean") {
        voice.autoSpeak = parsed.autoSpeak;
      }
      if (typeof parsed?.provider === "string") {
        voice.provider = parsed.provider;
      }
      current.voice = voice;
      writeStreamSettings(current);
      json(res, { ok: true, voice });
    } catch (err) {
      error(
        res,
        err instanceof Error ? err.message : "Failed to save voice settings",
        500,
      );
    }
    return true;
  }

  if (method === "POST" && pathname === "/api/stream/voice/speak") {
    try {
      const body = await readRequestBody(req);
      const parsed = typeof body === "string" ? JSON.parse(body) : body;
      const text =
        typeof parsed?.text === "string" ? sanitizeSpeechText(parsed.text) : "";
      if (!text) {
        error(res, "text must include speakable content", 400);
        return true;
      }

      if (text.length > SPEAK_TEXT_MAX_CHARS) {
        error(
          res,
          `text exceeds maximum length of ${SPEAK_TEXT_MAX_CHARS} characters`,
          400,
        );
        return true;
      }

      const ttsConf = state.config?.messages?.tts;
      const resolved = resolveTtsConfig(ttsConf);
      if (!resolved) {
        error(
          res,
          "No TTS provider available. Configure API keys in Secrets.",
          400,
        );
        return true;
      }

      if (!ttsStreamBridge.isAttached()) {
        error(
          res,
          "TTS bridge not attached — start stream with voice enabled first",
          400,
        );
        return true;
      }

      if (ttsStreamBridge.isSpeaking()) {
        error(res, "Already speaking — wait for current speech to finish", 429);
        return true;
      }

      const speaking = await ttsStreamBridge.speak(text, resolved);
      json(res, { ok: true, speaking });
    } catch (err) {
      error(res, err instanceof Error ? err.message : "TTS speak failed", 500);
    }
    return true;
  }

  return false;
}

export async function onAgentMessage(
  text: string,
  state: StreamRouteState,
  deps: Pick<
    StreamVoiceRouteContext,
    | "sanitizeSpeechText"
    | "readStreamSettings"
    | "resolveTtsConfig"
    | "ttsStreamBridge"
  >,
): Promise<void> {
  const speakableText = deps.sanitizeSpeechText(text);
  if (!speakableText) return;
  if (!state.streamManager.isRunning()) return;
  if (!deps.ttsStreamBridge.isAttached()) return;

  const settings = deps.readStreamSettings();
  if (!settings.voice?.enabled) return;
  if (settings.voice.autoSpeak === false) return;

  const ttsConf = state.config?.messages?.tts;
  const resolved = deps.resolveTtsConfig(ttsConf);
  if (!resolved) return;

  try {
    await deps.ttsStreamBridge.speak(speakableText, resolved);
  } catch (err) {
    logger.warn(
      `[stream-voice] Auto-TTS failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}
