import { createUniqueUuid } from "./entities";
import { logger } from "./logger";
import type { IAgentRuntime, Memory, Role, UUID, World } from "./types";
import { formatError } from "./utils/format-error";
import { asRecordOrUndefined as asRecord } from "./utils/type-guards";

const DEFAULT_SERVER_ROLE: Role = "NONE";

export type RoleName = "OWNER" | "ADMIN" | "USER" | "GUEST";

export type RoleGrantSource = "owner" | "manual" | "connector_admin";

export const ROLE_RANK: Record<RoleName, number> = {
	GUEST: 0,
	USER: 1,
	ADMIN: 2,
	OWNER: 3,
};

export type RolesWorldMetadata = {
	ownership?: { ownerId?: string };
	roles?: Record<string, RoleName>;
	roleSources?: Record<string, RoleGrantSource>;
};

export type ConnectorAdminWhitelist = Record<string, string[]>;

export type RolesConfig = {
	connectorAdmins?: ConnectorAdminWhitelist;
};

export type RoleCheckResult = {
	entityId: UUID;
	role: RoleName;
	isOwner: boolean;
	isAdmin: boolean;
	canManageRoles: boolean;
};

export interface ServerOwnershipState {
	servers: {
		[serverId: string]: World;
	};
}

const CONNECTOR_ADMINS_SETTING_KEY = "ELIZA_ROLES_CONNECTOR_ADMINS_JSON";
const CANONICAL_OWNER_SETTING_KEY = "ELIZA_ADMIN_ENTITY_ID";
const OWNER_CONTACTS_SETTING_KEY = "ELIZA_OWNER_CONTACTS_JSON";
const CONNECTOR_ID_FIELDS = ["userId", "id", "username", "userName"] as const;
const CONNECTOR_STABLE_ID_FIELDS = ["userId", "id"] as const;
type ConnectorIdField = (typeof CONNECTOR_ID_FIELDS)[number];
type ConnectorAdminMatch = {
	connector: string;
	matchedValue: string;
	matchedField: ConnectorIdField;
};

type ResolveEntityRoleOptions = {
	liveEntityMetadata?: Record<string, unknown> | null;
	liveEntityId?: string;
};

type OwnerContactEntry = {
	entityId?: string;
};

function asStringArray(value: unknown): string[] {
	if (!Array.isArray(value)) return [];
	return value
		.filter((entry): entry is string => typeof entry === "string")
		.map((entry) => entry.trim())
		.filter(Boolean);
}

function normalizeConnectorAdminWhitelist(
	whitelist: ConnectorAdminWhitelist | Record<string, unknown> | undefined,
): ConnectorAdminWhitelist {
	if (!whitelist || typeof whitelist !== "object") return {};

	return Object.fromEntries(
		Object.entries(whitelist)
			.map(([connector, values]) => [connector, asStringArray(values)])
			.filter(([, values]) => values.length > 0),
	);
}

function normalizeRoleGrantSource(
	raw: string | undefined | null,
): RoleGrantSource | null {
	if (raw === "owner" || raw === "manual" || raw === "connector_admin") {
		return raw;
	}
	return null;
}

function getRuntimeSettingString(
	runtime: IAgentRuntime,
	key: string,
): string | undefined {
	if (typeof runtime.getSetting !== "function") {
		return undefined;
	}

	const value = runtime.getSetting(key);
	if (typeof value !== "string") {
		return undefined;
	}

	const trimmed = value.trim();
	return trimmed.length > 0 ? trimmed : undefined;
}

function parseOwnerContactEntityIds(raw: string | undefined): string[] {
	if (!raw) {
		return [];
	}

	try {
		const parsed = JSON.parse(raw) as Record<string, OwnerContactEntry>;
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
			return [];
		}

		return Object.values(parsed)
			.map((entry) =>
				entry && typeof entry.entityId === "string"
					? entry.entityId.trim()
					: "",
			)
			.filter((entityId) => entityId.length > 0);
	} catch (error) {
		logger.warn(
			`[roles] Failed to parse owner contacts from runtime settings: ${formatError(error)}`,
		);
		return [];
	}
}

