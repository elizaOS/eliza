/**
 * account-eligibility — the single source of truth for "what is this
 * provider eligible for right now?"
 *
 * Prefers the server-supplied `runtimeEligibility` (#16203 contract). When
 * that's absent (older agent, or the field hasn't landed yet) it falls back
 * to a CONSERVATIVE inference from the static provider option so the UI never
 * over-promises: a subscription provider is treated as coding-agent-only, an
 * API/BYOK provider as chat-capable. No hardcoded provider-name copy leaks
 * into the components — they consume the resolved shape below.
 */

import type { LinkedAccountProviderId } from "@elizaos/shared";
import type { ProviderRuntimeEligibility } from "../../api/client-accounts";
import type { AccountsListProvider } from "../../api/client-agent";
import type { AccountProviderOption } from "./account-provider-options";

export interface ResolvedEligibility {
  chat: boolean;
  codingAgent: boolean;
  /** Whether the data came from the server or was inferred client-side. */
  source: "runtime" | "inferred";
  note?: string;
}

/**
 * Conservative fallback: infer capability from the static option's category.
 *  - chat providers (BYOK API keys) → chat + coding agent
 *  - coding subscriptions → coding agent only (until the server says chat)
 *  - unavailable providers → neither
 */
function inferEligibility(option: AccountProviderOption): ResolvedEligibility {
  if (option.unavailable) {
    return { chat: false, codingAgent: false, source: "inferred" };
  }
  if (option.category === "chat") {
    return { chat: true, codingAgent: true, source: "inferred" };
  }
  // coding subscription / plan
  return { chat: false, codingAgent: true, source: "inferred" };
}

export function resolveProviderEligibility(
  option: AccountProviderOption,
  runtime: ProviderRuntimeEligibility | undefined,
): ResolvedEligibility {
  if (runtime) {
    return {
      chat: runtime.chat,
      codingAgent: runtime.codingAgent,
      source: "runtime",
      ...(runtime.note ? { note: runtime.note } : {}),
    };
  }
  return inferEligibility(option);
}

export interface EligibilityChip {
  key: string;
  label: string;
  tone: "chat" | "coding" | "muted";
}

/**
 * Render-ready capability chips. One chip per real capability the provider
 * can serve — no auth-method noise (that lives in the add flow). Keeps the
 * row calm: at most two capability chips.
 */
export function eligibilityChips(
  eligibility: ResolvedEligibility,
): EligibilityChip[] {
  const chips: EligibilityChip[] = [];
  if (eligibility.chat) {
    chips.push({ key: "chat", label: "Chat", tone: "chat" });
  }
  if (eligibility.codingAgent) {
    chips.push({ key: "coding", label: "Coding agents", tone: "coding" });
  }
  if (chips.length === 0) {
    chips.push({ key: "none", label: "Not eligible", tone: "muted" });
  }
  return chips;
}

/** Fast lookup of the runtime eligibility payload from a providers list. */
export function runtimeEligibilityFor(
  provider: AccountsListProvider | undefined,
): ProviderRuntimeEligibility | undefined {
  return provider?.runtimeEligibility;
}

export type ProviderConnectionState =
  | "connected-healthy"
  | "connected-attention"
  | "disconnected";

/**
 * ONE status signal per row (skill rule: kill the pill maze). Collapses
 * health counts into a single state; details live on expand.
 */
export function providerConnectionState(
  accounts: { enabled: boolean; health: string }[],
): ProviderConnectionState {
  if (accounts.length === 0) return "disconnected";
  const needsAttention = accounts.some(
    (a) =>
      a.health === "needs-reauth" ||
      a.health === "invalid" ||
      a.health === "expired",
  );
  if (needsAttention) return "connected-attention";
  return "connected-healthy";
}

export function isProviderId(value: string): value is LinkedAccountProviderId {
  return typeof value === "string" && value.length > 0;
}
