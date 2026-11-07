/**
 * iOS adapter that satisfies `NativeStreamingAgentPlugin` over the in-process
 * ElizaBunRuntime bridge (#12354). It lets `createNativeStreamingResponse`
 * (native-agent-stream.ts) turn the iOS local agent's chat token stream into a
 * live `ReadableStream`-bodied `Response` exactly as it does for Android — no
 * changes to the streaming primitive.
 *
 * Wire model: unlike a socket, the native `call({method:"http_request_stream"})`
 * blocks until the whole stream finishes (the embedded Bun engine's C ABI is a
 * single request→response call, and it services the per-token `stream_emit`
 * host-calls inline while it waits). So `requestStream` cannot wait on that
 * promise before returning a `streamId` — the caller must attach its
 * `agentStream*` listeners FIRST. This adapter therefore pre-allocates the
 * `streamId`, returns it synchronously, and fires the blocking native call in
 * the background; the events it emits arrive after listeners are live.
 */

import type {
  NativeStreamAgentRequestOptions,
  NativeStreamingAgentPlugin,
  NativeStreamListenerHandle,
} from "./native-agent-stream";

/** The minimal ElizaBunRuntime surface the streaming adapter drives. */
export interface IosStreamingRuntime {
  call(options: {
    method: string;
    args?: unknown;
  }): Promise<{ result: unknown }>;
  addListener(
    eventName: string,
    listener: (event: unknown) => void,
  ): Promise<{ remove: () => void | Promise<void> }>;
}

/** Generate an unguessable, single-use stream identity. */
function newStreamId(): string {
  const cryptoObject = globalThis.crypto;
  if (typeof cryptoObject?.randomUUID === "function") {
    return `ios-stream-${cryptoObject.randomUUID()}`;
  }
  if (typeof cryptoObject?.getRandomValues !== "function") {
    throw new Error(
      "iOS stream creation requires a cryptographically secure random source",
    );
  }

  const bytes = new Uint8Array(16);
  cryptoObject.getRandomValues(bytes);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0"));
  return `ios-stream-${hex.slice(0, 4).join("")}-${hex.slice(4, 6).join("")}-${hex.slice(6, 8).join("")}-${hex.slice(8, 10).join("")}-${hex.slice(10).join("")}`;
}

/**
 * Build a `NativeStreamingAgentPlugin` backed by the iOS runtime bridge. The
 * `onStreamError` hook (optional) observes a native call rejection for
 * diagnostics. The returned stream `completion` promise is load-bearing: if the
 * native call rejects before a terminal `agentStreamComplete` event, the shared
 * stream helper settles the head/body instead of leaving the reader pending.
 */
export function createIosStreamingAgentPlugin(
  runtime: IosStreamingRuntime,
  onStreamError?: (error: unknown) => void,
): NativeStreamingAgentPlugin {
  return {
    requestStream(
      options: NativeStreamAgentRequestOptions,
    ): Promise<{ streamId: string; completion: Promise<unknown> }> {
      const streamId = newStreamId();
      // Fire-and-forget: the call blocks until the stream completes, but the
      // token events already reached the WebView through the listeners the
      // caller attached before awaiting this resolved streamId.
      const completion = runtime
        .call({
          method: "http_request_stream",
          args: {
            method: options.method,
            path: options.path,
            headers: options.headers,
            body: options.body,
            timeoutMs: options.timeoutMs,
            streamId,
          },
        })
        .catch((error) => {
          onStreamError?.(error);
          throw error;
        });
      // error-policy:J5 `requestStream` intentionally returns before the native
      // call settles. Mark this promise handled to avoid an unhandled-rejection;
      // the rejection IS observed by the caller through the returned
      // `completion` (and surfaced via onStreamError above).
      void completion.catch(() => {});
      return Promise.resolve({ streamId, completion });
    },
    addListener(
      eventName:
        | "agentStreamResponse"
        | "agentStreamChunk"
        | "agentStreamComplete",
      listener: (event: unknown) => void,
    ): Promise<NativeStreamListenerHandle> {
      return runtime.addListener(eventName, listener);
    },
  };
}