function getMemoryMetadata(
	message: Memory,
): Record<string, unknown> | undefined {
	return asRecord((message as Memory & { metadata?: unknown }).metadata);
}

function getMessageSource(message: Memory): string | undefined {
	return typeof message.content?.source === "string"
		? message.content.source
		: undefined;
}

function getConnectorMetadataFromMemory(
	message: Memory,
): Record<string, unknown> | undefined {
	const memoryMetadata = getMemoryMetadata(message);
	const source = getMessageSource(message);
	if (!source) {
		return undefined;
	}

	const sourceMetadata = asRecord(memoryMetadata?.[source]);
	if (sourceMetadata) {
		return { [source]: sourceMetadata };
	}

	if (source === "discord") {
		const fromId = memoryMetadata?.fromId;
		if (typeof fromId !== "string" || fromId.trim().length === 0) {
			return undefined;
		}

		const entityName =
			typeof memoryMetadata?.entityName === "string"
				? memoryMetadata.entityName
				: undefined;

		return {
			discord: {
				userId: fromId,
				id: fromId,
				...(entityName ? { name: entityName, username: entityName } : {}),
			},
		};
	}

	return undefined;
}

async function getEntityMetadata(
	runtime: IAgentRuntime,
	entityId: string,
): Promise<Record<string, unknown> | undefined> {
	if (typeof runtime.getEntityById !== "function") {
		return undefined;
	}

	try {
		const entity = await runtime.getEntityById(entityId as UUID);
		return asRecord(entity?.metadata);
	} catch (error) {
		logger.warn(
			`[roles] Failed to look up entity ${entityId}: ${formatError(error)}`,
		);
		return undefined;
	}
}

export async function getUserServerRole(
	runtime: IAgentRuntime,
	entityId: string,
	serverId: string,
): Promise<Role> {
	const worldId = createUniqueUuid(runtime, serverId);
	const world = await runtime.getWorld(worldId);

	const worldMetadata = world?.metadata;
	const roles = worldMetadata?.roles;
	if (!roles) {
		return DEFAULT_SERVER_ROLE;
	}

	const role = roles[entityId as UUID];
	if (role) {
		return role;
	}

	return DEFAULT_SERVER_ROLE;
}

export async function findWorldsForOwner(
	runtime: IAgentRuntime,
	entityId: string,
): Promise<World[] | null> {
	if (!entityId) {
		logger.error(
			{ src: "core:roles", agentId: runtime.agentId },
			"User ID is required to find server",
		);
		return null;
	}

	const worlds = await runtime.getAllWorlds();

	if (!worlds || worlds.length === 0) {
		logger.debug(
			{ src: "core:roles", agentId: runtime.agentId },
			"No worlds found for agent",
		);
		return null;
	}

	const ownerWorlds: World[] = [];
	for (const world of worlds) {
		const worldMetadata = world.metadata;
		const worldMetadataOwnership = worldMetadata?.ownership;
		if (worldMetadataOwnership && worldMetadataOwnership.ownerId === entityId) {
			ownerWorlds.push(world);
		}
	}

	return ownerWorlds.length ? ownerWorlds : null;
}

export function getConfiguredOwnerEntityIds(runtime: IAgentRuntime): string[] {
	const configuredAdminEntityId = getRuntimeSettingString(
		runtime,
		CANONICAL_OWNER_SETTING_KEY,
	);
	const ownerContactsRaw = getRuntimeSettingString(
		runtime,
		OWNER_CONTACTS_SETTING_KEY,
	);
	const ownerContactEntityIds = parseOwnerContactEntityIds(ownerContactsRaw);
	const deduped = new Set<string>();

	if (configuredAdminEntityId) {
		deduped.add(configuredAdminEntityId);
	}

	for (const entityId of ownerContactEntityIds) {
		deduped.add(entityId);
	}

	return [...deduped];
}

