/**
 * Adapts the cloud voice session's canonical Eliza SSE request to a loopback
 * self-hosted runtime conversation stream. The voice orchestrator and SSE
 * decoder remain unchanged; this boundary only rewrites the route shape and
 * removes cloud-only credentials. It also maps conversation ids to runtime room
 * ids so a voice-fetch abort reaches the runtime's authoritative turn-control
 * route before another turn can enter that room's queue.
 */

import {
  hasCommittedRealtimeVoiceIngress,
  REALTIME_VOICE_CLIENT_TRANSPORT,
} from "@elizaos/shared";
import {
  VOICE_STREAM_PROTOCOL,
  VOICE_TRACE_HEADER,
  voiceClientMessageIdForTrace,
} from "@/lib/voice-session/eliza-sse-bridge";

const CLOUD_CONVERSATION_STREAM_PATH =
  /^\/api\/v1\/eliza\/agents\/[^/]+\/api\/conversations\/([^/]+)\/messages\/stream$/;
const VOICE_ABORT_REASON = "voice-session-interrupt";
// The core exact-abort route waits at most 750ms for request settlement. Leave
// enough outer transport margin for loopback scheduling and JSON delivery.
const DEFAULT_RUNTIME_ABORT_TIMEOUT_MS = 2_000;
const DEFAULT_RUNTIME_ABORT_RETRY_DELAY_MS = 20;
const DEFAULT_RUNTIME_INGRESS_TIMEOUT_MS = 5_000;

export interface LocalRuntimeConversationFetchOptions {
  /** One hard deadline covers every pre-registration retry and response read. */
  abortTimeoutMs?: number;
  /** Delay between `aborted:false` status probes. */
  abortRetryDelayMs?: number;
  /** Deadline for one immutable transcript-delivery attempt. */
  ingressTimeoutMs?: number;
}

export class LocalRuntimeConversationFetchError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "LocalRuntimeConversationFetchError";
  }
}

/**
 * The loopback route returned an authoritative non-success response before it
 * acknowledged durable voice ingress. Unlike a transport loss or deadline,
 * this is known fate: retaining an exact-ingress barrier would retry a request
 * the server already rejected and permanently block later turns.
 */
class KnownUncommittedIngressResponseError extends LocalRuntimeConversationFetchError {}

