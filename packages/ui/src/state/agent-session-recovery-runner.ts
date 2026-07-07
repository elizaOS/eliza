/**
 * Executes post-upgrade agent-session recovery (#15132): refresh a stale
 * dedicated-agent credential by re-running the cloud pairing exchange in the
 * CURRENT window, then land back on `/` re-paired.
 *
 * This reuses the exact server-side exchange that first-pairing and the
 * "Open Web UI" popup use, `POST /api/v1/eliza/agents/:id/pairing-token`
 * returns a one-time `<agent>/pair?token=…` `redirectUrl`; the agent's `/pair`
 * relay consumes the token, pins the fresh API key into sessionStorage + the
 * boot-config singleton, and redirects to `/`. Because the dead-end app is
 * ALREADY on the agent, we navigate the current window rather than opening a
 * popup (no popup-blocker dependency, no second tab).
 *
 * SECURITY NOTE (auth-adjacent): no auth is bypassed or weakened. The pairing
 * token is minted server-side ONLY for a caller holding a valid cloud session;
 * an unauthenticated caller gets a 401/403 here and falls through to the
 * password wall exactly as before.
 */

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
  | { ok: true; redirectUrl: string }
  | { ok: false; reason: "not-ready" | "unauthorized" | "error"; message: string };

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
  sleepFn?: (ms: number) => Promise<void>;
  /** Injected clock (tests). Defaults to `Date.now`. */
  nowFn?: () => number;
  /** Navigate the current window to the `/pair` relay. Injected in tests. */
  navigate: (url: string) => void;
}

const realSleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Only absolute http(s) URLs are safe full-page navigation targets. */
function isSafeRedirectUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    return parsed.protocol === "https:" || parsed.protocol === "http:";
  } catch {
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

/**
 * Poll the cloud pairing-token endpoint until it returns a `/pair` redirect,
 * then navigate the current window there. The `/pair` relay pins the fresh
 * credential and redirects to `/`, so a successful run does not return control
 * to the caller, it hands off to a full-page navigation. Returns a failure
 * result (without navigating) when the agent never becomes ready, the caller is
 * unauthorized, or the request errors, so the caller can fall back to the wall.
 */
export async function runAgentSessionRecovery(
  deps: RunAgentSessionRecoveryDeps,
): Promise<AgentSessionRecoveryResult> {
  const {
    cloudApiBase,
    agentId,
    cloudToken,
    navigate,
    fetchFn = fetch,
    sleepFn = realSleep,
    nowFn = Date.now,
  } = deps;

  const base = cloudApiBase.replace(/\/+$/, "");
  const url = `${base}/api/v1/eliza/agents/${encodeURIComponent(
    agentId,
  )}/pairing-token`;

  const deadline = nowFn() + MAX_PAIRING_WAIT_MS;
  while (nowFn() < deadline) {
    let res: Response;
    try {
      res = await fetchFn(url, {
        method: "POST",
        headers: { Authorization: `Bearer ${cloudToken}` },
      });
    } catch (err) {
      return {
        ok: false,
        reason: "error",
        message: err instanceof Error ? err.message : String(err),
      };
    }

    const data = (await res
      .json()
      .catch(() => ({ error: "Unknown error" }))) as PairingTokenResponse;

    if (res.status === 202) {
      await sleepFn(retryAfterMs(res, data));
      continue;
    }

    if (res.status === 401 || res.status === 403) {
      // No valid cloud session after all, let the wall stand.
      return {
        ok: false,
        reason: "unauthorized",
        message: data.error || `Unauthorized (HTTP ${res.status})`,
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
      // Hand off to the /pair relay in the current window: it pins the fresh
      // credential and redirects to `/`, clearing the stale-credential 401 loop.
      navigate(redirectUrl);
      return { ok: true, redirectUrl };
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
