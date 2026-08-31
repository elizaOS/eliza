/**
 * Resolves the cloud agent identity and one-time consent required before
 * realtime voice may own the microphone. A production self-hosted build may
 * arm only after its paired same-origin runtime proves the voice-session
 * contract for the active conversation; failed consent or availability checks
 * never fabricate eligibility.
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

/** Read the production self-hosted realtime capability stamp. */
export function isRealtimeVoiceSelfHostedEnabled(): boolean {
  try {
    const raw = import.meta.env?.VITE_VOICE_REALTIME_SELF_HOSTED as unknown;
    if (typeof raw !== "string") return false;
    const value = raw.trim().toLowerCase();
    return (
      value === "1" || value === "true" || value === "yes" || value === "on"
    );
  } catch {
    // error-policy:J4 An unreadable build stamp leaves self-hosted realtime disabled.
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
  expectedConversationId: string | null,
): Promise<boolean> {
  try {
    const res = await doFetch(probePath, {
      method: "GET",
      redirect: "error",
    });
    if (res.status !== 200 || res.redirected || res.type === "opaqueredirect") {
      return false;
    }
    const mediaType = res.headers
      .get("content-type")
      ?.split(";", 1)[0]
      ?.trim()
      .toLowerCase();
    if (mediaType !== "application/json") return false;
    const body: unknown = await res.json();
    const ready =
      typeof body === "object" &&
      body !== null &&
      !Array.isArray(body) &&
      (body as { ready?: unknown }).ready === true;
    if (!ready) return false;
    return (
      expectedConversationId === null ||
      (body as { conversationId?: unknown }).conversationId ===
        expectedConversationId
    );
  } catch {
    // error-policy:J4 An unreachable or malformed probe leaves realtime unavailable to the caller.
    return false;
  }
}

function normalizeRealtimeConversationId(
  value: string | null | undefined,
): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  return normalized && normalized.length <= 128 ? normalized : null;
}

function conversationScopedProbePath(
  probePath: string,
  conversationId: string,
): string {
  const separator = probePath.includes("?") ? "&" : "?";
  return `${probePath}${separator}conversationId=${encodeURIComponent(conversationId)}`;
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
   * Active conversation identity. Production self-hosted eligibility is bound
   * to this exact value so a gateway pinned to another conversation cannot arm
   * realtime and take the microphone before refusing the mint.
   */
  conversationId?: string | null;
  /**
   * Injectable force-arm flag (tests). Defaults to the VITE-side
   * `VITE_VOICE_REALTIME_FORCE` read. When true and normal resolution yields
   * null, `agentId` falls back to the sentinel only after the non-consuming
   * health probe succeeds. Never overrides a real resolved agent id.
   */
  forceEnabled?: boolean;
  /** Production self-hosted capability stamp (tests may inject it). */
  selfHostedEnabled?: boolean;
  /** Whether the selected runtime is a paired self-hosted remote. */
  resolveSelfHostedRuntime?: () => boolean;
}): UseRealtimeVoiceMintResult {
  const doFetch = options?.fetch ?? defaultConsentFetch;
  const consentPath = options?.consentPath ?? "/api/v1/voice/session/consent";
  const probePath = options?.probePath ?? "/api/v1/voice/session/health";
  const forceEnabled = options?.forceEnabled ?? isRealtimeVoiceForceEnabled();
  const selfHostedEnabled =
    options?.selfHostedEnabled ?? isRealtimeVoiceSelfHostedEnabled();
  const persistedActiveServer = options?.resolveAgentId
    ? null
    : loadPersistedActiveServer();

  const resolvedAgentId = useMemo(() => {
    // A real, resolvable cloud agent id ALWAYS wins over the sentinel.
    if (options?.resolveAgentId) {
      const id = options.resolveAgentId();
      return isUuid(id) ? id : null;
    }
    const id = persistedActiveServer
      ? resolveDedicatedAgentId(persistedActiveServer)
      : null;
    return isUuid(id) ? id : null;
    // resolveAgentId identity is stable in practice; the persisted server read
    // is intentionally per-mount (a runtime switch remounts the chat surface).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [options?.resolveAgentId, persistedActiveServer]);

  const selfHostedRuntime = options?.resolveSelfHostedRuntime
    ? options.resolveSelfHostedRuntime()
    : persistedActiveServer?.kind === "remote";

  const probeConversationId = normalizeRealtimeConversationId(
    options?.conversationId,
  );
  const selfHostedProbeEligible = Boolean(
    selfHostedEnabled && selfHostedRuntime && probeConversationId,
  );
  const availabilityProbeEligible =
    !resolvedAgentId && (forceEnabled || selfHostedProbeEligible);
  const availabilityProbePath =
    selfHostedProbeEligible && probeConversationId
      ? conversationScopedProbePath(probePath, probeConversationId)
      : probePath;
  const availabilityProbeKey = availabilityProbeEligible
    ? availabilityProbePath
    : null;
  const expectedProbeConversationId = selfHostedProbeEligible
    ? probeConversationId
    : null;
  const [armedProbeKey, setArmedProbeKey] = useState<string | null>(null);

  useEffect(() => {
    if (!availabilityProbeKey) {
      setArmedProbeKey(null);
      return;
    }

    let cancelled = false;
    setArmedProbeKey(null);
    void probeRealtimeVoiceAvailability(
      doFetch,
      availabilityProbeKey,
      expectedProbeConversationId,
    ).then((available) => {
      if (!cancelled) {
        setArmedProbeKey(available ? availabilityProbeKey : null);
      }
    });

    return () => {
      cancelled = true;
    };
  }, [availabilityProbeKey, doFetch, expectedProbeConversationId]);

  const availabilityProbeArmed =
    availabilityProbeKey !== null && armedProbeKey === availabilityProbeKey;

  const agentId =
    resolvedAgentId ??
    (availabilityProbeArmed ? REALTIME_FORCE_SENTINEL_AGENT_ID : null);

  const getConsentNonce = useCallback(async (): Promise<string | null> => {
    return fetchConsentNonce(doFetch, consentPath);
  }, [consentPath, doFetch]);

  return { agentId, getConsentNonce };
}
