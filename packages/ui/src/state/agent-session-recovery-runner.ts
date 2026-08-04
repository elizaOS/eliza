/**
 * Executes post-upgrade agent-session recovery (#15132): refresh a stale
 * dedicated-agent credential by re-running the cloud pairing exchange.
 *
 * This reuses the exact server-side exchange that first-pairing and the
 * "Open Web UI" popup use, `POST /api/v1/eliza/agents/:id/pairing-token`
 * returns a one-time `<agent>/pair?token=…` `redirectUrl`; the agent's `/pair`
 * relay consumes the token, pins the fresh API key into sessionStorage + the
 * boot-config singleton, and redirects to `/`. Browser shells can still hand
 * off to that relay. Capacitor native shells must not navigate their main
 * WebView to the remote agent origin, because the native bridge is injected
 * only for the app origin; those callers consume the returned `/pair` token
 * in-process instead (#15483).
 *
 * SECURITY NOTE (auth-adjacent): no auth is bypassed or weakened. The pairing
 * token is minted server-side ONLY for a caller holding a valid cloud session;
 * a 401 becomes Cloud reauthentication, while forbidden/account/agent failures
 * preserve Cloud auth and route to management. Self-hosted callers retain their
 * owner-password boundary.
 */

import {
  CloudPairExchangeError,
  exchangeAuthenticatedNativeCloudPairToken,
  persistCloudPairApiToken,
} from "../components/auth/CloudPairRelay";

const MAX_PAIRING_WAIT_MS = 120_000;
const DEFAULT_RETRY_AFTER_MS = 5_000;

interface PairingTokenResponse {
  data?: {
    redirectUrl?: string;
    retryAfterMs?: number;
    status?: string;
    message?: string;
  };
  error?: string;
}

export type AgentSessionRecoveryResult =
  | { ok: true; redirectUrl: string; mode: "navigate" | "in-process" }
  | {
      ok: false;
      reason:
        | "not-ready"
        | "unauthorized"
        | "manage-required"
        | "cancelled"
        | "error";
      message: string;
    };

export interface RunAgentSessionRecoveryDeps {
  /** Cloud control-plane base (boot config `cloudApiBase`). */
  cloudApiBase: string;
  /** The dedicated agent to re-pair with. */
  agentId: string;
  /** Cloud session token (Steward JWT) authorizing the pairing-token mint. */
  cloudToken: string;
  /** Injected fetch (tests). Defaults to global `fetch`. */
  fetchFn?: typeof fetch;
  /** Injected sleep (tests). Defaults to real setTimeout. */
  sleepFn?: (ms: number, signal?: AbortSignal) => Promise<void>;
  /** Injected clock (tests). Defaults to `Date.now`. */
  nowFn?: () => number;
  /** Cancels mint polling and native exchange when the owning UI cycle ends. */
  signal?: AbortSignal;
  /** Navigate the current window to the `/pair` relay. Injected in tests. */
  navigate: (url: string) => void;
  /**
   * Consume the returned `/pair?token=…` exchange inside the current app origin
   * instead of navigating to the remote relay. Required for Capacitor native
   * WebViews, where remote-origin navigation loses the native bridge.
   */
  consumeRedirectInProcess?: boolean;
  /** Injected authenticated native pair-token exchange (tests). */
  exchangePairToken?: (
    token: string,
    binding: {
      cloudToken: string;
      agentId: string;
      expectedOrigin: string;
      signal?: AbortSignal;
    },
  ) => Promise<string>;
  /** Injected API-key persistence (tests). Defaults to CloudPairRelay's persistence. */
  persistPairApiToken?: (apiToken: string, agentId: string) => void;
  /**
   * OPT-IN purge for terminal mint/exchange outcomes (#16666). Those outcomes
   * alone prove nothing about the durable agent bearer, so there is
   * deliberately NO default: only a caller that independently observed the
   * adopted dedicated-agent bearer rejected (for example `/api/auth/me` 401
   * `remote_auth_required`) may supply a purge. It should be
   * `clearStalePairCredentialsForAgent(agentId)` so deletion stays scoped to
   * the proven credential. Generic pairing callers omit it.
   */
  clearStalePairCredentials?: () => void;
  /** Rejects any late response or side effect that belongs to an old target. */
  isRecoveryTargetCurrent?: () => boolean;
  /**
   * Atomically commit an in-process bearer to every caller-owned store. When
   * provided, this replaces the default persistence + callback pair.
   */
  commitPairedInProcess?: (apiToken: string) => void | Promise<void>;
  /** Optional callback after an in-process pair succeeds. */
  onPairedInProcess?: (apiToken: string) => void | Promise<void>;
}

const realSleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve) => {
    if (signal?.aborted) {
      resolve();
      return;
    }
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      signal?.removeEventListener("abort", finish);
      resolve();
    };
    const timeout = setTimeout(finish, ms);
    signal?.addEventListener("abort", finish, { once: true });
  });

const cancelledResult = (): AgentSessionRecoveryResult => ({
  ok: false,
  reason: "cancelled",
  message: "Agent session recovery was cancelled",
});

/** Only absolute http(s) URLs are safe full-page navigation targets. */
function isSafeRedirectUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    return parsed.protocol === "https:" || parsed.protocol === "http:";
  } catch {
    // error-policy:J3 malformed dependency URLs fail the navigation allowlist.
    return false;
  }
}

function retryAfterMs(res: Response, data: PairingTokenResponse): number {
  const fromBody = data.data?.retryAfterMs;
  if (typeof fromBody === "number" && fromBody > 0) return fromBody;

  const retryAfter = Number(res.headers.get("Retry-After"));
  if (Number.isFinite(retryAfter) && retryAfter > 0) return retryAfter * 1000;

  return DEFAULT_RETRY_AFTER_MS;
}

function pairTokenFromRedirectUrl(redirectUrl: string): string | null {
  try {
    const parsed = new URL(redirectUrl);
    if (parsed.pathname.replace(/\/+$/, "") !== "/pair") return null;
    return parsed.searchParams.get("token")?.trim() || null;
  } catch {
    // error-policy:J3 malformed dependency URLs cannot yield a pairing token.
    return null;
  }
}

function classifyNativePairExchangeError(
  error: unknown,
): Extract<AgentSessionRecoveryResult, { ok: false }> {
  const message = error instanceof Error ? error.message : String(error);
  if (!(error instanceof CloudPairExchangeError)) {
    return { ok: false, reason: "error", message };
  }

  if (
    error.code === "cloud_auth_required" ||
    error.code === "authentication_required" ||
    (!error.code && error.status === 401)
  ) {
    return { ok: false, reason: "unauthorized", message };
  }

  if (
    error.code === "sandbox_credential_unavailable" ||
    error.code === "access_denied" ||
    (!error.code && error.status === 403)
  ) {
    return { ok: false, reason: "manage-required", message };
  }

  return { ok: false, reason: "error", message };
}

/**
 * Poll the cloud pairing-token endpoint until it returns a redirect. Browsers
 * navigate through `/pair`; native callers consume its one-time token
 * in-process, install the bearer, and re-probe auth. Returns a classified
 * failure when the agent never becomes ready, Cloud rejects authentication,
 * management is required, or a transient request fails.
 */
