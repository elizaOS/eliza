/**
 * W1-F — Default channel pack entry point.
 *
 * Wave 1 ships an EMPTY pack: this file exists so the registration entry
 * point is stable and Wave 2 (W2-B) can populate the channel contributions
 * (`in_app`, `push`, `imessage`, `telegram`, `discord`, `sms`, `email`,
 * `voice`, etc.) without further repo restructuring.
 */

import type {
  ChannelContribution,
  ChannelRegistry,
} from "./contract.js";

/**
 * Empty in Wave 1 — Wave 2 W2-B populates this list with the migrated
 * channel contributions.
 */
export const DEFAULT_CHANNEL_PACK: readonly ChannelContribution[] = [];

/**
 * Register every channel in the default pack against the supplied registry.
 *
 * Wave 1: no-op (the pack is empty). Wave 2: registers the migrated channels.
 */
export function registerDefaultChannelPack(registry: ChannelRegistry): void {
  for (const contribution of DEFAULT_CHANNEL_PACK) {
    registry.register(contribution);
  }
}
