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
 * FORCE-ARM OVERRIDE (`VITE_VOICE_REALTIME_FORCE`, default OFF): a build can opt
 * in to arming realtime even when no cloud agent id is resolvable. This exists
 * for a same-origin standalone voice backend (e.g. sol-dev) whose mint binds a
 * FIXED server-side identity and IGNORES the client `agentId` — so a sentinel
 * UUID is a safe stand-in there (the server never reads it). The override ONLY
 * substitutes the sentinel WHEN the normal resolution yields null AND a
 * same-origin health probe succeeds; a real cloud agent id always wins. Probe
 * failure keeps `agentId` null, so an absent/broken/permission-denied backend
 * falls straight back to batch before realtime owns the mic. With the flag OFF
 * the behavior is byte-for-byte the current behavior: null agentId on a
 * self-hosted runtime, no probe change.
 *
 * Consent: `getConsentNonce` calls the consent route on the visible gesture that
 * starts a session. A 404 (feature off) or 503 (consent store not configured)
 * both resolve to null, which the session hook reads as "fall back to batch".
 * The nonce is never fabricated.
 */

import { useCallback, useEffect, useMemo, useState } from "react";

import { resolveDedicatedAgentId } from "../state/agent-session-recovery";
import { loadPersistedActiveServer } from "../state/persistence";

/**
 * Sentinel agent UUID used ONLY when the force-arm override is on and no real
 * cloud agent id is resolvable. The standalone voice backend binds its OWN fixed
 * identity server-side and ignores the client `agentId`, so this value is never
 * trusted as an identity — it exists solely to satisfy the UUID shape guard and
 * the `hasIds` availability gate so the consent-probe can decide arming. It is a
 * deliberately recognizable valid v4-shaped UUID (not a real agent).
 */
export const REALTIME_FORCE_SENTINEL_AGENT_ID =
  "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";

/**
 * Read the VITE-side force-arm flag. Vite statically replaces `import.meta.env.
 * VITE_*` at build time, so this MUST be a literal member read (not a dynamic
 * key). Absent/blank/anything-but-truthy ⇒ OFF, so no build arms via the
 * sentinel unless it explicitly opts in. Mirrors `isRealtimeVoiceFlagEnabled`.
 */
export function isRealtimeVoiceForceEnabled(): boolean {
  try {
    const raw = import.meta.env?.VITE_VOICE_REALTIME_FORCE as unknown;
    if (typeof raw !== "string") return false;
    const v = raw.trim().toLowerCase();
    return v === "1" || v === "true" || v === "yes" || v === "on";
  } catch {
    return false;
  }
}

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

async function fetchConsentNonce(
  doFetch: (url: string, init?: RequestInit) => Promise<Response>,
  consentPath: string,
): Promise<string | null> {
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
}

async function probeRealtimeVoiceAvailability(
  doFetch: (url: string, init?: RequestInit) => Promise<Response>,
  probePath: string,
): Promise<boolean> {
  try {
    const res = await doFetch(probePath, { method: "GET" });
    return res.ok;
  } catch {
    return false;
  }
}

export function useRealtimeVoiceMint(options?: {
  /** Injectable fetch (tests). Defaults to the CSRF/bearer dashboard fetch. */
  fetch?: (url: string, init?: RequestInit) => Promise<Response>;
  /** Injectable agent-id resolver (tests). */
  resolveAgentId?: () => string | null;
  /** Consent route path. Default "/api/v1/voice/session/consent". */
  consentPath?: string;
  /** Non-consuming availability probe path for force-arm builds. */
  probePath?: string;
  /**
   * Injectable force-arm flag (tests). Defaults to the VITE-side
   * `VITE_VOICE_REALTIME_FORCE` read. When true and normal resolution yields
   * null, `agentId` falls back to the sentinel only after the non-consuming
   * health probe succeeds. Never overrides a real resolved agent id.
   */
  forceEnabled?: boolean;
}): UseRealtimeVoiceMintResult {
  const doFetch = options?.fetch ?? defaultConsentFetch;
  const consentPath = options?.consentPath ?? "/api/v1/voice/session/consent";
  const probePath = options?.probePath ?? "/api/v1/voice/session/health";
  const forceEnabled = options?.forceEnabled ?? isRealtimeVoiceForceEnabled();

  const resolvedAgentId = useMemo(() => {
    // A real, resolvable cloud agent id ALWAYS wins over the sentinel.
    if (options?.resolveAgentId) {
      const id = options.resolveAgentId();
      return isUuid(id) ? id : null;
    }
    const active = loadPersistedActiveServer();
    const id = active ? resolveDedicatedAgentId(active) : null;
    return isUuid(id) ? id : null;
    // resolveAgentId identity is stable in practice; the persisted server read
    // is intentionally per-mount (a runtime switch remounts the chat surface).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [options?.resolveAgentId]);

  const forceProbeEligible = forceEnabled && !resolvedAgentId;
  const [forceProbeArmed, setForceProbeArmed] = useState(false);

  useEffect(() => {
    if (!forceProbeEligible) {
      setForceProbeArmed(false);
      return;
    }

    let cancelled = false;
    setForceProbeArmed(false);
    void probeRealtimeVoiceAvailability(doFetch, probePath).then(
      (available) => {
        if (!cancelled) setForceProbeArmed(available);
      },
    );

    return () => {
      cancelled = true;
    };
  }, [doFetch, forceProbeEligible, probePath]);

  const agentId =
    resolvedAgentId ??
    (forceProbeArmed ? REALTIME_FORCE_SENTINEL_AGENT_ID : null);

  const getConsentNonce = useCallback(async (): Promise<string | null> => {
    return fetchConsentNonce(doFetch, consentPath);
  }, [consentPath, doFetch]);

  return { agentId, getConsentNonce };
}
