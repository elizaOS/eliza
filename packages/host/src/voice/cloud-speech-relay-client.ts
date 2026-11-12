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
  readConfirmedSpeechRetirement,
  SPEECH_ADMISSION_OUTCOME_HEADER,
  SPEECH_MINT_INTENT_HEADER,
  SPEECH_RECOVERY_HEADER,
  SPEECH_RELAY_ROUTES,
  SPEECH_RETIREMENT_HEADER,
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

export interface CloudSpeechRelayRetirement {
  close(): Promise<void>;
  retryRetirement?(): Promise<void>;
  /** Explicit current-owner reconciliation only; never used for provider dispatch. */
  reconcileRetirement?(credential: string): Promise<void>;
}
export interface CloudSpeechRecoveryJournal {
  pending(): Promise<readonly string[]>;
  record(sessionId: string): Promise<void>;
  clear(sessionId: string): Promise<void>;
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
  /** Stable owner/runtime/environment lineage, independent of key rotation; explicit reconciliation only. */
  assertRetirementLineage?(): void;
  signal?: AbortSignal;
  /** Register cleanup before remote admission; remains usable if acquisition rejects. */
  registerRetirement?(retirement: CloudSpeechRelayRetirement): void;
  recoveryJournal?: CloudSpeechRecoveryJournal;
  /** Host-only successor fence. Consent may prepare a ledger before this resolves;
   * recovery and provider admission must wait for confirmed predecessor retirement. */
  beforeProviderAdmission?(): Promise<void>;
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
    options?: ErrorOptions,
  ) {
    super(message, options);
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
  signal?: AbortSignal,
): Promise<Record<string, unknown>> {
  const reader = response.body?.getReader();
  requireValue(reader);
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  const abort = () => {
    void reader.cancel().catch(() => {});
  };
  signal?.addEventListener("abort", abort, { once: true });
  try {
    signal?.throwIfAborted();
    for (;;) {
      const part = await reader.read();
      signal?.throwIfAborted();
      current();
      if (part.done) break;
      bytes += part.value.length;
      requireValue(bytes <= cap);
      chunks.push(part.value);
    }
  } finally {
    signal?.removeEventListener("abort", abort);
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

const PRE_ADMISSION_CACHE_WARMING_CODES = new Set([
  "auth_cache_warming",
  "rate_limit_cache_warming",
  "inference_dependency_cache_warming",
  "billing_cache_warming",
  "inference_admission_cache_warming",
]);

// This refusal is emitted before authentication admits the operation. Never
// replay a generic 503, network failure, or an already-admitted speech request.
function warmingDelay(
  response: Response,
  body: Record<string, unknown>,
): number | null {
  const error = body.error;
  const nested =
    error && typeof error === "object" && !Array.isArray(error)
      ? (error as Record<string, unknown>)
      : undefined;
  // Only explicit pre-admission cache refusals are replayable. A generic
  // retryable 503 may follow an admitted operation, so it fails promptly.
  const warming =
    body.code === "auth_cache_warming" ||
    (typeof nested?.code === "string" &&
      PRE_ADMISSION_CACHE_WARMING_CODES.has(nested.code));
  if (!warming) return null;
  const value = response.headers.get("retry-after");
  if (value !== null) {
    if (/^\d+$/.test(value)) return Number(value) * 1000;
    if (
      !/^(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun), \d{2} [A-Z][a-z]{2} \d{4} \d{2}:\d{2}:\d{2} GMT$/.test(
        value,
      )
    )
      return null;
    const date = Date.parse(value);
    return Number.isFinite(date) ? Math.max(0, date - Date.now()) : null;
  }
  return 1000;
}
function waitForWarming(ms: number, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const abort = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", abort);
      resolve();
    }, ms);
    signal.addEventListener("abort", abort, { once: true });
  });
}

