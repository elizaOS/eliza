/**
 * Telegram private-chat access policy shared by the full bot service and the
 * standalone poller. `TELEGRAM_DM_POLICY` decides how a DM from an arbitrary
 * Telegram user is gated when no `TELEGRAM_ALLOWED_CHATS` allowlist is
 * configured; the default `pairing` delegates to the core PairingService code
 * handshake so an unconfigured bot is never default-open to strangers.
 */
import { checkPairingAllowed, type IAgentRuntime, logger } from "@elizaos/core";

/** DM gating modes accepted by `TELEGRAM_DM_POLICY`. */
export type TelegramDmPolicy = "open" | "pairing" | "allowlist" | "disabled";

/**
 * Unset or unparsable policy values fail closed to `pairing`: unknown senders
 * are held for owner approval instead of silently getting full bot access.
 */
export const DEFAULT_TELEGRAM_DM_POLICY: TelegramDmPolicy = "pairing";

const TELEGRAM_DM_POLICIES: readonly TelegramDmPolicy[] = [
  "open",
  "pairing",
  "allowlist",
  "disabled",
];

/**
 * Parse a raw `TELEGRAM_DM_POLICY` setting. Blank or absent input yields the
 * default; unrecognized values are warned about and fail closed to the
 * default rather than being treated as `open`.
 */
export function resolveTelegramDmPolicy(raw: unknown): TelegramDmPolicy {
  if (raw === undefined || raw === null) {
    return DEFAULT_TELEGRAM_DM_POLICY;
  }
  const normalized = String(raw).trim().toLowerCase();
  if (!normalized) {
    return DEFAULT_TELEGRAM_DM_POLICY;
  }
  if ((TELEGRAM_DM_POLICIES as readonly string[]).includes(normalized)) {
    return normalized as TelegramDmPolicy;
  }
  logger.warn(
    { src: "plugin:telegram", policy: normalized },
    "Unrecognized TELEGRAM_DM_POLICY value; failing closed to the default pairing policy",
  );
  return DEFAULT_TELEGRAM_DM_POLICY;
}

/** Outcome of gating one inbound private chat against the DM policy. */
export interface TelegramDmAccessDecision {
  allowed: boolean;
  /** Pairing-code reply to deliver to the sender, when one was issued. */
  replyMessage?: string;
}

/**
 * Evaluate one private-chat sender against the resolved DM policy. Only the
 * `pairing` branch is stateful: it delegates to the core PairingService,
 * which replies with a one-time code at most once per request TTL per sender.
 * `allowlist` denies here because callers only reach this gate when no
 * allowlist is configured; a configured allowlist decides before this runs.
 */
export async function checkTelegramDmAccess(
  runtime: IAgentRuntime,
  params: {
    policy: TelegramDmPolicy;
    senderId: string;
    username?: string;
  },
): Promise<TelegramDmAccessDecision> {
  const { policy, senderId, username } = params;

  if (policy === "open") {
    return { allowed: true };
  }

  if (policy === "disabled" || policy === "allowlist") {
    return { allowed: false };
  }

  const pairing = await checkPairingAllowed(runtime, {
    channel: "telegram",
    senderId,
    metadata: username ? { username } : undefined,
  });
  return {
    allowed: pairing.allowed,
    ...(pairing.replyMessage ? { replyMessage: pairing.replyMessage } : {}),
  };
}