export function hasConfiguredCanonicalOwner(runtime: IAgentRuntime): boolean {
	return getConfiguredOwnerEntityIds(runtime).length > 0;
}

export function resolveCanonicalOwnerId(
	runtime: IAgentRuntime,
	metadata?: RolesWorldMetadata,
): string | null {
	const configuredOwnerIds = getConfiguredOwnerEntityIds(runtime);
	if (configuredOwnerIds.length > 0) {
		return configuredOwnerIds[0] ?? null;
	}

	const worldOwnerId = metadata?.ownership?.ownerId;
	return typeof worldOwnerId === "string" && worldOwnerId.length > 0
		? worldOwnerId
		: null;
}

function resolveOwnershipCandidateIds(
	runtime: IAgentRuntime,
	metadata?: RolesWorldMetadata,
): string[] {
	const configuredOwnerIds = getConfiguredOwnerEntityIds(runtime);
	if (configuredOwnerIds.length > 0) {
		return configuredOwnerIds;
	}

	const ownerId = resolveCanonicalOwnerId(runtime, metadata);
	return ownerId ? [ownerId] : [];
}

function connectorIdentityMatches(
	left: Record<string, unknown> | null | undefined,
	right: Record<string, unknown> | null | undefined,
): boolean {
	if (!left || !right) return false;

	for (const [connector, leftRaw] of Object.entries(left)) {
		const leftConnector = asRecord(leftRaw);
		const rightConnector = asRecord(right[connector]);
		if (!leftConnector || !rightConnector) {
			continue;
		}

		for (const field of CONNECTOR_STABLE_ID_FIELDS) {
			const leftValue = leftConnector[field];
			const rightValue = rightConnector[field];
			if (
				typeof leftValue === "string" &&
				leftValue.length > 0 &&
				leftValue === rightValue
			) {
				return true;
			}
		}
	}

	return false;
}

async function hasConfirmedIdentityLink(
	runtime: IAgentRuntime,
	entityId: string,
	ownerId: string,
): Promise<boolean> {
	const linkedIds = await getConfirmedLinkedEntityIds(runtime, entityId);
	return linkedIds.includes(ownerId);
}

async function getConfirmedLinkedEntityIds(
	runtime: IAgentRuntime,
	entityId: string,
): Promise<string[]> {
	if (typeof runtime.getRelationships !== "function") {
		return [];
	}

	try {
		const relationships = await runtime.getRelationships({
			entityIds: [entityId as UUID],
			tags: ["identity_link"],
		});

		const linkedIds = new Set<string>();
		for (const relationship of relationships) {
			const metadata = asRecord(relationship.metadata);
			if (metadata?.status !== "confirmed") {
				continue;
			}

			if (
				relationship.sourceEntityId === entityId &&
				typeof relationship.targetEntityId === "string"
			) {
				linkedIds.add(relationship.targetEntityId);
			}
			if (
				relationship.targetEntityId === entityId &&
				typeof relationship.sourceEntityId === "string"
			) {
				linkedIds.add(relationship.sourceEntityId);
			}
		}

		return [...linkedIds];
	} catch (error) {
		logger.warn(
			`[roles] Failed to load identity links for ${entityId}: ${formatError(error)}`,
		);
		return [];
	}
}

