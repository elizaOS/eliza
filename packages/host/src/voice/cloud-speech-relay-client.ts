/** Server-only speech transport. The local VoiceSession still owns turns, history and model execution.
 * Disabled by default; account credentials and the one-use speech token never reach the renderer.
 */

import { createHash } from "node:crypto";
import { logger } from "@elizaos/core";
import type { CartesiaInkRealtimeEvent } from "./cartesia-ink";
import type {
  RealtimeTtsStreamCallbacks,
  VoiceSessionSpeechPorts,
} from "./session";
import { speechHttpTimings } from "./speech-http-timing";
import {
  decodeSpeechRelayAudio,
  SPEECH_RELAY_ROUTES,
  type SpeechRelayServerControl,
} from "./speech-relay-wire";

export interface CloudSpeechRelayTransportDiagnostic {
  event: "cloud_speech_transport";
  /** Per-instance random correlation ID, never a Cloud/local session identifier. */
  diagnosticId: string;
  phase: "bootstrap" | "connecting" | "live" | "retiring";
  cause:
    | "socket_close"
    | "socket_error"
    | "message_rejected"
    | "wire_error"
    | "lifecycle_check_failed"
    | "expired"
    | "send_failed"
    | "uplink_rejected"
    | "startup"
    | "startup_timeout"
    | "minted_session";
  elapsedMs: number;
  liveElapsedMs: number | null;
  stage?:
    | "consent_post"
    | "mint_post"
    | "websocket_connect"
    | "relay_ready"
    | "stt_connected";
  durationMs?: number;
  responseHeadersMs?: number;
  responseBodyMs?: number;
  serverTimingMs?: Record<string, number>;
  httpStatus?: number;
  /** Existing Cloud HTTP correlation header, strictly lowercase32 hexadecimal. */
  httpTraceId?: string;
  outcome?: "returned" | "failed";
  /** SHA256 of the validated minted session, never its raw identifier or token. */
  speechSessionDigest?: string;
  /** Negotiated PCM contract, not a measurement of the physical microphone. */
  pcmSampleRateHz: 16000;
  sentPcmBytes: number;
  sentPcmFrames: number;
  receivedPcmBytes: number;
  receivedPcmFrames: number;
  closeCode?: number;
  wasClean?: boolean;
  clientCode?: CloudSpeechRelayClientError["code"];
  wireCode?: Extract<SpeechRelayServerControl, { t: "error" }>["code"];
}

export interface CloudSpeechRelayClientOptions {
  enabled?: boolean;
  /** Exact reviewed API origin, without a path/query. Never taken from a renderer request. */
  origin: string;
  /** Tests can use an actual two-ended loopback socket; never admits a non-loopback HTTP origin. */
  allowInsecureLoopback?: boolean;
  credential(): Promise<string>;
  /** Pin owner/credential revision and local agent generation for this whole session. */
  assertCurrent(): void;
  signal?: AbortSignal;
  fetch?: typeof fetch;
  websocket?: (url: string) => WebSocket;
  /** Safe structured diagnostics only; logger failure cannot alter transport lifecycle. */
  logger?: Pick<typeof logger, "warn">;
}
export class CloudSpeechRelayClientError extends Error {
  constructor(
    readonly code:
      | "disabled"
      | "configuration"
      | "insufficient_credits"
      | "authorization"
      | "protocol"
      | "closed"
      | "expired"
      | "transport",
    message: string,
  ) {
    super(message);
    this.name = "CloudSpeechRelayClientError";
  }
}
function speechHttpFailureCode(
  status: number,
): CloudSpeechRelayClientError["code"] {
  if (status === 401 || status === 403) return "authorization";
  if (status === 410) return "expired";
  if (status === 429 || status >= 500) return "transport";
  return "protocol";
}
const UUID =
  /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const encoder = new TextEncoder();
function requireValue(value: unknown): asserts value {
  if (!value)
    throw new CloudSpeechRelayClientError(
      "protocol",
      "Invalid speech relay response",
    );
}
function record(value: unknown): Record<string, unknown> {
  requireValue(value && typeof value === "object" && !Array.isArray(value));
  return value as Record<string, unknown>;
}
function exact(value: Record<string, unknown>, keys: string[]) {
  requireValue(
    Object.keys(value).length === keys.length &&
      keys.every((key) => Object.hasOwn(value, key)),
  );
}

