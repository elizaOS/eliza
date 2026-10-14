/**
 * Explicit standalone host speech on libelizainference: Paradee-8M speech
 * output (`/api/tts/paradee`) and Qwen3-ASR speech input
 * (`/api/asr/libelizainference`). Each runs in its own host worker and needs no
 * agent text model or Eliza-1 bundle.
 */
import type http from "node:http";
import { resolveAuthorizedRouteRole } from "./auth";
import type { CompatRuntimeState } from "./compat-route-shared";
import { sendJson } from "./response";
import {
  AsrAudioError,
  readMonoPcm16Wav,
  StandaloneAsrService,
} from "./standalone-asr-service";
import { StandaloneTtsService } from "./standalone-speech-service";

export const TTS_PROVIDER = "libelizainference-paradee";
export const ASR_PROVIDER = "local-inference";
const MAX_AUDIO_BYTES = 2 * 1024 * 1024;

interface SpeechHost {
  tts: StandaloneTtsService;
  asr: StandaloneAsrService;
  seen: Map<string, number>;
  ttsActive: boolean;
  asrActive: boolean;
  stopped: boolean;
}
const hosts = new WeakMap<CompatRuntimeState, SpeechHost>();
const closedHosts = new WeakSet<CompatRuntimeState>();
const generations = new WeakMap<CompatRuntimeState, number>();
const ttsEnabled = () => process.env.ELIZA_PARADEE_ENABLED === "1";
const asrEnabled = () => process.env.ELIZA_ASR_ENABLED === "1";

export function closeStandaloneSpeech(state: CompatRuntimeState): void {
  closedHosts.add(state);
  stopStandaloneSpeech(state);
}
export function stopStandaloneSpeech(state: CompatRuntimeState): void {
  generations.set(state, (generations.get(state) ?? 0) + 1);
  const host = hosts.get(state);
  if (!host) return;
  hosts.delete(state);
  host.stopped = true;
  host.tts.stop();
  host.asr.stop();
}
function hostFor(state: CompatRuntimeState): SpeechHost {
  let host = hosts.get(state);
  if (!host) {
    host = {
      tts: new StandaloneTtsService(),
      asr: new StandaloneAsrService(),
      seen: new Map(),
      ttsActive: false,
      asrActive: false,
      stopped: false,
    };
    hosts.set(state, host);
  }
  return host;
}
/** Warm only the configured workers; requests share their cancellable boot. */
export function warmStandaloneSpeech(state: CompatRuntimeState): void {
  if (!process.versions.bun || closedHosts.has(state)) return;
  if (!ttsEnabled() && !asrEnabled()) return;
  const host = hostFor(state);
  const warm = (start: Promise<unknown>) =>
    void start.catch(() => {
      if (!host.stopped)
        console.warn(
          "Local speech initialization failed; the next request can retry.",
        );
    });
  if (ttsEnabled())
    warm(
      Promise.all([
        host.tts.initialize(),
        // The built `./routes` entry re-exports the TTS route module; the deep
        // `routes/local-inference-tts-route` path only exists in source.
        import("@elizaos/plugin-local-inference/routes"),
      ]),
    );
  if (asrEnabled()) warm(host.asr.initialize());
}

/** Reserve a replay key for one owner request; false when it was refused. */
function admit(
  res: http.ServerResponse,
  host: SpeechHost,
  identityId: string,
  requestId: unknown,
  active: boolean,
): requestId is string {
  if (typeof requestId !== "string" || !/^[0-9a-f-]{36}$/i.test(requestId)) {
    sendJson(res, 400, { error: "request_id_required" });
    return false;
  }
  const key = `${identityId}:${requestId}`,
    now = Date.now();
  for (const [id, expires] of host.seen)
    if (expires < now) host.seen.delete(id);
  if (host.seen.has(key)) {
    sendJson(res, 409, { error: "duplicate_request" });
    return false;
  }
  if (active || host.seen.size >= 256) {
    sendJson(res, 429, { error: "provider_busy" });
    return false;
  }
  return true;
}

