// action: SEND_MESSAGE
// send message to a user or room (other than this room we are in)

import { findEntityByName } from "../../entities.ts";
import { requireActionSpec } from "../../generated/spec-helpers.ts";
import { logger } from "../../logger.ts";
import type {
  Action,
  ActionExample,
  ActionResult,
  Content,
  HandlerCallback,
  HandlerOptions,
  IAgentRuntime,
  Memory,
  State,
} from "../../types/index.ts";
import { ModelType } from "../../types/index.ts";
import { composePromptFromState, parseKeyValueXml } from "../../utils.ts";

// Get text content from centralized specs
const spec = requireActionSpec("SEND_MESSAGE");

/** Shape of the target extraction XML response */
interface TargetExtractionResult {
  targetType?: string;
  source?: string;
  messageText?: string;
  identifiers?: {
    roomName?: string;
    userId?: string;
    username?: string;
  };
}

/**
 * Task: Extract Target and Source Information
 *
 * Recent Messages:
 * {{recentMessages}}
 *
 * Instructions:
 * Analyze the conversation to identify:
 * 1. The target type (user or room)
 * 2. The target platform/source (e.g. telegram, discord, etc)
 * 3. Any identifying information about the target
 * 4. The message text to send
 *
 * Return an XML response with:
 * <response>
 *   <targetType>user|room</targetType>
 *   <source>platform-name</source>
 *   <messageText>text_to_send</messageText>
 *   <identifiers>
 *     <username>username_if_applicable</username>
 *     <roomName>room_name_if_applicable</roomName>
 *     <!-- Add other relevant identifiers as needed -->
 *   </identifiers>
 * </response>
 *
 * Example outputs:
 * For "send a message to @dev_guru on telegram":
 * <response>
 *   <targetType>user</targetType>
 *   <source>telegram</source>
 *   <messageText>Hello!</messageText>
 *   <identifiers>
 *     <username>dev_guru</username>
 *   </identifiers>
 * </response>
 *
 * For "post this in #announcements":
 * <response>
 *   <targetType>room</targetType>
 *   <source>discord</source>
 *   <messageText>Important announcement!</messageText>
 *   <identifiers>
 *     <roomName>announcements</roomName>
 *   </identifiers>
 * </response>
 */
const targetExtractionTemplate = `# Task: Extract Target and Source Information

# Recent Messages:
{{recentMessages}}

# Instructions:
Analyze the conversation to identify:
1. The target type (user or room)
2. The target platform/source (e.g. telegram, discord, etc)
3. Any identifying information about the target
4. The message text to send

Do NOT include any thinking, reasoning, or <think> sections in your response. 
Go directly to the XML response format without any preamble or explanation.

Return an XML response with:
<response>
  <targetType>user|room</targetType>
  <source>platform-name</source>
  <messageText>text_to_send</messageText>
  <identifiers>
    <username>username_if_applicable</username>
    <roomName>room_name_if_applicable</roomName>
  </identifiers>
</response>

Example outputs:
1. For "send a message to @dev_guru on telegram":
<response>
  <targetType>user</targetType>
  <source>telegram</source>
  <messageText>Hello!</messageText>
  <identifiers>
    <username>dev_guru</username>
  </identifiers>
</response>

2. For "post this in #announcements":
<response>
  <targetType>room</targetType>
  <source>discord</source>
  <messageText>Important announcement!</messageText>
  <identifiers>
    <roomName>announcements</roomName>
  </identifiers>
</response>

IMPORTANT: Your response must ONLY contain the <response></response> XML block above. Do not include any text, thinking, or reasoning before or after this XML block. Start your response immediately with <response> and end with </response>.`;
/**
 * Represents an action to send a message to a user or room.
 *
 * @typedef {Action} sendMessageAction
 * @property {string} name - The name of the action.
 * @property {string[]} similes - Additional names for the action.
 * @property {string} description - Description of the action.
 * @property {function} validate - Asynchronous function to validate if the action can be executed.
 * @property {function} handler - Asynchronous function to handle the action execution.
 * @property {ActionExample[][]} examples - Examples demonstrating the usage of the action.
 */
