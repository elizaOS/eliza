import type http from "node:http";
import { resolveAuthorizedRouteRole } from "./auth";
import type { CompatRuntimeState } from "./compat-route-shared";
import { sendJson } from "./response";
import { StandaloneKokoroService } from "./standalone-kokoro-service";

const service = new StandaloneKokoroService();
process.once("exit", () => service.stop());
const seen = new Map<string, number>();
let active = false;
export async function handleStandaloneKokoroRoute(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  state: CompatRuntimeState,
) {
  const path = new URL(req.url ?? "/", "http://localhost").pathname;
  const status = req.method === "GET" && path === "/api/tts/kokoro/status";
  if (!status && !(req.method === "POST" && path === "/api/tts/kokoro"))
    return false;
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
  if (process.env.ELIZA_KOKORO_ENABLED !== "1") {
    sendJson(
      res,
      status ? 200 : 503,
      status
        ? { ready: false, provider: "standalone-kokoro" }
        : { error: "provider_not_configured" },
    );
    return true;
  }
  if (status) {
    try {
      await service.initialize();
      sendJson(res, 200, {
        ready: service.initialized,
        busy: active,
        provider: "standalone-kokoro",
        voice: "af_bella",
        sampleRate: 24000,
        format: "pcm16-wav",
        maxCharacters: 500,
      });
    } catch {
      sendJson(res, 200, {
        ready: false,
        provider: "standalone-kokoro",
        error: "initialization_failed",
      });
    }
    return true;
  }
  const requestId = req.headers["x-request-id"];
  if (typeof requestId !== "string" || !/^[0-9a-f-]{36}$/i.test(requestId)) {
    sendJson(res, 400, { error: "request_id_required" });
    return true;
  }
  const key = `${identity.identityId}:${requestId}`,
    now = Date.now();
  for (const [id, expires] of seen) if (expires < now) seen.delete(id);
  if (seen.has(key)) {
    sendJson(res, 409, { error: "duplicate_request" });
    return true;
  }
  if (active || seen.size >= 256) {
    sendJson(res, 429, { error: "provider_busy" });
    return true;
  }
  if (!/^application\/json(?:;|$)/i.test(req.headers["content-type"] ?? "")) {
    sendJson(res, 415, { error: "json_required" });
    return true;
  }
  const controller = new AbortController(),
    abort = () => controller.abort(),
    close = () => {
      if (!res.writableEnded) abort();
    };
  req.once("aborted", abort);
  res.once("close", close);
  const deadline = setTimeout(() => {
    abort();
    req.destroy();
  }, 45000);
  active = true;
  try {
    let size = 0;
    const parts: Buffer[] = [];
    for await (const part of req) {
      size += part.length;
      if (size > 8192) {
        sendJson(res, 413, { error: "request_too_large" });
        return true;
      }
      parts.push(Buffer.from(part));
    }
    controller.signal.throwIfAborted();
    let input: Record<string, unknown>;
    try {
      input = JSON.parse(Buffer.concat(parts).toString("utf8"));
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
      "@elizaos/plugin-local-inference/routes/local-inference-tts-route"
    );
    const text = sanitizeLocalInferenceSpeechText(input.text);
    if (!text) {
      sendJson(res, 422, { error: "no_speakable_text" });
      return true;
    }
    seen.set(key, now + 600000);
    const audio = await service.synthesize(requestId, text, controller.signal);
    controller.signal.throwIfAborted();
    if (!res.destroyed) {
      res.writeHead(200, {
        "Content-Type": "audio/wav",
        "Content-Length": audio.length,
        "Cache-Control": "no-store",
        "X-Request-Id": requestId,
        "X-Eliza-Speech-Provider": "standalone-kokoro",
      });
      res.end(audio);
    }
  } catch {
    if (!res.destroyed)
      sendJson(res, controller.signal.aborted ? 499 : 502, {
        error: controller.signal.aborted ? "cancelled" : "speech_failed",
      });
  } finally {
    clearTimeout(deadline);
    req.off("aborted", abort);
    res.off("close", close);
    active = false;
  }
  return true;
}
