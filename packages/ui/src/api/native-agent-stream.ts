/**
 * Native streaming bridge → a real streaming `Response`.
 *
 * The buffered `Agent.request` bridge (android-native-agent-transport.ts) reads
 * the whole loopback response into one string, so an SSE body (the chat reply's
 * token frames) arrives all at once and the WebView never streams. `Agent`
 * gained a `requestStream` method that pushes the response incrementally via
 * `agentStream*` Capacitor events; this turns those events back into a
 * `ReadableStream`-bodied `Response` so the existing SSE parser reads tokens as
 * they arrive.
 *
 * Pure transport glue — the plugin is passed in, so it unit-tests with a fake.
 */

import { logger } from "@elizaos/logger";

export interface NativeStreamAgentRequestOptions {
  method?: string;
  path: string;
  headers?: Record<string, string>;
  body?: string | null;
}

export interface NativeStreamResponseEvent {
  streamId: string;
  status: number;
  statusText?: string;
  headers?: Record<string, string>;
}

export interface NativeStreamChunkEvent {
  streamId: string;
  dataBase64: string;
}

export interface NativeStreamCompleteEvent {
  streamId: string;
  error?: string | null;
}

export interface NativeStreamListenerHandle {
  remove: () => void | Promise<void>;
}

/** The subset of the `Agent` Capacitor plugin the streaming bridge needs. */
export interface NativeStreamingAgentPlugin {
  requestStream: (
    options: NativeStreamAgentRequestOptions,
  ) => Promise<{ streamId: string; completion?: Promise<unknown> }>;
  addListener: (
    eventName:
      | "agentStreamResponse"
      | "agentStreamChunk"
      | "agentStreamComplete",
    listener: (event: unknown) => void,
  ) => Promise<NativeStreamListenerHandle> | NativeStreamListenerHandle;
  /**
   * Stop the native producer when the owner abandons a stream. Implementations
   * close the Android UDS or abort the iOS model request.
   */
  cancelStream?: (streamId: string) => Promise<void> | void;
}

/** Type guard: does this plugin expose the streaming bridge? */
export function supportsNativeStreaming(
  plugin: unknown,
): plugin is NativeStreamingAgentPlugin {
  if (!plugin || typeof plugin !== "object") return false;
  const p = plugin as Record<string, unknown>;
  return (
    typeof p.requestStream === "function" && typeof p.addListener === "function"
  );
}

function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/**
 * Start a streaming loopback request and resolve with a `Response` whose body is
 * a live `ReadableStream` fed by the native `agentStream*` events. Resolves once
 * the response head arrives; the body streams until `agentStreamComplete`.
 *
 * Listeners attach synchronously after `requestStream` resolves — Capacitor
 * delivers events on a later tick, so no chunk is missed. Cancelling the stream
 * (reader.cancel) or completion detaches every listener.
 */