export function createLocalRuntimeConversationFetch(
  localRuntimeOrigin: string,
  fetchImpl: typeof fetch = fetch,
  options: LocalRuntimeConversationFetchOptions = {},
): typeof fetch {
  const origin = resolveLoopbackOrigin(localRuntimeOrigin);
  const abortTimeoutMs = resolvePositiveIntegerOption(
    options.abortTimeoutMs,
    DEFAULT_RUNTIME_ABORT_TIMEOUT_MS,
    "abortTimeoutMs",
  );
  const abortRetryDelayMs = resolvePositiveIntegerOption(
    options.abortRetryDelayMs,
    DEFAULT_RUNTIME_ABORT_RETRY_DELAY_MS,
    "abortRetryDelayMs",
  );
  const ingressTimeoutMs = resolvePositiveIntegerOption(
    options.ingressTimeoutMs,
    DEFAULT_RUNTIME_INGRESS_TIMEOUT_MS,
    "ingressTimeoutMs",
  );
  const roomIdByConversationId = new Map<string, string>();
  const pendingAbortByRequest = new Map<
    string,
    { roomId: string; clientMessageId: string; task: Promise<void> }
  >();
  const pendingIngressByConversation = new Map<
    string,
    {
      conversationId: string;
      clientMessageId: string;
      task: Promise<void>;
    }
  >();

  const abortRequestKey = (roomId: string, clientMessageId: string): string =>
    JSON.stringify([roomId, clientMessageId]);
  const ingressRequestKey = (
    conversationId: string,
    clientMessageId: string,
  ): string => JSON.stringify([conversationId, clientMessageId]);

  const resolveConversationRoomId = async (
    conversationId: string,
    signal: AbortSignal,
  ): Promise<string> => {
    const cached = roomIdByConversationId.get(conversationId);
    if (cached) return cached;

    const target = new URL("/api/conversations", origin);
    const response = await fetchImpl(target, {
      method: "GET",
      headers: { Accept: "application/json" },
      signal,
    });
    if (!response.ok) {
      throw new LocalRuntimeConversationFetchError(
        `local conversation metadata returned HTTP ${response.status}`,
      );
    }

    const conversations = await parseConversationList(response);
    for (const conversation of conversations) {
      roomIdByConversationId.set(conversation.id, conversation.roomId);
    }
    const roomId = roomIdByConversationId.get(conversationId);
    if (!roomId) {
      throw new LocalRuntimeConversationFetchError(
        "local voice conversation has no runtime room mapping",
      );
    }
    return roomId;
  };

  const dispatchRuntimeAbort = async (
    roomId: string,
    clientMessageId: string,
  ): Promise<void> => {
    const target = new URL(
      `/api/turns/${encodeURIComponent(roomId)}/abort`,
      origin,
    );
    const controller = new AbortController();
    const timeoutError = new LocalRuntimeConversationFetchError(
      `local runtime turn abort did not settle within ${abortTimeoutMs}ms`,
    );
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_resolve, reject) => {
      timeout = setTimeout(() => {
        controller.abort(timeoutError);
        reject(timeoutError);
      }, abortTimeoutMs);
    });
    const probeUntilSettled = (async () => {
      while (true) {
        if (controller.signal.aborted) throw timeoutError;
        let response: Response;
        try {
          response = await fetchImpl(target, {
            method: "POST",
            headers: {
              Accept: "application/json",
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              reason: VOICE_ABORT_REASON,
              clientMessageId,
            }),
            signal: controller.signal,
          });
        } catch (error) {
          if (controller.signal.reason === timeoutError) throw timeoutError;
          throw error;
        }
        if (!response.ok) {
          throw new LocalRuntimeConversationFetchError(
            `local runtime turn abort returned HTTP ${response.status}`,
          );
        }

        const status = await parseRuntimeAbortStatus(response);
        if (status.clientMessageId !== clientMessageId) {
          throw new LocalRuntimeConversationFetchError(
            "local runtime turn abort echoed a different request id",
          );
        }
        if (status.requestArmRejected) {
          throw new LocalRuntimeConversationFetchError(
            "local runtime could not arm exact request cancellation",
          );
        }
        if (
          status.requestIngressState === "failed" ||
          status.requestIngressFailure !== null
        ) {
          // A failed exact-ingress receipt is authoritative terminal fate: no
          // transcript was committed and no old generation can still own the
          // room. Once settled, release this barrier instead of retrying an
          // immutable request that the route has already rejected forever.
          if (status.requestSettled) return;
          await waitForRuntimeAbortRetry(
            abortRetryDelayMs,
            controller.signal,
            timeoutError,
          );
          continue;
        }
        if (
          status.requestIngressState === "committed" &&
          status.requestSettled &&
          (status.requestObserved || status.requestArmed)
        ) {
          return;
        }

        // A registered request can take longer than the core route's bounded
        // wait to finish persistence and release its room lease. Retry only the
        // same exact capability under this outer deadline. A pre-registration
        // tombstone is not authoritative until the immutable transcript has
        // arrived, become durable, and the exact request has settled.
        await waitForRuntimeAbortRetry(
          abortRetryDelayMs,
          controller.signal,
          timeoutError,
        );
      }
    })();

    try {
      await Promise.race([probeUntilSettled, deadline]);
    } finally {
      if (timeout) clearTimeout(timeout);
      if (!controller.signal.aborted) {
        controller.abort(
          new DOMException("abort probe complete", "AbortError"),
        );
      }
    }
  };

  const startRuntimeAbort = (
    roomId: string,
    clientMessageId: string,
  ): Promise<void> => {
    const key = abortRequestKey(roomId, clientMessageId);
    const existing = pendingAbortByRequest.get(key);
    if (existing) return existing.task;

    const pending = dispatchRuntimeAbort(roomId, clientMessageId);
    pendingAbortByRequest.set(key, {
      roomId,
      clientMessageId,
      task: pending,
    });
    void pending.then(
      () => {
        if (pendingAbortByRequest.get(key)?.task === pending) {
          pendingAbortByRequest.delete(key);
        }
      },
      (error) => {
        void error;
        // error-policy:J5 The response-body cancellation observes this same
        // rejection. Retain it as a barrier so the next turn retries the
        // authoritative abort before it can enter the room queue.
      },
    );
    return pending;
  };

  const awaitPriorRuntimeAbort = async (
    roomId: string,
    currentClientMessageId?: string,
  ): Promise<void> => {
    const priors = [...pendingAbortByRequest.entries()].filter(
      ([, pending]) =>
        pending.roomId === roomId &&
        pending.clientMessageId !== currentClientMessageId,
    );
    await Promise.all(
      priors.map(async ([key, prior]) => {
        try {
          await prior.task;
          return;
        } catch (error) {
          void error;
          // error-policy:J4 Retry each failed exact capability once at the
          // next-turn boundary. Distinct tabs can cancel different request ids
          // in the same room, so no task may stand in for another token.
          if (pendingAbortByRequest.get(key)?.task === prior.task) {
            pendingAbortByRequest.delete(key);
          }
        }
        await startRuntimeAbort(roomId, prior.clientMessageId);
      }),
    );
  };

  const awaitPriorIngressBarrier = async (
    conversationId: string,
    currentClientMessageId: string,
  ): Promise<void> => {
    const priors = [...pendingIngressByConversation.values()].filter(
      (pending) =>
        pending.conversationId === conversationId &&
        pending.clientMessageId !== currentClientMessageId,
    );
    await Promise.all(
      priors.map(async (pending) => {
        try {
          await pending.task;
          return;
        } catch (error) {
          void error;
          const roomId = roomIdByConversationId.get(pending.conversationId);
          if (!roomId) {
            // Room resolution failed before any stream POST could be admitted,
            // so this request has known pre-ingress fate and no exact runtime
            // capability exists to settle. Drop the stale barrier; retaining it
            // would make a transient metadata failure poison every later turn.
            const ingressKey = ingressRequestKey(
              pending.conversationId,
              pending.clientMessageId,
            );
            if (pendingIngressByConversation.get(ingressKey) === pending) {
              pendingIngressByConversation.delete(ingressKey);
            }
            return;
          }
          const abortKey = abortRequestKey(roomId, pending.clientMessageId);
          const oldAbort = pendingAbortByRequest.get(abortKey);
          if (oldAbort) {
            try {
              await oldAbort.task;
              return;
            } catch (abortError) {
              void abortError;
              if (pendingAbortByRequest.get(abortKey)?.task === oldAbort.task) {
                pendingAbortByRequest.delete(abortKey);
              }
            }
          }
          const retry = startRuntimeAbort(roomId, pending.clientMessageId);
          pending.task = retry;
          await retry;
          const ingressKey = ingressRequestKey(
            pending.conversationId,
            pending.clientMessageId,
          );
          if (pendingIngressByConversation.get(ingressKey) === pending) {
            pendingIngressByConversation.delete(ingressKey);
          }
        }
      }),
    );
  };

  const fetchCommittedIngress = async (
    target: URL,
    requestInit: RequestInit,
  ): Promise<Response> => {
    const controller = new AbortController();
    const timeoutError = new LocalRuntimeConversationFetchError(
      `local realtime voice ingress did not commit within ${ingressTimeoutMs}ms`,
    );
    const timeout = setTimeout(
      () => controller.abort(timeoutError),
      ingressTimeoutMs,
    );
    try {
      const response = await fetchImpl(target, {
        ...requestInit,
        signal: controller.signal,
      });
      if (!response.ok) {
        const ErrorType = hasCommittedRealtimeVoiceIngress(response.headers)
          ? LocalRuntimeConversationFetchError
          : KnownUncommittedIngressResponseError;
        void response.body?.cancel().catch(() => undefined);
        throw new ErrorType(
          `local realtime voice ingress returned HTTP ${response.status}`,
        );
      }
      if (!hasCommittedRealtimeVoiceIngress(response.headers)) {
        void response.body?.cancel().catch(() => undefined);
        throw new LocalRuntimeConversationFetchError(
          "local realtime voice response arrived before durable ingress",
        );
      }
      return response;
    } catch (error) {
      if (controller.signal.reason === timeoutError) throw timeoutError;
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  };

  return (async (
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> => {
    const sourceUrl = resolveRequestUrl(input);
    const match = CLOUD_CONVERSATION_STREAM_PATH.exec(sourceUrl.pathname);
    if (!match?.[1]) {
      throw new LocalRuntimeConversationFetchError(
        `unsupported local voice upstream path: ${sourceUrl.pathname}`,
      );
    }
    if ((init?.method ?? "GET").toUpperCase() !== "POST") {
      throw new LocalRuntimeConversationFetchError(
        "local voice conversation bridge requires POST",
      );
    }

    const conversationId = decodeURIComponent(match[1]);
    const target = new URL(
      `/api/conversations/${encodeURIComponent(conversationId)}/messages/stream`,
      origin,
    );
    const body = parseRequestBody(init?.body);
    const headers = new Headers(init?.headers);
    const traceId = headers.get(VOICE_TRACE_HEADER);
    if (
      !traceId ||
      body.clientMessageId !== voiceClientMessageIdForTrace(traceId)
    ) {
      throw new LocalRuntimeConversationFetchError(
        "local voice conversation request id does not match its trace",
      );
    }
    headers.delete("Authorization");
    headers.delete("X-Service-Key");
    headers.delete("X-Eliza-Organization-Id");
    headers.delete("X-Eliza-User-Id");
    headers.set("Content-Type", "application/json");
    headers.set("Accept", "text/event-stream");

    const requestInit: RequestInit = {
      ...init,
      headers,
      body: JSON.stringify(body),
    };
    delete requestInit.signal;

    const callerSignal = init?.signal;
    let roomId: string | null = null;
    let responseExposed = false;
    let streamAttempted = false;
    let abortBarrier: Promise<void> | null = null;
    const roomPromise = (async () => {
      await awaitPriorIngressBarrier(conversationId, body.clientMessageId);
      const controller = new AbortController();
      const timeoutError = new LocalRuntimeConversationFetchError(
        `local conversation metadata did not resolve within ${ingressTimeoutMs}ms`,
      );
      const timeout = setTimeout(
        () => controller.abort(timeoutError),
        ingressTimeoutMs,
      );
      try {
        roomId = await resolveConversationRoomId(
          conversationId,
          controller.signal,
        );
        return roomId;
      } catch (error) {
        if (controller.signal.reason === timeoutError) throw timeoutError;
        throw error;
      } finally {
        clearTimeout(timeout);
      }
    })();
    const deliveryPromise = (async () => {
      const resolvedRoomId = await roomPromise;
      await awaitPriorRuntimeAbort(resolvedRoomId, body.clientMessageId);
      streamAttempted = true;
      return fetchCommittedIngress(target, requestInit);
    })();

    const startAbortBarrier = (): Promise<void> => {
      if (abortBarrier) return abortBarrier;
      const key = ingressRequestKey(conversationId, body.clientMessageId);
      abortBarrier = (async () => {
        const resolvedRoomId = await roomPromise;
        const exactAbort = startRuntimeAbort(
          resolvedRoomId,
          body.clientMessageId,
        );

        let committedResponse: Response | null = null;
        try {
          committedResponse = await deliveryPromise;
        } catch (firstError) {
          if (!(firstError instanceof KnownUncommittedIngressResponseError)) {
            // The caller can cancel before the original loopback POST reaches
            // the route. Retry the same immutable request once; exact
            // idempotency plus the cancellation tombstone guarantees at-most-
            // once user ingress. A received non-success without the ingress
            // proof is known terminal fate and must not be retried.
            try {
              committedResponse = await fetchCommittedIngress(
                target,
                requestInit,
              );
            } catch (retryError) {
              void retryError;
              // The response can be lost after the server committed ingress.
              // Exact abort status is also a versioned durable-ingress proof.
            }
          }
        }
        if (committedResponse && !responseExposed) {
          void committedResponse.body?.cancel().catch(() => undefined);
        }
        await exactAbort;
      })();
      pendingIngressByConversation.set(key, {
        conversationId,
        clientMessageId: body.clientMessageId,
        task: abortBarrier,
      });
      void abortBarrier.then(
        () => {
          if (pendingIngressByConversation.get(key)?.task === abortBarrier) {
            pendingIngressByConversation.delete(key);
          }
        },
        (error) => {
          void error;
          if (!streamAttempted) {
            // Metadata/room resolution failed before a POST was possible. There
            // is no unknown transcript fate to protect and no room-scoped abort
            // capability, so later requests must be allowed to retry metadata.
            if (pendingIngressByConversation.get(key)?.task === abortBarrier) {
              pendingIngressByConversation.delete(key);
            }
            return;
          }
          // error-policy:J5 Keep a failed post-attempt ingress barrier so every
          // later turn fails closed instead of outrunning unknown transcript fate.
        },
      );
      return abortBarrier;
    };

    let rejectCallerAbort: ((reason: unknown) => void) | null = null;
    const onAbort = () => {
      void startAbortBarrier().catch(() => undefined);
      rejectCallerAbort?.(
        callerSignal?.reason ??
          new DOMException("voice request aborted", "AbortError"),
      );
    };
    let callerAbort: Promise<never> | null = null;
    if (callerSignal) {
      callerAbort = new Promise<never>((_resolve, reject) => {
        rejectCallerAbort = reject;
        if (callerSignal.aborted) {
          onAbort();
          return;
        }
        callerSignal.addEventListener("abort", onAbort, { once: true });
      });
    }

    let response: Response;
    try {
      response = await (callerAbort
        ? Promise.race([deliveryPromise, callerAbort])
        : deliveryPromise);
    } catch (error) {
      if (!callerSignal?.aborted) {
        callerSignal?.removeEventListener("abort", onAbort);
        // A lost response can race after the server durably accepted the user
        // turn. Treat that as unknown fate: preserve/retry the immutable ingress
        // and cancel its exact work in the background before any later turn.
        if (
          streamAttempted &&
          !(error instanceof KnownUncommittedIngressResponseError)
        ) {
          void startAbortBarrier().catch(() => undefined);
        }
      }
      throw error;
    }
    if (callerSignal?.aborted) {
      onAbort();
      void response.body?.cancel().catch(() => undefined);
      throw (
        callerSignal.reason ??
        new DOMException("voice request aborted", "AbortError")
      );
    }
    responseExposed = true;
    return callerSignal
      ? bindRuntimeAbortToResponse({
          response,
          signal: callerSignal,
          onAbort,
          abortRuntimeTurn: startAbortBarrier,
        })
      : response;
  }) as typeof fetch;
}

async function parseConversationList(
  response: Response,
): Promise<Array<{ id: string; roomId: string }>> {
  let payload: unknown;
  try {
    payload = await response.json();
  } catch (error) {
    // error-policy:J3 Local runtime metadata is still a transport boundary;
    // malformed JSON cannot authorize an abort against a fabricated room id.
    throw new LocalRuntimeConversationFetchError(
      "local conversation metadata is invalid JSON",
      { cause: error },
    );
  }
  if (typeof payload !== "object" || payload === null) {
    throw new LocalRuntimeConversationFetchError(
      "local conversation metadata has an invalid shape",
    );
  }
  const rawConversations = (payload as { conversations?: unknown })
    .conversations;
  if (!Array.isArray(rawConversations)) {
    throw new LocalRuntimeConversationFetchError(
      "local conversation metadata has an invalid shape",
    );
  }
  return rawConversations.flatMap((candidate) => {
    if (typeof candidate !== "object" || candidate === null) return [];
    const { id, roomId } = candidate as { id?: unknown; roomId?: unknown };
    return typeof id === "string" &&
      id.length > 0 &&
      typeof roomId === "string" &&
      roomId.length > 0
      ? [{ id, roomId }]
      : [];
  });
}

function bindRuntimeAbortToResponse(options: {
  response: Response;
  signal: AbortSignal;
  onAbort: () => void;
  abortRuntimeTurn: () => Promise<void>;
}): Response {
  const { response, signal, onAbort, abortRuntimeTurn } = options;
  const cleanup = () => {
    signal.removeEventListener("abort", onAbort);
  };
  if (!response.body) {
    cleanup();
    return response;
  }

  const reader = response.body.getReader();
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const chunk = await reader.read();
        if (chunk.done) {
          cleanup();
          controller.close();
          return;
        }
        controller.enqueue(chunk.value);
      } catch (error) {
        if (signal.aborted) {
          try {
            await abortRuntimeTurn();
          } catch (abortError) {
            void abortError;
            // error-policy:J6 The aborted stream remains the caller-visible
            // outcome; the next-turn barrier retains the control failure.
          }
        }
        cleanup();
        controller.error(error);
      }
    },
    cancel(reason) {
      const runtimeAbort = signal.aborted ? abortRuntimeTurn() : null;
      cleanup();
      // Caller-visible Stop is immediate. The exact abort and native body
      // cancellation continue independently; the same-room pending-abort map
      // remains the authoritative barrier before any replacement request.
      void reader.cancel(reason).catch(() => undefined);
      void runtimeAbort?.catch(() => undefined);
    },
  });
  return new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}

