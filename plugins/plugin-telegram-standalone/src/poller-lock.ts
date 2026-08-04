/** Shared Telegram poller ownership exports from the full Telegram plugin. */
export {
  claimTelegramPollerToken,
  ensureTelegramPollerTokenAvailable,
  getTelegramPollerClaim,
  listTelegramPollerHealth,
  markTelegramPollerConnected,
  markTelegramPollerError,
  markTelegramPollerTerminated,
  markTelegramPollerUpdate,
  releaseTelegramPollerToken,
  type TelegramPollerClaim,
  type TelegramPollerHealth,
  type TelegramPollerMode,
} from "@elizaos/plugin-telegram";
