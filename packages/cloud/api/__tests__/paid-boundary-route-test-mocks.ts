/** Shares deterministic generative-route mocks across mounted boundary suites. */

import { mock } from "bun:test";

export const paidBoundaryState: {
  routeError: Error | null;
  knownIdentityError: Error | null;
} = {
  routeError: null,
  knownIdentityError: null,
};

export const requireGenerativeRouteCaller = mock(async () => {
  if (paidBoundaryState.routeError) throw paidBoundaryState.routeError;
  return {
    user: { id: "user-1", organization_id: "org-1" },
    apiKeyId: "key-1",
    authSource: "combined_cache" as const,
    appScopeId: null,
  };
});

export const requireGenerativeKnownIdentity = mock(async () => {
  if (paidBoundaryState.knownIdentityError)
    throw paidBoundaryState.knownIdentityError;
  return {
    user: { id: "user-1", organization_id: "org-1" },
    apiKeyId: null,
    authSource: "compatibility" as const,
    appScopeId: null,
  };
});

export const getGenerativeOperationContext = mock(
  (_context: unknown, caller: { apiKeyId: string | null }) => ({
    organizationId: "org-1",
    userId: "user-1",
    apiKeyId: caller.apiKeyId,
    requestId: "request-1",
  }),
);

export function resetPaidBoundaryRouteMocks(): void {
  paidBoundaryState.routeError = null;
  paidBoundaryState.knownIdentityError = null;
  requireGenerativeRouteCaller.mockClear();
  requireGenerativeKnownIdentity.mockClear();
  getGenerativeOperationContext.mockClear();
}
