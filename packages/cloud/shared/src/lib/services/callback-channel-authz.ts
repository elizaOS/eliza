// Coordinates cloud service callback channel authz behavior behind route handlers.
import { elizaRoomCharactersRepository } from "../../db/repositories/eliza-room-characters";
import { logger } from "../utils/logger";

/**
 * Confirms the room a payment-settlement callback would post into belongs to
 * the organization that created the charge.
 *
 * A charge's `callback_channel.{roomId, agentId}` is attacker-controlled — it is
 * supplied by whoever created the charge and stored verbatim. Without this check
 * an attacker could create their own app + charge, point the channel at a victim
 * org's room, self-pay, and have a forged `role:'agent'` settlement message
 * ("Payment went through for $X.") injected into the victim's conversation,
 * attributed to the victim's agent (#10253).
 *
 * `eliza_room_characters → user_characters.organization_id` is the room→org
 * authority. A room with no character mapping cannot be attributed to an org, so
 * it is rejected (fail-closed) — the legitimate callback path targets a
 * cloud-managed character room, which always carries that mapping.
 */
export async function callbackRoomBelongsToOrganization(params: {
  roomId: string;
  chargeOrganizationId: string;
  logContext: string;
}): Promise<boolean> {
  const { roomId, chargeOrganizationId, logContext } = params;

  const roomOrganizationId = await elizaRoomCharactersRepository.findOrganizationIdByRoomId(roomId);

  if (!roomOrganizationId) {
    logger.warn(
      `[${logContext}] refusing callback room-message: room has no organization mapping`,
      { roomId, chargeOrganizationId },
    );
    return false;
  }

  if (roomOrganizationId !== chargeOrganizationId) {
    logger.warn(`[${logContext}] refusing cross-tenant callback room-message`, {
      roomId,
      roomOrganizationId,
      chargeOrganizationId,
    });
    return false;
  }

  return true;
}
