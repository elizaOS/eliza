/**
 * Cloud = Steward login seam (DECISIONS.md D3).
 *
 * The Cloud connection authenticates via Steward on every target — hosted web
 * (same-origin cookie + localStorage JWT) and native (Bearer-from-localStorage).
 * The actual Steward sign-in UI (passkey / email / OAuth / wallet via
 * `@stwd/react`) lives in the shell-router layer, which lazily mounts the
 * Steward provider only when the user chooses Cloud. This module is the thin,
 * dependency-free contract between the two:
 *
 *   - The shell-router registers a launcher with {@link registerStewardLoginLauncher}.
 *   - The cloud-state login flow (`handleCloudLogin`, Cloud branch) calls
 *     {@link launchStewardLogin}, which resolves once a Steward session token is
 *     present (or rejects on cancel / failure).
 *
 * Keeping this a plain module (no React, no `@stwd/*`) means `useCloudState`
 * never pulls the Steward SDK into the non-cloud bundle — the SDK ships only in
 * the shell-router's lazy cloud path.
 */

import {
  clearStoredStewardToken,
  readStoredStewardToken,
} from "@elizaos/shared/steward-session-client";
import { cloudTokenSecsRemaining } from "../api/client-cloud";

export interface StewardLoginResult {
  /** The Steward session JWT now present in localStorage. */
  token: string;
}

/**
 * Minimum lifetime (seconds) a stored Steward JWT must still have for the
 * short-circuit to trust it. A token at or under this margin is treated as
 * already dead: rather than hand the caller an expired session (which would
 * 401 the agent picker / subsequent calls in a loop) we clear it and force a
 * real re-auth.
 */
const STEWARD_TOKEN_MIN_VALID_SECS = 10;

/**
 * Whether a stored Steward token can be trusted to short-circuit sign-in.
 * Opaque (non-JWT) device-code / Remote session tokens have no decodable `exp`
 * (`cloudTokenSecsRemaining` → null) and are left to the legacy flow, matching
 * the cloud token-lifecycle refresh which also no-ops on a null result. A JWT
 * is usable only while it has more than a small safety margin of life left.
 */
function isStoredStewardTokenUsable(token: string): boolean {
  const secs = cloudTokenSecsRemaining(token);
  if (secs === null) return true; // opaque/device-code token — not our concern
  return secs > STEWARD_TOKEN_MIN_VALID_SECS;
}

/**
 * A launcher opens the Steward sign-in surface and resolves once the user has
 * authenticated (a Steward token is in localStorage). It rejects if the user
 * cancels or sign-in fails. Implemented by the shell-router.
 */
export type StewardLoginLauncher = () => Promise<StewardLoginResult>;

let registeredLauncher: StewardLoginLauncher | null = null;

/**
 * Register the Steward sign-in launcher. Called once by the shell-router when
 * it mounts the lazy Cloud provider tree. Returns an unregister function.
 */
export function registerStewardLoginLauncher(
  launcher: StewardLoginLauncher,
): () => void {
  registeredLauncher = launcher;
  return () => {
    if (registeredLauncher === launcher) {
      registeredLauncher = null;
    }
  };
}

/** Whether a shell-router Steward launcher is currently registered. */
export function hasStewardLoginLauncher(): boolean {
  return registeredLauncher !== null;
}

/**
 * Whether a stored Steward token exists AND can short-circuit sign-in (see
 * {@link launchStewardLogin}). Callers use this to decide if the Steward
 * branch can complete without a mounted launcher: a stored-but-stale JWT
 * cannot (launching would just clear it and throw when nothing is mounted),
 * so they should fall back to the legacy device-code flow instead.
 */
export function hasUsableStoredStewardToken(): boolean {
  const existing = readStoredStewardToken()?.trim();
  return Boolean(existing && isStoredStewardTokenUsable(existing));
}

/**
 * Drive the Cloud=Steward sign-in. If a *still-valid* session token is already
 * stored we resolve immediately; otherwise we invoke the registered launcher.
 * A stored-but-expired Steward JWT must NOT short-circuit — doing so produces a
 * false "connected" state whose subsequent authed calls 401 in a loop — so we
 * drain the stale value and fall through to a real re-auth. Throws when no
 * launcher is registered (the shell-router has not mounted the Cloud provider)
 * so the caller can fall back to a legacy path during migration.
 */
export async function launchStewardLogin(): Promise<StewardLoginResult> {
  const existing = readStoredStewardToken()?.trim();
  if (existing && isStoredStewardTokenUsable(existing)) {
    return { token: existing };
  }
  if (existing) clearStoredStewardToken();

  if (!registeredLauncher) {
    throw new Error(
      "Eliza Cloud sign-in is unavailable: the Steward login surface is not mounted.",
    );
  }
  return registeredLauncher();
}