interface RuntimeAbortStatus {
  requestAborted: boolean;
  requestObserved: boolean;
  requestArmed: boolean;
  requestArmRejected: boolean;
  requestIngressState: "pending" | "committed" | "failed";
  requestIngressFailure:
    | "request_finished_before_ingress"
    | "abort_tombstone_expired"
    | "abort_tombstone_capacity"
    | null;
  requestSettled: boolean;
  active: boolean;
  queuePending: number;
  clientMessageId: string;
}

async function parseRuntimeAbortStatus(
  response: Response,
): Promise<RuntimeAbortStatus> {
  let payload: unknown;
  try {
    payload = await response.json();
  } catch (error) {
    throw new LocalRuntimeConversationFetchError(
      "local runtime turn abort returned invalid JSON",
      { cause: error },
    );
  }
  if (typeof payload !== "object" || payload === null) {
    throw new LocalRuntimeConversationFetchError(
      "local runtime turn abort returned an invalid status",
    );
  }
  const status = payload as Record<string, unknown>;
  const validIngressFailure =
    status.requestIngressFailure === null ||
    status.requestIngressFailure === "request_finished_before_ingress" ||
    status.requestIngressFailure === "abort_tombstone_expired" ||
    status.requestIngressFailure === "abort_tombstone_capacity";
  if (
    typeof status.requestAborted !== "boolean" ||
    typeof status.requestObserved !== "boolean" ||
    typeof status.requestArmed !== "boolean" ||
    typeof status.requestArmRejected !== "boolean" ||
    (status.requestIngressState !== "pending" &&
      status.requestIngressState !== "committed" &&
      status.requestIngressState !== "failed") ||
    !validIngressFailure ||
    (status.requestIngressState === "failed") !==
      (status.requestIngressFailure !== null) ||
    typeof status.requestSettled !== "boolean" ||
    typeof status.active !== "boolean" ||
    typeof status.clientMessageId !== "string" ||
    status.clientMessageId.length === 0 ||
    status.clientMessageId.length > 128 ||
    !Number.isSafeInteger(status.queuePending) ||
    (status.queuePending as number) < 0
  ) {
    throw new LocalRuntimeConversationFetchError(
      "local runtime turn abort returned an invalid status",
    );
  }
  return {
    requestAborted: status.requestAborted,
    requestObserved: status.requestObserved,
    requestArmed: status.requestArmed,
    requestArmRejected: status.requestArmRejected,
    requestIngressState: status.requestIngressState,
    requestIngressFailure:
      status.requestIngressFailure as RuntimeAbortStatus["requestIngressFailure"],
    requestSettled: status.requestSettled,
    active: status.active,
    queuePending: status.queuePending as number,
    clientMessageId: status.clientMessageId,
  };
}

