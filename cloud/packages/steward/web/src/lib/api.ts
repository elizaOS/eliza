import { StewardClient } from "./steward-client";

export const API_URL = process.env.NEXT_PUBLIC_STEWARD_API_URL || "https://api.steward.fi";

let _apiKey = "";
let _tenantId = "";

export function setCredentials(tenantId: string, apiKey: string) {
  _tenantId = tenantId;
  _apiKey = apiKey;
  _steward = new StewardClient({
    baseUrl: API_URL,
    apiKey: _apiKey,
    tenantId: _tenantId,
  });
}

export function setAuthToken(token: string) {
  _steward = new StewardClient({
    baseUrl: API_URL,
    authToken: token,
  });
}

/**
 * Try to read the JWT from localStorage on module load (client-side only).
 * This ensures the API client is authenticated immediately on page refresh,
 * without waiting for React to hydrate and sync the token.
 */
function getInitialToken(): string | undefined {
  if (typeof window === "undefined") return undefined;
  try {
    return localStorage.getItem("steward_session_token") ?? undefined;
  } catch {
    return undefined;
  }
}

const initialToken = getInitialToken();

let _steward = initialToken
  ? new StewardClient({ baseUrl: API_URL, authToken: initialToken })
  : new StewardClient({
      baseUrl: API_URL,
      apiKey: _apiKey,
      tenantId: _tenantId,
    });

// Proxy getter so components always get the latest client instance
export const steward = new Proxy({} as StewardClient, {
  get(_target, prop) {
    return (_steward as unknown as Record<string | symbol, unknown>)[prop];
  },
});

export { _apiKey as API_KEY, _tenantId as TENANT_ID };
