/**
 * Narrow, renderer-safe package seam for reading and subscribing to the
 * canonical app auth snapshot from non-React background services.
 */
export {
  type AuthStatusState,
  isAuthenticatedNow,
  subscribeAuthStatus,
} from "./hooks/useAuthStatus";
