/**
 * Signal direct-message access policy, resolved from each account's
 * advertised `dm` config (`character.settings.signal[.accounts.<id>].dm`).
 * The default `pairing` delegates to the core PairingService code handshake
 * so an unconfigured agent is never default-open to strangers over DMs.
 * Group messages are not gated here — group access stays governed by
 * `SIGNAL_SHOULD_IGNORE_GROUP_MESSAGES` and the group allowlist settings.
 */
import { checkPairingAllowed, type IAgentRuntime, isInAllowlist, logger } from "@elizaos/core";

/** DM gating modes accepted by the account `dm.policy` config. */
export type SignalDmPolicy = "open" | "pairing" | "allowlist" | "disabled";

/**
 * Unset or unparsable policy values fail closed to `pairing`: unknown senders
 * are held for owner approval instead of silently getting full agent access.
 */
export const DEFAULT_SIGNAL_DM_POLICY: SignalDmPolicy = "pairing";

const SIGNAL_DM_POLICIES: readonly SignalDmPolicy[] = ["open", "pairing", "allowlist", "disabled"];

/**
 * Parse a raw `dm.policy` config value. Blank or absent input yields the
 * default; unrecognized values are warned about and fail closed to the
 * default rather than being treated as `open`.
 */
export function resolveSignalDmPolicy(raw: unknown): SignalDmPolicy {
  if (raw === undefined || raw === null) {
    return DEFAULT_SIGNAL_DM_POLICY;
  }
  const normalized = String(raw).trim().toLowerCase();
  if (!normalized) {
    return DEFAULT_SIGNAL_DM_POLICY;
  }
  if ((SIGNAL_DM_POLICIES as readonly string[]).includes(normalized)) {
    return normalized as SignalDmPolicy;
  }
  logger.warn(
    { src: "plugin:signal", policy: normalized },
    "Unrecognized Signal dm.policy value; failing closed to the default pairing policy"
  );
  return DEFAULT_SIGNAL_DM_POLICY;
}

/** Outcome of gating one inbound DM sender against the DM policy. */
export interface SignalDmAccessDecision {
  allowed: boolean;
  /** Pairing-code reply to deliver to the sender, when one was issued. */
  replyMessage?: string;
}

/**
 * Evaluate one DM sender against the resolved DM policy. The static
 * `allowFrom` list admits senders under every non-`disabled` policy;
 * `allowlist` additionally consults the core pairing allowlist; only the
 * `pairing` branch is stateful, delegating to the core PairingService, which
 * replies with a one-time code at most once per request TTL per sender.
 */
export async function checkSignalDmAccess(
  runtime: IAgentRuntime,
  params: {
    policy: SignalDmPolicy;
    senderId: string;
    allowFrom?: Array<string | number>;
    username?: string;
  }
): Promise<SignalDmAccessDecision> {
  const { policy, senderId, allowFrom, username } = params;

  if (policy === "disabled") {
    return { allowed: false };
  }

  if (policy === "open") {
    return { allowed: true };
  }

  if (allowFrom?.some((entry) => String(entry) === senderId)) {
    return { allowed: true };
  }

  if (policy === "allowlist") {
    return { allowed: await isInAllowlist(runtime, "signal", senderId) };
  }

  const pairing = await checkPairingAllowed(runtime, {
    channel: "signal",
    senderId,
    metadata: username ? { username } : undefined,
  });
  return {
    allowed: pairing.allowed,
    ...(pairing.replyMessage ? { replyMessage: pairing.replyMessage } : {}),
  };
}
