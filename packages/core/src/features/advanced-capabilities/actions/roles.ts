import { requireActionSpec } from "../../../generated/spec-helpers.ts";
import { logger } from "../../../logger.ts";
import type {
	Action,
	ActionExample,
	ActionResult,
	HandlerCallback,
	HandlerOptions,
	IAgentRuntime,
	Memory,
	Role,
	State,
	UUID,
	World,
} from "../../../types/index.ts";
import { ChannelType } from "../../../types/index.ts";

// Get text content from centralized specs
const spec = requireActionSpec("UPDATE_ROLE");

/** Shape of individual assignment in structured responses. */
interface RoleAssignmentToon {
	entityId?: string;
	newRole?: string;
}

/** Shape of the role extraction structured response. */
interface RoleExtractionResult {
	assignments?:
		| {
				assignment?: RoleAssignmentToon | RoleAssignmentToon[];
		  }
		| RoleAssignmentToon[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeRoleAssignments(value: unknown): RoleAssignmentToon[] {
	if (Array.isArray(value)) {
		return value.filter(
			(entry): entry is RoleAssignmentToon =>
				isRecord(entry) &&
				(typeof entry.entityId === "string" ||
					typeof entry.newRole === "string"),
		);
	}

	if (isRecord(value) && "assignment" in value) {
		return normalizeRoleAssignments(value.assignment);
	}

	if (
		isRecord(value) &&
		(typeof value.entityId === "string" || typeof value.newRole === "string")
	) {
		return [value as RoleAssignmentToon];
	}

	return [];
}

function readRoleAssignments(
	message: Memory,
	options?: HandlerOptions,
): RoleAssignmentToon[] {
	const params =
		options?.parameters && typeof options.parameters === "object"
			? (options.parameters as Record<string, unknown>)
			: {};
	return normalizeRoleAssignments(
		params.assignments ?? message.content.assignments,
	);
}

/**
 * Determines if the user with the current role can modify the role to the new role.
 * @param currentRole The current role of the user making the change
 * @param targetRole The current role of the user being changed (null if new user)
 * @param newRole The new role to assign
 * @returns Whether the role change is allowed
 */
/**
 * Determines if a user with a given current role can modify the role of another user to a new role.
 * @param {Role} currentRole - The current role of the user attempting to modify the other user's role.
 * @param {Role | null} targetRole - The target user's current role. Can be null if the user does not exist.
 * @param {Role} newRole - The new role that the current user is attempting to set for the target user.
 * @returns {boolean} Returns true if the user can modify the role, false otherwise.
 */
const ROLE_OWNER: Role = "OWNER";
const ROLE_ADMIN: Role = "ADMIN";
const ROLE_MEMBER: Role = "MEMBER";
const ROLE_GUEST: Role = "GUEST";
const ROLE_NONE: Role = "NONE";

/** Numeric hierarchy for permission checks — higher number = more privilege. */
const ROLE_LEVEL: Record<Role, number> = {
	[ROLE_OWNER]: 4,
	[ROLE_ADMIN]: 3,
	[ROLE_MEMBER]: 2,
	[ROLE_GUEST]: 1,
	[ROLE_NONE]: 0,
};

const canModifyRole = (
	currentRole: Role,
	targetRole: Role | null,
	newRole: Role,
): boolean => {
	// Users can't change their own role
	if (targetRole === currentRole) {
		return false;
	}

	const currentLevel = ROLE_LEVEL[currentRole] ?? 0;
	const targetLevel = targetRole !== null ? (ROLE_LEVEL[targetRole] ?? 0) : -1;
	const newLevel = ROLE_LEVEL[newRole] ?? 0;

	// Must outrank the target and the destination role
	return currentLevel > targetLevel && currentLevel > newLevel;
};

/**
 * Interface representing a role assignment to a user.
 */
interface RoleAssignment {
	entityId: string;
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
export const updateRoleAction: Action = {
	name: spec.name,
	similes: spec.similes ? [...spec.similes] : [],
	description: spec.description,
	examples: (spec.examples ?? []) as ActionExample[][],

	validate: async (
		runtime: IAgentRuntime,
		message: Memory,
		state?: State,
		options?: HandlerOptions,
	): Promise<boolean> => {
		if (readRoleAssignments(message, options).length === 0) {
			return false;
		}
		// Only activate in group chats where the feature is enabled
		const channelType = message.content.channelType as ChannelType;

		// First, check if this is a supported channel type
		if (
			channelType !== ChannelType.GROUP &&
			channelType !== ChannelType.WORLD
		) {
			return false;
		}

		// Then, check if we have a server/world context
		const room = state?.data?.room ?? (await runtime.getRoom(message.roomId));
		if (!room?.messageServerId) {
			return false;
		}

		return true;
	},

	handler: async (
		runtime: IAgentRuntime,
		message: Memory,
		state?: State,
		_options?: HandlerOptions,
		callback?: HandlerCallback,
	): Promise<ActionResult> => {
		if (!state) {
			logger.error(
				{
					src: "plugin:advanced-capabilities:action:update_role",
					agentId: runtime.agentId,
				},
				"State is required for role assignment",
			);
			return {
				text: "State is required for role assignment",
				values: {
					success: false,
					error: "STATE_REQUIRED",
				},
				data: {
					actionName: "UPDATE_ROLE",
					error: "State is required",
				},
				success: false,
				error: new Error("State is required for role assignment"),
			};
		}

		// Extract needed values from message and state
		const { roomId } = message;
		const worldId = runtime.getSetting("WORLD_ID");

		// First, get the world for this server
		let world: World | null = null;

		if (worldId) {
			world = await runtime.getWorld(worldId as UUID);
		}

		if (!world) {
			logger.error(
				{
					src: "plugin:advanced-capabilities:action:update_role",
					agentId: runtime.agentId,
				},
				"World not found",
			);
			await callback?.({
				text: "I couldn't find the world. This action only works in a world.",
			});
			return {
				text: "World not found",
				values: {
					success: false,
					error: "WORLD_NOT_FOUND",
				},
				data: {
					actionName: "UPDATE_ROLE",
					error: "World not found",
				},
				success: false,
			};
		}

		if (!world.metadata?.roles) {
			world.metadata = world.metadata || {};
			world.metadata.roles = {};
		}

		// Get the entities for this room
		const entities = await runtime.getEntitiesForRoom(roomId);
		const entityById = new Map<string, (typeof entities)[number]>();
		for (const entity of entities) {
			if (entity.id) {
				entityById.set(entity.id, entity);
			}
		}

		// Get the role of the requester
		const requesterRole = world.metadata.roles[message.entityId] || ROLE_NONE;

		// Handle the parsed structured response.
		const assignmentArray = readRoleAssignments(message, _options);
		const assignments: RoleAssignment[] = assignmentArray
			.filter(
				(a): a is RoleAssignmentToon & { entityId: string; newRole: string } =>
					typeof a.entityId === "string" && typeof a.newRole === "string",
			)
			.map((a) => ({
				entityId: a.entityId,
				newRole: a.newRole as Role,
			}));

		if (!assignments.length) {
			await callback?.({
				text: "No valid role assignments found in the request.",
				actions: ["UPDATE_ROLE"],
				source: "discord",
			});
			return {
				text: "No valid role assignments found",
				values: {
					success: false,
					error: "NO_ASSIGNMENTS",
				},
				data: {
					actionName: "UPDATE_ROLE",
					error: "No valid role assignments found in the request",
				},
				success: false,
			};
		}

		// Process each role assignment
		let worldUpdated = false;
		const successfulUpdates: Array<{
			entityId: string;
			entityName: string;
			newRole: Role;
		}> = [];
		const failedUpdates: Array<{ entityId: string; reason: string }> = [];

		for (const assignment of assignments) {
			const targetEntity = entityById.get(assignment.entityId);
			if (!targetEntity) {
				logger.error(
					{
						src: "plugin:advanced-capabilities:action:update_role",
						agentId: runtime.agentId,
						entityId: assignment.entityId,
					},
					"Could not find an ID to assign to",
				);
				failedUpdates.push({
					entityId: assignment.entityId,
					reason: "Entity not found",
				});
				continue;
			}

			// Cast entityId to UUID type for role lookup
			const entityIdAsUuid =
				assignment.entityId as `${string}-${string}-${string}-${string}-${string}`;
			const currentRole = world.metadata.roles[entityIdAsUuid] ?? null;

			// Validate role modification permissions
			if (!canModifyRole(requesterRole, currentRole, assignment.newRole)) {
				await callback?.({
					text: `You don't have permission to change ${targetEntity?.names[0]}'s role to ${assignment.newRole}.`,
					actions: ["UPDATE_ROLE"],
					source: "discord",
				});
				failedUpdates.push({
					entityId: assignment.entityId,
					reason: "Insufficient permissions",
				});
				continue;
			}

			// Update role in world metadata
			world.metadata.roles[entityIdAsUuid] = assignment.newRole;

			worldUpdated = true;
			successfulUpdates.push({
				entityId: assignment.entityId,
				entityName: targetEntity?.names[0] || "Unknown",
				newRole: assignment.newRole,
			});

			await callback?.({
				text: `Updated ${targetEntity?.names[0]}'s role to ${assignment.newRole}.`,
				actions: ["UPDATE_ROLE"],
				source: "discord",
			});
		}

		// Save updated world metadata if any changes were made
		if (worldUpdated) {
			try {
				await runtime.updateWorld(world);
				logger.info(
					{
						src: "plugin:advanced-capabilities:action:update_role",
						agentId: runtime.agentId,
						messageServerId: world.messageServerId,
					},
					"Updated roles in world metadata",
				);
			} catch (error) {
				logger.error(
					{
						src: "plugin:advanced-capabilities:action:update_role",
						agentId: runtime.agentId,
						error: error instanceof Error ? error.message : String(error),
					},
					"Failed to save world updates",
				);
				return {
					text: "Failed to save role updates",
					values: {
						success: false,
						error: "SAVE_FAILED",
					},
					data: {
						actionName: "UPDATE_ROLE",
						error: error instanceof Error ? error.message : String(error),
						attemptedUpdates: successfulUpdates,
					},
					success: false,
					error: error instanceof Error ? error : new Error(String(error)),
				};
			}
		}

		return {
			text: `Role updates completed: ${successfulUpdates.length} successful, ${failedUpdates.length} failed`,
			values: {
				success: true,
				successfulUpdates: successfulUpdates.length,
				failedUpdates: failedUpdates.length,
			},
			data: {
				actionName: "UPDATE_ROLE",
				successfulUpdateCount: successfulUpdates.length,
				failedUpdateCount: failedUpdates.length,
				worldId: world.id ?? "",
				messageServerId: world.messageServerId ?? "",
			},
			success: true,
		};
	},
	parameters: [
		{
			name: "assignments",
			description: "Role assignments to apply by entity ID.",
			required: true,
			schema: {
				type: "array" as const,
				items: {
					type: "object" as const,
					properties: {
						entityId: { type: "string" as const },
						newRole: {
							type: "string" as const,
							enum: ["OWNER", "ADMIN", "MEMBER", "GUEST", "NONE"],
						},
					},
					required: ["entityId", "newRole"],
				},
			},
		},
	],
};
