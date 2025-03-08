import type { ZodSchema, z } from "zod";
import { createUniqueUuid } from "..";
import { composePrompt } from "../prompts";
import { logger } from "../logger";
import {
	type Action,
	type ActionExample,
	ChannelType,
	type HandlerCallback,
	type IAgentRuntime,
	type Memory,
	type ModelType,
	ModelTypes,
	Role,
	type State,
	type UUID,
} from "../types";

/**
 * Asynchronous function to generate an object based on the provided parameters.
 *
 * @param {Object} options - The options object containing runtime, prompt, modelType, stopSequences, output, enumValues, and schema.
 * @param {Object} options.runtime - The runtime object.
 * @param {string} options.prompt - The prompt to be used for generating the object.
 * @param {string} options.modelType - The type of model to use for generation.
 * @param {string[]} [options.stopSequences=[]] - The stop sequences to be used during generation.
 * @param {string} [options.output="object"] - The desired output type (object or enum).
 * @param {string[]} [options.enumValues=[]] - The enum values to be used for enum output type.
 * @param {Object} [options.schema] - The schema object to validate the generated object against.
 * @returns {Promise<any>} The generated object based on the provided parameters, or null if an error occurs.
 */
export const generateObject = async ({
	runtime,
	prompt,
	modelType,
	stopSequences = [],
	output = "object",
	enumValues = [],
	schema,
}): Promise<any> => {
	if (!prompt) {
		const errorMessage = "generateObject prompt is empty";
		console.error(errorMessage);
		throw new Error(errorMessage);
	}

	// Special handling for enum output type
	if (output === "enum" && enumValues) {
		const response = await runtime.useModel(modelType, {
			runtime,
			prompt,
			modelType,
			stopSequences,
			maxTokens: 8,
			object: true,
		});

		// Clean up the response to extract just the enum value
		const cleanedResponse = response.trim();

		// Verify the response is one of the allowed enum values
		if (enumValues.includes(cleanedResponse)) {
			return cleanedResponse;
		}

		// If the response includes one of the enum values (case insensitive)
		const matchedValue = enumValues.find((value) =>
			cleanedResponse.toLowerCase().includes(value.toLowerCase()),
		);

		if (matchedValue) {
			return matchedValue;
		}

		logger.error(`Invalid enum value received: ${cleanedResponse}`);
		logger.error(`Expected one of: ${enumValues.join(", ")}`);
		return null;
	}

	// Regular object/array generation
	const response = await runtime.useModel(modelType, {
		runtime,
		prompt,
		modelType,
		stopSequences,
		object: true,
	});

	let jsonString = response;

	// Find appropriate brackets based on expected output type
	const firstChar = output === "array" ? "[" : "{";
	const lastChar = output === "array" ? "]" : "}";

	const firstBracket = response.indexOf(firstChar);
	const lastBracket = response.lastIndexOf(lastChar);

	if (firstBracket !== -1 && lastBracket !== -1 && firstBracket < lastBracket) {
		jsonString = response.slice(firstBracket, lastBracket + 1);
	}

	if (jsonString.length === 0) {
		logger.error(`Failed to extract JSON ${output} from model response`);
		return null;
	}

	// Parse the JSON string
	try {
		const json = JSON.parse(jsonString);

		// Validate against schema if provided
		if (schema) {
			return schema.parse(json);
		}

		return json;
	} catch (_error) {
		logger.error(`Failed to parse JSON ${output}`);
		logger.error(jsonString);
		return null;
	}
};

// Role modification validation helper
/**
 * Determines if a user with a given current role can modify another user's role to a new role.
 * Owners can modify any role except other owners. Admins can only modify NONE roles and can't promote to OWNER or ADMIN.
 *
 * @param {Role} currentRole - The current role of the user attempting to modify roles.
 * @param {Role | null} targetRole - The current role of the user whose role is being modified, can be null.
 * @param {Role} newRole - The new role that the user is attempting to set.
 * @returns {boolean} Returns true if the role can be modified, false if not.
 */
const canModifyRole = (
	currentRole: Role,
	targetRole: Role | null,
	newRole: Role,
): boolean => {
	// Owners can modify any role except other owners
	if (currentRole === Role.OWNER) {
		return targetRole !== Role.OWNER;
	}

	// Admins can only modify NONE roles and can't promote to OWNER or ADMIN
	if (currentRole === Role.ADMIN) {
		return (
			(!targetRole || targetRole === Role.NONE) &&
			![Role.OWNER, Role.ADMIN].includes(newRole)
		);
	}

	return false;
};

