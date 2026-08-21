/**
 * Carries a gateway identity across an in-isolate Hono dispatch without
 * re-verifying the same external credential. Request-object identity is the
 * capability: network callers cannot manufacture or replay an entry.
 */

import type { InternalServiceAuth } from "../../_auth";

const preverifiedRequests = new WeakMap<Request, InternalServiceAuth>();

export function markPreverifiedPersonalSharedRequest(
  request: Request,
  auth: InternalServiceAuth,
): void {
  if (preverifiedRequests.has(request)) {
    throw new Error("Personal Shared request was already preverified");
  }
  preverifiedRequests.set(request, auth);
}

export function consumePreverifiedPersonalSharedRequest(
  request: Request,
): InternalServiceAuth | undefined {
  const auth = preverifiedRequests.get(request);
  if (auth) preverifiedRequests.delete(request);
  return auth;
}
