/**
 * Resolves the cloud agent identity and one-time consent required before
 * realtime voice may own the microphone. Self-hosted runtimes stay on batch
 * voice unless an explicit force build also passes its same-origin health
 * probe; failed consent or availability checks never fabricate eligibility.
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
    // error-policy:J4 An unreadable build flag leaves force-arming explicitly disabled.
    return false;
  }
}

// NOTE ON MODULE GRAPH: the default consent fetch pulls the full native/cloud
// transport chain. We import it LAZILY (dynamic import inside
// `defaultConsentFetch`) so a surface that renders this hook doesn't eagerly
// load that chain, and a test that injects `fetch` never touches it at all.
// `agent-session-recovery` + `persistence` ARE imported statically because the
// agent-id resolution is pure and cheap; a test that injects `resolveAgentId`
// still exercises the real UUID guard on the injected value.

/**
 * The default consent fetch shares the voice-session control-plane policy with
 * minting, so both legs always use the same origin and credential.
 */
async function defaultConsentFetch(
  url: string,
  init?: RequestInit,
): Promise<Response> {
  const { fetchVoiceSession } = await import("../voice/voice-session-fetch");
  return fetchVoiceSession(url, init);
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

const DEFAULT_FORCE_PROBE_RETRY_MS = 1_000;

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
    // error-policy:J4 Transport/parse failure selects the existing batch-voice path.
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
    // error-policy:J4 An unreachable probe leaves realtime unavailable to the caller.
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
  /** Retry cadence for a force-arm health probe that has not succeeded yet. */
  probeRetryMs?: number;
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
  const probeRetryMs = options?.probeRetryMs ?? DEFAULT_FORCE_PROBE_RETRY_MS;
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
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    setForceProbeArmed(false);

    const probe = async (): Promise<void> => {
      const available = await probeRealtimeVoiceAvailability(
        doFetch,
        probePath,
      );
      if (cancelled) return;
      if (available) {
        setForceProbeArmed(true);
        return;
      }

      // The local voice gateway is a sibling dev process and can become ready
      // after the renderer mounts. Keep the batch mic authoritative while it
      // is unavailable, but re-probe so a normal startup race recovers without
      // requiring a renderer reload or silently leaving Talk inert forever.
      retryTimer = setTimeout(() => {
        retryTimer = null;
        void probe();
      }, probeRetryMs);
    };
    void probe();

    return () => {
      cancelled = true;
      if (retryTimer !== null) clearTimeout(retryTimer);
    };
  }, [doFetch, forceProbeEligible, probePath, probeRetryMs]);

  const agentId =
    resolvedAgentId ??
    (forceProbeArmed ? REALTIME_FORCE_SENTINEL_AGENT_ID : null);

  const getConsentNonce = useCallback(async (): Promise<string | null> => {
    return fetchConsentNonce(doFetch, consentPath);
  }, [consentPath, doFetch]);

  return { agentId, getConsentNonce };
}
