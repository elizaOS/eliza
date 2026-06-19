/**
 * Cloud TTS helpers — proxy to Eliza Cloud (`elizacloud.ai`).
 *
 * Pure / config-driven helpers (TTS API key resolution, base URL resolution,
 * voice / model id normalization, compat header mirroring) live in
 * `@elizaos/shared/elizacloud/server-cloud-tts` so host-layer packages can
 * resolve cloud TTS configuration without reverse-importing this plugin.
 *
 * The HTTP request handler (`handleCloudTtsPreviewRoute`) stays here because
 * it wires together the runtime route system.
 */
import type http from "node:http";
import { sanitizeSpeechText } from "@elizaos/core";
import {
  _internalResolveCloudApiKey,
  ELIZA_CLOUD_TTS_MAX_TEXT_CHARS,
  resolveCloudProxyTtsModel,
  resolveCloudTtsCandidateUrls,
  resolveElizaCloudTtsVoiceId,
  shouldRetryCloudTtsUpstream,
  ttsDebug,
  ttsDebugTextPreview,
} from "@elizaos/shared";

export {
  __resetCloudBaseUrlCache,
  ELIZA_CLOUD_TTS_MAX_TEXT_CHARS,
  ensureCloudTtsApiKeyAlias,
  mirrorCompatHeaders,
  normalizeElizaCloudTtsModelId,
  resolveCloudProxyTtsModel,
  resolveCloudTtsBaseUrl,
  resolveCloudTtsCandidateUrls,
  resolveElevenLabsApiKeyForCloudMode,
  resolveElizaCloudTtsVoiceId,
  shouldRetryCloudTtsUpstream,
} from "@elizaos/shared";

/** Browser → API correlation (never forwarded to Eliza Cloud). */
export function readTtsDebugClientHeaders(
  req: Pick<http.IncomingMessage, "headers">,
): {
  messageId?: string;
  clipSegment?: string;
  hearingFull?: string;
} {
  const pick = (name: string): string | undefined => {
    const raw = req.headers[name];
    if (raw == null) return undefined;
    const v = Array.isArray(raw) ? raw[0] : raw;
    return typeof v === "string" && v.trim() ? v.trim() : undefined;
  };
  const decode = (enc: string | undefined): string | undefined => {
    if (!enc) return undefined;
    try {
      return decodeURIComponent(enc);
    } catch {
      return enc;
    }
  };
  return {
    messageId: decode(pick("x-elizaos-tts-message-id")),
    clipSegment: decode(pick("x-elizaos-tts-clip-segment")),
    hearingFull: decode(pick("x-elizaos-tts-full-preview")),
  };
}

function ttsClientDbgFields(
  hdr: ReturnType<typeof readTtsDebugClientHeaders>,
): Record<string, string> {
  const o: Record<string, string> = {};
  if (hdr.messageId) o.messageId = hdr.messageId;
  if (hdr.clipSegment) o.clipSegment = hdr.clipSegment;
  if (hdr.hearingFull) o.hearingFull = hdr.hearingFull;
  return o;
}

function pickBodyString(
  body: Record<string, unknown>,
  camel: string,
  snake: string,
): unknown {
  const a = body[camel];
  if (typeof a === "string" && a.trim()) return a;
  const b = body[snake];
  if (typeof b === "string" && b.trim()) return b;
  return undefined;
}

async function readRawRequestBody(req: http.IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
  }
  return Buffer.concat(chunks);
}

function sendJsonResponse(
  res: http.ServerResponse,
  status: number,
  body: unknown,
): void {
  if (res.headersSent) return;
  res.statusCode = status;
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.end(JSON.stringify(body));
}

function sendJsonErrorResponse(
  res: http.ServerResponse,
  status: number,
  message: string,
): void {
  sendJsonResponse(res, status, { error: message });
}

function forwardCloudTtsUpstreamError(
  res: http.ServerResponse,
  status: number,
  bodyText: string,
): void {
  if (res.headersSent) return;
  const trimmed = bodyText.trim();
  if (
    (trimmed.startsWith("{") && trimmed.endsWith("}")) ||
    (trimmed.startsWith("[") && trimmed.endsWith("]"))
  ) {
    try {
      const parsed: unknown = JSON.parse(trimmed);
      sendJsonResponse(res, status, parsed);
      return;
    } catch {
      /* fall through */
    }
  }
  res.statusCode = status;
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.end(
    JSON.stringify({ error: trimmed || "Eliza Cloud TTS request failed" }),
  );
}