async function resolveOwnershipRole(
	runtime: IAgentRuntime,
	metadata: RolesWorldMetadata | undefined,
	entityId: string,
	options?: ResolveEntityRoleOptions,
): Promise<RoleName | null> {
	const ownerIds = resolveOwnershipCandidateIds(runtime, metadata);
	if (ownerIds.length === 0) {
		return null;
	}

	const senderMetadata =
		options?.liveEntityMetadata ?? (await getEntityMetadata(runtime, entityId));

	for (const ownerId of ownerIds) {
		if (ownerId === entityId) {
			return "OWNER";
		}

		if (await hasConfirmedIdentityLink(runtime, entityId, ownerId)) {
			return "OWNER";
		}

		const ownerMetadata = await getEntityMetadata(runtime, ownerId);
		if (!ownerMetadata) {
			continue;
		}

		if (connectorIdentityMatches(senderMetadata, ownerMetadata)) {
			return "OWNER";
		}
	}

	return null;
}

function resolveWorldIdFromMessageMetadata(
	runtime: IAgentRuntime,
	message: Memory,
): UUID | null {
	const source = getMessageSource(message);
	const metadata = getMemoryMetadata(message);
	if (source === "discord") {
		const serverId =
			typeof metadata?.discordServerId === "string"
				? metadata.discordServerId
				: typeof metadata?.discordChannelId === "string"
					? metadata.discordChannelId
					: null;

		if (!serverId) {
			return null;
		}

		return createUniqueUuid(runtime, serverId) as UUID;
	}

	return null;
}

export function setConnectorAdminWhitelist(
	runtime: IAgentRuntime,
	whitelist: ConnectorAdminWhitelist | Record<string, unknown> | undefined,
): void {
	if (typeof runtime.setSetting !== "function") {
		return;
	}

	const normalized = normalizeConnectorAdminWhitelist(whitelist);
	if (Object.keys(normalized).length === 0) {
		runtime.setSetting(CONNECTOR_ADMINS_SETTING_KEY, null);
		return;
	}

	runtime.setSetting(CONNECTOR_ADMINS_SETTING_KEY, JSON.stringify(normalized));
}

export function getConnectorAdminWhitelist(
	runtime: IAgentRuntime,
): ConnectorAdminWhitelist {
	const raw = getRuntimeSettingString(runtime, CONNECTOR_ADMINS_SETTING_KEY);
	if (!raw) {
		return {};
	}

	try {
		const parsed = JSON.parse(raw) as Record<string, unknown>;
		return normalizeConnectorAdminWhitelist(parsed);
	} catch (error) {
		logger.warn(
			`[roles] Failed to parse ${CONNECTOR_ADMINS_SETTING_KEY}: ${formatError(error)}`,
		);
		return {};
	}
}

export function matchEntityToConnectorAdminWhitelist(
	entityMetadata: Record<string, unknown> | null | undefined,
	whitelist: ConnectorAdminWhitelist | Record<string, unknown> | undefined,
): ConnectorAdminMatch | null {
	if (!entityMetadata || typeof entityMetadata !== "object") return null;

	const normalizedWhitelist = normalizeConnectorAdminWhitelist(whitelist);
	for (const [connector, platformIds] of Object.entries(normalizedWhitelist)) {
		const connectorMeta = asRecord(entityMetadata[connector]);
		if (!connectorMeta) {
			continue;
		}

		for (const field of CONNECTOR_ID_FIELDS) {
			const value = connectorMeta[field];
			if (typeof value === "string" && platformIds.includes(value)) {
				return { connector, matchedValue: value, matchedField: field };
			}
		}
	}

	return null;
}

export function normalizeRole(raw: string | undefined | null): RoleName {
	const upper = (raw ?? "").toUpperCase();
	if (upper === "OWNER" || upper === "ADMIN" || upper === "USER") return upper;
	return "GUEST";
}

export function getEntityRole(
	metadata: RolesWorldMetadata | undefined,
	entityId: string,
): RoleName {
	if (!metadata?.roles) return "GUEST";
	return normalizeRole(metadata.roles[entityId]);
}

function getStoredRoleSource(
	metadata: RolesWorldMetadata | undefined,
	entityId: string,
): RoleGrantSource | null {
	return normalizeRoleGrantSource(metadata?.roleSources?.[entityId]);
}

