export const TELEGRAM_CONNECTED_PATH = "/connected?from=telegram";
export const TELEGRAM_ACCOUNT_CONNECTED_PATH = "/connected";

/**
 * The signed Telegram auth endpoint redeems bot-issued continuations as one
 * server-side operation. The browser only selects the post-auth destination;
 * it has no privileged continuation endpoint of its own.
 */
export function getTelegramLinkDestination(
  continuationRedeemed: boolean,
): string {
  return continuationRedeemed
    ? TELEGRAM_CONNECTED_PATH
    : TELEGRAM_ACCOUNT_CONNECTED_PATH;
}
