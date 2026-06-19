import { setTimeout as delay } from "node:timers/promises";
import { getDevCredentials } from "@feed/api";

const DEFAULT_BASE_URL =
  process.env.TEST_API_URL ||
  process.env.TEST_BASE_URL ||
  "http://localhost:3000";

export async function waitForServerAvailability(
  baseUrl: string = DEFAULT_BASE_URL,
  attempts: number = 10,
  timeoutMs: number = 5000,
): Promise<boolean> {
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const response = await fetch(`${baseUrl}/api/health`, {
        signal: AbortSignal.timeout(timeoutMs),
        cache: "no-store",
      });
      if (response.ok) {
        return true;
      }
    } catch {}

    if (attempt < attempts) {
      await delay(1000);
    }
  }

  return false;
}

export async function waitForEndpointAvailability(
  url: string,
  init: RequestInit,
  isAvailable: (response: Response) => boolean,
  attempts: number = 10,
  timeoutMs: number = 5000,
): Promise<boolean> {
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const response = await fetch(url, {
        ...init,
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (isAvailable(response)) {
        return true;
      }
    } catch {}

    if (attempt < attempts) {
      await delay(1000);
    }
  }

  return false;
}

export function requireServer(
  serverAvailable: boolean,
  baseUrl: string = DEFAULT_BASE_URL,
): void {
  if (!serverAvailable) {
    throw new Error(`Integration test requires a live server at ${baseUrl}`);
  }
}

/**
 * Get admin token for integration tests.
 * Checks (in order): explicit env overrides, CI token, dev credentials.
 * Uses the x-dev-admin-token header for authentication.
 */
export function getAdminToken(): string | null {
  // Preserve existing explicit env overrides used by local/staging harnesses
  if (process.env.DEV_ADMIN_TOKEN) return process.env.DEV_ADMIN_TOKEN;
  if (process.env.TEST_ADMIN_TOKEN) return process.env.TEST_ADMIN_TOKEN;
  // CI production mode: dev credentials are disabled, use the CI token
  if (process.env.CI_ADMIN_TOKEN) return process.env.CI_ADMIN_TOKEN;
  // Local development fallback
  return getDevCredentials()?.devAdminToken ?? null;
}

export function requireAuth(
  serverAvailable: boolean,
  devAdminToken: string | null,
  baseUrl: string = DEFAULT_BASE_URL,
): void {
  requireServer(serverAvailable, baseUrl);
  if (!devAdminToken) {
    throw new Error(
      "Integration test requires a dev admin token for authenticated coverage",
    );
  }
}