async function resolveStoredRoleSource(
	runtime: IAgentRuntime,
	metadata: RolesWorldMetadata | undefined,
	entityId: string,
	options?: ResolveEntityRoleOptions,
): Promise<RoleGrantSource | null> {
	const storedSource = getStoredRoleSource(metadata, entityId);
	if (storedSource) {
		return storedSource;
	}

	const storedRole = getEntityRole(metadata, entityId);
	if (storedRole === "GUEST") {
		return null;
	}
	if (storedRole === "OWNER") {
		return "owner";
	}

	const entityMetadata =
		options?.liveEntityId === entityId
			? (options.liveEntityMetadata ?? undefined)
			: undefined;
	const matchedWhitelist = matchEntityToConnectorAdminWhitelist(
		entityMetadata ?? (await getEntityMetadata(runtime, entityId)),
		getConnectorAdminWhitelist(runtime),
	);

	if (storedRole === "ADMIN" && matchedWhitelist) {
		return "connector_admin";
	}

	return "manual";
}

async function resolveExplicitGrantedRole(
	runtime: IAgentRuntime,
	metadata: RolesWorldMetadata | undefined,
	entityId: string,
	options?: ResolveEntityRoleOptions,
): Promise<{
	role: RoleName;
	source: "manual" | "linked_manual";
} | null> {
	const directRole = getEntityRole(metadata, entityId);
	const directSource = await resolveStoredRoleSource(
		runtime,
		metadata,
		entityId,
		options,
	);
	if (directRole !== "GUEST" && directSource === "manual") {
		return { role: directRole, source: "manual" };
	}

	const linkedIds = await getConfirmedLinkedEntityIds(runtime, entityId);
	let bestRole: RoleName | null = null;

	for (const linkedEntityId of linkedIds) {
		const linkedRole = getEntityRole(metadata, linkedEntityId);
		if (linkedRole === "GUEST") {
			continue;
		}
		const linkedSource = await resolveStoredRoleSource(
			runtime,
			metadata,
			linkedEntityId,
		);
		if (linkedSource !== "manual") {
			continue;
		}
		if (!bestRole || ROLE_RANK[linkedRole] > ROLE_RANK[bestRole]) {
			bestRole = linkedRole;
		}
	}

	return bestRole ? { role: bestRole, source: "linked_manual" } : null;
}

export function getLiveEntityMetadataFromMessage(
	message: Memory,
): Record<string, unknown> | undefined {
	// Only trust connector identity stamped into the Memory itself.
	// content.metadata can come from untrusted chat clients, so it must not
	// participate in role resolution.
	return getConnectorMetadataFromMemory(message);
}

export async function resolveEntityRole(
	runtime: IAgentRuntime,
	_world: Awaited<ReturnType<IAgentRuntime["getWorld"]>>,
	metadata: RolesWorldMetadata | undefined,
	entityId: string,
	options?: ResolveEntityRoleOptions,
): Promise<RoleName> {
	const explicitRole = getEntityRole(metadata, entityId);
	const explicitSource = await resolveStoredRoleSource(
		runtime,
		metadata,
		entityId,
		options,
	);
	const ownershipRole = await resolveOwnershipRole(
		runtime,
		metadata,
		entityId,
		options,
	);

	if (ownershipRole === "OWNER") {
		return "OWNER";
	}

	const whitelist = getConnectorAdminWhitelist(runtime);
	const liveMatched = matchEntityToConnectorAdminWhitelist(
		options?.liveEntityMetadata ?? undefined,
		whitelist,
	);

	if (explicitRole !== "GUEST") {
		if (explicitRole === "OWNER") {
			return hasConfiguredCanonicalOwner(runtime) ? "GUEST" : "OWNER";
		}

		if (explicitSource === "connector_admin") {
			if (Object.keys(whitelist).length === 0) {
				return "GUEST";
			}

			if (liveMatched) {
				return "ADMIN";
			}

			const entityMetadata = await getEntityMetadata(runtime, entityId);
			const matched = matchEntityToConnectorAdminWhitelist(
				entityMetadata,
				whitelist,
			);
			if (matched) {
				return "ADMIN";
			}

			return "GUEST";
		}

		return explicitRole;
	}

	if (Object.keys(whitelist).length === 0) {
		return explicitRole;
	}

	if (liveMatched) {
		return "ADMIN";
	}

	const entityMetadata = await getEntityMetadata(runtime, entityId);
	const matched = matchEntityToConnectorAdminWhitelist(
		entityMetadata,
		whitelist,
	);
	if (!matched) {
		return explicitRole;
	}

	return "ADMIN";
}

