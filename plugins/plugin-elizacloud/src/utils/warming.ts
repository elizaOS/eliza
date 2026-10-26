/**
 * Cold-cache warming detection for raw-`Response` cloud media calls (STT/TTS).
 *
 * On a box whose text brain runs elsewhere (e.g. Cerebras), the cloud's
 * per-model billing/auth admission cache goes cold between rare media calls;
 * the first call after idle answers 503 with a machine-readable warming body
 * that clears within ~1s on retry. The throw-shaped SDK calls already ride
 * through this (`retryMediaWarming` in models/media.ts, inline handlers in
 * models/image.ts — #18323/#18325/#18333; server escape #18249); this helper
 * is the companion for handlers that receive a raw `Response` and must peek
 * its body instead of a thrown error. Historical generic service_unavailable
 * 503 shapes remain retryable; diagnostics must not label every such refusal
 * as an authorization-cache miss. Other statuses return null.
 */

interface WarmingPeek {
  error?: { code?: unknown; type?: unknown; retryAfter?: unknown; reason?: unknown };
  code?: unknown;
  type?: unknown;
  retryAfter?: unknown;
  reason?: unknown;
}

/**
 * Returns the seconds to wait before retrying a warming 503, or null when the
 * response is not an existing cache-warming/generic-unavailable retry shape. Reads a clone so
 * the caller's body remains consumable.
 */
export async function warmingRetryWaitSeconds(
  response: Response,
  onObserved?: (detail: {code?:string;type?:string;reason?:string;retryWaitSeconds:number|null;durationMs:number})=>void,
): Promise<number | null> {
  if (response.status !== 503) return null;
  const started=Date.now();
  let observed:{code?:string;type?:string;reason?:string;retryWaitSeconds:number|null;durationMs:number}={retryWaitSeconds:null,durationMs:0};
  const safeMachine=new Set(["service_unavailable","auth_cache_warming","rate_limit_cache_warming","pricing_cache_warming","billing_cache_warming","generative_cache_warming","rate_limit_unavailable","inference_budget_unavailable","authentication_error","permission_error","authentication_required","access_denied","authorization_unavailable","credential_invalid","credential_inactive","organization_inactive","account_inactive","membership_missing","moderation_blocked","rate_limit_exceeded"]);
  const machine=(value:unknown)=>typeof value==='string'&&safeMachine.has(value)?value:undefined;
  try {
    const peek = (await response.clone().json()) as WarmingPeek;
    const code = String(peek?.error?.code ?? peek?.code ?? "");
    const type = String(peek?.error?.type ?? peek?.type ?? "");
    const warming =
      code.endsWith("_cache_warming") ||
      code === "service_unavailable" ||
      type === "service_unavailable";
    observed={...observed,code:machine(peek?.error?.code??peek?.code),type:machine(peek?.error?.type??peek?.type),reason:machine(peek?.error?.reason??peek?.reason)};
    if (!warming) return null;
    const ra = peek?.error?.retryAfter ?? peek?.retryAfter;
    const wait=typeof ra === "number" && Number.isFinite(ra) && ra > 0
      ? Math.min(ra, 3)
      : 1.5;
    observed.retryWaitSeconds=wait;
    return wait;
  } catch {
    // error-policy:J3 a non-JSON 503 body is an explicit "not warming"
    // verdict; the caller surfaces the original HTTP failure.
    return null;
  } finally {
    observed.durationMs=Math.max(0,Date.now()-started);
    try{onObserved?.(observed);}catch{/* Diagnostics cannot alter the retry decision. */}
  }
}
