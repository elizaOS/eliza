import dedent from "dedent";
import { logger } from "../../../logger.ts";
import {
	type ActionExample,
	type ActionResult,
	ChannelType,
	type Action as ElizaAction,
	type HandlerCallback,
	type IAgentRuntime,
	type Memory,
	ModelType,
	Role,
	type State,
	type UUID,
	type World,
} from "../../../types/index.ts";
import { composePrompt } from "../../../utils.ts";

const canModifyRole = (
	currentRole: Role,
	targetRole: Role | null,
	newRole: Role,
): boolean => {
	if (targetRole === currentRole) return false;

	switch (currentRole) {
		case Role.OWNER:
			return true;
		case Role.ADMIN:
			return newRole !== Role.OWNER;
		default:
			return false;
	}
};

const _extractionTemplate = `# Task: Extract role assignments from the conversation

# Current Server Members:
{{serverMembers}}

# Available Roles:
- OWNER: Full control over the organization
- ADMIN: Administrative privileges
- NONE: Standard member access

# Recent Conversation:
{{recentMessages}}

# Current speaker role: {{speakerRole}}

# Instructions: Analyze the conversation and extract any role assignments being made by the speaker.
Only extract role assignments if:
1. The speaker has appropriate permissions to make the change
2. The role assignment is clearly stated
3. The target user is a valid server member
4. The new role is one of: OWNER, ADMIN, or NONE

Return the results in this JSON format:
{
"roleAssignments": [
  {
    "entityId": "<UUID of the entity being assigned to>",
    "newRole": "ROLE_NAME"
  }
]
}

If no valid role assignments are found, return an empty array.`;

interface RoleAssignment {
	entityId: string;
	newRole: Role;
}

