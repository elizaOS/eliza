/**
 * Export all Nostr actions.
 *
 * The former DM-specific standalone action is intentionally absent: the Nostr
 * DM connector registered by NostrService.registerSendHandlers handles DMs
 * through MESSAGE operation=send. Public notes now route through POST
 * operation=send via the Nostr PostConnector.
 */

export { publishProfile } from "./publishProfile.js";
