import { apiFetch } from "./api-client";

const STEWARD_SESSION_ENDPOINT = "/api/auth/steward-session";
const STEWARD_REFRESH_TOKEN_KEY = "steward_refresh_token";

function readStoredRefreshToken(): string | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage.getItem(STEWARD_REFRESH_TOKEN_KEY);
  } catch {
    return null;
  }
}

export async function syncStewardSessionCookie(
  token: string,
  refreshToken?: string | null,
): Promise<void> {
  const response = await apiFetch(STEWARD_SESSION_ENDPOINT, {
    method: "POST",
    skipAuth: true,
    json: {
      token,
      refreshToken: refreshToken ?? readStoredRefreshToken(),
    },
  });

  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as { error?: string } | null;
    throw new Error(body?.error || "Could not establish an Eliza Cloud session.");
  }

  if (typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent("steward-token-sync", { detail: { token } }));
  }
}
