/**
 * Typed, minimal account state for a Personal Shared turn answered while
 * Dedicated access is withdrawn (#25146). It carries only the access state,
 * the confirmed reason category, the safe preservation deadline and the
 * signed-in billing action: never card details, provider objects or other
 * account data. The server resolves it from the durable fallback authority;
 * RPC params can never supply it.
 */

export const PERSONAL_FALLBACK_ACCOUNT_REASONS = [
  "billing_suspended",
  "subscription_payment_failed",
  "subscription_ended",
] as const;
export type PersonalFallbackAccountReason = (typeof PERSONAL_FALLBACK_ACCOUNT_REASONS)[number];

export interface PersonalSharedFallbackAccountState {
  access: "shared_fallback";
  /** `recovery_pending` once billing is restored and Dedicated is restarting. */
  state: "shared_active" | "recovery_pending";
  reason: PersonalFallbackAccountReason;
  /** Dedicated memory stays unavailable until billing is restored. */
  dedicatedMemory: "unavailable";
  generation: number;
  /** ISO time through which the stopped Dedicated agent is preserved, when policy sets one. */
  dedicatedRetainedUntil: string | null;
  /** Signed-in billing surface; a checkout redirect alone never restores access. */
  recoveryAction: {
    kind: "restore_subscription" | "add_credits";
    path: "/cloud/billing";
  };
}

export const PERSONAL_FALLBACK_ACCOUNT_PROVIDER = "PERSONAL_FALLBACK_ACCOUNT_STATE";

function isIsoTimestamp(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/.test(value) &&
    Number.isFinite(Date.parse(value))
  );
}

/** Exact boundary parser; anything else is rejected rather than coerced. */
export function parsePersonalSharedFallbackAccountState(
  value: unknown,
): PersonalSharedFallbackAccountState | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const input = value as Record<string, unknown>;
  const action = input.recoveryAction as Record<string, unknown> | null | undefined;
  if (
    input.access !== "shared_fallback" ||
    (input.state !== "shared_active" && input.state !== "recovery_pending") ||
    !PERSONAL_FALLBACK_ACCOUNT_REASONS.includes(input.reason as PersonalFallbackAccountReason) ||
    input.dedicatedMemory !== "unavailable" ||
    typeof input.generation !== "number" ||
    !Number.isSafeInteger(input.generation) ||
    input.generation < 1 ||
    (input.dedicatedRetainedUntil !== null && !isIsoTimestamp(input.dedicatedRetainedUntil)) ||
    !action ||
    typeof action !== "object" ||
    (action.kind !== "restore_subscription" && action.kind !== "add_credits") ||
    action.path !== "/cloud/billing" ||
    Object.keys(action).length !== 2 ||
    Object.keys(input).length !== 7
  ) {
    return null;
  }
  return {
    access: "shared_fallback",
    state: input.state as PersonalSharedFallbackAccountState["state"],
    reason: input.reason as PersonalFallbackAccountReason,
    dedicatedMemory: "unavailable",
    generation: input.generation,
    dedicatedRetainedUntil: input.dedicatedRetainedUntil as string | null,
    recoveryAction: {
      kind: action.kind as PersonalSharedFallbackAccountState["recoveryAction"]["kind"],
      path: "/cloud/billing",
    },
  };
}

const REASON_TEXT: Record<PersonalFallbackAccountReason, string> = {
  billing_suspended: "the account ran out of funds and its Dedicated agent was stopped",
  subscription_payment_failed: "the paid plan's payment failed and its grace period ended",
  subscription_ended: "the paid plan ended",
};

/** The model-facing provider block for a fallback turn. Server-owned, not user data. */
export function formatPersonalSharedFallbackAccountContext(
  state: PersonalSharedFallbackAccountState,
): string {
  const lines = [
    "# Account state (server-verified)",
    `- Dedicated access is paused because ${REASON_TEXT[state.reason]}.`,
    state.state === "recovery_pending"
      ? "- Billing has been restored and the Dedicated agent is restarting; this chat continues here until it is back."
      : "- This chat runs on the free Shared agent in a separate conversation.",
    "- Memory, conversation history and knowledge from the Dedicated agent are unavailable here until billing is restored. If the user asks about earlier Dedicated work, say plainly that it is unavailable right now and has not been lost; never guess or invent it.",
    state.dedicatedRetainedUntil
      ? `- The Dedicated agent and its data are preserved until at least ${state.dedicatedRetainedUntil}.`
      : "- The Dedicated agent and its data are preserved.",
    state.recoveryAction.kind === "restore_subscription"
      ? "- To restore Dedicated access, the signed-in account owner can update payment or renew the plan at /cloud/billing."
      : "- To restore Dedicated access, the signed-in account owner can add credits at /cloud/billing.",
    "- Free Shared capabilities listed above remain available. Never mention card details or payment provider data.",
  ];
  return lines.join("\n");
}