export async function checkSenderPrivateAccess(
	runtime: IAgentRuntime,
	message: Memory,
): Promise<{
	entityId: UUID;
	role: RoleName;
	isOwner: boolean;
	isAdmin: boolean;
	canManageRoles: boolean;
	hasPrivateAccess: boolean;
	accessRole: RoleName | null;
	accessSource: "owner" | "manual" | "linked_manual" | null;
} | null> {
	const resolved = await resolveWorldForMessage(runtime, message);
	if (!resolved) return null;

	const { world, metadata } = resolved;
	const entityId = message.entityId as UUID;
	const options = {
		liveEntityMetadata: getLiveEntityMetadataFromMessage(message),
		liveEntityId: entityId,
	};
	const role = await resolveEntityRole(
		runtime,
		world,
		metadata,
		entityId,
		options,
	);
	const ownershipRole = await resolveOwnershipRole(
		runtime,
		metadata,
		entityId,
		options,
	);

	if (ownershipRole === "OWNER") {
		return {
			entityId,
			role,
			isOwner: true,
			isAdmin: true,
			canManageRoles: true,
			hasPrivateAccess: true,
			accessRole: "OWNER",
			accessSource: "owner",
		};
	}

	const explicitAccess = await resolveExplicitGrantedRole(
		runtime,
		metadata,
		entityId,
		options,
	);

	return {
		entityId,
		role,
		isOwner: false,
		isAdmin: role === "OWNER" || role === "ADMIN",
		canManageRoles: role === "OWNER" || role === "ADMIN",
		hasPrivateAccess: explicitAccess !== null,
		accessRole: explicitAccess?.role ?? null,
		accessSource: explicitAccess?.source ?? null,
	};
}

export function canModifyRole(
	actorRole: RoleName,
	targetCurrentRole: RoleName,
	newRole: RoleName,
): boolean {
	if (targetCurrentRole === newRole) return false;
	const actorRank = ROLE_RANK[actorRole];
	const targetRank = ROLE_RANK[targetCurrentRole];
	if (actorRole === "OWNER") return true;
	if (actorRole === "ADMIN") {
		if (targetRank >= actorRank) return false;
		if (newRole === "OWNER") return false;
		return true;
	}
	return false;
}

export async function resolveWorldForMessage(
	runtime: IAgentRuntime,
	message: Memory,
): Promise<{
	world: Awaited<ReturnType<IAgentRuntime["getWorld"]>>;
	metadata: RolesWorldMetadata;
} | null> {
	const room = await runtime.getRoom(message.roomId);
	const worldId =
		room?.worldId ?? resolveWorldIdFromMessageMetadata(runtime, message);
	if (!worldId) return null;
	const world = await runtime.getWorld(worldId);
	if (!world) return null;
	const metadata = (world.metadata ?? {}) as RolesWorldMetadata;
	return { world, metadata };
}

export async function resolveCanonicalOwnerIdForMessage(
	runtime: IAgentRuntime,
	message: Memory,
): Promise<string | null> {
	const configuredOwnerId = resolveCanonicalOwnerId(runtime);
	if (configuredOwnerId) {
		return configuredOwnerId;
	}

	const resolved = await resolveWorldForMessage(runtime, message);
	return resolveCanonicalOwnerId(runtime, resolved?.metadata);
}

