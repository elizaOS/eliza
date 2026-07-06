/**
 * Shared mint loop for the cloud pairing-token endpoint
 * (`POST /api/v1/eliza/agents/:id/pairing-token`).
 *
 * Two consumers ride the same 202+Retry-After protocol: the dashboard's
 * "Open Web UI" popup flow (`instances/lib/open-web-ui.ts`, same-origin +
 * session cookie) and the programmatic dedicated-agent credential repair
 * (`repair-agent-credential.ts`, absolute control-plane base + Steward
 * Bearer). The endpoint answers 202 while it auto-resumes a stopped agent,
 * so both callers must poll — extracting the loop keeps the retry semantics
 * (Retry-After header vs body `retryAfterMs` vs 5s default) identical.
 *
 * Network-level failures (fetch rejection) propagate to the caller: the popup
 * flow surfaces them as a toast, the repairer translates them at its own
 * boundary. Everything the server *answered* is returned as a typed result.
 */

const DEFAULT_RETRY_AFTER_MS = 5_000;

export interface PairingTokenResponse {
  data?: {
    redirectUrl?: string;
    retryAfterMs?: number;
    status?: string;
    message?: string;
  };
  error?: string;
}

export interface PairingTokenPollArgs {
  agentId: string;
  /**
   * Absolute cloud API base. Omit (or pass "") for a same-origin relative
   * call — the dashboard popup flow, where the session cookie is the auth.
   */
  apiBase?: string;
  /** Steward Bearer token for cross-origin callers; omitted → cookie auth. */
  authToken?: string | null;
  /** Total budget for the 202 poll loop. */
  maxWaitMs: number;
  /** Called with the server's progress message on each 202 (popup status text). */
  onStarting?: (message: string) => void;
  /** Checked after every response; `true` stops the loop (popup closed). */
  shouldAbort?: () => boolean;
}

export type PairingTokenPollResult =
  | { ok: true; redirectUrl: string }
  | {
      ok: false;
      reason: "aborted" | "timeout" | "request_failed" | "no_redirect_url";
      status?: number;
      message?: string;
    };

function retryAfterMs(res: Response, data: PairingTokenResponse): number {
  const fromBody = data.data?.retryAfterMs;
  if (typeof fromBody === "number" && fromBody > 0) return fromBody;

  const retryAfter = Number(res.headers.get("Retry-After"));
  if (Number.isFinite(retryAfter) && retryAfter > 0) {
    return retryAfter * 1000;
  }

  return DEFAULT_RETRY_AFTER_MS;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export async function pollPairingTokenRedirectUrl(
  args: PairingTokenPollArgs,
): Promise<PairingTokenPollResult> {
  const base = (args.apiBase ?? "").replace(/\/+$/, "");
  const url = `${base}/api/v1/eliza/agents/${encodeURIComponent(args.agentId)}/pairing-token`;
  const headers: Record<string, string> = {};
  if (args.authToken) headers.Authorization = `Bearer ${args.authToken}`;

  const deadline = Date.now() + args.maxWaitMs;
  while (Date.now() < deadline) {
    const res = await fetch(url, { method: "POST", headers });
    const data = (await res
      .json()
      // error-policy:J3 a non-JSON body still carries the HTTP status; the
      // typed failure below quotes the explicit "Unknown error" marker.
      .catch(() => ({ error: "Unknown error" }))) as PairingTokenResponse;

    if (args.shouldAbort?.()) return { ok: false, reason: "aborted" };

    if (res.status === 202) {
      args.onStarting?.(
        data.data?.message ??
          "Agent is starting. Connecting when the Web UI is ready…",
      );
      await sleep(retryAfterMs(res, data));
      continue;
    }

    if (!res.ok) {
      return {
        ok: false,
        reason: "request_failed",
        status: res.status,
        message: data.error,
      };
    }

    if (data.data?.redirectUrl) {
      return { ok: true, redirectUrl: data.data.redirectUrl };
    }

    return { ok: false, reason: "no_redirect_url", status: res.status };
  }

  return { ok: false, reason: "timeout" };
}
