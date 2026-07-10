/**
 * `useRealtimeVoiceMint` — resolves the two app-specific inputs the realtime
 * voice session needs from the SAME auth/runtime source the rest of the app
 * uses for /api/v1 calls:
 *   1. the owner agent UUID for the mint (`agentId`), and
 *   2. a consent-nonce fetch (`getConsentNonce`) that POSTs
 *      `/api/v1/voice/session/consent` through `fetchWithCsrf` (the exact same
 *      CSRF/bearer helper every other dashboard `/api/v1` route uses).
 *
 * Agent-id resolution: a realtime session mints against the CLOUD worker route,
 * which requires the caller's dedicated cloud agent UUID. We derive it from the
 * persisted active server (`resolveDedicatedAgentId`), which is the same id the
 * cloud REST adapter base carries. A local/self-hosted runtime has no cloud
 * agent id → `agentId` is null → the realtime path never arms and the mic runs
 * the batch flow unchanged.
 *
 * Consent: `getConsentNonce` calls the consent route on the visible gesture that
 * starts a session. A 404 (feature off) or 503 (consent store not configured)
 * both resolve to null, which the session hook reads as "fall back to batch".
 * The nonce is never fabricated.
 */

import { useCallback, useMemo } from "react";

import { resolveDedicatedAgentId } from "../state/agent-session-recovery";
import { loadPersistedActiveServer } from "../state/persistence";

// NOTE ON MODULE GRAPH: `../api/csrf-client` (the default consent fetch) pulls
// the full native transport chain. We import it LAZILY (dynamic import inside
// `defaultConsentFetch`) so a surface that renders this hook doesn't eagerly
// load that chain, and a test that injects `fetch` never touches it at all.
// `agent-session-recovery` + `persistence` ARE imported statically because the
// agent-id resolution is pure and cheap; a test that injects `resolveAgentId`
// still exercises the real UUID guard on the injected value.

/**
 * The default consent fetch = the same CSRF/bearer helper every other dashboard
 * /api/v1 call uses.
 */
async function defaultConsentFetch(
  url: string,
  init?: RequestInit,
): Promise<Response> {
  const { fetchWithCsrf } = await import("../api/csrf-client");
  return fetchWithCsrf(url, init);
}

/** UUID v-any shape guard so we never mint with a non-UUID id (the route 400s). */
function isUuid(value: string | null | undefined): value is string {
  return (
    typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
      value.trim(),
    )
  );
}

export interface UseRealtimeVoiceMintResult {
  /** Owner agent UUID for the mint, or null when no cloud agent is resolvable. */
  agentId: string | null;
  /**
   * Obtain a one-time consent nonce for a realtime session. Resolves null on a
   * 404/503/any non-200, or a transport failure — the caller then uses batch.
   */
  getConsentNonce: () => Promise<string | null>;
}

/** Response shape of POST /api/v1/voice/session/consent. */
interface ConsentResponse {
  consentNonce?: unknown;
}

export function useRealtimeVoiceMint(options?: {
  /** Injectable fetch (tests). Defaults to the CSRF/bearer dashboard fetch. */
  fetch?: (url: string, init?: RequestInit) => Promise<Response>;
  /** Injectable agent-id resolver (tests). */
  resolveAgentId?: () => string | null;
  /** Consent route path. Default "/api/v1/voice/session/consent". */
  consentPath?: string;
}): UseRealtimeVoiceMintResult {
  const doFetch = options?.fetch ?? defaultConsentFetch;
  const consentPath =
    options?.consentPath ?? "/api/v1/voice/session/consent";

  const agentId = useMemo(() => {
    if (options?.resolveAgentId) {
      const id = options.resolveAgentId();
      return isUuid(id) ? id : null;
    }
    const active = loadPersistedActiveServer();
    if (!active) return null;
    const id = resolveDedicatedAgentId(active);
    return isUuid(id) ? id : null;
    // resolveAgentId identity is stable in practice; the persisted server read
    // is intentionally per-mount (a runtime switch remounts the chat surface).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [options?.resolveAgentId]);

  const getConsentNonce = useCallback(async (): Promise<string | null> => {
    try {
      const res = await doFetch(consentPath, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
      });
      if (!res.ok) return null;
      const json = (await res.json()) as ConsentResponse;
      const nonce = json?.consentNonce;
      return typeof nonce === "string" && nonce.trim() ? nonce : null;
    } catch {
      // Transport/parse failure → no nonce → batch fallback. Never fabricate.
      return null;
    }
  }, [consentPath, doFetch]);

  return { agentId, getConsentNonce };
}
