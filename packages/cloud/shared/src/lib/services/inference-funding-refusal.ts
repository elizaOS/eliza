/**
 * The client-facing body of a funding refusal (HTTP 402) on an inference
 * route. One mapping for every route, so clients read the same `error.code`
 * everywhere: a billing hold, a plan allowance that is used up (with the end
 * of its period when one is still ahead), or too little credit.
 *
 * Detection is by error name so lean route bundles need not import the
 * credits and admission services to build a refusal.
 */

export interface InferenceFundingRefusal {
  message: string;
  type: "insufficient_quota";
  code: "billing_hold_active" | "allowance_exhausted" | "insufficient_credits";
  resetsAt?: string;
}

export function inferenceFundingRefusal(
  error: unknown,
  options: {
    creditKind?: string;
    /** Replaces the default wording of the `insufficient_credits` refusal. */
    insufficientCreditsMessage?: string;
  } = {},
): InferenceFundingRefusal {
  const name = error instanceof Error ? error.name : "";
  if (name === "BillingHoldActiveError") {
    return {
      message: (error as Error).message,
      type: "insufficient_quota",
      code: "billing_hold_active",
    };
  }
  if (name === "AllowanceExhaustedError") {
    const resetsAt = (error as { resetsAt?: unknown }).resetsAt;
    return {
      message: "Plan allowance is used up for this period. Nothing is purchased automatically.",
      type: "insufficient_quota",
      code: "allowance_exhausted",
      ...(typeof resetsAt === "string" && { resetsAt: new Date(resetsAt).toISOString() }),
    };
  }
  const required = (error as { required?: unknown } | null)?.required;
  const creditKind = options.creditKind ?? "credits";
  return {
    message: options.insufficientCreditsMessage
      ? options.insufficientCreditsMessage
      : typeof required === "number"
        ? `Insufficient ${creditKind}. Required: $${required.toFixed(4)}`
        : `Insufficient ${creditKind}.`,
    type: "insufficient_quota",
    code: "insufficient_credits",
  };
}
