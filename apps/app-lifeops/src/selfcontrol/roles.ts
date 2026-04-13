import type { IAgentRuntime, Memory } from "@elizaos/core";

const CANONICAL_OWNER_SETTING_KEY = "ELIZA_ADMIN_ENTITY_ID";
const IDENTITY_LINK_TAG = "identity_link";

type RoleName = "OWNER" | "ADMIN" | "USER" | "GUEST";

type RolesWorldMetadata = {
  ownership?: { ownerId?: string };
  roles?: Record<string, RoleName | string>;
  [key: string]: unknown;
};

type RelationshipLike = {
  sourceEntityId?: string;
  targetEntityId?: string;
  tags?: string[];
  metadata?: Record<string, unknown> | null;
};

type EntityLike = {
  metadata?: Record<string, unknown> | null;
};

type ConnectorIdentity = {
  connector: string;
  values: Set<string>;
};

export type RoleCheckResult = {
  entityId: string;
  role: RoleName;
  isOwner: boolean;
  isAdmin: boolean;
  canManageRoles: boolean;
  hasPrivateAccess: boolean;
};

function normalizeRole(role: unknown): RoleName {
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

function resolveCanonicalOwnerId(
  runtime: IAgentRuntime,
  metadata?: RolesWorldMetadata,
): string | null {
  if (typeof runtime.getSetting === "function") {
    const configured = runtime.getSetting(CANONICAL_OWNER_SETTING_KEY);
    if (typeof configured === "string" && configured.trim().length > 0) {
      return configured.trim();
    }
  }

  return metadata?.ownership?.ownerId ?? null;
}

async function resolveWorldForMessage(
  runtime: IAgentRuntime,
  message: Memory,
): Promise<RolesWorldMetadata | null> {
  const room = await runtime.getRoom(message.roomId);
  if (!room?.worldId) {
    return null;
  }

  const world = await runtime.getWorld(room.worldId);
  if (!world) {
    return null;
  }

  return (world.metadata ?? {}) as RolesWorldMetadata;
}

function normalizeIdentityValue(value: unknown): string | null {
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

function collectConnectorIdentities(
  metadata: Record<string, unknown> | null | undefined,
): ConnectorIdentity[] {
  if (!metadata) {
    return [];
  }

  const identities: ConnectorIdentity[] = [];
  for (const [connector, rawConnectorData] of Object.entries(metadata)) {
    if (!rawConnectorData || typeof rawConnectorData !== "object") {
      continue;
    }

    const connectorData = rawConnectorData as Record<string, unknown>;
    const values = new Set<string>();
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

function extractLiveMessageMetadata(
  message: Memory,
): Record<string, unknown> | undefined {
  const metadata = (message.content as Record<string, unknown>)?.metadata;
  if (metadata && typeof metadata === "object" && !Array.isArray(metadata)) {
    return metadata as Record<string, unknown>;
  }

  return undefined;
}

function extractMessageConnectorMetadata(
  message: Memory,
): Record<string, unknown> | undefined {
  const metadata = (message as Memory & { metadata?: Record<string, unknown> })
    .metadata;
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
    return undefined;
  }

  const source = typeof message.content?.source === "string"
    ? message.content.source
    : undefined;
  const result: Record<string, unknown> = {};

  const fromId =
    metadata.fromId ??
    metadata.discordUserId ??
    metadata.telegramUserId ??
    metadata.userId ??
    metadata.id;
  const username = metadata.username ?? metadata.telegramUsername;

  if (
    source === "discord" ||
    typeof metadata.discordServerId === "string" ||
    typeof metadata.discordChannelId === "string"
  ) {
    result.discord = {
      userId: fromId,
      username,
    };
  }

  if (
    source === "telegram" ||
    typeof metadata.telegramChatId === "string" ||
    typeof metadata.telegramUserId === "string"
  ) {
    result.telegram = {
      id: fromId,
      username,
    };
  }

  return Object.keys(result).length > 0 ? result : undefined;
}

function sharesConnectorIdentity(
  left: Record<string, unknown> | null | undefined,
  right: Record<string, unknown> | null | undefined,
): boolean {
  if (!left || !right) {
    return false;
  }

  const leftIdentities = collectConnectorIdentities(left);
  const rightByConnector = new Map(
    collectConnectorIdentities(right).map((identity) => [
      identity.connector,
      identity.values,
    ]),
  );

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

async function getEntity(
  runtime: IAgentRuntime,
  entityId: string,
): Promise<EntityLike | null> {
  if (typeof runtime.getEntityById !== "function") {
    return null;
  }

  const entity = await runtime.getEntityById(entityId);
  return entity ? (entity as EntityLike) : null;
}

function isConfirmedIdentityLink(
  relationship: RelationshipLike,
  senderEntityId: string,
  canonicalOwnerId: string,
): boolean {
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

  return (
    (relationship.sourceEntityId === senderEntityId &&
      relationship.targetEntityId === canonicalOwnerId) ||
    (relationship.sourceEntityId === canonicalOwnerId &&
      relationship.targetEntityId === senderEntityId)
  );
}

async function senderMatchesCanonicalOwner(
  runtime: IAgentRuntime,
  message: Memory,
  canonicalOwnerId: string,
): Promise<boolean> {
  const senderEntityId = String(message.entityId);
  if (senderEntityId === canonicalOwnerId) {
    return true;
  }

  const ownerEntity = await getEntity(runtime, canonicalOwnerId);
  const ownerMetadata =
    ownerEntity?.metadata && typeof ownerEntity.metadata === "object"
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
  })) as RelationshipLike[];

  return relationships.some((relationship) =>
    isConfirmedIdentityLink(relationship, senderEntityId, canonicalOwnerId),
  );
}

export async function checkSenderRole(
  runtime: IAgentRuntime,
  message: Memory,
): Promise<RoleCheckResult | null> {
  try {
    const metadata = await resolveWorldForMessage(runtime, message);
    if (!metadata) {
      return null;
    }

    const senderEntityId = String(message.entityId);
    const canonicalOwnerId = resolveCanonicalOwnerId(runtime, metadata);

    let role: RoleName;
    if (
      canonicalOwnerId &&
      (await senderMatchesCanonicalOwner(runtime, message, canonicalOwnerId))
    ) {
      role = "OWNER";
    } else {
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
  } catch {
    return null;
  }
}
