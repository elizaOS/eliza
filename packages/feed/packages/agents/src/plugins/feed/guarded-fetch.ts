/**
 * SSRF-guarded fetch for the Feed A2A integration.
 *
 * The A2A agent-card endpoint is operator/agent-supplied
 * (`FEED_A2A_ENDPOINT` / `NEXT_PUBLIC_APP_URL` and, for `A2AClient`, the URL the
 * card advertises), so a raw `fetch` of it is an SSRF sink: a card URL that
 * resolves to `169.254.169.254`, `10.x`, or the mesh network would let the
 * request reach cloud metadata or internal services. Every outbound A2A request
 * routes through {@link fetchWithSsrfGuard} (from `@elizaos/core`), which
 * validates the URL, blocks private/loopback/link-local targets, and — on
 * Node/Bun — pins DNS to the validated IP so the host cannot rebind between the
 * check and the connect. Redirects are re-validated on every hop.
 *
 * Identity headers are merged into the guard's request init rather than handed
 * off through a custom `fetchImpl`, which keeps the guard's auto-loaded pinned
 * transport (the DNS-rebinding defense) in force.
 */

import { fetchWithSsrfGuard } from "@elizaos/core";

/** Guarded replacement for `fetch(url, init)` used for all A2A outbound calls. */
export async function guardedFetch(
  url: string | URL | Request,
  init?: RequestInit,
): Promise<Response> {
  const { target, requestInit } = a2aRequestParts(url, init);
  const { response, release } = await fetchWithSsrfGuard({
    url: target,
    ...(requestInit ? { init: requestInit } : {}),
  });
  // The guard's release() only clears the abort timer we did not set here, so it
  // is a no-op cleanup; call it to honor the contract without holding the socket.
  await release();
  return response;
}

/**
 * Build a `fetchImpl` (matching the `A2AClient` fetch contract) that injects the
 * given headers and routes every request through {@link guardedFetch}. Used so
 * `A2AClient` cannot fetch an unguarded, attacker-controllable card/task URL.
 */
export function createGuardedFetchImpl(
  injectHeaders: (headers: Headers) => void,
): typeof fetch {
  const impl = async (
    url: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    const headers = new Headers(url instanceof Request ? url.headers : undefined);
    for (const [key, value] of new Headers(init?.headers)) {
      headers.set(key, value);
    }
    injectHeaders(headers);
    return guardedFetch(url, { ...init, headers });
  };
  return impl as typeof fetch;
}

function a2aRequestParts(
  url: string | URL | Request,
  init?: RequestInit,
): { target: string; requestInit?: RequestInit } {
  if (typeof url === "string") {
    return { target: url, requestInit: init };
  }
  if (url instanceof URL) {
    return { target: url.toString(), requestInit: init };
  }
  return {
    target: url.url,
    requestInit: {
      method: url.method,
      headers: url.headers,
      body: url.body,
      signal: url.signal,
      redirect: url.redirect,
      ...init,
    },
  };
}
