/**
 * Routes realtime voice-session control traffic to the selected runtime or the
 * Eliza Cloud control plane. Cloud sessions use the Steward credential rather
 * than the dedicated agent token, while self-hosted sessions retain the normal
 * dashboard transport.
 */

import { readStoredStewardToken } from "@elizaos/shared/steward-session-client";
import { CSRF_HEADER_NAME } from "../api/auth/sessions";
import {
  readCsrfTokenFromCookie,
  requestViaAgentTransport,
} from "../api/csrf-client";
import { loadPersistedActiveServer } from "../state/persistence";
import { configuredCloudVoiceOrigin } from "./shared-runtime-voice";

function cloudVoiceSessionUrl(path: string): string {
  const origin = configuredCloudVoiceOrigin();
  if (!origin) {
    throw new Error("Eliza Cloud voice-session origin is not configured");
  }
  return `${origin.replace(/\/+$/, "")}${path}`;
}

/**
 * Fetch a consent, health, or mint route without leaking an agent-local bearer
 * to the Cloud control plane. An explicit caller Authorization header remains
 * authoritative for non-dashboard hosts and tests.
 */
export async function fetchVoiceSession(
  path: string,
  init: RequestInit = {},
): Promise<Response> {
  if (!path.startsWith("/") || path.startsWith("//")) {
    throw new Error("Voice-session requests require a relative API path");
  }

  const activeServer = loadPersistedActiveServer();
  if (activeServer?.kind !== "cloud") {
    const { fetchWithCsrf } = await import("../api/csrf-client");
    const headers = new Headers(init.headers);
    const accessToken =
      activeServer?.kind === "remote"
        ? activeServer.accessToken?.trim()
        : undefined;
    if (accessToken && !headers.has("Authorization")) {
      headers.set("Authorization", `Bearer ${accessToken}`);
    }
    return fetchWithCsrf(path, { ...init, headers });
  }

  const headers = new Headers(init.headers);
  const method = (init.method ?? "GET").toUpperCase();
  if (method === "POST") {
    const csrfToken = readCsrfTokenFromCookie();
    if (csrfToken) headers.set(CSRF_HEADER_NAME, csrfToken);
  }

  const stewardToken = readStoredStewardToken()?.trim();
  if (stewardToken && !headers.has("Authorization")) {
    headers.set("Authorization", `Bearer ${stewardToken}`);
  }

  return requestViaAgentTransport(cloudVoiceSessionUrl(path), {
    ...init,
    credentials: "include",
    headers,
  });
}
