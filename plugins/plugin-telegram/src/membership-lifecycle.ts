/**
 * Pure Telegram bot-membership transition classifier. The service uses this
 * for `my_chat_member` updates so removal suspends an existing world and re-add
 * reconnects the same world instead of creating a new identity or history.
 */
export type TelegramMembershipState =
  | "creator"
  | "administrator"
  | "member"
  | "restricted"
  | "left"
  | "kicked";

export type TelegramMembershipTransition = "connected" | "left" | "updated";

const PRESENT_STATES = new Set<TelegramMembershipState>([
  "creator",
  "administrator",
  "member",
  "restricted",
]);

function present(state: TelegramMembershipState): boolean {
  return PRESENT_STATES.has(state);
}

export function classifyTelegramMembershipTransition(
  previous: TelegramMembershipState,
  next: TelegramMembershipState,
): TelegramMembershipTransition | null {
  if (previous === next) return null;
  if (present(previous) && !present(next)) return "left";
  if (!present(previous) && present(next)) return "connected";
  return "updated";
}
