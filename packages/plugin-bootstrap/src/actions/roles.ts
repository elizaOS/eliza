import {
  type HandlerOptions,
  type Action,
  type ActionExample,
  ChannelType,
  composePrompt,
  type HandlerCallback,
  type IAgentRuntime,
  logger,
  type Memory,
  ModelType,
  Role,
  type State,
  type UUID,
  World,
  type ActionResult,
  parseKeyValueXml,
} from '@elizaos/core';

/** Shape of individual assignment in XML response */
interface RoleAssignmentXml {
  entityId?: string;
  newRole?: string;
}

/** Shape of the role extraction XML response */
interface RoleExtractionResult {
  assignments?: {
    assignment?: RoleAssignmentXml | RoleAssignmentXml[];
  };
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
const canModifyRole = (currentRole: Role, targetRole: Role | null, newRole: Role): boolean => {
  // User's can't change their own role
  if (targetRole === currentRole) {
    return false;
  }

  switch (currentRole) {
    // Owners can do everything
    case Role.OWNER:
      return true;
    // Admins can only create/modify users up to their level
    case Role.ADMIN:
      return newRole !== Role.OWNER;
    // Normal users can't modify roles
    case Role.NONE:
    default:
      return false;
  }
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
  name: 'UPDATE_ROLE',
  similes: ['CHANGE_ROLE', 'SET_PERMISSIONS', 'ASSIGN_ROLE', 'MAKE_ADMIN'],
  description: 'Assigns a role (Admin, Owner, None) to a user or list of users in a channel.',

  validate: async (runtime: IAgentRuntime, message: Memory, state?: State): Promise<boolean> => {
    // Only activate in group chats where the feature is enabled
    const channelType = message.content.channelType as ChannelType;

    // First, check if this is a supported channel type
    if (channelType !== ChannelType.GROUP && channelType !== ChannelType.WORLD) {
      return false;
    }

    // Then, check if we have a server/world context
    const room = state?.data?.room ?? (await runtime.getRoom(message.roomId));
    if (!room || !room.messageServerId) {
      return false;
    }

    return true;
  },

  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    state?: State,
    _options?: HandlerOptions,
    callback?: HandlerCallback
  ): Promise<ActionResult> => {
    if (!state) {
      logger.error(
        { src: 'plugin:bootstrap:action:update_role', agentId: runtime.agentId },
        'State is required for role assignment'
      );
      return {
        text: 'State is required for role assignment',
        values: {
          success: false,
          error: 'STATE_REQUIRED',
        },
        data: {
          actionName: 'UPDATE_ROLE',
          error: 'State is required',
        },
        success: false,
        error: new Error('State is required for role assignment'),
      };
    }

    // Extract needed values from message and state
    const { roomId } = message;
    const worldId = runtime.getSetting('WORLD_ID');

    // First, get the world for this server
    let world: World | null = null;

    if (worldId) {
      world = await runtime.getWorld(worldId as UUID);
    }

    if (!world) {
      logger.error(
        { src: 'plugin:bootstrap:action:update_role', agentId: runtime.agentId },
        'World not found'
      );
      await callback?.({
        text: "I couldn't find the world. This action only works in a world.",
      });
      return {
        text: 'World not found',
        values: {
          success: false,
          error: 'WORLD_NOT_FOUND',
        },
        data: {
          actionName: 'UPDATE_ROLE',
          error: 'World not found',
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

    // Get the role of the requester
    const requesterRole = world.metadata.roles[message.entityId] || Role.NONE;

    // Construct extraction prompt
    const extractionPrompt = composePrompt({
      state: {
        ...state.values,
        content: state.text,
      },
      template: `# Task: Parse Role Assignment

I need to extract user role assignments from the input text. Users can be referenced by name, username, or mention.

The available role types are:
- OWNER: Full control over the server and all settings
- ADMIN: Ability to manage channels and moderate content
- NONE: Regular user with no special permissions

# Current context:
{{content}}

Do NOT include any thinking, reasoning, or <think> sections in your response. 
Go directly to the XML response format without any preamble or explanation.

Format your response as XML with multiple assignments:
<response>
  <assignments>
    <assignment>
      <entityId>John</entityId>
      <newRole>ADMIN</newRole>
    </assignment>
    <assignment>
      <entityId>Sarah</entityId>
      <newRole>OWNER</newRole>
    </assignment>
  </assignments>
</response>

IMPORTANT: Your response must ONLY contain the <response></response> XML block above. Do not include any text, thinking, or reasoning before or after this XML block. Start your response immediately with <response> and end with </response>.`,
    });

    // Extract role assignments using text model with XML parsing
    const response = await runtime.useModel(ModelType.TEXT_SMALL, {
      prompt: extractionPrompt,
    });

    const parsedXml = parseKeyValueXml<RoleExtractionResult>(response);

    // Handle the parsed XML structure
    let assignments: RoleAssignment[] = [];
    if (parsedXml?.assignments?.assignment) {
      // Normalize to array
      const assignmentArray = Array.isArray(parsedXml.assignments.assignment)
        ? parsedXml.assignments.assignment
        : [parsedXml.assignments.assignment];

      assignments = assignmentArray
        .filter((a): a is RoleAssignmentXml & { entityId: string } => !!a.entityId)
        .map((a) => ({
          entityId: a.entityId,
          newRole: a.newRole as Role,
        }));
    }

    if (!assignments.length) {
      await callback?.({
        text: 'No valid role assignments found in the request.',
        actions: ['UPDATE_ROLE'],
        source: 'discord',
      });
      return {
        text: 'No valid role assignments found',
        values: {
          success: false,
          error: 'NO_ASSIGNMENTS',
        },
        data: {
          actionName: 'UPDATE_ROLE',
          error: 'No valid role assignments found in the request',
        },
        success: false,
      };
    }

    // Process each role assignment
    let worldUpdated = false;
    const successfulUpdates: Array<{ entityId: string; entityName: string; newRole: Role }> = [];
    const failedUpdates: Array<{ entityId: string; reason: string }> = [];

    for (const assignment of assignments) {
      const targetEntity = entities.find((e) => e.id === assignment.entityId);
      if (!targetEntity) {
        logger.error(
          {
            src: 'plugin:bootstrap:action:update_role',
            agentId: runtime.agentId,
            entityId: assignment.entityId,
          },
          'Could not find an ID to assign to'
        );
        failedUpdates.push({
          entityId: assignment.entityId,
          reason: 'Entity not found',
        });
        continue;
      }

      const currentRole = world.metadata.roles[assignment.entityId];

      // Validate role modification permissions
      if (!canModifyRole(requesterRole, currentRole, assignment.newRole)) {
        await callback?.({
          text: `You don't have permission to change ${targetEntity?.names[0]}'s role to ${assignment.newRole}.`,
          actions: ['UPDATE_ROLE'],
          source: 'discord',
        });
        failedUpdates.push({
          entityId: assignment.entityId,
          reason: 'Insufficient permissions',
        });
        continue;
      }

      // Update role in world metadata
      world.metadata.roles[assignment.entityId] = assignment.newRole;

      worldUpdated = true;
      successfulUpdates.push({
        entityId: assignment.entityId,
        entityName: targetEntity?.names[0] || 'Unknown',
        newRole: assignment.newRole,
      });

      await callback?.({
        text: `Updated ${targetEntity?.names[0]}'s role to ${assignment.newRole}.`,
        actions: ['UPDATE_ROLE'],
        source: 'discord',
      });
    }

    // Save updated world metadata if any changes were made
    if (worldUpdated) {
      try {
        await runtime.updateWorld(world);
        logger.info(
          {
            src: 'plugin:bootstrap:action:update_role',
            agentId: runtime.agentId,
            messageServerId: world.messageServerId,
          },
          'Updated roles in world metadata'
        );
      } catch (error) {
        logger.error(
          {
            src: 'plugin:bootstrap:action:update_role',
            agentId: runtime.agentId,
            error: error instanceof Error ? error.message : String(error),
          },
          'Failed to save world updates'
        );
        return {
          text: 'Failed to save role updates',
          values: {
            success: false,
            error: 'SAVE_FAILED',
          },
          data: {
            actionName: 'UPDATE_ROLE',
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
        updates: successfulUpdates,
        failures: failedUpdates,
      },
      data: {
        actionName: 'UPDATE_ROLE',
        successfulUpdates,
        failedUpdates,
        worldId: world.id,
        messageServerId: world.messageServerId,
      },
      success: true,
    };
  },

  examples: [
    [
      {
        name: '{{name1}}',
        content: {
          text: 'Make {{name2}} an ADMIN',
          source: 'discord',
        },
      },
      {
        name: '{{name3}}',
        content: {
          text: "Updated {{name2}}'s role to ADMIN.",
          actions: ['UPDATE_ROLE'],
        },
      },
    ],
    [
      {
        name: '{{name1}}',
        content: {
          text: 'Set @alice and @bob as admins',
          source: 'discord',
        },
      },
      {
        name: '{{name3}}',
        content: {
          text: "Updated alice's role to ADMIN.\nUpdated bob's role to ADMIN.",
          actions: ['UPDATE_ROLE'],
        },
      },
    ],
    [
      {
        name: '{{name1}}',
        content: {
          text: 'Ban @troublemaker',
          source: 'discord',
        },
      },
      {
        name: '{{name3}}',
        content: {
          text: 'I cannot ban users.',
          actions: ['REPLY'],
        },
      },
    ],
  ] as ActionExample[][],
};
