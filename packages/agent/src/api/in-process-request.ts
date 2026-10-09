/** Provenance attached by the authenticated native dispatcher; HTTP headers cannot create it. */
import type { AgentHttpRequestAuthorization } from "../runtime/host-bridge.ts";

const authenticatedInProcessRequests = new WeakMap<
  object,
  AgentHttpRequestAuthorization | undefined
>();

export function markAuthenticatedInProcessRequest(
  request: object,
  authorization?: AgentHttpRequestAuthorization,
): void {
  authenticatedInProcessRequests.set(request, authorization);
}

export function isAuthenticatedInProcessRequest(request: object): boolean {
  return authenticatedInProcessRequests.has(request);
}

/** Original verified principal, never reconstructed from HTTP or model fields. */
export function getAuthenticatedInProcessAuthorization(
  request: object,
): AgentHttpRequestAuthorization | undefined {
  return authenticatedInProcessRequests.get(request);
}
