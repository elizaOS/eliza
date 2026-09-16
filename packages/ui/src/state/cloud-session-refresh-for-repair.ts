/**
 * Silent cloud-session recovery for the agent-subdomain re-pair path (#15132
 * follow-up: the "Open this agent from Eliza Cloud" dead-end).
 *
 * THE BUG THIS CLOSES: a returning PWA user opens the hosted Cloud app
 * directly. Their persisted agent credential is
 * stale (container upgraded / SW-refreshed), so `/api/auth/me` 401s with
 * `remote_auth_required`. The top-level auth gate wants to transparently
 * re-pair, but re-pairing needs a cloud session token, and
 * `getCloudAuthToken()` reads the APP-ORIGIN localStorage mirror — which a
 * cold PWA relaunch may not have. A host-only HttpOnly session cookie can
 * still be present on that same app origin, but nothing was consulting it at
 * the recovery gate, so the
 * user fell straight through to the terminal `CloudHostedAgentAuthNotice`
 * ("Re-open from Eliza Cloud") dead-end instead of a silent re-pair.
 *
 * This module makes the SAME cookie→session recovery that the startup restore
 * path already performs (`resolveRestoredStewardToken`) available at the
 * recovery gate: when there is no app-origin cloud token but a Steward authed
 * cookie exists, refresh the session from the cookie, persist it, and report
 * whether a token is now available. The recovery hook then re-pairs silently;
 * only a genuinely absent/expired cloud session falls through to the notice.
 *
 * SECURITY (auth-adjacent): this NEVER fabricates or bypasses a session. It
 * only exchanges an EXISTING, server-validated HttpOnly refresh cookie for a
 * fresh access token via the canonical Steward refresh endpoint. No cookie →
 * no token → the notice/wall stands exactly as before. It writes only the
 * canonical Steward token key, touching no unrelated agent credential (i.e.
 * it does NOT introduce the over-broad purge that #16673's default did).
 */

import {
  getStewardTabSessionAuthorityCoordinator,
  hasStewardAuthedCookie,
  readStoredStewardToken,
  STEWARD_REFRESH_ENDPOINT,
  type StewardTokenWriteOptions,
  writeStoredStewardToken,
} from "@elizaos/shared/steward-session-client";
import { refreshCloudStewardSession } from "../api/client-cloud";

/** Bounded so the recovery gate can never hang on a slow refresh. */
export const CLOUD_REPAIR_REFRESH_TIMEOUT_MS = 6_000;

export interface EnsureCloudSessionForRepairDeps {
  /** Injected (tests). Defaults to the shared client cookie probe. */
  hasCookie?: (environment?: string | null) => boolean;
  /** Injected (tests). Defaults to the localStorage Steward mirror read. */
  readToken?: () => string | null | undefined;
  /** Injected (tests). Defaults to the canonical Steward refresh. */
  refreshFn?: typeof refreshCloudStewardSession;
  /** Injected (tests). Defaults to the localStorage Steward mirror write. */
  writeToken?: (
    token: string,
    options?: StewardTokenWriteOptions,
  ) => Promise<void> | void;
  /** Lifetime of the UI recovery that will consume the result. */
  signal?: AbortSignal;
  /** Reject a replaced agent/target before publication and continuation. */
  beforePublish?: () => void;
  /** The continuing owner can omit its own legacy re-arm event; canonical publication still fires. */
  emitSyncEvent?: boolean;
  /** Injected (tests). Defaults to the real refresh timeout. */
  timeoutMs?: number;
  /** Injected (tests). Defaults to real setTimeout-based race. */
  raceTimeout?: <T>(p: Promise<T>, ms: number) => Promise<T | null>;
}

function defaultRaceTimeout<T>(p: Promise<T>, ms: number): Promise<T | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), ms);
  });
  return Promise.race([p, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

function resolveRepairRefreshEndpoint(): string | undefined {
  if (typeof window === "undefined") return undefined;
  // Refresh cookies are host-only. Pages proxies this same-origin endpoint to
  // the matching API Worker, preserving the browser cookie boundary.
  return `${window.location.origin}${STEWARD_REFRESH_ENDPOINT}`;
}

/**
 * Ensure an app-origin cloud session token exists for the re-pair exchange,
 * recovering it from the same-origin HttpOnly Eliza Cloud cookie when the
 * localStorage mirror is empty.
 *
 * Returns the usable cloud token, or `null` when none can be recovered (no
 * cookie, refresh failed/timed out, or refresh returned no token). Callers
 * MUST treat `null` as "no cloud session — keep the wall/notice."
 *
 * At most one refresh network call per invocation; the caller gates invocation
 * to once per unauthenticated cycle so there is no refresh loop.
 */
export async function ensureCloudSessionForRepair(
  deps: EnsureCloudSessionForRepairDeps = {},
): Promise<string | null> {
  const {
    hasCookie = hasStewardAuthedCookie,
    readToken = readStoredStewardToken,
    refreshFn = refreshCloudStewardSession,
    writeToken = writeStoredStewardToken,
    timeoutMs = CLOUD_REPAIR_REFRESH_TIMEOUT_MS,
    raceTimeout = defaultRaceTimeout,
  } = deps;

  if (deps.signal?.aborted) return null;

  // Fast path: the app-origin mirror already has a token — nothing to recover.
  const existing = readToken()?.trim();
  if (existing) return existing;

  // No app-origin token. Only this host's HttpOnly session cookie can recover
  // one; without it there is genuinely no cloud session and the notice/wall is
  // the honest surface.
  if (typeof window === "undefined") return null;
  if (!hasCookie()) return null;

  const lifetime = new AbortController();
  const cancel = () => lifetime.abort();
  deps.signal?.addEventListener("abort", cancel, { once: true });
  window.addEventListener("pagehide", cancel);
  try {
    const coordinator = getStewardTabSessionAuthorityCoordinator();
    const expected = coordinator.readSnapshot();
    const recovery = coordinator
      .runExclusive({
        kind: "refresh",
        signal: lifetime.signal,
        expectedToken: expected.token,
        expectedGeneration: expected.generation,
        expectedScope: expected.scope,
        timeoutMs,
        work: async (authority) => {
          const validate = () => {
            authority.revalidate();
            deps.beforePublish?.();
          };
          validate();
          const recovered = await refreshFn({
            endpoint: resolveRepairRefreshEndpoint(),
            authority,
            timeoutMs,
          });
          validate();
          const token = recovered?.token?.trim();
          if (!token) return null;
          await writeToken(token, { authority, beforePublish: validate });
          validate();
          if (
            deps.emitSyncEvent !== false &&
            typeof CustomEvent === "function"
          ) {
            window.dispatchEvent(new CustomEvent("steward-token-sync"));
          }
          return token;
        },
      })
      .catch(() => {
        // error-policy:J4 the recovery result is observed even if an injected
        // UI deadline resolves first; failed work cannot publish a session.
        return null;
      });
    // The UI deadline does not release the underlying coordinator hold: any
    // unabortable transport retains ownership until its actual settlement.
    return await raceTimeout(recovery, timeoutMs);
  } catch {
    // error-policy:J4 failed/absent/cancelled recovery keeps the explicit wall;
    // no fresh authority is borrowed to publish a late result.
    return null;
  } finally {
    lifetime.abort();
    deps.signal?.removeEventListener("abort", cancel);
    window.removeEventListener("pagehide", cancel);
  }
}