async function readJson(
  response: Response,
  cap: number,
  current: () => void,
): Promise<Record<string, unknown>> {
  const reader = response.body?.getReader();
  requireValue(reader);
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    for (;;) {
      const part = await reader.read();
      current();
      if (part.done) break;
      bytes += part.value.length;
      requireValue(bytes <= cap);
      chunks.push(part.value);
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  const data = new Uint8Array(bytes);
  let offset = 0;
  for (const chunk of chunks) {
    data.set(chunk, offset);
    offset += chunk.length;
  }
  return record(
    JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(data)),
  );
}

export async function createCloudSpeechRelayPorts(
  options: CloudSpeechRelayClientOptions,
): Promise<{
  speechPorts: VoiceSessionSpeechPorts;
  close(): Promise<void>;
  sessionId: string;
  expiresAt: number;
}> {
  if (options.enabled !== true)
    throw new CloudSpeechRelayClientError(
      "disabled",
      "Cloud speech relay is disabled",
    );
  if (typeof window !== "undefined")
    throw new CloudSpeechRelayClientError(
      "configuration",
      "Cloud speech transport must run on the host",
    );
  const origin = new URL(options.origin);
  if (
    origin.username ||
    origin.password ||
    origin.pathname !== "/" ||
    origin.search ||
    origin.hash ||
    origin.origin !== options.origin.replace(/\/$/, "")
  )
    throw new CloudSpeechRelayClientError(
      "configuration",
      "An exact Cloud API origin is required",
    );
  const loopback =
    options.allowInsecureLoopback === true &&
    origin.protocol === "http:" &&
    ["127.0.0.1", "[::1]"].includes(origin.hostname);
  if (origin.protocol !== "https:" && !loopback)
    throw new CloudSpeechRelayClientError(
      "configuration",
      "Cloud speech requires HTTPS",
    );
  const lifecycle = new AbortController();
  let relayReady = false;
  let closed = false,
    closePromise: Promise<void> | undefined,
    socket: WebSocket | undefined,
    expiryTimer: ReturnType<typeof setTimeout> | undefined,
    sessionId: string | undefined,
    expiry = 0;
  let stt: ((event: CartesiaInkRealtimeEvent) => void) | undefined;
  const pendingStt: CartesiaInkRealtimeEvent[] = [];
  const contexts = new Map<
      string,
      {
        callbacks: RealtimeTtsStreamCallbacks;
        resolve(): void;
        reject(error: Error): void;
        resolvePrepared(): void;
        rejectPrepared(error: Error): void;
        prepared: boolean;
        cancelled: boolean;
        finished: boolean;
        firstAudio: boolean;
        frames: number;
        started: number;
      }
    >(),
    retired = new Set<string>();
  let contextsCreated = 0,
    ttsCharacters = 0;
  let outputBytes = 0,
    uplinkBytes = 0;
  let sentPcmBytes = 0,
    sentPcmFrames = 0,
    receivedPcmFrames = 0;
  const diagnosticStarted = performance.now();
  let transportPhase: CloudSpeechRelayTransportDiagnostic["phase"] =
    "bootstrap";
  const diagnosticId = crypto.randomUUID();
  let liveStarted: number | undefined;
  let socketStarted: number | undefined;
  let diagnosticsEmitted = 0;
  const startupStages = new Set<CloudSpeechRelayTransportDiagnostic["stage"]>();
  const diagnose = (
    cause: CloudSpeechRelayTransportDiagnostic["cause"],
    details: Pick<
      CloudSpeechRelayTransportDiagnostic,
      | "closeCode"
      | "wasClean"
      | "clientCode"
      | "wireCode"
      | "stage"
      | "durationMs"
      | "httpStatus"
      | "httpTraceId"
      | "outcome"
      | "speechSessionDigest"
      | "responseHeadersMs"
      | "responseBodyMs"
      | "serverTimingMs"
    > = {},
  ) => {
    // One failure plus its close confirmation normally emits two records. Bound
    // repeated socket events; raw bodies, session IDs, tokens and credentials are never included.
    if (cause === "startup") {
      if (!details.stage || startupStages.has(details.stage)) return;
      startupStages.add(details.stage);
    } else {
      if (diagnosticsEmitted >= 4) return;
      diagnosticsEmitted++;
    }
    try {
      const event: CloudSpeechRelayTransportDiagnostic = {
        event: "cloud_speech_transport",
        diagnosticId,
        phase: transportPhase,
        cause,
        elapsedMs: Math.max(
          0,
          Math.round(performance.now() - diagnosticStarted),
        ),
        liveElapsedMs:
          liveStarted === undefined
            ? null
            : Math.max(0, Math.round(performance.now() - liveStarted)),
        ...(details.stage ? { stage: details.stage } : {}),
        ...(typeof details.speechSessionDigest === "string" &&
        /^[a-f0-9]{64}$/.test(details.speechSessionDigest)
          ? { speechSessionDigest: details.speechSessionDigest }
          : {}),
        ...(typeof details.durationMs === "number" &&
        Number.isFinite(details.durationMs) &&
        details.durationMs >= 0
          ? { durationMs: Math.round(details.durationMs) }
          : {}),
        ...(typeof details.httpStatus === "number" &&
        Number.isInteger(details.httpStatus) &&
        details.httpStatus >= 100 &&
        details.httpStatus <= 599
          ? { httpStatus: details.httpStatus }
          : {}),
        ...(typeof details.httpTraceId === "string" &&
        /^[a-f0-9]{32}$/.test(details.httpTraceId)
          ? { httpTraceId: details.httpTraceId }
          : {}),
        ...(typeof details.responseHeadersMs === "number" &&
        Number.isFinite(details.responseHeadersMs) &&
        details.responseHeadersMs >= 0
          ? { responseHeadersMs: Math.round(details.responseHeadersMs) }
          : {}),
        ...(typeof details.responseBodyMs === "number" &&
        Number.isFinite(details.responseBodyMs) &&
        details.responseBodyMs >= 0
          ? { responseBodyMs: Math.round(details.responseBodyMs) }
          : {}),
        ...(details.serverTimingMs && Object.keys(details.serverTimingMs).length
          ? { serverTimingMs: details.serverTimingMs }
          : {}),
        ...(details.outcome ? { outcome: details.outcome } : {}),
        pcmSampleRateHz: 16000,
        sentPcmBytes,
        sentPcmFrames,
        receivedPcmBytes: outputBytes,
        receivedPcmFrames,
        ...(typeof details.closeCode === "number" &&
        Number.isInteger(details.closeCode) &&
        details.closeCode >= 1000 &&
        details.closeCode <= 4999
          ? { closeCode: details.closeCode }
          : {}),
        ...(typeof details.wasClean === "boolean"
          ? { wasClean: details.wasClean }
          : {}),
        ...(details.clientCode &&
        [
          "disabled",
          "configuration",
          "authorization",
          "protocol",
          "closed",
          "expired",
          "transport",
        ].includes(details.clientCode)
          ? { clientCode: details.clientCode }
          : {}),
        ...(details.wireCode ? { wireCode: details.wireCode } : {}),
      };
      (options.logger ?? logger).warn(
        { ...event },
        "[Cloud Speech] transport diagnostic",
      );
    } catch {
      // Telemetry is observational; ownership and teardown retain their behavior.
    }
  };
  const assertCurrent = () => {
    try {
      lifecycle.signal.throwIfAborted();
      options.signal?.throwIfAborted();
      options.assertCurrent();
      if (closed)
        throw new CloudSpeechRelayClientError(
          "closed",
          "Cloud speech session is closed",
        );
    } catch (error) {
      diagnose(
        "lifecycle_check_failed",
        error instanceof CloudSpeechRelayClientError
          ? { clientCode: error.code }
          : {},
      );
      if (socket)
        terminate(
          new CloudSpeechRelayClientError(
            "authorization",
            "Cloud speech owner changed",
          ),
        );
      throw error;
    }
  };
  const credential = await options.credential();
  assertCurrent();
  if (
    typeof credential !== "string" ||
    !credential.trim() ||
    /[\r\n]/.test(credential)
  )
    throw new CloudSpeechRelayClientError(
      "authorization",
      "Cloud account credential is unavailable",
    );
  const request = async (
    path: string,
    body: unknown,
    signal: AbortSignal = lifecycle.signal,
  ) => {
    const started = performance.now();
    let status: number | undefined;
    let headersMs: number | undefined;
    let httpTraceId: string | undefined;
    let bodyStarted: number | undefined;
    let serverTimingMs: Record<string, number> | undefined;
    let returned = false;
    try {
      assertCurrent();
      const response = await (options.fetch ?? fetch)(new URL(path, origin), {
        method: "POST",
        redirect: "error",
        headers: {
          authorization: `Bearer ${credential}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(body),
        signal: AbortSignal.any([signal, AbortSignal.timeout(10000)]),
      });
      headersMs = performance.now() - started;
      try {
        const value = response.headers.get("X-Eliza-Trace-Id");
        if (value !== null && /^[a-f0-9]{32}$/.test(value)) httpTraceId = value;
      } catch {
        // Optional correlation cannot change the request's result or failure.
      }
      serverTimingMs = speechHttpTimings(response.headers);
      status = response.status;
      assertCurrent();
      if (!response.ok) {
        await response.body?.cancel();
        throw new CloudSpeechRelayClientError(
          speechHttpFailureCode(response.status),
          "Cloud speech request was not admitted",
        );
      }
      if (
        !response.headers
          .get("content-type")
          ?.toLowerCase()
          .startsWith("application/json")
      ) {
        await response.body?.cancel();
        throw new CloudSpeechRelayClientError(
          "protocol",
          "Cloud speech response is not JSON",
        );
      }
      bodyStarted = performance.now();
      const result = await readJson(response, 16384, assertCurrent);
      returned = true;
      return result;
    } finally {
      diagnose("startup", {
        stage:
          path === SPEECH_RELAY_ROUTES.consent ? "consent_post" : "mint_post",
        durationMs: performance.now() - started,
        ...(headersMs === undefined ? {} : { responseHeadersMs: headersMs }),
        ...(bodyStarted === undefined
          ? {}
          : { responseBodyMs: performance.now() - bodyStarted }),
        ...(serverTimingMs === undefined ? {} : { serverTimingMs }),
        ...(status === undefined ? {} : { httpStatus: status }),
        ...(httpTraceId === undefined ? {} : { httpTraceId }),
        outcome: returned ? "returned" : "failed",
      });
    }
  };
  const send = (value: unknown) => {
    assertCurrent();
    requireValue(socket?.readyState === 1);
    const json = JSON.stringify(value);
    requireValue(encoder.encode(json).byteLength <= 8192);
    try {
      socket.send(json);
    } catch {
      diagnose("send_failed", { clientCode: "transport" });
      terminate(
        new CloudSpeechRelayClientError(
          "transport",
          "Cloud speech send failed",
        ),
      );
      throw new CloudSpeechRelayClientError(
        "transport",
        "Cloud speech send failed",
      );
    }
  };
  const terminate = (error?: Error) => {
    if (closed) return;
    closed = true;
    transportPhase = "retiring";
    if (expiryTimer) clearTimeout(expiryTimer);
    options.signal?.removeEventListener("abort", aborted);
    lifecycle.abort();
    for (const context of contexts.values()) {
      context.cancelled = true;
      context.rejectPrepared(
        error ??
          new CloudSpeechRelayClientError(
            "closed",
            "Speech preparation was cancelled",
          ),
      );
      if (error) context.reject(error);
      else context.resolve();
    }
    contexts.clear();
    pendingStt.length = 0;
    if (error) {
      try {
        stt?.({
          type: "error",
          code: "speech_relay_unavailable",
          message: "Cloud speech transport ended",
        });
      } catch {
        /* Cleanup must finish even if the owner notification throws. */
      }
    }
    if (relayReady && socket?.readyState === 1) {
      try {
        socket.send(JSON.stringify({ t: "stop" }));
      } catch {
        /* The socket is already being retired. */
      }
    }
    socket?.close(1000, "speech-closed");
  };
  const close = (): Promise<void> => {
    if (closePromise) return closePromise;
    terminate();
    closePromise = (async () => {
      if (!sessionId) return;
      // Retirement can only revoke this already-minted session at its captured
      // origin with its captured credential. It must survive local ticket expiry,
      // owner replacement and normal socket teardown; none may admit more audio.
      const retirementDeadline = AbortSignal.timeout(10000);
      const response = await (options.fetch ?? fetch)(
        new URL(SPEECH_RELAY_ROUTES.revoke(sessionId), origin),
        {
          method: "POST",
          redirect: "error",
          headers: {
            authorization: `Bearer ${credential}`,
            "content-type": "application/json",
          },
          body: "{}",
          signal: retirementDeadline,
        },
      );
      if (!response.ok) {
        await response.body?.cancel();
        throw new CloudSpeechRelayClientError(
          speechHttpFailureCode(response.status),
          "Cloud speech retirement was not confirmed",
        );
      }
      const result = await readJson(response, 1024, () =>
        retirementDeadline.throwIfAborted(),
      );
      exact(result, ["revoked"]);
      requireValue(result.revoked === true);
      retirementDeadline.throwIfAborted();
    })();
    return closePromise;
  };
  const aborted = () =>
    terminate(
      new CloudSpeechRelayClientError("closed", "Cloud speech was cancelled"),
    );
  options.signal?.addEventListener("abort", aborted, { once: true });
  try {
    const consent = await request(SPEECH_RELAY_ROUTES.consent, {});
    exact(consent, ["consentNonce", "expiresAt"]);
    requireValue(
      typeof consent.consentNonce === "string" &&
        UUID.test(consent.consentNonce) &&
        typeof consent.expiresAt === "string" &&
        Date.parse(consent.expiresAt) > Date.now(),
    );
    const minted = await request(SPEECH_RELAY_ROUTES.mint, {
      consentNonce: consent.consentNonce,
    });
    exact(minted, ["sessionId", "token", "expiresAt", "wsUrl", "version"]);
    requireValue(
      typeof minted.sessionId === "string" &&
        UUID.test(minted.sessionId) &&
        typeof minted.token === "string" &&
        minted.token.length > 0 &&
        minted.token.length <= 6144 &&
        typeof minted.expiresAt === "string" &&
        minted.version === 1,
    );
    sessionId = minted.sessionId;
    expiry = Date.parse(minted.expiresAt);
    requireValue(
      Number.isFinite(expiry) &&
        expiry > Date.now() &&
        expiry <= Date.now() + 65000,
    );
    requireValue(typeof minted.wsUrl === "string");
    const wsUrl = new URL(minted.wsUrl),
      expected = new URL(SPEECH_RELAY_ROUTES.ws, origin);
    expected.protocol = loopback ? "ws:" : "wss:";
    expected.search = `?sessionId=${sessionId}`;
    requireValue(wsUrl.href === expected.href);
    assertCurrent();
    diagnose("minted_session", {
      speechSessionDigest: createHash("sha256")
        .update(JSON.stringify({ cloudSessionId: sessionId }))
        .digest("hex"),
    });
    transportPhase = "connecting";
    socketStarted = performance.now();
    const connectedSocket = (
      options.websocket ?? ((url) => new WebSocket(url))
    )(wsUrl.href);
    socket = connectedSocket;
    connectedSocket.binaryType = "arraybuffer";
    await new Promise<void>((resolve, reject) => {
      let ready = false;
      let failed = false;
      let startupStage: "websocket_connect" | "relay_ready" =
        "websocket_connect";
      let phaseStarted = performance.now();
      let timer: ReturnType<typeof setTimeout>;
      // Each startup phase has its own finite five-second budget. Upgrade time
      // must not consume the hello-to-ready budget before hello can be sent.
      const armDeadline = () => {
        timer = setTimeout(() => {
          diagnose("startup_timeout", {
            stage: startupStage,
            durationMs: performance.now() - phaseStarted,
            outcome: "failed",
            clientCode: "transport",
          });
          fail(
            new CloudSpeechRelayClientError(
              "transport",
              "Cloud speech did not become ready",
            ),
          );
        }, 5000);
      };
      const fail = (error: Error) => {
        if (failed) return;
        failed = true;
        clearTimeout(timer);
        lifecycle.signal.removeEventListener("abort", onAbort);
        reject(error);
        terminate(error);
      };
      const onAbort = () =>
        fail(
          new CloudSpeechRelayClientError(
            "closed",
            "Cloud speech was cancelled",
          ),
        );
      lifecycle.signal.addEventListener("abort", onAbort, { once: true });
      armDeadline();
      connectedSocket.onopen = () => {
        if (failed || closed) {
          connectedSocket.close(1000, "speech-closed");
          return;
        }
        if (startupStage !== "websocket_connect") return;
        clearTimeout(timer);
        startupStage = "relay_ready";
        phaseStarted = performance.now();
        armDeadline();
        diagnose("startup", {
          stage: "websocket_connect",
          durationMs:
            socketStarted === undefined
              ? undefined
              : performance.now() - socketStarted,
          outcome: "returned",
        });
        try {
          requireValue(connectedSocket.url === expected.href);
          send({ t: "hello", token: minted.token, errorReasons: true });
        } catch {
          fail(
            new CloudSpeechRelayClientError(
              "authorization",
              "Cloud speech hello failed",
            ),
          );
        }
      };
      connectedSocket.onerror = () => {
        diagnose("socket_error", { clientCode: "transport" });
        fail(
          new CloudSpeechRelayClientError(
            "transport",
            "Cloud speech socket failed",
          ),
        );
      };
      connectedSocket.onclose = (event) => {
        diagnose("socket_close", {
          closeCode: event.code,
          wasClean: event.wasClean,
          clientCode: "closed",
        });
        fail(
          new CloudSpeechRelayClientError(
            "closed",
            "Cloud speech socket closed",
          ),
        );
      };
      connectedSocket.onmessage = (event) => {
        try {
          assertCurrent();
          if (event.data instanceof ArrayBuffer) {
            requireValue(ready);
            const { id, pcm } = decodeSpeechRelayAudio(
              new Uint8Array(event.data),
            );
            outputBytes += pcm.length;
            receivedPcmFrames++;
            requireValue(outputBytes <= 8 * 1024 * 1024);
            const context = contexts.get(id);
            if (!context) {
              requireValue(retired.has(id));
              return;
            }
            if (!context.cancelled) {
              if (!context.firstAudio) {
                context.firstAudio = true;
                context.callbacks.onFirstAudio?.({
                  elapsedMs: performance.now() - context.started,
                });
              }
              context.frames++;
              context.callbacks.onAudioFrame?.({ bytes: pcm });
            }
            return;
          }
          requireValue(
            typeof event.data === "string" &&
              encoder.encode(event.data).byteLength <= 8192,
          );
          const frame = record(JSON.parse(event.data));
          if (frame.t === "ready") {
            exact(frame, [
              "t",
              "version",
              "sampleRate",
              "channels",
              "expiresAt",
            ]);
            requireValue(
              !ready &&
                frame.version === 1 &&
                frame.sampleRate === 16000 &&
                frame.channels === 1 &&
                frame.expiresAt === minted.expiresAt,
            );
            ready = true;
            relayReady = true;
            liveStarted = performance.now();
            transportPhase = "live";
            diagnose("startup", {
              stage: "relay_ready",
              durationMs: performance.now() - phaseStarted,
              outcome: "returned",
            });
            clearTimeout(timer);
            lifecycle.signal.removeEventListener("abort", onAbort);
            resolve();
            return;
          }
          // A relay may refuse admission before ready. Validate its public
          // error code without admitting any STT/TTS control or audio frames.
          if (frame.t === "error")
            handleControl(frame as SpeechRelayServerControl);
          requireValue(ready);
          handleControl(frame as SpeechRelayServerControl);
        } catch (error) {
          diagnose("message_rejected", {
            clientCode:
              error instanceof CloudSpeechRelayClientError
                ? error.code
                : "protocol",
          });
          fail(
            error instanceof CloudSpeechRelayClientError &&
              error.code === "insufficient_credits"
              ? error
              : new CloudSpeechRelayClientError(
                  "protocol",
                  "Invalid Cloud speech frame",
                ),
          );
        }
      };
    });
    assertCurrent();
    expiryTimer = setTimeout(
      () => {
        diagnose("expired", { clientCode: "expired" });
        terminate(
          new CloudSpeechRelayClientError(
            "expired",
            "Cloud speech session expired",
          ),
        );
      },
      Math.max(1, expiry - Date.now()),
    );
  } catch (error) {
    terminate();
    if (sessionId) await close().catch(() => {});
    throw error;
  }
  function handleControl(input: SpeechRelayServerControl) {
    const frame = record(input);
    if (frame.t === "error") {
      exact(
        frame,
        Object.hasOwn(frame, "reason")
          ? ["t", "code", "reason"]
          : ["t", "code"],
      );
      requireValue(
        frame.reason === undefined ||
          (frame.code === "unavailable" &&
            frame.reason === "insufficient_credits"),
      );
      const wireCode = frame.code;
      requireValue(
        wireCode === "unauthorized" ||
          wireCode === "protocol" ||
          wireCode === "unavailable" ||
          wireCode === "closed",
      );
      diagnose("wire_error", { wireCode });
      throw new CloudSpeechRelayClientError(
        frame.reason === "insufficient_credits"
          ? "insufficient_credits"
          : "transport",
        frame.reason === "insufficient_credits"
          ? "Voice needs more Eliza Cloud credits. Add credits, then try again."
          : "Cloud speech ended",
      );
    }
    if (frame.t === "stt") {
      exact(frame, ["t", "event"]);
      const event = record(frame.event);
      const type = event.type;
      requireValue(
        [
          "connected",
          "start-of-turn",
          "transcript-update",
          "eager-end-of-turn",
          "turn-resumed",
          "end-of-turn",
        ].includes(String(type)) &&
          Object.keys(event).every((key) =>
            ["type", "transcript", "requestId"].includes(key),
          ),
      );
      requireValue(
        type === "connected"
          ? event.transcript === undefined
          : typeof event.transcript === "string" &&
              event.transcript.length <= 16384,
      );
      requireValue(
        event.requestId === undefined ||
          (typeof event.requestId === "string" &&
            event.requestId.length <= 256),
      );
      if (type === "connected")
        diagnose("startup", {
          stage: "stt_connected",
          durationMs:
            socketStarted === undefined
              ? undefined
              : performance.now() - socketStarted,
          outcome: "returned",
        });
      const canonical = {
        type,
        raw: {},
        ...(type === "connected" ? {} : { transcript: event.transcript ?? "" }),
        ...(event.requestId === undefined
          ? {}
          : { requestId: event.requestId }),
      } as CartesiaInkRealtimeEvent;
      if (stt) stt(canonical);
      else {
        requireValue(pendingStt.length < 64);
        pendingStt.push(canonical);
      }
      return;
    }
    requireValue(
      typeof frame.id === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(frame.id),
    );
    const context = contexts.get(frame.id);
    if (frame.t === "tts_prepared") {
      exact(frame, ["t", "id"]);
      if (!context) {
        requireValue(retired.has(frame.id));
        return;
      }
      requireValue(!context.prepared);
      context.prepared = true;
      if (!context.cancelled) context.resolvePrepared();
      return;
    }
    if (frame.t === "complete") {
      exact(frame, ["t", "id"]);
      if (!context) {
        requireValue(retired.has(frame.id));
        return;
      }
      requireValue(context.finished);
      contexts.delete(frame.id);
      retired.add(frame.id);
      if (!context.cancelled)
        context.callbacks.onComplete?.({ frameCount: context.frames });
      context.resolve();
      return;
    }
    if (frame.t === "flush_complete") {
      requireValue(
        Object.keys(frame).every((key) =>
          ["t", "id", "flushId"].includes(key),
        ) &&
          (frame.flushId === undefined ||
            (typeof frame.flushId === "number" &&
              Number.isSafeInteger(frame.flushId) &&
              frame.flushId >= 0)),
      );
      if (!context) {
        requireValue(retired.has(frame.id));
        return;
      }
      if (!context.cancelled)
        context.callbacks.onFlushComplete?.(
          frame.flushId === undefined ? {} : { flushId: frame.flushId },
        );
      return;
    }
    throw new CloudSpeechRelayClientError(
      "protocol",
      "Unknown Cloud speech control",
    );
  }
  const speechPorts: VoiceSessionSpeechPorts = {
    openStt(onEvent) {
      assertCurrent();
      requireValue(!stt);
      stt = onEvent;
      queueMicrotask(() => {
        if (!closed) for (const event of pendingStt.splice(0)) onEvent(event);
      });
      return {
        sendAudioChunk(chunk) {
          try {
            assertCurrent();
            const bytes = ArrayBuffer.isView(chunk)
              ? new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength)
              : new Uint8Array(chunk);
            requireValue(
              bytes.byteLength > 0 &&
                bytes.byteLength <= 3200 &&
                bytes.byteLength % 2 === 0,
            );
            uplinkBytes += bytes.byteLength;
            requireValue(uplinkBytes <= (60000 / 1000) * 32000);
            const currentSocket = socket;
            requireValue(currentSocket && currentSocket.readyState === 1);
            currentSocket.send(new Uint8Array(bytes));
            sentPcmBytes += bytes.byteLength;
            sentPcmFrames++;
          } catch (error) {
            diagnose(
              "uplink_rejected",
              error instanceof CloudSpeechRelayClientError
                ? { clientCode: error.code }
                : {},
            );
            throw error;
          }
        },
        close() {
          terminate();
        },
        cancel() {
          terminate();
        },
      };
    },
    tts: {
      createStream(_options, callbacks) {
        assertCurrent();
        requireValue(++contextsCreated <= 64);
        const id = crypto.randomUUID();
        let resolve!: () => void, reject!: (error: Error) => void;
        const closedPromise = new Promise<void>((yes, no) => {
          resolve = yes;
          reject = no;
        });
        void closedPromise.catch(() => {});
        let resolvePrepared!: () => void,
          rejectPrepared!: (error: Error) => void;
        const preparedPromise = new Promise<void>((resolve, reject) => {
          resolvePrepared = resolve;
          rejectPrepared = reject;
        });
        void preparedPromise.catch(() => {});
        const context = {
          resolvePrepared,
          rejectPrepared,
          prepared: false,
          callbacks,
          resolve,
          reject,
          cancelled: false,
          finished: false,
          firstAudio: false,
          frames: 0,
          started: performance.now(),
        };
        contexts.set(id, context);
        send({ t: "prepare", id });
        return {
          opened: preparedPromise,
          closed: closedPromise,
          sendPhrase(phrase) {
            assertCurrent();
            if (context.cancelled || context.finished)
              throw new CloudSpeechRelayClientError(
                "closed",
                "Speech context is closed",
              );
            requireValue(
              typeof phrase.text === "string" &&
                phrase.text.length <= 1024 &&
                ttsCharacters + phrase.text.length <= 4096 &&
                typeof phrase.continueContext === "boolean" &&
                (phrase.flush === undefined ||
                  typeof phrase.flush === "boolean"),
            );
            if (phrase.text) {
              ttsCharacters += phrase.text.length;
              send({
                t: "tts",
                id,
                text: phrase.text,
                ...(phrase.flush ? { flush: true } : {}),
              });
            }
            if (!phrase.continueContext) {
              context.finished = true;
              send({ t: "finish", id });
            }
          },
          cancel() {
            if (context.cancelled || !contexts.has(id)) return;
            context.cancelled = true;
            context.rejectPrepared(
              new CloudSpeechRelayClientError(
                "closed",
                "Speech preparation was cancelled",
              ),
            );
            contexts.delete(id);
            retired.add(id);
            try {
              if (!closed) send({ t: "cancel", id });
            } finally {
              resolve();
            }
          },
        };
      },
      close() {
        terminate();
      },
    },
  };
  requireValue(sessionId);
  return { speechPorts, close, sessionId, expiresAt: expiry };
}
