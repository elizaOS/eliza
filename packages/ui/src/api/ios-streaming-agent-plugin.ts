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
  const uuid =
    typeof globalThis.crypto?.randomUUID === "function"
      ? globalThis.crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return `ios-stream-${uuid}`;
}

/**
 * Build a `NativeStreamingAgentPlugin` backed by the iOS runtime bridge. The
 * `onStreamError` hook (optional) observes a native call that rejects after the
 * stream head was already delivered — the response body is already terminated by
 * an `agentStreamComplete` event in the normal path, so this is purely for
 * diagnostics, never for control flow.
 */
export function createIosStreamingAgentPlugin(
  runtime: IosStreamingRuntime,
  onStreamError?: (error: unknown) => void,
): NativeStreamingAgentPlugin {
  return {
    requestStream(
      options: NativeStreamAgentRequestOptions,
    ): Promise<{ streamId: string }> {
      const streamId = newStreamId();
      // Fire-and-forget: the call blocks until the stream completes, but the
      // token events already reached the WebView through the listeners the
      // caller attached before awaiting this resolved streamId.
      void runtime
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
        });
      return Promise.resolve({ streamId });
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