function waitForRuntimeAbortRetry(
  delayMs: number,
  signal: AbortSignal,
  timeoutError: LocalRuntimeConversationFetchError,
): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(timeoutError);
      return;
    }
    const timeout = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, delayMs);
    const onAbort = () => {
      clearTimeout(timeout);
      signal.removeEventListener("abort", onAbort);
      reject(timeoutError);
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

function resolvePositiveIntegerOption(
  value: number | undefined,
  fallback: number,
  name: string,
): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new LocalRuntimeConversationFetchError(
      `${name} must be a positive safe integer`,
    );
  }
  return value;
}

function resolveLoopbackOrigin(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch (error) {
    // error-policy:J2 Configuration errors retain their parse cause so the
    // local gateway fails at startup rather than hiding a broken route.
    throw new LocalRuntimeConversationFetchError(
      "local runtime origin is not a valid URL",
      { cause: error },
    );
  }
  if (
    (url.protocol !== "http:" && url.protocol !== "https:") ||
    (url.hostname !== "127.0.0.1" &&
      url.hostname !== "localhost" &&
      url.hostname !== "::1")
  ) {
    throw new LocalRuntimeConversationFetchError(
      "local runtime origin must be an HTTP loopback URL",
    );
  }
  url.pathname = "/";
  url.search = "";
  url.hash = "";
  return url;
}

