/**
 * Typed, minimal account state for a Personal Shared turn answered while
 * Dedicated access is withdrawn (#25146). It carries only the access state,
 * the confirmed reason category, the safe preservation deadline and the
 * signed-in billing action: never card details, provider objects or other
 * account data. The server resolves it from the durable fallback authority;
 * RPC params can never supply it.
 */

import {
  PERSONAL_FALLBACK_ACCOUNT_REASONS,
  type PersonalFallbackAccountReason,
  type PersonalFallbackRecoveryLink,
  type PersonalSharedFallbackAccountState,
} from "@elizaos/cloud-sdk/browser-contracts";

export {
  PERSONAL_FALLBACK_ACCOUNT_REASONS,
  type PersonalFallbackAccountReason,
  type PersonalFallbackRecoveryLink,
  type PersonalSharedFallbackAccountState,
} from "@elizaos/cloud-sdk/browser-contracts";

/** Path of the signed recovery link resolver; the token is the final segment. */
export const PERSONAL_FALLBACK_RECOVERY_LINK_PATH = "/api/v1/eliza/personal/recovery/";

const RECOVERY_TOKEN = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;

/** True for an absolute recovery-resolver URL with a compact JWS token and nothing else. */
export function isPersonalFallbackRecoveryLinkUrl(value: unknown): value is string {
  if (typeof value !== "string" || value.length > 2_048) return false;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    // error-policy:J3 untrusted boundary value — an unparseable URL is invalid.
    return false;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return false;
  if (url.username || url.password || url.search || url.hash) return false;
  if (!url.pathname.startsWith(PERSONAL_FALLBACK_RECOVERY_LINK_PATH)) return false;
  return RECOVERY_TOKEN.test(url.pathname.slice(PERSONAL_FALLBACK_RECOVERY_LINK_PATH.length));
}

function parseRecoveryLink(value: unknown): PersonalFallbackRecoveryLink | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const link = value as Record<string, unknown>;
  if (
    Object.keys(link).length !== 2 ||
    !isPersonalFallbackRecoveryLinkUrl(link.url) ||
    !isIsoTimestamp(link.expiresAt)
  ) {
    return null;
  }
  return { url: link.url, expiresAt: link.expiresAt };
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
    Object.keys(action).length !== ("link" in action ? 3 : 2) ||
    Object.keys(input).length !== 7
  ) {
    return null;
  }
  const link = "link" in action ? parseRecoveryLink(action.link) : undefined;
  if (link === null) return null;
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
      ...(link ? { link } : {}),
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
    ...(state.recoveryAction.link
      ? [
          `- Pay action link (opens billing after sign-in; expires ${state.recoveryAction.link.expiresAt}): ${state.recoveryAction.link.url}. Share it only with this account owner in this conversation.`,
        ]
      : []),
    "- Free Shared capabilities listed above remain available. Never mention card details or payment provider data.",
  ];
  return lines.join("\n");
}
