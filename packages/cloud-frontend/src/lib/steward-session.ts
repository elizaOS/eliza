import {
  readStoredStewardRefreshToken,
  STEWARD_SESSION_ENDPOINT,
} from "@elizaos/steward-session-client";
import { apiFetch } from "./api-client";

/**
 * Same-origin Steward JWT -> HttpOnly cookie sync. Uses `apiFetch` so the
 * call inherits the SPA's API base-URL + credential plumbing.
 *
 * The shared `syncStewardSession()` from `@elizaos/steward-session-client`
 * speaks to global `fetch` and is correct for os-homepage. cloud-frontend
 * goes through `apiFetch` instead — we still use the shared constants and
 * storage helpers so the contract stays in one place.
 */
export async function syncStewardSessionCookie(
  token: string,
  refreshToken?: string | null,
): Promise<void> {
  const response = await apiFetch(STEWARD_SESSION_ENDPOINT, {
    method: "POST",
    skipAuth: true,
    json: {
      token,
      refreshToken:
        refreshToken === undefined
          ? readStoredStewardRefreshToken()
          : refreshToken,
    },
  });

  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as {
      error?: string;
    } | null;
    throw new Error(
      body?.error || "Could not establish an Eliza Cloud session.",
    );
  }

  if (typeof window !== "undefined") {
    window.dispatchEvent(
      new CustomEvent("steward-token-sync", { detail: { token } }),
    );
  }
}