export async function createNativeStreamingResponse(
  agent: NativeStreamingAgentPlugin,
  options: NativeStreamAgentRequestOptions,
  signal?: AbortSignal,
): Promise<Response> {
  signal?.throwIfAborted();
  const stream = await agent.requestStream(options);
  const { streamId } = stream;

  let controller: ReadableStreamDefaultController<Uint8Array> | null = null;
  // Buffer events that land before `start()` runs (and the terminal state if it
  // arrives before any reader pulls), so nothing is dropped on either edge.
  const pending: Uint8Array[] = [];
  let terminal: { error?: string | null } | null = null;
  const handles: NativeStreamListenerHandle[] = [];
  let detached = false;
  let nativeCancelled = false;

  const cancelNative = (): void => {
    if (nativeCancelled) return;
    nativeCancelled = true;
    void Promise.resolve(agent.cancelStream?.(streamId)).catch((error) => {
      // error-policy:J6 best-effort teardown: the owner-facing stream is
      // already cancelled; report a failed native stop so leaked work remains
      // observable without replacing the caller's AbortError.
      logger.warn(
        { error, streamId },
        "[NativeAgentStream] Native stream cancellation failed",
      );
    });
  };

  const removeHandle = (handle: NativeStreamListenerHandle): void => {
    void Promise.resolve(handle.remove()).catch((error) => {
      // error-policy:J6 best-effort teardown: listener removal cannot repair a
      // terminal stream, but a failed removal is observable as a leak signal.
      logger.warn(
        { error, streamId },
        "[NativeAgentStream] Native listener removal failed",
      );
    });
  };

  const detach = (): void => {
    if (detached) return;
    detached = true;
    signal?.removeEventListener("abort", onAbort);
    for (const handle of handles) removeHandle(handle);
  };
  const trackHandle = (handle: NativeStreamListenerHandle): void => {
    if (detached) {
      removeHandle(handle);
      return;
    }
    handles.push(handle);
  };

  const body = new ReadableStream<Uint8Array>({
    start(c) {
      controller = c;
      for (const chunk of pending) c.enqueue(chunk);
      pending.length = 0;
      if (terminal) {
        if (terminal.error) c.error(new Error(terminal.error));
        else c.close();
        detach();
      }
    },
    cancel() {
      cancelNative();
      detach();
    },
  });

  let resolveHead: (response: Response) => void;
  let rejectHead: (reason: unknown) => void;
  const head = new Promise<Response>((resolve, reject) => {
    resolveHead = resolve;
    rejectHead = reject;
  });
  // error-policy:J5 unhandled-rejection guard; the rejection IS observed by the
  // caller that consumes the returned `head` promise (line 207) — this keepalive
  // catch only prevents a spurious unhandledrejection if head settles first.
  void head.catch(() => {});
  let headSettled = false;

  const abortError = (): Error =>
    signal?.reason instanceof Error
      ? signal.reason
      : new DOMException("Native stream cancelled", "AbortError");

  const onAbort = (): void => {
    if (detached) return;
    cancelNative();
    failStream(abortError());
  };

  const failStream = (reason: unknown): void => {
    if (detached) return;
    const error =
      reason instanceof Error
        ? reason
        : new Error(String(reason ?? "Stream failed"));
    if (!headSettled) {
      headSettled = true;
      rejectHead(error);
      detach();
      return;
    }
    if (controller) {
      controller.error(error);
      detach();
    } else {
      terminal = { error: error.message };
    }
  };

  // Terminal on a SUCCESSFUL native completion (the resolution, not just the
  // rejection failStream handles): if the head never arrived, settle it with a
  // 200 so the caller gets a Response, then close the body. Idempotent — a
  // later `agentStreamComplete` sees `detached` and no-ops.
  const finishStream = (): void => {
    if (detached) return;
    if (!headSettled) {
      headSettled = true;
      resolveHead(new Response(body, { status: 200 }));
    }
    if (controller) {
      controller.close();
      detach();
    } else {
      terminal = { error: null };
    }
  };

  const onResponse = (event: unknown): void => {
    const e = event as NativeStreamResponseEvent;
    if (!e || e.streamId !== streamId || headSettled) return;
    headSettled = true;
    resolveHead(
      new Response(body, {
        status: e.status,
        statusText: e.statusText ?? "",
        headers: e.headers ?? {},
      }),
    );
  };

  const onChunk = (event: unknown): void => {
    const e = event as NativeStreamChunkEvent;
    if (!e || e.streamId !== streamId || !e.dataBase64) return;
    const bytes = base64ToBytes(e.dataBase64);
    if (controller) controller.enqueue(bytes);
    else pending.push(bytes);
  };

  const onComplete = (event: unknown): void => {
    const e = event as NativeStreamCompleteEvent;
    if (!e || e.streamId !== streamId || detached) return;
    // Always settle the head before touching the body — a terminal event that
    // beats the response (empty stream completing head-first, or a dropped head
    // event) must still resolve/reject the caller's promise, never leave it
    // hanging. A failure can't yield a Response, so it rejects; a success
    // resolves a 200 and falls through to close the body.
    if (!headSettled) {
      headSettled = true;
      if (e.error) {
        rejectHead(new Error(e.error));
        detach();
        return;
      }
      resolveHead(new Response(body, { status: 200 }));
    }
    if (controller) {
      if (e.error) controller.error(new Error(e.error));
      else controller.close();
      detach();
    } else {
      terminal = { error: e.error };
    }
  };

  if (stream.completion) {
    // Both settlements are terminal: a resolved completion closes the stream via
    // `finishStream` (missing the terminal event still ends the reply); a
    // rejected one fails it. Wiring only `.catch` would hang on a silent success.
    void stream.completion.then(finishStream, failStream);
  }

  signal?.addEventListener("abort", onAbort, { once: true });
  if (signal?.aborted) {
    onAbort();
  }

  trackHandle(await agent.addListener("agentStreamResponse", onResponse));
  trackHandle(await agent.addListener("agentStreamChunk", onChunk));
  trackHandle(await agent.addListener("agentStreamComplete", onComplete));

  return head;
}
