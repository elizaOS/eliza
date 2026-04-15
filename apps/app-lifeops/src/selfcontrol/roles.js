import { checkSenderRole as coreCheckSenderRole, logger, resolveCanonicalOwnerId, } from "@elizaos/core";
export async function checkSenderRole(runtime, message) {
    const result = await coreCheckSenderRole(runtime, message);
    if (result) {
        return {
            ...result,
            hasPrivateAccess: result.isAdmin,
        };
    }
    // Fallback: no world found for this message's room. This happens for
    // dashboard/terminal sessions where the world may not be set up yet.
    // If the sender matches the configured canonical owner, grant OWNER.
    const canonicalOwnerId = resolveCanonicalOwnerId(runtime);
    const senderEntityId = String(message.entityId);
    if (canonicalOwnerId && senderEntityId === canonicalOwnerId) {
        logger.debug("[selfcontrol] No world for message room, but sender matches configured admin entity — granting OWNER");
        return {
            entityId: senderEntityId,
            role: "OWNER",
            isOwner: true,
            isAdmin: true,
            canManageRoles: true,
            hasPrivateAccess: true,
        };
    }
    logger.debug("[selfcontrol] checkSenderRole returned null — no world found and sender does not match configured admin entity");
    return null;
}