export async function handleCloudTtsPreviewRoute(
  req: http.IncomingMessage,
  res: http.ServerResponse,
): Promise<boolean> {
  const clientTtsDbg = readTtsDebugClientHeaders(req);
  const dbgExtra = ttsClientDbgFields(clientTtsDbg);

  const cloudApiKey = _internalResolveCloudApiKey();
  if (!cloudApiKey) {
    ttsDebug("server:cloud-tts:reject", {
      reason: "no_api_key",
      ...dbgExtra,
    });
    sendJsonErrorResponse(
      res,
      401,
      "Eliza Cloud is not connected. Connect your Eliza Cloud account first.",
    );
    return true;
  }

  const rawBody = await readRawRequestBody(req);
  let body: Record<string, unknown>;
  try {
    body = JSON.parse(rawBody.toString("utf8")) as Record<string, unknown>;
  } catch {
    sendJsonErrorResponse(res, 400, "Invalid JSON request body");
    return true;
  }

  const text = sanitizeSpeechText(
    typeof body.text === "string" ? body.text : "",
  );
  if (!text) {
    sendJsonErrorResponse(res, 400, "Missing text");
    return true;
  }

  if (text.length > ELIZA_CLOUD_TTS_MAX_TEXT_CHARS) {
    sendJsonErrorResponse(
      res,
      400,
      `Text too long. Maximum length is ${ELIZA_CLOUD_TTS_MAX_TEXT_CHARS} characters`,
    );
    return true;
  }

  const cloudModel = resolveCloudProxyTtsModel(
    pickBodyString(body, "modelId", "model_id"),
  );
  const cloudVoice = resolveElizaCloudTtsVoiceId(
    pickBodyString(body, "voiceId", "voice_id"),
  );
  const cloudUrls = resolveCloudTtsCandidateUrls();

  const ttsPreview = ttsDebugTextPreview(text);
  ttsDebug("server:cloud-tts:proxy", {
    textChars: text.length,
    preview: ttsPreview,
    modelId: cloudModel,
    voiceId: cloudVoice,
    urlCandidates: cloudUrls.length,
    ...dbgExtra,
  });

  try {
    let lastStatus = 0;
    let lastDetails = "unknown error";
    let cloudResponse: Response | null = null;
    for (let i = 0; i < cloudUrls.length; i++) {
      const cloudUrl = cloudUrls[i];
      if (cloudUrl === undefined) {
        continue;
      }
      const attempt = await fetch(cloudUrl, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${cloudApiKey}`,
          "x-api-key": cloudApiKey,
          "Content-Type": "application/json",
          Accept: "audio/mpeg",
        },
        body: JSON.stringify({
          text,
          voiceId: cloudVoice,
          modelId: cloudModel,
        }),
      });

      if (attempt.ok) {
        cloudResponse = attempt;
        ttsDebug("server:cloud-tts:upstream-ok", {
          urlIndex: i,
          status: attempt.status,
          preview: ttsPreview,
          ...dbgExtra,
        });
        break;
      }

      lastStatus = attempt.status;
      lastDetails = await attempt.text().catch(() => "unknown error");
      ttsDebug("server:cloud-tts:upstream-retry", {
        urlIndex: i,
        status: attempt.status,
        preview: ttsPreview,
        ...dbgExtra,
      });

      const hasMoreCandidates = i < cloudUrls.length - 1;
      if (!hasMoreCandidates || !shouldRetryCloudTtsUpstream(attempt.status)) {
        break;
      }
    }
    if (!cloudResponse) {
      ttsDebug("server:cloud-tts:reject", {
        reason: "upstream_failed",
        lastStatus,
        preview: ttsPreview,
        ...dbgExtra,
      });
      if (
        lastStatus === 400 ||
        lastStatus === 401 ||
        lastStatus === 402 ||
        lastStatus === 403 ||
        lastStatus === 429
      ) {
        forwardCloudTtsUpstreamError(res, lastStatus, lastDetails);
        return true;
      }
      sendJsonErrorResponse(
        res,
        502,
        `Eliza Cloud TTS failed (${lastStatus || 502}): ${lastDetails}`,
      );
      return true;
    }

    const audioBuffer = Buffer.from(await cloudResponse.arrayBuffer());
    ttsDebug("server:cloud-tts:success", {
      bytes: audioBuffer.length,
      preview: ttsPreview,
      ...dbgExtra,
    });
    res.statusCode = 200;
    res.setHeader("Content-Type", "audio/mpeg");
    res.setHeader("Cache-Control", "no-store");
    res.end(audioBuffer);
    return true;
  } catch (err) {
    sendJsonErrorResponse(
      res,
      502,
      `Eliza Cloud TTS request failed: ${err instanceof Error ? err.message : String(err)}`,
    );
    return true;
  }
}
