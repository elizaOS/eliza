/** Provenance attached by the authenticated native dispatcher; HTTP headers cannot create it. */
const authenticatedInProcessRequests = new WeakSet<object>();

export function markAuthenticatedInProcessRequest(request: object): void {
  authenticatedInProcessRequests.add(request);
}

export function isAuthenticatedInProcessRequest(request: object): boolean {
  return authenticatedInProcessRequests.has(request);
}
