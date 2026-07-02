/**
 * Client-side recognizer for the server's synthetic error-fallback chat
 * replies, so the voice self-test SEND stage cannot report `pass` on a turn
 * where the model provider actually failed (#10726 "pass-on-provider-error"
 * hole).
 *
 * The canonical strings and classification live server-side:
 *   - `packages/agent/src/api/chat-routes.ts`
 *     (`PROVIDER_ISSUE_CHAT_REPLY`, `NO_RESPONSE_FALLBACK_REPLY`,
 *      `INSUFFICIENT_CREDITS_CHAT_REPLY`, `RATE_LIMITED_CHAT_REPLY`,
 *      `NO_PROVIDER_CHAT_MESSAGE`, `classifySyntheticChatFailureText`)
 *   - `packages/core/src/features/basic-capabilities/providers/recentMessages.ts`
 *     (`SYNTHETIC_ASSISTANT_FAILURE_TEXTS` / `..._KINDS`)
 *
 * The SSE done event already carries a structured `failureKind` for these
 * turns and the harness checks that FIRST; this text classifier is the
 * defense-in-depth net for paths that persist the fallback text without the
 * structured discriminator. Keep the strings in sync with the server sources
 * above — the unit test pins each one.
 */

export type ErrorFallbackReplyKind =
  | "provider_issue"
  | "no_response"
  | "insufficient_credits"
  | "rate_limited"
  | "no_provider"
  | "transient_failure";

/** Mirrors `chat-routes.ts` canonical fallback reply strings (normalized). */
const EXACT_FALLBACK_REPLIES: ReadonlyArray<{
  text: string;
  kind: ErrorFallbackReplyKind;
}> = [
  { text: "sorry, i'm having a provider issue", kind: "provider_issue" },
  {
    text: "i don't have a reply for that — try rephrasing?",
    kind: "no_response",
  },
  {
    text: "i don't have a reply for that - try rephrasing?",
    kind: "no_response",
  },
  {
    text: "eliza cloud credits are depleted. top up the cloud balance and try again.",
    kind: "insufficient_credits",
  },
  {
    text: "i'm being rate-limited right now — give it a few seconds and try again.",
    kind: "rate_limited",
  },
  {
    text:
      "connect an llm provider to start chatting. open settings → providers, " +
      "or choose eliza cloud during first-run setup.",
    kind: "no_provider",
  },
  {
    text: "something went wrong on my end. please try again.",
    kind: "transient_failure",
  },
];

function normalize(text: string): string {
  return text.trim().toLowerCase().replace(/[’]/g, "'").replace(/\s+/g, " ");
}

/**
 * Classify a reply as a known server error-fallback text. Returns `null` for
 * a genuine model reply. Mirrors the normalization + pattern fallbacks of
 * `classifySyntheticChatFailureText` (chat-routes.ts) and
 * `isSyntheticAssistantFailureMessage` (recentMessages.ts).
 */
export function classifyErrorFallbackReply(
  text: string | null | undefined,
): ErrorFallbackReplyKind | null {
  if (!text) return null;
  const normalized = normalize(text);
  if (!normalized) return null;
  for (const { text: canonical, kind } of EXACT_FALLBACK_REPLIES) {
    if (normalized === canonical) return kind;
  }
  if (/\bprovider issue\b/.test(normalized)) return "provider_issue";
  if (/^something went wrong on my end\b/.test(normalized)) {
    return "transient_failure";
  }
  return null;
}
