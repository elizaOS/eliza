/**
 * X/Twitter direct-message access policy for the DM polling loop.
 * `TWITTER_DM_POLICY` decides how a DM from an arbitrary X user is gated; the
 * default `pairing` delegates to the core PairingService code handshake so an
 * unconfigured agent is never default-open to strangers (any texter could
 * otherwise drive the agent's reply loop over DMs). Mirrors the Telegram
 * connector's `dm-policy.ts` semantics.
 */
import {
  checkPairingAllowed,
  type IAgentRuntime,
  isInAllowlist,
  logger,
} from "@elizaos/core";

/** DM gating modes accepted by `TWITTER_DM_POLICY`. */
export type TwitterDmPolicy = "open" | "pairing" | "allowlist" | "disabled";

/**
 * Unset or unparsable policy values fail closed to `pairing`: unknown senders
 * are held for owner approval instead of silently getting full agent access.
 */
export const DEFAULT_TWITTER_DM_POLICY: TwitterDmPolicy = "pairing";

const TWITTER_DM_POLICIES: readonly TwitterDmPolicy[] = [
  "open",
  "pairing",
  "allowlist",
  "disabled",
];

/**
 * Parse a raw `TWITTER_DM_POLICY` setting. Blank or absent input yields the
 * default; unrecognized values are warned about and fail closed to the
 * default rather than being treated as `open`.
 */
export function resolveTwitterDmPolicy(raw: unknown): TwitterDmPolicy {
  if (raw === undefined || raw === null) {
    return DEFAULT_TWITTER_DM_POLICY;
  }
  const normalized = String(raw).trim().toLowerCase();
  if (!normalized) {
    return DEFAULT_TWITTER_DM_POLICY;
  }
  if ((TWITTER_DM_POLICIES as readonly string[]).includes(normalized)) {
    return normalized as TwitterDmPolicy;
  }
  logger.warn(
    { src: "plugin:x", policy: normalized },
    "Unrecognized TWITTER_DM_POLICY value; failing closed to the default pairing policy",
  );
  return DEFAULT_TWITTER_DM_POLICY;
}

/** Outcome of gating one inbound DM sender against the DM policy. */
export interface TwitterDmAccessDecision {
  allowed: boolean;
  /** Pairing-code reply to deliver to the sender, when one was issued. */
  replyMessage?: string;
}

/**
 * Evaluate one DM sender against the resolved DM policy. Only the `pairing`
 * branch is stateful: it delegates to the core PairingService, which replies
 * with a one-time code at most once per request TTL per sender. `allowlist`
 * consults the same core allowlist without creating a request or sending a
 * pairing code.
 */
export async function checkTwitterDmAccess(
  runtime: IAgentRuntime,
  params: {
    policy: TwitterDmPolicy;
    senderId: string;
    username?: string;
  },
): Promise<TwitterDmAccessDecision> {
  const { policy, senderId, username } = params;

  if (policy === "open") {
    return { allowed: true };
  }

  if (policy === "disabled") {
    return { allowed: false };
  }

  if (policy === "allowlist") {
    return { allowed: await isInAllowlist(runtime, "x", senderId) };
  }

  const pairing = await checkPairingAllowed(runtime, {
    channel: "x",
    senderId,
    metadata: username ? { username } : undefined,
  });
  return {
    allowed: pairing.allowed,
    ...(pairing.replyMessage ? { replyMessage: pairing.replyMessage } : {}),
  };
}
