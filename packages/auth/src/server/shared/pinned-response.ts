/** Bounded Node transport; callers supply the destination policy at connect time. */
import type { LookupFunction } from "node:net";
import {
  ElizaError,
  nodePinnedFetch,
  readResponseWithLimit,
} from "@elizaos/core";

export async function fetchPinnedResponse(
  url: URL,
  init: RequestInit,
  options: {
    lookup?: LookupFunction;
    timeoutMs: number;
    maxBytes: number;
    rejectRedirects?: boolean;
  },
): Promise<Response> {
  const controller = new AbortController();
  const abort = () => controller.abort(init.signal?.reason);
  if (init.signal?.aborted) abort();
  else init.signal?.addEventListener("abort", abort, { once: true });
  const deadline = setTimeout(
    () =>
      controller.abort(
        new ElizaError("Pinned request timed out", {
          code: "LOGIN_HTTP_TIMEOUT",
        }),
      ),
    options.timeoutMs,
  );
  try {
    const response = await nodePinnedFetch({
      url,
      init: { ...init, signal: controller.signal },
      lookup: options.lookup as Parameters<typeof nodePinnedFetch>[0]["lookup"],
      addresses: [],
    });
    if (
      options.rejectRedirects &&
      response.status >= 300 &&
      response.status < 400
    ) {
      throw new ElizaError("Pinned endpoint redirects are not allowed", {
        code: "LOGIN_HTTP_REDIRECT",
      });
    }
    const declaredLength = Number(response.headers.get("content-length"));
    if (Number.isFinite(declaredLength) && declaredLength > options.maxBytes) {
      throw new ElizaError("Pinned response exceeded maximum size", {
        code: "LOGIN_HTTP_RESPONSE_TOO_LARGE",
      });
    }
    const body = await readResponseWithLimit(response, options.maxBytes);
    return new Response(
      [204, 205, 304].includes(response.status) ? null : new Uint8Array(body),
      {
        status: response.status,
        headers: response.headers,
      },
    );
  } catch (error) {
    // Node may surface a body cancellation as ECONNRESET. Preserve the caller's
    // cancellation or our typed deadline instead of leaking a transport error.
    if (controller.signal.aborted) throw controller.signal.reason;
    throw error;
  } finally {
    clearTimeout(deadline);
    init.signal?.removeEventListener("abort", abort);
    controller.abort();
  }
}
