import { createUniqueUuid } from "../../../entities.ts";
import { logger } from "../../../logger.ts";
import {
	ChannelType,
	type IAgentRuntime,
	type Memory,
	type Provider,
	type ProviderResult,
	type State,
	type UUID,
} from "../../../types/index.ts";

const MAX_ROLE_MEMBERS_PER_GROUP = 25;
const MAX_ROLE_TEXT_LENGTH = 5000;

export const roleProvider: Provider = {
	name: "ROLES",
	description:
		"Roles in the server, default are OWNER, ADMIN and MEMBER (as well as NONE)",
	dynamic: true,
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
		try {
			const room = state.data.room ?? (await runtime.getRoom(message.roomId));
			if (!room) {
				logger.debug("No room found for roles provider, skipping");
				return {
					data: { roles: [] },
					values: {
						roles: "No room context available for role information.",
					},
					text: "No room context available for role information.",
				};
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

			const serverId = room.messageServerId;
			if (!serverId) {
				return {
					data: { roles: [], error: "No server ID found" },
					values: { roles: "No role information available for this server." },
					text: "No role information available for this server.",
				};
			}

			logger.info(`Using server ID: ${serverId}`);

			const worldId = createUniqueUuid(runtime, serverId);
			const world = await runtime.getWorld(worldId);

			if (!world?.metadata?.ownership?.ownerId) {
				logger.info(
					`No ownership data found for server ${serverId}, initializing empty role hierarchy`,
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

			const roles = world.metadata.roles || {};

			if (Object.keys(roles).length === 0) {
				logger.info(`No roles found for server ${serverId}`);
				return {
					data: {
						roles: [],
					},
					values: {
						roles: "No role information available for this server.",
					},
				};
			}

			logger.info(`Found ${Object.keys(roles).length} roles`);

			const owners: { name: string; username: string; names: string[] }[] = [];
			const admins: { name: string; username: string; names: string[] }[] = [];
			const members: { name: string; username: string; names: string[] }[] = [];

			for (const entityId of Object.keys(roles) as UUID[]) {
				const userRole = roles[entityId];
				const user = await runtime.getEntityById(entityId);

				const metadata = user?.metadata as
					| Record<string, Record<string, unknown>>
					| undefined;
				const name =
					(metadata?.default?.name as string) ||
					(metadata?.discord?.name as string) ||
					user?.names?.[0];

				const username =
					(metadata?.default?.username as string) ||
					(metadata?.discord?.username as string) ||
					(metadata?.discord?.userName as string) ||
					user?.names?.[0];

				const names = user?.names as string[];

				if (
					owners.some((owner) => owner.username === username) ||
					admins.some((admin) => admin.username === username) ||
					members.some((member) => member.username === username)
				) {
					continue;
				}

				if (!name || !username || !names || names.length === 0) {
					logger.warn(
						`User ${entityId} (role: ${userRole}) has no name or username, skipping`,
					);
					continue;
				}

				switch (userRole) {
					case "OWNER":
						owners.push({ name, username, names });
						break;
					case "ADMIN":
						admins.push({ name, username, names });
						break;
					default:
						members.push({ name, username, names });
						break;
				}
			}

			let response = "# Server Role Hierarchy\n\n";

			if (owners.length > 0) {
				response += "## Owners\n";
				owners.slice(0, MAX_ROLE_MEMBERS_PER_GROUP).forEach((owner) => {
					response += `${owner.name} (${owner.names.join(", ")})\n`;
				});
				response += "\n";
			}

			if (admins.length > 0) {
				response += "## Administrators\n";
				admins.slice(0, MAX_ROLE_MEMBERS_PER_GROUP).forEach((admin) => {
					response += `${admin.name} (${admin.names.join(", ")}) (${admin.username})\n`;
				});
				response += "\n";
			}

			if (members.length > 0) {
				response += "## Members\n";
				members.slice(0, MAX_ROLE_MEMBERS_PER_GROUP).forEach((member) => {
					response += `${member.name} (${member.names.join(", ")}) (${member.username})\n`;
				});
			}

			if (response.length > MAX_ROLE_TEXT_LENGTH) {
				response = `${response.slice(0, MAX_ROLE_TEXT_LENGTH)}...`;
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
					roleCounts: {
						owners: owners.length,
						admins: admins.length,
						members: members.length,
					},
					truncated:
						owners.length > MAX_ROLE_MEMBERS_PER_GROUP ||
						admins.length > MAX_ROLE_MEMBERS_PER_GROUP ||
						members.length > MAX_ROLE_MEMBERS_PER_GROUP ||
						response.length >= MAX_ROLE_TEXT_LENGTH,
				},
				values: {
					roles: response,
				},
				text: response,
			};
		} catch (error) {
			return {
				data: {
					roles: [],
					error: error instanceof Error ? error.message : String(error),
				},
				values: {
					roles: "No role information available for this server.",
				},
				text: "No role information available for this server.",
			};
		}
	},
};

export default roleProvider;
