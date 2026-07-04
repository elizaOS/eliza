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

export interface NativeStreamAgentRequestOptions {
  method?: string;
  path: string;
  headers?: Record<string, string>;
  body?: string | null;
  timeoutMs?: number;
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
): Promise<Response> {
  const stream = await agent.requestStream(options);
  const { streamId } = stream;

  let controller: ReadableStreamDefaultController<Uint8Array> | null = null;
  // Buffer events that land before `start()` runs (and the terminal state if it
  // arrives before any reader pulls), so nothing is dropped on either edge.
  const pending: Uint8Array[] = [];
  let terminal: { error?: string | null } | null = null;
  const handles: NativeStreamListenerHandle[] = [];
  let detached = false;

  const detach = (): void => {
    if (detached) return;
    detached = true;
    for (const handle of handles) void handle.remove();
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
      detach();
    },
  });

  let resolveHead: (response: Response) => void;
  let rejectHead: (reason: unknown) => void;
  const head = new Promise<Response>((resolve, reject) => {
    resolveHead = resolve;
    rejectHead = reject;
  });
  void head.catch(() => {});
  let headSettled = false;

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
    if (!e || e.streamId !== streamId) return;
    // A failure before the head ever arrived can't yield a Response — reject the
    // head so the caller falls back / surfaces the error.
    if (e.error && !headSettled) {
      headSettled = true;
      rejectHead(new Error(e.error));
      detach();
      return;
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
    void stream.completion.catch(failStream);
  }

  handles.push(await agent.addListener("agentStreamResponse", onResponse));
  handles.push(await agent.addListener("agentStreamChunk", onChunk));
  handles.push(await agent.addListener("agentStreamComplete", onComplete));

  return head;
}