export async function createCloudSpeechRelayPorts(
  options: CloudSpeechRelayClientOptions,
): Promise<{
  speechPorts: VoiceSessionSpeechPorts;
  close(): Promise<void>;
  /** Explicitly retry only a failed retirement of this captured session. */
  retryRetirement?(): Promise<void>;
  /** Explicit current-owner reconciliation only; never used for provider dispatch. */
  reconcileRetirement?(credential: string): Promise<void>;
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
  if (options.beforeProviderAdmission && !options.recoveryJournal)
    throw new CloudSpeechRelayClientError(
      "configuration",
      "Prepared speech requires a recovery journal",
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
    retirementFailed = false,
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
  let admissionState:
    | "not_started"
    | "pending"
    | "identified"
    | "rejected"
    | "unknown" = "not_started";
  let admissionPending: Promise<void> | undefined;
  let retirementCapabilityAccepted = false;
  let journalWrite: Promise<void> | undefined;
  const journal = options.recoveryJournal;
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
    const mintRequest = path === SPEECH_RELAY_ROUTES.mint;
    const mintIntent =
      mintRequest &&
      body &&
      typeof body === "object" &&
      "consentNonce" in body &&
      typeof body.consentNonce === "string" &&
      UUID.test(body.consentNonce)
        ? body.consentNonce
        : undefined;
    let finishAdmission: (() => void) | undefined;
    // Consent has no provider allocation and may need a cold authorization
    // and storage round trip. Stop still cancels it through startupSignal.
    const requestTimeoutMs = mintRequest ? 10_000 : 30_000;
    const deadline = started + requestTimeoutMs;
    const requestDeadline = AbortSignal.timeout(requestTimeoutMs);
    const startupSignal = AbortSignal.any([signal, requestDeadline]);
    const requestSignal = mintRequest ? requestDeadline : startupSignal;
    const encoded = JSON.stringify(body);
    try {
      let response: Response;
      for (let attempt = 0; ; attempt++) {
        startupSignal.throwIfAborted();
        assertCurrent();
        if (mintRequest) {
          admissionState = "pending";
          admissionPending ??= new Promise<void>((resolve) => {
            finishAdmission = resolve;
          });
        }
        response = await (options.fetch ?? fetch)(new URL(path, origin), {
          method: "POST",
          redirect: "error",
          headers: {
            authorization: `Bearer ${credential}`,
            "content-type": "application/json",
            [SPEECH_RETIREMENT_HEADER]: "1",
            ...(journal ? { [SPEECH_RECOVERY_HEADER]: "1" } : {}),
            ...(mintIntent ? { [SPEECH_MINT_INTENT_HEADER]: mintIntent } : {}),
          },
          body: encoded,
          // Drain a dispatched mint for its cleanup identity if Stop wins.
          signal: requestSignal,
        });
        headersMs = performance.now() - started;
        httpTraceId = undefined;
        try {
          const value = response.headers.get("X-Eliza-Trace-Id");
          if (value !== null && /^[a-f0-9]{32}$/.test(value))
            httpTraceId = value;
        } catch {
          // Optional correlation cannot change the request's result or failure.
        }
        serverTimingMs = speechHttpTimings(response.headers);
        status = response.status;
        if (!mintRequest) assertCurrent();
        if (response.ok) break;

        const preallocationRefusal =
          retirementCapabilityAccepted &&
          mintRequest &&
          mintIntent &&
          (!response.url || new URL(response.url).origin === origin.origin) &&
          response.headers.get(SPEECH_ADMISSION_OUTCOME_HEADER) ===
            `not-created-v1:${mintIntent}`;
        if (preallocationRefusal) admissionState = "rejected";
        let delay: number | null = null;
        if (
          (!mintRequest || preallocationRefusal) &&
          response.status === 503 &&
          response.headers
            .get("content-type")
            ?.toLowerCase()
            .startsWith("application/json")
        ) {
          try {
            delay = warmingDelay(
              response,
              await readJson(response, 16384, assertCurrent, startupSignal),
            );
          } catch {
            startupSignal.throwIfAborted();
            assertCurrent();
          }
        } else {
          await response.body?.cancel();
        }
        if (
          delay === null ||
          attempt >= 2 ||
          !Number.isFinite(delay) ||
          delay >= deadline - performance.now()
        ) {
          throw new CloudSpeechRelayClientError(
            speechHttpFailureCode(response.status),
            "Cloud speech request was not admitted",
          );
        }
        await waitForWarming(delay, startupSignal);
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
      const result = await readJson(
        response,
        16384,
        mintRequest ? () => requestDeadline.throwIfAborted() : assertCurrent,
        requestSignal,
      );
      if (
        mintRequest &&
        !journal &&
        typeof result.sessionId === "string" &&
        UUID.test(result.sessionId)
      ) {
        sessionId = result.sessionId;
        admissionState = "identified";
      }
      assertCurrent();
      returned = true;
      return result;
    } finally {
      if (mintRequest && finishAdmission) {
        if (admissionState === "pending") admissionState = "unknown";
        finishAdmission();
      }
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
  const confirmSessionRetirement = async (
    id: string,
    retirementCredential: string,
    assertLineage?: () => void,
    retirementDeadline = AbortSignal.timeout(10_000),
  ): Promise<void> => {
    assertLineage?.();
    if (
      typeof retirementCredential !== "string" ||
      !retirementCredential.trim() ||
      /[\r\n]/.test(retirementCredential)
    ) {
      throw new CloudSpeechRelayClientError(
        "authorization",
        "A current owner credential is required",
      );
    }
    // The session and origin stay captured. Only explicit reconciliation
    // may use a current same-owner credential, exclusively for this revoke;
    // it never replaces the startup credential or admits more audio.
    retirementDeadline.throwIfAborted();
    const response = await (options.fetch ?? fetch)(
      new URL(SPEECH_RELAY_ROUTES.revoke(id), origin),
      {
        method: "POST",
        redirect: "error",
        headers: {
          authorization: `Bearer ${retirementCredential}`,
          "content-type": "application/json",
          [SPEECH_RETIREMENT_HEADER]: "1",
        },
        body: "{}",
        signal: retirementDeadline,
      },
    );
    try {
      assertLineage?.();
    } catch (error) {
      await response.body?.cancel();
      throw error;
    }
    if (!response.ok) {
      await response.body?.cancel();
      throw new CloudSpeechRelayClientError(
        speechHttpFailureCode(response.status),
        "Cloud speech retirement was not confirmed",
      );
    }
    const result = await readJson(
      response,
      1024,
      () => retirementDeadline.throwIfAborted(),
      retirementDeadline,
    );
    assertLineage?.();
    if (!readConfirmedSpeechRetirement(result, id))
      throw new CloudSpeechRelayClientError(
        "protocol",
        "Cloud speech retirement proof is unconfirmed",
      );
    retirementDeadline.throwIfAborted();
    await journal?.clear(id);
  };
  const confirmRetirement = async (
    retirementCredential: string,
    assertLineage?: () => void,
  ) => {
    assertLineage?.();
    // The prepared ID can fence a delayed mint on the server.
    if (journalWrite) await journalWrite.catch(() => {});
    if (journal && sessionId)
      return confirmSessionRetirement(
        sessionId,
        retirementCredential,
        assertLineage,
      );
    const retirementDeadline = AbortSignal.timeout(10000);
    const pending = admissionPending;
    if (pending && admissionState === "pending") {
      await new Promise<void>((resolve, reject) => {
        const abort = () =>
          reject(
            new CloudSpeechRelayClientError(
              "protocol",
              "Cloud speech admission remains unconfirmed",
            ),
          );
        retirementDeadline.addEventListener("abort", abort, { once: true });
        void pending.then(() => {
          retirementDeadline.removeEventListener("abort", abort);
          resolve();
        });
      });
      assertLineage?.();
    }
    if (!sessionId) {
      if (admissionState === "not_started" || admissionState === "rejected")
        return;
      throw new CloudSpeechRelayClientError(
        "protocol",
        "Cloud speech admission remains unconfirmed",
      );
    }
    return confirmSessionRetirement(
      sessionId,
      retirementCredential,
      assertLineage,
      retirementDeadline,
    );
  };
  let reconciliation: Promise<void> | undefined;
  const close = (): Promise<void> => {
    if (closePromise) return closePromise;
    terminate();
    closePromise = confirmRetirement(credential);
    const attempt = closePromise;
    void attempt.catch(() => {
      // Retry only the same captured session's authenticated retirement.
      // Transport stays closed; this cannot reopen a provider or admit audio.
      if (closePromise === attempt) retirementFailed = true;
    });
    return attempt;
  };
  const aborted = () =>
    terminate(
      new CloudSpeechRelayClientError("closed", "Cloud speech was cancelled"),
    );
  options.signal?.addEventListener("abort", aborted, { once: true });
  const retirement: CloudSpeechRelayRetirement = {
    close,
    retryRetirement() {
      if (retirementFailed) {
        retirementFailed = false;
        closePromise = undefined;
      }
      return close();
    },
    reconcileRetirement(currentCredential) {
      if (reconciliation) return reconciliation;
      const assertLineage = options.assertRetirementLineage;
      if (!assertLineage)
        return Promise.reject(
          new CloudSpeechRelayClientError(
            "configuration",
            "Retirement reconciliation requires owner lineage",
          ),
        );
      const attempt = (async () => {
        assertLineage();
        let alreadyConfirmed = false;
        try {
          await close();
          alreadyConfirmed = true;
        } catch {
          /* Explicit owner reconciliation follows. */
        }
        assertLineage();
        if (alreadyConfirmed) return;
        await confirmRetirement(currentCredential, assertLineage);
        assertLineage();
        retirementFailed = false;
        closePromise = Promise.resolve();
      })();
      reconciliation = attempt;
      void attempt.then(
        () => {
          if (reconciliation === attempt) reconciliation = undefined;
        },
        () => {
          if (reconciliation === attempt) reconciliation = undefined;
        },
      );
      return attempt;
    },
  };
  try {
    options.registerRetirement?.(retirement);
    const recover = async () => {
      if (!journal) return;
      for (const id of await journal.pending()) {
        assertCurrent();
        requireValue(UUID.test(id));
        // The successor ledger is not a previous interrupted admission.
        if (id === sessionId) continue;
        await confirmSessionRetirement(id, credential, assertCurrent);
      }
      assertCurrent();
    };
    if (!options.beforeProviderAdmission) await recover();
    const consent = await request(SPEECH_RELAY_ROUTES.consent, {});
    exact(consent, [
      "consentNonce",
      "expiresAt",
      "retirementProofVersion",
      ...(journal ? ["recoverySessionId"] : []),
    ]);
    requireValue(
      consent.retirementProofVersion === 1 &&
        typeof consent.consentNonce === "string" &&
        UUID.test(consent.consentNonce) &&
        typeof consent.expiresAt === "string" &&
        Date.parse(consent.expiresAt) > Date.now(),
    );
    retirementCapabilityAccepted = true;
    if (journal) {
      const preparedId = consent.recoverySessionId;
      requireValue(typeof preparedId === "string" && UUID.test(preparedId));
      sessionId = preparedId;
      journalWrite = journal.record(preparedId);
      await journalWrite;
      assertCurrent();
    }
    const beforeProviderAdmission = options.beforeProviderAdmission;
    if (beforeProviderAdmission) {
      // Race the host fence with cancellation so an unclaimed successor cannot
      // retain a pending acquisition (or block host shutdown) indefinitely.
      await new Promise<void>((resolve, reject) => {
        const abort = () => reject(lifecycle.signal.reason);
        lifecycle.signal.throwIfAborted();
        lifecycle.signal.addEventListener("abort", abort, { once: true });
        void beforeProviderAdmission()
          .then(resolve, reject)
          .finally(() => {
            lifecycle.signal.removeEventListener("abort", abort);
          });
      });
      assertCurrent();
      await recover();
      requireValue(Date.parse(String(consent.expiresAt)) > Date.now());
    }
    const minted = await request(SPEECH_RELAY_ROUTES.mint, {
      consentNonce: consent.consentNonce,
      ...(journal ? { recoverySessionId: sessionId } : {}),
    });
    exact(minted, [
      "sessionId",
      "token",
      "expiresAt",
      "wsUrl",
      "version",
      "retirementProofVersion",
    ]);
    requireValue(
      typeof minted.sessionId === "string" &&
        UUID.test(minted.sessionId) &&
        (!journal || minted.sessionId === sessionId) &&
        typeof minted.token === "string" &&
        minted.token.length > 0 &&
        minted.token.length <= 6144 &&
        typeof minted.expiresAt === "string" &&
        minted.version === 1 &&
        minted.retirementProofVersion === 1,
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
          // A relay that predates renewal refuses an unknown hello key, so
          // `extend` is sent only when this deployment's mint offered it.
          send({
            t: "hello",
            token: minted.token,
            errorReasons: true,
          });
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
    armExpiry();
  } catch (error) {
    terminate();
    if (sessionId || admissionState !== "not_started") {
      try {
        await close();
      } catch (cleanupError) {
        const cause = new AggregateError(
          [error, cleanupError],
          "Cloud speech startup failed with unconfirmed retirement",
        );
        // Preserve the caller's transport/auth classification without losing
        // the cleanup failure or treating uncertain admission as retired.
        if (error instanceof CloudSpeechRelayClientError) {
          throw new CloudSpeechRelayClientError(error.code, error.message, {
            cause,
          });
        }
        throw cause;
      }
    }
    throw error;
  }
  function armExpiry() {
    if (expiryTimer) clearTimeout(expiryTimer);
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
      // The provider also closes an idle continuation context on its own.
      context.finished = true;
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
  return { speechPorts, ...retirement, sessionId, expiresAt: expiry };
}
