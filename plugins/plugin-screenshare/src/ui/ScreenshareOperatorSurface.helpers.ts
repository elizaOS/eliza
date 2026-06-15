// Shared data contracts + fetch helpers for the Screenshare view, used by both
// ScreenshareOperatorSurface.tsx (host + connect + TUI components) and the
// `interact` capability handler (ScreenshareOperatorSurface.interact.ts). Kept
// out of the .tsx so that file exports only React components and stays
// Fast-Refresh-compatible in dev.
import { client } from "@elizaos/ui";

export interface Capability {
  available: boolean;
  tool: string;
}

export interface CapabilitiesResponse {
  platform: string;
  capabilities: Record<string, Capability>;
}

export interface PublicSession {
  id: string;
  label: string;
  status: "active" | "stopped";
  createdAt: string;
  updatedAt: string;
  stoppedAt: string | null;
  platform: string;
  frameCount: number;
  inputCount: number;
  lastFrameAt: string | null;
  lastInputAt: string | null;
}

export interface StartSessionResponse {
  session: PublicSession;
  token: string;
  viewerUrl: string;
}

export interface SessionsResponse {
  sessions: PublicSession[];
}

function apiUrl(path: string): string {
  const base = client.getBaseUrl();
  return base ? `${base}${path}` : path;
}

export async function fetchJson<T>(
  path: string,
  init?: RequestInit,
): Promise<T> {
  const token = client.getRestAuthToken();
  const response = await fetch(apiUrl(path), {
    ...init,
    headers: {
      ...(init?.body ? { "Content-Type": "application/json" } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...init?.headers,
    },
  });
  const body = (await response.json().catch(() => null)) as unknown;
  if (!response.ok) {
    const message =
      body &&
      typeof body === "object" &&
      "error" in body &&
      typeof body.error === "string"
        ? body.error
        : `Request failed (${response.status})`;
    throw new Error(message);
  }
  return body as T;
}

export function buildViewerUrl(args: {
  baseUrl?: string;
  sessionId: string;
  token: string;
}): string {
  const params = new URLSearchParams({
    sessionId: args.sessionId,
    token: args.token,
  });
  const base = args.baseUrl?.trim().replace(/\/+$/, "") ?? "";
  if (base) {
    params.set("remoteBase", base);
    return `${base}/api/apps/screenshare/viewer?${params.toString()}`;
  }
  return apiUrl(`/api/apps/screenshare/viewer?${params.toString()}`);
}

export async function loadScreenshareTuiState(): Promise<{
  capabilities: CapabilitiesResponse;
  sessions: SessionsResponse;
}> {
  const [capabilities, sessions] = await Promise.all([
    fetchJson<CapabilitiesResponse>("/api/apps/screenshare/capabilities"),
    fetchJson<SessionsResponse>("/api/apps/screenshare/sessions"),
  ]);
  return { capabilities, sessions };
}
