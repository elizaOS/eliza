import {emitSpeechProxyTiming,timeSpeechProxyFetch,speechUpstreamTraceId} from "./cloud-speech-proxy-timing";
/**
 * Cloud TTS helpers — proxy to Eliza Cloud (`api.eliza.app`).
 *
 * Pure / config-driven helpers (TTS API key resolution, base URL resolution,
 * voice / model id normalization, compat header mirroring) live in
 * `@elizaos/plugin-elizacloud/cloud-config/server-cloud-tts` so host-layer packages can
 * resolve cloud TTS configuration without reverse-importing this plugin.
 *
 * The HTTP request handler (`handleCloudTtsPreviewRoute`) stays here because
 * it wires together the runtime route system. Upstream `fetch` calls abort
 * with the same `resolveCloudTimeoutMs` ceiling as `models/speech.ts` /
 * `models/transcription.ts`; a stalled cloud hop must not hang the proxy
 * `for (;;)` warming loop forever.
 */
import type http from "node:http";
import { setTimeout as delay } from "node:timers/promises";
import { ELIZA_CLOUD_TTS_MAX_TEXT_CHARS } from "../cloud-config/server-cloud-tts.js";
import { _internalResolveCloudApiKey } from "../cloud-config/server-cloud-tts.js";
import { logger } from "@elizaos/core";
import { resolveCloudProxyTtsModel } from "../cloud-config/server-cloud-tts.js";
import { resolveCloudSttCandidateUrls } from "../cloud-config/server-cloud-tts.js";
import { resolveCloudTimeoutMs } from "../utils/config";
import { resolveCloudTtsCandidateUrls } from "../cloud-config/server-cloud-tts.js";
import { resolveElizaCloudTtsVoiceId } from "../cloud-config/server-cloud-tts.js";
import { sanitizeSpeechText } from "@elizaos/core/protocol";
import { shouldRetryCloudTtsUpstream } from "../cloud-config/server-cloud-tts.js";
import { ttsDebug } from "@elizaos/core";
import { ttsDebugTextPreview } from "@elizaos/core";
import { warmingRetryWaitSeconds } from "../utils/warming";
/** Abort a proxy hop when set; `0` on the env key opts out (same as the SDK). */
function cloudProxyAbortSignal(envKey: string, clientSignal: AbortSignal): AbortSignal {
    const timeoutMs = resolveCloudTimeoutMs(envKey, 60000);
    return timeoutMs === undefined ? clientSignal : AbortSignal.any([clientSignal, AbortSignal.timeout(timeoutMs)]);
}

/** Request EOF is normal. Only an aborted upload or an unfinished response close cancels the proxy. */
function cloudProxyClient(req: http.IncomingMessage, res: http.ServerResponse) {
    const controller = new AbortController();
    const abort = () => controller.abort(new DOMException("Cloud speech client disconnected", "AbortError"));
    const closed = () => { if (!res.writableEnded) abort(); };
    req.once("aborted", abort);
    res.once("close", closed);
    if (req.aborted || (res.destroyed && !res.writableEnded)) abort();
    return {
        signal: controller.signal,
        dispose() { req.off("aborted", abort); res.off("close", closed); },
    };
}

/** Forward only actual upstream evidence. An omitted provider remains unverified. */
function forwardCloudSpeechHeaders(upstream: Response, res: http.ServerResponse, kind: "tts" | "stt") {
    const providerHeader = `X-Eliza-${kind.toUpperCase()}-Provider`;
    for (const name of [providerHeader, ...(kind === "stt" ? ["X-Eliza-STT-Model"] : []), "Server-Timing", "X-Eliza-Trace-Id", "X-Request-Id", "X-Trace-Id", "CF-Ray"]) {
        const value = upstream.headers.get(name);
        if (value) res.setHeader(name, value);
    }
    if (kind === "tts") {
        const moderation = upstream.headers.get("X-Eliza-TTS-Moderation");
        if (moderation === "reviewed" || moderation === "approved-hit")
            res.setHeader("X-Eliza-TTS-Moderation", moderation);
    }
    const provider = upstream.headers.get(providerHeader)?.trim();
    if (provider) res.setHeader("X-Eliza-Speech-Provider", provider);
    res.setHeader("X-Eliza-Speech-Route", "cloud");
}

