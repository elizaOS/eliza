/**
 * Canonical classification of the Cloud's insufficient-credits gate (HTTP 402,
 * `code: insufficient_credits`, body from `insufficientCredits402` server-side)
 * for any consumer of the API client — chat send, /join, future surfaces.
 * Fail-closed: unless the error shape is provably the canonical 402 gate, the
 * caller keeps its generic error state. Walks the `cause` chain because the
 * gate can arrive wrapped (client `ApiError` with the parsed body on `data`,
 * or a direct-cloud request error). Domain interpretation of the body (e.g.
 * /join's welcome-bonus withholding) belongs to the owning surface, layered on
 * top of this classifier — see `cloud/join/lib/join-credit-gate-error.ts`.
 */

export interface CreditGateError {
  /** The server's user-facing explanation (the 402 body's `error`). */
  message: string;
  /** The parsed 402 body for domain-specific wrappers; null when unavailable. */
  body: Record<string, unknown> | null;
}

const INSUFFICIENT_CREDITS_CODE = "insufficient_credits";

function bodyFrom(error: Error): Record<string, unknown> | null {
  const data = (error as Error & { data?: unknown }).data;
  return typeof data === "object" && data !== null && !Array.isArray(data)
    ? (data as Record<string, unknown>)
    : null;
}

/**
 * The credit-gate classification for a failed request, or `null` when the
 * error is anything else (network, provisioning, auth, ...).
 */
export function describeCreditGateError(
  error: unknown,
): CreditGateError | null {
  let current: unknown = error;
  for (let depth = 0; depth < 5 && current instanceof Error; depth += 1) {
    const { status, code } = current as Error & {
      status?: unknown;
      code?: unknown;
    };
    const body = bodyFrom(current);
    const bodyCode = body?.code;
    if (
      status === 402 &&
      (code === INSUFFICIENT_CREDITS_CODE ||
        bodyCode === INSUFFICIENT_CREDITS_CODE)
    ) {
      const bodyError =
        typeof body?.error === "string" ? body.error.trim() : "";
      return { message: bodyError || current.message.trim(), body };
    }
    current = (current as Error & { cause?: unknown }).cause;
  }
  return null;
}
