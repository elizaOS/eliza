/**
 * Steward session glue for the app-hosted cloud surfaces.
 *
 * Thin adapter over the canonical client in
 * `@elizaos/shared/steward-session-client` — the single source of truth for the
 * storage-key names, request/response/error shapes, and read/write/clear
 * helpers shared across os-homepage, cloud-frontend, and the cloud-api route
 * handlers. We re-export the browser-safe surface the cloud domain modules need
 * so they import from one place inside `@elizaos/ui/cloud` instead of reaching
 * into `@elizaos/shared` directly.
 *
 * Cookie-sync / nonce-exchange endpoint *selection* deliberately stays in the
 * app shell (it depends on the active connection's base URL), so it is not
 * re-exported here.
 */

import type {
  ClearOpts,
  StewardSessionErrorCode,
} from "@elizaos/shared/steward-session-client";
import {
  clearStewardSession,
  clearStoredStewardToken,
  hasStewardAuthedCookie,
  readStoredStewardToken,
  STEWARD_AUTHED_COOKIE,
  STEWARD_SESSION_ENDPOINT,
  STEWARD_TENANT_ID,
  STEWARD_TOKEN_KEY,
  StewardSessionError,
  writeStoredStewardToken,
} from "@elizaos/shared/steward-session-client";

export type { ClearOpts, StewardSessionErrorCode };
export {
  clearStewardSession,
  clearStoredStewardToken,
  hasStewardAuthedCookie,
  readStoredStewardToken,
  STEWARD_AUTHED_COOKIE,
  STEWARD_SESSION_ENDPOINT,
  STEWARD_TENANT_ID,
  STEWARD_TOKEN_KEY,
  StewardSessionError,
  writeStoredStewardToken,
};

/**
 * Read the current Steward access token (JWT) from localStorage, or `null`
 * under SSR / when no session is present. Convenience alias over
 * {@link readStoredStewardToken} for cloud call sites that just want the token.
 */
export function getStewardToken(): string | null {
  return readStoredStewardToken();
}

/** Whether a Steward session token is currently stored in the browser. */
export function hasStewardToken(): boolean {
  return readStoredStewardToken() !== null;
}
