/**
 * Pass/fail classifier for a cloud-bridge `message.send` reply, shared by the
 * live e2e chat scripts (hetzner-e2e-chat.ts, live-cloud-provision-smoke.ts).
 *
 * The agent runtime answers HTTP 200 with canned text when its model path is
 * dead — "Sorry, I'm having a provider issue", credits-depleted, rate-limited,
 * no-provider — tagged with a `failureKind` discriminator that the bridge
 * propagates (#15616). The bridge itself fabricates text (`fallback: true`),
 * the cloud-agent image echoes the prompt when @elizaos/core is missing
 * (`[echo] …` — which would even contain the proof token), and the shared
 * runtime marks designed-unavailable turns `degraded: true`. A smoke pass must
 * mean a real model round-trip, so every one of those shapes is a failure here:
 * the structured flags are the primary signal and the canned-string list is
 * belt-and-braces for runtimes that predate `failureKind`.
 *
 * The canned strings mirror packages/agent/src/api/chat-routes.ts,
 * packages/core/src/services/message/fallback-reply.ts, and the bridge
 * fallback in packages/cloud/shared/src/lib/services/eliza-sandbox.ts. They are
 * duplicated (not imported) so these scripts stay runnable with plain `bun run`
 * on a CI box without a workspace build.
 */

/** Verbatim canned failure replies the runtime/bridge can return with HTTP 200. */
export const KNOWN_CANNED_FAILURE_REPLIES: readonly string[] = [
  // packages/agent chat routes (dead model path, HTTP 200 + failureKind)
  "Sorry, I'm having a provider issue",
  "I don't have a reply for that — try rephrasing?",
  "I'm being rate-limited right now — give it a few seconds and try again.",
  "Connect an LLM provider to start chatting. Open Settings → Providers, " +
    "or choose Eliza Cloud during first-run setup.",
  "Something went wrong on my end. Please try again.",
  // packages/core fallback-reply.ts (shared with connectors)
  "Eliza Cloud credits are depleted. Top up the cloud balance and try again.",
  // the bridge's own no-reply fabrication (also flagged fallback:true)
  "Agent runtime is online, but no model response was produced before the cloud bridge timeout.",
  // cloud-agent native /bridge with an empty handleMessage callback
  "(no response)",
];

export interface BridgeReplyVerdict {
  ok: boolean;
  /** Trimmed reply text ("" when absent). */
  reply: string;
  /** Which bridge rung produced the reply ("unknown" for pre-#15616 bridges). */
  transport: string;
  /** Why the reply was rejected; null when ok. */
  reason: string | null;
}

// Mirrors classifySyntheticChatFailureText in packages/agent chat-routes.ts so
// smart-quote / whitespace drift can't dodge the canned-string match.
function normalizeReply(text: string): string {
  return text.trim().toLowerCase().replace(/[’]/g, "'").replace(/\s+/g, " ");
}

const NORMALIZED_CANNED_REPLIES = new Set(
  KNOWN_CANNED_FAILURE_REPLIES.map(normalizeReply),
);

function fail(
  reason: string,
  reply: string,
  transport: string,
): BridgeReplyVerdict {
  return { ok: false, reply, transport, reason };
}

/**
 * Judge a bridge `message.send` result. Passes only a non-empty reply that is
 * not flagged (`fallback`/`failureKind`/`degraded`), does not match a known
 * canned failure string, is not a cloud-agent echo, and contains `token` — the
 * per-run proof that a live model round-tripped THIS prompt.
 */
export function classifyBridgeReply(
  result: unknown,
  token: string,
): BridgeReplyVerdict {
  if (!result || typeof result !== "object" || Array.isArray(result)) {
    return fail("bridge response carried no result object", "", "unknown");
  }
  const record = result as Record<string, unknown>;
  const transport =
    typeof record.transport === "string" && record.transport.trim()
      ? record.transport.trim()
      : "unknown";
  const reply = typeof record.text === "string" ? record.text.trim() : "";

  if (record.fallback === true) {
    return fail(
      `bridge fabricated fallback text (reason: ${String(record.reason ?? "unknown")})`,
      reply,
      transport,
    );
  }
  if (typeof record.failureKind === "string" && record.failureKind.trim()) {
    return fail(
      `runtime returned a canned failure reply (failureKind: ${record.failureKind.trim()})`,
      reply,
      transport,
    );
  }
  if (record.degraded === true) {
    return fail(
      "shared runtime returned a degraded (designed-unavailable) turn",
      reply,
      transport,
    );
  }
  if (!reply) {
    return fail("bridge reply was empty", reply, transport);
  }

  const normalized = normalizeReply(reply);
  if (NORMALIZED_CANNED_REPLIES.has(normalized)) {
    return fail(
      "reply matches a known canned failure string",
      reply,
      transport,
    );
  }
  // Echo-mode cloud-agent (core unavailable) parrots the prompt back — it
  // would contain the proof token, so it must be rejected before the token check.
  if (normalized.startsWith("[echo]")) {
    return fail(
      "reply is a cloud-agent echo (runtime core unavailable)",
      reply,
      transport,
    );
  }
  if (
    /is temporarily unavailable \(no shared model configured\)\.?$/.test(reply)
  ) {
    return fail(
      "reply is the shared-runtime no-model-configured notice",
      reply,
      transport,
    );
  }
  if (!reply.includes(token)) {
    return fail(
      `reply did not echo the proof token ${token}`,
      reply,
      transport,
    );
  }

  return { ok: true, reply, transport, reason: null };
}
