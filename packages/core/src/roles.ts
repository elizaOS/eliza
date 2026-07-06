/**
 * The agent's role/permission authorization system: the OWNER > ADMIN > USER >
 * GUEST tier vocabulary, the canonical rank table every gate compares against,
 * and the resolution that turns a sender + world into an effective role. A role
 * is merged here from four sources — an explicit grant stored on world metadata
 * (`roles`/`roleSources`), the configured or world-recorded canonical owner, a
 * connector-admin whitelist match on a stable platform id, and confirmed
 * identity links that let a linked entity inherit the owner/grant. `canModifyRole`
 * is the privilege-escalation gate (OWNER may change anyone; ADMIN only
 * strictly-lower ranks and never grants OWNER); `hasRoleAccess` is the read-time
 * gate callers use to admit or deny an action.
 *
 * Consumed by access-context.ts, the runtime context-gates, and plugin-manager
 * security wrappers. Load-bearing invariants an editor must preserve: rank lives
 * only in CANONICAL_ROLE_RANK, shared with runtime/context-gates.ts so the two
 * never drift (#9948); MEMBER is an alias of USER, not a demotion to GUEST, so
 * both resolution paths agree (#12087 Item 6); resolution trusts ONLY connector
 * identity stamped into the Memory, never client-supplied content.metadata; and
 * every access check fails CLOSED — an unknown role ranks below GUEST and an
 * unresolvable connector sender is treated as GUEST while local/API messages
 * keep the USER fallback they historically used. Owner and role grants are
 * recorded explicitly with their source so they stay auditable.
 */
import {
	getConnectorIdentityMetadataMapping,
	getConnectorWorldIdMetadataKeys,
	normalizeConnectorSource,
} from "./connectors.ts";
import { createUniqueUuid } from "./entities";
import { logger } from "./logger";
import type { IAgentRuntime, Memory, UUID, World } from "./types";
import {
	MESSAGE_SOURCE_AGENT_GREETING,
	MESSAGE_SOURCE_CLIENT_CHAT,
	MESSAGE_SOURCE_CODING_AGENT,
	MESSAGE_SOURCE_SUB_AGENT,
} from "./types/message-source";
import { formatError } from "./utils/format-error";
import { asRecordOrUndefined as asRecord } from "./utils/type-guards";

export type RoleName = "OWNER" | "ADMIN" | "USER" | "GUEST";

export type RoleGrantSource = "owner" | "manual" | "connector_admin";

/**
 * Canonical rank for every role tier across the codebase — the single source of
 * truth for role ordering (#9948). It spans both vocabularies that historically
 * disagreed: the `NONE` floor and the `MEMBER` alias (`environment.ts` `Role`)
 * plus `USER`/`GUEST` (`RoleName`). `USER` and `MEMBER` are the same tier.
 *
 * `roles.ts` and `runtime/context-gates.ts` both derive their ranking from this
 * constant rather than each keeping a private rank literal — two rank tables
 * that could silently drift apart is the authz hazard #9948 calls out.
 */
export const CANONICAL_ROLE_RANK = {
	NONE: 0,
	GUEST: 1,
	USER: 2,
	MEMBER: 2,
	ADMIN: 3,
	OWNER: 4,
} as const;

export const ROLE_RANK: Record<RoleName, number> = {
	GUEST: CANONICAL_ROLE_RANK.GUEST,
	USER: CANONICAL_ROLE_RANK.USER,
	ADMIN: CANONICAL_ROLE_RANK.ADMIN,
	OWNER: CANONICAL_ROLE_RANK.OWNER,
};

/**
 * True iff `role` ranks at least `minRole` on {@link CANONICAL_ROLE_RANK}. The
 * rank-aware replacement for the scattered `isAdminRank(role)`
 * string comparisons (#12087 Item 31) — those silently miss any tier added between
 * ADMIN and OWNER and don't recognize the MEMBER/USER aliasing. Unknown/empty roles
 * fall to the NONE floor (rank 0), so the predicate fails closed.
 */
export function hasAtLeastRole(
	role: string | undefined | null,
	minRole: keyof typeof CANONICAL_ROLE_RANK,
): boolean {
	const rank =
		CANONICAL_ROLE_RANK[
			(role ?? "").toUpperCase() as keyof typeof CANONICAL_ROLE_RANK
		] ?? 0;
	return rank >= CANONICAL_ROLE_RANK[minRole];
}

/** True iff `role` is ADMIN-rank or higher (ADMIN or OWNER). #12087 Item 31. */
export function isAdminRank(role: string | undefined | null): boolean {
	return hasAtLeastRole(role, "ADMIN");
}

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
const CONNECTOR_STABLE_ID_FIELDS = ["userId", "id"] as const;
type ConnectorStableIdField = (typeof CONNECTOR_STABLE_ID_FIELDS)[number];
type ConnectorAdminMatch = {
	connector: string;
	matchedValue: string;
	matchedField: ConnectorStableIdField;
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
	return typeof message.content.source === "string"
		? message.content.source
		: undefined;
}

