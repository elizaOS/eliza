/**
 * Pure DM-policy gate for gateway-managed Discord connections. The event
 * router consults it for every direct message before any character lookup or
 * response generation, so a "disabled" or allowlist policy fails closed at
 * the earliest routing step.
 *
 * Mirrors the agent plugin's DISCORD_DM_POLICY semantics: unset or "open"
 * keeps the gateway's historical open-DM behavior; "disabled" admits nobody;
 * "allowlist" admits owners plus dmAllowFrom; "pairing" admits owners only,
 * because the gateway has no pairing flow.
 *
 * The standalone gateway validates its assignment envelope independently,
 * then delegates to the same shared authorization function exported here.
 */
export { isDiscordDmSenderAllowed as isDmSenderAllowed } from "@elizaos/shared/discord-dm-policy";