function resolveRequestUrl(input: RequestInfo | URL): URL {
  if (input instanceof URL) return input;
  if (typeof input === "string") return new URL(input);
  return new URL(input.url);
}

function parseRequestBody(body: BodyInit | null | undefined): {
  text: string;
  clientMessageId: string;
  metadata: { clientTransport: typeof REALTIME_VOICE_CLIENT_TRANSPORT };
  streamProtocol: typeof VOICE_STREAM_PROTOCOL;
} {
  if (typeof body !== "string") {
    throw new LocalRuntimeConversationFetchError(
      "local voice conversation body must be JSON text",
    );
  }
  try {
    const parsed = JSON.parse(body) as {
      text?: unknown;
      clientMessageId?: unknown;
      metadata?: unknown;
      streamProtocol?: unknown;
    };
    if (typeof parsed.text !== "string" || parsed.text.trim() === "") {
      throw new LocalRuntimeConversationFetchError(
        "local voice conversation text is required",
      );
    }
    if (
      typeof parsed.clientMessageId !== "string" ||
      parsed.clientMessageId.trim() !== parsed.clientMessageId ||
      parsed.clientMessageId.length === 0 ||
      parsed.clientMessageId.length > 128
    ) {
      throw new LocalRuntimeConversationFetchError(
        "local voice conversation client message id is required",
      );
    }
    const metadata =
      typeof parsed.metadata === "object" &&
      parsed.metadata !== null &&
      !Array.isArray(parsed.metadata)
        ? (parsed.metadata as Record<string, unknown>)
        : null;
    if (metadata?.clientTransport !== REALTIME_VOICE_CLIENT_TRANSPORT) {
      throw new LocalRuntimeConversationFetchError(
        "local voice conversation transport metadata is required",
      );
    }
    if (parsed.streamProtocol !== VOICE_STREAM_PROTOCOL) {
      throw new LocalRuntimeConversationFetchError(
        "local voice conversation delta stream protocol is required",
      );
    }
    return {
      text: parsed.text,
      clientMessageId: parsed.clientMessageId,
      metadata: { clientTransport: REALTIME_VOICE_CLIENT_TRANSPORT },
      streamProtocol: parsed.streamProtocol,
    };
  } catch (error) {
    // error-policy:J3 The generated upstream body crosses a transport boundary;
    // malformed input fails explicitly instead of becoming an empty chat turn.
    if (error instanceof LocalRuntimeConversationFetchError) throw error;
    throw new LocalRuntimeConversationFetchError(
      "local voice conversation body is invalid JSON",
      { cause: error },
    );
  }
}