const LOCAL_UNRESOLVED_ROLE_SOURCES = new Set([
	MESSAGE_SOURCE_CLIENT_CHAT,
	MESSAGE_SOURCE_SUB_AGENT,
	MESSAGE_SOURCE_CODING_AGENT,
	MESSAGE_SOURCE_AGENT_GREETING,
	"api",
	"benchmark",
	"dashboard",
	"deep-link",
	"event",
	"ios-local",
	"local-voice",
	"owner_app",
	"test",
]);

/**
 * Role floor used when a real sender exists but no world role can be resolved.
 * Connector messages must not outrank a fully resolved stranger, so unknown
 * non-local sources fall to GUEST. Local, owner-app, and harness traffic keeps
 * USER so no-world control surfaces keep their historical behavior.
 */
export function getUnresolvedSenderRoleFloor(message: Memory): RoleName {
	const source = getMessageSource(message)?.trim().toLowerCase();
	if (!source || LOCAL_UNRESOLVED_ROLE_SOURCES.has(source)) {
		return "USER";
	}
	return "GUEST";
}

function hasConnectorStableIdentity(
	metadata: Record<string, unknown> | null | undefined,
): boolean {
	if (!metadata) {
		return false;
	}

	for (const rawConnector of Object.values(metadata)) {
		const connector = asRecord(rawConnector);
		if (!connector) {
			continue;
		}

		for (const field of CONNECTOR_STABLE_ID_FIELDS) {
			const value = connector[field];
			if (typeof value === "string" && value.trim().length > 0) {
				return true;
			}
		}
	}

	return false;
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
		const nestedMetadata = { [source]: sourceMetadata };
		if (hasConnectorStableIdentity(nestedMetadata)) {
			return nestedMetadata;
		}
	}

	// No nested `metadata[source]` object present. Fall back to the connector's
	// DECLARED flat-field -> identity projection from the connector-source
	// registry (owner metadata), instead of a connector-specific literal branch
	// baked into core (#12090 item 22 / #12087). The Discord legacy mapping
	// (fromId/entityName) is registered as connector-owned metadata in
	// connectors.ts, so this path is generic across connectors.
	const mapping = getConnectorIdentityMetadataMapping(source);
	if (!mapping) {
		return undefined;
	}

	const userId = memoryMetadata?.[mapping.userIdField];
	if (typeof userId !== "string" || userId.trim().length === 0) {
		return undefined;
	}

	const canonicalSource = normalizeConnectorSource(source) || source;
	const displayName =
		mapping.nameField && typeof memoryMetadata?.[mapping.nameField] === "string"
			? (memoryMetadata[mapping.nameField] as string)
			: undefined;

	return {
		[canonicalSource]: {
			userId,
			id: userId,
			...(displayName ? { name: displayName, username: displayName } : {}),
		},
	};
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

	const liveEntityMetadata = options?.liveEntityMetadata;
	const senderMetadata = hasConnectorStableIdentity(liveEntityMetadata)
		? liveEntityMetadata
		: await getEntityMetadata(runtime, entityId);

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
	if (!source) {
		return null;
	}
	const metadata = getMemoryMetadata(message);

	// Derive the world id from the connector's DECLARED flat world-id keys
	// (registry, owner metadata) instead of a connector-specific literal that
	// hardcodes per-connector world-id fields in core (#12090 item 22 / #12087).
	// The Discord legacy keys are registered as connector-owned metadata in
	// connectors.ts; first present, non-empty string wins.
	const worldIdKeys = getConnectorWorldIdMetadataKeys(source);
	for (const key of worldIdKeys) {
		const value = metadata?.[key];
		if (typeof value === "string" && value.trim().length > 0) {
			return createUniqueUuid(runtime, value) as UUID;
		}
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

		for (const field of CONNECTOR_STABLE_ID_FIELDS) {
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
	// MEMBER is the USER-tier alias (CANONICAL_ROLE_RANK.MEMBER === .USER). Folding
	// it to GUEST here (rank 2 → 1) silently demoted a stored "MEMBER" world role
	// below a `minRole: USER` gate that the context-gate path (normalizeGateRole
	// folds USER→MEMBER) would grant — the #12087 Item 6 asymmetry. Resolve MEMBER
	// to its canonical USER tier so both paths agree.
	if (upper === "MEMBER") return "USER";
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
		isAdmin: isAdminRank(role),
		canManageRoles: isAdminRank(role),
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
		isAdmin: isAdminRank(role),
		canManageRoles: isAdminRank(role),
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

/**
 * Injectable role-resolution seam for {@link hasRoleAccess} (#12087 Item 18).
 * Lets callers (e.g. plugin-manager/security.ts wrappers, and tests) substitute
 * the sender-role check / canonical-owner resolution without monkey-patching the
 * module.
 */
export type RoleAccessDeps = {
	checkSenderRole?: (
		runtime: IAgentRuntime,
		message: Memory,
	) => Promise<RoleCheckResult | null>;
	resolveCanonicalOwnerIdForMessage?: (
		runtime: IAgentRuntime,
		message: Memory,
	) => Promise<string | null | undefined>;
};

async function isCanonicalOwner(
	runtime: IAgentRuntime,
	message: Memory,
	resolveFn: NonNullable<
		RoleAccessDeps["resolveCanonicalOwnerIdForMessage"]
	> = resolveCanonicalOwnerIdForMessage,
): Promise<boolean> {
	try {
		const ownerId = await resolveFn(runtime, message);
		return typeof ownerId === "string" && ownerId === message.entityId;
	} catch {
		return false;
	}
}

/**
 * Check whether the sender has at least the given role in the elizaOS
 * role hierarchy (OWNER > ADMIN > USER > GUEST).
 *
 * When there is no access context at all (no runtime / no sender entity — for
 * example local API calls), allow through so local-only usage follows the same
 * lenient path as plugin role gating. But when there IS a real sender whose
 * role simply cannot be resolved, use the same source-aware floor as Stage 1
 * context filtering.
 */
export async function hasRoleAccess(
	runtime: IAgentRuntime | undefined,
	message: Memory | undefined,
	requiredRole: RoleName,
	deps: RoleAccessDeps = {},
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

	if (
		await isCanonicalOwner(
			context.runtime,
			context.message,
			deps.resolveCanonicalOwnerIdForMessage,
		)
	) {
		return true;
	}

	const checkRoleFn = deps.checkSenderRole ?? checkSenderRole;
	try {
		const result = await checkRoleFn(context.runtime, context.message);
		if (!result) {
			const senderRank =
				ROLE_RANK[getUnresolvedSenderRoleFloor(context.message)];
			const requiredRank = ROLE_RANK[requiredRole] ?? 0;
			return senderRank >= requiredRank;
		}

		const senderRank = ROLE_RANK[result.role] ?? 0;
		const requiredRank = ROLE_RANK[requiredRole] ?? 0;
		return senderRank >= requiredRank;
	} catch {
		return false;
	}
}

/**
 * Persist the deployed-app owner as an EXPLICIT, auditable grant on a world's
 * metadata: `roles[ownerId] = "OWNER"` together with `roleSources[ownerId] =
 * "owner"`. Before this, the owner's OWNER status was emergent — inferred from
 * `ownership.ownerId` at read time and (at best) a bare `roles` entry with no
 * recorded source — so it could not be audited or distinguished from a manual /
 * connector grant (#9948). This records the grant and its provenance.
 *
 * Pure + idempotent: mutates `metadata` in place and returns `true` iff it
 * actually changed something (so callers only persist on a real change).
 */
export function recordOwnerGrant(
	metadata: RolesWorldMetadata,
	ownerId: string,
): boolean {
	metadata.roles ??= {};
	metadata.roleSources ??= {};
	let changed = false;
	if (metadata.roles[ownerId] !== "OWNER") {
		metadata.roles[ownerId] = "OWNER";
		changed = true;
	}
	if (metadata.roleSources[ownerId] !== "owner") {
		metadata.roleSources[ownerId] = "owner";
		changed = true;
	}
	return changed;
}

/**
 * Record an explicit, auditable role grant on a world's metadata: pairs
 * `roles[entityId] = role` with `roleSources[entityId] = source` (GUEST clears the
 * source, matching {@link setEntityRole}). Use when you hold the metadata but not
 * a Memory — {@link setEntityRole} needs a message and {@link recordOwnerGrant}
 * only records the canonical OWNER. Pure + idempotent: mutates `metadata` in place
 * and returns `true` iff it changed something (#12087 Item 11).
 */
export function recordRoleGrant(
	metadata: RolesWorldMetadata,
	entityId: string,
	role: RoleName,
	source: RoleGrantSource = "manual",
): boolean {
	metadata.roles ??= {};
	metadata.roleSources ??= {};
	let changed = false;
	if (metadata.roles[entityId] !== role) {
		metadata.roles[entityId] = role;
		changed = true;
	}
	if (role === "GUEST") {
		if (metadata.roleSources[entityId] !== undefined) {
			delete metadata.roleSources[entityId];
			changed = true;
		}
	} else if (metadata.roleSources[entityId] !== source) {
		metadata.roleSources[entityId] = source;
		changed = true;
	}
	return changed;
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
