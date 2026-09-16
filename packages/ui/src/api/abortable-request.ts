/**
 * Observes cancellation while a native bridge operation settles. Cancelling
 * the wait cannot undo a side effect already dispatched to the native host.
 */
import { reportRendererDiagnostic } from "../utils/renderer-diagnostics";

export function runAbortableRequest<T>(
  signal: AbortSignal,
  run: () => Promise<T>,
): Promise<T> {
  signal.throwIfAborted();
  return new Promise<T>((resolve, reject) => {
    const cleanup = () => signal.removeEventListener("abort", onAbort);
    const onAbort = () => {
      cleanup();
      reject(signal.reason);
    };
    signal.addEventListener("abort", onAbort, { once: true });
    Promise.resolve()
      .then(() => {
        signal.throwIfAborted();
        return run();
      })
      .then(
        (value) => {
          cleanup();
          resolve(value);
        },
        (error: unknown) => {
          cleanup();
          reject(error);
        },
      );
  });
}

/** Keep native response reads cancellable through complete body consumption. */
export function abortableResponse(
  response: Response,
  signal: AbortSignal,
): Response {
  if (!response.body) return response;
  const reader = response.body.getReader();
  let settled = false;
  let controller: ReadableStreamDefaultController<Uint8Array>;
  const finish = () => {
    settled = true;
    signal.removeEventListener("abort", onAbort);
  };
  const onAbort = () => {
    if (settled) return;
    finish();
    controller.error(signal.reason);
    void reader.cancel(signal.reason).catch((error: unknown) => {
      // error-policy:J5 the underlying stream already reports this same abort.
      if (signal.aborted && error === signal.reason) return;
      // error-policy:J6 cancellation has reached the caller; report other teardown failures.
      reportRendererDiagnostic({
        scope: "native-response.cancel",
        severity: "warning",
        error,
      });
    });
  };
  const body = new ReadableStream<Uint8Array>(
    {
      start(streamController) {
        controller = streamController;
        if (signal.aborted) onAbort();
        else signal.addEventListener("abort", onAbort, { once: true });
      },
      async pull() {
        try {
          const result = await reader.read();
          if (settled) return;
          if (result.done) {
            finish();
            controller.close();
          } else controller.enqueue(result.value);
        } catch (error) {
          // error-policy:J1 propagate the body-read failure through the Fetch stream.
          if (settled) return;
          finish();
          controller.error(error);
        }
      },
      cancel(reason) {
        finish();
        return reader.cancel(reason);
      },
    },
    { highWaterMark: 0 },
  );
  return new Response(body, response);
}
