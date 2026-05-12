import dedent from "dedent";
import { logger } from "../../../logger.ts";
import {
	type ActionResult,
	ChannelType,
	type HandlerCallback,
	type IAgentRuntime,
	type Memory,
	ModelType,
	Role,
	type State,
	type UUID,
	type World,
} from "../../../types/index.ts";

const canModifyRole = (
	currentRole: Role,
	targetRole: Role | null,
	_newRole: Role,
): boolean => {
	if (targetRole === currentRole) return false;
	return currentRole === Role.OWNER;
};

interface RoleAssignment {
	entityId: string;
	newRole: Role;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeRole(value: unknown): Role | null {
	const normalized =
		typeof value === "string" ? value.trim().toUpperCase() : "";
	return (Object.values(Role) as string[]).includes(normalized)
		? (normalized as Role)
		: null;
}

function extractRoleAssignments(result: unknown): RoleAssignment[] {
	const assignments: RoleAssignment[] = [];

	const addAssignment = (rawEntityId: unknown, rawRole: unknown): void => {
		const entityId = typeof rawEntityId === "string" ? rawEntityId.trim() : "";
		const newRole = normalizeRole(rawRole);
		if (!entityId || !newRole) {
			return;
		}
		assignments.push({ entityId, newRole });
	};

	const traverse = (node: unknown): void => {
		if (Array.isArray(node)) {
			for (const item of node) {
				traverse(item);
			}
			return;
		}

		if (!isRecord(node)) {
			return;
		}

		if ("entityId" in node && "newRole" in node) {
			addAssignment(node.entityId, node.newRole);
		}

		for (const value of Object.values(node)) {
			traverse(value);
		}
	};

	traverse(result);
	return assignments;
}

type ActionOptions = Record<string, unknown>;

function readNestedParameters(
	options: ActionOptions | undefined,
): ActionOptions {
	const nested = options?.parameters;
	if (typeof nested === "object" && nested !== null && !Array.isArray(nested)) {
		return nested as ActionOptions;
	}
	return {};
}

export async function updateRoleHandler(
	runtime: IAgentRuntime,
	message: Memory,
	state: State | undefined,
	options: ActionOptions | undefined,
	callback?: HandlerCallback,
): Promise<ActionResult> {
	if (!state) {
		logger.error("State is required for role assignment");
		throw new Error("State is required for role assignment");
	}

	const channelType = message.content.channelType as ChannelType;
	if (channelType !== ChannelType.GROUP && channelType !== ChannelType.WORLD) {
		await callback?.({
			text: "Role assignment only works in a group or world channel.",
			actions: ["TRUST"],
			source: "discord",
		});
		return {
			success: false,
			data: {
				actionName: "TRUST",
				subaction: "update_role",
				success: false,
				error: "Unsupported channel type",
			},
		};
	}

	const { roomId } = message;
	const serverId = message.content.serverId as string;
	if (!serverId) {
		await callback?.({
			text: "Role assignment requires a serverId on the message.",
			actions: ["TRUST"],
			source: "discord",
		});
		return {
			success: false,
			data: {
				actionName: "TRUST",
				subaction: "update_role",
				success: false,
				error: "Missing serverId",
			},
		};
	}

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
				actionName: "TRUST",
				subaction: "update_role",
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

	const serverMembers = entities
		.map((entity) => {
			const names = entity.names?.filter(Boolean).join(", ") || "Unknown";
			return `- entityId: ${entity.id}\n  names: ${names}`;
		})
		.join("\n");

	const extractionPrompt = dedent`
				# Task: Parse Role Assignment

				I need to extract user role assignments from the input text. Users can be referenced by name, username, or mention.

				The available role types are:
				- OWNER: Full control over the server and all settings
				- ADMIN: Ability to manage channels and moderate content
				- NONE: Regular user with no special permissions

				# Current server members:
				${serverMembers || "No members available"}

				# Current speaker role:
				${requesterRole}

				# Current context:
				${state.text}

				Return only assignments that are clearly requested and match a current server member.
				Each entry has:
				- entityId: The exact entityId from Current server members
				- newRole: The role to assign (OWNER, ADMIN, or NONE)
			`;

	const params = readNestedParameters(options);
	const parsed = await runtime.dynamicPromptExecFromState({
		state,
		params: { prompt: extractionPrompt },
		schema: [
			{
				field: "roleAssignments",
				description:
					"Role assignments clearly requested by the speaker, or an empty list when none are valid",
				type: "array",
				items: {
					description: "One role assignment",
					type: "object",
					properties: [
						{
							field: "entityId",
							description: "Exact entityId from Current server members",
							required: true,
						},
						{
							field: "newRole",
							description: "One of OWNER, ADMIN, or NONE",
							required: true,
						},
					],
				},
				required: false,
				validateField: false,
				streamField: false,
			},
		],
		options: {
			modelType: ModelType.TEXT_LARGE,
			contextCheckLevel: 0,
			maxRetries: 1,
		},
	});

	const explicitAssignments = extractRoleAssignments(params.roleAssignments);
	const result = explicitAssignments.length
		? explicitAssignments
		: extractRoleAssignments(parsed);

	if (!result?.length) {
		await callback?.({
			text: "No valid role assignments found in the request.",
			actions: ["TRUST"],
			source: "discord",
		});
		return {
			success: false,
			data: {
				actionName: "TRUST",
				subaction: "update_role",
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
				actions: ["TRUST"],
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
			actions: ["TRUST"],
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
			actionName: "TRUST",
			subaction: "update_role",
			success: worldUpdated,
			updatedRoles,
			totalProcessed: result.length,
			totalUpdated: updatedRoles.length,
		},
		text: worldUpdated
			? `Successfully updated ${updatedRoles.length} role(s).`
			: "No roles were updated.",
	};
}