export async function handleStandaloneSpeechRoute(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  state: CompatRuntimeState,
): Promise<boolean> {
  const path = new URL(req.url ?? "/", "http://localhost").pathname;
  const kind =
    path === "/api/tts/paradee" || path === "/api/tts/paradee/status"
      ? "tts"
      : path === "/api/asr/libelizainference" ||
          path === "/api/asr/libelizainference/status"
        ? "asr"
        : null;
  if (!kind) return false;
  const status = path.endsWith("/status");
  if (req.method !== (status ? "GET" : "POST")) return false;
  const provider = kind === "tts" ? TTS_PROVIDER : ASR_PROVIDER;
  const runtime = state.current;
  const generation = generations.get(state) ?? 0;
  const current = () =>
    state.current === runtime && (generations.get(state) ?? 0) === generation;
  const identity = await resolveAuthorizedRouteRole(req, {
    state,
    allowTrustedLocalBypass: false,
  });
  if (!identity.ok) {
    sendJson(res, identity.status, { error: identity.reason });
    return true;
  }
  if (identity.role !== "OWNER" || !identity.identityId) {
    sendJson(res, 403, { error: "paired_owner_required" });
    return true;
  }
  if (!current()) {
    sendJson(res, 409, { error: "speech_host_changed" });
    return true;
  }
  if (closedHosts.has(state)) {
    sendJson(res, 503, { error: "speech_host_closed" });
    return true;
  }
  if (!(kind === "tts" ? ttsEnabled() : asrEnabled())) {
    sendJson(
      res,
      status ? 200 : 503,
      status
        ? { ready: false, provider }
        : { error: "provider_not_configured" },
    );
    return true;
  }
  if (!process.versions.bun) {
    sendJson(
      res,
      status ? 200 : 503,
      status
        ? { ready: false, provider, error: "bun_host_required" }
        : { error: "bun_host_required" },
    );
    return true;
  }
  const host = hostFor(state);
  const service = kind === "tts" ? host.tts : host.asr;
  if (status) {
    try {
      await service.initialize();
      if (!current() || host.stopped) {
        sendJson(res, 409, { error: "speech_host_changed" });
        return true;
      }
      sendJson(
        res,
        200,
        kind === "tts"
          ? {
              ready: service.initialized,
              busy: host.ttsActive,
              provider,
              model: "paradee-8m-v1.0",
              voice: "af_heart",
              sampleRate: 24000,
              format: "pcm16-wav",
              maxCharacters: 500,
            }
          : {
              ready: service.initialized,
              busy: host.asrActive,
              provider,
              model: "qwen3-asr-0.6b-q8_0",
              language: "en",
              format: "pcm16-wav",
              maxDurationSeconds: 60,
            },
      );
    } catch {
      sendJson(res, 200, {
        ready: false,
        provider,
        error: "initialization_failed",
      });
    }
    return true;
  }
  const requestId = req.headers["x-request-id"];
  if (
    !admit(
      res,
      host,
      identity.identityId,
      requestId,
      (kind === "tts" ? host.ttsActive : host.asrActive) || service.busy,
    )
  )
    return true;
  const contentType = req.headers["content-type"] ?? "";
  if (
    kind === "tts"
      ? !/^application\/json(?:;|$)/i.test(contentType)
      : !/^audio\/(?:x-)?wav(?:;|$)/i.test(contentType)
  ) {
    sendJson(res, 415, {
      error: kind === "tts" ? "json_required" : "pcm_wav_required",
    });
    return true;
  }
  const controller = new AbortController(),
    abort = () => controller.abort(),
    close = () => {
      if (!res.writableEnded) abort();
    };
  req.once("aborted", abort);
  res.once("close", close);
  const deadline = setTimeout(
    () => {
      abort();
      req.destroy();
    },
    kind === "tts" ? 75_000 : 105_000,
  );
  if (kind === "tts") host.ttsActive = true;
  else host.asrActive = true;
  try {
    const limit = kind === "tts" ? 8192 : MAX_AUDIO_BYTES;
    const declared = Number(req.headers["content-length"]);
    if (Number.isFinite(declared) && declared > limit) {
      sendJson(res, 413, {
        error: kind === "tts" ? "request_too_large" : "audio_too_large",
      });
      return true;
    }
    let size = 0;
    const parts: Buffer[] = [];
    for await (const part of req) {
      size += part.length;
      if (size > limit) {
        sendJson(res, 413, {
          error: kind === "tts" ? "request_too_large" : "audio_too_large",
        });
        return true;
      }
      parts.push(Buffer.from(part));
    }
    controller.signal.throwIfAborted();
    const body = Buffer.concat(parts);
    if (kind === "asr") {
      let audio: ReturnType<typeof readMonoPcm16Wav>;
      try {
        audio = readMonoPcm16Wav(body);
      } catch (error) {
        if (!(error instanceof AsrAudioError)) throw error;
        sendJson(res, error.status, { error: error.code });
        return true;
      }
      if (!current() || host.stopped) throw new Error("Speech host stopped");
      host.seen.set(`${identity.identityId}:${requestId}`, Date.now() + 600000);
      const text = await host.asr.transcribe(
        requestId,
        audio.samples,
        audio.sampleRate,
        controller.signal,
      );
      controller.signal.throwIfAborted();
      if (!current() || host.stopped) throw new Error("Speech host stopped");
      if (!text) {
        sendJson(res, 422, { error: "no_speech" });
        return true;
      }
      sendJson(res, 200, { text, provider });
      return true;
    }
    let input: Record<string, unknown>;
    try {
      input = JSON.parse(body.toString("utf8"));
    } catch {
      sendJson(res, 400, { error: "invalid_json" });
      return true;
    }
    if (
      !input ||
      typeof input !== "object" ||
      Array.isArray(input) ||
      typeof input.text !== "string" ||
      !input.text.trim() ||
      input.text.length > 500 ||
      Object.keys(input).some((key) => key !== "text")
    ) {
      sendJson(res, 422, { error: "invalid_speech_text" });
      return true;
    }
    const { sanitizeLocalInferenceSpeechText } = await import(
      "@elizaos/plugin-local-inference/routes"
    );
    const text = sanitizeLocalInferenceSpeechText(input.text);
    if (!text) {
      sendJson(res, 422, { error: "no_speakable_text" });
      return true;
    }
    if (!current() || host.stopped) throw new Error("Speech host stopped");
    host.seen.set(`${identity.identityId}:${requestId}`, Date.now() + 600000);
    const audio = await host.tts.synthesize(requestId, text, controller.signal);
    controller.signal.throwIfAborted();
    if (!current() || host.stopped) throw new Error("Speech host stopped");
    if (!res.destroyed) {
      res.writeHead(200, {
        "Content-Type": "audio/wav",
        "Content-Length": audio.length,
        "Cache-Control": "no-store",
        "X-Request-Id": requestId,
        "X-Eliza-Speech-Provider": provider,
      });
      res.end(audio);
    }
  } catch {
    if (!res.destroyed)
      sendJson(res, controller.signal.aborted ? 499 : 502, {
        error: controller.signal.aborted
          ? "cancelled"
          : kind === "tts"
            ? "speech_failed"
            : "transcription_failed",
      });
  } finally {
    clearTimeout(deadline);
    req.off("aborted", abort);
    res.off("close", close);
    if (kind === "tts") host.ttsActive = false;
    else host.asrActive = false;
  }
  return true;
}