export { __resetCloudBaseUrlCache, ELIZA_CLOUD_TTS_MAX_TEXT_CHARS, ensureCloudTtsApiKeyAlias, mirrorCompatHeaders, normalizeElizaCloudTtsModelId, resolveCloudProxyTtsModel, resolveCloudTtsBaseUrl, resolveCloudTtsCandidateUrls, resolveElevenLabsApiKeyForCloudMode, resolveElizaCloudTtsVoiceId, shouldRetryCloudTtsUpstream } from "../cloud-config/server-cloud-tts.js";
/** Browser → API correlation (never forwarded to Eliza Cloud). */
export function readTtsDebugClientHeaders(req: Pick<http.IncomingMessage, "headers">): {
    messageId?: string;
    clipSegment?: string;
    hearingFull?: string;
} {
    const pick = (name: string): string | undefined => {
        const raw = req.headers[name];
        if (raw == null)
            return undefined;
        const v = Array.isArray(raw) ? raw[0] : raw;
        return typeof v === "string" && v.trim() ? v.trim() : undefined;
    };
    const decode = (enc: string | undefined): string | undefined => {
        if (!enc)
            return undefined;
        try {
            return decodeURIComponent(enc);
        }
        catch {
            return enc;
        }
    };
    return {
        messageId: decode(pick("x-elizaos-tts-message-id")),
        clipSegment: decode(pick("x-elizaos-tts-clip-segment")),
        hearingFull: decode(pick("x-elizaos-tts-full-preview")),
    };
}
function ttsClientDbgFields(hdr: ReturnType<typeof readTtsDebugClientHeaders>): Record<string, string> {
    const o: Record<string, string> = {};
    if (hdr.messageId)
        o.messageId = hdr.messageId;
    if (hdr.clipSegment)
        o.clipSegment = hdr.clipSegment;
    if (hdr.hearingFull)
        o.hearingFull = hdr.hearingFull;
    return o;
}
function pickBodyString(body: Record<string, unknown>, camel: string, snake: string): unknown {
    const a = body[camel];
    if (typeof a === "string" && a.trim())
        return a;
    const b = body[snake];
    if (typeof b === "string" && b.trim())
        return b;
    return undefined;
}
async function readRawRequestBody(req: http.IncomingMessage): Promise<Buffer> {
    // On the bare agent server (packages/agent/src/bin.ts), the host's
    // `attachJsonBodyIfPresent` already drains and JSON-parses the stream for an
    // `application/json` request, stashing `req.rawBody`/`req.body` before the
    // route runs. Re-streaming here would then read zero bytes and 400 a valid
    // request (#16348). Honor the pre-read body first, mirroring app's
    // `readCompatJsonBody`. The packaged app path re-streams `req` fresh and
    // leaves these unset, so it still falls through to the drain below.
    const preRead = req as http.IncomingMessage & {
        rawBody?: unknown;
        body?: unknown;
    };
    if (typeof preRead.rawBody === "string") {
        return Buffer.from(preRead.rawBody, "utf8");
    }
    if (preRead.body && typeof preRead.body === "object") {
        return Buffer.from(JSON.stringify(preRead.body), "utf8");
    }
    const chunks: Buffer[] = [];
    for await (const chunk of req) {
        chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
    }
    return Buffer.concat(chunks);
}
function sendJsonResponse(res: http.ServerResponse, status: number, body: unknown): void {
    if (res.headersSent)
        return;
    res.statusCode = status;
    res.setHeader("content-type", "application/json; charset=utf-8");
    res.end(JSON.stringify(body));
}
function sendJsonErrorResponse(res: http.ServerResponse, status: number, message: string): void {
    sendJsonResponse(res, status, { error: message });
}
function forwardCloudTtsUpstreamError(res: http.ServerResponse, status: number, bodyText: string): void {
    if (res.headersSent)
        return;
    const trimmed = bodyText.trim();
    if ((trimmed.startsWith("{") && trimmed.endsWith("}")) ||
        (trimmed.startsWith("[") && trimmed.endsWith("]"))) {
        try {
            const parsed: unknown = JSON.parse(trimmed);
            sendJsonResponse(res, status, parsed);
            return;
        }
        catch {
            /* fall through */
        }
    }
    res.statusCode = status;
    res.setHeader("content-type", "application/json; charset=utf-8");
    res.end(JSON.stringify({ error: trimmed || "Eliza Cloud TTS request failed" }));
}
export async function handleCloudTtsPreviewRoute(req: http.IncomingMessage, res: http.ServerResponse): Promise<boolean> {
    const clientTtsDbg = readTtsDebugClientHeaders(req);
    const dbgExtra = ttsClientDbgFields(clientTtsDbg);
    const cloudApiKey = _internalResolveCloudApiKey();
    if (!cloudApiKey) {
        ttsDebug("server:cloud-tts:reject", {
            reason: "no_api_key",
            ...dbgExtra,
        });
        sendJsonErrorResponse(res, 401, "Eliza Cloud is not connected. Connect your Eliza Cloud account first.");
        return true;
    }
    const rawBody = await readRawRequestBody(req);
    let body: Record<string, unknown>;
    try {
        body = JSON.parse(rawBody.toString("utf8")) as Record<string, unknown>;
    }
    catch {
        sendJsonErrorResponse(res, 400, "Invalid JSON request body");
        return true;
    }
    const text = sanitizeSpeechText(typeof body.text === "string" ? body.text : "");
    if (!text) {
        sendJsonErrorResponse(res, 400, "Missing text");
        return true;
    }
    if (text.length > ELIZA_CLOUD_TTS_MAX_TEXT_CHARS) {
        sendJsonErrorResponse(res, 400, `Text too long. Maximum length is ${ELIZA_CLOUD_TTS_MAX_TEXT_CHARS} characters`);
        return true;
    }
    const cloudModel = resolveCloudProxyTtsModel(pickBodyString(body, "modelId", "model_id"));
    const cloudVoice = resolveElizaCloudTtsVoiceId(pickBodyString(body, "voiceId", "voice_id"));
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
    const proxyRequestId=crypto.randomUUID();
    const timingSink=(value:import("./cloud-speech-proxy-timing").SpeechProxyObservation)=>logger.info(value,"[Cloud Speech] proxy timing");
    const client = cloudProxyClient(req, res);
    try {
        client.signal.throwIfAborted();
        let lastStatus = 0;
        let lastDetails = "unknown error";
        let cloudResponse: Response | null = null;
        let successfulCandidate=-1;
        for (let i = 0; i < cloudUrls.length; i++) {
            const cloudUrl = cloudUrls[i];
            if (cloudUrl === undefined) {
                continue;
            }
            // #16425: forward the client's per-utterance Idempotency-Key so the
            // cloud route can replay the direct attempt's committed reservation
            // instead of charging the same utterance a second time through this
            // fallback transport.
            const idempotencyKey = req.headers["idempotency-key"];
            let attempt: Response;
            let warmingRetries = 0;
            for (;;) {
                client.signal.throwIfAborted();
                const ttsSignal = cloudProxyAbortSignal("ELIZAOS_CLOUD_TTS_TIMEOUT_MS", client.signal);
                attempt = await timeSpeechProxyFetch(()=>fetch(cloudUrl, {
                    method: "POST",
                    headers: {
                        Authorization: `Bearer ${cloudApiKey}`,
                        "x-api-key": cloudApiKey,
                        "Content-Type": "application/json",
                        Accept: "audio/mpeg",
                        ...(typeof idempotencyKey === "string" && idempotencyKey
                            ? { "Idempotency-Key": idempotencyKey }
                            : {}),
                    },
                    body: JSON.stringify({
                        text,
                        voiceId: cloudVoice,
                        modelId: cloudModel,
                    }),
                    ...(ttsSignal ? { signal: ttsSignal } : {}),
                }),{kind:"tts",proxyRequestId,candidate:i,attempt:warmingRetries+1},timingSink);
                if (attempt.ok || warmingRetries >= 2)
                    break;
                const waitSeconds = await warmingRetryWaitSeconds(attempt,detail=>emitSpeechProxyTiming(timingSink,{kind:"tts",proxyRequestId,candidate:i,attempt:warmingRetries+1,phase:"retry_decision",status:attempt.status,upstreamTraceId:speechUpstreamTraceId(attempt),...detail}));
                if (waitSeconds === null)
                    break;
                warmingRetries++;
                logger.warn(`[Cloud TTS] retryable upstream unavailability (503), retry ${warmingRetries}/2 after ${waitSeconds}s`);
                await delay(waitSeconds * 1000, undefined, { signal: client.signal });
            }
            if (attempt.ok) {
                cloudResponse = attempt;
                successfulCandidate=i;
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
            client.signal.throwIfAborted();
            ttsDebug("server:cloud-tts:reject", {
                reason: "upstream_failed",
                lastStatus,
                preview: ttsPreview,
                ...dbgExtra,
            });
            if (lastStatus === 400 ||
                lastStatus === 401 ||
                lastStatus === 402 ||
                lastStatus === 403 ||
                lastStatus === 429) {
                forwardCloudTtsUpstreamError(res, lastStatus, lastDetails);
                return true;
            }
            sendJsonErrorResponse(res, 502, `Eliza Cloud TTS failed (${lastStatus || 502}): ${lastDetails}`);
            return true;
        }
        const drainStarted=Date.now();
        let audioBuffer:Buffer;
        try{audioBuffer=Buffer.from(await cloudResponse.arrayBuffer());}
        catch(error){emitSpeechProxyTiming(timingSink,{kind:"tts",proxyRequestId,candidate:successfulCandidate,phase:"body_drain",durationMs:Math.max(0,Date.now()-drainStarted),status:cloudResponse.status,outcome:"threw",upstreamTraceId:speechUpstreamTraceId(cloudResponse)});throw error;}
        emitSpeechProxyTiming(timingSink,{kind:"tts",proxyRequestId,candidate:successfulCandidate,phase:"body_drain",durationMs:Math.max(0,Date.now()-drainStarted),bytes:audioBuffer.length,status:cloudResponse.status,outcome:"returned",upstreamTraceId:speechUpstreamTraceId(cloudResponse)});
        client.signal.throwIfAborted();
        forwardCloudSpeechHeaders(cloudResponse, res, "tts");
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
    }
    catch (err) {
        if (client.signal.aborted) return true;
        sendJsonErrorResponse(res, 502, `Eliza Cloud TTS request failed: ${err instanceof Error ? err.message : String(err)}`);
        return true;
    }
    finally { client.dispose(); }
}
/** WAV bodies larger than this are rejected before proxying (cloud caps at 25MB). */
const ELIZA_CLOUD_STT_MAX_BYTES = 25 * 1024 * 1024;
export const ELIZA_CLOUD_STT_MAX_JSON_BODY_BYTES = Math.ceil(ELIZA_CLOUD_STT_MAX_BYTES / 3) * 4 + 1024;
/**
 * Read the raw request body up to a byte cap, aborting past the limit. The STT
 * body is opaque audio bytes (a WAV), so it is streamed straight through rather
 * than JSON-parsed — the cap prevents an oversized upload from buffering
 * unbounded before the cloud's own size check rejects it.
 */
async function readCappedRequestBody(req: http.IncomingMessage, maxBytes: number): Promise<Buffer | null> {
    const chunks: Buffer[] = [];
    let total = 0;
    for await (const chunk of req) {
        const buf = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
        total += buf.length;
        if (total > maxBytes)
            return null;
        chunks.push(buf);
    }
    return Buffer.concat(chunks);
}
/**
 * Agent-side proxy for interactive web STT (`POST /api/asr/cloud`). Interactive
 * capture records a mono PCM16 WAV client-side and POSTs the raw bytes here;
 * this forwards them as a multipart `audio` field to the same upstream cloud STT
 * route (`<cloud-base>/voice/stt`) the server-side transcription model uses, and
 * returns `{ text }`. It mirrors {@link handleCloudTtsPreviewRoute} exactly:
 * same base-URL / api-key resolution, same www/apex candidate fan-out, same
 * fail-loud contract — a missing key is 401 and an unreachable upstream is 502
 * so the capture surface renders a distinguishable error state rather than
 * silently downgrading to the browser recognizer.
 */
export async function handleCloudSttRoute(req: http.IncomingMessage, res: http.ServerResponse): Promise<boolean> {
    const cloudApiKey = _internalResolveCloudApiKey();
    if (!cloudApiKey) {
        sendJsonErrorResponse(res, 401, "Eliza Cloud is not connected. Connect your Eliza Cloud account first.");
        return true;
    }
    const provider = req.headers["x-eliza-stt-provider"];
    if (provider !== undefined && provider !== "cartesia") {
        sendJsonErrorResponse(res, 400, "Invalid speech-to-text provider");
        return true;
    }
    const contentType = req.headers["content-type"];
    const requestMime = typeof contentType === "string" && contentType.trim()
        ? contentType.split(";", 1)[0]?.trim() || "audio/wav"
        : "audio/wav";
    const jsonBody = requestMime.toLowerCase() === "application/json";
    let rawBody: Buffer | null;
    if (jsonBody) {
        let body: Record<string, unknown> | null;
        try {
            body = JSON.parse((await readRawRequestBody(req)).toString("utf8")) as Record<string, unknown> | null;
        }
        catch {
            sendJsonErrorResponse(res, 400, "Invalid JSON request body");
            return true;
        }
        rawBody = typeof body?.audioBase64 === "string" ? Buffer.from(body.audioBase64, "base64") : Buffer.alloc(0);
        if (rawBody.length > ELIZA_CLOUD_STT_MAX_BYTES)
            rawBody = null;
    }
    else {
        rawBody = await readCappedRequestBody(req, ELIZA_CLOUD_STT_MAX_BYTES);
    }
    if (rawBody === null) {
        sendJsonErrorResponse(res, 413, "Audio too large");
        return true;
    }
    if (rawBody.length === 0) {
        sendJsonErrorResponse(res, 400, "Missing audio body");
        return true;
    }
    const mime = jsonBody ? "audio/wav" : requestMime;
    const filename = mime.includes("wav") ? "recording.wav" : "recording.bin";
    const cloudUrls = resolveCloudSttCandidateUrls();
    logger.debug(`[Cloud STT] proxying ${rawBody.length}B ${mime} to ${cloudUrls.length} candidate(s)`);
    const proxyRequestId=crypto.randomUUID();
    const timingSink=(value:import("./cloud-speech-proxy-timing").SpeechProxyObservation)=>logger.info(value,"[Cloud Speech] proxy timing");
    const client = cloudProxyClient(req, res);
    try {
        client.signal.throwIfAborted();
        let lastStatus = 0;
        let lastDetails = "unknown error";
        let cloudResponse: Response | null = null;
        let successfulCandidate=-1;
        for (let i = 0; i < cloudUrls.length; i++) {
            const cloudUrl = cloudUrls[i];
            if (cloudUrl === undefined)
                continue;
            let attempt: Response;
            let warmingRetries = 0;
            for (;;) {
                client.signal.throwIfAborted();
                const form = new FormData();
                form.append("audio", new Blob([new Uint8Array(rawBody)], { type: mime }), filename);
                if (provider === "cartesia") form.append("provider", provider);
                const sttSignal = cloudProxyAbortSignal("ELIZAOS_CLOUD_STT_TIMEOUT_MS", client.signal);
                attempt = await timeSpeechProxyFetch(()=>fetch(cloudUrl, {
                    method: "POST",
                    headers: {
                        Authorization: `Bearer ${cloudApiKey}`,
                        "x-api-key": cloudApiKey,
                    },
                    body: form,
                    ...(sttSignal ? { signal: sttSignal } : {}),
                }),{kind:"stt",proxyRequestId,candidate:i,attempt:warmingRetries+1},timingSink);
                if (attempt.ok || warmingRetries >= 2)
                    break;
                const waitSeconds = await warmingRetryWaitSeconds(attempt,detail=>emitSpeechProxyTiming(timingSink,{kind:"stt",proxyRequestId,candidate:i,attempt:warmingRetries+1,phase:"retry_decision",status:attempt.status,upstreamTraceId:speechUpstreamTraceId(attempt),...detail}));
                if (waitSeconds === null)
                    break;
                warmingRetries++;
                logger.warn(`[Cloud STT] retryable upstream unavailability (503), retry ${warmingRetries}/2 after ${waitSeconds}s`);
                await delay(waitSeconds * 1000, undefined, { signal: client.signal });
            }
            if (attempt.ok) {
                cloudResponse = attempt;
                successfulCandidate=i;
                break;
            }
            lastStatus = attempt.status;
            try {
                lastDetails = await attempt.text();
            }
            catch {
                // error-policy:J6 upstream error bodies are diagnostic-only.
                lastDetails = "unknown error";
            }
            const hasMoreCandidates = i < cloudUrls.length - 1;
            if (!hasMoreCandidates || !shouldRetryCloudTtsUpstream(attempt.status)) {
                break;
            }
        }
        if (!cloudResponse) {
            client.signal.throwIfAborted();
            logger.warn(`[Cloud STT] upstream failed (${lastStatus || 502})`);
            if (lastStatus === 400 ||
                lastStatus === 401 ||
                lastStatus === 402 ||
                lastStatus === 403 ||
                lastStatus === 429) {
                forwardCloudTtsUpstreamError(res, lastStatus, lastDetails);
                return true;
            }
            sendJsonErrorResponse(res, 502, `Eliza Cloud STT failed (${lastStatus || 502}): ${lastDetails}`);
            return true;
        }
        let data: {
            text?: unknown;
            transcript?: unknown;
        } | null;
        const drainStarted=Date.now();
        let drainReturned=false;
        try {
            data = (await cloudResponse.json()) as {
                text?: unknown;
                transcript?: unknown;
            } | null;
            drainReturned=true;
        }
        catch {
            // error-policy:J3 malformed upstream JSON becomes an empty transcript.
            data = null;
        } finally {
            emitSpeechProxyTiming(timingSink,{kind:"stt",proxyRequestId,candidate:successfulCandidate,phase:"body_drain",durationMs:Math.max(0,Date.now()-drainStarted),status:cloudResponse.status,outcome:drainReturned?"returned":"threw",upstreamTraceId:speechUpstreamTraceId(cloudResponse)});
        }
        const text = typeof data?.text === "string"
            ? data.text.trim()
            : typeof data?.transcript === "string"
                ? data.transcript.trim()
                : "";
        client.signal.throwIfAborted();
        forwardCloudSpeechHeaders(cloudResponse, res, "stt");
        logger.debug(`[Cloud STT] transcript ${text.length} chars`);
        sendJsonResponse(res, 200, { text });
        return true;
    }
    catch (err) {
        if (client.signal.aborted) return true;
        // error-policy:J1 route boundary translates upstream/proxy failures.
        sendJsonErrorResponse(res, 502, `Eliza Cloud STT request failed: ${err instanceof Error ? err.message : String(err)}`);
        return true;
    }
    finally { client.dispose(); }
}
