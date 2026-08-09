/**
 * Control-plane routing for the realtime voice session routes (#18xxx,
 * LOGIN-FLOW-AUDIT 2026-08-09 cliff #3).
 *
 * The consent (`POST /api/v1/voice/session/consent`), mint
 * (`POST /api/v1/voice/session`) and force-arm health probe routes exist ONLY
 * on the Eliza Cloud control-plane Worker (`api.elizacloud.ai` /
 * `api-staging.elizacloud.ai`) — they need the Worker's DB repositories,
 * consent-nonce store, and JWT signer. They are NOT mounted in agent
 * containers, and the dedicated-agent proxy forwards unknown `/api/*` paths
 * into the container, which 404s them.
 *
 * The voice client, however, issues those calls as RELATIVE paths through
 * `fetchWithCsrf`, which resolves them against the ACTIVE AGENT base
 * (`resolveApiUrl`). On the dedicated pairing path the active base is the
 * per-agent subdomain (`https://<agentId>.staging.elizacloud.ai`), so a fresh
 * user's first voice tap POSTed consent to the agent container and got 404 ×3
 * ("Cartesia voice could not confirm microphone consent").
 *
 * This module derives the correct control-plane origin for the managed-cloud
 * agent bases, mirroring the batch-voice precedent in
 * `shared-runtime-voice.ts` (#15395/#16116):
 *   - dedicated base  `https://<id>.elizacloud.ai`          → `https://api.elizacloud.ai`
 *   - dedicated base  `https://<id>.staging.elizacloud.ai`  → `https://api-staging.elizacloud.ai`
 *   - shared base     `<worker>/api/v1/eliza/agents/<id>`   → `<worker>` (path stripped)
 *   - anything else (self-hosted, standalone dev adapter, control-plane
 *     same-origin, blank) → null, and callers keep the EXISTING relative
 *     same-origin paths unchanged.
 *
 * Auth for the cross-origin control-plane call is the canonical Steward
 * session JWT (`readStoredStewardToken`), attached as `Authorization: Bearer`
 * — the same pattern `local-asr-transcribe.ts` uses for its direct Worker
 * route. Relying on `fetchWithCsrf`'s boot-config `apiToken` would send the
 * AGENT pair token to the Worker, which cannot authenticate it.
 */

import { readStoredStewardToken } from "@elizaos/shared/steward-session-client";

import {
  DEFAULT_DIRECT_CLOUD_API_BASE_URL,
  STAGING_DIRECT_CLOUD_API_BASE_URL,
} from "../api/direct-cloud-endpoints";
import { isDedicatedCloudAgentBase } from "../utils/cloud-agent-base";
import { getElizaApiBase } from "../utils/eliza-globals";
import { sharedRuntimeVoiceOrigin } from "./shared-runtime-voice";

const STAGING_DEDICATED_SUFFIX = ".staging.elizacloud.ai";

/**
 * The control-plane Worker origin that serves the realtime voice-session
 * routes for a given ACTIVE agent api base, or `null` when the base is not a
 * managed Eliza Cloud agent base (self-hosted / standalone / same-origin
 * control-plane — the relative path is already correct there).
 */
export function realtimeVoiceControlPlaneOrigin(
  apiBase: string | null | undefined,
): string | null {
  const raw = apiBase?.trim();
  if (!raw) return null;

  // Shared-tier managed base: the worker origin is the base with the
  // `/api/v1/eliza/agents/<id>` tail stripped (exact #15395 derivation).
  const sharedOrigin = sharedRuntimeVoiceOrigin(raw);
  if (sharedOrigin) return sharedOrigin;

  // Dedicated managed base: map the per-agent subdomain to its environment's
  // API host. The environment is encoded in the host itself
  // (`.staging.elizacloud.ai` vs `.elizacloud.ai`), so this needs no config.
  if (isDedicatedCloudAgentBase(raw)) {
    try {
      const host = new URL(raw).hostname.toLowerCase();
      return host.endsWith(STAGING_DEDICATED_SUFFIX)
        ? STAGING_DIRECT_CLOUD_API_BASE_URL
        : DEFAULT_DIRECT_CLOUD_API_BASE_URL;
    } catch {
      // error-policy:J3 an unparseable base cannot be proven managed-cloud;
      // fall through to the unchanged same-origin path (fail-closed to the
      // pre-existing behavior).
      return null;
    }
  }

  return null;
}

/**
 * Resolve a realtime voice-session route path (`/api/v1/voice/session[...]`)
 * for the CURRENT active agent base: an absolute control-plane URL on managed
 * cloud bases, the unchanged relative path everywhere else.
 */
export function resolveRealtimeVoiceSessionUrl(
  path: string,
  apiBase: string | null | undefined = getElizaApiBase(),
): string {
  const origin = realtimeVoiceControlPlaneOrigin(apiBase);
  if (!origin) return path;
  const suffix = path.startsWith("/") ? path : `/${path}`;
  return `${origin.replace(/\/+$/, "")}${suffix}`;
}

/**
 * The consent/mint/probe fetch. Same CSRF/bearer dashboard helper as before
 * (lazily imported to keep the native transport chain off this module graph),
 * plus the Steward session bearer when the request targets a cross-origin
 * control-plane URL — `fetchWithCsrf` only knows the boot-config apiToken,
 * which on a dedicated pairing is the AGENT token the Worker rejects.
 */
export async function realtimeVoiceSessionFetch(
  url: string,
  init?: RequestInit,
): Promise<Response> {
  const { fetchWithCsrf } = await import("../api/csrf-client");
  if (/^https?:\/\//i.test(url)) {
    const stewardToken = readStoredStewardToken()?.trim();
    if (stewardToken) {
      const headers = new Headers(init?.headers);
      if (!headers.has("Authorization")) {
        headers.set("Authorization", `Bearer ${stewardToken}`);
      }
      return fetchWithCsrf(url, { ...init, headers });
    }
  }
  return fetchWithCsrf(url, init);
}