/**
 * Template for extracting role assignments from a conversation.
 *
 * @type {string} extractionTemplate - The template string containing information about the task, server members, available roles, recent messages, current speaker role, and extraction instructions.
 * @returns {string} JSON format of role assignments if valid role assignments are found, otherwise an empty array.
 */
const extractionTemplate = `# Task: Extract role assignments from the conversation

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

/**
 * Asynchronous function to generate an array of objects based on the provided parameters.
 *
 * @param {Object} parameters - The parameters object.
 * @param {IAgentRuntime} parameters.runtime - The runtime for the agent.
 * @param {string} parameters.prompt - The prompt for generating the objects.
 * @param {ModelType} [parameters.modelType=ModelTypes.TEXT_SMALL] - The type of model to use.
 * @param {ZodSchema} [parameters.schema] - The schema for validating the generated objects.
 * @param {string} [parameters.schemaName] - The name of the schema.
 * @param {string} [parameters.schemaDescription] - The description of the schema.
 * @returns {Promise<z.infer<typeof schema>[]>} - A promise that resolves to an array of objects conforming to the schema.
 */
async function generateObjectArray({
	runtime,
	prompt,
	modelType = ModelTypes.TEXT_SMALL,
	schema,
	schemaName,
	schemaDescription,
}: {
	runtime: IAgentRuntime;
	prompt: string;
	modelType: ModelType;
	schema?: ZodSchema;
	schemaName?: string;
	schemaDescription?: string;
}): Promise<z.infer<typeof schema>[]> {
	if (!prompt) {
		logger.error("generateObjectArray prompt is empty");
		return [];
	}

	const result = await generateObject({
		runtime,
		prompt,
		modelType,
		output: "array",
		schema,
	});

	if (!Array.isArray(result)) {
		logger.error("Generated result is not an array");
		return [];
	}

	return schema ? schema.parse(result) : result;
}

/**
 * Interface representing a role assignment.
 * @typedef {Object} RoleAssignment
 * @property {UUID} entityId - The unique identifier of the entity.
 * @property {Role} newRole - The new role assigned to the entity.
 */
interface RoleAssignment {
	entityId: UUID;
	newRole: Role;
}

/**
 * Represents an action to update the role of a user within a server.
 * @typedef {Object} Action
 * @property {string} name - The name of the action.
 * @property {string[]} similes - The similar actions that can be performed.
 * @property {string} description - A description of the action and its purpose.
 * @property {Function} validate - A function to validate the action before execution.
 * @property {Function} handler - A function to handle the execution of the action.
 * @property {ActionExample[][]} examples - Examples demonstrating how the action can be used.
 */
const updateRoleAction: Action = {
	name: "UPDATE_ROLE",
	similes: ["CHANGE_ROLE", "SET_ROLE", "MODIFY_ROLE"],
	description:
		"Updates the role for a user with respect to the agent, world being the server they are in. For example, if an admin tells the agent that a user is their boss, set their role to ADMIN. Can only be used to set roles to ADMIN, OWNER or NONE. Can't be used to ban.",

	validate: async (
		runtime: IAgentRuntime,
		message: Memory,
		state: State,
	): Promise<boolean> => {
		logger.info("Starting role update validation");

		// Validate message source
		if (message.content.source !== "discord") {
			logger.info("Validation failed: Not a discord message");
			return false;
		}

		const room =
			state.data.room ??
			(await runtime.getDatabaseAdapter().getRoom(message.roomId));
		if (!room) {
			throw new Error("No room found");
		}

		// if room type is DM, return
		if (room.type !== ChannelType.GROUP) {
			// only handle in a group scenario for now
			return false;
		}

		const serverId = room.serverId;
		if (!serverId) {
			throw new Error("No server ID found");
		}
		try {
			// Get world data instead of ownership state from cache
			const worldId = createUniqueUuid(runtime, serverId);
			const world = await runtime.getDatabaseAdapter().getWorld(worldId);

			// Get requester ID and convert to UUID for consistent lookup
			const requesterId = message.entityId;

			// Get roles from world metadata
			if (!world.metadata?.roles) {
				logger.info(`No roles found for server ${serverId}`);
				return false;
			}

			// Lookup using UUID for consistency
			const requesterRole = world.metadata.roles[requesterId] as Role;

			logger.info(`Requester ${requesterId} role:`, requesterRole);

			if (!requesterRole) {
				logger.info("Validation failed: No requester role found");
				return false;
			}

			if (![Role.OWNER, Role.ADMIN].includes(requesterRole)) {
				logger.info(
					`Validation failed: Role ${requesterRole} insufficient for role management`,
				);
				return false;
			}

			return true;
		} catch (error) {
			logger.error("Error validating updateOrgRole action:", error);
			return false;
		}
	},

	handler: async (
		runtime: IAgentRuntime,
		message: Memory,
		state: State,
		_options: any,
		callback: HandlerCallback,
		responses: Memory[],
	): Promise<void> => {
		// Handle initial responses
		for (const response of responses) {
			await callback(response.content);
		}

		const room =
			state.data.room ??
			(await runtime.getDatabaseAdapter().getRoom(message.roomId));
		const world = await runtime.getDatabaseAdapter().getWorld(room.worldId);

		if (!room) {
			throw new Error("No room found");
		}

		const serverId = world.serverId;
		const requesterId = message.entityId;

		if (!world || !world.metadata) {
			logger.error(`No world or metadata found for server ${serverId}`);
			await callback({
				text: "Unable to process role changes due to missing server data.",
				actions: ["UPDATE_ROLE"],
				source: "discord",
			});
			return;
		}

		// Ensure roles object exists
		if (!world.metadata.roles) {
			world.metadata.roles = {};
		}

		// Get requester's role from world metadata
		const requesterRole =
			(world.metadata.roles[requesterId] as Role) || Role.NONE;

		// Get all entities in the room
		const entities = await runtime
			.getDatabaseAdapter()
			.getEntitiesForRoom(room.id, true);

		// Build server members prompt from entities
		const serverMembersContext = entities
			.map((entity) => {
				const discordData = entity.components?.find(
					(c) => c.type === "discord",
				)?.data;
				const name = discordData?.username || entity.names[0];
				const id = entity.id;
				return `${name} (${id})`;
			})
			.join("\n");

		// Create extraction prompt
		const extractionPrompt = composePrompt({
			state: {
				...state,
				serverMembers: serverMembersContext,
				speakerRole: requesterRole,
			},
			template: extractionTemplate,
		});

		// Extract role assignments
		const result = (await generateObjectArray({
			runtime,
			prompt: extractionPrompt,
			modelType: ModelTypes.TEXT_SMALL,
		})) as RoleAssignment[];

		if (!result?.length) {
			await callback({
				text: "No valid role assignments found in the request.",
				actions: ["UPDATE_ROLE"],
				source: "discord",
			});
			return;
		}

		// Process each role assignment
		let worldUpdated = false;

		for (const assignment of result) {
			let targetEntity = entities.find((e) => e.id === assignment.entityId);
			if (!targetEntity) {
				targetEntity = entities.find((e) => e.id === assignment.entityId);
				console.log("Trying to write to generated tenant ID");
			}
			if (!targetEntity) {
				console.log("Could not find an ID ot assign to");
			}

			const currentRole = world.metadata.roles[assignment.entityId];

			// Validate role modification permissions
			if (!canModifyRole(requesterRole, currentRole, assignment.newRole)) {
				await callback({
					text: `You don't have permission to change ${targetEntity.names[0]}'s role to ${assignment.newRole}.`,
					actions: ["UPDATE_ROLE"],
					source: "discord",
				});
				continue;
			}

			// Update role in world metadata
			world.metadata.roles[assignment.entityId] = assignment.newRole;

			worldUpdated = true;

			await callback({
				text: `Updated ${targetEntity.names[0]}'s role to ${assignment.newRole}.`,
				actions: ["UPDATE_ROLE"],
				source: "discord",
			});
		}

		// Save updated world metadata if any changes were made
		if (worldUpdated) {
			await runtime.getDatabaseAdapter().updateWorld(world);
			logger.info(`Updated roles in world metadata for server ${serverId}`);
		}
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

export default updateRoleAction;
