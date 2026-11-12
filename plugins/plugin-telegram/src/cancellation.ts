import type { Telegram } from "telegraf";

const adapted = Symbol("telegram-cancellation");

/** Install once on each owned SDK client, including the client for an update. */
export function preserveTelegramCancellation(client: Telegram): void {
  if (adapted in client) return;
  const callApi = client.callApi.bind(client);
  client.callApi = async (method, payload, options) => {
    const signal = options?.signal;
    if (!signal) return callApi(method, payload, options);

    const controller = new AbortController();
    const forwardAbort = () => {
      const reason = "reason" in signal ? signal.reason : undefined;
      if (reason === undefined || reason instanceof DOMException) {
        // Telegraf writes to fetch errors. Native DOMException messages can be
        // read-only, so give this call a writable reason without changing the
        // caller's signal or reason. Redact before Error creates its stack.
        const message =
          reason instanceof DOMException
            ? reason.message
            : "The operation was aborted.";
        const error = new Error(
          message.replace(/\/(bot|user)(\d+):[^/]+\//g, "/$1$2:[REDACTED]/"),
        );
        error.name =
          reason instanceof DOMException ? reason.name : "AbortError";
        controller.abort(error);
      } else {
        controller.abort(reason);
      }
    };
    signal.addEventListener("abort", forwardAbort, { once: true });
    try {
      if (signal.aborted) forwardAbort();
      return await callApi(method, payload, {
        ...options,
        // The SDK still types signals as its legacy shim; both fetch engines
        // accept the native signal used here.
        signal: controller.signal as typeof signal,
      });
    } finally {
      signal.removeEventListener("abort", forwardAbort);
    }
  };
  Object.defineProperty(client, adapted, { value: true });
}
