const CANONICAL_OWNER_SETTING_KEY = "ELIZA_ADMIN_ENTITY_ID";
const IDENTITY_LINK_TAG = "identity_link";
function normalizeRole(role) {
    if (typeof role !== "string") {
        return "GUEST";
    }
    switch (role.toUpperCase()) {
        case "OWNER":
            return "OWNER";
        case "ADMIN":
            return "ADMIN";
        case "USER":
            return "USER";
        default:
            return "GUEST";
    }
}
function resolveCanonicalOwnerId(runtime, metadata) {
    if (typeof runtime.getSetting === "function") {
        const configured = runtime.getSetting(CANONICAL_OWNER_SETTING_KEY);
        if (typeof configured === "string" && configured.trim().length > 0) {
            return configured.trim();
        }
    }
    return metadata?.ownership?.ownerId ?? null;
}
async function resolveWorldForMessage(runtime, message) {
    const room = await runtime.getRoom(message.roomId);
    if (!room?.worldId) {
        return null;
    }
    const world = await runtime.getWorld(room.worldId);
    if (!world) {
        return null;
    }
    return (world.metadata ?? {});
}
function normalizeIdentityValue(value) {
    if (typeof value === "number" || typeof value === "bigint") {
        return String(value);
    }
    if (typeof value !== "string") {
        return null;
    }
    const normalized = value.trim();
    if (normalized.length === 0) {
        return null;
    }
    return normalized.toLowerCase();
}
function collectConnectorIdentities(metadata) {
    if (!metadata) {
        return [];
    }
    const identities = [];
    for (const [connector, rawConnectorData] of Object.entries(metadata)) {
        if (!rawConnectorData || typeof rawConnectorData !== "object") {
            continue;
        }
        const connectorData = rawConnectorData;
        const values = new Set();
        for (const field of ["id", "userId", "user_id", "fromId", "username"]) {
            const normalized = normalizeIdentityValue(connectorData[field]);
            if (normalized) {
                values.add(normalized);
            }
        }
        if (values.size > 0) {
            identities.push({ connector, values });
        }
    }
    return identities;
}
function extractLiveMessageMetadata(message) {
    const metadata = message.content?.metadata;
    if (metadata && typeof metadata === "object" && !Array.isArray(metadata)) {
        return metadata;
    }
    return undefined;
}
function extractMessageConnectorMetadata(message) {
    const metadata = message
        .metadata;
    if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
        return undefined;
    }
    const source = typeof message.content?.source === "string"
        ? message.content.source
        : undefined;
    const result = {};
    const fromId = metadata.fromId ??
        metadata.discordUserId ??
        metadata.telegramUserId ??
        metadata.userId ??
        metadata.id;
    const username = metadata.username ?? metadata.telegramUsername;
    if (source === "discord" ||
        typeof metadata.discordServerId === "string" ||
        typeof metadata.discordChannelId === "string") {
        result.discord = {
            userId: fromId,
            username,
        };
    }
    if (source === "telegram" ||
        typeof metadata.telegramChatId === "string" ||
        typeof metadata.telegramUserId === "string") {
        result.telegram = {
            id: fromId,
            username,
        };
    }
    return Object.keys(result).length > 0 ? result : undefined;
}
function sharesConnectorIdentity(left, right) {
    if (!left || !right) {
        return false;
    }
    const leftIdentities = collectConnectorIdentities(left);
    const rightByConnector = new Map(collectConnectorIdentities(right).map((identity) => [
        identity.connector,
        identity.values,
    ]));
    for (const identity of leftIdentities) {
        const otherValues = rightByConnector.get(identity.connector);
        if (!otherValues) {
            continue;
        }
        for (const value of identity.values) {
            if (otherValues.has(value)) {
                return true;
            }
        }
    }
    return false;
}
async function getEntity(runtime, entityId) {
    if (typeof runtime.getEntityById !== "function") {
        return null;
    }
    const entity = await runtime.getEntityById(entityId);
    return entity ? entity : null;
}
function isConfirmedIdentityLink(relationship, senderEntityId, canonicalOwnerId) {
    if (!Array.isArray(relationship.tags)) {
        return false;
    }
    if (!relationship.tags.includes(IDENTITY_LINK_TAG)) {
        return false;
    }
    const status = normalizeIdentityValue(relationship.metadata?.status);
    if (status !== "confirmed") {
        return false;
    }
    return ((relationship.sourceEntityId === senderEntityId &&
        relationship.targetEntityId === canonicalOwnerId) ||
        (relationship.sourceEntityId === canonicalOwnerId &&
            relationship.targetEntityId === senderEntityId));
}
async function senderMatchesCanonicalOwner(runtime, message, canonicalOwnerId) {
    const senderEntityId = String(message.entityId);
    if (senderEntityId === canonicalOwnerId) {
        return true;
    }
    const ownerEntity = await getEntity(runtime, canonicalOwnerId);
    const ownerMetadata = ownerEntity?.metadata && typeof ownerEntity.metadata === "object"
        ? ownerEntity.metadata
        : undefined;
    if (ownerMetadata) {
        const senderEntity = await getEntity(runtime, senderEntityId);
        const senderMetadataCandidates = [
            extractMessageConnectorMetadata(message),
            extractLiveMessageMetadata(message),
            senderEntity?.metadata && typeof senderEntity.metadata === "object"
                ? senderEntity.metadata
                : undefined,
        ];
        for (const senderMetadata of senderMetadataCandidates) {
            if (sharesConnectorIdentity(senderMetadata, ownerMetadata)) {
                return true;
            }
        }
    }
    if (typeof runtime.getRelationships !== "function") {
        return false;
    }
    const relationships = (await runtime.getRelationships({
        entityIds: [senderEntityId],
        tags: [IDENTITY_LINK_TAG],
    }));
    return relationships.some((relationship) => isConfirmedIdentityLink(relationship, senderEntityId, canonicalOwnerId));
}
export async function checkSenderRole(runtime, message) {
    try {
        const metadata = await resolveWorldForMessage(runtime, message);
        if (!metadata) {
            return null;
        }
        const senderEntityId = String(message.entityId);
        const canonicalOwnerId = resolveCanonicalOwnerId(runtime, metadata);
        let role;
        if (canonicalOwnerId &&
            (await senderMatchesCanonicalOwner(runtime, message, canonicalOwnerId))) {
            role = "OWNER";
        }
        else {
            const storedRole = normalizeRole(metadata.roles?.[senderEntityId]);
            role =
                canonicalOwnerId &&
                    storedRole === "OWNER" &&
                    senderEntityId !== canonicalOwnerId
                    ? "GUEST"
                    : storedRole;
        }
        const isAdmin = role === "OWNER" || role === "ADMIN";
        return {
            entityId: senderEntityId,
            role,
            isOwner: role === "OWNER",
            isAdmin,
            canManageRoles: isAdmin,
            hasPrivateAccess: isAdmin,
        };
    }
    catch {
        return null;
    }
}
