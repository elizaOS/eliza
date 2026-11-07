/**
 * Never-follow-a-redirect fetch for code that runs inside the API Worker.
 *
 * `fetch(url, { redirect: "error" })` is the natural way to refuse redirects,
 * but the Cloudflare Workers runtime rejects that mode outright with
 * `TypeError: Invalid redirect value, must be one of "follow" or "manual"` —
 * every call fails before it leaves the Worker (elizaOS/eliza#37102). These
 * helpers ask for `"manual"` instead (accepted by workerd, Node, Bun and
 * browsers) and turn any redirect response into the same rejected promise
 * `"error"` produced, so callers keep their transport-failure path and nothing
 * ever follows a `Location` header.
 *
 * `worker-redirect-mode.test.ts` fails if a module the Worker bundles uses
 * `redirect: "error"` with a platform fetch again.
 */

/** The redirect mode every Worker-reachable no-follow request must use. */
export const NO_FOLLOW_REDIRECT = "manual" as const satisfies RequestRedirect;

type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

/** Thrown in place of the platform's `redirect: "error"` network error. */
export class RedirectRefusedError extends TypeError {
  readonly status: number;
  constructor(status: number) {
    super(`Refused to follow a redirect response (HTTP ${status})`);
    this.name = "RedirectRefusedError";
    this.status = status;
  }
}

/**
 * True for any response a `"manual"` fetch hands back instead of following:
 * every 3xx (workerd, Node and Bun expose the real status) and the browser's
 * status-0 `opaqueredirect` filtered response.
 */
export function isRedirectResponse(response: Response): boolean {
  return response.type === "opaqueredirect" || (response.status >= 300 && response.status < 400);
}

/**
 * Pass a non-redirect response through; otherwise release its body and reject
 * with {@link RedirectRefusedError}, exactly where `"error"` would have thrown.
 */
export async function refuseRedirect(response: Response): Promise<Response> {
  if (!isRedirectResponse(response)) return response;
  await response.body?.cancel().catch(() => {
    // error-policy:J6 The redirect is already refused; body disposal is
    // best-effort teardown of an unused response.
  });
  throw new RedirectRefusedError(response.status);
}

/** `fetch` that never follows a redirect and rejects on one, Worker-safe. */
export async function fetchWithoutRedirects(
  input: RequestInfo | URL,
  init?: RequestInit,
  fetchImpl: FetchLike = fetch,
): Promise<Response> {
  return refuseRedirect(await fetchImpl(input, { ...init, redirect: NO_FOLLOW_REDIRECT }));
}

/**
 * Wrap a fetch implementation (injected test fetch, `boundedProviderFetch`'s
 * `fetchImpl`) so every request it makes refuses redirects.
 */
export function withoutRedirects(fetchImpl: FetchLike = fetch): typeof fetch {
  return ((input: RequestInfo | URL, init?: RequestInit) =>
    fetchWithoutRedirects(input, init, fetchImpl)) as typeof fetch;
}
