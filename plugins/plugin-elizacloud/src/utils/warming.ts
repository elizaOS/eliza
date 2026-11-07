/**
 * Typed transient-503 detection for raw-`Response` cloud media calls (STT/TTS).
 *
 * The cloud fills cold caches inline and no longer answers a cold request with
 * a warming 503. It still answers 503 `service_unavailable` when the admission
 * Durable Object or primary is briefly unreachable; this helper peeks the body
 * of a raw `Response` and returns the short wait before one retry. Other
 * statuses and bodies return null.
 */

interface WarmingPeek {
  error?: { code?: unknown; type?: unknown; retryAfter?: unknown; reason?: unknown };
  code?: unknown;
  type?: unknown;
  retryAfter?: unknown;
  reason?: unknown;
}

/**
 * Returns the seconds to wait before retrying a typed transient 503, or null
 * when the response is not that shape. Reads a clone so the caller's body
 * remains consumable.
 */
export async function warmingRetryWaitSeconds(
  response: Response,
  onObserved?: (detail: {code?:string;type?:string;reason?:string;retryWaitSeconds:number|null;durationMs:number})=>void,
): Promise<number | null> {
  if (response.status !== 503) return null;
  const started=Date.now();
  let observed:{code?:string;type?:string;reason?:string;retryWaitSeconds:number|null;durationMs:number}={retryWaitSeconds:null,durationMs:0};
  const safeMachine=new Set(["service_unavailable","billing_unavailable","rate_limit_unavailable","inference_budget_unavailable","authentication_error","permission_error","authentication_required","access_denied","authorization_unavailable","credential_invalid","credential_inactive","organization_inactive","account_inactive","membership_missing","moderation_blocked","rate_limit_exceeded"]);
  const machine=(value:unknown)=>typeof value==='string'&&safeMachine.has(value)?value:undefined;
  try {
    const peek = (await response.clone().json()) as WarmingPeek;
    const code = String(peek?.error?.code ?? peek?.code ?? "");
    const type = String(peek?.error?.type ?? peek?.type ?? "");
    const warming = code === "service_unavailable" || type === "service_unavailable";
    observed={...observed,code:machine(peek?.error?.code??peek?.code),type:machine(peek?.error?.type??peek?.type),reason:machine(peek?.error?.reason??peek?.reason)};
    if (!warming) return null;
    const ra = peek?.error?.retryAfter ?? peek?.retryAfter;
    const wait=typeof ra === "number" && Number.isFinite(ra) && ra > 0
      ? Math.min(ra, 3)
      : 1.5;
    observed.retryWaitSeconds=wait;
    return wait;
  } catch {
    // error-policy:J3 a non-JSON 503 body is an explicit "not transient"
    // verdict; the caller surfaces the original HTTP failure.
    return null;
  } finally {
    observed.durationMs=Math.max(0,Date.now()-started);
    try{onObserved?.(observed);}catch{/* Diagnostics cannot alter the retry decision. */}
  }
}