export const updateRoleAction: ElizaAction = {
	name: "UPDATE_ROLE",
	similes: ["CHANGE_ROLE", "SET_PERMISSIONS", "ASSIGN_ROLE", "MAKE_ADMIN"],
	description:
		"Assigns a role (Admin, Owner, None) to a user or list of users in a channel.",

	validate: async (
		runtime: IAgentRuntime,
		message: Memory,
		state?: State,
		options?: Record<string, unknown>,
	): Promise<boolean> => {
		const __avTextRaw =
			typeof message?.content?.text === "string" ? message.content.text : "";
		const __avText = __avTextRaw.toLowerCase();
		const __avLegacyContextOk = Boolean(
			(message?.content?.channelType === ChannelType.GROUP ||
				message?.content?.channelType === ChannelType.WORLD) &&
				message?.content?.serverId,
		);
		const __avKeywords = ["update", "role", "roles"];
		const __avKeywordOk =
			__avKeywords.length > 0 &&
			(__avKeywords.some(
				(word) => word.length > 0 && __avText.includes(word),
			) ||
				__avLegacyContextOk);
		const __avRegex = /\b(?:update|role|roles)\b/i;
		const __avRegexOk = __avRegex.test(__avText) || __avLegacyContextOk;
		const __avSource = String(message?.content?.source ?? "");
		const __avExpectedSource = "";
		const __avSourceOk = __avExpectedSource
			? __avSource === __avExpectedSource
			: Boolean(
					__avSource ||
						state ||
						runtime?.agentId ||
						runtime?.getService ||
						runtime?.getSetting ||
						__avLegacyContextOk ||
						message?.content,
				);
		const __avOptions = options && typeof options === "object" ? options : {};
		const __avInputOk =
			__avText.trim().length > 0 ||
			Object.keys(__avOptions as Record<string, unknown>).length > 0 ||
			Boolean(message?.content && typeof message.content === "object");

		if (!(__avKeywordOk && __avRegexOk && __avSourceOk && __avInputOk)) {
			return false;
		}

		const __avLegacyValidate = async (
			_runtime: IAgentRuntime,
			message: Memory,
			_state?: State,
		): Promise<boolean> => {
			const channelType = message.content.channelType as ChannelType;
			const serverId = message.content.serverId as string;

			return (
				(channelType === ChannelType.GROUP ||
					channelType === ChannelType.WORLD) &&
				!!serverId
			);
		};
		try {
			return Boolean(await __avLegacyValidate(runtime, message, state));
		} catch {
			return false;
		}
	},

	handler: async (
		runtime: IAgentRuntime,
		message: Memory,
		state?: State,
		_options?: Record<string, unknown>,
		callback?: HandlerCallback,
	): Promise<ActionResult> => {
		if (!state) {
			logger.error("State is required for role assignment");
			throw new Error("State is required for role assignment");
		}

		const { roomId } = message;
		const serverId = message.content.serverId as string;
		const worldId = runtime.getSetting("WORLD_ID");

		let world: World | null = null;

		if (worldId) {
			world = await runtime.getWorld(worldId as UUID);
		}

		if (!world) {
			logger.error("World not found");
			await callback?.({
				text: "I couldn't find the world. This action only works in a world.",
			});
			return {
				success: false,
				data: {
					success: false,
					error: "World not found",
				},
			};
		}

		if (!world.metadata?.roles) {
			world.metadata = world.metadata || {};
			world.metadata.roles = {};
		}

		const entities = await runtime.getEntitiesForRoom(roomId);

		const requesterRole = world.metadata.roles[message.entityId] || Role.NONE;

		const extractionPrompt = composePrompt({
			state: {
				...state.values,
				content: state.text,
			},
			template: dedent`
				# Task: Parse Role Assignment

				I need to extract user role assignments from the input text. Users can be referenced by name, username, or mention.

				The available role types are:
				- OWNER: Full control over the server and all settings
				- ADMIN: Ability to manage channels and moderate content
				- NONE: Regular user with no special permissions

				# Current context:
				{{content}}

				Format your response as a JSON array of objects, each with:
				- entityId: The name or ID of the user
				- newRole: The role to assign (OWNER, ADMIN, or NONE)

				Example:
				\`\`\`json
				[
					{
						"entityId": "John",
						"newRole": "ADMIN"
					},
					{
						"entityId": "Sarah",
						"newRole": "OWNER"
					}
				]
				\`\`\`
			`,
		});

		const result = await runtime.useModel<
			typeof ModelType.OBJECT_LARGE,
			RoleAssignment[]
		>(ModelType.OBJECT_LARGE, {
			prompt: extractionPrompt,
			schema: {
				type: "array",
				items: {
					type: "object",
					properties: {
						entityId: { type: "string" },
						newRole: {
							type: "string",
							enum: Object.values(Role),
						},
					},
					required: ["entityId", "newRole"],
				},
			},
			output: "array",
		});

		if (!result?.length) {
			await callback?.({
				text: "No valid role assignments found in the request.",
				actions: ["UPDATE_ROLE"],
				source: "discord",
			});
			return {
				success: false,
				data: {
					success: false,
					message: "No valid role assignments found",
				},
			};
		}

		let worldUpdated = false;
		const updatedRoles: Array<{
			entityName: string;
			entityId: string;
			newRole: Role;
		}> = [];

		for (const assignment of result) {
			const targetEntity = entities.find((e) => e.id === assignment.entityId);
			if (!targetEntity) {
				logger.error("Could not find an ID to assign to");
				continue;
			}

			const currentRole = world.metadata.roles[assignment.entityId];

			if (!canModifyRole(requesterRole, currentRole, assignment.newRole)) {
				await callback?.({
					text: `You don't have permission to change ${targetEntity?.names[0]}'s role to ${assignment.newRole}.`,
					actions: ["UPDATE_ROLE"],
					source: "discord",
				});
				continue;
			}

			world.metadata.roles[assignment.entityId] = assignment.newRole;

			worldUpdated = true;
			updatedRoles.push({
				entityName: targetEntity.names[0] || "Unknown",
				entityId: assignment.entityId,
				newRole: assignment.newRole,
			});

			await callback?.({
				text: `Updated ${targetEntity?.names[0]}'s role to ${assignment.newRole}.`,
				actions: ["UPDATE_ROLE"],
				source: "discord",
			});
		}

		if (worldUpdated) {
			await runtime.updateWorld(world);
			logger.info(`Updated roles in world metadata for server ${serverId}`);
		}

		return {
			success: worldUpdated,
			data: {
				success: worldUpdated,
				updatedRoles,
				totalProcessed: result.length,
				totalUpdated: updatedRoles.length,
			},
			text: worldUpdated
				? `Successfully updated ${updatedRoles.length} role(s).`
				: "No roles were updated.",
		};
	},

	examples: [
		[
			{
				name: "{{name1}}",
				content: {
					text: "Make {{name2}} an ADMIN",
					source: "discord",
				},
			},
			{
				name: "{{name3}}",
				content: {
					text: "Updated {{name2}}'s role to ADMIN.",
					actions: ["UPDATE_ROLE"],
				},
			},
		],
		[
			{
				name: "{{name1}}",
				content: {
					text: "Set @alice and @bob as admins",
					source: "discord",
				},
			},
			{
				name: "{{name3}}",
				content: {
					text: "Updated alice's role to ADMIN.\nUpdated bob's role to ADMIN.",
					actions: ["UPDATE_ROLE"],
				},
			},
		],
		[
			{
				name: "{{name1}}",
				content: {
					text: "Ban @troublemaker",
					source: "discord",
				},
			},
			{
				name: "{{name3}}",
				content: {
					text: "I cannot ban users.",
					actions: ["REPLY"],
				},
			},
		],
	] as ActionExample[][],
};
