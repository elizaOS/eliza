/**
 * Client-side contract for the personal Eliza Dedicated-to-Shared fallback
 * (#25146): the typed route refusals a Shared chat surface returns, and the
 * account state `/api/v1/eliza/personal` reports while Dedicated access is
 * withdrawn. Both arrive from the network, so they are validated here rather
 * than trusted; anything malformed is rejected instead of coerced.
 */

import type { PersonalSharedFallbackAccountState } from "@elizaos/cloud-sdk/browser-contracts";
import { isElizaCloudControlPlaneHostname } from "@elizaos/plugin-elizacloud/cloud-config/domain-contract";

export type PersonalFallbackAccountState = PersonalSharedFallbackAccountState;
export type PersonalFallbackReason = PersonalFallbackAccountState["reason"];

const REASONS: ReadonlySet<string> = new Set<PersonalFallbackReason>([
  "billing_suspended",
  "subscription_payment_failed",
  "subscription_ended",
]);
const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/;
const RECOVERY_LINK_PATH = "/api/v1/eliza/personal/recovery/";
const RECOVERY_TOKEN = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function isIsoTimestamp(value: unknown): value is string {
  return (
    typeof value === "string" &&
    ISO_TIMESTAMP.test(value) &&
    Number.isFinite(Date.parse(value))
  );
}

/** True for the Cloud's signed recovery-resolver URL and nothing else. */
function isRecoveryLinkUrl(value: unknown): value is string {
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
  if (!url.pathname.startsWith(RECOVERY_LINK_PATH)) return false;
  return RECOVERY_TOKEN.test(url.pathname.slice(RECOVERY_LINK_PATH.length));
}

/**
 * Parse `identity.accountState` from `/api/v1/eliza/personal`. Returns null
 * for anything that is not the typed fallback state; callers treat a present
 * but unparseable value as an invalid response, never as "no fallback".
 */
export function parsePersonalFallbackAccountState(
  value: unknown,
): PersonalFallbackAccountState | null {
  const input = record(value);
  const action = record(input?.recoveryAction);
  if (
    !input ||
    !action ||
    input.access !== "shared_fallback" ||
    (input.state !== "shared_active" && input.state !== "recovery_pending") ||
    typeof input.reason !== "string" ||
    !REASONS.has(input.reason) ||
    input.dedicatedMemory !== "unavailable" ||
    typeof input.generation !== "number" ||
    !Number.isSafeInteger(input.generation) ||
    input.generation < 1 ||
    (input.dedicatedRetainedUntil !== null &&
      !isIsoTimestamp(input.dedicatedRetainedUntil)) ||
    (action.kind !== "restore_subscription" && action.kind !== "add_credits") ||
    action.path !== "/cloud/billing"
  ) {
    return null;
  }
  let link: PersonalFallbackAccountState["recoveryAction"]["link"];
  if (action.link !== undefined) {
    const rawLink = record(action.link);
    if (
      !rawLink ||
      !isRecoveryLinkUrl(rawLink.url) ||
      !isIsoTimestamp(rawLink.expiresAt)
    ) {
      return null;
    }
    link = { url: rawLink.url, expiresAt: rawLink.expiresAt };
  }
  return {
    access: "shared_fallback",
    state: input.state,
    reason: input.reason as PersonalFallbackReason,
    dedicatedMemory: "unavailable",
    generation: input.generation,
    dedicatedRetainedUntil: input.dedicatedRetainedUntil as string | null,
    recoveryAction: {
      kind: action.kind,
      path: "/cloud/billing",
      ...(link ? { link } : {}),
    },
  };
}

/**
 * Where the pay action goes: the signed, unexpired recovery link when it
 * points at the same Cloud (or a trusted Cloud control plane), otherwise the
 * signed-in billing page. Neither grants anything by itself.
 */
export function personalFallbackRecoveryUrl(
  state: PersonalFallbackAccountState,
  billingUrl: string,
  cloudApiBase: string,
  now: number = Date.now(),
): string {
  const link = state.recoveryAction.link;
  if (!link || Date.parse(link.expiresAt) <= now) return billingUrl;
  try {
    const linkUrl = new URL(link.url);
    const sameCloud = linkUrl.origin === new URL(cloudApiBase).origin;
    if (sameCloud || isElizaCloudControlPlaneHostname(linkUrl.hostname)) {
      return link.url;
    }
  } catch {
    // error-policy:J3 an unparseable Cloud base cannot vouch for the link.
  }
  return billingUrl;
}

export type PersonalRouteRefusal =
  /** 409: Dedicated owns this conversation; the chat must move there. */
  | { kind: "dedicated_active"; activeAgentId: string }
  /** 503: the route is between runtimes; the same request is retryable. */
  | {
      kind: "retry";
      code: "dedicated_reconciling" | "dedicated_fallback_pending";
      retryAfterSeconds: number | null;
    };

/**
 * Classify a failed request as a typed personal-route refusal, or null for
 * anything else. Walks the `cause` chain like the credit-gate classifier; the
 * code must come from the parsed body or the ApiError's code field.
 */
export function describePersonalRouteRefusal(
  error: unknown,
): PersonalRouteRefusal | null {
  let current: unknown = error;
  for (let depth = 0; depth < 5 && current instanceof Error; depth += 1) {
    const failure = current as Error & {
      status?: unknown;
      code?: unknown;
      data?: unknown;
      retryAfter?: unknown;
      cause?: unknown;
    };
    const body = record(failure.data);
    const code = body?.code ?? failure.code;
    if (failure.status === 409 && code === "personal_eliza_dedicated") {
      const activeAgentId =
        typeof body?.activeAgentId === "string"
          ? body.activeAgentId.trim()
          : "";
      if (activeAgentId) return { kind: "dedicated_active", activeAgentId };
    }
    if (
      failure.status === 503 &&
      (code === "dedicated_reconciling" ||
        code === "dedicated_fallback_pending")
    ) {
      const retryAfter = failure.retryAfter;
      return {
        kind: "retry",
        code,
        retryAfterSeconds:
          typeof retryAfter === "number" &&
          Number.isFinite(retryAfter) &&
          retryAfter > 0
            ? retryAfter
            : null,
      };
    }
    current = failure.cause;
  }
  return null;
}
