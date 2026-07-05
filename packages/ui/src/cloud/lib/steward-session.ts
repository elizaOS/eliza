/**
 * Steward session glue for the app-hosted cloud surfaces.
 *
 * Thin adapter over the canonical client in
 * `@elizaos/shared/steward-session-client` — the single source of truth for the
 * storage-key names, request/response/error shapes, and read/write/clear
 * helpers shared with the cloud-api route handlers. We re-export the
 * browser-safe surface the cloud domain modules need
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
import {
  readStoredToken,
  tokenIsExpired,
} from "../shell/StewardProviderShared";
import { decodeJwtPayload } from "./jwt";

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

/**
 * Whether a stored Steward token is worth holding the console auth gate for.
 * Raw presence is not enough: expired, malformed, and identity-less tokens read
 * as signed-out in `useSessionAuth`, so holding on them would replace the
 * intended login redirect with an uncloseable busy state.
 */
export function hasHydratableStewardToken(): boolean {
  const token = readStoredToken();
  if (!token || tokenIsExpired(token)) return false;
  const claims = decodeJwtPayload(token);
  const id = claims?.userId ?? claims?.sub;
  return typeof id === "string" && id.trim().length > 0;
}