export async function checkSenderRole(
	runtime: IAgentRuntime,
	message: Memory,
): Promise<RoleCheckResult | null> {
	const resolved = await resolveWorldForMessage(runtime, message);
	if (!resolved) return null;
	const { world, metadata } = resolved;
	const entityId = message.entityId as UUID;
	const role = await resolveEntityRole(runtime, world, metadata, entityId, {
		liveEntityMetadata: getLiveEntityMetadataFromMessage(message),
		liveEntityId: entityId,
	});
	return {
		entityId,
		role,
		isOwner: role === "OWNER",
		isAdmin: role === "OWNER" || role === "ADMIN",
		canManageRoles: role === "OWNER" || role === "ADMIN",
	};
}

type AccessContext = {
	runtime: IAgentRuntime & { agentId: string };
	message: Memory & { entityId: string };
};

function getAccessContext(
	runtime: IAgentRuntime | undefined,
	message: Memory | undefined,
): AccessContext | null {
	if (
		!runtime ||
		typeof runtime.agentId !== "string" ||
		!message ||
		typeof message.entityId !== "string" ||
		message.entityId.length === 0
	) {
		return null;
	}

	return { runtime, message };
}

export function isAgentSelf(
	runtime: IAgentRuntime | undefined,
	message: Memory | undefined,
): boolean {
	const context = getAccessContext(runtime, message);
	if (!context) {
		return false;
	}
	return context.message.entityId === context.runtime.agentId;
}

async function isCanonicalOwner(
	runtime: IAgentRuntime,
	message: Memory,
): Promise<boolean> {
	try {
		const ownerId = await resolveCanonicalOwnerIdForMessage(runtime, message);
		return typeof ownerId === "string" && ownerId === message.entityId;
	} catch {
		return false;
	}
}

/**
 * Check whether the sender has at least the given role in the elizaOS
 * role hierarchy (OWNER > ADMIN > USER > GUEST).
 *
 * When there is no world context (for example local API calls), allow through
 * so local-only usage follows the same lenient path as plugin role gating.
 */
export async function hasRoleAccess(
	runtime: IAgentRuntime | undefined,
	message: Memory | undefined,
	requiredRole: RoleName,
): Promise<boolean> {
	if (requiredRole === "GUEST") {
		return true;
	}

	const context = getAccessContext(runtime, message);
	if (!context) {
		return true;
	}

	if (isAgentSelf(context.runtime, context.message)) {
		return true;
	}

	if (await isCanonicalOwner(context.runtime, context.message)) {
		return true;
	}

	try {
		const result = await checkSenderRole(context.runtime, context.message);
		if (!result) {
			return true;
		}

		const senderRank = ROLE_RANK[result.role] ?? 0;
		const requiredRank = ROLE_RANK[requiredRole] ?? 0;
		return senderRank >= requiredRank;
	} catch {
		return false;
	}
}

export async function setEntityRole(
	runtime: IAgentRuntime,
	message: Memory,
	targetEntityId: string,
	newRole: RoleName,
	source: RoleGrantSource = "manual",
): Promise<Record<string, RoleName>> {
	const resolved = await resolveWorldForMessage(runtime, message);
	if (!resolved) throw new Error("Cannot resolve world for role assignment");
	const { world, metadata } = resolved;
	if (!metadata.roles) metadata.roles = {};
	metadata.roleSources ??= {};
	metadata.roles[targetEntityId] = newRole;
	if (newRole === "GUEST") {
		delete metadata.roleSources[targetEntityId];
	} else {
		metadata.roleSources[targetEntityId] = source;
	}
	(world as { metadata: RolesWorldMetadata }).metadata = metadata;
	await runtime.updateWorld(
		world as Parameters<IAgentRuntime["updateWorld"]>[0],
	);
	return { ...metadata.roles };
}
