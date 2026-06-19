import { requireProviderSpec } from "../../../generated/spec-helpers.ts";
import { logger } from "../../../logger.ts";
import type {
	Entity,
	IAgentRuntime,
	Memory,
	Metadata,
	Provider,
	ProviderResult,
	State,
	UUID,
} from "../../../types/index.ts";
import { ChannelType } from "../../../types/index.ts";

// Get text content from centralized specs
const spec = requireProviderSpec("ROLES");

type RoleUser = { name: string; username: string; names: string[] };
type IdentityFields = { name?: string; username?: string; userName?: string };

function isIdentityFields(value: unknown): value is IdentityFields {
	return value !== null && typeof value === "object";
}

function getString(value: unknown): string | undefined {
	return typeof value === "string" && value.trim().length > 0
		? value
		: undefined;
}

function getMetadataIdentity(metadata: Metadata | undefined): IdentityFields {
	if (!metadata) {
		return {};
	}

	const sourceOrder = [
		"default",
		"discord",
		"telegram",
		"twitter",
		"twitch",
		"slack",
	];
	const candidates: IdentityFields[] = [metadata];
	for (const source of sourceOrder) {
		const sourceMetadata = metadata[source];
		if (isIdentityFields(sourceMetadata)) {
			candidates.push(sourceMetadata);
		}
	}
	for (const value of Object.values(metadata)) {
		if (isIdentityFields(value)) {
			candidates.push(value);
		}
	}

	const identity: IdentityFields = {};
	for (const candidate of candidates) {
		identity.name ??= getString(candidate.name);
		identity.username ??=
			getString(candidate.username) ?? getString(candidate.userName);
		if (identity.name && identity.username) {
			return identity;
		}
	}
	return identity;
}

function getRoleUser(entity: Entity | null | undefined): RoleUser | null {
	const names = entity?.names?.filter((name) => name.trim().length > 0) ?? [];
	const metadataIdentity = getMetadataIdentity(entity?.metadata);
	const name = metadataIdentity.name ?? names[0];
	const username = metadataIdentity.username ?? names[0];

	if (!name || !username || names.length === 0) {
		return null;
	}

	return { name, username, names };
}

/**
 * Role provider that retrieves roles in the server based on the provided runtime, message, and state.
 * * @type { Provider }
 * @property { string } name - The name of the role provider.
 * @property { string } description - A brief description of the role provider.
 * @property { Function } get - Asynchronous function that retrieves and processes roles in the server.
 * @param { IAgentRuntime } runtime - The agent runtime object.
 * @param { Memory } message - The message memory object.
 * @param { State } state - The state object.
 * @returns {Promise<ProviderResult>} The result containing roles data, values, and text.
 */
/**
 * A provider for retrieving and formatting the role hierarchy in a server.
 * @type {Provider}
 */
export const roleProvider: Provider = {
	name: spec.name,
	description: spec.description,
	contexts: ["admin", "settings"],
	contextGate: { anyOf: ["admin", "settings"] },
	cacheStable: false,
	cacheScope: "turn",
	roleGate: { minRole: "ADMIN" },

	get: async (
		runtime: IAgentRuntime,
		message: Memory,
		state: State,
	): Promise<ProviderResult> => {
		const room = state.data.room ?? (await runtime.getRoom(message.roomId));
		if (!room) {
			throw new Error("No room found");
		}

		if (room.type !== ChannelType.GROUP) {
			return {
				data: {
					roles: [],
				},
				values: {
					roles:
						"No access to role information in DMs, the role provider is only available in group scenarios.",
				},
				text: "No access to role information in DMs, the role provider is only available in group scenarios.",
			};
		}

		const worldId = room.worldId;

		if (!worldId) {
			throw new Error("No world ID found for room");
		}

		logger.info(
			{
				src: "plugin:advanced-capabilities:provider:roles",
				agentId: runtime.agentId,
				worldId,
			},
			"Using world ID",
		);

		// Get world data
		const world = await runtime.getWorld(worldId);

		if (!world?.metadata?.ownership?.ownerId) {
			logger.info(
				{
					src: "plugin:advanced-capabilities:provider:roles",
					agentId: runtime.agentId,
					worldId,
				},
				"No ownership data found for world, initializing empty role hierarchy",
			);
			return {
				data: {
					roles: [],
				},
				values: {
					roles: "No role information available for this server.",
				},
				text: "No role information available for this server.",
			};
		}
		// Get roles from world metadata
		const roles = world.metadata.roles || {};

		if (Object.keys(roles).length === 0) {
			logger.info(
				{
					src: "plugin:advanced-capabilities:provider:roles",
					agentId: runtime.agentId,
					worldId,
				},
				"No roles found for world",
			);
			return {
				data: {
					roles: [],
				},
				values: {
					roles: "No role information available for this server.",
				},
				text: "No role information available for this server.",
			};
		}

		logger.info(
			{
				src: "plugin:advanced-capabilities:provider:roles",
				agentId: runtime.agentId,
				roleCount: Object.keys(roles).length,
			},
			"Found roles",
		);

		// Group users by role
		const owners: RoleUser[] = [];
		const admins: RoleUser[] = [];
		const members: RoleUser[] = [];

		const entityIds = Object.keys(roles) as UUID[];
		const entities = await Promise.all(
			entityIds.map((entityId) => runtime.getEntityById(entityId)),
		);
		const entityMap = new Map<UUID, (typeof entities)[number]>();
		for (let i = 0; i < entityIds.length; i += 1) {
			const entity = entities[i];
			if (entity) {
				entityMap.set(entityIds[i], entity);
			}
		}

		const seenUsernames = new Set<string>();

		// Process roles
		for (const entityId of entityIds) {
			const userRole = roles[entityId];
			const user = entityMap.get(entityId);

			const roleUser = getRoleUser(user);

			if (!roleUser) {
				logger.warn(
					{
						src: "plugin:advanced-capabilities:provider:roles",
						agentId: runtime.agentId,
						entityId,
					},
					"User has no name or username, skipping",
				);
				continue;
			}

			if (seenUsernames.has(roleUser.username)) {
				continue;
			}
			seenUsernames.add(roleUser.username);

			// Add to appropriate group
			switch (userRole) {
				case "OWNER":
					owners.push(roleUser);
					break;
				case "ADMIN":
					admins.push(roleUser);
					break;
				default:
					members.push(roleUser);
					break;
			}
		}

		// Format the response
		let response = "# Server Role Hierarchy\n\n";

		if (owners.length > 0) {
			response += "## Owners\n";
			owners.forEach((owner) => {
				response += `${owner.name} (${owner.names.join(", ")})\n`;
			});
			response += "\n";
		}

		if (admins.length > 0) {
			response += "## Administrators\n";
			admins.forEach((admin) => {
				response += `${admin.name} (${admin.names.join(", ")}) (${admin.username})\n`;
			});
			response += "\n";
		}

		if (members.length > 0) {
			response += "## Members\n";
			members.forEach((member) => {
				response += `${member.name} (${member.names.join(", ")}) (${member.username})\n`;
			});
		}

		if (owners.length === 0 && admins.length === 0 && members.length === 0) {
			return {
				data: {
					roles: [],
				},
				values: {
					roles: "No role information available for this server.",
				},
				text: "No role information available for this server.",
			};
		}

		return {
			data: {
				roles: response,
			},
			values: {
				roles: response,
			},
			text: response,
		};
	},
};

export default roleProvider;
