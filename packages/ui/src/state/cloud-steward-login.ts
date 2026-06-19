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

import { readStoredStewardToken } from "@elizaos/shared/steward-session-client";

export interface StewardLoginResult {
  /** The Steward session JWT now present in localStorage. */
  token: string;
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
 * Drive the Cloud=Steward sign-in. If a session token is already stored we
 * resolve immediately; otherwise we invoke the registered launcher. Throws when
 * no launcher is registered (the shell-router has not mounted the Cloud
 * provider) so the caller can fall back to a legacy path during migration.
 */
export async function launchStewardLogin(): Promise<StewardLoginResult> {
  const existing = readStoredStewardToken()?.trim();
  if (existing) return { token: existing };

  if (!registeredLauncher) {
    throw new Error(
      "Eliza Cloud sign-in is unavailable: the Steward login surface is not mounted.",
    );
  }
  return registeredLauncher();
}