export async function runAgentSessionRecovery(
  deps: RunAgentSessionRecoveryDeps,
): Promise<AgentSessionRecoveryResult> {
  const {
    cloudApiBase,
    agentId,
    cloudToken,
    navigate,
    consumeRedirectInProcess = false,
    exchangePairToken = (token, binding) =>
      exchangeAuthenticatedNativeCloudPairToken(token, {
        ...binding,
        cloudApiBase,
      }),
    persistPairApiToken = persistCloudPairApiToken,
    clearStalePairCredentials,
    isRecoveryTargetCurrent,
    commitPairedInProcess,
    onPairedInProcess,
    fetchFn = fetch,
    sleepFn = realSleep,
    nowFn = Date.now,
    signal,
  } = deps;

  const base = cloudApiBase.replace(/\/+$/, "");
  const url = `${base}/api/v1/eliza/agents/${encodeURIComponent(
    agentId,
  )}/pairing-token`;

  const deadline = nowFn() + MAX_PAIRING_WAIT_MS;
  while (nowFn() < deadline) {
    if (signal?.aborted || isRecoveryTargetCurrent?.() === false) {
      return cancelledResult();
    }
    let res: Response;
    try {
      res = await fetchFn(url, {
        method: "POST",
        headers: { Authorization: `Bearer ${cloudToken}` },
        signal,
      });
    } catch (err) {
      if (signal?.aborted) return cancelledResult();
      // error-policy:J4 a transient control-plane request failure becomes a
      // non-destructive retry result; the valid Cloud token is preserved.
      return {
        ok: false,
        reason: "error",
        message: err instanceof Error ? err.message : String(err),
      };
    }

    // error-policy:J3 malformed dependency JSON is converted to the route's
    // explicit unknown-error result rather than escaping the recovery runner.
    const data = (await res
      .json()
      .catch(() => ({ error: "Unknown error" }))) as PairingTokenResponse;
    if (signal?.aborted || isRecoveryTargetCurrent?.() === false) {
      return cancelledResult();
    }

    if (res.status === 202) {
      const remainingMs = Math.max(0, deadline - nowFn());
      const waitMs = Math.min(retryAfterMs(res, data), remainingMs);
      if (signal) {
        await sleepFn(waitMs, signal);
      } else {
        await sleepFn(waitMs);
      }
      if (signal?.aborted) return cancelledResult();
      continue;
    }

    if (res.status === 401) {
      // Cloud rejected the credential, so the caller may require a fresh login.
      // The purge remains opt-in: this response proves only the STEWARD
      // credential was refused; callers that separately observed the adopted
      // agent bearer fail may remove that scoped credential (#16666).
      // Network-shaped failures deliberately do not reach this branch.
      clearStalePairCredentials?.();
      return {
        ok: false,
        reason: "unauthorized",
        message: data.error || `Unauthorized (HTTP ${res.status})`,
      };
    }

    const requiresCloudManagement =
      res.status === 402 ||
      res.status === 403 ||
      res.status === 404 ||
      data.data?.status === "error";
    if (requiresCloudManagement) {
      // These responses prove the account/agent needs attention, not that the
      // Cloud bearer is invalid. Preserve Cloud auth and route the user to the
      // management surface. The opt-in agent-bearer purge is still safe because
      // the caller independently observed that dedicated bearer rejected.
      clearStalePairCredentials?.();
      return {
        ok: false,
        reason: "manage-required",
        message:
          data.error ||
          data.data?.message ||
          `Cloud agent requires attention (HTTP ${res.status})`,
      };
    }

    if (!res.ok) {
      return {
        ok: false,
        reason: "error",
        message:
          data.error || `Failed to generate pairing token (HTTP ${res.status})`,
      };
    }

    const redirectUrl = data.data?.redirectUrl;
    if (redirectUrl) {
      // Defense-in-depth (auth-adjacent): only navigate to an absolute http(s)
      // URL. The value comes from the authenticated cloud response, but a
      // full-page navigation must never honor a `javascript:`/`data:` or
      // otherwise malformed target.
      if (!isSafeRedirectUrl(redirectUrl)) {
        return {
          ok: false,
          reason: "error",
          message: "Pairing token returned an unsafe redirect URL",
        };
      }
      if (consumeRedirectInProcess) {
        const pairToken = pairTokenFromRedirectUrl(redirectUrl);
        if (!pairToken) {
          // A managed URL without a pair token means the sandbox has no usable
          // ELIZA_API_TOKEN. Reloading cannot repair that configuration; keep
          // Cloud auth and send the user to the management recovery surface.
          clearStalePairCredentials?.();
          return {
            ok: false,
            reason: "manage-required",
            message: "Pairing token returned a redirect without a pair token",
          };
        }
        try {
          const apiToken = await exchangePairToken(pairToken, {
            cloudToken,
            agentId,
            expectedOrigin: new URL(redirectUrl).origin,
            ...(signal ? { signal } : {}),
          });
          if (signal?.aborted || isRecoveryTargetCurrent?.() === false) {
            return cancelledResult();
          }
          if (commitPairedInProcess) {
            await commitPairedInProcess(apiToken);
          } else {
            persistPairApiToken(apiToken, agentId);
            await onPairedInProcess?.(apiToken);
          }
          return { ok: true, redirectUrl, mode: "in-process" };
        } catch (err) {
          if (signal?.aborted || isRecoveryTargetCurrent?.() === false) {
            return cancelledResult();
          }
          // error-policy:J4 native exchange failures retain the server's typed
          // recovery category. Unknown/network/storage failures stay retryable
          // and cannot invalidate the Cloud credential.
          const failure = classifyNativePairExchangeError(err);
          if (
            failure.reason === "unauthorized" ||
            failure.reason === "manage-required"
          ) {
            clearStalePairCredentials?.();
          }
          return failure;
        }
      }

      // Hand off to the /pair relay in the current window: it pins the fresh
      // credential and redirects to `/`, clearing the stale-credential 401 loop.
      if (signal?.aborted || isRecoveryTargetCurrent?.() === false) {
        return cancelledResult();
      }
      navigate(redirectUrl);
      return { ok: true, redirectUrl, mode: "navigate" };
    }

    return {
      ok: false,
      reason: "error",
      message: "No redirect URL returned from pairing token endpoint",
    };
  }

  return {
    ok: false,
    reason: "not-ready",
    message: "Agent did not become ready in time",
  };
}