export const sendMessageAction: Action = {
  name: spec.name,
  similes: spec.similes ? [...spec.similes] : [],
  description: spec.description,

  validate: async (
    runtime: IAgentRuntime,
    message: Memory,
    _state?: State,
  ): Promise<boolean> => {
    // Check if we have permission to send messages
    const worldId = message.roomId;
    const agentId = runtime.agentId;

    // Get all components for the current room to understand available sources
    const roomComponents = await runtime.getComponents(
      message.roomId,
      worldId,
      agentId,
    );

    // Get source types from room components
    for (const component of roomComponents) {
      if (component.type) {
        return true;
      }
    }
    return false;
  },

  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    state?: State,
    options?: HandlerOptions,
    callback?: HandlerCallback,
    responses?: Memory[],
  ): Promise<ActionResult> => {
    if (!state) {
      logger.error(
        {
          src: "plugin:bootstrap:action:send_message",
          agentId: runtime.agentId,
        },
        "State is required for sendMessage action",
      );
      return {
        text: "State is required for sendMessage action",
        values: {
          success: false,
          error: "STATE_REQUIRED",
        },
        data: {
          actionName: "SEND_MESSAGE",
          error: "State is required",
        },
        success: false,
        error: new Error("State is required for sendMessage action"),
      };
    }
    if (!callback) {
      logger.error(
        {
          src: "plugin:bootstrap:action:send_message",
          agentId: runtime.agentId,
        },
        "Callback is required for sendMessage action",
      );
      return {
        text: "Callback is required for sendMessage action",
        values: {
          success: false,
          error: "CALLBACK_REQUIRED",
        },
        data: {
          actionName: "SEND_MESSAGE",
          error: "Callback is required",
        },
        success: false,
        error: new Error("Callback is required for sendMessage action"),
      };
    }
    if (!responses) {
      logger.error(
        {
          src: "plugin:bootstrap:action:send_message",
          agentId: runtime.agentId,
        },
        "Responses are required for sendMessage action",
      );
      return {
        text: "Responses are required for sendMessage action",
        values: {
          success: false,
          error: "RESPONSES_REQUIRED",
        },
        data: {
          actionName: "SEND_MESSAGE",
          error: "Responses are required",
        },
        success: false,
        error: new Error("Responses are required for sendMessage action"),
      };
    }

    // Handle initial responses
    for (const response of responses) {
      await callback(response.content);
    }

    const sourceEntityId = message.entityId;
    const room = state.data.room ?? (await runtime.getRoom(message.roomId));

    if (!room) {
      return {
        text: "Could not find room",
        values: { success: false, error: "ROOM_NOT_FOUND" },
        data: { actionName: "SEND_MESSAGE", error: "Room not found" },
        success: false,
      };
    }

    const worldId = room.worldId;

    const actionParams = options?.parameters;
    const targetTypeParam = actionParams?.targetType;
    const sourceParam = actionParams?.source;
    const targetParam = actionParams?.target;
    const textParam = actionParams?.text;

    const canUseParams =
      (targetTypeParam === "user" || targetTypeParam === "room") &&
      typeof targetParam === "string" &&
      typeof textParam === "string";

    let targetData: TargetExtractionResult | null = null;
    if (canUseParams) {
      const resolvedSource =
        typeof sourceParam === "string" && sourceParam.trim() !== ""
          ? sourceParam.trim()
          : message.content.source;

      targetData = {
        targetType: targetTypeParam,
        source: resolvedSource,
        messageText: textParam,
        identifiers:
          targetTypeParam === "user"
            ? { username: targetParam }
            : { roomName: targetParam },
      };
    } else {
      // Extract target, source, and message text via model (fallback when <params> isn't provided)
      const targetPrompt = composePromptFromState({
        state,
        template: targetExtractionTemplate,
      });

      const targetResult = await runtime.useModel(ModelType.TEXT_SMALL, {
        prompt: targetPrompt,
        stopSequences: [],
      });

      targetData = parseKeyValueXml<TargetExtractionResult>(targetResult);
    }

    if (
      !targetData ||
      !targetData.targetType ||
      !targetData.source ||
      !targetData.messageText
    ) {
      await callback({
        text: "I couldn't determine the target, platform, or message text to send. Please specify who/where to send it and what you want me to say.",
        actions: ["SEND_MESSAGE_ERROR"],
        source: message.content.source,
      });
      return {
        text: "Could not determine message target",
        values: {
          success: false,
          error: "TARGET_UNCLEAR",
        },
        data: {
          actionName: "SEND_MESSAGE",
          error: "Could not parse target information from message",
        },
        success: false,
      };
    }

    const source = targetData.source.toLowerCase();
    const messageText = targetData.messageText;

    if (targetData.targetType === "user") {
      // Try to find the target user entity
      const lookupMessage: Memory =
        typeof targetData.identifiers?.username === "string" &&
        targetData.identifiers.username.trim() !== ""
          ? {
              ...message,
              content: {
                ...message.content,
                text: targetData.identifiers.username,
              },
            }
          : message;
      const targetEntity = await findEntityByName(
        runtime,
        lookupMessage,
        state,
      );

      if (!targetEntity) {
        await callback({
          text: "I couldn't find the user you want me to send a message to. Could you please provide more details about who they are?",
          actions: ["SEND_MESSAGE_ERROR"],
          source: message.content.source,
        });
        return {
          text: "Target user not found",
          values: {
            success: false,
            error: "USER_NOT_FOUND",
            targetType: "user",
          },
          data: {
            actionName: "SEND_MESSAGE",
            error: "Could not find target user",
            targetType: "user",
            source,
          },
          success: false,
        };
      }

      // Get the component for the specified source
      if (!targetEntity.id) {
        throw new Error("Target entity ID is required");
      }
      const userComponent = await runtime.getComponent(
        targetEntity.id,
        source,
        worldId,
        sourceEntityId,
      );

      if (!userComponent) {
        await callback({
          text: `I couldn't find ${source} information for that user. Could you please provide their ${source} details?`,
          actions: ["SEND_MESSAGE_ERROR"],
          source: message.content.source,
        });
        return {
          text: `No ${source} information found for user`,
          values: {
            success: false,
            error: "COMPONENT_NOT_FOUND",
            targetType: "user",
            source,
          },
          data: {
            actionName: "SEND_MESSAGE",
            error: `No ${source} component found for target user`,
            targetType: "user",
            targetEntityId: targetEntity.id ?? null,
            source,
          },
          success: false,
        };
      }

      interface ServiceWithSendDirectMessage {
        sendDirectMessage?: (target: string, content: Content) => Promise<void>;
      }
      const service = runtime.getService(
        source,
      ) as ServiceWithSendDirectMessage | null;
      const sendDirectMessage = service?.sendDirectMessage;

      if (!sendDirectMessage) {
        await callback({
          text: "I couldn't find the user you want me to send a message to. Could you please provide more details about who they are?",
          actions: ["SEND_MESSAGE_ERROR"],
          source: message.content.source,
        });
        return {
          text: "Message service not available",
          values: {
            success: false,
            error: "SERVICE_NOT_FOUND",
            targetType: "user",
            source,
          },
          data: {
            actionName: "SEND_MESSAGE",
            error: `No sendDirectMessage service found for ${source}`,
            targetType: "user",
            source,
          },
          success: false,
        };
      }
      // Send the message using the appropriate client
      if (!targetEntity.id) {
        throw new Error("Target entity ID is required");
      }
      await sendDirectMessage(targetEntity.id, {
        text: messageText,
        source,
      });

      await callback({
        text: `Message sent to ${targetEntity.names[0]} on ${source}.`,
        actions: ["SEND_MESSAGE"],
        source: message.content.source,
      });
      return {
        text: `Message sent to ${targetEntity.names[0]}`,
        values: {
          success: true,
          targetType: "user",
          target: targetEntity.id ?? null,
          targetName: targetEntity.names[0] ?? null,
          source,
          messageSent: true,
        },
        data: {
          actionName: "SEND_MESSAGE",
          targetType: "user",
          target: targetEntity.id ?? null,
          targetName: targetEntity.names[0] ?? null,
          source,
          messageContent: messageText ?? null,
        },
        success: true,
      };
    } else if (targetData.targetType === "room") {
      // Try to find the target room
      if (!worldId) {
        return {
          text: "Could not determine world for room lookup",
          values: { success: false, error: "NO_WORLD_ID" },
          data: {
            actionName: "SEND_MESSAGE",
            error: "No world ID available",
          },
          success: false,
        };
      }
      const rooms = await runtime.getRooms(worldId);
      const targetRoomName = targetData.identifiers?.roomName?.toLowerCase();
      const targetRoom = rooms.find(
        (r) => r.name?.toLowerCase() === targetRoomName,
      );

      if (!targetRoom) {
        await callback({
          text: "I couldn't find the room you want me to send a message to. Could you please specify the exact room name?",
          actions: ["SEND_MESSAGE_ERROR"],
          source: message.content.source,
        });
        return {
          text: "Target room not found",
          values: {
            success: false,
            error: "ROOM_NOT_FOUND",
            targetType: "room",
            roomName: targetData.identifiers?.roomName ?? null,
          },
          data: {
            actionName: "SEND_MESSAGE",
            error: "Could not find target room",
            targetType: "room",
            roomName: targetData.identifiers?.roomName ?? null,
            source,
          },
          success: false,
        };
      }

      interface ServiceWithSendRoomMessage {
        sendRoomMessage?: (target: string, content: Content) => Promise<void>;
      }
      const service = runtime.getService(
        source,
      ) as ServiceWithSendRoomMessage | null;
      const sendRoomMessage = service?.sendRoomMessage;

      if (!sendRoomMessage) {
        await callback({
          text: "I couldn't find the room you want me to send a message to. Could you please specify the exact room name?",
          actions: ["SEND_MESSAGE_ERROR"],
          source: message.content.source,
        });
        return {
          text: "Room message service not available",
          values: {
            success: false,
            error: "SERVICE_NOT_FOUND",
            targetType: "room",
            source,
          },
          data: {
            actionName: "SEND_MESSAGE",
            error: `No sendRoomMessage service found for ${source}`,
            targetType: "room",
            source,
          },
          success: false,
        };
      }

      // Send the message to the room
      await sendRoomMessage(targetRoom.id, {
        text: messageText,
        source,
      });

      await callback({
        text: `Message sent to ${targetRoom.name} on ${source}.`,
        actions: ["SEND_MESSAGE"],
        source: message.content.source,
      });
      return {
        text: `Message sent to ${targetRoom.name}`,
        values: {
          success: true,
          targetType: "room",
          target: targetRoom.id ?? null,
          targetName: targetRoom.name ?? null,
          source,
          messageSent: true,
        },
        data: {
          actionName: "SEND_MESSAGE",
          targetType: "room",
          target: targetRoom.id ?? null,
          targetName: targetRoom.name ?? null,
          source,
          messageContent: messageText ?? null,
        },
        success: true,
      };
    }

    // Should not reach here
    return {
      text: "Unknown target type",
      values: {
        success: false,
        error: "UNKNOWN_TARGET_TYPE",
      },
      data: {
        actionName: "SEND_MESSAGE",
        error: `Unknown target type: ${targetData.targetType}`,
      },
      success: false,
    };
  },

  examples: (spec.examples ?? []) as ActionExample[][],
};

export default sendMessageAction;
